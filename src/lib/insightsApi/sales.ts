/**
 * GET /api/insights/sales?from&to&compare=1&part=core|detail — Insights →
 * Продажби (migration 20260941000100 insights_sales; api module
 * supabase/functions/api/insightsSales.ts).
 *
 * THE sale cohort (insights_sale_rows) as "what did we sell": sale day
 * (Skopje), the six departments, MEX-first buckets that add up exactly to the total.
 * Values are денари (`*_mkd`: parcel COD, else price × 61,5, web = the shop
 * total) — render them with formatDenari, never convert again.
 *
 *   core    the cohort block (= GET /insights/cohort for the window), trend by
 *           source, MEX account × series, weekday × hour, quality, prev
 *   detail  products, cities, buyers, basket — the heavy tables; the tab asks
 *           for both parts at once and draws the header first
 *
 * Money keys (`*_mkd`) are owners only: an admin/manager gets the same payload
 * with every money key ABSENT (meta.money = false).
 */
import { apiFetch } from '@/lib/api';
import type {
  CohortBucket, CohortBucketKey, CohortOutside, CohortQuality, CohortSourceKey, CohortSplit, CohortTotal,
} from '@/components/insights/shared/cohortTypes';

export interface SalesMeta {
  from: string;
  to: string;
  prev_from?: string | null;
  prev_to?: string | null;
  prev_to_end?: string | null;
  partial?: boolean;
  days?: number;
  generated_at: string;
  money: boolean;
  clock: 'sale';
  part: 'core' | 'detail';
  granularity?: 'day' | 'week' | 'month';
  top_n?: number;
}

/** One source, in the cohort's shape (no leads — the Overview carries those). */
export interface SalesSource {
  key: CohortSourceKey;
  total: CohortTotal;
  buckets: CohortBucket[];
  outside: CohortOutside[];
  splits: CohortSplit[];
}

export interface SalesTrendPoint {
  /** First day of the bucket (YYYY-MM-DD) — a day, an ISO week (Monday) or a month. */
  d: string;
  count: number;
  value_mkd?: number;
  by_source: { key: CohortSourceKey; count: number; value_mkd?: number }[];
}

/** One MEX account × series (the channel a parcel names); series 'none' = no parcel yet. */
export interface SalesChannel {
  account: 'bio_natural' | 'natura' | 'unknown' | null;
  /** 9110 · 9103 · 9100 · 9102 · 9108 · ntmk (web) · m (bare M… waybills) · other · none */
  series: string;
  count: number;
  value_mkd?: number;
  cod_mkd?: number;
  paid: number;
  courier: number;
  to_pack: number;
  returned: number;
  by_source: { key: CohortSourceKey; count: number }[];
}

export interface SalesTimingCell { dow: number; hour: number; count: number; value_mkd?: number }

export interface SalesTiming {
  /** ISO weekday 1 = Monday … 7 = Sunday; hour 0–23 (Skopje). Only sales with a real moment. */
  cells: SalesTimingCell[];
  timed: number;
  /** Sales that carry a date only (collabBox imports, MEX-only labels). */
  untimed: { key: CohortSourceKey; kind: 'order' | 'web' | 'mex'; count: number }[];
  /** Every sale by its sale day's weekday; `days` = how many such days the period has. */
  weekdays: { dow: number; count: number; value_mkd?: number; days: number }[];
}

export interface SalesPrev {
  total: { count: number; value_mkd?: number; cod_mkd?: number };
  buckets: { key: CohortBucketKey; count: number; value_mkd?: number; cod_mkd?: number }[];
  by_source: { key: CohortSourceKey; total: { count: number; value_mkd?: number; cod_mkd?: number } }[];
}

export interface SalesCore {
  meta: SalesMeta;
  total: CohortTotal;
  buckets: CohortBucket[];
  outside: CohortOutside[];
  by_source: SalesSource[];
  trend: { granularity: 'day' | 'week' | 'month'; points: SalesTrendPoint[] };
  channels: SalesChannel[];
  timing: SalesTiming;
  quality: CohortQuality[];
  prev?: SalesPrev | null;
}

