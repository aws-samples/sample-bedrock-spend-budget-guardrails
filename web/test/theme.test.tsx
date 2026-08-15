/**
 * Theme regression tests — plan §15.14.
 *
 * The risk this guards against: Cloudscape's `applyMode` toggles a class on
 * `<body>` that the chart components watch via MutationObserver to re-style
 * their palette tokens. Rapid theme toggles can race that observer (we saw
 * a transient white-on-white legend in dark mode in 2026-04 when an
 * upstream Cloudscape update changed the observer debounce). This test
 * mounts a LineChart, toggles the theme repeatedly, and asserts the chart
 * renders without throwing and the body's `awsui-dark-mode` class tracks
 * the active mode.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import LineChart from '@cloudscape-design/components/line-chart';
import { Mode, applyMode } from '@cloudscape-design/global-styles';

const STORAGE_KEY = 'bbg.theme';
const DARK_CLASS = 'awsui-dark-mode';

const isDark = () => document.body.classList.contains(DARK_CLASS);

describe('Cloudscape theme regression', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.body.classList.remove(DARK_CLASS);
  });

  afterEach(() => {
    cleanup();
    document.body.classList.remove(DARK_CLASS);
  });

  it('applyMode toggles the awsui-dark-mode class on <body>', () => {
    expect(isDark()).toBe(false);
    applyMode(Mode.Dark);
    expect(isDark()).toBe(true);
    applyMode(Mode.Light);
    expect(isDark()).toBe(false);
  });

  it('renders a LineChart and survives 10 rapid Dark↔Light toggles without throwing', async () => {
    const series = [
      {
        title: 'Total spend ($)',
        type: 'line' as const,
        data: [
          { x: '2026-03', y: 1.23 },
          { x: '2026-04', y: 2.34 },
          { x: '2026-05', y: 3.45 },
        ],
      },
    ];

    applyMode(Mode.Dark);

    const { container } = render(
      <LineChart
        series={series}
        xDomain={['2026-03', '2026-04', '2026-05']}
        yDomain={[0, 4]}
        xTitle="Month"
        yTitle="USD"
        ariaLabel="Total spend trend"
        height={220}
        statusType="finished"
        hideFilter
        empty="No spend"
      />,
    );

    expect(container.querySelector('[role="application"], svg, [class*="chart"]')).not.toBeNull();
    expect(isDark()).toBe(true);

    for (let i = 0; i < 10; i++) {
      await act(async () => {
        applyMode(i % 2 === 0 ? Mode.Light : Mode.Dark);
      });
      // After each toggle the body class must match the requested mode.
      expect(isDark()).toBe(i % 2 !== 0);
    }

    // Chart node still attached after the storm.
    expect(container.firstChild).not.toBeNull();
  });

  it('persists the user choice to localStorage under bbg.theme', async () => {
    const { persistChoice, initialChoice, apply } = await import('../src/theme/applyMode');

    expect(initialChoice()).toBe('dark'); // default when no value persisted

    persistChoice('light');
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('light');
    expect(initialChoice()).toBe('light');

    persistChoice('system');
    expect(initialChoice()).toBe('system');

    // apply() returns the resolved Mode and synchronously updates <body>.
    const resolved = apply('dark');
    expect(resolved).toBe(Mode.Dark);
    expect(isDark()).toBe(true);
  });
});
