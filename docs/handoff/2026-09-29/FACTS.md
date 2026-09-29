# Elyon CRM — Macedonia — verified system facts (29.09.2026, main session)

Source of truth for rewriting the docs. Every statement here was verified live on MK (bmfxhgznttcnnlqloqzp) on 28–29.09.2026.

## Scale (29.09 ~05:00)
orders 354.048 · distinct customer phones 111.270 · products 706 (261 active) · product_aliases 1.744 · prediction-list memberships 112.320 · sales_people 47 with a CRM login + 63 placeholders (collabBox authors, former staff) · MEX parcels: BIO NATURAL 17.995, NATURA 42.858 · web_orders 24.531 · AlterCPA ledger 18.211 · collabbox_documents (sync ledger) 17.8k and growing (history backfill Mar→Sep) · teleshop_import_documents 258.705 · sale_source_reclass 170.478 · 251 migrations.

## Departments (owner law 28–29.09.2026; whole history)
Departments are decided by the collabBox FOLDER (document type) and the MEX profile — never by the system an order was made in, never by the seller's team. Six, in this order:
| key (cohort source) | label (mk) | what | MEX profile |
|---|---|---|---|
| altercpa | Affiliate – Lead in | AlterCPA affiliate leads (bridge + history: pending → decided) + collabBox 10111 "Нарачка LEADS" (stored altercpa/collabbox_leads) | BIO NATURAL, series 9110 |
| elyon_crm | Affiliate – Lead out | re-sale to affiliate customers: CRM-made sales (elyon_crm prediction_list/direct) + collabBox 10114 "LEADS-OUT" (elyon_crm/collabbox_leads_out) | BIO NATURAL, series 9103 |
| teleshop_out (new) | Телешоп – Lead out | collabBox 10050 "Нарачка out" (collabbox/teleshop_out) — incl. teleshop-out calls to customers who first came from affiliate | NATURA, series 9102 |
| teleshop_other | Телешоп – Lead in | collabBox 10036 "Нарачка in" (collabbox/teleshop) — the TV lead-in; + unclassified leftovers | NATURA, series 9100 |
| social | Социјални мрежи | collabBox 10106 / 10055 (collabbox/social) | NATURA, series 9108 / 1300 |
| web | Web | naturatherapy.mk shop mirror (web_orders — NOT orders) | NATURA, NTMK / M… |
- An order's department = public.cohort_order_source(sale_source, sale_source_detail, mex_tracking_id) (3-arg, 20260942001000). Exception: a CRM-made sale (prediction_list/direct) shipped on a NATURA parcel goes by its series (9102 → teleshop_out, 9100 → teleshop_other, 9108 → social).
- A MEX parcel with no order: by series (cohort_parcel_split/cohort_parcel_source): 9110 → altercpa · 9103 → elyon_crm · 9102 → teleshop_out · 9100 → teleshop_other · 9108/1300 → social · NTMK/M… → web · other → teleshop_other.
- collabBox document department at INSERT: public.collabbox_department(type, DocNumber, person, at) (20260942000900): by TYPE (10111, 10114, 10050, 10036, 10106/10055), falling back to the series. orders.collabbox_doc_type holds the type (backfilled 255.243).
- Every later move of an order's sale_source is logged in sale_source_reclass (from = the source before the FIRST move; scripts/reclass-department-sources.mjs and scripts/reclass-by-folder.mjs have --rollback).
- History: 168.564 rows moved to departments (series), then 165.571 re-stored by document type (the series lies for ~1.100: 703 LEADS-OUT numbered 9102, 286 out numbered 9100, 99 in numbered 9102); 68 CRM sales of AlterCPA-team agents moved back to Affiliate – Lead out (the team override was withdrawn, 20260942001100).
- Evidence (folder map): 10114 customers 97% had an AlterCPA lead first, 77% BIONATURAL products, 97% BIO NATURAL since 02.04.2026; 10050 customers 94% teleshop history, 7,7% BIONATURAL, NATURA 18.861/18.862; CRM orders ship 580/606 as BIO NATURAL 9103, 98,5% AlterCPA lead first. BIO NATURAL profile exists only since 02.04.2026 — older history is classified by TYPE.
- September 01–27 by department (orders): Affiliate in 2.132 / 6.348.156 ден · Teleshop out 2.162 / 4.959.661 · Teleshop in 1.382 / 2.854.065 · Affiliate out 736 / 2.072.845 · Social 152 / 284.460.

