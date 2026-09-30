/**
 * mex-reconcile matching — the pure half of the courier reconciliation.
 *
 * No Deno, no remote imports, no I/O: index.ts imports this as "./match.ts" and
 * vitest runs match.test.ts against it in Node. scripts/reconcile-mex-shipments.mjs
 * (the CSV path) mirrors pickCandidate's rules — keep the two in step. The one
 * deliberate gap is the upsell revive (pickCandidate): a portal CSV carries no
 * MEX account, so that path cannot tell a BIO NATURAL 9110 parcel from another.
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
export type LinkMethod = "tracking" | "phone_cod" | "phone_single" | "upsell_revive";
/** 'at_mex' = MEX 8 "Shipment created": за пакување — the order is (or becomes) confirmed,
 *  never shipped, until the courier takes the parcel (owner 30.09.2026). */
export type Target = "paid" | "returned" | "shipped" | "at_mex";
/** MEX 8 "Shipment created" — registered, not collected by a driver yet. */
export const AT_MEX_STATUS = 8;

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
  /** When the parcel was created at MEX (20260943001200); stamped at MEX 8 if still NULL. */
  mex_sent_at?: string | null;
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

/** 002-9110-158456/2026 → '9110'. Mirror of the mex_parcels.series generated
 * column (20260934000100): only the real NNN-SSSS-… shape has a series;
 * ORD-89109, NTMK40556, M3258911 and bare numbers read null. */
export function mexSeries(trackingId: string | null | undefined): string | null {
  const m = /^[0-9]{3}-([0-9]{4})-/.exec(String(trackingId ?? ""));
  return m ? m[1] : null;
}

/** Arrived through the AlterCPA intake — the live bridge, or the 2026-08
 * history import that reused external_source 'altercpa'. The same test
 * classify_sale_source (20260935000000) files under sale_source 'altercpa'. */
export function isAlterCpaOrder(o: Pick<OrderRow, "source_type" | "external_source">): boolean {
  return o.source_type === "altercpa" || o.external_source === "altercpa";
}

/** Our own 7-day no-parcel cancel (apply_no_parcel_rule, 20260938000000) of an
 * AlterCPA sale: not the customer's decision — only a parcel not seen yet. */
export function isNoParcelCancel(
  o: Pick<OrderRow, "status" | "cancellation_reason" | "source_type" | "external_source">,
): boolean {
  return o.status === "cancelled" && o.cancellation_reason === "no_parcel_7d" && isAlterCpaOrder(o);
}

/** What the upsell revive needs to know about a parcel: the account whose
 * list it came from, and its tracking id (for the series). */
export interface ParcelRef {
  account?: string | null;
  tracking_id?: string | null;
}

/** BIO NATURAL series 9110 — Нарачка LEADS, what the Elyon business ships for
 * AlterCPA leads. The account is the list the row came from, never derived
 * from the series (series cross accounts at the margins). */
export function isLeadsParcel(p: ParcelRef | null | undefined): boolean {
  return p?.account === "bio_natural" && mexSeries(p.tracking_id) === "9110";
}

/**
 * May a fresh parcel revive this order? An open or settled order: yes (the
 * usual rules decide). A cancelled / trashed one only by its OWN dispatch — an
 * AlterCPA lead by a Нарачка LEADS parcel (series 9110, either account: NATURA
 * carried the LEADS series before BIO NATURAL existed), a CRM sale by a
 * LEADS-OUT parcel (9103). A parcel of another folder on the same phone —
 * teleshop 9102 / 9100, social 9108 / 1300, web NTMK / M… — is another
 * department's sale (owner law 28–29.09.2026: the collabBox folder decides),
 * never the dead lead's: before this guard the phone + COD match revived
 * July leads on September teleshop parcels (repair cross-channel-parcels).
 */
export function mayReviveWith(o: OrderRow, parcel?: ParcelRef | null): boolean {
  if (o.status !== "cancelled" && o.status !== "trashed") return true;
  const series = mexSeries(parcel?.tracking_id);
  return isAlterCpaOrder(o) ? series === "9110" : series === "9103";
}

export type CandidateSkip = "unmatched" | "no_real_sale" | "single_not_open" | "ambiguous";
export type CandidatePick =
  | { order: OrderRow; method: "phone_cod" | "phone_single" | "upsell_revive" }
  | { skip: CandidateSkip };

