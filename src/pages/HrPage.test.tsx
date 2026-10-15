import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '@/i18n';
import type { HrAccess, HrMe, HrRequest } from '@/lib/hrApi';

// Render tests for /hr (Човечки ресурси, owner 15.10.2026): an agent sees only "Мое" with the
// balance and sends a request (POST /hr/requests with no employee_id = oneself); a team lead
// gets the lead tabs and approves at the team step. The network is replaced by mocks of
// @/lib/hrApi; the api decides everything again server-side.

vi.mock('@/layouts/AppLayout', () => ({
  AppLayout: ({ title, children }: { title: string; children: React.ReactNode }) => <div><h1>{title}</h1>{children}</div>,
}));

const api = vi.hoisted(() => ({
  me: vi.fn(), requests: vi.fn(), create: vi.fn(), decide: vi.fn(), cancel: vi.fn(), employees: vi.fn(),
  calendar: vi.fn(), balances: vi.fn(), holidays: vi.fn(),
}));
vi.mock('@/lib/hrApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/hrApi')>()),
  apiHrMe: (...a: unknown[]) => api.me(...a),
  apiHrRequests: (...a: unknown[]) => api.requests(...a),
  apiHrCreateRequest: (...a: unknown[]) => api.create(...a),
  apiHrDecide: (...a: unknown[]) => api.decide(...a),
  apiHrCancel: (...a: unknown[]) => api.cancel(...a),
  apiHrEmployees: (...a: unknown[]) => api.employees(...a),
  apiHrCalendar: (...a: unknown[]) => api.calendar(...a),
  apiHrBalances: (...a: unknown[]) => api.balances(...a),
  apiHrHolidays: (...a: unknown[]) => api.holidays(...a),
}));

beforeAll(async () => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  await i18n.changeLanguage('mk');
});
afterEach(() => { vi.clearAllMocks(); });

const { default: HrPage } = await import('./HrPage');

const E1 = '11111111-1111-4111-8111-111111111111';
const E2 = '22222222-2222-4222-8222-222222222222';
const today = '2026-10-15';

const employee = {
  id: E1, user_id: 'me', full_name: 'Ана Петровска', status: 'active' as const, company: null, workplace: 'call_centre' as const,
  shop_name: null, position: null, team_key: 'teleshop', approver_id: null, work_days: [1, 2, 3, 4, 5], holiday_calendars: ['orthodox'],
};
const balance = {
  employee_id: E1, year: 2026, today, source: 'default' as const, note: null, base_days: 20, extra_days: 0, carry_days: 0,
  carry_until: '2026-06-30', carry_available: 0, carry_expiring: 0, carry_lost: 0, entitled: 20, taken: 3, used: 3, planned: 0,
  pending: 2, remaining: 17, remaining_year: 17, longest_block: 3, first_part_ok: false, personal_paid_days: 0,
  personal_paid_over: false, unpaid_days: 0, sick_employer_days: 0, sick_fzom_days: 0,
};
const access = (a: Partial<HrAccess>): HrAccess => ({ full: false, final: false, team: false, seeAll: false, hasSelf: true, ...a });
const me = (a: Partial<HrAccess>): HrMe => ({
  access: access(a), employee, balance, requests: [], holidays: [
    { id: 'h1', date: '2026-10-23', name: 'Ден на македонската револуционерна борба', scope: 'all', moved_from: null, verified: true },
  ], year: 2026, today,
});
const req = (over: Partial<HrRequest>): HrRequest => ({
  id: 'r1', employee_id: E2, employee_name: 'Бети Николова', employee_user_id: 'beti', type: 'annual',
  date_from: '2026-10-19', date_to: '2026-10-21', days: 3, status: 'pending_team', note: null, doc_ref: null,
  requested_by: 'beti', requested_by_name: 'Бети Николова', requested_at: '2026-10-15T08:00:00Z',
  team_by: null, team_at: null, team_note: null, decided_by: null, decided_at: null, decision_note: null,
  cancelled_by: null, cancelled_at: null, cancel_note: null, can_decide: true, can_cancel: false, ...over,
});

function renderPage(path = '/hr') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}><HrPage /></MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('an agent', () => {
  it('sees only Мое + Празници, the balance, and sends a request for themselves', async () => {
    api.me.mockResolvedValue(me({}));
    api.create.mockResolvedValue({ request: req({}), stage: 'pending_team' });
    renderPage();
    expect(await screen.findByTestId('hr-remaining')).toHaveTextContent('17');
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(tabs).toEqual(['Мое', 'Празници']);
    expect(api.requests).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Побарај отсуство/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Од'), { target: { value: '2026-10-19' } });
    fireEvent.change(within(dialog).getByLabelText('До'), { target: { value: '2026-10-23' } });
    // Mon–Fri minus the 23.10 holiday = 4 working days
    expect(within(dialog).getByTestId('hr-days-preview')).toHaveTextContent('4 работни дена');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Испрати барање' }));
    await waitFor(() => expect(api.create).toHaveBeenCalledTimes(1));
    expect(api.create).toHaveBeenCalledWith(expect.objectContaining({
      employee_id: null, type: 'annual', date_from: '2026-10-19', date_to: '2026-10-23', record: false,
    }));
  });
});

describe('a team lead', () => {
  it('gets the lead tabs and approves at the team step', async () => {
    api.me.mockResolvedValue(me({ team: true }));
    api.requests.mockResolvedValue({ requests: [req({})] });
    api.employees.mockResolvedValue({ employees: [employee] });
    api.calendar.mockResolvedValue({ from: today, to: today, today, employees: [], absences: [], holidays: [] });
    api.decide.mockResolvedValue({ request: req({ status: 'pending_manager' }), stage: 'pending_manager' });
    renderPage('/hr?tab=requests');
    const list = await screen.findByTestId('hr-requests');
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent?.replace(/\d+$/, ''));
    expect(tabs).toEqual(['Преглед', 'Мое', 'Календар', 'Барања', 'Салда', 'Празници']);
    expect(within(list).getByText('Бети Николова')).toBeInTheDocument();
    fireEvent.click(within(list).getByRole('button', { name: 'Одобри (тим)' }));
    await waitFor(() => expect(api.decide).toHaveBeenCalledWith('r1', 'approve'));
  });

  it('a rejection asks for a note first', async () => {
    api.me.mockResolvedValue(me({ team: true }));
    api.requests.mockResolvedValue({ requests: [req({})] });
    api.employees.mockResolvedValue({ employees: [employee] });
    api.decide.mockResolvedValue({ request: req({ status: 'rejected' }), stage: 'rejected' });
    renderPage('/hr?tab=requests');
    const list = await screen.findByTestId('hr-requests');
    fireEvent.click(within(list).getByRole('button', { name: 'Одбиј' }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Одбиј' });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'премногу луѓе таа недела' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(api.decide).toHaveBeenCalledWith('r1', 'reject', 'премногу луѓе таа недела'));
  });
});
