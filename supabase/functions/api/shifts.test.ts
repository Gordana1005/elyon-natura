import { describe, expect, it } from "vitest";
import {
  addDaysYmd, agentRunway, cellKey, decideGate, diffCells, isRecentLogin, monthBounds, mondayOfYmd,
  normaliseCellsBody, parseActivityQuery, parseCopyBody, parseRange, parseRollMonthBody, runwaySummary,
  sameValue, shapeGrid, shapeLoginActivity, shapeMyShifts, shapeStatistics, skopjeNow, stagedFromInput,
  type GridCell, type StagedCell,
} from "./shifts.ts";

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const T1 = "33333333-3333-4333-8333-333333333333";
const S1 = "44444444-4444-4444-8444-444444444444";

const shift = (start: string, end: string, id = "s") => ({ id, date: "2026-10-01", start_time: `${start}:00`, end_time: `${end}:00` });

describe("decideGate — the login gate, unchanged", () => {
  it("lets in when any shift covers now, inclusive at both ends", () => {
    const d = decideGate([shift("07:00", "21:00")], "07:00", true);
    expect(d.allowed).toBe(true);
    expect(decideGate([shift("07:00", "21:00")], "21:00", true).allowed).toBe(true);
    expect(decideGate([shift("07:00", "21:00")], "21:01", true).allowed).toBe(false);
    expect(decideGate([shift("07:00", "21:00")], "06:59", true).allowed).toBe(false);
  });

  it("returns the FIRST covering shift and its HH:MM window", () => {
    const d = decideGate([shift("06:00", "10:00", "a"), shift("07:00", "21:00", "b")], "08:00", true);
    expect(d).toMatchObject({ allowed: true, start: "06:00", end: "10:00", shift: { id: "a" } });
  });

  it("no shift today: no_assignment for someone never scheduled, else no_shift_today", () => {
    expect(decideGate([], "09:00", false)).toMatchObject({ allowed: false, code: "no_assignment", reason: "No active shift assignment" });
    expect(decideGate([], "09:00", true)).toMatchObject({ allowed: false, code: "no_shift_today", reason: "No shift scheduled for today" });
  });

  it("00:00–00:00 is skipped; only such rows = zero_shift", () => {
    expect(decideGate([shift("00:00", "00:00")], "00:00", true)).toMatchObject({ allowed: false, code: "zero_shift" });
    expect(decideGate([shift("00:00", "00:00"), shift("09:00", "17:00")], "10:00", true).allowed).toBe(true);
  });

  it("outside hours lists today's real windows in the old reason / message text", () => {
    const d = decideGate([shift("00:00", "00:00"), shift("09:00", "17:00"), shift("18:00", "20:00")], "17:30", true);
    expect(d).toMatchObject({
      allowed: false, code: "outside_hours", windows: ["09:00 - 17:00", "18:00 - 20:00"],
      reason: "Outside shift hours (09:00 - 17:00, 18:00 - 20:00)",
    });
    if (!d.allowed) expect(d.message).toContain("Your shift hours are: 09:00 - 17:00, 18:00 - 20:00");
  });
});

describe("skopjeNow", () => {
  it("reads the Skopje wall clock (CEST = UTC+2 in October before the 25th)", () => {
    expect(skopjeNow(new Date("2026-10-01T05:30:00Z"))).toEqual({ date: "2026-10-01", time: "07:30" });
    expect(skopjeNow(new Date("2026-09-30T22:15:00Z"))).toEqual({ date: "2026-10-01", time: "00:15" });
    // CET from 25.10: UTC+1
    expect(skopjeNow(new Date("2026-11-02T06:00:00Z"))).toEqual({ date: "2026-11-02", time: "07:00" });
  });
});

describe("isRecentLogin — the 2-minute login-log dedupe", () => {
  const now = Date.parse("2026-10-01T07:02:00Z");
  it("dedupes within two minutes only", () => {
    expect(isRecentLogin("2026-10-01T07:00:30Z", now)).toBe(true);
    expect(isRecentLogin("2026-10-01T07:00:00Z", now)).toBe(false);
    expect(isRecentLogin(null, now)).toBe(false);
    expect(isRecentLogin("2026-10-01T07:05:00Z", now)).toBe(false);
  });
});

