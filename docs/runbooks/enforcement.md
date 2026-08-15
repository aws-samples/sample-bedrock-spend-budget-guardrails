# Runbook: `enforcement` Lambda

## Purpose

The `enforcement` Lambda is the budget-breach reactor. It consumes the `RunningSpend` DynamoDB stream, looks up the matching `Budgets` row (exact target plus a `<dimension>#*` wildcard fallback), and on a `deny`-mode breach builds a customer-managed `bbg-deny-<shortHash>-<period>` IAM policy targeting the foundation-model ARN(s) and any associated inference-profile ARNs. The policy is created (idempotent against `EntityAlreadyExistsException`), stamped onto the spend row via a set-once `attribute_not_exists` guard, then attached to the offending IAM user or role.

It also writes `PrincipalActivity` timeline rows via `recordActivity` (`lambda/src/shared/activity.js`) — `enforcement.applied` on a successful attach and `enforcement.unattachable` when a breached principal has no attach target — so the SPA's per-principal timeline shows the deny alongside the manual `enforcement.released` events written by the budgets API; the helper never throws and no-ops when `PRINCIPAL_ACTIVITY_TABLE` is unset.

## Symptoms

- CloudWatch alarm `<stage>-bbg-enforcement-errors` firing.
- A budget breach is visible in the SPA (`spendUsd >= limitUsd`) but the user is still able to invoke the model — the deny policy didn't get created or didn't get attached.
- Conversely: a deny policy got attached to the wrong principal (rare; usually a budget-target misconfiguration).
- `bbg.EnforcementApplied` flat at zero while breaches are happening.
- `bbg.AlertOnlyBreaches` climbing — that's expected for `action: alert` budgets but an operator may misread it as a malfunction.
- DLQ depth on `<stage>-bbg-enforcement-dlq`.
- Log lines `Failed to create/get deny policy`, `Failed to attach deny policy`, or `enforcement record failed`.
- IAM `LimitExceeded` — the principal already has 10 customer-managed policies attached (the IAM cap), so the new deny can't be attached.
- `principal not directly attachable` info log on a `Federated`/`SAML`/agent-service principal: for an `sso-user#`/`sourceIdentity#` budget or a role-keyed budget with a `condition`, enforcement attaches the deny to the **issuer role** scoped to the one identity (`aws:userid` / `aws:SourceIdentity` / `aws:PrincipalTag`) — normal. But for a `deny` budget on a principal with NO attach target AND NO scoping condition (`principal#unknown`, a GetFederationToken federated user, or a `sessionTag/…` key without the gateway), enforcement does **not** create an inert policy — it emits `EnforcementUnattachable` and the budget does not enforce. See [`alarms/enforcement-unattachable.md`](alarms/enforcement-unattachable.md).

## Likely causes (in order)

