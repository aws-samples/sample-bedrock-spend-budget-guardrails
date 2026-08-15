"""AWS session helpers.

The tool is read-only and uses the caller's existing credential chain
(IAM Identity Center via Okta, named profile, env vars, or instance role).
For org mode, we layer `sts:AssumeRole` to fan out into member accounts.

No long-lived secrets are ever written or read by this module.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

log = logging.getLogger(__name__)


# Default Bedrock-supported commercial regions. Kept conservative — script
# can override via --regions. We do NOT include GovCloud regions; the
# proposal explicitly scopes to commercial.
DEFAULT_BEDROCK_REGIONS = [
    "us-east-1",
    "us-east-2",
    "us-west-2",
    "ca-central-1",
    "eu-west-1",
    "eu-west-2",
    "eu-west-3",
    "eu-central-1",
    "eu-north-1",
    "ap-northeast-1",
    "ap-northeast-2",
    "ap-northeast-3",
    "ap-southeast-1",
    "ap-southeast-2",
    "ap-south-1",
    "sa-east-1",
]

# Cost Explorer is region-locked.
COST_EXPLORER_REGION = "us-east-1"


def default_botocore_config() -> Config:
    """Conservative retry config for read-only operations."""
    return Config(
        retries={"max_attempts": 8, "mode": "adaptive"},
        connect_timeout=10,
        read_timeout=60,
    )


@dataclass
class SessionContext:
    """Encapsulates a boto3 Session with metadata about how it was created."""

    session: boto3.Session
    account_id: str
    caller_arn: str
    is_assumed_role: bool

    def client(self, service: str, region: str | None = None):
        kwargs = {"config": default_botocore_config()}
        if region:
            kwargs["region_name"] = region
        return self.session.client(service, **kwargs)


def build_local_session(profile: str | None = None) -> SessionContext:
    """Build a SessionContext from the local credential chain.

    Used by `account-audit` (single account) and as the bootstrap session
    for `org-audit` (which then assumes into member accounts).
    """
    session = boto3.Session(profile_name=profile) if profile else boto3.Session()
    sts = session.client("sts", config=default_botocore_config())
    try:
        ident = sts.get_caller_identity()
    except ClientError as e:
        raise RuntimeError(
            f"Unable to call sts:GetCallerIdentity. "
            f"Check that AWS credentials are configured. Error: {e}"
        ) from e

    return SessionContext(
        session=session,
        account_id=ident["Account"],
        caller_arn=ident["Arn"],
        is_assumed_role=False,
    )


def assume_into_account(
    bootstrap: SessionContext,
    target_account_id: str,
    role_name: str,
    session_name: str = "BedrockAttributionAudit",
    duration_seconds: int = 3600,
) -> SessionContext | None:
    """Assume `role_name` in `target_account_id` and return a child session.

    Returns None on failure (e.g., role doesn't exist in the target account).
    Errors are logged but do NOT raise — the caller continues with the next
    account so a single broken trust chain doesn't kill the whole sweep.
    """
    role_arn = f"arn:aws:iam::{target_account_id}:role/{role_name}"
    sts = bootstrap.client("sts")
    try:
        resp = sts.assume_role(
            RoleArn=role_arn,
            RoleSessionName=session_name,
            DurationSeconds=duration_seconds,
        )
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "Unknown")
        log.warning(
            "Skipping account %s: cannot assume %s (%s)",
            target_account_id,
            role_arn,
            code,
        )
        return None

    creds = resp["Credentials"]
    child_session = boto3.Session(
        aws_access_key_id=creds["AccessKeyId"],
        aws_secret_access_key=creds["SecretAccessKey"],
        aws_session_token=creds["SessionToken"],
    )
    child_sts = child_session.client("sts", config=default_botocore_config())
    ident = child_sts.get_caller_identity()
    return SessionContext(
        session=child_session,
        account_id=ident["Account"],
        caller_arn=ident["Arn"],
        is_assumed_role=True,
    )


def is_management_account(session_ctx: SessionContext) -> bool:
    """Check whether the current credentials belong to an Organizations management account."""
    org = session_ctx.client("organizations")
    try:
        resp = org.describe_organization()
        management_account_id = resp["Organization"]["MasterAccountId"]
        return management_account_id == session_ctx.account_id
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "")
        # AWSOrganizationsNotInUseException, AccessDeniedException — both
        # mean "not the management account or no Organizations visibility".
        log.debug("describe-organization failed: %s", code)
        return False
