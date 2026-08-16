import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getSquidAdapter } from '@scp/shared';
import { recordAudit } from '../audit/sink.js';
import { badRequest, clientIp, unauthorized, HttpError } from '../http/context.js';
import { AuthenticationProviderRegistry } from '../providers/registry.js';
import { configurationHash, hashCredential, generateCredential, looksLike } from '../security/agentAuth.js';
import { compileCurrentConfiguration } from '../services/configuration.js';
import { getSetting, SETTING_TRAFFIC_LOG_URLS } from '../services/settings.js';
import { ingestAccessLog } from '../services/traffic.js';
import type { AppContext } from '../server.js';

/**
 * The agent API (PLAN.md Phase 3).
 *
 * This is the only surface a proxy node talks to, and it is deliberately tiny:
 * enrol once, then pull configuration and report what happened. Agents pull so
 * the control plane never needs a route into the proxy network - a node behind
 * NAT or a one-way firewall enrols exactly like a node in the next rack.
 *
 * Agent credentials are their own principal kind. They are not JWTs and they
 * carry no control plane permission: an agent can read the configuration meant
 * for its node and write its own status, nothing else.
 */

const POLL_INTERVAL_SECONDS = 30;

const enrollSchema = z.object({
  token: z.string().min(8).max(128),
  hostname: z.string().max(255).optional(),
  agentVersion: z.string().max(64).optional(),
  squidVersion: z.string().max(64).optional(),
});

const statusSchema = z.object({
  configHash: z.string().max(128).nullable().optional(),
  result: z.enum(['APPLIED', 'FAILED', 'VALIDATION_FAILED', 'UNCHANGED']),
  message: z.string().max(2048).optional(),
  agentVersion: z.string().max(64).optional(),
  squidVersion: z.string().max(64).optional(),
  squidRunning: z.boolean().optional(),
});

const logsSchema = z.object({
  lines: z.array(z.string().max(8192)).max(1000),
});

interface AgentPrincipal {
  nodeId: string;
  nodeName: string;
  credentialId: string;
  adapterId: string;
}

