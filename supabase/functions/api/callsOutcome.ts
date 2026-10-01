// ============================================================================
// /calls — the outcome IS the call log (plan "Фаза 11 — Нарачки и Повици", 01.10.2026).
//
//   POST /api/calls/outcome     one tap = one server call: resolve the open order(s),
//                               move the order or write the disposition record, write
//                               ONE call_logs row (source 'handset'), clear the
//                               mandatory-answer obligation, mark the list member
//   GET  /api/calls/call-again  "Мои" — the caller's own callbacks, by due time
//   GET  /api/calls/progress    the /calls progress row (calls today · sales today)
//
// Why: VOIP is off (Phase 2), agents dial from their own handsets, so the green Call
// button was pressed once in a week and a cancel / trash / confirm left no call row at
// all (767 call_logs in the week to 30.09, 766 of them "no answer"). Every outcome took
// 3–4 clicks and 2–4 round-trips from the browser (open-lead, then PATCH status or
// POST /orders, then call-logs, then the member write through PostgREST).
//
// Dependency-free on purpose (no Deno globals, no URL imports): vitest runs
// callsOutcome.test.ts against this file in Node, and index.ts imports it. The
// database work is behind `CallsOutcomePorts`, which index.ts implements with the
// service-role client; everything that DECIDES something lives here:
//   • body validation (reasons are required, 'other' needs a note, callbacks inside
//     the 6-day call-again window),
//   • which open order an outcome acts on — the same rule as the page's
//     chooseOpenOrder(): 0 → a record (cancel / trash), 1 → that order, more than one
//     → 409 choose_order and the agent picks (the anti-fork rule: a live lead is
//     completed, never forked),
//   • the order patch (PATCH /orders/:id/status parity for an OPEN order),
//   • the disposition record (POST /orders parity for a /calls cancel / trash with no
//     open order — the Phase 0 product fill included),
//   • the call_logs row shape and the list-member patch (markAfterCall parity).
// ============================================================================

import { productFromLastSale, type LastSaleProduct } from "./dispositions.ts";

export const CALL_OUTCOMES = ["no_answer", "call_again", "cancelled", "trash", "confirmed"] as const;
export type CallOutcomeKey = typeof CALL_OUTCOMES[number];

/** The reasons an agent may PICK — mirror of src/lib/cancellationReasons.ts CANCEL_REASON_VALUES.
 *  Retired values (family_refused, wrong_product, duplicate_order) and the system-only
 *  no_parcel_7d are deliberately absent: a new outcome never assigns them. */
export const CANCEL_REASONS = [
  "not_satisfied", "price_too_high", "still_using_product", "changed_mind", "no_money",
  "not_interested", "bought_elsewhere", "will_call_back", "other",
] as const;
/** Mirror of src/lib/trashReasons.ts TRASH_REASON_VALUES. */
export const TRASH_REASONS = [
  "wrong_number", "wrong_person", "not_reachable", "rude", "uncooperative", "duplicate_order", "other",
] as const;

/** Every status an outcome may act on — "open" (PATCH /orders/:id/status OPEN_LEAD_STATES). */
export const OPEN_ORDER_STATES = ["pending", "take", "call_again", "duplicated"] as const;
/** Lead sources (LEAD_SOURCE_TYPES / is_lead_source()) — the callbacks queue's orders. */
export const LEAD_SOURCES = ["altercpa", "inbound_lead", "opencart", "opencart_abandoned"] as const;

export const NOTE_MAX = 1000;
/** A callback with no time picked — markAfterCall's retry gap (3,5 h). */
export const DEFAULT_CALLBACK_MS = 3.5 * 60 * 60 * 1000;
/** expire_call_again_window() (cron call-again-expiry, every 5 min) reopens a callback 6 days
 *  after call_again_since. An explicit callback restarts that window, so it must fall inside it. */
export const CALLBACK_MAX_MS = 5 * 24 * 60 * 60 * 1000;
/** Clock skew between the agent's phone and the server. */
export const SKEW_MS = 5 * 60 * 1000;
/** An attempt start older than this is not this call (the agent left the customer on screen). */
export const ATTEMPT_MAX_AGE_MS = 30 * 60 * 1000;
/** The Pendings sentinel list id on the page (useMyQueue PENDINGS_QUEUE_ID) — never a list. */
export const PENDINGS_SENTINEL = "__pendings__";
export const PLACEHOLDER_PRODUCT = "No prior product on file";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string => (v == null ? "" : String(v)).trim();

