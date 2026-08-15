/**
 * Canonical Bedrock provider display names.
 *
 * The pricing table gets its `provider` from two sources that disagreed on
 * casing: the pricing-refresher stamps it verbatim from
 * `bedrock:ListFoundationModels.providerName` (vendor-cased, e.g. `"OpenAI"`),
 * while manual-override rows had no `provider` and the UI derived a lowercase
 * one from the model-id namespace (`"openai"`). That split rendered OpenAI (and
 * any override-priced provider) as TWO providers in the filter/sort/column.
 *
 * `canonicalProvider()` collapses any input — a stored provider string OR a bare
 * model id — to the single vendor-cased label, so all rows agree regardless of
 * source. The map is keyed on the lowercase model-id PREFIX (the namespace
 * before the first `.`), because several providers can't be recovered by
 * title-casing the prefix (`ai21`→`AI21 Labs`, `nvidia`→`NVIDIA`, `mistral`→
 * `Mistral AI`, `zai`→`Z.AI`, …) and several use internal caps
 * (`MiniMax`, `TwelveLabs`, `DeepSeek`). Verified against the live
 * ListFoundationModels providerName set (2026-07-30).
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
  moonshotai: 'Moonshot AI', // both prefixes are live and map to one vendor
  nvidia: 'NVIDIA',
  openai: 'OpenAI',
  qwen: 'Qwen',
  stability: 'Stability AI',
  twelvelabs: 'TwelveLabs',
  writer: 'Writer',
  zai: 'Z.AI',
};

/** Title-case fallback for an unknown prefix (`foo-bar` → `Foo-bar`). */
const titleCase = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/**
 * Extracts the provider prefix from a model id, stripping any cross-region
 * inference prefix (`us.`/`eu.`/`apac.`/`ap.`/`global.`) first, then taking the
 * namespace before the first remaining `.`.
 */
const prefixOfModelId = (modelId: string): string => {
  const stripped = modelId.replace(/^(us|eu|apac|ap|global)\./, '');
  const dot = stripped.indexOf('.');
  return (dot > 0 ? stripped.slice(0, dot) : stripped).toLowerCase();
};

/**
 * Returns the canonical vendor-cased provider name for a row. Prefers an
 * explicit stored `provider` (mapped through the same table so a lowercase or
 * mis-cased stored value is normalized too), else derives it from the model id.
 * Falls back to a title-cased prefix for any provider not in the table, and
 * `'Unknown'` when neither input is usable.
 */
export const canonicalProvider = (
  storedProvider: string | undefined,
  modelId: string | undefined,
): string => {
  const key = (storedProvider ?? '').trim().toLowerCase() || prefixOfModelId(modelId ?? '');
  if (!key) return 'Unknown';
  return PROVIDER_BY_PREFIX[key] ?? titleCase(key);
};
