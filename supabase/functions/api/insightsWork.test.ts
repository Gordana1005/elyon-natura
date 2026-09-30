import { describe, expect, it } from "vitest";
import {
  MONEY_KEY_RE, RATE_MIN_ACTIVE_MIN, buildWorkDayResponse, buildWorkResponse, dropMoneyKeys, parseCredited,
  parseWorkDay, rates, teamOrder, workAccess,
} from "./insightsWork.ts";
import type { WorkCounts } from "./insightsWork.ts";
import { overviewWindows } from "./overview.ts";

const NOW = new Date("2026-09-28T10:00:00Z"); // 12:00 Skopje

const zero: WorkCounts = {
  worked: 0, via_crm: 0, via_altercpa: 0, sale: 0, cancel: 0, trash: 0, callback: 0, no_answer: 0,
  call_logs: 0, timed_calls: 0, handling_sec: 0, credited: 0, worked_tracked: 0, sale_tracked: 0,
  online_min: null, active_min: null, idle_min: null, break_min: null, idle_alerts: null, breaks: 0, break_logged_min: 0,
};

// Two teams, one person of each + a person with no team; the numbers are the
// shape of 01–27.09.2026 scaled down.
const P_ANITA = "11111111-1111-1111-1111-111111111111";
const P_NINA = "22222222-2222-2222-2222-222222222222";
const P_LONE = "33333333-3333-3333-3333-333333333333";
const P_GHOST = "44444444-4444-4444-4444-444444444444";
const rpc = () => ({
  meta: { gran: "day", presence_since: "2026-09-28", work_since: "2026-08-05T06:27:26+00:00", calls_since: "2026-08-06T11:58:47Z", self: false },
  totals: {
    worked: 120, via_crm: 80, via_altercpa: 40, sale: 30, cancel: 60, trash: 25, callback: 0,
    no_answer: 70, call_logs: 72, timed_calls: 2, handling_sec: 100, people: 3, people_crm: 2, people_altercpa: 1,
    worked_tracked: 10, sale_tracked: 3, presence_people: 1, online_min: 90, active_min: 60, idle_min: 20, break_min: 10,
    idle_alerts: 1, breaks: 1, break_logged_min: 10, days_active: 3,
  },
  prev: {
    worked: 100, via_crm: 50, via_altercpa: 50, sale: 20, cancel: 50, trash: 30, callback: 0, no_answer: 40,
    call_logs: 40, timed_calls: 0, people: 2, worked_tracked: 0, sale_tracked: 0, presence_people: 0,
    online_min: null, active_min: null, idle_alerts: null,
  },
  teams: [
    { team_key: "altercpa_leads", name: "Pending — AlterCPA leads", mode: "pending" },
    { team_key: "crm_prediction", name: "Prediction — ElyonCRM", mode: "prediction" },
    { team_key: "management", name: "Management", mode: null },
  ],
  people: [
    {
      person_id: P_ANITA, name: "Anita Koligova", has_login: true, is_manager: false, is_active: true,
      team_key: "crm_prediction", role: "member", online_state: "online",
      worked: 70, via_crm: 70, via_altercpa: 0, sale: 10, cancel: 40, trash: 20, callback: 0,
      no_answer: 70, call_logs: 72, timed_calls: 2, handling_sec: 100, days_active: 3,
      first_at: "2026-09-26T06:00:00Z", last_at: "2026-09-28T09:00:00Z", avg_start_min: 480, avg_end_min: 960,
      last_decision_at: "2026-09-28T09:00:00Z", worked_tracked: 10, sale_tracked: 3, presence_days: 1,
      online_min: 90, active_min: 60, idle_min: 20, break_min: 10, idle_alerts: 1, breaks: 1, break_logged_min: 10,
    },
    {
      person_id: P_NINA, name: "Nina", has_login: true, is_manager: true, is_active: true,
      team_key: "altercpa_leads", role: "member", online_state: "offline",
      worked: 40, via_crm: 0, via_altercpa: 40, sale: 18, cancel: 15, trash: 7, callback: 0,
      no_answer: 0, call_logs: 0, timed_calls: 0, handling_sec: 0, days_active: 2,
      worked_tracked: 0, sale_tracked: 0, presence_days: 0, online_min: null, active_min: null,
    },
    {
      person_id: P_LONE, name: "Lone Operator", has_login: false, is_manager: false, is_active: true,
      team_key: "unassigned", role: "member", online_state: "n/a",
      worked: 5, via_crm: 10, via_altercpa: 5, sale: 2, cancel: 3, trash: 0, callback: 0,
      no_answer: 0, call_logs: 0, days_active: 1,
    },
  ],
  per_day: [
    { d: "2026-09-26", team_key: "crm_prediction", worked: 30, sale: 4, cancel: 16, trash: 10, callback: 0, no_answer: 30, call_logs: 30, people: 1 },
    { d: "2026-09-27", team_key: "altercpa_leads", worked: 40, sale: 18, cancel: 15, trash: 7, callback: 0, no_answer: 0, call_logs: 0, people: 1 },
    { d: "2026-09-27", team_key: "__none__", worked: 5, sale: 0, cancel: 5, trash: 0, callback: 0, no_answer: 0, call_logs: 0, people: 0 },
  ],
  by_hour: [{ p: P_ANITA, h: 9, d: 12, c: 8 }, { p: null, h: 25, d: 1, c: 0 }],
  callbacks: { leads: { total: 43, unassigned: 43, over_24h: 36, expiring_24h: 0 }, prediction: { total: 535 } },
  quality: { no_person: 5, no_person_top: [{ via: "crm", ext: "Someone", n: 5 }], days_before_presence: 2 },
});
const credited = () => ({
  gran: "day", total: 17, no_seller: 4,
  rows: [
    { p: P_ANITA, b: "2026-09-26", n: 3 },
    { p: P_ANITA, b: "2026-09-27", n: 2 },
    { p: P_NINA, b: "2026-09-27", n: 11 },
    { p: P_GHOST, b: "2026-09-27", n: 1 },
  ],
});

