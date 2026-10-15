import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '@/i18n';
import { addDays, skopjeToday } from '@/components/insights/shared/period';

// /orders: every status and every date by default (owner 15.10.2026), the quick
// views, the period ‹ ›, ONE "Филтри" panel (status with the MEX parts, department,
// seller …), every filter in the URL, the Insights drill-down honoured, the phone
// sheet, the card layout below md, the collabBox bookings bar (closed) and a row
// that opens the order. The network is mocked; the layout, the order windows and
// the Supabase client are stubs.

vi.mock('@/integrations/supabase/client', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'delete', 'insert']) chain[m] = () => chain;
  chain.maybeSingle = async () => ({ data: null, error: null });
  chain.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(res);
  return { supabase: { rpc: async () => ({ data: null, error: null }), from: () => chain, auth: { getSession: async () => ({ data: { session: null } }) } } };
});
const auth = vi.hoisted(() => ({ user: { id: 'u-admin', isAdmin: true, isManager: false, isWarehouse: false, full_name: 'Миле', email: 'mile@elyon.com' } }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('@/contexts/PermissionsContext', () => ({ usePermissions: () => ({ canAction: () => true, canSeePrivacy: () => false }) }));
vi.mock('@/layouts/AppLayout', () => ({
  AppLayout: ({ title, children }: { title: string; children: React.ReactNode }) => <div><h1>{title}</h1>{children}</div>,
}));
vi.mock('@/components/OrderModal', () => ({
  OrderModal: ({ open, data }: { open: boolean; data: { displayId: string } | null }) =>
    (open ? <div data-testid="order-modal">{data?.displayId}</div> : null),
}));
vi.mock('@/components/CreateOrderModal', () => ({ CreateOrderModal: () => null }));
vi.mock('@/components/CustomerHistoryDialog', () => ({ CustomerHistoryDialog: () => null }));
vi.mock('@/components/OrderCallsPanel', () => ({ OrderCallsPanel: () => null }));

const api = vi.hoisted(() => ({
  orders: vi.fn(),
  counts: vi.fn(),
  views: vi.fn(),
  bookings: vi.fn(),
}));
vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiGetOrders: (...a: unknown[]) => api.orders(...a),
  apiGetOrderStateCounts: (...a: unknown[]) => api.counts(...a),
  apiGetActiveViews: (...a: unknown[]) => api.views(...a),
  apiGetOrderBookings: (...a: unknown[]) => api.bookings(...a),
  apiGetOrderSellers: async () => ({ sellers: [{ id: '11111111-1111-4111-8111-111111111111', name: 'Александра Чима', active: true }] }),
  apiGetAgents: async () => [{ user_id: '22222222-2222-4222-8222-222222222222', full_name: 'Ивана Петровска' }],
  apiGetProducts: async () => [],
  apiGetAppSettings: async () => ({ altercpa_push_enabled: false }),
  apiGetCpaAttributionDimensions: async () => ({ webmasters: [], offers: [], streams: [] }),
  apiGetAlterCpaWebmasters: async () => [],
}));

beforeAll(async () => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  await i18n.changeLanguage('mk');
});
afterEach(() => { vi.clearAllMocks(); window.localStorage.clear(); });

const { default: Orders } = await import('./Orders');

