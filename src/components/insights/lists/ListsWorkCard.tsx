import { useId } from 'react';
import { PhoneMissed } from 'lucide-react';
import type { ListsTotal } from '@/lib/insightsApi/lists';
import { cn } from '@/lib/utils';
import { ClockCaption } from '../shared/ClockCaption';
import { StackedBar } from '../shared/StackedBar';
import { COHORT_TONE, OUTSIDE_TONE } from '../shared/cohortPalette';
import type { InsightsFormat } from '../shared/useInsightsFormat';
import { conversionOf, reachOf } from './listModel';

/** Decision order and colour = the LeadsInCard trio (validated there). */
const PARTS = [
  { key: 'worked_sale', tone: COHORT_TONE.paid },
  { key: 'worked_no', tone: OUTSIDE_TONE.cancelled_after_sale },
  { key: 'worked_trash', tone: OUTSIDE_TONE.trashed },
] as const;

/**
 * "Обработени од листите" — the calls that ended in a decision (the work
 * ledger, decision day): a sale, a "no", a trash. Never money. The "no
 * answer" clicks sit apart — they are not decisions, and the click does not
 * record its list (they are filed by the list the number is in now).
 */
export function ListsWorkCard({ total, f, className }: { total: ListsTotal; f: InsightsFormat; className?: string }) {
  const { t } = f;
  const titleId = useId();
  const conv = conversionOf(total.count, total.worked);
  const reach = reachOf(total.worked, total.no_answer);
  return (
    <section aria-labelledby={titleId} className={cn('flex min-w-0 flex-col gap-2 rounded-xl border bg-card p-4 shadow-sm', className)}>
      <div>
        <h3 id={titleId} className="text-sm font-medium text-muted-foreground">{t('insights.lists.work.title')}</h3>
        <ClockCaption clock="decided" />
      </div>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-2xl font-semibold tabular-nums">{f.int(total.worked)}</span>
        <span className="text-xs text-muted-foreground">
          {t('insights.lists.work.became', { n: f.int(total.count), pct: f.pct(conv, 1) })}
        </span>
      </div>
      <StackedBar
        className="h-2.5"
        label={t('insights.lists.work.title')}
        segments={PARTS.map((p) => ({
          key: p.key, weight: total[p.key], tone: p.tone,
          text: `${t(`insights.lists.work.${p.key}`)} · ${f.int(total[p.key])} (${f.share(total[p.key], total.worked)})`,
        }))}
      />
      <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        {PARTS.map((p) => (
          <li key={p.key} className="inline-flex items-center gap-1">
            <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full', p.tone)} aria-hidden />
            {t(`insights.lists.work.${p.key}`)} <b className="tabular-nums text-foreground">{f.int(total[p.key])}</b>
            <span className="tabular-nums">({f.share(total[p.key], total.worked)})</span>
          </li>
        ))}
      </ul>
      <p className="text-[11px] text-muted-foreground">
        {t('insights.lists.work.people', { customers: f.int(total.customers), people: f.int(total.people) })}
      </p>
      {total.no_answer > 0 && (
        <div className="flex items-start gap-1.5 border-t pt-2 text-[11px] text-muted-foreground">
          <PhoneMissed className="mt-px h-3 w-3 shrink-0" aria-hidden />
          <div>
            <p>{t('insights.lists.work.noAnswer', { n: f.int(total.no_answer), reach: f.pct(reach, 0) })}</p>
            <ClockCaption clock="call" className="mt-0.5" />
          </div>
        </div>
      )}
    </section>
  );
}
