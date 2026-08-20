# Runbook: `cur-reconciler`

## Purpose

Daily Athena run that computes per-IAM-principal Bedrock spend from the CUR 2.0 IAM-principal export and compares it against the meter's **invocation ledger** (`<stage>_bbg_ledger.invocations`, `model#` targets only — `profile#` rows duplicate the same dollars), with **both sides watermarked to bill-complete days** (`now − 72h`, override `RECONCILE_WATERMARK_HOURS`) so CUR ingestion lag cannot register as drift. Differences are emitted as `ReconciliationDelta` (per-stage: `service=bbg, stage=<stage>`) and `ReconciliationDeltaUsd` (per-principal) CloudWatch metrics; CUR-only spend the stage never metered rolls into `ReconciliationUnmeteredSpend` instead. The alarm (`<stage>-bbg-reconciliation-delta`, `> $1`, 3 days) exists only on stages listed in `bbg:reconciliationAlarmStages` (default `["prod"]`). Triggered by EventBridge Scheduler at `cron(0 6 * * ? *)` UTC, four hours after the daily Glue crawler at `cron(0 2 * * ? *)` keeps the CUR table schema in sync.

## Symptoms

- CloudWatch alarm `dev-bbg-reconciliation-delta` fires (`ReconciliationDelta > $1` for 3 consecutive eval periods).
- Lambda log line `CUR query failed; reconciliation skipped` — Athena returned an error or the table doesn't exist.
- `ReconciliationDeltaUsd` per-principal metrics consistently elevated for the same principals (typically a missing metering path for that caller, e.g. a service-linked role bypassing CWL invocation logs).
- Lambda response payload is `{"deltas": 0}` for every run despite real Bedrock spend in the account — usually means the Athena query returned zero rows.

## Likely causes (in order)

1. **CUR 2.0 IAM-principal export not yet delivering.** The export has to be created once via the Billing console (the `Include caller identity (IAM principal) allocation data` checkbox is UI-only, not exposed by `bcm-data-exports:CreateExport`). If the operator hasn't enabled it, or if it was just enabled, the first delivery can take ~24-48h. Currently waiting on first IAM-principal CUR delivery (~2026-05-17).
2. **Glue crawler hasn't run / table schema stale.** The reconciler depends on `<stage>_bbg_cur.<curTable>` (defaults: `dev_bbg_cur.data`). If the `dev-bbg-cur-crawler` was disabled or its IAM role lost S3 read perms, the table either doesn't exist or has stale columns.
3. **`CUR_DATABASE` / `CUR_TABLE` env vars wrong.** Driven by `bbg:curDatabase` / `bbg:curTable` operator-config keys, defaulting to `cur2_database` / `cur2_export` (legacy) and overridden by `CurStack` to `<stage>_bbg_cur` / `data`. If the operator's actual Glue table name doesn't match `data` (the leaf-prefix convention), set `bbg:curTable` accordingly.
4. **Athena workgroup denied or budget-blocked.** Workgroup `<stage>-bbg` has a per-query data-scanned cap; reconciler queries on a young CUR table (large monthly partition) can blow the cap.
5. **Real metering drift.** The principals showing nonzero per-principal delta are using Bedrock through a path the meter doesn't see (e.g. a service-linked role that doesn't emit invocation logs, or a new API surface the CWL log group doesn't subscribe to). This is the legitimate alarm and the one to investigate via the meter logs.
6. **Pricing drift.** Meter and CUR diverge by a uniform percentage — usually means a model launched mid-month and the pricing-refresher's Day-1 rate differs from CUR's actual rate. Resolves at the next daily refresh.

## Investigation

```bash
# Last reconciler run.
aws logs tail /aws/lambda/dev-bbg-cur-reconciler --since 36h --region us-west-2

# Schedule and crawler state.
aws scheduler get-schedule --name dev-bbg-cur-reconcile --region us-west-2
aws glue get-crawler --name dev-bbg-cur-crawler --region us-west-2

# Does the Glue table exist?
aws glue get-table --database-name dev_bbg_cur --name data --region us-west-2

# What's in the table? Look at columns to confirm line_item_iam_principal is present.
aws glue get-table --database-name dev_bbg_cur --name data --region us-west-2 \
  --query 'Table.StorageDescriptor.Columns[?contains(Name, `principal`) == `true`]'

# Run the reconciler query manually for the current period in the Athena console
# or via CLI:
aws athena start-query-execution --region us-west-2 \
  --work-group dev-bbg \
  --query-string "SELECT line_item_iam_principal, sum(line_item_unblended_cost)
                  FROM dev_bbg_cur.data
                  WHERE bill_billing_period_start_date >= TIMESTAMP '2026-05-01 00:00:00'
                    AND product_servicecode IN ('AmazonBedrock','AmazonBedrockFoundationModels','AmazonBedrockService')
                  GROUP BY 1"

# Cross-check meter totals for the same period.
aws dynamodb scan --table-name dev-bbg-running-spend --region us-west-2 \
  --filter-expression "period = :p" \
  --expression-attribute-values '{":p":{"S":"2026-05"}}' \
  --query 'Items[].[principal.S, target.S, spendUsd.N]' --output table

# Manual invoke of the reconciler with an explicit period (defaults to current).
aws lambda invoke --function-name dev-bbg-cur-reconciler \
  --region us-west-2 \
  --cli-binary-format raw-in-base64-out \
  --payload '{"period":"2026-05"}' /tmp/recon.json && cat /tmp/recon.json
```

## Remediation

### Cause 1 — CUR export not delivering

