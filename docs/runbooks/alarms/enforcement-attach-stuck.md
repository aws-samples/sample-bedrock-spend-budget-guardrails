# Runbook: `EnforcementAttachStuck`

## Symptom

CloudWatch alarm `<stage>-bbg-enforcement-attach-stuck` fires when the `bbg.EnforcementAttachStuck` metric is `> 0` for **1 evaluation period** of 5 minutes (`treatMissingData: NOT_BREACHING`). The metric increments each time the `enforcement` Lambda exhausted its in-process retry budget (3 attempts at 100ms / 400ms / 1600ms base delays with ±50% jitter) trying to attach a `bbg-deny-*` IAM policy after the policy ARN was already stamped onto the `RunningSpend` row.

This is the dangerous failure mode: the spend row says "this principal has been enforced" (so subsequent stream records short-circuit out), but no IAM policy is actually attached. **The principal can keep invoking Bedrock past their budget until an operator manually re-attaches the policy.**

The DynamoDB stream is configured for at-most-once delivery to the enforcement Lambda, so the record will not be re-processed automatically.

Default threshold: `> 0` over 1 period.

The metric carries a `principal=<truncated arn>` dimension so you can tell at a glance which principal is stuck.

## Severity guidance

- **Sev2** — multiple principals stuck, or any principal whose `spendUsd` is materially above their budget limit (e.g., 2x or more) while no policy is attached. Real spend is leaking past enforcement; page on-call immediately and start manual remediation.
- **Sev3** — a single principal stuck whose spend is just barely over the budget limit (so cost exposure is bounded), or a principal that turns out to have been deleted between stamp and attach (no actual exposure). Page during business hours.

## Likely causes (in order)

1. **Transient IAM throttling that outlasted the retry budget.** Three retries with ~2 seconds of total backoff is enough cover for typical IAM rate limits, but a sustained throttle storm — usually caused by a load-test or a separate runaway IAM-write process in the same account — can blow through it.
2. **Principal deleted between the `attribute_not_exists` stamp and the attach call.** The user or role was deleted in the milliseconds between stamping `enforcementPolicyArn` and calling `iam:AttachUserPolicy` / `iam:AttachRolePolicy`. The IAM API returns `NoSuchEntityException`; retries don't help because the principal is gone. Operationally fine — a deleted principal can't invoke Bedrock — but the row is left stamped.
3. **`LimitExceeded: Cannot exceed quota for PoliciesPerUser/Role`.** The principal already has 10 customer-managed policies attached. Same as cause #1 of `EnforcementErrors`, but here it survived all three retries. Quota increase or detach an unused policy.
4. **`AccessDenied` on the attach.** The Lambda's IAM role lost a permission, an SCP was applied to the target principal, or the deny-policy ARN scope was tightened below `bbg-deny-*`. Retries can't fix a deny.
5. **IAM service degradation in the region.** Rare. Check the AWS Health dashboard.

## Investigation

```bash
# Find the structured failure log lines and pull the affected principals + policy ARNs
aws logs filter-log-events --log-group-name /aws/lambda/dev-bbg-enforcement-us-west-2 \
  --filter-pattern '"Enforcement attach failed after retries"' \
  --start-time $(($(date +%s) * 1000 - 21600000)) --region us-west-2 \
  | jq '.events[].message | fromjson? | {spendArn, policyArn, principal, err}'

# Recent EnforcementAttachStuck count by 5-min period
aws cloudwatch get-metric-statistics --namespace bbg --metric-name EnforcementAttachStuck \
  --start-time $(date -u -v-6H '+%Y-%m-%dT%H:%M:%SZ') --end-time $(date -u '+%Y-%m-%dT%H:%M:%SZ') \
  --period 300 --statistics Sum --region us-west-2

# Which principals are stuck right now (one row per dimensioned metric)
aws cloudwatch list-metrics --namespace bbg --metric-name EnforcementAttachStuck \
  --region us-west-2

# Confirm the principal still exists
aws iam get-user --user-name <name> --region us-west-2
# or:
aws iam get-role --role-name <name> --region us-west-2

# Confirm the deny policy actually exists (it should — `ensurePolicy` runs before the stamp)
aws iam get-policy --policy-arn arn:aws:iam::<acct>:policy/bbg-deny-<hash>-<period> --region us-west-2

# Count the principal's currently-attached customer-managed policies (10 = at quota)
aws iam list-attached-user-policies --user-name <name> --region us-west-2 \
  | jq '.AttachedPolicies | length'

# Look at the breaching RunningSpend row — is enforcementPolicyArn really set?
aws dynamodb get-item --table-name dev-bbg-running-spend --region us-west-2 \
  --key '{"principal":{"S":"<principal>"},"sk":{"S":"<sk>"}}'
```

## Remediation

1. **Identify the stuck rows.** From the structured log line `Enforcement attach failed after retries`, gather `principal`, `policyArn`, and `spendArn` (formatted as `<principal>|<sk>`).

2. **Confirm the principal still exists** — see the `aws iam get-user` / `get-role` calls above. If the principal is deleted, the row is in a benign terminal state: leave the `enforcementPolicyArn` stamp in place so `period-rollover` can GC the orphan policy at month-end. No further action required.

3. **Resolve the underlying cause** before re-attaching:
   - Throttling: confirm `bbg.EnforcementErrors` rate is back to normal and IAM throttle metrics in the AWS console show recovery.
   - Quota exceeded: detach an unused customer-managed policy from the principal, OR open a service quota increase ticket for "Customer managed policies attached to a role" / "Customer managed policies attached to a user" (default 10, max ~20).
   - AccessDenied: redeploy `EnforcementStack` (`cdk deploy 'DevAppStage/Enforcement-us-west-2'`) to repair drifted Lambda role permissions; verify no SCP / permissions boundary on the target principal denies attach of `bbg-deny-*`.

4. **Manually re-attach the policy** once the underlying cause is resolved:

   ```bash
   aws iam attach-user-policy --user-name <user> \
     --policy-arn arn:aws:iam::<acct>:policy/bbg-deny-<hash>-<period> \
     --region us-west-2

   # for IAM roles:
   aws iam attach-role-policy --role-name <role> \
     --policy-arn arn:aws:iam::<acct>:policy/bbg-deny-<hash>-<period> \
     --region us-west-2
   ```

5. **Verify the attach landed** and the principal is now blocked:

   ```bash
   aws iam list-attached-user-policies --user-name <user> --region us-west-2 \
     | jq '.AttachedPolicies[] | select(.PolicyName | startswith("bbg-deny-"))'
   ```

   Optionally have the customer attempt a Bedrock invoke and confirm `AccessDeniedException` from the deny policy.

6. **Do NOT clear `enforcementPolicyArn` on the spend row.** The stamp is what `period-rollover` uses to find and delete the policy at month-end; clearing it would orphan the policy.

Acceptance: every stuck row from the alarm window has either a confirmed-deleted principal, OR a verified manual attach. `bbg.EnforcementAttachStuck` returns to 0 for at least one full evaluation period.

## Related Lambda runbooks

- [`enforcement`](../enforcement.md) — full Lambda-level runbook; cause #6 covers this failure mode end-to-end
- [`alarms/enforcement-errors.md`](enforcement-errors.md) — fires on transient attach failures *before* retries are exhausted
- [`period-rollover`](../period-rollover.md) — month-end GC that relies on `enforcementPolicyArn` being stamped
