import { describe, expect, it } from "vitest";
import {
  buildLeaderboardV2Response, LEADERBOARD_DEPARTMENTS, parseLeaderboardV2Query, stripLeaderboardV2Money,
} from "./leaderboardV2.ts";

// A leaderboard_day_v2() payload as the RPC hands it over (migration
// 20260942001200): two agents in two departments, a teleshop caller with only
// collabBox bookings, a manager, and the day's tie-out.
const rpc = {
  version: 2,
  day: "2026-09-28",
  is_today: true,
  generated_at: "2026-09-28T12:00:00+00:00",
  window: { from: "2026-09-27T22:00:00+00:00", to_end: "2026-09-28T21:59:59.999999+00:00" },
  filter: { department: null, team: null },
  departments: ["altercpa", "elyon_crm", "teleshop_out", "teleshop_other", "social", "web"],
  teams: [{ key: "altercpa_leads", name: "Pending — AlterCPA leads", people: 1 }, { key: "none", name: null, people: 1 }],
  summary: {
    people: 4, members: 3, managers: 1, ranked: 3, online_now: 1, idle: 0, on_break: 0, offline: 2, no_login: 1,
    was_online: 2, zero_sale_people: 0, worked: 70, sale_decisions: 20, sales: 16, value_mkd: 45000, booked: 23,
    booked_value_mkd: 51900, total_count: 39, total_value_mkd: 96900, cancelled_after_sale: 1, returned: 0,
    live_credited: 1, booked_twin: 2, booked_twin_value_mkd: 6000, no_seller: 2, no_seller_value_mkd: 5000, booked_no_person: 0,
  },
  day_totals: {
    sales: 18, value_mkd: 50000, credited: 16, live_credited: 1, worked: 72, unmapped_decisions: 2,
    by_department: {
      altercpa: { sales: 12, value_mkd: 36000, credited: 10, credited_value_mkd: 31000, no_seller: 2, no_seller_value_mkd: 5000, web: 0, mex_only: 3, mex_only_value_mkd: 9000 },
      web: { sales: 0, value_mkd: 0, web: 12, web_value_mkd: 27446 },
    },
    no_seller: { sales: 2, value_mkd: 5000, reasons: [{ reason: "awaiting_stamp", department: "altercpa", count: 2, value_mkd: 5000 }], booked: 0, booked_value_mkd: 0 },
    no_department: { orders: 0, orders_value_mkd: 0, bookings: 0, work: 0 },
    checks: { bookings_filter_drift: 0 },
  },
  rows: [
    {
      person_id: "p1", user_id: "u1", name: "Agent One", team_key: "altercpa_leads", team_name: "Pending — AlterCPA leads",
      is_member: true, is_manager: false, rank: 2, sales: 10, value_mkd: 31000, booked: 0, booked_value_mkd: 0,
      total_count: 10, total_value_mkd: 31000, cancelled_after_sale: 1, cancelled_value_mkd: 1450, returned: 0, live_credited: 1,
      booked_twin: 2, booked_twin_value_mkd: 6000, worked: 40, sale_decisions: 12, cancelled: 20, trashed: 5, callbacks: 3,
      conversion: 0.3, last_decision_at: "2026-09-28T11:58:00+00:00",
      departments: {
        altercpa: { sales: 10, value_mkd: 31000, booked: 0, booked_value_mkd: 0, booked_twin: 0, booked_twin_value_mkd: 0, cancelled_after_sale: 1, cancelled_value_mkd: 1450, returned: 0, live_credited: 1, worked: 40, sale_decisions: 12 },
        elyon_crm: { sales: 0, value_mkd: 0, booked: 0, booked_value_mkd: 0, booked_twin: 2, booked_twin_value_mkd: 6000, cancelled_after_sale: 0, cancelled_value_mkd: 0, returned: 0, live_credited: 0, worked: 0, sale_decisions: 0 },
        bogus: { sales: 99 },
      },
      presence: { state: "online", online_min: "312", active_min: 280, idle_min: 20, break_min: 12, idle_alerts: 1, idle_streak_min: null, first_login: null },
    },
    {
      person_id: "p2", user_id: null, name: "Teleshop Caller", team_key: null, team_name: null,
      is_member: false, is_manager: false, rank: 1, sales: 0, value_mkd: 0, booked: 23, booked_value_mkd: 51900,
      total_count: 23, total_value_mkd: 51900, cancelled_after_sale: 0, returned: 0, live_credited: 0, booked_twin: 0,
      worked: 0, sale_decisions: 0, cancelled: 0, trashed: 0, callbacks: 0, conversion: null, last_decision_at: null,
      departments: { teleshop_other: { sales: 0, value_mkd: 0, booked: 23, booked_value_mkd: 51900, booked_twin: 0, cancelled_after_sale: 0, returned: 0, live_credited: 0, worked: 0, sale_decisions: 0 } },
      presence: { state: "n/a" },
    },
    {
      person_id: "p3", user_id: "u3", name: "Manager", team_key: "management", team_name: "Management",
      is_member: true, is_manager: true, rank: null, sales: 6, value_mkd: 14000, total_count: 6, total_value_mkd: 14000,
      worked: 30, sale_decisions: 8, departments: {}, presence: null,
    },
  ],
};

