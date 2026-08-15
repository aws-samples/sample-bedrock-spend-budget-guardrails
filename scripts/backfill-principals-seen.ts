/**
 * One-shot backfill for the PrincipalsSeen directory.
 *
 * The PrincipalsSeen table is upserted by the identity-cache Lambda on every
 * new CloudTrail event after deploy. This script seeds it from RunningSpend
 * history so the Identities page's "Last 30 days" preset isn't empty on day 1.
 *
 * Source: RunningSpend.lastUpdated (set every time the meter writes a spend
 * row — i.e. every Bedrock invocation that joined to a CloudTrail identity).
 * It does NOT have ssoUser (the meter doesn't carry it through), so backfill
 * rows have ssoUser=null. Going-forward upserts from identity-cache will fill
 * it in the next time the principal invokes.
 *
 * Usage:
 *   BBG_STAGE_PREFIX=prod npx tsx scripts/backfill-principals-seen.ts
 *   BBG_STAGE_PREFIX=dev  npx tsx scripts/backfill-principals-seen.ts        # default
 *   BBG_STAGE_PREFIX=prod npx tsx scripts/backfill-principals-seen.ts --dry-run
 *
 * Idempotent: uses `if_not_exists(firstSeen, :t)` so re-runs preserve the
 * earliest known firstSeen. lastSeen always advances to the latest.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const stage = process.env.BBG_STAGE_PREFIX ?? 'dev';
const region = process.env.AWS_REGION ?? 'us-west-2';
const dryRun = process.argv.includes('--dry-run');

const RUNNING_SPEND_TABLE = `${stage}-bbg-running-spend`;
const PRINCIPALS_SEEN_TABLE = `${stage}-bbg-principals-seen`;
const PRINCIPALS_SEEN_TTL_SECONDS = 30 * 24 * 3600;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));

interface SpendRow {
  principal: string;
  sk: string;
  lastUpdated?: string;
  period?: string;
}

interface DerivedIdentity {
  principalType: string;
  principalArn: string;
}

/**
 * Reverse-engineer principalType + principalArn from the canonical principal
 * key. Format documented in lambda/src/shared/arn.ts:
 *   principal#<arn>                                     -> IAMUser / IAMRole / Federated / Unknown
 *   principal#arn:aws:iam::ACCT:role/aws-reserved/...   -> SSO
 *   principal#agent-role#<roleArn>                      -> AgentService
 *   principal#sso-user#<email>                          -> SSO (parallel human key)
 */
