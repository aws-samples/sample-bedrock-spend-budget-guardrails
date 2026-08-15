# Runbook: Disaster Recovery (DR)

## Overview

Disaster Recovery for Bedrock Budget Guard (BBG) means restoring the spend-metering, budget-enforcement, and audit-ledger data planes after corruption, accidental deletion, or a regional service event — with the smallest acceptable data loss for each plane and a clearly bounded outage. BBG runs two parallel stages, `dev` and `prod`, in a home account (referred to as `<home-account>` in this doc; substitute your account ID). The home region is `us-west-2`; metered regions are `us-west-2`, `us-east-1`, `us-east-2` (configurable via `bbg:meteredRegions`). All control-plane state (DDB tables, Cognito, ledger, audit) lives in the home account + home region; non-home metered regions deploy only a thin `cwl-forwarder` Lambda + EventBridge rule that ships invocation events back to the home-region default bus. **Multi-account installs** also have member-account state — per-member `bbg-enforcement` and `bbg-meter-reader` IAM roles deployed via `MemberStackSetStack` — which must be re-deployed (rather than restored) if a member account is lost; see "Member-account recovery" below.

The blast radius of any home-region DR event is the entire control loop: metering (`RunningSpend`), enforcement (`Budgets` + `bbg-deny-*` IAM policies in home + member accounts), join state (`IdentityCache`, `PendingMeter`), and audit (`LedgerBucket` + Athena). The web tier (CloudFront + S3) and API tier (HTTP API + Lambda) are stateless and rebuild from `git push`. A non-home-region failure (`us-east-1` or `us-east-2`) only loses the in-flight invocation events for that region until forwarders recover; no persistent state is at risk.

The control plane is fully reproducible from source. Every stack is CDK in `infra/lib/*-stack.ts`, deployed by a self-mutating CDK Pipeline (`bbg-pipeline`) sourced from GitHub via a CodeStar Connection. Re-running `BBG_LOCAL=1 cdk deploy` from a clean clone produces an identical infrastructure in minutes. The only operator-specific values live in the SSM parameter `/bbg/operator-config` (see `docs/operator-config.md`), which is itself a single JSON document that can be exported with `aws ssm get-parameter` and re-applied to a fresh account.

The data planes have layered protection: every DynamoDB table has Point-in-Time Recovery (PITR) enabled with a 35-day window and is encrypted with the per-stage CMK `alias/<stage>-bbg-data` (`infra/lib/data-stack.ts`). The `LedgerBucket` is versioned with KMS-CMK encryption and lifecycle tiering to IA → Glacier IR → 730-day expiry. Production stacks use `RemovalPolicy.RETAIN` and `deletionProtection: true` so an accidental `cdk destroy` cannot delete tables, the user pool, or the CMK. The CUR 2.0 export is a one-time setup against the operator's CUR S3 bucket (`bbg:curS3Bucket`, e.g. `<your-cur-bucket>`) and is rebuilt by re-running the daily Glue crawler — no BBG-side restore needed. Substitute your own CUR export bucket (the `bbg:curS3Bucket` operator-config value) for `<your-cur-bucket>` in the commands below.

## RPO / RTO targets per data plane

