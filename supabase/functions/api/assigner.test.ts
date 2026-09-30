import { describe, expect, it } from "vitest";
import {
  ASSIGNER_DEPARTMENTS, AUDIT_IDS_CAP, assignerBroadcastBody, distributeAudit, distributeNotifications,
  distributeRpcArgs, distributeRpcError, parseCallAgainsQuery, parseDepartmentsParam, parseDistributeBody,
  parseOrderParam, phone8, shapeBoard, shapeCallAgainItem, shapeDistribute, shapeLists,
} from "./assigner.ts";

const A1 = "11111111-1111-4111-8111-111111111111";
const A2 = "22222222-2222-4222-8222-222222222222";
const A3 = "33333333-3333-4333-8333-333333333333";
const LIST = "44444444-4444-4444-8444-444444444444";

describe("departments / order params", () => {
  it("keeps the canonical order, drops duplicates, 'unknown' allowed", () => {
    const r = parseDepartmentsParam("web,altercpa,unknown,altercpa, social ");
    expect(r).toEqual({ ok: true, departments: ["altercpa", "social", "web", "unknown"] });
  });
  it("missing or empty = all (null)", () => {
    expect(parseDepartmentsParam(null)).toEqual({ ok: true, departments: null });
    expect(parseDepartmentsParam(" ")).toEqual({ ok: true, departments: null });
    expect(parseDepartmentsParam(",,")).toEqual({ ok: true, departments: null });
  });
  it("an unknown key is a 400", () => {
    expect(parseDepartmentsParam("altercpa,teleshop")).toEqual({ ok: false, error: "invalid department: teleshop" });
  });
  it("seven keys, the six departments first", () => {
    expect(ASSIGNER_DEPARTMENTS).toEqual(["altercpa", "elyon_crm", "teleshop_out", "teleshop_other", "social", "web", "unknown"]);
  });
  it("order param falls back to the default", () => {
    expect(parseOrderParam("OLDEST", ["newest", "oldest"] as const, "newest")).toBe("oldest");
    expect(parseOrderParam("sideways", ["newest", "oldest"] as const, "newest")).toBe("newest");
    expect(parseOrderParam(null, ["oldest", "newest"] as const, "oldest")).toBe("oldest");
  });
});

