import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { badRequest, requirePermission } from '../http/context.js';
import {
  DEFAULT_STATISTICS_RETENTION_DAYS,
  getSetting,
  SETTING_STATISTICS_RETENTION_DAYS,
} from '../services/settings.js';
import type { AppContext } from '../server.js';

/**
 * Statistics (docs/design/statistics.md).
 *
 * Two stores answer this endpoint, and which one it uses is decided here rather
 * than by the caller:
 *
 *   hourly rollups   any range, but only node, user, decision and the counters
 *   raw events       any filter and full detail, but only within retention
 *
 * The answer says which store it came from and why, because a page that
 * silently switches between "everything" and "everything we still have" teaches
 * its reader to trust numbers that mean different things.
 */

const querySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  nodeId: z.string().uuid().optional(),
  username: z.string().max(64).optional(),
  clientIp: z.string().max(64).optional(),
  destination: z.string().max(255).optional(),
  decision: z.enum(['ALLOWED', 'DENIED', 'AUTH_REQUIRED', 'ERROR']).optional(),
  method: z.string().max(16).optional(),
});

type Query = z.infer<typeof querySchema>;

/** Filters that only the raw events can answer. */
const DETAIL_FILTERS = ['clientIp', 'destination', 'method'] as const;

interface Window {
  from: Date;
  to: Date;
}

const MAX_RANGE_DAYS = 400;

function windowOf(query: Query): Window {
  const to = query.to ? new Date(query.to) : new Date();
  const from = query.from ? new Date(query.from) : new Date(to.getTime() - 24 * 3600_000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw badRequest('The time range is not a valid pair of timestamps.');
  }
  if (from >= to) throw badRequest('The start of the range must be before its end.');
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * 86_400_000) {
    throw badRequest(`A range longer than ${MAX_RANGE_DAYS} days cannot be charted usefully.`);
  }
  return { from, to };
}

/** Hour, day or week, so a chart never gets more points than it can draw. */
function granularityOf(window: Window): { unit: 'hour' | 'day' | 'week'; label: string } {
  const hours = (window.to.getTime() - window.from.getTime()) / 3600_000;
  if (hours <= 72) return { unit: 'hour', label: 'hourly' };
  if (hours <= 24 * 120) return { unit: 'day', label: 'daily' };
  return { unit: 'week', label: 'weekly' };
}

export async function registerStatisticsRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  const { db, config } = context;

  app.get('/statistics', async (request) => {
    requirePermission(request, 'TRAFFIC_READ');
    const parsed = querySchema.safeParse(request.query ?? {});
    if (!parsed.success) throw badRequest('Invalid statistics query.', parsed.error.issues);
    const query = parsed.data;
    const window = windowOf(query);
    const grain = granularityOf(window);

    const statisticsRetention = await getSetting(
      db,
      SETTING_STATISTICS_RETENTION_DAYS,
      DEFAULT_STATISTICS_RETENTION_DAYS,
    );
    const rawHorizon = new Date(Date.now() - config.traffic.retentionDays * 86_400_000);
    const usedDetailFilter = DETAIL_FILTERS.find((name) => query[name]);

    // The raw events can answer anything, but only back to the horizon. Asking
    // them about a window that starts before it would quietly return a partial
    // answer, so the choice is made explicit and reported.
    const wantsDetail = Boolean(usedDetailFilter);
    const detailAvailable = window.from >= rawHorizon;
    const source: 'events' | 'rollups' = wantsDetail || detailAvailable ? 'events' : 'rollups';
    const truncated = wantsDetail && !detailAvailable;

    const summary =
      source === 'events'
        ? await fromEvents(db, window, query, grain, truncated ? rawHorizon : null)
        : await fromRollups(db, window, query, grain);

    return {
      window: { from: window.from.toISOString(), to: window.to.toISOString() },
      granularity: grain.label,
      source,
      /** What the reader has to know to interpret the numbers above. */
      coverage: {
        rawRetentionDays: config.traffic.retentionDays,
        statisticsRetentionDays: statisticsRetention,
        rawAvailableFrom: rawHorizon.toISOString(),
        detailFiltersAvailable: detailAvailable,
        truncatedToRawRetention: truncated,
        appliedDetailFilter: usedDetailFilter ?? null,
      },
      ...summary,
    };
  });
}

