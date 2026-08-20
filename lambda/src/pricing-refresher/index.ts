import { BedrockClient, ListFoundationModelsCommand } from '@aws-sdk/client-bedrock';
import {
  type Filter,
  GetProductsCommand,
  PricingClient,
} from '@aws-sdk/client-pricing';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import type { Dimension, DimensionKind } from '../shared/pricing.js';
import { logger, metrics, MetricUnit } from '../shared/powertools.js';
import { getConfiguredMemoryMb, recordSelfCost } from '../shared/self-cost.js';
import {
  classifyAmazonBedrockUsage,
  classifyFoundationModelsUsage,
  routingBucketPrecedence,
  routingModeOfUsagetype,
  classifyNonTokenUsage,
  skuPrecedence,
  type TokenKind,
  toPricePer1k,
} from './usagetype.js';
import {
  type FoundationModelSummary,
  indexByName,
  resolveModelIdFromServicename,
} from './cross-ref.js';
import { novaModelIdFor } from './nova-map.js';
import { modelNameVariants } from './name-variants.js';
import { MODEL_ALIASES } from './model-aliases.js';
import { BULK_SERVICE_CODES, type BulkServiceCode, loadRegionOfferSkus, type OfferSku } from './bulk-offer.js';

const PRICING_TABLE = process.env.PRICING_TABLE!;
// Pricing API is hosted in us-east-1, eu-central-1, ap-south-1 only.
const PRICING_REGION = 'us-east-1';

// Regions to refresh. Pulled from cdk.json `bbg:meteredRegions`; the Lambda
// receives them as a comma-separated env var injected by PricingStack.
const METERED_REGIONS = (process.env.METERED_REGIONS ?? 'us-east-1,us-east-2,us-west-2')
  .split(',')
  .map((r) => r.trim())
  .filter(Boolean);

// Nova short-name → static modelId. ListFoundationModels doesn't always return
// these by the exact name the Pricing API uses, so we reconcile them via the
// AmazonBedrock service code under the static ID. Shared between the Nova pass
// and the live-model set for the freshness metric.
const NOVA_SHORT_NAMES: Record<string, string> = {
  'Nova Micro': 'amazon.nova-micro-v1:0',
  'Nova Lite': 'amazon.nova-lite-v1:0',
  'Nova Pro': 'amazon.nova-pro-v1:0',
};

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({}),
  { marshallOptions: { removeUndefinedValues: true } },
);
// The AWS Pricing API (GetProducts) is a low-TPS service. This Lambda fans out
// ~140 models × 5 regions × several servicename candidates = thousands of
// sequential GetProducts calls, which throttled ("Rate exceeded") hundreds of
// times per run under the SDK default retry (standard, 3 attempts). The default
// reacts to throttles AFTER they happen with exponential backoff, amplifying
// wall-clock until the handler blew past its timeout and never emitted
// PricingRefreshAge — firing the *-pricing-refresh-age alarm (missing-data =
// breaching). `adaptive` retry adds a client-side token-bucket rate limiter
// that PROACTIVELY slows the request rate when it detects throttling, which is
// exactly right for a low-TPS API; the higher maxAttempts absorbs the residual
// throttles so individual SKUs don't fail out.
const pricing = new PricingClient({
  region: PRICING_REGION,
  retryMode: 'adaptive',
  maxAttempts: 8,
});

interface SkuJson {
  product: { sku: string; attributes: Record<string, string | undefined> };
  terms: {
    OnDemand?: Record<
      string,
      { priceDimensions: Record<string, { unit: string; pricePerUnit: { USD?: string }; description: string }> }
    >;
  };
}

interface PriceRow {
  inputPer1k?: number;
  outputPer1k?: number;
  cacheReadPer1k?: number;
  cacheWritePer1k?: number;
  /** Multi-dim dimensions discovered for this region. */
  dimensions: Partial<Record<DimensionKind, Dimension>>;
  /**
   * Precedence of the SKU that set each dimension (see skuPrecedence). Lets a
   * plain on-demand SKU win over a batch/flex/priority SKU for the same
   * dimension REGARDLESS of GetProducts response order.
   */
  precedence: Partial<Record<DimensionKind, number>>;
  /**
   * Routing-mode rate buckets (today only `global`). Global-routing SKUs
   * (`*_Global` / `*-global-standard` / `*-cross-region-global`) carry a
   * genuinely DIFFERENT billed rate from the plain regional SKU (Anthropic
   * frontier bills Global ~9% below regional; OpenAI GPT-5.6 also below), so
   * instead of only gap-filling the bare dimensions (their precedence-20
   * behavior, unchanged), they ALSO record here under their mode. The meter
   * selects this bucket when the invocation's model id carried the matching
   * routing prefix. Within a bucket, batch/flex/priority variants of the
   * global family still lose to the plain global SKU via the same
   * claim()/precedence rules.
   */
  routing?: Record<
    string,
    {
      dimensions: Partial<Record<DimensionKind, Dimension>>;
      precedence: Partial<Record<DimensionKind, number>>;
    }
  >;
}

export interface RegionalPricing {
  [region: string]: PriceRow;
}

const tokenKindToDimensionKind: Record<TokenKind, DimensionKind> = {
  input: 'inputTokens',
  output: 'outputTokens',
  cacheRead: 'cacheReadTokens',
  cacheWrite: 'cacheWriteTokens',
};

/**
 * Forward-compat watch for the `AmazonBedrockFoundationModels` Pricing API
 * service code. As of 2026-05 it has only 7 attributes — none of which is a
 * stable per-SKU model identifier (no `modelId`, no `model`, no
 * `inferenceType`). The pricing-refresher therefore joins by `servicename`
 * via `bedrock:ListFoundationModels` (see `cross-ref.ts`).
 *
 * AWS has an open feature request to add a stable model identifier. When that ships,
 * the refresher can collapse to a direct lookup. This watch fires the
 * `bbg.PricingApiSchemaChanged` metric the first time we see ANY SKU on
 * `AmazonBedrockFoundationModels` carry a populated value for `modelId`,
 * `model`, or `inferenceType` — signalling the cross-API workaround can
 * be retired. See `docs/runbooks/alarms/pricing-api-schema-changed.md`.
 */
