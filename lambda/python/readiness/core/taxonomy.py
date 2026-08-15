"""Tagging taxonomy heuristics — suggest organizational tags for IAM principals.

Customers know they need to tag IAM roles for Tier 1 attribution but rarely
know *what* taxonomy to use. This module pattern-matches IAM role names
against common naming conventions and produces suggested tag key→value
pairs the customer can review and apply.

The output is advisory only. We never apply tags ourselves — the customer
reviews the suggestions, edits them, and runs the generated setup-tier1.sh
script (or applies them through the IAM console).

Heuristics (in priority order, first match wins per dimension):

1. Environment from name segments: prod, production, dev, development,
   staging, stage, test, qa, sandbox, sbx
2. Team / business unit from common prefixes or segments
3. Project / workload from substrings like 'bedrock', 'ml', 'data-platform'
4. Cost-center from explicit patterns: CC-NNNN, costcenter-NNNN

Identity Center (AWSReservedSSO_*) roles get special handling — the
permission set name is parsed for team/role hints.
"""
from __future__ import annotations

import logging
import re
from dataclasses import asdict, dataclass, field

from core.models import IamPrincipalCandidate

log = logging.getLogger(__name__)


@dataclass
class TagSuggestion:
    """A proposed tag set for one IAM principal, with confidence and reasoning."""

    arn: str
    name: str
    suggested_tags: dict[str, str] = field(default_factory=dict)
    confidence: str = "low"  # "high" | "medium" | "low"
    reasoning: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


# Tokenization patterns
_ENV_TOKENS = {
    "production": "production",
    "prod": "production",
    "prd": "production",
    "development": "development",
    "develop": "development",
    "dev": "development",
    "staging": "staging",
    "stage": "staging",
    "stg": "staging",
    "test": "test",
    "tst": "test",
    "qa": "qa",
    "uat": "uat",
    "sandbox": "sandbox",
    "sbx": "sandbox",
}

# Common team / domain prefixes you'll see in enterprise IAM role naming.
# Conservative list — only suggest when the match is unambiguous.
_TEAM_TOKENS = {
    "datascience": "data-science",
    "data-science": "data-science",
    "ds": "data-science",
    "ml": "machine-learning",
    "mlops": "ml-platform",
    "ai": "ai",
    "platform": "platform",
    "platforms": "platform",
    "sre": "sre",
    "devops": "devops",
    "security": "security",
    "secops": "security",
    "infosec": "security",
    "finance": "finance",
    "finops": "finops",
    "marketing": "marketing",
    "engineering": "engineering",
    "eng": "engineering",
    "backend": "backend",
    "frontend": "frontend",
    "data": "data",
    "analytics": "analytics",
    "support": "support",
}

_PROJECT_HINTS = {
    "bedrock": "bedrock",
    "claude": "bedrock",
    "anthropic": "bedrock",
    "openai": "openai",
    "rag": "rag",
    "kb": "knowledge-base",
    "agent": "agents",
    "chatbot": "chatbot",
    "summariz": "summarization",
    "search": "search",
    "embedding": "embeddings",
}

_COST_CENTER_PATTERNS = [
    re.compile(r"(?:^|[-_])(CC-?\d{3,6})(?:[-_]|$)", re.IGNORECASE),
    re.compile(r"(?:^|[-_])costcenter[-_]?(\d{3,6})(?:[-_]|$)", re.IGNORECASE),
    re.compile(r"(?:^|[-_])cc(\d{3,6})(?:[-_]|$)", re.IGNORECASE),
]


def _tokenize(name: str) -> list[str]:
    """Split an IAM role name into lowercase alphanumeric tokens."""
    # Split on common separators: dash, underscore, dot, slash, camelCase
    tokens: list[str] = []
    # First handle camelCase boundaries: insert separators before capitals
    spaced = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "-", name)
    for chunk in re.split(r"[-_./\s]+", spaced.lower()):
        if chunk:
            tokens.append(chunk)
    return tokens


def _detect_environment(tokens: list[str]) -> tuple[str | None, str | None]:
    """Return (env_value, matched_token) or (None, None)."""
    for tok in tokens:
        if tok in _ENV_TOKENS:
            return _ENV_TOKENS[tok], tok
    return None, None


