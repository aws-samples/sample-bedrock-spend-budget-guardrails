import { Suspense, lazy, useEffect, useState } from 'react';
import type { NonCancelableCustomEvent } from '@cloudscape-design/components';
import { BrowserRouter, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router';
import AppLayout from '@cloudscape-design/components/app-layout';
import HelpPanel from '@cloudscape-design/components/help-panel';
import SideNavigation from '@cloudscape-design/components/side-navigation';
import TopNavigation, { type TopNavigationProps } from '@cloudscape-design/components/top-navigation';
import Flashbar, { type FlashbarProps } from '@cloudscape-design/components/flashbar';
import Link from '@cloudscape-design/components/link';
import Spinner from '@cloudscape-design/components/spinner';
import Box from '@cloudscape-design/components/box';
import { fetchAuthSession } from 'aws-amplify/auth';
import { useTheme } from './theme/ThemeProvider';
import { AuthGate, displayNameFromPayload } from './auth/AuthGate';
import { ScopeContext, formatAccount } from './auth/scope-context';
import { api } from './api/client';
import { HELP_TOPICS, type HelpTopic } from './docs/manifest';
import type { BbgConfig } from './config';

const BudgetsAdminShell = lazy(() =>
  import('./pages/BudgetsAdminShell').then((m) => ({ default: m.BudgetsAdminShell })),
);
const AdminUsers = lazy(() => import('./pages/AdminUsers').then((m) => ({ default: m.AdminUsers })));
const SpendDashboard = lazy(() => import('./pages/SpendDashboard').then((m) => ({ default: m.SpendDashboard })));
const Reports = lazy(() => import('./pages/Reports').then((m) => ({ default: m.Reports })));
const Identities = lazy(() => import('./pages/Identities').then((m) => ({ default: m.Identities })));
const Readiness = lazy(() => import('./pages/Readiness').then((m) => ({ default: m.Readiness })));
const InferenceProfiles = lazy(() =>
  import('./pages/InferenceProfiles').then((m) => ({ default: m.InferenceProfiles })),
);
const AgentSessions = lazy(() => import('./pages/AgentSessions').then((m) => ({ default: m.AgentSessions })));
const PricingOverrides = lazy(() =>
  import('./pages/PricingOverrides').then((m) => ({ default: m.PricingOverrides })),
);
const MyBudget = lazy(() => import('./pages/MyBudget').then((m) => ({ default: m.MyBudget })));
const Profile = lazy(() => import('./pages/Profile').then((m) => ({ default: m.Profile })));
const Enrollment = lazy(() => import('./pages/Enrollment').then((m) => ({ default: m.Enrollment })));
const AuditLog = lazy(() => import('./pages/AuditLog').then((m) => ({ default: m.AuditLog })));
const Docs = lazy(() => import('./pages/Docs').then((m) => ({ default: m.Docs })));
const MyActivity = lazy(() => import('./pages/MyActivity').then((m) => ({ default: m.MyActivity })));
const AdminActivity = lazy(() => import('./pages/AdminActivity').then((m) => ({ default: m.AdminActivity })));

const PageFallback = () => (
  <Box textAlign="center" padding="xxl">
    <Spinner size="large" />
  </Box>
);

interface AppProps {
  config: BbgConfig;
}

// nav items keyed by which scope tier sees them.
//   "any" — any admin (per-account or wildcard)
//   "wildcard" — super-admin only (server-side endpoints are
//                wildcard-gated, so per-account admins clicking these
//                links would hit a 403 banner)
type NavTier = 'any' | 'wildcard';
interface NavItem {
  type: 'link';
  text: string;
  href: string;
  tier: NavTier;
}
type NavSection = NavItem | { type: 'divider' };

const adminNavAll: NavSection[] = [
  { type: 'link', text: 'Spend', href: '/spend', tier: 'any' },
  { type: 'link', text: 'Budgets', href: '/budgets', tier: 'any' },
  { type: 'link', text: 'Readiness', href: '/readiness', tier: 'any' },
  { type: 'link', text: 'Identities', href: '/identities', tier: 'any' },
  { type: 'link', text: 'Inference profiles', href: '/inference-profiles', tier: 'any' },
  { type: 'link', text: 'Agent sessions', href: '/agent-sessions', tier: 'any' },
  { type: 'link', text: 'Pricing', href: '/pricing-overrides', tier: 'wildcard' },
  { type: 'divider' },
  { type: 'link', text: 'Users', href: '/admin/users', tier: 'wildcard' },
  { type: 'link', text: 'Enroll accounts', href: '/admin/enroll', tier: 'wildcard' },
  { type: 'link', text: 'Reports', href: '/reports', tier: 'wildcard' },
  { type: 'link', text: 'Admin audit', href: '/admin/audit', tier: 'wildcard' },
  { type: 'link', text: 'Activity', href: '/admin/activity', tier: 'wildcard' },
  { type: 'divider' },
  { type: 'link', text: 'My spend', href: '/me/spend', tier: 'any' },
  { type: 'link', text: 'My budget', href: '/me/budget', tier: 'any' },
  { type: 'link', text: 'My activity', href: '/me/activity', tier: 'any' },
  { type: 'link', text: 'My profile', href: '/me/profile', tier: 'any' },
  { type: 'divider' },
  { type: 'link', text: 'Documentation', href: '/docs', tier: 'any' },
];

const filterAdminNav = (isWildcard: boolean) =>
  adminNavAll.filter((item) =>
    item.type === 'link' ? item.tier === 'any' || isWildcard : true,
  );

const userNav = [
  { type: 'link' as const, text: 'My spend', href: '/me/spend' },
  { type: 'link' as const, text: 'My budget', href: '/me/budget' },
  { type: 'link' as const, text: 'My activity', href: '/me/activity' },
  { type: 'link' as const, text: 'My profile', href: '/me/profile' },
  { type: 'divider' as const },
  { type: 'link' as const, text: 'Documentation', href: '/docs' },
];

/**
 * map the current route to a HelpPanel topic (keys in HELP_TOPICS).
 * Pages listed here get an `info` link in the AppLayout that opens the tools
 * drawer; other routes have no help topic and the drawer stays hidden.
 */
const helpTopicForPath = (pathname: string): HelpTopic | undefined => {
  if (pathname === '/' || pathname.startsWith('/spend')) return HELP_TOPICS.spend;
  if (pathname.startsWith('/budgets')) return HELP_TOPICS.budgets;
  if (pathname.startsWith('/identities')) return HELP_TOPICS.identities;
  if (pathname.startsWith('/admin/enroll')) return HELP_TOPICS.enroll;
  if (pathname.startsWith('/pricing-overrides')) return HELP_TOPICS.pricing;
  if (pathname.startsWith('/admin/activity') || pathname.startsWith('/me/activity'))
    return HELP_TOPICS.activity;
  return undefined;
};

/**
 * parses the Cognito `bbg:scope` custom claim emitted by the
 * pre-token-gen V2 trigger. The claim is a JSON-encoded array of
 * 12-digit account IDs the user can administer, or `["*"]` for super-
 * admins (BBG-Admin-Wildcard / legacy Admins group).
 */
const parseScope = (raw: unknown): string[] => {
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as string[]).filter((s) => typeof s === 'string') : [];
  } catch {
    return [];
  }
};

