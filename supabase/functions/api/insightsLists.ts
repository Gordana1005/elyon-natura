// ============================================================================
// Insights → Prediction lists (Прогнозни списоци) — the pure half of
// GET /api/insights/lists (migration 20260941000400_insights_lists).
//
// Dependency-free on purpose (no Deno globals, no URL imports): vitest runs
// insightsLists.test.ts against this file in Node, and index.ts imports it.
//
//   LISTS_STALE_DAYS         "to pack" older than this many Skopje days is stale
//   LISTS_NON_MONEY_KEYS     every key a non-owner admin/manager may receive
//   buildListsResponse()     the RPC body + its cash-flow line, `meta` from the
//                            window (the one Skopje window every tab uses), the
//                            money stripped by whitelist for a non-owner
//
// The numbers are THE sale cohort's (insights_sale_rows): the tab's total is
// the list sales of EVERY department — Σ over the departments of the Overview's
// prediction_list split, by construction (a list sale's department is its
// parcel's MEX profile / series, 20260942001860 — never its agent's team).
// `elyon_crm` is the Affiliate – Lead out card alone (the tab's footer).
// ============================================================================

import { stripInsightsMoney } from "./insightsCommon.ts";
import type { InsightsWindow } from "./insightsCommon.ts";

/** A list sale still "to pack" after this many Skopje days is stale. */
export const LISTS_STALE_DAYS = 7;

/** Every key a non-owner may receive from GET /api/insights/lists (any depth).
 *  A money key (*_mkd / *_eur) never passes, even if listed; a key a later
 *  migration adds is dropped until it is listed here. */
export const LISTS_NON_MONEY_KEYS: ReadonlySet<string> = new Set([
  // envelope
  "meta", "from", "to", "prev_from", "prev_to", "prev_to_end", "partial", "days", "today", "generated_at",
  "money", "clock", "granularity", "trend_from", "stale_days", "has_prev", "first_attr_day", "presence_from",
  "total", "buckets", "outside", "lists", "not_recorded", "elyon_crm", "prev", "trend", "cash_flow", "agents",
  "quality",
  // totals / list rows
  "count", "paid", "returned", "units", "stale_to_pack", "lists_with_sales", "worked", "worked_sale",
  "worked_no", "worked_trash", "customers", "people", "no_answer", "no_answer_unlisted", "orders", "web",
  "mex_only", "id", "name", "category", "is_static", "is_active", "known", "order", "members",
  "members_active", "members_assigned", "drill_name", "last_sale", "spark",
  // bucket / split / trend objects
  "key", "splits", "d", "parts",
  // people
  "person_id", "sales", "lists", "active_minutes", "presence_days", "sales_on_presence_days",
  // not recorded / quality
  "samples", "display_id", "dup_of", "dup_of_list", "kind", "with_parcel",
  // cash flow (counts only)
  "parcels", "from_earlier",
]);

/**
 * GET /api/insights/lists: the RPC body with `meta` taken from the window (so
 * a partial-day comparison reports its real cut) and the cash-flow line
 * (insights_lists_cash — null when it failed: the tab still answers). A
 * non-owner gets the same payload with every money key ABSENT.
 */
export function buildListsResponse(
  rpc: Record<string, unknown> | null,
  cash: Record<string, unknown> | null,
  win: InsightsWindow,
  isOwner: boolean,
  now: Date = new Date(),
): Record<string, unknown> {
  const body: Record<string, unknown> = { ...(rpc ?? {}) };
  const rpcMeta = body.meta && typeof body.meta === "object" ? (body.meta as Record<string, unknown>) : {};
  // The RPC drops the comparison when it would scan past the foundation's cap.
  const hasPrev = !!win.prev && rpcMeta.has_prev !== false;
  body.meta = {
    ...rpcMeta,
    from: win.from,
    to: win.to,
    prev_from: hasPrev ? win.prev!.from : null,
    prev_to: hasPrev ? win.prev!.to : null,
    prev_to_end: hasPrev ? win.prev!.toEndIso : null,
    partial: win.partial,
    days: win.days,
    generated_at: now.toISOString(),
    money: isOwner,
    clock: "sale",
    has_prev: hasPrev,
  };
  if (!hasPrev) body.prev = null;
  body.cash_flow = cash && typeof cash === "object" && !Array.isArray(cash) ? cash : null;
  return isOwner ? body : stripInsightsMoney(body, LISTS_NON_MONEY_KEYS);
}
