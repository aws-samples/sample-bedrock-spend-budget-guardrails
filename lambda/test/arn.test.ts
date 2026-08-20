import { describe, expect, it } from 'vitest';
import { canonicalize, canonicalizeCurPrincipal, routingModeOf, stripCrisPrefix } from '../src/shared/arn';

describe('canonicalize CloudTrail userIdentity', () => {
  it('handles IAMUser', () => {
    const r = canonicalize({
      type: 'IAMUser',
      arn: 'arn:aws:iam::123456789012:user/alice',
      principalId: 'AIDAEXAMPLE',
      userName: 'alice',
      accountId: '123456789012',
    });
    expect(r.principalType).toBe('IAMUser');
    expect(r.principal).toBe('principal#arn:aws:iam::123456789012:user/alice');
  });

  it('canonicalizes AssumedRole via sessionIssuer.arn', () => {
    const r = canonicalize({
      type: 'AssumedRole',
      arn: 'arn:aws:sts::123456789012:assumed-role/Dev/alice-session',
      principalId: 'AROAEXAMPLE:alice-session',
      sessionContext: {
        sessionIssuer: {
          type: 'Role',
          arn: 'arn:aws:iam::123456789012:role/Dev',
          userName: 'Dev',
        },
      },
    });
    expect(r.principalType).toBe('IAMRole');
    expect(r.principal).toBe('principal#arn:aws:iam::123456789012:role/Dev');
  });

  it('detects SSO permission set roles via aws-reserved/sso.amazonaws.com', () => {
    const r = canonicalize({
      type: 'AssumedRole',
      arn: 'arn:aws:sts::123456789012:assumed-role/AWSReservedSSO_Admin_abc/alice@example.com',
      principalId: 'AROAEXAMPLE:alice@example.com',
      sessionContext: {
        sessionIssuer: {
          type: 'Role',
          arn: 'arn:aws:iam::123456789012:role/aws-reserved/sso.amazonaws.com/us-west-2/AWSReservedSSO_Admin_abc',
          userName: 'AWSReservedSSO_Admin_abc',
        },
      },
    });
    expect(r.principalType).toBe('SSO');
    expect(r.principal).toBe(
      'principal#arn:aws:iam::123456789012:role/aws-reserved/sso.amazonaws.com/us-west-2/AWSReservedSSO_Admin_abc',
    );
    expect(r.ssoUser).toBe('alice@example.com');
  });

  it('recognizes Bedrock Agents (AWSService invokedBy)', () => {
    const r = canonicalize({
      type: 'AWSService',
      invokedBy: 'bedrock.amazonaws.com',
      sessionContext: {
        sessionIssuer: {
          type: 'Role',
          arn: 'arn:aws:iam::123456789012:role/AmazonBedrockExecutionRoleForAgents_abc',
        },
      },
    });
    expect(r.principalType).toBe('AgentService');
    expect(r.principal).toContain('agent-role#');
  });

  it('captures sourceIdentity (sts:SetSourceIdentity)', () => {
    const r = canonicalize({
      type: 'AssumedRole',
      arn: 'arn:aws:sts::123456789012:assumed-role/GatewayInvoke/end-user',
      sessionContext: {
        sessionIssuer: { arn: 'arn:aws:iam::123456789012:role/GatewayInvoke' },
        sourceIdentity: 'alice@example.com',
      },
    });
    expect(r.sourceIdentity).toBe('alice@example.com');
  });

  it('falls back to Unknown for missing identity', () => {
    expect(canonicalize(undefined).principalType).toBe('Unknown');
  });
});

describe('canonicalizeCurPrincipal', () => {
  it.each([
    [
      'arn:aws:sts::123456789012:assumed-role/AdminRole/alice-session',
      'arn:aws:iam::123456789012:role/AdminRole',
    ],
    [
      'arn:aws:sts::123456789012:assumed-role/aws-pricing-assistant-prod-ecs-task-role/f2eecae31a0a4d3ebc75b02cc8dec80a',
      'arn:aws:iam::123456789012:role/aws-pricing-assistant-prod-ecs-task-role',
    ],
    [
      'arn:aws:sts::123:assumed-role/AWSReservedSSO_Admin_abc/alice@example.com',
      'arn:aws:iam::123:role/aws-reserved/sso.amazonaws.com/AWSReservedSSO_Admin_abc',
    ],
  ])('canonicalizes assumed-role %s', (input, expected) => {
    expect(canonicalizeCurPrincipal(input)).toBe(expected);
  });

  it.each([
    'arn:aws:iam::123:user/alice',
    'arn:aws:iam::123:role/Dev',
    'principal#agent-role#arn:aws:iam::123:role/AgentRole',
    'arn:aws:iam::123:federated-user/alice@example.com',
  ])('passes through non-assumed-role ARN %s', (input) => {
    expect(canonicalizeCurPrincipal(input)).toBe(input);
  });

  it('aggregates multiple sessions of the same role to one canonical key', () => {
    const sessions = [
      'arn:aws:sts::1:assumed-role/MyRole/sess-1',
      'arn:aws:sts::1:assumed-role/MyRole/sess-2',
      'arn:aws:sts::1:assumed-role/MyRole/sess-3',
    ];
    const canonical = sessions.map(canonicalizeCurPrincipal);
    expect(new Set(canonical).size).toBe(1);
    expect(canonical[0]).toBe('arn:aws:iam::1:role/MyRole');
  });
});

describe('stripCrisPrefix', () => {
  it.each([
    ['us.anthropic.claude-sonnet-4-6', 'anthropic.claude-sonnet-4-6'],
    ['eu.anthropic.claude-haiku-4-5', 'anthropic.claude-haiku-4-5'],
    ['apac.anthropic.claude-opus-4-7', 'anthropic.claude-opus-4-7'],
    ['ap.anthropic.claude-sonnet-4-5', 'anthropic.claude-sonnet-4-5'],
    ['global.anthropic.claude-opus-4-7', 'anthropic.claude-opus-4-7'],
    ['anthropic.claude-sonnet-4-6', 'anthropic.claude-sonnet-4-6'],
  ])('%s → %s', (input, expected) => {
    expect(stripCrisPrefix(input)).toBe(expected);
  });
});

describe('routingModeOf', () => {
  it.each([
    ['global.anthropic.claude-opus-5', 'global'],
    ['global.openai.gpt-5.6-sol', 'global'],
    ['us.anthropic.claude-fable-5', 'us'],
    ['eu.anthropic.claude-haiku-4-5', 'eu'],
    ['apac.anthropic.claude-opus-4-7', 'apac'],
  ])('%s → %s', (input, expected) => {
    expect(routingModeOf(input)).toBe(expected);
  });

  it('returns undefined for bare model ids', () => {
    expect(routingModeOf('anthropic.claude-opus-5')).toBeUndefined();
    expect(routingModeOf('openai.gpt-5.6-sol')).toBeUndefined();
  });

  it('does not misread a provider segment as a routing prefix', () => {
    // "usual.model" style ids must not match — the prefix set is closed.
    expect(routingModeOf('usual.model-v1')).toBeUndefined();
    expect(routingModeOf('mistral.mistral-large-2402-v1:0')).toBeUndefined();
  });
});
