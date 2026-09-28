/**
 * The sales cohort's pure rules — sums, the source filter, drill links, the
 * money strip. No React, no network: cohortModel.test.ts covers it.
 */
import { ORDERS_DRILL_KEYS } from '@/lib/api';
import {
  COHORT_BUCKETS, COHORT_OUTSIDE, COHORT_SALE_SOURCES, COHORT_SOURCES,
  type Cohort, type CohortBucket, type CohortBucketKey, type CohortLeadsIn, type CohortOutside,
  type CohortOutsideKey, type CohortQuality, type CohortQualityKind, type CohortSourceKey, type CohortSourceRow,
} from './cohortTypes';
import type { DayRange } from './period';

const hasNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const num = (v: unknown) => (hasNum(v) ? v : 0);

// ── Parts and sums ──────────────────────────────────────────────────────────

/** Tiles that always show — "0 returned" is news. */
export const CORE_TILES: CohortBucketKey[] = ['paid', 'courier', 'label', 'to_pack', 'returned'];
/** Shown only when above 0. `courier_problem` never gets its own tile: it is
 *  the "of which a problem" part of the courier tile (still at the courier —
 *  MEX 13 "Rejected" stays here until MEX says 7). */
export const OPTIONAL_TILES: CohortBucketKey[] = ['paid_legacy', 'paid_unproven'];

export interface Part { count: number; value_mkd: number | null; cod_mkd: number | null }

const partOf = (b: { count?: number; value_mkd?: number; cod_mkd?: number } | undefined): Part => ({
  count: num(b?.count),
  value_mkd: hasNum(b?.value_mkd) ? b!.value_mkd! : null,
  cod_mkd: hasNum(b?.cod_mkd) ? b!.cod_mkd! : null,
});

/** Every in-total bucket, in the bar's order, zeros included. */
export function bucketParts(buckets: CohortBucket[] | undefined): Record<CohortBucketKey, Part> {
  const out = {} as Record<CohortBucketKey, Part>;
  for (const k of COHORT_BUCKETS) out[k] = partOf(buckets?.find((b) => b.key === k));
  return out;
}

export function outsideParts(outside: CohortOutside[] | undefined): Record<CohortOutsideKey, Part> {
  const out = {} as Record<CohortOutsideKey, Part>;
  for (const k of COHORT_OUTSIDE) out[k] = partOf(outside?.find((b) => b.key === k));
  return out;
}

/** Σ of parts; a money sum is null when no part carries money (non-owner). */
export function sumParts(parts: Part[]): Part {
  let count = 0, value = 0, cod = 0, anyValue = false, anyCod = false;
  for (const p of parts) {
    count += p.count;
    if (p.value_mkd != null) { value += p.value_mkd; anyValue = true; }
    if (p.cod_mkd != null) { cod += p.cod_mkd; anyCod = true; }
  }
  return { count, value_mkd: anyValue ? value : null, cod_mkd: anyCod ? cod : null };
}

/** Which tiles a bar shows, in order. */
export function tileKeys(parts: Record<CohortBucketKey, Part>): CohortBucketKey[] {
  return COHORT_BUCKETS.filter((k) => CORE_TILES.includes(k) || (OPTIONAL_TILES.includes(k) && parts[k].count > 0));
}

export interface SumCheck {
  ok: boolean;
  count: { total: number; parts: number };
  value: { total: number; parts: number } | null;
}

/**
 * The contract's invariant: the parts add up to the total, exactly. Денари
 * are integers per sale, so the only slack allowed is rounding (≤ 1 ден per part).
 */
export function checkSum(total: { count: number; value_mkd?: number }, buckets: CohortBucket[]): SumCheck {
  const s = sumParts(Object.values(bucketParts(buckets)));
  const countOk = s.count === num(total.count);
  const value = hasNum(total.value_mkd) && s.value_mkd != null ? { total: total.value_mkd, parts: s.value_mkd } : null;
  const valueOk = !value || Math.abs(value.total - value.parts) <= COHORT_BUCKETS.length;
  return { ok: countOk && valueOk, count: { total: num(total.count), parts: s.count }, value };
}

/** A share of the total, weighted by денари for owners when every non-empty
 *  part carries them, else by count (what a non-owner's bar is weighted by). */
export function weightOf(p: Part, byValue: boolean): number {
  return byValue ? Math.max(0, p.value_mkd ?? 0) : p.count;
}
export const canWeighByValue = (parts: Part[], money: boolean) =>
  money && parts.some((p) => p.count > 0) && parts.every((p) => p.count === 0 || p.value_mkd != null);

