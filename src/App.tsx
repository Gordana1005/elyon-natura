// App entry
import { lazy, Suspense } from "react";
import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "@/contexts/AuthContext";
import { LanguageProvider } from "@/contexts/LanguageContext";
import { PermissionsProvider } from "@/contexts/PermissionsContext";
import { VoipProvider } from "@/contexts/VoipContext";
import { ProtectedRoute } from "@/components/ProtectedRoute";

// Eager: entry-point pages that should not require an extra round-trip.
import LoginPage from "./pages/LoginPage";
import StartPage from "./pages/StartPage";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import NotFound from "./pages/NotFound";
import { CallAgainRedirect } from "./components/calls/work/CallAgainRedirect";

// Lazy: every other page splits into its own chunk and loads on first navigation.
// We deliberately DO NOT configure rollup manualChunks — Vite's automatic
// chunking has been battle-tested and avoids the circular vendor chunks that
// broke an earlier attempt at this.
const Dashboard = lazy(() => import("./pages/Dashboard"));
const Orders = lazy(() => import("./pages/Orders"));
const UsersPage = lazy(() => import("./pages/UsersPage"));
const ProductsPage = lazy(() => import("./pages/ProductsPage"));
const AssignerPage = lazy(() => import("./pages/AssignerPage"));
const ShiftsPage = lazy(() => import("./pages/ShiftsPage"));
const CallScriptsPage = lazy(() => import("./pages/CallScriptsPage"));
const CallHistoryPage = lazy(() => import("./pages/CallHistoryPage"));
const WarehousePage = lazy(() => import("./pages/WarehousePage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const InboundLeadsPage = lazy(() => import("./pages/InboundLeadsPage"));
const WebhookManagementPage = lazy(() => import("./pages/WebhookManagementPage"));
const ManagementInsightsPage = lazy(() => import("./pages/ManagementInsightsPage"));
const OperationsPage = lazy(() => import("./pages/OperationsPage"));
const LeadDistributionPage = lazy(() => import("./pages/LeadDistributionPage"));
const CallsPage = lazy(() => import("./pages/CallsPage"));
const MissedCallsPage = lazy(() => import("./pages/MissedCallsPage"));
const SegmentsPage = lazy(() => import("./pages/SegmentsPage"));
const SegmentDetailPage = lazy(() => import("./pages/SegmentDetailPage"));
const PersonalListPage = lazy(() => import("./pages/PersonalListPage"));
const VoipHealthPage = lazy(() => import("./pages/VoipHealthPage"));
const AffiliatesAdminPage = lazy(() => import("./pages/AffiliatesAdminPage"));
const AlterCpaPage = lazy(() => import("./pages/AlterCpaPage"));
// Продавници (owner 02.10.2026, docs/SHOPS.md): owners + managers + admins; the page itself
// decides (useShopsAccess) — no module key, the api refuses everyone else.
const ShopsPage = lazy(() => import("./pages/ShopsPage"));
// Лојалност (owner 06.10.2026): owners + managers + admins; the page decides
// (useLoyaltyAccess) — no module key, the api refuses everyone else.
const LoyaltyPage = lazy(() => import("./pages/LoyaltyPage"));
// Affiliate (webmaster) portal — the only pages an 'affiliate' login can see.
const AffiliateDashboardPage = lazy(() => import("./pages/AffiliateDashboardPage"));
const AffiliateOffersCataloguePage = lazy(() => import("./pages/AffiliateOffersCataloguePage"));
const AffiliateIntegrationPage = lazy(() => import("./pages/AffiliateIntegrationPage"));
// Public, full-screen wall-board for the office TV. No login (token in the URL).
const TvLeaderboardPage = lazy(() => import("./pages/TvLeaderboardPage"));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30 * 1000,
      // kept 30 min (was the 5-min default): back on a page you saw, it shows at once and refreshes behind
      gcTime: 30 * 60 * 1000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

const PageLoader = () => (
  <div className="flex h-screen items-center justify-center bg-background">
    <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
  </div>
);

const App = () => (
  <QueryClientProvider client={queryClient}>
    {/* App-wide light/dark theme. Persists per-device under localStorage "theme".
        Default is light; OS preference is intentionally NOT followed (enableSystem=false).
        An inline script in index.html applies the saved theme before paint to avoid a flash. */}
    <ThemeProvider
      attribute="class"
      defaultTheme="light"
      enableSystem={false}
      storageKey="theme"
      disableTransitionOnChange
    >
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <AuthProvider>
          <LanguageProvider>
          <PermissionsProvider>
            <VoipProvider>
            <AppErrorBoundary>
            <Suspense fallback={<PageLoader />}>
              <Routes>
                <Route path="/login" element={<LoginPage />} />
                {/* Where every login lands: waits for the permissions, then homePath (29.09.2026). */}
                <Route path="/start" element={<StartPage />} />
                {/* Public wall-board for the office TV — token-gated server-side, no login/chrome. */}
                <Route path="/tv/leaderboard" element={<TvLeaderboardPage />} />
                <Route path="/" element={<ProtectedRoute moduleKey="dashboard"><Dashboard /></ProtectedRoute>} />
                <Route path="/orders" element={<ProtectedRoute moduleKey="orders"><Orders /></ProtectedRoute>} />
                <Route path="/users" element={<ProtectedRoute moduleKey="users"><UsersPage /></ProtectedRoute>} />
                <Route path="/products" element={<ProtectedRoute moduleKey="products"><ProductsPage /></ProtectedRoute>} />
                {/* "Assigned to me" is RETIRED (owner, 29.09.2026): the last 100 orders with no filter,
                    a Bulgarian leftover — agents work in /calls and see their orders on the Dashboard.
                    The page file and its permission rows stay; old links land on /calls. */}
                <Route path="/assigned" element={<Navigate to="/calls" replace />} />
                <Route path="/assigner" element={<ProtectedRoute moduleKey="assigner"><AssignerPage /></ProtectedRoute>} />
                {/* /predictions was the Bulgarian CSV prediction-list flow: 0 visits in 61 days, 0 rows
                    (owner audit 30.09.2026). The live lists are /segments. */}
                <Route path="/predictions" element={<Navigate to="/segments" replace />} />
                <Route path="/predictions/:id" element={<Navigate to="/segments" replace />} />
                {/* /prediction-leads is HIDDEN, not deleted (2026-08-19). It reads
                    the prediction_leads table, which has 0 rows here — every
                    prediction_agent had a permanently empty page in their
                    sidebar, while their real work surface is /calls. The page
                    and the permission rows stay so it can come back the day
                    prediction_leads is populated. */}
                <Route path="/prediction-leads" element={<Navigate to="/calls" replace />} />
                {/* Import orders never created a real order (every import came from the collabBox sync or a
                    script) and was unsafe — a blank status became PAID (owner audit 30.09.2026). POST
                    /orders/import stays for scripts/import-altercpa-mk.mjs. */}
                <Route path="/import-orders" element={<Navigate to="/orders" replace />} />
                {/* Performance + Agent Activity merged into Insights (2026-06). Keep old paths working. */}
                <Route path="/performance" element={<Navigate to="/insights?tab=agents" replace />} />
                <Route path="/agent-activity" element={<Navigate to="/insights?tab=call-activity" replace />} />
                <Route path="/shifts" element={<ProtectedRoute moduleKey="shifts" moduleKeysAny={["my_shifts"]}><ShiftsPage /></ProtectedRoute>} />
                <Route path="/my-shifts" element={<Navigate to="/shifts" replace />} />
                <Route path="/call-scripts" element={<ProtectedRoute moduleKey="call_scripts"><CallScriptsPage /></ProtectedRoute>} />
                <Route path="/call-history" element={<ProtectedRoute moduleKey="call_history"><CallHistoryPage /></ProtectedRoute>} />
                <Route path="/warehouse" element={<ProtectedRoute moduleKey="warehouse"><WarehousePage /></ProtectedRoute>} />
                <Route path="/settings" element={<ProtectedRoute moduleKey="settings"><SettingsPage /></ProtectedRoute>} />
                <Route path="/settings/:section" element={<ProtectedRoute moduleKey="settings"><SettingsPage /></ProtectedRoute>} />
                <Route path="/voip-health" element={<ProtectedRoute moduleKey="voip_health"><VoipHealthPage /></ProtectedRoute>} />
                <Route path="/ads" element={<Navigate to="/webhooks" replace />} />
                <Route path="/inbound-leads" element={<ProtectedRoute moduleKey="inbound_leads"><InboundLeadsPage /></ProtectedRoute>} />
                <Route path="/webhooks" element={<ProtectedRoute moduleKey="webhooks"><WebhookManagementPage /></ProtectedRoute>} />
                <Route path="/affiliates-admin" element={<ProtectedRoute moduleKey="affiliates_admin"><AffiliatesAdminPage /></ProtectedRoute>} />
                <Route path="/altercpa" element={<ProtectedRoute moduleKey="altercpa_bridge"><AlterCpaPage /></ProtectedRoute>} />
                <Route path="/affiliate" element={<ProtectedRoute moduleKey="affiliate_portal"><AffiliateDashboardPage /></ProtectedRoute>} />
                <Route path="/affiliate/offers" element={<ProtectedRoute moduleKey="affiliate_portal"><AffiliateOffersCataloguePage /></ProtectedRoute>} />
                <Route path="/affiliate/integration" element={<ProtectedRoute moduleKey="affiliate_portal"><AffiliateIntegrationPage /></ProtectedRoute>} />
                {/* The search bar on top of every page does the same lookup (owner audit 30.09.2026). */}
                <Route path="/search-prediction" element={<Navigate to="/" replace />} />
                <Route path="/insights" element={<ProtectedRoute moduleKey="insights" moduleKeysAny={["performance", "agent_activity", "call_activity"]} allowBusinessOwner><ManagementInsightsPage /></ProtectedRoute>} />
                <Route path="/operations" element={<ProtectedRoute moduleKey="operations"><OperationsPage /></ProtectedRoute>} />
                <Route path="/shops" element={<ProtectedRoute><ShopsPage /></ProtectedRoute>} />
                <Route path="/loyalty" element={<ProtectedRoute><LoyaltyPage /></ProtectedRoute>} />
                <Route path="/lead-distribution" element={<ProtectedRoute moduleKey="lead_distribution"><LeadDistributionPage /></ProtectedRoute>} />
                <Route path="/calls" element={<ProtectedRoute moduleKey="calls"><CallsPage /></ProtectedRoute>} />
                {/* Recordings merged into Call History (2026-06). Keep the old path working. */}
                <Route path="/recordings" element={<Navigate to="/call-history" replace />} />
                <Route path="/missed-calls" element={<ProtectedRoute moduleKey="missed_calls"><MissedCallsPage /></ProtectedRoute>} />
                <Route path="/segments" element={<ProtectedRoute moduleKey="segments"><SegmentsPage /></ProtectedRoute>} />
                <Route path="/segments/:id" element={<ProtectedRoute moduleKey="segments"><SegmentDetailPage /></ProtectedRoute>} />
                <Route path="/personal-list" element={<ProtectedRoute moduleKey="calls"><PersonalListPage /></ProtectedRoute>} />
                {/* Plan Фаза 11: the callbacks are a queue inside /calls ("Мои"); everyone's are the Assigner's tab. */}
                <Route path="/call-again" element={<CallAgainRedirect />} />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </Suspense>
            </AppErrorBoundary>
            </VoipProvider>
          </PermissionsProvider>
          </LanguageProvider>
        </AuthProvider>
      </BrowserRouter>
    </TooltipProvider>
    </ThemeProvider>
  </QueryClientProvider>
);

export default App;
