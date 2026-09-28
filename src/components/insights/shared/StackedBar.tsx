import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { cn } from '@/lib/utils';

export interface StackSegment {
  key: string;
  /** Flex weight (денари for owners, else the count). */
  weight: number;
  /** Literal Tailwind class(es) for the fill (light + dark). */
  tone: string;
  /** Texture channel (a CSS background-image), e.g. the unproven hatch. */
  pattern?: string;
  /** Readout, already formatted: "Наплатено · 717 (53,6%) · 1.685.032 ден". */
  text: string;
  href?: string | null;
}

/**
 * A 100 % stacked bar — the Overview's OutcomeBar, generic: flex weights, 2 px
 * surface gaps, rounded ends, never narrower than a sliver. Each segment is
 * its own hit target (hover or keyboard focus shows the readout) and, when
 * the link is exact, opens the orders it counts.
 */
export function StackedBar({ segments, label, className }: { segments: StackSegment[]; label: string; className?: string }) {
  const navigate = useNavigate();
  const ref = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ key: string; x: number } | null>(null);
  const shown = segments.filter((s) => s.weight > 0);

  if (!shown.length) return <div className={cn('rounded-full bg-muted', className)} aria-hidden />;

  const show = (key: string, el: HTMLElement) => {
    const box = ref.current?.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (box) setTip({ key, x: r.left - box.left + r.width / 2 });
  };
  const active = tip ? shown.find((s) => s.key === tip.key) : null;

  return (
    <div ref={ref} className="relative">
      <div role="group" aria-label={`${label}: ${shown.map((s) => s.text).join(' · ')}`} className={cn('flex gap-[2px] overflow-hidden rounded-full', className)}>
        {shown.map((s) => (
          <div
            key={s.key}
            role={s.href ? 'link' : 'img'}
            tabIndex={s.href ? 0 : -1}
            aria-label={s.text}
            onPointerEnter={(e) => show(s.key, e.currentTarget)}
            onPointerLeave={() => setTip(null)}
            onFocus={(e) => show(s.key, e.currentTarget)}
            onBlur={() => setTip(null)}
            onClick={() => s.href && navigate(s.href)}
            onKeyDown={(e) => { if (s.href && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); navigate(s.href); } }}
            className={cn(
              'h-full min-w-[3px] transition-[filter] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
              s.tone,
              s.href && 'cursor-pointer hover:brightness-110',
              tip?.key === s.key && 'brightness-110',
            )}
            style={{ flexGrow: s.weight, flexBasis: 0, ...(s.pattern ? { backgroundImage: s.pattern } : {}) }}
          />
        ))}
      </div>
      {active && (() => {
        // Keep the readout inside the card: centred over the segment, pinned near either end.
        const w = ref.current?.clientWidth ?? 0;
        const align = tip!.x < w * 0.2 ? 'left' : tip!.x > w * 0.8 ? 'right' : 'center';
        return (
          <div
            role="presentation"
            className={cn(
              'pointer-events-none absolute bottom-full z-20 mb-1.5 max-w-[90vw] whitespace-nowrap rounded-md border bg-popover px-2 py-1 text-xs tabular-nums text-popover-foreground shadow-md',
              align === 'center' && '-translate-x-1/2',
            )}
            style={align === 'left' ? { left: 0 } : align === 'right' ? { right: 0 } : { left: tip!.x }}
          >
            {active.text}
          </div>
        );
      })()}
    </div>
  );
}
