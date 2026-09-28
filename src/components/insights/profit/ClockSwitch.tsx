import { useId } from 'react';
import { CalendarCheck2, Wallet } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ProfitClock } from '@/lib/insightsApi/profit';
import type { InsightsFormat } from '../shared/useInsightsFormat';
import { STATUS_TEXT } from '../shared/cohortPalette';

export type ClockKey = 'cohort' | 'cash';

/**
 * The two clocks of the P&L, side by side with their bottom line, so neither
 * number can be read as the other: the SALES made in the period and what MEX
 * collected on them (cohort) · the MONEY that landed in the period, whatever
 * day it was sold (cash). One is selected and drives everything below.
 */
export function ClockSwitch({
  value, onChange, cohort, cash, f,
}: {
  value: ClockKey;
  onChange: (v: ClockKey) => void;
  cohort: ProfitClock;
  cash: ProfitClock;
  f: InsightsFormat;
}) {
  const { t } = f;
  const id = useId();
  const items: { key: ClockKey; c: ProfitClock; Icon: typeof Wallet }[] = [
    { key: 'cohort', c: cohort, Icon: CalendarCheck2 },
    { key: 'cash', c: cash, Icon: Wallet },
  ];
  return (
    <div role="radiogroup" aria-labelledby={`${id}-l`} className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      <span id={`${id}-l`} className="sr-only">{t('insights.profit.clock.label')}</span>
      {items.map(({ key, c, Icon }) => {
        const on = value === key;
        const net = c.total.net_mkd;
        return (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(key)}
            className={cn(
              'flex min-w-0 flex-col items-start gap-1 rounded-xl border bg-card p-3 text-left shadow-sm transition-colors sm:p-4',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              on ? 'border-primary ring-1 ring-primary' : 'hover:bg-muted/40',
            )}
          >
            <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <Icon className="h-3.5 w-3.5" aria-hidden />{t(`insights.profit.clock.${key}`)}
            </span>
            <span className="text-[11px] leading-snug text-muted-foreground">{t(`insights.profit.clock.${key}Hint`)}</span>
            <span className="mt-1 flex flex-wrap items-baseline gap-x-2">
              <span className={cn('text-xl font-semibold tabular-nums sm:text-2xl', net < 0 ? STATUS_TEXT.critical : 'text-card-foreground')}>
                {f.den(net)}
              </span>
              <span className="text-xs tabular-nums text-muted-foreground">
                {t('insights.profit.clock.netOf', { margin: f.pct(c.total.margin), revenue: f.den(c.total.revenue_mkd) })}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