describe("cells: validation", () => {
  it("accepts each of the four cell kinds", () => {
    const r = normaliseCellsBody({ cells: [
      { user_id: U1, date: "2026-10-05", off: true },
      { user_id: U1, date: "2026-10-06", template_id: T1 },
      { user_id: U1, date: "2026-10-07", start: "07:00", end: "21:00", name: " Октомври " },
      { user_id: U2, date: "2026-10-07", shift_id: S1 },
    ] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.cells).toHaveLength(4);
      expect(r.cells[2]).toEqual({ user_id: U1, date: "2026-10-07", start: "07:00", end: "21:00", name: "Октомври" });
    }
  });

  it("refuses a cell with no value, two values, a bad window or a bad id", () => {
    expect(normaliseCellsBody({ cells: [{ user_id: U1, date: "2026-10-05" }] }).ok).toBe(false);
    expect(normaliseCellsBody({ cells: [{ user_id: U1, date: "2026-10-05", off: true, template_id: T1 }] }).ok).toBe(false);
    expect(normaliseCellsBody({ cells: [{ user_id: U1, date: "2026-10-05", start: "18:00", end: "09:00" }] })).toMatchObject({ ok: false, error: "end must be after start" });
    expect(normaliseCellsBody({ cells: [{ user_id: U1, date: "2026-10-05", start: "7:00", end: "09:00" }] }).ok).toBe(false);
    expect(normaliseCellsBody({ cells: [{ user_id: "nope", date: "2026-10-05", off: true }] }).ok).toBe(false);
    expect(normaliseCellsBody({ cells: [{ user_id: U1, date: "2026-02-30", off: true }] }).ok).toBe(false);
    expect(normaliseCellsBody({ cells: [] }).ok).toBe(false);
    expect(normaliseCellsBody({}).ok).toBe(false);
  });

  it("keeps the last value of a person-day painted twice", () => {
    const r = normaliseCellsBody({ cells: [
      { user_id: U1, date: "2026-10-05", template_id: T1 },
      { user_id: U1, date: "2026-10-05", off: true },
    ] });
    expect(r).toEqual({ ok: true, cells: [{ user_id: U1, date: "2026-10-05", off: true }] });
  });
});

describe("cells: diffing staged against stored", () => {
  const stored = (over: Partial<GridCell>): GridCell => ({
    user_id: U1, date: "2026-10-05", shift_id: S1, start: "07:00", end: "21:00", name: "Октомври", template_id: null, ...over,
  });
  const tpl: StagedCell = { kind: "template", template_id: T1, start: "07:30", end: "14:30", name: "Smena 1" };

  it("drops no-ops: the same window, an erase of nothing, the same template", () => {
    const original = new Map([[cellKey(U1, "2026-10-05"), stored({})], [cellKey(U1, "2026-10-06"), stored({ date: "2026-10-06", start: "07:30", end: "14:30", template_id: T1 })]]);
    const staged = new Map<string, StagedCell>([
      [cellKey(U1, "2026-10-05"), { kind: "window", start: "07:00", end: "21:00" }],
      [cellKey(U1, "2026-10-06"), tpl],
      [cellKey(U2, "2026-10-05"), { kind: "off" }],
    ]);
    expect(diffCells(original, staged)).toEqual([]);
  });

  it("emits real changes as POST /shifts/cells cells, sorted by person then day", () => {
    const original = new Map([[cellKey(U1, "2026-10-05"), stored({})], [cellKey(U1, "2026-10-06"), stored({ date: "2026-10-06" })]]);
    const staged = new Map<string, StagedCell>([
      [cellKey(U2, "2026-10-05"), { kind: "window", start: "08:00", end: "16:00", name: "" }],
      [cellKey(U1, "2026-10-06"), { kind: "off" }],
      [cellKey(U1, "2026-10-05"), tpl],
    ]);
    expect(diffCells(original, staged)).toEqual([
      { user_id: U1, date: "2026-10-05", template_id: T1 },
      { user_id: U1, date: "2026-10-06", off: true },
      { user_id: U2, date: "2026-10-05", start: "08:00", end: "16:00" },
    ]);
  });

  it("a template brush onto the same window but an unlinked row is a change (it links the template)", () => {
    expect(sameValue(stored({ start: "07:30", end: "14:30" }), tpl)).toBe(false);
    expect(sameValue(stored({ start: "07:30", end: "14:30", template_id: T1 }), tpl)).toBe(true);
  });

  it("maps server cells (copy preview) back to staged values", () => {
    const templates = [{ id: T1, name: "Smena 1", start: "07:30", end: "14:30" }];
    expect(stagedFromInput({ user_id: U1, date: "2026-10-05", template_id: T1 }, templates)).toEqual(tpl);
    expect(stagedFromInput({ user_id: U1, date: "2026-10-05", off: true }, templates)).toEqual({ kind: "off" });
    expect(stagedFromInput({ user_id: U1, date: "2026-10-05", start: "07:00", end: "21:00", name: "Октомври" }, templates))
      .toEqual({ kind: "window", start: "07:00", end: "21:00", name: "Октомври" });
    expect(stagedFromInput({ user_id: U1, date: "2026-10-05", template_id: S1 }, templates)).toBeNull();
  });
});

