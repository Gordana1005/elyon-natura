import { describe, expect, it, vi } from "vitest";
import {
  buildCallLogRow, CALLBACK_MAX_MS, DEFAULT_CALLBACK_MS, dispositionOrderRow, dueStateOf, memberPatchFor,
  openOrderPatch, parseCallOutcomeBody, pickLeaderboardSelf, PLACEHOLDER_PRODUCT, recordCallOutcome,
  resolveOutcomeTarget, shapeMyCallbacks, type CallsOutcomePorts, type OpenOrder,
} from "./callsOutcome.ts";

const NOW = new Date("2026-10-01T10:00:00.000Z"); // 12:00 Skopje
const PHONE = "+38970123456";
const UUID = "6f1c1b7e-2f0a-4c55-9a51-0d7f3b0e1a11";
const LIST = "0a5b9e3c-77d1-4b8e-a0f5-1c2d3e4f5a6b";

const open = (over: Partial<OpenOrder>): OpenOrder => ({
  id: UUID, display_id: "100001", status: "pending", assigned_agent_id: null, assigned_agent_name: null,
  source_type: "altercpa", duplicated_from_display: null, created_at: "2026-09-30T08:00:00Z", ...over,
});

describe("parseCallOutcomeBody — outcome validation", () => {
  const ok = (body: Record<string, unknown>) => {
    const r = parseCallOutcomeBody(body, NOW);
    if (!r.ok) throw new Error(`${r.code}: ${r.error}`);
    return r.input;
  };
  const code = (body: unknown) => {
    const r = parseCallOutcomeBody(body, NOW);
    return r.ok ? "ok" : r.code;
  };

  it("accepts the five outcomes and keys the phone on its last 8 digits", () => {
    for (const outcome of ["no_answer", "call_again", "confirmed"]) {
      expect(ok({ phone: PHONE, outcome }).last8).toBe("70123456");
    }
    expect(ok({ phone: "070 123 456", outcome: "cancelled", reason: "no_money" }).reason).toBe("no_money");
    expect(ok({ phone: PHONE, outcome: "trash", reason: "wrong_number" }).reason).toBe("wrong_number");
    expect(ok({ customer_phone: PHONE, outcome: "no_answer" }).phone).toBe(PHONE);
  });

  it("refuses a missing body, a short phone and an unknown outcome", () => {
    expect(code(null)).toBe("invalid_body");
    expect(code([])).toBe("invalid_body");
    expect(code({ phone: "1234567", outcome: "no_answer" })).toBe("phone_required");
    expect(code({ phone: PHONE, outcome: "answered" })).toBe("invalid_outcome");
    expect(code({ phone: PHONE, outcome: "wrong_number" })).toBe("invalid_outcome");
  });

  it("a cancel or a trash REQUIRES a reason the agent may pick", () => {
    expect(code({ phone: PHONE, outcome: "cancelled" })).toBe("reason_required");
    expect(code({ phone: PHONE, outcome: "trash", reason: "  " })).toBe("reason_required");
    // system-only and retired cancel reasons are never assigned by an outcome
    expect(code({ phone: PHONE, outcome: "cancelled", reason: "no_parcel_7d" })).toBe("invalid_reason");
    expect(code({ phone: PHONE, outcome: "cancelled", reason: "family_refused" })).toBe("invalid_reason");
    // a trash reason is not a cancel reason and vice versa
    expect(code({ phone: PHONE, outcome: "cancelled", reason: "rude" })).toBe("invalid_reason");
    expect(code({ phone: PHONE, outcome: "trash", reason: "no_money" })).toBe("invalid_reason");
  });

  it("'other' needs a note; notes are trimmed and capped", () => {
    expect(code({ phone: PHONE, outcome: "cancelled", reason: "other" })).toBe("note_required");
    expect(ok({ phone: PHONE, outcome: "cancelled", reason: "other", note: "  во странство  " }).note).toBe("во странство");
    expect(code({ phone: PHONE, outcome: "no_answer", note: "x".repeat(1001) })).toBe("note_too_long");
    expect(ok({ phone: PHONE, outcome: "no_answer", note: "   " }).note).toBeNull();
  });

  it("ignores a reason on outcomes that take none", () => {
    expect(ok({ phone: PHONE, outcome: "no_answer", reason: "rude" }).reason).toBeNull();
  });

  it("order_id must be a uuid; the Pendings sentinel is never a list", () => {
    expect(code({ phone: PHONE, outcome: "no_answer", order_id: "ORD-1" })).toBe("invalid_order_id");
    expect(ok({ phone: PHONE, outcome: "no_answer", order_id: UUID }).orderId).toBe(UUID);
    expect(ok({ phone: PHONE, outcome: "no_answer", list_id: "__pendings__" }).listId).toBeNull();
    expect(code({ phone: PHONE, outcome: "no_answer", list_id: "list-1" })).toBe("invalid_list_id");
    expect(ok({ phone: PHONE, outcome: "no_answer", list_id: LIST }).listId).toBe(LIST);
  });

  it("a callback defaults to +3,5 h and must sit inside the call-again window", () => {
    expect(ok({ phone: PHONE, outcome: "call_again" }).callbackAt)
      .toBe(new Date(NOW.getTime() + DEFAULT_CALLBACK_MS).toISOString());
    const at = "2026-10-02T08:00:00.000Z";
    expect(ok({ phone: PHONE, outcome: "call_again", callback_at: at }).callbackAt).toBe(at);
    expect(code({ phone: PHONE, outcome: "call_again", callback_at: "soon" })).toBe("invalid_callback_at");
    expect(code({ phone: PHONE, outcome: "call_again", callback_at: "2026-10-01T09:00:00Z" })).toBe("callback_in_past");
    expect(code({ phone: PHONE, outcome: "call_again", callback_at: new Date(NOW.getTime() + CALLBACK_MAX_MS + 60_000).toISOString() }))
      .toBe("callback_too_far");
    // a minute of clock skew is clamped to now, not refused
    expect(ok({ phone: PHONE, outcome: "call_again", callback_at: "2026-10-01T09:59:00Z" }).callbackAt).toBe(NOW.toISOString());
    // only call_again carries one
    expect(ok({ phone: PHONE, outcome: "no_answer", callback_at: at }).callbackAt).toBeNull();
  });

  it("the attempt start is telemetry: kept when recent, dropped when stale or garbled", () => {
    expect(ok({ phone: PHONE, outcome: "no_answer", started_at: "2026-10-01T09:58:30Z" }).startedAt).toBe("2026-10-01T09:58:30.000Z");
    expect(ok({ phone: PHONE, outcome: "no_answer", started_at: "2026-10-01T09:00:00Z" }).startedAt).toBeNull();
    expect(ok({ phone: PHONE, outcome: "no_answer", started_at: "garbage" }).startedAt).toBeNull();
    expect(ok({ phone: PHONE, outcome: "no_answer", started_at: "2026-10-01T10:02:00Z" }).startedAt).toBe(NOW.toISOString());
  });
});

