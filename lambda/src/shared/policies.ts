import { createHash } from 'node:crypto';

/**
 * Builds the customer-managed deny IAM policy document attached to a
 * principal when their budget is breached. Targets foundation-model ARNs
 * and matching inference-profile ARNs across every region.
 */
export interface DenyPolicyInputs {
  /** Either `model#<id>`, `model#*`, `profile#<arn>`, or `profile#*`. */
  target: string;
  /** Inference profile ARNs known to map to the model (when target is a model). */
  associatedProfileArns?: string[];
  /** When the budget is keyed on a session tag, restrict the deny via `aws:PrincipalTag/<key>`. */
  sessionTagKey?: string;
  sessionTagValue?: string;
  /**
   * Identity-lens enforcement (sso-user#<email> budgets): the deny is
   * attached to the ISSUER role (the AWSReservedSSO_* role every user of a
   * permission set shares) and restricted to just this user's sessions via
   * `aws:userid StringLike "*:<email>"` — an assumed-role session's
   * aws:userid is `<role-unique-id>:<session-name>`, and IAM Identity
   * Center sets the session name to the user's email. No ABAC / session-tag
   * configuration required. Mutually exclusive with sessionTagKey/Value and
   * sourceIdentity.
   */
  ssoUserEmail?: string;
  /**
   * Identity-lens enforcement (sourceIdentity#<value> budgets): restrict
   * the deny to sessions carrying this sts:SourceIdentity via
   * `aws:SourceIdentity StringEquals`. Mutually exclusive with the other
   * condition kinds.
   */
  sourceIdentity?: string;
}

export interface DenyPolicyDoc {
  Version: '2012-10-17';
  Statement: Array<{
    Sid: string;
    Effect: 'Deny';
    Action: string[];
    Resource: string[];
    Condition?:
      | { StringEquals: Record<string, string> }
      | { StringLike: Record<string, string> };
  }>;
}

const FM_ACTIONS = [
  'bedrock:InvokeModel',
  'bedrock:InvokeModelWithResponseStream',
  'bedrock:Converse',
  'bedrock:ConverseStream',
  // POL-1 (B2): async / batch / bidirectional invocation paths are just
  // as billable as the synchronous ones — an over-budget principal could
  // otherwise keep spending via these while the deny policy is attached.
  'bedrock:StartAsyncInvoke',
  'bedrock:CreateModelInvocationJob',
  'bedrock:InvokeModelWithBidirectionalStream',
];
const PROFILE_ACTIONS = [...FM_ACTIONS, 'bedrock:GetInferenceProfile'];
const KB_ACTIONS = ['bedrock:Retrieve', 'bedrock:RetrieveAndGenerate', 'bedrock:RetrieveAndGenerateStream'];
// Agent invocation (InvokeAgent, plus the GA InvokeInlineAgent path) drives
// billable FM traffic just like direct model calls — a denied principal could
// otherwise keep spending via an agent until period rollover. NOTE: the IAM
// service prefix is `bedrock:` (NOT `bedrock-agent-runtime:` — that is the API
// namespace, not the IAM action namespace; a `bedrock-agent-runtime:*` action
// matches nothing and the deny would be inert). Agent actions are authorized
// against agent-alias ARNs, so they need their own Resource-scoped statement
// (DenyBedrockAgents below) — they will NOT match the foundation-model /
// inference-profile ARNs used by DenyBedrockInference.
const AGENT_ACTIONS = ['bedrock:InvokeAgent', 'bedrock:InvokeInlineAgent'];
// Guardrails are not model-scoped — a denied principal could otherwise
// keep racking up Bedrock charges via standalone ApplyGuardrail calls.
// Lives in its own Statement (Resource '*' for guardrail ARNs) below.
const GUARDRAIL_ACTIONS = ['bedrock:ApplyGuardrail'];
// Bedrock Flows (InvokeFlow) are a GA bedrock-agent-runtime path that drives
// billable FM traffic and, like guardrails, are not model-scoped — so a denied
// principal could otherwise keep spending via them. Lives in its own Statement
// (Resource '*' for flow ARNs) below.
const FLOW_ACTIONS = ['bedrock:InvokeFlow'];

const resourcesFor = (target: string, profileArns: string[] = []): string[] => {
  if (target === 'model#*') return ['arn:aws:bedrock:*::foundation-model/*'];
  if (target === 'profile#*') return ['arn:aws:bedrock:*:*:inference-profile/*'];
  if (target.startsWith('model#')) {
    const modelId = target.slice('model#'.length);
    return [`arn:aws:bedrock:*::foundation-model/${modelId}`, ...profileArns];
  }
  if (target.startsWith('profile#')) {
    const profileArn = target.slice('profile#'.length);
    return [profileArn];
  }
  return ['*'];
};

