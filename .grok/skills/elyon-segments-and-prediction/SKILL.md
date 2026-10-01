---
name: elyon-segments-and-prediction
description: Use for any work involving the prediction lists (segments) — the name-construction classifier (engine v3.7-mk, sticky trash), recency/value/frequency buckets, NEWCOMERS, Current Cancels, Never-Converted, Monadon exclusion, nightly pg_cron recompute, member state carry-over, Assigner, queues, avg_package_price, bulk order imports (the deferred segment_recompute_queue), the collabBox do-not-contact / deceased Trash markers, the fact that every department's customers (teleshop included, 112k memberships since 28.09) are in the lists, and how an agent's outcome on /calls reaches the lists since 01.10.2026 (the one-tap outcome bar → POST /calls/outcome: one call_logs row, the member marked, the disposition record with the last purchase — CallAgainPage and ChooseAnswerButton are gone). This is the agents' main work surface; read this before touching anything in it. In Macedonian the lists are "предикциски листи" — never "прогнози".
---

# Elyon Segments & Prediction Lists Skill (engine v3.7-mk — Macedonia)

Every customer phone is classified into **at most one** rule-driven calling list. Classification is **name-construction**: `recompute_customer_segments(phone)` computes three buckets and targets the list whose NAME matches exactly. **The rule columns on `prediction_segment_lists` (recency_months_min/max, single_price_min/max, min_paid_count, lifetime_min, priority) are VESTIGIAL — they do not drive membership.** Do not "fix" lists by editing them; the engine is the function.

## ⚠️ The 2026-06 drift incident (read first)

(Bulgarian production, June 2026 — before the Macedonian fork; the hard rules it produced apply here unchanged.) Production once ran an OLD function body while newer migrations were recorded as applied — old SQL had been re-run over the fixed function. Damage: 94 customers silently deleted from all lists (name mismatch "2-4m"), dead NEWCOMERS/Current Cancels, ~5,590 mislabeled members, 1,555 imported Monadon phones inside calling lists, "Last order €0.00" everywhere. Hard rules since:

1. **NEVER run old migration SQL in the Supabase SQL editor.** The canonical engine lives in `supabase/migrations/20260913000200_segment_engine_v3_7_sticky_trash.sql` (engine **v3.7-mk**; supersedes 20260731000000 v3.6 → 20260730000000 v3.5 → 20260725000000 v3.4 → …) and the live function carries a `COMMENT ... 'engine v3.7-mk …'` tag.
2. **One migration version = one file.** (Two files once shared `20260604120000`; the obsolete one was deleted.)
3. After ANY engine/data change: `node scripts/audit-segments-integrity.mjs` → must be 10/10 PASS. It detects function drift, label violations, band violations, pollution, missing customers, dead cron.

**Canonical engine file**: `supabase/migrations/20260913000200_segment_engine_v3_7_sticky_trash.sql` (engine **v3.7-mk**, 2026-08-06 — sticky trash; see the Trash List section below). Its parent, still accurate for everything except trash: `supabase/migrations/20260731000000_monadon_excluded_from_never_converted.sql` (engine v3.6, 2026-07-09 — a `monadon_legacy` phone with paid_count=0 is kept OUT of Never-Converted: target NULL → it stays only in the static FULL MONAD LIST; mirrored into the v4 shadow so parity stays 0). The live function COMMENT tag begins `engine v3.7-mk 2026-08-06: STICKY TRASH`. Parent chain: 20260730000000 (v3.5 comprehensive Trash List) → 20260725000000 (v3.4 Trashed wrong-number list) → 20260712000000 (v3.3 Current Returns) → 20260710000000 (Current Cancels 14d) → 20260701000000 (NEWCOMERS pen) → 20260629000000 (v3 restore). Companion: `20260713000000_returned_at_recording_fix.sql`. Apply engine SQL on Macedonia like any migration: tripwire, then `node scripts/apply-migration-mk.mjs <file>` (Management API — the DB password was never recorded, so there is no direct pg path), then `node scripts/engine-fixture-mk.mjs`.

