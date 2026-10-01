collabBox → CRM pipeline map and daily-sync design (read-only investigation; nothing in the repo was edited). Measured on MK `bmfxhgznttcnnlqloqzp`, 2026-09-28.

## 1. What exists today

**No collabBox tables.** There is no `collabbox_*` table or column, and no sync or cron job for collabBox (the pg_cron list has no such job). collabBox data lives only in `orders`:
- `external_source='collabbox'`, `external_order_id=<DocNumber>`. The unique index `uniq_orders_external_ref (external_source, external_order_id) WHERE external_order_id IS NOT NULL` exists live.
- `sale_source='collabbox'` and `sale_source_detail` come from the DocNumber's middle segment (`20260935000000_sale_source.sql:181-192`): 9100/9102 = teleshop, 9108 = social, 9103 = leads_out, 9110 = leads, anything else = the series itself.
- The author ("Aвтор") goes to `confirmed_by_name`, which fills `sold_via='collabbox'` and the `collabbox_author` handle (`20260935000100:455,470`).
- The MEX link is `mex_tracking_id = DocNumber`. `trg_orders_link_parcel` takes a free parcel (`20260934000100:558-613`). mex-reconcile then keeps the status current through that remembered link (`match.ts:194-196` gives the method `collabbox_import`).

**What the orders hold now:**

| Batch | Orders | Status | Proof and gaps |
|---|---|---|---|
| Pre-September, from the historic registers (`create-missing-orders-from-collabbox.mjs`) | 5.563 (leads 2.497, leads_out 2.352, teleshop 713, series 9225: 1) | 4.605 are `paid` with no MEX proof | Operator rule of 2026-08-12, `create-missing-orders…:17-28,243`. Kept under the approved "11.08 pre-Aug" rule. |
| September import (`import-collabbox-teleshop.mjs`) | 2.644 (teleshop 2.497, social 147) | Came from MEX | **0 of 2.644 have `product_id`; 0 `order_items` have `product_id`.** 117 orders carry "ЗАБЕЛЕШКА" note lines stored as items. Only 608 have a `customer_profiles` row. |

**Why the Overview says "застарено":**
- `fr_cb` in `20260936000000_insights_overview.sql:1029-1032` reads `max(orders.created_at) WHERE sale_source='collabbox'`.
- It is marked stale after 7 days (`:1082-1089`, text "manual import; newest document").
- The newest collabBox order is 2026-09-18 09:00 Skopje, 9 days 17 hours old. 944 teleshop/social parcels have been registered at MEX since then.
- Settings health repeats the same logic in `20260939000200_teams_admin_integrations.sql:1003-1024,1227-1240`, marked "KEEP IN STEP" at `:57-60`. Its day strip counts orders as "ok" runs and always shows 0 failed. That file is untracked, so another agent is still writing it.

**Problems in the existing scripts:**
- `import-collabbox-teleshop.mjs`:
  - `:181,196` writes `paid` straight from the parcel, even for price-0 rows. This skips mex-reconcile's `zero_value_link` guard (`mex-reconcile/index.ts:355`).
  - `:204,223-228` never uses the SKU map.
  - `:111-118` has no marker, service or note filter, so ПОЕН-*, ДОСТАВА and ЗАБЕЛЕШКА lines became `order_items`.
  - `:198` uses a fixed +02:00 offset, which is an hour wrong in winter (CET from 2026-10-25).
  - `:79` accepts 9 digits after the country code; `create-missing-orders…:69-76` has the correct 8-digit rule.
  - `:44` depends on a hard-coded `komitenti_full.csv` snapshot.
- `match-collabbox.mjs` is superseded (its `--apply` put 2.512 orders live as paid). `audit-collabbox-paid.mjs` and `reconcile-collabbox-mex.mjs` only report. `fix-order-values…` corrects price and quantity.

**SKU map:** `scripts/data/collabbox-sku-map.json` has 173 matched articles and 6 unmatched. Matching the September line items by name, it covers 127 of 207 real article names, or EUR 89.610 of EUR 91.899 of item value (97,5%). The unmatched lines are mostly ПОЕН-* loyalty markers (1.223 lines) and ДОСТАВА (154).

## 2. The 63 price-0 orders (checker C10)

C10's 63 are the price-0 collabBox orders marked `paid`: 43 teleshop plus 20 leads. Counting every price-0 collabBox order that holds a tracking id gives 65: those 63, plus 1 leads_out returned and 1 social shipped.

