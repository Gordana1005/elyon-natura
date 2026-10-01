import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { periodText, spanDays, stepRange, type DayRange, type PeriodPreset } from './period';

const arrow = 'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border bg-card text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40';

/**
 * ← 30.09.2026 → — step the period day by day (or by its own length), like the shop's dashboard
 * (owner 01.10.2026). → is disabled once the period ends today. Used by the /insights filter bar
 * (Табла included) and the /orders period.
 */
export function PeriodStepper({
  range, today, onStep, className, testId,
}: {
  range: DayRange;
  today: string;
  onStep: (next: { preset: PeriodPreset; range: DayRange }) => void;
  className?: string;
  testId?: string;
}) {
  const { t } = useTranslation();
  const oneDay = spanDays(range) === 1;
  const prev = stepRange(range, -1, today);
  const next = stepRange(range, 1, today);
  const prevLabel = t(oneDay ? 'insights.common.period.prevDay' : 'insights.common.period.prevPeriod');
  const nextLabel = t(oneDay ? 'insights.common.period.nextDay' : 'insights.common.period.nextPeriod');
  return (
    <div className={cn('inline-flex items-center gap-1.5', className)}>
      <button type="button" className={arrow} disabled={!prev} onClick={() => prev && onStep(prev)} aria-label={prevLabel} title={prevLabel}>
        <ChevronLeft className="h-4 w-4" aria-hidden />
      </button>
      <span className="min-w-[5.5rem] text-center text-xs font-medium tabular-nums" data-testid={testId}>{periodText(range)}</span>
      <button type="button" className={arrow} disabled={!next} onClick={() => next && onStep(next)} aria-label={nextLabel} title={nextLabel}>
        <ChevronRight className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}
