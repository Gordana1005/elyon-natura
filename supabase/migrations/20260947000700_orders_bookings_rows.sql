-- ============================================================================
-- orders_bookings_rows: ONLY the collabBox bookings of a window, for GET /orders/bookings (fix, 02.10.2026)
-- ============================================================================
-- GET /orders/bookings called insights_sale_rows over PostgREST and kept kind = 'booking' in the api. PostgREST
-- answers at most 1.000 rows, and a week holds thousands of sale rows (orders, web, MEX-only first), so on
-- /orders?range=week the bookings were cut off and the section stayed empty (found on production the same hour).
-- This wrapper returns the booking rows only — still THE calculation (insights_sale_rows, the cohort's own bk), never a
-- second definition. A window's bookings are the documents still waiting for their parcel (≤ 14 days old): a few
-- hundred, far under the cap.
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.orders_bookings_rows(p_from timestamptz, p_to_end timestamptz)
RETURNS TABLE(kind text, source text, sale_at timestamptz, value_mkd numeric, person_id uuid, display_id text, phone8 text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT s.kind, s.source, s.sale_at, s.value_mkd, s.person_id, s.display_id, s.phone8
  FROM public.insights_sale_rows(p_from, p_to_end, false) s
  WHERE s.kind = 'booking'
  ORDER BY s.sale_at DESC, s.display_id
$fn$;
COMMENT ON FUNCTION public.orders_bookings_rows(timestamptz, timestamptz) IS
  'Owner 02.10.2026: the collabBox bookings of a window (insights_sale_rows kind = ''booking'' — the cohort''s own definition), newest first, for GET /orders/bookings — so the PostgREST 1.000-row cap never cuts them off behind the orders. Migration 20260947000700.';

REVOKE ALL ON FUNCTION public.orders_bookings_rows(timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.orders_bookings_rows(timestamptz, timestamptz) TO service_role;
DO $g$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    GRANT EXECUTE ON FUNCTION public.orders_bookings_rows(timestamptz, timestamptz) TO supabase_read_only_user;
  END IF;
END
$g$;

COMMIT;
