# Runbook: `CwlForwardFailed`

## Symptom

CloudWatch alarm `<stage>-bbg-cwl-forward-failed` fires when the **5-minute `Sum`** of the `bbg.CwlForwardFailed` metric exceeds **0** for **1 evaluation period** (`treatMissingData: NOT_BREACHING`). The metric is emitted by the cross-region `cwl-forwarder` Lambda for **every EventBridge entry that `PutEvents` reported as failed** (a non-zero `FailedEntryCount` — note a `PutEvents` call can return HTTP 200 and still carry per-entry failures, which is exactly the silent-loss case this metric exists to catch).

Default threshold: `> 0` over 1 period (5 min). Any failure is worth paging.

## What it means

**Metered spend from a non-home region never reached the meter.** The forwarder lives in each metered region (`<stage>-bbg-cwl-forwarder-<region>`), subscribes to that region's Bedrock invocation log group (`/aws/bedrock/<stage>-invocations-<region>`), and republishes each log event as a `bbg.bedrock-invocation` EventBridge event onto the **home-region default bus**, where the home `meter` Lambda's rule consumes it and does the DynamoDB writes.

A failed entry is an invocation that never accumulates on `RunningSpend`. So:

- Spend is **under-counted** for the affected principals.
- Because enforcement reacts to the `RunningSpend` stream, a budget that should have breached **never fires** — the caller keeps invoking Bedrock past its limit.

Two mitigations are already in place and both are worth checking before assuming permanent loss: the handler **throws** on any partial failure, so the CWL subscription's async invoke retries the batch twice and, on exhaustion, routes it to the shared metering DLQ (`<stage>-bbg-metering-dlq-<region>`) for durable capture.

## Severity guidance

- **Sev3** — sustained non-zero across multiple periods, DLQ depth growing, or a whole metered region going quiet. Real, ongoing spend loss with enforcement blind spots. Page the on-call.
- **Sev4** — a single spike that clears on retry with the DLQ staying empty (a transient EventBridge throttle). The retry already recovered the spend. File a ticket.

## Likely causes (in order)

1. **EventBridge `PutEvents` throttling in the home region.** The default bus has an account/region `PutEvents` quota. A traffic burst across several metered regions at once (each forwarder chunking log events into 10-entry batches) can exceed it. `ErrorCode` in the logs will be a throttling code. Usually recovers on retry.
2. **Cross-region `events:PutEvents` denied.** The forwarder's role grants `events:PutEvents` on exactly `arn:aws:events:<home-region>:<account>:event-bus/default`. An IAM regression, an SCP, or a home-region/account mismatch in the `HOME_REGION` env var produces per-entry or call-level failures. For member accounts the equivalent wiring is in `MemberStackSetStack` (`bbg-cwl-forwarder-<region>`).
3. **Entry-size or malformed-detail rejection.** EventBridge caps total entry size (256KB). An unusually large Bedrock invocation log record — or a log line that isn't the expected shape — can be rejected per-entry while its siblings succeed.
4. **Home-region default bus problem.** The bus was deleted/replaced, or a bus-level resource policy now rejects the source account (relevant in the multi-account case, where member-account forwarders and EventBridge rules target the home account's default bus directly).
5. **A regional EventBridge or Bedrock-logging disruption.** Correlate with the AWS Health Dashboard before deep-diving.

## Investigation

```bash
# Which region is failing, and with what ErrorCode? (Run per metered region.)
aws logs tail /aws/lambda/dev-bbg-cwl-forwarder-us-east-1 --since 1h --region us-east-1 \
  --filter-pattern 'PutEvents partial failure'
# The warn carries: failedInBatch, sourceRegion, homeRegion, errorCodes[].

# Forwarded vs failed, side by side.
for m in CwlForwarded CwlForwardFailed; do
  echo "=== $m ==="
  aws cloudwatch get-metric-statistics --namespace bbg --metric-name $m \
    --dimensions Name=service,Value=bbg \
    --start-time "$(date -u -v-3H +%Y-%m-%dT%H:%M:%S)" \
    --end-time "$(date -u +%Y-%m-%dT%H:%M:%S)" \
    --period 300 --statistics Sum --region us-west-2 \
    --query 'Datapoints[].[Timestamp,Sum]' --output table
done

# Did retries exhaust? DLQ depth is the durable-loss indicator.
aws sqs get-queue-attributes \
  --queue-url "$(aws sqs get-queue-url --queue-name dev-bbg-metering-dlq-us-east-1 \
    --region us-east-1 --query QueueUrl --output text)" \
  --attribute-names ApproximateNumberOfMessages --region us-east-1

# Lambda-level errors (the handler throws on partial failure, so these track it).
aws cloudwatch get-metric-statistics --namespace AWS/Lambda --metric-name Errors \
  --dimensions Name=FunctionName,Value=dev-bbg-cwl-forwarder-us-east-1 \
  --start-time "$(date -u -v-3H +%Y-%m-%dT%H:%M:%S)" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%S)" \
  --period 300 --statistics Sum --region us-east-1

# Is the forwarder pointed at the right home region/account?
aws lambda get-function-configuration --function-name dev-bbg-cwl-forwarder-us-east-1 \
  --region us-east-1 --query 'Environment.Variables.{Home:HOME_REGION,Metered:METERED_REGION}'

# Does its role still allow PutEvents on the home default bus?
ROLE=$(aws lambda get-function-configuration \
  --function-name dev-bbg-cwl-forwarder-us-east-1 --region us-east-1 \
  --query Role --output text | awk -F/ '{print $NF}')
aws iam list-role-policies --role-name "$ROLE"

# Is the CWL subscription still wired to the forwarder?
aws logs describe-subscription-filters \
  --log-group-name /aws/bedrock/dev-invocations-us-east-1 --region us-east-1

# Is the home-region meter still receiving cross-region events at all?
aws logs tail /aws/lambda/dev-bbg-meter-us-west-2 --since 30m --region us-west-2 \
  --filter-pattern 'bedrock-invocation'

# Corroborate under-metering from the other direction.
aws cloudwatch get-metric-statistics --namespace bbg --metric-name MeterSpendCommitted \
  --dimensions Name=service,Value=bbg \
  --start-time "$(date -u -v-1d +%Y-%m-%dT%H:%M:%S)" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%S)" \
  --period 3600 --statistics Sum --region us-west-2 \
  --query 'Datapoints[].[Timestamp,Sum]' --output table
```

## Remediation

### Cause 1 — Throttling

Usually self-healing via the async retry. If it's chronic, request an EventBridge `PutEvents` quota increase for the home region, or reduce concurrent pressure (the forwarder already batches at EventBridge's 10-entry-per-call limit, so there's no cheap client-side win beyond spreading the metered regions' traffic). Then redrive the DLQ (below) to recover whatever exhausted its retries.