## Classification (decision order — first match wins)

1. **Monadon-only phone** (`orders.source_type = 'monadon_legacy'` is excluded from EVERYTHING) → no rule list; lives only in static "FULL MONAD LIST".
2. **paid_count = 0 + in-flight order** (`pending/take/call_again/confirmed/shipped/delivered`) → NO list (worked in Pendings section).
3. **Fresh cancel** (latest action, < 14 days) → **Current Cancels** (UNASSIGNED holding pen; assignment is stripped on entry). Nightly recompute returns them to a normal bucket after 14 days. Window is measured from the cancelled order's `created_at` (same as always); verified 2026-06-23 that recent cancels are created+cancelled the same day, so created_at ≈ entry date. `orders.cancelled_at` is deliberately NOT used — it is mostly NULL on recent cancels and a 2026-05-21 bulk backfill where present. (engine v3.2, 2026-06-23; was 30 days.)
4. **paid_count = 0** → Never-Converted Recent (cancel ≤ 180d) / Never-Converted Old (older/none; includes trashed-only phones — operator decision 2026-06-10). **EXCEPT** a phone with a `monadon_legacy` order (a FULL MONAD LIST member) → **NO rule list** (target NULL; engine v3.6, 2026-07-09): Monadon clients live only in the static FULL MONAD LIST until they actually buy, then they graduate to a paid band normally. Only this paid_count=0 branch is guarded — a recent cancel still parks them in Current Cancels, and a trashed newest order still shows additively in Trash List.
5. **Paid history** → name = recency + ' ' + value + ' ' + frequency:
   - **Recency** (days since last real paid order): <21 NEWCOMERS · 21–57 "21d" · 57–120 "57d" · 120–180 "4-6m" · 180–365 "6-12m" · 365–730 "1-2yr" · 730+ "2yr+".
   - **NEWCOMERS is an UNASSIGNED holding pen** (engine v3.1, 2026-06-18): on ENTRY the carry-over agent is stripped (`assigned_agent_* := NULL`), exactly like Current Cancels. Fresh buyers are visible in the Assigner but never auto-inherit an agent — only a manager's deliberate assignment sticks (it lives on the member row; the `ON CONFLICT DO UPDATE` never overwrites `assigned_agent_*`). At day 21 the nightly cron reclassifies them into the `21d …` band automatically, and at that point normal carry-over applies (a manager-set agent follows them forward).
   - **Value** (last paid order price): `≤26` vs `26+` (no split for NEWCOMERS). The `≤` is U+2264 — in SQL always build it as `chr(8804) || '26'` to survive encodings.
   - **Frequency** (lifetime paid orders, labels LITERALLY TRUE, most specific wins — operator spec 2026-06-10): 1–2 → "(1-3 orders)" · 3–4 → "(3+ orders)" · 5–6 → "(5+ orders)" · ≥7 → "(7+ orders)". A "(3+)" list must never contain a sub-3 client.

**Current Returns (ADDITIVE — engine v3.3, 2026-06-23).** Separate from the first-match-wins decision above. A customer whose **newest order is a return** ("until they order again" = no order created after their latest returned order) is tracked in **Current Returns** (UNASSIGNED, never called). It is *additive*: a customer with paid history stays in their normal band **and** also appears in Current Returns (dual membership); a return-**only** customer (paid_count = 0) appears **ONLY** in Current Returns, not Never-Converted. Current Returns is EXCLUDED from the nuclear delete + agent carry-over, and from the audit exclusivity check. Member trigger fields = the returned order (its `created_at` is the "Last order" date). `orders.returned_at` is a separate recording fix (trigger `trg_orders_set_returned_at`) — the list itself does not depend on it.

**Trash List — STICKY (engine v3.7-mk, 2026-08-06). This supersedes the v3.5 additive rule; the paragraph below is the law.** Canonical file: `supabase/migrations/20260913000200_segment_engine_v3_7_sticky_trash.sql`.