Confirm the CUR export exists in the management account's Billing console and is shipping IAM-principal-allocation data. The export name doesn't matter, but the S3 destination must match `bbg:curS3Bucket` and `bbg:curS3Prefix` operator-config values. New exports take up to 24-48h for first delivery; you can't accelerate it.

```bash
# Check the destination bucket has data.
aws s3 ls s3://<curS3Bucket>/<curS3Prefix>/ --recursive | head -20
```

If the bucket is empty after 48h, verify the export's status via the Billing console (Cost & Usage Reports page) — there's no useful CLI for this.

### Cause 2 — Glue crawler issue

```bash
# Trigger an immediate crawl.
aws glue start-crawler --name dev-bbg-cur-crawler --region us-west-2

# Watch its state.
aws glue get-crawler --name dev-bbg-cur-crawler --region us-west-2 \
  --query 'Crawler.{State:State, LastCrawl:LastCrawl}'
```

If the crawler errors with `AccessDenied` on the S3 prefix, verify the crawler role has `s3:GetObject` and `s3:ListBucket` on `arn:aws:s3:::<curS3Bucket>/<curS3Prefix>/*`. Redeploy `CurStack` to restore the role.

### Cause 3 — Wrong table name

Find the actual table name produced by the crawler:

```bash
aws glue get-tables --database-name dev_bbg_cur --region us-west-2 \
  --query 'TableList[].Name'
```

If it isn't `data`, set the operator-config:

```bash
aws ssm put-parameter --name /bbg/operator-config --type String --overwrite \
  --value "$(aws ssm get-parameter --name /bbg/operator-config --query 'Parameter.Value' --output text \
            | jq '. + {"bbg:curTable": "<actual-table-name>"}')"
```

Then redeploy `CurStack` (the env var is set at synth time):

```bash
BBG_LOCAL=1 npx cdk deploy 'DevAppStage/Cur-us-west-2'
```

### Cause 4 — Athena workgroup blocked

Check the workgroup's `BytesScannedCutoffPerQuery` and the query's actual scan size:

```bash
aws athena get-query-execution --query-execution-id <id> --region us-west-2 \
  --query 'QueryExecution.Statistics'
```

Either raise the cap or partition-prune by adding `bill_billing_period_start_date BETWEEN ...` (already present in the reconciler's query but only as `>=`).

### Cause 5 — Real drift (the alarm doing its job)

Pull the top per-principal deltas and look at the offending principals' invocation patterns:

```bash
# Per-principal metric.
aws cloudwatch list-metrics --namespace bbg --metric-name ReconciliationDeltaUsd \
  --region us-west-2 --output table

# Most common cause: a principal calling Bedrock via a path that doesn't emit
# the CWL invocation log we subscribe to. Check the bedrock model invocation
# logging config:
aws bedrock get-model-invocation-logging-configuration --region us-west-2

# If logging is off or pointed at a different log group, fix it:
aws bedrock put-model-invocation-logging-configuration --region us-west-2 \
  --logging-config '{"cloudWatchConfig":{"logGroupName":"/aws/bedrock/dev-invocations-us-west-2","roleArn":"<bedrock-logging-role>"}}'
```

If a service-linked role is calling Bedrock and bypassing the meter (e.g. through Bedrock's managed agents API path), the long-term fix is to extend the meter's CWL subscription or add a CloudTrail-data-event-based meter path.

### Cause 6 — Pricing drift

Check if the offending principals are using a model that recently launched. Compare the meter's stored cost against the CUR cost for one invocation:

```bash
# Get the meter's stored row.
aws dynamodb get-item --table-name dev-bbg-running-spend --region us-west-2 \
  --key '{"principal":{"S":"principal#arn:aws:iam::123:role/foo"},"sk":{"S":"2026-05#model#anthropic.claude-sonnet-4-6"}}'

# Get the pricing row used to compute it.
aws dynamodb get-item --table-name dev-bbg-pricing --region us-west-2 \
  --key '{"model":{"S":"anthropic.claude-sonnet-4-6"}}'
```

If `fetchedAt` predates the launch, force a pricing refresh (see [`pricing-refresher.md`](pricing-refresher.md)).

## Idempotency / safety notes

- **Safe to re-run any time.** The reconciler only emits CloudWatch metrics — no DDB / S3 writes. Repeated runs produce the same metric values for the same period.
- **No catch-up logic.** If the Lambda misses a day, that day's drift never surfaces — but the next day's run still works because the query window is the entire current `period`. To inspect a past period, invoke with `{"period":"YYYY-MM"}`.
- **Per-principal metric cardinality is capped at 20** (`deltas.slice(0, 20)`). If you have more than 20 principals over threshold, the others are missing from CloudWatch but still counted in the aggregate `ReconciliationDelta`.
- **CUR query partition-prunes on `bill_billing_period_start_date`.** Each Athena query scans only the current month's partitions. If the `period` arg points at a closed month, the scan is bounded to that month's parquet files only.
- **No DDB writes.** This is a strictly read-only Lambda from the application's perspective; the only side effect is CloudWatch `PutMetricData` (scoped to the `bbg` namespace via IAM condition).

## Related runbooks

- [`pricing-refresher.md`](pricing-refresher.md) — drift Cause 6 typically traces back to a stale pricing row.
- [`meter-unjoined.md`](meter-unjoined.md) — drift Cause 5 typically traces back to invocations the meter never saw.
- [`ledger-writer.md`](ledger-writer.md) — same per-principal data, different consumer (S3 ledger for historical Athena queries).
