"""Cost Explorer queries for Amazon Bedrock spend.

This module is read-only. It uses `ce:GetCostAndUsage` to discover:
  - Total Bedrock spend for the account (or for each account, when called
    from the management account)
  - Spend broken down by USAGE_TYPE — which encodes the model name and
    whether the cost is for input or output tokens

Usage type strings look like:
  USE1-Bedrock-tokens-Anthropic.Claude-3-5-Sonnet-v1-input-tokens
  USE2-Bedrock-tokens-Anthropic.Claude-3-5-Sonnet-v1-output-tokens

We parse those into structured `SpendByModel` rows so the report can show
per-model totals and an input/output split.

Note: Cost Explorer is region-locked to us-east-1 and only available to
accounts that have it enabled (which is automatic for any account with
billing access).
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from botocore.exceptions import ClientError

from core.auth import COST_EXPLORER_REGION, SessionContext
from core.models import SpendByModel

log = logging.getLogger(__name__)

BEDROCK_SERVICE_NAME = "Amazon Bedrock"


def _isoformat(d: datetime) -> str:
    return d.strftime("%Y-%m-%d")


def _date_window(days: int) -> tuple[str, str]:
    end = datetime.now(timezone.utc).date()
    start = end - timedelta(days=days)
    return start.isoformat(), end.isoformat()


def total_bedrock_spend(ctx: SessionContext, days: int = 90) -> float:
    """Return total Bedrock spend (UnblendedCost USD) over the last N days.

    For account-mode this returns the current account's spend.
    For org-mode (called from payer), this returns the *whole org* spend —
    the caller should switch to `bedrock_spend_by_account` for per-account.
    """
    ce = ctx.client("ce", region=COST_EXPLORER_REGION)
    start, end = _date_window(days)

    try:
        resp = ce.get_cost_and_usage(
            TimePeriod={"Start": start, "End": end},
            Granularity="MONTHLY",
            Metrics=["UnblendedCost"],
            Filter={
                "Dimensions": {
                    "Key": "SERVICE",
                    "Values": [BEDROCK_SERVICE_NAME],
                }
            },
        )
    except ClientError as e:
        log.warning("Cost Explorer call failed: %s", e)
        return 0.0

    total = 0.0
    for tp in resp.get("ResultsByTime", []):
        amt = tp.get("Total", {}).get("UnblendedCost", {}).get("Amount", "0")
        total += float(amt)
    return total


def bedrock_spend_by_account(
    ctx: SessionContext,
    days: int = 90,
) -> dict[str, float]:
    """Org-mode: returns {account_id -> spend_usd} for the last N days.

    Only meaningful when called from the management account or an account
    with consolidated billing visibility.
    """
    ce = ctx.client("ce", region=COST_EXPLORER_REGION)
    start, end = _date_window(days)
    out: dict[str, float] = {}
    next_token: str | None = None

    while True:
        kwargs = {
            "TimePeriod": {"Start": start, "End": end},
            "Granularity": "MONTHLY",
            "Metrics": ["UnblendedCost"],
            "Filter": {
                "Dimensions": {"Key": "SERVICE", "Values": [BEDROCK_SERVICE_NAME]}
            },
            "GroupBy": [{"Type": "DIMENSION", "Key": "LINKED_ACCOUNT"}],
        }
        if next_token:
            kwargs["NextPageToken"] = next_token

        try:
            resp = ce.get_cost_and_usage(**kwargs)
        except ClientError as e:
            log.warning("Cost Explorer per-account call failed: %s", e)
            return out

        for tp in resp.get("ResultsByTime", []):
            for grp in tp.get("Groups", []):
                acct = grp["Keys"][0]
                amt = float(grp["Metrics"]["UnblendedCost"]["Amount"])
                out[acct] = out.get(acct, 0.0) + amt

        next_token = resp.get("NextPageToken")
        if not next_token:
            break

    return out


def bedrock_spend_by_usage_type(
    ctx: SessionContext,
    days: int = 90,
) -> list[SpendByModel]:
    """Return per-model, per-direction (input/output) spend for the last N days.

    Works in both account and org mode — Cost Explorer scopes to the current
    visibility set automatically.
    """
    ce = ctx.client("ce", region=COST_EXPLORER_REGION)
    start, end = _date_window(days)
    rollup: dict[str, float] = {}
    next_token: str | None = None

    while True:
        kwargs = {
            "TimePeriod": {"Start": start, "End": end},
            "Granularity": "MONTHLY",
            "Metrics": ["UnblendedCost"],
            "Filter": {
                "Dimensions": {"Key": "SERVICE", "Values": [BEDROCK_SERVICE_NAME]}
            },
            "GroupBy": [{"Type": "DIMENSION", "Key": "USAGE_TYPE"}],
        }
        if next_token:
            kwargs["NextPageToken"] = next_token

        try:
            resp = ce.get_cost_and_usage(**kwargs)
        except ClientError as e:
            log.warning("Cost Explorer usage-type call failed: %s", e)
            return []

        for tp in resp.get("ResultsByTime", []):
            for grp in tp.get("Groups", []):
                ut = grp["Keys"][0]
                amt = float(grp["Metrics"]["UnblendedCost"]["Amount"])
                rollup[ut] = rollup.get(ut, 0.0) + amt

        next_token = resp.get("NextPageToken")
        if not next_token:
            break

    return [_parse_usage_type(ut, cost) for ut, cost in rollup.items() if cost > 0]


def _parse_usage_type(usage_type: str, cost: float) -> SpendByModel:
    """Parse a Bedrock usage_type string into a SpendByModel.

    Bedrock usage types come in many shapes — runtime tokens, Data Automation
    pages, Knowledge Base storage/queries, Guardrails policies, etc. Each
    has a distinct prefix that we map to a recognizable label.

    Examples:
      USE1-Bedrock-tokens-Anthropic.Claude-3-5-Sonnet-v1-input-tokens
        → model='Anthropic.Claude-3-5-Sonnet-v1', is_input=True

      EUW2-Bedrock-tokens-Amazon.Nova-Pro-v1-output-tokens
        → model='Amazon.Nova-Pro-v1', is_input=False

      USE1-DataAutomation-Custom-PagesProcessed
        → model='DataAutomation-Custom (PagesProcessed)', is_input=False

      USE1-DataAutomation-Custom-PagesProcessed-AddOnFields
        → model='DataAutomation-Custom (PagesProcessed AddOnFields)', is_input=False

      USE1-TitanEmbeddingV2-Text-input-tokens
        → model='Amazon.Titan-Embedding-V2-Text', is_input=True

      USE1-KnowledgeBase-Storage-Hours
        → model='KnowledgeBase (Storage Hours)', is_input=False

      USE1-Guardrails-Text-Units
        → model='Guardrails (Text Units)', is_input=False

    The first segment is a region prefix (USE1, EUW2, etc.) which we discard.
    """
    is_input = "input-tokens" in usage_type or usage_type.endswith("-input")
    is_output = "output-tokens" in usage_type or usage_type.endswith("-output")

    # Strip region prefix (e.g., "USE1-", "EUW2-", "APN1-")
    body = usage_type.split("-", 1)[1] if "-" in usage_type else usage_type

    model_id = "unknown"

    # Pattern 1: Bedrock-tokens-<model>-input-tokens / -output-tokens
    if body.startswith("Bedrock-tokens-"):
        tail = body[len("Bedrock-tokens-"):]
        for suffix in ("-input-tokens", "-output-tokens"):
            if tail.endswith(suffix):
                model_id = tail[: -len(suffix)]
                break
        else:
            model_id = tail

    # Pattern 2: TitanEmbeddingV2-Text-input-tokens etc. (Titan models have
    # their own usage_type prefix, no "Bedrock-tokens-" wrapper)
    elif body.startswith("Titan"):
        # e.g., TitanEmbeddingV2-Text-input-tokens → Amazon.Titan-Embedding-V2-Text
        for suffix in ("-input-tokens", "-output-tokens"):
            if body.endswith(suffix):
                model_id = f"Amazon.{body[: -len(suffix)]}"
                break
        else:
            model_id = f"Amazon.{body}"

    # Pattern 3: DataAutomation-<tier>-PagesProcessed[-AddOnFields]
    elif body.startswith("DataAutomation-"):
        tail = body[len("DataAutomation-"):]
        # tail is something like "Custom-PagesProcessed-AddOnFields"
        # Pull out the tier (Custom/Standard) and rest
        parts = tail.split("-", 1)
        tier = parts[0]
        unit = parts[1].replace("-", " ") if len(parts) > 1 else ""
        model_id = f"Bedrock.DataAutomation-{tier} ({unit})" if unit else f"Bedrock.DataAutomation-{tier}"

    # Pattern 4: Knowledge Base, Guardrails, CustomModel, ProvisionedThroughput, etc.
    elif body.startswith("KnowledgeBase-"):
        unit = body[len("KnowledgeBase-"):].replace("-", " ")
        model_id = f"Bedrock.KnowledgeBase ({unit})"
    elif body.startswith("Guardrails-"):
        unit = body[len("Guardrails-"):].replace("-", " ")
        model_id = f"Bedrock.Guardrails ({unit})"
    elif body.startswith("CustomModel-"):
        unit = body[len("CustomModel-"):].replace("-", " ")
        model_id = f"Bedrock.CustomModel ({unit})"
    elif body.startswith("ProvisionedThroughput-"):
        unit = body[len("ProvisionedThroughput-"):].replace("-", " ")
        model_id = f"Bedrock.ProvisionedThroughput ({unit})"

    # Fallback: keep the raw body so the row is still readable in the report
    else:
        model_id = body

    return SpendByModel(
        model_id=model_id,
        usage_type=usage_type,
        cost_usd=round(cost, 4),
        is_input=is_input if (is_input or is_output) else False,
    )
