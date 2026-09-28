import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '@/i18n';
import type { OverviewResponse } from '@/lib/api';
import { formatDenari } from '@/lib/currency';
import sample from './__fixtures__/overview.sample.json';
import cohortSample from '../shared/__fixtures__/cohort.sample.json';
import { stripMoney } from './model';

// The Overview on the sales cohort (HANDOFF §3, 2026-09-28), rendered from the
// week fixture: the header is the period's SALES, the source cards carry the
// same parts (never a worked count), leads and MEX cash sit apart, a
// non-owner sees the same page counted — and a number links to /orders only
// when the list holds exactly it.
const h = vi.hoisted(() => ({ overview: vi.fn(), drillKeys: [] as string[] }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u-test', isAdmin: true, isManager: false } }),
}));
vi.mock('@/lib/api', async (orig) => {
  const m = await orig<typeof import('@/lib/api')>();
  h.drillKeys.push(...(m.ORDERS_DRILL_KEYS as string[]));
  return {
    ...m,
    // The same array object the shared cohort model reads — a test can take `cohort_bucket` away.
    ORDERS_DRILL_KEYS: h.drillKeys,
    apiGetInsightsOverview: (...a: unknown[]) => h.overview(...a),
    apiGetInsightsPivot: vi.fn(async () => ({ by: [], rows: [] })),
    apiGetLeaderboardAdmin: vi.fn(async () => ({ tokens: [] })),
  };
});

beforeAll(async () => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  await i18n.changeLanguage('mk');
});

// The sources' cards/table choice is remembered per viewer — every test starts on cards.
beforeEach(() => { try { localStorage.removeItem('elyon.overview.sourcesView'); } catch { /* no storage */ } });

const { default: OverviewTab } = await import('./OverviewTab');

type WithCohort = OverviewResponse & { cohort?: unknown };
const payload = (): WithCohort => ({ ...(structuredClone(sample) as unknown as OverviewResponse), cohort: structuredClone(cohortSample) });

