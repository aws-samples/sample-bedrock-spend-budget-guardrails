"""Run history — track audits over time and compute deltas vs the previous run.

Each audit appends a compact snapshot to a JSONL file at
`<history_dir>/<account_id>.jsonl`. On the next run we read the most recent
prior entry, compute deltas, and surface them in the report so the customer
can see progress (or regression) since they last looked.

JSONL format (one JSON object per line, append-only) is intentional:
  - Trivial to write atomically (single line append)
  - Trivial to read most recent / iterate history without parsing the whole file
  - Trivial to truncate if the file ever gets too big
  - Each line is human-readable in less / cat / grep

History snapshot schema is a flat metric dump, NOT the full findings object.
The full findings already live in {account_id}.json — history is a much
smaller time-series of just the numbers that should change between audits.
"""
from __future__ import annotations

import json
import logging
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Optional

from core.models import AccountFindings, Readiness

log = logging.getLogger(__name__)


@dataclass
class RunSnapshot:
    """Compact, schema-stable summary of a single audit run."""

    audit_started_at: str
    audit_completed_at: str
    account_id: str
    is_management_account: bool
    readiness: str

    # Spend
    spend_30d_usd: float
    spend_90d_usd: float
    spend_attribution_status: str  # "by-principal" | "by-account-only"

    # Principals + tags
    num_principals: int
    pct_with_team: float
    pct_with_cost_center: float
    pct_with_environment: float
    pct_with_project: float

    # Bedrock resources
    num_inference_profiles: int
    num_projects: int
    num_agents: int
    num_knowledge_bases: int
    num_custom_models: int
    num_guardrails: int
    num_provisioned_throughputs: int

    # Cost-attribution infrastructure
    iam_principal_cost_tracking_enabled: bool

    # CloudWatch totals (across all models)
    invocations_30d: int = 0
    input_tokens_30d: int = 0
    output_tokens_30d: int = 0


def _snapshot_from_findings(f: AccountFindings) -> RunSnapshot:
    cw_inv = sum(u.invocations for u in f.model_usage_30d)
    cw_in = sum(u.input_tokens for u in f.model_usage_30d)
    cw_out = sum(u.output_tokens for u in f.model_usage_30d)
    return RunSnapshot(
        audit_started_at=f.audit_started_at,
        audit_completed_at=f.audit_completed_at or f.audit_started_at,
        account_id=f.account_id,
        is_management_account=f.is_management_account,
        readiness=f.readiness.value,
        spend_30d_usd=f.total_bedrock_spend_30d_usd,
        spend_90d_usd=f.total_bedrock_spend_90d_usd,
        spend_attribution_status=f.spend_attribution_status,
        num_principals=f.tag_coverage.total_principals,
        pct_with_team=f.tag_coverage.pct_with_team,
        pct_with_cost_center=f.tag_coverage.pct_with_cost_center,
        pct_with_environment=f.tag_coverage.pct_with_environment,
        pct_with_project=f.tag_coverage.pct_with_project,
        num_inference_profiles=len(f.application_inference_profiles),
        num_projects=len(f.projects),
        num_agents=len(f.agents),
        num_knowledge_bases=len(f.knowledge_bases),
        num_custom_models=len(f.custom_models),
        num_guardrails=len(f.guardrails),
        num_provisioned_throughputs=len(f.provisioned_throughputs),
        iam_principal_cost_tracking_enabled=f.iam_principal_cost_tracking_likely_enabled,
        invocations_30d=cw_inv,
        input_tokens_30d=cw_in,
        output_tokens_30d=cw_out,
    )


def history_path(history_dir: Path, account_id: str) -> Path:
    return history_dir / f"{account_id}.jsonl"


def record_run(findings: AccountFindings, history_dir: Path) -> Path:
    """Append a snapshot of this audit to the per-account history file.

    Idempotent on a single audit_started_at — if the file's last line has
    the same timestamp, we don't append a duplicate (defensive against
    accidental double-record).
    """
    history_dir.mkdir(parents=True, exist_ok=True)
    snap = _snapshot_from_findings(findings)
    path = history_path(history_dir, findings.account_id)

    # Defensive dedup against double-recording
    if path.exists():
        try:
            with path.open("r") as fp:
                last = None
                for line in fp:
                    line = line.strip()
                    if line:
                        last = line
                if last:
                    last_obj = json.loads(last)
                    if last_obj.get("audit_started_at") == snap.audit_started_at:
                        log.debug("History snapshot for %s already recorded", findings.account_id)
                        return path
        except (OSError, json.JSONDecodeError) as e:
            log.warning("Could not read existing history file %s: %s", path, e)

    line = json.dumps(asdict(snap), separators=(",", ":"))
    with path.open("a") as fp:
        fp.write(line + "\n")
    return path


def load_history(history_dir: Path, account_id: str) -> list[RunSnapshot]:
    """Return the full history for an account, oldest first."""
    path = history_path(history_dir, account_id)
    if not path.exists():
        return []
    out: list[RunSnapshot] = []
    try:
        with path.open("r") as fp:
            for line in fp:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                    out.append(RunSnapshot(**obj))
                except (json.JSONDecodeError, TypeError) as e:
                    log.warning("Skipping malformed history line in %s: %s", path, e)
    except OSError as e:
        log.warning("Could not read history file %s: %s", path, e)
    return out


def load_previous_run(
    history_dir: Path, account_id: str, before_timestamp: str
) -> Optional[RunSnapshot]:
    """Return the most recent run BEFORE `before_timestamp`, or None.

    `before_timestamp` is the ISO timestamp of the current run. We exclude
    matches at that exact timestamp so a re-recorded snapshot doesn't
    appear as its own previous run.
    """
    history = load_history(history_dir, account_id)
    earlier = [s for s in history if s.audit_started_at < before_timestamp]
    return earlier[-1] if earlier else None


