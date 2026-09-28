import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '@/i18n';
import type { WorkDayResponse, WorkResponse } from '@/lib/insightsApi/work';
import { buildWorkDayResponse, buildWorkResponse, parseWorkDay } from '../../../../supabase/functions/api/insightsWork';
import { overviewWindows } from '../../../../supabase/functions/api/overview';

// Render smoke test for Insights → Work: the payload is built by the api's own
// shaper from an insights_work-shaped fixture, the network is mocked.
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u-test', isAdmin: true, isManager: false } }),
}));
const work = vi.fn();
const workDay = vi.fn();
vi.mock('@/lib/insightsApi/work', async (orig) => ({
  ...(await orig<typeof import('@/lib/insightsApi/work')>()),
  apiGetInsightsWork: (...a: unknown[]) => work(...a),
  apiGetInsightsWorkDay: (...a: unknown[]) => workDay(...a),
}));

beforeAll(async () => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  await i18n.changeLanguage('mk');
});

const { default: CallActivityTab } = await import('./CallActivityTab');

const NOW = new Date('2026-09-28T10:00:00Z');
const ANITA = '11111111-1111-1111-1111-111111111111';
const NINA = '22222222-2222-2222-2222-222222222222';

function payload(): WorkResponse {
  const win = overviewWindows('2026-09-22', '2026-09-28', true, NOW);
  if ('error' in win) throw new Error(win.error);
  return buildWorkResponse({
    meta: { gran: 'day', presence_since: '2026-09-28', work_since: '2026-08-05T06:27:26Z', calls_since: '2026-08-06T11:58:47Z', self: false },
    totals: {
      worked: 2642, via_crm: 1781, via_altercpa: 861, sale: 489, cancel: 1426, trash: 727, callback: 0, no_answer: 793,
      call_logs: 796, timed_calls: 3, handling_sec: 23, people: 29, people_crm: 21, people_altercpa: 10, worked_tracked: 20,
      sale_tracked: 4, presence_people: 3, online_min: 579, active_min: 320, idle_min: 200, break_min: 59, idle_alerts: 2,
      breaks: 1, break_logged_min: 15, days_active: 7,
    },
    prev: { worked: 2852, via_crm: 1500, via_altercpa: 1352, sale: 479, cancel: 1600, trash: 773, callback: 0, no_answer: 1394, call_logs: 1400, timed_calls: 5, people: 30 },
    teams: [
      { team_key: 'altercpa_leads', name: 'Pending — AlterCPA leads', mode: 'pending' },
      { team_key: 'crm_prediction', name: 'Prediction — ElyonCRM', mode: 'prediction' },
      { team_key: 'management', name: 'Management', mode: null },
    ],
    people: [
      {
        person_id: ANITA, name: 'Anita Koligova', has_login: true, is_manager: false, is_active: true, team_key: 'crm_prediction',
        role: 'member', online_state: 'online', worked: 331, via_crm: 331, via_altercpa: 0, sale: 43, cancel: 200, trash: 88,
        callback: 0, no_answer: 380, call_logs: 380, timed_calls: 0, handling_sec: 0, days_active: 6,
        first_at: '2026-09-22T06:00:00Z', last_at: '2026-09-28T09:00:00Z', avg_start_min: 490, avg_end_min: 960,
        worked_tracked: 20, sale_tracked: 4, presence_days: 1, online_min: 300, active_min: 200, idle_min: 80, break_min: 20, idle_alerts: 1,
      },
      {
        person_id: NINA, name: 'Nina', has_login: true, is_manager: true, is_active: true, team_key: 'altercpa_leads',
        role: 'member', online_state: 'offline', worked: 404, via_crm: 0, via_altercpa: 404, sale: 334, cancel: 50, trash: 20,
        callback: 0, no_answer: 0, call_logs: 0, days_active: 5, avg_start_min: 1300, avg_end_min: 1400,
      },
    ],
    per_day: [
      { d: '2026-09-22', team_key: 'crm_prediction', worked: 60, sale: 8, cancel: 40, trash: 12, callback: 0, no_answer: 70, call_logs: 70, people: 1 },
      { d: '2026-09-23', team_key: 'altercpa_leads', worked: 80, sale: 60, cancel: 15, trash: 5, callback: 0, no_answer: 0, call_logs: 0, people: 1 },
    ],
    by_hour: [{ p: ANITA, h: 9, d: 12, c: 30 }, { p: NINA, h: 22, d: 40, c: 0 }],
    callbacks: {
      leads: { total: 43, unassigned: 43, over_24h: 36, expiring_24h: 0, no_since: 0, oldest_since: '2026-09-24T09:40:07Z' },
      prediction: { total: 535, unassigned: 464, over_24h: 535, expiring_24h: 104, no_since: 0, oldest_since: '2026-09-22T07:04:29Z' },
      window_days: 6,
    },
    quality: { no_person: 0, no_person_top: [], unmapped_calls: 0, unmapped_callers: 0, days_before_presence: 6, presence_gap_days: 0, people_no_login: 1 },
  }, {
    gran: 'day', total: 58, no_seller: 80,
    rows: [{ p: ANITA, b: '2026-09-22', n: 20 }, { p: NINA, b: '2026-09-23', n: 38 }],
  }, { gran: 'day', total: 60, no_seller: 1, rows: [] }, win, { self: false, now: NOW }) as unknown as WorkResponse;
}

