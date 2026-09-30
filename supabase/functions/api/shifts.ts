// ============================================================================
// Смени — the one "Shifts" page (plan Фаза 8, owner 30.09.2026): the pure half of
//   GET  /api/shifts/grid            public.shifts_grid()          (…001100)
//   POST /api/shifts/cells           public.shifts_set_cells()     (…001100)
//   POST /api/shifts/copy            public.shifts_copy_range()    (…001100)
//   POST /api/shifts/roll-month      public.shifts_roll_forward()  (…000100 / …001000)
//   GET  /api/shifts/runway          public.shifts_runway()        (…000100)
//   GET  /api/shifts/my?from&to      the agent's own days
//   GET  /api/shifts/check-login     the LOGIN GATE (kept exactly; owner 30.09)
//   GET  /api/shifts/statistics      public.shifts_statistics()    (…001100)
//   GET  /api/shifts/login-activity  public.shifts_login_activity() (…001100)
//
// Dependency-free on purpose (no Deno globals, no URL imports): vitest runs
// shifts.test.ts against this file in Node, index.ts imports it, and the page
// (src/components/shifts/*) imports the same cell / runway helpers, so the
// grid's staging and the server's validation can never disagree.
// ============================================================================

export const SHIFTS_TZ = "Europe/Skopje";
/** POST /shifts/login-log ignores a second log within this window (old bundles log after check-login already did). */
export const LOGIN_LOG_DEDUPE_MS = 2 * 60_000;
/** The runway warning: nobody may be ≤ this many days from their last shift (owner: 5). */
export const RUNWAY_WARN_DAYS = 5;
export const MAX_GRID_DAYS = 63;
export const MAX_CELLS = 3000;
export const MAX_STATS_DAYS = 401;

type Ok<T> = { ok: true } & T;
type Err = { ok: false; error: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown): string | null => (v == null || v === "" ? null : String(v));

export const isUuid = (s: unknown): s is string => typeof s === "string" && UUID_RE.test(s);

