-- Hygiene, no figure changes: a paid order whose own MEX parcel is delivered carries paid_basis = 'mex'.
--
-- mex-reconcile writes paid_basis 'mex' on every paid flip it makes, but orders that became paid before the
-- column existed (20260934000200), or through an import / collabBox document, still carry NULL — 14.674
-- orders on 29.09.2026 (import ~12.000 · altercpa 2.178 · manual 481), paid 21.01 → 26.09.2026.
--
-- Why no figure moves: cohort_order_bucket() (SQL) and cohortBucket() (TS) read MEX first — a linked parcel
-- with a MEX status decides the bucket and paid_basis is never consulted. The rows below all carry
-- orders.mex_status_id = 2 AND a delivered row in mex_parcels, so they sit in 'paid' before and after.
-- Left alone on purpose (paid_basis DOES decide their bucket, so 'mex' would move them):
--   · 3 orders whose parcel a live web order claims — judged on their CRM status alone (web claims win);
--   · 4 imported paid orders whose parcel is delivered in the register but whose orders.mex_* facts are
--     empty (paid_legacy through the NULL-basis import rule);
--   · 37 imported paid orders whose tracking id is not a delivered parcel.
-- The DO block refuses to run if any row it would touch changes bucket.
--
-- Triggers: an UPDATE of paid_basis alone fires only trg_orders_updated_at, which keep_updated_at disarms
-- (GET /call-agains reads updated_at as last_call_at). trg_orders_set_paid_basis fires on status only.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL elyon.keep_updated_at = 'on';
SET LOCAL elyon.bulk_repair = 'on';

CREATE TEMP TABLE _pb_mex ON COMMIT DROP AS
SELECT o.id
  FROM public.orders o
  JOIN public.mex_parcels p ON p.tracking_id = o.mex_tracking_id
 WHERE p.status_id = 2
   AND o.status = 'paid'
   AND o.paid_basis IS NULL
   AND o.mex_status_id = 2
   AND NOT EXISTS (SELECT 1 FROM public.web_orders w
                    WHERE w.mex_tracking_id = o.mex_tracking_id AND w.deleted_in_shop_at IS NULL);

DO $chk$
DECLARE
  v_moved int;
BEGIN
  SELECT count(*) INTO v_moved
    FROM public.orders o JOIN _pb_mex t ON t.id = o.id
   WHERE public.cohort_order_bucket(o.status::text, o.price, o.sold_at, o.paid_basis, o.source_type, o.sale_source_detail,
                                    o.mex_tracking_id, o.mex_status_id, o.mex_cod_mkd, o.mex_delivered_at, false)
         IS DISTINCT FROM
         public.cohort_order_bucket(o.status::text, o.price, o.sold_at, 'mex', o.source_type, o.sale_source_detail,
                                    o.mex_tracking_id, o.mex_status_id, o.mex_cod_mkd, o.mex_delivered_at, false);
  IF v_moved > 0 THEN
    RAISE EXCEPTION 'paid_basis backfill would move % order(s) to another cohort bucket — refusing', v_moved;
  END IF;
END
$chk$;

UPDATE public.orders o
   SET paid_basis = 'mex'
  FROM _pb_mex t
 WHERE t.id = o.id
   AND o.paid_basis IS NULL;

COMMIT;
