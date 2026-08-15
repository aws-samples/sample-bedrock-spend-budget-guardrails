# Runbook: `EnforcementErrors`

## Symptom

CloudWatch alarm `<stage>-bbg-enforcement-errors` fires when the `bbg.EnforcementErrors` metric is `> 0` for **1 evaluation period** (`treatMissingData: NOT_BREACHING`). The metric increments each time the `enforcement` Lambda failed to either (a) create / look up the `bbg-deny-*` IAM policy or (b) attach that policy to the offending user or role. A budget breach was detected from the `RunningSpend` DynamoDB stream but the corresponding deny policy never landed — the principal can keep calling Bedrock past their limit until the error is resolved.

Default threshold: `> 0` over 1 period (immediate).

## Severity guidance

- **Sev3** — repeated errors for the same principal, or any principal whose `spendUsd` is materially above their budget limit while no policy is attached. Real spend is leaking past enforcement; page the on-call.
- **Sev4** — a single transient `Throttling` / `ServiceFailure` from IAM that succeeded on the next stream record (the DynamoDB stream auto-retries). Confirm the principal eventually got a `bbg-deny-*` policy and close.

## Likely causes (in order)

1. **`LimitExceeded: Cannot exceed quota for PoliciesPerUser/Role: 10`**. The principal already has 10 customer-managed policies attached. BBG can't attach an 11th. This is the single most common case in long-lived accounts.
2. **`AccessDenied` on `iam:CreatePolicy` / `iam:AttachUserPolicy` / `iam:AttachRolePolicy`**. The enforcement Lambda's role lost a permission, or an SCP / permissions boundary on the target principal denies the attach.
3. **Principal no longer attachable.** The user or role was deleted between the time `RunningSpend` was written and the stream record was processed. `principalToAttachTarget` returns `null`; the deny policy is created but never attached. (This path logs but does **not** increment `EnforcementErrors` — only true API failures do.)
4. **DynamoDB stream consumer failure / throttling** preventing `enforcement` from running at all. The stream backs up and breaches go undetected. Check Lambda invocation errors and iterator age for `<stage>-bbg-enforcement-<region>`.
5. **`bbg-deny-*` policy ARN scoping mismatch.** The Lambda's IAM policy restricts `iam:AttachUser/RolePolicy` via an `ArnEquals` condition on `bbg-deny-*`. If the policy name pattern was changed without updating the IAM condition, every attach fails with `AccessDenied`.

## Investigation

```bash
# Tail enforcement Lambda logs for the underlying IAM error
aws logs tail /aws/lambda/dev-bbg-enforcement-us-west-2 --since 1h --region us-west-2 --filter-pattern 'EnforcementErrors OR LimitExceeded OR AccessDenied'

# Lambda invocation metrics + iterator age (stream backup signal)
aws cloudwatch get-metric-statistics --namespace AWS/Lambda --metric-name Errors \
  --dimensions Name=FunctionName,Value=dev-bbg-enforcement-us-west-2 \
  --start-time $(date -u -v-1H '+%Y-%m-%dT%H:%M:%SZ') --end-time $(date -u '+%Y-%m-%dT%H:%M:%SZ') \
  --period 300 --statistics Sum --region us-west-2

# How many policies are already attached to the offending principal?
aws iam list-attached-user-policies --user-name <username> --region us-west-2
aws iam list-attached-role-policies --role-name <rolename> --region us-west-2

# Find RunningSpend rows that breached but never got an enforcementPolicyArn stamped
aws dynamodb scan --table-name dev-bbg-running-spend --region us-west-2 \
  --filter-expression 'attribute_not_exists(enforcementPolicyArn) AND spendUsd >= :limit' \
  --expression-attribute-values '{":limit":{"N":"10"}}' --select COUNT
```

## Remediation

- **Quota exceeded (`LimitExceeded`)**: detach an unused customer-managed policy from the principal, then re-trigger by writing any small update to the `RunningSpend` row (e.g., `aws dynamodb update-item ... SET retryEnforcement = :v`). Long-term fix: request an IAM quota increase for that account or migrate the principal to a permissions-boundary-based enforcement model.
- **Lost IAM permission**: redeploy the EnforcementStack:
  ```bash
  cdk deploy 'DevAppStage/Enforcement-us-west-2'
  ```
- **Stream backup**: increase `enforcement` Lambda's reserved concurrency (currently capped to protect IAM API throttles) or split the budget table by principal-prefix shard.
- **Stuck breach with no policy attached**: as a one-time manual mitigation, attach the relevant `bbg-deny-<principal>-<target>-<period>` policy directly:
  ```bash
  aws iam attach-user-policy --user-name <user> --policy-arn arn:aws:iam::<acct>:policy/bbg-deny-<...>
  ```

## Related Lambda runbooks

- [`enforcement`](../enforcement.md)
- [`meter`](../meter.md) — upstream writer to `RunningSpend`; if `MeterUnjoined` is also firing, fix that first.
