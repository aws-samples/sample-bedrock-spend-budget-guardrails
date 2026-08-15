# Runbooks

Per-alarm and per-component troubleshooting guides.

## Alarms

Per-alarm runbooks live under [`alarms/`](alarms/) — one file per CloudWatch alarm created by `infra/lib/observability-stack.ts`.

- [`MeterUnjoined`](alarms/meter-unjoined.md) — meter saw a Bedrock invocation but couldn't join to a CloudTrail identity within the join window.
- [`EnforcementErrors`](alarms/enforcement-errors.md) — enforcement Lambda failed to create or attach a `bbg-deny-*` policy. Often `LimitExceeded` (10 customer-managed policies already attached) or an IAM `AccessDenied`.
- [`EnforcementAttachStuck`](alarms/enforcement-attach-stuck.md) — `enforcementPolicyArn` was stamped on a spend row but the `iam:AttachUser/RolePolicy` failed all 3 in-process retries. Principal is **NOT** blocked until an operator manually attaches.
- [`EnforcementUnattachable`](alarms/enforcement-unattachable.md) — a `deny` budget targets a principal BBG cannot attach a scoped deny to. The budget meters and alerts but does **NOT** enforce.
- [`EnforcementAppliedRate`](alarms/enforcement-applied-rate.md) — 5-min `Sum` of `EnforcementApplied` > 25: possible mass-enforcement (the ENF-2 pager). Operator response is the `bbg:pauseEnforcement` kill-switch.
- [`CwlForwardFailed`](alarms/cwl-forward-failed.md) — the cross-region `cwl-forwarder` dropped EventBridge entries (`PutEvents FailedEntryCount > 0`). That spend never reaches the meter, so enforcement never fires for it.
- [`PeriodRolloverDetachFailure`](alarms/period-rollover-detach-failure.md) — month-end rollover couldn't detach a `bbg-deny-*` policy after retries.
- [`PeriodRolloverDeleteFailure`](alarms/period-rollover-delete-failure.md) — month-end rollover detached the policy but couldn't delete it.
- [`PricingRefreshAge`](alarms/pricing-refresh-age.md) — the oldest live-model `fetchedAt` in the `Pricing` table is 36+ hours old, or the `pricing-refresher` went dark entirely (missing data treated as breaching). Check the EventBridge Scheduler and the Lambda's most recent run.
- [`OrgDiscountResolverDegraded`](alarms/org-discount-resolver-degraded.md) — the org/OU discount resolver couldn't reach AWS Organizations. OU/org discounts stop re-resolving and any prior-materialized `effectivePct` keeps applying at its last value (silent stale money).
- [`PricingGapCount`](alarms/pricing-gap-count.md) — a Bedrock model is in `ListFoundationModels` but has no Pricing API match for 4+ consecutive hours. The model row is written with `gap=true` and any caller using it trips `UnpricedInvocations`.
- [`PricingApiSchemaChanged`](alarms/pricing-api-schema-changed.md) — informational Sev5: AWS Pricing API added new SKU attributes that BBG might want to surface (forward-compat watch).
- [`UnpricedInvocations`](alarms/unpriced-invocations.md) — meter received Bedrock invocations against a model with no priced row. Token counts are still recorded; only the dollar amount is missing.
- [`ReconciliationDelta`](alarms/reconciliation-delta.md) — daily CUR reconciler found a delta > $1 between the meter's totals and CUR 2.0's `line_item_iam_principal` allocation.
- [`CanaryFailure`](alarms/canary-failures.md) — CloudWatch Synthetics canary couldn't load the SPA URL (only present when `bbg:canaryUrl` context is set).

## Components

Each Lambda + cross-cutting component has its own runbook under this directory:

- [`meter.md`](meter.md) — inputs (CWL subscription + `bbg.identity-arrived` events + cross-region / cross-account `bbg.bedrock-invocation` EventBridge events from member accounts), outputs (`RunningSpend` + `PendingMeter`), idempotency via `processedRequestIds`.
- [`meter-unjoined.md`](meter-unjoined.md) — what to do when the meter sees an invocation but identity-cache hasn't arrived yet.
- [`identity-cache.md`](identity-cache.md) — EventBridge consumer; canonicalization for 5 caller types (IAM user, IAM role, SSO, Federated, AssumedRole, Bedrock Agent service role).
- [`enforcement.md`](enforcement.md) — DDB stream consumer; creates + attaches `bbg-deny-*` policies. Cross-account writes via member's `bbg-enforcement` role (assume-role helper in `lambda/src/shared/iam-cross-account.ts`, 1-hour client cache).
- [`period-rollover.md`](period-rollover.md) — monthly + weekly + daily + 5h cron schedules + on-demand invoke. Detaches + deletes deny policies including in member accounts via cross-account assume-role.
- [`pricing-refresher.md`](pricing-refresher.md) — daily refresh against the AWS Pricing API.
- [`org-discount-resolver.md`](org-discount-resolver.md) — hourly (`cron(20 * * * ? *)`) + on-write resolver for hierarchical org/OU/account pricing discounts. Walks the Organizations tree off the meter hot path and materializes the most-specific-wins `effectivePct` onto each `discount#<accountId>` row. Degrades to a no-op when Organizations is denied.
- [`cur-reconciler.md`](cur-reconciler.md) — daily Athena query vs. the meter's totals.
- [`notify.md`](notify.md) — DDB stream consumer on `Budgets`; SES email on threshold crossings + enforcement events. Reads per-user notification prefs from Cognito custom attrs.
- [`inference-profile-refresher.md`](inference-profile-refresher.md) — daily walk of `bedrock:ListInferenceProfiles` to keep the per-region profile→model resolution fresh.
- [`ledger-writer.md`](ledger-writer.md) — DDB stream consumer on `RunningSpend`; appends per-event Parquet rows under `s3://<ledger-bucket>/ledger/` for Athena reports.
- [`gateway.md`](gateway.md) — optional, opt-in via `bbg:enableGateway=true`. API GW route + Lambda that wraps Bedrock InvokeModel with `sts:SetSourceIdentity` + transitive session tags so multi-agent calls attribute spend to the human caller.
- [`api.md`](api.md) — single API Gateway HTTP API + Cognito JWT authorizer; per-route table; scope-aware authorization model (`BBG-Admin-Wildcard` / `BBG-Admin-<accountId>` Cognito groups → `bbg:scope` claim).

## Cross-cutting

- [`dr.md`](dr.md) — RPO/RTO per data plane + quarterly drill checklist. Multi-region (us-west-2 home + us-east-1 + us-east-2 metered) and multi-account (cross-account StackSet roles) recovery scopes included.

## Member-account components (an earlier change+)

When `MemberStackSetStack` is enabled (any of `bbg:enrolledMemberAccounts`, `bbg:enrolledOrgAccounts`, `bbg:enrolledOus`, `bbg:enrolledWholeOrg`), every enrolled member account receives a small inline-CFN stack with:

- `bbg-enforcement` IAM role (home-region only — gated on the `IsHomeRegion` CFN Condition since IAM is global) — assumed by home enforcement / period-rollover / budgets-api Lambdas.
- `bbg-meter-reader` IAM role (home-region only) — reserved for future cross-account log forwarding.
- Per-region: `BbgBedrockLogGroup` + `BbgInvocationLoggingProvider` custom resource (calls `bedrock:PutModelInvocationLoggingConfiguration`) + `BbgCwlForwarder` Lambda + `BbgCwlSubscription` filter + `BbgBedrockApiRule` EventBridge rule whose target is the home-region default bus directly.

Failure modes for the member-stack live in [`enforcement.md`](enforcement.md) "Cross-account assume-role failed" and [`period-rollover.md`](period-rollover.md) "Cross-account detach/delete failed".