const ORDERS = [
  {
    id: 'o1', display_id: 'ORD-361400', status: 'shipped', customer_name: 'Марија Петровска', customer_phone: '+38970123456',
    customer_city: 'Скопје', customer_address: 'Партизанска 1', product_name: 'Prostafix', quantity: 2, price: 24.23,
    created_at: '2026-09-29T08:00:00Z', sold_at: '2026-09-29T08:05:00Z', confirmed_at: '2026-09-29T08:05:00Z',
    department: 'social', seller_name: 'Александра Чима', assigned_agent_name: 'Ивана Петровска', assigned_agent_id: 'x',
    operator_name: 'Александра Чима', operator_basis: 'sale', operator_auto: false,
    mex_tracking_id: '002-9108-123456/2026', mex_status_id: 10, mex_cod_mkd: 1490, mex_account: 'natura', source_type: 'import',
    order_items: [], is_owned: true,
  },
  {
    id: 'o2', display_id: 'ORD-361499', status: 'pending', customer_name: 'Петар Трајков', customer_phone: '+38975111222',
    customer_city: 'Битола', customer_address: '', product_name: 'Cardiofix', quantity: 1, price: 30,
    created_at: '2026-09-30T22:12:31Z', department: 'altercpa', seller_name: null, assigned_agent_name: null, assigned_agent_id: null,
    mex_tracking_id: null, mex_status_id: null, mex_cod_mkd: null, source_type: 'altercpa', order_items: [], is_owned: true,
  },
];

// collabBox bookings (owner 02.10.2026): sales booked in collabBox, no MEX parcel yet.
const BOOKINGS = {
  rows: [
    {
      doc_number: '002-9102-178224/2026', folder: 'Нарачка out', doc_type_id: '10050', department: 'teleshop_out',
      booked_at: '2026-10-02T10:43:11Z', dispatch_day: '2026-10-05', customer_name: 'Павица Богданов', phone8: '70874112',
      value_mkd: 2000, seller_person_id: '11111111-1111-4111-8111-111111111111', seller_name: 'Aida Kajevikj',
    },
    {
      doc_number: '002-9100-176726/2026', folder: 'Нарачка in', doc_type_id: '10036', department: 'teleshop_other',
      booked_at: '2026-10-02T09:58:04Z', dispatch_day: '2026-10-02', customer_name: 'Светлана Ивановска', phone8: '33413791',
      value_mkd: 1500, seller_person_id: null, seller_name: null,
    },
  ],
  total: 2,
  by_department: { teleshop_out: 1, teleshop_other: 1 },
  clamped: false,
  window: { from: '2026-10-02', to: '2026-10-02' },
  lookback_days: 29,
};

let location = '';
function LocationProbe() {
  location = useLocation().search;
  return null;
}
function renderAt(url = '/orders', opts: { orders?: unknown[]; bookings?: unknown } = {}) {
  const orders = opts.orders ?? ORDERS;
  api.orders.mockResolvedValue({ orders: structuredClone(orders), total: orders.length });
  api.bookings.mockResolvedValue(structuredClone(opts.bookings ?? BOOKINGS));
  api.counts.mockResolvedValue({ counts: { pending: 134, take: 0, call_again: 269, duplicated: 17, confirmed: 526, 'confirmed.no_parcel': 305, 'confirmed.packed': 221, shipped: 1028, 'shipped.courier': 655, 'shipped.problem': 213, delivered: 0, paid: 269011, returned: 36612, cancelled: 39416, trashed: 20751 } });
  api.views.mockResolvedValue({ views: { 75111222: { agent_id: 'u-other', agent_name: 'Ана', opened_at: '2026-10-01T08:00:00Z', expires_at: '2026-10-01T08:02:00Z' } } });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}>
        <Orders />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const t = (k: string, o?: Record<string, unknown>) => i18n.t(k, o) as string;
const lastOrdersCall = () => api.orders.mock.calls[api.orders.mock.calls.length - 1][0];
const quick = (key: string) => within(screen.getByTestId('quick-views')).getByRole('button', { name: new RegExp(`^${t(`ordersList.quick.${key}`)}`) });
const ready = () => screen.findAllByTestId('order-row', {}, { timeout: 10_000 });
const param = (k: string) => new URLSearchParams(location).get(k);
async function openPanel() {
  fireEvent.click(screen.getByTestId('filters-button'));
  return within(await screen.findByTestId('filters-panel'));
}

