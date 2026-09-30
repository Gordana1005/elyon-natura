import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { TFunction } from 'i18next';
import { Check, Circle, CircleDashed, PhoneCall, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { departmentLabel } from '@/lib/orderSource';
import { sourceColorVar } from '@/components/insights/overview/palette';
import { UNKNOWN_DEPARTMENT } from '@/lib/assignerApi';
import type { BoardPresence } from '@/lib/assigner/board';

// Small building blocks shared by the Assigner — the Insights card language
// (FilterBar chips, muted uppercase labels, tabular numbers), nothing new.

// min-h-9 below sm: a 36 px touch target on phones; a long label wraps inside the pill.
export const CHIP =
  'inline-flex min-h-9 max-w-full items-center gap-1.5 rounded-full border px-3 py-1 text-left text-xs font-medium leading-tight transition-colors sm:min-h-8 ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50';
export const CHIP_ON = 'border-foreground/60 bg-muted text-foreground';
export const CHIP_OFF = 'bg-card text-foreground hover:bg-muted';
export const LABEL = 'text-[11px] font-medium uppercase tracking-wide text-muted-foreground';

/** A toggle chip with the Insights "selected" look (border + muted fill + a check). */
export function Chip({
  on, onClick, children, title, className, disabled, ariaLabel,
}: {
  on: boolean; onClick: () => void; children: ReactNode; title?: string; className?: string; disabled?: boolean; ariaLabel?: string;
}) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick} title={title} disabled={disabled} aria-label={ariaLabel}
      className={cn(CHIP, on ? CHIP_ON : CHIP_OFF, className)}>
      {children}
      {on && <Check className="h-3 w-3 shrink-0" aria-hidden />}
    </button>
  );
}

/** A labelled single-choice row of chips (count presets, split, order). */
export function ChipGroup<V extends string | number>({
  label, value, options, onChange, className,
}: {
  label: string;
  value: V;
  options: { value: V; label: string; title?: string }[];
  onChange: (v: V) => void;
  className?: string;
}) {
  return (
    <div role="group" aria-label={label} className={cn('flex flex-wrap items-center gap-1.5', className)}>
      <span className={cn(LABEL, 'mr-0.5')}>{label}</span>
      {options.map((o) => (
        <Chip key={String(o.value)} on={o.value === value} onClick={() => onChange(o.value)} title={o.title}>
          {o.label}
        </Chip>
      ))}
    </div>
  );
}

/** The department's identity dash — needs OVERVIEW_COLOR_VARS on an ancestor. */
export function DeptDash({ dept, className }: { dept: string; className?: string }) {
  return (
    <span
      className={cn('h-[3px] w-3 shrink-0 rounded-full', dept === UNKNOWN_DEPARTMENT && 'bg-muted-foreground/40', className)}
      style={dept === UNKNOWN_DEPARTMENT ? undefined : { background: sourceColorVar(dept) }}
      aria-hidden
    />
  );
}

/** A department's label in the reader's language ('unknown' included). */
export const deptName = (t: TFunction, dept: string | null | undefined) =>
  departmentLabel(t, dept) ?? t('assigner.dept.unknown');

/** Presence: a shape + a colour + a word (never colour alone). */
export const PRESENCE_UI: Record<BoardPresence, { icon: LucideIcon; tone: string; key: string }> = {
  in_call: { icon: PhoneCall, tone: 'text-rose-600 dark:text-rose-400', key: 'assigner.statusInCall' },
  online: { icon: Circle, tone: 'fill-emerald-500 text-emerald-500', key: 'assigner.statusAvailable' },
  offline: { icon: CircleDashed, tone: 'text-muted-foreground', key: 'assigner.statusOffline' },
};

export function PresenceMark({ presence, t, className }: { presence: BoardPresence; t: TFunction; className?: string }) {
  const p = PRESENCE_UI[presence];
  const Icon = p.icon;
  return (
    <>
      <Icon className={cn('h-3 w-3 shrink-0', p.tone, presence === 'in_call' && 'motion-safe:animate-pulse', className)} aria-hidden />
      <span className="sr-only">({t(p.key)})</span>
    </>
  );
}

/**
 * Which way a live number just moved — for a short highlight, so a count that
 * drops as an agent works is SEEN to drop. Null when nothing changed recently.
 */
export function useChangeFlash(value: number, ms = 1_600): 'down' | 'up' | null {
  const prev = useRef(value);
  const [dir, setDir] = useState<'down' | 'up' | null>(null);
  useEffect(() => {
    if (value === prev.current) return;
    setDir(value < prev.current ? 'down' : 'up');
    prev.current = value;
    const id = window.setTimeout(() => setDir(null), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return dir;
}

/** A live count with an icon; flashes emerald when it drops, amber when it grows. */
export function LiveCount({
  icon: Icon, value, text, title, className,
}: { icon: LucideIcon; value: number; text: string; title: string; className?: string }) {
  const dir = useChangeFlash(value);
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1 rounded px-1 py-0.5 tabular-nums motion-safe:transition-colors motion-safe:duration-700',
        value === 0 && 'text-muted-foreground/70',
        dir === 'down' && 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
        dir === 'up' && 'bg-amber-500/15 text-amber-800 dark:text-amber-300',
        className,
      )}
    >
      <Icon className="h-3 w-3 shrink-0" aria-hidden />
      <span>{text}</span>
      <span className="sr-only">{title}</span>
    </span>
  );
}

/**
 * A card's head on a phone: the name WRAPS (never cut), extra badges wrap
 * under it and the phone gets its own line — the shared MobileCardHeader
 * truncates both, which cut long Macedonian names and hid the "done" badge.
 */
export function CardHead({ title, sub, badges }: { title: ReactNode; sub?: ReactNode; badges?: ReactNode }) {
  return (
    <div className="min-w-0 flex-1 space-y-0.5">
      <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
        <span className="min-w-0 break-words text-sm font-semibold leading-snug text-card-foreground">{title}</span>
        {badges}
      </div>
      {sub != null && <div className="min-w-0 break-all font-mono text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

/**
 * Paging that fits a phone: ‹ 2 / 14 › with 36 px targets below `sm`, the
 * shared SmartPagination from `sm` up.
 */
export function ResponsivePager({
  page, totalPages, onPageChange, t, desktop,
}: { page: number; totalPages: number; onPageChange: (p: number) => void; t: TFunction; desktop: ReactNode }) {
  if (totalPages <= 1) return null;
  const btn = 'inline-flex h-9 w-9 items-center justify-center rounded-lg border text-sm hover:bg-muted disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
  return (
    <>
      <div className="flex items-center justify-center gap-2 sm:hidden">
        <button type="button" className={btn} disabled={page <= 1} onClick={() => onPageChange(page - 1)} aria-label={t('pagination.prev')}>‹</button>
        <span className="min-w-[4rem] text-center text-sm tabular-nums">{page} / {totalPages}</span>
        <button type="button" className={btn} disabled={page >= totalPages} onClick={() => onPageChange(page + 1)} aria-label={t('pagination.next')}>›</button>
      </div>
      <div className="hidden sm:block">{desktop}</div>
    </>
  );
}
