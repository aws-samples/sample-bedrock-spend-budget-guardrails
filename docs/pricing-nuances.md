# AWS Pricing API integration nuances

Bedrock pricing comes from the AWS Price List Query API. Three service codes — `AmazonBedrockFoundationModels`, `AmazonBedrock`, `AmazonBedrockService` — each with subtle inconsistencies. The `pricing-refresher` Lambda papers over them and produces a single canonical `Pricing[modelId]` row.

## Verified facts (probed live 2026-05-13)

### Schemas

| Service code | Advertised attributes |
|---|---|
| `AmazonBedrockFoundationModels` | `termType, location, locationType, usagetype, regionCode, servicename, operation` (7 total) |
| `AmazonBedrock` | 24 attributes incl. `model, provider, inferenceType` |
| `AmazonBedrockService` | 17 attributes incl. `model, provider, inferenceType, crossRegion, tokenType` |

`AmazonBedrockFoundationModels` does NOT have `modelId`, `model`, `provider`, or `inferenceType`. The AWS Samples script that documents using `attributes.modelId` is wrong for this service code.

### Catalog overlap

- **`AmazonBedrockFoundationModels`** — 50 `servicename`s (re-counted 2026-07-30), all suffixed `(Amazon Bedrock Edition)`. Hosts newer Anthropic (Sonnet 4.x, Opus 4.x, Haiku 4.5), Cohere (incl. Embed 3/4), Jamba, Jurassic-2, Llama 2, Palmyra X4/X5, Stable Diffusion, TwelveLabs, Luma Ray2.
- **`AmazonBedrock`** — 84 model names across 14 providers (re-counted 2026-07-30). Older Claude (2.x, 3.x), DeepSeek, Gemma 3, Llama 3/4, Mistral/Voxtral/Ministral, Nova (incl. Nova 2), NVIDIA Nemotron, Qwen, Z AI, etc. Sonnet 4.x is **NOT** in this catalog.
- **`AmazonBedrockService`** — 3 models (Claude Sonnet 4 / 4.5 / Ray v2). Niche.

The refresher therefore queries **all three** and merges results.

## Cross-API workaround

Because `AmazonBedrockFoundationModels` lacks `modelId`, we join Bedrock's `bedrock:ListFoundationModels` against the Pricing API by **`servicename`**:

1. List `bedrock:ListFoundationModels` for every metered region. Build `(modelId, modelName, providerName)` tuples.
2. For each model, query `pricing:GetProducts(ServiceCode="AmazonBedrockFoundationModels", servicename="<modelName> (Amazon Bedrock Edition)", regionCode=<region>)`.
3. Strip the `(Amazon Bedrock Edition)` suffix from `attributes.servicename` to recover the modelName, then look it up in our index.
4. Walk every SKU; classify input/output/cache-read/cache-write by parsing `usagetype`.

For `AmazonBedrock` and `AmazonBedrockService`, use the structured `model` and `inferenceType` attributes directly.

### Name-join is the dominant failure mode (verified 2026-07-30)

`GetProducts` matches by exact `TERM_MATCH`, so when no candidate string matches, it returns **zero** SKUs and the model gaps *before any classifier runs*. A live replay of the matcher against every model (131 unique across the 3 metered regions) found **37 gaps — all name-join failures, none a genuine unpriced model**. So a non-zero `PricingGapCount` is almost always a BBG-side join bug, not AWS lagging on pricing.

To handle this the refresher expands each LFM name through, in order:
1. an exact verified alias — [`model-aliases.ts`](../lambda/src/pricing-refresher/model-aliases.ts), keyed on `modelId`, for free-form marketing renames no rule can derive (e.g. `cohere.embed-v4:0` → `Cohere Embed 4 Model`; `deepseek.r1-v1:0` → `R1`);
2. a generalized normalizer — [`name-variants.ts`](../lambda/src/pricing-refresher/name-variants.ts): parenthesized-version strip (`Mistral Large (24.02)` → `Mistral Large`), hyphen→space (`DeepSeek-R1`), training-qualifier strip (`IT`/`PT`/`BF16`/`VL`/`dense`/`Instruct`), integer→`x.0` (`Nova 2 Lite` → `Nova 2.0 Lite`), and version repositioning (`Nova 2 Sonic` → `Nova Sonic 2.0`, `Ministral 3 8B` → `Ministral 8B 3.0`).

Variants are tried **longest-first** and the AmazonBedrock walk **breaks on the first non-empty result** — critical because a broad variant can mis-join to a *different* model (e.g. `Mistral Large 3` → the legacy `Mistral Large`, an 8x-pricier SKU). Broadening the matcher trades gaps (visible, alarmed) for the risk of a silently-wrong price, so the pre-deploy gate is a full before/after rate diff, not just a gap count.

### SKUs with no `model` attribute at all

