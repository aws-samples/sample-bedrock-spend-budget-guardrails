# Bedrock Budget Guard — Threat Model

**Status:** Complete · **Methodology:** STRIDE via the Threat Modeling MCP (9 phases) · **Date:** 2026-07-15
**Machine-readable export:** [`docs/threat-model.json`](./threat-model.json) (AWS Threat Composer schema)
**Scope of analysis:** `lambda/src/**` and `infra/lib/**` in this repository (read-only code review).

This document is the STRIDE threat model for Bedrock Budget Guard. It is published so you can
see which threats were considered, which controls exist (with file:line), and what residual risk
you inherit when you deploy the sample. Every finding below was validated against the cited
source file and line range.

---

## 1. Executive summary

BBG is an AWS-native, multi-account **cost-control** system: it meters Amazon Bedrock spend per
IAM principal and, when a principal exceeds its USD budget or request/token rate limit, attaches a
scoped IAM **Deny** policy (`bbg-deny-*`) to that principal — in the home account directly, or in an
enrolled member account by assuming a `bbg-enforcement` role provisioned via CloudFormation
StackSets. An admin SPA (CloudFront + S3, WAFv2, Cognito passkey auth, API Gateway HTTP API with a
Cognito JWT authorizer) lets scoped admins manage budgets, defaults, enrollment, users, and pricing.

**BBG does not store customer prompt/response content.** Bedrock invocation logging is configured
with `textDataDeliveryEnabled=false` (member-stackset-stack.ts:447-456); BBG persists spend
metadata, budgets, IAM principal ARNs, and Cognito admin identities. This anchors the severity
calibration (assumption **A002**): the worst realistic impact is **availability** (denying a
legitimate principal's Bedrock access) or **cost** (failing to deny an over-budget principal so
spend continues) — **not** a confidentiality breach.

**Result:** 12 STRIDE threats identified across 5 trust boundaries. Phase 7.5 code validation
confirmed **5 were already fully mitigated by the code**; the remaining **7 residuals were
subsequently remediated before the initial public release** (verified against the fixed code — see §4). **All 12 are
now Resolved.** Every original residual was defence-in-depth hardening, not an open exploit, and each
fix was independently re-validated against the cited source (file:line below). **No finding is
Critical** — worst case is bounded to cost overrun or bounded Bedrock denial (A002). Nothing here
No finding requires a control beyond those already described below.

| Metric | Count |
|---|---|
| Total threats | 12 |
| Resolved | 12 (5 by original code: ENF-3, POL-2, AUZ-3, API-2, EDGE-1 · 7 remediated pre-release: ENF-1, ENF-2, POL-1, AUZ-1, AUZ-2, API-1, MET-1) |
| Open residuals | 0 |
| Critical severity | 0 |
| High severity (all Resolved) | 3 (ENF-1, ENF-2, AUZ-1) |

**Remediation summary** (verified — see §4 for the fix file:line): **AUZ-1** the API
Lambdas now set `AWS_ACCOUNT_ID` and the scope guard fails **closed** (403) for a scoped admin whose
target account is empty/unparseable; **ENF-1** the member `bbg-enforcement` trust policy gained an
`aws:PrincipalOrgID` `StringEquals` condition (Org-ID auto-detected at synth); **POL-1** the Deny
policy now covers `StartAsyncInvoke`/`CreateModelInvocationJob`/`InvokeModelWithBidirectionalStream`;
**ENF-2** an operator `bbg:pauseEnforcement` kill-switch + an `EnforcementApplied`-rate SNS alarm were
added; **API-1** malformed budget targets are rejected (400) before persistence; **AUZ-2** the legacy
`Admins`→wildcard fallback was removed; **MET-1** the `MeterUnjoined` + reconciliation-delta alarms
are SNS-wired with MET-1 runbook descriptions.

---

## 2. System / data-flow overview

**Components (C001–C008):**

- **C001 Admin SPA** — CloudFront + private S3 (OAC), WAFv2. Public runtime `config.json` (non-secret).
- **C002 Cognito user pool** — passkey (WebAuthn) sign-in; pre-token-gen V2 Lambda derives the
  `bbg:scope` claim from group membership.
