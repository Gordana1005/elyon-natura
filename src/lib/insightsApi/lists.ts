/**
 * GET /api/insights/lists?from&to&compare=1 — Insights → Prediction lists
 * (migration 20260941000400 insights_lists + insights_lists_cash; api module
 * supabase/functions/api/insightsLists.ts).
 *
 * The prediction-list slice of the Affiliate – Lead out department (`elyon_crm`)
 * of THE sale cohort (insights_sale_rows): sale day (Skopje), MEX-first buckets
 * that add up exactly to the total, value = parcel COD else price × 61,5 — all
 * in денари (`*_mkd`, render with formatDenari, never convert again). Σ lists +
 * not_recorded = the Overview's Affiliate – Lead out · prediction_list split; +
 * elyon_crm's other splits = its Affiliate – Lead out card. A list sale shipped
 * on a NATURA 9102 / 9100 / 9108 parcel counts in Телешоп – Lead out / Lead in /
 * Social media instead (owner 28.09), so every /orders link here also carries
 * cohort_source=elyon_crm.
 *
 * Money keys (`*_mkd`) are owners only: an admin/manager gets the same payload
 * with every money key ABSENT (meta.money = false).
 */
import { apiFetch } from '@/lib/api';
import type {
  CohortBucket, CohortBucketKey, CohortOutside, CohortOutsideKey,
} from '@/components/insights/shared/cohortTypes';

export interface ListsPart {
  key: CohortBucketKey | CohortOutsideKey;
  count: number;
  value_mkd?: number;
  cod_mkd?: number;
}

export interface ListsSeller {
  person_id: string;
  name: string | null;
  sales: number;
  value_mkd?: number;
  worked: number;
}

/** One prediction list: members NOW, the period's work and its cohort sales. */
export interface ListsRow {
  id: string;
  /** The list's exact name — DISPLAY through predictionListLabel(), never rename. */
  name: string | null;
  category: 'value' | 'cancel' | 'return' | 'other' | string | null;
  is_static: boolean;
  is_active: boolean;
  /** false = the list row no longer exists (its sales keep their snapshot name). */
  known: boolean;
  order: number | null;
  members: number;
  members_active: number;
  members_assigned: number;
  /** "No answer" clicks, filed under the list the number is in NOW (approximate). */
  no_answer: number;
  worked: number;
  worked_sale: number;
  worked_no: number;
  worked_trash: number;
  customers: number;
  count: number;
  value_mkd?: number;
  cod_mkd?: number;
  cash_mkd?: number;
  paid: number;
  returned: number;
  units: number;
  stale_to_pack: number;
  stale_to_pack_value_mkd?: number;
  /** Only the parts above 0. */
  buckets: ListsPart[];
  outside: ListsPart[];
  /** The orders' snapshot name for GET /orders?prediction_list= (null = no exact link). */
  drill_name: string | null;
  /** YYYY-MM-DD of the list's latest sale ever. */
  last_sale: string | null;
  agents: ListsSeller[];
  /** Sales per trend period, aligned with `trend` (null = none in the trend window). */
  spark: number[] | null;
  spark_mkd?: number[] | null;
}

export interface ListsTotal {
  count: number;
  value_mkd?: number;
  cod_mkd?: number;
  cash_mkd?: number;
  paid: number;
  returned: number;
  units: number;
  stale_to_pack: number;
  stale_to_pack_value_mkd?: number;
  lists_with_sales: number;
  worked: number;
  worked_sale: number;
  worked_no: number;
  worked_trash: number;
  customers: number;
  people: number;
  no_answer: number;
  no_answer_unlisted: number;
  orders: number;
  web: number;
  mex_only: number;
}

export interface ListsNotRecorded {
  count: number;
  value_mkd?: number;
  cash_mkd?: number;
  paid: number;
  returned: number;
  units: number;
  stale_to_pack: number;
  buckets: ListsPart[];
  outside: ListsPart[];
  worked: number;
  samples: { display_id: string; dup_of: string | null; dup_of_list: string | null }[];
}

export interface ListsTrendPoint {
  /** YYYY-MM-DD (day) or YYYY-MM (month). */
  d: string;
  count: number;
  value_mkd?: number;
  parts: ListsPart[];
}

export interface ListsAgent {
  person_id: string;
  name: string | null;
  sales: number;
  value_mkd?: number;
  cash_mkd?: number;
  paid: number;
  returned: number;
  lists: number;
  worked: number;
  worked_no: number;
  worked_trash: number;
  /** Active minutes over the window's days that have presence (null = none). */
  active_minutes: number | null;
  presence_days: number;
  /** Sales on the days presence covers — the numerator of sales per hour. */
  sales_on_presence_days: number;
}

export type ListsQualityKind =
  | 'unproven_paid' | 'stale_to_pack' | 'duplicate_original_open' | 'list_not_recorded'
  | 'ghost_dispositions' | 'no_seller' | 'cancelled_but_moving' | 'zero_cod_parcels';

export interface ListsQuality {
  kind: ListsQualityKind;
  count: number;
  value_mkd?: number;
  cod_mkd?: number;
  /** stale_to_pack: of them, a MEX parcel exists on the same number since. */
  with_parcel?: number;
  samples: string[];
}

export interface ListsCashFlow {
  parcels: number;
  from_earlier?: number;
  cod_mkd?: number;
  from_this_period_mkd?: number;
  from_earlier_mkd?: number;
}

export interface ListsResponse {
  meta: {
    from: string;
    to: string;
    today: string;
    prev_from: string | null;
    prev_to: string | null;
    prev_to_end?: string | null;
    partial?: boolean;
    days?: number;
    generated_at: string;
    money: boolean;
    clock: 'sale';
    granularity: 'day' | 'month';
    /** The trend starts here (at least 14 days, so a short period still has a line). */
    trend_from: string;
    stale_days: number;
    has_prev: boolean;
    /** The first list-attributed order (YYYY-MM-DD): nothing before it can be attributed. */
    first_attr_day: string | null;
    /** Agent presence exists from this day (YYYY-MM-DD) — per-hour rates only from here. */
    presence_from: string | null;
  };
  total: ListsTotal;
  buckets: CohortBucket[];
  outside: CohortOutside[];
  lists: ListsRow[];
  not_recorded: ListsNotRecorded;
  /** The whole Affiliate – Lead out department (= the Overview's card of `elyon_crm`). */
  elyon_crm: { count: number; value_mkd?: number; splits: { key: string; count: number; value_mkd?: number; cash_mkd?: number }[] };
  prev: { count: number; value_mkd?: number; cash_mkd?: number } | null;
  trend: ListsTrendPoint[];
  cash_flow: ListsCashFlow | null;
  agents: ListsAgent[];
  quality: ListsQuality[];
}

export const apiGetInsightsLists = (
  params: { from: string; to: string; compare?: boolean },
  signal?: AbortSignal,
): Promise<ListsResponse> => {
  const sp = new URLSearchParams({ from: params.from, to: params.to });
  if (params.compare) sp.set('compare', '1');
  return apiFetch(`insights/lists?${sp.toString()}`, { signal });
};
