import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  AlertTriangle, Boxes, CheckCircle2, CopyX, FlaskConical, Gift, Info, PackageCheck, PackageOpen, PackageSearch,
  ShieldAlert, Tag, TrendingDown, TrendingUp, Undo2, Wallet,
} from 'lucide-react';
import {
  apiGetInsightsStock, type StockProductRow, type StockQueueStage, type StockResponse,
} from '@/lib/insightsApi/returnsStock';
import { useAuth } from '@/contexts/AuthContext';
import { apiErrorText } from '@/i18n/apiErrors';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/EmptyState';
import { cn } from '@/lib/utils';
import { OVERVIEW_COLOR_VARS, SOURCE_ORDER, sourceColorVar } from '../overview/palette';
import { FilterBar } from '../overview/FilterBar';
import { DeltaBadge } from '../overview/KpiRow';
import { delta, parseOverviewParams, writeOverviewParams, type OverviewFilters } from '../overview/model';
import { dm } from '../overview/useOverviewFormat';
import { COHORT_TONE, STATUS_TEXT } from '../shared/cohortPalette';
import { useInsightsFormat, type InsightsFormat } from '../shared/useInsightsFormat';
import { useInsightsPeriod } from '../shared/useInsightsPeriod';
import { BarList, CountLink, DayColumns, Section, Tile, dec1 } from '../returns/RsBits';
import {
  STALE_AGES, filterProducts, queueDrill, rsDrill, slowMovers, topMovers, type StockSort,
} from '../returns/returnsModel';

type FixtureMode = '1' | 'nomoney';

/** The admin/manager/warehouse view: every `*_mkd` key and the valuation removed (dev fixture + tests). */
export function stripStockMoney(d: StockResponse): StockResponse {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) if (!/_(mkd|eur)$/.test(k) && k !== 'valuation') out[k] = walk(x);
      return out;
    }
    return v;
  };
  const s = walk(d) as StockResponse;
  s.meta = { ...s.meta, money: false };
  return s;
}

/**
 * Insights → Производи и залихи: what sold (units per product, by source), what
 * waits in the warehouse NOW, what came back, and how far the stock count can
 * be trusted. Units are the cohort sales' item lines (product_key folded;
 * loyalty points, notes, the delivery line and impossible quantities apart);
 * stock on hand shows only for warehouse-tracked products, and days of cover /
 * the valuation only once the count is trustworthy. Owners see денари
 * (meta.money); admins/managers the same page counted.
 *
 * Data: GET /insights/stock (migration 20260941000500). In a DEV build
 * `?stFixture=1` (or `=nomoney`) renders the typed fixture instead.
 */
