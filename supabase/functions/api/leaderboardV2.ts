// ============================================================================
// TV leaderboard v2 — the pure half of GET /api/leaderboard?v=2 (owner,
// 28–29.09.2026: "accurate for each agent — how much she made that day, in
// which department, from her own orders").
//
// Dependency-free on purpose (no Deno globals, no URL imports): vitest runs
// leaderboardV2.test.ts against this file in Node, and index.ts imports it.
//
// The SQL function public.leaderboard_day_v2(p_day, p_department, p_team)
// (migration 20260942001200) decides everything: who is on the board, each
// person's sales / bookings / cancels / work per department, the rank, the
// whole day's tie-out by department. This file only
//   • validates the query (?department= one of the six keys, ?team= a team key
//     or 'none') before the RPC runs,
//   • normalises the payload (numbers, presence defaults) and stamps `today`,
//   • strips every money figure for a caller without money access — a
//     WHITELIST of non-money keys, so a money field added to the RPC later is
//     dropped by default and has to be allowed here on purpose to leak.
// The TV token route keeps the leaderboard's existing access rule: a valid
// token receives the board with its денари (the wall screen has shown values
// since 2026-07); see index.ts.
// No bonus here: payouts / bonus / commission math are deferred by the owner.
// ============================================================================

import { parseTeamFilter } from "./teamLines.ts";

/** The six departments in the owner's order (migrations 20260942000500 / 20260942001000). */
export const LEADERBOARD_DEPARTMENTS = [
  "altercpa", "elyon_crm", "teleshop_out", "teleshop_other", "social", "web",
] as const;
export type LeaderboardDepartment = typeof LEADERBOARD_DEPARTMENTS[number];

export type PresenceStateV2 = "online" | "idle" | "break" | "offline" | "n/a";

/** ?department= / ?team= → the RPC's arguments, or a 400. ?team= is a team key, 'team:lane'
 *  (a business line's lane, 20260943000950), 'none' or a legacy alias (altercpa_leads /
 *  crm_prediction — old TV links); teamLines.parseTeamFilter owns the grammar. */
export function parseLeaderboardV2Query(q: { department?: string | null; team?: string | null }):
  { ok: true; department: LeaderboardDepartment | null; team: string | null } | { ok: false; error: string } {
  const dept = (q.department ?? "").trim();
  const team = (q.team ?? "").trim();
  if (dept && !(LEADERBOARD_DEPARTMENTS as readonly string[]).includes(dept)) {
    return { ok: false, error: "invalid department" };
  }
  const tf = parseTeamFilter(team);
  if (!tf.ok) return { ok: false, error: "invalid team" };
  return { ok: true, department: (dept || null) as LeaderboardDepartment | null, team: tf.value?.raw ?? null };
}

export interface PresenceV2 {
  state: PresenceStateV2;
  online_min: number;
  active_min: number;
  idle_min: number;
  break_min: number;
  first_seen: string | null;
  last_seen: string | null;
  first_active: string | null;
  last_active: string | null;
  idle_alerts: number;
  idle_streak_min: number | null;
  first_login: string | null;
}

/** One department of one person (or of the filter). Money keys end in _mkd. */
export interface DeptCellV2 {
  sales: number;
  value_mkd?: number;
  booked: number;
  booked_value_mkd?: number;
  booked_twin: number;
  booked_twin_value_mkd?: number;
  cancelled_after_sale: number;
  cancelled_value_mkd?: number;
  returned: number;
  live_credited: number;
  worked: number;
  sale_decisions: number;
}

export interface BoardRowV2 {
  person_id: string;
  user_id: string | null;
  name: string;
  team_key: string | null;
  team_name: string | null;
  /** The lane inside the business line (in | out | social); null for management / legacy / no team. */
  team_lane: string | null;
  /** sales_teams.kind: line | management | legacy (null = no team). */
  team_kind: string | null;
  is_member: boolean;
  is_manager: boolean;
  /** 1… among non-managers with a total > 0 (equal numbers share a place); null otherwise. */
  rank: number | null;
  sales: number;
  value_mkd?: number;
  booked: number;
  booked_value_mkd?: number;
  total_count: number;
  total_value_mkd?: number;
  cancelled_after_sale: number;
  cancelled_value_mkd?: number;
  returned: number;
  live_credited: number;
  booked_twin: number;
  booked_twin_value_mkd?: number;
  worked: number;
  sale_decisions: number;
  cancelled: number;
  trashed: number;
  callbacks: number;
  /** sale decisions ÷ worked, 0–1 (4 decimals); null when nothing was worked. */
  conversion: number | null;
  last_decision_at: string | null;
  departments: Partial<Record<LeaderboardDepartment, DeptCellV2>>;
  presence: PresenceV2;
}

