# Frontend & design

> React 18 + TypeScript + Vite SPA. Routing via React Router 6, server state via TanStack Query, UI via
> shadcn/ui (Radix primitives + Tailwind). Entry: [../src/main.tsx](../src/main.tsx) → [../src/App.tsx](../src/App.tsx).

---

## 1. App shell & providers

[../src/App.tsx](../src/App.tsx) wraps everything:

```
QueryClientProvider (staleTime 30s, refetchOnWindowFocus off, retry 1)
 └ ThemeProvider                 (light / dark, per device)
   └ TooltipProvider
     └ Toaster + Sonner          (two toast systems: shadcn useToast + sonner)
       └ BrowserRouter
         └ AuthProvider          (session + roles)
           └ LanguageProvider
             └ PermissionsProvider   (module/role permissions, business owner)
               └ VoipProvider        (the call engine; MK: VITE_USE_REAL_VOIP=false)
                 └ AppErrorBoundary  (a render error → message + Reload, never a white page — 29.09)
                   └ Suspense        (route-level code splitting via React.lazy)
                     └ Routes
```

Only `LoginPage`, `StartPage` and `NotFound` are eager; **every other page is `React.lazy`** → its own
chunk, loaded on first navigation. (Vite's automatic chunking is used deliberately — no manual
`manualChunks`.) A tab opened before a deploy may ask for a chunk that no longer exists: `main.tsx`
reloads once on `vite:preloadError` (not twice within 60 s — `sessionStorage` `elyon:chunk-reload-at`).

> **One cross‑context wire:** `VoipProvider` sits *below* `AuthProvider`, so it can't call up. Instead
> `VoipContext` writes every softphone state transition into the dependency‑free module store
> [../src/lib/voip/callStateBus.ts](../src/lib/voip/callStateBus.ts), which `AuthContext`'s presence
> heartbeat reads and relays as `voip_state` → `profiles.voip_state` → the "In call" status shown on the
> Assigner and Ops‑Center. Importing `VoipContext` from `AuthContext` directly would create a cycle — the
> bus is what avoids it.

---

## 2. Routes → modules → pages

Each route is wrapped in `<ProtectedRoute moduleKey="…">`. The `moduleKey` ties the route to RBAC
(section 4) and to the sidebar. Source of truth for the mapping: `MODULE_ROUTE_MAP` in
[../src/contexts/PermissionsContext.tsx](../src/contexts/PermissionsContext.tsx).

| Path | moduleKey | Page | Audience |
|---|---|---|---|
| `/start` | — | StartPage — where every login lands (below) | all |
| `/tv/leaderboard` | — (token `?key=`) | TvLeaderboardPage — the office TV, no login, no chrome | public |
| `/` | dashboard | Dashboard (admins: the Insights Overview) | all |
| `/orders` | orders | Orders (+ Daily Fulfilment CSV) | all (agents see own) |
| `/calls` | calls | CallsPage | agents |
| `/personal-list` | calls | PersonalListPage | agents |
| `/call-again` | calls | CallAgainPage | agents |
| `/assigned` | — | redirects to `/calls` — "Assigned to me" retired 29.09 (the page file and its permission rows stay) | — |
| `/prediction-leads` | — | redirects to `/calls` — hidden 2026-08-19 (`prediction_leads` has 0 rows) | — |
| `/search-prediction` | search_prediction | SearchPredictionPage | all |
| `/segments` · `/segments/:id` | segments | SegmentsPage / SegmentDetailPage | admin/manager |
| `/assigner` | assigner | AssignerPage | admin/manager |
| `/lead-distribution` | lead_distribution | LeadDistributionPage | admin/manager |
| `/predictions` · `/predictions/:id` | prediction_lists | PredictionListsPage / Detail | admin/manager |
| `/inbound-leads` | inbound_leads | InboundLeadsPage | admin/manager |
| `/webhooks` | webhooks | WebhookManagementPage ("Webhooks & Ads") | manager/ads_admin |
| `/products` | products | ProductsPage | manager/warehouse |
| `/warehouse` | warehouse | WarehousePage | warehouse/admin |
| `/insights` | insights | ManagementInsightsPage | admin/manager |
| `/operations` | operations | OperationsPage | admin/manager |
| `/performance` · `/agent-activity` | — | redirect to `/insights?tab=agents` · `?tab=call-activity` | — |
| `/users` | users | UsersPage | admin/manager |
| `/shifts` | shifts | ShiftsManagementPage | admin/manager |
| `/my-shifts` | my_shifts | MyShiftsPage | agents |
| `/call-scripts` | call_scripts | CallScriptsPage | admin/manager + agents (read) |
| `/call-history` | call_history | CallHistoryPage | all (agents see own) |
| `/recordings` | — | redirects to `/call-history` | — |
| `/settings` | settings | SettingsPage (RBAC admin) | admin |
| `/ads` | — | redirects to `/webhooks` | — |
| `*` | — | NotFound | — |