describe('/orders — every order by default (owner 15.10.2026)', { timeout: 30_000 }, () => {
  it('opens on every status and every date, 20 a page; the panel counts are asked only when it opens', async () => {
    renderAt();
    await ready();
    expect(lastOrdersCall()).toMatchObject({ view: 'all', page: 1, limit: 20 });
    expect(lastOrdersCall().state).toBeUndefined();
    expect(lastOrdersCall().day_from).toBeUndefined();
    expect(lastOrdersCall().drill).toBeUndefined();
    expect(quick('all')).toHaveAttribute('aria-pressed', 'true');
    expect(quick('orders')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('period-pick')).toHaveTextContent(t('ordersList.period.all'));
    // no status pills, no MEX / source pills, no counts request on load
    expect(screen.queryByRole('group', { name: t('ordersList.mex.label') })).toBeNull();
    expect(screen.queryByTestId('filter-status')).toBeNull();
    expect(api.counts).not.toHaveBeenCalled();
    // "who is viewing": ONE request for the page, both phones
    expect(api.views).toHaveBeenCalledTimes(1);
    expect(api.views.mock.calls[0][0]).toEqual(['70123456', '75111222']);
    expect(await screen.findAllByText(t('activeView.onCustomer', { name: 'Ана' }))).not.toHaveLength(0);
  });

  it('shows the MEX proof, the department and the value in денари on each row', async () => {
    renderAt();
    const [row] = await ready();
    expect(within(row).getAllByText(t('customer360.mexStatus.10')).length).toBeGreaterThan(0);
    expect(within(row).getAllByText('002-9108-123456/2026').length).toBeGreaterThan(0);
    expect(within(row).getAllByText(t('insights.common.source.social')).length).toBeGreaterThan(0);
    expect(within(row).getByText('1.490 ден')).toBeInTheDocument();
    // the Оператор of a sale is its seller — never the assignee (Ивана)
    expect(within(row).getAllByText(t('ordersList.operator.chip', { name: 'Александра Чима' })).length).toBeGreaterThan(0);
    expect(within(row).queryByText(t('ordersList.operator.chip', { name: 'Ивана Петровска' }))).toBeNull();
  });

  it('a value-hidden row (a dept_admin, another department) shows "—", never 0 ден — table and card', async () => {
    const { price: _p, mex_cod_mkd: _c, ...rest } = ORDERS[1];
    renderAt('/orders', { orders: [ORDERS[0], { ...rest, value_hidden: true }] });
    const rows = await ready();
    expect(within(rows[1]).getByTitle(t('ordersList.value.hidden'))).toHaveTextContent('—');
    expect(within(rows[1]).queryByText(/\d ден/)).toBeNull();
    const cards = screen.getAllByTestId('order-card');
    expect(within(cards[1]).getByTitle(t('ordersList.value.hidden'))).toHaveTextContent('—');
    expect(within(cards[1]).queryByText(/0 ден/)).toBeNull();
  });

  it('a row opens the order in one click', async () => {
    renderAt();
    const [row] = await ready();
    fireEvent.click(row);
    expect(await screen.findByTestId('order-modal')).toHaveTextContent('ORD-361400');
  });
});

