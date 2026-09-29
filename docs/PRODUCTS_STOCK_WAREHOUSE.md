# Products, catalogue, stock & warehouse — Macedonia

> Rewritten 29.09.2026. The Bulgarian version of this page (BigArena 3PL, the Daily Fulfilment
> CSV, Speedy / Econt offices, lev prices) is history: Macedonia ships with **MEX Poshta**, shows
> **денари**, and on 28.09 completed its catalogue so that every product that ever sold resolves
> to a catalogue product.

---

## 1. The catalogue — `products`

**706 products, 261 active (29.09).** Admin page: [../src/pages/ProductsPage.tsx](../src/pages/ProductsPage.tsx).

| Field | Meaning |
|---|---|
| `name` | Cyrillic (or brand Latin) product name, pack size included — pack sizes are different products |
| `sku` | internal code; the `set_product_sku` trigger fills `SKU-0000NN` for a new product without one |
| `price` | **EUR**, the agent's default selling price; shown in денари (`formatMoney`, × the FROZEN 61,5). To follow a market move, re-price in EUR from денари shelf prices (`scripts/reprice-catalogue-mk.mjs --plan`, then `--map … --commit`) — never touch the peg |
| `cost_price` | EUR purchase cost; owners only. **The owner sets cost prices later** — every product created on 28.09 has cost 0, and Pure Profit labels uncosted packages |
| `stock_quantity` / `low_stock_threshold` | see §3 |
| `is_active` | **the agents' order form (`ProductCombobox`) lists active products only**; /products and /warehouse show inactive ones with a "disabled" badge; Insights names them |
| `category` | free text; the 28.09 work created `Од продажби — collabBox/web (28.09.2026)`, `Без каталог — од продажби`, `Без каталог — трета страна (веб)` and `AlterCPA — нови понуди (28.09.2026)` |
| `days_of_supply_per_unit` | for the (dormant) v4 "Due to Reorder" list |

The 8 AlterCPA products of 28.09 (GlucoCare, MenCare, ProstaCare, NeuroCare, Arthriva, Collagen
Peptides Bionatural, Neurofix 1+1, Prostafix 1+1 — the 1+1 are bundles of 2) are active, with cost
0 until the owner sets it; their 10 MK AlterCPA offers were mapped the same night (see
[ALTERCPA-BRIDGE.md](ALTERCPA-BRIDGE.md)).

## 2. From a sold line to a catalogue product — `product_aliases`

Order lines arrive with free-text names from four worlds (CRM order items, collabBox documents,
the web shop, AlterCPA offers). They are folded, never guessed:

- **`product_aliases`** (20260940000000): PK `(source, alias_norm)`; `source` ∈ `crm` ·
  `collabbox` · `web` · `altercpa` · `mex` · `any` (`any` = the fallback for every source);
  `product_id`; `kind` ∈ `product` · `gift` · `loyalty_point` · `delivery` · `note` · `flyer`;
  `reviewed_by` / `reviewed_at`; `note`. Owners read, service role writes.
- **`product_alias_norm(name)`** — lower case, trimmed, inner whitespace collapsed. Deliberately
  NOT lossy: "2+1" and pack sizes stay apart; spelling variants are folded by alias rows.
- **`product_key(…)`** — a line's product: its `product_id`, else an alias, else `n:<name>`; the
  Insights functions then fold an `n:<name>` onto the one catalogue product whose normalised name
  is exactly the line's.
  **`order_line_kind(…)`** — is it a package at all: an alias kind decides (else `product`); the
  Insights functions also recognise the obvious non-products by name (`поен…` loyalty points,
  `достав…` delivery charge, `забелешк…` notes, `флаер…` flyers) — they are NOT packages.
- ⚠️ `product_key()` / `order_line_kind()` do **not** filter on `reviewed_by`: an applied alias
  counts in every Insights figure at once. **All 1.744 aliases are unreviewed on 29.09** (note
  "AUTO … чека одобрување") — they were applied after the owner saw the dry-run files.
- The collabBox sync maps document lines the same way (`product_aliases` source `collabbox`, then
  `any`, then `products.sku`); unmapped lines keep their name and are listed on the run.

### The catalogue completion of 28.09

| Run | What it did |
|---|---|
| `scripts/import-catalogue-products.mjs` run `01d83713` | 170 aliases (exact names → source `any`; strong matches → one row per source); ПОЕН / ДОСТАВА / ЗАБЕЛЕШКА / флаер / gift kind rows |
| `scripts/complete-catalogue.mjs` run `324615d4` | **325 new products** (34 active = sold in the last 60 days, 291 history-only inactive), **139 activations / fills** (45 inactive sold products activated; 94 active ones given a price and the placeholder stock), **479 aliases**; 32 spelling groups linked to existing products; **16 unsure groups left for the owner**; 42 non-products excluded |

