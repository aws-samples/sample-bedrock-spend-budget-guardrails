# Demo runbook

End-to-end walkthrough of the real-time meter + enforcement loop using **real account data**, not synthetic fixtures. This guide assumes the system is already deployed (see [`README.md`](../README.md) quickstart).

## Prereqs

- The deploy account has Bedrock model access for at least Claude Haiku 4.5 and Claude Sonnet 4.6 (request via Bedrock console → Model access).
- You can run AWS CLI as the deploy account.
- The pricing-refresher has run at least once so the `Pricing` table is populated.

## 1. Seed Cognito users

```bash
BBG_STAGE_PREFIX=dev  npm run -w @bbg/lambda seed:cognito
BBG_STAGE_PREFIX=prod npm run -w @bbg/lambda seed:cognito
```

Set `BBG_ADMIN_EMAIL`, `BBG_USER_EMAIL`, and `BBG_TEMP_PASSWORD` in your shell first; the script reads from those env vars and seeds nothing if they aren't set. Neither user gets a `custom:iam_principal` attribute — the meter records actual CloudTrail principals from real Bedrock callers, so there's nothing to fake.

Use the **Admin → Users** page in the web app after signing in to map a Cognito user to a specific IAM principal if you want to scope `/me/spend` for that user. Otherwise admins see everything via `/admin/spend`.

## 2. Sign in

Open your dev or prod app URL (whatever you configured under `bbg:domainNames` in the SSM operator config). Sign in with the email you set as `BBG_ADMIN_EMAIL` and the temp password you set as `BBG_TEMP_PASSWORD`. On first sign-in you'll be prompted to set a permanent password.

The dashboard loads with KPI tiles (total spend, distinct principals, distinct models, active enforcement).

Optional: add a passkey on the Profile page for password-free future sign-ins.

## 3. Set a budget

Budgets → Create budget. Pick a real principal you've seen in the **Identities** list (any IAM role/user that has called Bedrock recently appears there). For example:

- Principal: the IAM ARN of the role you'll be invoking Bedrock under (your identity provider role's ARN, an EC2 instance profile role, a Lambda execution role, etc.)
- Target: `anthropic.claude-sonnet-4-6` (will be prefixed `model#` automatically; use the exact model id the meter records — the Spend dashboard / Identities pages show it. Some models record a versioned id, e.g. `anthropic.claude-haiku-4-5-20251001-v1:0`)
- Limit: `0.10`
- Action: `Deny (block invocations)`

The row appears in the table with status `Active` (green).

## 4. Generate Bedrock traffic

```bash
npm run -w @bbg/lambda loadgen -- \
  --model us.anthropic.claude-sonnet-4-6 \
  --rps 10 \
  --duration 60s \
  --region us-west-2
```

`loadgen` uses your *current* AWS credential chain (your identity provider role, default profile, whatever you have assumed). CloudTrail records that exact principal as the caller, so the meter attributes spend to it directly — no `--as alice`, no demo creds, no profile override.

Watch the **Spend dashboard** in the web app: spend climbs in near-real-time. The per-model bar chart and per-principal × per-model stacked bar update as invocations land.

## 5. Watch enforcement fire

When the principal's Sonnet 4.6 spend crosses $0.10, the **Budgets** page row turns red ("Enforced (denied)"). Within seconds:

- A `bbg-deny-<hash>-<period>` IAM policy is created.
- It's attached to the principal (user via `iam:AttachUserPolicy`, role via `iam:AttachRolePolicy`).
- The next `loadgen` call fails with:

  ```
  AccessDeniedException: ... is not authorized to perform: bedrock:InvokeModel
  on resource: arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-6
  with an explicit deny in an identity-based policy:
  arn:aws:iam::<account>:policy/bbg-deny-<hash>-<period>
  ```

Run a Haiku 4.5 invocation in another terminal and confirm it still works — the deny is per-target, not blanket.

The global enforcement banner (Cloudscape Flashbar at the top of every page) also lights up while any `bbg-deny-*` is attached.

## 6. Release the deny (admin override)

