import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '@/i18n';
import { addDaysYmd, mondayOfYmd, skopjeNow, type ShiftsGrid } from '@/lib/shiftsApi';

// Render tests for the one "Смени" page (plan Фаза 8): the agent's banner, the manager's
// paint → staged → atomic save (POST /shifts/cells payload), and the roll-month preview →
// confirm. The network is replaced by mocks of @/lib/shiftsApi.

vi.mock('@/layouts/AppLayout', () => ({
  AppLayout: ({ title, children }: { title: string; children: React.ReactNode }) => <div><h1>{title}</h1>{children}</div>,
}));

const who = vi.hoisted(() => ({ manager: false }));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'me', isAdmin: who.manager, isManager: false } }),
}));
vi.mock('@/contexts/PermissionsContext', () => ({
  usePermissions: () => ({ canAccessModule: (m: string) => (m === 'shifts' ? who.manager : true) }),
}));

const api = vi.hoisted(() => ({
  my: vi.fn(),
  grid: vi.fn(),
  cells: vi.fn(),
  runway: vi.fn(),
  roll: vi.fn(),
  copy: vi.fn(),
}));
vi.mock('@/lib/shiftsApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/shiftsApi')>()),
  apiGetMyShiftDays: (...a: unknown[]) => api.my(...a),
  apiGetShiftsGrid: (...a: unknown[]) => api.grid(...a),
  apiSetShiftCells: (...a: unknown[]) => api.cells(...a),
  apiGetShiftsRunway: (...a: unknown[]) => api.runway(...a),
  apiRollShiftsMonth: (...a: unknown[]) => api.roll(...a),
  apiCopyShifts: (...a: unknown[]) => api.copy(...a),
}));
vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiGetAgents: () => Promise.resolve([]),
}));

beforeAll(async () => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  await i18n.changeLanguage('mk');
});
afterEach(() => { vi.clearAllMocks(); });

const { default: ShiftsPage } = await import('./ShiftsPage');

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/shifts']}><ShiftsPage /></MemoryRouter>
    </QueryClientProvider>,
  );
}

const today = skopjeNow().date;
const monday = mondayOfYmd(today);
const tuesday = addDaysYmd(monday, 1);
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const T1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const S1 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const grid: ShiftsGrid = {
  from: monday, to: addDaysYmd(monday, 6), today,
  people: [
    { user_id: A, name: 'Ана Петровска', roles: ['pending_agent'], gated: true, team_key: 'altercpa_leads', team_name: 'Pending — AlterCPA leads' },
    { user_id: B, name: 'Бети Николова', roles: ['prediction_agent'], gated: true, team_key: null, team_name: null },
  ],
  cells: [{ user_id: A, date: monday, shift_id: S1, start: '07:00', end: '21:00', name: 'Октомври', template_id: null }],
  templates: [{ id: T1, name: 'Smena 1', start: '07:30', end: '14:30' }],
  windows: [{ start: '07:00', end: '21:00', name: 'Октомври', count: 1000 }],
};

describe('agent view', () => {
  it('warns in red when there is no shift in the next 5 days', async () => {
    who.manager = false;
    const day = (d: string) => ({ id: S1, name: 'Октомври', date: d, start_time: '07:00', end_time: '21:00', template_id: null,
      clock_in_time: null, breaks: [], total_break_seconds: 0, on_break: false });
    api.my.mockResolvedValue([day(today), day(addDaysYmd(today, 1)), day(addDaysYmd(today, 2))]);
    renderPage();
    const banner = await screen.findByTestId('agent-runway-banner');
    const from = addDaysYmd(today, 3);
    expect(banner).toHaveTextContent(`Немате смена од ${from.slice(8, 10)}.${from.slice(5, 7)} — нема да можете да се најавите.`);
    expect(screen.getByTestId('today-card')).toHaveTextContent('07:00–21:00');
    expect(api.grid).not.toHaveBeenCalled();
  });

  it('no banner when the roster goes past the next 5 days', async () => {
    who.manager = false;
    api.my.mockResolvedValue([6, 7, 8].map((i) => ({ id: S1, name: 'Октомври', date: addDaysYmd(today, i), start_time: '07:00',
      end_time: '21:00', template_id: null, clock_in_time: null, breaks: [], total_break_seconds: 0, on_break: false })));
    renderPage();
    await screen.findByTestId('today-card');
    expect(screen.queryByTestId('agent-runway-banner')).toBeNull();
    expect(screen.getByTestId('today-card')).toHaveTextContent('Денес немате смена.');
  });
});

