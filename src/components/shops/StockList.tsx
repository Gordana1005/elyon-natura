import { useState } from 'react';
import { Package } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/EmptyState';
import type { ShopStockRow } from '@/lib/shopsTypes';
import { cn } from '@/lib/utils';
import { hasKey, numOrNull } from './shopsModel';
import { TopSellerZero } from './parts';
import type { ShopsFormat } from './useShopsFormat';

/** Rows shown before "show more" (a shop holds a few hundred articles). */
export const STOCK_PAGE = 60;

/**
 * One shop's stock, already filtered: qty, available (reserved in the hint), sold in 30 days,
 * days of cover, the "top seller at zero" badge and — for owners — the value at cost and retail.
 * A table on lg+, cards below.
 */
export function StockList({ rows, f }: { rows: ShopStockRow[]; f: ShopsFormat }) {
  const { t } = f;
  const [limit, setLimit] = useState(STOCK_PAGE);
  const money = rows.some((r) => hasKey(r, 'value_cost_mkd') || hasKey(r, 'value_retail_mkd'));
  const shown = rows.slice(0, limit);
  const den = (v: number | null | undefined) => (numOrNull(v) == null ? '—' : f.den(v));
  const cover = (r: ShopStockRow) => (r.days_cover == null ? '—' : t('shops.detail.coverDays', { n: f.int(r.days_cover) }));
  const zero = (r: ShopStockRow) => r.qty <= 0;

  if (rows.length === 0) return <EmptyState icon={<Package className="h-5 w-5" />} title={t('shops.detail.stockEmpty')} size="sm" />;

  return (
    <div className="space-y-2">
      <div className="hidden overflow-x-auto rounded-xl border bg-card shadow-sm lg:block">
        <table className="w-full text-sm">
          <caption className="sr-only">{t('shops.detail.stockTitle')}</caption>
          <thead>
            <tr className="border-b bg-muted/50 text-[11px] uppercase tracking-wide text-muted-foreground">
              <th scope="col" className="px-3 py-2 text-left font-medium">{t('shops.detail.colArticle')}</th>
              <th scope="col" className="px-2 py-2 text-right font-medium">{t('shops.detail.colQty')}</th>
              <th scope="col" className="px-2 py-2 text-right font-medium">{t('shops.detail.colAvailable')}</th>
              <th scope="col" className="px-2 py-2 text-right font-medium">{t('shops.detail.colSold30')}</th>
              <th scope="col" className="px-2 py-2 text-right font-medium" title={t('shops.detail.coverHint')}>{t('shops.detail.colCover')}</th>
              {money && <th scope="col" className="px-2 py-2 text-right font-medium">{t('shops.detail.colValueCost')}</th>}
              {money && <th scope="col" className="px-3 py-2 text-right font-medium">{t('shops.detail.colValueRetail')}</th>}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.code} className={cn('border-b last:border-0', r.zero_top_seller && 'bg-red-50/60 dark:bg-red-950/20')}>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-medium">{r.name}</span>
                    {r.zero_top_seller && <TopSellerZero f={f} />}
                  </div>
                  <div className="text-xs text-muted-foreground"><span className="font-mono">{r.code}</span>{r.brand ? ` · ${r.brand}` : ''}</div>
                </td>
                <td className={cn('whitespace-nowrap px-2 py-2 text-right font-semibold tabular-nums', zero(r) && 'text-red-700 dark:text-red-400')}>{f.int(r.qty)}</td>
                <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums" title={r.reserved ? t('shops.detail.reservedN', { n: f.int(r.reserved) }) : undefined}>
                  {f.int(r.available)}{r.reserved > 0 && <span className="ml-1 text-[11px] text-muted-foreground">({f.int(r.reserved)})</span>}
                </td>
                <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">{f.int(r.sold_30d)}</td>
                <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums text-muted-foreground">{cover(r)}</td>
                {money && <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">{den(r.value_cost_mkd)}</td>}
                {money && <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{den(r.value_retail_mkd)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="grid gap-2 md:grid-cols-2 lg:hidden">
        {shown.map((r) => (
          <li key={r.code} className={cn('min-w-0 rounded-xl border bg-card p-3 shadow-sm', r.zero_top_seller && 'border-red-300 dark:border-red-900')}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="break-words font-medium">{r.name}</div>
                <div className="text-xs text-muted-foreground"><span className="font-mono">{r.code}</span>{r.brand ? ` · ${r.brand}` : ''}</div>
              </div>
              <span className={cn('shrink-0 text-lg font-semibold tabular-nums', zero(r) && 'text-red-700 dark:text-red-400')}>{f.int(r.qty)}</span>
            </div>
            {r.zero_top_seller && <TopSellerZero f={f} className="mt-1.5" />}
            <dl className="mt-2 grid grid-cols-3 gap-x-3 gap-y-2 text-xs">
              <div className="min-w-0"><dt className="leading-tight text-muted-foreground">{t('shops.detail.colAvailable')}</dt><dd className="font-medium tabular-nums">{f.int(r.available)}</dd></div>
              <div className="min-w-0"><dt className="leading-tight text-muted-foreground">{t('shops.detail.colSold30')}</dt><dd className="font-medium tabular-nums">{f.int(r.sold_30d)}</dd></div>
              <div className="min-w-0"><dt className="leading-tight text-muted-foreground">{t('shops.detail.colCover')}</dt><dd className="font-medium tabular-nums">{cover(r)}</dd></div>
              {money && <div className="col-span-3 flex flex-wrap justify-between gap-x-3 sm:col-span-3">
                <span><span className="text-muted-foreground">{t('shops.detail.colValueCost')}: </span><span className="font-medium tabular-nums">{den(r.value_cost_mkd)}</span></span>
                <span><span className="text-muted-foreground">{t('shops.detail.colValueRetail')}: </span><span className="font-medium tabular-nums">{den(r.value_retail_mkd)}</span></span>
              </div>}
            </dl>
          </li>
        ))}
      </ul>

      {rows.length > limit && (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" onClick={() => setLimit((n) => n + STOCK_PAGE)}>
            {t('shops.more', { n: f.int(Math.min(STOCK_PAGE, rows.length - limit)) })}
          </Button>
        </div>
      )}
    </div>
  );
}
