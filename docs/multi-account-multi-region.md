# Multi-region + multi-account expansion

**What this is.** A design doc for taking Bedrock Budget Guard (BBG) from its current single-account, single-region (`us-west-2`) shape to a deployment where one **home account** monitors and enforces Bedrock spend across multiple regions in the home account *and* across selected member accounts of an AWS Organization in selected regions per member.

This doc is design-only. No code changes are proposed here. It refines the AWS Organizations enrollment design with the constraints actually hit in practice (CloudTrail trail caps, Bedrock invocation logging being per-region, CRIS pricing) and lays out a phased implementation path.

For overall system context, see [`docs/architecture.md`](architecture.md) and [`docs/architecture.png`](architecture.png).

---

## 1. Goal statement

**What this is.** The single sentence that defines what "expanded BBG" means.

A single BBG **home account** must be able to monitor and enforce on Bedrock spend across:

- **Multiple regions in the home account** — e.g. `us-west-2`, `us-east-1`, `us-east-2` simultaneously, with one BBG control plane.
- **Selected member accounts of an AWS Organization, in selected regions per member** — opt-in per (account, region) pair. Not every member account needs every region enabled.
- **All metering data flows back to the home account's `RunningSpend` table.** `Budgets`, `IdentityCache`, `Pricing`, `InferenceProfiles`, the API, and the web app all stay in the home account, single source of truth. Member accounts hold no BBG state.
- **Deny policies attach in the member account** the offending principal lives in. Enforcement is not centralized — IAM `AttachUserPolicy` / `AttachRolePolicy` only works in the principal's own account, so the home-account enforcement Lambda assumes a scoped role into the member account to do the attach.

The principle: **signals fan inwards** to the home account; **enforcement actions fan outwards** to the member accounts via short-lived `sts:AssumeRole` credentials. Same security model as the single-account version — the role permissions are unchanged, just split across an account boundary.

---

## 2. Constraints

**What this is.** Hard AWS limits and design realities that shape every option below.

- **Hard limit: 5 CloudTrail trails per AWS account**, including management trails. This is per-account, not per-region. A naive "one trail per metered region per account" pattern is dead on arrival for any org with more than a handful of regions.
- **Bedrock invocation logging is per-region.** [`PutModelInvocationLoggingConfiguration`](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_PutModelInvocationLoggingConfiguration.html) is a regional API and the configuration it sets is regional state. There's no `IsMultiRegion` flag analogous to CloudTrail. To capture token counts in N regions, you must call the API N times.
- **CloudTrail data events at high volume incur material cost.** At Bedrock-data-event volumes ($0.10 per 100k events priced from `aws-sdk` SKUs as of 2026-05; see [`docs/cost-estimate.md`](cost-estimate.md)), turning data events on for *every* region in *every* member account when the account doesn't actually use Bedrock there is wasteful.
- **Cross-region log forwarding adds infra surface.** Every region that runs Bedrock but isn't the home region adds a CloudWatch Logs subscription (or Kinesis stream, or S3 bucket) on the path between source-region invocation logs and the home-region meter Lambda. More moving parts → more failure modes → more runbook entries.
- **Cross-account IAM is a security boundary.** The home-account enforcement Lambda cannot just call `iam:AttachUserPolicy` against a member account's principal. It needs an explicit `sts:AssumeRole` into a role in the member account, with a tightly scoped trust policy and the existing `iam:PolicyARN ArnEquals bbg-deny-*` condition preserved.
- **Bedrock Model Invocation Logging cannot encrypt to a CMK in a different account by default.** If we use a customer-managed CMK on the home-region log group, we have to grant the member-account Bedrock service principal `kms:GenerateDataKey` on it, scoped via `aws:SourceAccount` and `aws:SourceArn`. 

These five constraints rule out the most obvious per-region/per-account fan-out designs.

---

## 3. Architecture options to evaluate

**What this is.** Three concrete approaches to the CloudTrail data-event capture problem, plus a recommendation.

The CloudTrail piece is the centre of the puzzle — Bedrock model invocation logging gives us tokens, but only CloudTrail data events give us `userIdentity` (and the `requestId` join). So the trail strategy decides the rest of the wiring.

### Option A — One trail per metered region

A dedicated `cloudtrail.Trail` for each metered region, similar to the current single-account `MeteringStack` (see [`infra/lib/metering-stack.ts:194`](../infra/lib/metering-stack.ts)).

**Pros**

- Zero refactor to the meter — each region's trail mirrors today's implementation.
- Failure isolation: a trail outage in one region doesn't blind the others.

**Cons**

- **NOT VIABLE for multi-account.** Hits the 5-trail cap fast. Even in the home account: 1 management trail + 5 metered regions = 6 trails, exceeds quota.
- Within the home account we could use up to 4 metered regions (1 trail slot reserved for an existing customer trail), but no member account that already has a Control Tower-managed trail has any slots left.
- Doubles up cost — every region pays the per-event surcharge independently, no aggregation.

**Verdict: REJECTED.** Doesn't scale past a single account, ever.

### Option B — One Organization trail with selectors (RECOMMENDED default)

A **single** organization trail in the home account (`IsOrganizationTrail=true`), with **advanced event selectors** scoped to:

