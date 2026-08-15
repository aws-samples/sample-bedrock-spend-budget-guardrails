"""IAM inventory: find principals that *can* call Bedrock and inspect their tags.

Why this approach: Bedrock data plane events (InvokeModel, Converse, etc.)
are NOT recorded in CloudTrail by default — they're high-volume data events
that require explicit opt-in. So we can't always observe who actually called
Bedrock. Instead we inventory the IAM principals that have permission to
call Bedrock — that's the universe of *potential* callers, which is the
right input for Tier 1 readiness scoring.

Once IAM Principal Cost Tracking is enabled + a fresh CUR 2.0 export,
we'll have the actual caller identity in `line_item_iam_principal` and can
replace this heuristic with ground truth.

This module is read-only: it uses `iam:List*`, `iam:Get*`, `iam:Simulate*`
only. Never modifies anything.
"""
from __future__ import annotations

import json
import logging
import re
from typing import Iterator

from botocore.exceptions import ClientError

from core.auth import SessionContext
from core.models import IamPrincipalCandidate, TagCoverage

log = logging.getLogger(__name__)

# Explicit Bedrock runtime actions — a strong signal the principal is wired
# to actually call Bedrock. The bare "*" admin wildcard is handled separately
# (see _action_bedrock_kind): it nominally includes Bedrock, but on an
# admin/infra role it's almost never a real, attributable Bedrock workload.
BEDROCK_RUNTIME_ACTIONS = {
    "bedrock:*",
    "bedrock-runtime:*",
    "bedrock:InvokeModel",
    "bedrock:InvokeModelWithResponseStream",
    "bedrock:Converse",
    "bedrock:ConverseStream",
    "bedrock-runtime:InvokeModel",
    "bedrock-runtime:InvokeModelWithResponseStream",
    "bedrock-runtime:Converse",
    "bedrock-runtime:ConverseStream",
}

IDENTITY_CENTER_ROLE_PATTERN = re.compile(r"^AWSReservedSSO_")

# AWS-managed infrastructure / service-linked roles. These routinely carry the
# "*" admin wildcard (so they nominally "can" call Bedrock) but are never an
# attributable Bedrock workload — counting them inflates the principal count
# and drags tag coverage toward 0%, skewing the readiness score. They're
# excluded from the candidate set. The name patterns are deliberately
# conservative: unambiguous AWS-provisioned roles only, never the account's
# own workload roles (those stay in the list, labeled by how they got access).
_EXCLUDED_ROLE_NAME_PREFIXES = (
    "aws-controltower-",
    "AWSControlTowerExecution",
    "AWS-QuickSetup-",
    "stacksets-exec-",
    "OrganizationAccountAccessRole",
    "IsengardRole-",  # AWS-internal provisioning role prefix; harmless for external
                      # accounts, kept so the filter works in AWS-internal ones too.
)
_CFN_EXEC_ROLE_RE = re.compile(r"cfn-exec-role-\d{12}-")  # CDK bootstrap exec roles


def _is_infra_role(arn: str, name: str) -> bool:
    """True for AWS-managed infra / service-linked roles that shouldn't count
    as attributable Bedrock principals."""
    if ":role/aws-service-role/" in arn:  # service-linked roles
        return True
    if name.startswith(_EXCLUDED_ROLE_NAME_PREFIXES):
        return True
    if _CFN_EXEC_ROLE_RE.search(name):
        return True
    return False


def _action_bedrock_kind(action: str) -> str | None:
    """Classify one IAM action's Bedrock grant: 'explicit' (a named Bedrock
    action), 'broad' (only via the "*" admin wildcard), or None."""
    if action == "*":
        return "broad"
    if action in BEDROCK_RUNTIME_ACTIONS:
        return "explicit"
    if action.startswith("bedrock:") and action.endswith("*"):
        return "explicit"
    if action.startswith("bedrock-runtime:") and action.endswith("*"):
        return "explicit"
    return None


