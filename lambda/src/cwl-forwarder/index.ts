import { gunzipSync } from 'node:zlib';
import {
  EventBridgeClient,
  PutEventsCommand,
} from '@aws-sdk/client-eventbridge';
import type { CloudWatchLogsEvent } from 'aws-lambda';
import { logger, metrics, MetricUnit } from '../shared/powertools.js';

/**
 * an earlier change Phase 1b: cross-region log forwarder.
 *
 * Lives in each metered region (us-east-1, us-east-2, ...). Subscribes
 * to the local Bedrock invocation LogGroup and emits an EventBridge
 * `bbg.bedrock-invocation` event to the HOME-region default event bus.
 * The home-region meter Lambda has an EventBridge rule that consumes
 * these events and does the actual DDB writes.
 *
 * Why this shape: cross-region IAM grants to a customer-managed KMS
 * key require the role ARN to exist before the policy update — but
 * CDK deploys DataStack (which holds the KMS key) before
 * MeteringStack (which creates the role). Chicken-and-egg. By keeping
 * all DDB / KMS access in the home region and shuttling raw events
 * across via EventBridge, this Lambda only needs `events:PutEvents`
 * on the home-region default bus (account-scoped).
 *
 * The home-region MeteringStack instance still has its own LogGroup
 * → meter direct path (CWL subscription filter to Lambda is
 * same-region only). It does NOT consume cross-region events from
 * itself; only from the metered-region forwarders.
 */

const HOME_REGION = process.env.HOME_REGION!;
const METERED_REGION = process.env.METERED_REGION!;

const eventbridge = new EventBridgeClient({ region: HOME_REGION });

interface CwlDecoded {
  messageType: string;
  logEvents: { message: string; timestamp: number; id: string }[];
}

const decodeCwlEvent = (event: CloudWatchLogsEvent): CwlDecoded => {
  return JSON.parse(
    gunzipSync(Buffer.from(event.awslogs.data, 'base64')).toString('utf8'),
  ) as CwlDecoded;
};

export const handler = async (event: CloudWatchLogsEvent): Promise<void> => {
  const decoded = decodeCwlEvent(event);
  if (decoded.messageType !== 'DATA_MESSAGE') return;
  if (decoded.logEvents.length === 0) return;

  // Batch the inner log events into one PutEvents call.
  // EventBridge limit is 10 entries per call; chunk if needed.
  const batches: typeof decoded.logEvents[] = [];
  const CHUNK = 10;
  for (let i = 0; i < decoded.logEvents.length; i += CHUNK) {
    batches.push(decoded.logEvents.slice(i, i + CHUNK));
  }

  let failed = 0;
  for (const batch of batches) {
    // Read the PutEvents response: a 200 can still carry per-entry failures
    // (FailedEntryCount>0). Silently dropping them loses cross-region spend →
    // under-metering → enforcement never fires. Count only delivered entries
    // and surface the failures on a dedicated metric so the DLQ + alarm can
    // catch a sustained loss.
    const res = await eventbridge.send(
      new PutEventsCommand({
        Entries: batch.map((ev) => ({
          // Default bus in the home region.
          EventBusName: 'default',
          Source: 'bbg.metering',
          DetailType: 'bbg.bedrock-invocation',
          Detail: JSON.stringify({
            sourceRegion: METERED_REGION,
            cwlMessage: ev.message,
            cwlTimestamp: ev.timestamp,
            cwlId: ev.id,
          }),
        })),
      }),
    );
    const failedInBatch = res.FailedEntryCount ?? 0;
    failed += failedInBatch;
    metrics.addMetric('CwlForwarded', MetricUnit.Count, batch.length - failedInBatch);
    if (failedInBatch > 0) {
      metrics.addMetric('CwlForwardFailed', MetricUnit.Count, failedInBatch);
      const reasons = (res.Entries ?? [])
        .filter((e) => e.ErrorCode)
        .map((e) => e.ErrorCode);
      logger.warn('PutEvents partial failure', {
        failedInBatch,
        sourceRegion: METERED_REGION,
        homeRegion: HOME_REGION,
        errorCodes: [...new Set(reasons)],
      });
    }
  }

  logger.info('forwarded CWL events', {
    count: decoded.logEvents.length,
    failed,
    sourceRegion: METERED_REGION,
    homeRegion: HOME_REGION,
  });
  metrics.publishStoredMetrics();

  // Throw on any partial failure so the Lambda retries and, on exhaustion,
  // routes the batch to the DLQ instead of dropping metered spend.
  if (failed > 0) {
    throw new Error(`PutEvents dropped ${failed} of ${decoded.logEvents.length} CWL events`);
  }
};
