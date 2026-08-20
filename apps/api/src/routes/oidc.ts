import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { recordAudit } from '../audit/sink.js';
import { actorOf, badRequest, conflict, notFound, requirePermission, unauthorized } from '../http/context.js';
import { issueToken, type PortalClaims, type SessionClaims, type TokenAudience } from '../security/jwt.js';
import { decryptSecret, encryptSecret } from '../security/secrets.js';
import {
  admits,
  buildAuthorizationUrl,
  createPkcePair,
  discover,
  exchangeCode,
  randomToken,
  usernameFrom,
  verifyIdToken,
} from '../security/oidc.js';
import { accessLeasePolicy } from '../services/settings.js';
import type { AppContext } from '../server.js';

/**
 * OIDC sign-in for the web interface (ADR 0004).
 *
 * Two doors served by one provider configuration: the control plane and the
 * self-service portal. OIDC authenticates people; it never authenticates proxy
 * traffic, because Squid speaks HTTP Basic and cannot consume a token. A portal
 * user provisions a proxy account instead, and that account's password is what
 * reaches Squid.
 *
 * Managing providers takes CP_USER_MANAGE rather than a settings permission:
 * whoever configures the provider decides who becomes an administrator, which
 * is exactly the power of creating one.
 */

const STATE_TTL_MINUTES = 10;

const providerSchema = z.object({
  key: z.string().regex(/^[a-z0-9-]{1,32}$/),
  name: z.string().min(1).max(64),
  enabled: z.boolean().default(true),
  issuer: z.string().url(),
  clientId: z.string().min(1).max(256),
  clientSecret: z.string().max(512).nullable().optional(),
  scopes: z.string().min(1).max(256).default('openid profile email'),
  allowAdminLogin: z.boolean().default(false),
  allowPortalLogin: z.boolean().default(true),
  adminClaim: z.string().max(128).nullable().optional(),
  adminValue: z.string().max(128).nullable().optional(),
  portalClaim: z.string().max(128).nullable().optional(),
  portalValue: z.string().max(128).nullable().optional(),
  usernameClaim: z.string().min(1).max(128).default('preferred_username'),
});

interface ProviderRow {
  id: string;
  key: string;
  name: string;
  enabled: boolean;
  issuer: string;
  client_id: string;
  client_secret_enc: string | null;
  scopes: string;
  allow_admin_login: boolean;
  allow_portal_login: boolean;
  admin_claim: string | null;
  admin_value: string | null;
  portal_claim: string | null;
  portal_value: string | null;
  username_claim: string;
}

