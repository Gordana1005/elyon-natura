/**
 * Insights → Агенти: the pure rules behind the tab — rates, links, sorting,
 * leaderboards, the reconciliation with the cohort, the CSV. No React, no
 * network: model.test.ts covers it against the live-shaped fixture.
 */
import type {
  NoSellerRow, PeopleBuckets, PeopleMeasures, PeopleMember, PeoplePerson, PeopleResponse, PeopleTeam,
} from '@/lib/insightsApi/agents';
import { DRILL_LABEL_PARAM } from '../overview/model';
import type { DayRange } from '../shared/period';

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

// ── rates (one definition each) ─────────────────────────────────────────────

/** Below this many active minutes a per-hour rate is noise ("—"). */
export const RATE_MIN_ACTIVE_MIN = 30;
/** Leaderboard floors: a rate over a handful of cases is luck, not skill. */
export const BOARD_MIN_WORKED = 30;
export const BOARD_MIN_CLOSED = 10;

/** Sales that are finished: paid (MEX, or legacy) or returned. */
export const closedOf = (b: PeopleBuckets) => num(b.paid) + num(b.paid_legacy) + num(b.returned);

export interface Rates {
  /** sale decisions ÷ worked decisions */
  conversion: number | null;
  /** MEX-proven paid ÷ sales */
  paidShare: number | null;
  /** returned ÷ (paid + returned) — of the finished sales */
  returnRate: number | null;
  /** still open: at the courier, packed, to pack */
  open: number;
  /** value ÷ sales (owners) */
  aov: number | null;
  /** packages ÷ sales */
  packagesPerSale: number | null;
  /** sale decisions on presence days ÷ active hours */
  salesPerActiveHour: number | null;
}

export function ratesOf(m: PeopleMeasures): Rates {
  const b = m.buckets;
  const closed = closedOf(b);
  const active = m.presence?.active_min ?? null;
  return {
    conversion: m.worked > 0 ? m.sale_decisions / m.worked : null,
    paidShare: m.sales > 0 ? num(b.paid) / m.sales : null,
    returnRate: closed > 0 ? num(b.returned) / closed : null,
    open: num(b.courier) + num(b.courier_problem) + num(b.label) + num(b.to_pack),
    aov: m.value_mkd != null && m.sales > 0 ? m.value_mkd / m.sales : null,
    packagesPerSale: m.sales > 0 ? m.packages / m.sales : null,
    salesPerActiveHour: active != null && active >= RATE_MIN_ACTIVE_MIN
      ? (m.presence?.sale_decisions ?? 0) / (active / 60) : null,
  };
}

/** Anything to show for this person in the period (sales, work or time). */
export const hasActivity = (m: PeopleMeasures) =>
  m.sales > 0 || m.worked > 0 || num(m.outside?.cancelled_after_sale) > 0 || (m.presence?.days ?? 0) > 0;

// ── links to /orders ────────────────────────────────────────────────────────

export type PartKey = keyof PeopleBuckets | 'total' | 'cancelled_after_sale' | 'trashed_after_sale';

/** /orders?cohort_bucket=…&sold_by_person_id=…&sold_from&sold_to — every sale a
 *  person is credited with is an order, so the list holds exactly the number. */
export function personHref(personId: string, keys: PartKey | PartKey[], range: DayRange, label?: string | null): string {
  const list = Array.isArray(keys) ? keys : [keys];
  const sp = new URLSearchParams();
  sp.set('cohort_bucket', list.includes('total') ? 'total' : list.join(','));
  sp.set('sold_by_person_id', personId);
  sp.set('sold_from', range.from);
  sp.set('sold_to', range.to);
  if (label) sp.set(DRILL_LABEL_PARAM, label);
  return `/orders?${sp.toString()}`;
}

/** A team's numbers link only when /orders?team_key lists exactly them. */
export function teamHref(team: Pick<PeopleTeam, 'key' | 'kind' | 'drill_exact'>, keys: PartKey | PartKey[], range: DayRange, label?: string | null): string | null {
  if (team.kind !== 'team' || !team.drill_exact) return null;
  const list = Array.isArray(keys) ? keys : [keys];
  const sp = new URLSearchParams();
  sp.set('cohort_bucket', list.includes('total') ? 'total' : list.join(','));
  sp.set('team_key', team.key);
  sp.set('sold_from', range.from);
  sp.set('sold_to', range.to);
  if (label) sp.set(DRILL_LABEL_PARAM, label);
  return `/orders?${sp.toString()}`;
}

/** A team member's row covers the person's whole period (so the person link is
 *  exact) unless part of their sales fell in another group. */
export const memberIsWhole = (member: PeopleMember, person: PeoplePerson | undefined) =>
  !!person && member.sales === person.sales &&
  num(member.outside?.cancelled_after_sale) === num(person.outside?.cancelled_after_sale) &&
  num(member.outside?.trashed_after_sale) === num(person.outside?.trashed_after_sale);

