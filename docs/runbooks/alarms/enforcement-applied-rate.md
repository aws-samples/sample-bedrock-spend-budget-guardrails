# Runbook: `EnforcementAppliedRate`

## Symptom

CloudWatch alarm `<stage>-bbg-enforcement-applied-rate` fires when the **5-minute `Sum`** of the `bbg.EnforcementApplied` metric exceeds **25** for **1 evaluation period** (`treatMissingData: NOT_BREACHING`). The metric is emitted once per **successful** deny-policy attach by the `enforcement` Lambda (`lambda/src/enforcement/index.ts`, immediately after `attachPolicyWithRetry` returns).

Default threshold: `> 25` over 1 period (5 min).

This is the **ENF-2 mass-enforcement pager** from [`docs/threat-model.md`](../../threat-model.md) §B1 — a High-severity Denial-of-Service finding: a compromised or buggy home enforcement Lambda attaching Deny policies at scale across every enrolled account produces an org-wide Bedrock outage. The threshold is a deliberately loose ceiling: routine enforcement is a handful of attaches, so dozens in five minutes is anomalous by construction.

## What it means

**Bedrock is being denied for a large number of principals right now, and it may not be legitimate.** Every `EnforcementApplied` is a real customer-managed `bbg-deny-<hash>-<period>` IAM policy attached to a real IAM user or role — the caller *is* blocked. Unlike most BBG alarms (which signal under-metering or missed enforcement), this one signals **over-enforcement**, so the blast radius is availability, not accuracy.

Treat it as an availability incident first and a root-cause investigation second. The operator response is the ENF-2 kill-switch: flip `bbg:pauseEnforcement` to stop *new* attaches while you investigate.

## Severity guidance

- **Sev2** — sustained or repeated breaches, or the attaches span multiple accounts / unrelated principals. This is the org-wide-outage shape. Page immediately, flip the kill-switch, then investigate.
- **Sev3** — a single 5-min spike that is explainable (see cause 1 or 2: a wildcard budget just went live, or a bulk enrollment landed) and the denied principals genuinely are over their limits. Confirm intent with the budget owner.

## Likely causes (in order)

1. **A legitimate wildcard budget just breached across a large principal population.** Enforcement matches the exact budget target plus a `<dimension>#*` wildcard fallback, so one low-limit wildcard budget can breach for every principal at once. Most common benign explanation — and still worth confirming, because a mis-set limit on a wildcard budget is functionally a self-inflicted outage.
2. **A metering bug inflating spend org-wide.** If the meter starts over-counting (pricing regression, a discount that should apply but no longer does, double-counted usage), every principal crosses its limit near-simultaneously. Cross-check against the CUR reconciler and the pricing alarms before blaming enforcement.
3. **A bulk enrollment or backfill.** A large batch of member accounts was just enrolled, or a replay pushed a burst of `RunningSpend` stream records for already-breached rows. The set-once `attribute_not_exists(enforcementPolicyArn)` guard prevents *re-*attaching to the same spend row, so a pure replay shouldn't spike this — if it does, the guard regressed and that itself is the finding.
4. **A compromised or buggy home enforcement Lambda (the ENF-2 threat).** Attaching denies at scale on purpose or by defect. Rare, and scoped by threat-model assumption A001 (trusted home account), but this alarm exists precisely so it isn't silent. Look for attaches with no corresponding breach in the spend rows.
5. **A period-boundary interaction.** Rollover cleaned up the prior period's policies but spend rows for the new period immediately re-breached (e.g. a limit that's already exceeded by carried-over usage). Legitimate mechanically, but usually indicates a budget whose limit or window is misconfigured.

## Investigation

```bash
# Every attach in the window, with the principal and target.
aws logs tail /aws/lambda/dev-bbg-enforcement --since 30m --region us-west-2 \
  --filter-pattern 'Budget breached'

# The metric itself — is this one spike or a sustained ramp?
aws cloudwatch get-metric-statistics --namespace bbg --metric-name EnforcementApplied \
  --dimensions Name=service,Value=bbg \
  --start-time "$(date -u -v-3H +%Y-%m-%dT%H:%M:%S)" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%S)" \
  --period 300 --statistics Sum --region us-west-2 \
  --query 'Datapoints[].[Timestamp,Sum]' --output table

# Is the kill-switch currently on or off?
aws lambda get-function-configuration --function-name dev-bbg-enforcement \
  --region us-west-2 --query 'Environment.Variables.ENFORCEMENT_PAUSED'

# How many bbg-deny-* policies exist right now, and how many are attached?
aws iam list-policies --scope Local --region us-west-2 \
  --query 'Policies[?starts_with(PolicyName, `bbg-deny-`)].[PolicyName,AttachmentCount,CreateDate]' \
  --output table

# Which budgets could have driven a fleet-wide breach? Look for wildcard
# targets and suspiciously low limits.
aws dynamodb scan --table-name dev-bbg-budgets --region us-west-2 \
  --projection-expression 'principal, target, limitUsd, #a, enabled, #u' \
  --expression-attribute-names '{"#a":"action","#u":"unlimited"}'

# Rule out a metering-side inflation (cause 2) before blaming enforcement.
for m in MeterSpendCommitted UnpricedInvocations ReconciliationDelta; do
  echo "=== $m ==="
  aws cloudwatch get-metric-statistics --namespace bbg --metric-name $m \
    --dimensions Name=service,Value=bbg \
    --start-time "$(date -u -v-1d +%Y-%m-%dT%H:%M:%S)" \
    --end-time "$(date -u +%Y-%m-%dT%H:%M:%S)" \
    --period 3600 --statistics Sum --region us-west-2 \
    --query 'Datapoints[].[Timestamp,Sum]' --output table
done

# Spot-check one denied principal: does its spend row actually justify the deny?
aws dynamodb query --table-name dev-bbg-running-spend --region us-west-2 \
  --key-condition-expression 'principal = :p' \
  --expression-attribute-values '{":p":{"S":"principal#arn:aws:iam::123456789012:role/foo"}}' \
  --query 'Items[].{sk:sk.S,spend:spendUsd.N,policy:enforcementPolicyArn.S}'
```