describe("parseLeaderboardV2Query", () => {
  it("accepts the six departments, a team key, 'none' and empty", () => {
    for (const d of LEADERBOARD_DEPARTMENTS) expect(parseLeaderboardV2Query({ department: d })).toEqual({ ok: true, department: d, team: null });
    expect(parseLeaderboardV2Query({ team: "crm_prediction" })).toEqual({ ok: true, department: null, team: "crm_prediction" });
    expect(parseLeaderboardV2Query({ team: "none" })).toEqual({ ok: true, department: null, team: "none" });
    expect(parseLeaderboardV2Query({ department: " ", team: null })).toEqual({ ok: true, department: null, team: null });
  });
  it("refuses anything else before the RPC runs", () => {
    expect(parseLeaderboardV2Query({ department: "teleshop" }).ok).toBe(false);
    expect(parseLeaderboardV2Query({ department: "altercpa;drop" }).ok).toBe(false);
    expect(parseLeaderboardV2Query({ team: "Crm Prediction" }).ok).toBe(false);
    expect(parseLeaderboardV2Query({ team: "x".repeat(41) }).ok).toBe(false);
  });
});

describe("buildLeaderboardV2Response", () => {
  const withMoney = buildLeaderboardV2Response({ rpc, today: "2026-09-28", money: true, generatedAt: "g" });

  it("keeps the RPC's order, numbers and the envelope", () => {
    expect(withMoney.version).toBe(2);
    expect(withMoney.money).toBe(true);
    expect(withMoney.today).toBe("2026-09-28");
    expect(withMoney.generated_at).toBe("g");
    expect(withMoney.rows.map((r) => r.person_id)).toEqual(["p1", "p2", "p3"]);
    expect(withMoney.rows[0].total_value_mkd).toBe(31000);
    expect(withMoney.rows[0].presence.online_min).toBe(312);          // "312" → 312
    expect(withMoney.rows[0].conversion).toBe(0.3);
    expect(withMoney.summary.total_value_mkd).toBe(96900);
    expect(withMoney.departments).toEqual([...LEADERBOARD_DEPARTMENTS]);
  });

  it("normalises presence and drops department keys that are not the six", () => {
    expect(withMoney.rows[1].presence.state).toBe("n/a");               // no login
    expect(withMoney.rows[2].presence.state).toBe("offline");           // a login, no presence row
    expect(withMoney.rows[2].rank).toBeNull();
    expect(Object.keys(withMoney.rows[0].departments)).toEqual(["altercpa", "elyon_crm"]);
    expect(withMoney.rows[2].booked).toBe(0);                           // missing → 0
  });

  it("strips every money figure (whitelist) for a caller without money access", () => {
    const noMoney = buildLeaderboardV2Response({ rpc, today: "2026-09-28", money: false });
    const keys: string[] = [];
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { keys.push(k); walk(x); }
    };
    walk(noMoney);
    expect(keys.filter((k) => /_mkd$|_eur$/.test(k))).toEqual([]);
    expect(noMoney.money).toBe(false);
    // the counts survive
    expect(noMoney.rows[0].sales).toBe(10);
    expect(noMoney.rows[0].departments.altercpa?.sales).toBe(10);
    expect((noMoney.day_totals.no_seller as { reasons: Array<Record<string, unknown>> }).reasons[0])
      .toEqual({ reason: "awaiting_stamp", department: "altercpa", count: 2 });
    expect((noMoney.day_totals.by_department as Record<string, Record<string, unknown>>).web).toEqual({ sales: 0, web: 12 });
  });

  it("drops a key the RPC grows later unless it is allowed on purpose", () => {
    const grown = { ...rpc, summary: { ...rpc.summary, bonus_pool: 40 }, rows: [{ ...rpc.rows[0], secret_margin: 12 }] };
    const out = stripLeaderboardV2Money(buildLeaderboardV2Response({ rpc: grown, today: "2026-09-28", money: true }));
    expect(out.summary).not.toHaveProperty("bonus_pool");
    expect(out.rows[0]).not.toHaveProperty("secret_margin");
  });

  it("survives an empty or broken RPC body", () => {
    const out = buildLeaderboardV2Response({ rpc: null, today: "2026-09-29", money: true });
    expect(out.rows).toEqual([]);
    expect(out.day).toBe("2026-09-29");
    expect(out.filter).toEqual({ department: null, team: null });
  });

  // the web view (leaderboard_web_live, 20260942001940): only with &department=web
  const webLive = {
    day: "2026-09-29", orders: "8", value_mkd: 13310, all_orders: 17, card: 1, cod: 7,
    by_outcome: [{ key: "awaiting", count: 7, value_mkd: 14250 }, { key: "preparing", count: 8, value_mkd: 13310 }],
    latest: [{ at: "2026-09-29T13:35:51Z", number: "NTMK62512", city: "Демир Капија", total_mkd: 2000, outcome: "card_unpaid",
      payment: "card", counted: false, source: "facebook", item: "Magnesium Bisglycinate", items: 3, phone: "070000000" }],
    last_order_at: "2026-09-29T13:35:51Z", synced_at: "2026-09-29T14:03:03Z",
  };

  it("carries the web shop's day only when it was asked for", () => {
    expect(withMoney).not.toHaveProperty("web_live");
    const out = buildLeaderboardV2Response({ rpc, today: "2026-09-29", money: true, webLive });
    expect(out.web_live?.orders).toBe(8);                                 // "8" → 8
    expect(out.web_live?.value_mkd).toBe(13310);
    expect(out.web_live?.latest[0]).toMatchObject({ number: "NTMK62512", payment: "card", counted: false, items: 3 });
    expect(out.web_live?.latest[0]).not.toHaveProperty("phone");          // never a phone on the wall
    expect(buildLeaderboardV2Response({ rpc, today: "2026-09-29", money: true, webLive: null }).web_live).toBeNull();
  });

  it("keeps the web counts and drops its денари without money access", () => {
    const out = buildLeaderboardV2Response({ rpc, today: "2026-09-29", money: false, webLive });
    expect(out.web_live?.orders).toBe(8);
    expect(out.web_live).not.toHaveProperty("value_mkd");
    expect(out.web_live?.by_outcome[0]).toEqual({ key: "awaiting", count: 7 });
    expect(out.web_live?.latest[0]).not.toHaveProperty("total_mkd");
    expect(out.web_live?.latest[0].city).toBe("Демир Капија");
  });
});
