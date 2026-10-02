import { useId, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowRight, Package, Trophy } from 'lucide-react';
import type { OverviewSourceKey } from '@/lib/api';
import type { PeoplePerson, PeopleResponse } from '@/lib/insightsApi/agents';
import type { SalesDetail, SalesProduct } from '@/lib/insightsApi/sales';
import { apiErrorText } from '@/i18n/apiErrors';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { ClockCaption } from '../shared/ClockCaption';
import { CompanyWideNote } from '../shared/CompanyWideNote';
import { switchTabParams } from '../shared/period';
import { teamLaneName } from '../agents/parts';
import type { InsightsFormat } from '../shared/useInsightsFormat';

/** The part of a react-query result these cards read. */
interface QueryState<T> {
  data?: T;
  isError: boolean;
  error: unknown;
  refetch: () => unknown;
}

const TOP_SELLERS = 10;
const TOP_PRODUCTS = 8;

type SellerSort = 'sales' | 'value';

/** A person's sales in the departments in view (all of them = their total). */
const salesIn = (p: PeoplePerson, sources: OverviewSourceKey[] | null) =>
  sources ? sources.reduce((a, k) => a + (Number(p.by_source?.[k as keyof PeoplePerson['by_source']]) || 0), 0) : p.sales;

/**
 * "Кој колку продал" — the call centre's people on THE sale cohort (GET
 * /insights/agents, the same query and cache entry as the teams below and the
 * Agents tab): a person's sales are the cohort sales credited to them on the sale
 * day, so the list ties to the hero. Owners rank by денари or by sales; everyone
 * else by sales. A department filter counts the person's sales in those
 * departments only (a value is not split by department, so it is hidden then).
 */