const SCHEMA_WATCH_ATTRIBUTES = ['modelId', 'inferenceType', 'model'] as const;
type SchemaWatchAttribute = (typeof SCHEMA_WATCH_ATTRIBUTES)[number];

interface SchemaWatchState {
  /** Attributes already emitted this run (dedupe — emit at most once each). */
  emitted: Set<SchemaWatchAttribute>;
}

const newSchemaWatchState = (): SchemaWatchState => ({ emitted: new Set() });

/**
 * Scans one `AmazonBedrockFoundationModels` SKU for any of the watched
 * attributes. If found and not already emitted this run, fires a
 * `bbg.PricingApiSchemaChanged` metric carrying the attribute name as a
 * dimension and logs a structured info line naming the SKU.
 */
const checkFoundationModelsSchema = (sku: SkuJson, state: SchemaWatchState): void => {
  const attrs = sku.product.attributes;
  for (const attr of SCHEMA_WATCH_ATTRIBUTES) {
    if (state.emitted.has(attr)) continue;
    const v = attrs[attr];
    if (typeof v === 'string' && v.trim().length > 0) {
      state.emitted.add(attr);
      const m = metrics.singleMetric();
      m.addDimension('attribute', attr);
      m.addMetric('PricingApiSchemaChanged', MetricUnit.Count, 1);
      logger.info(
        'AmazonBedrockFoundationModels SKU now carries a schema-watch attribute — the cross-API workaround in pricing-refresher can be retired',
        {
          sku: sku.product.sku,
          servicename: attrs.servicename,
          attribute: attr,
          value: v,
        },
      );
    }
  }
};

const tokenKindLabel: Record<TokenKind, string> = {
  input: 'Input tokens',
  output: 'Output tokens',
  cacheRead: 'Cache read tokens',
  cacheWrite: 'Cache write tokens',
};

const fetchAllSkus = async (
  serviceCode: string,
  filters: Filter[],
): Promise<SkuJson[]> => {
  const skus: SkuJson[] = [];
  let nextToken: string | undefined;
  do {
    const r = await pricing.send(
      new GetProductsCommand({
        ServiceCode: serviceCode,
        Filters: filters,
        MaxResults: 100,
        NextToken: nextToken,
      }),
    );
    for (const raw of r.PriceList ?? []) {
      // The Pricing SDK returns PriceList items as String *wrapper objects*
      // (constructor: String), not primitives — `typeof` reports 'object'
      // even though they JSON-parse cleanly. Coerce via String() and parse.
      const json = typeof raw === 'string' ? raw : String(raw);
      try {
        skus.push(JSON.parse(json) as SkuJson);
      } catch {
        // Skip malformed SKUs.
      }
    }
    nextToken = r.NextToken;
  } while (nextToken);
  return skus;
};

const firstOnDemandPrice = (sku: SkuJson): { unit: string; price: number } | undefined => {
  const term = Object.values(sku.terms.OnDemand ?? {})[0];
  if (!term) return undefined;
  const dim = Object.values(term.priceDimensions)[0];
  if (!dim) return undefined;
  const price = Number(dim.pricePerUnit.USD ?? '0');
  if (!Number.isFinite(price)) return undefined;
  return { unit: dim.unit, price };
};

const ensureRegion = (table: RegionalPricing, region: string): PriceRow =>
  (table[region] ??= { dimensions: {}, precedence: {} });

/**
 * Decides whether a SKU may set `kind` for this region, given its tier
 * `prec` (see skuPrecedence) and its `price`. Selection is fully
 * order-INDEPENDENT:
 *   1. Better tier wins (lower prec) — a plain on-demand SKU beats
 *      batch/flex/priority/global no matter the GetProducts order.
 *   2. At the SAME tier, the CHEAPEST SKU wins. Bedrock exposes several
 *      legitimate same-tier SKUs per dimension for multi-rate models —
 *      image resolution/quality (Nova Canvas Standard vs Premium), cache-write
 *      TTL (5-min vs 1h), Nova Sonic text vs speech "input tokens". The meter's
 *      invocation log carries only a coarse counter per dimension (one
 *      `outputImages`, one `cacheWriteTokens`, one `inputTokens`) with no
 *      resolution/TTL/modality signal to disambiguate, so a single rate must
 *      represent the dimension. Cheapest = the base/default tier (Bedrock's
 *      default cache TTL is 5-min, default image is Standard), which is the
 *      least-surprising choice and deterministic across refreshes.
 * Returns true (and records the SKU as the new winner) only when this SKU
 * strictly wins on (tier, then price).
 */
const claim = (row: PriceRow, kind: DimensionKind, prec: number, price: number): boolean => {
  const cur = row.precedence[kind];
  if (cur !== undefined) {
    if (cur < prec) return false; // existing SKU is a better tier
    if (cur === prec) {
      const curPrice = row.dimensions[kind]?.pricePerUnit;
      if (curPrice !== undefined && curPrice <= price) return false; // same tier, existing is cheaper/equal
    }
  }
  row.precedence[kind] = prec;
  return true;
};

const recordTokenPrice = (
  table: RegionalPricing,
  region: string,
  kind: TokenKind,
  pricePer1k: number,
  usagetype: string,
): void => {
  const row = ensureRegion(table, region);
  const dimKind = tokenKindToDimensionKind[kind];
  recordRoutingVariant(row, dimKind, usagetype, {
    unit: '1K tokens',
    pricePerUnit: pricePer1k,
    label: tokenKindLabel[kind],
  });
  if (!claim(row, dimKind, skuPrecedence(usagetype), pricePer1k)) return;
  if (kind === 'input') row.inputPer1k = pricePer1k;
  if (kind === 'output') row.outputPer1k = pricePer1k;
  if (kind === 'cacheRead') row.cacheReadPer1k = pricePer1k;
  if (kind === 'cacheWrite') row.cacheWritePer1k = pricePer1k;
  row.dimensions[dimKind] = {
    unit: '1K tokens',
    pricePerUnit: pricePer1k,
    label: tokenKindLabel[kind],
  };
};

/**
 * When the SKU is a routing-mode variant (today: `global`), record it into
 * the row's per-mode bucket with its own claim() precedence. This runs IN
 * ADDITION to the bare-dimension claim above (where such SKUs remain
 * demoted gap-fillers) — the bucket is what lets the meter bill
 * `global.`-routed traffic at the actual Global rate instead of the
 * regional rate (~9% higher for the Anthropic frontier lineup).
 */