/** Last 8 digits — the CRM's phone key (elyon-phone-normalization). '' when shorter. */
export function phone8(raw: unknown): string {
  const d = String(raw ?? "").replace(/\D/g, "");
  return d.length >= 8 ? d.slice(-8) : "";
}

export function requiresReason(o: CallOutcomeKey): boolean {
  return o === "cancelled" || o === "trash";
}

// ── POST /calls/outcome — the body ──────────────────────────────────────────

export interface CallOutcomeInput {
  phone: string;
  last8: string;
  outcome: CallOutcomeKey;
  reason: string | null;
  note: string | null;
  orderId: string | null;
  listId: string | null;
  /** call_again only: when to ring back (ISO). */
  callbackAt: string | null;
  /** When this attempt started — the tel: tap / the number copied / the customer shown (ISO). */
  startedAt: string | null;
}

export type ParseResult =
  | { ok: true; input: CallOutcomeInput }
  | { ok: false; error: string; code: string };

const fail = (code: string, error: string): ParseResult => ({ ok: false, code, error });

function parseInstant(v: unknown): Date | null {
  const s = str(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Validates the body. Pure: `now` is passed in. */
export function parseCallOutcomeBody(raw: unknown, now: Date): ParseResult {
  if (!isObj(raw)) return fail("invalid_body", "Invalid JSON body");
  const phone = str(raw.phone ?? raw.customer_phone);
  const last8 = phone8(phone);
  if (!last8) return fail("phone_required", "A phone with at least 8 digits is required");
  if (phone.length > 30) return fail("phone_required", "Phone is too long");

  const outcome = str(raw.outcome) as CallOutcomeKey;
  if (!(CALL_OUTCOMES as readonly string[]).includes(outcome)) {
    return fail("invalid_outcome", `outcome must be one of: ${CALL_OUTCOMES.join(", ")}`);
  }

  const noteRaw = str(raw.note);
  if (noteRaw.length > NOTE_MAX) return fail("note_too_long", `note is longer than ${NOTE_MAX} characters`);
  const note = noteRaw || null;

  let reason: string | null = null;
  if (requiresReason(outcome)) {
    reason = str(raw.reason) || null;
    if (!reason) return fail("reason_required", "A reason is required for a cancel or a trash");
    const allowed: readonly string[] = outcome === "cancelled" ? CANCEL_REASONS : TRASH_REASONS;
    if (!allowed.includes(reason)) return fail("invalid_reason", `invalid reason: ${reason}`);
    // 'other' is the catch-all — the note carries the real reason (cancelReasonRequiresNote).
    if (reason === "other" && !note) return fail("note_required", "The reason 'other' needs a note");
  }

  const orderIdRaw = str(raw.order_id);
  if (orderIdRaw && !UUID_RE.test(orderIdRaw)) return fail("invalid_order_id", "invalid order_id");
  const orderId = orderIdRaw || null;

  const listIdRaw = str(raw.list_id);
  let listId: string | null = null;
  if (listIdRaw && listIdRaw !== PENDINGS_SENTINEL) {
    if (!UUID_RE.test(listIdRaw)) return fail("invalid_list_id", "invalid list_id");
    listId = listIdRaw;
  }

  let callbackAt: string | null = null;
  if (outcome === "call_again") {
    const hasValue = raw.callback_at != null && str(raw.callback_at) !== "";
    const at = hasValue ? parseInstant(raw.callback_at) : new Date(now.getTime() + DEFAULT_CALLBACK_MS);
    if (!at) return fail("invalid_callback_at", "invalid callback_at");
    if (at.getTime() < now.getTime() - SKEW_MS) return fail("callback_in_past", "callback_at is in the past");
    if (at.getTime() > now.getTime() + CALLBACK_MAX_MS) {
      return fail("callback_too_far", "A callback must be within 5 days (the call-again window is 6)");
    }
    callbackAt = new Date(Math.max(at.getTime(), now.getTime())).toISOString();
  }

  // The attempt start is telemetry, never a reason to refuse an outcome: a missing, garbled
  // or stale value just leaves the timestamps empty.
  let startedAt: string | null = null;
  const st = parseInstant(raw.started_at);
  if (st && st.getTime() >= now.getTime() - ATTEMPT_MAX_AGE_MS && st.getTime() <= now.getTime() + SKEW_MS) {
    startedAt = new Date(Math.min(st.getTime(), now.getTime())).toISOString();
  }

  return { ok: true, input: { phone, last8, outcome, reason, note, orderId, listId, callbackAt, startedAt } };
}

// ── Which order does the outcome act on? ─────────────────────────────────────

/** One row of GET /orders/open-lead — every open order for the phone, newest first. */
export interface OpenOrder {
  id: string;
  display_id: string | null;
  status: string;
  assigned_agent_id: string | null;
  assigned_agent_name: string | null;
  source_type: string | null;
  duplicated_from_display?: string | null;
  created_at?: string | null;
}

export type OutcomeTarget =
  /** Move this open order (cancel / trash / call_again). */
  | { kind: "order"; order: OpenOrder }
  /** No open order: a cancel / trash writes its own record (POST /orders parity). */
  | { kind: "record" }
  /** No order moves; the call row may still point at one. */
  | { kind: "none"; contextOrderId: string | null }
  /** More than one open order and none chosen — the agent picks (never the code). */
  | { kind: "choose"; leads: OpenOrder[] }
  /** The chosen order is no longer open (settled by someone else in the meantime). */
  | { kind: "not_open"; orderId: string };

/**
 * The page's chooseOpenOrder() on the server. `open` = every OPEN order for the phone
 * (any owner — whoever is on the customer may close the order that exists, operator
 * rule 10.08), newest first.
 */
export function resolveOutcomeTarget(
  outcome: CallOutcomeKey,
  open: OpenOrder[],
  requestedOrderId: string | null,
): OutcomeTarget {
  const openOnly = open.filter((o) => (OPEN_ORDER_STATES as readonly string[]).includes(o.status));
  if (outcome === "confirmed") {
    // The order form already confirmed (or created) the order; the outcome only logs it.
    return { kind: "none", contextOrderId: requestedOrderId };
  }
  const requested = requestedOrderId ? openOnly.find((o) => o.id === requestedOrderId) ?? null : null;
  if (outcome === "no_answer") {
    // The no-answer lifecycle moves the caller's leads by phone; the row just links the lead.
    const ctx = requested ?? (openOnly.length === 1 ? openOnly[0] : null);
    return { kind: "none", contextOrderId: ctx?.id ?? null };
  }
  if (requestedOrderId) {
    return requested ? { kind: "order", order: requested } : { kind: "not_open", orderId: requestedOrderId };
  }
  if (openOnly.length === 0) {
    return requiresReason(outcome) ? { kind: "record" } : { kind: "none", contextOrderId: null };
  }
  if (openOnly.length === 1) return { kind: "order", order: openOnly[0] };
  return { kind: "choose", leads: openOnly };
}

// ── The order patch (PATCH /orders/:id/status parity, open orders only) ───────

export interface OrderRowForPatch {
  id: string;
  status: string;
  assigned_agent_id: string | null;
  call_again_since: string | null;
  cancelled_at?: string | null;
  cancelled_by_agent_id?: string | null;
}

export interface Actor {
  id: string;
  name: string | null;
  /** Claim an unassigned open order for the actor (agents; never admins / managers / warehouse). */
  claims: boolean;
}

export type OrderPatchResult =
  | { ok: true; patch: Record<string, unknown>; from: string; to: string; changed: boolean }
  | { ok: false; status: number; code: string; error: string };

export function targetStatusFor(outcome: CallOutcomeKey): "cancelled" | "trashed" | "call_again" | null {
  if (outcome === "cancelled") return "cancelled";
  if (outcome === "trash") return "trashed";
  if (outcome === "call_again") return "call_again";
  return null;
}

/**
 * The update for one OPEN order. Mirrors PATCH /orders/:id/status for an open order
 * (reason columns, cancelled_at / cancelled_by kept when already set, claim-on-action
 * as one triple) and closes or opens the call-again window like applyOutcomeToOrder.
 * An explicit callback RESTARTS the window (call_again_since = now): the customer
 * answered and asked for it, so "waiting since" starts again.
 */
export function openOrderPatch(a: {
  order: OrderRowForPatch;
  outcome: CallOutcomeKey;
  reason: string | null;
  note: string | null;
  callbackAt: string | null;
  now: Date;
  actor: Actor;
}): OrderPatchResult {
  const to = targetStatusFor(a.outcome);
  if (!to) return { ok: false, status: 400, code: "invalid_outcome", error: `outcome ${a.outcome} does not move an order` };
  const from = a.order.status;
  if (!(OPEN_ORDER_STATES as readonly string[]).includes(from)) {
    return {
      ok: false, status: 409, code: "order_not_open",
      error: `This order is already ${from} — it is no longer open.`,
    };
  }
  if (requiresReason(a.outcome) && !a.reason) {
    return { ok: false, status: 400, code: "reason_required", error: "A reason is required" };
  }
  const nowIso = a.now.toISOString();
  const patch: Record<string, unknown> = { status: to };
  if (to === "cancelled") {
    patch.cancellation_reason = a.reason;
    patch.cancellation_reason_notes = a.note;
    if (!a.order.cancelled_at) patch.cancelled_at = nowIso;
    if (!a.order.cancelled_by_agent_id) patch.cancelled_by_agent_id = a.actor.id;
    patch.call_again_since = null;
    patch.next_call_after = null;
  } else if (to === "trashed") {
    patch.trash_reason = a.reason;
    patch.trash_reason_notes = a.note;
    patch.call_again_since = null;
    patch.next_call_after = null;
  } else {
    patch.call_again_since = nowIso;
    patch.next_call_after = a.callbackAt;
  }
  if (a.actor.claims && !a.order.assigned_agent_id) {
    patch.assigned_agent_id = a.actor.id;
    patch.assigned_agent_name = a.actor.name;
    patch.assigned_at = nowIso;
  }
  return { ok: true, patch, from, to, changed: from !== to };
}

// ── The disposition record (POST /orders parity, cancel / trash, no open order) ─

export interface Attribution { id: string; type: string; name: string; category: string | null }

/**
 * The orders row a /calls cancel / trash writes when the customer has NO open order —
 * exactly what the page used to POST to /orders: price 0 (so it stays a disposition,
 * never a sale), source 'manual', the prediction list snapshot, the caller as owner
 * (agents only), and the customer's LAST PURCHASE as the product (Phase 0,
 * last_sale_product) — the placeholder only when they never bought anything.
 */
export function dispositionOrderRow(a: {
  phone: string;
  outcome: "cancelled" | "trash";
  reason: string;
  note: string | null;
  customerName: string | null;
  lastSale: LastSaleProduct | null;
  attribution: Attribution | null;
  actor: Actor & { assignToSelf: boolean };
  now: Date;
}): Record<string, unknown> {
  const nowIso = a.now.toISOString();
  const filled = productFromLastSale(a.lastSale);
  const cancelled = a.outcome === "cancelled";
  return {
    product_id: filled?.productId ?? null,
    product_name: filled?.productName ?? PLACEHOLDER_PRODUCT,
    customer_name: (a.customerName ?? "").trim(),
    customer_phone: a.phone,
    price: 0,
    quantity: 1,
    status: cancelled ? "cancelled" : "trashed",
    cancellation_reason: cancelled ? a.reason : null,
    cancellation_reason_notes: cancelled ? a.note : null,
    cancelled_at: cancelled ? nowIso : null,
    cancelled_by_agent_id: cancelled ? a.actor.id : null,
    trash_reason: cancelled ? null : a.reason,
    trash_reason_notes: cancelled ? null : a.note,
    source_type: "manual",
    prediction_list_id: a.attribution?.id ?? null,
    prediction_list_type: a.attribution?.type ?? null,
    prediction_list_name: a.attribution?.name ?? null,
    prediction_list_category: a.attribution?.category ?? null,
    assigned_agent_id: a.actor.assignToSelf ? a.actor.id : null,
    assigned_agent_name: a.actor.assignToSelf ? a.actor.name : null,
    assigned_at: a.actor.assignToSelf ? nowIso : null,
  };
}

// ── The call_logs row ────────────────────────────────────────────────────────

export interface CallLogRow {
  agent_id: string;
  context_type: "order" | "standalone";
  context_id: string | null;
  outcome: CallOutcomeKey;
  notes: string;
  started_at: string | null;
  connected_at: string | null;
  ended_at: string | null;
  customer_phone: string;
  connection_state: "answered" | "no_answer";
  source: "handset";
}

/**
 * ONE row per outcome. Handset rules (interim timing, owner 12.08): started_at = when the
 * attempt started (tel: tap / copy / customer shown), ended_at = the outcome tap;
 * answered → connected_at = started_at (ring 0, talk = total = agent-reported handling
 * time, never proof anyone picked up); no answer → connected_at NULL. No start known →
 * no timestamps at all (the history shows "logged"). The three *_seconds columns are
 * GENERATED ALWAYS from these.
 */
export function buildCallLogRow(a: {
  agentId: string;
  phone: string;
  outcome: CallOutcomeKey;
  contextOrderId: string | null;
  startedAt: string | null;
  now: Date;
  note: string | null;
}): CallLogRow {
  const answered = a.outcome !== "no_answer";
  const started = a.startedAt;
  return {
    agent_id: a.agentId,
    context_type: a.contextOrderId ? "order" : "standalone",
    context_id: a.contextOrderId,
    outcome: a.outcome,
    notes: a.note ?? "",
    started_at: started,
    connected_at: answered && started ? started : null,
    ended_at: started ? a.now.toISOString() : null,
    customer_phone: a.phone,
    connection_state: answered ? "answered" : "no_answer",
    source: "handset",
  };
}

// ── The list member (markAfterCall parity) ───────────────────────────────────

/**
 * What the page's markAfterCall() wrote to prediction_segment_members, now on the
 * server. no_answer → null: the no-answer lifecycle owns the member hold (the 2-a-day
 * pacing and the 9-strike rule), exactly as the page skipped markAfterCall for it.
 * A callback also opens the member's call-again window so it shows in the callbacks
 * queue (Мои) and the Assigner's call-agains tab.
 */
export function memberPatchFor(outcome: CallOutcomeKey, now: Date, callbackAt: string | null): Record<string, unknown> | null {
  const nowIso = now.toISOString();
  if (outcome === "no_answer") return null;
  if (outcome === "call_again") {
    return {
      last_call_at: nowIso,
      last_call_outcome: "call_again",
      is_completed: false,
      in_call_again_until: callbackAt,
      call_again_since: nowIso,
    };
  }
  return {
    last_call_at: nowIso,
    last_call_outcome: outcome,
    is_completed: true,
    in_call_again_until: null,
  };
}

// ── The orchestrator ─────────────────────────────────────────────────────────

export interface CallsOutcomePorts {
  /** Every open order for the phone (suffix match), newest first — GET /orders/open-lead. */
  listOpenOrders(last8: string): Promise<OpenOrder[]>;
  /** Re-read the order, apply openOrderPatch() guarded on its current status, write order_history. */
  applyToOpenOrder(a: {
    orderId: string; outcome: CallOutcomeKey; reason: string | null; note: string | null; callbackAt: string | null;
  }): Promise<{ ok: true; from: string; to: string; changed: boolean } | { ok: false; status: number; code: string; error: string }>;
  /** Look up name / attribution / last sale, insert dispositionOrderRow(), write order_history. */
  createDispositionRecord(a: {
    phone: string; outcome: "cancelled" | "trash"; reason: string; note: string | null;
  }): Promise<{ ok: true; id: string; product_name: string } | { ok: false; status: number; error: string }>;
  insertCallLog(row: CallLogRow): Promise<{ ok: true; id: string } | { ok: false; error: string }>;
  /** The paced retries + the 9-strike rule, shared with POST /call-logs. */
  afterNoAnswer(phone: string): Promise<void>;
  clearMissedCalls(last8: string): Promise<void>;
  clearObligation(phone: string): Promise<void>;
  /** Update the caller's member row in that list (suffix match); returns rows touched. */
  markMember(a: { listId: string; last8: string; patch: Record<string, unknown> }): Promise<number>;
  /** Broadcasts (assigner board, agent tiles). Fire-and-forget. */
  notify(a: { outcome: CallOutcomeKey; orderChanged: boolean }): void;
}

export interface OutcomeResponse {
  status: number;
  body: Record<string, unknown>;
}

const shapeLead = (o: OpenOrder) => ({
  id: o.id,
  display_id: o.display_id,
  status: o.status,
  assigned_agent_id: o.assigned_agent_id,
  assigned_agent_name: o.assigned_agent_name,
  source_type: o.source_type,
  duplicated_from_display: o.duplicated_from_display ?? null,
});

/**
 * One outcome, in the order the old page did it: the order first (a failed move is
 * returned as an error and nothing is logged, so a retry never doubles the call row),
 * then the call row, then the side effects that can never fail the request.
 */
export async function recordCallOutcome(
  ports: CallsOutcomePorts,
  input: CallOutcomeInput,
  ctx: { agentId: string; now: Date },
): Promise<OutcomeResponse> {
  const open = await ports.listOpenOrders(input.last8);
  const target = resolveOutcomeTarget(input.outcome, open, input.orderId);

  if (target.kind === "choose") {
    return {
      status: 409,
      body: {
        error: "This customer has more than one open order — choose the one you worked on.",
        code: "choose_order",
        leads: target.leads.map(shapeLead),
      },
    };
  }
  if (target.kind === "not_open") {
    return {
      status: 409,
      body: { error: "That order is no longer open.", code: "order_not_open", order_id: target.orderId },
    };
  }

  let orderId: string | null = null;
  let orderAction: "updated" | "created" | "none" = "none";
  let orderChanged = false;
  let productName: string | null = null;

  if (target.kind === "order") {
    const res = await ports.applyToOpenOrder({
      orderId: target.order.id, outcome: input.outcome, reason: input.reason, note: input.note, callbackAt: input.callbackAt,
    });
    if (!res.ok) return { status: res.status, body: { error: res.error, code: res.code, order_id: target.order.id } };
    orderId = target.order.id;
    orderAction = "updated";
    orderChanged = res.changed;
  } else if (target.kind === "record") {
    const res = await ports.createDispositionRecord({
      phone: input.phone, outcome: input.outcome as "cancelled" | "trash", reason: input.reason as string, note: input.note,
    });
    if (!res.ok) return { status: res.status, body: { error: res.error, code: "record_failed" } };
    orderId = res.id;
    orderAction = "created";
    orderChanged = true;
    productName = res.product_name;
  } else {
    orderId = target.contextOrderId;
  }

  const warnings: string[] = [];
  const row = buildCallLogRow({
    agentId: ctx.agentId, phone: input.phone, outcome: input.outcome, contextOrderId: orderId,
    startedAt: input.startedAt, now: ctx.now, note: input.note,
  });
  const log = await ports.insertCallLog(row);
  if (!log.ok) warnings.push("call_log_failed");

  // Every recorded outcome clears an open missed call for the number (POST /call-logs parity).
  await ports.clearMissedCalls(input.last8);
  if (input.outcome === "no_answer") await ports.afterNoAnswer(input.phone);
  // Any outcome — a plain "no answer" included — is "leaving a mark" (rule 13.08).
  await ports.clearObligation(input.phone);

  let memberMarked = 0;
  const patch = memberPatchFor(input.outcome, ctx.now, input.callbackAt);
  if (input.listId && patch) {
    memberMarked = await ports.markMember({ listId: input.listId, last8: input.last8, patch });
  }

  ports.notify({ outcome: input.outcome, orderChanged });

  return {
    status: 200,
    body: {
      ok: true,
      outcome: input.outcome,
      order_id: orderId,
      order_action: orderAction,
      product_name: productName,
      call_log_id: log.ok ? log.id : null,
      member_marked: memberMarked,
      callback_at: input.callbackAt,
      warnings,
      // The queue lives on the page (leads first, a pinned list wins, the Pendings
      // sentinel …) — the client serves the next customer from its own queue.
      next: "fetch",
    },
  };
}

// ── GET /calls/call-again — "Мои" ────────────────────────────────────────────

export type DueState = "due" | "soon" | "later";
/** "Soon" = due within this window. */
export const SOON_MS = 2 * 60 * 60 * 1000;

export interface CallbackItem {
  kind: "order" | "prediction";
  key: string;
  order_id: string | null;
  display_id: string | null;
  list_id: string | null;
  list_name: string | null;
  product_name: string | null;
  customer_phone: string;
  customer_name: string | null;
  due_at: string | null;
  due_state: DueState;
  call_again_since: string | null;
  last_call_at: string | null;
  last_call_outcome: string | null;
}

export interface CallbackOrderRow {
  id: string; display_id?: string | null; customer_phone: string; customer_name: string | null;
  product_name?: string | null; next_call_after: string | null; call_again_since: string | null;
}
export interface CallbackMemberRow {
  list_id: string; customer_phone: string; customer_name: string | null;
  in_call_again_until: string | null; call_again_since: string | null;
  last_call_at?: string | null; last_call_outcome?: string | null;
  prediction_segment_lists?: { name?: string | null } | null;
}
export interface LastCallRow { phone8: string; last_call_at: string | null; outcome: string | null }

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
};

export function dueStateOf(dueAt: string | null, now: Date): DueState {
  const t = ms(dueAt);
  if (t == null || t <= now.getTime()) return "due";
  return t - now.getTime() <= SOON_MS ? "soon" : "later";
}

/**
 * The caller's callbacks — the Assigner's definition (assigner_call_agains): lead
 * orders in call_again + list members with an open call-again window, de-duplicated by
 * phone (the order wins). Due first (longest waiting first), then by due time. The last
 * call is the REAL one (call_logs via bulk_last_calls) — never orders.updated_at, which
 * every assignment bumps.
 */
export function shapeMyCallbacks(a: {
  orders: CallbackOrderRow[];
  members: CallbackMemberRow[];
  lastCalls: LastCallRow[];
  now: Date;
}): { total: number; due: number; soon: number; items: CallbackItem[] } {
  const last = new Map(a.lastCalls.map((r) => [r.phone8, r] as [string, LastCallRow]));
  const byPhone = new Map<string, CallbackItem>();
  for (const o of a.orders) {
    const key = phone8(o.customer_phone);
    if (!key || byPhone.has(key)) continue;
    const lc = last.get(key);
    byPhone.set(key, {
      kind: "order", key: `order:${o.id}`, order_id: o.id, display_id: o.display_id ?? null,
      list_id: null, list_name: null, product_name: o.product_name ?? null,
      customer_phone: o.customer_phone, customer_name: o.customer_name,
      due_at: o.next_call_after, due_state: dueStateOf(o.next_call_after, a.now),
      call_again_since: o.call_again_since,
      last_call_at: lc?.last_call_at ?? null, last_call_outcome: lc?.outcome ?? null,
    });
  }
  for (const m of a.members) {
    const key = phone8(m.customer_phone);
    if (!key || byPhone.has(key)) continue;
    const lc = last.get(key);
    byPhone.set(key, {
      kind: "prediction", key: `${m.list_id}|${m.customer_phone}`, order_id: null, display_id: null,
      list_id: m.list_id, list_name: m.prediction_segment_lists?.name ?? null, product_name: null,
      customer_phone: m.customer_phone, customer_name: m.customer_name,
      due_at: m.in_call_again_until, due_state: dueStateOf(m.in_call_again_until, a.now),
      call_again_since: m.call_again_since,
      last_call_at: lc?.last_call_at ?? m.last_call_at ?? null,
      last_call_outcome: lc?.outcome ?? m.last_call_outcome ?? null,
    });
  }
  const items = [...byPhone.values()].sort((x, y) => {
    const dx = x.due_state === "due" ? 0 : 1;
    const dy = y.due_state === "due" ? 0 : 1;
    if (dx !== dy) return dx - dy;
    if (dx === 0) {
      // both due: the longest waiting first
      const sx = ms(x.call_again_since) ?? Number.MAX_SAFE_INTEGER;
      const sy = ms(y.call_again_since) ?? Number.MAX_SAFE_INTEGER;
      if (sx !== sy) return sx - sy;
    } else {
      const ux = ms(x.due_at) ?? 0;
      const uy = ms(y.due_at) ?? 0;
      if (ux !== uy) return ux - uy;
    }
    return x.key.localeCompare(y.key);
  });
  return {
    total: items.length,
    due: items.filter((i) => i.due_state === "due").length,
    soon: items.filter((i) => i.due_state === "soon").length,
    items,
  };
}

// ── GET /calls/progress ──────────────────────────────────────────────────────

/**
 * The caller's own row of leaderboard_day_v2 (the TV board — "one calculation
 * everywhere", owner 29.09): sales = credited sales today, worked = decisions today
 * ("Обработени"). null when the caller is not on today's board.
 */
export function pickLeaderboardSelf(payload: unknown, userId: string): { sales: number; worked: number } | null {
  if (!isObj(payload) || !Array.isArray(payload.rows)) return null;
  const row = (payload.rows as unknown[]).find((r) => isObj(r) && r.user_id === userId) as Record<string, unknown> | undefined;
  if (!row) return null;
  const n = (v: unknown) => { const x = Number(v ?? 0); return Number.isFinite(x) ? x : 0; };
  return { sales: n(row.sales), worked: n(row.worked) };
}
