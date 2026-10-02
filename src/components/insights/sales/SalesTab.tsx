import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { AlertTriangle, FlaskConical } from 'lucide-react';
import { apiGetInsightsSales, type SalesCore, type SalesDetail } from '@/lib/insightsApi/sales';
import { useAuth } from '@/contexts/AuthContext';
import { apiErrorText } from '@/i18n/apiErrors';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { skopjeHm } from '@/lib/presence/state';
import { OVERVIEW_COLOR_VARS } from '../overview/palette';
import { useInsightsPeriod } from '../shared/useInsightsPeriod';
import { useInsightsFormat } from '../shared/useInsightsFormat';
import { CompanyWideNote } from '../shared/CompanyWideNote';
import { CohortBar } from '../shared/CohortBar';
import { QualityRail } from '../shared/QualityRail';
import { LoadError } from '../shared/LoadError';
import { cohortDrill, stripCohortMoney } from '../shared/cohortModel';
import type { Cohort, CohortQualityKind } from '../shared/cohortTypes';
import { asCohortRows, detailQuality, prevHeadline } from './salesModel';
import { SalesKpis } from './SalesKpis';
import { SalesSources } from './SalesSources';
import { SalesTrend } from './SalesTrend';
import { SalesProducts } from './SalesProducts';
import { SalesCities } from './SalesCities';
import { SalesBuyers } from './SalesBuyers';
import { SalesBasket } from './SalesBasket';
import { SalesTiming } from './SalesTiming';
import { SalesChannels } from './SalesChannels';
import { SalesQualityCards } from './SalesQualityCards';

type FixtureMode = '1' | 'nomoney';

/** The dev fixture's non-owner twin: every *_mkd key removed (as the api does). */
const stripMoneyDeep = <T,>(v: T): T => stripCohortMoney(v as unknown as Cohort) as unknown as T;

/**
 * Insights → Продажби: "what did we sell". THE sale cohort (sale day, Skopje,
 * six departments, MEX-first parts that add up to the total) — the header is the
 * Overview's own number for the period, then where it came from, how it moved,
 * what was sold, where, to whom, in what basket, when, and through which MEX
 * channel. Owners see денари (meta.money); admins/managers the same page counted.
 *
 * Data: GET /insights/sales?part=core (header, sources, trend, timing, MEX
 * channels, quality) and ?part=detail (products, cities, buyers, basket) — both
 * asked at once, the header drawn first. In a DEV build `?salesFixture=1` (or
 * `=nomoney`) renders the 01–27.09.2026 fixture instead.
 */