// ── The source filter ───────────────────────────────────────────────────────

export interface CohortView {
  total: Part;
  buckets: CohortBucket[];
  outside: CohortOutside[];
  leads_in: CohortLeadsIn;
  rows: CohortSourceRow[];
  /** A source filter is on: the numbers are the selected rows only. */
  filtered: boolean;
}

const EMPTY_LEADS: CohortLeadsIn = { came_in: 0, became_sales: 0, cancelled: 0, trashed: 0, open: 0, conversion: null };

export function sumLeads(list: CohortLeadsIn[]): CohortLeadsIn {
  const out = { ...EMPTY_LEADS };
  for (const l of list) {
    out.came_in += num(l?.came_in);
    out.became_sales += num(l?.became_sales);
    out.cancelled += num(l?.cancelled);
    out.trashed += num(l?.trashed);
    out.open += num(l?.open);
  }
  out.conversion = out.came_in > 0 ? out.became_sales / out.came_in : null;
  return out;
}

const toBuckets = (parts: Record<string, Part>, keys: readonly string[]) =>
  keys.map((k) => ({
    key: k, count: parts[k].count,
    ...(parts[k].value_mkd != null ? { value_mkd: parts[k].value_mkd } : {}),
    ...(parts[k].cod_mkd != null ? { cod_mkd: parts[k].cod_mkd } : {}),
  }));

/**
 * The cohort for the selected sources (empty / all = the whole business, the
 * server's own numbers). A subset is re-summed from `by_source`, so the header
 * always equals Σ of the rows shown under it.
 */
export function cohortView(c: Cohort, selected: CohortSourceKey[] | null | undefined): CohortView {
  const order = (k: string) => { const i = (COHORT_SOURCES as readonly string[]).indexOf(k); return i < 0 ? 99 : i; };
  const all = [...(c.by_source ?? [])].sort((a, b) => order(a.key) - order(b.key));
  const rows = selected && selected.length ? all.filter((r) => selected.includes(r.key)) : all;
  const filtered = rows.length < all.length;
  if (!filtered) {
    return {
      total: partOf(c.total),
      buckets: c.buckets ?? [],
      outside: c.outside ?? [],
      leads_in: c.leads_in ?? sumLeads(all.map((r) => r.leads_in)),
      rows,
      filtered: false,
    };
  }
  const bparts = {} as Record<string, Part>;
  for (const k of COHORT_BUCKETS) bparts[k] = sumParts(rows.map((r) => bucketParts(r.buckets)[k]));
  const oparts = {} as Record<string, Part>;
  for (const k of COHORT_OUTSIDE) oparts[k] = sumParts(rows.map((r) => outsideParts(r.outside)[k]));
  return {
    total: sumParts(rows.map((r) => partOf(r.total))),
    buckets: toBuckets(bparts, COHORT_BUCKETS) as CohortBucket[],
    outside: toBuckets(oparts, COHORT_OUTSIDE).map(({ cod_mkd: _c, ...o }) => o) as CohortOutside[],
    leads_in: sumLeads(rows.map((r) => r.leads_in)),
    rows,
    filtered: true,
  };
}

// ── Drill-down links ────────────────────────────────────────────────────────

/** The /orders param a cohort part filters on (the api's twin of the bucket rule). */
export const COHORT_DRILL_PARAM = 'cohort_bucket';

/** /orders can list a cohort part only once it knows the `cohort_bucket` filter.
 *  Until then every part renders without a link — a link to a WIDER list
 *  (the filter silently dropped) would be worse than none. */
export const ordersSupportsCohortDrill = (keys: readonly string[] = ORDERS_DRILL_KEYS as readonly string[]) =>
  keys.includes(COHORT_DRILL_PARAM);

/**
 * Split keys that are PARCELS, not orders (MEX-only: NATURA teleshop/social,
 * BIO NATURAL unlinked LEADS / LEADS-OUT, M-prefix): the backend names them
 * `mex_*` or `unlinked_*`. They never link to /orders.
 */
export const isMexOnlySplit = (key: string) => /^(mex|unlinked)/i.test(key);

export const mexOnlyCount = (row: Pick<CohortSourceRow, 'splits'>) =>
  (row.splits ?? []).reduce((a, s) => a + (isMexOnlySplit(s.key) ? num(s.count) : 0), 0);

export type DrillBlock = 'none' | 'unsupported' | 'web' | 'mex_only';

