/**
 * /shops — pure helpers (no React; shopsModel.test.ts covers them): the URL state, money
 * presence, sorting, the vs-average and control states, the hour axis, the stock / matrix
 * filters and the small parsers the page needs. Shapes: src/lib/shopsTypes.ts.
 */
import { normalizeForSearch } from '@/lib/transliterate';
import { skopjeParts, skopjeYmd } from '@/lib/skopjeTime';
import { PERIOD_PARAMS, daysBetween } from '@/components/insights/shared/period';
import type {
  ShopDayRow, ShopRef, ShopStockRow, ShopsFreshness, ShopsStockMatrix,
} from '@/lib/shopsTypes';

// ── tabs + URL ──────────────────────────────────────────────────────────────

export const SHOPS_TABS = ['day', 'ranking', 'shop', 'stock', 'deliveries', 'health'] as const;
export type ShopsTab = (typeof SHOPS_TABS)[number];
/** The tabs that count by the page's period (the filter bar shows on them). */
export const PERIOD_TABS: ReadonlySet<ShopsTab> = new Set<ShopsTab>(['day', 'ranking', 'shop', 'deliveries']);

/**
 * The URL for another tab: the tab, the shared period and the chosen shop — a tab's own
 * filters (search, "only zero", brand, sort…) stay behind.
 */
export function tabParams(sp: URLSearchParams, tab: ShopsTab, extra?: Record<string, string>): URLSearchParams {
  const out = new URLSearchParams();
  out.set('tab', tab);
  for (const k of [...PERIOD_PARAMS, 'shop']) {
    const v = sp.get(k);
    if (v && k !== 'compare') out.set(k, v);
  }
  for (const [k, v] of Object.entries(extra ?? {})) out.set(k, v);
  return out;
}

/** Sets (or, for '' / null / false, removes) one URL param, keeping every other one. */
export function withParam(sp: URLSearchParams, key: string, value: string | boolean | null | undefined): URLSearchParams {
  const out = new URLSearchParams(sp);
  if (value === null || value === undefined || value === '' || value === false) out.delete(key);
  else out.set(key, value === true ? '1' : value);
  return out;
}

// ── money: render only what the payload carries ─────────────────────────────

const MONEY_KEY = /_mkd$/;

/** The key is in the payload (a number, or null = not computed yet). Absent = this reader sees no money. */
export const hasKey = (o: object | null | undefined, k: string): boolean =>
  !!o && Object.prototype.hasOwnProperty.call(o, k) && (o as Record<string, unknown>)[k] !== undefined;

export const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * What a manager receives (docs/SHOPS.md): the same payload, every `*_mkd` key removed.
 * Used by the tests and the screenshot mocks — the page itself only reads which keys arrived.
 */
export function stripShopsMoney<T>(v: T): T {
  const walk = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object') {
      return Object.fromEntries(Object.entries(x as Record<string, unknown>).filter(([k]) => !MONEY_KEY.test(k)).map(([k, y]) => [k, walk(y)]));
    }
    return x;
  };
  return walk(v) as T;
}

// ── shop rows: sorting ──────────────────────────────────────────────────────

export const SORT_KEYS = [
  'sales_mkd', 'units', 'receipts', 'avg_receipt_mkd', 'shop_margin_mkd', 'group_margin_mkd', 'returns_units', 'vs_avg_pct',
] as const;
export type ShopSortKey = (typeof SORT_KEYS)[number];
export const isMoneySort = (k: ShopSortKey) => MONEY_KEY.test(k);
/** i18n leaf under shops.metric.* */
export const SORT_LABEL: Record<ShopSortKey, string> = {
  sales_mkd: 'sales', units: 'units', receipts: 'receipts', avg_receipt_mkd: 'avgReceipt',
  shop_margin_mkd: 'shopMargin', group_margin_mkd: 'groupMargin', returns_units: 'returns', vs_avg_pct: 'vsAvg',
};

/** The sorts this payload can answer: a money metric only when its key arrived. */
export function availableSorts(rows: ShopDayRow[], totals?: object | null): ShopSortKey[] {
  return SORT_KEYS.filter((k) => !isMoneySort(k) || hasKey(totals, k) || rows.some((r) => hasKey(r, k)));
}

/** Owners rank by sales, everyone else by units. */
export const defaultSort = (money: boolean): ShopSortKey => (money ? 'sales_mkd' : 'units');

/** Reads `sort` from the URL; an unknown or unavailable key falls back to the default. */
export function parseSort(raw: string | null, available: ShopSortKey[], money: boolean): ShopSortKey {
  const k = raw as ShopSortKey;
  if (raw && (SORT_KEYS as readonly string[]).includes(raw) && available.includes(k)) return k;
  const d = defaultSort(money);
  return available.includes(d) ? d : 'units';
}

