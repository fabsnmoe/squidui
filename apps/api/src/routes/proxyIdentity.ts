import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hashProxyPassword, validatePasswordStrength } from '@scp/shared/crypt';
import { recordAudit } from '../audit/sink.js';
import { actorOf, badRequest, conflict, notFound, requirePermission } from '../http/context.js';
import { withTransaction } from '../db/pool.js';
import type { AppContext } from '../server.js';

/**
 * Local proxy users and proxy groups (PLAN.md 9.4, 9.11, 9.12).
 *
 * No endpoint in this file ever returns a password or a password hash - not
 * even masked. The UI shows a fixed placeholder and a "replace password"
 * action instead (PRODUCT.md section 16).
 */

const USERNAME_PATTERN = /^[A-Za-z0-9._@-]{1,64}$/;

const userCreateSchema = z.object({
  username: z.string().regex(USERNAME_PATTERN, 'Use letters, digits, dot, underscore, at sign or hyphen.'),
  displayName: z.string().max(128).nullable().optional(),
  description: z.string().max(512).nullable().optional(),
  status: z.enum(['ACTIVE', 'DISABLED']).default('ACTIVE'),
  password: z.string().min(1).max(256).optional(),
  groupIds: z.array(z.string().uuid()).max(64).default([]),
});

const userPatchSchema = z.object({
  displayName: z.string().max(128).nullable().optional(),
  description: z.string().max(512).nullable().optional(),
  status: z.enum(['ACTIVE', 'DISABLED']).optional(),
  groupIds: z.array(z.string().uuid()).max(64).optional(),
});

const passwordSchema = z.object({ password: z.string().min(1).max(256) });

const groupCreateSchema = z.object({
  name: z.string().min(1).max(128),
  description: z.string().max(512).nullable().optional(),
  source: z.enum(['LOCAL', 'EXTERNAL', 'LOGICAL']).default('LOCAL'),
  providerKey: z.string().max(64).nullable().optional(),
  externalId: z.string().max(512).nullable().optional(),
  memberGroupIds: z.array(z.string().uuid()).max(64).default([]),
});

const groupPatchSchema = groupCreateSchema.partial().omit({ source: true });

interface UserRow {
  id: string;
  username: string;
  display_name: string | null;
  description: string | null;
  status: 'ACTIVE' | 'DISABLED';
  password_updated_at: Date | null;
  source: string;
  valid_until: Date | null;
  last_verified_at: Date | null;
  created_at: Date;
  updated_at: Date;
  has_password: boolean;
  groups: Array<{ id: string; name: string }> | null;
}

function toUser(row: UserRow) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    description: row.description,
    status: row.status,
    hasPassword: row.has_password,
    groups: row.groups ?? [],
    passwordUpdatedAt: row.password_updated_at?.toISOString() ?? null,
    // Where the account came from and how long its access still runs. An
    // administrator has to be able to see a lease without opening the database
    // (ADR 0004 section 6).
    source: row.source,
    validUntil: row.valid_until?.toISOString() ?? null,
    lastVerifiedAt: row.last_verified_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

const USER_SELECT = `
  select u.id, u.username, u.display_name, u.description, u.status,
         u.password_updated_at, u.created_at, u.updated_at,
         u.source, u.valid_until, u.last_verified_at,
         (u.password_hash is not null) as has_password,
         coalesce(
           (select json_agg(json_build_object('id', g.id, 'name', g.name) order by g.name)
            from proxy_user_groups ug join proxy_groups g on g.id = ug.group_id
            where ug.user_id = u.id),
           '[]'::json
         ) as groups
  from proxy_users u`;

