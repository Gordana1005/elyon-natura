// The TV board's filter bar: all / one of the six departments · all / one team.
// A department shows that department's numbers for everyone who did anything
// in it that day; a team shows its badge holders (the team is a badge — it
// never decides a sale's department).
import { useTranslation } from 'react-i18next';
import { DEPARTMENTS, deptKey, type BoardFilter, type BoardTeam, type Department } from '@/lib/leaderboardV2';
import { teamLabel } from './tvBoardHelpers';

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
  // the chosen team stays selectable even when the department filter leaves it empty
  const list = filter.team && !teams.some((x) => x.key === filter.team)
    ? [...teams, { key: filter.team, name: null, people: 0 }] : teams;
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
          <button key={tm.key} type="button" onClick={() => setTeam(tm.key)} aria-pressed={filter.team === tm.key}
            className={pill(filter.team === tm.key)}>
            {teamLabel(t, tm.key, tm.name)}
            {tm.people > 0 && <span className="ml-1 text-[0.85em] font-normal opacity-70 tabular-nums lg:ml-[0.3vw]">{tm.people}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
