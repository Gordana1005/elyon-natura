import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { AlertTriangle, FlaskConical, Info, ListChecks } from 'lucide-react';
import { apiGetInsightsLists, type ListsPart, type ListsResponse } from '@/lib/insightsApi/lists';
import { useAuth } from '@/contexts/AuthContext';
import { apiErrorText } from '@/i18n/apiErrors';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/EmptyState';
import { cn } from '@/lib/utils';
import { skopjeHm } from '@/lib/presence/state';
import { OVERVIEW_COLOR_VARS } from '../overview/palette';
import { dm } from '../overview/useOverviewFormat';
import { CohortBar } from '../shared/CohortBar';
import { CashFlowCard } from '../shared/CohortSecondary';
import { useInsightsFormat } from '../shared/useInsightsFormat';
import { useInsightsPeriod } from '../shared/useInsightsPeriod';
import type { DrillKey } from '../shared/cohortModel';
import { listsDrill, viewOf } from './listModel';
import { LISTS_COLOR_VARS } from './listsPalette';
import { ListsKpis } from './ListsKpis';
import { ListsWorkCard } from './ListsWorkCard';
import { ListsRanking } from './ListsRanking';
import { ListsTable } from './ListsTable';
import { ListsTrend } from './ListsTrend';
import { ListsMatrix } from './ListsMatrix';
import { ListsSellers } from './ListsSellers';
import { ListsQualityRail } from './ListsQualityRail';

type FixtureMode = '1' | 'nomoney';

/** The admin/manager view of a payload: every `*_mkd` key removed (dev fixture + tests). */
export function stripListsMoney(d: ListsResponse): ListsResponse {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) if (!/_(mkd|eur)$/.test(k)) out[k] = walk(x);
      return out;
    }
    return v;
  };
  const s = walk(d) as ListsResponse;
  s.meta = { ...s.meta, money: false };
  return s;
}

/**
 * Insights → Прогнозни списоци: which prediction lists make money.
 *
 * The ElyonCRM prediction-list slice of THE sale cohort (GET /insights/lists,
 * migration 20260941000400): sale day (Skopje), MEX-first parts that add up
 * to the total, value = parcel COD else price × 61,5. Σ lists + "list not
 * recorded" = the Overview's ElyonCRM · prediction_list split. Owners see
 * денари (meta.money); admins/managers the same page counted.
 *
 * In a DEV build `?lsFixture=1` (or `=nomoney`) renders the typed fixture —
 * compiled out of production builds.
 */
