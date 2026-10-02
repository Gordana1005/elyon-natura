import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '@/i18n';
import { formatDenari } from '@/lib/currency';
import { naturaIncludesWeb, shownMexAccounts, type MexAccount, type MexCashResponse } from '@/lib/insightsApi/mexCash';
import sample from './__fixtures__/mexcash.sample.json';

// Insights → Наплата (MEX) (owner 02.10.2026) from its synthetic fixture: the
// period per MEX account on the delivery day, the days, MEX's settlement periods
// (the running one marked) and what MEX holds now — said to be NOT money in the bank.
const h = vi.hoisted(() => ({ mexCash: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u-test', isAdmin: true, isManager: false } }),
}));
vi.mock('@/lib/insightsApi/mexCash', async (orig) => ({
  ...(await orig<typeof import('@/lib/insightsApi/mexCash')>()),
  apiGetInsightsMexCash: (...a: unknown[]) => h.mexCash(...a),
}));

beforeAll(async () => { await i18n.changeLanguage('mk'); });
beforeEach(() => { h.mexCash.mockReset(); });

const { default: MexCashTab } = await import('./MexCashTab');
const data = () => structuredClone(sample) as unknown as MexCashResponse;

/** The dept_admin payload (access levels, 20260947001600): one account in every block. */
function onlyAccount(a: MexAccount, note: string | null): MexCashResponse {
  const d = data();
  const other: MexAccount = a === 'natura' ? 'bio_natural' : 'natura';
  const drop = <T extends Record<string, unknown>>(o: T): T => { const c = { ...o }; delete c[other]; return c; };
  return {
    ...d,
    meta: { ...d.meta, accounts: [a], dept_scope: a === 'natura' ? ['teleshop_out', 'teleshop_other', 'social'] : ['altercpa', 'elyon_crm'], account_note: note },
    days: d.days.map((x) => drop(x as unknown as Record<string, unknown>)) as unknown as MexCashResponse['days'],
    halves: d.halves.map((x) => drop(x as unknown as Record<string, unknown>)) as unknown as MexCashResponse['halves'],
    total: drop(d.total as unknown as Record<string, unknown>) as unknown as MexCashResponse['total'],
    now: drop(d.now as unknown as Record<string, unknown>) as unknown as MexCashResponse['now'],
  };
}

describe('Наплата (MEX) — which accounts are drawn', () => {
  it('meta.accounts in the fixed order; none, empty or unknown = both', () => {
    expect(shownMexAccounts({ accounts: ['bio_natural', 'natura'] })).toEqual(['natura', 'bio_natural']);
    expect(shownMexAccounts({ accounts: ['bio_natural'] })).toEqual(['bio_natural']);
    expect(shownMexAccounts({ accounts: [] })).toEqual(['natura', 'bio_natural']);
    expect(shownMexAccounts({})).toEqual(['natura', 'bio_natural']);
    expect(shownMexAccounts({ accounts: ['bogus' as MexAccount] })).toEqual(['natura', 'bio_natural']);
  });
  it('the web-shop note: NATURA drawn and the api says so, or NATURA alone', () => {
    expect(naturaIncludesWeb({ accounts: ['natura'], account_note: 'natura_includes_web' })).toBe(true);
    expect(naturaIncludesWeb({ accounts: ['natura'] })).toBe(true);
    expect(naturaIncludesWeb({ accounts: ['bio_natural'], account_note: 'natura_includes_web' })).toBe(false);
    expect(naturaIncludesWeb({ accounts: ['natura', 'bio_natural'] })).toBe(false);
    expect(naturaIncludesWeb({ accounts: ['natura', 'bio_natural'], account_note: 'natura_includes_web' })).toBe(true);
  });
});

