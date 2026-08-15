# Changelog

All notable changes to this project are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Going forward, every `feat:`/`fix:` commit that ships a user-visible change should add an `[Unreleased]` bullet.

A sample's public surface is broader than its code: it includes the CDK context keys, the operator-config schema, the DynamoDB item shapes, the metric/alarm names, and the HTTP routes. **MAJOR** = a deployed install cannot take the update without operator action (a renamed/removed `bbg:*` key, a changed DynamoDB key schema, a removed route or metric). **MINOR** = new backwards-compatible capability. **PATCH** = bug fix, docs, or dependency bump with no behaviour change an operator would notice.

## [Unreleased]

## [1.0.0] - 2026-08-15

Initial public release. `1.0.0` rather than `0.x` because the metering → budget → enforcement loop and the multi-account/multi-region topology are complete and have run continuously in a real AWS account; the version signals a stable public surface, not a preview. Published after an AWS Public Content Security Review and a full threat model.

### What's in it

Bedrock Budget Guard meters Amazon Bedrock spend per IAM principal per model in near real time, and enforces budgets by attaching customer-managed IAM Deny policies to the principal that overspent. See the [README](README.md) for the full feature list and [`docs/`](docs/) for per-topic guides and operational runbooks.

- **Near-real-time metering and enforcement** — Bedrock invocation logs to a metered `RunningSpend` row to an attached `bbg-deny-*` policy, p95 under 30 seconds. Works for IAM users, IAM roles, SSO `AWSReservedSSO_*` identities, and Bedrock Agents (single and multi-agent); no SDK shims required.
- **Multi-dimensional pricing** — tokens (input / output / cache read / cache write / embed), images, video seconds, audio seconds, and search units. Each model bills on the dimensions it actually charges for; budgets cap aggregate USD across all of them. Rates are refreshed daily from the AWS Price List.
- **Hierarchical custom pricing discounts** — meter at your negotiated rate rather than list price, with discounts authored at account, OU, or org scope and most-specific-wins precedence.
- **Budget windows, thresholds, and rate limits** — monthly / weekly / daily / 5-hour windows, multi-threshold warn-and-block ladders, an optional default-deny baseline for unbudgeted principals, and RPM/TPM limits that catch a runaway agent loop within a minute instead of after the dollars are spent.
- **Multi-account and Org-wide enrollment** — a point-and-click enrollment page with per-account, per-OU, and whole-org paths via CloudFormation StackSets, plus per-account admin scope claims so one install can serve multiple delegated admins.
- **Operator surfaces** — a dark-mode-first Cloudscape single-page app (spend dashboards, budgets, identities, pricing, Athena-backed reports), a durable ~365-day per-principal activity log, an admin audit log, threshold and enforcement email notifications, and optional CUR 2.0 reconciliation that alarms on drift between the meter and the bill.
- **Deploys as a self-mutating CDK Pipeline** — push to `main` triggers Build → UpdatePipeline → Assets → Dev → Prod, with WAFv2, AWS Config, CloudWatch dashboards and alarms, X-Ray tracing, and a Synthetics canary. Passkey / WebAuthn is the first factor for sign-in; a custom domain is optional.

### Known scope limits

- **Bedrock Runtime only, not Mantle.** BBG meters and enforces the `bedrock-runtime` / `bedrock-agent-runtime` / `bedrock` API surface. Traffic on Bedrock's **Mantle** endpoint (the OpenAI-compatible Responses API) is **not** covered, and this is not a filter that can simply be widened: Mantle has its own CloudTrail `eventSource`, logs inference as a `CreateInference` **data** event, and bypasses model-invocation logging, so token counts never reach the log group the meter reads. Practical effect: open-weight `openai.gpt-oss-*` models are fully metered; proprietary GPT-5.x served over Mantle is not. See [API-surface coverage](README.md#api-surface-coverage--bedrock-runtime-only-not-mantle).
- **Two models are intentionally unpriced.** `amazon.nova-reel-v1:0` and `v1:1` bill per generated video, a unit the meter has no counter for. Every other live model in the metered regions resolves a rate; a non-zero `PricingGapCount` means a name-join bug, not AWS lagging.
- **CUR reconciliation is opt-in** and requires you to activate the `iamPrincipal` cost-allocation tag. It is not needed for metering or enforcement.
- **Principals BBG cannot attribute to an identity are alert-only.** `GetFederationToken` users and `principal#unknown` callers are surfaced through the `EnforcementUnattachable` alarm rather than denied.

[Unreleased]: https://github.com/aws-samples/sample-bedrock-spend-budget-guardrails/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/aws-samples/sample-bedrock-spend-budget-guardrails/releases/tag/v1.0.0
