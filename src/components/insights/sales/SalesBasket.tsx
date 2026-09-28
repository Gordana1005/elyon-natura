import { Info } from 'lucide-react';
import type { SalesBasketKey, SalesDetail } from '@/lib/insightsApi/sales';
import { cn } from '@/lib/utils';
import { fmtNum } from '../overview/model';
import { sourceColorVar } from '../overview/palette';
import { ClockCaption } from '../shared/ClockCaption';
import type { InsightsFormat } from '../shared/useInsightsFormat';
import { ratio } from './salesModel';
import { NEUTRAL_BAR } from './salesPalette';

/**
 * "Кошничка" — how many packages one sale carries (gifts, points and delivery
 * are not packages), and per source the average sale and packages per sale.
 * MEX parcels with no order carry no line, so they sit in their own row.
 */
export function SalesBasket({ detail, money, f }: { detail: SalesDetail; money: boolean; f: InsightsFormat }) {
  const { t } = f;
  const k = detail.basket;
  if (!k) return null;
  const dist = k.dist ?? [];
  const max = Math.max(1, ...dist.map((d) => d.count));
  const total = dist.reduce((a, d) => a + d.count, 0);
  const label = (key: SalesBasketKey) => t(`insights.sales.basket.dist.k${key}`);

  return (
    <section aria-labelledby="sa-basket-title" className="flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4 shadow-sm">
      <div>
        <h2 id="sa-basket-title" className="text-base font-semibold">{t('insights.sales.basket.title')}</h2>
        <p className="text-xs text-muted-foreground">{t('insights.sales.basket.subtitle')}</p>
        <ClockCaption clock="sale" className="mt-0.5" />
      </div>

      <ul className="space-y-1.5" aria-label={t('insights.sales.basket.distLabel')}>
        {dist.map((d) => (
          <li key={d.key} className="grid grid-cols-[7.5rem_1fr_auto] items-center gap-2 text-xs">
            <span className={cn('truncate', d.key === 'none' && 'text-muted-foreground')} title={label(d.key)}>{label(d.key)}</span>
            <span className="h-3 rounded-sm bg-muted" aria-hidden>
              <span className={cn('block h-full rounded-sm', d.key === 'none' ? 'bg-muted-foreground/40' : NEUTRAL_BAR)}
                style={{ width: `${(d.count / max) * 100}%` }} />
            </span>
            <span className="tabular-nums">
              <b className="font-semibold">{f.int(d.count)}</b>
              <span className="ml-1 text-muted-foreground">{f.share(d.count, total)}</span>
              {money && d.value_mkd != null && d.count > 0 && (
                <span className="ml-1 hidden text-muted-foreground sm:inline">· {t('insights.sales.buyers.avg', { value: f.den(Math.round(d.value_mkd / d.count)) })}</span>
              )}
            </span>
          </li>
        ))}
      </ul>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[340px] text-xs">
          <thead>
            <tr className="border-b text-[11px] uppercase tracking-wide text-muted-foreground">
              <th scope="col" className="py-1.5 pr-2 text-left font-medium">{t('insights.common.table.source')}</th>
              <th scope="col" className="px-2 py-1.5 text-right font-medium">{t('insights.common.table.sales')}</th>
              <th scope="col" className="px-2 py-1.5 text-right font-medium">{t('insights.sales.basket.perSale')}</th>
              {money && <th scope="col" className="py-1.5 pl-2 text-right font-medium">{t('insights.sales.basket.avg')}</th>}
            </tr>
          </thead>
          <tbody>
            {(k.by_source ?? []).filter((s) => s.count > 0).map((s) => {
              const per = ratio(s.units, s.with_units);
              const avg = money && s.value_mkd != null ? ratio(s.value_mkd, s.count) : null;
              return (
                <tr key={s.key} className="border-b last:border-0">
                  <th scope="row" className="py-1.5 pr-2 text-left font-medium">
                    <span className="inline-flex items-center gap-1.5">
                      <span className="h-[3px] w-3 shrink-0 rounded-full" style={{ background: sourceColorVar(s.key) }} aria-hidden />{f.sourceLabel(s.key)}
                    </span>
                  </th>
                  <td className="px-2 py-1.5 text-right tabular-nums">{f.int(s.count)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {per != null ? fmtNum(per, f.lang, 1) : '—'}
                    {s.with_units < s.count && per != null && (
                      <span className="ml-1 text-[11px] text-muted-foreground">({t('insights.sales.basket.ofN', { n: f.int(s.with_units) })})</span>
                    )}
                  </td>
                  {money && <td className="py-1.5 pl-2 text-right tabular-nums">{avg != null ? f.den(Math.round(avg)) : '—'}</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="flex items-start gap-1 text-[11px] leading-snug text-muted-foreground">
        <Info className="mt-px h-3 w-3 shrink-0" aria-hidden />{t('insights.sales.basket.note')}
      </p>
    </section>
  );
}
