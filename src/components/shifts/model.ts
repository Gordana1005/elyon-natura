/**
 * Client-side helpers of the "Смени" page: days of a view, brushes and their colours,
 * the today-card state. The cell rules themselves (diffing, validation, the runway
 * banner) are the server's own module, re-exported by @/lib/shiftsApi.
 */
import {
  addDaysYmd, cellKey, isoDow, monthBounds, mondayOfYmd, sameValue,
  type GridCell, type GridTemplate, type GridWindow, type StagedCell,
} from '@/lib/shiftsApi';

export type GridView = 'week' | 'month';

/** The days a view shows around `anchor`: Mon–Sun of its week, or the whole month. */
export function viewDays(view: GridView, anchor: string): string[] {
  const from = view === 'week' ? mondayOfYmd(anchor) : monthBounds(anchor).from;
  const to = view === 'week' ? addDaysYmd(from, 6) : monthBounds(anchor).to;
  const out: string[] = [];
  for (let d = from; d <= to; d = addDaysYmd(d, 1)) out.push(d);
  return out;
}

/** Move the anchor one view back (-1) or forward (+1). */
export function stepAnchor(view: GridView, anchor: string, dir: -1 | 1): string {
  if (view === 'week') return addDaysYmd(mondayOfYmd(anchor), 7 * dir);
  const { from } = monthBounds(anchor);
  return dir === 1 ? addDaysYmd(monthBounds(anchor).to, 1) : monthBounds(addDaysYmd(from, -1)).from;
}

export const isWeekend = (day: string) => isoDow(day) >= 6;

/** A brush = what a click paints. `key` identifies it (and its colour). */
export type Brush =
  | { key: string; kind: 'template'; template_id: string; name: string; start: string; end: string }
  | { key: string; kind: 'window'; name: string | null; start: string; end: string }
  | { key: 'off'; kind: 'off' };

export const brushKeyOfTemplate = (id: string) => `t:${id}`;
export const brushKeyOfWindow = (start: string, end: string) => `w:${start}-${end}`;

/** Templates first, then the custom windows in use (a month roll's 07:00–21:00, …) not already a template. */
export function buildBrushes(templates: GridTemplate[], windows: GridWindow[]): Brush[] {
  const out: Brush[] = templates.map((t) => ({ key: brushKeyOfTemplate(t.id), kind: 'template', template_id: t.id, name: t.name, start: t.start, end: t.end }));
  const seen = new Set<string>();
  for (const w of windows) {
    const key = brushKeyOfWindow(w.start, w.end);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, kind: 'window', name: w.name, start: w.start, end: w.end });
  }
  return out;
}

export function brushToStaged(b: Brush): StagedCell {
  if (b.kind === 'off') return { kind: 'off' };
  if (b.kind === 'template') return { kind: 'template', template_id: b.template_id, start: b.start, end: b.end, name: b.name };
  return { kind: 'window', start: b.start, end: b.end, name: b.name };
}

/** The value a person-day shows: the staged one when there is one, else the stored cell. */
export type ShownCell =
  | { kind: 'off' }
  | { kind: 'shift'; start: string; end: string; name: string | null; template_id: string | null };

export function shownCell(stored: GridCell | undefined, staged: StagedCell | undefined): ShownCell {
  if (staged) {
    if (staged.kind === 'off') return { kind: 'off' };
    return { kind: 'shift', start: staged.start, end: staged.end, name: staged.name ?? null, template_id: staged.kind === 'template' ? staged.template_id : null };
  }
  if (!stored) return { kind: 'off' };
  return { kind: 'shift', start: stored.start, end: stored.end, name: stored.name, template_id: stored.template_id };
}

export const shownKey = (c: ShownCell): string =>
  c.kind === 'off' ? 'off' : c.template_id ? brushKeyOfTemplate(c.template_id) : brushKeyOfWindow(c.start, c.end);

/** "07–21" (whole hours) or "07:30–14:30". */
export function shortWindow(start: string, end: string): string {
  const s = start.endsWith(':00') ? start.slice(0, 2) : start;
  const e = end.endsWith(':00') ? end.slice(0, 2) : end;
  return `${s}–${e}`;
}

