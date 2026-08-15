#!/usr/bin/env tsx
/**
 * Reads CloudFormation outputs from a deployed BBG stage and writes
 *  - web/.env.local (consumed by Vite dev server)
 *  - web/public/config.json (deployed alongside the static site)
 *
 * The user's existing AWS CLI credentials are used as-is — no AWS_PROFILE
 * is set inside this script.
 */
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const stagePrefix = process.env.BBG_STAGE_PREFIX ?? 'dev';
const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-west-2';

const stacks = {
  auth: `${stagePrefix}-bbg-auth`,
  api: `${stagePrefix}-bbg-api`,
  web: `${stagePrefix}-bbg-web`,
  gateway: `${stagePrefix}-bbg-gateway`,
};

const PREFERRED_DOMAIN_OUTPUT = 'AppUrl';

interface StackOutputs {
  [key: string]: string;
}

const cfn = new CloudFormationClient({ region });

const fetchOutputs = async (stackName: string): Promise<StackOutputs> => {
  try {
    const r = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
    const outputs = r.Stacks?.[0]?.Outputs ?? [];
    const result: StackOutputs = {};
    for (const o of outputs) {
      if (o.OutputKey && o.OutputValue) result[o.OutputKey] = o.OutputValue;
    }
    return result;
  } catch (err) {
    console.warn('[dump-config] %s not found: %s', stackName, (err as Error).message);
    return {};
  }
};

const main = async (): Promise<void> => {
  const [auth, api, web, gateway] = await Promise.all(
    Object.values(stacks).map(fetchOutputs),
  );

  // Prefer the custom App URL when present; fall back to CloudFront.
  const appUrl = web[PREFERRED_DOMAIN_OUTPUT] ?? web.CloudFrontUrl ?? '';

  const config = {
    region,
    userPoolId: auth.UserPoolId ?? '',
    userPoolClientId: auth.UserPoolClientId ?? '',
    userPoolDomain: auth.UserPoolDomain ?? '',
    apiBaseUrl: api.ApiUrl ?? '',
    gatewayBaseUrl: gateway.GatewayApiUrl ?? '',
    cloudfrontUrl: web.CloudFrontUrl ?? '',
    appUrl,
  };

  const repoRoot = resolve(__dirname, '..');
  const envPath = resolve(repoRoot, 'web', '.env.local');
  const envBody = [
    `VITE_AWS_REGION=${config.region}`,
    `VITE_USER_POOL_ID=${config.userPoolId}`,
    `VITE_USER_POOL_CLIENT_ID=${config.userPoolClientId}`,
    `VITE_USER_POOL_DOMAIN=${config.userPoolDomain}`,
    `VITE_API_BASE_URL=${config.apiBaseUrl}`,
    `VITE_GATEWAY_BASE_URL=${config.gatewayBaseUrl}`,
    '',
  ].join('\n');
  await writeFile(envPath, envBody, 'utf8');

  const publicDir = resolve(repoRoot, 'web', 'public');
  await mkdir(publicDir, { recursive: true });
  await writeFile(resolve(publicDir, 'config.json'), JSON.stringify(config, null, 2), 'utf8');

  console.log('[dump-config] wrote:');
  console.log(`  ${envPath}`);
  console.log(`  ${publicDir}/config.json`);
  console.log('  values:', config);
};

void main();
