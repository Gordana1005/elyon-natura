import { useCallback, useMemo, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  AlertTriangle, Ban, CalendarClock, Coins, FlaskConical, Info, MapPin, Package, PhoneCall, RotateCcw, Route, Timer,
  Truck, Undo2, UserRound, ListChecks, type LucideIcon,
} from 'lucide-react';
import {
  apiGetInsightsReturns, type ReturnsClock, type ReturnsResponse, type ReturnsSourceRow,
} from '@/lib/insightsApi/returnsStock';
import { useAuth } from '@/contexts/AuthContext';
import { useDeptScope } from '@/contexts/PermissionsContext';
import { scopedKeys } from '@/lib/access';
import { apiErrorText } from '@/i18n/apiErrors';
import { cancelReasonLabel } from '@/lib/cancellationReasons';
import { trashReasonLabel } from '@/lib/trashReasons';
import { predictionListLabel } from '@/lib/predictionListLabel';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/EmptyState';
import { cn } from '@/lib/utils';
import { skopjeHm } from '@/lib/presence/state';
import { OVERVIEW_COLOR_VARS, SOURCE_ORDER, sourceColorVar } from '../overview/palette';
import { FilterBar } from '../overview/FilterBar';
import { DrillLink } from '../overview/DrillLink';
import { parseOverviewParams, writeOverviewParams, type OverviewFilters } from '../overview/model';
import { dm } from '../overview/useOverviewFormat';
import { ClockCaption } from '../shared/ClockCaption';
import { StackedBar } from '../shared/StackedBar';
import { COHORT_TONE, OUTSIDE_TONE, STATUS_TEXT } from '../shared/cohortPalette';
import { dropEmptyManagement } from '../shared/cohortTypes';
import { useInsightsFormat, type InsightsFormat } from '../shared/useInsightsFormat';
import { useInsightsPeriod } from '../shared/useInsightsPeriod';
import type { DayRange } from '../shared/period';
import {
  BarList, CountLink, DayColumns, RateTable, Section, ShareBar, Tile, dec1, type RateRowView,
} from './RsBits';
import { cityName, MIN_RATE_BASE, ratePp, returnsColumns, rsDrill } from './returnsModel';

type FixtureMode = '1' | 'nomoney';

/** The URL param of the clock (absent = the cohort). */
export const RETURNS_CLOCK_PARAM = 'rclock';

/** The admin/manager view of a payload: every `*_mkd` key removed (dev fixture + tests). */
export function stripReturnsMoney(d: ReturnsResponse): ReturnsResponse {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) if (!/_(mkd|eur)$/.test(k)) out[k] = walk(x);
      return out;
    }
    return v;
  };
  const s = walk(d) as ReturnsResponse;
  s.meta = { ...s.meta, money: false };
  return s;
}

/**
 * Insights → Враќања: what came back, from where, and what it cost.
 *
 * Two clocks, one toggle: the cohort (the period's sales and how many of them
 * came back SO FAR — ties to the Overview's "Вратено" part) and the MEX return
 * day (what physically came back in the period — ties to the MEX register).
 * Cancelled / trashed after the sale and parcels "rejected" at the door (still
 * at the courier) are shown apart, never as returns. Owners see денари
 * (meta.money); admins/managers the same page counted.
 *
 * Data: GET /insights/returns (migration 20260941000500). In a DEV build
 * `?rtFixture=1` (or `=nomoney`) renders the typed fixture instead.
 */
