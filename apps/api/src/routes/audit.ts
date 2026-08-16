import type { FastifyInstance } from 'fastify';
import { AUDIT_ACTIONS } from '@scp/shared';
import { listAuditEvents } from '../audit/sink.js';
import { requirePermission } from '../http/context.js';
import type { AppContext } from '../server.js';

/** Read-only audit log. There is deliberately no write or delete endpoint. */

export async function registerAuditRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  app.get('/audit-events', async (request) => {
    requirePermission(request, 'AUDIT_READ');
    const query = request.query as
      | { limit?: string; offset?: string; action?: string; actor?: string; outcome?: string }
      | undefined;

    const limit = Math.min(Math.max(Number(query?.limit ?? 50) || 50, 1), 200);
    const offset = Math.max(Number(query?.offset ?? 0) || 0, 0);

    const result = await listAuditEvents(context.db, {
      limit,
      offset,
      ...(query?.action ? { action: query.action } : {}),
      ...(query?.actor ? { actor: query.actor } : {}),
      ...(query?.outcome ? { outcome: query.outcome } : {}),
    });

    return { ...result, limit, offset, actions: AUDIT_ACTIONS };
  });
}
