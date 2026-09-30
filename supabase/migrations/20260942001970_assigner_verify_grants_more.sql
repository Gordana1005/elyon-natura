-- Completes 20260942001969: the rest of what scripts/verify-assigner.mjs reads through the Management API's
-- read-only role — the canonical pending load it compares the board with, and the department cache's
-- bookkeeping row. Read-only functions and SELECT only.
DO $g$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.assigned_pending_counts() TO supabase_read_only_user';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.agent_workloads() TO supabase_read_only_user';
    EXECUTE 'GRANT SELECT ON public.customer_departments_state TO supabase_read_only_user';
  END IF;
END
$g$;