/**
 * Fresh match for a parcel nobody holds yet, among the orders on its phone.
 *
 *   unlinked (no mex_tracking_id) and inside [−3d … +75d]      else 'unmatched'
 *   REAL SALES only (isRealSale)                              else 'no_real_sale'
 *   COD fits → nearest created date wins                      → 'phone_cod'
 *     (a cancelled / trashed order fits only a parcel of its own folder —
 *      mayReviveWith: AlterCPA 9110, CRM 9103)
 *   no fit, exactly ONE real sale, open/shipped/delivered     → 'phone_single'
 *   no fit, exactly ONE real sale, our no_parcel_7d cancel of
 *     an AlterCPA sale, parcel BIO NATURAL 9110 with a COD    → 'upsell_revive'
 *   no fit, exactly one real sale but cancelled/paid/…        → 'single_not_open'
 *   no fit, several real sales                                → 'ambiguous'
 *
 * THE UPSELL REVIVE (owner rule 2026-09-28). The 7-day rule cancels an AlterCPA
 * sale whose parcel has not appeared; when it does appear, the order goes back
 * to shipped and follows MEX. A COD that fits does that through 'phone_cod' and
 * rule C — but ~8.3% of 9110 parcels carry a COD that is not the CRM price (an
 * upsell at AlterCPA), and a lone cancelled sale never gets 'phone_single', so
 * that cancel stood forever. Narrow on purpose: the parcel's account and series
 * (`parcel` omitted → never), the same window, exactly one real sale counted
 * exactly as for 'phone_single', and that sale is our own no_parcel_7d cancel.
 * A COD of 0 is no signal (as for the cod_mismatch telemetry): never revived.
 */
export function pickCandidate(
  orders: OrderRow[], cod: number, created: Date | null, parcel?: ParcelRef | null,
): CandidatePick {
  if (!created) return { skip: "unmatched" };
  const inWindow = orders.filter((o) => !o.mex_tracking_id && inShipWindow(created, o.created_at));
  if (!inWindow.length) return { skip: "unmatched" };

  const real = inWindow.filter(isRealSale);
  if (!real.length) return { skip: "no_real_sale" };

  // A cancel / trash fits only its own folder's parcel (mayReviveWith).
  const fits = real.filter((o) => codOk(o.price, cod) && mayReviveWith(o, parcel));
  if (fits.length) {
    const dist = (o: OrderRow) => Math.abs(created.getTime() - new Date(o.created_at).getTime());
    return { order: [...fits].sort((a, b) => dist(a) - dist(b))[0], method: "phone_cod" };
  }
  if (real.length === 1) {
    const only = real[0];
    if (SINGLE_FALLBACK_STATUSES.has(only.status)) return { order: only, method: "phone_single" };
    if (cod > 0 && isLeadsParcel(parcel) && isNoParcelCancel(only)) return { order: only, method: "upsell_revive" };
    return { skip: "single_not_open" };
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
 *              'phone_single' guess. An 'upsell_revive' link counts only for
 *              the order it exists for: our no_parcel_7d cancel of an
 *              AlterCPA sale (isNoParcelCancel).
 *   null     — no-op (terminal/settled statuses, or rule C not satisfied).
 */
export function shipGate(o: OrderRow, method: LinkMethod): "open" | "rule_c" | null {
  if (OPEN_FOR_SHIP.has(o.status)) return "open";
  if ((o.status === "cancelled" || o.status === "trashed")
    && (method === "tracking" || method === "phone_cod")
    && (isAlterCpaOrder(o) || o.cancellation_reason === "no_parcel_7d")) {
    return "rule_c";
  }
  if (method === "upsell_revive" && isNoParcelCancel(o)) return "rule_c";
  return null;
}

/** MEX status → CRM target (owner 30.09.2026 — the naturatherapy.mk semantics):
 *   8 Shipment created                     → at_mex   (за пакување: confirmed, not shipped)
 *   4 / 10 / 9 / 1 / 3 (and any other id)  → shipped  (the courier has the parcel)
 *   2 Delivered                            → paid
 *   7 Returned                             → returned */
export function targetFor(statusId: unknown): Target {
  const id = Number(statusId);
  return id === 2 ? "paid" : id === 7 ? "returned" : id === AT_MEX_STATUS ? "at_mex" : "shipped";
}

/**
 * What a parcel at MEX 8 does to its order. NEVER a status change:
 *   'stamp'       — confirmed (or already shipped): mex_sent_at is stamped if NULL. A 'shipped'
 *                   order at 8 stays shipped (forward-only — the ~260 of 30.09 are moved back
 *                   once, by scripts/repair-shipped-at-mex8.mjs, never by the sweep).
 *   'wait_pickup' — pending / take / call_again, or a cancel / trash rule C would revive: the
 *                   order is left as it is until the courier takes the parcel (4/10/9/1/3), when
 *                   shipGate moves it to shipped exactly as before. Confirming it here instead
 *                   would stamp sold_at "now" and credit the old assigned agent —
 *                   tg_orders_stamp_sold only skips a MEX revival into shipped / paid / returned
 *                   (the leaderboard audit of 28.09, 20260942000800). AlterCPA confirms the open
 *                   ones within minutes anyway, and the cohort (MEX-first) already counts the
 *                   parcel as 'label'.
 *   null          — nothing (paid / returned / delivered / duplicated, or rule C not satisfied).
 */
export function atMexGate(o: OrderRow, method: LinkMethod): "stamp" | "wait_pickup" | null {
  if (o.status === "confirmed" || o.status === "shipped") return "stamp";
  return shipGate(o, method) ? "wait_pickup" : null;
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
