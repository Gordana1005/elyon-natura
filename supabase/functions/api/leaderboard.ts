// ============================================================================
// TV leaderboard — the pure half of GET /api/leaderboard (redesign 2026-09-28).
//
// Dependency-free on purpose (no Deno globals, no URL imports): vitest runs
// leaderboard.test.ts against this file in Node, and index.ts imports it.
//
// The SQL function public.leaderboard_day(p_day, p_mode) (migration
// 20260939000000) decides WHO is on a board and WHAT they did that Skopje day:
// team members of the board + guests who worked or sold its source + Settings
// extras, with work, sales, presence and last decision. This file turns that into the
// response the TV reads:
//   • every field the pre-redesign handler returned is still there (the TV
//     page of the previous deploy keeps working during the rollout); user_id
//     may now be null — an AlterCPA-only operator has no CRM login — so rows
//     also carry person_id and a stable `key`;
//   • the daily-game bonus PROJECTION, with the formulas unchanged. They are
//     not copied here: index.ts passes its own packageBonusRate and tierBonus
//     in, so there is exactly one definition of each (elyon-agent-commissions).
//     Only two things changed, both owner rules:
//       rule 1  which orders feed it — this board's SOURCE (sale_source), on
//               the sold clock, the ones still confirmed/shipped/delivered/paid
//               (returned and cancelled-after-sale reverse themselves, as before)
//       rule 5  managers are shown and never earn (as before: is_manager merges
//               sales_people.is_manager with the admin/manager roles), and the
//               TEAM-TARGET bonus goes only to the board team's own members
//               with at least one sale that day — not to guests, not to
//               zero-sale members. The per-package bonus still goes to every
//               non-manager who sold.
//   • the sort: sold (value or count) > worked > online.
// This is a projection shown on a wall. It is NOT payroll: calcAgentBonus /
// orderPackageBonus / agent_payout* are untouched and never read this.
// ============================================================================

export type LeaderboardMode = "prediction" | "pending";
export type PresenceState = "online" | "idle" | "break" | "offline" | "n/a";

/** One net sale as the RPC hands it over: price, quantity, order_items lines [price_per_unit, quantity]. */
export interface BonusOrder {
  p: number | string | null;
  q: number | string | null;
  i: Array<[number | string | null, number | string | null]> | null;
}

