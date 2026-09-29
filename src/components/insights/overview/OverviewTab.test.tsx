import { describe, expect, it, vi, beforeAll, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '@/i18n';
import type { OverviewResponse } from '@/lib/api';
import type { PeopleResponse } from '@/lib/insightsApi/agents';
import { eurToDen, formatDenari, formatMoney } from '@/lib/currency';
import sample from './__fixtures__/overview.sample.json';
import cohortSample from '../shared/__fixtures__/cohort.sample.json';
import peopleSample from '../agents/__fixtures__/people.sample.json';
import { stripMoney } from './model';

// The Overview after the 29.09.2026 clean-up, rendered from the contract fixtures:
// no pre-cohort widget is drawn (KPI tiles, source rows, the drill-down pivot), a
// missing cohort is an error with a retry, one Overview request per view, the
// trend's sales line is the cohort's, the teams are the Agents tab's and the
// attention rail speaks денари. The network is replaced by the fixtures.
const h = vi.hoisted(() => ({ overview: vi.fn(), agents: vi.fn(), pivot: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u-test', isAdmin: true, isManager: false } }),
}));
vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiGetInsightsOverview: (...a: unknown[]) => h.overview(...a),
  apiGetInsightsPivot: (...a: unknown[]) => h.pivot(...a),
  apiGetLeaderboardAdmin: vi.fn(async () => ({ tokens: [{ token: 'tv-token', is_active: true }] })),
}));
vi.mock('@/lib/insightsApi/agents', async (orig) => ({
  ...(await orig<typeof import('@/lib/insightsApi/agents')>()),
  apiGetInsightsAgents: (...a: unknown[]) => h.agents(...a),
}));

// jsdom has no layout engine; Recharts' ResponsiveContainer only needs the API.
beforeAll(async () => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  await i18n.changeLanguage('mk');
});
beforeEach(() => {
  h.overview.mockReset();
  h.agents.mockReset();
  h.pivot.mockReset();
  try { localStorage.removeItem('elyon.overview.sourcesView'); } catch { /* no storage */ }
});

const { default: OverviewTab } = await import('./OverviewTab');

type WithCohort = OverviewResponse & { cohort?: unknown };
const withCohort = (): WithCohort => ({ ...(structuredClone(sample) as unknown as OverviewResponse), cohort: structuredClone(cohortSample) });
const noCohort = (): WithCohort => ({ ...(structuredClone(sample) as unknown as OverviewResponse), cohort: null });
const people = (money = true): PeopleResponse => {
  const d = structuredClone(peopleSample) as unknown as PeopleResponse;
  d.meta = { ...d.meta, access: 'owner', money: true };
  if (money) return d;
  const strip = (v: unknown): unknown => (Array.isArray(v) ? v.map(strip) : v && typeof v === 'object'
    ? Object.fromEntries(Object.entries(v).filter(([k]) => !/_mkd$/.test(k)).map(([k, x]) => [k, strip(x)])) : v);
  const s = strip(d) as PeopleResponse;
  s.meta = { ...s.meta, access: 'counts', money: false };
  return s;
};