describe('/orders — the filters live in the URL', { timeout: 30_000 }, () => {
  it('a quick view and the period ‹ › go to the URL and to the api', async () => {
    renderAt();
    await ready();
    fireEvent.click(quick('cancelled'));
    await waitFor(() => expect(param('st')).toBe('cancelled'));
    await waitFor(() => expect(lastOrdersCall()).toMatchObject({ view: 'all', state: 'cancelled' }));
    fireEvent.click(quick('all'));
    await waitFor(() => expect(param('st')).toBeNull());

    const today = skopjeToday();
    fireEvent.click(screen.getByTestId('period-pick'));
    fireEvent.click(await screen.findByRole('radio', { name: t('insights.common.period.today') }));
    await waitFor(() => expect(param('range')).toBe('today'));
    await waitFor(() => expect(lastOrdersCall()).toMatchObject({ day_from: today, day_to: today }));
    // ‹ = yesterday, › = today again (never past it)
    expect(screen.getByRole('button', { name: t('insights.common.period.nextDay') })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: t('insights.common.period.prevDay') }));
    const yesterday = addDays(today, -1);
    await waitFor(() => expect(lastOrdersCall()).toMatchObject({ day_from: yesterday, day_to: yesterday }));
    expect(screen.getByTestId('period-pick')).toHaveTextContent(t('ordersList.period.yesterday'));
    fireEvent.click(screen.getByRole('button', { name: t('insights.common.period.nextDay') }));
    await waitFor(() => expect(param('range')).toBe('today'));
  });

  it('the "Филтри" panel: a status with its MEX part, a department and a seller — with the counts', async () => {
    renderAt();
    await ready();
    const panel = await openPanel();
    // the counts: the same filters, without the pick
    await waitFor(() => expect(api.counts).toHaveBeenCalledTimes(1));
    expect(api.counts.mock.calls[0][0].state).toBeUndefined();
    await waitFor(() => expect(panel.getByTestId('state-paid')).toHaveTextContent('269.011'));
    expect(panel.getByTestId('state-shipped.problem')).toHaveTextContent(t('ordersList.status.sub.problem'));
    // nobody is "Во обработка" / "Испорачана" in MK: those rows stay out
    expect(panel.queryByTestId('state-take')).toBeNull();
    expect(panel.queryByTestId('state-delivered')).toBeNull();

    fireEvent.click(panel.getByTestId('state-confirmed.no_parcel'));
    await waitFor(() => expect(param('st')).toBe('confirmed.no_parcel'));
    await waitFor(() => expect(lastOrdersCall()).toMatchObject({ view: 'all', state: 'confirmed.no_parcel' }));
    expect(panel.getByTestId('state-confirmed.no_parcel')).toHaveAttribute('aria-checked', 'true');
    // a parent ticks its MEX parts; un-ticking one keeps the other
    fireEvent.click(panel.getByTestId('state-shipped'));
    await waitFor(() => expect(param('st')).toBe('confirmed.no_parcel,shipped'));
    expect(panel.getByTestId('state-shipped.courier')).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(panel.getByTestId('state-shipped.courier'));
    await waitFor(() => expect(param('st')).toBe('confirmed.no_parcel,shipped.problem'));
    // a pick the strip cannot show: no quick view lit, a token per key, the badge counts it
    expect(quick('all')).toHaveAttribute('aria-pressed', 'false');
    const tokens = within(screen.getByTestId('filter-tokens'));
    expect(tokens.getByText(`${t('status.confirmed')} · ${t('ordersList.status.sub.no_parcel')}`)).toBeInTheDocument();
    expect(screen.getByTestId('filters-button')).toHaveTextContent('1');

    const dept = within(panel.getByTestId('filter-dept'));
    fireEvent.click(dept.getByRole('checkbox', { name: new RegExp(t('insights.common.source.social')) }));
    await waitFor(() => expect(param('dept')).toBe('social'));
    await waitFor(() => expect(lastOrdersCall().dept).toBe('social'));

    const seller = within(panel.getByTestId('filter-seller'));
    fireEvent.click(seller.getByRole('radio', { name: /Александра Чима/ }));
    await waitFor(() => expect(param('seller')).toBe('11111111-1111-4111-8111-111111111111'));
    await waitFor(() => expect(lastOrdersCall().seller).toBe('11111111-1111-4111-8111-111111111111'));

    const source = within(panel.getByTestId('filter-source'));
    fireEvent.click(source.getByRole('radio', { name: t('ordersPage.sourceAltercpa') }));
    await waitFor(() => expect(lastOrdersCall().source).toBe('altercpa'));

    // "Исчисти филтри" in the panel clears the panel's filters
    fireEvent.click(panel.getByRole('button', { name: t('ordersList.filters.clear') }));
    await waitFor(() => expect(param('st')).toBeNull());
    expect(param('dept')).toBeNull();
    expect(param('seller')).toBeNull();
  });

  it('Менаџмент is the last department (owner 02.10.2026) and goes to the URL and the api', async () => {
    renderAt();
    await ready();
    const panel = await openPanel();
    const dept = within(panel.getByTestId('filter-dept'));
    const names = dept.getAllByRole('checkbox').map((b) => b.textContent ?? '');
    const mgmt = names.findIndex((n) => n.includes(t('insights.common.source.management')));
    expect(mgmt).toBe(names.length - 1);
    fireEvent.click(dept.getByRole('checkbox', { name: new RegExp(t('insights.common.source.management')) }));
    await waitFor(() => expect(param('dept')).toBe('management'));
    await waitFor(() => expect(lastOrdersCall().dept).toBe('management'));
  });

  it('a phone in the search box is sent as typed and matched by its last 8 digits', async () => {
    renderAt();
    await ready();
    fireEvent.change(screen.getByRole('searchbox', { name: t('ordersList.search.label') }), { target: { value: '070 123 456' } });
    expect(screen.getByText(t('ordersList.search.phone'))).toBeInTheDocument();
    await waitFor(() => expect(new URLSearchParams(location).get('search')).toBe('070 123 456'));
    await waitFor(() => expect(lastOrdersCall().search).toBe('070 123 456'));
    // a search lists every status and date
    expect(lastOrdersCall().view).toBe('all');
    expect(lastOrdersCall().day_from).toBeUndefined();
  });

  it('opens with the filters of the URL — an old ?view= link still means what it said', async () => {
    renderAt('/orders?view=leads&range=custom&from=2026-09-01&to=2026-09-15&dept=altercpa&source=altercpa&agent=none');
    await ready();
    expect(lastOrdersCall()).toMatchObject({
      view: 'all', state: 'pending,take,call_again,duplicated', day_from: '2026-09-01', day_to: '2026-09-15',
      dept: 'altercpa', source: 'altercpa', agent_id: 'none',
    });
    expect(quick('leads')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('period-pick')).toHaveTextContent('01.09 – 15.09.2026');
    const tokens = within(screen.getByTestId('filter-tokens'));
    expect(tokens.getByText(t('ordersList.agent.chip', { name: t('ordersList.agent.none') }))).toBeInTheDocument();
    expect(screen.getByTestId('filters-button')).toHaveTextContent('3'); // department, source, agent
  });

  it('an Insights drill-down link is honoured: its own set, every status, every date', async () => {
    renderAt('/orders?cohort_bucket=paid&cohort_source=social&sold_from=2026-09-22&sold_to=2026-09-28&lbl=Social');
    await ready();
    const call = lastOrdersCall();
    expect(call.drill).toEqual({ cohort_bucket: 'paid', cohort_source: 'social', sold_from: '2026-09-22', sold_to: '2026-09-28' });
    expect(call.view).toBe('all');
    expect(call.state).toBeUndefined();
    expect(call.day_from).toBeUndefined();
    expect(quick('all')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('Social');
  });
});

