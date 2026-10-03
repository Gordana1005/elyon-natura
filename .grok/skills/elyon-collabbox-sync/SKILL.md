---
name: elyon-collabbox-sync
description: The collabBox (Accent Computers teleshop/office ERP) → Elyon CRM sync — the collabbox-sync Edge Function and migration 20260942000900 (+ the 15-minute schedule of 20260942001300). Covers the read-only headless client and its allow-list, the nightly 00:00 pass and the every-15-minutes full pass of yesterday + today, the retired live mode, collabbox_doc_role per document type, the writer collabbox_apply_documents / collabbox_apply_one and every ledger outcome in collabbox_documents, the rule "an order only once its MEX parcel exists", twins / conflicts / replacements / stornos / vanished documents, phones and komitent cards, seller credit, secrets and crons, freshness (collabbox_feed_state), the runbook (dry run one day, manual windows of at most 4 days, pause / resume), the known gaps, and how the collabBox history was loaded. Read before touching supabase/functions/collabbox-sync, collabbox_* tables or functions, scripts/collabbox-fetch.mjs, any collabBox import script, or anything that creates orders from collabBox. The 22 shops' tills are a SEPARATE reader (collabbox-shops — skill elyon-shops).
---

# collabBox → CRM sync

Built 28.09.2026 ~23:30 on the owner's order ("every day at 00:00 — recording and seeing
everything"), live since 29.09; every 15 minutes since 29.09 ~04:30 (owner: "every source
refreshed at least every 15 minutes; MEX stays the final proof").

- Database half: `supabase/migrations/20260942000900_collabbox_nightly_sync.sql`; schedule:
  `20260942001300_realtime_every_15_minutes.sql`; freshness and the Integrations run log:
  `20260942001400_freshness_every_15_minutes.sql` (applied 29.09 ~04:50).
- Function: `supabase/functions/collabbox-sync/` — `index.ts` (handler, runs, windows),
  `client.ts` (read-only HTTP client), `collabbox.ts` (pure parsers, type roles, line
  classification, phones — no Deno, no network), `collabbox.test.ts` (vitest; reads the migration
  to keep the twins equal).
- Design history + first runbook: `docs/handoff/2026-09-28/collabbox-pipeline.md` (§1–§7 are the
  PAUSED first design; §8 is what runs). `supabase/paused/20260939000350_collabbox_sync.sql` is
  **superseded — never apply it** (it would re-create these names with the old design).
- Departments per type: `elyon-departments-and-sources`.
- **Not this function: the shops.** The 22 retail shops' tills (10022 receipts, goods documents, stock per shop) are
  read by a SEPARATE edge function, **`collabbox-shops`** (02.10.2026, `elyon-shops`, `docs/SHOPS.md`): same server,
  same login (`COLLABBOX_USER` / `COLLABBOX_PASS`) and the same `x-collabbox-sync-secret`, but its OWN allow-list,
  tables (`shop_*`), switch (`app_settings.shops_reader`) and crons, scheduled off this sync's minutes. It never runs
  while a collabbox-sync run is running and never makes an order. Never merge the two allow-lists.
- **Stock v2 reads this ledger:** a parcel's contents are its document's goods lines
  (`collabbox_documents.payload->'lines'`, `code` = the Sigma article, kits already split) — `elyon-stock-v2`. Keep the
  line `code` / `qty` / role in the payload as they are.

## What collabBox is — and is not

- The teleshop / office ERP of Accent Computers, one Tomcat web app over **plain HTTP** (base URL
  in `client.ts` `COLLABBOX_BASE`), one login (VAULT §7), no API. Everything is a server-rendered
  HTML form; the protocol was reverse-engineered on 28.09 (`scripts/collabbox-fetch.mjs` header,
  PROTOCOL §0–§4).
- A document's **DocNumber IS the MEX tracking id** of its parcel (`002-9102-177237/2026`), and its
  **type** is the folder it was booked in. The type decides; the series in the DocNumber can lie.
- collabBox proves **dispatch, not payment**. Status and money come only from MEX.
- **Read-only by construction.** `client.ts isAllowed()` lets out exactly seven request shapes
  (GET/POST login, the document-header search, the line-items form + its search, the Коминтенти
  form `GET Index?comp=infocc` + its pure search `POST Index?comp=infocc&action=search` with
  `searchMode=search`, a numeric `id` and `delcustom` none — since 03.10.2026). Saving a search, the
  discount form, `addcustom` / `exportxls`, the old paged `…&pgsf=0&cp=1` shape, creating documents,
  e-mailing or Excel exports are refused before sending. Strictly sequential, 1,5 s between requests, a hard cap per
  run (100 full / 10 live), one re-login when the short `location.href='./Login…` redirect page
  comes back (`isLoginPage`), session ids redacted from every log line. Never widen the allow-list.

## Schedule (pg_cron, verified live 29.09)

| Job | UTC | Skopje gate (inside `invoke_collabbox_sync`) | Body sent |
|---|---|---|---|
| `collabbox-sync` | `0 22,23 * * *` | proceeds only at **00:xx**, once per Skopje day (no `nightly` run row for today) — DST-proof, one of the two slots is 00:xx | `{mode:'nightly', trigger:'cron'}` → window `collabbox_nightly_window(3, 14)` |
| `collabbox-sync-frequent` | `*/15 4-21 * * *` | **07:00–22:59** | `{mode:'manual', trigger:'cron', from: yesterday, to: today, ahead_days: 14}` — a FULL pass (headers, lines, orders once the parcel exists, seller credit, awaiting rows) **+ the documents DATED tomorrow … today + 14** (one header search + one line-items request for the whole range, since `20260944000500` — see "The booking day") |
| ~~`collabbox-live`~~ | retired by 20260942001300 | (was 08:00–20:15, headers only → `booked`) | mode `live` stays callable by hand |

Both are silent no-ops until the Vault row `collabbox_sync_secret` exists; `invoke_collabbox_sync`
swallows its own errors so the cron never fails — a green cron run only means the HTTP call was
queued. Truth is `collabbox_sync_runs`. The frequent pass is recorded as `kind = 'manual'`,
`trigger_kind = 'cron'`.

## One full run (nightly / manual / frequent), step by step — `index.ts runFull()`

1. **Housekeeping.** A `running` row older than 20 min is closed `failed` ("abandoned"). Only one
   full run at a time: a second nightly/manual answers **409 `already_running`** (a frequent pass
   during a manual backfill is simply skipped; a skipped nightly is caught up by the next night's
   window). A dry run writes no run row and skips the guard.
