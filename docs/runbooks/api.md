# Runbook: `api/*` (HTTP API + Cognito JWT authorizer)

## Purpose

The BBG admin/user HTTP API. A single API Gateway HTTP API (`<stage>-bbg-api`) with a Cognito JWT authorizer (`HttpJwtAuthorizer`, audience = the user pool's app client) routes to purpose-specific Lambda handlers under `lambda/src/api/*`. Admin routes require admin scope in the JWT (enforced via `requireAdmin()` in `lambda/src/shared/api.ts`); user self-routes use `custom:iam_principal` claim to scope reads to the caller's own data.

**Authorization model (an earlier change/20).** Pre-token-generation V2 Lambda (`lambda/src/pre-token-gen/`) writes a `bbg:scope` claim derived from the user's Cognito group memberships:
- `BBG-Admin-Wildcard` group → `bbg:scope = ["*"]` (super-admin, can read/write across every account)
- `BBG-Admin-<accountId>` group → `bbg:scope = [<accountId>, ...]` (account-scoped admin)
- Legacy `Admins` group is honored via compat fallback as wildcard scope, so single-account installs and in-flight users keep working.

Helpers `callerScope`, `scopeAllows`, `isAdminScope`, `isWildcardScope` in `lambda/src/shared/api.ts` gate every admin endpoint. Read endpoints (`/admin/budgets`, `/admin/spend`, `/admin/identities`, `/admin/agent-sessions`) auto-filter to the caller's scope. Cross-account writes by per-account-scoped admins return 403 + emit a `CrossAccountWriteAudit` Sum metric (CloudWatch namespace `bbg`) and a structured `kind:"audit"` log line via `lambda/src/shared/audit.ts`. Reports + user management + pricing overrides + manifest apply + defaults config remain super-admin only because the underlying state isn't yet partitioned by account.

## Per-route summary

| Route | Handler | Backed by | Notes |
|---|---|---|---|
| `GET /admin/budgets` | budgets | Budgets DDB | Scan all budgets. |
| `POST /admin/budgets` | budgets | Budgets DDB | Create. Auto-prefixes principal with `principal#`. |
| `PUT /admin/budget?principal=&target=` | budgets | Budgets DDB | Update existing. 404 if not present. **principal + target are QUERY params** (not path segments) — both embed an ARN whose `/` breaks HTTP-API path matching. |
| `DELETE /admin/budget?principal=&target=` | budgets | Budgets DDB | Hard delete. Query params (see above). |
| `POST /admin/budget/toggle?principal=&target=` | budgets | Budgets DDB | Flip `enabled`. Query params. |
| `POST /admin/budget/release?principal=&target=` | budgets | Budgets DDB + IAM | Detach + delete the active `bbg-deny-*` policy and clear `enforcementPolicyArn` on the spend row. Query params. |
| `GET /admin/spend` | spend | RunningSpend DDB GSI `byPeriod` | Current-period spend, all principals. |
| `GET /admin/spend/trend` | spend | RunningSpend DDB GSI `byPeriod` | Last N months (1-24, default 6). Sums `model#*` rows only to avoid double-counting profiles. |
| `GET /admin/identities` | identities | IdentityCache DDB | Distinct principals seen, with last `eventTime`. Limit 200. |
| `GET /admin/inference-profiles` | inference-profiles | InferenceProfiles DDB | Read-only listing. |
| `GET /admin/agent-sessions` | agent-sessions | AgentSessions DDB | Read-only listing. |
| `POST /admin/reports/query` | reports | Athena | Allow-listed templates only: `topSpenders`, `spendByModel`, `hourlyToday`, `perPrincipalPerModel`. Returns `executionId`. |
| `GET /admin/reports/{executionId}` | reports | Athena | Polls + returns rows when query succeeds. |
| `GET /admin/users` | users | Cognito | Lists pool users + group memberships. Limit 60 first page. |
| `POST /admin/users` | users | Cognito | Creates user. Auto-generates a Cognito-policy-compliant temp password if not supplied. |
| `GET /admin/users/groups` | users | Cognito | Lists pool groups. |
| `GET /admin/users/{username}` | users | Cognito | Single user detail + groups. |
| `PUT /admin/users/{username}` | users | Cognito | Update user attrs (incl. `custom:notify_*` prefs). |
| `DELETE /admin/users/{username}` | users | Cognito | Hard delete. |
| `PUT /admin/users/{username}/groups` | users | Cognito | Reconcile groups (computes add/remove diff). |
| `POST /admin/users/{username}/disable\|enable` | users | Cognito | Disable/enable login. |
| `POST /admin/users/{username}/reset-password` | users | Cognito | Reset to one-time password. |
| `GET /admin/pricing/overrides` | pricing-overrides | Pricing DDB | Returns the entire Pricing table (overrides + refresher rows). |
| `POST /admin/pricing/overrides` | pricing-overrides | Pricing DDB | Upsert. Synthesizes `dimensions.*Tokens` from legacy `inputPer1k` / `outputPer1k` shorthand. |
| `DELETE /admin/pricing/override?model=` | pricing-overrides | Pricing DDB | Delete a specific override row. **model is a QUERY param** (a model id can contain `/`). |
| `GET /admin/defaults` | budgets | Budgets DDB | Read defaults config sentinel row (`__defaults__`/`__defaults__`). |
| `PUT /admin/defaults` | budgets | Budgets DDB | Write defaults config (master toggle + default amount/window). Super-admin only. |
| `POST /admin/budgets:apply` | budgets | Budgets DDB | Apply a YAML/JSON manifest. Returns `{created, updated, unchanged, removed, defaultsChanged}` for dry-run; idempotent on `commit:true`. Super-admin only. |
| `GET /admin/audit` | audit | CloudWatch Logs Insights | audit log viewer. Queries the admin Lambda log groups for `kind:"audit"` lines. Super-admin only. |
| `GET /admin/org/accounts` | enrollment | Organizations API | Returns the Org tree (accounts + OUs + root) + home account ID + home metered regions. Super-admin only. |
| `GET /admin/org/account/{accountId}` | enrollment | Organizations API | DescribeAccount for a specific Org member. |
| `GET /admin/enrollment/config` | enrollment | SSM `/bbg/operator-config` | Current `enrolledMemberAccounts` + `enrolledOrgAccounts` + `enrolledOus` + `enrolledWholeOrg` for this stage. |
| `POST /admin/enrollment/config` | enrollment | SSM + CodePipeline | Auto-partitions a single picked-accounts list into in-Org (SERVICE_MANAGED) vs external (SELF_MANAGED) using the Org tree, writes back to SSM, triggers a pipeline run. Whole-org takes precedence at synth (no 400 on overlap). |
| `GET /admin/enrollment/status` | enrollment | CloudFormation StackSets | Per-(account, region) instance status across all 4 BBG StackSets, with a `source` field distinguishing External / In-Org account / OU auto-deploy / Whole-org auto-deploy. |
| `GET /admin/enrollment/preflight` | enrollment | Organizations + CFN | preflight: Org detected, StackSets trusted access, CFN organizations-access. Returns per-check status + fix commands. |
| `GET /admin/enrollment/auto-deployment` | enrollment | CloudFormation StackSets | an earlier change/32: returns the OU + whole-org StackSets' `autoDeployment` config (enabled, retainStacksOnAccountRemoval, organizationalUnitIds). Either field is `null` when its StackSet doesn't exist. |
| `GET /me/spend` | spend | RunningSpend DDB | Caller's spend for current period only. Returns `unmapped:true` if the caller has no `custom:iam_principal`. |
| `GET /me/spend/trend` | spend | RunningSpend DDB | Caller's last N months (1-12, default 3). |
| `GET /me/budget` | budgets | Budgets DDB | Budgets where `principal == callerPrincipalKey()`. |
| `GET /me/passkey-nicknames` | passkey-nicknames | PasskeyNicknames DDB | Caller's WebAuthn credential labels. |
| `PUT /me/passkey-nicknames/{credentialId}` | passkey-nicknames | PasskeyNicknames DDB | Set nickname (max 64 chars). |
| `DELETE /me/passkey-nicknames/{credentialId}` | passkey-nicknames | PasskeyNicknames DDB | Remove nickname. |

## Symptoms

- `401 Unauthorized` on any route — JWT missing, expired, wrong audience, or signed by an unexpected issuer.
- `403 Forbidden` on `/admin/*` — JWT valid but `cognito:groups` doesn't include `Admins`.
- `403 Forbidden` on `/me/*` only — caller has no `custom:iam_principal` attribute. Routes return `200` with `unmapped: true` for this case (not 403); a real 403 here means the JWT validation passed but `requireAdmin` was incorrectly added to a self-route.
- `404 NotFound` on a route that should exist — API Gateway routing not deployed (mismatch between code's `routeKey` switch and `infra/lib/api-stack.ts::route()` calls).
- `500` from `budgets` release — IAM detach/delete failed; commonly because the policy was already manually deleted but the spend row's `enforcementPolicyArn` wasn't cleared.
- `500` from `users` POST — `InvalidPasswordException` (returned as `400` with `code: "InvalidPasswordException"`), `UsernameExistsException` (returned as `409`), or genuine Cognito throttling.
- `429 TooManyRequestsException` from any users route — admin Cognito API rate limit (default 5 RPS for AdminGetUser etc.).
- Athena report stuck in `QUEUED`/`RUNNING` indefinitely — workgroup data-scan cap blew, or the query string itself is malformed.

## Likely causes (in order)

1. **Cognito JWT issues.** Token expired, audience mismatch (rotated app client), or the SPA is sending the wrong token (sometimes the ID token where the access token is expected, or vice versa).
2. **Missing or wrong group claim.** `requireAdmin` parses `cognito:groups` as array, comma-separated string, or bracketed-space-separated string (`[Admins Users]`). If your IDP returns yet another shape, admin routes 403.
3. **Cognito throttling (`users` handler).** Admin operations are rate-limited account-wide. Bulk operations (e.g. importing 100 users via the SPA's user-creation form) saturate the quota.
4. **Lambda IAM regression.** `users` needs `cognito-idp:Admin*` on the pool ARN; `pricing-overrides` and `passkey-nicknames` need DDB write; `reports` needs Athena + Glue + S3 read on the ledger bucket. Loss of any results in 500 with the IAM error in the body's `detail`.
5. **DDB conditional check failures.** `budgets` PUT 404s if no existing item — admin tries to update something that was deleted under them.
6. **Athena query template mismatch.** `reports` rejects unknown templates with 400; the SPA must use one of `topSpenders`, `spendByModel`, `hourlyToday`, `perPrincipalPerModel`. Adding a new template requires a code change.
7. **CORS pre-flight failures.** Browser blocks the request before it reaches Lambda. SPA origin missing from `bbg:additionalCorsOrigins` operator-config.
8. **`callerPrincipalKey` returning undefined.** `/me/*` routes return `unmapped: true` instead of an error — UI handles this by prompting the user to ask an admin to map their IAM principal.

## Investigation

```bash
# Tail the right handler's log group (one Lambda per resource).
for h in budgets spend identities inference-profiles agent-sessions pricing-overrides \
         passkey-nicknames reports users; do
  echo "=== $h ==="
  aws logs tail /aws/lambda/dev-bbg-api-$h --since 1h --region us-west-2 --format short
done

# HTTP API access logs (if enabled) — the api-stack doesn't enable them by
# default; check API Gateway's AWS::Logs::LogGroup if you've turned it on.
API_ID=$(aws apigatewayv2 get-apis --region us-west-2 \
  --query "Items[?Name=='dev-bbg-api'].ApiId" --output text)
echo "API ID: $API_ID"

# Inspect the JWT a caller is actually sending (paste into jwt.io or):
echo "<jwt>" | awk -F. '{print $2}' | base64 -d 2>/dev/null | jq

# Cognito group membership.
aws cognito-idp admin-list-groups-for-user \
  --user-pool-id <pool-id> --username <user> --region us-west-2

# Reports — find a stuck query.
aws athena list-query-executions --work-group dev-bbg --region us-west-2 \
  --max-results 10 \
  --query 'QueryExecutionIds[]' --output text \
  | xargs -n1 -I{} aws athena get-query-execution \
      --query-execution-id {} --region us-west-2 \
      --query 'QueryExecution.{Id:QueryExecutionId,State:Status.State,Reason:Status.StateChangeReason}'
```

## Remediation

### JWT/auth (Cause 1, 2)

- Re-login the user (forces token refresh).
- Verify the JWT issuer matches `https://cognito-idp.us-west-2.amazonaws.com/<pool-id>` and audience matches the user pool app client.
- If you rotated the app client recently, redeploy `ApiStack` so the authorizer's audience matches the new client ID.
- For group claims, log the raw value out from `claims['cognito:groups']` once and confirm the shape matches one of the three `requireAdmin` cases. Add a new shape handler if needed.

### Cognito throttling (Cause 3)

The `users` handler does serial `Promise.all` on `AdminListGroupsForUser` per user — for a 100-user pool that's 100 admin calls per page. Mitigations:
- Batch with concurrency limits (e.g. 5 at a time).
- Cache group memberships in DDB and refresh on user mutations only.
- Request a higher Cognito admin-API quota via Service Quotas console.

### Stuck Athena query (Cause 6)

```bash
aws athena stop-query-execution --query-execution-id <id> --region us-west-2
```

Inspect why it's stuck:

```bash
aws athena get-query-execution --query-execution-id <id> --region us-west-2 \
  --query 'QueryExecution.Status'
```

If it's `BytesScannedCutoffPerQuery` exceeded, the templates need partition pruning. The current templates filter on `year = CAST(year(now()) AS varchar)` which prunes annually — for a heavy year you may need month/day filters too.

### Stuck enforcement release (Cause 5 / `budgets` 500)

If the bbg-deny-* policy was manually deleted but the spend row still shows `enforcementPolicyArn`, manually clear it:

```bash
aws dynamodb update-item --table-name dev-bbg-running-spend --region us-west-2 \
  --key '{"principal":{"S":"principal#..."},"sk":{"S":"2026-05#model#..."}}' \
  --update-expression "REMOVE enforcementPolicyArn"
```

### CORS (Cause 7)

Add the production SPA origin to operator-config and redeploy `ApiStack`:

```bash
aws ssm put-parameter --name /bbg/operator-config --type String --overwrite \
  --value "$(aws ssm get-parameter --name /bbg/operator-config \
              --query 'Parameter.Value' --output text \
            | jq '. + {"bbg:additionalCorsOrigins": ["https://bbg.example.com"]}')"
BBG_LOCAL=1 npx cdk deploy 'DevAppStage/Api-us-west-2'
```

### Unmapped `/me/*` user (Cause 8)

Map the user via `PUT /admin/users/{username}` with `iamPrincipal`:

```bash
curl -X PUT https://<api-url>/admin/users/<user> \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -d '{"iamPrincipal": "arn:aws:iam::123:role/foo"}'
```

## Idempotency / safety notes

- **`POST /admin/budgets` is idempotent** — `PutCommand` with the same composite key (`principal`, `target`) overwrites. CreatedAt is set on each call (so successive POSTs reset it).
- **`DELETE /admin/budgets/...` is unconditional.** Doesn't check for a live `enforcementPolicyArn`; if there's an active deny policy, it stays attached. Use the `release` route first, then DELETE.
- **`POST /admin/budget/release?principal=&target=` is destructive (IAM detach + DeletePolicy).** Detaches from every user/role the policy is attached to, deletes non-default versions, then deletes the policy. If the policy doesn't exist, the IAM error is logged and the handler returns 500 — but the spend-row `enforcementPolicyArn` is NOT cleared in that case (intentional; clear it manually as above).
- **`POST /admin/pricing/overrides` overwrites a refresher-written row** for the same modelId. The next pricing refresher run can overwrite the override back. Today this is acceptable because operators set overrides for unpriced models — once the API prices them, the API value wins. If you need overrides to persist, see notes in [`pricing-refresher.md`](pricing-refresher.md).
- **`POST /admin/users` has side effects beyond Cognito.** When `permanent: true`, the temp password is set as the permanent password. When `sendInvite: false`, Cognito's standard invitation email is suppressed and the temp password is returned in the response — log redaction on this is YOUR responsibility, the access log will not redact it for you.
- **`PUT /admin/users/{username}/groups` reconciles** rather than replacing. Computes `add` and `remove` sets, applies both. Safe to retry.
- **`DELETE /admin/users/{username}` is hard delete.** No soft delete / archive; if compliance requires retention, disable the user instead (`POST /admin/users/{username}/disable`).
- **`/me/passkey-nicknames` is per-user-scoped** by `userId = JWT.sub`. There's no admin route — admins cannot list or modify other users' passkey nicknames. By design (passkey nicknames are private mnemonics, not security state).
- **Reports template SQL is module-static** (semgrep allowlist via `Object.prototype.hasOwnProperty.call`). Don't add user-supplied SQL fragments — the SQL injection surface is currently zero and we want to keep it that way.

## Related runbooks

- [`gateway.md`](gateway.md) — sibling HTTP API; opt-in proxy for Bedrock invocations.
- [`notify.md`](notify.md) — consumes the same Cognito user pool the `users` handler manages; updates to `custom:notify_*` here are reflected within 5 minutes.
- [`ledger-writer.md`](ledger-writer.md) — produces the S3 data the `reports` handler queries via Athena.
- [`pricing-refresher.md`](pricing-refresher.md) — `pricing-overrides` writes into the same Pricing DDB table.
