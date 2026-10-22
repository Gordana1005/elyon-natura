// ============================================================================
// /orders (Нарачки) — the list's filters, pure (Phase 11 A, 01.10.2026).
//
// Dependency-free on purpose (no Deno globals, no URL imports): vitest runs
// ordersList.test.ts against this file in Node, and index.ts imports it. The
// only imports are the two sibling modules that are dependency-free as well.
//
// GET /orders keeps every parameter it had (the /calls queue, the Assigner and
// every Insights drill-down still send them). This module adds the list's own:
//
//   view      orders | leads | cancelled | trashed | all — the status chips.
//             "Нарачки" = only real orders (confirmed · shipped · delivered ·
//             paid · returned; packed is a substate of confirmed), never a 0 ден
//             call-outcome record (sale_source_detail = 'disposition').
//   day_from / day_to   Skopje calendar days, inclusive. Each row is dated by
//             ITS status: a sale by the sale clock (sold_at → confirmed_at →
//             created_at, the Insights cohort's), a cancel by cancelled_at, a
//             trash by trashed_at, an open lead by created_at — so the "Сите"
//             count is exactly the sum of the other four.
//   dept      csv of the six departments → IC.cohortSourceOrFilter, the
//             PostgREST twin of cohort_order_source(…, dept_override).
//   seller    sales_people.id → sold_by_person_id.
//   mex       csv of MEX parcel groups (at_mex 8 · courier 1/3/4/9/10 ·
//             delivered 2 · returned 7 · rejected 13 · no_parcel).
//   source    csv of the real source_type values (altercpa · import · manual).
//   agent_id  a uuid, or `none` (unassigned).
//   state     csv of STATE_KEYS — the status filter (owner 15.10.2026: "status is
//             status"): every order status, plus the MEX parcel sub-states inside
//             Потврдена and Испратена, the only two statuses where MEX adds
//             anything (the Overview cohort's parts: Во магацин за пакување ·
//             Спакувано · Кај курирот · проблем). With view=all (or no view).
//   search    a phone (≥ 8 digits, any spacing) matches by its LAST 8 digits;
//             a MEX tracking id matches exactly; anything else is the old
//             substring search over id / name / phone / product.
//   products  csv of catalogue product ids (≤ 50, owner 22.10.2026: "одбереме
//             Urofix и да ни ги покаже сите порачки кои содржат Urofix") → the
//             orders holding one of them in their lines (order_products — the
//             line's product, else a reviewed alias; gifts too), through the
//             inner embed `op:order_products!inner()` that orderSelect() adds to
//             every select of the list. NOT `product` — that is the Insights
//             drill's exact orders.product_name.
//
// The filters come out as a list of builder calls (`Op`), which index.ts
// replays onto a supabase-js query: the SAME ops feed the page, the per-chip
// counts (GET /orders/view-counts) and the export, so they cannot drift.
// ============================================================================

import { isUuid, isValidYmd, skopjeDayEndIso, skopjeMidnightIso } from "./overview.ts";
import { cohortSourceOrFilter, INSIGHTS_SOURCES } from "./insightsCommon.ts";

// ── vocabularies ────────────────────────────────────────────────────────────

export const ORDER_VIEWS = ["orders", "leads", "cancelled", "trashed", "all"] as const;
export type OrderView = (typeof ORDER_VIEWS)[number];
/** The four views that partition every order ("all" = their sum). */
export const COUNTED_VIEWS = ["orders", "leads", "cancelled", "trashed"] as const;
export type CountedView = (typeof COUNTED_VIEWS)[number];

export const SALE_STATUSES = ["confirmed", "shipped", "delivered", "paid", "returned"] as const;
export const LEAD_STATUSES = ["pending", "take", "call_again", "duplicated"] as const;
export const VIEW_STATUSES: Record<CountedView, readonly string[]> = {
  orders: SALE_STATUSES,
  leads: LEAD_STATUSES,
  cancelled: ["cancelled"],
  trashed: ["trashed"],
};
const ALL_STATUSES: readonly string[] = [...SALE_STATUSES, ...LEAD_STATUSES, "cancelled", "trashed"];