A trash is **no longer** "the customer's newest order happens to be a trash", and it is **no longer** additive-but-still-callable. Three classes, decided per phone:

- **PERMANENT** — `wrong_number` / `wrong_person` / `rude` / `uncooperative` / `other`, and legacy rows with no reason recorded. Removed from **every** calling band (highest-precedence NULL-target branch) and held in the static **Trash List**. A later **pending / cancel / return does NOT release them** — that is the whole point of the change.
- **THE ONE RELEASE** — a **paid** order dated after the trash (`v_last_paid_at > v_perm_trash_at`). Money is better evidence than a disposition click. Operator decision 2026-08-06, taken on measured data: 13.784 currently-callable MK customers carried a trash and **2.391 of them had already paid us afterwards**; Bulgaria's v3.7 deletes those forever, Macedonia keeps them. **This is a deliberate MK deviation — do not "align with BG".**
- **PARKED** — `not_reachable` only: held **21 days from `orders.trashed_at`**, then released automatically by the nightly recompute (or earlier by a payment). Written by both the manual pick (the /calls outcome bar: Корпа → reason `not_reachable`, `POST /calls/outcome`; `ChooseAnswerButton` was removed 01.10) and the server auto-trash (9 consecutive no-answers — `applyNoAnswerLifecycle()`, shared by `POST /calls/outcome` and `POST /call-logs`).
- **`duplicate_order` is NOT a trash of the customer** — it is our own double-lead cleanup, so it neither drops them from a band nor enters the Trash List. **Second deliberate MK deviation**: BG's SQL treats it as permanent while BG's own code comment says the opposite; that inconsistency is not carried over.

Sticky trash also suppresses the additive **Current Returns** mirror. Trash List is `is_static=true` → excluded from nuclear delete / carry-over / exclusivity audit; the member row carries `trigger_trash_reason` for the UI's **Reason** column. **Scope: prediction lists only** — a trashed phone that sends a brand-new lead still arrives as a normal pending order and is callable in the Pendings queue.

`orders.trashed_at` (migration `20260913000100`) drives the 21-day timer. ⚠️ Its backfill chain is `order_history → updated_at → created_at`, and MK's 17.714 imported trashes have **zero** history rows, so they all landed on the import timestamp; `20260913000300` corrects them to `created_at` (the true AlterCPA order date). Any future bulk import must do the same or every trash instant collapses onto the import date and the paid-release test silently stops firing.

Behavioural fixture (run after ANY engine change): **`node scripts/verify-sticky-trash-mk.mjs`** — 8 cases pinning all of the above plus the 14-day cancel return.

## Member rows & state carry-over (sacred)

- `trigger_price/trigger_event_at/trigger_order_id` = the "Last order" column: paid buckets → most recent paid order with price > 0 (fallback: last paid); cancel-category lists → last cancelled order. The engine WRITES these on every insert/update (the old €0.00 bug was these fields never being written).
- `avg_package_price` = lifetime_value / paid_count, EUR. **Display in денари via `formatMoney` from `src/lib/currency.ts`** (see elyon-currency: stored EUR, shown денари at the FROZEN 61,5 peg — never the Bulgarian lev / 1.95583 formatters this line used to name).
- **Carry-over**: on a band move the engine copies `assigned_agent_*`, `last_call_*`, `is_completed`, `in_call_again_until`, `call_again_since` from the previous row (prefers an assigned row). A NEW purchase resets `is_completed`/call-again (fresh lifecycle). **Current Cancels AND NEWCOMERS entry strip assignment** (both are unassigned holding pens — Current Cancels also resets `is_completed`). Never bypass this with manual SQL on members.
- **The only other way `assigned_agent_*` gets cleared** is a deliberate manager unassign (Assigner Unassign tab / `POST /assigner/unassign-all` / `POST /segments/:id/assign` with `agent_id: null`). Those null ONLY the three assignment columns — never `is_completed`, `last_call_*` or `in_call_again_until` — and a recompute will not put the agent back. See "Mass unassign" below.

