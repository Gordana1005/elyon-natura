/**
 * Insights → Work: the pure half of the tab (no React). workModel.test.ts
 * covers it. The payload (src/lib/insightsApi/work.ts) already carries every
 * rate; this file only filters by team, fills the day axis, bins the heat
 * grid and turns minutes / instants into Skopje clock text.
 */
import type {
  WorkCounts, WorkDayPoint, WorkHourCell, WorkPerson, WorkPrev, WorkRates, WorkResponse, WorkTeam, WorkTotals,
} from '@/lib/insightsApi/work';
import { addDays, mondayOf } from '../shared/period';

export const WORK_OUTCOMES = ['sale', 'callback', 'no_answer', 'cancel', 'trash'] as const;
export type WorkOutcomeKey = (typeof WORK_OUTCOMES)[number];

/** Team chips: '' = all teams. */
export const TEAM_PARAM = 'wteam';
/** The swimlane's day (inside the period). */
export const DAY_PARAM = 'wday';

// ── team filter ─────────────────────────────────────────────────────────────

/** A team's name in the reader's language: its kind (the board it plays on), else its own name. */
export function teamLabel(
  tm: { team_key: string; name: string | null; mode: string | null },
  t: (k: string) => string,
): string {
  if (tm.mode === 'pending') return t('insights.calls.team.pending');
  if (tm.mode === 'prediction') return t('insights.calls.team.prediction');
  if (tm.team_key === 'management') return t('insights.calls.team.management');
  if (tm.team_key === 'unassigned') return t('insights.calls.team.unassigned');
  return tm.name ?? tm.team_key;
}

export function teamsFor(data: WorkResponse, team: string): WorkTeam[] {
  return team ? data.teams.filter((t) => t.team_key === team) : data.teams;
}

export function peopleFor(data: WorkResponse, team: string): WorkPerson[] {
  return teamsFor(data, team).flatMap((t) => t.members);
}

/** Someone who did something this period (a decision, a call log, a credited sale, minutes online). */
export const isActive = (p: Pick<WorkPerson, 'worked' | 'call_logs' | 'credited' | 'online_min'>) =>
  p.worked > 0 || p.call_logs > 0 || (p.credited ?? 0) > 0 || (p.online_min ?? 0) > 0;

export interface KpiView {
  cur: (WorkCounts & WorkRates & { people: number }) | null;
  prev: (WorkCounts & WorkRates & { people: number }) | null;
  /** A team chip is on: the tiles read that team, no comparison. */
  filtered: boolean;
}

/** The KPI tiles: the whole business (with the previous period), or one team. */
export function kpiView(data: WorkResponse, team: string): KpiView {
  if (!team) {
    const t: WorkTotals = data.totals;
    const p: WorkPrev | null = data.prev;
    return { cur: t, prev: p, filtered: false };
  }
  const tm = data.teams.find((x) => x.team_key === team);
  if (!tm) return { cur: null, prev: null, filtered: true };
  return { cur: { ...tm.totals, people: tm.totals.active_people }, prev: null, filtered: true };
}

// ── the day (or week) axis ──────────────────────────────────────────────────

/** Every bucket of the window, in order: each day, or each week's Monday. */
export function bucketKeys(from: string, to: string, gran: 'day' | 'week'): string[] {
  const out: string[] = [];
  if (!from || !to || from > to) return out;
  if (gran === 'day') {
    for (let d = from; d <= to && out.length < 800; d = addDays(d, 1)) out.push(d);
    return out;
  }
  for (let d = mondayOf(from); d <= to && out.length < 200; d = addDays(d, 7)) out.push(d);
  return out;
}

export type SeriesPoint = Omit<WorkDayPoint, 'team_key'>;

const EMPTY_POINT = (d: string): SeriesPoint => ({
  d, worked: 0, sale: 0, cancel: 0, trash: 0, callback: 0, no_answer: 0, call_logs: 0, credited: 0, people: 0,
  online_min: null, active_min: null,
});

/**
 * One point per bucket (gaps filled with 0), summed over the chosen team — or
 * over everything, decisions no person owns ('__none__') included, when no
 * team is chosen. Minutes stay null where nobody had presence.
 */
export function seriesFor(data: Pick<WorkResponse, 'per_day' | 'meta'>, team: string): SeriesPoint[] {
  const keys = bucketKeys(data.meta.from, data.meta.to, data.meta.gran);
  const by = new Map(keys.map((k) => [k, EMPTY_POINT(k)]));
  for (const p of data.per_day) {
    if (team && p.team_key !== team) continue;
    const cur = by.get(p.d) ?? EMPTY_POINT(p.d);
    cur.worked += p.worked; cur.sale += p.sale; cur.cancel += p.cancel; cur.trash += p.trash;
    cur.callback += p.callback; cur.no_answer += p.no_answer; cur.call_logs += p.call_logs;
    cur.credited += p.credited; cur.people += p.people;
    if (p.online_min != null) cur.online_min = (cur.online_min ?? 0) + p.online_min;
    if (p.active_min != null) cur.active_min = (cur.active_min ?? 0) + p.active_min;
    by.set(p.d, cur);
  }
  return [...by.values()].sort((a, b) => a.d.localeCompare(b.d));
}

