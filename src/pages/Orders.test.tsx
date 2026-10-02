import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '@/i18n';
import { addDays, skopjeToday } from '@/components/insights/shared/period';

// /orders (Phase 11 A): the default "Нарачки" chip with counts, every filter in
// the URL, the Insights drill-down honoured, the phone Filters sheet, the card
// layout below md and a row that opens the order. The network is mocked; the
// layout, the order windows and the Supabase client are stubs.

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
  apiGetOrderViewCounts: (...a: unknown[]) => api.counts(...a),
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
afterEach(() => { vi.clearAllMocks(); });

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
  api.counts.mockResolvedValue({ counts: { orders: 1400, leads: 63, cancelled: 1021, trashed: 543, all: 3027 } });
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
const chips = () => screen.getByRole('group', { name: t('ordersList.view.label') });
const chip = (key: string) => within(chips()).getByRole('button', { name: new RegExp(`^${t(`ordersList.view.${key}`)}`) });
const ready = () => screen.findAllByTestId('order-row', {}, { timeout: 10_000 });

describe('/orders — Нарачки by default', { timeout: 30_000 }, () => {
  it('opens on the "Нарачки" chip, for today (Skopje), with a count on every chip', async () => {
    renderAt();
    await ready();
    const today = skopjeToday();
    expect(lastOrdersCall()).toMatchObject({ view: 'orders', day_from: today, day_to: today, page: 1, limit: 20 });
    expect(lastOrdersCall().drill).toBeUndefined();
    expect(chip('orders')).toHaveAttribute('aria-pressed', 'true');
    expect(chip('cancelled')).toHaveAttribute('aria-pressed', 'false');
    await waitFor(() => expect(screen.getByTestId('view-count-orders').textContent).toBe('1.400'));
    expect(screen.getByTestId('view-count-all').textContent).toBe('3.027');
    // the counts ask for the same filters, without the chip
    expect(api.counts.mock.calls[0][0]).toMatchObject({ day_from: today, day_to: today });
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
  it('a chip, a department, a MEX group and a seller go to the URL and to the api', async () => {
    renderAt();
    await ready();
    fireEvent.click(chip('cancelled'));
    await waitFor(() => expect(new URLSearchParams(location).get('view')).toBe('cancelled'));
    await waitFor(() => expect(lastOrdersCall().view).toBe('cancelled'));

    const dept = screen.getAllByRole('group', { name: t('ordersList.dept.label') })[0];
    fireEvent.click(within(dept).getByRole('button', { name: new RegExp(t('insights.common.source.social')) }));
    await waitFor(() => expect(new URLSearchParams(location).get('dept')).toBe('social'));
    await waitFor(() => expect(lastOrdersCall().dept).toBe('social'));

    const mex = screen.getAllByRole('group', { name: t('ordersList.mex.label') })[0];
    fireEvent.click(within(mex).getByRole('button', { name: t('ordersList.mex.courier') }));
    await waitFor(() => expect(new URLSearchParams(location).get('mex')).toBe('courier'));
    await waitFor(() => expect(lastOrdersCall().mex).toBe('courier'));

    fireEvent.click(screen.getAllByRole('button', { name: t('ordersList.seller.label') })[0]);
    fireEvent.click(await screen.findByRole('button', { name: 'Александра Чима' }));
    await waitFor(() => expect(new URLSearchParams(location).get('seller')).toBe('11111111-1111-4111-8111-111111111111'));
    await waitFor(() => expect(lastOrdersCall().seller).toBe('11111111-1111-4111-8111-111111111111'));
  });

  it('Менаџмент is the last department chip (owner 02.10.2026) and goes to the URL and the api', async () => {
    renderAt();
    await ready();
    const dept = screen.getAllByRole('group', { name: t('ordersList.dept.label') })[0];
    const names = within(dept).getAllByRole('button').map((b) => b.textContent ?? '');
    const mgmt = names.findIndex((n) => n.includes(t('insights.common.source.management')));
    expect(mgmt).toBeGreaterThan(names.findIndex((n) => n.includes(t('insights.common.source.web'))));
    fireEvent.click(within(dept).getByRole('button', { name: new RegExp(t('insights.common.source.management')) }));
    await waitFor(() => expect(new URLSearchParams(location).get('dept')).toBe('management'));
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

  it('opens with the filters of the URL', async () => {
    renderAt('/orders?view=leads&range=custom&from=2026-09-01&to=2026-09-15&dept=altercpa&source=altercpa&agent=none');
    await ready();
    expect(lastOrdersCall()).toMatchObject({ view: 'leads', day_from: '2026-09-01', day_to: '2026-09-15', dept: 'altercpa', source: 'altercpa', agent_id: 'none' });
    expect(chip('leads')).toHaveAttribute('aria-pressed', 'true');
  });

  it('an Insights drill-down link is honoured: its own set, every status, every date', async () => {
    renderAt('/orders?cohort_bucket=paid&cohort_source=social&sold_from=2026-09-22&sold_to=2026-09-28&lbl=Social');
    await ready();
    const call = lastOrdersCall();
    expect(call.drill).toEqual({ cohort_bucket: 'paid', cohort_source: 'social', sold_from: '2026-09-22', sold_to: '2026-09-28' });
    expect(call.view).toBe('all');
    expect(call.day_from).toBeUndefined();
    expect(chip('all')).toHaveAttribute('aria-pressed', 'true');
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

  it('the Filters sheet edits a draft; "Примени" writes it to the URL', async () => {
    renderAt();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${t('ordersList.filters.open')}`) }));
    const sheet = await screen.findByRole('dialog');
    fireEvent.click(within(sheet).getByRole('button', { name: t('ordersList.mex.at_mex') }));
    fireEvent.click(within(sheet).getByRole('button', { name: new RegExp(t('insights.common.source.teleshop_out')) }));
    expect(new URLSearchParams(location).get('mex')).toBeNull(); // not before "Примени"
    fireEvent.click(within(sheet).getByRole('button', { name: t('ordersList.filters.apply') }));
    await waitFor(() => expect(new URLSearchParams(location).get('mex')).toBe('at_mex'));
    expect(new URLSearchParams(location).get('dept')).toBe('teleshop_out');
    await waitFor(() => expect(lastOrdersCall()).toMatchObject({ mex: 'at_mex', dept: 'teleshop_out' }));
  });

  it('speaks Macedonian: no English or Bulgarian leftovers', async () => {
    const { container } = renderAt();
    await ready();
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/⟪/);
    expect(text).not.toMatch(/\b(Status|Assignee|Details|Hide details|Export CSV|Any date|days|To:|Filters|Orders|Search)\b/);
    expect(text).not.toMatch(/Speedy|Econt|MONADLIST/);
    expect(text).not.toMatch(/прогноз/i);
  });
});

describe('/orders — collabBox bookings and the 2-day entry rule (owner 02.10.2026)', { timeout: 30_000 }, () => {
  it('shows the bookings beside the orders: a badge next to "Нарачки" and the section, for the same filters', async () => {
    renderAt('/orders?dept=teleshop_out,teleshop_other');
    await ready();
    const today = skopjeToday();
    await waitFor(() => expect(api.bookings).toHaveBeenCalled());
    expect(api.bookings.mock.calls[0][0]).toEqual({ day_from: today, day_to: today, dept: 'teleshop_out,teleshop_other' });
    // the chip's own count stays real orders only; the bookings sit beside it
    await waitFor(() => expect(screen.getByTestId('view-count-orders').textContent).toBe('1.400'));
    expect(await screen.findByTestId('bookings-chip')).toHaveTextContent(t('ordersList.bookings.chip', { count: 2 }));
    const section = await screen.findByTestId('bookings-section');
    const s = within(section);
    expect(s.getByRole('heading', { name: t('ordersList.bookings.title') })).toBeInTheDocument();
    expect(s.getByTestId('bookings-total')).toHaveTextContent('2');
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
  });

  it('0 orders for a filter but bookings → the empty state says why', async () => {
    renderAt('/orders?dept=teleshop_out', { orders: [] });
    expect(await screen.findByText(t('ordersList.bookings.empty', { count: 2 }), {}, { timeout: 10_000 })).toBeInTheDocument();
    expect(await screen.findByTestId('bookings-section')).toBeInTheDocument();
  });

  it('a filter a booking cannot have (a MEX status) and the leads chip leave them out; none → nothing', async () => {
    renderAt('/orders?mex=courier');
    await ready();
    expect(api.bookings).not.toHaveBeenCalled();
    expect(screen.queryByTestId('bookings-section')).toBeNull();
    expect(screen.queryByTestId('bookings-chip')).toBeNull();
    fireEvent.click(chip('all'));
    await waitFor(() => expect(lastOrdersCall().view).toBe('all'));
    expect(api.bookings).not.toHaveBeenCalled();
  });

  it('no bookings → no section and no badge', async () => {
    renderAt('/orders', { bookings: { ...BOOKINGS, rows: [], total: 0, by_department: {} } });
    await ready();
    await waitFor(() => expect(api.bookings).toHaveBeenCalled());
    expect(screen.queryByTestId('bookings-section')).toBeNull();
    expect(screen.queryByTestId('bookings-chip')).toBeNull();
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
