// The TV board's filter bar: all / one of the seven departments (Менаџмент last). The team bar (all teams / a
// team / its lanes) was removed on the owner's word (02.10.2026: "само збунувачки е") — since the seller's team decides
// the department, the departments say it all; an old ?team= TV link still filters (initialFilter), with no bar.
import { useTranslation } from 'react-i18next';
import { FILTER_DEPARTMENTS, deptKey, type BoardFilter, type BoardTeam, type Department } from '@/lib/leaderboardV2';

export function TvBoardFilters({ filter, onChange }: {
  filter: BoardFilter;
  /** kept for the callers; the team bar is gone */
  teams?: BoardTeam[];
  onChange: (f: BoardFilter) => void;
}) {
  const { t } = useTranslation();
  // phone / tablet: rem sizes, ONE row that scrolls sideways; wall screen (lg): vh, wrapping
  const pill = (active: boolean) =>
    `shrink-0 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-semibold transition lg:px-[0.8vw] lg:py-[0.5vh] lg:text-[1.55vh] ${active ? 'bg-indigo-500 text-white' : 'text-slate-300 hover:bg-white/10'}`;
  const group = 'flex w-fit max-w-full overflow-x-auto rounded-lg border border-white/10 bg-white/5 p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden lg:flex-wrap lg:overflow-visible lg:p-[0.4vh]';
  // choosing a department clears an old link's team, so what is on screen is what is filtered
  const setDept = (department: Department | null) => onChange({ department, team: null });
  return (
    <div className="flex min-w-0 flex-col gap-2 lg:flex-row lg:flex-wrap lg:items-center lg:gap-[0.8vw]">
      <div role="group" aria-label={t('leaderboard2.filterDepartments')} className={group}>
        <button type="button" onClick={() => setDept(null)} aria-pressed={!filter.department && !filter.team} className={pill(!filter.department && !filter.team)}>
          {t('leaderboard2.filterAll')}
        </button>
        {FILTER_DEPARTMENTS.map((d) => (
          <button key={d} type="button" onClick={() => setDept(d)} aria-pressed={filter.department === d}
            title={t(`leaderboard2.dept.${deptKey(d)}`)} className={pill(filter.department === d)}>
            {t(`leaderboard2.deptShort.${deptKey(d)}`)}
          </button>
        ))}
      </div>
    </div>
  );
}