- **Every one has a MEX COD of 0** (`raw.cod='0'`), and its collabBox value is also 0.
- They are replacement or exchange parcels. Examples:
  - ORD-104605 `002-9102-176665/2026` "ZINC… + ЗАБЕЛЕШКА фали цинк"
  - ORD-104064 "ЗАБЕЛЕШКА ке врати 4 сау палмето згрешена пратка"
  - ORD-104419 "замена со Б6"
- 46 of the 65 have a priced sale on the same phone within the previous 60 days.
- **Neither the collabBox amount nor the MEX COD can fix them, because no money changed hands.** The C10 "ghost parcel" reading is a false positive for these rows.
- Needed: C10 should accept "price 0 and COD 0" as consistent, and the owner should decide whether a replacement belongs in the order count at all. The other 25 C10 rows are AlterCPA or ElyonCRM orders whose COD is not 0; those are real ghosts.

**Evidence that the document amount is the price:** among September orders with a linked parcel, COD equals `round(price × 61,5)` within 3 ден for all 2.490 teleshop and all 146 social orders, and none are off by 150. In the header crawl, 36.064 of 36.071 teleshop/social documents from 2026 that have a parcel match `Iznos` to the COD within 3 ден.

## 3. The gap: MEX parcels with no order

**Parcels created since 2026-08-01, NATURA account, teleshop/social series:**

| Series | Month | Parcels | No order | Delivered, no order | COD of those | Returned | Open |
|---|---|---|---|---|---|---|---|
| 9100 | Aug | 2.309 | 2.268 | 2.029 | 4,11M ден | 236 | 3 |
| 9100 | Sep | 1.423 | 443 | 333 | 0,66M | 27 | 83 |
| 9102 | Aug | 2.942 | 2.870 | 2.562 | 5,70M | 290 | 18 |
| 9102 | Sep | 2.190 | 643 | 506 | 1,16M | 32 | 105 |
| 9108 | Aug | 389 | 386 | 355 | 0,62M | 31 | 0 |
| 9108 | Sep | 207 | 60 | 49 | 0,09M | 2 | 9 |

- **Total: 6.670 parcels with no order, 5.834 of them delivered, COD 12,34M ден (about EUR 200.600).** 121 of the no-order parcels have COD 0, which is the replacement class from section 2.
- The September import covered only 02.09–17.09. 09-01 has 233 parcels with no order, and from 09-18 on almost none have one.

**On the cash clock (by delivery date), delivered parcels with no order:**
- **September to 09-25:** teleshop 1.162 parcels / 2,49M ден, social 67 / 0,13M, web 280 / 0,48M, Elyon series 227 / 0,66M, M-prefix 94 / 0,08M.
- **August:** teleshop 4.689 / 10,04M ден, social 360 / 0,62M.
- This is cash with no placed order behind it. It is consistent with the Overview's Наплатено (3.062.765) being higher than Направени (2.454.319), but I did not check which date range the screenshot used.

**Other findings:**
- **Web is excluded correctly.** All 357 NTMK parcels have `sender_reference` NTMK… and are claimed by `web_orders.mex_tracking_id` (link method `tracking`). The Overview treats them as web (`insights_overview.sql:76-83`). The collabBox WEB document type 10112 has 2 documents in 2026, both worth 0. **However, 6 NTMK parcels are also linked in the CRM to AlterCPA orders** (ORD-98929, 75888, 89868, 79930, 76196, 95297; 4 paid at EUR 24,23 each), so those 4 are counted twice.
- **M-prefix parcels:** 3.175 on NATURA, 3,82M ден delivered with no order. They are not collabBox documents and web claims none of them. Their origin is unknown and they cannot be imported.
- **Wrongly credited teleshop parcels:** 248 teleshop/social parcels are held by non-collabBox orders (mostly AlterCPA history, all recorded on 09-27 by the register backfill). For 219 of them the COD does not fit the holder's price; **170 of those orders are `paid`, about 367k ден of teleshop cash credited to AlterCPA or ElyonCRM.** A daily sync will hit `conflict` on these.
- Separately, 873 NATURA parcels in series 9110 (2026-03-16 to 06-08) have no order: 529 delivered, 1,06M ден. They are LEADS documents, so they belong to linking existing orders, not creating new ones.

## 4. Design: `collabbox-sync`

This should be its own edge function plus SQL functions, so the shared `api` function is not touched.