### Cause 2 — IAM / wrong target bus

Redeploy the metering stack for the affected region to restore the grant and the env vars:

```bash
BBG_LOCAL=1 npx cdk deploy 'DevAppStage/Metering-us-east-1'
```

For member accounts, redeploy/refresh the member StackSet so the per-region `bbg-cwl-forwarder-<region>` and its role are back in the intended state. If an SCP blocks `events:PutEvents` cross-region, that has to be exempted — there is no in-app workaround; the whole cross-region design depends on this one call.

### Cause 3 — Oversized / malformed entry

Identify it from the `ErrorCode` list in the warn, then find the offending log event in `/aws/bedrock/<stage>-invocations-<region>` around that timestamp. A genuinely oversized record cannot be forwarded as-is; the entry is permanently lost for metering purposes (the invocation itself succeeded and will still show up in CUR, which is what the [`cur-reconciler`](../cur-reconciler.md) exists to surface).

### Cause 4 — Home bus problem

Confirm the home-region default bus exists and, in the multi-account case, that its resource policy still permits the member accounts:

```bash
aws events describe-event-bus --name default --region us-west-2
```

Redeploy the home-region metering stack if the rule/target wiring drifted.

### Always — recover the DLQ

Messages on `<stage>-bbg-metering-dlq-<region>` are the durable record of spend that exhausted its retries. Once the root cause is fixed, redrive them so the spend lands on `RunningSpend`:

```bash
aws sqs start-message-move-task \
  --source-arn "$(aws sqs get-queue-attributes \
    --queue-url "$(aws sqs get-queue-url --queue-name dev-bbg-metering-dlq-us-east-1 \
      --region us-east-1 --query QueueUrl --output text)" \
    --attribute-names QueueArn --region us-east-1 \
    --query 'Attributes.QueueArn' --output text)" \
  --region us-east-1
```

The meter is idempotent on `requestId` (`processedRequestIds` guard), so a redrive that partially overlaps already-metered events is safe.

Acceptance: `CwlForwardFailed` returns to 0, `CwlForwarded` tracks the invocation rate again, the DLQ drains to empty, and the alarm transitions to OK within one evaluation period.

## Related Lambda runbooks

- [`meter`](../meter.md) — the home-region consumer of the forwarded `bbg.bedrock-invocation` events.
- [`alarms/meter-unjoined.md`](meter-unjoined.md) — the adjacent under-metering signal (spend arrived but couldn't be joined to a principal).
- [`cur-reconciler`](../cur-reconciler.md) — daily CUR-vs-meter delta; the backstop that quantifies spend the meter never saw.
- [`alarms/reconciliation-delta.md`](reconciliation-delta.md) — fires when that delta persists.
- See `docs/multi-account-multi-region.md` for the full cross-region / cross-account event path.
