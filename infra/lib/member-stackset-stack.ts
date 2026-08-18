import * as cdk from "aws-cdk-lib";
import * as cloudformation from "aws-cdk-lib/aws-cloudformation";
import { Construct } from "constructs";

export interface EnrolledMemberAccount {
  readonly accountId: string;
  readonly regions: string[];
}

/** Org-targeted enrollment. Each entry deploys the member
 *  stack to every account currently in the OU AND auto-deploys to
 *  any account joining the OU later. */
export interface EnrolledOu {
  readonly ouId: string;
  readonly regions: string[];
}

/** in-Org account-list enrollment via SERVICE_MANAGED StackSet
 *  with ACCOUNT_FILTER=INTERSECTION. No per-member bootstrap CFN
 *  required (CFN handles role provisioning when StackSets trusted
 *  access + activate-organizations-access are enabled). */
export interface EnrolledOrgAccount {
  readonly accountId: string;
  readonly regions: string[];
}

/** whole-org enrollment via SERVICE_MANAGED StackSet targeting
 *  the Org root with `accountFilterType=DIFFERENCE` excluding the home
 *  account (which is metered locally). `autoDeployment.enabled=true`
 *  so every account currently in the Org AND every account joining
 *  later auto-receives the member stack within ~10 min. Mutually
 *  exclusive with `enrolledOus` and `enrolledOrgAccounts` — both
 *  StackSets would try to provision the same `bbg-enforcement` IAM
 *  role and conflict. Operator picks one path. */
export interface EnrolledWholeOrg {
  readonly regions: string[];
  /** Optional override list of account IDs to additionally exclude
   *  beyond the home account (e.g., shared-services accounts that
   *  shouldn't have BBG roles). Most operators leave this empty. */
  readonly excludeAccountIds?: string[];
}

export interface MemberStackSetStackProps extends cdk.StackProps {
  readonly stagePrefix: string;
  /** ARNs of every home-account Lambda execution role that can assume
   *  the member's `bbg-enforcement` role: enforcement (DDB-stream
   *  consumer that does the create/attach), period-rollover (detach
   *  + delete at period boundary), and the budgets-api Lambda
   *  (the `/admin/budgets/{p}/{t}/release` route). All three share the
   *  same `bbg-enforcement` member role. */
  readonly homeEnforcementRoleArns: string[];
  /** ARN of the home-account meter Lambda's execution role.
   *  Pinned in each member account's `bbg-meter-reader` trust policy. */
  readonly homeMeterRoleArn: string;
  /** Explicit per-account enrollments (SELF_MANAGED StackSet — operator
   *  must one-time bootstrap AWSCloudFormationStackSetExecutionRole in
   *  each member). Empty list = no SELF_MANAGED StackSet deployed. */
  readonly enrolledMemberAccounts: EnrolledMemberAccount[];
  /** Org-targeted enrollments (SERVICE_MANAGED StackSet). The
   *  home account must be the Organizations management account or a
   *  delegated CloudFormation StackSet admin. Empty list = no
   *  SERVICE_MANAGED StackSet deployed. */
  readonly enrolledOus: EnrolledOu[];
  /** in-Org account-list enrollments (SERVICE_MANAGED with
   *  ACCOUNT_FILTER=INTERSECTION). Skips the per-member bootstrap
   *  CFN that SELF_MANAGED requires. Empty list = no in-Org account
   *  StackSet deployed. */
  readonly enrolledOrgAccounts: EnrolledOrgAccount[];
  /** whole-org enrollment (SERVICE_MANAGED with
   *  ACCOUNT_FILTER=DIFFERENCE excluding home + optional extras).
   *  Mutually exclusive with enrolledOus + enrolledOrgAccounts.
   *  Undefined = no whole-org StackSet deployed. */
  readonly enrolledWholeOrg?: EnrolledWholeOrg;
  /** ENF-1: AWS Organizations ID (`o-xxxx`) of the home account's Org.
   *  When set, the member `bbg-enforcement` role trust policy gains an
   *  `aws:PrincipalOrgID` `StringEquals` condition (defence in depth on
   *  top of the home-role-ARN `Principal` allowlist). Sourced from
   *  operator-config `bbg:organizationId` (auto-detected at synth).
   *  Undefined ⇒ condition omitted with a synth-time warning (keeps the
   *  current allowlist-only behavior rather than breaking deploys). */
  readonly organizationId?: string;
}

