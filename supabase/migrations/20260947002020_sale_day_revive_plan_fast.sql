-- 20260947002020 — sale_day_revive_plan, fast again (20260947002000 follow-up)
--
-- 20260947002000 added the late-sale filter (late_sale_case_of: case 1 / 2 only) to the revive plan's final
-- WHERE; the planner evaluated it on every sale holding a parcel and the plan hit the statement timeout (the
-- 'sale-day-revive' cron runs it every 15 minutes). The revive candidates are now MATERIALIZED first (basis +
-- "dated before its evidence" — a handful of rows), and only those are classified. Same rule, same columns.

BEGIN;

CREATE OR REPLACE FUNCTION public.sale_day_revive_plan(
  p_since timestamptz DEFAULT '2026-01-01 00:00:00+01',
  p_order uuid DEFAULT NULL)
RETURNS TABLE (
  order_id uuid, display_id text, basis text, status_at_arrival text,
  old_sold_at timestamptz, new_sold_at timestamptz, arrival_at timestamptz,
  doc_number text, doc_type_id text, parcel text, value_mkd numeric,
  sale_source text, sale_source_detail text, sold_via text, dept_before text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  WITH e AS (            -- a sale now, stamped, holding a parcel; its reviving evidence
    SELECT o.id, o.display_id, o.status::text AS status, o.sold_at, o.sold_via, o.mex_tracking_id,
           o.created_at, o.sale_source, o.sale_source_detail, o.price, o.dept_override,
           d.doc_number, d.doc_type_id, d.booked_at,
           public.collabbox_sale_at(d.doc_at, d.booked_at) AS t_doc,
           p.created_at_mex AS t_par, p.cod_mkd
    FROM public.orders o
    LEFT JOIN public.mex_parcels p ON p.tracking_id = o.mex_tracking_id
    LEFT JOIN LATERAL (
      SELECT d.doc_number, d.doc_type_id, d.doc_at, d.booked_at
      FROM public.collabbox_documents d
      WHERE d.doc_number = o.mex_tracking_id
        AND public.collabbox_doc_role(d.doc_type_id) <> 'record'      -- a SALES document
        AND NOT coalesce(d.is_storno, false)
        AND d.vanished_at IS NULL
    ) d ON true
    WHERE o.mex_tracking_id IS NOT NULL
      AND o.status::text IN ('confirmed', 'shipped', 'delivered', 'paid', 'returned')
      AND o.sold_at IS NOT NULL
      AND (p_order IS NULL OR o.id = p_order)
      -- an undone move stays undone: the cron never moves that order again
      AND NOT EXISTS (SELECT 1 FROM public.sale_day_revive_moves u
                       WHERE u.order_id = o.id AND u.undone_at IS NOT NULL)
  ),
  a AS (
    SELECT e.*,
           coalesce(e.t_doc, e.t_par)            AS new_at,
           least(e.t_doc, e.booked_at, e.t_par)  AS arr_at
    FROM e
    WHERE coalesce(e.t_doc, e.t_par) >= p_since
      AND (coalesce(e.t_doc, e.t_par) AT TIME ZONE 'Europe/Skopje')::date
          > (e.sold_at AT TIME ZONE 'Europe/Skopje')::date                -- forward only, another day
  ),
  s AS (
    SELECT a.*, public.order_status_at(a.id, a.arr_at) AS st_arr
    FROM a
  ),
  b AS MATERIALIZED (
    SELECT s.*,
           CASE WHEN s.st_arr IN ('cancelled', 'trashed') THEN 'dead'
                WHEN s.st_arr IN ('pending', 'take', 'call_again') THEN 'unsold'
           END AS basis
    FROM s
  ),
  f AS MATERIALIZED (     -- the revive candidates first (few), THEN the late-sale classification on them
    SELECT b.* FROM b
    WHERE b.basis IS NOT NULL
      -- the sale is dated BEFORE its reviving evidence existed
      AND b.sold_at < b.arr_at
  )
  SELECT f.id, f.display_id, f.basis, f.st_arr, f.sold_at, f.new_at, f.arr_at,
         f.doc_number, f.doc_type_id, f.mex_tracking_id,
         coalesce(nullif(f.cod_mkd, 0)::numeric, round(coalesce(f.price, 0) * 61.5)),
         f.sale_source, f.sale_source_detail, f.sold_via,
         public.cohort_order_source(f.sale_source, f.sale_source_detail, f.mex_tracking_id, f.dept_override)
  FROM f
  -- 20260947002000: case 1 / 2 only — a late document / parcel is a NEW order, never a revive
  WHERE public.late_sale_case_of(f.id, f.mex_tracking_id) IN ('open', 'dead_recent');
$fn$;
REVOKE ALL ON FUNCTION public.sale_day_revive_plan(timestamptz, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sale_day_revive_plan(timestamptz, uuid) TO service_role, supabase_read_only_user;

COMMIT;