export default function ReturnsTab() {
  const f = useInsightsFormat();
  const { t } = f;
  const { user } = useAuth();
  const [sp, setSp] = useSearchParams();
  const period = useInsightsPeriod();
  const range = period.range;
  const clock: ReturnsClock = sp.get(RETURNS_CLOCK_PARAM) === 'returned' ? 'returned' : 'sale';
  const chips = useMemo(() => parseOverviewParams(sp, period.today), [sp, period.today]);
  // A dept_admin (access levels, 20260947001600) is locked to their departments: the chips offer
  // only those and a link's other departments are dropped (the api forces the same scope).
  const scope = scopedKeys(SOURCE_ORDER, useDeptScope());
  const scopeKey = scope?.join(',') ?? '';
  const sources = useMemo(
    () => (scope ? chips.sources.filter((k) => scope.includes(k)) : chips.sources),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chips.sources, scopeKey],
  );
  const filters: OverviewFilters = useMemo(() => ({
    preset: period.preset, range, compare: period.compare, sources, teams: [],
  }), [period.preset, range, period.compare, sources]);
  const setFilters = useCallback(
    (next: Partial<OverviewFilters>) => setSp((prev) => writeOverviewParams(prev, next), { replace: true }),
    [setSp],
  );
  const setClock = (c: ReturnsClock) => setSp((prev) => {
    const n = new URLSearchParams(prev);
    if (c === 'sale') n.delete(RETURNS_CLOCK_PARAM); else n.set(RETURNS_CLOCK_PARAM, c);
    return n;
  }, { replace: true });

  const raw = import.meta.env.DEV ? sp.get('rtFixture') : null;
  const fixture: FixtureMode | null = raw === '1' || raw === 'nomoney' ? raw : null;
  const load = useCallback(async (signal?: AbortSignal): Promise<ReturnsResponse> => {
    if (import.meta.env.DEV && fixture) {
      const m = clock === 'sale'
        ? await import('./__fixtures__/returns.sample.json')
        : await import('./__fixtures__/returns.mex.sample.json');
      const d = structuredClone(m.default) as unknown as ReturnsResponse;
      return fixture === 'nomoney' ? stripReturnsMoney(d) : d;
    }
    return apiGetInsightsReturns({ from: range.from, to: range.to, compare: period.compare, sources, clock }, signal);
  }, [fixture, clock, range.from, range.to, period.compare, sources]);

  const q = useQuery({
    queryKey: ['insights-returns', user?.id, range.from, range.to, period.compare, sources.join(','), clock, fixture],
    queryFn: ({ signal }) => load(signal),
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
    retry: 0,
  });
  const data = q.data;
  const money = data?.meta.money === true;
  // The chips: the login's scope, else the payload's (meta.dept_scope), else all seven.
  const chipKeys = scope ?? scopedKeys(SOURCE_ORDER, data?.meta.dept_scope) ?? SOURCE_ORDER;
  const errorText = (err: unknown) =>
    err instanceof Error && /^HTTP 404$|not found/i.test(err.message) ? t('insights.returns.notDeployed') : apiErrorText(err);

  return (
    <div className={cn('space-y-5', OVERVIEW_COLOR_VARS)}>
      {fixture && (
        <p role="status" className="flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          <FlaskConical className="h-4 w-4 shrink-0" aria-hidden />{t('overview.demoData')}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1"><FilterBar filters={filters} onChange={setFilters} teams={[]} f={f} sourceKeys={chipKeys} /></div>
        <ClockToggle clock={clock} onChange={setClock} f={f} />
      </div>

      {!data ? (
        q.isError ? (
          <EmptyState
            icon={<AlertTriangle className="h-5 w-5" />}
            title={t('insights.loadFailed')}
            description={errorText(q.error)}
            size="sm"
            action={<Button variant="outline" size="sm" onClick={() => { void q.refetch(); }}>{t('common.retry')}</Button>}
          />
        ) : <ReturnsSkeleton />
      ) : (
        // Refetch keeps the frame: the previous numbers stay, dimmed, no skeleton.
        <div aria-busy={q.isFetching} className={cn('space-y-6 transition-opacity duration-200', q.isPlaceholderData && 'opacity-60')}>
          {q.isError && (
            <p role="alert" className="flex items-center gap-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
              <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
              {t('overview.staleError')} {errorText(q.error)}
              <Button variant="ghost" size="sm" className="ml-auto h-6 px-2 text-xs" onClick={() => { void q.refetch(); }}>{t('common.retry')}</Button>
            </p>
          )}
          {data.kpis.base.count === 0 && data.kpis.returned.count === 0 ? (
            <EmptyState icon={<Undo2 className="h-5 w-5" />} title={t('insights.returns.emptyTitle')}
              description={t(clock === 'sale' ? 'insights.returns.emptySale' : 'insights.returns.emptyMex')} size="sm" />
          ) : (
            <ReturnsBody data={data} clock={clock} money={money} range={range} sources={sources} compare={period.compare} f={f} />
          )}
        </div>
      )}
    </div>
  );
}

function ClockToggle({ clock, onChange, f }: { clock: ReturnsClock; onChange: (c: ReturnsClock) => void; f: InsightsFormat }) {
  const { t } = f;
  const opt = (c: ReturnsClock, label: string, hint: string) => (
    <button
      type="button"
      role="radio"
      aria-checked={clock === c}
      title={hint}
      onClick={() => onChange(c)}
      className={cn('inline-flex h-8 items-center rounded-full px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        clock === c ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground')}
    >
      {label}
    </button>
  );
  return (
    <div role="radiogroup" aria-label={t('insights.returns.clock.label')} className="inline-flex shrink-0 items-center gap-0.5 rounded-full border bg-card p-0.5 shadow-sm">
      {opt('sale', t('insights.returns.clock.sale'), t('insights.returns.clock.saleHint'))}
      {opt('returned', t('insights.returns.clock.returned'), t('insights.returns.clock.returnedHint'))}
    </div>
  );
}

function ReturnsBody({ data, clock, money, range, sources, compare, f }: {
  data: ReturnsResponse; clock: ReturnsClock; money: boolean; range: DayRange; sources: string[]; compare: boolean; f: InsightsFormat;
}) {
  const { t, lang } = f;
  const k = data.kpis;
  const sale = clock === 'sale';
  const clockKey = sale ? 'sale' : 'returned';
  const baseLabel = t(sale ? 'insights.returns.col.sales' : 'insights.returns.col.finished');
  const drill = (bucket: Parameters<typeof rsDrill>[0]['bucket'], comp: Parameters<typeof rsDrill>[0]['comp'], count: number,
    extra?: Record<string, string | null | undefined>, srcs: string[] = sources) =>
    rsDrill({ clock, bucket, comp, count, sources: srcs, range, extra });
  const retDrill = drill('returned', k.returned, k.returned.count);

  const pp = compare && k.prev ? ratePp(k.rate, k.prev.rate) : null;
  const cutAt = data.meta.partial && data.meta.prev_to_end ? skopjeHm(data.meta.prev_to_end) : '';
  const prevLabel = compare && data.meta.has_prev && data.meta.prev_from && data.meta.prev_to
    ? (cutAt
      ? t('overview.kpi.vsPrevPartial', { period: f.period(data.meta.prev_from, data.meta.prev_to), time: cutAt })
      : t('overview.kpi.vsPrev', { period: f.period(data.meta.prev_from, data.meta.prev_to) }))
    : null;

  // the period's sales (or what finished) split: closed · still open · returned
  const openN = sale ? k.open?.count ?? 0 : 0;
  const closedN = Math.max(0, k.base.count - k.returned.count - openN);
  const segText = (label: string, n: number) => `${label} · ${f.int(n)} (${f.share(n, k.base.count)})`;
  const segments = [
    { key: 'closed', weight: closedN, tone: COHORT_TONE.paid, text: segText(t(sale ? 'insights.returns.part.closedSale' : 'insights.returns.part.delivered'), closedN) },
    ...(sale ? [{ key: 'open', weight: openN, tone: COHORT_TONE.to_pack, text: segText(t('insights.returns.part.open'), openN) }] : []),
    { key: 'returned', weight: k.returned.count, tone: COHORT_TONE.returned, text: segText(t('insights.returns.part.returned'), k.returned.count), href: retDrill.href },
  ];
  const columns = useMemo(() => returnsColumns(data.trend, clock), [data.trend, clock]);

  return (
    <div className="space-y-6">
      {/* ── the hero: how many came back, of what ─────────────────────── */}
      <section aria-labelledby="rt-hero" className="space-y-3 rounded-xl border bg-card p-4 shadow-sm sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
          <div className="min-w-0 space-y-0.5">
            <h2 id="rt-hero" className="text-sm font-medium text-muted-foreground">
              {t(sale ? 'insights.returns.hero.titleSale' : 'insights.returns.hero.titleMex', { period: f.period(range.from, range.to) })}
            </h2>
            <ClockCaption clock={clockKey} />
            {sources.length > 0 && sources.length < 4 && <p className="text-[11px] font-medium text-muted-foreground">{t('insights.common.cohort.filtered')}</p>}
          </div>
          {prevLabel && <span className="text-[11px] tabular-nums text-muted-foreground">{prevLabel}</span>}
        </div>
        <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
          <div className="space-y-1">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <CountLink drill={retDrill} label={`${t('insights.returns.part.returned')}: ${f.int(k.returned.count)}`} f={f}
                className={cn('text-[clamp(2rem,7vw,3rem)] font-semibold leading-none tracking-tight tabular-nums', STATUS_TEXT.returned)}>
                {f.int(k.returned.count)}
              </CountLink>
              <span className="text-sm text-muted-foreground">
                {t(sale ? 'insights.returns.hero.ofSales' : 'insights.returns.hero.ofFinished', { n: f.int(k.base.count), pct: f.pct(k.rate) })}
              </span>
              <PpBadge pp={pp} f={f} />
            </div>
            <p className="text-[11px] tabular-nums text-muted-foreground">
              {t('insights.common.cohort.composition', { orders: f.int(k.returned.orders), web: f.int(k.returned.web), mex: f.int(k.returned.mex_only) })}
            </p>
          </div>
          {money && k.returned.value_mkd != null && (
            <div className="space-y-0.5">
              <p className="text-[11px] font-medium text-muted-foreground">{t('insights.returns.hero.uncollected')}</p>
              <p className="text-xl font-semibold tabular-nums">{f.den(k.returned.value_mkd)}</p>
            </div>
          )}
        </div>
        <StackedBar segments={segments} label={t('insights.returns.hero.barLabel')} className="h-4" />
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
          {segments.map((s) => (
            <li key={s.key} className="inline-flex items-center gap-1">
              <span className={cn('h-2.5 w-2.5 rounded-full', s.tone)} aria-hidden />{s.text}
            </li>
          ))}
        </ul>
        {sale && (k.open?.share ?? 0) >= 0.05 && (
          <p className="flex items-start gap-1.5 rounded-lg bg-muted/50 px-2.5 py-1.5 text-[11px] leading-snug text-muted-foreground">
            <Info className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
            {t('insights.returns.hero.soFar', { n: f.int(openN), pct: f.pct(k.open?.share ?? 0, 0) })}
          </p>
        )}
      </section>

      {/* ── the tiles ─────────────────────────────────────────────────── */}
      <ul className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Tile icon={RotateCcw} label={t(sale ? 'insights.returns.tile.rateSale' : 'insights.returns.tile.rateMex')}
          value={f.pct(k.rate)}
          sub={k.prev ? t('insights.returns.tile.prevRate', { pct: f.pct(k.prev.rate), n: f.int(k.prev.returned) }) : undefined} />
        {money && k.returned.value_mkd != null ? (
          <Tile icon={Coins} label={t('insights.returns.tile.uncollected')} value={f.den(k.returned.value_mkd)}
            sub={t('insights.returns.tile.uncollectedSub')} />
        ) : k.round_trip ? (
          <Tile icon={Package} label={t('insights.returns.tile.parcels')} value={f.int(k.round_trip.parcels)}
            sub={t('insights.returns.tile.parcelsSub')} />
        ) : null}
        {/* The round trip is a margin figure: absent for administrators / dept_admins / managers. */}
        {money && k.round_trip && k.round_trip.loss_mkd != null && (
          <Tile icon={Route} label={t('insights.returns.tile.roundTrip')} value={f.den(k.round_trip.loss_mkd)}
            sub={t('insights.returns.tile.roundTripSub', {
              rate: f.den(k.round_trip.return_cost_mkd ?? 0),
              outbound: f.den(k.round_trip.outbound_if_billed_mkd ?? 0),
              per: f.den(k.round_trip.deliver_cost_mkd ?? 0),
            })} />
        )}
        <ProblemTile data={data} clock={clock} drill={sale && k.problem ? drill('courier_problem', k.problem, k.problem.count) : null} money={money} f={f} />
        <Tile icon={Ban} label={t('insights.returns.tile.cancelledAfter')}
          value={
            <CountLink
              drill={sale ? drill('cancelled_after_sale', { orders: k.cancelled_after_sale.count }, k.cancelled_after_sale.count) : rsDrill({ clock, bucket: 'cancelled_after_sale', comp: null, count: 0, sources, range })}
              label={`${t('insights.returns.tile.cancelledAfter')}: ${f.int(k.cancelled_after_sale.count)}`} f={f}>
              <span className="inline-flex items-center gap-1.5">
                <span className={cn('h-2.5 w-2.5 rounded-full', OUTSIDE_TONE.cancelled_after_sale)} aria-hidden />
                {f.int(k.cancelled_after_sale.count)}
              </span>
            </CountLink>
          }
          sub={<>
            {money && k.cancelled_after_sale.value_mkd != null && <>{f.den(k.cancelled_after_sale.value_mkd)} · </>}
            {t('insights.returns.tile.trashedAfter', { n: f.int(k.trashed_after_sale.count) })}
            <span className="block">{t(sale ? 'insights.returns.tile.cancelledSale' : 'insights.returns.tile.cancelledDecided')}</span>
          </>} />
        <Tile icon={Timer} label={t('insights.returns.tile.daysToReturn')}
          value={data.days_to_return.median_from_sale != null ? t('insights.returns.daysN', { n: dec1(f, data.days_to_return.median_from_sale) }) : '—'}
          sub={data.days_to_return.median_at_courier != null
            ? t('insights.returns.tile.atCourier', { n: dec1(f, data.days_to_return.median_at_courier) })
            : undefined} />
      </ul>

      {/* ── by source ─────────────────────────────────────────────────── */}
      {/* an empty Менаџмент row is not written (owner 02.10.2026: only "ако има нешто") */}
      <SourceReturns rows={dropEmptyManagement(data.by_source, (r) => r.base === 0 && r.returned === 0 && r.open === 0)}
        clock={clock} money={money} range={range} baseLabel={baseLabel} f={f} />

      {/* ── trend ─────────────────────────────────────────────────────── */}
      <Section title={t(sale ? 'insights.returns.trend.titleSale' : 'insights.returns.trend.titleMex')} clock={clockKey}
        sub={sale ? t('insights.returns.trend.subSale') : undefined}>
        <DayColumns
          columns={columns}
          granularity={data.meta.granularity}
          label={t(sale ? 'insights.returns.trend.titleSale' : 'insights.returns.trend.titleMex')}
          parts={[
            { key: 'closed', label: t(sale ? 'insights.returns.part.closedSale' : 'insights.returns.part.delivered'), tone: COHORT_TONE.paid },
            ...(sale ? [{ key: 'open', label: t('insights.returns.part.open'), tone: COHORT_TONE.to_pack }] : []),
            { key: 'returned', label: t('insights.returns.part.returned'), tone: COHORT_TONE.returned },
          ]}
          f={f}
        />
      </Section>

      {/* ── what, where ───────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <Section title={t('insights.returns.product.title')} clock={clockKey} sub={t('insights.returns.product.sub')}
          right={<Package className="h-4 w-4 text-muted-foreground" aria-hidden />}>
          <RateTable
            rows={[
              ...data.by_product.rows.map<RateRowView>((r) => ({
                key: r.key, base: r.sold_units, returned: r.returned_units, rate: r.rate,
                name: <>{r.name ?? '—'}{!r.catalogue && <span className="ml-1 rounded bg-muted px-1 text-[10px] font-normal text-muted-foreground" title={t('insights.returns.product.notInCatalogueHint')}>{t('insights.returns.product.notInCatalogue')}</span>}</>,
              })),
              ...(data.by_product.others && data.by_product.others.products > 0 ? [{
                key: '__others__', muted: true,
                name: t('insights.returns.product.others', { n: f.int(data.by_product.others.products) }),
                base: data.by_product.others.sold_units, returned: data.by_product.others.returned_units,
                rate: data.by_product.others.sold_units > 0 ? data.by_product.others.returned_units / data.by_product.others.sold_units : null,
              }] : []),
            ]}
            baseLabel={t('insights.returns.col.soldUnits')} returnedLabel={t('insights.returns.col.returnedUnits')}
            money={false} tone={COHORT_TONE.returned} minBase={MIN_RATE_BASE} f={f}
            footer={<ProductFooter data={data} sale={sale} f={f} />}
          />
        </Section>
        <Section title={t('insights.returns.city.title')} clock={clockKey}
          sub={t('insights.returns.city.sub', { n: f.int(data.by_city.places) })}
          right={<MapPin className="h-4 w-4 text-muted-foreground" aria-hidden />}>
          <RateTable
            rows={[
              ...data.by_city.rows.map<RateRowView>((r) => ({
                key: r.key, name: cityName(r, lang), base: r.base, returned: r.returned, rate: r.rate, value_mkd: r.value_mkd,
              })),
              ...(data.by_city.others && data.by_city.others.base > 0 ? [{
                key: '__others__', muted: true, name: t('insights.returns.city.others', { n: f.int(data.by_city.others.places) }),
                base: data.by_city.others.base, returned: data.by_city.others.returned, value_mkd: data.by_city.others.value_mkd,
                rate: data.by_city.others.base > 0 ? data.by_city.others.returned / data.by_city.others.base : null,
              }] : []),
              ...(data.by_city.unknown && data.by_city.unknown.base > 0 ? [{
                key: '__unknown__', muted: true, name: t('insights.common.sentinel.unknown'),
                base: data.by_city.unknown.base, returned: data.by_city.unknown.returned, value_mkd: data.by_city.unknown.value_mkd,
                rate: data.by_city.unknown.base > 0 ? data.by_city.unknown.returned / data.by_city.unknown.base : null,
              }] : []),
            ]}
            baseLabel={baseLabel} returnedLabel={t('insights.returns.col.returned')}
            money={money} tone={COHORT_TONE.returned} minBase={MIN_RATE_BASE} f={f}
          />
        </Section>
      </div>

      {/* ── who ───────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <Section title={t('insights.returns.person.title')} clock={clockKey} sub={t('insights.returns.person.sub')}
          right={<UserRound className="h-4 w-4 text-muted-foreground" aria-hidden />}>
          <RateTable
            rows={[
              ...data.by_person.rows.map<RateRowView>((r) => ({
                key: r.person_id, name: r.name ?? t('insights.common.sentinel.unknown'), base: r.base, returned: r.returned,
                rate: r.rate, value_mkd: r.value_mkd,
                drill: drill('returned', { orders: r.returned }, r.returned, { sold_by_person_id: r.person_id }),
              })),
              ...(data.by_person.others && data.by_person.others.base > 0 ? [{
                key: '__others__', muted: true, name: t('insights.returns.person.others', { n: f.int(data.by_person.others.people) }),
                base: data.by_person.others.base, returned: data.by_person.others.returned, value_mkd: data.by_person.others.value_mkd,
                rate: data.by_person.others.base > 0 ? data.by_person.others.returned / data.by_person.others.base : null,
              }] : []),
              ...(data.by_person.none && data.by_person.none.base > 0 ? [{
                key: '__none__', muted: true, name: t('insights.returns.person.none'),
                base: data.by_person.none.base, returned: data.by_person.none.returned, value_mkd: data.by_person.none.value_mkd,
                rate: data.by_person.none.base > 0 ? data.by_person.none.returned / data.by_person.none.base : null,
              }] : []),
            ]}
            baseLabel={baseLabel} returnedLabel={t('insights.returns.col.returned')}
            money={money} tone={COHORT_TONE.returned} minBase={MIN_RATE_BASE} f={f}
          />
        </Section>
        <Section title={t('insights.returns.list.title')} clock={clockKey} sub={t('insights.returns.list.sub')}
          right={<ListChecks className="h-4 w-4 text-muted-foreground" aria-hidden />}>
          <RateTable
            rows={data.by_list.map<RateRowView>((r) => ({
              key: r.list_id, name: r.name ? predictionListLabel(r.name) : t('insights.common.sentinel.unknown'),
              hint: r.name ?? undefined, base: r.base, returned: r.returned, rate: r.rate, value_mkd: r.value_mkd,
              drill: r.name ? drill('returned', { orders: r.returned }, r.returned, { prediction_list: r.name }, ['elyon_crm']) : null,
            }))}
            baseLabel={baseLabel} returnedLabel={t('insights.returns.col.returned')}
            money={money} tone={COHORT_TONE.returned} minBase={MIN_RATE_BASE} f={f}
            empty={t('insights.returns.list.empty')}
          />
        </Section>
      </div>

      {/* ── when, how long, which account ─────────────────────────────── */}
      <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
        <Section title={t('insights.returns.dow.title')} clock="sale" sub={t('insights.returns.dow.sub')}
          right={<CalendarClock className="h-4 w-4 text-muted-foreground" aria-hidden />}>
          <BarList
            tone={COHORT_TONE.returned}
            f={f}
            rows={data.by_weekday.map((d) => ({
              key: String(d.dow), label: t(`insights.returns.dow.d${d.dow}`), value: d.rate ?? 0,
              display: f.pct(d.rate), sub: `${f.int(d.returned)}/${f.int(d.base)}`,
            }))}
          />
        </Section>
        <Section title={t('insights.returns.days.title')} clock={clockKey}
          sub={t('insights.returns.days.sub', { n: f.int(data.days_to_return.count) })}
          right={<Timer className="h-4 w-4 text-muted-foreground" aria-hidden />}>
          <BarList
            tone={COHORT_TONE.returned}
            f={f}
            rows={data.days_to_return.bins.map((b) => ({
              key: b.key, label: t(`insights.returns.days.bin.${b.key}`), value: b.count,
              display: f.int(b.count), sub: f.share(b.count, data.days_to_return.count),
            }))}
          />
        </Section>
        <Section title={t('insights.returns.account.title')} clock={clockKey} sub={t('insights.returns.account.sub')}
          right={<Truck className="h-4 w-4 text-muted-foreground" aria-hidden />}>
          <RateTable
            rows={data.by_account.map<RateRowView>((a) => ({
              key: a.key, name: t(`insights.returns.account.${a.key === '__none__' ? 'none' : a.key}`, { defaultValue: a.key }),
              base: a.base, returned: a.returned, rate: a.rate, value_mkd: a.value_mkd, muted: a.key === '__none__',
            }))}
            baseLabel={baseLabel} returnedLabel={t('insights.returns.col.returned')}
            money={money} tone={COHORT_TONE.returned} f={f}
          />
        </Section>
      </div>

      {/* ── cancelled after the sale · the same phone again ──────────── */}
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <Reasons data={data} clock={clock} money={money} f={f} />
        <Repeaters data={data} clock={clock} f={f} />
      </div>

      <ReturnsNotes data={data} clock={clock} f={f} />
    </div>
  );
}

/** "+2,3 п.п." — a rate's change in percentage points; up is bad for returns. */
function PpBadge({ pp, f }: { pp: number | null; f: InsightsFormat }) {
  if (pp == null) return null;
  const tone = pp > 0 ? STATUS_TEXT.critical : pp < 0 ? STATUS_TEXT.good : STATUS_TEXT.neutral;
  const shown = dec1(f, Math.abs(pp));
  return (
    <span className={cn('text-xs font-semibold tabular-nums', tone)}
      aria-label={t2(f, pp)}>
      {pp > 0 ? '+' : pp < 0 ? '−' : '±'}{f.t('insights.returns.pp', { n: shown })}
    </span>
  );
}
const t2 = (f: InsightsFormat, pp: number) =>
  f.t(pp > 0 ? 'insights.returns.ppUp' : pp < 0 ? 'insights.returns.ppDown' : 'insights.returns.ppFlat',
    { n: dec1(f, Math.abs(pp)) });

function ProblemTile({ data, clock, drill, money, f }: {
  data: ReturnsResponse; clock: ReturnsClock; drill: ReturnType<typeof rsDrill> | null; money: boolean; f: InsightsFormat;
}) {
  const { t } = f;
  const p = data.kpis.problem;
  const nowN = data.now.rejected.count + data.now.attempted.count + data.now.problematic.count;
  const nowLine = t('insights.returns.tile.problemNow', {
    rejected: f.int(data.now.rejected.count), attempted: f.int(data.now.attempted.count), problematic: f.int(data.now.problematic.count),
  });
  if (clock === 'sale' && p) {
    return (
      <Tile icon={AlertTriangle} label={t('insights.returns.tile.problem')} alert={p.count > 0 ? 'warning' : null}
        value={drill ? <CountLink drill={drill} label={`${t('insights.returns.tile.problem')}: ${f.int(p.count)}`} f={f}>{f.int(p.count)}</CountLink> : f.int(p.count)}
        sub={<>
          {t('insights.returns.tile.problemSplit', { rejected: f.int(p.rejected), attempted: f.int(p.attempted), problematic: f.int(p.problematic) })}
          {money && p.value_mkd != null && p.count > 0 && <> · {f.den(p.value_mkd)}</>}
          <span className="block">{nowLine}</span>
        </>} />
    );
  }
  return (
    <Tile icon={AlertTriangle} label={t('insights.returns.tile.problemNowTitle')} alert={nowN > 0 ? 'warning' : null}
      value={f.int(nowN)} sub={<>{nowLine}<span className="block"><ClockCaption clock="now" /></span></>} />
  );
}

function SourceReturns({ rows, clock, money, range, baseLabel, f }: {
  rows: ReturnsSourceRow[]; clock: ReturnsClock; money: boolean; range: DayRange; baseLabel: string; f: InsightsFormat;
}) {
  const { t } = f;
  const sale = clock === 'sale';
  return (
    <Section title={t('insights.returns.source.title')} clock={sale ? 'sale' : 'returned'}>
      <div className="-mx-1 overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b text-[11px] uppercase tracking-wide text-muted-foreground">
              <th scope="col" className="px-1 py-1.5 text-left font-medium">{t('insights.common.table.source')}</th>
              <th scope="col" className="px-1 py-1.5 text-right font-medium">{baseLabel}</th>
              <th scope="col" className="px-1 py-1.5 text-right font-medium">{t('insights.returns.col.returned')}</th>
              <th scope="col" className="w-32 px-1 py-1.5 text-right font-medium">{t('insights.returns.col.rate')}</th>
              {sale && <th scope="col" className="px-1 py-1.5 text-right font-medium">{t('insights.returns.col.open')}</th>}
              {money && <th scope="col" className="px-1 py-1.5 text-right font-medium">{t('insights.returns.col.uncollected')}</th>}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={6} className="px-1 py-6 text-center text-muted-foreground">{t('insights.returns.empty')}</td></tr>
            ) : rows.map((r) => {
              const name = f.sourceLabel(r.key);
              const d = rsDrill({ clock, bucket: 'returned', comp: r, count: r.returned, sources: [r.key], range });
              const splits = (r.splits ?? []).filter((s) => s.base > 0);
              return (
                <tr key={r.key} className="border-b align-top last:border-0">
                  <th scope="row" className="px-1 py-2 text-left font-medium">
                    <span className="inline-flex items-center gap-2">
                      <span className="h-[3px] w-4 shrink-0 rounded-full" style={{ background: sourceColorVar(r.key) }} aria-hidden />{name}
                    </span>
                    {splits.length > 1 && (
                      <ul className="mt-1 flex flex-wrap gap-1 text-[11px] font-normal text-muted-foreground">
                        {splits.map((s) => (
                          <li key={`${s.kind}:${s.key}`} className="rounded-full bg-muted px-2 py-0.5"
                            title={s.kind === 'mex' ? t('insights.common.cohort.noLinkMexOnly') : undefined}>
                            {f.splitLabel(s.key)} <b className="tabular-nums">{f.int(s.returned)}/{f.int(s.base)}</b>
                            <span className="tabular-nums"> · {f.pct(s.rate)}</span>
                            {s.kind === 'mex' && <span className="ml-1 font-semibold uppercase">{t('insights.common.table.mexOnlyTag')}</span>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </th>
                  <td className="px-1 py-2 text-right tabular-nums">{f.int(r.base)}</td>
                  <td className="px-1 py-2 text-right font-semibold tabular-nums">
                    <CountLink drill={d} label={`${name} · ${t('insights.returns.col.returned')}: ${f.int(r.returned)}`} f={f}>{f.int(r.returned)}</CountLink>
                  </td>
                  <td className="px-1 py-2 text-right tabular-nums">
                    <span className="block font-medium">{f.pct(r.rate)}</span>
                    <ShareBar value={r.rate} tone={COHORT_TONE.returned} label={f.pct(r.rate)} />
                  </td>
                  {sale && <td className="px-1 py-2 text-right tabular-nums text-muted-foreground">{f.int(r.open)} <span className="text-[11px]">({f.share(r.open, r.base)})</span></td>}
                  {money && <td className="px-1 py-2 text-right tabular-nums">{r.value_mkd != null ? f.den(r.value_mkd) : '—'}</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

function ProductFooter({ data, sale, f }: { data: ReturnsResponse; sale: boolean; f: InsightsFormat }) {
  const { t } = f;
  const p = data.by_product;
  const bad = p.not_products.find((x) => x.kind === 'bad_quantity')?.units ?? 0;
  const other = p.not_products.filter((x) => x.kind !== 'bad_quantity').reduce((a, x) => a + x.units, 0);
  return (
    <span className="block space-y-0.5">
      <span className="block">{t(sale ? 'insights.returns.product.mexOnlySale' : 'insights.returns.product.mexOnlyMex', { base: f.int(p.mex_only.base), returned: f.int(p.mex_only.returned) })}</span>
      <span className="block">{t('insights.returns.product.free', { returned: f.int(p.total.free_returned_units), sold: f.int(p.total.free_units) })}</span>
      {(other > 0 || bad > 0) && (
        <span className="block">{t('insights.returns.product.notProducts', { n: f.int(other), bad: f.int(bad) })}</span>
      )}
    </span>
  );
}

function Reasons({ data, clock, money, f }: { data: ReturnsResponse; clock: ReturnsClock; money: boolean; f: InsightsFormat }) {
  const { t } = f;
  const total = data.reasons.reduce((a, r) => a + r.count, 0);
  const label = (bucket: string, reason: string) =>
    reason === '__unknown__' ? t('insights.returns.reasons.unknown')
      : bucket === 'trashed_after_sale' ? trashReasonLabel(reason) : cancelReasonLabel(reason);
  return (
    <Section title={t('insights.returns.reasons.title')} clock={clock === 'sale' ? 'sale' : 'decided'}
      sub={t('insights.returns.reasons.sub')} right={<Ban className="h-4 w-4 text-muted-foreground" aria-hidden />}>
      {total === 0 ? (
        <p className="py-4 text-center text-sm text-muted-foreground">{t('insights.returns.reasons.none')}</p>
      ) : (
        <ul className="space-y-1.5">
          {data.reasons.slice(0, 10).map((r) => (
            <li key={`${r.bucket}:${r.reason}`} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 text-sm">
              <span className={cn('h-2.5 w-2.5 rounded-full', r.bucket === 'cancelled_after_sale' ? OUTSIDE_TONE.cancelled_after_sale : OUTSIDE_TONE.trashed_after_sale)}
                title={f.outsideLabel(r.bucket)} aria-label={f.outsideLabel(r.bucket)} />
              <span className="min-w-0 truncate">{label(r.bucket, r.reason)}</span>
              <span className="tabular-nums">
                <b>{f.int(r.count)}</b>
                <span className="ml-1 text-xs text-muted-foreground">{f.share(r.count, total)}</span>
                {money && r.value_mkd != null && <span className="ml-2 text-xs text-muted-foreground">{f.den(r.value_mkd)}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function Repeaters({ data, clock, f }: { data: ReturnsResponse; clock: ReturnsClock; f: InsightsFormat }) {
  const { t } = f;
  const r = data.repeat;
  const total = data.kpis.returned.count;
  const fmtPhone = (p: string) => `0${p.slice(0, 2)} ${p.slice(2, 5)} ${p.slice(5)}`;
  return (
    <Section title={t('insights.returns.repeat.title')} clock={clock === 'sale' ? 'sale' : 'returned'}
      sub={t('insights.returns.repeat.sub', { phones: f.int(r.phones), n: f.int(r.returns_in_window), pct: f.share(r.returns_in_window, total) })}
      right={<PhoneCall className="h-4 w-4 text-muted-foreground" aria-hidden />}>
      {r.rows.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted-foreground">{t('insights.returns.repeat.none')}</p>
      ) : (
        <div className="-mx-1 max-h-80 overflow-auto">
          <table className="w-full min-w-[420px] text-sm">
            <thead>
              <tr className="border-b text-[11px] uppercase tracking-wide text-muted-foreground">
                <th scope="col" className="px-1 py-1.5 text-left font-medium">{t('insights.returns.repeat.buyer')}</th>
                <th scope="col" className="px-1 py-1.5 text-right font-medium">{t('insights.returns.repeat.returnedAll')}</th>
                <th scope="col" className="px-1 py-1.5 text-right font-medium">{t('insights.returns.repeat.deliveredAll')}</th>
                <th scope="col" className="px-1 py-1.5 text-right font-medium">{t('insights.returns.repeat.inWindow')}</th>
                <th scope="col" className="px-1 py-1.5 text-right font-medium">{t('insights.returns.repeat.last')}</th>
              </tr>
            </thead>
            <tbody>
              {r.rows.map((x) => (
                <tr key={x.phone8} className="border-b last:border-0">
                  <th scope="row" className="px-1 py-1.5 text-left font-medium">
                    <DrillLink href={`/orders?search=${x.phone8}`} title={t('insights.returns.repeat.open')} className="tabular-nums">{fmtPhone(x.phone8)}</DrillLink>
                    {x.name && <span className="block max-w-[12rem] truncate text-[11px] font-normal text-muted-foreground">{x.name}</span>}
                  </th>
                  <td className={cn('px-1 py-1.5 text-right font-semibold tabular-nums', STATUS_TEXT.returned)}>{f.int(x.returned_all)}</td>
                  <td className="px-1 py-1.5 text-right tabular-nums">{f.int(x.delivered_all)}</td>
                  <td className="px-1 py-1.5 text-right tabular-nums">{f.int(x.in_window)}</td>
                  <td className="px-1 py-1.5 text-right tabular-nums text-muted-foreground">{x.last_returned ? dm(x.last_returned, true) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

/** What the numbers above cannot vouch for yet — review items, nothing is fixed automatically. */
function ReturnsNotes({ data, clock, f }: { data: ReturnsResponse; clock: ReturnsClock; f: InsightsFormat }) {
  const { t } = f;
  const bad = data.by_product.not_products.find((x) => x.kind === 'bad_quantity')?.units ?? 0;
  const items: { key: string; sev: 'warning' | 'info'; icon: LucideIcon; title: string; body: ReactNode; n?: number }[] = [];
  if (data.kpis.crm_only_returned.count > 0) {
    items.push({ key: 'crm', sev: 'warning', icon: AlertTriangle, n: data.kpis.crm_only_returned.count,
      title: t('insights.returns.notes.crmOnly'), body: t('insights.returns.notes.crmOnlyHint') });
  }
  if (bad > 0) {
    items.push({ key: 'bad', sev: 'warning', icon: AlertTriangle, n: bad,
      title: t('insights.returns.notes.badQty'), body: t('insights.returns.notes.badQtyHint') });
  }
  if (data.now.rejected.count > 0) {
    items.push({ key: 'rej', sev: 'info', icon: Truck, n: data.now.rejected.count,
      title: t('insights.returns.notes.rejected'), body: t('insights.returns.notes.rejectedHint', { date: data.now.oldest ? dm(data.now.oldest, true) : '—' }) });
  }
  items.push({ key: 'reason', sev: 'info', icon: Info, title: t('insights.returns.notes.reason'), body: t('insights.returns.notes.reasonHint') });
  if ((data.kpis.round_trip?.parcels ?? 0) > 0) {
    items.push({ key: 'fee', sev: 'info', icon: Route, title: t('insights.returns.notes.fee'), body: t('insights.returns.notes.feeHint') });
  }
  void clock;
  return (
    <section aria-labelledby="rt-notes" className="space-y-3">
      <h2 id="rt-notes" className="text-base font-semibold">{t('insights.common.quality.title')}</h2>
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {items.map((q) => (
          <li key={q.key} className={cn('flex min-w-0 flex-col rounded-xl border bg-card p-4 shadow-sm', q.sev === 'warning' && 'border-amber-300 dark:border-amber-900')}>
            <span className={cn('inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide', q.sev === 'warning' ? STATUS_TEXT.warning : STATUS_TEXT.neutral)}>
              <q.icon className="h-3.5 w-3.5" aria-hidden />{t(`insights.common.quality.severity.${q.sev}`)}
            </span>
            <h3 className="mt-1 text-sm font-medium leading-snug">{q.title}</h3>
            {q.n != null && <p className="mt-1 text-2xl font-semibold tabular-nums">{f.int(q.n)}</p>}
            <p className="mt-2 text-[11px] leading-snug text-muted-foreground">{q.body}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ReturnsSkeleton() {
  return (
    <div className="space-y-5" aria-hidden>
      <Skeleton variant="card" className="h-48" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} variant="card" className="h-24" />)}
      </div>
      <Skeleton variant="card" className="h-56" />
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <Skeleton variant="card" className="h-72" /><Skeleton variant="card" className="h-72" />
      </div>
    </div>
  );
}
