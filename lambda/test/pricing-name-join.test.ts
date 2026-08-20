import { describe, expect, it } from 'vitest';
import { modelNameVariants } from '../src/pricing-refresher/name-variants';
import { skuPrecedence, classifyNonTokenUsage } from '../src/pricing-refresher/usagetype';
import { MODEL_ALIASES } from '../src/pricing-refresher/model-aliases';
import { __test } from '../src/pricing-refresher';

/**
 * Regression coverage for the pricing name-join + SKU-tier-precedence fix
 * (BBG pricing-gap). Each modelNameVariants case is a verified LFM→Pricing
 * pair the OLD 4-variant `ambNames` missed; the skuPrecedence cases pin the
 * live wrong-price bug where a batch/flex SKU could overwrite on-demand.
 */
describe('modelNameVariants — verified LFM → Pricing `model` pairs', () => {
  const contains = (name: string, expected: string) =>
    expect(modelNameVariants(name)).toContain(expected);

  it('strips training qualifiers LFM appends (Gemma IT/PT)', () => {
    contains('Gemma 3 27B PT', 'Gemma 3 27B');
    contains('Gemma 3 4B IT', 'Gemma 3 4B');
  });

  it('strips a parenthesized version group', () => {
    contains('Mistral Large (24.02)', 'Mistral Large');
    contains('Mistral Large (24.07)', 'Mistral Large 24.07');
  });

  it('normalizes hyphens to spaces', () => {
    contains('Qwen3-Coder-30B-A3B-Instruct', 'Qwen3 Coder 30B A3B');
    contains('DeepSeek-V3.1', 'DeepSeek V3.1');
  });

  it('promotes a bare integer major to x.0 (Nova 2 Lite → Nova 2.0 Lite)', () => {
    contains('Nova 2 Lite', 'Nova 2.0 Lite');
  });

  it('repositions the version to the end (Nova 2 Sonic → Nova Sonic 2.0)', () => {
    contains('Nova 2 Sonic', 'Nova Sonic 2.0');
  });

  it('swaps size/version for Ministral (Ministral 3 8B → Ministral 8B 3.0)', () => {
    contains('Ministral 3 8B', 'Ministral 8B 3.0');
  });

  it('drops a duplicated provider prefix (Qwen3 32B (dense) → Qwen3 32B)', () => {
    contains('Qwen3 32B (dense)', 'Qwen3 32B');
  });

  it('returns variants longest-first so a broad variant cannot shadow a precise one', () => {
    const v = modelNameVariants('Mistral Large 3');
    // The precise full name must be tried before the dangerous bare "Mistral
    // Large" (a different, 8x-pricier legacy model).
    expect(v.indexOf('Mistral Large 3')).toBeLessThan(v.indexOf('Mistral Large'));
  });
});

describe('skuPrecedence — plain on-demand must outrank discounted/SLA tiers', () => {
  it('ranks batch worst, then flex/priority, then cross-region/global, then plain', () => {
    expect(skuPrecedence('USE1-NovaMicro-input-tokens-batch')).toBe(90);
    expect(skuPrecedence('USE1-Nova2.0Lite-input-tokens-flex-cross-region-global')).toBe(80);
    expect(skuPrecedence('USE1-Nova2.0Lite-input-tokens-priority')).toBe(80);
    expect(skuPrecedence('USE1-Nova2.0Lite-input-tokens-cross-region-global')).toBe(20);
    expect(skuPrecedence('USE1-NovaMicro-input-tokens')).toBe(0);
    expect(skuPrecedence('USE1_input_tokens_standard-Units')).toBe(0);
  });

  it('ranks the FoundationModels `_Global` cross-region SKU below plain regional', () => {
    // BBG meters at the source region's regional rate, so the plain regional
    // SKU must beat its _Global sibling (both classify as `input`). A wrong
    // choice here flipped every flagship Anthropic model ~10% (regional
    // $0.0033 vs global $0.003).
    expect(skuPrecedence('USE1-MP:USE1_InputTokenCount_Global-Units')).toBe(20);
    expect(skuPrecedence('USE1-MP:USE1_InputTokenCount-Units')).toBe(0);
    expect(skuPrecedence('USE1-MP:USE1_CacheWrite1hInputTokenCount_Global-Units')).toBe(20);
  });

  it('matches AmazonBedrock lowercase `-batch` (the case-sensitivity bug)', () => {
    // The old /Batch/ regex missed this, letting the 50%-off batch rate win.
    expect(skuPrecedence('USE1-NovaMicro-output-tokens-batch')).toBe(90);
    expect(skuPrecedence('USE1-MP:USE1_MillionBatchInputTokens-Units')).toBe(90);
  });
});