export function TopSellersCard({ q, teamKeys, sources, f, className }: {
  q: QueryState<PeopleResponse>;
  /** The Overview's team chips (empty = every team). */
  teamKeys: string[];
  /** The department chips (null = every department). */
  sources: OverviewSourceKey[] | null;
  f: InsightsFormat;
  className?: string;
}) {
  const { t } = f;
  const titleId = useId();
  const [sp] = useSearchParams();
  const data = q.data;
  const money = data?.meta.money === true && !sources;
  const [sortRaw, setSort] = useState<SellerSort>('value');
  const sort: SellerSort = money ? sortRaw : 'sales';

  const teamNames = useMemo(() => new Map((data?.teams ?? []).map((tm) => [tm.key, tm.name])), [data]);
  const rows = useMemo(() => {
    const list = (data?.people ?? [])
      .filter((p) => !teamKeys.length || teamKeys.includes(p.team_key))
      .map((p) => ({ p, sales: salesIn(p, sources), value: p.value_mkd ?? 0 }))
      .filter((r) => r.sales > 0);
    const key = (r: (typeof list)[number]) => (sort === 'value' ? r.value : r.sales);
    return list.sort((a, b) => key(b) - key(a) || b.sales - a.sales || a.p.name.localeCompare(b.p.name));
  }, [data, teamKeys, sources, sort]);
  const shown = rows.slice(0, TOP_SELLERS);
  const max = Math.max(0, ...shown.map((r) => (sort === 'value' ? r.value : r.sales)));
  const totalSales = rows.reduce((a, r) => a + r.sales, 0);
  const noSeller = !teamKeys.length && !sources ? data?.no_seller?.count ?? 0 : 0;

  const agentsHref = (personId?: string) => {
    const next = switchTabParams(sp, 'agents');
    if (teamKeys.length) next.set('ag_team', teamKeys.join(','));
    if (personId) next.set('ag_person', personId);
    return `/insights?${next.toString()}`;
  };

  return (
    <section aria-labelledby={titleId} className={cn('flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4 shadow-sm', className)}>
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 id={titleId} className="flex items-center gap-1.5 text-sm font-semibold">
            <Trophy className="h-4 w-4 text-muted-foreground" aria-hidden />{t('overview.callCenter.sellers.title')}
          </h3>
          <ClockCaption clock="sale" />
        </div>
        {money && (
          <div role="group" aria-label={t('overview.callCenter.sellers.sortLabel')} className="inline-flex rounded-md border p-0.5 text-[11px]">
            {(['value', 'sales'] as const).map((k) => (
              <button key={k} type="button" aria-pressed={sort === k} onClick={() => setSort(k)}
                className={cn('rounded px-2 py-0.5 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  sort === k ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground')}>
                {t(`overview.callCenter.sellers.sort.${k}`)}
              </button>
            ))}
          </div>
        )}
      </header>

      {!data ? (
        q.isError ? (
          <p role="alert" className="text-xs text-destructive">
            {apiErrorText(q.error)}{' '}
            <button type="button" className="underline" onClick={() => { void q.refetch(); }}>{t('common.retry')}</button>
          </p>
        ) : (
          <div className="space-y-2" aria-hidden>
            {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-7 w-full" />)}
          </div>
        )
      ) : shown.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('overview.callCenter.sellers.empty')}</p>
      ) : (
        <ol className="space-y-2">
          {shown.map((r, i) => {
            const v = sort === 'value' ? r.value : r.sales;
            return (
              <li key={r.p.person_id} className="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-x-2 text-[13px]">
                <span className={cn('text-right text-xs font-semibold tabular-nums', i < 3 ? 'text-foreground' : 'text-muted-foreground')}>{i + 1}</span>
                <span className="min-w-0">
                  <Link to={agentsHref(r.p.person_id)}
                    className="block max-w-full truncate rounded-sm font-medium underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    {r.p.name}
                  </Link>
                  <span className="block truncate text-[10px] text-muted-foreground">
                    {teamLaneName(r.p.team_key, r.p.team_lane, teamNames.get(r.p.team_key) ?? null, f)}
                  </span>
                  <span className="mt-0.5 block h-1 rounded-full bg-muted" aria-hidden>
                    <span className="block h-full rounded-full bg-primary/60" style={{ width: `${max > 0 ? (v / max) * 100 : 0}%` }} />
                  </span>
                </span>
                <span className="text-right tabular-nums">
                  {money ? (
                    <>
                      <span className="block font-semibold">{sort === 'value' ? f.den(r.value) : t('overview.callCenter.sellers.salesN', { n: f.int(r.sales), count: r.sales })}</span>
                      <span className="block text-[10px] text-muted-foreground">{sort === 'value' ? t('overview.callCenter.sellers.salesN', { n: f.int(r.sales), count: r.sales }) : f.den(r.value)}</span>
                    </>
                  ) : (
                    <span className="block font-semibold">{t('overview.callCenter.sellers.salesN', { n: f.int(r.sales), count: r.sales })}</span>
                  )}
                </span>
              </li>
            );
          })}
        </ol>
      )}

      {data && (
        <footer className="mt-auto flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t pt-2 text-[11px] text-muted-foreground">
          <span>
            {t('overview.callCenter.sellers.footer', { n: f.int(totalSales), people: f.int(rows.length), count: rows.length })}
            {noSeller > 0 && <> · {t('overview.callCenter.sellers.noSeller', { n: f.int(noSeller) })}</>}
          </span>
          <Link to={agentsHref()} className="inline-flex items-center gap-1 font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {t('overview.callCenter.sellers.all')}<ArrowRight className="h-3 w-3" aria-hidden />
          </Link>
        </footer>
      )}
    </section>
  );
}

/** A product's packages / sales / value in the departments in view. */
function productIn(r: SalesProduct, sources: OverviewSourceKey[] | null) {
  if (!sources) return { units: r.units, sales: r.sales, value: r.value_mkd ?? null };
  const parts = (r.by_source ?? []).filter((s) => sources.includes(s.key as OverviewSourceKey));
  return {
    units: parts.reduce((a, s) => a + (s.units || 0), 0),
    sales: parts.reduce((a, s) => a + (s.sales || 0), 0),
    value: parts.some((s) => s.value_mkd != null) ? parts.reduce((a, s) => a + (s.value_mkd ?? 0), 0) : null,
  };
}

