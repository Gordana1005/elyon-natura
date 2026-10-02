// ============================================================================
// Insights → Наплата (MEX) — the pure half of GET /api/insights/mex-cash
// (migration 20260947001300_insights_mex_cash, owner 02.10.2026).
//
// Dependency-free on purpose (no Deno globals, no URL imports): vitest runs
// insightsMexCash.test.ts against this file in Node, and index.ts imports it.
//
//   mexCashAccess()            a viewer → the page with money · else 403. Since the access
//                              levels (20260947001600) the api decides "viewer": can_see_mex_cash()
//                              = can_see_margins() (super_admin / owner / finance) → the whole tab;
//                              a dept_admin → only their departments' MEX account
//                              (accessLevels.ts scopeMexCash); the old named list
//                              (app_settings.mex_cash.viewers) is no longer read.
//   MEX_CASH_NON_MONEY_KEYS    the whitelist a non-owner receives (money keys
//                              ABSENT, never 0)
//   buildMexCashResponse()     the RPC body with `meta` from the ONE Skopje window
//
// The numbers: MEX's collections on the DELIVERY day (mex_parcels.delivered_at,
// MEX 2) per MEX account, and its settlement periods (half-months 1–15 / 16–end —
// the periods MEX bills, proven against its Sigma fee invoices). Never the money
// that reached the bank: no payout date is in any data the CRM holds.
// ============================================================================

import { stripInsightsMoney } from "./insightsCommon.ts";
import type { InsightsWindow } from "./insightsCommon.ts";

export type MexCashAccess = "owner" | "forbidden";

/** "What we expect" is for a short named list only (owner 02.10.2026: "2–3 people"),
 *  not every owner: a viewer on the list who is also a business owner, else 403. */
export function mexCashAccess(isViewer: boolean, isOwner: boolean): MexCashAccess {
  return isViewer && isOwner ? "owner" : "forbidden";
}

/** Every key a payload without money may carry (any depth) — the defensive strip
 *  buildMexCashResponse applies whenever it is not asked for money. */
export const MEX_CASH_NON_MONEY_KEYS: ReadonlySet<string> = new Set([
  // envelope
  "meta", "from", "to", "partial", "days", "generated_at", "money", "today", "accounts", "data_through",
  // body
  "total", "halves", "now", "d", "complete",
  // per account
  "natura", "bio_natural", "parcels", "returned", "courier", "label",
]);

/** The response: `meta` from the window, money stripped by whitelist for a non-owner. */
export function buildMexCashResponse(
  rpc: Record<string, unknown> | null,
  win: Pick<InsightsWindow, "from" | "to" | "partial" | "days">,
  isOwner: boolean,
  now: Date = new Date(),
): Record<string, unknown> {
  const body: Record<string, unknown> = { ...(rpc ?? {}) };
  const rpcMeta = body.meta && typeof body.meta === "object" ? (body.meta as Record<string, unknown>) : {};
  body.meta = {
    ...rpcMeta,
    from: win.from,
    to: win.to,
    partial: win.partial,
    days: win.days,
    generated_at: now.toISOString(),
    money: isOwner,
  };
  return isOwner ? body : stripInsightsMoney(body, MEX_CASH_NON_MONEY_KEYS);
}
