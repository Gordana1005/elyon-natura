import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '@/i18n';
import { formatDenari } from '@/lib/currency';
import type { ShopDetail, ShopsDay, ShopsDeliveries, ShopsHealth, ShopsPeriod, ShopsStockMatrix } from '@/lib/shopsTypes';
import { stripShopsMoney } from '@/components/shops/shopsModel';
import dayFx from '@/components/shops/__fixtures__/day.owner.json';
import periodFx from '@/components/shops/__fixtures__/period.owner.json';
import detailFx from '@/components/shops/__fixtures__/detail.owner.json';
import matrixFx from '@/components/shops/__fixtures__/matrix.owner.json';
import deliveriesFx from '@/components/shops/__fixtures__/deliveries.owner.json';
import healthFx from '@/components/shops/__fixtures__/health.owner.json';

// /shops "Продавници" rendered from fixtures in the exact src/lib/shopsTypes.ts shapes: the owner
// payload (every *_mkd key) and the manager payload (none) — the page shows a money figure only
// when its key arrived. Tabs, period and filters come from the URL. The network is the mocked
// @/lib/shopsApi; the clock is fixed at 02.10.2026 14:20 Skopje.

vi.mock('@/layouts/AppLayout', () => ({
  AppLayout: ({ title, children }: { title: string; children: React.ReactNode }) => <div><h1>{title}</h1>{children}</div>,
}));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));

type Who = 'owner' | 'manager' | 'agent';
const who = vi.hoisted(() => ({ role: 'owner' as 'owner' | 'manager' | 'agent' }));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: {
      id: 'me', isAdmin: who.role === 'owner', isManager: who.role === 'manager',
      isExternalAffiliate: false, roles: [who.role === 'owner' ? 'admin' : who.role === 'manager' ? 'manager' : 'agent'],
    },
  }),
}));
vi.mock('@/contexts/PermissionsContext', () => ({
  usePermissions: () => ({ canSeeBusiness: who.role === 'owner', canAccessModule: () => true, isModuleEnabled: () => true }),
}));

const api = vi.hoisted(() => ({
  day: vi.fn(), period: vi.fn(), shop: vi.fn(), matrix: vi.fn(), deliveries: vi.fn(), health: vi.fn(),
}));
vi.mock('@/lib/shopsApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/shopsApi')>()),
  apiGetShopsDay: (...a: unknown[]) => api.day(...a),
  apiGetShopsPeriod: (...a: unknown[]) => api.period(...a),
  apiGetShop: (...a: unknown[]) => api.shop(...a),
  apiGetShopsStockMatrix: (...a: unknown[]) => api.matrix(...a),
  apiGetShopsDeliveries: (...a: unknown[]) => api.deliveries(...a),
  apiGetShopsHealth: (...a: unknown[]) => api.health(...a),
}));

const NOW = new Date('2026-10-02T12:20:00Z'); // 14:20 Skopje
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  await i18n.changeLanguage('mk');
});
afterAll(() => { vi.useRealTimers(); });
afterEach(() => { vi.clearAllMocks(); });

const { default: ShopsPage } = await import('./ShopsPage');

const pay = <T,>(v: unknown, role: Who): T => (role === 'owner' ? structuredClone(v) : stripShopsMoney(structuredClone(v))) as T;

function setup(url: string, role: Who = 'owner') {
  who.role = role;
  api.day.mockImplementation((day: string) => Promise.resolve(pay<ShopsDay>({ ...dayFx, day, live: day === '2026-10-02' }, role)));
  api.period.mockImplementation((from: string, to: string) => Promise.resolve(pay<ShopsPeriod>({ ...periodFx, from, to }, role)));
  api.shop.mockImplementation(() => Promise.resolve(pay<ShopDetail>(detailFx, role)));
  api.matrix.mockImplementation(() => Promise.resolve(pay<ShopsStockMatrix>(matrixFx, role)));
  api.deliveries.mockImplementation((p: { shop?: string | null }) => {
    const d = pay<ShopsDeliveries>(deliveriesFx, role);
    return Promise.resolve({ ...d, rows: d.rows.filter((r) => !p.shop || r.shop.code === p.shop) });
  });
  api.health.mockImplementation(() => Promise.resolve(pay<ShopsHealth>(healthFx, role)));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}><ShopsPage /></MemoryRouter>
    </QueryClientProvider>,
  );
}