export default function PredictionListsTab() {
  const f = useInsightsFormat();
  const { t } = f;
  const { user } = useAuth();
  const [sp] = useSearchParams();
  const period = useInsightsPeriod();
  const range = period.range;
  const raw = import.meta.env.DEV ? sp.get('lsFixture') : null;
  const fixture: FixtureMode | null = raw === '1' || raw === 'nomoney' ? raw : null;

  const load = useCallback(async (signal?: AbortSignal): Promise<ListsResponse> => {
    if (import.meta.env.DEV && fixture) {
      const m = await import('./__fixtures__/lists.sample.json');
      const d = structuredClone(m.default) as unknown as ListsResponse;
      return fixture === 'nomoney' ? stripListsMoney(d) : d;
    }
    return apiGetInsightsLists({ from: range.from, to: range.to, compare: period.compare }, signal);
  }, [fixture, range.from, range.to, period.compare]);

  const q = useQuery({
    queryKey: ['insights-lists', user?.id, range.from, range.to, period.compare, fixture],
    queryFn: ({ signal }) => load(signal),
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
    retry: 0,
  });
  const data = q.data;
  const money = data?.meta.money === true;
  const views = useMemo(() => viewOf(data?.lists ?? []), [data]);
  const allParts = useMemo<ListsPart[]>(
    () => [...(data?.buckets ?? []), ...(data?.outside ?? [])] as ListsPart[],
    [data],
  );
  const spark = useMemo(
    () => (data?.trend ?? []).map((p) => ({ d: p.d, v: money && p.value_mkd != null ? p.value_mkd : p.count })),
    [data, money],
  );

  const errorText = (err: unknown) =>
    err instanceof Error && /^HTTP 404$|not found/i.test(err.message) ? t('insights.lists.notDeployed') : apiErrorText(err);

  const cutAt = data?.meta.partial && data.meta.prev_to_end ? skopjeHm(data.meta.prev_to_end) : '';
  const prevLabel = period.compare && data?.meta.has_prev && data.meta.prev_from && data.meta.prev_to
    ? (cutAt
      ? t('overview.kpi.vsPrevPartial', { period: f.period(data.meta.prev_from, data.meta.prev_to), time: cutAt })
      : t('overview.kpi.vsPrev', { period: f.period(data.meta.prev_from, data.meta.prev_to) }))
    : null;

  const firstAttr = data?.meta.first_attr_day ?? null;
  const beforeAttribution = !!firstAttr && range.from < firstAttr;
  const split = data?.elyon_crm.splits.find((s) => s.key === 'prediction_list');
  const empty = !!data && data.total.count === 0 && data.total.worked === 0 && (data.outside ?? []).every((o) => o.count === 0);

  return (
    <div className={cn('space-y-5', OVERVIEW_COLOR_VARS, LISTS_COLOR_VARS)}>
      {fixture && (
        <p role="status" className="flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          <FlaskConical className="h-4 w-4 shrink-0" aria-hidden />{t('overview.demoData')}
        </p>
      )}

      {!data ? (
        q.isError ? (
          <EmptyState
            icon={<AlertTriangle className="h-5 w-5" />}
            title={t('insights.loadFailed')}
            description={errorText(q.error)}
            size="sm"
            action={<Button variant="outline" size="sm" onClick={() => { void q.refetch(); }}>{t('common.retry')}</Button>}
          />
        ) : <ListsSkeleton />
      ) : (
        // Refetch keeps the frame: the previous numbers stay, dimmed, no skeleton.
        <div aria-busy={q.isFetching} className={cn('space-y-8 transition-opacity duration-200', q.isPlaceholderData && 'opacity-60')}>
          {q.isError && (
            <p role="alert" className="flex items-center gap-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
              <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
              {t('overview.staleError')} {errorText(q.error)}
              <Button variant="ghost" size="sm" className="ml-auto h-6 px-2 text-xs" onClick={() => { void q.refetch(); }}>{t('common.retry')}</Button>
            </p>
          )}

          {beforeAttribution && (
            <p className="flex items-start gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              <Info className="mt-px h-4 w-4 shrink-0" aria-hidden />
              {t('insights.lists.attributionNote', { date: dm(firstAttr!, true) })}
            </p>
          )}

          {empty ? (
            <EmptyState
              icon={<ListChecks className="h-5 w-5" />}
              title={t('insights.lists.empty.title')}
              description={beforeAttribution && range.to < firstAttr!
                ? t('insights.lists.empty.beforeAttribution', { date: dm(firstAttr!, true) })
                : t('insights.lists.empty.body')}
              size="sm"
            />
          ) : (
            <>
              <div className="space-y-3">
                <CohortBar
                  title={t(money ? 'insights.lists.cohort.title' : 'insights.lists.cohort.titleNoMoney', { period: f.period(range.from, range.to) })}
                  total={{ count: data.total.count, value_mkd: data.total.value_mkd ?? null, cod_mkd: data.total.cod_mkd ?? null }}
                  buckets={data.buckets}
                  outside={data.outside}
                  money={money}
                  prev={period.compare && data.prev ? data.prev : null}
                  prevLabel={prevLabel}
                  spark={spark}
                  note={split ? t(money ? 'insights.lists.cohort.tie' : 'insights.lists.cohort.tieNoMoney', {
                    n: f.int(split.count), value: split.value_mkd != null ? f.den(split.value_mkd) : '',
                  }) : null}
                  drillFor={(key: DrillKey | DrillKey[]) => listsDrill(allParts, key, range)}
                  f={f}
                />
                <ListsKpis data={data} range={range} money={money} f={f} />
              </div>

              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <ListsWorkCard total={data.total} f={f} />
                {data.cash_flow && (
                  <CashFlowCard
                    cash={{
                      parcels: data.cash_flow.parcels,
                      cod_mkd: data.cash_flow.cod_mkd,
                      from_this_period_mkd: data.cash_flow.from_this_period_mkd,
                      from_earlier_mkd: data.cash_flow.from_earlier_mkd,
                    }}
                    money={money}
                    f={f}
                  />
                )}
              </div>

              <ListsRanking rows={views} range={range} money={money} f={f} />
              <ListsTable data={data} rows={views} range={range} money={money} f={f} />
              <ListsTrend points={data.trend} granularity={data.meta.granularity} trendFrom={data.meta.trend_from}
                range={range} money={money} f={f} />
              <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
                <ListsMatrix rows={views} money={money} f={f} />
                <ListsSellers agents={data.agents} range={range} money={money} presenceFrom={data.meta.presence_from} f={f} />
              </div>
            </>
          )}

          <ListsQualityRail items={data.quality} range={range} today={data.meta.today} staleDays={data.meta.stale_days} money={money} f={f} />

          <p className="px-1 text-[11px] leading-relaxed text-muted-foreground">{t('insights.lists.footnote')}</p>
        </div>
      )}
    </div>
  );
}

function ListsSkeleton() {
  return (
    <div className="space-y-5" aria-hidden>
      <Skeleton variant="card" className="h-56" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} variant="card" className="h-24" />)}
      </div>
      <Skeleton variant="card" className="h-80" />
    </div>
  );
}