describe("runway", () => {
  it("ok when nobody runs out: says how far the roster goes", () => {
    expect(runwaySummary({ today: "2026-10-01", warn_days: 5, agents: 33, min_last_date: "2026-10-31", running_out: [] }))
      .toMatchObject({ level: "ok", ends_on: "2026-10-31", count: 0, blocked_from: null, days_left: null });
  });

  it("warn: the roster ends on 31.10, 3 days from 28.10 → 3 agents cannot log in from 01.11", () => {
    const s = runwaySummary({ today: "2026-10-28", warn_days: 5, agents: 33, min_last_date: "2026-10-31", running_out: [
      { user_id: U1, name: "Ана", last_date: "2026-10-31" },
      { user_id: U2, name: "Бети", last_date: "2026-11-01" },
      { user_id: S1, name: "Ива", last_date: "2026-10-31" },
    ] });
    expect(s).toMatchObject({ level: "warn", ends_on: "2026-10-31", blocked_from: "2026-11-01", days_left: 4, count: 3 });
  });

  it("critical when someone is locked out today (no shift at all) or tomorrow", () => {
    expect(runwaySummary({ today: "2026-10-01", agents: 3, running_out: [{ user_id: U1, name: "Ана", last_date: null }] }))
      .toMatchObject({ level: "critical", blocked_from: "2026-10-01", days_left: 0, ends_on: null });
    expect(runwaySummary({ today: "2026-10-01", agents: 3, running_out: [{ user_id: U1, name: "Ана", last_date: "2026-10-01" }] }))
      .toMatchObject({ level: "critical", blocked_from: "2026-10-02", days_left: 1 });
    // a last day in the past is still "today"
    expect(runwaySummary({ today: "2026-10-03", agents: 3, running_out: [{ user_id: U1, name: "Ана", last_date: "2026-09-30" }] }))
      .toMatchObject({ blocked_from: "2026-10-03", days_left: 0 });
  });

  it("the agent's banner: no shift in the next 5 days", () => {
    expect(agentRunway([], "2026-10-01")).toEqual({ show: true, from: "2026-10-01", last: null });
    expect(agentRunway(["2026-09-30", "2026-10-02", "2026-10-03"], "2026-10-01")).toEqual({ show: true, from: "2026-10-04", last: "2026-10-03" });
    expect(agentRunway(["2026-10-05"], "2026-10-01")).toEqual({ show: true, from: "2026-10-06", last: "2026-10-05" });
    expect(agentRunway(["2026-10-06"], "2026-10-01")).toEqual({ show: false, from: null, last: "2026-10-06" });
  });
});