export default function StockTab() {
  const f = useInsightsFormat();
  const { t } = f;
  const { user } = useAuth();
  const [sp, setSp] = useSearchParams();
  const period = useInsightsPeriod();
  const range = period.range;
  const chips = useMemo(() => parseOverviewParams(sp, period.today), [sp, period.today]);
  const sources = chips.sources;
  const filters: OverviewFilters = useMemo(() => ({
    preset: period.preset, range, compare: period.compare, sources, teams: [],
  }), [period.preset, range, period.compare, sources]);
  const setFilters = useCallback(
    (next: Partial<OverviewFilters>) => setSp((prev) => writeOverviewParams(prev, next), { replace: true }),
    [setSp],
  );

  const raw = import.meta.env.DEV ? sp.get('stFixture') : null;
  const fixture: FixtureMode | null = raw === '1' || raw === 'nomoney' ? raw : null;
  const load = useCallback(async (signal?: AbortSignal): Promise<StockResponse> => {
    if (import.meta.env.DEV && fixture) {
      const m = await import('./__fixtures__/stock.sample.json');
      const d = structuredClone(m.default) as unknown as StockResponse;
      return fixture === 'nomoney' ? stripStockMoney(d) : d;
    }
    return apiGetInsightsStock({ from: range.from, to: range.to, compare: period.compare, sources }, signal);
  }, [fixture, range.from, range.to, period.compare, sources]);

  const q = useQuery({
    queryKey: ['insights-stock', user?.id, range.from, range.to, period.compare, sources.join(','), fixture],
    queryFn: ({ signal }) => load(signal),
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
    retry: 0,
  });
  const data = q.data;
  const money = data?.meta.money === true;
  const errorText = (err: unknown) =>
    err instanceof Error && /^HTTP 404$|not found/i.test(err.message) ? t('insights.stock.notDeployed') : apiErrorText(err);

  return (
    <div className={cn('space-y-5', OVERVIEW_COLOR_VARS)}>
      {fixture && (
        <p role="status" className="flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          <FlaskConical className="h-4 w-4 shrink-0" aria-hidden />{t('overview.demoData')}
        </p>
      )}
      <FilterBar filters={filters} onChange={setFilters} teams={[]} f={f} />

      {!data ? (
        q.isError ? (
          <EmptyState
            icon={<AlertTriangle className="h-5 w-5" />}
            title={t('insights.loadFailed')}
            description={errorText(q.error)}
            size="sm"
            action={<Button variant="outline" size="sm" onClick={() => { void q.refetch(); }}>{t('common.retry')}</Button>}
          />
        ) : <StockSkeleton />
      ) : (
        <div aria-busy={q.isFetching} className={cn('space-y-6 transition-opacity duration-200', q.isPlaceholderData && 'opacity-60')}>
          {q.isError && (
            <p role="alert" className="flex items-center gap-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
              <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
              {t('overview.staleError')} {errorText(q.error)}
              <Button variant="ghost" size="sm" className="ml-auto h-6 px-2 text-xs" onClick={() => { void q.refetch(); }}>{t('common.retry')}</Button>
            </p>
          )}
          <StockBody data={data} money={money} sources={sources} compare={period.compare} f={f} />
        </div>
      )}
    </div>
  );
}

function StockBody({ data, money, sources, compare, f }: {
  data: StockResponse; money: boolean; sources: string[]; compare: boolean; f: InsightsFormat;
}) {
  const { t } = f;
  const k = data.kpis;
  const trusted = data.trust.trusted;
  const pack = data.queue.find((s) => s.stage === 'to_pack');
  const label = data.queue.find((s) => s.stage === 'label');
  // Менаџмент only when it moved something (owner 02.10.2026: "ако има нешто")
  const shown = SOURCE_ORDER.filter((s) => (!sources.length || sources.includes(s))
    && (s !== 'management' || data.trend.some((p) => (p.by_source?.[s] ?? 0) > 0)));
  const columns = useMemo(() => data.trend.map((p) => ({
    d: p.d, total: p.units,
    segs: shown.map((s) => ({ key: s, value: p.by_source?.[s] ?? 0 })),
  })), [data.trend, shown]);

  return (
    <div className="space-y-6">
      <TrustBanner data={data} f={f} />

      <ul className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Tile icon={Boxes} label={t('insights.stock.tile.units')} value={f.int(k.units)}
          sub={<>
            {t('insights.stock.tile.unitsSub', { n: f.int(k.products_sold), pct: f.share(k.units_catalogue, k.units) })}
            {compare && k.units_prev != null && <span className="ml-1 inline-flex"><DeltaBadge d={delta(k.units, k.units_prev, 'up')} f={f} /></span>}
          </>} />
        <Tile icon={Gift} label={t('insights.stock.tile.free')} value={f.int(k.free_units)} sub={t('insights.stock.tile.freeSub')} />
        <Tile icon={PackageOpen} label={t('insights.stock.tile.toPack')} value={f.int(pack?.count ?? 0)}
          alert={pack && pack.ages.some((a) => STALE_AGES.includes(a.key) && a.count > 0) ? 'warning' : null}
          sub={t('insights.stock.tile.toPackSub', { units: f.int(pack?.units ?? 0), date: pack?.oldest ? dm(pack.oldest, true) : '—' })} />
        <Tile icon={Tag} label={t('insights.stock.tile.label')} value={f.int(label?.count ?? 0)}
          sub={t('insights.stock.tile.labelSub', { units: f.int(label?.units ?? 0), date: label?.oldest ? dm(label.oldest, true) : '—' })} />
        <Tile icon={Undo2} label={t('insights.stock.tile.returned')} value={f.int(k.returned_units)}
          sub={t('insights.stock.tile.returnedSub', { n: f.int(k.returned_parcels), mex: f.int(k.returned_mex_only) })} />
        {money && trusted && data.valuation ? (
          <Tile icon={Wallet} label={t('insights.stock.tile.valuation')} value={f.den(data.valuation.cost_mkd ?? 0)}
            sub={t('insights.stock.tile.valuationSub', { price: f.den(data.valuation.price_mkd ?? 0), pct: f.pct(data.valuation.coverage, 0) })} />
        ) : (
          <Tile icon={PackageSearch} label={t('insights.stock.tile.tracked')} value={`${f.int(k.tracked)} / ${f.int(k.active)}`}
            sub={trusted && k.out != null
              ? t('insights.stock.tile.trackedTrusted', { out: f.int(k.out), low: f.int(k.low ?? 0) })
              : t(money ? 'insights.stock.tile.trackedHiddenOwner' : 'insights.stock.tile.trackedHidden', { n: f.int(data.hygiene.not_tracked) })} />
        )}
      </ul>

      <Queue data={data} sources={sources} money={money} f={f} />

      <Section title={t('insights.stock.trend.title')} clock="sale" sub={t('insights.stock.trend.sub')}>
        <DayColumns
          columns={columns}
          granularity={data.meta.granularity}
          label={t('insights.stock.trend.title')}
          parts={shown.map((s) => ({ key: s, label: f.sourceLabel(s), color: sourceColorVar(s) }))}
          f={f}
        />
      </Section>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <Movers rows={data.products} compare={compare && data.meta.has_prev} f={f} />
        <SlowMovers rows={data.products} trusted={trusted} f={f} />
      </div>

      <ProductTable data={data} money={money} f={f} />

      <Hygiene data={data} f={f} />
    </div>
  );
}

