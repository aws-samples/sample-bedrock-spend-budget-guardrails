# Runbook: `PeriodRolloverDetachFailure`

## Symptom

CloudWatch alarm `<stage>-bbg-period-rollover-detach-failure` fires when the `bbg.PeriodRolloverDetachFailure` metric is `> 0` for **1 evaluation period of 5 minutes** (`treatMissingData: NOT_BREACHING`). The metric increments each time the `period-rollover` Lambda failed to detach a `bbg-deny-*` policy from a user or role even after 3 retries with jittered exponential backoff (~100/200/400ms base + jitter).

A failure here means a `bbg-deny-*` policy from the **prior** period is still attached to a principal. That principal will keep being denied access to Bedrock for the new period instead of getting a fresh budget — a budget-enforced principal stays blocked indefinitely until an operator detaches the policy manually.

Default threshold: `Sum > 0` over 5 minutes (immediate).

## Severity guidance

- **Sev3** — any time during the rollover window (00:00 UTC on the 1st of the month) when one or more principals are stuck denied for the new period. The customer experience is "I can't call Bedrock and I shouldn't be blocked." Page the on-call.
- **Sev4** — a single transient `Throttling` that emitted the metric on retry-3 but a subsequent on-demand re-invocation succeeded. Confirm by checking that the `bbg-deny-*` policy is gone, then close.

## Likely causes (in order)

1. **IAM `Throttling` / `RateExceeded`.** IAM has a low default rate limit (~10 TPS sustained) on detach calls. A rollover that touches dozens of principals can self-throttle. The 3-retry loop with jittered backoff usually absorbs this; a metric emission means the throttle outlasted the retry budget.
2. **`AccessDenied` on `iam:DetachUserPolicy` / `iam:DetachRolePolicy`.** The `period-rollover` Lambda's role grants these scoped via `iam:PolicyARN` ArnEquals to `bbg-deny-*`. A redeploy that drifted the IAM policy, or a deny SCP applied to the account, will cause every detach to 403.
3. **The user or role was deleted between attach time and rollover time.** IAM returns `NoSuchEntity` for the user/role. The retry loop won't help; the policy itself can still be deleted (no entities → DeletePolicy succeeds), but the metric still fires once for visibility.
4. **Permissions boundary on the principal denies `iam:DetachUserPolicy` /`iam:DetachRolePolicy` even when the Lambda's role allows it.** Less common but seen with strict customer-managed permissions boundaries on dev/sandbox principals.
5. **The deny policy was renamed manually.** If a human edited the policy outside the `bbg-deny-*` namespace, the Lambda's IAM policy condition (`ArnEquals bbg-deny-*`) won't match the new ARN and `AccessDenied` is returned.

## Investigation

```bash
# Recent rollover Lambda logs (filter for the structured warn lines the
# Lambda emits before incrementing the metric)
aws logs tail /aws/lambda/dev-bbg-period-rollover --since 24h --region us-west-2 \
  --filter-pattern '"detach failed after retries"'

# Same filter, including the per-attempt retry messages so you can see what
# error class the IAM API actually returned
aws logs tail /aws/lambda/dev-bbg-period-rollover --since 24h --region us-west-2 \
  --filter-pattern '"failed; retrying"'

# Pull the metric with the principal dimension to see who is stuck
aws cloudwatch list-metrics --namespace bbg \
  --metric-name PeriodRolloverDetachFailure --region us-west-2

# Confirm the bbg-deny-* policy is still attached to the offending principal
aws iam list-attached-user-policies --user-name <username> --region us-west-2
aws iam list-attached-role-policies --role-name <rolename> --region us-west-2

# Verify the Lambda's IAM policy still grants iam:DetachUser/RolePolicy on
# the bbg-deny-* ARN pattern
aws iam get-role-policy \
  --role-name dev-bbg-period-rollover-role \
  --policy-name dev-bbg-period-rollover-iam-policy --region us-west-2
```

## Remediation

**Cause 1 — IAM throttling.** The rollover is idempotent. Re-invoke for the same period:

```bash
aws lambda invoke --function-name dev-bbg-period-rollover \
  --payload '{"period":"2026-04"}' --cli-binary-format raw-in-base64-out \
  --region us-west-2 /tmp/out.json && cat /tmp/out.json
```

If it consistently throttles, lower invocation concurrency by sharding the rollover by principal-prefix.

**Cause 2 — `AccessDenied`.** Redeploy the EnforcementStack to restore the IAM grants:

```bash
cdk deploy 'DevAppStage/Enforcement-us-west-2'
```

If a deny SCP is at fault, escalate to the org admin to add the rollover-Lambda's role ARN to the SCP's NotPrincipal list.

**Cause 3 — Principal deleted.** Manually delete the orphaned `bbg-deny-*` policy:

```bash
aws iam delete-policy --policy-arn arn:aws:iam::<acct>:policy/bbg-deny-<hash>-2026-04 \
  --region us-west-2
```

The next rollover invocation for that period will be a no-op (policy gone, spend row deletes are idempotent).

**Cause 4 — Permissions boundary.** Detach the policy as the principal's account admin (the boundary doesn't restrict the principal-owner's IAM admin), then re-invoke rollover.

**Cause 5 — Renamed deny policy.** Detach manually:

```bash
aws iam detach-user-policy --user-name <user> --policy-arn <renamed-arn> --region us-west-2
# or detach-role-policy
aws iam delete-policy --policy-arn <renamed-arn> --region us-west-2
```

Acceptance: alarm transitions to OK within 5 minutes after the offending principal's deny policy is gone, AND the next rollover invocation for the affected period rolls over zero new failures.

## Related runbooks

- [`period-rollover`](../period-rollover.md) — the Lambda this metric is emitted from
- [`enforcement`](../enforcement.md) — creates the `bbg-deny-*` policies that the rollover Lambda is trying to clean up
- [`PeriodRolloverDeleteFailure`](period-rollover-delete-failure.md) — the delete-side companion alarm; if both fire together, look at cause 2 first (an `AccessDenied` on detach naturally chains into a delete failure on the same policy)
