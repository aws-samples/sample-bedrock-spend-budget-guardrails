# Runbook: `gateway` (opt-in, default OFF)

## Purpose

**Opt-in attribution proxy** for Bedrock invocations. Disabled by default — the meter does NOT depend on the gateway and direct `InvokeModel` callers must keep working without it. When enabled (`bbg:enableGateway` context flag = `true`), the gateway Lambda backs an HTTP API (`<stage>-bbg-gateway-api`) that proxies `POST /gateway/invoke` (Converse) and `POST /gateway/agents/{agentId}` (InvokeAgent) by performing `sts:AssumeRole` on a dedicated invoke role with **transitive session tags** (`principal`, `email`, `team`) and `sts:SetSourceIdentity` set to the caller's email. The result is that CloudTrail records the human caller even when the underlying Bedrock-Agent runtime fans out to multiple sub-invocations.

## Symptoms

- HTTP 5xx from `/gateway/invoke` or `/gateway/agents/{agentId}` despite a valid JWT.
- HTTP 429 with body `{"error":"Bedrock budget exceeded — deny policy active.", ...}` — the user breached and BBG's enforcement attached a deny policy to the gateway invoke role's principal. This is working as intended.
- HTTP 400 `agentId, agentAliasId, sessionId, prompt required` — caller payload incomplete.
- HTTP 500 with `Bedrock Agent error: ...` from the streaming completion — the agent itself errored mid-stream.
- HTTP 500 with `Bedrock Agent model not ready` — agent still preparing; retry after a few seconds.
- Logs show `AssumeRole returned no credentials` — the invoke role's trust policy doesn't trust the gateway Lambda role, or the role was deleted.
- CloudTrail entries for downstream Bedrock calls show `sourceIdentity` empty or set to `unknown` — session tags or source identity not being applied.

## Likely causes (in order)

1. **Gateway not enabled.** `bbg:enableGateway` defaults to `false`. If the operator hasn't flipped it, neither the Lambda nor the HTTP API exists. `404 NotFound` to the gateway endpoint is expected.
2. **STS AssumeRole denied.** The invoke role's trust policy initially trusts the entire account (`new iam.AccountPrincipal(this.account)`); the comment in `gateway-stack.ts` notes this should be **tightened post-deploy to the gateway Lambda role only**. If the post-deploy tightening was applied incorrectly, the Lambda's role is no longer trusted and AssumeRole fails.

   > **Security note:** account-level trust (`iam.AccountPrincipal(this.account)`) is only a first-run convenience — it lets any principal in the account assume the invoke role until the trust policy is narrowed. Operators SHOULD tighten the trust policy to the specific gateway Lambda execution-role ARN immediately after the first deploy (see "Cause 2 — AssumeRole denied" under Remediation for the exact command). Leaving account-wide trust in place is a permissive window that widens the blast radius of the invoke role.
3. **Caller's IAM principal has a `bbg-deny-*` policy attached.** Working as intended — the deny policy denies `bedrock:InvokeModel` etc. at evaluation time. Surfaces as `AccessDeniedException` with "explicit deny" in the message; gateway returns HTTP 429 with the helpful body.
4. **JWT claims missing `sub` or `email`.** The session-tag builder uses `sub`, `email`, and `custom:team` from the JWT. Missing `sub` makes the `RoleSessionName` malformed; missing `email` falls back to `sub` for `SourceIdentity`. Custom team defaults to `'default'`.
5. **Agent invoke streaming failure.** `InvokeAgentCommand` returns an async iterable; partial errors during streaming (`internalServerException`, `modelNotReadyException`) are translated into thrown errors and 5xx responses.
6. **CORS violation from the SPA.** Gateway HTTP API allows only `http://localhost:5173` by default — production SPA origin must be added to the gateway's `corsPreflight.allowOrigins` or browsers will reject.

## Investigation

```bash
# Is the gateway even deployed? Check the stack list.
aws cloudformation describe-stacks --region us-west-2 \
  --query 'Stacks[?contains(StackName,`Gateway`)].{Name:StackName,Status:StackStatus}'

# Recent gateway invocations.
aws logs tail /aws/lambda/dev-bbg-gateway --since 1h --region us-west-2

# Invoke role + trust policy.
ROLE_ARN=$(aws lambda get-function-configuration --function-name dev-bbg-gateway \
  --region us-west-2 --query 'Environment.Variables.INVOKE_ROLE_ARN' --output text)
ROLE_NAME=$(echo $ROLE_ARN | awk -F/ '{print $NF}')
aws iam get-role --role-name $ROLE_NAME --query 'Role.AssumeRolePolicyDocument'

# What attached policies does the invoke role have? (should grant bedrock:Invoke* + agent-runtime:Invoke*)
aws iam list-role-policies --role-name $ROLE_NAME

# Look for explicit-deny on the calling user's principal.
aws iam list-attached-user-policies --user-name <caller-username>
aws iam list-attached-role-policies --role-name <caller-rolename>
# Anything matching `bbg-deny-*` is BBG enforcement.

# Confirm a CloudTrail event has SourceIdentity + transitive tags set.
aws cloudtrail lookup-events --region us-west-2 \
  --lookup-attributes AttributeKey=EventName,AttributeValue=Converse \
  --max-results 5 \
  --query 'Events[].CloudTrailEvent' --output text \
  | jq -r '.userIdentity | {sourceIdentity, sessionContext: .sessionContext.sessionIssuer.userName}'
```