- **C003 Admin API** — API Gateway HTTP API + Cognito JWT authorizer; fronts the admin Lambdas.
- **C004 Enforcement Lambda** — RUNNING_SPEND DynamoDB-stream consumer; builds + attaches `bbg-deny-*`.
- **C005 `bbg-enforcement` role (member accounts)** — assumed by the home account to manage `bbg-deny-*`.
- **C006 Meter + ingestion** — invocation logs + CloudTrail → EventBridge → cwl-forwarder → meter → ledger/identity-cache.
- **C007 DynamoDB tables** — BUDGETS, RUNNING_SPEND (+stream), identity, rate-counters, manifest.
- **C008 CUR 2.0 reconciler** — Athena over `line_item_iam_principal` CUR; drift alarm.

**Primary enforcement data flow:**

```
metered principal → Bedrock (invocation logs + CloudTrail)
      → EventBridge → cwl-forwarder (cross-region) → meter Lambda
      → join requestId→principal (identity-cache) → accumulate spendUsd (RUNNING_SPEND)
      → DynamoDB stream → enforcement Lambda → build bbg-deny-* (policies.ts)
      → home account: attach directly | member account: sts:AssumeRole bbg-enforcement → attach
      → period-rollover: detach + delete at period boundary
```

**Admin control-plane flow:** browser → Cognito passkey → JWT (carries server-derived `bbg:scope`)
→ CloudFront/WAF → API Gateway (JWT authorizer) → admin Lambda → `callerScope`/`scopeAllows`
authZ → DynamoDB/Cognito/IAM write → `emitAudit`.

---

## 3. Trust boundaries (the five load-bearing ones)

| ID | Boundary | Crossing | Core control | Key concern |
|----|----------|----------|--------------|-------------|
| **B1** | Cross-account enforcement (home → member `bbg-enforcement`) | `sts:AssumeRole` | Member perms scoped to `bbg-deny-*` (ArnEquals); trust = home role ARNs | No ExternalId / OrgID condition; home account = org-wide deny weapon (A001) |
| **B2** | Deny-policy correctness (member principal → Bedrock) | IAM Deny policy | `bbg-deny-*` on FM/profile/KB/agent/guardrail actions | Un-denied action/region/resource; IAM policy size |
| **B3** | Auth / `bbg:scope` (Cognito → Admin API) | JWT authorizer | Passkey + server-derived `bbg:scope` in signed JWT | Legacy `Admins`→wildcard fallback |
| **B4** | Admin-API writes + audit (admin → DynamoDB/IAM) | HTTPS + IAM role | `scopeAllows` per write + `emitAudit` | Fail-open scope; unvalidated target ARN |
| **B5** | Metering integrity + web edge | ingestion + CloudFront | Idempotency, pending-join, CUR reconcile, WAF | Silent under-count; public config exposure |

---

## 4. Threats by boundary

Severity is calibrated to **A002** (worst realistic impact = cost/availability, not confidentiality).
Status reflects code validation **plus the pre-release remediation pass**: **Resolved** = the
code handles it (either originally, or via the pre-release remediation fix noted in the Residual column). Every
"existing mitigation" cite was opened and confirmed; every the pre-release remediation fix was independently
re-verified against the fixed source (file:line) and the gates (lint/test/synth) re-run green.

### B1 — Cross-account enforcement