// Literal class strings so Tailwind generates them. Every tone pairs a fill with a
// border and text that pass on both themes; the time text is always written, so a
// colour is never the only channel.
const TONES = [
  'bg-sky-100 border-sky-300 text-sky-900 dark:bg-sky-500/20 dark:border-sky-400/50 dark:text-sky-100',
  'bg-violet-100 border-violet-300 text-violet-900 dark:bg-violet-500/20 dark:border-violet-400/50 dark:text-violet-100',
  'bg-emerald-100 border-emerald-300 text-emerald-900 dark:bg-emerald-500/20 dark:border-emerald-400/50 dark:text-emerald-100',
  'bg-amber-100 border-amber-300 text-amber-900 dark:bg-amber-500/20 dark:border-amber-400/50 dark:text-amber-100',
  'bg-rose-100 border-rose-300 text-rose-900 dark:bg-rose-500/20 dark:border-rose-400/50 dark:text-rose-100',
  'bg-teal-100 border-teal-300 text-teal-900 dark:bg-teal-500/20 dark:border-teal-400/50 dark:text-teal-100',
  'bg-indigo-100 border-indigo-300 text-indigo-900 dark:bg-indigo-500/20 dark:border-indigo-400/50 dark:text-indigo-100',
  'bg-lime-100 border-lime-300 text-lime-900 dark:bg-lime-500/20 dark:border-lime-400/50 dark:text-lime-100',
] as const;
export const NEUTRAL_TONE = 'bg-slate-100 border-slate-300 text-slate-900 dark:bg-slate-500/20 dark:border-slate-400/50 dark:text-slate-100';
export const OFF_TONE = 'border-dashed border-border bg-transparent text-muted-foreground';

/** Brush key → tone, stable in the brushes' order. */
export function toneMap(brushes: Brush[]): Map<string, string> {
  const m = new Map<string, string>();
  let i = 0;
  for (const b of brushes) if (b.kind !== 'off') m.set(b.key, TONES[i++ % TONES.length]);
  return m;
}

/** Where "now" is relative to a shift window (Skopje HH:MM). */
export function shiftState(start: string, end: string, nowTime: string): 'upcoming' | 'on' | 'ended' {
  if (nowTime < start) return 'upcoming';
  if (nowTime > end) return 'ended';
  return 'on';
}

/** Duration in whole minutes → "1 ч 05 мин" style parts for i18n. */
export function hoursMinutes(totalMinutes: number): { h: number; m: number } {
  const t = Math.max(0, Math.round(totalMinutes));
  return { h: Math.floor(t / 60), m: t % 60 };
}

/** Minutes between two HH:MM. */
export function windowMinutes(start: string, end: string): number {
  const toM = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  return Math.max(0, toM(end) - toM(start));
}

export { cellKey };

// ── staging: what the grid has painted but not saved ─────────────────────────────────────

/**
 * `baseline` = what was stored when a person-day was first painted (null = nothing), so a
 * change made in one week survives a move to the next week (its grid is no longer loaded);
 * painting a cell back to its baseline un-stages it.
 */
export interface Staging {
  staged: Map<string, StagedCell>;
  baseline: Map<string, GridCell | null>;
}
export type StagingAction =
  | { type: 'paint'; entries: ReadonlyArray<readonly [string, StagedCell]>; stored: ReadonlyMap<string, GridCell> }
  | { type: 'reset' };

export const EMPTY_STAGING: Staging = { staged: new Map(), baseline: new Map() };

export function stagingReducer(s: Staging, a: StagingAction): Staging {
  if (a.type === 'reset') return { staged: new Map(), baseline: new Map() };
  const staged = new Map(s.staged);
  const baseline = new Map(s.baseline);
  for (const [key, value] of a.entries) {
    if (!baseline.has(key)) baseline.set(key, a.stored.get(key) ?? null);
    if (sameValue(baseline.get(key) ?? undefined, value)) staged.delete(key);
    else staged.set(key, value);
  }
  return { staged, baseline };
}

/** The baseline as diffCells wants it (only the person-days that had a shift). */
export function baselineCells(s: Staging): Map<string, GridCell> {
  const m = new Map<string, GridCell>();
  for (const [k, v] of s.baseline) if (v) m.set(k, v);
  return m;
}

/** The team a row is grouped under. Unknown keys fall back to the server's name. */
export const TEAM_ORDER: Record<string, number> = {
  affiliate_leads: 1, altercpa_leads: 1, affiliate_prediction: 2,
  teleshop_leads: 3, teleshop_prediction: 4, crm_prediction: 4, social: 5, management: 8,
};
