// One person on the TV board as a CARD — the phone / tablet layout (below 1024 px
// wide) of TvBoardRow. The same facts, stacked so nothing is cut or squeezed:
// rank, initials + presence, the full name, team badge (+ idle / break), the total
// and its денари on the right, a chip per department she sold in plus the collabBox
// bookings still waiting for a parcel, and one line with the day's work,
// conversion and time on the CRM.
import { BellRing, Clock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatDenari } from '@/lib/currency';
import { conversionPct, type BoardRow, type Department } from '@/lib/leaderboardV2';
import { DeptChips, PresenceDot } from './TvBoardParts';
import { RANK_ACCENT, fmtDur, hhmm, initials, teamLabel } from './tvBoardHelpers';

export function TvBoardCard({
  row, department, money, isToday, now, glow,
}: {
  row: BoardRow;
  department: Department | null;
  money: boolean;
  isToday: boolean;
  now: Date;
  glow: boolean;
}) {
  const { t } = useTranslation();
  const sold = row.total_count > 0;
  const p = row.presence;
  const quiet = !sold && !row.worked && (p.state === 'offline' || p.state === 'n/a');
  const conv = conversionPct(row);

  // the time on the CRM, else the last decision / the login, else why there is none
  const timeText = () => {
    if (p.online_min > 0) {
      const start = p.first_active || p.first_seen || p.first_login;
      const end = p.last_active || p.last_seen;
      return `${t('tvBoard.colTime')} ${fmtDur(p.online_min)}${start ? ` · ${hhmm(start)}–${end ? hhmm(end) : ''}` : ''}`;
    }
    if (row.last_decision_at) {
      const mins = Math.floor((now.getTime() - Date.parse(row.last_decision_at)) / 60000);
      return isToday && mins >= 0 && mins < 60
        ? t('tvBoard.lastDecisionAgo', { n: mins })
        : t('tvBoard.lastDecisionAt', { time: hhmm(row.last_decision_at) });
    }
    if (p.first_login) return t('tvBoard.loggedInAt', { time: hhmm(p.first_login) });
    return p.state === 'n/a' ? t('leaderboard2.noCrmLogin') : '—';
  };

  return (
    <div data-testid="tv-card"
      className={`rounded-xl border border-white/10 bg-white/[0.03] p-3 ${sold ? '' : quiet ? 'opacity-50' : 'opacity-75'}`}
      style={glow ? { animation: 'tv-glow 1.4s ease-in-out 2' } : undefined}>
      <div className="flex items-start gap-2.5">
        {/* Rank — non-managers with a total */}
        {row.rank != null ? (
          <span className={`mt-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-bold ring-1 ${RANK_ACCENT[row.rank] || 'bg-white/5 text-slate-300 ring-white/10'}`}>
            {row.rank}
          </span>
        ) : <span className="mt-1 inline-flex h-7 w-7 shrink-0 items-center justify-center text-slate-600">–</span>}
        {/* Initials + presence */}
        <span className="relative inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-indigo-500/20 text-xs font-bold text-indigo-200">
          {initials(row.name)}
          <span className="absolute -bottom-0.5 -right-0.5"><PresenceDot state={p.state} compact /></span>
        </span>
        {/* Name + team */}
        <div className="min-w-0 flex-1">
          <div className="break-words text-[15px] font-semibold leading-snug text-slate-50">{row.name}</div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-300">
              {teamLabel(t, row.team_key, row.team_name, row.team_lane)}
            </span>
            {isToday && p.state === 'idle' && (p.idle_streak_min ?? 0) > 0 && (
              <span className="rounded bg-amber-400/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300">{t('tvBoard.idleFor', { n: p.idle_streak_min })}</span>
            )}
            {isToday && p.state === 'break' && (
              <span className="rounded bg-sky-400/15 px-1.5 py-0.5 text-[10px] font-semibold text-sky-300">{t('tvBoard.stateBreak')}</span>
            )}
          </div>
        </div>
        {/* Total */}
        <div className="shrink-0 text-right tabular-nums">
          <div className="text-xl font-bold leading-none text-slate-50">
            {row.total_count}
            {row.cancelled_after_sale > 0 && (
              <span className="ml-1 text-xs font-medium text-rose-300" title={t('leaderboard2.cancelledHint')}>−{row.cancelled_after_sale}</span>
            )}
          </div>
          {money && <div className="mt-1 text-xs font-semibold text-slate-300">{formatDenari(row.total_value_mkd ?? 0)}</div>}
        </div>
      </div>

      {/* Departments + bookings */}
      <DeptChips row={row} department={department} money={money} compact className="mt-2.5" />

      {/* The day's work and the time on the CRM */}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400">
        <span>
          {t('tvBoard.colWorked')}{' '}
          <b className="font-semibold tabular-nums text-slate-200">{row.worked || 0}</b>
          {conv != null && <span className="tabular-nums"> · {t('leaderboard2.convShort', { pct: conv.toFixed(1) })}</span>}
        </span>
        <span className="inline-flex min-w-0 items-center gap-1 tabular-nums">
          <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="min-w-0">{timeText()}</span>
          {p.idle_alerts > 0 && (
            <span className="ml-1 inline-flex items-center gap-0.5 text-amber-300" title={t('tvBoard.idleAlerts', { n: p.idle_alerts })}>
              <BellRing className="h-3.5 w-3.5" aria-hidden />{p.idle_alerts}
            </span>
          )}
        </span>
      </div>
    </div>
  );
}
