---
name: elyon-security
description: Use when working on authentication, authorization, RLS policies, webhook security, audit logging, permission systems, secret handling, CORS, rate limiting, or any security-related changes. Covers the business-owners model (is_business_owner — every active admin is an owner, managers are not), the money strip for non-owners (incl. the order window's Origin and proof), the owner-only app_settings guard, the database guard that stops AlterCPA from creating money, where a login lands (/start + homePath, the permission-loading race, the no-access screen, AppErrorBoundary, the stale-chunk reload), and the 01.10.2026 hardening — Settings writes (modules, role permissions, privacy, courier rates, the MEX push switch) only through audited api routes with the browser write policies dropped (20260943001500), the audited single writers behind guard triggers (products.kind / brand_line), the warehouse status / delete guards, and the shift login gate. Critical for protecting customer data, financial information, and operational integrity.
---

# Elyon Security Skill

Security in this CRM is not theoretical — it protects real customer data (names, phones, addresses), financial information, and the operational integrity of a live call centre + warehouse business.

## Core Security Layers

### 1. Row Level Security (RLS)
- RLS is enabled on **almost every table**.
- Agents are heavily restricted by RLS.
- Service role (`adminClient`) bypasses RLS — this is why most backend reads use `adminClient`.
- Key helper functions in the database: `is_admin_or_manager(uid)`, `has_role(uid, 'role')`,
  `is_internal_staff(uid)` (any non-affiliate role), and `is_business_owner(uid)` (§6).

**Never** assume that just because a user is authenticated they can see a row. Always respect RLS in queries.

### 2. Webhook Security (Very Important)
- All inbound webhooks are protected by **HMAC-SHA256**, timing-safe compare.
- Header: `x-webhook-signature` = `hex(HMAC_SHA256(rawBody, WEBHOOK_SECRET))`.
- Secret: `WEBHOOK_SECRET` (stored only in Supabase Secrets — never in code or browser).
- **FAIL-CLOSED (2026-06-11):** if `WEBHOOK_SECRET` is unset the function now **rejects** all webhooks (it used to accept unsigned requests with a warning). Consequence: a blank/missing secret stops inbound leads entirely rather than opening the pipeline — that's intentional. Restore the secret to restore flow.
- Rate limiting per slug + per IP (100/60s); both PBX webhooks (`missed-call`, `missed-call-vm`) are now per-IP limited too.
- **No replay protection yet** (HMAC has no timestamp/nonce) — a captured signed `/webhook/leads` or `/webhook/:slug` call can be replayed to create duplicate leads. Deferred; opencart/missed-call dedupe mitigates their cases.
- Other shared-secret endpoints follow the same fail-closed pattern: `web-sync`
  (`x-web-sync-secret`, constant-time; see `elyon-web-shop-bridge`), the postback drain
  (`POSTBACK_DRAIN_SECRET`), and the public TV board (`?key=` checked against
  `leaderboard_access_tokens` before the auth gate).

**Rule**: Any new landing page integration must go through a properly signed webhook. Never weaken the fail-closed check.

### 3. Role-Based Access Control
There is a layered permission system:

- **Roles** (`app_role`): `admin`, `manager`, `agent`, `pending_agent`, `prediction_agent`,
  `inbound_agent`, `warehouse`, `ads_admin`, and `affiliate` (an EXTERNAL partner identity).
- **Module permissions** (`role_permissions`, e.g. `segments`, `performance`, `insights`,
  `call_activity`), enforced by the edge function too, not only the UI.
- **Customer privacy** (`role_privacy`: show phone / name / address / order history / segment
  members / recordings) — masked on API responses; admin-first.
- **Written only through the api since 01.10.2026** (§11): Settings → Пристап по улога (modules +
  role permissions + privacy in one screen) saves via `PUT /api/settings/modules`,
  `/settings/role-permissions`, `/settings/privacy` — admins only, one `audit_log` row per change
  with before / after. The browser write policies are gone; reading is unchanged
  (`get_my_permissions()` is SECURITY DEFINER).
- **Money / the business view = business owners** (§6), NOT a role and NOT
  `financial_visibility`. The `financial_visibility` Settings tab is gone (01.10 — it controlled
  nothing: `canSeeFinancial()` has no caller and the api never queries the table); the table stays
  only because `get_my_permissions()` still returns it, and nothing can write it from the browser.

Admins and managers get broad operational access. Agents are restricted both by RLS and by the permission system.

Admins automatically receive every other role (2026-05-19, `trg_admin_grant_all_roles`) —
**except `affiliate`** (20260801000100): an admin must never show up in affiliate-scoped queries.
So "has an agent role" is true for every admin; gate agent-only logic on "agent role AND NOT
admin/manager".

**Affiliate hard wall** (`api/index.ts:2888`): a login whose ONLY role is `affiliate` gets 403
on everything except `affiliate/*` and `GET /me`. See `elyon-affiliates`.

### 4. Audit Log
- There is an append-only `audit_log` table.
- Important actions (especially anything touching money, assignments, or customer data) should be logged.
- `audit_log.actor_id` is NOT NULL — a human actor is required, so SQL jobs never write it; the
  api writes the row after its own permission check (e.g. `business_owner.add`,
  `sales_person.*`, `no_parcel_rule.mode`). Unattended jobs keep their own ledgers instead
  (`no_parcel_rule_runs`, `data_repair_runs`, and `order_decider_runs` once 20260939000300 is
  applied).
- Never delete or modify audit records.

### 5. CORS & Edge Function Security
- `ALLOWED_ORIGINS` in `supabase/functions/api/index.ts` is the single source of truth for CORS.
- Adding a new domain (e.g. a new landing page domain) requires updating this array **and redeploying the function**.
- Frontend-only changes are not enough.

### 6. Business owners — who sees the money

- **`public.business_owners`** (20260934000000): a named list (seeded with Mile Stoev, Mitrov,
  Hedi, Nina, Dragana, Mr Tony). No insert/update/delete policies: written only by the api
  (`GET/POST/DELETE /api/business-owners`, owners-only, audited; refuses a login that is
  inactive or affiliate-only; never removes the LAST owner, and re-inserts if two owners
  remove each other at once). Managed in Settings → Owners.
- **`public.is_business_owner(uid)` is THE predicate.** RLS policies, the api's
  `isBusinessOwner()` (`api/index.ts:2941` — `rpc('is_business_owner')`, memoized per request,
  **fail-closed**: an rpc error means "not an owner") and `get_my_permissions().isBusinessOwner`
  → PermissionsContext `canSeeBusiness` (also forced false for external affiliates) all ask it,
  so server and UI cannot disagree.
- **Every ACTIVE admin is an owner** (20260939000500, owner ruling 28.09): the function returns
  true for anyone on the list OR any login holding `admin` whose `profiles.is_active` is true.
  The Suspend button only flips `is_active`, so a suspended admin loses the money view at once.
  **Managers are not owners** (unless listed): they keep the operational view without money.
  ⚠️ Comments written on 27.09 still say "no admin bypass" (`api/index.ts` ~2932,
  PermissionsContext, SettingsPage, several route comments). The code wins: the api asks the
  DB predicate, and the DB now lets every active admin in.
- **Owners-only tables (RLS SELECT = `is_business_owner`):** `business_owners`, `mex_parcels`,
  `sales_people` / `sales_person_identities` / `sales_teams` / `sales_team_members` /
  `altercpa_lead_events`, `agent_presence_days` (plus each person's own rows), `web_orders` /
  `web_order_items`, `no_parcel_rule_runs` / `_items`.
- **Owners-only routes:** `/business-owners`, `/presence/day`, `/sales-people/*`,
  `/integrations/*`, `/insights/pivot`, `/management-insights` (a non-owner admin/manager gets
  only `?scope=calls` with the `call_activity` module); money inside `/insights/overview`,
  `/customers/timeline`, the `origin` block of `GET /orders/:id` (`edfa901`) and the Операции
  money tiles (and the WIP `/insights/cohort`).
- **Owners-only UI:** Settings → Owners / Teams / Integrations, the top-bar "Who is working"
  button, the /insights money tabs (`useInsightsAccess().business` / `.money`).

### 7. The money strip — non-owners get the same page without money

Surfaces that admins/managers share with the owners (the Overview, Customer 360, the WIP cohort)
do not 403 them — they return the SAME payload with money removed. Surfaces that are money all
the way down (`/insights/pivot`, Settings → Owners / Teams / Integrations) are owners-only.

- `supabase/functions/api/overview.ts` `stripOverviewMoney()` (:213): a **whitelist**
  (`NON_MONEY_KEYS`, :170) of allowed keys at any depth, and any key ending `_eur` / `_mkd` is
  dropped even if listed. `meta.money = false`. A money key a later migration adds is dropped
  by default — it has to be whitelisted on purpose to leak. (`insightsCommon.ts`
  `stripInsightsMoney()` is the same pattern for the WIP cohort.)
- `supabase/functions/api/customer360.ts` `shapeTimeline()`: rule-based — every `_mkd` / `_eur`
  key plus `currency` and `price`, except `amount_eur` on a CRM order event; the SQL also omits
  them (`p_include_money`). Belt and braces.
- The order window's **"Origin and proof"** (`order_origin(id)`, attached by `GET /orders/:id` for
  admin / manager): for a non-owner the api deletes `price_mkd`, `parcel.cod_mkd` and
  `collabbox.amount_mkd` (`edfa901`, 29.09); the panel shows "—". ⚠️ This one is a DENY list of
  three keys, not the whitelist / suffix rule above — a money key added to `order_origin` later
  reaches managers until it is added to that delete list.
- The UI renders money only when the key is present or `meta.money` is true — never by its own
  role check. Money keys must carry the `_eur` / `_mkd` suffix or the strips cannot see them.

### 8. Owner-only settings keys — `trg_app_settings_guard_owner_keys`

`app_settings` was writable by ANY admin/manager session straight through PostgREST (policy
"Admins can manage app_settings", 20260714000000); since **`20260943001500` (01.10) only an admin
session** can (the policy is narrowed from `is_admin_or_manager` to admin). Even so, a direct write
bypasses the api's checks and the audit row. `trg_app_settings_guard_owner_keys` (last re-emitted in
20260942000100) refuses INSERT/UPDATE/DELETE of `no_parcel_rule`, `stock_mex_movements` and
`stock_counted_at` when `current_user` is `anon` or `authenticated` (42501); the service role (the
api, after its own check + audit) and the migration role still can. Add every new owner-only key to
that trigger. ⚠ **`mex_push` is not in it yet** — an admin session could flip the push switch from
the browser without the `mex.push_settings` audit row; add it before the push goes live.