2. **Window.** Manual: `from`/`to` (≤ 14 days, not after today). Nightly:
   `collabbox_nightly_window(p_days 3, p_max_days 14)` = the last 3 complete Skopje days, widened
   back to the day after the last ok **nightly** window and to any day still holding `booked` /
   `no_items` rows, never more than 14 days.
3. **Per day, sequentially:** headers of every type in `NIGHTLY_TYPES` (10036 · 10050 · 10106 ·
   10114 · 10111 · 10055 · 10107 · 10112 · 10099 · 10063 · 10058) in ONE page
   (`comp=searchdoc`, select values COMMA-WRAPPED or the search returns nothing; the count
   "Вкупно пронајдени N документи" is checked), then the HTML line-items table
   (`comp=repbydocitm`; no file is left on their server). A day whose lines fail stays `no_items`
   and is re-read next night — never guessed. A day is skipped when time or requests run out →
   run `partial`, warning `stopped before <day> (time budget)` or `(request cap)`.
4. **Classify in the function** (`collabbox.ts`): line role goods / delivery / note / marker
   (a `product_aliases` kind first — every alias row counts, `reviewed_by` is not read; then
   8001/"ДОСТАВА" delivery, 8004/ПОЕН/КУПОН/ФЛАЕР marker, 8002/"ЗАБЕЛЕШКА" note), product via
   `product_aliases` (source `collabbox`, then `any`) then `products.sku` (active first); stornos
   paired inside the window.
5. **Komitent cards** (`comp=infocc` by Шифра) for the customers of order AND 10111 LEADS documents
   the database cannot place (`collabbox_komitenti_needed(docs)`, priority 1 = no phone anywhere —
   no parcel phone, no stored phone of any source; 2 = a parcel / register phone exists), ≤ 60 per
   run, within the budget. The request is the Коминтенти form as the operators' "Барај" sends it
   (one GET of the form per session, then one POST per card, ≈ 0,3 s each); a search that answers
   with several rows and not the card is an ERROR ("ignored its filter"), never "not found". Fixed
   03.10.2026 (v8) — see Known gaps 1.
6. **The writer** `collabbox_apply_documents(run, docs, dry)` in batches of 40 (≤ 200 allowed),
   oldest first; one subtransaction per document (a bad document = an `error` ledger row, retried —
   never an aborted batch); `elyon.bulk_repair` (no paid/returned bells) and
   `elyon.keep_updated_at` set transaction-locally; the run's counters bumped atomically.
7. **Vanished documents** — `collabbox_close_window(run, day, day, types, seen)` per FULLY read day
   with at least one document: ledger rows of that day and those types that the re-read no longer
   finds get `vanished_at` + flag `vanished_from_collabbox`; an order THIS sync created for one
   gets a note (never deleted, never re-statused). A day that lost more than half of ≥ 10 known
   documents is "suspicious" — reported, never marked. An empty re-read proves nothing.
8. **Retry** — `collabbox_retry_open(run, dry, 14, 40)` up to 10 rounds: re-applies the stored
   payload of `no_phone` · `awaiting_parcel` · `credit_pending` · `error` rows of the **last 14
   days** (a parcel may have appeared, a holder been linked).
9. **Close the run** — status `ok` / `partial` / `failed`, `stats` (per-day fetch figures, komitent
   figures, storno pairs, outcome and reason counts, conflicts / no-phone / unmapped-line / storno /
   error lists ≤ 100, vanished sample, slowest request, warnings).

Budgets: background run 330 s (platform wall clock 400 s), synchronous (`"wait": true`, or a dry
run) 115 s, 45 s kept for the writer after the last fetch. A non-dry nightly/manual call answers
**202** with its `run_id` at once and works in the background (`EdgeRuntime.waitUntil`).

## What each document TYPE does — `collabbox_doc_role()` (SQL) = `DOC_ROLES` (collabbox.ts)

