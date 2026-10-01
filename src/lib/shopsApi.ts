/**
 * /shops "Продавници" (owner 02.10.2026, docs/SHOPS.md): typed clients for the six read-only
 * routes of supabase/functions/api (shops.ts). Same base URL and auth as every other call
 * (apiFetch). The JSON shapes are src/lib/shopsTypes.ts — the contract with the api.
 *
 * Access is the server's: owners get every `*_mkd` key, managers the same payload with every
 * money key removed, everyone else `forbidden`. The page renders a money figure only when its
 * key is present, so nothing here guesses who may see money.
 */
import { apiFetch } from './api';
import type {
  ShopDetail, ShopsDay, ShopsDeliveries, ShopsHealth, ShopsPeriod, ShopsStockMatrix,
} from './shopsTypes';

/** Every shops query key starts with this, so the page's loading indicator can follow them all. */
export const SHOPS_QUERY_ROOT = 'shops';
export const isShopsQueryKey = (key: readonly unknown[]): boolean => key[0] === SHOPS_QUERY_ROOT;

/** A collabBox warehouse code ('003'). Anything else never reaches the path (`shops/day` is a route). */
export const isShopCode = (v: unknown): v is string => typeof v === 'string' && /^\d{3}$/.test(v);

const query = (p: Record<string, string | null | undefined>): string => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v != null && v !== '') sp.set(k, v);
  const s = sp.toString();
  return s ? `?${s}` : '';
};

/** GET shops/day?day= — one Skopje day; `live` when it is today. */
export const apiGetShopsDay = (day: string, signal?: AbortSignal): Promise<ShopsDay> =>
  apiFetch<ShopsDay>(`shops/day${query({ day })}`, { signal });

/** GET shops/period?from&to — inclusive Skopje days, with Natura's Sigma invoicing to the shops. */
export const apiGetShopsPeriod = (from: string, to: string, signal?: AbortSignal): Promise<ShopsPeriod> =>
  apiFetch<ShopsPeriod>(`shops/period${query({ from, to })}`, { signal });

/** GET shops/:code?from&to&at — one shop: the period's sales and documents, the stock at `at` (default now). */
export function apiGetShop(
  code: string, p: { from: string; to: string; at?: string | null }, signal?: AbortSignal,
): Promise<ShopDetail> {
  if (!isShopCode(code)) return Promise.reject(new Error('invalid shop code'));
  return apiFetch<ShopDetail>(`shops/${code}${query({ from: p.from, to: p.to, at: p.at })}`, { signal });
}

/** GET shops/stock-matrix?at&q&brand — every article × every shop. */
export const apiGetShopsStockMatrix = (
  p: { at?: string | null; q?: string | null; brand?: string | null } = {}, signal?: AbortSignal,
): Promise<ShopsStockMatrix> =>
  apiFetch<ShopsStockMatrix>(`shops/stock-matrix${query({ at: p.at, q: p.q, brand: p.brand })}`, { signal });

/** GET shops/deliveries?from&to&shop — Sigma invoices to the shops ↔ their collabBox 10042 receipt. */
export const apiGetShopsDeliveries = (
  p: { from: string; to: string; shop?: string | null }, signal?: AbortSignal,
): Promise<ShopsDeliveries> =>
  apiFetch<ShopsDeliveries>(`shops/deliveries${query({ from: p.from, to: p.to, shop: isShopCode(p.shop) ? p.shop : null })}`, { signal });

/** GET shops/health — the reader, the backfill, the daily controls and the anomalies. */
export const apiGetShopsHealth = (signal?: AbortSignal): Promise<ShopsHealth> =>
  apiFetch<ShopsHealth>('shops/health', { signal });
