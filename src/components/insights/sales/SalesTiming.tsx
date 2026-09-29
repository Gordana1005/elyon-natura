import { Info } from 'lucide-react';
import type { SalesCore } from '@/lib/insightsApi/sales';
import { cn } from '@/lib/utils';
import { fmtNum } from '../overview/model';
import { ClockCaption } from '../shared/ClockCaption';
import type { InsightsFormat } from '../shared/useInsightsFormat';
import { HEAT_STEPS, heatGrid, hourSpan, ratio } from './salesModel';
import { HEAT_INK, HEAT_TONE, NEUTRAL_BAR } from './salesPalette';

const DOWS = [1, 2, 3, 4, 5, 6, 7] as const;

/**
 * "Кога продаваме" — weekday × hour (Skopje) of the sales that carry a real
 * moment: an agent's decision (in the CRM or the AlterCPA panel), a web
 * checkout. collabBox orders
 * carry a date only and a MEX-only parcel's time is its label, so they are
 * counted apart — never smeared into the grid. The grid is a table: every
 * cell prints its number; the blue ramp only helps the eye (legend below).
 * Beneath it, every sale by weekday, per calendar day of that weekday.
 */
export function SalesTiming({ core, f }: { core: SalesCore; f: InsightsFormat }) {
  const { t } = f;
  const tm = core.timing;
  const g = heatGrid(tm);
  const [lo, hi] = hourSpan(g.byHour);
  const hours = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  const dayShort = (d: number) => t(`insights.sales.timing.dow.d${d}`);
  const dayLong = (d: number) => t(`insights.sales.timing.dowLong.d${d}`);
  const hh = (h: number) => String(h).padStart(2, '0');
  const untimed = (tm?.untimed ?? []).filter((u) => u.count > 0);
  const weekdays = tm?.weekdays ?? [];
  const perDay = weekdays.map((w) => ({ ...w, avg: ratio(w.count, w.days) }));
  const maxAvg = Math.max(1, ...perDay.map((w) => w.avg ?? 0));

  return (
    <section aria-labelledby="sa-timing-title" className="space-y-3">
      <div>
        <h2 id="sa-timing-title" className="text-base font-semibold">{t('insights.sales.timing.title')}</h2>
        <p className="text-xs text-muted-foreground">{t('insights.sales.timing.subtitle', { n: f.int(tm?.timed ?? 0) })}</p>
        <ClockCaption clock="sale" className="mt-0.5" />
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1fr_18rem]">
        <div className="min-w-0 rounded-xl border bg-card p-3 shadow-sm sm:p-4">
          {g.max === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">{t('insights.sales.timing.empty')}</p>
          ) : (
            <>
              {g.peak && (
                <p className="mb-2 text-xs">
                  {t('insights.sales.timing.peak', { day: dayLong(g.peak.dow), hour: hh(g.peak.hour), n: f.int(g.peak.count) })}
                </p>
              )}
              <div className="overflow-x-auto">
                <table className="border-separate border-spacing-[2px] text-[10px] tabular-nums">
                  <caption className="sr-only">{t('insights.sales.timing.title')}</caption>
                  <thead>
                    <tr>
                      <th scope="col" className="sticky left-0 z-10 bg-card" />
                      {hours.map((h) => (
                        <th key={h} scope="col" className="min-w-[1.75rem] px-0.5 text-center font-normal text-muted-foreground">{hh(h)}</th>
                      ))}
                      <th scope="col" className="pl-1.5 text-right font-medium text-muted-foreground">Σ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {DOWS.map((d) => (
                      <tr key={d}>
                        <th scope="row" className="sticky left-0 z-10 bg-card pr-1.5 text-left text-[11px] font-medium">{dayShort(d)}</th>
                        {hours.map((h) => {
                          const n = g.cells[d - 1][h];
                          const s = g.step(n);
                          return (
                            <td key={h} title={`${dayLong(d)} ${hh(h)}:00 · ${f.int(n)}`}
                              className={cn('h-6 min-w-[1.75rem] rounded-[3px] text-center align-middle', HEAT_TONE[s], HEAT_INK[s], n === 0 && 'text-transparent')}>
                              {n > 0 ? f.int(n) : <span className="sr-only">0</span>}
                            </td>
                          );
                        })}
                        <td className="pl-1.5 text-right text-[11px] font-semibold">{f.int(g.byDow[d - 1])}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th scope="row" className="sticky left-0 z-10 bg-card pr-1.5 text-left text-[11px] font-medium text-muted-foreground">Σ</th>
                      {hours.map((h) => <td key={h} className="text-center text-muted-foreground">{g.byHour[h] > 0 ? f.int(g.byHour[h]) : ''}</td>)}
                      <td className="pl-1.5 text-right text-[11px] font-semibold">{f.int(tm?.timed ?? 0)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground" aria-hidden>
                <span>{t('insights.sales.timing.legendLow')}</span>
                {Array.from({ length: HEAT_STEPS }, (_, i) => (
                  <span key={i} className={cn('h-3 w-5 rounded-[3px]', HEAT_TONE[i + 1])} />
                ))}
                <span>{t('insights.sales.timing.legendHigh', { n: f.int(g.max) })}</span>
              </div>
            </>
          )}
          {untimed.length > 0 && (
            <p className="mt-2 flex items-start gap-1 text-[11px] leading-snug text-muted-foreground">
              <Info className="mt-px h-3 w-3 shrink-0" aria-hidden />
              <span>
                {t('insights.sales.timing.untimed', {
                  list: untimed.map((u) => `${f.sourceLabel(u.key)}${u.kind === 'mex' ? ` (${t('insights.common.table.mexOnlyTag')})` : ''} ${f.int(u.count)}`).join(' · '),
                })}
              </span>
            </p>
          )}
        </div>

        <div className="min-w-0 rounded-xl border bg-card p-3 shadow-sm sm:p-4">
          <h3 className="text-sm font-medium">{t('insights.sales.timing.weekdaysTitle')}</h3>
          <p className="mb-2 text-[11px] text-muted-foreground">{t('insights.sales.timing.weekdaysHint')}</p>
          <ul className="space-y-1.5">
            {perDay.map((w) => (
              <li key={w.dow} className="grid grid-cols-[2.25rem_1fr_auto] items-center gap-2 text-xs">
                <span className="font-medium">{dayShort(w.dow)}</span>
                <span className="h-3 rounded-sm bg-muted" aria-hidden>
                  <span className={cn('block h-full rounded-sm', NEUTRAL_BAR)} style={{ width: `${((w.avg ?? 0) / maxAvg) * 100}%` }} />
                </span>
                <span className="tabular-nums" title={t('insights.sales.timing.weekdayTitle', { n: f.int(w.count), days: f.int(w.days) })}>
                  <b className="font-semibold">{w.avg != null ? fmtNum(w.avg, f.lang, w.avg < 10 ? 1 : 0) : '—'}</b>
                  <span className="ml-1 text-muted-foreground">{t('insights.sales.timing.perDay')}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
