/**
 * in-app documentation manifest.
 *
 * A curated, USER-FACING docs index authored as structured content (not the
 * repo's internal `docs/*.md`, which are operator/runbook material and must
 * not ship in the public SPA). This module is the single source of truth for:
 *   - the Docs landing page (search + cards + rendered guide pages), and
 *   - the in-app HelpPanel content shown from each major page's `info` link.
 *
 * Keep entries short and task-oriented. When you add a user-facing feature,
 * add or update the relevant guide/help entry here — the doc-drift hook
 * (`npm run docs:check`) nudges you when a `web/src/pages` change lands with
 * no matching docs change.
 */

/** A single paragraph or a bulleted list within a guide section. */
export type DocBlock =
  | { kind: 'para'; text: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'steps'; items: string[] };

export interface DocSection {
  heading: string;
  blocks: DocBlock[];
}

export interface DocGuide {
  /** URL slug under /docs/<id>. */
  id: string;
  title: string;
  /** One-line summary shown on the landing cards + used for search. */
  summary: string;
  /** Keywords to broaden search matches beyond title/summary. */
  keywords: string[];
  sections: DocSection[];
}

/**
 * HelpPanel content keyed by page. Rendered in the AppLayout tools drawer when
 * a page's header `info` link is clicked. `learnMoreGuideId` deep-links into
 * the matching full guide.
 */
export interface HelpTopic {
  title: string;
  paragraphs: string[];
  bullets?: string[];
  learnMoreGuideId?: string;
}

export const WHAT_IS_BBG =
  'Bedrock Budget Guard (BBG) meters Amazon Bedrock spend per IAM principal and per model in near real time, and enforces per-principal budgets by attaching customer-managed IAM deny policies when a budget is breached. Everything runs in your own AWS account — spend is derived from CloudTrail, priced against public Bedrock rates (optionally adjusted by a custom pricing discount), and stored in DynamoDB with an S3 ledger for audit.';