describe('classifyNonTokenUsage — embeddings/rerank non-token shapes', () => {
  it('classifies bare `-second` audio (Nova Multimodal Embeddings)', () => {
    expect(
      classifyNonTokenUsage('USE1-NovaMultiModalEmbeddings-input-audio-second', '1K seconds'),
    ).toBe('inputAudioSeconds');
  });

  it('classifies rerank search units', () => {
    expect(classifyNonTokenUsage('USW2-AmazonRerank-v1-searchunits', 'Search Units')).toBe(
      'searchUnits',
    );
  });

  it('falls back to a unit containing "image" (Titan multimodal "Images Processed")', () => {
    expect(
      classifyNonTokenUsage('USE1-TitanEmbeddingsG1-Image-input-image', 'Images Processed'),
    ).toBe('outputImages');
  });
});

describe('SKU selection is order-independent (claim precedence + cheapest tiebreak)', () => {
  const { recordTokenPrice } = __test;

  it('records global-variant SKUs into the routing bucket AND keeps the regional rate on the bare dimension', () => {
    // Claude Opus 5 us-west-2, rates verified against CUR 2026-08-20:
    // regional input $0.0055, global-standard input $0.005.
    for (const order of [
      [
        ['USW2-anthropic.claude-opus-5-mantle-input-tokens-global-standard', 0.005],
        ['USW2-anthropic.claude-opus-5-mantle-input-tokens-standard', 0.0055],
      ],
      [
        ['USW2-anthropic.claude-opus-5-mantle-input-tokens-standard', 0.0055],
        ['USW2-anthropic.claude-opus-5-mantle-input-tokens-global-standard', 0.005],
      ],
    ] as Array<Array<[string, number]>>) {
      const table: Record<string, {
        dimensions: Record<string, { pricePerUnit: number }>;
        routing?: Record<string, { dimensions: Record<string, { pricePerUnit: number }> }>;
      }> = {};
      for (const [ut, price] of order) {
        recordTokenPrice(table as never, 'us-west-2', 'input', price, ut);
      }
      // Bare dimension: regional on-demand wins (unchanged behaviour).
      expect(table['us-west-2'].dimensions.inputTokens.pricePerUnit).toBe(0.0055);
      // Routing bucket: the global SKU gets a home.
      expect(table['us-west-2'].routing?.global.dimensions.inputTokens.pricePerUnit).toBe(0.005);
    }
  });

  it('within the global bucket, plain global beats batch-global regardless of order', () => {
    for (const order of [
      [
        ['USW2-Model-input-tokens-batch-global', 0.0025],
        ['USW2-Model-input-tokens-global-standard', 0.005],
      ],
      [
        ['USW2-Model-input-tokens-global-standard', 0.005],
        ['USW2-Model-input-tokens-batch-global', 0.0025],
      ],
    ] as Array<Array<[string, number]>>) {
      const table: Record<string, {
        routing?: Record<string, { dimensions: Record<string, { pricePerUnit: number }> }>;
      }> = {};
      for (const [ut, price] of order) {
        // batch SKUs are excluded from the BARE dimension by the caller's
        // classifier, but recordTokenPrice is only invoked for classified
        // SKUs — call it directly to exercise bucket precedence.
        recordTokenPrice(table as never, 'us-west-2', 'input', price, ut);
      }
      expect(table['us-west-2'].routing?.global.dimensions.inputTokens.pricePerUnit).toBe(0.005);
    }
  });

  it('CRIS cross-region (non-global) SKUs do NOT create a routing bucket', () => {
    const table: Record<string, { routing?: Record<string, unknown> }> = {};
    recordTokenPrice(table as never, 'us-east-1', 'input', 0.0033, 'USE1-Model-input-tokens-cross-region');
    expect(table['us-east-1'].routing).toBeUndefined();
  });

  it('picks on-demand over batch REGARDLESS of arrival order (the live money bug)', () => {
    // Nova Micro us-east-1: on-demand $0.000035 vs batch $0.0000175.
    for (const order of [
      [
        ['USE1-NovaMicro-input-tokens-batch', 0.0000175],
        ['USE1-NovaMicro-input-tokens', 0.000035],
      ],
      [
        ['USE1-NovaMicro-input-tokens', 0.000035],
        ['USE1-NovaMicro-input-tokens-batch', 0.0000175],
      ],
    ] as Array<Array<[string, number]>>) {
      const table: Record<string, { dimensions: Record<string, { pricePerUnit: number }>; precedence: Record<string, number> }> = {};
      for (const [ut, price] of order) recordTokenPrice(table as never, 'us-east-1', 'input', price, ut);
      expect(table['us-east-1'].dimensions.inputTokens.pricePerUnit).toBe(0.000035);
    }
  });

  it('picks regional over _Global cross-region REGARDLESS of order', () => {
    for (const order of [
      [
        ['USE1-MP:USE1_InputTokenCount_Global-Units', 0.003],
        ['USE1-MP:USE1_InputTokenCount-Units', 0.0033],
      ],
      [
        ['USE1-MP:USE1_InputTokenCount-Units', 0.0033],
        ['USE1-MP:USE1_InputTokenCount_Global-Units', 0.003],
      ],
    ] as Array<Array<[string, number]>>) {
      const table: Record<string, unknown> = {};
      for (const [ut, price] of order) recordTokenPrice(table as never, 'us-east-1', 'input', price, ut);
      expect((table['us-east-1'] as { dimensions: { inputTokens: { pricePerUnit: number } } }).dimensions.inputTokens.pricePerUnit).toBe(0.0033);
    }
  });

  it('at the same tier picks the CHEAPEST SKU (5-min cache-write over 1h) deterministically', () => {
    for (const order of [
      [
        ['USE1-MP:USE1_CacheWrite1hInputTokenCount-Units', 0.0066],
        ['USE1-MP:USE1_CacheWriteInputTokenCount-Units', 0.004125],
      ],
      [
        ['USE1-MP:USE1_CacheWriteInputTokenCount-Units', 0.004125],
        ['USE1-MP:USE1_CacheWrite1hInputTokenCount-Units', 0.0066],
      ],
    ] as Array<Array<[string, number]>>) {
      const table: Record<string, unknown> = {};
      for (const [ut, price] of order) recordTokenPrice(table as never, 'us-east-1', 'cacheWrite', price, ut);
      expect((table['us-east-1'] as { dimensions: { cacheWriteTokens: { pricePerUnit: number } } }).dimensions.cacheWriteTokens.pricePerUnit).toBe(0.004125);
    }
  });
});

describe('MODEL_ALIASES — shape invariants', () => {
  it('keys are plausible Bedrock modelIds and every value has fm or ab', () => {
    for (const [modelId, alias] of Object.entries(MODEL_ALIASES)) {
      expect(modelId).toMatch(/^[a-z0-9.-]+\.[a-z0-9.:-]+$/i);
      expect(Boolean(alias.fm) || Boolean(alias.ab)).toBe(true);
    }
  });
});
