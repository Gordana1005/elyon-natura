/**
 * The connected Overview's pure rules — ranges, drill-down links, deltas,
 * derived totals and formatting. No React, no network: overviewModel.test.ts
 * covers it. The components only lay these results out.
 */
import {
  ORDERS_DRILL_KEYS,
  type OrdersDrillParams, type OverviewBucketKey, type OverviewKpiSet, type OverviewSplit,
  type OverviewPivotRow, type OverviewResponse, type OverviewSource, type OverviewSourceKey,
  type OverviewSparkPoint, type OverviewTeamMember, type OverviewTrendPoint,
} from '@/lib/api';
import { SOURCE_ORDER } from './palette';

// ── Ranges (Skopje calendar days) ───────────────────────────────────────────

export const RANGE_PRESETS = ['today', 'week', 'month', 'year', 'custom'] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];
export const DEFAULT_PRESET: RangePreset = 'week';
/** Longest custom span we ask for (the shop panel's cap). */
export const MAX_SPAN_DAYS = 400;

const ymdRe = /^\d{4}-\d{2}-\d{2}$/;
export const isYmd = (s: string | null | undefined): s is string =>
  !!s && ymdRe.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

/** Today on the Europe/Skopje calendar. */
export function skopjeToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Skopje', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export interface DayRange { from: string; to: string }

/** A preset's days, inclusive — the shop panel's rules: rolling 7 / 30 / 365 days. */
export function presetRange(preset: RangePreset, today: string, custom?: Partial<DayRange>): DayRange {
  if (preset === 'custom') {
    let from = isYmd(custom?.from) ? custom!.from! : addDays(today, -6);
    let to = isYmd(custom?.to) ? custom!.to! : today;
    if (from > to) [from, to] = [to, from];             // a reversed pair is a slip, not a question
    if (daysBetween(from, to) > MAX_SPAN_DAYS) from = addDays(to, -MAX_SPAN_DAYS);
    return { from, to };
  }
  const span = preset === 'week' ? 6 : preset === 'month' ? 29 : preset === 'year' ? 364 : 0;
  return { from: addDays(today, -span), to: today };
}

/** The equal-length span immediately before `r` (what "compare" measures against). */
export function previousRange(r: DayRange): DayRange {
  const days = daysBetween(r.from, r.to) + 1;
  return { from: addDays(r.from, -days), to: addDays(r.to, -days) };
}

export interface OverviewFilters {
  preset: RangePreset;
  range: DayRange;
  compare: boolean;
  /** Empty = every source. */
  sources: OverviewSourceKey[];
  /** Empty = every team. team_key values. */
  teams: string[];
}

