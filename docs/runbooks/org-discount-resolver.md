# Runbook: `org-discount-resolver`

## Purpose

Resolves **hierarchical (org / OU / account) custom pricing discounts** off the meter's hot path and materializes the winning percentage onto each account's `discount#<accountId>` row in the `Pricing` table, so the meter keeps reading exactly one cached `GetItem` per account (no tree walk per invocation).

Discounts are authored at three scopes, all stored in the `Pricing` table under the reserved `discount#` namespace (`lambda/src/shared/discounts.ts`):

| Scope | `Pricing` table key (`model` PK) |
|---|---|
| account | `discount#<12-digit accountId>` |
| ou | `discount#ou#<ou-id>` (any depth; the org root `r-…` is just an OU) |
| org | `discount#org#<org-id>` |

What one run does:

1. **Scan** the `Pricing` table filtered to `begins_with(model, 'discount#')`, projecting `model, discountPct, effectivePct`. Splits the **authored** `discountPct` values by scope, and records which account rows currently carry a **materialized** `effectivePct`.
2. **Short-circuit when there is nothing hierarchical.** If there are no OU rows and no org row, it clears any leftover `effectivePct` on account rows (so the meter falls back to the authored `discountPct`) and returns `{ resolved: 0, degraded: false }` **without calling Organizations at all**.
3. **Walk AWS Organizations top-down** (`walkOrgTree` in `lambda/src/shared/org-tree.ts`): `ListRoots` → recursive `ListAccountsForParent` + `ListOrganizationalUnitsForParent`, plus `DescribeOrganization` for the org id. Deliberately **no `organizations:ListParents`** — the top-down descent already knows each account's ancestor chain, which keeps the IAM grant minimal. Each account comes back with a root-first `ouPath`.
4. **Resolve most-specific-wins** per account (`resolveEffectiveDiscount`): account row → nearest OU walking `ouPath` deepest-first → org root (naturally the last OU checked) → org-wide → none. Single winner; **no multiplicative stacking**.
5. **Materialize** `effectivePct`, `effectiveScope`, `effectiveScopeId`, `effectiveResolvedAt` onto `discount#<accountId>` with a bare `UpdateCommand` — so it **creates the account row if it doesn't exist** (an OU/org discount applies to accounts with no authored per-account row).
6. **Clear stale materializations**: any account that previously had an `effectivePct` but no longer resolves to one (winning scope deleted, account left the org) gets `REMOVE effectivePct, effectiveScope, effectiveScopeId, effectiveResolvedAt`. The authored `discountPct` is never touched.

Deploy shape (`infra/lib/pricing-stack.ts`):

- Function: `<stage>-bbg-org-discount-resolver` (prod: `prod-bbg-org-discount-resolver`), timeout **5 min**, memory 512MB, ARM64/Node 20.
- **Hourly** EventBridge Scheduler schedule `<stage>-bbg-org-discount-resolve`, `cron(20 * * * ? *)` **UTC** (hourly at :20, offset clear of the 03:00 pricing-refresher and the activity cron slots), retry policy `maximumRetryAttempts: 2`.
- **On-demand**: the pricing-overrides API async-invokes it (`InvocationType: 'Event'`) after **every** discount write — upsert, 0%-clear, and both DELETE forms (`lambda/src/api/pricing-overrides/index.ts::triggerResolver`, wired via the `DISCOUNT_RESOLVER_FN` env var set in `infra/lib/api-stack.ts`). That trigger is fire-and-forget: it logs `discount resolver trigger failed` and never fails the API response, because the hourly schedule is the backstop.
- IAM: read-write on the `Pricing` table + `organizations:ListRoots`, `ListAccountsForParent`, `ListOrganizationalUnitsForParent`, `DescribeOrganization`.

Metrics (namespace `bbg`, `service=bbg` dimension):

| Metric | Meaning |
|---|---|
| `OrgDiscountResolved` | Count of accounts whose `effectivePct` was **successfully written** this run. |
| `OrgDiscountResolverWriteFailures` | Per-write materialize/clear failures. **Non-fatal** — the run continues; a partial run leaves some accounts on a stale `effectivePct`, and this metric is what makes that observable. |
| `OrgDiscountResolverDegraded` | Organizations was unreachable/denied → the run was a **no-op**. Alarmed: see [`alarms/org-discount-resolver-degraded.md`](alarms/org-discount-resolver-degraded.md). |

## ⚠️ Money note — what "degraded" actually does

When the Organizations walk throws (BBG is **not** deployed in the Org management account, or `organizations:*` read access was lost), the handler logs `org-discount-resolver degraded — Organizations unavailable`, emits `OrgDiscountResolverDegraded`, and **returns without touching a single row**.