export async function registerAgentRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  const { db, config } = context;

  async function authenticateAgent(request: FastifyRequest): Promise<AgentPrincipal> {
    const header = request.headers['x-agent-key'];
    const key = Array.isArray(header) ? header[0] : header;
    if (!key || !looksLike('agent', key)) throw unauthorized('A node agent credential is required.');

    const { rows } = await db.query<{
      credential_id: string;
      node_id: string;
      name: string;
      adapter_id: string;
    }>(
      `select c.id as credential_id, n.id as node_id, n.name, n.adapter_id
       from node_credentials c
       join proxy_nodes n on n.id = c.node_id
       where c.key_hash = $1 and c.revoked_at is null`,
      [hashCredential(key)],
    );
    const row = rows[0];
    if (!row) throw unauthorized('This agent credential is not valid. Re-enrol the node.');

    await db.query('update node_credentials set last_used_at = now() where id = $1', [row.credential_id]);
    return {
      nodeId: row.node_id,
      nodeName: row.name,
      credentialId: row.credential_id,
      adapterId: row.adapter_id,
    };
  }

  /** Compiles once per request; the agent only refetches when the hash differs. */
  async function currentBundle(adapterId: string, nodeId: string) {
    const registry = await AuthenticationProviderRegistry.load(db, config);
    const compiled = await compileCurrentConfiguration(db, registry, {
      adapterId,
      generatorVersion: config.build.appVersion,
      includeSecrets: true,
      secretEncryptionKey: config.secretEncryptionKey,
      // The node decides which listener profiles and group-scoped policies
      // apply, so the bundle is built for it rather than for the fleet.
      nodeId,
    });
    return { compiled, hash: configurationHash(compiled.squidConf, compiled.artefacts) };
  }

  /* --- Enrolment --------------------------------------------------------- */

  app.post('/agent/enroll', async (request) => {
    const parsed = enrollSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('An enrolment token is required.');
    const input = parsed.data;
    const ip = clientIp(request);

    // Enrolment is unauthenticated by design - the token is the credential -
    // so it is rate limited per source address.
    const decision = context.loginLimiter.check(`enroll:${ip}`);
    if (!decision.allowed) {
      throw new HttpError(429, 'RATE_LIMITED', 'Too many enrolment attempts. Try again later.');
    }

    const { rows } = await db.query<{
      token_id: string;
      node_id: string;
      name: string;
      adapter_id: string;
      expires_at: Date;
      used_at: Date | null;
    }>(
      `select t.id as token_id, n.id as node_id, n.name, n.adapter_id, t.expires_at, t.used_at
       from node_enrollment_tokens t
       join proxy_nodes n on n.id = t.node_id
       where t.token_hash = $1`,
      [hashCredential(input.token)],
    );
    const token = rows[0];

    // One generic answer for unknown, used and expired: an attacker with a
    // guessed token learns nothing about which of the three it was.
    if (!token || token.used_at !== null || token.expires_at.getTime() <= Date.now()) {
      await recordAudit(db, {
        action: 'NODE_ENROLLED',
        outcome: 'FAILURE',
        actor: { id: null, username: 'agent', sourceIp: ip },
        payload: { reason: !token ? 'UNKNOWN_TOKEN' : token.used_at ? 'ALREADY_USED' : 'EXPIRED' },
      });
      throw unauthorized('This enrolment token is not valid. Issue a new one in the control plane.');
    }

    const { plaintext, hash } = generateCredential('agent');
    await db.query('update node_enrollment_tokens set used_at = now(), used_from_ip = $2 where id = $1', [
      token.token_id,
      ip,
    ]);
    // Re-enrolling replaces the previous credential rather than adding one.
    await db.query('update node_credentials set revoked_at = now() where node_id = $1 and revoked_at is null', [
      token.node_id,
    ]);
    await db.query('insert into node_credentials (node_id, key_hash) values ($1, $2)', [token.node_id, hash]);
    await db.query(
      `update proxy_nodes
       set enrolled_at = now(), last_seen_at = now(), status = 'HEALTHY',
           hostname = coalesce($2, hostname), agent_version = $3, squid_version = coalesce($4, squid_version),
           last_error = null
       where id = $1`,
      [token.node_id, input.hostname ?? null, input.agentVersion ?? null, input.squidVersion ?? null],
    );

    await recordAudit(db, {
      action: 'NODE_ENROLLED',
      actor: { id: null, username: `agent:${token.name}`, sourceIp: ip },
      targetType: 'proxy_node',
      targetId: token.node_id,
      targetName: token.name,
      payload: { hostname: input.hostname ?? null, agentVersion: input.agentVersion ?? null },
    });

    return {
      nodeId: token.node_id,
      nodeName: token.name,
      agentKey: plaintext,
      adapterId: token.adapter_id,
      pollIntervalSeconds: POLL_INTERVAL_SECONDS,
    };
  });

  /* --- Configuration pull ------------------------------------------------ */

  app.get('/agent/config', async (request) => {
    const agent = await authenticateAgent(request);
    const adapter = getSquidAdapter(agent.adapterId);
    const { compiled, hash } = await currentBundle(agent.adapterId, agent.nodeId);

    await db.query('update proxy_nodes set last_seen_at = now() where id = $1', [agent.nodeId]);

    return {
      configHash: hash,
      generatedAt: compiled.ir.generatedAt,
      adapterId: compiled.adapterId,
      pollIntervalSeconds: POLL_INTERVAL_SECONDS,
      squidConf: compiled.squidConf,
      // Path, mode and ownership together: mode alone is not enough, because
      // Squid drops privileges before starting its authentication helpers.
      artefacts: compiled.artefacts.map((artefact) => ({
        path: artefact.path,
        content: artefact.content,
        mode: artefact.mode,
        owner: artefact.owner,
        group: artefact.group,
      })),
      squid: {
        confPath: `${adapter.paths.generatedDir}/squid.conf`,
        binary: 'squid',
      },
      accessLogPath: adapter.paths.accessLog,
      warnings: compiled.warnings,
    };
  });

  /* --- Access log ingestion (PLAN.md Phase 8) ----------------------------- */

  app.post('/agent/logs', async (request) => {
    const agent = await authenticateAgent(request);
    const parsed = logsSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Invalid log payload.', parsed.error.issues);

    const result = await ingestAccessLog(db, agent.nodeId, parsed.data.lines, {
      // The runtime setting wins over the environment: an operator turns full
      // URL logging on in the UI, not by redeploying a container.
      logUrls: await getSetting(db, SETTING_TRAFFIC_LOG_URLS, config.traffic.logUrls),
      retentionDays: config.traffic.retentionDays,
    });

    await db.query('update proxy_nodes set last_seen_at = now() where id = $1', [agent.nodeId]);

    // Unparseable lines are counted, not logged: a malformed line may still
    // contain a URL, and the API log is not the place for request contents.
    return { accepted: result.accepted, rejected: result.rejected };
  });

  /* --- Status report ----------------------------------------------------- */

  app.post('/agent/status', async (request) => {
    const agent = await authenticateAgent(request);
    const parsed = statusSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Invalid status payload.', parsed.error.issues);
    const input = parsed.data;

    const failed = input.result === 'FAILED' || input.result === 'VALIDATION_FAILED';
    const status = failed ? 'DEGRADED' : input.squidRunning === false ? 'DEGRADED' : 'HEALTHY';

    await db.query(
      `update proxy_nodes
       set last_seen_at = now(),
           status = $2,
           agent_version = coalesce($3, agent_version),
           squid_version = coalesce($4, squid_version),
           apply_result = case when $5::text = 'UNCHANGED' then apply_result else $5::text end,
           apply_message = case when $5::text = 'UNCHANGED' then apply_message else $6::text end,
           applied_at = case when $5::text = 'APPLIED' then now() else applied_at end,
           last_error = case when $7::boolean then $6::text else null end
       where id = $1`,
      [
        agent.nodeId,
        status,
        input.agentVersion ?? null,
        input.squidVersion ?? null,
        input.result,
        input.message ?? null,
        failed,
      ],
    );

    await db.query(
      `insert into node_heartbeats (node_id, observed_at, agent_version, squid_version, squid_running, config_hash)
       values ($1, now(), $2, $3, $4, $5)
       on conflict (node_id) do update set
         observed_at = now(), agent_version = excluded.agent_version,
         squid_version = excluded.squid_version, squid_running = excluded.squid_running,
         config_hash = excluded.config_hash`,
      [
        agent.nodeId,
        input.agentVersion ?? null,
        input.squidVersion ?? null,
        input.squidRunning ?? null,
        input.configHash ?? null,
      ],
    );

    // Only state changes are audited. A healthy agent reports every 30 seconds
    // and must not drown the audit log.
    if (input.result === 'APPLIED' || failed) {
      await recordAudit(db, {
        action: failed ? 'NODE_CONFIG_FAILED' : 'NODE_CONFIG_APPLIED',
        outcome: failed ? 'FAILURE' : 'SUCCESS',
        actor: { id: null, username: `agent:${agent.nodeName}`, sourceIp: clientIp(request) },
        targetType: 'proxy_node',
        targetId: agent.nodeId,
        targetName: agent.nodeName,
        payload: { result: input.result, message: input.message ?? null, configHash: input.configHash ?? null },
      });
    }

    return { ok: true, pollIntervalSeconds: POLL_INTERVAL_SECONDS };
  });
}
