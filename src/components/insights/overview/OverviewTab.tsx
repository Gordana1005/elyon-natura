import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { AlertTriangle, FlaskConical } from 'lucide-react';
import { apiGetInsightsOverview, type OverviewResponse } from '@/lib/api';
import { apiGetInsightsAgents, type PeopleResponse } from '@/lib/insightsApi/agents';
import { apiGetInsightsSales, type SalesDetail } from '@/lib/insightsApi/sales';
import { useAuth } from '@/contexts/AuthContext';
import { useDeptScope } from '@/contexts/PermissionsContext';
import { scopedKeys } from '@/lib/access';
import { apiErrorText } from '@/i18n/apiErrors';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/EmptyState';
import { cn } from '@/lib/utils';
import { skopjeHm } from '@/lib/presence/state';
import { OVERVIEW_COLOR_VARS, SOURCE_ORDER } from './palette';
import { parseOverviewParams, stripMoney, writeOverviewParams, type DayRange, type OverviewFilters } from './model';
import { FilterBar } from './FilterBar';
import { FreshnessStrip } from './FreshnessStrip';
import { TeamsBoard } from './TeamsBoard';
import { TopProductsCard, TopSellersCard } from './CallCenterTop';
import { AttentionRail } from './AttentionRail';
import { useInsightsPeriod } from '../shared/useInsightsPeriod';
import { useInsightsFormat } from '../shared/useInsightsFormat';
import { CohortBar } from '../shared/CohortBar';
import { LeadsInCard } from '../shared/CohortSecondary';
import { CohortSources } from './CohortSources';
import { QualityRail } from '../shared/QualityRail';
import { LoadError } from '../shared/LoadError';
import { cohortDrill, cohortView, stripCohortMoney } from '../shared/cohortModel';
import type { Cohort, CohortQualityKind } from '../shared/cohortTypes';
import { sortTeams } from '../agents/model';
import { teamName } from '../agents/parts';

type FixtureMode = '1' | 'nomoney';

/** GET /insights/overview embeds the shared sales cohort under `cohort` (the
 *  contract in ../shared/cohortTypes) — null when its RPC failed. */
type OverviewWithCohort = OverviewResponse & { cohort?: Cohort | null };

/** The admin/manager view of a DEV fixture: every money key removed. */
const stripMoneyKeys = <T,>(v: T): T => {
  if (Array.isArray(v)) return v.map(stripMoneyKeys) as unknown as T;
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (!/_(mkd|eur)$/.test(k)) out[k] = stripMoneyKeys(x);
    return out as T;
  }
  return v;
};

/**
 * The connected Overview (Insights → Overview, and the admins' Табла): the call
 * centre on THE sale cohort (owner 02.10.2026) — the sales made in the period,
 * who sold them, which products, the leads, then the teams and the departments.
 * MEX's cash on the delivery-day clock is NOT here (it read as money received
 * the same day, while MEX pays out in lumps): Insights → Наплата (MEX) has it.
 * Owners get money (meta.money); admins/managers get the same page counted,
 * never an empty hole.
 *
 * Data: GET /insights/overview (freshness, the attention rail — and `cohort`,
 * the sales everything else counts) + GET /insights/agents for the sellers and
 * the teams (the Agents tab's own query) + GET /insights/sales?part=detail for
 * the products (the Sales tab's own query). The pre-cohort widgets are gone: the
 * KPI tiles and source rows (created day, CRM status, EUR) — a missing cohort is
 * an error with a retry now, never the old numbers — and the drill-down pivot
 * (DrillPivot.tsx: created day, CRM status, EUR, "no" calls counted as orders,
 * no web / MEX-only; it waits for a rebuild on the cohort and is not drawn).
 * In a DEV build `?ovFixture=1` (or `=nomoney`) renders the typed fixtures
 * instead — the branch and the JSON are compiled out of production builds.
 */
