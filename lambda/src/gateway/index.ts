import {
  BedrockAgentRuntimeClient,
  InvokeAgentCommand,
} from '@aws-sdk/client-bedrock-agent-runtime';
import {
  BedrockRuntimeClient,
  ConverseCommand,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { json, parseBody } from '../shared/api.js';
import { logger } from '../shared/powertools.js';

const INVOKE_ROLE_ARN = process.env.INVOKE_ROLE_ARN!;
const sts = new STSClient({});

interface InvokeRequest {
  modelId?: string;
  prompt?: string;
  agentId?: string;
  agentAliasId?: string;
  sessionId?: string;
}

const buildSessionTags = (claims: Record<string, string | string[]>) => {
  const sub = String(claims.sub ?? 'unknown');
  const email = String(claims.email ?? sub);
  const team = String((claims['custom:team'] as string) ?? 'default');
  return [
    { Key: 'principal', Value: sub },
    { Key: 'email', Value: email },
    { Key: 'team', Value: team },
  ];
};

const assumedClients = async (claims: Record<string, string | string[]>) => {
  const tags = buildSessionTags(claims);
  const r = await sts.send(
    new AssumeRoleCommand({
      RoleArn: INVOKE_ROLE_ARN,
      RoleSessionName: `bbg-${(claims.sub as string).slice(0, 32)}`,
      DurationSeconds: 900,
      Tags: tags,
      TransitiveTagKeys: tags.map((t) => t.Key),
      SourceIdentity: String(claims.email ?? claims.sub),
    }),
  );
  if (!r.Credentials) throw new Error('AssumeRole returned no credentials');
  const creds = {
    accessKeyId: r.Credentials.AccessKeyId!,
    secretAccessKey: r.Credentials.SecretAccessKey!,
    sessionToken: r.Credentials.SessionToken!,
  };
  return {
    bedrock: new BedrockRuntimeClient({ credentials: creds }),
    agent: new BedrockAgentRuntimeClient({ credentials: creds }),
  };
};

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  const claims = event.requestContext.authorizer.jwt.claims as Record<string, string | string[]>;
  const body = parseBody<InvokeRequest>(event);
  if (!body) return json(400, { error: 'Invalid body' });

  const { bedrock, agent } = await assumedClients(claims);
  const route = event.routeKey;

  try {
    if (route === 'POST /gateway/invoke') {
      if (!body.modelId || !body.prompt) {
        return json(400, { error: 'modelId and prompt required' });
      }
      // Prefer Converse for portability.
      const r = await bedrock.send(
        new ConverseCommand({
          modelId: body.modelId,
          messages: [{ role: 'user', content: [{ text: body.prompt }] }],
          inferenceConfig: { maxTokens: 256, temperature: 0.2 },
        }),
      );
      return json(200, {
        response: r.output?.message?.content?.[0]?.text ?? null,
        usage: r.usage,
      });
    }

    if (route === 'POST /gateway/agents/{agentId}') {
      const agentId = event.pathParameters?.agentId;
      if (!agentId || !body.agentAliasId || !body.sessionId || !body.prompt) {
        return json(400, { error: 'agentId, agentAliasId, sessionId, prompt required' });
      }
      const r = await agent.send(
        new InvokeAgentCommand({
          agentId,
          agentAliasId: body.agentAliasId,
          sessionId: body.sessionId,
          inputText: body.prompt,
        }),
      );

      // Consume the streaming completion. Bedrock Agents emits a
      // sequence of events; the `chunk.bytes` events carry the text
      // deltas. Other event types (trace, returnControl) we just
      // record-count for the response so callers can debug.
      let assembled = '';
      let chunkCount = 0;
      const traces: unknown[] = [];
      if (r.completion) {
        for await (const ev of r.completion) {
          if (ev.chunk?.bytes) {
            assembled += new TextDecoder().decode(ev.chunk.bytes);
            chunkCount++;
          }
          if (ev.trace) traces.push(ev.trace);
          if (ev.internalServerException) {
            throw new Error(`Bedrock Agent error: ${ev.internalServerException.message ?? 'unknown'}`);
          }
          if (ev.modelNotReadyException) {
            throw new Error('Bedrock Agent model not ready (still preparing); retry in a few seconds.');
          }
        }
      }

      return json(200, {
        sessionId: r.sessionId,
        contentType: r.contentType,
        response: assembled,
        chunks: chunkCount,
        // Trace events are large; only return the count by default.
        // Pass `?trace=1` if you want to inspect them in the response.
        traceEventCount: traces.length,
        traces:
          event.queryStringParameters?.trace === '1' ? traces : undefined,
      });
    }

    return json(404, { error: `Unknown route: ${route}` });
  } catch (err) {
    logger.error('gateway invocation failed', { err: (err as Error).message });
    if (
      (err as { name?: string }).name === 'AccessDeniedException' &&
      /explicit deny/i.test((err as Error).message ?? '')
    ) {
      return json(429, { error: 'Bedrock budget exceeded — deny policy active.', detail: (err as Error).message });
    }
    return json(500, { error: 'Internal error', detail: (err as Error).message });
  }
};

// InvokeModelCommand is currently unused (Converse is preferred). Kept in
// imports for future raw-invoke flows; suppress unused warning.
void InvokeModelCommand;