## /calls — the outcome IS the call log (01.10.2026, `0711fb7`)

VOIP is off in Macedonia: agents dial from their own handsets, so the green Call button was pressed
once in a week and a cancel / trash / confirm left no call row at all (767 `call_logs` that week, 766
of them "no answer"); every outcome took 3–4 clicks. `ChooseAnswerButton` and `CallAgainPage` are gone.

- **The outcome bar** (`src/components/calls/work/OutcomeBar.tsx`, order in
  `src/lib/callsWork/outcomes.ts`): **Не одговара** (a 5 s Undo; sent when the undo closes) ·
  **Повторно** (time chips) · **Откажа** / **Корпа** (the top-4 reasons as chips, "Друго…" = the full
  picker) · **Потврди** (the order form, then logged). Pinned to the bottom on a phone; keys **1–5** on
  desktop. With VOIP off a phone shows a `tel:` link, a desktop the number + copy — no mock call.
- **`POST /api/calls/outcome`** (`supabase/functions/api/callsOutcome.ts` + vitest; client
  `apiRecordCallOutcome` in `src/lib/callsWorkApi.ts`), outcomes `no_answer · call_again · cancelled ·
  trash · confirmed`, one server call:
  1. resolves the open order(s) like the page's `chooseOpenOrder()`: 0 → a cancel / trash
     **disposition record** carrying the customer's last purchase (`last_sale_product`, below), 1 →
     that order (PATCH-status parity), more → **409 `choose_order`** — a live lead is completed, never
     forked;
  2. writes exactly ONE `call_logs` row with **`source = 'handset'`** (migration `20260943001700`;
     an answered softphone row of the last 5 min is re-tagged instead);
  3. clears missed calls and the mandatory-answer obligation; `no_answer` runs the no-answer lifecycle
     (`applyNoAnswerLifecycle()`, verbatim from `POST /call-logs` — the 9-strike Unreachable rule and
     the paced retry, prediction outreach only);
  4. marks the list member (`markAfterCall` parity) when a `list_id` is sent and the outcome is not
     `no_answer`.
  `confirmed` only logs the call — the order form confirms. A callback must fall inside the 6-day
  call-again window. Needs order-edit rights; 60 per user rate limit.
- `GET /api/calls/progress` — my calls today + the TV board's sales / worked today
  (`leaderboard_day_v2`, cached 30 s). `GET /api/calls/call-again` — the agent's own callbacks
  (`elyon-assigner`). Polls pause when the tab is hidden, back off when empty, and refresh on the
  Assigner's broadcast.
- **The product on a disposition record** (Phase 0, `20260943000200`): the page used to look the
  last product up through `GET /orders`, which RLS scopes to the agent's own orders, so a list
  customer's cancel / trash said "No prior product on file" (1.021 of 1.022 cancels in the week to
  30.09). `POST /orders` (and `/calls/outcome`) now fill it on the server from
  **`last_sale_product(phone, before)`** — the latest real sale (confirmed → returned) by last-8, its
  non-placeholder item names, `product_id` only for one item; the price stays 0, so the row stays a
  `disposition` (never a sale). **Phase 1** (`scripts/repair-disposition-products.mjs`, run
  `1c8ee475`) repaired **7.116** old records with the sale BEFORE each one (54 customers with no
  earlier sale keep the placeholder; the 598 teleshop ban markers were excluded; `--rollback`).

## When recompute runs

1. Instantly via triggers on `orders` (INSERT / DELETE / UPDATE OF status, price, customer_phone).
2. **Nightly pg_cron job `nightly-segment-recompute`** (`0 0 * * *` UTC = **02:00 Skopje** in summer, 01:00 in winter — not Skopje-gated) → `recompute_all_segments()` (~111k distinct phones on MK since 28.09 — see "Recompute at MK scale"). This powers ALL time-based movement (band aging, 14-day Current Cancels un-parking, 180-day Recent→Old, NEWCOMERS graduation). Check: `select * from cron.job;` and `cron.job_run_details`.
3. Manual: "Recompute all" button on /segments; PATCH of a list also triggers it.

