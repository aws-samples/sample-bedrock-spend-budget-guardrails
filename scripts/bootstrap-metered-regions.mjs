#!/usr/bin/env node
/**
 * Auto-bootstrap every configured metered region before synth/deploy.
 *
 * Runs inside the pipeline's Synth CodeBuild step (see pipeline-stack.ts).
 * Adding a home-account region via the Enrollment UI writes
 * `bbg:meteredRegions` into the /bbg/operator-config SSM parameter and
 * re-triggers the pipeline; app-stage.ts then synthesizes a MeteringStack in
 * that region, which fails mid-release unless the region has the CDKToolkit
 * bootstrap stack. This script closes that gap: for each configured region it
 * checks CDKToolkit and runs `cdk bootstrap` only when missing/incomplete.
 *
 * Design notes:
 *  - Idempotent: already-bootstrapped regions are a single DescribeStacks
 *    call (~200ms) — no cdk invocation.
 *  - The bootstrap POWER deliberately lives in the pipeline's synth role
 *    (which already self-mutates the pipeline), NOT in the enrollment API
 *    Lambda: an API route able to create cfn-exec admin roles would be an
 *    account-takeover primitive. The UI's 409 preflight remains as a
 *    fast-feedback hint, but the pipeline self-heals regardless.
 *  - Region list resolution mirrors infra/lib/operator-config.ts precedence:
 *    SSM /bbg/operator-config `bbg:meteredRegions` wins over cdk.json.
 *  - Trust flags mirror scripts/bootstrap.sh / the existing regions
 *    (default qualifier, self-trust for the pipeline's deploy roles).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  CloudFormationClient,
  DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';

const OPERATOR_CONFIG_PARAM = process.env.OPERATOR_CONFIG_PARAM ?? '/bbg/operator-config';

const log = (msg) => console.log(`[bootstrap-metered-regions] ${msg}`);

const resolveRegions = async () => {
  // 1. SSM operator-config (what the Enrollment UI writes) wins.
  try {
    const ssm = new SSMClient({});
    const r = await ssm.send(new GetParameterCommand({ Name: OPERATOR_CONFIG_PARAM }));
    const cfg = JSON.parse(r.Parameter?.Value ?? '{}');
    if (Array.isArray(cfg['bbg:meteredRegions']) && cfg['bbg:meteredRegions'].length > 0) {
      return { regions: cfg['bbg:meteredRegions'], source: 'ssm' };
    }
  } catch (err) {
    log(`SSM operator-config unavailable (${err.name ?? err}); falling back to cdk.json`);
  }
  // 2. cdk.json context fallback.
  try {
    const cdkJson = JSON.parse(readFileSync(new URL('../cdk.json', import.meta.url), 'utf8'));
    const fromCdk = cdkJson?.context?.['bbg:meteredRegions'];
    if (Array.isArray(fromCdk) && fromCdk.length > 0) return { regions: fromCdk, source: 'cdk.json' };
  } catch {
    /* fall through */
  }
  return { regions: ['us-west-2'], source: 'default' };
};

const isBootstrapped = async (region) => {
  const cfn = new CloudFormationClient({ region });
  try {
    const r = await cfn.send(new DescribeStacksCommand({ StackName: 'CDKToolkit' }));
    const status = r.Stacks?.[0]?.StackStatus ?? '';
    return /COMPLETE$/.test(status) && !/ROLLBACK/.test(status);
  } catch {
    return false; // ValidationError => stack doesn't exist.
  }
};

const main = async () => {
  const sts = new STSClient({});
  const { Account: account } = await sts.send(new GetCallerIdentityCommand({}));
  const { regions, source } = await resolveRegions();
  // Region-code shape guard: the list is operator data; never let a
  // malformed value reach a shell invocation.
  const valid = regions.filter((r) => /^[a-z]{2}(-[a-z]+)+-\d$/.test(r));
  const rejected = regions.filter((r) => !valid.includes(r));
  if (rejected.length > 0) log(`WARNING: ignoring malformed region value(s): ${rejected.join(', ')}`);
  log(`account=${account} regions=[${valid.join(', ')}] (source: ${source})`);

  for (const region of valid) {
    if (await isBootstrapped(region)) {
      log(`${region}: CDKToolkit present — skipping`);
      continue;
    }
    log(`${region}: CDKToolkit missing — bootstrapping (~2 min)…`);
    execFileSync(
      'npx',
      [
        'cdk',
        'bootstrap',
        `aws://${account}/${region}`,
        '--trust',
        account,
        '--cloudformation-execution-policies',
        'arn:aws:iam::aws:policy/AdministratorAccess',
      ],
      { stdio: 'inherit' },
    );
    log(`${region}: bootstrapped`);
  }
  log('done');
};

main().catch((err) => {
  console.error('[bootstrap-metered-regions] FAILED:', err);
  process.exit(1);
});
