import { useTranslation } from 'react-i18next';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { AppLayout } from '@/layouts/AppLayout';
import type { DateRange } from '@/components/DateRangePicker';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Loader2, BarChart3 } from 'lucide-react';
import { apiGetManagementInsights, type InsightsResponse } from '@/lib/api';
import { EmptyState } from '@/components/EmptyState';
import { useAuth } from '@/contexts/AuthContext';
import { useInsightsAccess } from '@/contexts/PermissionsContext';
import { apiErrorText } from '@/i18n/apiErrors';
import AgentsTab from '@/components/insights/agents/AgentsTab';
import PayoutTab from '@/components/insights/PayoutTab';
import MarginLabTab from '@/components/insights/margins/MarginLabTab';
import OverviewTab from '@/components/insights/overview/OverviewTab';
import SalesTab from '@/components/insights/sales/SalesTab';
import PureProfitTab from '@/components/insights/profit/PureProfitTab';
import PredictionListsTab from '@/components/insights/lists/PredictionListsTab';
import StockTab from '@/components/insights/stock/StockTab';
import ReturnsTab from '@/components/insights/returns/ReturnsTab';
import CallActivityTab from '@/components/insights/calls/CallActivityTab';
import { InsightsFilterBar } from '@/components/insights/shared/InsightsFilterBar';
import { LoadError } from '@/components/insights/shared/LoadError';
import { useInsightsPeriod } from '@/components/insights/shared/useInsightsPeriod';
import { switchTabParams } from '@/components/insights/shared/period';

// Tab catalogue. `need` keys into useInsightsAccess(). The money tabs
// (`business`) are OWNERS ONLY — owner ruling 2026-09-27, no admin bypass —
// while Agents / Payout / Call Activity keep their module rules (Agents also
// honours the legacy Performance key, so nobody lost the old standalone page).
// Each tab lives in its own file under src/components/insights/<tab>/.
const TAB_DEFS = [
  // The connected Overview brings its own data and money gate (meta.money):
  // owners see money, admins/managers the same page counted.
  { value: 'overview', labelKey: 'insights.tabOverview', need: 'overview' },
  // Sales brings its own data (GET /insights/sales) and money gate
  // (meta.money): owners see денари, admins/managers the same page counted.
  { value: 'sales', labelKey: 'insights.tabSales', need: 'overview' },
  { value: 'agents', labelKey: 'insights.tabAgents', need: 'agents' },
  { value: 'payout', labelKey: 'insights.tabPayout', need: 'payout' },
  { value: 'pure-profit', labelKey: 'insights.tabPureProfit', need: 'business' },
  { value: 'margin-lab', labelKey: 'insights.tabMarginLab', need: 'business' },
  // Prediction lists bring their own data (GET /insights/lists) and money gate
  // (meta.money): owners see денари, admins/managers the same page counted.
  { value: 'prediction-lists', labelKey: 'insights.tabPredictionLists', need: 'overview' },
  // Stock and Returns bring their own data (GET /insights/stock, /insights/returns)
  // and money gate (meta.money): owners see денари, admins/managers the same page counted.
  { value: 'stock', labelKey: 'insights.tabStock', need: 'overview' },
  { value: 'returns', labelKey: 'insights.tabReturns', need: 'overview' },
  { value: 'call-activity', labelKey: 'insights.tabCallActivity', need: 'calls' },
] as const;

// Every tab that renders from the full (owners-only) aggregate.
const MONEY_TABS = new Set<string>(TAB_DEFS.filter(d => d.need === 'business').map(d => d.value));
// …except the owners-only tabs that fetch their own endpoint (still `business`,
// still on the shared period bar).
const OWN_DATA_MONEY_TABS = new Set<string>(['pure-profit', 'margin-lab']);

// The tabs that count by the page's ONE period (InsightsFilterBar /
// useInsightsPeriod). Payout still brings its own period controls (deferred),
// so the shared bar is not shown there — it would not drive it.
const PERIOD_TABS = new Set<string>(['overview', ...MONEY_TABS, 'call-activity', 'prediction-lists', 'sales', 'agents', 'stock', 'returns']);