describe('/orders — phones and small screens', { timeout: 30_000 }, () => {
  it('below md: one compact card per order (the table is md+)', async () => {
    renderAt();
    await ready();
    const cards = screen.getAllByTestId('order-card');
    expect(cards).toHaveLength(2);
    expect(cards[0].closest('ul')).toHaveClass('md:hidden');
    expect(screen.getByRole('table', { name: t('nav.orders') }).parentElement).toHaveClass('hidden', 'md:block');
    const c = within(cards[0]);
    expect(c.getByText(t('status.shipped'))).toBeInTheDocument();
    expect(c.getByText(t('insights.common.source.social'))).toBeInTheDocument();
    expect(c.getByText('+38970123456')).toBeInTheDocument();
    expect(c.getByText('1.490 ден')).toBeInTheDocument();
    expect(c.getByText(t('customer360.mexStatus.10'))).toBeInTheDocument();
    expect(within(cards[1]).getByText(t('ordersList.mex.noParcelShort'))).toBeInTheDocument();
  });

  it('on a phone the "Филтри" button opens the sheet: a draft; "Примени" writes it to the URL', async () => {
    const width = window.innerWidth;
    window.innerWidth = 390;
    try {
      renderAt();
      await ready();
      fireEvent.click(screen.getByTestId('filters-button'));
      const sheet = within(await screen.findByRole('dialog'));
      expect(screen.queryByTestId('filters-panel')).toBeNull();
      await waitFor(() => expect(api.counts).toHaveBeenCalled());
      fireEvent.click(sheet.getByTestId('state-confirmed.packed'));
      fireEvent.click(sheet.getByRole('checkbox', { name: new RegExp(t('insights.common.source.teleshop_out')) }));
      expect(param('st')).toBeNull(); // not before "Примени"
      fireEvent.click(sheet.getByRole('button', { name: t('ordersList.filters.apply') }));
      await waitFor(() => expect(param('st')).toBe('confirmed.packed'));
      expect(param('dept')).toBe('teleshop_out');
      await waitFor(() => expect(lastOrdersCall()).toMatchObject({ state: 'confirmed.packed', dept: 'teleshop_out' }));
    } finally {
      window.innerWidth = width;
    }
  });

  it('speaks Macedonian: no English or Bulgarian leftovers — the panel too', async () => {
    const { container } = renderAt();
    await ready();
    await openPanel();
    const text = (container.textContent ?? '') + (screen.getByTestId('filters-panel').textContent ?? '');
    expect(text).not.toMatch(/⟪/);
    expect(text).not.toMatch(/\b(Status|Assignee|Details|Hide details|Export CSV|Any date|days|To:|Filters|Orders|Search)\b/);
    expect(text).not.toMatch(/Speedy|Econt|MONADLIST/);
    expect(text).not.toMatch(/прогноз/i);
  });
});