const recordRoutingVariant = (
  row: PriceRow,
  kind: DimensionKind,
  usagetype: string,
  dim: Dimension,
): void => {
  const mode = routingModeOfUsagetype(usagetype);
  if (!mode) return;
  const bucket = ((row.routing ??= {})[mode] ??= { dimensions: {}, precedence: {} });
  const prec = routingBucketPrecedence(usagetype);
  const cur = bucket.precedence[kind];
  if (cur !== undefined) {
    if (cur < prec) return;
    if (cur === prec) {
      const curPrice = bucket.dimensions[kind]?.pricePerUnit;
      if (curPrice !== undefined && curPrice <= dim.pricePerUnit) return;
    }
  }
  bucket.precedence[kind] = prec;
  bucket.dimensions[kind] = dim;
};

const recordNonTokenPrice = (
  table: RegionalPricing,
  region: string,
  kind: DimensionKind,
  unit: string,
  pricePerUnit: number,
  usagetype: string,
  label?: string,
): void => {
  const row = ensureRegion(table, region);
  recordRoutingVariant(row, kind, usagetype, { unit, pricePerUnit, label });
  if (!claim(row, kind, skuPrecedence(usagetype), pricePerUnit)) return;
  row.dimensions[kind] = { unit, pricePerUnit, label };
};

/**
 * Stability AI ships many "feature" endpoints (erase-object, inpaint,
 * control-sketch, upscale, etc.) that don't have their own Pricing API
 * SKUs — per AWS docs they're billed at the parent generative model's
 * rate. Map known feature modelIds to their parent's servicename so the
 * refresher can populate pricing instead of leaving them as gaps.
 */
const FEATURE_FALLBACK: Array<{ pattern: RegExp; parentServicename: string; note: string }> = [
  // Stable Image edit / inpaint / outpaint / control / style features all
  // bill at the Stable Image Ultra rate.
  {
    pattern: /^stability\.stable-image-(?:control|erase|inpaint|outpaint|remove-background|search|style-guide)/,
    parentServicename: 'Stable Image Ultra (Amazon Bedrock Edition)',
    note: 'Borrowed from Stable Image Ultra parent SKU (per AWS docs feature endpoints share parent pricing).',
  },
  {
    pattern: /^stability\.stable-style-transfer/,
    parentServicename: 'Stable Image Ultra (Amazon Bedrock Edition)',
    note: 'Borrowed from Stable Image Ultra parent SKU.',
  },
  {
    pattern: /^stability\.stable-outpaint/,
    parentServicename: 'Stable Image Ultra (Amazon Bedrock Edition)',
    note: 'Borrowed from Stable Image Ultra parent SKU.',
  },
  // Upscalers also share the Stable Image Ultra rate per AWS docs.
  {
    pattern: /^stability\.stable-(?:conservative|creative|fast)-upscale/,
    parentServicename: 'Stable Image Ultra (Amazon Bedrock Edition)',
    note: 'Borrowed from Stable Image Ultra parent SKU.',
  },
];

export const featureFallbackFor = (
  modelId: string,
): { servicename: string; note: string } | undefined => {
  for (const f of FEATURE_FALLBACK) {
    if (f.pattern.test(modelId)) {
      return { servicename: f.parentServicename, note: f.note };
    }
  }
  return undefined;
};

/**
 * Generates candidate `servicename` values to match against the Pricing API.
 * Bedrock's ListFoundationModels often reports a slightly different model
 * name than the Pricing API uses — e.g. "Stable Image Ultra 1.0" vs
 * "Stable Image Ultra (Amazon Bedrock Edition)", "Pegasus v1.2" vs
 * "TwelveLabs Pegasus 1.2 (Amazon Bedrock Edition)". We try several
 * common variants, plus the generalized `modelNameVariants` normalizer and an
 * exact `MODEL_ALIASES` entry (checked FIRST) for free-form renames.
 */
const servicenameCandidates = (
  modelName: string,
  providerName: string,
  modelId?: string,
): string[] => {
  const trailingVersion = / (?:v?\d[\d.]*)$/i;
  const candidates = new Set<string>();
  const add = (s: string) => candidates.add(`${s} (Amazon Bedrock Edition)`);
  // Verified alias wins — it's an exact Pricing servicename, so try it first.
  const aliasFm = modelId ? MODEL_ALIASES[modelId]?.fm : undefined;
  if (aliasFm) add(aliasFm);
  add(modelName);
  add(`${providerName} ${modelName}`);
  // Strip trailing version suffix ("Stable Image Ultra 1.0" → "Stable Image Ultra")
  const stripped = modelName.replace(trailingVersion, '');
  if (stripped !== modelName) {
    add(stripped);
    add(`${providerName} ${stripped}`);
  }
  // Conversely add a trailing " v1.0" — catches "Stable Diffusion 3.5 Large"
  // → Pricing API "Stable Diffusion 3.5 Large v1.0".
  add(`${modelName} v1.0`);
  add(`${providerName} ${modelName} v1.0`);
  // Pegasus quirk: "Pegasus v1.2" → "TwelveLabs Pegasus 1.2"
  const noPrefixV = modelName.replace(/\bv(\d)/i, '$1');
  if (noPrefixV !== modelName) {
    add(noPrefixV);
    add(`${providerName} ${noPrefixV}`);
  }
  // Inverse: "Cohere Rerank 3.5" → "Cohere Rerank v3.5". Inserts a `v`
  // before the version on the trailing numeric component so the Pricing
  // API's preferred shape is also tried.
  const addedV = modelName.replace(/\s(\d)/, ' v$1');
  if (addedV !== modelName) {
    add(addedV);
    add(`${providerName} ${addedV}`);
  }
  // Generalized normalizer (paren-strip, hyphen→space, qualifier-strip,
  // version repositioning). Both bare and provider-prefixed forms.
  for (const v of modelNameVariants(modelName)) {
    add(v);
    add(`${providerName} ${v}`);
  }
  return [...candidates];
};

