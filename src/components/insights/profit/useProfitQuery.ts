import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { apiGetInsightsProfit, profitQueryKey, type ProfitResponse } from '@/lib/insightsApi/profit';
import { useInsightsPeriod } from '../shared/useInsightsPeriod';

/**
 * GET /insights/profit for the page's one period — shared by Pure Profit and
 * Margins (one query key, so switching between them reuses the answer). The
 * previous answer stays on screen while a new period loads.
 */
export function useProfitQuery() {
  const { user } = useAuth();
  const period = useInsightsPeriod();
  const params = { from: period.from, to: period.to, compare: period.compare };
  const q = useQuery<ProfitResponse>({
    queryKey: profitQueryKey(user?.id, params),
    queryFn: ({ signal }) => apiGetInsightsProfit(params, signal),
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
    retry: 0,
  });
  return { q, period };
}
