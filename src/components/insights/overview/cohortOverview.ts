/**
 * The Overview's source cards over the shared sales cohort (../shared/cohort*):
 * which buckets a tile adds up, where a split chip may link, and the lead
 * outcomes. Pure — cohortOverview.test.ts covers it; the cards only lay it out.
 *
 * Split keys (by_source[].splits, each with its `kind`):
 *   order  a sale_source_detail — altercpa `bridge` / `history` / `partner` /
 *          `team_prediction` / `team_collabbox_out` / `team_collabbox_leads_out`
 *          / `collabbox_leads`, elyon_crm (Lead out) `prediction_list` /
 *          `direct` / `collabbox_out` / `collabbox_leads_out` (collabBox "out"
 *          documents of agents who work in the CRM, owner 28.09), social
 *          `social` (/ `1300`), teleshop_other (Lead in) `teleshop` / `leads` /
 *          `leads_out` / a series, legacy `<source_type>`; `none` = no detail
 *          recorded (no filter can name it)
 *   web    the shop mirror by payment: `cod`, `card` — never /orders
 *   mex    parcels with no order, in the source their series names (owner
 *          28.09): AlterCPA `mex_leads` (9110) · Lead out `mex_out` (9102 /
 *          9103) · Lead in `mex_in` (9100) and `mex_other` (no series …) ·
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
