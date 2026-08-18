# Changelog

All notable changes to this project are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Going forward, every `feat:`/`fix:` commit that ships a user-visible change should add an `[Unreleased]` bullet.

A sample's public surface is broader than its code: it includes the CDK context keys, the operator-config schema, the DynamoDB item shapes, the metric/alarm names, and the HTTP routes. **MAJOR** = a deployed install cannot take the update without operator action (a renamed/removed `bbg:*` key, a changed DynamoDB key schema, a removed route or metric). **MINOR** = new backwards-compatible capability. **PATCH** = bug fix, docs, or dependency bump with no behaviour change an operator would notice.

## [Unreleased]

## [1.2.0] - 2026-08-18

### Added
- **The OpenAI-compatible Responses and Chat Completions APIs on `bedrock-runtime` are now metered and enforced.** AWS added the OpenAI GPT-5.6 models (Sol, Terra, Luna) to the `bedrock-runtime` endpoint, where inference is a CloudTrail **management** event and Bedrock model invocation logging applies. Verified against live calls: a `Responses` invocation produces an invocation-log record carrying `inputTokenCount`, `outputTokenCount`, `requestId`, and `identity.arn`, plus a CloudTrail event with `eventName: Responses`, `eventCategory: Management` and a matching `requestID`. `Responses` and `ChatCompletions` are now in the EventBridge `eventName` allowlist for the metering stack and for enrolled member accounts. Note these models require a `us.` or `global.` cross-Region inference profile on this endpoint — in-Region inference isn't offered for them — and BBG resolves either profile to the underlying model id for pricing.
- **Identity fallback from the invocation-log record.** When the CloudTrail join misses, the meter now derives the principal from the record's own `identity.arn` instead of parking the row in `PendingMeter` to expire. New `MeterIdentityFromLog` metric makes the fallback visible. The CloudTrail join stays primary because it also yields the SSO user and `sourceIdentity` that per-human enforcement needs.

### Fixed
- **Spend on the Responses API was silently lost.** Because `Responses` wasn't in the `eventName` allowlist, the identity join never happened: the row went to `PendingMeter`, its 1-hour TTL expired, and the spend was never committed — no error, only a `MeterUnjoined` bump. Reproduced end to end before the fix, with the unjoined row observed in the table.
- **Corrected the documented API-surface caveat, which was wrong in three ways.** Coverage follows the **endpoint**, not the model: the README previously said proprietary GPT-5.x spend is "invisible to this sample", which is no longer true on `bedrock-runtime`. It also described Bedrock Runtime inference as a CloudTrail *data* event — it is a **management** event, which is precisely why BBG works. And it understated the permanent gap: some models are `bedrock-mantle`-only (as of 2026-08, xAI Grok 4.3, GPT-5.5, GPT-5.4, and the Claude Mythos family) and cannot be metered by this sample at any configuration.
- **Named the enforcement bypass.** Mantle inference authorizes `bedrock-mantle:CreateInference`, a different IAM service prefix that the `bbg-deny-*` policy's `bedrock:*` actions cannot match — so Mantle is not merely a metering blind spot, a denied principal can still call it. This is now stated in the README rather than implied.
- Corrected a comment in the pricing refresher asserting cross-Region SKUs are "usually higher" than in-Region. That holds for the Anthropic lineup but **not** for OpenAI GPT-5.6, where AWS prices Global *below* in-Region/Geo. SKU precedence is unchanged and still correct; the comment now warns that routing mode must become part of the pricing key if AWS publishes GPT-5.6 SKUs, since `stripCrisPrefix` currently collapses `global.` into the bare model id.

## [1.1.1] - 2026-08-16

### Added
- **Fork-update guidance** — a new [Updating to a new release](README.md#-updating-to-a-new-release) section. Because the pipeline deploys from *your* fork, upstream releases don't reach you automatically; taking one is `git fetch upstream --tags && git merge v<version> && git push origin main`, and the push is what redeploys. No `cdk deploy` is needed, since the pipeline self-mutates. Explains why this normally merges cleanly (your settings live in the `/bbg/operator-config` SSM parameter, which overrides `cdk.json` at synth, so a standard install edits no tracked files), and calls out the two things that do conflict if you edit them: `cdk.json` context values, and hand-edited `version` fields in the workspace `package.json` files — which conflict on every release.

### Fixed
- The quickstart and Setup Step 1 cloned `sample-bedrock-spend-budget-guardrails.git`, which is not the published repo name — corrected to `sample-bedrock-spend-budget-guardrails`. Both now also add the `upstream` remote, so a later update is two commands rather than a hunt for the right URL.
- Prerequisites said only "a GitHub fork of this repo"; it now says why (you control when you take a release) and links the update path.

## [1.1.0] - 2026-08-16

### Added
- **One-command first-time install** — `./scripts/install.sh --github-owner <owner> --email you@example.com` replaces Setup Steps 1–5. It runs preflight checks, bootstraps CDK in **both** required regions, writes `/bbg/operator-config`, creates the GitHub connection, deploys the pipeline, watches it to green, seeds the Cognito admin user, and prints the sign-in URL plus a one-time generated password. Every step detects existing state, so a failure partway through (or stopping at the browser step) just needs the same command again — it resumes rather than starting over. One step still needs a human: a CodeConnections connection is created `PENDING` and there is no API to authorize it, so the script prints and opens the console link and polls until it flips to `AVAILABLE`. Preflight deliberately front-loads the failures that otherwise surface 20+ minutes into a deploy: a fork GitHub can't confirm (the top cause of a Source-stage failure), `--github-owner aws-samples` (a pipeline there can never be triggered by your pushes), missing Bedrock model access (deploys fine, meters nothing), and Node < 20. `--skip-fork-check` covers private forks, which 404 to an anonymous probe.

### Changed
- `scripts/bootstrap.sh` now bootstraps **`us-east-1` as well as the home region**. It only ever did the home region, which set operators up for the confusing `Invalid principal in policy` failure the README warns about — the CloudFront WAF WebACL and any ACM certificate are CloudFront-scoped and can only live in `us-east-1`, so a support stack is created there even for a single-region install. For a full install it now points at `install.sh`.

### Fixed
- **Re-installing a stage over retained resources now explains itself.** BBG gives the spend ledger, audit tables, and log buckets `RETAIN` deletion policies on purpose, so billing history survives a teardown — which means re-deploying the **same** stage collides with the survivors, and CloudFormation surfaces it only as a generic `AWS::EarlyValidation::ResourceExistenceCheck` hook failure. The installer now names the three resource classes involved (S3 buckets, DynamoDB tables, Bedrock invocation log groups) and prints the commands to inspect and clear them, or suggests deploying a different `--stage`.

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

[Unreleased]: https://github.com/aws-samples/sample-bedrock-spend-budget-guardrails/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/aws-samples/sample-bedrock-spend-budget-guardrails/releases/tag/v1.2.0
[1.1.1]: https://github.com/aws-samples/sample-bedrock-spend-budget-guardrails/releases/tag/v1.1.1
[1.1.0]: https://github.com/aws-samples/sample-bedrock-spend-budget-guardrails/releases/tag/v1.1.0
[1.0.0]: https://github.com/aws-samples/sample-bedrock-spend-budget-guardrails/releases/tag/v1.0.0
