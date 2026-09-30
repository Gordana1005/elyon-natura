import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '@/i18n';
import { Toaster } from '@/components/ui/toaster';

// Поставки (Phase 10): the grouped list → one section (/settings/:section), who
// sees what, the module-off confirm + 10 s Undo, and the old ?tab= links. The
// api, the auth / permissions contexts and the layout are replaced by fixtures;
// the big sections are stubs (they have their own tests).
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: null } }) } },
}));
type Viewer = { id: string; isAdmin: boolean; isManager: boolean; roles: string[] };
const auth: { user: Viewer } = { user: { id: 'u-admin', isAdmin: true, isManager: true, roles: ['admin', 'manager'] } };
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));

const modules = [
  { module_key: 'orders', module_label: 'Orders', is_enabled: true, is_protected: false },
  { module_key: 'webhooks', module_label: 'Webhooks', is_enabled: true, is_protected: false },
  { module_key: 'settings', module_label: 'Settings', is_enabled: true, is_protected: true },
  { module_key: 'ads', module_label: 'Ads', is_enabled: true, is_protected: false },
];
const perms = { canSeeBusiness: true, canUsers: true };
const refresh = vi.fn(async () => {});
vi.mock('@/contexts/PermissionsContext', () => ({
  usePermissions: () => ({
    modules,
    rolePermissions: [{ role: 'pending_agent', module_key: 'orders', can_view: true, can_create: false, can_edit: true, can_delete: false, can_export: false }],
    financialVisibility: [],
    privacy: [{ role: 'pending_agent', show_customer_phone: true, show_customer_name: true, show_customer_address: true, show_order_history: true, show_segment_members: true, can_hear_recordings: false, can_hear_own_recordings: false }],
    canSeeBusiness: perms.canSeeBusiness,
    canAccessModule: (m: string) => (m === 'users' ? perms.canUsers : true),
    refresh,
  }),
}));
vi.mock('@/contexts/LanguageContext', () => ({ useLanguage: () => ({ language: 'mk', setLanguage: vi.fn() }) }));
vi.mock('@/layouts/AppLayout', () => ({
  AppLayout: ({ title, children }: { title: string; children: React.ReactNode }) => <div><h1>{title}</h1>{children}</div>,
}));
vi.mock('@/components/settings/TeamsTab', () => ({ TeamsTab: () => <div data-testid="teams-tab">TeamsTab</div> }));
vi.mock('@/components/settings/IntegrationsHealthTab', () => ({ IntegrationsHealthTab: () => <div data-testid="integrations-tab" /> }));
vi.mock('@/components/settings/PredictionEngineTab', () => ({ PredictionEngineTab: () => <div data-testid="engine-tab" /> }));
vi.mock('@/components/settings/TelephonyTab', () => ({ TelephonyTab: () => <div data-testid="telephony-tab" /> }));

const setModule = vi.fn(async () => ({ ok: true }));
vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiGetUsers: vi.fn(async () => [
    { user_id: 'u-admin', full_name: 'Миле', email: 'mile@elyon.com', is_active: true, roles: ['admin'] },
    { user_id: 'u2', full_name: 'Симона', email: 's@elyon-mk.local', is_active: true, roles: ['manager'] },
  ]),
  apiGetIntegrationsHealth: vi.fn(async () => ({ generated_at: '', today: '2026-10-01', feeds: [], no_parcel: null, cron: [] })),
  apiGetSalesUnmapped: vi.fn(async () => ({ days: 90, altercpa: [], unnamed: [], logins: [], orders: [{ ext: 'x', n: 1 }] })),
  apiGetBusinessOwners: vi.fn(async () => []),
  apiGetLeaderboardAdmin: vi.fn(async () => ({ mode: 'prediction', roster_date: '', roster: [], rules: [],
    tokens: [{ id: 't1', label: 'Office TV', token: 'tok123', is_active: true, created_at: '2026-06-30T10:00:00Z' }] })),
  apiGetSalesTeams: vi.fn(async () => ({ today: '2026-10-01', accounts: [], people: [], logins: [], teams: [
    { key: 'teleshop', name: 'Телешоп', leaderboard_mode: 'prediction', kind: 'line', sort_order: 10 },
    { key: 'affiliate', name: 'Affiliate', leaderboard_mode: 'pending', kind: 'line', sort_order: 20 },
    { key: 'crm_prediction', name: 'Prediction — ElyonCRM', leaderboard_mode: 'prediction', kind: 'legacy', sort_order: 41 },
    { key: 'management', name: 'Management', leaderboard_mode: null, kind: 'management', sort_order: 90 },
  ] })),
  apiGetCourierRates: vi.fn(async () => [{ courier: 'mex', service: 'door', deliver_cost: 2.439, return_cost: 0 }]),
  apiGetAppSettings: vi.fn(async () => ({ personal_list_max_holds: 50, unpaid_chase_days: 3, unpaid_chase_stop_days: 30, altercpa_push_enabled: true })),
  apiGetSettingsMeta: vi.fn(async () => ({ app_settings: {}, audit: {} })),
  apiSetModuleEnabled: (...a: unknown[]) => setModule(...(a as [])),
}));

