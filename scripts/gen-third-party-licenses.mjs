#!/usr/bin/env node
/**
 * Generate THIRD-PARTY-LICENSES from the resolved node_modules tree.
 *
 * Reads each installed package's own package.json (the authoritative source for
 * name/version/license/repository) across the root node_modules, every workspace's
 * node_modules (infra, lambda, web) and any nested node_modules, excluding this
 * project's own @bbg/* packages. Writes a summary + per-package attribution to
 * THIRD-PARTY-LICENSES at the repo root.
 *
 * Why not `license-checker`? It's unmaintained and crashes on Node 24. This is a
 * dependency-free equivalent. Run after any dependency change:
 *   node scripts/gen-third-party-licenses.mjs
 */
import { readdirSync, readFileSync, statSync, existsSync, writeFileSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
// npm hoists most of the tree to the root node_modules, but not all of it: a package
// can stay under a workspace (e.g. web/node_modules/vite, web/node_modules/react-router)
// or nested under another package (e.g. aws-cdk-lib/node_modules/fs-extra) when versions
// conflict. Walk the root and every workspace root, and recurse into nested node_modules,
// de-duplicating by name@version. Scanning only the root node_modules silently drops
// direct dependencies.
const workspaces = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).workspaces || [];
const roots = ['', ...workspaces].map((ws) => join(repoRoot, ws, 'node_modules'));
const pkgs = new Map();
const seenDirs = new Set(); // a workspace root may be reached twice via symlinks

function scan(dir, scoped = false) {
  let real;
  try { real = realpathSync(dir); } catch { return; }
  if (seenDirs.has(real)) return;
  seenDirs.add(real);
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    if (name.startsWith('.')) continue; // .bin, .cache, .package-lock.json, tool caches
    if (!scoped && name.startsWith('@')) { scan(join(dir, name), true); continue; }
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (!st.isDirectory()) continue;
    const pj = join(p, 'package.json');
    if (!existsSync(pj)) continue;
    try {
      const j = JSON.parse(readFileSync(pj, 'utf8'));
      if (!j.name || !j.version) continue;
      if (j.name.startsWith('@bbg/')) continue; // our own workspace packages (symlinked)
      const lic =
        typeof j.license === 'string' ? j.license
        : j.license && j.license.type ? j.license.type
        : Array.isArray(j.licenses) ? j.licenses.map((l) => l.type || l).join(' OR ')
        : 'UNKNOWN';
      const repoRaw = typeof j.repository === 'string' ? j.repository : (j.repository && j.repository.url) || j.homepage || '';
      const repo = repoRaw.replace(/^git\+/, '').replace(/^git:\/\//, 'https://').replace(/\.git$/, '');
      pkgs.set(`${j.name}@${j.version}`, { name: j.name, version: j.version, license: lic, repo });
    } catch { /* skip unreadable */ }
    scan(join(p, 'node_modules')); // non-hoisted deps of this package
  }
}
for (const r of roots) scan(r);

const arr = [...pkgs.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
const tally = {};
for (const p of arr) tally[p.license] = (tally[p.license] || 0) + 1;

const out = [
  '# Third-Party Licenses',
  '',
  'Budget Guard for Amazon Bedrock (this sample) is licensed under MIT-0 (see LICENSE).',
  'It depends on the third-party open-source packages listed below. Each is the property',
  'of its respective copyright holders and is used under the license noted.',
  '',
  'This attribution covers the resolved dependency tree in node_modules (npm workspaces:',
  'infra, lambda, web). It is generated from each package’s own package.json; regenerate',
  'with scripts/gen-third-party-licenses.mjs after dependency changes.',
  '',
  '## License summary',
  '',
  ...Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([l, n]) => `- ${l}: ${n}`),
  '',
  `Total third-party packages: ${arr.length}`,
  '',
  '## Packages',
  '',
];
for (const p of arr) {
  out.push(`### ${p.name} ${p.version}`);
  out.push(`- License: ${p.license}`);
  if (p.repo) out.push(`- Source: ${p.repo}`);
  out.push('');
}
writeFileSync(join(repoRoot, 'THIRD-PARTY-LICENSES'), out.join('\n'));
console.log(`Wrote THIRD-PARTY-LICENSES: ${arr.length} packages, ${Object.keys(tally).length} distinct licenses`);
