/**
 * GET /api/insights/returns?from&to&compare=1&source=…&clock=sale|returned and
 * GET /api/insights/stock?from&to&compare=1&source=… — Insights → Враќања and
 * Производи и залихи (migration 20260941000500 insights_returns / insights_stock;
 * api module supabase/functions/api/insightsReturnsStock.ts).
 *
 * Returns has two clocks: `sale` (THE sale cohort — the period's sales and how
 * many came back so far; ties to GET /insights/cohort's returned part) and
 * `returned` (the MEX return day — what physically came back in the period;
 * ties to the parcel register). Stock: units per product from the cohort's
 * item lines, the warehouse queue NOW, stock on hand only where tracked with a
 * trust verdict, catalogue hygiene.
 *
 * Money keys (`*_mkd`, денари — render with formatDenari, never convert again)
 * and the stock valuation are owners only: everyone else gets the same payload
 * with them ABSENT (meta.money = false).
 */
import { apiFetch } from '@/lib/api';
import type { CohortSourceKey } from '@/components/insights/shared/cohortTypes';

export type ReturnsClock = 'sale' | 'returned';

export interface RsMeta {
  from: string;
  to: string;
  prev_from: string | null;
  prev_to: string | null;
  prev_to_end?: string | null;
  partial?: boolean;
  days?: number;
  generated_at: string;
  money: boolean;
  clock: ReturnsClock;
  granularity: 'day' | 'month';
  sources?: CohortSourceKey[];
  has_prev: boolean;
  /** Stock only: Skopje today (the queue's ages count from it). */
  today?: string;
}

/** A count, what it is made of (orders + web + mex_only) and, for owners, денари. */
export interface RsPart {
  count: number;
  value_mkd?: number;
  orders?: number;
  web?: number;
  mex_only?: number;
}

export interface ReturnsKpis {
  /** sale clock: the period's sales · returned clock: every parcel that finished (delivered ∪ returned). */
  base: RsPart;
  returned: RsPart & { cod_mkd?: number; parcels: number };
  /** returned / base, 0..1 (null when the base is 0). */
  rate: number | null;
  paid: RsPart;
  /** Sale clock only: the cohort still open (at the courier, label, to pack). */
  open: (RsPart & { share: number | null }) | null;
  /** Sale clock only: at the courier with a problem (13 rejected · 9 attempted · 3 problematic). */
  problem: (RsPart & { rejected: number; attempted: number; problematic: number }) | null;
  /** CRM says returned, no MEX parcel. */
  crm_only_returned: RsPart;
  cancelled_after_sale: RsPart;
  trashed_after_sale: RsPart;
  round_trip: {
    parcels: number;
    return_cost_mkd?: number;
    deliver_cost_mkd?: number;
    loss_mkd?: number;
    outbound_if_billed_mkd?: number;
  };
  prev: { base: number; returned: number; value_mkd?: number; rate: number | null } | null;
}

export interface ReturnsNow {
  rejected: RsPart;
  attempted: RsPart;
  problematic: RsPart;
  oldest: string | null;
}

export interface ReturnsSplit { key: string; kind: 'order' | 'web' | 'mex'; base: number; returned: number; value_mkd?: number; rate: number | null }

export interface ReturnsSourceRow {
  key: CohortSourceKey;
  base: number;
  base_value_mkd?: number;
  returned: number;
  value_mkd?: number;
  rate: number | null;
  open: number;
  base_orders: number;
  base_web: number;
  base_mex_only: number;
  /** The returned part's composition. */
  orders: number;
  web: number;
  mex_only: number;
  splits: ReturnsSplit[];
}

export interface RateRow { base: number; returned: number; value_mkd?: number; rate: number | null }

export interface ReturnsProductRow {
  key: string;
  name: string | null;
  catalogue: boolean;
  sold_units: number;
  returned_units: number;
  free_units: number;
  free_returned_units: number;
  rate: number | null;
}

export interface ReturnsResponse {
  meta: RsMeta;
  kpis: ReturnsKpis;
  now: ReturnsNow;
  by_source: ReturnsSourceRow[];
  by_account: (RateRow & { key: 'bio_natural' | 'natura' | '__none__' | string })[];
  by_product: {
    rows: ReturnsProductRow[];
    others: { products: number; sold_units: number; returned_units: number } | null;
    total: { sold_units: number; returned_units: number; free_units: number; free_returned_units: number };
    mex_only: { base: number; returned: number };
    not_products: { kind: string; units: number }[];
  };
  by_city: {
    rows: (RateRow & { key: string; name: string | null; name_lat: string | null; name_sq: string | null })[];
    others: (RateRow & { places: number }) | null;
    unknown: RateRow | null;
    places: number;
  };
  by_person: {
    rows: (RateRow & { person_id: string; name: string | null })[];
    others: (RateRow & { people: number }) | null;
    none: RateRow | null;
  };
  by_list: (RateRow & { list_id: string; name: string | null })[];
  by_weekday: { dow: number; base: number; returned: number; rate: number | null }[];
  days_to_return: {
    count: number;
    median_from_sale: number | null;
    median_at_courier: number | null;
    bins: { key: '0_3' | '4_7' | '8_14' | '15_21' | '22_30' | '31_plus'; count: number }[];
  };
  reasons: { bucket: 'cancelled_after_sale' | 'trashed_after_sale'; reason: string; count: number; value_mkd?: number }[];
  repeat: {
    phones: number;
    returns_in_window: number;
    rows: { phone8: string; name: string | null; returned_all: number; delivered_all: number; in_window: number; last_returned: string | null }[];
  };
  trend: { d: string; base: number; returned: number; open: number; value_mkd?: number }[];
}

