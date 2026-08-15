"""Render findings to JSON and Markdown.

Both modes use the same per-account renderer. Org mode adds a top-level
executive summary that aggregates across accounts.
"""
from __future__ import annotations

import json
from pathlib import Path

from core.models import AccountFindings, OrgFindings, Readiness


READINESS_BADGE = {
    Readiness.GREEN: "🟢 GREEN",
    Readiness.YELLOW: "🟡 YELLOW",
    Readiness.RED: "🔴 RED",
    Readiness.UNKNOWN: "⚪ UNKNOWN",
}


def write_account_json(findings: AccountFindings, output_dir: Path) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    path = output_dir / f"{findings.account_id}.json"
    path.write_text(json.dumps(findings.to_dict(), indent=2, default=str))
    return path


def render_account_markdown(findings: AccountFindings) -> str:
    lines: list[str] = []
    if findings.account_name and findings.account_name != findings.account_id:
        title = f"Bedrock Attribution Audit — {findings.account_name} ({findings.account_id})"
    else:
        title = f"Bedrock Attribution Audit — {findings.account_id}"
    lines.append(f"# {title}")
    lines.append("")
    lines.append(f"**Audit:** {findings.audit_started_at} → {findings.audit_completed_at}")
    if findings.is_management_account:
        lines.append("**Account role:** Organizations management account")
    lines.append(f"**Regions scanned:** {len(findings.regions_scanned)}")
    if findings.bedrock_regions_with_activity:
        lines.append(
            f"**Bedrock activity in:** {', '.join(findings.bedrock_regions_with_activity)}"
        )
    lines.append("")

    # Verdict
    lines.append(f"## Tier 1 readiness: {READINESS_BADGE[findings.readiness]}")
    lines.append("")
    if findings.readiness_reasoning:
        lines.append(findings.readiness_reasoning)
        lines.append("")

    # Compared to last run
    if findings.previous_run and findings.deltas_vs_previous:
        prev_started = findings.previous_run.get("audit_started_at", "")
        history_count = findings.audit_history_count
        lines.append("## Compared to last run")
        lines.append("")
        lines.append(
            f"This is audit **#{history_count}** for this account. "
            f"Last run: `{prev_started}`. "
            f"{len(findings.deltas_vs_previous)} metric(s) changed:"
        )
        lines.append("")
        lines.append("| Metric | Previous | Now | Direction |")
        lines.append("|---|---|---|---|")
        arrow = {"up": "↑", "down": "↓", "same": "—"}
        for d in findings.deltas_vs_previous:
            arr = arrow.get(d["direction"], "—")
            lines.append(
                f"| {d['label']} | {d['previous']} | {d['current']} | {arr} |"
            )
        lines.append("")
    elif findings.audit_history_count == 1:
        lines.append("## First audit for this account")
        lines.append("")
        lines.append(
            "No prior history found. Re-run the audit later (using the same output "
            "directory) and the next report will show what changed since today."
        )
        lines.append("")

    # Spend
    lines.append("## Spend")
    lines.append("")
    if findings.spend_attribution_status == "by-principal":
        lines.append("**Attribution status:** 🟢 Per-principal data available (Tier 1 IAM Principal Cost Tracking enabled)")
    else:
        lines.append(
            "**Attribution status:** 🟡 Account-level only — per-principal spend "
            "is not yet available. To unlock it, enable [Bedrock IAM Principal Cost "
            "Tracking](https://docs.aws.amazon.com/bedrock/latest/userguide/cost-mgmt-iam-principal-tracking.html) "
            "at the management account and create a CUR 2.0 export with caller identity included."
        )
    lines.append("")
    lines.append(f"- Last 30 days: **${findings.total_bedrock_spend_30d_usd:,.2f}**")
    lines.append(f"- Last 90 days: **${findings.total_bedrock_spend_90d_usd:,.2f}**")
    lines.append("")

    if findings.spend_by_model:
        # Aggregate input/output per model
        agg: dict[str, dict[str, float]] = {}
        for row in findings.spend_by_model:
            slot = "input" if row.is_input else "output"
            d = agg.setdefault(row.model_id, {"input": 0.0, "output": 0.0})
            d[slot] += row.cost_usd

        lines.append("### Spend by model (90d) — Cost Explorer")
        lines.append("")
        lines.append("| Model | Input cost | Output cost | Total |")
        lines.append("|---|---:|---:|---:|")
        for model, costs in sorted(agg.items(), key=lambda kv: -sum(kv[1].values())):
            total = costs["input"] + costs["output"]
            lines.append(
                f"| `{model}` | ${costs['input']:,.2f} | ${costs['output']:,.2f} | ${total:,.2f} |"
            )
        lines.append("")

    if findings.model_usage_30d:
        lines.append("### Model usage (30d) — CloudWatch metrics")
        lines.append("")
        lines.append(
            "_Independent signal: invocation counts and token volumes pulled from "
            "`AWS/Bedrock` CloudWatch metrics. Cross-check against the spend table "
            "above — the math should line up at published model rates._"
        )
        lines.append("")
        lines.append("| Model | Region | Invocations | Input tokens | Output tokens | Throttles |")
        lines.append("|---|---|---:|---:|---:|---:|")
        for u in sorted(findings.model_usage_30d, key=lambda m: -m.invocations):
            lines.append(
                f"| `{u.model_id}` | {u.region} "
                f"| {u.invocations:,} | {u.input_tokens:,} | {u.output_tokens:,} | {u.throttles:,} |"
            )
        lines.append("")

    # Principals
    lines.append("## Bedrock-capable IAM principals")
    lines.append("")
    n = findings.tag_coverage.total_principals
    lines.append(f"Total: **{n}** roles + users with `bedrock:*` permission grants")
    if n:
        cov = findings.tag_coverage
        lines.append("")
        lines.append("**Tag coverage** (% of principals with a given tag key):")
        lines.append("")
        lines.append("| Tag | Coverage |")
        lines.append("|---|---:|")
        lines.append(f"| `team` | {cov.pct_with_team:.0f}% |")
        lines.append(f"| `cost-center` | {cov.pct_with_cost_center:.0f}% |")
        lines.append(f"| `environment` | {cov.pct_with_environment:.0f}% |")
        lines.append(f"| `project` | {cov.pct_with_project:.0f}% |")
        lines.append("")

        if cov.distinct_team_values:
            lines.append(
                f"**Distinct `team` values found:** {', '.join('`'+v+'`' for v in cov.distinct_team_values)}"
            )
            lines.append("")
        if cov.distinct_cost_center_values:
            lines.append(
                f"**Distinct cost-center values found:** {', '.join('`'+v+'`' for v in cov.distinct_cost_center_values)}"
            )
            lines.append("")

        # Top 10 principals by name
        lines.append("**Top principals by name (first 10):**")
        lines.append("")
        lines.append("| ARN | Type | Identity Center? | Tags |")
        lines.append("|---|---|---|---|")
        for p in findings.candidate_principals[:10]:
            tags = ", ".join(f"{k}={v}" for k, v in sorted(p.tags.items())) or "_(none)_"
            ic = "yes" if p.is_identity_center_role else ""
            lines.append(f"| `{p.arn}` | {p.principal_type} | {ic} | {tags} |")
        if len(findings.candidate_principals) > 10:
            lines.append(f"| _… +{len(findings.candidate_principals)-10} more_ | | | |")
        lines.append("")

    # Bedrock resources
    lines.append("## Existing Bedrock cost-attribution resources")
    lines.append("")
    n_profiles = len(findings.application_inference_profiles)
    n_projects = len(findings.projects)
    n_logging = sum(1 for c in findings.invocation_logging if c.enabled)
    n_agents = len(findings.agents)
    n_kbs = len(findings.knowledge_bases)
    n_custom = len(findings.custom_models)
    n_guardrails = len(findings.guardrails)
    n_pt = len(findings.provisioned_throughputs)
    lines.append(f"- Application inference profiles (Tier 2): **{n_profiles}**")
    lines.append(f"- Bedrock Projects (mantle endpoint): **{n_projects}**")
    lines.append(f"- Regions with model invocation logging enabled: **{n_logging}**")
    lines.append(
        f"- CUR 2.0 export with IAM principal data: "
        f"**{'yes' if findings.iam_principal_cost_tracking_likely_enabled else 'no'}**"
    )
    lines.append(f"- Bedrock Agents: **{n_agents}**")
    lines.append(f"- Knowledge Bases: **{n_kbs}**")
    lines.append(f"- Custom models: **{n_custom}**")
    lines.append(f"- Guardrails: **{n_guardrails}**")
    lines.append(f"- Provisioned Throughput: **{n_pt}**")
    lines.append("")

    if findings.application_inference_profiles:
        lines.append("### Inference profiles")
        lines.append("")
        lines.append("| Region | Name | Tags |")
        lines.append("|---|---|---|")
        for prof in findings.application_inference_profiles:
            tags = ", ".join(f"{k}={v}" for k, v in sorted(prof.tags.items())) or "_(none)_"
            lines.append(f"| {prof.region} | `{prof.name}` | {tags} |")
        lines.append("")

    if findings.agents:
        lines.append("### Bedrock Agents")
        lines.append("")
        lines.append("| Region | Name | Foundation model | Status | Execution role | Tags |")
        lines.append("|---|---|---|---|---|---|")
        for a in findings.agents:
            tags = ", ".join(f"{k}={v}" for k, v in sorted(a.tags.items())) or "_(none)_"
            lines.append(
                f"| {a.region} | `{a.name}` | `{a.foundation_model}` "
                f"| {a.status} | `{a.agent_resource_role_arn}` | {tags} |"
            )
        lines.append("")

    if findings.knowledge_bases:
        lines.append("### Knowledge Bases")
        lines.append("")
        lines.append("| Region | Name | ID | Status | Tags |")
        lines.append("|---|---|---|---|---|")
        for k in findings.knowledge_bases:
            tags = ", ".join(f"{tk}={tv}" for tk, tv in sorted(k.tags.items())) or "_(none)_"
            lines.append(
                f"| {k.region} | `{k.name}` | {k.kb_id} | {k.status} | {tags} |"
            )
        lines.append("")

    # CloudTrail coverage
    bedrock_data_event_regions = [
        c.region for c in findings.cloudtrail_coverage if c.has_bedrock_data_events
    ]
    if bedrock_data_event_regions:
        lines.append(
            f"**CloudTrail Bedrock data events captured in:** {', '.join(bedrock_data_event_regions)}"
        )
    else:
        lines.append(
            "**CloudTrail Bedrock data events:** _not enabled in any inspected region._ "
            "Bedrock InvokeModel/Converse calls are data events that require explicit opt-in. "
            "Without this, who-called-what is invisible until Tier 1 IAM Principal Cost Tracking is set up."
        )
    lines.append("")

    # Recommendations
    if findings.recommendations:
        lines.append("## Recommendations")
        lines.append("")
        for r in findings.recommendations:
            lines.append(f"1. {r}")
        lines.append("")

    # Warnings
    if findings.warnings:
        lines.append("## Warnings")
        lines.append("")
        for w in findings.warnings:
            lines.append(f"- ⚠️  {w}")
        lines.append("")

    return "\n".join(lines)