**Where a login lands (29.09.2026, `6fbbcd5`).** The login navigates to `/start`, which waits for the
session, the profile (roles) and THIS login's permissions, then goes to `homePath()`
([../src/lib/homePath.ts](../src/lib/homePath.ts)): admins / managers / business owners → `/insights`
(else `/operations` when they may open it), call agents → `/calls`, warehouse → `/warehouse`, ads admin → `/webhooks`, an
affiliate → `/affiliate`, else the first of `/calls`, `/`, `/orders`, `/warehouse`, `/webhooks` the
login may open, else `NoAccessScreen` (a message and Sign out). A profile that never arrives ends
on that screen after 8 s. `ProtectedRoute` bounces a login without access to the same `homePath()`,
never to the page it is on — the old fixed bounce sent every agent to `/assigned`, which prediction
agents cannot open: a redirect loop that rendered a white screen. `PermissionsContext` reports
`loading` until the permissions are loaded for the current user id.

**Layout.** `AppLayout`'s `h-screen` frame and its `<main>` (the only scrolling element) are
`position: relative` (`81f4182`), so absolutely positioned descendants — the sr-only captions and
table twins of the Insights tabs — stay inside the scrolling content instead of stretching the
page into an empty grey area. The TV board frame likewise.

---

## 3. Data layer

- **All app data goes through [../src/lib/api.ts](../src/lib/api.ts)** — typed wrappers around `fetch`
  that attach the Supabase JWT + anon `apikey` and call the Edge Function. TanStack Query keys are
  consistent (`['calls-page-orders', phone]`, `['customer-history', phone]`, etc.) so mutations can
  invalidate precisely.
- **Lazy keys for expandable rows:** the Assigner's per‑agent drawer used to eager‑fetch via
  `['assigned-pending']` and `['agent-assigned-members']` — **both keys are gone**. The Unassign tab now
  fetches only what the operator expands: `['assigner-agent-list-members', agentId, listId, page]` and
  `['assigner-agent-pendings', agentId]`, each `enabled` only once its row is open.
- **Direct `supabase-js`** is used in only two places: `AuthContext` (session/login) and
  `PermissionsContext` (the `get_my_permissions` RPC). Everything else is the Edge Function.
- Query defaults: `staleTime: 30s`, `refetchOnWindowFocus: false`, `retry: 1`.

---

## 4. Auth & RBAC (three layers)

**Layer 1 — Auth** ([../src/contexts/AuthContext.tsx](../src/contexts/AuthContext.tsx)):
Supabase email/password. On session, loads `profiles` + `user_roles` into an `AuthUser` with boolean
flags (`isAdmin`, `isManager`, `isAgent`, `isWarehouse`, `isAdsAdmin`, …) and a `role` (primary, for
display). A **presence heartbeat** pings `presence/heartbeat` every 45 s while the tab is visible; sign‑out
logs a shift logout first. The beat also carries `{voip_state}` — read from
[../src/lib/voip/callStateBus.ts](../src/lib/voip/callStateBus.ts) — but **only when the softphone is
non‑idle**; idle beats deliberately omit the field so a second, idle tab can't clobber a live call. While a
call is live the beat keeps running **even when the tab is hidden**.