function renderWith(p: WithCohort, opts: { query?: string; agents?: PeopleResponse } = {}) {
  h.overview.mockResolvedValue(p);
  h.agents.mockResolvedValue(opts.agents ?? people());
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/insights?tab=overview&range=custom&from=2026-09-22&to=2026-09-28${opts.query ?? ''}`]}>
        <OverviewTab />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const PERIOD = '22.09 – 28.09.2026';
const cohortTitle = () => i18n.t('overview.cohort.title', { period: PERIOD });
const DENARS = /\d ден(?![а-яѓќљњџѕ])/;
const attentionCard = (kind: string) =>
  screen.getByText(i18n.t(`overview.attention.kind.${kind}`, { days: 10 })).closest('li')!;

describe('Overview — no pre-cohort widget', () => {
  it('a missing cohort is an error with a retry: never the old KPI tiles or source rows', async () => {
    const { container } = renderWith(noCohort());
    expect(await screen.findByText(i18n.t('overview.cohort.loadFailed'), {}, { timeout: 10_000 })).toBeInTheDocument();
    // the old hero (created-day MEX cash tile), its EUR "placed" tile and the source rows are gone
    expect(screen.queryByText(formatDenari(3036660))).toBeNull();
    expect(screen.queryByText(formatMoney(94614.87))).toBeNull();
    expect(screen.queryByRole('heading', { name: i18n.t('overview.sources.title') })).toBeNull();
    expect(container.textContent).not.toMatch(/€|EUR\b/);
    // the rest of the page still answers: freshness, the trend (MEX cash), teams, attention
    expect(screen.getByRole('heading', { name: i18n.t('overview.trend.title') })).toBeInTheDocument();
    expect(screen.getByText(i18n.t('overview.attention.kind.approved_no_parcel_7d', { days: 10 }))).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: i18n.t('common.retry') }));
    await vi.waitFor(() => expect(h.overview).toHaveBeenCalledTimes(2));
  }, 30_000);

  it('the drill-down pivot is not drawn and never fetched', async () => {
    renderWith(withCohort());
    await screen.findByText(cohortTitle(), {}, { timeout: 10_000 });
    expect(screen.queryByRole('heading', { name: i18n.t('overview.pivot.title') })).toBeNull();
    expect(h.pivot).not.toHaveBeenCalled();
  }, 30_000);

  it('compare + a department filter: ONE Overview request (the cohort carries its previous period)', async () => {
    renderWith(withCohort(), { query: '&src=altercpa,elyon_crm' });
    await screen.findByText(cohortTitle(), {}, { timeout: 10_000 });
    await screen.findByRole('heading', { name: i18n.t('insights.agents.teams.title') });
    expect(h.overview).toHaveBeenCalledTimes(1);
    expect(h.overview).toHaveBeenCalledWith({ from: '2026-09-22', to: '2026-09-28', compare: true }, expect.anything());
  }, 30_000);
});

describe('Overview — the trend is the cohort\'s', () => {
  it('each department: its sales by sale day (the cohort) beside MEX cash — never the orders created', async () => {
    renderWith(withCohort());
    await screen.findByText(cohortTitle(), {}, { timeout: 10_000 });
    const trend = screen.getByRole('heading', { name: i18n.t('overview.trend.title') }).closest('section')!;
    expect(within(trend).getByText(i18n.t('overview.trend.subtitleSales'), { exact: false })).toBeInTheDocument();
    expect(within(trend).queryByText(i18n.t('overview.trend.placed'))).toBeNull();
    fireEvent.click(within(trend).getByRole('button', { name: i18n.t('overview.trend.table') }));
    const table = within(trend).getByRole('table');
    // 22.09, Affiliate – Lead out: the cohort's sales that day (fixture spark by_source) and the MEX cash
    const d22 = cohortSample.spark.find((p) => p.d === '2026-09-22')!;
    const lo = (d22 as unknown as { by_source: { key: string; value_mkd: number }[] }).by_source.find((s) => s.key === 'elyon_crm')!;
    const row = within(table).getByRole('rowheader', { name: '22.09.2026' }).closest('tr')!;
    expect(within(row).getAllByText(formatDenari(lo.value_mkd)).length).toBeGreaterThan(0);
    expect(within(row).getAllByText(formatDenari(111432)).length).toBeGreaterThan(0);   // MEX cash, unchanged
    // the placed value of that day (2.615,62 € → 160.861 ден) is nowhere
    expect(within(row).queryByText(formatDenari(eurToDen(2615.62)))).toBeNull();
  }, 30_000);

  it('without the per-department spark (an older api) it draws the cash alone and points to Sales', async () => {
    const p = withCohort() as WithCohort & { cohort: { spark: { by_source?: unknown }[] } };
    for (const pt of p.cohort.spark) delete pt.by_source;
    renderWith(p);
    await screen.findByText(cohortTitle(), {}, { timeout: 10_000 });
    const trend = screen.getByRole('heading', { name: i18n.t('overview.trend.title') }).closest('section')!;
    expect(within(trend).getByText(i18n.t('overview.trend.subtitleCashOnly'), { exact: false })).toBeInTheDocument();
    const link = within(trend).getByRole('link', { name: i18n.t('overview.trend.toSales') });
    expect(new URLSearchParams(link.getAttribute('href')!.split('?')[1]).get('tab')).toBe('sales');
  }, 30_000);
});

describe('Overview — the teams are the Agents tab\'s', () => {
  it('the same payload and numbers as Insights → Агенти, with presence, TV board and a link to the tab', async () => {
    renderWith(withCohort());
    await screen.findByText(cohortTitle(), {}, { timeout: 10_000 });
    expect(h.agents).toHaveBeenCalledWith({ from: '2026-09-22', to: '2026-09-28', compare: true }, expect.anything());
    const team = await screen.findByRole('article', { name: i18n.t('insights.agents.team.byKey.altercpa_leads') });
    // 220 cohort sales, 646.000 ден — the Agents tab's figures for the week (people.sample.json)
    expect(within(team).getByRole('link', { name: '220' })).toBeInTheDocument();
    expect(within(team).getByText(formatDenari(646000))).toBeInTheDocument();
    expect(within(team).getByRole('link', { name: new RegExp(i18n.t('overview.teams.tvBoard')) }).getAttribute('href')).toContain('key=tv-token');
    const toAgents = screen.getByRole('link', { name: i18n.t('overview.teams.openAgents') });
    expect(new URLSearchParams(toAgents.getAttribute('href')!.split('?')[1]).get('tab')).toBe('agents');
    // the teleshop sellers have their own group, never "Unassigned"
    expect(screen.getByRole('article', { name: i18n.t('insights.agents.team.byKey.teleshop') })).toBeInTheDocument();
    expect(screen.queryByText('Unassigned')).toBeNull();
    // the team chips are the Agents tab's teams
    const chips = screen.getByRole('group', { name: i18n.t('overview.teamsLabel') });
    expect(within(chips).getByRole('button', { name: i18n.t('insights.agents.team.byKey.crm_prediction') })).toBeInTheDocument();
  }, 30_000);

  it('a manager: the same teams counted, not one denar', async () => {
    const { container } = renderWith(stripMoney(withCohort() as OverviewResponse) as WithCohort, { agents: people(false) });
    const team = await screen.findByRole('article', { name: i18n.t('insights.agents.team.byKey.altercpa_leads') }, { timeout: 10_000 });
    expect(within(team).getByRole('link', { name: '220' })).toBeInTheDocument();
    expect(container.textContent).not.toMatch(DENARS);
    expect(screen.queryByRole('columnheader', { name: i18n.t('insights.agents.col.value') })).toBeNull();
  }, 30_000);
});

describe('Overview — attention', () => {
  it('amounts in денари: the parcels\' COD where a parcel exists, price × 61,5 without one — never euro', async () => {
    renderWith(withCohort());
    await screen.findByText(i18n.t('overview.attention.kind.approved_no_parcel_7d', { days: 10 }), {}, { timeout: 10_000 });
    // MEX problems: 38.140 ден of COD (their price × 61,5 would be 37.663 ден; Σ price was 612,40 €)
    const mex = attentionCard('mex_problem');
    expect(within(mex).getByText(formatDenari(38140))).toBeInTheDocument();
    expect(within(mex).queryByText(formatDenari(eurToDen(612.4)))).toBeNull();
    expect(within(attentionCard('approved_no_parcel_7d')).getByText(formatDenari(95154))).toBeInTheDocument();
    expect(within(attentionCard('unlinked_parcels')).getByText(formatDenari(293060))).toBeInTheDocument();
    const rail = screen.getByRole('heading', { name: i18n.t('overview.attention.title') }).closest('section')!;
    expect(rail.textContent).not.toMatch(/€|EUR\b/);
  }, 30_000);

  it('only the kinds /orders can list link to it; the rest show their breakdown inline', async () => {
    renderWith(withCohort());
    await screen.findByText(i18n.t('overview.attention.kind.approved_no_parcel_7d', { days: 10 }), {}, { timeout: 10_000 });
    const href = within(attentionCard('approved_no_parcel_7d')).getByRole('link', { name: '38' }).getAttribute('href')!;
    const sp = new URLSearchParams(href.split('?')[1]);
    expect(href.startsWith('/orders?')).toBe(true);
    expect(sp.get('attention')).toBe('approved_no_parcel_7d');
    expect(sp.get('lbl')).toBe(i18n.t('overview.attention.kind.approved_no_parcel_7d', { days: 10 }));
    for (const kind of ['cod_mismatch', 'night_approvals', 'burst_approvals']) {
      const links = within(attentionCard(kind)).queryAllByRole('link').map((a) => a.getAttribute('href') ?? '');
      expect(links.filter((x) => x.includes('attention='))).toEqual([]);
    }
  }, 30_000);

  it('a manager sees the counts and no amount', async () => {
    renderWith(stripMoney(withCohort() as OverviewResponse) as WithCohort, { agents: people(false) });
    await screen.findByText(i18n.t('overview.attention.kind.mex_problem'), {}, { timeout: 10_000 });
    const rail = screen.getByRole('heading', { name: i18n.t('overview.attention.title') }).closest('section')!;
    expect(rail.textContent).not.toMatch(DENARS);
    expect(within(attentionCard('mex_problem')).getByText('17')).toBeInTheDocument();
  }, 30_000);
});
