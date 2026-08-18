/**
 * OpenAI-compatible Responses / Chat Completions APIs on `bedrock-runtime`.
 *
 * These are called on the `/openai/v1` paths rather than through the AWS SDKs,
 * and they produce a DIFFERENT record shape than the Bedrock-native operations:
 *
 *   - `operation` is `Responses` (not `Converse`)
 *   - `modelId` is the FULL inference-profile ARN, because in-Region inference
 *     is not available for these models on this endpoint — the caller must name
 *     a `us.` / `global.` cross-Region profile
 *   - the record carries `identity.arn` directly
 *
 * All three were captured from a live call on 2026-08-18. Regression intent:
 * a real Responses record must produce billable usage and a canonical model id,
 * because a prior gap parked these in PendingMeter (1h TTL) and lost the spend
 * once the row expired.
 */
import { describe, expect, it } from 'vitest';
import { extractUsage, type BedrockInvocationLog } from '../src/meter/index';
import { canonicalizeCurPrincipal, stripCrisPrefix } from '../src/shared/arn';
import { computeCost, type PricingRow } from '../src/shared/pricing';

/** Verbatim shape of a live `Responses` invocation-log record (ids anonymized). */
const RESPONSES_LOG: BedrockInvocationLog = {
  schemaType: 'ModelInvocationLog',
  timestamp: '2026-08-18T02:13:36Z',
  region: 'us-west-2',
  inferenceRegion: 'us-east-2',
  requestId: '9762b622-3703-49eb-9e9b-dcce74e8f71e',
  operation: 'Responses',
  modelId:
    'arn:aws:bedrock:us-west-2:111122223333:inference-profile/us.openai.gpt-5.6-sol',
  input: { inputTokenCount: 16 },
  output: { outputTokenCount: 11 },
  identity: {
    arn: 'arn:aws:sts::111122223333:assumed-role/SomeAdminRole/some-session',
  },
};

const GPT_PRICING: PricingRow = { inputPer1k: 0.00125, outputPer1k: 0.01 };

describe('OpenAI Responses API on bedrock-runtime', () => {
  it('extracts billable usage from a Responses record', () => {
    const usage = extractUsage(RESPONSES_LOG);
    expect(usage.inputTokens).toBe(16);
    expect(usage.outputTokens).toBe(11);
    // No cache counters on this record — must not be coerced to NaN.
    expect(usage.cacheReadTokens ?? 0).toBe(0);
    expect(usage.cacheWriteTokens ?? 0).toBe(0);
  });

  it('produces a non-zero cost, so the record is never treated as free', () => {
    const cost = computeCost(GPT_PRICING, 'us-west-2', extractUsage(RESPONSES_LOG));
    expect(cost.spendUsd).toBeGreaterThan(0);
    expect(cost.dimensionsUsage.inputTokens).toBe(16);
    expect(cost.dimensionsUsage.outputTokens).toBe(11);
  });

  it('resolves the profile ARN down to the bare model id for pricing', () => {
    // The meter takes the trailing segment of the profile ARN, then strips the
    // CRIS prefix. `global.` must strip the same way `us.` does.
    const profileId = RESPONSES_LOG.modelId!.split('/').slice(-1)[0];
    expect(profileId).toBe('us.openai.gpt-5.6-sol');
    expect(stripCrisPrefix(profileId)).toBe('openai.gpt-5.6-sol');
    expect(stripCrisPrefix('global.openai.gpt-5.6-sol')).toBe(
      'openai.gpt-5.6-sol',
    );
  });

  it('derives a canonical principal from the log record identity', () => {
    // This is the fallback that keeps spend from being lost when the CloudTrail
    // join misses. It must collapse the STS assumed-role ARN to the base role.
    expect(canonicalizeCurPrincipal(RESPONSES_LOG.identity!.arn!)).toBe(
      'arn:aws:iam::111122223333:role/SomeAdminRole',
    );
  });

  it('handles a Chat Completions record the same way', () => {
    const usage = extractUsage({
      ...RESPONSES_LOG,
      operation: 'ChatCompletions',
      modelId:
        'arn:aws:bedrock:us-west-2:111122223333:inference-profile/global.openai.gpt-5.6-terra',
    });
    expect(usage.inputTokens).toBe(16);
    expect(usage.outputTokens).toBe(11);
  });
});
