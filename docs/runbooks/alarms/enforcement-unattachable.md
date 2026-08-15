# Runbook: `EnforcementUnattachable`

## Symptom

CloudWatch alarm `<stage>-bbg-enforcement-unattachable` fires when the `bbg.EnforcementUnattachable` metric is `> 0` for **1 evaluation period** (`treatMissingData: NOT_BREACHING`). The metric increments when the `enforcement` Lambda detects a budget breach on a principal it **cannot attach a scoped deny to** — there is no attachable IAM user/role AND no scoping condition. Rather than create an inert (never-attached) IAM policy and falsely mark the row "Enforced", enforcement declines to act and emits this metric so the gap is visible.

Default threshold: `> 0` over 1 period (immediate).

## What it means

The budget **meters and alerts correctly, but does NOT deny.** The principal can keep calling Bedrock past its limit. This is a *configuration* problem (a deny budget on an unenforceable key), not a runtime failure.

## Likely causes

1. **A `deny` budget keyed on `principal#unknown`.** BBG couldn't attribute the invocations to any IAM identity (root caller, truncated CloudTrail event, unmatched userIdentity type). There is nothing to attach a deny to. *The budgets API now rejects creating such a budget (400); this alarm covers rows created before that guard, or via direct DynamoDB writes.*
2. **A federated principal with no observable issuer** — e.g. a legacy `GetFederationToken` (`arn:aws:sts::<acct>:federated-user/...`) session. CloudTrail carries no `sessionIssuer` for these, so BBG has no role to attach the deny to.
3. **A standalone `principal#sessionTag/...` budget without the gateway.** Session-tag budgets only auto-enforce when the BBG gateway (`bbg:enableGateway`) attaches the deny to the federation role. Without it, there's no attach target.

## Remediation

Re-key the budget to an **enforceable** principal, or make it alert-only:

- **IAM user / role ARN** — attaches directly.
- **`principal#sso-user#<email>`** — enforcement attaches the deny to the SSO reserved role scoped to that user via `aws:userid StringLike "*:<email>"` (only that user's sessions are denied). Requires the user's Bedrock traffic to be metered (an `sso-user#` spend row exists).
- **`principal#sourceIdentity#<value>`** — same idea, scoped via `aws:SourceIdentity`.
- **`action: alert`** — if the principal is genuinely unattachable, drop the deny and keep the budget for visibility/notification only. This clears the alarm.

## Investigation

```bash
# Which principal(s) tripped it? The drill-down emission carries a principal dimension.
aws logs tail /aws/lambda/dev-bbg-enforcement-us-west-2 --since 1h --region us-west-2 \
  --filter-pattern 'not enforceable'

# Find deny budgets on unenforceable keys.
aws dynamodb scan --table-name dev-bbg-budgets --region us-west-2 \
  --filter-expression 'action = :d AND (begins_with(principal, :u) OR begins_with(principal, :s))' \
  --expression-attribute-values '{":d":{"S":"deny"},":u":{"S":"principal#unknown"},":s":{"S":"principal#sessionTag/"}}'
```

## Related

- Enforcement mechanism for non-ARN identities: `docs/identity-coverage.md`, `docs/architecture.md` (coverage matrix).
