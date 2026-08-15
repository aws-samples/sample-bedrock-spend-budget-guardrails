/**
 * Explicit model-name aliases for the pricing-refresher's name-join, for the
 * free-form marketing renames NO normalization rule can derive (see
 * `name-variants.ts` for the derivable cases). Keyed on the stable Bedrock
 * `modelId`.
 *
 *   fm = exact `AmazonBedrockFoundationModels` servicename, WITHOUT the
 *        ` (Amazon Bedrock Edition)` suffix (the caller appends it).
 *   ab = exact `AmazonBedrock` `model` attribute value.
 *
 * Verified 2026-07-30 against the live AWS Pricing API (each value returns >=1
 * priced on-demand SKU in >=1 metered region). This is manual-maintenance debt:
 * an AWS rename silently reintroduces a gap, so the daily refresher runs a
 * staleness meta-check that alarms when an alias stops resolving. When adding an
 * entry, prove it with `scripts/test-pricing-refresher.ts --model <id>`.
 */
export const MODEL_ALIASES: Record<string, { fm?: string; ab?: string }> = {
  // Cohere embeddings — the marketing rename inserts/reorders the word "Model".
  'cohere.embed-english-v3': { fm: 'Cohere Embed 3 Model - English' },
  'cohere.embed-english-v3:0:512': { fm: 'Cohere Embed 3 Model - English' },
  'cohere.embed-multilingual-v3': { fm: 'Cohere Embed Model 3 - Multilingual' },
  'cohere.embed-multilingual-v3:0:512': { fm: 'Cohere Embed Model 3 - Multilingual' },
  'cohere.embed-v4:0': { fm: 'Cohere Embed 4 Model' },
  'luma.ray-v2:0': { fm: 'Luma Ray2' },
  // AmazonBedrock `model` renames.
  'deepseek.r1-v1:0': { ab: 'R1' },
  'deepseek.v3-v1:0': { ab: 'DeepSeek V3.1' },
  'mistral.devstral-2-123b': { ab: 'Devstral' },
  'mistral.magistral-small-2509': { ab: 'Magistral Small 1.2' },
  'mistral.voxtral-mini-3b-2507': { ab: 'Voxtral Mini 1.0' },
  'mistral.voxtral-small-24b-2507': { ab: 'Voxtral Small 1.0' },
  'mistral.ministral-3-3b-instruct': { ab: 'Ministral 3B 3.0' },
  'nvidia.nemotron-nano-9b-v2': { ab: 'NVIDIA Nemotron Nano 2' },
  'nvidia.nemotron-nano-12b-v2': { ab: 'NVIDIA Nemotron Nano 2 VL' },
  'qwen.qwen3-coder-30b-a3b-v1:0': { ab: 'Qwen3 Coder 30B A3B' },
};
