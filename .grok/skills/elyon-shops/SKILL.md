---
name: elyon-shops
description: The 22 retail shops (Продавници) of НАТУРА ТЕРАПИ СТОРЕС ДООЕЛ in the Macedonian Elyon CRM (owner 02.10.2026) — the collabbox-shops Edge Function (read-only against collabBox, its OWN allow-list, one run at a time, never alongside collabbox-sync, the request budget), its schedule (receipts every 15 min, goods documents hourly, the 23:30 stock snapshot + daily controls, the night backfill from 01.01.2026), the switch app_settings.shops_reader, the tables and writers (migrations 20260946000100–0400), the document types and what must never be added up (10018 + 10022, 10016 + 10042), loyalty ПОЕН lines, trade-book corrections, the 10005 count-difference sign (plus = shortage), VAT and cost rules, Natura's side (Sigma client 000001, the TV re-invoicing apart), the /shops page and its money access (owners everything, managers no money, everyone else 403), and the checker verify-shops. Read before touching supabase/functions/collabbox-shops, shop_* / shops_* tables or functions, GET /api/shops/*, src/components/shops, or anything that reports shop sales or shop stock.
---

# Shops (Продавници) — the collabBox shops reader (MACEDONIA)

> Owner, 02.10.2026: how much money the 22 shops make — more often than their own reports; how many products Natura
> gives them and where that is recorded; how much stock each shop holds at any moment. All in one place, connected
> with Stock v2. "Да, почни веднаш."

- Contract: **`docs/SHOPS.md`** (facts of the 01.10 probe, the request shapes, the reports). JSON: `src/lib/shopsTypes.ts`.
- Migrations (applied 02.10): `20260946000100` tables + writers · `0200` reports · `0300` switch + cron · `0400` top
  sellers = shelf goods only.
- Edge function `supabase/functions/collabbox-shops/` — `index.ts` (modes, runs, writers), `client.ts` (the read-only
  transport), `shops.ts` (pure: types, request bodies, `isAllowed`, parsers; `shops.test.ts` + `fixtures/`).
  `supabase/config.toml` `[functions.collabbox-shops] verify_jwt = false` (pg_cron sends no JWT; the secret header is
  checked in code).
- api `supabase/functions/api/shops.ts` (+ `shops.test.ts`); UI `src/pages/ShopsPage.tsx`, `src/components/shops/*`,
  `src/lib/shopsApi.ts`, i18n `shops.*` (mk / en / sq / bg).
- It is a SEPARATE reader from `collabbox-sync` (the teleshop documents → orders, `elyon-collabbox-sync`): same server,
  same login, same secret — different allow-list, tables and crons. It never makes an order.

## State on 02.10.2026

`app_settings.shops_reader.enabled = true` (audited `settings.shops_reader.enabled`, 02.10 01:31 Skopje),
`backfill.enabled = true`; 22 active shops; the first manual run: 463 receipt lines of 01.10, 187 goods documents,
one stock take per shop.

## 1. The shops and collabBox

- The shops belong to **НАТУРА ТЕРАПИ СТОРЕС ДООЕЛ** (Stores); collabBox is their till system. Each shop is a collabBox
  warehouse `003…029` (`shops.code`, internal `collabbox_magid`); `001 Централен` receives Natura's goods and passes
  them on; `002` is the call centre, `014` damaged goods. Sigma knows each shop as client **`000001`** + a delivery
  object (`shops.sigma_object`).
- Natura DOO (Sigma Ф00001-04) SELLS the goods to Stores. The shops' purchase cost = Natura's invoice price.

## 2. The reader — `collabbox-shops` (read-only, its own allow-list)

- **Only these request shapes** (`shops.ts isAllowed()`, checked before every send): login · the report forms
  (display) · `searchdoc` (document headers, types within the read list) · `repbydocitm` (document lines, all shops or
  ONE shop) · `infollc` (stock of ONE shop, `mode=doListOptions`) · `lnp` (period opening / in / out / closing of ONE
  shop) · `tkreport` (the trade book, cash / card, `cmbMagacin=-1`, `sum_by_warehouse=ON`).
  **Never:** an export, `submitCombo`, a saved search, `addcustom` / `deletecustom`, labels or the basket, the notepad,
  `ltd`, `mp`, `plrwc`, any field that saves / deletes. Never widen the allow-list.
