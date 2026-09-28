import { useMemo, useState, type ReactNode } from 'react';
import { ArrowDown, Info, MapPin, Search } from 'lucide-react';
import type { SalesCityCounts, SalesDetail } from '@/lib/insightsApi/sales';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { ClockCaption } from '../shared/ClockCaption';
import { STATUS_TEXT } from '../shared/cohortPalette';
import type { InsightsFormat } from '../shared/useInsightsFormat';
import { cityName, cityViews, countsOutcome, matchesSearch, paidRate, ratio, returnRate, type CityView } from './salesModel';

type SortKey = 'count' | 'value' | 'avg' | 'paid' | 'returns';

/**
 * "Каде продадовме" — the period's sales by place. Latin, Cyrillic and MEX's
 * "Skopje - Aerodrom" zones fold into one place (mk_city_key); the courier's
 * address counts when the sale has a parcel. Top places, then the rest in one
 * row and the sales with no city at all — the rows add up to the header.
 */
export function SalesCities({ detail, money, f }: { detail: SalesDetail; money: boolean; f: InsightsFormat }) {
  const { t, lang } = f;
  const c = detail.cities;
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortKey>('count');
  const views = useMemo(() => cityViews(c?.rows, detail.total, money), [c, detail.total, money]);
  const shown = useMemo(() => {
    const list = views.filter((r) => matchesSearch(r.name, q) || matchesSearch(r.name_lat, q));
    const key = (r: CityView): number => {
      switch (sort) {
        case 'count': return r.count;
        case 'value': return r.value_mkd ?? 0;
        case 'avg': return r.avg ?? 0;
        case 'paid': return paidRate(r.outcome) ?? -1;
        case 'returns': return returnRate(r.outcome) ?? -1;
      }
    };
    return [...list].sort((a, b) => key(b) - key(a) || b.count - a.count);
  }, [views, q, sort]);
  const cols = money ? 7 : 5;

  const Th = ({ k, children }: { k?: SortKey; children: ReactNode }) => (
    <th scope="col" aria-sort={k && sort === k ? 'descending' : undefined} className="px-3 py-2 text-right font-medium">
      {k ? (
        <button type="button" onClick={() => setSort(k)}
          className={cn('inline-flex items-center gap-0.5 rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            sort === k && 'text-foreground')}>
          {children}{sort === k && <ArrowDown className="h-3 w-3" aria-hidden />}
        </button>
      ) : children}
    </th>
  );

  const Cells = ({ r, avgOf }: { r: SalesCityCounts; avgOf?: number | null }) => {
    const o = countsOutcome(r);
    return (
      <>
        <td className="px-3 py-2 text-right font-semibold tabular-nums">{f.int(r.count)}</td>
        {money && <td className="px-3 py-2 text-right tabular-nums">{r.value_mkd != null ? f.den(r.value_mkd) : '—'}</td>}
        {money && <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{avgOf != null ? f.den(Math.round(avgOf)) : '—'}</td>}
        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{f.share(r.count, detail.total.count)}</td>
        <td className={cn('px-3 py-2 text-right tabular-nums', STATUS_TEXT.good)}>{f.pct(paidRate(o), 0)}</td>
        <td className={cn('px-3 py-2 text-right tabular-nums', STATUS_TEXT.returned)}>{f.pct(returnRate(o), 0)}</td>
      </>
    );
  };

  return (
    <section aria-labelledby="sa-cities-title" className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <h2 id="sa-cities-title" className="text-base font-semibold">{t('insights.sales.cities.title')}</h2>
          <p className="text-xs text-muted-foreground">
            {t('insights.sales.cities.subtitle', { places: f.int(c?.places ?? 0), spellings: f.int(c?.spellings ?? 0) })}
          </p>
          <ClockCaption clock="sale" />
        </div>
        <label className="relative w-full sm:w-64">
          <span className="sr-only">{t('insights.sales.cities.search')}</span>
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('insights.sales.cities.search')} className="h-8 pl-8 text-xs" />
        </label>
      </div>

      <div className="max-h-[560px] overflow-auto rounded-xl border bg-card shadow-sm">
        <table className={cn('w-full text-sm', money ? 'min-w-[720px]' : 'min-w-[520px]')}>
          <caption className="sr-only">{t('insights.sales.cities.title')}</caption>
          <thead className="sticky top-0 z-10 bg-card">
            <tr className="border-b text-[11px] uppercase tracking-wide text-muted-foreground">
              <th scope="col" className="px-3 py-2 text-left font-medium">{t('insights.sales.cities.colCity')}</th>
              <Th k="count">{t('insights.sales.cities.colSales')}</Th>
              {money && <Th k="value">{t('insights.sales.cities.colValue')}</Th>}
              {money && <Th k="avg">{t('insights.sales.cities.colAvg')}</Th>}
              <Th>{t('insights.sales.cities.colShare')}</Th>
              <Th k="paid">{t('insights.sales.cities.colPaid')}</Th>
              <Th k="returns">{t('insights.sales.cities.colReturns')}</Th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 ? (
              <tr><td colSpan={cols} className="px-3 py-6 text-center text-muted-foreground">
                {q ? t('insights.sales.cities.noMatch') : t('insights.sales.empty')}
              </td></tr>
            ) : shown.map((r) => (
              <tr key={r.key} className="border-b last:border-0">
                <th scope="row" className="px-3 py-2 text-left font-medium">
                  <span className="inline-flex items-center gap-1.5">
                    <MapPin className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />{cityName(r, lang)}
                  </span>
                  {(r.spellings > 1 || !r.known) && (
                    <span className="block text-[11px] font-normal text-muted-foreground">
                      {!r.known ? t('insights.sales.cities.unknownPlace') : t('insights.sales.cities.spellings', { n: f.int(r.spellings), count: r.spellings })}
                    </span>
                  )}
                </th>
                <Cells r={r} avgOf={r.avg} />
              </tr>
            ))}
          </tbody>
          <tbody className="border-t-2 text-muted-foreground">
            {c && c.others.places > 0 && !q && (
              <tr className="border-b">
                <th scope="row" className="px-3 py-2 text-left font-medium">{t('insights.sales.cities.others', { n: f.int(c.others.places), count: c.others.places })}</th>
                <Cells r={c.others} avgOf={money && c.others.value_mkd != null ? ratio(c.others.value_mkd, c.others.count) : null} />
              </tr>
            )}
            {c && c.unknown.count > 0 && !q && (
              <tr className="border-b">
                <th scope="row" className="px-3 py-2 text-left font-medium">{t('insights.sales.cities.noCity')}</th>
                <Cells r={c.unknown} avgOf={money && c.unknown.value_mkd != null ? ratio(c.unknown.value_mkd, c.unknown.count) : null} />
              </tr>
            )}
          </tbody>
          <tfoot className="sticky bottom-0 bg-card">
            <tr className="border-t-2 bg-muted/30 font-semibold">
              <th scope="row" className="px-3 py-2 text-left">{t('insights.common.table.total')}</th>
              <td className="px-3 py-2 text-right tabular-nums">{f.int(detail.total.count)}</td>
              {money && <td className="px-3 py-2 text-right tabular-nums">{detail.total.value_mkd != null ? f.den(detail.total.value_mkd) : '—'}</td>}
              {money && <td className="px-3 py-2 text-right tabular-nums">
                {detail.total.value_mkd != null && detail.total.count > 0 ? f.den(Math.round(detail.total.value_mkd / detail.total.count)) : '—'}
              </td>}
              <td colSpan={3} />
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="flex items-start gap-1 text-[11px] leading-snug text-muted-foreground">
        <Info className="mt-px h-3 w-3 shrink-0" aria-hidden />{t('insights.sales.cities.note')}
      </p>
    </section>
  );
}
