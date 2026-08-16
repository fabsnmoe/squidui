import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { recordAudit } from '../audit/sink.js';
import { actorOf, badRequest, requirePermission } from '../http/context.js';
import { getSetting, setSetting, SETTING_TRAFFIC_LOG_URLS } from '../services/settings.js';
import type { AppContext } from '../server.js';

/** System -> Settings. Runtime configuration an operator may change. */

const patchSchema = z.object({
  trafficLogUrls: z.boolean().optional(),
});

export async function registerSettingsRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  const { db, config } = context;

  app.get('/settings', async (request) => {
    requirePermission(request, 'SETTINGS_READ');
    const trafficLogUrls = await getSetting(db, SETTING_TRAFFIC_LOG_URLS, config.traffic.logUrls);

    return {
      traffic: {
        logUrls: trafficLogUrls,
        // Retention stays deployment configuration: changing it at runtime
        // would silently delete data an operator may be required to keep.
        retentionDays: config.traffic.retentionDays,
        retentionConfigurableAt: 'TRAFFIC_LOG_RETENTION_DAYS',
      },
      build: config.build,
    };
  });

  app.patch('/settings', async (request) => {
    const principal = requirePermission(request, 'SETTINGS_MANAGE');
    const parsed = patchSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Invalid settings payload.', parsed.error.issues);

    if (parsed.data.trafficLogUrls !== undefined) {
      const previous = await getSetting(db, SETTING_TRAFFIC_LOG_URLS, config.traffic.logUrls);
      await setSetting(db, SETTING_TRAFFIC_LOG_URLS, parsed.data.trafficLogUrls, principal.username);

      // Turning this on materially changes what is stored about people, so the
      // change is audited with both the old and the new value.
      await recordAudit(db, {
        action: 'SETTINGS_UPDATED',
        actor: actorOf(request),
        targetType: 'setting',
        targetId: SETTING_TRAFFIC_LOG_URLS,
        targetName: 'Traffic logging: full URLs',
        payload: { from: previous, to: parsed.data.trafficLogUrls },
      });
    }

    return { ok: true };
  });
}