describe("ranges and bodies", () => {
  it("calendar helpers", () => {
    expect(addDaysYmd("2026-10-31", 1)).toBe("2026-11-01");
    expect(mondayOfYmd("2026-10-04")).toBe("2026-09-28");
    expect(mondayOfYmd("2026-10-05")).toBe("2026-10-05");
    expect(monthBounds("2026-02-10")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
  });

  it("parseRange", () => {
    expect(parseRange(null, null, { from: "2026-10-01", to: "2026-10-07" }, 63)).toEqual({ ok: true, from: "2026-10-01", to: "2026-10-07" });
    expect(parseRange("2026-10-07", "2026-10-01", { from: "", to: "" }, 63).ok).toBe(false);
    expect(parseRange("2026-10-01", "2026-12-31", { from: "", to: "" }, 63).ok).toBe(false);
  });

  it("copy: previous week into this one, no overlap", () => {
    expect(parseCopyBody({ src_from: "2026-09-28", src_to: "2026-10-04", dst_from: "2026-10-05" }))
      .toEqual({ ok: true, src_from: "2026-09-28", src_to: "2026-10-04", dst_from: "2026-10-05", mode: "fill_empty", apply: false });
    expect(parseCopyBody({ src_from: "2026-09-28", src_to: "2026-10-04", dst_from: "2026-10-01" }).ok).toBe(false);
    expect(parseCopyBody({ src_from: "2026-09-28", src_to: "2026-10-04", dst_from: "2026-10-05", mode: "nuke" }).ok).toBe(false);
  });

  it("roll-month defaults to this month → the next", () => {
    expect(parseRollMonthBody({}, "2026-09-30")).toMatchObject({
      ok: true, src_from: "2026-09-01", src_to: "2026-09-30", dst_from: "2026-10-01", dst_to: "2026-10-31", apply: false, user_ids: null,
    });
    expect(parseRollMonthBody({ apply: true }, "2026-10-01")).toMatchObject({ src_from: "2026-10-01", dst_to: "2026-11-30", apply: true });
    expect(parseRollMonthBody({ user_ids: ["x"] }, "2026-10-01").ok).toBe(false);
  });

  it("login-activity query", () => {
    const sp = new URLSearchParams({ from: "2026-09-01", to: "2026-09-30", status: "late", limit: "500", offset: "-3" });
    expect(parseActivityQuery(sp, "2026-10-01")).toEqual({ ok: true, from: "2026-09-01", to: "2026-09-30", user_id: null, status: "late", limit: 200, offset: 0 });
    expect(parseActivityQuery(new URLSearchParams({ status: "Late Login" }), "2026-10-01").ok).toBe(false);
    expect(parseActivityQuery(new URLSearchParams({}), "2026-10-01")).toMatchObject({ from: "2026-10-01", to: "2026-10-01", limit: 50 });
  });
});

describe("response shapes", () => {
  it("grid: whitelisted, times as HH:MM", () => {
    const g = shapeGrid({ from: "2026-10-01", to: "2026-10-07", today: "2026-10-01", secret: 1,
      people: [{ user_id: U1, name: "Ана", roles: ["pending_agent"], gated: true, team_key: "altercpa_leads", team_name: "x", extra: 1 }],
      cells: [{ user_id: U1, date: "2026-10-01", shift_id: S1, start: "07:00:00", end: "21:00", name: "Октомври", template_id: null }],
      templates: [{ id: T1, name: "Smena 1", start: "07:30", end: "14:30" }], windows: [{ start: "07:00", end: "21:00", name: "Октомври", count: "12" }] });
    expect(g).not.toHaveProperty("secret");
    expect(g.people[0]).not.toHaveProperty("extra");
    expect(g.cells[0].start).toBe("07:00");
    expect(g.windows[0].count).toBe(12);
  });

  it("login activity: unknown status / reason codes are coerced", () => {
    const a = shapeLoginActivity({ total: "2", counts: { late: 1 }, rows: [
      { id: "1", kind: "blocked", user_id: U1, status: "blocked", reason_code: "outside_hours", reason_detail: "07:00 - 21:00" },
      { id: "2", kind: "login", user_id: U1, status: "weird", reason_code: "zzz" },
    ] });
    expect(a.total).toBe(2);
    expect(a.counts).toEqual({ on_time: 0, late: 1, early: 0, blocked: 0 });
    expect(a.rows[1]).toMatchObject({ status: "on_time", reason_code: "other" });
  });

  it("statistics: numbers coerced", () => {
    const s = shapeStatistics({ rows: [{ user_id: U1, full_name: "Ана", total_hours_scheduled: "19.5", total_shifts: 3 }], totals: { shifts: "3" } });
    expect(s.rows[0].total_hours_scheduled).toBe(19.5);
    expect(s.totals.shifts).toBe(3);
  });

  it("my shifts: clock-in and breaks attach by DATE", () => {
    const now = Date.parse("2026-10-01T10:00:00Z");
    const days = shapeMyShifts(
      [{ shift_date: "2026-10-01", shifts: { id: S1, name: "Октомври", date: "2026-10-01", start_time: "07:00:00", end_time: "21:00:00", template_id: null } }],
      [{ shift_date: "2026-10-01", login_time: "2026-10-01T05:10:00Z" }, { shift_date: "2026-10-01", login_time: "2026-10-01T05:02:00Z" }],
      [{ id: "b1", shift_date: "2026-10-01", break_start: "2026-10-01T09:30:00Z", break_end: null },
       { id: "b0", shift_date: "2026-10-01", break_start: "2026-10-01T08:00:00Z", break_end: "2026-10-01T08:15:00Z" }],
      now,
    );
    expect(days).toHaveLength(1);
    expect(days[0]).toMatchObject({ start_time: "07:00", end_time: "21:00", clock_in_time: "2026-10-01T05:02:00Z", total_break_seconds: 45 * 60, on_break: true });
    expect(days[0].breaks.map((b) => b.id)).toEqual(["b0", "b1"]);
  });
});
