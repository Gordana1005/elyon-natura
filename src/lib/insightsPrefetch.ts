import type { QueryClient } from '@tanstack/react-query';
import { apiGetInsightsOverview } from '@/lib/api';
import { apiGetInsightsAgents } from '@/lib/insightsApi/agents';
import { apiGetInsightsSales } from '@/lib/insightsApi/sales';
import { skopjeToday } from '@/components/insights/shared/period';

/**
 * Login → /insights (owner, 02.10.2026 — "Insights faster when we log in"): /start starts the
 * Overview's three requests and the page's code the moment it knows the landing page, instead of
 * after the page's code has downloaded and mounted (≈ 0,7–1,3 s earlier).
 *
 * The keys MUST stay identical to OverviewTab's queries for the default view — today, compare on,
 * no fixture — or the page fetches everything a second time.
 */
export function prefetchInsightsLanding(qc: QueryClient, userId: string): void {
  const today = skopjeToday();
  const staleTime = 5 * 60_000;
  void qc.prefetchQuery({
    queryKey: ['insights-overview', userId, today, today, true, null],
    queryFn: ({ signal }) => apiGetInsightsOverview({ from: today, to: today, compare: true }, signal),
    staleTime,
  });
  void qc.prefetchQuery({
    queryKey: ['insights-agents', userId, today, today, true, null],
    queryFn: ({ signal }) => apiGetInsightsAgents({ from: today, to: today, compare: true }, signal),
    staleTime,
  });
  void qc.prefetchQuery({
    queryKey: ['insights-sales', userId, today, today, 'detail', null],
    queryFn: ({ signal }) => apiGetInsightsSales({ from: today, to: today, part: 'detail' }, signal),
    staleTime,
  });
  // the page's code in parallel with its data
  void import('@/pages/ManagementInsightsPage');
}
