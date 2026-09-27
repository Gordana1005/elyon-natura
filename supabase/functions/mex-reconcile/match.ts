/**
 * mex-reconcile matching — the pure half of the courier reconciliation.
 *
 * No Deno, no remote imports, no I/O: index.ts imports this as "./match.ts" and
 * vitest runs match.test.ts against it in Node. scripts/reconcile-mex-shipments.mjs
 * (the CSV path) mirrors pickCandidate's rules — keep the two in step.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE (2026-09-27): a MEX parcel is only ever
 * matched to a REAL SALE. The old single-candidate fallback took ANY lone order
 * on the phone — typically a prediction agent's 0 ден "No prior product on file"
 * cancel/trash disposition row (/calls creates those with price 0) — linked the
 * parcel to it and flipped it to paid/returned. 182 such ghost rows by
 * 2026-09-27: 22 double-counted a teleshop order, 73 stole a real order's
 * parcel, 82 were sales that exist only at MEX.
 */

export const MKD_PER_EUR = 61.5;      // FROZEN — see src/lib/currency.ts. Never "update" it.
export const DELIVERY_MKD = 150;      // MEX delivery fee the COD may or may not include
export const COD_TOLERANCE_MKD = 3;
export const DAY = 86_400_000;
/** A parcel may be created up to 3 days before its order row (entry lag)… */
export const WINDOW_BEFORE_DAYS = 3;
/** …and up to 75 days after it. */
export const WINDOW_AFTER_DAYS = 75;

/** Statuses a parcel's mere existence moves forward to `shipped`. */
export const OPEN_FOR_SHIP: ReadonlySet<string> = new Set(["pending", "take", "call_again", "confirmed"]);
/** The only statuses the no-COD-fit single-candidate fallback may pick. */
export const SINGLE_FALLBACK_STATUSES: ReadonlySet<string> = new Set([...OPEN_FOR_SHIP, "shipped", "delivered"]);

/** How a parcel came to belong to an order in THIS run's logic. */
export type LinkMethod = "tracking" | "phone_cod" | "phone_single";
export type Target = "paid" | "returned" | "shipped";

/** A list_shipments.php row, exactly as MEX returns it (`cod` is a STRING). */
export interface MexShipment {
  tracking_id: string;
  sender_reference?: string | null;
  current_status_id: number | string;
  current_status_name?: string | null;
  receiver_name?: string | null;
  receiver_city?: string | null;
  receiver_phone?: string | null;
  cod?: string | number | null;
  created_at?: string | null;
  last_update_at?: string | null;
}

/** The order columns matching reads. */
export interface OrderRow {
  id: string;
  status: string;
  price: number | string | null;
  created_at: string;
  mex_tracking_id?: string | null;
  customer_phone?: string | null;
  product_name?: string | null;
  source_type?: string | null;
  external_source?: string | null;
  cancellation_reason?: string | null;
}

/** MEX timestamps are Skopje local ("YYYY-MM-DD HH:MM:SS"). +02:00 is exact in
 * summer and one hour off in winter — acceptable for settlement dates, and
 * consistent with the CSV reconciliation that established the baseline.
 * Unparseable → null (an Invalid Date would throw at toISOString()). */
export function mexDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = new Date(String(s).replace(" ", "T") + "+02:00");
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Local MK number (070…, 70…, 38970…) → E.164 the way every order stores it. */
export function mkE164(raw: unknown): string | null {
  let d = String(raw ?? "").replace(/\D/g, "");
  if (!d) return null;
  if (d.startsWith("389")) d = d.slice(3);
  d = d.replace(/^0+/, "");
  if (d.length < 8 || d.length > 9) return null;
  return "+389" + d;
}

/** MEX's COD string ("1500.00") → whole denari. The sign is dropped — this
 * value only feeds COD-fit matching; see isNegativeCod. */
export function parseCod(raw: unknown): number {
  return Math.round(Number(String(raw ?? "").replace(/[^\d.]/g, "")) || 0);
}

/** A leading minus: MEX paying money OUT (four such parcels on 2026-09-27, all
 * bare 7-digit ids, all "Delivered"). Not a sale — never fresh-matched, or its
 * stripped value could COD-fit a real order. Same test as mex_parse_cod. */
export function isNegativeCod(raw: unknown): boolean {
  return /^\s*-/.test(String(raw ?? ""));
}

/** The COD fits the order total: round(price€ × 61.5), with or without the
 * 150 ден delivery fee, ±3 ден. An unpriced order never fits — no signal. */
export function codOk(price: unknown, cod: number): boolean {
  const exp = Math.round(Number(price) * MKD_PER_EUR);
  if (!exp) return false;
  return Math.abs(cod - exp) <= COD_TOLERANCE_MKD
    || Math.abs(cod - exp - DELIVERY_MKD) <= COD_TOLERANCE_MKD;
}

/**
 * Mirror of isSyntheticProductName in src/lib/utils.ts — keep the two in step
 * (match.test.ts asserts parity). Placeholder names /calls writes on synthetic
 * outcome rows; they are not products.
 */
export function isSyntheticProductName(name: string | null | undefined): boolean {
  const n = (name || "").trim();
  if (!n || n === "—") return true;
  return /^(Cancelled|Trashed|No prior product on file)/i.test(n);
}

/** Something a customer bought: priced, a real product, not an admin copy.
 * The only kind of order a fresh parcel match may ever choose. */
export function isRealSale(o: Pick<OrderRow, "price" | "product_name" | "status">): boolean {
  return Number(o.price) > 0 && !isSyntheticProductName(o.product_name) && o.status !== "duplicated";
}

/** A row the courier could have collected money for. /calls disposition rows
 * are always price 0 — even the ones that copy a prior real product name. */
