"""BBG Readiness API Lambda (v1 account-mode).

One-click pre-onboarding readiness check. Vendors the
``bedrock-attribution-audit`` discovery engine (``core/`` + ``modes/``) and
exposes it behind the BBG admin API.

A full multi-region audit takes far longer than API Gateway's ~30s
integration cap, so this follows BBG's async start/poll pattern (the same
shape the Reports API uses):

    POST /admin/readiness            -> { jobId, state: "RUNNING" }
        requireAdmin + scope-gate on the home account, write a RUNNING
        marker to S3, then self-invoke asynchronously to run the audit.

    (async self-invoke, event {"mode": "run", "jobId": ...})
        run discover_account() against the home account using the Lambda's
        own execution role, render setup-tier1.sh, write the SUCCEEDED /
        FAILED result JSON to S3.

    GET  /admin/readiness/{jobId}    -> { state, findings?, setupScript?, ... }
        read the result blob back from S3.

v1 audits the BBG home (deploy) account only — discovery runs on the
Lambda's execution role, no cross-account assume-role. Org-mode (whole-org
sweep via the member-account roles) is v2.
"""
from __future__ import annotations

import datetime
import json
import logging
import os
import re
import uuid
from pathlib import Path
from typing import Any

import boto3
from botocore.exceptions import ClientError

log = logging.getLogger()
log.setLevel(logging.INFO)

HOME_ACCOUNT_ID = os.environ.get("HOME_ACCOUNT_ID", "")
RESULTS_BUCKET = os.environ["READINESS_RESULTS_BUCKET"]
RESULTS_PREFIX = os.environ.get("READINESS_RESULTS_PREFIX", "readiness/")
# Provided automatically by the Lambda runtime — used for the async
# self-invoke so we don't need a CDK env var (which would create a
# function->itself circular reference at synth time).
SELF_FUNCTION_NAME = os.environ.get("AWS_LAMBDA_FUNCTION_NAME", "")
# Org-mode (management-account sweep): the read-only role assumed in each
# member account, and how many member accounts to audit in parallel.
CROSS_ACCOUNT_ROLE = os.environ.get("READINESS_CROSS_ACCOUNT_ROLE", "OrganizationAccountAccessRole")
MAX_CONCURRENT_ACCOUNTS = int(os.environ.get("READINESS_MAX_CONCURRENT_ACCOUNTS", "4"))

_s3 = boto3.client("s3")
_lambda = boto3.client("lambda")


# ─────────────────────────── helpers ───────────────────────────

def _now() -> str:
    return datetime.datetime.utcnow().isoformat(timespec="seconds") + "Z"


def _json(status: int, body: Any) -> dict[str, Any]:
    return {
        "statusCode": status,
        "headers": {
            "content-type": "application/json",
            "access-control-allow-origin": "*",
            "access-control-allow-headers": "authorization, content-type",
        },
        "body": json.dumps(body, default=str),
    }


def _claims(event: dict[str, Any]) -> dict[str, Any]:
    return (
        event.get("requestContext", {})
        .get("authorizer", {})
        .get("jwt", {})
        .get("claims", {})
        or {}
    )


def _groups(claims: dict[str, Any]) -> list[str]:
    """Mirror shared/api.ts: cognito:groups can arrive as a real array, a
    comma-separated string, or a bracketed space-separated string."""
    g = claims.get("cognito:groups")
    if isinstance(g, list):
        return [str(x) for x in g]
    if isinstance(g, str):
        inner = re.sub(r"^\[(.*)\]$", r"\1", g)
        return [x for x in re.split(r"[\s,]+", inner) if x]
    return []


def _require_admin(claims: dict[str, Any]) -> bool:
    groups = _groups(claims)
    return any(
        x == "Admins" or x == "BBG-Admin-Wildcard" or x.startswith("BBG-Admin-")
        for x in groups
    )


def _caller_scope(claims: dict[str, Any]) -> dict[str, Any]:
    """Mirror shared/api.ts callerScope: parse the bbg:scope JSON claim,
    fall back to legacy cognito:groups membership."""
    raw = claims.get("bbg:scope")
    if isinstance(raw, str) and raw:
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, list):
                ids = [v for v in parsed if isinstance(v, str)]
                if "*" in ids:
                    return {"accounts": ["*"], "isWildcard": True}
                return {"accounts": ids, "isWildcard": False}
        except json.JSONDecodeError:
            pass
    groups = _groups(claims)
    if "Admins" in groups or "BBG-Admin-Wildcard" in groups:
        return {"accounts": ["*"], "isWildcard": True}
    accounts = [
        g[len("BBG-Admin-") :]
        for g in groups
        if g.startswith("BBG-Admin-") and re.fullmatch(r"\d{12}", g[len("BBG-Admin-") :])
    ]
    return {"accounts": accounts, "isWildcard": False}


def _scope_allows(scope: dict[str, Any], account_id: str) -> bool:
    return bool(scope.get("isWildcard")) or account_id in scope.get("accounts", [])


def _result_key(job_id: str) -> str:
    return f"{RESULTS_PREFIX}{job_id}.json"


