import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '@/i18n';
import { formatDenari } from '@/lib/currency';
import type { SalesCore, SalesDetail } from '@/lib/insightsApi/sales';
import coreSample from './__fixtures__/sales.core.sample.json';
import detailSample from './__fixtures__/sales.detail.sample.json';
import prevSample from './__fixtures__/sales.prev.sample.json';

// Insights → Продажби rendered from the 01.09–27.09.2026 payloads: the header
// is THE sale cohort (the Overview's own total), every table adds up to it,
// денари only — never euro — and a non-owner sees the same page counted.
const h = vi.hoisted(() => ({ sales: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u-test', isAdmin: true, isManager: false } }),
}));
vi.mock('@/lib/insightsApi/sales', async (orig) => {
  const m = await orig<typeof import('@/lib/insightsApi/sales')>();
  return { ...m, apiGetInsightsSales: (...a: unknown[]) => h.sales(...a) };
});

beforeAll(async () => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  await i18n.changeLanguage('mk');
});

const { default: SalesTab } = await import('./SalesTab');

const MONEY = /_mkd$/;
const strip = <T,>(v: T): T => {
  const walk = (x: unknown): unknown => Array.isArray(x) ? x.map(walk)
    : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).filter(([k]) => !MONEY.test(k)).map(([k, y]) => [k, walk(y)])) : x;
  const out = walk(v) as Record<string, unknown>;
  out.meta = { ...(out.meta as object), money: false };
  return out as T;
};
const corePayload = (money = true): SalesCore => {
  const c = {
    ...structuredClone(coreSample), prev: structuredClone(prevSample),
    meta: { ...structuredClone(coreSample).meta, prev_from: '2026-08-05', prev_to: '2026-08-31', part: 'core' },
  } as unknown as SalesCore;
  return money ? c : strip(c);
};
const detailPayload = (money = true): SalesDetail => {
  const d = structuredClone(detailSample) as unknown as SalesDetail;
  return money ? d : strip(d);
};

function renderWith(money = true, payloads?: { core: SalesCore; detail: SalesDetail }) {
  h.sales.mockImplementation((p: { part: string }) => Promise.resolve(
    payloads ? (p.part === 'core' ? payloads.core : payloads.detail) : p.part === 'core' ? corePayload(money) : detailPayload(money)));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/insights?tab=sales&range=custom&from=2026-09-01&to=2026-09-27']}>
        <SalesTab />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Sales — owner', () => {
  it('asks for both parts of the period and leads with the cohort total', async () => {
    renderWith();
    const title = i18n.t('insights.sales.header.title', { period: '01.09 – 27.09.2026' });
    expect(await screen.findByText(title, {}, { timeout: 10_000 })).toBeInTheDocument();
    expect(h.sales).toHaveBeenCalledWith({ from: '2026-09-01', to: '2026-09-27', compare: true, part: 'core' }, expect.anything());
    expect(h.sales).toHaveBeenCalledWith({ from: '2026-09-01', to: '2026-09-27', part: 'detail' }, expect.anything());
    // 7.254 sales · 18.171.088 ден — the Overview's cohort for 01–27.09 (five sources, re-cut 28.09)
    expect(screen.getAllByText(formatDenari(18171088)).length).toBeGreaterThan(0);
    expect(screen.getByText(i18n.t('insights.common.cohort.sumOk', { total: '7.254' }))).toBeInTheDocument();
  }, 30_000);

  it('draws every section, the products and cities from the detail part', async () => {
    renderWith();
    expect(await screen.findByRole('heading', { name: i18n.t('insights.sales.products.title') }, { timeout: 10_000 })).toBeInTheDocument();
    for (const k of ['sources.title', 'trend.title', 'cities.title', 'buyers.title', 'basket.title', 'timing.title', 'channels.title']) {
      expect(screen.getByRole('heading', { name: i18n.t(`insights.sales.${k}`) })).toBeInTheDocument();
    }
    // Skopje once — Latin / Cyrillic / MEX zones folded
    expect(screen.getAllByText('Скопје')).toHaveLength(1);
    // gifts, points and delivery are not packages; MEX parcels have no product
    expect(screen.getByText(i18n.t('insights.sales.products.kind.loyalty_point'))).toBeInTheDocument();
    expect(screen.getByText(i18n.t('insights.sales.products.noProduct'))).toBeInTheDocument();
  }, 30_000);

  it('never shows euro and never an English leftover label', async () => {
    const { container } = renderWith();
    await screen.findByRole('heading', { name: i18n.t('insights.sales.products.title') }, { timeout: 10_000 });
    expect(container.textContent).not.toMatch(/€|EUR\b/);
    expect(container.textContent).not.toMatch(/Top products by revenue|Altercpa|Import\b|Home\b/);
    expect(container.textContent).not.toMatch(/insights\.sales\./);
  }, 30_000);

  it('the total opens exactly its order part in /orders', async () => {
    const { container } = renderWith();
    await screen.findByRole('heading', { name: i18n.t('insights.sales.products.title') }, { timeout: 10_000 });
    const hrefs = [...container.querySelectorAll('a[href^="/orders"]')].map((a) => a.getAttribute('href')!);
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      const sp = new URLSearchParams(href.split('?')[1]);
      expect(sp.get('sold_from')).toBe('2026-09-01');
      expect(sp.get('sold_to')).toBe('2026-09-27');
      expect(sp.get('cohort_bucket')).toBeTruthy();
    }
  }, 30_000);
});

