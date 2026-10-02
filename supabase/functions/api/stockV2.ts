// ============================================================================
// Stock v2 (owner 01.10.2026, docs/STOCK-V2.md) — the pure half of
//   GET  /api/stock/v2/{health,day,article,parcels,movements,counts,config,articles,
//                       sigma/status,sigma/month-check}
//   POST /api/stock/v2/{count,count/:id/void,count/:id/approve,move,parcel-override,
//                       switch,run,article-cost,alias}      PUT /api/stock/v2/config
//   GET  /api/products/:id/articles     POST /api/products/articles(/approve|/exempt)
//   POST /api/stock/sigma/ingest        (HMAC only, no login — before the login gate)
// and of the old stock routes' retirement (stockByStatus, stock-movements).
//
// Every route calls ONE SQL function of the contract with the service role and
// p_actor = the caller; this file decides who may call what, validates every
// query / body, maps the SQL refusals to HTTP, and strips money for non-owners.
//
// Access (contract "HTTP API → Access", plus the routes it leaves open — see
// STOCK_ACCESS below):
//   quantities                 owners · admin · manager · warehouse
//   money (cost / value / COD) owners only — stripped for everyone else
//   counts                     owners · admin · warehouse (a non-owner's count is
//                              saved `pending`, the SQL decides that from p_is_owner)
//   approve a count, manual moves, overrides, configuration, the switch, a run,
//   costs, recipes / aliases / exemptions                           owners only
//
// Dependency-free on purpose (no Deno globals, no URL imports): vitest runs
// stockV2.test.ts against this file in Node; index.ts imports it. The HMAC
// check uses the Web Crypto API (globalThis.crypto.subtle — Deno and Node ≥ 19).
// ============================================================================

import { addDaysYmd, daysInclusive, isValidYmd, skopjeMidnightIso } from "./skopjeTime.ts";
import { stockMovesOnStatus } from "./stockLedger.ts";

// ── shared shapes ────────────────────────────────────────────────────────────
export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
export interface QueryLike { get(name: string): string | null }

const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const fail = <T = never>(error: string): Parsed<T> => ({ ok: false, error });
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export const WAREHOUSE_RE = /^[a-z0-9_]{2,20}$/;
/** A Sigma item code (6 digits) or a local article (L + 5 digits) — `stock_articles.code`. */
export const ARTICLE_RE = /^(?:[0-9]{6}|L[0-9]{5})$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A MEX tracking id (9110…, 9103…, NTMK…, M…): letters, digits and dashes. */
export const TRACKING_RE = /^[A-Za-z0-9-]{3,40}$/;

export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 500;
export const MAX_OFFSET = 1_000_000;
/** The longest day range a series / movements query may ask for. */
export const MAX_PERIOD_DAYS = 92;
/** Nothing in the stock ledger predates this day. */
export const MIN_DAY = "2020-01-01";
export const MAX_QTY = 1_000_000;
export const MAX_COUNT_LINES = 5000;
export const MAX_MOVE_LINES = 1000;
export const MAX_RECIPE_LINES = 50;
export const MAX_IDS = 1000;
export const MAX_NOTE = 500;
export const MAX_DOC_REF = 100;
export const MAX_SOURCE_REF = 200;
export const MAX_SEARCH = 80;
export const MAX_COST_MKD = 10_000_000;
/** A count / a move / a cost may not be dated more than this into the future (clock skew). */
export const FUTURE_SKEW_MS = 10 * 60_000;
/** POST /stock/sigma/ingest: the largest body accepted. */
export const SIGMA_MAX_BYTES = 2 * 1024 * 1024;
/** POST /stock/sigma/ingest: how far x-elyon-ts may be from now. */
export const SIGMA_MAX_SKEW_S = 300;

/** The cohort departments (cohort_order_source) — Менаџмент 7th since 20260947001000. */
export const STOCK_DEPARTMENTS = ["altercpa", "elyon_crm", "teleshop_out", "teleshop_other", "social", "web", "management"] as const;
export const STOCK_ACCOUNTS = ["natura", "bio_natural"] as const;
export const PARCEL_STATUS_GROUPS = ["delivered", "returned", "with_courier", "problem", "to_pack"] as const;
export const PARCEL_STATES = [
  "moved", "partial", "unmapped", "no_lines", "no_route", "test_phone", "excluded", "pre_opening", "waiting_lines",
] as const;
export const MOVE_KINDS = [
  "opening", "count_adjust", "parcel_out", "return_in", "unpack_in", "transfer_out", "transfer_in", "receipt",
  "production_in", "production_use", "b2b_out", "b2b_return_in", "export_out", "shop_out", "shop_return_in",
  "writeoff", "damaged_in", "adjust",
] as const;
export const MOVE_SOURCES = ["mex", "count", "sigma", "manual", "override"] as const;
export const COUNT_KINDS = ["opening", "full", "partial"] as const;
export const COUNT_SOURCES = ["manual", "sigma_variant", "xlsx"] as const;
export const MANUAL_MOVE_KINDS = ["receipt", "transfer", "adjust", "writeoff", "damaged", "unpack"] as const;
export const OVERRIDE_ACTIONS = ["exclude", "lines", "route", "unpacked", "damaged_return"] as const;
export const RECIPE_ROLES = ["main", "component", "gift"] as const;
export const ALIAS_SOURCES = ["collabbox_code", "collabbox_name", "web_product", "web_sku", "name_any"] as const;
export const SIGMA_SOURCES = ["csv", "connector"] as const;
export const SIGMA_MODES = ["delta", "snapshot", "items", "balances"] as const;

const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): v is T =>
  typeof v === "string" && (allowed as readonly string[]).includes(v);

// ── access ───────────────────────────────────────────────────────────────────
/** Who is calling. `owner` = public.is_business_owner() (every active admin + the owners list). */
export interface StockCaller { owner: boolean; admin: boolean; manager: boolean; warehouse: boolean }

export type StockCapability =
  | "read"       // quantities: day, article, parcels, movements, health, articles, recipes, config (warehouses), Sigma status
  | "money"      // cost / value / COD keys stay in the payload
  | "count"      // save a count (pending for a non-owner), void a PENDING count
  | "approve"    // approve a count, void an APPROVED one
  | "move"       // manual moves (receipt / transfer / adjust / writeoff / damaged / unpack)
  | "override"   // parcel overrides
  | "configure"  // warehouses, keys, routes, Sigma rules, settings
  | "switch"     // stock_v2.enabled on / off
  | "run"        // stock_v2_apply now (dry or real)
  | "costs"      // a purchase cost by hand
  | "mappings";  // recipes, their approval, exemptions, aliases

const staff = (c: StockCaller) => c.owner || c.admin || c.manager || c.warehouse;
const owner = (c: StockCaller) => c.owner;

/** The access matrix (docs/STOCK-V2.md "HTTP API → Access"). Owners-only unless a line says otherwise. */
export const STOCK_ACCESS: Record<StockCapability, (c: StockCaller) => boolean> = {
  read: staff,
  money: owner,
  count: (c) => c.owner || c.admin || c.warehouse,
  approve: owner,
  move: owner,
  override: owner,
  configure: owner,
  switch: owner,
  run: owner,
  costs: owner,
  mappings: owner,
};

export const STOCK_CAPABILITIES = Object.keys(STOCK_ACCESS) as StockCapability[];

export function stockCan(c: StockCaller, cap: StockCapability): boolean {
  return STOCK_ACCESS[cap](c);
}

/** Every capability of a caller — handed to the UI in GET stock/v2/health as `access`. */
export function stockAccess(c: StockCaller): Record<StockCapability, boolean> {
  const out = {} as Record<StockCapability, boolean>;
  for (const k of STOCK_CAPABILITIES) out[k] = stockCan(c, k);
  return out;
}

/** The 403 code: `owners_only` when staff asks for an owners-only capability, else `forbidden`. */
export function denyCode(c: StockCaller, cap: StockCapability): "owners_only" | "forbidden" {
  const ownersOnly = STOCK_ACCESS[cap] === owner;
  return ownersOnly && staff(c) ? "owners_only" : "forbidden";
}

