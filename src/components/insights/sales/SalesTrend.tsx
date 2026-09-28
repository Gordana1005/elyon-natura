import { useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { SalesCore } from '@/lib/insightsApi/sales';
import { formatDate } from '@/i18n/dates';
import { cn } from '@/lib/utils';
import { sourceColorVar } from '../overview/palette';
import { dm } from '../overview/useOverviewFormat';
import { ClockCaption } from '../shared/ClockCaption';
import type { DayRange } from '../shared/period';
import type { InsightsFormat } from '../shared/useInsightsFormat';
import { isPartialBucket, trendRows, trendSources } from './salesModel';

type Measure = 'value' | 'count';
type View = 'chart' | 'table';

/**
 * "Продажби низ времето" — the period's sales per day / ISO week / month,
 * stacked by source (the Overview's fixed source hues, 2 px surface gaps). One
 * measure at a time on ONE axis: денари (owners) or sales — never both. The
 * table is the same numbers.
 */
export function SalesTrend({ core, money, range, f }: { core: SalesCore; money: boolean; range: DayRange; f: InsightsFormat }) {
  const { t } = f;
  const [measure, setMeasure] = useState<Measure>(money ? 'value' : 'count');
  const [view, setView] = useState<View>('chart');
  const byValue = money && measure === 'value';
  const gran = core.trend?.granularity ?? 'day';
  const rows = useMemo(() => trendRows(core.trend?.points ?? [], byValue), [core.trend, byValue]);
  const sources = useMemo(() => trendSources(rows), [rows]);
  const fmt = (v: number) => (byValue ? f.den(v) : f.int(v));
  const label = (d: string, long = false) => {
    if (gran === 'month') {
      const [y, m] = d.split('-').map(Number);
      return formatDate(new Date(y, m - 1, 1), long ? 'LLLL yyyy' : 'LLL yy');
    }
    if (gran === 'week') return long ? t('insights.sales.trend.weekOf', { d: dm(d, true) }) : dm(d);
    return long ? dm(d, true) : dm(d);
  };
  const partial = (d: string) => isPartialBucket(d, gran, range.from, range.to);

  return (
    <section aria-labelledby="sa-trend-title" className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id="sa-trend-title" className="text-base font-semibold">{t('insights.sales.trend.title')}</h2>
          <p className="text-xs text-muted-foreground">
            {byValue ? t('insights.sales.trend.subtitleValue') : t('insights.sales.trend.subtitleCount')}
            {' · '}{t(`insights.sales.trend.gran.${gran}`)}
          </p>
          <ClockCaption clock="sale" />
        </div>
        <div className="flex flex-wrap gap-2">
          {money && (
            <Toggle label={t('insights.sales.trend.measureLabel')} value={measure} onChange={setMeasure}
              options={[['value', t('insights.sales.trend.byValue')], ['count', t('insights.sales.trend.byCount')]]} />
          )}
          <Toggle label={t('overview.trend.viewLabel')} value={view} onChange={setView}
            options={[['chart', t('overview.trend.chart')], ['table', t('overview.trend.table')]]} />
        </div>
      </div>

      {rows.length === 0 || rows.every((r) => r.total === 0) ? (
        <p className="rounded-xl border bg-card p-6 text-center text-sm text-muted-foreground">{t('insights.sales.empty')}</p>
      ) : view === 'chart' ? (
        <figure className="min-w-0 rounded-xl border bg-card p-3 shadow-sm sm:p-4">
          <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-hidden>
            {sources.map((s) => (
              <li key={s} className="inline-flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-sm" style={{ background: sourceColorVar(s) }} />{f.sourceLabel(s)}
              </li>
            ))}
          </ul>
          <div className="h-[260px]" aria-hidden>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={rows} margin={{ top: 6, right: 8, bottom: 0, left: 0 }} barCategoryGap="18%">
                <CartesianGrid vertical={false} stroke="var(--ov-grid)" />
                <XAxis dataKey="d" tickFormatter={(d) => label(String(d))} minTickGap={14}
                  tick={{ fontSize: 11, fill: 'var(--ov-axis)' }} axisLine={{ stroke: 'var(--ov-grid)' }} tickLine={false} />
                <YAxis width={byValue ? 70 : 44} tickFormatter={(v) => f.compact(Number(v))} tickCount={5} allowDecimals={false}
                  tick={{ fontSize: 11, fill: 'var(--ov-axis)' }} axisLine={false} tickLine={false} />
                <Tooltip
                  cursor={{ fill: 'var(--ov-grid)', opacity: 0.5 }}
                  content={({ active, payload, label: d }) => {
                    if (!active || !payload?.length) return null;
                    const row = rows.find((r) => r.d === d);
                    return (
                      <div className="rounded-md border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md">
                        <div className="mb-1 text-muted-foreground">
                          {label(String(d), true)}{partial(String(d)) ? ` ${t('insights.sales.trend.partial')}` : ''}
                        </div>
                        {[...payload].reverse().map((p) => (
                          <div key={String(p.dataKey)} className="flex items-center gap-2">
                            <span className="h-2 w-2 rounded-sm" style={{ background: String(p.color) }} />
                            <span className="text-muted-foreground">{f.sourceLabel(String(p.dataKey))}</span>
                            <span className="ml-auto pl-3 font-semibold tabular-nums">{fmt(Number(p.value))}</span>
                          </div>
                        ))}
                        {row && (
                          <div className="mt-1 flex justify-between gap-3 border-t pt-1 font-semibold tabular-nums">
                            <span>{t('insights.common.table.total')}</span><span>{fmt(row.total)}</span>
                          </div>
                        )}
                      </div>
                    );
                  }}
                />
                {sources.map((s) => (
                  <Bar key={s} dataKey={s} stackId="sales" fill={sourceColorVar(s)} stroke="hsl(var(--card))" strokeWidth={1}
                    isAnimationActive={false} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
          <figcaption className="sr-only">{t('insights.sales.trend.title')}</figcaption>
        </figure>
      ) : (
        <div className="relative max-h-[460px] overflow-auto rounded-xl border bg-card">
          <table className="w-full min-w-[560px] text-sm">
            <caption className="sr-only">{t('insights.sales.trend.title')}</caption>
            <thead className="sticky top-0 z-10 bg-muted text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="sticky left-0 bg-muted px-3 py-2 text-left font-medium">{t('overview.trend.colPeriod')}</th>
                {sources.map((s) => <th key={s} scope="col" className="px-3 py-2 text-right font-medium">{f.sourceLabel(s)}</th>)}
                <th scope="col" className="px-3 py-2 text-right font-medium">{t('insights.common.table.total')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.d} className="border-t">
                  <th scope="row" className="sticky left-0 bg-card px-3 py-1.5 text-left font-medium tabular-nums">
                    {label(r.d, true)}{partial(r.d) && <span className="ml-1 text-[11px] font-normal text-muted-foreground">{t('insights.sales.trend.partial')}</span>}
                  </th>
                  {sources.map((s) => <td key={s} className="px-3 py-1.5 text-right tabular-nums">{fmt(r[s] ?? 0)}</td>)}
                  <td className="px-3 py-1.5 text-right font-semibold tabular-nums">{fmt(r.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function Toggle<T extends string>({ label, value, onChange, options }: {
  label: string; value: T; onChange: (v: T) => void; options: [T, string][];
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-lg border bg-card p-0.5">
      {options.map(([v, text]) => (
        <button
          key={v} type="button" aria-pressed={value === v} onClick={() => onChange(v)}
          className={cn('rounded-md px-2.5 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            value === v ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted')}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

