#!/usr/bin/env tsx
/**
 * Sweeps memory configurations across each BBG Lambda using the awslabs
 * Lambda Power Tuning state machine, then writes a "Last run" section to
 * `docs/perf-tuning.md` so the team can compare against prior quarters.
 *
 * The state machine itself is operator-side infra: deploy it once via the
 * SAR app at https://github.com/alexcasalboni/aws-lambda-power-tuning, then
 * pass its ARN to this script (or set `BBG_POWER_TUNER_ARN`).
 *
 * The caller's existing AWS credentials are used as-is — no AWS_PROFILE is
 * set inside this script. The credentials must allow:
 *   - states:StartExecution / states:DescribeExecution on the tuner ARN
 *   - lambda:InvokeFunction on the BBG Lambdas (the tuner invokes them)
 *   - lambda:GetFunctionConfiguration on the BBG Lambdas (read currentMem)
 *
 * Usage:
 *   npm run -w @bbg/lambda power-tune -- --state-machine-arn <arn>
 *   BBG_POWER_TUNER_ARN=<arn> npm run -w @bbg/lambda power-tune
 *
 * Optional:
 *   --stage-prefix dev          (default: dev)
 *   --region us-west-2          (default: $AWS_REGION or us-west-2)
 *   --metered-region us-west-2  (default: same as --region)
 *   --num 5                     invocations per memory config (default: 5)
 *   --dry-run                   skip SFN calls, just synthesize a placeholder
 */
import {
  DescribeExecutionCommand,
  type DescribeExecutionCommandOutput,
  SFNClient,
  StartExecutionCommand,
} from '@aws-sdk/client-sfn';
import {
  GetFunctionConfigurationCommand,
  LambdaClient,
} from '@aws-sdk/client-lambda';
import { gzipSync } from 'node:zlib';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const DOC_PATH = resolve(REPO_ROOT, 'docs', 'perf-tuning.md');

// Memory steps to sweep. The awslabs tuner prefers explicit power values.
const POWER_VALUES = [256, 512, 1024, 2048, 3072];

// Per-Lambda target p95 latency in ms. Long-running daily jobs get a wider
// budget; hot-path Lambdas (meter, identity-cache, ledger-writer, notify)
// are held to <5s.
const TARGET_P95_MS: Record<string, number> = {
  meter: 5_000,
  'identity-cache': 5_000,
  'ledger-writer': 5_000,
  notify: 5_000,
  'inference-profile-refresher': 5_000,
  'period-rollover': 5_000,
  enforcement: 30_000,
  'pricing-refresher': 120_000,
  'cur-reconciler': 120_000,
};

interface CliArgs {
  stateMachineArn: string;
  stagePrefix: string;
  region: string;
  meteredRegion: string;
  num: number;
  dryRun: boolean;
}

const parseArgs = (): CliArgs => {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const has = (flag: string): boolean => argv.includes(flag);

  const stateMachineArn =
    get('--state-machine-arn') ?? process.env.BBG_POWER_TUNER_ARN ?? '';
  const dryRun = has('--dry-run');

  if (!stateMachineArn && !dryRun) {
    console.error(
      '[power-tune] missing --state-machine-arn (or BBG_POWER_TUNER_ARN env var).\n' +
        '            Deploy the awslabs Lambda Power Tuning state machine once via SAR:\n' +
        '              https://github.com/alexcasalboni/aws-lambda-power-tuning\n' +
        '            Then pass its ARN here.',
    );
    process.exit(2);
  }

  return {
    stateMachineArn,
    stagePrefix: get('--stage-prefix') ?? 'dev',
    region: get('--region') ?? process.env.AWS_REGION ?? 'us-west-2',
    meteredRegion:
      get('--metered-region') ?? get('--region') ?? process.env.AWS_REGION ?? 'us-west-2',
    num: Number(get('--num') ?? '5'),
    dryRun,
  };
};

interface LambdaTarget {
  /** Short handler name used in the Lambda function name. */
  shortName: string;
  /** Full deployed function name. */
  functionName: string;
  /** Synthesized representative event payload. */
  payload: unknown;
  /** Target p95 latency in ms for the lowest-cost-acceptable rule. */
  targetP95Ms: number;
}