/* -------------------------------------------------------------------------- */
/* From the hourly rollups: any range, fixed questions                         */
/* -------------------------------------------------------------------------- */

async function fromRollups(
  db: AppContext['db'],
  window: Window,
  query: Query,
  grain: { unit: string },
): Promise<Record<string, unknown>> {
  const params: unknown[] = [window.from.toISOString(), window.to.toISOString()];
  const conditions = ['bucket >= $1', 'bucket < $2'];
  if (query.nodeId) {
    params.push(query.nodeId);
    conditions.push(`node_id = $${params.length}`);
  }
  if (query.username) {
    params.push(query.username);
    conditions.push(`lower(username) = lower($${params.length})`);
  }
  if (query.decision) {
    params.push(query.decision);
    conditions.push(`decision = $${params.length}`);
  }
  const where = conditions.join(' and ');

  const { rows: totals } = await db.query(
    `select coalesce(sum(requests), 0)::text as requests,
            coalesce(sum(bytes), 0)::text as bytes,
            coalesce(sum(bytes_uploaded), 0)::text as bytes_uploaded,
            coalesce(sum(requests) filter (where authenticated), 0)::text as authenticated,
            coalesce(sum(requests) filter (where decision = 'DENIED'), 0)::text as denied,
            coalesce(sum(requests) filter (where decision = 'AUTH_REQUIRED'), 0)::text as challenged,
            coalesce(sum(requests) filter (where decision = 'ERROR'), 0)::text as errors,
            coalesce(sum(duration_sum), 0)::text as duration_sum,
            coalesce(sum(duration_count), 0)::text as duration_count,
            coalesce(max(duration_max), 0)::text as duration_max,
            count(distinct username) filter (where username <> '')::text as users
     from traffic_rollups where ${where}`,
    params,
  );

  const { rows: series } = await db.query(
    `select date_trunc('${grain.unit}', bucket) as at,
            sum(requests) filter (where decision = 'ALLOWED')::text as allowed,
            sum(requests) filter (where decision = 'DENIED')::text as denied,
            sum(requests) filter (where decision = 'AUTH_REQUIRED')::text as challenged,
            sum(requests) filter (where decision = 'ERROR')::text as errors,
            sum(bytes)::text as bytes,
            sum(bytes_uploaded)::text as bytes_uploaded
     from traffic_rollups where ${where}
     group by 1 order by 1`,
    params,
  );

  const { rows: topUsers } = await db.query(
    `select username,
            sum(requests)::text as requests,
            sum(bytes)::text as bytes,
            sum(bytes_uploaded)::text as bytes_uploaded
     from traffic_rollups where ${where} and username <> ''
     group by 1 order by sum(requests) desc limit 10`,
    params,
  );

  const { rows: topUsersByBytes } = await db.query(
    `select username, sum(bytes)::text as bytes, sum(requests)::text as requests
     from traffic_rollups where ${where} and username <> ''
     group by 1 order by sum(bytes) desc limit 10`,
    params,
  );

  const { rows: hourOfDay } = await db.query(
    `select extract(hour from bucket at time zone 'UTC')::int as hour,
            sum(requests)::text as requests
     from traffic_rollups where ${where}
     group by 1 order by 1`,
    params,
  );

  // Destinations and client addresses live in their own cubes, which carry no
  // user dimension - so they answer for the node, not for one person.
  const dimensionParams: unknown[] = [window.from.toISOString(), window.to.toISOString()];
  const dimensionConditions = ['bucket >= $1', 'bucket < $2'];
  if (query.nodeId) {
    dimensionParams.push(query.nodeId);
    dimensionConditions.push(`node_id = $${dimensionParams.length}`);
  }
  const dimensionWhere = dimensionConditions.join(' and ');

  const { rows: topDestinations } = await db.query(
    `select destination_host as host, sum(requests)::text as requests, sum(bytes)::text as bytes
     from traffic_destination_rollups where ${dimensionWhere}
     group by 1 order by sum(requests) desc limit 10`,
    dimensionParams,
  );

  const { rows: topClients } = await db.query(
    `select client_ip, sum(requests)::text as requests, sum(bytes)::text as bytes
     from traffic_client_rollups where ${dimensionWhere}
     group by 1 order by sum(requests) desc limit 10`,
    dimensionParams,
  );

  return {
    totals: totals[0] ?? {},
    series,
    topUsers,
    topUsersByBytes,
    topDestinations,
    topClients,
    hourOfDay,
    /** Only the raw events can answer these; the page hides them accordingly. */
    unavailable: ['responseTimePercentiles', 'errorReasons', 'methodMix', 'deniedDestinations', 'perUserDetail'],
  };
}

