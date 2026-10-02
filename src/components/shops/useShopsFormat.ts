import { useMemo } from 'react';
import { formatSkopje, skopjeYmd } from '@/lib/skopjeTime';
import { useInsightsFormat } from '@/components/insights/shared/useInsightsFormat';
import { dm } from '@/components/insights/overview/useOverviewFormat';
import { fmtNum } from '@/components/insights/overview/model';

/**
 * The Insights formatting (counts with the reader's marks, денари via formatDenari, "N min ago")
 * plus the shop page's times — always on the Skopje clock, whatever the reader's computer says.
 */
export function useShopsFormat() {
  const f = useInsightsFormat();
  return useMemo(() => ({
    ...f,
    /** A percent in percent units (vs_avg_pct 12.5) → "12,5%". */
    pctUnits: (v: number | null | undefined, digits = 1) => (v == null || !Number.isFinite(v) ? '—' : `${fmtNum(v, f.lang, digits)}%`),
    /** 14:05 */
    time: (iso: string | null | undefined) => formatSkopje(iso, 'HH:mm'),
    /** 01.10 14:05 */
    dayTime: (iso: string | null | undefined) => formatSkopje(iso, 'dd.MM HH:mm'),
    /** 01.10.2026 */
    dayFull: (iso: string | null | undefined) => (iso ? dm(iso.length === 10 ? iso : skopjeYmd(iso), true) : '—'),
    /** The time alone on today's Skopje day, else with its day. */
    moment: (iso: string | null | undefined, now: number = Date.now()) =>
      !iso ? '—' : skopjeYmd(iso) === skopjeYmd(now) ? formatSkopje(iso, 'HH:mm') : formatSkopje(iso, 'dd.MM HH:mm'),
    dm,
  }), [f]);
}

export type ShopsFormat = ReturnType<typeof useShopsFormat>;
