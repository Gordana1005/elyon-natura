import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  SHOPS_QUERY_ROOT, apiGetShop, apiGetShopsDay, apiGetShopsDeliveries, apiGetShopsHealth, apiGetShopsPeriod,
  apiGetShopsStockMatrix, isShopCode,
} from '@/lib/shopsApi';
import { skopjeDayEndIso } from '@/lib/skopjeTime';
import type { DayRange } from '@/components/insights/shared/period';
import type { ShopDayRow, ShopsDay, ShopsFreshness, ShopsPeriod, ShopsTotals } from '@/lib/shopsTypes';

/** A live day refreshes every minute (the reader reads receipts every 15 min). */
const LIVE_REFETCH_MS = 60_000;

/** One shape for both reports, so the Денес / Период tab and the ranking need no branches. */
export type ShopsSummary =
  | { kind: 'day'; day: ShopsDay; shops: ShopDayRow[]; totals: ShopsTotals; freshness: ShopsFreshness; live: boolean }
  | { kind: 'period'; period: ShopsPeriod; shops: ShopDayRow[]; totals: ShopsTotals; freshness: ShopsFreshness; live: boolean };

/**
 * One day → GET shops/day (live when it is today, refreshed every minute); a longer period →
 * GET shops/period. `today` decides "live" for the period too (its last day still running).
 */
export function useShopsSummary(range: DayRange, today: string, enabled = true) {
  const single = range.from === range.to;
  const live = range.to === today;
  return useQuery<ShopsSummary>({
    queryKey: [SHOPS_QUERY_ROOT, single ? 'day' : 'period', range.from, range.to],
    queryFn: async ({ signal }) => {
      if (single) {
        const day = await apiGetShopsDay(range.from, signal);
        return { kind: 'day', day, shops: day.shops ?? [], totals: day.totals, freshness: day.freshness, live: !!day.live };
      }
      const period = await apiGetShopsPeriod(range.from, range.to, signal);
      return { kind: 'period', period, shops: period.shops ?? [], totals: period.totals, freshness: period.freshness, live };
    },
    enabled,
    placeholderData: keepPreviousData,
    staleTime: live ? 30_000 : 5 * 60_000,
    refetchInterval: live ? LIVE_REFETCH_MS : false,
  });
}

/**
 * `at` in the URL is a Skopje day (YYYY-MM-DD) = the stock at that day's end; today / none = now
 * (the api's default).
 */
export const stockAtParam = (atDay: string | null, today: string): string | null =>
  atDay && atDay < today ? skopjeDayEndIso(atDay) : null;

export function useShopDetail(code: string | null, range: DayRange, atDay: string | null, today: string) {
  const at = stockAtParam(atDay, today);
  return useQuery({
    queryKey: [SHOPS_QUERY_ROOT, 'shop', code, range.from, range.to, at],
    queryFn: ({ signal }) => apiGetShop(code!, { from: range.from, to: range.to, at }, signal),
    enabled: isShopCode(code),
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[2] === code ? prev : undefined),
    staleTime: 60_000,
    refetchInterval: range.to === today && !at ? LIVE_REFETCH_MS * 2 : false,
  });
}

export function useStockMatrix(atDay: string | null, today: string) {
  const at = stockAtParam(atDay, today);
  return useQuery({
    queryKey: [SHOPS_QUERY_ROOT, 'stock-matrix', at],
    queryFn: ({ signal }) => apiGetShopsStockMatrix({ at }, signal),
    placeholderData: keepPreviousData,
    staleTime: 2 * 60_000,
  });
}

export function useShopsDeliveries(range: DayRange, shop: string | null) {
  return useQuery({
    queryKey: [SHOPS_QUERY_ROOT, 'deliveries', range.from, range.to, shop ?? null],
    queryFn: ({ signal }) => apiGetShopsDeliveries({ from: range.from, to: range.to, shop }, signal),
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
  });
}

export function useShopsHealth(enabled: boolean) {
  return useQuery({
    queryKey: [SHOPS_QUERY_ROOT, 'health'],
    queryFn: ({ signal }) => apiGetShopsHealth(signal),
    enabled,
    staleTime: 60_000,
    refetchInterval: 2 * 60_000,
  });
}
