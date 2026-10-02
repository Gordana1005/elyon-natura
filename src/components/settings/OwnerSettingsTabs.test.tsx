import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '@/i18n';
import { formatMoney } from '@/lib/currency';
import type { IntegrationsHealth, LineProposal, SalesTeamsOverview, SalesUnmapped } from '@/lib/api';

// Render smoke tests for Settings → Teams and Settings → Integrations health
// against synthetic payloads shaped like the SQL functions' (no real people).
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
const setMode = vi.fn(async (mode: string) => ({ ok: true, mode, preview: null }));
const preview = vi.fn(async () => ({ candidates: 569, to_cancel: 522, needs_linking: 47, value_eur: 14295.13, mode: 'report', days: 7 }));
const addIdentity = vi.fn(async () => ({ ok: true, identity: {}, backstamped: 3 }));
const move = vi.fn(async () => ({ ok: true }));
const applyLines = vi.fn(async () => ({ ok: true, changed: 1, inserted: 0, unchanged: 0, people: 1 }));

const TODAY = '2026-09-28';
const m = (team_key: string, valid_from: string, valid_to: string | null = null) =>
  ({ id: `${team_key}-${valid_from}`, team_key, valid_from, valid_to, role: 'member', is_primary: true, note: null, created_at: '' });
const teams: SalesTeamsOverview = {
  today: TODAY,
  // teams = business lines (20260943000900): the two lines, a legacy key still holding Ana, an
  // emptied legacy key (not listed), management — in sales_teams.sort_order
  teams: [
    { key: 'teleshop', name: 'Тим Центар', leaderboard_mode: 'prediction', kind: 'line', sort_order: 10 },
    { key: 'affiliate', name: 'Тим Маџари', leaderboard_mode: 'pending', kind: 'line', sort_order: 20 },
    { key: 'altercpa_leads', name: 'Pending — AlterCPA leads', leaderboard_mode: 'pending', kind: 'legacy', sort_order: 40 },
    { key: 'crm_prediction', name: 'Prediction — ElyonCRM', leaderboard_mode: 'prediction', kind: 'legacy', sort_order: 41 },
    { key: 'management', name: 'Management', leaderboard_mode: null, kind: 'management', sort_order: 90 },
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
const proposal: LineProposal = {
  generated_at: '2026-09-28T00:10:00Z', days: 60, since: '2026-07-30T00:10:00Z',
  thresholds: { sure: 0.8, likely: 0.6, min_sales: 5 },
  summary: { people: 2, sure: 1, likely: 0, decide: 1, unchanged: 0, legacy: 1, no_team: 1 },
  rows: [
    { person_id: 'p1', display_name: 'Ana Test', has_login: true, is_active: true, is_manager: false, identity_kinds: ['altercpa_user'],
      current: { team_key: 'altercpa_leads', lane: null, kind: 'legacy', memberships: 1, lines: 0, legacy: true },
      basis: 'window', span: 'window',
      counts: { altercpa: 97, elyon_crm: 3, teleshop_other: 0, teleshop_out: 0, social: 0, other: 0, total: 100 },
      window_sales: 100, history_sales: 400, first_sale_at: null, last_sale_at: null,
      line_share: 1, lane_share: 0.97, share: 0.97, confidence: 'sure', proposed: { team_key: 'affiliate', lane: 'in' }, unchanged: false },
    { person_id: 'p3', display_name: 'Loose Test', has_login: false, is_active: true, is_manager: false, identity_kinds: [],
      current: { team_key: null, lane: null, kind: null, memberships: 0, lines: 0, legacy: false },
      basis: 'none', span: 'window', counts: { altercpa: 0, elyon_crm: 0, teleshop_other: 0, teleshop_out: 0, social: 0, other: 0, total: 0 },
      window_sales: 0, history_sales: 0, first_sale_at: null, last_sale_at: null,
      line_share: null, lane_share: null, share: null, confidence: 'decide', proposed: { team_key: null, lane: null }, unchanged: false },
  ],
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
    // collabBox since 20260942001400: last_ok_at = its last ok sync run, with a run log like the others
    { key: 'collabbox', status: 'ok', last_ok_at: '2026-09-28T00:03:00Z', last_run_at: '2026-09-28T00:00:05Z',
      data_through: '2026-09-27T20:41:00Z', detail: 'full sync every 15 min 07:00-22:59 (yesterday + today) + nightly 00:00',
      last_error: 'collabBox login: 502', last_error_at: '2026-09-27T09:15:00Z', runs_24h: 68, failed_24h: 1,
      rows: { lag_parcels: 34517 }, days: days.map((d) => day(d, 64, d === '2026-09-27' ? 1 : 0)),
      jobs: [
        { job: 'rolling', expect: 'cbx_15m', status: 'ok', last_ok_at: '2026-09-27T20:48:00Z', last_run_at: '2026-09-27T20:45:00Z',
          last_run_status: 'ok', last_error: null, last_error_at: null, runs_24h: 64, failed_24h: 0, rows_24h: 312 },
        { job: 'nightly', expect: 'nightly', status: 'ok', last_ok_at: '2026-09-28T00:03:00Z', last_run_at: '2026-09-28T00:00:05Z',
          last_run_status: 'ok', last_error: null, last_error_at: null, runs_24h: 1, failed_24h: 0, rows_24h: 40 },
        { job: 'manual', expect: 'manual', status: 'ok', last_ok_at: '2026-09-27T10:02:00Z', last_run_at: '2026-09-27T10:00:00Z',
          last_run_status: 'ok', last_error: 'collabBox login: 502', last_error_at: '2026-09-27T09:15:00Z', runs_24h: 3, failed_24h: 1, rows_24h: 0 },
      ] },
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
  apiGetLineProposal: vi.fn(async () => proposal),
  apiApplyTeamLines: (...a: unknown[]) => applyLines(...(a as [])),
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
    // teams by their words (never the English DB name), legacy marked; an emptied legacy team is not listed
    expect(screen.getByRole('heading', { name: new RegExp(`^${i18n.t('insights.agents.team.byKey.altercpa_leads').replace(/[()]/g, '\\$&')}`) })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Pending — AlterCPA leads/ })).toBeNull();
    expect(screen.queryByRole('heading', { name: new RegExp(`^${i18n.t('insights.agents.team.byKey.crm_prediction').replace(/[()]/g, '\\$&')}`) })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Тим Центар' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: i18n.t('settings.teams.noTeam') })).toBeInTheDocument();
    expect(screen.getByText('#4222')).toBeInTheDocument();
    expect(within(screen.getByRole('button', { name: /^Boss Test/ })).getByText(i18n.t('settings.teams.badge.manager'))).toBeInTheDocument();
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

describe('Settings → Teams — the business-line proposal', () => {
  it('opens by itself while someone waits for a line, shows the evidence and accepts one row', async () => {
    wrap(<TeamsTab />);
    const panel = await screen.findByRole('region', { name: i18n.t('teamLines.proposal.title') }, { timeout: 10_000 });
    expect(await within(panel).findByText(i18n.t('teamLines.proposal.count.sure', { n: 1 }), {}, { timeout: 10_000 })).toBeInTheDocument();
    expect(within(panel).getByText(`${i18n.t('leaderboard2.deptShort.altercpa')} 97`)).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: i18n.t('teamLines.proposal.acceptAllSure', { n: 1 }) })).toBeEnabled();
    // Ana's row: Affiliate · лидови proposed, accepted as is
    const ana = within(panel).getByText('Ana Test').closest('li')!;
    expect(within(ana).getByText(i18n.t('teamLines.proposal.confidence.sure'), { exact: false })).toBeInTheDocument();
    fireEvent.click(within(ana).getByRole('button', { name: i18n.t('teamLines.proposal.accept') }));
    await waitFor(() => expect(applyLines).toHaveBeenCalledWith([{ person_id: 'p1', team_key: 'affiliate', lane: 'in' }]));
    // Loose Test has nothing to go by: no team proposed, nothing to accept until one is picked
    const loose = within(panel).getByText('Loose Test').closest('li')!;
    expect(within(loose).getByRole('button', { name: i18n.t('teamLines.proposal.accept') })).toBeDisabled();
  }, 30_000);
});