/** Reads the Overview's state out of the /insights URL (shareable, survives reload). */
export function parseOverviewParams(sp: URLSearchParams, today: string): OverviewFilters {
  const raw = sp.get('range') as RangePreset | null;
  const preset: RangePreset = raw && (RANGE_PRESETS as readonly string[]).includes(raw) ? raw : DEFAULT_PRESET;
  const range = presetRange(preset, today, { from: sp.get('from') ?? undefined, to: sp.get('to') ?? undefined });
  const sources = (sp.get('src') ?? '').split(',').filter((s): s is OverviewSourceKey =>
    (SOURCE_ORDER as string[]).includes(s));
  const teams = (sp.get('team') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return { preset, range, compare: sp.get('cmp') !== '0', sources, teams };
}

/** Writes the Overview's state back, keeping every other param (the tab). */
export function writeOverviewParams(sp: URLSearchParams, f: Partial<OverviewFilters>): URLSearchParams {
  const next = new URLSearchParams(sp);
  const set = (k: string, v: string | null) => (v ? next.set(k, v) : next.delete(k));
  if (f.preset !== undefined) set('range', f.preset === DEFAULT_PRESET ? null : f.preset);
  if (f.preset !== undefined || f.range !== undefined) {
    const custom = (f.preset ?? next.get('range')) === 'custom';
    set('from', custom && f.range ? f.range.from : custom ? next.get('from') : null);
    set('to', custom && f.range ? f.range.to : custom ? next.get('to') : null);
  }
  if (f.compare !== undefined) set('cmp', f.compare ? null : '0');
  if (f.sources !== undefined) set('src', f.sources.length ? f.sources.join(',') : null);
  if (f.teams !== undefined) set('team', f.teams.length ? f.teams.join(',') : null);
  return next;
}

// ── Drill-down links ────────────────────────────────────────────────────────

/** Display-only: who/what the drill is about (a person's name), never sent to the API. */
export const DRILL_LABEL_PARAM = 'lbl';

/** `/orders?…` for a set of drill params; null when there is nothing to filter on. */
export function ordersHref(p: OrdersDrillParams | null | undefined, label?: string | null): string | null {
  if (!p) return null;
  const sp = new URLSearchParams();
  for (const k of ORDERS_DRILL_KEYS) {
    const v = p[k];
    if (v) sp.set(k, v);
  }
  if (![...sp.keys()].length) return null;
  if (label) sp.set(DRILL_LABEL_PARAM, label);
  return `/orders?${sp.toString()}`;
}

/** Parses the drill params back out of /orders' URL (the round trip is tested). */
export function parseDrillParams(sp: URLSearchParams): OrdersDrillParams | null {
  const out: OrdersDrillParams = {};
  let any = false;
  for (const k of ORDERS_DRILL_KEYS) {
    const v = sp.get(k)?.trim();
    if (!v) continue;
    // Days must be real days; anything else would silently widen the list.
    if (/(_from|_to)$/.test(k) && !isYmd(v)) continue;
    out[k] = v;
    any = true;
  }
  return any ? out : null;
}

export type Outcome = OverviewBucketKey | 'to_pack' | 'to_collect' | 'lost';

/** The /orders filter behind ONE source row, or null when the row is not counted
 *  from `orders` (drill.sale_source empty → the numbers are shown without links). */
export function sourceDrill(
  src: Pick<OverviewSource, 'drill' | 'web_block'>,
  range: DayRange,
  extra: Partial<OrdersDrillParams> = {},
): OrdersDrillParams | null {
  const ss = src.drill?.sale_source ?? [];
  // web_block: the row's numbers come from the shop mirror, which is not `orders`.
  if (!ss.length || src.web_block === true) return null;
  return { sale_source: ss.join(','), created_from: range.from, created_to: range.to, ...extra };
}

/**
 * A split chip's filter. The server says so per split (`drill`, null = not an
 * orders filter); an older payload without it links only when the key is a
 * sale_source_detail the row lists.
 */
export function splitDrill(src: OverviewSource, split: OverviewSplit | string, range: DayRange): OrdersDrillParams | null {
  const sp = typeof split === 'string' ? { key: split } as OverviewSplit : split;
  if (src.web_block === true) return null;
  if ('drill' in sp) {
    const d = sp.drill;
    if (!d || !(d.sale_source ?? []).length) return null;
    return {
      sale_source: d.sale_source.join(','),
      ...((d.detail ?? []).length ? { sale_source_detail: d.detail!.join(',') } : {}),
      created_from: range.from, created_to: range.to,
    };
  }
  if (!(src.drill?.detail ?? []).includes(sp.key)) return null;
  return sourceDrill(src, range, { sale_source_detail: sp.key });
}

/** outcome filters behind the composite numbers (comma list = any of). */
export const OUTCOME = {
  /** The shop panel's "being prepared": to pack + packed. */
  preparingAll: 'preparing,packed',
  toCollect: 'preparing,packed,courier',
  lost: 'lost',
} as const;

// ── Numbers ─────────────────────────────────────────────────────────────────

/** Every bucket that is an order (Σ = placed). `mex_only` parcels are not. */
const PLACED_BUCKETS: (OverviewBucketKey | 'no_record')[] = [
  'awaiting', 'preparing', 'packed', 'courier', 'delivered', 'returned', 'cancelled', 'trashed', 'no_record',
];

const num = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const hasNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Orders placed in a row: the server's `placed`, else Σ buckets (each order is in exactly one). */
export function placedOf(src: Pick<OverviewSource, 'buckets' | 'placed'>): { count: number; value_eur: number } {
  if (src.placed && hasNum(src.placed.count)) {
    return { count: src.placed.count, value_eur: num(src.placed.value_eur) };
  }
  let count = 0, value = 0;
  for (const b of PLACED_BUCKETS) {
    count += num(src.buckets[b]?.count);
    value += num(src.buckets[b]?.value_eur);
  }
  return { count, value_eur: value };
}

/** The shop panel's "being prepared" = to pack (`preparing`) + `packed`. */
export function preparingOf(src: Pick<OverviewSource, 'buckets'>): { count: number; value_eur: number | null; packed: number; toPack: number } {
  const toPack = num(src.buckets.preparing?.count);
  const packed = num(src.buckets.packed?.count);
  const v = [src.buckets.preparing?.value_eur, src.buckets.packed?.value_eur].filter(hasNum);
  return { count: toPack + packed, value_eur: v.length ? v.reduce((a, b) => a + b, 0) : null, packed, toPack };
}

/** Cash that landed in the window for a row (cash clock); falls back to the cohort. */
export function cashOf(src: OverviewSource): Measure & { proven_count: number | null; proven_cod_mkd: number | null } {
  const c = src.cash;
  if (c) {
    return {
      count: hasNum(c.count) ? c.count : null,
      cod_mkd: hasNum(c.cod_mkd) ? c.cod_mkd : null,
      proven_count: hasNum(c.proven_count) ? c.proven_count : (hasNum(c.count) ? c.count : null),
      proven_cod_mkd: hasNum(c.proven_cod_mkd) ? c.proven_cod_mkd : (hasNum(c.cod_mkd) ? c.cod_mkd : null),
      unproven_count: c.unproven_count ?? null,
      unproven_cod_mkd: c.unproven_cod_mkd ?? null,
      mex_only_count: c.mex_only_count ?? null,
      mex_only_cod_mkd: c.mex_only_cod_mkd ?? null,
    };
  }
  const d = src.buckets.delivered;
  const cod = hasNum(src.money?.collected_mkd) ? src.money!.collected_mkd! : (hasNum(d?.cod_mkd) ? d!.cod_mkd! : null);
  return { count: d?.count ?? null, cod_mkd: cod, proven_count: d?.count ?? null, proven_cod_mkd: cod };
}

export type TileKey = 'placed' | 'confirmed' | 'at_courier' | 'delivered' | 'to_collect' | 'lost' | 'unproven_paid';

/** A derived measure: `count` is null when it cannot be split by source. */
export interface Measure {
  count: number | null;
  value_eur?: number | null;
  cod_mkd?: number | null;
  proven_count?: number | null;
  proven_cod_mkd?: number | null;
  unproven_count?: number | null;
  unproven_cod_mkd?: number | null;
  mex_only_count?: number | null;
  mex_only_cod_mkd?: number | null;
}
export type MeasureSet = Record<TileKey, Measure>;

/**
 * KPI values for a subset of sources, summed from their rows — each tile on its
 * own clock, exactly as the server sums the tiles (Σ sources = tiles). Only the
 * "lost" count is not split by source (returned + cancelled AFTER a sale).
 */
export function deriveKpis(sources: OverviewSource[], whole: OverviewKpiSet): MeasureSet {
  const sum = (f: (s: OverviewSource) => number | null | undefined) => {
    let any = false, t = 0;
    for (const s of sources) { const v = f(s); if (hasNum(v)) { any = true; t += v; } }
    return any ? t : null;
  };
  const cash = sources.map((s) => [s, cashOf(s)] as const);
  const csum = (f: (c: ReturnType<typeof cashOf>, s: OverviewSource) => number | null | undefined) => {
    let any = false, t = 0;
    for (const [s, c] of cash) { const v = f(c, s); if (hasNum(v)) { any = true; t += v; } }
    return any ? t : null;
  };
  const perSourceUnproven = sources.length > 0 && sources.every((s) => s.cash && hasNum(s.cash.unproven_count));
  return {
    placed: { count: sum((s) => placedOf(s).count), value_eur: sum((s) => placedOf(s).value_eur) },
    confirmed: { count: sum((s) => s.confirmed), value_eur: sum((s) => s.confirmed_value_eur) },
    at_courier: { count: sum((s) => s.buckets.courier?.count), value_eur: sum((s) => s.buckets.courier?.value_eur) },
    delivered: {
      count: csum((c) => c.count),
      cod_mkd: csum((c) => c.cod_mkd),
      proven_count: csum((c) => c.proven_count),
      proven_cod_mkd: csum((c) => c.proven_cod_mkd),
      mex_only_count: csum((c) => c.mex_only_count),
      mex_only_cod_mkd: csum((c) => c.mex_only_cod_mkd),
    },
    to_collect: {
      count: sum((s) => preparingOf(s).count + num(s.buckets.courier?.count)),
      value_eur: sum((s) => s.money?.to_collect_eur),
    },
    lost: { count: null, value_eur: sum((s) => s.money?.lost_eur) },
    unproven_paid: perSourceUnproven
      ? { count: sum((s) => s.cash?.unproven_count), cod_mkd: sum((s) => s.cash?.unproven_cod_mkd), value_eur: null }
      : { ...whole.unproven_paid },
  };
}

export function measureSetOf(k: OverviewKpiSet): MeasureSet {
  return {
    placed: k.placed, confirmed: k.confirmed, at_courier: k.at_courier, delivered: k.delivered,
    to_collect: k.to_collect, lost: k.lost, unproven_paid: k.unproven_paid,
  };
}

/**
 * Which number a tile leads with. Money tiles lead with money for owners only.
 * The hero is MEX-PROVEN cash (proven_cod_mkd) — claims without a delivered
 * parcel are the "unproven" tile, never the hero.
 */
export function primaryOf(tile: TileKey, m: Measure | undefined, money: boolean): number | null {
  if (!m) return null;
  if (tile === 'delivered') {
    if (money) return hasNum(m.proven_cod_mkd) ? m.proven_cod_mkd : hasNum(m.cod_mkd) ? m.cod_mkd : null;
    return hasNum(m.proven_count) ? m.proven_count : hasNum(m.count) ? m.count : null;
  }
  if (money && (tile === 'placed' || tile === 'to_collect' || tile === 'lost')) return hasNum(m.value_eur) ? m.value_eur : null;
  return hasNum(m.count) ? m.count : null;
}

/** Up is good for sales, bad for losses, neither for work in flight. */
export const TILE_GOOD_WHEN: Record<TileKey, 'up' | 'down' | 'neutral'> = {
  placed: 'up', confirmed: 'up', delivered: 'up', at_courier: 'neutral', to_collect: 'neutral',
  lost: 'down', unproven_paid: 'down',
};

export interface Delta {
  dir: 'up' | 'down' | 'flat' | 'new' | 'none';
  /** Signed fraction (0.059 = +5.9 %); null when there is no base to divide by. */
  pct: number | null;
  tone: 'good' | 'bad' | 'neutral';
}

export function delta(cur: number | null | undefined, prev: number | null | undefined, goodWhen: 'up' | 'down' | 'neutral'): Delta {
  if (!hasNum(cur) || !hasNum(prev)) return { dir: 'none', pct: null, tone: 'neutral' };
  if (cur === prev) return { dir: 'flat', pct: 0, tone: 'neutral' };
  const dir: 'up' | 'down' = cur > prev ? 'up' : 'down';
  const tone = goodWhen === 'neutral' ? 'neutral' : (dir === goodWhen ? 'good' : 'bad');
  if (prev === 0) return { dir: 'new', pct: null, tone };
  return { dir, pct: (cur - prev) / Math.abs(prev), tone };
}

/** Sums the trend into one series for the selected sources. */
export function seriesFromTrend(
  points: OverviewTrendPoint[],
  sources: OverviewSourceKey[],
  field: 'placed_value_eur' | 'delivered_cash_mkd' | 'placed_count' | 'delivered_count',
): OverviewSparkPoint[] {
  return points.map((p) => {
    let v = 0;
    for (const s of sources) v += num(p.by_source[s]?.[field]);
    return { d: p.bucket, v };
  });
}

/**
 * A share as text that never lies by rounding (ported from the shop panel):
 * something is never "0 %" and a part is never "100 %".
 */
export function shareText(n: number, of: number, lang: string): string {
  if (!(of > 0)) return '—';
  if (n === 0) return '0%';
  if (n === of) return '100%';
  const v = (n / of) * 100;
  const digits = v < 1 || v > 99 ? 1 : 0;
  const shown = v < 1 ? Math.max(0.1, Math.round(v * 10) / 10) : v > 99 ? Math.min(99.9, Math.floor(v * 10) / 10) : Math.round(v);
  return `${fmtNum(shown, lang, digits)}%`;
}

/**
 * Numbers are grouped by hand, not with Intl: the browser's locale data for
 * mk / sq is not everywhere (headless Chromium prints "1,051" for mk-MK), and a
 * count must group the same way as the денари beside it ("1.051 · 2.490 ден").
 * English keeps its own marks.
 */
const marks = (lang: string) => (lang === 'en' ? { group: ',', dec: '.' } : { group: '.', dec: ',' });

function groupDigits(int: string, sep: string): string {
  let out = '';
  for (let i = 0; i < int.length; i++) {
    if (i > 0 && (int.length - i) % 3 === 0) out += sep;
    out += int[i];
  }
  return out;
}

/** Fixed-digit number with the reader's marks: fmtNum(57.84, 'mk', 1) → "57,8". */
export function fmtNum(x: number, lang: string, digits = 0): string {
  const { group, dec } = marks(lang);
  const neg = x < 0;
  const [i, f] = Math.abs(x).toFixed(digits).split('.');
  return `${neg ? '-' : ''}${groupDigits(i, group)}${f ? dec + f : ''}`;
}

export const fmtInt = (n: number | null | undefined, lang: string) =>
  hasNum(n) ? fmtNum(Math.round(n), lang, 0) : '—';

export function fmtPct(x: number | null | undefined, lang: string, digits = 1): string {
  if (!hasNum(x)) return '—';
  return `${fmtNum(x * 100, lang, digits)}%`;
}

/** Axis-tick compaction: 950 · 12 k · 1.2 M → the caller wraps unit words via i18n. */
export function compactParts(v: number): { n: string; unit: '' | 'k' | 'm' } {
  const a = Math.abs(v);
  if (a >= 1_000_000) return { n: trimZero((v / 1_000_000).toFixed(a >= 10_000_000 ? 0 : 1)), unit: 'm' };
  if (a >= 1_000) return { n: trimZero((v / 1_000).toFixed(a >= 10_000 ? 0 : 1)), unit: 'k' };
  return { n: String(Math.round(v)), unit: '' };
}
const trimZero = (s: string) => s.replace(/\.0$/, '');

/** "N minutes ago" in whole units; `now` for anything under a minute. */
export function agoParts(iso: string | null | undefined, now: number): { unit: 'now' | 'min' | 'hour' | 'day'; n: number } | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const min = Math.max(0, Math.floor((now - t) / 60_000));
  if (min < 1) return { unit: 'now', n: 0 };
  if (min < 60) return { unit: 'min', n: min };
  const h = Math.floor(min / 60);
  if (h < 48) return { unit: 'hour', n: h };
  return { unit: 'day', n: Math.floor(h / 24) };
}

