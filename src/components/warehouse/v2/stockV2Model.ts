/**
 * Stock v2 on /warehouse — pure helpers (no React), unit-tested in __tests__/stockV2Model.test.ts.
 * Quantities may be fractional (КГ articles), so they are written with up to 3 decimals in the
 * reader's marks; КОМ articles come back whole and read as whole numbers.
 */
import { fmtNum } from '@/components/insights/overview/model';
import type { ParcelStatusGroup, StockDayArticle, StockMoveKind, StockMoveSource, ParcelStockState } from '@/lib/stockV2Types';

/** Sigma item code: six digits, or L + five digits (local articles). */
export const ARTICLE_CODE_RE = /^(?:\d{6}|L\d{5})$/;

export const MOVE_KINDS: StockMoveKind[] = [
  'opening', 'count_adjust', 'parcel_out', 'return_in', 'unpack_in', 'transfer_out', 'transfer_in', 'receipt',
  'production_in', 'production_use', 'b2b_out', 'b2b_return_in', 'export_out', 'shop_out', 'shop_return_in',
  'writeoff', 'damaged_in', 'adjust',
];
export const MOVE_SOURCES: StockMoveSource[] = ['mex', 'count', 'sigma', 'manual', 'override'];
export const STATUS_GROUPS: ParcelStatusGroup[] = ['delivered', 'with_courier', 'to_pack', 'returned', 'problem'];
export const PARCEL_STATES: ParcelStockState[] = [
  'moved', 'partial', 'unmapped', 'no_lines', 'no_route', 'waiting_lines', 'test_phone', 'excluded', 'pre_opening',
];
export const ACCOUNTS = ['natura', 'bio_natural'] as const;

/** The MEX account's own name, as the portal writes it. */
export const accountLabel = (a: string | null | undefined) => (a === 'bio_natural' ? 'BIO NATURAL' : a === 'natura' ? 'NATURA' : a || '—');

/** Literal class strings (Tailwind) — the Overview's validated outcome palette
 *  (palette.ts BUCKET_TONE): delivered emerald · courier deep indigo · to pack indigo ·
 *  returned red · problem orange. Always shown with a word and a number. */
export const STATUS_TONE: Record<ParcelStatusGroup, string> = {
  delivered: 'bg-[#059669] dark:bg-[#10b981]',
  with_courier: 'bg-[#312e81] dark:bg-[#c7d2fe]',
  to_pack: 'bg-[#4f46e5] dark:bg-[#818cf8]',
  returned: 'bg-[#b91c1c] dark:bg-[#ef4444]',
  problem: 'bg-[#fb923c] dark:bg-[#fb923c]',
};

/** The hourly chart: created → picked up, two steps of the Overview's pipeline ramp (indigo). */
export const HOURLY_COLOR_VARS =
  '[--s2-created:#818cf8] dark:[--s2-created:#4f46e5] [--s2-picked:#312e81] dark:[--s2-picked:#c7d2fe] ' +
  '[--s2-line:#4f46e5] dark:[--s2-line:#818cf8] [--s2-neg:#dc2626] dark:[--s2-neg:#ef4444] ' +
  '[--s2-grid:#e5e7eb] dark:[--s2-grid:#262c3b] [--s2-axis:#6b7280] dark:[--s2-axis:#8b93a7]';
export const s2Var = (k: 'created' | 'picked' | 'line' | 'neg' | 'grid' | 'axis') => `var(--s2-${k})`;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A quantity in the reader's marks: 1.250 · 12,5 (КГ) · '—' when missing. */
export function fmtQty(v: number | null | undefined, lang: string): string {
  if (!isNum(v)) return '—';
  const r = Math.round(v * 1000) / 1000;
  if (Number.isInteger(r)) return fmtNum(r, lang, 0).replace(/^-/, '−');
  const s = fmtNum(r, lang, 3);
  // trim trailing zeros of the decimals (12,500 → 12,5)
  return s.replace(/([.,]\d*?)0+$/, '$1').replace(/[.,]$/, '').replace(/^-/, '−');
}

/** A signed difference: +20 · −5 · 0. */
export function fmtSigned(v: number | null | undefined, lang: string): string {
  if (!isNum(v)) return '—';
  if (v > 0) return `+${fmtQty(v, lang)}`;
  return fmtQty(v, lang);
}

/** Days of cover with one decimal under 10 (3,5 д), whole above. */
export function fmtCover(v: number | null | undefined, lang: string): string | null {
  if (!isNum(v)) return null;
  if (v < 10) return fmtNum(Math.round(v * 10) / 10, lang, 1).replace(/[.,]0$/, '');
  return fmtNum(Math.round(v), lang, 0);
}

