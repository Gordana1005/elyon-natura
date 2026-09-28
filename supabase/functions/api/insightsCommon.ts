// ============================================================================
// Insights foundation — the pure half shared by every /insights endpoint
// (owner rules 2026-09-28; SQL: migration 20260940000000_insights_foundation).
//
// Dependency-free on purpose (no Deno globals, no URL imports): vitest runs
// insightsCommon.test.ts against this file in Node, and index.ts imports it.
//
//   insightsWindows()        the Skopje windows (overview.ts overviewWindows —
//                            ONE definition of where a day starts and ends)
//   insightsAccess()         owner → money · admin/manager → counts · else 403
//   stripInsightsMoney()     the non-owner view: a WHITELIST of non-money keys,
//                            so a money field a later migration adds is dropped
//                            by default; *_mkd / *_eur never pass, even when
//                            listed. Money keys are ABSENT, never 0.
//   buildCohortResponse()    GET /api/insights/cohort (+ Overview "cohort")
//   overlayFreshness()       swap one feed's freshness entry (collabBox)
//   cohortOrderBucket() / cohortOrderSaleAt()
//                            TS twins of cohort_order_bucket() and the cohort
//                            sale day (verify-insights-ties.mjs replays them
//                            over live rows)
//   cohortBucketOrFilter() / cohortSaleWindowOrFilter() / COHORT_UNIVERSE_OR
//                            their PostgREST twins for GET /orders
//                            ?cohort_bucket&sold_from&sold_to
// CHANGE A RULE HERE → change it in the migration too (and vice versa).
// ============================================================================

import { overviewWindows, parseCsvParam } from "./overview.ts";
import type { CsvResult, OverviewWindow } from "./overview.ts";

export type { OverviewWindow as InsightsWindow } from "./overview.ts";

/** The four sale sources (owner rules 2026-09-28). */
export const INSIGHTS_SOURCES = ["altercpa", "elyon_crm", "web", "teleshop_other"] as const;
export type InsightsSource = (typeof INSIGHTS_SOURCES)[number];

/** orders.sale_source values that make up each source's ORDER part — the
 *  drill link's sale_source param. web orders live in web_orders (not
 *  orders); 'web' here only ever matches CRM-entered web orders (0 today). */
export const SOURCE_SALE_SOURCES: Record<InsightsSource, string[]> = {
  altercpa: ["altercpa", "affiliate"],
  elyon_crm: ["elyon_crm"],
  web: ["web"],
  teleshop_other: ["collabbox", "legacy"],
};

/** Skopje windows for every /insights tab: ?from&to&compare, bare dates are
 *  Skopje days, the previous period is the same length and ends the day
 *  before `from` (cut at the elapsed time when `to` is today). */
export const insightsWindows = overviewWindows;

// ── access ──────────────────────────────────────────────────────────────────

export type InsightsAccess = "owner" | "counts" | "forbidden";

/** Money is owners-only (public.is_business_owner — no admin bypass). A
 *  non-owner admin/manager gets the same payload with every money key absent;
 *  anyone else is refused. */
export function insightsAccess(isOwner: boolean, isAdminOrManager: boolean): InsightsAccess {
  if (isOwner) return "owner";
  if (isAdminOrManager) return "counts";
  return "forbidden";
}

/** ?source=altercpa,web → validated sources; empty/absent/"all" → all four. */
export function parseSourcesParam(raw: string | null): CsvResult {
  const r = parseCsvParam(raw, INSIGHTS_SOURCES);
  if (!r.ok) return r;
  return { ok: true, values: r.values.length ? r.values : [...INSIGHTS_SOURCES] };
}

// ── the money strip (non-owners) ────────────────────────────────────────────

/** A money key at any depth, whatever list it appears in. */
export const MONEY_KEY_RE = /(_eur|_mkd)$/;

/** Every key a non-owner may receive from GET /api/insights/cohort. */
export const COHORT_NON_MONEY_KEYS: ReadonlySet<string> = new Set([
  // envelope
  "meta", "from", "to", "prev_from", "prev_to", "prev_to_end", "generated_at", "money", "clock",
  "sources", "granularity", "partial", "days",
  "total", "buckets", "outside", "by_source", "leads_in", "cash_flow", "prev", "spark", "quality",
  // bucket / split objects
  "key", "count", "orders", "web", "mex_only", "drill", "splits", "kind",
  // leads_in
  "came_in", "became_sales", "cancelled", "trashed", "open", "conversion", "other", "disposition",
  // cash_flow (counts only)
  "parcels", "card_orders",
  // spark
  "d",
]);

