import { useId, useState } from 'react';
import type { ListsAgent } from '@/lib/insightsApi/lists';
import { cn } from '@/lib/utils';
import { DrillLink } from '../overview/DrillLink';
import { fmtNum } from '../overview/model';
import { dm } from '../overview/useOverviewFormat';
import { ClockCaption } from '../shared/ClockCaption';
import { STATUS_TEXT } from '../shared/cohortPalette';
import { ordersSupportsCohortDrill } from '../shared/cohortModel';
import type { DayRange } from '../shared/period';
import type { InsightsFormat } from '../shared/useInsightsFormat';
import { conversionOf, listsHref, returnRateOf, salesPerHourOf } from './listModel';

const TOP = 12;

/**
 * Who sells from the lists: sales (the cohort, sale day) against the
 * decisions each seller made on list calls (decision day), the share that
 * ended in "no" / trash, returns — and sales per active hour where presence
 * covers the day (it starts on meta.presence_from). A name opens exactly the
 * seller's list sales in /orders. Counts for managers, денари for owners.
 */
export function ListsSellers({ agents, range, money, presenceFrom, f }: {
  agents: ListsAgent[];
  range: DayRange;
  money: boolean;
  presenceFrom: string | null;
  f: InsightsFormat;
}) {
  const { t } = f;
  const titleId = useId();
  const [all, setAll] = useState(false);
  if (!agents.length) return null;
  const shown = all ? agents : agents.slice(0, TOP);
  const hasPresence = agents.some((a) => (a.active_minutes ?? 0) > 0);
  const supported = ordersSupportsCohortDrill();

  return (
    <section aria-labelledby={titleId} className="space-y-3">
      <div>
        <h2 id={titleId} className="text-base font-semibold">{t('insights.lists.sellers.title')}</h2>
        <p className="text-xs text-muted-foreground">
          {hasPresence
            ? t('insights.lists.sellers.presenceNote', { date: presenceFrom ? dm(presenceFrom, true) : '—' })
            : t('insights.lists.sellers.noPresence', { date: presenceFrom ? dm(presenceFrom, true) : '—' })}
        </p>
        <ClockCaption clock={['sale', 'decided']} />
      </div>
      <div className="overflow-x-auto rounded-xl border bg-card shadow-sm">
        <table className={cn('w-full text-sm', money ? 'min-w-[720px]' : 'min-w-[600px]')}>
          <caption className="sr-only">{t('insights.lists.sellers.title')}</caption>
          <thead>
            <tr className="border-b text-[11px] uppercase tracking-wide text-muted-foreground">
              <th scope="col" className="sticky left-0 z-10 bg-card px-3 py-2 text-left font-medium">{t('insights.lists.sellers.col.name')}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">{t('insights.lists.sellers.col.sales')}</th>
              {money && <th scope="col" className="px-3 py-2 text-right font-medium">{t('insights.lists.sellers.col.value')}</th>}
              <th scope="col" className="px-3 py-2 text-right font-medium" title={t('insights.lists.table.hint.worked')}>{t('insights.lists.sellers.col.worked')}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium" title={t('insights.lists.table.hint.conv')}>{t('insights.lists.sellers.col.conv')}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium" title={t('insights.lists.sellers.hint.trash')}>{t('insights.lists.sellers.col.trash')}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium" title={t('insights.lists.table.hint.returnRate')}>{t('insights.lists.sellers.col.returnRate')}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">{t('insights.lists.sellers.col.lists')}</th>
              {hasPresence && <th scope="col" className="px-3 py-2 text-right font-medium" title={t('insights.lists.sellers.hint.perHour')}>{t('insights.lists.sellers.col.perHour')}</th>}
            </tr>
          </thead>
          <tbody>
            {shown.map((a) => {
              const conv = conversionOf(a.sales, a.worked);
              const trashShare = a.worked > 0 ? a.worked_trash / a.worked : null;
              const rr = returnRateOf(a.paid, a.returned);
              const perHour = salesPerHourOf(a.sales_on_presence_days, a.active_minutes);
              return (
                <tr key={a.person_id} className="border-b last:border-0 hover:bg-muted/20">
                  <th scope="row" className="sticky left-0 z-10 bg-card px-3 py-2 text-left font-medium">{a.name ?? '—'}</th>
                  <td className="px-3 py-2 text-right font-semibold tabular-nums">
                    <DrillLink href={supported && a.sales > 0 ? listsHref('total', range, { personId: a.person_id }) : null}>{f.int(a.sales)}</DrillLink>
                  </td>
                  {money && (
                    <td className="px-3 py-2 text-right tabular-nums">
                      {a.value_mkd != null ? f.den(a.value_mkd) : '—'}
                      {a.cash_mkd != null && a.cash_mkd > 0 && (
                        <span className="block text-[11px] text-muted-foreground">{t('insights.lists.sellers.cashLine', { value: f.den(a.cash_mkd) })}</span>
                      )}
                    </td>
                  )}
                  <td className="px-3 py-2 text-right tabular-nums">{f.int(a.worked)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{f.pct(conv, 1)}</td>
                  <td className={cn('px-3 py-2 text-right tabular-nums', trashShare != null && trashShare >= 0.5 && STATUS_TEXT.warning)}>
                    {f.pct(trashShare, 0)}
                    {a.worked_trash > 0 && <span className="block text-[11px] text-muted-foreground">{f.int(a.worked_trash)}</span>}
                  </td>
                  <td className={cn('px-3 py-2 text-right tabular-nums', rr != null && rr > 0 && STATUS_TEXT.returned)}>{f.pct(rr, 0)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{f.int(a.lists)}</td>
                  {hasPresence && (
                    <td className="px-3 py-2 text-right tabular-nums">
                      {perHour != null ? fmtNum(perHour, f.lang, 1) : '—'}
                      {a.active_minutes != null && a.active_minutes > 0 && (
                        <span className="block text-[11px] text-muted-foreground">{f.minutes(a.active_minutes)}</span>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {agents.length > TOP && (
        <button type="button" onClick={() => setAll((v) => !v)}
          className="text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {all ? t('insights.lists.sellers.showTop', { n: TOP }) : t('insights.lists.sellers.showAll', { n: f.int(agents.length) })}
        </button>
      )}
    </section>
  );
}
