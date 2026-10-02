// The prediction (Out) bonus on the TV board (owner 02.10.2026): per department with a target — the day's value
// toward the target, the three milestones (1/3, 2/3, 3/3) with the € each unlocks, the pool unlocked so far and what
// MEX has already collected of it. Everyone sees the euros (owner's answer). Wall screen in vh, phone in rem.
import { useTranslation } from 'react-i18next';
import { Trophy } from 'lucide-react';
import { formatDenari, formatEurExact } from '@/lib/currency';
import { bonusDepartmentsFor, bonusProgress, type BoardBonus } from '@/lib/bonusApi';
import { deptKey, type Department } from '@/lib/leaderboardV2';

const FRACTION = ['⅓', '⅔', '3/3'];

export function TvBonusStrip({ bonus, department }: { bonus: BoardBonus | null | undefined; department: string | null }) {
  const { t } = useTranslation();
  const deps = bonusDepartmentsFor(bonus, department);
  if (!deps.length) return null;
  return (
    <div className="mb-3 grid gap-2 lg:mb-[1.4vh] lg:gap-[0.8vw]" style={{ gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, 28rem), 1fr))` }}
      data-testid="tv-bonus">
      {deps.map((d) => {
        const pct = bonusProgress(d) * 100;
        return (
          <div key={d.department} className="min-w-0 rounded-xl border border-amber-300/20 bg-amber-300/[0.04] px-3 py-2.5 lg:px-[1.2vw] lg:py-[1.1vh]">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <div className="flex min-w-0 items-center gap-1.5 text-sm font-semibold text-amber-200 lg:text-[1.7vh]">
                <Trophy className="h-4 w-4 shrink-0 lg:h-[1.9vh] lg:w-[1.9vh]" aria-hidden />
                <span className="truncate">{t(`leaderboard2.dept.${deptKey(d.department as Department)}`)}</span>
              </div>
              <div className="text-right tabular-nums">
                <span className="text-lg font-bold text-amber-100 lg:text-[2.6vh]" data-testid="tv-bonus-pool">
                  {t('leaderboard2.bonus.pool', { eur: formatEurExact(d.pool_eur) })}
                </span>
                {d.paid_pool_eur > 0 && (
                  <span className="ml-2 text-xs text-slate-400 lg:text-[1.35vh]">{t('leaderboard2.bonus.paid', { eur: formatEurExact(d.paid_pool_eur) })}</span>
                )}
              </div>
            </div>
            {/* the bar: the day's value toward the target, a marker at each third */}
            <div className="relative mt-2 h-2.5 rounded-full bg-white/10 lg:mt-[1vh] lg:h-[1.2vh]" role="progressbar"
              aria-valuemin={0} aria-valuemax={d.target_mkd} aria-valuenow={d.value_mkd}
              aria-label={t('leaderboard2.bonus.progress', { value: formatDenari(d.value_mkd), target: formatDenari(d.target_mkd) })}>
              <div className="h-full rounded-full bg-gradient-to-r from-amber-400 to-emerald-400" style={{ width: `${pct}%` }} />
              {[1, 2].map((k) => (
                <span key={k} className="absolute top-0 h-full w-px bg-slate-900/70" style={{ left: `${(k / 3) * 100}%` }} aria-hidden />
              ))}
            </div>
            <div className="mt-1.5 flex items-center justify-between gap-2 text-xs text-slate-300 lg:mt-[0.8vh] lg:text-[1.4vh]">
              <span className="tabular-nums">{t('leaderboard2.bonus.progress', { value: formatDenari(d.value_mkd), target: formatDenari(d.target_mkd) })}</span>
              <span className="flex shrink-0 gap-1.5 lg:gap-[0.5vw]">
                {d.milestones_eur.map((eur, i) => (
                  <span key={i} title={formatDenari(d.thresholds_mkd[i] ?? 0)}
                    className={`rounded-md px-1.5 py-0.5 font-semibold tabular-nums lg:px-[0.5vw] ${i < d.reached ? 'bg-emerald-400/20 text-emerald-200' : 'bg-white/5 text-slate-400'}`}>
                    {FRACTION[i]} · {formatEurExact(eur)}
                  </span>
                ))}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
