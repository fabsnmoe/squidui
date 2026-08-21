import { parseAccessLogLine, type AccessLogEntry } from '@scp/shared';
import type { Db } from '../db/pool.js';

/**
 * Traffic log ingestion (PLAN.md Phase 8).
 *
 * Agents ship raw access log lines; parsing happens here so the format is
 * versioned in one place. Two things are written per batch: the individual
 * requests, kept for a bounded window, and hourly counters, which are what the
 * dashboard and the self-service portal actually read. Without the counters
 * every dashboard load would scan the raw table.
 */

export interface IngestOptions {
  /** Store the full URL, or only the destination host. */
  logUrls: boolean;
  retentionDays: number;
  /** How long the hourly statistics survive. Zero keeps them indefinitely. */
  statisticsRetentionDays: number;
}

export interface IngestResult {
  accepted: number;
  rejected: number;
}

/** Retention is enforced lazily; a cron would be a second thing to operate. */
let lastPruneAt = 0;
const PRUNE_INTERVAL_MS = 15 * 60_000;

function bucketOf(occurredAt: string): string {
  const date = new Date(occurredAt);
  date.setUTCMinutes(0, 0, 0);
  return date.toISOString();
}

export async function ingestAccessLog(
  db: Db,
  nodeId: string,
  lines: readonly string[],
  options: IngestOptions,
): Promise<IngestResult> {
  const entries: AccessLogEntry[] = [];
  let rejected = 0;

  for (const line of lines) {
    const entry = parseAccessLogLine(line);
    if (entry) entries.push(entry);
    else rejected += 1;
  }

  if (entries.length > 0) {
    await insertEvents(db, nodeId, entries, options);
    await updateRollups(db, nodeId, entries);
  }

  await db.query(
    `insert into node_log_state (node_id, last_shipped, lines_total, dropped_total)
     values ($1, now(), $2, $3)
     on conflict (node_id) do update set
       last_shipped = now(),
       lines_total = node_log_state.lines_total + excluded.lines_total,
       dropped_total = node_log_state.dropped_total + excluded.dropped_total`,
    [nodeId, entries.length, rejected],
  );

  await pruneIfDue(db, options);
  return { accepted: entries.length, rejected };
}

