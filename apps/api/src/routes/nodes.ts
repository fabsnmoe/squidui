import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SQUID_ADAPTERS } from '@scp/shared';
import { recordAudit } from '../audit/sink.js';
import { actorOf, badRequest, conflict, notFound, requirePermission } from '../http/context.js';
import { AuthenticationProviderRegistry } from '../providers/registry.js';
import { configurationHash, fingerprint, generateCredential } from '../security/agentAuth.js';
import { compileCurrentConfiguration } from '../services/configuration.js';
import type { AppContext } from '../server.js';

/**
 * Proxy node management (PLAN.md Phase 3).
 *
 * A node is created here first and then claims itself: the operator issues a
 * one-time enrolment token, runs the agent on the proxy host with it, and the
 * agent exchanges it for a long lived credential. One node or fifty works the
 * same way - nothing about this is single-node specific.
 */

const ENROLLMENT_TOKEN_TTL_MINUTES = 60;

const nodeCreateSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, 'Use letters, digits, dot, underscore and hyphen.'),
  description: z.string().max(512).nullable().optional(),
  hostname: z.string().max(255).nullable().optional(),
  adapterId: z.string().max(64).optional(),
  labels: z.record(z.string().max(64), z.string().max(128)).optional(),
});

const nodePatchSchema = nodeCreateSchema.partial().omit({ name: true });

interface NodeRow {
  id: string;
  name: string;
  description: string | null;
  hostname: string | null;
  status: string;
  squid_version: string | null;
  agent_version: string | null;
  adapter_id: string;
  labels: Record<string, string>;
  enrolled_at: Date | null;
  last_seen_at: Date | null;
  applied_at: Date | null;
  apply_result: string | null;
  apply_message: string | null;
  last_error: string | null;
  created_at: Date;
  reported_hash: string | null;
  squid_running: boolean | null;
  has_credential: boolean;
  pending_token: boolean;
}

const NODE_SELECT = `
  select n.id, n.name, n.description, n.hostname, n.status, n.squid_version, n.agent_version,
         n.adapter_id, n.labels, n.enrolled_at, n.last_seen_at, n.applied_at,
         n.apply_result, n.apply_message, n.last_error, n.created_at,
         h.config_hash as reported_hash, h.squid_running,
         exists (select 1 from node_credentials c where c.node_id = n.id and c.revoked_at is null) as has_credential,
         exists (select 1 from node_enrollment_tokens t
                 where t.node_id = n.id and t.used_at is null and t.expires_at > now()) as pending_token
  from proxy_nodes n
  left join node_heartbeats h on h.node_id = n.id`;

/**
 * A node is stale when it enrolled but has not checked in recently. The agent
 * polls on a fixed interval, so silence means the host, the agent or the
 * network is down - all three are the operator's problem, not ours to guess
 * between.
 */
const STALE_AFTER_MS = 3 * 60_000;

function toNode(row: NodeRow, currentHash: string) {
  const lastSeen = row.last_seen_at?.getTime() ?? 0;
  const stale = row.enrolled_at !== null && Date.now() - lastSeen > STALE_AFTER_MS;

  return {
    id: row.id,
    name: row.name,
    description: row.description,
    hostname: row.hostname,
    adapterId: row.adapter_id,
    labels: row.labels ?? {},
    status: stale ? 'UNREACHABLE' : row.status,
    enrolled: row.enrolled_at !== null,
    enrolledAt: row.enrolled_at?.toISOString() ?? null,
    lastSeenAt: row.last_seen_at?.toISOString() ?? null,
    agentVersion: row.agent_version,
    squidVersion: row.squid_version,
    squidRunning: row.squid_running,
    hasCredential: row.has_credential,
    pendingEnrollment: row.pending_token,
    apply: {
      result: row.apply_result,
      message: row.apply_message,
      at: row.applied_at?.toISOString() ?? null,
    },
    lastError: row.last_error,
    /** Whether what the node runs matches what the control plane would send. */
    configuration: {
      currentHash,
      reportedHash: row.reported_hash,
      inSync: row.reported_hash !== null && row.reported_hash === currentHash,
      drift: row.reported_hash !== null && row.reported_hash !== currentHash,
    },
    createdAt: row.created_at.toISOString(),
  };
}

