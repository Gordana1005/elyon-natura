// ============================================================================
// Connected Overview — the pure half of GET /api/insights/overview, GET
// /api/insights/pivot and the Overview drill-down filters of GET /api/orders.
//
// Dependency-free on purpose (no Deno globals, no URL imports): vitest runs
// overview.test.ts against this file in Node, and index.ts imports it.
//
// What lives here, and why it is not inline in index.ts:
//   overviewWindows()      Skopje calendar days → the exact instants the RPC
//                          AND the /orders drill-down both use. One function,
//                          so an Overview number and the list it opens can
//                          never disagree about where a day starts or ends.
//   stripOverviewMoney()   the non-owner view: a WHITELIST of non-money keys.
//                          A money field added to the RPC later is dropped for
//                          non-owners by default — it has to be allowed here
//                          on purpose to leak.
//   outcomeOrFilter() / soldWindowOrFilter()
//                          the PostgREST twins of insights_overview's bucket
//                          and SOLD-clock predicates (migration
//                          20260936000000). Change one → change the other.
// ============================================================================

export const OVERVIEW_SOURCES = ["altercpa", "elyon_crm", "web", "teleshop_other"] as const;

/** orders.sale_source vocabulary (migration 20260935000000). */
export const SALE_SOURCES = ["altercpa", "web", "elyon_crm", "collabbox", "affiliate", "legacy"] as const;

/** insights_pivot dimensions (migration 20260936000000). */
export const PIVOT_DIMENSIONS = ["source", "detail", "team", "person", "list", "webmaster", "stream", "product", "city"] as const;

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A sale_source_detail value we are willing to put into a PostgREST filter. */
const DETAIL_RE = /^[a-z0-9_.\-]{1,40}$/i;
const MAX_WINDOW_DAYS = 731;

// ── Skopje calendar ─────────────────────────────────────────────────────────

const SKOPJE_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "Europe/Skopje", hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
});

function skopjeParts(ms: number) {
  const p: Record<string, string> = {};
  for (const x of SKOPJE_PARTS.formatToParts(new Date(ms))) p[x.type] = x.value;
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}

/** Skopje wall clock minus UTC at an instant: +1 h in winter, +2 h in summer. */
function skopjeOffsetMs(ms: number): number {
  const t = Math.floor(ms / 1000) * 1000;
  const p = skopjeParts(t);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - t;
}

/** A Skopje wall-clock time → the UTC epoch ms it names. DST-exact, including
 *  the two changeover days (a noon probe gets their midnight wrong by 1 h). */
function skopjeWallToUtcMs(y: number, mo: number, d: number, h = 0, mi = 0): number {
  const wall = Date.UTC(y, mo - 1, d, h, mi, 0);
  let t = wall - skopjeOffsetMs(wall);
  const off = skopjeOffsetMs(t);
  if (wall - off !== t) t = wall - off;
  return t;
}

