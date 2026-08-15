#!/usr/bin/env tsx
/**
 * Loads a Lambda handler module from `lambda/src/<name>/index.ts` and runs
 * it with a synthetic event read from a JSON file. Uses the caller's
 * existing AWS credentials so DynamoDB reads/writes go to the deployed
 * tables.
 *
 * Usage:
 *   npx tsx scripts/local-invoke.ts meter test/fixtures/cwl-event.json
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const main = async (): Promise<void> => {
  const [, , handlerName, fixtureRelPath] = process.argv;
  if (!handlerName || !fixtureRelPath) {
    console.error('usage: local-invoke <handlerName> <fixturePath>');
    process.exit(2);
  }

  const repoRoot = resolve(__dirname, '..');
  const handlerEntry = resolve(repoRoot, 'lambda', 'src', handlerName, 'index.ts');
  const fixturePath = resolve(process.cwd(), fixtureRelPath);

  const event = JSON.parse(await readFile(fixturePath, 'utf8'));

  const mod = (await import(pathToFileURL(handlerEntry).href)) as {
    handler: (event: unknown, context: unknown) => Promise<unknown>;
  };

  const fakeContext = {
    awsRequestId: `local-${Date.now()}`,
    functionName: `local-${handlerName}`,
    invokedFunctionArn: `arn:aws:lambda:local::function:${handlerName}`,
    getRemainingTimeInMillis: () => 30_000,
    callbackWaitsForEmptyEventLoop: true,
    functionVersion: '$LATEST',
    memoryLimitInMB: '512',
    logGroupName: `/aws/lambda/local-${handlerName}`,
    logStreamName: `local-${Date.now()}`,
  };

  const result = await mod.handler(event, fakeContext);
  console.log(JSON.stringify(result, null, 2));
};

void main();
