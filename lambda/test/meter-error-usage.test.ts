import { afterEach, describe, expect, it, vi } from 'vitest';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { handler, type BedrockInvocationLog } from '../src/meter/index.js';
import { ddb } from '../src/shared/ddb.js';
import { logger, metrics } from '../src/shared/powertools.js';

vi.mock('../src/shared/ddb.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/shared/ddb.js')>(),
  ddb: { send: vi.fn(async () => ({})) },
}));

// Metadata shape observed in production: failed Stability Control Structure
// requests have errorCode but no output or token/image counters. IDs anonymized.
const failed: BedrockInvocationLog = {
  schemaType: 'ModelInvocationLog',
  timestamp: '2026-09-11T12:22:34Z',
  requestId: 'failed-image-request',
  modelId: 'arn:aws:bedrock:us-east-1:111122223333:inference-profile/us.stability.stable-image-control-structure-v1:0',
  operation: 'InvokeModel',
  errorCode: 'ServiceUnavailableException',
};
const invoke = (log: BedrockInvocationLog) => handler({
  'detail-type': 'bbg.bedrock-invocation',
  detail: { sourceRegion: 'us-east-1', cwlMessage: JSON.stringify(log) },
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('failed invocation usage classification', () => {
  it.each([
    failed,
    { ...failed, errorCode: undefined, error: { code: 'ServiceUnavailableException' } },
  ])('does not alarm or write spend for an error without usage', async (log) => {
    const metric = vi.spyOn(metrics, 'addMetric');
    const warn = vi.spyOn(logger, 'warn');
    await invoke(log);
    expect(metric.mock.calls.some(([name]) => name === 'MeterUsageMissing')).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    expect(ddb.send).not.toHaveBeenCalled();
  });

  it('retains the missing-usage signal for a successful record with no counters', async () => {
    const metric = vi.spyOn(metrics, 'addMetric');
    await invoke({ ...failed, errorCode: undefined });
    expect(metric.mock.calls.some(([name]) => name === 'MeterUsageMissing')).toBe(true);
    expect(ddb.send).not.toHaveBeenCalled();
  });

  it('preserves nonzero usage on an error record for metering', async () => {
    const error = vi.spyOn(logger, 'error');
    await invoke({ ...failed, input: { inputTokenCount: 12 } });
    const writes = vi.mocked(ddb.send).mock.calls
      .map(([command]) => command)
      .filter((command): command is PutCommand => command instanceof PutCommand);
    expect(writes).toHaveLength(1);
    expect(writes[0].input.Item?.usage.inputTokens).toBe(12);
    expect(writes[0].input.Item?.requestId).toBe(failed.requestId);
    expect(error).not.toHaveBeenCalled();
  });

  it('keeps zero-valued streaming start records quiet', async () => {
    const metric = vi.spyOn(metrics, 'addMetric');
    await invoke({ ...failed, errorCode: undefined, operation: 'ConverseStream',
      input: { inputTokenCount: 0 }, output: { outputTokenCount: 0 } });
    expect(metric.mock.calls.some(([name]) => name === 'MeterUsageMissing')).toBe(false);
    expect(ddb.send).not.toHaveBeenCalled();
  });
});
