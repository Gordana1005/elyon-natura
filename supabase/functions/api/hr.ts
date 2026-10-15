/**
 * HR — Човечки ресурси, Фаза 1 (owner 15.10.2026; migration 20261016120000_hr_core.sql).
 * The pure half of the /api/hr/* routes: the vocabularies, body validation, who sees which
 * dossier fields, and the shapes. Dependency-free (Deno + Vitest + the browser bundle share it,
 * like shifts.ts). The SQL decides the money-free truths: days, balances, the approval stages.
 *
 * Owner's decisions (15.10.2026):
 *   · every employee (call centre, shops, warehouse, office) — an employee is not a login;
 *   · leave: the team approves first, then a manager (a super admin may decide at any stage);
 *   · the dossier (personal data, contract) only for super_admin / owner / finance — everyone else
 *     gets the employee WITHOUT those keys (absent, never null), the way money keys are stripped.
 */
import { addDaysYmd, isoDow, isUuid, isYmd } from "./shifts.ts";

type Ok<T> = { ok: true } & T;
type Err = { ok: false; error: string };

export const HR_TZ = "Europe/Skopje";

export const LEAVE_TYPES = [
  "annual", "sick", "personal_paid", "unpaid", "maternity", "business_trip", "comp_day", "other",
] as const;
export type LeaveType = typeof LEAVE_TYPES[number];

/** How a type's days count (mirrors hr_leave_types.day_basis). */
export const CALENDAR_DAY_TYPES: readonly LeaveType[] = ["sick", "maternity"];
/** The grid / calendar letter (mirrors hr_leave_types.letter). */
export const LEAVE_LETTER: Record<LeaveType, string> = {
  annual: "О", sick: "Б", personal_paid: "П", unpaid: "Н", maternity: "М", business_trip: "С", comp_day: "К", other: "Д",
};

export const REQUEST_STATUSES = ["pending_team", "pending_manager", "approved", "rejected", "cancelled"] as const;
export type RequestStatus = typeof REQUEST_STATUSES[number];
export const OPEN_STATUSES: readonly RequestStatus[] = ["pending_team", "pending_manager"];

export const WORKPLACES = ["call_centre", "shop", "warehouse", "office", "field"] as const;
export type Workplace = typeof WORKPLACES[number];
export const CONTRACT_TYPES = ["indefinite", "fixed", "part_time", "seasonal", "student", "other"] as const;
export const HR_TEAMS = ["teleshop", "affiliate", "management"] as const;
export const HOLIDAY_CALENDARS = [
  "orthodox", "muslim", "catholic", "jewish", "albanian", "turkish", "roma", "vlach", "serbian", "bosniak",
] as const;
export type HolidayCalendar = typeof HOLIDAY_CALENDARS[number];
export const HOLIDAY_SCOPES = ["all", ...HOLIDAY_CALENDARS] as const;
export type HolidayScope = typeof HOLIDAY_SCOPES[number];

/** Personal paid leave above this many days a year is flagged (ЗРО — up to 7). */
export const PERSONAL_PAID_MAX = 7;
/** The first part of the year's leave: at least this many working days in one go. */
export const FIRST_PART_MIN = 12;
/** The calendar warns when this many people of one team / shop are away on the same day. */
export const MAX_SAME_DAY_HINT = 3;
/** Calendar range limit of /hr/calendar. */
export const MAX_CALENDAR_DAYS = 93;

// ── who sees which fields ────────────────────────────────────────────────────────────────

/** The dossier keys: super_admin / owner / finance only (and the person's own, notes excepted). */
export const DOSSIER_KEYS = [
  "phone", "email", "birth_date", "address", "emergency_contact", "hire_date", "contract_type", "contract_end",
  "probation_end", "prior_service_months", "extra_leave_days", "extra_leave_reason", "left_at", "notes",
] as const;

export type DossierView = "full" | "self" | "none";

/** The employee row as the viewer may see it: "full" = everything, "self" = their own dossier
 *  without HR's notes, "none" = the dossier keys ABSENT. */
export function stripEmployee<T extends Record<string, unknown>>(row: T, view: DossierView): Partial<T> {
  if (view === "full") return { ...row };
  const out: Record<string, unknown> = { ...row };
  if (view === "self") {
    delete out.notes;
    return out as Partial<T>;
  }
  for (const k of DOSSIER_KEYS) delete out[k];
  delete out.updated_by;
  return out as Partial<T>;
}

