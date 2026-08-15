"""Bedrock resource inventory across regions.

Discovers, in each Bedrock-supported region:
  - Application Inference Profiles (Tier 2 mechanism)
  - Bedrock Projects (mantle-endpoint Tier 3 mechanism)
  - Model invocation logging configuration (Tier 1 supplement)
  - List of regions where the account has *any* Bedrock activity

All calls are read-only:
  - bedrock:ListInferenceProfiles
  - bedrock:ListTagsForResource
  - bedrock:ListProjects (when GA in this region)
  - bedrock:GetModelInvocationLoggingConfiguration
"""
from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor, as_completed

from botocore.exceptions import ClientError

from core.auth import SessionContext
from core.models import (
    AgentSummary,
    CustomModelSummary,
    GuardrailSummary,
    InferenceProfileSummary,
    KnowledgeBaseSummary,
    ModelInvocationLoggingConfig,
    ProjectSummary,
    ProvisionedThroughputSummary,
)

log = logging.getLogger(__name__)


def list_application_inference_profiles_in_region(
    ctx: SessionContext, region: str
) -> list[InferenceProfileSummary]:
    """Return every APPLICATION-type inference profile in the given region."""
    bedrock = ctx.client("bedrock", region=region)
    out: list[InferenceProfileSummary] = []
    try:
        paginator = bedrock.get_paginator("list_inference_profiles")
        for page in paginator.paginate(typeEquals="APPLICATION"):
            for prof in page.get("inferenceProfileSummaries", []):
                arn = prof.get("inferenceProfileArn", "")
                tags = _list_tags(bedrock, arn)
                out.append(
                    InferenceProfileSummary(
                        arn=arn,
                        name=prof.get("inferenceProfileName", ""),
                        region=region,
                        type=prof.get("type", "APPLICATION"),
                        tags=tags,
                        model_source=_extract_model_source(prof),
                    )
                )
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "")
        if code in ("UnknownOperationException", "AccessDeniedException", "ValidationException"):
            log.debug("list_inference_profiles not available in %s: %s", region, code)
        else:
            log.warning("list_inference_profiles failed in %s: %s", region, code)
    return out


def _list_tags(bedrock, resource_arn: str) -> dict[str, str]:
    try:
        resp = bedrock.list_tags_for_resource(resourceARN=resource_arn)
        return {t["key"]: t["value"] for t in resp.get("tags", []) or []}
    except ClientError:
        return {}


def _extract_model_source(prof: dict) -> str:
    """Pull a human-readable description of what the profile points at."""
    models = prof.get("models", []) or []
    if models:
        return ", ".join(m.get("modelArn", "") for m in models)
    return prof.get("inferenceProfileId", "")


def list_projects_in_region(ctx: SessionContext, region: str) -> list[ProjectSummary]:
    """Return every Bedrock Project (bedrock-mantle attribution) in the region.

    The Projects API may not be available in every region yet; we skip on
    UnknownOperationException without flagging.
    """
    bedrock = ctx.client("bedrock", region=region)
    out: list[ProjectSummary] = []
    try:
        paginator = bedrock.get_paginator("list_projects")
        for page in paginator.paginate():
            for proj in page.get("projects", []):
                arn = proj.get("projectArn") or proj.get("arn", "")
                tags = _list_tags(bedrock, arn) if arn else {}
                out.append(
                    ProjectSummary(
                        project_id=proj.get("projectId", ""),
                        name=proj.get("name", ""),
                        region=region,
                        tags=tags,
                    )
                )
    except (ClientError, AttributeError, KeyError) as e:
        # KeyError: get_paginator raises this when the operation isn't in the
        # SDK (Bedrock Projects is a recent API and may not be in older botocore).
        # AttributeError: client method missing entirely.
        # ClientError: present but caller lacks permission or region doesn't have it.
        log.debug("list_projects not available in %s: %s", region, e)
    return out


# ---------------------------------------------------------------------------
# Bedrock Agents and Knowledge Bases
# ---------------------------------------------------------------------------