| Type | collabBox name | Role | What the writer does |
|---|---|---|---|
| 10036 | Нарачка in | `order` | an order — once its MEX parcel exists (Телешоп – Lead in) |
| 10050 | Нарачка out | `order` | an order — once its MEX parcel exists (Телешоп – Lead out) |
| 10106 | Нарачка Социјални Мрежи | `order` | an order — once its MEX parcel exists (Social) |
| 10114 | LEADS-OUT Нарачка | `order_unless_held` | an order ONLY when no order holds / names its parcel (Affiliate – Lead out, whoever booked it — the team rule of `20260942001800` that briefly moved a `crm_prediction` author's LEADS-OUT was withdrawn by `…1850`); otherwise its author is credited on that order. Waits for the parcel like the others (a LEADS-OUT booked in collabBox often has a CRM twin that takes the parcel) |
| 10111 | Нарачка LEADS | `credit` | **never an order in this writer** (the sale comes through AlterCPA): its author is credited as seller on the order holding its parcel. Exception OUTSIDE the writer (owner 01.10.2026, `20260944000970`, see D′): no order holds the parcel and MEX delivered / returned it → one order made from the document |
| 10055 · 10107 · 10112 · 10099 · 10063 · 10058 and any unknown | С. Мрежи-Продавница · Продавници · WEB · … | `record` | ledger only (10107 shop orders are not at MEX; 10112 web documents are worth 0) |

`collabbox.test.ts` reads the migration's CASE and fails when the TS twin differs — change both.

## The writer's decision, in order — `collabbox_apply_one()`

**A. Storno** (negative amount, or no/zero amount and a negative line) → `storno`, never an order.
Its original = the same komitent's earlier non-storno document worth exactly the reversed value
(±1 ден), ≤ 120 days back, only when **exactly one** fits (inside the window first, then the
`collabbox_documents` / `teleshop_import_documents` ledgers). The original is marked
`reversed_by`; if THIS sync created the original's order, that order gets a note ("check it and
cancel it if it never shipped") — never deleted, never re-statused. No unique original →
`storno_unmatched`.

**B. Record-only type** → `recorded`.

**C. The document already IS an order** (idempotency key `external_source = 'collabbox'`,
`external_order_id = DocNumber`, unique index `uniq_orders_external_ref`) → `exists` or `updated`:
fill `collabbox_doc_type` when NULL (a different stored type is flagged `type_changed:a>b`, never
overwritten), credit the author if nobody is stamped yet, flag `amount_edited_after_shipping`
(MEX decides). The "edited before packing" update path exists only for an order this sync created
as `confirmed` without a parcel — no longer possible since 29.09.

**D. 10111 LEADS (credit):** holder = the order the register links the parcel to, else the single
order naming the tracking id. Amount ≤ 0 → `replacement`. No holder → `credit_pending`
(`no_parcel_yet` / `parcel_not_linked_yet`). Else `collabbox_credit_order()` → `credited`, or
`recorded` with the credit verdict. `collabbox_retry_open()` re-tries pending rows only 14 days back:
an older `credit_pending` whose parcel gets a holder later (e.g. the phone + date link backfill,
`scripts/repair-link-lead-parcels.mjs`, owner 01.10.2026) is re-run through the SAME writer by
`node scripts/collabbox-recredit.mjs [--from 2026-09-01] [--to …]` — dry run through
`collabbox_apply_documents(…, p_dry = true)` in a READ ONLY transaction (the read-only role may not execute
the writer), apply under a `manual` `collabbox_sync_runs` row (one run at a time), before/after of the
holder's `sold_*` and the document in `data_repair_rows` (key `collabbox-recredit`), undo
`--rollback <run>`. It never changes `collabbox_apply_one` / `collabbox_credit_order`.

**D′. A LEADS document whose parcel MEX DELIVERED or RETURNED and no order holds (owner, 01.10.2026 — "If
there is delivery from MEX too or return, then of course we will import them, that way we know that MEX really
tried to deliver that order")** becomes ONE order — made OUTSIDE the writer, which stays unchanged
(migration `20260944000970`, `leads_parcel_orders_plan(days)` = the one definition; nightly cron
`leads-parcel-orders` 21:06 Skopje, switch `app_settings.leads_parcel_orders` seeded `report`; backfill
`scripts/repair-leads-parcel-orders.mjs`, key `leads-parcel-orders`, undo its own `--rollback <run>`). Rules:
a 9110 parcel at MEX 2 / 7, COD > 0, last 75 days, no order holds / names it, not a test phone; its 10111
document `credit_pending`, lines read, value > 0; NO twin — the phone + date linker has no row for it, no
living Affiliate sale on the phone (−30 d … +1 d: a re-ship is `repair-link-elyon-parcels.mjs`'s), and the
writer's `possible_twin_crm_sale` does not fit. The order is the writer's branch-E shape with
`external_order_id` = the DocNumber and `collabbox_doc_type '10111'` (→ `altercpa / collabbox_leads`,
Affiliate – Lead in — the same department its parcel had as MEX-only), status from MEX, `mex_link_parcel(…,
'collabbox_import')`; then the document is re-applied through `collabbox_apply_documents` in the same
transaction — branch C now finds the order by its DocNumber and `collabbox_credit_order` stamps the author
(outcome `updated` / credit `stamped`). In transit / at the label: not imported — they qualify by themselves.
9103 / 10114 stays this writer's (`order_unless_held` already makes those orders). Dry run `aa562ee1`
(01.10 ~22:40): 213 parcels → **121 orders** (410.929 ден: 88 paid, 33 returned; September 80 / 278.299 ден) +
92 listed (33 link-plan candidates, 34 a living Affiliate sale on the phone, 24 no document, 1 no phone).

**E. Order documents (10036 · 10050 · 10106 · 10114)**, first stop wins:

| Check | Outcome · reason |
|---|---|
| reversed by a storno | `skipped · reversed_by_storno` |
| DocNumber twice in one day's headers | `skipped · duplicate_doc_number` |
| DocNumber not `NNN-SSSS-n/yyyy` | `skipped · bad_doc_number` |
| the day's line items were not read | `no_items · line_items_not_read` (re-read next night) |
| no amount | `skipped · no_amount` |
| amount ≤ 0 or goods ≤ 0 (document value 0) | `replacement · replacement_zero_value` — never an order |
| its parcel's COD is 0 | `replacement · replacement_cod0` — never an order |
| another order holds (register) or names the parcel | 10114: credit that holder (`credited`/`recorded`); others: `conflict · parcel_held_by_other_order` / `tracking_named_by_other_order` |
| a live web order claims the parcel | `conflict · parcel_claimed_by_web_order` |
| the parcel was created at MEX BEFORE the document | `conflict · parcel_predates_document` (never linked to a later order) |
| **no MEX parcel yet** | **`awaiting_parcel`** (`waits_for_its_parcel` / `leads_out_waits_for_its_parcel`), retried 14 nights |
| the komitent is skipped (card, teleshop registry or header name: employee, company, deceased, wrong number, test, operator account, do-not-ship, junk name) | `skipped · komitent_<verdict>` |
| no valid Macedonian phone | `no_phone` (`no_komitent` / `komitent_card_not_read` / `no_valid_macedonian_phone`), retried 14 days |
| one of the owner's test phones (`report_excluded_phones`) | `skipped · test_phone` |
| **a twin:** a CRM / AlterCPA order on the same last-8 phone, not a collabBox order, status pending / take / call_again / confirmed / shipped / delivered / paid / returned, no parcel of its own, price > 0, a real product, not a disposition, created 1 day before … 2 days after the document's SALE time (`collabbox_sale_at` — the booking; it was `doc_at`, the dispatch day, until `20260944000630`, so a copy booked days ahead became a second order when its parcel came), with price × 61,5 equal (±3 ден) to the amount, to the amount − 150, or to the goods | `conflict · possible_twin_crm_sale` — never a second order |
| otherwise | **`created`** (`parcel_paid` / `parcel_returned` / `parcel_shipped`) |

A near CRM sale (±3 days of the sale time) whose price does NOT fit is only flagged
`near_crm_sale_price_differs` and the order is created. **Conflicts are listed, never forced.**

**The same twin rule in the cohort (`insights_sale_rows`' `bk`, before the order exists):** a waiting
booking is not counted when the customer's phone (card → teleshop registry → any stored card) has
such a CRM / AlterCPA sale (14 days before … 2 days after `doc_at`). **With no phone** (a komitent new
in collabBox) it is the author's own priced CRM sale created 1 day before … 2 days after the booking's
sale time AND either within ±10 min of it or with the same customer name after the script fold —
`collabbox_name_key()` (words → `mk_geo_norm`, sorted, ≥ 2 words), compared with the CRM sale's name
or any name the CRM holds on that sale's phone (`20260944000630`, owner 01.10: 4 LEADS-OUT copies
counted twice that day; it compared with `doc_at` ±10 min before). `leaderboard_day_v2` reads the
cohort, so such a booking shows as `booked_twin` there.

**Since `20260947001850` (owner 03.10.2026):** `bk` holds bookings whose SALE day is at most 10 Skopje days
back (`cohort_unshipped_since()`; it was `doc_at ≥ now() − 14 days`) — a booking MEX never takes stops
counting, and a booking whose parcel exists but no order holds it becomes MEX-only on its BOOKING day (`mo`
takes the document's `collabbox_sale_at`, the earlier of that and the parcel's creation). A **10111 LEADS**
document (`credit_pending` / `booked`, no parcel yet) is a booking too — Тим Маџари In, its author — only
with the customer's phone and when it is not the copy of a living Тим Маџари In sale on that phone (an
AlterCPA approval with no parcel, its sale or decision −30 d … +1 d, amount ignored); the writer's twin rule
applies as well. Phoneless LEADS documents wait for their parcel: the backtest (exports/leadsrt, 19–30.09)
found the author + folded-name pairing double-counting 208 of 677 of them.

**Since `20260947002050` (owner 03.10.2026) — a RE-BOOKING is not counted twice:** a booking with the
customer's phone and NO parcel of its own drops out of `bk` once it is OVERDUE — its first MEX batch day is over
(MEX registered ≥ 100 parcels after its dispatch day, `doc_at` or the first sighting if later, and before today)
— while the same last-8 phone has a sale with an existing MEX parcel (CRM order / collabBox order / MEX-only) made,
booked or sold 7 days before … 2 days after it, with a COD, not delivered before it, at the label / with the
courier / delivered (never MEX 3 · 9 · 13 or 7 — then it may be the re-send), still counted, with the same goods
(same priced products, or the value ± 3 ден / ± 150). MEX making the booking's own parcel ends it (a real second
shipment counts). Why the gate: MEX makes a document's parcel on the first working morning after its dispatch day
(Aug–Sep: 16.234 of 16.234), and without it the rule would have hidden 60 real second shipments of September for
hours to days (replay in exports/rebook). With it: September 3 / 7.990 ден, March–August 44 / 136.580 ден, none
ever shipped. The board shows an excluded order-type booking as `booked_twin`.

### The rule that matters most: an order only once its MEX parcel exists

Teleshop, social and LEADS-OUT are packed in collabBox, outside the CRM. A sync order without a
parcel would sit in the CRM warehouse's Packing queue (a double-pack risk), so an order document
waits as `awaiting_parcel` (retried for 14 nights) until MEX registers its parcel; until then the
booking is visible only through `collabbox_booked_today()` (below). Never create a "to pack"
(`confirmed`, no parcel) order from collabBox. (The migration header's "no parcel yet →
confirmed" line predates this 29.09 change; the function body is the law.)

### A created order

- `source_type 'import'`, `external_source 'collabbox'`, `external_order_id` = DocNumber,
  `mex_tracking_id` = DocNumber, `collabbox_doc_type` = type, `delivery_type 'home'`,
  `created_at = confirmed_at` = the document time (Skopje wall clock, DST-exact). The department
  comes from the insert trigger (`collabbox_department` by type).
- **Status from MEX, never from collabBox:** parcel 2 → `paid` (`paid_at` = delivered, `paid_basis
  'mex'`), 7 → `returned`, **8 → `confirmed` with `mex_sent_at` (за пакување — since
  `20260943001210`, owner 30.09: MEX 8 = the parcel waits for the courier)**, 4 / 10 / 9 / 1 / 3 →
  `shipped`; linked with
  `mex_link_parcel(DocNumber, order, 'collabbox_import', false)` — anything but `linked`/`already`
  rolls the insert back into `conflict · parcel_claimed_concurrently`. mex-reconcile keeps it
  current from then on.
- **Price** = goods value of the lines (ДОСТАВА, ЗАБЕЛЕШКА, ПОЕН / КУПОН / ФЛАЕР excluded) ÷ 61,5
  (FROZEN). A parcel COD that fits neither the goods nor goods + 150 (±3 ден) wins
  (`price_from_cod` — "COD ≠ price → MEX is right"). Lines → `order_items` (`collabbox_items`:
  proportional, summing exactly to the price); unmapped lines keep their name and are listed on
  the run; note lines → `order_notes` "collabBox: …"; one `order_history` row
  `System (collabbox-sync)`; `customer_profiles` insert-only.
- **Phone:** strict Macedonian 8-digit NSN (7X mobile · 2 Skopje · 3[1-4] · 4[2-8]) —
  `collabbox_mk_phone8()` = `MK_NSN_RE` (collabbox.ts) = `scripts/lib/teleshop-import.mjs`; never
  rewritten into a fake +389 number (unlike `normalizeMkPhone`). Source order: the komitent card
  (read tonight or stored, `source 'card'`) → `teleshop_import_customers` → the parcel receiver →
  `collabbox_customers` rows of `source 'parcel'`. A card phone that differs from the parcel's is
  flagged `phone_differs_from_parcel`. Stored `+389` + 8 digits.
- **Sale time (since `20260944000500`):** `created_at = confirmed_at = sold_at` = THE sale time
  `collabbox_sale_at(doc_at, booked_at)` — the booking (from 01.10.2026 on), else the document time.
- **Seller:** `sold_at` = the sale time, `sold_via 'collabbox'`, `sold_by_ext` = the identity's
  own spelling, `sold_by_person_id` via `collabbox_author_identity()` (`sales_person_identities`,
  `collabbox_author` first then `order_name`, whitespace-normalised). No agent-facing field
  (`confirmed_by_*`, `assigned_*`). Flags `no_author` / `author_unmapped`.
- **Stamp at write — the cron will not do it for LEADS / LEADS-OUT.** The stamping cron's
  `collabbox_author` rule (`order_decider_plan`) keys on the STORED `sale_source = 'collabbox'`; a
  LEADS-OUT order is stored `elyon_crm / collabbox_leads_out` and a LEADS one
  `altercpa / collabbox_leads` since the folder reclass. This writer (and `collabbox_credit_order()`
  below) is what credits them. Checked 29.09: every priced LEADS / LEADS-OUT order has a person
  (2.397 / 3.351); the 120 without one are 0 ден replacement rows.

### A late document for an existing order — a NEW order (03.10.2026)

**A LATE document is a NEW order (owner 03.10.2026 "ДА"; `20260947002000` / `2010` / `2020` / `2030`).** A sales document
(or its parcel) that arrives for an EXISTING order is that order's sale only when the lead was still open (case 1) or the order
was cancelled / trashed ≤ 10 days before it (case 2). Otherwise — more than 10 days after the cancel / trash (`dead_late`),
after the order's own sale that never shipped (`stale`: an approval / an AlterCPA "paid" older than 10 days at the arrival;
a delivery the customer POSTPONED — `sale_delivery_postponed_note`, ≤ 45 days — stays its own), or after the order already
shipped its own earlier parcel (`second_sale`) — the document becomes a NEW order. One definition: `late_sale_classify(order,
tracking)` / `late_sale_case_of` (arrival = the earliest of the document's sale time, its booking and the parcel's MEX
creation; the cancel moment = the last `order_history` move into cancelled / trashed, else the AlterCPA ledger's cancel /
trash, else `cancelled_at` / `trashed_at`, else `updated_at` (when ≤ the arrival), else `created_at`; the sale moment =
the `sale_day_revive` ledger's `old_sold_at`, else the earliest of `sold_at` / the approval / `confirmed_at`, else
`created_at`; `app_settings.late_sale_new_order.days` = 10).
- **In the writer:** branch D (10111 credit) and branch E's holder check (10114 credit, 10036 / 10050 / 10106 conflict) test
  the holder; a case-3 holder is not in the way — the document goes through branch E's own gates (lines, value, COD, web
  claim, a parcel older than the document, komitent, phone, test phone, the twin rule) and, right before the INSERT in the
  same sub-block, `late_sale_release()` puts the old order back and frees the parcel; `late_sale_attach_new()` names the
  new order in the ledger `late_sale_moves` and notes both orders. Ledger row: outcome `created`, `related_order_id` = the
  old order, credit `late_sale_new_order`, flag `late_sale:<case>`.
