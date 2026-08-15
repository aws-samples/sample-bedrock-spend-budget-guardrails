import Button from '@cloudscape-design/components/button';
import { useTheme } from './ThemeProvider';

/**
 * Top-nav theme toggle. Lives in TopNavigation's `utilities` slot.
 */
export const ThemeToggle = () => {
  const { choice, toggle } = useTheme();
  const next = choice === 'dark' ? 'light' : 'dark';
  return (
    <Button
      variant="icon"
      iconName={choice === 'dark' ? 'star-filled' : 'star'}
      ariaLabel={`Switch to ${next} mode (currently ${choice})`}
      onClick={toggle}
    />
  );
};
