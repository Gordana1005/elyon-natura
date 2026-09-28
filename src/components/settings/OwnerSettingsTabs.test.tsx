import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '@/i18n';
import { formatMoney } from '@/lib/currency';
import type { IntegrationsHealth, SalesTeamsOverview, SalesUnmapped } from '@/lib/api';

// Render smoke tests for Settings → Teams and Settings → Integrations health
// against synthetic payloads shaped like the SQL functions' (no real people).
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
const setMode = vi.fn(async (mode: string) => ({ ok: true, mode, preview: null }));
const preview = vi.fn(async () => ({ candidates: 569, to_cancel: 522, needs_linking: 47, value_eur: 14295.13, mode: 'report', days: 7 }));
const addIdentity = vi.fn(async () => ({ ok: true, identity: {}, backstamped: 3 }));
const move = vi.fn(async () => ({ ok: true }));

const TODAY = '2026-09-28';
const m = (team_key: string, valid_from: string, valid_to: string | null = null) =>
  ({ id: `${team_key}-${valid_from}`, team_key, valid_from, valid_to, role: 'member', is_primary: true, note: null, created_at: '' });
const teams: SalesTeamsOverview = {
  today: TODAY,
  teams: [
    { key: 'altercpa_leads', name: 'Pending — AlterCPA leads', leaderboard_mode: 'pending' },
    { key: 'crm_prediction', name: 'Prediction — ElyonCRM', leaderboard_mode: 'prediction' },
    { key: 'management', name: 'Management', leaderboard_mode: null },
  ],
  accounts: [{ id: 'acc', name: 'main', is_active: true }],
  people: [
    { id: 'p1', display_name: 'Ana Test', user_id: 'u1', login_name: 'Ana Test', login_email: 'ana@example.test', login_active: true,
      login_roles: ['pending_agent'], is_active: true, is_manager: false, notes: null, created_at: '', last_activity_at: '2026-09-27T10:00:00Z',
      decisions_30d: 12, sales_30d: 4,
      identities: [{ id: 'i1', kind: 'altercpa_user', account_id: 'acc', value: '4222', note: null, created_at: '' }],
      memberships: [m('altercpa_leads', '2026-08-05')] },
    { id: 'p2', display_name: 'Boss Test', user_id: 'u2', login_name: 'Boss Test', login_email: 'boss@example.test', login_active: true,
      login_roles: ['admin'], is_active: true, is_manager: true, notes: null, created_at: '', last_activity_at: null,
      decisions_30d: 0, sales_30d: 0, identities: [], memberships: [m('management', '2026-08-01')] },
    { id: 'p3', display_name: 'Loose Test', user_id: null, login_name: null, login_email: null, login_active: null, login_roles: [],
      is_active: true, is_manager: false, notes: null, created_at: '', last_activity_at: null, decisions_30d: 0, sales_30d: 0,
      identities: [], memberships: [] },
  ],
  logins: [{ user_id: 'u9', full_name: 'Free Login', email: 'free@example.test', is_active: true, roles: ['agent'], person_id: null }],
};
const unmapped: SalesUnmapped = {
  days: 90,
  altercpa: [],
  unnamed: [],
  logins: [{ user_id: 'u9', full_name: 'Free Login', email: 'free@example.test', is_active: true, roles: ['agent'],
             last_seen_at: null, last_work_at: null, is_test: false }],
  orders: [{ ext: 'Ана  Тест', sold_via: 'collabbox', stamped: true, sale_source: 'collabbox', n: 61,
             first_at: '2026-09-01T07:00:00Z', last_at: '2026-09-18T07:00:00Z', sample: [{ id: 'o1', display_id: 'ORD-1' }],
             suggestion: { person_id: 'p1', display_name: 'Ana Test', match: 'near' } }],
};
const day = (d: string, ok: number, failed = 0) => ({ d, ok, failed });
const days = ['2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27', TODAY];
const health: IntegrationsHealth = {
  generated_at: '2026-09-28T00:10:00Z',
  today: TODAY,
  feeds: [
    { key: 'altercpa', status: 'ok', last_ok_at: '2026-09-28T00:08:00Z', last_run_at: '2026-09-28T00:08:00Z',
      last_error: 'stale: still running after 10 minutes', last_error_at: '2026-09-27T02:45:01Z', runs_24h: 890, failed_24h: 2,
      rows: { leads_new: 347, leads_mk: 224 }, days: days.map((d) => day(d, 887, 1)),
      jobs: [
        { job: 'rolling', expect: 'rolling_2m', status: 'ok', last_ok_at: '2026-09-28T00:08:00Z', last_run_at: '2026-09-28T00:08:00Z',
          last_run_status: 'ok', last_error: null, last_error_at: null, runs_24h: 720, failed_24h: 0, rows_24h: 347 },
        { job: 'nightly', expect: 'nightly', status: 'failing', last_ok_at: '2026-08-09T01:16:00Z', last_run_at: '2026-09-27T01:15:00Z',
          last_run_status: 'failed', last_error: 'stale: still running after 10 minutes', last_error_at: '2026-09-27T01:15:00Z',
          runs_24h: 1, failed_24h: 1, rows_24h: 0 },
      ] },
    { key: 'collabbox', status: 'stale', last_ok_at: '2026-09-18T07:00:00Z', last_run_at: null, data_through: '2026-09-18T07:00:00Z',
      detail: 'manual import', last_error: null, last_error_at: null, runs_24h: 0, failed_24h: 0, rows: { lag_parcels: 34517 }, jobs: [], days: null },
  ],
  no_parcel: {
    key: 'no_parcel_rule', status: 'ok', mode: 'report', days_n: 7, hour: 21, settings: {},
    last_ok_at: '2026-09-27T23:13:28Z', last_cron_run_at: null, next_run_at: '2026-09-28T19:10:00Z',
    last_run: { id: 'r1', run_day: TODAY, ran_at: '2026-09-27T23:13:28Z', mode: 'report', trigger_kind: 'manual', days: 7,
                candidates: 569, to_cancel: 522, needs_linking: 47, cancelled: 0, value_eur: 14295.13, cancelled_value_eur: 0 },
    cron_last_status: null, cron_last_at: null, last_error: null, runs_24h: 1, days: days.map((d) => day(d, d === TODAY ? 1 : 0)),
  },
  cron: [{ jobid: 6, jobname: 'altercpa-sync-rolling', schedule: '*/2 * * * *', active: true, status: 'ok', last_status: 'succeeded',
           last_start: '2026-09-28T00:08:00Z', last_end: '2026-09-28T00:08:00Z', last_message: '1 row', last_error: null,
           last_error_at: null, runs_24h: 720, failed_24h: 0, days: days.map((d) => day(d, 720)) }],
};

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiGetSalesTeams: vi.fn(async () => teams),
  apiGetSalesUnmapped: vi.fn(async () => unmapped),
  apiAddSalesIdentity: (...a: unknown[]) => addIdentity(...(a as [])),
  apiMoveSalesPerson: (...a: unknown[]) => move(...(a as [])),
  apiGetIntegrationsHealth: vi.fn(async () => health),
  apiGetNoParcelPreview: () => preview(),
  apiSetNoParcelMode: (mode: string) => setMode(mode),
}));

