#!/usr/bin/env tsx
/**
 * End-to-end multi-agent demo. Run AFTER deploying with:
 *   bbg:enableGateway = true
 *   bbg:enableMultiAgent = true
 *
 * The script:
 *   1. Looks up the gateway URL + supervisor agent/alias IDs from CFN
 *      outputs (no hardcoded ARNs).
 *   2. Calls /gateway/agents/{supervisorAgentId} with a Cognito ID token.
 *   3. Prints the assembled supervisor response.
 *   4. Tells you which DDB rows to inspect to see attribution.
 *
 * Usage:
 *   AWS_PROFILE=bbg BBG_STAGE_PREFIX=dev BBG_ID_TOKEN=<jwt> \
 *     npm run -w @bbg/lambda multi-agent-demo
 *
 * The ID token comes from a successful sign-in to the SPA. Easiest way:
 * sign in at the SPA, open DevTools → Application → Cookies →
 * `aws.cognito.identity-id-token-...` (or look in IndexedDB for
 * Amplify's stored tokens).
 */
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { randomUUID } from 'node:crypto';

const stagePrefix = process.env.BBG_STAGE_PREFIX ?? 'dev';
const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-west-2';
const idToken = process.env.BBG_ID_TOKEN;

if (!idToken) {
  console.error(
    '[multi-agent-demo] BBG_ID_TOKEN env var required. Sign in to the SPA, then\n' +
      'copy your ID token from DevTools → Application → Local storage →\n' +
      'CognitoIdentityServiceProvider...idToken.',
  );
  process.exit(1);
}

const cfn = new CloudFormationClient({ region });

const stackOutput = async (stackName: string, key: string): Promise<string> => {
  const r = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
  const v = r.Stacks?.[0]?.Outputs?.find((o) => o.OutputKey === key)?.OutputValue;
  if (!v) throw new Error(`No output ${key} on ${stackName}`);
  return v;
};

const main = async (): Promise<void> => {
  const multiAgentStack = `${stagePrefix}-bbg-multi-agent`;
  const [agentId, aliasId, gatewayUrl] = await Promise.all([
    stackOutput(multiAgentStack, 'SupervisorAgentId'),
    stackOutput(multiAgentStack, 'SupervisorAliasId'),
    stackOutput(multiAgentStack, 'GatewayApiUrl'),
  ]);
  const sessionId = randomUUID();
  const prompt = `Give me a brief on the request-id-join pattern in Bedrock Budget Guard's metering pipeline.`;

  console.log(`[multi-agent-demo] supervisor=${agentId} alias=${aliasId}`);
  console.log(`[multi-agent-demo] gateway=${gatewayUrl}`);
  console.log(`[multi-agent-demo] session=${sessionId}`);
  console.log(`[multi-agent-demo] prompt="${prompt}"`);
  console.log();

  const start = Date.now();
  const resp = await fetch(`${gatewayUrl}/gateway/agents/${agentId}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${idToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      agentAliasId: aliasId,
      sessionId,
      prompt,
    }),
  });
  const elapsed = Date.now() - start;

  const text = await resp.text();
  if (!resp.ok) {
    console.error(`[multi-agent-demo] HTTP ${resp.status} after ${elapsed}ms:`);
    console.error(text);
    process.exit(1);
  }

  const json = JSON.parse(text);
  console.log(`[multi-agent-demo] HTTP 200 in ${elapsed}ms`);
  console.log(`[multi-agent-demo] chunks=${json.chunks} traceEvents=${json.traceEventCount}`);
  console.log();
  console.log('--- supervisor response ---');
  console.log(json.response);
  console.log('---');
  console.log();
  console.log('Attribution to inspect (within ~30s):');
  console.log('  RunningSpend rows for the supervisor + 2 collaborator service roles.');
  console.log('  IdentityCache rows correlating each agent invocation\'s requestId to');
  console.log('    the agent-role principal AND the user\'s sourceIdentity (your email).');
  console.log('  Spend dashboard: filter principal=agent-role to see the chain.');
};

void main().catch((err) => {
  console.error('[multi-agent-demo]', err);
  process.exit(1);
});
