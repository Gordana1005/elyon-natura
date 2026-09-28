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
 * convert again. VAT is the api's VAT_RATE (18 %, pending the accountant),
 * courier the courier_rates 'mex' row (150 ден), lead cost a wired-but-zero
 * slot, commission today's per-package rule (unchanged).
 */
import { apiFetch } from '@/lib/api';
import type { CohortBucket, CohortOutside } from '@/components/insights/shared/cohortTypes';

export const PROFIT_SOURCES = ['altercpa', 'elyon_crm', 'web', 'teleshop_other'] as const;
export type ProfitSourceKey = (typeof PROFIT_SOURCES)[number];

export interface PLRow {
  key: string;
  sales: number;
  revenue_mkd: number;
  card_mkd: number;
  vat_mkd: number;
  cogs_known_mkd: number;
  /** null: nothing in the view is costed, so nothing can be estimated. */
  cogs_est_mkd: number | null;
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
  cost_known: boolean;
  unit_cost_mkd: number | null;
  cogs_mkd: number;
  cogs_est_mkd: number | null;
  vat_mkd: number;
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
  | 'orders_without_lines' | 'vat_unconfirmed' | 'lead_cost_missing' | 'return_fee_unconfirmed';

export interface ProfitQuality {
  kind: ProfitQualityKind;
  severity: 'critical' | 'warning' | 'info';
  count: number;
  value_mkd?: number;
  share?: number | null;
  top?: { key: string; name: string | null; packages: number; revenue_mkd: number }[];
}

type StripTotal = { count: number; value_mkd: number; cod_mkd: number; orders: number; web: number; mex_only: number };

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
    vat: { rate: number; confirmed: boolean };
    courier: { deliver_mkd: number; return_mkd: number; source: 'courier_rates' | 'fallback' };
    lead_cost: { configured: boolean };
    commission: { rule: string; agents: number };
    mkd_per_eur: number;
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

export interface ProfitParams { from: string; to: string; compare?: boolean }

export function apiGetInsightsProfit(p: ProfitParams, signal?: AbortSignal): Promise<ProfitResponse> {
  const qs = new URLSearchParams({ from: p.from, to: p.to });
  if (p.compare) qs.set('compare', '1');
  return apiFetch<ProfitResponse>(`insights/profit?${qs.toString()}`, { signal });
}

/** One query key for both tabs (Pure Profit and Margins share the payload). */
export const profitQueryKey = (userId: string | undefined, p: ProfitParams) =>
  ['insights-profit', userId, p.from, p.to, !!p.compare] as const;