function dayPayload(): WorkDayResponse {
  const d = parseWorkDay('2026-09-28', NOW);
  if ('error' in d) throw new Error(d.error);
  return buildWorkDayResponse({
    meta: { day: '2026-09-28', presence_since: '2026-09-28' },
    people: [{
      person_id: ANITA, name: 'Anita Koligova', has_login: true, team_key: 'crm_prediction', online_state: 'online',
      presence: { first_seen: '2026-09-28T05:14:00Z', last_seen: '2026-09-28T09:30:00Z', online_min: 250, active_min: 180, idle_min: 60, break_min: 10, idle_alerts: 0 },
      logins: ['2026-09-28T05:14:00Z'], breaks: [],
      decisions: [{ at: '2026-09-28T06:00:00Z', o: 'sale', via: 'crm' }],
      calls: [{ at: '2026-09-28T05:50:00Z', o: 'no_answer', timed: false, sec: 0 }],
    }],
    unattributed: { decisions: 0, calls: 0 },
  }, d, { self: false, now: NOW }) as unknown as WorkDayResponse;
}

function renderTab(url = '/insights?tab=call-activity&range=custom&from=2026-09-22&to=2026-09-28') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}>
        <CallActivityTab />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Insights → Work', () => {
  it('shows the work ledger, people, credited drill links, queues and quality — and no money', async () => {
    work.mockResolvedValue(payload());
    workDay.mockResolvedValue(dayPayload());
    const { container } = renderTab();

    // KPI: decisions (both ledgers) with the CRM / AlterCPA split in words.
    expect(await screen.findByText('2.642', {}, { timeout: 10_000 })).toBeInTheDocument();
    expect(work).toHaveBeenCalledWith({ from: '2026-09-22', to: '2026-09-28', compare: true }, expect.anything());
    expect(screen.getByText(i18n.t('insights.calls.kpi.workedSub', { crm: '1.781', acpa: '861' }))).toBeInTheDocument();
    // The VOIP caveat is said on screen, and presence's start date.
    expect(screen.getByText(i18n.t('insights.calls.caveat.voip'))).toBeInTheDocument();
    expect(screen.getByText(i18n.t('insights.calls.caveat.presence', { date: '28.09.2026' }))).toBeInTheDocument();

    // The people table: Nina (AlterCPA panel, no call logs) is a row like everyone else.
    const table = screen.getByRole('table', { name: i18n.t('insights.calls.people.title') });
    const nina = within(table).getByRole('rowheader', { name: /Nina/ }).closest('tr')!;
    expect(within(nina).getByText('404')).toBeInTheDocument();
    // Credited sales open the cohort's own list for that person and period.
    const anita = within(table).getByRole('rowheader', { name: /Anita Koligova/ }).closest('tr')!;
    const link = within(anita).getByRole('link', { name: '20' });
    expect(link.getAttribute('href')).toBe(`/orders?sold_by_person_id=${ANITA}&sold_from=2026-09-22&sold_to=2026-09-28&cohort_bucket=total&lbl=Anita+Koligova`);

    // Teams side by side + the Teleshop placeholder.
    expect(screen.getAllByText(i18n.t('insights.calls.team.pending')).length).toBeGreaterThan(0);
    expect(screen.getByText(i18n.t('insights.calls.teams.teleshopNote'))).toBeInTheDocument();

    // The call-again queues (now) and the quality rail (no seller yet = 80).
    expect(screen.getAllByText('535').length).toBe(2); // total + waiting over 24 h
    expect(screen.getByText(i18n.t('insights.calls.quality.kind.noSeller'))).toBeInTheDocument();

    // The swimlane loads the period's last day.
    expect(await screen.findByText('28.09.2026')).toBeInTheDocument();
    expect(workDay).toHaveBeenCalledWith('2026-09-28', expect.anything());

    // No money on this tab — not one denar, not one euro.
    expect(container.textContent).not.toMatch(/\d ден(?![а-яѓќљњџѕ])|€/);
  });

  it('a failed load says so, with a retry', async () => {
    work.mockRejectedValue(new Error('HTTP 500'));
    renderTab();
    expect(await screen.findByText(i18n.t('insights.loadFailed'), {}, { timeout: 10_000 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: i18n.t('common.retry') })).toBeInTheDocument();
  });

  it('a team chip narrows the tiles to that team', async () => {
    work.mockResolvedValue(payload());
    workDay.mockResolvedValue(dayPayload());
    renderTab('/insights?tab=call-activity&range=custom&from=2026-09-22&to=2026-09-28&wteam=altercpa_leads');
    expect(await screen.findByText(i18n.t('insights.calls.kpi.filtered', { team: i18n.t('insights.calls.team.pending') }), {}, { timeout: 10_000 })).toBeInTheDocument();
  });
});