## Money rules (unchanged law)
- Prices stored in EUR; денари at display with the FROZEN 61,5 (never update). Денари everywhere except the foreign affiliate payout (EUR).
- MEX decides shipped/paid/returned; COD ≠ price → MEX is right (repair-cod-price; not when COD = price×61,5+150 or COD 0; trusts a teleshop parcel on another order only when the collabBox document with that DocNumber names it — collab_twin).
- Cohort money: sale day = sold_at → AlterCPA decided_at → confirmed_at → created_at (Skopje days); parts: Наплатено / Кај курирот / Спакувано / Во магацин / Вратено; value = parcel COD else price×61,5.
- paid_basis: mex | operator_ruling | legacy_import | manual | unproven. The teleshop history (214.700 orders before MEX coverage) is legacy_import = "paid – history", shown apart (paid_legacy), never MEX-proven.
- 10-day no-parcel rule (AlterCPA approvals only, 21:10 Skopje, apply mode); team_prediction excluded in its three twins (apply_no_parcel_rule, Overview anp, attentionFilter).
- Pure Profit monthly cache: version 4 (after 20260942001000), refreshed nightly 03:40 and by the owners' button; refreshed by hand 29.09.
- VAT 18% confirmed. Cost prices: owner will set; new products have cost 0.

## Who sold (sold_* stamps)
- orders.sold_at / sold_by_person_id / sold_via / sold_by_ext: write-once per column (fill NULL → value allowed; deliberate changes under SET LOCAL elyon.allow_sold_change).
- Live trigger tg_orders_stamp_sold: stamps a CRM confirmation / insert; the admin attribution correction (POST /orders/:id/attribution) re-points a CRM sale's seller (20260942000400); a MEX/repair revival of a non-sale (cancelled/trashed/pending → shipped/paid/returned without a new confirmer) is NOT stamped live — the stamp-order-deciders cron credits it by its rules (20260942000800). The department never depends on the seller (20260942001100).
- stamp-order-deciders cron (every 5 min; full 04:23): AlterCPA ledger decisions, collabBox author (document whose DocNumber = the order's parcel), CRM decisions, history imports.
- collabBox authors → people via sales_person_identities kind 'collabbox_author' (whitespace-normalised). 40 former teleshop authors (2023–24) added 28.09; 40.702 history orders filled; +506 by backfill-sellers-collabbox.
- Disposition (0 ден call outcome) rows are never sales; one that becomes a real sale (or its duplicate) is upgraded to prediction_list/direct (tg_orders_sale_detail_upgrade, 20260942000400).

## collabBox (the teleshop/office ERP of Accent Computers)
- DocNumber = the MEX tracking id. Folder map above. Read-only headless client: scripts/collabbox-fetch.mjs (Node) and supabase/functions/collabbox-sync (Deno). Credentials: VAULT §7 → function secrets COLLABBOX_USER/COLLABBOX_PASS; COLLABBOX_SYNC_SECRET = DB vault 'collabbox_sync_secret'.
- Nightly sync (migration 20260942000900, cron collabbox-sync '0 22,23 * * *' UTC, gate = 00:00 Skopje): re-reads the last 3 days (catch-up ≤ 14), all sales types with line items; ledger collabbox_documents (one row per document, outcome created/exists/updated/credited/recorded/conflict/replacement/storno/skipped/no_phone/awaiting_parcel/credit_pending/no_items/error); creates orders for 10036/10050/10106 and for 10114 when no order holds its parcel — ONLY once the MEX parcel exists (never a "to pack" CRM order: collabBox teleshop is packed outside the CRM; awaiting_parcel retried 14 nights); 10111 only credits the seller of the order holding its parcel; replacements (value 0 / COD 0) are never orders; stornos recorded; twin/held/web-claimed/older-parcel → conflict, never forced; runs in collabbox_sync_runs; freshness collabbox_feed_state().
- Frequent mode (cron collabbox-sync-frequent '*/15 4-21 * * *' UTC, gate 07:00–22:59 Skopje, 20260942001300): a FULL pass of yesterday + today every 15 minutes (headers, items, orders once the MEX parcel exists, seller credit, awaiting rows). The headers-only 'live' mode (collabbox-live) is retired from the schedule, still callable. collabbox_booked_today(day) = per author/person/type bookings no order holds yet (booked or awaiting_parcel) — for the leaderboard, never double.
- Tested 29.09: dry run 27.09; real run 27–28.09 (28.09: 350 documents, 207 awaiting parcel); history backfill 01.03→26.09 via the same function in 4-day windows (06.04 had one draft without a number — the parser now skips ≤ max(3,5%) incomplete rows). The komitent-card lookup does not work yet (found 0) — phones come from the parcel / teleshop registry.
- Earlier tools: scripts/import-teleshop-collabbox.mjs (teleshop history 2023→27.09, run 8bb49e8e: 247.001 orders; --rollback), scripts/import-leads-out-collabbox.mjs (run 954707fd, 64 orders), scripts/backfill-sellers-collabbox.mjs, scripts/backfill-collabbox-doc-types.mjs.

## Catalogue
- 8 AlterCPA products created 28.09 (GlucoCare, MenCare, ProstaCare, NeuroCare, Arthriva, Collagen Peptides Bionatural, Neurofix 1+1, Prostafix 1+1 — bundles of 2) + 10 MK offers mapped (their pending leads now enter the CRM; decided ones are not back-imported: import_scope pending_only).
- scripts/import-catalogue-products.mjs run 01d83713: 170 aliases. scripts/complete-catalogue.mjs run 324615d4: 325 new products (34 active, 291 history), 139 activations/fills (45 inactive sold products activated; 94 active ones given price/stock), 479 aliases; 32 spelling groups linked to existing products; 16 unsure groups left for the owner; 42 non-products excluded. Value resolving to the catalogue: history 99,9 %, 2026 100 %.
- Stock: placeholder 1000 on sellable products until the owner's stock count; the api refuses to confirm/ship when stock_quantity < qty. The MEX-driven stock ledger (stock_mex_apply) is dark until the count.
- Known issue: ~53 older aliases map a name to a product of a different pack size (~3,3 M ден, e.g. ТЕЧЕН КОЛАГЕН 0,5 Л → the 250 мл product).

## Crons (pg_cron, UTC schedules; Skopje gates in the functions)
affiliate-postback-drain every min · altercpa-rate-verdicts :05 (acts 10:05, 23:05) · altercpa-sync-continue every 2 min · altercpa-sync-nightly 01:15 (03:15 Skopje) · altercpa-sync-rolling every 2 min · altercpa-sync-status every 5 min (07:00–20:55) · altercpa-sync-weekly Sun 02:45 · collabbox-sync 22:00/23:00 (00:00 Skopje, last 3 days) · collabbox-sync-frequent every 15 min (07:00–22:59, yesterday + today in full) · insights-profit-monthly 01:40/02:40 (03:40) · lead-auto-distribute every min (09–19 if working-hours-only) · mex-reconcile every 15 min :07/:22/:37/:52 (06:00–22:59), both accounts in one sweep · mex-reconcile-weekly Sun 08:15 · nightly-segment-recompute 00:00 (02:00) · nightly-segment-recompute-shadow 00:30 (v4 shadow) · no-parcel-rule :10 (acts 21:10) · presence-stale-sweep every 2 min · reconcile-recording-links every 10 min (telephony idle) · stamp-order-deciders every 5 min · stamp-order-deciders-full 02:23 (04:23) · stock-mex-apply :12/:42 (dark) · unpaid-delivery-chase hourly (acts 09–11) · web-sync every 15 min · web-sync-nightly 01:01–01:51. No Vercel crons. Owner rule 29.09: every source refreshed at least every 15 minutes (20260942001300) — supersedes the 08-12 "crons stay as they are".

## Repairs and checks (all dry-run → hash → apply → rollback)
repair-cod-price (8e059bfe 34, f29eb4dd 325) · repair-teleshop-twin-links (c8dc9345 57; 8 rolled back — parcel older than the order) · repair-crm-collabbox-twins (3c32f8d3 6) · repair-link-elyon-parcels (8db253cc 141) · repair-revived-cross-channel (de9f07ca 3) · rollback-repair.mjs (--only, --loose). Checks: engine-fixture-mk, verify-attribution (C1–C14; C7 37 / C8b 14 = pre-existing AlterCPA leftovers), verify-insights-ties, verify-tab-{sales,agents,profit,lists,returns,work} — all PASS 29.09 (L8 flickers only while lists are recomputing).

## Leaderboard
(to be filled when leaderboard_day_v2 is live)

## Open owner items
16 unsure catalogue groups; ~53 wrong-size aliases; cost prices; lead price per webmaster; MEX return fee; stock count; teams for the Lead-in callers (Чима, Ристеска, Кипровска), 5 logins with no team, "AlterCPA #4531"; is Milijana Todorovska = "Милјана Тодоровска н."; manager AlterCPA accounts (Nina/Dragana) on the board; process: every lead out entered in the CRM first; the collabBox komitent-card lookup; the 17 parcels listed for a human; C7/C8b leftovers; social history before March (no MEX) not imported.
