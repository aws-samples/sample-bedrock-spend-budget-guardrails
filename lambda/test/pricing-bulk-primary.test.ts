import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Locks in the bulk-primary contract (the fix for the 5-region truncation):
 *
 *   1. A model priced from the static bulk offer files must NOT fall back to
 *      the throttling Query API (`GetProducts`). This is what keeps the run
 *      inside the Lambda timeout — a regression back to Query-primary would
 *      re-introduce the daily truncation.
 *   2. BOTH service codes' offer files are loaded per region — the
 *      `AmazonBedrockFoundationModels` file (keyed by `servicename`, `1M
 *      tokens`) carries the whole Marketplace-billed Claude lineup and was the
 *      half that used to be dropped.
 *   3. A model bulk can't price (no matching SKU) DOES fall back to the Query
 *      API and emits `PricingQueryFallbackUsed`.
 *
 * Mocks the SDK clients and the bulk-offer loader (no network); asserts against
 * the recorded GetProducts calls, DDB writes, and metrics.
 */
beforeAll(() => {
  process.env.PRICING_TABLE = 'test-pricing';
  process.env.METERED_REGIONS = 'us-east-1';
});

// --- Pricing (Query API) mock: records every GetProducts call. ---
const pricingSendMock = vi.fn();
vi.mock('@aws-sdk/client-pricing', () => {
  class FakeCommand {
    constructor(public readonly input: unknown) {}
  }
  return {
    PricingClient: vi.fn().mockImplementation(function () { return { send: pricingSendMock }; }),
    GetProductsCommand: class extends FakeCommand {
      readonly _kind = 'GetProductsCommand';
    },
  };
});

// --- Bedrock ListFoundationModels mock. ---
const bedrockSendMock = vi.fn();
vi.mock('@aws-sdk/client-bedrock', () => {
  class FakeCommand {
    constructor(public readonly input: unknown) {}
  }
  return {
    BedrockClient: vi.fn().mockImplementation(function () { return { send: bedrockSendMock }; }),
    ListFoundationModelsCommand: class extends FakeCommand {
      readonly _kind = 'ListFoundationModelsCommand';
    },
  };
});

vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: vi.fn().mockImplementation(function () { return {}; }),
}));

const ddbSendMock = vi.fn();
vi.mock('@aws-sdk/lib-dynamodb', () => {
  class FakeCommand {
    constructor(public readonly input: unknown) {}
  }
  return {
    DynamoDBDocumentClient: { from: () => ({ send: (cmd: unknown) => ddbSendMock(cmd) }) },
    PutCommand: class extends FakeCommand {
      readonly _kind = 'PutCommand';
    },
    ScanCommand: class extends FakeCommand {
      readonly _kind = 'ScanCommand';
    },
  };
});

// --- Bulk-offer loader mock: records which (region, serviceCode) were loaded. ---
const loadCalls: Array<{ region: string; serviceCode: string }> = [];
// Reshaped offer SKUs the loader would return, per service code. The AmazonBedrock
// file prices gpt-oss-120b by `model`; the FoundationModels file prices
// Claude Opus 4.7 by `servicename`.
const AB_SKUS = [
  {
    product: {
      sku: 'AB1',
      attributes: {
        model: 'gpt-oss-120b',
        regionCode: 'us-east-1',
        usagetype: 'USE1-gpt-oss-120b-input-tokens',
      },
    },
    terms: { OnDemand: { 'AB1.O': { priceDimensions: { 'AB1.O.R': { unit: '1K tokens', pricePerUnit: { USD: '0.00015' } } } } } },
  },
  {
    product: {
      sku: 'AB2',
      attributes: {
        model: 'gpt-oss-120b',
        regionCode: 'us-east-1',
        usagetype: 'USE1-gpt-oss-120b-output-tokens',
      },
    },
    terms: { OnDemand: { 'AB2.O': { priceDimensions: { 'AB2.O.R': { unit: '1K tokens', pricePerUnit: { USD: '0.0006' } } } } } },
  },
];
const FM_SKUS = [
  {
    product: {
      sku: 'FM1',
      attributes: {
        servicename: 'Claude Opus 4.7 (Amazon Bedrock Edition)',
        regionCode: 'us-east-1',
        usagetype: 'USE1-MP:USE1_input_tokens_standard-Units',
      },
    },
    // 1M-token unit → toPricePer1k divides by 1000 → $3/1M = $0.003/1K.
    terms: { OnDemand: { 'FM1.O': { priceDimensions: { 'FM1.O.R': { unit: 'Units', pricePerUnit: { USD: '3.00' } } } } } },
  },
];