export interface AuthScope {
  /** Account IDs the user can administer, or `['*']` for super-admin. */
  scopes: string[];
  /** True when scopes is non-empty (per-account admin or wildcard). */
  isAdmin: boolean;
  /** True when scopes contains '*'. */
  isWildcard: boolean;
  /** Currently-selected admin account from the top-nav selector. `'*'`
   *  for super-admins viewing aggregate; a 12-digit account ID
   *  otherwise. End users (isAdmin=false) get an empty string. */
  currentAccount: string;
  setCurrentAccount: (id: string) => void;
  /** follow-up: friendly account names from
   *  `organizations:DescribeAccount`. Only populated for wildcard
   *  admins (per-account admins can't call /admin/org/accounts).
   *  Map is empty until the lookup completes. */
  accountNames: Record<string, string>;
}

const STORAGE_KEY = 'bbg.currentAccount';

const useAuthScope = (config: BbgConfig): AuthScope | undefined => {
  const [scopes, setScopes] = useState<string[] | undefined>(undefined);
  const [currentAccount, setCurrentAccountState] = useState<string>('');
  const [accountNames, setAccountNames] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const session = await fetchAuthSession();
        const claims = session.tokens?.idToken?.payload ?? {};
        const fromBbg = parseScope(claims['bbg:scope']);
        // Compat fallback: if the pre-token-gen trigger hasn't deployed
        // yet (or the user signed in before that day), fall back to
        // legacy `cognito:groups` Admins membership = wildcard.
        let resolved = fromBbg;
        if (resolved.length === 0) {
          const groupsClaim = claims['cognito:groups'];
          const groups = Array.isArray(groupsClaim)
            ? (groupsClaim as string[])
            : typeof groupsClaim === 'string'
            ? [groupsClaim]
            : [];
          if (groups.includes('Admins') || groups.includes('BBG-Admin-Wildcard')) {
            resolved = ['*'];
          }
        }
        if (cancelled) return;
        setScopes(resolved);
        // Restore prior selection when valid; otherwise default to the
        // first scope ('*' for wildcards, the only ID for single-account
        // admins).
        const stored = window.localStorage.getItem(STORAGE_KEY) ?? '';
        const valid = stored && (resolved.includes('*') || resolved.includes(stored));
        const initial = valid ? stored : resolved[0] ?? '';
        setCurrentAccountState(initial);

        // follow-up: hydrate friendly account names for wildcard
        // admins. Per-account admins can't call this endpoint (it's
        // wildcard-only), so they keep raw IDs — fine, since they only
        // see their own account anyway.
        if (resolved.includes('*')) {
          try {
            const org = await api.listOrgAccounts(config);
            if (cancelled) return;
            const names: Record<string, string> = {};
            for (const a of org.accounts) names[a.id] = a.name;
            setAccountNames(names);
          } catch {
            /* Org call may fail on installs that aren't the Org management account.
             * Accept the empty map; the SPA falls back to raw IDs. */
          }
        }
      } catch {
        if (!cancelled) setScopes([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [config]);

  if (scopes === undefined) return undefined;
  const isWildcard = scopes.includes('*');
  return {
    scopes,
    isAdmin: scopes.length > 0,
    isWildcard,
    currentAccount,
    setCurrentAccount: (id: string) => {
      setCurrentAccountState(id);
      try {
        window.localStorage.setItem(STORAGE_KEY, id);
      } catch {
        /* localStorage may be disabled — fall back to in-memory only. */
      }
    },
    accountNames,
  };
};

interface ShellProps {
  config: BbgConfig;
  email: string;
  /** Friendly name for the top-nav (falls back to email). */
  displayName: string;
  signOut: () => void;
}

/**
 * Polls spend for any rows where an enforcement deny policy is currently
 * attached. Returns the count so the global flashbar can surface a banner.
 * Polls every 60s — the bedrock-meter writes faster than that, but the
 * banner exists for situational awareness, not real-time signaling.
 */
const useEnforcementBanner = (config: BbgConfig, isAdmin: boolean | undefined) => {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (isAdmin === undefined || !config.apiBaseUrl) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const resp = isAdmin ? await api.listSpend(config) : await api.mySpend(config);
        if (cancelled) return;
        setCount(resp.items.filter((r) => r.enforced).length);
      } catch {
        // Stay silent on errors — the banner is best-effort.
      }
    };
    void tick();
    const interval = window.setInterval(() => void tick(), 60000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [config, isAdmin]);
  return count;
};

