# Budget controls for Amazon Bedrock spend — a sample

> A sample showing how to meter Amazon Bedrock spend per IAM principal and put automated
> guardrails on it — in near real time, rather than waiting on billing data.

> [!IMPORTANT]
> This is sample code, for non-production usage. You should work with your security and legal
> teams to meet your organizational security, regulatory and compliance requirements before
> deployment.

This sample detects in **seconds** — not the 8–24 hours that CUR-based controls take — when an IAM user, role, SSO-federated user, EC2/Lambda role, or Bedrock Agent service role exceeds a configured spend budget on a specific foundation model or inference profile. It then attaches a customer-managed `Deny` IAM policy to that principal, and auto-detaches it at the start of the next budget period.

It demonstrates a full pattern end to end: metering across every pricing dimension a model charges on, per-principal IAM-based guardrails, a Cloudscape web UI with passkey MFA, multi-region and multi-account (Org) enrollment, observability, an AWS Config recorder, WAFv2 on the CloudFront distribution, and a CUR 2.0 reconciler that cross-checks the meter against AWS's billing data. Treat it as a reference to learn from and adapt — not a managed service.

---

## ✨ Features

- ⚡ **Sub-30-second enforcement** — `InvokeModel` to `bbg-deny-*` policy attached, p95.
- 🎯 **Scope: Bedrock Runtime** — meters and enforces the `bedrock-runtime` / `bedrock-agent-runtime` API surface. Traffic on Bedrock's **Mantle** endpoint (the OpenAI-compatible Responses API) is **not** covered — see [API-surface coverage](#api-surface-coverage--bedrock-runtime-only-not-mantle).
- 💰 **Multi-dimensional pricing** — meters tokens (input / output / cache read / cache write / embed), images, video seconds, audio seconds, and search units. Each model bills on whichever dimensions it actually charges for; budgets cap aggregate USD across all of them.
- 🏷️ **Hierarchical custom pricing discounts** — meter at your negotiated rate, not list price. Author a discount % at **account**, **OU**, or **org** scope; most-specific wins (account > nearest OU, deepest-first > org root > org-wide), single winner, no stacking. An hourly + on-write `org-discount-resolver` walks AWS Organizations and materializes the winning **effective rate** onto each account's row, so the meter's hot path stays one cached read. An account set to **0%** is an explicit list-price exclusion that overrides any discount it would otherwise inherit.
- 🛡️ **Per-principal IAM denies** — works for IAM users, IAM roles, SSO `AWSReservedSSO_*`, and Bedrock Agents (single + multi-agent). Per-human denies under a shared federation/SSO role attach to the issuer role scoped to the one identity (`aws:userid` / `aws:SourceIdentity`). Callers BBG can't attribute to an identity (`principal#unknown`, GetFederationToken users) are alert-only and surfaced via the `EnforcementUnattachable` alarm. No SDK shims; the gateway is optional (only needed for session-tag-keyed budgets).
- 🌍 **Multi-region metering** — Bedrock invocations land in any of `us-west-2`, `us-east-1`, `us-east-2` (configurable). Cross-region forwarder ships events to the home-region default event bus; spend rendered with per-region attribution on the dashboard.
- 🏢 **Multi-account / Org-wide enrollment** — point-and-click `/admin/enroll` page with four enrollment paths: per-account toggles (auto-routed in-Org → SERVICE_MANAGED INTERSECTION StackSet without per-member bootstrap; external → SELF_MANAGED with one-time bootstrap CFN), per-OU toggles (SERVICE_MANAGED + AutoDeployment so accounts joining an enrolled OU auto-enroll within ~10 min), and a top-of-page **whole-org Toggle** (SERVICE_MANAGED with `accountFilterType=DIFFERENCE` excluding home + extras; one click enrolls every Org account, including future ones). Whole-org takes precedence at synth — the per-OU and per-account selections stay in SSM and reactivate when whole-org is turned off.
- 🔑 **Per-account scope claims** — Cognito `bbg:scope` claim emitted by a pre-token-generation Lambda lets a single web-app install support multiple delegated admins, each scoped to specific accounts. Super-admins (`scope=["*"]`) see aggregated spend across the Org with per-account drill-down.
- 📋 **Admin audit log** — every cross-account admin write (budget create/update, enrollment changes, manifest apply, user management) emits a structured audit log line + a `CrossAccountWriteAudit` CloudWatch metric. Searchable in the web app's **Admin audit** page (`/admin/audit`) via CloudWatch Logs Insights. Complemented by — not replaced by — the activity log below: 14-day CloudWatch "who changed what" vs. 365-day durable "what happened to this principal".
- 🧾 **Per-principal activity log** — a durable ~365-day `PrincipalActivity` timeline per caller: threshold warnings, enforcement applied / released / rolled-over, budget and user changes, unenforceable budgets, and notification failures. Written by 6 Lambdas. Three surfaces: a per-principal modal from **Identities**, a self-service **My activity** page, and a super-admin central **Activity** feed backed by a `byDay` GSI.
- 📧 **Per-identity + ops-fallback budget emails** — threshold and enforcement emails route to the person, not just the admin: SSO / identity-lens rows (`principal#sso-user#<email>`) email the SSO user's own address, and `bbg:notifyOpsFallbackAddress` catches principals that map to no human (service roles, unmapped IAM users) so they're never silent.
- 📊 **CUR 2.0 reconciliation** (opt-in) — when you activate the `iamPrincipal` cost-allocation tag, a daily Athena query against the IAM-principal-allocated CUR cross-checks the meter and alarms on drift > $1 or 5%. Not required for near real-time metering or enforcement.
- 🌙 **Cloudscape web app** — dark-mode-first React + Vite (single-page app) with sortable / filterable Pricing, Inference Profiles, Identities, Budgets, Reports (Athena), Enrollment, Audit log, and Spend pages. Trend charts, top-spender bars, per-model dimension breakdowns, per-region and per-account spend charts.
- 🔐 **Passkey / WebAuthn first-factor sign-in** — no TOTP, no SMS. Cognito User Pool with Plus feature plan + per-credential nicknames you can rename. Yubikey + platform passkey both supported.
- 🚀 **GitOps via CDK Pipelines** — push to `main` triggers CodePipeline → Build → UpdatePipeline → Assets → Dev → Prod. Self-mutating; auto-promote with optional `bbg:requireProdApproval` gate.
- 🌐 **Custom domain + WAFv2** — Route53 + ACM wildcard cert; WAFv2 on prod CloudFront with managed rule sets (CommonRuleSet, KnownBadInputs, IpReputationList, RateLimit).
- 🔍 **Observability** — CloudWatch dashboards, alarms wired to SNS, X-Ray tracing on every Lambda, Powertools structured logging, Synthetics canary every 30 min.
- 🏛️ **AWS Config recorder + curated managed rules** for the Well-Architected Security pillar (S3 public-access prohibited, IAM policy admin checks, CloudTrail enabled / encrypted / log-file-validated, DDB PITR, Cognito MFA, etc.).