That means **any `effectivePct` materialized by a prior successful run stays in place and keeps being applied by the meter at its last value.** This is deliberate — mass-clearing on a transient denial or throttle would nuke every org/OU discount in one run, which is a worse money outcome than briefly-stale rates. But on a **permanent** loss of Organizations access it is silently-stale money, not a stop: metered spend keeps being scaled by a rate nobody is re-resolving. The alarm exists precisely to make that visible. Newly-authored **account-scope** discounts still take effect immediately, because the meter falls back to the authored `discountPct`.

## Symptoms

- CloudWatch alarm `<stage>-bbg-org-discount-resolver-degraded` firing (`OrgDiscountResolverDegraded > 0`) — see the dedicated alarm runbook.
- An operator authored an **OU** or **org** discount in the SPA's Pricing page, the row exists in the `Pricing` table, but metered spend for accounts under that OU is still at list price (no `effectivePct` on their `discount#<accountId>` rows).
- The inverse: an OU/org discount was **deleted** but accounts under it are still being discounted — the resolver hasn't run since the delete, or its clear-write failed (`OrgDiscountResolverWriteFailures > 0`).
- A **new account** was added to a discounted OU but is metering at list price — it has no `discount#<accountId>` row yet and the resolver hasn't run since it joined.
- `OrgDiscountResolved` is flat at zero while OU/org discount rows demonstrably exist.
- Logs in `/aws/lambda/<stage>-bbg-org-discount-resolver`: `materialize failed`, `clear materialized failed`, `org-discount-resolver degraded — Organizations unavailable`.
- CUR-vs-meter reconciliation drift in one direction across a whole OU (a stale `effectivePct` means the meter's dollars disagree with the real invoice).

## Likely causes (in order)

1. **BBG isn't deployed in the Org management account.** `ListRoots` returns `AccessDeniedException`, the run degrades, and OU/org scopes never resolve. This is the single most common cause and it is a **deployment-topology** fact, not a bug — `organizations:ListRoots` / `ListAccountsForParent` / `ListOrganizationalUnitsForParent` only work from the management account (or a delegated administrator).
2. **The on-write trigger didn't fire.** `DISCOUNT_RESOLVER_FN` is unset on the pricing-overrides Lambda (stale deploy — the env var is captured at synth), or the async invoke was throttled. `triggerResolver` swallows the error by design, so the only evidence is a `discount resolver trigger failed` warn. The hourly schedule still catches it within the hour.
3. **Scheduler didn't fire.** The `<stage>-bbg-org-discount-resolve` schedule was disabled or deleted (e.g. a manual test that wasn't undone), or its role lost `lambda:InvokeFunction`. Combined with cause 2, discounts can go a long time without re-resolving.
4. **DDB write failures during materialize/clear.** Throttling or a transient error on the `Pricing` table. Counted in `OrgDiscountResolverWriteFailures` and logged per account; the run continues, so the result is a **partial** materialization — some accounts on the new rate, others still on the old one.
5. **The authored scopeId doesn't match the real tree.** An OU discount keyed on an `ou-…` id that isn't in this org (typo, or an id from another org) resolves for nobody. The resolver has no way to flag it — the row exists, it just never wins. Cross-check the id against `organizations list-organizational-units-for-parent`.
6. **Account-scope exclusion mistaken for a bug.** An account row with authored `discountPct: 0` is an **explicit exclusion** — "meter at list price, ignore any OU/org discount this account would inherit." It short-circuits precedence *before* the OU/org fallthrough, and the resolver never materializes an `effectivePct` onto it. If someone reports "the OU discount isn't applying to account X", check for a `discountPct: 0` row on X first. This is the only way to opt one account out of an inherited discount, and the 0%-write path stores the row rather than deleting it precisely so the OU rate can't silently re-inherit.
7. **Timeout on a very large org.** The walk is O(#OUs + #account pages) plus one write per discounted account, inside a 5-minute timeout. A single pass covers a typical org (<500 accounts, <100 OUs) comfortably, but a many-thousand-account org with a discount on the root could run long. A timeout leaves a partial materialization (writes are per-account, not transactional).

## Investigation

```bash
# Recent resolver activity (degrade + per-write failure logs).
aws logs tail /aws/lambda/dev-bbg-org-discount-resolver --since 3h --region us-west-2

# Manual synchronous invoke — returns {"resolved":N,"degraded":false}.
# This is the fastest way to answer "is Organizations reachable from here?"
aws lambda invoke --function-name dev-bbg-org-discount-resolver \
  --invocation-type RequestResponse --region us-west-2 /tmp/out.json \
  && cat /tmp/out.json

# Hourly schedule state (must be ENABLED, cron(20 * * * ? *) UTC).
aws scheduler get-schedule --name dev-bbg-org-discount-resolve --region us-west-2

# Resolver metrics.
for m in OrgDiscountResolved OrgDiscountResolverWriteFailures OrgDiscountResolverDegraded; do
  echo "=== $m ==="
  aws cloudwatch get-metric-statistics --namespace bbg --metric-name $m \
    --dimensions Name=service,Value=bbg \
    --start-time "$(date -u -v-1d +%Y-%m-%dT%H:%M:%S)" \
    --end-time "$(date -u +%Y-%m-%dT%H:%M:%S)" \
    --period 3600 --statistics Sum --region us-west-2 \
    --query 'Datapoints[].[Timestamp,Sum]' --output table
done

# Every authored + materialized discount row (all three scopes live here).
aws dynamodb scan --table-name dev-bbg-pricing --region us-west-2 \
  --filter-expression 'begins_with(#m, :p)' \
  --expression-attribute-names '{"#m":"model"}' \
  --expression-attribute-values '{":p":{"S":"discount#"}}' \
  --projection-expression '#m, scope, discountPct, effectivePct, effectiveScope, effectiveScopeId, effectiveResolvedAt'

# One account's row — what the meter will actually read.
aws dynamodb get-item --table-name dev-bbg-pricing --region us-west-2 \
  --key '{"model":{"S":"discount#123456789012"}}'
# effectivePct present  → an OU/org (or account) rate resolved by the resolver; the meter prefers this.
# effectivePct absent   → the meter falls back to the authored discountPct.
# discountPct 0         → explicit exclusion (list price). Expected to have NO effectivePct.
# effectiveResolvedAt   → when the resolver last wrote it. Ancient + degraded alarm = stale money.

# Is Organizations reachable at all from this account? (The resolver's own check.)
aws organizations describe-organization --region us-east-1
aws organizations list-roots --region us-east-1

# Does the OU id in the discount row actually exist in this org?
aws organizations list-organizational-units-for-parent \
  --parent-id r-xxxx --region us-east-1 \
  --query 'OrganizationalUnits[].[Id,Name]' --output table
```

## Remediation

### Cause 1 — Not the Org management account (degraded)

Two supported outcomes; pick one:

- **Deploy BBG in the Org management account** (or make its account a delegated administrator for Organizations). Then re-invoke the resolver and confirm `degraded: false`.
- **Manage discounts per-account only.** Delete the OU/org rows and author one `discount#<accountId>` row per account. The meter's fallback to the authored `discountPct` needs no resolver at all, so account-scope discounts work in any account:

  ```bash
  # Clear an OU-scope row (0% on ou/org deletes the authored row).
  curl -X POST https://<api-url>/admin/pricing/discounts \
    -H "Authorization: Bearer $JWT" \
    -d '{"scope":"ou","scopeId":"ou-abcd-11111111","discountPct":0}'

  # Author per-account instead.
  curl -X POST https://<api-url>/admin/pricing/discounts \
    -H "Authorization: Bearer $JWT" \
    -d '{"scope":"account","scopeId":"123456789012","discountPct":12.5,"label":"EDP rate"}'
  ```

  **Before you delete the OU/org rows, remember the degrade semantics**: while degraded, the resolver won't clear the `effectivePct` those rows previously materialized. Deleting the OU row alone does **not** un-discount the accounts — the stale `effectivePct` keeps applying. Either fix Organizations access so one clean run clears them, or clear the field by hand (see cause 4).

### Cause 2 — On-write trigger didn't fire

Confirm the env var is present, then redeploy the API stack if it isn't (it's captured at synth):