## Remediation

### Cause 1 — Not enabled

Flip the context flag and deploy:

```bash
# In cdk.json, set "bbg:enableGateway": true at the desired stage.
BBG_LOCAL=1 npx cdk deploy 'DevAppStage/Gateway-us-west-2'
```

The HTTP API URL is in the stack's `GatewayApiUrl` output.

### Cause 2 — AssumeRole denied

Tighten the invoke role's trust policy to the gateway Lambda's execution role:

```bash
GATEWAY_LAMBDA_ROLE=$(aws lambda get-function --function-name dev-bbg-gateway \
  --region us-west-2 --query 'Configuration.Role' --output text)

aws iam update-assume-role-policy --role-name $ROLE_NAME --policy-document "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [{
    \"Effect\": \"Allow\",
    \"Principal\": {\"AWS\": \"$GATEWAY_LAMBDA_ROLE\"},
    \"Action\": [\"sts:AssumeRole\", \"sts:TagSession\", \"sts:SetSourceIdentity\"]
  }]
}"
```

`sts:TagSession` and `sts:SetSourceIdentity` are required — AssumeRole alone is not enough since the gateway calls AssumeRole with `Tags` and `SourceIdentity`.

### Cause 3 — Explicit deny (working as intended)

Direct the user to the BBG My Spend page to see which budget breached. To release:

```bash
# As an admin, release the budget enforcement (detaches + deletes the bbg-deny-* policy).
# principal + target are QUERY params (url-encoded) — NOT path segments.
curl -X POST "https://<api-url>/admin/budget/release?principal=<urlencoded-principal>&target=<urlencoded-target>" \
  -H "Authorization: Bearer $ADMIN_JWT"
```

The next budget period rolls over the 1st of the next month UTC and detaches automatically.

### Cause 4 — Missing JWT claims

Verify the user pool client includes `sub`, `email`, and `custom:team` in the access token claims (or ID token, depending on which the authorizer reads). Check the user's profile:

```bash
aws cognito-idp admin-get-user --user-pool-id $USER_POOL --username <user> \
  --region us-west-2 --query 'UserAttributes'
```

Make sure `email` is set; `custom:team` is optional and defaults to `'default'`.

### Cause 5 — Agent streaming error

Look at the trace events. The handler stores the count in the response and the full traces if `?trace=1` query param is set:

```bash
curl -X POST "https://<gateway-url>/gateway/agents/<agentId>?trace=1" \
  -H "Authorization: Bearer $JWT" \
  -d '{"agentAliasId":"...","sessionId":"...","prompt":"..."}'
```

`modelNotReadyException` is transient — wait 30s and retry. `internalServerException` requires inspecting the agent's prepare / orchestration config in the Bedrock console.

### Cause 6 — CORS

Edit `infra/lib/gateway-stack.ts::corsPreflight.allowOrigins` to include the production SPA origin and redeploy. Or read it from operator-config (e.g. via `bbg:additionalCorsOrigins`).

## Idempotency / safety notes

- **The gateway is OPT-IN and the meter MUST work without it.** Don't refactor the meter to depend on gateway-only data (e.g. session tags). Direct `InvokeModel` callers always work; the gateway is purely an attribution-quality enhancement.
- **Each request triggers a fresh `AssumeRole` (15-minute session).** Not cached. At high QPS, this is wasteful — consider caching credentials per JWT-sub for ~10 minutes if you observe STS rate-limiting (`Throttling` on AssumeRole). Today's volume doesn't warrant it.
- **`SourceIdentity` is set to `claims.email ?? claims.sub`.** Once set on a session, it cannot be changed by downstream AssumeRole calls — this is what makes the attribution propagate through Bedrock Agents' multi-hop invocations. If the email contains characters STS rejects (`SourceIdentity` constraints: `[\w+=,.@-]{2,64}`), AssumeRole will fail. Mitigate by sanitizing in `buildSessionTags`.
- **`InvokeModelCommand` is imported but unused.** The handler currently uses Converse for `/gateway/invoke`. The import is preserved for future raw-invoke flows; the `void InvokeModelCommand` at the bottom of `index.ts` suppresses the unused-import warning.
- **Trace events on agent invokes can be megabytes.** The default response returns `traceEventCount` only; pass `?trace=1` to include the full traces. Don't enable in the SPA by default — your access logs will balloon.
- **Don't widen the invoke role's `Resource: '*'`.** It currently grants the full Bedrock + Bedrock-Agent-Runtime invoke surface, which is fine because BBG enforcement is via the caller's principal-attached deny policy. If you scope the role's actions, you may break legitimate model access.

## Related runbooks

- [`api.md`](api.md) — sibling HTTP API for budgets / spend / users / etc.
- [`notify.md`](notify.md) — sends the user-facing email when a 429 surfaces here.
- See `infra/lib/gateway-stack.ts` for the full deploy wiring.