function TrustBanner({ data, f }: { data: StockResponse; f: InsightsFormat }) {
  const { t } = f;
  const tr = data.trust;
  // "2026-09-28T14:05" (Skopje) → "28.09.2026 14:05"
  const run = tr.mex_last_run ? `${dm(tr.mex_last_run.slice(0, 10), true)} ${tr.mex_last_run.slice(11, 16)}` : '—';
  if (tr.trusted) {
    return (
      <p className={cn('flex items-center gap-2 rounded-lg border px-3 py-2 text-xs', STATUS_TEXT.good)}>
        <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />
        {tr.mex_enabled
          ? t('insights.stock.trust.mexOk', { count: tr.last_count ? dm(tr.last_count, true) : '—', from: tr.mex_from ? dm(tr.mex_from, true) : '—', run })
          : t('insights.stock.trust.ok', { count: tr.last_count ? dm(tr.last_count, true) : '—', deduction: tr.last_deduction ? dm(tr.last_deduction, true) : '—' })}
      </p>
    );
  }
  // Counted (migration 20260942000100), but MEX stock movements are off, or their ledger stopped running.
  if (tr.counted) {
    return (
      <div role="status" className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2.5 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
        <ShieldAlert className="mt-px h-4 w-4 shrink-0" aria-hidden />
        <div className="space-y-0.5">
          <p className="font-semibold">{t('insights.stock.trust.countedTitle', { date: tr.last_count ? dm(tr.last_count, true) : '—' })}</p>
          <p>{tr.mex_enabled ? t('insights.stock.trust.stale', { run }) : t('insights.stock.trust.countedOff')}</p>
        </div>
      </div>
    );
  }
  return (
    <div role="status" className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2.5 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
      <ShieldAlert className="mt-px h-4 w-4 shrink-0" aria-hidden />
      <div className="space-y-0.5">
        <p className="font-semibold">{t('insights.stock.trust.title', { date: tr.last_count ? dm(tr.last_count, true) : '—' })}</p>
        <p>{t('insights.stock.trust.body', {
          deduction: tr.last_deduction ? dm(tr.last_deduction, true) : '—',
          parcels: f.int(tr.parcels_since_deduction),
          placeholder: f.int(data.hygiene.placeholder),
        })}</p>
        <p>{t('insights.stock.trust.window', { parcels: f.int(tr.parcels_window), moves: f.int(tr.ledger_moves_window), out: f.int(tr.ledger_out_window) })}</p>
        <p className="opacity-80">{t('insights.stock.trust.fix')}</p>
      </div>
    </div>
  );
}

