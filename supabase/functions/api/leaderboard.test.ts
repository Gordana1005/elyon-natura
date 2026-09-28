import { describe, expect, it } from "vitest";
import {
  bonusRulesFromRows, buildLeaderboardResponse, leaderboardPackageBonus,
  type BonusFormulas, type LbRpc, type LbRpcRow,
} from "./leaderboard.ts";

// Stand-ins for the edge function's packageBonusRate / tierBonus
// (supabase/functions/api/index.ts). The real ones are injected at runtime —
// leaderboard.ts holds no copy — so these must mirror them exactly.
const formulas: BonusFormulas = {
  packageBonusRate: (u: number) => (u >= 35 ? 3 : u > 25 ? 2 : 1),
  tierBonus: (value: number, tiers: any[]) => {
    if (!Array.isArray(tiers)) return 0;
    let bonus = 0; let bestMin = -Infinity;
    for (const t of tiers) {
      const min = Number(t?.min ?? 0);
      if (value >= min && min >= bestMin) { bestMin = min; bonus = Number(t?.bonus ?? 0); }
    }
    return bonus;
  },
};

// leaderboard_bonus_rules as they stand in the MK database (2026-09-28).
const rules = bonusRulesFromRows([
  { metric: "avg_order_value", is_active: true, tiers: [{ min: 0, bonus: 0 }, { min: 50, bonus: 5 }, { min: 75, bonus: 10 }, { min: 100, bonus: 20 }] },
  { metric: "confirmed_count", is_active: true, tiers: [{ min: 0, bonus: 0 }, { min: 10, bonus: 5 }, { min: 20, bonus: 10 }, { min: 30, bonus: 20 }] },
  { metric: "conversion_rate", is_active: false, tiers: [{ min: 0, bonus: 0 }] },
  { metric: "revenue_target", is_active: true, tiers: [{ min: 0, bonus: 0 }, { min: 1500, bonus: 10 }, { min: 2500, bonus: 20 }, { min: 4000, bonus: 40 }] },
]);

const presence = (state: string, extra: Record<string, unknown> = {}) => ({
  state, online_min: 0, active_min: 0, idle_min: 0, break_min: 0, first_seen: null, last_seen: null,
  first_active: null, last_active: null, idle_alerts: 0, idle_streak_min: null, first_login: null, ...extra,
}) as any;

// Shaped like leaderboard_day() rows on live data (22.09 / 27.09).
const row = (over: Partial<LbRpcRow>): LbRpcRow => ({
  person_id: "p-x", user_id: "u-x", name: "X", team_key: "crm_prediction", team_name: "Prediction — ElyonCRM",
  team_mode: "prediction", is_member: true, is_guest: false, is_extra: false, is_manager: false,
  worked: 0, sale_decisions: 0, cancelled: 0, trashed: 0, callbacks: 0, conversion: null,
  confirmed: 0, sold_value_eur: 0, avg_order_value: 0, net_confirmed: 0, net_value_eur: 0, packages: 0,
  shipped: 0, delivered: 0, returned: 0, lost: 0, delivered_cash_mkd: 0, live_credited: 0,
  bonus_orders: [], last_decision_at: null, presence: presence("offline"),
  ...over,
});