- **The new order** = branch E's shape: credited to the document's author (`collabbox_author_identity` — who entered it so it
  went to MEX), created / confirmed / sold at the booking (`collabbox_sale_at`), status from MEX (2 paid · 7 returned · 8
  confirmed · else shipped; a document with no parcel never becomes an order — every case-3 unit holds one), the parcel
  linked `collabbox_import`. A late **10111** is stored `elyon_crm / collabbox_leads_late` (explicit sale_source: never a
  lead) so `order_dept_by_team` decides by the author's LINE team (Маџари → Тим Маџари Out, Тим Центар Out authors → Тим
  Центар Out, Менаџмент → management); 10114 / 10050 / 10036 / 10106 keep their folder's source.
- **The old order is released** (`late_sale_release`): status = its status at the arrival (a second sale → its own earlier
  parcel back on it, with that parcel's MEX status); a cancel / trash keeps its own reason if the parcel never wiped it, else
  reason from the actor (`no-parcel-7d` → no_parcel_7d; else other + note) / trash → not_reachable (owner 27.09); an
  UNPROVEN courier status (an AlterCPA / import "paid" / "shipped" with no parcel of its own) is cancelled by the SYSTEM
  (other + note, dated by its sale moment — `20260947002030`, the folder-decides precedent: restored literally it would count
  again as paid_unproven while its parcel counts on the new order); the parcel's `mex_*` / paid / returned / shipped stamps
  cleared; the cod-price repair's price back when it priced it from THIS parcel; `sold_at` back from the sale_day_revive
  ledger (that move closed); `sold_*` cleared when THIS document's author was stamped on it by its credit (never for a
  second sale). Never a person's cancel; nothing is sent to AlterCPA.
