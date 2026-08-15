# Runbook: `notify`

## Purpose

DynamoDB-stream consumer on `RunningSpend` (separate event source mapping from enforcement) that sends SES emails to the Cognito user mapped to a breached IAM principal at the 50%/80%/100% spend thresholds and on enforcement-just-fired events. Threshold cadence is tracked on the spend row via `lastNotifiedThreshold` (atomic CAS) so retries don't re-send. Admins-group users with `custom:notify_admin_watch=true` receive a fan-out copy of every enforcement event. Deployed alongside enforcement in `<stage>-bbg-notify`.

Recipient resolution (three channels):

- **User-self.** The Cognito user whose `custom:iam_principal` matches the breached principal. adds a secondary email index so an SSO/identity-lens row (`principal#sso-user#<email>`) resolves to that person by their SSO email even though they have no `custom:iam_principal` ARN mapping; those lens rows drive only the user-self channel (the admin-watch copy is suppressed for lens rows since the primary role row already sent it).
- **Admin-watch.** Enforcement-only fan-out to Admins-group users with `custom:notify_admin_watch=true`.
- **Ops-fallback.** When `bbg:notifyOpsFallbackAddress` is configured, a principal that maps to NO Cognito human (an IAM role, or an IAM user with no operator account) still generates both its threshold and enforcement emails — routed to the ops mailbox instead of being silent. Skipped for identity-lens rows and when the ops address was already emailed via another channel. Unset ⇒ legacy behavior (unmapped principals surface only via admin-watch on enforcement).

## Symptoms

- Users report not receiving 50%/80%/100% threshold emails despite breaching budgets — or the inverse, getting duplicate emails for the same threshold.
- Lambda logs `NOTIFY_SENDER_ADDRESS not set; skipping email` — sender address operator-config is missing or empty.
- Lambda logs `no Cognito user matches principal; user-self email skipped` (`NotifyUnmappedPrincipal` metric) — the IAM principal that breached doesn't have a Cognito user with `custom:iam_principal=<that ARN>`.
- SES `MessageRejected` errors in the logs (sender not verified, recipient on suppression list, account in sandbox mode).
- Admin-watch fan-out is silent — no admins receive enforcement copies despite enforcement firing.
- Stream iterator age climbs on the notify event source mapping but enforcement runs cleanly (the two share the table but have independent mappings).

## Likely causes (in order)

1. **`NOTIFY_SENDER_ADDRESS` env var empty.** Sourced from `bbg:notifySenderAddress` operator-config; if the operator hasn't set it (or set it to an unverified SES identity), every send-attempt logs and exits cleanly without sending.
2. **SES sender identity not verified in deploy region.** The SES role policy is wide (`ses:SendEmail` on `*`), but SES itself rejects sends from unverified senders.
3. **SES sandbox mode.** Fresh accounts can only send to verified recipients. All sends to unverified addresses fail with `MessageRejected`.
4. **No Cognito user maps to the breached principal.** Self-channel emails are skipped (logged + `NotifyUnmappedPrincipal` metric). Common when a service role or unmapped IAM user invokes Bedrock. **Mitigation:** set `bbg:notifyOpsFallbackAddress` so these still reach an ops mailbox (`NotifyOpsFallback` metric); without it they surface only via admin-watch on enforcement, and never on threshold-only crossings.
5. **User opted out of the relevant threshold.** Cognito custom attrs `custom:notify_50pct`, `custom:notify_80pct`, `custom:notify_100pct`, `custom:notify_enforcement` (default opt-in: missing → enabled) and `custom:notify_admin_watch` (default opt-out: missing → disabled). Logged as `user opted out of threshold email` / `user opted out of enforcement emails`.
6. **Cache stale.** In-memory cache (5-min TTL) per warm execution context. If a user updates `custom:iam_principal` and a Lambda container is still warm, the old mapping persists for up to 5 minutes.
7. **Event source mapping disabled** (same recovery as ledger-writer). Notify and enforcement are independent mappings, so a notify-only outage doesn't affect enforcement.
8. **Cognito `ListUsers` paginated past throttle.** Pools with thousands of users hit `ListUsers` rate limits during cache rebuild. The function uses `Limit: 60` per page, so a 5000-user pool needs ~84 calls per refresh.
9. **`Admins` group doesn't exist.** Fresh deploy hasn't created the group yet. Code handles `ResourceNotFoundException` by treating as no admins; admin-watch fan-out goes silent.

