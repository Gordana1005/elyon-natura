import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import i18n from '@/i18n';
import { formatDenari } from '@/lib/currency';

// Render test for the TV board v2 (migration 20260942001200, GET
// /api/leaderboard?v=2): one row per agent with a chip per department, the
// collabBox bookings apart, managers at the end without a rank, the filter bar —
// and the OLD per-mode response a TV may still get while the api is redeployed.
const channel = { on: () => channel, subscribe: () => channel };
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { channel: () => channel, removeChannel: vi.fn() },
}));

beforeAll(async () => { await i18n.changeLanguage('mk'); });
afterEach(() => { vi.unstubAllGlobals(); });

const { default: TvLeaderboardPage } = await import('./TvLeaderboardPage');

const now = new Date();
const presence = (state: string, extra = {}) => ({
  state, online_min: 0, active_min: 0, idle_min: 0, break_min: 0, first_seen: null, last_seen: null,
  first_active: null, last_active: null, idle_alerts: 0, idle_streak_min: null, first_login: null, ...extra,
});
const cell = (over = {}) => ({
  sales: 0, value_mkd: 0, booked: 0, booked_value_mkd: 0, booked_twin: 0, booked_twin_value_mkd: 0,
  cancelled_after_sale: 0, cancelled_value_mkd: 0, returned: 0, live_credited: 0, worked: 0, sale_decisions: 0, ...over,
});
const base = {
  user_id: null, team_key: null, team_name: null, is_member: true, is_manager: false, rank: null, sales: 0, value_mkd: 0,
  booked: 0, booked_value_mkd: 0, total_count: 0, total_value_mkd: 0, cancelled_after_sale: 0, cancelled_value_mkd: 0,
  returned: 0, live_credited: 0, booked_twin: 0, booked_twin_value_mkd: 0, worked: 0, sale_decisions: 0, cancelled: 0,
  trashed: 0, callbacks: 0, conversion: null, last_decision_at: null, departments: {}, presence: presence('offline'),
};

const v2 = {
  version: 2, day: '2026-09-28', today: '2026-09-28', is_today: true, generated_at: now.toISOString(), money: true,
  window: null, filter: { department: null, team: null },
  departments: ['altercpa', 'elyon_crm', 'teleshop_out', 'teleshop_other', 'social', 'web'],
  teams: [
    { key: 'altercpa_leads', name: 'Pending — AlterCPA leads', people: 1 },
    { key: 'crm_prediction', name: 'Prediction — ElyonCRM', people: 2 },
    { key: 'management', name: 'Management', people: 1 },
  ],
  summary: {
    people: 4, members: 4, managers: 1, ranked: 2, online_now: 1, idle: 0, on_break: 0, offline: 2, no_login: 1, was_online: 1,
    zero_sale_people: 1, worked: 100, sale_decisions: 25, sales: 13, value_mkd: 36400, booked: 23, booked_value_mkd: 51900,
    total_count: 36, total_value_mkd: 88300, cancelled_after_sale: 1, returned: 0, live_credited: 0, booked_twin: 0,
    booked_twin_value_mkd: 0, no_seller: 2, no_seller_value_mkd: 5000, booked_no_person: 0,
  },
  day_totals: {},
  rows: [
    { ...base, person_id: 'p1', name: 'Татјана Кипровска', team_key: 'crm_prediction', rank: 1, booked: 23, booked_value_mkd: 51900,
      total_count: 23, total_value_mkd: 51900, presence: presence('n/a'),
      departments: { teleshop_other: cell({ booked: 23, booked_value_mkd: 51900 }) } },
    { ...base, person_id: 'p2', user_id: 'u2', name: 'Aleksandra Hristoska', team_key: 'altercpa_leads', rank: 2, sales: 10,
      value_mkd: 44980, total_count: 10, total_value_mkd: 44980, cancelled_after_sale: 1, worked: 31, sale_decisions: 11,
      conversion: 0.3548, presence: presence('online', { online_min: 312, active_min: 280, idle_min: 20, break_min: 12 }),
      departments: { altercpa: cell({ sales: 10, value_mkd: 44980, worked: 31, sale_decisions: 11 }) } },
    { ...base, person_id: 'p3', user_id: 'u3', name: 'Marija Temelkovska', team_key: 'crm_prediction' },
    { ...base, person_id: 'p4', user_id: 'u4', name: 'Nina', team_key: 'management', is_manager: true, sales: 3, value_mkd: 8400,
      total_count: 3, total_value_mkd: 8400, departments: { altercpa: cell({ sales: 3, value_mkd: 8400 }) } },
  ],
};