- **Switch** `app_settings.late_sale_new_order.mode`: `report` (seeded) — the writer only flags `late_sale_pending:<case>`
  and credits as before · `apply` — the writer splits by itself (set by the history repair's apply) · a payload
  `late_sale_force: true` (the repair) applies whatever the switch says. `collabbox_credit_order` never stamps a case-3
  holder in apply mode (verdict `late_sale`).
- **History:** `scripts/repair-late-sale-new-order.mjs` (dry run → `--apply --run <id>` in the quiet window → `--rollback
  <id> [--apply]` = `late_sale_undo(<the apply's collabBox run>)`). Dry run 03.10 `80ac53b3`: 738 case-3 units (394
  dead_late · 273 stale · 69 second_sale; 1,98 М ден), 685 move, 53 listed (31 parcels with no sales document, 12 twins,
  6 value 0, 3 named by two orders, 1 do-not-ship). Proof: `node scripts/verify-late-sale-new-order.mjs [--list]` (W1, L1–L4, F1).

### Crediting an EXISTING order — `collabbox_credit_order()`

Write-once `sold_*`: NULL → value only. Verdicts: `stamped` · `stamped_no_person` ·
`person_filled` (same author, person now known) · `already` · `other_decider` (credited by another
rule — never overwritten) · `not_a_sale` · `doc_predates_order` (document > 48 h older than the
order) · `parcel_shared` · `no_author`. `sold_at` = the document time when the order was DEAD
(cancelled / trashed) or an undecided lead (pending / take / call_again) at the document's — or its
parcel's — arrival (`order_status_at`; owner 03.10.2026 "ДА", `20260947001800`: a revived order
counts on the booking day, in every month). Otherwise the document time unless that moves the sale
into another Skopje month than its cohort day (AlterCPA decision, confirmed_at, created_at) — then
the cohort day. Before 03.10 a dead lead credited across a month boundary kept its old lead day
(ORD-88154: lead 12.08, cancelled 13.08, LEADS booked 01.09 → counted 12.08). The orders it had
already stamped — and every other revival (mex-reconcile, the link repairs, the stamping cron) —
are re-timed by `sale_day_revive_apply()` (see `elyon-presence-and-leaderboard` §3) — case 1 / 2 only since `20260947002000`:
a case-3 holder is never stamped in apply mode (verdict `late_sale`) and becomes a new order (above).

## The booking day — `booked_at` (owner 01.10.2026; `20260944000500` / `20260944000600`)

> "Денот кога операторот ја внел … ако потврдам нарачка ми се брои за денес … достава после 5 дена само
> ќе ја валидира порачката, или ќе ја направи return" — a collabBox sale counts on the day the operator
> BOOKED it, on the board and everywhere live.

- **Why:** collabBox's `Datum` (`doc_at`) is the **dispatch day** with the booking's clock time
  (`002-9102-177916/2026` reads 01.10 10:30 but sits between 177909 at 30.09 10:08 and 177920 at
  30.09 11:19). DocNumbers are allocated in booking order per series (`NNN-SSSS/yyyy`; ≤ 10 min of
  disorder measured, a few 9110 LEADS documents are dated a day BACK).
