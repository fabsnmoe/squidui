import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { evaluate, parseCidr, WEEKDAYS } from '@scp/shared';
import { recordAudit } from '../audit/sink.js';
import { actorOf, badRequest, conflict, notFound, requirePermission } from '../http/context.js';
import { withTransaction } from '../db/pool.js';
import { AuthenticationProviderRegistry } from '../providers/registry.js';
import { buildIr } from '../services/configuration.js';
import type { AppContext } from '../server.js';

/** Networks, listeners and access rules, plus the rule simulator. */

const cidrList = z
  .array(z.string().min(1).max(64))
  .min(1)
  .refine((values) => values.every((value) => parseCidr(value) !== null), {
    message: 'Every entry must be a valid IPv4 or IPv6 address or CIDR range.',
  });

const networkSchema = z.object({
  name: z.string().min(1).max(128),
  description: z.string().max(512).nullable().optional(),
  cidrs: cidrList,
});

const listenerSchema = z.object({
  name: z.string().min(1).max(128),
  address: z.string().min(1).max(64),
  port: z.number().int().min(1).max(65535),
  mode: z.enum(['FORWARD', 'INTERCEPT']).default('FORWARD'),
  enabled: z.boolean().default(true),
});

const sourceSchema = z.union([
  z.object({ kind: z.literal('ANY') }),
  z.object({ kind: z.literal('NETWORKS'), networkIds: z.array(z.string().uuid()).min(1) }),
]);

const identitySchema = z.union([
  z.object({ kind: z.literal('ANY') }),
  z.object({ kind: z.literal('AUTHENTICATED') }),
  z.object({ kind: z.literal('UNAUTHENTICATED') }),
  z.object({ kind: z.literal('USER'), userIds: z.array(z.string().uuid()).min(1) }),
  z.object({ kind: z.literal('GROUP'), groupIds: z.array(z.string().uuid()).min(1) }),
]);

const destinationSchema = z.union([
  z.object({ kind: z.literal('ANY') }),
  z.object({
    kind: z.literal('SPECIFIC'),
    domains: z.array(z.string().min(1).max(255)).default([]),
    cidrs: z.array(z.string().min(1).max(64)).default([]),
    ports: z.array(z.number().int().min(1).max(65535)).default([]),
  }),
]);

const scheduleSchema = z.union([
  z.object({ kind: z.literal('ALWAYS') }),
  z.object({
    kind: z.literal('WINDOW'),
    days: z.array(z.enum(WEEKDAYS)).min(1),
    startMinutes: z.number().int().min(0).max(1440),
    endMinutes: z.number().int().min(0).max(1440),
  }),
]);

const ruleSchema = z.object({
  scope: z.enum(['GLOBAL', 'NODE_GROUP']).optional(),
  scopeGroupIds: z.array(z.string().uuid()).max(32).optional(),
  name: z.string().min(1).max(128),
  description: z.string().max(512).nullable().optional(),
  enabled: z.boolean().default(true),
  action: z.enum(['ALLOW', 'DENY']),
  position: z.number().int().min(0).max(100_000).optional(),
  source: sourceSchema.default({ kind: 'ANY' }),
  identity: identitySchema.default({ kind: 'ANY' }),
  destination: destinationSchema.default({ kind: 'ANY' }),
  schedule: scheduleSchema.default({ kind: 'ALWAYS' }),
});

const simulateSchema = z.object({
  sourceIp: z.string().min(1).max(64),
  authenticated: z.boolean().default(false),
  username: z.string().max(128).optional(),
  providerKey: z.string().max(64).optional(),
  groups: z.array(z.string().max(255)).default([]),
  destinationHost: z.string().max(255).optional(),
  destinationPort: z.number().int().min(1).max(65535).optional(),
});