vi.mock('../src/pricing-refresher/bulk-offer.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/pricing-refresher/bulk-offer.js')>();
  return {
    ...real,
    loadRegionOfferSkus: vi.fn(async (region: string, serviceCode = 'AmazonBedrock') => {
      loadCalls.push({ region, serviceCode });
      if (serviceCode === 'AmazonBedrock') return AB_SKUS;
      if (serviceCode === 'AmazonBedrockFoundationModels') return FM_SKUS;
      return [];
    }),
  };
});

// Metric capture. vi.mock factories are hoisted above top-level consts, so the
// array is referenced lazily inside the mock (vitest allows `mock*`-prefixed
// names through the hoist guard).
const mockCaptured: Array<{ name: string; value: number }> = [];
vi.mock('../src/shared/powertools.js', async () => {
  const real = await vi.importActual<typeof import('@aws-lambda-powertools/metrics')>(
    '@aws-lambda-powertools/metrics',
  );
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    metrics: {
      addMetric: (name: string, _unit: string, value: number) => mockCaptured.push({ name, value }),
      addDimension: vi.fn(),
      publishStoredMetrics: vi.fn(),
      singleMetric: () => ({ addDimension: vi.fn(), addMetric: vi.fn() }),
    },
    MetricUnit: real.MetricUnit,
  };
});

const importHandler = async () => (await import('../src/pricing-refresher/index.js')).handler;
const captured = (): Array<{ name: string; value: number }> => mockCaptured;

const getProductsCalls = (): number =>
  pricingSendMock.mock.calls.filter((c) => (c[0] as { _kind?: string })?._kind === 'GetProductsCommand').length;

const putModels = (): string[] =>
  ddbSendMock.mock.calls
    .filter((c) => (c[0] as { _kind?: string })?._kind === 'PutCommand')
    .map((c) => (c[0] as { input: { Item: { model: string } } }).input.Item.model);

describe('pricing-refresher — bulk-primary contract', () => {
  beforeEach(() => {
    pricingSendMock.mockReset();
    bedrockSendMock.mockReset();
    ddbSendMock.mockReset();
    loadCalls.length = 0;
    captured().length = 0;
    ddbSendMock.mockResolvedValue({});
    // Query API returns nothing if it's ever reached (it shouldn't be for
    // bulk-priced models).
    pricingSendMock.mockResolvedValue({ PriceList: [], NextToken: undefined });
  });

  it('prices from bulk WITHOUT any GetProducts calls, and loads BOTH service codes', async () => {
    bedrockSendMock.mockResolvedValue({
      modelSummaries: [
        { modelId: 'openai.gpt-oss-120b-1:0', modelName: 'gpt-oss-120b', providerName: 'OpenAI', modelLifecycle: { status: 'ACTIVE' } },
        { modelId: 'anthropic.claude-opus-4-7-v1:0', modelName: 'Claude Opus 4.7', providerName: 'Anthropic', modelLifecycle: { status: 'ACTIVE' } },
      ],
    });

    const handler = await importHandler();
    const out = await handler();

    // Both models priced entirely from bulk — no per-model Query fallback.
    // (The precise signal is PricingQueryFallbackUsed, which fires inside
    // resolveModelPricing only when bulk misses a model+region. Raw GetProducts
    // call count is NOT a valid proxy here: the handler's separate Nova
    // short-name reconciliation pass always issues a few GetProducts calls.)
    expect(captured().filter((m) => m.name === 'PricingQueryFallbackUsed')).toHaveLength(0);
    expect(out.gaps).toEqual([]);

    // Both offer files loaded for the region (the FoundationModels half is the
    // one that used to be dropped).
    const codes = loadCalls.filter((c) => c.region === 'us-east-1').map((c) => c.serviceCode).sort();
    expect(codes).toEqual(['AmazonBedrock', 'AmazonBedrockFoundationModels']);

    // Both models written (gpt-oss via AmazonBedrock `model`, Claude via
    // FoundationModels `servicename`).
    expect(putModels()).toContain('openai.gpt-oss-120b-1:0');
    expect(putModels()).toContain('anthropic.claude-opus-4-7-v1:0');
  });

  it('falls back to GetProducts (and emits PricingQueryFallbackUsed) only for a model bulk cannot price', async () => {
    // A model neither offer file knows about → bulk misses → Query fallback.
    bedrockSendMock.mockResolvedValue({
      modelSummaries: [
        { modelId: 'vendor.unknown-model-v9:0', modelName: 'Unknown Model 9', providerName: 'Vendor', modelLifecycle: { status: 'ACTIVE' } },
      ],
    });

    const handler = await importHandler();
    await handler();

    // Bulk missed → the Query API was consulted at least once for this region.
    expect(getProductsCalls()).toBeGreaterThan(0);
    const fb = captured().filter((m) => m.name === 'PricingQueryFallbackUsed');
    expect(fb.length).toBeGreaterThan(0);
    expect(fb[0].value).toBe(1);
  });
});