// ── Owners-only money ───────────────────────────────────────────────────────

const MONEY_KEY = /(_eur|_mkd)$/;

/**
 * The payload a non-owner admin/manager receives: every money key removed,
 * counts kept (contract). Used for the dev fixture and the no-money tests —
 * the UI itself only ever trusts meta.money from the server.
 */
export function stripMoney(p: OverviewResponse): OverviewResponse {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        if (MONEY_KEY.test(k) || k === 'placed_value') continue;
        out[k] = walk(x);
      }
      return out;
    }
    return v;
  };
  const stripped = walk(p) as OverviewResponse;
  stripped.meta = { ...stripped.meta, money: false };
  delete stripped.kpis.spark;   // the api drops the whole spark block for a non-owner
  for (const s of stripped.sources) s.money = null;
  return stripped;
}

// ── Teams ───────────────────────────────────────────────────────────────────

export type MemberSortKey =
  | 'name' | 'state' | 'online' | 'active' | 'idle' | 'break' | 'worked' | 'confirmed'
  | 'conversion' | 'sold' | 'cash' | 'alerts';

const STATE_RANK: Record<string, number> = { online: 0, idle: 1, break: 2, offline: 3, 'n/a': 4 };

const memberValue = (m: OverviewTeamMember, k: MemberSortKey): number | string => {
  switch (k) {
    case 'name': return m.name.toLocaleLowerCase();
    case 'state': return STATE_RANK[m.online_state] ?? 9;
    case 'online': return num(m.online_min);
    case 'active': return num(m.active_min);
    case 'idle': return num(m.idle_min);
    case 'break': return num(m.break_min);
    case 'worked': return num(m.worked);
    case 'confirmed': return num(m.confirmed);
    case 'conversion': return num(m.conversion);
    case 'sold': return num(m.sold_value_eur);
    case 'cash': return num(m.delivered_cash_mkd);
    case 'alerts': return num(m.idle_alerts);
  }
};

