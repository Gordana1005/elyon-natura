# VAT rate per product — from Sigma (01.10.2026)

**Rule:** every product carries the VAT rate that Natura's own books (Sigma ERP) charge for it.
Food supplements and foods = **5 %**, cosmetics / gels / creams / oils / devices / chia drinks = **18 %**
(rates exactly as Sigma has them). This replaces the flat 18 % the MK CRM used since 28.09.2026.

## Evidence (read-only Sigma export, 29–30.09.2026 — `_salesforce-plan/05-sigma-export/raw-export/`)
- `Item.csv` — the item master. Every item has `VatId`: 0 = 0 %, 1 = 18 %, 2 = 5 %, 3 = 10 %.
- `WorkDocInLine.csv` — every invoice line with the VAT actually charged (`VatID`, `VatValue`).
  For the 73 items behind the September web sales: 2026 sales-invoice lines (ПН1) = **7,124 at 5 %, 158 at 18 %**
  (only cosmetics), 4 at 0 % — including the 12 МЕКС ПОШТА COD invoices.
  Example: MAGNESIUM BISGLYCINATE on the July 2026 MEX invoice: 476.19 net + 23.81 VAT (5 %) = 500.00.

## Files (`data/`)
| File | What |
|---|---|
| `sigma_items_vat.csv` | every Sigma finished-goods / trade / loyalty item: VatId, rate, 2025–26 invoice lines by rate |
| `crm_products_vat.json/.csv` | all 706 MK CRM products: `vat_rate`, `vat_source`, `sigma_code`, `sigma_name`, `sigma_vat_id`, `evidence` |
| `t2_products_vat.json/.csv` | all 187 naturatherapy.mk (storefront tenant 2) products, same columns |
| `review.csv` | products with sales whose rate came from a name or a rule, not a Sigma link — for a human |
| `summary.json` | counts by source and rate |

## How each product got its rate (`vat_source`)
1. `sigma:crosswalk-VERIFIED|HIGH|MEDIUM` — linked in the S2 product crosswalk to a Sigma item; rate = that item's `VatId`.
2. `sigma:manual` — the crosswalk link was wrong and was corrected by hand (01.10.2026), e.g. ELIXY Vitamin C serum
   was linked to vitamin C tablets.
3. `sigma:by-name` — no crosswalk link; the product's name names a Sigma item (the EARLIEST product named wins, i.e. a
   bundle takes its main product's rate). `+mixed` = the name also names products of the other rate (e.g. a supplement
   bundle with a cosmetic gift) — the bundle keeps the main product's rate.
4. `rule:cosmetic-18` / `rule:device-18` / `rule:supplement-5` — no Sigma item at all; decided by the product type.

Rebuild: `python build_vat_table.py` (needs the Sigma export; refresh `data/crm_products.json` and
`data/t2_products.json` from the two databases first).

**Open for the accountant (not a data question):** whether 5 % is legally right for food supplements (the books
apply it all of 2025–2026), and that the monthly МЕКС ПОШТА COD invoices value boxes at a few FIXED price tiers incl. VAT (mostly 495 / 295 / 195 / 100 / 60 ден; АД Астра's 004 series 500 / 600 / 900 / 1.000 / 1.200 ден), not at what each customer paid, and gift boxes are invoiced too; АД Астра's 004 invoices carried 0 % before its VAT registration (mid-2026). Full list of Sigma's VAT problems: `Сигма_ДДВ_неправилности_2026-10-01.xlsx` (rebuild: `python sigma_vat_anomalies.py`).
