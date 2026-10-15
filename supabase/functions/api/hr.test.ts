import { describe, expect, it } from "vitest";
import {
  decorateRequest, dueWithin, inTeamScope, maxSameDay, parseDecideBody, parseEmployeeBody, parseEntitlementBody,
  parseHolidayBody, parseLeaveRequestBody, parseYear, requestDays, rpcErrorStatus, shapeBalance, stripEmployee,
  teamsOfDepartments, workingDays, type HrRequest,
} from "./hr.ts";

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const E1 = "33333333-3333-4333-8333-333333333333";

const MON_FRI = [1, 2, 3, 4, 5];
const HOLIDAYS = [
  { date: "2026-10-12", scope: "all" },      // Monday — moved from Sunday 11.10
  { date: "2026-10-23", scope: "all" },      // Friday
  { date: "2026-08-28", scope: "orthodox" }, // Friday — orthodox only
  { date: "2026-05-27", scope: "muslim" },   // Wednesday — muslim only
];

describe("workingDays — the person's work days minus their holidays", () => {
  it("Mon–Fri: a full week is 5, a weekend 0", () => {
    expect(workingDays("2026-10-05", "2026-10-11", MON_FRI, ["orthodox"], [])).toBe(5);
    expect(workingDays("2026-10-17", "2026-10-18", MON_FRI, ["orthodox"], [])).toBe(0);
  });
  it("a state holiday (and its moved Monday) is off for everyone", () => {
    expect(workingDays("2026-10-12", "2026-10-16", MON_FRI, ["orthodox"], HOLIDAYS)).toBe(4);
    expect(workingDays("2026-10-19", "2026-10-23", MON_FRI, ["muslim"], HOLIDAYS)).toBe(4);
  });
  it("a religious day only for its believers", () => {
    expect(workingDays("2026-08-28", "2026-08-28", MON_FRI, ["orthodox"], HOLIDAYS)).toBe(0);
    expect(workingDays("2026-08-28", "2026-08-28", MON_FRI, ["muslim"], HOLIDAYS)).toBe(1);
    expect(workingDays("2026-05-27", "2026-05-27", MON_FRI, ["muslim"], HOLIDAYS)).toBe(0);
    expect(workingDays("2026-05-27", "2026-05-27", MON_FRI, ["orthodox"], HOLIDAYS)).toBe(1);
  });
  it("a shop's Mon–Sat week counts Saturday", () => {
    expect(workingDays("2026-10-05", "2026-10-11", [1, 2, 3, 4, 5, 6], ["orthodox"], [])).toBe(6);
  });
  it("a bad range is 0", () => {
    expect(workingDays("2026-10-10", "2026-10-01", MON_FRI, [], [])).toBe(0);
    expect(workingDays("x", "2026-10-01", MON_FRI, [], [])).toBe(0);
  });
});

describe("requestDays — sick / maternity count calendar days", () => {
  it("sick leave over a weekend and a holiday counts every day", () => {
    expect(requestDays("sick", "2026-10-09", "2026-10-13", MON_FRI, ["orthodox"], HOLIDAYS)).toBe(5);
  });
  it("annual leave counts working days", () => {
    expect(requestDays("annual", "2026-10-09", "2026-10-13", MON_FRI, ["orthodox"], HOLIDAYS)).toBe(2);
  });
});

describe("stripEmployee — the dossier is for super_admin / owner / finance", () => {
  const row = { id: E1, full_name: "Ана", workplace: "shop", phone: "070", birth_date: "1990-01-01", notes: "HR", hire_date: "2020-01-01", updated_by: U1 };
  it("none: the dossier keys are ABSENT (not null)", () => {
    const s = stripEmployee(row, "none");
    expect(s).toEqual({ id: E1, full_name: "Ана", workplace: "shop" });
    expect("phone" in s).toBe(false);
  });
  it("self: one's own dossier without HR's notes", () => {
    const s = stripEmployee(row, "self");
    expect(s.phone).toBe("070");
    expect("notes" in s).toBe(false);
  });
  it("full: everything", () => {
    expect(stripEmployee(row, "full")).toEqual(row);
  });
});

