/**
 * Insights → Returns and Products & stock — the pure rules the two tabs render
 * by: drill links, the trend columns, city names by language, the movers.
 * No React, no network: returnsModel.test.ts covers it.
 */
import { cohortHref, type DrillKey } from '../shared/cohortModel';
import { COHORT_SALE_SOURCES, COHORT_SOURCES, type CohortSourceKey } from '../shared/cohortTypes';
import type { DayRange } from '../shared/period';
import type {
  QueueAgeKey, ReturnsClock, ReturnsResponse, StockProductRow, StockQueueStage,
} from '@/lib/insightsApi/returnsStock';

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

// ── Drill links ─────────────────────────────────────────────────────────────

/** What a number is made of: orders (GET /orders can list them), web-shop
 *  orders (the mirror) and MEX parcels with no order. */
export interface Composition { orders?: number; web?: number; mex_only?: number }

export type RsBlock = 'none' | 'web' | 'mex_only' | 'mixed' | 'mex_day';

export interface RsDrill {
  /** The number itself opens /orders — only when every row behind it is an order. */
  href: string | null;
  /** A number that is only partly orders: the exact link to that part, and its size. */
  ordersHref: string | null;
  orders: number;
  blocked: RsBlock | null;
}

/** /orders sale_source values for the selected cohort sources (none = all four). */
export const saleSourcesOf = (sources: readonly string[] | null | undefined): string[] => {
  const keys = (sources && sources.length ? sources : COHORT_SOURCES) as CohortSourceKey[];
  return [...new Set(keys.flatMap((k) => COHORT_SALE_SOURCES[k] ?? []))];
};

/**
 * The link behind a returns / queue number. `bucket` is the cohort part the
 * /orders list filters on (returned · total · cancelled_after_sale · to_pack · …);
 * `extra` adds exact filters (a seller, a prediction list). The MEX-return-day
 * clock has no list: /orders cannot filter by the day MEX returned a parcel.
 */
export function rsDrill(opts: {
  clock: ReturnsClock;
  bucket: DrillKey | DrillKey[];
  comp: Composition | null | undefined;
  count: number;
  sources: readonly string[] | null | undefined;
  range: DayRange;
  extra?: Record<string, string | null | undefined>;
}): RsDrill {
  const { clock, bucket, comp, count, sources, range, extra } = opts;
  const none: RsDrill = { href: null, ordersHref: null, orders: 0, blocked: 'none' };
  if (!(count > 0)) return none;
  if (clock !== 'sale') return { ...none, blocked: 'mex_day' };
  const orders = num(comp?.orders);
  const web = num(comp?.web);
  const mex = num(comp?.mex_only);
  if (orders <= 0) return { ...none, blocked: web > 0 && mex > 0 ? 'mixed' : web > 0 ? 'web' : 'mex_only' };
  let href = cohortHref(bucket, saleSourcesOf(sources), range);
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(extra ?? {})) if (v) sp.set(k, v);
  if ([...sp.keys()].length) href += `&${sp.toString()}`;
  if (web === 0 && mex === 0) return { href, ordersHref: null, orders, blocked: null };
  return { href: null, ordersHref: href, orders, blocked: web > 0 && mex > 0 ? 'mixed' : web > 0 ? 'web' : 'mex_only' };
}

/** The /orders list of one queue age (to pack / label printed): the cohort part
 *  and the sale days that age covers. Only the order part is listable. */
export function queueDrill(
  stage: StockQueueStage['stage'],
  age: StockQueueStage['ages'][number],
  sources: readonly string[] | null | undefined,
): RsDrill {
  return rsDrill({
    clock: 'sale', bucket: stage, comp: age, count: age.count, sources,
    range: { from: age.from, to: age.to },
  });
}

/** A queue age older than two weeks is stale — the sale is waiting too long. */
export const STALE_AGES: QueueAgeKey[] = ['15_30', '31_plus'];

// ── Rates ───────────────────────────────────────────────────────────────────

