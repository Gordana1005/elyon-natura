// ============================================================================
// Insights → Продажби (Sales) — the pure half of GET /api/insights/sales
// (migration 20260941000100_insights_sales).
//
// Dependency-free on purpose (no Deno globals, no URL imports): vitest runs
// insightsSales.test.ts against this file in Node, and index.ts imports it.
//
//   SALES_PARTS / parseSalesPart()  ?part=core|detail (core by default)
//   SALES_NON_MONEY_KEYS            every key a non-owner admin/manager may
//                                   receive — a WHITELIST, so a money field a
//                                   later migration adds is dropped by default
//   buildSalesResponse()            the RPC body (+ the previous period's
//                                   summary for `core`), `meta` from the ONE
//                                   Skopje window every tab uses, money
//                                   stripped for a non-owner
//
// The numbers are THE sale cohort's (insights_sale_rows): the core part's
// total, buckets and sources equal GET /api/insights/cohort's for the same
// window by construction (scripts/verify-tab-sales.mjs proves it live).
// ============================================================================

import { stripInsightsMoney } from "./insightsCommon.ts";
import type { InsightsWindow } from "./insightsCommon.ts";

/** core = the cohort block, trend, MEX channels, weekday × hour, quality ·
 *  detail = products, cities, buyers, basket (the heavy tables). */
export const SALES_PARTS = ["core", "detail"] as const;
export type SalesPart = (typeof SALES_PARTS)[number];

/** Rows the products / cities tables return before folding the rest into "others". */
export const SALES_TOP_N = 40;

/** ?part=… → the part, or null when it is not one we serve. Absent = core. */
export function parseSalesPart(raw: string | null | undefined): SalesPart | null {
  const v = (raw ?? "").trim().toLowerCase();
  if (!v) return "core";
  return (SALES_PARTS as readonly string[]).includes(v) ? (v as SalesPart) : null;
}

/** Every key a non-owner may receive from GET /api/insights/sales (any depth).
 *  A money key (*_mkd / *_eur) never passes, even if listed. */
export const SALES_NON_MONEY_KEYS: ReadonlySet<string> = new Set([
  // envelope
  "meta", "from", "to", "prev_from", "prev_to", "prev_to_end", "partial", "days", "generated_at", "money",
  "clock", "part", "granularity", "top_n",
  "total", "buckets", "outside", "by_source", "prev", "trend", "channels", "timing", "quality",
  "products", "cities", "customers", "basket",
  // cohort parts / splits (booked = collabBox bookings awaiting their parcel, 20260942001900)
  "key", "count", "orders", "web", "mex_only", "booked", "drill", "splits", "kind",
  // trend
  "points", "d",
  // channels
  "account", "series", "paid", "courier", "to_pack", "returned",
  // timing
  "cells", "dow", "hour", "timed", "untimed", "weekdays",
  // products
  "rows", "others", "non_product", "no_product", "summary", "name", "catalogue", "sales", "units", "lines",
  "auto", "products", "unmapped_products", "unmapped_units", "unmapped_sales", "bad_qty_lines",
  // cities
  "name_lat", "known", "spellings", "places", "unknown", "unknown_places", "unknown_places_count",
  // buyers
  "buyers", "new", "returning", "repeat", "cross_source", "sales_new", "sales_returning", "no_phone",
  "history_from",
  // basket
  "dist", "with_units",
]);

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** The previous period for the header's delta: total, buckets, per-source
 *  totals — nothing else (null when there is no comparison or it failed). */
export function prevOf(summary: unknown): Record<string, unknown> | null {
  if (!isObj(summary) || !isObj(summary.total)) return null;
  return {
    total: summary.total,
    buckets: Array.isArray(summary.buckets) ? summary.buckets : [],
    by_source: Array.isArray(summary.by_source) ? summary.by_source : [],
  };
}

/**
 * GET /api/insights/sales: the RPC body with `meta` taken from the window (so
 * a partial-day comparison reports its real cut) and, for `core`, the previous
 * period's summary under `prev`. A non-owner gets the same payload with every
 * money key ABSENT (never 0).
 */
export function buildSalesResponse(
  rpc: Record<string, unknown> | null,
  prevSummary: unknown,
  win: InsightsWindow,
  isOwner: boolean,
  part: SalesPart,
  now: Date = new Date(),
): Record<string, unknown> {
  const body: Record<string, unknown> = { ...(rpc ?? {}) };
  const rpcMeta = isObj(body.meta) ? body.meta : {};
  const prev = part === "core" && win.prev ? prevOf(prevSummary) : null;
  body.meta = {
    ...rpcMeta,
    from: win.from,
    to: win.to,
    prev_from: prev ? win.prev!.from : null,
    prev_to: prev ? win.prev!.to : null,
    prev_to_end: prev ? win.prev!.toEndIso : null,
    partial: win.partial,
    days: win.days,
    generated_at: now.toISOString(),
    money: isOwner,
    clock: "sale",
    part,
  };
  if (part === "core") body.prev = prev;
  return isOwner ? body : stripInsightsMoney(body, SALES_NON_MONEY_KEYS);
}