const legacy = {
  generated_at: now.toISOString(), mode: 'prediction', day: '2026-09-22', today: '2026-09-22', is_today: true,
  target: 4000, team_revenue: 1692.71, team_target_pct: 42.3, team_target_bonus: 10,
  agents: [{ user_id: 'u9', full_name: 'Ruzhica Parizovska', is_super: false, rank: 1, confirmed_count: 5, packages: 5,
    avg_order_value: 47, revenue: 235.77, target_pct: 0, sold_rate: 0, calls: 0, bonus: 34, bonus_breakdown: {} }],
};

function serve(payload: unknown) {
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => payload }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const renderAt = (url: string) => render(<MemoryRouter initialEntries={[url]}><TvLeaderboardPage /></MemoryRouter>);

describe('TV leaderboard v2', () => {
  it('one row per agent: department chips, bookings, rank, managers last', async () => {
    const fetchMock = serve(v2);
    renderAt('/tv/leaderboard?key=k');
    expect(await screen.findByText('Aleksandra Hristoska')).toBeInTheDocument();
    const rows = screen.getAllByTestId('tv-row');
    expect(rows.map((r) => within(r).queryByText(/^(Татјана|Aleksandra|Marija|Nina)/)?.textContent)).toEqual([
      'Татјана Кипровска', 'Aleksandra Hristoska', 'Marija Temelkovska', 'Nina',
    ]);
    // the department chip: "Aff. in 10 · 44.980 ден"
    expect(within(rows[1]).getByTestId('chip-altercpa').textContent)
      .toBe(i18n.t('leaderboard2.chip', { dept: i18n.t('leaderboard2.deptShort.altercpa'), n: 10, value: formatDenari(44980) }));
    // a teleshop caller's day is her collabBox bookings: "Тел. in +23 чекаат пратка · 51.900 ден"
    expect(within(rows[0]).getByTestId('chip-booked-teleshop_other').textContent)
      .toBe(i18n.t('leaderboard2.bookedChip', { dept: i18n.t('leaderboard2.deptShort.teleshopOther'), n: 23, value: formatDenari(51900) }));
    expect(within(rows[0]).getByText('1')).toBeInTheDocument();                    // rank 1
    // managers: after the heading, no rank
    expect(screen.getByText(i18n.t('leaderboard2.managersHeading'))).toBeInTheDocument();
    expect(within(rows[3]).queryByText('4')).toBeNull();
    // KPIs: total incl. bookings, value in денари, the sales nobody is credited with
    expect(screen.getByText('36')).toBeInTheDocument();
    expect(screen.getByText(formatDenari(88300))).toBeInTheDocument();
    expect(screen.getByText(`2 · ${formatDenari(5000)}`)).toBeInTheDocument();
    expect(screen.getByText(i18n.t('leaderboard2.convShort', { pct: '35.5' }))).toBeInTheDocument();
    const url = new URL(String((fetchMock.mock.calls[0] as unknown[])[0]));
    expect(url.searchParams.get('v')).toBe('2');
    expect(url.searchParams.get('department')).toBeNull();
  });

  it('the filter bar asks for a department; an old ?mode= URL opens its team', async () => {
    const fetchMock = serve(v2);
    renderAt('/tv/leaderboard?key=k&mode=pending');
    await screen.findByText('Aleksandra Hristoska');
    expect(new URL(String((fetchMock.mock.calls[0] as unknown[])[0])).searchParams.get('team')).toBe('altercpa_leads');
    fireEvent.click(screen.getByRole('button', { name: i18n.t('leaderboard2.deptShort.teleshopOther') }));
    await vi.waitFor(() => {
      const last = new URL(String((fetchMock.mock.calls.at(-1) as unknown[])[0]));
      expect(last.searchParams.get('department')).toBe('teleshop_other');
      expect(last.searchParams.get('team')).toBe('altercpa_leads');
    });
  });

  it('a phone gets one card per person: nothing cut, the same chips, managers last', async () => {
    // below 1024 px (Tailwind lg) the board is a scrolling list of cards
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('max-width: 1023px'), media: query, onchange: null,
      addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    }));
    serve(v2);
    renderAt('/tv/leaderboard?key=k');
    expect(await screen.findByText('Aleksandra Hristoska')).toBeInTheDocument();
    expect(screen.queryAllByTestId('tv-row')).toHaveLength(0);
    const cards = screen.getAllByTestId('tv-card');
    expect(cards).toHaveLength(4);
    expect(within(cards[1]).getByTestId('chip-altercpa').textContent)
      .toBe(i18n.t('leaderboard2.chip', { dept: i18n.t('leaderboard2.deptShort.altercpa'), n: 10, value: formatDenari(44980) }));
    expect(within(cards[0]).getByTestId('chip-booked-teleshop_other').textContent)
      .toBe(i18n.t('leaderboard2.bookedChip', { dept: i18n.t('leaderboard2.deptShort.teleshopOther'), n: 23, value: formatDenari(51900) }));
    expect(within(cards[1]).getByText(formatDenari(44980))).toBeInTheDocument();   // the card's total
    expect(within(cards[0]).getByText('1')).toBeInTheDocument();                    // rank 1
    expect(screen.getByText(i18n.t('leaderboard2.managersHeading'))).toBeInTheDocument();
    expect(screen.queryByText(i18n.t('leaderboard2.colDepartments'))).toBeNull();   // no table header
  });

  it('the Web filter shows the shop itself, live — it has no agents', async () => {
    serve({
      ...v2, filter: { department: 'web', team: null }, rows: [], summary: { people: 0 },
      web_live: {
        day: '2026-09-28', orders: 8, value_mkd: 13310, all_orders: 17, card: 1, cod: 7,
        by_outcome: [{ key: 'awaiting', count: 7, value_mkd: 14250 }, { key: 'preparing', count: 8, value_mkd: 13310 },
          { key: 'card_unpaid', count: 2, value_mkd: 4000 }],
        latest: [
          { at: now.toISOString(), number: 'NTMK62512', city: 'Демир Капија', total_mkd: 2000, outcome: 'card_unpaid',
            payment: 'card', counted: false, source: 'facebook', item: 'Magnesium Bisglycinate', items: 3 },
          { at: now.toISOString(), number: 'NTMK62511', city: 'Скопје', total_mkd: 1490, outcome: 'preparing',
            payment: 'cod', counted: true, source: 'google', item: 'Neurofix', items: 1 },
        ],
        last_order_at: now.toISOString(), synced_at: now.toISOString(),
      },
    });
    renderAt('/tv/leaderboard?key=k&dept=web');
    const panel = await screen.findByTestId('tv-web-live');
    const salesTile = within(panel).getByText(i18n.t('tvBoard.web.sales')).parentElement as HTMLElement;
    expect(within(salesTile).getByText('8')).toBeInTheDocument();                 // = the Overview's web number
    expect(within(panel).getByText(formatDenari(13310))).toBeInTheDocument();
    expect(within(panel).getByText('17')).toBeInTheDocument();                    // every order of the day
    expect(screen.getByTestId('web-outcome-awaiting').textContent).toContain(i18n.t('tvBoard.web.outcome.awaiting'));
    expect(screen.getAllByTestId('tv-web-order')).toHaveLength(2);
    expect(screen.getByText('Magnesium Bisglycinate')).toBeInTheDocument();
    expect(screen.getByText(i18n.t('tvBoard.web.notCounted'))).toBeInTheDocument(); // the unpaid card
    expect(screen.queryByText(i18n.t('leaderboard2.noPeople'))).toBeNull();
  });

  it('still renders the old per-mode board while the api is being redeployed', async () => {
    serve(legacy);
    renderAt('/tv/leaderboard?key=k');
    expect(await screen.findByText('Ruzhica Parizovska')).toBeInTheDocument();
    expect(screen.getByText(i18n.t('leaderboard2.legacyApi'))).toBeInTheDocument();
    expect(screen.getByTestId('chip-elyon_crm').textContent)
      .toBe(i18n.t('leaderboard2.chip', { dept: i18n.t('leaderboard2.deptShort.elyon_crm'), n: 5, value: formatDenari(14500) }));
  });
});