// ── teams ───────────────────────────────────────────────────────────────────

// the SQL's order (insights_people tj): the two lead teams, the Teleshop (Lead in) and Social
// media pseudo-groups, management, any other team, nobody's
const TEAM_ORDER: Record<string, number> = { altercpa_leads: 1, crm_prediction: 2, teleshop: 3, social: 4, management: 5, none: 9 };
export const teamOrder = (key: string) => TEAM_ORDER[key] ?? 6;
export const sortTeams = (teams: PeopleTeam[]) => [...teams].sort((a, b) => teamOrder(a.key) - teamOrder(b.key) || a.key.localeCompare(b.key));

/** The call teams go side by side; management and the pseudo-groups below. */
export const isMainTeam = (t: Pick<PeopleTeam, 'mode'>) => t.mode === 'pending' || t.mode === 'prediction';

// ── the people table ────────────────────────────────────────────────────────

export type PeopleSortKey =
  | 'name' | 'team' | 'online' | 'worked' | 'sale_decisions' | 'conversion' | 'sales' | 'paid' | 'open'
  | 'returned' | 'return_rate' | 'cancelled' | 'packages' | 'per_hour' | 'value' | 'aov' | 'paid_value' | 'last';

export interface PeopleSort { key: PeopleSortKey; dir: 'asc' | 'desc' }

/** The default order: by sales for everyone (never by money — that would leak the ranking to a non-owner). */
export const DEFAULT_SORT: PeopleSort = { key: 'sales', dir: 'desc' };

const lastActivity = (p: PeoplePerson) => {
  const a = p.last_decision_at ? Date.parse(p.last_decision_at) : 0;
  const b = p.presence?.last_active_at ? Date.parse(p.presence.last_active_at) : 0;
  return Math.max(a, b) || null;
};
export const lastActivityOf = (p: PeoplePerson): string | null => {
  const v = lastActivity(p);
  return v ? new Date(v).toISOString() : null;
};

function sortValue(p: PeoplePerson, key: PeopleSortKey, teamLabel: (k: string) => string): number | string | null {
  const r = ratesOf(p);
  switch (key) {
    case 'name': return p.name.toLocaleLowerCase();
    case 'team': return teamLabel(p.team_key).toLocaleLowerCase();
    case 'online': return p.presence?.online_min ?? null;
    case 'worked': return p.worked;
    case 'sale_decisions': return p.sale_decisions;
    case 'conversion': return r.conversion;
    case 'sales': return p.sales;
    case 'paid': return num(p.buckets.paid);
    case 'open': return r.open;
    case 'returned': return num(p.buckets.returned);
    case 'return_rate': return r.returnRate;
    case 'cancelled': return num(p.outside.cancelled_after_sale);
    case 'packages': return p.packages;
    case 'per_hour': return r.salesPerActiveHour;
    case 'value': return p.value_mkd ?? null;
    case 'aov': return r.aov;
    case 'paid_value': return p.paid_mkd ?? null;
    case 'last': return lastActivity(p);
  }
}

/** Sorted rows; empty values (—) always last, ties by sales then name. */
export function sortPeople(rows: PeoplePerson[], sort: PeopleSort, teamLabel: (k: string) => string = (k) => k): PeoplePerson[] {
  const dir = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = sortValue(a, sort.key, teamLabel);
    const vb = sortValue(b, sort.key, teamLabel);
    if (va == null && vb != null) return 1;
    if (vb == null && va != null) return -1;
    if (va != null && vb != null && va !== vb) {
      return (typeof va === 'string' ? va.localeCompare(String(vb)) : (va as number) - (vb as number)) * dir;
    }
    return b.sales - a.sales || b.worked - a.worked || a.name.localeCompare(b.name);
  });
}

export interface PeopleFilter {
  search: string;
  teams: string[];
  /** Show roster people with nothing in the period. */
  showIdle: boolean;
}

/** Search ignores case and Latin / Cyrillic diacritics. */
const fold = (s: string) => s.toLocaleLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

export function filterPeople(rows: PeoplePerson[], f: PeopleFilter): PeoplePerson[] {
  const q = fold(f.search.trim());
  return rows.filter((p) =>
    (!q || fold(p.name).includes(q)) &&
    (!f.teams.length || f.teams.includes(p.team_key) || p.groups?.some((g) => f.teams.includes(g))) &&
    (f.showIdle || hasActivity(p)));
}

// ── leaderboards ────────────────────────────────────────────────────────────

export type BoardKey = 'sales' | 'conversion' | 'paid' | 'return_rate' | 'per_hour' | 'value';

export interface BoardEntry { person: PeoplePerson; value: number }

