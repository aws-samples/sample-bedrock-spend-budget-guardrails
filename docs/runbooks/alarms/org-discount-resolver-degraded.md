# Runbook: `OrgDiscountResolverDegraded`

## Symptom

CloudWatch alarm `<stage>-bbg-org-discount-resolver-degraded` fires when the `bbg.OrgDiscountResolverDegraded` metric is `> 0` for **1 evaluation period** (`treatMissingData: NOT_BREACHING`). The metric is emitted once per run by the `org-discount-resolver` Lambda when it has OU/org discount policies to resolve but **cannot walk the AWS Organizations tree** — `walkOrgTree` threw (typically `AccessDeniedException` on `organizations:ListRoots`). The run then returns `{ resolved: 0, degraded: true }` **without touching any row**.

Default threshold: `> 0` over 1 period (immediate).

## What it means

**Money keeps flowing at a rate nobody is re-resolving.** This is a silent-staleness condition, not a stop:

- OU- and org-scoped discounts **stop re-resolving**. A newly-authored OU discount never takes effect; a deleted one is never cleared.
- Any `effectivePct` materialized onto a `discount#<accountId>` row by a **prior successful run** stays in place and **keeps being applied by the meter at its last value**. The resolver deliberately does **not** mass-clear on a denial — doing so would nuke every org/OU discount on one transient throttle, which is a worse money outcome than briefly-stale rates. On a *permanent* loss of access, those rates persist until an operator re-authors them.
- **Account-scoped discounts are unaffected.** The meter falls back to the authored `discountPct`, so per-account rates keep working (and newly-authored ones take effect immediately).

So the failure mode to reason about is: metered spend may be discounted by an OU/org rate that is no longer the authored intent, and nothing else will tell you.

## Severity guidance

- **Sev3** — the install is expected to be the Org management account (OU/org discounts are in active use) and the alarm is sustained. Effective rates are frozen at their last value and every metered dollar is potentially wrong. Page the on-call.
- **Sev4** — a single degraded run (transient Organizations throttle) that the next hourly run clears, or a known non-management-account install where OU/org rows were authored by mistake. File a ticket.

## Likely causes (in order)

1. **BBG is not deployed in the Org management account.** `organizations:ListRoots` / `ListAccountsForParent` / `ListOrganizationalUnitsForParent` only succeed from the management account (or a delegated administrator). This is a deployment-topology fact, not a bug — and it is by far the most common cause. Expect it on any member-account install where someone authored an OU or org discount.
2. **`organizations:*` read access was denied or removed.** An SCP, permissions boundary, or a hand-edit to the resolver's role dropped one of the four granted read actions (`ListRoots`, `ListAccountsForParent`, `ListOrganizationalUnitsForParent`, `DescribeOrganization`).
3. **AWS Organizations isn't enabled** for the account (standalone account, or the org was deleted).
4. **Transient Organizations throttle / API error** on a large tree. Degrades that one run only; the next hourly run at `:20` recovers.

## Investigation