# ---------------------------------------------------------------------------
# Delta calculation
# ---------------------------------------------------------------------------


@dataclass
class DeltaRow:
    """One row in the comparison table."""

    label: str
    previous: str  # rendered display value
    current: str   # rendered display value
    direction: str  # "up" | "down" | "same"
    sentiment: str  # "good" | "bad" | "neutral" — for color hints in the UI


READINESS_RANK = {"RED": 0, "UNKNOWN": 1, "YELLOW": 2, "GREEN": 3}


def _direction_num(prev: float, cur: float) -> str:
    if cur > prev:
        return "up"
    if cur < prev:
        return "down"
    return "same"


def _direction_str(prev: str, cur: str) -> str:
    return "same" if prev == cur else "up"  # treat any change as "up" for strings


def compute_deltas(prev: RunSnapshot, cur: RunSnapshot) -> list[DeltaRow]:
    """Compute a structured comparison of metrics between two runs.

    Sentiment heuristics:
      - readiness   improvement → good (e.g., RED → YELLOW)
      - tag coverage up         → good
      - num_principals          → neutral (more or fewer is just more or fewer)
      - resource counts         → neutral (info)
      - spend                   → neutral (could be good or bad depending on context)
      - iam_principal_cost_tracking_enabled flipping to True → good
    """
    rows: list[DeltaRow] = []

    # Readiness
    prev_rank = READINESS_RANK.get(prev.readiness, 0)
    cur_rank = READINESS_RANK.get(cur.readiness, 0)
    if prev.readiness != cur.readiness:
        if cur_rank > prev_rank:
            sentiment = "good"
            direction = "up"
        elif cur_rank < prev_rank:
            sentiment = "bad"
            direction = "down"
        else:
            sentiment = "neutral"
            direction = "same"
    else:
        sentiment = "neutral"
        direction = "same"
    rows.append(
        DeltaRow(
            label="Readiness",
            previous=prev.readiness,
            current=cur.readiness,
            direction=direction,
            sentiment=sentiment,
        )
    )

    # Spend attribution status
    if prev.spend_attribution_status != cur.spend_attribution_status:
        sentiment = "good" if cur.spend_attribution_status == "by-principal" else "bad"
        rows.append(
            DeltaRow(
                label="Spend attribution status",
                previous=prev.spend_attribution_status,
                current=cur.spend_attribution_status,
                direction="up",
                sentiment=sentiment,
            )
        )

    # Numeric metrics: (label, prev_value, cur_value, sentiment_when_up, sentiment_when_down, formatter)
    numeric_rows = [
        (
            "Bedrock spend (90d)",
            prev.spend_90d_usd,
            cur.spend_90d_usd,
            "neutral",
            "neutral",
            lambda v: f"${v:,.2f}",
        ),
        (
            "Bedrock spend (30d)",
            prev.spend_30d_usd,
            cur.spend_30d_usd,
            "neutral",
            "neutral",
            lambda v: f"${v:,.2f}",
        ),
        (
            "Bedrock-capable principals",
            prev.num_principals,
            cur.num_principals,
            "neutral",
            "neutral",
            lambda v: f"{int(v)}",
        ),
        (
            "Tag coverage — team",
            prev.pct_with_team,
            cur.pct_with_team,
            "good",
            "bad",
            lambda v: f"{v:.0f}%",
        ),
        (
            "Tag coverage — cost-center",
            prev.pct_with_cost_center,
            cur.pct_with_cost_center,
            "good",
            "bad",
            lambda v: f"{v:.0f}%",
        ),
        (
            "Tag coverage — environment",
            prev.pct_with_environment,
            cur.pct_with_environment,
            "good",
            "bad",
            lambda v: f"{v:.0f}%",
        ),
        (
            "Tag coverage — project",
            prev.pct_with_project,
            cur.pct_with_project,
            "good",
            "bad",
            lambda v: f"{v:.0f}%",
        ),
        (
            "Inference profiles",
            prev.num_inference_profiles,
            cur.num_inference_profiles,
            "good",
            "neutral",
            lambda v: f"{int(v)}",
        ),
        (
            "Bedrock Projects",
            prev.num_projects,
            cur.num_projects,
            "good",
            "neutral",
            lambda v: f"{int(v)}",
        ),
        (
            "Bedrock Agents",
            prev.num_agents,
            cur.num_agents,
            "neutral",
            "neutral",
            lambda v: f"{int(v)}",
        ),
        (
            "Knowledge Bases",
            prev.num_knowledge_bases,
            cur.num_knowledge_bases,
            "neutral",
            "neutral",
            lambda v: f"{int(v)}",
        ),
        (
            "Invocations (CloudWatch, 30d)",
            prev.invocations_30d,
            cur.invocations_30d,
            "neutral",
            "neutral",
            lambda v: f"{int(v):,}",
        ),
        (
            "Input tokens (CloudWatch, 30d)",
            prev.input_tokens_30d,
            cur.input_tokens_30d,
            "neutral",
            "neutral",
            lambda v: f"{int(v):,}",
        ),
        (
            "Output tokens (CloudWatch, 30d)",
            prev.output_tokens_30d,
            cur.output_tokens_30d,
            "neutral",
            "neutral",
            lambda v: f"{int(v):,}",
        ),
    ]
    for label, p, c, sent_up, sent_down, fmt in numeric_rows:
        if p == c:
            continue  # don't clutter the report with no-change rows
        direction = _direction_num(p, c)
        sentiment = sent_up if direction == "up" else sent_down
        rows.append(
            DeltaRow(
                label=label,
                previous=fmt(p),
                current=fmt(c),
                direction=direction,
                sentiment=sentiment,
            )
        )

    return rows