export interface CohortDrill {
  href: string | null;
  /** Why there is no link. */
  blocked: DrillBlock | null;
  /** MEX-only parcels in the contributing sources: the list shows the orders
   *  only, so it can hold fewer rows than the number on the tile. */
  mexOnly: number;
}

export type DrillKey = CohortBucketKey | CohortOutsideKey | 'total';

const countIn = (row: CohortSourceRow, keys: DrillKey[]): number => keys.reduce((a, key) => {
  if (key === 'total') return a + num(row.total?.count);
  if ((COHORT_OUTSIDE as readonly string[]).includes(key)) return a + num(row.outside?.find((o) => o.key === key)?.count);
  return a + num(row.buckets?.find((b) => b.key === key)?.count);
}, 0);

/** `/orders?cohort_bucket=…&sale_source=…&sold_from=…&sold_to=…` — several parts
 *  = any of them (comma list); 'total' = the whole cohort (no bucket filter). */
export function cohortHref(key: DrillKey | DrillKey[], saleSources: string[], range: DayRange): string {
  const keys = (Array.isArray(key) ? key : [key]).filter((k) => k !== 'total');
  const sp = new URLSearchParams();
  if (keys.length) sp.set(COHORT_DRILL_PARAM, keys.join(','));
  if (saleSources.length) sp.set('sale_source', saleSources.join(','));
  sp.set('sold_from', range.from);
  sp.set('sold_to', range.to);
  return `/orders?${sp.toString()}`;
}

/**
 * The link behind one cohort number, over the source rows that make it up.
 * No link when nothing is there, when /orders cannot filter on the bucket yet,
 * when any contributing row is the web shop (a mirror, not orders), or when a
 * contributing row is made of MEX-only parcels alone.
 */
export function cohortDrill(
  rows: CohortSourceRow[], key: DrillKey | DrillKey[], range: DayRange, supported: boolean = ordersSupportsCohortDrill(),
): CohortDrill {
  const keys = Array.isArray(key) ? key : [key];
  const inPlay = rows.filter((r) => countIn(r, keys) > 0);
  const mexOnly = inPlay.reduce((a, r) => a + mexOnlyCount(r), 0);
  if (!inPlay.length) return { href: null, blocked: 'none', mexOnly: 0 };
  if (inPlay.some((r) => !(COHORT_SALE_SOURCES[r.key]?.length))) return { href: null, blocked: 'web', mexOnly };
  // A row whose every sale is a parcel without an order: the list would be empty.
  if (inPlay.some((r) => mexOnlyCount(r) >= num(r.total?.count) && num(r.total?.count) > 0)) {
    return { href: null, blocked: 'mex_only', mexOnly };
  }
  if (!supported) return { href: null, blocked: 'unsupported', mexOnly };
  const saleSources = [...new Set(inPlay.flatMap((r) => COHORT_SALE_SOURCES[r.key]))];
  return { href: cohortHref(key, saleSources, range), blocked: null, mexOnly };
}

// ── Quality rail ────────────────────────────────────────────────────────────

export type QualitySeverity = 'critical' | 'warning' | 'info';

/** unproven "paid" must read 0; the rest are review queues, never auto-fixed. */
export const QUALITY_SEVERITY: Record<CohortQualityKind, QualitySeverity> = {
  unproven_paid: 'critical',
  cancelled_but_moving: 'warning',
  double_count_candidates: 'warning',
  no_seller: 'warning',
  zero_cod_parcels: 'info',
};
const SEVERITY_RANK: Record<QualitySeverity, number> = { critical: 0, warning: 1, info: 2 };

/** The items worth a card: count > 0, most severe first, then the biggest. */
export function liveQuality(items: CohortQuality[] | undefined): CohortQuality[] {
  return (items ?? [])
    .filter((q) => num(q.count) > 0)
    .sort((a, b) => SEVERITY_RANK[QUALITY_SEVERITY[a.kind] ?? 'info'] - SEVERITY_RANK[QUALITY_SEVERITY[b.kind] ?? 'info']
      || num(b.count) - num(a.count));
}

// ── Owners-only money ───────────────────────────────────────────────────────

const MONEY_KEY = /_mkd$/;

/**
 * The payload an admin/manager receives: every `*_mkd` key removed, counts
 * kept. For the dev fixture and the tests — the UI itself only ever trusts
 * meta.money from the server.
 */
export function stripCohortMoney(c: Cohort): Cohort {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) if (!MONEY_KEY.test(k)) out[k] = walk(x);
      return out;
    }
    return v;
  };
  const s = walk(c) as Cohort;
  s.meta = { ...s.meta, money: false };
  return s;
}
