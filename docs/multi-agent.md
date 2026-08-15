# Multi-agent collaboration coverage

[Bedrock Agents multi-agent collaboration](https://docs.aws.amazon.com/bedrock/latest/userguide/agents-multi-agent-collaboration.html) lets a supervisor agent dispatch to collaborator agents, who in turn invoke foundation models. CloudTrail records each hop separately under the agent's service role, not the original end user.

BBG handles this correctly out of the box for **service-role-level enforcement**. Per-end-user attribution requires the optional gateway.

## Direct invocation (no gateway)

When a Cognito user (or anything else) directly calls `bedrock-agent-runtime:InvokeAgent`:

1. CloudTrail records `InvokeAgent` with the calling principal's `userIdentity` and `requestParameters.sessionId` and `requestParameters.agentId`.
2. The supervisor agent's downstream `InvokeModel` calls run under its **service role** — CloudTrail's `userIdentity` for those is `type: AWSService, invokedBy: bedrock.amazonaws.com` with `sessionContext.sessionIssuer.arn = <service-role-arn>`.
3. Same pattern repeats per collaborator.

BBG's `identity-cache` canonicalizes:

- The original `InvokeAgent` caller as their normal principal type (IAM user, role, SSO, etc.).
- Every downstream `InvokeModel` as `principal#agent-role#<service-role-arn>`.

Spend rolls up under each service role. Admins can:

- **Budget the supervisor's role**: cuts the entire chain when breached (deny propagates to collaborators because they all originate from the supervisor's invoke).
- **Budget a specific collaborator's role**: surgical cut to just that capability.

The `AgentSessions` DynamoDB table additionally aggregates per-`agentSessionId` so admins see the full conversation as a unit even though it spans multiple roles.

## Optional gateway pattern (per-end-user attribution)

If you want to charge spend back to the *human* who initiated the conversation:

1. Enable the gateway: `bbg:enableGateway=true` in `cdk.json`. Redeploy.
2. Have your application call `POST /gateway/agents/{agentId}` instead of `bedrock-agent-runtime:InvokeAgent` directly. The user authenticates with their Cognito JWT.
3. The `gateway` Lambda calls `sts:AssumeRole` on `BedrockGatewayInvokeRole` passing **transitive** session tags (`principal=<jwt:sub>`, `email=<jwt:email>`, `team=<custom:team>`) and `sts:SetSourceIdentity=<email>`.
4. Then it calls `bedrock-agent-runtime:InvokeAgent` with the temporary credentials.
5. CloudTrail now records every downstream hop with:
   - `userIdentity.sessionContext.attributes.principalTag/principal=<jwt:sub>` (transitive tags survive role chaining).
   - `userIdentity.sessionContext.sourceIdentity=<email>` (immutable; cannot be modified by intermediate roles).

BBG's `identity-cache` reads these and writes the canonical principal as `principal#sessionTag/principal=<jwt:sub>`. Spend rolls up to the human regardless of which collaborator did the work.

## Why the gateway is opt-in

It changes the call shape (clients must hit our API, not Bedrock directly). For pure-internal Agents tooling that's fine. For Agents that already exist with their own clients, you'd rewrite those clients. The gateway is therefore appropriate for new builds; existing Agents can rely on service-role enforcement until they migrate.

## Multi-agent collaboration roles need `sts:TagSession`

For session tags to propagate through the supervisor → collaborator chain, every agent service role's trust policy must allow `sts:TagSession`. The reference `MultiAgentStack` (`infra/lib/multi-agent-stack.ts`) configures this for the supervisor + collaborators it creates.

## End-to-end demo

`MultiAgentStack` deploys a real supervisor + 2 collaborators:

| Role | Model | Job |
|---|---|---|
| Supervisor | Claude Sonnet 4.6 | Receives the user prompt; delegates to Researcher then Summarizer |
| Researcher | Claude Haiku 4.5 | Returns 2–3 short factual bullets about the topic |
| Summarizer | Claude Haiku 4.5 | Rewrites researcher bullets as an executive briefing |

**Bring it up:**

```bash
# 1. Set both flags in your operator-config (SSM /bbg/operator-config),
#    then push to main to deploy.
# Add to the JSON:
#   "bbg:enableGateway": true,
#   "bbg:enableMultiAgent": true

# 2. Wait for the pipeline to deploy. Stacks created:
#    {stage}-bbg-gateway       — Lambda + HTTP API + JWT authorizer
#    {stage}-bbg-multi-agent   — Supervisor + Researcher + Summarizer + aliases

# 3. Sign in to the web app. Grab your Cognito ID token (DevTools → Application
#    → Local storage → CognitoIdentityServiceProvider...idToken).

# 4. Run the demo:
BBG_STAGE_PREFIX=dev BBG_ID_TOKEN=<jwt> \
  npm run -w @bbg/lambda multi-agent-demo
```

The script:
1. Looks up supervisor agent ID + alias ID + gateway URL from CFN outputs.
2. POSTs `/gateway/agents/<supervisorId>` with the JWT and a sample prompt.
3. The gateway Lambda assumes `BedrockGatewayInvokeRole` with transitive session tags + `sts:SetSourceIdentity=<your-email>`.
4. Bedrock Agents executes Supervisor → Researcher → Summarizer → returns assembled text.
5. The demo prints the response.

**What to inspect after the demo runs (within ~30 seconds):**

- **Spend dashboard** — three new principal rows: `principal#agent-role#<supervisor-role>`, `<researcher-role>`, `<summarizer-role>`. Each has its own `RunningSpend.target=model#anthropic.claude-...` row.
- **Identities page** — three new entries for the agent service roles.
- **CloudTrail** (Console) — every `InvokeModel` from the agent runs carries `sessionContext.sourceIdentity = <your-email>` and `sessionContext.attributes.principalTag/principal = <your-cognito-sub>`. Confirms that BBG's identity-cache will be able to roll the spend up to the human if you've configured a session-tag-keyed budget.
- **AgentSessions table** — one row keyed by the random sessionId from the demo, with `endUser=<your-email>` aggregating all three model-invoke costs.

**Set a budget that triggers enforcement:**

```bash
# Set a $0.05 deny budget on the supervisor's role, then run the demo
# again. Around the third invocation the supervisor's spend will cross
# the limit and BBG will attach a bbg-deny-* policy to the supervisor
# role, which kills the entire chain (collaborators can't be invoked
# without the supervisor).
```

**Tear down:**

```bash
# Flip both flags back to false, push to main. CFN deletes the stacks
# (CDK removes the agents + aliases automatically; no orphans).
```
