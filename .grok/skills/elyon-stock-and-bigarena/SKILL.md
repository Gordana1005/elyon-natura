---
name: elyon-stock-and-bigarena
description: HISTORY of stock in the Elyon CRM — the retired v1 regimes (the status-driven deduction on shipped / returned, the 20260942000100 product-level count + stock_mex_apply MEX ledger, the BigArena stock sync) and the Bulgarian BigArena import rules (SKU vs barcode, the operator's product decisions). In Macedonia stock is Stock v2 since 01.10.2026 (skill elyon-stock-v2) — read this one only to understand old inventory_logs rows, old scripts, or why a v1 path must stay dead.
---

# Elyon Stock & BigArena — HISTORY (Macedonia: superseded by Stock v2)

Stock is real money and real warehouse capacity. Mistakes here have physical consequences.

## 🛑 MK, since 01.10.2026: Stock v2 is the law — everything below is retired

- **Stock = `elyon-stock-v2`** (owner 01.10.2026, migrations `20260945000100`–`0900`, contract `docs/STOCK-V2.md`):
  one append-only ledger `stock_moves` per Sigma ARTICLE × warehouse × moment — the 22.09 opening count, every MEX
  parcel since deducted at its label (collabBox goods lines first), MEX 7 returns back, Sigma for everything that is
  not a parcel. In PREVIEW (`stock_v2.enabled = false`) until the owner's count sheet arrives.
- **Retired by `20260945000700`** (never re-enable — a parcel would be deducted twice): the cron `stock-mex-apply`
  (`app_settings.stock_mex_movements` = `{"retired":"stock_v2","enabled":false}`, it was never switched on), the api's
  status deductions (`stockByStatus()` is false), `POST /restock`, `POST /stock/count`, `POST /stock/mex-movements`
  and the BigArena stock sync (all 410), the product form's stock field, `stock_count_apply` / `stock_restock` /
  `stock_mex_apply`. `products.stock_quantity` is now a guarded MIRROR of the ledger
  (`products_stock_mirror_refresh()`, `tg_products_stock_guard`, cron `stock-v2-mirror`); `GET /stock-movements`
  reads the v2 ledger. `inventory_logs` keeps the old rows — history only.
- The sections below describe what ran before; keep them for reading old data and scripts, never as instructions.

## (Retired) MK: the count + MEX regime (migration 20260942000100)

- **Попис (stock count)**, Warehouse → Попис: one count event (`stock_count_apply`) sets on-hand,
  writes a `count` movement per difference, sets `app_settings.stock_counted_at`, and the FIRST
  count sets `stock_mex_movements.from`. Owners / admins / warehouse role.
- **From `from` on, MEX parcels move stock, not CRM statuses.** `stock_mex_apply()` (cron
  `:12/:42`) reconciles `stock_mex_ledger` (UNIQUE parcel × owner × kind) with
  `stock_mex_desired()`: a registered parcel deducts its owner's lines, MEX status 7 restocks,
  a relink/unlink reverses — each change an `inventory_logs` row (`mex_deduct/mex_restock/
  mex_reverse`). A (parcel, product) older than that product's last count is frozen.
- **Dark** until an owner switches `stock_mex_movements.enabled` on (POST /api/stock/mex-movements).
- The api's status blocks below are gated by `stockByStatus()` and **stop once `from` is set** —
  do not "restore" them, a parcel would be deducted twice.
- Free units (0-price / web GIFT lines of a catalogue product) are deducted unless
  `free_units = 'skip'`; a `product_aliases` row of kind `gift` skips one name — ANY such row:
  `order_line_kind()` never reads `reviewed_by`, so an unreviewed alias counts at once.
- Proof: `node scripts/verify-stock.mjs` (on-hand = last count + movements; one ledger row per key).

## (Retired) Core Stock Rules (before the first count)

- Stock **only** changes on `shipped` (decrement) and `returned` (increment).
- It is **never** changed on order creation or confirmation.
- It only fires when `order_items.product_id IS NOT NULL`. Legacy imported orders (product_id = null) are intentionally skipped — they are historical.

This logic lives in four places in the backend (PATCH status + bulk-status-update, for both shipped and returned). Touching any of them requires touching all of them or extracting a helper.

## (Retired, BG-era) Stock Sync Button (Primary Path from 2026-07-22 until Stock v2)

The operator no longer needs a developer to re-align stock. Warehouse → Inventory →
**BigArena Stock** uploads the fulfilment-panel CSV/XLSX and overwrites `stock_quantity`
after a full preview.

- Parser + matcher: `src/lib/bigarenaStock.ts` (**shared** by the UI and the guard in
  `BigArenaStatusSync`). Unit tests: `src/lib/bigarenaStock.test.ts`.
- Endpoint: `POST /api/products/bigarena-stock-sync` in `supabase/functions/api/index.ts`.
- CRM stock = **"Свободна наличност" (free)**, never free+reserved.
- Match order **SKU → barcode → normalized name**, re-computed server-side.
- Shared-barcode rows are merged by **summing** (NT0108 + 000982 today).
- Products missing from the CRM are **reported only, never auto-created** — this
  supersedes the old script's "stock > 10 inserts new" heuristic for the UI path.
- Logs `reason=bigarena_import`, `movement_type=bigarena_sync`.

`scripts/import-products-bigarena.mjs` remains as the CLI fallback and still follows the
older insert heuristic. If you change one parser, change the other.

## BigArena Import Rules (Historical Operator Decisions — Treat as Law)

When reconciling `stock.xlsx` (positive stock rows) against live CRM products, the operator has given very precise instructions in the past:

1. **Duplicates**: If it's a true duplicate we don't need, skip it.
2. **SKU updates**: When the file has a different (correct) SKU for a product we already have, prefer the file's SKU.
3. **No SKU in file**: Use the barcode as the SKU.
4. **Collagen example**: Specific products had exact update rules (e.g., update Collagen to NT0108 SKU).
5. **Osteo Fix**: Leave exactly as-is.
6. **Snail Complex 30+30**: Explicitly do **not** add.

These rules were battle-tested during a major reconciliation. Any new import or reconciliation script **must** embed or reference these decisions.

## (Retired) Inventory Logs

Since Stock v2 the ledger `stock_moves` IS the log (append-only, event time, corrections as new rows) and nothing
writes `inventory_logs` for stock any more. Under v1, every stock change wrote to `inventory_logs` with a `reason`:
- `order_deduction`
- `order_return`
- `bigarena_import`
- `manual`
- `restock`
- etc.

Never mutate stock without an accompanying log row.

## When This Skill Applies

- Reading old `inventory_logs` rows or the BigArena import scripts
- Understanding why a v1 path (status deduction, `stock_mex_apply`, restock, the BigArena sync) must stay dead
- Anything that moves, counts or reports stock TODAY → `elyon-stock-v2`

## Sacred References

- Import script: `scripts/import-products-bigarena.mjs`
- Reconciliation work and exact rules: historical sessions around May 2026 involving stock.xlsx vs live products
- Stock logic blocks: `supabase/functions/api/index.ts` (the four places — gated off by `stockByStatus()` = false)
- `PRODUCTS_STOCK_WAREHOUSE.md` in the docs folder (BG-era; for today read `docs/STOCK-V2.md`)

## Warning

The operator has been extremely specific about certain products and import behaviors multiple times. If you are doing anything with stock imports or bulk changes, read this skill and the relevant docs section first. Do not "improve" the rules without explicit confirmation.

This area has low tolerance for creative interpretation.