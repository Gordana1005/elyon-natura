import { AlertTriangle, Info } from 'lucide-react';
import { cn } from '@/lib/utils';
import { STATUS_TEXT } from '../shared/cohortPalette';
import type { InsightsFormat } from '../shared/useInsightsFormat';
import type { SalesQualityItem } from './salesModel';

/**
 * What this tab's tables cannot vouch for yet — product names no reviewed
 * alias maps, package counts no price supports, lines recognised by rule,
 * places outside the register, sales with no city or phone. Review queues,
 * never fixed automatically. Same card language as the shared quality rail.
 */
export function SalesQualityCards({ items, money, f }: { items: SalesQualityItem[]; money: boolean; f: InsightsFormat }) {
  const { t } = f;
  if (!items.length) return null;
  return (
    <section aria-labelledby="sa-quality-title" className="space-y-3">
      <h3 id="sa-quality-title" className="text-sm font-semibold">{t('insights.sales.quality.title')}</h3>
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {items.map((q) => {
          const Icon = q.severity === 'warning' ? AlertTriangle : Info;
          const tone = q.severity === 'warning' ? STATUS_TEXT.warning : STATUS_TEXT.neutral;
          return (
            <li key={q.kind} className={cn('flex min-w-0 flex-col rounded-xl border bg-card p-4 shadow-sm', q.severity === 'warning' && 'border-amber-300 dark:border-amber-900')}>
              <span className={cn('inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide', tone)}>
                <Icon className="h-3.5 w-3.5" aria-hidden />{t(`insights.common.quality.severity.${q.severity}`)}
              </span>
              <h4 className="mt-1 text-sm font-medium leading-snug">{t(`insights.sales.quality.kind.${q.kind}`)}</h4>
              <div className="mt-1 flex flex-wrap items-baseline gap-x-2">
                <span className="text-2xl font-semibold tabular-nums">{f.int(q.count)}</span>
                {money && q.value_mkd != null && q.value_mkd !== 0 && (
                  <span className="text-sm tabular-nums text-muted-foreground">{f.den(q.value_mkd)}</span>
                )}
              </div>
              <p className="mt-2 text-[11px] leading-snug text-muted-foreground">{t(`insights.sales.quality.hint.${q.kind}`)}</p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
