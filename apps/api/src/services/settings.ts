import type { Db } from '../db/pool.js';

/**
 * Runtime settings.
 *
 * Anything an operator should be able to change without restarting a container
 * lives here. The environment supplies the initial value; the stored value wins
 * afterwards, because a setting that can only be changed by editing .env and
 * redeploying is not a setting an operator will ever use.
 *
 * Cached briefly: these are read on every ingest batch.
 */

const CACHE_TTL_MS = 15_000;

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

export async function getSetting<T>(db: Db, key: string, fallback: T): Promise<T> {
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value as T;

  try {
    const { rows } = await db.query<{ value: T }>('select value from app_settings where key = $1', [key]);
    const value = rows.length > 0 ? (rows[0] as { value: T }).value : fallback;
    cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
  } catch {
    // A settings table that is unreachable must not take ingestion down; the
    // configured default is the safe answer.
    return fallback;
  }
}

export async function setSetting(db: Db, key: string, value: unknown, updatedBy: string): Promise<void> {
  await db.query(
    `insert into app_settings (key, value, updated_by) values ($1, $2::jsonb, $3)
     on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by`,
    [key, JSON.stringify(value), updatedBy],
  );
  cache.delete(key);
}

export function invalidateSettingsCache(): void {
  cache.clear();
}

export const SETTING_TRAFFIC_LOG_URLS = 'traffic.logUrls';