def write_account_markdown(findings: AccountFindings, output_dir: Path) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    path = output_dir / f"{findings.account_id}.md"
    path.write_text(render_account_markdown(findings))
    return path


def render_org_summary(findings: OrgFindings) -> str:
    """Top-level executive summary for an org-level audit."""
    lines: list[str] = []
    lines.append("# Bedrock Attribution Audit — Organization Summary")
    lines.append("")
    lines.append(f"**Management account:** {findings.management_account_id}")
    if findings.organization_id:
        lines.append(f"**Organization ID:** {findings.organization_id}")
    lines.append(f"**Audit:** {findings.audit_started_at} → {findings.audit_completed_at}")
    lines.append(f"**Accounts audited:** {len(findings.accounts)}")
    if findings.accounts_skipped:
        lines.append(f"**Accounts skipped:** {len(findings.accounts_skipped)} _(see below)_")
    lines.append("")
    lines.append(
        f"**Total Bedrock spend (last 30d):** ${findings.total_org_bedrock_spend_30d_usd:,.2f}"
    )
    lines.append(
        f"**Total Bedrock spend (last 90d):** ${findings.total_org_bedrock_spend_90d_usd:,.2f}"
    )
    lines.append("")

    # Per-account roll-up table
    lines.append("## Per-account roll-up")
    lines.append("")
    lines.append("| Account | Name | Readiness | 90d spend | # principals | Profiles | Projects |")
    lines.append("|---|---|---|---:|---:|---:|---:|")
    sorted_accounts = sorted(
        findings.accounts, key=lambda a: -a.total_bedrock_spend_90d_usd
    )
    for a in sorted_accounts:
        lines.append(
            f"| `{a.account_id}` "
            f"| {a.account_name or ''} "
            f"| {READINESS_BADGE[a.readiness]} "
            f"| ${a.total_bedrock_spend_90d_usd:,.2f} "
            f"| {a.tag_coverage.total_principals} "
            f"| {len(a.application_inference_profiles)} "
            f"| {len(a.projects)} |"
        )
    lines.append("")

    if findings.accounts_skipped:
        lines.append("## Skipped accounts")
        lines.append("")
        for s in findings.accounts_skipped:
            lines.append(f"- `{s.get('account_id','?')}` — {s.get('reason','unknown')}")
        lines.append("")

    # Prioritization
    lines.append("## Prioritization for Tier 1 onboarding")
    lines.append("")
    green = [a for a in findings.accounts if a.readiness == Readiness.GREEN]
    yellow = [a for a in findings.accounts if a.readiness == Readiness.YELLOW]
    red = [a for a in findings.accounts if a.readiness == Readiness.RED]
    lines.append(f"- 🟢 **{len(green)} accounts** ready to enable Tier 1 immediately")
    lines.append(f"- 🟡 **{len(yellow)} accounts** need a tagging cleanup before Tier 1 delivers value")
    lines.append(f"- 🔴 **{len(red)} accounts** should adopt Tier 2 (inference profiles) first")
    lines.append("")

    return "\n".join(lines)


def write_org_json(findings: OrgFindings, output_dir: Path) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    path = output_dir / "org-summary.json"
    path.write_text(json.dumps(findings.to_dict(), indent=2, default=str))
    return path


def write_org_markdown(findings: OrgFindings, output_dir: Path) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    path = output_dir / "org-summary.md"
    path.write_text(render_org_summary(findings))
    return path


def write_org_artifacts(findings: OrgFindings, output_dir: Path) -> tuple[Path, Path]:
    """Backward-compat: writes both org-summary.json and org-summary.md."""
    return (
        write_org_json(findings, output_dir),
        write_org_markdown(findings, output_dir),
    )