describe('Settings → Teams — person drawer', () => {
  it('opens a person and moves them into a business line with its lane, previewing the change', async () => {
    wrap(<TeamsTab />);
    fireEvent.click(await screen.findByRole('button', { name: /^Loose Test/ }, { timeout: 10_000 }));
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByText(i18n.t('settings.teams.drawer.move'))).toBeInTheDocument();
    expect(within(dlg).getByText(i18n.t('settings.teams.drawer.historyEmpty'))).toBeInTheDocument();
    // default target = the first business line (Телешоп), its first lane; nothing to close for someone with no team
    expect(within(dlg).getByText(i18n.t('settings.teams.drawer.preview.none', { team: 'Тим Центар', from: '28.09.2026' }))).toBeInTheDocument();
    expect(within(dlg).getByText(i18n.t('teamLines.drawer.lane'))).toBeInTheDocument();
    fireEvent.click(within(dlg).getByRole('button', { name: i18n.t('settings.teams.drawer.moveButton') }));
    await waitFor(() => expect(move).toHaveBeenCalledWith('p3', { team_key: 'teleshop', from: expect.any(String), role: 'member', lane: 'in' }));
  }, 30_000);
});

describe('Settings → Integrations health', () => {
  it('shows every feed with an icon + word, the failing job, and collabBox with its run log like the others', async () => {
    wrap(<IntegrationsHealthTab />);
    const alter = await screen.findByRole('region', { name: 'AlterCPA' }, { timeout: 10_000 });
    expect(within(alter).getAllByText(i18n.t('settings.integrations.status.ok')).length).toBeGreaterThan(0);
    expect(within(alter).getByText(i18n.t('settings.integrations.status.failing'))).toBeInTheDocument();
    expect(within(alter).getByText(i18n.t('settings.integrations.job.nightly'))).toBeInTheDocument();
    const cb = screen.getByRole('region', { name: 'collabBox' });
    // last success = the last ok sync run (no longer "newest document"), runs, the strip and the jobs
    expect(within(cb).getByText(i18n.t('settings.integrations.lastOk'))).toBeInTheDocument();
    expect(within(cb).getByText(i18n.t('settings.integrations.runs24Value', { runs: 68, failed: 1 }))).toBeInTheDocument();
    expect(within(cb).getByText(i18n.t('settings.integrations.days7'))).toBeInTheDocument();
    expect(within(cb).queryByText(i18n.t('settings.integrations.noRunsYet'))).toBeNull();
    expect(within(cb).getByText(i18n.t('settings.integrations.job.rolling'))).toBeInTheDocument();
    expect(within(cb).getByText(i18n.t('settings.integrations.expect.cbx_15m'))).toBeInTheDocument();
    expect(within(cb).getByText(i18n.t('settings.integrations.job.manual'))).toBeInTheDocument();
    // the newest document the sync has read is its own row; the old error sits under the last success
    expect(within(cb).getByText(i18n.t('settings.integrations.newestDoc'))).toBeInTheDocument();
    expect(within(cb).getByText(`· ${i18n.t('settings.integrations.errorOld')}`)).toBeInTheDocument();
    // the NATURA backlog is not a 24 h count: no "came in, 24 h" heading on this card
    expect(within(cb).getByText('34.517')).toBeInTheDocument();
    expect(within(cb).queryByText(i18n.t('settings.integrations.rows24'))).toBeNull();
    expect(screen.getByText(i18n.t('settings.integrations.issues', { count: 1 }))).toBeInTheDocument();
  }, 30_000);

  it('switching the no-parcel rule to Apply states the exact count first, then switches', async () => {
    wrap(<IntegrationsHealthTab />);
    // The card's window comes from the payload (days_n), never a hardcoded 7.
    const np = await screen.findByRole('region', { name: i18n.t('settings.integrations.feed.no_parcel_rule', { days: 7 }) }, { timeout: 10_000 });
    const href = within(np).getByRole('link', { name: i18n.t('settings.integrations.np.openOrders') }).getAttribute('href') ?? '';
    const sp = new URLSearchParams(href.split('?')[1]);
    expect(href.startsWith('/orders?')).toBe(true);
    expect(sp.get('attention')).toBe('approved_no_parcel_7d');
    expect(sp.get('lbl')).toBe(i18n.t('overview.attention.kind.approved_no_parcel_7d', { days: 7 }));
    fireEvent.click(within(np).getByRole('switch'));
    const body = await screen.findByText((t) => t.includes('522') && t.includes(formatMoney(14295.13)));
    expect(body.textContent).toContain('21:10');
    fireEvent.click(screen.getByRole('button', { name: i18n.t('settings.integrations.np.confirmApply') }));
    await waitFor(() => expect(setMode).toHaveBeenCalledWith('apply'));
  }, 30_000);
});
