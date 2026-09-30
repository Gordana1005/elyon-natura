import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import i18n from '@/i18n';

// Тим → Корисници: the Insights-style page with search (Cyrillic ⇄ Latin),
// KPI tiles that filter, role chips, status, clear, the URL state and the
// manager rule. GET /api/users is replaced by a fixture; the layout by a shell.
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: null } }) } },
}));
const auth: { user: { id: string; isAdmin: boolean; isManager: boolean } } = {
  user: { id: 'u-admin', isAdmin: true, isManager: false },
};
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('@/layouts/AppLayout', () => ({
  AppLayout: ({ title, children }: { title: string; children: React.ReactNode }) => <div><h1>{title}</h1>{children}</div>,
}));
const getUsers = vi.fn();
const setRoles = vi.fn();
const toggleActive = vi.fn();
vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiGetUsers: (...a: unknown[]) => getUsers(...a),
  apiSetUserRoles: (...a: unknown[]) => setRoles(...a),
  apiToggleUserActive: (...a: unknown[]) => toggleActive(...a),
  apiDeleteUser: vi.fn(),
  apiUpdateUser: vi.fn(),
}));

beforeAll(async () => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  await i18n.changeLanguage('mk');
});
afterEach(() => {
  vi.clearAllMocks();
  auth.user = { id: 'u-admin', isAdmin: true, isManager: false };
});

const { default: UsersPage } = await import('./UsersPage');

const now = Date.now();
const ago = (ms: number) => new Date(now - ms).toISOString();
const user = (user_id: string, full_name: string, email: string, roles: string[], extra: Record<string, unknown> = {}) => ({
  user_id, full_name, email, roles, role: roles[0], is_active: true, orders_processed: 0, leads_processed: 0,
  created_at: '2026-08-01T10:00:00Z', last_seen_at: null, ...extra,
});
const USERS = [
  user('u-admin', 'Миле Стоев', 'mile@elyon.com', ['admin'], { last_seen_at: ago(30_000) }),
  user('u1', 'Ивана Петровска', 'ivana.p@elyon-mk.local', ['pending_agent'], { orders_processed: 120, last_seen_at: ago(60_000) }),
  user('u2', 'Марија Темелковска', 'marija.m@elyon-mk.local', ['manager'], { orders_processed: 40, last_seen_at: ago(3 * 3_600_000) }),
  user('u3', 'Ружица Паризовска', 'ruzhica@elyon-mk.local', ['prediction_agent'], { is_active: false }),
  user('u4', 'Kristina Danevska', 'kristina@elyon-mk.local', ['pending_agent', 'prediction_agent'], { last_seen_at: ago(10 * 86_400_000) }),
];

let location = '';
function LocationProbe() {
  location = useLocation().search;
  return null;
}
function renderAt(url = '/users', rows: unknown = USERS) {
  getUsers.mockResolvedValue(structuredClone(rows));
  return render(
    <MemoryRouter initialEntries={[url]}>
      <UsersPage />
      <LocationProbe />
    </MemoryRouter>,
  );
}

const t = (k: string, o?: Record<string, unknown>) => i18n.t(k, o) as string;
const table = () => screen.getByRole('table', { name: t('nav.users') });
/** The names in the table, in order (the row header holds name + e-mail). */
const shownNames = () =>
  within(table()).getAllByRole('rowheader').map((h) => USERS.find((u) => h.textContent?.includes(u.full_name))?.full_name);
const toolbar = () => screen.getByRole('search');
const searchBox = () => within(toolbar()).getByRole('searchbox', { name: t('settings.searchNameEmail') });
const kpis = () => screen.getByRole('region', { name: t('users.kpi.title') });

