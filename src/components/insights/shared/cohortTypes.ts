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
 * Sources (HANDOFF §3; owner 28.09.2026 — migration 20260942000500), keys fixed,
 * names and order the owner's: AlterCPA (`altercpa`) · Телешоп – Lead out
 * (`elyon_crm`; an order's own sale_source, never its parcel's series) ·
 * Телешоп – Lead in (`teleshop_other`: every collabBox order that is not social,
 * legacy rows) · Социјални мрежи (`social`: collabBox social documents — detail
 * `social` = series 9108, or `1300`) · Веб-продавница (`web`: the web_orders
 * mirror). A MEX parcel no order holds belongs to the source its SERIES names:
 * 9110 → AlterCPA (`mex_leads`) · 9102 / 9103 → Lead out (`mex_out`) · 9100 →
 * Lead in (`mex_in`) · 9108 / 1300 → Social media (`mex_social`) · NTMK… / M… →
 * the web shop (`mex_web`) · anything else → Lead in (`mex_other`).
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

export const COHORT_SOURCES = ['altercpa', 'elyon_crm', 'teleshop_other', 'social', 'web'] as const;
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
 *  · mex = MEX parcels with no order, by series (mex_leads · mex_out · mex_in ·
 *  mex_social · mex_web · mex_other). Only an order split can open /orders. */
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

/** The /orders param behind a source's ORDER part: GET /orders?cohort_source=
 *  <keys> is the api's twin of cohort_order_source(sale_source, detail)
 *  (insightsCommon.ts cohortSourceOrFilter). A sale_source list cannot say it
 *  since collabBox is two sources (Social media, Teleshop/Other). The web
 *  mirror and MEX-only parcels are not orders — `web` only ever lists the rare
 *  CRM-entered web order. */
export const COHORT_SOURCE_PARAM = 'cohort_source';

/** The cohort_source value for a set of sources: the known keys in display
 *  order, or null when none or all five are asked for (no filter — the api then
 *  also lists an order not classified yet, as the cohort counts it). */
export function cohortSourceParam(sources: readonly string[]): string | null {
  const known = COHORT_SOURCES.filter((k) => sources.includes(k));
  return known.length && known.length < COHORT_SOURCES.length ? known.join(',') : null;
}
