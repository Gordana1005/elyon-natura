-- scripts/verify-assigner.mjs runs through the Management API's read-only mode (role
-- supabase_read_only_user, a read-only transaction). Let that role EXECUTE the Assigner's functions so the
-- checker can recount them; assigner_distribute is called there only with p_dry_run := true, and any write
-- would fail anyway inside the read-only transaction. The app keeps calling them as service_role.
DO $g$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.assigner_board() TO supabase_read_only_user';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.assigner_lists(text[]) TO supabase_read_only_user';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.assigner_list_members(uuid, text[], text, text, integer, integer) TO supabase_read_only_user';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.assigner_call_agains(text, text, text[], text, integer, integer) TO supabase_read_only_user';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.assigner_distribute(text, uuid, text[], text, integer, text, uuid[], boolean, boolean, text, text) TO supabase_read_only_user';
    EXECUTE 'GRANT SELECT ON public.customer_departments TO supabase_read_only_user';
  END IF;
END
$g$;
