// ============================================================================
// /orders — the collabBox BOOKINGS beside the orders (owner, Mile, 02.10.2026:
// "Треба да се гледат да").
//
// A booking = a collabBox order document whose MEX parcel does not exist yet.
// It becomes a CRM order only once MEX creates the parcel (usually the next
// morning), but it is a sale NOW: the Overview cohort and the TV leaderboard
// count it in its folder's department, credited to its author. /orders lists
// only real order rows, so on a filter like "Телешоп – Lead out · today" it
// showed 0 orders while the board showed the sales. GET /orders/bookings lists
// them beside the orders, with the list's own filters.
//
// ONE calculation: the rows are insights_sale_rows' kind = 'booking' rows (the
// cohort's own), never re-derived here. This module only windows, enriches
// (collabbox_documents, sales_people), filters, scopes, masks and counts.
//
// It also carries the pure half of the collabBox entry rule badge on the orders
// list (crm_sale_collab_states — 20260947000200, 5 days for every sale since
// 20260947001900): which rows of a page to ask about, and the `collab` field
// each one gets.
//
// Dependency-free on purpose (vitest runs ordersBookings.test.ts in Node).
// ============================================================================

import { INSIGHTS_SOURCES } from "./insightsCommon.ts";
import { parseOrdersListParams, type SearchSpec } from "./ordersList.ts";
import { addDaysYmd, skopjeDayEndIso, skopjeMidnightIso, skopjeYmd } from "./skopjeTime.ts";

// ── the window ──────────────────────────────────────────────────────────────

/**
 * How far back a booking can exist, in Skopje days INCLUDING today. The writer
 * waits on a document for 14 days after its DATE (collabbox_retry_open — the
 * date is the dispatch day), and a document can be booked up to 14 days before
 * it is dated (the frequent pass reads 14 days ahead). The cohort counts a
 * booking on its BOOKING day (collabbox_sale_at), so a booking can be up to
 * 14 + 14 days old: on 02.10.2026 one waiting booking was booked on 15.09 —
 * 17 days back, beyond a plain 15-day window.
 */
export const BOOKINGS_LOOKBACK_DAYS = 29;

export interface BookingsParams {
  dayFrom: string | null;
  dayTo: string | null;
  departments: string[];
  sellerId: string | null;
  search: SearchSpec | null;
}

export type BookingsParse = { ok: true; value: BookingsParams } | { ok: false; error: string };

/** The list's own parser (ordersList.ts): day_from / day_to, dept, seller,
 *  search — validated exactly like GET /orders, so a link that the list
 *  accepts is accepted here and vice versa. */
export function parseBookingsParams(sp: URLSearchParams): BookingsParse {
  const p = parseOrdersListParams(sp);
  if (!p.ok) return p;
  const v = p.value;
  return { ok: true, value: { dayFrom: v.dayFrom, dayTo: v.dayTo, departments: v.departments, sellerId: v.sellerId, search: v.search } };
}

export type BookingsWindow =
  | { empty: false; from: string; to: string; clamped: boolean }
  | { empty: true; clamped: boolean };

/**
 * The asked Skopje days ∩ the days a booking can exist (today and the
 * BOOKINGS_LOOKBACK_DAYS − 1 before it). `clamped` = the asked window started
 * earlier (or was open) and was cut to the lookback. A window wholly before the
 * lookback, or after today, is empty (no RPC call).
 */
export function bookingsWindow(p: Pick<BookingsParams, "dayFrom" | "dayTo">, today: string): BookingsWindow {
  const earliest = addDaysYmd(today, -(BOOKINGS_LOOKBACK_DAYS - 1));
  const clamped = !p.dayFrom || p.dayFrom < earliest;
  const from = p.dayFrom && p.dayFrom > earliest ? p.dayFrom : earliest;
  const to = p.dayTo && p.dayTo < today ? p.dayTo : today;
  if (from > to) return { empty: true, clamped };
  return { empty: false, from, to, clamped };
}

/** insights_sale_rows' arguments for a window (Skopje days → UTC instants). */
/** orders_bookings_rows' arguments (20260947000700 — insights_sale_rows kind = 'booking' only, so the PostgREST
 *  1.000-row cap never cuts the bookings off behind a week's orders). */
export function saleRowsArgs(w: { from: string; to: string }): { p_from: string; p_to_end: string } {
  return { p_from: skopjeMidnightIso(w.from), p_to_end: skopjeDayEndIso(w.to) };
}

// ── the rows ────────────────────────────────────────────────────────────────

/** The insights_sale_rows columns this endpoint reads. */
export interface SaleRow {
  kind: string;
  source: string | null;
  sale_at: string | null;
  value_mkd: number | string | null;
  person_id: string | null;
  display_id: string | null;
  phone8: string | null;
}

