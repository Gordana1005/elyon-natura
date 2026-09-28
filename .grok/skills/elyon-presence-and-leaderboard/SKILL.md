---
name: elyon-presence-and-leaderboard
description: Who is working, for how long, and who made each sale in the Macedonian Elyon CRM. Covers presence (agent_presence_days, the once-a-minute activity beat, breaks, the 30-minute idle alert, the owners' "Who is working" sheet), the people model (sales_people / sales_person_identities / sales_teams / sales_team_members / v_sales_work), the write-once orders.sold_* stamps and every rule that decides who is credited, the TV leaderboard (leaderboard_day, api/leaderboard.ts, TvLeaderboardPage), and Settings → Teams. Read before touching presence, the TV board, the people/teams tables, sold_* stamping, or anything that attributes a sale to a person.
---

# Presence, sales people & the TV leaderboard — MACEDONIA

Three layers, built 27–28.09.2026:

1. **Presence** — minutes each login has the CRM open, and the 30-minute idle alert.
2. **People** — who a human is across CRM logins, AlterCPA ids and name spellings; which
   team they are in on a given day; and `orders.sold_*` — who made each order a sale.
3. **The boards** — `leaderboard_day()` joins roster × work × sales × presence per Skopje day.

**Live state (HANDOFF §2, 28.09):** 20260935000100/000200, 20260939000000 and 000200 are
applied; `api` is deployed at `main` d91b0a9. **20260939000300 (the stamping cron) is written
but NOT applied** — until it is, see "Live credit" below.

## Owner rules (law — do not re-litigate)

- **Source wins for money; the team is a badge.** Which board an order feeds is
  `orders.sale_source` (20260935000000), never who sold it: prediction board = `elyon_crm`,
  pending board = `altercpa | affiliate`. A pending-team agent selling from a prediction list
  appears on the prediction board as a **guest**, badge still showing her own team.
- **Leaderboard for everyone (d91b0a9):** every member of a board's team is shown every day —
  online, idle, on break, offline, zero sales. Settings extras can only ADD people.
- **Management is shown, never earns.** `is_manager` on the board = `sales_people.is_manager`
  OR an `admin`/`manager` role (`leaderboard_day`, 20260939000000:273). Management has no board
  of its own (`sales_teams.leaderboard_mode` NULL); managers appear as guests when they work.
- **Lazar Delev is an owner:** a `sales_people` row in the `management` team, `is_manager`,
  never earns (HANDOFF §3). This is DATA entered in Settings → Teams — no code or migration
  names him, and HANDOFF §4.5 still lists it as open. Check `sales_people` before assuming.
- **AlterCPA-only operators are people too** (`sales_people.user_id` NULL). They have no CRM
  presence; the board shows their last decision instead.
- **Only the agent who decided is credited — never the manager who pressed a push** (28.09
  revision, below).
- **Payouts / bonus / commission math are DEFERRED by the owner** (HANDOFF §1). The board's bonus
  is a projection on a wall, not payroll — see `elyon-agent-commissions`.

## 1. Presence

### Two heartbeats — never feed one from the other

| Beat | Sent by | When | Writes | Used for |
|---|---|---|---|---|
| `POST /presence/heartbeat` (`api/index.ts:5987`) | `AuthContext.tsx:170-198` | every 45 s, **visible tab** (or a live softphone call) | `profiles.last_seen_at` (+`voip_state`) | lead-distribution "online" (2-min window, 20260921000000 / 20260931000001) |
| `POST /presence/activity` (`api/index.ts:6014`) | `src/lib/presence/tracker.ts` | every 60 s, **visible or hidden tab** | `agent_presence_days` via `presence_heartbeat()` | time on CRM, idle alerts, boards |

A hidden-tab beat must never touch `last_seen_at`: a forgotten background tab would start
receiving leads (20260935000200 header).

### Browser side — `src/lib/presence/*`, `src/hooks/usePresence.ts`

- `usePresenceTracking()` is mounted by `AppLayout` only (never the login page or the public TV
  board); external affiliate logins are skipped. The tracker lives at **module scope**
  (`tracker.ts`) with a 5 s release grace, so AppLayout's per-page remount does not restart it.
- State the browser reports: `active` if any input (pointer, key, wheel, touch, scroll, focus,
  tab becoming visible) in the last `IDLE_AFTER_MS = 60 s`, else `idle` (`state.ts:18,32`). Input
  time is shared across CRM tabs via `localStorage` key `elyon.presence.lastInput:<uid>`.
- A softphone call in progress counts as activity, capped at 60 min (`CALL_ACTIVE_CAP_MS`).
- The browser never reports breaks — the server reads the break button itself.
- On `should_alert` the tracker raises the sticky self-toast (`ui.ts` `showIdleSelfToast`, id
  `presence-idle-self`, `duration: Infinity`).

### Server side — migration 20260935000200_agent_presence.sql

- **`agent_presence_days`** (:116): one row per `(user_id, Skopje day)`: online / active / idle /
  break minutes (CHECK `online = active + idle + break`), first/last seen, first/last active,
  `last_state`, `idle_streak_started_at`, `idle_alerted_multiple`, `idle_alerts`.
  RLS: the person reads own rows; `is_business_owner()` reads all. No client writes.
- **`presence_heartbeat(state)`** (:513) — the only browser door (`authenticated` may execute).
  Refuses non-staff (`is_internal_staff`, 42501); a deactivated profile returns
  `{skipped:'inactive_profile'}`. Calls `presence_record_beat(uid, state, now())` (:224,
  service_role only; the explicit clock exists for tests).
- **Minutes credited per beat**, measured from the last COUNTED beat: < 50 s → 0 (two tabs /
  double fire); < 110 s → 1; < 180 s → 2 (one throttled beat lost); ≥ 180 s → 1 and a NEW
  session (idle streak dropped). Inside the 50 s window an `active` beat still moves one minute
  idle → active ("active wins").
- **Breaks:** an open `shift_breaks` row (`break_end IS NULL`, started < 16 h ago) makes every
  beat `break`; break time never starts or extends an idle streak. A browser claiming `break`
  with no open row is counted `idle`.
- **Idle streak** starts 60 s before the first idle beat, carries over Skopje midnight while
  the session is continuous (last beat < 3 min), dies when the session goes offline.
- **`presence_close_stale_sessions()`** (:552), cron `presence-stale-sweep` every 2 min: no beat
  for > 3 min → `last_state = 'offline'`, streak dropped.

### The idle alert

- Fires when the streak crosses each multiple of `presence_idle_alert_minutes` (30, 60, 90 …),
  once per multiple (`idle_alerted_multiple`). A non-numeric setting reads as 30; 0 = off.
- **Who can trigger it** (`presence_idle_alert_scope`, default `"agents"`): holds an agent role
  (`agent/pending_agent/prediction_agent/inbound_agent`) and is NOT admin, manager or business
  owner. Everyone's minutes are still counted. `"all"` = every staff login.
- **When** (`presence_idle_alert_hours`, default `{"from":7,"to":22}` Skopje, `from > to` wraps
  midnight, `from = to` = all day). Outside the hours the marker is left alone, so the first
  in-hours beat sends ONE catch-up alert.
- **Who is told:** the person (`type 'inactivity'`, `meta {i18n:'notif.inactivitySelf', minutes,
  self:true, subjectId, day}`) plus every recipient from `presence_idle_alert_recipients`
  (default `"owners"`; also `"admins"`, a uuid, or an array) — never the person twice, active
  profiles only (`meta.i18n 'notif.inactivity'`). Since 20260939000500 `"owners"` =
  `business_owners` ∪ every ACTIVE admin. Inserts run in a subtransaction: a failed alert
  never costs the minute (RAISE WARNING only).
- The four knobs are plain `app_settings` rows (seeded :108). **There is no Settings UI** for
  them; only `presence_idle_alert_minutes` is read by the api (the owners' panel footer).
- Bell side: see `elyon-notifications` (self copy → sticky toast; owner copy click opens the sheet).

### The owners' "Who is working" sheet

`PresenceHeaderButton` (top bar, rendered when `canSeeBusiness`) → `PresenceDayPanel` →
`GET /presence/day?date=` (`api/index.ts:6031`, `isBusinessOwner()` else 403 `owners_only`).
One row per staff person for that Skopje day, from `agent_presence_days` + `shift_login_logs` +
`admin_login_logs` + `shift_assignments` (affiliate-only logins dropped). Status
(`presenceStatusFor`, `api/index.ts:1532`): `online` (beat < 3 min, today only) · `offline` (had minutes) ·
`no_heartbeat` (a login record, no presence at all — e.g. an old SPA bundle) · `upcoming`
(scheduled, shift not started) · `absent` (scheduled, never came). "Agents only / All staff"
toggle uses the same agent test as the alert scope. Today refetches every 60 s.

### Shift logins and breaks (older tables the presence layer reads)

- `shift_login_logs` — agents: `POST /shifts/login-log`, `PATCH /shifts/logout-log`.
- `admin_login_logs` — admins/managers bypass shift gating and are logged server-side in
  `GET /shifts/check-login` (`api/index.ts:13591`).
- `shift_breaks` — the Calls-page Break button: `POST /shifts/break/start|end`,
  `GET /shifts/break/active`; one open break per user (`idx_shift_breaks_one_open_per_user`,
  20260520120000).

## 2. People, identities, teams — 20260935000100_sales_people_teams.sql

| Object | What it is |
|---|---|
| `sales_people` (:64) | one row per HUMAN. `user_id` optional + UNIQUE (ON DELETE SET NULL), `is_active`, `is_manager` |
| `sales_person_identities` (:94) | handles naming a person: `altercpa_user` (their id, per `account_id`), `collabbox_author`, `order_name` (confirmed/assigned name exactly as written). One handle → at most one person |
| `sales_teams` (:122) | `crm_prediction` (mode prediction) · `altercpa_leads` (mode pending) · `management` (mode NULL) |
| `sales_team_members` (:146) | person × team × `valid_from..valid_to` (inclusive, NULL = current); **at most one primary team per person per day** (EXCLUDE, btree_gist) |
| `altercpa_leads.decision / decided_by_altercpa_user / decided_at` | derived on every ledger write by `trg_altercpa_leads_decision` (:328): approved (phase 3) · cancel_other (phase 4, reason > 0 not in 2,7,8,9,10,14 — the 08-11 rule, counts as a SALE) · cancelled · trashed |
| `v_sales_work` (:550) | ONE row per human decision: CRM `order_history` transitions into confirmed/cancelled/trashed/call_again by a person (not `System (…)`, not `… — …`) + MK AlterCPA ledger decisions (test orders excluded), minus an AlterCPA record whose order already has a compatible human CRM decision at or before its `decided_at` + 15 min (the ledger row is that decision's mirror). `outcome` = sale/cancel/trash/callback; `actor_ext` = the raw key when no person matches |

- **SQL matches identities EXACTLY** (spaces included). The cross-script fold
  (`agentIdentityKey`, `api/index.ts:1167`) runs only at seed time
  (`scripts/seed-sales-people.mjs`) and as a *hint* in the unmapped queue — never in SQL.
- RLS: every table above is **owners-only SELECT**; writes are service role only.
- `altercpa_lead_events` (:344, append-only phase history) is defined but **nothing on this
  branch writes it** (its comment says altercpa-sync does — it does not; grep finds no writer).

## 3. `orders.sold_*` — who made this order a sale

Columns (20260935000100:366): `sold_at`, `sold_by_person_id` (FK, NO ACTION — a person who sold
cannot be deleted), `sold_via`, `sold_by_ext` (the raw decider key, kept even when no person
matches). Deliberately NOT `confirmed_at` — altercpa-sync's untouched guard reads that.

| `sold_via` | Meaning | `sold_by_ext` |
|---|---|---|
| `crm` | a CRM user decided it | user id or name |
| `crm_push` | a CRM decision pushed to AlterCPA; their approval is the mirror | the deciding agent's name |
| `altercpa` | their operator decided it in their panel | AlterCPA user id |
| `collabbox` | the collabBox document author | author as written |
| `import` | the 2026-08 AlterCPA history import | operator name |

- **Write-once per column** (`trg_orders_sold_write_once`, :502): a set value is silently kept,
  NULL → value is an allowed fill. A deliberate correction needs
  `SET LOCAL elyon.allow_sold_change = 'on'`.
- **Live stamp** `trg_orders_stamp_sold` (:412): a real sale (confirmed/shipped/delivered/paid/
  returned, price > 0, not a synthetic product) that names a confirmer, at the write where it
  FIRST becomes a sale — or, for an order already a sale, the write that first sets its confirmer
  (never for an AlterCPA order: that later confirmer is whoever moved the parcel on).
  altercpa-sync writes `confirmed` with no confirmer, so AlterCPA approvals are never stamped
  live. `Import`/`System` confirmers are not people; imports fall back to `assigned_agent_name`.
  `sold_via` = `crm`, or `import`/`collabbox` for import rows.
- **Everything else** (AlterCPA approvals, collabBox, history) is stamped by the same rules in
  two places that must stay in step: `scripts/backfill-order-deciders.mjs` (`planPageSql`) and
  `order_decider_plan()` in 20260939000300. Candidates: price > 0, not synthetic, not
  `duplicated`, and it IS or WAS a sale (status, an order_history transition, or AlterCPA
  approved/cancel_other). First rule that applies:
  1. `collabbox_author` — collabBox order with `confirmed_by_name` → `collabbox`.
  2. `history_import` — altercpa/history, not a duplicate, named operator → `import`.
  3. `crm_decided` — the FIRST transition into a sale status was made by a person → `crm`;
     `crm_decided_pushed` → `crm_push` when an **approval** push also landed 15 min before /
     5 min after AlterCPA's approval.
  4. AlterCPA order approved/cancel_other: no approval push → `altercpa_ledger` (the ledger's
     `decided_by_altercpa_user` via the `altercpa_user` identity of THAT row's account) → `altercpa`;
     an approval push → `crm_push_only`: **the agent named in the push comment**
     (`Agent: <name> — …`) via the `order_name` identity → `crm_push`; a push naming nobody →
     left unresolved and reported.
  5. `crm_confirmer` — no sale transition in order_history (pre-history rows), not AlterCPA →
     the confirmer's login, else (elyon_crm only) the exact `confirmed_by_name` → `crm`.

  `sold_at`: collabbox / import / confirmer → `coalesce(confirmed_at, created_at)`; crm_decided(_pushed)
  → that first transition's `changed_at`; crm_push_only / altercpa_ledger → the ledger's
  `decided_at`. A rule with no time is left unstamped (`no_time`), like the script.
- **28.09 revision (e84cca3, stamp-review.md defect 1):** only an APPROVAL push counts
  (`audit_log order.altercpa_push`, `payload.params.accept = '1'`, not `noop`); callback
  (status 3) and cancel (status 5) pushes never make anyone the seller; the fill never resolves
  a `crm_push` through the pusher's profile. Pushes are pressed by managers (stamp-review.md:
  Kalina, Dragana, Mile — all `is_manager`), which is why this matters.
- **The cron (20260939000300, NOT applied):** `stamp_order_deciders(p_since '14 days', p_dry_run,
  p_limit 1000)` every 5 min at :01/:06/… (`stamp-order-deciders`) + nightly full sweep 02:23 UTC,
  whole book, 5000 rows (`stamp-order-deciders-full`). `FOR NO KEY UPDATE SKIP LOCKED`, advisory
  run lock (a tick that cannot take it RAISES), applied runs logged to `order_decider_runs`
  (30 days), keeps `updated_at` via `elyon.keep_updated_at` (GET /call-agains reads
  `orders.updated_at` as last_call_at — never bump it in a bookkeeping write). The gate before
  applying it: `node scripts/verify-stamp-parity.mjs` (read-only; runs the migration's
  `order_decider_plan` body inline against the script's `planPageSql` on live data and
  re-derives every stored stamp — expects 0 diffs, exits 1 otherwise).
- **Live credit until the cron runs:** `leaderboard_day` dates an UNSTAMPED AlterCPA sale by its
  ledger `decided_at` and credits the day's `v_sales_work` sale row; counted in
  `summary.live_credited_sales` (20260939000000:71-80).

## 4. The TV leaderboard

- **`leaderboard_day(p_day, p_mode)`** (20260939000000:96; service_role + read-only harness) —
  who: members of a team with that `leaderboard_mode` valid on the day (a closed membership
  still shows on its past days), guests (sold this board's source or worked it in
  `v_sales_work`), Settings extras (`leaderboard_roster`). What: work counts + conversion from
  `v_sales_work`; sales on the SOLD clock (`sold_at`, else confirmed_at, else created_at;
  dispositions and `monadon_legacy` excluded) credited to `sold_by_person_id`; where those
  sales stand now; `delivered_cash_mkd` = MEX COD of delivered ones; presence minutes + live
  state (`n/a` without a login); first login; `last_decision_at`.
- **`GET /api/leaderboard?key=&mode=&day=`** (`api/index.ts:2816`) — public, validated against
  `leaderboard_access_tokens` BEFORE the auth gate, per-IP rate limit. Adds the per-mode
  `leaderboard_bonus_rules` and the day's `call_logs` counts, then
  `buildLeaderboardResponse()` (`api/leaderboard.ts:263`) with the edge function's OWN
  `packageBonusRate` / `tierBonus` injected (one definition each). Net sales = still confirmed/
  shipped/delivered/paid. Prediction: per-package + the team `revenue_target` tier, paid only to
  the board team's members with ≥ 1 net sale. Pending: per-package + `confirmed_count` tier +
  `avg_order_value` tier (only from 10 net sales). Managers: 0. Sort: sold > worked > online.
  Not paid-gated — a daily game, not the commission.
- **`src/pages/TvLeaderboardPage.tsx`** (`/tv/leaderboard?key=…[&mode=][&lang=]`): no login;
  Realtime broadcast `tv-leaderboard` (`confirmed` / `refresh`, sent by
  `broadcastLeaderboard`, `api/index.ts:1550`) + 20 s polling; day switcher. Money via
  `formatMoney` (EUR → денари). Rows without CRM minutes show "last decision N min ago".
- **Settings → Leaderboard** (`LeaderboardTab.tsx`, admin/manager; routes
  `leaderboard/admin|roster|rules|token`, `api/index.ts:3966-4035`): today's extras, bonus tiers
  (prediction: `revenue_target`; pending: `confirmed_count`, `avg_order_value`), TV tokens.

## 5. Settings → Teams (owners only)

`TeamsTab.tsx` → `/api/sales-people/*` (`api/index.ts:16819`, `isBusinessOwner()` only, one
`audit_log` row per write) → SECURITY DEFINER functions in 20260939000200 (service_role only;
refusals come back as `{ok:false, error:<code>}`, HTTP status from `teamsAdmin.ts statusForCode`):

- `sales_teams_admin_overview()` · `sales_teams_unmapped(days)` — the queue: AlterCPA deciders
  with no identity, `AlterCPA #NNNN (unnamed)` placeholders, agent logins with no person, sales
  with no person by decider key. Each order group gets a `same`/`near` suggestion
  (`teamsAdmin.ts suggestPerson`) — a hint, never applied.
- `sales_person_create` (person + login + identities + first team, all-or-nothing) ·
  `sales_person_update` · `sales_person_add_identity` / `_remove_identity` ·
  `sales_person_move_team` (closes the primary covering X at X−1, or replaces it if it starts on
  X, opens the new one — one transaction; refuses `later_membership_exists`) ·
  `sales_membership_delete`.
- **Back-stamping** (`sales_backstamp_orders`): adding a handle or linking a login fills
  `sold_by_person_id` ONLY where it is NULL and `sold_by_ext` is exactly that handle — never
  restamps, never touches `sold_at/via/ext`, never stamps an unstamped order (that is the
  script's / cron's job). Removing a handle never un-stamps. ⚠️ The applied 000200 version tries
  `session_replication_role` (refused on MK) and falls back to bumping `updated_at`; the
  000300 version (unapplied) switches it to `elyon.keep_updated_at`.

## Red flags

- Feeding `agent_presence_days` into `profiles.last_seen_at` or the reverse.
- Crediting a sale by `confirmed_by_*` or the pusher instead of `sold_by_person_id`.
- A fold / `ILIKE` / trim in SQL identity matching — exact values only.
- Overwriting `sold_*` without `elyon.allow_sold_change`, or bumping `updated_at` in a bulk stamp.
- A manager earning on the board, or a board chosen by team instead of `sale_source`.
- Changing `stamp_order_deciders` without the same change in `backfill-order-deciders.mjs`.

## Checks

`node scripts/verify-attribution.mjs` C4/C5 tie each board to the sales ledger (read-only).
`node scripts/verify-stamp-parity.mjs` proves the cron and the backfill script stamp alike.
Tests: `src/lib/presence/state.test.ts`, `supabase/functions/api/leaderboard.test.ts`,
`teamsAdmin.test.ts`, `src/pages/TvLeaderboardPage.test.tsx`, `teamsModel.test.ts`.
