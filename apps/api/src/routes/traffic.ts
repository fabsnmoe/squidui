import type { FastifyInstance } from 'fastify';
import { requirePermission } from '../http/context.js';
import { getSetting, SETTING_TRAFFIC_LOG_URLS } from '../services/settings.js';
import type { AppContext } from '../server.js';

/**
 * Traffic queries (PLAN.md 9.23).
 *
 * Two different reads with two different backing tables: the log view answers
 * "what happened" from the raw events, and every counter answers "how much"
 * from the hourly rollups. Aggregating over raw rows would make the dashboard
 * slower the longer the product runs.
 */

const IDENTITY_FILTERS = ['ANY', 'AUTHENTICATED', 'UNAUTHENTICATED', 'USER'] as const;

export async function registerTrafficRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  const { db, config } = context;

  app.get('/traffic/events', async (request) => {
    requirePermission(request, 'TRAFFIC_READ');
    const query = request.query as
      | {
          identity?: string;
          username?: string;
          nodeId?: string;
          decision?: string;
          host?: string;
          hours?: string;
          limit?: string;
          offset?: string;
        }
      | undefined;

    const conditions: string[] = [];
    const params: unknown[] = [];
    const hours = Math.min(Math.max(Number(query?.hours ?? 24) || 24, 1), 24 * 30);

    params.push(String(hours));
    conditions.push(`e.occurred_at > now() - ($${params.length} || ' hours')::interval`);

    const identity = (query?.identity ?? 'ANY').toUpperCase();
    if (identity === 'AUTHENTICATED') conditions.push('e.username is not null');
    else if (identity === 'UNAUTHENTICATED') conditions.push('e.username is null');
    else if (identity === 'USER' && query?.username) {
      params.push(query.username.toLowerCase());
      conditions.push(`lower(e.username) = $${params.length}`);
    }

    if (query?.nodeId) {
      params.push(query.nodeId);
      conditions.push(`e.node_id = $${params.length}`);
    }
    if (query?.decision) {
      params.push(query.decision.toUpperCase());
      conditions.push(`e.decision = $${params.length}`);
    }
    if (query?.host) {
      params.push(`%${query.host.toLowerCase()}%`);
      conditions.push(`lower(e.destination_host) like $${params.length}`);
    }

    const where = `where ${conditions.join(' and ')}`;
    const limit = Math.min(Math.max(Number(query?.limit ?? 100) || 100, 1), 500);
    const offset = Math.max(Number(query?.offset ?? 0) || 0, 0);

    params.push(limit);
    const limitIndex = params.length;
    params.push(offset);
    const offsetIndex = params.length;

    const { rows } = await db.query(
      `select e.id::text as id, e.occurred_at, e.client_ip, e.username, e.squid_status,
              e.http_status, e.bytes, e.duration_ms, e.method, e.destination_host,
              e.destination_port, e.url, e.decision,
              n.name as node_name
       from traffic_events e
       join proxy_nodes n on n.id = e.node_id
       ${where}
       order by e.occurred_at desc, e.id desc
       limit $${limitIndex} offset $${offsetIndex}`,
      params,
    );

    return {
      items: rows,
      limit,
      offset,
      hours,
      identityFilters: IDENTITY_FILTERS,
      /** The UI states this rather than silently showing a host-only column. */
      urlsRecorded: await getSetting(db, SETTING_TRAFFIC_LOG_URLS, config.traffic.logUrls),
      retentionDays: config.traffic.retentionDays,
    };
  });

  /** Counters for the dashboard, read from the rollups. */
  app.get('/traffic/summary', async (request) => {
    requirePermission(request, 'TRAFFIC_READ');
    const query = request.query as { hours?: string } | undefined;
    const hours = Math.min(Math.max(Number(query?.hours ?? 24) || 24, 1), 24 * 90);

    const { rows: totals } = await db.query<{
      authenticated: string;
      unauthenticated: string;
      denied: string;
      auth_required: string;
      bytes: string;
    }>(
      `select
         coalesce(sum(requests) filter (where authenticated), 0)::text as authenticated,
         coalesce(sum(requests) filter (where not authenticated), 0)::text as unauthenticated,
         coalesce(sum(requests) filter (where decision = 'DENIED'), 0)::text as denied,
         coalesce(sum(requests) filter (where decision = 'AUTH_REQUIRED'), 0)::text as auth_required,
         coalesce(sum(bytes), 0)::text as bytes
       from traffic_rollups
       where bucket > now() - ($1 || ' hours')::interval`,
      [String(hours)],
    );

    const { rows: topUsers } = await db.query(
      `select username, sum(requests)::text as requests, sum(bytes)::text as bytes
       from traffic_rollups
       where bucket > now() - ($1 || ' hours')::interval and username <> ''
       group by username order by sum(requests) desc limit 10`,
      [String(hours)],
    );

    const { rows: series } = await db.query(
      `select bucket,
              sum(requests) filter (where authenticated)::text as authenticated,
              sum(requests) filter (where not authenticated)::text as unauthenticated
       from traffic_rollups
       where bucket > now() - ($1 || ' hours')::interval
       group by bucket order by bucket`,
      [String(hours)],
    );

    const { rows: state } = await db.query<{ nodes: string; lines: string; dropped: string }>(
      `select count(*)::text as nodes,
              coalesce(sum(lines_total), 0)::text as lines,
              coalesce(sum(dropped_total), 0)::text as dropped
       from node_log_state`,
    );

    const authenticated = Number(totals[0]?.authenticated ?? '0');
    const unauthenticated = Number(totals[0]?.unauthenticated ?? '0');
    const reportingNodes = Number(state[0]?.nodes ?? '0');

    return {
      hours,
      // False until at least one agent has shipped something. The UI shows an
      // empty state rather than a zero that looks like a measurement.
      available: reportingNodes > 0,
      reportingNodes,
      authenticatedRequests: authenticated,
      unauthenticatedRequests: unauthenticated,
      totalRequests: authenticated + unauthenticated,
      deniedRequests: Number(totals[0]?.denied ?? '0'),
      authRequiredRequests: Number(totals[0]?.auth_required ?? '0'),
      bytes: Number(totals[0]?.bytes ?? '0'),
      topUsers,
      series,
      linesIngested: Number(state[0]?.lines ?? '0'),
      linesRejected: Number(state[0]?.dropped ?? '0'),
    };
  });
}
