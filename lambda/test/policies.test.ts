import { describe, expect, it } from 'vitest';
import { buildDenyPolicy, denyPolicyName, principalToAttachTarget } from '../src/shared/policies';

describe('deny policy builder', () => {
  it('targets the foundation-model ARN for a model# target', () => {
    const p = buildDenyPolicy({ target: 'model#anthropic.claude-sonnet-4-6' });
    expect(p.Statement[0].Resource).toContain(
      'arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6',
    );
  });

  it('includes any associated inference profile ARNs', () => {
    const profileArn = 'arn:aws:bedrock:us-east-1:123:inference-profile/us.anthropic.claude-sonnet-4-6';
    const p = buildDenyPolicy({
      target: 'model#anthropic.claude-sonnet-4-6',
      associatedProfileArns: [profileArn],
    });
    expect(p.Statement[0].Resource).toContain(profileArn);
  });

  it('targets the inference profile ARN for a profile# target', () => {
    const profileArn = 'arn:aws:bedrock:us-east-1:123:inference-profile/us.anthropic.claude-sonnet-4-6';
    const p = buildDenyPolicy({ target: `profile#${profileArn}` });
    expect(p.Statement[0].Resource).toEqual([profileArn]);
  });

  it('targets all foundation models for the wildcard model# target', () => {
    const p = buildDenyPolicy({ target: 'model#*' });
    expect(p.Statement[0].Resource).toEqual(['arn:aws:bedrock:*::foundation-model/*']);
  });

  it('attaches a session-tag Condition when keyed on a session tag', () => {
    const p = buildDenyPolicy({
      target: 'model#anthropic.claude-sonnet-4-6',
      sessionTagKey: 'principal',
      sessionTagValue: 'alice@example.com',
    });
    expect(p.Statement[0].Condition).toEqual({
      StringEquals: { 'aws:PrincipalTag/principal': 'alice@example.com' },
    });
  });

  it('denies agent invocation (InvokeAgent + InvokeInlineAgent) in its own agent-alias-scoped Statement', () => {
    const p = buildDenyPolicy({ target: 'model#anthropic.claude-sonnet-4-6' });
    const agentStmt = p.Statement.find((s) => s.Sid === 'DenyBedrockAgents');
    expect(agentStmt).toBeDefined();
    expect(agentStmt!.Effect).toBe('Deny');
    // IAM service prefix is `bedrock:` — NOT `bedrock-agent-runtime:` (that is the
    // API namespace and matches no IAM action, which would make the deny inert).
    expect(agentStmt!.Action).toEqual(['bedrock:InvokeAgent', 'bedrock:InvokeInlineAgent']);
    // Agent actions authorize against agent-alias ARNs, so they must NOT sit in
    // the foundation-model-scoped inference statement (a Deny only bites when the
    // resource matches).
    expect(agentStmt!.Resource).toEqual(['arn:aws:bedrock:*:*:agent-alias/*']);
    const inference = p.Statement.find((s) => s.Sid === 'DenyBedrockInference');
    expect(inference!.Action).not.toContain('bedrock:InvokeAgent');
  });

  it('emits a DenyBedrockFlows Statement that denies bedrock:InvokeFlow across all flow ARNs', () => {
    const p = buildDenyPolicy({ target: 'model#anthropic.claude-sonnet-4-6' });
    const flowStmt = p.Statement.find((s) => s.Sid === 'DenyBedrockFlows');
    expect(flowStmt).toBeDefined();
    expect(flowStmt!.Action).toEqual(['bedrock:InvokeFlow']);
    expect(flowStmt!.Resource).toEqual(['arn:aws:bedrock:*:*:flow/*']);
  });

  it('propagates the session-tag Condition onto the agent + flow Statements too', () => {
    const p = buildDenyPolicy({
      target: 'model#anthropic.claude-sonnet-4-6',
      sessionTagKey: 'principal',
      sessionTagValue: 'alice@example.com',
    });
    for (const sid of ['DenyBedrockAgents', 'DenyBedrockFlows']) {
      const stmt = p.Statement.find((s) => s.Sid === sid);
      expect(stmt!.Condition).toEqual({
        StringEquals: { 'aws:PrincipalTag/principal': 'alice@example.com' },
      });
    }
  });

  // an earlier change B5 — close the ApplyGuardrail bypass + cover RetrieveAndGenerateStream.
  it('includes bedrock:RetrieveAndGenerateStream so KB streaming retrieve is denied', () => {
    const p = buildDenyPolicy({ target: 'model#anthropic.claude-sonnet-4-6' });
    expect(p.Statement[0].Action).toContain('bedrock:RetrieveAndGenerateStream');
  });

  // POL-1 (B2) — deny async / batch / bidirectional invocation paths so an
  // over-budget principal can't keep spending through them once denied.
  it('includes async/batch/bidirectional invocation actions in the inference deny statement', () => {
    const p = buildDenyPolicy({ target: 'model#anthropic.claude-sonnet-4-6' });
    expect(p.Statement[0].Action).toContain('bedrock:StartAsyncInvoke');
    expect(p.Statement[0].Action).toContain('bedrock:CreateModelInvocationJob');
    expect(p.Statement[0].Action).toContain('bedrock:InvokeModelWithBidirectionalStream');
  });

  it('emits a DenyBedrockGuardrails Statement that denies bedrock:ApplyGuardrail across all guardrail ARNs', () => {
    const p = buildDenyPolicy({ target: 'model#anthropic.claude-sonnet-4-6' });
    const guardStmt = p.Statement.find((s) => s.Sid === 'DenyBedrockGuardrails');
    expect(guardStmt).toBeDefined();
    expect(guardStmt!.Effect).toBe('Deny');
    expect(guardStmt!.Action).toEqual(['bedrock:ApplyGuardrail']);
    expect(guardStmt!.Resource).toEqual(['arn:aws:bedrock:*:*:guardrail/*']);
  });

  it('propagates the session-tag Condition onto the guardrails Statement too', () => {
    const p = buildDenyPolicy({
      target: 'model#anthropic.claude-sonnet-4-6',
      sessionTagKey: 'principal',
      sessionTagValue: 'alice@example.com',
    });
    const guardStmt = p.Statement.find((s) => s.Sid === 'DenyBedrockGuardrails');
    expect(guardStmt!.Condition).toEqual({
      StringEquals: { 'aws:PrincipalTag/principal': 'alice@example.com' },
    });
  });
});

