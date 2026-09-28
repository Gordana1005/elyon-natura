import { Info, Repeat, UserPlus, Users } from 'lucide-react';
import type { SalesDetail } from '@/lib/insightsApi/sales';
import { cn } from '@/lib/utils';
import { fmtNum } from '../overview/model';
import { sourceColorVar } from '../overview/palette';
import { ClockCaption } from '../shared/ClockCaption';
import { formatDmy } from '../shared/period';
import type { InsightsFormat } from '../shared/useInsightsFormat';
import { buyersView } from './salesModel';
import { BUYER_NEW, BUYER_RETURNING } from './salesPalette';

/**
 * "Кому продадовме" — buyers are last-8 phones. New = never bought before the
 * period (as far back as the history reaches); returning = bought before;
 * repeat = two or more sales inside the period. Per source a buyer counts in
 * every source they bought from.
 */
export function SalesBuyers({ detail, money, f }: { detail: SalesDetail; money: boolean; f: InsightsFormat }) {
  const { t } = f;
  const b = buyersView(detail.customers, money);
  if (!b) return null;
  const newPct = b.buyers > 0 ? (b.new / b.buyers) * 100 : 0;

  return (
    <section aria-labelledby="sa-buyers-title" className="flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4 shadow-sm">
      <div>
        <h2 id="sa-buyers-title" className="text-base font-semibold">{t('insights.sales.buyers.title')}</h2>
        <p className="text-xs text-muted-foreground">{t('insights.sales.buyers.subtitle')}</p>
        <ClockCaption clock="sale" className="mt-0.5" />
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile icon={Users} label={t('insights.sales.buyers.buyers')} value={f.int(b.buyers)} />
        <Tile icon={UserPlus} label={t('insights.sales.buyers.new')} value={f.int(b.new)} sub={f.share(b.new, b.buyers)} />
        <Tile icon={Repeat} label={t('insights.sales.buyers.returning')} value={f.int(b.returning)} sub={f.share(b.returning, b.buyers)} />
        <Tile icon={Repeat} label={t('insights.sales.buyers.perBuyer')} value={b.salesPerBuyer != null ? fmtNum(b.salesPerBuyer, f.lang, 2) : '—'}
          sub={t('insights.sales.buyers.repeatN', { n: f.int(b.repeat) })} />
      </div>

      {/* new vs returning as one bar: the part-to-whole at a glance */}
      <div className="space-y-1">
        <div className="flex h-2.5 gap-[2px] overflow-hidden rounded-full" role="img"
          aria-label={`${t('insights.sales.buyers.new')} ${f.int(b.new)} · ${t('insights.sales.buyers.returning')} ${f.int(b.returning)}`}>
          {b.new > 0 && <span className={`h-full ${BUYER_NEW}`} style={{ flexGrow: newPct, flexBasis: 0 }} />}
          {b.returning > 0 && <span className={`h-full ${BUYER_RETURNING}`} style={{ flexGrow: 100 - newPct, flexBasis: 0 }} />}
        </div>
        <div className="flex justify-between text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1"><span className={`h-2 w-2 rounded-full ${BUYER_NEW}`} aria-hidden />{t('insights.sales.buyers.new')}</span>
          <span className="inline-flex items-center gap-1">{t('insights.sales.buyers.returning')}<span className={`h-2 w-2 rounded-full ${BUYER_RETURNING}`} aria-hidden /></span>
        </div>
      </div>

      {money && (b.avgNew != null || b.avgReturning != null) && (
        <dl className="grid grid-cols-2 gap-3 text-xs">
          <div><dt className="text-muted-foreground">{t('insights.sales.buyers.valueNew')}</dt>
            <dd className="font-semibold tabular-nums">{b.value_new_mkd != null ? f.den(b.value_new_mkd) : '—'}
              {b.avgNew != null && <span className="ml-1 font-normal text-muted-foreground">· {t('insights.sales.buyers.avg', { value: f.den(Math.round(b.avgNew)) })}</span>}</dd></div>
          <div><dt className="text-muted-foreground">{t('insights.sales.buyers.valueReturning')}</dt>
            <dd className="font-semibold tabular-nums">{b.value_returning_mkd != null ? f.den(b.value_returning_mkd) : '—'}
              {b.avgReturning != null && <span className="ml-1 font-normal text-muted-foreground">· {t('insights.sales.buyers.avg', { value: f.den(Math.round(b.avgReturning)) })}</span>}</dd></div>
        </dl>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[360px] text-xs">
          <thead>
            <tr className="border-b text-[11px] uppercase tracking-wide text-muted-foreground">
              <th scope="col" className="py-1.5 pr-2 text-left font-medium">{t('insights.common.table.source')}</th>
              <th scope="col" className="px-2 py-1.5 text-right font-medium">{t('insights.sales.buyers.buyers')}</th>
              <th scope="col" className="px-2 py-1.5 text-right font-medium">{t('insights.sales.buyers.new')}</th>
              <th scope="col" className="px-2 py-1.5 text-right font-medium">{t('insights.sales.buyers.returning')}</th>
              <th scope="col" className="py-1.5 pl-2 text-right font-medium">{t('insights.sales.buyers.repeat')}</th>
            </tr>
          </thead>
          <tbody>
            {b.by_source.map((s) => (
              <tr key={s.key} className="border-b last:border-0">
                <th scope="row" className="py-1.5 pr-2 text-left font-medium">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-[3px] w-3 shrink-0 rounded-full" style={{ background: sourceColorVar(s.key) }} aria-hidden />{f.sourceLabel(s.key)}
                  </span>
                </th>
                <td className="px-2 py-1.5 text-right tabular-nums">{f.int(s.buyers)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{f.int(s.new)} <span className="text-muted-foreground">({f.share(s.new, s.buyers)})</span></td>
                <td className="px-2 py-1.5 text-right tabular-nums">{f.int(s.returning)}</td>
                <td className="py-1.5 pl-2 text-right tabular-nums">{f.int(s.repeat)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="space-y-1 text-[11px] leading-snug text-muted-foreground">
        <li className="flex items-start gap-1"><Info className="mt-px h-3 w-3 shrink-0" aria-hidden />
          {t('insights.sales.buyers.history', { date: formatDmy(b.history_from) || '—' })}</li>
        {b.cross_source > 0 && (
          <li className="flex items-start gap-1"><Info className="mt-px h-3 w-3 shrink-0" aria-hidden />
            {t('insights.sales.buyers.crossSource', { n: f.int(b.cross_source), count: b.cross_source })}</li>
        )}
        {b.no_phone > 0 && (
          <li className="flex items-start gap-1"><Info className="mt-px h-3 w-3 shrink-0" aria-hidden />
            {t('insights.sales.buyers.noPhone', { n: f.int(b.no_phone), count: b.no_phone })}</li>
        )}
      </ul>
    </section>
  );
}

function Tile({ icon: Icon, label, value, sub }: { icon: typeof Users; label: string; value: string; sub?: string }) {
  return (
    <div className={cn('min-w-0 rounded-lg border px-2.5 py-2')}>
      <span className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        <Icon className="h-3 w-3 shrink-0" aria-hidden /><span className="truncate" title={label}>{label}</span>
      </span>
      <span className="block text-lg font-semibold text-card-foreground">{value}</span>
      {sub && <span className="block text-[11px] tabular-nums text-muted-foreground">{sub}</span>}
    </div>
  );
}
