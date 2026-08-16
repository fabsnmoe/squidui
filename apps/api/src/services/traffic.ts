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

  await pruneIfDue(db, options.retentionDays);
  return { accepted: entries.length, rejected };
}

async function insertEvents(
  db: Db,
  nodeId: string,
  entries: readonly AccessLogEntry[],
  options: IngestOptions,
): Promise<void> {
  const columns = 13;
  const values: unknown[] = [];
  const tuples: string[] = [];

  entries.forEach((entry, index) => {
    const base = index * columns;
    tuples.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, ` +
        `$${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, ` +
        `$${base + 12}, $${base + 13})`,
    );
    values.push(
      nodeId,
      entry.occurredAt,
      entry.clientIp,
      entry.username,
      entry.squidStatus,
      entry.httpStatus,
      entry.bytes,
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
        method, destination_host, destination_port, duration_ms, url, decision)
     values ${tuples.join(', ')}`,
    values,
  );
}

async function updateRollups(db: Db, nodeId: string, entries: readonly AccessLogEntry[]): Promise<void> {
  // Aggregated in memory first: one upsert per distinct bucket beats one per
  // request line by orders of magnitude on a busy proxy.
  const counters = new Map<string, { bucket: string; authenticated: boolean; username: string; decision: string; requests: number; bytes: number }>();

  for (const entry of entries) {
    const bucket = bucketOf(entry.occurredAt);
    const username = entry.username ?? '';
    const key = `${bucket}|${username}|${entry.decision}`;
    const existing = counters.get(key);
    if (existing) {
      existing.requests += 1;
      existing.bytes += entry.bytes ?? 0;
    } else {
      counters.set(key, {
        bucket,
        authenticated: entry.username !== null,
        username,
        decision: entry.decision,
        requests: 1,
        bytes: entry.bytes ?? 0,
      });
    }
  }

  for (const counter of counters.values()) {
    await db.query(
      `insert into traffic_rollups (bucket, node_id, authenticated, username, decision, requests, bytes)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (bucket, node_id, authenticated, username, decision) do update set
         requests = traffic_rollups.requests + excluded.requests,
         bytes = traffic_rollups.bytes + excluded.bytes`,
      [counter.bucket, nodeId, counter.authenticated, counter.username, counter.decision, counter.requests, counter.bytes],
    );
  }
}

async function pruneIfDue(db: Db, retentionDays: number): Promise<void> {
  const now = Date.now();
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) return;
  lastPruneAt = now;
  // Only the raw rows expire. The hourly counters stay, so a year-old month
  // still has numbers even though the individual requests are long gone.
  await db
    .query(`delete from traffic_events where occurred_at < now() - ($1 || ' days')::interval`, [
      String(Math.max(1, retentionDays)),
    ])
    .catch(() => undefined);
}

/** Exposed for tests: forces the next ingest to run the retention delete. */
export function resetPruneTimer(): void {
  lastPruneAt = 0;
}
