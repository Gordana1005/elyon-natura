import { Info, Truck } from 'lucide-react';
import type { SalesCore } from '@/lib/insightsApi/sales';
import { cn } from '@/lib/utils';
import { ClockCaption } from '../shared/ClockCaption';
import { STATUS_TEXT } from '../shared/cohortPalette';
import type { InsightsFormat } from '../shared/useInsightsFormat';
import { SourceMix } from './SalesProducts';
import { channelViews, paidRate, returnRate, seriesKey } from './salesModel';

/**
 * "По MEX сметка и серија" — the channel a parcel names: BIO NATURAL (9110
 * LEADS, 9103 LEADS-OUT) and NATURA (9102 Телешоп – Lead out, 9100 Телешоп –
 * Lead in, 9108 social, NTMK web, bare M… waybills), and the sales with no
 * parcel yet. It replaces "by delivery method" (every MK order is home
 * delivery). The mix shows which departments ship through each series — a
 * department is mostly its order's own, except that a CRM sale shipped on a
 * NATURA 9102 / 9100 / 9108 parcel counts in Телешоп / Social media (owner
 * 28.09). Rows add up to the header.
 */
export function SalesChannels({ core, money, f }: { core: SalesCore; money: boolean; f: InsightsFormat }) {
  const { t } = f;
  const rows = channelViews(core.channels, core.total.count);
  const account = (a: string | null) => (a ? t(`insights.sales.channels.account.${a}`, { defaultValue: a }) : '—');
  const series = (s: string) => t(`insights.sales.channels.series.${seriesKey(s)}`, { defaultValue: s });

  return (
    <section aria-labelledby="sa-channels-title" className="space-y-3">
      <div>
        <h2 id="sa-channels-title" className="text-base font-semibold">{t('insights.sales.channels.title')}</h2>
        <p className="text-xs text-muted-foreground">{t('insights.sales.channels.subtitle')}</p>
        <ClockCaption clock="sale" className="mt-0.5" />
      </div>
      <div className="overflow-x-auto rounded-xl border bg-card shadow-sm">
        <table className={cn('w-full text-sm', money ? 'min-w-[820px]' : 'min-w-[620px]')}>
          <caption className="sr-only">{t('insights.sales.channels.title')}</caption>
          <thead>
            <tr className="border-b text-[11px] uppercase tracking-wide text-muted-foreground">
              <th scope="col" className="px-3 py-2 text-left font-medium">{t('insights.sales.channels.colSeries')}</th>
              <th scope="col" className="px-3 py-2 text-left font-medium">{t('insights.sales.channels.colAccount')}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">{t('insights.common.table.sales')}</th>
              {money && <th scope="col" className="px-3 py-2 text-right font-medium">{t('insights.common.table.value')}</th>}
              {money && <th scope="col" className="px-3 py-2 text-right font-medium">{t('insights.sales.channels.colCod')}</th>}
              <th scope="col" className="px-3 py-2 text-right font-medium">{t('insights.sales.products.colPaid')}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">{t('insights.sales.products.colReturns')}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">{t('insights.sales.sources.inFlight')}</th>
              <th scope="col" className="w-28 px-3 py-2 text-left font-medium">{t('insights.sales.products.colSources')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={money ? 9 : 7} className="px-3 py-6 text-center text-muted-foreground">{t('insights.sales.empty')}</td></tr>
            ) : rows.map((r) => (
              <tr key={`${r.account ?? '-'}:${r.series}`} className={cn('border-b last:border-0', r.series === 'none' && 'bg-muted/30')}>
                <th scope="row" className="px-3 py-2 text-left font-medium">
                  <span className="inline-flex items-center gap-1.5">
                    {r.series !== 'none' && <Truck className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />}
                    {series(r.series)}
                  </span>
                </th>
                <td className="px-3 py-2 text-left text-muted-foreground">{account(r.account)}</td>
                <td className="px-3 py-2 text-right font-semibold tabular-nums">
                  {f.int(r.count)} <span className="text-[11px] font-normal text-muted-foreground">{r.share != null ? f.pct(r.share, 1) : ''}</span>
                </td>
                {money && <td className="px-3 py-2 text-right tabular-nums">{r.value_mkd != null ? f.den(r.value_mkd) : '—'}</td>}
                {money && <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{r.cod_mkd != null && r.series !== 'none' ? f.den(r.cod_mkd) : '—'}</td>}
                <td className={cn('px-3 py-2 text-right tabular-nums', STATUS_TEXT.good)}>{f.pct(paidRate(r.outcome), 0)}</td>
                <td className={cn('px-3 py-2 text-right tabular-nums', STATUS_TEXT.returned)}>{f.pct(returnRate(r.outcome), 0)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{f.int(r.outcome.inFlight)}</td>
                <td className="px-3 py-2.5"><SourceMix parts={r.by_source.map((s) => ({ key: s.key, n: s.count }))} f={f} /></td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 bg-muted/30 font-semibold">
              <th scope="row" colSpan={2} className="px-3 py-2 text-left">{t('insights.common.table.total')}</th>
              <td className="px-3 py-2 text-right tabular-nums">{f.int(core.total.count)}</td>
              {money && <td className="px-3 py-2 text-right tabular-nums">{core.total.value_mkd != null ? f.den(core.total.value_mkd) : '—'}</td>}
              {money && <td className="px-3 py-2 text-right tabular-nums">{core.total.cod_mkd != null ? f.den(core.total.cod_mkd) : '—'}</td>}
              <td colSpan={4} />
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="flex items-start gap-1 text-[11px] leading-snug text-muted-foreground">
        <Info className="mt-px h-3 w-3 shrink-0" aria-hidden />{t('insights.sales.channels.note')}
      </p>
    </section>
  );
}
