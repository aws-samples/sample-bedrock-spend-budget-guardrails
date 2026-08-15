# Runbook: `identity-cache` Lambda

## Purpose

The `identity-cache` Lambda is the canonical-identity resolver. It receives Bedrock CloudTrail data events from EventBridge, canonicalizes the `userIdentity` block into a stable `principal#...` key (handling IAMUser, AssumedRole, SSO `AWSReservedSSO_*`, federated, and Bedrock Agent service-call shapes), enriches with IAM principal tags, and writes an `IdentityCache` row keyed by `requestId`. If a `PendingMeter` row already exists for that requestId, it emits a `bbg.identity-arrived` EventBridge event so the meter can complete the spend join.

## Symptoms

- CloudWatch alarm `<stage>-bbg-meter-unjoined` firing — the join isn't completing because identity rows aren't landing (the symptom shows up in the meter, the cause is usually here). See [`meter-unjoined.md`](meter-unjoined.md) first.
- Lambda errors / throttles on `<stage>-bbg-identity-cache-<region>`.
- DLQ depth on `<stage>-bbg-metering-dlq-<region>` (this Lambda shares the metering DLQ).
- `bbg.IdentityArrivedAfterMeter` metric stuck at zero while `MeterUnjoined` is climbing — identity rows aren't being written, or the post-write `PendingMeter` lookup is broken.
- New principal types (federated SAML, custom AssumedRole shapes) showing up as `principal#unknown` in `RunningSpend` — canonicalization fell through every match arm.
- IAM tag enrichment missing for principals you'd expect to have it — usually the in-memory 5-minute tag cache is masking an `AccessDenied` from `iam:ListUserTags` / `iam:ListRoleTags`.
- Bedrock Agent invocations not appearing in `AgentSessions` — the `bedrock-agent-runtime:InvokeAgent` branch isn't matching.
- Log lines `No requestID on CloudTrail event`, `IAM tag lookup failed`, or `PendingMeter lookup failed`.

## Likely causes (in order)

1. **CloudTrail data events for Bedrock not flowing.** Most common root cause when `MeterUnjoined` fires. The `BedrockDataEvents` custom resource sets advanced event selectors on the `<stage>-bbg-bedrock-<region>` trail; if those got stripped (org-level CloudTrail re-deploy, manual edit), no events reach EventBridge so this Lambda never fires. See [`meter-unjoined.md`](meter-unjoined.md) for the full triage.
2. **EventBridge rule disabled or filter mismatch.** The rule `<stage>-bbg-bedrock-runtime-<region>` filters on `source: aws.bedrock-runtime / aws.bedrock / aws.bedrock-agent-runtime` and `detail-type: AWS API Call via CloudTrail`. If a new Bedrock API surface emits a different `source`, this Lambda won't see it.
3. **IAM tag-lookup permission denied.** `iam:ListUserTags` / `iam:ListRoleTags` fail on cross-account or `AWSReservedSSO_*` roles you can't introspect. The Lambda swallows the error in a debug log and proceeds without tags — the join still works, but tag-based budget conditions don't. If you see `principalTags` consistently empty for SSO sessions, this is why.
4. **New `userIdentity` shape canonicalizes to `principal#unknown`.** The match arms in `canonicalize()` (in `lambda/src/shared/arn.ts`) cover IAMUser, AssumedRole (with SSO sub-case keyed on `/aws-reserved/sso.amazonaws.com/`), `AWSService`/`invokedBy=bedrock.amazonaws.com` (Bedrock Agents), and `FederatedUser`/`WebIdentityUser`/`SAMLUser`. Anything else falls through. New AWS SSO/Identity Center session shapes have surfaced here historically.
5. **In-memory tag cache hot.** Tags are cached 5 min per ARN per Lambda execution environment. If a customer just changed an IAM tag, expect up to 5 min of stale data per warm container. Not a bug, but operators sometimes ask "why did my tag change not take effect."
6. **`AGENT_SESSIONS_TABLE` env var unset.** The Lambda would crash on the first `InvokeAgent` event. Should never happen in a CDK-deployed stack but watch for it after a manual env change.
7. **EventBridge `PutEvents` failing.** The Lambda has the `events:PutEvents` IAM permission scoped to the default event bus; if someone tightened that to a custom bus, identity-arrived emission silently fails. The identity row still gets written, but the meter never drains its pending row.

## Investigation