beforeAll(async () => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  await i18n.changeLanguage('mk');
});
afterEach(() => {
  vi.clearAllMocks();
  auth.user = { id: 'u-admin', isAdmin: true, isManager: true, roles: ['admin', 'manager'] };
  perms.canSeeBusiness = true;
  perms.canUsers = true;
});

const { default: SettingsPage } = await import('./SettingsPage');

let path = '';
function LocationProbe() {
  const l = useLocation();
  path = `${l.pathname}${l.search}`;
  return null;
}
function renderAt(url: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/settings/:section" element={<SettingsPage />} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>
      <Toaster />
    </QueryClientProvider>,
  );
}
const t = (k: string, o?: Record<string, unknown>) => i18n.t(k, o) as string;
const nav = () => screen.getByRole('navigation', { name: t('settingsPage.navLabel') });
const navLink = (sectionKey: string) => within(nav()).getByRole('link', { name: new RegExp(t(`settingsPage.section.${sectionKey}.label`)) });

describe('Поставки — list → detail (a phone shows one at a time)', { timeout: 30_000 }, () => {
  it('/settings is the grouped list; a section opens with a back arrow and the list is hidden below lg', async () => {
    renderAt('/settings');
    expect(within(nav()).getByRole('heading', { name: t('settingsPage.group.people') })).toBeInTheDocument();
    expect(within(nav()).getByRole('heading', { name: t('settingsPage.group.personal') })).toBeInTheDocument();
    // the list is the page on a phone (no hidden class); the empty detail pane is lg-only
    expect(nav().className).not.toMatch(/(^|\s)hidden(\s|$)/);
    expect(screen.queryByRole('link', { name: new RegExp(t('settingsPage.back')) })).toBeNull();

    fireEvent.click(navLink('rules'));
    await waitFor(() => expect(path).toBe('/settings/rules'));
    // phone: the list hides, the section shows with "← Поставки"
    expect(nav().className).toMatch(/(^|\s)hidden(\s|$)/);
    expect(nav().className).toContain('lg:block');
    expect(await screen.findByText(t('settingsPage.rules.desc'))).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: t('settingsPage.rules.personalCap.title') })).toBeInTheDocument();
    expect(navLink('rules').getAttribute('aria-current')).toBe('page');

    fireEvent.click(screen.getByRole('link', { name: new RegExp(`^${t('settingsPage.back')}$`) }));
    await waitFor(() => expect(path).toBe('/settings'));
  });

  it('/settings/teams renders the Teams tab', async () => {
    renderAt('/settings/teams');
    expect(await screen.findByTestId('teams-tab')).toBeInTheDocument();
    // its list badge: the unmapped queue
    expect(await within(nav()).findByText(t('settingsPage.badge.unmapped', { count: 1 }))).toBeInTheDocument();
  });

  it('old deep links land on the new sections', async () => {
    renderAt('/settings?tab=leaderboard');
    await waitFor(() => expect(path).toBe('/settings/tv'));
    expect(await screen.findByRole('heading', { name: t('settingsPage.tv.title') })).toBeInTheDocument();
  });

  it('ТВ табла: a link per department, per business line and per lane — no legacy or management link', async () => {
    renderAt('/settings/tv');
    const links = await screen.findByRole('list', { name: t('settingsPage.tv.linksTitle') });
    const open = (label: string) => within(links).getByRole('link', { name: `${t('settingsPage.tv.open')} · ${label}` }).getAttribute('href') ?? '';
    const lbl = (k: string) => t(k);
    expect(open(t('settingsPage.tv.all'))).toMatch(/\/tv\/leaderboard\?key=tok123&lang=mk$/);
    expect(open(t('leaderboard2.dept.teleshopOther'))).toContain('dept=teleshop_other');
    expect(open(lbl('teamLines.label.teleshop_in'))).toContain(`team=${encodeURIComponent('teleshop:in')}`);
    expect(open(lbl('teamLines.label.affiliate_out'))).toContain(`team=${encodeURIComponent('affiliate:out')}`);
    expect(within(links).queryByText(/ElyonCRM|стар тим|Менаџмент|Management/)).toBeNull();
    // rotate asks first
    fireEvent.click(screen.getByRole('button', { name: new RegExp(t('settingsPage.tv.rotate')) }));
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
  });

  it('an unknown section goes back to the list', async () => {
    renderAt('/settings/nope');
    await waitFor(() => expect(path).toBe('/settings'));
  });
});

