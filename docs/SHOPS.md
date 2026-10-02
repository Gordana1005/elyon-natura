# Shops (Продавници) — contract

## The owner's request (02.10.2026)
The owner wants to know how much money the 22 shops make, and to see it more often than the shops' own reports. He wants to know how many products Natura gives them and where that is recorded, and how much stock each shop holds at any moment. All of it in one place, connected with Stock v2.

**Owner decisions:**
- Build it now.
- **Owners see everything. Managers see the same data with no money** (every `*_mkd` key is stripped, as `stripOverviewMoney` does).
- The anomalies of 29–30.09 go into the warehouse-08 forensic report: −5,44 M ден moved from the shops back to 001 Централен through 10014, and Сити Мол's cost was higher than its sales.

The plan is in `~/.claude/plans/revert-the-421-unproven-encapsulated-brook.md`, part 2. The JSON shapes are in `src/lib/shopsTypes.ts`.

## Facts (probe of 01.10, read-only)
- **Shops.** The shops belong to НАТУРА ТЕРАПИ СТОРЕС ДООЕЛ. collabBox is their till system. Each shop is a collabBox warehouse 003…029. The internal ids used in the `magid` / `rightMagIds` filters are 4 = 003 Карпош, 6–19 = 004–017, 37–46 = 020–029, 3 = 001 Централен, 5 = 002 Call Centar, 16 = 014 Оштетена роба. Sigma knows each shop as client `000001` plus a delivery object; the mapping is in the investigation tables.
- **Sales are type 10022 Фискална Сметка.** The number is `NNN-4101/<seq>-YYYY`, where NNN is the shop. Retail returns are 10010.
  - **Lines:** `POST Index?comp=repbydocitm` with the sync's shape plus `cmbProkaz=1`, `edinecnaCena=ON`, `prikaziMagVlez=on`, `prikaziMagIzlez=on`, `showWorkingUnit=ON`, `idArtikl=ON`, and an optional `magid=,4,`. It returns 21 columns, including date+time, out-warehouse, cashier, qty, unit cost, unit price, cost value and sale value. `casOd`/`casDo` give hour windows.
  - **Per-shop totals** in one request: the same report with `groupby=dokumenti.magizlez&onlySums=on`.
  - **Daily control:** 10018 Дневен Финансиски Извештај (one per shop per day; never add it to 10022), and `POST Index?comp=tkreport&action=submit`, `cmbMagacin=-1`, `sum_by_warehouse=ON`, which also gives cash and card.
- **Stock per shop.**
  - `POST Index?comp=infollc`, with `mode=doListOptions`, `results=1`, `searchMode=` empty, `rightMagIds=,<id>,` and `datumdo` = the "as of" date, gives per article: avg cost ex VAT, in, out, stock, reserved, available, value and retail price. It matches lnp exactly, needs about 5 s per shop, and covers the 19 article groups.
  - `POST Index?comp=lnp&act=search`, with `searchMode=none` and `delcustom=none`, gives opening / bought / sold / closing per period, covering every article, in about 30 s per shop and month. Its "sold" figure includes components used by 10040 bundle assembly.
- **Movements.**
  - Natura → Stores arrives in **001 Централен** as twin documents 10016 Приемница and 10042 Влезна Фактура; count only 10042. The searchdoc option `chkShowBrVlFaktura=chk` shows Natura's own invoice number (`04-01101`), hand-typed, which is the join key to Sigma.
  - 001 → shop is 10014 Приемен лист (signed: + into the shop, − back to 001).
  - Transfers are 10015 and 10061. Returns to Natura are 10044. Bundle assembly is 10040. Damaged goods are 10062. Counts are 10011 and 10005.
  - **Not stock:** 10008 Нивелација (price only), the orders 10081–10113 and 10009 Одобрение за попуст.
  - **Not a product:** loyalty `ПОЕН-*` lines.
- **The shops' purchase cost is Natura's invoice price** (85,71 ex VAT, for example), so shop margin and group margin can both be computed exactly.

## Reader: edge function `collabbox-shops` (read-only)
- It has its own strict allow-list, holding only the request shapes above plus login.
  - **Never:** an export, `submitCombo`, `mode=addcustom` / `deletecustom`, label or "basket" buttons, notepad, `ltd`, `mp` or `plrwc`.
  - It shares the collabBox session rule: one run at a time, through its own run lock.
  - It is scheduled off the collabbox-sync minutes.
