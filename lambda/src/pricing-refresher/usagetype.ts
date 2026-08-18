/**
 * Classifies a Bedrock Pricing API SKU's `usagetype` (and optional
 * `inferenceType` attribute on AmazonBedrock/AmazonBedrockService) into one
 * of the dimension kinds we surface in the multi-dim Pricing schema.
 *
 * Returns `null` for SKUs we deliberately skip (reserved throughput, batch,
 * custom-model variants, etc.).
 *
 * Token-pricing variants verified against captured fixtures for: Sonnet 4.6
 * (CamelCase), Opus 4.7 (snake_case + `_standard` suffix), Claude 3.5 Sonnet
 * (CamelCase + Million-batch variants), Nova Micro (kebab-case in
 * AmazonBedrock service code).
 *
 * Image / video / audio / search variants based on observed Bedrock SKU
 * naming conventions; the refresher's matcher path also exposes a
 * `dimensionKind` extension that bypasses this token-only classifier when
 * the SKU's `unit` clearly identifies a non-token charge type.
 */
export type TokenKind = 'input' | 'output' | 'cacheRead' | 'cacheWrite';

/**
 * Wider dimension classifier for non-token SKUs. Returns null if the SKU
 * isn't recognized as one of these — caller falls back to the token
 * classifier.
 */
export type NonTokenKind =
  | 'outputImages'
  | 'inputVideoSeconds'
  | 'outputVideoSeconds'
  | 'inputAudioSeconds'
  | 'outputAudioSeconds'
  | 'searchUnits';

const RESERVED_PATTERNS = [/Reserved/i, /TPM/i];
// Case-INSENSITIVE: AmazonBedrockFoundationModels uses CamelCase
// (`MillionBatchInputTokens`) but the AmazonBedrock service code uses a
// lowercase kebab suffix (`USE1-NovaMicro-input-tokens-batch`). The old
// `/Batch/` missed the latter, so a 50%-off batch SKU could overwrite the
// on-demand rate under last-write-wins (see skuPrecedence + `claim` in index.ts).
const BATCH_PATTERNS = [/batch/i];
// `-custom-model` is for fine-tuned/custom-model variants. Pricing differs
// from base on-demand pricing; we exclude them from the base Pricing row to
// avoid double-counting.
const CUSTOM_MODEL_PATTERNS = [/-custom-model$/];

const isExcluded = (usagetype: string, allowBatch = false): boolean => {
  if (RESERVED_PATTERNS.some((p) => p.test(usagetype))) return true;
  if (CUSTOM_MODEL_PATTERNS.some((p) => p.test(usagetype))) return true;
  if (!allowBatch && BATCH_PATTERNS.some((p) => p.test(usagetype))) return true;
  return false;
};

// Non-batch SLA tiers (flex/priority) and cross-region variants are NOT
// excluded — they're real prices — but they must never displace a plain
// on-demand SKU for the same dimension. A single dimension can surface many
// competing SKUs (verified: Gemma 3 27B us-east-1 has 8 `input` SKUs spanning
// batch/flex $0.00012, standard $0.00023, priority $0.00040 — a 3.3x spread
// decided purely by Pricing API response order without this).
const SLA_TIER_PATTERNS = [/[_-]flex(?:[_-]|$)/i, /[_-]priority(?:[_-]|$)/i];
// Cross-region / global inference variants. These are a DISTINCT rate from the
// plain regional SKU, and BBG meters against the source region's regional rate
// — so a plain regional on-demand SKU must always beat its `_Global`/
// cross-region sibling for the BARE model id.
//
// CAUTION (2026-08-18): the direction of that rate difference is NOT uniform.
// It was originally written assuming cross-region is "usually higher", which is
// true for the Anthropic lineup but FALSE for OpenAI GPT-5.6, where AWS prices
// Global BELOW in-Region/Geo. Precedence here is still correct — it only picks
// which SKU fills the BARE model's dimension — but it means a caller who used a
// `global.` inference profile can be metered at the higher regional rate.
//
// That is tolerable today only because GPT-5.6 has no Price List SKU at all and
// runs on manual override rows. When AWS publishes real GPT-5.6 SKUs, routing
// mode has to become part of the pricing KEY rather than something we collapse
// away in `stripCrisPrefix`; until then this comment is the warning. `_Global` is the FoundationModels
// CamelCase spelling (`USE1_InputTokenCount_Global-Units`); `cross-region` /
// `cross-region-global` is the AmazonBedrock kebab spelling.
const CROSS_REGION_PATTERNS = [/cross[_-]region/i, /[_-]global(?:[_-]|$)/i];

