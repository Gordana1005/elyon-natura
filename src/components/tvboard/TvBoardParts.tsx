// Small building blocks of the TV leaderboard (src/pages/TvLeaderboardPage.tsx):
// the stat tile, the presence dot, the department chips and the confetti (tones
// and helpers: tvBoardHelpers.ts). Wall-screen sizing is in vh so a 32" and a 65"
// TV look alike; below 1024 px wide (phones, tablets) the same parts use rem
// sizes (the `lg:` prefix is the wall screen).
import { useMemo, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDenari } from '@/lib/currency';
import {
  bookedChips, deptChips, deptKey, type BoardRow, type Department, type PresenceStateV2,
} from '@/lib/leaderboardV2';
import { DEPT_TEXT, DEPT_TONE } from './tvBoardHelpers';

/** Tasteful confetti (thin brand-colored strips, no emoji). */
export function Confetti() {
  const bits = useMemo(() => Array.from({ length: 36 }, (_, i) => ({
    id: i, left: Math.random() * 100, delay: Math.random() * 0.8, dur: 2.6 + Math.random() * 1.8,
    color: ['#34d399', '#818cf8', '#fbbf24', '#f9fafb', '#22d3ee'][i % 5], rot: Math.random() * 360,
  })), []);
  return (
    <div className="pointer-events-none fixed inset-0 z-50 overflow-hidden">
      {bits.map((b) => (
        <span key={b.id} className="absolute -top-10 block"
          style={{ left: `${b.left}%`, width: '7px', height: '16px', background: b.color, borderRadius: '2px',
            transform: `rotate(${b.rot}deg)`, animation: `tv-fall ${b.dur}s cubic-bezier(.3,.1,.5,1) ${b.delay}s 1` }} />
      ))}
    </div>
  );
}

/** A KPI tile: two-line label and sub on a phone, one truncated line on the wall screen. */
export function StatCard({ label, value, sub, className = '', testId }: {
  label: string; value: string; sub?: string; className?: string; testId?: string;
}) {
  return (
    <div data-testid={testId} className={`min-w-0 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5 lg:px-[1.4vw] lg:py-[1.2vh] ${className}`}>
      <div className="line-clamp-2 text-[11px] font-medium uppercase leading-tight tracking-[0.08em] text-slate-400 lg:line-clamp-1 lg:text-[1.4vh] lg:tracking-[0.12em]">{label}</div>
      <div className="mt-1 truncate text-2xl font-bold leading-none tabular-nums text-slate-50 lg:mt-[0.4vh] lg:text-[3.4vh]">{value}</div>
      {sub && <div className="mt-1 line-clamp-2 text-[11px] leading-snug text-slate-400 lg:mt-[0.5vh] lg:line-clamp-1 lg:text-[1.35vh]">{sub}</div>}
    </div>
  );
}

const DOT: Record<PresenceStateV2, string> = {
  online: 'bg-emerald-400 shadow-[0_0_0.8vh_rgba(52,211,153,0.8)]',
  idle: 'bg-amber-400',
  break: 'bg-sky-400',
  offline: 'bg-slate-600',
  'n/a': 'border-2 border-slate-500 bg-transparent',
};

export function PresenceDot({ state, compact = false }: { state: PresenceStateV2 | undefined; compact?: boolean }) {
  const { t } = useTranslation();
  if (!state) return null;
  const label = {
    online: t('tvBoard.stateOnline'), idle: t('tvBoard.stateIdle'), break: t('tvBoard.stateBreak'),
    offline: t('tvBoard.stateOffline'), 'n/a': t('tvBoard.stateNa'),
  }[state];
  return (
    <span title={label} aria-label={label}
      className={`inline-block shrink-0 rounded-full ${DOT[state]} ${state === 'idle' ? 'animate-pulse' : ''} ${compact ? 'h-2.5 w-2.5 ring-2 ring-slate-900' : ''}`}
      style={compact ? undefined : { width: '1.2vh', height: '1.2vh' }} />
  );
}

/**
 * One chip per department the person sold in ("Aff. out 3 · 9.000 ден") and the
 * collabBox bookings still waiting for a parcel ("Тел. out +5 чекаат пратка") —
 * dashed, in the department's colour. `compact` = the phone card: rem sizes and
 * a chip may wrap instead of running past a narrow screen.
 */
export function DeptChips({ row, department, money, compact = false, className = '', style }: {
  row: BoardRow;
  department: Department | null;
  money: boolean;
  compact?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  const { t } = useTranslation();
  const chips = deptChips(row, department);
  const booked = bookedChips(row, department);
  const wrap = compact ? 'whitespace-normal' : 'whitespace-nowrap';
  return (
    <div className={`flex min-w-0 flex-wrap items-center ${compact ? 'gap-1.5 text-xs' : 'gap-[0.4vw] py-[0.4vh]'} ${className}`} style={style}>
      {chips.map((c) => (
        <span key={c.dept} data-testid={`chip-${c.dept}`} title={t(`leaderboard2.dept.${deptKey(c.dept)}`)}
          className={`inline-flex items-center ${wrap} rounded-md ${compact ? 'px-2 py-0.5' : 'px-[0.6vw] py-[0.25vh]'} font-semibold ring-1 ${DEPT_TONE[c.dept]}`}>
          {money
            ? t('leaderboard2.chip', { dept: t(`leaderboard2.deptShort.${deptKey(c.dept)}`), n: c.sales, value: formatDenari(c.value_mkd) })
            : t('leaderboard2.chipCount', { dept: t(`leaderboard2.deptShort.${deptKey(c.dept)}`), n: c.sales })}
        </span>
      ))}
      {booked.map((b) => (
        <span key={`b-${b.dept}`} data-testid={`chip-booked-${b.dept}`}
          title={`${t(`leaderboard2.dept.${deptKey(b.dept)}`)} — ${t('leaderboard2.bookedHint')}`}
          className={`inline-flex items-center ${wrap} rounded-md border border-dashed border-current ${compact ? 'px-2 py-0.5' : 'px-[0.6vw] py-[0.2vh]'} font-semibold ${DEPT_TEXT[b.dept]}`}>
          {money
            ? t('leaderboard2.bookedChip', { dept: t(`leaderboard2.deptShort.${deptKey(b.dept)}`), n: b.booked, value: formatDenari(b.value_mkd) })
            : t('leaderboard2.bookedChipCount', { dept: t(`leaderboard2.deptShort.${deptKey(b.dept)}`), n: b.booked })}
        </span>
      ))}
      {!chips.length && !booked.length && <span className="text-slate-600">—</span>}
    </div>
  );
}