/** The collabbox_documents columns this endpoint reads. */
export interface CollabDocRow {
  doc_number: string;
  doc_type_id: string | null;
  doc_type_name: string | null;
  komitent_name: string | null;
  booked_at: string | null;
  doc_at: string | null;
  amount_mkd: number | string | null;
}

/** One booking as GET /orders/bookings answers it. */
export interface BookingRow {
  /** The collabBox DocNumber — the MEX tracking id its parcel will carry. */
  doc_number: string;
  /** The folder (document type name), e.g. "Нарачка out". */
  folder: string | null;
  doc_type_id: string | null;
  /** One of the six departments (insights_sale_rows.source). */
  department: string | null;
  /** THE booking instant the cohort counts it at (collabbox_sale_at). */
  booked_at: string | null;
  /** collabBox's own date — the dispatch day (Skopje YYYY-MM-DD). */
  dispatch_day: string | null;
  customer_name: string | null;
  phone8: string | null;
  /** денари (the document's amount). */
  value_mkd: number;
  seller_person_id: string | null;
  seller_name: string | null;
}

/** The cohort's booking rows, each document once. */
export function bookingSaleRows(rows: readonly SaleRow[] | null | undefined): SaleRow[] {
  const seen = new Set<string>();
  const out: SaleRow[] = [];
  for (const r of rows ?? []) {
    if (r?.kind !== "booking" || !r.display_id || seen.has(r.display_id)) continue;
    seen.add(r.display_id);
    out.push(r);
  }
  return out;
}

const num = (v: number | string | null | undefined): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * A booking row from the cohort row + its document + its author's name. The
 * cohort decides the department, the time and the value; the document adds
 * the folder, the customer and the dispatch day.
 */
export function buildBookingRows(
  sale: readonly SaleRow[],
  docs: ReadonlyMap<string, CollabDocRow>,
  names: ReadonlyMap<string, string>,
): BookingRow[] {
  return sale.map((s) => {
    const d = docs.get(s.display_id!) ?? null;
    return {
      doc_number: s.display_id!,
      folder: d?.doc_type_name ?? null,
      doc_type_id: d?.doc_type_id ?? null,
      department: s.source ?? null,
      booked_at: s.sale_at ?? d?.booked_at ?? null,
      dispatch_day: d?.doc_at ? skopjeYmd(d.doc_at) || null : null,
      customer_name: d?.komitent_name?.trim() || null,
      phone8: s.phone8 && /^\d{8}$/.test(s.phone8) ? s.phone8 : null,
      value_mkd: Math.round(num(s.value_mkd ?? d?.amount_mkd)),
      seller_person_id: s.person_id ?? null,
      seller_name: s.person_id ? names.get(s.person_id) ?? null : null,
    };
  });
}

// ── filters, scope, order ───────────────────────────────────────────────────

export interface BookingsFilter {
  departments: readonly string[];
  sellerId: string | null;
  search: SearchSpec | null;
  /**
   * The caller's own sales people, or null = everyone. GET /orders shows a
   * caller who is not an admin / manager only the orders RLS lets them see
   * (assigned_agent_id = auth.uid()); a booking has no assignee, so its
   * owner is its author (sales_people.user_id = the caller).
   */
  scopePersonIds: readonly string[] | null;
}

const fold = (s: string | null | undefined) => (s ?? "").normalize("NFC").toLowerCase();

/** Does a booking match the search box (the list's SearchSpec)? */
export function matchesSearch(r: BookingRow, s: SearchSpec | null): boolean {
  if (!s) return true;
  switch (s.kind) {
    case "phone": return r.phone8 === s.last8;
    case "tracking": return r.doc_number === s.id;
    case "text": {
      const q = fold(s.text);
      return fold(r.customer_name).includes(q) || fold(r.doc_number).includes(q);
    }
  }
}

export function filterBookings(rows: readonly BookingRow[], f: BookingsFilter): BookingRow[] {
  const depts = new Set(f.departments);
  const scope = f.scopePersonIds ? new Set(f.scopePersonIds) : null;
  return rows.filter((r) =>
    (!depts.size || (r.department != null && depts.has(r.department)))
    && (!f.sellerId || r.seller_person_id === f.sellerId)
    && (!scope || (r.seller_person_id != null && scope.has(r.seller_person_id)))
    && matchesSearch(r, f.search));
}

/** Newest booking first; the document number breaks a tie (stable output). */
export function sortBookings(rows: readonly BookingRow[]): BookingRow[] {
  return [...rows].sort((a, b) => {
    const ta = a.booked_at ? Date.parse(a.booked_at) : 0;
    const tb = b.booked_at ? Date.parse(b.booked_at) : 0;
    return tb - ta || (a.doc_number < b.doc_number ? 1 : a.doc_number > b.doc_number ? -1 : 0);
  });
}

/** Count per department, in the owner's order (no money: the page shows no totals). */
export function countByDepartment(rows: readonly BookingRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of INSIGHTS_SOURCES) {
    const n = rows.filter((r) => r.department === k).length;
    if (n) out[k] = n;
  }
  return out;
}