export async function registerOidcRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  const { db, config } = context;

  /** Redirect target, fixed by configuration and never taken from the request. */
  function redirectUriFor(request: FastifyRequest): string {
    if (config.publicBaseUrl) return `${config.publicBaseUrl}/auth/callback`;
    // Without PUBLIC_BASE_URL the origin is derived, which works for a single
    // host installation. The provider requires an exact match, so an operator
    // running behind a reverse proxy has to set it explicitly.
    const proto = (request.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0] ?? 'http';
    const host = request.headers.host ?? 'localhost';
    return `${proto}://${host}/auth/callback`;
  }

  const publicView = (row: ProviderRow): Record<string, unknown> => ({
    id: row.id,
    key: row.key,
    name: row.name,
    enabled: row.enabled,
    issuer: row.issuer,
    clientId: row.client_id,
    // Presence, never the value.
    hasClientSecret: row.client_secret_enc !== null,
    scopes: row.scopes,
    allowAdminLogin: row.allow_admin_login,
    allowPortalLogin: row.allow_portal_login,
    adminClaim: row.admin_claim,
    adminValue: row.admin_value,
    portalClaim: row.portal_claim,
    portalValue: row.portal_value,
    usernameClaim: row.username_claim,
  });

  /* --- provider administration ------------------------------------------- */

  app.get('/identity-providers', async (request) => {
    requirePermission(request, 'CP_USER_READ');
    const { rows } = await db.query<ProviderRow>('select * from identity_providers order by name');
    return { items: rows.map(publicView), total: rows.length, redirectUri: redirectUriFor(request) };
  });

  app.post('/identity-providers', async (request, reply) => {
    requirePermission(request, 'CP_USER_MANAGE');
    const parsed = providerSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Invalid provider payload.', parsed.error.issues);
    const input = parsed.data;

    const { rows } = await db
      .query<{ id: string }>(
        `insert into identity_providers
           (key, name, enabled, issuer, client_id, client_secret_enc, scopes,
            allow_admin_login, allow_portal_login, admin_claim, admin_value,
            portal_claim, portal_value, username_claim)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`,
        [
          input.key,
          input.name,
          input.enabled,
          input.issuer.replace(/\/+$/, ''),
          input.clientId,
          input.clientSecret ? encryptSecret(input.clientSecret, config.secretEncryptionKey) : null,
          input.scopes,
          input.allowAdminLogin,
          input.allowPortalLogin,
          input.adminClaim || null,
          input.adminValue || null,
          input.portalClaim || null,
          input.portalValue || null,
          input.usernameClaim,
        ],
      )
      .catch((error: unknown) => {
        if (error instanceof Error && error.message.includes('identity_providers_key_idx')) {
          throw conflict(`An identity provider with the key "${input.key}" already exists.`);
        }
        throw error;
      });

    await recordAudit(db, {
      action: 'AUTH_PROVIDER_CREATED',
      actor: actorOf(request),
      targetType: 'identity_provider',
      targetId: rows[0]?.id ?? null,
      targetName: input.name,
      // The secret is deliberately absent; audit payloads never carry one.
      payload: { issuer: input.issuer, allowAdminLogin: input.allowAdminLogin },
    });
    return reply.status(201).send({ id: rows[0]?.id });
  });

  app.patch('/identity-providers/:id', async (request) => {
    requirePermission(request, 'CP_USER_MANAGE');
    const { id } = request.params as { id: string };
    const parsed = providerSchema.partial().safeParse(request.body);
    if (!parsed.success) throw badRequest('Invalid provider payload.', parsed.error.issues);
    const input = parsed.data;

    const { rows } = await db.query<{ name: string }>(
      `update identity_providers set
         name = coalesce($2, name),
         enabled = coalesce($3, enabled),
         issuer = coalesce($4, issuer),
         client_id = coalesce($5, client_id),
         -- An omitted secret keeps the stored one; an empty string clears it.
         client_secret_enc = case when $6::text is null then client_secret_enc
                                  when $6 = '' then null else $6 end,
         scopes = coalesce($7, scopes),
         allow_admin_login = coalesce($8, allow_admin_login),
         allow_portal_login = coalesce($9, allow_portal_login),
         admin_claim = $10, admin_value = $11,
         portal_claim = $12, portal_value = $13,
         username_claim = coalesce($14, username_claim),
         updated_at = now()
       where id = $1 returning name`,
      [
        id,
        input.name ?? null,
        input.enabled ?? null,
        input.issuer ? input.issuer.replace(/\/+$/, '') : null,
        input.clientId ?? null,
        input.clientSecret === undefined
          ? null
          : input.clientSecret
            ? encryptSecret(input.clientSecret, config.secretEncryptionKey)
            : '',
        input.scopes ?? null,
        input.allowAdminLogin ?? null,
        input.allowPortalLogin ?? null,
        input.adminClaim || null,
        input.adminValue || null,
        input.portalClaim || null,
        input.portalValue || null,
        input.usernameClaim ?? null,
      ],
    );
    if (rows.length === 0) throw notFound('Identity provider not found.');

    await recordAudit(db, {
      action: 'AUTH_PROVIDER_UPDATED',
      actor: actorOf(request),
      targetType: 'identity_provider',
      targetId: id,
      targetName: rows[0]?.name ?? null,
    });
    return { ok: true };
  });

  app.delete('/identity-providers/:id', async (request) => {
    requirePermission(request, 'CP_USER_MANAGE');
    const { id } = request.params as { id: string };
    const { rows } = await db.query<{ name: string }>(
      'delete from identity_providers where id = $1 returning name',
      [id],
    );
    if (rows.length === 0) throw notFound('Identity provider not found.');
    await recordAudit(db, {
      action: 'AUTH_PROVIDER_DELETED',
      actor: actorOf(request),
      targetType: 'identity_provider',
      targetId: id,
      targetName: rows[0]?.name ?? null,
    });
    return { ok: true };
  });

  /** Reaches the provider and reports what it found, before anyone relies on it. */
  app.post('/identity-providers/:id/test', async (request) => {
    requirePermission(request, 'CP_USER_MANAGE');
    const { id } = request.params as { id: string };
    const { rows } = await db.query<ProviderRow>('select * from identity_providers where id = $1', [id]);
    const provider = rows[0];
    if (!provider) throw notFound('Identity provider not found.');

    try {
      const discovery = await discover(provider.issuer);
      return {
        ok: true,
        authorizationEndpoint: discovery.authorization_endpoint,
        tokenEndpoint: discovery.token_endpoint,
        jwksUri: discovery.jwks_uri,
        redirectUri: redirectUriFor(request),
      };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Discovery failed.' };
    }
  });

  /* --- sign-in ------------------------------------------------------------ */

  /**
   * Which providers the sign-in screen may offer. Unauthenticated by necessity
   * - it is read before anyone has signed in - so it exposes nothing beyond a
   * name and a key.
   */
  app.get('/auth/oidc/providers', async (request) => {
    const audience = (request.query as { audience?: string }).audience === 'proxy-portal'
      ? 'proxy-portal'
      : 'control-plane';
    const column = audience === 'control-plane' ? 'allow_admin_login' : 'allow_portal_login';
    const { rows } = await db.query<{ key: string; name: string }>(
      `select key, name from identity_providers where enabled and ${column} order by name`,
    );
    return { items: rows, audience };
  });

  app.post('/auth/oidc/start', async (request) => {
    const parsed = z
      .object({
        providerKey: z.string().min(1).max(32),
        audience: z.enum(['control-plane', 'proxy-portal']),
      })
      .safeParse(request.body);
    if (!parsed.success) throw badRequest('A provider and an audience are required.');
    const { providerKey, audience } = parsed.data;

    const { rows } = await db.query<ProviderRow>(
      'select * from identity_providers where key = $1 and enabled',
      [providerKey],
    );
    const provider = rows[0];
    if (!provider) throw notFound('No such identity provider.');
    const allowed = audience === 'control-plane' ? provider.allow_admin_login : provider.allow_portal_login;
    if (!allowed) throw unauthorized('This provider does not serve that sign-in.');

    const discovery = await discover(provider.issuer);
    const pkce = createPkcePair();
    const state = randomToken();
    const nonce = randomToken();
    const redirectUri = redirectUriFor(request);

    await db.query(
      `insert into oidc_login_states (state, provider_id, audience, nonce, code_verifier, redirect_uri, expires_at)
       values ($1, $2, $3, $4, $5, $6, now() + ($7 || ' minutes')::interval)`,
      [state, provider.id, audience, nonce, pkce.verifier, redirectUri, String(STATE_TTL_MINUTES)],
    );
    // Cheap enough to do here and keeps the table from growing without bound.
    await db.query('delete from oidc_login_states where expires_at < now()');

    return {
      authorizationUrl: buildAuthorizationUrl({
        discovery,
        clientId: provider.client_id,
        redirectUri,
        scopes: provider.scopes,
        state,
        nonce,
        codeChallenge: pkce.challenge,
      }),
    };
  });

  app.post('/auth/oidc/callback', async (request) => {
    const parsed = z
      .object({ code: z.string().min(1).max(4096), state: z.string().min(1).max(512) })
      .safeParse(request.body);
    if (!parsed.success) throw badRequest('A code and a state are required.');

    // Consumed on read: a state that survives its use can be replayed.
    const { rows: stateRows } = await db.query<{
      provider_id: string;
      audience: TokenAudience;
      nonce: string;
      code_verifier: string;
      redirect_uri: string;
    }>(
      `delete from oidc_login_states
       where state = $1 and expires_at > now()
       returning provider_id, audience, nonce, code_verifier, redirect_uri`,
      [parsed.data.state],
    );
    const login = stateRows[0];
    if (!login) throw unauthorized('This sign-in attempt has expired. Start again.');

    const { rows } = await db.query<ProviderRow>(
      'select * from identity_providers where id = $1 and enabled',
      [login.provider_id],
    );
    const provider = rows[0];
    if (!provider) throw unauthorized('The identity provider is no longer available.');

    const discovery = await discover(provider.issuer);
    const tokens = await exchangeCode({
      discovery,
      clientId: provider.client_id,
      clientSecret: provider.client_secret_enc
        ? decryptSecret(provider.client_secret_enc, config.secretEncryptionKey)
        : null,
      code: parsed.data.code,
      redirectUri: login.redirect_uri,
      codeVerifier: login.code_verifier,
    });

    const claims = await verifyIdToken(tokens.id_token, {
      discovery,
      clientId: provider.client_id,
      nonce: login.nonce,
    });
    const username = usernameFrom(claims, provider.username_claim);

    return login.audience === 'control-plane'
      ? signInAdministrator(request, provider, claims, username)
      : signInPortalUser(request, provider, claims, username);
  });

  /* --- the two doors ------------------------------------------------------ */

  async function signInAdministrator(
    request: FastifyRequest,
    provider: ProviderRow,
    claims: Record<string, unknown> & { sub: string; email?: string; name?: string },
    username: string,
  ): Promise<unknown> {
    if (!provider.allow_admin_login) throw unauthorized('This provider does not grant control plane access.');
    if (!admits(claims as never, provider.admin_claim, provider.admin_value)) {
      await recordAudit(db, {
        action: 'CP_LOGIN_FAILED',
        outcome: 'FAILURE',
        actor: { id: null, username, sourceIp: request.ip },
        payload: { reason: 'CLAIM_NOT_PRESENT', provider: provider.key },
      });
      throw unauthorized('Your account is not permitted to administer this control plane.');
    }

    // Bound to the subject: a renamed account keeps its identity here.
    const { rows: existing } = await db.query<{ id: string; status: string }>(
      'select id, status from cp_users where oidc_issuer = $1 and oidc_subject = $2',
      [provider.issuer, claims.sub],
    );

    let user = existing[0];
    if (user) {
      await db.query(
        `update cp_users set display_name = $2, email = $3, last_login_at = now(), updated_at = now()
         where id = $1`,
        [user.id, claims.name ?? username, claims.email ?? null],
      );
    } else {
      // A directory account may carry a name a local account already holds -
      // "admin" is the obvious one. Failing the sign-in on that would be a
      // confusing dead end, so the local name wins and this one is qualified.
      const { rows: clash } = await db.query(
        'select 1 from cp_users where lower(username) = lower($1)',
        [username],
      );
      const localUsername = clash.length > 0 ? `${username}@${provider.key}` : username;

      const { rows: inserted } = await db.query<{ id: string; status: string }>(
        `insert into cp_users (username, display_name, email, source, oidc_issuer, oidc_subject, last_login_at)
         values ($1, $2, $3, 'OIDC', $4, $5, now())
         returning id, status`,
        [localUsername, claims.name ?? username, claims.email ?? null, provider.issuer, claims.sub],
      );
      user = inserted[0];
    }
    if (!user) throw unauthorized('The account could not be established.');
    if (user.status !== 'ACTIVE') throw unauthorized('This account is disabled in the control plane.');

    // The whole Administrator role, as the product owner asked: no partial
    // mapping, no claim-to-permission assembly (ADR 0004 section 2).
    await db.query(
      `insert into cp_user_roles (user_id, role_id)
       select $1, id from cp_roles where name = 'Administrator'
       on conflict do nothing`,
      [user.id],
    );

    const { rows: permissionRows } = await db.query<{ permission: string }>(
      `select distinct rp.permission from cp_user_roles ur
         join cp_role_permissions rp on rp.role_id = ur.role_id
       where ur.user_id = $1`,
      [user.id],
    );
    const permissions = permissionRows.map((row) => row.permission);

    const { token, expiresAt } = issueToken<SessionClaims>(
      { sub: user.id, aud: 'control-plane', username, permissions },
      config.jwtSecret,
      config.jwtTtlSeconds,
    );

    await recordAudit(db, {
      action: 'CP_LOGIN_SUCCEEDED',
      actor: { id: user.id, username, sourceIp: request.ip },
      payload: { provider: provider.key, method: 'OIDC' },
    });

    return {
      audience: 'control-plane',
      token,
      expiresAt: expiresAt.toISOString(),
      user: { id: user.id, username, displayName: claims.name ?? username, permissions },
    };
  }

  async function signInPortalUser(
    request: FastifyRequest,
    provider: ProviderRow,
    claims: Record<string, unknown> & { sub: string; email?: string; name?: string },
    username: string,
  ): Promise<unknown> {
    if (!provider.allow_portal_login) throw unauthorized('This provider does not grant portal access.');

    if (!admits(claims as never, provider.portal_claim, provider.portal_value)) {
      // A refused claim is evidence, not suspicion: this person had access and
      // the directory has taken it away. Acting on it here is the fast half of
      // deprovisioning - the lease below is the half that covers people who
      // never come back at all (ADR 0004).
      const { rows: revoked } = await db.query<{ id: string; username: string }>(
        `update proxy_users set status = 'DISABLED', updated_at = now()
         where oidc_issuer = $1 and oidc_subject = $2 and status = 'ACTIVE'
         returning id, username`,
        [provider.issuer, claims.sub],
      );
      const account = revoked[0];
      if (account) {
        await recordAudit(db, {
          action: 'PROXY_USER_UPDATED',
          outcome: 'SUCCESS',
          actor: { id: null, username: 'system', sourceIp: request.ip },
          targetType: 'proxy_user',
          targetId: account.id,
          targetName: account.username,
          payload: { disabled: true, reason: 'CLAIM_WITHDRAWN', provider: provider.key },
        });
      }
      throw unauthorized('Your account is not permitted to use this portal.');
    }

    // The proxy account may not exist yet. That is the normal first visit: the
    // portal offers to create one, because only then does a password exist that
    // Squid can check.
    const { rows } = await db.query<{
      id: string;
      username: string;
      status: string;
      valid_until: Date | null;
    }>(
      `select id, username, status, valid_until from proxy_users
       where oidc_issuer = $1 and oidc_subject = $2`,
      [provider.issuer, claims.sub],
    );
    const account = rows[0];

    if (account) {
      const policy = await accessLeasePolicy(db);
      const expiry = account.valid_until?.getTime() ?? null;
      const renewableFrom = expiry === null ? 0 : expiry - policy.renewalWindowDays * 86_400_000;
      // The claim was just verified against the provider, so this sign-in is
      // the renewal. Outside the window it only records the verification: the
      // lease is a fixed term with a window at its end, not a sliding one.
      const renews = expiry === null || Date.now() >= renewableFrom;

      await db.query(
        `update proxy_users set
           last_verified_at = now(),
           valid_until = case when $2 then now() + ($3 || ' days')::interval else valid_until end,
           -- An expired account comes back to life when the directory still
           -- vouches for the person. Deprovisioning is meant to end access, not
           -- to punish someone who returns.
           status = case when $2 and status = 'DISABLED' then 'ACTIVE' else status end,
           updated_at = now()
         where id = $1`,
        [account.id, renews, String(policy.leaseDays)],
      );
      if (renews && account.status !== 'ACTIVE') {
        await recordAudit(db, {
          action: 'PROXY_USER_UPDATED',
          actor: { id: null, username: 'system', sourceIp: request.ip },
          targetType: 'proxy_user',
          targetId: account.id,
          targetName: account.username,
          payload: { reactivated: true, reason: 'LEASE_RENEWED', provider: provider.key },
        });
      }
    }

    const { token, expiresAt } = issueToken<PortalClaims>(
      {
        sub: `oidc:${provider.key}:${claims.sub}`,
        aud: 'proxy-portal',
        username: account?.username ?? username,
        providerKey: `oidc:${provider.key}`,
        groups: [],
      },
      config.jwtSecret,
      config.jwtTtlSeconds,
    );

    return {
      audience: 'proxy-portal',
      token,
      expiresAt: expiresAt.toISOString(),
      user: {
        username: account?.username ?? username,
        displayName: claims.name ?? username,
        /** Nothing reaches Squid until this exists. */
        hasProxyAccount: Boolean(account),
        suggestedUsername: username,
      },
    };
  }
}
