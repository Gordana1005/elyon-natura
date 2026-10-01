import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useIsFetching } from '@tanstack/react-query';
import { Loader2, Radio } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { isShopsQueryKey } from '@/lib/shopsApi';
import { DmyDateInput } from '@/components/insights/shared/DmyDateInput';
import { PeriodStepper } from '@/components/insights/shared/PeriodStepper';
import {
  MAX_SPAN_DAYS, PERIOD_PRESETS, addDays, daysBetween, type DayRange, type PeriodPreset,
} from '@/components/insights/shared/period';
import type { InsightsPeriod } from '@/components/insights/shared/useInsightsPeriod';

const chip = 'inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8';
const chipOn = 'border-foreground/80 bg-foreground text-background';
const chipOff = 'bg-card text-foreground hover:bg-muted';

/** Earliest day the custom pickers offer (the receipt backfill starts in 2025). */
const EARLIEST_DAYS = 3 * 365;

/**
 * The /shops period: Денес (default, live) · Последни 7 дена · Овој месец · Оваа година ·
 * Прилагодено, with ← / → stepping a day (a longer period by its own length; → stops at today) —
 * the /insights PeriodStepper and period rules, stored in the same URL params (range / from / to).
 * The spinner follows every `shops` query.
 */
export function ShopsFilterBar({ period, className, children }: { period: InsightsPeriod; className?: string; children?: ReactNode }) {
  const { t } = useTranslation();
  const { preset, range, today, setPeriod } = period;
  const [showCustom, setShowCustom] = useState(preset === 'custom');
  const [draft, setDraft] = useState<{ from: string | null; to: string | null }>(range);
  useEffect(() => { setDraft(range); }, [range.from, range.to]); // eslint-disable-line react-hooks/exhaustive-deps
  const stepped = useRef(false);
  useEffect(() => {
    if (preset === 'custom' && !stepped.current) setShowCustom(true);
    stepped.current = false;
  }, [preset]);

  const step = (next: { preset: PeriodPreset; range: DayRange }) => {
    stepped.current = true;
    setShowCustom(false);
    setPeriod(next.preset === 'custom' ? next : { preset: next.preset });
  };
  const pick = (p: PeriodPreset) => {
    if (p === 'custom') { setShowCustom(true); return; }
    setShowCustom(false);
    setPeriod({ preset: p });
  };

  const min = addDays(today, -EARLIEST_DAYS);
  const reversed = !!draft.from && !!draft.to && draft.from > draft.to;
  const tooLong = !!draft.from && !!draft.to && !reversed && daysBetween(draft.from, draft.to) > MAX_SPAN_DAYS;
  const canApply = !!draft.from && !!draft.to && !reversed && !tooLong;
  const apply = (e: React.FormEvent) => {
    e.preventDefault();
    if (canApply) setPeriod({ preset: 'custom', range: { from: draft.from!, to: draft.to! } });
  };

  const fetching = useIsFetching({ predicate: (q) => isShopsQueryKey(q.queryKey) }) > 0;
  const live = range.to === today;

  return (
    <div className={cn('space-y-2 rounded-xl border bg-card/80 p-3 shadow-sm backdrop-blur-sm', className)}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div role="group" aria-label={t('insights.common.period.label')} className="flex flex-wrap gap-1.5">
          {PERIOD_PRESETS.map((p) => {
            const active = p === 'custom' ? showCustom : preset === p && !showCustom;
            return (
              <button key={p} type="button" aria-pressed={active} onClick={() => pick(p)} className={cn(chip, active ? chipOn : chipOff)}>
                {t(`insights.common.period.${p}`)}
              </button>
            );
          })}
        </div>
        <PeriodStepper range={range} today={today} onStep={step} testId="shops-period" />
        {live && (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300">
            <Radio className="h-3 w-3" aria-hidden />{t('shops.live')}
          </span>
        )}
        <div className="ml-auto flex min-h-8 items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
          {fetching && <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-label={t('insights.common.period.loading')} />}
        </div>
      </div>

      {showCustom && (
        <form onSubmit={apply} className="flex flex-wrap items-end gap-2">
          <DmyDateInput label={t('insights.common.period.from')} value={draft.from} onChange={(v) => setDraft((d) => ({ ...d, from: v }))}
            min={min} max={today} invalid={reversed} />
          <DmyDateInput label={t('insights.common.period.to')} value={draft.to} onChange={(v) => setDraft((d) => ({ ...d, to: v }))}
            min={min} max={today} invalid={reversed} />
          <Button type="submit" size="sm" className="h-8" disabled={!canApply}>{t('insights.common.period.apply')}</Button>
          <span className={cn('text-[11px]', reversed || tooLong ? 'text-red-700 dark:text-red-400' : 'text-muted-foreground')} aria-live="polite">
            {reversed ? t('insights.common.period.reversed')
              : tooLong ? t('insights.common.period.tooLong', { n: MAX_SPAN_DAYS })
                : t('insights.common.period.hint', { n: MAX_SPAN_DAYS })}
          </span>
        </form>
      )}
      {children}
    </div>
  );
}
