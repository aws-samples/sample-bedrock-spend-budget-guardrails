# Runbook: `ledger-writer`

## Purpose

DynamoDB-stream consumer on `RunningSpend` that writes per-row deltas as JSONL events to the `LedgerBucket` S3 bucket, partitioned by `events/year=YYYY/month=MM/day=DD/`. The bucket is registered with a Glue database via partition projection so admins can query historical spend via Athena (`/admin/reports/query`). Deployed per-region by the metering stack as `<stage>-bbg-ledger-writer-<region>` and bound to `data.runningSpend` via a `DynamoEventSource` (batch size 50, 5-second window, retry 3x with bisect-on-error).

## Symptoms

- Reports page in the SPA returns empty results for `topSpenders` / `spendByModel` / `hourlyToday` / `perPrincipalPerModel` even when `RunningSpend` has data.
- Athena query against `<stage>_bbg_ledger.invocations` returns 0 rows for the current day's partition but `RunningSpend` has matching rows.
- Lambda logs in `/aws/lambda/dev-bbg-ledger-writer-us-west-2`: errors writing to S3 (`AccessDenied`, `KMS`-related), or "ledger written" lines stop appearing.
- Lambda's DDB stream iterator age climbs (`IteratorAge` metric on the event source mapping).
- S3 listing of `s3://<stage>-bbg-ledger-<account>-<region>/events/year=YYYY/month=MM/day=DD/` is empty for today.

## Likely causes (in order)

1. **DDB stream event source mapping disabled.** Most common cause for a sudden stop. The mapping can be disabled via API or auto-disabled if the Lambda fails repeatedly past the retry limit and bisect couldn't isolate a poison record.
2. **Lambda role lost S3 write or KMS encrypt grant.** Both `data.ledgerBucket.grantWrite(this.ledgerWriter)` and `data.key.grantEncrypt(this.ledgerWriter)` are needed; manifest as `AccessDenied` or `KMSAccessDenied`.
3. **All stream events filtered out by the no-delta short-circuit.** The handler computes `delta(next, prev)` and skips the row if `spendUsd`, `inputTokens`, and `outputTokens` are all zero. If something is causing `RunningSpend` to write rows with no actual change (e.g. a metadata-only update), the writer correctly skips them — but no S3 lines get written.
4. **Glue partition projection misconfigured / not refreshed.** The Athena consumer reads via partition projection, so new partitions become queryable as soon as `year/month/day` directories exist in S3. If the Glue table's `projection.*` properties were stripped, query returns 0 rows even though objects exist.
5. **`REMOVE` events on stream.** The handler explicitly skips `eventName === 'REMOVE'` events. Period rollover or admin DELETE on a `RunningSpend` row produces these — they're correctly ignored, but don't expect to see them in S3.

## Investigation

```bash
# Recent invocations and errors.
aws logs tail /aws/lambda/dev-bbg-ledger-writer-us-west-2 --since 1h --region us-west-2

# Event source mapping state (UUID is per-region, list to find it).
aws lambda list-event-source-mappings \
  --function-name dev-bbg-ledger-writer-us-west-2 \
  --region us-west-2 \
  --query 'EventSourceMappings[].[UUID, State, LastProcessingResult, EventSourceArn]'

# Stream iterator age (how stale is the stream we're behind on).
aws cloudwatch get-metric-statistics --namespace AWS/Lambda \
  --metric-name IteratorAge \
  --dimensions Name=FunctionName,Value=dev-bbg-ledger-writer-us-west-2 \
  --start-time "$(date -u -v-1H +%Y-%m-%dT%H:%M:%S)" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%S)" \
  --period 60 --statistics Maximum --region us-west-2

# Bucket name (cross-stack output or look up the bucket directly).
LEDGER_BUCKET=$(aws lambda get-function-configuration \
  --function-name dev-bbg-ledger-writer-us-west-2 \
  --region us-west-2 --query 'Environment.Variables.LEDGER_BUCKET' --output text)

# Today's partition.
TODAY=$(date -u +%Y/%m/%d | sed 's|/|/month=|; s|/|/day=|; s|^|year=|')
aws s3 ls s3://$LEDGER_BUCKET/events/year=$(date -u +%Y)/month=$(date -u +%m)/day=$(date -u +%d)/ \
  --region us-west-2

# Confirm the Glue table has projection enabled.
aws glue get-table --database-name dev_bbg_ledger --name invocations --region us-west-2 \
  --query 'Table.Parameters'
# Expected: projection.enabled=true, projection.year.*, projection.month.*, projection.day.*
```