## 🏗️ Architecture

![BBG architecture](docs/architecture.png)

Full diagram + the real-time-loop logical flow in [`docs/architecture.md`](docs/architecture.md). Three signals fan into one decision pipeline:

```
Bedrock Model Invocation Logging  ─┐
   /aws/bedrock/...-invocations    │
                                   ├─→ requestId join in DynamoDB
CloudTrail Bedrock data events ────┤   ↓
   → EventBridge → identity-cache  │   meter Lambda computes spend across
                                   │   every dimension the model bills on
Pricing API (daily refresh)  ──────┤   then spend × (1 − effective discount)
                                   │   ↓
Custom pricing discounts  ─────────┘   RunningSpend write
   account / OU / org scope            ↓ (DDB stream)
                                       enforcement Lambda
                                       ↓
                                       iam:AttachUser/RolePolicy bbg-deny-*
```

An hourly `org-discount-resolver` walks AWS Organizations and materializes each account's effective negotiated rate ahead of time, keeping precedence resolution off the hot path — the meter still does one cached read.

Periodic period-rollover detaches the deny + clears spend on the first of each month.

An **opt-in** CUR 2.0 IAM-principal allocation layer can run in parallel as a **second source of truth** (requires activating the `iamPrincipal` cost-allocation tag). The meter stops the bleed with zero cost-tracking setup; CUR, when enabled, closes the books.

## 📸 Screenshots

Captured from a live BBG deployment via [`scripts/screenshots.ts`](scripts/screenshots.ts) (Playwright, dark mode, retina). Account ID, emails, and phone number masked via DOM substitution before capture.

### 1 · See your Bedrock spend

The Spend Dashboard is the admin landing page: total spend for the period, distinct principals + models seen, top spenders, and a per-target row table with input/output token counts. Identities lists every caller CloudTrail has ever seen calling Bedrock — useful for finding who needs a budget. The Pricing page shows the current per-model unit rates BBG uses to compute spend, with multi-dimensional badges (input / output / cache-read / cache-write / images / etc.). Inference profiles surfaces every CRIS profile in the account so admins can budget against profile ARNs the same way they budget against models.

| | |
|---|---|
| **Spend Dashboard** — KPIs, monthly trend, top spenders, per-model dimension breakdown, per-row table | [![Spend dashboard](docs/screenshots/spend-dashboard.png)](docs/screenshots/spend-dashboard.png) |
| **Identities** — every IAM principal observed by CloudTrail invoking Bedrock (users, roles, agents, SSO) | [![Identities](docs/screenshots/identities.png)](docs/screenshots/identities.png) |
| **Pricing** — per-model rates with multi-dim badges + manual override path for new / unmapped models | [![Pricing](docs/screenshots/pricing-overrides.png)](docs/screenshots/pricing-overrides.png) |
| **Inference profiles** — system-defined cross-region profiles with their target models + regions | [![Inference profiles](docs/screenshots/inference-profiles.png)](docs/screenshots/inference-profiles.png) |

### 2 · Enforce a budget

Set a per-principal × per-target limit with `action=deny` and BBG attaches a customer-managed `bbg-deny-*` IAM policy in seconds when spend crosses it. `action=alert` skips the deny and just emails (great for staging). Below: one IAM role hit its $0.10 deny limit on Claude Opus 4.7 and is now blocked; one IAM user blew past its $0.10 alert-only limit on the same model and is over but un-denied. The enforced caller's view of their own spend shows a red "Budget exceeded" banner — the same number the admin sees, scoped via Cognito's `custom:iam_principal` mapping.

| | |
|---|---|
| **Admin → Budgets** — yellow "Enforcement is active" Flashbar; deny + alert rows with status indicators | [![Admin budgets](docs/screenshots/admin-budgets.png)](docs/screenshots/admin-budgets.png) |
| **My Spend** (alert-only user) — red "Budget exceeded" alert; headroom $0.0000; per-target table | [![My spend (alert active)](docs/screenshots/my-spend-alert-active.png)](docs/screenshots/my-spend-alert-active.png) |

