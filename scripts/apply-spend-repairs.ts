#!/usr/bin/env tsx
/**
 * Apply a reviewed, immutable historical repair plan. Default is validation
 * and summary only. Usage: npx tsx scripts/apply-spend-repairs.ts plan.json [--apply]
 *
 * Recovery: rerun the SAME plan. DynamoDB markers prevent duplicate money;
 * deterministic S3 keys prevent duplicate ledger records after a crash.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { correctionTransaction, type SpendCorrection } from '../lambda/src/shared/spend-corrections.js';

interface Plan {
  accountId: string;
  region: string;
  stage: string;
  ledgerBucket: string;
  basis: string;
  corrections: SpendCorrection[];
}

const main = async (): Promise<void> => {
  const file = process.argv[2];
  if (!file) throw new Error('Supply a reviewed repair plan JSON file; --apply is optional.');
  const body = readFileSync(file, 'utf8');
  const digest = createHash('sha256').update(body).digest('hex');
  const plan = JSON.parse(body) as Plan;
  if (!/^\d{12}$/.test(plan.accountId) || !/^[a-z0-9-]+$/.test(plan.stage)
    || !plan.ledgerBucket.startsWith(`${plan.stage}-bbg-ledger-`) || !plan.basis) {
    throw new Error('Invalid account, stage, ledger bucket, or pricing basis');
  }
  const table = `${plan.stage}-bbg-running-spend`;
  const ids = new Set<string>();
  for (const c of plan.corrections) {
    if (ids.has(c.id)) throw new Error('Duplicate correction ID');
    ids.add(c.id);
    correctionTransaction(table, c);
    for (const row of c.ledger) {
      if (!String(row.target).startsWith('model#') || row.identityLens
        || !Number.isFinite(row.spendUsd) || !Number.isFinite(Date.parse(String(row.effectiveAt)))) {
        throw new Error('Invalid primary-model ledger correction');
      }
    }
  }
  const usd = plan.corrections.flatMap((c) => c.ledger).reduce((s, l) => s + Number(l.spendUsd), 0);
  console.log(JSON.stringify({ digest, account: plan.accountId, table,
    corrections: plan.corrections.length, primaryUsd: Number(usd.toFixed(6)), basis: plan.basis }));
  if (!process.argv.includes('--apply')) return;

  const identity = await new STSClient({ region: plan.region }).send(new GetCallerIdentityCommand({}));
  if (identity.Account !== plan.accountId) throw new Error('AWS credential account does not match the plan');
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: plan.region }), {
    marshallOptions: { removeUndefinedValues: true },
  });
  const s3 = new S3Client({ region: plan.region });
  const putOnce = async (key: string, content: string): Promise<void> => {
    try {
      await s3.send(new PutObjectCommand({
        Bucket: plan.ledgerBucket, ExpectedBucketOwner: plan.accountId,
        Key: key, Body: content, ContentType: 'application/x-ndjson', IfNoneMatch: '*',
      }));
    } catch (e) {
      if ((e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 412) throw e;
    }
  };
  // Record the complete plan BEFORE changing money. Bucket default KMS applies.
  await putOnce(`repairs/${digest}/plan.json`, body);
  let completed = 0;
  for (const c of plan.corrections) {
    const marked = await Promise.all(c.changes.map(async (r) => {
      const current = await ddb.send(new GetCommand({
        TableName: table, Key: { principal: r.principal, sk: r.sk }, ConsistentRead: true,
      }));
      return (current.Item?.appliedCorrectionIds as Set<string> | undefined)?.has(c.id) ?? false;
    }));
    if (marked.some(Boolean) && !marked.every(Boolean)) throw new Error(`Partial correction ${c.id}; investigate`);
    if (!marked.every(Boolean)) await ddb.send(new TransactWriteCommand(correctionTransaction(table, c)));
    // The stream writer skips this correction only. Emit exact per-request
    // effective times, including when one ARN migration combines several days.
    const now = new Date();
    const ledger = c.ledger.map((row) => ({
      ...row, correctionId: c.id, correctionPlan: digest, recordedAt: now.toISOString(),
    }));
    // Partition from the fixed plan's effective date makes retry keys stable
    // even when recovery runs on another day.
    const fixedDate = c.effectiveAt.slice(0, 10).split('-');
    await putOnce(`events/year=${fixedDate[0]}/month=${fixedDate[1]}/day=${fixedDate[2]}/repair-${c.id}.jsonl`,
      ledger.map((row) => JSON.stringify(row)).join('\n') + '\n');
    completed++;
    if (completed % 50 === 0) console.log(JSON.stringify({ completed, total: plan.corrections.length }));
  }
  await putOnce(`repairs/${digest}/completed.json`, JSON.stringify({ completed, primaryUsd: usd }));
  console.log(JSON.stringify({ completed, primaryUsd: Number(usd.toFixed(6)), audit: `s3://${plan.ledgerBucket}/repairs/${digest}/` }));
};
main().catch((e) => { console.error((e as Error).message); process.exitCode = 1; });