def list_agents_in_region(ctx: SessionContext, region: str) -> list[AgentSummary]:
    """List Bedrock Agents in the given region.

    Each agent has an associated execution role that is itself a Bedrock-capable
    IAM principal — those will also show up in the IAM principal inventory.
    """
    out: list[AgentSummary] = []
    try:
        bedrock_agent = ctx.client("bedrock-agent", region=region)
    except Exception as e:  # noqa: BLE001
        log.debug("bedrock-agent client unavailable in %s: %s", region, e)
        return out

    try:
        paginator = bedrock_agent.get_paginator("list_agents")
        for page in paginator.paginate():
            for ag in page.get("agentSummaries", []) or []:
                agent_id = ag.get("agentId", "")
                # Fetch full details to get foundation model + role
                fm = ""
                role_arn = ""
                tags: dict[str, str] = {}
                try:
                    full = bedrock_agent.get_agent(agentId=agent_id)
                    a = full.get("agent", {}) or {}
                    fm = a.get("foundationModel", "")
                    role_arn = a.get("agentResourceRoleArn", "")
                    agent_arn = a.get("agentArn", "")
                    if agent_arn:
                        tags = _list_tags_agent(bedrock_agent, agent_arn)
                except ClientError as e:
                    log.debug("get_agent failed for %s in %s: %s", agent_id, region, e)
                out.append(
                    AgentSummary(
                        agent_id=agent_id,
                        name=ag.get("agentName", ""),
                        region=region,
                        foundation_model=fm,
                        agent_resource_role_arn=role_arn,
                        status=ag.get("agentStatus", ""),
                        tags=tags,
                    )
                )
    except (ClientError, AttributeError, KeyError) as e:
        log.debug("list_agents not available in %s: %s", region, e)
    return out


def list_knowledge_bases_in_region(
    ctx: SessionContext, region: str
) -> list[KnowledgeBaseSummary]:
    """List Bedrock Knowledge Bases in the given region."""
    out: list[KnowledgeBaseSummary] = []
    try:
        bedrock_agent = ctx.client("bedrock-agent", region=region)
    except Exception as e:  # noqa: BLE001
        log.debug("bedrock-agent client unavailable in %s: %s", region, e)
        return out

    try:
        paginator = bedrock_agent.get_paginator("list_knowledge_bases")
        for page in paginator.paginate():
            for kb in page.get("knowledgeBaseSummaries", []) or []:
                kb_id = kb.get("knowledgeBaseId", "")
                tags: dict[str, str] = {}
                # Knowledge Base ARN format
                kb_arn = ""
                try:
                    full = bedrock_agent.get_knowledge_base(knowledgeBaseId=kb_id)
                    k = full.get("knowledgeBase", {}) or {}
                    kb_arn = k.get("knowledgeBaseArn", "")
                    if kb_arn:
                        tags = _list_tags_agent(bedrock_agent, kb_arn)
                except ClientError as e:
                    log.debug("get_knowledge_base failed for %s in %s: %s", kb_id, region, e)
                out.append(
                    KnowledgeBaseSummary(
                        kb_id=kb_id,
                        name=kb.get("name", ""),
                        region=region,
                        status=kb.get("status", ""),
                        tags=tags,
                    )
                )
    except (ClientError, AttributeError, KeyError) as e:
        log.debug("list_knowledge_bases not available in %s: %s", region, e)
    return out


def _list_tags_agent(bedrock_agent, resource_arn: str) -> dict[str, str]:
    """bedrock-agent has its own list_tags_for_resource shape (PascalCase keys)."""
    try:
        resp = bedrock_agent.list_tags_for_resource(resourceArn=resource_arn)
        return resp.get("tags", {}) or {}
    except ClientError:
        return {}


# ---------------------------------------------------------------------------
# Custom models, Guardrails, Provisioned Throughput
# ---------------------------------------------------------------------------


