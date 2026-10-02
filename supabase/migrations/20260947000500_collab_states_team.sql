-- ============================================================================
-- crm_sale_collab_states + team_dept: the /orders badge knows when the seller's TEAM already decides the department
-- (owner, 02.10.2026)
-- ============================================================================
-- 20260947000400 made the seller's line team decide the department (a lead excepted). /orders marks a CRM sale that is
-- not yet in collabBox as "(привремено)" — provisional until its booking / parcel decides. That is now true only for a
-- seller in Менаџмент / without a line team: a Телешоп Out agent's sale is Телешоп – Lead out whatever she books.
-- The function gains one column, team_dept = order_dept_by_team(…) (NULL = the booking / parcel still decides), so the
-- badge can tell. A RETURNS TABLE change needs DROP + CREATE; its only reader is the api's GET /orders (a missing
-- column reads as "not decided by the team" — the old marker — so the order of deploys does not matter).
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $drift$
BEGIN
  IF to_regprocedure('public.order_dept_by_team(text,uuid,timestamptz)') IS NULL
     OR to_regprocedure('public.crm_sale_collab_states(uuid[])') IS NULL THEN
    RAISE EXCEPTION 'collab states + team: 20260947000200 / 0400 missing';
  END IF;
END
$drift$;

DROP FUNCTION IF EXISTS public.crm_sale_collab_states(uuid[]);

CREATE FUNCTION public.crm_sale_collab_states(p_ids uuid[])
RETURNS TABLE(order_id uuid, collab_doc text, sale_day date, cancel_day date, mode text, team_dept text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _cfg  jsonb := coalesce((SELECT s.value FROM public.app_settings s WHERE s.key = 'collab_entry_rule'), '{}'::jsonb);
  _days integer := greatest(1, least(30, coalesce(CASE WHEN coalesce(_cfg->>'days', '') ~ '^[0-9]{1,2}$'
                                                       THEN (_cfg->>'days')::int END, 2)));
  _mode text := CASE WHEN _cfg->>'mode' = 'apply' THEN 'apply' ELSE 'report' END;
BEGIN
  IF coalesce(array_length(p_ids, 1), 0) > 200 THEN
    RAISE EXCEPTION 'crm_sale_collab_states: at most 200 orders' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT x.id, public.crm_sale_collab_doc(x.id),
         (coalesce(x.sold_at, x.confirmed_at, x.created_at) AT TIME ZONE 'Europe/Skopje')::date,
         (coalesce(x.sold_at, x.confirmed_at, x.created_at) AT TIME ZONE 'Europe/Skopje')::date + _days,
         _mode,
         public.order_dept_by_team(x.sale_source, x.sold_by_person_id, coalesce(x.sold_at, x.created_at))
  FROM public.orders x
  WHERE x.id = ANY (p_ids)
    AND x.status = 'confirmed'
    AND x.sale_source = 'elyon_crm'
    AND x.sale_source_detail IN ('prediction_list', 'direct')
    AND x.mex_tracking_id IS NULL;
END;
$fn$;
COMMENT ON FUNCTION public.crm_sale_collab_states(uuid[]) IS
  'Owner 02.10.2026: for the /orders badge — each confirmed CRM sale without a parcel among the ids: its collabBox document (crm_sale_collab_doc) or NULL, its sale day, the day the 2-day rule cancels it, the rule''s mode, and team_dept = the department its seller''s team already decides (order_dept_by_team; NULL = the booking / parcel still decides). ≤ 200 ids. Migrations 20260947000200 / 0500.';

REVOKE ALL ON FUNCTION public.crm_sale_collab_states(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crm_sale_collab_states(uuid[]) TO service_role;
DO $g$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    GRANT EXECUTE ON FUNCTION public.crm_sale_collab_states(uuid[]) TO supabase_read_only_user;
  END IF;
END
$g$;

COMMIT;