/** A real YYYY-MM-DD day. */
export function isYmd(s: unknown): s is string {
  if (typeof s !== "string" || !YMD_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** "HH:MM" (00:00 … 23:59). */
export const isHm = (s: unknown): s is string => typeof s === "string" && HM_RE.test(s);

/** A DB time ("07:00:00") as the gate compares it: "07:00". */
export const hm = (t: string | null | undefined): string => (t ?? "").slice(0, 5);

/** 00:00–00:00 is the "no active shift" marker. */
export const isZeroWindow = (start: string | null | undefined, end: string | null | undefined): boolean =>
  hm(start) === "00:00" && hm(end) === "00:00";

/** Calendar arithmetic on a YYYY-MM-DD (no timezone can shift it). */
export function addDaysYmd(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** ISO weekday of a YYYY-MM-DD: 1 = Monday … 7 = Sunday. */
export function isoDow(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow === 0 ? 7 : dow;
}

/** The Monday of the week `day` falls in. */
export const mondayOfYmd = (day: string): string => addDaysYmd(day, 1 - isoDow(day));

/** First and last day of the month `day` falls in. */
export function monthBounds(day: string): { from: string; to: string } {
  const from = `${day.slice(0, 7)}-01`;
  const [y, m] = day.split("-").map(Number);
  const to = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return { from, to };
}

/** Today and now on the Skopje clock, as the gate reads them ("HH:MM"; the 24:xx that
 *  hour12:false can emit at midnight is read as 00:xx). */
export function skopjeNow(now: Date = new Date()): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: SHIFTS_TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(now);
  const g = (t: string) => parts.find((p) => p.type === t)?.value || "";
  let time = `${g("hour")}:${g("minute")}`;
  if (time.startsWith("24:")) time = `00:${time.slice(3)}`;
  return { date: `${g("year")}-${g("month")}-${g("day")}`, time };
}

// ── the login gate (unchanged rule; owner kept it 30.09) ───────────────────────────────────

export type GateShift = { id: string; date: string; start_time: string; end_time: string };
export const REFUSAL_CODES = ["no_assignment", "no_shift_today", "zero_shift", "outside_hours"] as const;
export type RefusalCode = typeof REFUSAL_CODES[number];

export type GateDecision =
  | { allowed: true; shift: GateShift; start: string; end: string }
  | {
    allowed: false;
    code: RefusalCode;
    /** Today's real windows, "HH:MM - HH:MM" (outside_hours only). */
    windows: string[];
    /** The blocked_login_attempts.reason text (kept in its old English form — the
     *  login-activity RPC reads the code back out of it). */
    reason: string;
    /** The old English message, for browser bundles that do not know `code` yet. */
    message: string;
  };

/**
 * The gate, exactly as GET /shifts/check-login has always decided it: today's (Skopje) shifts,
 * 00:00–00:00 skipped, the FIRST shift whose window covers `nowTime` ("HH:MM", inclusive at both
 * ends, a plain text compare) lets the person in. No shift today → no_assignment when the person
 * has never had one, else no_shift_today; only 00:00–00:00 rows → zero_shift; else outside_hours.
 */
export function decideGate(todayShifts: GateShift[], nowTime: string, hasAnyAssignment: boolean): GateDecision {
  if (todayShifts.length === 0) {
    return hasAnyAssignment
      ? { allowed: false, code: "no_shift_today", windows: [], reason: "No shift scheduled for today",
          message: "Login not allowed. You have no shift scheduled for today." }
      : { allowed: false, code: "no_assignment", windows: [], reason: "No active shift assignment",
          message: "Login not allowed. You currently have no active shift." };
  }
  for (const shift of todayShifts) {
    const start = hm(shift.start_time);
    const end = hm(shift.end_time);
    if (start === "00:00" && end === "00:00") continue;
    if (nowTime >= start && nowTime <= end) return { allowed: true, shift, start, end };
  }
  if (todayShifts.every((s) => isZeroWindow(s.start_time, s.end_time))) {
    return { allowed: false, code: "zero_shift", windows: [], reason: "Shift set to 00:00-00:00 (no active shift)",
             message: "Login not allowed. You currently have no active shift." };
  }
  const windows = todayShifts
    .filter((s) => !isZeroWindow(s.start_time, s.end_time))
    .map((s) => `${hm(s.start_time)} - ${hm(s.end_time)}`);
  const shiftTimes = windows.join(", ");
  return {
    allowed: false, code: "outside_hours", windows,
    reason: `Outside shift hours (${shiftTimes})`,
    message: `Login not allowed. Your shift hours are: ${shiftTimes}. Current time is outside this window.`,
  };
}

/** True when a login was already logged in the last LOGIN_LOG_DEDUPE_MS (check-login logs it now;
 *  an old browser bundle still POSTs /shifts/login-log right after). */
export function isRecentLogin(lastLoginIso: string | null | undefined, nowMs: number, windowMs = LOGIN_LOG_DEDUPE_MS): boolean {
  if (!lastLoginIso) return false;
  const t = Date.parse(lastLoginIso);
  return Number.isFinite(t) && nowMs - t >= 0 && nowMs - t < windowMs;
}

// ── cells: the grid's unit ─────────────────────────────────────────────────────────────────

/** A person-day as the grid reads it (GET /shifts/grid). */
export interface GridCell {
  user_id: string;
  date: string;
  shift_id: string;
  start: string;
  end: string;
  name: string;
  template_id: string | null;
}

/** What the grid paints onto a person-day before it is saved. */
export type StagedCell =
  | { kind: "off" }
  | { kind: "template"; template_id: string; start: string; end: string; name: string }
  | { kind: "window"; start: string; end: string; name?: string | null };

/** POST /shifts/cells — one of off | shift_id | template_id | start+end per person-day. */
export interface ShiftCellInput {
  user_id: string;
  date: string;
  off?: true;
  shift_id?: string;
  template_id?: string;
  start?: string;
  end?: string;
  name?: string;
}

export const cellKey = (userId: string, date: string): string => `${userId}|${date}`;

/** Does painting `staged` onto `orig` change anything? (The gate reads the window; a template
 *  brush also links the row to its template, so a template onto an unlinked row is a change.) */
export function sameValue(orig: GridCell | undefined | null, staged: StagedCell): boolean {
  if (staged.kind === "off") return !orig;
  if (!orig) return false;
  if (staged.kind === "template") {
    return orig.template_id === staged.template_id && orig.start === staged.start && orig.end === staged.end;
  }
  return orig.start === staged.start && orig.end === staged.end;
}

/** A staged value as the POST body writes it. */
export function toCellInput(userId: string, date: string, staged: StagedCell): ShiftCellInput {
  if (staged.kind === "off") return { user_id: userId, date, off: true };
  if (staged.kind === "template") return { user_id: userId, date, template_id: staged.template_id };
  const out: ShiftCellInput = { user_id: userId, date, start: staged.start, end: staged.end };
  const name = (staged.name ?? "").trim();
  if (name) out.name = name;
  return out;
}

/**
 * The save payload: every staged person-day that differs from what is stored, as POST
 * /shifts/cells cells, sorted by person then day. A cell painted back to its stored value
 * (or erased where there was nothing) drops out, so [Зачувај (N)] counts real changes only.
 */
export function diffCells(
  original: ReadonlyMap<string, GridCell>,
  staged: ReadonlyMap<string, StagedCell>,
): ShiftCellInput[] {
  const out: ShiftCellInput[] = [];
  for (const [key, value] of staged) {
    const sep = key.indexOf("|");
    const userId = key.slice(0, sep);
    const date = key.slice(sep + 1);
    if (sameValue(original.get(key), value)) continue;
    out.push(toCellInput(userId, date, value));
  }
  return out.sort((a, b) => (a.user_id === b.user_id ? a.date.localeCompare(b.date) : a.user_id.localeCompare(b.user_id)));
}

/** A server cell (the copy preview / an undo list) back into a staged value the grid can show.
 *  A shift_id cell reverts to that row's window; null when it cannot be shown (unknown template). */
export function stagedFromInput(
  cell: ShiftCellInput,
  templates: ReadonlyArray<{ id: string; name: string; start: string; end: string }>,
): StagedCell | null {
  if (cell.off) return { kind: "off" };
  if (cell.template_id) {
    const t = templates.find((x) => x.id === cell.template_id);
    return t ? { kind: "template", template_id: t.id, start: t.start, end: t.end, name: t.name } : null;
  }
  if (cell.start && cell.end) return { kind: "window", start: cell.start, end: cell.end, name: cell.name ?? null };
  return null;
}

/** Validates POST /shifts/cells. Duplicates of one person-day: the last one wins. */
export function normaliseCellsBody(body: unknown): Ok<{ cells: ShiftCellInput[] }> | Err {
  if (!isObj(body) || !Array.isArray(body.cells)) return { ok: false, error: "cells must be an array" };
  if (body.cells.length === 0) return { ok: false, error: "no cells" };
  if (body.cells.length > MAX_CELLS) return { ok: false, error: `at most ${MAX_CELLS} cells per save` };
  const byKey = new Map<string, ShiftCellInput>();
  for (const raw of body.cells) {
    if (!isObj(raw)) return { ok: false, error: "a cell must be an object" };
    const userId = raw.user_id;
    const date = raw.date;
    if (!isUuid(userId)) return { ok: false, error: "invalid user_id" };
    if (!isYmd(date)) return { ok: false, error: "invalid date" };
    const kinds = [raw.off === true, raw.shift_id != null, raw.template_id != null, raw.start != null || raw.end != null]
      .filter(Boolean).length;
    if (kinds !== 1) return { ok: false, error: "a cell needs exactly one of off, shift_id, template_id or start + end" };
    let cell: ShiftCellInput;
    if (raw.off === true) cell = { user_id: userId, date, off: true };
    else if (raw.shift_id != null) {
      if (!isUuid(raw.shift_id)) return { ok: false, error: "invalid shift_id" };
      cell = { user_id: userId, date, shift_id: raw.shift_id };
    } else if (raw.template_id != null) {
      if (!isUuid(raw.template_id)) return { ok: false, error: "invalid template_id" };
      cell = { user_id: userId, date, template_id: raw.template_id };
    } else {
      if (!isHm(raw.start) || !isHm(raw.end)) return { ok: false, error: "start and end must be HH:MM" };
      if (!(raw.end > raw.start)) return { ok: false, error: "end must be after start" };
      cell = { user_id: userId, date, start: raw.start, end: raw.end };
      if (raw.name != null) {
        const name = String(raw.name).trim();
        if (name.length > 60) return { ok: false, error: "name is at most 60 characters" };
        if (name) cell.name = name;
      }
    }
    byKey.set(cellKey(userId, date), cell);
  }
  return { ok: true, cells: [...byKey.values()] };
}

// ── ranges and bodies ──────────────────────────────────────────────────────────────────────

/** from/to query params (YYYY-MM-DD, inclusive), defaulting both, at most `maxDays`. */
export function parseRange(
  from: string | null, to: string | null, fallback: { from: string; to: string }, maxDays: number,
): Ok<{ from: string; to: string }> | Err {
  const f = from ?? fallback.from;
  const t = to ?? fallback.to;
  if (!isYmd(f) || !isYmd(t)) return { ok: false, error: "from / to must be YYYY-MM-DD" };
  if (t < f) return { ok: false, error: "to is before from" };
  if (daysBetween(f, t) + 1 > maxDays) return { ok: false, error: `at most ${maxDays} days` };
  return { ok: true, from: f, to: t };
}

export const COPY_MODES = ["fill_empty", "overwrite"] as const;
export type CopyMode = typeof COPY_MODES[number];

/** POST /shifts/copy {src_from, src_to, dst_from, mode?, apply?}. */
export function parseCopyBody(body: unknown): Ok<{ src_from: string; src_to: string; dst_from: string; mode: CopyMode; apply: boolean }> | Err {
  if (!isObj(body)) return { ok: false, error: "body must be an object" };
  const { src_from, src_to, dst_from } = body;
  if (!isYmd(src_from) || !isYmd(src_to) || !isYmd(dst_from)) return { ok: false, error: "src_from, src_to and dst_from must be YYYY-MM-DD" };
  if (src_to < src_from) return { ok: false, error: "src_to is before src_from" };
  if (daysBetween(src_from, src_to) + 1 > MAX_GRID_DAYS) return { ok: false, error: `at most ${MAX_GRID_DAYS} days` };
  const dstTo = addDaysYmd(dst_from, daysBetween(src_from, src_to));
  if (!(dst_from > src_to || dstTo < src_from)) return { ok: false, error: "the source and destination overlap" };
  const mode = (body.mode ?? "fill_empty") as CopyMode;
  if (!(COPY_MODES as readonly string[]).includes(mode)) return { ok: false, error: "mode is fill_empty or overwrite" };
  return { ok: true, src_from, src_to, dst_from, mode, apply: body.apply === true };
}

/**
 * POST /shifts/roll-month. Default: this Skopje month → the next one (on 30.09 that is
 * September → October; on 01.10 October → November). Any of the four days may be given.
 */
export function parseRollMonthBody(body: unknown, today: string):
  Ok<{ src_from: string; src_to: string; dst_from: string; dst_to: string; apply: boolean; user_ids: string[] | null }> | Err {
  const b = isObj(body) ? body : {};
  const cur = monthBounds(today);
  const next = monthBounds(addDaysYmd(cur.to, 1));
  const src_from = b.src_from ?? cur.from;
  const src_to = b.src_to ?? cur.to;
  const dst_from = b.dst_from ?? next.from;
  const dst_to = b.dst_to ?? next.to;
  for (const d of [src_from, src_to, dst_from, dst_to]) if (!isYmd(d)) return { ok: false, error: "dates must be YYYY-MM-DD" };
  const sf = src_from as string, st = src_to as string, df = dst_from as string, dt = dst_to as string;
  if (st < sf || dt < df) return { ok: false, error: "a range ends before it starts" };
  if (daysBetween(df, dt) > 62) return { ok: false, error: "destination longer than 62 days" };
  if (daysBetween(sf, st) > 62) return { ok: false, error: "source longer than 62 days" };
  let userIds: string[] | null = null;
  if (b.user_ids != null) {
    if (!Array.isArray(b.user_ids) || !b.user_ids.every(isUuid)) return { ok: false, error: "user_ids must be uuids" };
    userIds = b.user_ids.length ? [...new Set(b.user_ids as string[])] : null;
  }
  return { ok: true, src_from: sf, src_to: st, dst_from: df, dst_to: dt, apply: b.apply === true, user_ids: userIds };
}

// ── runway ─────────────────────────────────────────────────────────────────────────────────

export interface RunwayPerson { user_id: string; name: string; last_date: string | null }
export interface RunwaySummary {
  level: "ok" | "warn" | "critical";
  today: string;
  warn_days: number;
  /** Gated agents who worked in the last 14 days. */
  agents: number;
  /** The last day with a shift for the first person to run out (level ok: the earliest last day of anyone). */
  ends_on: string | null;
  /** The first day someone cannot log in (warn/critical); null when ok. */
  blocked_from: string | null;
  /** Days from today to blocked_from (0 = already today). */
  days_left: number | null;
  /** How many run out within warn_days. */
  count: number;
  people: RunwayPerson[];
}

/**
 * shifts_runway() → the manager banner: "Смените завршуваат на {ends_on} — за {days_left} дена
 * {count} агенти нема да можат да се најават". critical when someone is locked out today or
 * tomorrow, warn inside the warn window, ok otherwise.
 */
export function runwaySummary(rpc: unknown): RunwaySummary {
  const r = isObj(rpc) ? rpc : {};
  const today = isYmd(r.today) ? r.today : "";
  const warn = num(r.warn_days) || RUNWAY_WARN_DAYS;
  const people: RunwayPerson[] = (Array.isArray(r.running_out) ? r.running_out : [])
    .filter(isObj)
    .map((p) => ({ user_id: String(p.user_id ?? ""), name: String(p.name ?? ""), last_date: isYmd(p.last_date) ? p.last_date : null }));
  const agents = num(r.agents);
  if (people.length === 0) {
    return { level: "ok", today, warn_days: warn, agents, ends_on: isYmd(r.min_last_date) ? r.min_last_date : null,
             blocked_from: null, days_left: null, count: 0, people };
  }
  const known = people.map((p) => p.last_date).filter((d): d is string => !!d).sort();
  const hasNone = people.some((p) => !p.last_date);
  const endsOn = hasNone ? null : known[0] ?? null;
  let blockedFrom = endsOn ? addDaysYmd(endsOn, 1) : today;
  if (today && blockedFrom < today) blockedFrom = today;
  const daysLeft = today ? Math.max(0, daysBetween(today, blockedFrom)) : null;
  return {
    level: daysLeft != null && daysLeft <= 1 ? "critical" : "warn",
    today, warn_days: warn, agents, ends_on: endsOn, blocked_from: blockedFrom, days_left: daysLeft,
    count: people.length, people,
  };
}

/**
 * The agent's own banner: "Немате смена од DD.MM — нема да можете да се најавите" when their
 * last shift on or after today is less than `warnDays` days ahead (the same rule as
 * shifts_runway). `dates` = the days they have a real (not 00:00–00:00) shift.
 */
export function agentRunway(dates: readonly string[], today: string, warnDays = RUNWAY_WARN_DAYS):
  { show: boolean; from: string | null; last: string | null } {
  const ahead = dates.filter((d) => isYmd(d) && d >= today).sort();
  const last = ahead.length ? ahead[ahead.length - 1] : null;
  if (!last) return { show: true, from: today, last: null };
  if (last < addDaysYmd(today, warnDays)) return { show: true, from: addDaysYmd(last, 1), last };
  return { show: false, from: null, last };
}

// ── response shapes (a whitelist: a key added to an RPC later never leaks out) ─────────────

export interface GridPerson {
  user_id: string; name: string; roles: string[]; gated: boolean; team_key: string | null; team_name: string | null;
}
export interface GridTemplate { id: string; name: string; start: string; end: string }
export interface GridWindow { start: string; end: string; name: string | null; count: number }
export interface ShiftsGrid {
  from: string; to: string; today: string;
  people: GridPerson[]; cells: GridCell[]; templates: GridTemplate[]; windows: GridWindow[];
}

export function shapeGrid(rpc: unknown): ShiftsGrid {
  const r = isObj(rpc) ? rpc : {};
  const arr = (v: unknown) => (Array.isArray(v) ? v.filter(isObj) : []);
  return {
    from: String(r.from ?? ""), to: String(r.to ?? ""), today: String(r.today ?? ""),
    people: arr(r.people).map((p) => ({
      user_id: String(p.user_id), name: String(p.name ?? ""),
      roles: Array.isArray(p.roles) ? p.roles.map(String) : [],
      gated: p.gated !== false, team_key: str(p.team_key), team_name: str(p.team_name),
    })),
    cells: arr(r.cells).map((c) => ({
      user_id: String(c.user_id), date: String(c.date), shift_id: String(c.shift_id),
      start: hm(String(c.start ?? "")), end: hm(String(c.end ?? "")), name: String(c.name ?? ""),
      template_id: str(c.template_id),
    })),
    templates: arr(r.templates).map((t) => ({
      id: String(t.id), name: String(t.name ?? ""), start: hm(String(t.start ?? "")), end: hm(String(t.end ?? "")),
    })),
    windows: arr(r.windows).map((w) => ({
      start: hm(String(w.start ?? "")), end: hm(String(w.end ?? "")), name: str(w.name), count: num(w.count),
    })),
  };
}

export const ACTIVITY_STATUSES = ["on_time", "late", "early", "blocked"] as const;
export type ActivityStatus = typeof ACTIVITY_STATUSES[number];

export function parseActivityQuery(sp: URLSearchParams, today: string):
  Ok<{ from: string; to: string; user_id: string | null; status: ActivityStatus | null; limit: number; offset: number }> | Err {
  const range = parseRange(sp.get("from"), sp.get("to"), { from: monthBounds(today).from, to: today }, MAX_STATS_DAYS);
  if (!range.ok) return range;
  const agent = sp.get("agent_id");
  const userId = agent && agent !== "all" ? agent : null;
  if (userId && !isUuid(userId)) return { ok: false, error: "invalid agent_id" };
  const rawStatus = sp.get("status");
  const status = rawStatus && rawStatus !== "all" ? rawStatus : null;
  if (status && !(ACTIVITY_STATUSES as readonly string[]).includes(status)) return { ok: false, error: "invalid status" };
  const limit = Math.min(200, Math.max(1, Math.trunc(num(sp.get("limit") ?? 50)) || 50));
  const offset = Math.max(0, Math.trunc(num(sp.get("offset") ?? 0)));
  return { ok: true, from: range.from, to: range.to, user_id: userId, status: status as ActivityStatus | null, limit, offset };
}

export interface ActivityRow {
  id: string; kind: "login" | "blocked"; user_id: string; user_name: string; role: string | null;
  date: string; at: string; shift_start: string | null; shift_end: string | null;
  login_local: string | null; logout_local: string | null; logout_time: string | null;
  minutes: number | null; status: ActivityStatus;
  reason_code: RefusalCode | "other" | null; reason_detail: string | null;
}
export interface ActivitySummary {
  user_id: string; user_name: string; logins: number; days: number;
  on_time: number; late: number; early: number; blocked: number;
}
export interface LoginActivity {
  from: string; to: string; total: number; limit: number; offset: number;
  counts: Record<ActivityStatus, number>;
  rows: ActivityRow[];
  summary: ActivitySummary[];
}

export function shapeLoginActivity(rpc: unknown): LoginActivity {
  const r = isObj(rpc) ? rpc : {};
  const counts = isObj(r.counts) ? r.counts : {};
  const arr = (v: unknown) => (Array.isArray(v) ? v.filter(isObj) : []);
  const status = (v: unknown): ActivityStatus =>
    (ACTIVITY_STATUSES as readonly string[]).includes(String(v)) ? (v as ActivityStatus) : "on_time";
  const code = (v: unknown): ActivityRow["reason_code"] =>
    v == null ? null : ([...REFUSAL_CODES, "other"] as string[]).includes(String(v)) ? (v as ActivityRow["reason_code"]) : "other";
  return {
    from: String(r.from ?? ""), to: String(r.to ?? ""), total: num(r.total), limit: num(r.limit), offset: num(r.offset),
    counts: { on_time: num(counts.on_time), late: num(counts.late), early: num(counts.early), blocked: num(counts.blocked) },
    rows: arr(r.rows).map((x) => ({
      id: String(x.id), kind: x.kind === "blocked" ? "blocked" : "login", user_id: String(x.user_id),
      user_name: String(x.user_name ?? ""), role: str(x.role), date: String(x.date ?? ""), at: String(x.at ?? ""),
      shift_start: str(x.shift_start), shift_end: str(x.shift_end),
      login_local: str(x.login_local), logout_local: str(x.logout_local), logout_time: str(x.logout_time),
      minutes: x.minutes == null ? null : num(x.minutes), status: status(x.status),
      reason_code: code(x.reason_code), reason_detail: str(x.reason_detail),
    })),
    summary: arr(r.summary).map((s) => ({
      user_id: String(s.user_id), user_name: String(s.user_name ?? ""), logins: num(s.logins), days: num(s.days),
      on_time: num(s.on_time), late: num(s.late), early: num(s.early), blocked: num(s.blocked),
    })),
  };
}

export interface StatsRow {
  user_id: string; full_name: string;
  total_worked_days: number; total_weekend_days: number;
  total_hours_scheduled: number; total_hours_actual: number;
  total_shifts: number; average_hours_per_shift: number;
  weekday_shifts: number; weekend_shifts: number;
  days_logged_in: number; late_days: number; blocked_attempts: number;
}
export interface ShiftStatistics {
  from: string; to: string; rows: StatsRow[];
  totals: { people: number; scheduled_hours: number; actual_hours: number; shifts: number; weekday_shifts: number;
            weekend_shifts: number; days_logged_in: number; late_days: number; blocked_attempts: number };
}

export function shapeStatistics(rpc: unknown): ShiftStatistics {
  const r = isObj(rpc) ? rpc : {};
  const t = isObj(r.totals) ? r.totals : {};
  const rows = (Array.isArray(r.rows) ? r.rows.filter(isObj) : []).map((x) => ({
    user_id: String(x.user_id), full_name: String(x.full_name ?? ""),
    total_worked_days: num(x.total_worked_days), total_weekend_days: num(x.total_weekend_days),
    total_hours_scheduled: num(x.total_hours_scheduled), total_hours_actual: num(x.total_hours_actual),
    total_shifts: num(x.total_shifts), average_hours_per_shift: num(x.average_hours_per_shift),
    weekday_shifts: num(x.weekday_shifts), weekend_shifts: num(x.weekend_shifts),
    days_logged_in: num(x.days_logged_in), late_days: num(x.late_days), blocked_attempts: num(x.blocked_attempts),
  }));
  return {
    from: String(r.from ?? ""), to: String(r.to ?? ""), rows,
    totals: {
      people: num(t.people), scheduled_hours: num(t.scheduled_hours), actual_hours: num(t.actual_hours),
      shifts: num(t.shifts), weekday_shifts: num(t.weekday_shifts), weekend_shifts: num(t.weekend_shifts),
      days_logged_in: num(t.days_logged_in), late_days: num(t.late_days), blocked_attempts: num(t.blocked_attempts),
    },
  };
}

// ── the agent's own days (GET /shifts/my) ──────────────────────────────────────────────────

export interface MyShiftDay {
  id: string; name: string; date: string; start_time: string; end_time: string; template_id: string | null;
  clock_in_time: string | null;
  breaks: { id: string; break_start: string; break_end: string | null }[];
  total_break_seconds: number;
  on_break: boolean;
}

/**
 * One entry per scheduled day. Clock-in = the earliest shift_login_logs row of that Skopje day and
 * the breaks = shift_breaks of that day — both by DATE, so a login stays attached when a shift row
 * is replaced (20260943001000 re-points assignments; login logs keep their own shift_id).
 */
export function shapeMyShifts(
  assignments: ReadonlyArray<{ shift_date?: string | null; shifts?: Record<string, unknown> | null }>,
  logins: ReadonlyArray<{ shift_date: string; login_time: string }>,
  breaks: ReadonlyArray<{ id: string; shift_date: string; break_start: string; break_end: string | null }>,
  nowMs: number,
): MyShiftDay[] {
  const clockIn = new Map<string, string>();
  for (const l of logins) {
    const prev = clockIn.get(l.shift_date);
    if (!prev || Date.parse(l.login_time) < Date.parse(prev)) clockIn.set(l.shift_date, l.login_time);
  }
  const byDay = new Map<string, { id: string; break_start: string; break_end: string | null }[]>();
  for (const b of breaks) {
    const list = byDay.get(b.shift_date) ?? [];
    list.push({ id: b.id, break_start: b.break_start, break_end: b.break_end });
    byDay.set(b.shift_date, list);
  }
  const out: MyShiftDay[] = [];
  for (const a of assignments) {
    const s = a.shifts;
    if (!s) continue;
    const date = String(s.date ?? a.shift_date ?? "");
    const dayBreaks = (byDay.get(date) ?? []).sort((x, y) => x.break_start.localeCompare(y.break_start));
    const totalMs = dayBreaks.reduce((sum, b) => {
      const end = b.break_end ? Date.parse(b.break_end) : nowMs;
      return sum + Math.max(0, end - Date.parse(b.break_start));
    }, 0);
    out.push({
      id: String(s.id), name: String(s.name ?? ""), date,
      start_time: hm(String(s.start_time ?? "")), end_time: hm(String(s.end_time ?? "")),
      template_id: str(s.template_id),
      clock_in_time: clockIn.get(date) ?? null,
      breaks: dayBreaks,
      total_break_seconds: Math.round(totalMs / 1000),
      on_break: dayBreaks.some((b) => !b.break_end),
    });
  }
  return out.sort((x, y) => (x.date === y.date ? x.start_time.localeCompare(y.start_time) : x.date.localeCompare(y.date)));
}