/** Voiding a count: a PENDING one by whoever may count; an APPROVED one only by an owner (it moves stock). */
export function canVoidCount(c: StockCaller, status: string | null | undefined): boolean {
  if (status === "pending") return stockCan(c, "count");
  if (status === "approved") return stockCan(c, "approve");
  return false;
}

// ── the stock regime: app_settings 'stock_v2' (+ the retired 'stock_mex_movements') ──
export interface StockV2Settings {
  /** the 'stock_v2' row exists (migration 20260945000100 applied) */
  present: boolean;
  enabled: boolean;
  sigma: { ingest: boolean; apply_on_ingest: boolean; costs_follow: boolean };
}

export interface SettingRow { key: string; value: unknown }

/** app_settings rows → the v2 switch. A missing row = present:false, everything off. */
export function readStockV2Settings(rows: SettingRow[] | null | undefined): StockV2Settings {
  const row = (rows || []).find((r) => r && r.key === "stock_v2");
  const v = isObj(row?.value) ? row!.value as Record<string, unknown> : {};
  const sg = isObj(v.sigma) ? v.sigma : {};
  return {
    present: !!row,
    enabled: v.enabled === true,
    sigma: { ingest: sg.ingest === true, apply_on_ingest: sg.apply_on_ingest !== false, costs_follow: sg.costs_follow === true },
  };
}

/**
 * Whether a CRM status change (shipped → deduct, returned → restore, and their
 * "Insufficient stock" refusal) still moves products.stock_quantity.
 * Stock v2: never, as soon as app_settings has the 'stock_v2' key (migration
 * …0100) — what leaves is MEX parcels + collabBox lines in the stock ledger, and
 * products.stock_quantity is a derived mirror a guard trigger protects (…0700).
 * Before that, the v1 rule (stockLedger.ts) still decides.
 */
export function statusMovesStock(rows: SettingRow[] | null | undefined): boolean {
  if (readStockV2Settings(rows).present) return false;
  const mex = (rows || []).find((r) => r && r.key === "stock_mex_movements");
  return stockMovesOnStatus(mex?.value ?? null);
}

/** ?preview= absent → preview while the switch is off (nothing is written yet), the ledger once it is on. */
export function resolvePreview(explicit: boolean | null, enabled: boolean): boolean {
  return explicit ?? !enabled;
}

// ── query parsing ────────────────────────────────────────────────────────────
const trimmed = (q: QueryLike, name: string): string => (q.get(name) ?? "").trim();

/** '1' / 'true' → true, '0' / 'false' → false, absent → null. */
export function parseBoolParam(v: string | null | undefined): Parsed<boolean | null> {
  const s = (v ?? "").trim().toLowerCase();
  if (s === "") return ok(null);
  if (s === "1" || s === "true") return ok(true);
  if (s === "0" || s === "false") return ok(false);
  return fail("bad_boolean");
}

function dayParam(v: string, today: string, fallback: string, err: string): Parsed<string> {
  const d = v || fallback;
  if (!isValidYmd(d) || d < MIN_DAY || d > today) return fail(err);
  return ok(d);
}

function warehouseParam(v: string, fallback: string | null): Parsed<string | null> {
  if (!v) return ok(fallback);
  return WAREHOUSE_RE.test(v) ? ok(v) : fail("bad_warehouse");
}

function limitOffset(q: QueryLike): Parsed<{ limit: number; offset: number }> {
  const l = trimmed(q, "limit");
  const o = trimmed(q, "offset");
  const limit = l === "" ? DEFAULT_LIMIT : Number(l);
  const offset = o === "" ? 0 : Number(o);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return fail("bad_limit");
  if (!Number.isInteger(offset) || offset < 0 || offset > MAX_OFFSET) return fail("bad_offset");
  return ok({ limit, offset });
}

