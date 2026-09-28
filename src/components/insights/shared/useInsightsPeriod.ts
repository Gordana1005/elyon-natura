import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  parsePeriodParams, previousRange, skopjeToday, spanDays, writePeriodParams,
  type DayRange, type PeriodPreset, type PeriodState,
} from './period';

export interface InsightsPeriod extends PeriodState {
  /** = range.from / range.to, inclusive Skopje days (YYYY-MM-DD). */
  from: string;
  to: string;
  /** Inclusive day count. */
  days: number;
  /** The equal-length span right before, or null when compare is off. */
  prev: DayRange | null;
  /** Today on the Skopje calendar. */
  today: string;
  /** The period ends today, so its last day is still running. */
  partial: boolean;
  setPeriod: (next: Partial<{ preset: PeriodPreset; range: DayRange; compare: boolean }>) => void;
}

/**
 * The period every /insights tab counts by — read from and written to the URL
 * (see period.ts), so all tabs share it and a tab switch keeps it.
 *
 * Tab data clients: put the period in the query key (`from`, `to`, `compare`)
 * and start the key with 'insights' ('insights', 'insights-sales', …) — the
 * filter bar's loading indicator and Cancel follow every such query.
 */
export function useInsightsPeriod(): InsightsPeriod {
  const [sp, setSp] = useSearchParams();
  const today = useMemo(() => skopjeToday(), []);
  const state = useMemo(() => parsePeriodParams(sp, today), [sp, today]);
  const setPeriod = useCallback<InsightsPeriod['setPeriod']>(
    (next) => setSp((prev) => writePeriodParams(prev, next), { replace: true }),
    [setSp],
  );
  return useMemo(() => ({
    ...state,
    from: state.range.from,
    to: state.range.to,
    days: spanDays(state.range),
    prev: state.compare ? previousRange(state.range) : null,
    today,
    partial: state.range.to === today,
    setPeriod,
  }), [state, today, setPeriod]);
}

/** A query-key predicate for "any /insights query" (loading indicator, Cancel). */
export const isInsightsQueryKey = (key: readonly unknown[]): boolean =>
  typeof key[0] === 'string' && key[0].startsWith('insights');