/**
 * Sorted copy. With no explicit column the board's rule applies: sold, then
 * worked, then time online (confirmed stands in for sold without money) — so
 * people who logged in and sold nothing are still listed, just lower.
 */
export function sortMembers(
  members: OverviewTeamMember[],
  sort: { key: MemberSortKey; dir: 'asc' | 'desc' } | null,
  money: boolean,
): OverviewTeamMember[] {
  const keys: { key: MemberSortKey; dir: 'asc' | 'desc' }[] = sort
    ? [sort, { key: 'name', dir: 'asc' }]
    : [{ key: money ? 'sold' : 'confirmed', dir: 'desc' }, { key: 'worked', dir: 'desc' }, { key: 'online', dir: 'desc' }, { key: 'name', dir: 'asc' }];
  return [...members].sort((a, b) => {
    for (const { key, dir } of keys) {
      const x = memberValue(a, key), y = memberValue(b, key);
      if (x === y) continue;
      const c = x < y ? -1 : 1;
      return dir === 'asc' ? c : -c;
    }
    return 0;
  });
}

// ── Pivot ───────────────────────────────────────────────────────────────────

const PIVOT_MEASURES = ['count', 'sold', 'placed_value_eur', 'value_eur', 'delivered', 'delivered_cash_mkd', 'returned', 'lost'] as const;