const win = () => {
  const w = overviewWindows("2026-09-26", "2026-09-28", true, NOW);
  if ("error" in w) throw new Error(w.error);
  return w;
};

describe("workAccess", () => {
  it("keeps the call_activity gate and pins other holders to themselves", () => {
    expect(workAccess({ canCallActivity: false, isAdminOrManager: true, isOwner: true })).toBe("forbidden");
    expect(workAccess({ canCallActivity: true, isAdminOrManager: true, isOwner: false })).toBe("all");
    expect(workAccess({ canCallActivity: true, isAdminOrManager: false, isOwner: true })).toBe("all");
    expect(workAccess({ canCallActivity: true, isAdminOrManager: false, isOwner: false })).toBe("self");
  });
});

describe("parseWorkDay", () => {
  it("defaults to today in Skopje and returns Skopje instants", () => {
    const d = parseWorkDay(null, NOW);
    if ("error" in d) throw new Error(d.error);
    expect(d.day).toBe("2026-09-28");
    expect(d.today).toBe(true);
    expect(d.fromIso).toBe("2026-09-27T22:00:00.000Z");
  });
  it("refuses the future and garbage", () => {
    expect(parseWorkDay("2026-09-29", NOW)).toEqual({ error: "day is in the future" });
    expect("error" in parseWorkDay("28.09.2026", NOW)).toBe(true);
    expect("error" in parseWorkDay("2026-02-30", NOW)).toBe(true);
  });
  it("reads a past day (winter offset)", () => {
    const d = parseWorkDay("2026-01-15", NOW);
    if ("error" in d) throw new Error(d.error);
    expect(d.fromIso).toBe("2026-01-14T23:00:00.000Z");
    expect(d.today).toBe(false);
  });
});