const buildTargets = (args: CliArgs): LambdaTarget[] => {
  const { stagePrefix, meteredRegion } = args;

  // CWL events are gzipped + base64-encoded under awslogs.data. We
  // synthesize ONE realistic Bedrock invocation log line so the meter
  // exercises canonicalization + DDB writes the way it does in prod.
  const cwlMessage = JSON.stringify({
    schemaType: 'BedrockModelInvocationLog',
    timestamp: new Date().toISOString(),
    region: meteredRegion,
    inferenceRegion: meteredRegion,
    requestId: `power-tune-${Date.now()}`,
    operation: 'InvokeModel',
    modelId: 'anthropic.claude-haiku-4-5-v1:0',
    input: { inputTokenCount: 200 },
    output: { outputTokenCount: 100 },
  });
  const cwlPayload = JSON.parse(JSON.stringify({})) as Record<string, unknown>;
  cwlPayload.awslogs = {
    data: gzipSync(
      Buffer.from(
        JSON.stringify({
          messageType: 'DATA_MESSAGE',
          owner: '000000000000',
          logGroup: '/aws/bedrock/model-invocations',
          logStream: 'power-tune',
          subscriptionFilters: ['bbg-meter'],
          logEvents: [
            {
              id: '1',
              timestamp: Date.now(),
              message: cwlMessage,
            },
          ],
        }),
      ),
    ).toString('base64'),
  };

  // CloudTrail event for identity-cache. The handler reads the inner
  // detail.userIdentity + detail.requestID — the rest is shape only.
  const cloudTrailPayload = {
    version: '0',
    id: `power-tune-${Date.now()}`,
    'detail-type': 'AWS API Call via CloudTrail',
    source: 'aws.bedrock',
    account: '000000000000',
    time: new Date().toISOString(),
    region: meteredRegion,
    resources: [],
    detail: {
      eventVersion: '1.09',
      eventTime: new Date().toISOString(),
      eventSource: 'bedrock.amazonaws.com',
      eventName: 'InvokeModel',
      awsRegion: meteredRegion,
      requestID: `power-tune-${Date.now()}`,
      userIdentity: {
        type: 'AssumedRole',
        principalId: 'AROAEXAMPLE:power-tune',
        arn: 'arn:aws:sts::000000000000:assumed-role/power-tune-role/power-tune',
        accountId: '000000000000',
        sessionContext: {
          attributes: { mfaAuthenticated: 'false', creationDate: new Date().toISOString() },
          sessionIssuer: {
            type: 'Role',
            principalId: 'AROAEXAMPLE',
            arn: 'arn:aws:iam::000000000000:role/power-tune-role',
            accountId: '000000000000',
            userName: 'power-tune-role',
          },
        },
      },
    },
  };

  // DynamoDB Stream event for enforcement / ledger-writer / notify. A
  // single MODIFY record on RunningSpend mirrors the hot path.
  const dynamoStreamPayload = {
    Records: [
      {
        eventID: 'power-tune-1',
        eventName: 'MODIFY',
        eventVersion: '1.1',
        eventSource: 'aws:dynamodb',
        awsRegion: meteredRegion,
        dynamodb: {
          ApproximateCreationDateTime: Math.floor(Date.now() / 1000),
          Keys: {
            principal: { S: 'principal#arn:aws:iam::000000000000:role/power-tune-role' },
            sk: { S: 'period#2026-05#target#anthropic.claude-haiku-4-5' },
          },
          NewImage: {
            principal: { S: 'principal#arn:aws:iam::000000000000:role/power-tune-role' },
            sk: { S: 'period#2026-05#target#anthropic.claude-haiku-4-5' },
            spendUsd: { N: '1.23' },
            inputTokens: { N: '12000' },
            outputTokens: { N: '8000' },
            period: { S: '2026-05' },
            target: { S: 'anthropic.claude-haiku-4-5' },
          },
          OldImage: {
            principal: { S: 'principal#arn:aws:iam::000000000000:role/power-tune-role' },
            sk: { S: 'period#2026-05#target#anthropic.claude-haiku-4-5' },
            spendUsd: { N: '1.10' },
            inputTokens: { N: '11000' },
            outputTokens: { N: '7500' },
          },
          SequenceNumber: '1',
          SizeBytes: 256,
          StreamViewType: 'NEW_AND_OLD_IMAGES',
        },
        eventSourceARN: `arn:aws:dynamodb:${meteredRegion}:000000000000:table/${stagePrefix}-bbg-running-spend/stream/power-tune`,
      },
    ],
  };

  // Scheduled-event payload for the once-a-day refreshers.
  const scheduledPayload = {
    version: '0',
    id: 'power-tune',
    'detail-type': 'Scheduled Event',
    source: 'aws.events',
    time: new Date().toISOString(),
    region: meteredRegion,
    resources: [],
    detail: {},
  };

  // cur-reconciler / period-rollover accept an optional period string.
  const periodPayload = { period: '2026-05' };

  return [
    {
      shortName: 'meter',
      functionName: `${stagePrefix}-bbg-meter-${meteredRegion}`,
      payload: cwlPayload,
      targetP95Ms: TARGET_P95_MS.meter,
    },
    {
      shortName: 'identity-cache',
      functionName: `${stagePrefix}-bbg-identity-cache-${meteredRegion}`,
      payload: cloudTrailPayload,
      targetP95Ms: TARGET_P95_MS['identity-cache'],
    },
    {
      shortName: 'enforcement',
      functionName: `${stagePrefix}-bbg-enforcement`,
      payload: dynamoStreamPayload,
      targetP95Ms: TARGET_P95_MS.enforcement,
    },
    {
      shortName: 'pricing-refresher',
      functionName: `${stagePrefix}-bbg-pricing-refresher`,
      payload: scheduledPayload,
      targetP95Ms: TARGET_P95_MS['pricing-refresher'],
    },
    {
      shortName: 'cur-reconciler',
      functionName: `${stagePrefix}-bbg-cur-reconciler`,
      payload: periodPayload,
      targetP95Ms: TARGET_P95_MS['cur-reconciler'],
    },
    {
      shortName: 'ledger-writer',
      functionName: `${stagePrefix}-bbg-ledger-writer-${meteredRegion}`,
      payload: dynamoStreamPayload,
      targetP95Ms: TARGET_P95_MS['ledger-writer'],
    },
    {
      shortName: 'notify',
      functionName: `${stagePrefix}-bbg-notify`,
      payload: dynamoStreamPayload,
      targetP95Ms: TARGET_P95_MS.notify,
    },
    {
      shortName: 'period-rollover',
      functionName: `${stagePrefix}-bbg-period-rollover`,
      payload: periodPayload,
      targetP95Ms: TARGET_P95_MS['period-rollover'],
    },
    {
      shortName: 'inference-profile-refresher',
      functionName: `${stagePrefix}-bbg-inference-profile-refresher-${meteredRegion}`,
      payload: scheduledPayload,
      targetP95Ms: TARGET_P95_MS['inference-profile-refresher'],
    },
  ];
};

