import { describe, expect, it, vi, beforeAll, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '@/i18n';
import type { OverviewResponse } from '@/lib/api';
import type { ShopsDay, ShopsPeriod } from '@/lib/shopsTypes';
import { formatDenari } from '@/lib/currency';
import sample from './__fixtures__/overview.sample.json';
import cohortSample from '../shared/__fixtures__/cohort.sample.json';
import peopleSample from '../agents/__fixtures__/people.sample.json';
import salesDetailSample from '../sales/__fixtures__/sales.detail.sample.json';
import dayFx from '@/components/shops/__fixtures__/day.owner.json';
import periodFx from '@/components/shops/__fixtures__/period.owner.json';

// The Продавници chip in Извори (owner 15.10.2026): alone = the shops' own view and no call-centre
// request; with departments = those departments + the shops card ("избраните оддели + продавници");
// "Сите извори" clears it. The shops never become a cohort source (`src`), only `shops=1`.
const h = vi.hoisted(() => ({ overview: vi.fn(), agents: vi.fn(), sales: vi.fn(), day: vi.fn(), period: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u-test', isAdmin: true, isManager: false } }),
}));
vi.mock('@/contexts/PermissionsContext', async (orig) => ({
  ...(await orig<typeof import('@/contexts/PermissionsContext')>()),
  useShopsInInsights: () => true,
  useDeptScope: () => null,
}));
vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiGetInsightsOverview: (...a: unknown[]) => h.overview(...a),
  apiGetLeaderboardAdmin: vi.fn(async () => ({ tokens: [] })),
}));
vi.mock('@/lib/insightsApi/agents', async (orig) => ({
  ...(await orig<typeof import('@/lib/insightsApi/agents')>()),
  apiGetInsightsAgents: (...a: unknown[]) => h.agents(...a),
}));
vi.mock('@/lib/insightsApi/sales', async (orig) => ({
  ...(await orig<typeof import('@/lib/insightsApi/sales')>()),
  apiGetInsightsSales: (...a: unknown[]) => h.sales(...a),
}));
vi.mock('@/lib/shopsApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/shopsApi')>()),
  apiGetShopsDay: (...a: unknown[]) => h.day(...a),
  apiGetShopsPeriod: (...a: unknown[]) => h.period(...a),
}));

beforeAll(async () => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  await i18n.changeLanguage('mk');
});
beforeEach(() => {
  for (const f of Object.values(h)) f.mockReset();
  h.overview.mockResolvedValue({ ...(structuredClone(sample) as unknown as OverviewResponse), cohort: structuredClone(cohortSample) });
  h.agents.mockResolvedValue({ ...structuredClone(peopleSample), meta: { ...(peopleSample as { meta: object }).meta, access: 'owner', money: true } });
  h.sales.mockResolvedValue(structuredClone(salesDetailSample));
  h.day.mockResolvedValue(structuredClone(dayFx) as unknown as ShopsDay);
  h.period.mockImplementation((from: string, to: string) => Promise.resolve({ ...structuredClone(periodFx), from, to } as unknown as ShopsPeriod));
});

const { default: OverviewTab } = await import('./OverviewTab');
const t = i18n.t.bind(i18n);

function Where() {
  const loc = useLocation();
  return <p data-testid="where">{loc.search}</p>;
}
function renderAt(query: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/insights?tab=overview&range=custom&from=2026-09-22&to=2026-09-28${query}`]}>
        <OverviewTab />
        <Where />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const sourcesGroup = () => screen.getByRole('group', { name: t('overview.sourcesLabel') });
const shopsChip = () => within(sourcesGroup()).getByRole('button', { name: new RegExp(t('overview.shops.title')) });

describe('the Продавници chip in Извори', { timeout: 30_000 }, () => {
  it('is offered next to the departments, off by default: everything + the shops card', async () => {
    renderAt('');
    expect(await screen.findByTestId('ov-shops', {}, { timeout: 10_000 })).toBeInTheDocument();
    expect(shopsChip().getAttribute('aria-pressed')).toBe('false');
  });

  it('alone: only the shops — their own view, no call-centre request', async () => {
    renderAt('&shops=1');
    expect(await screen.findByTestId('shops-day-tab', {}, { timeout: 10_000 })).toBeInTheDocument();
    expect(shopsChip().getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByText(t('overview.cohort.sources.title'))).toBeNull();
    expect(h.overview).not.toHaveBeenCalled();
    expect(h.agents).not.toHaveBeenCalled();
  });

  it('with a department: that department + the shops card, the total named "избраните оддели"', async () => {
    renderAt('&src=teleshop_out&shops=1');
    const card = await screen.findByTestId('ov-shops', {}, { timeout: 10_000 });
    expect(screen.getByRole('article', { name: t('insights.common.source.teleshop_out') })).toBeInTheDocument();
    expect(screen.queryByRole('article', { name: t('insights.common.source.altercpa') })).toBeNull();
    const group = await within(card).findByTestId('ov-shops-group');
    expect(group.textContent).toContain(t('overview.shops.groupTotalSelected', { cc: formatDenari(89900), shops: formatDenari(41253420) }).slice(0, 40));
  });

  it('a department without the chip hides the shops; "Сите извори" clears both', async () => {
    renderAt('&src=teleshop_out');
    await screen.findByRole('article', { name: t('insights.common.source.teleshop_out') }, { timeout: 10_000 });
    expect(screen.queryByTestId('ov-shops')).toBeNull();
    fireEvent.click(shopsChip());
    expect(await screen.findByTestId('ov-shops')).toBeInTheDocument();
    expect(screen.getByTestId('where').textContent).toContain('shops=1');
    fireEvent.click(within(sourcesGroup()).getByRole('button', { name: t('overview.allSources') }));
    expect(screen.getByTestId('where').textContent).not.toMatch(/shops=|src=/);
  });
});
