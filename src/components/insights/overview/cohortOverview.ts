/**
 * The Overview's source cards over the shared sales cohort (../shared/cohort*):
 * which buckets a tile adds up, where a split chip may link, and the lead
 * outcomes. Pure — cohortOverview.test.ts covers it; the cards only lay it out.
 *
 * Split keys (by_source[].splits) — the contract fixes {key, count, value_mkd?}:
 *   orders   altercpa `orders` · elyon_crm `prediction_list`, `direct` · teleshop_other `collabbox`
 *   parcels  `mex_*` / `unlinked_*` (the shared isMexOnlySplit): `unlinked_leads` (BIO NATURAL
 *            9110), `unlinked_leads_out` (9103), `mex_teleshop` (NATURA 9100/9102),
 *            `mex_social` (9108), `mex_other` (M-prefix / unknown series)
 *   web      `cod`, `card` (the shop mirror — never /orders)
 * Anything else renders with its label (or raw key) and no link.
 */
import { COHORT_SALE_SOURCES, type CohortBucketKey, type CohortLeadsIn, type CohortSourceRow, type CohortSplit } from '../shared/cohortTypes';
import { isMexOnlySplit, ordersSupportsCohortDrill, sumParts, type DrillBlock, type Part } from '../shared/cohortModel';
import type { DayRange } from '../shared/period';

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** The buckets a tile adds up: "Кај курирот" = moving + problem (MEX 1/4/10 and 3/9/13). */
export const tileBuckets = (k: CohortBucketKey): CohortBucketKey[] => (k === 'courier' ? ['courier', 'courier_problem'] : [k]);

/** A tile's number from the bucket parts. */
export const tilePart = (parts: Record<CohortBucketKey, Part>, k: CohortBucketKey): Part =>
  sumParts(tileBuckets(k).map((b) => parts[b]));

/** Splits that ARE orders, and the extra /orders filter each one needs. */
const SPLIT_ORDERS: Record<string, { detail?: string }> = {
  'altercpa:orders': {},
  'elyon_crm:prediction_list': { detail: 'prediction_list' },
  'elyon_crm:direct': { detail: 'direct' },
  'teleshop_other:collabbox': {},
};

export type SplitBlock = DrillBlock | 'not_orders';

/**
 * A split chip opens that split's sales of the period — only when the split is
 * orders, and only once /orders can filter the cohort (the same gate as every
 * other cohort number: a link to a wider list would be worse than none).
 */
export function splitDrill(
  row: Pick<CohortSourceRow, 'key'>, split: CohortSplit, range: DayRange, supported: boolean = ordersSupportsCohortDrill(),
): { href: string | null; blocked: SplitBlock | null } {
  if (!(num(split.count) > 0)) return { href: null, blocked: 'none' };
  if (!(COHORT_SALE_SOURCES[row.key]?.length)) return { href: null, blocked: 'web' };
  if (isMexOnlySplit(split.key)) return { href: null, blocked: 'mex_only' };
  const d = SPLIT_ORDERS[`${row.key}:${split.key}`];
  if (!d) return { href: null, blocked: 'not_orders' };
  if (!supported) return { href: null, blocked: 'unsupported' };
  const sp = new URLSearchParams();
  sp.set('sale_source', COHORT_SALE_SOURCES[row.key].join(','));
  if (d.detail) sp.set('sale_source_detail', d.detail);
  sp.set('sold_from', range.from);
  sp.set('sold_to', range.to);
  return { href: `/orders?${sp.toString()}`, blocked: null };
}

/** "Обработени": leads that got a decision — became a sale, were cancelled or trashed. */
export const workedOf = (l: CohortLeadsIn | null | undefined) =>
  num(l?.became_sales) + num(l?.cancelled) + num(l?.trashed);
