---
name: elyon-customer360-and-integrations
description: Customer 360 (one timeline per phone — customer_timeline, GET /api/customers/timeline, src/components/customer360) and Settings → Integrations health (integrations_health(), per-feed freshness that must stay in step with insights_overview's freshness block, the collabbox_feed_state() stub, every pg_cron job, the 7-day no-parcel rule card and the owners' Report ↔ Apply switch), and who may see what on both. Read before touching the timeline, a feed's freshness threshold, the no-parcel switch, or any owner-only money key on these surfaces.
---

# Customer 360 & Settings → Integrations health — MACEDONIA

Both shipped in d91b0a9 (migrations 20260939000100 and 20260939000200, applied; `api` deployed
at d91b0a9 — HANDOFF §2).

## Customer 360 — everything we hold on one phone

**Path:** `CustomerHistoryDialog` → tab "timeline" (Orders and Prediction Leads pages; fetched
only when the tab opens) → `GET /api/customers/timeline?phone=` (`api/index.ts:12065`) →
`customer_timeline(p_phone, p_include_money)` (20260939000100; SECURITY DEFINER, service_role +
the read-only harness only) → `C360.shapeTimeline()` (`supabase/functions/api/customer360.ts`) →
`src/components/customer360/CustomerTimeline.tsx` (+ pure `timelineModel.ts`).

- **Phone = last 8 digits** (`elyon-phone-normalization`). < 8 digits → `phone_too_short`
  (nothing is read); a scientific-notation value → `phone_corrupted` (api only).
- **One purchase = one event.** Event kinds, newest first:

| Kind | What | Nested |
|---|---|---|
| `order` | every CRM order on the phone, any source; 0 ден call-outcome rows flagged `disposition` | its MEX parcel(s) (register rows by `order_id` or tracking id; else the order's own `mex_*` copy, `from_order: true`), its latest AlterCPA ledger row (`lead`), items, reasons, `sold_by/sold_at/sold_via`, `paid_basis`, human-note count + newest 3 `System…` notes |
| `web_order` | `web_orders` on `phone8`, not deleted; `status` = `web_order_outcome()` | its parcel by `mex_tracking_id` |
| `altercpa_lead` | a ledger row that is NOT one of this customer's orders (never promoted, skipped, or promoted onto an order with another phone); geo `MK` unless promoted; `decided_by` via the `altercpa_user` identity | — |
| `parcel` | a MEX parcel on the phone owned by none of the above — a MEX-only sale, or `linked_elsewhere` (linked to another phone's order); `channel` from NTMK / series (web, teleshop, social, leads_out, leads, crm, other) | — |
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
(`api/index.ts:16961`, `isBusinessOwner()` else 403 `owners_only`) → `integrations_health()`
(20260939000200:877, service_role only) → `{generated_at, today, feeds[], no_parcel, cron[]}`.

### Feed cards — status `ok | stale | failing | n/a`

Headline thresholds are **the Overview's freshness formulas** (`frj` in `insights_overview()`,
20260936000000:989-1090). **KEEP THE TWO IN STEP** — a change in one is a change in both. The
Overview says `failed` where this page says `failing`.

| Feed | failing | stale |
|---|---|---|
| `altercpa` | no ok `rolling` run, or the last rolling run is not ok | last ok rolling run > 15 min ago |
| `mex_bio_natural`, `mex_natura` | no last ok, or the newest settled MEX run (any kind, 10 days) is not ok | last ok (a run that fetched THIS account, else the register's last sighting) < *expected* − 45 min; *expected* = now between 07:45 and 21:00 Skopje, else the last 20:40 |
| `web` | no ok/partial run, or the last settled run failed | last ok/partial run > 45 min ago |
| `collabbox` | `collabbox_feed_state()` says `failed` | newest collabBox document > 7 days old; none at all → `n/a` |

- **One deliberate refinement:** a run still `running` and < 15 min old is ignored when reading
  "the last run's status"; ≥ 15 min it counts as failed (hung).
- **MEX runs are shared** by both accounts: an ok run counts for the account it fetched
  (`skipped ? fetched_<acct>`); a failed run fails both.
- **Per-job rows** (the expected cron jobs + any other kind seen this week as `manual`):
  AlterCPA `rolling` (15 min), `status` (30 min before the expected 07:30–21:00 / 20:55 slot),
  `nightly` (26 h), `weekly` (8 days); MEX `rolling` (45 min before expected), `backfill` (8 days);
  web `incremental` (45 min), `backfill` (26 h). Each: last ok, last run, last error (red only
  when newer than the last success — `errorIsCurrent`), runs / failed / rows in 24 h, a 7-day
  ok/failed strip. Expect the AlterCPA `nightly`/`weekly` rows to read failing: every sweep since
  18.09 ends "stale: still running after 10 minutes" (HANDOFF §4.2).
- **`cron[]`:** every pg_cron job from the newest 50 000 `job_run_details` (8 days):
  `failing` if its last run failed, `n/a` if inactive or never run. A `succeeded` `invoke_*` job
  only means the HTTP call was queued — the feed card says whether the sync itself worked.

### `collabbox_feed_state()` — THE collabBox freshness (a stub today)

- Today collabBox is a manual import: `ok` / `stale` (> 7 days) / `n/a` from the newest
  `orders.sale_source = 'collabbox'` `created_at`; `lag_parcels` = NATURA 9100/9102/9108 parcels
  with COD > 0, > 48 h old, linked to no order and not claimed by a live web order.
- Keys `feed · last_ok_at · status · detail · data_through · lag_parcels` are a contract: the
  Overview is to read the same function. The overlay (`IC.overlayFreshness` in
  `GET /insights/overview`) is in the WIP `index.ts` only; the deployed d91b0a9 Overview still
  computes collabBox freshness in `insights_overview`'s own `fr_cb` (same 7-day rule, no lag).
- The real run log would replace the body via `supabase/paused/20260939000350_collabbox_sync.sql`
  — **PAUSED by the owner 28.09** (`supabase/paused/README.md`; never applied). The deployed
  `collabbox-sync` function is a one-GET reachability probe.

### The no-parcel rule card (10 days since 28.09; code `no_parcel_7d`) and the owners' Report ↔ Apply switch

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
  and never cancelled. The ledger IS the audit trail (no human actor for `audit_log`).
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
  (20260939000200:1494) refuses INSERT/UPDATE/DELETE of key `no_parcel_rule` for `anon` /
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
