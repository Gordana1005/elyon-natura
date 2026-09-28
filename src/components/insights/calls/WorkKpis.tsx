import { useMemo } from 'react';
import { Coffee, Timer } from 'lucide-react';
import type { WorkResponse } from '@/lib/insightsApi/work';
import { cn } from '@/lib/utils';
import { DeltaBadge } from '../overview/KpiRow';
import { Sparkline } from '../overview/Sparkline';
import { delta, fmtNum, type Delta } from '../overview/model';
import { ClockCaption } from '../shared/ClockCaption';
import { formatDmy } from '../shared/period';
import type { InsightsFormat } from '../shared/useInsightsFormat';
import { kpiView, presenceGap, seriesFor, skopjeDayMin, teamLabel, type SeriesPoint } from './workModel';

type TileKey = 'worked' | 'sale' | 'credited' | 'no_answer' | 'people' | 'active';

/**
 * Six stat tiles — decisions, sale decisions, the cohort's credited sales,
 * no-answer clicks, people who worked, active time — each with its change
 * against the previous period and a daily sparkline. A team chip turns them
 * into that team's numbers (no comparison: the previous period is whole-business).
 */
export function WorkKpis({ data, team, f }: { data: WorkResponse; team: string; f: InsightsFormat }) {
  const { t } = f;
  const view = kpiView(data, team);
  const series = useMemo(() => seriesFor(data, team), [data, team]);
  const spark = (pick: (p: SeriesPoint) => number | null) =>
    series.map((p) => ({ d: p.d, v: pick(p) ?? 0 }));
  const cur = view.cur;
  const prev = view.prev;
  const d = (a: number | null | undefined, b: number | null | undefined, good: 'up' | 'down' | 'neutral'): Delta | null =>
    prev ? delta(a, b, good) : null;
  const teamName = team ? teamLabel(data.teams.find((x) => x.team_key === team) ?? { team_key: team, name: null, mode: null }, t) : '';
  const noPresence = presenceGap(data.meta.from, data.meta.presence_since) && !cur?.active_min;
  const prevLabel = prev && data.meta.prev_from && data.meta.prev_to
    ? t('insights.calls.kpi.vsPrev', { period: f.period(data.meta.prev_from, data.meta.prev_to) })
    : null;

  // The comparison reaches back to (or before) the first day of the work
  // ledger: the previous period is incomplete, so its deltas overstate growth.
  const ledgerDay = skopjeDayMin(data.meta.work_since)?.day ?? null;
  const prevBeforeLedger = !!prev && !!data.meta.prev_from && !!ledgerDay && data.meta.prev_from <= ledgerDay;

  if (!cur) return null;
  const tiles: { key: TileKey; value: string; sub: string | null; d: Delta | null; spark: { d: string; v: number }[] | null; accent?: boolean }[] = [
    {
      key: 'worked', value: f.int(cur.worked),
      sub: t('insights.calls.kpi.workedSub', { crm: f.int(cur.via_crm), acpa: f.int(cur.via_altercpa) }),
      d: d(cur.worked, prev?.worked, 'up'), spark: spark((p) => p.worked), accent: true,
    },
    {
      key: 'sale', value: f.int(cur.sale),
      sub: t('insights.calls.kpi.saleSub', { pct: f.pct(cur.conversion) }),
      d: d(cur.sale, prev?.sale, 'up'), spark: spark((p) => p.sale),
    },
    {
      key: 'credited', value: cur.credited == null ? '—' : f.int(cur.credited),
      sub: cur.credited == null ? t('insights.calls.kpi.creditedFailed') : t('insights.calls.kpi.creditedSub'),
      d: data.meta.prev_credited ? d(cur.credited, prev?.credited, 'up') : null, spark: spark((p) => p.credited),
    },
    {
      key: 'no_answer', value: f.int(cur.no_answer),
      sub: cur.reach == null ? null : t('insights.calls.kpi.noAnswerSub', { pct: f.pct(cur.reach) }),
      d: d(cur.no_answer, prev?.no_answer, 'neutral'), spark: spark((p) => p.no_answer),
    },
    {
      key: 'people', value: f.int(cur.people),
      sub: team ? null : t('insights.calls.kpi.peopleSub', { crm: f.int(data.totals.people_crm), acpa: f.int(data.totals.people_altercpa) }),
      d: d(cur.people, prev?.people, 'neutral'), spark: spark((p) => p.people),
    },
    {
      key: 'active', value: cur.active_min ? f.minutes(cur.active_min) : '—',
      sub: cur.per_active_hour != null
        ? t('insights.calls.kpi.activeSub', { n: fmtNum(cur.per_active_hour, f.lang, 1) })
        : noPresence && data.meta.presence_since
          ? t('insights.calls.kpi.activeNone', { date: formatDmy(data.meta.presence_since) })
          : cur.online_min ? t('insights.calls.kpi.onlineSub', { time: f.minutes(cur.online_min) }) : null,
      d: d(cur.active_min, prev?.active_min, 'up'),
      spark: series.some((p) => p.active_min != null) ? spark((p) => p.active_min) : null,
    },
  ];

  return (
    <section aria-labelledby="wk-kpi-title" className="space-y-2">
      <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-1">
        <div>
          <h3 id="wk-kpi-title" className="sr-only">{t('insights.calls.kpi.title')}</h3>
          {view.filtered && (
            <p className="text-[11px] font-medium text-muted-foreground">{t('insights.calls.kpi.filtered', { team: teamName })}</p>
          )}
          <ClockCaption clock={['decided', 'call', 'sale']} />
        </div>
        {prevLabel && <span className="text-[11px] tabular-nums text-muted-foreground">{prevLabel}</span>}
      </div>
      {prevBeforeLedger && ledgerDay && (
        <p role="note" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-[11px] text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          {t('insights.calls.kpi.prevBeforeLedger', { date: formatDmy(ledgerDay) })}
        </p>
      )}
      <ul className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {tiles.map((tile) => (
          <li key={tile.key} className="flex min-w-0 flex-col rounded-xl border bg-card p-3 shadow-sm sm:p-4" title={t(`insights.calls.kpi.hint.${tile.key}`)}>
            <span className="text-xs font-medium leading-tight text-muted-foreground">{t(`insights.calls.kpi.${tile.key}`)}</span>
            <span className="mt-1 block truncate text-xl font-semibold text-card-foreground sm:text-2xl">{tile.value}</span>
            {tile.sub && <span className="truncate text-xs tabular-nums text-muted-foreground" title={tile.sub}>{tile.sub}</span>}
            <div className="mt-1.5 flex min-h-5 flex-wrap items-center gap-2">
              <DeltaBadge d={tile.d} f={f} />
            </div>
            <Sparkline className="mt-auto pt-2" points={tile.spark} accentClass={tile.accent ? 'bg-[#059669] dark:bg-[#10b981]' : undefined} />
          </li>
        ))}
      </ul>
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <Timer className="h-3.5 w-3.5" aria-hidden />
          {cur.timed_calls > 0
            ? t('insights.calls.kpi.timed', {
              n: f.int(cur.timed_calls),
              time: f.minutes(cur.handling_sec / 60),
              avg: f.int(cur.avg_handling_sec),
            })
            : t('insights.calls.kpi.timedNone')}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Coffee className="h-3.5 w-3.5" aria-hidden />
          {t('insights.calls.kpi.breaks', { n: f.int(cur.breaks), time: f.minutes(cur.break_logged_min) })}
        </span>
        {cur.idle_alerts != null && cur.idle_alerts > 0 && (
          <span className={cn('font-medium text-amber-700 dark:text-amber-400')}>
            {t('insights.calls.kpi.idleAlerts', { n: f.int(cur.idle_alerts) })}
          </span>
        )}
      </p>
    </section>
  );
}
