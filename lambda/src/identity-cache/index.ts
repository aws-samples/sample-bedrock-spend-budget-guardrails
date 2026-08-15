import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { IAMClient, ListRoleTagsCommand, ListUserTagsCommand } from '@aws-sdk/client-iam';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { EventBridgeEvent } from 'aws-lambda';
import { canonicalize, type CloudTrailUserIdentity } from '../shared/arn.js';
import { ddb, oneHourFromNowEpoch } from '../shared/ddb.js';
import { logger, metrics, MetricUnit } from '../shared/powertools.js';
import { getConfiguredMemoryMb, recordSelfCost } from '../shared/self-cost.js';

const IDENTITY_CACHE_TABLE = process.env.IDENTITY_CACHE_TABLE!;
const PENDING_METER_TABLE = process.env.PENDING_METER_TABLE!;
const AGENT_SESSIONS_TABLE = process.env.AGENT_SESSIONS_TABLE!;
const PRINCIPALS_SEEN_TABLE = process.env.PRINCIPALS_SEEN_TABLE!;

// Distinct-principals directory rolloff: 30 days. Matches the max
// configurable lookback window on the Identities page.
const PRINCIPALS_SEEN_TTL_SECONDS = 30 * 24 * 3600;

const iam = new IAMClient({});
const events = new EventBridgeClient({});

interface CloudTrailDetail {
  eventVersion?: string;
  eventTime?: string;
  eventSource?: string;
  eventName?: string;
  awsRegion?: string;
  requestID?: string;
  userIdentity?: CloudTrailUserIdentity;
  requestParameters?: {
    modelId?: string;
    agentId?: string;
    agentAliasId?: string;
    sessionId?: string;
  };
}

const tagCacheTtlMs = 5 * 60 * 1000;
const tagCache = new Map<string, { tags: Record<string, string>; expiresAt: number }>();

const fetchPrincipalTags = async (arn: string): Promise<Record<string, string>> => {
  const cached = tagCache.get(arn);
  if (cached && cached.expiresAt > Date.now()) return cached.tags;

  const tags: Record<string, string> = {};
  try {
    if (arn.includes(':user/')) {
      const userName = arn.split('/').slice(-1)[0];
      const r = await iam.send(new ListUserTagsCommand({ UserName: userName }));
      for (const t of r.Tags ?? []) if (t.Key && t.Value) tags[t.Key] = t.Value;
    } else if (arn.includes(':role/')) {
      // Role name path strip — IAM ListRoleTags wants the role name, which is
      // the tail segment of the role ARN.
      const roleName = arn.split('/').slice(-1)[0];
      const r = await iam.send(new ListRoleTagsCommand({ RoleName: roleName }));
      for (const t of r.Tags ?? []) if (t.Key && t.Value) tags[t.Key] = t.Value;
    }
  } catch (err) {
    // Forbidden is common for cross-account / SSO-reserved roles.
    logger.debug('IAM tag lookup failed', { arn, err: (err as Error).message });
  }

  tagCache.set(arn, { tags, expiresAt: Date.now() + tagCacheTtlMs });
  return tags;
};

const emitIdentityArrived = async (
  requestId: string,
  principal: string,
  modelId: string | undefined,
): Promise<void> => {
  // Read the PutEvents response: a 200 can still carry a per-entry failure
  // (FailedEntryCount>0). Dropping it silently means the meter never gets the
  // identity-arrived join signal → the metered spend stays unjoined and
  // enforcement never fires for it. Throw so the caller surfaces the failure.
  const res = await events.send(
    new PutEventsCommand({
      Entries: [
        {
          Source: 'bbg.metering',
          DetailType: 'bbg.identity-arrived',
          Detail: JSON.stringify({ requestId, principal, modelId }),
        },
      ],
    }),
  );
  if ((res.FailedEntryCount ?? 0) > 0) {
    const errorCode = res.Entries?.[0]?.ErrorCode;
    throw new Error(`PutEvents identity-arrived failed for ${requestId}: ${errorCode ?? 'unknown'}`);
  }
};

