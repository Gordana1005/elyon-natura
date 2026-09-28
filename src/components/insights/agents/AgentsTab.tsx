import { useCallback, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { AlertTriangle, FlaskConical, UserX } from 'lucide-react';
import { apiGetInsightsAgents, type PeopleResponse } from '@/lib/insightsApi/agents';
import { useAuth } from '@/contexts/AuthContext';
import { apiErrorText } from '@/i18n/apiErrors';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/EmptyState';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { skopjeHm } from '@/lib/presence/state';
import { OVERVIEW_COLOR_VARS } from '../overview/palette';
import { useInsightsPeriod } from '../shared/useInsightsPeriod';
import { useInsightsFormat } from '../shared/useInsightsFormat';
import { LoadError } from '../shared/LoadError';
import type { DayRange } from '../shared/period';
import { AgentsKpis } from './AgentsKpis';
import { BonusBlock } from './BonusBlock';
import { Leaderboards } from './Leaderboards';
import { NoSellerCard } from './NoSellerCard';
import { PeopleTable } from './PeopleTable';
import { PersonDetail } from './PersonDetail';
import { TeamsPanel } from './TeamsPanel';
import { AGENTS_COLOR_VARS } from './palette';
import { teamName } from './parts';
import type { PeopleFilter } from './model';

type FixtureMode = '1' | 'nomoney' | 'self';

/** Strips every *_mkd key (the dev fixture's non-owner view; the UI itself trusts meta.money). */
function stripMoney<T>(v: T): T {
  if (Array.isArray(v)) return v.map(stripMoney) as unknown as T;
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (!/_mkd$/.test(k)) out[k] = stripMoney(x);
    return out as T;
  }
  return v;
}

/**
 * Insights → Агенти: who sold, who worked, how well — people and teams on THE
 * sale cohort (the Overview's numbers, split by person). Owners see денари;
 * admins / managers the same page counted; an agent only themselves.
 *
 * Top to bottom: the credited sales and where they are now + the work KPIs ·
 * teams side by side · leaderboards · everyone in one sortable table (CSV) ·
 * sales with no seller (so the tab ties to the Overview) · the bonus figures
 * as today. A name opens the person drill (their days, what they sell, their
 * orders). Data: GET /insights/agents (+ ?person= for the drill); the bonus
 * block reads GET /agent-performance unchanged. In a DEV build
 * `?agFixture=1|nomoney|self` renders the typed fixture instead.
 */
