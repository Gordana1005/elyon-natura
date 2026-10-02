---
name: elyon-customer360-and-integrations
description: Customer 360 (one timeline per phone — customer_timeline, GET /api/customers/timeline, src/components/customer360, every order badged with its department) and Settings → Integrations health (integrations_health(), per-feed freshness that must stay in step with insights_overview's freshness block, collabbox_feed_state() — the real collabBox run log since 29.09, shown like every other feed — every pg_cron job, the 10-day no-parcel rule card and the owners' Report ↔ Apply switch), and who may see what on both. Read before touching the timeline, a feed's freshness threshold, the no-parcel switch, or any owner-only money key on these surfaces.
---

# Customer 360 & Settings → Integrations health — MACEDONIA

Both shipped in d91b0a9 (migrations 20260939000100 and 20260939000200, applied; `api` deployed
at d91b0a9 — HANDOFF §2).

## Customer 360 — everything we hold on one phone

**Path:** `CustomerHistoryDialog` → tab "timeline" (Orders and Prediction Leads pages; fetched
only when the tab opens) → `GET /api/customers/timeline?phone=` (`api/index.ts:12241`) →
`customer_timeline(p_phone, p_include_money)` (20260939000100, last re-emitted by
20260942001800 behind a drift guard; SECURITY DEFINER, service_role +
the read-only harness only) → `C360.shapeTimeline()` (`supabase/functions/api/customer360.ts`) →
`src/components/customer360/CustomerTimeline.tsx` (+ pure `timelineModel.ts`).

- **Phone = last 8 digits** (`elyon-phone-normalization`). < 8 digits → `phone_too_short`
  (nothing is read); a scientific-notation value → `phone_corrupted` (api only).
- **One purchase = one event.** Event kinds, newest first:

| Kind | What | Nested |
|---|---|---|
| `order` | every CRM order on the phone, any source; 0 ден call-outcome rows flagged `disposition`; `department` = `cohort_order_source(sale_source, detail, mex_tracking_id, dept_override)` (`20260942001700`, the override passed since `…1800` — a CRM sale follows its MEX profile, `…1860`) — the badge shows the department label (`departmentLabel`, `src/lib/orderSource.ts`), the stored `source` / `source_detail` words are only the fallback | its MEX parcel(s) (register rows by `order_id` or tracking id; else the order's own `mex_*` copy, `from_order: true`), its latest AlterCPA ledger row (`lead`), items, reasons, `sold_by/sold_at/sold_via`, `paid_basis`, human-note count + newest 3 `System…` notes |
| `web_order` | `web_orders` on `phone8`, not deleted; `status` = `web_order_outcome()` | its parcel by `mex_tracking_id` |
| `altercpa_lead` | a ledger row that is NOT one of this customer's orders (never promoted, skipped, or promoted onto an order with another phone); geo `MK` unless promoted; `decided_by` via the `altercpa_user` identity | — |
| `parcel` | a MEX parcel on the phone owned by none of the above — a MEX-only sale, or `linked_elsewhere` (linked to another phone's order); `channel` from NTMK / series (web, teleshop = 9100 and 9102, social, leads_out, leads, crm, other) — the timeline's own words, older than the six departments (it does not split Телешоп – Lead in / out; `20260942001700` changed only the order events; the department rule by series is in `elyon-departments-and-sources`) | — |
| `call` | `call_logs` on the phone — timing is agent-reported while VOIP is off, never proof anyone answered | — |
| `note` | `order_notes` written by a person (`System…` notes stay inside their order) | — |
| `list` | the prediction lists the customer sits on NOW (members matched by the exact phone strings of the orders, plus `+389` + last 8) | — |

- **Caps:** newest 300 purchase-type events + newest 150 calls/notes, so a chatty customer's
  calls never push purchases off the page; `truncated`, `total_events`, `kind_counts` (full
  counts, used by the filter chips).
- **Header:** up to 6 names (case/space variants folded, Cyrillic and Latin kept apart — both
  are real), cities, first/last seen; `summary` counts (orders, sales, dispositions, delivered,
  returned, cancelled, trashed, open, in progress, web orders excl. `card_unpaid`, leads,
  parcels incl. MEX-only, calls, notes, lists).
- **Owner-only summary money:** `lifetime_delivered_mkd` = Σ COD of MEX status-2 parcels, both
  accounts, each distinct parcel once (MEX is the money truth, rule 2026-08-12);
  `paid_orders_eur` = Σ CRM price of paid/delivered non-disposition orders (includes history
  that predates the MEX register).

### Who sees what in Customer 360

| Caller | Gets |
|---|---|
| no `role_privacy.show_order_history` | 403 (admins always pass — `privCan` is admin-first) |
| anyone allowed | every event and count, and the CRM order price `amount_eur` (the same price /orders shows every staff role) |
| + business owner (`is_business_owner`) | parcel `cod_mkd`, web `amount_mkd` / `shipping_mkd` / `currency`, AlterCPA `price_eur`, `lifetime_delivered_mkd`, `paid_orders_eur` |
| + admin / manager | `webmaster` (CPA provenance — same wall as `stripCpaAttribution`) |
| without `show_customer_name` | `customer_name` / `receiver_name` and the header names masked (`maskNameValue`) |

- **Money is stripped twice.** The SQL omits owner-only keys when `p_include_money = false`;
  `shapeTimeline()` then drops, BY RULE, every key ending `_mkd` / `_eur` plus `currency` and
  `price` — except `amount_eur` at the top level of an `order` event. A money key added to the
  SQL later is therefore absent for non-owners by default. Keep money keys suffixed.
- **The UI never checks roles for money:** it renders a figure only when the key is present.
  `amount_eur`, `price_eur`, `paid_orders_eur` → `formatMoney`; `cod_mkd`, `amount_mkd`,
  `lifetime_delivered_mkd` → `formatDenari` (`elyon-currency`).

## Settings → Integrations health (owners only)

> "When the AlterCPA feed was dead for 24 days nobody noticed; this would have shown it red on
> day one." — Mile

**Path:** Settings tab `integrations` (rendered when `canSeeBusiness`) →
`IntegrationsHealthTab.tsx` (refetch 60 s, not in background; `issueCount()` counts every
stale/failing feed, job, the rule and every active cron job) → `GET /api/integrations/health`
(`api/index.ts:17248`, `isBusinessOwner()` else 403 `owners_only`) → `integrations_health()`
(first 20260939000200:877, last re-emitted by 20260942001400; service_role only) →
`{generated_at, today, feeds[], no_parcel, cron[]}`.

### Feed cards — status `ok | stale | failing | n/a`

Headline thresholds are **the Overview's freshness formulas** (`frj` in `insights_overview()`,
first in 20260936000000, last re-emitted by 20260942001400; `integrations_health()` likewise).
**KEEP THE TWO IN STEP** — a change in one is a change in both. The Overview says `failed` where
this page says `failing`.

| Feed | failing | stale |
|---|---|---|
| `altercpa` | no ok `rolling` run, or the last rolling run is not ok | last ok rolling run > 15 min ago |
| `mex_bio_natural`, `mex_natura` | no last ok, or the newest settled MEX run (any kind, 10 days) is not ok | last ok (a run that fetched THIS account, else the register's last sighting) < *expected* − 45 min; *expected* = now between 06:30 and 23:00 Skopje, else the last 22:52 run (the schedule of `20260942001300`: every 15 min 06:00–22:59) |
| `web` | no ok/partial run, or the last settled run failed | last ok/partial run > 45 min ago |
| `collabbox` | `collabbox_feed_state()` says `failed`: the last settled nightly/manual sync run failed (a `running` row > 20 min counts) | the helper says `stale`: the last ok nightly/manual run is older than *expected* − 45 min; *expected* = now 07:30–23:15 Skopje, the 22:45 run from 23:15 to 00:45, the 00:00 nightly from 00:45 to 07:30. `n/a` only before the first run with no collabBox order |

Both freshness sets follow the 15-minute schedules since **`20260942001400`** (29.09 ~04:50):
`integrations_health()` (MEX job expectation `daytime_15m`, the collabBox run log) and
`insights_overview`'s `frj` / `fr_mex_expect` (MEX detail "mex-reconcile every 15 min 06:00-22:59
(both accounts, one sweep)") were re-emitted together, drift-guarded — keep doing it that way.

- **One deliberate refinement:** a run still `running` and < 15 min old is ignored when reading
  "the last run's status"; ≥ 15 min it counts as failed (hung).
- **MEX runs are shared** by both accounts: an ok run counts for the account it fetched
  (`skipped ? fetched_<acct>`); a failed run fails both.
- **Per-job rows** (the expected cron jobs + any other kind seen this week as `manual`), stale
  thresholds by expectation: AlterCPA `rolling` (`rolling_2m`: 15 min), `status` (`daytime_5m`:
  30 min before the expected slot — now 07:30–21:00, else the 20:55 run), `nightly` (26 h),
  `weekly` (8 days); MEX `rolling` (`daytime_15m`: 45 min before expected), `backfill` (8 days);
  web `incremental` (`every_15m`: 45 min), `backfill` (26 h); **collabBox** (since 20260942001400)
  `rolling` = the cron's frequent pass (`kind 'manual'` + `trigger_kind 'cron'`; `cbx_15m`: 45 min
  before expected — now 07:30–23:00, else the 22:45 run), `nightly` (26 h), and hand-started
  windows as `manual`. Each: last ok, last run, last error (red only
  when newer than the last success — `errorIsCurrent`), runs / failed / rows in 24 h, a 7-day
  ok/failed strip. From 18.09 to 28.09 every AlterCPA `nightly`/`weekly` sweep ended "stale: still
  running after 10 minutes"; since the resumable sweeps (`20260940000100`) a run row is one slice
  and an ok row does not mean the sweep finished — read `altercpa_sweeps.status`
  (`elyon-altercpa-bridge`).
- **`cron[]`:** every pg_cron job from the newest 50 000 `job_run_details` (8 days):
  `failing` if its last run failed, `n/a` if inactive or never run. A `succeeded` `invoke_*` job
  only means the HTTP call was queued — the feed card says whether the sync itself worked.

### `collabbox_feed_state()` — THE collabBox freshness (real since 29.09)

The stub of 20260939000200 was replaced by `20260942000900` (the collabBox sync — see
`elyon-collabbox-sync`); the key contract is kept.

- Keys `feed · last_ok_at · status · detail · data_through · lag_parcels` (the contract) +
  `last_run_at · last_error · last_error_at · runs_24h · failed_24h · live_last_ok_at ·
  booked_today · stale_to_pack`.
- `status`: `failed` (the last settled nightly/manual run in `collabbox_sync_runs` failed, or a
  `running` row is older than 20 min) · `stale` (the run that should have finished did not: last
  ok older than *expected* − 45 min, *expected* = now 07:30–23:15 Skopje, the 22:45 run until
  00:45, the 00:00 nightly until 07:30 — 20260942001400; it was a flat 26 h) · `ok` · `n/a`
  (never run and no collabBox order). The every-15-minutes pass (`collabbox-sync-frequent`,
  07:00–22:59 Skopje) is recorded as `kind 'manual'`, so it keeps `last_ok_at` fresh during the
  day; the 00:00 nightly covers the night. `detail` reads "full sync every 15 min 07:00-22:59
  (yesterday + today) + nightly 00:00 (last 3 days); last ok …; documents through …; N NATURA
  parcels without a document …"; `live_last_ok_at` stays only for compatibility (the headers-only
  live read is retired).
