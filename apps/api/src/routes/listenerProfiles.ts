import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AUTHENTICATION_MODES } from '@scp/shared';
import { recordAudit } from '../audit/sink.js';
import { actorOf, badRequest, conflict, notFound, requirePermission } from '../http/context.js';
import type { AppContext } from '../server.js';

/**
 * Node groups and listener profiles (ADR 0003).
 *
 * A listener profile carries its own authentication mode, which is what makes
 * a corporate listener requiring credentials and a guest listener requiring
 * none coexist on one node. `INHERIT` follows the global default, so a
 * single-node installation never has to look at any of this.
 */

const groupSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(512).nullable().optional(),
  labels: z.record(z.string().max(64), z.string().max(128)).optional(),
});

const profileSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(512).nullable().optional(),
  address: z.string().min(1).max(64).default('0.0.0.0'),
  port: z.number().int().min(1).max(65535).default(3128),
  mode: z.enum(['FORWARD', 'INTERCEPT']).default('FORWARD'),
  enabled: z.boolean().default(true),
  authenticationMode: z.enum(['INHERIT', ...AUTHENTICATION_MODES]).default('INHERIT'),
  sourceNetworkIds: z.array(z.string().uuid()).max(32).default([]),
  /** Null assigns the profile to every group. */
  groupId: z.string().uuid().nullable().optional(),
});

