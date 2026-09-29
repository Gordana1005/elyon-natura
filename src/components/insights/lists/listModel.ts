/**
 * Insights → Prediction lists: the pure rules — display labels, grouping and
 * roll-ups, rates, the exact /orders links. No React, no network:
 * listModel.test.ts covers it.
 *
 * LIST NAMES ARE DATA. The engine resolves lists by EXACT name and deletes
 * memberships before resolving, so a drifted name wipes members silently.
 * Everything here only READS a name to show a label or to group rows; the raw
 * name stays the key, the tooltip and the /orders filter.
 */
import { formatMoney } from '@/lib/currency';
import { parsePredictionListName, predictionListLabel, type ParsedListName } from '@/lib/predictionListLabel';
import type { ListsPart, ListsRow, ListsTrendPoint } from '@/lib/insightsApi/lists';
import { ordersSupportsCohortDrill, type CohortDrill, type DrillKey } from '../shared/cohortModel';
import { COHORT_BUCKETS, COHORT_OUTSIDE } from '../shared/cohortTypes';
import { addDays, type DayRange } from '../shared/period';

const hasNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const num = (v: unknown) => (hasNum(v) ? v : 0);

// ── Labels (display only) ───────────────────────────────────────────────────

/** The translate function (react-i18next's `t`, or i18n.t). */
export type LabelT = (key: string, opts?: Record<string, unknown>) => string;

/** Recency tokens in the engine's order, and their i18n-safe ids. */
export const RECENCY_ORDER = ['NEWCOMERS', '21d', '57d', '4-6m', '6-12m', '1-2yr', '2yr+'] as const;
const RECENCY_ID: Record<string, string> = {
  NEWCOMERS: 'newcomers', '21d': 'd21', '57d': 'd57', '4-6m': 'm4_6', '6-12m': 'm6_12', '1-2yr': 'y1_2', '2yr+': 'y2plus',
};
export const ORDERS_ORDER = ['1-3', '3+', '5+', '7+'] as const;
const ORDERS_ID: Record<string, string> = { '1-3': 'o1_3', '3+': 'o3', '5+': 'o5', '7+': 'o7' };

export const recencyId = (token: string | null | undefined) => (token ? RECENCY_ID[token] ?? null : null);
export const ordersId = (token: string | null | undefined) => (token ? ORDERS_ID[token] ?? null : null);

/**
 * The list's name in the reader's language — "57–120 дена · над 1.599 ден ·
 * 1–3 нарачки", "Скорешни откажувања" — built from the parsed name; a name
 * the parser does not know is shown as stored (EUR band → денари). The raw
 * name belongs in the tooltip.
 */
export function listLabel(t: LabelT, name: string | null | undefined, parsed: ParsedListName = parsePredictionListName(name)): string {
  const orders = (o: string | null) => {
    const id = ordersId(o);
    return id ? t(`insights.lists.name.orders.${id}`) : o ?? '';
  };
  if (parsed.kind === 'pen' && parsed.pen) return t(`insights.lists.name.pen.${parsed.pen}`, { defaultValue: String(name ?? '') });
  if (parsed.kind === 'newcomers') return t('insights.lists.name.newcomers', { orders: orders(parsed.orders) });
  if (parsed.kind === 'band') {
    const rid = recencyId(parsed.recency);
    if (!rid || parsed.threshold == null) return predictionListLabel(name);
    const value = formatMoney(parsed.threshold);
    return t('insights.lists.name.band', {
      recency: t(`insights.lists.name.recency.${rid}`),
      band: t(parsed.band === 'le' ? 'insights.lists.name.bandLe' : 'insights.lists.name.bandGt', { value }),
      orders: orders(parsed.orders),
    });
  }
  return predictionListLabel(name);
}

// ── Grouping and roll-ups ───────────────────────────────────────────────────

export type GroupBy = 'recency' | 'value' | 'orders' | 'none';
export const GROUP_BYS: GroupBy[] = ['recency', 'value', 'orders', 'none'];

export interface ListView extends ListsRow {
  parsed: ParsedListName;
}

export const viewOf = (rows: ListsRow[]): ListView[] => rows.map((r) => ({ ...r, parsed: parsePredictionListName(r.name) }));