/**
 * Walks SKUs from AmazonBedrockFoundationModels for one model. Tries each
 * candidate `servicename` until one returns a result; records every priced
 * SKU it finds (token-priced and non-token-priced).
 */
const refreshFoundationModels = async (
  modelName: string,
  providerName: string,
  region: string,
  table: RegionalPricing,
  schemaWatch: SchemaWatchState,
  modelId?: string,
): Promise<void> => {
  let skus: SkuJson[] = [];
  for (const candidate of servicenameCandidates(modelName, providerName, modelId)) {
    skus = await fetchAllSkus('AmazonBedrockFoundationModels', [
      { Type: 'TERM_MATCH', Field: 'servicename', Value: candidate },
      { Type: 'TERM_MATCH', Field: 'regionCode', Value: region },
    ]);
    if (skus.length > 0) break;
  }
  recordFoundationModelsSkus(skus, region, table, schemaWatch);
};

/**
 * Classifies + records a batch of AmazonBedrockFoundationModels SKUs. Shared by
 * the Query-API servicename walk (refreshFoundationModels) and the bulk-offer
 * path (refreshFromBulkOffer). FoundationModels SKUs are priced per 1M tokens
 * (`toPricePer1k(..., 'AmazonBedrockFoundationModels')` converts to per-1K).
 */
const recordFoundationModelsSkus = (
  skus: SkuJson[],
  region: string,
  table: RegionalPricing,
  schemaWatch: SchemaWatchState,
): void => {
  for (const sku of skus) {
    // Forward-compat: watch for AWS adding a stable per-SKU model identifier.
    checkFoundationModelsSchema(sku, schemaWatch);
    const usage = sku.product.attributes.usagetype;
    if (!usage) continue;
    const priced = firstOnDemandPrice(sku);
    if (!priced) continue;

    // Try token classification first (covers chat / cache / embed).
    const tokenKind = classifyFoundationModelsUsage(usage);
    if (tokenKind) {
      const per1k = toPricePer1k(priced.price, 'AmazonBedrockFoundationModels');
      recordTokenPrice(table, region, tokenKind, per1k, usage);
      continue;
    }

    // Otherwise look for image / video / audio / search-unit SKUs.
    const nonTokenKind = classifyNonTokenUsage(usage, priced.unit);
    if (nonTokenKind) {
      recordNonTokenPrice(table, region, nonTokenKind, priced.unit, priced.price, usage);
    }
  }
};

/**
 * Walks SKUs from AmazonBedrock for one model name. Uses the structured
 * `model` and `inferenceType` attributes for token classification, and falls
 * back to the non-token classifier for image / video / audio SKUs.
 */
const refreshAmazonBedrock = async (
  modelName: string,
  region: string,
  table: RegionalPricing,
): Promise<void> => {
  const skus = await fetchAllSkus('AmazonBedrock', [
    { Type: 'TERM_MATCH', Field: 'model', Value: modelName },
    { Type: 'TERM_MATCH', Field: 'regionCode', Value: region },
  ]);
  recordAmazonBedrockSkus(skus, region, table);
};

/**
 * Classifies + records a batch of AmazonBedrock SKUs. Shared by the
 * `model`-attribute walk (refreshAmazonBedrock) and the usagetype-prefix walk
 * (refreshByUsagetypePrefix) for models whose SKUs carry no `model` attribute.
 */
const recordAmazonBedrockSkus = (
  skus: SkuJson[],
  region: string,
  table: RegionalPricing,
): void => {
  for (const sku of skus) {
    const usage = sku.product.attributes.usagetype;
    const inferenceType = sku.product.attributes.inferenceType;
    if (!usage) continue;
    const priced = firstOnDemandPrice(sku);
    if (!priced) continue;

    const tokenKind = classifyAmazonBedrockUsage(usage, inferenceType);
    if (tokenKind && priced.unit === '1K tokens') {
      const per1k = toPricePer1k(priced.price, 'AmazonBedrock');
      recordTokenPrice(table, region, tokenKind, per1k, usage);
      continue;
    }

    const nonTokenKind = classifyNonTokenUsage(usage, priced.unit);
    if (nonTokenKind) {
      recordNonTokenPrice(table, region, nonTokenKind, priced.unit, priced.price, usage);
    }
  }
};

/**
 * Titan embeddings, Amazon Rerank, and Nova Multimodal Embeddings SKUs carry NO
 * `model` attribute (verified 2026-07-30: GetProducts(model="Titan Text
 * Embeddings V2") → 0 SKUs). They are only addressable by a usagetype substring
 * via a `CONTAINS` filter. Values are the region-prefix-stripped usagetype stem.
 */
const USAGETYPE_PREFIX: Record<string, string> = {
  'amazon.titan-embed-text-v1': 'TitanEmbeddingsG1-Text',
  'amazon.titan-embed-text-v1:2:8k': 'TitanEmbeddingsG1-Text',
  'amazon.titan-embed-text-v2:0': 'TitanEmbeddingV2-Text',
  'amazon.titan-embed-text-v2:0:8k': 'TitanEmbeddingV2-Text',
  'amazon.titan-embed-g1-text-02': 'TitanEmbeddingV2-Text',
  'amazon.titan-embed-image-v1': 'TitanEmbeddingsG1-Image',
  'amazon.titan-embed-image-v1:0': 'TitanEmbeddingsG1-Image',
  'amazon.rerank-v1:0': 'AmazonRerank-v1',
  'amazon.nova-2-multimodal-embeddings-v1:0': 'NovaMultiModalEmbeddings',
};

/**
 * Fallback for SKUs with no `model` attribute: match by usagetype substring
 * (`CONTAINS` — verified supported; `ANY_OF` is not). `isExcluded` still drops
 * the Provisioned/Reserved/Customization noise these prefixes also return.
 */
const refreshByUsagetypePrefix = async (
  prefix: string,
  region: string,
  table: RegionalPricing,
): Promise<void> => {
  const skus = await fetchAllSkus('AmazonBedrock', [
    { Type: 'CONTAINS', Field: 'usagetype', Value: prefix },
    { Type: 'TERM_MATCH', Field: 'regionCode', Value: region },
  ]);
  recordAmazonBedrockSkus(skus, region, table);
};