export interface SalesProduct {
  /** 'p:<uuid>' = a catalogue product · 'n:<name>' = a name no alias maps yet. */
  key: string;
  name: string | null;
  catalogue: boolean;
  /** Sales that carry the product (a product twice on one sale counts once). */
  sales: number;
  /** Packages (implausible counts left out — see summary.bad_qty_lines). */
  units: number;
  /** The sales' value spread over their lines by the line's money. */
  value_mkd?: number;
  paid: number;
  returned: number;
  courier: number;
  to_pack: number;
  by_source: { key: CohortSourceKey; sales: number; units: number; value_mkd?: number }[];
}

export type SalesLineKind = 'gift' | 'loyalty_point' | 'delivery' | 'note' | 'flyer';

export interface SalesProducts {
  rows: SalesProduct[];
  others: { products: number; sales: number; units: number; value_mkd?: number };
  /** Lines that are not packages; `auto` = recognised by rule, not by a reviewed alias. */
  non_product: { kind: SalesLineKind | string; lines: number; sales: number; units: number; value_mkd?: number; auto: number }[];
  /** Sales no line can carry — MEX parcels with no order (no product data). */
  no_product: { sales: number; value_mkd?: number; mex_only: number; mex_only_value_mkd?: number };
  summary: {
    products: number;
    units: number;
    value_mkd?: number;
    sales: number;
    unmapped_products: number;
    unmapped_units: number;
    unmapped_value_mkd?: number;
    unmapped_sales: number;
    bad_qty_lines: number;
    bad_qty_value_mkd?: number;
  };
}

export interface SalesCityCounts {
  count: number;
  value_mkd?: number;
  paid: number;
  returned: number;
  courier: number;
  to_pack: number;
}

export interface SalesCity extends SalesCityCounts {
  /** mk_city_key: the mk_settlements.name_norm of the place. */
  key: string;
  name: string;
  name_lat: string;
  /** false = not a place in mk_settlements (its own spelling is shown). */
  known: boolean;
  /** How many raw spellings folded into this place. */
  spellings: number;
}

export interface SalesCities {
  rows: SalesCity[];
  others: SalesCityCounts & { places: number };
  /** Sales with no city at all. */
  unknown: SalesCityCounts;
  places: number;
  spellings: number;
  unknown_places: number;
  unknown_places_count: number;
  unknown_places_value_mkd?: number;
}

export interface SalesCustomers {
  buyers: number;
  new: number;
  returning: number;
  /** Buyers with two or more sales in the period. */
  repeat: number;
  /** Buyers who bought from two or more sources in the period. */
  cross_source: number;
  sales: number;
  sales_new: number;
  sales_returning: number;
  value_new_mkd?: number;
  value_returning_mkd?: number;
  no_phone: number;
  /** How far back "bought before" can see (YYYY-MM-DD). */
  history_from: string | null;
  by_source: { key: CohortSourceKey; buyers: number; new: number; returning: number; repeat: number }[];
}

export type SalesBasketKey = '1' | '2' | '3' | '4' | '5' | 'none';

export interface SalesBasket {
  /** Packages per sale: 1 … 4, 5 = five or more, none = no package data (MEX-only). */
  dist: { key: SalesBasketKey; count: number; value_mkd?: number }[];
  by_source: {
    key: CohortSourceKey;
    count: number;
    with_units: number;
    units: number;
    value_mkd?: number;
    dist: { key: SalesBasketKey; count: number }[];
  }[];
}

export interface SalesDetail {
  meta: SalesMeta;
  total: { count: number; value_mkd?: number };
  products: SalesProducts;
  cities: SalesCities;
  customers: SalesCustomers;
  basket: SalesBasket;
}

export function apiGetInsightsSales(
  params: { from: string; to: string; compare?: boolean; part: 'core' },
  signal?: AbortSignal,
): Promise<SalesCore>;
export function apiGetInsightsSales(
  params: { from: string; to: string; compare?: boolean; part: 'detail' },
  signal?: AbortSignal,
): Promise<SalesDetail>;
export function apiGetInsightsSales(
  params: { from: string; to: string; compare?: boolean; part: 'core' | 'detail' },
  signal?: AbortSignal,
): Promise<SalesCore | SalesDetail> {
  const sp = new URLSearchParams({ from: params.from, to: params.to, part: params.part });
  if (params.compare && params.part === 'core') sp.set('compare', '1');
  return apiFetch(`insights/sales?${sp.toString()}`, { signal });
}
