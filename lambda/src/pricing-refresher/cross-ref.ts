/**
 * Cross-reference helpers for joining `bedrock:ListFoundationModels`
 * (modelId ↔ modelName) with the AWS Pricing API. Required because the
 * AWS Samples documented approach of using `product.attributes.modelId`
 * does not work — that attribute is unpopulated in all three Bedrock
 * Pricing API service codes (verified 2026-05-13). See
 * `docs/pricing-nuances.md`.
 */

export interface FoundationModelSummary {
  modelId: string;
  modelName: string;
  providerName: string;
  modelLifecycle?: string;
}

const BEDROCK_EDITION_SUFFIX = ' (Amazon Bedrock Edition)';

/**
 * Strips the trailing ` (Amazon Bedrock Edition)` marketing suffix from
 * an `AmazonBedrockFoundationModels` `servicename` to recover something
 * resembling the modelName from `bedrock:ListFoundationModels`.
 */
export const stripBedrockEditionSuffix = (servicename: string): string => {
  if (servicename.endsWith(BEDROCK_EDITION_SUFFIX)) {
    return servicename.slice(0, -BEDROCK_EDITION_SUFFIX.length);
  }
  return servicename;
};

/**
 * Case-insensitive normalize for cross-source name comparison.
 * `bedrock:ListFoundationModels` returns `"Claude Sonnet 4.6"` while the
 * Pricing API may return `"Claude Sonnet 4.6"` or, with version-suffix
 * variations, `"Claude Sonnet 4 v1"` — this normalizer is intentionally
 * conservative (case + whitespace + trailing version markers only).
 */
const normalize = (name: string): string =>
  name.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Indexes `ListFoundationModels` output by normalized modelName so SKUs
 * can be looked up in O(1).
 */
export const indexByName = (
  models: FoundationModelSummary[],
): Map<string, FoundationModelSummary> => {
  const idx = new Map<string, FoundationModelSummary>();
  for (const m of models) idx.set(normalize(m.modelName), m);
  return idx;
};

/**
 * Resolves a Pricing API `servicename` to a canonical modelId by:
 *   1. Stripping the `(Amazon Bedrock Edition)` suffix.
 *   2. Looking up the resulting name in the FM index.
 *   3. Returning the modelId, or `undefined` if no match (signals a gap).
 */
export const resolveModelIdFromServicename = (
  servicename: string,
  fmIndex: Map<string, FoundationModelSummary>,
): string | undefined => {
  const stripped = stripBedrockEditionSuffix(servicename);
  return fmIndex.get(normalize(stripped))?.modelId;
};