/** Top N per board; a rate board only ranks people above its floor. */
export function leaderboards(rows: PeoplePerson[], money: boolean, n = 5): Record<BoardKey, BoardEntry[] | null> {
  const top = (pick: (p: PeoplePerson) => number | null, asc = false) =>
    rows.map((p) => ({ person: p, value: pick(p) }))
      .filter((e): e is BoardEntry => e.value != null && Number.isFinite(e.value))
      .sort((a, b) => (asc ? a.value - b.value : b.value - a.value) || b.person.sales - a.person.sales || a.person.name.localeCompare(b.person.name))
      .slice(0, n);
  return {
    sales: top((p) => (p.sales > 0 ? p.sales : null)),
    conversion: top((p) => (p.worked >= BOARD_MIN_WORKED ? ratesOf(p).conversion : null)),
    paid: top((p) => (num(p.buckets.paid) > 0 ? num(p.buckets.paid) : null)),
    return_rate: top((p) => (closedOf(p.buckets) >= BOARD_MIN_CLOSED ? ratesOf(p).returnRate : null), true),
    per_hour: top((p) => { const v = ratesOf(p).salesPerActiveHour; return v != null && v > 0 ? v : null; }),
    value: money ? top((p) => (p.value_mkd != null && p.value_mkd > 0 ? p.value_mkd : null)) : null,
  };
}

// ── reconciliation with the cohort ──────────────────────────────────────────

export interface SourceTie { key: string; total: number; people: number; noSeller: number; ok: boolean }

export interface Reconciliation {
  total: number;
  people: number;
  noSeller: number;
  ok: boolean;
  bySource: SourceTie[];
}

/** Σ people's sales + sales with no seller = the cohort total — overall and per source. */
export function reconcile(d: Pick<PeopleResponse, 'totals' | 'people' | 'no_seller'>): Reconciliation | null {
  if (!d.totals || !d.no_seller) return null;
  const people = d.people.reduce((a, p) => a + p.sales, 0);
  const noSeller = num(d.no_seller.count);
  const bySource = d.totals.by_source.map((s) => {
    const pp = d.people.reduce((a, p) => a + num(p.by_source?.[s.key]), 0);
    const ns = d.no_seller!.reasons.filter((r) => r.source === s.key).reduce((a, r) => a + r.count, 0);
    return { key: s.key, total: s.sales, people: pp, noSeller: ns, ok: pp + ns === s.sales };
  });
  return {
    total: d.totals.sales, people, noSeller,
    ok: people + noSeller === d.totals.sales && bySource.every((s) => s.ok),
    bySource,
  };
}

/** The no-seller rows grouped by source, in the fixed source order. */
export function noSellerBySource(rows: NoSellerRow[]): { source: NoSellerRow['source']; rows: NoSellerRow[]; count: number; value_mkd: number | null }[] {
  const order = ['altercpa', 'elyon_crm', 'teleshop_other', 'social', 'web'] as const;
  return order.map((source) => {
    const list = rows.filter((r) => r.source === source);
    const anyValue = list.some((r) => r.value_mkd != null);
    return {
      source, rows: list,
      count: list.reduce((a, r) => a + r.count, 0),
      value_mkd: anyValue ? list.reduce((a, r) => a + num(r.value_mkd), 0) : null,
    };
  }).filter((g) => g.count > 0);
}

// ── CSV ─────────────────────────────────────────────────────────────────────

export interface CsvCol { header: string; get: (p: PeoplePerson) => string | number | null | undefined; money?: boolean }

const csvCell = (v: string | number | null | undefined) => {
  if (v == null) return '';
  const s = String(v);
  return /[",;\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** One row per person; money columns only when the payload carries money. */
export function peopleCsv(rows: PeoplePerson[], cols: CsvCol[], money: boolean): string {
  const shown = cols.filter((c) => money || !c.money);
  const lines = [shown.map((c) => csvCell(c.header)).join(',')];
  for (const p of rows) lines.push(shown.map((c) => csvCell(c.get(p))).join(','));
  // BOM so Excel opens the Cyrillic headers as UTF-8.
  return `﻿${lines.join('\r\n')}\r\n`;
}

// ── Skopje day instants (the bonus block's window) ──────────────────────────

/** Europe/Skopje's UTC offset in minutes at a given instant (+60 CET / +120 CEST). */
function skopjeOffsetMin(at: Date): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Skopje', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at);
  const g = (k: string) => Number(parts.find((p) => p.type === k)?.value);
  const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'));
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60000);
}

/** 00:00 Skopje of a YYYY-MM-DD day as a UTC ISO instant (DST-exact). */
export function skopjeDayStartIso(ymd: string): string {
  const wall = Date.parse(`${ymd}T00:00:00Z`);
  // guess with the day's noon offset, then settle on the offset AT that instant
  const guess = wall - skopjeOffsetMin(new Date(`${ymd}T12:00:00Z`)) * 60000;
  return new Date(wall - skopjeOffsetMin(new Date(guess)) * 60000).toISOString();
}

/** The last millisecond of a Skopje day (the next day's 00:00 − 1 ms). */
export function skopjeDayEndIso(ymd: string): string {
  const next = new Date(Date.parse(`${ymd}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  return new Date(Date.parse(skopjeDayStartIso(next)) - 1).toISOString();
}
