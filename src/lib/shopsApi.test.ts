import { beforeEach, describe, expect, it, vi } from 'vitest';

// The six GET routes of docs/SHOPS.md, built exactly; a bad shop code never reaches the path.
const h = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('./api', () => ({ apiFetch: (...a: unknown[]) => h.fetch(...a) }));

const api = await import('./shopsApi');

beforeEach(() => { h.fetch.mockReset(); h.fetch.mockResolvedValue({}); });
const path = () => h.fetch.mock.calls[0][0] as string;

describe('shopsApi', () => {
  it('builds the routes', async () => {
    await api.apiGetShopsDay('2026-10-02');
    expect(path()).toBe('shops/day?day=2026-10-02');
    h.fetch.mockClear();
    await api.apiGetShopsPeriod('2026-09-01', '2026-09-30');
    expect(path()).toBe('shops/period?from=2026-09-01&to=2026-09-30');
    h.fetch.mockClear();
    await api.apiGetShop('003', { from: '2026-09-01', to: '2026-09-30', at: null });
    expect(path()).toBe('shops/003?from=2026-09-01&to=2026-09-30');
    h.fetch.mockClear();
    await api.apiGetShop('003', { from: '2026-09-01', to: '2026-09-30', at: '2026-09-30T21:59:59.999999Z' });
    expect(path()).toBe('shops/003?from=2026-09-01&to=2026-09-30&at=2026-09-30T21%3A59%3A59.999999Z');
    h.fetch.mockClear();
    await api.apiGetShopsStockMatrix();
    expect(path()).toBe('shops/stock-matrix');
    h.fetch.mockClear();
    await api.apiGetShopsDeliveries({ from: '2026-09-01', to: '2026-09-30', shop: '006' });
    expect(path()).toBe('shops/deliveries?from=2026-09-01&to=2026-09-30&shop=006');
    h.fetch.mockClear();
    await api.apiGetShopsDeliveries({ from: '2026-09-01', to: '2026-09-30', shop: 'day' });
    expect(path()).toBe('shops/deliveries?from=2026-09-01&to=2026-09-30');
    h.fetch.mockClear();
    await api.apiGetShopsHealth();
    expect(path()).toBe('shops/health');
  });

  it('refuses a shop code that is not three digits (shops/day is a route, not a shop)', async () => {
    await expect(api.apiGetShop('day', { from: '2026-09-01', to: '2026-09-30' })).rejects.toThrow();
    await expect(api.apiGetShop('../x', { from: '2026-09-01', to: '2026-09-30' })).rejects.toThrow();
    expect(h.fetch).not.toHaveBeenCalled();
    expect(api.isShopCode('003')).toBe(true);
    expect(api.isShopCode('3')).toBe(false);
  });

  it('every shops query key starts with the same root', () => {
    expect(api.isShopsQueryKey(['shops', 'day'])).toBe(true);
    expect(api.isShopsQueryKey(['insights', 'x'])).toBe(false);
  });
});