export const buildDenyPolicy = (i: DenyPolicyInputs): DenyPolicyDoc => {
  const resources = resourcesFor(i.target, i.associatedProfileArns);
  // Exactly one condition kind may apply. Guard against ambiguous input —
  // combining them would silently AND the conditions and (almost certainly)
  // never match, producing an inert deny.
  const kinds = [
    i.sessionTagKey && i.sessionTagValue,
    i.ssoUserEmail,
    i.sourceIdentity,
  ].filter(Boolean).length;
  if (kinds > 1) {
    throw new Error(
      'buildDenyPolicy: sessionTag, ssoUserEmail, and sourceIdentity conditions are mutually exclusive',
    );
  }
  const condition = (
    i.sessionTagKey && i.sessionTagValue
      ? {
          StringEquals: {
            [`aws:PrincipalTag/${i.sessionTagKey}`]: i.sessionTagValue,
          },
        }
      : i.ssoUserEmail
        ? {
            // Assumed-role sessions carry aws:userid = '<role-id>:<session-name>';
            // Identity Center sets session-name to the user's email. The wildcard
            // matches any role-id so one document works across re-provisioned roles.
            StringLike: { 'aws:userid': `*:${i.ssoUserEmail}` },
          }
        : i.sourceIdentity
          ? { StringEquals: { 'aws:SourceIdentity': i.sourceIdentity } }
          : undefined
  ) as DenyPolicyDoc['Statement'][number]['Condition'] | undefined;

  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'DenyBedrockInference',
        Effect: 'Deny',
        Action: [...new Set([...FM_ACTIONS, ...PROFILE_ACTIONS, ...KB_ACTIONS])],
        Resource: resources,
        ...(condition ? { Condition: condition } : {}),
      },
      {
        Sid: 'DenyBedrockGuardrails',
        Effect: 'Deny',
        Action: GUARDRAIL_ACTIONS,
        Resource: ['arn:aws:bedrock:*:*:guardrail/*'],
        ...(condition ? { Condition: condition } : {}),
      },
      {
        Sid: 'DenyBedrockFlows',
        Effect: 'Deny',
        Action: FLOW_ACTIONS,
        Resource: ['arn:aws:bedrock:*:*:flow/*'],
        ...(condition ? { Condition: condition } : {}),
      },
      {
        // Agent invocation is authorized against agent-alias ARNs, so it needs
        // its own Resource scope — it won't match the foundation-model /
        // inference-profile ARNs of DenyBedrockInference.
        Sid: 'DenyBedrockAgents',
        Effect: 'Deny',
        Action: AGENT_ACTIONS,
        Resource: ['arn:aws:bedrock:*:*:agent-alias/*'],
        ...(condition ? { Condition: condition } : {}),
      },
    ],
  };
};

/** Stable short hash for a (principal, target, period) tuple. */
export const denyPolicyName = (principal: string, target: string, period: string): string => {
  const hash = createHash('sha1').update(`${principal}|${target}|${period}`).digest('hex').slice(0, 12);
  return `bbg-deny-${hash}-${period}`;
};

/**
 * Parses a canonical principal key back into the IAM API parameters needed
 * to attach a policy. Returns null for principal types not directly
 * attachable (e.g., session-tag-based federated users — those are gated by
 * the deny policy's Condition block, not by attachment).
 */
export interface AttachTarget {
  attachKind: 'user' | 'role';
  name: string;
}

export const principalToAttachTarget = (principal: string): AttachTarget | null => {
  // Strip our `principal#` prefix and any `agent-role#` sub-prefix.
  const inner = principal.replace(/^principal#(agent-role#)?/, '');
  const userMatch = /^arn:aws:iam::\d+:user\/(.+)$/.exec(inner);
  if (userMatch) return { attachKind: 'user', name: lastPathSegment(userMatch[1]) };
  const roleMatch = /^arn:aws:iam::\d+:role\/(.+)$/.exec(inner);
  if (roleMatch) return { attachKind: 'role', name: lastPathSegment(roleMatch[1]) };
  return null;
};

/**
 * IAM Attach/Detach*Policy take a bare RoleName/UserName — which cannot
 * contain `/`. An ARN's resource part may carry a PATH before the name
 * (e.g. SSO reserved roles: `role/aws-reserved/sso.amazonaws.com/us-west-2/
 * AWSReservedSSO_Admin_abc`). Passing the path'd string to AttachRolePolicy
 * fails IAM validation, so extract just the final segment.
 */
const lastPathSegment = (resource: string): string => {
  const idx = resource.lastIndexOf('/');
  return idx === -1 ? resource : resource.slice(idx + 1);
};