describe("rates", () => {
  it("reach divides CRM decisions by CRM decisions + no-answers, never all call logs", () => {
    const r = rates({ ...zero, worked: 7118 + 4683, via_crm: 7118, via_altercpa: 4683, sale: 2364, no_answer: 4373 });
    expect(r.reach).toBeCloseTo(0.6194, 4);
    expect(r.conversion).toBeCloseTo(0.2003, 4);
  });
  it("per active hour only with enough active minutes, and only over tracked decisions", () => {
    expect(rates({ ...zero, worked: 500, worked_tracked: 30, active_min: RATE_MIN_ACTIVE_MIN - 1 }).per_active_hour).toBeNull();
    const r = rates({ ...zero, worked: 500, worked_tracked: 30, sale_tracked: 6, active_min: 120 });
    expect(r.per_active_hour).toBe(15);
    expect(r.sales_per_active_hour).toBe(3);
  });
  it("no denominator → null, never 0 or Infinity", () => {
    const r = rates(zero, 0);
    expect(r).toEqual({ conversion: null, reach: null, per_active_hour: null, sales_per_active_hour: null, avg_handling_sec: null, per_active_day: null });
  });
  it("handling per timed call", () => {
    expect(rates({ ...zero, timed_calls: 35, handling_sec: 1997 }).avg_handling_sec).toBe(57);
  });
});

describe("buildWorkResponse", () => {
  const body = buildWorkResponse(rpc(), credited(), { gran: "day", total: 9, rows: [] }, win(), { self: false, now: NOW }) as any;

  it("groups people into teams in board order, members by work, team totals = Σ members", () => {
    expect(body.teams.map((t: any) => t.team_key)).toEqual(["altercpa_leads", "crm_prediction", "management", "unassigned"]);
    const pred = body.teams.find((t: any) => t.team_key === "crm_prediction");
    expect(pred.members.map((m: any) => m.name)).toEqual(["Anita Koligova"]);
    expect(pred.totals.worked).toBe(70);
    expect(pred.totals.credited).toBe(5);
    expect(pred.totals.people).toBe(1);
    expect(pred.totals.active_people).toBe(1);
    const mgmt = body.teams.find((t: any) => t.team_key === "management");
    expect(mgmt.members).toEqual([]);
    expect(mgmt.totals.worked).toBe(0);
    expect(mgmt.totals.online_min).toBeNull();
  });

  it("merges credited sales per person and per day by the person's team", () => {
    const anita = body.teams.flatMap((t: any) => t.members).find((m: any) => m.person_id === P_ANITA);
    expect(anita.credited).toBe(5);
    const nina = body.teams.flatMap((t: any) => t.members).find((m: any) => m.person_id === P_NINA);
    expect(nina.credited).toBe(11);
    const d26 = body.per_day.find((p: any) => p.d === "2026-09-26" && p.team_key === "crm_prediction");
    expect(d26.credited).toBe(3);
    // a credited day with no other work gets its own point
    const d27p = body.per_day.find((p: any) => p.d === "2026-09-27" && p.team_key === "crm_prediction");
    expect(d27p).toMatchObject({ credited: 2, worked: 0 });
    // credited to a person insights_work did not list → unassigned, flagged
    const d27u = body.per_day.find((p: any) => p.d === "2026-09-27" && p.team_key === "unassigned");
    expect(d27u.credited).toBe(1);
    expect(body.quality.credited_unlisted).toBe(1);
    expect(body.quality.no_seller).toBe(4);
    expect(body.totals.credited).toBe(17);
    expect(body.prev.credited).toBe(9);
  });

  it("Σ per_day = the totals (decisions nobody owns included)", () => {
    const sum = (k: string) => body.per_day.reduce((a: number, p: any) => a + p[k], 0);
    // the fixture's per_day covers all 75 of its SQL rows; a live run ties to totals.worked exactly
    expect(sum("worked")).toBe(75);
    expect(sum("credited")).toBe(body.totals.credited);
  });

  it("carries rates on people, teams and totals", () => {
    const anita = body.teams[1].members[0];
    expect(anita.reach).toBeCloseTo(0.5, 4);
    expect(anita.per_active_hour).toBe(10);
    expect(anita.per_active_day).toBeCloseTo(23.3, 1);
    expect(body.totals.reach).toBeCloseTo(80 / 150, 4);
    expect(body.prev.conversion).toBeCloseTo(0.2, 4);
  });

  it("meta: the window, the decided clock, VOIP off, presence start", () => {
    expect(body.meta).toMatchObject({
      from: "2026-09-26", to: "2026-09-28", prev_from: "2026-09-23", prev_to: "2026-09-25", partial: true, days: 3,
      gran: "day", clock: "decided", voip: false, presence_since: "2026-09-28", self: false, credited: true, prev_credited: true,
    });
  });

  it("drops an out-of-range hour", () => {
    expect(body.by_hour).toEqual([{ p: P_ANITA, h: 9, d: 12, c: 8 }]);
  });

  it("a failed credited scan reads null, never 0", () => {
    const b = buildWorkResponse(rpc(), null, null, win(), { self: false, now: NOW }) as any;
    expect(b.totals.credited).toBeNull();
    expect(b.teams[1].members[0].credited).toBeNull();
    expect(b.teams[1].totals.credited).toBeNull();
    expect(b.prev.credited).toBeNull();
    expect(b.meta.credited).toBe(false);
  });

  it("no previous period without a compare window", () => {
    const w = overviewWindows("2026-09-26", "2026-09-28", false, NOW);
    if ("error" in w) throw new Error(w.error);
    const b = buildWorkResponse(rpc(), credited(), null, w, { self: false, now: NOW }) as any;
    expect(b.prev).toBeNull();
  });

  it("never carries a money key, even when the SQL sends one", () => {
    const r = rpc() as any;
    r.totals.sold_value_eur = 1234;
    r.callbacks.leads.value_mkd = 99;
    const b = buildWorkResponse(r, credited(), null, win(), { self: false, now: NOW });
    const keys: string[] = [];
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { keys.push(k); walk(x); }
    };
    walk(b);
    expect(keys.filter((k) => MONEY_KEY_RE.test(k))).toEqual([]);
  });

  it("tolerates an empty payload", () => {
    const b = buildWorkResponse({}, null, null, win(), { self: true, now: NOW }) as any;
    expect(b.teams).toEqual([]);
    expect(b.per_day).toEqual([]);
    expect(b.totals.worked).toBe(0);
    expect(b.meta.self).toBe(true);
  });
});

