# Stock v2 — the Sigma side (workstream S)

The contract is [`docs/STOCK-V2.md`](../STOCK-V2.md). This folder builds everything Stock v2 needs from Sigma and
from the CRM's own evidence; the outputs go to the gitignored `exports/stock/` (business-confidential costs —
never committed).

| File | What |
|---|---|
| `crm_snapshot.mjs` | READ-ONLY CRM inputs → `exports/stock/crm-inputs.json` (products, collabBox lines with product + code, single-line orders vs their collabBox document, collabBox codes, web items). No customer data. |
| `build_sigma_stock.py` | The Sigma CSV export (+ the snapshot) → `articles.json`, `costs.json`, `openings.json`, `kits.json`, `recipes.json`, `sigma-batch-since-2209.json` (the contract files) and `aliases.json`, `local-articles.json`, `exempt.json`, `sigma-mex-invoices.json`, `review-*.json`, `summary.json`. Proves the sign rule against StockObject and the investigation's opening totals on every run. |
| `mapping_review_xlsx.py` | `exports/stock/Magacin-pregled-<date>.xlsx` — the owner's workbook (Macedonian): Резиме · Почетна состојба (with the empty count column) · Набавни цени · Производи→Артикли · collabBox шифри без артикл · Web производи · Пакети · Сигма документи од 22.09. |

```
node docs/stock/crm_snapshot.mjs                 # (or let the build call it: --refresh-crm)
python docs/stock/build_sigma_stock.py
python docs/stock/mapping_review_xlsx.py --date 2026-10-01
```

## The rules it applies

- **Sign rule** (also `tools/sigma-connector/sigma-fields.json`): an InventoryLine quantity is signed by Sigma; a
  transfer is −qty at the From object and +qty at the To object; InOut I… is +qty at the To object; O… is −qty at the
  From object. A document line is `{item_code, qty, side}`: `out` = the From object (effect −qty), `in` = the To object
  (effect +qty). Reproduces StockObject on 9,125 of 9,126 keys (Ф00001-04/001684 +10, a document posted after the
  StockObject file was cut).
- **Openings** (by document date, content as exported): `04_morning_2209` = documents ≤ 21.09 → **261,811** finished
  goods; `04_end_2209` = ≤ 22.09 → **229,571** (4 negatives, −47); `08_end_2209` = **131,145**; `04_plus_08_morning_2209`.
  A negative balance is not a count (left out, listed); `lines` carry only articles (АРТИКЛ, ТС, ЛОЈАЛИТИ).
- **Costs** (MKD excl. VAT, Ф00001 only — BioNatural at production cost, never АД Астра's price): 04 CalcBuyPrice
  quantity-weighted over the WYear buckets in stock → single bucket → median BuyPrice of the 2026 sales lines out of 04
  → a priced bucket with no stock → another Ф00001 object → none. Flags: `buckets_differ`, `cost_zero`, `no_stock_04`.
- **Kits**: ММ2 at Ф00001-04 (output = ProductionFlag 2, components = the negative lines), the most frequent whole
  assembly (the last one when they agree). ММ2 also re-labels / re-packs — those are not kits.
- **Recipes**: per CRM product, every candidate article is scored on collabBox lines that carry both the product and
  the code, single-line orders vs what their collabBox document packed, the sku, the VAT Sigma link and the S2
  crosswalk; a size in the name that disagrees blocks `high`. Bundles: the packed lines → the Sigma set the product
  ships as → the name ("2+1 X + Y", "+ подарок Z" — a gift only when the name says so) → the Sigma kit.
  Only `high` is approved by `mapping-apply`.
- **Aliases**: collabBox codes that are not a Sigma article (bundle codes like `600010 2+1 ПРОСТАТОЛ + ЦИНК`, a code
  Sigma uses for something else like `001685` OPTICARE ≠ BENZOKAIN → local article `L00001`), collabBox markers / notes
  (`not_stock`), Dr Becker names, web products (shop product id) and variant SKUs. Keys are normalised by
  `stock_v2_alias_key()`.

## Loading (the lead; dry by default, Macedonia only)

```
node scripts/stock/mapping-apply.mjs                      # every writer runs in one transaction, ROLLED BACK
node scripts/stock/mapping-apply.mjs --apply --actor <owner uuid>
node scripts/stock/opening-apply.mjs --variant 04_morning_2209 [--with-articles]   # or --xlsx <owner's count sheet>
node scripts/stock/sigma-ingest-file.mjs [--direct [--apply] | --send]            # the CSV batch (needs 0650)
node scripts/stock/sigma-month-check.mjs [--month 2026-08]                        # read-only
```

The office connector (same batch shape, same field list) is `tools/sigma-connector/` — install guide in Macedonian:
`tools/sigma-connector/README-INSTALL.md`.
