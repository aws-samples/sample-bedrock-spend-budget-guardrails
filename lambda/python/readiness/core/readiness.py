"""Compute the GREEN/YELLOW/RED Tier 1 readiness score for an account.

Scoring is intentionally simple and explainable — Joel and Matt should be
able to defend each color in a 30-second conversation with leadership.

Inputs that move the score:
  - # distinct candidate principals (roles + users with Bedrock perms)
  - % of those principals that carry common org tags (team, cost-center, etc.)
  - Presence of an existing CUR 2.0 export with IAM principal data
  - Whether any application inference profiles exist (Tier 2 already started)

Pre-Tier-1, candidate principals are a heuristic: anyone with Bedrock perms.
Once IAM Principal Cost Tracking is enabled and the CUR has flowed for a
billing cycle, this can be swapped for actual caller identity counts.
"""
from __future__ import annotations

from core.models import AccountFindings, Readiness, TagCoverage


def score_account(findings: AccountFindings) -> tuple[Readiness, str, list[str]]:
    """Return (readiness, reasoning, recommendations)."""
    n_principals = findings.tag_coverage.total_principals
    coverage = findings.tag_coverage
    has_profiles = bool(findings.application_inference_profiles)
    has_cur = findings.iam_principal_cost_tracking_likely_enabled

    if findings.total_bedrock_spend_90d_usd < 1.0 and n_principals == 0:
        return (
            Readiness.UNKNOWN,
            "No Bedrock spend or capable principals detected — nothing to attribute yet.",
            [
                "Skip Tier 1/Tier 2 setup for this account; revisit after the team starts using Bedrock."
            ],
        )

    # Compute a tag-coverage best signal — max % across the four common keys.
    best_tag_pct = max(
        coverage.pct_with_team,
        coverage.pct_with_cost_center,
        coverage.pct_with_environment,
        coverage.pct_with_project,
    )

    recs: list[str] = []
    reasons: list[str] = []

    # GREEN: enough role diversity AND decent tag coverage on at least one key
    if n_principals >= 3 and best_tag_pct >= 50:
        reasons.append(
            f"{n_principals} distinct Bedrock-capable principals with {best_tag_pct:.0f}% tag coverage."
        )
        if has_cur:
            reasons.append("CUR 2.0 export with IAM principal data is already configured.")
            recs.append(
                "Activate IAM principal cost allocation tags in the Billing console — "
                "you already have everything else."
            )
        else:
            recs.append(
                "Enable Tier 1: create a new CUR 2.0 export with the 'Include caller identity' "
                "option, then activate the relevant IAM principal cost allocation tags."
            )
        if not has_profiles:
            recs.append(
                "Plan Tier 2: create application inference profiles per team/product to get "
                "per-team CloudWatch metrics and tag-based attribution."
            )
        return (Readiness.GREEN, " ".join(reasons), recs)

    # RED: single shared role OR no tagging at all
    if n_principals <= 1:
        reasons.append(
            f"Only {n_principals} Bedrock-capable principal(s) detected — Tier 1 will produce a flat attribution."
        )
        recs.append(
            "Decompose the single shared role into per-team / per-product roles OR adopt "
            "Tier 2 application inference profiles to introduce attribution boundaries before "
            "investing in Tier 1 setup."
        )
        return (Readiness.RED, " ".join(reasons), recs)

    if best_tag_pct < 10 and n_principals >= 3:
        reasons.append(
            f"{n_principals} principals but ~{best_tag_pct:.0f}% tag coverage — Tier 1 will "
            f"attribute by ARN only, with no team or cost-center grouping."
        )
        recs.append(
            "Define a tagging taxonomy (team, cost-center, environment) and apply it to the "
            "Bedrock-capable principals before enabling Tier 1, OR start with Tier 2 inference "
            "profiles which carry their own cost allocation tags independent of IAM."
        )
        return (Readiness.RED, " ".join(reasons), recs)

    # YELLOW: everything else — some signal, some gaps
    reasons.append(
        f"{n_principals} Bedrock-capable principals, best tag coverage {best_tag_pct:.0f}% "
        f"on a single dimension."
    )
    if best_tag_pct < 50:
        recs.append(
            "Improve tag coverage to >=50% on at least one organizational dimension "
            "(team, cost-center, environment, or project)."
        )
    if not has_cur:
        recs.append(
            "Plan a fresh CUR 2.0 export with caller identity enabled — existing exports are not retroactive."
        )
    if not has_profiles:
        recs.append(
            "Pilot a single application inference profile per team in parallel — Tier 2 "
            "delivers value even before Tier 1 is fully tagged."
        )
    return (Readiness.YELLOW, " ".join(reasons), recs)


def populate_readiness(findings: AccountFindings) -> AccountFindings:
    """Mutate `findings` in place to fill readiness, reasoning, and recommendations."""
    readiness, reasoning, recs = score_account(findings)
    findings.readiness = readiness
    findings.readiness_reasoning = reasoning
    findings.recommendations.extend(recs)
    return findings
