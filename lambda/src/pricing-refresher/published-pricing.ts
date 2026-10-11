import type { Dimension, DimensionKind, PricingRow } from '../shared/pricing.js';

/**
 * Reviewed AWS website fallbacks for prices absent from the commercial Price
 * List. Dates describe verification, not an assertion about historical rates.
 * Never refresh verifiedAt just because the scheduled Lambda ran.
 */
export interface PublishedPricing extends PricingRow {
  sourceUrl: string;
  verifiedAt: string;
}

type Rates = [input: number, write: number | undefined, read: number, output: number];
const tokenDimensions = (rates: Rates): Partial<Record<DimensionKind, Dimension>> =>
  Object.fromEntries(
    (['inputTokens', 'cacheWriteTokens', 'cacheReadTokens', 'outputTokens'] as const)
      .flatMap((kind, i) => {
        const rate = rates[i];
        return rate === undefined ? [] : [[kind, { unit: '1K tokens', pricePerUnit: rate / 1000 }]];
      }),
  );

const VERIFIED_AT = '2026-10-11T00:00:00.000Z';
const OPENAI: Record<string, {
  card: string; geo: Rates; global?: Rates; serviceTierMultipliers?: Record<string, number>;
}> = {
  'openai.gpt-6-astra': {
    card: 'openai-gpt-6-astra', geo: [11, 13.75, 1.1, 55], global: [10, 12.5, 1, 50],
    serviceTierMultipliers: { ultrafast: 6 },
  },
  'openai.gpt-6.1-sol': {
    // 6.1 cache reads are 5% of input, not GPT-6 Sol's 10%.
    card: 'openai-gpt-6-1-sol', geo: [2.2, 2.75, 0.11, 11], global: [2, 2.5, 0.1, 10],
    serviceTierMultipliers: { ultrafast: 6 },
  },
  'openai.gpt-6-sol': {
    card: 'openai-gpt-6-sol', geo: [2.2, 2.75, 0.22, 11], global: [2, 2.5, 0.2, 10],
  },
  'openai.gpt-6-luna': {
    card: 'openai-gpt-6-luna', geo: [0.11, 0.1375, 0.011, 0.55], global: [0.1, 0.125, 0.01, 0.5],
  },
  'openai.gpt-5.6-sol': {
    card: 'openai-gpt-56-sol', geo: [4.4, 5.5, 0.44, 22], global: [4, 5, 0.4, 20],
  },
  'openai.gpt-5.6-terra': {
    card: 'openai-gpt-56-terra', geo: [2.2, 2.75, 0.22, 13.2], global: [2, 2.5, 0.2, 12],
  },
  'openai.gpt-5.6-luna': {
    card: 'openai-gpt-56-luna', geo: [0.22, 0.275, 0.022, 1.32], global: [0.2, 0.25, 0.02, 1.2],
  },
  // Model discovery includes these Mantle-only models. Price availability does
  // not extend BBG's endpoint coverage. Explicit cache writes are unsupported.
  'openai.gpt-5.5': { card: 'openai-gpt-55', geo: [5.5, undefined, 0.55, 33] },
  'openai.gpt-5.4': { card: 'openai-gpt-54', geo: [2.75, undefined, 0.275, 16.5] },
};

const longRates = (r: Rates): Rates =>
  [r[0] * 2, r[1] === undefined ? undefined : r[1] * 2, r[2] * 2, r[3] * 1.5];

// AWS Bedrock pricing, Stability AI Image Services: price per generation.
export const IMAGE_GENERATION_PRICES: Record<string, number> = {
  'stability.stable-image-remove-background-v1:0': 0.07,
  'stability.stable-image-erase-object-v1:0': 0.07,
  'stability.stable-image-control-structure-v1:0': 0.07,
  'stability.stable-image-control-sketch-v1:0': 0.07,
  'stability.stable-image-style-guide-v1:0': 0.07,
  'stability.stable-image-search-replace-v1:0': 0.07,
  'stability.stable-image-inpaint-v1:0': 0.07,
  'stability.stable-image-search-recolor-v1:0': 0.07,
  'stability.stable-style-transfer-v1:0': 0.08,
  'stability.stable-conservative-upscale-v1:0': 0.40,
  'stability.stable-creative-upscale-v1:0': 0.60,
  'stability.stable-fast-upscale-v1:0': 0.03,
  'stability.stable-outpaint-v1:0': 0.06,
};

export const publishedPricingFor = (modelId: string, region?: string): PublishedPricing | undefined => {
  // This registry reviews commercial pricing. Never export those rates into a
  // different partition whose availability, premiums, and tier support differ.
  if (region && /^(?:us-(?:gov|iso)|cn-|eusc-)/.test(region)) return undefined;
  const imagePrice = IMAGE_GENERATION_PRICES[modelId];
  if (imagePrice !== undefined) return {
    sourceUrl: 'https://aws.amazon.com/bedrock/pricing/',
    verifiedAt: VERIFIED_AT,
    dimensions: { outputImages: { unit: 'image', pricePerUnit: imagePrice } },
  };
  if (modelId === 'zai.glm-5.3') return {
    sourceUrl: 'https://aws.amazon.com/bedrock/pricing/',
    verifiedAt: VERIFIED_AT,
    dimensions: tokenDimensions([1.848, 2.31, 0.3432, 5.808]),
    routingDimensions: { global: tokenDimensions([1.68, 2.10, 0.312, 5.28]) },
    serviceTierMultipliers: { priority: 1.75, flex: 0.5, batch: 0.5 },
  };
  const p = OPENAI[modelId];
  if (!p) return undefined;
  return {
    sourceUrl: `https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-${p.card}.html`,
    verifiedAt: VERIFIED_AT,
    dimensions: tokenDimensions(p.geo),
    // Current cards specify a single commercial rate: do not retain the old
    // inferred India surcharge or synthesize unsupported global/cache rates.
    routingDimensions: p.global ? { global: tokenDimensions(p.global) } : undefined,
    serviceTierMultipliers: p.serviceTierMultipliers,
    contextTiers: [{
      minInputTokens: 272001,
      dimensions: tokenDimensions(longRates(p.geo)),
      routingDimensions: p.global ? { global: tokenDimensions(longRates(p.global)) } : undefined,
    }],
  };
};
