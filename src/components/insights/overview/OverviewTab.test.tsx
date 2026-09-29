import { describe, expect, it, vi, beforeAll } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '@/i18n';
import type { OverviewResponse } from '@/lib/api';
import { formatDenari, formatMoney } from '@/lib/currency';
import sample from './__fixtures__/overview.sample.json';
import { stripMoney } from './model';

// Render smoke test for the connected Overview against the contract fixture:
// the owner sees money, a non-owner admin/manager sees the same page counted
// and not one denar. The network is replaced by the fixture.
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u-test', isAdmin: true, isManager: false } }),
}));
const overview = vi.fn();
vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiGetInsightsOverview: (...a: unknown[]) => overview(...a),
  apiGetInsightsPivot: vi.fn(async () => ({ by: [], rows: [] })),
  apiGetLeaderboardAdmin: vi.fn(async () => ({ tokens: [] })),
}));

// jsdom has no layout engine; Recharts' ResponsiveContainer only needs the API.
beforeAll(async () => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  await i18n.changeLanguage('mk');
});

const { default: OverviewTab } = await import('./OverviewTab');

function renderWith(payload: OverviewResponse) {
  overview.mockResolvedValue(payload);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/insights?tab=overview&range=custom&from=2026-09-22&to=2026-09-28']}>
        <OverviewTab />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const owner = () => structuredClone(sample) as unknown as OverviewResponse;
// the departments' names (owner 28.09.2026) — Affiliate – Lead in is the AlterCPA intake
const ALTER = i18n.t('overview.source.altercpa');
// Any amount in denars: a digit, a space, "ден" as a whole word.
const DENARS = /\d ден(?![а-яѓќљњџѕ])/;

describe('Overview — owner', () => {
  it('leads with MEX-proven cash and links every bucket to exactly its orders', async () => {
    const { container } = renderWith(owner());
    // The hero is MEX-PROVEN cash — never the claims that include unproven "paid".
    expect(await screen.findByText(formatDenari(3036660), {}, { timeout: 10_000 })).toBeInTheDocument();
    expect(screen.queryByText(formatDenari(3062500))).toBeNull();
    expect(overview).toHaveBeenCalledWith({ from: '2026-09-22', to: '2026-09-28', compare: true }, expect.anything());

    expect(screen.getByRole('heading', { name: i18n.t('overview.sources.title') })).toBeInTheDocument();
    const alter = screen.getByRole('article', { name: ALTER });
    const delivered = within(alter).getByRole('link', { name: `${ALTER} · ${i18n.t('overview.bucket.delivered')}: 196` });
    expect(delivered.getAttribute('href'))
      .toBe('/orders?sale_source=altercpa%2Caffiliate&outcome=delivered&created_from=2026-09-22&created_to=2026-09-28&cohort_source=altercpa');
    // "Being prepared" is to pack + packed, and opens both.
    const prep = within(alter).getByRole('link', { name: `${ALTER} · ${i18n.t('overview.bucket.preparing')}: 173` });
    expect(prep.getAttribute('href')).toContain('outcome=preparing%2Cpacked');
    // Money line and splits are there for the owner.
    expect(within(alter).getAllByText(formatDenari(498760)).length).toBe(2); // delivered tile + Наплатено
    expect(within(alter).getByText(i18n.t('overview.split.returning'))).toBeInTheDocument();

    // The web mirror is not in `orders`: numbers without links, said in words.
    const web = screen.getByRole('article', { name: i18n.t('overview.source.web') });
    expect(within(web).queryAllByRole('link')).toHaveLength(0);
    expect(within(web).getByText(i18n.t('overview.sources.noLinks'))).toBeInTheDocument();
    // …and its OpenCart history nobody closed is shown as such, never guessed.
    expect(within(web).getAllByText(i18n.t('overview.bucket.no_record')).length).toBeGreaterThan(0);

    // MEX-only parcels sit beside the bar, never in it.
    const tele = screen.getByRole('article', { name: i18n.t('overview.source.teleshopOther') });
    expect(within(tele).getByText(i18n.t('overview.sources.mexOnlyChip', { n: '61' }), { exact: false })).toBeInTheDocument();
    // Телешоп – Lead out (new 28.09): its Нарачка out documents open by their department, its 9102 parcels sit beside
    const out = screen.getByRole('article', { name: i18n.t('overview.source.teleshop_out') });
    expect(within(out).getByText(i18n.t('overview.sources.mexOnlyChip', { n: '5' }), { exact: false })).toBeInTheDocument();
    const outHrefs = within(out).getAllByRole('link').map((a) => a.getAttribute('href')).filter((h): h is string => !!h);
    expect(outHrefs.length).toBeGreaterThan(0);
    for (const h of outHrefs) expect(h).toContain('cohort_source=teleshop_out');
    // Social media is a card of its own (owner 28.09.2026): its collabBox orders open by cohort_source
    const soc = screen.getByRole('article', { name: i18n.t('overview.source.social') });
    expect(within(soc).getByText(i18n.t('overview.sources.mexOnlyChip', { n: '20' }), { exact: false })).toBeInTheDocument();
    const socCourier = within(soc).getByRole('link', { name: `${i18n.t('overview.source.social')} · ${i18n.t('overview.bucket.courier')}: 26` });
    expect(socCourier.getAttribute('href')).toContain('cohort_source=social');
    expect(within(tele).queryByText(i18n.t('overview.split.social'))).toBeNull();

    // Deltas vs the previous period and the "must read 0" integrity tile (11 here → alarm).
    expect(container.textContent).toContain('+2,8%');
    expect(screen.getByText(i18n.t('overview.kpi.unprovenBad'))).toBeInTheDocument();
    expect(container.textContent).toMatch(DENARS);
    expect(screen.getByText(formatMoney(94614.87))).toBeInTheDocument();

    // Teams, pivot and the attention rail all render.
    expect(screen.getByRole('heading', { name: 'Pending — AlterCPA' })).toBeInTheDocument();
    expect(screen.getAllByRole('columnheader', { name: i18n.t('overview.teams.col.sold') }).length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: i18n.t('overview.pivot.title') })).toBeInTheDocument();
    expect(screen.getByText(i18n.t('overview.attention.kind.approved_no_parcel_7d', { days: 10 }))).toBeInTheDocument();
  }, 30_000);
});