// Ruzhica, 22.09: 5 sales / €235.77 / 24 packages (a 0 € gift line in two of them).
const ruzhica = row({
  person_id: "p-ruz", user_id: "u-ruz", name: "Ruzhica Parizovska", worked: 52, sale_decisions: 5, cancelled: 41, trashed: 6,
  conversion: 0.0962, confirmed: 5, sold_value_eur: 235.77, avg_order_value: 47.15, net_confirmed: 5, net_value_eur: 235.77, packages: 24,
  delivered: 1, delivered_cash_mkd: 3000, last_decision_at: "2026-09-22T17:41:09.962Z",
  bonus_orders: [
    { i: [[0, 1], [10.840000000000002, 3]], p: 32.52, q: 4 },
    { i: [[12.195, 2], [12.195, 2]], p: 48.78, q: 4 },
    { i: [[0, 1], [10.840000000000002, 3]], p: 32.52, q: 4 },
    { i: [[10.452857142857143, 7], [0, 1]], p: 73.17, q: 8 },
    { i: [[12.195, 4]], p: 48.78, q: 4 },
  ],
  presence: presence("online", { online_min: 312, active_min: 280, idle_min: 20, break_min: 12, first_login: "2026-09-22T06:58:00Z" }),
});
const big = row({
  person_id: "p-big", user_id: "u-big", name: "Big Seller", worked: 30, sale_decisions: 30, confirmed: 31, net_confirmed: 30,
  sold_value_eur: 1500, net_value_eur: 1450, returned: 1, packages: 40,
  bonus_orders: [{ p: 1450, q: 40, i: [] }],
});
const zero = row({ person_id: "p-zero", user_id: "u-zero", name: "Katerina Bakardzieva", worked: 15, cancelled: 15, presence: presence("idle", { online_min: 90, idle_min: 50, idle_streak_min: 34, idle_alerts: 1 }) });
const nobody = row({ person_id: "p-none", user_id: "u-none", name: "Zhaklina Bogatinova" });
const guest = row({
  person_id: "p-elena", user_id: "u-elena", name: "Elena Mladenovska", team_key: "altercpa_leads", team_name: "Pending — AlterCPA leads",
  team_mode: "pending", is_member: false, is_guest: true, worked: 3, sale_decisions: 1, confirmed: 1, net_confirmed: 1,
  sold_value_eur: 48.78, net_value_eur: 48.78, packages: 3, bonus_orders: [{ p: 48.78, q: 3, i: [[16.26, 3]] }],
});
const boss = row({
  person_id: "p-dragana", user_id: "u-dragana", name: "Dragana", team_key: "management", team_name: "Management", team_mode: null,
  is_member: false, is_guest: true, is_manager: true, worked: 29, sale_decisions: 21, confirmed: 21, net_confirmed: 21,
  sold_value_eur: 533.38, net_value_eur: 533.38, packages: 23, bonus_orders: [{ p: 533.38, q: 23, i: [[40, 23]] }],
});

const rpcOf = (mode: "prediction" | "pending", rows: LbRpcRow[]): LbRpc => ({
  day: "2026-09-22", mode, is_today: true, generated_at: "2026-09-22T18:00:00Z",
  summary: { people: rows.length, online_now: 2, idle: 1, on_break: 0, offline: rows.length - 2, sales: 50 },
  rows,
});

const build = (mode: "prediction" | "pending", rows: LbRpcRow[], callsByUser: Record<string, number> = {}) =>
  buildLeaderboardResponse({ rpc: rpcOf(mode, rows), mode, today: "2026-09-22", rules, callsByUser, formulas, generatedAt: "2026-09-22T18:00:00Z" });

describe("leaderboardPackageBonus — the old handler's reduce, verbatim", () => {
  it("lines earn rate(unit) × qty, a 0 € gift line earns the lowest tier", () => {
    // 1×rate(0)=1 + 3×rate(10.84)=3 → 4, twice; 4×1; 7×1 + 1×1 = 8; 4×1 → 4+4+4+8+4
    expect(leaderboardPackageBonus(ruzhica.bonus_orders, formulas.packageBonusRate)).toBe(24);
  });
  it("an order without lines falls back to price ÷ units", () => {
    expect(leaderboardPackageBonus([{ p: 105, q: 3, i: [] }], formulas.packageBonusRate)).toBe(9);   // 35 → 3 × 3
    expect(leaderboardPackageBonus([{ p: 30, q: 0, i: null }], formulas.packageBonusRate)).toBe(2);  // qty 0 reads as 1
    expect(leaderboardPackageBonus(null, formulas.packageBonusRate)).toBe(0);
  });
});