/**
 * Bulk-offer-file cache, keyed by `${serviceCode}|${region}`, populated lazily
 * and shared across every model in a single refresher run so each offer file is
 * downloaded at most once (NOT once per model). A key maps to its OfferSku[],
 * or to `null` if the fetch failed (negative-cached so we don't retry a broken
 * file per model). Reset implicitly per Lambda cold start; a warm container
 * reusing it is fine and desirable (the data changes ~daily).
 */
const bulkOfferCache = new Map<string, OfferSku[] | null>();

const getBulkOfferSkus = async (
  serviceCode: BulkServiceCode,
  region: string,
): Promise<OfferSku[] | null> => {
  const key = `${serviceCode}|${region}`;
  const cached = bulkOfferCache.get(key);
  if (cached !== undefined) return cached;
  try {
    const skus = await loadRegionOfferSkus(region, serviceCode);
    bulkOfferCache.set(key, skus);
    logger.info('loaded bulk offer file', { serviceCode, region, skuCount: skus.length });
    return skus;
  } catch (err) {
    logger.warn('bulk offer file fetch failed', {
      serviceCode,
      region,
      err: (err as Error).message,
    });
    bulkOfferCache.set(key, null);
    return null;
  }
};

/**
 * Pre-warms every (serviceCode, region) offer file once at the start of a run
 * so the per-model resolution below is pure in-memory filtering. Failures are
 * negative-cached and simply mean that (serviceCode, region) contributes
 * nothing — the Query-API fallback then covers those models. Cheap relative to
 * the per-model GetProducts fan-out it replaces (a handful of static downloads
 * vs thousands of throttled API calls).
 */
const prewarmBulkOffers = async (): Promise<void> => {
  await Promise.all(
    METERED_REGIONS.flatMap((region) =>
      BULK_SERVICE_CODES.map((svc) => getBulkOfferSkus(svc, region)),
    ),
  );
};

/**
 * PRIMARY pricing pass for one model+region off the static bulk offer files
 * (both service codes), running the SAME classifier path as the Query API for
 * each code — critically, each code's SKUs go through their OWN classifier
 * because their unit conventions differ (`AmazonBedrock` = `1K tokens` via
 * `classifyAmazonBedrockUsage`; `AmazonBedrockFoundationModels` = `1M tokens`
 * via `classifyFoundationModelsUsage` + `toPricePer1k(..., 'AmazonBedrockFoundationModels')`).
 * Throttle-free (files are pre-warmed, one static download each, reused across
 * models). Records into `table`; `claim()` keeps selection order-independent so
 * mixing both codes is safe.
 *
 *   - `AmazonBedrock`   : match on the `model` attribute (candidateNames = the
 *     exact `model` strings, i.e. alias + name variants; case-insensitive).
 *   - `FoundationModels`: match on the `servicename` attribute (candidateNames
 *     = the "… (Amazon Bedrock Edition)" servicename candidates; the offer
 *     files are already region-scoped so no regionCode filter is needed).
 */
const refreshFromBulkOffer = async (
  amazonBedrockNames: readonly string[],
  foundationModelsServicenames: readonly string[],
  region: string,
  table: RegionalPricing,
  schemaWatch: SchemaWatchState,
): Promise<void> => {
  // AmazonBedrock file — keyed by `model`.
  const ab = await getBulkOfferSkus('AmazonBedrock', region);
  if (ab) {
    const wanted = new Set(amazonBedrockNames.map((n) => n.toLowerCase()));
    const matching = ab.filter((s) => {
      const model = s.product.attributes.model;
      return typeof model === 'string' && wanted.has(model.toLowerCase());
    });
    recordAmazonBedrockSkus(matching as SkuJson[], region, table);
  }

  // AmazonBedrockFoundationModels file — keyed by `servicename`. Must use the
  // FoundationModels classifier (1M-token unit → per-1K conversion).
  const fm = await getBulkOfferSkus('AmazonBedrockFoundationModels', region);
  if (fm) {
    const wanted = new Set(foundationModelsServicenames.map((n) => n.toLowerCase()));
    const matching = fm.filter((s) => {
      const sn = s.product.attributes.servicename;
      return typeof sn === 'string' && wanted.has(sn.toLowerCase());
    });
    recordFoundationModelsSkus(matching as SkuJson[], region, table, schemaWatch);
  }
};

/**
 * Resolves the full per-region pricing for one model. The PRIMARY source is the
 * static bulk offer files (both service codes, pre-warmed once per run) — the
 * same Price List data as the Query API but throttle-free. The Query API
 * (`GetProducts`) is the FALLBACK, used only for a (model, region) the bulk
 * files left unpriced (e.g. a model published to the Query index before the
 * daily offer file caught up). This inversion is what keeps the run inside the
 * Lambda timeout: bulk pricing is pure in-memory filtering, whereas the Query
 * path fans out thousands of throttled `GetProducts` calls.
 *
 * Within each source the ordering mirrors what it always was — AmazonBedrock by
 * `model` (exact alias first, then generalized name variants, longest-first so
 * a broad variant can't mis-join to a different, pricier model) and
 * AmazonBedrockFoundationModels by `servicename`. `claim()` makes SKU selection
 * order-independent, so trying both sources is safe. The usagetype-prefix pass
 * (Titan embeddings / Rerank / Nova Multimodal Embeddings — SKUs with no
 * `model` attribute) stays on the Query API. Feature-fallback (Stability
 * sub-features) is handled separately by the caller.
 *
 * Exported so the read-only dry-run harness (scripts/test-pricing-refresher.ts)
 * exercises the EXACT resolution chain the handler writes — no reimplementation
 * that could drift. `schemaWatch` is optional (dry-run passes its own).
 */