describe("team scope — who a team lead sees and approves", () => {
  it("dept_admin departments map to the teams", () => {
    expect(teamsOfDepartments(["teleshop_out", "teleshop_other", "social"])).toEqual(["teleshop"]);
    expect(teamsOfDepartments(["altercpa", "elyon_crm"])).toEqual(["affiliate"]);
    expect(teamsOfDepartments(["web"])).toEqual([]);
    expect(teamsOfDepartments(null)).toEqual([]);
  });
  it("an explicit approver wins over the team; never oneself", () => {
    const viewer = { userId: U1, teams: ["teleshop"] };
    expect(inTeamScope({ team_key: "teleshop" }, viewer)).toBe(true);
    expect(inTeamScope({ team_key: "affiliate" }, viewer)).toBe(false);
    expect(inTeamScope({ team_key: "teleshop", approver_id: U2 }, viewer)).toBe(false);
    expect(inTeamScope({ team_key: "affiliate", approver_id: U1 }, viewer)).toBe(true);
    expect(inTeamScope({ team_key: "teleshop", user_id: U1 }, viewer)).toBe(false);
  });
});

describe("maxSameDay — too many of one team away at once", () => {
  const abs = [
    { employee_id: "a", date_from: "2026-10-19", date_to: "2026-10-23" },
    { employee_id: "b", date_from: "2026-10-21", date_to: "2026-10-21" },
    { employee_id: "c", date_from: "2026-10-21", date_to: "2026-10-22" },
    { employee_id: "d", date_from: "2026-10-21", date_to: "2026-10-21" },
  ];
  const team = (id: string) => (id === "d" ? "affiliate" : "teleshop");
  it("finds the busiest day of the group", () => {
    expect(maxSameDay(abs, team, "teleshop", "2026-10-19", "2026-10-23")).toEqual({ day: "2026-10-21", count: 3 });
    expect(maxSameDay(abs, team, "affiliate", "2026-10-19", "2026-10-23")).toEqual({ day: "2026-10-21", count: 1 });
  });
});

describe("bodies", () => {
  it("a leave request: type, dates, a one-day default", () => {
    const r = parseLeaveRequestBody({ type: "annual", date_from: "2026-10-19" });
    expect(r).toMatchObject({ ok: true, body: { type: "annual", date_from: "2026-10-19", date_to: "2026-10-19", employee_id: null, record: false } });
    expect(parseLeaveRequestBody({ type: "holiday", date_from: "2026-10-19" })).toMatchObject({ ok: false });
    expect(parseLeaveRequestBody({ type: "annual", date_from: "2026-10-20", date_to: "2026-10-19" })).toMatchObject({ ok: false });
    expect(parseLeaveRequestBody({ type: "annual", date_from: "2026-10-19", employee_id: "x" })).toMatchObject({ ok: false });
    expect(parseLeaveRequestBody({ type: "sick", date_from: "2026-10-19", record: true, employee_id: E1 }))
      .toMatchObject({ ok: true, body: { record: true, employee_id: E1 } });
  });
  it("a rejection needs a note", () => {
    expect(parseDecideBody({ decision: "approve" })).toEqual({ ok: true, decision: "approve", note: null });
    expect(parseDecideBody({ decision: "reject", note: "no" })).toMatchObject({ ok: false });
    expect(parseDecideBody({ decision: "reject", note: "премногу луѓе" })).toMatchObject({ ok: true, decision: "reject" });
    expect(parseDecideBody({ decision: "maybe" })).toMatchObject({ ok: false });
  });
  it("the dossier: known keys only, typed", () => {
    expect(parseEmployeeBody({ full_name: "Ана", workplace: "shop", work_days: [6, 1, 2, 2] }, true))
      .toEqual({ ok: true, data: { full_name: "Ана", workplace: "shop", work_days: [1, 2, 6] } });
    expect(parseEmployeeBody({ workplace: "shop" }, true)).toMatchObject({ ok: false, error: "a name is required" });
    expect(parseEmployeeBody({ salary: 1 }, false)).toMatchObject({ ok: false, error: "salary cannot be set" });
    expect(parseEmployeeBody({ work_days: [0] }, false)).toMatchObject({ ok: false });
    expect(parseEmployeeBody({ holiday_calendars: ["muslim", "albanian"] }, false)).toMatchObject({ ok: true });
    expect(parseEmployeeBody({ holiday_calendars: ["pagan"] }, false)).toMatchObject({ ok: false });
    expect(parseEmployeeBody({ hire_date: "" }, false)).toEqual({ ok: true, data: { hire_date: null } });
    expect(parseEmployeeBody({ full_name: "" }, false)).toMatchObject({ ok: false });
  });
  it("an entitlement: halves, base null = default", () => {
    expect(parseEntitlementBody({ employee_id: E1, year: 2026, base_days: 20, extra_days: 3, carry_days: 4.5 }))
      .toMatchObject({ ok: true, base_days: 20, extra_days: 3, carry_days: 4.5 });
    expect(parseEntitlementBody({ employee_id: E1, year: 2026, base_days: null })).toMatchObject({ ok: true, base_days: null });
    expect(parseEntitlementBody({ employee_id: E1, year: 2026, base_days: 20.3 })).toMatchObject({ ok: false });
    expect(parseEntitlementBody({ employee_id: E1, year: 1999, base_days: 20 })).toMatchObject({ ok: false });
  });
  it("a holiday", () => {
    expect(parseHolidayBody({ date: "2027-01-07", name: "Божик" })).toMatchObject({ ok: true, scope: "all", verified: true });
    expect(parseHolidayBody({ date: "2027-01-07", name: "X", scope: "pagan" })).toMatchObject({ ok: false });
  });
  it("the year param", () => {
    expect(parseYear("2027", "2026-10-15")).toBe(2027);
    expect(parseYear(null, "2026-10-15")).toBe(2026);
    expect(parseYear("abc", "2026-10-15")).toBe(2026);
  });
});