## Remediation

### Step 1 (always) — stop the bleeding with the ENF-2 kill-switch

`bbg:pauseEnforcement` makes the enforcement Lambda **skip attaching new deny policies** (it logs, emits `EnforcementPaused`, and no-ops). Already-attached denies are untouched, nothing is stamped, and enforcement resumes cleanly on the next stream event once the flag is cleared. It's an env flag captured at synth, so flipping it is a redeploy — deliberately, so the audit trail is the pipeline run rather than a mutable runtime toggle.

```bash
aws ssm put-parameter --name /bbg/operator-config --type String --overwrite \
  --value "$(aws ssm get-parameter --name /bbg/operator-config \
              --query 'Parameter.Value' --output text \
            | jq '. + {"bbg:pauseEnforcement": true}')"

BBG_LOCAL=1 npx cdk deploy 'DevAppStage/Enforcement-us-west-2'
```

Confirm: `ENFORCEMENT_PAUSED` reads `true` and the `EnforcementPaused` metric starts incrementing on subsequent breaches.

### Step 2 — release the principals that shouldn't be denied

Use the documented release path (it detaches + deletes the policy and clears `enforcementPolicyArn` on the spend row) rather than hand-deleting IAM policies. `principal` and `target` are URL-encoded **query** params (NOT path segments — an IAM ARN's `/` breaks path-segment matching and 404s at the gateway):

```bash
PRINCIPAL=$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=""))' \
  'principal#arn:aws:iam::123456789012:role/foo')
TARGET=$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=""))' \
  'model#anthropic.claude-sonnet-4-6')

curl -X POST "https://<api-url>/admin/budget/release?principal=$PRINCIPAL&target=$TARGET" \
  -H "Authorization: Bearer $JWT"
```

For a fleet-wide bad enforcement, the blunt instrument is an on-demand `period-rollover` invoke for the current period — it detaches and deletes every stamped `bbg-deny-*` for that period, including cross-account. Read [`period-rollover.md`](../period-rollover.md) first; it also clears the enforcement stamps.

**Do NOT hand-delete `bbg-deny-*` policies with a non-zero `AttachmentCount`** — that leaves orphan attachments and is `period-rollover`'s job.

### Cause 1 / 5 — misconfigured (wildcard) budget

Raise the limit, narrow the target, or set `action: alert` so the budget meters and notifies without denying. An alert-only budget emits `AlertOnlyBreaches` instead of `EnforcementApplied`, so it can't trip this alarm.

### Cause 2 — metering inflation

Fix the meter/pricing side, then re-price. Start with [`pricing-refresher.md`](../pricing-refresher.md), [`alarms/pricing-refresh-age.md`](pricing-refresh-age.md), and [`alarms/reconciliation-delta.md`](reconciliation-delta.md). A discount regression is a plausible inflation source — an account that should be discounted but resolves to list price crosses its limit early; check [`org-discount-resolver.md`](../org-discount-resolver.md) and the `OrgDiscountResolverDegraded` alarm.

### Cause 3 — guard regression

Confirm the set-once stamp is still in the update path: `ConditionExpression: 'attribute_not_exists(enforcementPolicyArn)'` in `lambda/src/enforcement/index.ts`. If a refactor dropped it, stream replays can re-attach and re-emit. That's a code bug — revert it.

### Cause 4 — suspected compromise

Leave the kill-switch on. Preserve evidence before remediating: export the enforcement log group for the window, snapshot `list-policies --scope Local` output, and check CloudTrail for `iam:AttachRolePolicy` / `iam:AttachUserPolicy` calls whose caller is **not** the enforcement Lambda's role. Note the security boundary that should have contained it: the Lambda's `iam:PolicyARN` `ArnEquals` condition is scoped to `bbg-deny-*` — **never widen it** (hard rule).

### Step 3 — resume enforcement

Once the root cause is fixed and the denied population is correct, clear the flag and redeploy:

```bash
aws ssm put-parameter --name /bbg/operator-config --type String --overwrite \
  --value "$(aws ssm get-parameter --name /bbg/operator-config \
              --query 'Parameter.Value' --output text \
            | jq '. + {"bbg:pauseEnforcement": false}')"

BBG_LOCAL=1 npx cdk deploy 'DevAppStage/Enforcement-us-west-2'
```

Acceptance: `EnforcementApplied` 5-min Sum returns below 25, `EnforcementPaused` stops incrementing, and the alarm transitions to OK within one evaluation period.

## Related Lambda runbooks

- [`enforcement`](../enforcement.md) — the Lambda that emits the metric; policy creation, attach retries, and the kill-switch behavior.
- [`period-rollover`](../period-rollover.md) — the supported bulk detach/delete path for `bbg-deny-*` policies.
- [`alarms/enforcement-errors.md`](enforcement-errors.md) — the inverse failure (attach *failed*).
- [`alarms/enforcement-attach-stuck.md`](enforcement-attach-stuck.md) — stamped but not attached; principal is NOT blocked.
- [`docs/threat-model.md`](../../threat-model.md) — ENF-2 (§B1), the finding this alarm remediates.