const D = dayFx as unknown as ShopsDay;
const P = periodFx as unknown as ShopsPeriod;
const T = (k: string, o?: Record<string, unknown>) => i18n.t(k, o) as string;
const MONEY_TEXT = /\d ден(?![а-ш])/;

describe('access', () => {
  it('an agent sees the no-access screen and nothing is fetched', () => {
    setup('/shops', 'agent');
    expect(screen.getByText(T('shops.noAccess'))).toBeInTheDocument();
    expect(api.day).not.toHaveBeenCalled();
  });
  it('a manager has every tab except Здравје; ?tab=health falls back to Денес / Период', async () => {
    setup('/shops?tab=health', 'manager');
    await screen.findByTestId('shops-day-tab', {}, { timeout: 10_000 });
    expect(screen.queryByRole('tab', { name: T('shops.tabs.health') })).toBeNull();
    for (const k of ['day', 'ranking', 'shop', 'stock', 'deliveries']) {
      expect(screen.getByRole('tab', { name: T(`shops.tabs.${k}`) })).toBeInTheDocument();
    }
    expect(api.health).not.toHaveBeenCalled();
  });
});

describe('Денес / Период', () => {
  it('owner, today: live, the Skopje day, money tiles, the shops by sales', async () => {
    setup('/shops');
    const tab = await screen.findByTestId('shops-day-tab', {}, { timeout: 10_000 });
    expect(api.day).toHaveBeenCalledWith('2026-10-02', expect.anything());
    expect(screen.getByText(T('shops.live'))).toBeInTheDocument();
    const kpis = within(tab).getByTestId('shops-kpis');
    expect(within(kpis).getByText(formatDenari(D.totals.sales_mkd))).toBeInTheDocument();
    expect(within(kpis).getByText(T('shops.kpi.groupMargin'))).toBeInTheDocument();
    expect(within(kpis).getByText(T('shops.kpi.shopsOpenOf', { n: '22' }))).toBeInTheDocument();
    // the freshness line: "сметки пред 6 мин · залиха од 23:30"
    const fresh = within(tab).getByTestId('shops-freshness');
    expect(fresh.textContent).toContain(T('shops.fresh.sales', { ago: T('overview.ago.min', { n: 6 }) }));
    expect(fresh.textContent).toContain(T('shops.fresh.stock', { time: '23:30' }));
    // sorted by sales: the first card is the best seller of the day
    const cards = within(tab).getByTestId('shops-cards');
    const best = [...D.shops].sort((a, b) => (b.sales_mkd ?? 0) - (a.sales_mkd ?? 0))[0];
    expect(within(cards).getAllByRole('listitem')[0].textContent).toContain(best.shop.name);
    // the shop with no receipts says so; the control is "not yet" on a live day
    expect(within(cards).getAllByText(T('shops.list.noReceipts')).length).toBeGreaterThan(0);
    expect(within(cards).getAllByText(T('shops.control.pending')).length).toBe(D.shops.length);
    expect(tab.textContent).not.toMatch(/€|EUR\b|shops\./);
  }, 30_000);

  it('manager, today: the same page counted — not one денар, sorted by units', async () => {
    setup('/shops', 'manager');
    const tab = await screen.findByTestId('shops-day-tab', {}, { timeout: 10_000 });
    const kpis = within(tab).getByTestId('shops-kpis');
    expect(within(kpis).queryByText(T('shops.kpi.sales'))).toBeNull();
    expect(within(kpis).queryByText(T('shops.kpi.cashCard'))).toBeNull();
    expect(within(kpis).getByText(T('shops.kpi.units'))).toBeInTheDocument();
    expect(tab.textContent).not.toMatch(MONEY_TEXT);
    expect(screen.queryByRole('button', { name: T('shops.list.bySales') })).toBeNull();
    const best = [...D.shops].sort((a, b) => b.units - a.units)[0];
    expect(within(within(tab).getByTestId('shops-cards')).getAllByRole('listitem')[0].textContent).toContain(best.shop.name);
  }, 30_000);

  it('a period in the URL asks shops/period and shows Натура → продавници (units for managers)', async () => {
    setup('/shops?range=custom&from=2026-09-01&to=2026-09-30', 'manager');
    const tab = await screen.findByTestId('shops-day-tab', {}, { timeout: 10_000 });
    expect(api.period).toHaveBeenCalledWith('2026-09-01', '2026-09-30', expect.anything());
    expect(api.day).not.toHaveBeenCalled();
    expect(screen.queryByText(T('shops.live'))).toBeNull();
    expect(within(tab).getByText(T('shops.natura.title'))).toBeInTheDocument();
    expect(within(tab).getByText('18.420')).toBeInTheDocument();
    expect(within(tab).queryByText(T('shops.natura.margin'))).toBeNull();
    expect(tab.textContent).not.toMatch(MONEY_TEXT);
  }, 30_000);

  it('owner, period: our margin and the TV re-invoicing apart', async () => {
    setup('/shops?range=custom&from=2026-09-01&to=2026-09-30');
    const tab = await screen.findByTestId('shops-day-tab', {}, { timeout: 10_000 });
    expect(within(tab).getByText(formatDenari(P.natura.natura_margin_mkd))).toBeInTheDocument();
    expect(within(tab).getByText(T('shops.natura.ads'))).toBeInTheDocument();
    expect(within(tab).getByText(formatDenari(P.natura.ads_reinvoiced_ex_vat_mkd))).toBeInTheDocument();
    // a period's control is decided: Сити Мол's mismatch shows
    expect(within(tab).getAllByText(T('shops.control.diff')).length).toBeGreaterThan(0);
  }, 30_000);

  it('← steps back one day', async () => {
    setup('/shops');
    await screen.findByTestId('shops-day-tab', {}, { timeout: 10_000 });
    fireEvent.click(screen.getByRole('button', { name: T('insights.common.period.prevDay') }));
    await screen.findByText('01.10.2026');
    expect(api.day).toHaveBeenCalledWith('2026-10-01', expect.anything());
  }, 30_000);

  it('a failed fetch says so with a retry; "forbidden" in words', async () => {
    who.role = 'owner';
    api.day.mockRejectedValue(new Error('forbidden'));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={['/shops']}><ShopsPage /></MemoryRouter></QueryClientProvider>);
    expect(await screen.findByText(T('shops.forbidden'), {}, { timeout: 10_000 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: T('common.retry') })).toBeInTheDocument();
  }, 30_000);

  it('no shops yet (reader off): an empty state, not a blank table', async () => {
    who.role = 'owner';
    api.day.mockResolvedValue({ ...structuredClone(dayFx), shops: [], hourly: [] });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={['/shops']}><ShopsPage /></MemoryRouter></QueryClientProvider>);
    expect(await screen.findByText(T('shops.list.empty'), {}, { timeout: 10_000 })).toBeInTheDocument();
    expect(screen.getByText(T('shops.chart.empty'))).toBeInTheDocument();
  }, 30_000);
});