export const resolveModelPricing = async (
  m: FoundationModelSummary,
  schemaWatch: SchemaWatchState = newSchemaWatchState(),
): Promise<RegionalPricing> => {
  const regional: RegionalPricing = {};
  const pricedIn = (region: string): boolean =>
    Object.keys(regional[region]?.dimensions ?? {}).length > 0;

  // AmazonBedrock `model`-attribute candidates: exact verified alias first,
  // then the generalized name normalizer (longest-first — critical so a broad
  // variant like "Mistral Large 3" → "Mistral Large" can't mis-join to a
  // different, 8x-pricier model; `claim()` + the offer filter both respect it).
  const aliasAb = MODEL_ALIASES[m.modelId]?.ab;
  const ambNames = aliasAb
    ? [aliasAb, ...modelNameVariants(m.modelName)]
    : modelNameVariants(m.modelName);
  // AmazonBedrockFoundationModels `servicename` candidates ("… (Amazon Bedrock
  // Edition)"), same set the Query-API servicename walk tries.
  const fmServicenames = servicenameCandidates(m.modelName, m.providerName, m.modelId);

  for (const region of METERED_REGIONS) {
    // PRIMARY: price off the pre-warmed bulk offer files (both service codes).
    try {
      await refreshFromBulkOffer(ambNames, fmServicenames, region, regional, schemaWatch);
    } catch (err) {
      logger.warn('bulk offer pricing failed', {
        modelId: m.modelId,
        region,
        err: (err as Error).message,
      });
    }
    if (pricedIn(region)) continue;

    // FALLBACK (Query API): the bulk files didn't price this model in this
    // region. Emit a metric so chronic reliance (offer files lagging the Query
    // index, or a genuine name-join gap) is visible.
    metrics.addMetric('PricingQueryFallbackUsed', MetricUnit.Count, 1);
    logger.info('bulk offer missed; falling back to Query API', { modelId: m.modelId, region });

    // FoundationModels (by servicename) — newer Anthropic SKUs live here.
    try {
      await refreshFoundationModels(m.modelName, m.providerName, region, regional, schemaWatch, m.modelId);
    } catch (err) {
      logger.warn('FoundationModels query failed', {
        modelName: m.modelName,
        region,
        err: (err as Error).message,
      });
    }
    if (pricedIn(region)) continue;

    // AmazonBedrock (by `model`) — older / Nova / 3P models. BREAK on the first
    // non-empty result so a broad variant can't shadow the precise one.
    for (const name of ambNames) {
      try {
        await refreshAmazonBedrock(name, region, regional);
      } catch (err) {
        logger.warn('AmazonBedrock query failed', {
          modelName: name,
          region,
          err: (err as Error).message,
        });
      }
      if (pricedIn(region)) break;
    }

    // Last resort: SKUs with NO `model` attribute (Titan embeddings, Rerank,
    // Nova Multimodal Embeddings), addressable only by usagetype substring.
    if (pricedIn(region)) continue;
    const prefix = USAGETYPE_PREFIX[m.modelId];
    if (prefix) {
      try {
        await refreshByUsagetypePrefix(prefix, region, regional);
      } catch (err) {
        logger.warn('usagetype-prefix query failed', {
          modelId: m.modelId,
          prefix,
          region,
          err: (err as Error).message,
        });
      }
    }
  }
  return regional;
};

const writePricingRow = async (
  modelId: string,
  modelName: string,
  providerName: string,
  source: 'pricing-api' | 'pricing-api-historical' | 'pricing-api-feature-fallback',
  regional: RegionalPricing,
  notes?: string,
): Promise<void> => {
  // Pick a "primary" rate per dimension (first region that has data) for
  // top-level legacy columns + the top-level dimensions map. Per-region
  // detail goes under regionRates / regionDimensions.
  let inputPer1k: number | undefined;
  let outputPer1k: number | undefined;
  let cacheReadPer1k: number | undefined;
  let cacheWritePer1k: number | undefined;
  const topDimensions: Partial<Record<DimensionKind, Dimension>> = {};
  const regionDimensions: Record<string, Partial<Record<DimensionKind, Dimension>>> = {};
  // Routing-mode rates (today: `global`). Flat mode→dimensions map,
  // first-region-wins like topDimensions — AWS publishes one Global rate per
  // model (the routing SKU is region-prefixed in usagetype but carries the
  // same price everywhere observed); revisit if a real per-region Global
  // divergence ever appears.
  const routingDimensions: Record<string, Partial<Record<DimensionKind, Dimension>>> = {};
  const regionRates: Record<
    string,
    { inputPer1k?: number; outputPer1k?: number; cacheReadPer1k?: number; cacheWritePer1k?: number }
  > = {};

  for (const [region, r] of Object.entries(regional)) {
    inputPer1k ??= r.inputPer1k;
    outputPer1k ??= r.outputPer1k;
    cacheReadPer1k ??= r.cacheReadPer1k;
    cacheWritePer1k ??= r.cacheWritePer1k;
    regionRates[region] = {
      inputPer1k: r.inputPer1k,
      outputPer1k: r.outputPer1k,
      cacheReadPer1k: r.cacheReadPer1k,
      cacheWritePer1k: r.cacheWritePer1k,
    };
    regionDimensions[region] = r.dimensions;
    for (const [k, dim] of Object.entries(r.dimensions) as Array<[DimensionKind, Dimension]>) {
      topDimensions[k] ??= dim;
    }
    for (const [mode, bucket] of Object.entries(r.routing ?? {})) {
      const target = (routingDimensions[mode] ??= {});
      for (const [k, dim] of Object.entries(bucket.dimensions) as Array<
        [DimensionKind, Dimension]
      >) {
        target[k] ??= dim;
      }
    }
  }

  await ddb.send(
    new PutCommand({
      TableName: PRICING_TABLE,
      Item: {
        model: modelId,
        displayName: modelName,
        provider: providerName,
        // Legacy fields (single-token shorthand, kept for back-compat).
        inputPer1k,
        outputPer1k,
        cacheReadPer1k,
        cacheWritePer1k,
        regionRates,
        // Multi-dim schema.
        dimensions: topDimensions,
        regionDimensions,
        // Routing-mode rates (only written when a mode has entries — the
        // meter treats a missing map as "no routing-specific rate").
        ...(Object.keys(routingDimensions).length > 0 ? { routingDimensions } : {}),
        source,
        notes,
        currency: 'USD',
        fetchedAt: new Date().toISOString(),
      },
    }),
  );
};