### 9. AlterCPA can never create money (61c3b8c, 20260934000200)

On 18.09 a catch-up inserted 1.344 AlterCPA orders directly as `paid` (~345 with no parcel).
Rule since 2026-08-12: AlterCPA decides only confirmed-or-dead; **MEX alone decides shipped /
paid / returned.** Enforced twice:

- **Code:** altercpa-sync maps every remote record through `resolveRemoteOutcome()`
  (`altercpa-sync/altercpa.ts`), which can only return `confirmed | cancelled | trashed | null`;
  inserts go through `assertInsertStatus()` (pending/confirmed/cancelled/trashed, else it
  throws). `HISTORY_PHASE_TO_STATUS` (phase 3 → paid) is for the history importer only, and
  `outcome.test.ts` fails if the bridge references it again.
- **Database:** `trg_orders_block_altercpa_money_insert` — BEFORE INSERT WHEN
  `source_type = 'altercpa'` refuses status shipped/delivered/paid/returned. No override, not
  even `elyon.bulk_repair`. Updates are untouched: mex-reconcile moves orders on from the courier.
- `orders.paid_basis` records WHY an order is paid (`mex | operator_ruling | legacy_import |
  manual | unproven`); a paid write that does not say is stamped `manual`
  (`trg_orders_set_paid_basis`).