describe('Продавници (ranking)', () => {
  it('sort=units in the URL ranks by units; owners can rank by money, managers cannot', async () => {
    setup('/shops?tab=ranking&range=custom&from=2026-09-01&to=2026-09-30&sort=units');
    const tab = await screen.findByTestId('shops-ranking-tab', {}, { timeout: 10_000 });
    const best = [...P.shops].sort((a, b) => b.units - a.units)[0];
    const first = within(within(tab).getByTestId('shops-cards')).getAllByRole('listitem')[0];
    expect(first.textContent).toContain(best.shop.name);
    const chips = within(tab).getByRole('group', { name: T('shops.ranking.metric') });
    expect(within(chips).getByRole('button', { name: T('shops.metric.shopMargin') })).toBeInTheDocument();
    expect(within(chips).getByRole('button', { name: T('shops.metric.units') })).toHaveAttribute('aria-pressed', 'true');
    // the shop opens its detail with the period kept
    const link = within(first).getAllByRole('link')[0];
    expect(link.getAttribute('href')).toBe(`/shops?tab=shop&range=custom&from=2026-09-01&to=2026-09-30&shop=${best.shop.code}`);
  }, 30_000);

  it('manager: no money metric to rank by, sales in the URL falls back to units', async () => {
    setup('/shops?tab=ranking&range=month&sort=sales_mkd', 'manager');
    const tab = await screen.findByTestId('shops-ranking-tab', {}, { timeout: 10_000 });
    const chips = within(tab).getByRole('group', { name: T('shops.ranking.metric') });
    expect(within(chips).queryByRole('button', { name: T('shops.metric.sales') })).toBeNull();
    expect(within(chips).queryByRole('button', { name: T('shops.metric.shopMargin') })).toBeNull();
    expect(within(chips).getByRole('button', { name: T('shops.metric.units') })).toHaveAttribute('aria-pressed', 'true');
    expect(tab.textContent).not.toMatch(MONEY_TEXT);
  }, 30_000);
});

