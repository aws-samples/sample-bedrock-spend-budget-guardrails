# Parallel enforcement: near real-time meter + AWS Budgets Actions

BBG ships **two enforcement channels**. Both can fire on the same principal × target. Both detach via the same `period-rollover` Lambda. The two channels are independent, fail-open with respect to each other, and use **distinct IAM policy namespaces** so they never race for the same resource.

| | Real-time channel (default) | CUR + Budgets channel (opt-in) |
|---|---|---|
| Trigger | DynamoDB stream on `RunningSpend` | AWS Budgets evaluation on CUR data |
| Latency to deny | sub-30s p95 | ~24h trailing (CUR cadence) |
| Source of truth | `RunningSpend` table (BBG meter) | CUR 2.0 with `iamPrincipal/*` cost-allocation tag |
| IAM policy prefix | `bbg-deny-<hash>-<period>` | `bbg-deny-cur-<hash>-<period>` |
| Consumer Lambda | `enforcement` (in `EnforcementStack`) | `budgets-action-sync` (in `BudgetsActionStack`) |
| Stack | always deployed | gated by `bbg:enableBudgetsAction=true` |
| Detach owner | `period-rollover` (`bbg-deny-*` ArnEquals scope) | same |

## Why both?

The near real-time meter is the **primary** enforcement signal — it has to be sub-minute to actually stop runaway spend before it accumulates. The CUR + Budgets channel is **defense-in-depth**: if the meter is degraded (broken pricing-refresher, identity-cache misses, stuck DDB stream consumer), AWS Budgets will independently catch the breach on the next CUR refresh and apply its own deny policy without any BBG code path having executed.

Concretely, the two channels protect against complementary failure modes:

- **Real-time meter wrong** (e.g. pricing-refresher gap): meter under-reports spend → no breach → no deny. Budgets channel catches it because CUR is the canonical billing source — it cannot be wrong about your actual spend.
- **AWS Budgets latency / outage**: Budgets fires too late or not at all. Real-time channel catches it within seconds.
- **One channel's IAM scope guardrail tightened too far**: the other channel still attaches its own policy.

## "If either fires, the principal is denied"

Both deny policies sit on the principal at the same time when both fire. IAM evaluates them as an explicit deny in either statement → access denied. This is the safe default: a principal on the wrong side of either reading of their spend is blocked from further Bedrock invocations until period-rollover.

If only one channel fires, the principal is still blocked — both attach `bedrock:InvokeModel` denies pointing at the same foundation-model ARN(s).

## Policy detach: shared owner, independent prefixes

Both channels use the `bbg-deny-` *family* of prefixes. The IAM scope guardrail for the enforcement Lambda's role is:

```json
{
  "Condition": {
    "ArnEquals": {
      "iam:PolicyARN": "arn:aws:iam::<acct>:policy/bbg-deny-*"
    }
  }
}
```

`bbg-deny-*` matches both `bbg-deny-<hash>` (real-time) and `bbg-deny-cur-<hash>` (Budgets). The `period-rollover` Lambda iterates `RunningSpend` rows whose `enforcementPolicyArn` is stamped — both channels stamp this column — and detaches whatever ARN it finds. No prefix-aware logic exists in `period-rollover`; it is intentionally prefix-agnostic so adding more enforcement channels in the future doesn't require code changes there.

The Budgets `BudgetsActionRole` (the role AWS Budgets assumes when attaching a deny on breach) is scoped *more tightly* — to `bbg-deny-cur-*` only — so even if it were misused it could not attach a real-time-channel policy.

## When the two channels disagree

This is the operationally interesting case. There are three flavors:

### 1. Real-time fired, Budgets did not

- **Most common**: the principal genuinely breached spend in the last 24 hours, faster than AWS Budgets refreshes. Within ~24h Budgets will agree.
- **Investigate** if Budgets *still* hasn't agreed after 48 hours: usually a `iamPrincipal/*` cost-allocation tag is not activated in the Billing console (see [`docs/cur-reconciliation.md`](cur-reconciliation.md)) or the CUR 2.0 export is missing the `INCLUDE_IAM_PRINCIPAL_DATA` flag.

### 2. Budgets fired, real-time did not

- **Most common**: the meter was degraded for some window (CWL subscription delivery delay, pricing-refresher run skipped). Real-time channel under-reported spend; Budgets caught up on the CUR refresh.
- **Investigate**: check `bbg.MeterUnjoined`, `bbg.PricingGapCount`, and the `cur-reconciler` drift output from the same period. If drift is consistent and large, treat the real-time meter as authoritative for *catching* future breaches but accept Budgets as authoritative for *truth* until you've fixed the meter.

