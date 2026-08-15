#!/usr/bin/env node
/**
 * doc-drift check.
 *
 * A non-blocking reminder that nudges you to update documentation when code in
 * watched areas changes without a matching docs/README change. Runs against the
 * git diff for the current commit (staged, when invoked from the pre-commit
 * hook) or against a range/working tree otherwise.
 *
 * It is intentionally advisory: it prints a checklist and exits 0 by default so
 * it never blocks a commit. Set BBG_DOCS_CHECK_STRICT=1 to make it exit 1 when
 * drift is detected (useful in CI if you want a hard gate).
 *
 * Usage:
 *   node scripts/docs-check.mjs            # check staged changes (pre-commit)
 *   node scripts/docs-check.mjs --range HEAD~1..HEAD
 *   BBG_DOCS_CHECK_STRICT=1 node scripts/docs-check.mjs
 */
import { execSync } from 'node:child_process';

// Code areas whose changes usually warrant a docs update.
const WATCHED = [
  { glob: /^lambda\/src\//, label: 'lambda/src (handlers, shared logic)' },
  { glob: /^infra\/lib\//, label: 'infra/lib (stacks, operator-config)' },
  { glob: /^web\/src\/pages\//, label: 'web/src/pages (user-facing UI)' },
];

// Paths that count as "documentation was updated".
const DOC_PATHS = [
  /^docs\//,
  /^README\.md$/,
  /^web\/src\/docs\//, // the in-app docs manifest counts as user docs
];

const isStrict = process.env.BBG_DOCS_CHECK_STRICT === '1';

const rangeArgIndex = process.argv.indexOf('--range');
const range = rangeArgIndex >= 0 ? process.argv[rangeArgIndex + 1] : undefined;

const gitFiles = () => {
  try {
    if (range) {
      return execSync(`git diff --name-only ${range}`, { encoding: 'utf8' });
    }
    // Staged changes (what a pre-commit hook sees). Fall back to unstaged if
    // nothing is staged, so a bare `npm run docs:check` is still useful.
    const staged = execSync('git diff --cached --name-only', { encoding: 'utf8' }).trim();
    if (staged) return staged;
    return execSync('git diff --name-only', { encoding: 'utf8' });
  } catch {
    return '';
  }
};

const files = gitFiles()
  .split('\n')
  .map((f) => f.trim())
  .filter(Boolean);

if (files.length === 0) {
  // Nothing to check.
  process.exit(0);
}

const touchedWatched = WATCHED.filter((w) => files.some((f) => w.glob.test(f)));
const touchedDocs = files.some((f) => DOC_PATHS.some((d) => d.test(f)));

if (touchedWatched.length > 0 && !touchedDocs) {
  const areas = touchedWatched.map((w) => `  • ${w.label}`).join('\n');
  process.stderr.write(
    [
      '',
      '📝 Doc-drift reminder — code changed in watched areas but no docs/README change is included:',
      areas,
      '',
      '   Consider whether this change needs a docs update:',
      '     • README.md — features, setup, or the Documentation section',
      '     • docs/*.md — operator-config keys, runbooks, architecture/specs',
      '     • web/src/docs/manifest.ts — user-facing in-app docs + HelpPanel content',
      '',
      isStrict
        ? '   BBG_DOCS_CHECK_STRICT=1 set → failing. Update docs or unset strict mode.'
        : '   (advisory only — commit is NOT blocked. Set BBG_DOCS_CHECK_STRICT=1 to enforce.)',
      '',
    ].join('\n'),
  );
  process.exit(isStrict ? 1 : 0);
}

// No drift (either docs were updated, or no watched code changed).
process.exit(0);