```bash
aws lambda get-function-configuration \
  --function-name dev-bbg-api-pricing-overrides --region us-west-2 \
  --query 'Environment.Variables.DISCOUNT_RESOLVER_FN'

BBG_LOCAL=1 npx cdk deploy 'DevAppStage/Api-us-west-2'
```

Then force a resolve now:

```bash
aws lambda invoke --function-name dev-bbg-org-discount-resolver \
  --invocation-type RequestResponse --region us-west-2 /tmp/out.json && cat /tmp/out.json
```

### Cause 3 — Scheduler didn't fire

```bash
aws scheduler update-schedule --name dev-bbg-org-discount-resolve \
  --state ENABLED --region us-west-2
```

If the schedule was deleted, redeploy `PricingStack` (it owns both the pricing-refresher and resolver schedules):

```bash
BBG_LOCAL=1 npx cdk deploy 'DevAppStage/Pricing-us-west-2'
```

### Cause 4 — Write failures / partial materialization

Re-invoke; the whole run is idempotent and converges. If writes keep failing, check the `Pricing` table for `WriteThrottleEvents` and the resolver's role for `dynamodb:UpdateItem` on that table.

To surgically clear a stale materialization on one account (e.g. while degraded), remove only the materialized fields — never the authored `discountPct`:

