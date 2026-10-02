import { describe, expect, it, vi, beforeAll } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '@/i18n';
import type { PeopleResponse } from '@/lib/insightsApi/agents';
import { formatDenari } from '@/lib/currency';
import sample from './__fixtures__/people.sample.json';
import { fmtInt } from '../overview/model';

// Render smoke test for Insights → Агенти against the live-shaped fixture
// (22–28.09.2026, names anonymised): the owner sees денари, a non-owner
// admin / manager the same page counted and not one denar, an agent only
// themselves. The network is replaced by the fixture.
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u-test', isAdmin: true, isManager: false } }),
}));
const agents = vi.fn();
vi.mock('@/lib/insightsApi/agents', () => ({
  apiGetInsightsAgents: (...a: unknown[]) => agents(...a),
}));
const perf = vi.fn();
vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiGetAgentPerformance: (...a: unknown[]) => perf(...a),
}));

beforeAll(async () => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  await i18n.changeLanguage('mk');
});

const { default: AgentsTab } = await import('./AgentsTab');

const meta = {
  from: '2026-09-22', to: '2026-09-28', prev_from: '2026-09-15', prev_to: '2026-09-21', partial: false, days: 7,
  generated_at: '2026-09-28T10:00:00Z', clock: 'sale' as const,
};
const owner = (): PeopleResponse => {
  const d = structuredClone(sample) as unknown as PeopleResponse;
  return { ...d, meta: { ...d.meta, ...meta, money: true, access: 'owner' } };
};
function noMoney<T>(v: T): T {
  if (Array.isArray(v)) return v.map(noMoney) as unknown as T;
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (!/_mkd$/.test(k)) o[k] = noMoney(x);
    return o as T;
  }
  return v;
}

function renderWith(payload: PeopleResponse) {
  agents.mockResolvedValue(payload);
  perf.mockResolvedValue([]);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/insights?tab=agents&range=custom&from=2026-09-22&to=2026-09-28']}>
        <AgentsTab />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const DENARS = /\d ден(?![а-яѓќљњџѕ])/;

describe('Агенти — owner', { timeout: 30_000 }, () => {
  it('leads with the credited sales in денари and links every person to exactly their orders', async () => {
    const d = owner();
    const { container } = renderWith(d);
    expect(await screen.findByText(formatDenari(d.totals!.with_person_mkd!), {}, { timeout: 10_000 })).toBeInTheDocument();
    expect(agents).toHaveBeenCalledWith({ from: '2026-09-22', to: '2026-09-28', compare: true, person: null }, expect.anything());

    // Teams side by side, the pseudo-groups named in the reader's language.
    expect(screen.getByRole('heading', { name: i18n.t('insights.agents.team.byKey.altercpa_leads') })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: i18n.t('insights.agents.team.byKey.none') })).toBeInTheDocument();

    // The biggest seller's sales open /orders for exactly that person and window.
    const top = [...d.people].sort((a, b) => b.sales - a.sales)[0];
    const table = screen.getByRole('table', { name: i18n.t('insights.agents.people.title') });
    const row = within(table).getByRole('button', { name: top.name }).closest('tr')!;
    const link = within(row).getAllByRole('link').find((a) => a.textContent === String(top.sales))!;
    const u = new URL(link.getAttribute('href')!, 'http://x');
    expect(u.searchParams.get('cohort_bucket')).toBe('total');
    expect(u.searchParams.get('sold_by_person_id')).toBe(top.person_id);
    expect(u.searchParams.get('sold_from')).toBe('2026-09-22');

    // The tie with the Overview is stated, and holds.
    expect(screen.getByText(i18n.t('insights.agents.noSeller.tieOk', {
      people: fmtInt(d.totals!.with_person, 'mk'), none: fmtInt(d.no_seller!.count, 'mk'), total: fmtInt(d.totals!.sales, 'mk'),
    }), { exact: false })).toBeInTheDocument();
    expect(container.textContent).toMatch(DENARS);
  });
});

describe('Агенти — admin / manager (no money)', { timeout: 30_000 }, () => {
  it('shows the same page counted and not one denar', async () => {
    const d = noMoney(owner());
    d.meta = { ...d.meta, money: false, access: 'counts' };
    const { container } = renderWith(d);
    expect(await screen.findByRole('heading', { name: i18n.t('insights.agents.teams.title') }, { timeout: 10_000 })).toBeInTheDocument();
    expect(screen.getByText(i18n.t('insights.agents.kpi.hero'))).toBeInTheDocument();
    // not a single денар anywhere on the tab (the bonus block is empty here)
    expect(container.textContent).not.toMatch(DENARS);
    expect(screen.queryByText(i18n.t('insights.agents.col.value'))).toBeNull();
  });
});

describe('Агенти — dept_admin (access levels 20260947001600)', { timeout: 30_000 }, () => {
  it('reads like the full view with money, and hides the figures its totals do not carry', async () => {
    const d = owner();
    const { cod_mkd: _c, paid_mkd: _p, prev: _pr, conversion: _cv, ...totals } = d.totals!;
    d.totals = totals;
    d.spark = (d.spark ?? []).map(({ value_mkd: _v, ...p }) => p);
    d.meta = { ...d.meta, money: true, access: 'dept', dept_scope: ['teleshop_out', 'teleshop_other', 'social'] };
    const { container } = renderWith(d);
    expect(await screen.findByText(formatDenari(d.totals!.with_person_mkd!), {}, { timeout: 10_000 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: i18n.t('insights.agents.teams.title') })).toBeInTheDocument();
    // no conversion tile (its key is absent), and never NaN anywhere
    expect(screen.queryByText(i18n.t('insights.agents.kpi.conversion'))).toBeNull();
    expect(container.textContent).not.toMatch(/NaN/);
  });
});

describe('Агенти — agent (self)', { timeout: 30_000 }, () => {
  it('shows only their own numbers', async () => {
    const d = owner();
    const me = d.people[0];
    renderWith(noMoney({ meta: { ...d.meta, money: false, access: 'self' }, people: [me], detail: null }) as PeopleResponse);
    expect(await screen.findByRole('heading', { name: i18n.t('insights.agents.self.title', { name: me.name }) }, { timeout: 10_000 })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: i18n.t('insights.agents.teams.title') })).toBeNull();
    expect(screen.queryByRole('table', { name: i18n.t('insights.agents.people.title') })).toBeNull();
  });
});
