import type { OverviewSparkPoint } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * Stat-tile sparkline: the series in the de-emphasis gray, the current (last)
 * point as an accent dot with a surface ring. Decorative — the tile states the
 * value in text and the trend block has the table twin — so it is aria-hidden.
 * The line stretches to the tile; the dot is HTML so it stays round.
 */
export function Sparkline({
  points, accentClass = 'bg-foreground', className,
}: { points: OverviewSparkPoint[] | null | undefined; accentClass?: string; className?: string }) {
  const pts = (points ?? []).filter((p) => Number.isFinite(p.v));
  if (pts.length < 2) return <div className={cn('h-7', className)} aria-hidden />;
  const W = 100, H = 28, pad = 4;
  const vs = pts.map((p) => p.v);
  const min = Math.min(...vs), max = Math.max(...vs);
  const span = max - min || 1;
  const x = (i: number) => (i * W) / (pts.length - 1);
  const y = (v: number) => H - pad - ((v - min) / span) * (H - 2 * pad);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(2)},${y(p.v).toFixed(2)}`).join(' ');
  const lastY = y(pts[pts.length - 1].v);
  return (
    <div className={cn('relative h-7', className)} aria-hidden>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-full w-full overflow-visible">
        <path d={d} fill="none" stroke="var(--ov-context)" strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      </svg>
      <span
        className={cn('absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-card', accentClass)}
        style={{ left: '100%', top: `${(lastY / H) * 100}%` }}
      />
    </div>
  );
}