describe('Корисници — search, filters, KPI tiles', { timeout: 30_000 }, () => {
  it('shows the KPI tiles with the counts', async () => {
    renderAt();
    await screen.findByRole('table', { name: t('nav.users') }, { timeout: 10_000 });
    const tile = (label: string) => within(kpis()).getByRole('button', { name: new RegExp(`^${label}`) });
    expect(tile(t('users.kpi.total')).textContent).toContain('5');
    expect(tile(t('users.filter.active')).textContent).toContain('4');
    expect(tile(t('users.filter.suspended')).textContent).toContain('1');
    expect(tile(t('users.kpi.online')).textContent).toContain('2');
    // the per-role counts
    expect(within(kpis()).getByRole('button', { name: new RegExp(t('userRole.pending_agent')) }).textContent).toContain('2');
    expect(shownNames()).toHaveLength(5);
    expect(screen.getByTestId('users-shown').textContent).toBe(t('users.filter.shown', { shown: 5, total: 5 }));
  });

  it('typing "ivana" finds "Ивана Петровска", and Cyrillic finds a Latin name', async () => {
    renderAt();
    await screen.findByRole('table', { name: t('nav.users') }, { timeout: 10_000 });
    fireEvent.change(searchBox(), { target: { value: 'ivana' } });
    expect(shownNames()).toEqual(['Ивана Петровска']);
    // the match is marked in the name
    expect(within(table()).getAllByText('Ивана', { selector: 'mark' }).length).toBeGreaterThan(0);
    expect(screen.getByTestId('users-shown').textContent).toBe(t('users.filter.shown', { shown: 1, total: 5 }));
    // … and the URL follows (a reload keeps it)
    await waitFor(() => expect(new URLSearchParams(location).get('q')).toBe('ivana'));

    fireEvent.change(searchBox(), { target: { value: 'Кристина' } });
    expect(shownNames()).toEqual(['Kristina Danevska']);
    fireEvent.change(searchBox(), { target: { value: 'ruzhica pariz' } });
    expect(shownNames()).toEqual(['Ружица Паризовска']);

    // Esc clears the search
    fireEvent.keyDown(searchBox(), { key: 'Escape' });
    expect((searchBox() as HTMLInputElement).value).toBe('');
    expect(shownNames()).toHaveLength(5);
  });

  it('a role chip filters (several = any of them) and a tile applies its filter', async () => {
    renderAt();
    await screen.findByRole('table', { name: t('nav.users') }, { timeout: 10_000 });
    const roles = within(toolbar()).getByRole('group', { name: t('usersPage.colRoles') });
    const manager = within(roles).getByRole('button', { name: new RegExp(t('userRole.manager')) });
    fireEvent.click(manager);
    expect(manager).toHaveAttribute('aria-pressed', 'true');
    expect(shownNames()).toEqual(['Марија Темелковска']);
    fireEvent.click(within(roles).getByRole('button', { name: new RegExp(t('userRole.admin')) }));
    expect(shownNames()).toEqual(['Марија Темелковска', 'Миле Стоев']);
    expect(new URLSearchParams(location).getAll('role')).toEqual(['manager', 'admin']);

    // the "Онлајн сега" tile: only the two seen in the last 2 minutes (and still a manager or admin)
    fireEvent.click(within(kpis()).getByRole('button', { name: new RegExp(`^${t('users.kpi.online')}`) }));
    expect(shownNames()).toEqual(['Миле Стоев']);
  });

  it('the status filter, then "Исчисти филтри" brings everyone back', async () => {
    renderAt();
    await screen.findByRole('table', { name: t('nav.users') }, { timeout: 10_000 });
    const status = within(toolbar()).getByRole('group', { name: t('settings.colStatus') });
    fireEvent.click(within(status).getByRole('button', { name: t('users.filter.suspended') }));
    expect(shownNames()).toEqual(['Ружица Паризовска']);
    expect(new URLSearchParams(location).get('status')).toBe('suspended');

    fireEvent.change(searchBox(), { target: { value: 'nobody' } });
    expect(screen.queryByRole('table', { name: t('nav.users') })).toBeNull();
    expect(screen.getByText(t('settings.noUsersFound'))).toBeInTheDocument();
    expect(screen.getByText(t('users.filter.noMatch'))).toBeInTheDocument();

    fireEvent.click(within(toolbar()).getByRole('button', { name: t('settings.clearFilters') }));
    expect(shownNames()).toHaveLength(5);
    expect((searchBox() as HTMLInputElement).value).toBe('');
    await waitFor(() => expect(location).toBe(''));
  });

  it('opens with the filters of the URL', async () => {
    renderAt('/users?q=petrovska&role=pending_agent&sort=orders');
    await screen.findByRole('table', { name: t('nav.users') }, { timeout: 10_000 });
    expect((searchBox() as HTMLInputElement).value).toBe('petrovska');
    expect(shownNames()).toEqual(['Ивана Петровска']);
    fireEvent.change(searchBox(), { target: { value: '' } });
    // the role from the URL still holds, sorted by orders, most first
    expect(shownNames()).toEqual(['Ивана Петровска', 'Kristina Danevska']);
    expect(within(toolbar()).getByRole('combobox', { name: t('users.filter.sort') })).toHaveValue('orders');
  });

  it('speaks Macedonian: no English leftovers, no missing keys', async () => {
    const { container } = renderAt();
    await screen.findByRole('table', { name: t('nav.users') }, { timeout: 10_000 });
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/⟪/);
    expect(text).not.toMatch(/\b(Users?|Active|Suspended|Search|Roles?|Showing|Clear|Edit|Delete|Online|Total|Status|Sort|Orders|Leads|Created|Actions|never|ago)\b/);
    expect(text).toContain(t('users.subtitle'));
  });
});

