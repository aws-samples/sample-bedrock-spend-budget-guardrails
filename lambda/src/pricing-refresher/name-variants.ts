/**
 * Generalized model-name normalizer for the pricing-refresher's name-join.
 *
 * `bedrock:ListFoundationModels` (LFM) and the AWS Pricing API disagree on
 * model names in systematic ways: LFM appends training qualifiers the Pricing
 * API drops (`Gemma 3 27B PT` vs `Gemma 3 27B`), parenthesizes versions
 * (`Mistral Large (24.02)` vs `Mistral Large`), hyphenates (`DeepSeek-R1` vs
 * `R1`), or repositions the version (`Nova 2 Sonic` vs `Nova Sonic 2.0`). The
 * refresher queries `GetProducts` with an exact `TERM_MATCH`, so a single wrong
 * candidate string returns ZERO SKUs and the model gaps before any classifier
 * runs. This produces the full set of plausible Pricing-API spellings for one
 * LFM model name so at least one matches.
 *
 * Verified 2026-07-30: `TERM_MATCH` is case-INSENSITIVE, so no casing variants
 * are emitted. Variants are returned longest-first so the caller can `break` on
 * the first non-empty result and a broad variant can never shadow a more
 * specific one (which would mis-join to a different, wrongly-priced model — see
 * the `Mistral Large 3` → `Mistral Large` hazard the old inline logic hit).
 */

/** Training / precision / format qualifiers LFM appends but Pricing omits. */
const DROP_QUALIFIERS = /\s+(?:IT|PT|BF16|VL|dense|Instruct|Chat)\b/gi;

export const modelNameVariants = (modelName: string): string[] => {
  const out = new Set<string>();
  const seed = [
    modelName,
    modelName.replace(/^Amazon\s+/, ''),
    modelName.replace(/\s+Instruct\s*$/i, ''),
    modelName.replace(/\s+v?\d[\d.]*$/i, ''),
  ];
  for (const b of seed) {
    out.add(b);
    // "Mistral Large (24.02)" → "Mistral Large" AND "Mistral Large 24.02"
    out.add(b.replace(/\s*\(([^)]*)\)\s*$/, '').trim());
    out.add(b.replace(/\s*\(([^)]*)\)\s*$/, ' $1').trim());
    // "DeepSeek-R1" → "DeepSeek R1"; "Qwen3-Coder-30B-A3B" → spaces
    out.add(b.replace(/-/g, ' ').replace(/\s+/g, ' ').trim());
    // "Gemma 3 27B PT" → "Gemma 3 27B"; "…Nano 12B v2 VL BF16" → "…Nano 12B v2"
    out.add(b.replace(DROP_QUALIFIERS, '').replace(/\s+/g, ' ').trim());
    // "Nova 2 Lite" → "Nova 2.0 Lite" (a bare integer major → x.0)
    out.add(b.replace(/\b(\d)\b(?=\s)/g, '$1.0'));
    // "Nova 2 Sonic" → "Nova Sonic 2.0" (version moved to the end)
    const mv = b.match(/^(\S+)\s+(\d[\d.]*)\s+(.+)$/);
    if (mv) out.add(`${mv[1]} ${mv[3]} ${mv[2]}${mv[2].includes('.') ? '' : '.0'}`);
    // "Ministral 3 8B" → "Ministral 8B 3.0" (size/version swap + .0)
    const mm = b.match(/^(\S+)\s+(\d+)\s+(\d+B)$/);
    if (mm) out.add(`${mm[1]} ${mm[3]} ${mm[2]}.0`);
    // Strip a duplicated provider prefix ("NVIDIA Nemotron Nano 9B v2").
    out.add(b.replace(/^(NVIDIA|Writer|Cohere|Meta|Amazon|Google|Mistral(?: AI)?)\s+/i, ''));
  }
  // hyphen→space THEN qualifier-strip (covers "Qwen3-Coder-30B-A3B-Instruct").
  for (const b of [...out]) {
    out.add(b.replace(/-/g, ' ').replace(DROP_QUALIFIERS, '').replace(/\s+/g, ' ').trim());
  }
  // Most-specific (longest) first so a broad variant can't shadow a precise one.
  return [...out].filter(Boolean).sort((a, b) => b.length - a.length);
};