**Tier 1: create orders from MEX, daily. It needs no collabBox access and can be built now.**
- Source: `mex_parcels`, which mex-reconcile already refreshes every 30 minutes for both accounts.
- Take series 9100/9102/9108 with `order_id IS NULL`, `cod_mkd > 0`, not NTMK, not claimed in `web_orders`, and `created_at_mex` on or after the backfill boundary.
- Each becomes an order with `external_source='collabbox'`, `external_order_id=tracking_id` (the tracking id is the DocNumber) and `price = cod_mkd / 61,5` (supported by the 100% match above).
- Phone from `phone8` as +389 plus 8 digits; name and city from the parcel. The product stays NULL until Tier 2 fills it.
- Schedule: pg_cron at 21:15 Skopje, after the last mex-reconcile run at 20:37, using the same kind of Skopje gate as `invoke_mex_reconcile`.

**Tier 2: collabBox documents (products, author, address, and orders not yet shipped).**
- Fetch "Документи-ставки" line items for types 10036, 10050, 10099 (Ист Гејт) and 10106, plus 10111 and 10114, for the last 3 days. Also fetch headers (which include the time in `Datum`) and new customer records.
- **Transport is the open problem.** VAULT §7.1 records that the headless line-item export is not solved. The header crawl did work on 09-10 (405 pages, 326.618 rows), but that script was not saved. The host is `http://…:8081`, plain HTTP, and it is not known whether it can be reached from Supabase.
- Options, in order of preference:
  1. Ask Accent Computers (the vendor) for a daily HTTPS or SFTP export or a read-only view. I can draft the request in Macedonian.
  2. Run a scheduled task on an office PC that posts to `collabbox-sync` with an HMAC signature.
  3. Always available: a manual XLS upload in Settings that goes through the same parser and records a run.

**Rules for both tiers:**
- **Idempotency key is the DocNumber** (ledger primary key plus the existing unique index). Whichever tier arrives first creates the order; the other only fills in missing fields.
- **Which types create orders:**
  - 10036, 10050, 10106 and 10099 create orders. 10099 only once its series is known; an unknown series is held for review.
  - 10111 and 10114 are recorded and reported only; they already have AlterCPA or ElyonCRM twins.
  - 10112 and 10055 are skipped (web, and store sales with no courier).
  - Documents worth 0, or with parcel COD 0, never become orders. They are recorded as `replacement` and noted on the customer's previous sale.
- **Status is never set to paid by collabBox.** It comes only from `mex_parcels`, using the same mapping as `targetFor`: 2 → paid with `paid_at=delivered_at` and `paid_basis='mex'`, 7 → returned, anything else → shipped. A document with no parcel is `confirmed`, which shows as "to pack". After that, mex-reconcile keeps it current.
- **Linking** goes through `mex_link_parcel(doc, id, 'collabbox_import')`. On `conflict`, it records the conflict and does not force.
- **Price** is the goods value from the lines, excluding service SKUs 8001/8002, ПОЕН markers and ЗАБЕЛЕШКА lines. Note lines go to `order_notes`.
- **Products** come through a SKU → `product_id` map; unmapped SKUs are listed on the run.
- **Customers:** strict E.164 (8 digits after +389), identity by last-8 digits. `customer_profiles` gets insert-only upserts.
- `created_at` is the document time in Skopje, falling back to 12:00 Skopje.

**Freshness:**
- Read `collabbox_sync_runs`: `last_ok_at` = last finished ok run; failed if the last run failed; stale after 26 hours.
- `data_through` = newest document; label it "daily sync".
- Add a "lag" figure: teleshop/social parcels with COD > 0, older than 48 hours, with no order. This should be close to 0.
- Put the logic in one helper, e.g. `collabbox_feed_state()`, and have both `fr_cb` and the Settings health CTE call it.
- Note: Tier 1 alone already clears "застарено" under today's SQL, because teleshop ships every working day (40–180 parcels a day in September), but that measures the data, not whether the job ran.

## 5. Schema changes needed (one new migration)

1. `collabbox_documents`, the ledger:
   - Key and document: `doc_number` (primary key), `doc_type_id`, `series` (generated the same way as in `mex_parcels`), `doc_at`.
   - Customer and author: `komitent_id`, name, `phone8`, address, city, author.
   - Money and lines: `amount_mkd`, `goods_mkd`, `lines` jsonb, `note_lines`.
   - Outcome: `kind` (sale / replacement / annotate_only / no_courier / unknown_series), `order_id` foreign key, `action` (created / enriched / annotated / conflict / skipped_*), `source` (mex_first / feed / upload).
   - Housekeeping: `run_id`, `first_seen_at`, `last_seen_at`, `raw`.
   - Readable by owners only, like `mex_parcels`.