export async function registerPolicyRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  const { db, config } = context;

  /* --- Networks ---------------------------------------------------------- */

  app.get('/networks', async (request) => {
    requirePermission(request, 'POLICY_READ');
    const { rows } = await db.query('select id, name, description, cidrs, created_at, updated_at from networks order by name');
    return { items: rows, total: rows.length };
  });

  app.post('/networks', async (request, reply) => {
    requirePermission(request, 'POLICY_MANAGE');
    const parsed = networkSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Invalid network payload.', parsed.error.issues);
    const { rows } = await db
      .query<{ id: string }>(
        'insert into networks (name, description, cidrs) values ($1, $2, $3) returning id',
        [parsed.data.name, parsed.data.description ?? null, parsed.data.cidrs],
      )
      .catch((error: unknown) => {
        if (error instanceof Error && error.message.includes('networks_name_key')) {
          throw conflict(`A network named "${parsed.data.name}" already exists.`);
        }
        throw error;
      });
    await recordAudit(db, {
      action: 'NETWORK_CREATED',
      actor: actorOf(request),
      targetType: 'network',
      targetId: rows[0]?.id ?? null,
      targetName: parsed.data.name,
      payload: { cidrs: parsed.data.cidrs },
    });
    return reply.status(201).send({ id: rows[0]?.id });
  });

  app.patch('/networks/:id', async (request) => {
    requirePermission(request, 'POLICY_MANAGE');
    const { id } = request.params as { id: string };
    const parsed = networkSchema.partial().safeParse(request.body);
    if (!parsed.success) throw badRequest('Invalid network payload.', parsed.error.issues);
    const { rows } = await db.query<{ name: string }>(
      `update networks set
         name = coalesce($2, name),
         description = coalesce($3, description),
         cidrs = coalesce($4, cidrs),
         updated_at = now()
       where id = $1 returning name`,
      [id, parsed.data.name ?? null, parsed.data.description ?? null, parsed.data.cidrs ?? null],
    );
    if (rows.length === 0) throw notFound('Network not found.');
    await recordAudit(db, {
      action: 'NETWORK_UPDATED',
      actor: actorOf(request),
      targetType: 'network',
      targetId: id,
      targetName: rows[0]?.name ?? null,
    });
    return { ok: true };
  });

  app.delete('/networks/:id', async (request) => {
    requirePermission(request, 'POLICY_MANAGE');
    const { id } = request.params as { id: string };
    const { rows: usedBy } = await db.query<{ name: string; position: number }>(
      `select name, position from access_rules
       where source->>'kind' = 'NETWORKS' and source->'networkIds' @> to_jsonb($1::text)
       order by position`,
      [id],
    );
    if (usedBy.length > 0) {
      throw conflict(
        `This network is used by ${usedBy.length} access rule(s): ${usedBy
          .map((rule) => `${rule.position} "${rule.name}"`)
          .join(', ')}.`,
      );
    }
    const { rows } = await db.query<{ name: string }>('delete from networks where id = $1 returning name', [id]);
    if (rows.length === 0) throw notFound('Network not found.');
    await recordAudit(db, {
      action: 'NETWORK_DELETED',
      actor: actorOf(request),
      targetType: 'network',
      targetId: id,
      targetName: rows[0]?.name ?? null,
    });
    return { ok: true };
  });

  /* --- Listeners --------------------------------------------------------- */

  app.get('/listeners', async (request) => {
    requirePermission(request, 'LISTENER_READ');
    const { rows } = await db.query('select id, name, address, port, mode, enabled from listeners order by name');
    return { items: rows, total: rows.length };
  });

  app.post('/listeners', async (request, reply) => {
    requirePermission(request, 'LISTENER_MANAGE');
    const parsed = listenerSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Invalid listener payload.', parsed.error.issues);
    const { rows } = await db.query<{ id: string }>(
      'insert into listeners (name, address, port, mode, enabled) values ($1, $2, $3, $4, $5) returning id',
      [parsed.data.name, parsed.data.address, parsed.data.port, parsed.data.mode, parsed.data.enabled],
    );
    await recordAudit(db, {
      action: 'LISTENER_CREATED',
      actor: actorOf(request),
      targetType: 'listener',
      targetId: rows[0]?.id ?? null,
      targetName: parsed.data.name,
      payload: { address: parsed.data.address, port: parsed.data.port, mode: parsed.data.mode },
    });
    return reply.status(201).send({ id: rows[0]?.id });
  });

  app.patch('/listeners/:id', async (request) => {
    requirePermission(request, 'LISTENER_MANAGE');
    const { id } = request.params as { id: string };
    const parsed = listenerSchema.partial().safeParse(request.body);
    if (!parsed.success) throw badRequest('Invalid listener payload.', parsed.error.issues);
    const { rows } = await db.query<{ name: string }>(
      `update listeners set
         name = coalesce($2, name), address = coalesce($3, address), port = coalesce($4, port),
         mode = coalesce($5, mode), enabled = coalesce($6, enabled), updated_at = now()
       where id = $1 returning name`,
      [
        id,
        parsed.data.name ?? null,
        parsed.data.address ?? null,
        parsed.data.port ?? null,
        parsed.data.mode ?? null,
        parsed.data.enabled ?? null,
      ],
    );
    if (rows.length === 0) throw notFound('Listener not found.');
    await recordAudit(db, {
      action: 'LISTENER_UPDATED',
      actor: actorOf(request),
      targetType: 'listener',
      targetId: id,
      targetName: rows[0]?.name ?? null,
    });
    return { ok: true };
  });

  app.delete('/listeners/:id', async (request) => {
    requirePermission(request, 'LISTENER_MANAGE');
    const { id } = request.params as { id: string };
    const { rows } = await db.query<{ name: string }>('delete from listeners where id = $1 returning name', [id]);
    if (rows.length === 0) throw notFound('Listener not found.');
    await recordAudit(db, {
      action: 'LISTENER_DELETED',
      actor: actorOf(request),
      targetType: 'listener',
      targetId: id,
      targetName: rows[0]?.name ?? null,
    });
    return { ok: true };
  });

  /* --- Access rules ------------------------------------------------------ */

  app.get('/access-rules', async (request) => {
    requirePermission(request, 'POLICY_READ');
    const { rows } = await db.query(
      `select id, position, name, description, enabled, action, source, identity, destination, schedule,
              scope, scope_group_ids, created_at, updated_at
       from access_rules order by position, id`,
    );
    return { items: rows, total: rows.length };
  });

  app.post('/access-rules', async (request, reply) => {
    requirePermission(request, 'POLICY_MANAGE');
    const parsed = ruleSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Invalid rule payload.', parsed.error.issues);
    const input = parsed.data;

    const position =
      input.position ??
      (await db
        .query<{ next: number }>('select coalesce(max(position), 0) + 10 as next from access_rules')
        .then((result) => result.rows[0]?.next ?? 10));

    const { rows } = await db.query<{ id: string }>(
      `insert into access_rules (position, name, description, enabled, action, source, identity, destination, schedule, scope, scope_group_ids)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11::uuid[])
       returning id`,
      [
        position,
        input.name,
        input.description ?? null,
        input.enabled,
        input.action,
        JSON.stringify(input.source),
        JSON.stringify(input.identity),
        JSON.stringify(input.destination),
        JSON.stringify(input.schedule),
        input.scope ?? 'GLOBAL',
        input.scopeGroupIds ?? [],
      ],
    );

    await recordAudit(db, {
      action: 'POLICY_RULE_CREATED',
      actor: actorOf(request),
      targetType: 'access_rule',
      targetId: rows[0]?.id ?? null,
      targetName: input.name,
      payload: { position, action: input.action, identity: input.identity.kind },
    });
    return reply.status(201).send({ id: rows[0]?.id, position });
  });

  app.patch('/access-rules/:id', async (request) => {
    requirePermission(request, 'POLICY_MANAGE');
    const { id } = request.params as { id: string };
    const parsed = ruleSchema.partial().safeParse(request.body);
    if (!parsed.success) throw badRequest('Invalid rule payload.', parsed.error.issues);
    const patch = parsed.data;

    const { rows } = await db.query<{ name: string }>(
      `update access_rules set
         position = coalesce($2, position),
         name = coalesce($3, name),
         description = coalesce($4, description),
         enabled = coalesce($5, enabled),
         action = coalesce($6, action),
         source = coalesce($7::jsonb, source),
         identity = coalesce($8::jsonb, identity),
         destination = coalesce($9::jsonb, destination),
         schedule = coalesce($10::jsonb, schedule),
         scope = coalesce($11, scope),
         scope_group_ids = coalesce($12::uuid[], scope_group_ids),
         updated_at = now()
       where id = $1 returning name`,
      [
        id,
        patch.position ?? null,
        patch.name ?? null,
        patch.description ?? null,
        patch.enabled ?? null,
        patch.action ?? null,
        patch.source ? JSON.stringify(patch.source) : null,
        patch.identity ? JSON.stringify(patch.identity) : null,
        patch.destination ? JSON.stringify(patch.destination) : null,
        patch.schedule ? JSON.stringify(patch.schedule) : null,
        patch.scope ?? null,
        patch.scopeGroupIds ?? null,
      ],
    );
    if (rows.length === 0) throw notFound('Access rule not found.');
    await recordAudit(db, {
      action: 'POLICY_RULE_UPDATED',
      actor: actorOf(request),
      targetType: 'access_rule',
      targetId: id,
      targetName: rows[0]?.name ?? null,
    });
    return { ok: true };
  });

  app.post('/access-rules/reorder', async (request) => {
    requirePermission(request, 'POLICY_MANAGE');
    const parsed = z.object({ order: z.array(z.string().uuid()).min(1) }).safeParse(request.body);
    if (!parsed.success) throw badRequest('An ordered list of rule ids is required.');

    await withTransaction(db, async (client) => {
      let position = 10;
      for (const id of parsed.data.order) {
        await client.query('update access_rules set position = $2, updated_at = now() where id = $1', [id, position]);
        position += 10;
      }
    });
    await recordAudit(db, {
      action: 'POLICY_RULES_REORDERED',
      actor: actorOf(request),
      payload: { count: parsed.data.order.length },
    });
    return { ok: true };
  });

  app.delete('/access-rules/:id', async (request) => {
    requirePermission(request, 'POLICY_MANAGE');
    const { id } = request.params as { id: string };
    const { rows } = await db.query<{ name: string }>('delete from access_rules where id = $1 returning name', [id]);
    if (rows.length === 0) throw notFound('Access rule not found.');
    await recordAudit(db, {
      action: 'POLICY_RULE_DELETED',
      actor: actorOf(request),
      targetType: 'access_rule',
      targetId: id,
      targetName: rows[0]?.name ?? null,
    });
    return { ok: true };
  });

  /**
   * Rule simulator: runs the real policy engine against the current IR, so the
   * answer shown in the UI is the answer the engine gives, not a second
   * implementation that can drift.
   */
  app.post('/access-rules/simulate', async (request) => {
    requirePermission(request, 'POLICY_READ');
    const parsed = simulateSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Invalid simulation payload.', parsed.error.issues);
    const input = parsed.data;

    const registry = await AuthenticationProviderRegistry.load(db, config);
    const { ir } = await buildIr(db, registry);

    const result = evaluate(ir, {
      sourceIp: input.sourceIp,
      identity: {
        authenticated: input.authenticated,
        username: input.username ?? null,
        providerKey: input.providerKey ?? null,
        groups: input.groups.map((name) => ({
          source: input.providerKey && input.providerKey !== 'local' ? ('EXTERNAL' as const) : ('LOCAL' as const),
          name,
          providerKey: input.providerKey && input.providerKey !== 'local' ? input.providerKey : null,
        })),
      },
      destinationHost: input.destinationHost ?? null,
      destinationPort: input.destinationPort ?? null,
    });

    return { ...result, mode: ir.authentication.mode };
  });
}
