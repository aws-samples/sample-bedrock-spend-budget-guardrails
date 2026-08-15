# Runbook: `PeriodRolloverDeleteFailure`

## Symptom

CloudWatch alarm `<stage>-bbg-period-rollover-delete-failure` fires when the `bbg.PeriodRolloverDeleteFailure` metric is `> 0` for **1 evaluation period of 5 minutes** (`treatMissingData: NOT_BREACHING`). The metric increments each time the `period-rollover` Lambda failed to delete a `bbg-deny-*` IAM policy after 3 retries with jittered exponential backoff.

A failure here means the policy detached cleanly from all entities but `iam:DeletePolicy` still rejected — most often because IAM's view of "detached" hadn't propagated yet, the policy still has non-default versions, or the Lambda's IAM policy is missing `iam:DeletePolicy`. The runtime impact is lower than `PeriodRolloverDetachFailure` because the policy is detached (caller is no longer denied), but stale `bbg-deny-*` policies will accumulate in IAM and eventually hit the per-account customer-managed-policy quota.

Default threshold: `Sum > 0` over 5 minutes (immediate).

## Severity guidance

- **Sev4** — single transient failure; the next rollover (or an on-demand re-invocation) will retry. Confirm by listing `bbg-deny-*` policies and checking the policy is gone, then close.
- **Sev3** — repeated failures or a steady drip of stale `bbg-deny-*` policies left behind month-over-month. The account is approaching the IAM customer-managed-policy quota (1500 default, 5000 max). Escalate.

## Likely causes (in order)

1. **`DeleteConflictException: Cannot delete a policy attached to entities`.** A detach silently succeeded at the API level but IAM's eventual-consistency window means `DeletePolicy` still sees the entity attachment. The 3-retry loop with backoff (~700ms total) usually absorbs this; metric emission means it didn't.
2. **Non-default policy versions still present.** IAM rejects `DeletePolicy` if the policy has multiple versions. The Lambda iterates `ListPolicyVersions` → `DeletePolicyVersion` for every non-default version before calling `DeletePolicy`. If `iam:DeletePolicyVersion` was removed from the role, every delete after the first version-creation fails.
3. **`AccessDenied` on `iam:DeletePolicy`.** The `period-rollover` Lambda's role policy must include `iam:DeletePolicy` scoped to `bbg-deny-*`. A redeploy drift or SCP can revoke this.
4. **`NoSuchEntity` (404).** The policy was deleted out-of-band by an operator. The Lambda treats this as a real failure and emits the metric, but the resource is already in the desired state. Safe to acknowledge and move on.
5. **`Throttling` / `RateExceeded`.** IAM API throttle outlasted the retry budget. Same shape as the detach failure; almost always self-heals.

## Investigation

```bash
# Recent rollover Lambda logs — the warn line precedes the metric emission
aws logs tail /aws/lambda/dev-bbg-period-rollover --since 24h --region us-west-2 \
  --filter-pattern '"delete policy failed after retries"'

# Per-attempt retry messages (shows the IAM error class, e.g.
# DeleteConflictException, AccessDenied, NoSuchEntity)
aws logs tail /aws/lambda/dev-bbg-period-rollover --since 24h --region us-west-2 \
  --filter-pattern '"delete policy" "failed; retrying"'

# Surface stale bbg-deny-* policies — anything from a period earlier than
# "this month" should not exist
aws iam list-policies --scope Local --max-items 200 --region us-west-2 \
  | jq '.Policies[]
        | select(.PolicyName | startswith("bbg-deny-"))
        | {PolicyName, Arn, AttachmentCount, CreateDate}'

# How many customer-managed policies exist in the account? (quota: 1500 default)
aws iam get-account-summary --region us-west-2 \
  | jq '.SummaryMap | {Policies, PoliciesQuota}'

# Confirm the Lambda's IAM policy still grants iam:DeletePolicy +
# iam:DeletePolicyVersion + iam:ListPolicyVersions on bbg-deny-*
aws iam get-role-policy \
  --role-name dev-bbg-period-rollover-role \
  --policy-name dev-bbg-period-rollover-iam-policy --region us-west-2
```

## Remediation

**Cause 1 — `DeleteConflictException`.** Re-invoke for the same period; IAM will be eventually consistent:

```bash
aws lambda invoke --function-name dev-bbg-period-rollover \
  --payload '{"period":"2026-04"}' --cli-binary-format raw-in-base64-out \
  --region us-west-2 /tmp/out.json && cat /tmp/out.json
```

**Cause 2 — Missing `iam:DeletePolicyVersion`.** Redeploy the EnforcementStack; the grant is in `infra/lib/enforcement-stack.ts` near lines 131-136:

```bash
cdk deploy 'DevAppStage/Enforcement-us-west-2'
```

If the policy has stuck non-default versions, you can manually drain them:

```bash
POLICY_ARN=arn:aws:iam::<acct>:policy/bbg-deny-<hash>-2026-04
aws iam list-policy-versions --policy-arn "$POLICY_ARN" --region us-west-2
# For each non-default version:
aws iam delete-policy-version --policy-arn "$POLICY_ARN" --version-id v2 --region us-west-2
aws iam delete-policy --policy-arn "$POLICY_ARN" --region us-west-2
```

**Cause 3 — `AccessDenied` on `iam:DeletePolicy`.** Same redeploy as cause 2. If an SCP is the cause, escalate.

**Cause 4 — `NoSuchEntity`.** Acknowledge the alarm. Optional: invoke for the period to clear any remaining spend rows.

**Cause 5 — Throttling.** Re-invoke; idempotent.

**Manual cleanup of accumulated stale policies** (if account is near quota and you can't wait for the next rollover):

```bash
# CAUTION: this deletes every bbg-deny-* policy in the account. Only run if
# every principal has had their attached deny policy detached AND you have
# confirmed no current-period bbg-deny-* policies are present.
aws iam list-policies --scope Local --max-items 200 --region us-west-2 \
  | jq -r '.Policies[]
           | select(.PolicyName | startswith("bbg-deny-"))
           | select(.AttachmentCount == 0)
           | .Arn' \
  | xargs -I{} aws iam delete-policy --policy-arn {} --region us-west-2
```

Acceptance: alarm transitions to OK within 5 minutes after the offending policy is deleted, AND `aws iam list-policies | jq '.Policies[] | select(.PolicyName | startswith("bbg-deny-"))'` shows only current-period policies.

## Related runbooks

- [`period-rollover`](../period-rollover.md) — the Lambda this metric is emitted from
- [`enforcement`](../enforcement.md) — creates the `bbg-deny-*` policies that the rollover Lambda is trying to clean up
- [`PeriodRolloverDetachFailure`](period-rollover-detach-failure.md) — the detach-side companion alarm; if both fire together, fix the detach side first (a delete will keep failing until the policy is unattached)
