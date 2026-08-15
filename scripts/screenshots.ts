#!/usr/bin/env tsx
/**
 * Captures full-page PNG screenshots of every BBG SPA page and saves
 * them to `docs/screenshots/`. Designed to run on a developer's machine,
 * not in CI — needs real Cognito credentials to sign in.
 *
 * Usage:
 *   BBG_SCREENSHOT_URL=https://sample-bedrock-spend-budget-guardrails-dev.example.com \
 *   BBG_SCREENSHOT_EMAIL=ops@example.com \
 *   BBG_SCREENSHOT_PASSWORD='strong-password' \
 *     npm run -w @bbg/lambda screenshots
 *
 * Override the page list with BBG_SCREENSHOT_PAGES="/spend,/budgets" if
 * you only want a subset.
 *
 * Set BBG_SCREENSHOT_MASK_ACCOUNT_ID=123456789012 to redact every visible
 * occurrence of that account ID with `############` before each PNG. Useful
 * when committing screenshots to a public repo from an internal account.
 *
 * Set BBG_SCREENSHOT_MASK_STRINGS="email1@x.com:redacted@example.com,oldStr:newStr"
 * to apply additional literal-text substitutions before each PNG. Each item is
 * `from:to`. Useful for masking real email addresses or other PII.
 *
 * Caveats:
 *   - WebAuthn passkey sign-in is not used (headless Chromium has no
 *     authenticator). The script uses the Cognito password fallback,
 *     which means the test account must have a permanent password set.
 *   - First-sign-in users are blocked: if Cognito returns
 *     CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED, the script bails out
 *     with a helpful error. Sign in once via the SPA to set a permanent
 *     password, then re-run.
 */
import { chromium, type Page } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const OUT_DIR = resolve(REPO_ROOT, 'docs', 'screenshots');

const BASE = process.env.BBG_SCREENSHOT_URL;
const EMAIL = process.env.BBG_SCREENSHOT_EMAIL;
const PASSWORD = process.env.BBG_SCREENSHOT_PASSWORD;

if (!BASE || !EMAIL || !PASSWORD) {
  console.error(
    'BBG_SCREENSHOT_URL, BBG_SCREENSHOT_EMAIL and BBG_SCREENSHOT_PASSWORD env\n' +
      'vars are required. BBG_SCREENSHOT_URL is your deployed SPA origin (there\n' +
      'is deliberately no default — it differs per deployment).\n' +
      'The account must be Cognito-confirmed (no first-login challenge) and\n' +
      'have its IAM principal mapped if /me/spend is to show real data.',
  );
  process.exit(1);
}

interface PageSpec {
  /** SPA route (everything after the origin). */
  path: string;
  /** Output filename (without `.png`). */
  filename: string;
  /** Optional: human label for log lines. */
  label?: string;
  /**
   * Optional: click a button by accessible name after the page loads but
   * before the screenshot. Used to capture modal-open states (e.g. the
   * "Create user" form).
   */
  clickButton?: string;
}

/**
 * Default capture set. Each page gets one full-page PNG. The order
 * matters — leading admin pages first so the lazy-loaded route bundle
 * is warm when the trailing user-self pages render.
 */
const DEFAULT_PAGES: PageSpec[] = [
  { path: '/spend', filename: 'spend-dashboard', label: 'Spend dashboard' },
  { path: '/budgets', filename: 'admin-budgets', label: 'Admin → Budgets' },
  { path: '/identities', filename: 'identities', label: 'Identities' },
  { path: '/inference-profiles', filename: 'inference-profiles', label: 'Inference profiles' },
  { path: '/agent-sessions', filename: 'agent-sessions', label: 'Agent sessions' },
  { path: '/pricing-overrides', filename: 'pricing-overrides', label: 'Pricing' },
  { path: '/reports', filename: 'reports', label: 'Reports' },
  { path: '/admin/users', filename: 'admin-users', label: 'Admin → Users' },
  {
    path: '/admin/users',
    filename: 'admin-users-create',
    label: 'Admin → Users (Create modal)',
    clickButton: 'Create user',
  },
  { path: '/me/spend', filename: 'my-spend', label: 'My spend' },
  { path: '/me/budget', filename: 'my-budget', label: 'My budget' },
  { path: '/me/profile', filename: 'my-profile', label: 'My profile' },
];

const pageList: PageSpec[] = (() => {
  const override = process.env.BBG_SCREENSHOT_PAGES;
  if (!override) return DEFAULT_PAGES;
  const wanted = override.split(',').map((s) => s.trim()).filter(Boolean);
  return DEFAULT_PAGES.filter((p) => wanted.includes(p.path));
})();

