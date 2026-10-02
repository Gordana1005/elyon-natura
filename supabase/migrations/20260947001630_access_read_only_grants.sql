-- ============================================================================
-- Read-only verification can ask the access gates (02.10.2026)
-- ============================================================================
-- The Management API's read_only queries run as supabase_read_only_user, which had no EXECUTE on
-- the money gates, so verify-scripts could not ask them. Grant EXECUTE (all SECURITY DEFINER,
-- read-only bodies) — as 20260947001300 did for insights_mex_cash. Nothing the app sees changes.
-- ============================================================================
DO $g$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.is_business_owner(uuid), public.can_see_mex_cash(uuid),
                                       public.my_access(), public.my_can_see_mex_cash(), public.get_my_permissions()
             TO supabase_read_only_user';
  END IF;
END
$g$;
