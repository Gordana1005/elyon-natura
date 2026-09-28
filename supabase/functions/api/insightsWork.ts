// ============================================================================
// Insights → Work ("Активност на повици") — the pure half of
// GET /api/insights/work and GET /api/insights/work/day (WP6, 2026-09-28;
// SQL: migration 20260941000600_insights_work).
//
// Dependency-free on purpose (no Deno globals, no URL imports): vitest runs
// insightsWork.test.ts against this file in Node, index.ts imports it, and
// scripts/verify-tab-work.mjs replays it over live rows.
//
//   workAccess()          who may read the tab: the call_activity module (as
//                         before — never widened); admins / managers / owners
//                         see everyone, any other holder only themselves
//   parseWorkDay()        ?day=YYYY-MM-DD → the Skopje day's instants
//   buildWorkResponse()   insights_work + insights_work_credited (this period
//                         and the previous one) → the tab's payload: teams with
//                         their members and totals, per-person rates, per-day
//                         series with credited sales merged in
//   buildWorkDayResponse() insights_work_day → the swimlane
//   rates()               conversion · reach · per active hour · handling
//
// No money anywhere: counts, minutes, seconds, rates. dropMoneyKeys() removes
// any *_eur / *_mkd key all the same, so a later SQL change cannot leak one.
// ============================================================================

import { overviewWindows, skopjeTodayYmd } from "./overview.ts";
import type { OverviewWindow } from "./overview.ts";

// ── access ──────────────────────────────────────────────────────────────────

export type WorkAccess = "all" | "self" | "forbidden";

/**
 * The tab keeps today's gate: the call_activity module (admins bypass it, as
 * canViewModule does). Admins, managers and business owners holding it see
 * every person; any other role an owner grants it to sees only their own row
 * — exactly what GET /agent-activity did for a plain agent.
 */
export function workAccess(o: { canCallActivity: boolean; isAdminOrManager: boolean; isOwner: boolean }): WorkAccess {
  if (!o.canCallActivity) return "forbidden";
  return o.isAdminOrManager || o.isOwner ? "all" : "self";
}

// ── the day param ───────────────────────────────────────────────────────────

export type WorkDay = { day: string; fromIso: string; toEndIso: string; today: boolean };

/** ?day=YYYY-MM-DD (default today, Skopje) → that day's Skopje instants. A day
 *  after today is refused; the window helper is the Overview's. */
export function parseWorkDay(raw: string | null, now: Date = new Date()): WorkDay | { error: string } {
  const today = skopjeTodayYmd(now);
  const day = raw && raw.trim() ? raw.trim() : today;
  if (day > today && /^\d{4}-\d{2}-\d{2}$/.test(day)) return { error: "day is in the future" };
  const w = overviewWindows(day, day, false, now);
  if ("error" in w) return { error: w.error === "from/to must be YYYY-MM-DD" ? "day must be YYYY-MM-DD" : w.error };
  return { day: w.from, fromIso: w.fromIso, toEndIso: w.toEndIso, today: w.from === today };
}

// ── shapes ──────────────────────────────────────────────────────────────────

export const OUTCOMES = ["sale", "callback", "no_answer", "cancel", "trash"] as const;
export type WorkOutcome = (typeof OUTCOMES)[number];

/** Below this many active minutes a per-hour rate is noise — shown as "—". */
export const RATE_MIN_ACTIVE_MIN = 30;

export interface WorkCounts {
  worked: number;
  via_crm: number;
  via_altercpa: number;
  sale: number;
  cancel: number;
  trash: number;
  callback: number;
  no_answer: number;
  call_logs: number;
  timed_calls: number;
  handling_sec: number;
  /** The cohort's credited sales; null when insights_work_credited failed. */
  credited: number | null;
  worked_tracked: number;
  sale_tracked: number;
  online_min: number | null;
  active_min: number | null;
  idle_min: number | null;
  break_min: number | null;
  idle_alerts: number | null;
  breaks: number;
  break_logged_min: number;
}

export interface WorkRates {
  /** sale decisions ÷ decisions */
  conversion: number | null;
  /** CRM decisions ÷ (CRM decisions + no-answer clicks) — reached, not dialled */
  reach: number | null;
  /** decisions on presence-tracked days ÷ active hours */
  per_active_hour: number | null;
  /** sale decisions on presence-tracked days ÷ active hours */
  sales_per_active_hour: number | null;
  /** agent-reported handling seconds ÷ timed calls */
  avg_handling_sec: number | null;
  /** decisions ÷ days with any activity */
  per_active_day: number | null;
}