const deriveIdentity = (canonical: string): DerivedIdentity => {
  const stripped = canonical.replace(/^principal#/, '');
  if (stripped.startsWith('agent-role#')) {
    return { principalType: 'AgentService', principalArn: stripped.replace(/^agent-role#/, '') };
  }
  if (stripped.startsWith('sso-user#')) {
    return { principalType: 'SSO', principalArn: stripped.replace(/^sso-user#/, '') };
  }
  if (stripped.includes('AWSReservedSSO_') || stripped.includes('aws-reserved/sso')) {
    return { principalType: 'SSO', principalArn: stripped };
  }
  if (stripped.includes(':user/')) {
    return { principalType: 'IAMUser', principalArn: stripped };
  }
  if (stripped.includes(':role/') || stripped.includes(':assumed-role/')) {
    return { principalType: 'IAMRole', principalArn: stripped };
  }
  return { principalType: 'Unknown', principalArn: stripped };
};

const main = async (): Promise<void> => {
  console.log(`[${dryRun ? 'DRY-RUN' : 'EXECUTE'}] backfill PrincipalsSeen from RunningSpend in ${stage} (${region})`);
  console.log(`  source: ${RUNNING_SPEND_TABLE}`);
  console.log(`  target: ${PRINCIPALS_SEEN_TABLE}`);
  const cutoffMs = Date.now() - PRINCIPALS_SEEN_TTL_SECONDS * 1000;
  const cutoffIso = new Date(cutoffMs).toISOString();
  console.log(`  cutoff: lastUpdated >= ${cutoffIso} (last 30 days)`);

  // Walk RunningSpend, collecting per-principal min/max lastUpdated.
  const aggregates = new Map<string, { firstSeen: string; lastSeen: string }>();
  let exclusiveStartKey: Record<string, unknown> | undefined;
  let scanned = 0;
  let kept = 0;

  do {
    const r = await ddb.send(
      new ScanCommand({
        TableName: RUNNING_SPEND_TABLE,
        ProjectionExpression: 'principal, sk, lastUpdated, #p',
        ExpressionAttributeNames: { '#p': 'period' },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    for (const row of (r.Items ?? []) as SpendRow[]) {
      scanned += 1;
      if (!row.principal || !row.lastUpdated) continue;
      if (row.lastUpdated < cutoffIso) continue;
      kept += 1;
      const existing = aggregates.get(row.principal);
      if (!existing) {
        aggregates.set(row.principal, { firstSeen: row.lastUpdated, lastSeen: row.lastUpdated });
      } else {
        if (row.lastUpdated < existing.firstSeen) existing.firstSeen = row.lastUpdated;
        if (row.lastUpdated > existing.lastSeen) existing.lastSeen = row.lastUpdated;
      }
    }
    exclusiveStartKey = r.LastEvaluatedKey;
  } while (exclusiveStartKey);

  console.log(`  scanned ${scanned} RunningSpend rows; kept ${kept} within 30d`);
  console.log(`  distinct principals: ${aggregates.size}`);

  if (dryRun) {
    for (const [principal, agg] of aggregates) {
      const id = deriveIdentity(principal);
      console.log(`    ${principal}  type=${id.principalType}  first=${agg.firstSeen}  last=${agg.lastSeen}`);
    }
    return;
  }

  // Upsert each principal. Read-modify-write so existing rows from the
  // live identity-cache merge correctly:
  //   firstSeen -> min(existing, backfill)        (preserve earlier history)
  //   lastSeen  -> max(existing, backfill)        (don't regress live writes)
  //   principalType / principalArn -> keep existing if present
  let upserted = 0;
  let skipped = 0;
  for (const [principal, agg] of aggregates) {
    const { principalType, principalArn } = deriveIdentity(principal);

    const existing = await ddb.send(
      new GetCommand({ TableName: PRINCIPALS_SEEN_TABLE, Key: { principal } }),
    );
    const cur = existing.Item as
      | { firstSeen?: string; lastSeen?: string; principalType?: string; principalArn?: string }
      | undefined;

    const mergedFirstSeen =
      cur?.firstSeen && cur.firstSeen < agg.firstSeen ? cur.firstSeen : agg.firstSeen;
    const mergedLastSeen =
      cur?.lastSeen && cur.lastSeen > agg.lastSeen ? cur.lastSeen : agg.lastSeen;
    const mergedType = cur?.principalType ?? principalType;
    const mergedArn = cur?.principalArn ?? principalArn;
    const lastSeenEpoch = Math.floor(new Date(mergedLastSeen).getTime() / 1000);

    if (
      cur?.firstSeen === mergedFirstSeen &&
      cur?.lastSeen === mergedLastSeen &&
      cur?.principalType === mergedType &&
      cur?.principalArn === mergedArn
    ) {
      skipped += 1;
      continue;
    }

    await ddb.send(
      new UpdateCommand({
        TableName: PRINCIPALS_SEEN_TABLE,
        Key: { principal },
        UpdateExpression:
          'SET firstSeen = :first, lastSeen = :last, principalType = :pt, principalArn = :pa, #ttl = :ttl',
        ExpressionAttributeValues: {
          ':first': mergedFirstSeen,
          ':last': mergedLastSeen,
          ':pt': mergedType,
          ':pa': mergedArn,
          ':ttl': lastSeenEpoch + PRINCIPALS_SEEN_TTL_SECONDS,
        },
        ExpressionAttributeNames: { '#ttl': 'ttl' },
      }),
    );
    upserted += 1;
  }

  console.log(`  upserted ${upserted} PrincipalsSeen rows (${skipped} unchanged)`);
  console.log(`done.`);
};

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