- Strictly sequential, **≥ 1,5 s between requests** (1,6 s used), a hard cap per run, one re-login on the login page,
  session ids redacted, credentials never logged. **One run at a time** (`shops_reader_runs` `running` → 409; a row
  older than 20 min is closed as abandoned) and **never while a `collabbox-sync` run is running** (the same login).
- Secrets: `COLLABBOX_USER` / `COLLABBOX_PASS` (VAULT §7) and the header `x-collabbox-sync-secret` =
  `COLLABBOX_SYNC_SECRET` — the same values `collabbox-sync` uses, nothing new; the DB Vault row
  `collabbox_sync_secret` feeds `invoke_collabbox_shops(mode)`.

### Schedule (pg_cron UTC, Skopje gates — DST-proof; off the collabbox-sync minutes)

| Job | UTC | Skopje | Reads | Requests |
|---|---|---|---|---|
| `collabbox-shops-sales` | `5,20,35,50 4-22 * * *` | 07:05 … 23:50, every 15 min | today's **10022** receipts + **10010** retail returns of every shop (before 07:30 also yesterday) | ≤ 6 |
| `collabbox-shops-docs` | `25 4-22 * * *` | 07:25 … 23:25, hourly | goods documents of yesterday + today: one searchdoc (with Natura's invoice numbers) + one lines request | ≤ 8 |
| `collabbox-shops-nightly` | `30 21,22 * * *` | 23:30 | receipts once more · **infollc stock of every active shop** · the **10018** daily reports + the trade book · averages · prune (snapshots kept 62 days) | ≤ 40 |
| `collabbox-shops-backfill` | `0,30 22,23,0-4 * * *` | 00:30 … 05:30, every 30 min | yesterday closed, then history oldest first: receipt days from 01.01.2026, 10018 months, goods weeks from 01.01.2026, `lnp` per shop and month from 2025-01 — resumable (`shops_backfill_log`) | ≤ `backfill.max_requests` 60 (hard max 120) |

Daily ≈ 390 requests. A run answers 202 at once and works in the background; truth = `shops_reader_runs`. Manual:
`{mode:'manual', from, to (≤ 7 days), parts, shops?, dry_run?, wait?}` (≤ 40 requests). `scripts/shops/backfill-shops.mjs`
shows the backfill plan (read-only) and `--apply` runs chunks through the function — only 21:00–06:30 Skopje
(`--any-hour` overrides; never into 07:00, the collabbox-sync rule).

### The switch — `app_settings.shops_reader` (an OWNER key)

`{"enabled", "sales", "docs", "nightly", "snapshot_keep_days": 62, "backfill": {"enabled", "sales_from", "docs_from",
"lnp_from", "max_requests", "sales_days_per_run", "lnp_per_run"}}` — guarded by `tg_app_settings_guard_owner_keys`.
Off = every cron tick is a silent no-op (the SQL invoker checks it, the function again). Pause: switch off, or
`select cron.unschedule(jobid) from cron.job where jobname like 'collabbox-shops-%'`.

## 3. Document types — what is read, and what is NEVER added up

| Type | Name | Role |
|---|---|---|
| **10022** | Фискална Сметка | THE sales (`NNN-4101/<seq>-YYYY`, NNN = the shop) |
| 10010 | Повратница од малопродажба | retail returns — subtracted from sales |
| **10018** | Дневен Финансиски Извештај | the daily CONTROL of the receipts — **never added to 10022** |
| **10042** | Влезна Фактура | Natura's invoice into 001 Централен (Natura's own number = the Sigma join key) |
| 10016 | Приемница | the TWIN of 10042 — **never read, never added to 10042** |
| 10014 | Приемен лист во трговија | 001 → shop, signed (+ into the shop, − back to 001) |
| 10015 / 10061 | Препратница / меѓу продавници | transfers |
| 10044 | Повратница до добавувач | returns to Natura |
| 10040 | Налог за производство | bundle assembly at the till |
| 10062 | Записник за оштетена роба | damaged goods |
| 10011 / **10005** | Пописна Листа / Лагер-попис разлика | the count LIST (moves nothing) / the count DIFFERENCE (moves stock) |
| 10008 · 10009 · 10066 · 10081–10113 | Нивелација (price only) · discount approval · retail turnover summary · orders | **never** goods or sales |

