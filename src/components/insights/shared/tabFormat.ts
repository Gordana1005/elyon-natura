import { formatMoney } from '@/lib/currency';

// Formatting helpers of the pre-cohort /insights tabs, moved verbatim out of
// ManagementInsightsPage. New code formats through useInsightsFormat()
// (reader's marks, formatDenari / formatMoney) instead.
export const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
export const cap = (s: string) => s.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
export const moneyTip = (v: number) => formatMoney(v);
