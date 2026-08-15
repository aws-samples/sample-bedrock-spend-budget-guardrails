import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { apply, initialChoice, persistChoice, type ThemeChoice } from './applyMode';

interface ThemeContextValue {
  choice: ThemeChoice;
  setChoice: (next: ThemeChoice) => void;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

export const ThemeProvider = ({ children }: { children: ReactNode }) => {
  const [choice, setChoice] = useState<ThemeChoice>(() => initialChoice());

  useEffect(() => {
    apply(choice);
    persistChoice(choice);
  }, [choice]);

  // Re-apply when the OS preference flips while in `system` mode.
  useEffect(() => {
    if (choice !== 'system') return;
    const mql = window.matchMedia('(prefers-color-scheme: light)');
    const handler = () => apply('system');
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [choice]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      choice,
      setChoice,
      toggle: () => setChoice((c) => (c === 'dark' ? 'light' : 'dark')),
    }),
    [choice],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};

export const useTheme = (): ThemeContextValue => {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside ThemeProvider');
  return ctx;
};