- **Reading ahead:** the frequent pass also reads the documents dated tomorrow … today + 14
  (`ahead_days`, `aheadRange()` in `collabbox.ts`: one header search + one line-items request, the
  same request shapes; skipped with a warning when time or requests run out; vanished-marking per
  ahead day that returned documents). The run row's `ahead_to` records the range read. Before this,
  on 01.10, 83 order-type documents dated 02–09.10 were invisible.
- **`collabbox_documents.booked_at` + `booked_at_basis`**, decided ONCE at the first sighting by
  `collabbox_estimate_booked_at(doc, doc_at, first_seen_at, first_run_id)` (the writer passes it; the
  trigger `trg_collabbox_documents_booked_at` fills any other insert, keeps it write-once —
  `SET LOCAL elyon.collabbox_booked_at_backfill = 'on'` lets the backfill re-decide — and clamps it to
  ≤ `doc_at`): **`seen`** — a full pass (`kind` manual/nightly, `ok`) that had read the day (its window,
  or `(window_to, ahead_to]`) finished before the sighting and started < 23 h before it, so it was
  booked in between → its clock time on the latest day ≤ the sighting (exact even across midnight;
  the first pass of the morning sees an evening booking); **`sequence`** — the 3rd smallest
  `LEAST(doc_at, first_seen_at)` of the next 20 numbers of the series (+ 60 min) bounds it → its clock
  time on the latest day ≤ that bound; **`doc`** — `doc_at`. Never more than 31 days back. TWIN:
  `scripts/lib/collabbox-booking-day.mjs` (constants checked by `bookingDay.test.ts`; JS = SQL proven
  on 8.504 real documents in PGlite, and again by the backfill's dry run once applied). NULL =
  undecided (read as `doc_at`).
- **THE sale time** `collabbox_sale_at(doc_at, booked_at)` = `booked_at` when it is earlier AND on or
  after `collabbox_booking_day_since()` (01.10.2026 00:00 Skopje — the owner's default: closed months
  never move, nothing moves INTO September), else `doc_at`. Read by the writer (the order's
  created / confirmed / sold, `collabbox_credit_order`'s time), `collabbox_booked_today`,
  `leaderboard_day_v2`'s `bkd`, `insights_sale_rows`' booking rows, `insights_work`. Never derive a
  collabBox sale day from `doc_at` again. `order_origin` carries `booked_at` (the order window shows
  "booked … · за испорака дд.мм").
- **The morning gap (fixed in `insights_sale_rows`, `20260944000600`):** MEX registers the night's
  parcels ~07:34, mex-reconcile ~07:37, this sync makes the orders ~07:50. A booking now stays a
  booking until an ORDER holds its parcel, and a parcel whose document is still counted as a booking
  is never MEX-only — on 01.10, 263 documents of 30.09 (588.150 ден; 157 Нарачка out) used to jump to
  no-seller MEX-only parcels of 01.10 for those minutes.
- **History:** `scripts/backfill-collabbox-booked-at.mjs` (dry run default, read-only; `--apply
  --expect ledger=N,orders=M --actor` after the owner's OK, quiet window, no pass running; ledger-first
  `data_repair_runs` key `collabbox-booked-at`; `--rollback --run`). With the default cutoff nothing
  moves (booked_at is information below 01.10); the dry run prints the what-ifs for 01.09 / 01.03.
  Check: `node scripts/verify-booking-day.mjs` (B1 decided · B2 ≤ doc_at · B3 board = cohort, no
  morning gap · B4 the ahead range is read, every ahead document of the local collab_out export is in
  the ledger).
- **Apply order:** `20260944000500` → `20260944000600` → deploy `collabbox-sync` (it falls back without
  `ahead_to` if deployed first, but must not be) → backfill dry run → owner → `--apply`.

## The ledger — `collabbox_documents` (PK DocNumber)

One row per document ever seen; `outcome` = what the LAST pass decided; `payload` = the document as
sent (what the retry re-applies); `created_by_sync` never cleared; `department` =
`collabbox_department()`; `reason`, `flags`, `order_id`, `related_order_id` (the order in the way),
`attempts`, `vanished_at`, storno links. Owners read (RLS), service role writes.

| Outcome | Meaning | Retried? |
|---|---|---|
| `booked` | live mode: header only | by the next full pass of that day |
| `created` / `exists` / `updated` | this pass created / found / filled the order | — |
| `credited` / `recorded` | author credited on the holder / ledger only | — |
| `conflict` | a holder, a web claim, an older parcel or a CRM twin is in the way | re-evaluated whenever the day is re-read |
| `replacement` | value 0 / goods 0 / COD 0 — never an order | — |
| `storno` | a reversal, recorded | — |
| `skipped` | not importable (reason) | — |
| `no_phone` · `awaiting_parcel` · `credit_pending` | open | by `collabbox_retry_open`, 14 days |
| `no_items` | the day's lines were not read | next night's window |
| `error` | the writer raised (reason) | 14 days |

The ledger covers every document from **01.03.2026** on: the history backfill (01.03 → 26.09, 4-day
manual windows) finished on 29.09 at 08:03 with 0 errors. Over history most rows are `exists` (the
teleshop import already held the order), `recorded` or `credit_pending`; the orders the backfill
created are chiefly social (10106) and LEADS-OUT (10114). For today's picture run the outcome query
in the Runbook below.

Other tables: `collabbox_sync_runs` (one row per non-dry run: kind `nightly`/`live`/`manual`,
trigger, window, counters, `stats`, `error`, `warning`); `collabbox_customers` (komitent cards —
phone, name, city, address, skip verdict, flags; `source` `card`, `parcel` or `register_YYYYMMDD`
(a phone from that day's register harvest, `20260947001950`, `run_id` = the load's
`data_repair_runs` id — the writer reads only `card` / `parcel`); PII, owners only; PK `komitent_id`,
so every reader's "any stored row" subquery returns at most one row).

## Freshness — `collabbox_feed_state()`

Keys `feed · last_ok_at · status · detail · data_through · lag_parcels` (the contract of the
20260939000200 stub) + `last_run_at · last_error · last_error_at · runs_24h · failed_24h ·
live_last_ok_at · booked_today · stale_to_pack`.
- `status`: `failed` = the last settled nightly/manual run failed (a `running` row > 20 min
  counts) · `stale` = the run that should have finished did not — last ok older than *expected* −
  45 min, *expected* = now (07:30–23:15 Skopje), the 22:45 run (23:15–00:45), the 00:00 nightly
  (00:45–07:30) — since `20260942001400` (it was a flat 26 h) · `ok` · `n/a` before any run with
  no collabBox order.
- `last_ok_at` = the last ok nightly/manual run (frequent passes count); `data_through` = the
  newest ledger document; `lag_parcels` = NATURA 9100/9102/9108 COD parcels > 48 h old, linked to
  no order, not web-claimed, never seen by the sync;
  `stale_to_pack` = orders this sync created to pack still without a parcel after 7 days (should
  stay 0 now); `live_last_ok_at` is kept only for compatibility.
- Read by `integrations_health()` — since 20260942001400 the collabBox card carries the run log:
  job `rolling` = the cron's frequent pass (`kind 'manual'` + `trigger_kind 'cron'`, stale 45 min
  past the expected slot), job `nightly` (26 h), hand-started windows as `manual`, 24 h counts,
  last error and the 7-day strip — and overlaid on the Overview's freshness by
  `GET /api/insights/overview` (`IC.overlayFreshness`).

`collabbox_booked_today(day)` = per author / person / type, the day's (the BOOKING day's, since
`20260944000500`) documents of 10036 · 10050 ·
10111 · 10114 · 10106 with outcome `booked` or `awaiting_parcel`, amount > 0, not storno, not
vanished, that no order holds yet (no order with that external ref or tracking id, no linked
parcel). Its consumer is the TV leaderboard: `leaderboard_day_v2` (`20260942001200`) keeps a
drift-checked copy of this filter and counts a booking into the seller's total only for the
`order` types 10036 · 10050 · 10106 (and not when the customer's CRM / AlterCPA sale already is on
the board — the writer's twin rule); 10111 LEADS and 10114 LEADS-OUT bookings are shown apart as
twins. Once the parcel exists the frequent pass creates the order (`sold_at` = the document time),
the booking drops out and the order counts instead — same day, same author. See
`elyon-presence-and-leaderboard`.

## Secrets and setup

- Function secrets `COLLABBOX_USER` / `COLLABBOX_PASS` (the collabBox login, `docs/VAULT.md` §7)
  and `COLLABBOX_SYNC_SECRET` (the `x-collabbox-sync-secret` header, compared in constant time);
  the SAME value lives in the DB Vault as `collabbox_sync_secret` for pg_cron. The function fails
  closed (503) when any is unset, and never logs credentials.
- `supabase/config.toml` `[functions.collabbox-sync] verify_jwt = false` (pg_cron sends no JWT;
  the header is the gate).
- Setup / redeploy (Macedonia only): `node scripts/assert-mk-target.mjs` →
  `node scripts/apply-migration-mk.mjs supabase/migrations/20260942000900_collabbox_nightly_sync.sql`
  (only on a fresh project) → `npx supabase secrets set COLLABBOX_USER=… COLLABBOX_PASS=…
  COLLABBOX_SYNC_SECRET=<64 hex> --project-ref bmfxhgznttcnnlqloqzp` →
  `npx supabase functions deploy collabbox-sync --project-ref bmfxhgznttcnnlqloqzp` →
  `select vault.create_secret('<the same 64 hex>', 'collabbox_sync_secret');` →
  `node scripts/engine-fixture-mk.mjs`.
- `scripts/collabbox-fetch.mjs` (the Node twin of the client, same allow-list idea) reads the
  credentials at runtime from VAULT §7 and writes to `exports/collabbox/` (gitignored, PII).

## Runbook

**Dry run of ONE past day** (reads collabBox, writes NOTHING — no order, ledger or run row;
answers in ~30–90 s; keep the secret in an environment variable, keep the output out of git — it
holds customer data):

```bash
curl -s -X POST https://bmfxhgznttcnnlqloqzp.supabase.co/functions/v1/collabbox-sync \
  -H "x-collabbox-sync-secret: $COLLABBOX_SYNC_SECRET" -H "Content-Type: application/json" \
  -d '{"mode":"manual","from":"2026-09-27","to":"2026-09-27","dry_run":true}' > dry-2026-09-27.json
```

Read `days[].headers / items / items_error`, `requests` (≤ 100), `outcomes` / `reasons` (a day the
CRM already holds is mostly `exists` / `recorded` / `credited`), every `plan[]` row with
`outcome: "created"` (status, price_eur, department, flags), the `conflicts`, `no_phone`,
`unmapped` lists, `komitenti` (needed vs found), `warnings`, `slowest_ms`.

**A real manual window:** same body without `dry_run` (add `"wait": true` to get the summary back
instead of `202` + `run_id`). **Keep a window to ≤ 4 days per call** — the size the Mar→Sep
backfill used. Every day costs two paced requests (headers + line items) plus card lookups and the
writer, and a run stops at its time budget (115 s synchronous, 330 s in the background) or its
100-request cap: a longer window ends `partial` with the warning `stopped before <day> (…)`, and
the rest must be run again from that day. The code accepts up to 14 days (`MAX_WINDOW_DAYS`).
Only one nightly/manual run at a time: a second call — and every `collabbox-sync-frequent` pass
meanwhile — gets **409 `already_running`**. So run backfills in the night gap — 23:00–23:55, or
after the 00:00 nightly has finished and before 07:00 Skopje — never across 00:00 (the nightly
would get 409 and wait a day) and never into 07:00 (the day's passes would be skipped); one window
after another, reading each result before the next.

**Check a run:**
```sql
select kind, trigger_kind, status, window_from, window_to, fetched, created, updated, unchanged,
       conflicts, replacements, no_phone, credited, recorded, skipped, pending, stornos, errors,
       vanished, komitenti_fetched, error, warning, duration_ms
  from collabbox_sync_runs order by started_at desc limit 10;
select outcome, reason, count(*) from collabbox_documents group by 1, 2 order by 3 desc;
select public.collabbox_feed_state();
```

**Re-evaluate old open rows** (older than 14 days, e.g. the backfill's `credit_pending`): run a
manual window over their days — the writer re-reads and re-applies every document.

**Pause:** `select cron.unschedule('collabbox-sync'); select cron.unschedule('collabbox-sync-frequent');`
(or delete the Vault row). Re-applying 20260942000900 / 20260942001300 re-creates the jobs.
Tripwire first; the function and the crons target Macedonia only (the URL in
`invoke_collabbox_sync` is this project).

## Known gaps (29.09)

1. **The komitent-card lookup — FIXED 03.10.2026 (function v8, owner "ГО", read-only).** From 29.09 to
   03.10 it found nothing (60 read, 60 "not found" per pass): the sync sent the 10.09 harvest's short
   field list to `…&action=search&pgsf=0&cp=1`, and collabBox then IGNORES every filter and answers with
   the first 50 of the 166k-row register (the harvests' `name1=А` "worked" only because of that). Probed
   read-only on 03.10 (the form page + a handful of searches): the same path without paging and the short
   list → the whole register again; the FULL form, serialised from `GET Index?comp=infocc` as the browser
   sends it (`resolveClick('search')`: action=search, searchMode=search) → "Пронајден е 1 резултат", the
   card asked for. That answer has 20 columns (Прикажи картичка = no — no Број картичка), so
   `parseKomitentSearch` maps the columns by the HEADER row (fixed positions only as a fallback). 9 cards
   checked: every phone equal to the 01.10 register's (and to the teleshop registry where it had one); a
   new komitent of 02.10 is found with its phone; an unknown Шифра answers "Нема резултати за
   специфираното барање" (= not found). The lookup now also covers 10111 LEADS documents (index.ts).
   **The missing phones were loaded once from the 01.10 register** (`20260947001950` +
   `scripts/load-komitent-register-phones.mjs`, run `ed4bcc39`, source `register_20261001`, 12.473
   komitenti — only those of our sales documents no reader could place; rollback `--rollback <run>
   --apply`). Such a row is not a card: the writer ignores it, `insights_sale_rows`' bk0 reads it (its
   third source), a card read later replaces it.
2. **Do-not-contact is flagged, not trashed.** A card / name marked do-not-contact creates the order
   with flag `banned_customer_do_not_contact`; the sync does NOT create the sticky-trash marker the
   history import made (598 markers). A new such customer enters the calling lists until a manager
   trashes the phone.
3. **Open rows older than 14 days are never retried by the cron** — e.g. the historical 10111
   `credit_pending` rows from the Mar→Sep backfill. Re-run a manual window over their days.
4. Settings → Integrations: the SQL card has the run log since 20260942001400 and the words follow
   the 15-minute schedules (`145645c`: `feedDesc.collabbox`, `expect.cbx_15m`). Since 29.09
   afternoon the UI shows it like every other feed — "Last success" = the last ok run, runs / failed
   in 24 h, a "Newest document" row for `data_through`, the strip and the `rolling` / `nightly` /
   `manual` jobs (`elyon-customer360-and-integrations`). Closed.
5. The live mode never ran from cron (retired at 04:30 on 29.09, before its 08:00 window);
   `live_last_ok_at` is NULL.
6. Social history before March 2026 (no MEX) is not imported; the sync backfill started 01.03.2026.
7. The repair-kit "quiet window" (20:55–07:00) predates the 15-minute passes: collabBox runs until
   22:59 and MEX from 06:00 — see `docs/OPERATIONS_RUNBOOK.md`.

## How the collabBox history got into the CRM

| When | Tool (run) | What |
|---|---|---|
| 12.08 | `create-missing-orders-from-collabbox.mjs` | 5.563 pre-September register orders (LEADS / LEADS-OUT / teleshop), 4.605 `paid` with no MEX proof under the 12.08 operator rule — shown as "paid – history" |
| ~18.09 | `import-collabbox-teleshop.mjs` | the 02–17.09 teleshop/social import (2.644 orders) — superseded |
| 28.09 17:10–19:40 | `import-teleshop-collabbox.mjs` (run `8bb49e8e`, ledger 20260942000300) | **247.001 orders** from 10036 / 10050 (series 9100 / 9102), 01.2023 → 27.09.2026: 214.700 paid – history (`paid_basis legacy_import`, before MEX coverage), 28.577 MEX-paid, 3.311 returned, 413 in transit; 56.699 new customers; 598 do-not-contact / deceased trash markers; 1.432 conflicts and 7.777 skipped recorded in `teleshop_import_documents` (258.705 rows) / `teleshop_import_customers` (71.669). `--rollback --run <id>` |
| 28.09 | `import-leads-out-collabbox.mjs` (run `954707fd`) | 64 LEADS-OUT orders booked only in collabBox |
| 28.09 | `backfill-sellers-collabbox.mjs` (run `5b29ca75`) | 506 sales credited to their collabBox author; 40 former teleshop authors (2023–24) added as people; 40.702 history orders filled by the stamping function |
| 28.09 night | `backfill-collabbox-doc-types.mjs` | `orders.collabbox_doc_type` for 255.243 orders |
| 28.09 night | `reclass-by-folder.mjs` | every collabBox order to its department by type |
| 29.09 from 03:48 Skopje | the sync, `mode manual` | first run 27–28.09 (28.09: 350 documents, 207 awaiting their parcel); then 01.03 → 26.09 in 4-day windows, finished 08:03 with 0 errors — mostly `exists` / `recorded` / `credit_pending`; the orders it created are chiefly social (10106) and LEADS-OUT (10114). 06.04 failed twice on a draft document without a number until `20ad77d` (the header check now tolerates ≤ max(3, 5 %) incomplete rows per day, dropped and counted) |
| 29.09 08:46 | the sync, re-apply (run `4cdb427f`) | the 125 documents whose parcels the cross-channel repair `a057bc52` took off dead AlterCPA leads became their own teleshop / social orders with their sellers (`elyon-departments-and-sources`) |

**Do not re-run** `match-collabbox.mjs` with `--apply` (superseded — it once put 2.512 orders live
as paid) or the two August/September importers above. `reconcile-collabbox-mex.mjs` and
`audit-collabbox-paid.mjs` only report.

## Red flags

- Any request to collabBox outside the allow-list, any write to collabBox, credentials in a log,
  a file or a commit. Adding a shops request shape to this client (it belongs to `collabbox-shops`).
- Creating an order without its MEX parcel, or setting a status / `paid` from collabBox.
- Forcing a conflict, linking a parcel created before its document, a second order for one
  DocNumber.
- Changing `DOC_ROLES` without `collabbox_doc_role()` (or the reverse), or deciding a department by
  series when the type is known.
- `× 61,5` on a COD or a document amount (they are already денари).
- Applying anything from `supabase/paused/`.
- A collabBox sale day computed from `doc_at` (the dispatch day) instead of `collabbox_sale_at`, a write
  of `booked_at` outside the write-once guard, or moving a closed month's sales without the owner.
- Anything aimed at the Bulgarian project.