/**
 * deploys a self-managed CFN StackSet from the home account
 * that provisions per-member-account IAM roles in each enrolled member.
 *
 * Two roles per member:
 *   - `bbg-enforcement` — assumed by the home enforcement Lambda. Can
 *     attach/detach/create/delete `bbg-deny-*` IAM policies in the
 *     member, scoped via `iam:PolicyARN` ArnEquals condition.
 *   - `bbg-meter-reader` — assumed by the home meter Lambda. Reserved
 *     for future cross-account log forwarding (currently unused).
 *
 * Self-managed permission model — operator must one-time bootstrap
 * `AWSCloudFormationStackSetExecutionRole` in each member account
 * trusting the home account's `AWSCloudFormationStackSetAdministrationRole`.
 * See `docs/multi-account-multi-region.md` § 6.2.1 for the bootstrap CFN.
 *
 * Skipped entirely when `enrolledMemberAccounts` is empty (default).
 * Existing single-account deployments don't deploy this stack at all
 * (gated in `app-stage.ts`).
 */
export class MemberStackSetStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MemberStackSetStackProps) {
    super(scope, id, props);

    const {
      stagePrefix,
      homeEnforcementRoleArns,
      homeMeterRoleArn,
      enrolledMemberAccounts,
      enrolledOus,
      enrolledOrgAccounts,
      enrolledWholeOrg,
      organizationId,
    } = props;

    if (
      enrolledMemberAccounts.length === 0 &&
      enrolledOus.length === 0 &&
      enrolledOrgAccounts.length === 0 &&
      !enrolledWholeOrg
    ) {
      // No-op stack so the synth tree is stable but no resources land.
      return;
    }

    // whole-org takes precedence over per-OU and per-account
    // SERVICE_MANAGED paths. CFN refuses two StackSets racing to create
    // the same global bbg-enforcement IAM role, so when whole-org is
    // active the other two SERVICE_MANAGED paths are silently skipped
    // by zeroing them out below. The operator's per-account/per-OU
    // selections stay in SSM unchanged — flipping whole-org off later
    // restores the previous deployment shape with no further edits.
    // The SELF_MANAGED enrolledMemberAccounts path (external accounts
    // outside the Org) is NOT affected by whole-org since it deploys
    // to accounts the SERVICE_MANAGED StackSet can't reach anyway.
    let effectiveEnrolledOus = enrolledOus;
    let effectiveEnrolledOrgAccounts = enrolledOrgAccounts;
    if (
      enrolledWholeOrg &&
      (enrolledOus.length > 0 || enrolledOrgAccounts.length > 0)
    ) {
      cdk.Annotations.of(this).addInfo(
        `[${stagePrefix}] enrolledWholeOrg is active — skipping ${enrolledOus.length} per-OU and ` +
          `${enrolledOrgAccounts.length} per-account SERVICE_MANAGED enrollments. They remain in ` +
          "SSM and will reactivate when whole-org is turned off.",
      );
      effectiveEnrolledOus = [];
      effectiveEnrolledOrgAccounts = [];
    }

    const homeAccountId = this.account;
    const homeRegion = cdk.Stack.of(this).region;

    // ENF-1: constrain who can assume the member `bbg-enforcement` role.
    // The `Principal` allowlist (home Lambda role ARNs) stays as the
    // primary control; when we know the Org ID we ADD an
    // `aws:PrincipalOrgID` StringEquals condition so a leaked/guessed home
    // role ARN outside the Org still can't assume the role (defence in
    // depth). Omitted with a warning when the Org ID isn't available —
    // keeps single-account / no-Organizations deploys working.
    const enforcementTrustCondition = organizationId
      ? { StringEquals: { "aws:PrincipalOrgID": organizationId } }
      : undefined;
    if (!enforcementTrustCondition) {
      cdk.Annotations.of(this).addWarning(
        `[${stagePrefix}] bbg:organizationId is not set — the member bbg-enforcement trust ` +
          "policy will rely on the home-role-ARN allowlist alone (no aws:PrincipalOrgID " +
          "condition). Set bbg:organizationId in operator-config to enable the ENF-1 " +
          "defence-in-depth condition.",
      );
    }

    // F2: the ONLY principal allowed to assume the member bbg-readiness-reader
    // role is the home-account Readiness Lambda's execution role, whose name is
    // pinned deterministically in api-stack.ts (`${stagePrefix}-bbg-readiness`).
    // Trust is further constrained by the audit's fixed RoleSessionName
    // (`BedrockAttributionAudit`, set in the readiness engine's
    // core/auth.assume_into_account) and — when the Org ID is known — an
    // aws:PrincipalOrgID condition, so a leaked home-role ARN outside the Org
    // or an assume with any other session name still can't sweep members.
    const readinessReaderPrincipalArn = `arn:aws:iam::${homeAccountId}:role/${stagePrefix}-bbg-readiness`;
    const readinessReaderTrustCondition = {
      StringEquals: {
        "sts:RoleSessionName": "BedrockAttributionAudit",
        ...(organizationId ? { "aws:PrincipalOrgID": organizationId } : {}),
      },
    };

