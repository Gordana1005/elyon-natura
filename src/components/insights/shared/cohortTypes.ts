/**
 * The shared sales-cohort contract (owner rules 2026-09-28) —
 * GET /api/insights/cohort?from&to&compare=1&source=… and the `cohort` key of
 * GET /api/insights/overview. Every /insights tab codes against this shape.
 *
 * TOTAL = the sales made in the period (sale day = coalesce(sold_at, the
 * AlterCPA ledger decision for approved / cancel_other, confirmed_at,
 * created_at), Skopje days), and the buckets split it EXACTLY: Σ buckets =
 * total, and every sale sits in one bucket. MEX status decides the bucket
 * whenever a parcel exists. Cancelled / trashed after sale and replacements
 * (0 ден) are OUTSIDE the total. The owner's test phones are in nothing.
 *
 * Sources (HANDOFF §3): AlterCPA · ElyonCRM (an order's own sale_source, never
 * its parcel's series) · Web shop (the web_orders mirror) · Teleshop/Other
 * (collabBox orders + EVERY MEX parcel with no order, split by channel; the
 * unlinked BIO NATURAL 9110/9103 parcels are the neutral `elyon_unlinked`).
 *
 * Every number says what it is made of — `orders` (GET /orders can list them),
 * `web` (the shop mirror) and `mex_only` (parcels with no order) — so a number
 * links to /orders only when it is all orders (exact), and otherwise offers
 * its order part alone.
 *
 * Money keys (`*_mkd`) are owners only (is_business_owner): an admin/manager
 * gets the same payload with every money key ABSENT (meta.money = false).
 * Values are денари: parcel COD when a parcel exists, else price × 61,5; the
 * web shop's total for web orders. Render them with formatDenari — never
 * convert them again.
 *
 * Kept local (not in src/lib/api.ts) while that file is shared by several
 * builders; move it there once it is free.
 */

export const COHORT_SOURCES = ['altercpa', 'elyon_crm', 'web', 'teleshop_other'] as const;
export type CohortSourceKey = (typeof COHORT_SOURCES)[number];

/** In-total buckets, in the bar's fixed order. */
export const COHORT_BUCKETS = [
  'paid', 'paid_legacy', 'paid_unproven', 'courier', 'courier_problem', 'label', 'to_pack', 'returned',
] as const;
export type CohortBucketKey = (typeof COHORT_BUCKETS)[number];

/** Outside the total — shown apart, never summed into sales: sold then
 *  cancelled (Откажани, red) or trashed (Во корпа, grey), and replacements. */
export const COHORT_OUTSIDE = ['cancelled_after_sale', 'trashed_after_sale', 'replacement'] as const;
export type CohortOutsideKey = (typeof COHORT_OUTSIDE)[number];

export const COHORT_QUALITY_KINDS = [
  'unproven_paid', 'zero_cod_parcels', 'double_count_candidates', 'no_seller', 'cancelled_but_moving',
] as const;
export type CohortQualityKind = (typeof COHORT_QUALITY_KINDS)[number];

export interface CohortMoney {
  /** Sold value in денари (owners only). */
  value_mkd?: number;
  /** MEX cash-on-delivery in денари (owners only). */
  cod_mkd?: number;
}

/** What a number is made of: orders + web + mex_only = count. `drill` is the
 *  api's /orders link for the orders part (null when there is none). */
export interface CohortComposition {
  orders?: number;
  web?: number;
  mex_only?: number;
  drill?: string | null;
}

export interface CohortBucket extends CohortMoney, CohortComposition {
  key: CohortBucketKey;
  count: number;
}

export interface CohortOutside extends CohortComposition {
  key: CohortOutsideKey;
  count: number;
  value_mkd?: number;
}

/** order = orders of one sale_source_detail · web = the shop mirror (cod | card)
 *  · mex = MEX parcels with no order (mex_teleshop, mex_social, mex_web,
 *  elyon_unlinked, mex_other). Only an order split can open /orders. */
export type CohortSplitKind = 'order' | 'web' | 'mex';

export interface CohortSplit {
  key: string;
  count: number;
  value_mkd?: number;
  kind?: CohortSplitKind;
  drill?: string | null;
}

/** Leads that came in (created in the period), each in exactly one state:
 *  became_sales + cancelled + trashed + open + other = came_in. */
export interface CohortLeadsIn {
  came_in: number;
  became_sales: number;
  cancelled: number;
  trashed: number;
  open: number;
  other?: number;
  /** ElyonCRM "no" call rows among the cancelled / trashed (never sales). */
  disposition?: number;
  /** 0..1 (became_sales / came_in); null when nothing came in. */
  conversion: number | null;
}

export type CohortTotal = { count: number } & CohortMoney & CohortComposition;

export interface CohortSourceRow {
  key: CohortSourceKey;
  total: CohortTotal;
  buckets: CohortBucket[];
  outside: CohortOutside[];
  splits: CohortSplit[];
  leads_in: CohortLeadsIn;
}

export interface CohortCashFlow {
  /** MEX COD delivered in the period, any sale day (owners only). */
  cod_mkd?: number;
  /** Web orders paid by card (shop PAID + MEX delivered) — their COD at MEX is 0 (owners only). */
  card_mkd?: number;
  parcels: number;
  /** Card-paid web orders among the parcels. */
  card_orders?: number;
  from_this_period_mkd?: number;
  from_earlier_mkd?: number;
}

export interface CohortQuality {
  kind: CohortQualityKind;
  count: number;
  value_mkd?: number;
}

export interface CohortSparkPoint {
  d: string;
  count: number;
  value_mkd?: number;
}

export interface Cohort {
  meta: {
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
    sources?: CohortSourceKey[];
    granularity?: 'day' | 'month';
  };
  total: CohortTotal;
  buckets: CohortBucket[];
  outside: CohortOutside[];
  by_source: CohortSourceRow[];
  leads_in: CohortLeadsIn;
  cash_flow: CohortCashFlow;
  prev?: { total: { count: number } & CohortMoney; buckets: CohortBucket[] } | null;
  spark: CohortSparkPoint[];
  quality: CohortQuality[];
}

/** /orders sale_source values behind each cohort source's ORDER part (the api's
 *  SOURCE_SALE_SOURCES): the web mirror and MEX-only parcels are not orders —
 *  `web` only ever lists the rare CRM-entered web order. */
export const COHORT_SALE_SOURCES: Record<CohortSourceKey, string[]> = {
  altercpa: ['altercpa', 'affiliate'],
  elyon_crm: ['elyon_crm'],
  web: ['web'],
  teleshop_other: ['collabbox', 'legacy'],
};

/** Every orders.sale_source — a drill over all of them sends no sale_source
 *  (the api then also lists an order not classified yet, as the cohort counts it). */
export const ALL_SALE_SOURCES = ['altercpa', 'affiliate', 'elyon_crm', 'web', 'collabbox', 'legacy'] as const;