/** Free text for a filter: control characters and the LIKE / PostgREST metacharacters removed, ≤ 80. */
export function cleanSearch(v: string | null | undefined): string {
  return String(v ?? "")
    // deno-lint-ignore no-control-regex
    .replace(/[\u0000-\u001f\u007f%_\\,()'"*]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SEARCH);
}

function periodParams(q: QueryLike, today: string, defaultDays: number): Parsed<{ from: string; to: string }> {
  const to = dayParam(trimmed(q, "to"), today, today, "bad_to");
  if (!to.ok) return to;
  const from = dayParam(trimmed(q, "from"), today, addDaysYmd(to.value, -(defaultDays - 1)), "bad_from");
  if (!from.ok) return from;
  if (from.value > to.value) return fail("bad_period");
  if (daysInclusive(from.value, to.value) > MAX_PERIOD_DAYS) return fail("period_too_long");
  return ok({ from: from.value, to: to.value });
}

export interface DayQuery { day: string; warehouse: string; at: string | null; preview: boolean | null }

/** GET stock/v2/day?day=YYYY-MM-DD&warehouse=main&at=HH:MM&preview=0/1 (day defaults to today, Skopje). */
export function parseDayQuery(q: QueryLike, today: string): Parsed<DayQuery> {
  const day = dayParam(trimmed(q, "day"), today, today, "bad_day");
  if (!day.ok) return day;
  const wh = warehouseParam(trimmed(q, "warehouse"), "main");
  if (!wh.ok) return wh;
  const atRaw = trimmed(q, "at");
  if (atRaw && !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(atRaw)) return fail("bad_at");
  const preview = parseBoolParam(q.get("preview"));
  if (!preview.ok) return fail("bad_preview");
  return ok({ day: day.value, warehouse: wh.value!, at: atRaw ? `${atRaw}:00` : null, preview: preview.value });
}

export interface ArticleSeriesQuery { code: string; warehouse: string; from: string; to: string; preview: boolean | null }

/** GET stock/v2/article?code&warehouse&from&to&preview — the last 30 days by default, ≤ 92 days. */
export function parseArticleSeriesQuery(q: QueryLike, today: string): Parsed<ArticleSeriesQuery> {
  const code = trimmed(q, "code");
  if (!ARTICLE_RE.test(code)) return fail("bad_code");
  const wh = warehouseParam(trimmed(q, "warehouse"), "main");
  if (!wh.ok) return wh;
  const per = periodParams(q, today, 30);
  if (!per.ok) return per;
  const preview = parseBoolParam(q.get("preview"));
  if (!preview.ok) return fail("bad_preview");
  return ok({ code, warehouse: wh.value!, from: per.value.from, to: per.value.to, preview: preview.value });
}

export interface ParcelFilters {
  warehouse?: string; account?: string; department?: string; status?: string; city?: string; state?: string;
}
export interface ParcelsQuery { day: string; filters: ParcelFilters; limit: number; offset: number }

/** GET stock/v2/parcels?day&warehouse&account&department&status&city&state&limit&offset. */
export function parseParcelsQuery(q: QueryLike, today: string): Parsed<ParcelsQuery> {
  const day = dayParam(trimmed(q, "day"), today, today, "bad_day");
  if (!day.ok) return day;
  const filters: ParcelFilters = {};
  const wh = warehouseParam(trimmed(q, "warehouse"), null);
  if (!wh.ok) return wh;
  if (wh.value) filters.warehouse = wh.value;
  const account = trimmed(q, "account");
  if (account) { if (!oneOf(account, STOCK_ACCOUNTS)) return fail("bad_account"); filters.account = account; }
  const dep = trimmed(q, "department");
  if (dep) { if (!oneOf(dep, STOCK_DEPARTMENTS)) return fail("bad_department"); filters.department = dep; }
  const status = trimmed(q, "status");
  if (status) { if (!oneOf(status, PARCEL_STATUS_GROUPS)) return fail("bad_status"); filters.status = status; }
  const state = trimmed(q, "state");
  if (state) { if (!oneOf(state, PARCEL_STATES)) return fail("bad_state"); filters.state = state; }
  const city = cleanSearch(q.get("city"));
  if (city) filters.city = city;
  const lo = limitOffset(q);
  if (!lo.ok) return lo;
  return ok({ day: day.value, filters, ...lo.value });
}

export interface MovementFilters {
  from: string; to: string;          // Skopje days, both inclusive
  warehouse?: string; article?: string; kind?: string; source?: string; q?: string;
  corrections?: boolean;             // true = only corrections, false = none, absent = all
}
export interface MovementsQuery { filters: MovementFilters; limit: number; offset: number }

/** GET stock/v2/movements?from&to&warehouse&article&kind&source&q&corrections&limit&offset — the last 30 days by default. */
export function parseMovementsQuery(q: QueryLike, today: string): Parsed<MovementsQuery> {
  const per = periodParams(q, today, 30);
  if (!per.ok) return per;
  const filters: MovementFilters = { from: per.value.from, to: per.value.to };
  const wh = warehouseParam(trimmed(q, "warehouse"), null);
  if (!wh.ok) return wh;
  if (wh.value) filters.warehouse = wh.value;
  const article = trimmed(q, "article");
  if (article) { if (!ARTICLE_RE.test(article)) return fail("bad_article"); filters.article = article; }
  const kind = trimmed(q, "kind");
  if (kind) { if (!oneOf(kind, MOVE_KINDS)) return fail("bad_kind"); filters.kind = kind; }
  const source = trimmed(q, "source");
  if (source) { if (!oneOf(source, MOVE_SOURCES)) return fail("bad_source"); filters.source = source; }
  const text = cleanSearch(q.get("q"));
  if (text) filters.q = text;
  const corr = parseBoolParam(q.get("corrections"));
  if (!corr.ok) return fail("bad_corrections");
  if (corr.value !== null) filters.corrections = corr.value;
  const lo = limitOffset(q);
  if (!lo.ok) return lo;
  return ok({ filters, ...lo.value });
}

/** GET stock/v2/sigma/month-check?month=YYYY-MM → the first day of that month ('YYYY-MM-01'); not after this month. */
export function parseMonthQuery(q: QueryLike, today: string): Parsed<string> {
  const m = trimmed(q, "month");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) return fail("bad_month");
  const first = `${m}-01`;
  if (first < MIN_DAY || m > today.slice(0, 7)) return fail("bad_month");
  return ok(first);
}

export interface ArticlesQuery { q: string; warehouse: string; active: boolean | null; limit: number; preview: boolean | null }

/** GET stock/v2/articles?q&warehouse&active=1|0|all&limit&preview — active articles by default, ≤ 500. */
export function parseArticlesQuery(q: QueryLike): Parsed<ArticlesQuery> {
  const wh = warehouseParam(trimmed(q, "warehouse"), "main");
  if (!wh.ok) return wh;
  const a = trimmed(q, "active").toLowerCase();
  let active: boolean | null = true;
  if (a === "all") active = null;
  else if (a) {
    const b = parseBoolParam(a);
    if (!b.ok) return fail("bad_active");
    active = b.value;
  }
  const l = trimmed(q, "limit");
  const limit = l === "" ? 200 : Number(l);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return fail("bad_limit");
  const preview = parseBoolParam(q.get("preview"));
  if (!preview.ok) return fail("bad_preview");
  return ok({ q: cleanSearch(q.get("q")), warehouse: wh.value!, active, limit, preview: preview.value });
}

export interface CountsQuery { warehouse: string | null; limit: number }

/** GET stock/v2/counts?warehouse&limit — every warehouse when absent, the newest 50 by default, ≤ 500. */
export function parseCountsQuery(q: QueryLike): Parsed<CountsQuery> {
  const wh = warehouseParam(trimmed(q, "warehouse"), null);
  if (!wh.ok) return wh;
  const l = trimmed(q, "limit");
  const limit = l === "" ? 50 : Number(l);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return fail("bad_limit");
  return ok({ warehouse: wh.value, limit });
}

// ── body parsing ─────────────────────────────────────────────────────────────
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})$/;

/**
 * An instant from a body: an ISO date-time WITH an offset (or Z), or a bare
 * YYYY-MM-DD = that day's 00:00 in Skopje. Returned as a UTC ISO string.
 * `-infinity` passes only when allowed (a cost / recipe valid for the whole history).
 */
export function parseInstant(
  v: unknown, nowMs: number, opts: { allowInfinity?: boolean; maxFutureMs?: number } = {},
): Parsed<string> {
  if (typeof v !== "string") return fail("bad_time");
  const s = v.trim();
  if (opts.allowInfinity && s === "-infinity") return ok("-infinity");
  let ms: number;
  if (isValidYmd(s)) ms = Date.parse(skopjeMidnightIso(s));
  else if (ISO_INSTANT_RE.test(s)) ms = Date.parse(s);
  else return fail("bad_time");
  if (!Number.isFinite(ms)) return fail("bad_time");
  if (ms < Date.parse(skopjeMidnightIso(MIN_DAY))) return fail("bad_time");
  if (ms > nowMs + (opts.maxFutureMs ?? FUTURE_SKEW_MS)) return fail("time_in_future");
  return ok(new Date(ms).toISOString());
}

/** A quantity: finite, ≥ 0 (> 0 when `positive`), ≤ 1.000.000, at most 3 decimals. */
export function isQty(v: unknown, positive: boolean): v is number {
  if (typeof v !== "number" || !Number.isFinite(v)) return false;
  if (positive ? v <= 0 : v < 0) return false;
  if (v > MAX_QTY) return false;
  return Math.abs(Math.round(v * 1000) - v * 1000) < 1e-6;
}

const optText = (v: unknown, max: number): Parsed<string | null> => {
  if (v === undefined || v === null) return ok(null);
  if (typeof v !== "string") return fail("bad_text");
  const s = v.trim();
  if (s.length > max) return fail("text_too_long");
  return ok(s || null);
};

const reqDry = (b: Record<string, unknown>): Parsed<boolean> =>
  typeof b.dry === "boolean" ? ok(b.dry) : fail("dry_required");

export interface QtyLine { code: string; qty: number }

/** [{code, qty}] — every article once, a valid code, a quantity (> 0 when `positive`). */
export function parseQtyLines(v: unknown, opts: { min: number; max: number; positive: boolean }): Parsed<QtyLine[]> {
  if (!Array.isArray(v)) return fail("lines_required");
  if (v.length < opts.min) return fail("lines_required");
  if (v.length > opts.max) return fail("too_many_lines");
  const seen = new Set<string>();
  const out: QtyLine[] = [];
  for (const raw of v) {
    if (!isObj(raw)) return fail("bad_line");
    const code = typeof raw.code === "string" ? raw.code.trim() : "";
    if (!ARTICLE_RE.test(code)) return fail("bad_code");
    if (!isQty(raw.qty, opts.positive)) return fail("bad_qty");
    if (seen.has(code)) return fail("duplicate_code");
    seen.add(code);
    out.push({ code, qty: raw.qty as number });
  }
  return ok(out);
}

export interface CountRequest {
  warehouse: string; counted_at: string; kind: typeof COUNT_KINDS[number]; lines: QtyLine[];
  packed_counted: boolean; source: typeof COUNT_SOURCES[number]; source_ref: string | null; note: string | null; dry: boolean;
}