export const GUIDES: DocGuide[] = [
  {
    id: 'overview',
    title: 'What is Bedrock Budget Guard?',
    summary: 'How BBG meters spend and enforces budgets, end to end.',
    keywords: ['overview', 'introduction', 'how it works', 'metering', 'enforcement', 'architecture'],
    sections: [
      {
        heading: 'What it does',
        blocks: [
          { kind: 'para', text: WHAT_IS_BBG },
          {
            kind: 'list',
            items: [
              'Meters Bedrock spend per IAM principal × per model, in near real time, across every metered region.',
              'Prices each invocation against public Bedrock rates — optionally scaled by a custom pricing discount (per account, per OU, or org-wide).',
              'Enforces budgets by attaching a customer-managed IAM deny policy (bbg-deny-*) when spend crosses a deny threshold.',
              'Emails the principal (and optionally admins / an ops mailbox) at 50% / 80% / 100% thresholds and on enforcement.',
              'Releases enforcement automatically at the start of the next budget period, or manually from the Budgets page.',
            ],
          },
        ],
      },
      {
        heading: 'The flow',
        blocks: [
          {
            kind: 'steps',
            items: [
              'A principal invokes Bedrock; CloudTrail records the call.',
              'The meter derives spend, prices it, and writes a per-principal × per-model running-spend row.',
              'A budget on that principal/model is evaluated against the new spend.',
              'On a warn threshold, a notification email goes out. On a deny threshold, an IAM deny policy is attached and an enforcement email is sent.',
              'At the next period rollover, the deny is detached and spend resets.',
            ],
          },
        ],
      },
    ],
  },
  {
    id: 'budgets',
    title: 'Creating and managing budgets',
    summary: 'Set per-principal, per-model budgets with alert-only or deny enforcement.',
    keywords: ['budget', 'limit', 'threshold', 'deny', 'alert', 'enforcement', 'release', 'principal'],
    sections: [
      {
        heading: 'Budget basics',
        blocks: [
          {
            kind: 'para',
            text: 'A budget targets a principal (an IAM user/role ARN, or a non-ARN identity such as an SSO user) and a target (a specific model, an inference profile, or all models). It sets a dollar limit for the period, an action (alert-only or deny), and warn thresholds.',
          },
          {
            kind: 'list',
            items: [
              'Alert-only budgets email at thresholds but never block access.',
              'Deny budgets additionally attach an IAM deny policy once spend crosses the block threshold.',
              'Thresholds default to 50% / 80% / 100%; the block threshold is the highest deny threshold.',
            ],
          },
        ],
      },
      {
        heading: 'Releasing enforcement',
        blocks: [
          {
            kind: 'para',
            text: 'When a deny is active, an admin can release it from the Budgets page — this detaches the deny policy immediately. Otherwise enforcement clears automatically at the start of the next budget period.',
          },
        ],
      },
    ],
  },
  {
    id: 'spend',
    title: 'Reading the spend dashboard',
    summary: 'Understand metered spend, enforcement status, and per-identity views.',
    keywords: ['spend', 'dashboard', 'cost', 'metering', 'enforced', 'identity', 'sso', 'account'],
    sections: [
      {
        heading: 'What the numbers mean',
        blocks: [
          {
            kind: 'para',
            text: 'Spend is priced against public Bedrock rates. If a custom pricing discount applies to an account (set directly, or inherited from its OU or the organization), that account’s rows reflect the discounted (effective) cost, not list price.',
          },
          {
            kind: 'list',
            items: [
              'Each row is one principal × one target for the selected period.',
              'An "enforced" row currently has a bbg-deny-* policy attached.',
              'Identity-lens rows (e.g. an SSO user seen through a shared role) mirror the role’s dollars for per-person visibility and are excluded from account totals to avoid double-counting.',
            ],
          },
        ],
      },
    ],
  },
  {
    id: 'pricing-discount',
    title: 'Custom pricing discounts',
    summary: 'Reflect negotiated Bedrock rates (per account, OU, or org) so metered spend matches your effective cost.',
    keywords: ['pricing', 'discount', 'rate', 'negotiated', 'effective cost', 'account', 'ou', 'org', 'organization', 'hierarchy', 'inherit', 'exclusion'],
    sections: [
      {
        heading: 'When to use it',
        blocks: [
          {
            kind: 'para',
            text: 'If your organization has negotiated discounted Amazon Bedrock rates, set a discount percentage so dashboards and budgets reflect effective cost rather than public list price. The metering pipeline scales recorded spend by (1 − pct/100).',
          },
          {
            kind: 'para',
            text: 'Discounts can be set at three scopes, and the most specific one wins: an account-level discount beats an Organizational Unit (OU) discount, which beats an org-wide discount. OU and org discounts are inherited by every account beneath them.',
          },
          {
            kind: 'list',
            items: [
              'Set discounts per account, per OU, or org-wide on the Pricing page (super-admin only); changes are audited.',
              'Most-specific-wins: account > nearest OU (deepest first) > org-wide > list price. No stacking — a single winning rate applies.',
              'OU/org discounts require BBG to be deployed in the AWS Organizations management account; otherwise only per-account discounts apply.',
              'A new OU/org discount takes effect within minutes (resolved on save, and re-checked hourly).',
              'Set an ACCOUNT discount to 0% to explicitly exclude that account from any OU/org discount it would otherwise inherit — it meters at list price. (To instead let it fall back to inheritance, remove the account row entirely.)',
            ],
          },
        ],
      },
    ],
  },
  {
    id: 'notifications',
    title: 'Email notifications',
    summary: 'Who gets emailed at thresholds and on enforcement — and how to configure it.',
    keywords: ['email', 'notification', 'threshold', 'enforcement', 'sso', 'admin watch', 'ops', 'alert'],
    sections: [
      {
        heading: 'Who gets notified',
        blocks: [
          {
            kind: 'list',
            items: [
              'The mapped user: the person whose account maps to the breached principal (by IAM ARN, or by SSO email for identity-lens budgets) gets threshold and enforcement emails.',
              'Admin watchers: admins who opt in receive a copy of every enforcement event.',
              'Ops fallback: when configured by an operator, principals with no mapped person (e.g. service roles) still send their threshold and enforcement emails to an ops mailbox instead of going silent.',
            ],
          },
          {
            kind: 'para',
            text: 'You control your own threshold floor and enforcement opt-in on the My profile page.',
          },
        ],
      },
    ],
  },
  {
    id: 'activity-log',
    title: 'Per-principal activity log',
    summary: 'A durable timeline of what has happened to a principal over time.',
    keywords: ['activity', 'log', 'timeline', 'history', 'audit', 'warning', 'enforcement', 'identity'],
    sections: [
      {
        heading: 'What it records',
        blocks: [
          {
            kind: 'para',
            text: 'A newest-first timeline of the events that matter for a principal. There are three ways in: open a single principal’s activity from the Identities page (Activity action); see your own timeline under My activity; or, as a super-admin, browse every principal on the Activity page.',
          },
          {
            kind: 'list',
            items: [
              'Threshold warnings crossed and enforcement applied / released / rolled over.',
              'Budgets created, updated, deleted, or toggled on the principal.',
              'User lifecycle and metadata changes (created, enabled/disabled, mapping changed).',
              'Unenforceable budgets (a deny that couldn’t be attached) and notification failures.',
            ],
          },
          {
            kind: 'para',
            text: 'This is distinct from the Admin audit log (which answers "which operator changed what"). The activity log answers "what has happened to THIS principal over time".',
          },
        ],
      },
    ],
  },
  {
    id: 'audit-log',
    title: 'Audit log vs. activity log',
    summary: 'Which log answers which question — and why BBG keeps both.',
    keywords: ['audit', 'activity', 'operator', 'compliance', 'history', 'who changed', 'retention'],
    sections: [
      {
        heading: 'Which log do I want?',
        blocks: [
          {
            kind: 'para',
            text: 'BBG keeps two complementary logs. They are not redundant — neither can be derived from the other.',
          },
          {
            kind: 'list',
            items: [
              'Admin audit (Admin audit page) — "which operator changed what", across accounts. Sourced from CloudWatch Logs, so it covers roughly the last 7 days (bounded by a 14-day log-retention ceiling). Super-admin only.',
              'Activity (Activity / My activity pages) — "what happened to a principal over time": threshold warnings, enforcement, and the budget/user changes behind them. A durable 365-day store.',
            ],
          },
          {
            kind: 'para',
            text: 'Events like threshold warnings and enforcement have no operator at all, so they only ever appear in the activity log. Admin-initiated changes appear in both: the audit line records who did it; the activity row records who it happened to.',
          },
        ],
      },
    ],
  },
  {
    id: 'identities',
    title: 'Identities and enrollment',
    summary: 'The principals BBG has seen, and how member accounts are enrolled.',
    keywords: ['identities', 'principal', 'enroll', 'account', 'member', 'sso', 'role', 'arn'],
    sections: [
      {
        heading: 'Identities',
        blocks: [
          {
            kind: 'para',
            text: 'The Identities page lists distinct Bedrock callers the meter has seen (canonicalized from CloudTrail) within a lookback window. Use it to find a principal to budget, or to open its activity timeline.',
          },
        ],
      },
      {
        heading: 'Enrollment',
        blocks: [
          {
            kind: 'para',
            text: 'For multi-account installs, enroll member accounts so BBG can meter and enforce across them. Enrollment deploys the metering-reader and enforcement roles into each member account.',
          },
        ],
      },
    ],
  },
];

