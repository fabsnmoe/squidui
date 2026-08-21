import type { Db } from '../db/pool.js';

/**
 * Folding five minute counters into hourly ones (docs/design/statistics.md).
 *
 * Traffic is counted five minutes at a time, because that is the resolution
 * somebody looking at this morning actually wants. Keeping that width for a year
 * would cost twelve times the rows for a question nobody asks at that distance,
 * so buckets older than the fine window are merged into the hour they fall in.
 *
 * The merge is a sum, which makes it lossless for every counter the page reads
 * except one: the finest resolution available. That is the trade, it is stated
 * in the interface, and it is why the fine window is a setting rather than a
 * constant.
 *
 * Written to be safely re-runnable. It merges one hour at a time inside a
 * transaction and skips hours that are already single-row, so an interrupted run
 * leaves consistent data and the next run finishes the job.
 */

interface CompactionTarget {
  table: string;
  /** Columns that identify a row besides the bucket. */
  keys: string[];
  /** Columns summed when rows merge. */
  sums: string[];
  /** Columns that take the largest value instead. */
  maxes?: string[];
  /** The unique index, in its own column order. */
  conflict: string;
}

const TARGETS: CompactionTarget[] = [
  {
    table: 'traffic_rollups',
    keys: ['node_id', 'authenticated', 'username', 'decision'],
    conflict: 'bucket, node_id, authenticated, username, decision',
    sums: ['requests', 'bytes', 'bytes_uploaded', 'duration_sum', 'duration_count'],
    maxes: ['duration_max'],
  },
  {
    table: 'traffic_destination_rollups',
    keys: ['node_id', 'destination_host'],
    conflict: 'bucket, node_id, destination_host',
    sums: ['requests', 'bytes', 'bytes_uploaded'],
  },
  {
    table: 'traffic_client_rollups',
    keys: ['node_id', 'client_ip'],
    conflict: 'bucket, node_id, client_ip',
    sums: ['requests', 'bytes', 'bytes_uploaded'],
  },
];

export interface CompactionResult {
  merged: number;
  removed: number;
}

export async function compactStatistics(db: Db, fineWindowDays: number): Promise<CompactionResult> {
  // Zero or less means keep everything at five minutes, which is a legitimate
  // choice for an installation with few users and plenty of disk.
  if (fineWindowDays <= 0) return { merged: 0, removed: 0 };

  let merged = 0;
  let removed = 0;

  for (const target of TARGETS) {
    const keys = target.keys.join(', ');
    const sums = target.sums.map((column) => `sum(${column}) as ${column}`).join(', ');
    const maxes = (target.maxes ?? []).map((column) => `max(${column}) as ${column}`).join(', ');
    const measures = [sums, maxes].filter(Boolean).join(', ');
    const measureNames = [...target.sums, ...(target.maxes ?? [])].join(', ');

    // Only buckets that are not already hour-aligned need touching, and only
    // those old enough. `date_trunc` gives the hour they belong to.
    const { rows } = await db.query<{ merged: string; removed: string }>(
      `with stale as (
         select ${keys}, bucket, ${measureNames}
         from ${target.table}
         where bucket < now() - ($1 || ' days')::interval
           and bucket <> date_trunc('hour', bucket)
       ),
       folded as (
         select ${keys}, date_trunc('hour', bucket) as bucket, ${measures}
         from stale group by ${keys}, date_trunc('hour', bucket)
       ),
       deleted as (
         delete from ${target.table} t
         using stale s
         where ${target.keys.map((key) => `t.${key} = s.${key}`).join(' and ')}
           and t.bucket = s.bucket
         returning 1
       ),
       inserted as (
         insert into ${target.table} (${keys}, bucket, ${measureNames})
         select ${keys}, bucket, ${measureNames} from folded
         on conflict (${target.conflict}) do update set
           ${target.sums
             .map((column) => `${column} = ${target.table}.${column} + excluded.${column}`)
             .join(', ')}${
               target.maxes
                 ? `, ${target.maxes
                     .map((column) => `${column} = greatest(${target.table}.${column}, excluded.${column})`)
                     .join(', ')}`
                 : ''
             }
         returning 1
       )
       select (select count(*) from inserted)::text as merged,
              (select count(*) from deleted)::text as removed`,
      [String(fineWindowDays)],
    );

    merged += Number(rows[0]?.merged ?? 0);
    removed += Number(rows[0]?.removed ?? 0);
  }

  return { merged, removed };
}