/**
 * Real pricing staleness age, in seconds: `now - min(fetchedAt)` across every
 * pricing row the meter can read FOR A CURRENTLY-LIVE MODEL. Emitting a
 * hard-coded 0 (the old behaviour) made the 36h staleness alarm unreachable, so
 * a refresher that silently stopped would let the meter charge against days-old
 * prices undetected. The OLDEST row is what matters — a single stale live model
 * is a real gap even if the rest refreshed — so we take the max age (min
 * fetchedAt).
 *
 * CRITICAL: only rows for models STILL returned by ListFoundationModels count.
 * A deprecated model (e.g. an old Claude/Llama variant AWS removed) keeps its
 * last-known price row forever — it can no longer be invoked, so its stale
 * price is harmless, but its ancient `fetchedAt` would otherwise pin this
 * metric past 36h permanently and fire the alarm even when the refresher is
 * perfectly healthy. Reserved non-model rows (e.g. `discount#<acct>`) have no
 * `fetchedAt` and are skipped anyway. Rows without a parseable `fetchedAt` are
 * ignored. Returns 0 when no live-model row has a fetchedAt (e.g. empty table).
 *
 * ALSO EXCLUDED: manual `source: 'override'` rows. This metric measures
 * REFRESHER HEALTH, and by definition the refresher cannot refresh an override —
 * an override exists precisely because AWS publishes no priced SKU for that
 * model in the Price List (Query API *or* bulk offer files), so the model gaps
 * every run and its `fetchedAt` is frozen at whenever a human authored it.
 * Counting overrides made the alarm fire on a *permanent, un-actionable*
 * condition. Observed 2026-08-15: the `openai.gpt-5.6-{sol,terra,luna}`
 * override rows (authored 2026-07-30, Mantle-served, no commercial Price List
 * SKU — see docs/pricing-nuances.md) became visible in ListFoundationModels,
 * instantly pinning this metric at 15.3 days and firing
 * `<stage>-bbg-pricing-refresh-age` in both stages, while the refresher was
 * provably healthy (135 refreshed, 0 errors, 0 skipped, age 538s the day
 * before). Staleness of an override is a *pricing-coverage* concern, tracked by
 * `PricingGapCount` + the operator's own review of `notes`, not a refresher SLO.
 */
