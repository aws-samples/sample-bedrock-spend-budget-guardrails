/**
 * Multi-dimensional Bedrock pricing model.
 *
 * Bedrock charges by several different units depending on the model:
 *   - tokens (chat / embeddings / cache read+write)
 *   - images (resolution-tiered)
 *   - audio seconds (in / out)
 *   - video seconds (out)
 *   - search units (rerank)
 *
 * A single `Pricing` row therefore carries a `dimensions` map keyed by
 * dimension kind. The meter at request time looks at every usage field on
 * the Bedrock invocation log, multiplies it by the matching dimension's
 * `pricePerUnit`, and sums the result into one USD cost.
 *
 * Legacy single-token rows that only carry `inputPer1k` / `outputPer1k` are
 * handled transparently — `dimensionsOf()` synthesizes a `dimensions` map
 * from them.
 */

export type DimensionKind =
  | 'inputTokens'
  | 'outputTokens'
  | 'cacheReadTokens'
  | 'cacheWriteTokens'
  | 'outputImages'
  | 'inputVideoSeconds'
  | 'outputVideoSeconds'
  | 'inputAudioSeconds'
  | 'outputAudioSeconds'
  | 'searchUnits'
  | 'embedTokens';

export interface Dimension {
  /** Unit name from the Pricing API or operator override. Free-text. */
  unit: string;
  /**
   * Price per 1 unit of `unit`. So for `outputImages` with `unit: 'image'`,
   * pricePerUnit = $/image. For `inputTokens` with `unit: '1K tokens'`,
   * pricePerUnit = $/1K tokens (i.e. multiply by `inputTokenCount / 1000`).
   */
  pricePerUnit: number;
  /** Human label displayed in the UI (e.g., "Input tokens", "1024×1024 image"). */
  label?: string;
  /** Optional notes from the operator (override flow). */
  notes?: string;
}

export interface PricingRow {
  /** Top-level dimensions discovered by the refresher (or set via override). */
  dimensions?: Partial<Record<DimensionKind, Dimension>>;
  /** Per-region overrides; missing keys fall back to top-level `dimensions`. */
  regionDimensions?: Record<string, Partial<Record<DimensionKind, Dimension>>>;
  /**
   * Per-ROUTING-MODE overrides (`global`, keyed by `routingModeOf`'s output).
   * Highest precedence: an invocation routed via a `global.` inference
   * profile is billed at AWS's distinct Global SKU rate, which for several
   * lineups (Anthropic frontier ~9% below regional, OpenAI GPT-5.6 below
   * regional) differs from the regional rate — so when the meter passes a
   * routing mode and the row has an entry for it, those dimensions win over
   * regionDimensions/dimensions. Missing kinds fall back per-dimension.
   * Populated by the refresher from `*_Global` / `*-global-standard` SKUs,
   * or authored on manual override rows.
   */
  routingDimensions?: Record<string, Partial<Record<DimensionKind, Dimension>>>;

  // ---- Legacy fields (still populated for backward compatibility) ----
  /** $/1K input tokens. Equivalent to `dimensions.inputTokens`. */
  inputPer1k?: number;
  /** $/1K output tokens. Equivalent to `dimensions.outputTokens`. */
  outputPer1k?: number;
  cacheReadPer1k?: number;
  cacheWritePer1k?: number;
  regionRates?: Record<
    string,
    {
      inputPer1k?: number;
      outputPer1k?: number;
      cacheReadPer1k?: number;
      cacheWritePer1k?: number;
    }
  >;
}

/** Usage counters extracted from a Bedrock invocation log. */
export interface UsageCounts {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  outputImages?: number;
  inputVideoSeconds?: number;
  outputVideoSeconds?: number;
  inputAudioSeconds?: number;
  outputAudioSeconds?: number;
  searchUnits?: number;
  embedTokens?: number;
}

const TOKEN_DIMENSIONS: DimensionKind[] = [
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'embedTokens',
];

const isTokenDimension = (kind: DimensionKind): boolean => TOKEN_DIMENSIONS.includes(kind);

/**
 * Returns the merged dimension map for a row, considering the regional
 * override and synthesizing legacy `inputPer1k`/`outputPer1k`/cache-* fields
 * if no `dimensions` map is set. When `routing` is provided and the row has
 * `routingDimensions[routing]`, those dimensions are layered LAST (highest
 * precedence) — a Global-routed invocation is billed at the Global SKU rate,
 * not the source region's regional rate.
 */
export const dimensionsOf = (
  row: PricingRow | undefined,
  region: string,
  routing?: string,
): Partial<Record<DimensionKind, Dimension>> => {
  if (!row) return {};

  // Start with top-level explicit dimensions, then layer regional dimensions.
  const merged: Partial<Record<DimensionKind, Dimension>> = { ...(row.dimensions ?? {}) };
  const regionalDims = row.regionDimensions?.[region];
  if (regionalDims) Object.assign(merged, regionalDims);
  // Routing mode wins over region: the routing SKU already IS the billed
  // rate for this traffic regardless of which region sourced it.
  const routingDims = routing ? row.routingDimensions?.[routing] : undefined;
  if (routingDims) Object.assign(merged, routingDims);

  // Synthesize from legacy token fields for rows that haven't been migrated.
  const regional = row.regionRates?.[region];
  const inputRate = regional?.inputPer1k ?? row.inputPer1k;
  const outputRate = regional?.outputPer1k ?? row.outputPer1k;
  const cacheReadRate = regional?.cacheReadPer1k ?? row.cacheReadPer1k;
  const cacheWriteRate = regional?.cacheWritePer1k ?? row.cacheWritePer1k;
  if (merged.inputTokens === undefined && inputRate !== undefined) {
    merged.inputTokens = { unit: '1K tokens', pricePerUnit: inputRate, label: 'Input tokens' };
  }
  if (merged.outputTokens === undefined && outputRate !== undefined) {
    merged.outputTokens = { unit: '1K tokens', pricePerUnit: outputRate, label: 'Output tokens' };
  }
  if (merged.cacheReadTokens === undefined && cacheReadRate !== undefined) {
    merged.cacheReadTokens = { unit: '1K tokens', pricePerUnit: cacheReadRate, label: 'Cache read tokens' };
  }
  if (merged.cacheWriteTokens === undefined && cacheWriteRate !== undefined) {
    merged.cacheWriteTokens = { unit: '1K tokens', pricePerUnit: cacheWriteRate, label: 'Cache write tokens' };
  }
  return merged;
};

