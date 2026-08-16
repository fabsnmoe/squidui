import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../server.js';

/**
 * Liveness and readiness.
 *
 * `/health/live`  the process is up - never touches a dependency.
 * `/health/ready` the process can serve traffic - checks the database and the
 *                 schema, which is what the documented install flow probes
 *                 (PLAN.md section 16).
 */

export async function registerHealthRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  const { db, config } = context;

  app.get('/health/live', async () => ({
    status: 'ok',
    version: config.build.appVersion,
    gitSha: config.build.gitSha,
    buildDate: config.build.buildDate,
  }));

  app.get('/health/ready', async (_request, reply) => {
    const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];

    try {
      await db.query('select 1');
      checks.push({ name: 'database', ok: true });
    } catch (error) {
      checks.push({
        name: 'database',
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }

    if (checks[0]?.ok) {
      try {
        const { rows } = await db.query<{ count: string }>(
          "select count(*)::text as count from information_schema.tables where table_name = 'proxy_auth_config'",
        );
        const migrated = (rows[0]?.count ?? '0') !== '0';
        checks.push({
          name: 'schema',
          ok: migrated,
          ...(migrated ? {} : { detail: 'Migrations have not been applied yet. Run the migrate service.' }),
        });
      } catch (error) {
        checks.push({
          name: 'schema',
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const ready = checks.every((check) => check.ok);
    return reply.status(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'not-ready',
      version: config.build.appVersion,
      checks,
    });
  });

  // Build metadata, readable without a session so an operator can verify what
  // is deployed before logging in.
  app.get('/health/version', async () => ({
    version: config.build.appVersion,
    gitSha: config.build.gitSha,
    buildDate: config.build.buildDate,
  }));
}
