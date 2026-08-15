# Well-Architected mapping

How BBG aligns with the six AWS Well-Architected pillars.

## Operational Excellence

- **IaC-only**: every resource defined via AWS CDK v2 (TypeScript). Zero manual console clicks beyond the one-time CodeStar Connection approval.
- **GitOps deploys**: `git push origin main` triggers CDK Pipelines to build, synth, and deploy through Dev → Prod (manual approval gate optional via context flag).
- **Self-mutating pipeline**: pipeline updates itself on every push so changes to the deployment definition flow through with the application.
- **Observability**: every Lambda emits structured logs via `@aws-lambda-powertools/logger`, traces via `@aws-lambda-powertools/tracer` (X-Ray), and CloudWatch metrics via `@aws-lambda-powertools/metrics`. Custom metrics include `bbg.MeterUnjoined`, `bbg.UnpricedInvocations`, `bbg.EnforcementApplied`, `bbg.EnforcementErrors`, `bbg.PricingGapCount`, `bbg.PricingRefreshAge`, `bbg.NotifyOpsFallback`, `bbg.OrgDiscountResolved`, `bbg.OrgDiscountResolverWriteFailures`, `bbg.OrgDiscountResolverDegraded`.
- **CloudWatch dashboards**: `bbg/Operations` aggregates the meter pipeline, enforcement, pricing freshness, and reconciliation widgets.
- **Alarms**: `MeterUnjoined > 0`, `EnforcementErrors > 0`, `EnforcementApplied` rate spike, `EnforcementUnattachable > 0`, `PricingRefreshAge > 36h`, `OrgDiscountResolverDegraded > 0`, `ReconciliationDelta > $1` for ≥3 days.
- **Runbooks**: every alarm and Lambda has a runbook in [`docs/runbooks/`](runbooks/).

## Security

- **Cognito User Pool** with feature plan `Plus` (advanced security `ENFORCED`), strict password policy (12 chars, all classes), passkeys/WebAuthn for first-factor MFA-replacement.
- **API Gateway HTTP API** with Cognito JWT authorizer; admin endpoints gate on `cognito:groups` claim including `Admins`.
- **Custom domain** with wildcard ACM cert in us-east-1 (`*.example.com`). Strict TLS 1.2_2021 minimum on CloudFront.
- **Least-privilege IAM**:
  - Enforcement Lambda: `iam:Attach*Policy` / `iam:Detach*Policy` scoped via `iam:PolicyARN` ArnEquals condition to `arn:aws:iam::<acct>:policy/bbg-deny-*` only.
  - Users Lambda: Cognito Admin actions scoped to the BBG User Pool ARN only.
  - Reports Lambda: Athena + Glue scoped to the BBG WorkGroup + database.
- **KMS-CMK encryption** on every DynamoDB table, Athena results bucket, ledger bucket, and sensitive CloudWatch log groups.
- **S3**: every bucket has Block Public Access ON, Origin Access Control where applicable, server access logs to a dedicated logs bucket.
- **CloudTrail**: dedicated trail with Bedrock data events (advanced event selectors), log-file-validation, KMS encryption.
- **`cdk-nag`**: AwsSolutionsChecks aspect runs on every `cdk synth`. All findings have documented suppressions with `reason:` for security-review audit.
- **Threat-model coverage**: passkeys mitigate phishing/credential-replay; `iam:PolicyARN` condition prevents the enforcement role from being used to escalate privileges; deny policies are blast-radius-bound to their `bbg-deny-` namespace.

## Reliability

- **DynamoDB on-demand + PITR** on every application table.
- **Multi-AZ** implicit for every managed service (DynamoDB, Lambda, S3, CloudFront, API GW, Cognito).
- **DLQs**: every Lambda has an SQS DLQ with 14-day retention. A 5-minute EventBridge schedule drains stuck `PendingMeter` rows.
- **Idempotency** on every meter write (`processedRequestIds` set) and every enforcement attach (`enforcementPolicyArn` set-once via `attribute_not_exists`).
- **At-least-once handling** for EventBridge Scheduler invocations of `period-rollover` (uses set-once idempotency keys).
- **Circuit breakers** around the AWS Pricing API (jittered backoff + Bulk API fallback path).
- **Rollback**: every deploy is a CloudFormation changeset; failed deploys auto-rollback. CDK Pipelines stages can be re-deployed point-in-time from any commit.

## Performance Efficiency

- **ARM64 (Graviton) Lambdas** via `aws-cdk-lib/aws-lambda-nodejs`.
- **DynamoDB Streams** for hot-path propagation (sub-second meter → enforcement).
- **In-memory caches with TTL**: 5-minute IAM-tag cache in identity-cache, in-process Pricing-table cache.
- **API Gateway HTTP API** instead of REST API (lower latency, lower cost).
- **CloudFront** in front of the React app with `CACHING_OPTIMIZED` policy.
- **Esbuild bundling** of every Lambda (NodejsFunction) — smaller bundles help keep cold-start latency low for the API handlers.
- **Cloudscape Design System** UI uses Cloudscape's chart palette for consistent rendering across light/dark modes.

## Cost Optimization

- **DynamoDB on-demand** — no over-provisioning; pay only for actual read/write units.
- **S3 lifecycle**: `LedgerBucket` transitions to IA at 30d, Glacier IR at 180d, expires at 2 years. Athena results bucket expires at 30d.
- **CloudTrail data events** scoped via advanced event selectors to Bedrock-only resource types, with 7d retention on the dedicated trail.
- **Pricing API refresh** runs once per 24h, not per request.
- **Cost-allocation tags** on every CDK construct (`Project=bbg`, `Stage=<dev|prod>`, `CostCenter=bbg`).
- **Reserved concurrency caps** on hot Lambdas to prevent runaway invocations from blowing up costs.
- **CloudWatch self-cost metric** `bbg.MeterCostUSD` so operators see what BBG itself costs to run.

## Sustainability

- **AWS Graviton-based Lambdas** can be more energy-efficient than x86 for comparable workloads.
- **Right-sized memory** per Lambda — default 256 MB for API handlers, 512 MB for stream consumers, 1 GB only where bundling profile or token math demands it.
- **Serverless throughout** — no idle EC2, no over-provisioned RDS clusters.
- **Aggressive log retention** (14 days for application logs, 7 days for CloudTrail, 30 days for Athena results) reduces storage footprint.
- **`loadgen.ts` flag-controlled** with explicit `--rps` and `--duration` to avoid runaway sample workloads.
