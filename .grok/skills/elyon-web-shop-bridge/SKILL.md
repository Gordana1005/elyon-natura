---
name: elyon-web-shop-bridge
description: The naturatherapy.mk web shop → Elyon CRM mirror. Covers the HARD rule (the live shop gets no changes; web orders are a read-only mirror, never CRM orders), the shop-side crm_export schema and the elyon_crm_reader role, web_orders / web_order_items / web_sync_runs, the web-sync Edge Function and its 15-minute and nightly crons, web_order_outcome() / web_order_money(), how web orders link to MEX parcels (NTMK references, mex_tracking_id claims), card-paid orders, and web money in denari. Read before touching web_*, supabase/functions/web-sync, supabase/shop-side, scripts/apply-shop-crm-export.mjs, or anything that counts web sales.
---

# naturatherapy.mk web shop bridge — a read-only mirror

Built 27–28.09.2026 (migrations 20260937000000 + 20260937000100, applied; `web-sync` deployed —
HANDOFF §2: 24.485 MK orders incl. the OpenCart history).

## The hard rules (owner, 27.09 — law)

1. **The live shop gets NO changes.** It is a multi-tenant production platform (Supabase
   `kctgthpoeysmhmkrnkil`, tenants BG / MK / AL / GR in ONE database). The only thing ever
   approved on it: schema `crm_export` (four read-only functions over tenant 2) and the login
   role `elyon_crm_reader`. No shop code, settings, tenants, rows, indexes or deploys change.
   Never use the shop's full-access keys from the CRM.
2. **Web orders are NOT CRM orders.** They live in `public.web_orders` and never enter
   `public.orders`: nobody calls, assigns, confirms or ships them here, they get no `sold_*`, no
   commission, no segment membership. The shop auto-ships them through our NATURA MEX account
   with no phone confirmation, so they keep the shop's OWN outcome rules.
3. **Read-only toward MEX too.** Linking a web order to its parcel writes `web_orders` only —
   never `mex_parcels.order_id` (that FK belongs to `public.orders`).
4. **Web money is denari** (`web_orders.total` in `currency`, MKD on this store, never
   converted). Render with `formatDenari`, never `formatMoney` — see `elyon-currency`.

`orders.sale_source = 'web'` (OpenCart / inbound-lead / `naturatherapy%` rows ENTERED IN THE CRM,
20260935000000) is a different thing: 0 rows today (`insightsCommon.ts` SOURCE_SALE_SOURCES note).

## Shop side — `supabase/shop-side/crm_export_tenant2.sql`