    // Inline Python forwarder. Member-account CWL subscription
    // gzip-base64-encodes the message; we decode, fan out one PutEvents
    // batch (max 10 entries) per call to the home default bus. Total
    // < 4KB so CFN's inline-code limit isn't a constraint.
    const forwarderPythonCode = `import base64, gzip, json, os
import boto3

HOME_REGION = os.environ['HOME_REGION']
HOME_ACCOUNT = os.environ['HOME_ACCOUNT']
SOURCE_REGION = os.environ.get('AWS_REGION', '')
events = boto3.client('events', region_name=HOME_REGION)
HOME_BUS_ARN = f'arn:aws:events:{HOME_REGION}:{HOME_ACCOUNT}:event-bus/default'

def handler(event, _ctx):
    payload = json.loads(gzip.decompress(base64.b64decode(event['awslogs']['data'])))
    if payload.get('messageType') != 'DATA_MESSAGE':
        return
    log_events = payload.get('logEvents', [])
    for i in range(0, len(log_events), 10):
        batch = log_events[i:i+10]
        events.put_events(Entries=[{
            'EventBusName': HOME_BUS_ARN,
            'Source': 'bbg.metering',
            'DetailType': 'bbg.bedrock-invocation',
            'Detail': json.dumps({
                'sourceRegion': SOURCE_REGION,
                'cwlMessage': ev['message'],
                'cwlTimestamp': ev['timestamp'],
                'cwlId': ev['id'],
            }),
        } for ev in batch])
    print(f'forwarded {len(log_events)} events from {SOURCE_REGION}')
`;

