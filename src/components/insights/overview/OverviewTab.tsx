import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, FlaskConical } from 'lucide-react';
import {
  apiGetInsightsOverview, apiGetInsightsPivot,
  type OrdersDrillParams, type OverviewPivotDim, type OverviewPivotResponse, type OverviewResponse,
  type OverviewSource, type OverviewSourceKey,
} from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import { apiErrorText } from '@/i18n/apiErrors';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/EmptyState';
import { cn } from '@/lib/utils';
import { skopjeHm } from '@/lib/presence/state';
import { OVERVIEW_COLOR_VARS, SOURCE_ORDER } from './palette';
import {
  OUTCOME, deriveKpis, groupPivotRows, measureSetOf, ordersHref, parseOverviewParams, placedOf, preparingOf,
  previousRange, seriesFromTrend, skopjeToday, sourceDrill, stripMoney, writeOverviewParams,
  type DayRange, type MeasureSet, type OverviewFilters, type TileKey,
} from './model';
import { useOverviewFormat } from './useOverviewFormat';
import { FilterBar } from './FilterBar';
import { FreshnessStrip } from './FreshnessStrip';
import { KpiRow } from './KpiRow';
import { SourceRows } from './SourceRows';
import { SourceTrends } from './SourceTrends';
import { TeamsBoard } from './TeamsBoard';
import { DrillPivot } from './DrillPivot';
import { AttentionRail } from './AttentionRail';

type FixtureMode = '1' | 'nomoney';

/**
 * The connected Overview (Insights → Overview): every denar by source, team and
 * person, MEX-proven cash apart from claims. Owners get money (meta.money);
 * admins/managers get the same page counted, never an empty hole.
 *
 * Data: GET /insights/overview (+ /insights/pivot per drill level). In a DEV
 * build `?ovFixture=1` (or `=nomoney`) renders the typed fixture instead — the
 * branch and the JSON are compiled out of production builds.
 */
