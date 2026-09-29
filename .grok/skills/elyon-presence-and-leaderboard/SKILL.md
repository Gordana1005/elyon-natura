---
name: elyon-presence-and-leaderboard
description: Who is working, for how long, and who made each sale in the Macedonian Elyon CRM. Covers presence (agent_presence_days, the once-a-minute activity beat, breaks, the 30-minute idle alert, the owners' "Who is working" sheet), the people model (sales_people / sales_person_identities / sales_teams / sales_team_members / v_sales_work), the write-once orders.sold_* stamps and every rule that decides who is credited (the live trigger, the stamping cron, the attribution re-point, the no-revive guard), the TV leaderboard v2 (leaderboard_day_v2 — one row per agent split over the six departments, api/leaderboardV2.ts, TvLeaderboardPage) and the legacy v1 board (leaderboard_day), the Операции per-agent figures, and Settings → Teams. Read before touching presence, the TV board, the people/teams tables, sold_* stamping, or anything that attributes a sale to a person.
---

# Presence, sales people & the TV leaderboard — MACEDONIA

Three layers, built 27–29.09.2026:

1. **Presence** — minutes each login has the CRM open, and the 30-minute idle alert.
2. **People** — who a human is across CRM logins, AlterCPA ids and name spellings; which
   team they are in on a given day; and `orders.sold_*` — who made each order a sale.
3. **The boards** — `leaderboard_day_v2()` (the TV board since 29.09): one row per person, the
   day's sales split over the six departments; the older `leaderboard_day()` (two boards by
   source) is still the api's default response.

**Live state (29.09):** every migration named here is applied — 20260935000100/000200,
20260939000000/000200/000300 (the stamping cron: every 5 min + the 04:23 full sweep),
20260942000400 / 000800 / 001100 (stamp rules), 20260942001200 (leaderboard v2, live 29.09 05:10,
`145645c`), 20260942001800 → 001850 → 001860 (the board's department takes `orders.dept_override`:
a CRM-made sale follows its MEX profile). The `api` was last deployed 29.09 11:37 (v83, `edfa901`).

## Owner rules (law — do not re-litigate)

- **The department decides where a sale counts; the team is a badge.** A sale's department is
  `cohort_order_source(sale_source, detail, mex_tracking_id, dept_override)`: the collabBox folder
  and the MEX profile — never the system it was made in, never the seller, never her team. A
  CRM-made sale follows its parcel's profile (owner 29.09 ~12:05, `20260942001860`: BIO NATURAL =
  Affiliate – Lead out, NATURA = by series), so the same agent's sales can land in two departments.
  A team rule (`20260942001800`: `crm_prediction` sellers → Телешоп – Lead out) lived two hours and
  was withdrawn (`…1850`), like the AlterCPA-team override before it (20260942001100). See
  `elyon-departments-and-sources` §3b.
- **Leaderboard for everyone:** every member of every team valid that day is shown — online, idle,
  on break, offline, zero sales — plus anyone who sold, booked, decided, was online or logged in
  that day (the logins with no team show up with no badge).
- **Managers are shown, never ranked.** `is_manager` on the board = `sales_people.is_manager` OR an
  `admin` / `manager` role; managers are listed after everyone else with no rank.
- **Lazar Delev is an owner:** a `sales_people` row in the `management` team, `is_manager`,
  never earns (HANDOFF §3). This is DATA entered in Settings → Teams — no code or migration
  names him. Check `sales_people` before assuming.
- **AlterCPA-only operators are people too** (`sales_people.user_id` NULL). They have no CRM
  presence; the board shows their last decision instead.
- **Only the agent who decided is credited — never the manager who pressed a push** (28.09
  revision, below).
- **Payouts / bonus / commission math are DEFERRED by the owner** (new metrics are coming). The v2
  board shows **no bonus at all**; the v1 board's bonus is a projection on a wall, not payroll —
  see `elyon-agent-commissions`. Nothing here changes `confirmed_by_*`, which payout math reads.

## 1. Presence

### Two heartbeats — never feed one from the other