describe('/orders — collabBox bookings and the collabBox entry rule (owner 02.10.2026)', { timeout: 30_000 }, () => {
  it('the bookings sit under the toolbar, CLOSED; a click opens them and the browser remembers (owner 15.10.2026)', async () => {
    const view = renderAt('/orders?dept=teleshop_out,teleshop_other');
    const [firstRow] = await ready();
    await waitFor(() => expect(api.bookings).toHaveBeenCalled());
    // every date by default: only the department goes along
    expect(api.bookings.mock.calls[0][0]).toEqual({ dept: 'teleshop_out,teleshop_other' });
    const section = await screen.findByTestId('bookings-section');
    // above the list, one line, closed
    expect(section.compareDocumentPosition(firstRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const s = within(section);
    const toggle = s.getByTestId('bookings-toggle');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(s.getByRole('heading', { name: new RegExp(t('ordersList.bookings.title')) })).toBeInTheDocument();
    expect(s.getByTestId('bookings-total')).toHaveTextContent('2');
    expect(s.queryAllByTestId('booking-row')).toHaveLength(0);
    expect(screen.queryByTestId('bookings-chip')).toBeNull();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(s.getAllByTestId('booking-row')).toHaveLength(2);
    expect(s.getAllByTestId('booking-card')).toHaveLength(2);
    expect(s.getAllByText('Павица Богданов').length).toBeGreaterThan(0);
    expect(s.getAllByText('2.000 ден').length).toBeGreaterThan(0);
    expect(s.getAllByText('Нарачка out').length).toBeGreaterThan(0);
    expect(s.getAllByText('002-9102-178224/2026').length).toBeGreaterThan(0);
    expect(s.getAllByText(t('ordersList.bookings.ships', { day: '05.10' })).length).toBeGreaterThan(0);
    // read-only: a booking is not an order to open
    fireEvent.click(s.getAllByTestId('booking-row')[0]);
    expect(screen.queryByTestId('order-modal')).toBeNull();
    expect(window.localStorage.getItem('orders.bookings.open')).toBe('1');

    // the next visit opens it as it was left
    view.unmount();
    renderAt('/orders?dept=teleshop_out');
    await ready();
    expect(await screen.findByTestId('bookings-toggle')).toHaveAttribute('aria-expanded', 'true');
  });

  it('0 orders for a filter but bookings → the empty state says why', async () => {
    renderAt('/orders?dept=teleshop_out', { orders: [] });
    expect(await screen.findByText(t('ordersList.bookings.empty', { count: 2 }), {}, { timeout: 10_000 })).toBeInTheDocument();
    expect(await screen.findByTestId('bookings-section')).toBeInTheDocument();
  });

  it('a status or a filter a booking cannot have leaves them out; Нарачки brings them back', async () => {
    const first = renderAt('/orders?mex=courier');
    await ready();
    expect(api.bookings).not.toHaveBeenCalled();
    expect(screen.queryByTestId('bookings-section')).toBeNull();
    // an old MEX link still filters — shown as a token
    expect(within(screen.getByTestId('filter-tokens')).getByText(`MEX: ${t('ordersList.mex.courier')}`)).toBeInTheDocument();
    first.unmount();

    renderAt('/orders?st=paid');
    await ready();
    expect(api.bookings).not.toHaveBeenCalled();
    fireEvent.click(quick('orders'));
    await waitFor(() => expect(api.bookings).toHaveBeenCalled());
    expect(await screen.findByTestId('bookings-section')).toBeInTheDocument();
  });

  it('no bookings → no section', async () => {
    renderAt('/orders', { bookings: { ...BOOKINGS, rows: [], total: 0, by_department: {} } });
    await ready();
    await waitFor(() => expect(api.bookings).toHaveBeenCalled());
    expect(screen.queryByTestId('bookings-section')).toBeNull();
  });

  it('a CRM sale: green "Во collabBox", or amber "Не е во collabBox" (+ the cancel day in apply mode) and a provisional department', async () => {
    const crm = (id: string, collab: unknown) => ({
      ...ORDERS[0], id, display_id: id, status: 'confirmed', department: 'elyon_crm', sale_source: 'elyon_crm',
      sale_source_detail: 'prediction_list', mex_tracking_id: null, mex_status_id: null, mex_cod_mkd: null, collab,
    });
    renderAt('/orders', {
      orders: [
        crm('ORD-1', { doc: '002-9103-178176/2026', sale_day: '2026-10-02', cancel_day: '2026-10-04', mode: 'report' }),
        crm('ORD-2', { doc: null, sale_day: '2026-10-02', cancel_day: '2026-10-04', mode: 'report' }),
        crm('ORD-3', { doc: null, sale_day: '2026-09-30', cancel_day: '2026-10-02', mode: 'apply' }),
      ],
    });
    const rows = await ready();
    const [r1, r2, r3] = rows.map((r) => within(r));
    expect(r1.getAllByTestId('collab-in')[0]).toHaveAttribute('title', t('ordersList.collab.inTitle', { doc: '002-9103-178176/2026' }));
    expect(r1.queryByTestId('dept-provisional')).toBeNull();
    expect(r2.getAllByTestId('collab-missing')[0]).toHaveTextContent(t('ordersList.collab.missing'));
    expect(r2.getAllByTestId('collab-missing')[0].textContent).not.toMatch(/21:20/);
    expect(r2.getAllByTestId('dept-provisional')[0]).toHaveTextContent(t('ordersList.collab.provisional'));
    // the table cell: the cancel time on its own line; the phone card: ' · ' inline
    expect(r3.getAllByTestId('collab-missing')[0]).toHaveTextContent(`${t('ordersList.collab.missing')}${t('ordersList.collab.cancels', { day: '02.10', time: '21:20' })}`);
    expect(within(screen.getAllByTestId('order-card')[2]).getByTestId('collab-missing')).toHaveTextContent(`${t('ordersList.collab.missing')} · ${t('ordersList.collab.cancels', { day: '02.10', time: '21:20' })}`);
    // the phone cards carry the same badge
    const cards = screen.getAllByTestId('order-card');
    expect(within(cards[0]).getByTestId('collab-in')).toBeInTheDocument();
    expect(within(cards[2]).getByTestId('collab-missing')).toBeInTheDocument();
  });
});