export default function SalesTab() {
  const f = useInsightsFormat();
  const { t } = f;
  const { user } = useAuth();
  const [sp] = useSearchParams();
  const period = useInsightsPeriod();
  const range = period.range;
  const raw = import.meta.env.DEV ? sp.get('salesFixture') : null;
  const fixture: FixtureMode | null = raw === '1' || raw === 'nomoney' ? raw : null;

  const loadCore = useCallback(async (signal?: AbortSignal): Promise<SalesCore> => {
    if (import.meta.env.DEV && fixture) {
      const [c, p] = await Promise.all([import('./__fixtures__/sales.core.sample.json'), import('./__fixtures__/sales.prev.sample.json')]);
      const body = { ...structuredClone(c.default), prev: structuredClone(p.default) } as unknown as SalesCore;
      body.meta = { ...body.meta, prev_from: '2026-08-05', prev_to: '2026-08-31', part: 'core' };
      return fixture === 'nomoney' ? stripMoneyDeep(body) : body;
    }
    return apiGetInsightsSales({ from: range.from, to: range.to, compare: period.compare, part: 'core' }, signal);
  }, [fixture, range.from, range.to, period.compare]);

  const loadDetail = useCallback(async (signal?: AbortSignal): Promise<SalesDetail> => {
    if (import.meta.env.DEV && fixture) {
      const d = await import('./__fixtures__/sales.detail.sample.json');
      const body = structuredClone(d.default) as unknown as SalesDetail;
      return fixture === 'nomoney' ? stripMoneyDeep(body) : body;
    }
    return apiGetInsightsSales({ from: range.from, to: range.to, part: 'detail' }, signal);
  }, [fixture, range.from, range.to]);

  // The key carries the login (a cached owner payload never renders for the
  // next person on this browser) and starts with 'insights' (the period bar's
  // loading indicator and Cancel follow it).
  const coreQ = useQuery({
    queryKey: ['insights-sales', user?.id, range.from, range.to, period.compare, 'core', fixture],
    queryFn: ({ signal }) => loadCore(signal),
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
    retry: 0,
  });
  const detailQ = useQuery({
    queryKey: ['insights-sales', user?.id, range.from, range.to, 'detail', fixture],
    queryFn: ({ signal }) => loadDetail(signal),
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
    retry: 0,
  });

  const core = coreQ.data;
  const detail = detailQ.data;
  const money = core?.meta?.money === true;
  const detailMoney = detail?.meta?.money === true;
  const rows = useMemo(() => asCohortRows(core?.by_source, core?.meta?.dept_scope), [core]);
  // A dept_admin (access levels, 20260947001600): the detail tables are the whole company's
  // counts, never their departments' money — say so above them.
  const detailCompanyWide = detail?.meta?.company_wide === true;
  const prev = period.compare ? prevHeadline(core?.prev) : null;

  const cutAt = core?.meta.partial && core.meta.prev_to_end ? skopjeHm(core.meta.prev_to_end) : '';
  const prevLabel = prev && core?.meta.prev_from && core.meta.prev_to
    ? (cutAt
      ? t('overview.kpi.vsPrevPartial', { period: f.period(core.meta.prev_from, core.meta.prev_to), time: cutAt })
      : t('overview.kpi.vsPrev', { period: f.period(core.meta.prev_from, core.meta.prev_to) }))
    : null;
  // The hero's sparkline: sales per trend bucket (денари for owners, counts otherwise).
  const spark = useMemo(
    () => (core?.trend?.points ?? []).map((p) => ({ d: p.d, v: money && p.value_mkd != null ? p.value_mkd : p.count })),
    [core, money],
  );
  const qualityHref = (kind: CohortQualityKind): string | null =>
    kind === 'unproven_paid' ? cohortDrill(rows, 'paid_unproven', range).href : null;
  // Before the migration / deploy lands: say so, not a raw error.
  const errorText = (err: unknown) =>
    err instanceof Error && /^HTTP 404$|could not find the function|not found/i.test(err.message)
      ? t('insights.sales.notDeployed') : apiErrorText(err);

  return (
    <div className={cn('space-y-5', OVERVIEW_COLOR_VARS)}>
      {fixture && (
        <p role="status" className="flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          <FlaskConical className="h-4 w-4 shrink-0" aria-hidden />{t('overview.demoData')}
        </p>
      )}

      {!core ? (
        coreQ.isError ? (
          <LoadError text={errorText(coreQ.error)} onRetry={() => { void coreQ.refetch(); }} />
        ) : (
          <SalesSkeleton />
        )
      ) : (
        // Refetch keeps the frame: the previous numbers stay, dimmed, no skeleton.
        <div aria-busy={coreQ.isFetching || detailQ.isFetching} className="space-y-8">
          {coreQ.isError && (
            <p role="alert" className="flex items-center gap-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
              <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
              {t('overview.staleError')} {errorText(coreQ.error)}
              <Button variant="ghost" size="sm" className="ml-auto h-6 px-2 text-xs" onClick={() => { void coreQ.refetch(); }}>{t('common.retry')}</Button>
            </p>
          )}

          <div className={cn('space-y-8 transition-opacity duration-200', coreQ.isPlaceholderData && 'opacity-60')}>
            <div className="space-y-3">
              <CohortBar
                title={money
                  ? t('insights.sales.header.title', { period: f.period(range.from, range.to) })
                  : t('insights.sales.header.titleNoMoney', { period: f.period(range.from, range.to) })}
                total={core.total} buckets={core.buckets} outside={core.outside} money={money}
                rows={rows} range={range}
                prev={prev}
                prevLabel={prevLabel}
                spark={spark}
                f={f}
              />
              <SalesKpis core={core} detail={detail ?? null} money={money} f={f} />
            </div>
            <SalesSources core={core} money={money} range={range} compare={!!prev} f={f} />
            <SalesTrend core={core} money={money} range={range} f={f} />
          </div>

          {/* The heavy tables: their own request, their own loading and error. */}
          {!detail ? (
            detailQ.isError ? (
              <LoadError text={errorText(detailQ.error)} onRetry={() => { void detailQ.refetch(); }} />
            ) : (
              <DetailSkeleton label={t('insights.sales.detailLoading')} />
            )
          ) : (
            <div className={cn('space-y-8 transition-opacity duration-200', detailQ.isPlaceholderData && 'opacity-60')}>
              {detailQ.isError && (
                <p role="alert" className="flex items-center gap-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
                  <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
                  {t('overview.staleError')} {errorText(detailQ.error)}
                  <Button variant="ghost" size="sm" className="ml-auto h-6 px-2 text-xs" onClick={() => { void detailQ.refetch(); }}>{t('common.retry')}</Button>
                </p>
              )}
              {detailCompanyWide && <CompanyWideNote />}
              <SalesProducts detail={detail} money={detailMoney} f={f} />
              <SalesCities detail={detail} money={detailMoney} f={f} />
              <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
                <SalesBuyers detail={detail} money={detailMoney} f={f} />
                <SalesBasket detail={detail} money={detailMoney} f={f} />
              </div>
            </div>
          )}

          <div className={cn('space-y-8 transition-opacity duration-200', coreQ.isPlaceholderData && 'opacity-60')}>
            <SalesTiming core={core} f={f} />
            <SalesChannels core={core} money={money} f={f} />
            <div className="space-y-4">
              <QualityRail items={core.quality} money={money} hrefFor={qualityHref} f={f} />
              <SalesQualityCards items={detailQuality(detail)} money={detailMoney} f={f} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SalesSkeleton() {
  return (
    <div className="space-y-5" aria-hidden>
      <Skeleton variant="card" className="h-56" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} variant="card" className="h-20" />)}
      </div>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} variant="card" className="h-44" />)}
      </div>
      <Skeleton variant="card" className="h-72" />
    </div>
  );
}

function DetailSkeleton({ label }: { label: string }) {
  return (
    <div className="space-y-5" role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      <Skeleton variant="card" className="h-80" />
      <Skeleton variant="card" className="h-64" />
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <Skeleton variant="card" className="h-56" />
        <Skeleton variant="card" className="h-56" />
      </div>
    </div>
  );
}
