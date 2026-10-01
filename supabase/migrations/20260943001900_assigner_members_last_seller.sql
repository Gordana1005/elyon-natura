-- The Assigner's list members also say WHO SOLD to the customer last (owner 01.10.2026: the column must
-- show which operator made the sale, not who the member happens to be assigned to — the board already
-- shows every agent's assigned load).
--
-- last_seller = the seller of the customer's LAST SALE (customer_departments.order_id, the same order the
-- buyer department comes from): sales_people.display_name via the write-once sold_by_person_id, else the
-- raw sold_by_ext (a former operator with no person row), else the confirmer. Computed for the page rows
-- only (≤ 200), so the list stays as fast as before. Everything else is unchanged from 20260942001963.

DO $drift$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE proname = 'assigner_list_members') IS DISTINCT FROM '200f6144b77da23bc516c191d7e3bbb7' THEN
    RAISE EXCEPTION 'assigner_list_members drifted from its 20260942001963 body — re-read it before replacing';
  END IF;
END
$drift$;

CREATE OR REPLACE FUNCTION public.assigner_list_members(
  p_list_id     uuid,
  p_departments text[] DEFAULT NULL,
  p_assigned    text   DEFAULT 'all',   -- 'all' | 'none' | <agent uuid>
  p_completed   text   DEFAULT 'all',   -- 'all' | 'yes' | 'no'
  p_limit       integer DEFAULT 50,
  p_offset      integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
WITH m AS (
  SELECT pm.*, public.assigner_dept_key(cd.department) AS department, cd.order_id AS last_sale_order_id
  FROM public.prediction_segment_members pm
  LEFT JOIN public.customer_departments cd ON cd.customer_phone = pm.customer_phone
  WHERE pm.list_id = p_list_id
    AND (p_departments IS NULL OR cardinality(p_departments) = 0
         OR public.assigner_dept_key(cd.department) = ANY (p_departments))
    AND (p_assigned IS NULL OR p_assigned = 'all'
         OR (p_assigned = 'none' AND pm.assigned_agent_id IS NULL)
         OR pm.assigned_agent_id::text = p_assigned)
    AND (p_completed IS NULL OR p_completed = 'all'
         OR (p_completed = 'yes' AND pm.is_completed)
         OR (p_completed = 'no' AND NOT pm.is_completed))
),
pg AS (
  SELECT * FROM m
  ORDER BY m.trigger_event_at DESC NULLS LAST, m.customer_phone
  LIMIT greatest(1, least(coalesce(p_limit, 50), 200)) OFFSET greatest(0, coalesce(p_offset, 0))
),
pg2 AS (
  SELECT pg.*,
         coalesce(sp.display_name, nullif(btrim(o.sold_by_ext), ''), nullif(btrim(o.confirmed_by_name), '')) AS last_seller
  FROM pg
  LEFT JOIN public.orders o ON o.id = pg.last_sale_order_id
  LEFT JOIN public.sales_people sp ON sp.id = o.sold_by_person_id
)
SELECT jsonb_build_object(
  'total',   (SELECT count(*) FROM m),
  'members', coalesce((SELECT jsonb_agg(to_jsonb(pg2) ORDER BY pg2.trigger_event_at DESC NULLS LAST, pg2.customer_phone) FROM pg2),
                      '[]'::jsonb)
)
$fn$;

COMMENT ON FUNCTION public.assigner_list_members(uuid, text[], text, text, integer, integer) IS
  'GET /api/segments/:id (Assigner): a list''s members page with the buyer department (assigner_dept_key over customer_departments; unknown = no row), a department filter, and last_seller (who sold the customer''s last sale — sold_by person, else sold_by_ext, else the confirmer). 20260942001963 + 20260943001900. Service role only.';

REVOKE ALL ON FUNCTION public.assigner_list_members(uuid, text[], text, text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assigner_list_members(uuid, text[], text, text, integer, integer) TO service_role;
DO $g$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.assigner_list_members(uuid, text[], text, text, integer, integer) TO supabase_read_only_user';
  END IF;
END $g$;

NOTIFY pgrst, 'reload schema';