/**
 * Shape of the JSON the awslabs Lambda Power Tuning state machine returns
 * in `output` once execution completes. We only read the fields we need.
 * Reference: https://github.com/alexcasalboni/aws-lambda-power-tuning
 */
interface PowerTunerOutput {
  power: number;
  cost: number;
  duration: number;
  stateMachine?: { executionCost?: number };
  stats?: Array<{
    power: number;
    averagePrice: number;
    averageDuration: number;
    p95Duration?: number;
    totalCost?: number;
  }>;
}

interface TuneResult {
  shortName: string;
  functionName: string;
  currentMemoryMb: number | null;
  recommendedMemoryMb: number | null;
  recommendedAvgCostUsd: number | null;
  recommendedP95Ms: number | null;
  recommendedAvgMs: number | null;
  acceptableP95Ms: number;
  acceptable: boolean;
  estimatedSavingsPct: number | null;
  errorMessage?: string;
}

const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

const runStateMachine = async (
  sfn: SFNClient,
  stateMachineArn: string,
  input: Record<string, unknown>,
): Promise<PowerTunerOutput> => {
  const start = await sfn.send(
    new StartExecutionCommand({
      stateMachineArn,
      input: JSON.stringify(input),
    }),
  );
  if (!start.executionArn) throw new Error('StartExecution returned no executionArn');

  // The tuner state machine is async (SUCCEEDED ~minutes later). Poll.
  // 30min hard cap matches the typical max for 5x configs x N invocations.
  const deadline = Date.now() + 30 * 60_000;
  let last: DescribeExecutionCommandOutput | undefined;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    last = await sfn.send(new DescribeExecutionCommand({ executionArn: start.executionArn }));
    const status = last.status;
    if (status === 'SUCCEEDED') break;
    if (status === 'FAILED' || status === 'TIMED_OUT' || status === 'ABORTED') {
      throw new Error(
        `power-tuner execution ${status}: ${last.error ?? '<no error>'}`,
      );
    }
    if (Date.now() > deadline) {
      throw new Error('power-tuner execution timed out client-side after 30 minutes');
    }
    await sleep(15_000);
  }

  const outputJson = last?.output;
  if (!outputJson) throw new Error('power-tuner SUCCEEDED but had no output');
  return JSON.parse(outputJson) as PowerTunerOutput;
};

