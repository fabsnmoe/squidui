import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AUTHENTICATION_MODES,
  detectSecurityFindings,
  hasOpenProxyFinding,
  type ProxyAuthenticationConfiguration,
} from '@scp/shared';
import { recordAudit } from '../audit/sink.js';
import {
  actorOf,
  badRequest,
  clientIp,
  conflict,
  notFound,
  requirePermission,
  HttpError,
} from '../http/context.js';
import { LDAP_DEFAULTS, parseLdapConfig } from '../providers/ldap.js';
import { AuthenticationProviderRegistry } from '../providers/registry.js';
import { encryptSecret } from '../security/secrets.js';
import { buildIr } from '../services/configuration.js';
import type { AppContext } from '../server.js';

/**
 * Authentication -> Overview, Providers and Test (PLAN.md 9.10, 9.13, 9.22).
 */

const configPatchSchema = z.object({
  mode: z.enum(AUTHENTICATION_MODES).optional(),
  defaultAccess: z.enum(['ALLOW', 'DENY']).optional(),
  realm: z.string().min(1).max(128).optional(),
  /**
   * Set by the UI after the operator confirmed the open proxy warning. Without
   * it a configuration that would open the proxy is refused - not because it is
   * forbidden, but so it cannot happen by accident (PRODUCT.md section 5).
   */
  acknowledgeOpenProxy: z.boolean().optional(),
});

const ldapConfigSchema = z.object({
  uri: z.string().min(1).max(512),
  baseDn: z.string().min(1).max(512),
  userFilter: z.string().min(1).max(512),
  bindDn: z.string().max(512).nullable().optional(),
  startTls: z.boolean().optional(),
  tlsRejectUnauthorized: z.boolean().optional(),
  groupBaseDn: z.string().max(512).nullable().optional(),
  groupFilter: z.string().max(512).nullable().optional(),
  displayNameAttribute: z.string().max(128).optional(),
  connectTimeoutMs: z.number().int().min(500).max(60_000).optional(),
});

const providerCreateSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'Use lowercase letters, digits and hyphens.'),
  type: z.enum(['LDAP']),
  name: z.string().min(1).max(128),
  enabled: z.boolean().default(false),
  priority: z.number().int().min(0).max(10_000).default(100),
  config: ldapConfigSchema,
  bindPassword: z.string().max(512).optional(),
});

const providerPatchSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().min(0).max(10_000).optional(),
  config: ldapConfigSchema.partial().optional(),
  bindPassword: z.string().max(512).optional(),
});

const authTestSchema = z.object({
  username: z.string().min(1).max(128),
  password: z.string().min(1).max(256),
  sourceIp: z.string().max(64).optional(),
});