export const sortValue = (r: ShopDayRow, k: ShopSortKey): number | null => numOrNull((r as unknown as Record<string, unknown>)[k]);

/** Highest first (or lowest with dir 'asc'); a missing value always last; ties by shop code. */
export function sortShops(rows: ShopDayRow[], key: ShopSortKey, dir: 'asc' | 'desc' = 'desc'): ShopDayRow[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = sortValue(a, key), y = sortValue(b, key);
    if (x == null && y == null) return a.shop.code.localeCompare(b.shop.code);
    if (x == null) return 1;
    if (y == null) return -1;
    return x === y ? a.shop.code.localeCompare(b.shop.code) : sign * (x - y);
  });
}

// ── vs average · daily control ──────────────────────────────────────────────

export type VsDir = 'up' | 'down' | 'flat' | 'none';
/** Within ±2 % of the average reads "at average" — not an arrow. */
export const VS_FLAT_PCT = 2;
/** vs_avg_pct is in percent (12.5 = +12,5 %), as every `_pct` in the api. */
export function vsDir(pct: number | null | undefined): VsDir {
  const v = numOrNull(pct);
  if (v == null) return 'none';
  if (Math.abs(v) < VS_FLAT_PCT) return 'flat';
  return v > 0 ? 'up' : 'down';
}

export type ControlState = 'ok' | 'diff' | 'pending';
export const controlState = (ok: boolean | null | undefined): ControlState => (ok === true ? 'ok' : ok === false ? 'diff' : 'pending');

/** margin ÷ base as a fraction, or null when it cannot be said. */
export const shareOf = (part: number | null | undefined, base: number | null | undefined): number | null => {
  const p = numOrNull(part), b = numOrNull(base);
  return p == null || b == null || b <= 0 ? null : p / b;
};

// ── the hour axis ───────────────────────────────────────────────────────────

/** The shops' day on the axis even before the first / after the last receipt. */
export const SHOP_HOURS = { open: 8, close: 21 } as const;

export interface HourRow { hour: number; receipts: number; units: number; sales_mkd?: number; partial: boolean }

/**
 * Every hour from opening (or the first receipt) to closing (or the last receipt), the
 * missing ones as zeros; `nowHour` (live day) marks the running hour and the axis stops there.
 */
export function hourlyRows(
  hourly: { hour: number; receipts: number; units: number; sales_mkd?: number }[],
  nowHour: number | null,
): HourRow[] {
  const by = new Map(hourly.map((h) => [h.hour, h]));
  const money = hourly.some((h) => hasKey(h, 'sales_mkd'));
  const first = Math.min(SHOP_HOURS.open, ...hourly.map((h) => h.hour));
  let last = Math.max(SHOP_HOURS.close, ...hourly.map((h) => h.hour));
  if (nowHour != null) last = Math.max(Math.min(last, nowHour), ...hourly.map((h) => h.hour));
  const out: HourRow[] = [];
  for (let h = first; h <= last; h++) {
    const x = by.get(h);
    const row: HourRow = { hour: h, receipts: x?.receipts ?? 0, units: x?.units ?? 0, partial: nowHour != null && h === nowHour };
    if (money) row.sales_mkd = numOrNull(x?.sales_mkd) ?? 0;
    out.push(row);
  }
  return out;
}

// ── stock (one shop) ────────────────────────────────────────────────────────

const norm = (s: string | null | undefined) => normalizeForSearch(String(s ?? ''));

/** Name, code or brand, Cyrillic or Latin. */
export function matchesSearch(q: string, ...fields: (string | null | undefined)[]): boolean {
  const n = norm(q).trim();
  if (!n) return true;
  return fields.some((f) => norm(f).includes(n));
}

/** "Само нула" = nothing on the shelf. Top sellers at zero first, then the best sellers. */
export function filterStock(rows: ShopStockRow[], p: { q?: string | null; zero?: boolean }): ShopStockRow[] {
  return rows
    .filter((r) => (!p.zero || r.qty <= 0) && matchesSearch(p.q ?? '', r.name, r.code, r.brand))
    .sort((a, b) => Number(b.zero_top_seller) - Number(a.zero_top_seller) || b.sold_30d - a.sold_30d || a.name.localeCompare(b.name));
}

/** The server's stock basis — 'snapshot 01.10 23:30 + 14 movements' — read for translation; null = show as sent. */
export function parseStockBasis(s: string | null | undefined): { at: string; movements: number } | null {
  const m = /snapshot\s+(\d{1,2}\.\d{1,2}(?:\.\d{2,4})?\s+\d{1,2}:\d{2})\s*\+\s*(\d+)\s+movements?/i.exec(String(s ?? ''));
  return m ? { at: m[1], movements: Number(m[2]) } : null;
}

// ── the matrix ──────────────────────────────────────────────────────────────