// Access levels (20260947001600): a dept_admin's core is their departments' (with money) but the
// MEX channels and the timing are the whole company's counts with no *_mkd; the detail part is
// the whole company's counts (meta.company_wide).
describe('Sales — dept_admin', () => {
  const CENTAR = ['teleshop_out', 'teleshop_other', 'social'];
  const payloads = () => {
    const core = corePayload(true);
    core.meta = { ...core.meta, dept_scope: CENTAR };
    core.by_source = core.by_source.filter((s) => CENTAR.includes(s.key));
    core.channels = strip({ meta: {}, channels: core.channels }).channels;
    core.timing = strip({ meta: {}, timing: core.timing }).timing;
    const detail = detailPayload(false);
    detail.meta = { ...detail.meta, dept_scope: CENTAR, company_wide: true };
    return { core, detail };
  };

  it('says the detail tables are the whole company; channels count without a money column, never NaN', async () => {
    const p = payloads();
    const { container } = renderWith(true, p);
    expect(await screen.findByRole('heading', { name: i18n.t('insights.sales.products.title') }, { timeout: 10_000 })).toBeInTheDocument();
    // the detail tables, the MEX channels and the timing each say "whole company"
    expect(screen.getAllByText(i18n.t('access.companyWide')).length).toBeGreaterThanOrEqual(3);
    const channels = screen.getByRole('heading', { name: i18n.t('insights.sales.channels.title') }).closest('section')!;
    expect(within(channels).queryByRole('columnheader', { name: i18n.t('insights.sales.channels.colCod') })).toBeNull();
    // the footer adds up the channels themselves (company-wide), not the department header
    const sum = p.core.channels.reduce((a, c) => a + c.count, 0);
    expect(within(channels).getByText(new Intl.NumberFormat('de-DE').format(sum))).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/NaN/);
  }, 30_000);
});

describe('Sales — admin / manager (counts only)', () => {
  it('the same page, not one денар', async () => {
    const { container } = renderWith(false);
    const title = i18n.t('insights.sales.header.titleNoMoney', { period: '01.09 – 27.09.2026' });
    expect(await screen.findByText(title, {}, { timeout: 10_000 })).toBeInTheDocument();
    await screen.findByRole('heading', { name: i18n.t('insights.sales.products.title') }, { timeout: 10_000 });
    // no денари amount anywhere ("1.234 ден"); "денови" in a caption is not
    // money, nor the fixed 60 ден threshold the bad-quantity hint names
    const text = (container.textContent ?? '').replace(i18n.t('insights.sales.quality.hint.bad_qty'), '');
    expect(text).not.toMatch(/\d ден(?![а-я])/);
    expect(screen.queryByText(i18n.t('insights.sales.kpi.avg'))).toBeNull();
    expect(screen.getAllByText(i18n.t('insights.sales.kpi.buyers')).length).toBeGreaterThan(0);
    // the counts are all there
    expect(screen.getByText(i18n.t('insights.common.cohort.sumOk', { total: '7.254' }))).toBeInTheDocument();
  }, 30_000);
});