| ID | STRIDE | Scenario | Existing mitigation (file:line) | Residual | Severity | Recommendation |
|----|--------|----------|--------------------------------|----------|----------|----------------|
| **ENF-1** | Elevation of Privilege | An actor who can assume the member `bbg-enforcement` role attaches a Bedrock Deny to any principal in that account. | Member IAM perms scoped to `arn:...:policy/bbg-deny-*` via `ArnEquals iam:PolicyARN` on attach/detach, and CreatePolicy resource is `bbg-deny-*` — `member-stackset-stack.ts:236,243-262`. Trust `Principal` = specific home role ARNs — `member-stackset-stack.ts:205-214`. | **Resolved (remediated pre-release).** The `AssumeRolePolicyDocument` now carries an `aws:PrincipalOrgID` `StringEquals` condition (Org ID auto-detected at synth; omitted with a synth warning + allowlist-only fallback when unavailable) — `member-stackset-stack.ts:154-171,240-245`, threaded via `app-stage.ts:279`. Home-role-ARN `Principal` allowlist retained as the primary control. Synth confirmed a real Org ID (`o-…`) embedded in the trust policy. | High (Unlikely) | Done — `aws:PrincipalOrgID` condition added. Optionally add `sts:ExternalId` for external (non-Org) enrollment. |
| **ENF-2** | Denial of Service | A compromised/buggy home enforcement Lambda attaches Deny policies at scale across every enrolled account → org-wide Bedrock outage (A001 catastrophic case). | At-most-once event source mapping + 3 retries + DLQ — `enforcement-stack.ts:110-113`; set-once `enforcementPolicyArn` guard prevents duplicate attach — `enforcement/index.ts:222`; per-budget `unlimited` escape hatch. | **Resolved (remediated pre-release).** Operator kill-switch `bbg:pauseEnforcement` → `ENFORCEMENT_PAUSED` env (`enforcement-stack.ts:43-44,69`); the Lambda skips new deny attaches, emits an `EnforcementPaused` metric, and no-ops when set — `enforcement/index.ts:366-375`. An `EnforcementAppliedRate` alarm (5-min Sum > 25, SNS-wired) pages on mass-enforcement — `observability-stack.ts:92-98,166-175,261-263`. | High (Unlikely) | Done — rate alarm + pause flag. Residual under A001 (trusted home account) accepted. |
| **ENF-3** | Denial of Service | Detach fails at period rollover (IAM throttle) → a legitimate principal stays locked out past reset. | `period-rollover/index.ts:36-129` retry 3× + per-principal continue + `PeriodRolloverDetachFailure`/`DeleteFailure` dual-emit alarms; stuck-attach emits `EnforcementAttachStuck` + runbook — `enforcement/index.ts:190-201`; manual `/release` path — `api/budgets/index.ts:480-559`. | **Resolved.** Retried, alarmed, manually recoverable. (Operator must action the alarm; no auto self-heal.) | Medium | None required; keep the runbook current. |

### B2 — Deny-policy correctness

| ID | STRIDE | Scenario | Existing mitigation (file:line) | Residual | Severity | Recommendation |
|----|--------|----------|--------------------------------|----------|----------|----------------|
| **POL-1** | Elevation of Privilege | A budget-exceeded, Deny-attached principal keeps spending via a Bedrock action the policy doesn't cover. | `policies.ts:29-93` denies `InvokeModel`, `InvokeModelWithResponseStream`, `Converse`, `ConverseStream`, `GetInferenceProfile`, `Retrieve`, `RetrieveAndGenerate(+Stream)`, `InvokeAgent`, `ApplyGuardrail` across `arn:aws:bedrock:*`. | **Resolved (remediated pre-release).** `FM_ACTIONS` now also denies `bedrock:StartAsyncInvoke`, `bedrock:CreateModelInvocationJob` (batch), and `bedrock:InvokeModelWithBidirectionalStream` — `policies.ts:37-39`; asserted by `policies.test.ts`. | Medium (Possible) | Done — async/batch/bidirectional actions added to `FM_ACTIONS`. |
| **POL-2** | Elevation of Privilege | A target mapping to very many inference-profile ARNs pushes the policy toward the IAM 6KB managed-policy limit → truncation / CreatePolicy failure leaves the principal partly un-denied. | `policies.ts:43-55` resource list = one FM ARN + associated profiles (or a single wildcard for `model#*`/`profile#*`), so documents are tiny in practice; CreatePolicy failure caught + `EnforcementErrors` — `enforcement/index.ts:366-369`. | **Resolved.** No realistic path to the size limit with current targeting; failures are surfaced. | Low | Optional: split into multiple statements if a target ever nears the limit. |
| **POL-3** | Elevation of Privilege | A `deny` budget on a non-ARN principal (federated / SSO user / `unknown`) produced a customer-managed policy that was **never attached to anything** — an inert deny — while the spend row was stamped and `EnforcementApplied` emitted, so the dashboard falsely showed "Enforced (denied)" and the principal kept spending. | Historically none for the non-attached case; the deny was created in the home account and assumed (incorrectly) to gate via its Condition. | **Resolved .** The meter writes per-identity "lens" rows (`principal#sso-user#<email>` / `principal#sourceIdentity#<value>`) and enforcement attaches the deny to the **issuer role** scoped to the one identity via `aws:userid` (SSO) / `aws:SourceIdentity` (`policies.ts` `buildDenyPolicy`, `enforcement/index.ts` `evaluateAndEnforce`). A principal with no attach target AND no scoping condition (`principal#unknown`, GetFederationToken) no longer produces an inert policy or a false "Enforced" stamp — enforcement emits `EnforcementUnattachable` (alarmed) and the budgets API rejects `deny` on such keys. | Medium (Possible) | Done — issuer-attach enforcement + fail-loud `EnforcementUnattachable`; docs corrected. |

