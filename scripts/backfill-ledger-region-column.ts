/**
 * One-shot: backfill the normalized `region` (and `enforced`) fields onto
 * historical ledger JSONL objects so the new spendByRegion report covers
 * data written before the ledger-writer schema change (deployed 2026-06-02).
 *
 * Why this is safe + needed:
 *   - The OLD ledger-writer spread the whole RunningSpend delta row into each
 *     JSONL line, so historical lines already carry the raw cumulative
 *     `region_<code>` attrs (e.g. `region_us_west_2`) — the data is present,
 *     just not in the normalized `region` column the Glue table now expects.
 *   - This script derives `region` from those attrs (the region attr with the
 *     largest value on the line — for single-region lines that's the only one)
 *     and writes it back as a fixed `region` field, plus `enforced: false`.
 *   - It is ADDITIVE: every existing key is preserved; we only add `region` /
 *     `enforced` when absent. Glue's JSON SerDe ignores undeclared columns, so
 *     leaving the raw `region_*` attrs in place is harmless.
 *   - Idempotent: lines that already have a non-empty `region` are left as-is,
 *     so re-runs (and lines written by the NEW writer) are no-ops.
 *
 * NOT backfillable: enforcement. The old writer never captured
 * `enforcementPolicyArn` / `enforcementReason`, so that history does not exist
 * in the ledger. Historical lines get `enforced: false`; the enforcement
 * report only has real data going forward from the schema deploy.
 *
 * Usage:
 *   BBG_STAGE_PREFIX=prod AWS_ACCOUNT_ID=<your-account-id> \
 *     npx tsx scripts/backfill-ledger-region-column.ts --dry-run
 *   BBG_STAGE_PREFIX=prod AWS_ACCOUNT_ID=<your-account-id> \
 *     npx tsx scripts/backfill-ledger-region-column.ts
 */
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

const stage = process.env.BBG_STAGE_PREFIX ?? 'dev';
const region = process.env.AWS_REGION ?? 'us-west-2';
const dryRun = process.argv.includes('--dry-run');

const resolveLedgerBucket = (): string => {
  if (process.env.BBG_LEDGER_BUCKET) return process.env.BBG_LEDGER_BUCKET;
  const acct = process.env.AWS_ACCOUNT_ID;
  if (!acct) throw new Error('Set BBG_LEDGER_BUCKET or AWS_ACCOUNT_ID to derive the bucket name.');
  return `${stage}-bbg-ledger-${acct}-${region}`;
};

const s3 = new S3Client({ region });

/** Derive the source region for a line from its `region_<code>` attrs.
 *  Largest attr wins (single-region lines have exactly one). '' if none. */
const regionForLine = (row: Record<string, unknown>): string => {
  let best = '';
  let bestVal = 0;
  for (const [k, v] of Object.entries(row)) {
    if (!k.startsWith('region_') || typeof v !== 'number') continue;
    if (v > bestVal) {
      bestVal = v;
      best = k.slice('region_'.length).replace(/_/g, '-');
    }
  }
  return best;
};

const main = async (): Promise<void> => {
  const bucket = resolveLedgerBucket();
  console.log(`[${dryRun ? 'DRY-RUN' : 'EXECUTE'}] backfill region column in s3://${bucket}/events/`);

  let continuationToken: string | undefined;
  let objects = 0;
  let objectsRewritten = 0;
  let linesTotal = 0;
  let linesEnriched = 0;
  const regionTally: Record<string, number> = {};

  do {
    const list = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: 'events/', ContinuationToken: continuationToken }),
    );
    for (const obj of list.Contents ?? []) {
      if (!obj.Key || !obj.Key.endsWith('.jsonl')) continue;
      objects += 1;
      const body = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: obj.Key }));
      const text = await body.Body!.transformToString();

      let changed = false;
      const outLines: string[] = [];
      for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        linesTotal += 1;
        let row: Record<string, unknown>;
        try {
          row = JSON.parse(line) as Record<string, unknown>;
        } catch {
          outLines.push(line); // preserve unparseable lines verbatim
          continue;
        }
        const derived = regionForLine(row);
        const hasRegion = typeof row.region === 'string' && row.region !== '';
        // Idempotent: a line is done when its enforcement flag is normalized
        // AND either it already carries a region or there's no region_* attr
        // to derive one from. Re-runs (and new-writer lines) skip here.
        const alreadyDone = row.enforced !== undefined && (hasRegion || !derived);
        if (alreadyDone) {
          outLines.push(JSON.stringify(row));
          continue;
        }
        if (derived && !row.region) {
          row.region = derived;
          regionTally[derived] = (regionTally[derived] ?? 0) + 1;
        }
        // Normalize the enforcement flag too (old lines have none).
        if (row.enforced === undefined) row.enforced = false;
        changed = true;
        linesEnriched += 1;
        outLines.push(JSON.stringify(row));
      }

      if (changed && !dryRun) {
        await s3.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: obj.Key,
            Body: outLines.join('\n') + '\n',
            ContentType: 'application/x-ndjson',
          }),
        );
        objectsRewritten += 1;
      } else if (changed) {
        objectsRewritten += 1; // would-rewrite count in dry-run
      }
    }
    continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (continuationToken);

  console.log(`  scanned ${objects} objects, ${linesTotal} lines`);
  console.log(`  ${dryRun ? 'would enrich' : 'enriched'} ${linesEnriched} lines across ${objectsRewritten} objects`);
  console.log(`  region distribution: ${JSON.stringify(regionTally)}`);
  console.log(dryRun ? '(dry-run — no writes)' : 'done.');
};

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
