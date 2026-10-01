---
name: elyon-fulfilment-csv
description: Use whenever generating, modifying, or explaining how a CRM order becomes a MEX Poshta parcel — the MEX Import CSV on /orders (the exact 8-column portal contract Kod na pratka … Tezina, Latin transliteration, comma-delimited, NO BOM, NO quoted fields, status transition rules, ship_after_date filtering) AND its twin since 01.10.2026, the "Испрати до MEX" push from /warehouse (add_shipment.php via supabase/functions/api/mexPush.ts, pinned field by field to the CSV; the mex_push_attempts ledger, the claim, the existence check, the double-parcel guard, the account from the product line, app_settings.mex_push OFF until the owner). MEX has no cancel endpoint. Extremely high operational impact.
---

# Elyon Fulfilment CSV Skill — The MEX Poshta Import Contract (+ the push)

**Rewritten 2026-08-18.** The export on /orders is no longer a warehouse hand-off
file (BigArena's Bulgarian 3PL era) and no longer the `add_shipment.php` API
parameter dump (the 2026-09 interim). It is the file the **MEX Poshta client
portal bulk-imports to create real shipments**. Getting the format wrong means
parcels don't ship, ship to the wrong zone, or collect the wrong COD.

## The Contract (single source: `src/lib/mexImportCsv.ts`)

The header row is fixed, Latin, exactly as MEX's own template ships it:

```
Kod na pratka,Ime,Adresa,Grad,Telefon,Otkup,Opis,Tezina
A1234567,Alex Test,Varshavska 123,Skopje,076123456,150,maska za telefon,0.1
```

| Column | Value | Rules |
|---|---|---|
| `Kod na pratka` | `display_id` digits only (`ORD-01234` → `01234`) | Our reference; the reconcile cron matches on it |
| `Ime` | full customer name, transliterated | ONE field — no first/last split |
| `Adresa` | `composeHomeAddress(effectiveHomeParts(o))`, or `Podiganje: #code name city` for office pickup | transliterated, commas stripped |
| `Grad` | `mex_city_name` — the MEX zone's own Latin name | matched by NAME against MEX's 149 zones; never the operator's free text |
| `Telefon` | national `0XXXXXXXX` from stored `+389` E.164 | |
| `Otkup` | `codFor(price).amount` — plain integer denari (`1850`, no decimals) | codFor = frozen 61.5 peg, rounded to 10 ден |
| `Opis` | `delivery_instructions` (the order form's "Delivery / additional info"), transliterated | empty when blank — NOT the product list (operator decision 2026-08-18) |
| `Tezina` | constant `MEX_IMPORT_WEIGHT_KG` = `1` | rates are flat; declaration only |

## The Non-Negotiable Format Rules

- **Delimiter**: comma (`,`) · **Encoding**: UTF-8 **without BOM** (`toCsv(..., ',', false)`)
- **NO quoted fields, ever.** Every text field is sanitized (commas, quotes and
  newlines → space) *before* `toCsv`, so quoting never triggers — a naive
  importer would read a quoted field as garbage columns. Do not remove the
  sanitizer and rely on CSV quoting instead.
- **Everything Latin** via `transliterate()` from `src/lib/transliterate.ts`
  (readable digraph map) — **never** the lossy `normalizeMkGeo()`.
- `src/lib/mexImportCsv.test.ts` pins the exact header and full example rows.
  If it fails, the file no longer matches what the MEX portal accepts.

## Core Business Rules Encoded in the Export

1. **Status flip on export** (optional): "Mark as shipped on export" flips the
   exported confirmed orders → `shipped`, which triggers the server-side stock
   decrement (bulk-status-update; admin/manager/warehouse only).
2. **ship_after_date filtering**: default "Ready to ship by" = today + 2 days.
   Postponed orders past the cutoff drop out and resurface on their day.
3. **Pre-export validation** (`src/lib/fulfilmentValidation.ts`): an order is
   exported only with a full name, valid phone, 4-digit postal code, a resolved
   `mex_city_id` (the routable-zone gate — MEX has NO cancellation endpoint),
   product lines, price > 0 and a usable address. Invalid ones are held back
   via `FulfilmentValidationDialog` ("Fix first"), never silently dropped or
   exported broken. Every order gets the zone on save from ONE SQL resolver
   (migration 20260943000600): `mex_zone_for_settlement(orders.settlement_id)` —
   the place / district the order form PICKED — else `mex_zone_for_name(city,
   quarter)` for free text; `orders.mex_zone_basis` records which. The api
   (`resolveOrderZone`, pure half in `api/addressRouting.ts`) and `altercpa-sync`
   both call it; the old name match with LIMIT 1 sent 290/295 Skopje sales to
   "Skopje - Centar". Open orders are re-zoned by
   `scripts/repair-open-order-zones.mjs`; `scripts/verify-address-routing.mjs`
   checks the data. AlterCPA mirrored orders must be stamped by `altercpa-sync`
   — until 2026-08-22 they were not, so 593/631 confirmed sat unexportable
   with city "Skopje" already on the row. Catch-up:
   `node --env-file=.env scripts/backfill-order-mex-city.mjs`. Foreign cities
   (Sofia, Vienna, …) stay NULL on purpose.
4. **Product list is NOT in the file.** `Opis` is delivery info, not contents —
   the order form's **"За курирот"** field (`delivery_instructions`; the internal
   note is a separate `order_notes` row and never reaches MEX). There is no packing
   slip or label in the CRM at all: the warehouse prints from the MEX portal (owner,
   30.09.2026).

## The push — "Испрати до MEX" (built 01.10.2026, switched OFF)

The same parcel, created by the CRM itself instead of a person uploading the CSV
(owner 30.09: the naturatherapy.mk shop's flow; ported read-only from
`D:\naturatherapy\storefront\src\lib\shipping\mex.ts` / `mex-send.ts`). Until the
owner switches it on, the CSV above remains the way CRM sales reach MEX (besides
agents re-booking them in collabBox 10114).

- **Where:** /warehouse → Испрати до MEX (`elyon-warehouse-incoming`) →
  `POST /api/warehouse/mex-push {order_ids, account_overrides?, dry_run}`;
  `GET /api/warehouse/queue`; `GET` / `PATCH /api/warehouse/mex-push/settings`
  (PATCH admin-only, audited `mex.push_settings`). Admin / manager / warehouse only.
  Pure half `supabase/functions/api/mexPush.ts` (+ `mexPush.test.ts`), queue shaping
  `warehouseQueue.ts` (money stripped for non-owners), SQL in migration
  `20260943001200_mex_push.sql`.
- **The body = the CSV row, field by field** (`buildMexPayload`; the test pins it
  to `mexImportCsv.ts`): `tracking_id` = `sender_reference` = the order's
  `display_id` (MEX files the parcel under OUR number) · `first_name` / `last_name`
  (the CSV `Ime` split at the first space) · `receiver_phone` 0… · `receiver_address`
  (the CSV `Adresa`; an office order "Подигање: #code name city") ·
  `receiver_city_id` = `mex_city_id` (the CSV `Grad` as an id) · `cod` = a **STRING**
  of whole denars (`codMkd` = `codFor`: price € × the frozen 61,5, rounded to 10) ·
  `weight` 1 · `instructions` = `Opis` (≤ 10.000 characters). Every string is folded
  to ASCII. Header `AuthKey` (BIO NATURAL `MEX_API_KEY`, NATURA `MEX_API_KEY_2`).
- **Validation** = the CSV's gate (`fulfilmentValidation.ts`, same codes) + the
  push's own: `not_confirmed`, `has_parcel`, `web_order` (a web order is NEVER sent
  from the CRM), `test_phone`, `ship_later`, `no_reference`.