1. **IAM `LimitExceeded` on `AttachUser/RolePolicy`.** IAM caps customer-managed policy attachments at 10 per user/role. This is the most common production hit. The Lambda creates the policy but the attach fails — `bbg.EnforcementErrors` increments. Service-quota-increase ticket required for >10.
2. **`AWS_ACCOUNT_ID` env var not set / wrong.** `currentAccountId()` reads `process.env.AWS_ACCOUNT_ID` (injected by the CDK stack) and throws if missing. After a manual env edit this is the loud failure mode.
3. **`EntityAlreadyExistsException` recovery path failing.** The Lambda catches it and `GetPolicy`s the existing policy by deterministic ARN (`bbg-deny-<sha1[0:12]>-<YYYY-MM>`). If `iam:GetPolicy` is denied (someone tightened the IAM policy below `bbg-deny-*`), the recovery fails.
4. **Deny policy IAM scoping too tight.** The Lambda's role can only Create/Delete/Get/Attach policies whose ARN matches `arn:aws:iam::<acct>:policy/bbg-deny-*` (via `iam:PolicyARN` ArnEquals). Don't widen this — but if someone tightened it further (e.g., to a single account) cross-account principals can't be enforced.
5. **`InferenceProfiles` table query throwing.** `profilesForModel()` swallows the error with `.catch(() => undefined)` and returns an empty list, so the deny policy has the bare-model ARN but no profile ARNs. A user invoking via a profile would still hit the model deny… unless they invoke through a profile that resolves to the model in a different region. Watch for users circumventing a model deny via profile invocation.
6. **`enforcementPolicyArn` stamped but attach failed (`EnforcementAttachStuck` alarm firing).** The set-once guard via `attribute_not_exists(enforcementPolicyArn)` makes `stampEnforcementOnSpend()` idempotent, but the IAM attach is a separate API call. The Lambda now retries the attach 3 times in-process with exponential backoff and ±50% jitter (100ms / 400ms / 1600ms base delays). If all three retries fail, it emits a `bbg.EnforcementAttachStuck` count metric (with a `principal=<truncated arn>` dimension) and logs a structured error. The dedicated `<stage>-bbg-enforcement-attach-stuck` alarm fires on `Sum > 0` over 5 minutes — see [`alarms/enforcement-attach-stuck.md`](alarms/enforcement-attach-stuck.md) for the dedicated alarm runbook. The DynamoDB stream is configured for at-most-once delivery to enforcement, so the Lambda will *not* re-process the record after a terminal failure. The spend row remains stamped (intentional — `period-rollover` will still find and clean up the policy at month-end) but the principal is **NOT** blocked until an operator manually attaches.
7. **DDB stream behind.** Stream consumer lag means breaches process minutes late. Check `IteratorAge` on the event source mapping.
8. **Budget row disabled / wrong target string.** `evaluateAndEnforce()` skips disabled budgets and budgets where `spendUsd < limitUsd`. A misconfigured budget target (e.g., `model#claude-opus-4-7-v1` instead of the canonical `model#anthropic.claude-opus-4-7-v1`) silently doesn't match.
9. **Cross-account assume-role failed (an earlier change+).** When the breach is in a member account (principal ARN's account ID != home account ID), enforcement assumes the member's `bbg-enforcement` role via `lambda/src/shared/iam-cross-account.ts` and calls IAM there. Failure modes: (a) member account isn't enrolled (no `bbg-enforcement` role exists) — `STS::AssumeRole` returns `AccessDenied`; (b) StackSet drifted, role was deleted manually — same; (c) member-stack's home-region condition failed (fix) so the role only exists in one region — assume-role works but pinned to the home region; (d) `iam-cross-account.ts` 1-hour client cache is serving stale credentials after a member-account StackSet update — clear by restarting the Lambda or waiting for cache TTL.

## Investigation

```bash
# Recent enforcement logs (errors first)
aws logs tail /aws/lambda/dev-bbg-enforcement \
  --since 30m --filter-pattern '?ERROR ?WARN ?failed ?Limit' --region us-west-2

# Lambda invocation + error counts
aws cloudwatch get-metric-statistics \
  --namespace AWS/Lambda --metric-name Errors \
  --dimensions Name=FunctionName,Value=dev-bbg-enforcement \
  --start-time $(date -u -v-1H +%FT%TZ) --end-time $(date -u +%FT%TZ) \
  --period 60 --statistics Sum --region us-west-2

# Stream iterator age (lag)
aws cloudwatch get-metric-statistics --namespace AWS/Lambda \
  --metric-name IteratorAge \
  --dimensions Name=FunctionName,Value=dev-bbg-enforcement \
  --start-time $(date -u -v-1H +%FT%TZ) --end-time $(date -u +%FT%TZ) \
  --period 60 --statistics Maximum --region us-west-2

# DLQ depth
aws sqs get-queue-attributes \
  --queue-url $(aws sqs get-queue-url --queue-name dev-bbg-enforcement-dlq \
    --region us-west-2 --query QueueUrl --output text) \
  --attribute-names ApproximateNumberOfMessages --region us-west-2

# All current bbg-deny-* policies (path-prefix scan)
aws iam list-policies --scope Local --max-items 200 --region us-west-2 \
  | jq '.Policies[] | select(.PolicyName | startswith("bbg-deny-")) | {PolicyName, Arn, AttachmentCount, CreateDate}'

# What's attached to a specific user / role?
aws iam list-attached-user-policies --user-name <user> --region us-west-2
aws iam list-attached-role-policies --role-name <role> --region us-west-2

# Specific deny policy's content (for verifying Resource list)
aws iam get-policy-version --policy-arn arn:aws:iam::123456789012:policy/bbg-deny-<hash>-2026-05 \
  --version-id v1 --region us-west-2

# Inspect the breaching RunningSpend row (does it have enforcementPolicyArn stamped?)
aws dynamodb get-item --table-name dev-bbg-running-spend \
  --key '{"principal":{"S":"principal#arn:aws:iam::123456789012:role/SomeRole"},"sk":{"S":"period#2026-05#target#model#anthropic.claude-opus-4-7-v1"}}' \
  --region us-west-2

# The matching Budgets row
aws dynamodb get-item --table-name dev-bbg-budgets \
  --key '{"principal":{"S":"principal#..."},"target":{"S":"model#anthropic.claude-opus-4-7-v1"}}' \
  --region us-west-2

# BBG metrics
aws cloudwatch get-metric-statistics --namespace bbg --metric-name EnforcementApplied \
  --start-time $(date -u -v-1H +%FT%TZ) --end-time $(date -u +%FT%TZ) \
  --period 60 --statistics Sum --region us-west-2
aws cloudwatch get-metric-statistics --namespace bbg --metric-name EnforcementErrors \
  --start-time $(date -u -v-1H +%FT%TZ) --end-time $(date -u +%FT%TZ) \
  --period 60 --statistics Sum --region us-west-2

# Stamped-but-not-attached failures (the EnforcementAttachStuck alarm)
aws cloudwatch get-metric-statistics --namespace bbg --metric-name EnforcementAttachStuck \
  --start-time $(date -u -v-6H +%FT%TZ) --end-time $(date -u +%FT%TZ) \
  --period 300 --statistics Sum --region us-west-2

# Which principals are stuck? Use the `principal` dimension on the metric.
aws cloudwatch list-metrics --namespace bbg --metric-name EnforcementAttachStuck \
  --region us-west-2

# Cross-reference against RunningSpend rows that have enforcementPolicyArn set
# but where the principal is still able to invoke (i.e., the policy is missing
# from list-attached-{user,role}-policies).
aws dynamodb scan --table-name dev-bbg-running-spend --region us-west-2 \
  --filter-expression 'attribute_exists(enforcementPolicyArn)' \
  --projection-expression 'principal,sk,enforcementPolicyArn'
```

## Remediation

**Cause 1 — IAM `LimitExceeded` (10 attached policies cap).** Either:
- Detach an unused customer-managed policy from the principal, then re-trigger enforcement (any future spend write to `RunningSpend` re-fires the stream record); or
- Open a service quota increase request for "Customer managed policies attached to a role" / "Customer managed policies attached to a user". The default is 10, max is typically 20.

**Cause 2 — `AWS_ACCOUNT_ID` missing.** Redeploy the enforcement stack (CDK injects it):

```bash
cdk deploy 'DevAppStage/Enforcement'
```

**Cause 3 — `iam:GetPolicy` denied on the recovery path.** Confirm the role policy still grants `iam:GetPolicy` on `arn:aws:iam::<acct>:policy/bbg-deny-*`. It does in `infra/lib/enforcement-stack.ts` lines 67-80; redeploy if drifted.

**Cause 4 — Deny ARN scoping too tight.** Don't widen below `bbg-deny-*` — the IAM `iam:PolicyARN` ArnEquals condition is a hard rule. If the breach is in a different account, that's a multi-account architecture extension, not a quick fix.

**Cause 5 — InferenceProfiles query failing.** Force-refresh inference profiles:

```bash
aws lambda invoke --function-name dev-bbg-inference-profile-refresher-us-west-2 \
  --region us-west-2 /tmp/out.json && cat /tmp/out.json
```

Then check `dev-bbg-inference-profiles` table has rows with `byModel` GSI populated.

**Cause 6 — Stamped but not attached (`EnforcementAttachStuck` alarm).** The Lambda already retried 3 times with backoff before giving up. Now alarmed via `bbg.EnforcementAttachStuck` — see [`alarms/enforcement-attach-stuck.md`](alarms/enforcement-attach-stuck.md). Manual remediation:

1. **Identify the affected spend row.** Use the structured log line `Enforcement attach failed after retries` to get `principal`, `policyArn`, and `spendArn` (formatted as `<principal>|<sk>`).

   ```bash
   aws logs filter-log-events --log-group-name /aws/lambda/dev-bbg-enforcement-us-west-2 \
     --filter-pattern 'EnforcementAttachStuck' \
     --start-time $(($(date +%s) * 1000 - 21600000)) --region us-west-2
   ```

2. **Confirm the principal still exists.** A deleted user/role is the most likely terminal-failure cause:

   ```bash
   aws iam get-user --user-name <name>   # or get-role --role-name
   ```

   If it's gone, the spend row is in a terminal state — no further enforcement needed; the principal can't invoke Bedrock anyway. Leave the row stamped so `period-rollover` will GC the orphan policy.

3. **Manually attach the policy.** Once you've confirmed the principal exists and the underlying root cause is resolved (IAM throttle subsided, quota raised, etc.):

   ```bash
   aws iam attach-user-policy --user-name <user> \
     --policy-arn arn:aws:iam::<acct>:policy/bbg-deny-<hash>-<period> \
     --region us-west-2
   # or for roles:
   aws iam attach-role-policy --role-name <role> \
     --policy-arn arn:aws:iam::<acct>:policy/bbg-deny-<hash>-<period> \
     --region us-west-2
   ```

4. **Verify the attach landed.**

   ```bash
   aws iam list-attached-user-policies --user-name <user> --region us-west-2 \
     | jq '.AttachedPolicies[] | select(.PolicyName | startswith("bbg-deny-"))'
   ```

The `enforcementPolicyArn` is already stamped on the spend row, so `period-rollover` will still detach + delete this policy correctly at month-end. **Do not** clear `enforcementPolicyArn` on the row — that would break the rollover GC.

**Cause 7 — Stream lag.** Check the event source mapping's `BatchSize` (default 25, `MaxBatchingWindow` 2s) and concurrency. If the stream shard is hot, scale Lambda concurrency.

**Cause 8 — Budget target mismatch.** The canonical target format is `model#<bare-model-id-without-CRIS-prefix>`. Fix the budget row in the SPA's Budgets page (or via the API).

## Idempotency / safety notes

- **Safe to retry the entire Lambda invocation.** Stream record reprocessing is at-least-once; the `attribute_not_exists(enforcementPolicyArn)` guard makes the policy-attach path effectively at-most-once per spend row.
- **Policy creation is idempotent** via `EntityAlreadyExistsException` → `GetPolicy` recovery on a deterministic ARN.
- **Policy attach is retried in-process up to 3 times** with exponential backoff and jitter (100ms / 400ms / 1600ms ±50%) before terminal failure. The DynamoDB stream consumer is configured at-most-once for enforcement, so the in-process retry is the *only* retry — there is no stream redelivery. On terminal failure the `bbg.EnforcementAttachStuck` metric fires the dedicated alarm and an operator must manually re-attach. See cause 6.
- **Do NOT manually delete `bbg-deny-*` policies that have non-zero `AttachmentCount`** — that's `period-rollover`'s job. Manual deletion mid-period leaves orphan attachments.
- **Do NOT widen the `iam:PolicyARN` ArnEquals condition** below `bbg-deny-*` — it's the security boundary that prevents this Lambda from attaching arbitrary IAM policies. See [`docs/threat-model.md`](../threat-model.md) POL-1.
- **`bbg-deny-*` policies are scoped to the period in their name** (`bbg-deny-<hash>-<YYYY-MM>`). Hand-rolling a deny policy in this namespace will get cleaned up by `period-rollover`. Don't do it.
- **Alert-only budgets are non-destructive** — `EnforcementApplied` won't fire, only `AlertOnlyBreaches`. Don't troubleshoot an alert-only "missing enforcement" — it's working as designed.

## Related runbooks

- [`meter.md`](meter.md) — writes the `RunningSpend` rows that this Lambda consumes
- [`identity-cache.md`](identity-cache.md) — produces the canonical principal that becomes the attach target
- [`period-rollover.md`](period-rollover.md) — detaches + deletes the deny policies at month-end
