// ============================================================================
// Insights → Returns (Враќања) and Products & stock (Производи и залихи) — the
// pure half of GET /api/insights/returns and GET /api/insights/stock
// (migration 20260941000500_insights_returns_stock).
//
// Dependency-free on purpose (no Deno globals, no URL imports): vitest runs
// insightsReturnsStock.test.ts against this file in Node, and index.ts imports it.
//
//   returnsAccess() / stockAccess()   owner → money · admin / manager (and, for
//                                     stock, the warehouse role) → counts · else 403
//   parseReturnsClock()               ?clock=sale (default, the cohort) | returned
//                                     (the MEX return day)
//   RETURNS_NON_MONEY_KEYS / STOCK_NON_MONEY_KEYS   whitelists for non-owners
//   buildReturnsResponse() / buildStockResponse()   the RPC body with `meta`
//                                     from the ONE Skopje window, money stripped
//                                     by whitelist for a non-owner (money keys
//                                     ABSENT, never 0)
//
// The numbers: the sale clock is THE cohort (insights_sale_rows) — its
// returned part ties to GET /insights/cohort for the same window; the MEX
// clock ties to the parcel register (scripts/verify-tab-returns.mjs).
// ============================================================================

import { stripInsightsMoney } from "./insightsCommon.ts";
import type { InsightsWindow } from "./insightsCommon.ts";

export type TabAccess = "owner" | "counts" | "forbidden";

/** Returns: owners see денари; any admin / manager the same page counted. */
export function returnsAccess(isOwner: boolean, isAdminOrManager: boolean): TabAccess {
  if (isOwner) return "owner";
  if (isAdminOrManager) return "counts";
  return "forbidden";
}

/** Stock: as Returns, plus the warehouse role (counts only — never cost or price). */
export function stockAccess(isOwner: boolean, isAdminOrManager: boolean, isWarehouse: boolean): TabAccess {
  if (isOwner) return "owner";
  if (isAdminOrManager || isWarehouse) return "counts";
  return "forbidden";
}

export const RETURNS_CLOCKS = ["sale", "returned"] as const;
export type ReturnsClock = (typeof RETURNS_CLOCKS)[number];

/** ?clock= → sale (default) | returned; anything else → null (400). */
export function parseReturnsClock(raw: string | null): ReturnsClock | null {
  const v = (raw ?? "").trim().toLowerCase();
  if (!v) return "sale";
  return (RETURNS_CLOCKS as readonly string[]).includes(v) ? (v as ReturnsClock) : null;
}

/** The comparison is computed only for windows up to this many days (the RPC
 *  agrees: a year's comparison would double the scan). */
export const COMPARE_MAX_DAYS = 93;

const ENVELOPE = [
  "meta", "from", "to", "prev_from", "prev_to", "prev_to_end", "partial", "days", "generated_at", "money",
  "clock", "granularity", "sources", "has_prev", "today",
];

/** Every key a non-owner may receive from GET /api/insights/returns (any depth). */
export const RETURNS_NON_MONEY_KEYS: ReadonlySet<string> = new Set([
  ...ENVELOPE,
  // kpis
  "kpis", "base", "returned", "rate", "paid", "open", "problem", "crm_only_returned", "cancelled_after_sale",
  "trashed_after_sale", "round_trip", "prev", "count", "orders", "web", "mex_only", "booked", "parcels", "share",
  "rejected", "attempted", "problematic",
  // now
  "now", "oldest",
  // breakdowns
  "by_source", "by_account", "by_product", "by_city", "by_person", "by_list", "by_weekday", "days_to_return",
  "reasons", "repeat", "trend",
  "key", "kind", "splits", "base_orders", "base_web", "base_mex_only", "base_booked",
  "rows", "name", "catalogue", "sold_units", "returned_units", "free_units", "free_returned_units", "others",
  "products", "total", "not_products", "units",
  "name_lat", "name_sq", "places", "unknown",
  "person_id", "people", "none", "list_id",
  "dow", "median_from_sale", "median_at_courier", "bins",
  "bucket", "reason",
  "phones", "returns_in_window", "phone8", "returned_all", "delivered_all", "in_window", "last_returned",
  "d",
]);

