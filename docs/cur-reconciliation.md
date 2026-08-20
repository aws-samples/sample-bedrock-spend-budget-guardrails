# CUR 2.0 reconciliation

The real-time meter is BBG's primary signal for stopping cost overruns. **CUR 2.0 IAM-principal cost allocation** is the secondary signal — the auditor that closes the books and catches anything the meter missed.

## How it works

1. Enable CUR 2.0 in the management account console with the **Include caller identity (IAM principal) allocation data** option.
2. Activate the `iamPrincipal/*` cost-allocation tags in Billing → Cost Allocation Tags.
3. The `cur-reconciler` Lambda runs daily at 06:00 UTC. It:
   - Computes a **reconciliation watermark** of `now − 72h` (override: `RECONCILE_WATERMARK_HOURS`). CUR line items land 8–24h after the usage they bill — and Marketplace-billed model SKUs (the entire Anthropic Claude lineup) were observed settling later than 48h — while the meter records an invocation within seconds; comparing a real-time total against a lagging one guarantees a phantom "drift" equal to the last day-or-two of spend for any active principal. Windowing **both** sides to end at the watermark means every row in the comparison is bill-complete, so a non-zero delta is a real discrepancy, not ingestion latency.
   - Queries the CUR 2.0 export via Athena for per-principal Bedrock spend with `line_item_usage_start_date < watermark`.
   - Queries the **S3/Athena invocation ledger** (`<stage>_bbg_ledger.invocations`, written by `ledger-writer` off the RunningSpend stream) for per-principal metered spend with `recordedat < watermark`, summing **`model#` targets only** — the meter writes the same dollars to a `profile#` row alongside every `model#` row when an inference profile was used (so admins can budget either dimension), and identity-lens rows are already excluded at write time; counting either duplicate class would inflate the meter side. The ledger — not the RunningSpend DynamoDB table — is the meter side of the comparison: RunningSpend only holds month-running cumulative totals, which cannot be windowed to the watermark.
   - Splits the population: principals the meter knows get a `bbg.ReconciliationDelta` metric (`stage=<stage>` dimension) — any delta here means the meter and the bill disagree about spend the meter **did** see. CUR-only principals (pre-deployment history, another stage's traffic, structural bypasses like `bedrock-mantle`) roll up into `bbg.ReconciliationUnmeteredSpend` instead — real signal, but not fixable by fixing the meter, so it must not feed the drift alarm.
   - Logs the top-20 per-principal breakdown of both populations (meter vs CUR vs delta) every run.
4. Alarm `<stage>-bbg-reconciliation-delta` fires when the stage's own `ReconciliationDelta` is > $1 for 3 consecutive days. The `stage` metric dimension keeps dev's and prod's reconcilers on separate series — without it, a barely-metering dev install comparing itself against the whole account's CUR holds the prod alarm red. The alarm itself is additionally **stage-gated** by `bbg:reconciliationAlarmStages` (default `["prod"]`): in a shared-account dev+prod install only one stage owns the invocation-log subscription, so only that stage's reconciliation is meaningful. The metric publishes on every stage regardless; single-stage forks deploying only dev should set `["dev"]`.

## What it catches

- **Meter bugs**: the meter under-counted somewhere (e.g., a CRIS-prefixed model id we didn't strip).
- **Bypass paths**: usage that bypassed our metering entirely (e.g., a Bedrock feature added later that doesn't produce model invocation logs).
- **Pricing drift**: our Pricing table has stale rates because the daily refresh stopped working.

## What it doesn't catch

- **Real-time abuse**: CUR is 8–24h delayed. By the time it sees the spike, the meter+enforcement loop has already attached a deny policy (or should have).
- **Sub-account allocation**: CUR aggregates across the management account only. For per-account budgets you still need the meter.

## Turning it on

This is a manual one-time setup in the management account because CUR 2.0 export creation is restricted to the payer:

```
aws cur put-report-definition --report-definition '{
  "ReportName": "bbg-cur-2",
  "TimeUnit": "HOURLY",
  "Format": "Parquet",
  "Compression": "Parquet",
  "AdditionalSchemaElements": ["RESOURCES", "SPLIT_COST_ALLOCATION_DATA", "MANUAL_DISCOUNT_COMPATIBILITY", "INCLUDE_CALLER_IDENTITY"],
  "S3Bucket": "<your-cur-bucket>",
  "S3Prefix": "bbg",
  "S3Region": "us-east-1",
  "ReportVersioning": "OVERWRITE_REPORT"
}' --region us-east-1
```

Then activate the `iamPrincipal/*` tags in the Billing console.

The `cur-reconciler` Lambda's `CUR_DATABASE` and `CUR_TABLE` env vars (set in `CurStack`) point at the Athena database and table that the CUR export's Glue crawler creates. Until those exist, the reconciler logs "CUR query failed; reconciliation skipped" and exits cleanly — alarms don't fire.

## Why this is "follow-on" not "MVP"

The real-time meter alone is sufficient for stopping abuse. CUR reconciliation adds:

- **Defense in depth** against meter bugs.
- **Authoritative dollars** for finance reporting (the meter approximates from a daily-refreshed pricing table; CUR has the actual billed amount).

It's worth wiring up before going to production, but a single-account demo can defer it.

## Principal-key canonicalization

CUR's `line_item_iam_principal` records the assumed-role session form for any role-based caller:

```
arn:aws:sts::ACCT:assumed-role/<RoleName>/<Session>
```

BBG's meter (and therefore the ledger the reconciler reads) keys the same caller by the canonical role ARN:

```
arn:aws:iam::ACCT:role/<RoleName>
```

Without canonicalization the reconciler treats every distinct session as its own principal and emits N false-positive deltas per role (one per session, plus the canonical-form row). The reconciler applies `regexp_replace(...)` in the Athena `GROUP BY` to collapse sessions to the canonical role ARN before crossing the wire, with a defensive in-process `canonicalizeCurPrincipal` (`lambda/src/shared/arn.ts`) covering any edge case the regex misses.

SSO assumed-role sessions get a best-effort match: CUR's principal lacks the `aws-reserved/sso.amazonaws.com/<region>/` path segment that CloudTrail's `sessionContext.sessionIssuer.arn` carries, so SSO callers may still partially mismatch until both sides converge. Documented limitation; revisit if SSO usage grows.

### Pre-deployment history

CUR reflects the entire calendar month including spend from before BBG was deployed in the account. Those rows have no matching meter entries — the reconciler classifies them as **unmetered** and rolls them into `bbg.ReconciliationUnmeteredSpend` (dashboard-only) rather than the alarmed `ReconciliationDelta`, so they cannot false-page. They roll off naturally on the first of the next month when the period changes. The reconciler's "CUR spend with no meter counterpart" log line lists the top-20 unmetered principals per run; to break one down by day, run an Athena query like:

```sql
SELECT date_trunc('day', line_item_usage_start_date) AS day,
       sum(line_item_unblended_cost) AS spend
FROM <cur_db>.data
WHERE line_item_iam_principal LIKE '%<RoleName>%'
  AND product_servicecode IN ('AmazonBedrock', 'AmazonBedrockFoundationModels', 'AmazonBedrockService')
GROUP BY 1 ORDER BY 1
```

If most of the spend is on days before BBG's first deploy, that's expected — not a bug.

### What day 1 looks like

On a fresh install the first reconciler run typically shows a large
`bbg.ReconciliationUnmeteredSpend` value — the CUR export carries usage from before BBG
was deployed, so spend BBG never metered lands in the unmetered rollup (see
"Pre-deployment history" above) and rolls off at the next period boundary. The alarmed
`ReconciliationDelta` series only covers principals the meter has actually seen, so it
starts near zero.

Expect the most recent ~72h to be excluded from every run — that's the reconciliation
watermark doing its job, not missing data.