/**
 * Precedence rank for competing SKUs of the SAME dimension — LOWER wins. Plain
 * on-demand (`_standard` or no tier suffix) is authoritative; batch/flex/
 * priority/cross-region variants only fill a dimension no on-demand SKU set.
 * Batch ranks worst since it's the deepest discount and the most misleading if
 * it wins. See `claim()` in index.ts, which uses this to make SKU selection
 * order-independent.
 */
export const skuPrecedence = (usagetype: string): number => {
  if (BATCH_PATTERNS.some((p) => p.test(usagetype))) return 90;
  if (SLA_TIER_PATTERNS.some((p) => p.test(usagetype))) return 80;
  if (CROSS_REGION_PATTERNS.some((p) => p.test(usagetype))) return 20;
  return 0; // plain on-demand / `_standard`
};

/**
 * AmazonBedrockFoundationModels usagetypes (per-1M-token, `unit: "Units"`).
 * Multiple naming conventions coexist:
 *   - CamelCase:  USE1_InputTokenCount_Global-Units
 *                 USE1_CacheReadInputTokenCount-Units
 *                 USE1_CacheWrite1hInputTokenCount_Global-Units
 *   - snake_case: USE1_input_tokens_standard-Units
 *                 USE1_output_tokens_standard-Units
 *                 USE1_cache_write_tokens_1h_global_standard-Units
 */
export const classifyFoundationModelsUsage = (usagetype: string): TokenKind | null => {
  if (isExcluded(usagetype)) return null;

  // Cache variants must match BEFORE plain Input/Output checks because
  // CacheReadInputTokenCount contains "Input" as a substring.
  if (/CacheRead\w*Token/i.test(usagetype) || /cache[_-]read[_-].*token/i.test(usagetype)) {
    return 'cacheRead';
  }
  if (/CacheWrite\w*Token/i.test(usagetype) || /cache[_-]write[_-].*token/i.test(usagetype)) {
    return 'cacheWrite';
  }
  // After cache-token checks above, plain input/output. Anchor on a token
  // boundary that includes `_standard` and `-Units` suffixes that come right
  // after the "tokens" word in observed conventions.
  if (/InputTokenCount/i.test(usagetype) || /[_-]input[_-]tokens?(?:[_-]|$)/i.test(usagetype)) {
    return 'input';
  }
  if (/OutputTokenCount/i.test(usagetype) || /[_-]output[_-]tokens?(?:[_-]|$)/i.test(usagetype)) {
    return 'output';
  }
  return null;
};

/**
 * AmazonBedrock / AmazonBedrockService usagetypes (per-1K-token, `unit: "1K tokens"`).
 * Format: USE1-NovaMicro-input-tokens, USE1-deepseek.v3.2-input-tokens, etc.
 *
 * `inferenceType`, when populated, is the authoritative classifier — but
 * usagetype regex remains the fallback (and the cache-read/cache-write
 * disambiguation, since `inferenceType: "Input tokens"` covers both).
 */
export const classifyAmazonBedrockUsage = (
  usagetype: string,
  inferenceType?: string,
): TokenKind | null => {
  if (isExcluded(usagetype)) return null;

  // Cache variants take precedence over the inferenceType "Input tokens"
  // umbrella so we record cacheRead/cacheWrite separately.
  if (/cache[_-]read[_-].*token/i.test(usagetype)) return 'cacheRead';
  if (/cache[_-]write[_-].*token/i.test(usagetype)) return 'cacheWrite';

  // inferenceType is the structured authoritative classifier when populated.
  // Bedrock has many inferenceType variants — chat, audio-tokens,
  // image-tokens, video-tokens, prompt-cache, plus Flex/Priority SLA tiers.
  // We collapse all "input"-flavored ones into 'input' and likewise for
  // 'output' so the meter's per-token math works uniformly.
  if (inferenceType) {
    const it = inferenceType.toLowerCase();
    if (/prompt cache read/.test(it)) return 'cacheRead';
    if (/prompt cache write/.test(it)) return 'cacheWrite';
    // "Input ... token(s)" — covers Input tokens, Text Input Tokens,
    // Input Audio Token Count, Input Image Token Count,
    // Input Video Token Count, Speech Understanding input token, plus
    // Flex / Priority / batch suffixed variants.
    if (/^input.*token/.test(it) || /^text input.*token/.test(it) || /^speech.*input.*token/.test(it)) {
      return 'input';
    }
    if (/^output.*token/.test(it) || /^text output.*token/.test(it) || /^speech.*output.*token/.test(it)) {
      return 'output';
    }
  }

  if (/[_-]input[_-]tokens?(?:[_-]|$)/i.test(usagetype)) return 'input';
  if (/[_-]output[_-]tokens?(?:[_-]|$)/i.test(usagetype)) return 'output';
  return null;
};

