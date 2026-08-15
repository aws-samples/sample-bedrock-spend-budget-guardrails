import { createContext, useContext } from 'react';

/**
 * follow-up: minimal context exposing the auth scope's account-
 * name lookup so deep pages (Identities, SpendDashboard, etc.) can
 * render `Friendly Name (123456789012)` without prop-drilling.
 *
 * Defaults to empty maps + `false` so non-admin pages and local-dev
 * runs (where `<Shell>` doesn't wrap routes) still type-check.
 */
export interface ScopeContextValue {
  accountNames: Record<string, string>;
  isWildcard: boolean;
  scopes: string[];
  currentAccount: string;
  /**
   * Re-read the display name shown in the top-right from a freshly
   * refreshed ID token. Called by the Profile page after a user changes
   * their `name` so the top-right updates without requiring a re-login.
   * No-op default for local-dev / non-Shell render paths.
   */
  refreshDisplayName: () => void;
}

export const ScopeContext = createContext<ScopeContextValue>({
  accountNames: {},
  isWildcard: false,
  scopes: [],
  currentAccount: '',
  refreshDisplayName: () => undefined,
});

export const useScope = (): ScopeContextValue => useContext(ScopeContext);

/** Render an account ID as `Name (123456789012)` if a friendly name
 *  is known, else just the raw ID. `*` renders as `All accounts`. */
export const formatAccount = (
  id: string,
  names: Record<string, string>,
): string => {
  if (id === '*') return 'All accounts';
  const name = names[id];
  return name ? `${name} (${id})` : id;
};
