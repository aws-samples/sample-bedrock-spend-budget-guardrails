# Operator config (SSM Parameter Store)

BBG keeps account-specific values out of the public repo. The committed `cdk.json` carries repo-wide defaults — feature flags, GitHub repo name, and a **home-region-only** metered-region default (`bbg:meteredRegions: ["us-west-2"]`). Anything that depends on *your* AWS account, your DNS zone, your team's email, or the regions *you* meter lives in a single SSM String parameter that the synth step reads at deploy time and which **overrides** the `cdk.json` defaults. (Every key below can be set in SSM; a value present in SSM wins over the same key in `cdk.json`.)

## Quickstart

1. Author a JSON document with your operator values (see [Schema](#schema)).
2. Write it to SSM in the same account+region as the pipeline:

   ```bash
   aws ssm put-parameter \
     --name /bbg/operator-config \
     --type String \
     --overwrite \
     --value "$(cat <<'EOF'
   {
     "bbg:githubOwner": "your-github-user-or-org",
     "bbg:hostedZoneName": "example.com",
     "bbg:hostedZoneId": "Z0123456789ABCDEFGHIJ",
     "bbg:domainNames": {
       "dev": "bbg-dev.example.com",
       "prod": "bbg.example.com"
     },
     "bbg:cognitoDomainPrefix": {
       "dev": "bbg-<account>-<region>",
       "prod": "prod-bbg-<account>-<region>"
     },
     "bbg:additionalCorsOrigins": [],
     "bbg:alertEmail": "ops@example.com"
   }
   EOF
   )"
   ```

3. Deploy as normal — `infra/bin/app.ts` calls `loadOperatorConfig()` at synth, which fetches the SSM document and pushes each key into CDK context. Existing `node.tryGetContext('bbg:...')` calls keep working unchanged.

## Schema

| Key | Type | Required? | What it does |
|---|---|---|---|
| `bbg:githubOwner` | string | yes | GitHub user or org that owns the repo CodePipeline polls. |
| `bbg:meteredRegions` | string[] | optional, default `["us-west-2"]` | Regions where Bedrock invocations are metered. **First entry = home region** (all control-plane state lives there). Each *additional* region deploys a thin metering stack there **and** makes CDK Pipelines create a cross-region "support" stack (replication bucket + KMS) in it — so **every region listed here must be `cdk bootstrap`-ed before you deploy** (along with `us-east-1`, which always hosts the CloudFront WAF + ACM cert stacks). Overrides the `cdk.json` home-only default. Also editable from the Enrollment UI, which writes it back here. Start home-only and expand once bootstrapped. |
| `bbg:hostedZoneName` | string | yes if using a custom domain | Route53 zone (e.g. `example.com`). |
| `bbg:hostedZoneId` | string | yes if using a custom domain | Route53 zone ID. |
| `bbg:domainNames` | object `{dev, prod}` | yes if using a custom domain | Per-stage subdomains BBG attaches to CloudFront and uses as the WebAuthn relying-party ID. |
| `bbg:cognitoDomainPrefix` | object `{dev, prod}` or string | recommended | Cognito hosted-UI domain prefix per stage. Must be globally unique within the AWS region. Convention: `bbg-<account>-<region>` for dev, `prod-bbg-<account>-<region>` for prod. |
| `bbg:additionalCorsOrigins` | string[] | optional | Extra origins to add to the API CORS allowlist (e.g. the raw `*.cloudfront.net` URL while you wait for the custom domain to resolve). |
| `bbg:alertEmail` | string | optional | Subscribed to the SNS alerts topic so infra alarms (meter unjoined, enforcement errors, canary failure, etc.) page someone. |
| `bbg:disableConfigStack` | boolean | optional | Skip the AWS Config recorder + managed rules in prod. Useful when Control Tower or Security Hub already manages Config in your account. |
| `bbg:spendRetentionMonths` | number | optional, default `13` | Months of `RunningSpend` history retained in DynamoDB (drives each spend row's TTL). Controls how far back the Spend Dashboard / My Budget period selectors can read. `13` = a year + the current month. `0` ⇒ retain forever (no TTL written). The S3 ledger is the permanent archive regardless, so lowering this only bounds the hot DynamoDB store, not the audit trail. |
| `bbg:notifySenderAddress` | string | optional | SES-verified sender address for budget-threshold and enforcement emails sent to the Cognito user mapped to a breached principal. Without it, the notify Lambda no-ops. The address (or its parent domain) must be a verified identity in SES in your deploy region. |
| `bbg:notifyOpsFallbackAddress` | string | optional | **** Ops mailbox that receives budget threshold **and** enforcement emails for principals that map to no Cognito human — IAM roles, or IAM users with no operator account — so unmapped principals aren't silent. Requires `bbg:notifySenderAddress` (ignored without a sender, since SES needs a verified `From`). Emitted as the `NotifyOpsFallback` metric. Unset ⇒ legacy behavior (unmapped principals surface only via admin-watch, and only on enforcement). Sends use the same `From` (`bbg:notifySenderAddress`), so no extra SES verification is needed for the recipient beyond SES sandbox rules. |
| `bbg:pauseEnforcement` | boolean | optional, default `false` | **ENF-2 kill-switch.** When `true`, the enforcement Lambda skips attaching **new** `bbg-deny-*` policies (it logs + emits an `EnforcementPaused` metric and no-ops). Already-attached denies stay put and period-rollover still detaches them normally — this only halts *new* denies (e.g. during an incident where a metering bug is over-denying org-wide). Flipping it is a redeploy (env-flag), so the change is captured in the pipeline audit trail. Pairs with the `${stagePrefix}-bbg-enforcement-applied-rate` alarm, which pages when the attach rate spikes. |
| `bbg:curS3Bucket` | string | required for CUR reconciliation | S3 bucket where your BCM Data Exports CUR 2.0 export delivers Parquet files. Skipping this skips the Glue crawler + the reconciler will report empty (no-op) until set. |
| `bbg:curS3Prefix` | string | optional, defaults to `cur2-iam` | S3 path prefix under `bbg:curS3Bucket` that the export writes into. The Glue crawler scans `s3://<curS3Bucket>/<curS3Prefix>/`. |
| `bbg:curTable` | string | optional, defaults to `data` | Name of the Glue table that the daily crawler creates inside the `${stagePrefix}_bbg_cur` database. Glue defaults to the leaf prefix segment, which is `data` for the standard export layout. Override only if your bucket layout differs. |
| `bbg:enrolledMemberAccounts` | per-stage map `{dev, prod}` of arrays of `{accountId, regions}` (or a flat array applied to every stage) | optional, default `{}` | Multi-account: **external** member accounts (outside this Org). SELF_MANAGED StackSet — **each enrolled account must one-time bootstrap `AWSCloudFormationStackSetExecutionRole`** trusting the home account's `AWSCloudFormationStackSetAdministrationRole` (see [`docs/multi-account-multi-region.md`](multi-account-multi-region.md) § 6.2.1). Same per-stage shape as `bbg:domainNames`. **A given member account must only be enrolled by ONE stage** (role names are not stage-prefixed). Empty list (or stage missing from the map) = no SELF_MANAGED StackSet for that stage. The web app's `/admin/enroll` wizard auto-routes external accounts here; in-Org accounts go to `bbg:enrolledOrgAccounts` instead. |
| `bbg:enrolledOrgAccounts` | per-stage map `{dev, prod}` of arrays of `{accountId, regions}` | optional, default `{}` | Multi-account: **in-Org** member accounts (accounts belonging to the same AWS Organization as the deploy account). SERVICE_MANAGED StackSet with `accountFilterType=INTERSECTION` targeting these specific account IDs at the Org root. **No per-member bootstrap CFN required** — CFN auto-provisions the execution role when StackSets trusted access is enabled. The web app's enroll wizard auto-routes accounts here when their `accountId` appears in the Org tree. |
| `bbg:enrolledOus` | per-stage map of arrays of `{ouId, regions}` | optional, default `{}` | Multi-account: Organizational Unit-targeted enrollment. SERVICE_MANAGED StackSet with `AutoDeployment.Enabled=true` so accounts joining these OUs later auto-receive the BBG member stack within minutes. Removal from an OU detaches the stack (`RetainStacksOnAccountRemoval=false`). Requires the same prereqs as `bbg:enrolledOrgAccounts` plus `cloudformation activate-organizations-access`. |
| `bbg:enrolledWholeOrg` | per-stage map `{dev, prod}` of `{regions, excludeAccountIds?}` (or a flat object applied to every stage) | optional, default `undefined` | Multi-account: **whole-org auto-enrollment**. SERVICE_MANAGED StackSet targeting the Org root with `accountFilterType=DIFFERENCE` excluding the home account (always) + any operator-supplied additional `excludeAccountIds`. `AutoDeployment.Enabled=true` — every account currently in the Org AND every account joining later auto-receives the BBG member stack within ~10 min. **Takes precedence at synth** over `bbg:enrolledOus` and `bbg:enrolledOrgAccounts` (both SERVICE_MANAGED StackSets would race to provision the same `bbg-enforcement` IAM role). When whole-org is set, the per-OU and per-account SERVICE_MANAGED StackSets are silently skipped — operator's selections stay in SSM unchanged and reactivate when whole-org is turned off. The SELF_MANAGED `enrolledMemberAccounts` path is unaffected (external accounts outside the Org). The web app's enroll wizard exposes this as a single Toggle at the top of `/admin/enroll`. |
| `bbg:organizationId` | string `o-xxxxx` | optional, **auto-detected** | AWS Organizations ID. Used in (a) the home-bus EventBusPolicy `aws:PrincipalOrgID` condition when org-wide enrollment is in use, so any account in the Org can `events:PutEvents` to the home bus; and (b) **ENF-1**: the member `bbg-enforcement` role's `AssumeRolePolicyDocument` gains an `aws:PrincipalOrgID` `StringEquals` condition (defence in depth on top of the home-role-ARN allowlist). Auto-detected at synth time via `organizations:DescribeOrganization` when not set — customers don't need to paste their `o-xxxxx` ID. Falls back to undefined when the home account isn't in an Org or lacks Organizations:* perms; when undefined the ENF-1 condition is omitted (synth-time warning) and the trust policy relies on the allowlist alone. |
| `bbg:organizationRootId` | string `r-xxxx` | optional, **auto-detected** | Organizations Root ID, used as the SERVICE_MANAGED StackSet's `OrganizationalUnitIds` when targeting in-Org accounts via `accountFilterType=INTERSECTION`. Auto-detected alongside `bbg:organizationId`. |
| `bbg:createManagementEventsTrail` | boolean | optional, default **`true`** | Whether BBG creates its own multi-region, management-events CloudTrail trail (`<stage>-bbg-mgmt-<region>`) in the home region. This is what makes Bedrock `InvokeModel`/`Converse`/`InvokeAgent` calls reach the default EventBridge bus (as `AWS API Call via CloudTrail`) so `identity-cache` can join them — CloudTrail's free 90-day Event history alone does **not** deliver to EventBridge; a trail logging management events is required. **Set to `false`** if the account/Organization already has a management trail (e.g., AWS Control Tower, an org trail) — a second copy of management events is not free, so you'd be paying twice. When `true`, CloudTrail delivers the first copy of management events at no charge; you pay only trivial S3 storage (7-day expiry). BBG does **not** add data-event selectors to this trail. |

## How it works

`infra/lib/operator-config.ts` calls `ssm:GetParameter /bbg/operator-config`, parses the JSON value, and writes each `bbg:*` key into the CDK App's context. Synth then proceeds normally; the existing `node.tryGetContext()` lookups in `app-stage.ts`, `pipeline-stack.ts`, etc. find their values.

The synth happens in two places, both of which need IAM access to the SSM parameter:

- **Locally** (`BBG_LOCAL=1 cdk deploy`): your shell credentials must include `ssm:GetParameter` on the parameter ARN. Admin-level roles have this by default.
- **In the pipeline** (CodeBuild Synth step): `PipelineStack` grants `ssm:GetParameter` to the synth project's role automatically.

If the parameter is missing the synth still runs — it just warns and proceeds with whatever values are baked into `cdk.json`. Stack construction may then fail downstream with a clearer "set `bbg:githubOwner`" error.

## Overrides

`BBG_OPERATOR_CONFIG_PARAM` env var changes the parameter name (useful for staging multi-tenant variants), and `bbg:operatorConfigSsm` in `cdk.json` controls the param name the pipeline grants its CodeBuild role access to. The two should match.

## Why SSM and not env vars?

CodeBuild env vars work for a flat list of strings, but operator config has nested shapes (`{dev, prod}` maps, arrays). One JSON-encoded SSM param keeps the schema honest and lets local dev + pipeline read identically.

## Why SSM and not `cdk.context.json`?

CDK auto-loads `cdk.context.json` natively, but the file is gitignored — so the pipeline (which only sees what's committed) wouldn't pick up operator values. SSM is the simplest hosted store that's read-accessible to both the pipeline's CodeBuild role and the local deploying user.