- `SET LOCAL elyon.bulk_repair = 'on'` silences the order-paid, order-returned and AlterCPA
  confirm-rate notification triggers for a repair transaction — transaction-local only, never a
  session SET on a pooled connection.

### 10. Where a login lands — and never a white screen (`6fbbcd5`, 29.09)

Owner: "agents land on /calls and it must work; managers and admins land on Insights; never a white
screen, never an unwanted page." The route guards are UX, not the security boundary (the api
checks every call), but a bad bounce locks people out of their work.

- **One rule, `homePath(user, {canAccessModule, canSeeBusiness})`** (`src/lib/homePath.ts`, tested
  in `homePath.test.ts`): external affiliate → `/affiliate` (if `affiliate_portal`); admin /
  manager / business owner → `/insights` (any of `insights` · `performance` · `agent_activity` ·
  `call_activity`, or being an owner), else `/operations` when they may open it; a call agent (`agent`,
  `pending_agent`, `prediction_agent`, `inbound_agent`) → `/calls`; warehouse → `/warehouse`;
  ads admin → `/products` (was `/webhooks`, hidden since the 30.09 page audit); affiliate →
  `/affiliate`; else the first of `/calls`, `/`, `/orders`, `/warehouse`, `/products` the login may
  open; else `null` = no page at all.
