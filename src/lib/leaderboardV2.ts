// ── TV leaderboard v2 (owner, 28–29.09.2026) ────────────────────────────────
// One board, one row per agent, the day split over the six departments + the
// collabBox bookings still waiting for their parcel. The payload is built by
// public.leaderboard_day_v2 (migration 20260942001200) and served by
// GET /api/leaderboard?v=2 (supabase/functions/api/leaderboardV2.ts); this file
// holds the client types, the fetcher and the pure helpers the TV page uses.
//
// Rollout: Vercel deploys this page on push, the api is deployed by hand. Until
// the api knows ?v=2 it answers with the old per-mode board — toBoardV2() turns
// that into the same shape (one department, `legacy: true`) so the wall screen
// never goes blank in between.
// Money: every amount is ALREADY денари (*_mkd) — render with formatDenari,
// never formatMoney (that would multiply by the peg a second time).
import { eurToDen } from '@/lib/currency';
import { TEAM_FILTER_RE } from '@/lib/teamLines';

const API_BASE = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/api`;

/** The six departments in the owner's order. */
export const DEPARTMENTS = ['altercpa', 'elyon_crm', 'teleshop_out', 'teleshop_other', 'social', 'web'] as const;
export type Department = typeof DEPARTMENTS[number];
export const isDepartment = (v: unknown): v is Department => (DEPARTMENTS as readonly string[]).includes(String(v));
/** The i18n key of a department under leaderboard2.dept / deptShort: a key
 *  ending in `_other` is an i18next plural form, so teleshop_other is spelled
 *  teleshopOther there (the insights locales do the same). */
export const deptKey = (d: Department): string => (d === 'teleshop_other' ? 'teleshopOther' : d);

export type PresenceStateV2 = 'online' | 'idle' | 'break' | 'offline' | 'n/a';

export interface PresenceV2 {
  state: PresenceStateV2;
  online_min: number;
  active_min: number;
  idle_min: number;
  break_min: number;
  first_seen: string | null;
  last_seen: string | null;
  first_active: string | null;
  last_active: string | null;
  idle_alerts: number;
  idle_streak_min: number | null;
  first_login: string | null;
}

export interface DeptCell {
  sales: number;                 // real orders (confirmed / packed / shipped / paid + returned)
  value_mkd?: number;            // денари: parcel COD, else price × 61,5
  booked: number;                // collabBox bookings awaiting a parcel, counted in the total
  booked_value_mkd?: number;
  booked_twin: number;           // LEADS / LEADS-OUT bookings (and CRM twins) — shown apart, never counted
  booked_twin_value_mkd?: number;
  cancelled_after_sale: number;
  cancelled_value_mkd?: number;
  returned: number;
  live_credited: number;
  worked: number;
  sale_decisions: number;
}

export interface BoardRow {
  person_id: string;
  user_id: string | null;        // null = no CRM login (AlterCPA / collabBox only)
  name: string;
  team_key: string | null;       // primary team that day — a badge only
  team_name: string | null;
  /** The lane inside the business line (in | out | social) — absent from an older api. */
  team_lane?: string | null;
  /** sales_teams.kind: line | management | legacy. */
  team_kind?: string | null;
  is_member: boolean;
  is_manager: boolean;           // shown, never ranked
  rank: number | null;
  sales: number;
  value_mkd?: number;
  booked: number;
  booked_value_mkd?: number;
  total_count: number;           // sales + booked
  total_value_mkd?: number;
  cancelled_after_sale: number;
  cancelled_value_mkd?: number;
  returned: number;
  live_credited: number;
  booked_twin: number;
  booked_twin_value_mkd?: number;
  worked: number;                // the whole day — or, with ?department, that department's (20260944000600)
  sale_decisions: number;
  cancelled: number;
  trashed: number;
  callbacks: number;
  conversion: number | null;     // 0–1
  last_decision_at: string | null;
  departments: Partial<Record<Department, DeptCell>>;
  presence: PresenceV2;
}

/** A team on the filter bar in sales_teams.sort_order order; a business line carries its lanes
 *  (lane.key = 'team:lane' is itself a filter value, 20260943000950). */
export interface BoardTeam {
  key: string;
  name: string | null;
  people: number;
  kind?: string | null;
  sort_order?: number | null;
  lanes?: Array<{ lane: string; key: string; people: number }>;
}

export interface BoardV2 {
  version: 2;
  day: string;
  today: string;
  is_today: boolean;
  generated_at: string;
  money: boolean;
  filter: { department: Department | null; team: string | null };
  departments: Department[];
  teams: BoardTeam[];
  summary: Record<string, number>;
  day_totals: Record<string, unknown>;
  rows: BoardRow[];
  /** true = the api still served the old per-mode board (adapted here). */
  legacy?: boolean;
  /** The web shop's day (only with department=web; null = the api could not read it; absent = old api). */
  web_live?: WebLive | null;
}

/** The TV board's web view (leaderboard_web_live, 20260942001940): the shop itself, it has no agents. */
export interface WebLive {
  day: string;
  /** The cohort's web part of the day — the Overview's number: the shop's orders ("чека потврда"
   *  included, 20260942001965) and the day's MEX web parcels with no shop order (20260942001967). */
  orders: number;
  value_mkd?: number;
  all_orders: number;
  card: number;
  cod: number;
  /** Counted orders still waiting for the shop's confirmation (absent from an older api → 0). */
  awaiting?: number;
  awaiting_value_mkd?: number;
  /** Counted MEX web parcels (M… / NTMK…) with no order in the shop mirror (absent → 0). */
  mex_only?: number;
  mex_only_value_mkd?: number;
  by_outcome: Array<{ key: string; count: number; value_mkd?: number }>;
  latest: Array<{
    /** 'mex' = a MEX web parcel with no shop order: tracking id, city, COD — no product. */
    kind?: 'web' | 'mex';
    at: string | null; number: string | null; city: string | null; total_mkd?: number; outcome: string;
    payment: 'card' | 'cod'; counted: boolean; source: string | null; item: string | null; items: number;
  }>;
  last_order_at: string | null;
  synced_at: string | null;
}

export interface BoardFilter { department: Department | null; team: string | null }

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const PRESENCE = new Set<PresenceStateV2>(['online', 'idle', 'break', 'offline', 'n/a']);

function presenceOf(p: unknown, hasLogin: boolean): PresenceV2 {
  const x = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
  const st = x.state as PresenceStateV2;
  const s = (k: string) => (typeof x[k] === 'string' ? (x[k] as string) : null);
  return {
    state: PRESENCE.has(st) ? st : hasLogin ? 'offline' : 'n/a',
    online_min: num(x.online_min), active_min: num(x.active_min), idle_min: num(x.idle_min), break_min: num(x.break_min),
    first_seen: s('first_seen'), last_seen: s('last_seen'), first_active: s('first_active'), last_active: s('last_active'),
    idle_alerts: num(x.idle_alerts),
    idle_streak_min: x.idle_streak_min == null ? null : num(x.idle_streak_min),
    first_login: s('first_login'),
  };
}

/** The old board's mode → the department it showed (sale_source decided the board). */
const LEGACY_MODE_DEPT: Record<string, Department> = { prediction: 'elyon_crm', pending: 'altercpa' };

/** A v2 payload as is; a pre-v2 per-mode board (the api not deployed yet) in the v2 shape. */
export function toBoardV2(data: unknown, filter: BoardFilter): BoardV2 {
  const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  if (d.version === 2) {
    const b = d as unknown as BoardV2;
    return { ...b, rows: Array.isArray(b.rows) ? b.rows : [], teams: Array.isArray(b.teams) ? b.teams : [], summary: b.summary ?? {} };
  }
  // ── legacy: { mode, day, today, agents[] } (supabase/functions/api/leaderboard.ts) ──
  const dept = LEGACY_MODE_DEPT[String(d.mode)] ?? 'elyon_crm';
  const agents = Array.isArray(d.agents) ? (d.agents as Record<string, unknown>[]) : [];
  const rows: BoardRow[] = agents.map((a) => {
    const sales = num(a.sales ?? a.confirmed_count);
    const value = eurToDen(num(a.sold_value_eur ?? a.revenue));
    const userId = typeof a.user_id === 'string' ? a.user_id : null;
    const conv = a.conversion_pct == null ? null : num(a.conversion_pct) / 100;
    const cell: DeptCell = {
      sales, value_mkd: value, booked: 0, booked_value_mkd: 0, booked_twin: 0, booked_twin_value_mkd: 0,
      cancelled_after_sale: num(a.lost), cancelled_value_mkd: 0, returned: num(a.returned), live_credited: num(a.live_credited),
      worked: num(a.worked), sale_decisions: num(a.sale_decisions),
    };
    return {
      person_id: String(a.key ?? a.person_id ?? userId ?? a.full_name ?? ''),
      user_id: userId,
      name: String(a.full_name ?? 'Agent'),
      team_key: typeof a.team_key === 'string' ? a.team_key : null,
      team_name: typeof a.team_name === 'string' ? a.team_name : null,
      is_member: !!a.is_member,
      is_manager: !!(a.is_manager ?? a.is_super),
      rank: null,
      sales, value_mkd: value, booked: 0, booked_value_mkd: 0, total_count: sales, total_value_mkd: value,
      cancelled_after_sale: num(a.lost), cancelled_value_mkd: 0, returned: num(a.returned), live_credited: num(a.live_credited),
      booked_twin: 0, booked_twin_value_mkd: 0,
      worked: num(a.worked), sale_decisions: num(a.sale_decisions), cancelled: num(a.cancelled), trashed: num(a.trashed),
      callbacks: num(a.callbacks), conversion: conv,
      last_decision_at: typeof a.last_decision_at === 'string' ? a.last_decision_at : null,
      departments: sales > 0 || cell.worked > 0 ? { [dept]: cell } : {},
      presence: presenceOf(a.presence, !!userId),
    };
  });
  const ordered = rankRows(rows);
  const s = (d.summary && typeof d.summary === 'object' ? d.summary : {}) as Record<string, unknown>;
  return {
    version: 2,
    day: String(d.day ?? ''),
    today: String(d.today ?? d.day ?? ''),
    is_today: !!d.is_today,
    generated_at: String(d.generated_at ?? new Date().toISOString()),
    money: true,
    filter: { department: dept, team: filter.team },
    departments: [...DEPARTMENTS],
    teams: [],
    summary: {
      people: ordered.length,
      online_now: num(s.online_now), idle: num(s.idle), on_break: num(s.on_break), offline: num(s.offline),
      no_login: num(s.no_login), was_online: num(s.was_online),
      sales: ordered.reduce((a, r) => a + r.sales, 0),
      value_mkd: ordered.reduce((a, r) => a + (r.value_mkd ?? 0), 0),
      booked: 0, booked_value_mkd: 0,
      total_count: ordered.reduce((a, r) => a + r.total_count, 0),
      total_value_mkd: ordered.reduce((a, r) => a + (r.total_value_mkd ?? 0), 0),
      worked: ordered.reduce((a, r) => a + r.worked, 0),
      sale_decisions: ordered.reduce((a, r) => a + r.sale_decisions, 0),
      no_seller: num(s.unattributed_sales),
      no_seller_value_mkd: eurToDen(num(s.unattributed_value_eur)),
    },
    day_totals: {},
    rows: ordered,
    legacy: true,
  };
}

/** leaderboard_day_v2's order, for rows built on the client (the legacy board):
 *  non-managers with a total ranked by денари then count (equal numbers share a
 *  place), then the rest of the non-managers, then the managers. */
export function rankRows(rows: BoardRow[]): BoardRow[] {
  const ranked = rows.filter((r) => !r.is_manager && r.total_count > 0).map((r) => ({ ...r }))
    .sort((a, b) => (num(b.total_value_mkd) - num(a.total_value_mkd)) || (b.total_count - a.total_count) || a.name.localeCompare(b.name));
  ranked.forEach((r, i) => {
    const prev = i > 0 ? ranked[i - 1] : null;
    r.rank = prev && num(prev.total_value_mkd) === num(r.total_value_mkd) && prev.total_count === r.total_count ? prev.rank : i + 1;
  });
  const rest = rows.filter((r) => !r.is_manager && r.total_count === 0).map((r) => ({ ...r, rank: null }))
    .sort((a, b) => (b.worked - a.worked) || a.name.localeCompare(b.name));
  const managers = rows.filter((r) => r.is_manager).map((r) => ({ ...r, rank: null }))
    .sort((a, b) => (num(b.total_value_mkd) - num(a.total_value_mkd)) || a.name.localeCompare(b.name));
  return [...ranked, ...rest, ...managers];
}

/** The rows the board ranks and the managers listed after them. */
export function splitManagers(rows: BoardRow[]): { people: BoardRow[]; managers: BoardRow[] } {
  return { people: rows.filter((r) => !r.is_manager), managers: rows.filter((r) => r.is_manager) };
}

export interface DeptChip { dept: Department; sales: number; value_mkd: number }

/** The department chips of a row: every department with a sale, in the owner's
 *  order (only the filter's department when one is chosen). */
export function deptChips(row: BoardRow, department: Department | null = null): DeptChip[] {
  const out: DeptChip[] = [];
  for (const d of DEPARTMENTS) {
    if (department && d !== department) continue;
    const c = row.departments[d];
    if (c && c.sales > 0) out.push({ dept: d, sales: c.sales, value_mkd: num(c.value_mkd) });
  }
  return out;
}

/** The collabBox bookings a row counts (awaiting a parcel), per department. */
export function bookedChips(row: BoardRow, department: Department | null = null): Array<{ dept: Department; booked: number; value_mkd: number }> {
  const out: Array<{ dept: Department; booked: number; value_mkd: number }> = [];
  for (const d of DEPARTMENTS) {
    if (department && d !== department) continue;
    const c = row.departments[d];
    if (c && c.booked > 0) out.push({ dept: d, booked: c.booked, value_mkd: num(c.booked_value_mkd) });
  }
  return out;
}

// ── the day on screen (the arrows and the date picker) ──────────────────────
/** The first day the board opens: the web history is complete from here (owner, 29.09.2026 —
 *  the gap 30.07–03.09.2026 is filled from the MEX web parcels, 20260942001967). */
export const BOARD_FIRST_DAY = '2026-01-01';
const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** A calendar day ± n days (YYYY-MM-DD, no time zone involved). */
export function addDaysYmd(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Whole days from `a` to `b` (b − a); both YYYY-MM-DD. */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/**
 * The day the board should show for a wanted day: null = today, live (a day on or after `today`,
 * or anything that is not a real YYYY-MM-DD); a day before BOARD_FIRST_DAY opens that first day.
 * `today` is the server's Skopje day (BoardV2.today) — never the TV's own clock.
 */
export function boardDay(wanted: string | null | undefined, today: string): string | null {
  if (!wanted || !YMD.test(wanted) || Number.isNaN(Date.parse(`${wanted}T00:00:00Z`))) return null;
  if (addDaysYmd(wanted, 0) !== wanted) return null;              // 2026-02-31 and friends
  if (YMD.test(today) && wanted >= today) return null;
  return wanted < BOARD_FIRST_DAY ? BOARD_FIRST_DAY : wanted;
}

/** The web view's confirmed orders: the counted ones the shop no longer shows as "чека потврда". */
export const webConfirmed = (w: Pick<WebLive, 'orders' | 'awaiting'>): number => Math.max(0, (w.orders ?? 0) - (w.awaiting ?? 0));

/** Conversion as a percentage with one decimal, or null. */
export const conversionPct = (row: Pick<BoardRow, 'conversion'>): number | null =>
  row.conversion == null || !Number.isFinite(Number(row.conversion)) ? null : Math.round(Number(row.conversion) * 1000) / 10;

/** The old TV URLs carried ?mode=prediction|pending (one board per team): they open the v2
 *  board on that team's ALIAS — the teams became business lines on 30.09.2026 and the server
 *  (sales_team_filter_matches, 20260943000950) reads altercpa_leads as the old team + Affiliate
 *  lane in ("Affiliate лидови"), crm_prediction as the old team + lane out on every line
 *  ("предикција"), so an old link shows the same people before and after the re-key.
 *  ?dept= / ?department= and ?team= win; ?team= takes 'team:lane' too. */
export const LEGACY_MODE_TEAM: Record<string, string> = { prediction: 'crm_prediction', pending: 'altercpa_leads' };
export function initialFilter(params: URLSearchParams): BoardFilter {
  const dRaw = params.get('dept') ?? params.get('department');
  const department = isDepartment(dRaw) ? dRaw : null;
  const tRaw = (params.get('team') ?? '').trim();
  const team = TEAM_FILTER_RE.test(tRaw) ? tRaw : null;
  if (department || team) return { department, team };
  const mode = params.get('mode') ?? '';
  return { department: null, team: LEGACY_MODE_TEAM[mode] ?? null };
}

export async function apiGetLeaderboardV2(key: string, opts: { day?: string } & BoardFilter): Promise<BoardV2> {
  const qs = new URLSearchParams({ key, v: '2' });
  if (opts.day) qs.set('day', opts.day);
  if (opts.department) qs.set('department', opts.department);
  if (opts.team) qs.set('team', opts.team);
  const res = await fetch(`${API_BASE}/leaderboard?${qs.toString()}`, {
    headers: { apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || 'Leaderboard error');
  return toBoardV2(data, { department: opts.department, team: opts.team });
}