describe("resolveOutcomeTarget — the chooseOpenOrder / anti-fork rules", () => {
  const A = open({ id: "a" });
  const B = open({ id: "b", status: "duplicated", duplicated_from_display: "100001" });

  it("no open order: a cancel / trash writes a record, a callback moves nothing", () => {
    expect(resolveOutcomeTarget("cancelled", [], null)).toEqual({ kind: "record" });
    expect(resolveOutcomeTarget("trash", [], null)).toEqual({ kind: "record" });
    expect(resolveOutcomeTarget("call_again", [], null)).toEqual({ kind: "none", contextOrderId: null });
  });

  it("exactly one open order: the outcome completes THAT order (never a second one)", () => {
    expect(resolveOutcomeTarget("cancelled", [A], null)).toEqual({ kind: "order", order: A });
    expect(resolveOutcomeTarget("call_again", [A], null)).toEqual({ kind: "order", order: A });
  });

  it("more than one open order: the agent chooses — the code never guesses", () => {
    expect(resolveOutcomeTarget("trash", [A, B], null)).toEqual({ kind: "choose", leads: [A, B] });
    expect(resolveOutcomeTarget("cancelled", [A, B], "b")).toEqual({ kind: "order", order: B });
  });

  it("a chosen order that is no longer open is refused, not silently re-targeted", () => {
    expect(resolveOutcomeTarget("cancelled", [A], "zzz")).toEqual({ kind: "not_open", orderId: "zzz" });
  });

  it("settled rows in the list are never targets", () => {
    const paid = open({ id: "p", status: "paid" });
    expect(resolveOutcomeTarget("cancelled", [paid], null)).toEqual({ kind: "record" });
  });

  it("no answer moves no order itself (the lifecycle does) but links a single lead", () => {
    expect(resolveOutcomeTarget("no_answer", [A], null)).toEqual({ kind: "none", contextOrderId: "a" });
    expect(resolveOutcomeTarget("no_answer", [A, B], null)).toEqual({ kind: "none", contextOrderId: null });
    expect(resolveOutcomeTarget("no_answer", [A, B], "b")).toEqual({ kind: "none", contextOrderId: "b" });
  });

  it("confirmed only logs: the order form already confirmed it", () => {
    expect(resolveOutcomeTarget("confirmed", [A], null)).toEqual({ kind: "none", contextOrderId: null });
    expect(resolveOutcomeTarget("confirmed", [], "x")).toEqual({ kind: "none", contextOrderId: "x" });
  });
});