/**
 * "Најпродавани производи" — the period's sales folded by product (GET
 * /insights/sales?part=detail, the Sales tab's own query and cache entry), most
 * packages first. Owners see the value the sales spread over their lines; a
 * department filter counts that department's lines only.
 */
export function TopProductsCard({ q, sources, f, className }: {
  q: QueryState<SalesDetail>;
  sources: OverviewSourceKey[] | null;
  f: InsightsFormat;
  className?: string;
}) {
  const { t } = f;
  const titleId = useId();
  const [sp] = useSearchParams();
  const data = q.data;
  const money = data?.meta?.money === true;
  const rows = useMemo(
    () => (data?.products?.rows ?? [])
      .map((r) => ({ r, ...productIn(r, sources) }))
      .filter((x) => x.units > 0)
      .sort((a, b) => b.units - a.units || b.sales - a.sales || (a.r.name ?? '').localeCompare(b.r.name ?? '')),
    [data, sources],
  );
  const shown = rows.slice(0, TOP_PRODUCTS);
  const max = Math.max(0, ...shown.map((x) => x.units));
  const allUnits = rows.reduce((a, x) => a + x.units, 0);

  return (
    <section aria-labelledby={titleId} className={cn('flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4 shadow-sm', className)}>
      <header className="min-w-0">
        <h3 id={titleId} className="flex items-center gap-1.5 text-sm font-semibold">
          <Package className="h-4 w-4 text-muted-foreground" aria-hidden />{t('overview.callCenter.products.title')}
        </h3>
        <ClockCaption clock="sale" />
        {/* A dept_admin's products are the whole company's counts (access levels, 20260947001600). */}
        {data?.meta?.company_wide === true && <CompanyWideNote compact className="mt-1" />}
      </header>

      {!data ? (
        q.isError ? (
          <p role="alert" className="text-xs text-destructive">
            {apiErrorText(q.error)}{' '}
            <button type="button" className="underline" onClick={() => { void q.refetch(); }}>{t('common.retry')}</button>
          </p>
        ) : (
          <div className="space-y-2" aria-hidden>
            {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-7 w-full" />)}
          </div>
        )
      ) : shown.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('overview.callCenter.products.empty')}</p>
      ) : (
        <ol className="space-y-2">
          {shown.map((x, i) => (
            <li key={x.r.key} className="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-x-2 text-[13px]">
              <span className={cn('text-right text-xs font-semibold tabular-nums', i < 3 ? 'text-foreground' : 'text-muted-foreground')}>{i + 1}</span>
              <span className="min-w-0">
                <span className="block truncate font-medium" title={x.r.name ?? undefined}>{x.r.name || t('insights.common.sentinel.unknown')}</span>
                <span className="block truncate text-[10px] text-muted-foreground">
                  {t('overview.callCenter.products.salesN', { n: f.int(x.sales), count: x.sales })}
                  {money && x.value != null && <> · {f.den(x.value)}</>}
                </span>
                <span className="mt-0.5 block h-1 rounded-full bg-muted" aria-hidden>
                  <span className="block h-full rounded-full bg-emerald-600/60" style={{ width: `${max > 0 ? (x.units / max) * 100 : 0}%` }} />
                </span>
              </span>
              <span className="text-right tabular-nums">
                <span className="block font-semibold">{f.int(x.units)}</span>
                <span className="block text-[10px] text-muted-foreground">{t('overview.callCenter.products.unitsShort')}</span>
              </span>
            </li>
          ))}
        </ol>
      )}

      {data && (
        <footer className="mt-auto flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t pt-2 text-[11px] text-muted-foreground">
          <span>{t('overview.callCenter.products.footer', { units: f.int(allUnits), products: f.int(rows.length), count: rows.length })}</span>
          <Link to={`/insights?${switchTabParams(sp, 'sales').toString()}`}
            className="inline-flex items-center gap-1 font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {t('overview.callCenter.products.all')}<ArrowRight className="h-3 w-3" aria-hidden />
          </Link>
        </footer>
      )}
    </section>
  );
}
