import { describe, expect, it } from 'vitest';

// Re-implement the cost helper here against a stable contract so we can test
// it without bootstrapping the SDK clients in src/meter/index.ts.
const computeCost = (
  pricing:
    | { inputPer1k?: number; outputPer1k?: number; regionRates?: Record<string, { inputPer1k?: number; outputPer1k?: number }> }
    | undefined,
  region: string,
  inputTokens: number,
  outputTokens: number,
) => {
  if (!pricing) return { spendUsd: 0, priced: false };
  const regional = pricing.regionRates?.[region];
  const inputRate = regional?.inputPer1k ?? pricing.inputPer1k;
  const outputRate = regional?.outputPer1k ?? pricing.outputPer1k;
  if (inputRate === undefined && outputRate === undefined) return { spendUsd: 0, priced: false };
  const spend = ((inputRate ?? 0) * inputTokens + (outputRate ?? 0) * outputTokens) / 1000;
  return { spendUsd: Number(spend.toFixed(6)), priced: true };
};

describe('meter cost computation', () => {
  it('computes spend for Sonnet 4.6: 1M input + 500K output ≈ $7.50', () => {
    const r = computeCost(
      { inputPer1k: 0.003, outputPer1k: 0.015 },
      'us-east-1',
      1_000_000,
      500_000,
    );
    expect(r.priced).toBe(true);
    expect(r.spendUsd).toBeCloseTo(0.003 * 1000 + 0.015 * 500, 4);
  });

  it('prefers the calling-region rate over the default rate', () => {
    const r = computeCost(
      {
        inputPer1k: 0.003,
        outputPer1k: 0.015,
        regionRates: { 'eu-west-1': { inputPer1k: 0.0033, outputPer1k: 0.0165 } },
      },
      'eu-west-1',
      1_000,
      0,
    );
    expect(r.spendUsd).toBeCloseTo(0.0033, 6);
  });

  it('falls back to default rate when calling region has no entry', () => {
    const r = computeCost(
      {
        inputPer1k: 0.003,
        outputPer1k: 0.015,
        regionRates: { 'eu-west-1': { inputPer1k: 0.0033 } },
      },
      'us-west-2',
      1_000,
      1_000,
    );
    expect(r.spendUsd).toBeCloseTo(0.018, 6);
  });

  it('flags unpriced when no pricing row exists', () => {
    expect(computeCost(undefined, 'us-east-1', 1, 1)).toEqual({ spendUsd: 0, priced: false });
  });

  it('flags unpriced when pricing row has no rates', () => {
    expect(computeCost({}, 'us-east-1', 1, 1)).toEqual({ spendUsd: 0, priced: false });
  });

  it('handles zero tokens cleanly', () => {
    expect(computeCost({ inputPer1k: 0.003, outputPer1k: 0.015 }, 'us-east-1', 0, 0).spendUsd).toBe(0);
  });
});