// ── Stock ───────────────────────────────────────────────────────────────────

export interface StockTrust {
  /** The count can be read: it was counted and the ledger follows the shipments. */
  trusted: boolean;
  last_count: string | null;
  last_restock: string | null;
  last_deduction: string | null;
  last_movement: string | null;
  last_parcel: string | null;
  parcels_since_deduction: number;
  ledger_out_window: number;
  ledger_in_window: number;
  ledger_moves_window: number;
  parcels_window: number;
  /** The stock regime (migration 20260942000100) — absent on an older database. */
  counted?: boolean;
  mex_enabled?: boolean;
  /** YYYY-MM-DD (Skopje): where MEX-driven stock movements start. */
  mex_from?: string | null;
  /** YYYY-MM-DDTHH:MM (Skopje): the MEX stock ledger's last successful run. */
  mex_last_run?: string | null;
}

export type QueueAgeKey = '0_2' | '3_7' | '8_14' | '15_30' | '31_plus';

export interface StockQueueStage {
  stage: 'to_pack' | 'label';
  count: number;
  value_mkd?: number;
  orders: number;
  web: number;
  mex_only: number;
  oldest: string | null;
  units: number;
  ages: { key: QueueAgeKey; count: number; value_mkd?: number; orders: number; web: number; mex_only: number; from: string; to: string }[];
  by_source: { key: CohortSourceKey; count: number; value_mkd?: number; orders: number; web: number; mex_only: number; oldest: string | null }[];
}

export type StockState = 'ok' | 'low' | 'out' | 'not_tracked' | null;

export interface StockProductRow {
  key: string;
  product_id: string | null;
  name: string | null;
  sku: string | null;
  catalogue: boolean;
  tracked: boolean;
  placeholder: boolean;
  state: StockState;
  on_hand: number | null;
  low_threshold: number | null;
  cost_known: boolean | null;
  units: number;
  units_prev: number | null;
  by_source: Record<CohortSourceKey, number>;
  free_units: number;
  returned_units: number;
  queue_units: number;
  pack_units: number;
  label_units: number;
  days_cover: number | null;
  cost_mkd?: number | null;
  price_mkd?: number | null;
  stock_value_mkd?: number | null;
}

export interface StockResponse {
  meta: RsMeta;
  trust: StockTrust;
  kpis: {
    sales: number;
    sales_mex_only: number;
    units: number;
    units_prev: number | null;
    free_units: number;
    units_catalogue: number;
    products_sold: number;
    returned_units: number;
    returned_parcels: number;
    returned_mex_only: number;
    tracked: number;
    active: number;
    /** Only when the count is trusted. */
    out: number | null;
    low: number | null;
  };
  queue: StockQueueStage[];
  queue_products: { key: string; name: string | null; catalogue: boolean; pack_units: number; label_units: number; on_hand: number | null }[];
  products: StockProductRow[];
  products_more: { products: number; units: number } | null;
  trend: { d: string; units: number; by_source: Record<CohortSourceKey, number> }[];
  hygiene: {
    duplicates: { key: string; products: { product_id: string; name: string; tracked: boolean; on_hand: number | null; units: number }[] }[];
    unmapped: { names: number; units: number; rows: { name: string; units: number }[] };
    no_cost: { active: number; selling: number; units: number; rows: { product_id: string; name: string; units: number }[] };
    not_products: { kind: string; units: number; lines: number }[];
    not_tracked: number;
    placeholder: number;
    inactive_selling: number;
  };
  /** Owners only, and only when the count is trusted. */
  valuation?: { cost_mkd?: number; price_mkd?: number; coverage: number | null } | null;
}

export interface RsParams { from: string; to: string; compare?: boolean; sources?: string[] }

const query = (p: RsParams) => {
  const sp = new URLSearchParams({ from: p.from, to: p.to });
  if (p.compare) sp.set('compare', '1');
  if (p.sources?.length) sp.set('source', p.sources.join(','));
  return sp;
};

export const apiGetInsightsReturns = (p: RsParams & { clock: ReturnsClock }, signal?: AbortSignal): Promise<ReturnsResponse> => {
  const sp = query(p);
  sp.set('clock', p.clock);
  return apiFetch(`insights/returns?${sp.toString()}`, { signal });
};

export const apiGetInsightsStock = (p: RsParams, signal?: AbortSignal): Promise<StockResponse> =>
  apiFetch(`insights/stock?${query(p).toString()}`, { signal });