export default function OverviewTab() {
  const f = useInsightsFormat();
  const { t } = f;
  const { user } = useAuth();
  const [sp, setSp] = useSearchParams();
  // The period is the page's one filter bar (shared by every tab); the chips
  // below it — sources, teams — are the Overview's own.
  const period = useInsightsPeriod();
  const chips = useMemo(() => parseOverviewParams(sp, period.today), [sp, period.today]);
  const loginScope = useDeptScope();
  const setFilters = useCallback(
    (next: Partial<OverviewFilters>) => setSp((prev) => writeOverviewParams(prev, next), { replace: true }),
    [setSp],
  );
  const raw = import.meta.env.DEV ? sp.get('ovFixture') : null;
  const fixture: FixtureMode | null = raw === '1' || raw === 'nomoney' ? raw : null;

  const load = useCallback(async (r: DayRange, compare: boolean, signal?: AbortSignal): Promise<OverviewWithCohort> => {
    if (import.meta.env.DEV && fixture) {
      const m = await import('./__fixtures__/overview.sample.json');
      const c = await import('../shared/__fixtures__/cohort.sample.json');
      const d = structuredClone(m.default) as unknown as OverviewWithCohort;
      const cohort = structuredClone(c.default) as unknown as Cohort;
      if (fixture === 'nomoney') return { ...stripMoney(d), cohort: stripCohortMoney(cohort) };
      return { ...d, cohort };
    }
    return apiGetInsightsOverview({ from: r.from, to: r.to, compare }, signal);
  }, [fixture]);

  // ONE request per view: the cohort carries its own previous period, so a
  // department filter needs no second Overview for the previous span.
  const q = useQuery({
    queryKey: ['insights-overview', user?.id, period.range.from, period.range.to, period.compare, fixture],
    queryFn: ({ signal }) => load(period.range, period.compare, signal),
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
    retry: 0,
  });
  const data = q.data;

  // A dept_admin (access levels, 20260947001600) is locked to their departments: the chips
  // offer only those, and a link carrying another department's chip drops it. The payload's
  // meta.dept_scope wins once it is here; before that the login's own scope.
  const dataScope = data?.meta.dept_scope ?? data?.cohort?.meta?.dept_scope ?? null;
  const scopeKey = (dataScope ?? loginScope)?.join(',') ?? null;
  const scope = useMemo(
    () => scopedKeys(SOURCE_ORDER, scopeKey === null ? null : scopeKey.split(',').filter(Boolean)),
    [scopeKey],
  );
  const filters: OverviewFilters = useMemo(() => ({
    preset: period.preset, range: period.range, compare: period.compare,
    sources: scope ? chips.sources.filter((k) => scope.includes(k)) : chips.sources,
    teams: chips.teams,
  }), [period.preset, period.range, period.compare, chips.sources, chips.teams, scope]);

  // The teams are the Agents tab's (GET /insights/agents): the SAME query key as
  // AgentsTab, so the two share one cache entry and show the same numbers.
  const loadAgents = useCallback(async (r: DayRange, compare: boolean, signal?: AbortSignal): Promise<PeopleResponse> => {
    if (import.meta.env.DEV && fixture) {
      const m = await import('../agents/__fixtures__/people.sample.json');
      const d = structuredClone(m.default) as unknown as PeopleResponse;
      const meta = { ...d.meta, access: 'owner' as const, money: true };
      return fixture === 'nomoney'
        ? stripMoneyKeys({ ...d, meta: { ...meta, access: 'counts' as const, money: false } })
        : { ...d, meta };
    }
    return apiGetInsightsAgents({ from: r.from, to: r.to, compare }, signal);
  }, [fixture]);
  const agentsQ = useQuery({
    queryKey: ['insights-agents', user?.id, filters.range.from, filters.range.to, filters.compare, fixture ? `ov-${fixture}` : null],
    queryFn: ({ signal }) => loadAgents(filters.range, filters.compare, signal),
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
    retry: 0,
  });

  // The top products are the Sales tab's (GET /insights/sales?part=detail): the SAME
  // query key as SalesTab, so the two share one cache entry and show the same numbers.
  const loadSalesDetail = useCallback(async (r: DayRange, signal?: AbortSignal): Promise<SalesDetail> => {
    if (import.meta.env.DEV && fixture) {
      const m = await import('../sales/__fixtures__/sales.detail.sample.json');
      const d = structuredClone(m.default) as unknown as SalesDetail;
      return fixture === 'nomoney' ? stripMoneyKeys({ ...d, meta: { ...d.meta, money: false } }) : d;
    }
    return apiGetInsightsSales({ from: r.from, to: r.to, part: 'detail' }, signal);
  }, [fixture]);
  const productsQ = useQuery({
    queryKey: ['insights-sales', user?.id, filters.range.from, filters.range.to, 'detail', fixture ? `ov-${fixture}` : null],
    queryFn: ({ signal }) => loadSalesDetail(filters.range, signal),
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
    retry: 0,
  });

  // Which departments are in view: null = every department (no chip on).
  const sourcesInView = useMemo(
    () => (filters.sources.length ? SOURCE_ORDER.filter((k) => filters.sources.includes(k)) : null),
    [filters.sources],
  );

  const money = data?.meta.money === true;

  // The shared sales cohort (one total, parts that add up).
  const cohort = data?.cohort ?? null;
  const cohortMoney = money && cohort?.meta?.money !== false;
  const cv = useMemo(() => (cohort ? cohortView(cohort, filters.sources) : null), [cohort, filters.sources]);
  // The hero's sparkline: sales per sale day (денари for owners, counts otherwise) —
  // the whole business only.
  const cohortSpark = useMemo(
    () => (cohort && cv && !cv.filtered
      ? (cohort.spark ?? []).map((p) => ({ d: p.d, v: cohortMoney && p.value_mkd != null ? p.value_mkd : p.count }))
      : null),
    [cohort, cv, cohortMoney],
  );
  // A quality card opens a list only when /orders holds exactly its rows.
  const qualityHref = (kind: CohortQualityKind): string | null =>
    kind === 'unproven_paid' && cv ? cohortDrill(cv.rows, 'paid_unproven', filters.range).href : null;

  // Team chips, and the people behind them for the attention rail, from the Agents payload.
  const agentTeams = useMemo(() => sortTeams(agentsQ.data?.teams ?? []), [agentsQ.data]);
  const teamChips = useMemo(() => agentTeams.map((tm) => ({ key: tm.key, name: teamName(tm.key, tm.name, f) })), [agentTeams, f]);
  const teamPeople = useMemo(
    () => (filters.teams.length && agentTeams.length
      ? new Set(agentTeams.filter((tm) => filters.teams.includes(tm.key)).flatMap((tm) => tm.members.map((m) => m.person_id)))
      : null),
    [agentTeams, filters.teams],
  );

  const cutAt = data?.meta.partial && data.meta.prev_to_end ? skopjeHm(data.meta.prev_to_end) : '';
  const prevLabel = filters.compare && data?.meta.prev_from && data.meta.prev_to
    ? (cutAt
      ? t('overview.kpi.vsPrevPartial', { period: f.period(data.meta.prev_from, data.meta.prev_to), time: cutAt })
      : t('overview.kpi.vsPrev', { period: f.period(data.meta.prev_from, data.meta.prev_to) }))
    : null;

  const errorText = (err: unknown) =>
    err instanceof Error && /^HTTP 404$|not found/i.test(err.message) ? t('overview.notDeployed') : apiErrorText(err);

  return (
    <div className={cn('space-y-5', OVERVIEW_COLOR_VARS)}>
      {fixture && (
        <p role="status" className="flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          <FlaskConical className="h-4 w-4 shrink-0" aria-hidden />{t('overview.demoData')}
        </p>
      )}

      <FilterBar filters={filters} onChange={setFilters} teams={teamChips} f={f} sourceKeys={scope ?? SOURCE_ORDER} />

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
          {cohort && cv ? (
            // The call centre first (owner 02.10.2026): this period's sales and
            // where each one is now — the parts add up to the total — then who
            // sold them, what was sold and the leads that came in. MEX's cash
            // (the delivery-day clock) is not on this page: it lives on its own
            // tab, Insights → Наплата (MEX), next to MEX's payouts.
            <div className="space-y-4">
              <CohortBar
                title={t('overview.cohort.title', { period: f.period(filters.range.from, filters.range.to) })}
                total={cv.total} buckets={cv.buckets} outside={cv.outside} money={cohortMoney}
                rows={cv.rows} range={filters.range}
                prev={filters.compare && !cv.filtered ? cohort.prev?.total ?? null : null}
                prevLabel={filters.compare && !cv.filtered ? prevLabel : null}
                spark={cohortSpark}
                note={cv.filtered ? t('insights.common.cohort.filtered') : null}
                f={f}
              />
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,0.9fr)]">
                <TopSellersCard q={agentsQ} teamKeys={filters.teams} sources={sourcesInView} f={f} />
                <TopProductsCard q={productsQ} sources={sourcesInView} f={f} />
                <LeadsInCard leads={cv.leads_in} f={f} className="lg:col-span-2 xl:col-span-1" />
              </div>
            </div>
          ) : (
            // The cohort failed (the api answers `cohort: null`): say so and offer
            // a retry — the pre-cohort tiles (created day, CRM status, EUR) never
            // stand in for it.
            <LoadError text={t('overview.cohort.loadFailed')} onRetry={() => { void q.refetch(); }} />
          )}
          <TeamsBoard q={agentsQ} teamKeys={filters.teams} range={filters.range} canTvLink={!!(user?.isAdmin || user?.isManager)} f={f} />
          {/* Per department: cards on the same cohort (the table twin is one toggle away). */}
          {cohort && cv && (
            <CohortSources rows={cv.rows} total={cv.total} leadsTotal={cv.leads_in} money={cohortMoney} range={filters.range} f={f} />
          )}
          {/* The drill-down table (DrillPivot.tsx) is not drawn: it counts orders by
              created day on CRM status in EUR, "no" calls as orders, and misses web and
              MEX-only sales. It waits for a rebuild on the cohort (insights_sale_rows). */}
          {cohort && <QualityRail items={cohort.quality} money={cohortMoney} hrefFor={qualityHref} f={f} />}
          <AttentionRail items={data.attention ?? []} money={money} teamPeople={teamPeople} f={f} />
        </div>
      )}
    </div>
  );
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