- `eventCategory = Data`
- `resources.type IN (AWS::Bedrock::Model, AWS::Bedrock::AgentAlias, AWS::Bedrock::KnowledgeBase)`
- `readOnly = true OR false` (we want both — `InvokeModel` is `readOnly=true` per CloudTrail's classification, while `InvokeAgent` is sometimes recorded as `readOnly=false`).

The org trail counts against the home account's 5-trail quota *only*; member accounts are not charged a slot for the org trail. CloudTrail delivers logs from every member account in the org's selected scope to the home-account S3 bucket.

**Pros**

- One trail to operate, monitor, and pay for.
- Member accounts give up zero trail slots — operators in those accounts can keep their own trails.
- Advanced selectors confine costs to Bedrock data events only — non-Bedrock traffic adds nothing.
- Newly-created accounts in the org auto-enroll if the org trail's `OrganizationsRootARN` selector targets the org root (or a chosen OU).
- The S3 bucket for trail logs is in the home account, so the home-account `identity-cache` Lambda already has the IAM grants it needs.

**Cons**

- **Requires AWS Organizations management permissions** to create the org trail. BBG never assumes management-account access — operators must explicitly opt in. We flag this with an SSM context flag (e.g. `bbg:enableOrgTrail`, default `false`) and the home account must be either the management account or a delegated CloudTrail administrator account.
- An org trail is org-wide by definition — you can scope by OU but not by individual account. If you want to monitor only 3 of 50 member accounts, you still pay data-event ingest for the other 47 (mitigated by the resource-type selectors so non-Bedrock traffic is free, but Bedrock-using accounts you didn't intend to enrol still cost money).
- Latency from member-account `InvokeModel` to home-account EventBridge bus is typically 1–3 minutes for cross-account org-trail delivery — slower than the in-account ~30s today. This is acceptable for the meter (the existing `PendingMeter` retry path already handles late-arriving identity), but enforcement p95 will be ~2 min in member accounts vs. <30 s in the home account.

**Verdict: RECOMMENDED as the default for multi-account.** Fits within the trail cap, pays the operational simplicity tax for the latency cost.

### Option C — Fold into an existing customer trail

If the customer's organization already runs a CloudTrail org trail (Control Tower deploys one as `aws-controltower-BaselineCloudTrail`; many security orgs also run their own), we can **add** Bedrock data-event advanced selectors to that existing trail rather than create a new one.

**Pros**

- Zero net new trails — best for security-mature orgs already at or near the 5-trail cap.
- Inherits the customer's existing log-bucket replication, KMS key, and lifecycle policies.
- The customer's log-aggregation security tooling (e.g. Splunk, Athena over the trail bucket) gets Bedrock data events for free.

**Cons**

- **Requires the customer to give BBG `cloudtrail:PutEventSelectors` access to a trail they own.** That's a policy edit on someone else's resource — possibly hard in regulated orgs.
- Adding Bedrock data event selectors to a busy trail can shift its cost characteristics — operator should review the trail's existing data-event budget first.
- If the customer's trail has a different S3 bucket layout, BBG's S3-driven identity-cache pipeline needs path-aware ingest (operator config knob).

**Verdict: BEST CHOICE for security-mature orgs.** Document as an alternative to Option B, gated on operator config flag `bbg:existingTrailArn`. When set, BBG skips creating its own trail and instead emits a one-time CloudFormation custom resource that calls `PutEventSelectors` on the customer's trail to add Bedrock data events. The custom resource is idempotent and removes its added selectors on stack delete.

### Summary

| Option | Trails created | Trail cap impact | Member-account opt-in granularity | Recommended for |
|---|---|---|---|---|
| **A** — per-region trail | N (= metered regions × accounts) | Hits cap fast | Per-account | NOT VIABLE past 1 account |
| **B** — Org trail | 1 (home) | 1 slot home, 0 slots member | Per-OU | **Default for multi-account** |
| **C** — Reuse customer trail | 0 | 0 | Per-(trail's scope) | Security-mature orgs at trail cap |

---

## 4. Cross-region log forwarding

**What this is.** How Bedrock invocation logs (which carry token counts) get from the source region in a member account to the home-region meter Lambda.

CloudTrail data events solve identity (Option B/C above). Token counts come from a **separate** stream — Bedrock model invocation logging delivers them to a CloudWatch Logs log group in the source region. To meter, the home-region `meter` Lambda has to read those logs.

Two paths, in increasing order of operational simplicity:

### Path 1 — Subscription destination + Kinesis (the "classic" route)

1. In the source region of the source member account, Bedrock writes invocation logs to a CWL log group (`/aws/bedrock/<stage>-invocations-<region>`, mirroring [`infra/lib/metering-stack.ts:166`](../infra/lib/metering-stack.ts)).
2. A **CloudWatch Logs cross-account / cross-region [destination](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/CrossAccountSubscriptions.html)** in the source region targets a **Kinesis Data Stream** in the home region.
3. The home-region meter Lambda consumes from the Kinesis stream.

**Pros**
- Mature, well-supported pattern; documented in the AWS Logs developer guide for years.
- Backpressure-tolerant — if the meter slows, Kinesis buffers up to 7 days.
- Works across both account and region boundaries simultaneously.

**Cons**
- Three new resources per (member-account, source-region) pair: log-group + destination + IAM role on the source side, plus a shared home-region Kinesis stream.
- Kinesis is the major recurring cost — base shard pricing plus PUT-payload charges. At low Bedrock volumes the Kinesis bill can dominate.
- Operator has to provision the Kinesis stream's shard count to match peak invocation rate; under-provisioned shards drop log records.

### Path 2 — CWL cross-region subscription filter (the "modern" route)

CloudWatch Logs gained a native cross-region subscription filter target in 2025. The source-region log group can directly subscribe a destination Lambda or Firehose in another region — no intermediate Kinesis stream required.

1. In the source region, Bedrock writes to its CWL log group.
2. A `logs.SubscriptionFilter` on that log group has `destinationArn` pointing at the home-region `meter` Lambda.
3. The Lambda gets invoked directly from the source region.

**Pros**
- Two resources instead of three (subscription filter + IAM role; no Kinesis stream).
- One billing line item (CWL ingest) instead of two (CWL ingest + Kinesis).
- Drastically simpler for low-volume regions where Kinesis would be over-provisioned.

**Cons**
- Newer feature — fewer mature patterns documented and slightly riskier in failure modes (e.g. throttling behaviour under burst).
- No buffer in front of the meter Lambda, so transient Lambda failures could lose records (the meter Lambda's existing DLQ catches these, but there's no replay layer the way Kinesis offers).

### Recommendation

**Default to Path 2** (cross-region subscription filter direct to home-region Lambda) for any deployment with fewer than ~100k invocations/region/month. **Fall back to Path 1** (Kinesis-buffered) when:

- Per-region invocation volume exceeds ~100k/month and DLQ replay would be operationally costly.
- The deployment is multi-account and we expect spiky traffic where peak well exceeds the meter's reserved concurrency.
- An auditor requires a buffered durable-storage layer before metering.

Document both in the operator config and let `bbg:crossRegionLogPath` accept `"direct"` (default) or `"kinesis"`.

**Open question: do the source-region CloudWatch Logs ingest charges apply in the source region or the destination region for cross-region subscription filters?** This is materially relevant to the cost model for member accounts that don't otherwise have CWL infra. Verify before final implementation; default to assuming source-region pricing applies (the conservative cost model).

---

## 5. IAM roles per member account

**What this is.** The three explicitly-named cross-account roles a member account must host so the home account's Lambdas can read signals and write deny policies.

All three live in the **member** account and are assumed by Lambda execution roles in the **home** account. Trust policies are tight — only the specific home-account Lambda role can assume, and only for known external-id values where applicable. Because IAM is a global service, the member stack gates all three behind a CloudFormation condition so they are created exactly once per account (in the home region), not once per enrolled region.

The member stack also creates a handful of **local** service roles that no other account assumes — for Bedrock invocation logging, the invocation-logging custom-resource provider, the CWL forwarder, and the EventBridge rule's cross-account `PutEvents` target. Those are per-region, unnamed (CloudFormation generates the names), and not part of the cross-account trust surface described below.

### `bbg-meter-reader` (read-only)

Assumed by the home-account `meter` Lambda's execution role. Used to read identity-cache and pending-meter signals where the source data lives in the member account (e.g. when the org trail delivers events that need member-account context, or when reading log group metadata).

**Permissions**

| Action | Resource | Why |
|---|---|---|
| `events:PutEvents` | `arn:aws:events:<home-region>:<member-account>:event-bus/default` | Forward `bbg.identity-arrived` events from member account back to home (only used in advanced setups; usually unnecessary because org trail handles delivery) |
| `logs:DescribeLogGroups`, `logs:DescribeLogStreams` | `arn:aws:logs:*:<member-account>:log-group:/aws/bedrock/*` | Sanity-check that Bedrock invocation logging is enabled in the metered region |
| `logs:GetLogEvents` (read-only) | Same as above | Replay window for late-joining identity-cache misses |

No write to `RunningSpend`, `Budgets`, `Pricing`, or any DynamoDB table in any account. No write to S3. The role cannot affect Bedrock spend; it's purely an observation role.

**Trust policy** restricts `Principal` to:

```json
{
  "Effect": "Allow",
  "Principal": { "AWS": "arn:aws:iam::<home-account>:role/<home-region>-bbg-meter-<region>-role" },
  "Action": "sts:AssumeRole",
  "Condition": { "StringEquals": { "sts:ExternalId": "<random-per-deploy>" } }
}
```

External-id is an extra defence-in-depth against the [confused deputy problem](https://docs.aws.amazon.com/IAM/latest/UserGuide/confused-deputy.html); even if the trust policy ARN is leaked, an attacker who guessed the home-account Lambda role still needs the external id to assume.

### `bbg-enforcement` (write — IAM only)

Assumed by the home-account `enforcement` Lambda's execution role. Identical permissions to today's single-account enforcement role, just hosted in the member account.

**Permissions**

| Action | Resource constraint | Why |
|---|---|---|
| `iam:CreatePolicy` | `arn:aws:iam::<member-account>:policy/bbg-deny-*` | Create the deny on first breach |
| `iam:DeletePolicy` | Same | Clean up at period rollover |
| `iam:GetPolicy`, `iam:GetPolicyVersion`, `iam:ListPolicyVersions` | Same | Idempotency checks |
| `iam:AttachUserPolicy`, `iam:DetachUserPolicy` | `*` (entity), with `Condition: { ArnEquals: { iam:PolicyARN: arn:aws:iam::<member-account>:policy/bbg-deny-* } }` | Attach the deny to the offending IAM user; the condition restricts the attached policy to the BBG namespace |
| `iam:AttachRolePolicy`, `iam:DetachRolePolicy` | Same condition | Same, for IAM roles |
| `iam:ListAttachedUserPolicies`, `iam:ListAttachedRolePolicies` | `*` | Period-rollover cleanup pagination |

**Critical: do NOT widen the `iam:PolicyARN` condition.** This is a hard rule — the enforcement role can only ever attach `bbg-deny-*` policies, never anything else, even with full IAM admin credentials assumed. Same scoping as today's [`infra/lib/enforcement-stack.ts`](../infra/lib/enforcement-stack.ts) inline policy, just deployed to a different account.

**Trust policy** restricts `Principal` to the home-account `enforcement` Lambda role specifically, plus an external-id condition.

### `bbg-readiness-reader` (read-only)

Assumed by the home-account `readiness` Lambda for the org-wide Bedrock-attribution audit. Purely `Describe`/`List`/`Get` across IAM, Bedrock, CloudWatch, CloudTrail, Cost Explorer, and BCM Data Exports — no mutating action anywhere, so a compromise of the readiness Lambda cannot change member-account state. **Trust policy** pins the home readiness Lambda role ARN plus the audit's fixed `RoleSessionName` (and the Org ID when it's known at synth time).

### Why separate roles, not one

Could combine them into a single `bbg-cross-account` role and let every Lambda assume it. We don't because:

- **Least privilege.** The meter and readiness Lambdas have no business calling `iam:CreatePolicy`. Combining roles means *any* compromise of either potentially leads to IAM policy creation in member accounts. Splitting limits the blast radius.
- **Independent rotation.** The corresponding Lambda roles in the home account already exist independently; mirroring that split into the member account keeps the symmetry.
- **Audit clarity.** Roles named for their function (`bbg-meter-reader`, `bbg-enforcement`, `bbg-readiness-reader`) read better in member-account CloudTrail logs than one generic role.

### Distribution

For org-wide rollout, these roles plus their trust and inline policies — along with the per-region ingest resources (Bedrock invocation-logging log group + config, the CWL forwarder Lambda and its subscription filter, and the Bedrock-runtime EventBridge rule) — are packaged as a single CloudFormation template (`BbgMemberStack`, rendered inline in [`infra/lib/member-stackset-stack.ts`](../infra/lib/member-stackset-stack.ts)) and distributed via **CloudFormation StackSets** (or Service Catalog, or CDK Pipelines cross-account — see §8 open question).

---

## 6. Sequencing (phases for implementation)

**What this is.** The minimum-viable-shipping order. Each phase is independently deployable; existing deployments don't break when a phase ships.

### Phase 1 — Home account, multi-region

Goal: prove the home-account multi-region case end-to-end before touching cross-account.

#### 6.1.1 Phase 1a — topology refactor (shipped 2026-05-21)

Refactored `MeteringStack` so each instance can land in its corresponding metered region, since:

- Bedrock can only deliver invocation logs to a CloudWatch LogGroup **in the same region** as the Bedrock invocation.
- CWL subscription filters to Lambda are **same-region only** (no cross-region target support).

Topology:

| Resource | Lives in |
|---|---|
| LogGroup (`/aws/bedrock/...-invocations-{region}`) | metered region |
| `BedrockLoggingConfig` custom resource | metered region |
| Bedrock data-events CloudTrail trail | metered region |
| EventBridge rules (`BedrockApiRule`, `IdentityArrivedRule`) on the default bus | metered region |
| `meter` / `identity-cache` / `inference-profile-refresher` Lambdas | metered region (read/write DDB cross-region to home) |
| `ledger-writer` Lambda | **home region only** (consumes the home-region DDB stream — event-source mappings cannot span regions) |
| `RunningSpend`, `Budgets`, `IdentityCache`, etc. (DataStack tables) | home region |

Lambdas in non-home metered regions get a `HOME_REGION` env var; the shared DDB client honors it so cross-region table access targets the home region. Latency cost is ~10–50ms per call plus inter-region data transfer; since the meter writes to DDB once per invocation (not per token), the bill stays small.

**No behavior change for the single-region case** (home == metered): the topology is identical to pre-refactor.

#### 6.1.2 Phase 1b — flip on additional regions (deferred)

Once the single-region topology has soaked in your environment, expand `bbg:meteredRegions` to `["us-west-2", "us-east-1", "us-east-2"]` and redeploy. Validation steps:

- Confirm Bedrock invocations in any of the 3 regions show up in the home-account `RunningSpend` table within the same p95 latency budget as today's single-region meter.
- **CRIS verification:** confirm the existing prefix strip in [`lambda/src/shared/arn.ts:114`](../lambda/src/shared/arn.ts) handles cross-region invocations. Specifically: a call originating in `us-west-2` against an inference profile that runs the model in `us-east-1` should still be metered against the home-account `RunningSpend` table at the source region's pricing rate.
- Document the per-region cost expectation (CloudTrail + CloudWatch Logs + Lambda invocations + cross-region DDB transfer) in `docs/cost-estimate.md`.

#### 6.1.3 Out of scope

- No new IAM cross-account roles in either Phase 1a or 1b.
- No Org trail.
- No StackSet deployment.

**Done when:** multi-region home-account demo runs Bedrock in 3 regions and BBG meters all 3 in a single Spend dashboard.

### Phase 2 — Multi-account, opt-in via StackSet

Goal: enrol member accounts one at a time with operator action. **Phase 2 has both a data-plane and a control-plane shape; both are first-class.**

#### 6.2.1 Data plane (cross-account ingest + enforcement)

- Add `BbgMemberStack` (CloudFormation, deployed via StackSet) — see §5.
- Add `bbg:enrolledMemberAccounts` to operator config: a list of `{ accountId, regions: [...] }` objects.
- Update `enforcement` Lambda to derive the `accountId` from the principal ARN, call `sts:AssumeRole` against `arn:aws:iam::<accountId>:role/bbg-enforcement` if the principal is in a non-home account, and use those credentials for `iam:AttachUserPolicy`/`AttachRolePolicy`.
- Add the home-account `meter` Lambda's optional `sts:AssumeRole` against `arn:aws:iam::<accountId>:role/bbg-meter-reader` for any member-account log replay.
- Document `aws cloudformation create-stack-set` + `create-stack-instances` in the operator runbook.
- Region selection per member account is via the `regions: [...]` list — Phase 2 still uses one trail per metered region in the **home account** (i.e. Option A in §3 for ingest), not the org trail. Member accounts ship their identity-cache events to the home-region default event bus via a per-account `events:PutEvents` permission grant.

**One-time bootstrap (per member account)** — self-managed StackSet permission model requires `AWSCloudFormationStackSetExecutionRole` to exist in each member, trusting the home account's `AWSCloudFormationStackSetAdministrationRole`. CDK does not deploy this for you; the operator runs it once with member-account admin credentials.

The execution role needs permissions for **every** resource type in the member stack, not just IAM — the stack also creates two Lambda functions, a log group, a subscription filter, and an EventBridge rule, and it passes roles to Lambda and EventBridge. A policy scoped to IAM + CloudFormation alone will fail mid-deploy with `AccessDenied`:

```yaml
# stackset-execution-role.yaml — deploy to each member account once.
AWSTemplateFormatVersion: '2010-09-09'
Resources:
  StackSetExecutionRole:
    Type: AWS::IAM::Role
    Properties:
      RoleName: AWSCloudFormationStackSetExecutionRole
      AssumeRolePolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Principal: { AWS: 'arn:aws:iam::<HOME_ACCOUNT_ID>:role/AWSCloudFormationStackSetAdministrationRole' }
            Action: sts:AssumeRole
      # One-time bootstrap only. Grant the minimum needed to deploy everything
      # the BBG member stack contains: seven IAM roles (three explicitly named
      # — bbg-enforcement, bbg-meter-reader, bbg-readiness-reader, all gated to
      # the home region because IAM is global — plus four CloudFormation-named
      # service roles for Bedrock invocation logging, the custom-resource
      # provider, the CWL forwarder, and the EventBridge rule target), two
      # Lambda functions (bbg-invocation-logging-provider-<region>,
      # bbg-cwl-forwarder-<region>), the /aws/bedrock/bbg-<region> log group,
      # its subscription filter, and the bbg-bedrock-runtime-<region> rule.
      # Operators SHOULD scope this further to their org.
      Policies:
        - PolicyName: bbg-member-stackset-deploy
          PolicyDocument:
            Version: '2012-10-17'
            Statement:
              # The three named cross-account roles, plus the four whose names
              # CloudFormation generates from the stack name (StackSet-…).
              - Effect: Allow
                Action:
                  - iam:CreateRole
                  - iam:DeleteRole
                  - iam:GetRole
                  - iam:PutRolePolicy
                  - iam:DeleteRolePolicy
                  - iam:GetRolePolicy
                  - iam:AttachRolePolicy
                  - iam:DetachRolePolicy
                  - iam:ListAttachedRolePolicies
                  - iam:ListRolePolicies
                  - iam:TagRole
                  - iam:UntagRole
                  - iam:UpdateAssumeRolePolicy
                Resource:
                  - 'arn:aws:iam::*:role/bbg-*'
                  - 'arn:aws:iam::*:role/StackSet-*'
              # Passed to lambda:CreateFunction (the two provider roles) and to
              # events:PutTargets (the rule's PutEvents role).
              - Effect: Allow
                Action: iam:PassRole
                Resource:
                  - 'arn:aws:iam::*:role/bbg-*'
                  - 'arn:aws:iam::*:role/StackSet-*'
                Condition:
                  StringEquals:
                    iam:PassedToService:
                      - lambda.amazonaws.com
                      - events.amazonaws.com
              - Effect: Allow
                Action:
                  - lambda:CreateFunction
                  - lambda:DeleteFunction
                  - lambda:GetFunction
                  - lambda:GetFunctionConfiguration
                  - lambda:UpdateFunctionCode
                  - lambda:UpdateFunctionConfiguration
                  - lambda:AddPermission
                  - lambda:RemovePermission
                  - lambda:GetPolicy
                  - lambda:TagResource
                  - lambda:UntagResource
                  - lambda:ListTags
                  # CloudFormation invokes the invocation-logging custom
                  # resource through this role.
                  - lambda:InvokeFunction
                Resource: 'arn:aws:lambda:*:*:function:bbg-*'
              - Effect: Allow
                Action:
                  - logs:CreateLogGroup
                  - logs:DeleteLogGroup
                  - logs:DescribeLogGroups
                  - logs:PutRetentionPolicy
                  - logs:DeleteRetentionPolicy
                  - logs:TagResource
                  - logs:UntagResource
                  - logs:ListTagsForResource
                  - logs:PutSubscriptionFilter
                  - logs:DeleteSubscriptionFilter
                  - logs:DescribeSubscriptionFilters
                Resource: 'arn:aws:logs:*:*:log-group:/aws/bedrock/bbg-*'
              - Effect: Allow
                Action:
                  - events:PutRule
                  - events:DeleteRule
                  - events:DescribeRule
                  - events:PutTargets
                  - events:RemoveTargets
                  - events:ListTargetsByRule
                  - events:TagResource
                  - events:UntagResource
                Resource: 'arn:aws:events:*:*:rule/bbg-bedrock-runtime-*'
              - Effect: Allow
                Action: 'cloudformation:*'
                Resource: 'arn:aws:cloudformation:*:*:stack/StackSet-*/*'
```

> **`Resource: 'arn:aws:iam::*:role/StackSet-*'`** covers the four roles whose
> physical names CloudFormation derives from the stack name. If a member deploy
> fails with `AccessDenied` on `iam:CreateRole`, check the generated name in the
> stack events — CloudFormation truncates long stack names, so a very long
> `stageprefix` can produce a role name that no longer starts with `StackSet-`.
> Widen that one statement's `Resource` to `'*'` if so.

After this is deployed in the member, add the account to `bbg:enrolledMemberAccounts` in the home-account operator config and let the next pipeline run materialize the StackSet stack instances.

#### 6.2.2 Control plane (central deploy + per-account delegated admin)

> **First-class design constraint** surfaced during a real-world deployment evaluation: *"the holy grail is being able to deploy it centrally but then delegate admin access on a per account level."* Without this, Phase 2 either degenerates into "every account installs its own web app" (operationally untenable) or "every account-owner admins through the central team" (defeats delegation).

The shape:

- **One shared web app install** in the home account. Member-account owners log in to the same web app with their Cognito identity.
- **`scope` claim on the Cognito session** carries the list of `accountId`s the user can administer. A central super-admin has `scope: ["*"]`; a single member account's admin has `scope: ["111122223333"]`; a team that owns several accounts has `scope: ["111122223333", "444455556666"]`.
- **RBAC predicates on every API endpoint** filter by `scope.accounts` before reading/writing DDB. The web app's "current account" selector restricts the active view.
- **Cognito group naming**: `BBG-Admin-<accountId>` for per-account admins; `BBG-Admin-Wildcard` for super-admins. Group membership is the source of truth for scope.
- **Audit trail**: every cross-account budget edit is stamped with the operator's Cognito sub + the target account ID — important for chargeback and forensic review.

Sketch — example RBAC predicate on `GET /admin/identities`:

```typescript
// pseudocode in api/admin/identities.ts
const scope = parseCognitoScope(event.requestContext.authorizer.claims);
const accountFilter = scope.accounts.includes('*')
  ? null
  : { 'accountId IN': scope.accounts };
return ddb.query({ ...baseQuery, FilterExpression: accountFilter });
```

Open design questions:

- Cross-account dashboard view: aggregate or per-account default? Recommend aggregation with drill-down.
- Default-budget interaction: each delegated account has its own `bbg:defaultBudgetUSD` — do not propagate.
- Identity-cache cross-account: the web app needs to know which account each `RunningSpend` row belongs to (already carried via the `accountId` column added in Phase 2 data-plane work).

**Done when:** one externally-deployed member account is enrolled; Bedrock spend in that account is metered into the home `RunningSpend` table; a budget breach in the member account triggers a `bbg-deny-*` attach in the member account; a delegated admin in that account can log into the central web app and see/edit only their account's budgets, identities, and dashboards.

### Phase 3 — Organization-wide auto-enrollment (live, an earlier change/an earlier change)

Goal: scale Phase 2 to 50+ member accounts without per-account manual ops.

**Three SERVICE_MANAGED targeting flavors are live**, each backed by its own StackSet:

| Operator-config key | StackSet name | `accountFilterType` | autoDeployment | Use case |
|---|---|---|---|---|
| `bbg:enrolledOus` | `<stage>-bbg-member-roles-org` | (none — OU members) | `enabled: true` | Pick specific OUs; new accounts joining auto-enroll |
| `bbg:enrolledOrgAccounts` | `<stage>-bbg-member-roles-org-accounts` | `INTERSECTION` | `enabled: false` | Pick specific in-Org accounts by ID |
| `bbg:enrolledWholeOrg` | `<stage>-bbg-member-roles-whole-org` | `DIFFERENCE` (excludes home + extras) | `enabled: true` | Enroll the whole Org in one toggle |

The whole-org and OU paths both have `autoDeployment: enabled` so accounts joining the Org (or a targeted OU) auto-receive the member stack within ~10 min, and accounts leaving have their member stack detached.

**Precedence:** `bbg:enrolledWholeOrg` takes precedence over `bbg:enrolledOus` and `bbg:enrolledOrgAccounts` at synth. When whole-org is set, the per-OU and per-account SERVICE_MANAGED StackSets are silently skipped (CFN can't run two StackSets racing to provision the same global `bbg-enforcement` IAM role). The operator's per-OU/per-account selections **stay in SSM unchanged** — flipping whole-org off later restores the previous deployment shape with no further edits. The SELF_MANAGED `enrolledMemberAccounts` path (external accounts outside the Org) is unaffected since whole-org targets only Org members.

**SPA UX:**
- The web app's enroll page (`/admin/enroll`) has an "Organizational Units" tab where a wildcard-scope admin picks OUs + per-OU regions and clicks Apply, AND a "Whole-org auto-enroll" Toggle at the top with its own region picker.
- When the whole-org toggle is on, the per-OU and per-account toggles remain editable so operators can keep curating their selections; the toggle's description explains the precedence behavior.
- The page surfaces both StackSets' live `autoDeployment` state (enabled/retain flags + currently-targeted OU IDs) via the `GET /admin/enrollment/auto-deployment` API endpoint.
- The "StackSet status" tab distinguishes four deployment sources per instance: External (SELF_MANAGED), In-Org account (SERVICE_MANAGED INTERSECTION), OU auto-deploy (SERVICE_MANAGED + autoDeployment), or Whole-org auto-deploy (SERVICE_MANAGED DIFFERENCE + autoDeployment).

**Operator workflow:**

1. Open `/admin/enroll`, switch to the "Organizational Units" tab.
2. Toggle "Enrolled" on each OU you want auto-enrolled. Pick regions per OU (default `us-west-2`).
3. Click **Apply**. The page shows the pipeline execution ID; the StackSet update lands in ~10 min.
4. Verify via the "StackSet status" tab — every account currently in the targeted OUs renders a row with `Source: OU auto-deploy` and `Status: CURRENT`.
5. New accounts that join the OU later automatically get a row appended within ~10 min of joining — no operator action.

**Prerequisites** (same as the in-Org account path; the SPA preflight panel surfaces missing prereqs):
- The home account is the Org management account, OR has been registered as a delegated CFN StackSet administrator.
- `aws cloudformation activate-organizations-access` has been run (one-time, in the management account).
- `aws organizations enable-aws-service-access --service-principal=member.org.stacksets.cloudformation.amazonaws.com` has been run (one-time).

**What's still optional / aspirational:**
- Org-wide CloudTrail (Option B in §3): not required for Phase 3 to ship since the cross-account EventBridge rule + CWL forwarder pattern from Phase 2 covers data events. Still a worthwhile follow-up for cost reduction at scale.
- `Accounts` DynamoDB table for friendly account names: friendly names are already rendered in the web app via `formatAccount()` reading from the live `organizations:ListAccounts` result; a cached DDB table is only needed if Org API calls become a hot-path cost.
- Account-level / OU-level budget targets (`account#<id>` / `ou#<ou-id>`): not yet implemented.

**Done when:** an OU contains N accounts, all are auto-enrolled, and BBG correctly meters and enforces across all of them with no per-account operator action beyond the initial OU selection. ✅ Verified end-to-end against a multi-account test Org during soak.

---

## 7. Cost model

**What this is.** Order-of-magnitude expected costs by what gets multiplied by what. Numbers are illustrative — re-run [`scripts/estimate-cost.ts`](../scripts/estimate-cost.ts) for live unit prices and your specific volume.

### Per metered region (home account)

| Component | Driver | At 100k Bedrock calls/region/month |
|---|---|---|
| CloudTrail data events | Bedrock-only advanced selectors | ~$10/month |
| CloudWatch Logs ingest | Bedrock invocation logs | ~$2.50/month |
| DynamoDB writes (`RunningSpend` + ledger) | ~4 writes per invocation | ~$2.50/month |
| Lambda invocations (ARM) | ~3 per Bedrock call (meter + identity-cache + ledger-writer) | ~$0.60/month |

These are largely linear in invocation count; doubling traffic doubles cost. Multi-region just multiplies by N regions.

Cross-reference [`docs/cost-estimate.md`](cost-estimate.md) for the full per-component breakdown — that doc shows ~$55/month at 1M invocations in `us-west-2` today. Multi-region scales roughly N× that (the fixed costs — KMS keys, WAF, Synthetics canary, CloudFront — don't scale; only per-region per-invocation lines do).

### Per metered account (member)

| Component | Driver | Approx |
|---|---|---|
| IAM resources (`bbg-enforcement` + `bbg-meter-reader` + `bbg-readiness-reader` roles, the per-region service roles, and their inline policies) | Static | $0 |
| StackSet stack instance | Static | $0 |
| Cross-account `sts:AssumeRole` calls from home | Per enforcement event | <$0.01/month |
| Cross-account CloudTrail data event delivery (under org trail Option B) | Bedrock-only events | Same as home-account region: ~$10/region/month |

Member accounts cost essentially nothing on the BBG-specific resources themselves; the only material recurring cost is the data events, and those flow through the same pricing as the home-account regions.

### Per region of cross-region log forwarding

| Path | Driver | Approx |
|---|---|---|
| **Path 1 — Kinesis-buffered** | 1 stream + N shards × 24h | ~$11/shard/month + PUT payload charges |
| **Path 2 — CWL cross-region subscription** | No new resources beyond the subscription filter | CWL ingest pricing (~$0.50/GB) — comparable to the source-region ingest line |

Path 2 is materially cheaper at low volume; Path 1 only wins when peak invocation rate justifies a buffered durable layer. See §4 for the recommendation logic.

### Cross-references

- [`docs/cost-estimate.md`](cost-estimate.md) — live per-component breakdown for single-account `us-west-2`. Scale per-invocation lines by region count for multi-region.
- [`scripts/estimate-cost.ts`](../scripts/estimate-cost.ts) — re-run via `npm run -w @bbg/lambda estimate-cost` to refresh for your volume.
- For CUR-2.0 reconciliation specifics across accounts, see [`docs/cur-reconciliation.md`](cur-reconciliation.md). CUR 2.0 IAM-principal allocation is already org-wide when the export is configured at the org management account, so there's no per-account charge for the cross-account path itself.

---

## 8. Open questions

**What this is.** Things we don't yet have firm answers on. Default to the conservative option until each is resolved.

### CRIS twist

**Question.** Does cross-region inference (CRIS — cross-region inference profiles) introduce a wrinkle in cross-account / cross-region metering?

**Current state.** BBG already strips the CRIS regional prefix (`us.`/`eu.`/`apac.`/`ap.`/`global.`) from the `modelId` before pricing lookup — see [`lambda/src/shared/arn.ts:113`](../lambda/src/shared/arn.ts) and the rationale in [`docs/pricing-nuances.md`](pricing-nuances.md). This works because, per AWS Pricing API verification on 2026-05-13, **CRIS calls are billed at the source region's rate using the bare model SKU** — there are no separate CRIS pricing SKUs.

**What we need to verify in multi-region:** that the meter still attributes correctly when the **calling region** (where `InvokeModel` was invoked) differs from the **fulfilling region** (where the model actually ran, behind the inference profile). Specifically:

- The CloudTrail event records the `eventRegion` as the *calling* region (verified for direct `InvokeModel` and via inference profile in single-region today).
- The Bedrock invocation log entry records the same calling region in its `region` field.
- The `RunningSpend` row should be keyed by the calling region's pricing rate, not the fulfilling region's. This is what BBG does today (the strip-prefix-and-lookup-bare-modelId path) and should continue to work in multi-region — but we should explicitly add a multi-region integration test before Phase 1 ships.

**Document this fact in the doc:** `lambda/src/pricing-refresher/cross-ref.ts` plus the prefix-strip in [`lambda/src/shared/arn.ts`](../lambda/src/shared/arn.ts) already implement the right behaviour. Multi-region expansion does not introduce new CRIS handling; it only requires that we test the existing handling against multi-region traffic.

### StackSet vs Service Catalog vs CDK Pipelines

**Question.** Which distribution mechanism gives the best operator UX for adding a member account?

**Trade-offs:**

| Mechanism | Pros | Cons |
|---|---|---|
| **CloudFormation StackSets** (org auto-deploy) | Native AWS, no extra infra. Auto-enrolls new org accounts. Documented pattern (Config, Security Hub use it). Operator runs one `create-stack-set` once. | Templated CloudFormation only — can't directly use CDK constructs without a synth + render step. Updates have to roll across all stack instances; partial-failure recovery is operator-driven. |
| **AWS Service Catalog** | Self-service portfolio model — member-account admins can opt in/out themselves via the AWS console. Approval workflow built-in. | Adds a Service Catalog product + portfolio to maintain. Extra IAM surface. Doesn't auto-enrol new accounts. |
| **CDK Pipelines cross-account** | First-class CDK — same source of truth as the rest of BBG. Per-account stage targets supported. | Requires CDK bootstrap in every member account first (`npx cdk bootstrap`). Adds member-account compute cost (CodeBuild) for every deploy. Less natural for "add account" — you have to update the pipeline source and push to redeploy. |

**Don't pick a winner yet.** Each suits a different operator persona:

- StackSets fits **central-IT-managed orgs** that want one operator to opt in N accounts and have new accounts auto-enrol.
- Service Catalog fits **decentralized orgs** where each member-account team self-enrols on their own schedule.
- CDK Pipelines fits **unified-toolchain shops** where everything BBG-related must live in the same CDK app.

Phase 2 default = StackSets (lowest friction for the most-common case). Add a Service Catalog wrapper in a future phase if customers ask for it. Defer CDK Pipelines cross-account until we have a customer with that explicit requirement.

### Other ambiguities (deferred — open question, not yet resolved)

- **Cross-region CWL subscription source-region vs destination-region pricing.** See §4. Default to assuming source-region pricing applies; verify before final implementation.
- **Bedrock invocation logging and KMS-CMK encryption with a key in a different account.** §2 notes the constraint; full pattern needs an explicit test before Phase 2 ships.
- **Account-level vs principal-level enforcement precedence in multi-account.** Today's single-account precedence is documented in the original plan; cross-account adds the question of whether an OU-level budget overrides a per-principal budget. Default to per-principal-most-specific-wins until we have customer feedback. 
- **SCP-based enforcement.** Service Control Policies are strictly stronger than IAM denies (member-account admins cannot bypass them). Adding an SCP-emit path requires `organizations:AttachPolicy` on the home-account enforcement role — material widening of permissions; deferred until there's a clear operator demand.

---

## 9. Out of scope

**What this is.** Things that come up in conversation about multi-region/multi-account but are explicitly *not* this design.

- **Custom domains / DNS in non-home regions.** BBG's UI lives in the home account on a single CloudFront distribution. Member accounts and non-home regions have no UI surface.
- **Gateway-stack (`bbg:enableGateway`) cross-account.** The optional gateway pattern is an attribution aid for a single account; cross-account attribution via the gateway is a distinct future design.
- **Multi-account multi-agent (`bbg:enableMultiAgent`) reference deployment.** The multi-agent demo stack is a reference fixture, not production code; it doesn't need to scale across accounts.
- **AWS GovCloud / China region partitions.** Different IAM partition (`aws-us-gov`, `aws-cn`); the principal-ARN canonicalization handles partition correctly already, but cross-partition organization trails are not supported by AWS, so this expansion stays within `aws` partition only.

---

## 10. Cross-references

- [`docs/architecture.md`](architecture.md) and [`docs/architecture.png`](architecture.png) — single-account architecture; everything here builds on that loop.
- [`docs/cost-estimate.md`](cost-estimate.md) — live per-component pricing.
- [`docs/pricing-nuances.md`](pricing-nuances.md) — CRIS handling and the AWS Pricing API quirks the meter handles.
- [`docs/cur-reconciliation.md`](cur-reconciliation.md) — CUR 2.0 IAM-principal allocation, which is already org-wide when configured at the org management account.
- [`docs/operator-config.md`](operator-config.md) — schema for the SSM operator-config parameter; new keys for multi-region/multi-account land here.
- [`infra/lib/metering-stack.ts`](../infra/lib/metering-stack.ts) — current per-region metering wiring; the prop `meteredRegion` is already region-parameterized.
- [`infra/lib/cur-stack.ts`](../infra/lib/cur-stack.ts) — current CUR 2.0 wiring; relevant when reasoning about cross-account billing data.
- [`lambda/src/pricing-refresher/cross-ref.ts`](../lambda/src/pricing-refresher/cross-ref.ts) and [`lambda/src/shared/arn.ts`](../lambda/src/shared/arn.ts) — existing CRIS handling that is already correct for multi-region.
