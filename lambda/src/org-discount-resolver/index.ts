import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { DescribeOrganizationCommand, OrganizationsClient } from '@aws-sdk/client-organizations';
import {
  type DiscountPolicies,
  discountKey,
  parseDiscountKey,
  resolveEffectiveDiscount,
} from '../shared/discounts.js';
import { walkOrgTree } from '../shared/org-tree.js';
import { logger, metrics, MetricUnit } from '../shared/powertools.js';

const PRICING_TABLE = process.env.PRICING_TABLE!;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
// Organizations is a global service, addressed in us-east-1.
const organizations = new OrganizationsClient({ region: 'us-east-1' });

/**
 * Read every authored discount row from the Pricing table and split by scope.
 * (account rows may ALSO carry a materialized `effectivePct` from a prior run;
 * the authored value is `discountPct` — we only read that here.)
 */
const loadPolicies = async (): Promise<{
  policies: DiscountPolicies;
  accountRowsWithMaterialized: string[];
}> => {
  const byAccount = new Map<string, number>();
  const byOu = new Map<string, number>();
  let org: number | undefined;
  const accountRowsWithMaterialized: string[] = [];

  let cursor: Record<string, unknown> | undefined;
  do {
    const r = await ddb.send(
      new ScanCommand({
        TableName: PRICING_TABLE,
        // Only discount rows. `model` begins with the reserved prefix.
        FilterExpression: 'begins_with(#m, :p)',
        ExpressionAttributeNames: { '#m': 'model' },
        ExpressionAttributeValues: { ':p': 'discount#' },
        ProjectionExpression: '#m, discountPct, effectivePct',
        ExclusiveStartKey: cursor,
      }),
    );
    for (const item of r.Items ?? []) {
      const key = item.model as string;
      const parsed = parseDiscountKey(key);
      if (!parsed) continue;
      const authored = item.discountPct;
      if (parsed.scope === 'account') {
        if (typeof authored === 'number') byAccount.set(parsed.scopeId, authored);
        // Track account rows that currently carry a materialized value, so we
        // can clear stale ones whose winning scope disappeared.
        if (item.effectivePct !== undefined) accountRowsWithMaterialized.push(parsed.scopeId);
      } else if (parsed.scope === 'ou') {
        if (typeof authored === 'number') byOu.set(parsed.scopeId, authored);
      } else if (parsed.scope === 'org') {
        if (typeof authored === 'number') org = authored;
      }
    }
    cursor = r.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (cursor);

  return { policies: { byAccount, byOu, org }, accountRowsWithMaterialized };
};

/** Materialize (or clear) the effective discount on one account's row. Uses a
 *  bare Update so it creates the account row if it doesn't exist yet (an OU/org
 *  discount applies to accounts that have no authored per-account row). */
const materialize = async (
  accountId: string,
  effective: { pct: number; scope: string; scopeId: string } | undefined,
): Promise<void> => {
  if (effective) {
    await ddb.send(
      new UpdateCommand({
        TableName: PRICING_TABLE,
        Key: { model: discountKey('account', accountId) },
        UpdateExpression:
          'SET effectivePct = :p, effectiveScope = :s, effectiveScopeId = :sid, effectiveResolvedAt = :t',
        ExpressionAttributeValues: {
          ':p': effective.pct,
          ':s': effective.scope,
          ':sid': effective.scopeId,
          ':t': new Date().toISOString(),
        },
      }),
    );
  } else {
    // No effective discount → strip any stale materialized fields. Leaves an
    // authored `discountPct` (if any) untouched.
    await ddb.send(
      new UpdateCommand({
        TableName: PRICING_TABLE,
        Key: { model: discountKey('account', accountId) },
        UpdateExpression: 'REMOVE effectivePct, effectiveScope, effectiveScopeId, effectiveResolvedAt',
      }),
    );
  }
};

/**
 * Resolve hierarchical (org/OU/account) discounts and materialize the winning
 * effective percentage onto each account's `discount#<accountId>` row so the
 * meter (hot path) reads it with its existing single cached GetItem.
 *
 * Runs hourly + on every operator write. When Organizations is denied (BBG not
 * deployed in the management account) it DEGRADES: logs, emits
 * `OrgDiscountResolverDegraded` (alarmed — see observability-stack), and returns
 * WITHOUT touching any row. Consequence to understand: any `effectivePct`
 * materialized by a PRIOR successful run (while access existed) STAYS in place
 * and keeps applying — we deliberately do NOT mass-clear on a transient denial
 * (that would nuke every org/OU discount on one throttle). So on a permanent
 * loss of Organizations access, previously-resolved OU/org discounts persist at
 * their last value until an operator re-authors them; the alarm makes this
 * visible. Newly-authored account-scope discounts still take effect immediately
 * (the meter falls back to the authored `discountPct`). Best-effort per account;
 * a single failed write is counted (OrgDiscountResolverWriteFailures), not fatal.
 */
export const handler = async (): Promise<{ resolved: number; degraded: boolean }> => {
  const { policies, accountRowsWithMaterialized } = await loadPolicies();

  const hasHierarchical = policies.byOu.size > 0 || policies.org !== undefined;
  if (!hasHierarchical) {
    // Nothing but account-scoped discounts (or none). Clear any leftover
    // materialized fields from a previous hierarchical config so the meter
    // falls back to authored per-account values, then exit without touching
    // Organizations at all.
    for (const accountId of accountRowsWithMaterialized) {
      await materialize(accountId, undefined).catch((err) =>
        logger.warn('clear materialized failed', { accountId, err: (err as Error).message }),
      );
    }
    logger.info('org-discount-resolver: no OU/org policies; nothing to materialize', {
      cleared: accountRowsWithMaterialized.length,
    });
    return { resolved: 0, degraded: false };
  }

  // We have OU/org policies → we must know the tree. Try to walk it.
  let tree;
  let orgId: string | undefined;
  try {
    tree = await walkOrgTree(organizations);
    orgId = await organizations
      .send(new DescribeOrganizationCommand({}))
      .then((r) => r.Organization?.Id)
      .catch(() => undefined);
  } catch (err) {
    // Not the management account (or Organizations disabled). Degrade: leave
    // account-scoped discounts working; org/OU scopes simply don't apply.
    logger.warn('org-discount-resolver degraded — Organizations unavailable', {
      err: (err as Error).message,
    });
    metrics.addMetric('OrgDiscountResolverDegraded', MetricUnit.Count, 1);
    metrics.publishStoredMetrics();
    return { resolved: 0, degraded: true };
  }

  // Resolve + materialize per account. Also clear accounts that used to have a
  // materialized value but no longer resolve to one.
  const resolvedAccounts = new Set<string>();
  let resolved = 0;
  let writeFailures = 0;
  for (const acct of tree.accounts) {
    const effective = resolveEffectiveDiscount(acct.id, acct.ouPath, policies, orgId);
    if (effective) {
      resolvedAccounts.add(acct.id);
      try {
        await materialize(acct.id, effective);
        resolved += 1; // count only ACTUAL successful writes
      } catch (err) {
        writeFailures += 1;
        logger.warn('materialize failed', { accountId: acct.id, err: (err as Error).message });
      }
    }
  }
  // Clear stale materializations (winning scope removed, or account left the org).
  for (const accountId of accountRowsWithMaterialized) {
    if (!resolvedAccounts.has(accountId)) {
      try {
        await materialize(accountId, undefined);
      } catch (err) {
        writeFailures += 1;
        logger.warn('clear materialized failed', { accountId, err: (err as Error).message });
      }
    }
  }

  metrics.addMetric('OrgDiscountResolved', MetricUnit.Count, resolved);
  // Surfaces materialize/clear write failures so a partial run (some accounts
  // left on a stale effectivePct) is observable, not silent.
  metrics.addMetric('OrgDiscountResolverWriteFailures', MetricUnit.Count, writeFailures);
  metrics.publishStoredMetrics();
  logger.info('org-discount-resolver complete', {
    accounts: tree.accounts.length,
    ous: tree.ous.length,
    resolved,
  });
  return { resolved, degraded: false };
};