## Investigation

```bash
# Recent notify activity.
aws logs tail /aws/lambda/dev-bbg-notify --since 1h --region us-west-2

# Notify-specific metrics.
for m in NotifyEmailsSent NotifyThreshold NotifyEnforcement NotifyAdminWatch \
         NotifyOptedOut NotifyUnmappedPrincipal NotifyOpsFallback; do
  echo "=== $m ==="
  aws cloudwatch get-metric-statistics --namespace bbg --metric-name $m \
    --start-time "$(date -u -v-1d +%Y-%m-%dT%H:%M:%S)" \
    --end-time "$(date -u +%Y-%m-%dT%H:%M:%S)" \
    --period 3600 --statistics Sum --region us-west-2 \
    --query 'Datapoints[].[Timestamp,Sum]' --output table
done

# Sender address + verification.
SENDER=$(aws lambda get-function-configuration \
  --function-name dev-bbg-notify --region us-west-2 \
  --query 'Environment.Variables.NOTIFY_SENDER_ADDRESS' --output text)
echo "Sender: $SENDER"
aws sesv2 get-email-identity --email-identity "$SENDER" --region us-west-2 \
  --query '{Verified:VerifiedForSendingStatus, Status:VerificationStatus}'

# SES sandbox state.
aws sesv2 get-account --region us-west-2 \
  --query '{Sandbox:ProductionAccessEnabled, SendingPaused:SendingEnabled}'

# Per-user prefs (replace USERNAME).
USER_POOL=$(aws lambda get-function-configuration \
  --function-name dev-bbg-notify --region us-west-2 \
  --query 'Environment.Variables.USER_POOL_ID' --output text)
aws cognito-idp admin-get-user --user-pool-id $USER_POOL --username <user> \
  --region us-west-2 \
  --query 'UserAttributes[?starts_with(Name,`custom:notify`) || Name==`custom:iam_principal`]'

# How many admin-watch subscribers?
aws cognito-idp list-users-in-group --user-pool-id $USER_POOL --group-name Admins \
  --region us-west-2 --query 'Users[].Attributes[?Name==`email` || Name==`custom:notify_admin_watch`]'

# Inspect the spend row's threshold tracking.
aws dynamodb get-item --table-name dev-bbg-running-spend --region us-west-2 \
  --key '{"principal":{"S":"principal#arn:aws:iam::123:role/foo"},"sk":{"S":"2026-05#model#anthropic.claude-sonnet-4-6"}}'
# Look at lastNotifiedThreshold / enforcementPolicyArn.
```

## Remediation

### Cause 1 — `NOTIFY_SENDER_ADDRESS` empty

Set the operator-config and redeploy `EnforcementStack` (the env var is captured at synth):

```bash
# Update operator-config (it's a JSON SSM parameter).
aws ssm put-parameter --name /bbg/operator-config --type String --overwrite \
  --value "$(aws ssm get-parameter --name /bbg/operator-config \
              --query 'Parameter.Value' --output text \
            | jq '. + {"bbg:notifySenderAddress": "alerts@bbg.example.com"}')"

# Redeploy the stack (the Lambda env var only updates on stack deploy).
BBG_LOCAL=1 npx cdk deploy 'DevAppStage/Enforcement-us-west-2'
```

### Cause 2 — Sender not verified

```bash
aws sesv2 create-email-identity --email-identity alerts@bbg.example.com --region us-west-2
# Either reply to the verification email (mailbox-style identity) or set up
# the DKIM CNAMEs from get-email-identity output (domain-style identity).
```

### Cause 3 — SES sandbox

Request production access from the SES console or:

```bash
aws sesv2 put-account-details --region us-west-2 \
  --mail-type TRANSACTIONAL \
  --website-url https://your-app.example.com \
  --use-case-description "BBG transactional alerts to internal Bedrock users" \
  --production-access-enabled
```

Approval is manual and takes ~24h. Until then, verify recipient identities individually.

### Cause 4 — Unmapped IAM principal

Map the user via the admin Users page (`/admin/users/{username}` PUT with `iamPrincipal: "arn:..."`), or via API:

```bash
curl -X PUT https://<api-url>/admin/users/<username> \
  -H "Authorization: Bearer $JWT" \
  -d '{"iamPrincipal": "arn:aws:iam::123:role/foo"}'
```

