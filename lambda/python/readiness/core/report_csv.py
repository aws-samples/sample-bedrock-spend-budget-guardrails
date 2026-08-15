"""CSV report writers.

Produces flat, Excel-friendly CSV outputs for FinOps users who want to
slice and dice in a spreadsheet rather than read Markdown.

Account mode produces three per-account CSVs:
  - {account_id}-principals.csv  — one row per Bedrock-capable IAM principal
  - {account_id}-spend.csv       — one row per (model, input/output) cost line
  - {account_id}-profiles.csv    — one row per application inference profile

Org mode produces:
  - accounts.csv     — one row per audited account (the executive roll-up)
  - principals.csv   — combined across all accounts
  - spend.csv        — combined across all accounts
  - profiles.csv     — combined across all accounts
"""
from __future__ import annotations

# defusedcsv is a drop-in replacement for the stdlib csv module that neutralizes
# spreadsheet formula injection (CWE-1236): it prefixes any cell beginning with
# =, +, -, @ (etc.) so Excel/Sheets won't execute it. These reports embed
# operator-influenced strings (IAM principal names, ARNs, tag values) that later
# land in a spreadsheet, so we harden the writer here rather than trust the input.
from defusedcsv import csv
from pathlib import Path

from core.models import AccountFindings, OrgFindings


def _join_tags(tags: dict[str, str]) -> str:
    """Join a tag dict into a deterministic 'k1=v1;k2=v2' string for CSV cells."""
    return ";".join(f"{k}={v}" for k, v in sorted(tags.items()))


def write_account_csvs(findings: AccountFindings, output_dir: Path) -> list[Path]:
    """Write per-account CSV exports. Returns paths to the files created."""
    output_dir.mkdir(parents=True, exist_ok=True)
    paths: list[Path] = []

    # principals.csv
    p = output_dir / f"{findings.account_id}-principals.csv"
    with p.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(
            [
                "account_id",
                "arn",
                "name",
                "type",
                "is_identity_center_role",
                "permission_source",
                "tags",
            ]
        )
        for pr in findings.candidate_principals:
            w.writerow(
                [
                    findings.account_id,
                    pr.arn,
                    pr.name,
                    pr.principal_type,
                    pr.is_identity_center_role,
                    ";".join(pr.bedrock_permission_source),
                    _join_tags(pr.tags),
                ]
            )
    paths.append(p)

    # spend.csv
    p = output_dir / f"{findings.account_id}-spend.csv"
    with p.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["account_id", "model", "direction", "usage_type", "cost_usd"])
        for s in findings.spend_by_model:
            direction = "input" if s.is_input else "output"
            w.writerow(
                [findings.account_id, s.model_id, direction, s.usage_type, s.cost_usd]
            )
    paths.append(p)

    # model-usage.csv (CloudWatch — invocation + token counts, last 30d)
    p = output_dir / f"{findings.account_id}-model-usage.csv"
    with p.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(
            [
                "account_id",
                "region",
                "model_id",
                "days",
                "invocations",
                "input_tokens",
                "output_tokens",
                "throttles",
            ]
        )
        for u in findings.model_usage_30d:
            w.writerow(
                [
                    findings.account_id,
                    u.region,
                    u.model_id,
                    u.days,
                    u.invocations,
                    u.input_tokens,
                    u.output_tokens,
                    u.throttles,
                ]
            )
    paths.append(p)

    # profiles.csv
    p = output_dir / f"{findings.account_id}-profiles.csv"
    with p.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["account_id", "region", "name", "arn", "type", "tags"])
        for prof in findings.application_inference_profiles:
            w.writerow(
                [
                    findings.account_id,
                    prof.region,
                    prof.name,
                    prof.arn,
                    prof.type,
                    _join_tags(prof.tags),
                ]
            )
    paths.append(p)

    # agents.csv
    p = output_dir / f"{findings.account_id}-agents.csv"
    with p.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(
            [
                "account_id",
                "region",
                "agent_id",
                "name",
                "foundation_model",
                "status",
                "execution_role_arn",
                "tags",
            ]
        )
        for a in findings.agents:
            w.writerow(
                [
                    findings.account_id,
                    a.region,
                    a.agent_id,
                    a.name,
                    a.foundation_model,
                    a.status,
                    a.agent_resource_role_arn,
                    _join_tags(a.tags),
                ]
            )
    paths.append(p)

    # knowledge-bases.csv
    p = output_dir / f"{findings.account_id}-knowledge-bases.csv"
    with p.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["account_id", "region", "kb_id", "name", "status", "tags"])
        for k in findings.knowledge_bases:
            w.writerow(
                [
                    findings.account_id,
                    k.region,
                    k.kb_id,
                    k.name,
                    k.status,
                    _join_tags(k.tags),
                ]
            )
    paths.append(p)

    # action-items.csv — prioritized next-steps for THIS account
    p = output_dir / f"{findings.account_id}-action-items.csv"
    with p.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(
            [
                "account_id",
                "account_name",
                "priority",
                "category",
                "action",
                "blocks",
                "effort_estimate_hours",
                "owner",
                "due_date",
                "notes",
            ]
        )
        for ai in findings.action_items:
            w.writerow(
                [
                    ai.get("account_id", findings.account_id),
                    ai.get("account_name", findings.account_name or ""),
                    ai.get("priority", ""),
                    ai.get("category", ""),
                    ai.get("action", ""),
                    ai.get("blocks", ""),
                    ai.get("effort_estimate_hours", ""),
                    ai.get("owner", ""),
                    ai.get("due_date", ""),
                    ai.get("notes", ""),
                ]
            )
    paths.append(p)

    # suggested-tags.csv — taxonomy suggestions per principal
    p = output_dir / f"{findings.account_id}-suggested-tags.csv"
    with p.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(
            [
                "account_id",
                "principal_name",
                "principal_arn",
                "confidence",
                "suggested_tags",
                "reasoning",
            ]
        )
        for s in findings.tag_suggestions:
            w.writerow(
                [
                    findings.account_id,
                    s.get("name", ""),
                    s.get("arn", ""),
                    s.get("confidence", ""),
                    _join_tags(s.get("suggested_tags", {})),
                    s.get("reasoning", ""),
                ]
            )
    paths.append(p)

    return paths


