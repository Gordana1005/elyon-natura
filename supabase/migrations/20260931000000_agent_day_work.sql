-- Agent "what I did today" register.
-- Clock = order_history.changed_at (human dispositions), Europe/Skopje window
-- passed in as timestamptz bounds from the edge function. System/cron authors
-- are excluded so an AlterCPA cancel does not look like the agent's work.
-- order_history starts 2026-08-01 — never use this RPC for lifetime totals.

CREATE INDEX IF NOT EXISTS idx_order_history_changed_by_at
  ON public.order_history (changed_by, changed_at DESC)
  WHERE changed_by IS NOT NULL;

CREATE OR REPLACE FUNCTION public.agent_self_day_orders(
  p_owner_id uuid,
  p_owner_names text[],
  p_from text,
  p_to text,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp SET TimeZone = 'UTC' SET work_mem = '64MB'
AS $fn$
WITH acts AS (
  SELECT h.order_id, h.to_status::text AS to_status, h.changed_at
  FROM public.order_history h
  WHERE (nullif(p_from, '') IS NULL OR h.changed_at >= nullif(p_from, '')::timestamptz)
    AND (nullif(p_to, '')   IS NULL OR h.changed_at <= nullif(p_to, '')::timestamptz)
    AND h.to_status IN ('confirmed', 'cancelled', 'trashed', 'call_again')
    AND h.changed_by_name IS NOT NULL
    AND h.changed_by_name NOT LIKE 'System (%'
    AND ( h.changed_by = p_owner_id
       OR ( h.changed_by IS NULL AND (
              h.changed_by_name = ANY (p_owner_names)
              OR EXISTS (SELECT 1 FROM unnest(p_owner_names) v
                         WHERE h.changed_by_name LIKE v || ' %') ) ) )
),
latest AS (
  SELECT DISTINCT ON (a.order_id)
         a.order_id, a.to_status AS last_to_status, a.changed_at AS last_changed_at
  FROM acts a
  ORDER BY a.order_id, a.changed_at DESC
),
rows AS (
  SELECT
    o.id,
    o.display_id,
    o.status,
    o.price,
    o.quantity,
    o.product_name,
    o.customer_name,
    o.customer_phone,
    o.customer_address,
    o.customer_city,
    o.postal_code,
    o.cancellation_reason,
    o.cancellation_reason_notes,
    o.trash_reason,
    o.trash_reason_notes,
    o.confirmed_at,
    o.cancelled_at,
    o.trashed_at,
    o.created_at,
    o.source_type,
    o.assigned_agent_id,
    o.ship_after_date,
    l.last_to_status,
    l.last_changed_at,
    (SELECT coalesce(jsonb_agg(jsonb_build_object(
              'product_name', i.product_name,
              'quantity', i.quantity,
              'price_per_unit', i.price_per_unit,
              'total_price', i.total_price
            ) ORDER BY i.id), '[]'::jsonb)
       FROM public.order_items i WHERE i.order_id = o.id) AS order_items
  FROM latest l
  JOIN public.orders o ON o.id = l.order_id
),
totals AS (
  SELECT
    count(*)::int AS n,
    count(*) FILTER (WHERE last_to_status = 'confirmed')::int AS confirmed_n,
    coalesce(sum(price) FILTER (WHERE last_to_status = 'confirmed'), 0)::numeric AS confirmed_sum,
    count(*) FILTER (WHERE last_to_status = 'cancelled')::int AS cancelled_n,
    coalesce(sum(price) FILTER (WHERE last_to_status = 'cancelled'), 0)::numeric AS cancelled_sum,
    count(*) FILTER (WHERE last_to_status = 'trashed')::int AS trashed_n,
    coalesce(sum(price) FILTER (WHERE last_to_status = 'trashed'), 0)::numeric AS trashed_sum,
    count(*) FILTER (WHERE last_to_status = 'call_again')::int AS call_again_n
  FROM rows
),
page AS (
  SELECT *
  FROM rows
  ORDER BY last_changed_at DESC
  LIMIT GREATEST(LEAST(COALESCE(p_limit, 50), 100), 1)
  OFFSET GREATEST(COALESCE(p_offset, 0), 0)
)
SELECT jsonb_build_object(
  'orders', coalesce((SELECT jsonb_agg(to_jsonb(p)) FROM page p), '[]'::jsonb),
  'total', (SELECT n FROM totals),
  'totals', (SELECT to_jsonb(t) FROM totals t)
);
$fn$;

COMMENT ON FUNCTION public.agent_self_day_orders(uuid, text[], text, text, integer, integer) IS
  'Orders an agent disposed (confirm/cancel/trash/call_again) in a window, from order_history. Human authors only. Starts 2026-08-01.';
REVOKE ALL ON FUNCTION public.agent_self_day_orders(uuid, text[], text, text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.agent_self_day_orders(uuid, text[], text, text, integer, integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.agent_self_day_orders(uuid, text[], text, text, integer, integer) TO service_role;

-- Lead-in agents must see / (My Performance). Seed omitted dashboard for pending_agent.
INSERT INTO public.role_permissions (role, module_key, can_view, can_create, can_edit, can_delete, can_export)
VALUES ('pending_agent', 'dashboard', true, false, false, false, false)
ON CONFLICT (role, module_key) DO UPDATE SET can_view = EXCLUDED.can_view;