def _detect_team(tokens: list[str], name: str) -> tuple[str | None, str | None]:
    """Return (team_value, matched_token)."""
    # Direct token match
    for tok in tokens:
        if tok in _TEAM_TOKENS:
            return _TEAM_TOKENS[tok], tok
    # Substring match for compound team names (e.g., "data-science")
    lower = name.lower()
    for needle, value in _TEAM_TOKENS.items():
        if "-" in needle and needle in lower:
            return value, needle
    return None, None


def _detect_project(tokens: list[str], name: str) -> tuple[str | None, str | None]:
    lower = name.lower()
    for tok in tokens:
        for needle, value in _PROJECT_HINTS.items():
            if tok == needle or tok.startswith(needle):
                return value, tok
    for needle, value in _PROJECT_HINTS.items():
        if needle in lower:
            return value, needle
    return None, None


def _detect_cost_center(name: str) -> str | None:
    for pat in _COST_CENTER_PATTERNS:
        m = pat.search(name)
        if m:
            cc = m.group(1).upper()
            if not cc.startswith("CC"):
                cc = f"CC-{cc}"
            return cc
    return None


def _parse_identity_center_role(name: str) -> str | None:
    """Pull the permission set name out of an AWSReservedSSO_* role name.

    Example: AWSReservedSSO_DataScienceAdmin_abc123def456789 → DataScienceAdmin
    """
    m = re.match(r"^AWSReservedSSO_([A-Za-z][A-Za-z0-9]*)_[a-f0-9]+$", name)
    if m:
        return m.group(1)
    return None


def suggest_for_principal(principal: IamPrincipalCandidate) -> TagSuggestion:
    """Generate tag suggestions for a single principal."""
    name = principal.name
    tokens = _tokenize(name)

    # Identity Center special handling — pull permission set name first
    permission_set: str | None = None
    if principal.is_identity_center_role:
        permission_set = _parse_identity_center_role(name)
        if permission_set:
            # Re-tokenize the permission set name, which is the meaningful part
            tokens = _tokenize(permission_set)

    suggested: dict[str, str] = {}
    matches: list[str] = []
    confidence_signals = 0

    env, env_tok = _detect_environment(tokens)
    if env:
        suggested["environment"] = env
        matches.append(f"environment={env} (from token '{env_tok}')")
        confidence_signals += 1

    team, team_tok = _detect_team(tokens, name)
    if team:
        suggested["team"] = team
        matches.append(f"team={team} (from token '{team_tok}')")
        confidence_signals += 1

    project, project_tok = _detect_project(tokens, name)
    if project:
        suggested["project"] = project
        matches.append(f"project={project} (from token '{project_tok}')")
        confidence_signals += 1

    cc = _detect_cost_center(name)
    if cc:
        suggested["cost-center"] = cc
        matches.append(f"cost-center={cc} (from name pattern)")
        confidence_signals += 1

    # Confidence calibration:
    #   2+ dimensions matched  → high
    #   1 dimension matched    → medium
    #   0 dimensions           → low + a "REVIEW" placeholder
    if confidence_signals >= 2:
        confidence = "high"
    elif confidence_signals == 1:
        confidence = "medium"
    else:
        confidence = "low"
        suggested["team"] = "REVIEW"
        matches.append(
            "Could not infer organizational dimensions from role name — "
            "team set to REVIEW for manual selection."
        )

    return TagSuggestion(
        arn=principal.arn,
        name=name,
        suggested_tags=suggested,
        confidence=confidence,
        reasoning=" · ".join(matches),
    )


def suggest_taxonomy(
    principals: list[IamPrincipalCandidate],
) -> list[TagSuggestion]:
    """Generate tag suggestions for every Bedrock-capable principal."""
    return [suggest_for_principal(p) for p in principals]


def aggregate_suggested_dimensions(
    suggestions: list[TagSuggestion],
) -> dict[str, list[tuple[str, int]]]:
    """Return a frequency-sorted view of suggested values per dimension.

    Useful for the "what tag values are we suggesting?" summary in the
    report. Output: {dim: [(value, count), ...]}.
    """
    out: dict[str, dict[str, int]] = {}
    for s in suggestions:
        for k, v in s.suggested_tags.items():
            if v == "REVIEW":
                continue
            out.setdefault(k, {})
            out[k][v] = out[k].get(v, 0) + 1
    return {
        dim: sorted(counts.items(), key=lambda kv: -kv[1])
        for dim, counts in out.items()
    }
