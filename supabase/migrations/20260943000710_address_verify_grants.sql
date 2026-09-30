-- scripts/verify-address-routing.mjs reads through the Management API's read-only role. Grant it EXECUTE on the
-- read-only address resolvers of 20260943000500–0700 (STABLE lookups — no writes). customer_profile_merge and
-- mk_settlements_refresh_requires_district write, so they stay service_role only.
DO $g$
DECLARE f regprocedure;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    FOR f IN
      SELECT p.oid::regprocedure FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace
         AND p.proname IN ('mex_zone_hub', 'mex_zone_for_settlement', 'mex_zone_for_name', 'mex_zone_canonical',
                           'mex_zone_leaf', 'mk_clean_quarter', 'mk_geo_norm', 'mk_strip_settlement_prefix',
                           'open_order_zone_candidates')
    LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO supabase_read_only_user', f);
    END LOOP;
  END IF;
END
$g$;