const tuneOne = async (
  sfn: SFNClient,
  lam: LambdaClient,
  stateMachineArn: string,
  num: number,
  target: LambdaTarget,
): Promise<TuneResult> => {
  let currentMemoryMb: number | null = null;
  try {
    const cfg = await lam.send(
      new GetFunctionConfigurationCommand({ FunctionName: target.functionName }),
    );
    currentMemoryMb = cfg.MemorySize ?? null;
  } catch (err) {
    // Function may not be deployed yet — surface as a non-fatal warning.
    return {
      shortName: target.shortName,
      functionName: target.functionName,
      currentMemoryMb: null,
      recommendedMemoryMb: null,
      recommendedAvgCostUsd: null,
      recommendedP95Ms: null,
      recommendedAvgMs: null,
      acceptableP95Ms: target.targetP95Ms,
      acceptable: false,
      estimatedSavingsPct: null,
      errorMessage: `GetFunctionConfiguration failed: ${(err as Error).message}`,
    };
  }

  let output: PowerTunerOutput;
  try {
    output = await runStateMachine(sfn, stateMachineArn, {
      lambdaARN: target.functionName,
      powerValues: POWER_VALUES,
      num,
      payload: target.payload,
      parallelInvocation: true,
      strategy: 'cost',
      // The tuner's `dryRun` flag invokes once per config (cheap smoke).
      // We want real numbers, so leave it false.
      dryRun: false,
    });
  } catch (err) {
    return {
      shortName: target.shortName,
      functionName: target.functionName,
      currentMemoryMb,
      recommendedMemoryMb: null,
      recommendedAvgCostUsd: null,
      recommendedP95Ms: null,
      recommendedAvgMs: null,
      acceptableP95Ms: target.targetP95Ms,
      acceptable: false,
      estimatedSavingsPct: null,
      errorMessage: `state-machine error: ${(err as Error).message}`,
    };
  }

  // Pick the cheapest config that meets the target p95. Fall back to the
  // tuner's recommendation if every config breaches.
  const stats = (output.stats ?? []).slice().sort((a, b) => a.averagePrice - b.averagePrice);
  const acceptableSorted = stats.filter(
    (s) => (s.p95Duration ?? s.averageDuration) <= target.targetP95Ms,
  );
  const pick = acceptableSorted[0] ?? stats[0];
  const baselineCost =
    stats.find((s) => s.power === currentMemoryMb)?.averagePrice ?? output.cost;
  const savings =
    pick && baselineCost > 0 ? Math.max(0, ((baselineCost - pick.averagePrice) / baselineCost) * 100) : null;

  return {
    shortName: target.shortName,
    functionName: target.functionName,
    currentMemoryMb,
    recommendedMemoryMb: pick?.power ?? output.power,
    recommendedAvgCostUsd: pick?.averagePrice ?? output.cost,
    recommendedP95Ms: pick?.p95Duration ?? null,
    recommendedAvgMs: pick?.averageDuration ?? output.duration ?? null,
    acceptableP95Ms: target.targetP95Ms,
    acceptable: Boolean(acceptableSorted[0]),
    estimatedSavingsPct: savings,
  };
};

const renderTable = (results: TuneResult[]): string => {
  const header =
    '| Lambda | Current MB | Recommended MB | Avg cost / invoke | p95 latency | Target p95 | Δ savings | Notes |\n' +
    '|---|---|---|---|---|---|---|---|';
  const rows = results.map((r) => {
    const note = r.errorMessage
      ? r.errorMessage
      : r.acceptable
      ? 'OK'
      : 'NO config met target p95 — investigate';
    const fmtMs = (ms: number | null): string => (ms == null ? '—' : `${ms.toFixed(0)} ms`);
    const fmtUsd = (n: number | null): string =>
      n == null ? '—' : `$${n.toFixed(8)}`;
    const fmtPct = (n: number | null): string => (n == null ? '—' : `${n.toFixed(1)}%`);
    return `| \`${r.shortName}\` | ${r.currentMemoryMb ?? '—'} | ${r.recommendedMemoryMb ?? '—'} | ${fmtUsd(r.recommendedAvgCostUsd)} | ${fmtMs(r.recommendedP95Ms)} | ${r.acceptableP95Ms} ms | ${fmtPct(r.estimatedSavingsPct)} | ${note} |`;
  });
  return [header, ...rows].join('\n');
};

