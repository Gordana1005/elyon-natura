import { useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/EmptyState';
import { apiErrorText } from '@/i18n/apiErrors';
import { cn } from '@/lib/utils';
import { skopjeHm } from '@/lib/presence/state';
import { OVERVIEW_COLOR_VARS } from '../overview/palette';
import { CohortBar } from '../shared/CohortBar';
import { useInsightsFormat } from '../shared/useInsightsFormat';
import { AffiliateBreakdownCard } from './AffiliateBreakdownCard';
import { ClockSwitch, type ClockKey } from './ClockSwitch';
import { ProductPLTable } from './ProductPLTable';
import { ProfitHero } from './ProfitHero';
import { ProfitQualityRail } from './ProfitQualityRail';
import { ProfitTrend } from './ProfitTrend';
import { SourcePLTable } from './SourcePLTable';
import { Waterfall } from './Waterfall';
import PureProfitExportDialog from './PureProfitExportDialog';
import { CacheNote } from './CacheNote';
import { CostSourceNote } from './CostSourceNote';
import { PROFIT_COLOR_VARS } from './profitPalette';
import { stripRows } from './profitModel';
import { useProfitQuery } from './useProfitQuery';

/**
 * Insights → Чиста добивка (Pure Profit), owners only. GET /insights/profit
 * for the page's one period: the P&L on two clocks — the SALES made in the
 * period and what MEX collected on them (cohort, the default), and the MONEY
 * that landed in the period (cash) — revenue → VAT → product cost (known +
 * labelled estimate; Sigma CalcBuyPrice through the recipes since 01.10.2026,
 * the source line says which) → the gifts packed in the parcels (Phase B) → MEX
 * courier → returns → today's commission → lead cost
 * (not configured) → net, by department, per Affiliate – Lead in webmaster, per product, per
 * day, with the cost-coverage rail. The previous render stays while a new
 * period loads.
 */
export default function PureProfitTab() {
  const f = useInsightsFormat();
  const { t } = f;
  const { q, period } = useProfitQuery();
  const [clockKey, setClockKey] = useState<ClockKey>('cohort');
  const data = q.data;
  const clock = data ? (clockKey === 'cohort' ? data.cohort : data.cash) : null;
  const rows = useMemo(() => (data ? stripRows(data.strip) : []), [data]);

  const clockLabel = t(clockKey === 'cohort' ? 'insights.profit.clock.cohortCaption' : 'insights.profit.clock.cashCaption', {
    period: data ? f.period(data.meta.from, data.meta.to) : '',
  });
  const cutAt = data?.meta.partial && data.meta.prev_to_end ? skopjeHm(data.meta.prev_to_end) : '';
  const prevLabel = data?.meta.prev_from && data.meta.prev_to
    ? (cutAt
      ? t('overview.kpi.vsPrevPartial', { period: f.period(data.meta.prev_from, data.meta.prev_to), time: cutAt })
      : t('overview.kpi.vsPrev', { period: f.period(data.meta.prev_from, data.meta.prev_to) }))
    : null;
  const errorText = (err: unknown) =>
    err instanceof Error && err.message === 'owners_only' ? t('insights.ownersOnly')
      : err instanceof Error && /^HTTP 404$|not found/i.test(err.message) ? t('overview.notDeployed') : apiErrorText(err);

  return (
    <div className={cn('space-y-6', OVERVIEW_COLOR_VARS, PROFIT_COLOR_VARS)}>
      {!data || !clock ? (
        q.isError ? (
          <EmptyState
            icon={<AlertTriangle className="h-5 w-5" />}
            title={t('insights.loadFailed')}
            description={errorText(q.error)}
            size="sm"
            action={<Button variant="outline" size="sm" onClick={() => { void q.refetch(); }}>{t('common.retry')}</Button>}
          />
        ) : <ProfitSkeleton />
      ) : (
        <div aria-busy={q.isFetching} className={cn('space-y-8 transition-opacity duration-200', q.isPlaceholderData && 'opacity-60')}>
          {q.isError && (
            <p role="alert" className="flex items-center gap-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
              <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
              {t('overview.staleError')} {errorText(q.error)}
              <Button variant="ghost" size="sm" className="ml-auto h-6 px-2 text-xs" onClick={() => { void q.refetch(); }}>{t('common.retry')}</Button>
            </p>
          )}

          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                {t('insights.profit.intro')}
                {period.compare && data.meta.prev_skipped && (
                  <span className="block">{t('insights.profit.prevSkipped', { n: data.meta.prev_max_days })}</span>
                )}
              </p>
              <PureProfitExportDialog data={data} />
            </div>
            <ClockSwitch value={clockKey} onChange={setClockKey} cohort={data.cohort} cash={data.cash} f={f} />
            <CacheNote meta={data.meta} f={f} />
            <CostSourceNote meta={data.meta} clock={clockKey} f={f} />
          </div>

          <ProfitHero clock={clock} meta={data.meta} prevLabel={prevLabel} f={f} />

          {clockKey === 'cohort' && (
            <CohortBar
              title={t('insights.profit.strip.title', { period: f.period(data.meta.from, data.meta.to) })}
              note={t('insights.profit.strip.note')}
              total={data.strip.total}
              buckets={data.strip.buckets}
              outside={data.strip.outside}
              money
              rows={rows}
              range={{ from: data.meta.from, to: data.meta.to }}
              f={f}
            />
          )}

          <div className="grid grid-cols-1 gap-6 2xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
            <Waterfall row={clock.total} meta={data.meta} clockLabel={clockLabel} f={f} />
            <ProfitTrend points={clock.trend} granularity={data.meta.granularity} cohort={clockKey === 'cohort'} f={f} />
          </div>

          <SourcePLTable clockRows={clock.by_source} total={clock.total} meta={data.meta} clockLabel={clockLabel} f={f} />

          <AffiliateBreakdownCard
            rows={clock.affiliates}
            altercpa={clock.by_source.find((r) => r.key === 'altercpa')}
            cohort={clockKey === 'cohort'}
            f={f}
          />

          <ProductPLTable rows={data.products} others={data.products_others} total={data.products_total} f={f} />

          <ProfitQualityRail items={data.quality} f={f} />
        </div>
      )}
    </div>
  );
}

function ProfitSkeleton() {
  return (
    <div className="space-y-5" aria-hidden>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Skeleton variant="card" className="h-28" />
        <Skeleton variant="card" className="h-28" />
      </div>
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[5fr_9fr]">
        <Skeleton variant="card" className="h-48" />
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} variant="card" className="h-24" />)}
        </div>
      </div>
      <Skeleton variant="card" className="h-72" />
      <Skeleton variant="card" className="h-64" />
    </div>
  );
}