describe("openOrderPatch — PATCH /orders/:id/status parity for an open order", () => {
  const actor = { id: "agent-1", name: "Ана", claims: true };
  const order = { id: "a", status: "take", assigned_agent_id: null, call_again_since: "2026-09-28T08:00:00Z", cancelled_at: null, cancelled_by_agent_id: null };

  it("cancel: reason + note, who / when, the call-again window closed, an unassigned order claimed", () => {
    const r = openOrderPatch({ order, outcome: "cancelled", reason: "no_money", note: "по плата", callbackAt: null, now: NOW, actor });
    expect(r).toEqual({
      ok: true, from: "take", to: "cancelled", changed: true,
      patch: {
        status: "cancelled", cancellation_reason: "no_money", cancellation_reason_notes: "по плата",
        cancelled_at: NOW.toISOString(), cancelled_by_agent_id: "agent-1",
        call_again_since: null, next_call_after: null,
        assigned_agent_id: "agent-1", assigned_agent_name: "Ана", assigned_at: NOW.toISOString(),
      },
    });
  });

  it("trash writes the structured reason; an owned order is never re-claimed", () => {
    const r = openOrderPatch({ order: { ...order, assigned_agent_id: "other" }, outcome: "trash", reason: "rude", note: null, callbackAt: null, now: NOW, actor });
    expect(r.ok && r.patch).toEqual({ status: "trashed", trash_reason: "rude", trash_reason_notes: null, call_again_since: null, next_call_after: null });
  });

  it("a callback restarts the window and parks the lead until the agreed time", () => {
    const at = "2026-10-01T14:00:00.000Z";
    const r = openOrderPatch({ order: { ...order, status: "call_again" }, outcome: "call_again", reason: null, note: null, callbackAt: at, now: NOW, actor: { ...actor, claims: false } });
    expect(r).toMatchObject({ ok: true, from: "call_again", to: "call_again", changed: false });
    expect(r.ok && r.patch).toEqual({ status: "call_again", call_again_since: NOW.toISOString(), next_call_after: at });
  });

  it("a settled order is refused (409), never overwritten", () => {
    const r = openOrderPatch({ order: { ...order, status: "confirmed" }, outcome: "cancelled", reason: "no_money", note: null, callbackAt: null, now: NOW, actor });
    expect(r).toMatchObject({ ok: false, status: 409, code: "order_not_open" });
  });

  it("keeps an existing cancelled_at / cancelled_by", () => {
    const r = openOrderPatch({ order: { ...order, cancelled_at: "2026-09-01T00:00:00Z", cancelled_by_agent_id: "x" }, outcome: "cancelled", reason: "other", note: "n", callbackAt: null, now: NOW, actor });
    expect(r.ok && "cancelled_at" in r.patch).toBe(false);
    expect(r.ok && "cancelled_by_agent_id" in r.patch).toBe(false);
  });
});

describe("dispositionOrderRow — POST /orders parity (Phase 0 product fill)", () => {
  const actor = { id: "agent-1", name: "Ана", claims: true, assignToSelf: true };
  it("carries the last purchase, never the placeholder, and is never a sale", () => {
    const row = dispositionOrderRow({
      phone: PHONE, outcome: "cancelled", reason: "no_money", note: null, customerName: " Марија ",
      lastSale: { product_id: "p1", product_name: "Parafix" }, attribution: { id: LIST, type: "segment", name: "21d 26+ (1-3 orders)", category: "value" },
      actor, now: NOW,
    });
    expect(row).toMatchObject({
      product_id: "p1", product_name: "Parafix", customer_name: "Марија", price: 0, quantity: 1, status: "cancelled",
      cancellation_reason: "no_money", cancelled_by_agent_id: "agent-1", trash_reason: null, source_type: "manual",
      prediction_list_id: LIST, prediction_list_name: "21d 26+ (1-3 orders)", assigned_agent_id: "agent-1",
    });
    expect(row).not.toHaveProperty("confirmed_by_agent_id");
  });
  it("falls back to the placeholder only with no sale; managers do not become owners", () => {
    const row = dispositionOrderRow({
      phone: PHONE, outcome: "trash", reason: "wrong_number", note: "друг човек", customerName: null, lastSale: null,
      attribution: null, actor: { ...actor, assignToSelf: false }, now: NOW,
    });
    expect(row).toMatchObject({
      product_id: null, product_name: PLACEHOLDER_PRODUCT, customer_name: "", status: "trashed",
      trash_reason: "wrong_number", trash_reason_notes: "друг човек", cancellation_reason: null, cancelled_at: null,
      assigned_agent_id: null, assigned_agent_name: null, assigned_at: null,
    });
  });
});