/** POST stock/v2/count — StockCountRequest. `dry` is required (the UI previews first). */
export function parseCountRequest(body: unknown, nowMs: number): Parsed<CountRequest> {
  if (!isObj(body)) return fail("body_required");
  if (typeof body.warehouse !== "string" || !WAREHOUSE_RE.test(body.warehouse)) return fail("bad_warehouse");
  const at = parseInstant(body.counted_at, nowMs);
  if (!at.ok) return fail(at.error === "time_in_future" ? "counted_at_in_future" : "bad_counted_at");
  if (!oneOf(body.kind, COUNT_KINDS)) return fail("bad_kind");
  const lines = parseQtyLines(body.lines, { min: 1, max: MAX_COUNT_LINES, positive: false });
  if (!lines.ok) return lines;
  if (body.packed_counted !== undefined && typeof body.packed_counted !== "boolean") return fail("bad_packed_counted");
  const source = body.source === undefined || body.source === null ? "manual" : body.source;
  if (!oneOf(source, COUNT_SOURCES)) return fail("bad_source");
  const sref = optText(body.source_ref, MAX_SOURCE_REF);
  if (!sref.ok) return fail("bad_source_ref");
  const note = optText(body.note, MAX_NOTE);
  if (!note.ok) return fail("bad_note");
  const dry = reqDry(body);
  if (!dry.ok) return dry;
  return ok({
    warehouse: body.warehouse, counted_at: at.value, kind: body.kind, lines: lines.value,
    packed_counted: body.packed_counted === true, source, source_ref: sref.value, note: note.value, dry: dry.value,
  });
}

/** {reason} — 5 … 500 characters (the database requires 5) (void a count). */
export function parseReasonBody(body: unknown): Parsed<string> {
  if (!isObj(body) || typeof body.reason !== "string") return fail("reason_required");
  const r = body.reason.trim();
  if ([...r].length < 5) return fail("reason_required");
  if (r.length > MAX_NOTE) return fail("reason_too_long");
  return ok(r);
}

export interface ManualMoveRequest {
  kind: typeof MANUAL_MOVE_KINDS[number]; from: string | null; to: string | null; event_at: string;
  doc_ref: string | null; note: string | null; lines: QtyLine[]; dry: boolean;
}

/**
 * POST stock/v2/move — StockManualMoveRequest. Which side each kind needs:
 *   receipt → to · transfer → from AND to (different) · adjust → exactly one
 *   (from = down, to = up) · writeoff / damaged → from (to optional) · unpack → to (from optional).
 * Quantities are positive; the side carries the sign.
 */
export function parseManualMoveRequest(body: unknown, nowMs: number): Parsed<ManualMoveRequest> {
  if (!isObj(body)) return fail("body_required");
  if (!oneOf(body.kind, MANUAL_MOVE_KINDS)) return fail("bad_kind");
  const side = (v: unknown): Parsed<string | null> => {
    if (v === undefined || v === null || v === "") return ok(null);
    return typeof v === "string" && WAREHOUSE_RE.test(v) ? ok(v) : fail("bad_warehouse");
  };
  const from = side(body.from);
  if (!from.ok) return from;
  const to = side(body.to);
  if (!to.ok) return to;
  const f = from.value, t = to.value;
  switch (body.kind) {
    case "receipt": if (!t) return fail("to_required"); break;
    case "transfer":
      if (!f || !t) return fail("from_and_to_required");
      if (f === t) return fail("same_warehouse");
      break;
    case "adjust": if (!!f === !!t) return fail("one_side_required"); break;
    case "writeoff":
    case "damaged":
      if (!f) return fail("from_required");
      if (f === t) return fail("same_warehouse");
      break;
    case "unpack":
      if (!t) return fail("to_required");
      if (f === t) return fail("same_warehouse");
      break;
  }
  const at = parseInstant(body.event_at, nowMs);
  if (!at.ok) return fail(at.error === "time_in_future" ? "event_at_in_future" : "bad_event_at");
  const doc = optText(body.doc_ref, MAX_DOC_REF);
  if (!doc.ok) return fail("bad_doc_ref");
  const note = optText(body.note, MAX_NOTE);
  if (!note.ok) return fail("bad_note");
  const lines = parseQtyLines(body.lines, { min: 1, max: MAX_MOVE_LINES, positive: true });
  if (!lines.ok) return lines;
  const dry = reqDry(body);
  if (!dry.ok) return dry;
  return ok({ kind: body.kind, from: f, to: t, event_at: at.value, doc_ref: doc.value, note: note.value, lines: lines.value, dry: dry.value });
}

/** The size of a JSON value once serialized (bytes ≈ characters for the ASCII payloads here). */
const jsonSize = (v: unknown): number => {
  try { return JSON.stringify(v ?? null).length; } catch { return Infinity; }
};

export interface ParcelOverrideRequest { tracking_id: string; action: typeof OVERRIDE_ACTIONS[number]; payload: Record<string, unknown>; note: string }

/**
 * POST stock/v2/parcel-override {tracking_id, action, payload, note}. `payload` is an object (≤ 20 kB);
 * for `lines` it must carry `lines: [{code, qty > 0}]`, for `route` a `warehouse` code. A note (≥ 3) is required.
 */
export function parseParcelOverride(body: unknown): Parsed<ParcelOverrideRequest> {
  if (!isObj(body)) return fail("body_required");
  const tr = typeof body.tracking_id === "string" ? body.tracking_id.trim() : "";
  if (!TRACKING_RE.test(tr)) return fail("bad_tracking_id");
  if (!oneOf(body.action, OVERRIDE_ACTIONS)) return fail("bad_action");
  const payload = body.payload === undefined || body.payload === null ? {} : body.payload;
  if (!isObj(payload)) return fail("bad_payload");
  if (jsonSize(payload) > 20_000) return fail("payload_too_large");
  if (body.action === "lines") {
    const l = parseQtyLines(payload.lines, { min: 1, max: 200, positive: true });
    if (!l.ok) return l;
  }
  if (body.action === "route" && (typeof payload.warehouse !== "string" || !WAREHOUSE_RE.test(payload.warehouse))) {
    return fail("bad_warehouse");
  }
  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (note.length < 3) return fail("note_required");
  if (note.length > MAX_NOTE) return fail("note_too_long");
  return ok({ tracking_id: tr, action: body.action, payload, note });
}

export const CONFIG_KEYS = ["warehouses", "keys", "routes", "sigma_rules"] as const;
export interface ConfigPatch {
  /** → stock_v2_config_set(p_patch) — null when the body has none of them */
  config: Record<string, unknown[]> | null;
  /** → stock_v2_set(p_enabled = unchanged, p_patch) — null when absent */
  settings: Record<string, unknown> | null;
}

/**
 * PUT stock/v2/config — a partial StockConfig: any of warehouses / keys / routes / sigma_rules (arrays of
 * row objects, ≤ 200 each) and `settings` (an object; `enabled` is NOT allowed here — POST stock/v2/switch).
 * ≤ 64 kB. The SQL writer validates every row.
 */
export function parseConfigPatch(body: unknown): Parsed<ConfigPatch> {
  if (!isObj(body)) return fail("body_required");
  if (jsonSize(body) > 64_000) return fail("body_too_large");
  const allowed = new Set<string>([...CONFIG_KEYS, "settings"]);
  for (const k of Object.keys(body)) if (!allowed.has(k)) return fail(`unknown_key:${k}`.slice(0, 60));
  let config: Record<string, unknown[]> | null = null;
  for (const k of CONFIG_KEYS) {
    if (body[k] === undefined) continue;
    const arr = body[k];
    if (!Array.isArray(arr) || arr.length > 200 || !arr.every(isObj)) return fail(`bad_${k}`);
    (config ??= {})[k] = arr;
  }
  let settings: Record<string, unknown> | null = null;
  if (body.settings !== undefined) {
    if (!isObj(body.settings)) return fail("bad_settings");
    if ("enabled" in body.settings) return fail("use_switch");
    settings = body.settings;
  }
  if (!config && !settings) return fail("nothing_to_update");
  return ok({ config, settings });
}

/** POST stock/v2/switch {enabled}. */
export function parseSwitchBody(body: unknown): Parsed<boolean> {
  if (!isObj(body) || typeof body.enabled !== "boolean") return fail("enabled_required");
  return ok(body.enabled);
}

/** POST stock/v2/run {dry} — `dry` must be said out loud. */
export function parseRunBody(body: unknown): Parsed<boolean> {
  if (!isObj(body)) return fail("dry_required");
  return reqDry(body);
}

