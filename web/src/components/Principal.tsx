import Badge from '@cloudscape-design/components/badge';
import SpaceBetween from '@cloudscape-design/components/space-between';

export interface ParsedPrincipal {
  display: string;
  full: string;
  type: 'IAMUser' | 'IAMRole' | 'SSO' | 'AgentService' | 'Federated' | 'Unknown';
}

const TYPE_BADGE_COLOR: Record<ParsedPrincipal['type'], 'blue' | 'green' | 'red' | 'grey' | 'severity-high' | 'severity-medium'> = {
  IAMUser: 'blue',
  IAMRole: 'green',
  SSO: 'severity-medium',
  AgentService: 'severity-high',
  Federated: 'red',
  Unknown: 'grey',
};

/**
 * Parses a canonical `principal#...` key into a friendly display name plus
 * its type. Mirrors lambda/src/shared/arn.ts canonicalize() output.
 */
export const parsePrincipal = (principal: string): ParsedPrincipal => {
  const stripped = principal.replace(/^principal#/, '');

  if (stripped.startsWith('agent-role#')) {
    const arn = stripped.replace(/^agent-role#/, '');
    const tail = arn.split('/').slice(-1)[0] ?? arn;
    return { display: tail, full: arn, type: 'AgentService' };
  }

  if (stripped.startsWith('sso-user#')) {
    const email = stripped.replace(/^sso-user#/, '');
    return { display: email, full: email, type: 'SSO' };
  }

  // identity-lens key: sts:SourceIdentity value.
  if (stripped.startsWith('sourceIdentity#')) {
    const value = stripped.replace(/^sourceIdentity#/, '');
    return { display: value, full: stripped, type: 'Federated' };
  }

  if (stripped.startsWith('sessionTag/')) {
    const value = stripped.replace(/^sessionTag\/[^=]+=/, '');
    return { display: value, full: stripped, type: 'Federated' };
  }

  // arn:aws:iam::ACCT:user/<name>
  const userMatch = /^arn:aws:iam::\d+:user\/(.+)$/.exec(stripped);
  if (userMatch) return { display: userMatch[1], full: stripped, type: 'IAMUser' };

  // SSO reserved role
  if (stripped.includes('/aws-reserved/sso.amazonaws.com/')) {
    const tail = stripped.split('/').slice(-1)[0];
    return { display: tail, full: stripped, type: 'SSO' };
  }

  // arn:aws:iam::ACCT:role/<name>
  const roleMatch = /^arn:aws:iam::\d+:role\/(.+)$/.exec(stripped);
  if (roleMatch) return { display: roleMatch[1], full: stripped, type: 'IAMRole' };

  return { display: stripped, full: stripped, type: 'Unknown' };
};

/**
 * Cloudscape Badge + name display for a principal.
 */
export const PrincipalCell = ({ principal, principalType }: { principal: string; principalType?: string }) => {
  const parsed = parsePrincipal(principal);
  const type = (principalType as ParsedPrincipal['type']) ?? parsed.type;
  return (
    <SpaceBetween size="xs" direction="horizontal">
      <Badge color={TYPE_BADGE_COLOR[type] ?? 'grey'}>{type}</Badge>
      <span title={parsed.full} style={{ fontFamily: 'monospace' }}>
        {parsed.display}
      </span>
    </SpaceBetween>
  );
};