Titan embeddings, Amazon Rerank 1.0, and Nova Multimodal Embeddings SKUs carry **no `model` attribute** — `GetProducts(AmazonBedrock, model="Titan Text Embeddings V2")` returns 0. They are keyed by `titanModel` (e.g. `TitanEmbeddingsV2-Text-input`), `feature="Reranker"`, or only by `usagetype`. The refresher reaches them with a `USAGETYPE_PREFIX` map + a `Type=CONTAINS,Field=usagetype` pass (see below). `isExcluded` still drops the Provisioned/Reserved/Customization noise these substrings also return.

Note: embeddings ride on the **`inputTokens`** dimension, NOT `embedTokens`. `embedTokens` exists in `DimensionKind` but is intentionally never written — the meter emits no `embedTokens` counter (`meter/index.ts`), so pricing it there would leave every embedding call `UnpricedInvocations`. Titan/Cohere embed SKUs are literally named `-input-tokens` and correctly classify as `input`.

### Bulk offer files — the PRIMARY (throttle-free) source

`pricing:GetProducts` (the Query API) is low-TPS and throttles hard: pricing ~140 models × 5 regions × several servicename candidates fans out to thousands of sequential, throttled calls. At 5 metered regions this ran right at the 15-minute Lambda cap and started **truncating** — the time-budget guard stopped the loop after ~102 of 137 models, and because the model loop order is deterministic the *same* ~35 tail models (the entire Marketplace-billed Claude lineup, worst-case for the servicename fan-out) were skipped every run, so their `fetchedAt` never advanced and `PricingRefreshAge` climbed a day per run. See the runbook.

AWS publishes the **same** Price List data as static, public, no-auth JSON **offer files** — the feed behind the AWS pricing website / calculator. Pricing off these is pure in-memory filtering after a handful of static downloads, so the refresher now uses them as the **PRIMARY** source and demotes `GetProducts` to a fallback for anything bulk missed.

Bedrock's Price List is split across **two service codes**, and the refresher reads **both** offer files per region — loading only one silently drops half the catalogue:

- `AmazonBedrock` — newer models keyed by the **`model`** attribute (Nova, DeepSeek, GLM, `gpt-oss-*`, Llama, older Claude 2/3, …). Unit: `1K tokens`.
- `AmazonBedrockFoundationModels` — Marketplace-billed models keyed by **`servicename`** ("… (Amazon Bedrock Edition)"), **no `model` attribute**. Unit: `1M tokens` (so prices go through `toPricePer1k(…, 'AmazonBedrockFoundationModels')`, which divides by 1000). This file holds the entire Anthropic Claude 3.x/4.x/5 lineup, Cohere Command/Embed/Rerank, AI21 Jurassic, Palmyra, Stability, Luma, TwelveLabs.

Each service code's SKUs go through **its own** classifier (`classifyAmazonBedrockUsage` vs `classifyFoundationModelsUsage`) because the unit conventions differ. Files are pre-warmed once at the start of the run (`prewarmBulkOffers`) and cached by `(serviceCode, region)`. URLs:

- `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/<serviceCode>/current/region_index.json` → per-region file URLs (small, ~6KB).
- `.../<serviceCode>/<version>/<region>/index.json` → `{ products[sku].attributes, terms.OnDemand[sku][term].priceDimensions[rc] }`, a strict superset in shape of a `GetProducts` result. These per-region files are already region-scoped (every product's `regionCode` = the file's region), so no `regionCode` filter is needed in-memory.

When bulk leaves a model unpriced in a region, the refresher falls back to `GetProducts` (FoundationModels-by-servicename → AmazonBedrock-by-model → the `usagetype`-prefix CONTAINS pass for no-`model` SKUs) and emits **`PricingQueryFallbackUsed`**. A trickle is fine (offer files lagging the Query index for a brand-new model); a sustained high count means bulk coverage regressed and warrants investigation.

**This is a source swap for the same data, not a new data source.** Both the bulk files and `GetProducts` read the same Price List, so a model AWS hasn't published to the Price List is absent from both. Note the OpenAI distinction:

- The open-weight **`gpt-oss-*`** family (120b, 20b, and the safeguard variants) **is** published under `AmazonBedrock` and prices normally through this path.
- The proprietary **GPT-5.x** frontier models are served on Bedrock's **Mantle** inference engine. They **are** commercially available and priced on the Bedrock pricing *website*, but their SKUs are **not surfaced through the Price List API / bulk offer files** (as of 2026-08 some commercial-region SKUs are absent entirely, others appear only as `us-gov-*`). So neither the Query API nor the offer files can price them — this is a **Price List publishing gap, not a refresher bug**, and pricing them needs a manual override until AWS publishes the commercial SKUs.

