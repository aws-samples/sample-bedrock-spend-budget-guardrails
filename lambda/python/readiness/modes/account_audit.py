"""Single-account Bedrock discovery.

Runs all read-only checks in the current account using the caller's
existing credentials. No assume-role, no Organizations API.

Two entry points:
  - ``discover_account(ctx)`` — pure discovery + readiness scoring. No disk
    writes, no run-history, no setup-script generation. Returns a single
    ``AccountFindings``. This is the seam the BBG Readiness Lambda calls; the
    handler returns ``findings.to_dict()`` straight to the API.
  - ``audit_current_account(...)`` — the CLI wrapper. Calls ``discover_account``
    then layers run-history, the setup-tier1 script, and report artifacts
    ({output_dir}/{account_id}.json|.md|.csv|.html) on top.
"""
from __future__ import annotations

import logging
from pathlib import Path

from core.auth import (
    DEFAULT_BEDROCK_REGIONS,
    SessionContext,
    build_local_session,
    is_management_account,
)
from core.bedrock_inventory import inventory_all_regions, regions_with_bedrock_activity
from core.cloudtrail import cloudtrail_coverage_all_regions, list_cur_exports
from core.cloudwatch_bedrock import model_usage_all_regions
from core.cost_explorer import (
    bedrock_spend_by_usage_type,
    total_bedrock_spend,
)
from core.history import (
    compute_deltas,
    history_path,
    load_history,
    load_previous_run,
    record_run,
)
from core.action_items import generate_action_items
from core.setup_script import write_setup_script
from core.taxonomy import aggregate_suggested_dimensions, suggest_taxonomy
from core.iam_inventory import compute_tag_coverage, find_bedrock_capable_principals
from core.models import AccountFindings, now_iso
from core.readiness import populate_readiness
from core.report import write_account_json, write_account_markdown
from core.report_csv import write_account_csvs
from core.report_html import write_account_html

log = logging.getLogger(__name__)


