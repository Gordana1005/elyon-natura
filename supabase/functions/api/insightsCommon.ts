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
//   cohortOrderBucket() / cohortOrderSaleAt() / isCohortExcludedPhone()
//                            TS twins of cohort_order_bucket(), the cohort
//                            sale day and the test-phone rule (the phone LIST
//                            is data: public.report_excluded_phones, handed
//                            over by insights_cohort_order_exceptions())
//   cohortBucketOrFilter() / cohortSaleWindowOrFilter() / COHORT_UNIVERSE_OR /
//   cohortExcludedPhoneOr()  their PostgREST twins for GET /orders
//                            ?cohort_bucket&sold_from&sold_to
//   cohortSourceOrFilter()   the twin of cohort_order_source(sale_source,
//                            sale_source_detail, mex_tracking_id) for GET
//                            /orders?cohort_source= (migrations 20260942000500,
//                            20260942001000: the six departments — a card's
//                            orders are no sale_source list, and a CRM-made
//                            sale moves with its parcel's NATURA series)
//   cohortOrdersFilter()     all of them, assembled ONCE: index.ts applies it
//                            to the /orders query and scripts/verify-insights-
//                            ties.mjs translates the very same filter to SQL
//                            and ties every order part to its /orders count
// CHANGE A RULE HERE → change it in the migration too (and vice versa).
// ============================================================================

import { overviewWindows, parseCsvParam } from "./overview.ts";
import type { CsvResult, OverviewWindow } from "./overview.ts";

export type { OverviewWindow as InsightsWindow } from "./overview.ts";

/** The six departments, in the owner's display order (28.09.2026 — migrations
 *  20260942000500, 20260942001000): altercpa ("Affiliate – Lead in") · elyon_crm
 *  ("Affiliate – Lead out") · teleshop_out ("Телешоп – Lead out") ·
 *  teleshop_other ("Телешоп – Lead in") · social (Social media) · web. The keys
 *  never change; the app names them. */
export const INSIGHTS_SOURCES = ["altercpa", "elyon_crm", "teleshop_out", "teleshop_other", "social", "web"] as const;
export type InsightsSource = (typeof INSIGHTS_SOURCES)[number];

/** The collabBox details that make an order Social media's: 'social' (series
 *  9108) and '1300' (the "Нарачка С. Мрежи-Продавница" type, series 002-1300,
 *  which classify_sale_source leaves as its bare series). */
export const SOCIAL_DETAILS = ["social", "1300"] as const;

/** The NATURA series that move a CRM-made sale to another department by its
 *  parcel (the tracking id's second segment, NNN-SSSS-…) — owner 28.09.2026:
 *  9102 "Нарачка out" → Телешоп – Lead out · 9100 "Нарачка in" → Телешоп –
 *  Lead in · 9108 / 1300 → Social media. Any other series (9103, 9110, NTMK…)
 *  or no parcel: the sale stays Affiliate – Lead out. */
export const CRM_PARCEL_SERIES = { "9102": "teleshop_out", "9100": "teleshop_other", "9108": "social", "1300": "social" } as const;

/** A tracking id on a series, as the SQL writes it (LIKE '___-9102-%'; `_` is
 *  LIKE's one-character wildcard in PostgREST too, `*` its `%`). */
const onSeries = (s: string) => `mex_tracking_id.like.___-${s}-*`;
/** A CRM-made sale: elyon_crm prediction_list | direct, or the same sale stored
 *  as altercpa team_prediction by the withdrawn team rule (20260942000700). */
const CRM_MADE = "or(and(sale_source.eq.elyon_crm,sale_source_detail.in.(prediction_list,direct)),"
  + "and(sale_source.in.(altercpa,affiliate),sale_source_detail.eq.team_prediction))";
/** Where a CRM-made sale's parcel puts it: Affiliate – Lead out when the parcel
 *  is on none of the NATURA series (no parcel counts as none), else the
 *  department its series names. The five conditions cover every tracking id. */
