/**
 * Replay protection must not live on the spend row.
 *
 * The meter used to ADD every requestId to a `processedRequestIds` string set
 * on the RunningSpend row. The set never shrinks, so a busy principal × model ×
 * month row reached DynamoDB's 400 KB item limit after about 11,000 requests.
 * From then on every update failed with "Item size to update has exceeded the
 * maximum allowed size", the meter logged the error, and the spend was lost.
 * Observed on an OpenAI GPT-6 Astra row served through the Responses API:
 * 11,358 request ids, frozen on the second day of the month.
 *
 * Replay protection is now a marker item in MeterDedup, written in the same
 * transaction as the spend update.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { BedrockInvocationLog } from '../src/meter/index.js';
import { ddb } from '../src/shared/ddb.js';
import { logger, metrics } from '../src/shared/powertools.js';

vi.mock('../src/shared/ddb.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/shared/ddb.js')>(),
  ddb: { send: vi.fn() },
}));

process.env.RUNNING_SPEND_TABLE = 'test-bbg-running-spend';
process.env.METER_DEDUP_TABLE = 'test-bbg-meter-dedup';
process.env.IDENTITY_CACHE_TABLE = 'test-bbg-identity-cache';
process.env.PRICING_TABLE = 'test-bbg-pricing';
process.env.BUDGETS_TABLE = 'test-bbg-budgets';
const { handler, dedupKey } = await import('../src/meter/index.js');

const PRINCIPAL = 'principal#arn:aws:iam::111122223333:role/SomeAdminRole';
const PROFILE_ARN = 'arn:aws:bedrock:us-west-2:111122223333:inference-profile/us.openai.gpt-6-astra';

/** Shape of a live `Responses` record for GPT-6 Astra (ids anonymized). */
const astraLog = (requestId: string, modelId = PROFILE_ARN): BedrockInvocationLog => ({
  schemaType: 'ModelInvocationLog',
  timestamp: '2026-11-17T06:46:34Z',
  region: 'us-west-2',
  inferenceRegion: 'us-east-1',
  requestId,
  operation: 'Responses',
  modelId,
  input: { inputTokenCount: 2, cacheReadInputTokenCount: 158_000, cacheWriteInputTokenCount: 3_300 },
  output: { outputTokenCount: 600 },
  identity: { arn: 'arn:aws:sts::111122223333:assumed-role/SomeAdminRole/some-session' },
});

// GPT-6 Astra in-Region rates per 1K tokens, from the model card.
const ASTRA_PRICING = { inputPer1k: 0.011, cacheWritePer1k: 0.01375, cacheReadPer1k: 0.0011, outputPer1k: 0.055 };

const invoke = (log: BedrockInvocationLog) => handler({
  'detail-type': 'bbg.bedrock-invocation',
  detail: { sourceRegion: 'us-west-2', cwlMessage: JSON.stringify(log) },
});

const transactions = () => vi.mocked(ddb.send).mock.calls
  .map(([command]) => command)
  .filter((command): command is TransactWriteCommand => command instanceof TransactWriteCommand);

const cancelled = (...codes: string[]) => Object.assign(new Error('Transaction cancelled'), {
  name: 'TransactionCanceledException',
  CancellationReasons: codes.map((Code) => ({ Code })),
});

let transact: (command: TransactWriteCommand) => Promise<unknown>;

