import i18n from '@/i18n';
import { eurToDen, formatMoney } from '@/lib/currency';
import { compactParts } from '@/components/insights/overview/model';

// Formatting helpers of the pre-cohort /insights tabs, moved verbatim out of
// ManagementInsightsPage. New code formats through useInsightsFormat()
// (reader's marks, formatDenari / formatMoney) instead.
export const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
export const cap = (s: string) => s.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
export const moneyTip = (v: number) => formatMoney(v);

/**
 * Chart-axis tick for a STORED-EUR value: compact денари ("31 илј. ден"),
 * never the raw euro number. Display only — the chart data stays EUR.
 */
export const moneyAxis = (eur: number) => {
  const { n, unit } = compactParts(eurToDen(eur));
  const shown = i18n.language === 'en' ? n : n.replace('.', ',');
  const num = unit === 'k' ? i18n.t('overview.unit.k', { n: shown })
    : unit === 'm' ? i18n.t('overview.unit.m', { n: shown }) : shown;
  return `${num} ден`;
};
