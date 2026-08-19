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
import NotFound from "./pages/NotFound";

// Lazy: every other page splits into its own chunk and loads on first navigation.
// We deliberately DO NOT configure rollup manualChunks — Vite's automatic
// chunking has been battle-tested and avoids the circular vendor chunks that
// broke an earlier attempt at this.
const Dashboard = lazy(() => import("./pages/Dashboard"));
const Orders = lazy(() => import("./pages/Orders"));
const UsersPage = lazy(() => import("./pages/UsersPage"));
const ProductsPage = lazy(() => import("./pages/ProductsPage"));
const AssignedPage = lazy(() => import("./pages/AssignedPage"));
const AssignerPage = lazy(() => import("./pages/AssignerPage"));
const PredictionListsPage = lazy(() => import("./pages/PredictionListsPage"));
const PredictionListDetail = lazy(() => import("./pages/PredictionListDetail"));
// Kept imported-but-unrouted on purpose: the route below redirects while the
// prediction_leads table is empty. Deleting the page would make restoring it
// a rewrite rather than a one-line route change.
const ImportOrdersPage = lazy(() => import("./pages/ImportOrdersPage"));
const ShiftsManagementPage = lazy(() => import("./pages/ShiftsManagementPage"));
const MyShiftsPage = lazy(() => import("./pages/MyShiftsPage"));
const CallScriptsPage = lazy(() => import("./pages/CallScriptsPage"));
const CallHistoryPage = lazy(() => import("./pages/CallHistoryPage"));
const WarehousePage = lazy(() => import("./pages/WarehousePage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const InboundLeadsPage = lazy(() => import("./pages/InboundLeadsPage"));
const WebhookManagementPage = lazy(() => import("./pages/WebhookManagementPage"));
const SearchPredictionPage = lazy(() => import("./pages/SearchPredictionPage"));
const ManagementInsightsPage = lazy(() => import("./pages/ManagementInsightsPage"));
const OperationsPage = lazy(() => import("./pages/OperationsPage"));
const LeadDistributionPage = lazy(() => import("./pages/LeadDistributionPage"));
const CallsPage = lazy(() => import("./pages/CallsPage"));
const MissedCallsPage = lazy(() => import("./pages/MissedCallsPage"));
const SegmentsPage = lazy(() => import("./pages/SegmentsPage"));
const SegmentDetailPage = lazy(() => import("./pages/SegmentDetailPage"));
const PersonalListPage = lazy(() => import("./pages/PersonalListPage"));
const CallAgainPage = lazy(() => import("./pages/CallAgainPage"));
const VoipHealthPage = lazy(() => import("./pages/VoipHealthPage"));
const AffiliatesAdminPage = lazy(() => import("./pages/AffiliatesAdminPage"));
const AlterCpaPage = lazy(() => import("./pages/AlterCpaPage"));
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
            <Suspense fallback={<PageLoader />}>
              <Routes>
                <Route path="/login" element={<LoginPage />} />
                {/* Public wall-board for the office TV — token-gated server-side, no login/chrome. */}
                <Route path="/tv/leaderboard" element={<TvLeaderboardPage />} />
                <Route path="/" element={<ProtectedRoute moduleKey="dashboard"><Dashboard /></ProtectedRoute>} />
                <Route path="/orders" element={<ProtectedRoute moduleKey="orders"><Orders /></ProtectedRoute>} />
                <Route path="/users" element={<ProtectedRoute moduleKey="users"><UsersPage /></ProtectedRoute>} />
                <Route path="/products" element={<ProtectedRoute moduleKey="products"><ProductsPage /></ProtectedRoute>} />
                <Route path="/assigned" element={<ProtectedRoute moduleKey="assigned"><AssignedPage /></ProtectedRoute>} />
                <Route path="/assigner" element={<ProtectedRoute moduleKey="assigner"><AssignerPage /></ProtectedRoute>} />
                <Route path="/predictions" element={<ProtectedRoute moduleKey="prediction_lists"><PredictionListsPage /></ProtectedRoute>} />
                <Route path="/predictions/:id" element={<ProtectedRoute moduleKey="prediction_lists"><PredictionListDetail /></ProtectedRoute>} />
                {/* /prediction-leads is HIDDEN, not deleted (2026-08-19). It reads
                    the prediction_leads table, which has 0 rows here — every
                    prediction_agent had a permanently empty page in their
                    sidebar, while their real work surface is /calls. The page
                    and the permission rows stay so it can come back the day
                    prediction_leads is populated. */}
                <Route path="/prediction-leads" element={<Navigate to="/calls" replace />} />
                <Route path="/import-orders" element={<ProtectedRoute moduleKey="order_import"><ImportOrdersPage /></ProtectedRoute>} />
                {/* Performance + Agent Activity merged into Insights (2026-06). Keep old paths working. */}
                <Route path="/performance" element={<Navigate to="/insights?tab=agents" replace />} />
                <Route path="/agent-activity" element={<Navigate to="/insights?tab=call-activity" replace />} />
                <Route path="/shifts" element={<ProtectedRoute moduleKey="shifts"><ShiftsManagementPage /></ProtectedRoute>} />
                <Route path="/my-shifts" element={<ProtectedRoute moduleKey="my_shifts"><MyShiftsPage /></ProtectedRoute>} />
                <Route path="/call-scripts" element={<ProtectedRoute moduleKey="call_scripts"><CallScriptsPage /></ProtectedRoute>} />
                <Route path="/call-history" element={<ProtectedRoute moduleKey="call_history"><CallHistoryPage /></ProtectedRoute>} />
                <Route path="/warehouse" element={<ProtectedRoute moduleKey="warehouse"><WarehousePage /></ProtectedRoute>} />
                <Route path="/settings" element={<ProtectedRoute moduleKey="settings"><SettingsPage /></ProtectedRoute>} />
                <Route path="/voip-health" element={<ProtectedRoute moduleKey="voip_health"><VoipHealthPage /></ProtectedRoute>} />
                <Route path="/ads" element={<Navigate to="/webhooks" replace />} />
                <Route path="/inbound-leads" element={<ProtectedRoute moduleKey="inbound_leads"><InboundLeadsPage /></ProtectedRoute>} />
                <Route path="/webhooks" element={<ProtectedRoute moduleKey="webhooks"><WebhookManagementPage /></ProtectedRoute>} />
                <Route path="/affiliates-admin" element={<ProtectedRoute moduleKey="affiliates_admin"><AffiliatesAdminPage /></ProtectedRoute>} />
                <Route path="/altercpa" element={<ProtectedRoute moduleKey="altercpa_bridge"><AlterCpaPage /></ProtectedRoute>} />
                <Route path="/affiliate" element={<ProtectedRoute moduleKey="affiliate_portal"><AffiliateDashboardPage /></ProtectedRoute>} />
                <Route path="/affiliate/offers" element={<ProtectedRoute moduleKey="affiliate_portal"><AffiliateOffersCataloguePage /></ProtectedRoute>} />
                <Route path="/affiliate/integration" element={<ProtectedRoute moduleKey="affiliate_portal"><AffiliateIntegrationPage /></ProtectedRoute>} />
                <Route path="/search-prediction" element={<ProtectedRoute moduleKey="search_prediction"><SearchPredictionPage /></ProtectedRoute>} />
                <Route path="/insights" element={<ProtectedRoute moduleKey="insights" moduleKeysAny={["performance", "agent_activity"]}><ManagementInsightsPage /></ProtectedRoute>} />
                <Route path="/operations" element={<ProtectedRoute moduleKey="operations"><OperationsPage /></ProtectedRoute>} />
                <Route path="/lead-distribution" element={<ProtectedRoute moduleKey="lead_distribution"><LeadDistributionPage /></ProtectedRoute>} />
                <Route path="/calls" element={<ProtectedRoute moduleKey="calls"><CallsPage /></ProtectedRoute>} />
                {/* Recordings merged into Call History (2026-06). Keep the old path working. */}
                <Route path="/recordings" element={<Navigate to="/call-history" replace />} />
                <Route path="/missed-calls" element={<ProtectedRoute moduleKey="missed_calls"><MissedCallsPage /></ProtectedRoute>} />
                <Route path="/segments" element={<ProtectedRoute moduleKey="segments"><SegmentsPage /></ProtectedRoute>} />
                <Route path="/segments/:id" element={<ProtectedRoute moduleKey="segments"><SegmentDetailPage /></ProtectedRoute>} />
                <Route path="/personal-list" element={<ProtectedRoute moduleKey="calls"><PersonalListPage /></ProtectedRoute>} />
                <Route path="/call-again" element={<ProtectedRoute moduleKey="calls"><CallAgainPage /></ProtectedRoute>} />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </Suspense>
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
