import {
  BedrockClient,
  GetInferenceProfileCommand,
  ListInferenceProfilesCommand,
} from '@aws-sdk/client-bedrock';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../shared/ddb.js';
import { logger } from '../shared/powertools.js';

const INFERENCE_PROFILES_TABLE = process.env.INFERENCE_PROFILES_TABLE!;
const METERED_REGIONS = (process.env.METERED_REGIONS ?? 'us-east-1,us-east-2,us-west-2')
  .split(',')
  .map((r) => r.trim())
  .filter(Boolean);

interface SeenProfile {
  profileArn: string;
  type: 'SYSTEM_DEFINED' | 'APPLICATION';
  modelId: string;
  regions: string[];
  displayName: string;
}

export const handler = async (): Promise<{ refreshed: number }> => {
  const seen = new Map<string, SeenProfile>();

  for (const region of METERED_REGIONS) {
    const bedrock = new BedrockClient({ region });
    let nextToken: string | undefined;
    do {
      const r = await bedrock.send(new ListInferenceProfilesCommand({ nextToken })).catch((err) => {
        logger.warn('ListInferenceProfiles failed', { region, err: (err as Error).message });
        return undefined;
      });
      if (!r) break;
      for (const p of r.inferenceProfileSummaries ?? []) {
        if (!p.inferenceProfileArn || !p.inferenceProfileId) continue;
        const detail = await bedrock
          .send(new GetInferenceProfileCommand({ inferenceProfileIdentifier: p.inferenceProfileId }))
          .catch(() => undefined);
        const modelArn = detail?.models?.[0]?.modelArn ?? '';
        const modelId = modelArn.split('/').slice(-1)[0] ?? '';
        seen.set(p.inferenceProfileArn, {
          profileArn: p.inferenceProfileArn,
          type: (p.type as 'SYSTEM_DEFINED' | 'APPLICATION') ?? 'SYSTEM_DEFINED',
          modelId,
          regions: METERED_REGIONS,
          displayName: p.inferenceProfileName ?? p.inferenceProfileId,
        });
      }
      nextToken = r.nextToken;
    } while (nextToken);
  }

  for (const profile of seen.values()) {
    await ddb.send(
      new PutCommand({
        TableName: INFERENCE_PROFILES_TABLE,
        Item: { ...profile, fetchedAt: new Date().toISOString() },
      }),
    );
  }

  logger.info('inference-profile-refresher complete', { count: seen.size });
  return { refreshed: seen.size };
};
