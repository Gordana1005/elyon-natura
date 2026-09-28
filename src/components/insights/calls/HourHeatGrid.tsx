import { useMemo, useState } from 'react';
import type { WorkResponse } from '@/lib/insightsApi/work';
import { cn } from '@/lib/utils';
import { ClockCaption } from '../shared/ClockCaption';
import type { InsightsFormat } from '../shared/useInsightsFormat';
import { HEAT_TONE } from './workPalette';
import { heatBin, heatBreaks, heatGrid, peopleFor, teamLabel, type HeatMetric } from './workModel';

/** A bin's bounds as text: "0", "3", "4–7". */
function binRange(b: number, breaks: number[]): string {
  if (b === 0) return '0';
  const lo = b === 1 ? 1 : breaks[b - 2] + 1;
  const hi = breaks[b - 1];
  return lo >= hi ? String(hi) : `${lo}–${hi}`;
}

/**
 * When the work happens: Skopje hour × person, one blue ramp (more = darker;
 * dark mode flips to lighter). The top row is everyone together. Hovering or
 * focusing a cell reads it out in words above the grid; the legend states the
 * bin bounds. Shows shift coverage, late starts, lunch gaps and night work.
 */
export function HourHeatGrid({ data, team, f }: { data: WorkResponse; team: string; f: InsightsFormat }) {
  const { t } = f;
  const [metric, setMetric] = useState<HeatMetric>('all');
  const [hover, setHover] = useState<string | null>(null);
  const people = useMemo(() => peopleFor(data, team), [data, team]);
  const names = useMemo(() => new Map(people.map((p) => [p.person_id, p])), [people]);
  const grid = useMemo(() => heatGrid(data.by_hour, people.map((p) => p.person_id), metric), [data.by_hour, people, metric]);
  const breaks = useMemo(() => heatBreaks(grid.rows.flatMap((r) => r.cells)), [grid]);
  const allBreaks = useMemo(() => heatBreaks(grid.all), [grid]);
  const cols = grid.hours.length;
  const unit = (n: number) => (metric === 'all' ? t('insights.calls.heat.nAll', { count: n, n: f.int(n) }) : t('insights.calls.heat.nDecisions', { count: n, n: f.int(n) }));
  const cellText = (who: string, h: number, n: number) =>
    t('insights.calls.heat.cell', { name: who, from: `${String(h).padStart(2, '0')}:00`, to: `${String((h + 1) % 24).padStart(2, '0')}:00`, what: unit(n) });

  return (
    <section aria-labelledby="wk-heat-title" className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h3 id="wk-heat-title" className="text-base font-semibold">{t('insights.calls.heat.title')}</h3>
          <p className="text-xs text-muted-foreground">{t('insights.calls.heat.subtitle')}</p>
          <ClockCaption clock={['decided', 'call']} />
        </div>
        <div role="group" aria-label={t('insights.calls.heat.metricLabel')} className="inline-flex rounded-lg border p-0.5">
          {(['all', 'decisions'] as const).map((v) => (
            <button key={v} type="button" aria-pressed={metric === v} onClick={() => setMetric(v)}
              className={cn('rounded-md px-2.5 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                metric === v ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted')}>
              {t(`insights.calls.heat.metric.${v}`)}
            </button>
          ))}
        </div>
      </div>

      {grid.rows.length === 0 ? (
        <p className="rounded-xl border bg-card p-6 text-center text-sm text-muted-foreground">{t('insights.calls.heat.empty')}</p>
      ) : (
        <div className="rounded-xl border bg-card p-3 shadow-sm sm:p-4">
          <p className="mb-2 min-h-4 text-xs tabular-nums text-muted-foreground" aria-live="polite">{hover ?? t('insights.calls.heat.hint')}</p>
          <div className="overflow-x-auto">
            <div className="grid min-w-[640px] gap-px" style={{ gridTemplateColumns: `minmax(120px,170px) repeat(${cols}, minmax(18px,1fr))` }}
              onPointerLeave={() => setHover(null)}>
              {/* hour axis */}
              <div />
              {grid.hours.map((h) => (
                <div key={`h${h}`} className="pb-1 text-center text-[10px] tabular-nums text-muted-foreground">{String(h).padStart(2, '0')}</div>
              ))}
              {/* everyone */}
              <div className="truncate pr-2 text-xs font-semibold">{t('insights.calls.heat.all')}</div>
              {grid.hours.map((h) => {
                const n = grid.all[h];
                const text = cellText(t('insights.calls.heat.all'), h, n);
                return (
                  <div key={`a${h}`} tabIndex={0} aria-label={text} onPointerEnter={() => setHover(text)} onFocus={() => setHover(text)}
                    className={cn('h-6 rounded-[3px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', HEAT_TONE[heatBin(n, allBreaks)])} />
                );
              })}
              <div className="col-span-full h-2" />
              {grid.rows.map((r) => {
                const p = r.id ? names.get(r.id) : null;
                const who = p?.name ?? t('insights.calls.heat.nobody');
                return [
                  <div key={`n${r.id}`} className="flex min-w-0 items-center gap-1 truncate pr-2 text-xs" title={p ? `${who} · ${teamLabel(data.teams.find((x) => x.team_key === p.team_key) ?? { team_key: p.team_key, name: null, mode: null }, t)}` : who}>
                    <span className="truncate">{who}</span>
                    <span className="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground">{f.int(r.total)}</span>
                  </div>,
                  ...grid.hours.map((h) => {
                    const n = r.cells[h];
                    const text = cellText(who, h, n);
                    return (
                      <div key={`${r.id}-${h}`} tabIndex={-1} aria-label={text} onPointerEnter={() => setHover(text)}
                        className={cn('h-5 rounded-[3px]', HEAT_TONE[heatBin(n, breaks)])} />
                    );
                  }),
                ];
              })}
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground" aria-hidden>
            <span>{t('insights.calls.heat.legendLess')}</span>
            {[0, 1, 2, 3, 4, 5].map((b) => (
              <span key={b} className="inline-flex items-center gap-1">
                <span className={cn('h-3 w-4 rounded-[3px]', HEAT_TONE[b])} />
                <span className="tabular-nums">{binRange(b, breaks)}</span>
              </span>
            ))}
            <span>{t('insights.calls.heat.legendMore')}</span>
            <span className="ml-auto">{t('insights.calls.heat.legendNote')}</span>
          </div>
        </div>
      )}
    </section>
  );
}