beforeAll(async () => {
  await i18n.changeLanguage('mk');
});

const { TeamsTab } = await import('./TeamsTab');
const { IntegrationsHealthTab } = await import('./IntegrationsHealthTab');

const wrap = (ui: React.ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>);
};

describe('Settings → Teams', () => {
  it('lists people by team, a no-team column, and the unmapped queue with its hint', async () => {
    wrap(<TeamsTab />);
    expect((await screen.findAllByText('Ana Test', {}, { timeout: 10_000 })).length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: 'Pending — AlterCPA leads' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: i18n.t('settings.teams.noTeam') })).toBeInTheDocument();
    expect(screen.getByText('#4222')).toBeInTheDocument();
    expect(screen.getByText(i18n.t('settings.teams.badge.manager'))).toBeInTheDocument();
    expect(await screen.findByText(i18n.t('settings.teams.unmapped.suggestNear', { name: 'Ana Test' }))).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'ORD-1' }).getAttribute('href')).toBe('/orders?search=ORD-1');
  }, 30_000);

  it('assigns an unmapped spelling to the suggested person as a collabBox author', async () => {
    wrap(<TeamsTab />);
    await screen.findByText(i18n.t('settings.teams.unmapped.suggestNear', { name: 'Ana Test' }), {}, { timeout: 10_000 });
    const btns = screen.getAllByRole('button', { name: i18n.t('settings.teams.unmapped.assign') });
    fireEvent.click(btns[btns.length - 1]);
    await waitFor(() => expect(addIdentity).toHaveBeenCalledWith('p1', { kind: 'collabbox_author', value: 'Ана  Тест' }));
  }, 30_000);
});

