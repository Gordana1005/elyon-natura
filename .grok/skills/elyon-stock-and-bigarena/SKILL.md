---
name: elyon-stock-and-bigarena
description: Use for any stock movement, BigArena imports, reconciliation, inventory logs, or rules around when stock decrements or is restored. Includes the very specific historical rules the operator has set for product imports, SKU vs barcode handling, and what must never be touched.
---

# Elyon Stock & BigArena Reconciliation Skill

Stock is real money and real warehouse capacity. Mistakes here have physical consequences.

## MK: the count + MEX regime (migration 20260942000100) — overrides the rules below

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

## Core Stock Rules (before the first count)

- Stock **only** changes on `shipped` (decrement) and `returned` (increment).
- It is **never** changed on order creation or confirmation.
- It only fires when `order_items.product_id IS NOT NULL`. Legacy imported orders (product_id = null) are intentionally skipped — they are historical.

This logic lives in four places in the backend (PATCH status + bulk-status-update, for both shipped and returned). Touching any of them requires touching all of them or extracting a helper.

## Stock Sync Button (Primary Path since 2026-07-22)

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

## Inventory Logs

Every stock change must write to `inventory_logs` with proper `reason`:
- `order_deduction`
- `order_return`
- `bigarena_import`
- `manual`
- `restock`
- etc.

Never mutate stock without an accompanying log row.

## When This Skill Applies

- Running or modifying BigArena import scripts
- Any stock reconciliation
- Changing decrement/restore logic
- Building reports that include stock value or movements
- Adding new products that will have stock

## Sacred References

- Import script: `scripts/import-products-bigarena.mjs`
- Reconciliation work and exact rules: historical sessions around May 2026 involving stock.xlsx vs live products
- Stock logic blocks: `supabase/functions/api/index.ts` (the four places)
- `PRODUCTS_STOCK_WAREHOUSE.md` in the docs folder

## Warning

The operator has been extremely specific about certain products and import behaviors multiple times. If you are doing anything with stock imports or bulk changes, read this skill and the relevant docs section first. Do not "improve" the rules without explicit confirmation.

This area has low tolerance for creative interpretation.