In **Budgets**, click the orange `Release` button on the enforced row. Confirms detach + delete of the deny policy + clears `enforcementPolicyArn` on the spend row. The principal can immediately invoke Sonnet 4.6 again.

## 7. Reports

**Reports** page → choose a preset → **Run query**. Athena runs against the JSONL ledger that the `ledger-writer` Lambda has been emitting from every spend update. The page renders bar/line/table charts depending on the preset.

## 8. Period rollover (skip-the-month demo)

```bash
npm run -w @bbg/lambda force-rollover
```

Manually invokes the `period-rollover` Lambda. It detaches every active `bbg-deny-*`, deletes them, and resets the spend rows. The Budgets page returns to all green.

## 9. Dual-channel enforcement (advanced, opt-in)

If you've deployed with `bbg:enableBudgetsAction=true` (see [`docs/parallel-enforcement.md`](parallel-enforcement.md)), you can watch BOTH enforcement channels fire on the same principal. The real-time channel fires within seconds of the spend crossing the limit; the AWS Budgets channel fires on the next CUR refresh (~24h trailing) and attaches a separately-named `bbg-deny-cur-*` policy.

### 9a. Set a budget and watch the AWS Budget object materialize

```bash
# 1. In the web app Budgets page, set a $0.10 deny budget on a Sonnet-using principal.
# 2. Within ~10s the budgets-action-sync Lambda mirrors the row to AWS Budgets.
aws budgets describe-budgets --account-id "$AWS_ACCOUNT_ID" \
  --query 'Budgets[?starts_with(BudgetName, `bbg-`)].[BudgetName, BudgetLimit.Amount]' \
  --output table
```

You should see one `bbg-<hash>-arn_aws_iam___user_alice-model_anthropic_claude-sonnet-4-6` row with a `0.10` limit.

### 9b. Watch both channels fire

```bash
# Generate enough traffic to breach the budget.
npm run -w @bbg/lambda loadgen -- \
  --model us.anthropic.claude-sonnet-4-6 \
  --rps 10 --duration 60s \
  --region us-west-2

# Within ~30s: the near real-time channel attaches `bbg-deny-<hash>-<period>`.
aws iam list-attached-user-policies --user-name alice \
  --query 'AttachedPolicies[?starts_with(PolicyName, `bbg-deny-`)].PolicyName'
# → ["bbg-deny-aaa111bbb222-2026-05"]

# ~24h later (or sooner if you force a CUR refresh):
# The Budgets channel ALSO attaches `bbg-deny-cur-<hash>-<period>`.
# Both policies coexist; either one independently denies the principal.
```

### 9c. Pause the meter to prove Budgets is independent

This demonstrates the defense-in-depth value:

```bash
# Disable the real-time meter's DDB stream consumer. The CloudWatch Logs
# subscription stops feeding RunningSpend, so the real-time channel cannot fire.
aws lambda put-event-source-mapping \
  --uuid <enforcement-event-source-mapping-uuid> --no-enabled

# Now run loadgen again. RunningSpend doesn't update; real-time enforcement
# never fires. But the next CUR refresh (force one via the cur-reconciler
# Lambda) will eventually see the breach and AWS Budgets will attach
# bbg-deny-cur-* on its own — the only operator action needed is the
# original budget row in DDB.
```

### 9d. Period rollover detaches both

```bash
npm run -w @bbg/lambda force-rollover
# Both bbg-deny-* AND bbg-deny-cur-* are detached and deleted in one pass.
```

## 10. Multi-agent (advanced, opt-in)

If you've enabled the optional gateway and multi-agent stacks (`bbg:enableGateway=true, bbg:enableMultiAgent=true`):

- The gateway lets you call Bedrock with `sts:AssumeRole` + transitive session tags + `SetSourceIdentity=<email>`, so end-user attribution propagates through Bedrock Agents to the human even when the underlying CloudTrail principal is a service role.
- The **Agent sessions** page shows conversations rolled up to the end-user email even though every downstream `InvokeModel` ran under the supervisor's and collaborators' service roles.