def write_org_csvs(findings: OrgFindings, output_dir: Path) -> list[Path]:
    """Write org-level CSV exports. Returns paths to the files created."""
    output_dir.mkdir(parents=True, exist_ok=True)
    paths: list[Path] = []

    # accounts.csv — the executive roll-up, one row per account
    p = output_dir / "accounts.csv"
    with p.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(
            [
                "account_id",
                "account_name",
                "is_management_account",
                "readiness",
                "spend_30d_usd",
                "spend_90d_usd",
                "num_principals",
                "tag_coverage_team_pct",
                "tag_coverage_cost_center_pct",
                "tag_coverage_environment_pct",
                "tag_coverage_project_pct",
                "num_inference_profiles",
                "num_projects",
                "num_agents",
                "num_knowledge_bases",
                "num_custom_models",
                "num_guardrails",
                "num_provisioned_throughputs",
                "iam_principal_cur_enabled",
                "active_regions",
                "readiness_reasoning",
            ]
        )
        for a in findings.accounts:
            w.writerow(
                [
                    a.account_id,
                    a.account_name or "",
                    a.is_management_account,
                    a.readiness.value,
                    a.total_bedrock_spend_30d_usd,
                    a.total_bedrock_spend_90d_usd,
                    a.tag_coverage.total_principals,
                    a.tag_coverage.pct_with_team,
                    a.tag_coverage.pct_with_cost_center,
                    a.tag_coverage.pct_with_environment,
                    a.tag_coverage.pct_with_project,
                    len(a.application_inference_profiles),
                    len(a.projects),
                    len(a.agents),
                    len(a.knowledge_bases),
                    len(a.custom_models),
                    len(a.guardrails),
                    len(a.provisioned_throughputs),
                    a.iam_principal_cost_tracking_likely_enabled,
                    ";".join(a.bedrock_regions_with_activity),
                    a.readiness_reasoning,
                ]
            )
    paths.append(p)

    # principals.csv — combined across all accounts
    p = output_dir / "principals.csv"
    with p.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(
            [
                "account_id",
                "account_name",
                "arn",
                "name",
                "type",
                "is_identity_center_role",
                "permission_source",
                "tags",
            ]
        )
        for a in findings.accounts:
            for pr in a.candidate_principals:
                w.writerow(
                    [
                        a.account_id,
                        a.account_name or "",
                        pr.arn,
                        pr.name,
                        pr.principal_type,
                        pr.is_identity_center_role,
                        ";".join(pr.bedrock_permission_source),
                        _join_tags(pr.tags),
                    ]
                )
    paths.append(p)

    # spend.csv — combined across all accounts
    p = output_dir / "spend.csv"
    with p.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(
            [
                "account_id",
                "account_name",
                "model",
                "direction",
                "usage_type",
                "cost_usd",
            ]
        )
        for a in findings.accounts:
            for s in a.spend_by_model:
                direction = "input" if s.is_input else "output"
                w.writerow(
                    [
                        a.account_id,
                        a.account_name or "",
                        s.model_id,
                        direction,
                        s.usage_type,
                        s.cost_usd,
                    ]
                )
    paths.append(p)

    # model-usage.csv — CloudWatch metrics combined across all accounts
    p = output_dir / "model-usage.csv"
    with p.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(
            [
                "account_id",
                "account_name",
                "region",
                "model_id",
                "days",
                "invocations",
                "input_tokens",
                "output_tokens",
                "throttles",
            ]
        )
        for a in findings.accounts:
            for u in a.model_usage_30d:
                w.writerow(
                    [
                        a.account_id,
                        a.account_name or "",
                        u.region,
                        u.model_id,
                        u.days,
                        u.invocations,
                        u.input_tokens,
                        u.output_tokens,
                        u.throttles,
                    ]
                )
    paths.append(p)

    # profiles.csv — combined across all accounts
    p = output_dir / "profiles.csv"
    with p.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(
            [
                "account_id",
                "account_name",
                "region",
                "name",
                "arn",
                "type",
                "tags",
            ]
        )
        for a in findings.accounts:
            for prof in a.application_inference_profiles:
                w.writerow(
                    [
                        a.account_id,
                        a.account_name or "",
                        prof.region,
                        prof.name,
                        prof.arn,
                        prof.type,
                        _join_tags(prof.tags),
                    ]
                )
    paths.append(p)

    # agents.csv — combined across all accounts
    p = output_dir / "agents.csv"
    with p.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(
            [
                "account_id",
                "account_name",
                "region",
                "agent_id",
                "name",
                "foundation_model",
                "status",
                "execution_role_arn",
                "tags",
            ]
        )
        for a in findings.accounts:
            for ag in a.agents:
                w.writerow(
                    [
                        a.account_id,
                        a.account_name or "",
                        ag.region,
                        ag.agent_id,
                        ag.name,
                        ag.foundation_model,
                        ag.status,
                        ag.agent_resource_role_arn,
                        _join_tags(ag.tags),
                    ]
                )
    paths.append(p)

    # knowledge-bases.csv — combined across all accounts
    p = output_dir / "knowledge-bases.csv"
    with p.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(
            [
                "account_id",
                "account_name",
                "region",
                "kb_id",
                "name",
                "status",
                "tags",
            ]
        )
        for a in findings.accounts:
            for kb in a.knowledge_bases:
                w.writerow(
                    [
                        a.account_id,
                        a.account_name or "",
                        kb.region,
                        kb.kb_id,
                        kb.name,
                        kb.status,
                        _join_tags(kb.tags),
                    ]
                )
    paths.append(p)

    # action-items.csv — combined prioritized list across all accounts
    p = output_dir / "action-items.csv"
    with p.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(
            [
                "account_id",
                "account_name",
                "priority",
                "category",
                "action",
                "blocks",
                "effort_estimate_hours",
                "owner",
                "due_date",
                "notes",
            ]
        )
        for a in findings.accounts:
            for ai in a.action_items:
                w.writerow(
                    [
                        ai.get("account_id", a.account_id),
                        ai.get("account_name", a.account_name or ""),
                        ai.get("priority", ""),
                        ai.get("category", ""),
                        ai.get("action", ""),
                        ai.get("blocks", ""),
                        ai.get("effort_estimate_hours", ""),
                        ai.get("owner", ""),
                        ai.get("due_date", ""),
                        ai.get("notes", ""),
                    ]
                )
    paths.append(p)

    # suggested-tags.csv — combined taxonomy suggestions across all accounts
    p = output_dir / "suggested-tags.csv"
    with p.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(
            [
                "account_id",
                "account_name",
                "principal_name",
                "principal_arn",
                "confidence",
                "suggested_tags",
                "reasoning",
            ]
        )
        for a in findings.accounts:
            for s in a.tag_suggestions:
                w.writerow(
                    [
                        a.account_id,
                        a.account_name or "",
                        s.get("name", ""),
                        s.get("arn", ""),
                        s.get("confidence", ""),
                        _join_tags(s.get("suggested_tags", {})),
                        s.get("reasoning", ""),
                    ]
                )
    paths.append(p)

    return paths