function renderTab(d: MexCashResponse) {
  h.mexCash.mockResolvedValue(d);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/insights?tab=mex-cash&range=custom&from=2026-09-16&to=2026-10-02']}>
        <MexCashTab />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Наплата (MEX)', () => {
  it('says what it is, and adds the accounts up to the period total', async () => {
    renderTab(data());
    expect(await screen.findByText(i18n.t('insights.mexCash.kpi.collected'), {}, { timeout: 10_000 })).toBeInTheDocument();
    expect(h.mexCash).toHaveBeenCalledWith({ from: '2026-09-16', to: '2026-10-02' }, expect.anything());
    expect(screen.getByText(i18n.t('insights.mexCash.intro'))).toBeInTheDocument();
    const total = sample.total.natura.cod_mkd + sample.total.bio_natural.cod_mkd;
    const tile = screen.getByText(i18n.t('insights.mexCash.kpi.collected')).closest('li')!;
    expect(within(tile).getByText(formatDenari(total))).toBeInTheDocument();
    const natura = screen.getAllByText(i18n.t('insights.mexCash.account.natura'))[0].closest('li')!;
    expect(within(natura).getByText(formatDenari(sample.total.natura.cod_mkd))).toBeInTheDocument();
  }, 30_000);

  it('MEX settlement periods: newest first, the running one marked, the payouts said to be missing', async () => {
    renderTab(data());
    const heading = await screen.findByText(i18n.t('insights.mexCash.halves.title'), {}, { timeout: 10_000 });
    const section = heading.closest('section')!;
    expect(within(section).getAllByText(i18n.t('insights.mexCash.halves.running')).length).toBeGreaterThan(0);
    expect(within(section).getByText(i18n.t('insights.mexCash.halves.payouts'))).toBeInTheDocument();
    const h0 = sample.halves[0];
    expect(within(section).getAllByText(formatDenari(h0.natura.cod_mkd + h0.bio_natural.cod_mkd)).length).toBeGreaterThan(0);
  }, 30_000);

  it('a dept_admin of Тим Центар: NATURA only, with the web-shop note; no BIO NATURAL anywhere', async () => {
    renderTab(onlyAccount('natura', 'natura_includes_web'));
    expect(await screen.findByText(i18n.t('insights.mexCash.naturaIncludesWeb'), {}, { timeout: 10_000 })).toBeInTheDocument();
    expect(screen.queryAllByText(i18n.t('insights.mexCash.account.bio_natural'))).toHaveLength(0);
    // one account: the total IS that account — no separate "collected" tile, no total column
    expect(screen.queryByText(i18n.t('insights.mexCash.kpi.collected'))).toBeNull();
    expect(screen.queryAllByRole('columnheader', { name: i18n.t('insights.mexCash.col.total') })).toHaveLength(0);
    const natura = screen.getAllByText(i18n.t('insights.mexCash.account.natura'))[0].closest('li')!;
    expect(within(natura).getByText(formatDenari(sample.total.natura.cod_mkd))).toBeInTheDocument();
    const now = screen.getByText(i18n.t('insights.mexCash.now.courier')).closest('li')!;
    expect(within(now).getAllByText(formatDenari(sample.now.natura.courier_cod_mkd)).length).toBeGreaterThan(0);
  }, 30_000);

  it('a dept_admin of Тим Маџари: BIO NATURAL only, no web-shop note', async () => {
    renderTab(onlyAccount('bio_natural', null));
    const label = await screen.findAllByText(i18n.t('insights.mexCash.account.bio_natural'), {}, { timeout: 10_000 });
    expect(label.length).toBeGreaterThan(0);
    expect(screen.queryAllByText(i18n.t('insights.mexCash.account.natura'))).toHaveLength(0);
    expect(screen.queryByText(i18n.t('insights.mexCash.naturaIncludesWeb'))).toBeNull();
  }, 30_000);

  it('what MEX holds now: at the courier and labelled, per account', async () => {
    renderTab(data());
    const label = await screen.findByText(i18n.t('insights.mexCash.now.courier'), {}, { timeout: 10_000 });
    const tile = label.closest('li')!;
    expect(within(tile).getByText(formatDenari(sample.now.natura.courier_cod_mkd + sample.now.bio_natural.courier_cod_mkd))).toBeInTheDocument();
  }, 30_000);
});
