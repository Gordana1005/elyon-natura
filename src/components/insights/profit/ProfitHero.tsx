import type { ReactNode } from 'react';
import { AlertTriangle, Info } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ProfitClock, ProfitResponse } from '@/lib/insightsApi/profit';
import { DeltaBadge } from '../overview/KpiRow';
import { delta } from '../overview/model';
import { Sparkline } from '../overview/Sparkline';
import { ClockCaption } from '../shared/ClockCaption';
import { STATUS_TEXT } from '../shared/cohortPalette';
import type { InsightsFormat } from '../shared/useInsightsFormat';
import { totalCosts } from './profitModel';

/**
 * The bottom line of the selected clock — net profit (the hero), its margin
 * and change — and the tiles that explain it: revenue, costs, cost coverage,
 * profit per sale, and what is still open (cohort) or came back (cash).
 */
export function ProfitHero({
  clock, meta, prevLabel, f,
}: {
  clock: ProfitClock;
  meta: ProfitResponse['meta'];
  prevLabel: string | null;
  f: InsightsFormat;
}) {
  const { t } = f;
  const tot = clock.total;
  const cohort = clock.clock === 'sale';
  const d = clock.prev ? delta(tot.net_mkd, clock.prev.net_mkd, 'up') : null;
  const spark = clock.trend.length > 1 ? clock.trend.map((p) => ({ d: p.d, v: p.net_mkd })) : null;
  const cov = tot.coverage_packages;
  const lowCoverage = cov != null && cov < 0.9;

  return (
    <section aria-labelledby="pp-hero" className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,5fr)_minmax(0,9fr)]">
      <div className="flex flex-col justify-between rounded-xl border bg-card p-4 shadow-sm sm:p-5">
        <div className="space-y-1">
          <h2 id="pp-hero" className="text-sm font-medium text-muted-foreground">
            {cohort ? t('insights.profit.hero.titleCohort') : t('insights.profit.hero.titleCash')}
          </h2>
          <ClockCaption clock={cohort ? 'sale' : 'delivered'} />
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 pt-1">
            <span className={cn(
              'break-words text-[clamp(2.25rem,8vw,3.5rem)] font-semibold leading-[1.05] tracking-tight tabular-nums',
              tot.net_mkd < 0 ? STATUS_TEXT.critical : 'text-card-foreground',
            )}>
              {f.den(tot.net_mkd)}
            </span>
            <DeltaBadge d={d} f={f} />
          </div>
          <p className="text-sm tabular-nums text-muted-foreground">
            {t('insights.profit.hero.marginLine', { margin: f.pct(tot.margin), sales: f.int(tot.sales) })}
          </p>
          {prevLabel && clock.prev && (
            <p className="text-[11px] tabular-nums text-muted-foreground">
              {prevLabel} · {f.den(clock.prev.net_mkd)}
            </p>
          )}
          {tot.cogs_est_mkd != null && tot.cogs_est_mkd > 0 && (
            <p className="flex items-start gap-1 pt-1 text-[11px] leading-snug text-muted-foreground">
              <Info className="mt-px h-3 w-3 shrink-0" aria-hidden />
              {t('insights.profit.hero.estimateNote', {
                est: f.den(tot.cogs_est_mkd), share: f.pct(clock.cost_ratio), upper: f.den(tot.net_upper_mkd),
              })}
            </p>
          )}
        </div>
        {spark && <Sparkline className="mt-4 h-14" points={spark} accentClass="bg-[#334155] dark:bg-[#cbd5e1]" />}
      </div>

      <ul className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <Tile label={t('insights.profit.tile.revenue')} value={f.den(tot.revenue_mkd)}
          sub={cohort ? t('insights.profit.tile.revenueCohortSub', { n: f.int(tot.sales) }) : t('insights.profit.tile.revenueCashSub', { n: f.int(tot.sales) })}
          extra={tot.card_mkd > 0 ? t('insights.profit.tile.cardPart', { v: f.den(tot.card_mkd) }) : null} />
        <Tile label={t('insights.profit.tile.costs')} value={f.den(totalCosts(tot))}
          sub={t('insights.profit.tile.costsSub', { pct: f.pct(tot.revenue_mkd > 0 ? totalCosts(tot) / tot.revenue_mkd : null) })} />
        <Tile label={t('insights.profit.tile.perSale')} value={tot.profit_per_sale_mkd != null ? f.den(tot.profit_per_sale_mkd) : '—'}
          sub={t('insights.profit.tile.aov', { v: tot.aov_mkd != null ? f.den(tot.aov_mkd) : '—' })} />
        <Tile
          label={t('insights.profit.tile.coverage')}
          value={f.pct(cov, 0)}
          sub={t('insights.profit.tile.coverageSub', { c: f.int(tot.packages_costed), n: f.int(tot.packages) })}
          status={lowCoverage ? (
            <span className={cn('inline-flex items-center gap-1 text-[11px] font-medium', STATUS_TEXT.warning)}>
              <AlertTriangle className="h-3 w-3" aria-hidden />{t('insights.profit.tile.coverageLow')}
            </span>
          ) : null}
          alert={lowCoverage}
        />
        {cohort && clock.open ? (
          <Tile label={t('insights.profit.tile.open')} value={f.den(clock.open.value_mkd)}
            sub={t('insights.profit.tile.openSub', { n: f.int(clock.open.count) })} />
        ) : (
          <Tile label={t('insights.profit.tile.parcels')} value={f.int(Math.round(tot.parcels_delivered))}
            sub={t('insights.profit.tile.parcelsSub', { r: f.int(Math.round(tot.parcels_returned)) })} />
        )}
        <Tile
          label={cohort ? t('insights.profit.tile.returned') : t('insights.profit.tile.returnRate')}
          value={cohort ? f.den(tot.returned_mkd ?? 0) : f.pct(tot.return_rate)}
          sub={cohort
            ? t('insights.profit.tile.returnedSub', { n: f.int(tot.returned ?? 0), pct: f.pct(tot.return_rate) })
            : t('insights.profit.tile.returnRateSub', { fee: f.den(meta.courier.return_mkd) })}
        />
      </ul>
    </section>
  );
}

function Tile({ label, value, sub, extra, status, alert }: {
  label: string; value: string; sub?: string | null; extra?: string | null; status?: ReactNode; alert?: boolean;
}) {
  return (
    <li className={cn(
      'flex min-w-0 flex-col rounded-xl border bg-card p-3 shadow-sm sm:p-4',
      alert && 'border-amber-300 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/30',
    )}>
      <span className="text-xs font-medium leading-tight text-muted-foreground">{label}</span>
      <span className="mt-1 block truncate text-xl font-semibold tabular-nums text-card-foreground sm:text-2xl">{value}</span>
      {sub && <span className="text-xs tabular-nums text-muted-foreground">{sub}</span>}
      {extra && <span className="text-[11px] tabular-nums text-muted-foreground">{extra}</span>}
      {status && <div className="mt-1.5">{status}</div>}
    </li>
  );
}
