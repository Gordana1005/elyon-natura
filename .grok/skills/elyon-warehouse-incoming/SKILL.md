---
name: elyon-warehouse-incoming
description: Use for anything related to the /warehouse Incoming Orders tab, Delayed Orders, Shipment Calendar, bulk status updates, stock safety during shipping, ship_after_date logic, and the daily warehouse workflow. This is the primary operational view used by warehouse staff.
---

# Elyon Warehouse Incoming Orders Skill

This area is the daily heartbeat of the physical operation. The Incoming Orders tab is where warehouse staff see what is ready to pick, pack, and ship today.

## Core Mental Model

The tab combines two sources:
1. Real orders in statuses: `confirmed`, `shipped`, `delivered`, `paid`
2. Unconverted confirmed prediction leads (direct from segments, no order yet)

These are merged in the backend (`/warehouse/incoming-orders`) and presented with powerful filtering + grouping by date.

## Critical Business Rules

**ship_after_date postponement**:
- Agents can set a future `ship_after_date` during confirmation.
- The "Ready to ship by" filter (default = today + 2) excludes future-dated orders from today's list.
- This is intentional and respected by the warehouse flow.

**Stock safety**:
- MK, once the first stock count exists (migration 20260942000100): MEX parcels move stock and
  marking `shipped` / `returned` here moves nothing (see `elyon-stock-and-bigarena`).
- Before that: stock only decrements on transition to `shipped` (via single PATCH or bulk).
- Only rows where `order_items.product_id IS NOT NULL` affect stock (legacy imports are skipped on purpose).
- Bulk export can optionally flip `confirmed → shipped` automatically.

**Source distinction**:
- Standard orders vs Prediction Leads have slightly different display and capabilities (leads cannot always have status changed the same way).

## Performance History (Important Context)

This area was historically one of the slowest parts of the app under real load because of unpaginated heavy selects with joins on large date windows. After the 2026 performance work:

- Composite indexes were added specifically for these queries.
- The handler now uses explicit `.range()` pagination.
- The frontend uses React Query with proper invalidation instead of blind full refetches.

Any future changes here must preserve the performance characteristics.

## When This Skill Applies

- Working in WarehousePage.tsx (all three tabs)
- Modifying the incoming-orders backend handler
- Bulk status updates that affect warehouse views
- Calendar or delayed order logic
- Any discussion of "what the warehouse sees today"

## Key Gotchas

- Grouping in the UI is by `created_at`, not always `ship_after_date`.
- The KPI "Pending Orders" count at the top of the warehouse page pulls a wide set — be careful not to make it expensive.
- Prediction leads without linked orders have special handling (`prediction_lead_direct` source).

## Sacred References

- Frontend: `src/pages/WarehousePage.tsx` (IncomingOrdersTab, DelayedOrdersTab, ShipmentCalendarTab)
- Backend: `supabase/functions/api/index.ts` — the entire `warehouse/incoming-orders` GET handler + PATCH/DELETE
- Stock logic: the four blocks in status update paths
- Indexes added in migration `20260523093000_warehouse_incoming_orders_indexes.sql`

## Recommended Approach for Changes

1. Read this skill + the performance indexes migration.
2. Prefer server-side aggregation or skeleton queries for calendar views if the dataset grows.
3. Never remove the explicit pagination or the 90-day safety default without strong justification.
4. After any status-changing change, consider the impact on the warehouse view and stock.

The warehouse staff (and the operator) depend on this screen being fast and trustworthy every single day. Treat changes here with extreme care.