def _statement_bedrock_kind(statement: dict) -> str | None:
    """Strongest Bedrock grant kind in one Allow statement: 'explicit' beats
    'broad'; None if the statement grants no Bedrock access."""
    if statement.get("Effect") != "Allow":
        return None
    actions = statement.get("Action", [])
    if isinstance(actions, str):
        actions = [actions]
    kinds = [k for k in (_action_bedrock_kind(a) for a in actions) if k]
    if "explicit" in kinds:
        return "explicit"
    if "broad" in kinds:
        return "broad"
    return None


def _iter_role_policies(iam, role_name: str) -> Iterator[tuple[str, dict]]:
    """Yield (policy_name, policy_document) for every inline + managed policy on a role."""
    # Inline policies
    paginator = iam.get_paginator("list_role_policies")
    try:
        for page in paginator.paginate(RoleName=role_name):
            for pname in page.get("PolicyNames", []):
                doc = iam.get_role_policy(RoleName=role_name, PolicyName=pname)
                yield (f"inline:{pname}", doc["PolicyDocument"])
    except ClientError as e:
        log.debug("list_role_policies failed for %s: %s", role_name, e)

    # Attached managed policies
    paginator = iam.get_paginator("list_attached_role_policies")
    try:
        for page in paginator.paginate(RoleName=role_name):
            for ap in page.get("AttachedPolicies", []):
                arn = ap["PolicyArn"]
                pname = ap["PolicyName"]
                try:
                    pol = iam.get_policy(PolicyArn=arn)
                    version = pol["Policy"]["DefaultVersionId"]
                    pv = iam.get_policy_version(PolicyArn=arn, VersionId=version)
                    yield (f"managed:{pname}", pv["PolicyVersion"]["Document"])
                except ClientError as e:
                    log.debug("get_policy_version failed for %s: %s", arn, e)
    except ClientError as e:
        log.debug("list_attached_role_policies failed for %s: %s", role_name, e)


def _iter_user_policies(iam, user_name: str) -> Iterator[tuple[str, dict]]:
    """Yield (policy_name, policy_document) for every inline + managed policy on a user."""
    paginator = iam.get_paginator("list_user_policies")
    try:
        for page in paginator.paginate(UserName=user_name):
            for pname in page.get("PolicyNames", []):
                doc = iam.get_user_policy(UserName=user_name, PolicyName=pname)
                yield (f"inline:{pname}", doc["PolicyDocument"])
    except ClientError as e:
        log.debug("list_user_policies failed for %s: %s", user_name, e)

    paginator = iam.get_paginator("list_attached_user_policies")
    try:
        for page in paginator.paginate(UserName=user_name):
            for ap in page.get("AttachedPolicies", []):
                try:
                    arn = ap["PolicyArn"]
                    pol = iam.get_policy(PolicyArn=arn)
                    version = pol["Policy"]["DefaultVersionId"]
                    pv = iam.get_policy_version(PolicyArn=arn, VersionId=version)
                    yield (f"managed:{ap['PolicyName']}", pv["PolicyVersion"]["Document"])
                except ClientError as e:
                    log.debug("user managed policy fetch failed: %s", e)
    except ClientError as e:
        log.debug("list_attached_user_policies failed for %s: %s", user_name, e)


