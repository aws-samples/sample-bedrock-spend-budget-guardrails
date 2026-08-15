"""CloudWatch metrics for Amazon Bedrock — second signal for cost validation.

Cost Explorer tells you the dollar amount of Bedrock spend. CloudWatch
metrics tell you the invocation count and token volumes that drove that
spend. Showing both side-by-side lets the customer cross-check the math
(e.g., "8 million input tokens at $X per million should be $Y — does my
bill match?").

This module is read-only — uses only `cloudwatch:GetMetricStatistics`.

Returns per-region, per-model:
  - invocations: total Bedrock InvokeModel/Converse calls
  - input_tokens: aggregate input tokens consumed
  - output_tokens: aggregate output tokens generated
  - throttles: total throttling events

Bedrock CloudWatch metrics namespace: `AWS/Bedrock`
Dimension: `ModelId` (one entry per model the account has used)
"""
from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone

from botocore.exceptions import ClientError

from core.auth import SessionContext
from core.models import ModelUsage

log = logging.getLogger(__name__)

BEDROCK_NAMESPACE = "AWS/Bedrock"
BEDROCK_METRICS = ["Invocations", "InputTokenCount", "OutputTokenCount", "InvocationThrottles"]


def list_models_with_activity(ctx: SessionContext, region: str) -> list[str]:
    """Return ModelIds that have any AWS/Bedrock metric data points in the region."""
    cw = ctx.client("cloudwatch", region=region)
    out: set[str] = set()
    try:
        paginator = cw.get_paginator("list_metrics")
        for page in paginator.paginate(
            Namespace=BEDROCK_NAMESPACE,
            MetricName="Invocations",
        ):
            for m in page.get("Metrics", []) or []:
                for d in m.get("Dimensions", []) or []:
                    if d["Name"] == "ModelId":
                        out.add(d["Value"])
    except ClientError as e:
        log.debug("list_metrics failed in %s: %s", region, e)
    return sorted(out)


def model_usage_for_region(
    ctx: SessionContext, region: str, days: int = 30
) -> list[ModelUsage]:
    """Pull per-model invocation + token counts for the last N days in this region."""
    cw = ctx.client("cloudwatch", region=region)
    end = datetime.now(timezone.utc)
    start = end - timedelta(days=days)
    out: list[ModelUsage] = []

    model_ids = list_models_with_activity(ctx, region)
    if not model_ids:
        return out

    for model_id in model_ids:
        usage = ModelUsage(model_id=model_id, region=region, days=days)
        for metric_name in BEDROCK_METRICS:
            try:
                resp = cw.get_metric_statistics(
                    Namespace=BEDROCK_NAMESPACE,
                    MetricName=metric_name,
                    Dimensions=[{"Name": "ModelId", "Value": model_id}],
                    StartTime=start,
                    EndTime=end,
                    # Use a very large period so we get a single aggregated bucket.
                    # 86400 * days = whole window, but the API caps Period at 1 day
                    # for ranges over 63 days; chunk if needed.
                    Period=min(86400 * days, 86400 * 30),
                    Statistics=["Sum"],
                )
            except ClientError as e:
                log.debug(
                    "get_metric_statistics %s/%s in %s: %s",
                    model_id,
                    metric_name,
                    region,
                    e,
                )
                continue
            total = int(sum(p.get("Sum", 0) for p in resp.get("Datapoints", []) or []))
            if metric_name == "Invocations":
                usage.invocations = total
            elif metric_name == "InputTokenCount":
                usage.input_tokens = total
            elif metric_name == "OutputTokenCount":
                usage.output_tokens = total
            elif metric_name == "InvocationThrottles":
                usage.throttles = total
        out.append(usage)

    return out


def model_usage_all_regions(
    ctx: SessionContext, regions: list[str], days: int = 30
) -> list[ModelUsage]:
    """Pull per-model usage from CloudWatch across all given regions in parallel."""
    out: list[ModelUsage] = []
    with ThreadPoolExecutor(max_workers=8) as pool:
        futs = {pool.submit(model_usage_for_region, ctx, r, days): r for r in regions}
        for f in as_completed(futs):
            try:
                out.extend(f.result())
            except Exception as e:  # noqa: BLE001
                log.warning("Model usage fetch failed in %s: %s", futs[f], e)
    return out
