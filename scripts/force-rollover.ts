#!/usr/bin/env tsx
/**
 * Manually invokes the period-rollover Lambda. Useful to demonstrate
 * deny-policy detachment without waiting for the monthly EventBridge cron.
 */
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';

const stagePrefix = process.env.BBG_STAGE_PREFIX ?? 'dev';
const region = process.env.AWS_REGION ?? 'us-west-2';

const main = async (): Promise<void> => {
  const lambda = new LambdaClient({ region });
  const fnName = `${stagePrefix}-bbg-period-rollover`;
  console.log(`[force-rollover] invoking ${fnName} in ${region}`);
  const r = await lambda.send(
    new InvokeCommand({
      FunctionName: fnName,
      Payload: Buffer.from(JSON.stringify({ source: 'force-rollover-script' })),
    }),
  );
  if (r.Payload) {
    console.log('[force-rollover] response:', new TextDecoder().decode(r.Payload));
  }
  if (r.FunctionError) {
    console.error('[force-rollover] function error:', r.FunctionError);
    process.exit(1);
  }
};

void main();
