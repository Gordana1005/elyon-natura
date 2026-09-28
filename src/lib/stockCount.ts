/**
 * The stock count (попис) form model — pure, unit-tested (stockCount.test.ts).
 *
 * A draft maps product id → what the worker typed. Blank = not counted (the
 * product keeps its number); a whole number 0 … 1.000.000 = counted; anything
 * else is invalid and blocks the save. The preview's real difference comes
 * from the server (against the quantity at that moment); this summary is the
 * live estimate against the loaded list.
 */
import type { StockCountLine } from '@/lib/stockApi';

export const MAX_COUNTED = 1_000_000;
export const DRAFT_STORAGE_KEY = 'elyon.stockCountDraft.v1';

export type CountDraft = Record<string, string>;

export interface CountProduct {
  id: string;
  name: string;
  sku?: string | null;
  stock_quantity: number;
  cost_price?: number | null;
  is_active?: boolean;
}

/** Whole units, Macedonian grouping (1.250 · −30). */
export function formatUnits(n: number | null | undefined): string {
  const v = Math.round(Number(n) || 0);
  const s = String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return v < 0 ? `−${s}` : s;
}

/** '' → null (not counted) · '12' → 12 · anything else → 'invalid'. */
export function parseCounted(text: string | undefined | null): number | null | 'invalid' {
  const s = String(text ?? '').trim();
  if (s === '') return null;
  // Plain digits, or thousands grouped by a dot / space as typed in Macedonian
  // ("1.000", "1 250"). "2.5" is NOT 25 — a count is whole units.
  if (!/^\d+$/.test(s) && !/^\d{1,3}([. ]\d{3})+$/.test(s)) return 'invalid';
  const n = Number(s.replace(/[. ]/g, ''));
  return n <= MAX_COUNTED ? n : 'invalid';
}

export interface CountSummary {
  lines: StockCountLine[];
  invalid: string[];
  counted: number;
  changed: number;
  up: number;
  down: number;
  /** Σ difference × cost (EUR) over counted products with a known cost — owners render it in денари. */
  diffCostEur: number;
}

/** The lines to send and the live estimate against the loaded quantities. */
export function summarizeCount(draft: CountDraft, products: CountProduct[]): CountSummary {
  const out: CountSummary = { lines: [], invalid: [], counted: 0, changed: 0, up: 0, down: 0, diffCostEur: 0 };
  for (const p of products) {
    const v = parseCounted(draft[p.id]);
    if (v === null) continue;
    if (v === 'invalid') { out.invalid.push(p.id); continue; }
    out.lines.push({ product_id: p.id, counted: v });
    out.counted++;
    const diff = v - Number(p.stock_quantity || 0);
    if (diff !== 0) out.changed++;
    if (diff > 0) out.up += diff;
    if (diff < 0) out.down -= diff;
    const cost = Number(p.cost_price || 0);
    if (cost > 0) out.diffCostEur += diff * cost;
  }
  return out;
}

/** Fill every EMPTY field with the system quantity (a quick start for a partial recount). */
export function fillEmptyWithSystem(draft: CountDraft, products: CountProduct[]): CountDraft {
  const next: CountDraft = { ...draft };
  for (const p of products) {
    if (String(next[p.id] ?? '').trim() === '') next[p.id] = String(Math.max(0, Number(p.stock_quantity || 0)));
  }
  return next;
}

/** A draft kept on this device only (a count of 170 products must survive a refresh). */
export function loadDraft(): CountDraft {
  try {
    const raw = localStorage.getItem(DRAFT_STORAGE_KEY);
    const v = raw ? JSON.parse(raw) : null;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: CountDraft = {};
    for (const [k, x] of Object.entries(v)) if (typeof x === 'string') out[k] = x;
    return out;
  } catch {
    return {};
  }
}

export function saveDraft(draft: CountDraft): void {
  try {
    const kept = Object.fromEntries(Object.entries(draft).filter(([, v]) => String(v).trim() !== ''));
    if (Object.keys(kept).length) localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(kept));
    else localStorage.removeItem(DRAFT_STORAGE_KEY);
  } catch { /* private window / blocked storage: the form still works */ }
}

export function clearDraft(): void {
  try { localStorage.removeItem(DRAFT_STORAGE_KEY); } catch { /* ignore */ }
}