export function hasSaleValue(o: Pick<OrderRow, "price">): boolean {
  return Number(o.price) > 0;
}

/** Parcel created within [−3d … +75d] of the order row. */
export function inShipWindow(created: Date, orderCreatedAt: string): boolean {
  const delta = created.getTime() - new Date(orderCreatedAt).getTime();
  return delta >= -WINDOW_BEFORE_DAYS * DAY && delta <= WINDOW_AFTER_DAYS * DAY;
}

export type CandidateSkip = "unmatched" | "no_real_sale" | "single_not_open" | "ambiguous";
export type CandidatePick =
  | { order: OrderRow; method: "phone_cod" | "phone_single" }
  | { skip: CandidateSkip };

/**
 * Fresh match for a parcel nobody holds yet, among the orders on its phone.
 *
 *   unlinked (no mex_tracking_id) and inside [−3d … +75d]      else 'unmatched'
 *   REAL SALES only (isRealSale)                              else 'no_real_sale'
 *   COD fits → nearest created date wins                      → 'phone_cod'
 *   no fit, exactly ONE real sale, open/shipped/delivered     → 'phone_single'
 *   no fit, exactly one real sale but cancelled/paid/…        → 'single_not_open'
 *   no fit, several real sales                                → 'ambiguous'
 */
export function pickCandidate(orders: OrderRow[], cod: number, created: Date | null): CandidatePick {
  if (!created) return { skip: "unmatched" };
  const inWindow = orders.filter((o) => !o.mex_tracking_id && inShipWindow(created, o.created_at));
  if (!inWindow.length) return { skip: "unmatched" };

  const real = inWindow.filter(isRealSale);
  if (!real.length) return { skip: "no_real_sale" };

  const fits = real.filter((o) => codOk(o.price, cod));
  if (fits.length) {
    const dist = (o: OrderRow) => Math.abs(created.getTime() - new Date(o.created_at).getTime());
    return { order: [...fits].sort((a, b) => dist(a) - dist(b))[0], method: "phone_cod" };
  }
  if (real.length === 1) {
    return SINGLE_FALLBACK_STATUSES.has(real[0].status)
      ? { order: real[0], method: "phone_single" }
      : { skip: "single_not_open" };
  }
  return { skip: "ambiguous" };
}

export type HolderPick = { order: OrderRow } | { skip: "tracking_conflict" | "register_disagrees" };

/**
 * Which order a remembered parcel belongs to, given every order whose
 * mex_tracking_id is this parcel (call with ≥1 holder) and the register's
 * link (mex_parcels.order_id: a uuid, or null/undefined when unlinked).
 *
 *   register linked → that holder, or 'register_disagrees' if it holds nothing
 *   one holder      → it
 *   several         → the one real sale (a ghost double: a teleshop import plus a
 *                     0 ден disposition that grabbed the same parcel), else
 *                     'tracking_conflict' — never a guess.
 */
export function resolveHolder(holders: OrderRow[], registerOrderId: string | null | undefined): HolderPick {
  if (registerOrderId) {
    const h = holders.find((o) => o.id === registerOrderId);
    return h ? { order: h } : { skip: "register_disagrees" };
  }
  if (holders.length === 1) return { order: holders[0] };
  const real = holders.filter(isRealSale);
  return real.length === 1 ? { order: real[0] } : { skip: "tracking_conflict" };
}

/** link_method a pre-register link is recorded under. Mirrors
 * scripts/backfill-mex-register.mjs: collabBox imports wrote the id themselves. */
export function rememberedLinkMethod(o: Pick<OrderRow, "external_source">): "collabbox_import" | "tracking" {
  return o.external_source === "collabbox" ? "collabbox_import" : "tracking";
}

/**
 * May a parcel at the courier move this order to `shipped`?
 *   'open'   — pending/take/call_again/confirmed: forward-only progress.
 *   'rule_c' — MEX outranks AlterCPA: an AlterCPA cancel/trash (or our own
 *              'no_parcel_7d' cancel) whose parcel then turns up at MEX did
 *              ship. Strong links only ('tracking', 'phone_cod'); never on a
 *              'phone_single' guess.
 *   null     — no-op (terminal/settled statuses, or rule C not satisfied).
 */
export function shipGate(o: OrderRow, method: LinkMethod): "open" | "rule_c" | null {
  if (OPEN_FOR_SHIP.has(o.status)) return "open";
  if ((o.status === "cancelled" || o.status === "trashed")
    && (method === "tracking" || method === "phone_cod")
    && (o.source_type === "altercpa" || o.external_source === "altercpa"
      || o.cancellation_reason === "no_parcel_7d")) {
    return "rule_c";
  }
  return null;
}

/** MEX status → CRM target: 2 Delivered → paid, 7 Returned → returned, any
 * other status → shipped (the parcel exists at the courier). */
export function targetFor(statusId: unknown): Target {
  const id = Number(statusId);
  return id === 2 ? "paid" : id === 7 ? "returned" : "shipped";
}

/** One row per tracking id, the LAST occurrence winning and keeping its later
 * position — pages come last_update_asc, so a parcel that moved pages mid-sweep
 * keeps its newest state. Rows without a tracking id are dropped. */
export function dedupeShipments<T extends { tracking_id?: string | null }>(rows: T[]): T[] {
  const byId = new Map<string, T>();
  for (const r of rows) {
    const id = r?.tracking_id;
    if (!id) continue;
    byId.delete(id);
    byId.set(id, r);
  }
  return [...byId.values()];
}

/** A register-only run fetched and upserted but matched nothing, so it must
 * never advance the matching cursor. */
export function isRegisterOnlyRun(r: { kind?: string | null; skipped?: Record<string, unknown> | null }): boolean {
  return r.kind === "register" || Boolean(r.skipped?.register_only);
}