export interface LeaderboardV2Response {
  version: 2;
  day: string;
  today: string;
  is_today: boolean;
  generated_at: string;
  /** false = every *_mkd key was stripped. */
  money: boolean;
  window: { from: string; to_end: string } | null;
  filter: { department: LeaderboardDepartment | null; team: string | null };
  departments: LeaderboardDepartment[];
  teams: BoardTeamV2[];
  summary: Record<string, number>;
  day_totals: Record<string, unknown>;
  rows: BoardRowV2[];
  /** The web shop's day (leaderboard_web_live, 20260942001940) — only with &department=web. */
  web_live?: WebLiveV2 | null;
}

/** A team on the board's filter bar (sales_teams.sort_order order); a line carries its lanes
 *  (lane.key = 'team:lane' is itself a filter value). */
export interface BoardTeamV2 {
  key: string;
  name: string | null;
  people: number;
  kind: string | null;
  sort_order: number | null;
  lanes: Array<{ lane: string; key: string; people: number }>;
}

/** The TV board's web view: the web shop has no agents, so the board shows the shop itself. */
export interface WebLiveV2 {
  day: string;
  /** = the cohort's web part of the day (the Overview's number): the shop's orders — "чека потврда"
   *  included (20260942001965) — and the day's MEX-only web parcels (20260942001967). */
  orders: number;
  value_mkd: number;
  all_orders: number;
  card: number;
  cod: number;
  /** Counted orders still waiting for the shop's confirmation ("чекаат потврда"). */
  awaiting: number;
  awaiting_value_mkd: number;
  /** Counted MEX web parcels with no order in the shop mirror (M… / NTMK…). */
  mex_only: number;
  mex_only_value_mkd: number;
  by_outcome: Array<{ key: string; count: number; value_mkd: number }>;
  latest: Array<{
    /** 'web' = a shop order · 'mex' = a MEX web parcel with no shop order (tracking id, city, COD; no product). */
    kind: "web" | "mex";
    at: string | null; number: string | null; city: string | null; total_mkd: number; outcome: string;
    payment: "card" | "cod"; counted: boolean; source: string | null; item: string | null; items: number;
  }>;
  last_order_at: string | null;
  synced_at: string | null;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const numOrNull = (v: unknown): number | null => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const obj = (v: unknown): Record<string, unknown> =>
  (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});

const PRESENCE_STATES = new Set<PresenceStateV2>(["online", "idle", "break", "offline", "n/a"]);

function normPresence(p: unknown, hasLogin: boolean): PresenceV2 {
  const x = obj(p);
  const st = x.state as PresenceStateV2;
  return {
    state: PRESENCE_STATES.has(st) ? st : hasLogin ? "offline" : "n/a",
    online_min: num(x.online_min),
    active_min: num(x.active_min),
    idle_min: num(x.idle_min),
    break_min: num(x.break_min),
    first_seen: str(x.first_seen),
    last_seen: str(x.last_seen),
    first_active: str(x.first_active),
    last_active: str(x.last_active),
    idle_alerts: num(x.idle_alerts),
    idle_streak_min: numOrNull(x.idle_streak_min),
    first_login: str(x.first_login),
  };
}

function normCell(v: unknown): DeptCellV2 {
  const x = obj(v);
  return {
    sales: num(x.sales),
    value_mkd: num(x.value_mkd),
    booked: num(x.booked),
    booked_value_mkd: num(x.booked_value_mkd),
    booked_twin: num(x.booked_twin),
    booked_twin_value_mkd: num(x.booked_twin_value_mkd),
    cancelled_after_sale: num(x.cancelled_after_sale),
    cancelled_value_mkd: num(x.cancelled_value_mkd),
    returned: num(x.returned),
    live_credited: num(x.live_credited),
    worked: num(x.worked),
    sale_decisions: num(x.sale_decisions),
  };
}

