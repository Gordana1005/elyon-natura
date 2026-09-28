import { useId, useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { ListsTrendPoint } from '@/lib/insightsApi/lists';
import { formatDate } from '@/i18n/dates';
import { cn } from '@/lib/utils';
import { dm } from '../overview/useOverviewFormat';
import { ClockCaption } from '../shared/ClockCaption';
import { COHORT_TONE } from '../shared/cohortPalette';
import type { DayRange } from '../shared/period';
import type { InsightsFormat } from '../shared/useInsightsFormat';
import { TREND_PARTS, trendRows } from './listModel';
import { trendColorVar } from './listsPalette';

/**
 * List sales per sale day (per month past 62 days), stacked by where each
 * sale is NOW — the recent days are still to pack / at the courier, the older
 * ones paid or returned. Денари for owners, sales otherwise; one y-axis. The
 * table twin is one toggle away.
 */
export function ListsTrend({ points, granularity, trendFrom, range, money, f }: {
  points: ListsTrendPoint[];
  granularity: 'day' | 'month';
  trendFrom: string;
  range: DayRange;
  money: boolean;
  f: InsightsFormat;
}) {
  const { t } = f;
  const titleId = useId();
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const rows = useMemo(() => trendRows(points, money), [points, money]);
  const parts = TREND_PARTS.filter((k) => rows.some((r) => r[k] > 0));
  const value = (v: number) => (money ? f.den(v) : f.int(v));
  const label = (b: string, long = false) => {
    if (granularity === 'month' || b.length === 7) {
      const [y, m] = b.split('-').map(Number);
      return formatDate(new Date(y, m - 1, 1), long ? 'LLLL yyyy' : 'LLL yy');
    }
    return long ? dm(b, true) : dm(b);
  };
  const extended = trendFrom < range.from;
  const empty = rows.every((r) => r.total === 0);

  return (
    <section aria-labelledby={titleId} className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id={titleId} className="text-base font-semibold">{t('insights.lists.trend.title')}</h2>
          <p className="text-xs text-muted-foreground">
            {money ? t('insights.lists.trend.subtitleMoney') : t('insights.lists.trend.subtitleCount')}
            {' · '}{granularity === 'month' ? t('overview.trend.byMonth') : t('overview.trend.byDay')}
            {extended && <> · {t('insights.lists.trend.extended', { from: dm(trendFrom, true) })}</>}
          </p>
          <ClockCaption clock="sale" />
        </div>
        <div role="group" aria-label={t('overview.trend.viewLabel')} className="inline-flex rounded-lg border p-0.5">
          {(['chart', 'table'] as const).map((v) => (
            <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)}
              className={cn('rounded-md px-2.5 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                view === v ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted')}>
              {t(`overview.trend.${v}`)}
            </button>
          ))}
        </div>
      </div>

      {empty ? (
        <p className="rounded-xl border bg-card p-6 text-center text-sm text-muted-foreground">{t('insights.lists.trend.empty')}</p>
      ) : view === 'chart' ? (
        <figure className="min-w-0 rounded-xl border bg-card p-3 shadow-sm sm:p-4">
          <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {parts.map((k) => (
              <li key={k} className="inline-flex items-center gap-1.5">
                <span className={cn('h-2.5 w-2.5 rounded-sm', COHORT_TONE[k])} aria-hidden />{f.bucketLabel(k)}
              </li>
            ))}
          </ul>
          <div className="h-[240px]" aria-hidden>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={rows} margin={{ top: 6, right: 8, bottom: 0, left: 0 }} barCategoryGap="18%">
                <CartesianGrid vertical={false} stroke="var(--ov-grid)" />
                <XAxis dataKey="d" tickFormatter={(b) => label(String(b))} minTickGap={14}
                  tick={{ fontSize: 11, fill: 'var(--ov-axis)' }} axisLine={{ stroke: 'var(--ov-grid)' }} tickLine={false} />
                <YAxis width={58} tickFormatter={(v) => f.compact(Number(v))} tickCount={4} allowDecimals={false}
                  tick={{ fontSize: 11, fill: 'var(--ov-axis)' }} axisLine={false} tickLine={false} />
                <Tooltip
                  cursor={{ fill: 'var(--ov-grid)', opacity: 0.5 }}
                  content={({ active, payload, label: l }) => {
                    if (!active || !payload?.length) return null;
                    const row = payload[0]?.payload as (typeof rows)[number] | undefined;
                    return (
                      <div className="rounded-md border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md">
                        <div className="mb-1 text-muted-foreground">{label(String(l), true)}</div>
                        {[...parts].reverse().filter((k) => (row?.[k] ?? 0) > 0).map((k) => (
                          <div key={k} className="flex items-center gap-2">
                            <span className={cn('h-2 w-2 rounded-sm', COHORT_TONE[k])} />
                            <span className="font-semibold tabular-nums">{value(row![k])}</span>
                            <span className="text-muted-foreground">{f.bucketLabel(k)}</span>
                          </div>
                        ))}
                        <div className="mt-1 border-t pt-1 font-semibold tabular-nums">{t('insights.lists.trend.total', { value: value(row?.total ?? 0) })}</div>
                      </div>
                    );
                  }}
                />
                {parts.map((k) => (
                  <Bar key={k} dataKey={k} stackId="s" fill={trendColorVar(k)} stroke="hsl(var(--card))" strokeWidth={1}
                    isAnimationActive={false} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        </figure>
      ) : (
        <div className="relative max-h-[420px] overflow-auto rounded-xl border bg-card">
          <table className="w-full min-w-[560px] text-sm">
            <caption className="sr-only">{t('insights.lists.trend.title')}</caption>
            <thead className="sticky top-0 z-10 bg-muted text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="sticky left-0 bg-muted px-3 py-2 text-left font-medium">{t('overview.trend.colPeriod')}</th>
                {parts.map((k) => <th key={k} scope="col" className="px-3 py-2 text-right font-medium">{f.bucketLabel(k)}</th>)}
                <th scope="col" className="px-3 py-2 text-right font-medium">{t('insights.lists.trend.colTotal')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.d} className="border-t">
                  <th scope="row" className="sticky left-0 bg-card px-3 py-1.5 text-left font-medium tabular-nums">{label(r.d, true)}</th>
                  {parts.map((k) => <td key={k} className="px-3 py-1.5 text-right tabular-nums">{r[k] ? value(r[k]) : '—'}</td>)}
                  <td className="px-3 py-1.5 text-right font-semibold tabular-nums">{value(r.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
