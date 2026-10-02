/**
 * GET /api/insights/profit?from&to&compare=1 — Insights → Pure Profit and
 * Margins (migration 20260941000300 insights_profit; api module
 * supabase/functions/api/insightsProfit.ts). OWNERS ONLY (403 owners_only for
 * a non-owner admin / manager).
 *
 * Two clocks, never mixed:
 *   cohort — the sales made in the period (sale day, Skopje) and what MEX
 *            collected on them; the strip ties to /insights/cohort
 *   cash   — the MEX money delivered in the period (any sale day) + card
 * Every money key is whole денари (`*_mkd`): render with formatDenari, never
 * convert again. VAT is PER PRODUCT from Sigma (owner 01.10.2026, docs/VAT.md):
 * each line at its product's rate (5 % supplements, 18 % cosmetics / devices),
 * a line with no rate at 5 % and shown apart (meta.vat); courier the
 * courier_rates 'mex' row (150 ден), lead cost a wired-but-zero slot,
 * commission today's per-package rule (unchanged). Purchase cost (owner
 * 01.10.2026): Sigma CalcBuyPrice through each product's approved recipe at the
 * sale day (meta.cost.source 'sigma'), or the old catalogue price ('legacy'),
 * plus the extra goods packed in the parcel (cogs_extra_mkd, Phase B).
 */
import { apiFetch } from '@/lib/api';
import type { CohortBucket, CohortOutside } from '@/components/insights/shared/cohortTypes';

/** The departments, in the owner's order (28.09.2026; Менаџмент last, 02.10.2026 —
 *  20260947001000) — the P&L's columns (an empty Менаџмент column is not shown: plColumns). */
export const PROFIT_SOURCES = ['altercpa', 'elyon_crm', 'teleshop_out', 'teleshop_other', 'social', 'web', 'management'] as const;
export type ProfitSourceKey = (typeof PROFIT_SOURCES)[number];

/** One rate's part of the VAT line: the gross value taxed at it and its VAT. */
export interface VatPart { rate: number; revenue_mkd: number; vat_mkd: number }

export interface PLRow {
  key: string;
  sales: number;
  revenue_mkd: number;
  card_mkd: number;
  /** Σ per line at each product's Sigma rate. */
  vat_mkd: number;
  /** The VAT of the costed packages alone (absent from an api older than 01.10.2026). */
  vat_costed_mkd?: number;
  /** The VAT line by rate; Σ = vat_mkd up to rounding. */
  vat_split?: VatPart[];
  /** The value with no rate on file, taxed at the default rate. */
  vat_unclassified?: { revenue_mkd: number; vat_mkd: number };
  cogs_known_mkd: number;
  /** null: nothing in the view is costed, so nothing can be estimated. */
  cogs_est_mkd: number | null;
  /** Phase B — gifts and other goods packed beyond the order lines (signed; absent from an api
   *  older than the Sigma costs, 0 while Phase B is off). Part of the costed basis. */
  cogs_extra_mkd?: number;
  cogs_extra_detail?: { mex_only_mkd: number; mex_only_revenue_mkd: number; negative_mkd: number; sales: number };
  courier_mkd: number;
  returns_mkd: number;
  commission_mkd: number;
  lead_cost_mkd: number;
  net_mkd: number;
  /** Uncosted packages at 0 — an upper bound, never the headline. */
  net_upper_mkd: number;
  margin: number | null;
  costed: { revenue_mkd: number; net_mkd: number; margin: number | null };
  revenue_costed_mkd: number;
  revenue_uncosted_mkd: number;
  revenue_other_mkd: number;
  packages: number;
  free_packages: number;
  packages_costed: number;
  packages_uncosted: number;
  coverage_packages: number | null;
  coverage_revenue: number | null;
  parcels_delivered: number;
  parcels_returned: number;
  returned: number | null;
  returned_mkd: number | null;
  return_rate: number | null;
  aov_mkd: number | null;
  cost_per_sale_mkd: number | null;
  profit_per_sale_mkd: number | null;
  packages_per_sale: number | null;
}