export async function registerProxyIdentityRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  const { db, config } = context;

  async function replaceGroups(
    client: { query: (text: string, values?: unknown[]) => Promise<unknown> },
    userId: string,
    groupIds: string[],
  ): Promise<void> {
    await client.query('delete from proxy_user_groups where user_id = $1', [userId]);
    for (const groupId of groupIds) {
      await client.query(
        'insert into proxy_user_groups (user_id, group_id) values ($1, $2) on conflict do nothing',
        [userId, groupId],
      );
    }
  }

  /* --- Users ------------------------------------------------------------- */

  app.get('/proxy-users', async (request) => {
    requirePermission(request, 'PROXY_USER_READ');
    const query = request.query as { search?: string; status?: string; groupId?: string } | undefined;

    const conditions: string[] = [];
    const params: unknown[] = [];
    if (query?.search) {
      params.push(`%${query.search}%`);
      conditions.push(`(u.username ilike $${params.length} or u.display_name ilike $${params.length})`);
    }
    if (query?.status === 'ACTIVE' || query?.status === 'DISABLED') {
      params.push(query.status);
      conditions.push(`u.status = $${params.length}`);
    }
    if (query?.groupId) {
      params.push(query.groupId);
      conditions.push(
        `exists (select 1 from proxy_user_groups ug where ug.user_id = u.id and ug.group_id = $${params.length})`,
      );
    }
    const where = conditions.length > 0 ? `where ${conditions.join(' and ')}` : '';

    const { rows } = await db.query<UserRow>(`${USER_SELECT} ${where} order by u.username`, params);
    return { items: rows.map(toUser), total: rows.length };
  });

  app.get('/proxy-users/:id', async (request) => {
    requirePermission(request, 'PROXY_USER_READ');
    const { id } = request.params as { id: string };
    const { rows } = await db.query<UserRow>(`${USER_SELECT} where u.id = $1`, [id]);
    const user = rows[0];
    if (!user) throw notFound('Proxy user not found.');
    return toUser(user);
  });

  app.post('/proxy-users', async (request, reply) => {
    requirePermission(request, 'PROXY_USER_CREATE');
    const parsed = userCreateSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Invalid proxy user payload.', parsed.error.issues);
    const input = parsed.data;

    if (input.password) {
      const violations = validatePasswordStrength(input.password);
      if (violations.length > 0) throw badRequest('The password does not meet the policy.', violations);
    }

    const { rows: existing } = await db.query('select 1 from proxy_users where lower(username) = lower($1)', [
      input.username,
    ]);
    if (existing.length > 0) throw conflict(`A proxy user named "${input.username}" already exists.`);

    const passwordHash = input.password ? hashProxyPassword(input.password, config.proxyPasswordFormat) : null;

    const id = await withTransaction(db, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `insert into proxy_users
           (username, display_name, description, status, password_hash, password_format, password_updated_at)
         values ($1, $2, $3, $4, $5, $6, case when $5::text is null then null else now() end)
         returning id`,
        [
          input.username,
          input.displayName ?? null,
          input.description ?? null,
          input.status,
          passwordHash,
          passwordHash ? config.proxyPasswordFormat : null,
        ],
      );
      const userId = rows[0]?.id as string;
      await replaceGroups(client, userId, input.groupIds);
      return userId;
    });

    await recordAudit(db, {
      action: 'PROXY_USER_CREATED',
      actor: actorOf(request),
      targetType: 'proxy_user',
      targetId: id,
      targetName: input.username,
      payload: { status: input.status, groups: input.groupIds.length, passwordSet: Boolean(passwordHash) },
    });

    const { rows } = await db.query<UserRow>(`${USER_SELECT} where u.id = $1`, [id]);
    return reply.status(201).send(toUser(rows[0] as UserRow));
  });

  app.patch('/proxy-users/:id', async (request) => {
    requirePermission(request, 'PROXY_USER_UPDATE');
    const { id } = request.params as { id: string };
    const parsed = userPatchSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Invalid proxy user payload.', parsed.error.issues);
    const patch = parsed.data;

    const { rows: currentRows } = await db.query<UserRow>(`${USER_SELECT} where u.id = $1`, [id]);
    const current = currentRows[0];
    if (!current) throw notFound('Proxy user not found.');

    await withTransaction(db, async (client) => {
      await client.query(
        `update proxy_users
         set display_name = $2, description = $3, status = $4,
             -- An administrator touching the status owns that decision from now
             -- on: clearing the reason stops a later sign-in from undoing it.
             disabled_reason = case when $5::boolean then null else disabled_reason end,
             updated_at = now()
         where id = $1`,
        [
          id,
          patch.displayName === undefined ? current.display_name : patch.displayName,
          patch.description === undefined ? current.description : patch.description,
          patch.status ?? current.status,
          patch.status !== undefined,
        ],
      );
      if (patch.groupIds) await replaceGroups(client, id, patch.groupIds);
    });

    if (patch.status === 'DISABLED' && current.status !== 'DISABLED') {
      await recordAudit(db, {
        action: 'PROXY_USER_DISABLED',
        actor: actorOf(request),
        targetType: 'proxy_user',
        targetId: id,
        targetName: current.username,
      });
    }
    await recordAudit(db, {
      action: 'PROXY_USER_UPDATED',
      actor: actorOf(request),
      targetType: 'proxy_user',
      targetId: id,
      targetName: current.username,
      payload: { status: patch.status ?? current.status, groupsChanged: patch.groupIds !== undefined },
    });

    const { rows } = await db.query<UserRow>(`${USER_SELECT} where u.id = $1`, [id]);
    return toUser(rows[0] as UserRow);
  });

  app.post('/proxy-users/:id/password', async (request) => {
    requirePermission(request, 'PROXY_USER_PASSWORD_RESET');
    const { id } = request.params as { id: string };
    const parsed = passwordSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('A password is required.');

    const violations = validatePasswordStrength(parsed.data.password);
    if (violations.length > 0) throw badRequest('The password does not meet the policy.', violations);

    const { rows } = await db.query<{ username: string }>('select username from proxy_users where id = $1', [id]);
    const user = rows[0];
    if (!user) throw notFound('Proxy user not found.');

    // The plaintext exists only inside this call; only the crypt(3) string is
    // written (PLAN.md 9.5).
    const hash = hashProxyPassword(parsed.data.password, config.proxyPasswordFormat);
    await db.query(
      `update proxy_users
       set password_hash = $2, password_format = $3, password_updated_at = now(), updated_at = now()
       where id = $1`,
      [id, hash, config.proxyPasswordFormat],
    );

    await recordAudit(db, {
      action: 'PROXY_USER_PASSWORD_CHANGED',
      actor: actorOf(request),
      targetType: 'proxy_user',
      targetId: id,
      targetName: user.username,
      payload: { format: config.proxyPasswordFormat },
    });

    return { ok: true, passwordUpdatedAt: new Date().toISOString() };
  });

  app.delete('/proxy-users/:id', async (request) => {
    requirePermission(request, 'PROXY_USER_DELETE');
    const { id } = request.params as { id: string };
    const { rows } = await db.query<{ username: string }>('select username from proxy_users where id = $1', [id]);
    const user = rows[0];
    if (!user) throw notFound('Proxy user not found.');

    await db.query('delete from proxy_users where id = $1', [id]);
    await recordAudit(db, {
      action: 'PROXY_USER_DELETED',
      actor: actorOf(request),
      targetType: 'proxy_user',
      targetId: id,
      targetName: user.username,
    });
    return { ok: true };
  });

  /* --- Groups ------------------------------------------------------------ */

  const GROUP_SELECT = `
    select g.id, g.name, g.description, g.source, g.provider_key, g.external_id,
           g.created_at, g.updated_at,
           (select count(*) from proxy_user_groups ug where ug.group_id = g.id)::int as member_count,
           coalesce(
             (select json_agg(json_build_object('id', m.id, 'name', m.name, 'source', m.source,
                                                'providerKey', m.provider_key) order by m.name)
              from logical_group_members lgm join proxy_groups m on m.id = lgm.member_group_id
              where lgm.logical_group_id = g.id),
             '[]'::json
           ) as members
    from proxy_groups g`;

  interface GroupRow {
    id: string;
    name: string;
    description: string | null;
    source: 'LOCAL' | 'EXTERNAL' | 'LOGICAL';
    provider_key: string | null;
    external_id: string | null;
    member_count: number;
    members: Array<{ id: string; name: string; source: string; providerKey: string | null }>;
    created_at: Date;
    updated_at: Date;
  }

  const toGroup = (row: GroupRow) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    source: row.source,
    providerKey: row.provider_key,
    externalId: row.external_id,
    memberCount: row.member_count,
    members: row.members ?? [],
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });

  app.get('/proxy-groups', async (request) => {
    requirePermission(request, 'PROXY_GROUP_READ');
    const query = request.query as { source?: string } | undefined;
    const params: unknown[] = [];
    let where = '';
    if (query?.source) {
      params.push(query.source);
      where = 'where g.source = $1';
    }
    const { rows } = await db.query<GroupRow>(`${GROUP_SELECT} ${where} order by g.source, g.name`, params);
    return { items: rows.map(toGroup), total: rows.length };
  });

  app.post('/proxy-groups', async (request, reply) => {
    requirePermission(request, 'PROXY_GROUP_MANAGE');
    const parsed = groupCreateSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Invalid group payload.', parsed.error.issues);
    const input = parsed.data;

    if (input.source === 'EXTERNAL' && !input.providerKey) {
      throw badRequest('An external group needs the provider it comes from.');
    }

    const id = await withTransaction(db, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `insert into proxy_groups (name, description, source, provider_key, external_id)
         values ($1, $2, $3, $4, $5) returning id`,
        [
          input.name,
          input.description ?? null,
          input.source,
          input.source === 'EXTERNAL' ? (input.providerKey ?? null) : null,
          input.externalId ?? null,
        ],
      );
      const groupId = rows[0]?.id as string;
      if (input.source === 'LOGICAL') {
        for (const memberId of input.memberGroupIds) {
          await client.query(
            'insert into logical_group_members (logical_group_id, member_group_id) values ($1, $2) on conflict do nothing',
            [groupId, memberId],
          );
        }
      }
      return groupId;
    }).catch((error: unknown) => {
      if (error instanceof Error && error.message.includes('proxy_groups_identity_key')) {
        throw conflict(`A ${input.source.toLowerCase()} group named "${input.name}" already exists.`);
      }
      throw error;
    });

    await recordAudit(db, {
      action: 'PROXY_GROUP_CREATED',
      actor: actorOf(request),
      targetType: 'proxy_group',
      targetId: id,
      targetName: input.name,
      payload: { source: input.source, providerKey: input.providerKey ?? null },
    });

    const { rows } = await db.query<GroupRow>(`${GROUP_SELECT} where g.id = $1`, [id]);
    return reply.status(201).send(toGroup(rows[0] as GroupRow));
  });

  app.patch('/proxy-groups/:id', async (request) => {
    requirePermission(request, 'PROXY_GROUP_MANAGE');
    const { id } = request.params as { id: string };
    const parsed = groupPatchSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Invalid group payload.', parsed.error.issues);
    const patch = parsed.data;

    const { rows: currentRows } = await db.query<GroupRow>(`${GROUP_SELECT} where g.id = $1`, [id]);
    const current = currentRows[0];
    if (!current) throw notFound('Group not found.');

    await withTransaction(db, async (client) => {
      await client.query(
        'update proxy_groups set name = $2, description = $3, external_id = $4, updated_at = now() where id = $1',
        [
          id,
          patch.name ?? current.name,
          patch.description === undefined ? current.description : patch.description,
          patch.externalId === undefined ? current.external_id : patch.externalId,
        ],
      );
      if (current.source === 'LOGICAL' && patch.memberGroupIds) {
        await client.query('delete from logical_group_members where logical_group_id = $1', [id]);
        for (const memberId of patch.memberGroupIds) {
          if (memberId === id) continue;
          await client.query(
            'insert into logical_group_members (logical_group_id, member_group_id) values ($1, $2) on conflict do nothing',
            [id, memberId],
          );
        }
      }
    });

    await recordAudit(db, {
      action: 'PROXY_GROUP_UPDATED',
      actor: actorOf(request),
      targetType: 'proxy_group',
      targetId: id,
      targetName: patch.name ?? current.name,
    });

    const { rows } = await db.query<GroupRow>(`${GROUP_SELECT} where g.id = $1`, [id]);
    return toGroup(rows[0] as GroupRow);
  });

  app.delete('/proxy-groups/:id', async (request) => {
    requirePermission(request, 'PROXY_GROUP_MANAGE');
    const { id } = request.params as { id: string };
    const { rows } = await db.query<{ name: string }>('select name from proxy_groups where id = $1', [id]);
    const group = rows[0];
    if (!group) throw notFound('Group not found.');

    // Deleting a group that a rule still references would silently change the
    // effective policy, so it is refused with the list of blocking rules.
    const { rows: usedBy } = await db.query<{ name: string; position: number }>(
      `select name, position from access_rules
       where identity->>'kind' = 'GROUP'
         and identity->'groupIds' @> to_jsonb($1::text)
       order by position`,
      [id],
    );
    if (usedBy.length > 0) {
      throw conflict(
        `This group is used by ${usedBy.length} access rule(s): ${usedBy
          .map((rule) => `${rule.position} "${rule.name}"`)
          .join(', ')}. Remove it from those rules first.`,
      );
    }

    await db.query('delete from proxy_groups where id = $1', [id]);
    await recordAudit(db, {
      action: 'PROXY_GROUP_DELETED',
      actor: actorOf(request),
      targetType: 'proxy_group',
      targetId: id,
      targetName: group.name,
    });
    return { ok: true };
  });
}
