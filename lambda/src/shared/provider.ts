import { stripCrisPrefix } from './arn.js';

/**
 * Canonical Bedrock provider display names, keyed on the lowercase model-id
 * prefix. Matches the vendor casing `bedrock:ListFoundationModels.providerName`
 * returns (which the pricing-refresher stamps verbatim), so a manual pricing
 * override — which otherwise has no provider — gets the SAME string and doesn't
 * split into a second provider in the UI. Several can't be recovered by
 * title-casing the prefix (`ai21`→`AI21 Labs`, `nvidia`→`NVIDIA`, `zai`→`Z.AI`,
 * …). Verified against the live providerName set (2026-07-30). Mirrors
 * `web/src/components/providerName.ts` (lambda and web don't share code).
 */
const PROVIDER_BY_PREFIX: Record<string, string> = {
  ai21: 'AI21 Labs',
  amazon: 'Amazon',
  anthropic: 'Anthropic',
  cohere: 'Cohere',
  deepseek: 'DeepSeek',
  google: 'Google',
  luma: 'Luma AI',
  meta: 'Meta',
  minimax: 'MiniMax',
  mistral: 'Mistral AI',
  moonshot: 'Moonshot AI',
  moonshotai: 'Moonshot AI',
  nvidia: 'NVIDIA',
  openai: 'OpenAI',
  qwen: 'Qwen',
  stability: 'Stability AI',
  twelvelabs: 'TwelveLabs',
  writer: 'Writer',
  zai: 'Z.AI',
};

const titleCase = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/**
 * Derives the canonical vendor-cased provider name from a model id (e.g.
 * `openai.gpt-5.6-luna` → `OpenAI`). Strips any CRIS prefix first, maps the
 * namespace before the first `.` through the table, and falls back to a
 * title-cased prefix for an unknown provider. Returns `'Unknown'` for an empty
 * id.
 */
export const providerFromModelId = (modelId: string): string => {
  const stripped = stripCrisPrefix(modelId ?? '');
  const dot = stripped.indexOf('.');
  const prefix = (dot > 0 ? stripped.slice(0, dot) : stripped).toLowerCase();
  if (!prefix) return 'Unknown';
  return PROVIDER_BY_PREFIX[prefix] ?? titleCase(prefix);
};