export async function registerProxyAuthRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  const { db, config } = context;

  async function loadConfiguration(): Promise<ProxyAuthenticationConfiguration> {
    const { rows } = await db.query<{
      mode: ProxyAuthenticationConfiguration['mode'];
      default_access: 'ALLOW' | 'DENY';
      realm: string;
      open_proxy_acknowledged_at: Date | null;
      open_proxy_acknowledged_by: string | null;
      updated_at: Date;
    }>('select * from proxy_auth_config where id = 1');
    const row = rows[0];
    if (!row) throw notFound('Proxy authentication configuration is missing. Run the migrate step.');

    const { rows: providerRows } = await db.query<{
      id: string;
      key: string;
      enabled: boolean;
      priority: number;
    }>('select id, key, enabled, priority from auth_providers order by priority, key');

    return {
      mode: row.mode,
      defaultAccess: row.default_access,
      realm: row.realm,
      providers: providerRows,
      openProxyAcknowledgedAt: row.open_proxy_acknowledged_at?.toISOString() ?? null,
      openProxyAcknowledgedBy: row.open_proxy_acknowledged_by,
      updatedAt: row.updated_at.toISOString(),
    };
  }

  /* --- Overview ---------------------------------------------------------- */

  app.get('/proxy-auth/overview', async (request) => {
    requirePermission(request, 'PROXY_AUTH_READ');
    const registry = await AuthenticationProviderRegistry.load(db, config);
    const [configuration, providers, { ir }] = await Promise.all([
      loadConfiguration(),
      registry.summaries(),
      buildIr(db, registry),
    ]);

    return {
      configuration,
      providers,
      findings: detectSecurityFindings(ir),
      listeners: ir.listeners,
    };
  });

  app.patch('/proxy-auth/config', async (request) => {
    const principal = requirePermission(request, 'PROXY_AUTH_CONFIGURE');
    const parsed = configPatchSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Invalid configuration payload.', parsed.error.issues);
    const patch = parsed.data;

    const before = await loadConfiguration();
    const next = {
      mode: patch.mode ?? before.mode,
      defaultAccess: patch.defaultAccess ?? before.defaultAccess,
      realm: patch.realm ?? before.realm,
    };

    // Dry run: build the IR as it would look after the change and check it.
    const registry = await AuthenticationProviderRegistry.load(db, config);
    const { ir } = await buildIr(db, registry);
    // The security check has to judge the *new* configuration. Listeners that
    // inherit are re-resolved against the new default; without this, switching
    // from disabled to required is judged against the old listeners and the
    // tightening is refused as if it opened the proxy.
    const projected = {
      ...ir,
      authentication: { ...ir.authentication, mode: next.mode, realm: next.realm },
      defaultAccess: next.defaultAccess,
      listeners: ir.listeners.map((listener) =>
        listener.inheritsAuthentication ? { ...listener, authentication: next.mode } : listener,
      ),
    };
    const findings = detectSecurityFindings(projected);

    if (hasOpenProxyFinding(findings) && !patch.acknowledgeOpenProxy) {
      throw new HttpError(
        409,
        'OPEN_PROXY_CONFIRMATION_REQUIRED',
        'This change would allow unauthenticated clients to use the proxy. Confirm the warning to proceed.',
        { findings },
      );
    }

    const acknowledged = hasOpenProxyFinding(findings) && patch.acknowledgeOpenProxy === true;
    await db.query(
      `update proxy_auth_config
       set mode = $1,
           default_access = $2,
           realm = $3,
           open_proxy_acknowledged_at = case when $4::boolean then now() else open_proxy_acknowledged_at end,
           open_proxy_acknowledged_by = case when $4::boolean then $5 else open_proxy_acknowledged_by end,
           updated_at = now()
       where id = 1`,
      [next.mode, next.defaultAccess, next.realm, acknowledged, principal.username],
    );

    if (next.mode !== before.mode) {
      await recordAudit(db, {
        action: 'AUTH_MODE_CHANGED',
        actor: actorOf(request),
        targetType: 'proxy_auth_config',
        targetId: '1',
        payload: { from: before.mode, to: next.mode },
      });
    }
    if (next.defaultAccess !== before.defaultAccess) {
      await recordAudit(db, {
        action: 'AUTH_DEFAULT_ACCESS_CHANGED',
        actor: actorOf(request),
        targetType: 'proxy_auth_config',
        targetId: '1',
        payload: { from: before.defaultAccess, to: next.defaultAccess },
      });
    }
    if (acknowledged) {
      await recordAudit(db, {
        action: 'AUTH_OPEN_PROXY_ACKNOWLEDGED',
        actor: actorOf(request),
        targetType: 'proxy_auth_config',
        targetId: '1',
        payload: { findings: findings.map((finding) => finding.code) },
      });
    }

    return { configuration: await loadConfiguration(), findings };
  });

  /* --- Providers --------------------------------------------------------- */

  app.get('/auth-providers', async (request) => {
    requirePermission(request, 'AUTH_PROVIDER_READ');
    const refresh = (request.query as { refresh?: string } | undefined)?.refresh === 'true';
    const registry = await AuthenticationProviderRegistry.load(db, config);
    const summaries = await registry.summaries({ refresh });

    // Statistics are cheap for local and unavailable for LDAP; the UI shows
    // what exists instead of pretending both are the same.
    const enriched = await Promise.all(
      summaries.map(async (summary) => {
        const adapter = registry.byId(summary.id);
        const statistics = adapter ? await adapter.statistics().catch(() => ({ users: null, groups: null })) : null;
        const detail =
          adapter && adapter.type === 'LDAP'
            ? { server: parseLdapConfig((adapter as { config?: unknown }).config).uri }
            : {};
        return { ...summary, statistics, ...detail };
      }),
    );

    return { providers: enriched, ldapDefaults: LDAP_DEFAULTS };
  });

  app.post('/auth-providers', async (request) => {
    requirePermission(request, 'AUTH_PROVIDER_MANAGE');
    const parsed = providerCreateSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Invalid provider payload.', parsed.error.issues);
    const input = parsed.data;

    const { rows: existing } = await db.query('select 1 from auth_providers where key = $1', [input.key]);
    if (existing.length > 0) throw conflict(`A provider with the key "${input.key}" already exists.`);

    const { rows } = await db.query<{ id: string }>(
      `insert into auth_providers (key, type, name, enabled, priority, config)
       values ($1, $2, $3, $4, $5, $6::jsonb) returning id`,
      [
        input.key,
        input.type,
        input.name,
        input.enabled,
        input.priority,
        JSON.stringify(parseLdapConfig(input.config)),
      ],
    );
    const providerId = rows[0]?.id as string;

    if (input.bindPassword) {
      await db.query(
        `insert into provider_secrets (provider_id, name, ciphertext) values ($1, 'bindPassword', $2)
         on conflict (provider_id, name) do update set ciphertext = excluded.ciphertext, updated_at = now()`,
        [providerId, encryptSecret(input.bindPassword, config.secretEncryptionKey)],
      );
    }

    AuthenticationProviderRegistry.invalidateHealth();
    await recordAudit(db, {
      action: 'AUTH_PROVIDER_CREATED',
      actor: actorOf(request),
      targetType: 'auth_provider',
      targetId: providerId,
      targetName: input.name,
      // `input` contains bindPassword; the sink redacts it, and this is the
      // regression the audit tests cover.
      payload: { key: input.key, type: input.type, enabled: input.enabled, priority: input.priority },
    });

    return { id: providerId };
  });

  app.patch('/auth-providers/:id', async (request) => {
    requirePermission(request, 'AUTH_PROVIDER_MANAGE');
    const { id } = request.params as { id: string };
    const parsed = providerPatchSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Invalid provider payload.', parsed.error.issues);
    const patch = parsed.data;

    const { rows } = await db.query<{
      id: string;
      key: string;
      type: 'LOCAL' | 'LDAP';
      name: string;
      enabled: boolean;
      priority: number;
      config: unknown;
    }>('select id, key, type, name, enabled, priority, config from auth_providers where id = $1', [id]);
    const provider = rows[0];
    if (!provider) throw notFound('Provider not found.');

    const nextConfig =
      provider.type === 'LDAP' && patch.config
        ? parseLdapConfig({ ...(provider.config as object), ...patch.config })
        : provider.config;

    await db.query(
      `update auth_providers
       set name = $2, enabled = $3, priority = $4, config = $5::jsonb, updated_at = now()
       where id = $1`,
      [
        id,
        patch.name ?? provider.name,
        patch.enabled ?? provider.enabled,
        patch.priority ?? provider.priority,
        JSON.stringify(nextConfig),
      ],
    );

    if (patch.bindPassword !== undefined && provider.type === 'LDAP') {
      if (patch.bindPassword === '') {
        await db.query('delete from provider_secrets where provider_id = $1 and name = $2', [id, 'bindPassword']);
      } else {
        await db.query(
          `insert into provider_secrets (provider_id, name, ciphertext) values ($1, 'bindPassword', $2)
           on conflict (provider_id, name) do update set ciphertext = excluded.ciphertext, updated_at = now()`,
          [id, encryptSecret(patch.bindPassword, config.secretEncryptionKey)],
        );
      }
    }

    AuthenticationProviderRegistry.invalidateHealth(id);

    if (patch.enabled !== undefined && patch.enabled !== provider.enabled) {
      await recordAudit(db, {
        action: patch.enabled ? 'AUTH_PROVIDER_ENABLED' : 'AUTH_PROVIDER_DISABLED',
        actor: actorOf(request),
        targetType: 'auth_provider',
        targetId: id,
        targetName: provider.name,
      });
    }
    await recordAudit(db, {
      action: 'AUTH_PROVIDER_UPDATED',
      actor: actorOf(request),
      targetType: 'auth_provider',
      targetId: id,
      targetName: patch.name ?? provider.name,
      payload: {
        priority: patch.priority ?? provider.priority,
        bindPasswordChanged: patch.bindPassword !== undefined,
      },
    });

    return { ok: true };
  });

  app.delete('/auth-providers/:id', async (request) => {
    requirePermission(request, 'AUTH_PROVIDER_MANAGE');
    const { id } = request.params as { id: string };

    const { rows } = await db.query<{ key: string; name: string; type: string }>(
      'select key, name, type from auth_providers where id = $1',
      [id],
    );
    const provider = rows[0];
    if (!provider) throw notFound('Provider not found.');
    if (provider.type === 'LOCAL') {
      // The local provider is the fallback that keeps emergency accounts
      // usable; removing it would be an operational trap.
      throw conflict('The local provider cannot be deleted. Disable it instead.');
    }

    await db.query('delete from auth_providers where id = $1', [id]);
    AuthenticationProviderRegistry.invalidateHealth(id);
    await recordAudit(db, {
      action: 'AUTH_PROVIDER_DELETED',
      actor: actorOf(request),
      targetType: 'auth_provider',
      targetId: id,
      targetName: provider.name,
      payload: { key: provider.key },
    });

    return { ok: true };
  });

  app.post('/auth-providers/:id/test', async (request) => {
    requirePermission(request, 'AUTH_PROVIDER_TEST');
    const { id } = request.params as { id: string };
    const registry = await AuthenticationProviderRegistry.load(db, config);
    const adapter = registry.byId(id);
    if (!adapter) throw notFound('Provider not found.');

    const result = await adapter.testConnection();
    AuthenticationProviderRegistry.invalidateHealth(id);
    await recordAudit(db, {
      action: 'AUTH_PROVIDER_TESTED',
      outcome: result.ok ? 'SUCCESS' : 'FAILURE',
      actor: actorOf(request),
      targetType: 'auth_provider',
      targetId: id,
      targetName: adapter.name,
      payload: { summary: result.summary },
    });

    return result;
  });

  /* --- Authentication test (PRODUCT.md section 22) ------------------------ */

  app.post('/auth-test', async (request, reply) => {
    requirePermission(request, 'AUTH_PROVIDER_TEST');
    const parsed = authTestSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Username and password are required.');

    const decision = context.authTestLimiter.check(`ip:${clientIp(request)}`);
    if (!decision.allowed) {
      reply.header('Retry-After', String(decision.retryAfterSeconds));
      throw new HttpError(429, 'RATE_LIMITED', 'Too many authentication tests. Try again later.');
    }

    const registry = await AuthenticationProviderRegistry.load(db, config);
    const result = await registry.authenticate({
      username: parsed.data.username,
      password: parsed.data.password,
      sourceIp: parsed.data.sourceIp ?? null,
    });

    // The password is neither persisted nor logged; only the outcome is
    // (PRODUCT.md section 22, PLAN.md 9.21).
    await recordAudit(db, {
      action: 'AUTH_TEST_PERFORMED',
      outcome: result.success ? 'SUCCESS' : 'FAILURE',
      actor: actorOf(request),
      targetType: 'proxy_identity',
      targetName: parsed.data.username,
      payload: {
        provider: result.providerKey,
        groups: result.groups,
        attempts: result.attempts.map((attempt) => ({
          providerKey: attempt.providerKey,
          outcome: attempt.outcome,
        })),
      },
    });

    return result;
  });
}
