import { useMemo, useState } from 'react';
import type { NonCancelableCustomEvent } from '@cloudscape-design/components';
import { useNavigate, useParams } from 'react-router';
import Box from '@cloudscape-design/components/box';
import Cards from '@cloudscape-design/components/cards';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import Link from '@cloudscape-design/components/link';
import SpaceBetween from '@cloudscape-design/components/space-between';
import TextContent from '@cloudscape-design/components/text-content';
import TextFilter from '@cloudscape-design/components/text-filter';
import { GUIDES, WHAT_IS_BBG, type DocBlock, type DocGuide } from '../docs/manifest';

/** Renders one structured content block with Cloudscape-native typography. */
const Block = ({ block }: { block: DocBlock }) => {
  if (block.kind === 'para') {
    return (
      <TextContent>
        <p>{block.text}</p>
      </TextContent>
    );
  }
  if (block.kind === 'steps') {
    return (
      <TextContent>
        <ol>
          {block.items.map((it, i) => (
            <li key={i}>{it}</li>
          ))}
        </ol>
      </TextContent>
    );
  }
  return (
    <TextContent>
      <ul>
        {block.items.map((it, i) => (
          <li key={i}>{it}</li>
        ))}
      </ul>
    </TextContent>
  );
};

/** Full guide page at /docs/:guideId. */
const GuideView = ({ guide }: { guide: DocGuide }) => {
  const navigate = useNavigate();
  return (
    <ContentLayout
      header={
        <Header variant="h1" description={guide.summary}>
          {guide.title}
        </Header>
      }
    >
      <SpaceBetween size="l">
        <Box>
          <Link onFollow={() => navigate('/docs')}>← All documentation</Link>
        </Box>
        {guide.sections.map((section, si) => (
          <Container key={si} header={<Header variant="h2">{section.heading}</Header>}>
            <SpaceBetween size="s">
              {section.blocks.map((block, bi) => (
                <Block key={bi} block={block} />
              ))}
            </SpaceBetween>
          </Container>
        ))}
      </SpaceBetween>
    </ContentLayout>
  );
};

/** Landing page: hero + search over the guide index + cards. */
const DocsLanding = () => {
  const navigate = useNavigate();
  const [filter, setFilter] = useState('');

  const matches = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return GUIDES;
    return GUIDES.filter((g) => {
      const hay = [g.title, g.summary, ...g.keywords].join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [filter]);

  return (
    <ContentLayout
      header={
        <Header variant="h1" description="Guides for using Bedrock Budget Guard.">
          Documentation
        </Header>
      }
    >
      <SpaceBetween size="l">
        <Container header={<Header variant="h2">What is Bedrock Budget Guard?</Header>}>
          <TextContent>
            <p>{WHAT_IS_BBG}</p>
          </TextContent>
        </Container>

        <TextFilter
          filteringText={filter}
          filteringPlaceholder="Search documentation"
          filteringAriaLabel="Search documentation"
          onChange={(e: NonCancelableCustomEvent<{ filteringText: string }>) => setFilter(e.detail.filteringText)}
          countText={
            filter.trim()
              ? `${matches.length} match${matches.length === 1 ? '' : 'es'}`
              : ''
          }
        />

        <Cards
          items={matches}
          cardDefinition={{
            header: (g) => (
              <Link fontSize="heading-m" onFollow={() => navigate(`/docs/${g.id}`)}>
                {g.title}
              </Link>
            ),
            sections: [{ id: 'summary', content: (g) => g.summary }],
          }}
          cardsPerRow={[{ cards: 1 }, { minWidth: 640, cards: 2 }]}
          trackBy="id"
          empty={
            <Box textAlign="center" color="inherit">
              No guides match “{filter}”.
            </Box>
          }
        />
      </SpaceBetween>
    </ContentLayout>
  );
};

/**
 * in-app documentation. `/docs` shows the searchable landing page;
 * `/docs/:guideId` renders a single guide. Content comes from the curated
 * docs manifest (web/src/docs/manifest.ts), rendered natively in Cloudscape.
 */
export const Docs = () => {
  const { guideId } = useParams();
  const guide = guideId ? GUIDES.find((g) => g.id === guideId) : undefined;
  if (guideId && !guide) {
    // Unknown slug — fall back to the landing page rather than a blank screen.
    return <DocsLanding />;
  }
  return guide ? <GuideView guide={guide} /> : <DocsLanding />;
};