    // Inline CFN template body — the per-member IAM roles + ingest
    // forwarders. This template is rendered exactly once at synth and
    // shipped to every enrolled member account by the StackSet.
    //
    // The StackSet creates one stack per (account, region). IAM is a
    // global service — `bbg-enforcement` and `bbg-meter-reader` must
    // exist exactly once per account, NOT per region. Gate the IAM
    // resources via a CFN Condition that fires only in the home
    // region. The CWL forwarder + Bedrock invocation logging + EB rule
    // remain per-region (Bedrock can only deliver invocation logs to a
    // same-region log group; CWL subscription filters to Lambda are
    // same-region only).
    const templateBody = {
      AWSTemplateFormatVersion: "2010-09-09",
      Description: `BBG (${stagePrefix}) cross-account IAM roles + ingest. Deployed via StackSet from home account ${homeAccountId}.`,
      Conditions: {
        IsHomeRegion: { "Fn::Equals": [{ Ref: "AWS::Region" }, homeRegion] },
      },
      Resources: {
        BbgEnforcementRole: {
          Type: "AWS::IAM::Role",
          Condition: "IsHomeRegion",
          Properties: {
            RoleName: "bbg-enforcement",
            Description:
              "BBG cross-account enforcement role. Trusted by the home-account enforcement Lambda to attach bbg-deny-* policies in this member account.",
            AssumeRolePolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { AWS: homeEnforcementRoleArns },
                  Action: "sts:AssumeRole",
                  // ENF-1: defence-in-depth Org constraint (added only when
                  // the Org ID is known at synth time).
                  ...(enforcementTrustCondition
                    ? { Condition: enforcementTrustCondition }
                    : {}),
                },
              ],
            },
            Policies: [
              {
                PolicyName: "BbgEnforcementInline",
                PolicyDocument: {
                  Version: "2012-10-17",
                  Statement: [
                    {
                      Sid: "BbgManageDenyPolicies",
                      Effect: "Allow",
                      Action: [
                        "iam:CreatePolicy",
                        "iam:CreatePolicyVersion",
                        "iam:DeletePolicy",
                        "iam:DeletePolicyVersion",
                        "iam:GetPolicy",
                        "iam:ListPolicyVersions",
                        "iam:ListEntitiesForPolicy",
                      ],
                      // Use AWS::AccountId so the same template body works
                      // for every enrolled member; CFN substitutes it at
                      // deploy time per-account.
                      Resource: {
                        "Fn::Sub":
                          "arn:aws:iam::${AWS::AccountId}:policy/bbg-deny-*",
                      },
                    },
                    {
                      Sid: "BbgAttachDetachUser",
                      Effect: "Allow",
                      Action: ["iam:AttachUserPolicy", "iam:DetachUserPolicy"],
                      Resource: {
                        "Fn::Sub": "arn:aws:iam::${AWS::AccountId}:user/*",
                      },
                      Condition: {
                        ArnEquals: {
                          "iam:PolicyARN": {
                            "Fn::Sub":
                              "arn:aws:iam::${AWS::AccountId}:policy/bbg-deny-*",
                          },
                        },
                      },
                    },
                    {
                      Sid: "BbgAttachDetachRole",
                      Effect: "Allow",
                      Action: ["iam:AttachRolePolicy", "iam:DetachRolePolicy"],
                      Resource: {
                        "Fn::Sub": "arn:aws:iam::${AWS::AccountId}:role/*",
                      },
                      Condition: {
                        ArnEquals: {
                          "iam:PolicyARN": {
                            "Fn::Sub":
                              "arn:aws:iam::${AWS::AccountId}:policy/bbg-deny-*",
                          },
                        },
                      },
                    },
                    {
                      Sid: "BbgReadPrincipals",
                      Effect: "Allow",
                      Action: ["iam:GetUser", "iam:GetRole"],
                      Resource: "*",
                    },
                  ],
                },
              },
            ],
          },
        },
        BbgMeterReaderRole: {
          Type: "AWS::IAM::Role",
          Condition: "IsHomeRegion",
          Properties: {
            RoleName: "bbg-meter-reader",
            Description:
              "BBG cross-account meter-reader role. Reserved for future use; trusted by the home-account meter Lambda.",
            AssumeRolePolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { AWS: homeMeterRoleArn },
                  Action: "sts:AssumeRole",
                },
              ],
            },
            Policies: [
              {
                PolicyName: "BbgMeterReaderInline",
                PolicyDocument: {
                  Version: "2012-10-17",
                  Statement: [
                    {
                      Sid: "BbgPutEventsHome",
                      Effect: "Allow",
                      Action: ["events:PutEvents"],
                      Resource: `arn:aws:events:*:${homeAccountId}:event-bus/default`,
                    },
                    {
                      Sid: "BbgDescribeLogs",
                      Effect: "Allow",
                      Action: [
                        "logs:Describe*",
                        "logs:GetLogEvents",
                        "logs:FilterLogEvents",
                      ],
                      Resource: {
                        "Fn::Sub":
                          "arn:aws:logs:*:${AWS::AccountId}:log-group:/aws/bedrock/*",
                      },
                    },
                  ],
                },
              },
            ],
          },
        },

        // F2: dedicated read-only role for the home-account Readiness Lambda's
        // org-sweep (org-mode). Replaces the AdministratorAccess
        // OrganizationAccountAccessRole the audit previously assumed — a
        // code-compromise on the Readiness Lambda can now only Describe/List/Get
        // in the member, never mutate. Trust is pinned to the home Readiness
        // Lambda role ARN + the audit's fixed RoleSessionName (+ Org ID when
        // known). Permission set mirrors the Lambda's own discovery grant in
        // api-stack.ts (all read-only; these APIs have no resource-level
        // scoping so the '*' is covered by the blanket AwsSolutions-IAM5
        // suppression in bin/app.ts).
        BbgReadinessReaderRole: {
          Type: "AWS::IAM::Role",
          Condition: "IsHomeRegion",
          Properties: {
            RoleName: "bbg-readiness-reader",
            Description:
              "BBG cross-account read-only readiness-audit role. Trusted by the home-account Readiness Lambda to run Bedrock-attribution discovery (Describe/List/Get only) in this member account.",
            AssumeRolePolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { AWS: readinessReaderPrincipalArn },
                  Action: "sts:AssumeRole",
                  Condition: readinessReaderTrustCondition,
                },
              ],
            },
            Policies: [
              {
                PolicyName: "BbgReadinessReadOnly",
                PolicyDocument: {
                  Version: "2012-10-17",
                  Statement: [
                    {
                      Sid: "BbgReadinessDiscovery",
                      Effect: "Allow",
                      Action: [
                        "ce:GetCostAndUsage",
                        "organizations:DescribeOrganization",
                        "organizations:ListAccounts",
                        "iam:ListRoles",
                        "iam:ListUsers",
                        "iam:ListRolePolicies",
                        "iam:ListAttachedRolePolicies",
                        "iam:GetRolePolicy",
                        "iam:ListUserPolicies",
                        "iam:ListAttachedUserPolicies",
                        "iam:GetUserPolicy",
                        "iam:GetPolicy",
                        "iam:GetPolicyVersion",
                        "iam:ListUserTags",
                        "iam:ListRoleTags",
                        "bedrock:ListInferenceProfiles",
                        "bedrock:ListProjects",
                        "bedrock:ListAgents",
                        "bedrock:ListKnowledgeBases",
                        "bedrock:ListCustomModels",
                        "bedrock:ListGuardrails",
                        "bedrock:ListProvisionedModelThroughputs",
                        "bedrock:ListTagsForResource",
                        "bedrock:GetModelInvocationLoggingConfiguration",
                        "cloudwatch:ListMetrics",
                        "cloudwatch:GetMetricData",
                        "cloudwatch:GetMetricStatistics",
                        "cloudtrail:DescribeTrails",
                        "cloudtrail:GetEventSelectors",
                        "bcm-data-exports:ListExports",
                        "bcm-data-exports:GetExport",
                      ],
                      Resource: "*",
                    },
                  ],
                },
              },
            ],
          },
        },

        // Bedrock invocation logging in this member account.
        // Bedrock writes invocation logs to the same per-region log
        // group shape the home-account MeteringStack uses. The CWL
        // subscription below fans them out to the home-region default
        // event bus.
        BbgBedrockLogGroup: {
          Type: "AWS::Logs::LogGroup",
          Properties: {
            LogGroupName: { "Fn::Sub": "/aws/bedrock/bbg-${AWS::Region}" },
            RetentionInDays: 14,
          },
        },

        // Bedrock InvocationLoggingConfiguration is account+region-
        // singleton and currently has no plain CFN resource type, so we
        // use a custom-resource wrapper around the bedrock:PutModelInvo
        // cationLoggingConfiguration API. ServiceToken points at the
        // BbgInvocationLoggingProvider Lambda below.
        BbgInvocationLoggingConfig: {
          Type: "Custom::BbgInvocationLogging",
          DependsOn: ["BbgBedrockLogGroup", "BbgInvocationLoggingProvider"],
          Properties: {
            ServiceToken: {
              "Fn::GetAtt": ["BbgInvocationLoggingProvider", "Arn"],
            },
            LogGroupName: { "Fn::Sub": "/aws/bedrock/bbg-${AWS::Region}" },
            LogRoleArn: { "Fn::GetAtt": ["BbgBedrockLogRole", "Arn"] },
          },
        },

        BbgBedrockLogRole: {
          Type: "AWS::IAM::Role",
          Properties: {
            AssumeRolePolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { Service: "bedrock.amazonaws.com" },
                  Action: "sts:AssumeRole",
                  // N6: confused-deputy guard. Bedrock invocation logging is
                  // account+region scoped, so pin the trust to this member
                  // account (aws:SourceAccount) and its Bedrock ARNs
                  // (aws:SourceArn) — mirrors budgets-action-stack.ts and
                  // multi-agent-stack.ts. Both the member account id and the
                  // region are substituted by CFN per stack-instance at
                  // deploy time.
                  Condition: {
                    StringEquals: {
                      "aws:SourceAccount": { Ref: "AWS::AccountId" },
                    },
                    ArnLike: {
                      "aws:SourceArn": {
                        "Fn::Sub":
                          "arn:aws:bedrock:${AWS::Region}:${AWS::AccountId}:*",
                      },
                    },
                  },
                },
              ],
            },
            Policies: [
              {
                PolicyName: "WriteInvocationLogs",
                PolicyDocument: {
                  Version: "2012-10-17",
                  Statement: [
                    {
                      Effect: "Allow",
                      Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
                      Resource: { "Fn::GetAtt": ["BbgBedrockLogGroup", "Arn"] },
                    },
                  ],
                },
              },
            ],
          },
        },

        BbgInvocationLoggingProviderRole: {
          Type: "AWS::IAM::Role",
          Properties: {
            AssumeRolePolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { Service: "lambda.amazonaws.com" },
                  Action: "sts:AssumeRole",
                },
              ],
            },
            ManagedPolicyArns: [
              "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
            ],
            Policies: [
              {
                PolicyName: "ManageInvocationLogging",
                PolicyDocument: {
                  Version: "2012-10-17",
                  Statement: [
                    {
                      Effect: "Allow",
                      Action: [
                        "bedrock:GetModelInvocationLoggingConfiguration",
                        "bedrock:PutModelInvocationLoggingConfiguration",
                        "bedrock:DeleteModelInvocationLoggingConfiguration",
                      ],
                      Resource: "*",
                    },
                    {
                      Effect: "Allow",
                      Action: ["iam:PassRole"],
                      Resource: { "Fn::GetAtt": ["BbgBedrockLogRole", "Arn"] },
                    },
                  ],
                },
              },
            ],
          },
        },

        BbgInvocationLoggingProvider: {
          Type: "AWS::Lambda::Function",
          Properties: {
            FunctionName: {
              "Fn::Sub": "bbg-invocation-logging-provider-${AWS::Region}",
            },
            Runtime: "python3.12",
            Handler: "index.handler",
            Role: { "Fn::GetAtt": ["BbgInvocationLoggingProviderRole", "Arn"] },
            Timeout: 60,
            Code: {
              ZipFile: `import json, urllib.request
import boto3
bedrock = boto3.client('bedrock')
def send(event, status, data=None, reason=''):
    body = json.dumps({
        'Status': status, 'Reason': reason or 'See CloudWatch logs',
        'PhysicalResourceId': event.get('PhysicalResourceId') or 'bbg-invocation-logging',
        'StackId': event['StackId'], 'RequestId': event['RequestId'],
        'LogicalResourceId': event['LogicalResourceId'],
        'Data': data or {},
    }).encode('utf-8')
    req = urllib.request.Request(event['ResponseURL'], data=body, method='PUT')
    req.add_header('Content-Type', '')
    urllib.request.urlopen(req)
def handler(event, _ctx):
    try:
        if event['RequestType'] in ('Create', 'Update'):
            bedrock.put_model_invocation_logging_configuration(
                loggingConfig={
                    'cloudWatchConfig': {
                        'logGroupName': event['ResourceProperties']['LogGroupName'],
                        'roleArn': event['ResourceProperties']['LogRoleArn'],
                    },
                    'textDataDeliveryEnabled': False,
                    'imageDataDeliveryEnabled': False,
                    'embeddingDataDeliveryEnabled': False,
                    'videoDataDeliveryEnabled': False,
                }
            )
        elif event['RequestType'] == 'Delete':
            try:
                bedrock.delete_model_invocation_logging_configuration()
            except Exception:
                pass
        send(event, 'SUCCESS')
    except Exception as e:
        send(event, 'FAILED', reason=str(e)[:200])
`,
            },
          },
        },

        // Cross-account log forwarder. Decodes the gzip-base64 CWL
        // payload and PutEvents to the home-region default bus. The
        // home meter Lambda's RemoteBedrockInvocationRule consumes
        // these events identically to the same-account cross-region
        // case (Phase 1b).
        BbgCwlForwarderRole: {
          Type: "AWS::IAM::Role",
          Properties: {
            AssumeRolePolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { Service: "lambda.amazonaws.com" },
                  Action: "sts:AssumeRole",
                },
              ],
            },
            ManagedPolicyArns: [
              "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
            ],
            Policies: [
              {
                PolicyName: "PutEventsHome",
                PolicyDocument: {
                  Version: "2012-10-17",
                  Statement: [
                    {
                      Effect: "Allow",
                      Action: ["events:PutEvents"],
                      Resource: `arn:aws:events:${homeRegion}:${homeAccountId}:event-bus/default`,
                    },
                  ],
                },
              },
            ],
          },
        },

        BbgCwlForwarder: {
          Type: "AWS::Lambda::Function",
          Properties: {
            FunctionName: { "Fn::Sub": "bbg-cwl-forwarder-${AWS::Region}" },
            Runtime: "python3.12",
            Handler: "index.handler",
            Role: { "Fn::GetAtt": ["BbgCwlForwarderRole", "Arn"] },
            Timeout: 30,
            Environment: {
              Variables: {
                HOME_REGION: homeRegion,
                HOME_ACCOUNT: homeAccountId,
              },
            },
            Code: { ZipFile: forwarderPythonCode },
          },
        },

        BbgCwlForwarderInvokePermission: {
          Type: "AWS::Lambda::Permission",
          Properties: {
            FunctionName: { "Fn::GetAtt": ["BbgCwlForwarder", "Arn"] },
            Action: "lambda:InvokeFunction",
            Principal: { "Fn::Sub": "logs.${AWS::Region}.amazonaws.com" },
            SourceArn: { "Fn::GetAtt": ["BbgBedrockLogGroup", "Arn"] },
          },
        },

        BbgCwlSubscription: {
          Type: "AWS::Logs::SubscriptionFilter",
          DependsOn: ["BbgCwlForwarderInvokePermission"],
          Properties: {
            LogGroupName: { Ref: "BbgBedrockLogGroup" },
            FilterPattern: "",
            DestinationArn: { "Fn::GetAtt": ["BbgCwlForwarder", "Arn"] },
          },
        },

        // CloudTrail Bedrock data events also forward to the home bus
        // via a cross-account EventBridge rule. Cross-account event
        // bus targets accept a target IAM role in the source account;
        // the home-account default bus must permit PutEvents from
        // this account (granted by EventBusPolicy in app-stage).
        BbgBedrockApiEventRole: {
          Type: "AWS::IAM::Role",
          Properties: {
            AssumeRolePolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { Service: "events.amazonaws.com" },
                  Action: "sts:AssumeRole",
                },
              ],
            },
            Policies: [
              {
                PolicyName: "PutEventsHome",
                PolicyDocument: {
                  Version: "2012-10-17",
                  Statement: [
                    {
                      Effect: "Allow",
                      Action: ["events:PutEvents"],
                      Resource: `arn:aws:events:${homeRegion}:${homeAccountId}:event-bus/default`,
                    },
                  ],
                },
              },
            ],
          },
        },

        BbgBedrockApiRule: {
          Type: "AWS::Events::Rule",
          Properties: {
            Name: { "Fn::Sub": "bbg-bedrock-runtime-${AWS::Region}" },
            EventPattern: {
              source: [
                "aws.bedrock-runtime",
                "aws.bedrock",
                "aws.bedrock-agent-runtime",
              ],
              "detail-type": ["AWS API Call via CloudTrail"],
              detail: {
                eventName: [
                  "InvokeModel",
                  "InvokeModelWithResponseStream",
                  "Converse",
                  "ConverseStream",
                  // OpenAI-compatible APIs on the /openai/v1 paths of bedrock-runtime. Verified
                  // 2026-08-18 against a live call: CloudTrail logs these as MANAGEMENT events
                  // (eventName 'Responses', eventCategory 'Management', managementEvent true,
                  // eventSource bedrock.amazonaws.com) carrying userIdentity + a requestID that
                  // matches the invocation-log record. Without them the meter writes to
                  // PendingMeter, the row TTLs out after 1h, and the spend is silently lost --
                  // reproduced before this fix.
                  "Responses",
                  "ChatCompletions",
                  "InvokeAgent",
                  "Retrieve",
                  "RetrieveAndGenerate",
                ],
              },
            },
            Targets: [
              {
                Id: "home-bus",
                Arn: `arn:aws:events:${homeRegion}:${homeAccountId}:event-bus/default`,
                RoleArn: { "Fn::GetAtt": ["BbgBedrockApiEventRole", "Arn"] },
              },
            ],
          },
        },
      },
      Outputs: {
        EnforcementRoleArn: {
          Condition: "IsHomeRegion",
          Value: { "Fn::GetAtt": ["BbgEnforcementRole", "Arn"] },
        },
        MeterReaderRoleArn: {
          Condition: "IsHomeRegion",
          Value: { "Fn::GetAtt": ["BbgMeterReaderRole", "Arn"] },
        },
        ReadinessReaderRoleArn: {
          Condition: "IsHomeRegion",
          Value: { "Fn::GetAtt": ["BbgReadinessReaderRole", "Arn"] },
        },
        BedrockLogGroup: {
          Value: { Ref: "BbgBedrockLogGroup" },
        },
        CwlForwarderArn: {
          Value: { "Fn::GetAtt": ["BbgCwlForwarder", "Arn"] },
        },
      },
    };

    const templateBodyJson = JSON.stringify(templateBody);

    // SELF_MANAGED StackSet — explicit per-account enrollments. Each
    // (accountId, region) pair becomes a stack instance. Member-account
    // operators must one-time bootstrap AWSCloudFormationStackSetExecu
    // tionRole; see docs/multi-account-multi-region.md § 6.2.1.
    if (enrolledMemberAccounts.length > 0) {
      new cloudformation.CfnStackSet(this, "BbgMemberRoles", {
        stackSetName: `${stagePrefix}-bbg-member-roles`,
        description: `BBG (${stagePrefix}) cross-account roles + ingest for explicitly-enrolled member accounts.`,
        permissionModel: "SELF_MANAGED",
        capabilities: ["CAPABILITY_NAMED_IAM"],
        templateBody: templateBodyJson,
        stackInstancesGroup: enrolledMemberAccounts.map((m) => ({
          regions: m.regions,
          deploymentTargets: { accounts: [m.accountId] },
        })),
        operationPreferences: {
          maxConcurrentCount: 1,
          failureToleranceCount: 0,
        },
      });

      new cdk.CfnOutput(this, "MemberStackSetName", {
        value: `${stagePrefix}-bbg-member-roles`,
      });
    }

    // SERVICE_MANAGED StackSet — Org-targeted enrollments with
    // auto-deployment. New accounts joining any of the listed OUs
    // automatically get the member stack within minutes (CFN Org-wide
    // auto-deploy). Removal from an OU detaches the stack.
    //
    // Prereqs (operator runs once in the Org management account):
    //   aws cloudformation activate-organizations-access
    //   aws organizations enable-aws-service-access \
    //     --service-principal=member.org.stacksets.cloudformation.amazonaws.com
    //
    // Both must be enabled in the home account, which must be the Org
    // management account (or a registered delegated administrator).
    if (effectiveEnrolledOus.length > 0) {
      new cloudformation.CfnStackSet(this, "BbgMemberRolesOrg", {
        stackSetName: `${stagePrefix}-bbg-member-roles-org`,
        description: `BBG (${stagePrefix}) cross-account roles + ingest, Org-wide auto-deploy by OU.`,
        permissionModel: "SERVICE_MANAGED",
        autoDeployment: {
          enabled: true,
          retainStacksOnAccountRemoval: false,
        },
        capabilities: ["CAPABILITY_NAMED_IAM"],
        templateBody: templateBodyJson,
        stackInstancesGroup: effectiveEnrolledOus.map((o) => ({
          regions: o.regions,
          deploymentTargets: { organizationalUnitIds: [o.ouId] },
        })),
        operationPreferences: {
          maxConcurrentPercentage: 50,
          failureTolerancePercentage: 25,
        },
      });

      new cdk.CfnOutput(this, "MemberStackSetOrgName", {
        value: `${stagePrefix}-bbg-member-roles-org`,
      });
    }

    // SERVICE_MANAGED StackSet with ACCOUNT_FILTER=INTERSECTION
    // for in-Org account-list enrollment (no per-member bootstrap CFN
    // required). Target = Org root + filter to the listed accounts. The
    // root ID isn't known at synth time — operators pass it via
    // `bbg:organizationRootId` (auto-detected by loadOperatorConfig
    // when missing). Without it we fall back to skipping this StackSet
    // and the in-Org accounts route to the SELF_MANAGED path (which
    // requires the bootstrap CFN, but at least doesn't fail synth).
    const orgRootId = this.node.tryGetContext("bbg:organizationRootId") as
      string | undefined;
    if (effectiveEnrolledOrgAccounts.length > 0 && orgRootId) {
      // Group by region to fold {acct1: [r1,r2], acct2: [r1]} into the
      // CFN StackInstancesGroup shape (one entry per distinct region
      // set). Most operators pick the same regions for every account,
      // so this collapses to a single group.
      const groupsByRegions = new Map<string, string[]>();
      for (const a of effectiveEnrolledOrgAccounts) {
        const key = [...a.regions].sort().join(",");
        const list = groupsByRegions.get(key) ?? [];
        list.push(a.accountId);
        groupsByRegions.set(key, list);
      }
      new cloudformation.CfnStackSet(this, "BbgMemberRolesOrgAccounts", {
        stackSetName: `${stagePrefix}-bbg-member-roles-org-accounts`,
        description: `BBG (${stagePrefix}) cross-account roles + ingest, in-Org account-list (no bootstrap CFN).`,
        permissionModel: "SERVICE_MANAGED",
        // CFN requires autoDeployment on every SERVICE_MANAGED StackSet
        // (even with accountFilterType=INTERSECTION). Disable the
        // auto-deploy behavior since the operator chose specific
        // accounts — adding/removing accounts is an operator action,
        // not an auto-managed-by-Org one.
        autoDeployment: {
          enabled: false,
        },
        capabilities: ["CAPABILITY_NAMED_IAM"],
        templateBody: templateBodyJson,
        stackInstancesGroup: [...groupsByRegions.entries()].map(
          ([regionKey, accountIds]) => ({
            regions: regionKey.split(","),
            deploymentTargets: {
              organizationalUnitIds: [orgRootId],
              accounts: accountIds,
              accountFilterType: "INTERSECTION",
            },
          }),
        ),
        operationPreferences: {
          maxConcurrentPercentage: 50,
          failureTolerancePercentage: 25,
        },
      });

      new cdk.CfnOutput(this, "MemberStackSetOrgAccountsName", {
        value: `${stagePrefix}-bbg-member-roles-org-accounts`,
      });
    } else if (effectiveEnrolledOrgAccounts.length > 0 && !orgRootId) {
      cdk.Annotations.of(this).addWarning(
        `${effectiveEnrolledOrgAccounts.length} in-Org account(s) enrolled but bbg:organizationRootId is not set; ` +
          "falling back to SELF_MANAGED (per-member bootstrap CFN required).",
      );
    }

    // whole-org StackSet. Targets the Org root with
    // accountFilterType=DIFFERENCE excluding the home account (always)
    // + any operator-supplied additional excludes. autoDeployment is
    // ON so accounts joining the Org auto-receive the member stack
    // within ~10 min. Pattern matches AWS Config / Security Hub
    // aggregator deployments.
    if (enrolledWholeOrg && orgRootId) {
      const excluded = new Set<string>([
        homeAccountId,
        ...(enrolledWholeOrg.excludeAccountIds ?? []),
      ]);
      new cloudformation.CfnStackSet(this, "BbgMemberRolesWholeOrg", {
        stackSetName: `${stagePrefix}-bbg-member-roles-whole-org`,
        description: `BBG (${stagePrefix}) cross-account roles + ingest, whole-org auto-deploy.`,
        permissionModel: "SERVICE_MANAGED",
        autoDeployment: {
          enabled: true,
          retainStacksOnAccountRemoval: false,
        },
        capabilities: ["CAPABILITY_NAMED_IAM"],
        templateBody: templateBodyJson,
        stackInstancesGroup: [
          {
            regions: enrolledWholeOrg.regions,
            deploymentTargets: {
              organizationalUnitIds: [orgRootId],
              accounts: [...excluded],
              accountFilterType: "DIFFERENCE",
            },
          },
        ],
        operationPreferences: {
          maxConcurrentPercentage: 50,
          failureTolerancePercentage: 25,
        },
      });

      new cdk.CfnOutput(this, "MemberStackSetWholeOrgName", {
        value: `${stagePrefix}-bbg-member-roles-whole-org`,
      });
    } else if (enrolledWholeOrg && !orgRootId) {
      cdk.Annotations.of(this).addWarning(
        "enrolledWholeOrg is set but bbg:organizationRootId is not (caller likely lacks " +
          "organizations:ListRoots). Whole-org StackSet not deployed.",
      );
    }
  }
}