2. `collabbox_sync_runs`: counters, `unmapped_skus`, `skipped`, `status`, `error`, timings, following the pattern of `mex_sync_runs` and `web_sync_runs`.
3. `collabbox_sku_map`, seeded with the 173 rows from the JSON file.
4. Service-role functions `collabbox_apply_documents(run, rows jsonb)` and `collabbox_create_from_mex(since, dry)`, plus the pg_cron job.
5. `CREATE OR REPLACE` of `insights_overview` (`fr_cb`) and the integrations-health function through the helper. This has to be coordinated with the agent that owns `20260939000200`.
6. `verify-attribution`: add a parcel-coverage check and the C10 exception for COD-0 rows.

## 6. One-off backfill, January–August

Source: `C:\Users\Mile\collab_out\99-arhiva-surovo-prevzemanje\orders\type_*.csv` (moved there when the folder was reorganised by department on 01.10.2026) (header crawl of 09-10) joined with `mex_parcels`. Scratch script: `…\scratchpad\cbx\backfill.mjs`.

**Documents that could be created** (value > 0, no existing order by DocNumber or tracking id), January–August 2026:

| Type | Documents | Value |
|---|---|---|
| 10036 (Нарачка in) | 19.567 | EUR 670.147 |
| 10050 (Нарачка out) | 26.027 | EUR 916.524 |
| 10106 (Социјални Мрежи) | 3.202 | EUR 91.500 |
| **Total** | **48.796** | **EUR 1.678.171** |

