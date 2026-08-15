# Runbook: `period-rollover` Lambda

## Purpose

The `period-rollover` Lambda runs once a month at 00:00 UTC on the 1st (EventBridge Scheduler `cron(0 0 1 * ? *)`) to clean up the prior period. For every `RunningSpend` row that matches the prior period's `YYYY-MM` key (queried via the `byPeriod` GSI), it detaches the stamped `bbg-deny-*` policy from every IAM user/role still holding it, deletes the policy, and deletes the spend row so the new period starts from zero. Operators can also invoke it on demand with an explicit `{ period: "YYYY-MM" }` payload.

It also writes a `PrincipalActivity` timeline row via `recordActivity` (`enforcement.rolled_over`) for every deny it successfully releases, so the SPA's per-principal timeline shows the release next to the `enforcement.applied` row the enforcement Lambda wrote; the helper never throws and no-ops when `PRINCIPAL_ACTIVITY_TABLE` is unset.

## Symptoms

- It's the 1st of the month and IAM still has `bbg-deny-*` policies from the prior period attached to principals — users still blocked from invoking models they should now be able to use.
- `bbg.EnforcementRolledBack` metric stuck at zero on the 1st of the month, despite known prior-period breaches.
- IAM `LimitExceeded` errors in `enforcement` because the prior period's deny policies weren't cleaned up and the principal already has 10 attached.
- `period-rollover` Lambda invocation count is zero around 00:00 UTC on the 1st — Scheduler didn't fire.
- `RunningSpend` rows for the prior `period` key are still present (they should be deleted at rollover).
- Log lines `rollover policy cleanup failed`, `detach failed after retries`, `delete policy failed after retries`.
- Alarm `<stage>-bbg-period-rollover-detach-failure` or `<stage>-bbg-period-rollover-delete-failure` in OK→ALARM. These are the canonical signals; see linked alarm runbooks below.

## Likely causes (in order)

1. **EventBridge Scheduler didn't fire.** Check schedule state, target Lambda ARN, and the scheduler-role's `lambda:InvokeFunction` permission. Common after a CDK redeploy that drifted the role wiring.
2. **IAM `iam:DetachUserPolicy` / `iam:DetachRolePolicy` permission denied or throttled.** **Alarmed** via `bbg.PeriodRolloverDetachFailure` — see [`docs/runbooks/alarms/period-rollover-detach-failure.md`](alarms/period-rollover-detach-failure.md). The Lambda's role grants these scoped to `iam:PolicyARN` ArnEquals `bbg-deny-*`. If a deny policy was created with a name that doesn't match the pattern (e.g., a hand-rolled one), the detach will fail. The Lambda retries 3x with jittered backoff, emits `PeriodRolloverDetachFailure` (with a `principal` dimension) on persistent failure, and continues processing the remaining principals — one bad detach won't block the rest of the rollover.
3. **`iam:DeletePolicy` failing because policy still has attachments or non-default versions.** **Alarmed** via `bbg.PeriodRolloverDeleteFailure` — see [`docs/runbooks/alarms/period-rollover-delete-failure.md`](alarms/period-rollover-delete-failure.md). AWS rejects delete-with-attachments and rejects delete-with-extra-versions. The Lambda detaches first, drains non-default versions, and only then deletes; if the delete still fails it retries 3x with jittered backoff and emits `PeriodRolloverDeleteFailure` (with a `policyArn` dimension) on persistent failure. Look for `detach failed after retries` warnings preceding the delete failure — that indicates cause 2 chained into 3.
4. **`iam:DeletePolicy` failing because policy has non-default versions.** The Lambda enumerates and deletes non-default versions before the policy itself. If the IAM role policy doesn't include `iam:DeletePolicyVersion` + `iam:ListPolicyVersions`, this will trip — those grants ARE present in `infra/lib/enforcement-stack.ts` lines 131-136 but check for drift.
5. **`byPeriod` GSI not propagated.** Spend rows from the prior period exist on the base table but the GSI projection is stale (DDB GSI propagation lag is rare beyond seconds, but a backfill operation could leave it inconsistent for minutes).
6. **Run timed out.** Lambda timeout is 5 minutes. A large account with many breached principals may need pagination across multiple pages — the Lambda already loops with `LastEvaluatedKey`, but if there are thousands of rows it could exceed the timeout. Re-invocation continues from any rows the prior run skipped (the spend-row `Delete` makes progress idempotent).
7. **Lambda invoked with a bad `period` payload.** On-demand invocations expect `{ period: "YYYY-MM" }` (or no payload, in which case it computes prior month). A malformed value matches no GSI rows and silently rolls over zero records.
8. **Cross-account detach/delete failed (an earlier change+).** Period-rollover assumes the member account's `bbg-enforcement` role via `lambda/src/shared/iam-cross-account.ts` to detach + delete the deny policy in member accounts. Failure modes: (a) member account was deenrolled mid-period (role gone) — assume-role returns `AccessDenied`, the principal is left blocked until the operator re-enrolls or manually clears the deny policy in the member; (b) StackSet operation in flight on the member's stack (CFN refuses concurrent IAM updates) — typically transient, retries clear it; (c) home-region IAM gating means the role only exists in the home region — the rollover Lambda always uses the home region for cross-account assume-role, so this is correct, but a misconfigured rollout (e.g., manually deploying to non-home region only) would surface here.

## Investigation

