import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '@/i18n';
import { DEFAULT_GUARANTEE_SETTINGS, buildRates, type RateRow } from '../../../supabase/functions/api/altercpaGuarantee';

// Стапки counts Skopje days. At 00:30 in Skopje (22:30 UTC the evening before) "today" is
// already the new day — the old tab asked for the UTC date and lost the first two hours.
const h = vi.hoisted(() => ({ rates: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
  apiGetAlterCpaWebmasters: vi.fn(async () => [{ id: '1', account_id: 'a', wm_id: '3221', name: 'Fomikch' }]),
}));
vi.mock('@/lib/altercpaGuaranteeApi', async (orig) => {
  const m = await orig<typeof import('@/lib/altercpaGuaranteeApi')>();
  return { ...m, apiGetGuaranteeRates: (from: string, to: string) => h.rates(from, to) };
});

const NOW = new Date('2026-09-30T22:30:00Z'); // 00:30 on 01.10 in Skopje
beforeAll(async () => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  await i18n.changeLanguage('mk');
  vi.setSystemTime(NOW);
});
afterAll(() => { vi.useRealTimers(); });

const { RatesTab, ratesRange } = await import('./RatesTab');
const { useInsightsFormat } = await import('@/components/insights/shared/useInsightsFormat');

const row = (over: Partial<RateRow>): RateRow => ({
  grain: 'webmaster', day: '2026-09-28', webmaster: '3221', stream: null, offer_name: null, leads: 0, test_excluded: 0,
  approved: 0, cancel_other: 0, cancelled: 0, trashed: 0, open: 0, counted: 0, mex_shipped: 0, crm_sticky: 0, ...over,
});
const payload = (from: string, to: string) => buildRates({
  from, to, today: '2026-10-01', settings: DEFAULT_GUARANTEE_SETTINGS, now: NOW,
  rates: [
    row({ grain: 'day', webmaster: null, leads: 150, test_excluded: 3, approved: 40, counted: 40, cancelled: 110, mex_shipped: 30, crm_sticky: 70 }),
    row({ leads: 150, test_excluded: 3, approved: 40, counted: 40, cancelled: 110, mex_shipped: 30, crm_sticky: 70 }),
    row({ grain: 'stream', stream: 'k6p672', leads: 100, counted: 30 }),
    row({ grain: 'stream', stream: 'zz9', leads: 50, counted: 10 }),
    row({ grain: 'offer', offer_name: 'Adenofrin', leads: 150, counted: 40 }),
  ],
});

function Harness() {
  const f = useInsightsFormat();
  return <RatesTab f={f} />;
}
const wrap = (url = '/altercpa?tab=rates') => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={[url]}><Harness /></MemoryRouter></QueryClientProvider>);
};

beforeEach(() => { h.rates.mockReset(); h.rates.mockImplementation(async (from: string, to: string) => payload(from, to)); });

describe('ratesRange', () => {
  const today = '2026-10-01';
  it('defaults to the last 14 Skopje days', () => {
    expect(ratesRange(new URLSearchParams(''), today)).toEqual({ from: '2026-09-18', to: today });
  });
  it('stretches back to a notification’s date, never past today, at most 92 days', () => {
    expect(ratesRange(new URLSearchParams('wm=3221&date=2026-09-01'), today)).toEqual({ from: '2026-09-01', to: today });
    expect(ratesRange(new URLSearchParams('from=2026-09-20&to=2026-10-09'), today)).toEqual({ from: '2026-09-20', to: today });
    expect(ratesRange(new URLSearchParams('from=2026-01-01&to=2026-10-01'), today).from).toBe('2026-07-02');
  });
});

describe('RatesTab', { timeout: 30_000 }, () => {
  it('at 00:30 Skopje asks for the period ending on the SKOPJE day (01.10), not the UTC one', async () => {
    wrap();
    await waitFor(() => expect(h.rates).toHaveBeenCalled());
    expect(h.rates).toHaveBeenCalledWith('2026-09-18', '2026-10-01');
    expect(await screen.findByText('Стар метод')).toBeInTheDocument();
    expect(screen.getByText('Тест-лидови')).toBeInTheDocument();
    expect(screen.getByText(/Од 01\.10\.2026: \(одобрени \+ откажани-друго\) ÷ сите MK лидови/)).toBeInTheDocument();
  });

  it('?wm=&date= (the notification link) opens that cohort’s sheet with its streams, offers and MEX', async () => {
    wrap('/altercpa?tab=rates&wm=3221&date=2026-09-28');
    expect(await screen.findByText('Fomikch · 28.09.2026')).toBeInTheDocument();
    expect(screen.getAllByText('По поток').length).toBeGreaterThan(0);
    expect(screen.getByText('k6p672')).toBeInTheDocument();
    expect(screen.getByText('Реално испратени (MEX)')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Прикажи ги лидовите/ })).toHaveAttribute('href', '/altercpa?tab=leads&from=2026-09-28&to=2026-09-28&wm=3221');
  });
});
