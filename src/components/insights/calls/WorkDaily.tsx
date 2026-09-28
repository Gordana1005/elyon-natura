import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { WorkResponse } from '@/lib/insightsApi/work';
import { cn } from '@/lib/utils';
import { ClockCaption } from '../shared/ClockCaption';
import { StackedBar } from '../shared/StackedBar';
import { dm } from '../overview/useOverviewFormat';
import type { InsightsFormat } from '../shared/useInsightsFormat';
import { OUTCOME_TONE, outcomeVar } from './workPalette';
import { DAY_PARAM, WORK_OUTCOMES, kpiView, outcomeCounts, seriesFor } from './workModel';

/**
 * What the work ended in: the period's outcome mix (one 100 % bar with a
 * labelled legend), then decisions + no-answer clicks per day (or week) as
 * stacked columns — one axis, counts. A day column opens that day's swimlane
 * below. The table twin carries every number the chart draws.
 */
export function WorkDaily({ data, team, f }: { data: WorkResponse; team: string; f: InsightsFormat }) {
  const { t } = f;
  const [, setSp] = useSearchParams();
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const series = useMemo(() => seriesFor(data, team), [data, team]);
  const cur = kpiView(data, team).cur;
  const byWeek = data.meta.gran === 'week';
  const label = (d: string, long = false) => (byWeek ? t('insights.calls.daily.weekOf', { date: dm(d, long) }) : dm(d, long));
  const outcomeLabel = (k: string) => t(`insights.calls.outcome.${k}`);

  const mix = cur ? outcomeCounts(cur) : [];
  const mixTotal = mix.reduce((a, x) => a + x.n, 0);
  const openDay = (d: string) => {
    if (byWeek) return;
    setSp((prev) => { const n = new URLSearchParams(prev); n.set(DAY_PARAM, d); return n; }, { replace: true });
    document.getElementById('wk-day')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const any = series.some((p) => p.worked + p.no_answer > 0);

  return (
    <section aria-labelledby="wk-daily-title" className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h3 id="wk-daily-title" className="text-base font-semibold">{t('insights.calls.daily.title')}</h3>
          <p className="text-xs text-muted-foreground">
            {t('insights.calls.daily.subtitle')} · {byWeek ? t('insights.calls.daily.byWeek') : t('insights.calls.daily.byDay')}
          </p>
          <ClockCaption clock={['decided', 'call']} />
        </div>
        <div role="group" aria-label={t('insights.calls.daily.viewLabel')} className="inline-flex rounded-lg border p-0.5">
          {(['chart', 'table'] as const).map((v) => (
            <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)}
              className={cn('rounded-md px-2.5 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                view === v ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted')}>
              {t(`insights.calls.daily.${v}`)}
            </button>
          ))}
        </div>
      </div>

      {/* The period's mix — words and numbers beside every colour. */}
      <div className="rounded-xl border bg-card p-3 shadow-sm sm:p-4">
        <p className="mb-2 text-xs font-medium text-muted-foreground">{t('insights.calls.daily.mixTitle')}</p>
        <StackedBar
          className="h-3"
          label={t('insights.calls.daily.mixTitle')}
          segments={mix.map((m) => ({
            key: m.key, weight: m.n, tone: OUTCOME_TONE[m.key],
            text: `${outcomeLabel(m.key)} · ${f.int(m.n)} (${f.share(m.n, mixTotal)})`,
          }))}
        />
        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs">
          {mix.map((m) => (
            <li key={m.key} className="inline-flex items-center gap-1.5">
              <span className={cn('h-2.5 w-2.5 rounded-sm', OUTCOME_TONE[m.key])} aria-hidden />
              <span className="text-muted-foreground">{outcomeLabel(m.key)}</span>
              <span className="font-semibold tabular-nums">{f.int(m.n)}</span>
              <span className="tabular-nums text-muted-foreground">{f.share(m.n, mixTotal)}</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-[11px] leading-snug text-muted-foreground">{t('insights.calls.daily.mixNote')}</p>
      </div>

      {!any ? (
        <p className="rounded-xl border bg-card p-6 text-center text-sm text-muted-foreground">{t('insights.calls.daily.empty')}</p>
      ) : view === 'chart' ? (
        <figure className="min-w-0 rounded-xl border bg-card p-3 shadow-sm sm:p-4">
          <div className="h-[240px]" aria-hidden>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={series} margin={{ top: 6, right: 8, bottom: 0, left: 0 }} barCategoryGap="18%"
                onClick={(e) => { const d = (e as { activeLabel?: string } | null)?.activeLabel; if (d) openDay(String(d)); }}>
                <CartesianGrid vertical={false} stroke="var(--wk-grid)" />
                <XAxis dataKey="d" tickFormatter={(d) => dm(String(d))} minTickGap={14}
                  tick={{ fontSize: 11, fill: 'var(--wk-axis)' }} axisLine={{ stroke: 'var(--wk-grid)' }} tickLine={false} />
                <YAxis width={60} tickFormatter={(v) => f.compact(Number(v))} tickCount={4} allowDecimals={false}
                  tick={{ fontSize: 11, fill: 'var(--wk-axis)' }} axisLine={false} tickLine={false} />
                <Tooltip
                  cursor={{ fill: 'hsl(var(--muted))', opacity: 0.6 }}
                  content={({ active, payload, label: d }) => {
                    if (!active || !payload?.length) return null;
                    const p = series.find((x) => x.d === d);
                    if (!p) return null;
                    return (
                      <div className="rounded-md border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md">
                        <div className="mb-1 font-medium">{label(String(d), true)}</div>
                        {[...WORK_OUTCOMES].reverse().map((k) => (
                          <div key={k} className="flex items-center gap-2">
                            <span className={cn('h-2 w-2 rounded-sm', OUTCOME_TONE[k])} />
                            <span className="w-10 text-right font-semibold tabular-nums">{f.int(p[k])}</span>
                            <span className="text-muted-foreground">{outcomeLabel(k)}</span>
                          </div>
                        ))}
                        <div className="mt-1 border-t pt-1 text-muted-foreground">
                          {t('insights.calls.daily.tipPeople', { n: f.int(p.people), credited: f.int(p.credited) })}
                        </div>
                        {!byWeek && <div className="text-[11px] text-muted-foreground">{t('insights.calls.daily.tipOpen')}</div>}
                      </div>
                    );
                  }}
                />
                {WORK_OUTCOMES.map((k, i) => (
                  <Bar key={k} dataKey={k} stackId="o" fill={outcomeVar(k)} isAnimationActive={false}
                    stroke="hsl(var(--card))" strokeWidth={1}
                    radius={i === WORK_OUTCOMES.length - 1 ? [3, 3, 0, 0] : 0}
                    cursor={byWeek ? undefined : 'pointer'} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
          <figcaption className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
            {WORK_OUTCOMES.map((k) => (
              <span key={k} className="inline-flex items-center gap-1.5"><span className={cn('h-2 w-2 rounded-sm', OUTCOME_TONE[k])} aria-hidden />{outcomeLabel(k)}</span>
            ))}
            {!byWeek && <span className="ml-auto">{t('insights.calls.daily.clickHint')}</span>}
          </figcaption>
        </figure>
      ) : (
        <div className="relative max-h-[460px] overflow-auto rounded-xl border bg-card">
          <table className="w-full min-w-[720px] text-sm">
            <caption className="sr-only">{t('insights.calls.daily.title')}</caption>
            <thead className="sticky top-0 z-10 bg-muted text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="sticky left-0 bg-muted px-3 py-2 text-left font-medium">{t('insights.calls.daily.colPeriod')}</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">{t('insights.calls.daily.colWorked')}</th>
                {WORK_OUTCOMES.map((k) => <th key={k} scope="col" className="px-3 py-2 text-right font-medium">{outcomeLabel(k)}</th>)}
                <th scope="col" className="px-3 py-2 text-right font-medium">{t('insights.calls.daily.colCredited')}</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">{t('insights.calls.daily.colPeople')}</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">{t('insights.calls.daily.colActive')}</th>
              </tr>
            </thead>
            <tbody>
              {series.map((p) => (
                <tr key={p.d} className="border-t">
                  <th scope="row" className="sticky left-0 bg-card px-3 py-1.5 text-left font-medium tabular-nums">
                    {byWeek ? label(p.d, true) : (
                      <button type="button" onClick={() => openDay(p.d)} className="rounded-sm underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                        {dm(p.d, true)}
                      </button>
                    )}
                  </th>
                  <td className="px-3 py-1.5 text-right font-semibold tabular-nums">{f.int(p.worked)}</td>
                  {WORK_OUTCOMES.map((k) => <td key={k} className="px-3 py-1.5 text-right tabular-nums">{f.int(p[k])}</td>)}
                  <td className="px-3 py-1.5 text-right tabular-nums">{f.int(p.credited)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{f.int(p.people)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{p.active_min != null ? f.minutes(p.active_min) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