- Schema `crm_export`, outside `public` so the shop's `prisma db push` never sees or drops it.
- Four **late-bound PL/pgSQL** functions (STABLE, SECURITY DEFINER, `search_path pg_catalog,
  pg_temp`, `TimeZone UTC`) — functions, not views, so nothing pins a shop column: a shop
  schema change can only make OUR call fail, never block the shop's deploy. The self-test
  proves zero `pg_depend` rows to any table/column.
  - `mk_orders(p_updated_after, p_after_id, p_limit)` — incremental feed by `(updatedAt, id)`
  - `mk_orders_by_id(p_after_id, p_limit)` — the full sweep by id (resumable)
  - `mk_order_items(p_order_ids)` — lines of those ids THAT BELONG TO TENANT 2 (≤ 2000 ids)
  - `mk_orders_summary()` — tenant-2 count + newest `updatedAt` (the sync's probe)
  Page size clamped to 1..2000. Tenant resolved by SLUG `naturatherapy-mk` on every call; a
  renamed slug makes every call RAISE.
- Columns are the minimum: no names, e-mail, address, comments, payment refs or customer ids.
  The phone IS exported — the CRM keeps it as E.164 + last-8 for customer matching.
- `elyon_crm_reader`: LOGIN, NOINHERIT, no memberships, `CONNECTION LIMIT 3`,
  `default_transaction_read_only = on`, `statement_timeout 30s`,
  `idle_in_transaction_session_timeout 60s`; USAGE on `crm_export` + EXECUTE on the four
  functions, no table privilege anywhere.
- Apply ONLY with `node scripts/apply-shop-crm-export.mjs --apply` (default = dry static
  checks): refuses any target but the shop, refuses a file that touches anything beyond
  `crm_export` + the role, diffs the catalog inside the transaction and rolls back on any
  other change, sets the password as a SCRAM verifier, then logs in AS the reader to prove
  isolation. Also `--verify`, `--set-function-secrets` (runs the MK tripwire; sets
  `WEB_SHOP_DB_URL` + `WEB_SYNC_SECRET` [+ `WEB_SHOP_DB_CA`] on `oufoazmnbwugtfldkwsn` and the
  Vault row `web_sync_secret`), `--backfill`, `--sync`. Secrets live in `docs/VAULT.md` §8 only.
  Rollback SQL is in the file header.

## CRM side — `20260937000000_web_orders.sql`

| Object | Notes |
|---|---|
| `web_orders` | PK `shop_order_id`; `order_number` must be `OC-<n>` (OpenCart history since 2022-05-21) or `NTMK<n>` (native since 2026-09-04); `is_legacy` generated; `status` / `payment_method` / `payment_status` CHECKed against the shop's enums (a NEW shop value fails the upsert loudly, on purpose); `total`, `shipping_total`, `discount_total` in `currency`; `phone` (+389 E.164, NULL if not MK) + `phone8`; `tracking_number/status/status_at`; `mex_tracking_id` / `mex_link_method` / `mex_linked_at`; `deleted_in_shop_at`; `last_synced_at` (data changed) vs `last_seen_at` (read) |
| `web_order_items` | shop lines, `kind` SALE / GIFT (gift = price 0), `product_id` is the SHOP's id |
| `web_sync_runs` | one row per invocation: kind incremental/backfill, status running/ok/partial/failed, cursors, backfill session, counts, `rejected`, `error`, `warning` |
| `web_upsert_orders(orders, items, items_complete)` | the ONLY writer. Refuses the WHOLE batch on a foreign `tenant_slug`, a bad number, id or timestamps, or an item outside the batch; ≤ 2000 orders / 20 000 items; **monotonic** (`updated_at` never goes backwards); a number now held by another shop id retires the old row |
| `web_link_mex_parcels(ids, recent_days)` | the parcel link, below |
| `web_mark_deleted(session_start, shop_count)` | after a COMPLETE sweep: live rows the sweep did not see get `deleted_in_shop_at`; guard: more than max(25, 2 %) candidates → nothing marked, `guard: 'tripped'` |
| `insights_web_block(from, to_end)` | the Overview's web block (day = CREATED instant, Skopje; `card_unpaid` excluded; buckets, money, native/legacy split, courier statuses, delivery days, MEX facts, `mex_only`, `non_mkd_count`, daily) |

RLS: `web_orders` / `web_order_items` SELECT = `is_business_owner()` only (phones + money);
`web_sync_runs` = owners + admin/manager. Every writer and every function above except the
pure classifiers is service_role only. `deleted_in_shop_at IS NOT NULL` rows are excluded from
every web number (column comment; the block's totals, the timeline, the Overview's claim list
and the collabBox lag test filter it — the block's `mex_only` NOT EXISTS does not).

## Outcome and money — `web_order_outcome()` / `web_order_money()`

SQL twins of the shop's `classifyOutcome()` / `classifyMoney()` (storefront
`src/lib/order-outcome.ts`) — change them only together with the shop's rules. Ordered, first
match wins:

| Outcome | Rule |
|---|---|
| `card_unpaid` | CARD + status PENDING/CANCELLED + payment not PAID/PARTIALLY_REFUNDED/REFUNDED — a failed checkout, counted NOWHERE |
| `cancelled` | CANCELLED |
| `returned` | RETURNED or REFUNDED |
| `delivered` | DELIVERED, or DONE with payment PAID/PARTIALLY_REFUNDED |
| `no_record` | DONE without payment (OpenCart history nobody recorded) |
| `courier` | SHIPPED |
| `preparing` | CONFIRMED or PROCESSING |
| `awaiting` | everything else (PENDING) |

**In the cohort (owner 29.09.2026, `20260942001965`): `awaiting` COUNTS as a sale** — `cohort_web_bucket` puts an
awaiting order with a value in `to_pack` (a sale the shop has not confirmed yet), exactly like the shop's own panel
("22 направени нарачки · 43.774 ден" on 29.09 at noon). `card_unpaid` never counts; `cancelled` is shown apart. The
cohort carries an `awaiting` count on every bucket and the total, so the Overview's web card says "од нив N чекаат
потврда"; a waiting order counts until the shop acts (no age limit — the shop panel has none either).

**The TV board's web view — `leaderboard_web_live(day)`** (`…1940`, `…1967`): the shop's Skopje day = the cohort's web
part EXACTLY (checked on all 273 days 01.01–30.09.2026, 0 diffs): orders / value / awaiting, the outcomes, the 12
newest orders (no name or phone) — **plus the day's MEX-only web parcels** (the cohort's `mex_web` rows), which is how
the **gap 30.07–03.09.2026** (the old shop was never migrated; no web orders exist) is filled from MEX (owner
29.09). A day picker opens any day since 01.01.2026. 19 days have neither orders nor counted parcels
(31.07, 01–13.08, 22–23.08, 28–30.08).