const Shell = ({ config, email, displayName, signOut }: ShellProps) => {
  const location = useLocation();
  const navigate = useNavigate();
  const { choice, toggle } = useTheme();
  const auth = useAuthScope(config);
  // Live display name shown in the top-right. Seeded from the prop (read
  // off the ID token at sign-in) and refreshed in place when the user
  // updates their `name` on the Profile page — see refreshDisplayName.
  const [liveDisplayName, setLiveDisplayName] = useState(displayName);
  useEffect(() => setLiveDisplayName(displayName), [displayName]);
  const refreshDisplayName = async () => {
    try {
      // Force a token refresh so the new `name` claim lands, then re-derive.
      const s = await fetchAuthSession({ forceRefresh: true });
      const next = displayNameFromPayload(s.tokens?.idToken?.payload);
      if (next) setLiveDisplayName(next);
    } catch {
      // Best-effort — falls back to the prior name / next sign-in.
    }
  };
  const isAdmin = auth?.isAdmin;
  const enforcedCount = useEnforcementBanner(config, isAdmin);
  const [dismissed, setDismissed] = useState(false);
  // route-derived in-app help. When the current page has a help topic,
  // the AppLayout shows an `info` link that opens this panel in the tools
  // drawer. Auto-close when navigating to a page with no topic.
  const helpTopic = helpTopicForPath(location.pathname);
  const [toolsOpen, setToolsOpen] = useState(false);
  useEffect(() => {
    if (!helpTopic) setToolsOpen(false);
  }, [helpTopic]);
  const flashItems: FlashbarProps.MessageDefinition[] =
    enforcedCount > 0 && !dismissed
      ? [
          {
            id: 'enforcement-active',
            type: 'warning',
            header: 'Enforcement is active',
            content: isAdmin
              ? `${enforcedCount} principal${enforcedCount === 1 ? '' : 's'} currently blocked from invoking Bedrock by a bbg-deny-* policy. Review on the Spend page.`
              : 'Your account is currently blocked from invoking Bedrock by an active enforcement policy. Contact an admin or wait for the next budget period.',
            dismissible: true,
            onDismiss: () => setDismissed(true),
            buttonText: isAdmin ? 'View spend' : undefined,
            onButtonClick: isAdmin ? () => navigate('/spend') : undefined,
          },
        ]
      : [];

  // account selector. Visible only when the user has
  // wildcard scope (super-admin viewing N accounts) or membership in
  // 2+ per-account groups. Single-account admins see the implicit
  // selection in the menu label but no need to pick.
  const accountSelectorItems: TopNavigationProps.MenuDropdownUtility['items'] = (() => {
    if (!auth || !auth.isAdmin) return [];
    if (auth.isWildcard) {
      // Super-admin: aggregate view + each known account from the Org.
      // Account names come from the enroll-wizard's
      // /admin/org/accounts call hydrated by useAuthScope. Sorted by
      // friendly name so the menu reads alphabetically.
      const ids = Object.keys(auth.accountNames).sort((a, b) =>
        (auth.accountNames[a] ?? '').localeCompare(auth.accountNames[b] ?? ''),
      );
      return [
        { id: '*', text: 'All accounts (super-admin)' },
        ...ids.map((id) => ({ id, text: formatAccount(id, auth.accountNames) })),
      ];
    }
    return auth.scopes.map((id) => ({ id, text: formatAccount(id, auth.accountNames) }));
  })();
  const showAccountSelector =
    auth?.isAdmin && (auth.isWildcard || auth.scopes.length > 1);
  const accountChipText = auth
    ? formatAccount(auth.currentAccount, auth.accountNames)
    : '';

  const utilities: TopNavigationProps.Utility[] = [
    // page help — opens the tools drawer with the route's HelpPanel.
    // Shown only on pages that have a help topic.
    ...(helpTopic
      ? ([
          {
            type: 'button',
            iconName: 'status-info',
            ariaLabel: `Help: ${helpTopic.title}`,
            text: 'Help',
            onClick: () => setToolsOpen((o) => !o),
          },
        ] as TopNavigationProps.Utility[])
      : []),
    {
      type: 'button',
      iconName: choice === 'dark' ? 'star-filled' : 'star',
      ariaLabel: `Switch to ${choice === 'dark' ? 'light' : 'dark'} mode`,
      text: choice === 'dark' ? 'Dark' : 'Light',
      onClick: toggle,
    },
    ...(showAccountSelector
      ? ([
          {
            type: 'menu-dropdown',
            text: accountChipText,
            ariaLabel: 'Active account',
            iconName: 'multiscreen',
            items: accountSelectorItems,
            onItemClick: (e) => {
              auth?.setCurrentAccount(e.detail.id);
            },
          },
        ] as TopNavigationProps.Utility[])
      : []),
    {
      type: 'menu-dropdown',
      text: liveDisplayName,
      // Keep the email visible as the dropdown sub-line so it's still clear
      // which account is signed in when a friendly name is shown.
      description: liveDisplayName !== email ? email : undefined,
      iconName: 'user-profile',
      items: [
        { id: 'profile', text: 'My profile' },
        { id: 'signout', text: 'Sign out' },
      ],
      onItemClick: (e) => {
        if (e.detail.id === 'signout') signOut();
        if (e.detail.id === 'profile') navigate('/me/profile');
      },
    },
  ];

  return (
    <ScopeContext.Provider
      value={{
        accountNames: auth?.accountNames ?? {},
        isWildcard: auth?.isWildcard ?? false,
        scopes: auth?.scopes ?? [],
        currentAccount: auth?.currentAccount ?? '',
        refreshDisplayName: () => void refreshDisplayName(),
      }}
    >
      <TopNavigation
        identity={{
          href: '/',
          title: 'Bedrock Budget Guard',
          // Inline data-URI SVGs don't inherit `currentColor` from CSS,
          // so the previous logo was invisible in dark mode. Use AWS
          // brand orange (#FF9900) — readable against both light and
          // dark Cloudscape backgrounds, and reads as AWS-native.
          logo: {
            src:
              'data:image/svg+xml;utf8,' +
              encodeURIComponent(
                '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24"><path fill="#FF9900" d="M12 2 3 6v6c0 5 4 9 9 10 5-1 9-5 9-10V6z"/></svg>',
              ),
            alt: 'BBG',
          },
        }}
        utilities={utilities}
      />

      <AppLayout
        toolsHide={!helpTopic}
        toolsOpen={Boolean(helpTopic) && toolsOpen}
        onToolsChange={(e: NonCancelableCustomEvent<{ open: boolean }>) => setToolsOpen(e.detail.open)}
        tools={
          helpTopic ? (
            <HelpPanel
              header={<h2>{helpTopic.title}</h2>}
              footer={
                helpTopic.learnMoreGuideId ? (
                  <div>
                    <h3>Learn more</h3>
                    <Link
                      variant="primary"
                      onFollow={() => {
                        setToolsOpen(false);
                        navigate(`/docs/${helpTopic.learnMoreGuideId}`);
                      }}
                    >
                      Open the full guide
                    </Link>
                  </div>
                ) : undefined
              }
            >
              {helpTopic.paragraphs.map((p, i) => (
                <p key={i}>{p}</p>
              ))}
              {helpTopic.bullets && (
                <ul>
                  {helpTopic.bullets.map((b, i) => (
                    <li key={i}>{b}</li>
                  ))}
                </ul>
              )}
            </HelpPanel>
          ) : undefined
        }
        navigation={
          <SideNavigation
            header={{ text: 'BBG', href: isAdmin ? '/' : '/me/spend' }}
            items={isAdmin ? filterAdminNav(auth?.isWildcard ?? false) : userNav}
            activeHref={location.pathname}
            onFollow={(e) => {
              if (!e.detail.external) {
                e.preventDefault();
                navigate(e.detail.href);
              }
            }}
          />
        }
        notifications={<Flashbar items={flashItems} />}
        content={
          isAdmin === undefined ? (
            <></>
          ) : (
            <Suspense fallback={<PageFallback />}>
              <Routes>
                <Route
                  path="/"
                  element={isAdmin ? <SpendDashboard config={config} /> : <Navigate to="/me/spend" replace />}
                />
                {isAdmin && <Route path="/spend" element={<SpendDashboard config={config} />} />}
                {isAdmin && <Route path="/budgets" element={<BudgetsAdminShell config={config} />} />}
                {/* legacy routes redirect to the tabbed shell. */}
                {isAdmin && <Route path="/admin/defaults" element={<Navigate to="/budgets?tab=defaults" replace />} />}
                {isAdmin && <Route path="/admin/manifest" element={<Navigate to="/budgets?tab=manifest" replace />} />}
                {isAdmin && <Route path="/readiness" element={<Readiness config={config} />} />}
                {isAdmin && <Route path="/identities" element={<Identities config={config} />} />}
                {isAdmin && <Route path="/inference-profiles" element={<InferenceProfiles config={config} />} />}
                {isAdmin && <Route path="/agent-sessions" element={<AgentSessions config={config} />} />}
                {isAdmin && <Route path="/pricing-overrides" element={<PricingOverrides config={config} />} />}
                {isAdmin && <Route path="/reports" element={<Reports config={config} />} />}
                {isAdmin && <Route path="/admin/users" element={<AdminUsers config={config} />} />}
                {isAdmin && <Route path="/admin/enroll" element={<Enrollment config={config} />} />}
                {isAdmin && <Route path="/admin/audit" element={<AuditLog config={config} />} />}
                {isAdmin && <Route path="/admin/activity" element={<AdminActivity config={config} />} />}
                <Route path="/me/spend" element={<MyBudget config={config} mode="spend" />} />
                <Route path="/me/budget" element={<MyBudget config={config} mode="budget" />} />
                <Route path="/me/profile" element={<Profile config={config} />} />
                {/* Self-service activity — every signed-in user, own timeline. */}
                <Route path="/me/activity" element={<MyActivity config={config} />} />
                {/* docs available to every signed-in user. */}
                <Route path="/docs" element={<Docs />} />
                <Route path="/docs/:guideId" element={<Docs />} />
                <Route path="/callback" element={<NavLink to="/">Returning…</NavLink>} />
                <Route path="*" element={<Navigate to="/me/spend" replace />} />
              </Routes>
            </Suspense>
          )
        }
      />
    </ScopeContext.Provider>
  );
};

export const App = ({ config }: AppProps) => {
  // Local-dev escape hatch: if Cognito isn't configured, render the shell
  // without auth so devs can iterate on the layout without a backend.
  if (!config.userPoolId || !config.userPoolClientId) {
    return (
      <BrowserRouter>
        <Shell config={config} email="local-dev" displayName="local-dev" signOut={() => undefined} />
      </BrowserRouter>
    );
  }

  return (
    <AuthGate>
      {({ email, displayName, signOut }) => (
        <BrowserRouter>
          <Shell config={config} email={email} displayName={displayName} signOut={signOut} />
        </BrowserRouter>
      )}
    </AuthGate>
  );
};