The cache refreshes within 5 minutes.

### Cause 5 — User opted out

Confirm intent. If the user wants the email back, toggle on via the My Profile page in the SPA, or admin-set:

```bash
curl -X PUT https://<api-url>/admin/users/<username> \
  -H "Authorization: Bearer $JWT" \
  -d '{"notify50pct": true, "notify80pct": true, "notify100pct": true, "notifyEnforcement": true}'
```

Note: the api/users handler stores these as Cognito custom attrs (`custom:notify_50pct`, etc.) as `'true'`/`'false'` strings.

### Cause 6 — Stale cache

The cache rebuilds every 5 minutes. To force a refresh now, bump the function's environment to invalidate the warm container:

```bash
aws lambda update-function-configuration \
  --function-name dev-bbg-notify --region us-west-2 \
  --environment "Variables={...existing...,CACHE_BUMP=$(date +%s)}"
```

(Or just wait 5 minutes — much simpler.)

### Cause 7 — Mapping disabled

```bash
UUID=$(aws lambda list-event-source-mappings \
  --function-name dev-bbg-notify --region us-west-2 \
  --query 'EventSourceMappings[0].UUID' --output text)
aws lambda update-event-source-mapping --uuid $UUID --enabled --region us-west-2
```

### Cause 8 — `ListUsers` throttled

Throttle errors propagate (the cache rebuild has no retry layer). If the pool is large, increase `Limit` from 60 to 200 in `refreshPrincipalEmailMap` (Cognito's documented max). Long-term, replace the in-memory cache with a dedicated DDB GSI on `custom:iam_principal` populated by the `api/users` handler — the comment block at the top of `lambda/src/notify/index.ts` flags this as the upgrade path.

### Cause 9 — Admins group missing

```bash
aws cognito-idp create-group --user-pool-id $USER_POOL --group-name Admins \
  --description "BBG admin users" --region us-west-2
aws cognito-idp admin-add-user-to-group --user-pool-id $USER_POOL \
  --username <admin-user> --group-name Admins --region us-west-2
```

## Idempotency / safety notes

- **`lastNotifiedThreshold` CAS protects against re-sending.** The update uses `ConditionExpression: 'attribute_not_exists(lastNotifiedThreshold) OR lastNotifiedThreshold < :t'` and ignores `ConditionalCheckFailedException`. Stream retries / replays will not re-send a threshold email.
- **Enforcement-just-fired emails have NO de-dup key.** Detection is based on `prevEnforcementPolicyArn` not present + `enforcementPolicyArn` present in the new image. If the same stream record is replayed (rare but possible on a Lambda crash before stream-pointer advance), the user gets the enforcement email twice. We accept this tradeoff because enforcement events are infrequent and a duplicate is preferable to a missed one.
- **Send-to-self dedupe.** Within a single event, the function tracks `sentTo` (lowercased emails) to avoid an admin-watch user who is also the offending-principal user from receiving both copies.
- **The `enabled = false` budget filter in `fetchBudget` returns the row;** the handler then early-exits at `if (!budget || !budget.enabled || budget.limitUsd <= 0) return;`. Disabling a budget stops emails immediately on the next stream event.
- **Don't email admin-watch on threshold crossings.** Threshold emails go to the user only — admin-watch is enforcement-only by design (threshold pings would be noise at org scale). The check is `if (enforcementJustFired && !row.identityLens) { ... admin fan-out ... }` (the `!row.identityLens` guard is an earlier change: lens rows would double-send the admin copy the primary role row already sent). **Exception:** the ops-fallback channel DOES send on threshold crossings, but only for a single configured mailbox and only for principals with no mapped human — it's a targeted backstop, not an org-scale fan-out.
- **The Lambda logs the unhandled exception via `logger.error('notify failed', ...)` and continues to the next record.** A single bad row doesn't poison the batch. The `bisectBatchOnError` and DLQ on the event source provide a second line of defense.

## Related runbooks

- [`pricing-refresher.md`](pricing-refresher.md) — sibling daily; not directly related but shares operator-config patterns.
- See `infra/lib/enforcement-stack.ts` for the deploy-time wiring (notify shares the stack with enforcement and period-rollover).
- See `lambda/src/api/users/index.ts` for the management surface that sets the `custom:notify_*` attrs.
