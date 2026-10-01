import { formatDate } from '@/i18n/dates';
import { localDateOfYmd, skopjeHour } from '@/lib/skopjeTime';
import type { ChartRow } from './ShopsBarChart';
import { hasKey, hourlyRows } from './shopsModel';
import type { ShopsSummary } from './useShopsData';

const pad = (n: number) => String(n).padStart(2, '0');

/** The chart rows: the day's hours (live: up to the running hour), or the period's days. */
export function chartRows(s: ShopsSummary, today: string, now: Date = new Date()): ChartRow[] {
  if (s.kind === 'day') {
    return hourlyRows(s.day.hourly ?? [], s.live ? skopjeHour(now) : null).map((h) => ({
      key: `h${h.hour}`, label: String(h.hour), long: `${pad(h.hour)}:00–${pad((h.hour + 1) % 24)}:00`,
      receipts: h.receipts, units: h.units, ...(h.sales_mkd !== undefined ? { sales_mkd: h.sales_mkd } : {}), partial: h.partial,
    }));
  }
  return (s.period.daily ?? []).map((d) => ({
    key: d.day, label: `${d.day.slice(8, 10)}.${d.day.slice(5, 7)}`,
    long: formatDate(localDateOfYmd(d.day), 'EEE dd.MM.yyyy'),
    receipts: d.receipts, units: d.units, ...(hasKey(d, 'sales_mkd') ? { sales_mkd: d.sales_mkd ?? 0 } : {}),
    partial: d.day === today,
  }));
}
