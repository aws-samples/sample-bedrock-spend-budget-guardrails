import { describe, expect, it } from 'vitest';
import { correctionIdFor, correctionTransaction, type SpendCorrection } from '../src/shared/spend-corrections.js';

const correction = (): SpendCorrection => {
  const c = {
    effectiveAt: '2026-09-01T00:00:00Z',
    changes: [{
      principal: 'principal#arn:aws:iam::111122223333:role/Example',
      sk: 'period#2026-09#target#model#openai.gpt-6-astra',
      target: 'model#openai.gpt-6-astra', period: '2026-09', region: 'us-west-2',
      spendUsd: 0.1, costs: { inputTokens: 0.1 }, requestIds: ['request-1'],
      alreadyProcessed: true, unpricedDelta: -1,
    }],
    ledger: [{ principal: 'principal#arn:aws:iam::111122223333:role/Example',
      target: 'model#openai.gpt-6-astra', spendUsd: 0.1, effectiveAt: '2026-09-01T00:00:00Z' }],
  };
  return { ...c, id: correctionIdFor(c) };
};

describe('historical spend corrections', () => {
  it('guards both original request membership and correction idempotency without adding tokens again', () => {
    const r = correctionTransaction('prod-bbg-running-spend', correction()).TransactItems![0].Update!;
    expect(r.ConditionExpression).toContain('NOT contains(appliedCorrectionIds, :id)');
    expect(r.ConditionExpression).toContain('contains(processedRequestIds, :rid0)');
    expect(r.ConditionExpression).toContain('unpricedInvocations >= :remaining');
    expect(r.UpdateExpression).not.toContain('processedRequestIds :requests');
    expect(Object.values(r.ExpressionAttributeNames!)).not.toContain('usage_inputTokens');
  });
  it('rejects a changed plan with an old correction ID or duplicate token accumulation', () => {
    const changed = correction(); changed.changes[0].spendUsd = 10;
    expect(() => correctionTransaction('prod-bbg-running-spend', changed)).toThrow();
    const duplicate = correction(); duplicate.changes[0].usage = { inputTokens: 100 };
    duplicate.id = correctionIdFor(duplicate);
    expect(() => correctionTransaction('prod-bbg-running-spend', duplicate)).toThrow('duplicate usage');
  });
  it('atomically moves an unchanged zero-dollar ARN row and guards new request membership', () => {
    const c = correction();
    c.changes[0].alreadyProcessed = false;
    c.changes[0].usage = { outputVideoSeconds: 4.75 };
    c.changes[0].unpricedDelta = undefined;
    c.deleteSource = {
      principal: c.changes[0].principal,
      sk: 'period#2026-09#target#model#arn:aws:bedrock:us-west-2::foundation-model/luma.ray-v2:0',
      lastUpdated: c.effectiveAt, unpricedInvocations: 1, requestIds: ['request-1'],
    };
    c.id = correctionIdFor(c);
    const tx = correctionTransaction('prod-bbg-running-spend', c);
    expect(tx.TransactItems).toHaveLength(2);
    expect(tx.TransactItems![0].Update!.ConditionExpression).toContain('NOT contains(processedRequestIds, :rid0)');
    expect(tx.TransactItems![1].Delete!.ConditionExpression).toContain('spendUsd = :zero');
    expect(tx.TransactItems![1].Delete!.ConditionExpression).toContain('processedRequestIds = :requests');
  });
});
