import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { marshall } from '@aws-sdk/util-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import type { DynamoDBStreamEvent } from 'aws-lambda';
import { beforeEach, describe, expect, it } from 'vitest';

// Set env before importing the handler — index.ts reads LEDGER_BUCKET at
// module-load time.
process.env.LEDGER_BUCKET = 'test-ledger-bucket';

const s3Mock = mockClient(S3Client);

const { handler } = await import('../src/ledger-writer/index.js');

/** Build a MODIFY stream record from plain old/new row objects. */
const modifyRecord = (
  next: Record<string, unknown>,
  prev?: Record<string, unknown>,
): DynamoDBStreamEvent['Records'][number] =>
  ({
    eventName: 'MODIFY',
    dynamodb: {
      NewImage: marshall(next),
      ...(prev ? { OldImage: marshall(prev) } : {}),
    },
  }) as unknown as DynamoDBStreamEvent['Records'][number];

/** Run the handler over one record and parse the JSONL lines it wrote. */
const writtenLines = async (
  ...records: DynamoDBStreamEvent['Records'][number][]
): Promise<Array<Record<string, unknown>>> => {
  const r = await handler({ Records: records } as DynamoDBStreamEvent);
  expect(r.written).toBe(records.length);
  const put = s3Mock.commandCalls(PutObjectCommand);
  expect(put).toHaveLength(1);
  const body = put[0].args[0].input.Body as string;
  return body
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
};

const baseRow = {
  sk: '2026-07#model#anthropic.claude-3-5-sonnet-20241022-v2:0',
  period: '2026-07',
  target: 'model#anthropic.claude-3-5-sonnet-20241022-v2:0',
  spendUsd: 1.25,
  inputTokens: 1000,
  outputTokens: 200,
};

beforeEach(() => {
  s3Mock.reset();
  s3Mock.on(PutObjectCommand).resolves({});
});

describe('ledger-writer account attribution (display rule)', () => {
  it('derives the account id from an iam principal ARN', async () => {
    const [line] = await writtenLines(
      modifyRecord({ ...baseRow, principal: 'principal#arn:aws:iam::123456789012:user/alice' }),
    );
    expect(line.account).toBe('123456789012');
  });

  it('derives the account id from an sts (assumed-role) principal ARN', async () => {
    const [line] = await writtenLines(
      modifyRecord({
        ...baseRow,
        principal: 'principal#arn:aws:sts::210987654321:assumed-role/DevRole/session-1',
      }),
    );
    expect(line.account).toBe('210987654321');
  });

  it("emits '(unknown)' for non-ARN principals — never the home account", async () => {
    const [line] = await writtenLines(
      modifyRecord({ ...baseRow, principal: 'principal#api-key:some-opaque-key' }),
    );
    expect(line.account).toBe('(unknown)');
  });

  it('keeps the stable column set (no dynamic region_* attrs) and pairs account with region', async () => {
    const [line] = await writtenLines(
      modifyRecord(
        {
          ...baseRow,
          principal: 'principal#arn:aws:iam::123456789012:user/alice',
          region_us_west_2: 1.25,
        },
        {
          ...baseRow,
          principal: 'principal#arn:aws:iam::123456789012:user/alice',
          spendUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
          region_us_west_2: 0,
        },
      ),
    );
    expect(line.account).toBe('123456789012');
    expect(line.region).toBe('us-west-2');
    // The dynamic attr must not leak into the JSONL — only the normalized columns.
    expect(line).not.toHaveProperty('region_us_west_2');
    expect(line.spendUsd).toBe(1.25);
  });
});