export default function ManagementInsightsPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  // The one period of /insights — shared by every tab through the URL, so a
  // tab switch keeps it (see useInsightsPeriod).
  const period = useInsightsPeriod();
  const range: DateRange = { from: period.from, to: period.to };

  // Per-area access — shared with the sidebar, see useInsightsAccess().
  const access = useInsightsAccess();
  const tabs = TAB_DEFS.filter(tab => access[tab.need]);

  // The default is always a tab this user can actually see.
  const requested = searchParams.get('tab');
  const activeTab = tabs.some(tab => tab.value === requested) ? requested! : (tabs[0]?.value ?? 'overview');
  // Owners-only tabs that bring their own data (Pure Profit + Margins read GET
  // /insights/profit) never wait for the full aggregate.
  const moneyTab = MONEY_TABS.has(activeTab) && !OWN_DATA_MONEY_TABS.has(activeTab);

  // OWNERS: the full aggregate (money tabs) — Call Activity reads its own
  // GET /insights/work — only on a tab that needs it, never while the operator sits on
  // Agents/Payout, which bring their own (also heavy) requests. The key
  // carries the login, so a cached owner response can never render for the
  // next person who signs in on this browser.
  const fullQ = useQuery<InsightsResponse>({
    queryKey: ['insights', user?.id, range.from, range.to],
    queryFn: ({ signal }) => apiGetManagementInsights({ from: range.from || undefined, to: range.to || undefined }, signal),
    staleTime: 5 * 60_000,
    enabled: access.business && moneyTab,
    // Keep the previous range's numbers on screen while the new ones load, instead
    // of blanking every tab to a spinner. On a wide range that spinner is the whole
    // wait. `retry` is 0 rather than the global 1 because retrying a heavy aggregate
    // silently doubles an already-long wait before the operator sees any error.
    placeholderData: keepPreviousData,
    retry: 0,
  });

  // Call Activity (the work tab) brings its own data: GET /insights/work for
  // everyone holding call_activity — no money on it, so no owner split here.

  // Money only ever renders from the owner query, and only for an owner.
  const data = access.business ? fullQ.data : undefined;
  const errorText = (err: unknown) =>
    err instanceof Error && err.message === 'owners_only' ? t('insights.ownersOnly') : apiErrorText(err);

  // The shared period bar shows on every tab it drives (Call Activity included:
  // its day-by-day swimlane steps through the days of this same period).
  const showPeriodBar = PERIOD_TABS.has(activeTab);

  if (tabs.length === 0) {
    return (
      <AppLayout title={t('nav.insights')}>
        <EmptyState icon={<BarChart3 className="h-5 w-5" />} title={t('insights.noAccess')} description={t('insights.noAccessDesc')} />
      </AppLayout>
    );
  }

  return (
    <AppLayout title={t('nav.insights')}>
      <div className="space-y-5">
        {/* A tab switch keeps the shared period (and drops the old tab's own filters). */}
        <Tabs value={activeTab} onValueChange={(v) => setSearchParams(switchTabParams(searchParams, v))}>
          <TabsList className="h-auto">
            {tabs.map(tab => <TabsTrigger key={tab.value} value={tab.value}>{t(tab.labelKey)}</TabsTrigger>)}
          </TabsList>

          {showPeriodBar && <InsightsFilterBar className="mt-4" />}

          {moneyTab && !data ? (
            // A failed aggregate says so — it never spins forever.
            fullQ.isError ? (
              <div className="mt-4"><LoadError text={errorText(fullQ.error)} onRetry={() => { void fullQ.refetch(); }} /></div>
            ) : (
              <div className="flex items-center justify-center py-24"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>
            )
          ) : (
            <>
              {access.overview && (
                <TabsContent value="overview" className="mt-4"><OverviewTab /></TabsContent>
              )}
              {access.overview && (
                <TabsContent value="prediction-lists" className="mt-4"><PredictionListsTab /></TabsContent>
              )}
              {access.overview && (
                <TabsContent value="sales" className="mt-4"><SalesTab /></TabsContent>
              )}

              {/* Pure Profit + Margins: owners only, GET /insights/profit (one shared query). */}
              {access.business && <>
                <TabsContent value="pure-profit" className="mt-4"><PureProfitTab /></TabsContent>
                <TabsContent value="margin-lab" className="mt-4"><MarginLabTab /></TabsContent>
              </>}

              {access.overview && <>
                <TabsContent value="stock" className="mt-4"><StockTab /></TabsContent>
                <TabsContent value="returns" className="mt-4"><ReturnsTab /></TabsContent>
              </>}

              {access.agents && (
                <TabsContent value="agents" className="mt-4"><AgentsTab /></TabsContent>
              )}

              {access.payout && (
                <TabsContent value="payout" className="mt-4"><PayoutTab /></TabsContent>
              )}

              {access.calls && (
                <TabsContent value="call-activity" className="mt-4">
                  <CallActivityTab />
                </TabsContent>
              )}
            </>
          )}
        </Tabs>
      </div>
    </AppLayout>
  );
}
