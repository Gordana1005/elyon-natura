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
  const pill = (active: boolean) =>
    `whitespace-nowrap rounded-md px-[0.8vw] py-[0.5vh] text-[1.55vh] font-semibold transition ${active ? 'bg-indigo-500 text-white' : 'text-slate-300 hover:bg-white/10'}`;
  const setDept = (department: Department | null) => onChange({ ...filter, department });
  const setTeam = (team: string | null) => onChange({ ...filter, team });
  // the chosen team stays selectable even when the department filter leaves it empty
  const list = filter.team && !teams.some((x) => x.key === filter.team)
    ? [...teams, { key: filter.team, name: null, people: 0 }] : teams;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-[0.8vw]">
      <div role="group" aria-label={t('leaderboard2.filterDepartments')}
        className="flex flex-wrap rounded-lg border border-white/10 bg-white/5 p-[0.4vh]">
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
      <div role="group" aria-label={t('leaderboard2.filterTeams')}
        className="flex flex-wrap rounded-lg border border-white/10 bg-white/5 p-[0.4vh]">
        <button type="button" onClick={() => setTeam(null)} aria-pressed={!filter.team} className={pill(!filter.team)}>
          {t('leaderboard2.allTeams')}
        </button>
        {list.map((tm) => (
          <button key={tm.key} type="button" onClick={() => setTeam(tm.key)} aria-pressed={filter.team === tm.key}
            className={pill(filter.team === tm.key)}>
            {teamLabel(t, tm.key, tm.name)}
            {tm.people > 0 && <span className="ml-[0.3vw] text-[0.85em] font-normal opacity-70 tabular-nums">{tm.people}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
