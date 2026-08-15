"""Shared dataclasses for discovery findings.

The same models are used by both `account-audit` and `org-audit`. A single
account's audit produces an `AccountFindings` object; the org-level audit
wraps a list of these in `OrgFindings`.
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from datetime import datetime
from enum import Enum
from typing import Any


class Readiness(str, Enum):
    """Per-account readiness for Tier 1 IAM Principal Cost Tracking."""

    GREEN = "GREEN"   # >=3 distinct calling principals AND >=50% tag coverage
    YELLOW = "YELLOW"  # mixed signals — needs cleanup before Tier 1 delivers value
    RED = "RED"        # single shared role or no tagging — Tier 2 (inference profiles) first
    UNKNOWN = "UNKNOWN"  # insufficient data to score (e.g., no Bedrock activity yet)


@dataclass
class SpendByModel:
    model_id: str          # parsed from CUR usage type (e.g., "Anthropic.Claude-3-5-Sonnet")
    usage_type: str        # raw usage type string from Cost Explorer
    cost_usd: float
    is_input: bool         # input vs output token cost line


@dataclass
class ModelUsage:
    """Per-model usage from CloudWatch metrics — independent of billing data.

    Used as a second signal alongside Cost Explorer to validate cost numbers.
    """
    model_id: str
    region: str
    days: int = 30
    invocations: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    throttles: int = 0


@dataclass
class IamPrincipalCandidate:
    """An IAM role or user that has bedrock:* permission grants.

    Pre-Tier-1, this is our best heuristic for 'who could be calling Bedrock'.
    Once IAM Principal Cost Tracking is enabled and CUR 2.0 has the principal
    column, we can replace this with actual caller identity data.
    """
    arn: str
    name: str
    principal_type: str    # "role" | "user"
    tags: dict[str, str] = field(default_factory=dict)
    bedrock_permission_source: list[str] = field(default_factory=list)  # policy names
    is_identity_center_role: bool = False  # AWSReservedSSO_* pattern
    # How Bedrock access was granted: "explicit" (a named bedrock:/
    # bedrock-runtime: action) or "broad" (only via the "*" admin wildcard).
    # Explicit is the stronger attribution signal; broad is usually an
    # admin/infra role that merely *could* call Bedrock.
    access_via: str = "explicit"


@dataclass
class InferenceProfileSummary:
    arn: str
    name: str
    region: str
    type: str   # "APPLICATION" | "SYSTEM_DEFINED"
    tags: dict[str, str] = field(default_factory=dict)
    model_source: str = ""


@dataclass
class ProjectSummary:
    """Bedrock Project (bedrock-mantle attribution mechanism)."""
    project_id: str
    name: str
    region: str
    tags: dict[str, str] = field(default_factory=dict)


@dataclass
class AgentSummary:
    """Bedrock Agent — typically created via bedrock-agent:CreateAgent.

    Surfacing these directly because:
      1. Agent invocations may not have generated billable spend yet
      2. Each agent has an execution role that is itself a Bedrock-capable
         IAM principal — so it should be tagged for Tier 1
      3. Agent foundation_model tells us which models are wired up
      4. Agents may be tagged separately from their underlying invocations
    """
    agent_id: str
    name: str
    region: str
    foundation_model: str = ""
    agent_resource_role_arn: str = ""
    status: str = ""
    tags: dict[str, str] = field(default_factory=dict)


@dataclass
class KnowledgeBaseSummary:
    kb_id: str
    name: str
    region: str
    status: str = ""
    tags: dict[str, str] = field(default_factory=dict)


@dataclass
class CustomModelSummary:
    arn: str
    name: str
    region: str
    base_model: str = ""
    tags: dict[str, str] = field(default_factory=dict)


@dataclass
class GuardrailSummary:
    guardrail_id: str
    name: str
    region: str
    status: str = ""
    tags: dict[str, str] = field(default_factory=dict)


@dataclass
class ProvisionedThroughputSummary:
    arn: str
    name: str
    region: str
    model_arn: str = ""
    status: str = ""
    tags: dict[str, str] = field(default_factory=dict)


@dataclass
class ModelInvocationLoggingConfig:
    region: str
    enabled: bool
    cloudwatch_log_group: str | None = None
    s3_bucket: str | None = None
    image_data_delivery: bool = False
    text_data_delivery: bool = False
    embedding_data_delivery: bool = False


@dataclass
class CloudTrailDataEventCoverage:
    """Whether Bedrock data plane events are captured in any trail.

    By default they are NOT — they're high-volume data events that require
    explicit opt-in via event selectors.
    """
    region: str
    has_management_trail: bool = False
    has_bedrock_data_events: bool = False
    org_trail_arn: str | None = None
    org_trail_s3_bucket: str | None = None


@dataclass
class CurExportSummary:
    """An existing CUR 2.0 / Data Export configuration."""
    name: str
    s3_destination: str
    includes_iam_principal: bool = False
    includes_resources: bool = False


@dataclass
class TagCoverage:
    """Tag posture across the candidate calling principals."""
    total_principals: int = 0
    pct_with_team: float = 0.0
    pct_with_cost_center: float = 0.0
    pct_with_environment: float = 0.0
    pct_with_project: float = 0.0
    distinct_team_values: list[str] = field(default_factory=list)
    distinct_cost_center_values: list[str] = field(default_factory=list)


@dataclass
class AccountFindings:
    """Everything the script learns about a single AWS account."""
    account_id: str
    account_name: str | None
    is_management_account: bool
    audit_started_at: str
    audit_completed_at: str | None
    regions_scanned: list[str]
    bedrock_regions_with_activity: list[str]

    # Spend
    total_bedrock_spend_30d_usd: float = 0.0
    total_bedrock_spend_90d_usd: float = 0.0
    spend_by_model: list[SpendByModel] = field(default_factory=list)
    # CloudWatch second signal: per-model invocations + token counts (last 30d)
    model_usage_30d: list[ModelUsage] = field(default_factory=list)
    # Status: can we attribute spend to specific principals yet?
    # "by-principal" — Tier 1 IAM Principal Cost Tracking is enabled and CUR
    # has line_item_iam_principal data. Future audits can break spend down
    # by IAM identity.
    # "by-account-only" — pre-Tier-1. Cost Explorer shows account-level
    # spend only. Per-principal data unavailable.
    spend_attribution_status: str = "by-account-only"

    # Principals (pre-Tier-1 heuristic)
    candidate_principals: list[IamPrincipalCandidate] = field(default_factory=list)
    tag_coverage: TagCoverage = field(default_factory=TagCoverage)

    # Bedrock resources
    application_inference_profiles: list[InferenceProfileSummary] = field(default_factory=list)
    projects: list[ProjectSummary] = field(default_factory=list)
    agents: list[AgentSummary] = field(default_factory=list)
    knowledge_bases: list[KnowledgeBaseSummary] = field(default_factory=list)
    custom_models: list[CustomModelSummary] = field(default_factory=list)
    guardrails: list[GuardrailSummary] = field(default_factory=list)
    provisioned_throughputs: list[ProvisionedThroughputSummary] = field(default_factory=list)
    invocation_logging: list[ModelInvocationLoggingConfig] = field(default_factory=list)

    # Observability infrastructure
    cloudtrail_coverage: list[CloudTrailDataEventCoverage] = field(default_factory=list)
    cur_exports: list[CurExportSummary] = field(default_factory=list)
    iam_principal_cost_tracking_likely_enabled: bool = False

    # Verdict
    readiness: Readiness = Readiness.UNKNOWN
    readiness_reasoning: str = ""
    recommendations: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    # Tagging suggestions (from core.taxonomy)
    tag_suggestions: list[dict[str, Any]] = field(default_factory=list)
    suggested_tag_dimensions: dict[str, list[Any]] = field(default_factory=dict)

    # Action items (from core.action_items)
    action_items: list[dict[str, Any]] = field(default_factory=list)

    # Run history
    audit_history_count: int = 1  # Total audits including this one
    previous_run: dict[str, Any] | None = None
    deltas_vs_previous: list[dict[str, Any]] = field(default_factory=list)

    # Parent-organization context. Populated when the account belongs to an
    # AWS Organization. Both fields are None for standalone accounts (or
    # when describe-organization returns AWSOrganizationsNotInUseException
    # / AccessDenied).
    parent_organization_id: str | None = None      # e.g. "o-abc123def4"
    parent_management_account_id: str | None = None  # the org's payer account id

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class OrgFindings:
    """Output from `org-audit` — a wrapper around per-account findings."""
    organization_id: str | None
    management_account_id: str
    audit_started_at: str
    audit_completed_at: str | None
    accounts: list[AccountFindings] = field(default_factory=list)
    accounts_skipped: list[dict[str, str]] = field(default_factory=list)
    total_org_bedrock_spend_30d_usd: float = 0.0
    total_org_bedrock_spend_90d_usd: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def now_iso() -> str:
    return datetime.utcnow().isoformat(timespec="seconds") + "Z"
