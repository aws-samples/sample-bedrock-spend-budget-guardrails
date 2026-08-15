/**
 * ActivityTable — the shared renderer extracted from PrincipalActivityModal so
 * the modal, /me/activity, and /admin/activity all render identically. First
 * component test in web/test (theme.test.tsx aside). Guards:
 *  - the badge-color mapping stays correct per event family, and
 *  - each variant renders the right "By"/Principal columns and redaction
 *    (self variant must NOT show an actor email — it's a redaction boundary).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ActivityTable, activityBadgeColor } from '../src/components/ActivityTable';
import type { ActivityItem } from '../src/api/client';

afterEach(cleanup);

const row = (over: Partial<ActivityItem>): ActivityItem => ({
  ts: '2026-07-30T00:00:00.000Z',
  type: 'threshold.warning',
  summary: 'Spend crossed 80%',
  ...over,
});

describe('activityBadgeColor', () => {
  it('maps enforcement + unattachable to red', () => {
    expect(activityBadgeColor('enforcement.applied')).toBe('red');
    expect(activityBadgeColor('enforcement.unattachable')).toBe('red');
  });
  it('maps threshold warnings to amber (severity-medium)', () => {
    expect(activityBadgeColor('threshold.warning')).toBe('severity-medium');
  });
  it('maps releases + rollovers to green', () => {
    expect(activityBadgeColor('enforcement.released')).toBe('green');
    expect(activityBadgeColor('enforcement.rolled_over')).toBe('green');
  });
  it('maps budget/user config changes to blue', () => {
    expect(activityBadgeColor('budget.created')).toBe('blue');
    expect(activityBadgeColor('user.disabled')).toBe('blue');
  });
  it('falls back to grey for unknown types', () => {
    expect(activityBadgeColor('notification.sent')).toBe('grey');
  });
});

describe('ActivityTable variants', () => {
  it('admin variant renders a Principal column and the actor email', () => {
    render(
      <ActivityTable
        variant="admin"
        items={[row({ principal: 'principal#arn:aws:iam::1:role/X', actor: { email: 'op@example.com' } })]}
      />,
    );
    expect(screen.getByText('Principal')).toBeTruthy();
    expect(screen.getByText('op@example.com')).toBeTruthy();
  });

  it('self variant redacts the actor — shows "An administrator", never the email', () => {
    render(
      <ActivityTable
        variant="self"
        items={[row({ byAdmin: true, actor: { email: 'secret@example.com' } })]}
      />,
    );
    expect(screen.getByText('An administrator')).toBeTruthy();
    expect(screen.queryByText('secret@example.com')).toBeNull();
    // No Principal column in the self view.
    expect(screen.queryByText('Principal')).toBeNull();
  });

  it('self variant shows "(system)" for a system (no-actor) event', () => {
    render(<ActivityTable variant="self" items={[row({ byAdmin: false })]} />);
    expect(screen.getByText('(system)')).toBeTruthy();
  });

  it('admin variant makes the principal clickable when onPrincipalClick is provided', () => {
    const onClick = vi.fn();
    const principal = 'principal#arn:aws:iam::1:role/MyDistinctRole';
    const { container } = render(
      <ActivityTable variant="admin" onPrincipalClick={onClick} items={[row({ principal })]} />,
    );
    // PrincipalCell renders the trimmed display name ("MyDistinctRole") inside a
    // clickable Cloudscape Link. Click the anchor so onFollow fires.
    expect(screen.getByText('MyDistinctRole')).toBeTruthy();
    const anchor = container.querySelector('a');
    expect(anchor).not.toBeNull();
    anchor!.click();
    expect(onClick).toHaveBeenCalledWith(principal);
  });
});
