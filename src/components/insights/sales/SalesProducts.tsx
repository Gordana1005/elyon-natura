import { useMemo, useState, type ReactNode } from 'react';
import { ArrowDown, Gift, Info, PackageX, Search } from 'lucide-react';
import type { SalesDetail } from '@/lib/insightsApi/sales';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { sourceColorVar } from '../overview/palette';
import { ClockCaption } from '../shared/ClockCaption';
import { STATUS_TEXT } from '../shared/cohortPalette';
import { COHORT_SOURCES } from '../shared/cohortTypes';
import type { InsightsFormat } from '../shared/useInsightsFormat';
import { matchesSearch, paidRate, productViews, returnRate, type ProductView } from './salesModel';

type SortKey = 'value' | 'units' | 'sales' | 'paid' | 'returns';

/**
 * "Што продадовме" — every product line of the period's sales, folded by
 * product (a catalogue product, or a name no reviewed alias maps yet — tagged).
 * A sale's value is spread over its lines by the line's money, so the column
 * adds up: products + other lines (gifts, points, delivery — never packages)
 * + sales with no line (MEX parcels with no order) = the header, to the denar.
 * Rows are folded names, not an /orders filter — so they carry no link.
 */
export function SalesProducts({ detail, money, f }: { detail: SalesDetail; money: boolean; f: InsightsFormat }) {
  const { t } = f;
  const p = detail.products;
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortKey>(money ? 'value' : 'units');
  const views = useMemo(() => productViews(p?.rows, { units: p?.summary?.units ?? 0, value_mkd: p?.summary?.value_mkd }, money), [p, money]);
  const shown = useMemo(() => {
    const list = views.filter((r) => matchesSearch(r.name, q));
    const key = (r: ProductView): number => {
      switch (sort) {
        case 'value': return r.value_mkd ?? 0;
        case 'units': return r.units;
        case 'sales': return r.sales;
        case 'paid': return paidRate(r.outcome) ?? -1;
        case 'returns': return returnRate(r.outcome) ?? -1;
      }
    };
    return [...list].sort((a, b) => key(b) - key(a) || b.sales - a.sales);
  }, [views, q, sort]);
  const others = p?.others;
  const nonProduct = (p?.non_product ?? []).filter((x) => x.lines > 0);
  const noProduct = p?.no_product;
  const total = detail.total;
  const autoLines = nonProduct.reduce((a, x) => a + x.auto, 0);
  const cols = money ? 10 : 8;

  const Th = ({ k, children, className }: { k?: SortKey; children: ReactNode; className?: string }) => (
    <th scope="col" aria-sort={k && sort === k ? 'descending' : undefined} className={cn('px-3 py-2 text-right font-medium', className)}>
      {k ? (
        <button type="button" onClick={() => setSort(k)}
          className={cn('inline-flex items-center gap-0.5 rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            sort === k && 'text-foreground')}>
          {children}{sort === k && <ArrowDown className="h-3 w-3" aria-hidden />}
        </button>
      ) : children}
    </th>
  );

  return (
    <section aria-labelledby="sa-products-title" className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <h2 id="sa-products-title" className="text-base font-semibold">{t('insights.sales.products.title')}</h2>
          <p className="text-xs text-muted-foreground">
            {t('insights.sales.products.subtitle', {
              products: f.int(p?.summary?.products ?? 0), units: f.int(p?.summary?.units ?? 0), sales: f.int(p?.summary?.sales ?? 0),
            })}
          </p>
          <ClockCaption clock="sale" />
        </div>
        <label className="relative w-full sm:w-64">
          <span className="sr-only">{t('insights.sales.products.search')}</span>
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('insights.sales.products.search')} className="h-8 pl-8 text-xs" />
        </label>
      </div>

      <div className="overflow-x-auto rounded-xl border bg-card shadow-sm">
        <table className={cn('w-full text-sm', money ? 'min-w-[900px]' : 'min-w-[720px]')}>
          <caption className="sr-only">{t('insights.sales.products.title')}</caption>
          <thead>
            <tr className="border-b text-[11px] uppercase tracking-wide text-muted-foreground">
              <th scope="col" className="px-3 py-2 text-left font-medium">{t('insights.sales.products.colProduct')}</th>
              <Th k="sales">{t('insights.sales.products.colSales')}</Th>
              <Th k="units">{t('insights.sales.products.colUnits')}</Th>
              {money && <Th k="value">{t('insights.sales.products.colValue')}</Th>}
              <Th>{t('insights.sales.products.colShare')}</Th>
              {money && <Th>{t('insights.sales.products.colPerUnit')}</Th>}
              <Th k="paid">{t('insights.sales.products.colPaid')}</Th>
              <Th k="returns">{t('insights.sales.products.colReturns')}</Th>
              <th scope="col" className="w-28 px-3 py-2 text-left font-medium">{t('insights.sales.products.colSources')}</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 ? (
              <tr><td colSpan={cols} className="px-3 py-6 text-center text-muted-foreground">
                {q ? t('insights.sales.products.noMatch') : t('insights.sales.empty')}
              </td></tr>
            ) : shown.map((r) => (
              <tr key={r.key} className="border-b align-top last:border-0">
                <th scope="row" className="max-w-[18rem] px-3 py-2 text-left font-medium">
                  <span className="line-clamp-2 break-words" title={r.name ?? undefined}>{r.name ?? t('insights.common.sentinel.unknown')}</span>
                  {!r.catalogue && (
                    <span className="mt-0.5 inline-block rounded-full border border-dashed px-1.5 text-[10px] font-normal text-muted-foreground"
                      title={t('insights.sales.products.unmappedHint')}>
                      {t('insights.sales.products.unmappedTag')}
                    </span>
                  )}
                </th>
                <td className="px-3 py-2 text-right tabular-nums" title={t('insights.sales.noLinkFolded')}>{f.int(r.sales)}</td>
                <td className="px-3 py-2 text-right font-semibold tabular-nums">{f.int(r.units)}</td>
                {money && <td className="px-3 py-2 text-right tabular-nums">{r.value_mkd != null ? f.den(r.value_mkd) : '—'}</td>}
                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{r.share != null ? f.pct(r.share, 1) : '—'}</td>
                {money && <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{r.perUnit != null ? f.den(Math.round(r.perUnit)) : '—'}</td>}
                <td className={cn('px-3 py-2 text-right tabular-nums', STATUS_TEXT.good)}>{f.pct(paidRate(r.outcome), 0)}</td>
                <td className={cn('px-3 py-2 text-right tabular-nums', STATUS_TEXT.returned)}>{f.pct(returnRate(r.outcome), 0)}</td>
                <td className="px-3 py-2.5"><SourceMix parts={r.by_source.map((s) => ({ key: s.key, n: s.units }))} f={f} /></td>
              </tr>
            ))}
          </tbody>
          <tbody className="border-t-2 text-muted-foreground">
            {others && others.products > 0 && !q && (
              <tr className="border-b">
                <th scope="row" className="px-3 py-2 text-left font-medium">{t('insights.sales.products.others', { n: f.int(others.products), count: others.products })}</th>
                <td className="px-3 py-2 text-right tabular-nums">{f.int(others.sales)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{f.int(others.units)}</td>
                {money && <td className="px-3 py-2 text-right tabular-nums">{others.value_mkd != null ? f.den(others.value_mkd) : '—'}</td>}
                <td colSpan={money ? 5 : 4} />
              </tr>
            )}
            {nonProduct.map((x) => (
              <tr key={x.kind} className="border-b">
                <th scope="row" className="px-3 py-2 text-left font-normal">
                  <span className="inline-flex items-center gap-1.5">
                    <Gift className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    {t(`insights.sales.products.kind.${x.kind}`, { defaultValue: x.kind })}
                  </span>
                  <span className="block text-[11px]">{t('insights.sales.products.notPackages', { n: f.int(x.lines), count: x.lines })}</span>
                </th>
                <td className="px-3 py-2 text-right tabular-nums">{f.int(x.sales)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{f.int(x.units)}</td>
                {money && <td className="px-3 py-2 text-right tabular-nums">{x.value_mkd != null ? f.den(x.value_mkd) : '—'}</td>}
                <td colSpan={money ? 5 : 4} />
              </tr>
            ))}
            {noProduct && noProduct.sales > 0 && (
              <tr className="border-b">
                <th scope="row" className="px-3 py-2 text-left font-normal">
                  <span className="inline-flex items-center gap-1.5"><PackageX className="h-3.5 w-3.5 shrink-0" aria-hidden />{t('insights.sales.products.noProduct')}</span>
                  <span className="block text-[11px]">{t('insights.sales.products.noProductHint', { n: f.int(noProduct.mex_only), count: noProduct.mex_only })}</span>
                </th>
                <td className="px-3 py-2 text-right tabular-nums">{f.int(noProduct.sales)}</td>
                <td className="px-3 py-2 text-right tabular-nums">—</td>
                {money && <td className="px-3 py-2 text-right tabular-nums">{noProduct.value_mkd != null ? f.den(noProduct.value_mkd) : '—'}</td>}
                <td colSpan={money ? 5 : 4} />
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr className="bg-muted/30 font-semibold">
              <th scope="row" className="px-3 py-2 text-left">{t('insights.common.table.total')}</th>
              <td className="px-3 py-2 text-right tabular-nums">{f.int(total.count)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{f.int(p?.summary?.units ?? 0)}</td>
              {money && <td className="px-3 py-2 text-right tabular-nums">{total.value_mkd != null ? f.den(total.value_mkd) : '—'}</td>}
              <td colSpan={money ? 5 : 4} className="px-3 py-2 text-left text-[11px] font-normal text-muted-foreground">
                {t('insights.sales.products.footer')}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <ul className="space-y-1 text-[11px] leading-snug text-muted-foreground">
        {autoLines > 0 && (
          <li className="flex items-start gap-1"><Info className="mt-px h-3 w-3 shrink-0" aria-hidden />
            {t('insights.sales.products.autoNote', { n: f.int(autoLines), count: autoLines })}</li>
        )}
        {(p?.summary?.unmapped_products ?? 0) > 0 && (
          <li className="flex items-start gap-1"><Info className="mt-px h-3 w-3 shrink-0" aria-hidden />
            {t('insights.sales.products.unmappedNote', { n: f.int(p!.summary.unmapped_products), count: p!.summary.unmapped_products })}</li>
        )}
        {(p?.summary?.bad_qty_lines ?? 0) > 0 && (
          <li className="flex items-start gap-1"><Info className="mt-px h-3 w-3 shrink-0" aria-hidden />
            {t('insights.sales.products.badQtyNote', { n: f.int(p!.summary.bad_qty_lines), count: p!.summary.bad_qty_lines })}</li>
        )}
        <li className="flex items-start gap-1"><Info className="mt-px h-3 w-3 shrink-0" aria-hidden />{t('insights.sales.noLinkFolded')}</li>
      </ul>
    </section>
  );
}

/** A tiny 100 % bar of which sources sold this — the source hues, the numbers in its label. */
export function SourceMix({ parts, f }: { parts: { key: string; n: number }[]; f: InsightsFormat }) {
  const ordered = COHORT_SOURCES.map((k) => ({ key: k, n: parts.find((p) => p.key === k)?.n ?? 0 })).filter((p) => p.n > 0);
  const sum = ordered.reduce((a, p) => a + p.n, 0);
  if (!sum) return <span className="text-muted-foreground">—</span>;
  const text = ordered.map((p) => `${f.sourceLabel(p.key)} ${f.int(p.n)}`).join(' · ');
  return (
    <div role="img" aria-label={text} title={text} className="flex h-2 w-24 gap-[2px] overflow-hidden rounded-full">
      {ordered.map((p) => <span key={p.key} className="h-full" style={{ flexGrow: p.n, flexBasis: 0, background: sourceColorVar(p.key) }} />)}
    </div>
  );
}