```bash
# Recent identity-cache logs (errors/warnings first)
aws logs tail /aws/lambda/dev-bbg-identity-cache-us-west-2 \
  --since 30m --filter-pattern '?ERROR ?WARN ?failed ?denied' --region us-west-2

# Full tail when reproducing
aws logs tail /aws/lambda/dev-bbg-identity-cache-us-west-2 --follow --region us-west-2

# CloudTrail trail status — is it logging?
aws cloudtrail get-trail-status --name dev-bbg-bedrock-us-west-2 --region us-west-2

# Currently configured event selectors (should mention Bedrock resource types)
aws cloudtrail get-event-selectors --trail-name dev-bbg-bedrock-us-west-2 --region us-west-2

# EventBridge rule + target health
aws events describe-rule --name dev-bbg-bedrock-runtime-us-west-2 --region us-west-2
aws events list-targets-by-rule --rule dev-bbg-bedrock-runtime-us-west-2 --region us-west-2

# Recent identity rows (confirm shape)
aws dynamodb scan --table-name dev-bbg-identity-cache \
  --max-items 5 --region us-west-2

# Look for principal#unknown rows (canonicalization fell through)
aws dynamodb scan --table-name dev-bbg-identity-cache \
  --filter-expression 'principal = :p' \
  --expression-attribute-values '{":p":{"S":"principal#unknown"}}' \
  --region us-west-2

# Agent sessions tracking working?
aws dynamodb scan --table-name dev-bbg-agent-sessions \
  --max-items 5 --region us-west-2

# IdentityArrivedAfterMeter — should match the rate at which MeterUnjoined drains
aws cloudwatch get-metric-statistics --namespace bbg \
  --metric-name IdentityArrivedAfterMeter \
  --start-time $(date -u -v-1H +%FT%TZ) --end-time $(date -u +%FT%TZ) \
  --period 60 --statistics Sum --region us-west-2

# Confirm the Lambda's IAM role can actually call PutEvents
aws iam simulate-principal-policy \
  --policy-source-arn $(aws iam get-role --role-name dev-bbg-identity-cache-us-west-2-role \
    --query 'Role.Arn' --output text 2>/dev/null) \
  --action-names events:PutEvents --region us-west-2 2>/dev/null || echo 'role lookup may need a different name'
```

## Remediation

**Cause 1 — Trail event selectors stripped.** Re-deploy the metering stack; the `BedrockDataEvents` custom resource will reset them:

```bash
cdk deploy 'DevAppStage/Metering-us-west-2'
```

Verify with `aws cloudtrail get-event-selectors` that the advanced selectors mention `AWS::Bedrock::AgentAlias` and `AWS::Bedrock::KnowledgeBase`.

**Cause 2 — EventBridge rule disabled / filter mismatch.** Re-enable:

```bash
aws events enable-rule --name dev-bbg-bedrock-runtime-us-west-2 --region us-west-2
```

If a new Bedrock API surface needs to be covered, edit the `eventPattern` in `infra/lib/metering-stack.ts` and redeploy.

**Cause 3 — IAM tag denials.** Usually benign — the Lambda already swallows them. If you need tags for a specific cross-account principal, the answer is to grant `iam:ListUserTags` / `iam:ListRoleTags` on that account to the Lambda's role via a resource-based / cross-account approach. Don't widen the Lambda's policy to `Resource: *` blindly.

**Cause 4 — New `userIdentity` shape.** Capture the unmatched payload from a log line, drop a fixture in `lambda/test/fixtures/cloudtrail/`, add a match arm in `canonicalize()`, write a unit test, then redeploy.

**Cause 5 — Hot tag cache.** Either wait 5 min for the cache to expire, or force-roll the Lambda's execution environments by publishing a new version (a no-op env change works):

```bash
aws lambda update-function-configuration \
  --function-name dev-bbg-identity-cache-us-west-2 \
  --description "cache-bust $(date +%s)" --region us-west-2
```

**Cause 6 — Missing env var.** Redeploy the metering stack — env vars are wired in `infra/lib/metering-stack.ts`.

**Cause 7 — `events:PutEvents` denied.** Check the Lambda's role policy. The grant is on the default event bus; if a custom bus is in use, both the rule and the grant need updating.

## Idempotency / safety notes

- **Safe to retry the entire Lambda invocation.** The `IdentityCache` write is a `PutCommand` (last-write-wins, but every retry of the same CloudTrail event has the same content so the row is stable). The TTL is reset to "1 hour from now" on each write, which extends the join window — that's fine.
- **`AgentSessions` upsert uses `if_not_exists` on `firstSeen` and `endUser`** so retries don't clobber the original session-start timestamp. `lastSeen` advances on every retry, which is correct.
- **`bbg.identity-arrived` emission is at-most-once-per-invocation, but at-least-once across retries.** The meter's drain path is idempotent (reads + deletes a `PendingMeter` row, with the `processedRequestIds` guard catching any double-billing), so duplicate events are safe.
- **Don't manually edit `IdentityCache` rows.** The meter joins by `requestId`, and rewriting the `principal` mid-flight would mis-attribute the spend. If you absolutely need to override an attribution, use the SPA's admin tools (which write a corrective adjustment, not an in-place edit).
- **`AgentSessions` rows have a 7-day TTL** — keep that in mind if you're investigating an old multi-agent attribution issue.

## Related runbooks

- [`meter.md`](meter.md) — the downstream consumer of `IdentityCache` rows and `bbg.identity-arrived` events
- [`meter-unjoined.md`](meter-unjoined.md) — the alarm that most often triages back to this Lambda
- [`enforcement.md`](enforcement.md) — uses the canonicalized principal as the IAM attach target
