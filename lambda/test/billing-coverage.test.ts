import { describe, expect, it } from 'vitest';
import { reconciliationTotals, type SpendRow } from '../src/cur-reconciler/totals.js';
import { computeCost, type PricingRow } from '../src/shared/pricing.js';
import { videoBillingOf, type VideoLog } from '../src/shared/video-billing.js';

const account = '111122223333';
const otherAccount = '444455556666';
const principal = `principal#arn:aws:iam::${account}:role/Video`;
const arn = 'arn:aws:bedrock:us-west-2::foundation-model/luma.ray-v2:0';
const target = 'model#luma.ray-v2:0';
const pool = `account-model#${account}/luma.ray-v2:0`;
const log: VideoLog = {
  modelId: arn, status: 'Completed',
  output: {
    outputVideoDurationSeconds: 4.75, outputVideoWidth: 1024,
    outputVideoHeight: 1024, outputVideoFramesPerSecond: 24,
  },
};
const pricing: PricingRow = {
  dimensions: { outputVideoSeconds: { unit: 'Second', pricePerUnit: 0.75 } },
  videoOutputPricing: {
    billingRule: 'luma-ray-v2',
    regionRates: { 'us-west-2': {
      Standard: { unit: 'Second', pricePerUnit: 0.75 },
      HD: { unit: 'Second', pricePerUnit: 1.5 },
    } },
  },
};

describe('Luma billing evidence', () => {
  it('prices the verified metadata signature at five HD seconds and preserves observed usage', () => {
    const result = computeCost(pricing, 'us-west-2', { outputVideoSeconds: 4.75 },
      undefined, undefined, 'default', videoBillingOf(log));
    expect(result.spendUsd).toBe(7.5);
    expect(result.dimensionsUsage.outputVideoSeconds).toBe(4.75);
    expect(result.priced).toBe(true);
  });
  it('uses explicit generation settings for Standard and nine-second clips', () => {
    const billing = videoBillingOf({ ...log, input: { inputBodyJson: { resolution: '540p', duration: '9s' } } });
    expect(computeCost(pricing, 'us-west-2', { outputVideoSeconds: 8.75 },
      undefined, undefined, 'default', billing).spendUsd).toBe(6.75);
  });
  it('applies the account discount to the actual resolution and billable duration', () => {
    expect(computeCost(pricing, 'us-west-2', { outputVideoSeconds: 4.75 },
      20, undefined, 'default', videoBillingOf(log)).spendUsd).toBe(6);
  });
  it.each([
    { ...log, output: { ...log.output, outputVideoWidth: 800 } },
    { ...log, output: { ...log.output, outputVideoFramesPerSecond: 30 } },
    { ...log, output: { ...log.output, outputVideoDurationSeconds: 4.2 } },
    { ...log, status: 'Failed' },
    { ...log, errorCode: 'ValidationException' },
    { ...log, input: { inputBodyJson: { resolution: '4k', duration: '5s' } } },
  ])('leaves unverified metadata unpriced (%j)', (unknown) => {
    const cost = computeCost(pricing, 'us-west-2', { outputVideoSeconds: 4.75 },
      undefined, undefined, 'default', videoBillingOf(unknown));
    expect(cost.priced).toBe(false);
    expect(cost.missingDimensions).toEqual(['outputVideoSeconds']);
    expect(cost.spendUsd).toBe(0);
  });
  it('does not borrow an unsupported region rate or modify other video providers', () => {
    expect(computeCost(pricing, 'us-east-1', { outputVideoSeconds: 4.75 },
      undefined, undefined, 'default', videoBillingOf(log)).priced).toBe(false);
    expect(videoBillingOf({ ...log, modelId: 'amazon.nova-reel-v1:1' })).toBeUndefined();
    expect(computeCost({ dimensions: pricing.dimensions }, 'us-west-2',
      { outputVideoSeconds: 4.75 }).spendUsd).toBe(3.5625);
  });
});

describe('CUR without caller attribution', () => {
  it('compares anonymous model charges at account/model scope, retaining other principal spend', () => {
    const result = reconciliationTotals([
      { account, target: arn, spend: 195 },
      { account, principal: principal.slice(10), spend: 10 },
    ], [
      { principal, target, spend: 180 },
      { principal: principal.replace('Video', 'Admin'), target, spend: 15 },
      { principal, target: 'model#openai.gpt-5.6-sol', spend: 12 },
    ]);
    expect(result.curTotals.get(pool)).toBe(195);
    expect(result.meterTotals.get(pool)).toBe(195);
    expect(result.curTotals.get(principal)).toBe(10);
    expect(result.meterTotals.get(principal)).toBe(12);
    expect(result.unattributedSpend).toBe(195);
    expect(result.pooledModels).toEqual([pool]);
  });
  it('pools both attributed and anonymous rows for the model without double counting', () => {
    const result = reconciliationTotals([
      { account, target: arn, spend: 7.5 },
      { account, principal: principal.slice(10), target: arn, spend: 7.5 },
    ], [{ principal, target, spend: 15 }]);
    expect([...result.curTotals]).toEqual([[pool, 15]]);
    expect([...result.meterTotals]).toEqual([[pool, 15]]);
    expect(result.unattributedSpend).toBe(7.5);
  });
  it('keeps separate accounts separate, even when the model matches', () => {
    const result = reconciliationTotals([{ account, target: arn, spend: 7.5 }], [
      { principal: principal.replace(account, otherAccount), target, spend: 7.5 },
    ]);
    expect(result.meterTotals.has(pool)).toBe(false);
    expect(result.curTotals.get(pool)).toBe(7.5);
  });
  it('retains unidentifiable anonymous charges and treats blank caller strings as missing', () => {
    const result = reconciliationTotals([
      { account, spend: 5 },
      { account, principal: ' ', target: arn, spend: 7.5 },
    ], [{ principal, target, spend: 3.5625 }]);
    expect(result.curTotals.get(`unattributed#${account}`)).toBe(5);
    expect(result.unattributedSpend).toBe(12.5);
    expect(result.curTotals.get(pool)! - result.meterTotals.get(pool)!).toBe(3.9375);
  });
  it('continues aggregating session principals when attribution is complete', () => {
    const cur: SpendRow[] = ['a', 'b'].map((session) => ({
      principal: `arn:aws:sts::${account}:assumed-role/Video/${session}`, target: arn, spend: 7.5,
    }));
    const result = reconciliationTotals(cur, [{ principal, target, spend: 15 }]);
    expect(result.pooledModels).toEqual([]);
    expect([...result.curTotals]).toEqual([[principal, 15]]);
  });
});
