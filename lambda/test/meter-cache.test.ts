/**
 * an earlier change B1 — end-to-end cache-token metering.
 *
 * The pricing module's multi-dimension test (`pricing-multi-dim.test.ts`)
 * already verifies that cacheReadTokens and cacheWriteTokens contribute to
 * the bill at the right rates given the right inputs. What was missing is
 * a regression test that exercises the FULL meter pipeline:
 *
 *   CWL event (with cacheReadInputTokenCount + cacheWriteInputTokenCount)
 *     → extractUsage (meter Lambda)
 *     → computeCost (pricing module)
 *
 * If extractUsage ever stops mapping the wire-format counters into
 * UsageCounts, this test fails before the meter ships.
 */
import { describe, expect, it } from 'vitest';
import { extractUsage, type BedrockInvocationLog } from '../src/meter/index';
import { computeCost, type PricingRow } from '../src/shared/pricing';

const CLAUDE_HAIKU_PRICING: PricingRow = {
  inputPer1k: 0.003,
  outputPer1k: 0.015,
  cacheReadPer1k: 0.0003, // 10% of input — Anthropic standard cache-read
  cacheWritePer1k: 0.00375, // 1.25× input — Anthropic 5-min cache-write
};

describe('an earlier change B1: end-to-end cache token metering', () => {
  it('extracts cacheReadInputTokenCount and cacheWriteInputTokenCount from a CWL event', () => {
    const log: BedrockInvocationLog = {
      schemaType: 'application/vnd.aws.bedrock.logs.invocation',
      timestamp: '2026-05-25T07:30:00Z',
      region: 'us-east-1',
      requestId: 'cache-fixture-001',
      operation: 'Converse',
      modelId: 'anthropic.claude-haiku-4-5-20251001-v1:0',
      input: {
        inputTokenCount: 100,
        cacheReadInputTokenCount: 1000,
        cacheWriteInputTokenCount: 500,
      },
      output: { outputTokenCount: 50 },
    };

    const usage = extractUsage(log);
    expect(usage.inputTokens).toBe(100);
    expect(usage.outputTokens).toBe(50);
    expect(usage.cacheReadTokens).toBe(1000);
    expect(usage.cacheWriteTokens).toBe(500);
  });

  it('prices cache-read and cache-write as separate dimensions on the spend row', () => {
    const log: BedrockInvocationLog = {
      input: {
        inputTokenCount: 100,
        cacheReadInputTokenCount: 1000,
        cacheWriteInputTokenCount: 500,
      },
      output: { outputTokenCount: 50 },
    };

    const usage = extractUsage(log);
    const cost = computeCost(CLAUDE_HAIKU_PRICING, 'us-east-1', usage);

    expect(cost.priced).toBe(true);
    // input: 100 * 0.003 / 1000 = 0.0003
    expect(cost.dimensionsCost.inputTokens).toBeCloseTo(0.0003, 6);
    // output: 50 * 0.015 / 1000 = 0.00075
    expect(cost.dimensionsCost.outputTokens).toBeCloseTo(0.00075, 6);
    // cacheRead: 1000 * 0.0003 / 1000 = 0.0003
    expect(cost.dimensionsCost.cacheReadTokens).toBeCloseTo(0.0003, 6);
    // cacheWrite: 500 * 0.00375 / 1000 = 0.001875
    expect(cost.dimensionsCost.cacheWriteTokens).toBeCloseTo(0.001875, 6);
    // Total: 0.0003 + 0.00075 + 0.0003 + 0.001875 = 0.003225
    expect(cost.spendUsd).toBeCloseTo(0.003225, 6);
  });

  it('cache-write is ~12.5x more expensive than cache-read at Anthropic 5-min cache rates', () => {
    // Sanity check that the pricing math reflects Anthropic's published ratio.
    // 1.25× input (write) / 0.1× input (read) = 12.5×.
    const log: BedrockInvocationLog = {
      input: {
        cacheReadInputTokenCount: 1000,
        cacheWriteInputTokenCount: 1000,
      },
    };
    const usage = extractUsage(log);
    const cost = computeCost(CLAUDE_HAIKU_PRICING, 'us-east-1', usage);

    const ratio = cost.dimensionsCost.cacheWriteTokens! / cost.dimensionsCost.cacheReadTokens!;
    expect(ratio).toBeCloseTo(12.5, 2);
  });

  it('handles a no-cache invocation cleanly (cache fields absent)', () => {
    const log: BedrockInvocationLog = {
      input: { inputTokenCount: 100 },
      output: { outputTokenCount: 50 },
    };

    const usage = extractUsage(log);
    expect(usage.cacheReadTokens).toBeUndefined();
    expect(usage.cacheWriteTokens).toBeUndefined();

    const cost = computeCost(CLAUDE_HAIKU_PRICING, 'us-east-1', usage);
    expect(cost.dimensionsCost.cacheReadTokens).toBeUndefined();
    expect(cost.dimensionsCost.cacheWriteTokens).toBeUndefined();
  });

  it('skips cache-write pricing when the model has no cacheWritePer1k rate (e.g., model not yet refreshed)', () => {
    const pricingNoCacheWrite: PricingRow = {
      inputPer1k: 0.003,
      outputPer1k: 0.015,
      cacheReadPer1k: 0.0003,
      // cacheWritePer1k intentionally missing
    };
    const log: BedrockInvocationLog = {
      input: {
        inputTokenCount: 100,
        cacheReadInputTokenCount: 1000,
        cacheWriteInputTokenCount: 500,
      },
      output: { outputTokenCount: 50 },
    };
    const usage = extractUsage(log);
    const cost = computeCost(pricingNoCacheWrite, 'us-east-1', usage);

    // cacheRead is priced; cacheWrite is observed but not priced (anyMissing)
    expect(cost.dimensionsUsage.cacheWriteTokens).toBe(500);
    expect(cost.dimensionsCost.cacheWriteTokens).toBeUndefined();
    expect(cost.dimensionsCost.cacheReadTokens).toBeCloseTo(0.0003, 6);
  });
});