const CRM_PARCEL: Partial<Record<InsightsSource, string[]>> = {
  elyon_crm: [`or(mex_tracking_id.is.null,and(${Object.keys(CRM_PARCEL_SERIES)
    .map((s) => `mex_tracking_id.not.like.___-${s}-*`).join(",")}))`],
  ...Object.entries(CRM_PARCEL_SERIES).reduce<Partial<Record<InsightsSource, string[]>>>((acc, [s, k]) => {
    (acc[k] ??= []).push(onSeries(s));
    return acc;
  }, {}),
};
/** The AlterCPA-team details of 20260942000700 — never the Affiliate – Lead in
 *  card (team_collabbox_out is a Нарачка out document, the other two are
 *  Affiliate – Lead out). */
const TEAM_DETAILS = "team_prediction,team_collabbox_out,team_collabbox_leads_out";
/** Everything but the CRM-made sales, per department. */
const REST_PARTS: Record<InsightsSource, string[]> = {
  altercpa: [`and(sale_source.in.(altercpa,affiliate),or(sale_source_detail.is.null,sale_source_detail.not.in.(${TEAM_DETAILS})))`],
  elyon_crm: [
    "and(sale_source.eq.elyon_crm,or(sale_source_detail.is.null,sale_source_detail.not.in.(prediction_list,direct,collabbox_out)))",
    "and(sale_source.in.(altercpa,affiliate),sale_source_detail.eq.team_collabbox_leads_out)",
  ],
  // collabBox "Нарачка out" by its folder: as stored after the reclass, and before it
  teleshop_out: [
    "and(sale_source.eq.collabbox,sale_source_detail.eq.teleshop_out)",
    "and(sale_source.eq.elyon_crm,sale_source_detail.eq.collabbox_out)",
    "and(sale_source.in.(altercpa,affiliate),sale_source_detail.eq.team_collabbox_out)",
  ],
  teleshop_other: [
    "sale_source.is.null",
    "and(sale_source.not.in.(altercpa,affiliate,elyon_crm,web),"
      + `or(sale_source.neq.collabbox,sale_source_detail.is.null,sale_source_detail.not.in.(${SOCIAL_DETAILS.join(",")},teleshop_out)))`,
  ],
  social: [`and(sale_source.eq.collabbox,sale_source_detail.in.(${SOCIAL_DETAILS.join(",")}))`],
  web: ["sale_source.eq.web"],
};

/** The union of some departments as PostgREST `or` terms: their non-CRM parts,
 *  and ONE CRM-made part over the union of their parcel conditions (all of
 *  them = every CRM-made sale), so a link naming several departments stays
 *  short. */
function departmentTerms(keys: readonly InsightsSource[]): string[] {
  const parcel = keys.flatMap((k) => CRM_PARCEL[k] ?? []);
  const crmAll = keys.filter((k) => CRM_PARCEL[k]).length === Object.keys(CRM_PARCEL).length;
  const crm = !parcel.length ? []
    : crmAll ? [CRM_MADE]
    : [`and(${CRM_MADE},${parcel.length === 1 ? parcel[0] : `or(${parcel.join(",")})`})`];
  return [...crm, ...keys.flatMap((k) => REST_PARTS[k])];
}

/** Each department's ORDER part as ONE PostgREST `or` term — the twin of
 *  cohort_order_source(sale_source, sale_source_detail, mex_tracking_id)
 *  (20260942001000). web orders live in web_orders (not orders); 'web' here
 *  only ever matches CRM-entered web orders (0 today). Телешоп – Lead in is
 *  everything else, NULL included (the SQL's ELSE): a NULL sale_source /
 *  detail / tracking id never matches not.in / neq / not.like, so the NULLs
 *  are named. The six terms partition every order (insightsCommon.test.ts). */
export const COHORT_SOURCE_TERM = Object.fromEntries(INSIGHTS_SOURCES.map((k) => {
  const t = departmentTerms([k]);
  return [k, t.length === 1 ? t[0] : `or(${t.join(",")})`];
})) as Record<InsightsSource, string>;

/** GET /orders?cohort_source=a,b → one PostgREST `or` expression selecting
 *  exactly the orders cohort_order_source() puts in those sources; null when
 *  none is asked for or all six are (no filter: every order is in one). */
export function cohortSourceOrFilter(keys: readonly string[]): string | null {
  const known = INSIGHTS_SOURCES.filter((k) => keys.includes(k));
  if (!known.length || known.length === INSIGHTS_SOURCES.length) return null;
  return departmentTerms(known).join(",");
}