describe('Корисници — who may change what', { timeout: 30_000 }, () => {
  it('an admin toggles a role and the active switch; nobody changes themselves', async () => {
    setRoles.mockResolvedValue({});
    toggleActive.mockResolvedValue({});
    renderAt();
    await screen.findByRole('table', { name: t('nav.users') }, { timeout: 10_000 });
    const row = (name: string) => within(table()).getByRole('rowheader', { name: new RegExp(name) }).closest('tr')!;

    // "Уреди улоги" opens every role an admin may hand out; a click saves at once
    fireEvent.click(within(row('Ивана Петровска')).getByRole('button', { name: t('users.row.editRolesFor', { name: 'Ивана Петровска' }) }));
    const editor = await screen.findByRole('dialog');
    expect(within(editor).getByRole('button', { name: new RegExp(t('userRole.pending_agent')) })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(editor).getByRole('button', { name: new RegExp(t('userRole.warehouse')) }));
    await waitFor(() => expect(setRoles).toHaveBeenCalledWith('u1', ['pending_agent', 'warehouse']));

    fireEvent.click(within(row('Ивана Петровска')).getByRole('switch'));
    await waitFor(() => expect(toggleActive).toHaveBeenCalledWith('u1'));

    // nobody changes themselves
    expect(within(row('Миле Стоев')).getByRole('switch')).toBeDisabled();
    expect(within(row('Миле Стоев')).queryByRole('button', { name: t('users.row.editRolesFor', { name: 'Миле Стоев' }) })).toBeNull();
  });

  it('a manager manages only pending / prediction agents, and hands out only those roles', async () => {
    auth.user = { id: 'u2', isAdmin: false, isManager: true };
    renderAt();
    await screen.findByRole('table', { name: t('nav.users') }, { timeout: 10_000 });
    const row = (name: string) => within(table()).getByRole('rowheader', { name: new RegExp(name) }).closest('tr')!;
    expect(within(row('Миле Стоев')).getByRole('switch')).toBeDisabled();
    expect(within(row('Миле Стоев')).queryByRole('button', { name: t('users.row.actions', { name: 'Миле Стоев' }) })).toBeNull();
    expect(within(row('Миле Стоев')).queryByRole('button', { name: t('users.row.editRolesFor', { name: 'Миле Стоев' }) })).toBeNull();
    const ivana = row('Ивана Петровска');
    expect(within(ivana).getByRole('switch')).not.toBeDisabled();
    fireEvent.click(within(ivana).getByRole('button', { name: t('users.row.editRolesFor', { name: 'Ивана Петровска' }) }));
    const editor = await screen.findByRole('dialog');
    const offered = within(editor).getAllByRole('button').map((b) => b.textContent);
    expect(offered).toEqual([t('userRole.pending_agent'), t('userRole.prediction_agent')]);
  });

  it('a failed load says so, and retry loads', async () => {
    getUsers.mockRejectedValueOnce(new Error('boom'));
    render(<MemoryRouter initialEntries={['/users']}><UsersPage /></MemoryRouter>);
    const retry = await screen.findByRole('button', { name: t('common.retry') }, { timeout: 10_000 });
    getUsers.mockResolvedValueOnce(structuredClone(USERS));
    fireEvent.click(retry);
    await screen.findByRole('table', { name: t('nav.users') }, { timeout: 10_000 });
    expect(shownNames()).toHaveLength(5);
  });
});
