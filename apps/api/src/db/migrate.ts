import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig } from '../config.js';
import { bootstrap } from '../bootstrap.js';
import { createPool, waitForDatabase, type Db } from './pool.js';

/**
 * Forward-only SQL migration runner (ADR 0001).
 *
 * Each file runs exactly once, inside a transaction, and is recorded with a
 * checksum so an edited-after-the-fact migration is caught instead of silently
 * diverging between environments.
 */

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

async function ensureMigrationsTable(db: Db): Promise<void> {
  await db.query(`
    create table if not exists schema_migrations (
      filename   text primary key,
      checksum   text        not null,
      applied_at timestamptz not null default now()
    )
  `);
}

export async function runMigrations(db: Db, log: (message: string) => void): Promise<MigrationResult> {
  await ensureMigrationsTable(db);

  const files = (await readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith('.sql')).sort();
  const { rows } = await db.query<{ filename: string; checksum: string }>(
    'select filename, checksum from schema_migrations',
  );
  const applied = new Map(rows.map((row) => [row.filename, row.checksum]));

  const result: MigrationResult = { applied: [], skipped: [] };

  for (const filename of files) {
    const sql = await readFile(join(MIGRATIONS_DIR, filename), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const previous = applied.get(filename);

    if (previous) {
      if (previous !== checksum) {
        throw new Error(
          `Migration ${filename} was modified after it was applied (checksum mismatch). ` +
            'Create a new migration instead of editing an applied one.',
        );
      }
      result.skipped.push(filename);
      continue;
    }

    log(`applying ${filename}`);
    const client = await db.connect();
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into schema_migrations (filename, checksum) values ($1, $2)', [
        filename,
        checksum,
      ]);
      await client.query('commit');
      result.applied.push(filename);
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw new Error(
        `Migration ${filename} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      client.release();
    }
  }

  return result;
}

/** Entry point of the `migrate` compose service. */
async function main(): Promise<void> {
  const config = loadConfig();
  const db = createPool(config.databaseUrl);
  const log = (message: string): void => {
    process.stdout.write(`[migrate] ${message}\n`);
  };

  try {
    log('waiting for the database');
    await waitForDatabase(db);

    const result = await runMigrations(db, log);
    log(
      result.applied.length > 0
        ? `applied ${result.applied.length} migration(s): ${result.applied.join(', ')}`
        : 'schema already up to date',
    );

    const summary = await bootstrap(db, config, log);
    log(`bootstrap: ${summary.join('; ') || 'nothing to do'}`);
    log('done');
  } finally {
    await db.end();
  }
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`[migrate] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