Money: `lost` (CANCELLED/RETURNED/REFUNDED or payment REFUNDED) · `collected` (payment PAID/
PARTIALLY_REFUNDED) · `unrecorded` (DONE) · `to_collect`. Known gap: shop refunds are not
mirrored, so `collected_mkd` is GROSS; the block reports `partially_refunded_count` and
`refunds_mirrored: false`.

## The `web-sync` Edge Function — `supabase/functions/web-sync/index.ts`

- `POST` with header `x-web-sync-secret` (constant-time compare). `WEB_SHOP_DB_URL` must log in
  as `elyon_crm_reader` to the shop project (pooler or direct) — any other user or host, or a
  URL naming either Elyon CRM ref (MK or BG), is refused. TLS is enforced.
- Bodies: `{}` incremental · `{backfill:true}` one chunk of a full sweep · `restart:true` ·
  `nightly:true` · `dry:true` (reads and validates, writes nothing).
- Each page is read in a READ ONLY, repeatable-read transaction on the shop. Pages of 500,
  ≤ 20 pages and a 100 s budget per call.
- **Incremental:** keyset over the shop's `(updatedAt, id)`; an `ok` cursor is re-read with a
  10-minute overlap, a `partial` one continued exactly (upserts are monotonic, so re-reads are
  harmless). Prisma sets `updatedAt`, so raw-SQL edits in the shop do not move it — the nightly
  sweep catches those and deletions.
- **Sweep:** keyset by id, resumable across calls (a session < 24 h old continues);
  `nightly:true` is a no-op when a sweep finished < 20 h ago. At the end: `web_mark_deleted`
  (a tripped guard FAILS the run), link every live order, reset the incremental cursor to the
  sweep start − 10 min.
- **Guards:** a foreign-tenant row aborts the run before anything is written; an order number
  that is neither `OC-` nor `NTMK` is skipped, counted in `rejected` (sample in `stats`) with a
  `warning` — it never blocks the cursor, and the nightly sweep re-reports it until
  `ORDER_NUMBER_RE` AND `web_order_number_ok()` are widened together; the probe reporting
  0 tenant-2 orders fails the run.
- **Housekeeping:** a `running` row older than 10 min is closed `failed` ("abandoned"); a second
  run of the same kind answers 409 `already_running`.
- **Crons** (20260937000100; **every 5 min since 29.09.2026**, `20260942001940`): `web-sync` at `1-59/5 * * * *` and
  `web-sync-nightly` at `1,11,21,31,41,51 1 * * *` (01:xx UTC), both through
  `invoke_web_sync()` (pg_net, secret from Vault `web_sync_secret`; no secret → silent no-op;
  errors are swallowed so the cron itself never fails — failures show in `web_sync_runs`).
- **Freshness:** Settings → Integrations health `web` card ("на секои 5 мин"; stale 20 min after the last
  ok/partial run since `…1945` — it was 45 min at 15-minute runs — failing when the last settled run failed) and the Overview's freshness —
  see `elyon-customer360-and-integrations`.

## Web orders and MEX parcels

- The web shop ships through the **NATURA** MEX account (`MEX_API_KEY_2`, which also carries
  teleshop 9100/9102 and social 9108 — 20260934000100). A parcel is recognised as the shop's by
  an `NTMK…` `sender_reference` or tracking id, or by a web order's claim; an `NTMK…`-shaped
  tracking id has no DocNumber series (`mex_parcels.series` NULL, 357 such ids on 27.09).
- **The link** (`web_link_mex_parcels`), best first, newest parcel within a rule:
  `tracking` (the shop's waybill = MEX `tracking_id`) › `sender_reference` (MEX stored our
  order number) › `order_number` (MEX `tracking_id` = our order number). Runs for each written
  page; at the end of an incremental run for every live order of the last 60 days that is
  unlinked or whose waybill no longer matches its link (a parcel often reaches the register
  after the order reached us); at the end of a sweep for all of them, any age.