async function insertEvents(
  db: Db,
  nodeId: string,
  entries: readonly AccessLogEntry[],
  options: IngestOptions,
): Promise<void> {
  const columns = 14;
  const values: unknown[] = [];
  const tuples: string[] = [];

  entries.forEach((entry, index) => {
    const base = index * columns;
    tuples.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, ` +
        `$${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, ` +
        `$${base + 12}, $${base + 13}, $${base + 14})`,
    );
    values.push(
      nodeId,
      entry.occurredAt,
      entry.clientIp,
      entry.username,
      entry.squidStatus,
      entry.httpStatus,
      entry.bytes,
      entry.bytesUploaded,
      entry.method,
      entry.destinationHost,
      entry.destinationPort,
      entry.durationMs,
      // Full URLs are personal data. When TRAFFIC_LOG_URLS is off the host is
      // still recorded, which answers "where did traffic go" without keeping
      // every page a user opened.
      options.logUrls ? entry.url?.slice(0, 2048) ?? null : null,
      entry.decision,
    );
  });

  await db.query(
    `insert into traffic_events
       (node_id, occurred_at, client_ip, username, squid_status, http_status, bytes,
        bytes_uploaded, method, destination_host, destination_port, duration_ms, url, decision)
     values ${tuples.join(', ')}`,
    values,
  );
}

async function updateRollups(db: Db, nodeId: string, entries: readonly AccessLogEntry[]): Promise<void> {
  // Aggregated in memory first: one upsert per distinct bucket beats one per
  // request line by orders of magnitude on a busy proxy.
  interface IdentityCounter {
    bucket: string;
    authenticated: boolean;
    username: string;
    decision: string;
    requests: number;
    bytes: number;
    bytesUploaded: number;
    durationSum: number;
    durationCount: number;
    durationMax: number;
  }
  interface DimensionCounter {
    bucket: string;
    key: string;
    requests: number;
    bytes: number;
    bytesUploaded: number;
  }

  const counters = new Map<string, IdentityCounter>();
  // Destinations and client addresses are their own cubes rather than further
  // dimensions on this one. Multiplying them out is what turns a rollup into
  // something the size of the raw data it was meant to replace.
  const destinations = new Map<string, DimensionCounter>();
  const clients = new Map<string, DimensionCounter>();

  const addDimension = (
    into: Map<string, DimensionCounter>,
    bucket: string,
    key: string,
    bytes: number,
    uploaded: number,
  ): void => {
    const mapKey = `${bucket}|${key}`;
    const found = into.get(mapKey);
    if (found) {
      found.requests += 1;
      found.bytes += bytes;
      found.bytesUploaded += uploaded;
    } else {
      into.set(mapKey, { bucket, key, requests: 1, bytes, bytesUploaded: uploaded });
    }
  };

  for (const entry of entries) {
    const bucket = bucketOf(entry.occurredAt);
    const username = entry.username ?? '';
    const bytes = entry.bytes ?? 0;
    // Null means the node has not picked up format v3 yet. A sum has no way to
    // express "unknown", so it counts as zero here and the page says when a
    // range predates the format rather than presenting the dip as a fact.
    const uploaded = entry.bytesUploaded ?? 0;

    const key = `${bucket}|${username}|${entry.decision}`;
    const existing = counters.get(key);
    if (existing) {
      existing.requests += 1;
      existing.bytes += bytes;
      existing.bytesUploaded += uploaded;
      if (entry.durationMs !== null) {
        existing.durationSum += entry.durationMs;
        existing.durationCount += 1;
        existing.durationMax = Math.max(existing.durationMax, entry.durationMs);
      }
    } else {
      counters.set(key, {
        bucket,
        authenticated: entry.username !== null,
        username,
        decision: entry.decision,
        requests: 1,
        bytes,
        bytesUploaded: uploaded,
        // Counted separately from requests: a mean over rows that never
        // reported a time would be a different number than it claims to be.
        durationSum: entry.durationMs ?? 0,
        durationCount: entry.durationMs === null ? 0 : 1,
        durationMax: entry.durationMs ?? 0,
      });
    }

    if (entry.destinationHost) addDimension(destinations, bucket, entry.destinationHost, bytes, uploaded);
    if (entry.clientIp) addDimension(clients, bucket, entry.clientIp, bytes, uploaded);
  }

  for (const counter of counters.values()) {
    await db.query(
      `insert into traffic_rollups
         (bucket, node_id, authenticated, username, decision, requests, bytes,
          bytes_uploaded, duration_sum, duration_count, duration_max)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       on conflict (bucket, node_id, authenticated, username, decision) do update set
         requests = traffic_rollups.requests + excluded.requests,
         bytes = traffic_rollups.bytes + excluded.bytes,
         bytes_uploaded = traffic_rollups.bytes_uploaded + excluded.bytes_uploaded,
         duration_sum = traffic_rollups.duration_sum + excluded.duration_sum,
         duration_count = traffic_rollups.duration_count + excluded.duration_count,
         duration_max = greatest(traffic_rollups.duration_max, excluded.duration_max)`,
      [
        counter.bucket,
        nodeId,
        counter.authenticated,
        counter.username,
        counter.decision,
        counter.requests,
        counter.bytes,
        counter.bytesUploaded,
        counter.durationSum,
        counter.durationCount,
        counter.durationMax,
      ],
    );
  }

  for (const destination of destinations.values()) {
    await db.query(
      `insert into traffic_destination_rollups
         (bucket, node_id, destination_host, requests, bytes, bytes_uploaded)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (bucket, node_id, destination_host) do update set
         requests = traffic_destination_rollups.requests + excluded.requests,
         bytes = traffic_destination_rollups.bytes + excluded.bytes,
         bytes_uploaded = traffic_destination_rollups.bytes_uploaded + excluded.bytes_uploaded`,
      [
        destination.bucket,
        nodeId,
        destination.key.slice(0, 255),
        destination.requests,
        destination.bytes,
        destination.bytesUploaded,
      ],
    );
  }

  for (const client of clients.values()) {
    await db.query(
      `insert into traffic_client_rollups
         (bucket, node_id, client_ip, requests, bytes, bytes_uploaded)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (bucket, node_id, client_ip) do update set
         requests = traffic_client_rollups.requests + excluded.requests,
         bytes = traffic_client_rollups.bytes + excluded.bytes,
         bytes_uploaded = traffic_client_rollups.bytes_uploaded + excluded.bytes_uploaded`,
      [client.bucket, nodeId, client.key.slice(0, 64), client.requests, client.bytes, client.bytesUploaded],
    );
  }
}

async function pruneIfDue(db: Db, options: IngestOptions): Promise<void> {
  const now = Date.now();
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) return;
  lastPruneAt = now;

  // Two windows, because they hold different things. The raw rows are personal
  // data and expire first; the hourly counters carry no URL and no individual
  // request, so they can be kept far longer without keeping a record of what
  // any one person read.
  const rawDays = String(Math.max(1, options.retentionDays));
  await db
    .query(`delete from traffic_events where occurred_at < now() - ($1 || ' days')::interval`, [rawDays])
    .catch(() => undefined);

  // Zero means keep indefinitely, which is what installations upgrading into
  // this had before the setting existed. Deleting their history because a new
  // default appeared would be indefensible.
  if (options.statisticsRetentionDays <= 0) return;
  const statsDays = String(options.statisticsRetentionDays);
  for (const table of ['traffic_rollups', 'traffic_destination_rollups', 'traffic_client_rollups']) {
    await db
      .query(`delete from ${table} where bucket < now() - ($1 || ' days')::interval`, [statsDays])
      .catch(() => undefined);
  }
}

/** Exposed for tests: forces the next ingest to run the retention delete. */
export function resetPruneTimer(): void {
  lastPruneAt = 0;
}
