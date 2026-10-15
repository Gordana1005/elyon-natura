import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '@/i18n';
import { formatDenari } from '@/lib/currency';
import type { Cohort, CohortSourceRow } from '../shared/cohortTypes';
import { useInsightsFormat } from '../shared/useInsightsFormat';
import cohortSample from '../shared/__fixtures__/cohort.sample.json';
import type { OriginOrders } from '@/lib/insightsApi/originOrders';

// A tile on the Teleshop Out card opens EXACTLY the rows it counts (owner 15.10.2026: "ЦРМ + collab"):
// CRM orders link to /orders, a collabBox booking shows its document number, the sum is the tile's.
const h = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/lib/insightsApi/originOrders', async (orig) => ({
  ...(await orig<typeof import('@/lib/insightsApi/originOrders')>()),
  apiGetOriginOrders: (...a: unknown[]) => h.get(...a),
}));

beforeAll(async () => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  await i18n.changeLanguage('mk');
});
const t = i18n.t.bind(i18n);
const { CohortSources } = await import('./CohortSources');

const payload = (money: boolean): OriginOrders => ({
  meta: { from: '2026-09-22', to: '2026-09-28', source: 'teleshop_out', origin: 'bio_natural', money, count: 2, truncated: false },
  rows: [
    { kind: 'order', sale_day: '2026-09-28', bucket: 'paid', display_id: 'ORD-367109', customer: 'Едвина Абдиева', phone: '+38975440964',
      seller: 'Милјана Тодоровска', products: '4× КУРКУМА АКТИВ', first_src: 'lead', first_day: '2025-12-02', ...(money ? { value_mkd: 2000 } : {}) },
    { kind: 'booking', sale_day: '2026-09-27', bucket: 'to_pack', display_id: '002-9102-179079/2026', customer: 'МАЦА ВУЛЕТИЧ', phone: '…70111222',
      seller: 'Тамара Радович', products: '4× БРОНХО ПРОТЕКТ 500ml', first_src: 'doc', first_day: '2025-05-01', ...(money ? { value_mkd: 4700 } : {}) },
  ],
});

function Cards({ money = true }: { money?: boolean }) {
  const f = useInsightsFormat();
  const rows = structuredClone((cohortSample as unknown as Cohort).by_source) as CohortSourceRow[];
  const total = rows.reduce((a, x) => ({ ...a, count: a.count + x.total.count }), { count: 0, value_mkd: null, cod_mkd: null });
  return <CohortSources rows={rows} total={total} leadsTotal={null} money={money} range={{ from: '2026-09-22', to: '2026-09-28' }} f={f} />;
}
function renderCards(money = true) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter><Cards money={money} /></MemoryRouter></QueryClientProvider>);
}

describe('the orders behind an origin tile', { timeout: 30_000 }, () => {
  it('owner: the tile opens CRM + collabBox rows, the order links to /orders, the sum shows', async () => {
    h.get.mockResolvedValue(payload(true));
    renderCards();
    const tile = screen.getAllByTestId('origin-tile-bio_natural')[1];               // [0] Affiliate Out, [1] Teleshop Out
    fireEvent.click(tile);
    expect(h.get).toHaveBeenCalledWith({ from: '2026-09-22', to: '2026-09-28', source: 'teleshop_out', origin: 'bio_natural' });
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByText(`${t('insights.common.source.teleshop_out')} · ${t('overview.cohort.origin.key.bio_natural')}`)).toBeInTheDocument();
    const link = (await within(dlg).findAllByRole('link', { name: 'ORD-367109' }))[0];
    expect(link).toHaveAttribute('href', '/orders?search=ORD-367109');
    expect(within(dlg).getAllByText('002-9102-179079/2026').length).toBeGreaterThan(0);
    expect(within(dlg).getAllByText(t('overview.cohort.origin.drill.kind.booking')).length).toBeGreaterThan(0);
    expect(within(dlg).getByTestId('origin-drill-summary').textContent).toContain(formatDenari(6700));
    // search narrows to one row
    fireEvent.change(within(dlg).getByRole('textbox', { name: t('overview.cohort.origin.drill.search') }), { target: { value: 'вулетич' } });
    expect(within(dlg).getByTestId('origin-drill-summary').textContent).toContain(formatDenari(4700));
    expect(within(dlg).queryAllByRole('link', { name: 'ORD-367109' })).toHaveLength(0);
  });

  it('counted (no money): the same rows, not one denar', async () => {
    h.get.mockResolvedValue(payload(false));
    renderCards(false);
    fireEvent.click(screen.getAllByTestId('origin-tile-bio_natural')[1]);
    const dlg = await screen.findByRole('dialog');
    await within(dlg).findAllByRole('link', { name: 'ORD-367109' });
    expect(dlg.textContent).not.toMatch(/\d ден(?![а-яѓќљњџѕ])/);
  });
});
