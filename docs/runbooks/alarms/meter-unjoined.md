# Runbook: `MeterUnjoined`

## Symptom

CloudWatch alarm `<stage>-bbg-meter-unjoined` fires when the `bbg.MeterUnjoined` metric is `> 0` for **5 consecutive evaluation periods** (`treatMissingData: NOT_BREACHING`). The metric increments each time the `meter` Lambda received a Bedrock invocation log entry but couldn't find a matching identity record in `IdentityCache` within the join window. The invocation goes into `PendingMeter` and waits for a `bbg.identity-arrived` event, but the matching Bedrock API-call event never arrived.

Default threshold: `> 0` over 5 periods.

## Severity guidance

- **Sev3** — sustained `MeterUnjoined > 0` across multiple regions or growing `PendingMeter` backlog. Spend is not being attributed to principals, so budgets and enforcement are silently under-counting. Page the on-call.
- **Sev4** — single-region, low rate (a handful per hour), and `PendingMeter` is draining. Almost always a transient identity-cache lag or an SSO role you can't tag — file a ticket and follow up next business day.

## How identity events reach BBG

Bedrock `InvokeModel` / `Converse` / `InvokeAgent` calls surface as management-event API calls (`detail-type: "AWS API Call via CloudTrail"`) on the account's **default EventBridge bus**, and the `<stage>-bbg-bedrock-runtime-<region>` EventBridge rule matches them to target `identity-cache`. That default-bus delivery only happens when a **trail logging management events** exists — CloudTrail's free 90-day Event history alone does NOT deliver to EventBridge. A transient join gap is almost always identity-cache lag — **not** a data-event-selector problem.

> Prerequisite: a **multi-region management-events trail** must exist. By default BBG creates one (`<stage>-bbg-mgmt-<region>`); operators opt out with `bbg:createManagementEventsTrail: false` when the account/Org already has one (Control Tower, org trail). If someone opted out AND the account then has no management trail, Bedrock API calls never reach the default bus and identity never arrives. Confirm a management trail exists: `aws cloudtrail list-trails` → each should have `IsMultiRegionTrail: true` and be logging management events.

## Likely causes (in order)

1. **Transient join race (most common).** During a deploy or a traffic burst, an invocation log can arrive a beat ahead of its identity event; it lands in `PendingMeter`, ticks `MeterUnjoined`, then joins moments later. Self-resolving — `PendingMeter` drains to 0. This is the Sev4 case.
2. **No management trail in the account.** Happens only if `bbg:createManagementEventsTrail` was set to `false` AND no other management trail exists — then Bedrock API-call events never reach the default bus. Check `aws cloudtrail list-trails` for one with `IsMultiRegionTrail: true` logging management events; if none, either flip `bbg:createManagementEventsTrail` back to `true` (default) and redeploy, or enable your org/Control Tower trail.
3. **EventBridge rule disabled or misconfigured.** The rule `<stage>-bbg-bedrock-runtime-<region>` filters on `source: [aws.bedrock-runtime, aws.bedrock, aws.bedrock-agent-runtime]` + `detail-type: "AWS API Call via CloudTrail"`. Check state with `aws events describe-rule`.
4. **`identity-cache` Lambda failing.** Its DLQ piles up; check `/aws/lambda/<stage>-bbg-identity-cache-<region>` for errors (e.g., IAM tag-lookup permissions denied for some principal types).

## Investigation

```bash
# Is there any multi-region management trail delivering Bedrock API calls?
aws cloudtrail list-trails --region us-west-2

# EventBridge rule state and target
aws events describe-rule --name dev-bbg-bedrock-runtime-us-west-2 --region us-west-2
aws events list-targets-by-rule --rule dev-bbg-bedrock-runtime-us-west-2 --region us-west-2

# identity-cache invocations + errors
aws logs tail /aws/lambda/dev-bbg-identity-cache-us-west-2 --since 1h --region us-west-2

# How many pending rows? (draining → transient; growing → real)
aws dynamodb scan --table-name dev-bbg-pending-meter --region us-west-2 --select COUNT
```

## Remediation

- **Transient (PendingMeter draining, no errors):** no action — the alarm auto-clears once the metric stays 0 for 5 periods.
- **No management trail:** enable one (the org / `Default` multi-region trail). BBG intentionally does not create its own.
- **Rule disabled:** re-enable it, or redeploy the MeteringStack: `cdk deploy 'DevAppStage/Metering-us-west-2'`.
- If `identity-cache` is failing on IAM tag lookups for an SSO role you can't assume, the Lambda already swallows that error in a debug log. The principal will canonicalize without tags but the join still works.
- For an immediate one-time drain of accumulated `PendingMeter` rows after fixing the underlying issue:
  ```bash
  npx tsx scripts/drain-pending.ts
  ```

Acceptance: `PendingMeter` table count drops to 0 (or near 0) after the next batch of invocations and `bbg.MeterUnjoined` returns to 0 within 10 minutes.

## Related Lambda runbooks

- [`meter`](../meter.md)
- [`identity-cache`](../identity-cache.md)