- **The login goes to `/start`** (`src/pages/StartPage.tsx`, eager): it waits for the session, the
  profile (roles) and THIS login's permissions, then navigates to `homePath`. A session whose
  profile never arrives ends on the no-access screen after 8 s — never a loop.
- **The race it fixed:** permissions load in an effect AFTER the render in which a login appears,
  so for one render `loading` was false with empty permissions; every `ProtectedRoute` saw "no
  access" and bounced agents to `/assigned` — which prediction agents cannot open: `/assigned` →
  `/assigned` → … renders nothing. `PermissionsContext` now reports `loading` until the
  permissions are loaded for the CURRENT user id (`loadedFor`).
- **`ProtectedRoute`** bounces a login without access to `homePath` — never to the page it is on;
  with no home it renders **`NoAccessScreen`** (`src/components/NoAccessScreen.tsx`: a message and
  Sign out). Never hard-code a fallback page in a guard again.
- **"Assigned to me" is retired** (the last 100 orders, unfiltered — a Bulgarian leftover): gone from
  the menu; `/assigned` redirects to `/calls`; the page file and its permission rows stay.
- **`AppErrorBoundary`** (`src/components/AppErrorBoundary.tsx`, around every route in `App.tsx`):
  a render error shows `appError.*` and a Reload button instead of unmounting the app.
  **`main.tsx`** reloads once on `vite:preloadError` (a tab opened before a deploy asking for a lazy
  chunk that no longer exists), guarded by `sessionStorage` `elyon:chunk-reload-at` (not twice in
  60 s).

### 11. Settings and other writes go through the api — audited (01.10.2026)

The old Settings page wrote `module_settings`, `role_permissions`, `role_privacy` and
`financial_visibility` straight from the browser: one click, no confirm, no audit row (audit_log
held not one module or permission entry), and a module switched off hides it from EVERYONE,
admins included. Migration **`20260943001500_settings_audit.sql`** (deploy order: api → migration →
UI):

