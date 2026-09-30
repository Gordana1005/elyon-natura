// ============================================================================
// The Assigner redesign (plan "Assigner redesign", Part A5, 30.09.2026) — the
// pure half of
//   GET  /api/assigner/board        public.assigner_board()        (…001950)
//   GET  /api/assigner/lists        public.assigner_lists()        (…001957)
//   POST /api/assigner/distribute   public.assigner_distribute()   (…001960)
// and of the fixed GET /api/call-agains (public.assigner_call_agains, …001962)
// and GET /api/orders/unassigned-pending.
//
// Dependency-free on purpose (no Deno globals, no URL imports): vitest runs
// assigner.test.ts against this file in Node, and index.ts imports it.
//
// The SQL decides everything (who is on the board, the pools, the deal). This
// file only
//   • validates query strings and the distribute body before an RPC runs,
//   • shapes each RPC payload into the EXACT response contract the frontend
//     codes against — a whitelist of keys with numbers coerced, so a key added
//     to an RPC later never leaks into a response by accident,
//   • builds the per-agent notifications and the audit payload of a real
//     distribution, and the realtime broadcast body (`assigner` / `refresh`).
// ============================================================================

/** The six departments in the owner's order, and 'unknown' (a buyer with no
 *  customer_departments row). The same keys as the SQL (assigner_dept_key). */
export const ASSIGNER_DEPARTMENTS = [
  "altercpa", "elyon_crm", "teleshop_out", "teleshop_other", "social", "web", "unknown",
] as const;
export type AssignerDepartment = typeof ASSIGNER_DEPARTMENTS[number];

export const DISTRIBUTE_KINDS = ["list", "pendings", "call_agains"] as const;
export type DistributeKind = typeof DISTRIBUTE_KINDS[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** More agents than this in one distribution is a mistake, not a use case. */
export const MAX_DISTRIBUTE_AGENTS = 100;
/** The largest single count a distribution accepts (the biggest list is ~13k). */
export const MAX_DISTRIBUTE_COUNT = 100_000;

type Ok<T> = { ok: true } & T;
type Err = { ok: false; error: string };

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown): string | null => (v == null || v === "" ? null : String(v));
const bool = (v: unknown): boolean => v === true || v === "true";
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Canonical order, de-duplicated; unknown keys are an error. */
function normaliseDepartments(list: string[]): Ok<{ departments: AssignerDepartment[] | null }> | Err {
  const want = new Set<string>();
  for (const raw of list) {
    const k = String(raw ?? "").trim();
    if (!k) continue;
    if (!(ASSIGNER_DEPARTMENTS as readonly string[]).includes(k)) return { ok: false, error: `invalid department: ${k}` };
    want.add(k);
  }
  if (want.size === 0) return { ok: true, departments: null };
  return { ok: true, departments: ASSIGNER_DEPARTMENTS.filter((k) => want.has(k)) };
}

/** `?departments=a,b` → the keys, or null for "all" (missing / empty). */
export function parseDepartmentsParam(raw: string | null | undefined): Ok<{ departments: AssignerDepartment[] | null }> | Err {
  if (raw == null || raw.trim() === "") return { ok: true, departments: null };
  return normaliseDepartments(raw.split(","));
}

