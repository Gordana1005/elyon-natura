/**
 * Insights → Продажби: the pure rules — rates, the source rows, the trend
 * series, the heat grid, the quality items. No React, no network:
 * salesModel.test.ts covers it. The components only lay these results out.
 *
 * Definitions (said the same way in every widget):
 *   paid rate     paid (MEX delivered, + paid by ruling / legacy import) ÷ sales
 *   return rate   returned ÷ (paid + returned) — among sales that are CLOSED;
 *                 a sale still at the courier or in the warehouse is neither
 *   in flight     at the courier (incl. a problem) + label printed + to pack
 *   average sale  value ÷ sales (денари, owners only)
 */
import type { CohortBucket, CohortBucketKey, CohortLeadsIn, CohortSourceKey, CohortSourceRow } from '../shared/cohortTypes';
import { COHORT_SOURCES, dropEmptyManagement, emptySourceRow, MANAGEMENT_SOURCE, withManagementRow } from '../shared/cohortTypes';
import { cohortRowEmpty } from '../shared/cohortModel';
import type {
  SalesCity, SalesCityCounts, SalesChannel, SalesCore, SalesCustomers, SalesDetail, SalesPrev, SalesProduct, SalesSource,
  SalesTiming, SalesTrendPoint,
} from '@/lib/insightsApi/sales';

const hasNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const num = (v: unknown) => (hasNum(v) ? v : 0);
/** a ÷ b, or null when there is nothing to divide by. */
export const ratio = (a: number, b: number): number | null => (b > 0 ? a / b : null);

// ── buckets → the four numbers every row shows ─────────────────────────────

export interface Outcome {
  count: number;
  paid: number;
  returned: number;
  inFlight: number;
  toPack: number;
  unproven: number;
}

const bucketCount = (buckets: CohortBucket[] | undefined, keys: CohortBucketKey[]) =>
  (buckets ?? []).reduce((a, b) => a + (keys.includes(b.key) ? num(b.count) : 0), 0);

export function outcomeOf(total: { count: number }, buckets: CohortBucket[] | undefined): Outcome {
  return {
    count: num(total?.count),
    paid: bucketCount(buckets, ['paid', 'paid_legacy']),
    returned: bucketCount(buckets, ['returned']),
    inFlight: bucketCount(buckets, ['courier', 'courier_problem', 'label', 'to_pack']),
    toPack: bucketCount(buckets, ['to_pack']),
    unproven: bucketCount(buckets, ['paid_unproven']),
  };
}

/** The same rates from a row that carries plain counts (products, cities, channels). */
export function outcomeOfCounts(r: { count?: number; sales?: number; paid: number; returned: number; courier: number; to_pack: number }): Outcome {
  return {
    count: num(r.count ?? r.sales),
    paid: num(r.paid),
    returned: num(r.returned),
    inFlight: num(r.courier) + num(r.to_pack),
    toPack: num(r.to_pack),
    unproven: 0,
  };
}

export const paidRate = (o: Outcome) => ratio(o.paid, o.count);
/** Returned among the CLOSED sales (paid or returned) — not among all. */
export const returnRate = (o: Outcome) => ratio(o.returned, o.paid + o.returned);

// ── sources ────────────────────────────────────────────────────────────────

const NO_LEADS: CohortLeadsIn = { came_in: 0, became_sales: 0, cancelled: 0, trashed: 0, open: 0, other: 0, disposition: 0, conversion: null };

/** The cohort helpers (CohortBar, cohortDrill) read source rows; this tab
 *  carries no leads (the Overview does), so they get an empty funnel. The rows
 *  are the WHOLE business (the tab has no source filter), so they always hold a
 *  Менаџмент row (withManagementRow) — a number over them drills unfiltered.
 *  A dept_admin's payload (`scope` = meta.dept_scope, access levels 20260947001600) holds only
 *  their departments: the rows are those, one per scope key (empty when the body sent none),
 *  and no Менаџмент row is added outside the scope — a number drills to their departments. */
export function asCohortRows(sources: SalesSource[] | undefined, scope?: readonly string[] | null): CohortSourceRow[] {
  const rows = (sources ?? []).map((s) => ({ ...s, leads_in: NO_LEADS }));
  if (Array.isArray(scope)) {
    return COHORT_SOURCES.filter((k) => scope.includes(k))
      .map((k) => rows.find((r) => r.key === k) ?? emptySourceRow(k));
  }
  return withManagementRow(rows, () => emptySourceRow(MANAGEMENT_SOURCE));
}

export interface SourceView {
  key: CohortSourceKey;
  row: CohortSourceRow;
  count: number;
  value: number | null;
  prevCount: number | null;
  prevValue: number | null;
  outcome: Outcome;
  /** Share of all sales — by денари for owners, by count otherwise. */
  share: number | null;
  avg: number | null;
}

