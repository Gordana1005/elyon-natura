import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { InsightsFormat } from '@/components/insights/shared/useInsightsFormat';
import type { RatesDay } from '@/lib/altercpaGuaranteeApi';
import { StateBadge } from './bits';
import { rateToneClass } from './guaranteeText';
import type { CellPick } from './RatesMatrix';

/** Стапки below xl: a card per day — the MK total on top, a tappable row per webmaster. */
export function RatesDayCards({ days, wmName, f, onPick }: {
  days: RatesDay[];
  wmName: (wm: string) => string;
  f: InsightsFormat;
  onPick: CellPick;
}) {
  const { t } = f;
  return (
    <ul className="grid grid-cols-1 gap-3 md:grid-cols-2" data-testid="rates-cards">
      {days.map((d) => (
        <li key={d.day} className="flex min-w-0 flex-col gap-2 rounded-xl border bg-card p-3 shadow-sm">
          <button type="button" onClick={() => onPick(d.day, '*')} className="flex min-h-11 flex-wrap items-start justify-between gap-2 text-left">
            <span className="min-w-0">
              <span className="block text-sm font-semibold tabular-nums">{f.period(d.day, d.day)}</span>
              <span className="block text-[11px] text-muted-foreground tabular-nums">
                {t('altercpaGuarantee.card.counts', { counted: f.int(d.totals.counted), leads: f.int(d.totals.leads), open: f.int(d.totals.open) })}
              </span>
            </span>
            <span className="flex flex-col items-end gap-1">
              <span className={cn('text-xl font-semibold leading-none tabular-nums', rateToneClass(d.totals.state, d.totals.math))}>{f.pct(d.totals.math.rate)}</span>
              {d.settled ? <StateBadge state={d.totals.state} /> : <span className="text-[10px] text-muted-foreground">{t('altercpaGuarantee.rates.settlingDay')}</span>}
            </span>
          </button>
          {d.webmasters.length > 0 && (
            <ul className="divide-y border-t text-sm">
              {d.webmasters.map((w) => (
                <li key={w.webmaster}>
                  <button type="button" onClick={() => onPick(d.day, w.webmaster)}
                    className="flex min-h-11 w-full items-center gap-2 py-1.5 text-left hover:bg-muted/50">
                    <span className="min-w-0 flex-1 break-words">{wmName(w.webmaster)}</span>
                    <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                      {f.int(w.counted)}/{f.int(w.leads)}
                      {w.open > 0 && <> · {t('altercpaGuarantee.rates.openBadge', { n: f.int(w.open) })}</>}
                    </span>
                    <span className={cn('w-14 shrink-0 text-right font-semibold tabular-nums', rateToneClass(w.state, w.math))}>{f.pct(w.math.rate)}</span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}
