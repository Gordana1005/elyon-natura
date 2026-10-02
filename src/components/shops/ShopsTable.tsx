import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDown, ArrowUp, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ShopDayRow } from '@/lib/shopsTypes';
import { SORT_LABEL, hasKey, numOrNull, sortValue, type ShopSortKey } from './shopsModel';
import { ControlBadge, VsAvgBadge } from './parts';
import type { ShopsFormat } from './useShopsFormat';

type Col = 'sales_mkd' | 'receipts' | 'units' | 'avg_receipt_mkd' | 'shop_margin_mkd' | 'group_margin_mkd' | 'returns_units' | 'vs_avg_pct' | 'last' | 'control';

/**
 * The shops as a table on xl+ and as cards below (never sideways): Денес / Период lists them by
 * sales or units with last receipt + control; Продавници ranks them with sortable headers, a
 * rank and a bar for the ranked metric. A money column only when its key arrived. Every shop
 * opens its detail (?tab=shop&shop=003).
 */
export function ShopsTable({
  rows, variant, mode, sortKey, dir, onSort, hrefFor, f,
}: {
  rows: ShopDayRow[];
  variant: 'day' | 'ranking';
  /** One day (times only) or a period (day + time). */
  mode: 'day' | 'period';
  sortKey: ShopSortKey;
  dir: 'asc' | 'desc';
  /** Ranking: headers sort. */
  onSort?: (k: ShopSortKey) => void;
  hrefFor: (code: string) => string;
  f: ShopsFormat;
}) {
  const { t } = f;
  const present = (k: string) => rows.some((r) => hasKey(r, k));
  const ranking = variant === 'ranking';
  const cols: Col[] = [
    ...(present('sales_mkd') ? (['sales_mkd'] as Col[]) : []),
    'receipts', 'units',
    ...(present('avg_receipt_mkd') ? (['avg_receipt_mkd'] as Col[]) : []),
    ...(present('shop_margin_mkd') ? (['shop_margin_mkd'] as Col[]) : []),
    ...(ranking && present('group_margin_mkd') ? (['group_margin_mkd'] as Col[]) : []),
    ...(ranking ? (['returns_units'] as Col[]) : []),
    'vs_avg_pct',
    ...(ranking ? [] : (['last', 'control'] as Col[])),
  ];
  const max = Math.max(0, ...rows.map((r) => sortValue(r, sortKey) ?? 0));
  const vsHint = t(mode === 'day' ? 'shops.list.vsAvgHintDay' : 'shops.list.vsAvgHintPeriod');

  const label = (c: Col) =>
    c === 'last' ? t('shops.list.colLast') : c === 'control' ? t('shops.list.colControl') : t(`shops.metric.${SORT_LABEL[c]}`);
  const money = (v: number | null | undefined, k: string, r: ShopDayRow) =>
    !hasKey(r, k) ? null : numOrNull(v) == null ? '—' : f.den(v);
  const cell = (r: ShopDayRow, c: Col): ReactNode => {
    switch (c) {
      case 'sales_mkd': return money(r.sales_mkd, c, r);
      case 'avg_receipt_mkd': return money(r.avg_receipt_mkd, c, r);
      case 'shop_margin_mkd': return money(r.shop_margin_mkd, c, r);
      case 'group_margin_mkd': return hasKey(r, c) && r.group_margin_mkd == null
        ? <span className="text-muted-foreground" title={t('shops.kpi.groupPending')}>—</span> : money(r.group_margin_mkd, c, r);
      case 'receipts': return f.int(r.receipts);
      case 'units': return f.int(r.units);
      case 'returns_units': return f.int(r.returns_units);
      case 'vs_avg_pct': return <VsAvgBadge pct={r.vs_avg_pct} f={f} />;
      case 'last': return r.last_receipt_at
        ? (mode === 'day' ? f.time(r.last_receipt_at) : f.dayTime(r.last_receipt_at))
        : <span className="text-muted-foreground">{t('shops.list.noReceipts')}</span>;
      case 'control': return <ControlBadge ok={r.control_ok} f={f} />;
    }
  };
  const sortable = (c: Col): c is ShopSortKey => ranking && c !== 'last' && c !== 'control';

  const nameBlock = (r: ShopDayRow, rank?: number) => (
    <div className="flex min-w-0 items-center gap-2">
      {rank != null && <span className="w-6 shrink-0 text-right text-xs font-semibold tabular-nums text-muted-foreground">{rank}</span>}
      <div className="min-w-0">
        <Link to={hrefFor(r.shop.code)} className="font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <span className="mr-1.5 font-mono text-xs text-muted-foreground">{r.shop.code}</span>{r.shop.name}
        </Link>
        <div className="break-words text-xs text-muted-foreground">
          {r.shop.city}{!r.shop.active && ` · ${t('shops.list.inactive')}`}
        </div>
      </div>
    </div>
  );
  const bar = (r: ShopDayRow) => {
    const v = sortValue(r, sortKey);
    if (!ranking || sortKey === 'vs_avg_pct' || v == null || max <= 0) return null;
    return (
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
        <div className="h-full rounded-full bg-[var(--sh-bar)]" style={{ width: `${Math.max(0, (v / max) * 100)}%` }} />
      </div>
    );
  };

  return (
    <>
      <div className="hidden overflow-x-auto rounded-xl border bg-card shadow-sm xl:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50 text-[11px] uppercase tracking-wide text-muted-foreground">
              <th scope="col" className="px-3 py-2 text-left font-medium">{t('shops.list.colShop')}</th>
              {cols.map((c) => {
                const active = sortable(c) && c === sortKey;
                return (
                  <th key={c} scope="col" title={c === 'vs_avg_pct' ? vsHint : undefined}
                    aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}
                    className={cn('px-2 py-2 font-medium', c === 'control' || c === 'vs_avg_pct' || c === 'last' ? 'text-left' : 'text-right')}>
                    {sortable(c) && onSort ? (
                      <button type="button" onClick={() => onSort(c)}
                        className={cn('inline-flex items-center gap-1 uppercase tracking-wide hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', active && 'text-foreground')}>
                        {label(c)}
                        {active && (dir === 'asc' ? <ArrowUp className="h-3 w-3" aria-hidden /> : <ArrowDown className="h-3 w-3" aria-hidden />)}
                      </button>
                    ) : label(c)}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.shop.code} className={cn('border-b last:border-0 hover:bg-muted/40', r.receipts === 0 && 'text-muted-foreground')}>
                <td className="min-w-[11rem] px-3 py-2 align-top">
                  {nameBlock(r, ranking ? i + 1 : undefined)}
                  {bar(r)}
                </td>
                {cols.map((c) => (
                  <td key={c} className={cn('whitespace-nowrap px-2 py-2 align-top tabular-nums',
                    c === 'control' || c === 'vs_avg_pct' || c === 'last' ? 'text-left' : 'text-right',
                    c === sortKey && ranking && 'font-semibold')}>
                    {cell(r, c)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="grid gap-2 md:grid-cols-2 xl:hidden" data-testid="shops-cards">
        {rows.map((r, i) => (
          <li key={r.shop.code} className={cn('min-w-0 rounded-xl border bg-card p-3 shadow-sm', r.receipts === 0 && 'opacity-80')}>
            <div className="flex items-start justify-between gap-2">
              {nameBlock(r, ranking ? i + 1 : undefined)}
              <Link to={hrefFor(r.shop.code)} aria-label={t('shops.list.open', { name: r.shop.name })}
                className="-mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted">
                <ChevronRight className="h-4 w-4" aria-hidden />
              </Link>
            </div>
            {bar(r)}
            <dl className="mt-2 grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-x-3 gap-y-2">
              {cols.filter((c) => c !== 'control' && c !== 'last').map((c) => (
                <div key={c} className="min-w-0">
                  <dt className="text-[11px] leading-tight text-muted-foreground" title={c === 'vs_avg_pct' ? vsHint : undefined}>{label(c)}</dt>
                  <dd className={cn('break-words text-sm tabular-nums', c === sortKey && ranking ? 'font-semibold' : 'font-medium')}>{cell(r, c)}</dd>
                </div>
              ))}
            </dl>
            {(cols.includes('last') || cols.includes('control')) && (
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-2 text-[11px] text-muted-foreground">
                {cols.includes('last') && (
                  <span>{t('shops.list.colLast')}: <span className="font-medium tabular-nums text-foreground">{cell(r, 'last')}</span></span>
                )}
                {cols.includes('control') && <ControlBadge ok={r.control_ok} f={f} />}
              </div>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
