"""Action items — structured next-step list per account.

The readiness scoring tells the customer "you're RED" but stops short of
"here's exactly what to do." This module turns the audit findings into an
itemized action list with priority, category, blocked-improvement, and
effort estimate. The list is rendered as `action-items.csv` so the
customer can drop it into Jira / Asana / their PM tool of choice.

Each action references one specific gap detected during the audit. The
generator is deliberately conservative — it does NOT recommend Tier 3
(vendor consolidation) unless Tier 1 + Tier 2 are already in place,
because doing them in the wrong order produces re-work.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass

from core.models import AccountFindings


@dataclass
class ActionItem:
    """One step on the customer's roadmap to per-principal cost attribution."""

    account_id: str
    account_name: str
    priority: int                  # 1 (highest) - 5 (lowest)
    category: str                  # "Tier 1 prereq" | "Tier 1 enable" | "Tier 2" | "Observability" | "Cleanup"
    action: str                    # The actual thing to do — concise imperative sentence
    blocks: str                    # What improvement this unlocks (e.g., "Tier 1 readiness GREEN")
    effort_estimate_hours: float   # Best-guess hours of work
    owner: str = ""                # Customer fills in (defaults to blank)
    due_date: str = ""             # Customer fills in (defaults to blank)
    notes: str = ""                # Optional extra context

    def to_dict(self) -> dict:
        return asdict(self)


# ---------------------------------------------------------------------------
# Generators — each returns 0+ ActionItem instances based on the findings
# ---------------------------------------------------------------------------


def _tier1_prereq_actions(f: AccountFindings) -> list[ActionItem]:
    """Tag-coverage and IAM-role decomposition prerequisites for Tier 1."""
    items: list[ActionItem] = []
    cov = f.tag_coverage
    n = cov.total_principals

    if n == 0:
        return items  # No principals to tag

    # Best tag coverage on any single dimension
    best_pct = max(
        cov.pct_with_team,
        cov.pct_with_cost_center,
        cov.pct_with_environment,
        cov.pct_with_project,
    )

    # Single shared role pattern — Tier 1 will produce flat attribution.
    if n == 1:
        items.append(
            ActionItem(
                account_id=f.account_id,
                account_name=f.account_name or "",
                priority=1,
                category="Tier 1 prereq",
                action=(
                    "Decompose the single shared IAM role into per-team / per-product roles. "
                    "Tier 1 IAM Principal Cost Tracking attributes by IAM principal — with one "
                    "role, every team's spend rolls up to the same line item."
                ),
                blocks="Per-team attribution (Tier 1 + Tier 2 both depend on this)",
                effort_estimate_hours=8.0,
                notes="Plan the role split with the affected teams before changing trust policies.",
            )
        )
    elif best_pct < 50:
        # Apply taxonomy
        n_to_tag = max(1, int(n * (100 - best_pct) / 100))
        items.append(
            ActionItem(
                account_id=f.account_id,
                account_name=f.account_name or "",
                priority=1,
                category="Tier 1 prereq",
                action=(
                    f"Apply organizational tags to ~{n_to_tag} of {n} Bedrock-capable IAM principals. "
                    f"Suggested taxonomy is in suggested-tags.csv (review and edit before applying). "
                    f"Use the generated setup-tier1.sh script as a starting point."
                ),
                blocks="Tier 1 readiness GREEN",
                effort_estimate_hours=4.0,
                notes=(
                    f"Current coverage: team={cov.pct_with_team:.0f}%, "
                    f"cost-center={cov.pct_with_cost_center:.0f}%, "
                    f"environment={cov.pct_with_environment:.0f}%, "
                    f"project={cov.pct_with_project:.0f}%. Target: >=50% on at least one."
                ),
            )
        )

    return items


