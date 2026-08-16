import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { verifyControlPlanePassword, hashControlPlanePassword, validatePasswordStrength } from '@scp/shared/crypt';
import { recordAudit } from '../audit/sink.js';
import { actorOf, badRequest, clientIp, requireAuth, unauthorized, HttpError } from '../http/context.js';
import { issueToken, type SessionClaims } from '../security/jwt.js';
import type { AppContext } from '../server.js';

/**
 * Control plane sessions.
 *
 * This is the *control plane* identity plane. Nothing here touches proxy users
 * (PRODUCT.md section 1).
 */

const loginSchema = z.object({
  username: z.string().min(1).max(128),
  password: z.string().min(1).max(256),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(1).max(256),
});

interface UserRow {
  id: string;
  username: string;
  display_name: string | null;
  password_hash: string;
  status: string;
  must_change_password: boolean;
}

async function permissionsOf(context: AppContext, userId: string): Promise<string[]> {
  const { rows } = await context.db.query<{ permission: string }>(
    `select distinct rp.permission
     from cp_user_roles ur
     join cp_role_permissions rp on rp.role_id = ur.role_id
     where ur.user_id = $1`,
    [userId],
  );
  return rows.map((row) => row.permission).sort();
}

export async function registerSessionRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  const { db, config } = context;

  app.post('/session', async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Username and password are required.');
    const { username, password } = parsed.data;

    const ip = clientIp(request);
    // Two buckets: one per source address, one per account, so neither a
    // single host nor a single targeted account can be hammered (T3).
    for (const key of [`ip:${ip}`, `user:${username.toLowerCase()}`]) {
      const decision = context.loginLimiter.check(key);
      if (!decision.allowed) {
        reply.header('Retry-After', String(decision.retryAfterSeconds));
        throw new HttpError(429, 'RATE_LIMITED', 'Too many login attempts. Try again later.');
      }
    }

    const { rows } = await db.query<UserRow>(
      `select id, username, display_name, password_hash, status, must_change_password
       from cp_users where lower(username) = lower($1)`,
      [username],
    );
    const user = rows[0];

    // One generic failure for every cause, so the response cannot be used to
    // enumerate accounts. The audit event keeps the real reason.
    const failure = async (reason: string): Promise<HttpError> => {
      await recordAudit(db, {
        action: 'CP_LOGIN_FAILED',
        outcome: 'FAILURE',
        actor: { id: null, username, sourceIp: ip },
        payload: { reason },
      });
      return unauthorized('Invalid username or password.');
    };

    if (!user) {
      // Spend comparable work even for unknown users.
      verifyControlPlanePassword(password, 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA');
      throw await failure('UNKNOWN_USER');
    }
    if (user.status !== 'ACTIVE') throw await failure('USER_DISABLED');
    if (!verifyControlPlanePassword(password, user.password_hash)) throw await failure('BAD_PASSWORD');

    const permissions = await permissionsOf(context, user.id);
    const { token, expiresAt } = issueToken<SessionClaims>(
      { sub: user.id, aud: 'control-plane', username: user.username, permissions },
      config.jwtSecret,
      config.jwtTtlSeconds,
    );

    await db.query('update cp_users set last_login_at = now() where id = $1', [user.id]);
    context.loginLimiter.reset(`ip:${ip}`);
    context.loginLimiter.reset(`user:${username.toLowerCase()}`);

    await recordAudit(db, {
      action: 'CP_LOGIN_SUCCEEDED',
      actor: { id: user.id, username: user.username, sourceIp: ip },
    });

    return {
      token,
      expiresAt: expiresAt.toISOString(),
      user: {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        permissions,
        mustChangePassword: user.must_change_password,
      },
    };
  });

  app.get('/session', async (request) => {
    const principal = requireAuth(request);
    const { rows } = await db.query<UserRow>(
      'select id, username, display_name, password_hash, status, must_change_password from cp_users where id = $1',
      [principal.id],
    );
    const user = rows[0];
    if (!user || user.status !== 'ACTIVE') throw unauthorized('Session is no longer valid.');

    return {
      user: {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        permissions: await permissionsOf(context, user.id),
        mustChangePassword: user.must_change_password,
      },
      build: config.build,
    };
  });

  app.delete('/session', async (request) => {
    const principal = requireAuth(request);
    await recordAudit(db, { action: 'CP_LOGOUT', actor: actorOf(request) });
    return { ok: true, username: principal.username };
  });

  app.post('/session/password', async (request) => {
    const principal = requireAuth(request);
    const parsed = changePasswordSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Current and new password are required.');

    const violations = validatePasswordStrength(parsed.data.newPassword);
    if (violations.length > 0) {
      throw badRequest('The new password does not meet the policy.', violations);
    }

    const { rows } = await db.query<{ password_hash: string }>(
      'select password_hash from cp_users where id = $1',
      [principal.id],
    );
    const stored = rows[0]?.password_hash;
    if (!stored || !verifyControlPlanePassword(parsed.data.currentPassword, stored)) {
      throw unauthorized('The current password is not correct.');
    }

    await db.query(
      'update cp_users set password_hash = $2, must_change_password = false, updated_at = now() where id = $1',
      [principal.id, hashControlPlanePassword(parsed.data.newPassword)],
    );
    await recordAudit(db, {
      action: 'CP_USER_UPDATED',
      actor: actorOf(request),
      targetType: 'cp_user',
      targetId: principal.id,
      targetName: principal.username,
      payload: { change: 'password' },
    });

    return { ok: true };
  });
}