export interface ProfitTrendPoint { d: string; sales: number; revenue_mkd: number; net_mkd: number }

export interface ProfitAffiliate {
  key: string;
  name: string | null;
  sales_total: number;
  open: number;
  pl: PLRow;
}

export interface ProfitClock {
  clock: 'sale' | 'delivered';
  cost_ratio: number | null;
  total: PLRow;
  by_source: PLRow[];
  prev: { revenue_mkd: number; net_mkd: number; sales: number; margin: number | null } | null;
  trend: ProfitTrendPoint[];
  affiliates: ProfitAffiliate[];
  open: { count: number; value_mkd: number } | null;
  unproven: { count: number; value_mkd: number } | null;
}

export interface ProfitProduct {
  key: string;
  name: string | null;
  kind: 'product' | 'gift' | 'loyalty_point' | 'delivery' | 'note' | 'flyer' | 'unknown' | string;
  reviewed: boolean;
  package: boolean;
  sources: ProfitSourceKey[];
  sales: number;
  packages: number;
  free_packages: number;
  revenue_mkd: number;
  /** Every package costed (Sigma: an approved recipe with every article costed on every sale day). */
  cost_known: boolean;
  /** Some packages costed, some not (a recipe that starts inside the window). */
  cost_partial?: boolean;
  /** The average unit cost of the costed packages (денари). */
  unit_cost_mkd: number | null;
  packages_costed?: number;
  cogs_mkd: number;
  cogs_est_mkd: number | null;
  /** The product's share of the extra packed goods (Phase B). */
  cogs_extra_mkd?: number;
  vat_mkd: number;
  /** The rate used (the product's, else the default); null = "others" of mixed rates. */
  vat_rate?: number | null;
  /** false = no Sigma rate on file — taxed at the default, listed as unclassified. */
  vat_classified?: boolean;
  courier_mkd: number;
  commission_mkd: number;
  commission_share: number | null;
  net_mkd: number;
  margin: number | null;
  returned_packages: number;
  returned_mkd: number;
  return_rate: number | null;
}

export interface ProfitDistribution {
  packages: number;
  avg_mkd: number | null;
  min_mkd: number | null;
  p25_mkd: number | null;
  median_mkd: number | null;
  p75_mkd: number | null;
  max_mkd: number | null;
}

export type ProfitQualityKind =
  | 'uncosted_packages' | 'mex_only_contents' | 'unproven_paid' | 'non_product_lines'
  | 'orders_without_lines' | 'vat_unclassified' | 'vat_flat_default' | 'lead_cost_missing' | 'return_fee_unconfirmed'
  | 'cost_legacy' | 'recipe_missing' | 'extra_goods_negative';

/** meta.cost (Sigma purchase costs, owner 01.10.2026; absent from an older api = legacy). */
export interface ProfitCostMeta {
  source: 'sigma' | 'legacy' | 'mixed';
  basis: 'sigma_calcbuyprice' | 'catalogue_cost_price';
  /** The Sigma snapshot date (YYYY-MM-DD). */
  as_of: string | null;
  extra_goods: boolean;
  coverage: { cohort: { packages: number | null; revenue: number | null }; cash: { packages: number | null; revenue: number | null } };
  uncosted_products: number;
  partial_products: number;
}

/** What had no rate (taxed at the default), cohort clock, by kind. */
export interface VatUnclassified {
  revenue_mkd: number;
  vat_mkd: number;
  mex_only_mkd: number;
  no_lines_mkd: number;
  unmatched_mkd: number;
  no_rate_mkd: number;
  products: number;
}

