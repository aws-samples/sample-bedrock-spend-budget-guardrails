# Pricing coverage and historical corrections

BBG prefers AWS Price List data. When commercial SKUs are absent, the refresher uses reviewed AWS website rates in `lambda/src/pricing-refresher/published-pricing.ts`. Each fallback carries a source URL and `verifiedAt`; scheduled refreshes do not advance that review date. Operator overrides are preserved.

## Rates and usage

- Frontier OpenAI prices include input, output, cache reads, and 30-minute cache writes. Global routing has separate rates.
- `contextTiers` selects the rate for the whole request when input plus cache-read plus cache-write tokens reaches `minInputTokens`. For current OpenAI tiers, long-context rates start at 272,001 input tokens.
- Explicit service-tier multipliers apply only where supported. An unsupported tier is flagged as unpriced instead of silently using Standard.
- Any missing rate for an observed dimension makes an invocation partially unpriced; known dimensions still contribute spend.
- Known single-image Stability APIs use one generation for successful synchronous invocation metadata with an output content type when counters are absent. Explicit zero counters and errors never trigger this fallback. Other records with no supported counters emit `MeterUsageMissing`; explicit failures without usage are excluded. Error records with nonzero counters still enter metering.
- Foundation-model and inference-profile ARNs are normalized before pricing lookup.
- Nova Reel's US Price List entries label the unit `video`, but their descriptions explicitly bill per second. That specific documented form is normalized to seconds; arbitrary video-count units are not converted.
- Ray v2 preserves both Standard and HD SKUs under `videoOutputPricing`. Generation settings select the resolution and requested five- or nine-second duration. For metadata-only logs, the verified 1024×1024, 24fps, 4.75-second completed output maps to a five-second HD charge. Other incomplete signatures remain unpriced. The usage counter retains the observed media duration; `videoBilling` in the ledger records the billing interpretation. This rule applies only to Ray v2.

The pricing page shows base rates and identifies rows with routing/context variants. Editing base rates preserves existing routing, context, and video variants. The base video rate alone does not describe every resolution.

## Monitoring

Application metrics use `service=bbg, stage=<stage>`. Update custom dashboards that previously queried only the service dimension.

| Metric | Meaning |
|---|---|
| `PricingGapCount` | One daily gauge, including zero, for models unresolved by API or reviewed website fallback |
| `PricingRefreshAge` | Age of the oldest live automatically refreshed row |
| `PricingFallbackAge` | Age of the oldest live website review or manual override; alarm after 30 days |
| `UnpricedInvocations` | Committed primary invocations with wholly or partially missing rates; profile/lens updates do not duplicate the count |
| `MeterUsageMissing` | Invocation metadata with no supported counters; explicit failures without usage and zero streaming-start records are excluded |
| `ReconciliationUnattributedSpend` | CUR dollars without caller identity, including models whose account-level totals reconcile |

## Historical repair

Adding a price does not reprice previously accumulated usage. Replaying the original request encounters the existing request-ID guard. Do not delete those guards.

The ledger now preserves usage/cost maps, request IDs, routing, service tiers, discounts, and effective timestamps. New unpriced writes also retain `unpricedRequestIds` for targeted recovery.

For historical data, prepare a reviewed JSON plan using the `SpendCorrection` schema and `correctionIdFor()` in `lambda/src/shared/spend-corrections.ts`. The plan specifies the account, region, stage, discovered ledger bucket, pricing basis, and corrections.

1. Establish the original missing amount from invocation metadata and ledger evidence. Do not infer that a model was free because its CUR rows are absent.
2. Include matching profile and identity-lens accumulators in the same correction, but include only primary model dollars in the ledger.
3. For existing usage, change dollars and outstanding unpriced counts without adding tokens again. A legacy zero-dollar ARN row can be moved atomically to its canonical target with an exact source-state condition.
4. Review the dry-run summary:

   ```bash
   npx tsx scripts/apply-spend-repairs.ts /path/to/reviewed-plan.json
   ```

5. Apply the same immutable plan:

   ```bash
   npx tsx scripts/apply-spend-repairs.ts /path/to/reviewed-plan.json --apply
   ```

The runner verifies the credential account, writes the plan to the existing encrypted ledger bucket, and applies conditional DynamoDB transactions. It emits deterministic ledger objects with original effective dates. Rerunning the same plan recovers from an interrupted ledger write without applying money twice.

Reconciliation compares `coalesce(effectiveat, recordedat)` with the billing watermark. Legacy records still use their original ingestion time. Keep unmatched billing estimates visible: changing estimates to zero or raising the alarm threshold does not repair missing billing data.