- drops the browser write policies on those four tables (reads unchanged; the old policies are in
  the migration's comments for a rollback);
- narrows the `app_settings` and `courier_rates` write policies from admin-or-manager to admin (§8).

The writes now (admins only unless noted; each one `audit_log` row with before / after):

| Write | Route | Audit action |
|---|---|---|
| modules on/off | `PUT /api/settings/modules` (confirm + 10 s Undo in the UI) | `settings.module_toggle` |
| role permissions | `PUT /api/settings/role-permissions` | `settings.role_permission` |
| privacy | `PUT /api/settings/privacy` | `settings.privacy` |
| courier rates (MEX saveable since 01.10) | `PATCH /api/courier-rates` — **owners only**, GET too | `settings.courier_rates` |
| the MEX push switch | `PATCH /api/warehouse/mex-push/settings` | `mex.push_settings` |
| `last changed by` for the rules | `GET /api/settings/meta` reads `audit_log` by action | — |

Pure half and the editable roles: `supabase/functions/api/settingsAccess.ts` (+ vitest); who sees
which section: `src/components/settings/sections.ts` (managers see only Корисници, the rules
read-only and Лично). Granting admin on /users asks first ("админ = гледа пари"); rotating or
revoking a TV token and recomputing the engine confirm.

**Audited single writers behind guard triggers.** Where a table stays writable by admins/managers
through PostgREST but one column family must be audited, the pattern is a SECURITY DEFINER writer
that opens a transaction-local gate + a BEFORE trigger that refuses every other write:
`products_set_kind()` / `tg_products_kind_guard` and `products_set_brand_line()` /
`tg_products_brand_line_guard` (`20260943001400` / `001300`; `elyon-products-catalogue`). A
maintenance script must go through the writer too. Use the same pattern for the next such column.

**Other guards of 30.09–01.10:**
- Warehouse: `PATCH /api/warehouse/incoming-orders/:id` refuses `status` (400
  `warehouse_status_disabled`); `DELETE` is admin-only (403 `admin_only`) and audited
  `order.hard_delete` — ⚠ except a `prediction_lead` row, which is deleted without the audit row.
- The MEX push: `mex_push_attempts` RLS on with no policies (service role only); the order value in
  the warehouse queue reaches owners only (`warehouseQueue.ts`).
- The shift **login gate** (`elyon-presence-and-leaderboard` §1b): `GET /shifts` and
  `/shift-templates` are for roster managers only (admin/manager + the `shifts` module) — `GET
  /shifts` had no role check before; the gate is still evaluated in the browser and fails open on a
  network error (a UX gate, not a security boundary).
- `POST /customer-profile` = the fill-only `customer_profile_merge()` with a role check (it used to
  overwrite saved data with empty values).
- `/settings` → Телефонија only while VOIP is on; hidden pages keep their routes and their api
  checks (CLAUDE.md "Hidden pages").

### 12. Личен дневник — deny-all, the api is the only door (01.10.2026, `20260944000400`)

`public.personal_notebooks` and `public.personal_notes` (an operator's notebooks and notes under
/personal-list?tab=notes) are **deny-all**: RLS on, **no policy**, `REVOKE ALL … FROM PUBLIC, anon,
authenticated`, `GRANT ALL … TO service_role`. The browser can neither read nor write them; every
read and write goes through `personal-notes/*` in `supabase/functions/api/index.ts`, which applies
the rules of `personalNotes.ts` (vitest):

- **Who writes:** the operator only (`canWrite` = self) — an admin cannot edit someone's notes either.
- **Who reads:** self, any admin, or a manager reading a **non-admin** (`canRead`; owner default:
  a manager never reads an admin's). `GET personal-notes/authors` is admin/manager only and drops
  admins for managers. Every read of someone else's (notebooks, a notebook's notes, a note, a
  search) writes `audit_log` `personal_notes.viewed_other` (viewer, owner_id, notebook_id).
- **Audit:** `personal_notes.notebook_created / notebook_renamed / notebook_deleted /
  notebook_restored / note_deleted / note_restored` — payload ids, title, char count, **never the
  body**. Autosaves are not audited. Writes are rate-limited (`personal_notes.write`, 120/min/user).
- A note's `(notebook_id, owner_id)` is a composite FK to the notebook's `(id, owner_id)`, so a note
  can never sit in another person's notebook. Autosave is versioned (`.eq('version', base)` →
  `409 version_conflict` + the current row).
- Soft delete; `personal_notes_purge()` (SECURITY DEFINER, executable by nobody) hard-deletes rows
  deleted > 30 days ago, cron `personal-notes-purge` `40 1 * * *` (GMT). The read helpers
  `personal_notebooks_overview(uuid)` / `personal_notes_authors()` are service_role only.
- Check (read-only, MK): `node scripts/verify-personal-notes.mjs` (N1 no privilege for
  anon/authenticated + RLS on + no policy, N2 note owner = notebook owner, N3 purge cron, N4 nothing
  deleted > 31 days). Never add a browser policy to these tables — add an api route.

## Common Security Gotchas in This Project

- Using `supabase` client instead of `adminClient` in the Edge Function when you need cross-user data.
- Forgetting to redeploy the Edge Function after changing `ALLOWED_ORIGINS` or webhook logic.
- Leaving `WEBHOOK_SECRET` unset in production — webhooks now **fail closed** (reject), so this silently stops all inbound leads. Always set the secret before relying on webhooks.
- Re-enabling public signup (`disable_signup` must stay `true`; users are admin-created only). HIBP leaked-password check + session timeouts are Pro-plan — enable on upgrade.
- Assuming an agent can only see their own data without checking RLS.
- Exposing money to non-owners: gating it on your own `admin` check (misses listed non-admin
  owners and suspended admins), on `financial_visibility`, or only in the UI — ask
  `is_business_owner()`.