/** ?cohort_source=social,teleshop_other → validated source keys; empty /
 *  absent / "all" → none (no filter). */
export const parseCohortSourceParam = (raw: string | null): CsvResult => parseCsvParam(raw, INSIGHTS_SOURCES);

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

/** ?source=altercpa,web → validated sources; empty/absent/"all" → all six. */
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
/** Kept outside the total: sold then cancelled (Откажани, red) / trashed (Во
 *  корпа, grey) with no parcel, and replacements (nothing to collect). */
export const COHORT_OUTSIDE = ["cancelled_after_sale", "trashed_after_sale", "replacement"] as const;
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
  // No parcel: the CRM status ('delivered' is the BG-era twin of paid).
  const s = o.status;
  const paid = s === "paid" || s === "delivered";
  if ((paid || s === "returned" || s === "shipped" || s === "confirmed") && price <= 0) return "replacement";
  if (paid) {
    const legacy = o.paid_basis === "operator_ruling" || o.paid_basis === "legacy_import" ||
      (o.paid_basis == null && o.source_type === "import");
    return legacy ? "paid_legacy" : "paid_unproven";
  }
  if (s === "returned") return "returned";
  if (s === "shipped") return "courier";
  if (s === "confirmed") return "to_pack";
  if (s === "cancelled" && o.sold_at != null && price > 0) return "cancelled_after_sale";
  if (s === "trashed" && o.sold_at != null && price > 0) return "trashed_after_sale";
  return null;
}

// ── test phones (owner 2026-09-28) ──────────────────────────────────────────
// The owner's test phones (070 123 456, 02 312 3123): their CRM orders, web
// orders and MEX parcels are in no insights number. The LIST is not copied
// here: it is public.report_excluded_phones (migration 20260939000700), and
// the api receives it as insights_cohort_order_exceptions().excluded_phone8s —
// adding a phone there needs no deploy.

/** A last-8 value as report_excluded_phones stores it (its CHECK). */
const PHONE8_RE = /^[0-9]{8}$/;

/** TS twin of public.is_report_excluded_phone(): the phone's digits (any
 *  format) end in a listed last-8 value; fewer than 8 digits → false. */
export function isCohortExcludedPhone(raw: string | null | undefined, phone8s: readonly string[]): boolean {
  const d = String(raw ?? "").replace(/\D/g, "");
  return d.length >= 8 && phone8s.includes(d.slice(-8));
}

/** The PostgREST side of the test-phone rule: drop an order whose phone TEXT
 *  ends in a listed phone (null when the list is empty). The few the text
 *  cannot show (spaces inside the digits, an order holding a test-phone
 *  parcel) come by id: insights_cohort_order_exceptions().test_orders. */
export function cohortExcludedPhoneOr(phone8s: readonly string[]): string | null {
  const list = phone8s.filter((p) => PHONE8_RE.test(p));
  if (!list.length) return null;
  return `customer_phone.is.null,and(${list.map((p) => `customer_phone.not.like.*${p}`).join(",")})`;
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
  /** The test phones' last-8 digits (public.report_excluded_phone8s()). */
  excluded_phone8s: string[];
  /** Test-phone orders cohortExcludedPhoneOr() cannot see. */
  test_orders: string[];
}

/** insights_cohort_order_exceptions(p_from, p_to_end) → validated lists, or
 *  null when the payload is malformed or too long to put in a filter. */