## Files & surfaces

- **Engine (canonical)**: `supabase/migrations/20260913000200_segment_engine_v3_7_sticky_trash.sql` (engine **v3.7-mk**; parent `20260731000000_monadon_excluded_from_never_converted.sql` v3.6, chain up through 20260730000000 v3.5) · returned_at fix: `20260713000000_returned_at_recording_fix.sql` · cron: `20260630000000_nightly_segment_recompute_cron.sql` · bulk-load queue: `20260942000300_teleshop_import_ledger.sql` (`segment_recompute_queue`, `segment_recompute_drain()`).
- **Health check**: `scripts/audit-segments-integrity.mjs` (uses SUPABASE_ACCESS_TOKEN from .env; management API; read-only).
- **API**: `supabase/functions/api/index.ts` — GET /segments (overview + counts + `engine_data_as_of`), GET /segments/:id (paginated members), POST /segments/recompute, PATCH /segments/:id, assign/auto-assign/bulk-unassign.
- **Mass unassign (2026-07-22, FULL DETACH since 2026-07-28)**: `GET /assigner/assignment-summary` (who holds what, per agent × list — one `assignment_matrix()` RPC, migration `20260803000000`) and `POST /assigner/unassign-all` (`{agent_id:'all'|uuid, list_ids?, include_pendings?, include_done?}`), admin/manager only, audited as `assigner.unassign_all` (payload carries `include_done`). **Without `include_done` it frees ONLY `is_completed = false` rows** (the original 07-22 contract, still the API default). **The Unassign tab now ALWAYS sends `include_done: true`** — operator decision 2026-07-28: a called member's `assigned_agent_*` stamp is ALSO cleared, so the (agent, list) pair disappears from `assignment_matrix()` and the list stops hanging off the agent's profile as an "empty" list. Nothing else is touched: `is_completed`, `last_call_*`, `in_call_again_until`, `call_logs` and sales credit (`confirmed_by_*`) all survive — the who-called-whom record lives in `call_logs` + the audit row, not in the member stamp. The per-list `POST /segments/:id/bulk-unassign` (SegmentDetailPage) also clears done rows and is unchanged. UI: `src/components/assigner/BulkUnassignPanel.tsx`, third tab on /assigner; copy key is `assigner.unassignFullDetach` (`unassignKeepsDone` was deleted).
- **Per-client unassign from the Unassign tab (2026-07-28)**: each agent row expands to its lists (`src/components/assigner/AgentListMembersRow.tsx` — lazy `GET /segments/:id?assigned=<agentId>`, done members included, 50/page, per-client unassign via `POST /segments/:id/assign` with `agent_id: null`; a manager without `show_segment_members` gets 403 → inline `assigner.membersRestricted` notice while bulk detach still works) and to a pending-leads row (`src/components/assigner/AgentPendingLeadsRow.tsx` — `GET /orders?status=pending&agent_id=`, per-order `POST /orders/bulk-unassign`).
- **UI**: `src/pages/SegmentsPage.tsx` (cards + "Engine data as of …" strip + Recompute all), `SegmentDetailPage.tsx` + `src/components/assigner/SegmentMemberTable.tsx` (Last order = trigger_price/date), Assigner (see `elyon-assigner`; the per-agent drawer/`<Sheet>` inspector was DELETED 2026-07-28), `useMyQueue.ts`, `CallsPage.tsx` + `src/components/calls/work/*` (the outcome bar, the call-again view — `CallAgainPage.tsx` was deleted 01.10, `/call-again` redirects to `/calls?queue=call-again`). `/predictions` and `/predictions/:id` redirect to `/segments` (the old pages were deleted 30.09).
- **Docs**: `docs/HOW_PREDICTION_SEGMENTS_WORK_NOW.md` (technical/operator explanation, incident history) · `docs/PREDICTION_LISTS_PLAIN_GUIDE.md` (plain-words guide for agents/managers — keep BOTH in sync with this skill on any rule change).
- **Static lists**: externally-imported (engine never touches) = "Cancelled Pendings", "FULL MONAD LIST" (1,555 Monadon customers + product info); engine-written additive statics = **"Trash List"** (all trashes + reason), "Current Returns", "Due to Reorder" (v4).
- Rollback snapshot from the v3 repair: `prediction_segment_members_backup_20260610` (drop after a verified week).