/** A dept_admin's departments → the HR teams they lead (teleshop ↔ Тим Центар, affiliate ↔ Тим Маџари). */
export function teamsOfDepartments(depts: readonly string[] | null | undefined): string[] {
  const d = new Set(depts ?? []);
  const out: string[] = [];
  if (["teleshop_out", "teleshop_other", "social"].some((k) => d.has(k))) out.push("teleshop");
  if (["altercpa", "elyon_crm"].some((k) => d.has(k))) out.push("affiliate");
  return out;
}

/** Is this employee in a team approver's scope? Their explicit approver, else their team's lead. */
export function inTeamScope(
  e: { approver_id?: string | null; team_key?: string | null; user_id?: string | null },
  viewer: { userId: string; teams: readonly string[] },
): boolean {
  if (e.user_id && e.user_id === viewer.userId) return false;
  if (e.approver_id) return e.approver_id === viewer.userId;
  return !!e.team_key && viewer.teams.includes(e.team_key);
}

// ── days ─────────────────────────────────────────────────────────────────────────────────

export interface HolidayLite { date: string; scope: string }

/** Working days in [from, to] for a person — the browser's preview of hr_working_days(): their ISO
 *  work days minus the holidays that apply to them (scope all or one of their calendars). */
export function workingDays(
  from: string, to: string, workDays: readonly number[], calendars: readonly string[], holidays: readonly HolidayLite[],
): number {
  if (!isYmd(from) || !isYmd(to) || to < from) return 0;
  const off = new Set(holidays.filter((h) => h.scope === "all" || calendars.includes(h.scope)).map((h) => h.date));
  let n = 0;
  for (let d = from; d <= to; d = addDaysYmd(d, 1)) {
    if (workDays.includes(isoDow(d)) && !off.has(d)) n++;
  }
  return n;
}

/** The days a request counts: calendar days for sick / maternity, else working days. */
export function requestDays(
  type: LeaveType, from: string, to: string, workDays: readonly number[], calendars: readonly string[],
  holidays: readonly HolidayLite[],
): number {
  if (!isYmd(from) || !isYmd(to) || to < from) return 0;
  if (CALENDAR_DAY_TYPES.includes(type)) {
    let n = 0;
    for (let d = from; d <= to; d = addDaysYmd(d, 1)) n++;
    return n;
  }
  return workingDays(from, to, workDays, calendars, holidays);
}

/** The most people of one group absent on the same day in [from, to] (the "too many at once" hint). */
export function maxSameDay(
  absences: readonly { employee_id: string; date_from: string; date_to: string }[],
  groupOf: (employeeId: string) => string | null,
  group: string,
  from: string,
  to: string,
): { day: string | null; count: number } {
  let best = { day: null as string | null, count: 0 };
  if (!isYmd(from) || !isYmd(to) || to < from) return best;
  for (let d = from; d <= to; d = addDaysYmd(d, 1)) {
    const who = new Set(absences.filter((a) => a.date_from <= d && a.date_to >= d && groupOf(a.employee_id) === group)
      .map((a) => a.employee_id));
    if (who.size > best.count) best = { day: d, count: who.size };
  }
  return best;
}

// ── bodies ───────────────────────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const optText = (v: unknown, max: number): string | null | undefined => {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s.length > max ? s.slice(0, max) : s;
};

export interface LeaveRequestBody {
  employee_id: string | null;
  type: LeaveType;
  date_from: string;
  date_to: string;
  note: string | null;
  doc_ref: string | null;
  record: boolean;
}

export function parseLeaveRequestBody(raw: unknown): Ok<{ body: LeaveRequestBody }> | Err {
  if (!isObj(raw)) return { ok: false, error: "body must be an object" };
  const type = raw.type;
  if (typeof type !== "string" || !(LEAVE_TYPES as readonly string[]).includes(type)) return { ok: false, error: "unknown type" };
  const from = raw.date_from;
  const to = raw.date_to ?? raw.date_from;
  if (!isYmd(from) || !isYmd(to)) return { ok: false, error: "date_from / date_to must be YYYY-MM-DD" };
  if (to < from) return { ok: false, error: "date_to is before date_from" };
  const emp = raw.employee_id ?? null;
  if (emp !== null && !isUuid(emp)) return { ok: false, error: "employee_id must be a uuid" };
  return {
    ok: true,
    body: {
      employee_id: emp as string | null, type: type as LeaveType, date_from: from, date_to: to as string,
      note: optText(raw.note, 1000) ?? null, doc_ref: optText(raw.doc_ref, 100) ?? null, record: raw.record === true,
    },
  };
}

