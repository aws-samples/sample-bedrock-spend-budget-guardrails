#!/usr/bin/env bash
# ── Bedrock Budget Guard — one-command first-time install ──────────────────────
#
# Replaces README Steps 1-5 with a single resumable command. Inherits the
# caller's AWS environment; never sets AWS_PROFILE.
#
#   ./scripts/install.sh --github-owner <your-fork-owner> --email you@example.com
#
# What it does, in order:
#   1. Preflight — tools, credentials, region, Bedrock model access, fork reachability
#   2. Bootstrap CDK in the home region AND us-east-1 (both are mandatory)
#   3. Write /bbg/operator-config
#   4. Create the GitHub CodeStar connection, then WAIT for you to authorize it
#      in a browser (the one step that cannot be automated), polling until ready
#   5. cdk deploy PipelineStack
#   6. Watch the pipeline to green
#   7. Seed the Cognito admin user and print the sign-in URL
#
# Safe to re-run. Every step detects existing state and skips or resumes, so a
# failure partway through does not require starting over or cleaning up by hand.
#
set -euo pipefail

# ── output helpers ────────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  B=$'\033[1m'; DIM=$'\033[2m'; R=$'\033[0m'
  GRN=$'\033[32m'; YEL=$'\033[33m'; RED=$'\033[31m'; CYN=$'\033[36m'
else
  B=''; DIM=''; R=''; GRN=''; YEL=''; RED=''; CYN=''
fi
STEP=0
step()  { STEP=$((STEP+1)); printf '\n%s[%d/7] %s%s\n' "$B" "$STEP" "$1" "$R"; }
ok()    { printf '   %s✓%s %s\n' "$GRN" "$R" "$1"; }
info()  { printf '   %s·%s %s\n' "$DIM" "$R" "$1"; }
warn()  { printf '   %s!%s %s\n' "$YEL" "$R" "$1"; }
die()   { printf '\n%serror:%s %s\n\n' "$RED" "$R" "$1" >&2; exit 1; }

# ── args ──────────────────────────────────────────────────────────────────────
GITHUB_OWNER=""; GITHUB_REPO="sample-bedrock-spend-budget-guardrails"; ADMIN_EMAIL=""
HOME_REGION="${AWS_REGION:-us-west-2}"; STAGE="prod"; ASSUME_YES=0; SKIP_FORK_CHECK=0

print_usage() {
  printf '%s\n' \
    "${B}Bedrock Budget Guard — first-time install${R}" \
    "" \
    "  ./scripts/install.sh --github-owner <owner> --email <you@example.com> [options]" \
    "" \
    "${B}Required${R}" \
    "  --github-owner <owner>   GitHub user/org owning your fork of this repo." \
    "                           The pipeline sources from it, so it must be a fork" \
    "                           you can push to — not aws-samples." \
    "  --email <address>        Admin sign-in address + where alerts go." \
    "" \
    "${B}Options${R}" \
    "  --repo <name>            Fork repo name            (default: $GITHUB_REPO)" \
    "  --region <region>        Home/metered region       (default: $HOME_REGION)" \
    "  --stage <dev|prod>       Stage to seed + report    (default: $STAGE)" \
    "  --yes                    Skip the confirmation prompt" \
    "  --skip-fork-check        Do not probe GitHub for the fork (private forks," \
    "                           and any repo GitHub will not confirm anonymously)" \
    "  -h, --help               This message" \
    "" \
    "${B}Notes${R}" \
    "  Runs as your current AWS CLI session — set credentials however you normally" \
    "  do. us-east-1 is always bootstrapped: the CloudFront WAF and any ACM cert" \
    "  must live there regardless of your home region." \
    "" \
    "  Re-running is safe. Each step detects existing state and resumes." \
    ""
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --github-owner) GITHUB_OWNER="${2:-}"; shift 2 ;;
    --repo)         GITHUB_REPO="${2:-}"; shift 2 ;;
    --email)        ADMIN_EMAIL="${2:-}"; shift 2 ;;
    --region)       HOME_REGION="${2:-}"; shift 2 ;;
    --stage)        STAGE="${2:-}"; shift 2 ;;
    --yes|-y)       ASSUME_YES=1; shift ;;
    --skip-fork-check) SKIP_FORK_CHECK=1; shift ;;
    -h|--help)      print_usage; exit 0 ;;
    *)              print_usage; die "unknown argument: $1" ;;
  esac