### B3 — Auth / `bbg:scope`

| ID | STRIDE | Scenario | Existing mitigation (file:line) | Residual | Severity | Recommendation |
|----|--------|----------|--------------------------------|----------|----------|----------------|
| **AUZ-2** | Elevation of Privilege | A member of the legacy `Admins` Cognito group signs in and gets `bbg:scope=["*"]` (org-wide super-admin) via the migration fallback. | Intentional migration compat: `pre-token-gen/index.ts:32` and `shared/api.ts:78` map `Admins`→wildcard; code comments flag it for removal (follow-up). | **Resolved (remediated pre-release).** The `Admins`→wildcard branch is removed from `deriveScope` (`pre-token-gen/index.ts:26-35`) and from the `callerScope` compat fallback (`shared/api.ts:80-87`); an `Admins`-only user now derives **empty** scope (no writes, no cross-account reads). Tests flipped to assert `Admins` grants no scope (`pre-token-gen.test.ts`, `api-scope.test.ts`). Confirmed the `BBG-Admin-Wildcard` group membership in both live pools before removal. (Note: `requireAdmin` still lists `Admins` as a coarse "is-admin-at-all" gate, but it confers no scope — harmless.) | Medium (Possible) | Done — legacy fallbacks removed. |
| **AUZ-3** | Spoofing | A client forges/alters `bbg:scope` to gain wildcard/other-account scope. | `bbg:scope` is server-derived by the pre-token-gen trigger from `groupsToOverride` (not client input) — `pre-token-gen/index.ts:42-62`; delivered in a Cognito-signed JWT; authorizer pins issuer + audience — `api-stack.ts:64-67`; handlers read scope only from validated claims — `shared/api.ts:54-86`. | **Resolved.** Client cannot influence the claim without controlling Cognito group membership (users API, wildcard-only). | High → mitigated | None (depends only on retiring AUZ-2). |

### B4 — Admin-API writes + audit

| ID | STRIDE | Scenario | Existing mitigation (file:line) | Residual | Severity | Recommendation |
|----|--------|----------|--------------------------------|----------|----------|----------------|
| **AUZ-1** | Elevation of Privilege | A scope-limited admin invokes a write targeting a principal in an account outside their scope. | `scopeAllows` gate on create/update/delete/toggle/release — `api/budgets/index.ts:308-311,384-387,435-438,456-459,489-492`; global routes (defaults, manifest, users, pricing, enrollment) are `isWildcard`-only — e.g. `api/budgets/index.ts:209,568`, `users/index.ts:366`, `pricing-overrides/index.ts:55`, `enrollment/index.ts:342`; core check `shared/api.ts:91-94`. | **Resolved (remediated pre-release).** The API Lambdas' `commonEnv` now sets `AWS_ACCOUNT_ID` (`api-stack.ts:73`), so `accountFromPrincipal` resolves the home account. A new fail-**closed** `scopeGuardResult()` (`api/budgets/index.ts:183-197`) rejects (403) a non-wildcard caller when `targetAccount` is empty/unparseable, and is applied at **all 5 write sites** — POST/PUT/DELETE/toggle/release (`budgets/index.ts:366-369,450-453,502-505,524-527,558-561`). No write path still uses the old `if (targetAccount && …)` pattern (grep-confirmed). Wildcard admins still proceed. Covered by `api-budgets.test.ts`. | High (Unlikely) | Done — fail-closed scope guard + `AWS_ACCOUNT_ID` set. |
| **API-1** | Tampering | An in-scope admin submits a malformed/over-broad budget `target` so the generated Deny resource defaults to `*`. | Budgets handler validates thresholds/window/rate + normalizes the `principal#` prefix; enrollment validates 12-digit account IDs + `ou-` IDs — `enrollment/index.ts:509,563,602,618`. | **Resolved (remediated pre-release).** `isValidTarget()` (`api/budgets/index.ts:125-130`) rejects (400) any target not matching `model#<id>`/`model#*`/`profile#<arn>`/`profile#*` (non-wildcard body must have a non-empty suffix), applied on both POST and PUT before persisting (`budgets/index.ts:356-360,443-447`), so `resourcesFor()` (`policies.ts:60`) never reaches the `['*']` fallback. Covered by `api-budgets.test.ts`. | Medium (Possible) | Done — budget target shape validated before persistence. |
| **API-2** | Repudiation | An admin write mutates state without leaving an audit line. | `emitAudit` — `shared/audit.ts:32-47` — called on every budget write (`api/budgets/index.ts:284,360,421,440,471,552,669`), pricing (`pricing-overrides:116,129`), enrollment (`enrollment:646`), and once per non-GET users request (`users/index.ts:375-385`). | **Resolved.** Coverage is complete for cross-account/global writes. (Self-service `/me/passkey-nicknames` writes are un-audited — own data, low value; audit lands in the Lambda log group, not a WORM store.) | Low | Optional: ship audit lines to a dedicated immutable sink (already shaped for an EventBridge fan-out). |