describe("helpers", () => {
  it("teamOrder = sales_teams.sort_order: Телешоп, Affiliate, legacy, management, unassigned", () => {
    const keys = [
      { team_key: "unassigned" }, { team_key: "management", sort_order: 90 },
      { team_key: "affiliate", sort_order: 20 }, { team_key: "crm_prediction", sort_order: 41 },
      { team_key: "altercpa_leads", sort_order: 40 }, { team_key: "teleshop", sort_order: 10 },
    ].sort((a, b) => teamOrder(a) - teamOrder(b)).map((t) => t.team_key);
    expect(keys).toEqual(["teleshop", "affiliate", "altercpa_leads", "crm_prediction", "management", "unassigned"]);
    // an older payload without sort_order keeps the seeded order
    expect([{ team_key: "management" }, { team_key: "affiliate" }, { team_key: "teleshop" }]
      .sort((a, b) => teamOrder(a) - teamOrder(b)).map((t) => t.team_key)).toEqual(["teleshop", "affiliate", "management"]);
  });
  it("a legacy team nobody is in any more is not listed; one with members is", () => {
    const win = overviewWindows("2026-09-26", "2026-09-27", false, NOW);
    if ("error" in win) throw new Error(win.error);
    const body = buildWorkResponse({
      meta: {}, totals: {},
      teams: [
        { team_key: "teleshop", name: "Телешоп", mode: "prediction", kind: "line", sort_order: 10 },
        { team_key: "altercpa_leads", name: "old", mode: "pending", kind: "legacy", sort_order: 40 },
        { team_key: "crm_prediction", name: "old", mode: "prediction", kind: "legacy", sort_order: 41 },
      ],
      people: [
        { person_id: P_ANITA, name: "Anita", team_key: "teleshop", team_lane: "out", worked: 3 },
        { person_id: P_NINA, name: "Nina", team_key: "crm_prediction", worked: 1 },
      ],
    }, null, null, win, { self: false, now: NOW }) as any;
    expect(body.teams.map((t: any) => t.team_key)).toEqual(["teleshop", "crm_prediction"]);
    expect(body.teams[0].members[0]).toMatchObject({ team_key: "teleshop", team_lane: "out" });
    expect(body.teams[0]).toMatchObject({ kind: "line", sort_order: 10 });
  });
  it("parseCredited drops malformed rows", () => {
    expect(parseCredited({ total: "3", rows: [{ p: "x", b: "2026-09-01", n: "3" }, { p: 1 }] }))
      .toEqual({ gran: null, total: 3, no_seller: null, rows: [{ p: "x", b: "2026-09-01", n: 3 }] });
    expect(parseCredited(null)).toBeNull();
  });
  it("dropMoneyKeys at any depth", () => {
    expect(dropMoneyKeys({ a: 1, b_eur: 2, c: [{ d_mkd: 3, e: 4 }] })).toEqual({ a: 1, c: [{ e: 4 }] });
  });
});