/* -------------------------------------------------------------------------- */
/* From the raw events: every filter, within retention                         */
/* -------------------------------------------------------------------------- */

async function fromEvents(
  db: AppContext['db'],
  window: Window,
  query: Query,
  grain: { unit: string },
  clampFrom: Date | null,
): Promise<Record<string, unknown>> {
  const from = clampFrom && clampFrom > window.from ? clampFrom : window.from;
  const params: unknown[] = [from.toISOString(), window.to.toISOString()];
  const conditions = ['occurred_at >= $1', 'occurred_at < $2'];

  const add = (value: unknown, clause: (placeholder: string) => string): void => {
    params.push(value);
    conditions.push(clause(`$${params.length}`));
  };
  if (query.nodeId) add(query.nodeId, (p) => `node_id = ${p}`);
  if (query.username) add(query.username, (p) => `lower(username) = lower(${p})`);
  if (query.decision) add(query.decision, (p) => `decision = ${p}`);
  if (query.method) add(query.method, (p) => `upper(method) = upper(${p})`);
  if (query.clientIp) add(query.clientIp, (p) => `client_ip = ${p}`);
  // Matches a host and everything under it, so "example.com" also finds
  // "cdn.example.com" - which is what an operator means by the question.
  if (query.destination) add(query.destination, (p) => `(destination_host = ${p} or destination_host like '%.' || ${p})`);
  const where = conditions.join(' and ');

  const { rows: totals } = await db.query(
    `select count(*)::text as requests,
            coalesce(sum(bytes), 0)::text as bytes,
            coalesce(sum(bytes_uploaded), 0)::text as bytes_uploaded,
            count(*) filter (where username is not null)::text as authenticated,
            count(*) filter (where decision = 'DENIED')::text as denied,
            count(*) filter (where decision = 'AUTH_REQUIRED')::text as challenged,
            count(*) filter (where decision = 'ERROR')::text as errors,
            count(distinct username)::text as users,
            count(distinct client_ip)::text as clients,
            count(distinct destination_host)::text as destinations,
            coalesce(round(avg(duration_ms)), 0)::text as duration_avg,
            coalesce(max(duration_ms), 0)::text as duration_max,
            coalesce(percentile_disc(0.5) within group (order by duration_ms), 0)::text as duration_p50,
            coalesce(percentile_disc(0.95) within group (order by duration_ms), 0)::text as duration_p95
     from traffic_events where ${where}`,
    params,
  );

  const { rows: series } = await db.query(
    `select date_trunc('${grain.unit}', occurred_at) as at,
            count(*) filter (where decision = 'ALLOWED')::text as allowed,
            count(*) filter (where decision = 'DENIED')::text as denied,
            count(*) filter (where decision = 'AUTH_REQUIRED')::text as challenged,
            count(*) filter (where decision = 'ERROR')::text as errors,
            coalesce(sum(bytes), 0)::text as bytes,
            coalesce(sum(bytes_uploaded), 0)::text as bytes_uploaded
     from traffic_events where ${where}
     group by 1 order by 1`,
    params,
  );

  const top = async (column: string, extra = ''): Promise<unknown[]> => {
    const { rows } = await db.query(
      `select ${column} as key, count(*)::text as requests, coalesce(sum(bytes), 0)::text as bytes
       from traffic_events where ${where} ${extra} and ${column} is not null
       group by 1 order by count(*) desc limit 10`,
      params,
    );
    return rows;
  };

  return {
    totals: totals[0] ?? {},
    series,
    topUsers: await top('username'),
    topDestinations: await top('destination_host'),
    topClients: await top('client_ip'),
    deniedDestinations: await top('destination_host', "and decision = 'DENIED'"),
    methodMix: await top('method'),
    errorReasons: await top('squid_status', "and decision = 'ERROR'"),
    hourOfDay: (
      await db.query(
        `select extract(hour from occurred_at at time zone 'UTC')::int as hour, count(*)::text as requests
         from traffic_events where ${where} group by 1 order by 1`,
        params,
      )
    ).rows,
    unavailable: [],
  };
}
