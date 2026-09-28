/**
 * GET /api/insights/agents?from&to&compare=1[&person=<uuid>] — Insights → Агенти
 * (migration 20260941000200 insights_people; api module
 * supabase/functions/api/insightsPeople.ts).
 *
 * People and teams on THE sale cohort (insights_sale_rows): a person's sales
 * are the cohort sales credited to them (orders.sold_by_person_id), on the
 * sale day (Skopje), in MEX-first buckets that add up to their total; the
 * people's sales + `no_seller` = the cohort's total, per source. Work =
 * v_sales_work decisions (conversion = sale decisions ÷ worked); time =
 * agent_presence_days (recorded since `meta.presence_since`). A team counts
 * each event in the team the person was in THAT day ('teleshop' = collabBox
 * sales outside a team, 'none' = anything else outside a team).
 *
 * Money keys (`*_mkd`, денари — render with formatDenari, never convert) are
 * owners only: an admin / manager gets the same payload with every money key
 * ABSENT (meta.money = false); an agent (meta.access = 'self') gets only their
 * own row and drill, without money.
 */
import { apiFetch } from '@/lib/api';

export type PeopleAccessKind = 'owner' | 'counts' | 'self';

export interface PeopleBuckets {
  paid: number;
  paid_legacy: number;
  paid_unproven: number;
  courier: number;
  courier_problem: number;
  label: number;
  to_pack: number;
  returned: number;
}
export interface PeopleOutside {
  cancelled_after_sale: number;
  trashed_after_sale: number;
  replacement: number;
}
export interface PeopleBySource {
  altercpa: number;
  elyon_crm: number;
  teleshop_other: number;
  web: number;
}
export interface PeoplePresence {
  days: number;
  online_min: number | null;
  active_min: number | null;
  idle_min: number | null;
  break_min: number | null;
  idle_alerts: number | null;
  first_active_at: string | null;
  last_active_at: string | null;
  /** Sale decisions on the days that have a presence record (the per-hour numerator). */
  sale_decisions: number;
}

/** The measures every person, team member and team carries. */
export interface PeopleMeasures {
  sales: number;
  value_mkd?: number;
  cod_mkd?: number;
  paid_mkd?: number;
  returned_mkd?: number;
  cancelled_mkd?: number;
  packages: number;
  buckets: PeopleBuckets;
  outside: PeopleOutside;
  by_source: PeopleBySource;
  worked: number;
  sale_decisions: number;
  cancel_decisions: number;
  trash_decisions: number;
  callback_decisions: number;
  via_crm: number;
  via_altercpa: number;
  /** sale decisions ÷ worked (0..1), null with no decision. */
  conversion: number | null;
  first_decision_at: string | null;
  last_decision_at: string | null;
  presence: PeoplePresence | null;
  prev: { sales: number; worked: number; sale_decisions: number } | null;
}

export type PresenceState = 'online' | 'idle' | 'break' | 'offline' | 'n/a';

export interface PeoplePerson extends PeopleMeasures {
  person_id: string;
  name: string;
  has_login: boolean;
  is_manager: boolean;
  is_active: boolean;
  identity_kinds: ('altercpa_user' | 'collabbox_author' | 'order_name')[];
  /** The team shown on the person's row (a real team key, 'teleshop' or 'none'). */
  team_key: string;
  team_role: string | null;
  online_state: PresenceState;
  /** Every group their activity in the window fell in. */
  groups: string[];
}

export interface PeopleMember extends PeopleMeasures {
  person_id: string;
}

export type TeamKind = 'team' | 'teleshop' | 'none';

export interface PeopleTeam extends PeopleMeasures {
  key: string;
  /** sales_teams.name for a real team; null for the pseudo-groups (i18n). */
  name: string | null;
  mode: 'pending' | 'prediction' | null;
  kind: TeamKind;
  people: number;
  online_now: number;
  break_now: number;
  /** /orders?team_key= lists exactly this group's sales. */
  drill_exact: boolean;
  members: PeopleMember[];
  spark: { d: string; sales: number; sale_decisions: number; worked: number }[] | null;
}

