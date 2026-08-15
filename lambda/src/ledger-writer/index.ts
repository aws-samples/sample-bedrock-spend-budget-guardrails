import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { DynamoDBStreamEvent } from 'aws-lambda';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { logger } from '../shared/powertools.js';

const LEDGER_BUCKET = process.env.LEDGER_BUCKET!;

const s3 = new S3Client({});

interface SpendRow {
  principal: string;
  sk: string;
  spendUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  period?: string;
  target?: string;
  lastUpdated?: string;
  // Enforcement stamp (present while a deny policy is attached).
  enforcementPolicyArn?: string;
  enforcementReason?: 'usd' | 'rpm' | 'tpm';
  // identity-lens rows duplicate the primary role row's dollars
  // (per-identity view). They must NOT be written to the permanent S3
  // ledger — Athena/Reports/CUR reconciliation would double-count.
  identityLens?: 'sso-user' | 'source-identity';
  // Per-region cumulative spend lives in dynamic `region_<code>` attrs
  // (e.g. `region_us_west_2`). Indexed access below; not enumerated here.
  [key: string]: unknown;
}

interface OldImage extends SpendRow {}

const partition = (eventTime: Date): { year: string; month: string; day: string } => ({
  year: String(eventTime.getUTCFullYear()),
  month: String(eventTime.getUTCMonth() + 1).padStart(2, '0'),
  day: String(eventTime.getUTCDate()).padStart(2, '0'),
});

/**
 * Which source region this spend delta is attributed to. The meter stores
 * per-region cumulative spend as `region_<code>` attrs (underscores for the
 * region's hyphens, e.g. `region_us_west_2`). The region whose cumulative
 * value grew the most between the old and new images is where this event's
 * spend went — in the common single-invocation case exactly one region attr
 * increases, by the spendUsd delta. Returns '' when no region attr is
 * present (legacy rows that pre-date region attribution).
 */
const regionForDelta = (next: SpendRow, prev: OldImage | undefined): string => {
  let bestRegion = '';
  let bestDelta = 0;
  for (const [k, v] of Object.entries(next)) {
    if (!k.startsWith('region_') || typeof v !== 'number') continue;
    const prevVal = typeof prev?.[k] === 'number' ? (prev[k] as number) : 0;
    const inc = v - prevVal;
    if (inc > bestDelta) {
      bestDelta = inc;
      // region_us_west_2 -> us-west-2
      bestRegion = k.slice('region_'.length).replace(/_/g, '-');
    }
  }
  return bestRegion;
};

/**
 * Display-only account attribution for the ledger. Mirrors
 * `accountForDisplay` in lambda/src/api/spend/index.ts: bucket by the true
 * ARN account — matching both `iam` and `sts` ARNs (federated principals
 * are stored as sts ARNs) — and return '(unknown)' for principals with no
 * account segment. NEVER falls back to the home account (that fallback is
 * the authorization-scope behavior of `accountFromPrincipal`, not display
 * attribution) — a non-ARN principal must not inflate the home account's
 * spend-by-account report.
 */
const accountForDisplay = (principal: string): string => {
  const m = /arn:aws:(?:iam|sts)::(\d+):/.exec(principal);
  return m ? m[1] : '(unknown)';
};

const delta = (next: SpendRow, prev: OldImage | undefined): SpendRow => ({
  ...next,
  spendUsd: (next.spendUsd ?? 0) - (prev?.spendUsd ?? 0),
  inputTokens: (next.inputTokens ?? 0) - (prev?.inputTokens ?? 0),
  outputTokens: (next.outputTokens ?? 0) - (prev?.outputTokens ?? 0),
  // Stable, fixed-name fields for the Glue/Athena schema — derived here so
  // Reports can GROUP BY region / account / filter on enforcement without
  // the table needing to know the dynamic `region_<code>` key set or parse
  // principal ARNs.
  region: regionForDelta(next, prev),
  account: accountForDisplay(next.principal),
  enforced: Boolean(next.enforcementPolicyArn),
  enforcementReason: next.enforcementReason,
});

export const handler = async (event: DynamoDBStreamEvent): Promise<{ written: number }> => {
  const lines: string[] = [];
  for (const record of event.Records) {
    if (record.eventName === 'REMOVE') continue;
    const next = record.dynamodb?.NewImage;
    if (!next) continue;
    const prev = record.dynamodb?.OldImage
      ? (unmarshall(record.dynamodb.OldImage as Record<string, never>) as OldImage)
      : undefined;
    const newRow = unmarshall(next as Record<string, never>) as SpendRow;
    // skip identity-lens rows — the primary role row already carries
    // these dollars to the ledger; writing lens rows too would double-count
    // in Athena / Reports / CUR reconciliation.
    if (newRow.identityLens) continue;
    const d = delta(newRow, prev);
    if ((d.spendUsd ?? 0) === 0 && (d.inputTokens ?? 0) === 0 && (d.outputTokens ?? 0) === 0) continue;
    // Emit an explicit, stable column set (mirrors the Glue table schema in
    // data-stack.ts). We intentionally do NOT spread `...d` — that would
    // leak the dynamic `region_<code>` attrs + the enforcementPolicyArn into
    // the JSONL. region / account / enforced / enforcementReason are the
    // normalized fields Athena queries against.
    lines.push(
      JSON.stringify({
        principal: d.principal,
        sk: d.sk,
        period: d.period,
        target: d.target,
        spendUsd: d.spendUsd,
        inputTokens: d.inputTokens,
        outputTokens: d.outputTokens,
        region: d.region,
        account: d.account,
        enforced: d.enforced,
        enforcementReason: d.enforcementReason,
        lastUpdated: d.lastUpdated,
        recordedAt: new Date().toISOString(),
      }),
    );
  }

  if (lines.length === 0) return { written: 0 };

  const now = new Date();
  const { year, month, day } = partition(now);
  const key = `events/year=${year}/month=${month}/day=${day}/${now.toISOString()}-${Math.random()
    .toString(36)
    .slice(2, 8)}.jsonl`;

  await s3.send(
    new PutObjectCommand({
      Bucket: LEDGER_BUCKET,
      Key: key,
      Body: lines.join('\n') + '\n',
      ContentType: 'application/x-ndjson',
    }),
  );

  logger.info('ledger written', { key, count: lines.length });
  return { written: lines.length };
};