describe("rpcErrorStatus — the writers' own messages", () => {
  it("maps codes", () => {
    expect(rpcErrorStatus({ code: "23505", message: "hr_leave_request: overlaps 18.10–20.10" }))
      .toEqual({ status: 409, error: "hr.conflict: overlaps 18.10–20.10" });
    expect(rpcErrorStatus({ code: "42501", message: "hr_leave_decide: nobody decides their own request" }).status).toBe(403);
    expect(rpcErrorStatus({ code: "P0002" }).status).toBe(404);
    expect(rpcErrorStatus({ code: "XX000", message: "secret table detail" })).toEqual({ status: 400, error: "hr.failed" });
  });
});

describe("decorateRequest — what the viewer may do", () => {
  const base: HrRequest = {
    id: "r", employee_id: E1, employee_name: "Ана", employee_user_id: U2, type: "annual",
    date_from: "2026-10-20", date_to: "2026-10-22", days: 3, status: "pending_team", note: null, doc_ref: null,
    requested_by: U2, requested_at: "2026-10-15T08:00:00Z", team_by: null, team_at: null, team_note: null,
    decided_by: null, decided_at: null, decision_note: null, cancelled_by: null, cancelled_at: null, cancel_note: null,
  };
  const today = "2026-10-15";
  it("the team lead decides the team step only", () => {
    const team = { userId: U1, final: false, superAdmin: false, teamScope: true, today };
    expect(decorateRequest(base, team).can_decide).toBe(true);
    expect(decorateRequest({ ...base, status: "pending_manager" }, team).can_decide).toBe(false);
  });
  it("a manager decides any open step, never their own", () => {
    const mgr = { userId: U1, final: true, superAdmin: false, teamScope: false, today };
    expect(decorateRequest({ ...base, status: "pending_manager" }, mgr).can_decide).toBe(true);
    expect(decorateRequest({ ...base, employee_user_id: U1 }, mgr).can_decide).toBe(false);
    expect(decorateRequest({ ...base, employee_user_id: U1 }, { ...mgr, superAdmin: true }).can_decide).toBe(true);
  });
  it("the employee cancels while open, or before an approved one starts", () => {
    const me = { userId: U2, final: false, superAdmin: false, teamScope: false, today };
    expect(decorateRequest(base, me).can_cancel).toBe(true);
    expect(decorateRequest({ ...base, status: "approved" }, me).can_cancel).toBe(true);
    expect(decorateRequest({ ...base, status: "approved", date_from: "2026-10-15" }, me).can_cancel).toBe(false);
    expect(decorateRequest({ ...base, status: "rejected" }, me).can_cancel).toBe(false);
    expect(decorateRequest(base, me).can_decide).toBe(false);
  });
});

describe("shapeBalance / dueWithin", () => {
  it("numerics as strings become numbers", () => {
    const b = shapeBalance({ year: 2026, base_days: "20", taken: "2.0", remaining: 18, first_part_ok: false, source: "default" });
    expect(b).toMatchObject({ year: 2026, base_days: 20, taken: 2, remaining: 18, first_part_ok: false, source: "default", carry_days: 0 });
    expect(shapeBalance(null)).toBeNull();
  });
  it("a contract ending within 30 days", () => {
    expect(dueWithin("2026-11-01", "2026-10-15", 30)).toBe(true);
    expect(dueWithin("2026-12-01", "2026-10-15", 30)).toBe(false);
    expect(dueWithin("2026-10-01", "2026-10-15", 30)).toBe(false);
    expect(dueWithin(null, "2026-10-15", 30)).toBe(false);
  });
});