done

[[ -n "$GITHUB_OWNER" ]] || { print_usage; die "--github-owner is required."; }
[[ -n "$ADMIN_EMAIL"  ]] || { print_usage; die "--email is required."; }
[[ "$ADMIN_EMAIL" == *@*.* ]] || die "--email does not look like an address: $ADMIN_EMAIL"
[[ "$STAGE" == "dev" || "$STAGE" == "prod" ]] || die "--stage must be dev or prod."

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
export AWS_REGION="$HOME_REGION"
export AWS_DEFAULT_REGION="$HOME_REGION"

# ── 1. preflight ──────────────────────────────────────────────────────────────
step "Preflight"

for tool in node npm aws git; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool not found on PATH."
done
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
(( NODE_MAJOR >= 20 )) || die "Node 20+ required (found $(node -v)). Try: nvm use"
ok "node $(node -v), npm $(npm -v)"

CALLER_JSON="$(aws sts get-caller-identity --output json 2>/dev/null)" \
  || die "No usable AWS credentials. Set them up, then re-run."
ACCOUNT="$(printf '%s' "$CALLER_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).Account))')"
CALLER_ARN="$(printf '%s' "$CALLER_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).Arn))')"
ok "account $ACCOUNT in $HOME_REGION"
info "as $CALLER_ARN"

# The pipeline sources from the operator's fork. aws-samples is not writable by
# you, so a pipeline pointed there can never be triggered by your pushes.
if [[ "$GITHUB_OWNER" == "aws-samples" ]]; then
  die "--github-owner cannot be aws-samples. Fork the repo first, then pass your own owner."
fi

# Reachability check, not an auth check: a 404 here is the single most common
# cause of a Source-stage failure 20 minutes into the install.
if (( SKIP_FORK_CHECK )); then
  info "fork check skipped (--skip-fork-check)"
elif command -v curl >/dev/null 2>&1; then
  GH_CODE="$(curl -s -o /dev/null -w '%{http_code}' \
    "https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}" 2>/dev/null || echo 000)"
  case "$GH_CODE" in
    200) ok "fork ${GITHUB_OWNER}/${GITHUB_REPO} is reachable" ;;
    404) die "GitHub says ${GITHUB_OWNER}/${GITHUB_REPO} does not exist (404).
       Fork this repo first, or pass --repo if your fork uses a different name.
       A PRIVATE fork also returns 404 to an anonymous check. If the name is
       right and the repo is private, re-run with --skip-fork-check." ;;
    000) warn "could not reach GitHub to verify the fork; continuing" ;;
    *)   warn "GitHub returned HTTP $GH_CODE for the fork; continuing" ;;
  esac
fi

# Bedrock model access is account+region state that CDK cannot provision. Without
# it BBG deploys fine but meters nothing, which looks like a broken install.
if aws bedrock list-foundation-models --region "$HOME_REGION" >/dev/null 2>&1; then
  ok "Bedrock reachable in $HOME_REGION"
  info "if no spend appears later, grant model access: Bedrock console → Model access"
else
  warn "could not list Bedrock models in $HOME_REGION — metering will stay empty"
  warn "grant model access in the Bedrock console, then re-run traffic"
fi

if [[ ! -d node_modules ]]; then
  info "installing dependencies (npm ci)…"
  npm ci --silent || die "npm ci failed."
fi
ok "dependencies present"

printf '\n%sAbout to install Bedrock Budget Guard:%s\n' "$B" "$R"
printf '   account   %s\n' "$ACCOUNT"
printf '   regions   %s + us-east-1 (WAF/cert)\n' "$HOME_REGION"
printf '   fork      %s/%s\n' "$GITHUB_OWNER" "$GITHUB_REPO"
printf '   admin     %s\n' "$ADMIN_EMAIL"
printf '   %sTypical first run: ~30 minutes, mostly unattended. One browser step.%s\n' "$DIM" "$R"
if (( ! ASSUME_YES )); then
  printf '\n   Continue? [y/N] '
  read -r reply
  [[ "$reply" =~ ^[Yy]$ ]] || { printf '   aborted.\n'; exit 0; }
fi

# ── 2. bootstrap ──────────────────────────────────────────────────────────────
step "Bootstrap CDK"