function stripWith(v: unknown, allowed: ReadonlySet<string>): unknown {
  if (Array.isArray(v)) return v.map((x) => stripWith(x, allowed));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (!allowed.has(k) || MONEY_KEY_RE.test(k)) continue;
      out[k] = stripWith(x, allowed);
    }
    return out;
  }
  return v;
}

/** The payload without a single money figure: only whitelisted keys survive
 *  (at any depth) and no *_mkd / *_eur key ever does. `meta.money` = false.
 *  Pass a tab's own whitelist for other payloads (defaults to the cohort's). */
export function stripInsightsMoney(
  payload: Record<string, unknown>,
  allowed: ReadonlySet<string> = COHORT_NON_MONEY_KEYS,
): Record<string, unknown> {
  const withMeta = new Set(allowed);
  withMeta.add("meta");
  withMeta.add("money");
  const out = stripWith(payload, withMeta) as Record<string, unknown>;
  const meta = out.meta && typeof out.meta === "object" ? (out.meta as Record<string, unknown>) : {};
  out.meta = { ...meta, money: false };
  return out;
}

/** GET /api/insights/cohort: the RPC body with `meta` taken from the window
 *  (so a partial-day comparison reports its real cut), money stripped for a
 *  non-owner. */
export function buildCohortResponse(
  rpc: Record<string, unknown> | null,
  win: OverviewWindow,
  isOwner: boolean,
  now: Date = new Date(),
): Record<string, unknown> {
  const body: Record<string, unknown> = { ...(rpc ?? {}) };
  const rpcMeta = body.meta && typeof body.meta === "object" ? (body.meta as Record<string, unknown>) : {};
  body.meta = {
    ...rpcMeta,
    from: win.from,
    to: win.to,
    prev_from: win.prev?.from ?? null,
    prev_to: win.prev?.to ?? null,
    prev_to_end: win.prev?.toEndIso ?? null,
    partial: win.partial,
    days: win.days,
    generated_at: now.toISOString(),
    money: isOwner,
    clock: "sale",
  };
  return isOwner ? body : stripInsightsMoney(body);
}

/** Replace the freshness entry of `entry.feed` (append it when missing).
 *  Anything malformed leaves the array as it was. */
export function overlayFreshness(freshness: unknown, entry: unknown): unknown {
  if (!Array.isArray(freshness)) return freshness;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return freshness;
  const feed = (entry as Record<string, unknown>).feed;
  if (typeof feed !== "string" || !feed) return freshness;
  let hit = false;
  const out = freshness.map((e) => {
    if (e && typeof e === "object" && (e as Record<string, unknown>).feed === feed) { hit = true; return entry; }
    return e;
  });
  if (!hit) out.push(entry);
  return out;
}

// ── the cohort's order rules (twins of the migration) ───────────────────────

/** The eight buckets that sum to the total, in display order. */
export const COHORT_BUCKETS = [
  "paid", "paid_unproven", "paid_legacy", "courier", "courier_problem", "label", "to_pack", "returned",
] as const;
/** Kept outside the total. */
export const COHORT_OUTSIDE = ["cancelled_after_sale", "replacement"] as const;
export const COHORT_KEYS = [...COHORT_BUCKETS, ...COHORT_OUTSIDE] as const;
export type CohortKey = (typeof COHORT_KEYS)[number];

/** ?cohort_bucket=paid,label | total (= the eight in-total buckets). */
export function parseCohortBucketParam(raw: string | null): CsvResult {
  const r = parseCsvParam(raw, [...COHORT_KEYS, "total"]);
  if (!r.ok) return r;
  const values = new Set<string>();
  for (const v of r.values) {
    if (v === "total") COHORT_BUCKETS.forEach((b) => values.add(b));
    else values.add(v);
  }
  return { ok: true, values: COHORT_KEYS.filter((k) => values.has(k)) };
}

