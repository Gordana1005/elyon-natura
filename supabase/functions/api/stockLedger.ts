// ============================================================================
// Stock — the physical count (попис) and MEX-driven stock movements: the pure
// half of GET /api/stock/health, POST /api/stock/count and
// POST /api/stock/mex-movements (migration 20260942000100_stock_mex_movements).
//
// Dependency-free on purpose (no Deno globals, no URL imports): vitest runs
// stockLedger.test.ts against this file in Node, and index.ts imports it.
//
//   stockHealthAccess()   who may read the health card (no money in it)
//   stockCountAccess()    who may count: business owners, admins, warehouse
//   parseCountBody()      {lines:[{product_id, counted}], note?, dry?}
//   parseMexSwitchBody()  {enabled, free_units?}
//   stockMovesOnStatus()  whether the api's OLD status-driven stock moves
//                         (shipped → deduct, returned → restore) still apply:
//                         only until the first count anchors the MEX ledger
//   countErrorStatus()    the RPC's refusal codes → HTTP status
// ============================================================================

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The most products one count may carry (the catalogue has ~250). */
export const MAX_COUNT_LINES = 5000;
/** The highest quantity a count may set for one product. */
export const MAX_COUNTED = 1_000_000;
export const MAX_NOTE = 500;

/** The health card: owners, admins, managers and the warehouse role — it carries no money. */
export function stockHealthAccess(isOwner: boolean, isAdminOrManager: boolean, isWarehouse: boolean): boolean {
  return isOwner || isAdminOrManager || isWarehouse;
}

/** Saving a count (owner brief 2026-09-28): business owners, admins and the warehouse role — not managers. */
export function stockCountAccess(isOwner: boolean, isAdmin: boolean, isWarehouse: boolean): boolean {
  return isOwner || isAdmin || isWarehouse;
}

export interface CountLine { product_id: string; counted: number }
export interface CountBody { lines: CountLine[]; note: string | null; dry: boolean }
export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** POST /api/stock/count body. Every product once, an integer 0 … 1.000.000 each. */
export function parseCountBody(body: unknown): Parsed<CountBody> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "body_required" };
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.lines) || b.lines.length === 0) return { ok: false, error: "lines_required" };
  if (b.lines.length > MAX_COUNT_LINES) return { ok: false, error: "too_many_lines" };
  const seen = new Set<string>();
  const lines: CountLine[] = [];
  for (const raw of b.lines) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "bad_line" };
    const r = raw as Record<string, unknown>;
    const id = typeof r.product_id === "string" ? r.product_id.trim().toLowerCase() : "";
    if (!UUID_RE.test(id)) return { ok: false, error: "bad_product_id" };
    const c = r.counted;
    if (typeof c !== "number" || !Number.isInteger(c) || c < 0 || c > MAX_COUNTED) return { ok: false, error: "bad_quantity" };
    if (seen.has(id)) return { ok: false, error: "duplicate_product" };
    seen.add(id);
    lines.push({ product_id: id, counted: c });
  }
  if (b.note !== undefined && b.note !== null && typeof b.note !== "string") return { ok: false, error: "bad_note" };
  const note = typeof b.note === "string" ? b.note.trim().slice(0, MAX_NOTE) : "";
  if (b.dry !== undefined && typeof b.dry !== "boolean") return { ok: false, error: "bad_dry" };
  return { ok: true, value: { lines, note: note || null, dry: b.dry === true } };
}

export type FreeUnits = "deduct" | "skip";
export interface MexSwitchBody { enabled: boolean; free_units: FreeUnits | null }

/** POST /api/stock/mex-movements body. */
export function parseMexSwitchBody(body: unknown): Parsed<MexSwitchBody> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "body_required" };
  const b = body as Record<string, unknown>;
  if (typeof b.enabled !== "boolean") return { ok: false, error: "enabled_required" };
  if (b.free_units !== undefined && b.free_units !== null && b.free_units !== "deduct" && b.free_units !== "skip") {
    return { ok: false, error: "bad_free_units" };
  }
  return { ok: true, value: { enabled: b.enabled, free_units: (b.free_units as FreeUnits | undefined) ?? null } };
}

/**
 * Whether a CRM status change (shipped / returned) still moves stock.
 * `setting` = app_settings.stock_mex_movements.value. Once the first physical
 * count has set `from`, MEX parcels move stock (public.stock_mex_apply) — a
 * status change must not, or a parcel would be deducted twice. Before that
 * (no row, no `from`, an unreadable value) the old behaviour stays.
 */
export function stockMovesOnStatus(setting: unknown): boolean {
  if (!setting || typeof setting !== "object" || Array.isArray(setting)) return true;
  const from = (setting as Record<string, unknown>).from;
  if (typeof from !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(from)) return true;
  return Number.isNaN(Date.parse(from));
}

/** The RPCs' refusal codes → HTTP status. */
export function countErrorStatus(code: string): number {
  if (code === "not_installed") return 503;
  if (code === "no_count") return 409;
  if (code === "unknown_product") return 404;
  return 400;
}