describe('Settings → Teams — person drawer', () => {
  it('opens a person and moves them to a team from today, previewing the change', async () => {
    wrap(<TeamsTab />);
    fireEvent.click(await screen.findByRole('button', { name: /Loose Test/ }, { timeout: 10_000 }));
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByText(i18n.t('settings.teams.drawer.move'))).toBeInTheDocument();
    expect(within(dlg).getByText(i18n.t('settings.teams.drawer.historyEmpty'))).toBeInTheDocument();
    // default target = the first team; nothing to close for someone with no team
    expect(within(dlg).getByText(i18n.t('settings.teams.drawer.preview.none', { team: 'Pending — AlterCPA leads', from: '28.09.2026' }))).toBeInTheDocument();
    fireEvent.click(within(dlg).getByRole('button', { name: i18n.t('settings.teams.drawer.moveButton') }));
    await waitFor(() => expect(move).toHaveBeenCalledWith('p3', { team_key: 'altercpa_leads', from: expect.any(String), role: 'member' }));
  }, 30_000);
});

describe('Settings → Integrations health', () => {
  it('shows every feed with an icon + word, the failing job, and collabBox without a run strip', async () => {
    wrap(<IntegrationsHealthTab />);
    const alter = await screen.findByRole('region', { name: 'AlterCPA' }, { timeout: 10_000 });
    expect(within(alter).getAllByText(i18n.t('settings.integrations.status.ok')).length).toBeGreaterThan(0);
    expect(within(alter).getByText(i18n.t('settings.integrations.status.failing'))).toBeInTheDocument();
    expect(within(alter).getByText(i18n.t('settings.integrations.job.nightly'))).toBeInTheDocument();
    const cb = screen.getByRole('region', { name: 'collabBox' });
    expect(within(cb).getByText(i18n.t('settings.integrations.noRunsYet'))).toBeInTheDocument();
    expect(within(cb).getByText('34.517')).toBeInTheDocument();
    expect(screen.getByText(i18n.t('settings.integrations.issues', { count: 2 }))).toBeInTheDocument();
  }, 30_000);

  it('switching the 7-day rule to Apply states the exact count first, then switches', async () => {
    wrap(<IntegrationsHealthTab />);
    const np = await screen.findByRole('region', { name: i18n.t('settings.integrations.feed.no_parcel_rule') }, { timeout: 10_000 });
    expect(within(np).getByRole('link', { name: i18n.t('settings.integrations.np.openOrders') }).getAttribute('href'))
      .toBe('/orders?attention=approved_no_parcel_7d');
    fireEvent.click(within(np).getByRole('switch'));
    const body = await screen.findByText((t) => t.includes('522') && t.includes(formatMoney(14295.13)));
    expect(body.textContent).toContain('21:10');
    fireEvent.click(screen.getByRole('button', { name: i18n.t('settings.integrations.np.confirmApply') }));
    await waitFor(() => expect(setMode).toHaveBeenCalledWith('apply'));
  }, 30_000);
});