export interface WorkPerson extends WorkCounts, WorkRates {
  person_id: string;
  name: string;
  has_login: boolean;
  is_manager: boolean;
  is_active: boolean;
  team_key: string;
  role: string;
  online_state: string;
  days_active: number;
  presence_days: number;
  first_at: string | null;
  last_at: string | null;
  avg_start_min: number | null;
  avg_end_min: number | null;
  last_decision_at: string | null;
  first_active: string | null;
  last_active: string | null;
}

export interface WorkTeam {
  team_key: string;
  name: string | null;
  mode: string | null;
  totals: WorkCounts & WorkRates & { people: number; active_people: number };
  members: WorkPerson[];
}

export interface WorkDayPoint {
  d: string;
  team_key: string;
  worked: number;
  sale: number;
  cancel: number;
  trash: number;
  callback: number;
  no_answer: number;
  call_logs: number;
  credited: number;
  people: number;
  online_min: number | null;
  active_min: number | null;
}

// ── helpers ─────────────────────────────────────────────────────────────────

const num = (v: unknown): number => {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
};
const numOrNull = (v: unknown): number | null => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const ratio = (a: number, b: number, digits = 4): number | null =>
  b > 0 ? Math.round((a / b) * 10 ** digits) / 10 ** digits : null;
const sumNullable = (vals: (number | null)[]): number | null =>
  vals.some((v) => v != null) ? vals.reduce<number>((a, v) => a + (v ?? 0), 0) : null;

/** A money key at any depth (the insights-wide rule). */
export const MONEY_KEY_RE = /(_eur|_mkd)$/;

/** Removes every *_eur / *_mkd key at any depth — this tab has none; the
 *  guard keeps it that way whatever a later migration returns. */
export function dropMoneyKeys<T>(v: T): T {
  if (Array.isArray(v)) return v.map((x) => dropMoneyKeys(x)) as unknown as T;
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (MONEY_KEY_RE.test(k)) continue;
      out[k] = dropMoneyKeys(x);
    }
    return out as T;
  }
  return v;
}

/** The rates every row (person, team, total) carries — one definition. */
export function rates(c: WorkCounts, daysActive: number | null = null): WorkRates {
  const activeH = c.active_min != null && c.active_min >= RATE_MIN_ACTIVE_MIN ? c.active_min / 60 : null;
  return {
    conversion: ratio(c.sale, c.worked),
    reach: ratio(c.via_crm, c.via_crm + c.no_answer),
    per_active_hour: activeH ? Math.round((c.worked_tracked / activeH) * 10) / 10 : null,
    sales_per_active_hour: activeH ? Math.round((c.sale_tracked / activeH) * 100) / 100 : null,
    avg_handling_sec: c.timed_calls > 0 ? Math.round(c.handling_sec / c.timed_calls) : null,
    per_active_day: daysActive && daysActive > 0 ? Math.round((c.worked / daysActive) * 10) / 10 : null,
  };
}

function countsOf(r: Record<string, unknown>, credited: number | null): WorkCounts {
  return {
    worked: num(r.worked),
    via_crm: num(r.via_crm),
    via_altercpa: num(r.via_altercpa),
    sale: num(r.sale),
    cancel: num(r.cancel),
    trash: num(r.trash),
    callback: num(r.callback),
    no_answer: num(r.no_answer),
    call_logs: num(r.call_logs),
    timed_calls: num(r.timed_calls),
    handling_sec: num(r.handling_sec),
    credited,
    worked_tracked: num(r.worked_tracked),
    sale_tracked: num(r.sale_tracked),
    online_min: numOrNull(r.online_min),
    active_min: numOrNull(r.active_min),
    idle_min: numOrNull(r.idle_min),
    break_min: numOrNull(r.break_min),
    idle_alerts: numOrNull(r.idle_alerts),
    breaks: num(r.breaks),
    break_logged_min: num(r.break_logged_min),
  };
}

