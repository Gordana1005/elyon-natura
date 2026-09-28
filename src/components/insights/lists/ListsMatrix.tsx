import { useId, useMemo } from 'react';
import { formatMoney } from '@/lib/currency';
import { cn } from '@/lib/utils';
import { ClockCaption } from '../shared/ClockCaption';
import type { InsightsFormat } from '../shared/useInsightsFormat';
import { conversionOf, recencyValueMatrix, type ListsRollup, type ListView } from './listModel';
import { MAGNITUDE_BAR } from './listsPalette';

const BANDS = ['le', 'gt'] as const;

/**
 * Recency × value band: how long since the customer's last paid order
 * against the price of that order (≤ / over the band threshold). Each cell =
 * the band lists of that recency: sales (денари for owners), a bar as long as
 * its share of the best cell, and the conversion of the calls. NEWCOMERS and
 * the holding pens have no value band and sit in the table only.
 */
export function ListsMatrix({ rows, money, f }: { rows: ListView[]; money: boolean; f: InsightsFormat }) {
  const { t } = f;
  const titleId = useId();
  const m = useMemo(() => recencyValueMatrix(rows), [rows]);
  if (!m.rows.length) return null;
  const threshold = m.threshold != null ? formatMoney(m.threshold) : '';
  const measure = (c: ListsRollup) => (money && c.value_mkd != null ? c.value_mkd : c.count);
  const max = Math.max(1, money ? m.max.value : m.max.count);

  return (
    <section aria-labelledby={titleId} className="space-y-3">
      <div>
        <h2 id={titleId} className="text-base font-semibold">{t('insights.lists.matrix.title')}</h2>
        <p className="text-xs text-muted-foreground">{t('insights.lists.matrix.subtitle')}</p>
        <ClockCaption clock={['sale', 'decided']} />
      </div>
      <div className="overflow-x-auto rounded-xl border bg-card shadow-sm">
        <table className="w-full min-w-[420px] text-sm">
          <caption className="sr-only">{t('insights.lists.matrix.title')}</caption>
          <thead>
            <tr className="border-b text-[11px] uppercase tracking-wide text-muted-foreground">
              <th scope="col" className="px-3 py-2 text-left font-medium">{t('insights.lists.matrix.recency')}</th>
              {BANDS.map((b) => (
                <th key={b} scope="col" className="px-3 py-2 text-left font-medium">
                  {t(`insights.lists.name.band${b === 'le' ? 'Le' : 'Gt'}`, { value: threshold })}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {m.rows.map((rid) => (
              <tr key={rid} className="border-b last:border-0 align-top">
                <th scope="row" className="px-3 py-2 text-left font-medium">{t(`insights.lists.name.recency.${rid}`)}</th>
                {BANDS.map((b) => {
                  const c = m.cells[rid]?.[b];
                  if (!c) return <td key={b} className="px-3 py-2 text-muted-foreground">—</td>;
                  const v = measure(c);
                  const conv = conversionOf(c.count, c.worked);
                  return (
                    <td key={b} className="px-3 py-2">
                      <span className={cn('block font-semibold tabular-nums', v === 0 && 'font-normal text-muted-foreground')}>
                        {money && c.value_mkd != null ? f.den(c.value_mkd) : f.int(c.count)}
                      </span>
                      <span className="mt-1 block h-1.5 w-full rounded-full bg-muted" aria-hidden>
                        <span className={cn('block h-full rounded-full', MAGNITUDE_BAR)} style={{ width: `${v > 0 ? Math.max(3, (v / max) * 100) : 0}%` }} />
                      </span>
                      <span className="mt-1 block text-[11px] tabular-nums text-muted-foreground">
                        {t('insights.lists.matrix.cell', {
                          sales: f.int(c.count), worked: f.int(c.worked), pct: f.pct(conv, 1), members: f.int(c.members_active),
                        })}
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