beforeEach(() => {
  transact = async () => ({});
  vi.mocked(ddb.send).mockImplementation((async (command: unknown) => {
    if (command instanceof TransactWriteCommand) return transact(command);
    if (command instanceof GetCommand) {
      const { TableName, Key } = command.input;
      if (TableName === process.env.IDENTITY_CACHE_TABLE) return { Item: { requestId: Key?.requestId, principal: PRINCIPAL } };
      if (TableName === process.env.PRICING_TABLE && Key?.model === 'openai.gpt-6-astra') return { Item: { model: Key.model, ...ASTRA_PRICING } };
    }
    return {};
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('meter replay protection', () => {
  it('commits each row with a conditional marker and never grows a set on the row', async () => {
    await invoke(astraLog('req-1'));
    await invoke(astraLog('req-2'));

    // Two requests × (model row + inference-profile row).
    const writes = transactions();
    expect(writes).toHaveLength(4);
    for (const write of writes) {
      const [marker, spend] = write.input.TransactItems!;
      expect(marker.Put?.TableName).toBe('test-bbg-meter-dedup');
      expect(marker.Put?.ConditionExpression).toBe('attribute_not_exists(id)');
      expect(marker.Put?.Item?.ttl).toBeGreaterThan(Date.now() / 1000);
      expect(spend.Update?.TableName).toBe('test-bbg-running-spend');
      expect(spend.Update?.ConditionExpression).toBeUndefined();
      const expression = spend.Update!.UpdateExpression!;
      expect(expression.split(' SET ')[0]).not.toContain('RequestIds');
      expect(expression).toMatch(/REMOVE processedRequestIds, unpricedRequestIds$/);
      expect(Object.values(spend.Update!.ExpressionAttributeValues!).some((v) => v instanceof Set)).toBe(false);
    }
    const keys = writes.map((w) => w.input.TransactItems![1].Update!.Key);
    expect(keys[0]).toEqual({ principal: PRINCIPAL, sk: 'period#2026-11#target#model#openai.gpt-6-astra' });
    expect(keys[1]).toEqual({ principal: PRINCIPAL, sk: `period#2026-11#target#profile#${PROFILE_ARN}` });
    expect(writes[0].input.TransactItems![0].Put!.Item!.id)
      .toBe(dedupKey(PRINCIPAL, 'period#2026-11#target#model#openai.gpt-6-astra', 'req-1'));
    expect(writes[0].input.TransactItems![1].Update!.ExpressionAttributeValues![':spend']).toBeGreaterThan(0);
  });

  it('meters a bare cross-Region model id the same way', async () => {
    await invoke(astraLog('req-3', 'us.openai.gpt-6-astra'));
    const writes = transactions();
    expect(writes).toHaveLength(1);
    expect(writes[0].input.TransactItems![1].Update!.Key!.sk).toBe('period#2026-11#target#model#openai.gpt-6-astra');
  });

  it('treats an existing marker as a replay and writes nothing else', async () => {
    transact = async () => { throw cancelled('ConditionalCheckFailed', 'None'); };
    const metric = vi.spyOn(metrics, 'addMetric');
    const error = vi.spyOn(logger, 'error');
    await invoke(astraLog('req-1'));
    expect(metric.mock.calls.some(([name]) => name === 'MeterSpendCommitted')).toBe(false);
    expect(error).not.toHaveBeenCalled();
  });

  it('retries a conflict with another writer on the same row', async () => {
    let calls = 0;
    transact = async () => {
      calls++;
      if (calls === 1) throw cancelled('None', 'TransactionConflict');
      return {};
    };
    const metric = vi.spyOn(metrics, 'addMetric');
    await invoke(astraLog('req-1', 'us.openai.gpt-6-astra'));
    expect(calls).toBe(2);
    expect(metric.mock.calls.filter(([name]) => name === 'MeterSpendCommitted')).toHaveLength(1);
  });

  it('reports any other failure instead of treating it as a replay', async () => {
    transact = async () => { throw cancelled('None', 'ValidationError'); };
    const error = vi.spyOn(logger, 'error');
    await invoke(astraLog('req-1', 'us.openai.gpt-6-astra'));
    expect(error).toHaveBeenCalledWith('remote bedrock-invocation processInvocation failed', expect.anything());
  });

  it('keeps metering a model with no price as unpriced usage', async () => {
    await invoke(astraLog('req-4', 'us.openai.gpt-7-astra'));
    const writes = transactions();
    expect(writes).toHaveLength(1);
    const update = writes[0].input.TransactItems![1].Update!;
    expect(update.Key!.sk).toBe('period#2026-11#target#model#openai.gpt-7-astra');
    expect(update.UpdateExpression).toContain('unpricedInvocations :one');
    expect(update.ExpressionAttributeValues![':spend']).toBe(0);
    expect(Object.values(update.ExpressionAttributeNames!)).toContain('usage_cacheReadTokens');
  });
});
