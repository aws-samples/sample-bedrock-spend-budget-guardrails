# CUR 2.0 reconciliation

The real-time meter is BBG's primary signal for stopping cost overruns. **CUR 2.0 IAM-principal cost allocation** is the secondary signal — the auditor that closes the books and catches anything the meter missed.

## How it works

1. Enable CUR 2.0 in the management account console with the **Include caller identity (IAM principal) allocation data** option.
2. Activate the `iamPrincipal/*` cost-allocation tags in Billing → Cost Allocation Tags.
3. The `cur-reconciler` Lambda runs daily at 06:00 UTC. It:
   - Queries the latest CUR 2.0 partition via Athena: `SELECT line_item_iam_principal, line_item_usage_type, sum(line_item_unblended_cost) GROUP BY 1, 2`.
   - Compares per-principal × per-usage-type aggregates to the meter's `RunningSpend` totals for the same window.
   - Emits a `bbg.ReconciliationDelta` CloudWatch metric per `(principal, usage type)` pair.
4. Alarm `bbg-reconciliation-delta` fires when delta > $1 OR delta > 5% sustained for 3 consecutive days.

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

BBG's RunningSpend keys the same caller by the canonical role ARN:

```
arn:aws:iam::ACCT:role/<RoleName>
```

Without canonicalization the reconciler treats every distinct session as its own principal and emits N false-positive deltas per role (one per session, plus the canonical-form row). The reconciler applies `regexp_replace(...)` in the Athena `GROUP BY` to collapse sessions to the canonical role ARN before crossing the wire, with a defensive in-process `canonicalizeCurPrincipal` (`lambda/src/shared/arn.ts`) covering any edge case the regex misses.

SSO assumed-role sessions get a best-effort match: CUR's principal lacks the `aws-reserved/sso.amazonaws.com/<region>/` path segment that CloudTrail's `sessionContext.sessionIssuer.arn` carries, so SSO callers may still partially mismatch until both sides converge. Documented limitation; revisit if SSO usage grows.

### Pre-deployment history

CUR reflects the entire calendar month including spend from before BBG was deployed in the account. Those rows have no matching meter entries and surface as legitimate-looking "drift" in the first reconciliation runs. The deltas roll off naturally on the first of the next month when the period changes. Operators investigating a large delta should first run an Athena query like:

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

On a fresh install the first reconciler run typically emits one `bbg.ReconciliationDelta`
data point per (principal × usage-type) pair, and the largest is usually a **pre-deployment
artifact** rather than a real drift: the CUR export carries usage from before BBG was
deployed, so spend BBG never metered shows up as a delta on an admin role's high-token
models. It matches the "Pre-deployment history" pattern above and rolls off at the next
period boundary.

Expect the most recent day or two to be empty in that first run — CUR export latency is
8–24 hours. Start measuring the real delta from the *second* daily run onward.

The `bbg-reconciliation-delta` alarm is configured to fire on **3 consecutive days** of breach, so the day-1 pre-deploy spike won't false-page provided no further breach occurs on 2026-05-20 / 2026-05-21.