/** MEX parcel status groups (mex_parcels.status_id). */
export const MEX_GROUPS = {
  at_mex: [8],               // Shipment created — the label exists, MEX has not picked it up
  courier: [1, 3, 4, 9, 10], // In delivery · Problematic · Picked up · Delivery attempted · In transit
  delivered: [2],
  returned: [7],
  rejected: [13],
} as const;
export const MEX_GROUP_KEYS = ["at_mex", "courier", "delivered", "returned", "rejected", "no_parcel"] as const;
export type MexGroupKey = (typeof MEX_GROUP_KEYS)[number];

/** The product filter: at most this many products, and the select's inner embed it filters through. */
export const MAX_PRODUCTS = 50;
export const PRODUCT_EMBED = "op:order_products!inner()";

/** The source_type values that exist in MK (import 338k · altercpa 10k · manual 9k). */
export const LIST_SOURCE_TYPES = ["altercpa", "import", "manual"] as const;

/** Never a real order: the 0 ден records a call outcome leaves behind. */
export const NOT_DISPOSITION = "or(sale_source_detail.is.null,sale_source_detail.neq.disposition)";
/** "Сите" / a status pick: a disposition record never shows under a SALE status (it does under a
 *  cancel / trash, as in those views) — so the list is exactly the sum of the four views. */
export const SALE_NOT_DISPOSITION =
  `status.not.in.(${SALE_STATUSES.join(",")}),sale_source_detail.is.null,sale_source_detail.neq.disposition`;

/** The status filter's vocabulary (owner 15.10.2026): every order status, in the list's order, plus
 *  the MEX sub-states of Потврдена and Испратена (`<status>.<part>`). A parent covers its children. */
export const STATE_KEYS = [
  "pending", "take", "call_again", "duplicated",
  "confirmed", "confirmed.no_parcel", "confirmed.packed",
  "shipped", "shipped.courier", "shipped.problem",
  "delivered", "paid", "returned", "cancelled", "trashed",
] as const;
export type StateKey = (typeof STATE_KEYS)[number];
/** The sub-states, as PostgREST terms. MEX 8 = the label exists, not picked up (за пакување, never
 *  shipped); 1 · 4 · 10 = with the courier; 3 · 9 · 13 = a problem, 13 "Одбиена" included — the
 *  customer refused, the parcel is on its way back and becomes MEX 7 (returned) when MEX books it. */
export const STATE_SUB_TERMS: Record<Extract<StateKey, `${string}.${string}`>, string> = {
  "confirmed.no_parcel": "and(status.eq.confirmed,mex_tracking_id.is.null)",
  "confirmed.packed": "and(status.eq.confirmed,mex_status_id.eq.8)",
  "shipped.courier": "and(status.eq.shipped,mex_status_id.in.(1,4,10))",
  "shipped.problem": "and(status.eq.shipped,mex_status_id.in.(3,9,13))",
};

/** A MEX tracking id as the courier writes it: 002-9103-123456/2026. */
const TRACKING_RE = /^\d{3}-\d{4}-\d{1,9}\/\d{4}$/;
/** What a typed phone may contain besides digits. */
const PHONE_CHARS_RE = /^\+?[\d\s\-./()]+$/;

// ── search ──────────────────────────────────────────────────────────────────

export type SearchSpec =
  | { kind: "phone"; last8: string }
  | { kind: "tracking"; id: string }
  | { kind: "text"; text: string };

/** The last 8 digits of something that LOOKS like a phone (8–15 digits, any
 *  spacing, dashes, dots, brackets, a leading +), else null. "070 123 456",
 *  "+389 70 123 456" and "70123456" all give "70123456". A 5–6 digit order
 *  number is not a phone. */
export function phoneLast8(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!s || !PHONE_CHARS_RE.test(s)) return null;
  const d = s.replace(/\D/g, "");
  if (d.length < 8 || d.length > 15) return null;
  return d.slice(-8);
}

/** The substring search's safe text — the same characters index.ts's
 *  sanitizeSearch() strips (PostgREST `or` syntax and LIKE wildcards). */
export function sanitizeSearchText(s: string): string {
  return (s || "").replace(/[%_\\,().]/g, "").trim();
}

export function parseSearch(raw: string | null | undefined): SearchSpec | null {
  const s = (raw ?? "").trim().slice(0, 100);
  if (!s) return null;
  if (TRACKING_RE.test(s)) return { kind: "tracking", id: s };
  const last8 = phoneLast8(s);
  if (last8) return { kind: "phone", last8 };
  const text = sanitizeSearchText(s);
  return text ? { kind: "text", text } : null;
}

