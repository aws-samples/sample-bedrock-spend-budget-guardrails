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
const NOVEMBER_REVIEW = '2026-11-28T00:00:00.000Z';
/** Multipliers can change on a published date; the refresher evaluates them daily. */
type TierMultipliers = Record<string, number> | ((now: number) => Record<string, number>);
const OPENAI: Record<string, {
  card: string; geo: Rates; global?: Rates; serviceTierMultipliers?: TierMultipliers; verifiedAt?: string;
}> = {
  'openai.gpt-6.2-astra': {
    card: 'openai-gpt-6-2-astra', geo: [8.8, 11, 0.44, 44], global: [8, 10, 0.4, 40],
    // Card: Ultrafast is 3x Standard through 2027-02-28, then 6x from 2027-03-01.
    serviceTierMultipliers: (now) => ({ ultrafast: now < Date.parse('2027-03-01T00:00:00Z') ? 3 : 6 }),
    verifiedAt: NOVEMBER_REVIEW,
  },
  'openai.gpt-6.2-sol': {
    card: 'openai-gpt-6-2-sol', geo: [2.2, 2.75, 0.11, 11], global: [2, 2.5, 0.1, 10],
    verifiedAt: NOVEMBER_REVIEW,
  },
  'openai.gpt-6.1-terra': {
    card: 'openai-gpt-6-1-terra', geo: [1.1, 1.375, 0.055, 5.5], global: [1, 1.25, 0.05, 5],
    verifiedAt: NOVEMBER_REVIEW,
  },
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

/**
 * Reviewed long-context boundaries for models whose rates come from the Price
 * List. The catalog publishes `long_ctx` SKUs without the boundary that turns
 * them on, so the refresher skips those SKUs unless this file names it.
 */
const CONTEXT_BOUNDARIES: Record<string, { minInputTokens: number; sourceUrl: string; verifiedAt: string }> = {
  // Card: prompts over 100,000 tokens bill at the Long Context rates.
  'anthropic.claude-haiku-5-5': {
    minInputTokens: 100001,
    sourceUrl: 'https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-haiku-5-5.html',
    verifiedAt: NOVEMBER_REVIEW,
  },
};

const commercialOnly = (region?: string): boolean =>
  !region || !/^(?:us-(?:gov|iso)|cn-|eusc-)/.test(region);

/** Reviewed context boundary for a model: its full website row first, else a boundary-only review. */
export const contextBoundaryFor = (
  modelId: string, region?: string,
): { minInputTokens: number; sourceUrl: string; verifiedAt: string } | undefined => {
  if (!commercialOnly(region)) return undefined;
  const published = publishedPricingFor(modelId, region);
  const tier = published?.contextTiers?.[0];
  if (published && tier) {
    return { minInputTokens: tier.minInputTokens, sourceUrl: published.sourceUrl, verifiedAt: published.verifiedAt };
  }
  return CONTEXT_BOUNDARIES[modelId];
};

export const publishedPricingFor = (
  modelId: string, region?: string, now: number = Date.now(),
): PublishedPricing | undefined => {
  // This registry reviews commercial pricing. Never export those rates into a
  // different partition whose availability, premiums, and tier support differ.
  if (!commercialOnly(region)) return undefined;
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
  // Not in the Price List as of the review. Card rates: US and IN CRIS share
  // one rate; Global is lower. No long-context tier is published.
  if (modelId === 'moonshotai.kimi-k3.1') return {
    sourceUrl: 'https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-moonshot-ai-kimi-k3-1-highspeed.html',
    verifiedAt: NOVEMBER_REVIEW,
    dimensions: tokenDimensions([4.4, 5.5, 0.22, 22]),
    routingDimensions: { global: tokenDimensions([4, 5, 0.2, 20]) },
    serviceTierMultipliers: { priority: 1.75, flex: 0.5 },
  };
  const p = OPENAI[modelId];
  if (!p) return undefined;
  return {
    sourceUrl: `https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-${p.card}.html`,
    verifiedAt: p.verifiedAt ?? VERIFIED_AT,
    dimensions: tokenDimensions(p.geo),
    // Current cards specify a single commercial rate: do not retain the old
    // inferred India surcharge or synthesize unsupported global/cache rates.
    routingDimensions: p.global ? { global: tokenDimensions(p.global) } : undefined,
    serviceTierMultipliers: typeof p.serviceTierMultipliers === 'function'
      ? p.serviceTierMultipliers(now) : p.serviceTierMultipliers,
    contextTiers: [{
      minInputTokens: 272001,
      dimensions: tokenDimensions(longRates(p.geo)),
      routingDimensions: p.global ? { global: tokenDimensions(longRates(p.global)) } : undefined,
    }],
  };
};