/** The server's "nothing here" values in a pivot dimension. */
export const PIVOT_NONE = new Set(['(none)', '(unknown)', '']);

/** Groups pivot rows to the given `dims`, summing the measures. Used on every
 *  response (the server may answer with more dimensions than a level needs).
 *  A `person` dimension keeps its `person_id`. */
export function groupPivotRows(rows: OverviewPivotRow[], dims: string[]): OverviewPivotRow[] {
  const keyDims = dims.includes('person') ? [...dims, 'person_id'] : dims;
  const map = new Map<string, OverviewPivotRow>();
  for (const r of rows) {
    const key = keyDims.map((d) => String(r[d] ?? '')).join('\u0001');
    let g = map.get(key);
    if (!g) {
      g = { count: 0 };
      for (const d of keyDims) {
        g[d] = r[d] ?? null;
        if (r[`${d}_name`] != null) g[`${d}_name`] = r[`${d}_name`];
      }
      map.set(key, g);
    }
    for (const m of PIVOT_MEASURES) {
      const v = r[m];
      if (typeof v === 'number' && Number.isFinite(v)) g[m] = num(g[m] as number | undefined) + v;
    }
  }
  return [...map.values()];
}

/** The /orders filter for one pivot leaf dimension (null = the pivot reports a
 *  name that /orders cannot filter on exactly, e.g. a webmaster's display name). */
export const PIVOT_LEAF_PARAM: Record<string, keyof OrdersDrillParams | null> = {
  detail: 'sale_source_detail', list: 'prediction_list', webmaster: null, stream: 'cpa_stream', product: 'product', city: 'city',
};