| Beat | Sent by | When | Writes | Used for |
|---|---|---|---|---|
| `POST /presence/heartbeat` (`api/index.ts:6115`) | `AuthContext.tsx:170-198` | every 45 s, **visible tab** (or a live softphone call) | `profiles.last_seen_at` (+`voip_state`) | lead-distribution "online" (2-min window, 20260921000000 / 20260931000001), Операции "online" |
| `POST /presence/activity` (`api/index.ts:6142`) | `src/lib/presence/tracker.ts` | every 60 s, **visible or hidden tab** | `agent_presence_days` via `presence_heartbeat()` | time on CRM, idle alerts, boards |

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
`GET /presence/day?date=` (`api/index.ts:6159`, `isBusinessOwner()` else 403 `owners_only`).
One row per staff person for that Skopje day, from `agent_presence_days` + `shift_login_logs` +
`admin_login_logs` + `shift_assignments` (affiliate-only logins dropped). Status
(`presenceStatusFor`, `api/index.ts:1560`): `online` (beat < 3 min, today only) · `offline` (had minutes) ·
`no_heartbeat` (a login record, no presence at all — e.g. an old SPA bundle) · `upcoming`
(scheduled, shift not started) · `absent` (scheduled, never came). "Agents only / All staff"
toggle uses the same agent test as the alert scope. Today refetches every 60 s.

### Shift logins and breaks (older tables the presence layer reads)

- `shift_login_logs` — agents: `POST /shifts/login-log` (the client sends `shift_date`),
  `PATCH /shifts/logout-log`. Операции reads today's rows by the Skopje date since `6e8bd8f`
  (it used the UTC date before).
- `admin_login_logs` — admins/managers bypass shift gating and are logged server-side in
  `GET /shifts/check-login` (`api/index.ts:13767`).
- `shift_breaks` — the Calls-page Break button: `POST /shifts/break/start|end`,
  `GET /shifts/break/active`; one open break per user (`idx_shift_breaks_one_open_per_user`,
  20260520120000).

## 2. People, identities, teams — 20260935000100_sales_people_teams.sql