def find_bedrock_capable_principals(ctx: SessionContext) -> list[IamPrincipalCandidate]:
    """Enumerate IAM roles + users whose policies grant Bedrock runtime actions.

    Permission-based (not behavior-based) because Bedrock data events are
    usually not in CloudTrail. Two refinements keep the signal meaningful:

    - AWS-managed infra / service-linked roles (Control Tower, CDK CFN-exec,
      StackSets, Org access, internal provisioning roles, Quick Setup, service-linked) are
      excluded — they carry "*" but are never attributable Bedrock workloads.
    - Each remaining principal is labeled `access_via`: "explicit" (a named
      Bedrock action) or "broad" (only via the "*" admin wildcard).
    """
    iam = ctx.client("iam")
    candidates: list[IamPrincipalCandidate] = []
    excluded_infra = 0

    # Roles
    paginator = iam.get_paginator("list_roles")
    for page in paginator.paginate():
        for role in page.get("Roles", []):
            role_name = role["RoleName"]
            arn = role["Arn"]
            # Drop AWS-managed infra / service-linked roles before scoring.
            if _is_infra_role(arn, role_name):
                excluded_infra += 1
                continue
            grants: list[str] = []
            kinds: list[str] = []
            for pname, pdoc in _iter_role_policies(iam, role_name):
                stmts = pdoc.get("Statement", [])
                if isinstance(stmts, dict):
                    stmts = [stmts]
                stmt_kinds = [k for k in (_statement_bedrock_kind(s) for s in stmts) if k]
                if stmt_kinds:
                    grants.append(pname)
                    kinds.extend(stmt_kinds)
            if not grants:
                continue
            tags = {t["Key"]: t["Value"] for t in role.get("Tags", []) or []}
            candidates.append(
                IamPrincipalCandidate(
                    arn=arn,
                    name=role_name,
                    principal_type="role",
                    tags=tags,
                    bedrock_permission_source=grants,
                    is_identity_center_role=bool(IDENTITY_CENTER_ROLE_PATTERN.match(role_name)),
                    access_via="explicit" if "explicit" in kinds else "broad",
                )
            )

    # Users
    paginator = iam.get_paginator("list_users")
    for page in paginator.paginate():
        for user in page.get("Users", []):
            user_name = user["UserName"]
            arn = user["Arn"]
            grants: list[str] = []
            kinds: list[str] = []
            for pname, pdoc in _iter_user_policies(iam, user_name):
                stmts = pdoc.get("Statement", [])
                if isinstance(stmts, dict):
                    stmts = [stmts]
                stmt_kinds = [k for k in (_statement_bedrock_kind(s) for s in stmts) if k]
                if stmt_kinds:
                    grants.append(pname)
                    kinds.extend(stmt_kinds)
            if not grants:
                continue
            tag_resp = iam.list_user_tags(UserName=user_name)
            tags = {t["Key"]: t["Value"] for t in tag_resp.get("Tags", []) or []}
            candidates.append(
                IamPrincipalCandidate(
                    arn=arn,
                    name=user_name,
                    principal_type="user",
                    tags=tags,
                    bedrock_permission_source=grants,
                    access_via="explicit" if "explicit" in kinds else "broad",
                )
            )

    log.info(
        "Found %d Bedrock-capable IAM principals (excluded %d AWS-managed infra/service roles)",
        len(candidates),
        excluded_infra,
    )
    return candidates


def compute_tag_coverage(principals: list[IamPrincipalCandidate]) -> TagCoverage:
    """Compute aggregate tag-posture metrics across the candidate principal set.

    Tag coverage is the % of candidate principals that carry each common
    organizational tag. This is the input to the readiness score.
    """
    if not principals:
        return TagCoverage()

    n = len(principals)
    keys_by_intent = {
        "team": {"team", "Team", "TEAM"},
        "cost_center": {
            "cost-center",
            "CostCenter",
            "costcenter",
            "cost_center",
            "CC",
        },
        "environment": {"environment", "Environment", "env", "Env", "ENV"},
        "project": {"project", "Project", "PROJECT"},
    }

    def has_any(p: IamPrincipalCandidate, keys: set[str]) -> bool:
        return any(k in p.tags for k in keys)

    def values_for(keys: set[str]) -> list[str]:
        out: set[str] = set()
        for p in principals:
            for k in keys:
                if k in p.tags:
                    out.add(p.tags[k])
        return sorted(out)

    return TagCoverage(
        total_principals=n,
        pct_with_team=round(
            sum(has_any(p, keys_by_intent["team"]) for p in principals) / n * 100, 1
        ),
        pct_with_cost_center=round(
            sum(has_any(p, keys_by_intent["cost_center"]) for p in principals) / n * 100, 1
        ),
        pct_with_environment=round(
            sum(has_any(p, keys_by_intent["environment"]) for p in principals) / n * 100, 1
        ),
        pct_with_project=round(
            sum(has_any(p, keys_by_intent["project"]) for p in principals) / n * 100, 1
        ),
        distinct_team_values=values_for(keys_by_intent["team"]),
        distinct_cost_center_values=values_for(keys_by_intent["cost_center"]),
    )
