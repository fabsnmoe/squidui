import pg from 'pg';

/**
 * A single shared pool. `pg` returns numeric/bigint columns as strings by
 * default to avoid precision loss; the only bigint we use is the audit event
 * id, which we keep as a string anyway.
 */

export type Db = pg.Pool;

let pool: pg.Pool | null = null;

export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: 'squid-control-plane',
  });
}

export function getPool(databaseUrl: string): pg.Pool {
  if (!pool) pool = createPool(databaseUrl);
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/** Runs `fn` inside a transaction, rolling back on any error. */
export async function withTransaction<T>(db: Db, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Waits for the database to accept connections; used by migrate and startup. */
export async function waitForDatabase(db: Db, attempts = 30, delayMs = 2000): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await db.query('select 1');
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(
    `Database not reachable after ${attempts} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}
