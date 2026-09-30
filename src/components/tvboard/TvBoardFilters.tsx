// The TV board's filter bar: all / one of the six departments · all / one team (· one lane).
// A department shows that department's numbers for everyone who did anything
// in it that day; a team shows its badge holders (the team is a badge — it
// never decides a sale's department). Teams are business lines (owner, 30.09.2026):
// choosing Телешоп / Affiliate opens its lanes ("лидови" / "предикција" / "Социјални мрежи"),
// the value is then 'team:lane'. An old link's legacy key (?team=crm_prediction,
// ?mode=pending) stays selectable under its alias label.
import { useTranslation } from 'react-i18next';
import { DEPARTMENTS, deptKey, type BoardFilter, type BoardTeam, type Department } from '@/lib/leaderboardV2';
import { laneLabel, splitTeamFilter, teamFilterValue, type Lane } from '@/lib/teamLines';
import { filterTeamLabel, teamLabel } from './tvBoardHelpers';

export function TvBoardFilters({ filter, teams, onChange }: {
  filter: BoardFilter;
  teams: BoardTeam[];
  onChange: (f: BoardFilter) => void;
}) {
  const { t } = useTranslation();
  // phone / tablet: rem sizes, each group ONE row that scrolls sideways; wall screen (lg): vh, wrapping
  const pill = (active: boolean) =>
    `shrink-0 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-semibold transition lg:px-[0.8vw] lg:py-[0.5vh] lg:text-[1.55vh] ${active ? 'bg-indigo-500 text-white' : 'text-slate-300 hover:bg-white/10'}`;
  const group = 'flex w-fit max-w-full overflow-x-auto rounded-lg border border-white/10 bg-white/5 p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden lg:flex-wrap lg:overflow-visible lg:p-[0.4vh]';
  const setDept = (department: Department | null) => onChange({ ...filter, department });
  const setTeam = (team: string | null) => onChange({ ...filter, team });
  const sel = splitTeamFilter(filter.team);
  // the chosen team stays selectable even when the department filter leaves it empty
  const list = sel.team && !teams.some((x) => x.key === sel.team)
    ? [...teams, { key: sel.team, name: null, people: 0 }] : teams;
  const selTeam = sel.team ? list.find((x) => x.key === sel.team) : undefined;
  const lanes = selTeam?.lanes ?? [];
  // a lane that is chosen but has nobody on this (department-filtered) board stays selectable
  const laneList = sel.lane && !lanes.some((l) => l.lane === sel.lane)
    ? [...lanes, { lane: sel.lane, key: teamFilterValue(sel.team!, sel.lane), people: 0 }] : lanes;
  return (
    <div className="flex min-w-0 flex-col gap-2 lg:flex-row lg:flex-wrap lg:items-center lg:gap-[0.8vw]">
      <div role="group" aria-label={t('leaderboard2.filterDepartments')} className={group}>
        <button type="button" onClick={() => setDept(null)} aria-pressed={!filter.department} className={pill(!filter.department)}>
          {t('leaderboard2.filterAll')}
        </button>
        {DEPARTMENTS.map((d) => (
          <button key={d} type="button" onClick={() => setDept(d)} aria-pressed={filter.department === d}
            title={t(`leaderboard2.dept.${deptKey(d)}`)} className={pill(filter.department === d)}>
            {t(`leaderboard2.deptShort.${deptKey(d)}`)}
          </button>
        ))}
      </div>
      <div role="group" aria-label={t('leaderboard2.filterTeams')} className={group}>
        <button type="button" onClick={() => setTeam(null)} aria-pressed={!filter.team} className={pill(!filter.team)}>
          {t('leaderboard2.allTeams')}
        </button>
        {list.map((tm) => (
          <button key={tm.key} type="button" onClick={() => setTeam(tm.key)} aria-pressed={sel.team === tm.key}
            className={pill(sel.team === tm.key)}>
            {filterTeamLabel(t, tm.key, tm.name)}
            {tm.people > 0 && <span className="ml-1 text-[0.85em] font-normal opacity-70 tabular-nums lg:ml-[0.3vw]">{tm.people}</span>}
          </button>
        ))}
      </div>
      {sel.team && laneList.length > 0 && (
        <div role="group" aria-label={t('teamLines.filterLanes', { team: teamLabel(t, sel.team, selTeam?.name) })} className={group}>
          <button type="button" onClick={() => setTeam(sel.team)} aria-pressed={!sel.lane} className={pill(!sel.lane)}>
            {t('teamLines.allLanes')}
          </button>
          {laneList.map((l) => (
            <button key={l.key} type="button" onClick={() => setTeam(teamFilterValue(sel.team!, l.lane as Lane))}
              aria-pressed={sel.lane === l.lane} title={teamLabel(t, sel.team, selTeam?.name, l.lane)} className={pill(sel.lane === l.lane)}>
              {laneLabel(t, l.lane)}
              {l.people > 0 && <span className="ml-1 text-[0.85em] font-normal opacity-70 tabular-nums lg:ml-[0.3vw]">{l.people}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