**Layer 2 — Permissions** ([../src/contexts/PermissionsContext.tsx](../src/contexts/PermissionsContext.tsx)):
one `get_my_permissions` RPC returns three tables — `module_settings` (feature flags), `role_permissions`
(per‑role can_view/create/edit/delete/export), `financial_visibility` (per‑role money fields). Exposes:
- `canAccessModule(key)` — gates routes/nav (admins always pass; a few keys are hardcoded fallbacks
  because they aren't seeded yet: `calls`/`recordings` → any role, `segments` → admin/manager,
  `products` → manager/warehouse, `webhooks` → manager/ads_admin).
- `canAction(key, action)` — fine‑grained CRUD/export checks.
- `canSeeFinancial(metric)` — hides profit/cost/net‑contribution from agents.

**Layer 3 — Server** — every privileged endpoint re‑checks roles in code (RLS is the backstop). The two
must stay in sync. See [USERS_ROLES_PERMISSIONS.md](USERS_ROLES_PERMISSIONS.md).

`<ProtectedRoute>` redirects unauthenticated users to `/login` and blocks modules the user can't access.

---

## 5. Layout, navigation, design system

- **Layout:** [../src/layouts/AppLayout.tsx](../src/layouts/AppLayout.tsx) renders the sidebar +
  top bar; pages pass `title` and optional `headerActions`. [../src/components/AppSidebar.tsx](../src/components/AppSidebar.tsx)
  builds the nav from the modules the user can access (so agents never see admin items).
- **Design system:** **shadcn/ui** — Radix primitives styled with Tailwind, generated into
  [../src/components/ui/](../src/components/ui/) (~50 primitives: button, dialog, table, popover,
  select, command, calendar, sheet, drawer `vaul`, sidebar, chart, …). Theming is CSS‑variable based in
  [../src/index.css](../src/index.css) with the palette in [../tailwind.config.ts](../tailwind.config.ts);
  components reference semantic tokens (`bg-background`, `text-muted-foreground`, `border`, `primary`,
  `destructive`, `emerald-*` for call/positive accents). `cn()` ([../src/lib/utils.ts](../src/lib/utils.ts))
  merges class names.
- **Icons:** lucide-react. **Toasts:** sonner + shadcn `useToast`. **Charts:** recharts. **Dates:** date-fns.

### House components & conventions
| Component / helper | Role |
|---|---|
| `StatusBadge`, `PhoneQualityBadge`, `StockBadge`, `LeadQualityBadge` | Consistent coloured pills for status/quality/stock |
| `DeliveryMethodPicker` | Home/Speedy/Econt pills + cascading City→Office autocomplete (type‑to‑search, Cyrillic/Latin) |
| `CreateOrderModal` / `OrderModal` | New‑order‑during‑call / manager review‑edit; both pre‑fill from prior orders + customer_profile |
| `CustomerIntelligencePanel` | Phone‑keyed dossier (used by OrderModal; exports `LeadQualityBadge`) |
| `calls/ClientProfileCard` | The Calls strip: info · 4 metrics + quality · persistent note · toolbar · Orders/Calls dossier |
| `currency.ts` | `formatEur`, `formatLev`, `formatPriceInline` — **always show EUR + лв** |
| `notes.ts` | `cleanNoteForDisplay()` — strip import provenance on render only |
| `csv.ts` | `toCsv`/`downloadCsv` (default `;`+BOM; the Fulfilment CSV overrides to `,`+no‑BOM) |
| `roles.ts`, `address.ts`, `validation.ts`, `searchFormat.ts` | Shared role labels, address formatting, zod schemas, search highlighting |