Verified against the live feed by `lambda/test/pricing-bulk-offer.test.ts` and the `scripts/test-pricing-refresher.ts --all` dry-run (bulk-primary reproduces the prod table's rates exactly, 0 diffs, 2 expected `nova-reel` gaps).

### Filter operators

`Type=TERM_MATCH` is **case-insensitive** (`model=Minimax M2` and `MiniMax M2` both match), so no casing variants are generated. `Type=CONTAINS` **is** supported (load-bearing for the no-`model` embeddings/rerank path); `Type=ANY_OF` is **not**.

### One dimension, many rates — the collapse is lossy (and the meter can't disambiguate)

Some models expose several legitimate SKUs for a *single* dimension: Nova Canvas has 8 image rates (T2I/I2I × 1024/2048 × Standard/Premium, $0.04–$0.08); cache-write has 5-min vs 1h-TTL variants; Nova Sonic has both `speech-input-tokens` ($0.0034) and `text-input-tokens` ($0.00006) that both classify as `input`. The meter's invocation log carries only a coarse counter per dimension (one `outputImagesCount`, one `cacheWriteInputTokenCount`, one `inputTokenCount` — see `extractUsage` in `meter/index.ts`) with **no resolution / TTL / modality signal**, so a single rate must represent the dimension. The refresher therefore picks the **cheapest same-tier SKU** deterministically (the base/default tier — Bedrock's default cache TTL is 5-min, default image is Standard), which is stable across refreshes and preserves the least-surprising rate. A future improvement would be for Bedrock to surface the tier/resolution on the invocation log so the meter could select per-call; until then this is a documented approximation.

**Genuinely unpriceable (correctly left as gaps):** `amazon.nova-reel-v1:0/v1:1` price per *generated video* (`unit: video`, $0.08), but the meter emits `outputVideoSeconds` (duration), not a video count — there is no counter to multiply, so pricing it would create a phantom dimension. Same rationale as `nova-grounding` (`unit: Requests`) and the `Cohere Embed V4 Units` SKU.

### SLA tiers multiply SKUs per dimension — precedence is mandatory