describe('Продавница (detail)', () => {
  it('no shop picked: a picker, nothing fetched for a shop', async () => {
    setup('/shops?tab=shop');
    await screen.findByTestId('shops-detail-pick', {}, { timeout: 10_000 });
    expect(api.shop).not.toHaveBeenCalled();
    expect(await screen.findByRole('link', { name: /Карпош/ })).toBeInTheDocument();
  }, 30_000);

  it('?shop=003&zero=1: the shop, its basis in words, only the empty shelves', async () => {
    setup('/shops?tab=shop&shop=003&range=custom&from=2026-09-01&to=2026-09-30&zero=1');
    const tab = await screen.findByTestId('shops-detail-tab', {}, { timeout: 10_000 });
    await within(tab).findByText(T('shops.detail.byArticle'), {}, { timeout: 10_000 });
    expect(api.shop).toHaveBeenCalledWith('003', { from: '2026-09-01', to: '2026-09-30', at: null }, expect.anything());
    expect(within(tab).getByTestId('shops-stock-basis').textContent).toContain(T('shops.detail.basis', { at: '01.10 23:30', count: 14 }));
    const zeroRows = (detailFx as unknown as ShopDetail).stock.filter((r) => r.qty <= 0);
    expect(within(tab).getByRole('button', { name: new RegExp(T('shops.detail.onlyZero', { n: zeroRows.length }).replace(/[()]/g, '\\$&')) })).toHaveAttribute('aria-pressed', 'true');
    // goods in with Natura's invoice number, signed units
    expect(within(tab).getAllByText('04-01101').length).toBeGreaterThan(0);
    expect(within(tab).getAllByText('+186').length).toBeGreaterThan(0);
    expect(within(tab).getAllByText(T('shops.detail.zeroTop')).length).toBeGreaterThan(0);
    // owners see the stock value
    expect(tab.textContent).toContain(T('shops.detail.valueCost', { value: formatDenari((detailFx as unknown as ShopDetail).stock_totals.value_cost_mkd) }));
  }, 30_000);

  it('manager: the same detail without a денар', async () => {
    setup('/shops?tab=shop&shop=003&range=month', 'manager');
    const tab = await screen.findByTestId('shops-detail-tab', {}, { timeout: 10_000 });
    await within(tab).findByText(T('shops.detail.byArticle'), {}, { timeout: 10_000 });
    expect(tab.textContent).not.toMatch(MONEY_TEXT);
    expect(within(tab).queryByText(T('shops.detail.colValueCost'))).toBeNull();
  }, 30_000);
});