def list_custom_models_in_region(
    ctx: SessionContext, region: str
) -> list[CustomModelSummary]:
    bedrock = ctx.client("bedrock", region=region)
    out: list[CustomModelSummary] = []
    try:
        paginator = bedrock.get_paginator("list_custom_models")
        for page in paginator.paginate():
            for cm in page.get("modelSummaries", []) or []:
                arn = cm.get("modelArn", "")
                tags = _list_tags(bedrock, arn) if arn else {}
                out.append(
                    CustomModelSummary(
                        arn=arn,
                        name=cm.get("modelName", ""),
                        region=region,
                        base_model=cm.get("baseModelArn", ""),
                        tags=tags,
                    )
                )
    except (ClientError, AttributeError, KeyError) as e:
        log.debug("list_custom_models not available in %s: %s", region, e)
    return out


def list_guardrails_in_region(
    ctx: SessionContext, region: str
) -> list[GuardrailSummary]:
    bedrock = ctx.client("bedrock", region=region)
    out: list[GuardrailSummary] = []
    try:
        paginator = bedrock.get_paginator("list_guardrails")
        for page in paginator.paginate():
            for gr in page.get("guardrails", []) or []:
                gid = gr.get("id", "")
                arn = gr.get("arn", "")
                tags = _list_tags(bedrock, arn) if arn else {}
                out.append(
                    GuardrailSummary(
                        guardrail_id=gid,
                        name=gr.get("name", ""),
                        region=region,
                        status=gr.get("status", ""),
                        tags=tags,
                    )
                )
    except (ClientError, AttributeError, KeyError) as e:
        log.debug("list_guardrails not available in %s: %s", region, e)
    return out


def list_provisioned_throughputs_in_region(
    ctx: SessionContext, region: str
) -> list[ProvisionedThroughputSummary]:
    bedrock = ctx.client("bedrock", region=region)
    out: list[ProvisionedThroughputSummary] = []
    try:
        paginator = bedrock.get_paginator("list_provisioned_model_throughputs")
        for page in paginator.paginate():
            for pt in page.get("provisionedModelSummaries", []) or []:
                arn = pt.get("provisionedModelArn", "")
                tags = _list_tags(bedrock, arn) if arn else {}
                out.append(
                    ProvisionedThroughputSummary(
                        arn=arn,
                        name=pt.get("provisionedModelName", ""),
                        region=region,
                        model_arn=pt.get("modelArn", ""),
                        status=pt.get("status", ""),
                        tags=tags,
                    )
                )
    except (ClientError, AttributeError, KeyError) as e:
        log.debug(
            "list_provisioned_model_throughputs not available in %s: %s", region, e
        )
    return out


def get_invocation_logging_config(
    ctx: SessionContext, region: str
) -> ModelInvocationLoggingConfig:
    """Return the model invocation logging config for the region.

    Returns a record with `enabled=False` if logging is not configured.
    """
    bedrock = ctx.client("bedrock", region=region)
    try:
        resp = bedrock.get_model_invocation_logging_configuration()
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "")
        log.debug("get_model_invocation_logging_configuration in %s: %s", region, code)
        return ModelInvocationLoggingConfig(region=region, enabled=False)

    cfg = resp.get("loggingConfig")
    if not cfg:
        return ModelInvocationLoggingConfig(region=region, enabled=False)

    cw = cfg.get("cloudWatchConfig", {}) or {}
    s3 = cfg.get("s3Config", {}) or {}
    return ModelInvocationLoggingConfig(
        region=region,
        enabled=True,
        cloudwatch_log_group=cw.get("logGroupName"),
        s3_bucket=s3.get("bucketName"),
        image_data_delivery=cfg.get("imageDataDeliveryEnabled", False),
        text_data_delivery=cfg.get("textDataDeliveryEnabled", False),
        embedding_data_delivery=cfg.get("embeddingDataDeliveryEnabled", False),
    )


