---
name: elyon-history-truth
description: How every HISTORIC order in the Macedonian Elyon CRM is proven (owner 03–04.10.2026) — proof by a linked MEX parcel (paid_basis mex), by collabBox's courier flag for the days another courier carried (operator_ruling), or none; the full MEX register in mex_history_stage, mex_parcels.history_run, the history linker (mex_history_lead_plan / _apply), the cancel rules for paid orders with no proof, the repair runs and their undo, the clean-data hand-over for the Salesforce migration. Read before touching orders.paid_basis, a history repair, mex_history_*, scripts/history/*, or anything that says an old order was or was not paid.
---

# History truth — how an old order is proven (MACEDONIA)

> Owner, 03.10.2026: "Сакам утре веќе да имам 100 % сигурна база." · 03.10 night: "Зошто сите овие податоци чекаат моја
> одлука?" · 04.10: "1.410 документи без трага од курир, пиши ги овие неплатени. Заврши сè … базата да е чиста."

The hand-over that started it: `D:\naturatherapy\NATURALL-CRM-HISTORY-TRUTH-PROMPT.md` (the audit of MEX × collabBox ×
CRM since 18.03.2020; its private files in `D:\naturatherapy\_salesforce-plan\07-data-backups-PRIVATE\2026-10-03\`).
The hand-over that ends it: `D:\naturatherapy\NATURALL-CRM-CLEAN-DATA-HANDOVER.md` + the private package
`…\07-data-backups-PRIVATE\2026-10-04\naturall-crm-clean\` (`scripts/history/export_clean_handover.py`).

## 1. The proof of an order — read it like this

| Order | Proof | Where it is written |
|---|---|---|
| holds a MEX parcel (`mex_tracking_id`, `mex_status_id` 2 / 7) | **MEX** — delivered = paid, 7 = returned | the order's `mex_*` columns, `mex_parcels` (linked both ways); `paid_basis = 'mex'` on a paid order |
| paid, no parcel, `paid_basis = 'operator_ruling'` | **collabBox's courier flag** ("Delivered") on a day another courier carried the folder | the order's note names the document; `data_repair_rows.evidence` of a `courier-outcomes` run |
| returned, no parcel | the same flag ("Return to sender"), or MEX's register by phone (not linked) | the note / the ledger (`paid_returned`, `dead_returned`, `mex_returned_phone`) |
| paid, no parcel, `paid_basis` NULL / `legacy_import` | **none** — a document or a trace exists but nothing proves the delivery | listed in the hand-over; never call it proven |

- **MEX beats everything.** Never judge an order that holds a MEX parcel, or a MEX day, by the collabBox flag.
- The couriers that were not MEX: Колпортер Пост (teleshop, 101 days of 22.01–27.11.2024), Еко Логистик (LEADS,
  09.10.2025–22.01.2026), Јон Експрес (12 days of May–June 2026). A whole folder went to one courier on a day.
- collabBox's flags are read by `scripts/collabbox-delivery-attrs.mjs` (read-only search, one request per day, 2,5 s
  apart; it runs beside the crons). A document with a MEX parcel lacks a flag in 7 of 63.779 cases — "no flag" is real.

## 2. The MEX register's history

- `mex_history_stage` — the WHOLE register (453.204 parcels since 18.03.2020, parsed with `mex_parse_ts` /
  `mex_parse_cod`). Private, no reader. Loader: `scripts/history/mex_history_stage_load.py`.
- **Never insert an UNLINKED history row into `mex_parcels`.** `insights_sale_rows` (`mo`), `insights_overview`
  (`mf`), `insights_cash_rows`, `insights_parcel_rows`, `insights_profit` (`rp`), `leaderboard_web_live`,
  `collabbox_feed_state` and `web_phone_link_candidates` (the 03:01 web sweep) would count or pair it. A history parcel
  enters only ALREADY LINKED to its order, in the same transaction (`mex_parcels.history_run` = the run).
- By number (`20260948000200`): `mex_history_link_plan(run)` → `call mex_history_link_apply(run, 2000)` →
  undo `call mex_history_link_undo(run)`. A price-0 order never takes a parcel (`…0210`).
- By phone + date (`20260948000220` / `0230`): `mex_history_lead_plan(mode)` / `mex_history_lead_apply(true, run,
  hash, mode)` are the LIVE linker's bodies with the parcel source swapped — **generated** by
  `scripts/history/gen_history_lead_links_migration.mjs`; never edit them, regenerate when `link_lead_parcels_plan`
  changes. Mode `lead` = 9110 / 9103; mode `pre9110` = the teleshop-numbered lead parcels before 19.06.2025, proof
  only (never a revival). **Always `set enable_nestloop = off; set work_mem = '96MB'`** for the plan (29 s vs > 5 min).
- After a link the standing COD rule applies: `node scripts/repair-cod-price.mjs` (dry run → apply).

## 3. The cancel rules for "paid" with no proof (owner's own rule)

"Платена + нема MEX + нема collabBox = откажана." `scripts/repair-history-cancels.mjs`:
`no_proof_cancel` (nothing on the phone or the name within ±45 days) · `no_proof_cancel_twin` / `no_proof_cancel_trace`
(every trace is another order's) · `duplicate_cancel` (`duplicate_order`, the holder ≤ 3 days away) ·
`label_only_cancel` (MEX 8 for months) · `never_shipped_cancel` (a document with no parcel and no courier flag — owner
04.10: "неплатени"). Every cancel is a SYSTEM cancel **dated on the order's own day** (never today — the 14-day Current
Cancels pen); `sold_*` stay. An unclaimed parcel / document within ±45 days is left alone (possibly the order's own late
shipment — the late-sale law makes it a NEW order).

## 4. How a history repair is run (the pattern that worked)

1. A read-only builder in `scripts/history/` (private sources → `exports/repairs/<name>/input.csv`, ids only).
2. The repair on `scripts/lib/repair-kit.mjs`: dry run (CSV + `data_repair_runs`) → my own checks (twins, duplicates,
   what every cron would do afterwards) → `--apply --run <id>` with `elyon.defer_segments` prepended to each chunk.
3. Afterwards, always: `select public.segment_recompute_drain(50000); select public.recompute_all_segments();`
   `select public.refresh_customer_departments(true);` `insights_profit_refresh(month)` for EVERY cached month (the
   kit keeps `updated_at`, so the nightly profit job does not notice) → the verify scripts → the audit re-run
   (`python pull_crm_orders.py new` + `build_history_audit.py` in the private history-audit folder).
4. Long statements go through **psql** (`exports/db-move/2026-10-03-cutover/pgpass.conf`, with
   `keepalives=1 keepalives_idle=20 keepalives_interval=10`): the Management API gateway cuts a request at ~100 s.
5. A rule the owner already gave is applied, not asked again — report the result and the undo.

## 5. Never

- Never mark a paid order proven without a parcel link or a courier flag; never invent a new `paid_basis` value
  (allowed: mex · operator_ruling · legacy_import · manual · unproven).
- Never revive a dead lead by a parcel of another folder (`mayReviveWith`); `pre9110` parcels only PROVE.
- Never push anything to MEX, AlterCPA or collabBox for a history repair; never delete an order.
- Never run a history repair while `recompute_all_segments` runs or beside another session's apply — agree first.

## 6. The runs (undo: `node scripts/rollback-repair.mjs --run <id> --apply` unless said otherwise)

See CLAUDE.md, the bullets from "The parcels ANOTHER COURIER carried" to "Documents with no MEX parcel in a MEX month",
and the table in the clean-data hand-over. `mex-history-links` is undone by `call public.mex_history_link_undo(run)`;
a `mex-history-lead-links` run by rollback-repair **then** `delete from mex_parcels where history_run = '<run>' and
order_id is null`.
