import { useId, useState } from 'react';
import { Bar, CartesianGrid, Cell, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatDate } from '@/i18n/dates';
import { cn } from '@/lib/utils';
import type { ProfitTrendPoint } from '@/lib/insightsApi/profit';
import { dm } from '../overview/useOverviewFormat';
import { ClockCaption } from '../shared/ClockCaption';
import type { InsightsFormat } from '../shared/useInsightsFormat';
import { PP_FILL, ppVar } from './profitPalette';

/**
 * Net profit per day (or month): columns on one денари axis, the collected
 * revenue as the context line. A loss day drops below the zero line in red.
 * On the cohort clock the latest days are still at the courier — their
 * profit grows as MEX delivers (said under the chart). Table twin one click away.
 */
export function ProfitTrend({ points, granularity, cohort, f }: {
  points: ProfitTrendPoint[];
  granularity: 'day' | 'month';
  cohort: boolean;
  f: InsightsFormat;
}) {
  const { t } = f;
  const titleId = useId();
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const label = (b: string, long = false) => {
    if (granularity === 'month' || b.length === 7) {
      const [y, m] = b.split('-').map(Number);
      return formatDate(new Date(y, m - 1, 1), long ? 'LLLL yyyy' : 'LLL yy');
    }
    return long ? dm(b, true) : dm(b);
  };
  const netName = t('insights.profit.trend.net');
  const revName = t('insights.profit.trend.revenue');

  return (
    <section aria-labelledby={titleId} className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id={titleId} className="text-base font-semibold">{t('insights.profit.trend.title')}</h2>
          <p className="text-xs text-muted-foreground">
            {granularity === 'month' ? t('insights.profit.trend.byMonth') : t('insights.profit.trend.byDay')}
          </p>
          <ClockCaption clock={cohort ? 'sale' : 'delivered'} />
        </div>
        <div role="group" aria-label={t('insights.profit.trend.viewLabel')} className="inline-flex rounded-lg border p-0.5">
          {(['chart', 'table'] as const).map((v) => (
            <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)}
              className={cn('rounded-md px-2.5 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                view === v ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted')}>
              {t(`insights.profit.trend.${v}`)}
            </button>
          ))}
        </div>
      </div>

      {points.length === 0 ? (
        <p className="rounded-xl border bg-card p-6 text-center text-sm text-muted-foreground">{t('insights.profit.empty')}</p>
      ) : view === 'chart' ? (
        <figure className="min-w-0 rounded-xl border bg-card p-3 shadow-sm sm:p-4">
          <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-hidden>
            <li className="inline-flex items-center gap-1.5"><span className={cn('h-2.5 w-2.5 rounded-sm', PP_FILL.net)} />{netName}</li>
            <li className="inline-flex items-center gap-1.5"><span className={cn('h-2.5 w-2.5 rounded-sm', PP_FILL.loss)} />{t('insights.profit.trend.loss')}</li>
            <li className="inline-flex items-center gap-1.5"><span className="h-0.5 w-4 rounded-full" style={{ background: ppVar('rev') }} />{revName}</li>
          </ul>
          <div className="h-[240px]" aria-hidden>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={points} margin={{ top: 6, right: 12, bottom: 0, left: 0 }}>
                <CartesianGrid vertical={false} stroke={ppVar('grid')} />
                <XAxis dataKey="d" tickFormatter={(b) => label(String(b))} minTickGap={16}
                  tick={{ fontSize: 11, fill: ppVar('axis') }} axisLine={{ stroke: ppVar('grid') }} tickLine={false} />
                <YAxis width={66} tickFormatter={(v) => f.compact(Number(v))} tickCount={5}
                  tick={{ fontSize: 11, fill: ppVar('axis') }} axisLine={false} tickLine={false} />
                <ReferenceLine y={0} stroke={ppVar('axis')} />
                <Tooltip
                  cursor={{ fill: 'hsl(var(--muted))', opacity: 0.5 }}
                  content={({ active, payload, label: l }) => {
                    if (!active || !payload?.length) return null;
                    const p = payload[0].payload as ProfitTrendPoint;
                    return (
                      <div className="rounded-md border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md">
                        <div className="mb-1 text-muted-foreground">{label(String(l), true)}</div>
                        <div className="tabular-nums"><b>{f.den(p.net_mkd)}</b> {netName}</div>
                        <div className="tabular-nums text-muted-foreground">{f.den(p.revenue_mkd)} {revName} · {t('insights.profit.trend.salesN', { n: f.int(p.sales) })}</div>
                      </div>
                    );
                  }}
                />
                <Bar dataKey="net_mkd" maxBarSize={24} radius={[4, 4, 0, 0]} isAnimationActive={false}>
                  {points.map((p) => <Cell key={p.d} fill={p.net_mkd < 0 ? ppVar('loss') : ppVar('net')} />)}
                </Bar>
                <Line type="linear" dataKey="revenue_mkd" stroke={ppVar('rev')} strokeWidth={2} dot={false}
                  activeDot={{ r: 4, stroke: 'hsl(var(--card))', strokeWidth: 2 }} isAnimationActive={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          {cohort && <figcaption className="mt-2 text-[11px] text-muted-foreground">{t('insights.profit.trend.cohortNote')}</figcaption>}
        </figure>
      ) : (
        <div className="relative max-h-[420px] overflow-auto rounded-xl border bg-card">
          <table className="w-full min-w-[420px] text-sm">
            <caption className="sr-only">{t('insights.profit.trend.title')}</caption>
            <thead className="sticky top-0 z-10 bg-muted text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2 text-left font-medium">{t('insights.profit.trend.colPeriod')}</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">{t('insights.profit.table.sales')}</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">{revName}</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">{netName}</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">{t('insights.profit.table.margin')}</th>
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.d} className="border-t">
                  <th scope="row" className="px-3 py-1.5 text-left font-medium tabular-nums">{label(p.d, true)}</th>
                  <td className="px-3 py-1.5 text-right tabular-nums">{f.int(p.sales)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{f.den(p.revenue_mkd)}</td>
                  <td className={cn('px-3 py-1.5 text-right tabular-nums', p.net_mkd < 0 && 'text-red-700 dark:text-red-400')}>{f.den(p.net_mkd)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{f.pct(p.revenue_mkd > 0 ? p.net_mkd / p.revenue_mkd : null)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