/** Every key a non-owner may receive from GET /api/insights/stock (any depth).
 *  `valuation` is deliberately absent (owners only). */
export const STOCK_NON_MONEY_KEYS: ReadonlySet<string> = new Set([
  ...ENVELOPE,
  // trust
  "trust", "trusted", "last_count", "last_restock", "last_deduction", "last_movement", "last_parcel",
  "parcels_since_deduction", "ledger_out_window", "ledger_in_window", "ledger_moves_window", "parcels_window",
  // the stock regime (20260942000100): counted, and the MEX stock ledger on / its last run
  "counted", "mex_enabled", "mex_from", "mex_last_run",
  // kpis
  "kpis", "sales", "sales_mex_only", "units", "units_prev", "free_units", "units_catalogue", "products_sold",
  "returned_units", "returned_parcels", "returned_mex_only", "tracked", "active", "out", "low",
  // queue
  "queue", "stage", "count", "orders", "web", "mex_only", "oldest", "ages", "key", "from", "to", "by_source",
  "queue_products", "name", "catalogue", "pack_units", "label_units", "on_hand",
  // products
  "products", "product_id", "sku", "placeholder", "state", "low_threshold", "cost_known",
  "altercpa", "elyon_crm", "social", "teleshop_out", "teleshop_other", "queue_units", "days_cover", "products_more",
  // trend
  "trend", "d",
  // hygiene
  "hygiene", "duplicates", "unmapped", "names", "rows", "no_cost", "selling", "not_products", "kind", "lines",
  "not_tracked", "inactive_selling",
]);

function envelope(
  rpc: Record<string, unknown> | null,
  win: InsightsWindow,
  isOwner: boolean,
  extra: Record<string, unknown>,
  now: Date,
): Record<string, unknown> {
  const body: Record<string, unknown> = { ...(rpc ?? {}) };
  const rpcMeta = body.meta && typeof body.meta === "object" ? (body.meta as Record<string, unknown>) : {};
  const hasPrev = !!win.prev && rpcMeta.has_prev === true;
  body.meta = {
    ...rpcMeta,
    ...extra,
    from: win.from,
    to: win.to,
    prev_from: hasPrev ? win.prev!.from : null,
    prev_to: hasPrev ? win.prev!.to : null,
    prev_to_end: hasPrev ? win.prev!.toEndIso : null,
    partial: win.partial,
    days: win.days,
    generated_at: now.toISOString(),
    money: isOwner,
    has_prev: hasPrev,
  };
  return body;
}

/** GET /api/insights/returns: `meta` from the window, the clock echoed, money
 *  stripped by whitelist for a non-owner. A dropped comparison (window over
 *  COMPARE_MAX_DAYS) leaves kpis.prev null. */
export function buildReturnsResponse(
  rpc: Record<string, unknown> | null,
  win: InsightsWindow,
  isOwner: boolean,
  clock: ReturnsClock,
  now: Date = new Date(),
): Record<string, unknown> {
  const body = envelope(rpc, win, isOwner, { clock }, now);
  const meta = body.meta as Record<string, unknown>;
  if (!meta.has_prev && body.kpis && typeof body.kpis === "object") {
    body.kpis = { ...(body.kpis as Record<string, unknown>), prev: null };
  }
  return isOwner ? body : stripInsightsMoney(body, RETURNS_NON_MONEY_KEYS);
}

/** GET /api/insights/stock: as Returns; a non-owner never receives the valuation. */
export function buildStockResponse(
  rpc: Record<string, unknown> | null,
  win: InsightsWindow,
  isOwner: boolean,
  now: Date = new Date(),
): Record<string, unknown> {
  const body = envelope(rpc, win, isOwner, { clock: "sale" }, now);
  if (!isOwner) return stripInsightsMoney(body, STOCK_NON_MONEY_KEYS);
  return body;
}

/** The RPC's prev window: only when compare is on AND the window is short
 *  enough (the RPC applies the same cap). */
export function prevArgs(win: InsightsWindow): { p_prev_from: string | null; p_prev_to_end: string | null } {
  if (!win.prev || win.days > COMPARE_MAX_DAYS) return { p_prev_from: null, p_prev_to_end: null };
  return { p_prev_from: win.prev.fromIso, p_prev_to_end: win.prev.toEndIso };
}