/** The group a list falls in, for a grouping (a stable key + its sort rank). */
export function groupKeyOf(l: ListView, by: GroupBy): { key: string; rank: number } {
  const p = l.parsed;
  if (by === 'none') return { key: 'all', rank: 0 };
  if (by === 'recency') {
    if (p.kind === 'band' || p.kind === 'newcomers') {
      const i = (RECENCY_ORDER as readonly string[]).indexOf(p.recency ?? '');
      if (i >= 0) return { key: RECENCY_ID[p.recency!], rank: i };
    }
    return p.kind === 'pen' ? { key: 'pens', rank: 50 } : { key: 'other', rank: 60 };
  }
  if (by === 'value') {
    if (p.kind === 'band') return p.band === 'le' ? { key: 'le', rank: 0 } : { key: 'gt', rank: 1 };
    if (p.kind === 'newcomers') return { key: 'newcomers', rank: 2 };
    return p.kind === 'pen' ? { key: 'pens', rank: 50 } : { key: 'other', rank: 60 };
  }
  // orders
  if (p.kind === 'band' || p.kind === 'newcomers') {
    const i = (ORDERS_ORDER as readonly string[]).indexOf(p.orders ?? '');
    if (i >= 0) return { key: ORDERS_ID[p.orders!], rank: i };
  }
  return p.kind === 'pen' ? { key: 'pens', rank: 50 } : { key: 'other', rank: 60 };
}

export interface ListsRollup {
  count: number;
  value_mkd: number | null;
  cod_mkd: number | null;
  cash_mkd: number | null;
  stale_to_pack_value_mkd: number | null;
  paid: number;
  returned: number;
  units: number;
  stale_to_pack: number;
  worked: number;
  worked_sale: number;
  worked_no: number;
  worked_trash: number;
  /** Σ over lists — a number decided on two lists counts twice. */
  customers: number;
  members: number;
  members_active: number;
  no_answer: number;
  lists: number;
  buckets: ListsPart[];
  outside: ListsPart[];
}

const SUM_KEYS = [
  'count', 'paid', 'returned', 'units', 'stale_to_pack', 'worked', 'worked_sale', 'worked_no', 'worked_trash',
  'customers', 'members', 'members_active', 'no_answer',
] as const;
const MONEY_SUM_KEYS = ['value_mkd', 'cod_mkd', 'cash_mkd', 'stale_to_pack_value_mkd'] as const;

/** Parts by key across rows (only the keys above 0 are kept, in bar order). */
export function mergeParts(lists: ListsPart[][], order: readonly string[]): ListsPart[] {
  const acc = new Map<string, ListsPart>();
  for (const parts of lists) {
    for (const p of parts ?? []) {
      const cur = acc.get(p.key) ?? { key: p.key, count: 0 };
      cur.count += num(p.count);
      if (hasNum(p.value_mkd)) cur.value_mkd = num(cur.value_mkd) + p.value_mkd;
      if (hasNum(p.cod_mkd)) cur.cod_mkd = num(cur.cod_mkd) + p.cod_mkd;
      acc.set(p.key, cur);
    }
  }
  return order.filter((k) => acc.has(k) && acc.get(k)!.count > 0).map((k) => acc.get(k)!);
}

/** Σ of rows; a money sum is null when no row carries money (non-owner). */
export function rollup(rows: Partial<ListsRow>[]): ListsRollup {
  const out = { lists: rows.length } as ListsRollup;
  for (const k of SUM_KEYS) out[k] = rows.reduce((a, r) => a + num(r[k]), 0);
  for (const k of MONEY_SUM_KEYS) {
    const any = rows.some((r) => hasNum(r[k]));
    out[k] = any ? rows.reduce((a, r) => a + num(r[k]), 0) : null;
  }
  out.buckets = mergeParts(rows.map((r) => r.buckets ?? []), COHORT_BUCKETS);
  out.outside = mergeParts(rows.map((r) => r.outside ?? []), COHORT_OUTSIDE);
  return out;
}

export interface ListGroup {
  key: string;
  rank: number;
  rows: ListView[];
  total: ListsRollup;
}

export type SortBy = 'order' | 'value' | 'sales' | 'conversion' | 'members';
export const SORT_BYS: SortBy[] = ['order', 'value', 'sales', 'conversion', 'members'];

const orderCmp = (a: ListView, b: ListView) =>
  (a.order ?? 9999) - (b.order ?? 9999) || String(a.name ?? '').localeCompare(String(b.name ?? ''));