export interface ArticleCostRequest { code: string; cost_mkd: number; valid_from: string; note: string | null }

/** POST stock/v2/article-cost {code, cost_mkd, valid_from, note} — денари without VAT, ≤ 4 decimals; valid_from may be -infinity. */
export function parseArticleCostBody(body: unknown, nowMs: number): Parsed<ArticleCostRequest> {
  if (!isObj(body)) return fail("body_required");
  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!ARTICLE_RE.test(code)) return fail("bad_code");
  const c = body.cost_mkd;
  if (typeof c !== "number" || !Number.isFinite(c) || c < 0 || c > MAX_COST_MKD
      || Math.abs(Math.round(c * 10_000) - c * 10_000) > 1e-6) return fail("bad_cost");
  const vf = parseInstant(body.valid_from, nowMs, { allowInfinity: true });
  if (!vf.ok) return fail("bad_valid_from");
  const note = optText(body.note, MAX_NOTE);
  if (!note.ok) return fail("bad_note");
  return ok({ code, cost_mkd: c, valid_from: vf.value, note: note.value });
}

export interface RecipeLine { code: string; qty: number; role: typeof RECIPE_ROLES[number] }
export interface RecipeRequest { product_id: string; lines: RecipeLine[]; approve: boolean; valid_from: string | null; note: string | null }

/**
 * POST products/articles {product_id, lines:[{code, qty, role?}], approve?, valid_from?, note?}.
 * 0 < qty ≤ 100, role main (default) / component / gift, every article once, ≤ 50 lines (0 = no recipe).
 * valid_from absent → null (the SQL's default, '-infinity' = the whole history).
 */
export function parseRecipeBody(body: unknown, nowMs: number): Parsed<RecipeRequest> {
  if (!isObj(body)) return fail("body_required");
  const pid = typeof body.product_id === "string" ? body.product_id.trim().toLowerCase() : "";
  if (!UUID_RE.test(pid)) return fail("bad_product_id");
  if (!Array.isArray(body.lines)) return fail("lines_required");
  if (body.lines.length > MAX_RECIPE_LINES) return fail("too_many_lines");
  const seen = new Set<string>();
  const lines: RecipeLine[] = [];
  for (const raw of body.lines) {
    if (!isObj(raw)) return fail("bad_line");
    const code = typeof raw.code === "string" ? raw.code.trim() : "";
    if (!ARTICLE_RE.test(code)) return fail("bad_code");
    const q = raw.qty;
    if (typeof q !== "number" || !Number.isFinite(q) || q <= 0 || q > 100
        || Math.abs(Math.round(q * 1000) - q * 1000) > 1e-6) return fail("bad_qty");
    const role = raw.role === undefined || raw.role === null ? "main" : raw.role;
    if (!oneOf(role, RECIPE_ROLES)) return fail("bad_role");
    if (seen.has(code)) return fail("duplicate_code");
    seen.add(code);
    lines.push({ code, qty: q, role });
  }
  if (body.approve !== undefined && typeof body.approve !== "boolean") return fail("bad_approve");
  let validFrom: string | null = null;
  if (body.valid_from !== undefined && body.valid_from !== null) {
    const vf = parseInstant(body.valid_from, nowMs, { allowInfinity: true });
    if (!vf.ok) return fail("bad_valid_from");
    validFrom = vf.value;
  }
  const note = optText(body.note, MAX_NOTE);
  if (!note.ok) return fail("bad_note");
  return ok({ product_id: pid, lines, approve: body.approve === true, valid_from: validFrom, note: note.value });
}

/** {product_ids: uuid[]} — lower-cased, de-duplicated, 1 … 1000. */
export function parseProductIds(v: unknown): Parsed<string[]> {
  if (!Array.isArray(v)) return fail("product_ids_required");
  const seen = new Set<string>();
  for (const raw of v) {
    const id = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (!UUID_RE.test(id)) return fail("bad_product_id");
    seen.add(id);
  }
  if (seen.size === 0) return fail("product_ids_required");
  if (seen.size > MAX_IDS) return fail("too_many_products");
  return ok([...seen]);
}

/** POST products/articles/approve {product_ids}. */
export function parseApproveBody(body: unknown): Parsed<string[]> {
  if (!isObj(body)) return fail("product_ids_required");
  return parseProductIds(body.product_ids);
}

export interface ExemptRequest { product_ids: string[]; exempt: boolean; reason: string | null }

/** POST products/articles/exempt {product_ids, exempt, reason?} — delivery, ПОЕН, flyers… never move stock. */
export function parseExemptBody(body: unknown): Parsed<ExemptRequest> {
  if (!isObj(body)) return fail("product_ids_required");
  const ids = parseProductIds(body.product_ids);
  if (!ids.ok) return ids;
  if (typeof body.exempt !== "boolean") return fail("exempt_required");
  const reason = optText(body.reason, MAX_NOTE);
  if (!reason.ok) return fail("bad_reason");
  if (body.exempt && !reason.value) return fail("reason_required");
  return ok({ product_ids: ids.value, exempt: body.exempt, reason: reason.value });
}

export interface AliasRequest { source: typeof ALIAS_SOURCES[number]; key: string; lines: QtyLine[]; approve: boolean }

/**
 * POST stock/v2/alias {source, key, lines, approve?} — a collabBox code / name, a web product / SKU or any
 * name → articles. `lines: []` = "not stock" (kind not_stock). The SQL normalises the key.
 */
export function parseAliasBody(body: unknown): Parsed<AliasRequest> {
  if (!isObj(body)) return fail("body_required");
  if (!oneOf(body.source, ALIAS_SOURCES)) return fail("bad_source");
  const key = typeof body.key === "string" ? body.key.trim() : "";
  if (!key || key.length > 200) return fail("bad_key");
  const lines = parseQtyLines(body.lines, { min: 0, max: 50, positive: true });
  if (!lines.ok) return lines;
  if (body.approve !== undefined && typeof body.approve !== "boolean") return fail("bad_approve");
  return ok({ source: body.source, key, lines: lines.value, approve: body.approve === true });
}

// ── POST stock/sigma/ingest ──────────────────────────────────────────────────
export const SIGMA_BATCH_ID_RE = /^[A-Za-z0-9._:|-]{1,120}$/;
export const SIGMA_MAX_ROWS = { docs: 20_000, drafts: 20_000, items: 20_000, balances: 50_000 } as const;

/**
 * A SigmaBatch, checked for shape only — stock_sigma_ingest() keeps only its whitelisted fields
 * (and refuses person data). batch_id, source, mode and exported_at are required; every list is
 * an array of objects within its cap.
 */
export function parseSigmaBatch(v: unknown): Parsed<Record<string, unknown>> {
  if (!isObj(v)) return fail("bad_batch");
  if (typeof v.batch_id !== "string" || !SIGMA_BATCH_ID_RE.test(v.batch_id)) return fail("bad_batch_id");
  if (!oneOf(v.source, SIGMA_SOURCES)) return fail("bad_source");
  if (!oneOf(v.mode, SIGMA_MODES)) return fail("bad_mode");
  if (typeof v.exported_at !== "string" || !Number.isFinite(Date.parse(v.exported_at))) return fail("bad_exported_at");
  if (v.window !== undefined && v.window !== null) {
    const w = v.window;
    if (!isObj(w) || typeof w.from !== "string" || typeof w.to !== "string"
        || !Number.isFinite(Date.parse(w.from)) || !Number.isFinite(Date.parse(w.to))) return fail("bad_window");
  }
  if (v.mode === "snapshot" && !isObj(v.window)) return fail("window_required");
  for (const k of Object.keys(SIGMA_MAX_ROWS) as (keyof typeof SIGMA_MAX_ROWS)[]) {
    const arr = v[k];
    if (arr === undefined || arr === null) continue;
    if (!Array.isArray(arr) || !arr.every(isObj)) return fail(`bad_${k}`);
    if (arr.length > SIGMA_MAX_ROWS[k]) return fail(`too_many_${k}`);
  }
  if (v.balances_taken_at !== undefined && v.balances_taken_at !== null
      && (typeof v.balances_taken_at !== "string" || !Number.isFinite(Date.parse(v.balances_taken_at)))) {
    return fail("bad_balances_taken_at");
  }
  return ok(v);
}

