import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { AppLayout } from '@/layouts/AppLayout';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { BarChart3 } from 'lucide-react';
import { EmptyState } from '@/components/EmptyState';
import { useInsightsAccess } from '@/contexts/PermissionsContext';
import AgentsTab from '@/components/insights/agents/AgentsTab';
import PayoutTab from '@/components/insights/PayoutTab';
import MarginLabTab from '@/components/insights/margins/MarginLabTab';
import OverviewTab from '@/components/insights/overview/OverviewTab';
import SalesTab from '@/components/insights/sales/SalesTab';
import PureProfitTab from '@/components/insights/profit/PureProfitTab';
import PredictionListsTab from '@/components/insights/lists/PredictionListsTab';
import StockTab from '@/components/insights/stock/StockTab';
import ReturnsTab from '@/components/insights/returns/ReturnsTab';
import MexCashTab from '@/components/insights/mexcash/MexCashTab';
import CallActivityTab from '@/components/insights/calls/CallActivityTab';
import { InsightsFilterBar } from '@/components/insights/shared/InsightsFilterBar';
import { switchTabParams } from '@/components/insights/shared/period';

// Tab catalogue. `need` keys into useInsightsAccess(). Only Pure Profit and
// Margin Lab are `business` — owners only (is_business_owner(): the owners list
// and every active admin, 20260939000500). The cohort tabs (Overview, Sales,
// Prediction lists, Stock, Returns) open to admins/managers too and gate their
// money by the payload's meta.money. Agents / Payout / Call Activity keep their
// module rules (Agents also honours the legacy Performance key, so nobody lost
// the old standalone page). Every tab brings its own data; each lives in its
// own file under src/components/insights/<tab>/.
const TAB_DEFS = [
  // The connected Overview brings its own data and money gate (meta.money):
  // owners see money, admins/managers the same page counted.
  { value: 'overview', labelKey: 'insights.tabOverview', need: 'overview' },
  // Sales brings its own data (GET /insights/sales) and money gate
  // (meta.money): owners see денари, admins/managers the same page counted.
  { value: 'sales', labelKey: 'insights.tabSales', need: 'overview' },
  // Наплата (MEX) (owner 02.10.2026): what MEX collected per delivery day, account and
  // settlement period — off the Overview, where it read as money received that day.
  // A short NAMED list only (app_settings.mex_cash.viewers: Mile + Hedi), not every
  // owner — can_see_mex_cash() on the server, GET /insights/mex-cash answers 403 to anyone else.
  { value: 'mex-cash', labelKey: 'insights.tabMexCash', need: 'mexCash' },
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

// The tabs that count by the page's ONE period (InsightsFilterBar /
// useInsightsPeriod — shared by every tab through the URL, so a tab switch
// keeps it). Payout still brings its own period controls (deferred), so the
// shared bar is not shown there — it would not drive it.
const PERIOD_TABS = new Set<string>(['overview', 'pure-profit', 'margin-lab', 'call-activity', 'prediction-lists', 'sales', 'mex-cash', 'agents', 'stock', 'returns']);

export default function ManagementInsightsPage() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();

  // Per-area access — shared with the sidebar, see useInsightsAccess().
  const insightsAccess = useInsightsAccess();
  // Наплата (MEX): the named viewers only (my_can_see_mex_cash(), migration 20260947001300).
  const { user } = useAuth();
  const mexCashQ = useQuery({
    queryKey: ['my-can-see-mex-cash', user?.id],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('my_can_see_mex_cash');
      if (error) return false;
      return data === true;
    },
    enabled: !!user?.id && insightsAccess.business,
    staleTime: 10 * 60_000,
    retry: 0,
  });
  const access = { ...insightsAccess, mexCash: insightsAccess.business && mexCashQ.data === true };
  const tabs = TAB_DEFS.filter(tab => access[tab.need]);

  // The default is always a tab this user can actually see.
  const requested = searchParams.get('tab');
  // A link straight to Наплата (MEX) waits for the viewer check instead of opening (and
  // fetching) the first tab meanwhile.
  const mexCashPending = requested === 'mex-cash' && insightsAccess.business && mexCashQ.isPending;
  const activeTab = mexCashPending ? 'mex-cash'
    : tabs.some(tab => tab.value === requested) ? requested! : (tabs[0]?.value ?? 'overview');

  // No page-level aggregate: every tab fetches its own endpoint (the full
  // GET /management-insights report is no tab's data any more — the api keeps
  // answering it, and ?scope=calls, for older clients).

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

          {access.overview && (
            <TabsContent value="overview" className="mt-4"><OverviewTab /></TabsContent>
          )}
          {access.overview && (
            <TabsContent value="prediction-lists" className="mt-4"><PredictionListsTab /></TabsContent>
          )}
          {access.overview && (
            <TabsContent value="sales" className="mt-4"><SalesTab /></TabsContent>
          )}
          {access.mexCash && (
            <TabsContent value="mex-cash" className="mt-4"><MexCashTab /></TabsContent>
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
        </Tabs>
      </div>
    </AppLayout>
  );
}