describe("buildLeaderboardResponse — prediction", () => {
  const res = build("prediction", [nobody, zero, guest, boss, ruzhica, big], { "u-ruz": 40 });
  const by = Object.fromEntries(res.agents.map((a) => [a.full_name, a]));

  it("keeps every pre-redesign field", () => {
    for (const k of ["user_id", "full_name", "is_super", "confirmed_count", "packages", "avg_order_value", "revenue",
      "target_pct", "sold_rate", "calls", "bonus", "bonus_breakdown", "rank"]) {
      expect(by["Ruzhica Parizovska"]).toHaveProperty(k);
    }
    for (const k of ["generated_at", "mode", "day", "today", "is_today", "target", "team_revenue", "team_target_pct", "team_target_bonus", "agents"]) {
      expect(res).toHaveProperty(k);
    }
    expect(by["Ruzhica Parizovska"].sold_rate).toBe(12.5);
    expect(by["Ruzhica Parizovska"].calls).toBe(40);
  });

  it("team revenue = every non-manager on the board (guests too); manager excluded", () => {
    expect(res.team_revenue).toBe(r2(235.77 + 1450 + 48.78));
    expect(res.team_target_bonus).toBe(10);                    // 1734.55 ≥ 1500
    expect(res.target).toBe(4000);
    expect(res.team_target_pct).toBe(Math.round((1734.55 / 4000) * 1000) / 10);
  });

  it("team target goes only to the team's own members with ≥ 1 sale", () => {
    expect(by["Ruzhica Parizovska"].bonus_breakdown).toEqual({ package: 24, target: 10 });
    expect(by["Ruzhica Parizovska"].bonus).toBe(34);
    expect(by["Ruzhica Parizovska"].earns_team_target).toBe(true);
    // guest: per-package yes, team target no
    expect(by["Elena Mladenovska"].bonus_breakdown).toEqual({ package: 3, target: 0 });
    expect(by["Elena Mladenovska"].earns_team_target).toBe(false);
    expect(res.summary.team_target_earners).toBe(2);
  });

  it("zero-sale members are shown with bonus 0 and no team target", () => {
    for (const n of ["Katerina Bakardzieva", "Zhaklina Bogatinova"]) {
      expect(by[n]).toBeDefined();
      expect(by[n].bonus).toBe(0);
      expect(by[n].earns_team_target).toBe(false);
      expect(by[n].bonus_breakdown).toEqual({ package: 0, target: 0 });
    }
  });

  it("a manager is shown and earns nothing", () => {
    expect(by.Dragana.is_super).toBe(true);
    expect(by.Dragana.bonus).toBe(0);
    expect(by.Dragana.bonus_breakdown).toEqual({ package: 0, target: 0 });
    expect(by.Dragana.confirmed_count).toBe(21);
  });

  it("confirmed_count / revenue are net of returns; sales / sold_value_eur are gross", () => {
    expect(by["Big Seller"].confirmed_count).toBe(30);
    expect(by["Big Seller"].revenue).toBe(1450);
    expect(by["Big Seller"].sales).toBe(31);
    expect(by["Big Seller"].sold_value_eur).toBe(1500);
    expect(by["Big Seller"].returned).toBe(1);
    expect(by["Big Seller"].avg_order_value).toBe(r2(1450 / 30));
  });

  it("sorts sold (value) > worked > online, and ranks everyone", () => {
    expect(res.agents.map((a) => a.full_name)).toEqual([
      "Big Seller", "Dragana", "Ruzhica Parizovska", "Elena Mladenovska",
      "Katerina Bakardzieva", // worked 15
      "Zhaklina Bogatinova",  // worked 0
    ]);
    expect(res.agents.map((a) => a.rank)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("presence and conversion come through; rows are keyed by person", () => {
    expect(by["Katerina Bakardzieva"].presence.state).toBe("idle");
    expect(by["Katerina Bakardzieva"].presence.idle_streak_min).toBe(34);
    expect(by["Ruzhica Parizovska"].presence.online_min).toBe(312);
    expect(by["Ruzhica Parizovska"].conversion_pct).toBe(9.6);
    expect(by["Ruzhica Parizovska"].key).toBe("p-ruz");
    expect(by["Katerina Bakardzieva"].conversion_pct).toBeNull();
  });
});

describe("buildLeaderboardResponse — pending", () => {
  const altercpaOnly = row({
    person_id: "p-4531", user_id: null, name: "AlterCPA #4531 (unnamed)", team_key: "altercpa_leads", team_mode: "pending",
    worked: 12, sale_decisions: 4, cancelled: 8, confirmed: 4, net_confirmed: 4, sold_value_eur: 140, net_value_eur: 140, packages: 4,
    bonus_orders: [{ p: 35, q: 1, i: [[35, 1]] }, { p: 35, q: 1, i: [[35, 1]] }, { p: 35, q: 1, i: [[35, 1]] }, { p: 35, q: 1, i: [[35, 1]] }],
    last_decision_at: "2026-09-22T15:02:00Z", presence: { state: "n/a" } as any,
  });
  const sanela = row({
    person_id: "p-san", user_id: "u-san", name: "Sanela Dzogovikj", team_key: "altercpa_leads", team_mode: "pending",
    worked: 32, sale_decisions: 10, confirmed: 10, net_confirmed: 10, sold_value_eur: 800, net_value_eur: 800, packages: 19,
    bonus_orders: [{ p: 800, q: 19, i: [] }],
  });
  const idleMember = row({ person_id: "p-iva", user_id: "u-iva", name: "Iva", team_key: "altercpa_leads", team_mode: "pending" });
  const res = build("pending", [idleMember, boss, altercpaOnly, sanela]);
  const by = Object.fromEntries(res.agents.map((a) => [a.full_name, a]));

  it("AlterCPA-only operator: no login, presence n/a, last decision, still earns", () => {
    const a = by["AlterCPA #4531 (unnamed)"];
    expect(a.user_id).toBeNull();
    expect(a.key).toBe("p-4531");
    expect(a.presence.state).toBe("n/a");
    expect(a.presence.online_min).toBe(0);
    expect(a.last_decision_at).toBe("2026-09-22T15:02:00Z");
    expect(a.calls).toBe(0);
    expect(a.bonus_breakdown).toEqual({ package: 12, volume: 0, avg: 0 });
  });

  it("volume + avg tiers unchanged (avg gated at 10 confirmed); no team target on pending", () => {
    // 800/10 = 80 → avg tier 10; 10 confirmed → volume 5; 19 units at 800/19≈42.1 → 3 each = 57
    expect(by["Sanela Dzogovikj"].bonus_breakdown).toEqual({ package: 57, volume: 5, avg: 10 });
    expect(by["Sanela Dzogovikj"].bonus).toBe(72);
    expect(res.team_target_bonus).toBe(0);
    expect(res.agents.every((a) => !a.earns_team_target)).toBe(true);
  });

  it("manager on the pending board: shown, 0", () => {
    expect(by.Dragana.bonus).toBe(0);
    expect(by.Dragana.bonus_breakdown).toEqual({ package: 0, volume: 0, avg: 0 });
  });

  it("sorts by confirmed first on pending, zero-sale member last", () => {
    expect(res.agents.map((a) => a.full_name)).toEqual(["Dragana", "Sanela Dzogovikj", "AlterCPA #4531 (unnamed)", "Iva"]);
  });

  it("a row with no user id and no presence object reads n/a, never crashes", () => {
    const r = build("pending", [row({ person_id: null, user_id: null, name: "Ghost", presence: null })]);
    expect(r.agents[0].presence.state).toBe("n/a");
    expect(r.agents[0].key).toBe("user:Ghost");
  });
});

function r2(n: number) { return Math.round(n * 100) / 100; }
