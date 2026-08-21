import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hashProxyPassword, validatePasswordStrength } from '@scp/shared/crypt';
import { recordAudit } from '../audit/sink.js';
import { badRequest, conflict, requirePortalAuth, unauthorized } from '../http/context.js';
import { accessLeasePolicy } from '../services/settings.js';
import type { AppContext } from '../server.js';

/**
 * Self-service proxy accounts for people who signed in with OIDC (ADR 0004).
 *
 * This is the bridge between the two identity planes, and the only place it
 * exists. Keycloak proves who the person is; Squid needs a password it can
 * check with HTTP Basic. So the person sets one here, and it reaches Squid
 * through the same NCSA file as any local proxy user.
 *
 * The password set here is not the directory password and is never compared
 * against it. The portal says so, because a user who assumes otherwise will try
 * their real password against the proxy and wonder why it fails.
 */

const usernamePattern = /^[A-Za-z0-9._@-]{1,64}$/;

const createSchema = z.object({
  username: z.string().regex(usernamePattern),
  password: z.string().min(1).max(256),
});

const passwordSchema = z.object({ password: z.string().min(1).max(256) });

/** `oidc:<providerKey>:<subject>` - the subject may itself contain colons. */
function oidcIdentity(sub: string): { providerKey: string; subject: string } | null {
  if (!sub.startsWith('oidc:')) return null;
  const rest = sub.slice('oidc:'.length);
  const separator = rest.indexOf(':');
  if (separator <= 0) return null;
  return { providerKey: rest.slice(0, separator), subject: rest.slice(separator + 1) };
}