- **15.195 of these have no MEX record** (January, February and most of March; NATURA's MEX history starts 2026-03-23). **Recommendation: start the backfill at 2026-04-01.** Those older documents can only ever be "confirmed", which would show them as waiting to be packed forever.
- **April–August:** 32.824 documents, EUR 1.113.920. At MEX: about 30.034 delivered, 3.465 returned, 79 open.
- Equivalent from the MEX side (April–August parcels with no order): 33.435 parcels, about EUR 1,0M delivered.
- Products need the monthly line-item exports (UI export works one month at a time).
- About 220 July–August documents will hit link conflicts.
- Load: insert in chunks of 500 off-hours on the t4g.small database. Every insert triggers a per-phone segment recompute (`trg_orders_recompute_segments`). Auto-distribution is not triggered (it only fires for `pending` lead sources).

## 7. Decisions needed before building

1. **Prediction lists.** The September import already put **2.293 phones into Elyon's lists** (1.290 NEWCOMERS 1-3, 675 "21d 26+", 140 Current Returns, …). 1.889 of the 2.468 September phones have no other order in the CRM. The backfill would repeat this at about 15 times the scale, while teleshop's own "Нарачка out" call centre already calls these customers. Should the segment engine exclude `sale_source='collabbox'` as a trigger?
2. Is a replacement parcel an order, and what happens to the 65 existing ones?
3. Re-link the 170 AlterCPA orders marked `paid` on a teleshop parcel whose COD does not fit (about 367k ден). This moves money between sources.
4. Stop mex-reconcile from fresh-matching series 9100/9102/9108. This changes a cron rule, and those are supposed to stay as they are. It currently causes 0 new links.
5. What are the M-prefix parcels and document type 10099?
6. Which transport for collabBox: the vendor feed or an office runner?

## 8. Runbook — the nightly sync (built 28.09.2026 ~23:30, owner: "every day at 00:00")

Sections 1–7 above are the investigation and the first (paused) design; what runs is this:
`supabase/migrations/20260942000900_collabbox_nightly_sync.sql` (ledger `collabbox_documents`, cards
`collabbox_customers`, runs `collabbox_sync_runs`, the writer, `collabbox_booked_today`, the freshness,
the crons) + `supabase/functions/collabbox-sync/` (`index.ts` handler, `client.ts` read-only collabBox
client, `collabbox.ts` parsers/classification, `collabbox.test.ts`). The paused
`supabase/paused/20260939000350_collabbox_sync.sql` is superseded — never apply it.

**What it does.** `collabbox-sync` cron `0 22,23 * * *` UTC → only the 00:xx Skopje slot proceeds,
once a day. It re-reads the last 3 Skopje days (widened back after a missed night, max 14): headers +
HTML line items of 10036 · 10050 · 10106 · 10114 · 10111 · 10055 · 10107 · 10112 · 10099 · 10063 ·
10058, reads komitent cards it needs, and writes through `collabbox_apply_documents` (orders for
10036/10050/10106, 10114 only when no order holds its parcel, credits for 10111, everything else
recorded). `collabbox-live` cron `*/30 6-19 * * *` UTC → 08:00–20:00 Skopje: today's headers of
10036 · 10050 · 10111 · 10114 · 10106 → ledger `booked` → `collabbox_booked_today(day)` for the
leaderboard. Status always from MEX; departments from `collabbox_department(type, …)`.

**Deploy (Macedonia only — run the tripwire first, pass the ref explicitly):**
```
node scripts/assert-mk-target.mjs
node scripts/apply-migration-mk.mjs supabase/migrations/20260942000900_collabbox_nightly_sync.sql
node scripts/engine-fixture-mk.mjs
npx supabase secrets set COLLABBOX_USER=<VAULT §7 user> COLLABBOX_PASS=<VAULT §7 password> COLLABBOX_SYNC_SECRET=<new 64 hex> --project-ref bmfxhgznttcnnlqloqzp
npx supabase functions deploy collabbox-sync --project-ref bmfxhgznttcnnlqloqzp
```
A 64-hex secret: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
`supabase/config.toml` sets `verify_jwt = false` for this function (pg_cron sends no JWT; the
`x-collabbox-sync-secret` header is checked in code and the function fails closed without it).

**Test before enabling — a dry run of ONE past day (reads collabBox, writes NOTHING):**
```
# bash — keep the secret in an environment variable, never in a file
curl -s -X POST https://bmfxhgznttcnnlqloqzp.supabase.co/functions/v1/collabbox-sync \
  -H "x-collabbox-sync-secret: $COLLABBOX_SYNC_SECRET" -H "Content-Type: application/json" \
  -d '{"mode":"manual","from":"2026-09-27","to":"2026-09-27","dry_run":true}' > dry-2026-09-27.json
# PowerShell
Invoke-RestMethod -Method Post -Uri https://bmfxhgznttcnnlqloqzp.supabase.co/functions/v1/collabbox-sync `
  -Headers @{ 'x-collabbox-sync-secret' = $env:COLLABBOX_SYNC_SECRET } -ContentType 'application/json' `
  -Body '{"mode":"manual","from":"2026-09-27","to":"2026-09-27","dry_run":true}' | ConvertTo-Json -Depth 8 > dry-2026-09-27.json
```
Answers in ~30–90 s. Check in the JSON (the file holds customer data — keep it out of git):
- `days[0].headers` / `items` = what collabBox shows for that day; `items_error` empty; `requests` ≤ 100.
- `outcomes`: a day the history import already covered is mostly `exists` / `recorded` / `credited`
  (the orders are there); `created` should be only documents the CRM does not have. Read every
  `plan[]` row with `outcome: "created"` (status, price_eur, department, flags) and the `conflicts`,
  `no_phone`, `unmapped` lists.
- `komitenti`: `needed` vs `found` / `not_found`. **The card search (comp=infocc by Шифра) is the one
  request shape not yet exercised live**: if `found` is 0 while `needed` > 0, the search does not
  filter by id — say so before enabling (documents then wait for their parcel's phone: `no_phone`,
  retried 14 days).
- `warnings` empty; `slowest_ms` well under 60.000.
Then, during the day, the live mode: `{"mode":"live","dry_run":true}` → `headers`, `by_type`.
Optionally one real (non-dry) past day: `{"mode":"manual","from":"2026-09-27","to":"2026-09-27"}` — a
run that writes answers 202 with its `run_id` and works in the background (`"wait": true` keeps it
synchronous) — then `select * from collabbox_sync_runs order by started_at desc limit 1;` and
`select outcome, reason, count(*) from collabbox_documents group by 1, 2 order by 3 desc;`.

**Types of the existing collabBox orders (once, quiet window after 20:55):**
`node scripts/backfill-collabbox-doc-types.mjs` (dry run: 255.267 of 255.272 typed from the local
harvest + fetches on 28.09, 5 unknown) → `… --apply` (writes only `orders.collabbox_doc_type`).

**Turn the crons on** (both are scheduled by the migration and are no-ops until this row exists):
```
select vault.create_secret('<the same 64 hex as COLLABBOX_SYNC_SECRET>', 'collabbox_sync_secret');
```
**Check the next morning:** `select kind, status, window_from, window_to, fetched, created, updated,
conflicts, replacements, no_phone, credited, unmapped_lines, error from collabbox_sync_runs order by
started_at desc limit 5;` · `select public.collabbox_feed_state();` (Settings → Integrations and the
Overview read it) · `node scripts/engine-fixture-mk.mjs`.
**Pause:** `select cron.unschedule('collabbox-sync'); select cron.unschedule('collabbox-live');` (or
delete the Vault row). Re-applying the migration re-creates both jobs.
