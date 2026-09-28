import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '@/i18n';
import { formatDenari } from '@/lib/currency';
import type { StockResponse } from '@/lib/insightsApi/returnsStock';
import { fmtInt } from '../overview/model';
import { dm } from '../overview/useOverviewFormat';
import sample from './__fixtures__/stock.sample.json';

// Insights → Products & stock rendered from the 01.09–27.09.2026 payload: the
// trust banner says the count is unverified (last count 06.08, ledger silent
// since 20.08) and hides days of cover / valuation, the queue opens exactly its
// orders by age, and a non-owner never sees a cost, a price or a stock value.
const h = vi.hoisted(() => ({ stock: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u-test', isAdmin: true, isManager: false } }),
}));
vi.mock('@/lib/insightsApi/returnsStock', async (orig) => {
  const m = await orig<typeof import('@/lib/insightsApi/returnsStock')>();
  return { ...m, apiGetInsightsStock: (...a: unknown[]) => h.stock(...a) };
});

beforeAll(async () => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  await i18n.changeLanguage('mk');
});

const { default: StockTab, stripStockMoney } = await import('./StockTab');

const S = () => structuredClone(sample) as unknown as StockResponse;
const WIN = 'range=custom&from=2026-09-01&to=2026-09-27';

function renderWith(p: StockResponse) {
  h.stock.mockReset();
  h.stock.mockResolvedValue(p);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/insights?tab=stock&${WIN}`]}>
        <StockTab />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const trustTitle = (s: StockResponse) => i18n.t('insights.stock.trust.title', { date: dm(s.trust.last_count!, true) });

describe('Products & stock — owner', () => {
  it('says the stock count is unverified and hides days of cover and the valuation', async () => {
    const s = S();
    const { container } = renderWith(s);
    expect(await screen.findByText(trustTitle(s), {}, { timeout: 10_000 })).toBeInTheDocument();
    expect(h.stock).toHaveBeenCalledWith({ from: '2026-09-01', to: '2026-09-27', compare: true, sources: [] }, expect.anything());
    expect(screen.queryByText(i18n.t('insights.stock.tile.valuation'))).toBeNull();
    expect(screen.queryByText(i18n.t('insights.stock.col.cover'))).toBeNull();
    // units sold, the queue and the not-tracked count are there
    expect(screen.getAllByText(fmtInt(s.kpis.units, 'mk')).length).toBeGreaterThan(0);
    expect(screen.getByText(i18n.t('insights.stock.queue.title'))).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/€|EUR\b/);
    // "out of stock" is never claimed while the count is unverified
    expect(screen.queryByText(i18n.t('insights.stock.state.out'))).toBeNull();
  });

  it('a queue age opens exactly the to-pack orders of those sale days', async () => {
    const s = S();
    renderWith(s);
    await screen.findByText(trustTitle(s), {}, { timeout: 10_000 });
    const pack = s.queue.find((q) => q.stage === 'to_pack')!;
    const age = pack.ages.find((a) => a.count > 0 && a.web === 0 && a.mex_only === 0)!;
    const link = screen.getAllByRole('link').find((a) => {
      const href = a.getAttribute('href') ?? '';
      return href.includes('cohort_bucket=to_pack') && href.includes(`sold_from=${age.from}`) && href.includes(`sold_to=${age.to}`);
    });
    expect(link).toBeDefined();
    expect(link!.textContent).toBe(fmtInt(age.count, 'mk'));
  });

  it('shows the catalogue hygiene: duplicates, unmapped names, no cost, non-product lines', async () => {
    const s = S();
    renderWith(s);
    await screen.findByText(trustTitle(s), {}, { timeout: 10_000 });
    for (const k of ['duplicates', 'unmapped', 'noCost', 'notProducts', 'notTracked']) {
      expect(screen.getByText(i18n.t(`insights.stock.hygiene.${k}`))).toBeInTheDocument();
    }
  });
});

describe('Products & stock — admin / manager (no money)', () => {
  it('never shows a cost, a price, a queue value or the valuation', async () => {
    const owner = S();
    const s = stripStockMoney(S());
    const { container } = renderWith(s);
    await screen.findByText(trustTitle(s), {}, { timeout: 10_000 });
    expect(screen.queryByText(i18n.t('insights.stock.col.cost'))).toBeNull();
    const costs = owner.products.map((p) => p.cost_mkd).filter((v): v is number => typeof v === 'number' && v > 0);
    for (const v of [...owner.queue.map((q) => q.value_mkd ?? 0).filter((v) => v > 0), ...costs.slice(0, 5)]) {
      expect(container.textContent).not.toContain(formatDenari(v));
    }
    expect((s as unknown as Record<string, unknown>).valuation).toBeUndefined();
  });
});