- **Every 15 min, 07:00–23:00:** receipt and retail-return lines for today, all shops, in 1–2 requests, upserted idempotently by (doc, line).
- **Hourly:** a searchdoc and the line items for 10042, 10014, 10015, 10061, 10044, 10040, 10062, 10011, 10005 and 10010 over the last 2 days.
- **Nightly at 23:30:** an infollc snapshot per active shop (about 22 requests, ≥ 1.5 s apart), plus tkreport and the 10018 controls.
- **Backfill:** receipt lines day by day from 2026-01-01, and lnp per shop per month for 2025–2026. It runs at night in chunks and is resumable.
- **Switch:** `app_settings.shops_reader = {"enabled": false, "backfill": {...}}`. It is an owner key, and the lead enables it after review.

## Tables (migrations `20260946000100+`)
RLS deny-all, api only.
- `shops`: code PK, name, city, sigma_object, collabbox_magid, active.
- `shop_sales_lines`: doc_number, line_no, doc_type, shop_code, sold_at, article_code, article_name, qty, unit_cost_mkd, unit_price_mkd, cost_value_mkd, sale_value_mkd, cashier, is_return, read_at. PK (doc_number, line_no).
- `shop_docs` and `shop_doc_lines`: the goods, transfer, count and damaged documents, with natura_doc, signed qty and value.
- `shop_stock_snapshots`: taken_at, shop_code, article_code, qty, reserved, available, avg_cost_mkd, retail_price_mkd, value_mkd. PK (taken_at, shop_code, article_code).
- `shop_day_controls`: day, shop_code, receipts_total_mkd, report_total_mkd, cash_mkd, card_mkd, ok.
- `shops_reader_runs`.

## Reports (SQL) and routes
| Route | Response | Notes |
|---|---|---|
| GET `shops/day?day=` | `ShopsDay` | live when the day is today |
| GET `shops/period?from&to` | `ShopsPeriod` | includes Natura's Sigma invoicing to Stores in the period, from the Stock v2 Sigma staging (client 000001), with the TV re-invoicing shown apart |
| GET `shops/:code?from&to&at` | `ShopDetail` | stock at `at` = latest snapshot ≤ `at` + the lines and documents after it |
| GET `shops/stock-matrix?at&q&brand` | `ShopsStockMatrix` | |
| GET `shops/deliveries?from&to&shop` | `ShopsDeliveries` | Sigma invoice ↔ collabBox 10042 via the Natura doc number; in transit when not yet received |
| GET `shops/health` | `ShopsHealth` | |

**Access:**
- Owners get everything.
- Managers get everything with every `*_mkd` key removed.
- Everyone else gets `forbidden`.

Group cost = Natura's Sigma CalcBuyPrice for the article (`article_cost_at` from Stock v2). Until those costs are loaded, it falls back to `null`, never to an invented value.

## UI: `/shops` "Продавници" (menu, Insights style, every screen, mk/en/sq/bg, namespace `shops.*`)
Tabs:
- **Денес / Период**: the PeriodStepper, live today.
- **Продавници**: the ranking, as cards below `md`.
- **Продавница**: the detail view: stock now, sales by article, goods in/out, counts.
- **Залиха низ продавници**: the matrix.
- **Испорачано од Натура**.
- **Здравје**: freshness, controls, anomalies.

Money shows only when its key is present. The freshness line reads "сметки пред N мин · залиха од 23:30".

## Workstreams
| WS | Branch | Owns |
|---|---|---|
| SD (data + api) | `shops-data` | `supabase/functions/collabbox-shops/**`; migrations `20260946000100+`; `supabase/functions/api/shops.ts` (+ test) and its route block in `index.ts`; `scripts/shops/**` (backfill, verify-shops.mjs) |
| SU (ui) | `shops-ui` | `src/pages/ShopsPage.tsx`, `src/components/shops/**`, `src/lib/shopsApi.ts`, the menu entry and route, the `shops.*` i18n keys |

The lead applies migrations, deploys functions and enables the reader.
