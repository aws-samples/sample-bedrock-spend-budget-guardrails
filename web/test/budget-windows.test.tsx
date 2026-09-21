import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { AdminBudgets } from '../src/pages/AdminBudgets';
import { api, type BudgetRow, type BudgetWindow, type SpendRow } from '../src/api/client';
import type { BbgConfig } from '../src/config';

vi.mock('../src/api/client', () => ({
  api: { listBudgets: vi.fn(), listSpend: vi.fn() },
}));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it('shows each budget’s own window spend, deny status, and Release action', async () => {
  const config: BbgConfig = {
    region: 'us-west-2', userPoolId: '', userPoolClientId: '', userPoolDomain: '',
    apiBaseUrl: 'https://example.invalid', gatewayBaseUrl: '', webAuthnEnabled: false,
  };
  const windows: BudgetWindow[] = ['monthly', 'weekly', 'daily', '5h'];
  const budgets: BudgetRow[] = windows.map(window => ({
    principal: `principal#sourceIdentity#person-${window}`, target: 'model#amazon.nova-micro-v1:0',
    limitUsd: 1, action: 'deny', enabled: true,
    ...(window === 'monthly' ? {} : { window }),
  }));
  const row = (budget: BudgetRow, spendUsd: number): SpendRow => ({
    principal: budget.principal, target: budget.target, sk: `period#test#target#${budget.target}`,
    spendUsd, enforced: true, enforcementReason: 'usd', inputTokens: 0, outputTokens: 0,
  });
  vi.mocked(api.listBudgets).mockResolvedValue({ items: budgets });
  vi.mocked(api.listSpend).mockImplementation(async (_config, _period, window = 'monthly') => ({
    period: window,
    // A monthly row for the daily principal must not override the daily row.
    items: window === 'monthly' ? [row(budgets[0], 2), row(budgets[2], 99)]
      : [row(budgets[windows.indexOf(window)], 2)],
  }));
  render(<MemoryRouter><AdminBudgets config={config} /></MemoryRouter>);
  await screen.findByText('person-daily');
  for (const window of windows) {
    const tr = screen.getByText(`person-${window}`).closest('tr')!;
    expect(within(tr).getByText('$2.0000')).toBeTruthy();
    expect(within(tr).getByText('Enforced (USD)')).toBeTruthy();
    expect(within(tr).getByRole('button', { name: 'Release', exact: true })).toBeTruthy();
  }
  for (const window of windows) expect(api.listSpend).toHaveBeenCalledWith(config, undefined, window);
  await waitFor(() => expect(api.listSpend).toHaveBeenCalledTimes(4));
});