export default function AgentsTab() {
  const f = useInsightsFormat();
  const { t } = f;
  const { user } = useAuth();
  const period = useInsightsPeriod();
  const range: DayRange = period.range;
  const [sp, setSp] = useSearchParams();
  const raw = import.meta.env.DEV ? sp.get('agFixture') : null;
  const fixture: FixtureMode | null = raw === '1' || raw === 'nomoney' || raw === 'self' ? raw : null;

  // The tab's own filters live in the URL (a tab switch drops them, the period stays).
  const personId = sp.get('ag_person');
  const filter: PeopleFilter = useMemo(() => ({
    search: '',
    teams: (sp.get('ag_team') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    showIdle: sp.get('ag_idle') !== '0',
  }), [sp]);
  const [search, setSearch] = useState('');
  const setParam = useCallback((k: string, v: string | null) => setSp((prev) => {
    const next = new URLSearchParams(prev);
    if (v == null || v === '') next.delete(k); else next.set(k, v);
    return next;
  }, { replace: true }), [setSp]);
  const onFilter = useCallback((next: Partial<PeopleFilter>) => {
    if (next.search !== undefined) setSearch(next.search);
    if (next.teams !== undefined) setParam('ag_team', next.teams.join(','));
    if (next.showIdle !== undefined) setParam('ag_idle', next.showIdle ? null : '0');
  }, [setParam]);
  const openPerson = useCallback((id: string | null) => setParam('ag_person', id), [setParam]);

  const load = useCallback(async (person: string | null, signal?: AbortSignal): Promise<PeopleResponse> => {
    if (import.meta.env.DEV && fixture) {
      const m = await import('./__fixtures__/people.sample.json');
      const d = structuredClone(m.default) as unknown as PeopleResponse;
      const meta = { ...d.meta, prev_from: null, prev_to: null, partial: false, days: 7, generated_at: new Date().toISOString(), access: 'owner' as const, money: true };
      if (fixture === 'self') {
        const me = d.people[0];
        return stripMoney({ meta: { ...meta, access: 'self', money: false }, people: [me], detail: null });
      }
      // the fixture's detail stands in for whichever person is opened
      const withDetail = { ...d, meta, detail: person && d.detail ? { ...d.detail, person_id: person } : null };
      return fixture === 'nomoney' ? stripMoney({ ...withDetail, meta: { ...meta, access: 'counts', money: false } }) : withDetail;
    }
    return apiGetInsightsAgents({ from: range.from, to: range.to, compare: period.compare, person }, signal);
  }, [fixture, range.from, range.to, period.compare]);

  const q = useQuery({
    queryKey: ['insights-agents', user?.id, range.from, range.to, period.compare, fixture],
    queryFn: ({ signal }) => load(null, signal),
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
    retry: 0,
  });
  const data = q.data;
  const money = data?.meta.money === true;
  const self = data?.meta.access === 'self';

  const drillQ = useQuery({
    queryKey: ['insights-agents', user?.id, range.from, range.to, period.compare, fixture, 'person', personId],
    queryFn: ({ signal }) => load(personId, signal),
    enabled: !!personId && !!data && !self,
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
    retry: 0,
  });

  const people = useMemo(() => data?.people ?? [], [data]);
  const teams = useMemo(() => data?.teams ?? [], [data]);
  const teamNames = useMemo(() => new Map(teams.map((tm) => [tm.key, tm.name])), [teams]);
  const teamChips = useMemo(() => teams.map((tm) => ({ key: tm.key, name: tm.name })), [teams]);
  const noSellerRef = useRef<HTMLElement>(null);
  const goNoSeller = () => {
    noSellerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    noSellerRef.current?.focus({ preventScroll: true });
  };

  const cutAt = data?.meta.partial && data.meta.prev_to_end ? skopjeHm(data.meta.prev_to_end) : '';
  const prevLabel = period.compare && data?.meta.prev_from && data.meta.prev_to
    ? (cutAt
      ? t('overview.kpi.vsPrevPartial', { period: f.period(data.meta.prev_from, data.meta.prev_to), time: cutAt })
      : t('overview.kpi.vsPrev', { period: f.period(data.meta.prev_from, data.meta.prev_to) }))
    : null;

  const errorText = (err: unknown) =>
    err instanceof Error && /^HTTP 404$|not found|insights_people/i.test(err.message) ? t('insights.agents.notDeployed') : apiErrorText(err);

  const drillPerson = personId
    ? (drillQ.data?.people.find((p) => p.person_id === personId) ?? people.find((p) => p.person_id === personId) ?? null)
    : null;
  const drillDetail = drillQ.data?.detail && drillQ.data.detail.person_id === personId ? drillQ.data.detail : null;
  const granularity = data?.meta.granularity === 'month' ? 'month' : 'day';

  return (
    <div className={cn('space-y-6', OVERVIEW_COLOR_VARS, AGENTS_COLOR_VARS)}>
      {fixture && (
        <p role="status" className="flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          <FlaskConical className="h-4 w-4 shrink-0" aria-hidden />{t('overview.demoData')}
        </p>
      )}

      {!data ? (
        q.isError ? <LoadError text={errorText(q.error)} onRetry={() => { void q.refetch(); }} /> : <AgentsSkeleton />
      ) : (
        <div aria-busy={q.isFetching} className={cn('space-y-8 transition-opacity duration-200', q.isPlaceholderData && 'opacity-60')}>
          {q.isError && (
            <p role="alert" className="flex items-center gap-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
              <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
              {t('overview.staleError')} {errorText(q.error)}
              <Button variant="ghost" size="sm" className="ml-auto h-6 px-2 text-xs" onClick={() => { void q.refetch(); }}>{t('common.retry')}</Button>
            </p>
          )}
          <Notes data={data} f={f} />

          {self ? (
            data.meta.self_unlinked || people.length === 0 ? (
              <EmptyState icon={<UserX className="h-5 w-5" />} size="sm"
                title={data.meta.self_unlinked ? t('insights.agents.self.unlinked') : t('insights.agents.self.empty')}
                description={data.meta.self_unlinked ? t('insights.agents.self.unlinkedHint') : t('insights.agents.self.emptyHint')} />
            ) : (
              <section aria-labelledby="ag-self-title" className="space-y-3 rounded-xl border bg-card p-4 shadow-sm sm:p-5">
                <h2 id="ag-self-title" className="text-base font-semibold">{t('insights.agents.self.title', { name: people[0].name })}</h2>
                <PersonDetail person={people[0]} detail={data.detail} range={range} money={false} granularity={granularity} f={f} />
              </section>
            )
          ) : data.totals ? (
            <>
              <AgentsKpis data={data} people={people} money={money} prevLabel={prevLabel} onNoSeller={goNoSeller} f={f} />
              <TeamsPanel teams={teams} people={people} range={range} money={money} onPerson={openPerson} f={f} />
              <Leaderboards people={people} money={money} teamNames={teamNames} onPerson={openPerson} f={f} />
              <PeopleTable people={people} teams={teamChips} range={range} money={money}
                filter={{ ...filter, search }} onFilter={onFilter} onPerson={openPerson} f={f} />
              <NoSellerCard ref={noSellerRef} data={data} money={money} f={f} />
            </>
          ) : null}

          <BonusBlock range={range} self={self} f={f} />
        </div>
      )}

      <Sheet open={!!personId && !self} onOpenChange={(o) => { if (!o) openPerson(null); }}>
        <SheetContent side="right" className={cn('w-full overflow-y-auto sm:max-w-2xl', OVERVIEW_COLOR_VARS, AGENTS_COLOR_VARS)}>
          <SheetHeader className="pr-6 text-left">
            <SheetTitle>{drillPerson?.name ?? t('insights.agents.drill.title')}</SheetTitle>
            <SheetDescription>
              {t('insights.agents.drill.subtitle', { period: f.period(range.from, range.to) })}
              {drillPerson ? ` · ${teamName(drillPerson.team_key, teamNames.get(drillPerson.team_key) ?? null, f)}` : ''}
            </SheetDescription>
          </SheetHeader>
          <div className={cn('mt-4 transition-opacity', drillQ.isFetching && 'opacity-60')}>
            {drillPerson ? (
              <PersonDetail person={drillPerson} detail={drillDetail} range={range} money={money} granularity={granularity} f={f} />
            ) : drillQ.isError ? (
              <LoadError text={errorText(drillQ.error)} onRetry={() => { void drillQ.refetch(); }} />
            ) : drillQ.isFetching ? (
              <Skeleton className="h-64 w-full" />
            ) : (
              <p className="text-sm text-muted-foreground">{t('insights.agents.drill.notInPeriod')}</p>
            )}
            {drillPerson && !drillDetail && drillQ.isFetching && <Skeleton className="mt-4 h-40 w-full" />}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

/** What the numbers can and cannot vouch for: presence starts 28.09.2026; the seller stamp's freshness. */
function Notes({ data, f }: { data: PeopleResponse; f: ReturnType<typeof useInsightsFormat> }) {
  const { t } = f;
  const since = data.meta.presence_since;
  const presenceBefore = !since || data.meta.from < since;
  const stamped = data.meta.stamped_at ? skopjeHm(data.meta.stamped_at) : null;
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
      {presenceBefore && (
        <li>{since ? t('insights.agents.notes.presenceSince', { day: f.period(since, since) }) : t('insights.agents.notes.presenceNone')}</li>
      )}
      {stamped && <li>{t('insights.agents.notes.stamped', { time: stamped })}</li>}
      <li>{t('insights.agents.notes.teamRule')}</li>
    </ul>
  );
}

function AgentsSkeleton() {
  return (
    <div className="space-y-5" aria-hidden>
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[5fr_7fr]">
        <Skeleton variant="card" className="h-48" />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} variant="card" className="h-24" />)}
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 2xl:grid-cols-2">
        {Array.from({ length: 2 }, (_, i) => <Skeleton key={i} variant="card" className="h-72" />)}
      </div>
      <Skeleton variant="card" className="h-96" />
    </div>
  );
}
