import { logger, metrics, MetricUnit } from './powertools.js';
import type { CallerScope } from './api.js';

/**
 * audit trail. Every admin write emits one structured log line
 * + a `CrossAccountWriteAudit` metric (Sum, dimension-free) so the
 * Operations dashboard can surface aggregate write volume per stage.
 *
 * The log line goes to the same Lambda log group as the rest of the
 * handler (cheaper than provisioning a dedicated audit stream and
 * still searchable via CloudWatch Logs Insights). The line is
 * recognizable by `kind: "audit"` and a stable shape so a downstream
 * EventBridge rule can fan it out to S3/SIEM later without changing
 * the producer.
 */
export interface AuditFields {
  /** What's being changed — short verb tag, e.g. `budgets.create`. */
  readonly action: string;
  /** Account ID whose data was touched. Use `'*'` for cross-account
   *  ops the operator scoped via the wildcard. */
  readonly targetAccountId: string;
  /** Free-form detail object — included in the log line as-is. Avoid
   *  putting secrets here. */
  readonly detail?: Record<string, unknown>;
}

interface CallerIdentity {
  readonly sub?: string;
  readonly email?: string;
}

export const emitAudit = (
  identity: CallerIdentity,
  scope: CallerScope,
  fields: AuditFields,
): void => {
  logger.warn('audit', {
    kind: 'audit',
    action: fields.action,
    targetAccountId: fields.targetAccountId,
    // Deliberate audit record of the acting operator's identity. Recording
    // the operator email (alongside the Cognito sub) is intentional so the
    // audit trail attributes each cross-account write to a real person.
    // Consequence: audit logs contain operator email addresses and must be
    // treated and retained as sensitive (PII) — handle/route accordingly.
    operator: { sub: identity.sub, email: identity.email },
    scope: { isWildcard: scope.isWildcard, accounts: scope.accounts },
    detail: fields.detail ?? {},
    ts: new Date().toISOString(),
  });
  metrics.addMetric('CrossAccountWriteAudit', MetricUnit.Count, 1);
};