export const computePricingRefreshAgeSeconds = async (
  nowMs: number,
  liveModelIds: ReadonlySet<string>,
): Promise<number> => {
  let oldestFetchedAtMs: number | undefined;
  let cursor: Record<string, unknown> | undefined;
  do {
    const r = await ddb.send(
      new ScanCommand({
        TableName: PRICING_TABLE,
        ProjectionExpression: '#m, fetchedAt, #s',
        ExpressionAttributeNames: { '#m': 'model', '#s': 'source' },
        ExclusiveStartKey: cursor,
      }),
    );
    for (const item of r.Items ?? []) {
      const model = item.model as string | undefined;
      // Skip rows for models AWS no longer lists — a stale price on an
      // un-invocable model isn't a freshness gap. Also skips reserved rows.
      if (!model || !liveModelIds.has(model)) continue;
      // Skip manually-authored overrides — the refresher never rewrites them,
      // so their age measures human curation, not refresher health.
      if (item.source === 'override') continue;
      const fetchedAt = item.fetchedAt as string | undefined;
      if (!fetchedAt) continue;
      const t = new Date(fetchedAt).getTime();
      if (Number.isNaN(t)) continue;
      if (oldestFetchedAtMs === undefined || t < oldestFetchedAtMs) oldestFetchedAtMs = t;
    }
    cursor = r.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (cursor);

  if (oldestFetchedAtMs === undefined) return 0;
  return Math.max(0, Math.floor((nowMs - oldestFetchedAtMs) / 1000));
};

/**
 * Minimal Lambda context shape we consume — just the remaining-time clock, so
 * we can stop starting new models before the hard timeout kills us mid-loop
 * (which would skip metric emission and blind the pricing alarms). Optional so
 * unit tests and the local harness can call handler() with no context.
 */
interface RemainingTimeContext {
  getRemainingTimeInMillis?: () => number;
}

// Stop starting NEW models once this little time remains, so the tail of the
// handler (staleness scan + metric publish + return) always runs. The
// per-model work is bounded but not tiny (5 regions × many GetProducts on a
// throttling API), so leave a comfortable margin.
const TIME_BUDGET_RESERVE_MS = 90_000;

export const handler = async (
  _event?: unknown,
  context?: RemainingTimeContext,
): Promise<{ refreshed: number; gaps: string[]; incomplete: boolean }> => {
  const startedAt = Date.now();
  logger.info('pricing-refresher starting', { regions: METERED_REGIONS });
  const remainingMs = (): number =>
    context?.getRemainingTimeInMillis ? context.getRemainingTimeInMillis() : Number.POSITIVE_INFINITY;

  const allModels: FoundationModelSummary[] = [];
  for (const region of METERED_REGIONS) {
    const bedrock = new BedrockClient({ region });
    try {
      const r = await bedrock.send(new ListFoundationModelsCommand({}));
      for (const m of r.modelSummaries ?? []) {
        if (m.modelId && m.modelName && m.providerName) {
          allModels.push({
            modelId: m.modelId,
            modelName: m.modelName,
            providerName: m.providerName,
            modelLifecycle: m.modelLifecycle?.status,
          });
        }
      }
    } catch (err) {
      logger.warn(`ListFoundationModels failed in ${region}`, { err: (err as Error).message });
    }
  }

  // De-duplicate by modelId across regions.
  const byId = new Map<string, FoundationModelSummary>();
  for (const m of allModels) byId.set(m.modelId, m);
  const uniqueModels = [...byId.values()];
  // FM index is consumed by `resolveModelIdFromServicename` for follow-on
  // AmazonBedrockService SKU walks; kept for future use.
  void indexByName(uniqueModels);
  logger.info(`Discovered ${uniqueModels.length} unique models across regions`);

  // Pre-warm the primary source: download every (serviceCode, region) bulk
  // offer file once, up front, so per-model resolution is pure in-memory
  // filtering. This is what replaces the throttled per-model GetProducts
  // fan-out that was blowing the time budget.
  await prewarmBulkOffers();

  const gaps: string[] = [];
  let refreshed = 0;
  let skipped = 0;
  // Forward-compat schema watch state — shared across every SKU we read in
  // this refresh so we emit each watched attribute at most once per run.
  const schemaWatch = newSchemaWatchState();

  for (const m of uniqueModels) {
    // Time-budget guard: if we're close to the Lambda timeout, stop starting
    // new models so the tail (staleness scan + metric publish) still runs. A
    // hard timeout mid-loop skips publishStoredMetrics() entirely, which is why
    // the PricingRefreshAge / PricingGapCount alarms were flying blind. A
    // truncated run leaves prior rows intact (they're independent PutItems) and
    // signals PricingRefreshIncomplete so the shortfall is visible.
    if (remainingMs() < TIME_BUDGET_RESERVE_MS) {
      skipped = uniqueModels.length - refreshed - gaps.length;
      logger.warn('pricing-refresher time budget reached; stopping model loop early', {
        refreshed,
        gaps: gaps.length,
        skipped,
        remainingMs: remainingMs(),
      });
      break;
    }
    const regional = await resolveModelPricing(m, schemaWatch);

    // Did we find any priced SKU at all (token, image, video, audio, search)?
    const found = Object.values(regional).some(
      (r) => Object.keys(r.dimensions).length > 0,
    );
    if (found) {
      await writePricingRow(m.modelId, m.modelName, m.providerName, 'pricing-api', regional);
      refreshed++;
      continue;
    }

    // Feature-fallback: Stability AI sub-feature endpoints don't have their
    // own SKUs but bill at the parent generative model's rate.
    const fallback = featureFallbackFor(m.modelId);
    if (fallback) {
      const fallbackTable: RegionalPricing = {};
      for (const region of METERED_REGIONS) {
        const skus = await fetchAllSkus('AmazonBedrockFoundationModels', [
          { Type: 'TERM_MATCH', Field: 'servicename', Value: fallback.servicename },
          { Type: 'TERM_MATCH', Field: 'regionCode', Value: region },
        ]).catch(() => [] as SkuJson[]);
        for (const sku of skus) {
          // Forward-compat: same schema watch on the feature-fallback path
          // since it also queries AmazonBedrockFoundationModels.
          checkFoundationModelsSchema(sku, schemaWatch);
          const usage = sku.product.attributes.usagetype;
          if (!usage) continue;
          const priced = firstOnDemandPrice(sku);
          if (!priced) continue;
          const tokenKind = classifyFoundationModelsUsage(usage);
          if (tokenKind) {
            const per1k = toPricePer1k(priced.price, 'AmazonBedrockFoundationModels');
            recordTokenPrice(fallbackTable, region, tokenKind, per1k, usage);
            continue;
          }
          const nonTokenKind = classifyNonTokenUsage(usage, priced.unit);
          if (nonTokenKind) {
            recordNonTokenPrice(fallbackTable, region, nonTokenKind, priced.unit, priced.price, usage);
          }
        }
      }
      const fallbackFound = Object.values(fallbackTable).some(
        (r) => Object.keys(r.dimensions).length > 0,
      );
      if (fallbackFound) {
        await writePricingRow(
          m.modelId,
          m.modelName,
          m.providerName,
          'pricing-api-feature-fallback',
          fallbackTable,
          fallback.note,
        );
        refreshed++;
        continue;
      }
    }

    gaps.push(m.modelId);
    metrics.addMetric('PricingGapCount', MetricUnit.Count, 1);
    logger.info('No pricing found across any dimension', { modelId: m.modelId, modelName: m.modelName });
  }

  // Pass 2: handle Nova short-name reconciliation. The map gives us model IDs
  // that may not be in ListFoundationModels by exact name; query AmazonBedrock
  // by the human short name and write under the static modelId.
  for (const [novaName, novaId] of Object.entries(NOVA_SHORT_NAMES)) {
    if (byId.has(novaId)) continue; // already covered
    const regional: RegionalPricing = {};
    for (const region of METERED_REGIONS) {
      await refreshAmazonBedrock(novaName, region, regional).catch(() => undefined);
    }
    if (Object.keys(regional).length > 0) {
      const id = novaModelIdFor(novaName) ?? novaId;
      await writePricingRow(id, novaName, 'Amazon', 'pricing-api', regional);
      refreshed++;
    }
  }

  // Suppress unused warning while resolveModelIdFromServicename remains in
  // the public API for follow-on work (servicename-only flows in
  // AmazonBedrockService).
  void resolveModelIdFromServicename;

  // Emit the REAL staleness age (now - oldest fetchedAt among LIVE models) so
  // the 36h alarm is reachable — previously hard-coded to 0, which pinned the
  // alarm OK forever. Live set = models AWS still lists (byId) + the statically
  // reconciled Nova IDs; deprecated models' lingering rows are excluded so they
  // don't pin the metric past 36h forever (see computePricingRefreshAgeSeconds).
  const liveModelIds = new Set<string>(byId.keys());
  for (const [novaName, novaId] of Object.entries(NOVA_SHORT_NAMES)) {
    liveModelIds.add(novaModelIdFor(novaName) ?? novaId);
  }
  const pricingRefreshAgeSeconds = await computePricingRefreshAgeSeconds(Date.now(), liveModelIds);
  metrics.addMetric('PricingRefreshAge', MetricUnit.Seconds, pricingRefreshAgeSeconds);
  // Emit a truncation signal so a run that hit the time budget is visible (and
  // alarmable) rather than silently under-refreshing. 0 on a complete run.
  const incomplete = skipped > 0;
  metrics.addMetric('PricingRefreshIncomplete', MetricUnit.Count, incomplete ? 1 : 0);
  metrics.addMetric('PricingModelsSkipped', MetricUnit.Count, skipped);

  // Self-cost: pricing-refresher runs daily and is dominated by Lambda
  // compute (Pricing API calls themselves are free). DDB cost is roughly
  // one PutItem per refreshed model row.
  recordSelfCost('pricing-refresher', Date.now() - startedAt, getConfiguredMemoryMb(), {
    ddbReads: 0,
    ddbWrites: refreshed,
  });
  metrics.publishStoredMetrics();

  logger.info('pricing-refresher complete', {
    refreshed,
    gapCount: gaps.length,
    skipped,
    incomplete,
    pricingRefreshAgeSeconds,
  });
  return { refreshed, gaps, incomplete };
};

/**
 * Test-only surface for the order-independent SKU-selection logic (module-
 * private otherwise). Not part of the runtime API.
 */
export const __test = { recordTokenPrice, recordNonTokenPrice };
