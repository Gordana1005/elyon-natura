import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '@/i18n';
import { formatDenari } from '@/lib/currency';
import type { ShopsDay } from '@/lib/shopsTypes';
import { stripShopsMoney } from '@/components/shops/shopsModel';
import dayFx from '@/components/shops/__fixtures__/day.owner.json';
import { ShopsOverviewCard } from './ShopsOverviewCard';

// Продавници on the Overview (owner 15.10.2026): the shops' sales of the same period, apart from
// the call centre — the owner also gets "кол-центар + продавници = вкупно"; a manager the same
// card counted; a reader the shops api refuses gets no card at all.

const api = vi.hoisted(() => ({ day: vi.fn(), period: vi.fn() }));
vi.mock('@/lib/shopsApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/shopsApi')>()),
  apiGetShopsDay: (...a: unknown[]) => api.day(...a),
  apiGetShopsPeriod: (...a: unknown[]) => api.period(...a),
}));

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-02T12:20:00Z'));
  await i18n.changeLanguage('mk');
});
afterAll(() => { vi.useRealTimers(); });
afterEach(() => { vi.clearAllMocks(); });

const t = i18n.t.bind(i18n);
const DAY = { from: '2026-10-02', to: '2026-10-02' };

function renderCard(callCentreMkd: number | null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/insights?tab=overview']}>
        <ShopsOverviewCard range={DAY} today="2026-10-02" callCentreMkd={callCentreMkd} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('the Overview shops card', () => {
  it('owner: sales, receipts, the three best shops and the call centre + shops total', async () => {
    api.day.mockResolvedValue(structuredClone(dayFx) as unknown as ShopsDay);
    renderCard(2_000_000);
    const card = await screen.findByTestId('ov-shops');
    expect(await within(card).findByText(formatDenari(1160250))).toBeInTheDocument();
    expect(within(card).getByText('457')).toBeInTheDocument();
    const top = within(card).getAllByRole('listitem').map((li) => li.textContent ?? '');
    expect(top[0]).toContain('Рамстор');
    expect(top[1]).toContain('Сити Мол');
    expect(top[2]).toContain('Скопје Мол');
    const group = within(card).getByTestId('ov-shops-group');
    expect(group.textContent).toContain(formatDenari(2_000_000));
    expect(group.textContent).toContain(formatDenari(3_160_250));
    expect(within(card).getByRole('link', { name: new RegExp(t('overview.shops.open')) }).getAttribute('href'))
      .toBe('/insights?tab=shops');
  });

  it('manager: the same card counted — no denar, no total line', async () => {
    api.day.mockResolvedValue(stripShopsMoney(structuredClone(dayFx)) as unknown as ShopsDay);
    renderCard(null);
    const card = await screen.findByTestId('ov-shops');
    expect(await within(card).findByText('457')).toBeInTheDocument();
    expect(within(card).queryByTestId('ov-shops-group')).toBeNull();
    expect(card.textContent).not.toMatch(/\d ден(?![а-яѓќљњџѕ])/);
  });

  it('a reader the shops api refuses: no card', async () => {
    api.day.mockRejectedValue(new Error('Forbidden'));
    const { container } = renderCard(1);
    await vi.waitFor(() => expect(api.day).toHaveBeenCalled());
    await vi.waitFor(() => expect(container.querySelector('[data-testid="ov-shops"]')).toBeNull());
    expect(screen.queryByText(t('overview.shops.loadFailed'))).toBeNull();
  });

  it('a period asks shops/period, never the day', async () => {
    api.period.mockResolvedValue({ ...structuredClone(dayFx), from: '2026-09-01', to: '2026-09-30', daily: [], natura: null });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <ShopsOverviewCard range={{ from: '2026-09-01', to: '2026-09-30' }} today="2026-10-02" callCentreMkd={null} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findByTestId('ov-shops');
    expect(api.period).toHaveBeenCalledWith('2026-09-01', '2026-09-30', expect.anything());
    expect(api.day).not.toHaveBeenCalled();
  });
});