New products take the typical sale price (median денари per unit of the last 90 days ÷ 61,5, or of
the last 20 priced lines), cost 0. Both scripts have `--rollback --run <id>` (removes the run's
still-unreviewed aliases and the products nothing references). Result: sold value resolving to a
catalogue product — **history 99,9 %, 2026 100 %**.

**Known issues (open with the owner):**
- **~53 older aliases map a name to a product of a different pack size** — about 3,3 M ден of
  sales, e.g. "ТЕЧЕН КОЛАГЕН 0,5 Л" → the 250 мл product. Product and margin figures per pack size
  are wrong for those lines until the aliases are corrected.
- **16 unsure spelling groups** wait for the owner; they stay `n:<name>` in reports.

## 3. Stock

Stock on hand is the **placeholder 1.000** on sellable products until the owner's stock count
(owner, 29.09: stock is not a focus now — keep it working, add no detail). The mechanism (and the
rules inherited from Bulgaria) is in `.grok/skills/elyon-stock-and-bigarena`.

## 4. Warehouse — `/warehouse`

[../src/pages/WarehousePage.tsx](../src/pages/WarehousePage.tsx), tabs: **Packing** (За пакување),
**Inventory**, **Movements**, **Попис** (the stock count) and **History**.

- **Packing is a sub-state of `confirmed`** (`orders.packed_at` / `packed_by` / `packed_by_name`) —
  there is no enum value for it. `shipped` normally comes from MEX (`mex-reconcile` moves an order
  to shipped once its parcel is registered); MEX alone decides paid and returned.
- The `warehouse` role packs, sees inventory / movements / history and can restock
  (`POST /api/restock`, logged in `inventory_logs`).
- **collabBox teleshop, social and LEADS-OUT are packed in collabBox**, outside the CRM: the
  collabBox sync creates their orders only once the MEX parcel exists, so they never enter the CRM
  Packing queue (`.grok/skills/elyon-collabbox-sync`).

## 5. Fulfilment — the MEX Import CSV

The /orders export is **MEX Poshta's own 8-column portal import template** (`Kod na pratka, Ime,
Adresa, Grad, Telefon, Otkup, Opis, Tezina`): Latin transliteration, integer денари COD, comma,
no BOM, no quoted fields. Single source: `src/lib/mexImportCsv.ts`; the contract and its traps:
`.grok/skills/elyon-fulfilment-csv`. A direct MEX `add_shipment` push is designed but dark.

## 6. Courier and addresses

- **MEX Poshta only**, two accounts: **BIO NATURAL** (the Elyon business — series 9110 LEADS,
  9103 LEADS-OUT; 17.995 parcels on 29.09) and **NATURA** (teleshop 9100 / 9102, social 9108 /
  1300, the web shop `NTMK…` / `M…`; 42.858 parcels). `mex-reconcile` reads both every 15 minutes,
  06:00–22:59 Skopje. The DocNumber of a collabBox document is its parcel's tracking id.
- Rate card (`courier_rates`, row `mex`): **150 ден per delivered parcel, 0 per return** (whether MEX
  bills returns is an open owner question) — `.grok/skills/elyon-logistics-costs`.
- Addresses: `mk_settlements` (OpenStreetMap, ODbL) · `mk_streets` · `mex_cities` (MEX's delivery
  zones) + `mex_city_aliases`; post codes and municipalities are derived, not authoritative.
  Scripts: `import-mk-settlements.mjs`, `import-mk-streets-osm.mjs`, `fetch-mex-cities.mjs`,
  `map-settlements-to-mex.mjs`, `enrich-mk-postal-codes.mjs`.
- **Dead in Macedonia:** `bg_settlements` (0 rows), the Speedy / Econt `courier_offices` cache and
  its scrapers, the BigArena stock-sync upload (not ported — see the comment in `WarehousePage.tsx`),
  the Bulgarian Daily Fulfilment CSV and the BG SKU-vs-barcode rules.

## 7. Quick reference

```bash
node scripts/assert-mk-target.mjs                                   # before any write
node scripts/import-catalogue-products.mjs                          # dry run → run id
node scripts/complete-catalogue.mjs [--include-active]              # dry run → run id
node scripts/complete-catalogue.mjs --apply --run <id> --actor mile@elyon.com
node scripts/complete-catalogue.mjs --rollback --run <id> [--apply]
node scripts/reprice-catalogue-mk.mjs --plan                        # re-price in EUR, never the peg (read-only plan)
node scripts/reprice-catalogue-mk.mjs --map prices.json [--commit]  # денари shelf prices → EUR; writes only with --commit
```