## 4. The rules every reader of the shop tables follows

- **Loyalty `ПОЕН-*` lines** are kept and flagged (`is_point`): never units, never sales, never product stock (the
  controls include them — the till does).
- **A trade-book correction is never goods:** a goods line with a near-zero cost and a huge price (e.g. 1 × ПОЕН-350 at
  −6.883.979 ден after a count) is `is_correction` — never units / stock / goods value; `shops_health` lists it as
  anomaly `book_correction`.
- **10005 count difference: a POSITIVE value is a SHORTAGE (stock down), a negative one a SURPLUS** —
  `shops_doc_delta()` signs it by the value, whatever column collabBox put the quantity in. 10011 never moves stock.
- **Top sellers = shelf goods only** (`…0400`): Sigma article codes (`00xxxx`) whose name is not a bundle pattern —
  never ПОЕН, the paper bag, or bundles the till assembles at the moment of sale (10040); the first live read flagged
  "11 of 20 top sellers out of stock" in every shop because of them.
- **Values are as collabBox shows them: WITH VAT** (cost and sale). Ex VAT = each line ÷ (1 + its article's VAT): the
  line's own → `shop_articles` (nightly infollc) → `products.vat_rate` by sku → 5 % (counted in
  `quality.vat_unclassified_units`, never silent).
- **Shop cost** = collabBox's booked cost = Natura's invoice price; a unit cost > 3 × the chain's median for that
  article and month is capped at the median (bundles assembled in the shop break the average) —
  `quality.cost_capped_lines`.
- **Group cost** = Natura's own Sigma `CalcBuyPrice` of the units sold (`article_cost_at()` from Stock v2, a kit = its
  components) at the sale day; **NULL while any unit has no cost — never invented** (`quality.group_cost_missing_units`).
- **Stock at a moment** = `shops_stock_at()`: the latest nightly take ≤ the moment + the receipt and goods lines after
  it (`stock_basis` "snapshot 01.10 23:30 + N movements"); no take before the moment = unknown.
- **Natura's side** (`shops_period.natura`, `shops_deliveries`): Stock v2's Sigma staging (client `000001`, object =
  the shop, basis `sigma`) when it holds documents, else Stores' own 10042 in / 10044 back (basis `collabbox`). A
  delivery is "in transit" until its 10042 arrives. The money of a delivery is the received 10042's lines ex VAT.
- **Economics (owner context, 02.10):** Natura's own margin on goods sold to the shops is ≈ 30 % (Sigma price list 07);
  the shops buy at roughly 12–20 % of the shelf price. Natura's **TV re-invoicing to Stores (≈ 1,6 М ден a month)** is
  shown apart (`ads_reinvoiced_ex_vat_mkd`, NULL while it is not in the Sigma staging) — never as goods.
- **No customer data:** a retail line's customer is always "Непознат Купувач"; a receipt with a named komitent is only
  COUNTED (`named_customer_receipts`), never stored. Cashiers are staff and are kept.
- Days are Skopje days; a live day ends now.

## 5. Tables and writers (RLS deny-all, service_role only; `supabase_read_only_user` may SELECT)