describe("buildCallLogRow — the call_logs row shape", () => {
  const base = { agentId: "agent-1", phone: PHONE, now: NOW, note: null };
  it("answered: connected_at collapses to the attempt start (ring 0), source handset", () => {
    expect(buildCallLogRow({ ...base, outcome: "cancelled", contextOrderId: "o1", startedAt: "2026-10-01T09:58:00.000Z" })).toEqual({
      agent_id: "agent-1", context_type: "order", context_id: "o1", outcome: "cancelled", notes: "",
      started_at: "2026-10-01T09:58:00.000Z", connected_at: "2026-10-01T09:58:00.000Z", ended_at: NOW.toISOString(),
      customer_phone: PHONE, connection_state: "answered", source: "handset",
    });
  });
  it("no answer never connects", () => {
    const r = buildCallLogRow({ ...base, outcome: "no_answer", contextOrderId: null, startedAt: "2026-10-01T09:59:00.000Z" });
    expect(r).toMatchObject({ context_type: "standalone", context_id: null, connection_state: "no_answer", connected_at: null, ended_at: NOW.toISOString() });
  });
  it("no attempt start → no timestamps (logged, not timed)", () => {
    const r = buildCallLogRow({ ...base, outcome: "call_again", contextOrderId: null, startedAt: null });
    expect(r).toMatchObject({ started_at: null, connected_at: null, ended_at: null, connection_state: "answered", outcome: "call_again" });
  });
  it("only the columns the table has (the *_seconds are GENERATED ALWAYS)", () => {
    const r = buildCallLogRow({ ...base, outcome: "trash", contextOrderId: null, startedAt: null, note: "груб" });
    expect(Object.keys(r).sort()).toEqual([
      "agent_id", "connected_at", "connection_state", "context_id", "context_type", "customer_phone",
      "ended_at", "notes", "outcome", "source", "started_at",
    ]);
    expect(r.notes).toBe("груб");
  });
});

describe("memberPatchFor — markAfterCall parity", () => {
  it("no answer is owned by the server lifecycle", () => {
    expect(memberPatchFor("no_answer", NOW, null)).toBeNull();
  });
  it("a callback keeps the member open and opens its window", () => {
    expect(memberPatchFor("call_again", NOW, "2026-10-01T14:00:00.000Z")).toEqual({
      last_call_at: NOW.toISOString(), last_call_outcome: "call_again", is_completed: false,
      in_call_again_until: "2026-10-01T14:00:00.000Z", call_again_since: NOW.toISOString(),
    });
  });
  it("cancel / trash / confirm complete the member for the list", () => {
    for (const o of ["cancelled", "trash", "confirmed"] as const) {
      expect(memberPatchFor(o, NOW, null)).toEqual({ last_call_at: NOW.toISOString(), last_call_outcome: o, is_completed: true, in_call_again_until: null });
    }
  });
});

function fakePorts(over: Partial<CallsOutcomePorts> = {}) {
  const calls: string[] = [];
  const ports: CallsOutcomePorts = {
    listOpenOrders: vi.fn(async () => { calls.push("listOpenOrders"); return []; }),
    applyToOpenOrder: vi.fn(async () => { calls.push("applyToOpenOrder"); return { ok: true as const, from: "pending", to: "cancelled", changed: true }; }),
    createDispositionRecord: vi.fn(async () => { calls.push("createDispositionRecord"); return { ok: true as const, id: "rec-1", product_name: "Parafix" }; }),
    insertCallLog: vi.fn(async () => { calls.push("insertCallLog"); return { ok: true as const, id: "log-1" }; }),
    afterNoAnswer: vi.fn(async () => { calls.push("afterNoAnswer"); }),
    clearMissedCalls: vi.fn(async () => { calls.push("clearMissedCalls"); }),
    clearObligation: vi.fn(async () => { calls.push("clearObligation"); }),
    markMember: vi.fn(async () => { calls.push("markMember"); return 1; }),
    notify: vi.fn(() => { calls.push("notify"); }),
    ...over,
  };
  return { ports, calls };
}
const input = (over: Record<string, unknown>) => {
  const r = parseCallOutcomeBody({ phone: PHONE, ...over }, NOW);
  if (!r.ok) throw new Error(r.code);
  return r.input;
};
const ctx = { agentId: "agent-1", now: NOW };