bootstrap_region() {
  local region="$1"
  local ver
  ver="$(aws ssm get-parameter --name /cdk-bootstrap/hnb659fds/version \
          --region "$region" --query 'Parameter.Value' --output text 2>/dev/null || true)"
  if [[ -n "$ver" && "$ver" != "None" ]]; then
    ok "$region already bootstrapped (v$ver)"
  else
    info "bootstrapping $region…"
    npx cdk bootstrap "aws://$ACCOUNT/$region" >/dev/null 2>&1 \
      || die "cdk bootstrap failed in $region."
    ok "$region bootstrapped"
  fi
}
bootstrap_region "$HOME_REGION"
# Always required, even for a single-region install: the CloudFront WAF WebACL
# and ACM certs are CloudFront-scoped and can only live in us-east-1. Skipping
# this produces a confusing "Invalid principal in policy" much later.
[[ "$HOME_REGION" == "us-east-1" ]] || bootstrap_region "us-east-1"

# ── 3. operator config ────────────────────────────────────────────────────────
step "Write operator config"

CONFIG_JSON="$(node -e '
  const [owner, repo, email, region] = process.argv.slice(1);
  process.stdout.write(JSON.stringify({
    "bbg:githubOwner": owner,
    "bbg:githubRepo": repo,
    "bbg:alertEmail": email,
    "bbg:meteredRegions": [region],
  }, null, 2));
' "$GITHUB_OWNER" "$GITHUB_REPO" "$ADMIN_EMAIL" "$HOME_REGION")"

EXISTING="$(aws ssm get-parameter --name /bbg/operator-config --region "$HOME_REGION" \
             --query 'Parameter.Value' --output text 2>/dev/null || true)"
if [[ -n "$EXISTING" && "$EXISTING" != "None" ]]; then
  info "existing /bbg/operator-config found — merging, keeping your extra keys"
  CONFIG_JSON="$(node -e '
    const existing = JSON.parse(process.argv[1]);
    const wanted   = JSON.parse(process.argv[2]);
    process.stdout.write(JSON.stringify({ ...existing, ...wanted }, null, 2));
  ' "$EXISTING" "$CONFIG_JSON")"
fi
aws ssm put-parameter --name /bbg/operator-config --type String --overwrite \
  --region "$HOME_REGION" --value "$CONFIG_JSON" >/dev/null \
  || die "could not write /bbg/operator-config."
ok "/bbg/operator-config written"
printf '%s' "$CONFIG_JSON" | sed 's/^/     /'

# ── 4. CodeStar connection (the one browser step) ──────────────────────────────
step "GitHub connection"

conn_status() {
  aws codeconnections get-connection --connection-arn "$1" --region "$HOME_REGION" \
    --query 'Connection.ConnectionStatus' --output text 2>/dev/null || echo MISSING
}

CONN_ARN="$(aws ssm get-parameter --name /bbg/github-connection-arn --region "$HOME_REGION" \
             --query 'Parameter.Value' --output text 2>/dev/null || true)"
if [[ -n "$CONN_ARN" && "$CONN_ARN" != "None" ]] && [[ "$(conn_status "$CONN_ARN")" != "MISSING" ]]; then
  info "reusing connection from SSM"
else
  CONN_ARN="$(aws codeconnections list-connections --region "$HOME_REGION" \
    --query "Connections[?ConnectionName=='bbg-github'].ConnectionArn | [0]" \
    --output text 2>/dev/null || true)"
  if [[ -z "$CONN_ARN" || "$CONN_ARN" == "None" ]]; then
    info "creating connection bbg-github…"
    CONN_ARN="$(aws codeconnections create-connection --provider-type GitHub \
      --connection-name bbg-github --region "$HOME_REGION" \
      --query ConnectionArn --output text)" || die "could not create the connection."
  fi
  aws ssm put-parameter --name /bbg/github-connection-arn --type String --overwrite \
    --region "$HOME_REGION" --value "$CONN_ARN" >/dev/null
fi
ok "connection $CONN_ARN"