## Verification ritual (non-negotiable after any change here)

1. `node scripts/audit-segments-integrity.mjs` → all PASS.
   ⚠️ MK baseline 2026-08-06: **13/14**. The one standing failure is *"Real Last-order price on paid buckets — 461 zero-price"*, a source-data gap, **not** an engine fault. Treat 13/14 as green; anything else failing is a regression.
   **It is irreducible — do not try to "fix" it again.** 1.199 paid orders arrived from AlterCPA with `price = 0`; every source was exhausted (raw export: 0 of 1.199 priced · their `items`/`goods`: also 0 · CRM `order_items`: 0 · collabBox: 86 overlap and its amounts are surcharge-inflated, not sale prices). 461 were recovered by `scripts/recover-zero-prices-mk.mjs` where the source **did** record a quantity and the same offer+quantity sold at one settled price (≥90% of ≥10 paid peers, ±1 month). The remaining 738 recorded **neither price nor quantity** — 662 of them Alpha Male, whose 1.490/3.000/4.000 ден "spread" is purely pack size (1/3/4 units), so without a quantity there is nothing to price. Guessing there would invent revenue on a defaulted quantity. €0 is the honest value for "we do not know".
2. `node scripts/verify-sticky-trash-mk.mjs` → 8/8. Pins the trash + cancel rules behaviourally.
3. `node scripts/engine-fixture-mk.mjs` → the list-name contract (a drifted name wipes members silently).
4. `node scripts/segment-engine-parity.mjs` → drift 0. It compares the two member TABLES, so recompute **both** engines first or it reports thousands of false differences (`recompute_customer_segments` writes live, `recompute_customer_segments_v4` writes shadow).
5. Spot-check a "(3+ orders)" list in the UI: only 3–4-order customers, real "Last order" prices.
6. Next morning after engine changes: member `updated_at` advanced overnight (cron alive).

**Recompute at MK scale.** `recompute_all_segments()` loops every distinct phone in `orders` — **111.270 on 29.09** (47.231 on 08-06; Bulgaria ~9.600, so any "~4 s" figure is a BG number). Measured 2026-08-06: ~40 s for 47k phones in 2.000-phone batches; not re-measured since the teleshop import more than doubled the phones. One single-statement call can outlive the Management API's timeout; batch it rather than assuming a bare `select recompute_all_segments();` will return. The nightly cron call runs inside the database and is not bound by that timeout.

## Every department's customers are in the lists (since 28.09.2026)

The engine classifies **every phone in `orders`** (only `monadon_legacy` rows are excluded). There
is no exclusion by `sale_source`: AlterCPA, CRM, teleshop (collabBox) and social customers all get
a list. The open question of 28.09 morning ("should collabBox orders trigger the engine?") was
settled by the teleshop history import the same evening:

- `scripts/import-teleshop-collabbox.mjs` (run `8bb49e8e`) loaded 247.001 teleshop orders
  (2023 → 27.09.2026) under `SET LOCAL elyon.defer_segments = 'on'`; the queue was then drained —
  **70.036 phones, 0 failed** — and memberships went **54.145 → 112.148** (112.320 on 29.09
  ~05:00).
- The collabBox sync (`elyon-collabbox-sync`) creates orders without deferring (small volume), so
  each new teleshop / social / LEADS-OUT order recomputes its phone at once, like any order.