| Object | What it is |
|---|---|
| `sales_people` (:64) | one row per HUMAN. `user_id` optional + UNIQUE (ON DELETE SET NULL), `is_active`, `is_manager`. 29.09: 47 with a CRM login + 63 placeholders (collabBox authors, former staff) |
| `sales_person_identities` (:94) | handles naming a person: `altercpa_user` (their id, per `account_id`), `collabbox_author`, `order_name` (confirmed/assigned name exactly as written). One handle → at most one person |
| `sales_teams` (:122) | `crm_prediction` (mode prediction) · `altercpa_leads` (mode pending) · `management` (mode NULL) — the modes matter to the v1 board only |
| `sales_team_members` (:146) | person × team × `valid_from..valid_to` (inclusive, NULL = current); **at most one primary team per person per day** (EXCLUDE, btree_gist). A badge only: the membership trigger of 20260942001800 that re-decided departments is dropped (`…1860`) |
| `altercpa_leads.decision / decided_by_altercpa_user / decided_at` | derived on every ledger write by `trg_altercpa_leads_decision` (:328): approved (phase 3) · cancel_other (phase 4, reason > 0 not in 2,7,8,9,10,14 — the 08-11 rule, counts as a SALE) · cancelled · trashed |
| `v_sales_work` (:550) | ONE row per human decision: CRM `order_history` transitions into confirmed/cancelled/trashed/call_again by a person (not `System (…)`, not `… — …`) + MK AlterCPA ledger decisions (test orders excluded), minus an AlterCPA record whose order already has a compatible human CRM decision at or before its `decided_at` + 15 min (the ledger row is that decision's mirror). `outcome` = sale/cancel/trash/callback; `actor_ext` = the raw key when no person matches |

- **SQL matches identities EXACTLY** (spaces included). The cross-script fold
  (`agentIdentityKey`, `api/index.ts:1195`) runs only at seed time
  (`scripts/seed-sales-people.mjs`) and as a *hint* in the unmapped queue — never in SQL. The
  collabBox sync and `backfill-sellers-collabbox.mjs` compare collabBox authors with runs of
  whitespace collapsed (`collabbox_author_identity()`), because the DB spellings carry double spaces.
- RLS: every table above is **owners-only SELECT**; writes are service role only.
- `altercpa_lead_events` (:344, append-only phase history) is defined but **nothing writes it**
  (its comment says altercpa-sync does — it does not; grep finds no writer).

## 3. `orders.sold_*` — who made this order a sale

Columns (20260935000100:366): `sold_at`, `sold_by_person_id` (FK, NO ACTION — a person who sold
cannot be deleted), `sold_via`, `sold_by_ext` (the raw decider key, kept even when no person
matches). Deliberately NOT `confirmed_at` — altercpa-sync's untouched guard reads that.

| `sold_via` | Meaning | `sold_by_ext` |
|---|---|---|
| `crm` | a CRM user decided it | user id or name |
| `crm_push` | a CRM decision pushed to AlterCPA; their approval is the mirror | the deciding agent's name |
| `altercpa` | their operator decided it in their panel | AlterCPA user id |
| `collabbox` | the collabBox document author (the sync, the importers, the seller backfill) | author as written |
| `import` | the 2026-08 AlterCPA history import | operator name |

- **Write-once per column** (`trg_orders_sold_write_once`, :502): a set value is silently kept,
  NULL → value is an allowed fill. A deliberate correction needs
  `SET LOCAL elyon.allow_sold_change = 'on'`.
- **Live stamp** `trg_orders_stamp_sold` (last re-emitted by 20260942001100): a real sale
  (confirmed/shipped/delivered/paid/returned, price > 0, not a synthetic product) that names a
  confirmer, at the write where it FIRST becomes a sale — or, for an order already a sale, the write
  that first sets its confirmer (never for an AlterCPA order: that later confirmer is whoever moved
  the parcel on). altercpa-sync writes `confirmed` with no confirmer, so AlterCPA approvals are
  never stamped live. `Import`/`System` confirmers are not people; imports fall back to
  `assigned_agent_name`. `sold_via` = `crm`, or `import`/`collabbox` for import rows;
  `sold_at` = `coalesce(confirmed_at, now())`. Three rules added 28.09:
  - **No-revive guard** (20260942000800): an UPDATE into shipped/delivered/paid/returned from a
    non-sale status (cancelled / trashed / pending) with the confirmer unchanged is NOT stamped — a
    MEX (or repair) revival is not a decision of today. The stamping cron credits it by its rules
    (the collabBox author at the booking time, the AlterCPA decision), never "now" and the old
    assigned agent.
  - **Attribution re-point** (20260942000400): for a CRM-made sale (`sold_via 'crm'`), a change of
    an already-set `confirmed_by_agent_id` — only the admin-only `POST /orders/:id/attribution`
    does it — re-points `sold_by_person_id` / `sold_by_ext` to the new confirmer; `sold_at` never
    moves.
  - **The department never depends on the seller** (20260942001100): the trigger no longer moves a
    CRM sale of an AlterCPA-team agent to `altercpa/team_prediction`; it never touches
    `sale_source`. The separate `tg_orders_zz_dept_override` (20260942001800, rule of `…1860`)
    fills `orders.dept_override` from the order's MEX profile, not from its seller.
- **A disposition that becomes a sale** (a 0 ден call-outcome row an agent turns into a real
  sale, or its duplicate) is upgraded to `prediction_list` / `direct`
  (`tg_orders_sale_detail_upgrade`, 20260942000400) — so it counts on the board and in Insights.
- **Everything else** (AlterCPA approvals, collabBox, history) is stamped by the same rules in
  two places that must stay in step: `scripts/backfill-order-deciders.mjs` (`planPageSql`) and
  `order_decider_plan()` in 20260939000300. Candidates: price > 0, not synthetic, not
  `duplicated`, and it IS or WAS a sale (status, an order_history transition, or AlterCPA
  approved/cancel_other). First rule that applies:
  1. `collabbox_author` — `sale_source` collabbox with `confirmed_by_name` → `collabbox`. It
     reads the STORED source: since the folder reclass the LEADS (`altercpa/collabbox_leads`) and
     LEADS-OUT (`elyon_crm/collabbox_leads_out`) rows are outside it (at best rule 5 would stamp a
     LEADS-OUT `crm` and look the author up by `order_name` only). Their writers stamp `sold_*`
     themselves — the sync at insert and `collabbox_credit_order()`, `import-leads-out-collabbox`,
     `backfill-sellers-collabbox`. Measured 29.09: every priced LEADS / LEADS-OUT order carries a
     person (2.397 / 3.351); the 120 without one are 0 ден replacement rows (price 0, COD 0), which
     no rule stamps. So there is no gap today — but a NEW writer of those two details must stamp
     at write, or the author is never credited.
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
- **collabBox credit outside the cron:** the collabBox sync stamps the orders it creates
  (`sold_at` = the document time, `sold_via 'collabbox'`) and credits the author of a 10111 LEADS /
  10114 LEADS-OUT document on the order holding its parcel (`collabbox_credit_order()`, write-once,
  never over another decider — `elyon-collabbox-sync`); `scripts/backfill-sellers-collabbox.mjs`
  did the same for history (run `5b29ca75`, 506 sales).
- **28.09 revision (e84cca3, stamp-review.md defect 1):** only an APPROVAL push counts
  (`audit_log order.altercpa_push`, `payload.params.accept = '1'`, not `noop`); callback
  (status 3) and cancel (status 5) pushes never make anyone the seller; the fill never resolves
  a `crm_push` through the pusher's profile. Pushes are pressed by managers (stamp-review.md:
  Kalina, Dragana, Mile — all `is_manager`), which is why this matters.