describe('Залиха низ продавници', () => {
  it('Latin search finds the Cyrillic article; the zeros of top sellers are red', async () => {
    setup('/shops?tab=stock&q=kurkum');
    const tab = await screen.findByTestId('shops-matrix-tab', {}, { timeout: 10_000 });
    expect(api.matrix).toHaveBeenCalledWith({ at: null }, expect.anything());
    const cards = within(tab).getByTestId('shops-matrix-cards');
    expect(within(cards).getAllByRole('listitem').filter((li) => li.parentElement === cards)).toHaveLength(1);
    expect(cards.textContent).toContain('Куркумактив 500 мл');
    expect(within(tab).getByText(T('shops.matrix.count', { shown: '1', total: '45' }))).toBeInTheDocument();
  }, 30_000);

  it('brand + "top sellers with a 0" from the URL', async () => {
    setup('/shops?tab=stock&brand=Bio%20Natural&gaps=1');
    const tab = await screen.findByTestId('shops-matrix-tab', {}, { timeout: 10_000 });
    const cards = within(tab).getByTestId('shops-matrix-cards');
    const items = within(cards).getAllByRole('listitem').filter((li) => li.parentElement === cards);
    expect(items.length).toBeGreaterThan(0);
    for (const li of items) {
      expect(li.textContent).toContain('Bio Natural');
      expect(li.textContent).toContain(T('shops.matrix.top'));
    }
  }, 30_000);
});

describe('Испорачано од Натура', () => {
  it('shop + in transit from the URL; managers see units, no value', async () => {
    setup('/shops?tab=deliveries&range=custom&from=2026-09-01&to=2026-09-30&shop=003&transit=1', 'manager');
    const tab = await screen.findByTestId('shops-deliveries-tab', {}, { timeout: 10_000 });
    expect(api.deliveries).toHaveBeenCalledWith({ from: '2026-09-01', to: '2026-09-30', shop: '003' }, expect.anything());
    expect(within(tab).getAllByText(T('shops.deliveries.transit')).length).toBeGreaterThan(0);
    expect(within(tab).queryAllByText(T('shops.deliveries.received'))).toHaveLength(0);
    expect(within(tab).queryByText(T('shops.deliveries.value'))).toBeNull();
    expect(tab.textContent).not.toMatch(MONEY_TEXT);
  }, 30_000);
});

describe('Здравје', () => {
  it('owner: the reader, the backfill, the controls and every anomaly kind in words', async () => {
    setup('/shops?tab=health');
    const tab = await screen.findByTestId('shops-health-tab', {}, { timeout: 10_000 });
    expect(within(tab).getByText(T('shops.health.enabled'))).toBeInTheDocument();
    expect(within(tab).getByText(T('shops.health.progress', { pct: '71%' }))).toBeInTheDocument();
    const list = within(tab).getByTestId('shops-anomalies');
    for (const a of (healthFx as unknown as ShopsHealth).anomalies) {
      expect(within(list).getByText(T(`shops.anomaly.${a.kind}`))).toBeInTheDocument();
    }
    expect(within(list).getByText(`−${formatDenari(5440000)}`)).toBeInTheDocument();
    expect(screen.queryByText(T('insights.common.period.today'))).toBeNull(); // no period bar here
  }, 30_000);
});

describe('i18n — the keys the page builds at runtime exist in every language', () => {
  it('anomaly kinds, control states, metrics, feeds, statuses, tabs', () => {
    const keys = [
      ...['no_receipts_by_11', 'cost_above_sales', 'big_transfer', 'big_return', 'zero_top_seller', 'delivery_not_received', 'control_mismatch'].map((k) => `shops.anomaly.${k}`),
      ...['ok', 'diff', 'pending'].flatMap((k) => [`shops.control.${k}`, `shops.control.${k}Hint`]),
      ...['sales', 'units', 'receipts', 'avgReceipt', 'shopMargin', 'groupMargin', 'returns', 'vsAvg'].map((k) => `shops.metric.${k}`),
      ...['sales', 'docs', 'stock', 'reader'].map((k) => `shops.health.feed.${k}`),
      ...['ok', 'error', 'failed', 'running', 'partial', 'skipped', 'locked'].map((k) => `shops.health.status.${k}`),
      ...['day', 'ranking', 'shop', 'stock', 'deliveries', 'health'].map((k) => `shops.tabs.${k}`),
      'nav.shops',
    ];
    for (const lng of ['mk', 'en', 'sq']) {
      const missing = keys.filter((k) => !i18n.exists(k, { lng }));
      expect(missing, lng).toEqual([]);
    }
  });
});