- **Created at most once — MEX has no cancel:**
  1. **Claim** (`mex_push_claim`): `UPDATE … SET mex_sent_at / mex_sent_by WHERE
     mex_tracking_id IS NULL`. A definite refusal releases it (`mex_push_release`);
     an unknown outcome (timeout) keeps it 15 minutes and the next attempt asks MEX first.
  2. **Ask MEX first:** our own `mex_parcels` register, then `get_shipment_status.php`
     by our order number, then `get_shipment_status_by_ref.php`, then the digits-only
     CSV code. A parcel that exists is re-linked (`exists_linked`), never re-created.
     If MEX cannot be asked, that is an error — never "no parcel".
  3. **Create**, then `mex_push_record`: a provisional register row, the link through
     `mex_link_parcel(…, 'push')` (sets `mex_tracking_id`, `mex_account`,
     `mex_status_id`), an order note, audit `mex.push`.
  - **Ledger `mex_push_attempts`** (RLS on, no policies): one row per attempt
    (`ok` / `exists_linked` / `error` / `skipped`) with the exact request and reply;
    the partial UNIQUE `mex_push_attempts_one_success` allows ONE success per order.
  - **Double-parcel guard:** an unlinked parcel on the same last-8 phone within 14
    days, or a collabBox order document on the same phone from the day before the
    sale onward, **blocks** (override only with `double_ok` + a reason ≥ 3
    characters); older documents, a parcel held by another order, an earlier
    unconfirmed push and a failed last attempt are hints.