- **The cron (20260939000300, live):** `stamp_order_deciders(p_since '14 days', p_dry_run,
  p_limit 1000)` every 5 min at :01/:06/… (`stamp-order-deciders`) + nightly full sweep 02:23 UTC
  = 04:23 Skopje (summer), whole book, 5000 rows (`stamp-order-deciders-full`).
  `FOR NO KEY UPDATE SKIP LOCKED`, advisory run lock (a tick that cannot take it RAISES), applied
  runs logged to `order_decider_runs` (30 days), keeps `updated_at` via `elyon.keep_updated_at`
  (GET /call-agains reads `orders.updated_at` as last_call_at — never bump it in a bookkeeping
  write). The parity gate: `node scripts/verify-stamp-parity.mjs` (read-only; runs the
  migration's `order_decider_plan` body inline against the script's `planPageSql` on live data and
  re-derives every stored stamp — expects 0 diffs, exits 1 otherwise).
- **Between cron ticks** an AlterCPA approval is unstamped for up to 5 minutes; both boards credit
  such a sale live by the day's first `v_sales_work` sale decision that names a person (stamp or
  ledger, never both).

## 4. The TV leaderboard v2 — by department (the TV page since 29.09)

"Accurate for each agent — how much she made that day, in which department, from her own
orders." ONE board, one row per person, the day split over the six departments.