export interface CohortOrderRow {
  id?: string;
  status: string | null;
  price: number | string | null;
  sold_at: string | null;
  confirmed_at?: string | null;
  created_at?: string | null;
  paid_basis: string | null;
  source_type: string | null;
  sale_source_detail: string | null;
  mex_tracking_id: string | null;
  mex_status_id: number | null;
  mex_cod_mkd: number | null;
  mex_delivered_at: string | null;
}

const num = (v: number | string | null | undefined): number | null =>
  v === null || v === undefined || v === "" ? null : Number(v);

/** TS twin of public.cohort_order_bucket(): MEX-first; NULL = not a sale. */
export function cohortOrderBucket(o: CohortOrderRow, webClaimed: boolean): CohortKey | null {
  if (o.sale_source_detail === "disposition") return null;
  const price = num(o.price) ?? 0;
  const cod = num(o.mex_cod_mkd);
  const st = o.mex_status_id;
  const hasParcel = o.mex_tracking_id != null && (st != null || o.mex_delivered_at != null) && !webClaimed;
  if (hasParcel) {
    if (cod != null && cod <= 0) return "replacement";
    if (cod == null && price <= 0) return "replacement";
    if (st === 2 || (st == null && o.mex_delivered_at != null)) return "paid";
    if (st === 7) return "returned";
    if (st === 3 || st === 9 || st === 13) return "courier_problem";
    if (st === 8) return "label";
    return "courier";
  }
  const s = o.status;
  if ((s === "paid" || s === "returned" || s === "shipped" || s === "confirmed") && price <= 0) return "replacement";
  if (s === "paid") {
    const legacy = o.paid_basis === "operator_ruling" || o.paid_basis === "legacy_import" ||
      (o.paid_basis == null && o.source_type === "import");
    return legacy ? "paid_legacy" : "paid_unproven";
  }
  if (s === "returned") return "returned";
  if (s === "shipped") return "courier";
  if (s === "confirmed") return "to_pack";
  if ((s === "cancelled" || s === "trashed") && o.sold_at != null && price > 0) return "cancelled_after_sale";
  return null;
}

/** TS twin of the cohort sale day: sold_at → the AlterCPA ledger's decided_at
 *  (approved | cancel_other; only passed for an order with no sold_at) →
 *  confirmed_at → created_at. */
export function cohortOrderSaleAt(o: CohortOrderRow, ledgerAt: string | null): string | null {
  return o.sold_at ?? ledgerAt ?? o.confirmed_at ?? o.created_at ?? null;
}

// ── the PostgREST twins (GET /orders) ───────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Beyond this the id lists would not fit a URL; the api refuses rather than
 *  list the wrong orders (0–10 ids expected; the stamping cron empties ledger). */
export const COHORT_EXCEPTIONS_MAX = 300;

export interface CohortExceptions {
  web_claimed: string[];
  ledger: { id: string; sale_at: string }[];
}

/** insights_cohort_order_exceptions() → validated lists, or null when the
 *  payload is malformed or too long to put in a filter. */
export function parseCohortExceptions(raw: unknown): CohortExceptions | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.web_claimed) || !Array.isArray(r.ledger)) return null;
  const web = r.web_claimed.filter((x): x is string => typeof x === "string" && UUID_RE.test(x));
  const ledger: { id: string; sale_at: string }[] = [];
  for (const e of r.ledger) {
    if (!e || typeof e !== "object") return null;
    const { id, sale_at } = e as Record<string, unknown>;
    if (typeof id !== "string" || !UUID_RE.test(id) || typeof sale_at !== "string" || Number.isNaN(Date.parse(sale_at))) return null;
    ledger.push({ id, sale_at });
  }
  if (web.length !== r.web_claimed.length) return null;
  if (web.length + ledger.length > COHORT_EXCEPTIONS_MAX) return null;
  return { web_claimed: web, ledger };
}

/** Disposition rows are never sales — every cohort drill carries this. */
export const COHORT_UNIVERSE_OR = "sale_source_detail.is.null,sale_source_detail.neq.disposition";

