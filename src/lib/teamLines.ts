// Teams = business lines (owner ruling 30.09.2026, plan "Фаза 3") — the client's pure half:
// lanes, the team order, the 'team:lane' filter value and the labels every board uses.
// Twin of supabase/functions/api/teamLines.ts (the server's grammar and order); the SQL is
// migrations 20260943000900 / 20260943000950. A team NEVER decides a sale's department.
//   Телешоп   teleshop   lanes: in = "лидови" · out = "предикција" · social = "Социјални мрежи"
//   Affiliate affiliate  lanes: in = "лидови" · out = "предикција"
//   Менаџмент management no lane, never ranked
// Legacy keys altercpa_leads / crm_prediction stay readable (old rows, old TV links).
import type { TFunction } from 'i18next';
import i18n from '@/i18n';

export const LANES = ['in', 'out', 'social'] as const;
export type Lane = typeof LANES[number];
export const isLane = (v: unknown): v is Lane => (LANES as readonly unknown[]).includes(v);

/** The lanes each business line takes (the SQL enforces the same). */
export const LINE_LANES: Readonly<Record<string, readonly Lane[]>> = {
  teleshop: ['in', 'out', 'social'],
  affiliate: ['in', 'out'],
};
export const isLineKey = (k: string | null | undefined): boolean => !!k && k in LINE_LANES;
export const LEGACY_TEAM_KEYS = ['altercpa_leads', 'crm_prediction'] as const;
export const isLegacyTeam = (k: string | null | undefined): boolean => (LEGACY_TEAM_KEYS as readonly string[]).includes(k ?? '');

/** sales_teams.sort_order as seeded + the groups outside a team (the server's TEAM_SORT_FALLBACK). */
export const TEAM_SORT_FALLBACK: Readonly<Record<string, number>> = {
  teleshop: 10, affiliate: 20, altercpa_leads: 40, crm_prediction: 41,
  teleshop_unassigned: 60, social_unassigned: 61, management: 90, unassigned: 99, none: 99,
};
/** A team's place: its sort_order, else the seeded order, else after the known teams. */
export function teamSortOrder(key: string | null | undefined, sortOrder?: number | null): number {
  if (typeof sortOrder === 'number' && Number.isFinite(sortOrder)) return sortOrder;
  return TEAM_SORT_FALLBACK[key ?? 'none'] ?? 70;
}

/** 'teleshop:out' → { team: 'teleshop', lane: 'out' }; a plain key has no lane. */
export function splitTeamFilter(v: string | null | undefined): { team: string | null; lane: Lane | null } {
  if (!v) return { team: null, lane: null };
  const [team, lane] = v.split(':');
  return { team: team || null, lane: isLane(lane) ? lane : null };
}
export const teamFilterValue = (team: string, lane?: Lane | null) => (lane ? `${team}:${lane}` : team);

/** The TV / URL grammar: a team key, 'team:lane' (lane in | out | social) or 'none'. */
export const TEAM_FILTER_RE = /^[a-z][a-z0-9_]{0,39}(?::(?:in|out|social))?$/;

/** A lane's word ("лидови" / "предикција" / "Социјални мрежи"); an unknown lane shows itself. */
export const laneLabel = (t: TFunction, lane: string): string =>
  (i18n.exists(`teamLines.lane.${lane}`) ? t(`teamLines.lane.${lane}`) : lane);

/**
 * Team + lane as the owner names it ("Телешоп предикција", "Affiliate лидови", "Социјални
 * мрежи"); a team with no lane is its own label (`teamText`, from the surface's key space); a
 * pair with no words yet (a line added later) is "team · lane".
 */
export function teamLaneLabel(t: TFunction, team: string | null | undefined, lane: string | null | undefined, teamText: string): string {
  if (!team || !lane) return teamText;
  const key = `teamLines.label.${team}_${lane}`;
  return i18n.exists(key) ? t(key) : `${teamText} · ${laneLabel(t, lane)}`;
}