describe("recordCallOutcome — one tap, one server call", () => {
  it("no answer: logs FIRST (the streak counts this call), then the lifecycle, obligation; no member write", async () => {
    const { ports, calls } = fakePorts();
    const res = await recordCallOutcome(ports, input({ outcome: "no_answer", list_id: LIST }), ctx);
    expect(res.status).toBe(200);
    expect(calls).toEqual(["listOpenOrders", "insertCallLog", "clearMissedCalls", "afterNoAnswer", "clearObligation", "notify"]);
    expect(res.body).toMatchObject({ ok: true, order_action: "none", call_log_id: "log-1", member_marked: 0, next: "fetch" });
    expect((ports.insertCallLog as any).mock.calls[0][0]).toMatchObject({ outcome: "no_answer", connection_state: "no_answer", source: "handset" });
  });

  it("cancel with no open order: ONE record (with the product), one row linked to it, the member completed", async () => {
    const { ports, calls } = fakePorts();
    const res = await recordCallOutcome(ports, input({ outcome: "cancelled", reason: "not_interested", list_id: LIST }), ctx);
    expect(calls).toEqual(["listOpenOrders", "createDispositionRecord", "insertCallLog", "clearMissedCalls", "clearObligation", "markMember", "notify"]);
    expect(res.body).toMatchObject({ order_id: "rec-1", order_action: "created", product_name: "Parafix", member_marked: 1 });
    expect((ports.insertCallLog as any).mock.calls[0][0]).toMatchObject({ context_type: "order", context_id: "rec-1", outcome: "cancelled" });
    expect((ports.markMember as any).mock.calls[0][0]).toMatchObject({ listId: LIST, last8: "70123456", patch: { is_completed: true, last_call_outcome: "cancelled" } });
  });

  it("cancel with one open lead: the lead is moved, never forked", async () => {
    const { ports } = fakePorts({ listOpenOrders: vi.fn(async () => [open({ id: UUID })]) });
    const res = await recordCallOutcome(ports, input({ outcome: "cancelled", reason: "no_money" }), ctx);
    expect(ports.applyToOpenOrder).toHaveBeenCalledWith({ orderId: UUID, outcome: "cancelled", reason: "no_money", note: null, callbackAt: null });
    expect(ports.createDispositionRecord).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({ order_id: UUID, order_action: "updated" });
  });

  it("two open orders and none chosen: 409 choose_order, and nothing is written", async () => {
    const { ports, calls } = fakePorts({ listOpenOrders: vi.fn(async () => [open({ id: "a" }), open({ id: "b", status: "duplicated" })]) });
    const res = await recordCallOutcome(ports, input({ outcome: "trash", reason: "rude" }), ctx);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "choose_order" });
    expect((res.body.leads as unknown[]).length).toBe(2);
    expect(calls).toEqual([]); // (the overridden listOpenOrders does not record itself)
  });

  it("a refused order move returns the error and logs nothing (a retry never doubles the row)", async () => {
    const { ports, calls } = fakePorts({
      listOpenOrders: vi.fn(async () => [open({ id: UUID })]),
      applyToOpenOrder: vi.fn(async () => ({ ok: false as const, status: 409, code: "order_not_open", error: "already confirmed" })),
    });
    const res = await recordCallOutcome(ports, input({ outcome: "cancelled", reason: "no_money" }), ctx);
    expect(res).toMatchObject({ status: 409, body: { code: "order_not_open" } });
    expect(calls).not.toContain("insertCallLog");
    expect(calls).not.toContain("clearObligation");
  });

  it("callback on a prediction customer: no order, the member parked until the agreed time", async () => {
    const { ports } = fakePorts();
    const at = "2026-10-01T15:00:00.000Z";
    const res = await recordCallOutcome(ports, input({ outcome: "call_again", callback_at: at, list_id: LIST }), ctx);
    expect(ports.applyToOpenOrder).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({ order_action: "none", callback_at: at });
    expect((ports.markMember as any).mock.calls[0][0].patch).toMatchObject({ in_call_again_until: at, is_completed: false });
  });

  it("confirmed: the form did the order — log it against that order, complete the member", async () => {
    const { ports } = fakePorts();
    const res = await recordCallOutcome(ports, input({ outcome: "confirmed", order_id: UUID, list_id: LIST }), ctx);
    expect(ports.applyToOpenOrder).not.toHaveBeenCalled();
    expect(ports.createDispositionRecord).not.toHaveBeenCalled();
    expect((ports.insertCallLog as any).mock.calls[0][0]).toMatchObject({ context_id: UUID, connection_state: "answered", outcome: "confirmed" });
    expect(res.body).toMatchObject({ order_id: UUID, order_action: "none", member_marked: 1 });
  });

  it("a failed call row never undoes the recorded outcome — it is reported", async () => {
    const { ports } = fakePorts({ insertCallLog: vi.fn(async () => ({ ok: false as const, error: "boom" })) });
    const res = await recordCallOutcome(ports, input({ outcome: "cancelled", reason: "no_money" }), ctx);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ call_log_id: null, warnings: ["call_log_failed"] });
    expect(ports.clearObligation).toHaveBeenCalled();
  });
});

