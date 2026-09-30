-- Completes 20260943000710: the internal read-only helper open_order_zone_candidates() calls.
DO $g$
DECLARE f regprocedure;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    FOR f IN SELECT p.oid::regprocedure FROM pg_proc p
              WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('mex_zone_town_key')
    LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO supabase_read_only_user', f);
    END LOOP;
  END IF;
END
$g$;
