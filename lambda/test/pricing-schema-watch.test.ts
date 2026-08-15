import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// pricing-refresher reads PRICING_TABLE at module load — set before import.
beforeAll(() => {
  process.env.PRICING_TABLE = 'test-pricing';
  process.env.METERED_REGIONS = 'us-east-1';
});

// ---------------------------------------------------------------------------
// SDK client mocks. Same vi.mock pattern as enforcement.test.ts: stub each
// SDK module so the handler's clients call our recorders. This is simpler
// than aws-sdk-client-mock for a single end-to-end shape, and matches the
// repo's existing test idiom.
// ---------------------------------------------------------------------------

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

// The pricing-refresher now prices off the static bulk offer files FIRST and
// only falls back to the Query API (GetProducts) for what bulk missed. This
// test drives the schema watch on the FoundationModels *Query* path, so stub
// the bulk loader to return nothing — forcing every model through the mocked
// Query fallback deterministically (and avoiding a real network fetch in unit
// tests). See resolveModelPricing in ../src/pricing-refresher/index.ts.
vi.mock('../src/pricing-refresher/bulk-offer.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/pricing-refresher/bulk-offer.js')>();
  return { ...real, loadRegionOfferSkus: vi.fn(async () => []) };
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
    DynamoDBDocumentClient: {
      from: () => ({ send: (cmd: unknown) => ddbSendMock(cmd) }),
    },
    PutCommand: class extends FakeCommand {
      readonly _kind = 'PutCommand';
    },
    ScanCommand: class extends FakeCommand {
      readonly _kind = 'ScanCommand';
    },
  };
});

// Capture metric emissions. Mirrors enforcement.test.ts: the schema watch
// uses singleMetric() so it can attach the `attribute` dimension without
// leaking it onto neighbouring metrics flushed in the same invocation.
interface CapturedMetric {
  name: string;
  unit: string;
  value: number;
  dimensions: Record<string, string>;
}
const captured: CapturedMetric[] = [];
let pendingDims: Record<string, string> = {};

vi.mock('../src/shared/powertools.js', async () => {
  const real = await vi.importActual<typeof import('@aws-lambda-powertools/metrics')>(
    '@aws-lambda-powertools/metrics',
  );
  const fakeMetrics = {
    addMetric: (name: string, unit: string, value: number) => {
      captured.push({ name, unit, value, dimensions: { ...pendingDims } });
    },
    addDimension: (k: string, v: string) => {
      pendingDims[k] = v;
    },
    publishStoredMetrics: () => {
      pendingDims = {};
    },
    singleMetric: () => {
      const dims: Record<string, string> = {};
      return {
        addDimension: (k: string, v: string) => {
          dims[k] = v;
        },
        addMetric: (name: string, unit: string, value: number) => {
          captured.push({ name, unit, value, dimensions: { ...dims } });
        },
      };
    },
  };
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    metrics: fakeMetrics,
    MetricUnit: real.MetricUnit,
  };
});

// ---------------------------------------------------------------------------
// Helpers to build a fake AmazonBedrockFoundationModels GetProducts response.
// ---------------------------------------------------------------------------

interface SkuAttrs {
  regionCode: string;
  usagetype: string;
  servicename: string;
  operation?: string;
  location?: string;
  locationType?: string;
  // Schema-watch attributes (absent today; populated if AWS adds a stable model identifier).
  modelId?: string;
  model?: string;
  inferenceType?: string;
}

const buildSku = (sku: string, attrs: SkuAttrs, pricePerUnit = '5.00'): string =>
  JSON.stringify({
    product: { sku, attributes: attrs },
    serviceCode: 'AmazonBedrockFoundationModels',
    terms: {
      OnDemand: {
        [`${sku}.OFFER`]: {
          priceDimensions: {
            [`${sku}.OFFER.RATE`]: {
              unit: 'Units',
              pricePerUnit: { USD: pricePerUnit },
              description: 'Input Tokens - Standard',
            },
          },
        },
      },
    },
  });

