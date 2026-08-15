import Badge from '@cloudscape-design/components/badge';
import SpaceBetween from '@cloudscape-design/components/space-between';
import { canonicalProvider } from './providerName';

/**
 * Parses a `model#<id>` or `profile#<arn>` target into a short display name.
 */
export const parseTarget = (target: string): { display: string; kind: 'model' | 'profile' | 'unknown' } => {
  if (target === 'model#*') return { display: 'all models', kind: 'model' };
  if (target === 'profile#*') return { display: 'all inference profiles', kind: 'profile' };
  if (target.startsWith('model#')) return { display: target.slice('model#'.length), kind: 'model' };
  if (target.startsWith('profile#')) {
    const tail = target.slice('profile#'.length).split('/').slice(-1)[0];
    return { display: tail, kind: 'profile' };
  }
  return { display: target, kind: 'unknown' };
};

/**
 * Drops the regional CRIS prefix and provider segment from a Bedrock model
 * id for compact UI display.
 *   anthropic.claude-sonnet-4-6 → "Claude Sonnet 4.6"
 *   us.anthropic.claude-haiku-4-5-20251001-v1:0 → "Claude Haiku 4.5"
 */
export const friendlyModelName = (modelId: string): string => {
  const stripped = modelId.replace(/^(us|eu|apac|ap|global)\./, '');
  const segments = stripped.split('.');
  const provider = segments[0] ?? '';
  const rest = segments.slice(1).join('.');
  const tail = rest
    .replace(/-(?:\d{8})-v\d+:\d+$/, '') // -20251001-v1:0
    .replace(/-v\d+:\d+$/, '') // -v1:0
    .split('-')
    .map((p) => (p.length <= 2 ? p : p.charAt(0).toUpperCase() + p.slice(1)))
    .join(' ');
  if (!tail) return modelId;
  // Anthropic/Amazon are the house models — drop the vendor prefix for a
  // cleaner label ("Claude Sonnet 4.6", "Nova 2 Lite"). For everyone else,
  // prefix the canonical vendor name so it reads "OpenAI Gpt Oss 120B", not
  // the ad-hoc title-cased "Openai …".
  if (provider === 'anthropic' || provider === 'amazon') return tail;
  return `${canonicalProvider(undefined, stripped)} ${tail}`;
};

export const ModelCell = ({ target }: { target: string }) => {
  const t = parseTarget(target);
  if (t.kind === 'model') {
    return (
      <SpaceBetween size="xs" direction="horizontal">
        <Badge>model</Badge>
        <span title={target}>{friendlyModelName(t.display)}</span>
      </SpaceBetween>
    );
  }
  return (
    <SpaceBetween size="xs" direction="horizontal">
      <Badge color="green">profile</Badge>
      <span title={target}>{t.display}</span>
    </SpaceBetween>
  );
};
