/**
 * PRIMARY pricing source: the AWS **Price List bulk offer files**.
 *
 * The refresher's data source is the AWS Price List, which is exposed two ways:
 * the *Query* API (`pricing:GetProducts`) and static, public, no-auth JSON
 * "offer files" under `https://pricing.us-east-1.amazonaws.com/offers/...` (the
 * exact feed behind the AWS pricing website / calculator). Both read the SAME
 * Price List — identical rates — but the Query API is low-TPS and throttles
 * hard (~140 models × N regions × several servicename candidates = thousands of
 * sequential throttled calls), while the offer files are a handful of static
 * downloads. So the refresher prices off the offer files first and only falls
 * back to `GetProducts` for anything the offer files missed (e.g. a model
 * published to the Query index before the daily offer file caught up).
 *
 * Bedrock's Price List is split across TWO service codes, each with its own
 * offer file, and the refresher must read BOTH:
 *   - `AmazonBedrock` — newer models keyed by the `model` attribute
 *     (Nova, DeepSeek, GLM, gpt-oss, Llama, older Claude 2/3, …), `1K tokens`.
 *   - `AmazonBedrockFoundationModels` — Marketplace-billed models keyed by
 *     `servicename` ("… (Amazon Bedrock Edition)"), no `model` attribute,
 *     `1M tokens` (the whole Anthropic Claude 3.x/4.x/5 lineup, Cohere
 *     Command/Embed/Rerank, AI21 Jurassic, Palmyra, Stability, Luma, TwelveLabs).
 * Loading only `AmazonBedrock` would silently drop the entire Claude lineup.
 *
 * The per-region file (`.../<serviceCode>/<version>/<region>/index.json`) is a
 * strict superset in shape of a `GetProducts` result: its
 * `products[sku].attributes` carry the same `model` / `servicename` /
 * `usagetype` / `inferenceType` / `regionCode`, and `terms.OnDemand[sku][term]
 * .priceDimensions[rc]` carries the same `{ pricePerUnit.USD, unit }`. So we
 * reshape each product into the `SkuJson` the refresher already parses and run
 * the SAME classify+record path — no new classifier logic.
 *
 * IMPORTANT: the offer files are the same Price List as `GetProducts` — NOT a
 * way to obtain prices AWS hasn't published to the Price List. A model absent
 * from the Query API is absent from the offer files too; both read the same
 * feed.
 *
 * OpenAI on Bedrock illustrates the boundary:
 *   - The open-weight `gpt-oss-*` family (120b, 20b, safeguard variants) IS
 *     published under `AmazonBedrock` and prices normally through this path.
 *   - The proprietary GPT-5.x frontier models are served on Bedrock's Mantle
 *     inference engine. They ARE commercially available and priced on the
 *     Bedrock pricing *website*, but their SKUs are not surfaced through the
 *     Price List API / bulk offer files (as of 2026-08, some commercial-region
 *     SKUs are absent entirely and others appear only as `us-gov-*`). So neither
 *     the Query API nor these offer files can price them — this is a Price List
 *     publishing gap, not a refresher bug. Pricing those needs a manual override
 *     until AWS publishes the commercial SKUs to the Price List.
 */

interface BulkPriceDimension {
  unit: string;
  pricePerUnit: { USD?: string };
  description?: string;
}
interface BulkOfferFile {
  products: Record<
    string,
    { sku: string; productFamily?: string; attributes: Record<string, string | undefined> }
  >;
  terms?: {
    OnDemand?: Record<string, Record<string, { priceDimensions: Record<string, BulkPriceDimension> }>>;
  };
}

/** Same shape `fetchAllSkus` yields, so callers reuse the existing parse path. */
export interface OfferSku {
  product: { sku: string; attributes: Record<string, string | undefined> };
  terms: {
    OnDemand?: Record<string, { priceDimensions: Record<string, BulkPriceDimension> }>;
  };
}

const OFFERS_HOST = 'https://pricing.us-east-1.amazonaws.com';

/**
 * The two Bedrock service codes whose offer files together cover the whole
 * Bedrock Price List (see the module header). Both are fetched per region.
 */
export const BULK_SERVICE_CODES = ['AmazonBedrock', 'AmazonBedrockFoundationModels'] as const;
export type BulkServiceCode = (typeof BULK_SERVICE_CODES)[number];

const regionIndexUrl = (serviceCode: BulkServiceCode): string =>
  `${OFFERS_HOST}/offers/v1.0/aws/${serviceCode}/current/region_index.json`;

const fetchJson = async (url: string): Promise<unknown> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
};

/**
 * Loads and reshapes one service code's bulk offer file for one region into
 * `OfferSku[]`. Resolves the per-region file URL from the small
 * `region_index.json` (so we ride AWS's current published version rather than
 * hard-coding a version string). One offer file per (serviceCode, region);
 * cache across models in the caller. Only products carrying an on-demand price
 * are returned.
 */
export const loadRegionOfferSkus = async (
  region: string,
  serviceCode: BulkServiceCode = 'AmazonBedrock',
): Promise<OfferSku[]> => {
  const regionIndex = (await fetchJson(regionIndexUrl(serviceCode))) as {
    regions?: Record<string, { currentVersionUrl?: string }>;
  };
  const rel = regionIndex.regions?.[region]?.currentVersionUrl;
  if (!rel) throw new Error(`${serviceCode} region_index has no entry for ${region}`);
  const file = (await fetchJson(`${OFFERS_HOST}${rel}`)) as BulkOfferFile;

  const onDemand = file.terms?.OnDemand ?? {};
  const out: OfferSku[] = [];
  for (const [sku, product] of Object.entries(file.products ?? {})) {
    const termsForSku = onDemand[sku];
    if (!termsForSku) continue; // no on-demand price (e.g. reserved-only) — skip
    out.push({
      product: { sku, attributes: product.attributes },
      terms: { OnDemand: termsForSku },
    });
  }
  return out;
};
