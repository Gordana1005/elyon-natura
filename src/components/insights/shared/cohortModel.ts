/**
 * The sales cohort's pure rules — sums, the source filter, drill links, the
 * money strip. No React, no network: cohortModel.test.ts covers it.
 */
import { ORDERS_DRILL_KEYS } from '@/lib/api';
import {
  COHORT_BUCKETS, COHORT_OUTSIDE, COHORT_SOURCE_PARAM, COHORT_SOURCES, cohortSourceParam,
  type Cohort, type CohortBucket, type CohortBucketKey, type CohortComposition, type CohortLeadsIn, type CohortOutside,
  type CohortOutsideKey, type CohortQuality, type CohortQualityKind, type CohortSourceKey, type CohortSourceRow,
  type CohortSplit,
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

export interface Part {
  count: number;
  value_mkd: number | null;
  cod_mkd: number | null;
  /** What it is made of (orders + web + mex_only = count); null when the api did not say. */
  orders?: number | null;
  web?: number | null;
  mex_only?: number | null;
}

type PartLike = { count?: number; value_mkd?: number | null; cod_mkd?: number | null } & CohortComposition;

const partOf = (b: PartLike | undefined): Part => ({
  count: num(b?.count),
  value_mkd: hasNum(b?.value_mkd) ? b!.value_mkd! : null,
  cod_mkd: hasNum(b?.cod_mkd) ? b!.cod_mkd! : null,
  orders: hasNum(b?.orders) ? b!.orders! : null,
  web: hasNum(b?.web) ? b!.web! : null,
  mex_only: hasNum(b?.mex_only) ? b!.mex_only! : null,
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

/** Σ of parts; a money sum is null when no part carries money (non-owner), a
 *  composition sum is null as soon as one part does not say what it is made of. */
export function sumParts(parts: Part[]): Part {
  let count = 0, value = 0, cod = 0, anyValue = false, anyCod = false;
  const comp = { orders: 0 as number | null, web: 0 as number | null, mex_only: 0 as number | null };
  for (const p of parts) {
    count += p.count;
    if (p.value_mkd != null) { value += p.value_mkd; anyValue = true; }
    if (p.cod_mkd != null) { cod += p.cod_mkd; anyCod = true; }
    for (const k of ['orders', 'web', 'mex_only'] as const) {
      const v = p[k];
      comp[k] = comp[k] == null || v == null ? null : comp[k]! + v;
    }
  }
  return { count, value_mkd: anyValue ? value : null, cod_mkd: anyCod ? cod : null, ...comp };
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

const EMPTY_LEADS: CohortLeadsIn = {
  came_in: 0, became_sales: 0, cancelled: 0, trashed: 0, open: 0, other: 0, disposition: 0, conversion: null,
};

export function sumLeads(list: CohortLeadsIn[]): CohortLeadsIn {
  const out = { ...EMPTY_LEADS };
  for (const l of list) {
    out.came_in += num(l?.came_in);
    out.became_sales += num(l?.became_sales);
    out.cancelled += num(l?.cancelled);
    out.trashed += num(l?.trashed);
    out.open += num(l?.open);
    out.other = num(out.other) + num(l?.other);
    out.disposition = num(out.disposition) + num(l?.disposition);
  }
  out.conversion = out.came_in > 0 ? out.became_sales / out.came_in : null;
  return out;
}

/** "Обработени": the leads that got a decision — became a sale, were cancelled
 *  or trashed (an ElyonCRM "no" call is a cancel); open ones are not worked yet. */
export const workedOf = (l: CohortLeadsIn | null | undefined) =>
  num(l?.became_sales) + num(l?.cancelled) + num(l?.trashed);

const toBuckets = (parts: Record<string, Part>, keys: readonly string[]) =>
  keys.map((k) => ({
    key: k, count: parts[k].count,
    ...(parts[k].value_mkd != null ? { value_mkd: parts[k].value_mkd } : {}),
    ...(parts[k].cod_mkd != null ? { cod_mkd: parts[k].cod_mkd } : {}),
    ...(parts[k].orders != null ? { orders: parts[k].orders } : {}),
    ...(parts[k].web != null ? { web: parts[k].web } : {}),
    ...(parts[k].mex_only != null ? { mex_only: parts[k].mex_only } : {}),
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
 * A split made of MEX parcels with no order (the api's kind 'mex', by series:
 * mex_leads · mex_out · mex_in · mex_social · mex_web · mex_other — and the
 * pre-28.09 mex_teleshop / elyon_unlinked of an older payload). It never links
 * to /orders.
 */
export const isMexOnlySplit = (s: Pick<CohortSplit, 'key' | 'kind'> | string) => {
  const sp = typeof s === 'string' ? { key: s } : s;
  return sp.kind ? sp.kind === 'mex' : /^(mex_|unlinked|elyon_unlinked)/i.test(sp.key);
};

/** MEX parcels with no order among a source's sales. */
export const mexOnlyCount = (row: Pick<CohortSourceRow, 'splits'> & { total?: CohortSourceRow['total'] }) =>
  hasNum(row.total?.mex_only) ? row.total!.mex_only!
    : (row.splits ?? []).reduce((a, s) => a + (isMexOnlySplit(s) ? num(s.count) : 0), 0);

/** Why a number has no link of its own: nothing there · /orders cannot filter
 *  the cohort yet · (part of it is) the web mirror · (part of it is) MEX
 *  parcels with no order · both · the api did not say what it is made of. */
export type DrillBlock = 'none' | 'unsupported' | 'web' | 'mex_only' | 'mixed' | 'unknown';

export interface CohortDrill {
  /** The number itself opens /orders — ONLY when every sale behind it is an
   *  order, so the list holds exactly the number (never a wider or narrower one). */
  href: string | null;
  blocked: DrillBlock | null;
  /** A number that is only partly orders: the exact link to that part, and its size. */
  ordersHref: string | null;
  orders: number;
  /** What no list holds: web-shop orders (the mirror) and MEX parcels with no order. */
  web: number;
  mexOnly: number;
}

export type DrillKey = CohortBucketKey | CohortOutsideKey | 'total';

const partIn = (row: CohortSourceRow, key: DrillKey): Part => {
  if (key === 'total') return partOf(row.total);
  if ((COHORT_OUTSIDE as readonly string[]).includes(key)) return partOf(row.outside?.find((o) => o.key === key));
  return partOf(row.buckets?.find((b) => b.key === key));
};

/** `/orders?cohort_bucket=…&cohort_source=…&sold_from=…&sold_to=…` — several
 *  parts = any of them (comma list); 'total' = the eight in-total buckets;
 *  `sources` = the cohort sources (keys) the number is made of. Every source
 *  at once is sent as none (as the api's own links do). */
export function cohortHref(key: DrillKey | DrillKey[], sources: readonly string[], range: DayRange): string {
  const keys = Array.isArray(key) ? key : [key];
  const sp = new URLSearchParams();
  sp.set(COHORT_DRILL_PARAM, keys.includes('total') ? 'total' : keys.join(','));
  const cs = cohortSourceParam(sources);
  if (cs) sp.set(COHORT_SOURCE_PARAM, cs);
  sp.set('sold_from', range.from);
  sp.set('sold_to', range.to);
  return `/orders?${sp.toString()}`;
}

/**
 * The link behind one cohort number, over the source rows that make it up.
 * The number links only when it is ALL orders (web = MEX-only = 0): then the
 * /orders list holds exactly it. A number that is partly orders keeps no link
 * of its own and offers its order part (`ordersHref`, `orders`) instead; a
 * number with no orders at all, or before /orders can filter the cohort, has
 * none. The api says per number what it is made of (orders / web / mex_only).
 */
export function cohortDrill(
  rows: CohortSourceRow[], key: DrillKey | DrillKey[], range: DayRange, supported: boolean = ordersSupportsCohortDrill(),
): CohortDrill {
  const keys = Array.isArray(key) ? key : [key];
  const inPlay = rows.map((r) => ({ r, p: sumParts(keys.map((k) => partIn(r, k))) })).filter((x) => x.p.count > 0);
  const none = { href: null, ordersHref: null, orders: 0, web: 0, mexOnly: 0 };
  if (!inPlay.length) return { ...none, blocked: 'none' };
  const s = sumParts(inPlay.map((x) => x.p));
  // No composition (an older api): nobody can say the list would hold exactly this.
  if (s.orders == null || s.web == null || s.mex_only == null) return { ...none, blocked: 'unknown' };
  const made = { orders: s.orders, web: s.web, mexOnly: s.mex_only };
  if (!supported) return { href: null, ordersHref: null, ...made, blocked: 'unsupported' };
  const sources = [...new Set(inPlay.map((x) => x.r.key))];
  const href = s.orders > 0 ? cohortHref(key, sources, range) : null;
  if (s.web === 0 && s.mex_only === 0) return { href, ordersHref: null, ...made, blocked: href ? null : 'none' };
  return {
    href: null, ordersHref: href, ...made,
    blocked: s.web > 0 && s.mex_only > 0 ? 'mixed' : s.web > 0 ? 'web' : 'mex_only',
  };
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