# A connection is created PENDING and only becomes AVAILABLE after a human
# completes the GitHub OAuth handshake in a browser. There is no API for it.
CONN_URL="https://${HOME_REGION}.console.aws.amazon.com/codesuite/settings/connections?region=${HOME_REGION}"
if [[ "$(conn_status "$CONN_ARN")" != "AVAILABLE" ]]; then
  printf '\n   %s▶ ACTION NEEDED — authorize the connection in a browser%s\n' "$YEL$B" "$R"
  printf '     1. Open %s%s%s\n' "$CYN" "$CONN_URL" "$R"
  printf '     2. Click %sbbg-github%s → %sUpdate pending connection%s\n' "$B" "$R" "$B" "$R"
  printf '     3. Install/authorize the AWS Connector for GitHub on %s%s%s\n' "$B" "$GITHUB_OWNER" "$R"
  printf '        %sA connection maps 1:1 to one GitHub owner. If you already have a%s\n' "$DIM" "$R"
  printf '        %sconnection for a different owner, this one still needs its own app install.%s\n' "$DIM" "$R"
  command -v open >/dev/null 2>&1 && open "$CONN_URL" >/dev/null 2>&1 || true
  printf '\n     waiting for status AVAILABLE (Ctrl-C to stop; re-run to resume)'
  for _ in $(seq 1 120); do   # 120 × 10s = 20 minutes
    sleep 10
    [[ "$(conn_status "$CONN_ARN")" == "AVAILABLE" ]] && { printf '\n'; break; }
    printf '.'
  done
  printf '\n'
fi
[[ "$(conn_status "$CONN_ARN")" == "AVAILABLE" ]] \
  || die "connection is still $(conn_status "$CONN_ARN"). Authorize it at:
       $CONN_URL
       then re-run this script — it resumes from here."
ok "connection AVAILABLE"

# ── 5. deploy the pipeline ────────────────────────────────────────────────────
step "Deploy PipelineStack"
info "this creates the pipeline and its cross-region support stacks (~5 min)"
npx cdk deploy PipelineStack --require-approval never \
  || die "cdk deploy PipelineStack failed. Fix the reported error and re-run."
ok "PipelineStack deployed"

# ── 6. watch the pipeline ────────────────────────────────────────────────────
step "Wait for the pipeline"
info "first run builds, self-mutates, then deploys Dev and Prod (~25 min)"

pipeline_states() {
  aws codepipeline get-pipeline-state --name bbg-pipeline --region "$HOME_REGION" \
    --query 'stageStates[].[stageName,latestExecution.status]' --output text 2>/dev/null || true
}
LAST=""
PIPELINE_FAILED=0
for _ in $(seq 1 180); do    # 180 × 20s = 60 minutes
  SNAP="$(pipeline_states)"
  if [[ -n "$SNAP" && "$SNAP" != "$LAST" ]]; then
    printf '     %s\n' "$(printf '%s' "$SNAP" | tr '\n' ' ' | tr -s ' ')"
    LAST="$SNAP"
  fi
  if printf '%s' "$SNAP" | grep -q 'Failed'; then
    PIPELINE_FAILED=1
    warn "a stage failed — inspect it, then re-run this script to resume:"
    warn "https://${HOME_REGION}.console.aws.amazon.com/codesuite/codepipeline/pipelines/bbg-pipeline/view"
    break
  fi
  # Done when every stage reports Succeeded and none is still InProgress.
  if [[ -n "$SNAP" ]] && ! printf '%s' "$SNAP" | grep -qE 'InProgress|Failed' \
     && printf '%s' "$SNAP" | grep -q 'Succeeded'; then
    ok "pipeline green"
    break
  fi
  sleep 20
done

# ── 7. seed the admin user ───────────────────────────────────────────────────
step "Seed the admin user"

WEB_URL="$(aws cloudformation describe-stacks --stack-name "${STAGE}-bbg-web" \
  --region "$HOME_REGION" \
  --query "Stacks[0].Outputs[?contains(OutputKey,'Url')||contains(OutputKey,'Domain')].OutputValue | [0]" \
  --output text 2>/dev/null || true)"

