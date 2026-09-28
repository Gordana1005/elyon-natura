import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '@/i18n';
import { formatDenari } from '@/lib/currency';
import type { ListsResponse } from '@/lib/insightsApi/lists';
import sample from './__fixtures__/lists.sample.json';

// Insights → Prediction lists rendered from the 01.09–27.09.2026 payload: the
// header is the list slice of THE sale cohort (= the Overview's ElyonCRM ·
// prediction_list split), the lists read in Macedonian with денари bands, a
// number opens exactly its orders, and a non-owner sees the same page counted.
const h = vi.hoisted(() => ({ lists: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u-test', isAdmin: true, isManager: false } }),
}));
vi.mock('@/lib/insightsApi/lists', async (orig) => {
  const m = await orig<typeof import('@/lib/insightsApi/lists')>();
  return { ...m, apiGetInsightsLists: (...a: unknown[]) => h.lists(...a) };
});

beforeAll(async () => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  await i18n.changeLanguage('mk');
});

const { default: PredictionListsTab, stripListsMoney } = await import('./PredictionListsTab');

const payload = () => structuredClone(sample) as unknown as ListsResponse;
const WIN = 'range=custom&from=2026-09-01&to=2026-09-27';

function renderWith(p: ListsResponse, query = WIN) {
  h.lists.mockResolvedValue(p);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/insights?tab=prediction-lists&${query}`]}>
        <PredictionListsTab />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const title = () => i18n.t('insights.lists.cohort.title', { period: '01.09 – 27.09.2026' });

describe('Prediction lists — owner', () => {
  it('leads with the list slice of the cohort and ties it to the Overview', async () => {
    renderWith(payload());
    expect(await screen.findByText(title(), {}, { timeout: 10_000 })).toBeInTheDocument();
    expect(h.lists).toHaveBeenCalledWith({ from: '2026-09-01', to: '2026-09-27', compare: true }, expect.anything());
    expect(screen.getAllByText(formatDenari(1929281)).length).toBeGreaterThan(0);
    expect(screen.getByText(i18n.t('insights.lists.cohort.tie', { n: '686', value: formatDenari(1929281) }))).toBeInTheDocument();
    // Σ lists + list not recorded = the slice total, said in the table footer
    expect(screen.getByText(i18n.t('insights.lists.table.foot.tieOk'))).toBeInTheDocument();
    expect(screen.queryByText(i18n.t('insights.lists.table.foot.tieBad'))).toBeNull();
    // MEX cash (cohort) and the cash-flow line
    expect(screen.getAllByText(formatDenari(1249939)).length).toBeGreaterThan(0);
    expect(screen.getByText(formatDenari(1255939))).toBeInTheDocument();
  });

  it('never shows euro, never the stored English list names as the label', async () => {
    const { container } = renderWith(payload());
    await screen.findByText(title(), {}, { timeout: 10_000 });
    expect(container.textContent).not.toMatch(/€|EUR\b/);
    const best = screen.getAllByText('57–120 дена · над 1.599 ден · 1–3 нарачки');
    expect(best.length).toBeGreaterThan(0);
    // the raw name rides in the tooltip, and the link filters on it exactly
    const link = best.map((el) => el.closest('a')).find(Boolean) as HTMLAnchorElement;
    const sp = new URLSearchParams(link.getAttribute('href')!.split('?')[1]);
    expect(Object.fromEntries(sp)).toMatchObject({
      cohort_bucket: 'total', sale_source: 'elyon_crm', sale_source_detail: 'prediction_list',
      prediction_list: '57d 26+ (1-3 orders)', sold_from: '2026-09-01', sold_to: '2026-09-27',
    });
    expect(link.getAttribute('title')).toContain('57d 26+ (1-3 orders)');
  });

  it('opens a list: its parts, its sellers, the stored name', async () => {
    renderWith(payload());
    await screen.findByText(title(), {}, { timeout: 10_000 });
    const table = screen.getByRole('table', { name: i18n.t('insights.lists.table.title') });
    const btn = within(table).getAllByRole('button').find((b) => b.textContent?.includes('57–120 дена · над 1.599 ден · 1–3 нарачки'))!;
    fireEvent.click(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    expect(within(table).getByText('57d 26+ (1-3 orders)', { selector: 'code' })).toBeInTheDocument();
    expect(within(table).getByText(i18n.t('insights.lists.detail.sellers'))).toBeInTheDocument();
  });

  it('the stale card opens exactly the to-pack sales older than 7 days', async () => {
    renderWith(payload());
    await screen.findByText(title(), {}, { timeout: 10_000 });
    const stale = screen.getAllByRole('link', { name: '46' })
      .map((a) => a.getAttribute('href')!)
      .find((href) => href.includes('cohort_bucket=to_pack'))!;
    expect(stale).toContain('sold_to=2026-09-20');
    expect(stale).toContain('sale_source_detail=prediction_list');
  });

  it('says attribution starts 14.08.2026 when the period starts earlier', async () => {
    renderWith(payload(), 'range=custom&from=2026-08-01&to=2026-09-27');
    expect(await screen.findByText(i18n.t('insights.lists.attributionNote', { date: '14.08.2026' }), {}, { timeout: 10_000 })).toBeInTheDocument();
  });

  it('shows the list whose list was not recorded, with its original', async () => {
    renderWith(payload());
    await screen.findByText(title(), {}, { timeout: 10_000 });
    expect(screen.getByText(i18n.t('insights.lists.table.foot.notRecorded'))).toBeInTheDocument();
    const nr = payload().not_recorded.samples[0];
    expect(screen.getAllByRole('link', { name: nr.display_id })[0]).toHaveAttribute('href', `/orders?search=${nr.display_id}`);
  });
});

describe('Prediction lists — admin / manager (counts only)', () => {
  it('the same page with no денари figure and no money column', async () => {
    const { container } = renderWith(stripListsMoney(payload()));
    expect(await screen.findByText(i18n.t('insights.lists.cohort.titleNoMoney', { period: '01.09 – 27.09.2026' }), {}, { timeout: 10_000 })).toBeInTheDocument();
    expect(screen.queryByText(formatDenari(1929281))).toBeNull();
    expect(screen.queryByText(formatDenari(1249939))).toBeNull();
    expect(screen.queryByRole('columnheader', { name: i18n.t('insights.lists.table.col.value') })).toBeNull();
    // no money figure of the owner payload renders (every *_mkd value above 999, formatted)
    const text = container.textContent ?? '';
    const amounts = new Set<number>();
    const walk = (v: unknown, k = ''): void => {
      if (Array.isArray(v)) v.forEach((x) => walk(x, k));
      else if (v && typeof v === 'object') Object.entries(v).forEach(([kk, x]) => walk(x, kk));
      else if (/_mkd$/.test(k) && typeof v === 'number' && v > 999) amounts.add(v);
    };
    walk(sample);
    expect(amounts.size).toBeGreaterThan(50);
    expect([...amounts].filter((v) => text.includes(formatDenari(v)))).toEqual([]);
    // counts stay
    expect(screen.getAllByText('686').length).toBeGreaterThan(0);
  });
});