### 3 · Investigate, attribute, govern

Reports runs Cloudscape `CodeEditor`-rendered Athena queries against the long-term Parquet ledger for ad-hoc analysis (top 10 of the month, rolling 90-day spend by team, etc.). Agent sessions surfaces multi-agent supervisor → collaborator chains so admins can see when a single user prompt fanned into N model calls. Admin → Users is the Cognito admin surface — invite a new user, change groups, override notification preferences, force a password reset. My Profile is what every BBG user manages themselves: passkey enrollment, the IAM principal their `/me/spend` view is keyed to, and a row of toggles for which budget events trigger emails.

| | |
|---|---|
| **Reports** — Athena-powered ad-hoc queries (`CodeEditor` SQL + results table) | [![Reports](docs/screenshots/reports.png)](docs/screenshots/reports.png) |
| **Agent sessions** — multi-agent supervisor → collaborator chains keyed by `agentSessionId` | [![Agent sessions](docs/screenshots/agent-sessions.png)](docs/screenshots/agent-sessions.png) |
| **Admin → Users** — Cognito users, group membership, IAM principal mapping, per-user notification overrides | [![Admin users](docs/screenshots/admin-users.png)](docs/screenshots/admin-users.png) |
| **Create user** — auto-generate Cognito-policy-compliant temp password (or supply your own) + send invitation email + group membership | [![Create user](docs/screenshots/admin-users-create.png)](docs/screenshots/admin-users-create.png) |
| **My Profile** — passkey + YubiKey enrollment, IAM principal mapping, notification preferences | [![My profile](docs/screenshots/my-profile.png)](docs/screenshots/my-profile.png) |

## 🆔 Identity coverage

| Caller | Canonical principal key | Enforcement |
|---|---|---|
| IAM user | `principal#arn:aws:iam::ACCT:user/alice` | `AttachUserPolicy bbg-deny-*` |
| IAM role / EC2 role / Lambda role | `principal#arn:aws:iam::ACCT:role/RoleName` | `AttachRolePolicy bbg-deny-*` |
| IAM Identity Center (SSO) | Both the `AWSReservedSSO_*` role AND `principal#sso-user#<email>` | `AttachRolePolicy` on the SSO role |
| Federated SAML / OIDC | `principal#sso-user#<email>` / `principal#sourceIdentity#<value>` (or `sessionTag/<sub>` via the gateway) | Deny attached to the issuer role, scoped to the one identity via `aws:userid` / `aws:SourceIdentity` |
| Bedrock Agent (single) | `principal#agent-role#<roleArn>` | Deny on the agent's service role |
| Bedrock Agent (multi-agent collaboration) | Per-collaborator role + per-`agentSessionId` rollup | Deny on supervisor or specific collaborator |