```bash
aws dynamodb update-item --table-name dev-bbg-pricing --region us-west-2 \
  --key '{"model":{"S":"discount#123456789012"}}' \
  --update-expression 'REMOVE effectivePct, effectiveScope, effectiveScopeId, effectiveResolvedAt'
```

The meter caches the discount row for 5 minutes per warm container, so allow that long for the change to take effect on the money path.

### Cause 5 — scopeId doesn't match the tree

Re-author the row with the correct `ou-…` / `r-…` / `o-…` id (the API validates the *shape* — `ou-[a-z0-9-]+`, `r-[a-z0-9]+`, `o-[a-z0-9]+` — but cannot validate existence). Delete the bogus row:

```bash
curl -X DELETE "https://<api-url>/admin/pricing/discounts?scope=ou&scopeId=ou-typo-99999999" \
  -H "Authorization: Bearer $JWT"
```

### Cause 6 — Account exclusion working as designed

No action. Confirm intent with the operator. To make the account inherit the OU/org rate again, **delete** its account row (don't set it to some other value):

```bash
curl -X DELETE https://<api-url>/admin/pricing/discounts/123456789012 \
  -H "Authorization: Bearer $JWT"
```

The delete triggers the resolver, which then materializes the inherited rate onto a freshly-created row.

### Cause 7 — Timeout on a large org

Re-invoke (idempotent; it converges over successive runs). If it times out repeatedly, raise `memorySize` from 512MB in `infra/lib/pricing-stack.ts` (faster CPU → faster JSON/SDK work) — the timeout is already 5 min and the walk is I/O-bound on Organizations pagination. Longer term, batch the materialize writes or shard the walk by top-level OU.

## Idempotency / safety notes

- **Safe to re-run any time, as often as you like.** Every write is a keyed `UpdateCommand` on `discount#<accountId>`, so repeated runs converge to the same rows. That's exactly why the API can fire-and-forget an async invoke on every discount write on top of the hourly schedule.
- **Degrade is a no-op, NOT a clear.** Re-read the money note above before assuming a degraded run reverted anything. It didn't.
- **The resolver never touches the authored `discountPct`.** It only writes/removes `effectivePct`, `effectiveScope`, `effectiveScopeId`, `effectiveResolvedAt`. Operator intent is always recoverable from the authored values.
- **It creates account rows that were never authored.** A row with `effectivePct` and **no** `discountPct` is normal — it's an account inheriting an OU/org rate. Don't "clean up" those rows; the next run just recreates them.
- **`resolved` counts successful writes only** (incremented after the `await`, not before), so `OrgDiscountResolved` is a real write count, not an intent count. The gap between the account population and `resolved` shows up as `OrgDiscountResolverWriteFailures`.
- **A single failed write is not fatal.** The loop continues to the next account. This is deliberate: one throttled account shouldn't block re-resolving the other 499.
- **It only reads the `Pricing` table's `discount#` namespace.** Real model rows are untouched, so the resolver and the daily `pricing-refresher` can't clobber each other — and the resolver's `discount#…` rows have no `fetchedAt`, so they're skipped by the refresher's staleness computation.
- **No multiplicative stacking, ever.** Exactly one scope wins per account. If a customer expects "5% org + 3% OU = 8%", that's not the model — author the combined rate at the more specific scope.

## Related runbooks

- [`alarms/org-discount-resolver-degraded.md`](alarms/org-discount-resolver-degraded.md) — the `OrgDiscountResolverDegraded > 0` alarm and its stale-money consequence.
- [`pricing-refresher.md`](pricing-refresher.md) — shares the `Pricing` table (different key namespace) and the `PricingStack` scheduler role.
- [`meter.md`](meter.md) — the hot-path consumer: one cached `GetItem` on `discount#<accountId>`, preferring `effectivePct` over `discountPct`.
- [`api.md`](api.md) — the `/admin/pricing/discounts` surface that authors the rows and fires the on-write trigger.
- See `lambda/src/shared/discounts.ts` for the key format + precedence, and `lambda/src/shared/org-tree.ts` for the tree walk.