- Most teleshop history is `paid` with `paid_basis = 'legacy_import'` (before MEX coverage): for
  the engine a paid order is a paid order — recency / value / frequency bands use it as they use
  any other sale.

**Bulk loads — the deferred queue (20260942000300).** A writer that inserts thousands of orders
sets `SET LOCAL elyon.defer_segments = 'on'`: `trg_orders_recompute_segments` then QUEUES the phone
in `segment_recompute_queue` instead of recomputing per row. `segment_recompute_drain(p_limit)`
settles the queue (a phone whose recompute raises is marked `failed_at` / `last_error` and skipped,
never aborting the batch); `recompute_all_segments()` covers it too. Never drain concurrently with
`recompute_all_segments` or a bulk writer. The teleshop importer's `--drain` calls it.

## Do-not-contact and deceased markers (collabBox, 28.09)

The teleshop import put **598 phones into the sticky Trash List** — owner decision 28.09:

- **Do-not-contact** komitenti (the operator wrote it into the collabBox name — "не се јавувај",
  "да не се контактира" …) ARE imported with their orders, and each phone gets ONE marker row:
  a `trashed` order, `trash_reason 'other'` (a PERMANENT class in v3.7-mk), note
  **"Не се јавувај (collabBox)"**, price 0 → `sale_source_detail 'disposition'` (never a sale),
  `external_source 'teleshop_import'`, `external_order_id 'ban:<phone>'` (idempotent), `trashed_at`
  = the import time. 584 such markers.
- **Deceased** komitenti are never imported; the 14 already in the CRM got the marker with note
  **"Починат/а – не се јавувај (collabBox)"**.
- Result: all 598 in the Trash List, 0 in a calling list. Release only by a manager changing the
  marker order's status, or by a PAID order dated after the marker (the MK sticky-trash rule) — no
  imported order is, they are all older. `--rollback --run 8bb49e8e-…` deletes the markers first.
- **Gap:** the collabBox sync only FLAGS a do-not-contact document
  (`banned_customer_do_not_contact` in `collabbox_documents.flags`) — it creates the order and no
  marker. Trash such a phone by hand until the sync learns it.

## Insights → Предикциски листи — which lists make money (29.09; the tab read "Прогнозни списоци" until 01.10)

The report side of the lists (`GET /api/insights/lists` → `insights_lists` / `insights_lists_cash`,
20260941000400; `src/components/insights/lists/`) reads THE sale cohort's rows whose detail is
`prediction_list` (a CRM sale with `prediction_list_id`), per list, per seller, with the MEX-first
parts.

- **Every department's list sales are on the tab** (since `20260942001800`, kept by the final
  rule of `…1860`): a list sale is counted in the department its MEX profile gives it — BIO
  NATURAL → Affiliate – Lead out, NATURA → by series (`elyon-departments-and-sources` §3b) — and it
  stays on the tab either way. Before, the tab was the Affiliate – Lead out slice only and a list
  sale on a NATURA parcel dropped out of it.
- Σ lists + "list not recorded" = the Overview's `prediction_list` split **summed over the
  departments**; the tab's footer is the Affiliate – Lead out card (the department's whole
  `prediction_list` / `direct` split). Every `/orders` link carries
  `sale_source=elyon_crm&sale_source_detail=prediction_list` (+ list name / seller / window), no
  `cohort_source` (`listModel.ts listsHref`).
- Checks: `verify-attribution` C3 (tab = Σ departments · `prediction_list`; footer = the Affiliate –
  Lead out card) and `verify-tab-lists` L1–L8 (L4 / L7 fixed for NATURA parcels in `40f1425`;
  September PASS). L8 compares members and flickers while the nightly recompute runs.

## Engine v4 — config-driven, no-code list builder (BUILT 2026-06-26, SHADOW)

