/**
 * The ONE period every /insights tab counts by (owner rule 2026-09-28).
 *
 * Presets are Skopje days — Денес (the default, owner 01.10.2026) · Последни 7 дена (today and the six days
 * before it) · Овој месец (1st → today) · Оваа година (1 Jan → today) ·
 * Прилагодено —
 * and "compare" is the equal-length span right before (the server's
 * overviewWindows() uses the same rule and cuts a partial day at the same
 * elapsed time).
 *
 * The state lives in the /insights URL so it survives a reload, can be shared,
 * and — because every tab reads the same params — survives a tab switch:
 *   range=<preset>        (the default preset is left out)
 *   from=YYYY-MM-DD&to=YYYY-MM-DD   (custom only; a preset is recomputed from today)
 *   compare=0             (compare is ON by default; the legacy `cmp=0` is still read)
 *
 * Pure functions, no React: period.test.ts covers them.
 */

export const PERIOD_PRESETS = ['today', 'week', 'month', 'year', 'custom'] as const;
export type PeriodPreset = (typeof PERIOD_PRESETS)[number];
/** Today by default (owner, 01.10.2026: "by default today, with arrows to go day by day"). */
export const DEFAULT_PERIOD_PRESET: PeriodPreset = 'today';
/** Longest custom span we ask for (the server refuses > 731; a year-to-date is ≤ 366). */
export const MAX_SPAN_DAYS = 400;

/** The URL params the period owns. Everything else in the URL is left alone. */
export const PERIOD_PARAMS = ['range', 'from', 'to', 'compare'] as const;
const LEGACY_COMPARE_PARAM = 'cmp';

export interface DayRange { from: string; to: string }

export interface PeriodState {
  preset: PeriodPreset;
  /** Inclusive Skopje days. */
  range: DayRange;
  compare: boolean;
}

const ymdRe = /^\d{4}-\d{2}-\d{2}$/;