- **`leaderboard_day_v2(p_day, p_department, p_team)`** (migration 20260942001200, read-side only;
  SECURITY DEFINER, EXECUTE for service_role + the read-only verification role). Roster = every
  team member valid that day (any team, management too; a closed membership still shows on its own
  past days) + anyone credited / booking / deciding / online / logged in that day. Badge = the
  primary team valid that day (a badge only). Numbers per person × department:
  - **sales** = THE cohort's order rows (`insights_sale_rows` — read, never copied: sale day =
    `sold_at` → AlterCPA approval → `confirmed_at` → `created_at`, Skopje; "Нарачки" only =
    confirmed / packed / shipped / paid + returned; dispositions and the owner's test phones out;
    value = the parcel COD when a MEX parcel is linked (a shared parcel: the holder's share), else
    price × 61,5, in денари), department = the row's
    `cohort_order_source(sale_source, detail, mex_tracking_id, dept_override)` (the override passed
    since 20260942001800 — a CRM sale on BIO NATURAL is Affiliate – Lead out, on NATURA its series'
    department, `…1860`). **Credited to
    `sold_by_person_id`; an UNSTAMPED sale → the day's first `v_sales_work` sale decision naming a
    person.** Stamp or ledger, never both; nobody → `day_totals.no_seller` with insights_people's
    reasons. Sales cancelled / trashed after the sale: shown apart, never in sales or value.
  - **booked** = `collabbox_booked_today(p_day)` (a drift-checked copy of its filter; no order
    holds the DocNumber yet), department by document type. **Counted into the total ONLY for the
    `order` types 10036 Нарачка in · 10050 Нарачка out · 10106 Социјални мрежи**, and not when the
    customer (komitent card / teleshop registry / the document's parcel) already has a CRM /
    AlterCPA sale with no parcel of its own, created 1 day before … 2 days after, at a price that
    fits (the writer's `possible_twin_crm_sale` rule). **10111 LEADS and 10114 LEADS-OUT bookings
    are `booked_twin` — shown, never counted**: their sale is the CRM / AlterCPA order (28.09: 17 of
    the 23 LEADS-OUT bookings with a known phone had the same agent's CRM sale minutes apart). Once
    the parcel exists the collabBox sync creates the order (`sold_at` = the document time), the
    booking drops out and the order counts — same day, same author. A booking whose author is not
    named in Settings → Teams sits in the no-seller bucket.
  - **total** = sales + counted bookings (count and денари) — what ranks.
  - **worked / conversion** = `v_sales_work` over the WHOLE day, every department (the decisions on
    the owner's test orders out): worked, sale / cancel / trash / callback decisions, conversion =
    sale decisions ÷ worked; per department as well.
  - **time** = `agent_presence_days` of the day + the live state (today only); `n/a` without a CRM
    login.
  - **rank** = rank() among non-managers with a total > 0, by total денари then count (equal
    numbers share a place), within the filter shown; managers (`is_manager` or an admin/manager
    role) listed last, never ranked. **No bonus** (payouts deferred by the owner).
  - Filters: `p_department` (one of the six keys: the people with anything in it — sale, cancel,
    booking, decision — and that department's numbers), `p_team` (a team key, or `none` = no team
    that day). `day_totals` is never filtered: per department credited + no seller + web shop +
    MEX-only parcels (which no person can hold) = the cohort; `no_department` and
    `checks.bookings_filter_drift` must be 0.
  - Money: every amount is a `*_mkd` key, whole денари. ~0,35 s for one day on live data.
- **`GET /api/leaderboard?key=<token>&v=2[&day=YYYY-MM-DD][&department=<key>][&team=<key|none>]`**
  (`api/index.ts:2850`) — public, validated against `leaderboard_access_tokens` BEFORE the auth
  gate, per-IP rate limit → `supabase/functions/api/leaderboardV2.ts`: validates `department` (one
  of the six keys) and `team` (`^[a-z0-9_]{1,40}$`; an unknown key → 400) before the RPC, normalises
  the payload, and strips money by a WHITELIST of non-money keys for a caller without money access
  (a money field added to the RPC later is dropped by default). The TV token keeps the board's
  existing access rule: it receives the денари (`money: true`).
- **`src/pages/TvLeaderboardPage.tsx`** + `src/components/tvboard/*` + `src/lib/leaderboardV2.ts`:
  rank, name, team badge, department chips "Aff. out 3 · 9.000 ден", dashed booking chips
  "+5 резервирани", total, worked · conversion, time on CRM; filter bar; `?dept=` (or
  `?department=`) / `?team=` pin a TV, an old `?mode=prediction|pending` URL opens its team
  (`crm_prediction` / `altercpa_leads`); `?lang=` pins the language; a day switcher (◀ ▶) reviews
  previous days (the api's `&day=`). Today updates live via the Realtime broadcast
  `tv-leaderboard` with a 20 s polling fallback.
  `toBoardV2()` adapts a v1 response (an api without `?v=2`) so the wall never goes blank.
  Amounts are денари already → `formatDenari`, never `formatMoney`. i18n: `leaderboard2.*`
  (`teleshop_other` is `teleshopOther` in keys — `_other` is an i18next plural suffix).
- **Операции** (`GET /api/operations-center`, admin/manager) reads `leaderboard_day_v2` for today
  (all departments, all teams): per agent `sales_today` = the row's `total_count`, `worked_today` =
  its `worked`. The day's KPIs come from `insights_cohort` of the Skopje day; money tiles for
  business owners only (`docs/INSIGHTS_ANALYTICS.md`).

## 4b. The legacy v1 boards — `leaderboard_day()` (still the api default)

- **`leaderboard_day(p_day, p_mode)`** (20260939000000:96; service_role + read-only harness) —
  two boards by SOURCE: prediction = `elyon_crm` sales, pending = `altercpa | affiliate`. Who:
  members of a team with that `leaderboard_mode` valid on the day, guests (sold this board's
  source or worked it in `v_sales_work`), Settings extras (`leaderboard_roster`). What: work counts
  + conversion from `v_sales_work`; sales on the SOLD clock credited to `sold_by_person_id`;
  `delivered_cash_mkd` = MEX COD of delivered ones; presence minutes + live state. Teleshop (in and
  out), social and the collabBox bookings are on neither board, and managers were ranked (the 28.09
  audit: the boards showed 72% of sales) — why v2 exists.
- **`GET /api/leaderboard?key=&mode=&day=`** without `v=2` still answers with it, plus the per-mode
  `leaderboard_bonus_rules`, the day's `call_logs` counts and a daily-game bonus projection
  (`buildLeaderboardResponse()`, `api/leaderboard.ts:263`, with the edge function's OWN
  `packageBonusRate` / `tierBonus` injected). Kept so an old TV bundle keeps working;
  `verify-attribution` C4/C5 still tie these two boards to the sales ledger. Do not extend it.
- **Settings → Leaderboard** (`LeaderboardTab.tsx`, admin/manager; routes
  `leaderboard/admin|roster|rules|token`, `api/index.ts:4045-4095`): today's extras, bonus tiers
  (prediction: `revenue_target`; pending: `confirmed_count`, `avg_order_value`), TV tokens. The
  extras and bonus tiers feed v1 only; the TV tokens gate both.

## 5. Settings → Teams (owners only)

`TeamsTab.tsx` → `/api/sales-people/*` (`api/index.ts:17102`, `isBusinessOwner()` only, one
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
  script's / cron's job). Removing a handle never un-stamps. The 20260939000300 version keeps
  `orders.updated_at` with `elyon.keep_updated_at` (`session_replication_role` is refused on MK).
- **Open with the owner (29.09):** teams for the Lead-in callers (Чима, Ристеска, Кипровска), 5
  logins with no team, AlterCPA #4531, whether Milijana = "Милјана Тодоровска н.", whether the
  manager accounts (Nina / Dragana) appear on the board — `docs/handoff/2026-09-29/PRASHANJA-ZA-MILE.md`.

## Red flags

- Feeding `agent_presence_days` into `profiles.last_seen_at` or the reverse.
- Crediting a sale by `confirmed_by_*` or the pusher instead of `sold_by_person_id`.
- A fold / `ILIKE` / trim in SQL identity matching — exact values only (the collabBox author
  whitespace collapse is the one documented exception).
- Overwriting `sold_*` without `elyon.allow_sold_change`, or bumping `updated_at` in a bulk stamp.
- A manager ranked on the board, a bonus on the v2 board, a department chosen by the seller or
  her team (two team rules were tried and withdrawn — never a third), or a board query that calls
  the 3-argument `cohort_order_source` (it loses the MEX-profile override).
- Counting a LEADS / LEADS-OUT booking into a total (it doubles the CRM / AlterCPA sale), or a
  board figure that re-derives the cohort instead of reading `insights_sale_rows`.
- Changing `stamp_order_deciders` without the same change in `backfill-order-deciders.mjs`.

## Checks

`node scripts/verify-leaderboard-v2.mjs [--from --to] [--filters-day] [--inline]` — v2, per Skopje
day: L1 every person × department = a truth computed straight from orders + `v_sales_work` +
`collabbox_booked_today` (+ the twin rule; its truth reads `dept_override` since `40f1425`); L2 Σ
board = `insights_cohort` per department; L3 once and only once; L4 rank; L5 roster; L6 safety
counters; L7 filters; exit 1 on any FAIL. PASS 22–29.09 and on September + July (29.09 09:00), and
22–29.09 again after 20260942001800 (`40f1425`, 11:44 — before the `…1850` / `…1860` reversal).
`node scripts/verify-attribution.mjs` C4/C5 tie the two v1 boards to the sales ledger (read-only).
`node scripts/verify-stamp-parity.mjs` proves the cron and the backfill script stamp alike.
Tests: `src/lib/presence/state.test.ts`, `supabase/functions/api/leaderboard.test.ts`,
`leaderboardV2.test.ts` (api + `src/lib`), `teamsAdmin.test.ts`,
`src/pages/TvLeaderboardPage.test.tsx`, `teamsModel.test.ts`.