| Data plane | RPO (acceptable data loss) | RTO (acceptable downtime) | Backup mechanism |
|---|---|---|---|
| Budgets DDB (`prod-bbg-budgets`) | 5 min | 30 min | PITR (35-day window) + ad-hoc on-demand backup before risky migrations |
| RunningSpend DDB (`prod-bbg-running-spend`) | 5 min | 30 min | PITR (35-day window). Stream is best-effort; lost stream events are recoverable from the JSONL ledger in `LedgerBucket`. |
| IdentityCache DDB (`prod-bbg-identity-cache`) | 1 hour | 1 hour | PITR. TTL-bounded (≤ 7 days), so stale-after-restore rows self-evict. |
| Pricing DDB (`prod-bbg-pricing`) | 24 hours | 4 hours | PITR. Daily `pricing-refresher` Lambda re-populates from AWS Pricing API on its own — restore is optional. |
| InferenceProfiles DDB (`prod-bbg-inference-profiles`) | 24 hours | 4 hours | PITR. Daily `inference-profile-refresher` Lambda re-populates from `bedrock:ListInferenceProfiles` — restore is optional. |
| PendingMeter DDB (`prod-bbg-pending-meter`) | 1 hour | 1 hour | PITR. TTL-bounded (≤ 24 hours); stuck rows are drained by `scripts/drain-pending.ts`. |
| AgentSessions DDB (`prod-bbg-agent-sessions`) | 1 hour | 1 hour | PITR. TTL-bounded; sessions short-lived. |
| PasskeyNicknames DDB (`prod-bbg-passkey-nicknames`) | 24 hours | 4 hours | PITR. Cosmetic data (user-chosen nicknames); credential identity itself lives in Cognito. |
| LedgerBucket (`prod-bbg-ledger-<home-account>-us-west-2`) | 0 (versioned writes) | 1 hour | S3 versioning + KMS-CMK + lifecycle to Glacier IR at day 180. |
| AthenaResultsBucket (`prod-bbg-athena-results-<home-account>-us-west-2`) | n/a (regenerable) | 0 | KMS-CMK. Results are query outputs; rerun the query. |
| AccessLogsBucket (`prod-bbg-access-logs-<home-account>-us-west-2`) | 24 hours | 4 hours | S3-managed encryption. 90-day expiry. Audit-only. |
| Web hosting bucket (`prod-bbg-web-<home-account>-us-west-2`) | 0 (regenerable) | 15 min | Recreated from `git push` — `web/dist/` is rebuilt by the pipeline. |
| Cognito User Pool (`prod-bbg`, ID `<home-userpool-id>`) | 24 hours | 8 hours | Manual export (`cognito-idp list-users` → JSON snapshot) on a daily Lambda; passkey credentials must be re-registered after restore. |
| Pipeline state (`bbg-pipeline`) | 0 (source is git) | 30 min | IaC: redeploy `PipelineStack` with `BBG_LOCAL=1 cdk deploy bbg-pipeline`. |
| CUR 2.0 export (`<your-cur-bucket>`/`cur2-iam/`) | 24 hours | 24 hours | Re-trigger Glue crawler (`prod-bbg-cur-crawler`); export itself is owned by the management account. |

**Justification.** `RunningSpend` is the hot table that drives enforcement; an RPO of 5 min keeps lost-spend exposure under any single billing-period threshold worth alarming on. `Budgets` is configured-but-rarely-changed, so 5 min is conservative and matches PITR's effective lower bound. The TTL-bounded join tables (`IdentityCache`, `PendingMeter`, `AgentSessions`) tolerate looser RPO because their content self-heals — replays of CWL events through the meter regenerate identity rows, and stuck pending rows are drained by the existing script. `Pricing` and `InferenceProfiles` get 24h RPO because the daily refresher Lambdas rebuild them automatically; PITR is a backstop, not the primary recovery path. `LedgerBucket` is the audit record-of-truth and gets RPO=0 via S3 versioning. The Cognito User Pool's 24h RPO reflects that user creations are rare and that passkey credentials must be re-registered anyway — there is no AWS-supported export of WebAuthn credential blobs.

## Recovery procedures

### Recovering a single DDB table from PITR

PITR can restore to any second within the 35-day window. The standard pattern: restore to a *new* table name, validate, then either swap or backfill into the live table.

1. Identify the latest known-good timestamp. Cross-reference CloudWatch metrics (`bbg.RunningSpend*`), the `bbg.MeterUnjoined` alarm history, and any operator-initiated change.
2. Restore to a temp table:
   ```bash
   aws dynamodb restore-table-to-point-in-time \
     --source-table-name prod-bbg-running-spend \
     --target-table-name prod-bbg-running-spend-restore-$(date -u +%Y%m%d%H%M) \
     --restore-date-time 2026-05-16T14:00:00Z \
     --region us-west-2
   ```
3. Wait for `TableStatus=ACTIVE` (typically 5–20 min depending on size):
   ```bash
   aws dynamodb describe-table --table-name <restore-table-name> --region us-west-2 \
     --query 'Table.{Status:TableStatus,Items:ItemCount,Size:TableSizeBytes}'
   ```
4. Validate. Compare item count and sample rows against the live table's last-known good snapshot. Schema mismatches are the most common surprise — confirm GSIs (`byTarget` on `Budgets`, `byPeriod` on `RunningSpend`) were re-created.
5. Choose the swap strategy:
   - **Hard cutover** (preferred for `Budgets`): pause writers (disable EventBridge rules + DDB stream consumers), `aws dynamodb delete-table` on the corrupted table, then rename the restore table by recreating with `BatchWriteItem`. Or update env vars (`BUDGETS_TABLE`) on every Lambda to point at the new table. Re-deploy via CDK after recovery to restore the canonical name.
   - **Backfill** (preferred for `RunningSpend`): write a small script that scans the restore table and conditionally writes rows back into the live table only if `lastUpdated` is newer than the live row. Avoids stopping enforcement.