/** Per-page HelpPanel content, keyed by a stable page id. */
export const HELP_TOPICS: Record<string, HelpTopic> = {
  spend: {
    title: 'Spend dashboard',
    paragraphs: [
      'Near-real-time Bedrock spend per principal and per model for the selected period, priced against public Bedrock rates (adjusted by any custom pricing discount).',
      'Rows marked enforced currently have an IAM deny policy attached. Identity-lens rows are excluded from account totals to avoid double-counting.',
    ],
    learnMoreGuideId: 'spend',
  },
  budgets: {
    title: 'Budgets',
    paragraphs: [
      'Create per-principal, per-model budgets. Alert-only budgets email at thresholds; deny budgets also attach an IAM deny policy when spend crosses the block threshold.',
      'When a deny is active you can release it here; otherwise it clears automatically at the next period rollover.',
    ],
    bullets: [
      'Target: a specific model, an inference profile, or all models.',
      'Thresholds default to 50% / 80% / 100%.',
    ],
    learnMoreGuideId: 'budgets',
  },
  identities: {
    title: 'Identities',
    paragraphs: [
      'Distinct Bedrock callers the meter has seen (canonicalized from CloudTrail) in the selected window.',
      'Use the row actions to create a budget for a principal or open its activity timeline.',
    ],
    learnMoreGuideId: 'identities',
  },
  enroll: {
    title: 'Enroll accounts',
    paragraphs: [
      'Enroll member accounts so BBG can meter and enforce Bedrock spend across them. Enrollment deploys the metering-reader and enforcement roles into each member account.',
    ],
    learnMoreGuideId: 'identities',
  },
  pricing: {
    title: 'Pricing',
    paragraphs: [
      'Override per-model unit prices, and set custom pricing discounts (per account, per OU, or org-wide) so metered spend reflects negotiated (effective) Bedrock rates rather than public list price.',
      'Most-specific scope wins (account > OU > org). An account set to 0% is explicitly excluded from inherited discounts (list price). OU/org scopes require the Organizations management account. Changes are audited.',
    ],
    learnMoreGuideId: 'pricing-discount',
  },
  activity: {
    title: 'Activity',
    paragraphs: [
      'A durable timeline of what happened to a principal over time — threshold warnings, enforcement applied/released/rolled-over, and the budget/user changes behind them.',
      'This is distinct from the Admin audit log (which answers "which operator changed what", over a 14-day window). "My activity" shows your own timeline; the admin "Activity" feed shows every principal (super-admin only).',
    ],
    learnMoreGuideId: 'activity-log',
  },
};
