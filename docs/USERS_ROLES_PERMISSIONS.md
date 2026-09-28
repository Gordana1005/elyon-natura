# Users, roles & permissions

> Who can log in, what role(s) they hold, and exactly what each role can see and do. Access is enforced
> in **three layers** — frontend gates (UX), Edge‑Function role checks (the real gate), and Postgres RLS
> (backstop). All three read from the same role/permission data.

---

## 1. Accounts

- **Auth:** Supabase email/password. A user = a row in `auth.users` + a `profiles` row (`full_name`,
  `email`, `is_active`, `language`, `last_seen_at`, `voip_state`, `voip_state_at`) auto‑created by the
  `handle_new_user` trigger on signup.
- **Create users:** `POST /users/create` (admin/manager, rate‑limited 10/min) creates the auth user,
  profile, and role(s). UI: [../src/pages/UsersPage.tsx](../src/pages/UsersPage.tsx). Bootstrap script:
  `scripts/create-admin-users.mjs` (the 3 founding admins); `scripts/create-agents-2026-05.mjs` created
  two agents as `pending_agent + prediction_agent`.
- **Manage:** `PUT /users/:id/roles` (replace set), `PATCH /users/:id/role` (single), `POST /users/:id/toggle-active`,
  `DELETE /users/:id`. You can't change/disable your own account via these (self‑guard).
- **Login emails:** the founding accounts use placeholder `…@elyoncrm.local` domains (no email is sent —
  `email_confirm=true`). Swap for real emails if you want password‑reset emails to work.

---

## 2. The 7 roles (`app_role`)

A user can hold **several** roles (rows in `user_roles`). The frontend computes boolean flags + a "primary"
role for display ([../src/contexts/AuthContext.tsx](../src/contexts/AuthContext.tsx)).

| Role | Who | Capabilities |
|---|---|---|
| `admin` | Mile + super‑users | Everything, everywhere. Auto‑granted every other role (see §5). |
| `manager` | Managers | Same as admin in most checks (`is_admin_or_manager`); assign, review, analytics, products, users. |
| `agent` | The ~3 call‑centre agents | Calls, their assigned orders/leads, their own call history; no admin pages, no cost/profit. |
| `warehouse` | Warehouse staff | Flip orders shipped/paid/returned, warehouse page, fulfilment data. |
| `prediction_agent` | Prediction/segment workers | Like agent, segment‑focused. Counts as an "agent" in flags. |
| `pending_agent` | New users awaiting approval | Minimal/read‑only until a real role is granted. Counts as "agent". |
| `ads_admin` | Ads/marketing | Webhooks & Ads module only. |

Primary‑role precedence (display): admin → manager → prediction_agent → pending_agent → agent → warehouse → ads_admin.

### 2a. Owners — who sees money (Macedonia, 27–28.09.2026)

Money is not a role. ONE predicate decides it everywhere — RLS policies, the `api` function
(`rpc is_business_owner` / `isBusinessOwner()`), and the frontend (`get_my_permissions().isBusinessOwner` →
`canSeeBusiness`, `useInsightsAccess().business` / `.money`):

- `public.is_business_owner(uid)` is true for anyone on `public.business_owners` (Settings → Owners,
  [../src/components/settings/OwnersTab.tsx](../src/components/settings/OwnersTab.tsx);
  `20260934000000_business_owners.sql`) **or any ACTIVE admin** (`20260939000500_admins_are_owners.sql`,
  owner ruling 28.09: "all admins should be able to see it all"; a suspended admin loses it).
- **Managers are not owners.** Shared operational surfaces (e.g. `/insights/overview`) give them the same
  payload with every money key absent (`meta.money = false`, the `stripOverviewMoney` whitelist in
  `supabase/functions/api/overview.ts`); owner-only surfaces (Settings → Teams / Integrations,
  `/insights/pivot`, `/management-insights` beyond `?scope=calls`, the presence day sheet) answer
  `403 owners_only`.
- The presence idle-alert "owners" recipient group uses the same predicate.
- Owner-only tables include `mex_parcels`, `web_orders`, the no-parcel ledger and the people/teams tables;
  see [[elyon-security]] (`.grok/skills/elyon-security/SKILL.md`) for the full list.

---

## 3. The permission system (three tables)

Bootstrapped by one RPC, `get_my_permissions()` (SECURITY DEFINER), which the frontend calls once on
login ([../src/contexts/PermissionsContext.tsx](../src/contexts/PermissionsContext.tsx)). It returns:

| Table | Controls | Used by |
|---|---|---|
| `module_settings` | Global feature flags per module (`is_enabled`, `is_protected`) | `isModuleEnabled()` |
| `role_permissions` | Per‑role, per‑module `can_view/create/edit/delete/export` | `canAccessModule()`, `canAction()` |
| `financial_visibility` | Per‑role money fields (`show_profit/cost/net_contribution/returned_value/financial_insights`) | `canSeeFinancial()` |

