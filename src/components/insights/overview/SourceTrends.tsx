import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { OverviewSourceKey, OverviewTrendPoint } from '@/lib/api';
import { formatDate } from '@/i18n/dates';
import { cn } from '@/lib/utils';
import { sourceColorVar } from './palette';
import { ClockCaption } from '../shared/ClockCaption';
import { dm, type OverviewFormat } from './useOverviewFormat';

interface Row { bucket: string; sales: number; done: number }

/**
 * Small multiples — one panel per department, each with its own single y-axis
 * (never dual): the cohort's SALES by sale day (context gray — the same rows the
 * header counts, bookings included; insights_cohort's spark per department) vs
 * MEX cash by delivery day (the department's hue — insights_overview's trend, it
 * ties to the register). Both lines share one unit — денари for owners, counts
 * otherwise. Without the per-department spark (an older api) it draws the cash
 * alone and points to Sales → trend. The old "placed" line (every order created
 * that day: "no" calls, cancels, trash and open leads included) is gone.
 */
export function SourceTrends({
  points, granularity, sales, sources, money, salesHref, f,
}: {
  points: OverviewTrendPoint[];
  granularity: 'day' | 'month';
  /** model.cohortSalesSeries: bucket → department → sales; null = cash only. */
  sales: Map<string, Partial<Record<OverviewSourceKey, number>>> | null;
  sources: OverviewSourceKey[];
  money: boolean;
  /** Insights → Sales (its trend by source), same period. */
  salesHref: string | null;
  f: OverviewFormat;
}) {
  const { t } = f;
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const bucketLabel = (b: string, long = false) => {
    if (granularity === 'month' || b.length === 7) {
      const [y, m] = b.split('-').map(Number);
      return formatDate(new Date(y, m - 1, 1), long ? 'LLLL yyyy' : 'LLL yy');
    }
    return long ? dm(b, true) : dm(b);
  };
  const withSales = sales != null;
  const rowsBy = useMemo(() => {
    const out: Record<string, Row[]> = {};
    for (const s of sources) {
      out[s] = points.map((p) => {
        const c = p.by_source[s];
        return {
          bucket: p.bucket,
          sales: sales?.get(p.bucket)?.[s] ?? 0,
          done: money ? (c?.delivered_cash_mkd ?? 0) : (c?.delivered_count ?? 0),
        };
      });
    }
    return out;
  }, [points, sources, sales, money]);
  const value = (v: number) => (money ? f.den(v) : f.int(v));
  const salesName = money ? t('overview.trend.sales') : t('overview.trend.salesCount');
  const doneName = money ? t('overview.trend.cash') : t('overview.trend.delivered');
  const subtitle = withSales
    ? (money ? t('overview.trend.subtitleSales') : t('overview.trend.subtitleSalesCount'))
    : (money ? t('overview.trend.subtitleCashOnly') : t('overview.trend.subtitleCashOnlyCount'));

  return (
    <section aria-labelledby="ov-trend-title" className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id="ov-trend-title" className="text-base font-semibold">{t('overview.trend.title')}</h2>
          <p className="text-xs text-muted-foreground">
            {subtitle}
            {' · '}{granularity === 'month' ? t('overview.trend.byMonth') : t('overview.trend.byDay')}
          </p>
          <ClockCaption clock={withSales ? ['sale', 'delivered'] : ['delivered']} />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {salesHref && (
            <Link to={salesHref}
              className="inline-flex items-center gap-1 rounded-md text-xs font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              {t('overview.trend.toSales')}<ArrowRight className="h-3 w-3" aria-hidden />
            </Link>
          )}
          <div role="group" aria-label={t('overview.trend.viewLabel')} className="inline-flex rounded-lg border p-0.5">
            {(['chart', 'table'] as const).map((v) => (
              <button
                key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)}
                className={cn('rounded-md px-2.5 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  view === v ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted')}
              >
                {t(`overview.trend.${v}`)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {points.length === 0 || sources.length === 0 ? (
        <p className="rounded-xl border bg-card p-6 text-center text-sm text-muted-foreground">{t('overview.trend.empty')}</p>
      ) : view === 'chart' ? (
        <>
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-hidden>
            {withSales && (
              <li className="inline-flex items-center gap-1.5"><span className="h-0.5 w-4 rounded-full bg-[var(--ov-context)]" />{salesName}</li>
            )}
            <li className="inline-flex items-center gap-1.5">
              <span className="flex gap-0.5">
                {sources.map((s) => <span key={s} className="h-0.5 w-2 rounded-full" style={{ background: sourceColorVar(s) }} />)}
              </span>
              {doneName}
            </li>
          </ul>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {sources.map((s) => (
              <figure key={s} className="min-w-0 rounded-xl border bg-card p-3 shadow-sm sm:p-4">
                <figcaption className="mb-2 flex items-center gap-2 text-sm font-medium">
                  <span className="h-[3px] w-4 rounded-full" style={{ background: sourceColorVar(s) }} aria-hidden />
                  {f.source(s)}
                </figcaption>
                <div className="h-[180px]" aria-hidden>
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={rowsBy[s]} margin={{ top: 6, right: 18, bottom: 0, left: 0 }}>
                      <CartesianGrid vertical={false} stroke="var(--ov-grid)" />
                      <XAxis
                        dataKey="bucket" tickFormatter={(b) => bucketLabel(String(b))} minTickGap={18}
                        tick={{ fontSize: 11, fill: 'var(--ov-axis)' }} axisLine={{ stroke: 'var(--ov-grid)' }} tickLine={false}
                      />
                      <YAxis
                        width={66} tickFormatter={(v) => f.compact(Number(v))} tickCount={4} allowDecimals={false}
                        tick={{ fontSize: 11, fill: 'var(--ov-axis)' }} axisLine={false} tickLine={false}
                      />
                      <Tooltip
                        cursor={{ stroke: 'var(--ov-axis)', strokeWidth: 1 }}
                        content={({ active, payload, label }) =>
                          active && payload?.length ? (
                            <div className="rounded-md border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md">
                              <div className="mb-1 text-muted-foreground">{bucketLabel(String(label), true)}</div>
                              {payload.map((p) => (
                                <div key={String(p.dataKey)} className="flex items-center gap-2">
                                  <span className="h-0.5 w-3 rounded-full" style={{ background: String(p.color) }} />
                                  <span className="font-semibold tabular-nums">{value(Number(p.value))}</span>
                                  <span className="text-muted-foreground">{p.dataKey === 'sales' ? salesName : doneName}</span>
                                </div>
                              ))}
                            </div>
                          ) : null
                        }
                      />
                      {withSales && (
                        <Line type="linear" dataKey="sales" stroke="var(--ov-context)" strokeWidth={2} dot={false}
                          activeDot={{ r: 4, stroke: 'hsl(var(--card))', strokeWidth: 2 }} isAnimationActive={false} />
                      )}
                      <Line type="linear" dataKey="done" stroke={sourceColorVar(s)} strokeWidth={2} dot={false}
                        activeDot={{ r: 4, stroke: 'hsl(var(--card))', strokeWidth: 2 }} isAnimationActive={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </figure>
            ))}
          </div>
        </>
      ) : (
        <div className="relative max-h-[460px] overflow-auto rounded-xl border bg-card">
          <table className="w-full min-w-[560px] text-sm">
            <caption className="sr-only">{t('overview.trend.title')}</caption>
            <thead className="sticky top-0 z-10 bg-muted text-xs text-muted-foreground">
              <tr>
                <th rowSpan={2} scope="col" className="sticky left-0 bg-muted px-3 py-2 text-left font-medium">{t('overview.trend.colPeriod')}</th>
                {sources.map((s) => (
                  <th key={s} colSpan={withSales ? 2 : 1} scope="colgroup" className="border-l px-3 pt-2 text-center font-medium">{f.source(s)}</th>
                ))}
              </tr>
              <tr>
                {sources.map((s) => [
                  withSales && <th key={`${s}-s`} scope="col" className="border-l px-3 pb-2 text-right font-normal">{salesName}</th>,
                  <th key={`${s}-d`} scope="col" className={cn('px-3 pb-2 text-right font-normal', !withSales && 'border-l')}>{doneName}</th>,
                ])}
              </tr>
            </thead>
            <tbody>
              {points.map((p, i) => (
                <tr key={p.bucket} className="border-t">
                  <th scope="row" className="sticky left-0 bg-card px-3 py-1.5 text-left font-medium tabular-nums">{bucketLabel(p.bucket, true)}</th>
                  {sources.map((s) => [
                    withSales && <td key={`${s}-s`} className="border-l px-3 py-1.5 text-right tabular-nums">{value(rowsBy[s][i].sales)}</td>,
                    <td key={`${s}-d`} className={cn('px-3 py-1.5 text-right tabular-nums', !withSales && 'border-l')}>{value(rowsBy[s][i].done)}</td>,
                  ])}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
