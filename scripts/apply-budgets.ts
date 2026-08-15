#!/usr/bin/env tsx
/**
 * declarative budget manifest CLI. Reads a YAML or JSON manifest,
 * does a dry-run against the live API to surface a diff, prompts the
 * operator for confirmation, then applies.
 *
 * Auth: requires a Cognito ID token. Pass via --token or BBG_ID_TOKEN
 * env. The simplest way to get one is to copy it out of the SPA's
 * localStorage after signing in.
 *
 * Usage:
 *   tsx scripts/apply-budgets.ts -f budgets.yaml
 *   tsx scripts/apply-budgets.ts -f budgets.yaml --yes      # skip prompt
 *   tsx scripts/apply-budgets.ts -f budgets.yaml --dry-run  # diff only
 *   tsx scripts/apply-budgets.ts -f budgets.json --api https://bbg-prod.example.com/api
 */
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output, exit } from 'node:process';
import { parse as parseYaml } from 'yaml';

interface Args {
  file: string;
  apiBase: string;
  token: string;
  yes: boolean;
  dryRunOnly: boolean;
}

const parseArgs = (): Args => {
  const argv = process.argv.slice(2);
  const get = (flag: string, alias?: string): string | undefined => {
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === flag || argv[i] === alias) return argv[i + 1];
    }
    return undefined;
  };
  const has = (flag: string): boolean => argv.includes(flag);
  const file = get('-f', '--file');
  const apiBase = get('--api') ?? process.env.BBG_API_BASE ?? '';
  const token = get('--token') ?? process.env.BBG_ID_TOKEN ?? '';
  if (!file) {
    console.error('error: -f / --file is required');
    exit(2);
  }
  if (!apiBase) {
    console.error('error: --api or BBG_API_BASE env is required');
    exit(2);
  }
  if (!token) {
    console.error('error: --token or BBG_ID_TOKEN env is required (Cognito ID token)');
    exit(2);
  }
  return {
    file,
    apiBase: apiBase.replace(/\/$/, ''),
    token,
    yes: has('--yes') || has('-y'),
    dryRunOnly: has('--dry-run'),
  };
};

const loadManifest = async (path: string): Promise<unknown> => {
  const raw = await readFile(path, 'utf8');
  if (path.endsWith('.json')) return JSON.parse(raw);
  return parseYaml(raw);
};

interface ApplyResponse {
  dryRun: boolean;
  diff: {
    created: Array<{ principal: string; target: string }>;
    updated: Array<{ principal: string; target: string }>;
    unchanged: Array<{ principal: string; target: string }>;
    removed: Array<{ principal: string; target: string }>;
    defaultsChanged: boolean;
  };
}

const callApply = async (
  args: Args,
  manifest: unknown,
  dryRun: boolean,
): Promise<ApplyResponse> => {
  const r = await fetch(`${args.apiBase}/admin/budgets:apply`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${args.token}`,
    },
    body: JSON.stringify({ manifest, dryRun }),
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`HTTP ${r.status}: ${text}`);
  }
  return JSON.parse(text) as ApplyResponse;
};

const printDiff = (resp: ApplyResponse): void => {
  const d = resp.diff;
  console.log(
    `\n${resp.dryRun ? 'Dry-run diff' : 'Applied'}: ${d.created.length} created, ${d.updated.length} updated, ${d.removed.length} removed, ${d.unchanged.length} unchanged${d.defaultsChanged ? ', defaults updated' : ''}.\n`,
  );
  for (const e of d.created) console.log(`  + ${e.principal}  ${e.target}`);
  for (const e of d.updated) console.log(`  ~ ${e.principal}  ${e.target}`);
  for (const e of d.removed) console.log(`  - ${e.principal}  ${e.target}`);
  if (d.created.length + d.updated.length + d.removed.length === 0 && !d.defaultsChanged) {
    console.log('  (no changes)');
  }
};

const confirm = async (): Promise<boolean> => {
  const rl = createInterface({ input, output });
  const answer = await rl.question('\nApply these changes? [y/N] ');
  rl.close();
  return answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes';
};

const main = async (): Promise<void> => {
  const args = parseArgs();
  const manifest = await loadManifest(args.file);
  const dryRun = await callApply(args, manifest, true);
  printDiff(dryRun);
  if (args.dryRunOnly) return;
  const noChanges =
    dryRun.diff.created.length === 0 &&
    dryRun.diff.updated.length === 0 &&
    dryRun.diff.removed.length === 0 &&
    !dryRun.diff.defaultsChanged;
  if (noChanges) {
    console.log('\nNothing to apply.');
    return;
  }
  if (!args.yes) {
    // nosemgrep: javascript-confirm - local readline confirm() (defined above,
    // node:readline/promises), not the browser window.confirm(). This is a Node
    // CLI script with no DOM; the rule's blocking-UI concern does not apply.
    const ok = await confirm();
    if (!ok) {
      console.log('Aborted.');
      exit(1);
    }
  }
  const applied = await callApply(args, manifest, false);
  printDiff(applied);
};

main().catch((err) => {
  console.error(err);
  exit(1);
});