describe('manager view', () => {
  it('paints with a brush, stages the changes and saves them atomically', async () => {
    who.manager = true;
    api.runway.mockResolvedValue({ level: 'ok', today, warn_days: 5, agents: 2, ends_on: '2026-10-31', blocked_from: null, days_left: null, count: 0, people: [] });
    api.grid.mockResolvedValue(grid);
    api.cells.mockResolvedValue({ changed: 2, unchanged: 0, cells: [], undo: [{ user_id: A, date: monday, shift_id: S1 }, { user_id: B, date: tuesday, off: true }] });
    const { container } = renderPage();

    const gridEl = await screen.findByTestId('shift-grid');
    expect(api.grid).toHaveBeenCalledWith(monday, addDaysYmd(monday, 6));
    expect(within(gridEl).getByText('Ана Петровска')).toBeInTheDocument();

    // pick the "Smena 1" template brush, paint Beti's Tuesday
    fireEvent.click(container.querySelector(`[data-brush="t:${T1}"]`)!);
    fireEvent.click(gridEl.querySelector(`[data-cell-key="${B}|${tuesday}"]`)!);
    // the eraser on Ana's Monday
    fireEvent.click(container.querySelector('[data-brush="off"]')!);
    fireEvent.click(gridEl.querySelector(`[data-cell-key="${A}|${monday}"]`)!);
    // erasing an empty day is not a change
    fireEvent.click(gridEl.querySelector(`[data-cell-key="${B}|${monday}"]`)!);

    expect(gridEl.querySelector(`[data-cell-key="${B}|${tuesday}"]`)).toHaveAttribute('data-staged', 'true');
    const save = screen.getByRole('button', { name: 'Зачувај (2)' });
    fireEvent.click(save);

    await waitFor(() => expect(api.cells).toHaveBeenCalledTimes(1));
    expect(api.cells).toHaveBeenCalledWith([
      { user_id: A, date: monday, off: true },
      { user_id: B, date: tuesday, template_id: T1 },
    ]);
    // one Undo, with the server's undo cells
    const undo = await screen.findByRole('button', { name: 'Врати' });
    fireEvent.click(undo);
    await waitFor(() => expect(api.cells).toHaveBeenCalledTimes(2));
    expect(api.cells).toHaveBeenLastCalledWith([{ user_id: A, date: monday, shift_id: S1 }, { user_id: B, date: tuesday, off: true }]);
  });

  it('asks for a brush before painting, and painting back to the stored value un-stages', async () => {
    who.manager = true;
    api.runway.mockResolvedValue({ level: 'ok', today, warn_days: 5, agents: 2, ends_on: '2026-10-31', blocked_from: null, days_left: null, count: 0, people: [] });
    api.grid.mockResolvedValue(grid);
    const { container } = renderPage();
    const gridEl = await screen.findByTestId('shift-grid');
    fireEvent.click(gridEl.querySelector(`[data-cell-key="${B}|${tuesday}"]`)!);
    expect(gridEl.querySelector('[data-staged]')).toBeNull();

    fireEvent.click(container.querySelector('[data-brush="off"]')!);
    fireEvent.click(gridEl.querySelector(`[data-cell-key="${A}|${monday}"]`)!);
    expect(screen.getByRole('button', { name: 'Зачувај (1)' })).toBeInTheDocument();
    fireEvent.click(container.querySelector('[data-brush="w:07:00-21:00"]')!);
    fireEvent.click(gridEl.querySelector(`[data-cell-key="${A}|${monday}"]`)!);
    expect(screen.queryByRole('button', { name: /Зачувај/ })).toBeNull();
  });

  it('rolls the month over: preview first, then apply after the confirm', async () => {
    who.manager = true;
    api.runway.mockResolvedValue({
      level: 'warn', today, warn_days: 5, agents: 2, ends_on: addDaysYmd(today, 3), blocked_from: addDaysYmd(today, 4), days_left: 4, count: 2,
      people: [{ user_id: A, name: 'Ана Петровска', last_date: addDaysYmd(today, 3) }, { user_id: B, name: 'Бети Николова', last_date: addDaysYmd(today, 3) }],
    });
    api.grid.mockResolvedValue(grid);
    const preview = {
      apply: false, name: 'Ноември', src: ['2026-10-01', '2026-10-31'], dst: ['2026-11-01', '2026-11-30'],
      people: [
        { user_id: A, name: 'Ана Петровска', hours: '07:00-21:00', weekdays: '1234567', days: 30, already_covered: 0 },
        { user_id: B, name: 'Бети Николова', hours: '07:00-21:00', weekdays: '12345', days: 21, already_covered: 0 },
      ],
      excluded: [], person_days: 51, skipped_covered: 0, shifts_created: 0, assignments_created: 0,
    };
    api.roll.mockImplementation((body: { apply?: boolean }) =>
      Promise.resolve(body.apply ? { ...preview, apply: true, shifts_created: 30, assignments_created: 51, assignments_widened: 0 } : preview));
    renderPage();

    const banner = await screen.findByTestId('runway-banner');
    expect(banner).toHaveTextContent('за 4 дена 2 агенти нема да можат да се најават');
    fireEvent.click(within(banner).getByRole('button', { name: 'Пренеси го месецот' }));

    const list = await screen.findByTestId('roll-preview');
    expect(api.roll).toHaveBeenCalledWith({ apply: false });
    expect(list).toHaveTextContent('Ана Петровска');
    expect(list).toHaveTextContent('секој ден');
    expect(list).toHaveTextContent('Пон Вто Сре Чет Пет');
    expect(api.roll).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Потврди и внеси (51)' }));
    await waitFor(() => expect(api.roll).toHaveBeenCalledTimes(2));
    expect(api.roll).toHaveBeenLastCalledWith({
      apply: true, src_from: '2026-10-01', src_to: '2026-10-31', dst_from: '2026-11-01', dst_to: '2026-11-30',
    });
    await waitFor(() => expect(screen.queryByTestId('roll-preview')).toBeNull());
  });
});
