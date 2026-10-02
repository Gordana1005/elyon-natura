// One person on the TV board (owner 02.10.2026: "треба да покажува колку е вкупен број на продажби, просек на
// продажба и време во ЦРМ"): rank (non-managers with a total), name + team badge + presence, the number of sales
// (collabBox bookings included), the average sale and the time on the CRM.
import { useTranslation } from 'react-i18next';
import { formatDenari } from '@/lib/currency';
import { avgSaleMkd, type BoardRow } from '@/lib/leaderboardV2';
import { PresenceDot } from './TvBoardParts';
import { RANK_ACCENT, fmtDur, hhmm, initials, teamLabel, tvGrid } from './tvBoardHelpers';

export function TvBoardRow({
  row, idx, money, rowVh, fontVh, isToday, now, glow,
}: {
  row: BoardRow;
  idx: number;
  money: boolean;
  rowVh: number;
  fontVh: number;
  isToday: boolean;
  now: Date;
  glow: boolean;
}) {
  const { t } = useTranslation();
  const sold = row.total_count > 0;
  const p = row.presence;
  const quiet = !sold && !row.worked && (p.state === 'offline' || p.state === 'n/a');
  const avg = avgSaleMkd(row);
  // second lines never shrink below what a wall screen can be read from
  const smallVh = Math.max(1.3, fontVh * 0.66);

  const lastDecisionText = (iso: string) => {
    const mins = Math.floor((now.getTime() - Date.parse(iso)) / 60000);
    if (isToday && mins >= 0 && mins < 60) return t('tvBoard.lastDecisionAgo', { n: mins });
    return t('tvBoard.lastDecisionAt', { time: hhmm(iso) });
  };

  const timeCell = () => {
    if (p.online_min > 0) {
      const start = p.first_active || p.first_seen || p.first_login;
      const end = p.last_active || p.last_seen;
      return (
        <div className="min-w-0 leading-tight">
          <div className="font-semibold tabular-nums">{fmtDur(p.online_min)}</div>
          {start && (
            <div className="truncate text-slate-400 tabular-nums" style={{ fontSize: `${smallVh}vh` }}>
              {`${hhmm(start)}–${end ? hhmm(end) : ''}`}
            </div>
          )}
        </div>
      );
    }
    if (row.last_decision_at) return <div className="truncate text-slate-300" style={{ fontSize: `${smallVh}vh` }}>{lastDecisionText(row.last_decision_at)}</div>;
    if (p.first_login) return <div className="truncate text-slate-400" style={{ fontSize: `${smallVh}vh` }}>{t('tvBoard.loggedInAt', { time: hhmm(p.first_login) })}</div>;
    return <div className="truncate text-slate-500" style={{ fontSize: `${smallVh}vh` }}>{p.state === 'n/a' ? t('leaderboard2.noCrmLogin') : '—'}</div>;
  };

  return (
    <div data-testid="tv-row"
      className={`grid ${tvGrid(money)} items-center border-t border-white/5 px-[1.6vw] ${idx % 2 ? 'bg-white/[0.015]' : ''} ${sold ? '' : quiet ? 'opacity-40' : 'opacity-60'}`}
      style={{ minHeight: `${rowVh}vh`, fontSize: `${fontVh}vh`, ...(glow ? { animation: 'tv-glow 1.4s ease-in-out 2' } : {}) }}>
      {/* Rank — non-managers with a total */}
      <div>
        {row.rank != null ? (
          <span className={`inline-flex items-center justify-center rounded-full font-bold ring-1 ${RANK_ACCENT[row.rank] || 'bg-white/5 text-slate-300 ring-white/10'}`}
            style={{ width: `${rowVh * 0.7}vh`, height: `${rowVh * 0.7}vh`, fontSize: `${fontVh * 0.72}vh` }}>{row.rank}</span>
        ) : <span className="text-slate-600">–</span>}
      </div>
      {/* Person */}
      <div className="flex min-w-0 items-center gap-[0.7vw]">
        <span className="relative inline-flex shrink-0 items-center justify-center rounded-full bg-indigo-500/20 font-bold text-indigo-200"
          style={{ width: `${rowVh * 0.72}vh`, height: `${rowVh * 0.72}vh`, fontSize: `${fontVh * 0.62}vh` }}>
          {initials(row.name)}
          <span className="absolute -bottom-[0.2vh] -right-[0.2vh]"><PresenceDot state={p.state} /></span>
        </span>
        <span className="truncate font-semibold">{row.name}</span>
        <span className="shrink-0 rounded bg-white/10 px-[0.5vw] py-[0.2vh] text-[1.2vh] font-medium uppercase tracking-wide text-slate-300">
          {teamLabel(t, row.team_key, row.team_name, row.team_lane)}
        </span>
        {isToday && p.state === 'idle' && (p.idle_streak_min ?? 0) > 0 && (
          <span className="shrink-0 rounded bg-amber-400/15 px-[0.5vw] py-[0.2vh] text-[1.2vh] font-semibold text-amber-300">{t('tvBoard.idleFor', { n: p.idle_streak_min })}</span>
        )}
        {isToday && p.state === 'break' && (
          <span className="shrink-0 rounded bg-sky-400/15 px-[0.5vw] py-[0.2vh] text-[1.2vh] font-semibold text-sky-300">{t('tvBoard.stateBreak')}</span>
        )}
      </div>
      {/* Sales */}
      <div className="text-right font-bold tabular-nums" data-testid="tv-sales">
        {row.total_count}
        {row.cancelled_after_sale > 0 && (
          <span className="ml-[0.3vw] text-[0.5em] font-medium text-rose-300" title={t('leaderboard2.cancelledHint')}>−{row.cancelled_after_sale}</span>
        )}
      </div>
      {/* Value — the total денари (owners) */}
      {money && (
        <div className="text-right font-bold tabular-nums" data-testid="tv-value">
          {formatDenari(row.total_value_mkd ?? 0)}
        </div>
      )}
      {/* Average sale (owners) */}
      {money && (
        <div className="text-right font-semibold tabular-nums text-slate-200" data-testid="tv-avg">
          {avg != null ? formatDenari(avg) : '—'}
        </div>
      )}
      {/* Time on the CRM / last decision */}
      <div className="pl-[1.2vw]">{timeCell()}</div>
    </div>
  );
}