function normRow(v: unknown): BoardRowV2 {
  const r = obj(v);
  const departments: Partial<Record<LeaderboardDepartment, DeptCellV2>> = {};
  for (const [k, cell] of Object.entries(obj(r.departments))) {
    if ((LEADERBOARD_DEPARTMENTS as readonly string[]).includes(k)) departments[k as LeaderboardDepartment] = normCell(cell);
  }
  const userId = str(r.user_id);
  return {
    person_id: String(r.person_id ?? ""),
    user_id: userId,
    name: str(r.name) ?? "Agent",
    team_key: str(r.team_key),
    team_name: str(r.team_name),
    team_lane: str(r.team_lane),
    team_kind: str(r.team_kind),
    is_member: !!r.is_member,
    is_manager: !!r.is_manager,
    rank: r.rank == null ? null : num(r.rank),
    sales: num(r.sales),
    value_mkd: num(r.value_mkd),
    booked: num(r.booked),
    booked_value_mkd: num(r.booked_value_mkd),
    total_count: num(r.total_count),
    total_value_mkd: num(r.total_value_mkd),
    cancelled_after_sale: num(r.cancelled_after_sale),
    cancelled_value_mkd: num(r.cancelled_value_mkd),
    returned: num(r.returned),
    live_credited: num(r.live_credited),
    booked_twin: num(r.booked_twin),
    booked_twin_value_mkd: num(r.booked_twin_value_mkd),
    worked: num(r.worked),
    sale_decisions: num(r.sale_decisions),
    cancelled: num(r.cancelled),
    trashed: num(r.trashed),
    callbacks: num(r.callbacks),
    conversion: numOrNull(r.conversion),
    last_decision_at: str(r.last_decision_at),
    departments,
    presence: normPresence(r.presence, !!userId),
  };
}

/** leaderboard_web_live's jsonb, typed and cleaned (no name / phone ever leaves it). */
export function normWebLive(v: unknown): WebLiveV2 {
  const w = obj(v);
  return {
    day: String(w.day ?? ""),
    orders: num(w.orders),
    value_mkd: num(w.value_mkd),
    all_orders: num(w.all_orders),
    card: num(w.card),
    cod: num(w.cod),
    awaiting: num(w.awaiting),
    awaiting_value_mkd: num(w.awaiting_value_mkd),
    mex_only: num(w.mex_only),
    mex_only_value_mkd: num(w.mex_only_value_mkd),
    by_outcome: Array.isArray(w.by_outcome)
      ? (w.by_outcome as unknown[]).map((o) => { const x = obj(o); return { key: String(x.key ?? ""), count: num(x.count), value_mkd: num(x.value_mkd) }; })
      : [],
    latest: Array.isArray(w.latest)
      ? (w.latest as unknown[]).map((o) => {
        const x = obj(o);
        return {
          kind: x.kind === "mex" ? "mex" as const : "web" as const,
          at: str(x.at), number: str(x.number), city: str(x.city), total_mkd: num(x.total_mkd),
          outcome: String(x.outcome ?? ""), payment: x.payment === "card" ? "card" as const : "cod" as const,
          counted: x.counted === true, source: str(x.source), item: str(x.item), items: num(x.items),
        };
      })
      : [],
    last_order_at: str(w.last_order_at),
    synced_at: str(w.synced_at),
  };
}

function numbersOf(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, x] of Object.entries(obj(v))) out[k] = num(x);
  return out;
}

// ── the money strip (a whitelist) ────────────────────────────────────────────

/** Every key a caller without money access may receive. Anything else — every
 *  *_mkd figure, and any key the RPC grows later — is dropped. Department keys
 *  are listed because `departments` / `by_department` are maps keyed by them. */
