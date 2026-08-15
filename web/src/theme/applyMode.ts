import { applyMode, Mode } from '@cloudscape-design/global-styles';

const STORAGE_KEY = 'bbg.theme';

export type ThemeChoice = 'dark' | 'light' | 'system';

const resolveSystemMode = (): Mode => {
  if (typeof window === 'undefined' || !window.matchMedia) return Mode.Dark;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? Mode.Light : Mode.Dark;
};

export const initialChoice = (): ThemeChoice => {
  if (typeof window === 'undefined') return 'dark';
  const saved = window.localStorage.getItem(STORAGE_KEY);
  if (saved === 'dark' || saved === 'light' || saved === 'system') return saved;
  // Default: dark mode.
  return 'dark';
};

export const persistChoice = (choice: ThemeChoice): void => {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(STORAGE_KEY, choice);
  }
};

export const apply = (choice: ThemeChoice): Mode => {
  const mode = choice === 'system' ? resolveSystemMode() : choice === 'dark' ? Mode.Dark : Mode.Light;
  applyMode(mode);
  return mode;
};

export { Mode };