### B5 — Metering integrity + web edge

| ID | STRIDE | Scenario | Existing mitigation (file:line) | Residual | Severity | Recommendation |
|----|--------|----------|--------------------------------|----------|----------|----------------|
| **MET-1** | Tampering | Spend is under-counted or never joined to a principal (dropped log/event, cross-region loss, identity-cache miss) so RUNNING_SPEND never crosses the block threshold → enforcement never fires. | Idempotent on `processedRequestIds` — `meter/index.ts:382-404`; unjoined spend parked + drained on identity arrival (`meter/index.ts:476-491`, `identity-cache/index.ts:179-196`) with `MeterUnjoined` metric; cross-region `cwl-forwarder`; CUR reconciler drift metric `ReconciliationDeltaUsd` — `cur-reconciler/index.ts`. | **Resolved (remediated pre-release).** Both alarms exist and are SNS-wired: `MeterUnjoinedAlarm` (> 0 for 5 periods) — `observability-stack.ts:101-116`; `ReconciliationDeltaAlarm` (aggregate `ReconciliationDelta`, Maximum/day > $1 for 3 days; the alarmable rollup of the per-principal `ReconciliationDeltaUsd` drill-down) — `observability-stack.ts:132-149`; both pushed to `alarms[]` and `addAlarmAction(SnsAction(alertTopic))` — `observability-stack.ts:261-263`. the pre-release remediation added MET-1 runbook `alarmDescription`s to both. | Medium (Possible) | Done — `MeterUnjoined` + reconciliation-delta alarms SNS-wired with MET-1 descriptions. |
| **EDGE-1** | Information Disclosure | An unauthenticated actor reads the public `config.json` for secrets or probes for WAF gaps. | `web/public/config.json` holds only region, pool id, **public** client id, domain, and URLs — no secrets; WAFv2 `CommonRuleSet` + `KnownBadInputs` + `AmazonIpReputationList` + 2000/5min per-IP rate limit — `waf-stack.ts:37-101`; Cognito passkey is the auth gate. | **Resolved.** No secret exposure by design; edge is behind WAF + Cognito. (WAF rules are baseline managed sets — acceptable for an admin SPA.) | Low | None required. |

---

## 5. Assumptions

- **A001 — Org-internal trust.** BBG's home account and each enrolled member account are in the same
  AWS Organization under common trust; the home account is the trusted governance account. A
  **compromised home account is catastrophic** — the enforcement role can Deny Bedrock org-wide.
  This scopes ENF-1/ENF-2 to Org-internal actors and justifies accepting their (Unlikely) residual.
- **A002 — Worst impact = availability/cost, not confidentiality.** BBG stores spend metadata,
  budgets, and admin identities — never customer prompt/response content (invocation logging
  `textDataDeliveryEnabled=false`). Severity is graded against cost overrun / bounded Bedrock denial;
  this is why no finding is Critical.
- **A003 — Residual-risk calibration.** Phase 7.5 code validation confirmed which candidate threats
  the code already handled (5 resolved). The other 7 were defence-in-depth hardening (not open
  exploits) and have since been **remediated before the initial public release and independently re-verified**
  against the fixed code — all 12 threats are now Resolved.

---

## 6. Residual-risk summary