const importHandler = async () => {
  // Fresh module per test so module-level state (METERED_REGIONS) doesn't
  // bleed; vi.resetModules in beforeEach handles this.
  const mod = await import('../src/pricing-refresher/index.js');
  return mod.handler;
};

const TODAY_LFM = {
  modelSummaries: [
    {
      modelId: 'anthropic.claude-opus-4-7-v1:0',
      modelName: 'Claude Opus 4.7',
      providerName: 'Anthropic',
      modelLifecycle: { status: 'ACTIVE' },
    },
  ],
};

describe('pricing-refresher schema watch', () => {
  beforeEach(() => {
    pricingSendMock.mockReset();
    bedrockSendMock.mockReset();
    ddbSendMock.mockReset();
    captured.length = 0;
    pendingDims = {};

    // Default DDB Put returns success.
    ddbSendMock.mockResolvedValue({});
    // Default Bedrock returns one model so the refresher has something to walk.
    bedrockSendMock.mockImplementation(() => Promise.resolve(TODAY_LFM));
  });

  it('does NOT emit PricingApiSchemaChanged when modelId/model/inferenceType are all absent (today\'s reality)', async () => {
    // Synthesize today's AmazonBedrockFoundationModels response shape — no
    // modelId, no model, no inferenceType. This is the gap that drives the
    // cross-API workaround.
    pricingSendMock.mockImplementation((cmd: unknown) => {
      const k = (cmd as { _kind?: string })._kind;
      if (k !== 'GetProductsCommand') throw new Error('unexpected pricing cmd');
      return Promise.resolve({
        PriceList: [
          buildSku('SKU_INPUT', {
            regionCode: 'us-east-1',
            usagetype: 'USE1-MP:USE1_input_tokens_standard-Units',
            servicename: 'Claude Opus 4.7 (Amazon Bedrock Edition)',
          }),
          buildSku('SKU_OUTPUT', {
            regionCode: 'us-east-1',
            usagetype: 'USE1-MP:USE1_output_tokens_standard-Units',
            servicename: 'Claude Opus 4.7 (Amazon Bedrock Edition)',
          }),
        ],
        NextToken: undefined,
      });
    });

    const handler = await importHandler();
    await handler();

    const schemaMetrics = captured.filter((m) => m.name === 'PricingApiSchemaChanged');
    expect(schemaMetrics).toHaveLength(0);
  });

  it('emits PricingApiSchemaChanged with attribute=modelId when AWS populates modelId on a SKU', async () => {
    // Synthesize the future shape: same SKUs, but one carries modelId.
    pricingSendMock.mockImplementation((cmd: unknown) => {
      const k = (cmd as { _kind?: string })._kind;
      if (k !== 'GetProductsCommand') throw new Error('unexpected pricing cmd');
      return Promise.resolve({
        PriceList: [
          buildSku('SKU_INPUT', {
            regionCode: 'us-east-1',
            usagetype: 'USE1-MP:USE1_input_tokens_standard-Units',
            servicename: 'Claude Opus 4.7 (Amazon Bedrock Edition)',
            modelId: 'anthropic.claude-opus-4-7-v1:0',
          }),
          buildSku('SKU_OUTPUT', {
            regionCode: 'us-east-1',
            usagetype: 'USE1-MP:USE1_output_tokens_standard-Units',
            servicename: 'Claude Opus 4.7 (Amazon Bedrock Edition)',
            modelId: 'anthropic.claude-opus-4-7-v1:0',
          }),
        ],
        NextToken: undefined,
      });
    });

    const handler = await importHandler();
    await handler();

    const schemaMetrics = captured.filter((m) => m.name === 'PricingApiSchemaChanged');
    // Two SKUs both carry modelId, but the watch state dedupes — exactly one
    // emission per attribute per refresh.
    expect(schemaMetrics).toHaveLength(1);
    expect(schemaMetrics[0].value).toBe(1);
    expect(schemaMetrics[0].dimensions.attribute).toBe('modelId');
  });
});