export function sortRows(rows: ListView[], by: SortBy): ListView[] {
  const out = [...rows];
  const desc = (f: (r: ListView) => number) => (a: ListView, b: ListView) => f(b) - f(a) || orderCmp(a, b);
  switch (by) {
    case 'value': return out.sort(desc((r) => (hasNum(r.value_mkd) ? r.value_mkd : r.count)));
    case 'sales': return out.sort(desc((r) => r.count));
    case 'conversion': return out.sort(desc((r) => conversionOf(r.count, r.worked) ?? -1));
    case 'members': return out.sort(desc((r) => r.members_active));
    default: return out.sort(orderCmp);
  }
}

/** A list that has nothing to say for the period: no member now, no work, no sale. */
export const isQuiet = (r: ListsRow) =>
  r.members === 0 && r.worked === 0 && r.count === 0 && r.no_answer === 0 && (r.outside ?? []).length === 0;

export function groupLists(rows: ListView[], by: GroupBy, sort: SortBy): ListGroup[] {
  const groups = new Map<string, ListGroup>();
  for (const r of rows) {
    const g = groupKeyOf(r, by);
    const cur = groups.get(g.key) ?? { key: g.key, rank: g.rank, rows: [], total: null as unknown as ListsRollup };
    cur.rows.push(r);
    groups.set(g.key, cur);
  }
  return [...groups.values()]
    .map((g) => ({ ...g, rows: sortRows(g.rows, sort), total: rollup(g.rows) }))
    .sort((a, b) => a.rank - b.rank);
}

// ── Rates ───────────────────────────────────────────────────────────────────

/** Sales ÷ worked decisions (Обработени); null when nothing was worked. */
export const conversionOf = (sales: number, worked: number): number | null => (worked > 0 ? sales / worked : null);
/** Returned ÷ the parcels MEX finished (paid + returned). */
export const returnRateOf = (paid: number, returned: number): number | null =>
  paid + returned > 0 ? returned / (paid + returned) : null;
export const paidRateOf = (paid: number, sales: number): number | null => (sales > 0 ? paid / sales : null);
/** Average sale in денари (owners). */
export const aovOf = (value: number | null | undefined, sales: number): number | null =>
  hasNum(value) && sales > 0 ? value / sales : null;
/** Worked ÷ (worked + no-answer clicks): how often a dialled number ended in a decision. */
export const reachOf = (worked: number, noAnswer: number): number | null =>
  worked + noAnswer > 0 ? worked / (worked + noAnswer) : null;
/** Sales per active agent-hour over the days presence covers; null without presence. */
export const salesPerHourOf = (sales: number, activeMinutes: number | null | undefined): number | null =>
  hasNum(activeMinutes) && activeMinutes > 0 ? sales / (activeMinutes / 60) : null;

// ── /orders links (exact, or none) ──────────────────────────────────────────

export const LIST_SALE_SOURCE = 'elyon_crm';
export const LIST_DETAIL = 'prediction_list';
/** The Affiliate – Lead out department key — the tab's footer card. The tab's list sales are
 *  NOT limited to it: since 20260942001800 a list sale counts in its agent's department (a
 *  teleshop Lead-out agent's → Телешоп – Lead out), and the tab shows the list sales of every
 *  department, so its links carry sale_source + detail only (no cohort_source). */
export const LIST_COHORT_SOURCE = 'elyon_crm';

/**
 * `/orders?cohort_bucket=…&sale_source=elyon_crm&sale_source_detail=prediction_list
 * [&prediction_list=<exact name>][&sold_by_person_id=…]&sold_from&sold_to` — the
 * order twin of a number on this tab (every list sale is an order, in whichever
 * department its agent puts it — 20260942001800).
 */
export function listsHref(
  key: DrillKey | DrillKey[],
  range: DayRange,
  opts: { listName?: string | null; personId?: string | null; soldTo?: string } = {},
): string {
  const keys = Array.isArray(key) ? key : [key];
  const sp = new URLSearchParams();
  sp.set('cohort_bucket', keys.includes('total') ? 'total' : keys.join(','));
  sp.set('sale_source', LIST_SALE_SOURCE);
  sp.set('sale_source_detail', LIST_DETAIL);
  if (opts.listName) sp.set('prediction_list', opts.listName);
  if (opts.personId) sp.set('sold_by_person_id', opts.personId);
  sp.set('sold_from', range.from);
  sp.set('sold_to', opts.soldTo ?? range.to);
  return `/orders?${sp.toString()}`;
}