`shops` · `shop_articles` · `shop_sales_lines` (PK doc_number, line_no) · `shop_docs` / `shop_doc_lines` · `shop_stock_takes`
/ `shop_stock_snapshots` · `shop_stock_periods` (lnp) · `shop_day_controls` · `shops_reader_runs` · `shops_backfill_log`.
Writers (SECURITY DEFINER, idempotent — a document's lines are replaced as a whole): `shops_ingest_sales`,
`shops_ingest_docs`, `shops_ingest_stock`, `shops_ingest_controls`, `shops_articles_refresh_averages`,
`shops_snapshots_prune`. Rollback: drop the tables and `shops_*` functions — nothing else depends on them.

## 6. Reports, routes and money access

| Route | SQL | Response |
|---|---|---|
| `GET /api/shops/day?day=` | `shops_day` | `ShopsDay` (live today; `vs_avg_pct` vs the same weekday of 4 weeks) |
| `GET /api/shops/period?from&to` | `shops_period` | `ShopsPeriod` (+ what Natura invoiced the shops) |
| `GET /api/shops/:code?from&to&at` | `shop_detail` | `ShopDetail` (404 unknown shop) |
| `GET /api/shops/stock-matrix?at&q&brand` | `shops_stock_matrix` | `ShopsStockMatrix` |
| `GET /api/shops/deliveries?from&to&shop` | `shops_deliveries` | `ShopsDeliveries` |
| `GET /api/shops/health` | `shops_health` | `ShopsHealth` (anomalies: `no_receipts_by_11`, `cost_above_sales`, `big_transfer`, `big_return`, `zero_top_seller`, `delivery_not_received`, `control_mismatch`, `book_correction`) |

- **Owners (`is_business_owner()`) get everything. Managers (and a non-owner admin) get the SAME payload with every
  `*_mkd` key ABSENT** — the SQL leaves them out (`p_money = false`, `shops_strip_money`) and the api's
  `stripShopsMoney()` removes any left, at any depth. **Everyone else: 403.** For owners a money key is a number, or
  `null` when UNKNOWN — never 0 for unknown. The anomaly `detail` text never carries money.
- **/shops "Продавници"** (menu; Insights style; cards below md; tabs Денес / Период · Продавници · Продавница · Залиха
  низ продавници · Испорачано од Натура · Здравје); money renders only when its key is present; the freshness line
  "сметки пред N мин · залиха од 23:30".

## 7. Checks

`node scripts/shops/verify-shops.mjs [--days=30] [--json]` — READ-ONLY, pinned to MK: H1 receipts == the 10018 report
and the trade book · H2 the stock chain (take + lines = next take) · H3 every Sigma invoice to 000001 received as a 10042
with Natura's number · H4 no money for managers · H5 never added up (no 10018 / 10016 / 10066 / 10008 among sales or
goods; ПОЕН flagged; corrections listed) · H6 no customer data · H7 freshness while on (receipts < 35 min, goods < 75
min, stock < 26 h). Plus `npm test` (`collabbox-shops/shops.test.ts`, `api/shops.test.ts`,
`src/components/shops/*.test.ts`).

## Never

- Widen the allow-list, write anything to collabBox, run two readers at once or alongside `collabbox-sync`, or start a
  manual backfill that runs into 07:00.
- **Add 10018 to 10022, or 10016 to 10042** (each is the other's control / twin); count 10011 as a movement; count
  10008 / 10009 / 10066 / orders as goods.
- Count ПОЕН lines or trade-book corrections as goods, units, sales or stock.
- Read a positive 10005 value as a surplus.
- Show a `*_mkd` key to a non-owner, or fill an unknown amount with 0.
- Invent a group cost — NULL until Stock v2's Sigma costs cover every unit.
- Store a retail customer's name, or switch `shops_reader` without an owner (it is an owner key).
- Quote the warehouse-08 investigation's numbers in the repo — that report is INTERNAL (`exports/magacin/`, gitignored).

## Companion skills

`elyon-collabbox-sync` (the other collabBox reader) · `elyon-stock-v2` (Sigma staging, `article_cost_at`) ·
`elyon-security` (money strip, owner keys) · `elyon-logistics-costs` (VAT per product).
