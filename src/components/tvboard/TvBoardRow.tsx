// One person on the TV board: rank (non-managers with a total), name + team
// badge + presence, one chip per department she sold in ("Aff. out 3 · 9.000
// ден"), the collabBox bookings still waiting for a parcel ("+5 резервирани"),
// the total, the work of the whole day and the time on the CRM.
import { BellRing } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatDenari } from '@/lib/currency';
import {
  bookedChips, conversionPct, deptChips, deptKey, type BoardRow, type Department,
} from '@/lib/leaderboardV2';
import { PresenceDot } from './TvBoardParts';
import { DEPT_TEXT, DEPT_TONE, RANK_ACCENT, TV_GRID, fmtDur, hhmm, initials, teamLabel } from './tvBoardHelpers';

export function TvBoardRow({
  row, idx, department, money, rowVh, fontVh, isToday, now, glow,
}: {
  row: BoardRow;
  idx: number;
  department: Department | null;
  money: boolean;
  rowVh: number;
  fontVh: number;
  isToday: boolean;
  now: Date;
  glow: boolean;
}) {
  const { t } = useTranslation();
  const chips = deptChips(row, department);
  const booked = bookedChips(row, department);
  const sold = row.total_count > 0;
  const p = row.presence;
  const quiet = !sold && !row.worked && (p.state === 'offline' || p.state === 'n/a');
  const conv = conversionPct(row);
  const den = (v: number | undefined) => (money ? formatDenari(v ?? 0) : '');
  // chips and second lines never shrink below what a wall screen can be read from
  const chipVh = Math.max(1.45, fontVh * 0.8);
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
          <div className="truncate text-slate-400 tabular-nums" style={{ fontSize: `${smallVh}vh` }}>
            {start ? `${hhmm(start)}–${end ? hhmm(end) : ''}` : ''}
            {p.idle_alerts > 0 && (
              <span className="ml-[0.4vw] inline-flex items-center gap-[0.2vw] text-amber-300" title={t('tvBoard.idleAlerts', { n: p.idle_alerts })}>
                <BellRing style={{ width: '1.3vh', height: '1.3vh' }} />{p.idle_alerts}
              </span>
            )}
          </div>
        </div>
      );
    }
    if (row.last_decision_at) return <div className="truncate text-slate-300" style={{ fontSize: `${smallVh}vh` }}>{lastDecisionText(row.last_decision_at)}</div>;
    if (p.first_login) return <div className="truncate text-slate-400" style={{ fontSize: `${smallVh}vh` }}>{t('tvBoard.loggedInAt', { time: hhmm(p.first_login) })}</div>;
    return <div className="truncate text-slate-500" style={{ fontSize: `${smallVh}vh` }}>{p.state === 'n/a' ? t('leaderboard2.noCrmLogin') : '—'}</div>;
  };

  return (
    <div data-testid="tv-row"
      className={`grid ${TV_GRID} items-center border-t border-white/5 px-[1.6vw] ${idx % 2 ? 'bg-white/[0.015]' : ''} ${sold ? '' : quiet ? 'opacity-40' : 'opacity-60'}`}
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
          {teamLabel(t, row.team_key, row.team_name)}
        </span>
        {isToday && p.state === 'idle' && (p.idle_streak_min ?? 0) > 0 && (
          <span className="shrink-0 rounded bg-amber-400/15 px-[0.5vw] py-[0.2vh] text-[1.2vh] font-semibold text-amber-300">{t('tvBoard.idleFor', { n: p.idle_streak_min })}</span>
        )}
        {isToday && p.state === 'break' && (
          <span className="shrink-0 rounded bg-sky-400/15 px-[0.5vw] py-[0.2vh] text-[1.2vh] font-semibold text-sky-300">{t('tvBoard.stateBreak')}</span>
        )}
      </div>
      {/* Departments: sales per department + the bookings awaiting a parcel */}
      <div className="flex min-w-0 flex-wrap items-center gap-[0.4vw] py-[0.4vh]" style={{ fontSize: `${chipVh}vh` }}>
        {chips.map((c) => (
          <span key={c.dept} data-testid={`chip-${c.dept}`} title={t(`leaderboard2.dept.${deptKey(c.dept)}`)}
            className={`inline-flex items-center whitespace-nowrap rounded-md px-[0.6vw] py-[0.25vh] font-semibold ring-1 ${DEPT_TONE[c.dept]}`}>
            {money
              ? t('leaderboard2.chip', { dept: t(`leaderboard2.deptShort.${deptKey(c.dept)}`), n: c.sales, value: formatDenari(c.value_mkd) })
              : t('leaderboard2.chipCount', { dept: t(`leaderboard2.deptShort.${deptKey(c.dept)}`), n: c.sales })}
          </span>
        ))}
        {/* collabBox bookings still waiting for a parcel: dashed, in the department's colour */}
        {booked.map((b) => (
          <span key={`b-${b.dept}`} data-testid={`chip-booked-${b.dept}`}
            title={`${t(`leaderboard2.dept.${deptKey(b.dept)}`)} — ${t('leaderboard2.bookedHint')}`}
            className={`inline-flex items-center whitespace-nowrap rounded-md border border-dashed border-current px-[0.6vw] py-[0.2vh] font-semibold ${DEPT_TEXT[b.dept]}`}>
            {money
              ? t('leaderboard2.bookedChip', { dept: t(`leaderboard2.deptShort.${deptKey(b.dept)}`), n: b.booked, value: formatDenari(b.value_mkd) })
              : t('leaderboard2.bookedChipCount', { dept: t(`leaderboard2.deptShort.${deptKey(b.dept)}`), n: b.booked })}
          </span>
        ))}
        {!chips.length && !booked.length && <span className="text-slate-600">—</span>}
      </div>
      {/* Total */}
      <div className="text-right tabular-nums">
        <div className="font-bold">
          {row.total_count}
          {row.cancelled_after_sale > 0 && (
            <span className="ml-[0.3vw] text-[0.5em] font-medium text-rose-300" title={t('leaderboard2.cancelledHint')}>−{row.cancelled_after_sale}</span>
          )}
        </div>
        {money && <div className="font-semibold text-slate-300" style={{ fontSize: `${smallVh}vh` }}>{den(row.total_value_mkd)}</div>}
      </div>
      {/* Worked — the whole day */}
      <div className="text-center tabular-nums text-slate-200">
        <div>{row.worked || '—'}</div>
        {conv != null && <div className="text-slate-400" style={{ fontSize: `${smallVh}vh` }}>{t('leaderboard2.convShort', { pct: conv.toFixed(1) })}</div>}
      </div>
      {/* Time on the CRM / last decision */}
      {timeCell()}
    </div>
  );
}
