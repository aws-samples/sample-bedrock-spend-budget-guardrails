import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyAmazonBedrockUsage,
  classifyFoundationModelsUsage,
  toPricePer1k,
} from '../src/pricing-refresher/usagetype';
import {
  indexByName,
  resolveModelIdFromServicename,
  stripBedrockEditionSuffix,
} from '../src/pricing-refresher/cross-ref';
import { novaModelIdFor } from '../src/pricing-refresher/nova-map';

const fixtureDir = resolve(__dirname, 'fixtures', 'pricing');
const loadFixture = (name: string) =>
  JSON.parse(readFileSync(resolve(fixtureDir, name), 'utf8'));

interface SkuAttrs {
  usagetype: string;
  servicename: string;
  inferenceType?: string;
  model?: string;
}
interface PricedSku {
  attrs: SkuAttrs;
  unit: string;
  pricePerUnit: string;
}
const flatten = (raw: { PriceList: string[] }): PricedSku[] =>
  raw.PriceList.map((s: string) => {
    const j = JSON.parse(s) as {
      product: { attributes: SkuAttrs };
      terms: { OnDemand: Record<string, { priceDimensions: Record<string, { unit: string; pricePerUnit: { USD: string } }> }> };
    };
    const term = Object.values(j.terms.OnDemand)[0];
    const dim = Object.values(term.priceDimensions)[0];
    return { attrs: j.product.attributes, unit: dim.unit, pricePerUnit: dim.pricePerUnit.USD };
  });

describe('usagetype classifier — AmazonBedrockFoundationModels', () => {
  it('correctly classifies every Sonnet 4.6 token SKU (CamelCase convention)', () => {
    const skus = flatten(loadFixture('fm-sonnet-4-6-use1.json'));
    expect(skus.length).toBeGreaterThan(0);

    const classified = skus.map((s) => ({
      usagetype: s.attrs.usagetype,
      kind: classifyFoundationModelsUsage(s.attrs.usagetype),
    }));

    // Spot-checks against the fixture content we observed:
    expect(
      classified.find((c) => c.usagetype === 'USE1-MP:USE1_InputTokenCount_Global-Units')?.kind,
    ).toBe('input');
    expect(
      classified.find((c) => c.usagetype === 'USE1-MP:USE1_CacheReadInputTokenCount-Units')?.kind,
    ).toBe('cacheRead');
    expect(
      classified.find((c) => c.usagetype === 'USE1-MP:USE1_CacheWrite1hInputTokenCount_Global-Units')
        ?.kind,
    ).toBe('cacheWrite');

    // Reserved-throughput SKUs must be excluded.
    expect(
      classified.find((c) => c.usagetype === 'USE1-MP:USE1_Reserved_1Month_InputTPM_Geo-Units')
        ?.kind,
    ).toBeNull();
  });

  it('correctly classifies Opus 4.7 token SKUs (snake_case + _standard convention)', () => {
    const skus = flatten(loadFixture('fm-opus-4-7-use1.json'));
    expect(skus.length).toBeGreaterThan(0);
    expect(
      classifyFoundationModelsUsage('USE1-MP:USE1_output_tokens_standard-Units'),
    ).toBe('output');
    expect(
      classifyFoundationModelsUsage('USE1-MP:USE1_cache_write_tokens_1h_global_standard-Units'),
    ).toBe('cacheWrite');
    expect(
      classifyFoundationModelsUsage('USE1-MP:USE1_cache_write_tokens_global_standard-Units'),
    ).toBe('cacheWrite');
  });

  it('excludes batch SKUs from base pricing classification', () => {
    expect(
      classifyFoundationModelsUsage('APN1-MP:APN1_MillionBatchInputTokens-Units'),
    ).toBeNull();
  });
});