export function sourceViews(core: SalesCore, money: boolean): SourceView[] {
  const order = (k: string) => { const i = (COHORT_SOURCES as readonly string[]).indexOf(k); return i < 0 ? 99 : i; };
  // an empty Менаџмент row is not written (owner 02.10.2026: only "ако има нешто")
  const rows = dropEmptyManagement(asCohortRows(core.by_source, core.meta?.dept_scope).sort((a, b) => order(a.key) - order(b.key)), cohortRowEmpty);
  const totalCount = num(core.total?.count);
  const totalValue = money && hasNum(core.total?.value_mkd) ? core.total.value_mkd! : null;
  return rows.map((row) => {
    const p = core.prev?.by_source?.find((x) => x.key === row.key)?.total;
    const value = money && hasNum(row.total.value_mkd) ? row.total.value_mkd! : null;
    const count = num(row.total.count);
    return {
      key: row.key,
      row,
      count,
      value,
      prevCount: p ? num(p.count) : null,
      prevValue: p && money && hasNum(p.value_mkd) ? p.value_mkd! : null,
      outcome: outcomeOf(row.total, row.buckets),
      share: value != null && totalValue != null ? ratio(value, totalValue) : ratio(count, totalCount),
      avg: value != null ? ratio(value, count) : null,
    };
  });
}

/** The previous period's number to compare the header with (денари for owners). */
export function prevHeadline(prev: SalesPrev | null | undefined): { count: number; value_mkd?: number } | null {
  if (!prev?.total) return null;
  return { count: num(prev.total.count), ...(hasNum(prev.total.value_mkd) ? { value_mkd: prev.total.value_mkd } : {}) };
}

// ── trend ──────────────────────────────────────────────────────────────────

export type TrendRow = { d: string; total: number } & Partial<Record<CohortSourceKey, number>>;

/** One row per bucket, one number per source: денари when `byValue`, else sales. */
export function trendRows(points: SalesTrendPoint[] | undefined, byValue: boolean): TrendRow[] {
  return (points ?? []).map((p) => {
    const row: TrendRow = { d: p.d, total: 0 };
    for (const k of COHORT_SOURCES) {
      const s = p.by_source?.find((x) => x.key === k);
      const v = byValue ? num(s?.value_mkd) : num(s?.count);
      row[k] = v;
      row.total += v;
    }
    return row;
  });
}

/** Sources that sold anything in the period (a stack never shows an empty colour). */
export const trendSources = (rows: TrendRow[]): CohortSourceKey[] =>
  COHORT_SOURCES.filter((k) => rows.some((r) => num(r[k]) > 0));

// ── products / cities ──────────────────────────────────────────────────────

export interface ProductView extends SalesProduct {
  outcome: Outcome;
  perUnit: number | null;
  /** Share of all packages (count) or of the products' денари (owners). */
  share: number | null;
}

export function productViews(rows: SalesProduct[] | undefined, totals: { units: number; value_mkd?: number }, money: boolean): ProductView[] {
  const allValue = money && hasNum(totals.value_mkd) ? totals.value_mkd! : null;
  return (rows ?? []).map((r) => ({
    ...r,
    outcome: outcomeOfCounts(r),
    perUnit: money && hasNum(r.value_mkd) ? ratio(r.value_mkd!, r.units) : null,
    share: allValue != null && hasNum(r.value_mkd) ? ratio(r.value_mkd!, allValue) : ratio(r.units, num(totals.units)),
  }));
}

/** A product row matches a search: its name, case- and script-insensitive enough for a filter box. */
export const matchesSearch = (name: string | null | undefined, q: string) =>
  !q.trim() || (name ?? '').toLocaleLowerCase().includes(q.trim().toLocaleLowerCase());

export interface CityView extends SalesCity {
  outcome: Outcome;
  avg: number | null;
  share: number | null;
}

export function cityViews(rows: SalesCity[] | undefined, total: { count: number; value_mkd?: number }, money: boolean): CityView[] {
  return (rows ?? []).map((r) => ({
    ...r,
    outcome: outcomeOfCounts(r),
    avg: money && hasNum(r.value_mkd) ? ratio(r.value_mkd!, r.count) : null,
    share: ratio(r.count, num(total.count)),
  }));
}

/** The city name in the reader's script: Cyrillic for mk / bg, Latin for en / sq. */
export const cityName = (c: Pick<SalesCity, 'name' | 'name_lat'>, lang: string) =>
  (lang === 'en' || lang === 'sq' ? c.name_lat : c.name) || c.name || c.name_lat;

export const countsOutcome = (c: SalesCityCounts) => outcomeOfCounts(c);

// ── channels (MEX account × series) ────────────────────────────────────────

/** The series a channel row names, as an i18n key under insights.sales.channels.series.*. */
export function seriesKey(series: string): string {
  if (/^[0-9]{4}$/.test(series)) return `s${series}`;
  return ['ntmk', 'm', 'other', 'none'].includes(series) ? series : 'other';
}

export interface ChannelView extends SalesChannel {
  outcome: Outcome;
  share: number | null;
}

export function channelViews(rows: SalesChannel[] | undefined, totalCount: number): ChannelView[] {
  return (rows ?? []).map((c) => ({
    ...c,
    outcome: { count: c.count, paid: c.paid, returned: c.returned, inFlight: c.courier + c.to_pack, toPack: c.to_pack, unproven: 0 },
    share: ratio(c.count, totalCount),
  }));
}

