import { apiFetch } from '@/lib/api';

/**
 * Insights → Work ("Активност на повици") — GET /api/insights/work and
 * GET /api/insights/work/day (migration 20260941000600, api insightsWork.ts).
 *
 * Every figure is a count, minutes, seconds or a rate — no money on this tab.
 * Clocks: decisions by the decision instant (Skopje day); call logs by when the
 * agent logged them (AGENT-REPORTED while VOIP is off: a no-answer is the
 * "Не се јавува" click, a timed call is Call/End pressed in the CRM — not
 * proof anyone picked up); presence only exists from meta.presence_since
 * (28.09.2026); credited sales are the cohort's (sale day); callbacks are NOW.
 */

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
  /** The cohort's credited sales (null: the cohort scan failed). */
  credited: number | null;
  /** Decisions / sale decisions on days the person has presence (the per-hour numerators). */
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
  conversion: number | null;
  reach: number | null;
  per_active_hour: number | null;
  sales_per_active_hour: number | null;
  avg_handling_sec: number | null;
  per_active_day: number | null;
}

export type WorkOnlineState = 'online' | 'idle' | 'break' | 'offline' | 'n/a';

export interface WorkPerson extends WorkCounts, WorkRates {
  person_id: string;
  name: string;
  has_login: boolean;
  is_manager: boolean;
  is_active: boolean;
  team_key: string;
  /** The lane inside the business line (in | out | social) — absent from an older api. */
  team_lane?: string | null;
  role: string;
  online_state: WorkOnlineState | string;
  days_active: number;
  presence_days: number;
  first_at: string | null;
  last_at: string | null;
  /** Average minutes-of-day (Skopje) of the first / last activity across active days. */
  avg_start_min: number | null;
  avg_end_min: number | null;
  last_decision_at: string | null;
  first_active: string | null;
  last_active: string | null;
}

export interface WorkTeam {
  team_key: string;
  name: string | null;
  mode: 'pending' | 'prediction' | string | null;
  /** sales_teams.kind: line | management | legacy (absent from an older api). */
  kind?: string | null;
  sort_order?: number | null;
  totals: WorkCounts & WorkRates & { people: number; active_people: number };
  members: WorkPerson[];
}

export interface WorkDayPoint {
  /** YYYY-MM-DD — the day, or the week's Monday when meta.gran = 'week'. */
  d: string;
  /** A team key, 'unassigned', or '__none__' (decisions no person owns). */
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

export interface WorkHourCell {
  /** person_id, or null for decisions no person owns */
  p: string | null;
  /** Skopje hour 0–23 */
  h: number;
  /** decisions */
  d: number;
  /** call logs (no-answer clicks + timed calls) */
  c: number;
}

export interface WorkCallbackQueue {
  total: number;
  unassigned: number;
  over_24h: number;
  expiring_24h: number;
  no_since: number;
  oldest_since: string | null;
}

export interface WorkQuality {
  no_person: number;
  no_person_top: { via: string; ext: string | null; n: number }[];
  unmapped_calls: number;
  unmapped_callers: number;
  days_before_presence: number;
  presence_gap_days: number;
  people_no_login: number;
  credited_unlisted: number;
  /** Order sales in the cohort with no seller stamped yet (the decider stamping lags). */
  no_seller: number | null;
}

export interface WorkTotals extends WorkCounts, WorkRates {
  people: number;
  people_crm: number;
  people_altercpa: number;
  presence_people: number;
  days_active: number;
}

export interface WorkPrev extends WorkCounts, WorkRates {
  people: number;
  presence_people: number;
}

export interface WorkResponse {
  meta: {
    from: string;
    to: string;
    prev_from: string | null;
    prev_to: string | null;
    prev_to_end: string | null;
    partial: boolean;
    days: number;
    generated_at: string;
    gran: 'day' | 'week';
    clock: 'decided';
    voip: boolean;
    presence_since: string | null;
    work_since: string | null;
    calls_since: string | null;
    self: boolean;
    credited: boolean;
    prev_credited: boolean;
    rate_min_active_min: number;
  };
  totals: WorkTotals;
  prev: WorkPrev | null;
  teams: WorkTeam[];
  per_day: WorkDayPoint[];
  by_hour: WorkHourCell[];
  callbacks: { leads: WorkCallbackQueue; prediction: WorkCallbackQueue; window_days: number } | null;
  quality: WorkQuality | null;
}

export const apiGetInsightsWork = (
  params: { from: string; to: string; compare?: boolean },
  signal?: AbortSignal,
): Promise<WorkResponse> => {
  const sp = new URLSearchParams({ from: params.from, to: params.to });
  if (params.compare) sp.set('compare', '1');
  return apiFetch<WorkResponse>(`insights/work?${sp.toString()}`, { signal });
};

// ── one day's swimlane ──────────────────────────────────────────────────────

export interface WorkDayDecision { at: string; o: 'sale' | 'cancel' | 'trash' | 'callback' | string; via: 'crm' | 'altercpa' | string }
export interface WorkDayCall { at: string; o: string | null; timed: boolean; e: string | null; sec: number; st: string | null }

export interface WorkDayPerson {
  person_id: string;
  name: string;
  has_login: boolean;
  is_manager: boolean;
  team_key: string;
  online_state: WorkOnlineState | string;
  presence: {
    first_seen: string | null;
    last_seen: string | null;
    first_active: string | null;
    last_active: string | null;
    online_min: number;
    active_min: number;
    idle_min: number;
    break_min: number;
    idle_alerts: number;
    last_state: string | null;
  } | null;
  logins: string[];
  breaks: { s: string; e: string | null }[];
  decisions: WorkDayDecision[];
  calls: WorkDayCall[];
  totals: {
    worked: number;
    sale: number;
    cancel: number;
    trash: number;
    callback: number;
    no_answer: number;
    call_logs: number;
    timed_calls: number;
    handling_sec: number;
    first_at: string | null;
    last_at: string | null;
  };
}

export interface WorkDayResponse {
  meta: { day: string; today: boolean; generated_at: string; presence_since: string | null; voip: boolean; self: boolean };
  people: WorkDayPerson[];
  unattributed: { decisions: number; calls: number };
}

export const apiGetInsightsWorkDay = (day: string, signal?: AbortSignal): Promise<WorkDayResponse> =>
  apiFetch<WorkDayResponse>(`insights/work/day?day=${encodeURIComponent(day)}`, { signal });
