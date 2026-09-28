/**
 * The Overview's source cards over the shared sales cohort (../shared/cohort*):
 * which buckets a tile adds up, where a split chip may link, and the lead
 * outcomes. Pure — cohortOverview.test.ts covers it; the cards only lay it out.
 *
 * Split keys (by_source[].splits, each with its `kind`):
 *   order  a sale_source_detail — altercpa `bridge` / `history` / `partner`,
 *          elyon_crm `prediction_list` / `direct`, collabBox `teleshop` /
 *          `social` / `leads` / `leads_out` / a series, legacy `<source_type>`;
 *          `none` = no detail recorded (no filter can name it)
 *   web    the shop mirror by payment: `cod`, `card` — never /orders
 *   mex    Teleshop/Other's parcels with no order — `mex_teleshop` (9100/9102),
 *          `mex_social` (9108), `mex_web` (an NTMK… parcel no shop order
 *          claims), `elyon_unlinked` (BIO NATURAL 9110/9103: the neutral
 *          "Elyon account — unlinked"), `mex_other` — never /orders
 * Anything else renders with its label (or raw key) and no link.
 */
import { COHORT_SALE_SOURCES, type CohortBucketKey, type CohortSourceRow, type CohortSplit } from '../shared/cohortTypes';
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
  const ss = COHORT_SALE_SOURCES[row.key] ?? [];
  if (split.kind !== 'order' || split.key === 'none' || !DETAIL_RE.test(split.key) || !ss.length) {
    return { href: null, blocked: 'not_orders' };
  }
  if (!supported) return { href: null, blocked: 'unsupported' };
  const sp = new URLSearchParams();
  sp.set(COHORT_DRILL_PARAM, 'total');
  sp.set('sale_source', ss.join(','));
  sp.set('sale_source_detail', split.key);
  sp.set('sold_from', range.from);
  sp.set('sold_to', range.to);
  return { href: `/orders?${sp.toString()}`, blocked: null };
}