6. Once verified, delete the temp table to stop accruing storage cost.

### Recovering S3 bucket data loss (LedgerBucket)

`LedgerBucket` is versioned. Object deletion places a delete marker rather than removing data.

1. List versions for the affected prefix:
   ```bash
   aws s3api list-object-versions \
     --bucket prod-bbg-ledger-<home-account>-us-west-2 \
     --prefix events/year=2026/month=05/day=16/ \
     --region us-west-2
   ```
2. For each object with a `DeleteMarker`, remove the marker:
   ```bash
   aws s3api delete-object \
     --bucket prod-bbg-ledger-<home-account>-us-west-2 \
     --key events/year=2026/month=05/day=16/<object-key> \
     --version-id <delete-marker-version-id> \
     --region us-west-2
   ```
3. Re-run the affected Athena queries to confirm the partition is queryable again. Partition projection is enabled (no MSCK REPAIR required).
4. If the corruption was a bad write rather than a delete, restore the prior version explicitly:
   ```bash
   aws s3api copy-object \
     --bucket prod-bbg-ledger-<home-account>-us-west-2 \
     --copy-source 'prod-bbg-ledger-<home-account>-us-west-2/<key>?versionId=<good-version-id>' \
     --key '<key>' \
     --region us-west-2
   ```

### Recovering the Cognito User Pool

Cognito has no first-party point-in-time restore. Treat the pool as semi-precious: rebuild from the daily user-export snapshot, then have users re-register passkeys.

1. Locate the most recent export. The recommended pattern (not yet in IaC) is a daily Lambda that runs `cognito-idp list-users --user-pool-id <home-userpool-id>` and writes JSON to `s3://prod-bbg-ledger-.../cognito-export/YYYY-MM-DD/users.json`.
2. If the existing pool is recoverable (deleted users, drifted attributes), repopulate users in place:
   ```bash
   aws cognito-idp admin-create-user \
     --user-pool-id <home-userpool-id> \
     --username <email> \
     --user-attributes Name=email,Value=<email> Name=email_verified,Value=true \
     --message-action SUPPRESS \
     --region us-west-2
   ```
3. If the pool itself was deleted, redeploy `NetworkAndAuthStack` via CDK Pipeline. The new pool will have a new ID — update the `/bbg/operator-config` SSM parameter and bounce the API Lambdas + SPA so they pick up the new issuer URL. Then bulk-import users from the export.
4. Notify users that all passkeys must be re-registered. Cognito does not let you import WebAuthn credentials, and the WebAuthn relying-party ID is bound to the user pool, so credentials from the old pool would not validate even if migrated.
5. Restore custom attributes (`iam_principal`, `notify_*`) per user from the snapshot.

### Recovering from a stuck or rolled-back pipeline

`bbg-pipeline` is itself deployed from CDK, so a broken pipeline can be re-bootstrapped from a clean clone.

1. Confirm the pipeline is broken rather than just slow:
   ```bash
   aws codepipeline get-pipeline-state --name bbg-pipeline --region us-west-2
   ```