/** Is a money key present on a row (owners only — the api strips it for everyone else)? */
export function hasKey<T extends object>(obj: T | null | undefined, key: string): boolean {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

/** HH:MM (24 h) or null. */
export function parseHm(text: string | null | undefined): string | null {
  const m = /^(\d{1,2})[:.](\d{2})$/.exec((text ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

/**
 * What a worker types as a counted quantity → a number, null (blank) or 'invalid'.
 * "1.250" / "1 250" = 1250 (Macedonian thousands), "12,5" = 12.5, "12.5" = 12.5 (a dot with
 * not exactly three digits after it is a decimal point). Negative values are invalid.
 */
export function parseQty(text: string | null | undefined): number | null | 'invalid' {
  const s = String(text ?? '').trim().replace(/\u00a0/g, ' ');
  if (s === '') return null;
  let norm: string;
  if (/^\d{1,3}([. ]\d{3})+(,\d+)?$/.test(s)) norm = s.replace(/[. ]/g, '').replace(',', '.');
  else if (/^\d+(,\d+)?$/.test(s)) norm = s.replace(',', '.');
  else if (/^\d+(\.\d+)?$/.test(s)) norm = s;
  else return 'invalid';
  const n = Number(norm);
  if (!Number.isFinite(n) || n < 0 || n > 10_000_000) return 'invalid';
  return Math.round(n * 1000) / 1000;
}

export interface PastedLine { code: string; qty: number }
export interface PasteResult { lines: PastedLine[]; errors: { row: number; text: string }[] }

/**
 * Two columns pasted from Excel — code<TAB>qty (also `;`, or spaces). A header row and empty
 * rows are skipped; a code that repeats keeps the LAST quantity (the sheet's correction).
 */
export function parsePasted(text: string): PasteResult {
  const out = new Map<string, number>();
  const errors: PasteResult['errors'] = [];
  const rows = text.replace(/\r/g, '').split('\n');
  rows.forEach((raw, i) => {
    const row = raw.trim();
    if (!row) return;
    const cells = row.split(/\t|;/).map((c) => c.trim()).filter((c) => c !== '');
    let code: string | undefined;
    let qtyText: string | undefined;
    if (cells.length >= 2) { code = cells[0]; qtyText = cells[cells.length - 1]; }
    else {
      const m = /^(\S+)\s+(.+)$/.exec(row);
      if (m) { code = m[1]; qtyText = m[2]; }
    }
    code = code?.toUpperCase().replace(/^'/, '');
    const qty = parseQty(qtyText);
    if (!code || !ARTICLE_CODE_RE.test(code) || qty === null || qty === 'invalid') {
      // the first row of a sheet is usually its header — not an error
      if (i === 0 && !/\d/.test(row.slice(0, 6))) return;
      errors.push({ row: i + 1, text: row.slice(0, 80) });
      return;
    }
    out.set(code, qty);
  });
  return { lines: [...out].map(([code, qty]) => ({ code, qty })), errors };
}

export type ArticleSort = 'name' | 'closing' | 'out' | 'available' | 'cover' | 'value';
export const ARTICLE_SORTS: ArticleSort[] = ['name', 'out', 'closing', 'available', 'cover', 'value'];

/** Search (code or name) · only negative · sorted. Negative rows always lead when sorting by stock. */
export function filterArticles(rows: StockDayArticle[], opts: { q?: string; negative?: boolean; sort?: ArticleSort }, lang: string): StockDayArticle[] {
  const q = (opts.q ?? '').trim().toLowerCase();
  let out = rows.filter((r) => (!opts.negative || r.negative || r.closing < 0)
    && (!q || r.code.toLowerCase().includes(q) || r.name.toLowerCase().includes(q)));
  const sort = opts.sort ?? 'out';
  const num = (v: number | null | undefined, empty: number) => (isNum(v) ? v : empty);
  out = [...out].sort((a, b) => {
    switch (sort) {
      case 'name': return a.name.localeCompare(b.name, lang);
      case 'closing': return a.closing - b.closing;
      case 'available': return a.available - b.available;
      case 'cover': return num(a.days_cover, Infinity) - num(b.days_cover, Infinity);
      case 'value': return num(b.value_mkd, -Infinity) - num(a.value_mkd, -Infinity);
      case 'out':
      default: return b.out - a.out || a.name.localeCompare(b.name, lang);
    }
  });
  return out;
}

/** A non-negative whole page number from the URL (?page=), 0 when unreadable. */
export const readPage = (v: string | null): number => {
  const n = Number(v);
  return Number.isInteger(n) && n > 1 ? n - 1 : 0;
};

/** The 0-based row offset of ?page= (1-based in the URL, absent = the first page). */
export const readPageOffset = (v: string | null, limit: number): number => readPage(v) * limit;