// ── parameters ──────────────────────────────────────────────────────────────

export interface OrdersListParams {
  /** The status chip; null = not asked (the legacy callers). */
  view: OrderView | null;
  /** Legacy ?status=a,b (the /calls queue, the Assigner, the MEX CSV). */
  statuses: string[] | null;
  dayFrom: string | null;
  dayTo: string | null;
  departments: string[];
  sellerId: string | null;
  mexGroups: MexGroupKey[];
  sources: string[];
  agent: { kind: "id"; id: string } | { kind: "none" } | null;
  search: SearchSpec | null;
  /** The status filter (STATE_KEYS); [] = every status. Only with view all / none. */
  states: StateKey[];
  /** Catalogue product ids (lower case, distinct); [] = every order. */
  productIds: string[];
}

export type ParseResult = { ok: true; value: OrdersListParams } | { ok: false; error: string };

/** A csv param → distinct values, each in `allowed`; "", absent or "all" → []. */
function csv(raw: string | null, allowed: readonly string[]): { ok: true; values: string[] } | { ok: false; bad: string } {
  if (raw == null || raw.trim() === "" || raw.trim() === "all") return { ok: true, values: [] };
  const values = [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
  for (const v of values) if (!allowed.includes(v)) return { ok: false, bad: v };
  return { ok: true, values };
}

/** Reads and validates the list's parameters. Anything malformed → an error
 *  (400), never a silently wider list. */
export function parseOrdersListParams(sp: URLSearchParams): ParseResult {
  const rawView = sp.get("view");
  let view: OrderView | null = null;
  if (rawView != null && rawView !== "") {
    if (!(ORDER_VIEWS as readonly string[]).includes(rawView)) return { ok: false, error: `Invalid view: ${rawView}` };
    view = rawView as OrderView;
  }

  let statuses: string[] | null = null;
  const rawStatus = sp.get("status");
  if (rawStatus && rawStatus !== "all") {
    const st = csv(rawStatus, ALL_STATUSES);
    if (!st.ok) return { ok: false, error: `Invalid status: ${st.bad}` };
    statuses = st.values;
  }

  const dayFrom = sp.get("day_from") || null;
  const dayTo = sp.get("day_to") || null;
  for (const d of [dayFrom, dayTo]) {
    if (d && !isValidYmd(d)) return { ok: false, error: "day_from / day_to must be YYYY-MM-DD (Skopje days)" };
  }
  if (dayFrom && dayTo && dayFrom > dayTo) return { ok: false, error: "day_from is after day_to" };

  const dept = csv(sp.get("dept"), INSIGHTS_SOURCES);
  if (!dept.ok) return { ok: false, error: `Invalid dept: ${dept.bad}` };

  const seller = sp.get("seller") || null;
  if (seller && !isUuid(seller)) return { ok: false, error: "Invalid seller" };

  const mex = csv(sp.get("mex"), MEX_GROUP_KEYS);
  if (!mex.ok) return { ok: false, error: `Invalid mex: ${mex.bad}` };

  const src = csv(sp.get("source"), LIST_SOURCE_TYPES);
  if (!src.ok) return { ok: false, error: `Invalid source: ${src.bad}` };

  const rawAgent = sp.get("agent_id");
  let agent: OrdersListParams["agent"] = null;
  if (rawAgent && rawAgent !== "all") {
    if (rawAgent === "none") agent = { kind: "none" };
    else if (isUuid(rawAgent)) agent = { kind: "id", id: rawAgent };
    else return { ok: false, error: "Invalid agent_id" };
  }

  const productIds: string[] = [];
  for (const raw of (sp.get("products") ?? "").split(",")) {
    const v = raw.trim().toLowerCase();
    if (!v) continue;
    if (!isUuid(v)) return { ok: false, error: "Invalid products" };
    if (!productIds.includes(v)) productIds.push(v);
  }
  if (productIds.length > MAX_PRODUCTS) return { ok: false, error: "Too many products" };

  const state = csv(sp.get("state"), STATE_KEYS);
  if (!state.ok) return { ok: false, error: `Invalid state: ${state.bad}` };
  // A status pick is its own status filter: next to a view chip it would silently narrow twice.
  if (state.values.length && view && view !== "all") return { ok: false, error: "state goes with view=all only" };

  return {
    ok: true,
    value: {
      view, statuses, dayFrom, dayTo,
      departments: dept.values,
      sellerId: seller,
      mexGroups: mex.values as MexGroupKey[],
      sources: src.values,
      agent,
      search: parseSearch(sp.get("search")),
      states: STATE_KEYS.filter((k) => state.values.includes(k)),
      productIds,
    },
  };
}

/** True when the list is narrowed at all (then the total is an exact count). */
export function isNarrowed(p: OrdersListParams): boolean {
  return Boolean(
    (p.view && p.view !== "all") || p.statuses?.length || p.dayFrom || p.dayTo || p.departments.length ||
    p.sellerId || p.mexGroups.length || p.sources.length || p.agent || p.search || stateOps(p.states).length ||
    p.productIds.length,
  );
}

// ── the status pick ─────────────────────────────────────────────────────────

const statusOfState = (k: string) => k.split(".")[0];

/** The pick in STATE_KEYS order, unknown keys dropped, a child dropped when its parent is picked. */
export function normalizeStates(states: readonly string[]): StateKey[] {
  const set = new Set(states);
  return STATE_KEYS.filter((k) => set.has(k) && !(k.includes(".") && set.has(statusOfState(k))));
}

/** The pick as builder calls: plain statuses → one eq / in (index-friendly); with a sub-state →
 *  ONE `or` of the plain statuses and the sub-state terms. Every status picked = no filter. */
export function stateOps(states: readonly string[]): Op[] {
  const set = normalizeStates(states);
  const plain = set.filter((k) => !k.includes("."));
  const subs = set.filter((k): k is keyof typeof STATE_SUB_TERMS => k.includes("."));
  if (!subs.length) {
    if (!plain.length || plain.length >= ALL_STATUSES.length) return [];
    return [plain.length === 1 ? { m: "eq", col: "status", v: plain[0] } : { m: "in", col: "status", v: plain }];
  }
  const parts: string[] = [];
  if (plain.length) parts.push(plain.length === 1 ? `status.eq.${plain[0]}` : `status.in.(${plain.join(",")})`);
  for (const k of subs) parts.push(STATE_SUB_TERMS[k]);
  return [{ m: "or", v: parts.join(",") }];
}

/** The views (status families) a pick touches, in COUNTED_VIEWS order. */
export function stateViews(states: readonly string[]): CountedView[] {
  const statuses = new Set(normalizeStates(states).map(statusOfState));
  return COUNTED_VIEWS.filter((v) => VIEW_STATUSES[v].some((s) => statuses.has(s)));
}

/** The one view a narrowing pick lies wholly in (its clock dates and sorts the list), else null. */
function singleStateView(states: readonly string[]): CountedView | null {
  if (!stateOps(states).length) return null;
  const views = stateViews(states);
  return views.length === 1 ? views[0] : null;
}

// ── the builder calls ───────────────────────────────────────────────────────

/** One supabase-js filter call. index.ts replays them (applyOps). */
export type Op =
  | { m: "in"; col: string; v: readonly (string | number)[] }
  | { m: "eq"; col: string; v: string | number }
  | { m: "is"; col: string; v: null }
  | { m: "like"; col: string; v: string }
  | { m: "ilike"; col: string; v: string }
  | { m: "gte"; col: string; v: string }
  | { m: "lte"; col: string; v: string }
  | { m: "or"; v: string }
  | { m: "not"; col: string; op: string; v: string | null };

/** Anything with the supabase-js filter methods (a real query, the recorder). */
// deno-lint-ignore no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Builder = any;

/** Replays the ops onto a query builder; returns the builder. */
export function applyOps<Q extends Builder>(q: Q, ops: readonly Op[]): Q {
  let out: Builder = q;
  for (const o of ops) {
    switch (o.m) {
      case "or": out = out.or(o.v); break;
      case "not": out = out.not(o.col, o.op, o.v); break;
      default: out = out[o.m](o.col, o.v);
    }
  }
  return out as Q;
}

/**
 * A stand-in for the supabase-js query that only RECORDS filter calls. The
 * GET /orders handler builds its (long, legacy + drill) filter chain on this,
 * then replays the same ops onto the page query and onto each count query.
 */
export function filterRecorder() {
  const ops: Op[] = [];
  const r = {
    ops,
    in(col: string, v: readonly (string | number)[]) { ops.push({ m: "in", col, v: [...v] }); return r; },
    eq(col: string, v: string | number) { ops.push({ m: "eq", col, v }); return r; },
    is(col: string, v: null) { ops.push({ m: "is", col, v }); return r; },
    like(col: string, v: string) { ops.push({ m: "like", col, v }); return r; },
    ilike(col: string, v: string) { ops.push({ m: "ilike", col, v }); return r; },
    gte(col: string, v: string) { ops.push({ m: "gte", col, v }); return r; },
    lte(col: string, v: string) { ops.push({ m: "lte", col, v }); return r; },
    or(v: string) { ops.push({ m: "or", v }); return r; },
    not(col: string, op: string, v: string | null) { ops.push({ m: "not", col, op, v }); return r; },
  };
  return r;
}

/** A column inside the day window, as PostgREST `and` parts (open ends allowed). */
function rangeParts(col: string, fromIso: string | null, toIso: string | null): string[] {
  const out: string[] = [];
  if (fromIso) out.push(`${col}.gte.${fromIso}`);
  if (toIso) out.push(`${col}.lte.${toIso}`);
  return out;
}

/** The sale clock inside the window: sold_at, else confirmed_at, else created_at
 *  (the Insights cohort's sale day; the AlterCPA-ledger step is left out — 42
 *  of 7.597 sales in 30 days had no sold_at, and the stamping cron runs every
 *  5 minutes). */
export function saleClockOr(fromIso: string | null, toIso: string | null): string {
  const and = (parts: string[]) => `and(${parts.join(",")})`;
  return [
    and(rangeParts("sold_at", fromIso, toIso)),
    and(["sold_at.is.null", ...rangeParts("confirmed_at", fromIso, toIso)]),
    and(["sold_at.is.null", "confirmed_at.is.null", ...rangeParts("created_at", fromIso, toIso)]),
  ].join(",");
}

/** Each view's own day column(s) inside the window, as ONE PostgREST term. */
function viewDayTerm(view: CountedView, fromIso: string | null, toIso: string | null): string {
  switch (view) {
    case "orders": return `or(${saleClockOr(fromIso, toIso)})`;
    case "leads": return `and(${rangeParts("created_at", fromIso, toIso).join(",")})`;
    case "cancelled": return `and(${rangeParts("cancelled_at", fromIso, toIso).join(",")})`;
    case "trashed": return `and(${rangeParts("trashed_at", fromIso, toIso).join(",")})`;
  }
}

/** The window over EVERY status (or the families a pick touches): each row by its own status's clock. */
export function anyStatusDayOr(fromIso: string | null, toIso: string | null, views: readonly CountedView[] = COUNTED_VIEWS): string {
  return views.map((v) => {
    const st = VIEW_STATUSES[v];
    const guard = st.length === 1 ? `status.eq.${st[0]}` : `status.in.(${st.join(",")})`;
    return `and(${guard},${viewDayTerm(v, fromIso, toIso)})`;
  }).join(",");
}

/** The Skopje window as UTC instants (open ends → null). */
export function dayWindow(p: Pick<OrdersListParams, "dayFrom" | "dayTo">): { fromIso: string | null; toIso: string | null } {
  return {
    fromIso: p.dayFrom ? skopjeMidnightIso(p.dayFrom) : null,
    toIso: p.dayTo ? skopjeDayEndIso(p.dayTo) : null,
  };
}

/** The filters that do NOT depend on the status chip: agent, source,
 *  department, seller, MEX group, search, products (the last one filters the
 *  `op` embed — every select of the list must go through orderSelect()). */
export function baseOps(p: OrdersListParams): Op[] {
  const ops: Op[] = [];
  if (p.agent?.kind === "id") ops.push({ m: "eq", col: "assigned_agent_id", v: p.agent.id });
  if (p.agent?.kind === "none") ops.push({ m: "is", col: "assigned_agent_id", v: null });
  if (p.sources.length === 1) ops.push({ m: "eq", col: "source_type", v: p.sources[0] });
  else if (p.sources.length > 1) ops.push({ m: "in", col: "source_type", v: p.sources });
  const dept = cohortSourceOrFilter(p.departments);
  if (dept) ops.push({ m: "or", v: dept });
  if (p.sellerId) ops.push({ m: "eq", col: "sold_by_person_id", v: p.sellerId });
  const mex = mexGroupsOr(p.mexGroups);
  if (mex) ops.push({ m: "or", v: mex });
  ops.push(...searchOps(p.search));
  if (p.productIds.length) ops.push({ m: "in", col: "op.product_id", v: p.productIds });
  return ops;
}

/** A select of the list: the product filter needs its inner embed in EVERY select it filters (the
 *  page, the view counts, the state counts) — without it PostgREST has no `op` to filter. */
export function orderSelect(p: Pick<OrdersListParams, "productIds">, cols: string): string {
  return p.productIds.length ? `${cols}, ${PRODUCT_EMBED}` : cols;
}

/** mex=a,b → one PostgREST `or` expression; null when none / all six. */
export function mexGroupsOr(groups: readonly string[]): string | null {
  const known = MEX_GROUP_KEYS.filter((g) => groups.includes(g));
  if (!known.length || known.length === MEX_GROUP_KEYS.length) return null;
  const ids = known.filter((g) => g !== "no_parcel").flatMap((g) => MEX_GROUPS[g as Exclude<MexGroupKey, "no_parcel">]);
  const parts: string[] = [];
  if (ids.length) parts.push(`mex_status_id.in.(${[...ids].sort((a, b) => a - b).join(",")})`);
  if (known.includes("no_parcel")) parts.push("mex_tracking_id.is.null");
  return parts.join(",");
}

export function searchOps(s: SearchSpec | null): Op[] {
  if (!s) return [];
  switch (s.kind) {
    // Suffix, never `%last8%`: a substring can hit another customer. Phones are
    // stored digits-only (+389…), so the suffix IS the last 8 digits; the
    // trigram index on customer_phone serves it (6–40 ms on 358k rows).
    case "phone": return [{ m: "like", col: "customer_phone", v: `%${s.last8}` }];
    case "tracking": return [{ m: "eq", col: "mex_tracking_id", v: s.id }];
    case "text": return [{
      m: "or",
      v: `display_id.ilike.%${s.text}%,customer_name.ilike.%${s.text}%,customer_phone.ilike.%${s.text}%,product_name.ilike.%${s.text}%`,
    }];
  }
}

/** The statuses a view (∩ the legacy ?status=) lets through; null = no status filter. */
export function viewStatuses(p: Pick<OrdersListParams, "statuses">, view: OrderView | null): string[] | null {
  const own = view && view !== "all" ? [...VIEW_STATUSES[view]] : null;
  if (own && p.statuses) return own.filter((s) => p.statuses!.includes(s));
  return own ?? (p.statuses ? [...p.statuses] : null);
}

/** The filters that DO depend on the status chip / pick: the statuses, "never a
 *  disposition record" under a sale status, and the day window on each row's clock. */
export function viewOps(p: OrdersListParams, view: OrderView | null): Op[] {
  const ops: Op[] = [];
  const st = viewStatuses(p, view);
  if (st) ops.push(st.length === 1 ? { m: "eq", col: "status", v: st[0] } : { m: "in", col: "status", v: st });
  if (view === "orders") ops.push({ m: "or", v: NOT_DISPOSITION });
  if (view === "all") ops.push({ m: "or", v: SALE_NOT_DISPOSITION });
  // The status pick (view all / none only — parseOrdersListParams refuses it beside a chip).
  const pick = view && view !== "all" ? [] : stateOps(p.states ?? []);
  ops.push(...pick);
  if (p.dayFrom || p.dayTo) {
    const { fromIso, toIso } = dayWindow(p);
    const own = view && view !== "all" ? view : singleStateView(p.states ?? []);
    if (pick.length && !own) {
      ops.push({ m: "or", v: anyStatusDayOr(fromIso, toIso, stateViews(p.states)) });
    } else if (own) {
      const term = viewDayTerm(own, fromIso, toIso);
      // A single `and(…)` term is a plain AND of filters; an `or(…)` term is ONE or-group.
      if (term.startsWith("or(")) ops.push({ m: "or", v: term.slice(3, -1) });
      else for (const part of term.slice(4, -1).split(",")) ops.push(rangeOp(part));
    } else {
      ops.push({ m: "or", v: anyStatusDayOr(fromIso, toIso) });
    }
  }
  return ops;
}

/** `col.gte.ISO` → the matching builder call. */
function rangeOp(part: string): Op {
  const m = part.match(/^([a-z_]+)\.(gte|lte)\.(.+)$/);
  if (!m) throw new Error(`bad range part: ${part}`);
  return { m: m[2] as "gte" | "lte", col: m[1], v: m[3] };
}

/** Newest first by the date the list shows: with a day window, a view's own
 *  clock (a sale → its sale day, a cancel → cancelled_at …) — also for a status
 *  pick that lies wholly in one view; otherwise, and for leads / a mixed pick,
 *  created_at (the index keeps a whole-history page fast). */
export function orderSpec(p: OrdersListParams, view: OrderView | null): { col: string; ascending: boolean; nullsFirst?: boolean }[] {
  const windowed = Boolean(p.dayFrom || p.dayTo);
  const created = { col: "created_at", ascending: false };
  const own = view && view !== "all" ? view : singleStateView(p.states ?? []);
  if (windowed && own === "orders") return [{ col: "sold_at", ascending: false, nullsFirst: false }, created];
  if (windowed && own === "cancelled") return [{ col: "cancelled_at", ascending: false, nullsFirst: false }, created];
  if (windowed && own === "trashed") return [{ col: "trashed_at", ascending: false, nullsFirst: false }, created];
  return [created];
}

/** GET /orders/state-counts: one count per STATE_KEYS key, for the same filters as the list
 *  (each key counted as if it were the only pick — the panel's numbers). null = that count failed. */
export function stateCountParams(p: OrdersListParams, key: StateKey): OrdersListParams {
  return { ...p, view: "all", states: [key] };
}

/** The four counts → the five chips ("all" = their sum; null when one failed). */
export function viewCounts(counts: Record<CountedView, number | null>): Record<OrderView, number | null> {
  const parts = COUNTED_VIEWS.map((v) => counts[v]);
  const all = parts.some((n) => n == null) ? null : (parts as number[]).reduce((a, b) => a + b, 0);
  return { ...counts, all };
}

// ── MEX + "who is viewing" helpers ──────────────────────────────────────────

/** The group a parcel status belongs to (the list's MEX badge + filter). */
export function mexGroupOf(statusId: number | null | undefined, trackingId: string | null | undefined): MexGroupKey | null {
  if (!trackingId) return "no_parcel";
  for (const [g, ids] of Object.entries(MEX_GROUPS)) if ((ids as readonly number[]).includes(Number(statusId))) return g as MexGroupKey;
  return null;
}

/** GET /active-views?phones=a,b,c → the distinct last-8s (max 200). */
export function parsePhonesParam(raw: string | null): string[] {
  const out = new Set<string>();
  for (const p of (raw ?? "").split(",")) {
    const d = p.replace(/\D/g, "");
    if (d.length >= 8) out.add(d.slice(-8));
    if (out.size >= 200) break;
  }
  return [...out];
}

export interface ActiveViewRow {
  agent_id: string;
  agent_name: string | null;
  customer_phone: string;
  opened_at: string;
  expires_at: string;
}

/** Live views (expires_at in the future) keyed by the phone's last 8 digits,
 *  newest first per phone. No write happens on this read: the expired rows are
 *  swept by the cron (20260943001620), and this filter never shows one. */
export function activeViewsByPhone(rows: readonly ActiveViewRow[], last8s: readonly string[], now: Date): Record<string, ActiveViewRow> {
  const want = new Set(last8s);
  const out: Record<string, ActiveViewRow> = {};
  const nowMs = now.getTime();
  for (const r of [...rows].sort((a, b) => Date.parse(b.opened_at) - Date.parse(a.opened_at))) {
    if (!(Date.parse(r.expires_at) > nowMs)) continue;
    const d = (r.customer_phone || "").replace(/\D/g, "");
    if (d.length < 8) continue;
    const k = d.slice(-8);
    if (want.has(k) && !out[k]) out[k] = r;
  }
  return out;
}
