# Runbook: `inference-profile-refresher`

## Purpose

Daily job that calls `bedrock:ListInferenceProfiles` (and `GetInferenceProfile` per profile) across every metered region and writes a row per profile to the `InferenceProfiles` DDB table. The meter and enforcement Lambdas read this table to (a) translate a `profile#<arn>` budget target into the underlying `model#<modelId>` for cost lookup and (b) build deny policies that cover both the foundation-model ARN and any associated inference-profile ARNs. The Lambda is deployed per-region under the metering stack (`<stage>-bbg-inference-profile-refresher-<region>`) and triggered by EventBridge Scheduler at `cron(0 2 * * ? *)` UTC (one per metered region: `<stage>-bbg-inference-profile-refresh-<region>`), sized to run before the pricing-refresher so profile metadata is fresh by the time pricing joins against it.

## Symptoms

- A budget targeting `profile#arn:...:inference-profile/us.anthropic.claude-sonnet-4-6` never enforces, even though spend climbs past the limit. Enforcement logs `unknown profile, skipping`.
- Admin Inference Profiles page (`/admin/inference-profiles`) returns an empty list or a list with stale `fetchedAt` timestamps.
- Logs in `/aws/lambda/dev-bbg-inference-profile-refresher-us-west-2`: `ListInferenceProfiles failed`.
- Meter logs `profile not found in InferenceProfiles, falling back to model lookup` for a CRIS-routed invocation.

## Likely causes (in order)

1. **Schedule failed to fire.** `MeteringStack` wires a `scheduler.CfnSchedule` (`<stage>-bbg-inference-profile-refresh-<region>`, cron `cron(0 2 * * ? *)` UTC) that invokes the Lambda daily. If `fetchedAt` is days old the schedule is either disabled, deleted, or its IAM role lost `lambda:InvokeFunction` on the target. Confirm with `aws scheduler get-schedule` (see Investigation).
2. **Bedrock API regression in one region.** `ListInferenceProfiles` failed with throttling, `AccessDenied`, or a transient 5xx. Logged as `ListInferenceProfiles failed` (warning, doesn't propagate); the per-region run silently produces zero rows for that region.
3. **`bedrock:GetInferenceProfile` denied.** IAM regression dropped the permission from the Lambda role. Per-profile detail fetch fails (`.catch(() => undefined)`), the row still gets written but with empty `modelId`. Profile-keyed enforcement breaks because the meter can't translate to a model.
4. **New profile shape not handled.** The Lambda assumes `detail.models[0].modelArn` is the underlying foundation model. If AWS adds a new profile type with a different shape, `modelId` ends up empty.

## Investigation

```bash
# Schedule status (the scheduler lives in the Lambda's deploy region; one
# schedule per metered region).
aws scheduler get-schedule --name dev-bbg-inference-profile-refresh-us-west-2 --region us-west-2
# Confirm State=ENABLED, ScheduleExpression="cron(0 2 * * ? *)", and that the
# Target.Arn matches dev-bbg-inference-profile-refresher-us-west-2.

# Last invocation.
aws logs tail /aws/lambda/dev-bbg-inference-profile-refresher-us-west-2 --since 7d --region us-west-2

# Manual invoke (no input payload required).
aws lambda invoke --function-name dev-bbg-inference-profile-refresher-us-west-2 \
  --region us-west-2 /tmp/ip-refresh.json && cat /tmp/ip-refresh.json
# Expected: {"refreshed": N}

# Inspect the table.
aws dynamodb scan --table-name dev-bbg-inference-profiles \
  --region us-west-2 --max-items 20 --output table

# What does Bedrock currently report?
aws bedrock list-inference-profiles --region us-west-2 \
  --query 'inferenceProfileSummaries[].[inferenceProfileId,inferenceProfileName,type]' --output table

# Detail for one profile (verify modelArn is populated).
aws bedrock get-inference-profile \
  --inference-profile-identifier us.anthropic.claude-sonnet-4-6-20250929-v1:0 \
  --region us-west-2
```

## Remediation

### Cause 1 — Schedule failed to fire

Manual invoke first to backfill (idempotent):

```bash
for region in us-east-1 us-east-2 us-west-2; do
  aws lambda invoke --function-name dev-bbg-inference-profile-refresher-$region \
    --region $region /tmp/ip-$region.json
done
```

Then restore the schedule. If `aws scheduler get-schedule` showed `State=DISABLED`:

```bash
aws scheduler update-schedule \
  --name dev-bbg-inference-profile-refresh-us-west-2 \
  --region us-west-2 \
  --state ENABLED \
  --schedule-expression 'cron(0 2 * * ? *)' \
  --schedule-expression-timezone UTC \
  --flexible-time-window 'Mode=OFF' \
  --target "Arn=arn:aws:lambda:us-west-2:<acct>:function:dev-bbg-inference-profile-refresher-us-west-2,RoleArn=<scheduler-role-arn>"
```

If the schedule was deleted entirely, redeploy `MeteringStack` for the affected region — the `scheduler.CfnSchedule` is recreated from CDK source. If the IAM role lost `lambda:InvokeFunction`, the redeploy also restores the `grantInvoke` policy.

### Cause 2 — Regional API regression

Identify which region is failing in the logs, then test directly:

```bash
aws bedrock list-inference-profiles --region us-east-2
```

If transient, re-invoke the Lambda. If persistent, check the AWS Health Dashboard for that region.

### Cause 3 — IAM regression on `GetInferenceProfile`

Verify the policy on the Lambda role grants both actions:

```bash
ROLE=$(aws lambda get-function --function-name dev-bbg-inference-profile-refresher-us-west-2 \
  --region us-west-2 --query 'Configuration.Role' --output text | awk -F/ '{print $NF}')
aws iam list-role-policies --role-name $ROLE
aws iam get-role-policy --role-name $ROLE --policy-name <inline-policy-name>
```

Expected actions: `bedrock:ListInferenceProfiles`, `bedrock:GetInferenceProfile`. Re-deploy `MeteringStack` to restore.

### Cause 4 — New profile shape with empty `modelId`

Inspect the offending profile:

```bash
aws bedrock get-inference-profile \
  --inference-profile-identifier <profile-id> --region us-west-2
```

If `models[0].modelArn` is not the right field (e.g. AWS introduces multi-model profiles), update `lambda/src/inference-profile-refresher/index.ts` to extract the right modelId. Run the unit tests, deploy, and re-invoke.

## Idempotency / safety notes

- **Safe to re-run any time.** Every write is `PutCommand` keyed by `profileArn`. Repeated runs converge to the same rows.
- **Stale rows are NOT deleted.** If a profile is removed from Bedrock, its row stays in the DDB table indefinitely. If a budget targets a deleted profile, enforcement still resolves to the old `modelId`. To clean up, run a manual scan + delete:

  ```bash
  aws dynamodb scan --table-name dev-bbg-inference-profiles --region us-west-2 \
    --query 'Items[?fetchedAt.S < `'"$(date -v-7d +%Y-%m-%d)"'`].profileArn' \
    --output text
  ```

  Then `delete-item` per stale ARN.
- **Don't run more than once per minute per region.** `GetInferenceProfile` is rate-limited; the loop calls it once per profile and the daily cadence is sized accordingly.

## Related runbooks

- [`pricing-refresher.md`](pricing-refresher.md) — sibling daily; same memory/timeout pattern.
- [`meter-unjoined.md`](meter-unjoined.md) — for upstream identity-join failures (different surface, related stack).
- See `infra/lib/enforcement-stack.ts` and `lambda/src/enforcement/index.ts` for how this table is consumed when building deny policies.