const enc = new TextEncoder();
const toHex = (b: ArrayBuffer | Uint8Array): string =>
  Array.from(b instanceof Uint8Array ? b : new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");

/** hex(HMAC_SHA256(secret, ts + "." + rawBody)) — the signature the Sigma connector / CSV uploader sends. */
export async function sigmaSignature(secret: string, ts: string, rawBody: string | Uint8Array): Promise<string> {
  const subtle = globalThis.crypto.subtle;
  const key = await subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const body = typeof rawBody === "string" ? enc.encode(rawBody) : rawBody;
  const head = enc.encode(`${ts}.`);
  const msg = new Uint8Array(head.length + body.length);
  msg.set(head, 0);
  msg.set(body, head.length);
  return toHex(await subtle.sign("HMAC", key, msg));
}

/** Constant-time string comparison (both already lower-case hex of the same length when it matters). */
export function timingSafeEqual(a: string, b: string): boolean {
  const n = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export type SigmaVerdict = { ok: true } | { ok: false; error: "not_configured" | "missing_headers" | "bad_timestamp" | "stale" | "bad_signature" };

/**
 * x-elyon-ts + x-elyon-signature over the RAW body (before any JSON parse).
 *   ts   unix seconds (13-digit milliseconds also accepted), within ±300 s of `nowMs`
 *   sig  hex(HMAC_SHA256(secret, ts + "." + rawBody)), 64 hex characters (an optional "sha256=" prefix)
 * Fail-closed: no secret → not_configured. The comparison is constant-time.
 */
export async function verifySigmaSignature(
  ts: string | null | undefined, rawBody: string | Uint8Array, sig: string | null | undefined,
  secret: string | null | undefined, nowMs: number,
): Promise<SigmaVerdict> {
  if (!secret) return { ok: false, error: "not_configured" };
  const t = (ts ?? "").trim();
  let s = (sig ?? "").trim().toLowerCase();
  if (!t || !s) return { ok: false, error: "missing_headers" };
  if (!/^\d{9,13}$/.test(t)) return { ok: false, error: "bad_timestamp" };
  const n = Number(t);
  const tsMs = t.length >= 13 ? n : n * 1000;
  if (Math.abs(nowMs - tsMs) > SIGMA_MAX_SKEW_S * 1000) return { ok: false, error: "stale" };
  if (s.startsWith("sha256=")) s = s.slice(7);
  if (!/^[0-9a-f]{64}$/.test(s)) return { ok: false, error: "bad_signature" };
  const expected = await sigmaSignature(secret, t, rawBody);
  return timingSafeEqual(s, expected) ? { ok: true } : { ok: false, error: "bad_signature" };
}

/** The HTTP status of each ingest refusal. */
export function sigmaVerdictStatus(error: string): number {
  if (error === "not_configured") return 503;
  return 401;
}

// ── money ────────────────────────────────────────────────────────────────────
/** The money keys of the contract, plus anything ending _mkd / _eur and the Sigma / CRM cost fields. */
export const STOCK_MONEY_KEYS = new Set(["cost_mkd", "value_mkd", "cod_mkd", "value_diff_mkd", "cost_price", "calc_buy_price", "cost_price_eur"]);
const MONEY_SUFFIX_RE = /(_mkd|_eur)$/;

export const isStockMoneyKey = (k: string): boolean => STOCK_MONEY_KEYS.has(k) || MONEY_SUFFIX_RE.test(k);

/** Remove every money key at any depth (the non-owner view). Never mutates its input. */
export function stripStockMoney<T>(v: T): T {
  if (Array.isArray(v)) return v.map((x) => stripStockMoney(x)) as unknown as T;
  if (isObj(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (isStockMoneyKey(k)) continue;
      out[k] = stripStockMoney(x);
    }
    return out as T;
  }
  return v;
}

/** Owners get the payload untouched, everyone else without money. */
export const moneyView = <T>(isOwner: boolean, v: T): T => (isOwner ? v : stripStockMoney(v));

// ── SQL refusals → HTTP ──────────────────────────────────────────────────────
export interface HttpError { status: number; body: { error: string; detail?: string } }

/** A code the SQL writers return in {ok:false, error} or RAISE as the message. */
export function resultErrorStatus(code: string): number {
  switch (code) {
    case "owners_only": case "forbidden": return 403;
    case "not_found": case "unknown_article": case "unknown_product": case "unknown_warehouse": case "unknown_count": return 404;
    case "disabled": case "busy": case "conflict": case "no_opening": case "already_void": case "already_approved":
    case "not_pending": case "opening_exists": case "opening_not_first": case "before_last_count": return 409;
    case "not_installed": case "not_configured": return 503;
    default: return 400;
  }
}

const detailOf = (m: unknown): string | undefined => {
  const s = typeof m === "string" ? m.trim() : "";
  return s ? s.slice(0, 300) : undefined;
};

/** A PostgREST / Postgres error of a stock RPC → status + a safe body (no schema details for 5xx). */
export function stockRpcError(err: { code?: string; message?: string } | null | undefined): HttpError {
  const code = String(err?.code ?? "");
  const msg = String(err?.message ?? "");
  // a function / table of the contract that is not there yet (its migration is not applied)
  if (code === "PGRST202" || code === "PGRST205" || code === "42883" || code === "42P01") return { status: 503, body: { error: "not_installed" } };
  if (code === "42501") return { status: 403, body: { error: "forbidden", detail: detailOf(msg) } };
  if (code === "P0002") return { status: 404, body: { error: "not_found", detail: detailOf(msg) } };
  if (code === "23505") return { status: 409, body: { error: "conflict" } };
  if (code === "55P03" || code === "40001" || code === "40P01") return { status: 409, body: { error: "busy" } };
  if (code === "57014") return { status: 504, body: { error: "timeout" } };
  if (["22023", "22P02", "22007", "22008", "22003", "23514", "23502", "23503"].includes(code)) {
    return { status: 400, body: { error: "bad_request", detail: detailOf(msg) } };
  }
  if (code === "P0001") {
    const m = msg.trim();
    if (/^[a-z][a-z0-9_]{1,40}$/.test(m)) return { status: resultErrorStatus(m), body: { error: m } };
    return { status: 400, body: { error: "bad_request", detail: detailOf(m) } };
  }
  return { status: 500, body: { error: "failed" } };
}

/** A PostgREST / Postgres error that only says "this function is not there" (its migration is not applied). */
export function isMissingFunction(err: { code?: string } | null | undefined): boolean {
  const c = String(err?.code ?? "");
  return c === "PGRST202" || c === "42883";
}

/** A jsonb result of the shape {ok:false, error} → the HTTP error; anything else is a success (null). */
export function resultError(data: unknown): HttpError | null {
  if (!isObj(data) || data.ok !== false) return null;
  const code = typeof data.error === "string" && /^[a-z][a-z0-9_]{1,40}$/.test(data.error) ? data.error : "failed";
  const body: HttpError["body"] = { error: code };
  if (typeof data.detail === "string") body.detail = data.detail.slice(0, 300);
  return { status: resultErrorStatus(code), body };
}

// ── POST stock/v2/count: warnings and refusals as CODES the UI translates ────
/**
 * The count codes the /warehouse Попис tab translates — i18n `stock2.count.warn.<code>`, where
 * "<code>:<n>" fills {{n}}. stock_v2_count_save() (…0400) already answers codes:
 *   warnings  parcels_near_count:N · no_opening · old_count (> 30 days back) ·
 *             pending_owner_approval · not_counted:N (a full count left articles out)
 *   refusals  before_last_count · opening_exists · opening_not_first ·
 *             unknown_article / whole_units_only (+ the offending lines in `bad`)
 * The aliases rename the SQL's word to the UI's (whole_units_only → kom_fraction); a code
 * the UI does not know, or free text, goes through unchanged (the UI shows it as sent).
 */
export const COUNT_CODES = [
  "parcels_near_count", "in_past", "before_last_count", "kom_fraction", "unknown_article", "opening_exists",
  "opening_not_first", "no_opening", "old_count", "pending_owner_approval", "not_counted",
] as const;
export const COUNT_CODE_ALIASES: Readonly<Record<string, string>> = { whole_units_only: "kom_fraction" };
const COUNT_CODE_RE = /^([a-z][a-z0-9_]{1,40})(:[\s\S]*)?$/;
/** At most this many article codes are named in one refusal ("unknown_article:000123, 000456 +3"). */
export const COUNT_REFUSAL_MAX_CODES = 10;

/** One warning → its code ("parcels_near_count:12"), an alias renamed; free text kept as it is; empty → null. */
export function countCode(w: unknown): string | null {
  if (typeof w !== "string") return null;
  const s = w.trim();
  if (!s) return null;
  const m = COUNT_CODE_RE.exec(s);
  if (!m) return s.slice(0, 300);
  return (COUNT_CODE_ALIASES[m[1]] ?? m[1]) + (m[2] ?? "");
}

/** StockCountResult.warnings: codes, de-duplicated, order kept. */
export function normalizeCountWarnings(v: unknown): string[] {
  const out: string[] = [];
  for (const w of Array.isArray(v) ? v : []) {
    const c = countCode(w);
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

/** A successful stock_v2_count_save() result with its warnings as codes (everything else untouched). */
export function shapeCountResult<T>(data: T): T {
  if (!isObj(data)) return data;
  return { ...data, warnings: normalizeCountWarnings(data.warnings) } as T;
}

/**
 * A refused count ({ok:false, error, bad?, last_count_at?}) → the HTTP error whose `error` is the
 * code the UI translates — with the article codes for unknown_article / kom_fraction
 * ("unknown_article:000123, 000456"), `code` = the bare code, `last_count_at` for before_last_count.
 * Not a refusal → null.
 */
export function countRefusal(data: unknown): HttpError | null {
  if (!isObj(data) || data.ok !== false) return null;
  const raw = typeof data.error === "string" ? data.error.trim() : "";
  if (!/^[a-z][a-z0-9_]{1,40}$/.test(raw)) return resultError(data);
  const code = COUNT_CODE_ALIASES[raw] ?? raw;
  let error = code;
  if (code === "unknown_article" || code === "kom_fraction") {
    const arts: string[] = [];
    for (const b of Array.isArray(data.bad) ? data.bad : []) {
      if (!isObj(b) || (b.why !== undefined && b.why !== raw)) continue;
      const c = typeof b.code === "string" ? b.code.trim() : "";
      if (c && !arts.includes(c)) arts.push(c.slice(0, 20));
    }
    if (arts.length) {
      const shown = arts.slice(0, COUNT_REFUSAL_MAX_CODES).join(", ");
      const more = arts.length - COUNT_REFUSAL_MAX_CODES;
      error = `${code}:${shown}${more > 0 ? ` +${more}` : ""}`;
    }
  }
  const body: HttpError["body"] & { code: string; last_count_at?: string } = { error, code };
  if (typeof data.detail === "string") body.detail = data.detail.slice(0, 300);
  if (code === "before_last_count" && typeof data.last_count_at === "string") body.last_count_at = data.last_count_at;
  return { status: resultErrorStatus(code), body };
}

// ── response shapes built in TS (no SQL getter in the contract) ─────────────
const num =(v: unknown): number => { const n = typeof v === "number" ? v : Number(v ?? 0); return Number.isFinite(n) ? n : 0; };
const numOrNull = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : String(v));

/** A timestamptz from PostgREST → epoch ms ('-infinity' / 'infinity' included). */
export function tsMs(v: unknown): number {
  if (v === "-infinity") return -Infinity;
  if (v === "infinity") return Infinity;
  const ms = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(ms) ? ms : NaN;
}

export interface CostRow { article_code: string; cost_mkd: unknown; valid_from: unknown; source: unknown; recorded_at?: unknown }

/**
 * The cost of each article at `atMs` — the TS twin of article_cost_at(): the newest row with
 * valid_from ≤ at; on a tie the `owner` value wins, then the latest recorded.
 */
export function pickArticleCosts(rows: CostRow[], atMs: number): Map<string, number> {
  const best = new Map<string, { vf: number; owner: boolean; rec: number; cost: number }>();
  for (const r of rows || []) {
    const vf = tsMs(r.valid_from);
    const cost = numOrNull(r.cost_mkd);
    if (Number.isNaN(vf) || vf > atMs || cost === null) continue;
    const cand = { vf, owner: r.source === "owner", rec: tsMs(r.recorded_at) || 0, cost };
    const cur = best.get(r.article_code);
    const better = !cur || cand.vf > cur.vf
      || (cand.vf === cur.vf && (cand.owner && !cur.owner || cand.owner === cur.owner && cand.rec > cur.rec));
    if (better) best.set(r.article_code, cand);
  }
  const out = new Map<string, number>();
  for (const [k, v] of best) out.set(k, v.cost);
  return out;
}

export interface ArticleRowIn { code: string; name: unknown; unit: unknown; brand: unknown; active: unknown }

/** StockArticleRow[] — `on_hand` from stock_v2_on_hand(), `cost_mkd` only when costs are given (owners). */
export function shapeArticleRows(
  rows: ArticleRowIn[], onHand: Map<string, number> | null, costs: Map<string, number> | null,
): Record<string, unknown>[] {
  return (rows || []).map((a) => {
    const out: Record<string, unknown> = {
      code: String(a.code), name: String(a.name ?? ""), unit: String(a.unit ?? ""), brand: str(a.brand),
      active: a.active !== false, on_hand: onHand ? (onHand.get(String(a.code)) ?? 0) : null,
    };
    if (costs) out.cost_mkd = costs.get(String(a.code)) ?? null;
    return out;
  });
}

/** stock_v2_on_hand() rows → code → qty. */
export function onHandMap(rows: unknown): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!isObj(r) || typeof r.article_code !== "string") continue;
    m.set(r.article_code, (m.get(r.article_code) ?? 0) + num(r.qty));
  }
  return m;
}

