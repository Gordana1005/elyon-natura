import { useId } from 'react';
import { Users } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PLRow, ProfitAffiliate } from '@/lib/insightsApi/profit';
import { sourceColorVar } from '../overview/palette';
import { STATUS_TEXT } from '../shared/cohortPalette';
import type { InsightsFormat } from '../shared/useInsightsFormat';

/**
 * Affiliate – Lead in by webmaster — nested under that department's column of
 * the P&L (`altercpa`): the rows add up to it (a sale with no webmaster on
 * file is its own row). Same
 * cost model as the P&L; lead cost is not in it (no per-webmaster rates yet),
 * so each row is profit BEFORE what the lead cost us. Names come from
 * altercpa_webmasters; an unnamed partner shows its id.
 */
export function AffiliateBreakdownCard({ rows, altercpa, cohort, f }: {
  rows: ProfitAffiliate[];
  altercpa: PLRow | undefined;
  cohort: boolean;
  f: InsightsFormat;
}) {
  const { t } = f;
  const titleId = useId();
  if (!rows.length) return null;
  const name = (a: ProfitAffiliate) =>
    a.key === '__none__' ? t('insights.profit.aff.none') : a.name ?? t('insights.profit.aff.unnamed', { id: a.key });
  return (
    <section aria-labelledby={titleId} className="space-y-2">
      <div>
        <h2 id={titleId} className="flex items-center gap-2 text-base font-semibold">
          <span className="h-[3px] w-4 rounded-full" style={{ background: sourceColorVar('altercpa') }} aria-hidden />
          <Users className="h-4 w-4 text-muted-foreground" aria-hidden />{t('insights.profit.aff.title')}
        </h2>
        <p className="text-xs text-muted-foreground">{t('insights.profit.aff.subtitle')}</p>
      </div>
      <div className="overflow-x-auto rounded-xl border bg-card shadow-sm">
        <table className="w-full min-w-[680px] text-sm">
          <thead>
            <tr className="border-b text-[11px] uppercase tracking-wide text-muted-foreground">
              <th scope="col" className="px-3 py-2 text-left font-medium">{t('insights.profit.aff.partner')}</th>
              {cohort && <th scope="col" className="px-3 py-2 text-right font-medium">{t('insights.profit.aff.sales')}</th>}
              <th scope="col" className="px-3 py-2 text-right font-medium">{cohort ? t('insights.profit.aff.collected') : t('insights.profit.aff.parcels')}</th>
              {cohort && <th scope="col" className="px-3 py-2 text-right font-medium">{t('insights.profit.aff.returnRate')}</th>}
              <th scope="col" className="px-3 py-2 text-right font-medium">{t('insights.profit.table.revenue')}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">{t('insights.profit.aff.net')}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">{t('insights.profit.table.margin')}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">{t('insights.profit.table.profitPerSale')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.key} className="border-b last:border-0">
                <th scope="row" className="px-3 py-2 text-left font-medium">
                  {name(a)}
                  {a.name && <span className="ml-1.5 font-mono text-[11px] font-normal text-muted-foreground">{a.key}</span>}
                </th>
                {cohort && (
                  <td className="px-3 py-2 text-right tabular-nums">
                    {f.int(a.sales_total)}
                    {a.open > 0 && <span className="block text-[11px] text-muted-foreground">{t('insights.profit.aff.openN', { n: f.int(a.open) })}</span>}
                  </td>
                )}
                <td className="px-3 py-2 text-right tabular-nums">{f.int(a.pl.sales)}</td>
                {cohort && <td className="px-3 py-2 text-right tabular-nums">{f.pct(a.pl.return_rate)}</td>}
                <td className="px-3 py-2 text-right tabular-nums">{f.den(a.pl.revenue_mkd)}</td>
                <td className={cn('px-3 py-2 text-right font-semibold tabular-nums', a.pl.net_mkd < 0 && STATUS_TEXT.critical)}>{f.den(a.pl.net_mkd)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{f.pct(a.pl.margin)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{a.pl.profit_per_sale_mkd == null ? '—' : f.den(a.pl.profit_per_sale_mkd)}</td>
              </tr>
            ))}
          </tbody>
          {altercpa && (
            <tfoot>
              <tr className="border-t-2 bg-muted/30 font-semibold">
                <th scope="row" className="px-3 py-2 text-left">{t('insights.profit.aff.sum')}</th>
                {cohort && <td className="px-3 py-2 text-right tabular-nums">{f.int(rows.reduce((s, a) => s + a.sales_total, 0))}</td>}
                <td className="px-3 py-2 text-right tabular-nums">{f.int(altercpa.sales)}</td>
                {cohort && <td className="px-3 py-2 text-right tabular-nums">{f.pct(altercpa.return_rate)}</td>}
                <td className="px-3 py-2 text-right tabular-nums">{f.den(altercpa.revenue_mkd)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{f.den(altercpa.net_mkd)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{f.pct(altercpa.margin)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{altercpa.profit_per_sale_mkd == null ? '—' : f.den(altercpa.profit_per_sale_mkd)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      <p className="text-[11px] leading-snug text-muted-foreground">{t('insights.profit.aff.leadNote')}</p>
    </section>
  );
}
