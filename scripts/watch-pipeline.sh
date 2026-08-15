#!/usr/bin/env bash
# Watch a CodePipeline execution to completion. If the execution is
# superseded/cancelled, automatically follows the new latest execution.
#
# Usage:
#   watch-pipeline.sh                          # follow latest execution
#   watch-pipeline.sh <executionId>            # follow a specific id
#   watch-pipeline.sh <executionId> <pipeline> # custom pipeline (default: bbg-pipeline)
#
# Uses whatever credentials your shell already has (never sets AWS_PROFILE).
# Watches can outlive a short-lived session token, so if your organization
# vends temporary credentials, export BBG_CREDS_REFRESH_CMD with a command
# that re-vends them; it is re-run before every poll. It must print
# shell-`eval`-able `export VAR=value` lines, e.g.:
#
#   export BBG_CREDS_REFRESH_CMD='my-cred-tool print --format env | sed "s/^/export /"'
#
# Why this exists: ad-hoc one-liners kept breaking — captured "watching $EXEC"
# into the variable, lost the trailing newline, used non-quoted vars in case
# statements, etc. This file is the canonical watcher.

set -uo pipefail

PIPELINE="${2:-bbg-pipeline}"
EXEC_ID="${1:-}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-west-2}}"
UUID_RE='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'

export AWS_REGION="$REGION"
export AWS_DEFAULT_REGION="$REGION"

refresh_creds() {
  [ -n "${BBG_CREDS_REFRESH_CMD:-}" ] || return 0
  local vended
  vended=$(eval "$BBG_CREDS_REFRESH_CMD" 2>/dev/null) || {
    echo "WARN: BBG_CREDS_REFRESH_CMD failed; continuing with existing credentials" >&2
    return 0
  }
  eval "$vended"
  export AWS_REGION="$REGION"
  export AWS_DEFAULT_REGION="$REGION"
}

latest_exec_id() {
  # `aws codepipeline list-pipeline-executions --max-items 1` appends a
  # second line "None" (its pagination marker token). Take the first
  # line and strip whitespace.
  aws codepipeline list-pipeline-executions \
    --pipeline-name "$PIPELINE" \
    --max-items 1 \
    --query 'pipelineExecutionSummaries[0].pipelineExecutionId' \
    --output text 2>/dev/null \
    | head -n 1 \
    | tr -d '[:space:]'
}

refresh_creds

if [ -z "$EXEC_ID" ]; then
  EXEC_ID=$(latest_exec_id)
fi

if ! [[ "$EXEC_ID" =~ $UUID_RE ]]; then
  echo "ERROR: bad execution id: '$EXEC_ID'" >&2
  exit 2
fi

echo "watching pipeline=$PIPELINE exec=$EXEC_ID"

while true; do
  refresh_creds

  status=$(aws codepipeline get-pipeline-execution \
    --pipeline-name "$PIPELINE" \
    --pipeline-execution-id "$EXEC_ID" \
    --query 'pipelineExecution.status' \
    --output text 2>&1)

  active=$(aws codepipeline list-action-executions \
    --pipeline-name "$PIPELINE" \
    --filter "pipelineExecutionId=$EXEC_ID" \
    --query 'actionExecutionDetails[?status==`InProgress` || status==`Failed`].[stageName,actionName,status]' \
    --output text 2>/dev/null | tr '\n' ';' | sed 's/;$//')

  printf '%s exec=%s status=%s | %s\n' "$(date +%H:%M:%S)" "$EXEC_ID" "$status" "$active"

  case "$status" in
    Succeeded|Failed|Stopped)
      exit 0
      ;;
    Cancelled|Superseded)
      new=$(latest_exec_id)
      if [[ "$new" =~ $UUID_RE ]] && [ "$new" != "$EXEC_ID" ]; then
        EXEC_ID="$new"
        echo "  → following new execution $EXEC_ID"
      else
        exit 0
      fi
      ;;
  esac

  sleep 60
done
