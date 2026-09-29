// Small building blocks of the TV leaderboard (src/pages/TvLeaderboardPage.tsx):
// the stat tile, the presence dot and the confetti (tones and helpers:
// tvBoardHelpers.ts). Wall-screen sizing is in vh so a 32" and a 65" TV look alike.
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { PresenceStateV2 } from '@/lib/leaderboardV2';

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

export function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-white/10 bg-white/[0.03] px-[1.4vw] py-[1.2vh]">
      <div className="truncate text-[1.4vh] font-medium uppercase tracking-[0.12em] text-slate-400">{label}</div>
      <div className="mt-[0.4vh] truncate text-[3.4vh] font-bold leading-none tabular-nums text-slate-50">{value}</div>
      {sub && <div className="mt-[0.5vh] truncate text-[1.35vh] text-slate-400">{sub}</div>}
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

export function PresenceDot({ state }: { state: PresenceStateV2 | undefined }) {
  const { t } = useTranslation();
  if (!state) return null;
  const label = {
    online: t('tvBoard.stateOnline'), idle: t('tvBoard.stateIdle'), break: t('tvBoard.stateBreak'),
    offline: t('tvBoard.stateOffline'), 'n/a': t('tvBoard.stateNa'),
  }[state];
  return (
    <span title={label} aria-label={label}
      className={`inline-block shrink-0 rounded-full ${DOT[state]} ${state === 'idle' ? 'animate-pulse' : ''}`}
      style={{ width: '1.2vh', height: '1.2vh' }} />
  );
}