2. Refresh local credentials for the home account (whatever your organization's credential-vending flow is).
3. From a clean clone, re-deploy the pipeline stack:
   ```bash
   BBG_LOCAL=1 npx cdk deploy bbg-pipeline --region us-west-2
   ```
4. If the SOURCE stage is failing, the CodeStar Connection has been revoked. Re-authorize at the AWS console (CodeSuite → Settings → Connections), wait for status `AVAILABLE`, then retry the failed source action.
5. If a downstream stage is failing on a CDK rollback, deploy that stack directly to bypass the pipeline while diagnosing:
   ```bash
   BBG_LOCAL=1 npx cdk deploy 'ProdAppStage/Data-us-west-2' --region us-west-2
   ```
   Bypassing CDK Pipelines is OK during recovery; just re-arm the pipeline once the stack is healthy by re-running the failed action.

### Recovering the CUR 2.0 export

The CUR export itself is a *management-account* resource (CUR 2.0 with IAM principal allocation requires the Billing console — see `infra/lib/cur-stack.ts`; BBG never assumes management-account access). BBG only owns the Glue crawler, the Glue database, and the reconciler.

1. If the BBG-side crawler stopped finding data, confirm the export still writes to `s3://<your-cur-bucket>/cur2-iam/`:
   ```bash
   aws s3 ls s3://<your-cur-bucket>/cur2-iam/ --region us-east-1
   ```
2. If the crawler's table schema drifted, force a full re-crawl:
   ```bash
   aws glue start-crawler --name prod-bbg-cur-crawler --region us-west-2
   ```
3. If the export itself was deleted in the management account, re-create it via the Billing console (UI-only `Include caller identity (IAM principal) allocation data` checkbox — see `cur-stack.ts` comments). Once the next daily delivery lands, the BBG crawler picks it up automatically.
4. The reconciler will report `EmptyResults` for any day not yet covered by the export. That is expected for the first 24 hours after a fresh export.

### Whole-region failure (us-west-2 down)

**Out of scope for v1 — BBG is single-region by design.** If `us-west-2` is fully unavailable, BBG metering and enforcement are unavailable for the duration of the outage. There is no automatic failover and no warm replica. The deltas required to make this section actionable would include:

- DDB Global Tables on every metering table (Budgets, RunningSpend, IdentityCache, Pricing, InferenceProfiles, PendingMeter).
- Cross-region S3 replication for `LedgerBucket` to a passive region.
- A second `MeteringStack` deployed to the failover region with EventBridge rules disabled in steady state (warm-passive).
- A user-pool replacement strategy: Cognito User Pools cannot be replicated; the failover region would need its own pool plus a documented user re-registration procedure or a signed-cookie cross-region SSO bridge.
- An updated CDK Pipeline that deploys to both regions and a runbook step to flip CloudFront to the passive API origin.

Until that EPIC ships, the right action during a regional event is to communicate to BBG users that enforcement is paused and Bedrock spend is *not* being metered — Bedrock itself remains available because BBG is observability + enforcement, not an in-line gateway (the optional `gateway-stack.ts` is opt-in and doesn't block calls when bypassed).

## Quarterly DR drill checklist

Run this once per quarter. Block 90 minutes. The point is exercising the path, not stress-testing the data — pick the smallest non-critical table.

- [ ] Restore `prod-bbg-passkey-nicknames` (smallest, lowest risk) from PITR to `prod-bbg-passkey-nicknames-drill-YYYYQN`. Verify item count matches a reference scan from the live table within ±5 rows. Verify schema matches (`userId` PK, `credentialId` SK).
- [ ] Verify S3 versioning is `Enabled` on `prod-bbg-ledger-...`. `aws s3api get-bucket-versioning --bucket prod-bbg-ledger-<home-account>-us-west-2` should return `"Status": "Enabled"`.
- [ ] Verify PITR is `Enabled` on every prod DDB table:
      ```bash
      for t in budgets running-spend identity-cache pricing inference-profiles pending-meter agent-sessions passkey-nicknames; do
        aws dynamodb describe-continuous-backups --table-name prod-bbg-$t --region us-west-2 \
          --query 'ContinuousBackupsDescription.PointInTimeRecoveryDescription.PointInTimeRecoveryStatus'
      done
      ```
      All eight should return `"ENABLED"`.
- [ ] Run `BBG_LOCAL=1 npx cdk synth 'DevAppStage/*'` from a *clean* clone (no node_modules, no cdk.context.json) to confirm IaC reproducibility. The synth should succeed without any prompt for missing context.
- [ ] Confirm the CodeStar Connection is `AVAILABLE`:
      ```bash
      aws codestar-connections get-connection \
        --connection-arn $(aws ssm get-parameter --name /bbg/github-connection-arn --query Parameter.Value --output text --region us-west-2) \
        --region us-west-2 --query 'Connection.ConnectionStatus'
      ```
- [ ] Confirm Cognito User Pool deletion protection is on for prod and that the WebAuthn relying-party ID matches the deployed app domain:
      ```bash
      aws cognito-idp describe-user-pool --user-pool-id <home-userpool-id> --region us-west-2 \
        --query 'UserPool.{DeletionProtection:DeletionProtection,RP:Policies.SignInPolicy,WebAuthnRP:WebAuthnConfiguration}'
      ```
- [ ] Confirm the daily `pricing-refresher` and `inference-profile-refresher` Lambdas have run within the last 36 hours (so a Pricing-table restore is in fact optional). Check the `bbg.PricingRefreshAge` metric.
- [ ] Drop the drill restore table when done: `aws dynamodb delete-table --table-name prod-bbg-passkey-nicknames-drill-YYYYQN --region us-west-2`. Don't leave drill tables accruing storage.

## Backup/restore reference commands

```bash
# Confirm PITR is enabled on a table.
aws dynamodb describe-continuous-backups \
  --table-name prod-bbg-running-spend \
  --region us-west-2 \
  --query 'ContinuousBackupsDescription.PointInTimeRecoveryDescription'

# One-shot on-demand DDB backup before a risky migration.
aws dynamodb create-backup \
  --table-name prod-bbg-budgets \
  --backup-name prod-bbg-budgets-pre-$(date -u +%Y%m%d%H%M) \
  --region us-west-2

# List existing on-demand backups.
aws dynamodb list-backups --table-name prod-bbg-budgets --region us-west-2

# Restore a DDB table to point-in-time.
aws dynamodb restore-table-to-point-in-time \
  --source-table-name prod-bbg-running-spend \
  --target-table-name prod-bbg-running-spend-restore \
  --restore-date-time 2026-05-16T14:00:00Z \
  --region us-west-2

# List S3 object versions (for delete-marker recovery on LedgerBucket).
aws s3api list-object-versions \
  --bucket prod-bbg-ledger-<home-account>-us-west-2 \
  --prefix events/year=2026/month=05/ \
  --region us-west-2

# Snapshot Cognito users (the missing daily backup — run manually if pool drift is suspected).
aws cognito-idp list-users \
  --user-pool-id <home-userpool-id> \
  --region us-west-2 \
  --output json > cognito-users-$(date -u +%Y%m%d).json

# Export the operator config so a fresh-account redeploy is one command.
aws ssm get-parameter --name /bbg/operator-config --with-decryption \
  --region us-west-2 --query 'Parameter.Value' --output text > operator-config.json

# Re-deploy the pipeline from a clean clone (last-resort control-plane recovery).
BBG_LOCAL=1 npx cdk deploy bbg-pipeline --region us-west-2

# Force a CUR Glue crawler re-scan after the export was recreated.
aws glue start-crawler --name prod-bbg-cur-crawler --region us-west-2

# Drain stuck PendingMeter rows after a meter outage (existing repo script).
npx tsx scripts/drain-pending.ts
```

## Escalation

1. **First responder** — the on-call BBG maintainer for your deployment. Pages via the SNS alert topic subscribed to `bbg:alertEmail` from operator-config.
2. **Sibling runbooks to consult before declaring DR**:
   - [`meter-unjoined.md`](meter-unjoined.md) — if `MeterUnjoined > 0` is the symptom, this is almost never DR.
   - `enforcement-errors.md` — if enforcement is failing but data planes are healthy, this is a Lambda or IAM issue, not DR.
   - `pricing-refresh.md` — if `Pricing` is stale, the daily refresher likely just needs a manual invoke; restoring from PITR is overkill.
   - `reconciliation-delta.md` — if CUR drift is the symptom, see CUR procedure above; this is rarely DR.
3. **Escalate to AWS Support** when:
   - PITR returns `RestoreInProgress` for more than 60 minutes on a sub-1GB table (regional service issue).
   - The CodeStar Connection cannot be re-authorized despite a successful console authorization flow.
   - S3 versioning shows expected versions but `GetObject` returns `NoSuchKey` (rare consistency issue worth a Severity 2 case).
   - You suspect the CMK `alias/prod-bbg-data` is impaired — DDB and S3 reads start failing with `KMSAccessDeniedException`. KMS issues require AWS Support; do **not** attempt to delete-and-recreate the key.
4. **Escalate to security/audit** if any restore involves rolling back enforcement state (`bbg-deny-*` policies, `RunningSpend` rows): file a ticket noting the time window and affected principals so the audit trail in `LedgerBucket` can be cross-referenced.

## Related runbooks

- [`meter-unjoined.md`](meter-unjoined.md)
- `enforcement-errors.md` *(written in parallel)*
- `pricing-refresh.md` *(written in parallel)*
- `reconciliation-delta.md` *(written in parallel)*
- `period-rollover.md` *(written in parallel)*
- [`docs/cur-reconciliation.md`](../cur-reconciliation.md) — CUR 2.0 reconciler design
- [`docs/operator-config.md`](../operator-config.md) — the SSM doc you'd re-apply during a fresh-account rebuild
- [`docs/architecture.md`](../architecture.md) — full system reference
