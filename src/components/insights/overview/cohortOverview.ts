/**
 * The Overview's source cards over the shared sales cohort (../shared/cohort*):
 * which buckets a tile adds up, where a split chip may link, and the lead
 * outcomes. Pure — cohortOverview.test.ts covers it; the cards only lay it out.
 *
 * Split keys (by_source[].splits, each with its `kind`) — the six departments
 * of 28.09.2026:
 *   order  a sale_source_detail — altercpa (Affiliate – Lead in) `bridge` /
 *          `history` / `partner` / `collabbox_leads` · elyon_crm (Affiliate –
 *          Lead out) `prediction_list` / `direct` / `collabbox_leads_out`, and
 *          until the data reclass `team_prediction` / `team_collabbox_leads_out`
 *          · teleshop_out (Телешоп – Lead out) `teleshop_out` (collabBox
 *          "Нарачка out"; `collabbox_out` before the reclass) /
 *          `team_collabbox_out` / `prediction_list` / `direct` (a CRM sale on a
 *          9102 parcel) · teleshop_other (Телешоп – Lead in) `teleshop` /
 *          `leads` / `leads_out` / a series, and a CRM sale on a 9100 parcel ·
 *          social `social` (/ `1300`), and a CRM sale on a 9108 parcel · legacy
 *          `<source_type>`; `none` = no detail recorded (no filter can name it).
 *          The same detail can sit in two departments, so a chip's link always
 *          carries its row's cohort_source.
 *   web    the shop mirror by payment: `cod`, `card` — never /orders
 *   mex    parcels with no order, in the department their series names (owner
 *          28.09): Affiliate – Lead in `mex_leads` (9110) · Affiliate – Lead
 *          out `mex_leads_out` (9103) · Телешоп – Lead out `mex_out` (9102) ·
 *          Телешоп – Lead in `mex_in` (9100) and `mex_other` (no series …) ·
 *          Social media `mex_social` (9108 / 1300) · web `mex_web` (NTMK… / M…)
 *          — never /orders
 * Anything else renders with its label (or raw key) and no link.
 */
import { COHORT_SOURCE_PARAM, COHORT_SOURCES, type CohortBucketKey, type CohortSourceRow, type CohortSplit } from '../shared/cohortTypes';
import {
  COHORT_DRILL_PARAM, isMexOnlySplit, ordersSupportsCohortDrill, sumParts, type DrillBlock, type Part,
} from '../shared/cohortModel';
import type { DayRange } from '../shared/period';

export { workedOf } from '../shared/cohortModel';

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** A sale_source_detail GET /orders accepts as a filter (overview.ts DETAIL_RE). */
const DETAIL_RE = /^[a-z0-9_.-]{1,40}$/i;

/**
 * Whether a department has a lead funnel (came in → worked → became a sale).
 * Телешоп — Lead in AND Lead out — has none: every collabBox Нарачка document
 * IS a sale, so "came in = became sales = 100 %" would be a tautology (owner,
 * 28.09.2026). Nor does Social media: its orders are collabBox social documents.
 */
export const NO_FUNNEL_SOURCES: readonly string[] = ['teleshop_out', 'teleshop_other', 'social'];
export const hasLeadFunnel = (key: string) => !NO_FUNNEL_SOURCES.includes(key);

/** The buckets a tile adds up: "Кај курирот" = moving + problem (MEX 1/4/10 and 3/9/13). */
export const tileBuckets = (k: CohortBucketKey): CohortBucketKey[] => (k === 'courier' ? ['courier', 'courier_problem'] : [k]);

/** A tile's number from the bucket parts. */
export const tilePart = (parts: Record<CohortBucketKey, Part>, k: CohortBucketKey): Part =>
  sumParts(tileBuckets(k).map((b) => parts[b]));

export type SplitBlock = DrillBlock | 'not_orders';

/**
 * A split chip opens that split's sales of the period — only an ORDER split
 * with a detail the list can filter on, and only once /orders can filter the
 * cohort (the same gate as every other cohort number: a link to a wider list
 * would be worse than none). The link is the cohort's own (cohort_bucket=total
 * + the split's detail + the sale window), so it lists exactly the chip.
 */
export function splitDrill(
  row: Pick<CohortSourceRow, 'key'>, split: CohortSplit, range: DayRange, supported: boolean = ordersSupportsCohortDrill(),
): { href: string | null; blocked: SplitBlock | null } {
  if (!(num(split.count) > 0)) return { href: null, blocked: 'none' };
  if (split.kind === 'web') return { href: null, blocked: 'web' };
  if (isMexOnlySplit(split)) return { href: null, blocked: 'mex_only' };
  const known = (COHORT_SOURCES as readonly string[]).includes(row.key);
  if (split.kind !== 'order' || split.key === 'none' || !DETAIL_RE.test(split.key) || !known) {
    return { href: null, blocked: 'not_orders' };
  }
  if (!supported) return { href: null, blocked: 'unsupported' };
  const sp = new URLSearchParams();
  sp.set(COHORT_DRILL_PARAM, 'total');
  sp.set(COHORT_SOURCE_PARAM, row.key);
  sp.set('sale_source_detail', split.key);
  sp.set('sold_from', range.from);
  sp.set('sold_to', range.to);
  return { href: `/orders?${sp.toString()}`, blocked: null };
}
