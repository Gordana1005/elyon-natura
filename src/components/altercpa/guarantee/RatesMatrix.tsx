import { cn } from '@/lib/utils';
import type { InsightsFormat } from '@/components/insights/shared/useInsightsFormat';
import type { CohortView, RatesDay } from '@/lib/altercpaGuaranteeApi';
import { rateToneClass } from './guaranteeText';

export type CellPick = (day: string, wm: string) => void;

/**
 * Стапки from xl: one row per Skopje arrival day, one column per webmaster (most leads first)
 * and "Вкупно MK". A cell = the rate (coloured against the target once judged), counted / leads
 * and the open leads still undecided. Click → the cohort's sheet.
 */
export function RatesMatrix({ days, webmasters, wmName, f, onPick, selected }: {
  days: RatesDay[];
  webmasters: string[];
  wmName: (wm: string) => string;
  f: InsightsFormat;
  onPick: CellPick;
  selected: { day: string; wm: string } | null;
}) {
  const { t } = f;
  return (
    <table className="w-full table-fixed border-separate border-spacing-0 text-sm" data-testid="rates-matrix">
      <thead>
        <tr className="text-[11px] uppercase tracking-wide text-muted-foreground">
          <th scope="col" className="w-28 border-b px-2 py-2 text-left font-medium">{t('altercpaGuarantee.rates.day')}</th>
          {webmasters.map((wm) => (
            <th key={wm} scope="col" className="break-words border-b px-2 py-2 text-right font-medium normal-case">{wmName(wm)}</th>
          ))}
          <th scope="col" className="border-b border-l px-2 py-2 text-right font-medium">{t('altercpaGuarantee.rates.totalMk')}</th>
        </tr>
      </thead>
      <tbody>
        {days.map((d) => (
          <tr key={d.day} className={cn(!d.settled && 'bg-muted/30')}>
            <th scope="row" className="border-b px-2 py-1.5 text-left font-medium">
              <span className="block tabular-nums">{f.period(d.day, d.day)}</span>
              {!d.settled && <span className="block text-[10px] font-normal text-muted-foreground">{t('altercpaGuarantee.rates.settlingDay')}</span>}
            </th>
            {webmasters.map((wm) => {
              const v = d.webmasters.find((w) => w.webmaster === wm);
              return (
                <td key={wm} className="border-b p-0.5 text-right">
                  {v ? <Cell v={v} f={f} label={`${wmName(wm)} · ${f.period(d.day, d.day)}`} active={selected?.day === d.day && selected.wm === wm} onClick={() => onPick(d.day, wm)} />
                    : <span className="block px-2 py-1.5 text-muted-foreground">—</span>}
                </td>
              );
            })}
            <td className="border-b border-l p-0.5 text-right">
              <Cell v={d.totals} f={f} strong label={`${t('altercpaGuarantee.rates.totalMk')} · ${f.period(d.day, d.day)}`}
                active={selected?.day === d.day && selected.wm === '*'} onClick={() => onPick(d.day, '*')} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Cell({ v, f, onClick, active, strong, label }: { v: CohortView; f: InsightsFormat; onClick: () => void; active: boolean; strong?: boolean; label: string }) {
  const { t } = f;
  return (
    <button type="button" onClick={onClick} aria-label={label} aria-pressed={active}
      className={cn('flex w-full flex-col items-end rounded-md px-2 py-1 text-right transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active && 'bg-primary/10 ring-1 ring-primary/40')}>
      <span className={cn('tabular-nums', strong ? 'font-bold' : 'font-semibold', rateToneClass(v.state, v.math))}>{f.pct(v.math.rate)}</span>
      <span className="text-[11px] tabular-nums text-muted-foreground">{f.int(v.counted)}/{f.int(v.leads)}</span>
      {v.open > 0 && (
        <span className="mt-0.5 rounded-full bg-sky-100 px-1.5 text-[10px] font-medium tabular-nums text-sky-800 dark:bg-sky-500/15 dark:text-sky-300">
          {t('altercpaGuarantee.rates.openBadge', { n: f.int(v.open) })}
        </span>
      )}
    </button>
  );
}