export function parseCohortExceptions(raw: unknown): CohortExceptions | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.web_claimed) || !Array.isArray(r.ledger)) return null;
  // test_orders / excluded_phone8s arrived with the test-phone rule; an older body without them is none
  const testRaw = r.test_orders ?? [];
  const phonesRaw = r.excluded_phone8s ?? [];
  if (!Array.isArray(testRaw) || !Array.isArray(phonesRaw)) return null;
  const uuids = (a: unknown[]) => a.filter((x): x is string => typeof x === "string" && UUID_RE.test(x));
  const web = uuids(r.web_claimed);
  const test = uuids(testRaw);
  // the phones go into a filter string: exactly 8 digits or the body is refused
  const phones = phonesRaw.filter((x): x is string => typeof x === "string" && PHONE8_RE.test(x));
  const ledger: { id: string; sale_at: string }[] = [];
  for (const e of r.ledger) {
    if (!e || typeof e !== "object") return null;
    const { id, sale_at } = e as Record<string, unknown>;
    if (typeof id !== "string" || !UUID_RE.test(id) || typeof sale_at !== "string" || Number.isNaN(Date.parse(sale_at))) return null;
    ledger.push({ id, sale_at });
  }
  if (web.length !== r.web_claimed.length || test.length !== testRaw.length || phones.length !== phonesRaw.length) return null;
  if (web.length + ledger.length + test.length + phones.length > COHORT_EXCEPTIONS_MAX) return null;
  return { web_claimed: web, ledger, excluded_phone8s: phones, test_orders: test };
}

/** Disposition rows are never sales — every cohort drill carries this. */
export const COHORT_UNIVERSE_OR = "sale_source_detail.is.null,sale_source_detail.neq.disposition";

/**
 * cohort_bucket=a,b → ONE PostgREST `or` expression selecting exactly the
 * orders cohort_order_bucket() puts in those buckets. `webClaimed`: order ids
 * whose parcel a live web order claims — judged on their CRM status alone, so
 * they get the no-parcel clauses and everyone else the MEX-first ones (the id
 * list appears at most twice, never once per clause: it keeps the URL short).
 * Always combine with COHORT_UNIVERSE_OR (cohortOrdersFilter does).
 */
export function cohortBucketOrFilter(keys: readonly string[], webClaimed: readonly string[] = []): string | null {
  const w = webClaimed.filter((x) => UUID_RE.test(x));
  // a parcel exists → MEX decides · no parcel → the CRM status decides
  const hp = "mex_tracking_id.not.is.null,or(mex_status_id.not.is.null,mex_delivered_at.not.is.null)";
  const nhp = "or(mex_tracking_id.is.null,and(mex_status_id.is.null,mex_delivered_at.is.null))";
  const notRepl = "or(mex_cod_mkd.gt.0,and(mex_cod_mkd.is.null,price.gt.0))";
  const repl = "or(mex_cod_mkd.lte.0,and(mex_cod_mkd.is.null,or(price.is.null,price.lte.0)))";
  const legacy = "or(paid_basis.in.(operator_ruling,legacy_import),and(paid_basis.is.null,source_type.eq.import))";
  const notLegacy = "or(paid_basis.not.in.(operator_ruling,legacy_import),and(paid_basis.is.null,or(source_type.is.null,source_type.neq.import)))";
  const paid = "status.in.(paid,delivered)";   // 'delivered' = the BG-era twin of paid
  const PARCEL: Partial<Record<CohortKey, string>> = {
    paid: `and(${hp},${notRepl},or(mex_status_id.eq.2,and(mex_status_id.is.null,mex_delivered_at.not.is.null)))`,
    returned: `and(${hp},${notRepl},mex_status_id.eq.7)`,
    courier_problem: `and(${hp},${notRepl},mex_status_id.in.(3,9,13))`,
    label: `and(${hp},${notRepl},mex_status_id.eq.8)`,
    courier: `and(${hp},${notRepl},mex_status_id.not.in.(2,3,7,8,9,13))`,
    replacement: `and(${hp},${repl})`,
  };
  const CRM: Partial<Record<CohortKey, string>> = {
    paid_unproven: `${paid},price.gt.0,${notLegacy}`,
    paid_legacy: `${paid},price.gt.0,${legacy}`,
    returned: "status.eq.returned,price.gt.0",
    courier: "status.eq.shipped,price.gt.0",
    to_pack: "status.eq.confirmed,price.gt.0",
    cancelled_after_sale: "status.eq.cancelled,sold_at.not.is.null,price.gt.0",
    trashed_after_sale: "status.eq.trashed,sold_at.not.is.null,price.gt.0",
    replacement: "status.in.(paid,delivered,returned,shipped,confirmed),or(price.is.null,price.lte.0)",
  };
  const normal: string[] = [];
  const crmOnly: string[] = [];
  const add = (list: string[], c: string) => { if (!list.includes(c)) list.push(c); };
  for (const k of keys) {
    const p = PARCEL[k as CohortKey];
    if (p) add(normal, p);
    const c = CRM[k as CohortKey];
    if (c) { add(normal, `and(${nhp},${c})`); add(crmOnly, `and(${c})`); }
  }
  if (!normal.length) return null;
  if (!w.length) return normal.join(",");
  const ids = w.join(",");
  return [
    `and(id.not.in.(${ids}),or(${normal.join(",")}))`,
    ...(crmOnly.length ? [`and(id.in.(${ids}),or(${crmOnly.join(",")}))`] : []),
  ].join(",");
}