const partsCount = (parts: ListsPart[], keys: DrillKey[]) =>
  keys.includes('total')
    ? parts.filter((p) => (COHORT_BUCKETS as readonly string[]).includes(p.key)).reduce((a, p) => a + num(p.count), 0)
    : parts.filter((p) => (keys as string[]).includes(p.key)).reduce((a, p) => a + num(p.count), 0);

/**
 * The CohortBar/table drill for a slice of list sales. `listName`: undefined =
 * the whole prediction-list slice; a string = that list; null = a list whose
 * orders carry more than one snapshot name (no exact link — `unknown`).
 */
export function listsDrill(
  parts: ListsPart[],
  key: DrillKey | DrillKey[],
  range: DayRange | null,
  listName?: string | null,
  supported: boolean = ordersSupportsCohortDrill(),
): CohortDrill {
  const keys = Array.isArray(key) ? key : [key];
  const n = partsCount(parts, keys);
  const base = { ordersHref: null, orders: n, web: 0, mexOnly: 0 };
  if (n === 0 || !range) return { ...base, href: null, blocked: 'none' };
  if (!supported) return { ...base, href: null, blocked: 'unsupported' };
  if (listName === null) return { ...base, href: null, blocked: 'unknown' };
  return { ...base, href: listsHref(keys, range, { listName }), blocked: null };
}

/**
 * The last sale day a "to pack older than N days" sale can have, inside the
 * period: sold_to for the stale drill (sale day ≤ today − N − 1), or null when
 * the whole period is younger than that.
 */
export function staleSoldTo(range: DayRange, today: string, staleDays: number): string | null {
  const last = addDays(today, -(staleDays + 1));
  if (last < range.from) return null;
  return last < range.to ? last : range.to;
}

// ── Trend ───────────────────────────────────────────────────────────────────

/** The trend's stacked parts, in the bar's order (bottom → top). */
export const TREND_PARTS = ['paid', 'paid_unproven', 'courier', 'label', 'to_pack', 'returned'] as const;
export type TrendPart = (typeof TREND_PARTS)[number];
const TREND_OF: Record<string, TrendPart> = {
  paid: 'paid', paid_legacy: 'paid', paid_unproven: 'paid_unproven',
  courier: 'courier', courier_problem: 'courier', label: 'label', to_pack: 'to_pack', returned: 'returned',
};

export type TrendRow = { d: string; total: number } & Record<TrendPart, number>;

/** One row per period: each part in денари (money) or sales (counts). */
export function trendRows(points: ListsTrendPoint[], money: boolean): TrendRow[] {
  return points.map((p) => {
    const row = { d: p.d, total: 0 } as TrendRow;
    for (const k of TREND_PARTS) row[k] = 0;
    for (const part of p.parts ?? []) {
      const k = TREND_OF[part.key];
      if (!k) continue;
      const v = money ? num(part.value_mkd) : num(part.count);
      row[k] += v;
      row.total += v;
    }
    return row;
  });
}

// ── Recency × value band ────────────────────────────────────────────────────

export interface MatrixView {
  /** Recency families that exist in the rows (engine order). */
  rows: string[];
  cells: Record<string, Partial<Record<'le' | 'gt', ListsRollup>>>;
  /** The band threshold as named (EUR), for the column labels. */
  threshold: number | null;
  max: { value: number; count: number };
}

/** Band lists only (NEWCOMERS and the pens have no value band). */
export function recencyValueMatrix(rows: ListView[]): MatrixView {
  const cells: MatrixView['cells'] = {};
  const byCell = new Map<string, ListView[]>();
  let threshold: number | null = null;
  for (const r of rows) {
    if (r.parsed.kind !== 'band' || !r.parsed.band || !recencyId(r.parsed.recency)) continue;
    threshold ??= r.parsed.threshold;
    const k = `${r.parsed.recency}|${r.parsed.band}`;
    byCell.set(k, [...(byCell.get(k) ?? []), r]);
  }
  let maxV = 0, maxN = 0;
  for (const [k, list] of byCell) {
    const [rec, band] = k.split('|') as [string, 'le' | 'gt'];
    const id = recencyId(rec)!;
    const roll = rollup(list);
    (cells[id] ??= {})[band] = roll;
    maxV = Math.max(maxV, num(roll.value_mkd));
    maxN = Math.max(maxN, roll.count);
  }
  const present = RECENCY_ORDER.filter((r) => r !== 'NEWCOMERS' && cells[recencyId(r)!]).map((r) => recencyId(r)!);
  return { rows: present, cells, threshold, max: { value: maxV, count: maxN } };
}