```bash
# Confirm the degrade + read the thrown error message.
aws logs tail /aws/lambda/dev-bbg-org-discount-resolver --since 3h --region us-west-2 \
  --filter-pattern 'degraded'

# Reproduce synchronously — the fastest yes/no on Organizations reachability.
aws lambda invoke --function-name dev-bbg-org-discount-resolver \
  --invocation-type RequestResponse --region us-west-2 /tmp/out.json \
  && cat /tmp/out.json
# {"resolved":0,"degraded":true}  → still denied.
# {"resolved":N,"degraded":false} → recovered (cause 4).

# Can this account see Organizations at all?
aws organizations describe-organization --region us-east-1
aws organizations list-roots --region us-east-1
# AccessDeniedException here = cause 1 or 2. Compare the caller:
aws sts get-caller-identity
# ...against the org's management account id from describe-organization
# (Organization.MasterAccountId) if you can read it from elsewhere.

# Are the four read actions still on the resolver's role?
ROLE=$(aws lambda get-function-configuration \
  --function-name dev-bbg-org-discount-resolver --region us-west-2 \
  --query Role --output text | awk -F/ '{print $NF}')
aws iam list-role-policies --role-name "$ROLE"
aws iam get-role-policy --role-name "$ROLE" --policy-name <policy-name> \
  --query 'PolicyDocument.Statement[?contains(to_string(Action), `organizations`)]'

# Which OU/org rows are we failing to resolve, and what effectivePct is
# currently stuck in place from the last successful run?
aws dynamodb scan --table-name dev-bbg-pricing --region us-west-2 \
  --filter-expression 'begins_with(#m, :p)' \
  --expression-attribute-names '{"#m":"model"}' \
  --expression-attribute-values '{":p":{"S":"discount#"}}' \
  --projection-expression '#m, scope, discountPct, effectivePct, effectiveScopeId, effectiveResolvedAt'
# An old effectiveResolvedAt on an account row + this alarm = stale money.
# If there are NO discount#ou#… / discount#org#… rows, the resolver would have
# short-circuited before touching Organizations — this alarm should not be firing.
```

## Remediation

Pick one of the two supported topologies.

### Option A — Deploy BBG in the Org management account (causes 1, 3)

Make the install (or a delegated administrator for Organizations) the management account, then confirm:

```bash
aws lambda invoke --function-name dev-bbg-org-discount-resolver \
  --invocation-type RequestResponse --region us-west-2 /tmp/out.json && cat /tmp/out.json
```

### Option B — Manage discounts per-account only

Account-scope discounts need no Organizations access at all — the meter reads the authored `discountPct` directly. Delete the OU/org rows and author one row per account:

```bash
# 0% on an ou/org scope deletes the authored row.
curl -X POST https://<api-url>/admin/pricing/discounts \
  -H "Authorization: Bearer $JWT" \
  -d '{"scope":"ou","scopeId":"ou-abcd-11111111","discountPct":0}'

curl -X POST https://<api-url>/admin/pricing/discounts \
  -H "Authorization: Bearer $JWT" \
  -d '{"scope":"account","scopeId":"123456789012","discountPct":12.5,"label":"EDP rate"}'
```

**Critical follow-up:** while degraded, deleting the OU/org row does **not** un-discount the accounts that inherited it — the resolver won't run a clearing pass. Clear each stale materialization by hand (authored `discountPct` is preserved):

```bash
aws dynamodb update-item --table-name dev-bbg-pricing --region us-west-2 \
  --key '{"model":{"S":"discount#123456789012"}}' \
  --update-expression 'REMOVE effectivePct, effectiveScope, effectiveScopeId, effectiveResolvedAt'
```

The meter caches the discount row for 5 minutes per warm container, so allow that long on the money path.

### Cause 2 — IAM regression

Restore the grant by redeploying `PricingStack` (it declares the four read actions):

```bash
BBG_LOCAL=1 npx cdk deploy 'DevAppStage/Pricing-us-west-2'
```

If an SCP is the blocker, either exempt the resolver's role or fall back to Option B.

### Cause 4 — Transient

No action. The hourly `cron(20 * * * ? *)` run clears it. Confirm with a manual synchronous invoke returning `degraded: false`.

Acceptance: a run logs `org-discount-resolver complete` and emits `OrgDiscountResolved` (with `OrgDiscountResolverDegraded` absent). The alarm returns to OK within the next evaluation period.

## Related runbooks

- [`org-discount-resolver`](../org-discount-resolver.md) — full component runbook, precedence rules, and the degrade semantics in detail.
- [`meter`](../meter.md) — reads the materialized `effectivePct` on the money path (one cached `GetItem`, 5-min TTL).
- [`pricing-refresher`](../pricing-refresher.md) — shares the `Pricing` table and the `PricingStack` scheduler role.