The hard-coded thresholds are being lifted into **operator-editable config** so lists can be tuned/created from the UI (Settings → **Prediction Engine**) with no SQL/migration/deploy. **Status: built but NOT yet live — it runs in SHADOW.** The live engine is v3.7-mk (`recompute_customer_segments`); v4 writes a separate `prediction_segment_members_shadow` table on its own nightly job (`nightly-segment-recompute-shadow`, 00:30 UTC) until the operator validates and applies the cutover (each engine migration up to v3.7-mk, `20260913000200`, re-emits the v4 shadow too, so parity stays checkable).

- **Config store**: `segment_engine_config` (versioned JSONB, one `is_active`, plus `active_engine` = `'v3_4' | 'v4'`). Read by `get_segment_engine_config()`. Seeded to the EXACT v3.4 values, so shadow == live until edited (parity must be 0). Knobs: `recency_bands` (label + max_days; `holding_pen` band = NEWCOMERS, strict `<`, no value split), `value_bands` (label + max_price), `frequency_bands` (label + min_count, most-specific wins), `windows.current_cancels_days` (14), `windows.never_converted_recent_days` (180), and `reorder` (see below).
- **Engine**: `recompute_customer_segments_v4(phone)` loops over the config bands instead of hard-coded `IF` chains (migration `20260726010000`); `recompute_all_segments_v4()` bulk. Scaffold/tables/cron in `20260726000000`. All sacred behaviour preserved (exclusivity, carry-over, holding-pen assignment strip, additive Returns/Trashed, monadon exclusion).
- **List sync**: `sync_segment_lists_from_config()` ADD-only while `active_engine='v3_4'` (deactivating a list the live v3.4 still targets would nuke members); orphan-deactivation only switches on after cutover.
- **Package-based recall — "Due to Reorder"** (additive, static list, operator decision 2026-06-26): calls each customer just before they run out. `supply_days = Σ(order_items.quantity × products.days_of_supply_per_unit)` over their most recent paid order; member iff `now ≥ last_paid_at + supply_days − reorder.buffer_days`. Per-product `days_of_supply_per_unit` (default 15 = a 30-cap pack; a 4-pack = 60) is set on the Products screen. **Dormant** until `reorder.enabled` is turned on. Calendar bands are unchanged (additive).
- **API** (`supabase/functions/api/index.ts`): `GET/PUT /segments/engine-config`, `GET /segments/engine-diff` (live vs shadow + drift), `POST /segments` (create list), `DELETE /segments/:id` (deactivate by default / guarded hard-delete). RPCs: `set_segment_engine_config`, `segment_engine_diff`.
- **UI**: `src/components/settings/PredictionEngineTab.tsx` (admin-only tab) — band editors, windows, reorder, save-with-diff preview. Assigner non-distributable keys off `is_static` (fallback literal is now `'Trash List'`). The Trash List's reason column renders in `src/components/assigner/SegmentMemberTable.tsx` from `trigger_trash_reason` (shown only when present), labelled via `trashReason.*`.
- **Safety tooling**: `scripts/segment-engine-parity.mjs` (live vs shadow diff — must be 0 before cutover); `scripts/audit-segments-integrity.mjs` is now **config-aware** (freq/recency boundaries + cancel window read from the active config; engine-fingerprint check branches on `active_engine`; added a "Due to Reorder" check).
- **Cutover**: migration `20260726030000` (⚠️ apply only when validated) generates the LIVE v4 FROM the proven shadow function via `pg_get_functiondef` + table swap (no hand-copy), swaps shadow data into the real table, flips `active_engine='v4'`, and keeps v3.4 as `recompute_customer_segments_v3_4` for instant rollback (rollback block included).

**Rule for changing thresholds now: edit the config in the UI, don't touch SQL.** The function is generic; the data is the rules.

## Companion skills

- `elyon-currency` (every price display), `elyon-phone-normalization` (membership keys on normalized phones), `elyon-assigner` (distribution), `elyon-security` (RLS: agents see only their assigned members).