/** meta.vat (01.10.2026). An api older than that sends only {rate, confirmed}. */
export interface ProfitVatMeta {
  /** per_product_sigma = Σ per line at each product's Sigma rate; flat_default = everything at default_rate. */
  mode?: 'per_product_sigma' | 'flat_default';
  default_rate?: number;
  /** = default_rate (kept for older clients). */
  rate: number;
  confirmed: boolean;
  source?: 'sigma';
  by_rate?: { cohort: Record<string, { revenue_mkd: number; vat_mkd: number }>; cash: Record<string, { revenue_mkd: number; vat_mkd: number }> };
  effective_rate?: { cohort: number | null; cash: number | null };
  unclassified?: { cohort: VatUnclassified | null; cash: { revenue_mkd: number; vat_mkd: number } };
}

export interface ProfitQuality {
  kind: ProfitQualityKind;
  severity: 'critical' | 'warning' | 'info';
  count: number;
  value_mkd?: number;
  share?: number | null;
  top?: { key: string; name: string | null; packages: number; revenue_mkd: number }[];
}

type StripTotal = { count: number; value_mkd: number; cod_mkd: number; orders: number; web: number; mex_only: number; booked?: number };

export interface ProfitResponse {
  meta: {
    from: string;
    to: string;
    days: number;
    partial: boolean;
    prev_from: string | null;
    prev_to: string | null;
    prev_to_end: string | null;
    prev_skipped: boolean;
    prev_max_days: number;
    generated_at: string;
    money: true;
    granularity: 'day' | 'month';
    vat: ProfitVatMeta;
    /** Where the purchase cost came from (absent from an api older than the Sigma costs). */
    cost?: ProfitCostMeta;
    courier: { deliver_mkd: number; return_mkd: number; source: 'courier_rates' | 'fallback' };
    lead_cost: { configured: boolean };
    commission: { rule: string; agents: number };
    mkd_per_eur: number;
    /** Windows over 62 days: the closed months read from the monthly cache
     *  (insights_profit_monthly); null for shorter windows (all live). */
    cache: ProfitCacheMeta | null;
  };
  /** The cohort strip in /insights/cohort's shape (CohortBar). */
  strip: {
    total: StripTotal;
    buckets: CohortBucket[];
    outside: CohortOutside[];
    by_source: { key: ProfitSourceKey; total: StripTotal; buckets: CohortBucket[]; outside: CohortOutside[] }[];
  };
  cohort: ProfitClock;
  cash: ProfitClock;
  products: ProfitProduct[];
  products_others: ProfitProduct | null;
  products_total: number;
  realized: Record<'all' | ProfitSourceKey, ProfitDistribution>;
  quality: ProfitQuality[];
}

export interface ProfitCacheMeta {
  months: { cohort: number; cash: number };
  closed_months: number;
  /** The oldest snapshot used — "cached until". */
  refreshed_min: string | null;
  refreshed_max: string | null;
  live: { clock: 'cohort' | 'cash'; from: string; to: string }[];
}

export interface ProfitParams { from: string; to: string; compare?: boolean }

/** POST /insights/profit/refresh — recompute the window's closed months of the
 *  cache (owners). Returns what is still left when the ~90 s budget ran out. */
export function apiRefreshInsightsProfit(p: { from: string; to: string }): Promise<{ refreshed: string[]; remaining: string[]; ms: number }> {
  const qs = new URLSearchParams({ from: p.from, to: p.to });
  return apiFetch(`insights/profit/refresh?${qs.toString()}`, { method: 'POST' });
}

export function apiGetInsightsProfit(p: ProfitParams, signal?: AbortSignal): Promise<ProfitResponse> {
  const qs = new URLSearchParams({ from: p.from, to: p.to });
  if (p.compare) qs.set('compare', '1');
  return apiFetch<ProfitResponse>(`insights/profit?${qs.toString()}`, { signal });
}

/** One query key for both tabs (Pure Profit and Margins share the payload). */
export const profitQueryKey = (userId: string | undefined, p: ProfitParams) =>
  ['insights-profit', userId, p.from, p.to, !!p.compare] as const;