// ── PII: the same masks GET /orders applies (index.ts redactCustomer) ──────

export interface BookingPiiFlags { name: boolean; phone: boolean }

/** "Марија Петровска" → "Марија П." (index.ts maskNameValue). */
export function maskName(v: string | null): string | null {
  if (v == null) return null;
  const parts = v.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return parts[0] ?? "";
  return parts[0] + " " + parts.slice(1).map((s) => (s[0] || "") + ".").join(" ");
}

/** "70123456" → "•••••456" (index.ts maskPhoneValue). */
export function maskPhone(v: string | null): string | null {
  if (v == null) return null;
  const d = v.replace(/\D/g, "");
  if (!d) return "";
  return d.length <= 3 ? "•".repeat(d.length) : "•".repeat(d.length - 3) + d.slice(-3);
}

export function redactBookings(rows: readonly BookingRow[], f: BookingPiiFlags): BookingRow[] {
  if (f.name && f.phone) return [...rows];
  return rows.map((r) => ({
    ...r,
    customer_name: f.name ? r.customer_name : maskName(r.customer_name),
    phone8: f.phone ? r.phone8 : maskPhone(r.phone8),
  }));
}

// ── the response ────────────────────────────────────────────────────────────

export interface BookingsResponse {
  rows: BookingRow[];
  total: number;
  by_department: Record<string, number>;
  clamped: boolean;
  /** The Skopje days actually read (null when the window was empty). */
  window: { from: string; to: string } | null;
  lookback_days: number;
}

export function bookingsResponse(rows: readonly BookingRow[], w: BookingsWindow): BookingsResponse {
  const sorted = sortBookings(rows);
  return {
    rows: sorted,
    total: sorted.length,
    by_department: countByDepartment(sorted),
    clamped: w.clamped,
    window: w.empty ? null : { from: w.from, to: w.to },
    lookback_days: BOOKINGS_LOOKBACK_DAYS,
  };
}

/** Splits a list into chunks of at most `size` (the `in (…)` reads and the RPC's ≤ 200 ids). */
export function chunks<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// ── the collabBox entry rule badge (20260947000200 / 1900: 5 days, every sale) ─

/** crm_sale_collab_states' row. */
export interface CollabStateRow {
  order_id: string;
  collab_doc: string | null;
  sale_day: string | null;
  cancel_day: string | null;
  mode: string | null;
  /** 20260947000500: the department the seller's team already decides (NULL / absent = the booking / parcel decides). */
  team_dept?: string | null;
}

/** The `collab` field a list row gets. */
export interface OrderCollab {
  /** The collabBox document that proves the sale is entered, or null. */
  doc: string | null;
  sale_day: string | null;
  /** The Skopje day the rule cancels it at 21:20 (apply mode only). */
  cancel_day: string | null;
  mode: "report" | "apply";
  /** The seller's line team already decides the department (owner 02.10.2026) — never provisional. */
  team_decides: boolean;
}

/** The RPC's own limit (crm_sale_collab_states raises above 200). */
export const COLLAB_STATES_MAX_IDS = 200;

/** The statuses the rule reads as a sale still waiting for its parcel. */
const COLLAB_RULE_STATUSES = new Set(["confirmed", "shipped"]);

/**
 * The rows of a page worth asking about — the rule's population (owner
 * 03.10.2026, "од секаде"): a sale (confirmed, or shipped in the CRM) with no
 * MEX parcel, a price, not made by collabBox itself (external_source
 * 'collabbox'), not a web-shop order (sale_source 'web'), not a /calls
 * disposition — whatever its intake (CRM, AlterCPA, partner …). The RPC's own
 * WHERE, so it is never asked about rows it would drop anyway; it re-checks.
 */
export function collabCandidateIds(orders: readonly Record<string, unknown>[]): string[] {
  const out: string[] = [];
  for (const o of orders) {
    if (COLLAB_RULE_STATUSES.has(String(o.status ?? "")) && !o.mex_tracking_id
      && o.external_source !== "collabbox" && o.sale_source !== "web"
      && o.sale_source_detail !== "disposition" && Number(o.price ?? 0) > 0 && typeof o.id === "string") {
      out.push(o.id);
    }
  }
  return out;
}

/** order id → its `collab` field. */
export function collabById(rows: readonly CollabStateRow[] | null | undefined): Record<string, OrderCollab> {
  const out: Record<string, OrderCollab> = {};
  for (const r of rows ?? []) {
    if (!r?.order_id) continue;
    out[r.order_id] = {
      doc: r.collab_doc || null,
      sale_day: r.sale_day ?? null,
      cancel_day: r.cancel_day ?? null,
      mode: r.mode === "apply" ? "apply" : "report",
      team_decides: !!r.team_dept,
    };
  }
  return out;
}