describe("buildWorkDayResponse", () => {
  const day = parseWorkDay("2026-09-17", NOW);
  if ("error" in day) throw new Error(day.error);
  const b = buildWorkDayResponse({
    meta: { day: "2026-09-17", presence_since: "2026-09-28" },
    people: [
      {
        person_id: P_ANITA, name: "Anita Koligova", has_login: true, team_key: "crm_prediction", online_state: "offline",
        presence: null, logins: ["2026-09-17T06:01:00Z", 5], breaks: [{ s: "2026-09-17T10:00:00Z", e: null }, { e: "x" }],
        decisions: [
          { at: "2026-09-17T07:00:00Z", o: "cancel", via: "crm" },
          { at: "2026-09-17T08:00:00Z", o: "sale", via: "crm" },
        ],
        calls: [
          { at: "2026-09-17T06:30:00Z", o: "no_answer", timed: false, sec: 0 },
          { at: "2026-09-17T09:00:00Z", o: "answered", timed: true, e: "2026-09-17T09:01:00Z", sec: 60, st: "answered" },
        ],
      },
      {
        person_id: P_NINA, name: "Nina", has_login: true, team_key: "altercpa_leads",
        decisions: [{ at: "2026-09-17T21:30:00Z", o: "sale", via: "altercpa" }], calls: [],
      },
    ],
    unattributed: { decisions: 2, calls: 0 },
  }, day, { self: false, now: NOW }) as any;

  it("puts the AlterCPA team first and totals each row", () => {
    expect(b.people.map((p: any) => p.name)).toEqual(["Nina", "Anita Koligova"]);
    const a = b.people[1];
    expect(a.totals).toMatchObject({
      worked: 2, sale: 1, cancel: 1, no_answer: 1, call_logs: 2, timed_calls: 1, handling_sec: 60,
      first_at: "2026-09-17T06:30:00Z", last_at: "2026-09-17T09:00:00Z",
    });
    expect(a.logins).toEqual(["2026-09-17T06:01:00Z"]);
    expect(a.breaks).toEqual([{ s: "2026-09-17T10:00:00Z", e: null }]);
  });
  it("meta and the unattributed count", () => {
    expect(b.meta).toMatchObject({ day: "2026-09-17", today: false, voip: false, presence_since: "2026-09-28" });
    expect(b.unattributed).toEqual({ decisions: 2, calls: 0 });
  });
});
