-- Packing state for the warehouse "За пакување" workflow (2026-08-17).
-- Deliberately NOT a new order_status enum value: packing is a warehouse-internal
-- substate of 'confirmed'. The segment engine, REAL_ORDER_STATUSES, AlterCPA maps
-- and every status dropdown keep working untouched. 'shipped' stays the stock-
-- deduction moment; mex-reconcile stays forward-only.
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS packed_at      timestamptz,
  ADD COLUMN IF NOT EXISTS packed_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS packed_by_name text;

COMMENT ON COLUMN public.orders.packed_at IS
  'Warehouse packed timestamp. Status stays confirmed while packed; NULL = still in the to-pack queue. Also the future trigger point for the MEX Poshta add_shipment.php push (deferred).';

-- The packing queue is always "confirmed, newest window": one partial index
-- serves both sub-views (packed_at IS NULL / IS NOT NULL) and the KPI count.
CREATE INDEX IF NOT EXISTS idx_orders_confirmed_packing
  ON public.orders (packed_at, created_at DESC)
  WHERE status = 'confirmed';