function Queue({ data, sources, money, f }: { data: StockResponse; sources: string[]; money: boolean; f: InsightsFormat }) {
  const { t } = f;
  const today = data.meta.today ?? data.meta.to;
  return (
    <Section title={t('insights.stock.queue.title')} clock="now" sub={t('insights.stock.queue.sub')}>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {data.queue.map((s) => <QueueStage key={s.stage} s={s} today={today} sources={sources} money={money} f={f} />)}
      </div>
      {data.queue_products.length > 0 && (
        <div className="-mx-1 overflow-x-auto border-t pt-3">
          <p className="mb-1 px-1 text-[11px] font-medium text-muted-foreground">{t('insights.stock.queue.products')}</p>
          <table className="w-full min-w-[420px] text-sm">
            <thead>
              <tr className="border-b text-[11px] uppercase tracking-wide text-muted-foreground">
                <th scope="col" className="px-1 py-1.5 text-left font-medium">{t('insights.stock.col.product')}</th>
                <th scope="col" className="px-1 py-1.5 text-right font-medium">{t('insights.stock.col.toPack')}</th>
                <th scope="col" className="px-1 py-1.5 text-right font-medium">{t('insights.stock.col.label')}</th>
                <th scope="col" className="px-1 py-1.5 text-right font-medium">{t('insights.stock.col.onHand')}</th>
              </tr>
            </thead>
            <tbody>
              {data.queue_products.map((p) => (
                <tr key={p.key} className="border-b last:border-0">
                  <th scope="row" className="max-w-[16rem] truncate px-1 py-1.5 text-left font-medium" title={p.name ?? undefined}>{p.name ?? '—'}</th>
                  <td className="px-1 py-1.5 text-right font-semibold tabular-nums">{f.int(p.pack_units)}</td>
                  <td className="px-1 py-1.5 text-right tabular-nums">{f.int(p.label_units)}</td>
                  <td className="px-1 py-1.5 text-right tabular-nums"><OnHand value={p.on_hand} trusted={data.trust.trusted} f={f} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

function QueueStage({ s, today, sources, money, f }: {
  s: StockQueueStage; today: string; sources: string[]; money: boolean; f: InsightsFormat;
}) {
  const { t } = f;
  const all = rsDrill({ clock: 'sale', bucket: s.stage, comp: s, count: s.count, sources, range: { from: s.oldest ?? today, to: today } });
  const stale = s.ages.filter((a) => STALE_AGES.includes(a.key)).reduce((n, a) => n + a.count, 0);
  const Icon = s.stage === 'to_pack' ? PackageOpen : Tag;
  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <span className={cn('h-2.5 w-2.5 rounded-full', s.stage === 'to_pack' ? COHORT_TONE.to_pack : COHORT_TONE.label)} aria-hidden />
          <Icon className="h-3.5 w-3.5" aria-hidden />{f.bucketLabel(s.stage)}
        </span>
        {s.oldest && <span className="text-[11px] tabular-nums text-muted-foreground">{t('insights.stock.queue.oldest', { date: dm(s.oldest, true) })}</span>}
      </div>
      <div className="flex flex-wrap items-baseline gap-x-3">
        <CountLink drill={all} label={`${f.bucketLabel(s.stage)}: ${f.int(s.count)}`} f={f} className="text-2xl font-semibold tabular-nums">{f.int(s.count)}</CountLink>
        <span className="text-xs text-muted-foreground">{t('insights.stock.queue.units', { n: f.int(s.units) })}</span>
        {money && s.value_mkd != null && <span className="text-xs tabular-nums text-muted-foreground">{f.den(s.value_mkd)}</span>}
      </div>
      <BarList
        tone={s.stage === 'to_pack' ? COHORT_TONE.to_pack : COHORT_TONE.label}
        f={f}
        rows={s.ages.map((a) => {
          const d = queueDrill(s.stage, a, sources);
          return {
            key: a.key, label: t(`insights.stock.queue.age.${a.key}`), value: a.count, display: f.int(a.count),
            alert: STALE_AGES.includes(a.key) && a.count > 0,
            href: <CountLink drill={d} label={`${f.bucketLabel(s.stage)} · ${t(`insights.stock.queue.age.${a.key}`)}: ${f.int(a.count)}`} f={f} className="font-semibold">{f.int(a.count)}</CountLink>,
          };
        })}
      />
      {stale > 0 && (
        <p className={cn('flex items-start gap-1.5 text-[11px] leading-snug', STATUS_TEXT.warning)}>
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
          {t(s.stage === 'to_pack' ? 'insights.stock.queue.staleToPack' : 'insights.stock.queue.staleLabel', { n: f.int(stale) })}
        </p>
      )}
      <ul className="flex flex-wrap gap-1 text-[11px] text-muted-foreground">
        {s.by_source.map((x) => (
          <li key={x.key} className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5">
            <span className="h-[3px] w-3 rounded-full" style={{ background: sourceColorVar(x.key) }} aria-hidden />
            {f.sourceLabel(x.key)} <b className="tabular-nums">{f.int(x.count)}</b>
            {x.mex_only > 0 && <span className="font-semibold uppercase">{t('insights.common.table.mexOnlyTag')} {f.int(x.mex_only)}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function OnHand({ value, trusted, f }: { value: number | null; trusted: boolean; f: InsightsFormat }) {
  const { t } = f;
  if (value == null) return <span className="text-[11px] text-muted-foreground">{t('insights.stock.state.not_tracked')}</span>;
  return (
    <span className={cn(!trusted && 'text-muted-foreground')} title={trusted ? undefined : t('insights.stock.unverifiedHint')}>
      {f.int(value)}{!trusted && <sup aria-hidden>*</sup>}
      {!trusted && <span className="sr-only"> {t('insights.stock.unverified')}</span>}
    </span>
  );
}

function Movers({ rows, compare, f }: { rows: StockProductRow[]; compare: boolean; f: InsightsFormat }) {
  const { t } = f;
  const top = topMovers(rows, 10);
  return (
    <Section title={t('insights.stock.movers.title')} clock="sale" sub={t('insights.stock.movers.sub')}
      right={<TrendingUp className="h-4 w-4 text-muted-foreground" aria-hidden />}>
      {top.length === 0 ? <p className="py-4 text-center text-sm text-muted-foreground">{t('insights.stock.empty')}</p> : (
        <BarList tone={COHORT_TONE.paid} f={f} rows={top.map(({ row, delta: dl }) => ({
          key: row.key, label: <span title={row.name ?? undefined}>{row.name ?? '—'}</span>, value: row.units, display: f.int(row.units),
          sub: compare && dl != null
            ? <span className={cn(dl > 0 ? STATUS_TEXT.good : dl < 0 ? STATUS_TEXT.critical : STATUS_TEXT.neutral)}>{dl > 0 ? '+' : dl < 0 ? '−' : '±'}{f.int(Math.abs(dl))}</span>
            : undefined,
        }))} />
      )}
    </Section>
  );
}

function SlowMovers({ rows, trusted, f }: { rows: StockProductRow[]; trusted: boolean; f: InsightsFormat }) {
  const { t } = f;
  const slow = slowMovers(rows, 10);
  return (
    <Section title={t('insights.stock.slow.title')} clock={['sale', 'now']} sub={t('insights.stock.slow.sub')}
      right={<TrendingDown className="h-4 w-4 text-muted-foreground" aria-hidden />}>
      {slow.length === 0 ? <p className="py-4 text-center text-sm text-muted-foreground">{t('insights.stock.slow.none')}</p> : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-[11px] uppercase tracking-wide text-muted-foreground">
              <th scope="col" className="px-1 py-1.5 text-left font-medium">{t('insights.stock.col.product')}</th>
              <th scope="col" className="px-1 py-1.5 text-right font-medium">{t('insights.stock.col.units')}</th>
              <th scope="col" className="px-1 py-1.5 text-right font-medium">{t('insights.stock.col.onHand')}</th>
            </tr>
          </thead>
          <tbody>
            {slow.map((r) => (
              <tr key={r.key} className="border-b last:border-0">
                <th scope="row" className="max-w-[16rem] truncate px-1 py-1.5 text-left font-medium" title={r.name ?? undefined}>{r.name ?? '—'}</th>
                <td className={cn('px-1 py-1.5 text-right tabular-nums', r.units === 0 && 'font-semibold text-amber-700 dark:text-amber-400')}>{f.int(r.units)}</td>
                <td className="px-1 py-1.5 text-right tabular-nums"><OnHand value={r.on_hand} trusted={trusted} f={f} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}

const STATE_TONE: Record<string, string> = {
  ok: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300',
  low: 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300',
  out: 'bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300',
  not_tracked: 'bg-muted text-muted-foreground',
};

function ProductTable({ data, money: moneyIn, f }: { data: StockResponse; money: boolean; f: InsightsFormat }) {
  // The purchase-cost column is a margin figure: an administrator's payload keeps meta.money but
  // carries no cost_mkd (access levels, 20260947001600) — then no column of "—" is drawn.
  const money = moneyIn && (data.products ?? []).some((p) => p.cost_mkd != null);
  const { t } = f;
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<StockSort>('units');
  const [onlyCatalogue, setOnlyCatalogue] = useState(false);
  const rows = useMemo(() => filterProducts(data.products, q, sort, onlyCatalogue), [data.products, q, sort, onlyCatalogue]);
  const trusted = data.trust.trusted;
  const sortBtn = (key: StockSort, label: string) => (
    <button type="button" aria-pressed={sort === key} onClick={() => setSort(key)}
      className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', sort === key ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground')}>
      {label}
    </button>
  );
  return (
    <Section title={t('insights.stock.table.title')} clock={['sale', 'returned', 'now']}
      sub={t('insights.stock.table.sub', { n: f.int(data.products.length) })}>
      <div className="flex flex-wrap items-center gap-2">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('insights.stock.table.search')}
          aria-label={t('insights.stock.table.search')} className="h-8 w-full max-w-xs text-sm" />
        <div role="group" aria-label={t('insights.stock.table.sort')} className="flex flex-wrap items-center gap-1">
          {sortBtn('units', t('insights.stock.col.units'))}
          {sortBtn('queue', t('insights.stock.col.queue'))}
          {sortBtn('returned', t('insights.stock.col.returned'))}
          {sortBtn('on_hand', t('insights.stock.col.onHand'))}
        </div>
        <label className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <input type="checkbox" checked={onlyCatalogue} onChange={(e) => setOnlyCatalogue(e.target.checked)} className="h-3.5 w-3.5" />
          {t('insights.stock.table.onlyCatalogue')}
        </label>
      </div>
      <div className="-mx-1 max-h-[32rem] overflow-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="sticky top-0 bg-card">
            <tr className="border-b text-[11px] uppercase tracking-wide text-muted-foreground">
              <th scope="col" className="px-1 py-1.5 text-left font-medium">{t('insights.stock.col.product')}</th>
              <th scope="col" className="px-1 py-1.5 text-right font-medium">{t('insights.stock.col.units')}</th>
              <th scope="col" className="px-1 py-1.5 text-left font-medium">{t('insights.stock.col.bySource')}</th>
              <th scope="col" className="px-1 py-1.5 text-right font-medium">{t('insights.stock.col.free')}</th>
              <th scope="col" className="px-1 py-1.5 text-right font-medium">{t('insights.stock.col.returned')}</th>
              <th scope="col" className="px-1 py-1.5 text-right font-medium">{t('insights.stock.col.queue')}</th>
              <th scope="col" className="px-1 py-1.5 text-right font-medium">{t('insights.stock.col.onHand')}</th>
              <th scope="col" className="px-1 py-1.5 text-left font-medium">{t('insights.stock.col.state')}</th>
              {trusted && <th scope="col" className="px-1 py-1.5 text-right font-medium">{t('insights.stock.col.cover')}</th>}
              {money && <th scope="col" className="px-1 py-1.5 text-right font-medium">{t('insights.stock.col.cost')}</th>}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={10} className="px-1 py-6 text-center text-muted-foreground">{t('insights.stock.empty')}</td></tr>
            ) : rows.map((r) => {
              const total = SOURCE_ORDER.reduce((a, s) => a + (r.by_source?.[s] ?? 0), 0);
              return (
                <tr key={r.key} className="border-b last:border-0">
                  <th scope="row" className="max-w-[18rem] px-1 py-1.5 text-left font-medium">
                    <span className="line-clamp-2 break-words" title={r.name ?? undefined}>{r.name ?? '—'}</span>
                    <span className="text-[10px] font-normal text-muted-foreground">
                      {r.sku && <span className="mr-1 tabular-nums">{r.sku}</span>}
                      {!r.catalogue && <span className="rounded bg-muted px-1">{t('insights.returns.product.notInCatalogue')}</span>}
                      {r.catalogue && r.cost_known === false && <span className="rounded bg-muted px-1">{t('insights.stock.noCost')}</span>}
                    </span>
                  </th>
                  <td className="px-1 py-1.5 text-right font-semibold tabular-nums">
                    {f.int(r.units)}
                    {r.units_prev != null && <span className="block"><DeltaBadge d={delta(r.units, r.units_prev, 'up')} f={f} /></span>}
                  </td>
                  <td className="px-1 py-1.5">
                    {total > 0 ? (
                      <span className="flex h-2 w-24 gap-[2px] overflow-hidden rounded-full" role="img"
                        aria-label={SOURCE_ORDER.map((s) => `${f.sourceLabel(s)} ${f.int(r.by_source?.[s] ?? 0)}`).join(' · ')}
                        title={SOURCE_ORDER.map((s) => `${f.sourceLabel(s)} ${f.int(r.by_source?.[s] ?? 0)}`).join(' · ')}>
                        {SOURCE_ORDER.filter((s) => (r.by_source?.[s] ?? 0) > 0).map((s) => (
                          <span key={s} className="h-full" style={{ flexGrow: r.by_source[s], flexBasis: 0, background: sourceColorVar(s) }} />
                        ))}
                      </span>
                    ) : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="px-1 py-1.5 text-right tabular-nums text-muted-foreground">{f.int(r.free_units)}</td>
                  <td className="px-1 py-1.5 text-right tabular-nums">{f.int(r.returned_units)}</td>
                  <td className="px-1 py-1.5 text-right tabular-nums">{f.int(r.queue_units)}</td>
                  <td className="px-1 py-1.5 text-right tabular-nums">{r.catalogue ? <OnHand value={r.on_hand} trusted={trusted} f={f} /> : '—'}</td>
                  <td className="px-1 py-1.5">
                    {r.state && (trusted || r.state === 'not_tracked')
                      ? <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-medium', STATE_TONE[r.state])}>{t(`insights.stock.state.${r.state}`)}</span>
                      : r.state ? <span className="text-[11px] text-muted-foreground">{t('insights.stock.unverified')}</span> : null}
                    {r.placeholder && <span className="ml-1 text-[10px] text-muted-foreground" title={t('insights.stock.placeholderHint')}>{t('insights.stock.placeholder')}</span>}
                  </td>
                  {trusted && <td className="px-1 py-1.5 text-right tabular-nums">{r.days_cover != null ? t('insights.returns.daysN', { n: dec1(f, r.days_cover) }) : '—'}</td>}
                  {money && <td className="px-1 py-1.5 text-right tabular-nums text-muted-foreground">{r.cost_mkd != null ? f.den(r.cost_mkd) : '—'}</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {data.products_more && data.products_more.products > 0 && (
        <p className="text-[11px] text-muted-foreground">{t('insights.stock.table.more', { n: f.int(data.products_more.products), units: f.int(data.products_more.units) })}</p>
      )}
    </Section>
  );
}

function Hygiene({ data, f }: { data: StockResponse; f: InsightsFormat }) {
  const { t } = f;
  const h = data.hygiene;
  const notProducts = h.not_products;
  return (
    <section aria-labelledby="st-hygiene" className="space-y-3">
      <h2 id="st-hygiene" className="text-base font-semibold">{t('insights.stock.hygiene.title')}</h2>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        <HygieneCard icon={CopyX} title={t('insights.stock.hygiene.duplicates')} n={f.int(h.duplicates.length)} warn={h.duplicates.length > 0}
          hint={t('insights.stock.hygiene.duplicatesHint')}>
          <ul className="space-y-1.5 text-xs">
            {h.duplicates.slice(0, 8).map((g) => (
              <li key={g.key} className="rounded-md bg-muted/50 px-2 py-1">
                {g.products.map((p) => (
                  <span key={p.product_id} className="flex justify-between gap-2">
                    <span className="min-w-0 truncate" title={p.name}>{p.name}</span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">{t('insights.stock.hygiene.dupUnits', { n: f.int(p.units) })}</span>
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </HygieneCard>
        <HygieneCard icon={PackageSearch} title={t('insights.stock.hygiene.unmapped')} n={f.int(h.unmapped.names)} warn={h.unmapped.names > 0}
          hint={t('insights.stock.hygiene.unmappedHint', { units: f.int(h.unmapped.units) })}>
          <ul className="space-y-0.5 text-xs">
            {h.unmapped.rows.slice(0, 10).map((r) => (
              <li key={r.name} className="flex justify-between gap-2">
                <span className="min-w-0 truncate" title={r.name}>{r.name}</span><b className="shrink-0 tabular-nums">{f.int(r.units)}</b>
              </li>
            ))}
          </ul>
        </HygieneCard>
        <HygieneCard icon={Wallet} title={t('insights.stock.hygiene.noCost')} n={f.int(h.no_cost.selling)} warn={h.no_cost.selling > 0}
          hint={t('insights.stock.hygiene.noCostHint', { active: f.int(h.no_cost.active), units: f.int(h.no_cost.units) })}>
          <ul className="space-y-0.5 text-xs">
            {h.no_cost.rows.slice(0, 10).map((r) => (
              <li key={r.product_id} className="flex justify-between gap-2">
                <span className="min-w-0 truncate" title={r.name}>{r.name}</span><b className="shrink-0 tabular-nums">{f.int(r.units)}</b>
              </li>
            ))}
          </ul>
        </HygieneCard>
        <HygieneCard icon={Info} title={t('insights.stock.hygiene.notProducts')} n={f.int(notProducts.reduce((a, x) => a + x.lines, 0))}
          warn={notProducts.some((x) => x.kind === 'bad_quantity')} hint={t('insights.stock.hygiene.notProductsHint')}>
          <ul className="space-y-0.5 text-xs">
            {notProducts.map((x) => (
              <li key={x.kind} className="flex justify-between gap-2">
                <span className={cn(x.kind === 'bad_quantity' && STATUS_TEXT.warning)}>{t(`insights.stock.kind.${x.kind}`, { defaultValue: x.kind })}</span>
                <span className="tabular-nums">{t('insights.stock.hygiene.linesUnits', { lines: f.int(x.lines), units: f.int(x.units) })}</span>
              </li>
            ))}
          </ul>
        </HygieneCard>
        <HygieneCard icon={PackageCheck} title={t('insights.stock.hygiene.notTracked')} n={f.int(h.not_tracked)} warn={false}
          hint={t('insights.stock.hygiene.notTrackedHint', { placeholder: f.int(h.placeholder), inactive: f.int(h.inactive_selling) })} />
      </div>
    </section>
  );
}

function HygieneCard({ icon: Icon, title, n, warn, hint, children }: {
  icon: typeof Info; title: string; n: string; warn: boolean; hint: string; children?: ReactNode;
}) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5 rounded-xl border bg-card p-4 shadow-sm', warn && 'border-amber-300 dark:border-amber-900')}>
      <span className={cn('inline-flex items-center gap-1.5 text-sm font-medium', warn ? STATUS_TEXT.warning : 'text-muted-foreground')}>
        <Icon className="h-4 w-4 shrink-0" aria-hidden />{title}
      </span>
      <span className="text-2xl font-semibold tabular-nums">{n}</span>
      <p className="text-[11px] leading-snug text-muted-foreground">{hint}</p>
      {children}
    </div>
  );
}

function StockSkeleton() {
  return (
    <div className="space-y-5" aria-hidden>
      <Skeleton className="h-16 w-full" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} variant="card" className="h-24" />)}
      </div>
      <Skeleton variant="card" className="h-64" />
      <Skeleton variant="card" className="h-72" />
    </div>
  );
}