def discover_account(
    ctx: SessionContext,
    regions: list[str] | None = None,
    account_name_hint: str | None = None,
) -> AccountFindings:
    """Run all read-only Bedrock discovery + readiness scoring for the
    account behind ``ctx`` and return the populated findings.

    This is the pure, side-effect-free core of an account audit: no disk
    writes, no run-history, no setup-script generation. It is the entry
    point the BBG Readiness Lambda invokes — the handler can return
    ``discover_account(ctx).to_dict()`` directly to the API with no
    filesystem round-trip. The CLI wrapper ``audit_current_account`` layers
    history + report artifacts on top of this.

    Parameters
    ----------
    ctx
        A built session context (local credential chain or an assumed-role
        child session from org mode). Required — callers that need to build
        a session from a profile should use ``audit_current_account`` or
        build one via ``core.auth.build_local_session`` first.
    regions
        Bedrock regions to scan. Defaults to DEFAULT_BEDROCK_REGIONS.
    account_name_hint
        Friendly account name to embed in the report. When None and the
        caller is a management account, a "use org-audit" warning is added.
    """
    regions = regions or DEFAULT_BEDROCK_REGIONS

    started = now_iso()
    log.info("Starting account audit for %s (caller=%s)", ctx.account_id, ctx.caller_arn)

    findings = AccountFindings(
        account_id=ctx.account_id,
        account_name=account_name_hint,
        is_management_account=is_management_account(ctx),
        audit_started_at=started,
        audit_completed_at=None,
        regions_scanned=regions,
        bedrock_regions_with_activity=[],
    )

    # Detect parent-organization context. describe-organization works from
    # any account in the org (including member accounts) and returns the
    # org id + management/payer account id. Falls through silently for
    # standalone accounts or when the caller lacks organizations:Describe*.
    try:
        org_resp = ctx.client("organizations").describe_organization()
        org_meta = org_resp.get("Organization", {}) or {}
        findings.parent_organization_id = org_meta.get("Id")
        findings.parent_management_account_id = org_meta.get("MasterAccountId")
    except Exception as e:  # noqa: BLE001
        log.debug("describe-organization unavailable for this caller: %s", e)

    # If the user pointed account-audit at a management account, they may not
    # realize they're only seeing the payer's own resources, not the linked
    # accounts. Warn them visibly so they can switch to org-audit if needed.
    # Skip the warning when called from inside org-audit (account_name_hint
    # is set in that path because the org-audit loop pre-fetches names).
    if findings.is_management_account and account_name_hint is None:
        org_member_count: int | None = None
        try:
            org = ctx.client("organizations")
            paginator = org.get_paginator("list_accounts")
            org_member_count = sum(
                1
                for page in paginator.paginate()
                for a in (page.get("Accounts", []) or [])
                if a.get("Status") == "ACTIVE"
            )
        except Exception as e:  # noqa: BLE001
            log.debug("Could not count org members: %s", e)

        members_phrase = (
            f" ({org_member_count} active linked accounts in this org)"
            if org_member_count and org_member_count > 1
            else ""
        )
        warning_text = (
            f"This is the Organizations management account{members_phrase}. "
            f"`account-audit` only audits the payer's own resources — to audit "
            f"every linked account in the organization, use `org-audit` instead "
            f"(or pick option 2 in `bedrock-attribution-audit run`)."
        )
        log.warning(warning_text)
        findings.warnings.append(warning_text)

    # 1. Spend (Cost Explorer)
    log.info("Querying Cost Explorer...")
    findings.total_bedrock_spend_30d_usd = round(total_bedrock_spend(ctx, days=30), 2)
    findings.total_bedrock_spend_90d_usd = round(total_bedrock_spend(ctx, days=90), 2)
    findings.spend_by_model = bedrock_spend_by_usage_type(ctx, days=90)

    # 2. Active regions (CloudWatch metric existence)
    log.info("Detecting Bedrock activity per region...")
    findings.bedrock_regions_with_activity = regions_with_bedrock_activity(ctx, regions)

    # 3. IAM principal inventory + tag coverage
    log.info("Enumerating Bedrock-capable IAM principals...")
    findings.candidate_principals = find_bedrock_capable_principals(ctx)
    findings.tag_coverage = compute_tag_coverage(findings.candidate_principals)

    # 4. Bedrock resources (profiles, projects, agents, KBs, custom models, guardrails,
    # provisioned throughput, logging config) per region.
    # Limit to regions where there's actual activity if any were found,
    # else scan the full default list (maybe pre-launch — capture readiness anyway).
    inventory_regions = findings.bedrock_regions_with_activity or regions
    log.info("Inventorying Bedrock resources across %d regions...", len(inventory_regions))
    (
        profiles,
        projects,
        logging_configs,
        agents,
        knowledge_bases,
        custom_models,
        guardrails,
        provisioned_throughputs,
    ) = inventory_all_regions(ctx, inventory_regions)
    findings.application_inference_profiles = profiles
    findings.projects = projects
    findings.invocation_logging = logging_configs
    findings.agents = agents
    findings.knowledge_bases = knowledge_bases
    findings.custom_models = custom_models
    findings.guardrails = guardrails
    findings.provisioned_throughputs = provisioned_throughputs

    # If we found agents but no Bedrock activity in a region (because spend
    # may not have hit yet), surface those regions as having activity too.
    agent_regions = {a.region for a in agents}
    kb_regions = {k.region for k in knowledge_bases}
    extra_active = (agent_regions | kb_regions) - set(findings.bedrock_regions_with_activity)
    if extra_active:
        findings.bedrock_regions_with_activity = sorted(
            set(findings.bedrock_regions_with_activity) | extra_active
        )

    # 5. CloudTrail data event coverage
    log.info("Checking CloudTrail data event coverage...")
    findings.cloudtrail_coverage = cloudtrail_coverage_all_regions(ctx, inventory_regions)

    # 6. CUR exports (only meaningful at management account)
    if findings.is_management_account:
        log.info("Listing CUR 2.0 / Data Exports configurations...")
        findings.cur_exports = list_cur_exports(ctx)
        findings.iam_principal_cost_tracking_likely_enabled = any(
            e.includes_iam_principal for e in findings.cur_exports
        )
    else:
        findings.warnings.append(
            "CUR 2.0 export configuration is only visible from the Organizations management "
            "account. Run `org-audit` from the payer to confirm Tier 1 prerequisite is in place."
        )

    # 7. Compute spend-attribution status — can we attribute spend to principals yet?
    findings.spend_attribution_status = (
        "by-principal"
        if findings.iam_principal_cost_tracking_likely_enabled
        else "by-account-only"
    )

    # 8. CloudWatch model usage (independent signal for cost validation)
    log.info("Pulling CloudWatch Bedrock metrics (last 30d)...")
    if inventory_regions:
        findings.model_usage_30d = model_usage_all_regions(
            ctx, inventory_regions, days=30
        )

    # 9. Score readiness + recommendations
    populate_readiness(findings)

    findings.audit_completed_at = now_iso()

    # 9b. Tagging taxonomy suggestions (advisory; never auto-applied)
    log.info("Generating tagging taxonomy suggestions...")
    suggestions = suggest_taxonomy(findings.candidate_principals)
    findings.tag_suggestions = [s.to_dict() for s in suggestions]
    findings.suggested_tag_dimensions = aggregate_suggested_dimensions(suggestions)

    # 9c. Action items — turn the readiness gaps into a prioritized work list
    log.info("Building action-items list...")
    actions = generate_action_items(findings)
    findings.action_items = [a.to_dict() for a in actions]

    return findings


