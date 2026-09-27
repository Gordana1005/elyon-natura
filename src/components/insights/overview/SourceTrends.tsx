import { useMemo, useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { OverviewSourceKey, OverviewTrendPoint } from '@/lib/api';
import { eurToDen } from '@/lib/currency';
import { formatDate } from '@/i18n/dates';
import { cn } from '@/lib/utils';
import { sourceColorVar } from './palette';
import { dm, type OverviewFormat } from './useOverviewFormat';

interface Row { bucket: string; placed: number; done: number }

/**
 * Small multiples — one panel per source, each with its own single y-axis
 * (never dual): placed (context gray) vs collected / delivered (the source hue).
 * Both lines share one unit — денари for owners, counts otherwise.
 */
export function SourceTrends({
  points, granularity, sources, money, f,
}: {
  points: OverviewTrendPoint[];
  granularity: 'day' | 'month';
  sources: OverviewSourceKey[];
  money: boolean;
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
  const rowsBy = useMemo(() => {
    const out: Record<string, Row[]> = {};
    for (const s of sources) {
      out[s] = points.map((p) => {
        const c = p.by_source[s];
        return {
          bucket: p.bucket,
          placed: money ? eurToDen(c?.placed_value_eur ?? 0) : (c?.placed_count ?? 0),
          done: money ? (c?.delivered_cash_mkd ?? 0) : (c?.delivered_count ?? 0),
        };
      });
    }
    return out;
  }, [points, sources, money]);
  const value = (v: number) => (money ? f.den(v) : f.int(v));
  const placedName = money ? t('overview.trend.placed') : t('overview.trend.placedCount');
  const doneName = money ? t('overview.trend.cash') : t('overview.trend.delivered');

  return (
    <section aria-labelledby="ov-trend-title" className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id="ov-trend-title" className="text-base font-semibold">{t('overview.trend.title')}</h2>
          <p className="text-xs text-muted-foreground">
            {money ? t('overview.trend.subtitleMoney') : t('overview.trend.subtitleCount')}
            {' · '}{granularity === 'month' ? t('overview.trend.byMonth') : t('overview.trend.byDay')}
          </p>
        </div>
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

      {points.length === 0 || sources.length === 0 ? (
        <p className="rounded-xl border bg-card p-6 text-center text-sm text-muted-foreground">{t('overview.trend.empty')}</p>
      ) : view === 'chart' ? (
        <>
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-hidden>
            <li className="inline-flex items-center gap-1.5"><span className="h-0.5 w-4 rounded-full bg-[var(--ov-context)]" />{placedName}</li>
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
                                  <span className="text-muted-foreground">{p.dataKey === 'placed' ? placedName : doneName}</span>
                                </div>
                              ))}
                            </div>
                          ) : null
                        }
                      />
                      <Line type="linear" dataKey="placed" stroke="var(--ov-context)" strokeWidth={2} dot={false}
                        activeDot={{ r: 4, stroke: 'hsl(var(--card))', strokeWidth: 2 }} isAnimationActive={false} />
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
                  <th key={s} colSpan={2} scope="colgroup" className="border-l px-3 pt-2 text-center font-medium">{f.source(s)}</th>
                ))}
              </tr>
              <tr>
                {sources.map((s) => [
                  <th key={`${s}-p`} scope="col" className="border-l px-3 pb-2 text-right font-normal">{placedName}</th>,
                  <th key={`${s}-d`} scope="col" className="px-3 pb-2 text-right font-normal">{doneName}</th>,
                ])}
              </tr>
            </thead>
            <tbody>
              {points.map((p, i) => (
                <tr key={p.bucket} className="border-t">
                  <th scope="row" className="sticky left-0 bg-card px-3 py-1.5 text-left font-medium tabular-nums">{bucketLabel(p.bucket, true)}</th>
                  {sources.map((s) => [
                    <td key={`${s}-p`} className="border-l px-3 py-1.5 text-right tabular-nums">{value(rowsBy[s][i].placed)}</td>,
                    <td key={`${s}-d`} className="px-3 py-1.5 text-right tabular-nums">{value(rowsBy[s][i].done)}</td>,
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