function sumCounts(rows: WorkCounts[]): WorkCounts {
  const s = (k: keyof WorkCounts) => rows.reduce((a, r) => a + num(r[k]), 0);
  const n = (k: keyof WorkCounts) => sumNullable(rows.map((r) => (r[k] as number | null)));
  return {
    worked: s("worked"), via_crm: s("via_crm"), via_altercpa: s("via_altercpa"),
    sale: s("sale"), cancel: s("cancel"), trash: s("trash"), callback: s("callback"),
    no_answer: s("no_answer"), call_logs: s("call_logs"), timed_calls: s("timed_calls"), handling_sec: s("handling_sec"),
    credited: n("credited"),
    worked_tracked: s("worked_tracked"), sale_tracked: s("sale_tracked"),
    online_min: n("online_min"), active_min: n("active_min"), idle_min: n("idle_min"), break_min: n("break_min"),
    idle_alerts: n("idle_alerts"), breaks: s("breaks"), break_logged_min: s("break_logged_min"),
  };
}

/** Board order: the AlterCPA lead team (pending), the prediction team, other
 *  teams, management, then nobody's. The Overview TeamsBoard's order. */
export function teamOrder(t: { team_key: string; mode: string | null }): number {
  if (t.mode === "pending") return 0;
  if (t.mode === "prediction") return 1;
  if (t.team_key === "management") return 7;
  if (t.team_key === "unassigned") return 9;
  return 5;
}

/** Most decisions first; ties → call logs, then name. */
export const byWork = (a: WorkPerson, b: WorkPerson) =>
  b.worked - a.worked || b.call_logs - a.call_logs || a.name.localeCompare(b.name);

// ── credited (insights_work_credited) ───────────────────────────────────────

export interface CreditedBlock {
  gran: string | null;
  total: number;
  /** Order sales in the cohort nobody is credited with yet (null in the self view). */
  no_seller: number | null;
  rows: { p: string; b: string; n: number }[];
}

export function parseCredited(raw: unknown): CreditedBlock | null {
  if (!raw || typeof raw !== "object") return null;
  const o = obj(raw);
  const rows = arr(o.rows)
    .map((r) => obj(r))
    .filter((r) => typeof r.p === "string" && typeof r.b === "string")
    .map((r) => ({ p: r.p as string, b: r.b as string, n: num(r.n) }));
  return { gran: str(o.gran), total: num(o.total), no_seller: numOrNull(o.no_seller), rows };
}

// ── GET /api/insights/work ──────────────────────────────────────────────────

export interface BuildWorkOptions { self: boolean; now?: Date }

/**
 * insights_work (+ credited this period / the previous one) → the payload.
 * `credited` null = its RPC failed: every credited figure is null (shown as
 * "—", never 0) and meta.credited = false.
 */