describe('Overview — admin/manager without money', () => {
  it('renders the same page counted: no denar anywhere, no money columns, no holes', async () => {
    const { container } = renderWith(stripMoney(owner()));
    expect(await screen.findByText(i18n.t('overview.kpi.heroLabelNoMoney'), {}, { timeout: 10_000 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: i18n.t('overview.sources.titleNoMoney') })).toBeInTheDocument();
    expect(container.textContent).not.toMatch(DENARS);
    expect(screen.queryByText(i18n.t('overview.money.collected'))).toBeNull();
    expect(screen.queryByRole('columnheader', { name: i18n.t('overview.teams.col.sold') })).toBeNull();
    expect(screen.queryByRole('columnheader', { name: i18n.t('overview.pivot.col.value') })).toBeNull();

    // What stays: parcel count as the hero, counts in every tile, the rates, teams, attention.
    expect(screen.getAllByText('1.285').length).toBeGreaterThan(0);   // proven parcels
    expect(screen.getAllByText(i18n.t('overview.rates.delivery')).length).toBe(6);   // one per department
    const alter = screen.getByRole('article', { name: ALTER });
    expect(within(alter).getByRole('link', { name: `${ALTER} · ${i18n.t('overview.bucket.delivered')}: 196` })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Pending — AlterCPA' })).toBeInTheDocument();
    expect(screen.getByText(i18n.t('overview.attention.kind.cod_mismatch'))).toBeInTheDocument();
    // No presence data = "—", never a fake 0 minutes.
    const vesna = screen.getByRole('rowheader', { name: /Весна Јованова/ }).closest('tr')!;
    expect(within(vesna).queryByText(/мин/)).toBeNull();
  }, 30_000);
});

describe('Overview — attention links', () => {
  it('only the kinds /orders can list link to it; the rest show their breakdown inline', async () => {
    renderWith(owner());
    // No `days` in the fixture → the rule's default window (10) in the label.
    const card = (kind: string) => screen.getByText(i18n.t(`overview.attention.kind.${kind}`, { days: 10 })).closest('li')!;
    await screen.findByText(i18n.t('overview.attention.kind.approved_no_parcel_7d', { days: 10 }), {}, { timeout: 10_000 });
    const href = within(card('approved_no_parcel_7d')).getByRole('link', { name: '38' }).getAttribute('href')!;
    const sp = new URLSearchParams(href.split('?')[1]);
    expect(href.startsWith('/orders?')).toBe(true);
    expect(sp.get('attention')).toBe('approved_no_parcel_7d');
    expect(sp.get('lbl')).toBe(i18n.t('overview.attention.kind.approved_no_parcel_7d', { days: 10 }));
    for (const kind of ['cod_mismatch', 'night_approvals', 'burst_approvals']) {
      const links = within(card(kind)).queryAllByRole('link').map((a) => a.getAttribute('href') ?? '');
      expect(links.filter((h) => h.includes('attention='))).toEqual([]);
    }
  }, 30_000);
});