- **The account** (`decideAccount`): from the basket's PRODUCT LINES
  (`mex_profile_for_line`: Bio Natural / Dr.Becker → BIO NATURAL, Natura Therapy /
  Ad Astra → NATURA — `elyon-products-catalogue`). No line → the department only
  suggests (`line_missing`, a person confirms); a disagreeing department / team or a
  **mixed basket** (`mixed_basket`) → no account until a person picks one with a
  reason. **The mixed-basket rule is still the owner's decision.**
- **The switch `app_settings.mex_push`** — OFF:
  `{"enabled":false,"accounts":{"natura":false,"bio_natural":false},"auto_send_at":null,"max_per_send":50}`.
  While off a real send answers `409 mex_push_disabled` and only a dry run works
  (the button is disabled with an explanation); one account off → that order comes
  back `skipped` / `account_disabled`. Hard cap 50 orders per send
  (`MEX_PUSH_HARD_CAP`; more → 400 `too_many_orders`), a 100 s time budget (the rest
  come back `deferred`). The UI asks for a dry run first and a "MEX нема откажување"
  confirmation, then sends in chunks.
- **No status change on send.** The order stays `confirmed` with `mex_sent_at` —
  **MEX 8 = за пакување**; mex-reconcile makes it `shipped` only when the courier
  takes the parcel (4 / 10 / 9 / 1 / 3), `paid` at 2, `returned` at 7.
- **The 11:00 auto-send** (`mexAutoSendPlan()`) is BUILT and NOT scheduled: no
  route, no cron; settings report `auto_send_scheduled: false` (owner: not everyone
  works in the CRM yet).
- **Open with the owner before switching it on:** the mixed-basket rule, and that
  collabBox gets NO document when the CRM ships directly (a LEADS-OUT booking would
  then be missing there). 01.10: 0 attempts in the ledger.

## What Happened to BigArena

The "BigArena Status CSV / XLSX" manual upload button was removed from /orders
and /warehouse on 2026-08-18 — courier outcomes come automatically from the
`mex-reconcile` cron (AlterCPA + MEX are the only truth sources). The server
endpoint `orders/bigarena-sync` still exists in the edge function (dormant,
role-guarded); the stock sync (`bigArenaStock`, products page) is a separate
feature and still live.

## Red Lines

- Never change the delimiter, add a BOM, add/rename/reorder columns, or let a
  field reach `toCsv` un-sanitized.
- Never emit decimals in `Otkup` or compute it outside `codFor()`.
- Never put the operator's free-text city in `Grad` — only `mex_city_name`.
- Never include orders past the ready-by cutoff or ones that failed validation.
- Never bypass the stock decrement when flipping to shipped on export.
- Never let the push and the CSV drift apart (`mexPush.test.ts` pins them), never
  create a parcel without the claim + the existence check, never send a web order,
  and never switch `app_settings.mex_push` on or schedule the 11:00 auto-send
  without the owner.

## Sacred Code Locations

- Column contract + sanitizer: `src/lib/mexImportCsv.ts` (+ its test)
- The push: `supabase/functions/api/mexPush.ts` (+ test), `warehouseQueue.ts`,
  routes in `index.ts` (`warehouse/queue`, `warehouse/mex-push`), migration
  `20260943001200_mex_push.sql`
- Order selection, ready-by filter, flip: `src/pages/Orders.tsx` (`runFulfilmentExport`, the popover)
- Validation gate: `src/lib/fulfilmentValidation.ts`
- CSV mechanics: `src/lib/csv.ts` · Transliteration: `src/lib/transliterate.ts`
- Backend bulk status + stock: `supabase/functions/api/index.ts` (bulk-status-update)

This is not a normal export. It is the live shipping contract with MEX Poshta.
A bad file here is parcels that don't move. Treat it with the respect it deserves.