/** The cohort sale day inside [fromIso, toEndIso] as a PostgREST `or`
 *  expression — the twin of coalesce(sold_at, ledger decided_at, confirmed_at,
 *  created_at). `ledger`: the orders (sold_at NULL) dated by the ledger. Each
 *  ledger id appears ONCE (the URL stays short while the stamping cron has
 *  not dated them yet): dated inside → listed by id; dated outside → kept
 *  out of the fallback days. */
export function cohortSaleWindowOrFilter(
  fromIso: string,
  toEndIso: string,
  ledger: readonly { id: string; sale_at: string }[] = [],
): string {
  const L = ledger.filter((e) => UUID_RE.test(e.id));
  const f = Date.parse(fromIso), t = Date.parse(toEndIso);
  const inside = (e: { sale_at: string }) => { const x = Date.parse(e.sale_at); return x >= f && x <= t; };
  const inWin = L.filter(inside).map((e) => e.id);
  const outWin = L.filter((e) => !inside(e)).map((e) => e.id);
  const notL = outWin.length ? `,id.not.in.(${outWin.join(",")})` : "";
  return [
    `and(sold_at.gte.${fromIso},sold_at.lte.${toEndIso})`,
    `and(sold_at.is.null${notL},or(and(confirmed_at.gte.${fromIso},confirmed_at.lte.${toEndIso}),and(confirmed_at.is.null,created_at.gte.${fromIso},created_at.lte.${toEndIso})))`,
    ...(inWin.length ? [`id.in.(${inWin.join(",")})`] : []),
  ].join(",");
}

export interface CohortOrdersFilter {
  /** PostgREST `or=(…)` expressions, ANDed with each other (supabase-js `.or()`). */
  or: string[];
  /** Orders never in the list (`id=not.in.(…)`, supabase-js `.not("id", "in", …)`). */
  notIds: string[];
}

/** supabase-js sends the whole filter in the URL; past ~8 KB the gateway refuses
 *  the request line. Measured: a `total` drill with six web claims is ~3.3 KB of
 *  filter (~4.2 KB of URL). Beyond this budget the api says why (503) instead. */
export const COHORT_FILTER_MAX_CHARS = 6000;
export const cohortFilterChars = (f: CohortOrdersFilter) =>
  f.or.reduce((a, e) => a + e.length, 0) + f.notIds.reduce((a, id) => a + id.length + 1, 0);

/**
 * Everything GET /orders?cohort_bucket=…[&sold_from&sold_to] adds to its
 * query so the list holds EXACTLY the order part the cohort counted: never a
 * disposition row, never a test phone, the buckets asked for and — with a
 * window (Skopje-day instants) — the cohort sale day. The source stays the
 * caller's own filter: `cohort_source` (cohortSourceOrFilter, what the cohort's
 * links send) or a plain `sale_source` `.in()`. ONE assembly for index.ts and
 * the verify script.
 */
export function cohortOrdersFilter(
  keys: readonly string[],
  ex: CohortExceptions,
  window: { fromIso: string; toEndIso: string } | null,
): CohortOrdersFilter {
  const or = [COHORT_UNIVERSE_OR];
  const phones = cohortExcludedPhoneOr(ex.excluded_phone8s);
  if (phones) or.push(phones);
  const buckets = cohortBucketOrFilter(keys, ex.web_claimed);
  if (buckets) or.push(buckets);
  if (window) or.push(cohortSaleWindowOrFilter(window.fromIso, window.toEndIso, ex.ledger));
  return { or, notIds: ex.test_orders.filter((x) => UUID_RE.test(x)) };
}