describe("shapeMyCallbacks — Мои", () => {
  const now = NOW;
  it("de-duplicates by phone (the order wins), due first by waiting time, then by due time; real last call", () => {
    const r = shapeMyCallbacks({
      now,
      orders: [
        { id: "o1", display_id: "1", customer_phone: "+38970111111", customer_name: "A", product_name: "X", next_call_after: null, call_again_since: "2026-09-29T08:00:00Z" },
        { id: "o2", display_id: "2", customer_phone: "+38970222222", customer_name: "B", product_name: "Y", next_call_after: "2026-10-01T11:00:00Z", call_again_since: "2026-10-01T09:00:00Z" },
      ],
      members: [
        { list_id: LIST, customer_phone: "070111111", customer_name: "A dup", in_call_again_until: null, call_again_since: "2026-09-20T00:00:00Z", prediction_segment_lists: { name: "L" } },
        { list_id: LIST, customer_phone: "+38970333333", customer_name: "C", in_call_again_until: "2026-10-01T09:30:00Z", call_again_since: "2026-09-27T08:00:00Z", last_call_at: "2026-09-30T08:00:00Z", last_call_outcome: "no_answer", prediction_segment_lists: { name: "L" } },
        { list_id: LIST, customer_phone: "+38970444444", customer_name: "D", in_call_again_until: "2026-10-03T08:00:00Z", call_again_since: "2026-09-30T08:00:00Z", prediction_segment_lists: { name: "L" } },
      ],
      lastCalls: [{ phone8: "70111111", last_call_at: "2026-09-30T12:00:00Z", outcome: "no_answer" }],
    });
    expect(r.items.map((i) => i.customer_name)).toEqual(["C", "A", "B", "D"]);
    expect(r).toMatchObject({ total: 4, due: 2, soon: 1 });
    expect(r.items[1]).toMatchObject({ kind: "order", order_id: "o1", last_call_at: "2026-09-30T12:00:00Z", due_state: "due" });
    expect(r.items[2]).toMatchObject({ due_state: "soon" });
    expect(r.items[3]).toMatchObject({ kind: "prediction", list_name: "L", due_state: "later" });
  });
  it("due states", () => {
    expect(dueStateOf(null, NOW)).toBe("due");
    expect(dueStateOf("2026-10-01T09:00:00Z", NOW)).toBe("due");
    expect(dueStateOf("2026-10-01T11:59:00Z", NOW)).toBe("soon");
    expect(dueStateOf("2026-10-01T12:01:00Z", NOW)).toBe("later");
  });
});

describe("pickLeaderboardSelf — the TV board's numbers", () => {
  it("returns the caller's own sales and worked", () => {
    expect(pickLeaderboardSelf({ rows: [{ user_id: "x", sales: 9 }, { user_id: "me", sales: "3", worked: 12 }] }, "me")).toEqual({ sales: 3, worked: 12 });
  });
  it("null when off the board or malformed", () => {
    expect(pickLeaderboardSelf({ rows: [] }, "me")).toBeNull();
    expect(pickLeaderboardSelf(null, "me")).toBeNull();
    expect(pickLeaderboardSelf({ rows: "x" }, "me")).toBeNull();
  });
});