/** Outcome counts of any row, in the fixed bar order. */
export function outcomeCounts(c: Pick<WorkCounts, WorkOutcomeKey>): { key: WorkOutcomeKey; n: number }[] {
  return WORK_OUTCOMES.map((key) => ({ key, n: c[key] ?? 0 }));
}

// ── the heat grid ───────────────────────────────────────────────────────────

export type HeatMetric = 'decisions' | 'all';

export interface HeatRow { id: string | null; cells: number[]; total: number }

/**
 * person × hour counts (decisions, or decisions + call logs) for the people
 * shown, plus the hour span to draw: every hour that has activity, never
 * narrower than 08–20.
 */
export function heatGrid(cells: WorkHourCell[], people: string[], metric: HeatMetric): { rows: HeatRow[]; hours: number[]; all: number[] } {
  const want = new Set(people);
  const idx = new Map(people.map((p, i) => [p, i]));
  const rows: HeatRow[] = people.map((id) => ({ id, cells: Array(24).fill(0), total: 0 }));
  const all = Array(24).fill(0);
  let lo = 8, hi = 20;
  for (const c of cells) {
    if (!c.p || !want.has(c.p)) continue;
    const v = metric === 'all' ? c.d + c.c : c.d;
    if (!v) continue;
    const r = rows[idx.get(c.p)!];
    r.cells[c.h] += v;
    r.total += v;
    all[c.h] += v;
    lo = Math.min(lo, c.h);
    hi = Math.max(hi, c.h);
  }
  const hours: number[] = [];
  for (let h = lo; h <= hi; h++) hours.push(h);
  return { rows: rows.filter((r) => r.total > 0), hours, all };
}

/** Upper bounds of bins 1..5 over the non-zero values (quantiles; strictly rising). */
export function heatBreaks(values: number[]): number[] {
  const v = values.filter((x) => x > 0).sort((a, b) => a - b);
  if (!v.length) return [1, 1, 1, 1, 1];
  const q = (p: number) => v[Math.min(v.length - 1, Math.floor(p * (v.length - 1)))];
  const raw = [q(0.2), q(0.4), q(0.6), q(0.8), v[v.length - 1]];
  const out: number[] = [];
  raw.forEach((x, i) => out.push(i === 0 ? Math.max(x, 1) : Math.max(x, out[i - 1] + 1)));
  return out;
}

/** 0 for no activity, else the first bin whose bound holds the value. */
export function heatBin(v: number, breaks: number[]): number {
  if (!v) return 0;
  const i = breaks.findIndex((b) => v <= b);
  return i < 0 ? 5 : i + 1;
}

// ── clock text (Skopje) ─────────────────────────────────────────────────────

/** Minutes after Skopje midnight → "08:05". */
export function minToHm(min: number | null | undefined): string {
  if (min == null || !Number.isFinite(min)) return '';
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

const SKOPJE_PARTS = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Skopje', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
});

/** An instant → its Skopje day (YYYY-MM-DD) and minutes after that day's midnight. */
export function skopjeDayMin(iso: string | null | undefined): { day: string; min: number } | null {
  if (!iso) return null;
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return null;
  const p = Object.fromEntries(SKOPJE_PARTS.formatToParts(t).map((x) => [x.type, x.value]));
  const h = p.hour === '24' ? 0 : Number(p.hour);
  return { day: `${p.year}-${p.month}-${p.day}`, min: h * 60 + Number(p.minute) + t.getUTCSeconds() / 60 };
}

/** Minutes of `iso` relative to Skopje midnight of `day` (may run past 1440 or below 0). */
export function minutesInto(day: string, iso: string): number | null {
  const s = skopjeDayMin(iso);
  if (!s) return null;
  if (s.day === day) return s.min;
  const diff = Math.round((Date.parse(`${s.day}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86_400_000);
  return s.min + diff * 1440;
}

/**
 * A person's working hours for the table: one day → the first and last
 * activity ("08:05–16:40"); several days → the average start and end
 * ("~08:10–16:30") — the caller adds the day count.
 */
export function hoursText(p: Pick<WorkPerson, 'first_at' | 'last_at' | 'avg_start_min' | 'avg_end_min' | 'days_active'>): { text: string; averaged: boolean } | null {
  if (p.days_active <= 0) return null;
  if (p.days_active === 1) {
    const a = skopjeDayMin(p.first_at), b = skopjeDayMin(p.last_at);
    if (!a || !b) return null;
    return { text: `${minToHm(a.min)}–${minToHm(b.min)}`, averaged: false };
  }
  if (p.avg_start_min == null || p.avg_end_min == null) return null;
  return { text: `${minToHm(p.avg_start_min)}–${minToHm(p.avg_end_min)}`, averaged: true };
}

/** The swimlane's day: the requested one when it lies in the period, else the period's last day. */
export function pickDay(requested: string | null, from: string, to: string): string {
  return requested && requested >= from && requested <= to ? requested : to;
}

/** The period started before presence tracking existed (so minutes are partial). */
export function presenceGap(from: string, presenceSince: string | null): boolean {
  return !presenceSince || from < presenceSince;
}