export interface LbPresence {
  state: PresenceState;
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

/** One row of leaderboard_day().rows. */
export interface LbRpcRow {
  person_id: string | null;
  user_id: string | null;
  name: string;
  team_key: string | null;
  team_name: string | null;
  team_mode: string | null;
  is_member: boolean;
  is_guest: boolean;
  is_extra: boolean;
  is_manager: boolean;
  worked: number;
  sale_decisions: number;
  cancelled: number;
  trashed: number;
  callbacks: number;
  conversion: number | string | null;
  confirmed: number;
  sold_value_eur: number | string;
  avg_order_value: number | string;
  net_confirmed: number;
  net_value_eur: number | string;
  packages: number;
  shipped: number;
  delivered: number;
  returned: number;
  lost: number;
  delivered_cash_mkd: number | string;
  live_credited: number;
  bonus_orders: BonusOrder[] | null;
  last_decision_at: string | null;
  presence: Partial<LbPresence> | null;
}

export interface LbRpcSummary {
  people: number;
  members: number;
  guests: number;
  extras: number;
  managers: number;
  online_now: number;
  idle: number;
  on_break: number;
  offline: number;
  no_login: number;
  was_online: number;
  zero_sale_people: number;
  worked: number;
  unmapped_decisions: number;
  sales: number;
  sold_value_eur: number | string;
  unattributed_sales: number;
  unattributed_value_eur: number | string;
  live_credited_sales: number;
}

export interface LbRpc {
  day: string;
  mode: LeaderboardMode;
  is_today: boolean;
  generated_at?: string;
  window?: { from: string; to_end: string };
  summary: Partial<LbRpcSummary> | null;
  rows: LbRpcRow[] | null;
}

export type BonusRules = Record<string, { tiers: any[]; is_active: boolean }>;

/** The two formulas, injected from index.ts so they exist exactly once. */
export interface BonusFormulas {
  packageBonusRate: (unitPrice: number) => number;
  tierBonus: (value: number, tiers: any[]) => number;
}

export interface LeaderboardAgent {
  // ── the pre-redesign contract (kept field for field) ──
  user_id: string | null;
  full_name: string;
  is_super: boolean;
  confirmed_count: number;
  packages: number;
  avg_order_value: number;
  revenue: number;
  target_pct: number;
  sold_rate: number;
  calls: number;
  bonus: number;
  bonus_breakdown: Record<string, number>;
  rank: number;
  // ── new ──
  key: string;
  person_id: string | null;
  team_key: string | null;
  team_name: string | null;
  is_member: boolean;
  is_guest: boolean;
  is_extra: boolean;
  is_manager: boolean;
  earns_team_target: boolean;
  worked: number;
  sales: number;
  sold_value_eur: number;
  sale_decisions: number;
  cancelled: number;
  trashed: number;
  callbacks: number;
  conversion_pct: number | null;
  shipped: number;
  delivered: number;
  returned: number;
  lost: number;
  delivered_cash_mkd: number;
  live_credited: number;
  last_decision_at: string | null;
  presence: LbPresence;
}

export interface LeaderboardSummary extends LbRpcSummary {
  team_target_earners: number;
}

export interface LeaderboardResponse {
  generated_at: string;
  mode: LeaderboardMode;
  day: string;
  today: string;
  is_today: boolean;
  target: number;
  team_revenue: number;
  team_target_pct: number;
  team_target_bonus: number;
  summary: LeaderboardSummary;
  agents: LeaderboardAgent[];
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const r2 = (n: number) => Math.round(n * 100) / 100;

/** leaderboard_bonus_rules rows → the rules map the formulas read. */
export function bonusRulesFromRows(rows: Array<{ metric: string; tiers: any; is_active: boolean }> | null): BonusRules {
  const rules: BonusRules = {};
  for (const r of rows || []) rules[r.metric] = { tiers: Array.isArray(r.tiers) ? r.tiers : [], is_active: !!r.is_active };
  return rules;
}

/**
 * The daily per-package bonus of a set of net sales — the pre-redesign
 * handler's reduce, verbatim: each order_items line earns rate(unit) × qty; an
 * order without lines falls back to price ÷ units. NOT paid-gated (this is the
 * daily game, not the commission).
 */
export function leaderboardPackageBonus(orders: BonusOrder[] | null, rate: (unitPrice: number) => number): number {
  let total = 0;
  for (const o of orders || []) {
    const its = o.i || [];
    total += its.length
      ? its.reduce((s, it) => s + rate(Number(it[0] || 0)) * Number(it[1] || 0), 0)
      : rate(Number(o.p || 0) / Math.max(1, Number(o.q || 0) || 1)) * (Number(o.q || 0) || 1);
  }
  return total;
}

export const PRESENCE_RANK: Record<PresenceState, number> = { online: 0, idle: 1, break: 2, offline: 3, "n/a": 4 };

function normPresence(p: Partial<LbPresence> | null | undefined, hasLogin: boolean): LbPresence {
  const state = (p?.state && p.state in PRESENCE_RANK ? p.state : hasLogin ? "offline" : "n/a") as PresenceState;
  return {
    state,
    online_min: num(p?.online_min),
    active_min: num(p?.active_min),
    idle_min: num(p?.idle_min),
    break_min: num(p?.break_min),
    first_seen: p?.first_seen ?? null,
    last_seen: p?.last_seen ?? null,
    first_active: p?.first_active ?? null,
    last_active: p?.last_active ?? null,
    idle_alerts: num(p?.idle_alerts),
    idle_streak_min: p?.idle_streak_min == null ? null : num(p.idle_streak_min),
    first_login: p?.first_login ?? null,
  };
}

/** Sold (value or count) > worked > online > name. */
export function compareLeaderboardRows(mode: LeaderboardMode) {
  return (x: LeaderboardAgent, y: LeaderboardAgent): number => {
    const sx = x.sales > 0 || x.confirmed_count > 0 ? 1 : 0;
    const sy = y.sales > 0 || y.confirmed_count > 0 ? 1 : 0;
    if (sx !== sy) return sy - sx;
    const bySold = mode === "prediction"
      ? (y.revenue - x.revenue) || (y.confirmed_count - x.confirmed_count) || (y.sold_value_eur - x.sold_value_eur)
      : (y.confirmed_count - x.confirmed_count) || (y.revenue - x.revenue) || (y.sales - x.sales);
    return bySold
      || (y.worked - x.worked)
      || (PRESENCE_RANK[x.presence.state] - PRESENCE_RANK[y.presence.state])
      || (y.presence.active_min - x.presence.active_min)
      || (y.presence.online_min - x.presence.online_min)
      || x.full_name.localeCompare(y.full_name);
  };
}

export function buildLeaderboardResponse(input: {
  rpc: LbRpc;
  mode: LeaderboardMode;
  today: string;
  rules: BonusRules;
  /** call_logs of the day for this board's context, per user_id. */
  callsByUser: Record<string, number>;
  formulas: BonusFormulas;
  generatedAt?: string;
}): LeaderboardResponse {
  const { rpc, mode, today, rules, callsByUser, formulas } = input;
  const tiersFor = (m: string) => (rules[m]?.is_active ? rules[m].tiers : []);
  const targetTiers = tiersFor("revenue_target");
  const topTarget = targetTiers.reduce((mx: number, t: any) => Math.max(mx, Number(t?.min) || 0), 0);

  const base = (rpc.rows || []).map((r) => {
    const confirmed = num(r.net_confirmed);                 // net of returns / cancels — what the bonus reads
    const revenueRaw = num(r.net_value_eur);
    const calls = r.user_id ? num(callsByUser[r.user_id]) : 0;
    return {
      r,
      isSuper: !!r.is_manager,
      confirmed,
      revenueRaw,
      revenue: r2(revenueRaw),
      avg: confirmed > 0 ? r2(revenueRaw / confirmed) : 0,
      calls,
      soldRate: calls > 0 ? Math.round((confirmed / calls) * 1000) / 10 : 0,
      pkg: r2(leaderboardPackageBonus(r.bonus_orders, formulas.packageBonusRate)),
    };
  });

  // PREDICTION targets are a TEAM total per day. The board's revenue counts
  // every non-manager on it (a guest's prediction sale is prediction money —
  // source wins); the unlocked tier is paid to the team's own members who sold.
  let teamRevenueRaw = 0;
  for (const b of base) if (!b.isSuper) teamRevenueRaw += b.revenueRaw;
  const teamRevenue = r2(teamRevenueRaw);
  const teamTargetBonus = mode === "prediction" ? formulas.tierBonus(teamRevenue, targetTiers) : 0;
  const teamTargetPct = topTarget > 0 ? Math.round((teamRevenue / topTarget) * 1000) / 10 : 0;

  const agents: LeaderboardAgent[] = base.map((b) => {
    const { r, isSuper, confirmed, pkg } = b;
    const earnsTarget = mode === "prediction" && !isSuper && !!r.is_member && confirmed >= 1;
    let total = 0;
    let breakdown: Record<string, number>;
    if (mode === "prediction") {
      const target = earnsTarget ? teamTargetBonus : 0;
      total = isSuper ? 0 : r2(pkg + target);
      breakdown = isSuper ? { package: 0, target: 0 } : { package: pkg, target };
    } else {
      // Warm pendings: per-package + confirmed milestones + avg (10+ orders gate).
      const volume = formulas.tierBonus(confirmed, tiersFor("confirmed_count"));
      const avgBonus = confirmed >= 10 ? formulas.tierBonus(b.avg, tiersFor("avg_order_value")) : 0;
      total = isSuper ? 0 : r2(pkg + volume + avgBonus);
      breakdown = isSuper ? { package: 0, volume: 0, avg: 0 } : { package: pkg, volume, avg: avgBonus };
    }
    const conv = r.conversion == null ? null : Number(r.conversion);
    return {
      user_id: r.user_id ?? null,
      full_name: r.name || "Agent",
      is_super: isSuper,
      confirmed_count: confirmed,
      packages: num(r.packages),
      avg_order_value: b.avg,
      revenue: b.revenue,
      target_pct: teamTargetPct,
      sold_rate: b.soldRate,
      calls: b.calls,
      bonus: total,
      bonus_breakdown: breakdown,
      rank: 0,
      key: r.person_id ? r.person_id : `user:${r.user_id ?? r.name}`,
      person_id: r.person_id ?? null,
      team_key: r.team_key ?? null,
      team_name: r.team_name ?? null,
      is_member: !!r.is_member,
      is_guest: !!r.is_guest,
      is_extra: !!r.is_extra,
      is_manager: !!r.is_manager,
      earns_team_target: earnsTarget,
      worked: num(r.worked),
      sales: num(r.confirmed),
      sold_value_eur: r2(num(r.sold_value_eur)),
      sale_decisions: num(r.sale_decisions),
      cancelled: num(r.cancelled),
      trashed: num(r.trashed),
      callbacks: num(r.callbacks),
      conversion_pct: conv == null || !Number.isFinite(conv) ? null : Math.round(conv * 1000) / 10,
      shipped: num(r.shipped),
      delivered: num(r.delivered),
      returned: num(r.returned),
      lost: num(r.lost),
      delivered_cash_mkd: Math.round(num(r.delivered_cash_mkd)),
      live_credited: num(r.live_credited),
      last_decision_at: r.last_decision_at ?? null,
      presence: normPresence(r.presence, !!r.user_id),
    };
  });

  agents.sort(compareLeaderboardRows(mode));
  agents.forEach((a, i) => { a.rank = i + 1; });

  const s = rpc.summary || {};
  const summary: LeaderboardSummary = {
    people: num(s.people ?? agents.length),
    members: num(s.members),
    guests: num(s.guests),
    extras: num(s.extras),
    managers: num(s.managers),
    online_now: num(s.online_now),
    idle: num(s.idle),
    on_break: num(s.on_break),
    offline: num(s.offline),
    no_login: num(s.no_login),
    was_online: num(s.was_online),
    zero_sale_people: num(s.zero_sale_people),
    worked: num(s.worked),
    unmapped_decisions: num(s.unmapped_decisions),
    sales: num(s.sales),
    sold_value_eur: r2(num(s.sold_value_eur)),
    unattributed_sales: num(s.unattributed_sales),
    unattributed_value_eur: r2(num(s.unattributed_value_eur)),
    live_credited_sales: num(s.live_credited_sales),
    team_target_earners: agents.filter((a) => a.earns_team_target).length,
  };

  return {
    generated_at: input.generatedAt ?? new Date().toISOString(),
    mode,
    day: String(rpc.day),
    today,
    is_today: !!rpc.is_today,
    target: topTarget,
    team_revenue: teamRevenue,
    team_target_pct: teamTargetPct,
    team_target_bonus: teamTargetBonus,
    summary,
    agents,
  };
}
