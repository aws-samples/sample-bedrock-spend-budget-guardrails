import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import type { DimensionKind } from './pricing.js';
import { createHash } from 'node:crypto';

export interface SpendCorrection {
  id: string;
  effectiveAt: string;
  changes: Array<{
    principal: string;
    sk: string;
    target: string;
    period: string;
    region: string;
    spendUsd: number;
    costs: Partial<Record<DimensionKind, number>>;
    /** Only supplied for usage that was never accumulated at this target. */
    usage?: Partial<Record<DimensionKind, number>>;
    requestIds: string[];
    alreadyProcessed: boolean;
    unpricedDelta?: number;
    ttl?: number;
  }>;
  /** Move a legacy zero-dollar ARN target atomically with the canonical update. */
  deleteSource?: {
    principal: string;
    sk: string;
    lastUpdated: string;
    unpricedInvocations: number;
    requestIds: string[];
  };
  /** Primary-model ledger deltas only; profile/lens rows must not duplicate USD. */
  ledger: Array<Record<string, unknown>>;
}

export const correctionIdFor = (c: Omit<SpendCorrection, 'id'>): string =>
  createHash('sha256').update(JSON.stringify({
    effectiveAt: c.effectiveAt, changes: c.changes, deleteSource: c.deleteSource, ledger: c.ledger,
  })).digest('hex').slice(0, 32);

export const correctionTransaction = (
  table: string, correction: SpendCorrection,
): TransactWriteCommandInput => {
  if (!/^[a-zA-Z0-9-]+-bbg-running-spend$/.test(table)
    || correction.id !== correctionIdFor(correction)
    || !Number.isFinite(Date.parse(correction.effectiveAt))
    || correction.changes.length === 0 || correction.changes.length > 90) {
    throw new Error('Invalid correction identity or table');
  }
  const transactItems: NonNullable<TransactWriteCommandInput['TransactItems']> =
    correction.changes.map((c) => {
      if (!Number.isFinite(c.spendUsd) || c.requestIds.length === 0
        || c.sk !== `period#${c.period}#target#${c.target}`
        || !/^(model|profile)#/.test(c.target)
        || (c.alreadyProcessed && c.usage && Object.keys(c.usage).length > 0)) {
        throw new Error('Invalid correction change or duplicate usage');
      }
      const values: Record<string, unknown> = {
        ':id': correction.id, ':ids': new Set([correction.id]),
        ':spend': c.spendUsd, ':period': c.period, ':target': c.target,
        ':time': correction.effectiveAt, ':skip': true,
      };
      const names: Record<string, string> = {};
      const add = ['spendUsd :spend', 'appliedCorrectionIds :ids'];
      let removeUnpriced = '';
      let retention = '';
      const conditions = ['NOT contains(appliedCorrectionIds, :id)'];
      c.requestIds.forEach((id, i) => {
        values[`:rid${i}`] = id;
        conditions.push(`${c.alreadyProcessed ? '' : 'NOT '}contains(processedRequestIds, :rid${i})`);
      });
      const increment = (key: string, n: number): void => {
        if (!Number.isFinite(n)) throw new Error(`Invalid delta for ${key}`);
        const i = Object.keys(names).length;
        names[`#n${i}`] = key;
        values[`:n${i}`] = n;
        add.push(`#n${i} :n${i}`);
      };
      for (const [k, n] of Object.entries(c.costs)) increment(`cost_${k}`, n);
      for (const [k, n] of Object.entries(c.usage ?? {})) increment(`usage_${k}`, n);
      if (!c.alreadyProcessed) {
        values[':requests'] = new Set(c.requestIds);
        add.push('processedRequestIds :requests');
        increment('inputTokens', c.usage?.inputTokens ?? 0);
        increment('outputTokens', c.usage?.outputTokens ?? 0);
      }
      if (c.unpricedDelta) {
        increment('unpricedInvocations', c.unpricedDelta);
        if (c.unpricedDelta < 0) {
          values[':remaining'] = -c.unpricedDelta;
          conditions.push('unpricedInvocations >= :remaining');
          values[':unpricedIds'] = new Set(c.requestIds);
          removeUnpriced = ' DELETE unpricedRequestIds :unpricedIds';
        }
      }
      increment(`region_${c.region.replace(/-/g, '_')}`, c.spendUsd);
      if (c.ttl !== undefined) {
        names['#ttl'] = 'ttl';
        values[':ttl'] = c.ttl;
        retention = ', #ttl = if_not_exists(#ttl, :ttl)';
      }
      return {
        Update: {
          TableName: table, Key: { principal: c.principal, sk: c.sk },
          UpdateExpression: `ADD ${add.join(', ')} SET period = :period, target = :target, lastUpdated = if_not_exists(lastUpdated, :time), lastCorrectionId = :id, lastCorrectionEffectiveAt = :time, lastCorrectionSuppressLedger = :skip${retention}${removeUnpriced}`,
          ConditionExpression: conditions.join(' AND '),
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        },
      };
    });
  if (correction.deleteSource) {
    const s = correction.deleteSource;
    if (!s.sk.includes('#target#model#arn:aws:bedrock:') || !s.sk.includes(':foundation-model/')) {
      throw new Error('Only legacy foundation-model ARN source rows may be removed');
    }
    transactItems.push({
      Delete: {
        TableName: table, Key: { principal: s.principal, sk: s.sk },
        ConditionExpression: 'spendUsd = :zero AND unpricedInvocations = :count AND lastUpdated = :time AND processedRequestIds = :requests',
        ExpressionAttributeValues: {
          ':zero': 0, ':count': s.unpricedInvocations, ':time': s.lastUpdated,
          ':requests': new Set(s.requestIds),
        },
      },
    });
  }
  return { TransactItems: transactItems };
};
