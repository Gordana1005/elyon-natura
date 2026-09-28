import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useIsFetching, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { DmyDateInput } from './DmyDateInput';
import { MAX_SPAN_DAYS, PERIOD_PRESETS, addDays, daysBetween, periodText, type PeriodPreset } from './period';
import { isInsightsQueryKey, useInsightsPeriod } from './useInsightsPeriod';

const chip = 'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
const chipOn = 'border-foreground/80 bg-foreground text-background';
const chipOff = 'bg-card text-foreground hover:bg-muted';

/** Earliest day the custom pickers offer (three years back). */
const EARLIEST_YEARS = 3;

/**
 * THE period filter of /insights — mounted once by the page, above whichever
 * tab is open, so every tab counts the same Skopje days and a tab switch keeps
 * them. Presets are calendar periods (this week = Monday → today); custom days
 * are written dd.mm.yyyy; compare = the equal span right before.
 *
 * The loading indicator follows every query whose key starts with 'insights'
 * (past ~3 s it shows the elapsed seconds and a Cancel).
 * `children` = a tab's own extra controls, shown on the same card.
 */
export function InsightsFilterBar({ className, children }: { className?: string; children?: ReactNode }) {
  const { t } = useTranslation();
  const period = useInsightsPeriod();
  const { preset, range, compare, prev, today, setPeriod } = period;

  const [showCustom, setShowCustom] = useState(preset === 'custom');
  const [draft, setDraft] = useState<{ from: string | null; to: string | null }>(range);
  useEffect(() => { setDraft(range); }, [range.from, range.to]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (preset === 'custom') setShowCustom(true); }, [preset]);

  const pick = (p: PeriodPreset) => {
    if (p === 'custom') { setShowCustom(true); return; }
    setShowCustom(false);
    setPeriod({ preset: p });
  };

  const min = addDays(today, -EARLIEST_YEARS * 365);
  const reversed = !!draft.from && !!draft.to && draft.from > draft.to;
  const tooLong = !!draft.from && !!draft.to && !reversed && daysBetween(draft.from, draft.to) > MAX_SPAN_DAYS;
  const canApply = !!draft.from && !!draft.to && !reversed && !tooLong;
  const apply = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canApply) return;
    setPeriod({ preset: 'custom', range: { from: draft.from!, to: draft.to! } });
  };

  // Loading: any /insights query in flight; past ~3 s, seconds + Cancel.
  const queryClient = useQueryClient();
  const fetching = useIsFetching({ predicate: (q) => isInsightsQueryKey(q.queryKey) }) > 0;
  const [slowSecs, setSlowSecs] = useState(0);
  useEffect(() => {
    if (!fetching) { setSlowSecs(0); return; }
    const id = setInterval(() => setSlowSecs((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [fetching]);

  return (
    <div className={cn('space-y-2 rounded-xl border bg-card/80 p-3 shadow-sm backdrop-blur-sm', className)}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div role="group" aria-label={t('insights.common.period.label')} className="flex flex-wrap gap-1.5">
          {PERIOD_PRESETS.map((p) => {
            const active = p === 'custom' ? (preset === 'custom' || showCustom) : preset === p && !showCustom;
            return (
              <button key={p} type="button" aria-pressed={active} onClick={() => pick(p)} className={cn(chip, active ? chipOn : chipOff)}>
                {t(`insights.common.period.${p}`)}
              </button>
            );
          })}
        </div>
        <span className="text-xs font-medium tabular-nums" data-testid="insights-period">{periodText(range)}</span>
        <label className="flex items-center gap-2 text-xs">
          <Switch checked={compare} onCheckedChange={(v) => setPeriod({ compare: v })} aria-label={t('insights.common.period.compare')} />
          <span>{t('insights.common.period.compare')}</span>
          {prev && <span className="tabular-nums text-muted-foreground">{t('insights.common.period.vs', { period: periodText(prev) })}</span>}
        </label>
        <div className="ml-auto flex min-h-8 items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
          {fetching && slowSecs >= 3 ? (
            <>
              <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
              <span>{t('insights.slowLoading', { s: slowSecs })}</span>
              <Button
                variant="ghost" size="sm" className="h-6 px-2 text-xs"
                onClick={() => queryClient.cancelQueries({ predicate: (q) => isInsightsQueryKey(q.queryKey) })}
              >
                {t('common.cancel')}
              </Button>
            </>
          ) : fetching ? (
            <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-label={t('insights.common.period.loading')} />
          ) : null}
        </div>
      </div>

      {showCustom && (
        <form onSubmit={apply} className="flex flex-wrap items-end gap-2">
          <DmyDateInput
            label={t('insights.common.period.from')}
            value={draft.from}
            onChange={(v) => setDraft((d) => ({ ...d, from: v }))}
            min={min} max={today} invalid={reversed}
          />
          <DmyDateInput
            label={t('insights.common.period.to')}
            value={draft.to}
            onChange={(v) => setDraft((d) => ({ ...d, to: v }))}
            min={min} max={today} invalid={reversed}
          />
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
