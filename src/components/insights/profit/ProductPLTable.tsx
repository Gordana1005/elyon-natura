import { useId, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Package, Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { ProfitProduct } from '@/lib/insightsApi/profit';
import { ClockCaption } from '../shared/ClockCaption';
import { STATUS_TEXT } from '../shared/cohortPalette';
import type { InsightsFormat } from '../shared/useInsightsFormat';
import { sortProducts, type ProductSort } from './profitModel';

const TOP = 20;

/**
 * The product P&L (cohort clock, collected sales, all six departments, folded by
 * product key): packages (of which free), revenue, cost per package, net and
 * margin on the same cost basis as the P&L, returns. A product without a
 * catalogue cost reads "no cost" — its net carries the labelled estimate,
 * never a clean margin. Loyalty points, delivery charges and notes are shown
 * apart (not packages). Top 20, then everything with search.
 */
export function ProductPLTable({ rows, others, total, f }: {
  rows: ProfitProduct[];
  others: ProfitProduct | null;
  total: number;
  f: InsightsFormat;
}) {
  const { t } = f;
  const titleId = useId();
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<ProductSort>('revenue');
  const [all, setAll] = useState(false);
  const shown = useMemo(() => sortProducts(rows.filter((p) => p.revenue_mkd !== 0 || p.returned_packages > 0), sort, q), [rows, sort, q]);
  const visible = all || q ? shown : shown.slice(0, TOP);
  const name = (p: ProfitProduct) => {
    if (p.key === '__mex_only__') return t('insights.profit.prod.mexOnly');
    if (p.key === '__unknown__') return t('insights.profit.prod.unknownLine');
    if (p.key === '__others__') return t('insights.common.sentinel.others');
    return p.name ?? p.key;
  };
  const SORTS: ProductSort[] = ['revenue', 'net', 'margin', 'packages', 'returns'];

  return (
    <section aria-labelledby={titleId} className="space-y-2">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id={titleId} className="flex items-center gap-2 text-base font-semibold">
            <Package className="h-4 w-4 text-muted-foreground" aria-hidden />{t('insights.profit.prod.title')}
          </h2>
          <p className="text-xs text-muted-foreground">{t('insights.profit.prod.subtitle', { n: f.int(total) })}</p>
          <ClockCaption clock="sale" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative">
            <span className="sr-only">{t('insights.profit.prod.search')}</span>
            <Search className="pointer-events-none absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('insights.profit.prod.search')} className="h-9 w-48 pl-8" />
          </label>
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            {t('insights.profit.prod.sortBy')}
            <select value={sort} onChange={(e) => setSort(e.target.value as ProductSort)}
              className="h-9 rounded-md border bg-background px-2 text-sm text-foreground">
              {SORTS.map((s) => <option key={s} value={s}>{t(`insights.profit.prod.sort.${s}`)}</option>)}
            </select>
          </label>
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border bg-card shadow-sm">
        <table className="w-full min-w-[900px] text-sm">
          <thead>
            <tr className="border-b text-[11px] uppercase tracking-wide text-muted-foreground">
              <th scope="col" className="px-3 py-2 text-left font-medium">{t('insights.profit.prod.product')}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">{t('insights.profit.prod.packages')}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">{t('insights.profit.table.revenue')}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">{t('insights.profit.prod.perPackage')}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">{t('insights.profit.prod.unitCost')}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">{t('insights.profit.prod.cogs')}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">{t('insights.profit.prod.otherCosts')}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">{t('insights.profit.table.net')}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">{t('insights.profit.table.margin')}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">{t('insights.profit.prod.returns')}</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr><td colSpan={10} className="px-3 py-6 text-center text-muted-foreground">{t('insights.profit.prod.none')}</td></tr>
            ) : visible.map((p) => <Row key={p.key} p={p} name={name(p)} f={f} />)}
            {others && (all || !q) && (all || shown.length <= TOP) && <Row p={others} name={name(others)} f={f} muted />}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span>{t('insights.profit.prod.note')}</span>
        {!q && shown.length > TOP && (
          <button type="button" onClick={() => setAll((v) => !v)} className="rounded-md border px-2 py-1 text-xs font-medium text-foreground hover:bg-muted">
            {all ? t('insights.profit.prod.showTop', { n: TOP }) : t('insights.profit.prod.showAll', { n: f.int(shown.length) })}
          </button>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground">
        <Link to="/products" className="underline underline-offset-2 hover:text-foreground">{t('insights.profit.prod.setCosts')}</Link>
      </p>
    </section>
  );
}

function Row({ p, name, f, muted }: { p: ProfitProduct; name: string; f: InsightsFormat; muted?: boolean }) {
  const { t } = f;
  const other = p.vat_mkd + p.courier_mkd + p.commission_mkd;
  const nonProduct = !p.package && p.kind !== 'unknown';
  return (
    <tr className={cn('border-b last:border-0 align-top', muted && 'bg-muted/30 text-muted-foreground')}>
      <th scope="row" className="max-w-[18rem] px-3 py-2 text-left font-medium">
        <span className="block truncate" title={name}>{name}</span>
        <span className="mt-0.5 flex flex-wrap gap-1 text-[10px] font-normal">
          {!p.cost_known && p.package && (
            <span className="rounded-full bg-amber-100 px-1.5 py-px text-amber-900 dark:bg-amber-950/60 dark:text-amber-200">{t('insights.profit.prod.noCost')}</span>
          )}
          {nonProduct && (
            <span className="rounded-full bg-muted px-1.5 py-px text-muted-foreground">
              {t(`insights.profit.prod.kind.${p.kind}`, { defaultValue: p.kind })}{!p.reviewed ? ` · ${t('insights.profit.prod.byName')}` : ''}
            </span>
          )}
          {p.kind === 'unknown' && (
            <span className="rounded-full bg-muted px-1.5 py-px text-muted-foreground">{t('insights.profit.prod.contentsUnknown')}</span>
          )}
          {p.sources.length > 0 && <span className="text-muted-foreground">{p.sources.map((s) => f.sourceLabel(s)).join(' · ')}</span>}
        </span>
      </th>
      <td className="px-3 py-2 text-right tabular-nums">
        {p.package ? f.int(p.packages) : '—'}
        {p.free_packages > 0 && <span className="block text-[11px] text-muted-foreground">{t('insights.profit.prod.freeN', { n: f.int(p.free_packages) })}</span>}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">{f.den(p.revenue_mkd)}</td>
      <td className="px-3 py-2 text-right tabular-nums">{p.package && p.packages > 0 ? f.den(Math.round(p.revenue_mkd / p.packages)) : '—'}</td>
      <td className="px-3 py-2 text-right tabular-nums">{p.unit_cost_mkd != null ? f.den(p.unit_cost_mkd) : '—'}</td>
      <td className="px-3 py-2 text-right tabular-nums">
        {p.cost_known ? f.den(p.cogs_mkd) : p.cogs_est_mkd != null
          ? <span className="italic text-muted-foreground" title={t('insights.profit.prod.estTip')}>≈ {f.den(p.cogs_est_mkd)}</span>
          : '—'}
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{f.den(other)}</td>
      <td className={cn('px-3 py-2 text-right font-semibold tabular-nums', p.net_mkd < 0 && STATUS_TEXT.critical, !p.cost_known && p.package && 'font-normal italic')}>
        {!p.cost_known && p.package ? '≈ ' : ''}{f.den(p.net_mkd)}
      </td>
      <td className={cn('px-3 py-2 text-right tabular-nums', !p.cost_known && p.package && 'italic text-muted-foreground')}>{f.pct(p.margin)}</td>
      <td className="px-3 py-2 text-right tabular-nums">
        {p.returned_packages > 0 ? f.int(p.returned_packages) : '—'}
        {p.return_rate != null && p.returned_packages > 0 && <span className="block text-[11px] text-muted-foreground">{f.pct(p.return_rate)}</span>}
      </td>
    </tr>
  );
}