// ── weekday × hour ─────────────────────────────────────────────────────────

export const HEAT_STEPS = 5;

export interface HeatGrid {
  /** [dow 1..7][hour 0..23] counts. */
  cells: number[][];
  max: number;
  /** Which of HEAT_STEPS a count falls in (0 = none). Linear in count: step 5 is the busiest hour. */
  step: (n: number) => number;
  /** The busiest cell. */
  peak: { dow: number; hour: number; count: number } | null;
  byHour: number[];
  byDow: number[];
}

export function heatGrid(t: SalesTiming | undefined): HeatGrid {
  const cells = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  for (const c of t?.cells ?? []) {
    if (c.dow >= 1 && c.dow <= 7 && c.hour >= 0 && c.hour <= 23) cells[c.dow - 1][c.hour] += num(c.count);
  }
  let max = 0;
  let peak: HeatGrid['peak'] = null;
  cells.forEach((row, d) => row.forEach((n, h) => {
    if (n > max) { max = n; peak = { dow: d + 1, hour: h, count: n }; }
  }));
  const step = (n: number) => (n <= 0 || max <= 0 ? 0 : Math.min(HEAT_STEPS, Math.max(1, Math.ceil((n / max) * HEAT_STEPS))));
  const byHour = Array.from({ length: 24 }, (_, h) => cells.reduce((a, row) => a + row[h], 0));
  const byDow = cells.map((row) => row.reduce((a, n) => a + n, 0));
  return { cells, max, step, peak, byHour, byDow };
}

/** The first and last hour that ever sold — the grid shows that span (always ≥ 08–20). */
export function hourSpan(byHour: number[]): [number, number] {
  let lo = byHour.findIndex((n) => n > 0);
  let hi = 23 - [...byHour].reverse().findIndex((n) => n > 0);
  if (lo < 0) { lo = 8; hi = 20; }
  return [Math.min(lo, 8), Math.max(hi, 20)];
}

// ── buyers ─────────────────────────────────────────────────────────────────

export function buyersView(c: SalesCustomers | undefined, money: boolean) {
  if (!c) return null;
  return {
    ...c,
    newShare: ratio(c.new, c.buyers),
    repeatShare: ratio(c.repeat, c.buyers),
    salesPerBuyer: ratio(c.sales, c.buyers),
    avgNew: money && hasNum(c.value_new_mkd) ? ratio(c.value_new_mkd!, c.sales_new) : null,
    avgReturning: money && hasNum(c.value_returning_mkd) ? ratio(c.value_returning_mkd!, c.sales_returning) : null,
  };
}

// ── quality (this tab's own; the cohort's five come as sent) ───────────────

export type SalesQualityKind =
  | 'unmapped_products' | 'bad_qty' | 'auto_lines' | 'unknown_places' | 'no_city' | 'no_phone';

export interface SalesQualityItem {
  kind: SalesQualityKind;
  severity: 'warning' | 'info';
  count: number;
  value_mkd?: number;
}

/** Coverage items the detail part reveals — only those above 0. */
export function detailQuality(d: SalesDetail | undefined): SalesQualityItem[] {
  if (!d) return [];
  const s = d.products?.summary;
  const autoLines = (d.products?.non_product ?? []).reduce((a, x) => a + num(x.auto), 0);
  const items: SalesQualityItem[] = [
    { kind: 'unmapped_products', severity: 'info', count: num(s?.unmapped_products), ...(hasNum(s?.unmapped_value_mkd) ? { value_mkd: s!.unmapped_value_mkd } : {}) },
    { kind: 'bad_qty', severity: 'warning', count: num(s?.bad_qty_lines), ...(hasNum(s?.bad_qty_value_mkd) ? { value_mkd: s!.bad_qty_value_mkd } : {}) },
    { kind: 'auto_lines', severity: 'info', count: autoLines },
    { kind: 'unknown_places', severity: 'info', count: num(d.cities?.unknown_places_count), ...(hasNum(d.cities?.unknown_places_value_mkd) ? { value_mkd: d.cities!.unknown_places_value_mkd } : {}) },
    { kind: 'no_city', severity: 'warning', count: num(d.cities?.unknown?.count), ...(hasNum(d.cities?.unknown?.value_mkd) ? { value_mkd: d.cities!.unknown.value_mkd } : {}) },
    { kind: 'no_phone', severity: 'info', count: num(d.customers?.no_phone) },
  ];
  return items.filter((i) => i.count > 0);
}

/** A week / month bucket that sticks out of the period (it holds only the days inside it). */
export function isPartialBucket(d: string, gran: 'day' | 'week' | 'month', from: string, to: string): boolean {
  if (gran === 'day') return false;
  const start = d;
  const end = gran === 'week'
    ? new Date(Date.parse(`${d}T00:00:00Z`) + 6 * 86_400_000).toISOString().slice(0, 10)
    : new Date(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)), 0)).toISOString().slice(0, 10);
  return start < from || end > to;
}
