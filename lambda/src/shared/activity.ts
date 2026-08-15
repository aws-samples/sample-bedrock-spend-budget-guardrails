import { randomUUID } from 'node:crypto';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './ddb.js';
import { accountFromPrincipal } from './iam-cross-account.js';
import { logger } from './powertools.js';

/**
 * per-principal activity log.
 *
 * A durable, per-principal timeline of the events an operator cares about:
 * budget threshold warnings, enforcement applied/released/rolled-over,
 * unenforceable budgets, user lifecycle + metadata changes, and budget
 * changes. Distinct from the admin AUDIT trail (emitAudit): audit answers
 * "which operator changed what" globally over ~24h of logs; this answers
 * "what has happened to THIS principal over time" and is stored durably in
 * the PrincipalActivity table (PK=principal, SK=`ts#<iso>#<ulid>`, ~1yr TTL).
 *
 * Best-effort: a write failure is logged and swallowed — recording activity
 * must never break the metering/enforcement/admin path that triggered it.
 */
export type ActivityType =
  // user lifecycle + metadata (api/users)
  | 'user.created'
  | 'user.deleted'
  | 'user.disabled'
  | 'user.enabled'
  | 'user.metadata_changed'
  | 'user.groups_changed'
  | 'user.password_reset'
  // budget changes (api/budgets)
  | 'budget.created'
  | 'budget.updated'
  | 'budget.deleted'
  | 'budget.toggled'
  | 'budget.released'
  // enforcement lifecycle (enforcement, period-rollover)
  | 'threshold.warning'
  | 'enforcement.applied'
  | 'enforcement.released'
  | 'enforcement.rolled_over'
  | 'enforcement.unattachable'
  // notifications (notify)
  | 'notification.sent'
  | 'notification.failed';

export interface ActivityEvent {
  /** Canonical principal key (`principal#...`) the event is about. */
  readonly principal: string;
  readonly type: ActivityType;
  /** One-line human summary rendered in the UI timeline. */
  readonly summary: string;
  /** Optional structured detail (amounts, target, actor, etc.). No secrets. */
  readonly detail?: Record<string, unknown>;
  /** Acting operator (for admin-initiated events); omit for system events. */
  readonly actor?: { sub?: string; email?: string };
}

const ACTIVITY_TABLE = process.env.PRINCIPAL_ACTIVITY_TABLE;
/** Retention for activity rows. 1 year (in seconds). */
const ACTIVITY_TTL_SECONDS = 365 * 24 * 60 * 60;

/**
 * Record one activity event for a principal. No-op (with a debug log) when
 * `PRINCIPAL_ACTIVITY_TABLE` isn't configured, so callers can invoke it
 * unconditionally. Never throws.
 */
export const recordActivity = async (event: ActivityEvent): Promise<void> => {
  if (!ACTIVITY_TABLE) {
    logger.debug('recordActivity skipped — PRINCIPAL_ACTIVITY_TABLE unset', { type: event.type });
    return;
  }
  if (!event.principal) return;
  const now = new Date();
  const iso = now.toISOString();
  // SK sorts reverse-chronologically under Query(ScanIndexForward=false).
  // The uuid suffix disambiguates events written in the same millisecond.
  const sk = `ts#${iso}#${randomUUID()}`;
  // byDay GSI partition key (UTC day). Feeds the central /admin/activity view.
  const bucket = `day#${iso.slice(0, 10)}`;
  // Sparse attribute: only ARN principals resolve to an account. Written now so
  // a future per-account-scoped feed is a pure infra change (no second backfill).
  const accountId = accountFromPrincipal(event.principal);
  try {
    await ddb.send(
      new PutCommand({
        TableName: ACTIVITY_TABLE,
        Item: {
          principal: event.principal,
          sk,
          bucket,
          ts: iso,
          type: event.type,
          summary: event.summary,
          detail: event.detail ?? {},
          ...(event.actor ? { actor: event.actor } : {}),
          ...(accountId ? { accountId } : {}),
          ttl: Math.floor(now.getTime() / 1000) + ACTIVITY_TTL_SECONDS,
        },
      }),
    );
  } catch (err) {
    logger.warn('recordActivity write failed', {
      principal: event.principal,
      type: event.type,
      err: (err as Error).message,
    });
  }
};