export function buildWorkResponse(
  rpcRaw: unknown,
  creditedRaw: unknown,
  prevCreditedRaw: unknown,
  win: OverviewWindow,
  opts: BuildWorkOptions,
): Record<string, unknown> {
  const rpc = obj(rpcRaw);
  const meta = obj(rpc.meta);
  const credited = parseCredited(creditedRaw);
  const prevCredited = parseCredited(prevCreditedRaw);

  const byPerson = new Map<string, number>();
  for (const r of credited?.rows ?? []) byPerson.set(r.p, (byPerson.get(r.p) ?? 0) + r.n);

  // people
  const people: WorkPerson[] = arr(rpc.people).map((raw) => {
    const r = obj(raw);
    const id = String(r.person_id ?? "");
    const c = countsOf(r, credited ? (byPerson.get(id) ?? 0) : null);
    const days = num(r.days_active);
    return {
      person_id: id,
      name: String(r.name ?? ""),
      has_login: r.has_login === true,
      is_manager: r.is_manager === true,
      is_active: r.is_active !== false,
      team_key: str(r.team_key) ?? "unassigned",
      role: str(r.role) ?? "member",
      online_state: str(r.online_state) ?? "n/a",
      days_active: days,
      presence_days: num(r.presence_days),
      first_at: str(r.first_at),
      last_at: str(r.last_at),
      avg_start_min: numOrNull(r.avg_start_min),
      avg_end_min: numOrNull(r.avg_end_min),
      last_decision_at: str(r.last_decision_at),
      first_active: str(r.first_active),
      last_active: str(r.last_active),
      ...c,
      ...rates(c, days),
    };
  });
  const personTeam = new Map(people.map((p) => [p.person_id, p.team_key]));

  // credited to a person insights_work did not list (should not happen: it
  // lists everyone orders.sold_at credits) — counted in the totals, flagged
  let creditedUnlisted = 0;
  for (const [p, n] of byPerson) if (!personTeam.has(p)) creditedUnlisted += n;

  // teams: every sales team (even empty), + unassigned when someone is in it
  const teamDefs = arr(rpc.teams).map((t) => obj(t)).map((t) => ({
    team_key: String(t.team_key ?? ""), name: str(t.name), mode: str(t.mode),
  })).filter((t) => t.team_key);
  if (people.some((p) => p.team_key === "unassigned") && !teamDefs.some((t) => t.team_key === "unassigned")) {
    teamDefs.push({ team_key: "unassigned", name: null, mode: null });
  }
  for (const p of people) {
    if (!teamDefs.some((t) => t.team_key === p.team_key)) teamDefs.push({ team_key: p.team_key, name: null, mode: null });
  }
  const teams: WorkTeam[] = teamDefs
    .map((t) => {
      const members = people.filter((p) => p.team_key === t.team_key).sort(byWork);
      const c = sumCounts(members);
      if (!credited) c.credited = null;
      const days = Math.max(0, ...members.map((m) => m.days_active));
      return {
        ...t,
        totals: {
          ...c, ...rates(c, days || null),
          people: members.length,
          active_people: members.filter((m) => m.worked > 0 || m.call_logs > 0).length,
        },
        members,
      };
    })
    .sort((a, b) => teamOrder(a) - teamOrder(b) || (a.name ?? a.team_key).localeCompare(b.name ?? b.team_key));

  // totals (the SQL's — they also count decisions nobody owns)
  const tRaw = obj(rpc.totals);
  const totalsCounts = countsOf(tRaw, credited ? credited.total : null);
  const totals = {
    ...totalsCounts,
    ...rates(totalsCounts, num(tRaw.days_active) || null),
    people: num(tRaw.people),
    people_crm: num(tRaw.people_crm),
    people_altercpa: num(tRaw.people_altercpa),
    presence_people: num(tRaw.presence_people),
    days_active: num(tRaw.days_active),
  };

  let prev: Record<string, unknown> | null = null;
  if (rpc.prev && typeof rpc.prev === "object" && win.prev) {
    const pRaw = obj(rpc.prev);
    const pc = countsOf(pRaw, prevCredited ? prevCredited.total : null);
    prev = {
      ...pc,
      ...rates(pc),
      people: num(pRaw.people),
      presence_people: num(pRaw.presence_people),
    };
  }

  // per day × team, credited merged in by the person's team
  const pd = new Map<string, WorkDayPoint>();
  const key = (d: string, t: string) => `${d}|${t}`;
  const blank = (d: string, t: string): WorkDayPoint => ({
    d, team_key: t, worked: 0, sale: 0, cancel: 0, trash: 0, callback: 0, no_answer: 0, call_logs: 0,
    credited: 0, people: 0, online_min: null, active_min: null,
  });
  for (const raw of arr(rpc.per_day)) {
    const r = obj(raw);
    const d = str(r.d);
    const t = str(r.team_key) ?? "unassigned";
    if (!d) continue;
    pd.set(key(d, t), {
      d, team_key: t,
      worked: num(r.worked), sale: num(r.sale), cancel: num(r.cancel), trash: num(r.trash),
      callback: num(r.callback), no_answer: num(r.no_answer), call_logs: num(r.call_logs),
      credited: 0, people: num(r.people),
      online_min: numOrNull(r.online_min), active_min: numOrNull(r.active_min),
    });
  }
  for (const r of credited?.rows ?? []) {
    const t = personTeam.get(r.p) ?? "unassigned";
    const k = key(r.b, t);
    const cur = pd.get(k) ?? blank(r.b, t);
    cur.credited += r.n;
    pd.set(k, cur);
  }
  const perDay = [...pd.values()].sort((a, b) => a.d.localeCompare(b.d) || a.team_key.localeCompare(b.team_key));

  const byHour = arr(rpc.by_hour).map((raw) => {
    const r = obj(raw);
    return { p: str(r.p), h: num(r.h), d: num(r.d), c: num(r.c) };
  }).filter((r) => r.h >= 0 && r.h <= 23);

  const quality = rpc.quality && typeof rpc.quality === "object"
    ? { ...obj(rpc.quality), credited_unlisted: creditedUnlisted, no_seller: credited?.no_seller ?? null }
    : null;

  const body = {
    meta: {
      from: win.from,
      to: win.to,
      prev_from: win.prev?.from ?? null,
      prev_to: win.prev?.to ?? null,
      prev_to_end: win.prev?.toEndIso ?? null,
      partial: win.partial,
      days: win.days,
      generated_at: (opts.now ?? new Date()).toISOString(),
      gran: str(meta.gran) ?? (win.days <= 62 ? "day" : "week"),
      clock: "decided",
      // MK telephony is deferred (VITE_USE_REAL_VOIP=false): every call-log
      // figure is agent-reported.
      voip: false,
      presence_since: str(meta.presence_since),
      work_since: str(meta.work_since),
      calls_since: str(meta.calls_since),
      self: opts.self,
      credited: credited !== null,
      prev_credited: prevCredited !== null,
      rate_min_active_min: RATE_MIN_ACTIVE_MIN,
    },
    totals,
    prev,
    teams,
    per_day: perDay,
    by_hour: byHour,
    callbacks: rpc.callbacks ?? null,
    quality,
  };
  return dropMoneyKeys(body);
}