export interface RecipeRowIn {
  article_code: string; qty: unknown; role: unknown; status: unknown; confidence: unknown;
  valid_from?: unknown; valid_to?: unknown;
}

const STATUS_ORDER: Record<string, number> = { approved: 0, proposed: 1, rejected: 2 };
const ROLE_ORDER: Record<string, number> = { main: 0, component: 1, gift: 2 };

/**
 * ProductRecipe for GET products/:id/articles: the lines valid now or later (approved, proposed and
 * rejected), each with its article name and — for owners — its cost. `complete` = at least one approved
 * line and every approved line costed. `cost_mkd` = product_cost_at() when given, else the sum of the
 * approved lines (null when one is missing). Money keys are present only when `costs` is given.
 */
export function shapeRecipe(input: {
  product: { id: string; name: unknown };
  lines: RecipeRowIn[];
  names: Map<string, string>;
  exempt: boolean;
  costs: Map<string, number>;
  money: boolean;
  productCost?: number | null;
  nowMs: number;
}): Record<string, unknown> {
  const live = (input.lines || []).filter((l) => {
    const to = l.valid_to === undefined || l.valid_to === null ? Infinity : tsMs(l.valid_to);
    return Number.isNaN(to) || to > input.nowMs;
  });
  live.sort((a, b) =>
    (STATUS_ORDER[String(a.status)] ?? 9) - (STATUS_ORDER[String(b.status)] ?? 9)
    || (ROLE_ORDER[String(a.role)] ?? 9) - (ROLE_ORDER[String(b.role)] ?? 9)
    || String(a.article_code).localeCompare(String(b.article_code)));
  const approved = live.filter((l) => l.status === "approved");
  const complete = approved.length > 0 && approved.every((l) => input.costs.has(l.article_code));
  const lines = live.map((l) => {
    const out: Record<string, unknown> = {
      code: l.article_code,
      name: input.names.get(l.article_code) ?? "",
      qty: num(l.qty),
      role: oneOf(l.role, RECIPE_ROLES) ? l.role : "main",
      status: oneOf(l.status, ["proposed", "approved", "rejected"] as const) ? l.status : "proposed",
      confidence: str(l.confidence),
    };
    if (input.money) out.cost_mkd = input.costs.get(l.article_code) ?? null;
    return out;
  });
  const res: Record<string, unknown> = {
    product_id: input.product.id,
    product_name: String(input.product.name ?? ""),
    exempt: input.exempt,
    lines,
    complete,
  };
  if (input.money) {
    const summed = complete
      ? Math.round(approved.reduce((s, l) => s + num(l.qty) * (input.costs.get(l.article_code) ?? 0), 0) * 10_000) / 10_000
      : null;
    res.cost_mkd = input.productCost !== undefined ? input.productCost : summed;
  }
  return res;
}