- `last_ok_at` = the last ok nightly/manual run; `data_through` = the newest document in the
  ledger; `lag_parcels` = NATURA 9100/9102/9108 COD parcels > 48 h old, linked to no order, not
  claimed by a live web order and never seen by the sync; `stale_to_pack` = orders the sync created
  to pack that still have no parcel after 7 days (the sync no longer creates such orders).
- **Integrations card** (`integrations_health()`, re-emitted by 20260942001400): the helper's
  `status` (`failed` → `failing`), `detail`, `last_ok_at`, `data_through`, `lag_parcels`, PLUS the run
  log from `collabbox_sync_runs` — `last_run_at`, `last_error`, `runs_24h` / `failed_24h`, the jobs
  above and the 7-day strip (rows in 24 h = created + updated + credited). The words follow the
  15-minute schedules since `145645c` (`settings.integrations.feedDesc.*`, `expect.daytime_15m`
  "every 15 min, 06:00–23:00", `expect.cbx_15m` "every 15 min, 07:00–23:00", in every locale).
  **The UI reads it like every other feed (29.09 afternoon):** "Last success" (`lastOk`) = the
  last ok sync run, "Runs, 24 h" with the failures in red, then a "Newest document" row
  (`newestDoc`) for `data_through`; the 7-day strip and the jobs `rolling` (the 15-minute pass,
  `cbx_15m`), `nightly` and `manual` (hand-started windows, `expect.manual`) as on every card. The
  one collabBox difference left in `IntegrationsHealthTab.tsx` (`isCb`): its single row
  (`lag_parcels`) is a backlog, not a 24 h count, so it has no "Came in, 24 h" heading. Before, the
  card labelled `last_ok_at` "Newest document" and hid its run count — a leftover of the stub era.
  Test: `OwnerSettingsTabs.test.tsx` renders a live-shaped collabBox card (run log, three jobs, an
  old error) and asserts all of it.
- **Overview:** `GET /api/insights/overview` calls `collabbox_feed_state()` and overlays it on the
  Overview's freshness list (`IC.overlayFreshness`, `insightsCommon.ts`), replacing the old
  7-day `fr_cb` reading of `insights_overview`.
- `supabase/paused/20260939000350_collabbox_sync.sql` is **superseded — never apply it**.

### The no-parcel rule card (10 days since 28.09, APPLY mode; code `no_parcel_7d`) and the owners' Report ↔ Apply switch