describe("parseDistributeBody", () => {
  const base = { kind: "list", list_id: LIST, order: "newest", count: 100, split: "total", agent_ids: [A1, A2, A3], include_assigned: false, dry_run: false };

  it("accepts a full body", () => {
    const r = parseDistributeBody({ ...base, departments: ["teleshop_out", "altercpa"] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args).toEqual({
      kind: "list", list_id: LIST, departments: ["altercpa", "teleshop_out"], order: "newest", count: 100,
      split: "total", agent_ids: [A1, A2, A3], include_assigned: false, dry_run: false, source: "all",
    });
  });
  it("dry_run defaults to TRUE — nothing is written unless the caller says false", () => {
    const { dry_run: _omit, ...rest } = base;
    const r = parseDistributeBody(rest);
    expect(r.ok && r.args.dry_run).toBe(true);
  });
  it("count null / missing / 'all' = all", () => {
    for (const count of [null, undefined, "all"]) {
      const r = parseDistributeBody({ ...base, count });
      expect(r.ok && r.args.count).toBe(null);
    }
  });
  it("rejects a bad count", () => {
    for (const count of [0, -5, 2.5, "abc", 100_001]) {
      expect(parseDistributeBody({ ...base, count }).ok).toBe(false);
    }
  });
  it("defaults: split total, order newest, source all", () => {
    const r = parseDistributeBody({ kind: "pendings", agent_ids: [A1] });
    expect(r.ok && r.args).toMatchObject({ split: "total", order: "newest", source: "all", list_id: null, dry_run: true, include_assigned: false });
  });
  it("a list needs a list_id; the others ignore it", () => {
    expect(parseDistributeBody({ ...base, list_id: undefined })).toEqual({ ok: false, error: "list_id required" });
    const r = parseDistributeBody({ ...base, kind: "call_agains", list_id: "junk", source: "prediction" });
    expect(r.ok && r.args.list_id).toBe(null);
    expect(r.ok && r.args.source).toBe("prediction");
  });
  it("random is for lists only", () => {
    expect(parseDistributeBody({ ...base, order: "random" }).ok).toBe(true);
    expect(parseDistributeBody({ ...base, kind: "pendings", order: "random" })).toEqual({ ok: false, error: "random order is for lists only" });
  });
  it("rejects bad kind / split / source / departments / flags", () => {
    expect(parseDistributeBody({ ...base, kind: "all" }).ok).toBe(false);
    expect(parseDistributeBody({ ...base, split: "half" }).ok).toBe(false);
    expect(parseDistributeBody({ ...base, kind: "call_agains", source: "web" }).ok).toBe(false);
    expect(parseDistributeBody({ ...base, departments: "altercpa" }).ok).toBe(false);
    expect(parseDistributeBody({ ...base, departments: ["nope"] }).ok).toBe(false);
    expect(parseDistributeBody({ ...base, dry_run: "no" }).ok).toBe(false);
    expect(parseDistributeBody({ ...base, include_assigned: 1 }).ok).toBe(false);
    expect(parseDistributeBody(null).ok).toBe(false);
    expect(parseDistributeBody([base]).ok).toBe(false);
  });
  it("agents: required, uuids only, duplicates dropped in order, capped", () => {
    expect(parseDistributeBody({ ...base, agent_ids: [] })).toEqual({ ok: false, error: "agent_ids required" });
    expect(parseDistributeBody({ ...base, agent_ids: "x" }).ok).toBe(false);
    expect(parseDistributeBody({ ...base, agent_ids: [A1, "not-a-uuid"] })).toEqual({ ok: false, error: "invalid agent id" });
    const r = parseDistributeBody({ ...base, agent_ids: [A2, A1.toUpperCase(), A2, A1] });
    expect(r.ok && r.args.agent_ids).toEqual([A2, A1]);
    const many = Array.from({ length: 101 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    expect(parseDistributeBody({ ...base, agent_ids: many })).toEqual({ ok: false, error: "too many agents" });
  });
  it("maps to the RPC's named arguments", () => {
    const r = parseDistributeBody({ ...base, kind: "call_agains", source: "order", count: null, split: "per_agent" });
    if (!r.ok) throw new Error("parse");
    expect(distributeRpcArgs(r.args, "Mile Stoev")).toEqual({
      p_kind: "call_agains", p_list_id: null, p_departments: null, p_order: "newest", p_count: null,
      p_split: "per_agent", p_agent_ids: [A1, A2, A3], p_include_assigned: false, p_dry_run: false,
      p_source: "order", p_actor_name: "Mile Stoev",
    });
  });
});

// An assigner_distribute() payload: 100 over 3 = 34/33/33 (migration 20260942001960).
const rpcDistribute = {
  kind: "list", dry_run: false, list_id: LIST, departments: null, order: "newest", split: "total", count: 100,
  source: null, agents: 3, pool: 5168, selected: 100, assigned: 100,
  per_agent: [
    { agent_id: A1, full_name: "Adela", count: 34, orders: 0, members: 34 },
    { agent_id: A2, full_name: "Aida", count: 33, orders: 0, members: 33 },
    { agent_id: A3, full_name: "Aleksandra", count: 33, orders: 0, members: 33 },
  ],
  ids: Array.from({ length: 100 }, (_, i) => `member:${LIST}:+3897000${String(i).padStart(4, "0")}`),
  ids_truncated: false,
};

describe("shapeDistribute", () => {
  it("returns exactly the contract — no ids, no extra keys", () => {
    const out = shapeDistribute(rpcDistribute);
    expect(out).toEqual({
      kind: "list", dry_run: false, pool: 5168, selected: 100, assigned: 100,
      per_agent: [
        { agent_id: A1, full_name: "Adela", count: 34 },
        { agent_id: A2, full_name: "Aida", count: 33 },
        { agent_id: A3, full_name: "Aleksandra", count: 33 },
      ],
    });
    expect(Object.keys(out).sort()).toEqual(["assigned", "dry_run", "kind", "per_agent", "pool", "selected"]);
  });
  it("coerces numbers and survives junk", () => {
    expect(shapeDistribute({ kind: "pendings", dry_run: true, pool: "17", selected: "5", assigned: null, per_agent: [null, { agent_id: A1, count: "5" }] }))
      .toEqual({ kind: "pendings", dry_run: true, pool: 17, selected: 5, assigned: 0, per_agent: [{ agent_id: A1, full_name: null, count: 5 }] });
    expect(shapeDistribute(null).per_agent).toEqual([]);
  });
});

describe("distributeRpcError", () => {
  it("passes the SQL refusals (22023) through as 400", () => {
    expect(distributeRpcError({ code: "22023", message: "list is not assignable" })).toEqual({ status: 400, error: "list is not assignable" });
  });
  it("anything else is left to the sanitiser", () => {
    expect(distributeRpcError({ code: "42883", message: "function does not exist" })).toBe(null);
    expect(distributeRpcError(null)).toBe(null);
  });
});

describe("distributeNotifications", () => {
  const per = [
    { agent_id: A1, full_name: "Adela", count: 34 },
    { agent_id: A2, full_name: "Aida", count: 0 },
    { agent_id: A3, full_name: "Aleksandra", count: 1 },
  ];
  it("one ping per receiving agent, never the caller, never a zero", () => {
    const out = distributeNotifications("list", per, A3);
    expect(out.map((n) => n.agent_id)).toEqual([A1]);
    expect(out[0].notification).toEqual({
      type: "assignment",
      title: "New prediction leads assigned to you",
      message: "34 new leads assigned to you — open Prediction Leads to start calling.",
      link: "/prediction-leads",
      meta: { i18n: "notif.predictionLeadsAssigned", count: 34 },
    });
  });
  it("the per-kind texts of the old routes (singular / plural)", () => {
    const p = distributeNotifications("pendings", per, "someone-else");
    expect(p.map((n) => n.notification.meta)).toEqual([
      { i18n: "notif.ordersAssigned", count: 34 }, { i18n: "notif.ordersAssigned", count: 1 },
    ]);
    expect(p[1].notification.message).toBe("1 order assigned to you — open Assigned to Me.");
    const c = distributeNotifications("call_agains", per, "x");
    expect(c[0].notification).toMatchObject({ title: "Call Agains assigned to you", link: "/call-again", meta: { i18n: "notif.callAgainsAssigned", count: 34 } });
    expect(c[1].notification.message).toBe("1 customer to call back — open Call Again.");
  });
});

describe("distributeAudit", () => {
  const parsed = parseDistributeBody({ kind: "list", list_id: LIST, count: 100, agent_ids: [A1, A2, A3], dry_run: false });
  if (!parsed.ok) throw new Error("parse");
  it("records the request, the result and the ids", () => {
    const a = distributeAudit(parsed.args, rpcDistribute);
    expect(a.target_type).toBe("prediction_segment_members");
    expect(a.target_id).toBe(LIST);
    expect(a.target_name).toBe("100 list → 3 agents");
    expect(a.payload).toMatchObject({ kind: "list", pool: 5168, selected: 100, assigned: 100, per_agent: { [A1]: 34, [A2]: 33, [A3]: 33 } });
    expect((a.payload as any).ids).toHaveLength(100);
  });
  it("omits the ids above the cap", () => {
    const big = { ...rpcDistribute, ids: Array.from({ length: AUDIT_IDS_CAP + 1 }, (_, i) => `order:${i}`) };
    const a = distributeAudit(parsed.args, big);
    expect((a.payload as any).ids).toBeUndefined();
    expect((a.payload as any).ids_omitted).toBe(true);
    const none = distributeAudit(parsed.args, { ...rpcDistribute, ids: null });
    expect((none.payload as any).ids_omitted).toBe(true);
  });
});

// An assigner_board() payload (migration 20260942001950).
const rpcBoard = {
  generated_at: "2026-09-30T14:45:00+00:00",
  agents: [
    {
      user_id: A1, full_name: "Stanka", roles: ["pending_agent", "prediction_agent"], is_admin: false, is_manager: false,
      team_key: "teleshop", team_name: "Телешоп", team_lane: "out", online: true, in_call: false,
      last_seen_at: "2026-09-30T14:44:26+00:00", shift: { start: "09:00", end: "20:20" },
      pendings: 3, pendings_pending: 1, pendings_take: 0, call_agains: 12, call_agains_orders: 2, call_agains_members: 10,
      list_open: 60, list_parked: 4, list_assigned: 62, worked_today: 14, secret_future_key: "x",
    },
    { user_id: A2, full_name: null, roles: null, online: "true", shift: { start: "07:00" } },
  ],
  totals: {
    agents: 50, online: 2, in_call: 0, pendings_unassigned: 16, call_agains_unassigned: 343,
    call_agains_unassigned_orders: 121, call_agains_unassigned_members: 222,
    oldest_call_again_since: "2026-09-24T13:26:10+00:00", worked_today: 453,
  },
};

describe("shapeBoard", () => {
  it("returns exactly the contract per agent", () => {
    const out = shapeBoard(rpcBoard);
    expect(out.generated_at).toBe("2026-09-30T14:45:00+00:00");
    expect(out.agents[0]).toEqual({
      user_id: A1, full_name: "Stanka", roles: ["pending_agent", "prediction_agent"], is_admin: false, is_manager: false,
      team_key: "teleshop", team_name: "Телешоп", team_lane: "out", online: true, in_call: false,
      last_seen_at: "2026-09-30T14:44:26+00:00", shift: { start: "09:00", end: "20:20" },
      pendings: 3, pendings_pending: 1, pendings_take: 0, call_agains: 12, call_agains_orders: 2, call_agains_members: 10,
      list_open: 60, list_parked: 4, list_assigned: 62, worked_today: 14,
    });
  });
  it("defaults a sparse agent (nulls, zeros, no half shift)", () => {
    const a = shapeBoard(rpcBoard).agents[1];
    expect(a).toMatchObject({ user_id: A2, full_name: null, roles: [], online: true, in_call: false, shift: null, team_key: null, team_lane: null, last_seen_at: null, pendings: 0, worked_today: 0 });
  });
  it("totals — exactly the contract", () => {
    expect(shapeBoard(rpcBoard).totals).toEqual(rpcBoard.totals);
    expect(shapeBoard({}).totals).toEqual({
      agents: 0, online: 0, in_call: 0, pendings_unassigned: 0, call_agains_unassigned: 0,
      call_agains_unassigned_orders: 0, call_agains_unassigned_members: 0, oldest_call_again_since: null, worked_today: 0,
    });
  });
});

describe("shapeLists", () => {
  const rpcLists = {
    generated_at: "2026-09-30T15:00:00+00:00",
    departments: ["altercpa", "teleshop_out"],
    lists: [{
      id: LIST, name: "57d ≤26 (1-3 orders)", description: "Last paid 57-120 days ago", category: "value", is_static: false,
      display_order: 23, assignable: true, total: 446, distributable: 221, assigned: 197, done: 33, open: 413,
      by_department: {
        altercpa: { total: 365, distributable: 141, assigned: 196, done: 33 },
        teleshop_out: { total: 81, distributable: 80, assigned: 1, done: 0 },
        social: { total: 173, distributable: 173, assigned: 0, done: 0 },
      },
    }],
    totals: { total: 446, distributable: 221, assigned: 197, done: 33 },
  };
  it("returns the contract with all seven department keys", () => {
    const out = shapeLists(rpcLists);
    expect(out.departments).toEqual(["altercpa", "teleshop_out"]);
    expect(Object.keys(out.lists[0].by_department)).toEqual([...ASSIGNER_DEPARTMENTS]);
    expect(out.lists[0].by_department.web).toEqual({ total: 0, distributable: 0, assigned: 0, done: 0 });
    expect(out.lists[0].by_department.altercpa).toEqual({ total: 365, distributable: 141, assigned: 196, done: 33 });
    expect(out.lists[0]).toMatchObject({ id: LIST, assignable: true, total: 446, open: 413, description: "Last paid 57-120 days ago" });
    expect(out.totals).toEqual(rpcLists.totals);
  });
  it("departments null = all", () => {
    expect(shapeLists({ ...rpcLists, departments: null }).departments).toBe(null);
    expect(shapeLists({}).lists).toEqual([]);
  });
});

describe("GET /call-agains", () => {
  it("parses the old params and the new ones", () => {
    expect(parseCallAgainsQuery({ page: "2", limit: "500", agent_id: "unassigned", source: "order", order: "newest", departments: "web,altercpa" }))
      .toEqual({ ok: true, query: { agent: "unassigned", source: "order", departments: ["altercpa", "web"], order: "newest", page: 2, limit: 200 } });
    expect(parseCallAgainsQuery({})).toEqual({ ok: true, query: { agent: null, source: "all", departments: null, order: "oldest", page: 1, limit: 50 } });
    expect(parseCallAgainsQuery({ agent_id: A1.toUpperCase() }).ok && (parseCallAgainsQuery({ agent_id: A1 }) as any).query.agent).toBe(A1);
    expect((parseCallAgainsQuery({ agent_id: "all" }) as any).query.agent).toBe(null);
    expect(parseCallAgainsQuery({ departments: "x" }).ok).toBe(false);
  });
  it("an order item: the real last call, else call_again_since — never updated_at", () => {
    const item = {
      source_kind: "order", list_id: "order:abc", order_id: "abc", customer_phone: "+38970123456", customer_name: "Ana",
      call_again_since: "2026-09-25T09:10:06+00:00", last_call_at: null, last_call_outcome: "no_answer", in_call_again_until: null,
      assigned_agent_id: null, assigned_agent_name: null, lifetime_value: 24.4, paid_count: null, avg_package_price: 24.4,
      list_name: "Alpha Male", list_category: "order", department: "altercpa",
    };
    expect(shapeCallAgainItem(item, { last_call_at: "2026-09-29T10:00:00+00:00", outcome: "no_answer" })).toEqual({
      source_kind: "order", list_id: "order:abc", order_id: "abc", customer_phone: "+38970123456", customer_name: "Ana",
      call_again_since: "2026-09-25T09:10:06+00:00", last_call_at: "2026-09-29T10:00:00+00:00", last_call_outcome: "no_answer",
      in_call_again_until: null, assigned_agent_id: null, assigned_agent_name: null, lifetime_value: 24.4, paid_count: null,
      avg_package_price: 24.4, prediction_segment_lists: { name: "Alpha Male", category: "order" }, department: "altercpa",
    });
    expect(shapeCallAgainItem(item, null).last_call_at).toBe("2026-09-25T09:10:06+00:00");
  });
  it("a member keeps its own last call; no order_id key", () => {
    const m = shapeCallAgainItem({
      source_kind: "prediction", list_id: LIST, customer_phone: "+38976503941", call_again_since: "2026-09-24T13:26:10+00:00",
      last_call_at: "2026-09-24T13:26:10+00:00", last_call_outcome: "no_answer", paid_count: 4, list_name: "4-6m", list_category: "value", department: null,
    }, { last_call_at: "2030-01-01T00:00:00Z", outcome: "confirmed" });
    expect(m.last_call_at).toBe("2026-09-24T13:26:10+00:00");
    expect("order_id" in m).toBe(false);
    expect(m.department).toBe("unknown");
    expect(m.paid_count).toBe(4);
  });
  it("phone8 = the last 8 digits", () => {
    expect(phone8("+389 70 123 456")).toBe("70123456");
    expect(phone8(null)).toBe("");
  });
});

describe("assignerBroadcastBody", () => {
  it("channel assigner, event refresh, payload {agent_id?}", () => {
    expect(assignerBroadcastBody({ agent_id: A1 })).toEqual({ messages: [{ topic: "assigner", event: "refresh", payload: { agent_id: A1 } }] });
    expect(assignerBroadcastBody()).toEqual({ messages: [{ topic: "assigner", event: "refresh", payload: {} }] });
    expect(assignerBroadcastBody({ agent_id: null })).toEqual({ messages: [{ topic: "assigner", event: "refresh", payload: {} }] });
  });
});
