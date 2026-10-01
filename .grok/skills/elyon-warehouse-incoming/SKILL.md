---
name: elyon-warehouse-incoming
description: Use for anything on /warehouse (Магацин) in the Macedonian Elyon CRM — rebuilt 01.10.2026 (plan Фаза 9, Insights style) and on Stock v2 since 01–02.10 into the tabs Испрати до MEX · За пакување · Залихи · Пратки · Движења · Попис (the last four read Stock v2 — the preview banner while it is off, who sees quantities / money / counts / the switch). Covers the warehouse queue (warehouse_queue send / pack / pack_stale, one call for the tiles), the manual "Испрати до MEX" push (switched OFF until the owner; mex_push_attempts, the MEX push settings card), the MEX 8 = за пакување semantics (reconcile never ships at 8, the collabBox writer, the Overview's "packed", the not-applied repair of ~260 orders), no printing (the MEX portal does it), the server guards on the old incoming-orders routes, and stock safety. Read before touching WarehousePage, src/components/warehouse/*, warehouseQueue.ts, the warehouse routes, or anything that decides when an order counts as packed or shipped.
---

# Warehouse (Магацин) — MACEDONIA, since 01.10.2026

Owner, 30.09.2026: Магацин must be simpler and work like the naturatherapy.mk shop. "За пакување"
stays; the warehouse ticks confirmed orders and presses **"Испрати до MEX"** — MANUALLY (the 11:00
auto-send is built, not scheduled). **MEX status 8 = за пакување**; the courier taking the parcel
(4 / 10 / 9 / 1 / 3) makes the order shipped. **No printing and no packing list** — labels come
from the MEX portal.

`src/pages/WarehousePage.tsx` (Insights style; tabs deep-link with `?tab=send|pack|stock|parcels|movements|count`;
`day` and `wh` follow the reader across tabs) + `src/components/warehouse/*` (queue tabs) +
`src/components/warehouse/v2/*` (Stock v2 tabs) + `src/lib/warehouseApi.ts` / `src/lib/stockV2Api.ts`.

## The page, top to bottom

- **Tiles** (`WarehouseKpis`) from ONE call — `GET /api/warehouse/queue?tab=send&limit=1` returns
  every count: Испрати до MEX · За пакување · Чекаат > 3 дена · Активни производи (+ low stock).
  The old 13 s / 5,5 MB download of 22k orders to count 514 is gone.
- **Испрати до MEX** (`SendTab`; admin / manager / warehouse): confirmed orders with no parcel —
  never a web order, never a test phone. Department chips, oldest / newest, table from xl and
  cards below, the value for owners only. Per row: the validation badges (the CSV gate), the
  suggested MEX profile with its reasons (from the products' brand lines), double-parcel and
  10-day-rule warnings. Select → a dialog: **dry run first**, a "MEX нема откажување"
  confirmation, a chunked send, per-order results. **While `app_settings.mex_push` is off the
  send button is disabled with an explanation**; the /orders MEX Import CSV stays the way to ship.
  The full contract (body, claim, existence check, ledger, guards, account): `elyon-fulfilment-csv`.
- **За пакување** (`PackTab`; admin / manager / warehouse): parcels at **MEX 8** from BOTH accounts
  — CRM pushes, collabBox bookings and MEX-only parcels alike — grouped by Skopje day with their
  age; older than 14 days behind a "stale" chip. Read-only: the warehouse works it together with
  the MEX portal, where the labels are printed.
- **The four Stock v2 tabs (owner 01.10.2026; `elyon-stock-v2` is the law, `docs/STOCK-V2.md` the contract).**
  Every figure is per Sigma ARTICLE and warehouse (picker = the tracked warehouses from `GET stock/v2/health`),
  on a Skopje day, with a freshness line (пратки · Сигма · пресметано). **While `stock_v2.enabled` is false the
  tabs read the computed preview (`preview=1`) under the banner "Преглед — пресметано од пратките, ништо не е
  запишано"** — nothing is written until the owner approves the opening and switches it on.
  - **Залихи** (`StockDayTab`, + `ArticleDrawer`): per article opening · out · back · in · other out · adjust ·
    closing, to pack / with the courier / reserved / available (= closing − reserved), days of cover, negatives;
    cost and value for owners only. The drawer = the article's day series and its moves.
  - **Пратки** (`ParcelsDayTab`): the day's parcels as stock sees them — by account, department, status, city /
    zone, hourly created vs picked up (`mex_parcels.picked_up_at`), units and gift units, each parcel's state and
    lines source (override / collabBox / web / CRM); never a receiver name or phone; COD for owners only.
  - **Движења** (`MovementsV2Tab`): the ledger (`stock_v2_movements`) — filters warehouse / article / kind / source /
    text / corrections, the late days (recorded − event), Sigma documents with their version count, the running
    balance when one article and one warehouse are filtered.
  - **Попис** (`CountV2Tab`, + `StockV2HealthCard` for owners / admins): a count (dry preview first: system vs
    counted, warnings / refusal codes `stock2.count.warn.*`), the count history (`GET stock/v2/counts`, value
    difference for owners), pending counts an owner approves, and the health card — the switch (owners, with a
    confirm), a dry run, the queues (unmapped, no lines, stale labels), recipe coverage, Sigma freshness.
  - Access (`useStockAccess`): quantities = owners · admin · manager · warehouse; counting = owners · admin ·
    warehouse (a non-owner's count is `pending`); money, configuration, the switch = owners only.
  - The low-stock threshold (`products.low_stock_threshold`) is edited in the product form; the tiles still count
    active products under it.
- **MEX праќање card** (`MexPushSettingsCard`, admins): the global switch + one per account
  (BIO NATURAL / NATURA), with a confirm; `PATCH /api/warehouse/mex-push/settings`, audited
  `mex.push_settings`. Do not switch it on without the owner.
- **Removed 01.10:** the old tabs Packing / Inventory / Movements / Count / History became the tabs
  above (the v1 `StockTab` / `StockCountTab` / `MovementsTab` were replaced by the v2 tabs on 02.10) — Историја is gone (it duplicated /orders and loaded 3.019 rows at once), and so are the
  any-status dropdown (it allowed even "paid" and bypassed the rules), Delete, "Mark shipped" and
  the English CSV export. The Delayed / Shipment Calendar views of the BG-era skill no longer exist.

## The queue — `warehouse_queue(tab, departments, order, limit, offset)` (`20260943001200`)

One SQL call for the list and every count (service role; `supabase/functions/api/warehouseQueue.ts`
parses the query, enriches rows and strips money for non-owners):

| tab | rows |
|---|---|
| `send` | `warehouse_send_base()`: status confirmed, no `mex_tracking_id`, not a web order, not a test phone |
| `pack` | `warehouse_pack_base()`: a parcel at MEX 8, either account, ≤ 14 days old (collabBox-booked and MEX-only included) |
| `pack_stale` | the same, older than 14 days |

`warehouse_order_facts(ids)` is the one shape of an order that both the queue and the push read.

## MEX 8 = за пакување (owner 30.09; live 01.10)

| MEX status | The order |
|---|---|
| 8 "Shipment created" | stays **confirmed** — за пакување; only `orders.mex_sent_at` is stamped (if NULL) |
| 4 / 10 / 9 / 1 / 3 (and any other id) | **shipped** |
| 2 | **paid** |
| 7 | **returned** |

- **mex-reconcile** (`supabase/functions/mex-reconcile/match.ts` `targetFor` / `atMexGate`,
  `db69801`): a parcel at 8 changes NO status. A confirmed order gets `mex_sent_at`; an order
  already `shipped` stays shipped (the backlog is the repair's); a pending / take / call_again
  order or a rule-C cancel WAITS for the pickup (`wait_pickup`) — confirming it at 8 would stamp
  `sold_at` "now" for the old agent.
- **The collabBox writer** (`collabbox_apply_one`, `20260943001210`): a folder document whose
  parcel is at 8 becomes a **confirmed** order with `shipped_at` NULL and `mex_sent_at` = the
  parcel's creation at MEX (ledger reason `parcel_to_pack`); 4/10/9/1/3 → shipped, 2 → paid,
  7 → returned, no parcel → confirmed, all unchanged.
- **The Overview funnel** (`20260943001220` + the `overview.ts` twins): "Спакувано" (`packed`) =
  a confirmed or shipped order holding a parcel at MEX 8 — the cohort's `label` bucket; `preparing`
  = confirmed with no parcel at 8; `courier` = shipped, parcel not at 8. It no longer reads
  `orders.packed_at` (a click nobody ever used — 0 packed orders). Money does not move: the cohort
  was already MEX-first.
- **Repair NOT applied — waits for the owner's OK:** `scripts/repair-shipped-at-mex8.mjs` moves the
  ~260 orders still `shipped` while their parcel sits at MEX 8 back to confirmed (`shipped_at`
  NULL, `mex_sent_at` from the parcel, one history row + one note each; no stock or money moves).
  `--preview` (writes nothing) → dry run (CSV + a `data_repair_runs` row) → `--apply --run <id>`
  in the quiet window → `--rollback <id>`. Until then the Overview already counts them as packed.

## Server guards on the old routes (Phase 0, `47620bd`)

The `GET /api/warehouse/incoming-orders` handler still exists (the new page does not call it).

- `PATCH /api/warehouse/incoming-orders/:id` **refuses any `status`** — 400
  `warehouse_status_disabled` ("MEX decides shipped / paid / returned"); a status changes only
  through `/orders/:id/status` with its rules. An address edit there re-resolves the MEX zone
  (`elyon-fulfilment-csv` §3).
- `DELETE /api/warehouse/incoming-orders/:id` is **admin-only** (403 `admin_only`) and writes
  `audit_log` `order.hard_delete` (`{via:'warehouse', order}`). ⚠ A `prediction_lead` source is
  deleted without the audit row.

## Stock safety

- **Stock v2 (`elyon-stock-v2`):** a MEX parcel moves stock at its label (`created_at_mex`), a MEX 7 return
  brings it back; an order status moves nothing — marking shipped / returned, the MEX 8 repair and the push move
  no stock. The status-driven deduction and the v1 count / MEX ledger are RETIRED (`20260945000700`) — never
  bring them back. `products.stock_quantity` is a guarded mirror of the ledger.
- Stock v2 runs in PREVIEW until the owner's 22.09 count sheet is loaded as the opening and he switches it on
  (Попис → the health card). Never switch it on, approve an opening or approve recipes without him.
- New goods are entered in Sigma (they reach Движења through the Sigma ingest), never typed in here:
  `POST /restock` answers 410.

## Never

- Re-add a status dropdown, "Mark shipped" or a hard delete to the page — MEX decides shipped /
  paid / returned.
- Treat MEX 8 as shipped anywhere (a new report, a new match path, a new writer).
- Build printing / labels / a packing slip in the CRM (the owner's call: the MEX portal does it).
- Switch on the push, schedule the 11:00 auto-send or apply the MEX 8 repair without the owner.
- Download all orders to count them — read the queue's counts.
- Re-add a restock button, a typed stock quantity or a status-driven deduction (Stock v2 owns stock), or show a
  stock cost / value / COD to a non-owner.

## Checks

`npm test` (`mexPush.test.ts`, `warehouseQueue.test.ts`, `MexPushDialog.test.tsx`, `warehouseText.test.ts`,
`stockV2.test.ts`, `src/components/warehouse/v2/__tests__/*` — `StockDayTab` / `ParcelsDayTab` / `MovementsV2Tab` /
`CountV2Tab` / `WarehousePage` / `stockV2Model`), `node scripts/verify-stock-v2.mjs --preview` (full once on),
`node scripts/verify-insights-ties.mjs` after any change to `packed`, Playwright at 360 / 390 /
768 / 1024 / 1280 / 1920 px (zero overflow) for UI changes.

## Companion skills

`elyon-fulfilment-csv` (the CSV + push contract) · `elyon-products-catalogue` (the line → MEX
profile) · `elyon-stock-v2` (stock — the law) · `elyon-stock-and-bigarena` (v1 history) ·
`elyon-departments-and-sources` (the department chips) · `elyon-collabbox-sync` (the at-8 writer).