| Boundary | Threat | STRIDE | Severity | Likelihood | Status | Fix class |
|----------|--------|--------|----------|-----------|--------|-----------|
| B1 | ENF-1 | Elevation | High | Unlikely | **Resolved (the pre-release remediation)** | OrgID trust condition added |
| B1 | ENF-2 | DoS | High | Unlikely | **Resolved (the pre-release remediation)** | Kill-switch + rate alarm added |
| B1 | ENF-3 | DoS | Medium | Possible | Resolved | — |
| B2 | POL-1 | Elevation | Medium | Possible | **Resolved (the pre-release remediation)** | Async/batch/bidi deny actions added |
| B2 | POL-2 | Elevation | Low | Unlikely | Resolved | — |
| B3 | AUZ-2 | Elevation | Medium | Possible | **Resolved (the pre-release remediation)** | Legacy `Admins`→wildcard retired |
| B3 | AUZ-3 | Spoofing | High | Unlikely | Resolved | — |
| B4 | AUZ-1 | Elevation | High | Unlikely | **Resolved (the pre-release remediation)** | Fail-closed scope + `AWS_ACCOUNT_ID` |
| B4 | API-1 | Tampering | Medium | Possible | **Resolved (the pre-release remediation)** | Budget target shape validated |
| B4 | API-2 | Repudiation | Low | Unlikely | Resolved | — |
| B5 | MET-1 | Tampering | Medium | Possible | **Resolved (the pre-release remediation)** | MeterUnjoined + CUR-drift alarms SNS-wired |
| B5 | EDGE-1 | Info Disclosure | Low | Likely | Resolved | — |

**Overall posture:** the core enforcement and authorization controls are implemented and sound
(server-derived scope, per-account write gating, audited writes, scoped cross-account permissions,
idempotent metering, WAF + passkey edge). **All 7 former residuals were remediated in commit
the pre-release remediation and independently re-verified against the fixed code** (file:line in §4), with the
lint/test/synth gates re-run green (248 unit tests pass; `cdk synth 'DevAppStage/*'` clean, cdk-nag
OK; templates confirmed to embed `AWS_ACCOUNT_ID`, a real `aws:PrincipalOrgID`, `ENFORCEMENT_PAUSED`,
and the new/existing alarms). **0 open residuals remain.** No finding is a blocking exploit for the
sample release; all worst-case impacts are bounded to cost/availability per A002.

---

## 7. Traceability

- Machine-readable model (Threat Composer JSON): [`docs/threat-model.json`](./threat-model.json).
- Threat IDs below (ENF-1 … EDGE-1) are carried as `tags` on each threat in the JSON export for
  cross-referencing; the JSON `status` for all 12 threats is `threatResolved`.

| Threat | Status | Resolved by | Fix location (file:line) |
|--------|--------|-------------|--------------------------|
| ENF-1 | Resolved | the pre-release remediation | `member-stackset-stack.ts:154-171,240-245`; `app-stage.ts:279` |
| ENF-2 | Resolved | the pre-release remediation | `enforcement/index.ts:366-375`; `enforcement-stack.ts:43-44,69`; `observability-stack.ts:92-98,166-175` |
| ENF-3 | Resolved | original code | `period-rollover/index.ts:36-129`; `enforcement/index.ts:190-201` |
| POL-1 | Resolved | the pre-release remediation | `policies.ts:37-39` |
| POL-2 | Resolved | original code | `policies.ts:49-61`; `enforcement/index.ts:366-369` |
| AUZ-1 | Resolved | the pre-release remediation | `api/budgets/index.ts:183-197,366-369,450-453,502-505,524-527,558-561`; `api-stack.ts:73` |
| AUZ-2 | Resolved | the pre-release remediation | `pre-token-gen/index.ts:26-35`; `shared/api.ts:80-87` |
| AUZ-3 | Resolved | original code | `pre-token-gen/index.ts:37-57`; `api-stack.ts:64-67`; `shared/api.ts:56-88` |
| API-1 | Resolved | the pre-release remediation | `api/budgets/index.ts:125-130,356-360,443-447` |
| API-2 | Resolved | original code | `shared/audit.ts:32-47` (called on every write) |
| MET-1 | Resolved | the pre-release remediation | `observability-stack.ts:101-116,132-149,261-263` |
| EDGE-1 | Resolved | original code | `waf-stack.ts:37-101`; `web/public/config.json` (non-secret) |