/**
 * cohort_bucket=a,b → ONE PostgREST `or` expression selecting exactly the
 * orders cohort_order_bucket() puts in those buckets. `webClaimed`: order ids
 * whose parcel a live web order claims (judged without it). Always combine
 * with COHORT_UNIVERSE_OR.
 */
export function cohortBucketOrFilter(keys: readonly string[], webClaimed: readonly string[] = []): string | null {
  const w = webClaimed.filter((x) => UUID_RE.test(x));
  const hp = [
    "mex_tracking_id.not.is.null",
    "or(mex_status_id.not.is.null,mex_delivered_at.not.is.null)",
    ...(w.length ? [`id.not.in.(${w.join(",")})`] : []),
  ].join(",");
  const nhp = `or(mex_tracking_id.is.null,and(mex_status_id.is.null,mex_delivered_at.is.null)${w.length ? `,id.in.(${w.join(",")})` : ""})`;
  const notRepl = "or(mex_cod_mkd.gt.0,and(mex_cod_mkd.is.null,price.gt.0))";
  const repl = "or(mex_cod_mkd.lte.0,and(mex_cod_mkd.is.null,or(price.is.null,price.lte.0)))";
  const legacy = "or(paid_basis.in.(operator_ruling,legacy_import),and(paid_basis.is.null,source_type.eq.import))";
  const notLegacy = "or(paid_basis.not.in.(operator_ruling,legacy_import),and(paid_basis.is.null,or(source_type.is.null,source_type.neq.import)))";
  const parcel = (status: string) => `and(${hp},${notRepl},${status})`;
  const crm = (...conds: string[]) => `and(${nhp},${conds.join(",")})`;
  const CLAUSES: Record<CohortKey, string[]> = {
    paid: [parcel("or(mex_status_id.eq.2,and(mex_status_id.is.null,mex_delivered_at.not.is.null))")],
    returned: [parcel("mex_status_id.eq.7"), crm("status.eq.returned", "price.gt.0")],
    courier_problem: [parcel("mex_status_id.in.(3,9,13)")],
    label: [parcel("mex_status_id.eq.8")],
    courier: [parcel("mex_status_id.not.in.(2,3,7,8,9,13)"), crm("status.eq.shipped", "price.gt.0")],
    to_pack: [crm("status.eq.confirmed", "price.gt.0")],
    paid_unproven: [crm("status.eq.paid", "price.gt.0", notLegacy)],
    paid_legacy: [crm("status.eq.paid", "price.gt.0", legacy)],
    cancelled_after_sale: [crm("status.in.(cancelled,trashed)", "sold_at.not.is.null", "price.gt.0")],
    replacement: [`and(${hp},${repl})`, crm("status.in.(paid,returned,shipped,confirmed)", "or(price.is.null,price.lte.0)")],
  };
  const out: string[] = [];
  for (const k of keys) for (const c of CLAUSES[k as CohortKey] ?? []) if (!out.includes(c)) out.push(c);
  return out.length ? out.join(",") : null;
}

/** The cohort sale day inside [fromIso, toEndIso] as a PostgREST `or`
 *  expression — the twin of coalesce(sold_at, ledger decided_at, confirmed_at,
 *  created_at). `ledger`: the orders (sold_at NULL) dated by the ledger. */
export function cohortSaleWindowOrFilter(
  fromIso: string,
  toEndIso: string,
  ledger: readonly { id: string; sale_at: string }[] = [],
): string {
  const L = ledger.filter((e) => UUID_RE.test(e.id));
  const notL = L.length ? `,id.not.in.(${L.map((e) => e.id).join(",")})` : "";
  const f = Date.parse(fromIso), t = Date.parse(toEndIso);
  const inWin = L.filter((e) => { const x = Date.parse(e.sale_at); return x >= f && x <= t; });
  return [
    `and(sold_at.gte.${fromIso},sold_at.lte.${toEndIso})`,
    `and(sold_at.is.null${notL},confirmed_at.gte.${fromIso},confirmed_at.lte.${toEndIso})`,
    `and(sold_at.is.null${notL},confirmed_at.is.null,created_at.gte.${fromIso},created_at.lte.${toEndIso})`,
    ...(inWin.length ? [`id.in.(${inWin.map((e) => e.id).join(",")})`] : []),
  ].join(",");
}