export interface ConfigInput {
  settings: unknown;
  warehouses: Record<string, unknown>[];
  keys: Record<string, unknown>[];
  routes: Record<string, unknown>[];
  rules: Record<string, unknown>[];
}

/**
 * StockConfig. Owners see everything; the other stock roles only the warehouses (the picker) and
 * whether v2 is on — no routes, no Sigma rules, no other setting.
 */
export function shapeConfig(input: ConfigInput, full: boolean): Record<string, unknown> {
  const whById = new Map<number, string>();
  for (const w of input.warehouses || []) whById.set(num(w.id), String(w.code ?? ""));
  const keysBy = new Map<number, { system: string; key: string }[]>();
  for (const k of input.keys || []) {
    const id = num(k.warehouse_id);
    if (!keysBy.has(id)) keysBy.set(id, []);
    keysBy.get(id)!.push({ system: String(k.system ?? ""), key: String(k.key ?? "") });
  }
  const warehouses = [...(input.warehouses || [])]
    .sort((a, b) => num(a.sort) - num(b.sort) || String(a.code).localeCompare(String(b.code)))
    .map((w) => ({
      id: num(w.id), code: String(w.code ?? ""), name: String(w.name ?? ""), role: String(w.role ?? ""),
      tracked: w.tracked === true, sellable: w.sellable === true, active: w.active !== false,
      sigma_moves_from: str(w.sigma_moves_from),
      keys: full ? (keysBy.get(num(w.id)) ?? []) : [],
    }));
  const settings = isObj(input.settings) ? input.settings : {};
  if (!full) return { settings: { enabled: settings.enabled === true }, warehouses, routes: [], sigma_rules: [] };
  const routes = [...(input.routes || [])]
    .sort((a, b) => num(a.priority) - num(b.priority) || num(a.id) - num(b.id))
    .map((r) => ({
      id: num(r.id), priority: num(r.priority),
      match_account: str(r.match_account), match_series: str(r.match_series), match_shape: str(r.match_shape),
      warehouse: whById.get(num(r.warehouse_id)) ?? null,
      return_warehouse: r.return_warehouse_id === null || r.return_warehouse_id === undefined ? null : whById.get(num(r.return_warehouse_id)) ?? null,
      valid_from: str(r.valid_from), valid_to: str(r.valid_to), active: r.active !== false,
    }));
  const sigma_rules = [...(input.rules || [])]
    .sort((a, b) => num(a.id) - num(b.id))
    .map((r) => ({
      id: num(r.id), match: isObj(r.match) ? r.match : {}, action: r.action === "include" ? "include" : "exclude",
      reason: String(r.reason ?? ""), active: r.active !== false,
    }));
  return { settings, warehouses, routes, sigma_rules };
}

export interface SigmaStatusInput {
  settings: StockV2Settings;
  configured: boolean;
  batches: Record<string, unknown>[];
  docs: { staged: number; excluded: number; vanished: number; versions_gt1: number; drafts: number };
}

/** GET stock/v2/sigma/status: the switch, whether the secret is set (never its value), the last batches, the staging counts. */
export function shapeSigmaStatus(input: SigmaStatusInput): Record<string, unknown> {
  const batches = (input.batches || []).map((b) => ({
    batch_id: String(b.batch_id ?? ""), source: str(b.source), mode: str(b.mode),
    exported_at: str(b.exported_at), window_from: str(b.window_from), window_to: str(b.window_to),
    received_at: str(b.received_at), counts: isObj(b.counts) ? b.counts : {}, result: isObj(b.result) ? b.result : {},
  }));
  const seen = (src: string) => batches.filter((b) => b.source === src).map((b) => b.received_at).filter(Boolean).sort().pop() ?? null;
  return {
    enabled: input.settings.enabled,
    ingest: input.settings.sigma.ingest,
    apply_on_ingest: input.settings.sigma.apply_on_ingest,
    costs_follow: input.settings.sigma.costs_follow,
    configured: input.configured,
    last_batch_at: batches.map((b) => b.received_at).filter(Boolean).sort().pop() ?? null,
    connector_last_seen: seen("connector"),
    csv_last_seen: seen("csv"),
    docs: {
      staged: num(input.docs.staged), excluded: num(input.docs.excluded), vanished: num(input.docs.vanished),
      versions_gt1: num(input.docs.versions_gt1), drafts: num(input.docs.drafts),
    },
    batches,
  };
}

export interface WarehouseRow { code: unknown; name: unknown; role: unknown; tracked: unknown; active?: unknown; sort?: unknown }

/**
 * StockHealth.warehouses — the ACTIVE warehouses as StockWarehouseRef (code, name, role, tracked), by
 * sort then code. No money and no keys / routes, so every stock role gets it: the warehouse pickers of
 * a non-owner no longer depend on the owners-only configuration.
 */
export function shapeWarehouseRefs(rows: WarehouseRow[] | null | undefined): { code: string; name: string; role: string; tracked: boolean }[] {
  return [...(rows || [])]
    .filter((w) => w && w.active !== false && typeof w.code === "string" && w.code !== "")
    .sort((a, b) => num(a.sort) - num(b.sort) || String(a.code).localeCompare(String(b.code)))
    .map((w) => ({ code: String(w.code), name: String(w.name ?? ""), role: String(w.role ?? ""), tracked: w.tracked === true }));
}

const COUNT_KIND_SET = new Set<string>(COUNT_KINDS);
const COUNT_STATUS_SET = new Set(["pending", "approved", "void"]);

/**
 * GET stock/v2/counts → StockCountHistoryRow[] from stock_v2_counts() (…0510): exactly the contract's
 * keys; `value_diff_mkd` only when `money` (owners) — never for anyone else, whatever the SQL sent.
 */
export function shapeCountHistory(data: unknown, money: boolean): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const r of Array.isArray(data) ? data : []) {
    if (!isObj(r) || typeof r.id !== "string") continue;
    const row: Record<string, unknown> = {
      id: r.id,
      warehouse: String(r.warehouse ?? ""),
      counted_at: str(r.counted_at),
      kind: COUNT_KIND_SET.has(String(r.kind)) ? r.kind : "partial",
      source: String(r.source ?? "manual"),
      status: COUNT_STATUS_SET.has(String(r.status)) ? r.status : "pending",
      packed_counted: r.packed_counted === true,
      lines: num(r.lines),
      diff_units: numOrNull(r.diff_units),
      note: str(r.note),
      created_by_name: str(r.created_by_name),
      created_at: str(r.created_at),
      approved_by_name: str(r.approved_by_name),
      approved_at: str(r.approved_at),
      void_reason: str(r.void_reason),
    };
    if (money) row.value_diff_mkd = numOrNull(r.value_diff_mkd);
    out.push(row);
  }
  return out;
}
