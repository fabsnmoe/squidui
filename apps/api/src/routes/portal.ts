import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { buildAccessProfile, type IdentityGroupRef } from '@scp/shared';
import { hashProxyPassword, validatePasswordStrength, verifyProxyPassword } from '@scp/shared/crypt';
import { recordAudit } from '../audit/sink.js';
import {
  actorOf,
  badRequest,
  clientIp,
  conflict,
  requirePortalAuth,
  unauthorized,
  HttpError,
} from '../http/context.js';
import { AuthenticationProviderRegistry } from '../providers/registry.js';
import { issueToken, type PortalClaims } from '../security/jwt.js';
import { buildIr } from '../services/configuration.js';
import type { AppContext } from '../server.js';

/**
 * Proxy user self-service portal.
 *
 * Same web application, deliberately separate identity plane: these routes
 * authenticate against the *proxy* provider registry, issue a token with the
 * `proxy-portal` audience, and grant no control plane permission at all. A
 * portal token is rejected by every route in the rest of the API, and a
 * control plane token is rejected here (PRODUCT.md section 1).
 *
 * The portal is available in every authentication mode, including DISABLED:
 * an operator may keep proxy authentication off and still let users manage
 * their credentials in preparation for switching it on.
 */

const loginSchema = z.object({
  username: z.string().min(1).max(128),
  password: z.string().min(1).max(256),
});

const passwordSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(1).max(256),
});

interface LocalUserRow {
  id: string;
  username: string;
  display_name: string | null;
  description: string | null;
  status: 'ACTIVE' | 'DISABLED';
  password_hash: string | null;
  password_updated_at: Date | null;
  created_at: Date;
}