def _tier1_enable_actions(f: AccountFindings) -> list[ActionItem]:
    """Activate IAM cost allocation tags + create CUR 2.0 export."""
    items: list[ActionItem] = []
    if not f.is_management_account:
        # Only the management account can activate cost allocation tags or
        # create a CUR 2.0 export. Mention it but don't make it actionable here.
        return items

    if not f.iam_principal_cost_tracking_likely_enabled:
        items.append(
            ActionItem(
                account_id=f.account_id,
                account_name=f.account_name or "",
                priority=2,
                category="Tier 1 enable",
                action=(
                    "Create a new CUR 2.0 data export with 'Include caller identity (IAM "
                    "principal) allocation data' enabled. Existing exports are not "
                    "retroactively patched — a new export is required."
                ),
                blocks="Per-principal spend attribution in Cost Explorer + CUR 2.0",
                effort_estimate_hours=1.0,
                notes=(
                    "Console path: Billing and Cost Management → Data Exports → Create. "
                    "Use the bcm-data-exports CLI command in setup-tier1.sh as an alternative."
                ),
            )
        )
        items.append(
            ActionItem(
                account_id=f.account_id,
                account_name=f.account_name or "",
                priority=2,
                category="Tier 1 enable",
                action=(
                    "Activate the relevant IAM principal cost allocation tags in the "
                    "Billing console. Filter by type 'IAM principal' and activate every "
                    "tag your org wants to slice spend by (team, cost-center, etc.)."
                ),
                blocks="Per-tag spend grouping in Cost Explorer",
                effort_estimate_hours=0.5,
                notes=(
                    "Tags only appear here AFTER the principal makes at least one Bedrock "
                    "call. New tag activation takes up to 24h to flow into Cost Explorer."
                ),
            )
        )

    return items


def _tier2_actions(f: AccountFindings) -> list[ActionItem]:
    """Application Inference Profile creation."""
    items: list[ActionItem] = []
    if f.tag_coverage.total_principals == 0:
        return items  # No Bedrock activity to attribute

    if not f.application_inference_profiles:
        items.append(
            ActionItem(
                account_id=f.account_id,
                account_name=f.account_name or "",
                priority=3,
                category="Tier 2",
                action=(
                    "Create one application inference profile per team / product boundary. "
                    "Tag each profile with cost allocation tags (team, cost-center, environment). "
                    "Update application code to call the profile ARN instead of the model ID."
                ),
                blocks="Per-team CloudWatch metrics + per-team Cost Explorer slicing",
                effort_estimate_hours=4.0,
                notes=(
                    "Tier 2 delivers value even before Tier 1 is fully tagged — the profile "
                    "carries its own cost allocation tags independent of IAM."
                ),
            )
        )

    return items


def _observability_actions(f: AccountFindings) -> list[ActionItem]:
    """Model invocation logging, CloudTrail data events."""
    items: list[ActionItem] = []
    if f.tag_coverage.total_principals == 0:
        return items

    n_logging_enabled = sum(1 for c in f.invocation_logging if c.enabled)
    if n_logging_enabled == 0:
        items.append(
            ActionItem(
                account_id=f.account_id,
                account_name=f.account_name or "",
                priority=4,
                category="Observability",
                action=(
                    "Enable Bedrock model invocation logging in the regions where Bedrock "
                    "is used. Pick CloudWatch Logs OR S3 as the destination. This captures "
                    "full request/response data, useful for debugging and audit."
                ),
                blocks="Full request/response visibility for compliance + debugging",
                effort_estimate_hours=1.0,
                notes=(
                    "Disabled by default. Console path: Bedrock → Settings → Model "
                    "invocation logging. CLI: PutModelInvocationLoggingConfiguration."
                ),
            )
        )

    bedrock_de_regions = [
        c.region for c in f.cloudtrail_coverage if c.has_bedrock_data_events
    ]
    if not bedrock_de_regions and f.cloudtrail_coverage:
        items.append(
            ActionItem(
                account_id=f.account_id,
                account_name=f.account_name or "",
                priority=5,
                category="Observability",
                action=(
                    "Add Bedrock data events to your CloudTrail trail's event selectors. "
                    "Without this, who-called-what is invisible in CloudTrail until Tier 1 "
                    "IAM Principal Cost Tracking is enabled."
                ),
                blocks="Per-call audit trail for compliance",
                effort_estimate_hours=0.5,
                notes=(
                    "High volume. Plan for the storage + ingestion cost increase before "
                    "enabling. CLI: PutEventSelectors with AWS::Bedrock::* resource types."
                ),
            )
        )

    return items


def generate_action_items(f: AccountFindings) -> list[ActionItem]:
    """Generate a prioritized action-item list for one account.

    Returns items sorted by (priority asc, category asc) so the most
    important things show up first in the CSV.
    """
    items: list[ActionItem] = []
    items.extend(_tier1_prereq_actions(f))
    items.extend(_tier1_enable_actions(f))
    items.extend(_tier2_actions(f))
    items.extend(_observability_actions(f))
    items.sort(key=lambda i: (i.priority, i.category))
    return items