export function parseDecideBody(raw: unknown): Ok<{ decision: "approve" | "reject"; note: string | null }> | Err {
  if (!isObj(raw)) return { ok: false, error: "body must be an object" };
  if (raw.decision !== "approve" && raw.decision !== "reject") return { ok: false, error: "decision is approve or reject" };
  const note = optText(raw.note, 1000) ?? null;
  if (raw.decision === "reject" && (!note || note.length < 3)) return { ok: false, error: "a rejection needs a note" };
  return { ok: true, decision: raw.decision, note };
}

export function parseNoteBody(raw: unknown): { note: string | null } {
  return { note: isObj(raw) ? optText(raw.note, 1000) ?? null : null };
}

const EMPLOYEE_TEXT: Record<string, number> = {
  full_name: 120, company: 120, shop_name: 120, position: 120, phone: 40, email: 160, address: 300,
  emergency_contact: 200, extra_leave_reason: 300, notes: 2000,
};
const EMPLOYEE_DATES = ["birth_date", "hire_date", "contract_end", "probation_end", "left_at"] as const;

/** The dossier body for POST / PATCH /hr/employees: only known keys, each type-checked. */
export function parseEmployeeBody(raw: unknown, creating: boolean): Ok<{ data: Record<string, unknown> }> | Err {
  if (!isObj(raw)) return { ok: false, error: "body must be an object" };
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k in EMPLOYEE_TEXT) {
      if (v !== null && typeof v !== "string") return { ok: false, error: `${k} must be text` };
      data[k] = v === null ? "" : (v as string).trim().slice(0, EMPLOYEE_TEXT[k]);
    } else if ((EMPLOYEE_DATES as readonly string[]).includes(k)) {
      if (v !== null && v !== "" && !isYmd(v)) return { ok: false, error: `${k} must be YYYY-MM-DD` };
      data[k] = v || null;
    } else if (k === "user_id" || k === "approver_id") {
      if (v !== null && v !== "" && !isUuid(v)) return { ok: false, error: `${k} must be a uuid` };
      data[k] = v || null;
    } else if (k === "status") {
      if (v !== "active" && v !== "left") return { ok: false, error: "status is active or left" };
      data[k] = v;
    } else if (k === "workplace") {
      if (!(WORKPLACES as readonly unknown[]).includes(v)) return { ok: false, error: "unknown workplace" };
      data[k] = v;
    } else if (k === "contract_type") {
      if (v !== null && v !== "" && !(CONTRACT_TYPES as readonly unknown[]).includes(v)) return { ok: false, error: "unknown contract_type" };
      data[k] = v || null;
    } else if (k === "team_key") {
      if (v !== null && v !== "" && !(HR_TEAMS as readonly unknown[]).includes(v)) return { ok: false, error: "unknown team_key" };
      data[k] = v || null;
    } else if (k === "work_days") {
      if (!Array.isArray(v) || v.length === 0 || !v.every((x) => Number.isInteger(x) && x >= 1 && x <= 7)) {
        return { ok: false, error: "work_days are ISO weekdays 1–7" };
      }
      data[k] = [...new Set(v as number[])].sort();
    } else if (k === "holiday_calendars") {
      if (!Array.isArray(v) || !v.every((x) => (HOLIDAY_CALENDARS as readonly unknown[]).includes(x))) {
        return { ok: false, error: "unknown holiday calendar" };
      }
      data[k] = [...new Set(v as string[])].sort();
    } else if (k === "prior_service_months") {
      if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 720) return { ok: false, error: "prior_service_months 0–720" };
      data[k] = v;
    } else if (k === "extra_leave_days") {
      if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 15) return { ok: false, error: "extra_leave_days 0–15" };
      data[k] = v;
    } else {
      return { ok: false, error: `${k} cannot be set` };
    }
  }
  if (creating && !(typeof data.full_name === "string" && data.full_name.length > 0)) return { ok: false, error: "a name is required" };
  if ("full_name" in data && !data.full_name) return { ok: false, error: "a name is required" };
  if (data.status === "left" && !data.left_at && creating) return { ok: false, error: "left_at is required" };
  return { ok: true, data };
}

const dayNum = (v: unknown, max: number): number | null | undefined => {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 0 || n > max || Math.round(n * 2) !== n * 2) return undefined;
  return n;
};