export async function registerPortalRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  const { db, config } = context;

  const loadLocalUser = async (username: string): Promise<LocalUserRow | undefined> => {
    const { rows } = await db.query<LocalUserRow>(
      `select id, username, display_name, description, status, password_hash, password_updated_at, created_at
       from proxy_users where lower(username) = lower($1)`,
      [username],
    );
    return rows[0];
  };

  /**
   * Re-resolves the identity behind a portal token on every request.
   *
   * For local users this reads the database, so disabling an account ends the
   * portal session immediately instead of at token expiry. For directory users
   * the groups from sign-in time are used, because re-resolving them would
   * require the password again.
   */
  const resolveIdentity = async (
    principal: ReturnType<typeof requirePortalAuth>,
  ): Promise<{ groups: IdentityGroupRef[]; local: LocalUserRow | null }> => {
    if (principal.providerKey !== 'local') {
      return {
        groups: principal.groups.map((name) => ({
          source: 'EXTERNAL' as const,
          name,
          providerKey: principal.providerKey,
        })),
        local: null,
      };
    }

    const user = await loadLocalUser(principal.username);
    if (!user || user.status !== 'ACTIVE') {
      throw unauthorized('This account is no longer active.');
    }
    const { rows } = await db.query<{ name: string }>(
      `select g.name from proxy_user_groups ug
       join proxy_groups g on g.id = ug.group_id and g.source = 'LOCAL'
       where ug.user_id = $1 order by g.name`,
      [user.id],
    );
    return {
      groups: rows.map((row) => ({ source: 'LOCAL' as const, name: row.name, providerKey: null })),
      local: user,
    };
  };

  /* --- Sign in ----------------------------------------------------------- */

  app.post('/portal/session', async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Username and password are required.');
    const { username, password } = parsed.data;
    const ip = clientIp(request);

    for (const key of [`portal-ip:${ip}`, `portal-user:${username.toLowerCase()}`]) {
      const decision = context.loginLimiter.check(key);
      if (!decision.allowed) {
        reply.header('Retry-After', String(decision.retryAfterSeconds));
        throw new HttpError(429, 'RATE_LIMITED', 'Too many sign-in attempts. Try again later.');
      }
    }

    const registry = await AuthenticationProviderRegistry.load(db, config);
    const result = await registry.authenticate({ username, password, sourceIp: ip });

    if (!result.success || !result.providerKey) {
      await recordAudit(db, {
        action: 'PROXY_PORTAL_LOGIN_FAILED',
        outcome: 'FAILURE',
        actor: { id: null, username: `proxy:${username}`, sourceIp: ip },
        targetType: 'proxy_identity',
        targetName: username,
        payload: {
          attempts: result.attempts.map((attempt) => ({
            providerKey: attempt.providerKey,
            outcome: attempt.outcome,
          })),
        },
      });
      throw unauthorized('Invalid username or password.');
    }

    // The registry answers with the username as the provider spells it, which
    // is what the proxy will see in its logs.
    const resolvedUsername = result.username;
    const { token, expiresAt } = issueToken<PortalClaims>(
      {
        sub: `${result.providerKey}:${resolvedUsername.toLowerCase()}`,
        aud: 'proxy-portal',
        username: resolvedUsername,
        providerKey: result.providerKey,
        groups: result.groups.slice(0, 64),
      },
      config.jwtSecret,
      config.jwtTtlSeconds,
    );

    context.loginLimiter.reset(`portal-ip:${ip}`);
    context.loginLimiter.reset(`portal-user:${username.toLowerCase()}`);

    await recordAudit(db, {
      action: 'PROXY_PORTAL_LOGIN_SUCCEEDED',
      actor: { id: null, username: `proxy:${resolvedUsername}`, sourceIp: ip },
      targetType: 'proxy_identity',
      targetName: resolvedUsername,
      payload: { provider: result.providerKey, groups: result.groups },
    });

    return {
      token,
      expiresAt: expiresAt.toISOString(),
      user: {
        username: resolvedUsername,
        providerKey: result.providerKey,
        providerName: result.providerName,
        groups: result.groups,
        canChangePassword: result.providerKey === 'local',
      },
    };
  });

  app.delete('/portal/session', async (request) => {
    const principal = requirePortalAuth(request);
    await recordAudit(db, {
      action: 'PROXY_PORTAL_LOGOUT',
      actor: actorOf(request),
      targetType: 'proxy_identity',
      targetName: principal.username,
    });
    return { ok: true };
  });

  /* --- Profile ----------------------------------------------------------- */

  app.get('/portal/me', async (request) => {
    const principal = requirePortalAuth(request);
    const { groups, local } = await resolveIdentity(principal);
    const registry = await AuthenticationProviderRegistry.load(db, config);
    const provider = registry.byKey(principal.providerKey);

    return {
      username: principal.username,
      displayName: local?.display_name ?? null,
      description: local?.description ?? null,
      status: local?.status ?? 'ACTIVE',
      provider: {
        key: principal.providerKey,
        name: provider?.name ?? principal.providerKey,
        type: provider?.type ?? 'LOCAL',
      },
      groups: groups.map((group) => group.name),
      canChangePassword: principal.providerKey === 'local',
      passwordUpdatedAt: local?.password_updated_at?.toISOString() ?? null,
      memberSince: local?.created_at?.toISOString() ?? null,
    };
  });

  /* --- Password ---------------------------------------------------------- */

  app.post('/portal/password', async (request) => {
    const principal = requirePortalAuth(request);
    if (principal.providerKey !== 'local') {
      throw conflict(
        'Your account is managed by a directory. Change your password where your organisation manages it.',
      );
    }

    const parsed = passwordSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Current and new password are required.');

    const user = await loadLocalUser(principal.username);
    if (!user || user.status !== 'ACTIVE' || !user.password_hash) {
      throw unauthorized('This account is no longer active.');
    }
    // Changing a password always requires proving the current one, even though
    // the session is already authenticated.
    if (!verifyProxyPassword(parsed.data.currentPassword, user.password_hash)) {
      await recordAudit(db, {
        action: 'PROXY_USER_SELF_PASSWORD_CHANGED',
        outcome: 'FAILURE',
        actor: actorOf(request),
        targetType: 'proxy_user',
        targetId: user.id,
        targetName: user.username,
        payload: { reason: 'CURRENT_PASSWORD_MISMATCH' },
      });
      throw unauthorized('The current password is not correct.');
    }

    const violations = validatePasswordStrength(parsed.data.newPassword);
    if (violations.length > 0) throw badRequest('The new password does not meet the policy.', violations);
    if (verifyProxyPassword(parsed.data.newPassword, user.password_hash)) {
      throw badRequest('The new password must differ from the current one.');
    }

    await db.query(
      `update proxy_users
       set password_hash = $2, password_format = $3, password_updated_at = now(), updated_at = now()
       where id = $1`,
      [user.id, hashProxyPassword(parsed.data.newPassword, config.proxyPasswordFormat), config.proxyPasswordFormat],
    );

    await recordAudit(db, {
      action: 'PROXY_USER_SELF_PASSWORD_CHANGED',
      actor: actorOf(request),
      targetType: 'proxy_user',
      targetId: user.id,
      targetName: user.username,
      payload: { format: config.proxyPasswordFormat },
    });

    return { ok: true, passwordUpdatedAt: new Date().toISOString() };
  });

  /* --- Access profile ---------------------------------------------------- */

  app.get('/portal/access-profile', async (request) => {
    const principal = requirePortalAuth(request);
    const { groups } = await resolveIdentity(principal);

    const registry = await AuthenticationProviderRegistry.load(db, config);
    const { ir } = await buildIr(db, registry);

    const profile = buildAccessProfile(ir, {
      authenticated: true,
      username: principal.username,
      providerKey: principal.providerKey,
      groups,
    });

    return {
      ...profile,
      identity: { username: principal.username, groups: groups.map((group) => group.name) },
    };
  });

  /* --- Own activity ------------------------------------------------------ */

  app.get('/portal/activity', async (request) => {
    const principal = requirePortalAuth(request);
    const actor = `proxy:${principal.username}`;

    // Scoped to this identity only: a portal user can never read another
    // account's events, and never a control plane event.
    const { rows } = await db.query<{
      occurred_at: Date;
      action: string;
      outcome: string;
      source_ip: string | null;
    }>(
      `select occurred_at, action, outcome, source_ip
       from audit_events
       where actor_username = $1
         and action in ('PROXY_PORTAL_LOGIN_SUCCEEDED', 'PROXY_PORTAL_LOGIN_FAILED',
                        'PROXY_PORTAL_LOGOUT', 'PROXY_USER_SELF_PASSWORD_CHANGED')
       order by occurred_at desc
       limit 50`,
      [actor],
    );

    const { rows: counters } = await db.query<{ successes: string; failures: string; last_success: Date | null }>(
      `select
         count(*) filter (where action = 'PROXY_PORTAL_LOGIN_SUCCEEDED')::text as successes,
         count(*) filter (where action = 'PROXY_PORTAL_LOGIN_FAILED')::text as failures,
         max(occurred_at) filter (where action = 'PROXY_PORTAL_LOGIN_SUCCEEDED') as last_success
       from audit_events
       where actor_username = $1 and occurred_at > now() - interval '30 days'`,
      [actor],
    );

    return {
      events: rows.map((row) => ({
        occurredAt: row.occurred_at.toISOString(),
        action: row.action,
        outcome: row.outcome,
        sourceIp: row.source_ip,
      })),
      last30Days: {
        signIns: Number(counters[0]?.successes ?? '0'),
        failedSignIns: Number(counters[0]?.failures ?? '0'),
        lastSignInAt: counters[0]?.last_success?.toISOString() ?? null,
      },
      traffic: {
        // Per-user request counters need the proxy log pipeline, which is not
        // implemented. Reporting a zero here would be a lie.
        available: false,
        reason: 'Traffic statistics require the proxy log pipeline, which is not connected yet.',
      },
    };
  });
}
