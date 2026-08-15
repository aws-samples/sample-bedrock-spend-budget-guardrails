"""Org-wide Bedrock discovery.

Run from the AWS Organizations management account. Enumerates all member
accounts, assumes a read-only role into each, and runs the same per-account
audit logic as `account-audit`. Aggregates results into an org-level summary.

Permissions required at the management account:
  - organizations:DescribeOrganization, ListAccounts
  - sts:AssumeRole into the configured role in each member account
  - ce:GetCostAndUsage (for the org-wide spend rollup)
  - bcm-data-exports:ListExports / GetExport (for CUR 2.0 inventory)

The role assumed in each member account must have the same read-only
permissions that `account-audit` requires (Cost Explorer, IAM read,
Bedrock read, CloudTrail read).
"""
from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from botocore.exceptions import ClientError

from core.auth import (
    DEFAULT_BEDROCK_REGIONS,
    SessionContext,
    assume_into_account,
    build_local_session,
    is_management_account,
)
from core.cost_explorer import bedrock_spend_by_account, total_bedrock_spend
from core.models import AccountFindings, OrgFindings, now_iso
from core.report import (
    write_account_json,
    write_account_markdown,
    write_org_json,
    write_org_markdown,
)
from core.report_csv import write_org_csvs
from core.report_html import write_org_html
from modes.account_audit import audit_current_account

log = logging.getLogger(__name__)

DEFAULT_CROSS_ACCOUNT_ROLE = "OrganizationAccountAccessRole"


def _list_org_accounts(bootstrap: SessionContext) -> list[dict]:
    """Return [{Id, Name, Status}, ...] for every account in the org."""
    org = bootstrap.client("organizations")
    out: list[dict] = []
    paginator = org.get_paginator("list_accounts")
    for page in paginator.paginate():
        out.extend(page.get("Accounts", []) or [])
    return out


def audit_organization(
    profile: str | None = None,
    role_name: str = DEFAULT_CROSS_ACCOUNT_ROLE,
    regions: list[str] | None = None,
    output_dir: Path | None = None,
    max_concurrent_accounts: int = 4,
    only_account_ids: list[str] | None = None,
    formats: list[str] | None = None,
) -> OrgFindings:
    """Run an org-wide Bedrock discovery audit.

    Parameters
    ----------
    profile
        Optional AWS profile for the management account credentials.
    role_name
        Cross-account role to assume in each member account.
    regions
        Bedrock regions to scan per account.
    output_dir
        Output root. Org-level files go here; per-account files go in
        `{output_dir}/accounts/{account_id}.json|md`.
    max_concurrent_accounts
        Number of member accounts to audit in parallel.
    only_account_ids
        If provided, restrict the sweep to this set of account IDs.
        Useful for incremental rollouts or testing.
    """
    regions = regions or DEFAULT_BEDROCK_REGIONS
    output_dir = output_dir or Path("./output")
    accounts_dir = output_dir / "accounts"
    formats = formats or ["json", "markdown"]

    bootstrap = build_local_session(profile=profile)

    if not is_management_account(bootstrap):
        raise RuntimeError(
            f"Account {bootstrap.account_id} is not the Organizations management account. "
            f"Run `account-audit` against this account, or run `org-audit` from the payer."
        )

    started = now_iso()
    log.info(
        "Starting org audit from management account %s (caller=%s)",
        bootstrap.account_id,
        bootstrap.caller_arn,
    )

    org_id: str | None = None
    try:
        org_resp = bootstrap.client("organizations").describe_organization()
        org_id = org_resp["Organization"].get("Id")
    except ClientError as e:
        log.warning("describe_organization failed: %s", e)

    # Org-wide spend rollup (one Cost Explorer call from payer)
    log.info("Querying org-wide Bedrock spend...")
    spend_30d = round(total_bedrock_spend(bootstrap, days=30), 2)
    spend_90d = round(total_bedrock_spend(bootstrap, days=90), 2)
    spend_by_account_90d = bedrock_spend_by_account(bootstrap, days=90)

    # Enumerate accounts
    log.info("Enumerating org accounts...")
    org_accounts = _list_org_accounts(bootstrap)
    if only_account_ids:
        org_accounts = [a for a in org_accounts if a["Id"] in set(only_account_ids)]
    log.info("Will audit %d accounts (concurrency=%d)", len(org_accounts), max_concurrent_accounts)

    findings = OrgFindings(
        organization_id=org_id,
        management_account_id=bootstrap.account_id,
        audit_started_at=started,
        audit_completed_at=None,
        total_org_bedrock_spend_30d_usd=spend_30d,
        total_org_bedrock_spend_90d_usd=spend_90d,
    )

    # Audit each member account in parallel
    def _audit_one(acct: dict) -> tuple[dict, AccountFindings | None, str | None]:
        acct_id = acct["Id"]
        acct_name = acct.get("Name")
        if acct.get("Status") != "ACTIVE":
            return (acct, None, f"account status is {acct.get('Status')}")
        # The management account itself can be audited with the bootstrap session
        if acct_id == bootstrap.account_id:
            child = bootstrap
        else:
            child = assume_into_account(bootstrap, acct_id, role_name)
            if child is None:
                return (acct, None, f"could not assume {role_name}")
        try:
            f = audit_current_account(
                ctx=child,
                regions=regions,
                output_dir=accounts_dir,
                account_name_hint=acct_name,
                formats=formats,
            )
            # Layer in payer-side known data not visible from inside the member
            if acct_id in spend_by_account_90d and f.total_bedrock_spend_90d_usd == 0:
                f.total_bedrock_spend_90d_usd = round(spend_by_account_90d[acct_id], 2)
            return (acct, f, None)
        except Exception as e:  # noqa: BLE001
            log.exception("Audit failed for %s: %s", acct_id, e)
            return (acct, None, f"audit error: {e}")

    with ThreadPoolExecutor(max_workers=max_concurrent_accounts) as pool:
        futs = [pool.submit(_audit_one, a) for a in org_accounts]
        for fut in as_completed(futs):
            acct, result, reason = fut.result()
            if result is not None:
                findings.accounts.append(result)
            else:
                findings.accounts_skipped.append(
                    {
                        "account_id": acct["Id"],
                        "name": acct.get("Name", ""),
                        "reason": reason or "unknown",
                    }
                )

    findings.audit_completed_at = now_iso()
    if "json" in formats:
        write_org_json(findings, output_dir)
    if "markdown" in formats:
        write_org_markdown(findings, output_dir)
    if "csv" in formats:
        write_org_csvs(findings, output_dir)
    if "html" in formats:
        write_org_html(findings, output_dir)
    log.info(
        "Org audit complete: %d audited, %d skipped",
        len(findings.accounts),
        len(findings.accounts_skipped),
    )
    return findings
