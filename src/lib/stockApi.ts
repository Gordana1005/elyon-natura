/**
 * Stock — the physical count (попис) and MEX-driven stock movements
 * (migration 20260942000100; api module supabase/functions/api/stockLedger.ts).
 *
 *   GET  /api/stock/health          owners · admin / manager · warehouse (no money)
 *   POST /api/stock/count           owners · admin · warehouse — dry → preview
 *   POST /api/stock/mex-movements   owners only — the switch
 *
 * The health card carries no money; the count preview's value of the
 * difference is computed in the UI from the catalogue's cost, owners only.
 */
import { apiFetch } from '@/lib/api';

export interface StockHealth {
  /** A count exists AND MEX stock movements are on AND the ledger ran in the last 3 hours. */
  trusted: boolean;
  counted: { at: string; by: string | null; count_id: string; products: number; changed: number; anchored: boolean } | null;
  counted_at: string | null;
  catalogue: { active: number; counted: number; never_counted: number };
  mex: { enabled: boolean; from: string | null; free_units: 'deduct' | 'skip'; enabled_at: string | null; changed_by_name: string | null };
  last_run: { at: string; status: 'running' | 'ok' | 'failed'; error: string | null; movements: number | null; duration_ms: number | null } | null;
  last_ok_run: string | null;
  /** What the MEX ledger applied since `from` (null before the first count). */
  applied: { movements: number; units_out: number; units_in: number; units_reversed: number; last_movement: string | null; parcels_deducted: number } | null;
  /** What waits for review (null before the first count). */
  review: {
    parcels: number;
    deduct_events: number;
    skipped: { no_owner: number; no_lines: number; unmapped: number; test_phone: number };
    unmapped: { lines: number; units: number; names: number; rows: { name: string; src: string; why: string; lines: number; units: number }[] };
    not_stock: { kind: string; lines: number; units: number }[];
  } | null;
  /** What a run would move now — before the switch: what switching on applies. */
  pending: { keys: number; parcels: number; units_out: number; units_in: number; units_reversed: number; frozen: number } | null;
  products: {
    product_id: string;
    last_counted_at: string | null;
    counted_qty: number | null;
    out_30d: number | null;
    window_days: number | null;
    /** Only when trusted. */
    days_cover: number | null;
  }[];
  can_count: boolean;
  can_switch: boolean;
}

export interface StockCountLine { product_id: string; counted: number }

export interface StockCountResult {
  ok: true;
  dry: boolean;
  count_id?: string;
  counted_at?: string;
  products: number;
  changed: number;
  units_before: number;
  units_after: number;
  up: number;
  down: number;
  /** Active products this count does not cover (they keep their number). */
  not_counted: number;
  /** Preview: this count would anchor the MEX ledger (the first count). */
  anchors?: boolean;
  /** Saved: this count anchored it. */
  anchored?: boolean;
  from: string | null;
  lines: { product_id: string; name: string; sku: string | null; system: number; counted: number; diff: number }[];
}

export const apiGetStockHealth = (detail = true): Promise<StockHealth> =>
  apiFetch(`stock/health${detail ? '' : '?detail=0'}`);

export const apiPostStockCount = (body: { lines: StockCountLine[]; note?: string | null; dry: boolean }): Promise<StockCountResult> =>
  apiFetch('stock/count', { method: 'POST', body: JSON.stringify(body) });

export const apiSetStockMexMovements = (body: { enabled: boolean; free_units?: 'deduct' | 'skip' }) =>
  apiFetch<{ ok: true; settings: Record<string, unknown>; run: Record<string, unknown> | null }>(
    'stock/mex-movements', { method: 'POST', body: JSON.stringify(body) });

/** The api's refusal codes that have their own words (stockCount.err.*). */
export const STOCK_ERROR_CODES = [
  'bad_quantity', 'bad_product_id', 'duplicate_product', 'unknown_product', 'lines_required', 'too_many_lines',
  'no_count', 'owners_only', 'stock_not_installed', 'bad_free_units',
] as const;