describe('denyPolicyName', () => {
  it('is deterministic for a given (principal, target, period)', () => {
    const a = denyPolicyName('principal#arn:aws:iam::123:user/alice', 'model#x', '2026-05');
    const b = denyPolicyName('principal#arn:aws:iam::123:user/alice', 'model#x', '2026-05');
    expect(a).toBe(b);
    expect(a).toMatch(/^bbg-deny-[0-9a-f]{12}-2026-05$/);
  });

  it('differs across distinct inputs', () => {
    const a = denyPolicyName('p1', 't1', '2026-05');
    const b = denyPolicyName('p1', 't2', '2026-05');
    expect(a).not.toBe(b);
  });
});

describe('principalToAttachTarget', () => {
  it('parses IAM users', () => {
    expect(
      principalToAttachTarget('principal#arn:aws:iam::123456789012:user/alice'),
    ).toEqual({ attachKind: 'user', name: 'alice' });
  });

  it('parses IAM roles (including SSO reserved roles with paths)', () => {
    // IAM Attach/DetachRolePolicy take a bare RoleName (no slashes) — the
    // ARN's path (`aws-reserved/sso.amazonaws.com/<region>/`) must be
    // stripped or the IAM call fails validation. The previous expectation
    // (full path'd string) encoded that latent runtime failure.
    expect(
      principalToAttachTarget(
        'principal#arn:aws:iam::123456789012:role/aws-reserved/sso.amazonaws.com/us-west-2/AWSReservedSSO_Admin_abc',
      ),
    ).toEqual({
      attachKind: 'role',
      name: 'AWSReservedSSO_Admin_abc',
    });
  });

  it('parses Bedrock Agent service roles', () => {
    expect(
      principalToAttachTarget(
        'principal#agent-role#arn:aws:iam::123456789012:role/AmazonBedrockExecutionRoleForAgents_abc',
      ),
    ).toEqual({ attachKind: 'role', name: 'AmazonBedrockExecutionRoleForAgents_abc' });
  });

  it('returns null for session-tag-based federated principals', () => {
    expect(
      principalToAttachTarget('principal#sessionTag/principal=alice@example.com'),
    ).toBeNull();
  });
});

describe('identity-lens deny conditions', () => {
  it('emits an aws:userid StringLike condition for sso-user budgets, on every statement', () => {
    const p = buildDenyPolicy({
      target: 'model#anthropic.claude-sonnet-4-6',
      ssoUserEmail: 'alice@example.com',
    });
    for (const stmt of p.Statement) {
      expect(stmt.Condition).toEqual({
        StringLike: { 'aws:userid': '*:alice@example.com' },
      });
    }
  });

  it('emits an aws:SourceIdentity StringEquals condition for sourceIdentity budgets, on every statement', () => {
    const p = buildDenyPolicy({
      target: 'model#anthropic.claude-sonnet-4-6',
      sourceIdentity: 'alice@example.com',
    });
    for (const stmt of p.Statement) {
      expect(stmt.Condition).toEqual({
        StringEquals: { 'aws:SourceIdentity': 'alice@example.com' },
      });
    }
  });

  it('rejects ambiguous combinations of condition kinds', () => {
    expect(() =>
      buildDenyPolicy({
        target: 'model#anthropic.claude-sonnet-4-6',
        ssoUserEmail: 'alice@example.com',
        sourceIdentity: 'alice@example.com',
      }),
    ).toThrow(/mutually exclusive/);
    expect(() =>
      buildDenyPolicy({
        target: 'model#anthropic.claude-sonnet-4-6',
        sessionTagKey: 'principal',
        sessionTagValue: 'x',
        ssoUserEmail: 'alice@example.com',
      }),
    ).toThrow(/mutually exclusive/);
  });
});
