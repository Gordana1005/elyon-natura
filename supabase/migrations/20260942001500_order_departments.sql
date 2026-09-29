-- The Orders list names every order's DEPARTMENT and SELLER (owner, 29.09.2026 08:45: "why does
-- Orders say confirmed by System (collabbox-sync) — don't we know which agent?").
--
-- order_departments(ids) → (id, department, seller_name) for one page of GET /orders:
--   department  = THE mapping, cohort_order_source(sale_source, detail, mex_tracking_id)
--                 (20260942001000) — never re-implemented in TS
--   seller_name = the write-once sold_* stamp (the leaderboard's credit): the person's display
--                 name, else the raw external name (a collabBox author as collabBox writes it) —
--                 never a bare AlterCPA operator id
-- Read-only, display only: confirmed_by_* stay untouched (payout / bonus math is deferred by the
-- owner and reads them), so a collabBox order keeps its system confirmer and SHOWS its seller.
-- SECURITY DEFINER (sales_people is owners-only under RLS); EXECUTE for service_role (the api) and
-- the read-only verification role only.

BEGIN;

CREATE OR REPLACE FUNCTION public.order_departments(p_ids uuid[])
RETURNS TABLE (id uuid, department text, seller_name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT o.id,
         public.cohort_order_source(o.sale_source, o.sale_source_detail, o.mex_tracking_id),
         coalesce(sp.display_name,
                  CASE WHEN o.sold_by_ext ~ '^[0-9]+$' THEN NULL ELSE nullif(btrim(o.sold_by_ext), '') END)
    FROM public.orders o
    LEFT JOIN public.sales_people sp ON sp.id = o.sold_by_person_id
   WHERE o.id = ANY (p_ids)
$fn$;

COMMENT ON FUNCTION public.order_departments(uuid[]) IS
  'GET /orders page enrichment (20260942001500): each order''s department (cohort_order_source, the six departments) and seller (sold_* stamp: person display name, else the external author name, never a bare AlterCPA id). Display only.';

REVOKE ALL ON FUNCTION public.order_departments(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.order_departments(uuid[]) TO service_role;
DO $g$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    GRANT EXECUTE ON FUNCTION public.order_departments(uuid[]) TO supabase_read_only_user;
  END IF;
END
$g$;

COMMIT;