export type MatrixArticle = ShopsStockMatrix['articles'][number];
/** How many of the chain's best sellers (sold in 30 days) count as "top" for the red zeros. */
export const TOP_SELLERS_N = 20;
export const NO_BRAND = '__none__';

/**
 * Shelf goods only (02.10.2026, the first live read): never a loyalty ПОЕН voucher, a bag / consumable
 * (≤ 4-digit codes such as 1506 ХАРТИЕНА КЕСА) or a bundle the till assembles at the moment of sale
 * (collabBox bundle codes 1xxxxx–9xxxxx, names like "1+1 …", "ТУРМЕРИК 1+1", "3/1 ДИАБЕТОЛ …", "2 КРЕАТИН …").
 * Twin of the SQL rule in shops_stock_rows() (migration 20260946000400).
 */
export function isShelfGoods(a: Pick<MatrixArticle, 'code' | 'name'>): boolean {
  const code = String(a.code ?? '').trim();
  const name = String(a.name ?? '');
  if (/^поен/i.test(code) || /^поен/i.test(name)) return false;
  if (/^\d{1,4}$/.test(code) || /^[1-9]\d{5}$/.test(code)) return false;
  if (/\d\s*\+\s*\d/.test(name) || /^\s*\d+\s*\/\s*\d+\s/.test(name) || /^\s*[1-9]\s+[^0-9%]/.test(name)) return false;
  return true;
}

/** The chain's top sellers by 30-day units (only shelf goods that sold). */
export function topSellerCodes(articles: MatrixArticle[], n = TOP_SELLERS_N): Set<string> {
  return new Set([...articles].filter((a) => a.sold_30d_total > 0 && isShelfGoods(a))
    .sort((a, b) => b.sold_30d_total - a.sold_30d_total || a.code.localeCompare(b.code))
    .slice(0, n).map((a) => a.code));
}

export const qtyIn = (a: MatrixArticle, code: string): number => numOrNull(a.by_shop?.[code]) ?? 0;

/** Active shops where a top seller has nothing. */
export const zeroShops = (a: MatrixArticle, shops: ShopRef[]): ShopRef[] => shops.filter((s) => s.active && qtyIn(a, s.code) <= 0);

export function brandsOf(articles: MatrixArticle[]): string[] {
  const set = new Set<string>();
  for (const a of articles) set.add(a.brand ?? NO_BRAND);
  return [...set].sort((a, b) => (a === NO_BRAND ? 1 : b === NO_BRAND ? -1 : a.localeCompare(b)));
}

/** Search + brand + "only top sellers with a zero"; best sellers first. */
export function filterMatrix(
  m: ShopsStockMatrix, p: { q?: string | null; brand?: string | null; gaps?: boolean }, top: Set<string>,
): MatrixArticle[] {
  return m.articles
    .filter((a) => matchesSearch(p.q ?? '', a.name, a.code, a.brand)
      && (!p.brand || (a.brand ?? NO_BRAND) === p.brand)
      && (!p.gaps || (top.has(a.code) && zeroShops(a, m.shops).length > 0)))
    .sort((a, b) => b.sold_30d_total - a.sold_30d_total || a.name.localeCompare(b.name));
}

/** Compact numbers for the dense matrix: 1.240 → 1,2k (the cell's title carries the full value). */
export function compactQty(n: number, lang: string): string {
  if (Math.abs(n) < 1000) return String(Math.round(n));
  const v = (n / 1000).toFixed(Math.abs(n) >= 10_000 ? 0 : 1).replace(/\.0$/, '');
  return `${lang === 'en' ? v : v.replace('.', ',')}k`;
}

// ── health · freshness ──────────────────────────────────────────────────────

/** How far the receipt backfill is from `from` to today (0–1), or null before it starts. */
export function backfillShare(from: string | null, doneUntil: string | null, today: string): number | null {
  if (!from || !doneUntil) return null;
  const total = daysBetween(from, today);
  if (total <= 0) return 1;
  return Math.max(0, Math.min(1, daysBetween(from, doneUntil) / total));
}

export const minutesSince = (iso: string | null | undefined, now: number): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.max(0, Math.floor((now - t) / 60_000));
};

/** The reader reads receipts every 15 min, 07:00–23:00: past 30 min on a live day is late. */
export const SALES_STALE_MIN = 30;
export function salesLate(fresh: ShopsFreshness | null | undefined, now: number): boolean {
  const m = minutesSince(fresh?.last_sales_at, now);
  const h = skopjeParts(now).h;
  return m != null && m > SALES_STALE_MIN && h >= 7 && h < 23;
}

/** The stock snapshot's time alone when it is from today or yesterday (the nightly 23:30), else with its day. */
export function snapshotIsRecent(iso: string | null | undefined, now: number): boolean {
  if (!iso) return false;
  const day = skopjeYmd(iso);
  if (!day) return false;
  const gap = daysBetween(day, skopjeYmd(now));
  return gap >= 0 && gap <= 1;
}