function renderWith(p: WithCohort, query = 'range=custom&from=2026-09-22&to=2026-09-28') {
  h.overview.mockResolvedValue(p);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/insights?tab=overview&${query}`]}>
        <OverviewTab />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const withoutCohortDrill = async (fn: () => Promise<void>) => {
  const i = h.drillKeys.indexOf('cohort_bucket');
  h.drillKeys.splice(i, 1);
  try { await fn(); } finally { h.drillKeys.push('cohort_bucket'); }
};
const DENARS = /\d ден(?![а-яѓќљњџѕ])/;
const PERIOD = '22.09 – 28.09.2026';
const WIN = 'sold_from=2026-09-22&sold_to=2026-09-28';
const card = (name: string) => screen.getByRole('article', { name });

describe('Overview on the sales cohort — owner', () => {
  it('leads with the period\'s sales and shows each source on the same cohort', async () => {
    const { container } = renderWith(payload());
    expect(await screen.findByText(i18n.t('overview.cohort.title', { period: PERIOD }), {}, { timeout: 10_000 })).toBeInTheDocument();
    // The header is the cohort total — not the cash hero, not the placed tile of the old row.
    expect(screen.getAllByText(formatDenari(3239584)).length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: i18n.t('overview.cohort.sources.title') })).toBeInTheDocument();

    // A source card's header is its cohort total — never the worked count.
    const alter = card('AlterCPA');
    expect(within(alter).getByText(i18n.t('overview.cohort.sources.header', { n: '365', count: 365, value: formatDenari(991320) }))).toBeInTheDocument();
    // …its parts are the header's parts, the courier tile carrying its problem part.
    expect(within(alter).getByText(i18n.t('insights.common.cohort.problemPart', { n: '36' }))).toBeInTheDocument();
    expect(within(alter).getByText('56')).toBeInTheDocument();                  // 20 moving + 36 problem
    // …and its leads sit apart: worked, conversion, cancelled (red), trashed (grey), open.
    expect(within(alter).getByText(i18n.t('overview.cohort.leads.worked'))).toBeInTheDocument();
    expect(within(alter).getByText('715')).toBeInTheDocument();                 // 351 + 301 + 63
    expect(within(alter).getByText('42,2%')).toBeInTheDocument();
    expect(within(alter).getByText(i18n.t('insights.common.leads.cancelled'))).toBeInTheDocument();
    // Its sub-channels are its orders' own (the live bridge, partners) — no parcels credited to it.
    expect(within(alter).getByText(i18n.t('insights.common.split.bridge'))).toBeInTheDocument();
    expect(within(alter).queryByText(i18n.t('insights.common.split.mex_leads'))).toBeNull();

    // Lead out (elyon_crm): its sales are 142; its 1.638 "no" calls are decisions, said apart, never sales.
    const elyon = card(i18n.t('insights.common.source.elyon_crm'));
    expect(within(elyon).getByText(i18n.t('overview.cohort.sources.header', { n: '142', count: 142, value: formatDenari(390802) }))).toBeInTheDocument();
    expect(within(elyon).getByText(i18n.t('insights.common.leads.dispositionNote', { n: '1.638', count: 1638 }))).toBeInTheDocument();
    // Lead in (teleshop_other) holds its series' parcels with no order: 9100 (mex_in) and none (mex_other).
    const tele = card(i18n.t('insights.common.source.teleshopOther'));
    expect(within(tele).getByText(i18n.t('insights.common.split.mex_in'))).toBeInTheDocument();
    expect(within(tele).getByText(i18n.t('insights.common.split.mexOther'))).toBeInTheDocument();
    expect(within(tele).getByText(i18n.t('overview.cohort.sources.mexOnlyNote', { n: '709', count: 709 }))).toBeInTheDocument();
    expect(within(tele).queryByText(i18n.t('insights.common.split.mex_social'))).toBeNull();
    expect(within(tele).queryAllByRole('link')).toHaveLength(0);
    // Social media is its own card (owner 28.09.2026): its 9108 parcels, no lead funnel, no links.
    const soc = card(i18n.t('insights.common.source.social'));
    expect(within(soc).getByText(i18n.t('insights.common.split.mex_social'))).toBeInTheDocument();
    expect(within(soc).getByText(i18n.t('overview.cohort.sources.mexOnlyNote', { n: '31', count: 31 }))).toBeInTheDocument();
    expect(within(soc).getByText(i18n.t('overview.cohort.leads.noFunnelSocial'))).toBeInTheDocument();
    expect(within(soc).queryAllByRole('link')).toHaveLength(0);
    // The web card is the shop mirror: counted, said in words, no links.
    const web = card(i18n.t('insights.common.source.web'));
    expect(within(web).getByText(i18n.t('overview.cohort.sources.webNote'))).toBeInTheDocument();
    expect(within(web).queryAllByRole('link')).toHaveLength(0);

    // MEX cash is a separate figure on its own clock.
    expect(screen.getByText(formatDenari(3062765))).toBeInTheDocument();
    expect(container.textContent).toMatch(DENARS);
    // Teams, pivot and the attention rail still render.
    expect(screen.getByRole('heading', { name: i18n.t('overview.pivot.title') })).toBeInTheDocument();
    expect(screen.getByText(i18n.t('overview.attention.kind.approved_no_parcel_7d', { days: 10 }))).toBeInTheDocument();
  }, 30_000);

  it('every number that is all orders opens exactly its sales; a mixed one opens its order part', async () => {
    renderWith(payload());
    await screen.findByText(i18n.t('overview.cohort.title', { period: PERIOD }), {}, { timeout: 10_000 });
    const alter = card('AlterCPA');
    const paid = within(alter).getByRole('link', { name: `AlterCPA · ${i18n.t('insights.common.bucket.paid')}: 70` });
    expect(paid.getAttribute('href')).toBe(`/orders?cohort_bucket=paid&cohort_source=altercpa&${WIN}`);
    expect(paid.getAttribute('title')).toBeNull();
    const courier = within(alter).getByRole('link', { name: `AlterCPA · ${i18n.t('insights.common.bucket.courier')}: 56` });
    expect(courier.getAttribute('href')).toContain('cohort_bucket=courier%2Ccourier_problem');
    // A split that IS orders links to itself through the cohort filter; parcels without an order never do.
    const elyon = card(i18n.t('insights.common.source.elyon_crm'));
    const pl = within(elyon).getByText(i18n.t('insights.common.split.prediction_list')).closest('a')!;
    expect(pl.getAttribute('href'))
      .toBe(`/orders?cohort_bucket=total&cohort_source=elyon_crm&sale_source_detail=prediction_list&${WIN}`);
    // The header: 717 paid are 121 orders + 46 web + 550 parcels — the number stays text, its order part links.
    const bar = screen.getByRole('region', { name: i18n.t('overview.cohort.title', { period: PERIOD }) });
    const paidTile = within(bar).getByTitle(i18n.t('insights.common.bucket.paid')).closest('li')!;
    expect(within(paidTile).getByText('717').closest('a')).toBeNull();
    const part = within(paidTile).getByRole('link');
    expect(part).toHaveTextContent(i18n.t('insights.common.cohort.ordersPart', { n: '121' }));
    expect(part.getAttribute('href')).toBe(`/orders?cohort_bucket=paid&${WIN}`);
  }, 30_000);

  it('before /orders can filter the cohort, no cohort number links — the tooltip says why', async () => {
    await withoutCohortDrill(async () => {
      renderWith(payload());
      await screen.findByText(i18n.t('overview.cohort.title', { period: PERIOD }), {}, { timeout: 10_000 });
      const alter = card('AlterCPA');
      expect(within(alter).queryAllByRole('link')).toHaveLength(0);
      expect(within(alter).getByText('70').getAttribute('title')).toBe(i18n.t('overview.cohort.link.unsupported'));
    });
  }, 30_000);

  it('a source filter re-sums the header from the cards shown', async () => {
    renderWith(payload(), 'range=custom&from=2026-09-22&to=2026-09-28&src=altercpa,elyon_crm');
    await screen.findByText(i18n.t('overview.cohort.title', { period: PERIOD }), {}, { timeout: 10_000 });
    expect(screen.getAllByText(formatDenari(991320 + 390802)).length).toBeGreaterThan(0);
    const cards = screen.getAllByRole('article').map((a) => a.getAttribute('aria-labelledby') ?? '').filter((id) => id.startsWith('ov-src-'));
    expect(cards).toEqual(['ov-src-altercpa', 'ov-src-elyon_crm']);
  }, 30_000);

  it('the table view shows the same numbers as a table, and back', async () => {
    renderWith(payload());
    await screen.findByText(i18n.t('overview.cohort.title', { period: PERIOD }), {}, { timeout: 10_000 });
    const toggle = () => screen.getByRole('group', { name: i18n.t('overview.cohort.sources.viewLabel') });
    fireEvent.click(within(toggle()).getByRole('button', { name: i18n.t('overview.cohort.sources.view.table') }));
    const tableSection = screen.getByRole('heading', { name: i18n.t('overview.cohort.sources.tableTitle') }).closest('section')!;
    expect(within(tableSection).getByRole('table')).toBeInTheDocument();
    expect(within(tableSection).getByRole('rowheader', { name: /AlterCPA/ })).toBeInTheDocument();
    expect(screen.queryByRole('article', { name: 'AlterCPA' })).toBeNull();
    fireEvent.click(within(toggle()).getByRole('button', { name: i18n.t('overview.cohort.sources.view.cards') }));
    expect(card('AlterCPA')).toBeInTheDocument();
  }, 30_000);
});

describe('Overview on the sales cohort — admin/manager without money', () => {
  it('the same page counted: no denar anywhere, every count and lead outcome kept', async () => {
    const { container } = renderWith(stripMoney(payload() as OverviewResponse) as WithCohort);
    expect(await screen.findByText(i18n.t('overview.cohort.title', { period: PERIOD }), {}, { timeout: 10_000 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: i18n.t('overview.cohort.sources.titleNoMoney') })).toBeInTheDocument();
    expect(container.textContent).not.toMatch(DENARS);
    expect(screen.getAllByText('1.337').length).toBeGreaterThan(0);
    const alter = card('AlterCPA');
    expect(within(alter).getByText(i18n.t('overview.cohort.ordersN', { n: '365', count: 365 }))).toBeInTheDocument();
    expect(within(alter).getByText('715')).toBeInTheDocument();
    expect(within(alter).getByText('301')).toBeInTheDocument();
  }, 30_000);
});