/** PUT /hr/entitlements: base_days null = back to the default; halves allowed. */
export function parseEntitlementBody(raw: unknown):
  Ok<{ employee_id: string; year: number; base_days: number | null; extra_days: number; carry_days: number; note: string | null }> | Err {
  if (!isObj(raw)) return { ok: false, error: "body must be an object" };
  if (!isUuid(raw.employee_id)) return { ok: false, error: "employee_id must be a uuid" };
  const year = Number(raw.year);
  if (!Number.isInteger(year) || year < 2020 || year > 2100) return { ok: false, error: "bad year" };
  const base = dayNum(raw.base_days, 60);
  const extra = dayNum(raw.extra_days ?? 0, 30);
  const carry = dayNum(raw.carry_days ?? 0, 60);
  if (base === undefined || extra === undefined || extra === null || carry === undefined || carry === null) {
    return { ok: false, error: "days are 0–60 in halves" };
  }
  return { ok: true, employee_id: raw.employee_id, year, base_days: base, extra_days: extra, carry_days: carry,
           note: optText(raw.note, 300) ?? null };
}

export function parseHolidayBody(raw: unknown):
  Ok<{ date: string; name: string; scope: HolidayScope; moved_from: string | null; verified: boolean; note: string | null }> | Err {
  if (!isObj(raw)) return { ok: false, error: "body must be an object" };
  if (!isYmd(raw.date)) return { ok: false, error: "date must be YYYY-MM-DD" };
  const name = optText(raw.name, 120);
  if (!name) return { ok: false, error: "a name is required" };
  const scope = raw.scope ?? "all";
  if (!(HOLIDAY_SCOPES as readonly unknown[]).includes(scope)) return { ok: false, error: "unknown scope" };
  const moved = raw.moved_from ?? null;
  if (moved !== null && moved !== "" && !isYmd(moved)) return { ok: false, error: "moved_from must be YYYY-MM-DD" };
  return { ok: true, date: raw.date, name, scope: scope as HolidayScope, moved_from: (moved || null) as string | null,
           verified: raw.verified !== false, note: optText(raw.note, 300) ?? null };
}

export function parseYear(v: string | null, today: string): number {
  const n = Number(v);
  return Number.isInteger(n) && n >= 2020 && n <= 2100 ? n : Number(today.slice(0, 4));
}

/** The SQL writers raise their own messages ("hr_x: why"); map them to the api's answer. */
export function rpcErrorStatus(error: { code?: string; message?: string } | null | undefined): { status: number; error: string } {
  const code = String(error?.code ?? "");
  const why = String(error?.message ?? "").replace(/^[a-z_]+:\s*/i, "");
  if (code === "22023") return { status: 400, error: `hr.invalid: ${why}` };
  if (code === "22P02" || code === "22007" || code === "22008") return { status: 400, error: "hr.invalid: bad value" };
  if (code === "23505") return { status: 409, error: `hr.conflict: ${why}` };
  if (code === "23514") return { status: 400, error: "hr.invalid: value out of range" };
  if (code === "42501") return { status: 403, error: `hr.forbidden: ${why}` };
  if (code === "P0002") return { status: 404, error: "hr.not_found" };
  return { status: 400, error: "hr.failed" };
}

// ── shapes the UI reads ──────────────────────────────────────────────────────────────────

export interface HrEmployee {
  id: string;
  user_id: string | null;
  full_name: string;
  status: "active" | "left";
  company: string | null;
  workplace: Workplace;
  shop_name: string | null;
  position: string | null;
  team_key: string | null;
  approver_id: string | null;
  work_days: number[];
  holiday_calendars: string[];
  // dossier — present only for super_admin / owner / finance (and one's own)
  phone?: string | null;
  email?: string | null;
  birth_date?: string | null;
  address?: string | null;
  emergency_contact?: string | null;
  hire_date?: string | null;
  contract_type?: string | null;
  contract_end?: string | null;
  probation_end?: string | null;
  prior_service_months?: number;
  extra_leave_days?: number;
  extra_leave_reason?: string | null;
  left_at?: string | null;
  notes?: string | null;
}