### 3. Both fired but for different limits

- This happens when an operator updates a budget row in BBG and `budgets-action-sync` hasn't propagated yet (DDB stream lag) — the AWS Budget object is on the old limit while the meter is on the new one.
- **Resolution**: the sync Lambda is idempotent; it will catch up on the next stream record. If it doesn't, check the `BudgetsActionSyncFailures` metric and the `<stage>-bbg-budgets-action-sync-dlq` queue.

## Operator runbook

### Enabling the parallel channel

```bash
# Per-stage opt-in via cdk context.
BBG_LOCAL=1 npx cdk deploy 'DevAppStage/*' -c bbg:enableBudgetsAction=true
```

The flag is `false` by default in `cdk.json`. With the flag unset:

- No `BudgetsActionStack` is created.
- No `BudgetsActionRole` exists.
- No `budgets-action-sync` Lambda is deployed.
- The `Budgets` DDB table still has its stream enabled (the stream is unconditional so toggling the flag later doesn't require a `Budgets`-table replacement) but no consumer is wired to it.

### Disabling the parallel channel

`-c bbg:enableBudgetsAction=false` (or remove the flag) and re-deploy. CloudFormation will tear down `BudgetsActionStack`. **AWS Budget objects and Budget Actions previously created by the sync Lambda are NOT automatically deleted** — they live in the AWS Budgets service, not in CloudFormation. Cleanup:

```bash
# List the BBG-managed budgets.
aws budgets describe-budgets --account-id <acct> \
  --query 'Budgets[?starts_with(BudgetName, `bbg-`)].BudgetName' --output text

# Delete each one (and its actions).
for b in <names>; do
  aws budgets describe-budget-actions-for-budget --account-id <acct> --budget-name "$b" \
    --query 'Actions[].ActionId' --output text \
  | xargs -I {} aws budgets delete-budget-action --account-id <acct> --budget-name "$b" --action-id {}
  aws budgets delete-budget --account-id <acct> --budget-name "$b"
done
```

### Forcing reconciliation

The sync Lambda only runs on DDB-stream events. To force a full sync (e.g., after a long outage):

```bash
# Re-stamp every Budgets row with a no-op update — DDB stream emits a MODIFY
# event for each. The handler is idempotent.
aws dynamodb scan --table-name <stage>-bbg-budgets \
  --query 'Items[].[principal.S, target.S]' --output text \
| while read -r principal target; do
    aws dynamodb update-item --table-name <stage>-bbg-budgets \
      --key "{\"principal\":{\"S\":\"$principal\"},\"target\":{\"S\":\"$target\"}}" \
      --update-expression 'SET resyncedAt = :n' \
      --expression-attribute-values "{\":n\":{\"S\":\"$(date -u +%FT%TZ)\"}}"
  done
```

### When `BudgetsActionSyncFailures` fires

1. Check the DLQ: `aws sqs receive-message --queue-url <stage>-bbg-budgets-action-sync-dlq` — most failures are transient throttling.
2. Check the role: `aws iam get-role --role-name <stage>-bbg-budgets-action-role` should exist and have `budgets.amazonaws.com` in its trust policy.
3. Check the cost-allocation tag is still activated in Billing → Cost Allocation Tags. If it was deactivated, every `CreateBudget` call will succeed but the budget will never accrue spend (silent failure).
4. Check `iam:PassRole` permission: the sync Lambda's role must have `iam:PassRole` to the Budgets-Action role. The CDK stack wires this up; if you've manually edited the role, restore the original CDK-generated policy.

### Self-cost contribution

The `budgets-action-sync` Lambda emits the standard `bbg.MeterCostUSD` metric with `Lambda=budgets-action-sync` dimension. It is invoked once per Budgets-row mutation — typically a handful of invocations per day per operator-managed budget — so its self-cost is negligible compared to the meter or ledger-writer.

## See also

- [`docs/cur-reconciliation.md`](cur-reconciliation.md) — CUR 2.0 export setup and the `iamPrincipal/*` cost-allocation tag activation.
- [`docs/runbooks/enforcement.md`](runbooks/enforcement.md) — real-time channel runbook.
- [`docs/runbooks/period-rollover.md`](runbooks/period-rollover.md) — month-end detach for both channels.
- [`infra/lib/budgets-action-stack.ts`](../infra/lib/budgets-action-stack.ts) — the opt-in stack.
- [`lambda/src/budgets-action-sync/index.ts`](../lambda/src/budgets-action-sync/index.ts) — the sync handler.
