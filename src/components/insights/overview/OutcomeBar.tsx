import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Ban, CheckCircle2, CircleHelp, Hourglass, PackageOpen, Trash2, Truck, Undo2, type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { BAR_ORDER, BUCKET_TONE, type BarBucket } from './palette';

export type { BarBucket };

/** Icon per bucket — status buckets must never rely on colour alone. */
export const BUCKET_ICON: Record<BarBucket, LucideIcon> = {
  delivered: CheckCircle2,
  courier: Truck,
  preparing: PackageOpen,
  awaiting: Hourglass,
  returned: Undo2,
  cancelled: Ban,
  trashed: Trash2,
  no_record: CircleHelp,
};

export interface BarSegment {
  key: BarBucket;
  count: number;
  /** Already formatted (денари), owners only. */
  money?: string | null;
  href?: string | null;
}

/**
 * The shop panel's 100 % outcome bar: flex weights, 2px surface gaps, never
 * narrower than a sliver. Each segment is its own hit target (hover or keyboard
 * focus shows the readout) and opens the orders it counts.
 */
export function OutcomeBar({
  segments, label, share, int, bucketLabel, className,
}: {
  segments: BarSegment[];
  /** Accessible name of the whole bar. */
  label: string;
  share: (n: number, of: number) => string;
  int: (n: number) => string;
  bucketLabel: (b: string) => string;
  className?: string;
}) {
  const navigate = useNavigate();
  const ref = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ key: BarBucket; x: number } | null>(null);
  const ordered = BAR_ORDER.map((k) => segments.find((s) => s.key === k)).filter((s): s is BarSegment => !!s && s.count > 0);
  const total = ordered.reduce((a, s) => a + s.count, 0);
  const summary = ordered.map((s) => `${bucketLabel(s.key)} ${int(s.count)}`).join(' · ');

  if (total === 0) return <div className={cn('rounded-full bg-muted', className)} aria-hidden />;

  const show = (key: BarBucket, el: HTMLElement) => {
    const box = ref.current?.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (box) setTip({ key, x: r.left - box.left + r.width / 2 });
  };
  const active = tip ? ordered.find((s) => s.key === tip.key) : null;

  return (
    <div ref={ref} className="relative">
      <div role="group" aria-label={`${label}: ${summary}`} className={cn('flex gap-[2px] overflow-hidden rounded-full', className)}>
        {ordered.map((s) => {
          const text = `${bucketLabel(s.key)} · ${int(s.count)} (${share(s.count, total)})${s.money ? ` · ${s.money}` : ''}`;
          return (
            <div
              key={s.key}
              role={s.href ? 'link' : 'img'}
              tabIndex={s.href ? 0 : -1}
              aria-label={text}
              onPointerEnter={(e) => show(s.key, e.currentTarget)}
              onPointerLeave={() => setTip(null)}
              onFocus={(e) => show(s.key, e.currentTarget)}
              onBlur={() => setTip(null)}
              onClick={() => s.href && navigate(s.href)}
              onKeyDown={(e) => { if (s.href && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); navigate(s.href); } }}
              className={cn(
                'h-full min-w-[3px] transition-[filter] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                BUCKET_TONE[s.key],
                s.href && 'cursor-pointer hover:brightness-110',
                tip?.key === s.key && 'brightness-110',
              )}
              style={{ flexGrow: s.count, flexBasis: 0 }}
            />
          );
        })}
      </div>
      {active && (() => {
        // Keep the readout inside the card: centred over the segment, but
        // pinned to the bar's edge near either end.
        const w = ref.current?.clientWidth ?? 0;
        const align = tip!.x < w * 0.2 ? 'left' : tip!.x > w * 0.8 ? 'right' : 'center';
        return (
          <div
            role="presentation"
            className={cn(
              'pointer-events-none absolute bottom-full z-20 mb-1.5 whitespace-nowrap rounded-md border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md',
              align === 'center' && '-translate-x-1/2',
            )}
            style={align === 'left' ? { left: 0 } : align === 'right' ? { right: 0 } : { left: tip!.x }}
          >
            <span className="font-semibold tabular-nums">{int(active.count)}</span>
            <span className="text-muted-foreground"> · {share(active.count, total)}</span>
            {active.money && <span className="font-semibold tabular-nums"> · {active.money}</span>}
            <span className="ml-1.5 text-muted-foreground">{bucketLabel(active.key)}</span>
          </div>
        );
      })()}
    </div>
  );
}

/** Legend for every bar on the page — rect swatch mirrors the bar mark, icon carries status. */
export function OutcomeLegend({ bucketLabel, className, keys = BAR_ORDER }: {
  bucketLabel: (b: string) => string; className?: string; keys?: BarBucket[];
}) {
  return (
    <ul className={cn('flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground', className)}>
      {keys.map((k) => {
        const Icon = BUCKET_ICON[k];
        return (
          <li key={k} className="inline-flex items-center gap-1">
            <span className={cn('h-2.5 w-2.5 shrink-0 rounded-[3px]', BUCKET_TONE[k])} aria-hidden />
            <Icon className="h-3 w-3 shrink-0" aria-hidden />
            {bucketLabel(k)}
          </li>
        );
      })}
    </ul>
  );
}