/**
 * Converts a SKU's `pricePerUnit.USD` into our canonical `$ per 1K tokens`
 * representation. Service-code-aware:
 *   - AmazonBedrockFoundationModels: priced per 1M tokens (`unit: "Units"`)
 *     → multiply by 1/1000 to convert to per-1K.
 *   - AmazonBedrock / AmazonBedrockService: priced per 1K tokens (`unit:
 *     "1K tokens"`) → already in target units.
 */
export const toPricePer1k = (pricePerUnit: string | number, serviceCode: string): number => {
  const raw = typeof pricePerUnit === 'string' ? Number(pricePerUnit) : pricePerUnit;
  if (!Number.isFinite(raw)) return Number.NaN;
  if (serviceCode === 'AmazonBedrockFoundationModels') {
    return raw / 1000;
  }
  return raw;
};

/**
 * Best-effort classifier for non-token Bedrock SKUs. Bedrock's image / video
 * / audio / rerank pricing surfaces as distinct usagetype shapes:
 *
 *   image:   *Image*-Units, *image_*-Units, MillionImages, ImageOutput
 *   video:   *VideoOutput*Seconds*, video-output-seconds
 *   audio:   *AudioInput*Seconds*, *AudioOutput*Seconds* (also kebab-case)
 *   rerank:  *SearchUnit-Units, *search_unit*, KSearchUnits-Units
 */
export const classifyNonTokenUsage = (
  usagetype: string,
  unit: string | undefined,
): NonTokenKind | null => {
  if (RESERVED_PATTERNS.some((p) => p.test(usagetype))) return null;
  if (CUSTOM_MODEL_PATTERNS.some((p) => p.test(usagetype))) return null;

  // Audio: input vs output. Bedrock also emits a BARE `-second` (singular, no
  // "s") shape on the Nova Multimodal Embeddings SKUs
  // (`USE1-NovaMultiModalEmbeddings-input-audio-second`), so match `second`
  // with an optional trailing `s`.
  if (/AudioInput\w*Seconds?/i.test(usagetype) || /audio[_-]?input[_-]?seconds?/i.test(usagetype)) {
    return 'inputAudioSeconds';
  }
  if (/input[_-]audio[_-]seconds?/i.test(usagetype)) return 'inputAudioSeconds';
  if (/AudioOutput\w*Seconds?/i.test(usagetype) || /audio[_-]?output[_-]?seconds?/i.test(usagetype)) {
    return 'outputAudioSeconds';
  }
  // Video — input vs output (Pegasus charges by input video seconds; some
  // Nova / Luma video models charge per output video second).
  if (/VideoInput\w*Seconds?/i.test(usagetype) || /video[_-]?input[_-]?seconds?/i.test(usagetype)) {
    return 'inputVideoSeconds';
  }
  if (/inputVideoSecond/i.test(usagetype)) return 'inputVideoSeconds';
  if (/VideoOutput\w*Seconds?/i.test(usagetype) || /video[_-]?output[_-]?seconds?/i.test(usagetype)) {
    return 'outputVideoSeconds';
  }
  if (/outputVideoSecond/i.test(usagetype)) return 'outputVideoSeconds';
  // Search / rerank units
  if (/SearchUnit/i.test(usagetype) || /search[_-]?unit/i.test(usagetype)) {
    return 'searchUnits';
  }
  // Image output (broad: covers MillionImages, ImageOutput, image-output,
  // created_image, generated_image, etc.).
  if (
    /Image/i.test(usagetype) &&
    /(Output|count|generated|generation|standard|images|created)/i.test(usagetype)
  ) {
    return 'outputImages';
  }
  if (/created[_-]?image/i.test(usagetype)) return 'outputImages';
  // Fallback: lean on the SKU's `unit` field for image. Broadened from
  // exact `^image$` to a contains-match so Titan Multimodal Embeddings
  // (`Images Processed`) and Cohere Embed image SKUs (`Input Images`) are
  // captured — their unit isn't the bare word "image".
  if (unit && /image/i.test(unit)) return 'outputImages';
  if (unit && /^second/i.test(unit) && /Video/i.test(usagetype)) return 'outputVideoSeconds';
  if (unit && /search\s*unit/i.test(unit)) return 'searchUnits';

  return null;
};
