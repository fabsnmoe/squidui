import { redactAuditPayload, type AuditAction, type AuditOutcome } from '@scp/shared';
import type { Db } from '../db/pool.js';

/**
 * The single place audit events are written.
 *
 * Every payload passes through `redactAuditPayload`, so a caller that
 * accidentally hands over a password object still cannot persist it
 * (PLAN.md 9.21).
 */

export interface AuditActor {
  id: string | null;
  username: string | null;
  sourceIp: string | null;
}

export interface AuditInput {
  action: AuditAction;
  outcome?: AuditOutcome;
  actor: AuditActor;
  targetType?: string | null;
  targetId?: string | null;
  targetName?: string | null;
  payload?: Record<string, unknown>;
}

export async function recordAudit(db: Db, input: AuditInput): Promise<void> {
  const payload = redactAuditPayload(input.payload ?? {}) as Record<string, unknown>;
  await db.query(
    `insert into audit_events
       (action, outcome, actor_id, actor_username, target_type, target_id, target_name, source_ip, payload)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
    [
      input.action,
      input.outcome ?? 'SUCCESS',
      input.actor.id,
      input.actor.username,
      input.targetType ?? null,
      input.targetId ?? null,
      input.targetName ?? null,
      input.actor.sourceIp,
      JSON.stringify(payload),
    ],
  );
}

export interface AuditQuery {
  limit: number;
  offset: number;
  action?: string;
  actor?: string;
  outcome?: string;
}

export async function listAuditEvents(
  db: Db,
  query: AuditQuery,
): Promise<{ items: unknown[]; total: number }> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (query.action) {
    params.push(query.action);
    conditions.push(`action = $${params.length}`);
  }
  if (query.actor) {
    params.push(`%${query.actor}%`);
    conditions.push(`actor_username ilike $${params.length}`);
  }
  if (query.outcome) {
    params.push(query.outcome);
    conditions.push(`outcome = $${params.length}`);
  }
  const where = conditions.length > 0 ? `where ${conditions.join(' and ')}` : '';

  const { rows: countRows } = await db.query<{ count: string }>(
    `select count(*)::text as count from audit_events ${where}`,
    params,
  );

  params.push(query.limit);
  const limitIndex = params.length;
  params.push(query.offset);
  const offsetIndex = params.length;

  const { rows } = await db.query(
    `select id::text as id, occurred_at, action, outcome, actor_id, actor_username,
            target_type, target_id, target_name, source_ip, payload
     from audit_events
     ${where}
     order by occurred_at desc, id desc
     limit $${limitIndex} offset $${offsetIndex}`,
    params,
  );

  return { items: rows, total: Number(countRows[0]?.count ?? '0') };
}