/** The change of a rate in percentage points (cur − prev) × 100; null without both. */
export function ratePp(cur: number | null | undefined, prev: number | null | undefined): number | null {
  if (typeof cur !== 'number' || typeof prev !== 'number') return null;
  return Math.round((cur - prev) * 1000) / 10;
}

/** A rate shown with its evidence: below this base it is not ranked as high. */
export const MIN_RATE_BASE = 20;

// ── Trend columns ───────────────────────────────────────────────────────────

export interface ColumnSeg { key: string; value: number }
export interface Column { d: string; total: number; segs: ColumnSeg[] }

/**
 * Returns trend, one column per day (month): sale clock — the day's sales as
 * delivered-or-closed · still open · returned (so a young day reads as
 * immature, not as "no returns"); MEX clock — what finished that day as
 * delivered · returned.
 */
export function returnsColumns(trend: ReturnsResponse['trend'], clock: ReturnsClock): Column[] {
  return (trend ?? []).map((p) => {
    const returned = num(p.returned);
    const open = clock === 'sale' ? num(p.open) : 0;
    const rest = Math.max(0, num(p.base) - returned - open);
    return {
      d: p.d,
      total: num(p.base),
      segs: [
        { key: 'closed', value: rest },
        ...(clock === 'sale' ? [{ key: 'open', value: open }] : []),
        { key: 'returned', value: returned },
      ],
    };
  });
}

// ── Places ──────────────────────────────────────────────────────────────────

/** A settlement's name in the reader's language (mk / bg: Cyrillic; en: Latin; sq: Albanian). */
export function cityName(
  row: { name: string | null; name_lat: string | null; name_sq: string | null; key?: string },
  lang: string,
): string {
  const pick = lang === 'en' ? row.name_lat : lang === 'sq' ? (row.name_sq ?? row.name_lat) : row.name;
  return pick || row.name || row.name_lat || row.key || '—';
}

// ── Stock ───────────────────────────────────────────────────────────────────

export interface Mover { row: StockProductRow; delta: number | null }

/** The period's best sellers by units, with the change against the previous period. */
export function topMovers(rows: StockProductRow[], n = 10): Mover[] {
  return [...rows]
    .filter((r) => r.units > 0)
    .sort((a, b) => b.units - a.units || String(a.name).localeCompare(String(b.name)))
    .slice(0, n)
    .map((row) => ({ row, delta: row.units_prev == null ? null : row.units - row.units_prev }));
}

/**
 * Slow movers: catalogue products that are active and warehouse-tracked (they
 * hold stock) but sold the least in the period — 0 first, the biggest shelf
 * first among equals.
 */
export function slowMovers(rows: StockProductRow[], n = 10): StockProductRow[] {
  return rows
    .filter((r) => r.catalogue && r.tracked && (r.on_hand ?? 0) > 0)
    .sort((a, b) => a.units - b.units || (b.on_hand ?? 0) - (a.on_hand ?? 0) || String(a.name).localeCompare(String(b.name)))
    .slice(0, n);
}

export type StockSort = 'units' | 'returned' | 'queue' | 'on_hand' | 'name';

/** The product table: a text filter (name or SKU, any case) and a sort. */
export function filterProducts(rows: StockProductRow[], q: string, sort: StockSort, onlyCatalogue = false): StockProductRow[] {
  const needle = q.trim().toLowerCase();
  const out = rows.filter((r) => (!onlyCatalogue || r.catalogue)
    && (!needle || String(r.name ?? '').toLowerCase().includes(needle) || String(r.sku ?? '').toLowerCase().includes(needle)));
  const by: Record<StockSort, (a: StockProductRow, b: StockProductRow) => number> = {
    units: (a, b) => b.units - a.units,
    returned: (a, b) => b.returned_units - a.returned_units,
    queue: (a, b) => b.queue_units - a.queue_units,
    on_hand: (a, b) => (b.on_hand ?? -1) - (a.on_hand ?? -1),
    name: () => 0,
  };
  return out.sort((a, b) => by[sort](a, b) || String(a.name ?? '').localeCompare(String(b.name ?? '')));
}
