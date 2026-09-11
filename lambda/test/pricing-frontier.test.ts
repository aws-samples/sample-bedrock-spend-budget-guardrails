import { describe, expect, it } from 'vitest';
import { publishedPricingFor } from '../src/pricing-refresher/published-pricing.js';
import { computeCost } from '../src/shared/pricing.js';
import { canonicalizeModelId, extractUsage, type BedrockInvocationLog } from '../src/meter/index.js';

describe('published frontier pricing', () => {
  it('bills all four Astra dimensions at the published geo rates', () => {
    const cost = computeCost(publishedPricingFor('openai.gpt-6-astra'), 'us-west-2', {
      inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 1000, cacheWriteTokens: 1000,
    }, undefined, 'us');
    expect(cost.spendUsd).toBeCloseTo(0.08085, 6);
    expect(cost.priced).toBe(true);
  });

  it('switches the whole request to long-context pricing only above 272k, including caches', () => {
    const row = publishedPricingFor('openai.gpt-6-astra');
    const short = computeCost(row, 'us-west-2', {
      inputTokens: 1000, cacheReadTokens: 270000, cacheWriteTokens: 1000, outputTokens: 1000,
    }, undefined, 'global');
    expect(short.spendUsd).toBeCloseTo(0.3425, 6);
    const long = computeCost(row, 'us-west-2', {
      inputTokens: 1001, cacheReadTokens: 270000, cacheWriteTokens: 1000, outputTokens: 1000,
    }, 10, 'global');
    expect(long.spendUsd).toBeCloseTo((0.02002 + 0.54 + 0.025 + 0.075) * 0.9, 6);
    expect(long.priced).toBe(true);
  });

  it.each([
    ['openai.gpt-5.6-sol', 0.03234],
    ['openai.gpt-5.6-terra', 0.01837],
    ['openai.gpt-5.6-luna', 0.001837],
  ])('corrects short geo input, output and cache prices for %s', (model, expected) => {
    expect(computeCost(publishedPricingFor(String(model)), 'us-west-2', {
      inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 1000, cacheWriteTokens: 1000,
    }).spendUsd).toBeCloseTo(Number(expected), 6);
  });

  it('keeps partial pricing gaps visible and honors explicit free prices', () => {
    const result = computeCost({ inputPer1k: 0.01 }, 'us-west-2', { inputTokens: 1000, cacheWriteTokens: 500 });
    expect(result.spendUsd).toBe(0.01);
    expect(result.priced).toBe(false);
    expect(result.missingDimensions).toEqual(['cacheWriteTokens']);
    expect(computeCost({ inputPer1k: 0 }, 'us-west-2', { inputTokens: 100 }).priced).toBe(true);
    expect(computeCost({ inputPer1k: 0.01 }, 'us-west-2', { inputTokens: 100 }, 100).priced).toBe(true);
  });

  it('applies supported service tiers and flags unsupported tiers', () => {
    const row = { inputPer1k: 0.0022, serviceTierMultipliers: { priority: 1.75, flex: 0.5 } };
    expect(computeCost(row, 'us-west-2', { inputTokens: 1000 }, 0, 'us', 'priority').spendUsd).toBe(0.00385);
    expect(computeCost(publishedPricingFor('openai.gpt-6-astra'), 'us-west-2',
      { inputTokens: 1000 }, 0, 'us', 'priority').priced).toBe(false);
  });
});

describe('media invocation metadata', () => {
  // Production metadata shape, with identity/request identifiers anonymized.
  const image: BedrockInvocationLog = {
    schemaType: 'ModelInvocationLog', operation: 'InvokeModel', requestId: 'image-request',
    modelId: 'arn:aws:bedrock:us-east-1:111122223333:inference-profile/us.stability.stable-image-control-structure-v1:0',
    input: { inputContentType: 'application/json' },
    output: { outputContentType: 'application/json' },
  };
  it('uses one generation for the known synchronous image API and the actual feature price', () => {
    expect(extractUsage(image).outputImages).toBe(1);
    expect(computeCost(publishedPricingFor('stability.stable-image-control-structure-v1:0'),
      'us-east-1', extractUsage(image)).spendUsd).toBe(0.07);
    expect(computeCost(publishedPricingFor('stability.stable-creative-upscale-v1:0'),
      'us-east-1', { outputImages: 1 }).spendUsd).toBe(0.6);
  });
  it('never invents usage for errors, explicit zero counts, unknown models, or streaming starts', () => {
    expect(extractUsage({ ...image, errorCode: 'ValidationException' }).outputImages).toBeUndefined();
    expect(extractUsage({ ...image, output: { ...image.output, outputImagesCount: 0 } }).outputImages).toBe(0);
    expect(extractUsage({ ...image, modelId: 'unknown.image-model' }).outputImages).toBeUndefined();
    expect(extractUsage({ ...image, operation: 'ConverseStream' }).outputImages).toBeUndefined();
  });
  it('normalizes a Luma foundation-model ARN without inventing an inference profile', () => {
    expect(canonicalizeModelId('arn:aws:bedrock:us-west-2::foundation-model/luma.ray-v2:0', undefined))
      .toEqual({ modelId: 'luma.ray-v2:0', inferenceProfileArn: undefined });
    expect(extractUsage({ output: { outputVideoDurationSeconds: 4.75 } }).outputVideoSeconds).toBe(4.75);
  });
});