export async function registerListenerProfileRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  const { db } = context;

  /* --- Node groups ------------------------------------------------------- */

  app.get('/node-groups', async (request) => {
    requirePermission(request, 'NODE_READ');
    const { rows } = await db.query(
      `select g.id, g.name, g.description, g.labels, g.is_default, g.created_at,
              (select count(*) from proxy_nodes n where n.group_id = g.id)::int as node_count,
              (select count(*) from listener_profiles l where l.group_id = g.id)::int as listener_count
       from node_groups g order by g.is_default desc, g.name`,
    );
    return { items: rows, total: rows.length };
  });

  app.post('/node-groups', async (request, reply) => {
    requirePermission(request, 'NODE_MANAGE');
    const parsed = groupSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Invalid group payload.', parsed.error.issues);

    const { rows } = await db
      .query<{ id: string }>(
        `insert into node_groups (name, description, labels) values ($1, $2, $3::jsonb) returning id`,
        [parsed.data.name, parsed.data.description ?? null, JSON.stringify(parsed.data.labels ?? {})],
      )
      .catch((error: unknown) => {
        if (error instanceof Error && error.message.includes('node_groups_name_key')) {
          throw conflict(`A node group named "${parsed.data.name}" already exists.`);
        }
        throw error;
      });

    await recordAudit(db, {
      action: 'NODE_UPDATED',
      actor: actorOf(request),
      targetType: 'node_group',
      targetId: rows[0]?.id ?? null,
      targetName: parsed.data.name,
      payload: { created: true },
    });
    return reply.status(201).send({ id: rows[0]?.id });
  });

  app.patch('/node-groups/:id', async (request) => {
    requirePermission(request, 'NODE_MANAGE');
    const { id } = request.params as { id: string };
    const parsed = groupSchema.partial().safeParse(request.body);
    if (!parsed.success) throw badRequest('Invalid group payload.', parsed.error.issues);

    const { rows } = await db.query<{ name: string }>(
      `update node_groups set
         name = coalesce($2, name),
         description = coalesce($3, description),
         labels = coalesce($4::jsonb, labels),
         updated_at = now()
       where id = $1 returning name`,
      [id, parsed.data.name ?? null, parsed.data.description ?? null,
       parsed.data.labels ? JSON.stringify(parsed.data.labels) : null],
    );
    if (rows.length === 0) throw notFound('Node group not found.');
    return { ok: true };
  });

  app.delete('/node-groups/:id', async (request) => {
    requirePermission(request, 'NODE_MANAGE');
    const { id } = request.params as { id: string };

    const { rows } = await db.query<{ name: string; is_default: boolean; nodes: number }>(
      `select g.name, g.is_default,
              (select count(*) from proxy_nodes n where n.group_id = g.id)::int as nodes
       from node_groups g where g.id = $1`,
      [id],
    );
    const group = rows[0];
    if (!group) throw notFound('Node group not found.');
    // The default group is where an unassigned node lands; without it a node
    // would have nowhere to go.
    if (group.is_default) throw conflict('The default group cannot be deleted.');
    if (group.nodes > 0) {
      throw conflict(`${group.nodes} node(s) still belong to this group. Move them first.`);
    }

    await db.query('delete from node_groups where id = $1', [id]);
    await recordAudit(db, {
      action: 'NODE_DELETED',
      actor: actorOf(request),
      targetType: 'node_group',
      targetId: id,
      targetName: group.name,
    });
    return { ok: true };
  });

  /** Moving a node between groups changes which listeners it serves. */
  app.post('/nodes/:id/group', async (request) => {
    requirePermission(request, 'NODE_MANAGE');
    const { id } = request.params as { id: string };
    const parsed = z.object({ groupId: z.string().uuid().nullable() }).safeParse(request.body);
    if (!parsed.success) throw badRequest('A group id is required.');

    const { rows } = await db.query<{ name: string }>(
      'update proxy_nodes set group_id = $2 where id = $1 returning name',
      [id, parsed.data.groupId],
    );
    if (rows.length === 0) throw notFound('Node not found.');

    await recordAudit(db, {
      action: 'NODE_UPDATED',
      actor: actorOf(request),
      targetType: 'proxy_node',
      targetId: id,
      targetName: rows[0]?.name ?? null,
      payload: { groupId: parsed.data.groupId },
    });
    return { ok: true };
  });

  /* --- Listener profiles ------------------------------------------------- */

  app.get('/listener-profiles', async (request) => {
    requirePermission(request, 'LISTENER_READ');
    const { rows } = await db.query(
      `select l.id, l.name, l.description, l.address, l.port, l.mode, l.enabled,
              l.authentication_mode, l.source_network_ids, l.group_id,
              g.name as group_name, l.created_at, l.updated_at
       from listener_profiles l
       left join node_groups g on g.id = l.group_id
       order by l.port, l.name`,
    );
    const { rows: config } = await db.query<{ mode: string }>(
      'select mode from proxy_auth_config where id = 1',
    );
    return {
      items: rows,
      total: rows.length,
      // The UI has to show what INHERIT actually resolves to right now.
      globalDefault: config[0]?.mode ?? 'DISABLED',
    };
  });

  app.post('/listener-profiles', async (request, reply) => {
    requirePermission(request, 'LISTENER_MANAGE');
    const parsed = profileSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Invalid listener payload.', parsed.error.issues);
    const input = parsed.data;

    const { rows } = await db
      .query<{ id: string }>(
        `insert into listener_profiles
           (name, description, address, port, mode, enabled, authentication_mode, source_network_ids, group_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8::uuid[], $9)
         returning id`,
        [
          input.name,
          input.description ?? null,
          input.address,
          input.port,
          input.mode,
          input.enabled,
          input.authenticationMode,
          input.sourceNetworkIds,
          input.groupId ?? null,
        ],
      )
      .catch((error: unknown) => {
        if (error instanceof Error && error.message.includes('listener_profiles_bind_key')) {
          // Two listeners on one address and port make Squid refuse to start,
          // so this is caught here rather than at deployment time.
          throw conflict(`A listener already binds ${input.address}:${input.port} for this group.`);
        }
        throw error;
      });

    await recordAudit(db, {
      action: 'LISTENER_CREATED',
      actor: actorOf(request),
      targetType: 'listener_profile',
      targetId: rows[0]?.id ?? null,
      targetName: input.name,
      payload: {
        address: input.address,
        port: input.port,
        authenticationMode: input.authenticationMode,
        groupId: input.groupId ?? null,
      },
    });
    return reply.status(201).send({ id: rows[0]?.id });
  });

  app.patch('/listener-profiles/:id', async (request) => {
    requirePermission(request, 'LISTENER_MANAGE');
    const { id } = request.params as { id: string };
    const parsed = profileSchema.partial().safeParse(request.body);
    if (!parsed.success) throw badRequest('Invalid listener payload.', parsed.error.issues);
    const input = parsed.data;

    const { rows } = await db.query<{ name: string }>(
      `update listener_profiles set
         name = coalesce($2, name),
         description = coalesce($3, description),
         address = coalesce($4, address),
         port = coalesce($5, port),
         mode = coalesce($6, mode),
         enabled = coalesce($7, enabled),
         authentication_mode = coalesce($8, authentication_mode),
         source_network_ids = coalesce($9::uuid[], source_network_ids),
         updated_at = now()
       where id = $1 returning name`,
      [
        id,
        input.name ?? null,
        input.description ?? null,
        input.address ?? null,
        input.port ?? null,
        input.mode ?? null,
        input.enabled ?? null,
        input.authenticationMode ?? null,
        input.sourceNetworkIds ?? null,
      ],
    );
    if (rows.length === 0) throw notFound('Listener profile not found.');

    await recordAudit(db, {
      action: 'LISTENER_UPDATED',
      actor: actorOf(request),
      targetType: 'listener_profile',
      targetId: id,
      targetName: rows[0]?.name ?? null,
      payload: { authenticationMode: input.authenticationMode ?? null },
    });
    return { ok: true };
  });

  app.delete('/listener-profiles/:id', async (request) => {
    requirePermission(request, 'LISTENER_MANAGE');
    const { id } = request.params as { id: string };
    const { rows } = await db.query<{ name: string }>(
      'delete from listener_profiles where id = $1 returning name',
      [id],
    );
    if (rows.length === 0) throw notFound('Listener profile not found.');

    await recordAudit(db, {
      action: 'LISTENER_DELETED',
      actor: actorOf(request),
      targetType: 'listener_profile',
      targetId: id,
      targetName: rows[0]?.name ?? null,
    });
    return { ok: true };
  });
}
