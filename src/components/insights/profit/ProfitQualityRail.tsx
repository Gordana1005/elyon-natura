import { useId } from 'react';
import { AlertTriangle, Info, OctagonAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ProfitQuality } from '@/lib/insightsApi/profit';
import { STATUS_TEXT } from '../shared/cohortPalette';
import type { InsightsFormat } from '../shared/useInsightsFormat';

const ICON = { critical: OctagonAlert, warning: AlertTriangle, info: Info } as const;
const TEXT = { critical: STATUS_TEXT.critical, warning: STATUS_TEXT.warning, info: STATUS_TEXT.neutral } as const;
const BORDER = { critical: 'border-red-300 dark:border-red-900', warning: 'border-amber-300 dark:border-amber-900', info: '' } as const;
const RANK = { critical: 0, warning: 1, info: 2 } as const;

/**
 * What the profit above cannot vouch for yet — cost coverage (with the
 * biggest uncosted products), MEX parcels whose contents are unknown, unproven
 * "paid", lines read as non-products by their name, orders with no lines, the
 * sales with no Sigma VAT rate (taxed at 5 %, with the biggest products), and
 * the settings still pending (lead cost, MEX return fee; per-product VAT not
 * active yet). Review queues only: nothing is fixed or merged automatically.
 */
export function ProfitQualityRail({ items, f }: { items: ProfitQuality[]; f: InsightsFormat }) {
  const { t } = f;
  const titleId = useId();
  const live = items
    .filter((q) => q.count > 0 || q.kind === 'vat_flat_default')
    .sort((a, b) => RANK[a.severity] - RANK[b.severity] || (b.value_mkd ?? 0) - (a.value_mkd ?? 0));
  return (
    <section aria-labelledby={titleId} className="space-y-3">
      <h2 id={titleId} className="text-base font-semibold">{t('insights.profit.quality.title')}</h2>
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {live.map((q) => {
          const Icon = ICON[q.severity];
          const settings = q.kind === 'vat_flat_default' || q.kind === 'lead_cost_missing' || q.kind === 'return_fee_unconfirmed';
          return (
            <li key={q.kind} className={cn('flex min-w-0 flex-col rounded-xl border bg-card p-4 shadow-sm', BORDER[q.severity])}>
              <span className={cn('inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide', TEXT[q.severity])}>
                <Icon className="h-3.5 w-3.5" aria-hidden />
                {settings ? t('insights.profit.quality.pendingSetting') : t(`insights.common.quality.severity.${q.severity}`)}
              </span>
              <h3 className="mt-1 text-sm font-medium leading-snug">{t(`insights.profit.quality.kind.${q.kind}`)}</h3>
              {!settings && (
                <div className="mt-1 flex flex-wrap items-baseline gap-x-2">
                  <span className="text-2xl font-semibold tabular-nums">{f.int(q.count)}</span>
                  {q.share != null && <span className="text-sm tabular-nums text-muted-foreground">{f.pct(q.share)}</span>}
                  {q.value_mkd != null && q.value_mkd !== 0 && (
                    <span className="text-sm tabular-nums text-muted-foreground">{f.den(q.value_mkd)}</span>
                  )}
                </div>
              )}
              <p className="mt-2 text-[11px] leading-snug text-muted-foreground">{t(`insights.profit.quality.hint.${q.kind}`)}</p>
              {q.top && q.top.length > 0 && (
                <ol className="mt-2 space-y-0.5 text-[11px]">
                  {q.top.map((p) => {
                    const name = p.key === '__mex_only__' ? t('insights.profit.prod.mexOnly')
                      : p.key === '__unknown__' ? t('insights.profit.prod.unknownLine') : (p.name ?? p.key);
                    return (
                      <li key={p.key} className="flex justify-between gap-2">
                        <span className="truncate" title={name}>{name}</span>
                        <span className="shrink-0 tabular-nums text-muted-foreground">
                          {p.packages > 0 ? t('insights.profit.quality.topLine', { n: f.int(p.packages), v: f.den(p.revenue_mkd) }) : f.den(p.revenue_mkd)}
                        </span>
                      </li>
                    );
                  })}
                </ol>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