> **Money rule (non‑negotiable):** every monetary value shows EUR over лв in stacked monospace numerals.
> Use the `currency.ts` helpers, never raw numbers.

---

## 6. The Calls page (frontend mechanics)

[../src/pages/CallsPage.tsx](../src/pages/CallsPage.tsx) is the agent's main surface. Key behaviours
(full flow in [CALLS.md](CALLS.md)):
- **Silent queue auto‑pick:** picks the first non‑empty assigned segment list; agents never see a
  remaining‑count that would create pacing pressure. Admin/manager get a visible Queue dropdown.
- **TAKE soft‑lock:** `useActiveCallView(phone)` heartbeats so the customer's pending orders flip to
  `take` (other agents see it's being worked); reverts ~2 min after disconnect.
- **Dial:** `useVoip().startCall(phone, linkedContext)` — `linkedContext` is the customer's most
  relevant order so the logged call attaches to it.
- **Outcome:** `ChooseAnswerButton` → Confirmed (opens `CreateOrderModal`, status forced `confirmed`)
  / Cancelled (records a cancelled order with reason) / Trash / Didn't Answer (re‑queues ~2 h).
- **After call:** the screen stays on the customer with a "Next customer" button so the agent can still
  create an order / edit notes post‑call.

---

## 7. Page catalogue (one line each)

Dashboard (today + lifetime KPIs) · Orders (master list, filters, Fulfilment CSV, bulk ops) · CallsPage
(agent workspace) · PersonalListPage (claimed customers) · CallAgainPage (follow‑ups due) · AssignedPage
(agent's assigned orders) · PredictionLeadsPage (agent's imported leads) · SearchPredictionPage (phone/name/order
search → dossier) · SegmentsPage / SegmentDetailPage (27 rule lists + bulk assign) · AssignerPage (distribute
pendings — 3 tabs: Prediction Lists · Pendings · Unassign, plus a right‑hand agents panel; **no per‑agent
drawer** any more, agent cards and Pendings chips jump to the Unassign tab and expand that agent's row.
Unassign = one row per agent → expands to their lists and pending leads with per‑client unassign; bulk
unassign fully detaches, clearing the agent stamp on already‑called members too. Each agent card carries a
live Status tile — In call / Available / Offline) · LeadDistributionPage (auto‑assign config ⚠️) · PredictionListsPage / Detail (XLSX lead lists) ·
InboundLeadsPage (raw webhook stream) · WebhookManagementPage (webhook admin) · ProductsPage (catalogue/stock)
· WarehousePage (ship calendar + incoming) · ManagementInsightsPage (analytics) · OperationsPage (live ops) ·
AgentPerformancePage (per‑agent) · UsersPage (accounts/roles) · ShiftsManagementPage / MyShiftsPage ·
CallScriptsPage · CallHistoryPage · RecordingsPage (shell) · SettingsPage (RBAC matrix admin) · LoginPage · NotFound.

---

## 8. Build & quality notes

- `npm run build` passes (~8 s). Largest chunks: app `index` ~526 kB, `xlsx` ~429 kB, recharts
  `AreaChart` ~413 kB (each lazy/own‑chunk; the warehouse/insights/orders pages that need them pull them
  on demand). The 500 kB warning is on the main `index` chunk.
- `npm run lint` is **red**: 643 errors / 35 warnings, ~623 are `@typescript-eslint/no-explicit-any`
  (the API layer is intentionally `any`‑heavy) plus a few `react-hooks/exhaustive-deps` warnings.
  **CI does not run lint**, so this doesn't block deploys. See [AUDIT_FINDINGS.md](AUDIT_FINDINGS.md).
- `npm test` runs one trivial vitest — there is effectively **no UI test coverage**.

> VoIP rule: the softphone is **live** (`RealVoipEngine` behind `VoipContext`). Keep engine changes
> behind that seam and don't entangle them with Calls-page/queue refactors — keep diffs focused ([CALLS.md](CALLS.md)).