const LAST_RUN_START = '<!-- BBG-PERF-TUNE-LAST-RUN:START -->';
const LAST_RUN_END = '<!-- BBG-PERF-TUNE-LAST-RUN:END -->';

const renderLastRunBlock = (results: TuneResult[], args: CliArgs): string => {
  const date = new Date().toISOString().slice(0, 10);
  return [
    LAST_RUN_START,
    '## Last run',
    '',
    `- **Date**: ${date}`,
    `- **Stage**: \`${args.stagePrefix}\``,
    `- **Region**: \`${args.region}\` (metered region: \`${args.meteredRegion}\`)`,
    `- **Power values**: ${POWER_VALUES.join(', ')} MB`,
    `- **Invocations per config**: ${args.num}`,
    '',
    renderTable(results),
    '',
    LAST_RUN_END,
  ].join('\n');
};

const writeDoc = async (lastRunBlock: string): Promise<void> => {
  let body: string;
  try {
    body = await readFile(DOC_PATH, 'utf8');
  } catch {
    // First run — file might not exist yet.
    await mkdir(dirname(DOC_PATH), { recursive: true });
    body = '';
  }
  if (body.includes(LAST_RUN_START) && body.includes(LAST_RUN_END)) {
    const before = body.slice(0, body.indexOf(LAST_RUN_START));
    const after = body.slice(body.indexOf(LAST_RUN_END) + LAST_RUN_END.length);
    body = `${before}${lastRunBlock}${after}`;
  } else {
    body = `${body.trimEnd()}\n\n${lastRunBlock}\n`;
  }
  await writeFile(DOC_PATH, body, 'utf8');
};

const main = async (): Promise<void> => {
  const args = parseArgs();
  const sfn = new SFNClient({ region: args.region });
  const lam = new LambdaClient({ region: args.region });
  const targets = buildTargets(args);

  console.log(
    `[power-tune] sweeping ${targets.length} Lambdas via ${args.stateMachineArn || '<dry-run>'}`,
  );

  const results: TuneResult[] = [];
  for (const target of targets) {
    console.log(`[power-tune] ${target.shortName} (${target.functionName})`);
    if (args.dryRun) {
      results.push({
        shortName: target.shortName,
        functionName: target.functionName,
        currentMemoryMb: null,
        recommendedMemoryMb: null,
        recommendedAvgCostUsd: null,
        recommendedP95Ms: null,
        recommendedAvgMs: null,
        acceptableP95Ms: target.targetP95Ms,
        acceptable: false,
        estimatedSavingsPct: null,
        errorMessage: 'dry-run: no sweep executed',
      });
      continue;
    }
    try {
      const r = await tuneOne(sfn, lam, args.stateMachineArn, args.num, target);
      results.push(r);
      console.log(
        `[power-tune] ${target.shortName} -> rec=${r.recommendedMemoryMb}MB ` +
          `p95=${r.recommendedP95Ms ?? '?'}ms savings=${r.estimatedSavingsPct?.toFixed(1) ?? '?'}%`,
      );
    } catch (err) {
      const message = (err as Error).message;
      console.error(`[power-tune] ${target.shortName} FAILED: ${message}`);
      results.push({
        shortName: target.shortName,
        functionName: target.functionName,
        currentMemoryMb: null,
        recommendedMemoryMb: null,
        recommendedAvgCostUsd: null,
        recommendedP95Ms: null,
        recommendedAvgMs: null,
        acceptableP95Ms: target.targetP95Ms,
        acceptable: false,
        estimatedSavingsPct: null,
        errorMessage: message,
      });
    }
  }

  const block = renderLastRunBlock(results, args);
  await writeDoc(block);
  console.log(`[power-tune] wrote ${DOC_PATH}`);
};

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
