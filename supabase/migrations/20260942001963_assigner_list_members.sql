-- The Assigner's expanded list: its members WITH the buyer's department, filterable by department
-- (owner 29.09.2026: lists split by the department of the customer's LAST PURCHASE).
--
-- GET /api/segments/:id listed members through PostgREST, which cannot join customer_departments (no FK),
-- so the expanded list ignored the department chips and showed no department column. This function is
-- the same page, same order (trigger_event_at DESC), same assigned / completed filters, plus
--   · department  = assigner_dept_key(customer_departments.department) — 'unknown' when no row;
--   · p_departments filters on it (NULL / empty = every department), exactly as assigner_lists counts.
-- Read-only; service role only.

BEGIN;

SET LOCAL lock_timeout = '10s';

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
  SELECT pm.*, public.assigner_dept_key(cd.department) AS department
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
)
SELECT jsonb_build_object(
  'total',   (SELECT count(*) FROM m),
  'members', coalesce((SELECT jsonb_agg(to_jsonb(pg) ORDER BY pg.trigger_event_at DESC NULLS LAST, pg.customer_phone) FROM pg),
                      '[]'::jsonb)
)
$fn$;

COMMENT ON FUNCTION public.assigner_list_members(uuid, text[], text, text, integer, integer) IS
  'GET /api/segments/:id (Assigner): a list''s members page with the buyer department (assigner_dept_key over customer_departments; unknown = no row) and a department filter — the same keys assigner_lists counts. 20260942001963. Service role only.';

REVOKE ALL ON FUNCTION public.assigner_list_members(uuid, text[], text, text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assigner_list_members(uuid, text[], text, text, integer, integer) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