def _put_result(job_id: str, body: dict[str, Any]) -> None:
    _s3.put_object(
        Bucket=RESULTS_BUCKET,
        Key=_result_key(job_id),
        Body=json.dumps(body, default=str).encode("utf-8"),
        ContentType="application/json",
    )


def _get_result(job_id: str) -> dict[str, Any] | None:
    try:
        resp = _s3.get_object(Bucket=RESULTS_BUCKET, Key=_result_key(job_id))
        return json.loads(resp["Body"].read())
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") in ("NoSuchKey", "404", "NotFound"):
            return None
        raise


# ─────────────────────────── handlers ───────────────────────────

def _start() -> dict[str, Any]:
    """Kick off an async audit run and return its job id immediately."""
    job_id = str(uuid.uuid4())
    _put_result(
        job_id,
        {
            "jobId": job_id,
            "state": "RUNNING",
            "accountId": HOME_ACCOUNT_ID,
            "startedAt": _now(),
        },
    )
    _lambda.invoke(
        FunctionName=SELF_FUNCTION_NAME,
        InvocationType="Event",
        Payload=json.dumps({"mode": "run", "jobId": job_id}).encode("utf-8"),
    )
    log.info("Started readiness job %s for account %s", job_id, HOME_ACCOUNT_ID)
    return _json(202, {"jobId": job_id, "state": "RUNNING"})


def _poll(job_id: str) -> dict[str, Any]:
    result = _get_result(job_id)
    if result is None:
        return _json(404, {"state": "NOT_FOUND", "jobId": job_id})
    return _json(200, result)


def _run_audit(job_id: str) -> dict[str, Any]:
    """Async worker. Mirrors the standalone tool's auto-pivot:

    - If the deploy account is the Organizations **management/payer** account,
      sweep the whole org (assume-role into every member) and persist an
      org-level rollup.
    - Otherwise audit just this account.

    Heavy audit imports are lazy so the fast API-facing start/poll path keeps
    a small cold-start footprint.
    """
    log.info("Running readiness audit for job %s", job_id)
    try:
        from core.auth import build_local_session, is_management_account

        ctx = build_local_session()

        if is_management_account(ctx):
            # Management account → organization sweep.
            from modes.org_audit import audit_organization

            log.info("Account %s is the org management account — sweeping the org", ctx.account_id)
            org = audit_organization(
                regions=None,
                role_name=CROSS_ACCOUNT_ROLE,
                output_dir=Path("/tmp/bbg-readiness"),  # nosec B108 - Lambda /tmp is single-tenant, per-execution-environment ephemeral storage with no untrusted input in the path; audit writes go here only as scratch and we consume the return value, not the files.
                max_concurrent_accounts=MAX_CONCURRENT_ACCOUNTS,
                formats=["json"],
            )
            _put_result(
                job_id,
                {
                    "jobId": job_id,
                    "state": "SUCCEEDED",
                    "scope": "org",
                    "accountId": ctx.account_id,
                    "completedAt": _now(),
                    "orgFindings": org.to_dict(),
                },
            )
            log.info(
                "Readiness job %s SUCCEEDED (org: %d audited, %d skipped)",
                job_id,
                len(org.accounts),
                len(org.accounts_skipped),
            )
        else:
            # Member / standalone account → single-account audit.
            from core.setup_script import render_setup_script
            from core.taxonomy import suggest_taxonomy
            from modes.account_audit import discover_account

            findings = discover_account(ctx)
            suggestions = suggest_taxonomy(findings.candidate_principals)
            setup_script = render_setup_script(findings, suggestions)
            _put_result(
                job_id,
                {
                    "jobId": job_id,
                    "state": "SUCCEEDED",
                    "scope": "account",
                    "accountId": findings.account_id,
                    "completedAt": _now(),
                    "findings": findings.to_dict(),
                    "setupScript": setup_script,
                },
            )
            log.info("Readiness job %s SUCCEEDED (account: %s)", job_id, findings.readiness.value)
    except Exception as e:  # noqa: BLE001 — persist any failure for the poller
        log.exception("Readiness job %s FAILED", job_id)
        _put_result(
            job_id,
            {
                "jobId": job_id,
                "state": "FAILED",
                "accountId": HOME_ACCOUNT_ID,
                "completedAt": _now(),
                "error": str(e),
            },
        )
    return {"ok": True}


def handler(event: dict[str, Any], context: Any = None) -> Any:
    # Async self-invocation from _start — not an API Gateway event.
    if isinstance(event, dict) and event.get("mode") == "run":
        return _run_audit(event["jobId"])

    method = event.get("requestContext", {}).get("http", {}).get("method", "")
    claims = _claims(event)
    if not _require_admin(claims):
        return _json(403, {"error": "Forbidden"})

    scope = _caller_scope(claims)
    # v1 audits the home account only; gate on it the same way the
    # Identities handler scope-filters rows.
    if not _scope_allows(scope, HOME_ACCOUNT_ID):
        return _json(
            403,
            {
                "error": "Forbidden",
                "detail": "Readiness covers the BBG home account; your admin "
                "scope does not include it.",
            },
        )

    path_params = event.get("pathParameters") or {}
    job_id = path_params.get("jobId")

    if method == "POST":
        return _start()
    if method == "GET" and job_id:
        return _poll(job_id)
    return _json(400, {"error": "Bad request"})