- **The rule** (20260938000000): `apply_no_parcel_rule()`, cron `no-parcel-rule` at :10 every
  hour, self-gated to `settings.hour` (21 → 21:10 Skopje), one scheduled run per Skopje day.
  Settings `app_settings.no_parcel_rule` = `{mode, days (never < 3), sources, from_date, hour}`,
  seeded `report`; HANDOFF §2 records the owner flipping it to `apply` on 28.09. **The days have
  ONE reader** since 20260940000300: `public.no_parcel_rule_days()` (default 10, floor 3) —
  `apply_no_parcel_rule()`, `integrations_health().no_parcel.days_n`, `insights_overview`'s
  attention `anp` (the item carries `days`) and `GET /orders?attention=approved_no_parcel_7d`
  (`overview.ts attentionFilter(kind, now, {days, excludedPhone8s, testOrderIds})`, fed by the
  api from that RPC; both also drop the owner's test phones). Never hardcode 7 (or 10) again;
  the codes `no_parcel_7d` / `approved_no_parcel_7d` / `System (no-parcel-7d)` keep their names.
  Report mode
  writes only the ledger (`no_parcel_rule_runs` / `_items`, owners-only RLS); apply mode cancels
  (`cancellation_reason = 'no_parcel_7d'`, history as `System (no-parcel-7d)`, a note,
  `elyon.bulk_repair` on). An order with an unlinked parcel on the same phone is `needs_linking`
  and never cancelled; since `20260944000960` (owner, 01.10.2026) neither is one `in_collab` (a collabBox
  sales document for the customer since the sale) or `postponed` (a note postpones the delivery,
  ≤ `settings.postpone_days`, default 45) — runs carry `in_collab` / `postponed`, items `exempt_ref`, the
  dry run answers both counts (the card does not show them yet; the CSV's Action column does).
  The ledger IS the audit trail (no human actor for `audit_log`).
- **The phone + date link cron runs first** (`link-lead-parcels`, 21:02 Skopje, `20260944000950`): an
  orphan 9110/9103 parcel linked to its order (owner law 01.10.2026) leaves the no-parcel population
  before 21:10. Its switch `app_settings.link_lead_parcels` is guarded like `no_parcel_rule`; until a UI
  exists it is flipped with `node scripts/repair-link-lead-parcels.mjs --switch apply|report|off` (audited).
- **Card status:** `n/a` (no/inactive job) · `failing` (last cron run failed) · `stale` (nothing
  ran since the slot that should have, 20 min grace) · `ok`; last run, next run, 7-day strip
  with `to_cancel` / `cancelled`.
- **The switch:** `POST /api/integrations/no-parcel-rule/mode {mode}` → dry-run preview
  (`apply_no_parcel_rule(false, true)`) → `no_parcel_rule_set_mode(mode, actor)` (changes ONLY
  the `mode` key, row-locked) → `audit_log 'no_parcel_rule.mode'` with before / after /
  `preview_at_switch`. The confirm dialog for Apply states count, value and `needs_linking` from
  `GET …/no-parcel-rule/preview`, and its button stays disabled until that preview has loaded.
- **The CSV:** `GET …/no-parcel-rule/report?run_id=` (`no_parcel_rule_report`, default latest)
  → `noParcelReportCsv` (English headers, `Price MKD` via `eurToDen`, Skopje times, UTF-8 BOM).
- **The guard:** `app_settings` is writable by any admin/manager session through PostgREST
  (policy "Admins can manage app_settings", 20260714000000). `trg_app_settings_guard_owner_keys`
  (20260939000200:1494; keys no_parcel_rule, stock_mex_movements, stock_counted_at, mex_push, and
  link_lead_parcels since 20260944000950) refuses INSERT/UPDATE/DELETE of key `no_parcel_rule` for `anon` /
  `authenticated` (42501); the service role (the api, after its owner check) and the migration
  role still can. A new owner-only key must be added to that trigger.

### Who sees what (Integrations)

UI tab: `canSeeBusiness`. Server: `isBusinessOwner()` on every `/api/integrations/*` route.
Functions: service_role only (`collabbox_feed_state` also `supabase_read_only_user`). Since
20260939000500 every ACTIVE admin passes the owner check; managers never do — see `elyon-security`.

## Red flags

- A threshold changed in `integrations_health()` but not in `insights_overview()`'s `frj` (or back).
- Renaming a `collabbox_feed_state()` key, or applying anything from `supabase/paused/`.
- Flipping `no_parcel_rule.mode` through `app_settings` directly instead of the audited switch.
- A timeline money key without an `_mkd` / `_eur` suffix (it would slip past the rule-based
  strip), or a money render gated on a role instead of on the key being present.
- Reading a timeline `call` as a conversation that happened.

Tests: `supabase/functions/api/customer360.test.ts`, `integrationsHealth.test.ts`,
`src/components/customer360/*.test.ts(x)`, `src/components/settings/integrationsHealthModel.test.ts`,
`OwnerSettingsTabs.test.tsx`.