def audit_current_account(
    ctx: SessionContext | None = None,
    profile: str | None = None,
    regions: list[str] | None = None,
    output_dir: Path | None = None,
    account_name_hint: str | None = None,
    formats: list[str] | None = None,
) -> AccountFindings:
    """Run a single-account Bedrock discovery audit and write artifacts.

    Thin CLI/file-emitting wrapper around :func:`discover_account`. The
    discovery + scoring all happens in ``discover_account``; this function
    adds the side effects the CLI needs (run-history persistence, the
    setup-tier1 shell script, and the json/markdown/csv/html reports).

    Parameters
    ----------
    ctx
        Pre-built session context. If None, builds one from the local
        credential chain (or `profile` if given).
    profile
        Optional named AWS profile to use for credentials.
    regions
        Bedrock regions to scan. Defaults to DEFAULT_BEDROCK_REGIONS.
    output_dir
        Where to write report files. Defaults to ./output.
    account_name_hint
        Friendly account name to embed in the report. If None, the
        management account will be detected and the org's name used; for
        member accounts called outside org mode this is just the ID.
    formats
        Output formats to write. Any of {"json", "markdown", "csv", "html"}.
        Defaults to {"json", "markdown"}.
    """
    if ctx is None:
        ctx = build_local_session(profile=profile)
    regions = regions or DEFAULT_BEDROCK_REGIONS
    output_dir = output_dir or Path("./output")
    formats = formats or ["json", "markdown"]

    # Pure discovery + scoring (the Lambda-safe core).
    findings = discover_account(
        ctx, regions=regions, account_name_hint=account_name_hint
    )

    # 9d. Setup script — emit setup-tier1.sh the customer can review and run.
    # The renderer needs the TagSuggestion objects (not the serialized dicts
    # stored on findings). suggest_taxonomy is pure + deterministic over the
    # already-collected principals, so recomputing here is cheap and lets
    # discover_account keep a single AccountFindings return type.
    log.info("Generating setup-tier1 shell script...")
    suggestions = suggest_taxonomy(findings.candidate_principals)
    _, setup_script_content = write_setup_script(findings, suggestions, output_dir)

    # 9a. Run history — load previous run, record this run, compute deltas.
    # History lives in <output_dir>/.history/<account_id>.jsonl by default.
    # If the user re-uses the same output_dir between audits, history accumulates.
    history_dir = output_dir / ".history"
    previous = load_previous_run(
        history_dir, findings.account_id, findings.audit_started_at
    )
    if previous:
        from dataclasses import asdict as _asdict
        from core.history import _snapshot_from_findings

        cur_snap = _snapshot_from_findings(findings)
        deltas = compute_deltas(previous, cur_snap)
        findings.previous_run = _asdict(previous)
        findings.deltas_vs_previous = [_asdict(d) for d in deltas]
        log.info(
            "Found previous audit on %s — %d metrics changed",
            previous.audit_started_at,
            len(deltas),
        )
    else:
        log.info("No previous audit history found — this is the first run for this account")

    # Record this run AFTER computing deltas so we don't compare against ourselves
    record_run(findings, history_dir)
    findings.audit_history_count = len(load_history(history_dir, findings.account_id))

    # 10. Write artifacts
    if "json" in formats:
        write_account_json(findings, output_dir)
    if "markdown" in formats:
        write_account_markdown(findings, output_dir)
    if "csv" in formats:
        write_account_csvs(findings, output_dir)
    if "html" in formats:
        write_account_html(findings, output_dir, setup_script_content)
    log.info("Account audit complete: %s", findings.readiness.value)
    return findings