export async function registerNodeRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  const { db, config } = context;

  /** Hash of the configuration every node should currently be running. */
  async function currentConfigurationHash(): Promise<string> {
    const registry = await AuthenticationProviderRegistry.load(db, config);
    const compiled = await compileCurrentConfiguration(db, registry, {
      generatorVersion: config.build.appVersion,
      includeSecrets: true,
      secretEncryptionKey: config.secretEncryptionKey,
    });
    return configurationHash(compiled.squidConf, compiled.artefacts);
  }

  app.get('/nodes', async (request) => {
    requirePermission(request, 'NODE_READ');
    const [{ rows }, hash] = await Promise.all([
      db.query<NodeRow>(`${NODE_SELECT} order by n.name`),
      currentConfigurationHash(),
    ]);
    const items = rows.map((row) => toNode(row, hash));
    return {
      items,
      total: items.length,
      summary: {
        enrolled: items.filter((node) => node.enrolled).length,
        inSync: items.filter((node) => node.configuration.inSync).length,
        drifted: items.filter((node) => node.configuration.drift).length,
        unreachable: items.filter((node) => node.status === 'UNREACHABLE').length,
      },
      adapters: SQUID_ADAPTERS.map((adapter) => ({
        id: adapter.id,
        displayName: adapter.displayName,
        supports: adapter.supports,
      })),
    };
  });

  app.get('/nodes/:id', async (request) => {
    requirePermission(request, 'NODE_READ');
    const { id } = request.params as { id: string };
    const { rows } = await db.query<NodeRow>(`${NODE_SELECT} where n.id = $1`, [id]);
    const node = rows[0];
    if (!node) throw notFound('Node not found.');
    return toNode(node, await currentConfigurationHash());
  });

  app.post('/nodes', async (request, reply) => {
    requirePermission(request, 'NODE_MANAGE');
    const parsed = nodeCreateSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Invalid node payload.', parsed.error.issues);
    const input = parsed.data;

    const { rows: existing } = await db.query('select 1 from proxy_nodes where lower(name) = lower($1)', [input.name]);
    if (existing.length > 0) throw conflict(`A node named "${input.name}" already exists.`);

    const { rows } = await db.query<{ id: string }>(
      `insert into proxy_nodes (name, description, hostname, adapter_id, labels, status)
       values ($1, $2, $3, $4, $5::jsonb, 'UNKNOWN') returning id`,
      [
        input.name,
        input.description ?? null,
        input.hostname ?? null,
        input.adapterId ?? 'squid-6-debian',
        JSON.stringify(input.labels ?? {}),
      ],
    );
    const nodeId = rows[0]?.id as string;

    await recordAudit(db, {
      action: 'NODE_CREATED',
      actor: actorOf(request),
      targetType: 'proxy_node',
      targetId: nodeId,
      targetName: input.name,
      payload: { adapterId: input.adapterId ?? 'squid-6-debian' },
    });

    const { rows: created } = await db.query<NodeRow>(`${NODE_SELECT} where n.id = $1`, [nodeId]);
    return reply.status(201).send(toNode(created[0] as NodeRow, await currentConfigurationHash()));
  });

  app.patch('/nodes/:id', async (request) => {
    requirePermission(request, 'NODE_MANAGE');
    const { id } = request.params as { id: string };
    const parsed = nodePatchSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Invalid node payload.', parsed.error.issues);

    const { rows } = await db.query<{ name: string }>(
      `update proxy_nodes set
         description = coalesce($2, description),
         hostname = coalesce($3, hostname),
         adapter_id = coalesce($4, adapter_id),
         labels = coalesce($5::jsonb, labels)
       where id = $1 returning name`,
      [
        id,
        parsed.data.description ?? null,
        parsed.data.hostname ?? null,
        parsed.data.adapterId ?? null,
        parsed.data.labels ? JSON.stringify(parsed.data.labels) : null,
      ],
    );
    if (rows.length === 0) throw notFound('Node not found.');

    await recordAudit(db, {
      action: 'NODE_UPDATED',
      actor: actorOf(request),
      targetType: 'proxy_node',
      targetId: id,
      targetName: rows[0]?.name ?? null,
    });
    return { ok: true };
  });

  /**
   * Issues a one-time enrolment token. The plaintext is returned exactly once;
   * it is not recoverable afterwards, which is why the UI shows it in a
   * dedicated dialog with the ready-made agent command.
   */
  app.post('/nodes/:id/enrollment-token', async (request) => {
    const principal = requirePermission(request, 'NODE_MANAGE');
    const { id } = request.params as { id: string };

    const { rows } = await db.query<{ name: string; adapter_id: string }>(
      'select name, adapter_id from proxy_nodes where id = $1',
      [id],
    );
    const node = rows[0];
    if (!node) throw notFound('Node not found.');

    // Any previously issued and still unused token is invalidated: two valid
    // tokens for one node is a needless second way in.
    await db.query(
      "update node_enrollment_tokens set used_at = now(), used_from_ip = 'superseded' where node_id = $1 and used_at is null",
      [id],
    );

    const { plaintext, hash } = generateCredential('enrollment');
    const expiresAt = new Date(Date.now() + ENROLLMENT_TOKEN_TTL_MINUTES * 60_000);
    await db.query(
      'insert into node_enrollment_tokens (node_id, token_hash, created_by, expires_at) values ($1, $2, $3, $4)',
      [id, hash, principal.username, expiresAt],
    );

    await recordAudit(db, {
      action: 'NODE_ENROLLMENT_TOKEN_ISSUED',
      actor: actorOf(request),
      targetType: 'proxy_node',
      targetId: id,
      targetName: node.name,
      payload: { expiresAt: expiresAt.toISOString(), fingerprint: fingerprint(hash) },
    });

    return {
      token: plaintext,
      expiresAt: expiresAt.toISOString(),
      expiresInMinutes: ENROLLMENT_TOKEN_TTL_MINUTES,
      node: { id, name: node.name, adapterId: node.adapter_id },
    };
  });

  /** Revokes the agent credential; the node has to enrol again. */
  app.post('/nodes/:id/revoke', async (request) => {
    requirePermission(request, 'NODE_MANAGE');
    const { id } = request.params as { id: string };
    const { rows } = await db.query<{ name: string }>('select name from proxy_nodes where id = $1', [id]);
    if (rows.length === 0) throw notFound('Node not found.');

    await db.query('update node_credentials set revoked_at = now() where node_id = $1 and revoked_at is null', [id]);
    await db.query("update proxy_nodes set status = 'UNKNOWN', enrolled_at = null where id = $1", [id]);

    await recordAudit(db, {
      action: 'NODE_CREDENTIAL_REVOKED',
      actor: actorOf(request),
      targetType: 'proxy_node',
      targetId: id,
      targetName: rows[0]?.name ?? null,
    });
    return { ok: true };
  });

  app.delete('/nodes/:id', async (request) => {
    requirePermission(request, 'NODE_MANAGE');
    const { id } = request.params as { id: string };
    const { rows } = await db.query<{ name: string }>('delete from proxy_nodes where id = $1 returning name', [id]);
    if (rows.length === 0) throw notFound('Node not found.');

    await recordAudit(db, {
      action: 'NODE_DELETED',
      actor: actorOf(request),
      targetType: 'proxy_node',
      targetId: id,
      targetName: rows[0]?.name ?? null,
    });
    return { ok: true };
  });
}