export interface HrRequest {
  id: string;
  employee_id: string;
  employee_name: string;
  employee_user_id: string | null;
  type: LeaveType;
  date_from: string;
  date_to: string;
  days: number;
  status: RequestStatus;
  note: string | null;
  doc_ref: string | null;
  requested_by: string | null;
  requested_by_name?: string | null;
  requested_at: string;
  team_by: string | null;
  team_by_name?: string | null;
  team_at: string | null;
  team_note: string | null;
  decided_by: string | null;
  decided_by_name?: string | null;
  decided_at: string | null;
  decision_note: string | null;
  cancelled_by: string | null;
  cancelled_at: string | null;
  cancel_note: string | null;
  removed_shifts_count?: number;
  /** May the viewer approve / reject it now? */
  can_decide?: boolean;
  /** May the viewer cancel it? */
  can_cancel?: boolean;
}

export interface HrBalance {
  employee_id: string;
  year: number;
  today: string;
  source: "set" | "default";
  note: string | null;
  base_days: number;
  extra_days: number;
  carry_days: number;
  carry_until: string;
  carry_available: number;
  carry_expiring: number;
  carry_lost: number;
  entitled: number;
  taken: number;
  used: number;
  planned: number;
  pending: number;
  remaining: number;
  remaining_year: number;
  longest_block: number;
  first_part_ok: boolean;
  personal_paid_days: number;
  personal_paid_over: boolean;
  unpaid_days: number;
  sick_employer_days: number;
  sick_fzom_days: number;
}

export interface HrHoliday {
  id: string;
  date: string;
  name: string;
  scope: HolidayScope;
  moved_from: string | null;
  verified: boolean;
  note?: string | null;
}

export interface HrAbsence {
  id: string;
  employee_id: string;
  type: LeaveType;
  status: RequestStatus;
  date_from: string;
  date_to: string;
  days: number;
}

export interface HrCalendar {
  from: string;
  to: string;
  today: string;
  employees: (Pick<HrEmployee, "id" | "user_id" | "team_key" | "workplace" | "shop_name" | "position" | "work_days" | "holiday_calendars"> & { name: string })[];
  absences: HrAbsence[];
  holidays: HrHoliday[];
}

export interface HrAccess {
  /** The dossier: super_admin / owner / finance. */
  full: boolean;
  /** Decides at the manager step; sees and records everyone's absences. */
  final: boolean;
  /** Leads a team (dept_admin) or is someone's explicit approver. */
  team: boolean;
  /** Sees everyone (full or final). */
  seeAll: boolean;
  /** Has a dossier row of their own (may request leave). */
  hasSelf: boolean;
}

export interface HrMe {
  access: HrAccess;
  employee: HrEmployee | null;
  balance: HrBalance | null;
  requests: HrRequest[];
  holidays: HrHoliday[];
  year: number;
  today: string;
}

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** The SQL balance (numerics arrive as numbers or strings) → numbers. */
export function shapeBalance(raw: unknown): HrBalance | null {
  if (!isObj(raw)) return null;
  const r = raw as Record<string, unknown>;
  const keys = ["base_days", "extra_days", "carry_days", "carry_available", "carry_expiring", "carry_lost", "entitled",
    "taken", "used", "planned", "pending", "remaining", "remaining_year", "longest_block", "personal_paid_days",
    "unpaid_days", "sick_employer_days", "sick_fzom_days"];
  const out: Record<string, unknown> = { ...r };
  for (const k of keys) out[k] = num(r[k]);
  out.year = num(r.year);
  out.first_part_ok = r.first_part_ok === true;
  out.personal_paid_over = r.personal_paid_over === true;
  out.source = r.source === "set" ? "set" : "default";
  return out as unknown as HrBalance;
}

/** The request as the viewer may act on it. */
export function decorateRequest(
  r: HrRequest,
  viewer: { userId: string; final: boolean; superAdmin: boolean; teamScope: boolean; today: string },
): HrRequest {
  const own = r.employee_user_id === viewer.userId || r.requested_by === viewer.userId;
  const ownEmployee = r.employee_user_id === viewer.userId;
  const open = (OPEN_STATUSES as readonly string[]).includes(r.status);
  const canDecide = open && (!ownEmployee || viewer.superAdmin)
    && (viewer.final || (viewer.teamScope && r.status === "pending_team"));
  const canCancel = (r.status !== "rejected" && r.status !== "cancelled")
    && (viewer.final || (own && (open || r.date_from > viewer.today)));
  return { ...r, days: num(r.days), can_decide: canDecide, can_cancel: canCancel };
}

/** Is the dossier date within `days` from today (contract end, probation end)? */
export function dueWithin(date: string | null | undefined, today: string, days: number): boolean {
  if (!isYmd(date)) return false;
  return date >= today && date <= addDaysYmd(today, days);
}
