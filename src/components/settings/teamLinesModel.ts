// Settings → Teams → Предлог (teams = business lines, owner ruling 30.09.2026): the pure rules
// behind the panel and the lane selectors. Unit-tested in teamLinesModel.test.ts.
import type { LineApplyRow, LineProposalRow, SalesMembership, SalesTeam, TeamLane } from '@/lib/api';
import { LINE_LANES, isLegacyTeam, teamSortOrder } from '@/lib/teamLines';

export type ProposalView = 'changes' | 'all';

/** A team a person can be placed in now: a business line or management — never a legacy key. */
export const isTargetTeam = (t: Pick<SalesTeam, 'key' | 'kind'>) =>
  t.kind ? t.kind === 'line' || t.kind === 'management' : !isLegacyTeam(t.key);

/** The teams a selector offers, in their board order. */
export function targetTeams(teams: SalesTeam[]): SalesTeam[] {
  return teams.filter(isTargetTeam).sort((a, b) => teamSortOrder(a.key, a.sort_order) - teamSortOrder(b.key, b.sort_order));
}

/** A team's lanes (none for management / a team without lanes). */
export const lanesFor = (teamKey: string | null | undefined): readonly TeamLane[] =>
  (teamKey && LINE_LANES[teamKey]) || [];

/** The lane a team change keeps: the current one when the new team has it, else its first lane. */
export function laneAfterTeamChange(teamKey: string, lane: TeamLane | null): TeamLane | null {
  const lanes = lanesFor(teamKey);
  if (!lanes.length) return null;
  return lane && lanes.includes(lane) ? lane : lanes[0];
}

/** A (team, lane) pair the server takes: a line with one of its lanes, or a team without lanes. */
export function isCompletePick(teamKey: string | null, lane: TeamLane | null): teamKey is string {
  if (!teamKey || isLegacyTeam(teamKey)) return false;
  const lanes = lanesFor(teamKey);
  return lanes.length ? !!lane && lanes.includes(lane) : lane == null;
}

/** The rows the panel lists: every person, or only the ones the proposal would change. */
export function visibleRows(rows: LineProposalRow[], view: ProposalView): LineProposalRow[] {
  return view === 'all' ? rows : rows.filter((r) => !r.unchanged);
}

/** "Accept every sure row": the sure proposals that change something and name a team. */
export function sureApplyRows(rows: LineProposalRow[]): LineApplyRow[] {
  return rows
    .filter((r) => r.confidence === 'sure' && !r.unchanged && isCompletePick(r.proposed.team_key, r.proposed.lane))
    .map((r) => ({ person_id: r.person_id, team_key: r.proposed.team_key!, lane: r.proposed.lane }));
}

/** One row as the owner picked it (the proposal unless changed in the row's selectors). */
export function applyRowFor(r: Pick<LineProposalRow, 'person_id'>, teamKey: string | null, lane: TeamLane | null): LineApplyRow | null {
  return isCompletePick(teamKey, lane) ? { person_id: r.person_id, team_key: teamKey, lane: lanesFor(teamKey).length ? lane : null } : null;
}

/** The departments behind a proposal, largest first, without the empty ones. */
export type ProposalDept = 'altercpa' | 'elyon_crm' | 'teleshop_out' | 'teleshop_other' | 'social';
export function deptCounts(c: LineProposalRow['counts']): { dept: ProposalDept; n: number }[] {
  return (['altercpa', 'elyon_crm', 'teleshop_out', 'teleshop_other', 'social'] as const)
    .map((dept) => ({ dept, n: c[dept] ?? 0 }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n);
}

/** The lane selector of one membership row: only a line's membership has one. */
export const membershipHasLane = (m: Pick<SalesMembership, 'team_key'>) => lanesFor(m.team_key).length > 0;