export async function registerPortalOidcRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  const { db, config } = context;

  async function issuerOf(providerKey: string): Promise<string | null> {
    const { rows } = await db.query<{ issuer: string }>(
      'select issuer from identity_providers where key = $1 and enabled',
      [providerKey],
    );
    return rows[0]?.issuer ?? null;
  }

  /** The signed-in person, and the proxy account they have - if any. */
  app.get('/portal/proxy-account', async (request) => {
    const principal = requirePortalAuth(request);
    const identity = oidcIdentity(principal.subject);
    if (!identity) {
      // A local proxy user already is their proxy account.
      return { managed: false, hasAccount: true, username: principal.username };
    }

    const issuer = await issuerOf(identity.providerKey);
    if (!issuer) throw unauthorized('The identity provider is no longer available.');

    const { rows } = await db.query<{
      username: string;
      status: string;
      password_updated_at: Date | null;
      created_at: Date;
      valid_until: Date | null;
      last_verified_at: Date | null;
      lease_notice_ack_at: Date | null;
    }>(
      `select username, status, password_updated_at, created_at,
              valid_until, last_verified_at, lease_notice_ack_at
       from proxy_users where oidc_issuer = $1 and oidc_subject = $2`,
      [issuer, identity.subject],
    );
    const account = rows[0];
    const policy = await accessLeasePolicy(db);

    const expiry = account?.valid_until ?? null;
    const renewableFrom = expiry
      ? new Date(expiry.getTime() - policy.renewalWindowDays * 86_400_000)
      : null;
    const inRenewalWindow = renewableFrom !== null && Date.now() >= renewableFrom.getTime();

    return {
      managed: true,
      hasAccount: Boolean(account),
      username: account?.username ?? principal.username,
      status: account?.status ?? null,
      passwordUpdatedAt: account?.password_updated_at?.toISOString() ?? null,
      createdAt: account?.created_at?.toISOString() ?? null,
      lease: {
        days: policy.leaseDays,
        renewalWindowDays: policy.renewalWindowDays,
        validUntil: expiry?.toISOString() ?? null,
        renewableFrom: renewableFrom?.toISOString() ?? null,
        inRenewalWindow,
        lastVerifiedAt: account?.last_verified_at?.toISOString() ?? null,
        /**
         * The notice is due once when access is first granted, and again once
         * the renewal window opens. There is no mail in this product, so the
         * portal is the only place a person can be told - and being told once,
         * ninety days ago, is not being told.
         */
        noticeDue:
          Boolean(account) &&
          (!account?.lease_notice_ack_at ||
            // Acknowledging the first notice must not silence the renewal one,
            // and acknowledging the renewal one must not make it reappear.
            (inRenewalWindow &&
              renewableFrom !== null &&
              account.lease_notice_ack_at.getTime() < renewableFrom.getTime())),
      },
      /** Stated here so the UI does not have to invent the wording. */
      notice:
        'This password is used only by the proxy. It is separate from your organisational password and is never checked against it.',
    };
  });

  /** Creates the proxy account for the signed-in person. Once. */
  app.post('/portal/proxy-account', async (request, reply) => {
    const principal = requirePortalAuth(request);
    const identity = oidcIdentity(principal.subject);
    if (!identity) throw conflict('You already have a proxy account.');

    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest('A username and a password are required.', parsed.error.issues);
    }
    const violations = validatePasswordStrength(parsed.data.password);
    if (violations.length > 0) throw badRequest('The password does not meet the policy.', violations);

    const issuer = await issuerOf(identity.providerKey);
    if (!issuer) throw unauthorized('The identity provider is no longer available.');

    const { rows: existing } = await db.query<{ id: string }>(
      'select id from proxy_users where oidc_issuer = $1 and oidc_subject = $2',
      [issuer, identity.subject],
    );
    // One person, one proxy account (ADR 0004 section 3).
    if (existing.length > 0) throw conflict('You already have a proxy account.');

    const hash = hashProxyPassword(parsed.data.password, config.proxyPasswordFormat);
    const policy = await accessLeasePolicy(db);
    const { rows } = await db
      .query<{ id: string; valid_until: Date }>(
        `insert into proxy_users
           (username, display_name, status, password_hash, password_format, password_updated_at,
            source, oidc_issuer, oidc_subject, valid_until, last_verified_at)
         values ($1, $2, 'ACTIVE', $3, $4, now(), 'OIDC', $5, $6,
                 now() + ($7 || ' days')::interval, now())
         returning id, valid_until`,
        [
          parsed.data.username,
          principal.username,
          hash,
          config.proxyPasswordFormat,
          issuer,
          identity.subject,
          String(policy.leaseDays),
        ],
      )
      .catch((error: unknown) => {
        if (error instanceof Error && error.message.includes('proxy_users_username_key')) {
          throw conflict('That username is already taken. Choose another.');
        }
        throw error;
      });

    await recordAudit(db, {
      action: 'PROXY_USER_CREATED',
      actor: { id: null, username: `portal:${principal.username}`, sourceIp: request.ip },
      targetType: 'proxy_user',
      targetId: rows[0]?.id ?? null,
      targetName: parsed.data.username,
      // No password, no hash - the audit sink would redact them anyway.
      payload: { selfService: true, provider: identity.providerKey },
    });

    return reply.status(201).send({
      username: parsed.data.username,
      validUntil: rows[0]?.valid_until?.toISOString() ?? null,
      leaseDays: policy.leaseDays,
    });
  });

  /** Records that the person has been shown how long their access lasts. */
  app.post('/portal/proxy-account/acknowledge', async (request) => {
    const principal = requirePortalAuth(request);
    const identity = oidcIdentity(principal.subject);
    if (!identity) return { ok: true };

    const issuer = await issuerOf(identity.providerKey);
    if (!issuer) throw unauthorized('The identity provider is no longer available.');

    await db.query(
      `update proxy_users set lease_notice_ack_at = now()
       where oidc_issuer = $1 and oidc_subject = $2`,
      [issuer, identity.subject],
    );
    return { ok: true };
  });

  /**
   * Sets a new proxy password. No current password is required: the person just
   * proved who they are against the identity provider, which is a stronger
   * proof than the password being replaced.
   */
  app.post('/portal/proxy-account/password', async (request) => {
    const principal = requirePortalAuth(request);
    const identity = oidcIdentity(principal.subject);
    if (!identity) {
      throw conflict('Use the password form for local accounts, which asks for your current password.');
    }

    const parsed = passwordSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('A new password is required.');
    const violations = validatePasswordStrength(parsed.data.password);
    if (violations.length > 0) throw badRequest('The password does not meet the policy.', violations);

    const issuer = await issuerOf(identity.providerKey);
    if (!issuer) throw unauthorized('The identity provider is no longer available.');

    const hash = hashProxyPassword(parsed.data.password, config.proxyPasswordFormat);
    const { rows } = await db.query<{ id: string; username: string }>(
      `update proxy_users
         set password_hash = $3, password_format = $4, password_updated_at = now(), updated_at = now()
       where oidc_issuer = $1 and oidc_subject = $2 and status = 'ACTIVE'
       returning id, username`,
      [issuer, identity.subject, hash, config.proxyPasswordFormat],
    );
    const account = rows[0];
    if (!account) throw conflict('You do not have an active proxy account yet.');

    await recordAudit(db, {
      action: 'PROXY_USER_PASSWORD_CHANGED',
      actor: { id: null, username: `portal:${account.username}`, sourceIp: request.ip },
      targetType: 'proxy_user',
      targetId: account.id,
      targetName: account.username,
      payload: { selfService: true },
    });

    return { ok: true };
  });
}