## Remediation

### Cause 1 — Event source mapping disabled

```bash
UUID=$(aws lambda list-event-source-mappings \
  --function-name dev-bbg-ledger-writer-us-west-2 --region us-west-2 \
  --query 'EventSourceMappings[0].UUID' --output text)

aws lambda update-event-source-mapping --uuid $UUID \
  --enabled --region us-west-2
```

If it disables again immediately, look at `LastProcessingResult` for the underlying error (poison record, throttle, etc.). With `bisectBatchOnError: true` configured, the runtime will isolate the bad record into its own batch and eventually park it after `retryAttempts: 3` exhaust — check the Lambda's DLQ if one is configured, or CloudWatch Logs for the bisect events.

### Cause 2 — IAM regression

Verify the Lambda role's permissions:

```bash
ROLE=$(aws lambda get-function --function-name dev-bbg-ledger-writer-us-west-2 \
  --region us-west-2 --query 'Configuration.Role' --output text | awk -F/ '{print $NF}')

aws iam list-attached-role-policies --role-name $ROLE
aws iam list-role-policies --role-name $ROLE
```

Re-deploy `MeteringStack` to restore IAM:

```bash
BBG_LOCAL=1 npx cdk deploy 'DevAppStage/Metering-us-west-2'
```

### Cause 3 — Spurious updates filtered

Not an error — confirm by inspecting a recent stream event. If the meter is producing many no-op `MODIFY` events, fix at the source (the meter, not the ledger writer). Look for redundant `UpdateCommand` calls in `lambda/src/meter/index.ts`.

### Cause 4 — Glue partition projection broken

Re-deploy `DataStack` (which owns the Glue table):

```bash
BBG_LOCAL=1 npx cdk deploy 'DevAppStage/Data-us-west-2'
```

Verify projection comes back:

```bash
aws glue get-table --database-name dev_bbg_ledger --name invocations --region us-west-2 \
  --query 'Table.Parameters.{enabled:"projection.enabled", year:"projection.year.range", month:"projection.month.range"}'
```

### Cause 5 — REMOVE events

Working as intended. If you specifically need to capture deletions in the ledger (e.g. for audit), modify `lambda/src/ledger-writer/index.ts::handler` to write a `{"deletedAt":..., "principal":..., "sk":...}` row instead of the early `continue`. Coordinate with whoever consumes the ledger so the new shape doesn't break Athena queries.

### Catch-up after extended outage

The DDB stream retains events for 24 hours. If the writer is more than 24h behind, those events are gone. Reconstruction options:
- Approximate: re-derive the missed rows from the live `RunningSpend` table by writing a one-shot scan-and-emit script (the deltas won't be hourly-accurate but the daily totals will be correct).
- Exact: restore from the previous day's `RunningSpend` PITR backup, diff against current, emit deltas. Heavyweight; rarely worth it.

## Idempotency / safety notes

- **The S3 key includes a 6-char random suffix per batch** (`...-{Math.random()...}.jsonl`). Repeated processing of the same stream batch produces a NEW S3 object on each retry, not an overwrite. This means downstream Athena queries can double-count if the writer succeeds, S3 confirms, but the Lambda crashes before the stream pointer advances. Mitigation: the writer's logic is fast (single S3 PutObject per batch) and crashes between PutObject and pointer-advance are rare in practice. If you see double-counting, add an idempotency key based on `(eventID, sequenceNumber)` and use `IfNoneMatch: '*'` on the PutObject.
- **`REMOVE` events are silently dropped** — period rollover and admin deletes do NOT show up in the ledger. The reconciler still works because it queries CUR + RunningSpend, not the ledger.
- **Delta computation can produce negative `spendUsd` / token counts** if an upstream process subtracts from a row (rare but possible during period rollover). The Athena tables tolerate negatives; sum-aggregations still produce correct answers.
- **Don't manually delete S3 objects under `events/`.** Athena partition projection won't notice missing objects but admin-facing reports will silently undercount.
- **Bucket lifecycle is governed by `DataStack`** — by default ledger objects expire after 90 days at `dev` and 365 days at `prod` (check `infra/lib/data-stack.ts` for current values). If you need longer retention, raise the lifecycle rule and redeploy DataStack.

## Related runbooks

- [`cur-reconciler.md`](cur-reconciler.md) — sibling consumer of the same `RunningSpend` data, used as ground-truth check against CUR.
- [`meter-unjoined.md`](meter-unjoined.md) — upstream producer of `RunningSpend` rows.
- See `lambda/src/api/reports/index.ts` for the Athena consumer of this data.