export const LEADERBOARD_V2_NON_MONEY_KEYS: ReadonlySet<string> = new Set([
  // envelope
  "version", "day", "today", "is_today", "generated_at", "money", "window", "from", "to_end",
  "filter", "department", "team", "departments", "teams", "key", "name", "people",
  "summary", "day_totals", "rows",
  // summary / day_totals counts
  "members", "managers", "ranked", "online_now", "idle", "on_break", "offline", "no_login", "was_online",
  "zero_sale_people", "worked", "sale_decisions", "sales", "booked", "total_count", "cancelled_after_sale",
  "returned", "live_credited", "booked_twin", "no_seller", "booked_no_person", "by_department", "credited",
  "booked_twin_by_role", "web", "mex_only", "unmapped_decisions", "reasons", "reason", "count",
  "no_department", "orders", "bookings", "work", "checks", "bookings_filter_drift",
  // rows
  "person_id", "user_id", "team_key", "team_name", "is_member", "is_manager", "rank",
  // teams = business lines (20260943000950): the lane / kind of a row, a team's order and lanes
  "team_lane", "team_kind", "sort_order", "lanes", "lane",
  "cancelled", "trashed", "callbacks", "conversion", "last_decision_at", "presence",
  "state", "online_min", "active_min", "idle_min", "break_min", "first_seen", "last_seen",
  "first_active", "last_active", "idle_alerts", "idle_streak_min", "first_login",
  // the web view (web_live) — its counts; value_mkd / total_mkd go with the money
  "web_live", "all_orders", "card", "cod", "by_outcome", "latest", "at", "number", "city", "outcome",
  "payment", "counted", "source", "item", "items", "last_order_at", "synced_at", "awaiting", "kind",
  // the six departments (map keys)
  ...LEADERBOARD_DEPARTMENTS,
]);

const MONEY_KEY_RE = /_mkd$|_eur$/;

function stripValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripValue);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (!LEADERBOARD_V2_NON_MONEY_KEYS.has(k) || MONEY_KEY_RE.test(k)) continue;
      out[k] = stripValue(x);
    }
    return out;
  }
  return v;
}

/** The board without a single money figure; `money` is set to false. */
export function stripLeaderboardV2Money(payload: LeaderboardV2Response): LeaderboardV2Response {
  const out = stripValue(payload) as LeaderboardV2Response;
  out.money = false;
  return out;
}

/** The response of GET /api/leaderboard?v=2. */
export function buildLeaderboardV2Response(input: {
  rpc: unknown;
  today: string;
  /** false → every *_mkd key stripped (whitelist). */
  money: boolean;
  generatedAt?: string;
  /** leaderboard_web_live's answer (the web view); undefined = not asked for. */
  webLive?: unknown;
}): LeaderboardV2Response {
  const rpc = obj(input.rpc);
  const filter = obj(rpc.filter);
  const win = obj(rpc.window);
  const deptList = Array.isArray(rpc.departments)
    ? (rpc.departments as unknown[]).filter((d): d is LeaderboardDepartment =>
      (LEADERBOARD_DEPARTMENTS as readonly string[]).includes(String(d)))
    : [...LEADERBOARD_DEPARTMENTS];
  const teams: BoardTeamV2[] = Array.isArray(rpc.teams)
    ? (rpc.teams as unknown[]).map((t) => {
      const x = obj(t);
      const key = String(x.key ?? "none");
      return {
        key, name: str(x.name), people: num(x.people), kind: str(x.kind), sort_order: numOrNull(x.sort_order),
        lanes: Array.isArray(x.lanes)
          ? (x.lanes as unknown[]).map((l) => {
            const y = obj(l);
            const lane = String(y.lane ?? "");
            return { lane, key: str(y.key) ?? `${key}:${lane}`, people: num(y.people) };
          }).filter((l) => l.lane)
          : [],
      };
    })
    : [];
  const body: LeaderboardV2Response = {
    version: 2,
    day: String(rpc.day ?? input.today),
    today: input.today,
    is_today: !!rpc.is_today,
    generated_at: input.generatedAt ?? str(rpc.generated_at) ?? new Date().toISOString(),
    money: input.money,
    window: str(win.from) ? { from: String(win.from), to_end: String(win.to_end ?? "") } : null,
    filter: {
      department: (LEADERBOARD_DEPARTMENTS as readonly string[]).includes(String(filter.department))
        ? filter.department as LeaderboardDepartment : null,
      team: str(filter.team),
    },
    departments: deptList.length ? deptList : [...LEADERBOARD_DEPARTMENTS],
    teams,
    summary: numbersOf(rpc.summary),
    day_totals: obj(rpc.day_totals),
    rows: Array.isArray(rpc.rows) ? (rpc.rows as unknown[]).map(normRow) : [],
  };
  if (input.webLive !== undefined) body.web_live = input.webLive ? normWebLive(input.webLive) : null;
  return input.money ? body : stripLeaderboardV2Money(body);
}