/** A real YYYY-MM-DD day (2026-02-30 is not one). */
export const isYmd = (s: string | null | undefined): s is string => {
  if (!s || !ymdRe.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};

/** Today on the Europe/Skopje calendar. */
export function skopjeToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Skopje', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

/** Calendar arithmetic on a YYYY-MM-DD (no timezone can shift it). */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Inclusive day count of a range (1 for a single day). */
export const spanDays = (r: DayRange) => daysBetween(r.from, r.to) + 1;

/** Monday of the week `day` falls in (weeks start on Monday in Macedonia). */
export function mondayOf(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return addDays(day, -((dow + 6) % 7));
}

/**
 * A preset's days, inclusive, on the calendar: the week button is the last 7
 * days (today and the six before it — a Monday-to-today week is only today on
 * Monday, so it came out smaller than yesterday). This month = the 1st → today,
 * this year = 1 January → today. Custom: a
 * reversed pair is swapped (a slip, not a question), days after today are
 * pulled back to today, an unreadable day falls back to this week, and the
 * span is capped at MAX_SPAN_DAYS (the start moves, never the end).
 */
export function presetRange(preset: PeriodPreset, today: string, custom?: Partial<DayRange>): DayRange {
  switch (preset) {
    case 'today': return { from: today, to: today };
    case 'week': return { from: addDays(today, -6), to: today };
    case 'month': return { from: `${today.slice(0, 7)}-01`, to: today };
    case 'year': return { from: `${today.slice(0, 4)}-01-01`, to: today };
    case 'custom': {
      if (!isYmd(custom?.from) || !isYmd(custom?.to)) return presetRange('week', today);
      let from = custom!.from!;
      let to = custom!.to!;
      if (from > to) [from, to] = [to, from];
      if (to > today) to = today;
      if (from > today) from = today;
      if (daysBetween(from, to) > MAX_SPAN_DAYS) from = addDays(to, -MAX_SPAN_DAYS);
      return { from, to };
    }
  }
}

/**
 * The ← / → arrows next to the period (owner 01.10.2026, like the shop's dashboard): move the period
 * by its own length — one day for a day, seven for the last 7 days. Never past today: → is disabled
 * (null) when the period already ends today, and a step that would run past today lands on the span
 * that ends today. A single day that lands on today is the 'today' preset again; anything else is
 * a custom period.
 */
export function stepRange(r: DayRange, dir: -1 | 1, today: string): { preset: PeriodPreset; range: DayRange } | null {
  if (!isYmd(r.from) || !isYmd(r.to)) return null;
  if (dir > 0 && r.to >= today) return null;
  const days = spanDays(r);
  let from = addDays(r.from, dir * days);
  let to = addDays(r.to, dir * days);
  if (to > today) { to = today; from = addDays(today, -(days - 1)); }
  const preset: PeriodPreset = days === 1 && to === today ? 'today' : 'custom';
  return { preset, range: { from, to } };
}

/** The equal-length span immediately before `r` (what "compare" measures against). */
export function previousRange(r: DayRange): DayRange {
  const days = spanDays(r);
  return { from: addDays(r.from, -days), to: addDays(r.to, -days) };
}

// ── dd.mm.yyyy (the only way a day is written on screen) ────────────────────

/** YYYY-MM-DD → dd.mm.yyyy (straight off the string; no timezone can shift it). */
export const formatDmy = (ymd: string | null | undefined): string =>
  ymd && isYmd(ymd) ? `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}.${ymd.slice(0, 4)}` : '';

/**
 * What an operator types → YYYY-MM-DD, or null. Accepts 28.09.2026, 28.9.2026,
 * 28/09/2026, 28-09-2026 and a pasted 2026-09-28. Day first, always — never
 * the US month-first reading. A two-digit year is 20yy.
 */
export function parseDmy(text: string | null | undefined): string | null {
  const s = (text ?? '').trim();
  if (!s) return null;
  if (ymdRe.test(s)) return isYmd(s) ? s : null;
  const m = s.match(/^(\d{1,2})[./\-\s](\d{1,2})[./\-\s](\d{2}|\d{4})\.?$/);
  if (!m) return null;
  const year = m[3].length === 2 ? `20${m[3]}` : m[3];
  const ymd = `${year}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return isYmd(ymd) ? ymd : null;
}

/** A period as text: "28.09.2026" for one day, "22.09 – 28.09.2026" in one year, full dates otherwise. */
export function periodText(r: DayRange): string {
  if (!isYmd(r.from) || !isYmd(r.to)) return '';
  if (r.from === r.to) return formatDmy(r.from);
  if (r.from.slice(0, 4) === r.to.slice(0, 4)) return `${formatDmy(r.from).slice(0, 5)} – ${formatDmy(r.to)}`;
  return `${formatDmy(r.from)} – ${formatDmy(r.to)}`;
}

// ── URL state ───────────────────────────────────────────────────────────────

/** Reads the period out of the /insights URL. A from/to pair without `range`
 *  (a link from elsewhere) is read as a custom period. */
export function parsePeriodParams(sp: URLSearchParams, today: string): PeriodState {
  const raw = sp.get('range');
  const from = sp.get('from') ?? undefined;
  const to = sp.get('to') ?? undefined;
  let preset: PeriodPreset = DEFAULT_PERIOD_PRESET;
  if (raw && (PERIOD_PRESETS as readonly string[]).includes(raw)) preset = raw as PeriodPreset;
  else if (!raw && isYmd(from) && isYmd(to)) preset = 'custom';
  const range = presetRange(preset, today, { from, to });
  const cmp = sp.get('compare') ?? sp.get(LEGACY_COMPARE_PARAM);
  return { preset, range, compare: cmp !== '0' && cmp !== 'false' };
}

/** Writes the period back, keeping every other param (the tab, a tab's own filters). Defaults stay out of the URL. */
export function writePeriodParams(sp: URLSearchParams, next: Partial<PeriodState>): URLSearchParams {
  const out = new URLSearchParams(sp);
  const set = (k: string, v: string | null) => (v ? out.set(k, v) : out.delete(k));
  if (next.preset !== undefined) set('range', next.preset === DEFAULT_PERIOD_PRESET ? null : next.preset);
  if (next.preset !== undefined || next.range !== undefined) {
    const custom = (next.preset ?? out.get('range')) === 'custom';
    set('from', custom && next.range ? next.range.from : custom ? out.get('from') : null);
    set('to', custom && next.range ? next.range.to : custom ? out.get('to') : null);
  }
  if (next.compare !== undefined) {
    out.delete(LEGACY_COMPARE_PARAM);
    set('compare', next.compare ? null : '0');
  }
  return out;
}

/**
 * The URL for another tab: the tab plus the shared period, nothing else — a
 * tab's own filters (the Overview's sources/teams, a drill) do not follow the
 * reader into a tab that does not understand them.
 */
export function switchTabParams(sp: URLSearchParams, tab: string): URLSearchParams {
  const out = new URLSearchParams();
  out.set('tab', tab);
  for (const k of PERIOD_PARAMS) {
    const v = sp.get(k);
    if (v) out.set(k, v);
  }
  const legacy = sp.get(LEGACY_COMPARE_PARAM);
  if (legacy === '0' && !out.has('compare')) out.set('compare', '0');
  return out;
}
