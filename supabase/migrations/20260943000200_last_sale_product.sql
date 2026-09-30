-- The product a customer last BOUGHT, looked up server-side (owner audit, 30.09.2026).
--
-- Why: when an agent cancels or trashes a customer on /calls and there is no open order to close,
-- the page records a synthetic outcome row with "the customer's last product". The page looked that
-- up through GET /orders, which RLS scopes to the agent's own assigned orders — so for a
-- prediction-list customer it found nothing and wrote "No prior product on file". In the week to
-- 30.09 that was 1.021 of 1.022 agent cancels and 543 agent trashes (7.170 rows since 18.08), and
-- every one of those customers HAS a previous sale. POST /orders now fills the product from this
-- function (service role, last-8 match, the same rule as lastRealProduct in CallsPage.tsx: the
-- latest real sale's non-placeholder item names joined; product_id only when it is one item).
--
-- p_before lets the one-off repair (scripts/repair-disposition-products.mjs) take the sale that
-- came BEFORE each old record, not today's.

CREATE OR REPLACE FUNCTION public.last_sale_product(p_phone text, p_before timestamptz DEFAULT now())
RETURNS TABLE (order_id uuid, product_id uuid, product_name text, sale_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  WITH d AS (SELECT right(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g'), 8) AS d8),
  sales AS (
    SELECT o.id, o.product_id, o.product_name, coalesce(o.sold_at, o.confirmed_at, o.created_at) AS sale_at
      FROM orders o, d
     WHERE length(d.d8) = 8
       -- the exact expression of idx_orders_phone_last8
       AND right(regexp_replace(o.customer_phone, '[^0-9]'::text, ''::text, 'g'::text), 8) = d.d8
       AND o.status IN ('confirmed', 'shipped', 'delivered', 'paid', 'returned')
       AND coalesce(o.sold_at, o.confirmed_at, o.created_at) < p_before
  ),
  named AS (
    SELECT s.id, s.sale_at, s.product_id AS order_pid, s.product_name AS order_name,
           (SELECT string_agg(oi.product_name, ', ' ORDER BY oi.created_at, oi.id)
              FROM order_items oi
             WHERE oi.order_id = s.id AND NOT public.is_synthetic_product_name(oi.product_name)) AS items_name,
           (SELECT CASE WHEN count(*) = 1 THEN max(oi.product_id::text)::uuid END
              FROM order_items oi
             WHERE oi.order_id = s.id AND NOT public.is_synthetic_product_name(oi.product_name)) AS items_pid
      FROM sales s
  )
  SELECT n.id,
         CASE WHEN n.items_name IS NOT NULL THEN n.items_pid ELSE n.order_pid END,
         coalesce(n.items_name, n.order_name),
         n.sale_at
    FROM named n
   WHERE n.items_name IS NOT NULL OR NOT public.is_synthetic_product_name(n.order_name)
   ORDER BY n.sale_at DESC, n.id
   LIMIT 1;
$fn$;

COMMENT ON FUNCTION public.last_sale_product(text, timestamptz) IS
  'The product of the customer''s latest real sale before p_before (last-8 phone match, statuses confirmed…returned, placeholder names skipped; items joined like CallsPage lastRealProduct, product_id only for one item). Feeds POST /orders for /calls cancel/trash records and the one-off disposition repair. Migration 20260943000200.';

REVOKE ALL ON FUNCTION public.last_sale_product(text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.last_sale_product(text, timestamptz) TO service_role;
