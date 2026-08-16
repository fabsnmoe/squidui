import { loadConfig, ConfigError } from './config.js';
import { createPool, waitForDatabase } from './db/pool.js';
import { buildServer } from './server.js';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`Configuration error: ${error.message}\n`);
      process.exit(78); // EX_CONFIG
    }
    throw error;
  }

  const db = createPool(config.databaseUrl);
  const app = await buildServer(db, config);

  try {
    await waitForDatabase(db, 30, 2000);
    app.log.info('database reachable');
  } catch (error) {
    // Start anyway: /health/live stays up so an orchestrator can tell the
    // difference between "process dead" and "dependency down".
    app.log.error({ err: error }, 'database not reachable at startup');
  }

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await db.end().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    { version: config.build.appVersion, gitSha: config.build.gitSha },
    'squid control plane api started',
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
