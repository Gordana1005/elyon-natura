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
import salesDetailSample from '../sales/__fixtures__/sales.detail.sample.json';
import { stripMoney } from './model';

// The Overview after the 29.09.2026 clean-up, rendered from the contract fixtures:
// no pre-cohort widget is drawn (KPI tiles, source rows, the drill-down pivot), a
// missing cohort is an error with a retry, one Overview request per view, the call
// centre first (02.10.2026: who sold how much, the best-selling products — no MEX
// cash, no MEX-cash trend), the teams are the Agents tab's and the attention rail
// speaks денари. The network is replaced by the fixtures.
const h = vi.hoisted(() => ({ overview: vi.fn(), agents: vi.fn(), pivot: vi.fn(), sales: vi.fn() }));
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
vi.mock('@/lib/insightsApi/sales', async (orig) => ({
  ...(await orig<typeof import('@/lib/insightsApi/sales')>()),
  apiGetInsightsSales: (...a: unknown[]) => h.sales(...a),
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
  h.sales.mockReset();
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

const salesNoMoney = () => {
  const strip = (v: unknown): unknown => (Array.isArray(v) ? v.map(strip) : v && typeof v === 'object'
    ? Object.fromEntries(Object.entries(v).filter(([k]) => !/_mkd$/.test(k)).map(([k, x]) => [k, strip(x)])) : v);
  const d = strip(structuredClone(salesDetailSample)) as typeof salesDetailSample;
  return { ...d, meta: { ...d.meta, money: false } };
};

function renderWith(p: WithCohort, opts: { query?: string; agents?: PeopleResponse } = {}) {
  h.overview.mockResolvedValue(p);
  h.agents.mockResolvedValue(opts.agents ?? people());
  // the api strips the products' money for a non-owner as it does the rest
  h.sales.mockResolvedValue(opts.agents?.meta.money === false ? salesNoMoney() : structuredClone(salesDetailSample));
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
    // the rest of the page still answers: freshness, teams, attention
    expect(await screen.findByRole('heading', { name: i18n.t('insights.agents.teams.title') })).toBeInTheDocument();
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

describe('Overview — a dept_admin (access levels 20260947001600)', () => {
  const CENTAR = ['teleshop_out', 'teleshop_other', 'social'];
  const scoped = (): WithCohort => {
    const p = withCohort();
    const c = p.cohort as { meta: Record<string, unknown>; by_source: { key: string }[] };
    c.meta = { ...c.meta, dept_scope: CENTAR };
    c.by_source = c.by_source.filter((r) => CENTAR.includes(r.key));
    return { ...p, meta: { ...p.meta, money: true, dept_scope: CENTAR } };
  };
  const chips = () => within(screen.getByRole('group', { name: i18n.t('overview.sourcesLabel') })).getAllByRole('button')
    .filter((b) => b.hasAttribute('aria-pressed'));

  it('the department chips are locked to their departments; the page renders on 3 of 7 rows', async () => {
    const { container } = renderWith(scoped());
    await screen.findByText(cohortTitle(), {}, { timeout: 10_000 });
    expect(chips().map((b) => b.textContent)).toEqual([
      i18n.t('insights.common.source.teleshop_out'), i18n.t('insights.common.source.teleshopOther'), i18n.t('insights.common.source.social'),
    ]);
    expect(container.textContent).not.toMatch(/NaN/);
  }, 30_000);

  it('a link carrying another department\'s chip drops it', async () => {
    renderWith(scoped(), { query: '&src=altercpa,social' });
    await screen.findByText(cohortTitle(), {}, { timeout: 10_000 });
    expect(chips().filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.textContent))
      .toEqual([i18n.t('insights.common.source.social')]);
  }, 30_000);
});

describe('Overview — the call centre first (owner 02.10.2026)', () => {
  it('no MEX cash and no MEX-cash trend: they live on Insights → Наплата (MEX)', async () => {
    renderWith(withCohort());
    await screen.findByText(cohortTitle(), {}, { timeout: 10_000 });
    expect(screen.queryByText(i18n.t('insights.common.cash.title'))).toBeNull();
    expect(screen.queryByText(i18n.t('insights.common.cash.titleNoMoney'))).toBeNull();
    expect(screen.queryByRole('heading', { name: i18n.t('overview.trend.title') })).toBeNull();
    // the leads that came in stay — a call-centre figure
    expect(screen.getByText(i18n.t('insights.common.leads.title'))).toBeInTheDocument();
  }, 30_000);

  it('who sold how much: the Agents payload, the owner ranks by денари, each name opens the person', async () => {
    renderWith(withCohort());
    const card = (await screen.findByRole('heading', { name: i18n.t('overview.callCenter.sellers.title') }, { timeout: 10_000 })).closest('section')!;
    const sellers = (peopleSample as unknown as PeopleResponse).people
      .filter((p) => p.sales > 0)
      .sort((a, b) => (b.value_mkd ?? 0) - (a.value_mkd ?? 0) || b.sales - a.sales || a.name.localeCompare(b.name));
    const rows = await within(card).findAllByRole('listitem');
    expect(rows.length).toBe(Math.min(10, sellers.length));
    expect(within(rows[0]).getByText(sellers[0].name)).toBeInTheDocument();
    expect(within(rows[0]).getByText(formatDenari(sellers[0].value_mkd ?? 0))).toBeInTheDocument();
    const href = within(rows[0]).getByRole('link', { name: sellers[0].name }).getAttribute('href')!;
    const sp = new URLSearchParams(href.split('?')[1]);
    expect(sp.get('tab')).toBe('agents');
    expect(sp.get('ag_person')).toBe(sellers[0].person_id);
    // by sales instead
    fireEvent.click(within(card).getByRole('button', { name: i18n.t('overview.callCenter.sellers.sort.sales') }));
    const bySales = [...sellers].sort((a, b) => b.sales - a.sales || (b.value_mkd ?? 0) - (a.value_mkd ?? 0) || a.name.localeCompare(b.name));
    expect(within(within(card).getAllByRole('listitem')[0]).getByText(bySales[0].name)).toBeInTheDocument();
  }, 30_000);

  it('the best-selling products: the Sales tab\'s detail, most packages first', async () => {
    renderWith(withCohort());
    const card = (await screen.findByRole('heading', { name: i18n.t('overview.callCenter.products.title') }, { timeout: 10_000 })).closest('section')!;
    await vi.waitFor(() => expect(h.sales).toHaveBeenCalledWith({ from: '2026-09-22', to: '2026-09-28', part: 'detail' }, expect.anything()));
    const top = [...salesDetailSample.products.rows].filter((r) => r.units > 0)
      .sort((a, b) => b.units - a.units || b.sales - a.sales || (a.name ?? '').localeCompare(b.name ?? ''))[0];
    const first = (await within(card).findAllByRole('listitem'))[0];
    expect(within(first).getByText(top.name!)).toBeInTheDocument();
  }, 30_000);

  it('a manager: the sellers counted by sales, not one denar', async () => {
    renderWith(stripMoney(withCohort() as OverviewResponse) as WithCohort, { agents: people(false) });
    const card = (await screen.findByRole('heading', { name: i18n.t('overview.callCenter.sellers.title') }, { timeout: 10_000 })).closest('section')!;
    await within(card).findAllByRole('listitem');
    expect(within(card).queryByRole('button', { name: i18n.t('overview.callCenter.sellers.sort.value') })).toBeNull();
    expect(card.textContent).not.toMatch(DENARS);
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