/** `?order=` for a listing: one of the allowed values, else the default. */
export function parseOrderParam<T extends string>(raw: string | null | undefined, allowed: readonly T[], fallback: T): T {
  const v = String(raw ?? "").trim().toLowerCase();
  return (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

// ── POST /assigner/distribute ────────────────────────────────────────────────

export interface DistributeArgs {
  kind: DistributeKind;
  list_id: string | null;
  departments: AssignerDepartment[] | null;
  order: "newest" | "oldest" | "random";
  count: number | null;
  split: "total" | "per_agent";
  agent_ids: string[];
  include_assigned: boolean;
  dry_run: boolean;
  source: "all" | "order" | "prediction";
}

/**
 * The request body → the RPC's arguments, or a 400.
 * Body: {kind, list_id?, departments?, order, count (null = all), split,
 *        agent_ids, include_assigned, dry_run, source?}
 * `dry_run` defaults to TRUE — nothing is written unless the caller says
 * `dry_run: false`. `split` defaults to 'total', `order` to 'newest',
 * `source` to 'all'. Duplicate agent ids are dropped (first position kept).
 */
export function parseDistributeBody(body: unknown): Ok<{ args: DistributeArgs }> | Err {
  if (!isObj(body)) return { ok: false, error: "invalid body" };

  const kind = String(body.kind ?? "").trim();
  if (!(DISTRIBUTE_KINDS as readonly string[]).includes(kind)) return { ok: false, error: "invalid kind" };

  let listId: string | null = null;
  if (kind === "list") {
    listId = typeof body.list_id === "string" ? body.list_id.trim() : "";
    if (!UUID_RE.test(listId)) return { ok: false, error: "list_id required" };
  }

  let departments: AssignerDepartment[] | null = null;
  if (body.departments != null) {
    if (!Array.isArray(body.departments)) return { ok: false, error: "departments must be an array" };
    const d = normaliseDepartments(body.departments.map((x) => String(x ?? "")));
    if (!d.ok) return d;
    departments = d.departments;
  }

  const order = body.order == null ? "newest" : String(body.order).trim();
  if (!["newest", "oldest", "random"].includes(order)) return { ok: false, error: "invalid order" };
  if (order === "random" && kind !== "list") return { ok: false, error: "random order is for lists only" };

  let count: number | null = null;
  if (body.count != null && body.count !== "all") {
    const c = typeof body.count === "number" ? body.count : Number(body.count);
    if (!Number.isInteger(c) || c < 1 || c > MAX_DISTRIBUTE_COUNT) {
      return { ok: false, error: "count must be a whole number from 1, or null for all" };
    }
    count = c;
  }

  const split = body.split == null ? "total" : String(body.split).trim();
  if (split !== "total" && split !== "per_agent") return { ok: false, error: "invalid split" };

  if (!Array.isArray(body.agent_ids)) return { ok: false, error: "agent_ids required" };
  const agentIds: string[] = [];
  for (const raw of body.agent_ids) {
    if (typeof raw !== "string" || !UUID_RE.test(raw.trim())) return { ok: false, error: "invalid agent id" };
    const id = raw.trim().toLowerCase();
    if (!agentIds.includes(id)) agentIds.push(id);
  }
  if (agentIds.length === 0) return { ok: false, error: "agent_ids required" };
  if (agentIds.length > MAX_DISTRIBUTE_AGENTS) return { ok: false, error: "too many agents" };

  if (body.include_assigned != null && typeof body.include_assigned !== "boolean") {
    return { ok: false, error: "include_assigned must be true or false" };
  }
  if (body.dry_run != null && typeof body.dry_run !== "boolean") {
    return { ok: false, error: "dry_run must be true or false" };
  }

  const source = body.source == null ? "all" : String(body.source).trim();
  if (!["all", "order", "prediction"].includes(source)) return { ok: false, error: "invalid source" };

  return {
    ok: true,
    args: {
      kind: kind as DistributeKind,
      list_id: listId,
      departments,
      order: order as DistributeArgs["order"],
      count,
      split: split as DistributeArgs["split"],
      agent_ids: agentIds,
      include_assigned: body.include_assigned === true,
      dry_run: body.dry_run !== false,
      source: source as DistributeArgs["source"],
    },
  };
}

/** The RPC's named arguments (supabase-js .rpc payload). */
export function distributeRpcArgs(a: DistributeArgs, actorName: string | null) {
  return {
    p_kind: a.kind,
    p_list_id: a.list_id,
    p_departments: a.departments,
    p_order: a.order,
    p_count: a.count,
    p_split: a.split,
    p_agent_ids: a.agent_ids,
    p_include_assigned: a.include_assigned,
    p_dry_run: a.dry_run,
    p_source: a.source,
    p_actor_name: actorName,
  };
}

export interface DistributePerAgent { agent_id: string; full_name: string | null; count: number }
export interface DistributeResponse {
  kind: DistributeKind;
  dry_run: boolean;
  pool: number;
  selected: number;
  assigned: number;
  per_agent: DistributePerAgent[];
}

/** assigner_distribute() → the EXACT response contract (no ids). */
export function shapeDistribute(raw: unknown): DistributeResponse {
  const r = isObj(raw) ? raw : {};
  const per = Array.isArray(r.per_agent) ? r.per_agent : [];
  return {
    kind: String(r.kind ?? "") as DistributeKind,
    dry_run: r.dry_run !== false,
    pool: num(r.pool),
    selected: num(r.selected),
    assigned: num(r.assigned),
    per_agent: per.filter(isObj).map((p) => ({
      agent_id: String(p.agent_id ?? ""),
      full_name: str(p.full_name),
      count: num(p.count),
    })),
  };
}

/**
 * The SQL raises SQLSTATE 22023 with a short, safe message for every refusal
 * (invalid kind / order / split / department, no agents, inactive or unknown
 * agent, list not found / not active / not assignable). Those go back as 400
 * with the message; anything else is not the caller's fault and is sanitised
 * by the route.
 */
export function distributeRpcError(err: { code?: string; message?: string } | null | undefined):
  { status: 400; error: string } | null {
  if (err && err.code === "22023" && typeof err.message === "string" && err.message.length <= 200) {
    return { status: 400, error: err.message };
  }
  return null;
}

type Notification = { type: string; title: string; message: string; link: string; meta: Record<string, unknown> };

/**
 * One summary ping per agent who received work in a REAL run (never the caller
 * themself, never an agent who got 0) — the same texts, links and i18n keys the
 * per-kind routes already send: segments/:id/auto-assign (list),
 * orders/bulk-assign (pendings), call-agains/assign (call-agains).
 */
export function distributeNotifications(kind: DistributeKind, perAgent: DistributePerAgent[], actorId: string):
  Array<{ agent_id: string; notification: Notification }> {
  const out: Array<{ agent_id: string; notification: Notification }> = [];
  for (const p of perAgent) {
    const n = p.count;
    if (!p.agent_id || n <= 0 || p.agent_id === actorId) continue;
    const s = n === 1 ? "" : "s";
    let notification: Notification;
    if (kind === "list") {
      notification = {
        type: "assignment",
        title: "New prediction leads assigned to you",
        message: `${n} new lead${s} assigned to you — open Prediction Leads to start calling.`,
        link: "/prediction-leads",
        meta: { i18n: "notif.predictionLeadsAssigned", count: n },
      };
    } else if (kind === "pendings") {
      notification = {
        type: "assignment",
        title: "New orders assigned to you",
        message: `${n} order${s} assigned to you — open Assigned to Me.`,
        link: "/assigned",
        meta: { i18n: "notif.ordersAssigned", count: n },
      };
    } else {
      notification = {
        type: "assignment",
        title: "Call Agains assigned to you",
        message: `${n} customer${s} to call back — open Call Again.`,
        link: "/call-again",
        meta: { i18n: "notif.callAgainsAssigned", count: n },
      };
    }
    out.push({ agent_id: p.agent_id, notification });
  }
  return out;
}

/** Ids kept in the audit row up to this many; beyond it only the counts. */
export const AUDIT_IDS_CAP = 1000;

/** The audit_log row of a real distribution (action 'assigner.distribute'). */
export function distributeAudit(a: DistributeArgs, raw: unknown) {
  const r = isObj(raw) ? raw : {};
  const shaped = shapeDistribute(raw);
  const ids = Array.isArray(r.ids) ? r.ids : null;
  const keepIds = !!ids && ids.length <= AUDIT_IDS_CAP;
  const names = shaped.per_agent.filter((p) => p.count > 0).map((p) => p.full_name || p.agent_id);
  return {
    target_type: a.kind === "list" ? "prediction_segment_members" : a.kind === "pendings" ? "order" : "callback",
    target_id: a.kind === "list" ? a.list_id : null,
    target_name: `${shaped.assigned} ${a.kind} → ${names.length} agent${names.length === 1 ? "" : "s"}`,
    payload: {
      kind: a.kind,
      list_id: a.list_id,
      departments: a.departments,
      order: a.order,
      count: a.count,
      split: a.split,
      source: a.kind === "call_agains" ? a.source : null,
      include_assigned: a.include_assigned,
      agent_ids: a.agent_ids,
      pool: shaped.pool,
      selected: shaped.selected,
      assigned: shaped.assigned,
      per_agent: Object.fromEntries(shaped.per_agent.map((p) => [p.agent_id, p.count])),
      ...(keepIds ? { ids } : { ids_omitted: true }),
    },
  };
}

// ── GET /assigner/board ──────────────────────────────────────────────────────

export interface BoardAgent {
  user_id: string;
  full_name: string | null;
  roles: string[];
  is_admin: boolean;
  is_manager: boolean;
  team_key: string | null;
  team_name: string | null;
  online: boolean;
  in_call: boolean;
  last_seen_at: string | null;
  shift: { start: string; end: string } | null;
  pendings: number;
  pendings_pending: number;
  pendings_take: number;
  call_agains: number;
  call_agains_orders: number;
  call_agains_members: number;
  list_open: number;
  list_parked: number;
  list_assigned: number;
  worked_today: number;
}
export interface BoardTotals {
  agents: number;
  online: number;
  in_call: number;
  pendings_unassigned: number;
  call_agains_unassigned: number;
  call_agains_unassigned_orders: number;
  call_agains_unassigned_members: number;
  oldest_call_again_since: string | null;
  worked_today: number;
}
export interface BoardResponse { generated_at: string | null; agents: BoardAgent[]; totals: BoardTotals }

/** assigner_board() → the EXACT response contract. */
export function shapeBoard(raw: unknown): BoardResponse {
  const r = isObj(raw) ? raw : {};
  const agents = (Array.isArray(r.agents) ? r.agents : []).filter(isObj).map((a): BoardAgent => {
    const sh = isObj(a.shift) && typeof a.shift.start === "string" && typeof a.shift.end === "string"
      ? { start: a.shift.start, end: a.shift.end } : null;
    return {
      user_id: String(a.user_id ?? ""),
      full_name: str(a.full_name),
      roles: Array.isArray(a.roles) ? a.roles.map(String) : [],
      is_admin: bool(a.is_admin),
      is_manager: bool(a.is_manager),
      team_key: str(a.team_key),
      team_name: str(a.team_name),
      online: bool(a.online),
      in_call: bool(a.in_call),
      last_seen_at: str(a.last_seen_at),
      shift: sh,
      pendings: num(a.pendings),
      pendings_pending: num(a.pendings_pending),
      pendings_take: num(a.pendings_take),
      call_agains: num(a.call_agains),
      call_agains_orders: num(a.call_agains_orders),
      call_agains_members: num(a.call_agains_members),
      list_open: num(a.list_open),
      list_parked: num(a.list_parked),
      list_assigned: num(a.list_assigned),
      worked_today: num(a.worked_today),
    };
  });
  const t = isObj(r.totals) ? r.totals : {};
  return {
    generated_at: str(r.generated_at),
    agents,
    totals: {
      agents: num(t.agents),
      online: num(t.online),
      in_call: num(t.in_call),
      pendings_unassigned: num(t.pendings_unassigned),
      call_agains_unassigned: num(t.call_agains_unassigned),
      call_agains_unassigned_orders: num(t.call_agains_unassigned_orders),
      call_agains_unassigned_members: num(t.call_agains_unassigned_members),
      oldest_call_again_since: str(t.oldest_call_again_since),
      worked_today: num(t.worked_today),
    },
  };
}

// ── GET /assigner/lists ──────────────────────────────────────────────────────

export interface DeptCounts { total: number; distributable: number; assigned: number; done: number }
export interface ListRow {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  is_static: boolean;
  display_order: number;
  assignable: boolean;
  total: number;
  distributable: number;
  assigned: number;
  done: number;
  open: number;
  by_department: Record<AssignerDepartment, DeptCounts>;
}
export interface ListsResponse {
  generated_at: string | null;
  departments: AssignerDepartment[] | null;
  lists: ListRow[];
  totals: DeptCounts;
}

const deptCounts = (v: unknown): DeptCounts => {
  const o = isObj(v) ? v : {};
  return { total: num(o.total), distributable: num(o.distributable), assigned: num(o.assigned), done: num(o.done) };
};

/** assigner_lists() → the EXACT response contract (all seven department keys). */
export function shapeLists(raw: unknown): ListsResponse {
  const r = isObj(raw) ? raw : {};
  const lists = (Array.isArray(r.lists) ? r.lists : []).filter(isObj).map((l): ListRow => {
    const bd = isObj(l.by_department) ? l.by_department : {};
    const by = Object.fromEntries(ASSIGNER_DEPARTMENTS.map((k) => [k, deptCounts(bd[k])])) as Record<AssignerDepartment, DeptCounts>;
    return {
      id: String(l.id ?? ""),
      name: String(l.name ?? ""),
      description: str(l.description),
      category: str(l.category),
      is_static: bool(l.is_static),
      display_order: num(l.display_order),
      assignable: bool(l.assignable),
      total: num(l.total),
      distributable: num(l.distributable),
      assigned: num(l.assigned),
      done: num(l.done),
      open: num(l.open),
      by_department: by,
    };
  });
  const depts = Array.isArray(r.departments)
    ? ASSIGNER_DEPARTMENTS.filter((k) => (r.departments as unknown[]).includes(k))
    : null;
  return {
    generated_at: str(r.generated_at),
    departments: depts && depts.length ? depts : null,
    lists,
    totals: deptCounts(r.totals),
  };
}

// ── GET /call-agains ─────────────────────────────────────────────────────────

export interface CallAgainsQuery {
  agent: string | null;          // null = all · 'unassigned' · a user id
  source: "all" | "order" | "prediction";
  departments: AssignerDepartment[] | null;
  order: "oldest" | "newest";
  page: number;
  limit: number;
}

/** The query string of GET /call-agains (old params kept: page, limit ≤ 200,
 *  agent_id, source; new: order = oldest (default) | newest, departments). */
export function parseCallAgainsQuery(q: {
  page?: string | null; limit?: string | null; agent_id?: string | null; source?: string | null;
  order?: string | null; departments?: string | null;
}): Ok<{ query: CallAgainsQuery }> | Err {
  const page = Math.max(1, parseInt(q.page || "1", 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(q.limit || "50", 10) || 50));
  const rawAgent = (q.agent_id || "").trim();
  // Unknown agent values fall back to "all", as the old route did.
  const agent = rawAgent === "unassigned" ? "unassigned" : UUID_RE.test(rawAgent) ? rawAgent.toLowerCase() : null;
  const source = parseOrderParam(q.source, ["all", "order", "prediction"] as const, "all");
  const order = parseOrderParam(q.order, ["oldest", "newest"] as const, "oldest");
  const d = parseDepartmentsParam(q.departments);
  if (!d.ok) return d;
  return { ok: true, query: { agent, source, departments: d.departments, order, page, limit } };
}

/** The last 8 digits of a phone (the call_logs key of bulk_last_calls). */
export const phone8 = (p: string | null | undefined): string => String(p || "").replace(/\D/g, "").slice(-8);

export interface LastCall { last_call_at: string | null; outcome: string | null }

/**
 * One assigner_call_agains() item → the old GET /call-agains item + department.
 * A LEAD ORDER's last call is the real one from call_logs (bulk_last_calls) —
 * never orders.updated_at; with no call log it falls back to call_again_since
 * (the no-answer that opened the window). A member keeps its own last_call_*.
 */
export function shapeCallAgainItem(item: unknown, lastCall?: LastCall | null) {
  const i = isObj(item) ? item : {};
  const isOrder = i.source_kind === "order";
  const base = {
    source_kind: isOrder ? "order" : "prediction",
    list_id: String(i.list_id ?? ""),
    ...(isOrder ? { order_id: str(i.order_id) } : {}),
    customer_phone: String(i.customer_phone ?? ""),
    customer_name: str(i.customer_name),
    call_again_since: str(i.call_again_since),
    last_call_at: str(i.last_call_at),
    last_call_outcome: str(i.last_call_outcome),
    in_call_again_until: str(i.in_call_again_until),
    assigned_agent_id: str(i.assigned_agent_id),
    assigned_agent_name: str(i.assigned_agent_name),
    lifetime_value: i.lifetime_value == null ? null : num(i.lifetime_value),
    paid_count: i.paid_count == null ? null : num(i.paid_count),
    avg_package_price: i.avg_package_price == null ? null : num(i.avg_package_price),
    prediction_segment_lists: { name: String(i.list_name ?? ""), category: String(i.list_category ?? "") },
    department: str(i.department) ?? "unknown",
  };
  if (isOrder) {
    base.last_call_at = lastCall?.last_call_at ?? base.call_again_since;
    base.last_call_outcome = lastCall?.outcome ?? "no_answer";
  }
  return base;
}

// ── realtime ─────────────────────────────────────────────────────────────────

export const ASSIGNER_TOPIC = "assigner";
export const ASSIGNER_EVENT = "refresh";

/** The body of POST {SUPABASE_URL}/realtime/v1/api/broadcast — channel
 *  `assigner`, event `refresh`, payload {agent_id?} (the same mechanism as the
 *  TV board's `tv-leaderboard`). No agent_id = a change for several agents
 *  (or the pools): every open Assigner refetches the same way. */
export function assignerBroadcastBody(payload: { agent_id?: string | null } = {}) {
  const p: Record<string, unknown> = {};
  if (payload.agent_id) p.agent_id = payload.agent_id;
  return { messages: [{ topic: ASSIGNER_TOPIC, event: ASSIGNER_EVENT, payload: p }] };
}