export type NoSellerReason =
  'web_shop' | 'mex_only' | 'altercpa_cancelled' | 'awaiting_stamp' | 'unmapped' | 'no_decider';

export interface NoSellerRow {
  reason: NoSellerReason;
  source: 'altercpa' | 'elyon_crm' | 'web' | 'teleshop_other';
  /** web: cod | card · mex_only: the channel split · unmapped: sold_via. */
  detail: string | null;
  count: number;
  value_mkd?: number;
  cod_mkd?: number;
  buckets: PeopleBuckets;
}

export interface PeopleTotals {
  sales: number;
  value_mkd?: number;
  cod_mkd?: number;
  paid_mkd?: number;
  with_person: number;
  with_person_mkd?: number;
  without_person: number;
  without_person_mkd?: number;
  by_source: { key: 'altercpa' | 'elyon_crm' | 'web' | 'teleshop_other'; sales: number; with_person: number; value_mkd?: number; with_person_mkd?: number }[];
  worked: number;
  sale_decisions: number;
  cancel_decisions: number;
  trash_decisions: number;
  callback_decisions: number;
  unmapped_decisions: number;
  conversion: number | null;
  prev: { sales: number; with_person: number; worked: number; sale_decisions: number } | null;
}

export interface PeopleDetailDay {
  d: string;
  sales: number;
  value_mkd?: number;
  paid: number;
  returned: number;
  worked: number;
  sale_decisions: number;
  cancel_decisions: number;
  trash_decisions: number;
  callback_decisions: number;
  online_min: number | null;
  active_min: number | null;
}

export interface PeopleDetail {
  person_id: string;
  days: PeopleDetailDay[];
  products: { name: string; count: number; value_mkd?: number }[];
  identities: { kind: string; value: string }[];
  memberships: { team_key: string; name: string | null; from: string; to: string | null; role: string; primary: boolean }[];
}

export interface PeopleResponse {
  meta: {
    from: string;
    to: string;
    prev_from: string | null;
    prev_to: string | null;
    prev_to_end?: string | null;
    partial: boolean;
    days: number;
    generated_at: string;
    money: boolean;
    clock: 'sale';
    access: PeopleAccessKind;
    granularity?: 'day' | 'month';
    /** First day agent_presence_days has data (YYYY-MM-DD), null if none. */
    presence_since?: string | null;
    /** The seller-stamping cron's last run. */
    stamped_at?: string | null;
    person?: string | null;
    /** An agent whose login is no sales person yet. */
    self_unlinked?: boolean;
  };
  /** Absent for an agent (self view). */
  totals?: PeopleTotals;
  teams?: PeopleTeam[];
  people: PeoplePerson[];
  no_seller?: {
    count: number;
    value_mkd?: number;
    reasons: NoSellerRow[];
    handles: { via: string | null; handle: string; count: number; value_mkd?: number }[];
    cancelled_by: { person_id: string | null; name: string | null; altercpa_user: number | null; count: number; value_mkd?: number }[];
  };
  unmapped_work?: { count: number; actors: { via: string; actor: string | null; count: number }[] };
  spark?: { d: string; sales: number; with_person: number; value_mkd?: number; worked: number; sale_decisions: number }[];
  detail: PeopleDetail | null;
}

export const apiGetInsightsAgents = (
  p: { from: string; to: string; compare?: boolean; person?: string | null },
  signal?: AbortSignal,
): Promise<PeopleResponse> => {
  const sp = new URLSearchParams({ from: p.from, to: p.to });
  if (p.compare) sp.set('compare', '1');
  if (p.person) sp.set('person', p.person);
  return apiFetch<PeopleResponse>(`insights/agents?${sp.toString()}`, { signal });
};
