-- 20260948000210_mex_history_plan_priced_only.sql
-- mex_history_link_plan(): a price-0 order never takes a history parcel.
--
-- The first load (run dd935dad, 04.10.2026) linked three price-0 collabBox orders — free replacements; one of them
-- carried a COD of 150 ден (the delivery fee only), which made it a 150-ден "paid" sale and tripped
-- verify-attribution C10 (an order holding a parcel with price 0). They were unlinked the same morning
-- (mex_history_links.skipped names the reason); this keeps the next plan from picking such an order again.

CREATE OR REPLACE FUNCTION public.mex_history_link_plan(p_run uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $plan$
DECLARE
  _n integer;
BEGIN
  IF p_run IS NULL THEN
    RAISE EXCEPTION 'mex_history_link_plan: a run id is required';
  END IF;
  IF EXISTS (SELECT 1 FROM public.mex_history_links WHERE run_id = p_run) THEN
    RAISE EXCEPTION 'mex_history_link_plan: run % already has a plan', p_run;
  END IF;

  INSERT INTO public.mex_history_links (run_id, order_id, tracking_id, rule, expect_status)
  SELECT p_run, o.id, s.tracking_id,
         CASE WHEN o.status = 'paid' THEN 'paid_delivered' ELSE 'returned_returned' END,
         o.status::text
    FROM public.mex_history_stage s
    JOIN public.orders o
      ON o.external_source = 'collabbox' AND o.external_order_id = s.tracking_id   -- the document number IS the parcel
   WHERE o.mex_tracking_id IS NULL
     AND coalesce(o.price, 0) > 0                                                  -- a price-0 order is a replacement, never a sale
     AND (   (o.status = 'paid'     AND s.status_id = 2 AND coalesce(s.cod_mkd, 0) > 0)   -- COD 0 = a replacement: not here
          OR (o.status = 'returned' AND s.status_id = 7))
     AND coalesce(s.phone8, '') NOT IN ('70123456', '23123123')                    -- the test phones
     AND s.created_at_mex IS NOT NULL AND s.last_update_at IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.mex_parcels mp WHERE mp.tracking_id = s.tracking_id)
     AND NOT EXISTS (SELECT 1 FROM public.orders x WHERE x.mex_tracking_id = s.tracking_id);
  GET DIAGNOSTICS _n = ROW_COUNT;

  RETURN jsonb_build_object(
    'run', p_run, 'planned', _n,
    'by_rule', (SELECT jsonb_object_agg(x.rule, x.n) FROM (
                  SELECT l.rule, count(*) AS n FROM public.mex_history_links l WHERE l.run_id = p_run GROUP BY 1) x));
END;
$plan$;

REVOKE ALL ON FUNCTION public.mex_history_link_plan(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mex_history_link_plan(uuid) TO service_role;