// ── GET /api/insights/work/day ──────────────────────────────────────────────

export interface WorkDayDecision { at: string; o: string; via: string }
export interface WorkDayCall { at: string; o: string | null; timed: boolean; e: string | null; sec: number; st: string | null }

export function buildWorkDayResponse(rpcRaw: unknown, day: WorkDay, opts: { self: boolean; now?: Date }): Record<string, unknown> {
  const rpc = obj(rpcRaw);
  const meta = obj(rpc.meta);
  const teamRank = (k: string) => (k === "altercpa_leads" ? 0 : k === "crm_prediction" ? 1 : k === "management" ? 7 : k === "unassigned" ? 9 : 5);
  const people = arr(rpc.people).map((raw) => {
    const r = obj(raw);
    const decisions: WorkDayDecision[] = arr(r.decisions).map((x) => obj(x))
      .filter((x) => typeof x.at === "string")
      .map((x) => ({ at: x.at as string, o: String(x.o ?? ""), via: String(x.via ?? "") }));
    const calls: WorkDayCall[] = arr(r.calls).map((x) => obj(x))
      .filter((x) => typeof x.at === "string")
      .map((x) => ({ at: x.at as string, o: str(x.o), timed: x.timed === true, e: str(x.e), sec: num(x.sec), st: str(x.st) }));
    const count = (o: string) => decisions.filter((x) => x.o === o).length;
    const presence = r.presence && typeof r.presence === "object" ? obj(r.presence) : null;
    const timed = calls.filter((c) => c.timed);
    return {
      person_id: String(r.person_id ?? ""),
      name: String(r.name ?? ""),
      has_login: r.has_login === true,
      is_manager: r.is_manager === true,
      team_key: str(r.team_key) ?? "unassigned",
      online_state: str(r.online_state) ?? "n/a",
      presence,
      logins: arr(r.logins).filter((x): x is string => typeof x === "string"),
      breaks: arr(r.breaks).map((x) => obj(x)).filter((x) => typeof x.s === "string")
        .map((x) => ({ s: x.s as string, e: str(x.e) })),
      decisions,
      calls,
      totals: {
        worked: decisions.length,
        sale: count("sale"),
        cancel: count("cancel"),
        trash: count("trash"),
        callback: count("callback"),
        no_answer: calls.filter((c) => c.o === "no_answer").length,
        call_logs: calls.length,
        timed_calls: timed.length,
        handling_sec: timed.reduce((a, c) => a + c.sec, 0),
        first_at: [...decisions.map((x) => x.at), ...calls.map((x) => x.at)].sort()[0] ?? null,
        last_at: [...decisions.map((x) => x.at), ...calls.map((x) => x.at)].sort().at(-1) ?? null,
      },
    };
  }).sort((a, b) => teamRank(a.team_key) - teamRank(b.team_key)
    || b.totals.worked - a.totals.worked || b.totals.call_logs - a.totals.call_logs || a.name.localeCompare(b.name));
  const un = obj(rpc.unattributed);
  return dropMoneyKeys({
    meta: {
      day: day.day,
      today: day.today,
      generated_at: (opts.now ?? new Date()).toISOString(),
      presence_since: str(meta.presence_since),
      voip: false,
      self: opts.self,
    },
    people,
    unattributed: { decisions: num(un.decisions), calls: num(un.calls) },
  });
}