export default function OverviewTab() {
  const f = useOverviewFormat();
  const { t } = f;
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [sp, setSp] = useSearchParams();
  const today = useMemo(() => skopjeToday(), []);
  const filters = useMemo(() => parseOverviewParams(sp, today), [sp, today]);
  const setFilters = useCallback(
    (next: Partial<OverviewFilters>) => setSp((prev) => writeOverviewParams(prev, next), { replace: true }),
    [setSp],
  );
  const raw = import.meta.env.DEV ? sp.get('ovFixture') : null;
  const fixture: FixtureMode | null = raw === '1' || raw === 'nomoney' ? raw : null;

  const load = useCallback(async (r: DayRange, compare: boolean, signal?: AbortSignal): Promise<OverviewResponse> => {
    if (import.meta.env.DEV && fixture) {
      const m = await import('./__fixtures__/overview.sample.json');
      const d = structuredClone(m.default) as unknown as OverviewResponse;
      return fixture === 'nomoney' ? stripMoney(d) : d;
    }
    return apiGetInsightsOverview({ from: r.from, to: r.to, compare }, signal);
  }, [fixture]);

  const q = useQuery({
    queryKey: ['insights-overview', user?.id, filters.range.from, filters.range.to, filters.compare, fixture],
    queryFn: ({ signal }) => load(filters.range, filters.compare, signal),
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
    retry: 0,
  });
  const data = q.data;

  // Which sources are in view. Empty filter = all of them; order is fixed.
  const allKeys = useMemo(
    () => SOURCE_ORDER.filter((k) => data?.sources.some((s) => s.key === k))
      .concat((data?.sources ?? []).map((s) => s.key).filter((k) => !SOURCE_ORDER.includes(k))),
    [data],
  );
  const selected: OverviewSourceKey[] = useMemo(
    () => (filters.sources.length ? allKeys.filter((k) => filters.sources.includes(k)) : allKeys),
    [allKeys, filters.sources],
  );
  const filtered = filters.sources.length > 0 && selected.length < allKeys.length;

  // A source filter needs the previous period per source → the same endpoint for that span.
  const prevRange = previousRange(filters.range);
  const prevQ = useQuery({
    queryKey: ['insights-overview', user?.id, prevRange.from, prevRange.to, false, fixture],
    queryFn: ({ signal }) => load(prevRange, false, signal),
    enabled: !!data && filters.compare && filtered,
    staleTime: 5 * 60_000,
    retry: 0,
  });

  // Past ~3 s the spinner gains elapsed seconds and a Cancel (same as the page).
  const [slowSecs, setSlowSecs] = useState(0);
  useEffect(() => {
    if (!q.isFetching) { setSlowSecs(0); return; }
    const id = setInterval(() => setSlowSecs((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [q.isFetching]);

  const fetchPivot = useCallback(async (by: OverviewPivotDim[], signal?: AbortSignal): Promise<OverviewPivotResponse> => {
    if (import.meta.env.DEV && fixture) {
      const m = await import('./__fixtures__/pivot.sample.json');
      const rows = (m.default as unknown as OverviewPivotResponse).rows;
      const grouped = groupPivotRows(rows, by);
      if (fixture === 'nomoney') for (const r of grouped) { delete r.value_eur; delete r.delivered_cash_mkd; }
      return { by, rows: grouped };
    }
    return apiGetInsightsPivot({ from: filters.range.from, to: filters.range.to, by }, signal);
  }, [fixture, filters.range.from, filters.range.to]);

  const money = data?.meta.money === true;
  const sources = useMemo(
    () => (data?.sources ?? []).filter((s) => selected.includes(s.key))
      .sort((a, b) => selected.indexOf(a.key) - selected.indexOf(b.key)),
    [data, selected],
  );

  const view = useMemo(() => {
    if (!data) return null;
    const cur: MeasureSet = filtered ? deriveKpis(sources, data.kpis) : measureSetOf(data.kpis);
    let prev: MeasureSet | null = null;
    if (filters.compare) {
      if (!filtered) prev = data.kpis.prev ? measureSetOf(data.kpis.prev) : null;
      else if (prevQ.data) {
        const ps = prevQ.data.sources.filter((s) => selected.includes(s.key));
        prev = deriveKpis(ps, prevQ.data.kpis);
      }
    }
    const pts = data.trend?.points ?? [];
    const spark = data.kpis.spark ?? {};
    const sparks: Partial<Record<TileKey, { d: string; v: number }[] | null>> = {
      placed: !filtered && money && spark.placed_value?.length ? spark.placed_value
        : seriesFromTrend(pts, selected, money ? 'placed_value_eur' : 'placed_count'),
      delivered: !filtered && money && spark.delivered_cash_mkd?.length ? spark.delivered_cash_mkd
        : seriesFromTrend(pts, selected, money ? 'delivered_cash_mkd' : 'delivered_count'),
    };
    if (!filtered) {
      for (const k of ['confirmed', 'at_courier', 'to_collect', 'lost', 'unproven_paid'] as TileKey[]) {
        const series = spark[k];
        if (Array.isArray(series) && series.length) sparks[k] = series;
      }
    }
    return { cur, prev, sparks, hrefs: tileHrefs(sources, filters.range, filtered) };
  }, [data, prevQ.data, sources, selected, filtered, filters.compare, filters.range, money]);

  const teams = useMemo(() => (data?.teams ?? []), [data]);
  const shownTeams = filters.teams.length ? teams.filter((tm) => filters.teams.includes(tm.team_key)) : teams;
  const teamPeople = filters.teams.length ? new Set(shownTeams.flatMap((tm) => tm.members.map((m) => m.person_id))) : null;

  const cutAt = data?.meta.partial && data.meta.prev_to_end ? skopjeHm(data.meta.prev_to_end) : '';
  const prevLabel = filters.compare && data?.meta.prev_from && data.meta.prev_to
    ? (cutAt
      ? t('overview.kpi.vsPrevPartial', { period: f.period(data.meta.prev_from, data.meta.prev_to), time: cutAt })
      : t('overview.kpi.vsPrev', { period: f.period(data.meta.prev_from, data.meta.prev_to) }))
    : filters.compare && filtered ? t('overview.kpi.vsPrev', { period: f.period(prevRange.from, prevRange.to) }) : null;

  const errorText = (err: unknown) =>
    err instanceof Error && /^HTTP 404$|not found/i.test(err.message) ? t('overview.notDeployed') : apiErrorText(err);

  return (
    <div className={cn('space-y-5', OVERVIEW_COLOR_VARS)}>
      {fixture && (
        <p role="status" className="flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          <FlaskConical className="h-4 w-4 shrink-0" aria-hidden />{t('overview.demoData')}
        </p>
      )}

      <FilterBar
        filters={filters}
        onChange={setFilters}
        today={today}
        teams={teams.map((tm) => ({ key: tm.team_key, name: tm.name }))}
        fetching={q.isFetching}
        slowSecs={slowSecs}
        onCancel={() => queryClient.cancelQueries({ queryKey: ['insights-overview'] })}
        f={f}
      />

      {!data ? (
        q.isError ? (
          <EmptyState
            icon={<AlertTriangle className="h-5 w-5" />}
            title={t('insights.loadFailed')}
            description={errorText(q.error)}
            size="sm"
            action={<Button variant="outline" size="sm" onClick={() => { void q.refetch(); }}>{t('common.retry')}</Button>}
          />
        ) : (
          <OverviewSkeleton />
        )
      ) : (
        // Refetch keeps the frame: the previous numbers stay, dimmed, no skeleton.
        <div
          aria-busy={q.isFetching}
          className={cn('space-y-8 transition-opacity duration-200', q.isPlaceholderData && 'opacity-60')}
        >
          {q.isError && (
            <p role="alert" className="flex items-center gap-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
              <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
              {t('overview.staleError')} {errorText(q.error)}
              <Button variant="ghost" size="sm" className="ml-auto h-6 px-2 text-xs" onClick={() => { void q.refetch(); }}>{t('common.retry')}</Button>
            </p>
          )}
          <FreshnessStrip feeds={data.freshness ?? []} attention={data.attention ?? []} asOf={skopjeHm(data.meta.generated_at) || null} f={f} />
          {view && (
            <KpiRow cur={view.cur} prev={view.prev} money={money} sparks={view.sparks} hrefs={view.hrefs}
              prevLabel={prevLabel} filtered={filtered} f={f} />
          )}
          <SourceRows sources={sources} range={filters.range} money={money} f={f} />
          <SourceTrends points={data.trend?.points ?? []} granularity={data.trend?.granularity ?? 'day'} sources={selected} money={money} f={f} />
          <TeamsBoard teams={shownTeams} range={filters.range} money={money} canTvLink={!!(user?.isAdmin || user?.isManager)} f={f} />
          <DrillPivot
            sources={sources}
            teamsFilter={filters.teams}
            range={filters.range}
            money={money}
            fetchPivot={fetchPivot}
            queryKeyBase={['insights-overview', user?.id, filters.range.from, filters.range.to, fixture]}
            teams={teams}
            f={f}
          />
          <AttentionRail items={data.attention ?? []} money={money} teamPeople={teamPeople} f={f} />
        </div>
      )}
    </div>
  );
}

/**
 * A tile links only when the link is exact: every selected source that adds to
 * the number must be counted from `orders` (the web-shop mirror is not).
 */
function tileHrefs(sources: OverviewSource[], range: DayRange, filtered: boolean): Partial<Record<TileKey, string | null>> {
  const contributes: Record<Exclude<TileKey, 'unproven_paid' | 'delivered'>, (s: OverviewSource) => number> = {
    placed: (s) => placedOf(s).count,
    confirmed: (s) => s.confirmed,
    at_courier: (s) => s.buckets.courier?.count ?? 0,
    to_collect: (s) => preparingOf(s).count + (s.buckets.courier?.count ?? 0),
    lost: (s) => (s.buckets.returned?.count ?? 0) + (s.buckets.cancelled?.count ?? 0) + (s.buckets.trashed?.count ?? 0),
  };
  const base = (k: keyof typeof contributes): string | null => {
    const inPlay = sources.filter((s) => contributes[k](s) > 0);
    if (!inPlay.length || inPlay.some((s) => !sourceDrill(s, range))) return null;
    return [...new Set(inPlay.flatMap((s) => s.drill.sale_source))].join(',');
  };
  const cr = { created_from: range.from, created_to: range.to };
  const make = (k: keyof typeof contributes, extra: OrdersDrillParams) => {
    const ss = base(k);
    return ss ? ordersHref({ sale_source: ss, ...extra }) : null;
  };
  return {
    placed: make('placed', cr),
    confirmed: make('confirmed', { sold_from: range.from, sold_to: range.to }),
    at_courier: make('at_courier', { ...cr, outcome: 'courier' }),
    // The hero is on the CASH clock and includes MEX-only parcels (not orders): no single list holds it.
    delivered: null,
    to_collect: make('to_collect', { ...cr, outcome: OUTCOME.toCollect }),
    lost: make('lost', { ...cr, outcome: OUTCOME.lost }),
    // Cash clock: paid in the window, no delivered MEX parcel. Whole business only.
    unproven_paid: filtered ? null : ordersHref({ cash_from: range.from, cash_to: range.to, proof: 'unproven' }),
  };
}

function OverviewSkeleton() {
  return (
    <div className="space-y-5" aria-hidden>
      <Skeleton className="h-8 w-2/3" />
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[5fr_9fr]">
        <Skeleton variant="card" className="h-44" />
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} variant="card" className="h-24" />)}
        </div>
      </div>
      {Array.from({ length: 2 }, (_, i) => <Skeleton key={i} variant="card" className="h-64" />)}
    </div>
  );
}