/**
 * Converts one usage counter + dimension into USD. Token dimensions use
 * `count / 1000 * pricePerUnit` (they're priced per 1K tokens); other
 * dimensions use `count * pricePerUnit` directly.
 */
const costOfDimension = (kind: DimensionKind, count: number, dim: Dimension): number => {
  if (count <= 0) return 0;
  return isTokenDimension(kind)
    ? (count / 1000) * dim.pricePerUnit
    : count * dim.pricePerUnit;
};

export interface CostBreakdown {
  /** Total USD cost across all priced dimensions. */
  spendUsd: number;
  /** Per-dimension USD cost (only dimensions with non-zero usage are present). */
  dimensionsCost: Partial<Record<DimensionKind, number>>;
  /** Per-dimension usage counts (echoed back so callers can persist them). */
  dimensionsUsage: Partial<Record<DimensionKind, number>>;
  /**
   * `true` iff at least one usage field had a matching priced dimension.
   * `false` for unpriced models (alarms via `bbg.UnpricedInvocations`).
   * Also `false` if no usage fields were non-zero.
   */
  priced: boolean;
}

/**
 * Computes total USD cost + per-dimension breakdown for one invocation.
 *
 * Rules:
 *   - Walk every non-zero counter in `usage`. Skip counters with no matching
 *     priced dimension (those become "unpriced" — counts towards the
 *     UnpricedInvocations metric).
 *   - For tokens-as-dimensions, divide count by 1000 before multiplying.
 *   - `priced` is true iff at least one (count, dimension) pair contributed
 *     to spend.
 */
export const computeCost = (
  pricing: PricingRow | undefined,
  region: string,
  usage: UsageCounts,
  /**
   * an earlier change "Custom pricing discount": a per-account percentage (0–100)
   * reflecting a negotiated/discounted Amazon Bedrock rate. When set, list
   * prices are scaled by `(1 - discountPct/100)` so metered spend reflects
   * effective cost. Applied uniformly to the total AND every per-dimension
   * cost so the dashboard's dimension breakdown stays internally consistent.
   * Out-of-range values are clamped to [0, 100]; undefined/0 = list price.
   */
  discountPct?: number,
  /**
   * Inference routing mode extracted from the invocation's model id
   * (`routingModeOf`): `'global'` for `global.`-profile traffic. Selects
   * `routingDimensions[routing]` rates when the row carries them; undefined
   * or an unlisted mode falls back to regional/default dimensions.
   */
  routing?: string,
): CostBreakdown => {
  const dims = dimensionsOf(pricing, region, routing);
  // Clamp defensively — the config write-path validates 0–100, but a bad
  // stored value must never produce a negative or >list charge.
  const factor =
    discountPct === undefined ? 1 : 1 - Math.min(100, Math.max(0, discountPct)) / 100;
  const dimensionsCost: Partial<Record<DimensionKind, number>> = {};
  const dimensionsUsage: Partial<Record<DimensionKind, number>> = {};
  let total = 0;
  let priced = false;
  let anyUsage = false;
  let anyMissing = false;

  const consider = (kind: DimensionKind, count: number | undefined): void => {
    if (count === undefined || count <= 0) return;
    anyUsage = true;
    dimensionsUsage[kind] = count;
    const dim = dims[kind];
    if (!dim) {
      anyMissing = true;
      return;
    }
    // `priced` reflects that the model HAD a rate for this dimension —
    // computed pre-discount so a 100% discount (factor 0) doesn't
    // masquerade as "unpriced" and trip the UnpricedInvocations alarm.
    const listCost = costOfDimension(kind, count, dim);
    if (listCost > 0) {
      const c = listCost * factor;
      dimensionsCost[kind] = c;
      total += c;
      priced = true;
    }
  };

  consider('inputTokens', usage.inputTokens);
  consider('outputTokens', usage.outputTokens);
  consider('cacheReadTokens', usage.cacheReadTokens);
  consider('cacheWriteTokens', usage.cacheWriteTokens);
  consider('outputImages', usage.outputImages);
  consider('inputVideoSeconds', usage.inputVideoSeconds);
  consider('outputVideoSeconds', usage.outputVideoSeconds);
  consider('inputAudioSeconds', usage.inputAudioSeconds);
  consider('outputAudioSeconds', usage.outputAudioSeconds);
  consider('searchUnits', usage.searchUnits);
  consider('embedTokens', usage.embedTokens);

  return {
    spendUsd: Number(total.toFixed(6)),
    dimensionsCost,
    dimensionsUsage,
    // priced=false means EITHER the model had no priced dimensions for any
    // observed usage, OR no usage was recorded. anyMissing distinguishes the
    // first case so the meter can emit UnpricedInvocations correctly.
    priced: priced || (anyUsage && !anyMissing),
  };
};