export const handler = async (
  event: EventBridgeEvent<'AWS API Call via CloudTrail', CloudTrailDetail>,
): Promise<{ ok: true }> => {
  const startedAt = Date.now();
  let ddbReads = 0;
  let ddbWrites = 0;

  const detail = event.detail;
  const requestId = detail.requestID;
  if (!requestId) {
    logger.warn('No requestID on CloudTrail event', { eventName: detail.eventName });
    recordSelfCost('identity-cache', Date.now() - startedAt, getConfiguredMemoryMb(), {
      ddbReads,
      ddbWrites,
    });
    metrics.publishStoredMetrics();
    return { ok: true };
  }

  const canonical = canonicalize(detail.userIdentity);
  const principalArnForTags = canonical.principal.replace(/^principal#(agent-role#)?/, '');
  const principalTags = await fetchPrincipalTags(principalArnForTags);

  const sessionTags = detail.userIdentity?.sessionContext?.attributes ?? {};

  // 1. Persist the identity row. Idempotent (Put with NoOp on existing row).
  await ddb.send(
    new PutCommand({
      TableName: IDENTITY_CACHE_TABLE,
      Item: {
        requestId,
        principal: canonical.principal,
        principalType: canonical.principalType,
        principalArn: principalArnForTags,
        principalTags,
        sessionTags,
        sourceIdentity: canonical.sourceIdentity,
        ssoUser: canonical.ssoUser,
        eventTime: detail.eventTime,
        region: detail.awsRegion,
        ttl: oneHourFromNowEpoch(),
      },
    }),
  );
  ddbWrites += 1;

  // 2. Upsert the distinct-principal directory row for the Identities page.
  //    Small table (~10s–1000s of rows), one entry per canonicalized principal.
  //    `firstSeen` is preserved across upserts; `lastSeen` advances on every
  //    event; TTL = lastSeen + 30d so quiet principals roll off naturally.
  const eventTimeIso = detail.eventTime ?? new Date().toISOString();
  const lastSeenEpoch = Math.floor(new Date(eventTimeIso).getTime() / 1000);
  await ddb.send(
    new UpdateCommand({
      TableName: PRINCIPALS_SEEN_TABLE,
      Key: { principal: canonical.principal },
      UpdateExpression:
        'SET firstSeen = if_not_exists(firstSeen, :t), lastSeen = :t, principalType = :pt, principalArn = :pa, ssoUser = :su, #ttl = :ttl',
      ExpressionAttributeValues: {
        ':t': eventTimeIso,
        ':pt': canonical.principalType ?? 'unknown',
        ':pa': principalArnForTags,
        ':su': canonical.ssoUser ?? null,
        ':ttl': lastSeenEpoch + PRINCIPALS_SEEN_TTL_SECONDS,
      },
      ExpressionAttributeNames: { '#ttl': 'ttl' },
    }),
  );
  ddbWrites += 1;

  // 3. Track agent sessions for multi-agent attribution.
  const agentSessionId = detail.requestParameters?.sessionId;
  if (
    detail.eventSource === 'bedrock-agent-runtime.amazonaws.com' &&
    detail.eventName === 'InvokeAgent' &&
    agentSessionId
  ) {
    await ddb.send(
      new UpdateCommand({
        TableName: AGENT_SESSIONS_TABLE,
        Key: { agentSessionId },
        UpdateExpression: 'SET firstSeen = if_not_exists(firstSeen, :t), lastSeen = :t, endUser = if_not_exists(endUser, :u), agentId = :a, #ttl = :ttl',
        ExpressionAttributeValues: {
          ':t': detail.eventTime ?? new Date().toISOString(),
          ':u': canonical.sourceIdentity ?? canonical.ssoUser ?? canonical.principal,
          ':a': detail.requestParameters?.agentId ?? 'unknown',
          ':ttl': oneHourFromNowEpoch() + 24 * 3600 * 7, // keep agent sessions a week
        },
        ExpressionAttributeNames: { '#ttl': 'ttl' },
      }),
    );
    ddbWrites += 1;
  }

  // 4. If a meter event already landed for this requestId, emit
  //    identity-arrived so the meter can complete the join.
  let pendingItem: Record<string, unknown> | undefined;
  try {
    const pending = await ddb.send(
      new GetCommand({ TableName: PENDING_METER_TABLE, Key: { requestId } }),
    );
    ddbReads += 1;
    pendingItem = pending.Item;
  } catch (err) {
    logger.warn('PendingMeter lookup failed', { err: (err as Error).message });
  }
  if (pendingItem) {
    metrics.addMetric('IdentityArrivedAfterMeter', MetricUnit.Count, 1);
  }

  recordSelfCost('identity-cache', Date.now() - startedAt, getConfiguredMemoryMb(), {
    ddbReads,
    ddbWrites,
  });
  metrics.publishStoredMetrics();

  // Emit OUTSIDE the lookup try/catch so a PutEvents partial failure
  // propagates (identity-cache is on the meter DLQ path); swallowing it here
  // would leave the metered spend permanently unjoined.
  if (pendingItem) {
    await emitIdentityArrived(
      requestId,
      canonical.principal,
      pendingItem.modelId as string | undefined,
    );
  }
  return { ok: true };
};
