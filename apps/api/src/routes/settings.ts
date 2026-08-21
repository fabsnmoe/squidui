import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { recordAudit } from '../audit/sink.js';
import { actorOf, badRequest, requirePermission } from '../http/context.js';
import {
  accessLeasePolicy,
  getSetting,
  setSetting,
  DEFAULT_STATISTICS_FINE_DAYS,
  DEFAULT_STATISTICS_RETENTION_DAYS,
  SETTING_OIDC_LEASE_DAYS,
  SETTING_STATISTICS_FINE_DAYS,
  SETTING_STATISTICS_RETENTION_DAYS,
  SETTING_OIDC_RENEWAL_WINDOW_DAYS,
  SETTING_TRAFFIC_LOG_URLS,
} from '../services/settings.js';
import type { AppContext } from '../server.js';

/** System -> Settings. Runtime configuration an operator may change. */

const patchSchema = z.object({
  trafficLogUrls: z.boolean().optional(),
  // One day is the shortest lease that still means anything; a year is the
  // longest that can still be called deprovisioning.
  leaseDays: z.number().int().min(1).max(365).optional(),
  // Zero is "keep indefinitely", which is why the floor is not one.
  statisticsRetentionDays: z.number().int().min(0).max(3650).optional(),
  statisticsFineWindowDays: z.number().int().min(0).max(365).optional(),
  renewalWindowDays: z.number().int().min(0).max(365).optional(),
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
      // Directory-backed proxy access is a lease that only a sign-in renews
      // (ADR 0004). Both numbers are operator decisions, not constants.
      accessLease: await accessLeasePolicy(db),
      statistics: {
        retentionDays: await getSetting(db, SETTING_STATISTICS_RETENTION_DAYS, DEFAULT_STATISTICS_RETENTION_DAYS),
        fineWindowDays: await getSetting(db, SETTING_STATISTICS_FINE_DAYS, DEFAULT_STATISTICS_FINE_DAYS),
        fineBucketMinutes: 5,
        // Shown together so nobody has to guess which window governs which
        // number on the statistics page.
        rawRetentionDays: config.traffic.retentionDays,
        rawRetentionConfigurableAt: 'TRAFFIC_LOG_RETENTION_DAYS',
      },
      build: config.build,
    };
  });

  app.patch('/settings', async (request) => {
    const principal = requirePermission(request, 'SETTINGS_MANAGE');
    const parsed = patchSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Invalid settings payload.', parsed.error.issues);

    for (const [field, key, label] of [
      ['leaseDays', SETTING_OIDC_LEASE_DAYS, 'Directory access: lease length'],
      ['renewalWindowDays', SETTING_OIDC_RENEWAL_WINDOW_DAYS, 'Directory access: renewal window'],
    ] as const) {
      const value = parsed.data[field];
      if (value === undefined) continue;
      const previous = (await accessLeasePolicy(db))[field];
      await setSetting(db, key, value, principal.username);
      // Shortening a lease revokes access sooner for everyone; that belongs in
      // the audit trail with both values.
      await recordAudit(db, {
        action: 'SETTINGS_UPDATED',
        actor: actorOf(request),
        targetType: 'setting',
        targetId: key,
        targetName: label,
        payload: { from: previous, to: value },
      });
    }

    if (parsed.data.statisticsRetentionDays !== undefined) {
      const previous = await getSetting(
        db,
        SETTING_STATISTICS_RETENTION_DAYS,
        DEFAULT_STATISTICS_RETENTION_DAYS,
      );
      await setSetting(db, SETTING_STATISTICS_RETENTION_DAYS, parsed.data.statisticsRetentionDays, principal.username);
      // Lowering this deletes history at the next ingest and cannot be undone,
      // so both values go into the audit trail.
      await recordAudit(db, {
        action: 'SETTINGS_UPDATED',
        actor: actorOf(request),
        targetType: 'setting',
        targetId: SETTING_STATISTICS_RETENTION_DAYS,
        targetName: 'Statistics retention',
        payload: { from: previous, to: parsed.data.statisticsRetentionDays },
      });
    }

    if (parsed.data.statisticsFineWindowDays !== undefined) {
      const previous = await getSetting(db, SETTING_STATISTICS_FINE_DAYS, DEFAULT_STATISTICS_FINE_DAYS);
      await setSetting(db, SETTING_STATISTICS_FINE_DAYS, parsed.data.statisticsFineWindowDays, principal.username);
      // Shortening this folds detail away at the next compaction; the counters
      // survive, the resolution does not.
      await recordAudit(db, {
        action: 'SETTINGS_UPDATED',
        actor: actorOf(request),
        targetType: 'setting',
        targetId: SETTING_STATISTICS_FINE_DAYS,
        targetName: 'Statistics: fine resolution window',
        payload: { from: previous, to: parsed.data.statisticsFineWindowDays },
      });
    }

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
