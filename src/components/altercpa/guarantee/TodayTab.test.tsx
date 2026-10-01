import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '@/i18n';
import { DEFAULT_GUARANTEE_SETTINGS, buildToday, type OpenLeadRow, type RateRow } from '../../../../supabase/functions/api/altercpaGuarantee';

// Денес: the tiles, the cards in risk order with their one sentence, the open leads with their
// ages on the reader's clock, and the word "Отворени" — never "На чекање".
const h = vi.hoisted(() => ({ today: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
  apiGetAlterCpaWebmasters: vi.fn(async () => [
    { id: '1', account_id: 'a', wm_id: '3221', name: 'Fomikch' },
    { id: '2', account_id: 'a', wm_id: '2676', name: 'KMA.biz' },
    { id: '3', account_id: 'a', wm_id: '3223', name: 'ezaff.com' },
  ]),
}));
vi.mock('@/lib/altercpaGuaranteeApi', async (orig) => {
  const m = await orig<typeof import('@/lib/altercpaGuaranteeApi')>();
  return { ...m, apiGetGuaranteeToday: (p: unknown) => h.today(p) };
});

const NOW = new Date('2026-10-01T11:00:00Z'); // 13:00 in Skopje
beforeAll(async () => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  await i18n.changeLanguage('mk');
  vi.setSystemTime(NOW);
});
afterAll(() => { vi.useRealTimers(); });

const { TodayTab } = await import('./TodayTab');
const { useInsightsFormat } = await import('@/components/insights/shared/useInsightsFormat');

const row = (over: Partial<RateRow>): RateRow => ({
  grain: 'webmaster', day: '2026-10-01', webmaster: '3221', stream: null, offer_name: null, leads: 0, test_excluded: 0,
  approved: 0, cancel_other: 0, cancelled: 0, trashed: 0, open: 0, counted: 0, mex_shipped: 0, crm_sticky: 0, ...over,
});
const lead = (id: string, wm: string, at: string, over: Partial<OpenLeadRow> = {}): OpenLeadRow => ({
  lead_id: id, altercpa_id: id, day: '2026-10-01', arrived_at: at, webmaster: wm, stream: 'k6p672', offer_name: 'Adenofrin',
  customer_name: 'Ана П.', order_id: null, display_id: null, crm_status: null, mex_status_id: null, mex_tracking_id: null, ...over,
});

const payload = () => buildToday({
  day: '2026-10-01', today: '2026-10-01', back: 2, now: NOW, settings: DEFAULT_GUARANTEE_SETTINGS,
  freshness: { leads_seen_at: '2026-10-01T10:59:00Z', decisions_seen_at: '2026-10-01T10:56:00Z', newest_arrival_at: null },
  rates: [
    row({ grain: 'day', webmaster: null, leads: 157, test_excluded: 2, approved: 45, cancel_other: 5, cancelled: 58, trashed: 19, open: 30, counted: 50 }),
    row({ webmaster: '3221', leads: 90, approved: 28, cancel_other: 2, counted: 30, cancelled: 30, trashed: 10, open: 20 }), // met +3
    row({ webmaster: '2676', leads: 40, approved: 8, counted: 8, cancelled: 22, trashed: 7, open: 3 }),                     // unreachable
    row({ webmaster: '3223', leads: 27, approved: 9, cancel_other: 3, counted: 12, cancelled: 6, trashed: 2, open: 7 }),   // met +3
  ],
  open: [
    lead('a', '2676', '2026-10-01T06:30:00Z'),
    lead('b', '2676', '2026-10-01T09:50:00Z', { display_id: 'ORD-362061', crm_status: 'confirmed' }),
    lead('c', '3221', '2026-10-01T10:00:00Z'),
  ],
  stuckOpen: [lead('s', '3221', '2026-09-26T08:00:00Z', { day: '2026-09-26' })],
});

function Harness() {
  const f = useInsightsFormat();
  return <TodayTab f={f} />;
}
const wrap = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={['/altercpa']}><Harness /></MemoryRouter></QueryClientProvider>);
};

beforeEach(() => { h.today.mockReset(); h.today.mockResolvedValue(payload()); });

describe('TodayTab', { timeout: 30_000 }, () => {
  it('asks for today (Skopje) with two days back, and shows the tiles', async () => {
    wrap();
    expect(await screen.findByText('Отворени')).toBeInTheDocument();
    expect(h.today).toHaveBeenCalledWith({ day: '2026-10-01', back: 2 });
    expect(screen.getByText('До 30%')).toBeInTheDocument();
    expect(screen.getByText('+2 над целта')).toBeInTheDocument();
    expect(screen.getByText('Може да се откажат')).toBeInTheDocument();
    expect(screen.getByText('тест: 2 (не се бројат)')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/На чекање|рогноз/);
  });

  it('ages on the reader’s clock: the oldest open lead waited 4 ч 30 мин', async () => {
    wrap();
    expect(await screen.findByText('најстар: 4 ч 30 мин')).toBeInTheDocument();
  });

  it('cards in risk order — unreachable first, then the thinnest margin — each with one sentence', async () => {
    wrap();
    await screen.findByText('Отворени');
    const cards = screen.getAllByTestId('wm-card');
    expect(cards.map((c) => c.getAttribute('data-wm'))).toEqual(['2676', '3221', '3223']);
    expect(within(cards[0]).getByText('KMA.biz')).toBeInTheDocument();
    expect(within(cards[0]).getByTestId('wm-sentence')).toHaveTextContent('Недостижно со сегашните лидови: најмногу 27,5%');
    expect(within(cards[1]).getByTestId('wm-sentence')).toHaveTextContent('Над целта +3 · сите 20 отворени може да се откажат');
  });

  it('folds out the open leads: arrival, age, the CRM order and the "CRM потврдена — чека AlterCPA" flag', async () => {
    wrap();
    await screen.findByText('Отворени');
    const kma = screen.getAllByTestId('wm-card')[0];
    fireEvent.click(within(kma).getByRole('button', { name: 'Отворени лидови (3)' }));
    expect(within(kma).getAllByText('08:30').length).toBeGreaterThan(0);       // 06:30Z = 08:30 Skopje
    expect(within(kma).getAllByText('4 ч 30 мин').length).toBeGreaterThan(0);
    expect(within(kma).getAllByText('1 ч 10 мин').length).toBeGreaterThan(0);
    expect(within(kma).getAllByText('ORD-362061')[0].closest('a')).toHaveAttribute('href', '/orders?search=ORD-362061&view=all');
    expect(within(kma).getAllByText('CRM потврдена — чека AlterCPA').length).toBeGreaterThan(0);
  });

  it('stuck open leads link to Лидови filtered to the open ones', async () => {
    wrap();
    expect(await screen.findByText('Заглавени отворени: 1')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Прикажи ги' })).toHaveAttribute('href', '/altercpa?tab=leads&from=2026-09-26&to=2026-09-28&decision=open');
    expect(screen.getByText('Вчера · 30.09.2026')).toBeInTheDocument();
  });
});