export function isValidYmd(s: unknown): s is string {
  if (typeof s !== "string" || !YMD_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function addDaysYmd(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Calendar days from `from` to `to`, both inclusive (1 for a single day). */
export function daysInclusive(from: string, to: string): number {
  const a = Date.parse(from + "T00:00:00Z");
  const b = Date.parse(to + "T00:00:00Z");
  return Math.round((b - a) / 86_400_000) + 1;
}

export function skopjeTodayYmd(now: Date = new Date()): string {
  const p = skopjeParts(now.getTime());
  return `${p.y}-${String(p.mo).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/** Skopje 00:00 of a calendar day, as a UTC ISO instant. */
export function skopjeMidnightIso(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(skopjeWallToUtcMs(y, m, d)).toISOString();
}

/** The LAST instant of a Skopje calendar day (23:59:59.999999 local) as a UTC
 *  ISO string with microseconds. Used as an inclusive `<=` bound, it leaves no
 *  gap before the next day's midnight (a …59.000 bound drops the final second). */
export function skopjeDayEndIso(ymd: string): string {
  const next = Date.parse(skopjeMidnightIso(addDaysYmd(ymd, 1)));
  return new Date(next - 1).toISOString().replace(/Z$/, "999Z");
}

// ── windows ─────────────────────────────────────────────────────────────────

export interface OverviewWindow {
  from: string;           // Skopje day, inclusive
  to: string;             // Skopje day, inclusive (clamped to today)
  days: number;
  fromIso: string;        // → p_from and created_from
  toEndIso: string;       // → p_to_end and created_to
  partial: boolean;       // the window ends today: the day is not over yet
  prev: null | { from: string; to: string; fromIso: string; toEndIso: string };
}

/**
 * Resolves ?from&to&compare into instants. Bare dates are Skopje days.
 * Missing dates default to today; a range reaching into the future is clamped
 * to today. The previous period has the same number of days and ends the day
 * before `from`; when the current window ends today (a partial day), the
 * previous one is cut at the same elapsed time, so "today so far" is compared
 * with "yesterday by this time" and not with a whole day.
 */
export function overviewWindows(
  fromRaw: string | null,
  toRaw: string | null,
  compare: boolean,
  now: Date = new Date(),
): OverviewWindow | { error: string } {
  const today = skopjeTodayYmd(now);
  let from = fromRaw && fromRaw.trim() ? fromRaw.trim() : today;
  let to = toRaw && toRaw.trim() ? toRaw.trim() : (fromRaw && fromRaw.trim() ? from : today);
  if (!isValidYmd(from) || !isValidYmd(to)) return { error: "from/to must be YYYY-MM-DD" };
  if (from > to) return { error: "from is after to" };
  if (to > today) to = today;
  if (from > today) from = today;
  const days = daysInclusive(from, to);
  if (days > MAX_WINDOW_DAYS) return { error: `window longer than ${MAX_WINDOW_DAYS} days` };

  const fromIso = skopjeMidnightIso(from);
  const toEndIso = skopjeDayEndIso(to);
  const partial = to === today;

  let prev: OverviewWindow["prev"] = null;
  if (compare) {
    const pFrom = addDaysYmd(from, -days);
    const pTo = addDaysYmd(from, -1);
    const pFromIso = skopjeMidnightIso(pFrom);
    let pToEndIso = skopjeDayEndIso(pTo);
    if (partial) {
      const elapsed = Math.max(0, now.getTime() - Date.parse(fromIso));
      const cut = Date.parse(pFromIso) + elapsed;
      if (cut < Date.parse(pToEndIso)) pToEndIso = new Date(cut).toISOString();
    }
    prev = { from: pFrom, to: pTo, fromIso: pFromIso, toEndIso: pToEndIso };
  }
  return { from, to, days, fromIso, toEndIso, partial, prev };
}

// ── the money strip (non-owner admins and managers) ─────────────────────────

/**
 * Every key a non-owner may receive, at any depth. Anything else — every
 * *_eur / *_mkd figure, `money`, `spark`, `value_eur`, `cod_mkd`, and any key a
 * future migration adds — is removed. Counts, rates, names, times and drill
 * filters stay (contract 2026-09-28: "the same payload without money").
 */
const NON_MONEY_KEYS = new Set<string>([
  // envelope
  "meta", "window", "freshness", "kpis", "sources", "trend", "teams", "attention",
  "from", "to", "to_end", "prev_from", "prev_to", "prev_to_end", "days", "granularity",
  "generated_at", "money_visible", "partial",
  // freshness
  "feed", "last_ok_at", "status", "detail", "last_run_status", "status_sync_ok_at", "data_through",
  // kpis
  "placed", "confirmed", "at_courier", "delivered", "to_collect", "lost", "unproven_paid", "prev",
  "count", "proven_count", "unproven_count", "mex_only_count",
  // sources
  "key", "buckets", "cash", "worked", "cohort_sold", "conversion", "splits", "drill", "web_block", "placed_shop",
  "awaiting", "preparing", "packed", "courier", "returned", "cancelled", "trashed", "no_record", "mex_only",
  "basis", "sold_count", "bought_before", "sale_source",
  // trend
  "points", "bucket", "by_source", "placed_count", "delivered_count",
  "altercpa", "elyon_crm", "web", "teleshop_other",
  // teams
  "team_key", "name", "mode", "online_now", "break_now", "unmapped_decisions", "members",
  "person_id", "user_id", "is_manager", "role", "online_state",
  "online_min", "active_min", "idle_min", "break_min", "first_active", "last_active", "idle_alerts",
  "sales_decisions", "last_decision_at",
  // attention
  "kind", "severity", "windows", "by_person", "by_status", "by_account", "sample",
  "status_id", "status_name", "account", "series",
  "display_id", "tracking_id", "at", "person", "note",
]);
const MONEY_KEY_RE = /(_eur|_mkd)$/;

function stripValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripValue);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (!NON_MONEY_KEYS.has(k) || MONEY_KEY_RE.test(k)) continue;
      out[k] = stripValue(x);
    }
    return out;
  }
  return v;
}

/** The Overview without a single money figure. `meta.money` is set to false. */
export function stripOverviewMoney<T extends Record<string, unknown>>(payload: T): Record<string, unknown> {
  const out = stripValue(payload) as Record<string, unknown>;
  const meta = (out.meta && typeof out.meta === "object") ? out.meta as Record<string, unknown> : {};
  out.meta = { ...meta, money: false };
  return out;
}

/** The response of GET /api/insights/overview: meta + the RPC body, money
 *  stripped unless the caller is a business owner. */
export function buildOverviewResponse(
  rpc: Record<string, unknown> | null,
  win: OverviewWindow,
  isOwner: boolean,
  now: Date = new Date(),
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    meta: {
      from: win.from,
      to: win.to,
      prev_from: win.prev?.from ?? null,
      prev_to: win.prev?.to ?? null,
      prev_to_end: win.prev?.toEndIso ?? null,
      partial: win.partial,
      days: win.days,
      generated_at: now.toISOString(),
      money: isOwner,
    },
    ...(rpc ?? {}),
  };
  return isOwner ? body : stripOverviewMoney(body);
}

// ── /orders drill-down filters ─────────────────────────────────────────────

/** PostgREST `or=(…)` clauses per Overview bucket — the twins of the CASE in
 *  insights_overview. Compound outcomes (to_collect, lost, …) expand to their
 *  buckets so a tile's link lists exactly what the tile counted. */
const OUTCOME_CLAUSES: Record<string, string[]> = {
  awaiting: ["status.in.(pending,take,call_again,duplicated)"],
  preparing: ["and(status.eq.confirmed,packed_at.is.null)"],
  packed: ["and(status.eq.confirmed,packed_at.not.is.null)"],
  courier: ["status.eq.shipped"],
  delivered: ["status.in.(paid,delivered)"],
  returned: ["status.eq.returned"],
  cancelled: ["status.eq.cancelled"],
  trashed: ["status.eq.trashed"],
  // money groups
  to_collect: ["status.in.(confirmed,shipped)"],
  lost: ["status.eq.returned", "and(status.in.(cancelled,trashed),sold_at.not.is.null)"],
  cancelled_after_confirm: ["and(status.in.(cancelled,trashed),sold_at.not.is.null)"],
};
export const OUTCOMES = Object.keys(OUTCOME_CLAUSES);

export type CsvResult = { ok: true; values: string[] } | { ok: false; bad: string };

/** A comma-separated query param → distinct non-empty values, each checked
 *  against `allowed` (a list) or a pattern. Empty/absent → ok with []. */
export function parseCsvParam(raw: string | null, allowed: readonly string[] | RegExp): CsvResult {
  if (raw == null || raw.trim() === "" || raw.trim() === "all") return { ok: true, values: [] };
  const values = [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
  for (const v of values) {
    const good = Array.isArray(allowed) ? allowed.includes(v) : (allowed as RegExp).test(v);
    if (!good) return { ok: false, bad: v };
  }
  return { ok: true, values };
}

export const parseDetailParam = (raw: string | null): CsvResult => parseCsvParam(raw, DETAIL_RE);

export function isUuid(s: unknown): s is string {
  return typeof s === "string" && UUID_PATTERN.test(s);
}

/** outcome=a,b → one PostgREST `or` expression, or null when nothing to filter. */
export function outcomeOrFilter(outcomes: string[]): string | null {
  const clauses: string[] = [];
  for (const o of outcomes) for (const c of OUTCOME_CLAUSES[o] ?? []) if (!clauses.includes(c)) clauses.push(c);
  return clauses.length ? clauses.join(",") : null;
}

/** The SOLD clock as a PostgREST `or` expression — the twin of
 *  insights_overview's sale_at: sold_at; for an uncredited sale confirmed_at,
 *  else created_at; never the 0 ден disposition rows. Bounds are inclusive. */
export function soldWindowOrFilter(fromIso: string, toEndIso: string): string {
  const notDisposition = "or(sale_source_detail.is.null,sale_source_detail.neq.disposition)";
  const saleStatus = "status.in.(confirmed,shipped,delivered,paid,returned)";
  return [
    `and(${notDisposition},sold_at.gte.${fromIso},sold_at.lte.${toEndIso})`,
    `and(${notDisposition},sold_at.is.null,${saleStatus},confirmed_at.gte.${fromIso},confirmed_at.lte.${toEndIso})`,
    `and(${notDisposition},sold_at.is.null,${saleStatus},confirmed_at.is.null,created_at.gte.${fromIso},created_at.lte.${toEndIso})`,
  ].join(",");
}

/** The CASH clock as a PostgREST `or` expression — the twin of
 *  insights_overview's cash_at for orders: delivered orders by the MEX
 *  delivery instant when proven, else paid_at, else created_at. */
export function cashWindowOrFilter(fromIso: string, toEndIso: string): string {
  const delivered = "status.in.(paid,delivered)";
  return [
    `and(${delivered},mex_delivered_at.gte.${fromIso},mex_delivered_at.lte.${toEndIso})`,
    `and(${delivered},mex_delivered_at.is.null,paid_at.gte.${fromIso},paid_at.lte.${toEndIso})`,
    `and(${delivered},mex_delivered_at.is.null,paid_at.is.null,created_at.gte.${fromIso},created_at.lte.${toEndIso})`,
  ].join(",");
}

/** proof=mex|unproven: a delivered order with / without a delivered MEX parcel. */
export const PROOF_VALUES = ["mex", "unproven"] as const;

/** orders.paid_basis vocabulary (migration 20260934000200). */
export const PAID_BASIS_VALUES = ["mex", "operator_ruling", "legacy_import", "manual", "unproven"] as const;

/** A free-text equality filter value (list / product / city names). */
export function isSafeText(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= 200 && !/[\u0000-\u001f]/.test(v);
}

/** attention=<kind> kinds that are a filter over `orders`. The rest
 *  (cod_mismatch, night_approvals, burst_approvals, unlinked_parcels,
 *  stale_feed, web_waiting_24h) are arithmetic across columns, live in other
 *  tables, or are not orders at all — the rail shows their samples instead. */
export const LISTABLE_ATTENTION = ["approved_no_parcel_7d", "mex_problem"] as const;

export interface AttentionFilter {
  eq: Record<string, string>;
  in: Record<string, (string | number)[]>;
  isNull: string[];
  or: string[];
}

/** The PostgREST twin of insights_overview's `anp` / `mp` CTEs ("as of now"). */
export function attentionFilter(kind: string, now: Date = new Date()): AttentionFilter | null {
  if (kind === "approved_no_parcel_7d") {
    const cut = new Date(now.getTime() - 7 * 86_400_000).toISOString();
    return {
      eq: { status: "confirmed" },
      in: { sale_source: ["altercpa", "affiliate"] },
      isNull: ["mex_tracking_id"],
      or: [
        [`and(sold_at.not.is.null,sold_at.lt.${cut})`,
         `and(sold_at.is.null,confirmed_at.not.is.null,confirmed_at.lt.${cut})`,
         `and(sold_at.is.null,confirmed_at.is.null,created_at.lt.${cut})`].join(","),
        `ship_after_date.is.null,ship_after_date.lte.${skopjeTodayYmd(now)}`,
      ],
    };
  }
  if (kind === "mex_problem") {
    return { eq: {}, in: { mex_status_id: [3, 9, 13] }, isNull: [], or: [] };
  }
  return null;
}

/** by=source,team → validated pivot dimensions (1–4, known, de-duplicated). */
export function parsePivotBy(raw: string | null): CsvResult {
  const r = parseCsvParam(raw, PIVOT_DIMENSIONS);
  if (!r.ok) return r;
  if (r.values.length === 0) return { ok: false, bad: "(empty)" };
  if (r.values.length > 4) return { ok: false, bad: "(more than 4 dimensions)" };
  return r;
}
