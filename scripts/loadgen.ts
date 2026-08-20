#!/usr/bin/env tsx
/**
 * Generates Bedrock InvokeModel traffic from the caller's default AWS
 * credentials. The CloudTrail userIdentity for each call attributes spend
 * to whatever IAM principal you're currently assumed as — so just sign
 * with credentials for the deploy account first, then run this.
 *
 * Usage:
 *   npm run loadgen -- --model us.anthropic.claude-haiku-4-5-20251001-v1:0 --rps 5 --duration 60s
 *   npm run loadgen -- --model us.anthropic.claude-sonnet-4-6 --duration 2m
 */
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';

const parseArgs = (): {
  model: string;
  rps: number;
  durationMs: number;
  region: string;
} => {
  const args = process.argv.slice(2);
  const get = (flag: string, def?: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : def;
  };
  const model = get('--model', 'us.anthropic.claude-haiku-4-5-20251001-v1:0')!;
  const rps = Number(get('--rps', '1'));
  const dur = get('--duration', '30s')!;
  const region = get('--region', process.env.AWS_REGION ?? 'us-west-2')!;
  const durationMs = dur.endsWith('s')
    ? Number(dur.slice(0, -1)) * 1000
    : dur.endsWith('m')
    ? Number(dur.slice(0, -1)) * 60_000
    : Number(dur);
  return { model, rps, durationMs, region };
};

const main = async (): Promise<void> => {
  const { model, rps, durationMs, region } = parseArgs();

  // Use the caller's default credential chain — no .demo-credentials.json,
  // no AWS_PROFILE override. CloudTrail records whichever IAM principal is
  // assumed in this shell.
  const bedrock = new BedrockRuntimeClient({ region });

  const intervalMs = Math.max(1, Math.floor(1000 / rps));
  const stopAt = Date.now() + durationMs;
  let issued = 0;
  let succeeded = 0;
  let failed = 0;

  console.log(`[loadgen] model=${model} rps=${rps} duration=${durationMs}ms region=${region}`);

  while (Date.now() < stopAt) {
    issued++;
    const start = Date.now();
    void bedrock
      .send(
        new ConverseCommand({
          modelId: model,
          messages: [
            { role: 'user', content: [{ text: `Reply with the number ${issued}. Keep it under 10 words.` }] },
          ],
          inferenceConfig: { maxTokens: 50, temperature: 0.1 },
        }),
      )
      .then((r) => {
        succeeded++;
        const tokens = r.usage;
        if (issued % 10 === 0) {
          console.log(
            `[loadgen] #${issued} ok in ${Date.now() - start}ms tokens=${tokens?.inputTokens}/${tokens?.outputTokens}`,
          );
        }
      })
      .catch((err) => {
        failed++;
        const name = (err as { name?: string }).name ?? 'Error';
        const message = (err as Error).message ?? '';
        console.warn(`[loadgen] #${issued} FAIL ${name}: ${message.slice(0, 120)}`);
      });

    await new Promise((res) => setTimeout(res, intervalMs));
  }

  // Drain pending invocations.
  while (succeeded + failed < issued) {
    await new Promise((res) => setTimeout(res, 250));
  }
  console.log(`[loadgen] done: issued=${issued} ok=${succeeded} fail=${failed}`);
};

void main();
