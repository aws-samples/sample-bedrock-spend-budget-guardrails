# Declarative budget manifest

The declarative manifest lets you describe your budgets, defaults, and deletions as a single YAML or JSON file, then apply them via CLI or the web app's Manifest page. Every change is dry-run-first — the server returns a structured diff before anything is written.

## Why

- **Versioned in git.** Budget changes get reviewed and audited the same way as code.
- **AI-authorable.** A model can edit the manifest given the schema, then a human applies it.
- **Reversible.** No "replace whole world" mode in v1. Removals must be explicit (`delete:` list). Anything in the live state but absent from the manifest is **kept**.

## Schema (`apiVersion: bbg/v1`)

```yaml
apiVersion: bbg/v1
kind: BudgetSet
metadata:
  description: Optional free-form text.

# Optional: master toggle + values for the default-deny baseline.
# Maps 1:1 to PUT /admin/defaults.
defaults:
  enabled: false           # Default OFF — flip on intentionally.
  limitUsd: 100
  window: monthly          # monthly | weekly | daily | 5h
  thresholds:
    - { at: 80,  action: warn }
    - { at: 100, action: block }
  # Optional: rate limits propagated to every default-materialized
  # budget so runaway agent loops are caught in seconds, before USD
  # accrues. Same semantics as on per-principal budgets. Omit any of
  # these three keys to skip rate-limit enforcement on default rows.
  rpm: 60                  # max requests per window
  tpm: 50000               # max tokens per window (input + output combined)
  rateWindowSeconds: 60    # 60 | 300 | 900

# Per-principal × per-target budgets.
budgets:
  - principal: arn:aws:iam::123456789012:role/DataScienceTeam
    target: anthropic.claude-opus-4-7   # bare modelId or model#... or profile#...
    limitUsd: 200
    window: monthly
    thresholds:
      - { at: 50,  action: warn }
      - { at: 80,  action: warn }
      - { at: 100, action: block }

  - principal: arn:aws:iam::123456789012:role/Researcher
    target: "*"                         # all models
    unlimited: true                     # opt out of enforcement; meter still records spend

  - principal: arn:aws:iam::123456789012:user/student-alice
    target: anthropic.claude-haiku-4-5
    limitUsd: 5
    window: weekly

# Optional: explicit removals. Anything else in current state stays untouched.
delete:
  - principal: arn:aws:iam::123456789012:user/old-bob
    target: model#anthropic.claude-opus-4-7
```

### Target normalization

The manifest accepts ergonomic `target` strings — `anthropic.claude-opus-4-7` becomes `model#anthropic.claude-opus-4-7`; `*` becomes `model#*`. Already-prefixed values (`model#…`, `profile#…`) pass through unchanged.

### Principal normalization

Bare ARNs (`arn:aws:iam::…`) get the `principal#` prefix to match what the meter writes. Already-prefixed values pass through.

### Validation rules

- `apiVersion` must be `bbg/v1` and `kind` must be `BudgetSet`.
- Every budget must have either `limitUsd >= 0` or `unlimited: true`.
- `unlimited: true` budgets cannot have a `block` threshold (warn-only thresholds are fine for spend visibility).
- `window` must be one of `monthly | weekly | daily | 5h`.
- `thresholds` must be strictly-increasing percentages with at most one `block`, which must be the last entry.

## CLI: `scripts/apply-budgets.ts`

```bash
# Dry-run + interactive prompt:
BBG_API_BASE=https://bbg.example.com/api \
BBG_ID_TOKEN=$(cat ~/.bbg-token) \
tsx scripts/apply-budgets.ts -f budgets.yaml

# Skip the prompt (for CI):
tsx scripts/apply-budgets.ts -f budgets.yaml --yes

# Diff only, no write:
tsx scripts/apply-budgets.ts -f budgets.yaml --dry-run
```

The `BBG_ID_TOKEN` is a Cognito ID token. The simplest way to get one is to copy it out of the web app's localStorage after signing in (DevTools → Application → Local Storage → `CognitoIdentityServiceProvider.<pool>.<user>.idToken`). For unattended applies, a service-account user with a passkey + a token-fetcher script is recommended (out of scope for this doc).

## Web app: Admin → Manifest

The Manifest page in the web app pre-fills the editor with your **current state**, so you can edit-in-place rather than authoring from scratch. Click **Dry-run + diff** to see what will change; the confirm modal lists every create / update / remove before you apply. The apply call returns the same diff structure the CLI prints.

## AI-authoring workflow

The schema is small enough to give a model in a single prompt. A reasonable workflow:

1. Export the current state via the web app Manifest page or `tsx scripts/apply-budgets.ts -f /dev/null --dry-run` (the API returns `unchanged` for everything that's currently set).
2. Hand the YAML and your goal to the model:
   > *"Here's our current BBG manifest. We're onboarding a new class of 30 students; each gets `arn:aws:iam::…:user/student-<n>` and a $25/week Haiku budget. Output an updated manifest."*
3. Paste the model's output back into the web app, dry-run, eyeball the diff, apply.

## Apply semantics

- The server reads current state once at the start of the apply call (one Scan against the `Budgets` table, with the `__defaults__` sentinel filtered out).
- For each manifest budget: upsert via `PutCommand`. Unchanged budgets are skipped to save the write.
- For each `delete:` entry: `DeleteCommand`.
- If `defaults:` is present and any field differs from the current sentinel row, the sentinel row is rewritten via the same path that `PUT /admin/defaults` uses.
- The whole apply runs in the API Lambda's request handler — no batching across DDB transactions, but Operations are idempotent so a partial apply can be retried safely.

## Limitations (v1)

- **No replace mode.** Removals are explicit (must be listed in `delete:`). Deliberate, to avoid an accidental "delete everything" via an empty manifest — same posture as the default-budget master toggle.
- **No multi-account scope selector yet.** The API endpoint operates on a single account at a time. Cross-account workflows are handled in the web app's Enroll-accounts wizard; multi-account manifest authoring will gain a `metadata.scope` selector in a follow-up.
- **No glob/regex on `principal`.** Each row is one IAM principal. Glob support is a likely v2 add — the I2 SAG asked for it specifically for student rosters.
- **No comments preserved when round-tripping through the web app.** The Form/YAML editor reserializes the structured form. Author your canonical manifest in git (where the comments are preserved); use the web app for ad-hoc edits.

## Troubleshooting

- **"Reserved principal/target"** — you can't write `__defaults__` directly via the budgets API; use the `defaults:` section instead.
- **"limitUsd is required"** — check that `unlimited: true` is spelled correctly. A typo (`unlimitied`) is silently treated as `false` by JSON parsing.
- **HTTP 403 on apply** — the caller is missing the `Admins` Cognito group. Add yourself via the web app's Admin → Users page or the AWS console.