describe('usagetype classifier — AmazonBedrock', () => {
  it('uses inferenceType when provided (Nova Micro)', () => {
    expect(
      classifyAmazonBedrockUsage('USE1-NovaMicro-input-tokens', 'Input tokens'),
    ).toBe('input');
    expect(
      classifyAmazonBedrockUsage('USE1-NovaMicro-output-tokens', 'Output tokens'),
    ).toBe('output');
  });

  it('falls back to usagetype regex when inferenceType is absent', () => {
    expect(classifyAmazonBedrockUsage('USE1-deepseek.v3.2-input-tokens')).toBe('input');
    expect(classifyAmazonBedrockUsage('USE1-deepseek.v3.2-output-tokens')).toBe('output');
  });

  it('classifies Nova Micro cache variants from kebab-case', () => {
    expect(
      classifyAmazonBedrockUsage('USE1-NovaMicro-cache-read-input-token-count', 'Input tokens'),
    ).toBe('cacheRead');
    expect(
      classifyAmazonBedrockUsage('USE1-NovaMicro-cache-write-input-token-count', 'Input tokens'),
    ).toBe('cacheWrite');
  });

  it('excludes -custom-model variants', () => {
    expect(
      classifyAmazonBedrockUsage(
        'USE1-NovaMicro-cache-read-input-token-count-custom-model',
        'Input tokens',
      ),
    ).toBeNull();
  });
});

describe('toPricePer1k', () => {
  it('divides AmazonBedrockFoundationModels prices by 1000 (per-1M → per-1K)', () => {
    expect(toPricePer1k('3.0000000000', 'AmazonBedrockFoundationModels')).toBe(0.003);
  });

  it('passes AmazonBedrock prices through unchanged (already per-1K)', () => {
    expect(toPricePer1k('0.0000087500', 'AmazonBedrock')).toBe(0.0000087500);
  });
});

describe('cross-ref name resolution', () => {
  it('strips the (Amazon Bedrock Edition) suffix', () => {
    expect(stripBedrockEditionSuffix('Claude Sonnet 4.6 (Amazon Bedrock Edition)')).toBe(
      'Claude Sonnet 4.6',
    );
    expect(stripBedrockEditionSuffix('Already plain')).toBe('Already plain');
  });

  it('resolves modelId by case-insensitive name match', () => {
    const idx = indexByName([
      { modelId: 'anthropic.claude-sonnet-4-20250514-v1:0', modelName: 'Claude Sonnet 4', providerName: 'Anthropic' },
      { modelId: 'anthropic.claude-haiku-4-5-20251015-v1:0', modelName: 'Claude Haiku 4.5', providerName: 'Anthropic' },
    ]);
    expect(
      resolveModelIdFromServicename('Claude Sonnet 4 (Amazon Bedrock Edition)', idx),
    ).toBe('anthropic.claude-sonnet-4-20250514-v1:0');
    expect(
      resolveModelIdFromServicename('claude haiku 4.5 (Amazon Bedrock Edition)', idx),
    ).toBe('anthropic.claude-haiku-4-5-20251015-v1:0');
    expect(
      resolveModelIdFromServicename('Unknown Model (Amazon Bedrock Edition)', idx),
    ).toBeUndefined();
  });

  it('returns undefined for deprecated models no longer in ListFoundationModels', () => {
    const idx = indexByName([]); // empty FM list simulates account where 3.5 Sonnet is gone.
    expect(
      resolveModelIdFromServicename('Claude 3.5 Sonnet (Amazon Bedrock Edition)', idx),
    ).toBeUndefined();
  });
});

describe('Nova short-name map', () => {
  it('maps every shipped Nova model name to its modelId', () => {
    expect(novaModelIdFor('Nova Micro')).toBe('amazon.nova-micro-v1:0');
    expect(novaModelIdFor('Nova Lite')).toBe('amazon.nova-lite-v1:0');
    expect(novaModelIdFor('Nova Pro')).toBe('amazon.nova-pro-v1:0');
    expect(novaModelIdFor('Nova Canvas')).toBe('amazon.nova-canvas-v1:0');
  });

  it('returns undefined for unmapped Nova variants (signals UI warning)', () => {
    expect(novaModelIdFor('Nova Mystery')).toBeUndefined();
  });
});

describe('end-to-end: real Sonnet 4.6 fixture produces correct prices', () => {
  it('extracts $3.00/1M input → $0.003/1K input', () => {
    const skus = flatten(loadFixture('fm-sonnet-4-6-use1.json'));
    const inputSku = skus.find(
      (s) => s.attrs.usagetype === 'USE1-MP:USE1_InputTokenCount_Global-Units',
    );
    expect(inputSku).toBeDefined();
    if (!inputSku) return;
    const kind = classifyFoundationModelsUsage(inputSku.attrs.usagetype);
    expect(kind).toBe('input');
    expect(toPricePer1k(inputSku.pricePerUnit, 'AmazonBedrockFoundationModels')).toBeCloseTo(0.003, 6);
  });
});