- A new table without `REVOKE ALL … FROM PUBLIC, anon, authenticated` — default privileges
  hand it to `anon`/`authenticated` in full (see `elyon-notifications` Rule 4).
- A route guard that redirects to a fixed page, or reads permissions before they are loaded for
  the current user — the 29.09 white-screen loop. Bounce through `homePath()`; show
  `NoAccessScreen` when it returns null (§10).
- Storing secrets in `.env` that gets committed (use the proper Supabase secrets + local `.env` that is gitignored).

## When This Skill Applies

- Adding or modifying any permission check
- Working with webhooks or inbound leads
- Changing RLS policies or database functions related to auth
- Building new admin-only or owner-only features, or any surface that shows money
- Reviewing any PR that touches authentication, data access, or secrets
- Setting up a new environment or reseller instance

## Key Files & References

- `docs/SECURITY.md` and `docs/USERS_ROLES_PERMISSIONS.md` — ⚠️ neither describes the
  business-owners model yet; for money access this skill and the migrations win.
- `supabase/functions/api/index.ts` — the webhook verification function, `ALLOWED_ORIGINS`,
  the affiliate hard wall, `isBusinessOwner()`, `stripCpaAttribution` (CPA provenance is
  admin/manager only)
- `supabase/functions/api/overview.ts`, `customer360.ts` — the money strips
- Migrations `20260934000000_business_owners.sql`, `20260934000200_money_guards.sql`,
  `20260939000500_admins_are_owners.sql`; RLS policies throughout (search for `CREATE POLICY`)
- Permission checks in the frontend use `useAuth()` and `PermissionsContext`
  (`canSeeBusiness`, `useInsightsAccess()`); landing and bounces: `src/lib/homePath.ts`,
  `src/pages/StartPage.tsx`, `src/components/ProtectedRoute.tsx`, `NoAccessScreen.tsx`,
  `AppErrorBoundary.tsx`

## Decision Table

| Situation                              | Correct Approach                                      | Dangerous / Wrong Approach                     |
|----------------------------------------|-------------------------------------------------------|------------------------------------------------|
| Reading orders/leads in Edge Function  | Use `adminClient` when crossing user boundaries      | Using regular `supabase` client for admin data |
| Adding new domain                      | Update `ALLOWED_ORIGINS` + redeploy function         | Only updating frontend                         |
| New webhook                            | Create via script, enforce HMAC, set secret          | Accepting unsigned requests                    |
| Showing money / the business view      | `isBusinessOwner()` on the server, `canSeeBusiness` in the UI, strip money for non-owner admins/managers | A role check of your own, `financial_visibility`, or hiding it only in the UI |
| A new owner-only setting               | Audited api route + add the key to `trg_app_settings_guard_owner_keys` | A plain `app_settings` row any admin/manager can PATCH |
| A permission / module / privacy change | `PUT /api/settings/*` (admin, audited)               | A PostgREST write from the browser (the policies are gone) |
| A column that must be audited          | A SECURITY DEFINER writer + a guard trigger (`products_set_kind` pattern) | A plain UPDATE / PATCH with no audit row |
| An AlterCPA path that sets a status    | pending/confirmed/cancelled/trashed only; MEX moves money | Mapping an AlterCPA phase/status to paid/shipped/returned |
| Agent trying to see all data           | Let RLS + permission system restrict them            | Bypassing restrictions in the UI               |

## Golden Rules

1. **Least privilege** is the default. Start restrictive.
2. The Edge Function is the security boundary — never trust the frontend.
3. If you're unsure whether something should be visible to an agent, assume it should **not** be.
4. Money is owners-only by default: absent for everyone else, never zero-filled, never role-guessed.
5. Always think about auditability for anything that changes money, assignments, or customer records.

This system has real financial and privacy implications. Treat security changes with the same seriousness as stock or payment logic. When in doubt, ask before implementing.
