/**
 * Models Bedrock added after the October pricing review: GPT-6.2 Astra,
 * GPT-6.2 Sol, GPT-6.1 Terra, Kimi K3.1 and Claude Haiku 5.5's long-context
 * tier. Rates are from the AWS model cards cited in published-pricing.ts.
 */
import { describe, expect, it } from 'vitest';
import { contextBoundaryFor, publishedPricingFor } from '../src/pricing-refresher/published-pricing.js';
import { computeCost } from '../src/shared/pricing.js';
import { routingModeOf, stripCrisPrefix } from '../src/shared/arn.js';
import { canonicalizeModelId, extractUsage, type BedrockInvocationLog } from '../src/meter/index.js';

const usage = { inputTokens: 1000, cacheWriteTokens: 1000, cacheReadTokens: 1000, outputTokens: 1000 };

describe('November model coverage', () => {
  it.each([
    // model, geo short, global short, geo long per request of 272,001 input tokens
    ['openai.gpt-6.2-astra', 0.06424, 0.0584, 272.001 * 0.0176],
    ['openai.gpt-6.2-sol', 0.01606, 0.0146, 272.001 * 0.0044],
    ['openai.gpt-6.1-terra', 0.00803, 0.0073, 272.001 * 0.0022],
  ])('prices %s at the card rates, including long context', (model, geo, global, long) => {
    const row = publishedPricingFor(String(model));
    expect(row?.sourceUrl).toMatch(/model-card-openai-gpt-6-[12]-(astra|sol|terra)\.html$/);
    expect(row?.verifiedAt).toBe('2026-11-28T00:00:00.000Z');
    expect(computeCost(row, 'us-west-2', usage, 0, 'us').spendUsd).toBeCloseTo(Number(geo), 8);
    expect(computeCost(row, 'us-west-2', usage, 0, 'global').spendUsd).toBeCloseTo(Number(global), 8);
    expect(computeCost(row, 'us-west-2', { inputTokens: 272001 }, 0, 'us').spendUsd)
      .toBeCloseTo(Number(long), 5);
  });

  it('switches GPT-6.2 Astra Ultrafast from the 3x promotion to 6x on 2027-03-01', () => {
    const before = publishedPricingFor('openai.gpt-6.2-astra', 'us-east-1', Date.parse('2027-02-28T23:59:59Z'));
    const after = publishedPricingFor('openai.gpt-6.2-astra', 'us-east-1', Date.parse('2027-03-01T00:00:00Z'));
    expect(before?.serviceTierMultipliers).toEqual({ ultrafast: 3 });
    expect(after?.serviceTierMultipliers).toEqual({ ultrafast: 6 });
    expect(computeCost(before, 'us-east-1', { inputTokens: 1000 }, 0, 'us', 'ultrafast').spendUsd).toBeCloseTo(0.0264, 8);
    // Sol 6.2 and Terra 6.1 document no Ultrafast tier: flag it instead of guessing.
    expect(computeCost(publishedPricingFor('openai.gpt-6.2-sol'), 'us-east-1', usage, 0, 'us', 'ultrafast').priced)
      .toBe(false);
  });

  it('prices Kimi K3.1 for US, India and Global routing and its Priority and Flex tiers', () => {
    const row = publishedPricingFor('moonshotai.kimi-k3.1');
    expect(row?.sourceUrl).toContain('model-card-moonshot-ai-kimi-k3-1-highspeed.html');
    expect(computeCost(row, 'us-west-2', usage, 0, 'us').spendUsd).toBeCloseTo(0.03212, 8);
    expect(computeCost(row, 'ap-south-1', usage, 0, 'in').spendUsd).toBeCloseTo(0.03212, 8);
    expect(computeCost(row, 'eu-west-1', usage, 0, 'global').spendUsd).toBeCloseTo(0.0292, 8);
    expect(computeCost(row, 'us-west-2', { inputTokens: 1000 }, 0, 'us', 'priority').spendUsd).toBeCloseTo(0.0077, 8);
    expect(computeCost(row, 'us-west-2', { inputTokens: 1000 }, 0, 'us', 'flex').spendUsd).toBeCloseTo(0.0022, 8);
    // No long-context tier is published, so none is invented.
    expect(row?.contextTiers).toBeUndefined();
  });

  it('names a reviewed boundary only for reviewed commercial models', () => {
    expect(contextBoundaryFor('anthropic.claude-haiku-5-5')?.minInputTokens).toBe(100001);
    expect(contextBoundaryFor('openai.gpt-6.2-astra')?.minInputTokens).toBe(272001);
    expect(contextBoundaryFor('anthropic.claude-haiku-5-5', 'us-gov-west-1')).toBeUndefined();
    expect(contextBoundaryFor('unknown.future-model')).toBeUndefined();
    // A boundary review is not a price: Haiku rates still come from the catalog.
    expect(publishedPricingFor('anthropic.claude-haiku-5-5')).toBeUndefined();
  });
});

describe('cross-Region inference profile ids', () => {
  it.each([
    ['us.openai.gpt-6.2-astra', 'openai.gpt-6.2-astra', 'us'],
    ['global.openai.gpt-6.2-astra', 'openai.gpt-6.2-astra', 'global'],
    ['us.moonshotai.kimi-k3.1', 'moonshotai.kimi-k3.1', 'us'],
    ['in.moonshotai.kimi-k3.1', 'moonshotai.kimi-k3.1', 'in'],
    ['jp.anthropic.claude-haiku-5-5', 'anthropic.claude-haiku-5-5', 'jp'],
    ['au.anthropic.claude-haiku-5-5', 'anthropic.claude-haiku-5-5', 'au'],
    ['ca.anthropic.claude-haiku-5-5', 'anthropic.claude-haiku-5-5', 'ca'],
    ['us-gov.anthropic.claude-sonnet-4-5-20250929-v1:0', 'anthropic.claude-sonnet-4-5-20250929-v1:0', 'us-gov'],
    ['openai.gpt-6.2-astra', 'openai.gpt-6.2-astra', undefined],
  ])('%s prices as %s with routing %s', (id, base, routing) => {
    expect(stripCrisPrefix(String(id))).toBe(base);
    expect(routingModeOf(String(id))).toBe(routing);
  });

  it('meters a GPT-6.2 Astra Responses record under the bare model and its profile', () => {
    // Live record shape (ids anonymized): the profile ARN is the model id.
    const log: BedrockInvocationLog = {
      schemaType: 'ModelInvocationLog', operation: 'Responses', region: 'us-west-2', requestId: 'r-62',
      modelId: 'arn:aws:bedrock:us-west-2:111122223333:inference-profile/us.openai.gpt-6.2-astra',
      input: { inputTokenCount: 2, cacheReadInputTokenCount: 158000, cacheWriteInputTokenCount: 3300 },
      output: { outputTokenCount: 600 },
    };
    const { modelId, inferenceProfileArn } = canonicalizeModelId(log.modelId!, undefined);
    expect(stripCrisPrefix(modelId)).toBe('openai.gpt-6.2-astra');
    expect(inferenceProfileArn).toBe(log.modelId);
    const cost = computeCost(publishedPricingFor('openai.gpt-6.2-astra'), 'us-west-2', extractUsage(log), 0,
      routingModeOf(modelId));
    expect(cost.priced).toBe(true);
    expect(cost.spendUsd).toBeCloseTo(0.0000176 + 158 * 0.00044 + 3.3 * 0.011 + 0.6 * 0.044, 6);
  });
});
