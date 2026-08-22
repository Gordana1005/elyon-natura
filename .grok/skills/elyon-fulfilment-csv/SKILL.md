---
name: elyon-fulfilment-csv
description: Use whenever generating, modifying, or explaining the MEX Poshta import CSV (the "Fulfilment CSV" on /orders). Enforce the exact 8-column portal contract (Kod na pratka … Tezina), Latin transliteration, comma-delimited, NO BOM, NO quoted fields, status transition rules, ship_after_date filtering. This file is imported directly into the MEX Poshta client portal to create shipments. Extremely high operational impact.
---

# Elyon Fulfilment CSV Skill — The MEX Poshta Import Contract

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
   exported broken. Manual orders get the zone on save (`resolveMexCity` in
   `api/index.ts`). AlterCPA mirrored orders must be stamped by `altercpa-sync`
   — until 2026-08-22 they were not, so 593/631 confirmed sat unexportable
   with city "Skopje" already on the row. Catch-up:
   `node --env-file=.env scripts/backfill-order-mex-city.mjs`. Foreign cities
   (Sofia, Vienna, …) stay NULL on purpose.
4. **Product list is NOT in the file.** Picking/packing lives on the Warehouse
   page (its own export). `Opis` is delivery info, not contents.

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

## Sacred Code Locations

- Column contract + sanitizer: `src/lib/mexImportCsv.ts` (+ its test)
- Order selection, ready-by filter, flip: `src/pages/Orders.tsx` (`runFulfilmentExport`, the popover)
- Validation gate: `src/lib/fulfilmentValidation.ts`
- CSV mechanics: `src/lib/csv.ts` · Transliteration: `src/lib/transliterate.ts`
- Backend bulk status + stock: `supabase/functions/api/index.ts` (bulk-status-update)

This is not a normal export. It is the live shipping contract with MEX Poshta.
A bad file here is parcels that don't move. Treat it with the respect it deserves.