```bash
# Recent rollover logs (last invocation)
aws logs tail /aws/lambda/dev-bbg-period-rollover \
  --since 24h --region us-west-2

# Filter for warnings only
aws logs tail /aws/lambda/dev-bbg-period-rollover \
  --since 7d --filter-pattern '?WARN ?failed' --region us-west-2

# Did the Scheduler fire? (CloudWatch Lambda Invocations metric)
aws cloudwatch get-metric-statistics \
  --namespace AWS/Lambda --metric-name Invocations \
  --dimensions Name=FunctionName,Value=dev-bbg-period-rollover \
  --start-time $(date -u -v-3d +%FT%TZ) --end-time $(date -u +%FT%TZ) \
  --period 3600 --statistics Sum --region us-west-2

# Schedule state and target wiring
aws scheduler get-schedule --name dev-bbg-period-rollover --region us-west-2

# Confirm scheduler role still has lambda:InvokeFunction on the rollover Lambda
aws iam get-role --role-name <RolloverSchedulerRole-...> --region us-west-2

# Any leftover bbg-deny-* policies from the prior period?
aws iam list-policies --scope Local --max-items 200 --region us-west-2 \
  | jq '.Policies[] | select(.PolicyName | startswith("bbg-deny-")) | {PolicyName, Arn, AttachmentCount, CreateDate}'

# Spend rows still present for prior period (the GSI is byPeriod)
aws dynamodb query --table-name dev-bbg-running-spend \
  --index-name byPeriod \
  --key-condition-expression 'period = :p' \
  --expression-attribute-values '{":p":{"S":"2026-04"}}' \
  --select COUNT --region us-west-2

# BBG metric — rolled-over policy count from the last run
aws cloudwatch get-metric-statistics --namespace bbg \
  --metric-name EnforcementRolledBack \
  --start-time $(date -u -v-3d +%FT%TZ) --end-time $(date -u +%FT%TZ) \
  --period 3600 --statistics Sum --region us-west-2
```

## Remediation

**Cause 1 — Scheduler didn't fire.** Trigger an on-demand invocation for the missed period:

```bash
aws lambda invoke \
  --function-name dev-bbg-period-rollover \
  --payload '{"period":"2026-04"}' \
  --cli-binary-format raw-in-base64-out \
  --region us-west-2 /tmp/out.json && cat /tmp/out.json
```

Then redeploy the enforcement stack so the Scheduler is wired correctly for next month:

```bash
cdk deploy 'DevAppStage/Enforcement'
```

**Cause 2 / 3 — Detach permission denied or policy still attached.** Manually detach the offending principal, then re-invoke rollover for that period:

```bash
# For a user
aws iam detach-user-policy --user-name <user> \
  --policy-arn arn:aws:iam::<acct>:policy/bbg-deny-<hash>-2026-04 --region us-west-2
# For a role
aws iam detach-role-policy --role-name <role> \
  --policy-arn arn:aws:iam::<acct>:policy/bbg-deny-<hash>-2026-04 --region us-west-2
# Then retry rollover
aws lambda invoke --function-name dev-bbg-period-rollover \
  --payload '{"period":"2026-04"}' --cli-binary-format raw-in-base64-out \
  --region us-west-2 /tmp/out.json
```

**Cause 4 — Missing `iam:DeletePolicyVersion` permission.** Redeploy the enforcement stack; the grants are in `infra/lib/enforcement-stack.ts` lines 131-136.

**Cause 5 — `byPeriod` GSI stale.** Wait a few minutes and re-invoke. If consistently broken, check the `byPeriod` GSI status:

```bash
aws dynamodb describe-table --table-name dev-bbg-running-spend --region us-west-2 \
  | jq '.Table.GlobalSecondaryIndexes[] | select(.IndexName == "byPeriod")'
```

**Cause 6 — Timeout.** Re-invoke. Each spend-row delete is idempotent (deleting a missing key is a no-op) and policy detach/delete is also idempotent against subsequent runs. Multiple invocations chained together will eventually drain.

If a single run consistently times out, bump the Lambda timeout in `infra/lib/enforcement-stack.ts` (`Duration.minutes(5)` → `Duration.minutes(10)`) and redeploy.

**Cause 7 — Bad `period` payload.** Use the documented format `YYYY-MM`. A no-payload invocation computes the prior month from "now" and is the safer default.

## Idempotency / safety notes

- **The whole rollover is idempotent.** Re-invoking for the same period:
  - Re-queries the GSI (rows already deleted → no-op).
  - For each row with `enforcementPolicyArn` still present: re-detaches (no-op if already detached, swallowed warn if so), re-lists versions, re-deletes versions (no-op if already gone), re-deletes the policy (404 → no-op).
  - Deletes the spend row (404 → no-op).
- **Safe to invoke multiple periods in sequence** — each invocation only touches its target period.
- **`detachAndDelete()` retries each IAM call 3x (jittered backoff) and emits a metric on persistent failure** — `bbg.PeriodRolloverDetachFailure` (with a `principal` dimension) for detach failures and `bbg.PeriodRolloverDeleteFailure` (with a `policyArn` dimension) for delete failures. Both have CloudWatch alarms that page the on-call. The row's cleanup also continues past per-principal failures so one bad principal doesn't block the rest of the rollover.
- **Do NOT run during a period boundary if you've manually attached a `bbg-deny-*` policy** — rollover will detach it. Either name your policy outside the `bbg-deny-*` namespace or wait until after the rollover.
- **The spend-row delete is the explicit period boundary** — it doesn't wait for the TTL (which would purge a month later anyway, but rollover is the deterministic boundary).
- **On-demand invocations are safe in production** but exposed only via direct Lambda invoke (not via the API) — operators with `lambda:InvokeFunction` on this Lambda can trigger it. Don't widen invoke permissions casually.

## Related runbooks

- [`enforcement.md`](enforcement.md) — creates the `bbg-deny-*` policies that this Lambda cleans up
- [`meter.md`](meter.md) — writes the `RunningSpend` rows that this Lambda eventually deletes
- [`identity-cache.md`](identity-cache.md) — supplies the canonical principal that became the IAM attach target