if aws cloudformation describe-stacks --stack-name "${STAGE}-bbg-auth" \
     --region "$HOME_REGION" >/dev/null 2>&1; then
  # Generated locally and shown once — never written to the repo or to SSM.
  TEMP_PASSWORD="$(node -e '
    const c = require("crypto");
    const pick = (s, n) => Array.from({length: n},
      () => s[c.randomInt(s.length)]).join("");
    // Cognito default policy: upper, lower, digit, symbol.
    const out = pick("ABCDEFGHJKLMNPQRSTUVWXYZ", 4) + pick("abcdefghijkmnpqrstuvwxyz", 4)
              + pick("23456789", 3) + pick("!@#$%^&*-_", 2);
    console.log(out.split("").sort(() => c.randomInt(3) - 1).join(""));
  ')"
  if BBG_STAGE_PREFIX="$STAGE" BBG_ADMIN_EMAIL="$ADMIN_EMAIL" \
     BBG_TEMP_PASSWORD="$TEMP_PASSWORD" \
     npm run -w @bbg/lambda seed:cognito --silent >/dev/null 2>&1; then
    ok "admin user $ADMIN_EMAIL created in the $STAGE pool"
    SEEDED=1
  else
    warn "seeding did not complete — the user may already exist. To retry:"
    warn "  export BBG_ADMIN_EMAIL=$ADMIN_EMAIL BBG_TEMP_PASSWORD='<choose one>'"
    warn "  BBG_STAGE_PREFIX=$STAGE npm run -w @bbg/lambda seed:cognito"
    SEEDED=0
  fi
else
  warn "${STAGE}-bbg-auth not found — the pipeline has not finished that stage yet."
  warn "re-run this script once it is green to seed the admin user."
  SEEDED=0
fi

# ── done ─────────────────────────────────────────────────────────────────────
printf '\n%s──────────────────────────────────────────────────────────%s\n' "$B" "$R"
if (( PIPELINE_FAILED )) || (( ! SEEDED )); then
  printf '%s Install did NOT complete.%s\n' "$B$YEL" "$R"
else
  printf '%s Bedrock Budget Guard is installed.%s\n' "$B$GRN" "$R"
fi
printf '%s──────────────────────────────────────────────────────────%s\n\n' "$B" "$R"
if [[ -n "$WEB_URL" && "$WEB_URL" != "None" ]]; then
  case "$WEB_URL" in https://*) printf '   Sign in   %s%s%s\n' "$CYN" "$WEB_URL" "$R" ;;
                     *)         printf '   Sign in   %shttps://%s%s\n' "$CYN" "$WEB_URL" "$R" ;; esac
else
  printf '   Sign in   see the CloudFront URL in the %s-bbg-web stack outputs\n' "$STAGE"
fi
printf '   Username  %s\n' "$ADMIN_EMAIL"
if (( SEEDED )); then
  printf '   Password  %s%s%s  %s(shown once — you will be asked to change it)%s\n' \
    "$B" "$TEMP_PASSWORD" "$R" "$DIM" "$R"
fi
printf '%s\n' \
  "" \
  "   ${B}Next${R}" \
  "     · Sign in, then enroll a passkey on the My profile page." \
  "     · Set a budget:      Budgets → Create budget" \
  "     · Generate traffic:  npm run -w @bbg/lambda demo:traffic" \
  "     · Pipeline:          https://${HOME_REGION}.console.aws.amazon.com/codesuite/codepipeline/pipelines/bbg-pipeline/view" \
  "" \
  "   ${DIM}From here, every push to main on your fork redeploys automatically.${R}" \
  ""

if (( PIPELINE_FAILED )); then
  printf '%s   What to do next%s\n' "$B" "$R"
  printf '     1. Open the pipeline and read the failed action:\n'
  printf '        %shttps://%s.console.aws.amazon.com/codesuite/codepipeline/pipelines/bbg-pipeline/view%s\n' \
    "$CYN" "$HOME_REGION" "$R"
  printf '     2. A "%sResourceExistenceCheck%s" failure means a previous install of this\n' "$B" "$R"
  printf '        stage left RETAIN-policy resources behind. BBG deliberately retains the\n'
  printf '        spend ledger and audit data so a teardown cannot lose billing history,\n'
  printf '        which means a re-install of the SAME stage collides with them. Either\n'
  printf '        deploy a different --stage, or remove the leftovers first:\n'
  printf '          %saws s3 ls | grep %s-bbg%s            # then: aws s3 rb s3://<b> --force\n' "$DIM" "$STAGE" "$R"
  printf '          %saws dynamodb list-tables | grep %s-bbg%s   # then: aws dynamodb delete-table ...\n' "$DIM" "$STAGE" "$R"
  printf '     3. Fix the cause, then re-run this script — it resumes.\n\n'
  exit 1
fi
