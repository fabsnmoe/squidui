import type { FastifyInstance } from 'fastify';
import { detectSecurityFindings } from '@scp/shared';
import { requirePermission } from '../http/context.js';
import { AuthenticationProviderRegistry } from '../providers/registry.js';
import { buildIr } from '../services/configuration.js';
import type { AppContext } from '../server.js';

/**
 * Dashboard summary (PLAN.md 23, 9.22).
 *
 * Answers the six questions an administrator has in the first five seconds.
 * Metrics whose data source does not exist yet are reported as
 * `available: false` rather than as a fabricated number - the UI then renders
 * an empty state instead of a lie (design principle 9).
 */

export async function registerDashboardRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  const { db, config } = context;

  app.get('/dashboard', async (request) => {
    requirePermission(request, 'DASHBOARD_READ');

    const registry = await AuthenticationProviderRegistry.load(db, config);
    const [providers, { ir, issues }] = await Promise.all([registry.summaries(), buildIr(db, registry)]);

    const { rows: nodeRows } = await db.query<{ status: string; count: string }>(
      'select status, count(*)::text as count from proxy_nodes group by status',
    );
    const nodesByStatus = Object.fromEntries(nodeRows.map((row) => [row.status, Number(row.count)]));
    const nodeTotal = Object.values(nodesByStatus).reduce((sum, value) => sum + value, 0);

    const { rows: counters } = await db.query<{
      rules: string;
      enabled_rules: string;
      proxy_users: string;
      proxy_groups: string;
      config_versions: string;
    }>(
      `select
         (select count(*) from access_rules)::text as rules,
         (select count(*) from access_rules where enabled)::text as enabled_rules,
         (select count(*) from proxy_users where status = 'ACTIVE')::text as proxy_users,
         (select count(*) from proxy_groups)::text as proxy_groups,
         (select count(*) from config_versions)::text as config_versions`,
    );

    const { rows: recentFailures } = await db.query<{ count: string }>(
      `select count(*)::text as count from audit_events
       where action in ('CP_LOGIN_FAILED', 'AUTH_TEST_PERFORMED')
         and outcome = 'FAILURE'
         and occurred_at > now() - interval '24 hours'`,
    );

    return {
      authentication: {
        mode: ir.authentication.mode,
        realm: ir.authentication.realm,
        defaultAccess: ir.defaultAccess,
        providers: providers.map((provider) => ({
          key: provider.key,
          name: provider.name,
          enabled: provider.enabled,
          health: provider.health.state,
          priority: provider.priority,
        })),
      },
      findings: detectSecurityFindings(ir),
      issues,
      nodes: {
        total: nodeTotal,
        byStatus: nodesByStatus,
        // Node reporting arrives with the agent (Phase 3).
        available: nodeTotal > 0,
      },
      policies: {
        rules: Number(counters[0]?.rules ?? '0'),
        enabledRules: Number(counters[0]?.enabled_rules ?? '0'),
        listeners: ir.listeners.length,
      },
      identities: {
        proxyUsers: Number(counters[0]?.proxy_users ?? '0'),
        proxyGroups: Number(counters[0]?.proxy_groups ?? '0'),
      },
      configuration: {
        versions: Number(counters[0]?.config_versions ?? '0'),
      },
      traffic: {
        // Traffic and per-identity request counters come from the log pipeline
        // (Phase 8), which is not implemented yet.
        available: false,
        authenticatedRequests: null,
        unauthenticatedRequests: null,
        authenticationFailures24h: Number(recentFailures[0]?.count ?? '0'),
      },
    };
  });

  app.get('/nodes', async (request) => {
    requirePermission(request, 'NODE_READ');
    const { rows } = await db.query(
      'select id, name, hostname, status, squid_version, adapter_id, last_seen_at from proxy_nodes order by name',
    );
    return { items: rows, total: rows.length };
  });
}
