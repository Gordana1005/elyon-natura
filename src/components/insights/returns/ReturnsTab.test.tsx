import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '@/i18n';
import { formatDenari } from '@/lib/currency';
import { fmtInt, fmtPct } from '../overview/model';
import type { ReturnsResponse } from '@/lib/insightsApi/returnsStock';
import sample from './__fixtures__/returns.sample.json';
import mexSample from './__fixtures__/returns.mex.sample.json';

// Insights → Returns rendered from the 01.09–27.09.2026 payloads: the cohort
// clock (the period's sales and how many came back so far — the Overview's
// "Вратено" part) and the MEX-return-day clock; a number opens only the orders
// it counts; a non-owner sees the same page counted.
const h = vi.hoisted(() => ({ returns: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u-test', isAdmin: true, isManager: false } }),
}));
vi.mock('@/lib/insightsApi/returnsStock', async (orig) => {
  const m = await orig<typeof import('@/lib/insightsApi/returnsStock')>();
  return { ...m, apiGetInsightsReturns: (...a: unknown[]) => h.returns(...a) };
});

beforeAll(async () => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  await i18n.changeLanguage('mk');
});

const { default: ReturnsTab, stripReturnsMoney } = await import('./ReturnsTab');

const S = () => structuredClone(sample) as unknown as ReturnsResponse;
const M = () => structuredClone(mexSample) as unknown as ReturnsResponse;
const WIN = 'range=custom&from=2026-09-01&to=2026-09-27';

function renderWith(impl: (p: { clock: string }) => ReturnsResponse, query = WIN) {
  h.returns.mockReset();
  h.returns.mockImplementation(async (p: { clock: string }) => impl(p));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/insights?tab=returns&${query}`]}>
        <ReturnsTab />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const heroSale = () => i18n.t('insights.returns.hero.titleSale', { period: '01.09 – 27.09.2026' });

describe('Returns — owner, cohort clock', { timeout: 30_000 }, () => {
  it('leads with the cohort\'s returned part and says how much is still open', async () => {
    const s = S();
    renderWith(() => s);
    expect(await screen.findByText(heroSale(), {}, { timeout: 10_000 })).toBeInTheDocument();
    expect(h.returns).toHaveBeenCalledWith(
      { from: '2026-09-01', to: '2026-09-27', compare: true, sources: [], clock: 'sale' }, expect.anything());
    expect(screen.getAllByText(i18n.t('insights.returns.hero.ofSales', {
      n: fmtInt(s.kpis.base.count, 'mk'), pct: fmtPct(s.kpis.rate, 'mk'),
    })).length).toBe(1);
    // uncollected COD, in денари
    expect(screen.getAllByText(formatDenari(s.kpis.returned.value_mkd)).length).toBeGreaterThan(0);
    expect(screen.getByText(i18n.t('insights.returns.hero.soFar', {
      n: fmtInt(s.kpis.open!.count, 'mk'), pct: fmtPct(s.kpis.open!.share, 'mk', 0),
    }))).toBeInTheDocument();
  });

  it('never shows euro; the returned total (orders + web + MEX-only) offers only its order part', async () => {
    const s = S();
    const { container } = renderWith(() => s);
    await screen.findByText(heroSale(), {}, { timeout: 10_000 });
    expect(container.textContent).not.toMatch(/€|EUR\b/);
    const part = screen.getAllByText(i18n.t('insights.common.cohort.ordersPart', { n: fmtInt(s.kpis.returned.orders, 'mk') }))[0].closest('a')!;
    const sp = new URLSearchParams(part.getAttribute('href')!.split('?')[1]);
    expect(Object.fromEntries(sp)).toEqual({ cohort_bucket: 'returned', sold_from: '2026-09-01', sold_to: '2026-09-27' });
  });

  it('a seller\'s returns open exactly that seller\'s returned orders', async () => {
    renderWith(() => S());
    await screen.findByText(heroSale(), {}, { timeout: 10_000 });
    const link = screen.getAllByRole('link').find((a) => (a.getAttribute('href') ?? '').includes('sold_by_person_id='))!;
    const sp = new URLSearchParams(link.getAttribute('href')!.split('?')[1]);
    expect(sp.get('cohort_bucket')).toBe('returned');
    expect(sp.get('sold_by_person_id')).toBe('00000000-0000-4000-8000-000000000001');
  });

  it('shows cancelled-after-sale apart from returns, with reasons in Macedonian', async () => {
    renderWith(() => S());
    await screen.findByText(heroSale(), {}, { timeout: 10_000 });
    expect(screen.getByText(i18n.t('insights.returns.reasons.title'))).toBeInTheDocument();
    expect(screen.getAllByText(i18n.t('cancelReason.no_parcel_7d')).length).toBeGreaterThan(0);
  });
});

describe('Returns — the MEX-return-day clock', { timeout: 30_000 }, () => {
  it('switches the clock, asks the api for it, and ties to the register', async () => {
    renderWith((p) => (p.clock === 'returned' ? M() : S()));
    await screen.findByText(heroSale(), {}, { timeout: 10_000 });
    fireEvent.click(screen.getByRole('radio', { name: i18n.t('insights.returns.clock.returned') }));
    const hero = i18n.t('insights.returns.hero.titleMex', { period: '01.09 – 27.09.2026' });
    expect(await screen.findByText(hero, {}, { timeout: 10_000 })).toBeInTheDocument();
    await waitFor(() => expect(h.returns).toHaveBeenLastCalledWith(expect.objectContaining({ clock: 'returned' }), expect.anything()));
    expect(screen.getAllByText(fmtInt(M().kpis.returned.count, 'mk')).length).toBeGreaterThan(0);
    // no /orders link on this clock: the number says why in its tooltip
    expect(screen.getAllByTitle(i18n.t('insights.returns.noLinkMexDay')).length).toBeGreaterThan(0);
  });
});

describe('Returns — admin / manager (no money)', { timeout: 30_000 }, () => {
  it('shows the same page counted: no денари, no money tiles or columns', async () => {
    const owner = S();
    const s = stripReturnsMoney(S());
    const { container } = renderWith(() => s);
    await screen.findByText(heroSale(), {}, { timeout: 10_000 });
    // not one of the owner's денари figures
    for (const v of [owner.kpis.returned.value_mkd, owner.kpis.cancelled_after_sale.value_mkd, ...owner.by_source.map((r) => r.value_mkd)]) {
      expect(container.textContent).not.toContain(formatDenari(v));
    }
    expect(screen.queryByText(i18n.t('insights.returns.col.uncollected'))).toBeNull();
    expect(screen.queryByText(i18n.t('insights.returns.tile.uncollected'))).toBeNull();
    expect(screen.queryByText(i18n.t('insights.returns.tile.roundTrip'))).toBeNull();
    expect(screen.getByText(i18n.t('insights.returns.tile.parcels'))).toBeInTheDocument();
  });
});
