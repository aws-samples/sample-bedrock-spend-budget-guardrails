"""CloudTrail and CUR 2.0 observability inventory.

Two questions the script answers:
  1. Are Bedrock data plane events being captured anywhere? (CloudTrail)
  2. Is there a CUR 2.0 export with `line_item_iam_principal` enabled?

Bedrock InvokeModel / Converse / etc. are *data events* — they require
explicit opt-in via CloudTrail event selectors. By default they are NOT
in any trail, and `cloudtrail:LookupEvents` will return nothing for
EventSource=bedrock-runtime.amazonaws.com in most environments.

This module only checks configuration. It does not attempt to query
CloudTrail history (that would require parsing S3 or running Athena,
which is a follow-up enhancement once we know data events are enabled).
"""
from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor, as_completed

from botocore.exceptions import ClientError

from core.auth import SessionContext
from core.models import CloudTrailDataEventCoverage, CurExportSummary

log = logging.getLogger(__name__)


def _trail_has_bedrock_data_events(trail_arn: str, ct_client) -> bool:
    """Inspect a trail's event selectors for Bedrock data event coverage."""
    try:
        resp = ct_client.get_event_selectors(TrailName=trail_arn)
    except ClientError as e:
        log.debug("get_event_selectors %s: %s", trail_arn, e)
        return False

    # Advanced event selectors (newer trails)
    for ase in resp.get("AdvancedEventSelectors", []) or []:
        for fs in ase.get("FieldSelectors", []) or []:
            if fs.get("Field") == "eventCategory":
                # Data event category covers the data plane
                if "Data" in (fs.get("Equals") or []):
                    return True
            if fs.get("Field") == "resources.type":
                # Bedrock data event resource type is AWS::Bedrock::*
                vals = fs.get("Equals") or []
                if any("Bedrock" in v for v in vals):
                    return True

    # Legacy event selectors
    for es in resp.get("EventSelectors", []) or []:
        for de in es.get("DataResources", []) or []:
            if "Bedrock" in (de.get("Type") or ""):
                return True
    return False


def cloudtrail_coverage_for_region(
    ctx: SessionContext, region: str
) -> CloudTrailDataEventCoverage:
    """Inspect every visible trail in this region for Bedrock data event coverage."""
    ct = ctx.client("cloudtrail", region=region)
    coverage = CloudTrailDataEventCoverage(region=region)

    try:
        # describe_trails returns trails that publish to this region OR org trails
        resp = ct.describe_trails(includeShadowTrails=True)
    except ClientError as e:
        log.debug("describe_trails %s: %s", region, e)
        return coverage

    for tr in resp.get("trailList", []) or []:
        coverage.has_management_trail = True
        if tr.get("IsOrganizationTrail"):
            coverage.org_trail_arn = tr.get("TrailARN")
            coverage.org_trail_s3_bucket = tr.get("S3BucketName")
        if _trail_has_bedrock_data_events(tr.get("TrailARN"), ct):
            coverage.has_bedrock_data_events = True

    return coverage


def cloudtrail_coverage_all_regions(
    ctx: SessionContext, regions: list[str]
) -> list[CloudTrailDataEventCoverage]:
    """Run cloudtrail coverage check across all Bedrock regions in parallel."""
    out: list[CloudTrailDataEventCoverage] = []
    with ThreadPoolExecutor(max_workers=8) as pool:
        futs = {pool.submit(cloudtrail_coverage_for_region, ctx, r): r for r in regions}
        for f in as_completed(futs):
            try:
                out.append(f.result())
            except Exception as e:  # noqa: BLE001
                log.warning("CloudTrail check failed in %s: %s", futs[f], e)
    return sorted(out, key=lambda c: c.region)


def list_cur_exports(ctx: SessionContext) -> list[CurExportSummary]:
    """List CUR 2.0 / Data Exports configurations.

    Indicates whether the management account has already created a CUR 2.0
    export with `Include caller identity (IAM principal) allocation data`
    enabled — which is Tier 1 prerequisite step 3.

    Only meaningful at the management account level. Member accounts will
    typically get AccessDenied.
    """
    out: list[CurExportSummary] = []

    # The bcm-data-exports service is region-locked to us-east-1.
    try:
        client = ctx.client("bcm-data-exports", region="us-east-1")
    except Exception as e:  # noqa: BLE001
        log.debug("Cannot create bcm-data-exports client: %s", e)
        return out

    try:
        paginator = client.get_paginator("list_exports")
        for page in paginator.paginate():
            for exp in page.get("Exports", []) or []:
                export_arn = exp.get("ExportArn", "")
                try:
                    detail = client.get_export(ExportArn=export_arn)
                    e = detail["Export"]
                    cfg = e.get("DataQuery", {}).get("TableConfigurations", {}) or {}
                    cur_cfg = cfg.get("COST_AND_USAGE_REPORT", {}) or {}
                    includes_iam = cur_cfg.get(
                        "INCLUDE_CALLER_IDENTITY_DATA", "FALSE"
                    ).upper() == "TRUE"
                    includes_resources = cur_cfg.get(
                        "INCLUDE_RESOURCES", "FALSE"
                    ).upper() == "TRUE"
                    s3_dest = (
                        e.get("DestinationConfigurations", {})
                        .get("S3Destination", {})
                        .get("S3Bucket", "")
                    )
                    out.append(
                        CurExportSummary(
                            name=e.get("Name", ""),
                            s3_destination=s3_dest,
                            includes_iam_principal=includes_iam,
                            includes_resources=includes_resources,
                        )
                    )
                except ClientError as e:
                    log.debug("get_export failed for %s: %s", export_arn, e)
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "")
        log.debug("list_exports failed: %s", code)

    return out