- **The phone link** (`web_link_mex_parcels_by_phone` + read-only `web_phone_link_candidates`,
  20260940000300) — for what carries NO reference: the OpenCart-era (OC-…) orders shipped under
  bare NATURA `M<digits>` waybills (series NULL) the shop never recorded, so every such sale
  counted twice (web `paid_legacy` + a MEX-only `mex_other` parcel). A link needs ALL of: parcel
  `natura` · `^M[0-9]+$` · no series · held by no CRM order · claimed by no web order; order
  live · unlinked · **no waybill of its own** · total > 0 · not `card_unpaid`; same `phone8`;
  parcel created 1 h before → 10 days after the order; COD = round(total) ±1 (or total +
  shipping), or COD 0 with the shop's payment PAID/PARTIALLY_REFUNDED (prepaid); **exactly one
  candidate on both sides** (pass 1 ≤ 5 days, pass 2 ≤ 10 days over the rest). Method
  `phone_amount`; it YIELDS — released when a deterministic web claim, a CRM order or the
  order's own waybill appears. web-sync runs it after `web_link_mex_parcels` (incremental: last
  60 days; sweep: all) as best-effort (a failure is the run's `warning`). One-off:
  `scripts/backfill-web-parcel-links.mjs` (dry run default; `--apply --expect N`). Dry run
  28.09: 2.751 links (2.422 COD = total, 322 prepaid COD 0, 7 pass 2) — Mar–Aug cohort −2.428
  double counts; 01–27.09 sales unchanged (the OC history ends 18.08). Never linked: 198 COD-0
  parcels to the company's own stores / dm branches (B2B), 60 after the OC history gap
  (18.08 → 04.09, no web order mirrored), 38 ambiguous (same customer, same amount, twice),
  101 with no web order on the phone, the rest amount/window misses.
- **A claim** = a live web order's `mex_tracking_id`. Claims decide ownership of a parcel in:
  `insights_overview` (a delivered MEX-only parcel is `web` when `NTMK…` or claimed, else
  `teleshop_other`), `insights_web_block.mex_only` (NTMK parcels no web order claims and the CRM
  has not linked), `collabbox_feed_state()` (claimed NATURA parcels are not collabBox lag),
  `customer_timeline` (the parcel nests under its web order), and the WIP cohort
  (20260940000000, unapplied: "web claims win" over a CRM order holding the same parcel).

## Card-paid orders (COD 0 at MEX)

- A failed card checkout is `card_unpaid` and excluded from `placed` and every total.
- A card order was paid in the shop, so its MEX parcel has nothing (or less than the total) to
  collect: COD 0 at MEX is expected, not a free parcel. `insights_web_block.money.collected_mkd`
  (shop payment status → shop total) and `mex.delivered_cod_mkd` (what MEX collected)
  legitimately differ for these orders. Never "fix" one to the other.
- WIP cohort (20260940000000, unapplied): `card_mkd = shop total − COD` for a PAID web order
  whose parcel was delivered; a web order's replacement test uses the SHOP total, not the COD;
  but an UNCLAIMED parcel with COD ≤ 0 counts as a free replacement. Answered 28.09 (HANDOFF
  §4.5): the NATURA `M…` COD-0 parcels are NOT card-paid — 322 are OC orders the shop marks
  COD/PAID (prepaid; now phone-linked, see above), 198 are B2B shipments to the own stores / dm.

## Test phones (owner, HANDOFF §3)

- 070123456 and 23123123 (`public.report_excluded_phones`): their web orders (by `phone8`, or
  linked to a test-phone parcel) and parcels are excluded from `insights_web_block` (placed,
  buckets, money, `mex_only`) and every cohort / Overview figure since 20260940000300 — the shop
  cannot be touched to delete them. `sync.live_orders` (mirror size) still counts them.

## Red flags

- Any DDL, DML or deploy aimed at `kctgthpoeysmhmkrnkil` other than re-applying
  `crm_export_tenant2.sql` through the apply script.
- Inserting a web order into `public.orders`, or setting `mex_parcels.order_id` from a web order.
- `formatMoney(web_orders.total)` or `total * 61.5` (61× the real figure).
- Widening the order-number pattern in only one of `web-sync` / `web_order_number_ok()`.
- Changing `web_order_outcome()` without the shop's `order-outcome.ts` (C14 in
  `scripts/verify-attribution.mjs` checks the block against the shop's own classifier).