**Module → route map** lives in `MODULE_ROUTE_MAP` (frontend). Editing the matrix is an admin task in
[../src/pages/SettingsPage.tsx](../src/pages/SettingsPage.tsx) (`/settings`). Seeded by
`20260506170000_seed_default_permissions.sql`; the permission tables are locked down by
`20260506180000_lock_down_permissions_tables.sql` (admin‑only writes).

### Hardcoded fallbacks (not yet seeded in `module_settings`)
`canAccessModule()` short‑circuits a few keys until a seed migration lands:
- `calls` / `recordings` → any logged‑in role
- `segments` → admin/manager only
- `products` → manager/warehouse (admins already pass)
- `webhooks` → manager/ads_admin

> When you seed these into `module_settings`/`role_permissions`, remove the fallbacks so the matrix is the
> single source of truth ([AUDIT_FINDINGS.md](AUDIT_FINDINGS.md)).

---

## 4. How a permission decision is made

```
Route render: <ProtectedRoute moduleKey="X">  → canAccessModule('X')?  no → redirect
Inside page : canAction('X','edit')?  → show/hide Edit button
Money       : canSeeFinancial('show_profit')? → show/hide profit column
Server      : every privileged endpoint re-checks isAdminOrManager / isWarehouse in code
DB          : RLS policies (has_role / is_admin_or_manager) gate any direct PostgREST access
```

**Frontend gates are UX only.** The authoritative gate is the Edge‑Function role check; RLS is the final
backstop. When you add an endpoint, add the code check **and** mirror it in the frontend.

---

## 5. Admins get every role automatically

Migration `20260519100000_admin_grants_all_roles.sql` adds `admin_grant_all_roles()` + trigger
`trg_admin_grant_all_roles`: any admin user is automatically granted every non‑admin role (with a backfill).
This is why an admin can work the agent queue, act as warehouse, etc. — they hold all the flags. (It's also
why `isDualRole = isAdmin && isAgent` is effectively always true for admins, surfacing personal metrics on
the Dashboard.)

---

## 6. Shifts, breaks & presence (people management)

| Concern | Mechanism |
|---|---|
| Who works when | `shifts` + `shift_assignments` (or `shift_templates` + `assign-week`) |
| Check‑in / out | `shift_login_logs` via `POST /shifts/login-log` / `PATCH /shifts/logout-log` (logout also fires on sign‑out) |
| Breaks | `shift_breaks` via `POST /shifts/break/start|end`, `GET /shifts/break/active` |
| Reporting | `GET /shifts/statistics`, `GET /shifts/login-activity` |
| "Here right now" | `profiles.last_seen_at` via `presence/heartbeat` (45 s while tab visible); `agents/online` uses a 2‑min window |
| "On a call right now" | `profiles.voip_state` (`idle`, `dialing`, `in_call`, `wrapping`, `ending`) + `profiles.voip_state_at`, reported by the agent's **browser softphone** through the same `POST /presence/heartbeat` (optional `{voip_state}` body; re‑sent on every 45 s beat while non‑idle). `agents/online` + `operations-center` expose `in_call` = online **and** state ∈ {`dialing`,`in_call`} **and** `voip_state_at` younger than 3 min. Migration `20260908000000_profiles_voip_state.sql` |

Shift login is "I'm on shift today"; presence is "my tab is open this minute"; softphone state is "I'm on a
call right now". Operations Center and agents‑online combine all three. Pages: [ShiftsManagementPage.tsx](../src/pages/ShiftsManagementPage.tsx) (admin),
[MyShiftsPage.tsx](../src/pages/MyShiftsPage.tsx) (agent).

---

## 7. Login safety
- `blocked_login_attempts` ledgers failed logins (rate‑limit/lockout support).
- `audit_log` (append‑only, tamper‑evident) records sensitive admin actions (user create, bulk assign,
  segment assign, status bulk‑update) with actor + payload. See [SECURITY.md](SECURITY.md).

---

## 8. Adding a new role or module (checklist)
1. Add the role to the `app_role` enum (migration) **and** to the zod enum in `createUserSchema` (Edge Function)
   **and** to `AppRole` (AuthContext).
2. Seed `role_permissions` rows for the new module/role; add the module to `module_settings` + `MODULE_ROUTE_MAP`.
3. Add the route in `App.tsx` with `<ProtectedRoute moduleKey="…">` and a sidebar entry.
4. Add the server‑side role check on any new endpoints; mirror with `canAction`/`canAccessModule` on the UI.
5. Re‑deploy the Edge Function (role lists are in code) and run `db push` for the migration.
