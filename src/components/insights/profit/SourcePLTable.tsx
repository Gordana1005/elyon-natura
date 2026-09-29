import { Fragment, useId } from 'react';
import { cn } from '@/lib/utils';
import type { PLRow, ProfitResponse } from '@/lib/insightsApi/profit';
import { fmtNum } from '../overview/model';
import { sourceColorVar } from '../overview/palette';
import type { InsightsFormat } from '../shared/useInsightsFormat';
import { STATUS_TEXT } from '../shared/cohortPalette';

type Line = {
  key: string;
  label: string;
  value: (r: PLRow) => string;
  strong?: boolean;
  cost?: boolean;
  section?: string;
  tone?: (r: PLRow) => string | undefined;
};

/**
 * The P&L as a statement: one column per department, the owner's six in his
 * order (Affiliate – Lead in · Affiliate – Lead out · Teleshop – Lead out ·
 * Teleshop – Lead in · Social media · Web shop) and the total, one row per line — revenue, every
 * cost, net and margin — then the unit economics of each source (average
 * sale, cost and profit per sale, return rate, packages, cost coverage).
 * Σ source columns = the total column. The first column stays put on a phone.
 */
export function SourcePLTable({ clockRows, total, meta, clockLabel, f }: {
  clockRows: PLRow[];
  total: PLRow;
  meta: ProfitResponse['meta'];
  clockLabel: string;
  f: InsightsFormat;
}) {
  const { t } = f;
  const titleId = useId();
  const cols = [...clockRows, total];
  const neg = (v: number | null | undefined) => (v == null ? '—' : v === 0 ? f.den(0) : `−${f.den(v)}`);
  const lossTone = (r: PLRow) => (r.net_mkd < 0 ? STATUS_TEXT.critical : undefined);
  const lines: Line[] = [
    { key: 'sales', label: t('insights.profit.table.sales'), value: (r) => f.int(r.sales) },
    { key: 'revenue', label: t('insights.profit.table.revenue'), value: (r) => f.den(r.revenue_mkd), strong: true },
    { key: 'vat', label: t('insights.profit.step.vat', { pct: f.pct(meta.vat.rate, 0) }), value: (r) => neg(r.vat_mkd), cost: true },
    { key: 'cogs_known', label: t('insights.profit.step.cogs_known'), value: (r) => neg(r.cogs_known_mkd), cost: true },
    { key: 'cogs_est', label: t('insights.profit.step.cogs_est'), value: (r) => neg(r.cogs_est_mkd), cost: true },
    { key: 'courier', label: t('insights.profit.step.courier', { fee: f.den(meta.courier.deliver_mkd) }), value: (r) => neg(r.courier_mkd), cost: true },
    { key: 'returns', label: t('insights.profit.step.returns', { fee: f.den(meta.courier.return_mkd) }), value: (r) => neg(r.returns_mkd), cost: true },
    { key: 'commission', label: t('insights.profit.step.commission'), value: (r) => neg(r.commission_mkd), cost: true },
    { key: 'lead', label: t('insights.profit.step.lead'), value: (r) => (meta.lead_cost.configured ? neg(r.lead_cost_mkd) : t('insights.profit.table.notConfigured')), cost: true },
    { key: 'net', label: t('insights.profit.table.net'), value: (r) => f.den(r.net_mkd), strong: true, tone: lossTone },
    { key: 'margin', label: t('insights.profit.table.margin'), value: (r) => f.pct(r.margin), tone: lossTone },
    { key: 'costed', label: t('insights.profit.table.costedMargin'), value: (r) => f.pct(r.costed.margin) },
    // unit economics
    { key: 'aov', section: t('insights.profit.table.unitSection'), label: t('insights.profit.table.aov'), value: (r) => (r.aov_mkd == null ? '—' : f.den(r.aov_mkd)) },
    { key: 'cost_per_sale', label: t('insights.profit.table.costPerSale'), value: (r) => (r.cost_per_sale_mkd == null ? '—' : f.den(r.cost_per_sale_mkd)) },
    { key: 'profit_per_sale', label: t('insights.profit.table.profitPerSale'), value: (r) => (r.profit_per_sale_mkd == null ? '—' : f.den(r.profit_per_sale_mkd)), tone: lossTone },
    { key: 'return_rate', label: t('insights.profit.table.returnRate'), value: (r) => f.pct(r.return_rate) },
    { key: 'packages', label: t('insights.profit.table.packages'), value: (r) => (r.packages ? t('insights.profit.table.packagesVal', { n: f.int(r.packages), free: f.int(r.free_packages), per: r.packages_per_sale == null ? '—' : fmtNum(r.packages_per_sale, f.lang, 1) }) : '—') },
    { key: 'coverage', label: t('insights.profit.table.coverage'), value: (r) => f.pct(r.coverage_packages, 0), tone: (r) => (r.coverage_packages != null && r.coverage_packages < 0.9 ? STATUS_TEXT.warning : undefined) },
  ];

  return (
    <section aria-labelledby={titleId} className="space-y-2">
      <div>
        <h2 id={titleId} className="text-base font-semibold">{t('insights.profit.table.title')}</h2>
        <p className="text-xs text-muted-foreground">{clockLabel}</p>
      </div>
      <div className="overflow-x-auto rounded-xl border bg-card shadow-sm">
        <table className="w-full min-w-[880px] text-sm">
          <thead>
            <tr className="border-b text-[11px] uppercase tracking-wide text-muted-foreground">
              <th scope="col" className="sticky left-0 z-10 bg-card px-3 py-2 text-left font-medium">{t('insights.profit.table.line')}</th>
              {cols.map((c) => (
                <th key={c.key} scope="col" className={cn('px-3 py-2 text-right font-medium', c.key === 'total' && 'bg-muted/40')}>
                  <span className="inline-flex items-center justify-end gap-1.5">
                    {c.key !== 'total' && <span className="h-[3px] w-3 shrink-0 rounded-full" style={{ background: sourceColorVar(c.key) }} aria-hidden />}
                    {c.key === 'total' ? t('insights.profit.table.total') : f.sourceLabel(c.key)}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <Fragment key={l.key}>
                {l.section && (
                  <tr className="border-t-2 bg-muted/20">
                    <th scope="colgroup" colSpan={cols.length + 1} className="sticky left-0 px-3 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{l.section}</th>
                  </tr>
                )}
                <tr className={cn('border-b last:border-0', l.key === 'net' && 'border-t-2')}>
                  <th scope="row" className={cn('sticky left-0 z-10 bg-card px-3 py-1.5 text-left text-xs font-normal sm:text-sm', l.strong && 'font-semibold', l.cost && 'pl-5 text-muted-foreground')}>
                    {l.label}
                  </th>
                  {cols.map((c) => (
                    <td key={c.key} className={cn('px-3 py-1.5 text-right tabular-nums', l.strong && 'font-semibold', l.cost && 'text-muted-foreground', c.key === 'total' && 'bg-muted/40', l.tone?.(c))}>
                      {l.value(c)}
                    </td>
                  ))}
                </tr>
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] leading-snug text-muted-foreground">{t('insights.profit.table.note')}</p>
    </section>
  );
}