const signIn = async (page: Page): Promise<void> => {
  console.log(`[screenshots] navigating to ${BASE}`);
  await page.goto(BASE, { waitUntil: 'networkidle' });

  // Cloudscape Input renders an <input> wrapped in awsui markup. Target
  // by placeholder + name to be resilient to wrapper changes.
  const emailField = page.getByPlaceholder('admin@example.com').or(page.getByRole('textbox').first());
  await emailField.waitFor({ state: 'visible', timeout: 15_000 });
  await emailField.fill(EMAIL!);

  // The password field is a `type=password` input.
  const passwordField = page.locator('input[type="password"]').first();
  await passwordField.waitFor({ state: 'visible', timeout: 5_000 });
  await passwordField.fill(PASSWORD!);

  // Click the primary "Sign in" button (NOT "Sign in with passkey").
  await page.getByRole('button', { name: /^Sign in$/ }).click();

  // Wait for either the AppLayout (success) or a NEW_PASSWORD_REQUIRED challenge.
  const success = page
    .locator('[data-testid="awsui-app-layout-tools-toggle"]')
    .or(page.getByRole('navigation', { name: /Side navigation/i }))
    .or(page.getByText('My profile').first());
  const newPasswordChallenge = page.getByText(/Choose a permanent password/i);

  const winner = await Promise.race([
    success.waitFor({ state: 'visible', timeout: 30_000 }).then(() => 'success'),
    newPasswordChallenge.waitFor({ state: 'visible', timeout: 30_000 }).then(() => 'challenge'),
  ]).catch(() => 'timeout');

  if (winner === 'challenge') {
    throw new Error(
      'Sign-in produced a NEW_PASSWORD_REQUIRED challenge. The provided account ' +
        'has a temp password; sign in via the SPA once to set a permanent password, then re-run.',
    );
  }
  if (winner === 'timeout') {
    throw new Error('Sign-in did not complete within 30 seconds.');
  }
  console.log(`[screenshots] signed in as ${EMAIL}`);
};

/**
 * Walks every visible text node and applies a list of literal-text
 * substitutions before screenshotting. Doesn't touch href attributes (those
 * don't render). Safe to run multiple times. Used for both account-ID and
 * arbitrary PII masking.
 */
const applyMasks = async (
  page: Page,
  substitutions: Array<{ from: string; to: string }>,
): Promise<void> => {
  if (substitutions.length === 0) return;
  // Inline the entire mask logic in the eval body (no helper function refs)
  // to avoid esbuild/tsx wrapping it with `__name(...)` calls that fail in
  // the page context.
  await page.evaluate((subs: Array<{ from: string; to: string }>) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const targets: Text[] = [];
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      if (!node.nodeValue) continue;
      let hit = false;
      for (let i = 0; i < subs.length; i++) {
        if (node.nodeValue.indexOf(subs[i].from) !== -1) { hit = true; break; }
      }
      if (hit) targets.push(node);
    }
    for (let i = 0; i < targets.length; i++) {
      let v = targets[i].nodeValue || '';
      for (let j = 0; j < subs.length; j++) v = v.split(subs[j].from).join(subs[j].to);
      targets[i].nodeValue = v;
    }
    const inputs = document.querySelectorAll('input, textarea');
    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i] as HTMLInputElement | HTMLTextAreaElement;
      if (!input.value) continue;
      let hit = false;
      for (let j = 0; j < subs.length; j++) {
        if (input.value.indexOf(subs[j].from) !== -1) { hit = true; break; }
      }
      if (!hit) continue;
      let v = input.value;
      for (let j = 0; j < subs.length; j++) v = v.split(subs[j].from).join(subs[j].to);
      input.value = v;
    }
  }, substitutions);
};

const buildMasks = (): Array<{ from: string; to: string }> => {
  const masks: Array<{ from: string; to: string }> = [];
  const acct = process.env.BBG_SCREENSHOT_MASK_ACCOUNT_ID;
  if (acct) masks.push({ from: acct, to: '############' });
  const extra = process.env.BBG_SCREENSHOT_MASK_STRINGS;
  if (extra) {
    for (const pair of extra.split(',').map((s) => s.trim()).filter(Boolean)) {
      const idx = pair.indexOf(':');
      if (idx > 0) masks.push({ from: pair.slice(0, idx), to: pair.slice(idx + 1) });
    }
  }
  return masks;
};

const MASKS = buildMasks();

const capture = async (page: Page, spec: PageSpec): Promise<void> => {
  const url = `${BASE}${spec.path}`;
  console.log(`[screenshots] ${spec.label ?? spec.path} → ${url}`);
  await page.goto(url, { waitUntil: 'networkidle' });
  // Give Cloudscape charts + tables a moment to settle their async data
  // fetches. networkidle catches most of it but charts re-render after.
  await page.waitForTimeout(2000);
  if (spec.clickButton) {
    // Click a named button (e.g. "Create user") to open a modal, then wait
    // for the modal to settle before masking + screenshotting. Use a
    // contains-match on accessible name since Cloudscape buttons sometimes
    // include extra wrapper text.
    await page.getByRole('button', { name: spec.clickButton }).first().click({ timeout: 10_000 });
    await page.waitForTimeout(1500);
  }
  await applyMasks(page, MASKS);
  const out = resolve(OUT_DIR, `${spec.filename}.png`);
  await page.screenshot({ path: out, fullPage: true });
  console.log(`[screenshots]   wrote ${out}`);
};

const main = async (): Promise<void> => {
  await mkdir(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2, // retina-quality PNGs for crisp README rendering
    colorScheme: 'dark', // BBG defaults to dark mode
  });
  const page = await context.newPage();

  try {
    await signIn(page);
    for (const spec of pageList) {
      try {
        await capture(page, spec);
      } catch (err) {
        console.error(`[screenshots] failed on ${spec.path}: ${(err as Error).message}`);
      }
    }
  } finally {
    await browser.close();
  }
};

void main().catch((err) => {
  console.error('[screenshots]', err);
  process.exit(1);
});
