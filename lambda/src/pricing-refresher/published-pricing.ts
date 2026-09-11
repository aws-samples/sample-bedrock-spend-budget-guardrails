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

type Rates = [input: number, write: number, read: number, output: number];
const tokenDimensions = (rates: Rates): Partial<Record<DimensionKind, Dimension>> =>
  Object.fromEntries(
    (['inputTokens', 'cacheWriteTokens', 'cacheReadTokens', 'outputTokens'] as const)
      .map((kind, i) => [kind, { unit: '1K tokens', pricePerUnit: rates[i] / 1000 }]),
  );

const OPENAI: Record<string, { card: string; geo: Rates; global: Rates }> = {
  'openai.gpt-6-astra': {
    card: 'openai-gpt-6-astra', geo: [11, 13.75, 1.1, 55], global: [10, 12.5, 1, 50],
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
};

const longRates = (r: Rates): Rates => [r[0] * 2, r[1] * 2, r[2] * 2, r[3] * 1.5];
const indiaRates = (r: Rates): Rates => r.map((n) => Number((n * 1.2).toPrecision(12))) as Rates;

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

export const publishedPricingFor = (modelId: string): PublishedPricing | undefined => {
  const imagePrice = IMAGE_GENERATION_PRICES[modelId];
  if (imagePrice !== undefined) return {
    sourceUrl: 'https://aws.amazon.com/bedrock/pricing/',
    verifiedAt: '2026-09-11T00:00:00.000Z',
    dimensions: { outputImages: { unit: 'image', pricePerUnit: imagePrice } },
  };
  const p = OPENAI[modelId];
  if (!p) return undefined;
  const india = /(?:terra|luna)$/.test(modelId)
    ? Object.fromEntries(['ap-south-1', 'ap-south-2'].map((r) => [r, tokenDimensions(indiaRates(p.geo))]))
    : undefined;
  return {
    sourceUrl: `https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-${p.card}.html`,
    verifiedAt: '2026-09-11T00:00:00.000Z',
    dimensions: tokenDimensions(p.geo),
    regionDimensions: india,
    routingDimensions: { global: tokenDimensions(p.global) },
    contextTiers: [{
      minInputTokens: 272001,
      dimensions: tokenDimensions(longRates(p.geo)),
      regionDimensions: india
        ? Object.fromEntries(Object.keys(india).map((r) => [r, tokenDimensions(indiaRates(longRates(p.geo)))]))
        : undefined,
      routingDimensions: { global: tokenDimensions(longRates(p.global)) },
    }],
  };
};