For teams that want finer per-end-user attribution through Bedrock Agents (CloudTrail otherwise records the agent's service role, not the human), an **opt-in gateway** stack provides a `sts:AssumeRole`-with-transitive-tags + `sts:SetSourceIdentity` proxy. Disabled by default; the meter works without it.

Full caller-type matrix with sample CloudTrail JSON: [`docs/identity-coverage.md`](docs/identity-coverage.md).

### What about API keys?

Common question — especially in higher-ed where students each get their own API key for coursework and leaks happen. BBG does not have a separate "API key" object because **AWS doesn't expose Bedrock as an API-key API**; every Bedrock invocation is signed by an IAM principal under the hood, and that's what BBG meters and blocks.

- **Long-term IAM access keys** (`AKIA...`) belong to a specific IAM user. CloudTrail records the user as the `userIdentity`. BBG attaches the deny policy to that user; every key on that user is blocked at once.
- **Short-term/STS credentials** (`ASIA...`) — what `aws sts assume-role`, EC2 instance roles, Lambda execution roles, and IAM Identity Center all hand out — inherit the *source* IAM principal in CloudTrail's `userIdentity`. BBG canonicalizes the assumed-role ARN to its base role and meters/enforces against the role itself. So even if a leaked key is being used to mint many short-lived STS tokens, blocking the source role stops all of them.
- **Bedrock client SDKs that take an API key string** (e.g., a developer wraps an STS token as a "key" for a notebook) still surface as the underlying STS principal in CloudTrail. Same outcome.

If you have a use case where many users share a single IAM principal (e.g., a class roster all minting STS via a single shared role), BBG today blocks them as a group — the existing primitive is "block the principal." Per-end-user attribution within a shared principal is what the optional gateway stack adds (see "Identity coverage" above): it injects a session-tag identity claim that the meter and enforcement Lambdas honor, so you can budget and block individual students under one shared role.

### Action coverage

When a budget is breached, the `bbg-deny-*` policy denies every billable Bedrock API for the targeted principal × resource. Verified action list:

| Surface | Actions |
|---|---|
| Foundation models | `bedrock:InvokeModel`, `bedrock:InvokeModelWithResponseStream`, `bedrock:Converse`, `bedrock:ConverseStream` |
| Inference profiles | `bedrock:GetInferenceProfile` (plus the foundation-model actions above against the profile ARN) |
| Knowledge Bases | `bedrock:Retrieve`, `bedrock:RetrieveAndGenerate`, `bedrock:RetrieveAndGenerateStream` |
| Bedrock Agents | `bedrock-agent-runtime:InvokeAgent` |
| Guardrails | `bedrock:ApplyGuardrail` (denied across all guardrail ARNs in a separate `DenyBedrockGuardrails` Statement so a denied principal cannot bypass enforcement via standalone Guardrail calls) |

Cache-read and cache-write tokens are metered as separate dimensions (`cacheReadPer1k` and `cacheWritePer1k` in the pricing table) and contribute to `spendUsd` independently — Anthropic's published cache-write/cache-read ratio (~12.5× at the 5-min cache tier) is preserved end-to-end and covered by [`lambda/test/meter-cache.test.ts`](lambda/test/meter-cache.test.ts).

### API-surface coverage — Bedrock **Runtime** only (not Mantle)

> **Scope limitation.** This sample meters and enforces on the **Bedrock Runtime** API surface only. Traffic sent to Bedrock's newer **Mantle** endpoint (`bedrock-mantle.<region>.api.aws`, the OpenAI-compatible Responses API surface) is **not metered and not enforced** today.

| Surface | Metered & enforced? | Notes |
|---|---|---|
| `bedrock-runtime` — `InvokeModel`, `InvokeModelWithResponseStream`, `Converse`, `ConverseStream` | ✅ Yes | The primary path. Includes cross-region inference profiles. |
| `bedrock-agent-runtime` — `InvokeAgent`, `Retrieve`, `RetrieveAndGenerate` | ✅ Yes | |
| `bedrock` — `ApplyGuardrail`, `InvokeFlow`, `InvokeInlineAgent` | ✅ Yes | |
| **`bedrock-mantle`** — `CreateInference` (Responses API) | ❌ **No** | Out of scope for this sample — see below. |

Why: BBG joins spend to an IAM principal from **management-event** API calls that Bedrock Runtime publishes to the default EventBridge bus, matched by the `<stage>-bbg-bedrock-runtime-<region>` rule on `source: ["aws.bedrock-runtime", "aws.bedrock", "aws.bedrock-agent-runtime"]` ([`infra/lib/metering-stack.ts`](infra/lib/metering-stack.ts)). Mantle is a distinct API surface: it has its own CloudTrail `eventSource` (`bedrock-mantle.amazonaws.com`) and logs inference as `CreateInference`, which is a **data event** (off by default, billed separately) rather than a management event. Direct Mantle calls also bypass Bedrock's model-invocation logging, so the token counts BBG prices against never reach the log group the meter reads. Covering Mantle therefore needs more than widening the event filter — it needs a data-event trail plus a different usage-extraction path, so it is deliberately left out of this sample.

Practical impact on model choice:

- **Open-weight OpenAI models** (`openai.gpt-oss-*`, including the safeguard variants) are served over the standard Runtime path — fully metered, priced, and enforced.
- **Proprietary OpenAI frontier models** (GPT-5.x) are served on Mantle, so their spend is **invisible to this sample**. They are also absent from the AWS Price List API/bulk offer files that the pricing refresher reads, so they carry no priced row either (see [`docs/pricing-nuances.md`](docs/pricing-nuances.md)).

If your account uses Mantle-served models, treat this sample's totals as covering the Runtime surface only, and use AWS Cost Explorer or CUR for whole-account Bedrock spend.

## 🛠️ Setup

There are two paths:

- **Path A — Service Catalog launch** (one click per account once a central admin has imported BBG into your Org's Service Catalog). Run order: read [`docs/service-catalog.md`](docs/service-catalog.md), then come back to Step 4 below for `cdk deploy PipelineStack`.
- **Path B — Direct clone + CDK** (described below). The path you'd take if you're the central admin packaging BBG for everyone else, or if you're evaluating BBG in a single account.

Either way, the application that gets deployed is identical — the only difference is whether `/bbg/operator-config` was written by hand or by the SC bootstrap product.

### Prerequisites

- AWS account with admin credentials (the deployer needs CDK bootstrap permissions; deploy runs as your usual CLI session — no `AWS_PROFILE` overrides).
- Bedrock model access in your target region (request via Bedrock console → Model access; the demo uses Claude Sonnet 4.6 + Haiku 4.5).
- *(Optional)* A Route53 hosted zone you own, if you want a custom domain — BBG then serves at `sample-bedrock-spend-budget-guardrails-{dev,prod}.<your-domain>`. Without one, it works out of the box on the CloudFront `*.cloudfront.net` URL (sign-in uses the Cloudscape-native SRP/passkey flow, not the Cognito hosted-UI redirect, so no callback domain is needed).
- Node.js 20+, npm 10+, Git.
- A GitHub fork of this repo (for the GitOps pipeline).

> **No cost-allocation setup required.** BBG meters and enforces entirely off **CloudTrail Bedrock data events + Bedrock model-invocation logging**, joined on `requestId`. It does **not** depend on AWS *IAM Principal Cost Tracking*, activated cost-allocation tags, or any consistent tagging taxonomy — the core real-time loop works on a stock account out of the box. (Cost-allocation tags matter only for the **opt-in** secondary reconciliation layers — CUR 2.0 and AWS Budgets Actions — which BBG uses as a books-closing cross-check, never as the primary shutoff. Principal tags that *are* present get surfaced on the Identities directory for convenience, but no metering or enforcement decision reads them.)

#### Optional: multi-account / Org-wide enrollment

If you plan to use the web app's enroll-accounts wizard to monitor multiple AWS accounts in your Organization (vs. running BBG per-account), the deploy account must be the **Organizations management account** (or a delegated CloudFormation StackSets administrator). Run these once, in the management account, before `cdk deploy PipelineStack`:

```bash
# Activate CloudFormation organizations-access (lets the home account
# target OUs in StackSet operations).
aws cloudformation activate-organizations-access

# Enable StackSets trusted access (lets SERVICE_MANAGED StackSets
# auto-provision the AWSCloudFormationStackSetExecutionRole in member
# accounts — eliminates the per-member bootstrap CFN that
# SELF_MANAGED would otherwise require).
aws organizations enable-aws-service-access \
  --service-principal=member.org.stacksets.cloudformation.amazonaws.com
```

The web app's `/admin/enroll` page runs a preflight check on load and surfaces actionable banners with copy-paste fix commands when either of these is missing. Single-account installs and external-account enrollments work without these prereqs (external accounts use a SELF_MANAGED StackSet that does require a one-time per-member bootstrap CFN; see [`docs/multi-account-multi-region.md`](docs/multi-account-multi-region.md) § 6.2.1).

### Step 1 — Clone + install

```bash
git clone git@github.com:<your-fork>/sample-bedrock-spend-budget-guardrails.git ~/git/sample-bedrock-spend-budget-guardrails
cd ~/git/sample-bedrock-spend-budget-guardrails
nvm use && npm ci
```

### Step 2 — Configure operator-specific values

BBG stores account-specific values (GitHub fork owner, metered regions, alert email, and — optionally — Cognito domain prefixes, Route53 zone, custom domain names) in a **single SSM String parameter** so the public repo never carries account IDs. Anything in SSM overrides the same key in `cdk.json` (whose committed default is home-region-only). Full schema is in [`docs/operator-config.md`](docs/operator-config.md); [`cdk.context.example.json`](cdk.context.example.json) is the minimal set that works when copied verbatim.

The minimum to deploy (no custom domain — serves on the CloudFront URL):

```bash
aws sts get-caller-identity   # confirm you're in the right account

aws ssm put-parameter \
  --name /bbg/operator-config \
  --type String \
  --value "$(cat cdk.context.example.json)" \
  --region us-west-2
# → edit bbg:githubOwner first, or pass your own JSON inline.
```

To add a custom domain, SES email, CUR reconciliation, multi-region metering, etc., add the corresponding keys from [`docs/operator-config.md`](docs/operator-config.md) (e.g. `bbg:hostedZoneName` + `bbg:hostedZoneId` + `bbg:domainNames`, `bbg:meteredRegions`).

### Step 3 — Establish the GitHub CodeStar connection

```bash
aws codeconnections create-connection \
  --provider-type GitHub \
  --connection-name bbg-github \
  --region us-west-2
# Approve at: https://console.aws.amazon.com/codesuite/settings/connections
# Then store the ARN where the pipeline expects it:
aws ssm put-parameter \
  --name /bbg/github-connection-arn \
  --value <arn> \
  --type String \
  --region us-west-2
```

### Step 4 — Bootstrap CDK + deploy the pipeline

**Bootstrap every region BBG will create a stack in — not just your home region.** BBG is a CDK Pipelines app, so any stack it deploys to a non-home region makes the pipeline stand up a cross-region *support* stack (an S3 replication bucket + KMS key) in that region. Those support stacks are created **from your laptop during `cdk deploy PipelineStack`, before the pipeline ever runs**, and their bucket policy references that region's CDK bootstrap role by ARN — so if the region isn't bootstrapped you get a confusing `Invalid principal in policy` failure (and, because the replication bucket is `RETAIN`, a leftover bucket that then fails the retry with `already exists`).

The regions you must bootstrap:

- **Your home region** (the first entry in `bbg:meteredRegions`, default `us-west-2`).
- **`us-east-1`** — always required. The CloudFront **WAF WebACL** (prod) and, if you use a custom domain, the **ACM certificate** are CloudFront-scoped and must live in `us-east-1`, so a `us-east-1` support stack is always created even for a single-region deploy.
- **Every additional region in `bbg:meteredRegions`** (none by default — the committed default is home-only).

```bash
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)

# Home region + us-east-1 (WAF/cert) — the minimum for the default home-only config.
npx cdk bootstrap aws://$ACCOUNT/us-west-2 aws://$ACCOUNT/us-east-1

# If you set bbg:meteredRegions to more than the home region, bootstrap each
# of those too, e.g.:
#   npx cdk bootstrap aws://$ACCOUNT/us-east-2 aws://$ACCOUNT/eu-west-1

npx cdk deploy PipelineStack
```

> Already tried to deploy and hit `Invalid principal in policy` or `Bucket ... already exists` on a `PipelineStack-support-<region>` stack? Bootstrap that region (above), then delete the retained replication bucket CloudFormation left behind (`aws s3 rb s3://<pipelinestack-support-...-replicationbucket...> --force`) and re-run `cdk deploy PipelineStack`.

That's it. From now on, every push to `main` triggers a full `Build → UpdatePipeline → Assets → Dev → Prod` deploy. First run takes ~25 minutes; subsequent runs ~10–15.

Watch progress at AWS Console → CodePipeline → `bbg-pipeline`.

### Step 5 — Seed Cognito + sign in

The seed script reads the admin and non-admin user emails from environment variables — nothing is hardcoded in the repo. Set the temp password in your shell only:

```bash
export BBG_ADMIN_EMAIL=ops@example.com
export BBG_USER_EMAIL=ops+bbg-test@example.com
export BBG_TEMP_PASSWORD='<choose a strong temp password>'

BBG_STAGE_PREFIX=dev  npm run -w @bbg/lambda seed:cognito
BBG_STAGE_PREFIX=prod npm run -w @bbg/lambda seed:cognito
```

Sign in at `https://sample-bedrock-spend-budget-guardrails-{dev,prod}.<your-domain>` (or the CloudFront `*.cloudfront.net` URL if you skipped the custom domain). First sign-in prompts you to set a permanent password. On the **My profile** page, optionally enroll a passkey or YubiKey for password-free future sign-ins.

### 🚀 Quick deploy without a custom domain (what to expect)

BBG deploys and runs fully without a Route53 domain — it serves from the CloudFront `*.cloudfront.net` URL. Everything works, with a couple of things to know:

- **Sign-in + passkey both work.** The SPA uses the Cloudscape-native SRP + passkey flow (not the Cognito hosted-UI redirect), so no OAuth callback domain is needed. WebAuthn/passkey is enabled automatically against the CloudFront hostname as the relying-party ID (a custom resource in the web stack sets it up, since `cloudfront.net` is a public suffix and the RP ID must be the full distribution host).
- **WAF, Config, metering, dashboards, the API, and the synthetic canary** all deploy and run against the CloudFront URL.
- **Email deep links are omitted.** Budget-threshold / enforcement emails still send (if you set `bbg:notifySenderAddress`), but without a stable app URL they don't include a "View details" link. Set a custom domain to get deep links.
- **You still must bootstrap `us-east-1`** (Step 4) — the CloudFront WAF lives there regardless of domain.

Add a custom domain later by setting `bbg:hostedZoneName` + `bbg:hostedZoneId` + `bbg:domainNames` in operator-config and redeploying.

### 💻 Local development (skip the pipeline)

```bash
BBG_LOCAL=1 npx cdk deploy --hotswap-fallback "DevAppStage/*" --require-approval never
npm run -w @bbg/web dump-config && npm run -w @bbg/web dev   # http://localhost:5173
```

`BBG_LOCAL=1` instantiates an `AppStage` directly (skipping `PipelineStack`) so you get hotswap-fast Lambda iteration. The web `dump-config` step pulls CFN outputs into `web/.env.local` so the Vite dev server points at your live AWS resources.

## 🚦 Generating traffic

```bash
# Loadgen invokes Bedrock with your CURRENT AWS credentials. Whatever role
# you're assumed as is what the meter records — no .demo-credentials.json,
# no AWS_PROFILE override. Spend lights up your Spend dashboard within ~30s.
npm run -w @bbg/lambda loadgen -- \
  --model us.anthropic.claude-haiku-4-5-20251001-v1:0 \
  --rps 5 --duration 60s
```

Full end-to-end demo runbook (set a budget → invoke → watch enforcement fire → release): [`docs/demo.md`](docs/demo.md).

## 📁 Project structure

```
sample-bedrock-spend-budget-guardrails/
├── infra/                            # @bbg/infra (CDK stacks)
│   ├── bin/app.ts                    # entry; loads operator config from SSM
│   └── lib/
│       ├── stages/app-stage.ts       # composes the full app
│       ├── network-and-auth-stack.ts # Cognito + WebAuthn config
│       ├── data-stack.ts             # DDB tables, S3 buckets, Glue, Athena
│       ├── pricing-stack.ts          # Pricing API refresher + gap handler
│       ├── metering-stack.ts         # Bedrock log subscription, default-bus API-call rule, meter
│       ├── enforcement-stack.ts      # DDB-stream-driven enforcement + scheduler
│       ├── api-stack.ts              # HTTP API + JWT authorizer + handlers
│       ├── web-stack.ts              # S3 + CloudFront + WAF + auto-generated config.json
│       ├── observability-stack.ts    # dashboards, alarms, Synthetics canary, SNS
│       ├── cur-stack.ts              # CUR 2.0 + reconciler
│       ├── config-stack.ts           # AWS Config recorder + 19 managed rules
│       ├── waf-stack.ts              # WAFv2 (us-east-1, scope=CLOUDFRONT)
│       ├── cert-stack.ts             # us-east-1 wildcard ACM cert
│       ├── member-stackset-stack.ts  # cross-account StackSet — IAM roles + ingest forwarder shipped to enrolled members
│       ├── gateway-stack.ts          # opt-in attribution proxy (default off)
│       ├── multi-agent-stack.ts      # opt-in supervisor + collaborators reference
│       └── pipeline-stack.ts         # CDK Pipelines + CodeStar connection
├── lambda/                           # @bbg/lambda
│   └── src/
│       ├── meter/                    # CWL → DDB join, multi-dim cost compute
│       ├── identity-cache/           # CloudTrail userIdentity canonicalization
│       ├── enforcement/              # DDB stream → bbg-deny-* attach (cross-account aware)
│       ├── period-rollover/          # detach + reset on the 1st of the month
│       ├── ledger-writer/            # DDB stream → JSONL → Athena
│       ├── pricing-refresher/        # AWS Pricing API → Pricing table
│       ├── org-discount-resolver/    # hourly + on-write Org walk → effective discount per account
│       ├── inference-profile-refresher/
│       ├── cur-reconciler/           # daily Athena vs meter compare
│       ├── budgets-action-sync/      # opt-in mirror to native AWS Budgets + Budget Actions
│       ├── cwl-forwarder/            # non-home metered region → home event bus
│       ├── notify/                   # SES emails on threshold + enforcement events
│       ├── pre-token-gen/            # Cognito V2 trigger emits bbg:scope claim
│       ├── api/                      # one handler per endpoint group
│       │   ├── enrollment/           # /admin/org/accounts, /admin/enrollment/* (preflight, config, status)
│       │   ├── audit/                # /admin/audit (CloudWatch Logs Insights)
│       │   ├── budgets/, spend/, identities/, users/, ...
│       │   └── ...
│       └── shared/                   # arn, pricing, ddb, api, audit, iam-cross-account helpers
├── web/                              # @bbg/web (React + Vite + Cloudscape)
│   └── src/
│       ├── pages/                    # AdminBudgets, AdminUsers, SpendDashboard,
│       │                             # Reports, InferenceProfiles, AgentSessions,
│       │                             # PricingOverrides, PricingDiscounts, Profile,
│       │                             # MyBudget, MyActivity, Identities, Readiness,
│       │                             # Enrollment (Org-tree wizard), AuditLog,
│       │                             # AdminActivity, Docs
│       ├── components/               # ModelCell, PrincipalCell, canonicalArn, ...
│       └── auth/                     # Cognito + WebAuthn integration; scope-context provider
├── service-catalog/                  # CFN templates: portfolio + per-account bootstrap product
├── scripts/                          # seed-cognito, loadgen, dump-config, force-rollover, watch-pipeline
├── docs/                             # architecture, identity coverage, runbooks
└── cdk.json                          # operator-config schema in docs/operator-config.md
```

## 🧱 Technology stack

### Infrastructure
- **AWS CDK v2** (TypeScript), npm workspaces (`infra`, `lambda`, `web`)
- **CDK Pipelines** + **CodeStar Connections** for GitOps
- **cdk-nag** AwsSolutions checks gating CI

### Compute / data
- **DynamoDB** hot path: `Budgets`, `RunningSpend`, `IdentityCache`, `Pricing`, `InferenceProfiles`, `PendingMeter`, `AgentSessions`, `PrincipalsSeen`, `PrincipalActivity`, `RateCounters`, `PasskeyNicknames`. On-demand, PITR, KMS-CMK.
- **Lambda** (Node 20, ARM64, Powertools): meter, identity-cache, enforcement, ledger-writer, pricing-refresher, org-discount-resolver, inference-profile-refresher, cur-reconciler, period-rollover, notify, cwl-forwarder, pre-token-gen, budgets-action-sync, plus per-route API handlers.
- **S3 + Glue + Athena** ledger for ad-hoc reporting; JSONL with partition projection.
- **EventBridge Scheduler** for the monthly period rollover, the daily pricing refresh, and the hourly org-discount resolve.

### Networking + auth
- **Cognito User Pool** with Plus feature plan, WebAuthn (passkey/YubiKey), `USER_AUTH` flow.
- **API Gateway HTTP API** with `HttpJwtAuthorizer`.
- **CloudFront** with custom domain (Route53 + ACM wildcard cert), WAFv2 on prod (CommonRuleSet + KnownBadInputs + IpReputationList + 2k/5min rate limit).
- **CloudTrail** — identity (`userIdentity` + `requestId`) arrives as Bedrock **management-event API calls** (`InvokeModel`, `Converse`, `InvokeAgent`, …) on the account's default EventBridge bus. A trail logging management events is required for that delivery (CloudTrail's free 90-day Event history alone doesn't reach EventBridge), so BBG creates a minimal multi-region management-events trail by default — opt out with `bbg:createManagementEventsTrail: false` if your account/Org already has one (Control Tower, org trail).

### Frontend
- **React 18** + **TypeScript** + **Vite**.
- **Cloudscape Design System** (`@cloudscape-design/components`, `@cloudscape-design/global-styles`).
- **AWS Amplify Auth v6** for Cognito + WebAuthn.
- Code-split per-route bundle: index ~19 KB, route chunks 1–10 KB each, Cloudscape ~940 KB cached separately.

### Observability + security
- **CloudWatch dashboards** + per-alarm SNS topics.
- **CloudWatch Synthetics canary** hitting the live custom domain every 30 min.
- **AWS Config recorder** + 19 managed rules (Well-Architected Security pillar).
- **X-Ray** tracing on every Lambda.
- **Powertools** structured logging.

## 💵 Cost to run

BBG is **almost entirely serverless** — Lambda + DynamoDB on-demand + S3 + CloudFront + CloudTrail + Cognito. No idle EC2/ECS/RDS bills.

A live, regenerable cost estimate is at [`docs/cost-estimate.md`](docs/cost-estimate.md). It's produced by [`scripts/estimate-cost.ts`](scripts/estimate-cost.ts), which queries the **AWS Pricing API directly** for every BBG-deployed service (CloudTrail data events, DynamoDB on-demand + PITR, Lambda ARM, CloudWatch Logs ingest+storage, Synthetics canary, AWS Config, WAFv2 + managed rule groups, CloudFront, S3, API Gateway, KMS) and multiplies by the documented usage assumptions.

Refresh the estimate any time:

```bash
npm run -w @bbg/lambda estimate-cost
```

Two scenarios are tracked: **Light demo** (~10k Bedrock invocations/month) and **Production** (~1M/month). Each line item shows its driver, live unit price, and total. Source SKU is named under each line so you can verify the price came from where you'd expect.

**What BBG does NOT cost you** (despite measuring it): the Bedrock invocations themselves. Those bill to whichever IAM principal made the call, exactly as they would without BBG.

**Self-cost reporting**: every Lambda emits `bbg.MeterCostUSD` (Sum, USD per invocation, dimensioned by `Lambda=<name>`) computing its own ARM compute + DDB write cost on each run. The `bbg/Operations` dashboard charts a 7-day rolling Sum per Lambda. AWS Cost Explorer filtered by the `Project=bbg` cost-allocation tag is still the cross-cutting view (CloudWatch Logs ingest, KMS, SQS, etc. — the things the Lambdas don't self-attribute).

## 📚 Documentation

**In-app docs.** Every signed-in user has a searchable **Documentation** section in the web app (nav → *Documentation*, route `/docs`) with task-oriented guides — what BBG is, budgets, reading the spend dashboard, custom pricing discounts, notifications, the per-principal activity log, and identities/enrollment. Major pages also carry a **Help** button (top nav) that opens a contextual panel and deep-links into the matching guide. The in-app content lives in [`web/src/docs/manifest.ts`](web/src/docs/manifest.ts).

**Keeping docs current.** A non-blocking pre-commit reminder (`npm run docs:check`) nudges you when code under `lambda/src`, `infra/lib`, or `web/src/pages` changes without a matching `docs/`, `README.md`, or in-app-docs update. Enable the hook once per clone with `npm run hooks:install` (sets `core.hooksPath`); set `BBG_DOCS_CHECK_STRICT=1` to turn the reminder into a hard gate (e.g. in CI).

**Reference docs (operator / architecture):**

- [`docs/architecture.md`](docs/architecture.md) — system diagram, the requestId join, multi-agent attribution, optional gateway flow, multi-account topology.
- [`docs/identity-coverage.md`](docs/identity-coverage.md) — full CloudTrail JSON samples for every caller type.
- [`docs/pricing-nuances.md`](docs/pricing-nuances.md) — AWS Pricing API workarounds (3 service codes, no `modelId` attribute, name normalization, multi-dimensional support, plus the `PricingApiSchemaChanged` forward-compat watch that fires when AWS finally ships a stable model identifier).
- [`docs/well-architected.md`](docs/well-architected.md) — pillar-by-pillar mapping.
- [`docs/threat-model.md`](docs/threat-model.md) — STRIDE threat model + mitigations (machine-readable export in [`docs/threat-model.json`](docs/threat-model.json)).
- [`docs/perf-tuning.md`](docs/perf-tuning.md) — quarterly per-Lambda memory sweep driven by Lambda Power Tuning.
- [`docs/cur-reconciliation.md`](docs/cur-reconciliation.md) — how CUR 2.0 IAM-principal allocation is layered as a second source.
- [`docs/parallel-enforcement.md`](docs/parallel-enforcement.md) — opt-in CUR + AWS Budgets enforcement channel that runs in parallel to the real-time meter (defense-in-depth).
- [`docs/multi-agent.md`](docs/multi-agent.md) — Bedrock Agents and multi-agent collaboration coverage.
- [`docs/multi-account-multi-region.md`](docs/multi-account-multi-region.md) — multi-region + multi-account expansion architecture (cross-region log forwarding via EventBridge, cross-account StackSet topology, OU vs explicit-account vs external enrollment paths, phased rollout).
- [`docs/declarative-budgets.md`](docs/declarative-budgets.md) — YAML/JSON manifest format + dry-run-first apply API. Authoring budgets in git instead of by hand in the web app.
- [`docs/service-catalog.md`](docs/service-catalog.md) — packaging BBG as an AWS Service Catalog product so per-account admins in your Org can self-service-launch.
- [`docs/operator-config.md`](docs/operator-config.md) — schema for the SSM operator-config parameter.
- [`docs/demo.md`](docs/demo.md) — full demo runbook end-to-end.
- [`docs/runbooks/`](docs/runbooks/) — per-Lambda and per-alarm operational runbooks.

## 🔒 Security

- **Real-time enforcement** stops runaway spend in seconds, not hours.
- **Scoped IAM**: enforcement Lambda's `iam:AttachUser/RolePolicy` is restricted via `iam:PolicyARN` ArnEquals condition to `bbg-deny-*` only — it cannot attach arbitrary policies.
- **Read-only Organizations grant**: the `org-discount-resolver` gets only `organizations:ListRoots`, `ListAccountsForParent`, `ListOrganizationalUnitsForParent`, and `DescribeOrganization`. It deliberately **omits** `organizations:ListParents` — the walk descends top-down, so it already knows each account's parent and never needs to query upward.
- **CloudTrail** identity signal rides a multi-region management-events trail (Bedrock API calls delivered to the default EventBridge bus). BBG creates a minimal one by default (management events only — the first copy is free from CloudTrail; write-only S3 with 7-day expiry); opt out via `bbg:createManagementEventsTrail: false` when the account/Org already has a management trail.
- **All S3 buckets** are private, BPA-on, OAC-served (CloudFront), and SSL-enforced.
- **WAFv2** on prod CloudFront.
- **AWS Config recorder + curated rules** for ongoing posture checks.
- **WebAuthn-only first-factor sign-in** — no TOTP, no SMS. Per-credential nicknames managed via DynamoDB.
- **Cognito advanced security** ENFORCED, password policy 12+ chars all classes.
- **No prompt content** in invocation logs (Bedrock's `textDataDeliveryEnabled: false`); BBG only meters token + dimension counts.

## 🤝 Contributing

This is an open-source aws-samples-style reference. PRs welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md) for the contribution workflow and [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) for the Amazon code of conduct. For security reports, see [`SECURITY.md`](SECURITY.md).

## 📄 License

[MIT-0](LICENSE)

---

**Status**: Sample / reference implementation — not for production use without your own review.