def regions_with_bedrock_activity(
    ctx: SessionContext, regions: list[str]
) -> list[str]:
    """Return the subset of `regions` where this account has called Bedrock.

    Heuristic: query CloudWatch's `AWS/Bedrock` namespace for any model
    invocations in the last 30 days. If the namespace has any datapoints,
    the account has touched Bedrock there.

    This is fast (one ListMetrics call per region) and cheap.
    """
    active: list[str] = []

    def _check(r: str) -> str | None:
        cw = ctx.client("cloudwatch", region=r)
        try:
            resp = cw.list_metrics(Namespace="AWS/Bedrock", MetricName="Invocations")
            if resp.get("Metrics"):
                return r
        except ClientError as e:
            log.debug("list_metrics in %s: %s", r, e)
        return None

    with ThreadPoolExecutor(max_workers=8) as pool:
        for f in as_completed([pool.submit(_check, r) for r in regions]):
            res = f.result()
            if res:
                active.append(res)
    return sorted(active)


def inventory_all_regions(
    ctx: SessionContext, regions: list[str]
) -> tuple[
    list[InferenceProfileSummary],
    list[ProjectSummary],
    list[ModelInvocationLoggingConfig],
    list[AgentSummary],
    list[KnowledgeBaseSummary],
    list[CustomModelSummary],
    list[GuardrailSummary],
    list[ProvisionedThroughputSummary],
]:
    """Run the full Bedrock inventory across `regions` in parallel.

    Returns (profiles, projects, logging_configs, agents, knowledge_bases,
    custom_models, guardrails, provisioned_throughputs).
    """
    profiles: list[InferenceProfileSummary] = []
    projects: list[ProjectSummary] = []
    logging_configs: list[ModelInvocationLoggingConfig] = []
    agents: list[AgentSummary] = []
    knowledge_bases: list[KnowledgeBaseSummary] = []
    custom_models: list[CustomModelSummary] = []
    guardrails: list[GuardrailSummary] = []
    provisioned_throughputs: list[ProvisionedThroughputSummary] = []

    def _per_region(r: str):
        # Each sub-call is wrapped so one failure doesn't drop the others.
        results: dict = {}
        sub_calls = [
            ("profiles", lambda: list_application_inference_profiles_in_region(ctx, r), []),
            ("projects", lambda: list_projects_in_region(ctx, r), []),
            ("logging", lambda: get_invocation_logging_config(ctx, r),
             ModelInvocationLoggingConfig(region=r, enabled=False)),
            ("agents", lambda: list_agents_in_region(ctx, r), []),
            ("knowledge_bases", lambda: list_knowledge_bases_in_region(ctx, r), []),
            ("custom_models", lambda: list_custom_models_in_region(ctx, r), []),
            ("guardrails", lambda: list_guardrails_in_region(ctx, r), []),
            ("provisioned_throughputs", lambda: list_provisioned_throughputs_in_region(ctx, r), []),
        ]
        for key, fn, default in sub_calls:
            try:
                results[key] = fn()
            except Exception as e:  # noqa: BLE001
                log.warning("%s failed in %s: %s", key, r, e)
                results[key] = default
        return results

    with ThreadPoolExecutor(max_workers=8) as pool:
        futs = {pool.submit(_per_region, r): r for r in regions}
        for f in as_completed(futs):
            r = futs[f]
            try:
                res = f.result()
                profiles.extend(res["profiles"])
                projects.extend(res["projects"])
                logging_configs.append(res["logging"])
                agents.extend(res["agents"])
                knowledge_bases.extend(res["knowledge_bases"])
                custom_models.extend(res["custom_models"])
                guardrails.extend(res["guardrails"])
                provisioned_throughputs.extend(res["provisioned_throughputs"])
            except Exception as e:  # noqa: BLE001
                log.warning("Inventory failed in %s: %s", r, e)

    return (
        profiles,
        projects,
        logging_configs,
        agents,
        knowledge_bases,
        custom_models,
        guardrails,
        provisioned_throughputs,
    )