A single dimension can surface many competing SKUs across tiers: standard, `-batch` (≈50% off), `-flex`, `-priority`, and `-cross-region-global`. Verified: Gemma 3 27B us-east-1 has **8 competing `input` SKUs** spanning batch/flex $0.00012, standard $0.00023, priority $0.00040 — a 3.3x spread. Without precedence the winner is decided by `GetProducts` response order. `skuPrecedence()` ([`usagetype.ts`](../lambda/src/pricing-refresher/usagetype.ts)) ranks batch worst, then flex/priority, then cross-region, then plain on-demand, and `claim()` ([`index.ts`](../lambda/src/pricing-refresher/index.ts)) makes the best-tier SKU win regardless of order. (The old `BATCH_PATTERNS=[/Batch/]` was case-sensitive and missed AmazonBedrock's lowercase `-batch`, so a batch rate could silently overwrite on-demand.)

**Global-routing SKUs are not just competitors — they're a real second rate.** `*_Global` / `*-global-standard` / `*-cross-region-global` variants bill Global-routed traffic at a genuinely different rate (verified against CUR 2026-08-20: Anthropic frontier bills Global ~9% *below* regional — Opus 5 input $0.005 vs $0.0055/1K). So in addition to their demoted role in the bare-dimension contest, `routingModeOfUsagetype()` routes them into the row's `routingDimensions.global` bucket (own `claim()` precedence via `routingBucketPrecedence()`: plain global beats flex/priority-global), and the meter prices any invocation whose model id carried a `global.` prefix from that bucket (`routingModeOf` in `shared/arn.ts` → `computeCost(..., routing)`).

### Model-alias maintenance

`MODEL_ALIASES` and `USAGETYPE_PREFIX` are hand-verified against the live API and are maintenance debt — an AWS rename silently reintroduces a gap. When `PricingGapCount` is non-zero, run the read-only harness `tsx scripts/test-pricing-refresher.ts --model <id>` (or `--all`) to see whether it's a join failure, then add an alias or extend the normalizer and re-run the harness to confirm 0 gaps before deploy.

## usagetype naming conventions

`AmazonBedrockFoundationModels` has at least three naming conventions in concurrent use:

| Convention | Example | Models |
|---|---|---|
| CamelCase | `USE1-MP:USE1_InputTokenCount_Global-Units` | Sonnet 4.6, Claude 3.5 Sonnet |
| snake_case + `_standard` | `USE1-MP:USE1_input_tokens_standard-Units` | Opus 4.7 |
| Million-prefixed batch | `APN1-MP:APN1_MillionBatchInputTokens-Units` | Claude 3.5 Sonnet (batch) |
| Reserved throughput | `APS7-MP:APS7_Reserved_1Month_InputTPM_Geo-Units` | Per-hour-per-1K-TPM, NOT a token rate (skip) |

Cache variants exist for newer Anthropic models: `CacheReadInputTokenCount`, `CacheWriteInputTokenCount`, `cache_write_tokens_1h_global_standard`. Anthropic prompt-caching pricing is materially different from base input rate.

`AmazonBedrock` uses kebab-case: `USE2-NovaMicro-input-tokens`, `USE1-deepseek.v3.2-input-tokens`. The `inferenceType` attribute (`Input tokens`, `Output tokens`) is the authoritative classifier; usagetype regex is the fallback.

## Per-token unit conventions

| Service code | Native unit | Conversion |
|---|---|---|
| `AmazonBedrockFoundationModels` | `Units` (= 1M tokens) | divide priced amount by 1,000,000 to get $/token |
| `AmazonBedrock`, `AmazonBedrockService` | `1K tokens` | already per-1K |

`AmazonBedrock` also contains non-token `unit` values that must be EXCLUDED from token-cost math: `TextUnit` (Guardrails), `1KTPMHour` (reserved tiers).

## Other gotchas

- **Cross-region inference profiles (CRIS)** — the *regional* prefixes (`us.`/`eu.`/`apac.`/`ap.`) are NOT separate Pricing SKUs. Probing `usagetype=USE1-us.anthropic.claude-sonnet-4-6-input-tokens` returns 0 results; those calls bill at the source region's rate using the bare-modelId SKU, and the meter strips the prefix before pricing lookup. **`global.` is the exception** (corrected 2026-08-20, previously claimed for all prefixes): Global routing has its own SKUs (`*_Global` / `*-global-standard`) at a genuinely different rate — Anthropic frontier bills Global ~9% below regional per CUR. The meter still strips `global.` for the spend-target key, but also passes the routing mode to `computeCost`, which prefers the row's `routingDimensions.global` rates.
- **Deprecated models** persist in the Pricing API after dropping out of `bedrock:ListFoundationModels`. Claude 3.5 Sonnet is a current example. The refresher keeps `source=pricing-api-historical` rows so historical invocations remain costable.
- **Newly launched models** can in principle have an initial window with no pricing in the API. In practice (verified 2026-07-30) the genuine-not-yet-priced set is currently **empty** — every live model has priced on-demand SKUs. So the steady-state `PricingGapCount` is 0 and any non-zero value should be triaged as a name-join bug first (see the runbook). Mitigation for a true launch gap is unchanged: the model surfaces on the Pricing UI page and admins can set a manual override.
- **Pricing API endpoints** are only `us-east-1`, `eu-central-1`, `ap-south-1`. The refresher Lambda runs in `us-east-1`.
- **`AmazonBedrock` non-Anthropic providers** (Cohere Embed, Palmyra X4/X5, TwelveLabs) need provider-prefix-aware matching when joining via `bedrock:ListFoundationModels.providerName`.
- **Amazon Nova short names** in `AmazonBedrock` (`Nova Micro`, `Nova Lite`, etc.) don't match `ListFoundationModels` modelNames cleanly. A static `nova-shortname → modelId` map (`lambda/src/pricing-refresher/nova-map.ts`) handles this.

## Forward-compat watch — `PricingApiSchemaChanged`

There is an open AWS feature request to add a stable `modelId` attribute to all three Bedrock service codes. Once it lands, the cross-reference workaround above can be retired in favor of a one-step direct lookup.

The `pricing-refresher` watches for this on every run. As it walks `AmazonBedrockFoundationModels` SKUs, it inspects each SKU's `attributes` for `modelId`, `inferenceType`, and `model` — three attributes that today are absent on every SKU on this service code. The first time any SKU on a run carries a populated value for one of those, the refresher emits `bbg.PricingApiSchemaChanged` (Sum=1) with an `attribute=<modelId|inferenceType|model>` dimension naming which one was found, and a structured log line that names the SKU + service code so we can correlate.

This is wired to a Sev5/informational alarm (`<stage>-bbg-pricing-api-schema-changed`) — see [`runbooks/alarms/pricing-api-schema-changed.md`](runbooks/alarms/pricing-api-schema-changed.md). Don't page on it; it's a refactor opportunity, not a failure.

When the alarm fires:
1. Confirm the change is durable (one full refresh cycle — partial backfill is real).
2. File a tech-debt story: collapse `cross-ref.ts` to a direct `pricing:GetProducts --filters Field=modelId,Value=<id>` call. `usagetype.ts`'s parsing logic is still needed (usagetype variants are unrelated to the modelId gap).
3. Retire the alarm + metric in the same PR.

Test coverage: [`lambda/test/pricing-schema-watch.test.ts`](../lambda/test/pricing-schema-watch.test.ts) asserts (a) no emission today (every fixture SKU lacks the attributes) and (b) a synthetic SKU with `attributes.modelId` populated triggers exactly one metric emission with the correct dimension.
