import Fastify, { type FastifyInstance } from 'fastify';
import type { AppConfig } from './config.js';
import type { Db } from './db/pool.js';
import { readPortalPrincipal, readPrincipal, sendError, HttpError } from './http/context.js';
import { RateLimiter } from './security/rateLimit.js';
import { registerAuditRoutes } from './routes/audit.js';
import { registerConfigurationRoutes } from './routes/configuration.js';
import { registerDashboardRoutes } from './routes/dashboard.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerAgentRoutes } from './routes/agent.js';
import { registerListenerProfileRoutes } from './routes/listenerProfiles.js';
import { registerNodeRoutes } from './routes/nodes.js';
import { registerPolicyRoutes } from './routes/policies.js';
import { registerPortalRoutes } from './routes/portal.js';
import { registerPortalOidcRoutes } from './routes/portalOidc.js';
import { registerOidcRoutes } from './routes/oidc.js';
import { expireStaleLeases } from './services/accessLease.js';
import { compactStatistics } from './services/statisticsCompaction.js';
import {
  DEFAULT_STATISTICS_FINE_DAYS,
  getSetting,
  SETTING_STATISTICS_FINE_DAYS,
} from './services/settings.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerTrafficRoutes } from './routes/traffic.js';
import { registerStatisticsRoutes } from './routes/statistics.js';
import { registerProxyAuthRoutes } from './routes/proxyAuth.js';
import { registerProxyIdentityRoutes } from './routes/proxyIdentity.js';
import { registerSessionRoutes } from './routes/session.js';

export interface AppContext {
  db: Db;
  config: AppConfig;
  loginLimiter: RateLimiter;
  authTestLimiter: RateLimiter;
}

export async function buildServer(db: Db, config: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      // Never let a password reach the log, whatever a handler passes in.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'body.password',
          'body.newPassword',
          'body.bindPassword',
          '*.password',
        ],
        censor: '[redacted]',
      },
    },
    trustProxy: true,
    bodyLimit: 1024 * 1024,
    disableRequestLogging: config.logLevel !== 'debug',
  });

  const context: AppContext = {
    db,
    config,
    loginLimiter: new RateLimiter(10, 5 * 60_000),
    authTestLimiter: new RateLimiter(20, 5 * 60_000),
  };

  const sweep = setInterval(() => {
    context.loginLimiter.sweep();
    context.authTestLimiter.sweep();
  }, 60_000);

  // Expired access leases (ADR 0004). Every five minutes is far finer than the
  // lease itself, and a failure here must not take the API down - it retries on
  // the next tick.
  const runLeaseSweep = (): void => {
    void expireStaleLeases(context.db)
      .then((count) => {
        if (count > 0) app.log.info({ count }, 'disabled proxy accounts with an expired lease');
      })
      .catch((error: unknown) => app.log.error({ err: error }, 'lease sweep failed'));
  };
  // Once at startup, then on a schedule. An interval alone would leave expired
  // access in place for the first five minutes after every restart, which is
  // exactly when an operator is most likely to be watching.
  runLeaseSweep();
  const leaseSweep = setInterval(runLeaseSweep, 5 * 60_000);
  leaseSweep.unref();

  // Folding five minute counters into hourly ones. Hourly is often enough: the
  // buckets being folded are already older than the fine window, so nothing is
  // waiting on this.
  const runCompaction = (): void => {
    void getSetting(context.db, SETTING_STATISTICS_FINE_DAYS, DEFAULT_STATISTICS_FINE_DAYS)
      .then((days) => compactStatistics(context.db, days))
      .then((result) => {
        if (result.removed > 0) {
          app.log.info(result, 'compacted five minute statistics into hourly buckets');
        }
      })
      .catch((error: unknown) => app.log.error({ err: error }, 'statistics compaction failed'));
  };
  runCompaction();
  const compaction = setInterval(runCompaction, 60 * 60_000);
  compaction.unref();
  sweep.unref();
  app.addHook('onClose', async () => {
    clearInterval(sweep);
    clearInterval(leaseSweep);
    clearInterval(compaction);
  });

  // Every request gets a principal if it carries a valid token; authorisation
  // itself is decided per route. The two audiences are mutually exclusive by
  // construction: a token verifies as one or the other, never both.
  app.addHook('onRequest', async (request) => {
    const principal = readPrincipal(request, config.jwtSecret);
    if (principal) {
      request.principal = principal;
      return;
    }
    const portalPrincipal = readPortalPrincipal(request, config.jwtSecret);
    if (portalPrincipal) request.portalPrincipal = portalPrincipal;
  });

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cache-Control', 'no-store');
    return payload;
  });

  app.setErrorHandler((error: unknown, _request, reply) => {
    if (error instanceof HttpError) return sendError(reply, error);

    // Fastify's own validation and body parsing errors carry a status code.
    const fastifyError = error as { statusCode?: number; message?: string };
    if (fastifyError.statusCode && fastifyError.statusCode < 500) {
      return reply.status(fastifyError.statusCode).send({
        error: {
          code: 'BAD_REQUEST',
          message: fastifyError.message ?? 'The request could not be processed.',
          details: null,
        },
      });
    }

    app.log.error({ err: error }, 'unhandled error');
    return sendError(reply, error);
  });

  app.setNotFoundHandler((request, reply) =>
    reply
      .status(404)
      .send({ error: { code: 'NOT_FOUND', message: `No route for ${request.method} ${request.url}`, details: null } }),
  );

  // Health is reachable twice on purpose: at the root for the container
  // healthcheck and orchestrators, and under /api because the web tier proxies
  // exactly that prefix through to this service.
  await registerHealthRoutes(app, context);
  await app.register(async (instance) => registerHealthRoutes(instance, context), { prefix: '/api' });

  await app.register(
    async (instance) => {
      await registerSessionRoutes(instance, context);
      await registerPortalRoutes(instance, context);
      await registerPortalOidcRoutes(instance, context);
      await registerOidcRoutes(instance, context);
      await registerNodeRoutes(instance, context);
      await registerListenerProfileRoutes(instance, context);
      await registerAgentRoutes(instance, context);
      await registerProxyAuthRoutes(instance, context);
      await registerProxyIdentityRoutes(instance, context);
      await registerPolicyRoutes(instance, context);
      await registerConfigurationRoutes(instance, context);
      await registerDashboardRoutes(instance, context);
      await registerTrafficRoutes(instance, context);
      await registerStatisticsRoutes(instance, context);
      await registerSettingsRoutes(instance, context);
      await registerAuditRoutes(instance, context);
    },
    { prefix: '/api/v1' },
  );

  return app;
}
