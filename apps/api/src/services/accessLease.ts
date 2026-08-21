import { recordAudit } from '../audit/sink.js';
import type { Db } from '../db/pool.js';

/**
 * Expiring directory-backed proxy access (ADR 0004).
 *
 * The half of deprovisioning that covers a person who never comes back. A user
 * deleted in the directory cannot sign in, cannot renew, and therefore loses
 * access when their lease runs out - without the control plane ever holding a
 * privileged credential on the directory.
 *
 * Disabled, not deleted: the statistics and the audit trail stay, and a person
 * whose access is restored is one sign-in away from working again.
 */

export async function expireStaleLeases(db: Db): Promise<number> {
  const { rows } = await db.query<{ id: string; username: string; valid_until: Date }>(
    `update proxy_users set status = 'DISABLED', disabled_reason = 'LEASE_EXPIRED', updated_at = now()
     where source = 'OIDC' and status = 'ACTIVE'
       and valid_until is not null and valid_until < now()
     returning id, username, valid_until`,
  );

  for (const row of rows) {
    await recordAudit(db, {
      action: 'PROXY_USER_UPDATED',
      actor: { id: null, username: 'system', sourceIp: null },
      targetType: 'proxy_user',
      targetId: row.id,
      targetName: row.username,
      payload: {
        disabled: true,
        reason: 'LEASE_EXPIRED',
        validUntil: row.valid_until.toISOString(),
      },
    });
  }

  return rows.length;
}