describe('Поставки — a manager never sees money', { timeout: 30_000 }, () => {
  it('sees only Корисници, Правила (read-only) and Лично', async () => {
    auth.user = { id: 'u2', isAdmin: false, isManager: true, roles: ['manager'] };
    perms.canSeeBusiness = false;
    renderAt('/settings');
    const links = within(nav()).getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(links).toEqual(['/settings/users', '/settings/rules', '/settings/personal']);
    for (const s of ['money', 'courier', 'partners', 'teams', 'integrations', 'access', 'tv', 'engine']) {
      expect(within(nav()).queryByText(t(`settingsPage.section.${s}.label`))).toBeNull();
    }
    expect(within(nav()).getByText(t('settingsPage.badge.readOnly'))).toBeInTheDocument();
  });

  it('a money section by URL says no access; the rules are read-only', async () => {
    auth.user = { id: 'u2', isAdmin: false, isManager: true, roles: ['manager'] };
    perms.canSeeBusiness = false;
    renderAt('/settings/courier');
    expect(await screen.findByText(t('settingsPage.noAccess'))).toBeInTheDocument();
    expect(screen.queryByText(t('settingsPage.courier.title'))).toBeNull();

    fireEvent.click(navLink('rules'));
    expect(await screen.findByText(t('settingsPage.rules.readOnlyNote'))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t('common.save') })).toBeNull();
    expect(screen.getByRole('switch', { name: t('settingsPage.rules.cpaPush.title') })).toBeDisabled();
  });
});

describe('Поставки → Пристап по улога — switching a module off', { timeout: 30_000 }, () => {
  it('asks first, then offers a 10-second Undo that switches it back on', async () => {
    renderAt('/settings/access');
    // dead modules (ads) are not offered; protected ones are locked
    expect(screen.queryByRole('switch', { name: 'Ads' })).toBeNull();
    expect(screen.getByRole('switch', { name: t('settingsPage.module.settings') })).toBeDisabled();

    fireEvent.click(screen.getByRole('switch', { name: t('settingsPage.module.webhooks') }));
    const dlg = await screen.findByRole('alertdialog');
    expect(within(dlg).getByText(t('settingsPage.access.offConfirmTitle', { module: t('settingsPage.module.webhooks') }))).toBeInTheDocument();
    expect(setModule).not.toHaveBeenCalled();

    fireEvent.click(within(dlg).getByRole('button', { name: t('settingsPage.access.offConfirm') }));
    await waitFor(() => expect(setModule).toHaveBeenCalledWith('webhooks', false));
    expect(refresh).toHaveBeenCalled();

    const undo = await screen.findByRole('button', { name: t('settingsPage.undo') });
    fireEvent.click(undo);
    await waitFor(() => expect(setModule).toHaveBeenLastCalledWith('webhooks', true));
  });

  it('cancel leaves the module on', async () => {
    renderAt('/settings/access');
    fireEvent.click(screen.getByRole('switch', { name: t('settingsPage.module.webhooks') }));
    const dlg = await screen.findByRole('alertdialog');
    fireEvent.click(within(dlg).getByRole('button', { name: t('common.cancel') }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(setModule).not.toHaveBeenCalled();
  });
});
