-- ============================================================================
-- A CRM sale takes its department from its collabBox BOOKING — at once, not when MEX makes the parcel
-- (owner, Mile, 02.10.2026)
-- ============================================================================
-- Owner: "телешоп внесуваат само преку НАТУРА профилот до мекс, само тие ордерс што се во папката и се преку натура
--   тие се од телешоп оут, а афилиејт оут праќаат само преку био натура … По Orders на фолдерите од тоа што е во
--   collab, дали завршиле преку био натура до мекс или преку натура, би ти дало одговор".
-- The law is unchanged — the collabBox FOLDER and the MEX PROFILE decide, never the team, never the product (last 10
--   days: Нарачка out / in / Социјални → 100 % NATURA; LEADS / LEADS-OUT → 100 % BIO NATURAL). What changes is WHEN a
--   CRM-made sale (elyon_crm prediction_list / direct) learns it: until now only from its MEX parcel
--   (order_dept_override, 20260942001860), so a sale booked this morning in "Нарачка out" sat in Affiliate – Lead out
--   (the no-parcel default) until MEX created the parcel the next day — /orders showed 0 Телешоп – Lead out while the
--   board counted the booking.
-- Now: a confirmed CRM sale with no parcel whose collabBox document is found takes THAT document's department, the
--   same calculation the cohort gives a booking: cohort_order_source(collabbox_department(type, doc, author, at)) —
--   10050 Нарачка out → Телешоп – Lead out · 10036 Нарачка in → Телешоп – Lead in · 10106 / 10055 → Социјални ·
--   10114 LEADS-OUT → Affiliate – Lead out · 10111 LEADS → Affiliate – Lead in.
--   The document: crm_sale_collab_doc (20260947000200, the 2-day rule's evidence) AND it must be the sale's own —
--   linked to the order (order_id / related_order_id) or booked by the sale's seller. A customer's other booking is
--   never borrowed.
--   The parcel still wins once MEX has it (order_dept_override by profile, unchanged). No booking and no parcel → NULL
--   (the default, Affiliate – Lead out) — shown on /orders as provisional, cancelled after 2 days by the
--   collabBox entry rule.
-- Kept current by: the orders trigger (on an UPDATE of the source / seller / sale time / parcel) and the cron
--   crm-sale-booking-dept every 15 minutes (a new booking arrives through the collabBox sync, not through the order).
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $drift$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.tg_orders_dept_override()')
                   AND md5(replace(p.prosrc, chr(13), '')) = 'c84b07bcf9fe03c3e425176524fc57c9')
     OR NOT EXISTS (SELECT 1 FROM pg_proc p
                     WHERE p.oid = to_regprocedure('public.order_dept_override(text,text,uuid,timestamptz,text,text)')
                       AND md5(replace(p.prosrc, chr(13), '')) = '0c493454717aafcddfa6f6c736c1769a')
     OR NOT EXISTS (SELECT 1 FROM pg_proc p
                     WHERE p.oid = to_regprocedure('public.collabbox_department(text,text,uuid,timestamptz)')
                       AND md5(replace(p.prosrc, chr(13), '')) = 'af4429b43a05ba94e7edda188f105de8')
     OR to_regprocedure('public.crm_sale_collab_doc(uuid)') IS NULL THEN
    RAISE EXCEPTION 'CRM sale booking department: tg_orders_dept_override / order_dept_override / collabbox_department changed, or 20260947000200 is missing';
  END IF;
END
$drift$;

-- ── 1. the booking's department of a CRM sale ───────────────────────────────
CREATE OR REPLACE FUNCTION public.crm_sale_booking_dept(p_order uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT public.cohort_order_source(x.dep[1], x.dep[2], d.doc_number)
  FROM public.orders o
  JOIN public.collabbox_documents d ON d.doc_number = public.crm_sale_collab_doc(o.id)
  CROSS JOIN LATERAL (SELECT public.collabbox_department(d.doc_type_id, d.doc_number, d.author_person_id, d.doc_at) AS dep) x
  WHERE o.id = p_order
    AND o.sale_source = 'elyon_crm'
    AND o.sale_source_detail IN ('prediction_list', 'direct')
    AND d.doc_type_id IN ('10050', '10036', '10106', '10055', '10114', '10111')
    AND (d.order_id = o.id OR d.related_order_id = o.id
         OR (o.sold_by_person_id IS NOT NULL AND d.author_person_id = o.sold_by_person_id))
    AND x.dep IS NOT NULL
$fn$;
COMMENT ON FUNCTION public.crm_sale_booking_dept(uuid) IS
  'Owner 02.10.2026: the department of a CRM sale''s own collabBox booking (crm_sale_collab_doc, linked to the order or booked by its seller) = the cohort''s booking department, cohort_order_source(collabbox_department(…)) — or NULL. Feeds orders.dept_override until the MEX parcel decides. Migration 20260947000300.';

-- ── 2. the orders trigger: the parcel first, then the booking ───────────────
CREATE OR REPLACE FUNCTION public.tg_orders_dept_override()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  NEW.dept_override := coalesce(
    public.order_dept_override(NEW.sale_source, NEW.sale_source_detail, NEW.sold_by_person_id,
                               coalesce(NEW.sold_at, NEW.created_at), NEW.mex_account, NEW.mex_tracking_id),
    -- no parcel yet: the sale's own collabBox booking (20260947000300); on INSERT the row does not exist yet
    CASE WHEN TG_OP = 'UPDATE' AND NEW.mex_tracking_id IS NULL
              AND NEW.sale_source = 'elyon_crm' AND NEW.sale_source_detail IN ('prediction_list', 'direct')
         THEN public.crm_sale_booking_dept(NEW.id) END);
  RETURN NEW;
END
$fn$;

COMMENT ON COLUMN public.orders.dept_override IS
  'The department a CRM-made sale takes (20260942001860 + 20260947000300): its MEX parcel''s profile (BIO NATURAL → elyon_crm, NATURA → by series), else its own collabBox booking''s folder (crm_sale_booking_dept), else NULL = THE mapping (cohort_order_source 3-arg). Maintained by tg_orders_zz_dept_override and the cron crm-sale-booking-dept — never write it by hand.';

-- ── 3. the 15-minute pass: a booking arrives through the collabBox sync ─────
CREATE OR REPLACE FUNCTION public.crm_sale_booking_dept_sync()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _n integer;
BEGIN
  PERFORM set_config('elyon.keep_updated_at', 'on', true);   -- GET /call-agains reads updated_at
  WITH c AS (
    SELECT o.id, o.dept_override AS cur, public.crm_sale_booking_dept(o.id) AS want
    FROM public.orders o
    WHERE o.status = 'confirmed'
      AND o.sale_source = 'elyon_crm'
      AND o.sale_source_detail IN ('prediction_list', 'direct')
      AND o.mex_tracking_id IS NULL
      AND coalesce(o.sold_at, o.confirmed_at, o.created_at) >= now() - interval '60 days'
  ), upd AS (
    UPDATE public.orders o SET dept_override = c.want
      FROM c
     WHERE o.id = c.id AND c.cur IS DISTINCT FROM c.want
       AND o.mex_tracking_id IS NULL AND o.status = 'confirmed'
    RETURNING o.id
  )
  SELECT count(*) INTO _n FROM upd;
  RETURN jsonb_build_object('ok', true, 'changed', _n);
END
$fn$;
COMMENT ON FUNCTION public.crm_sale_booking_dept_sync() IS
  'Owner 02.10.2026: every 15 minutes (cron crm-sale-booking-dept) — each confirmed CRM sale without a parcel (≤ 60 days) takes its own collabBox booking''s department (crm_sale_booking_dept), or back to NULL when the booking is gone; updated_at kept. Migration 20260947000300.';

DO $g$
BEGIN
  REVOKE ALL ON FUNCTION public.crm_sale_booking_dept(uuid)   FROM PUBLIC, anon, authenticated;
  REVOKE ALL ON FUNCTION public.crm_sale_booking_dept_sync() FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.crm_sale_booking_dept(uuid)   TO service_role;
  GRANT EXECUTE ON FUNCTION public.crm_sale_booking_dept_sync() TO service_role;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    GRANT EXECUTE ON FUNCTION public.crm_sale_booking_dept(uuid) TO supabase_read_only_user;
  END IF;
END
$g$;

DO $cron$
BEGIN
  PERFORM cron.unschedule(j.jobid) FROM cron.job j WHERE j.jobname = 'crm-sale-booking-dept';
  PERFORM cron.schedule('crm-sale-booking-dept', '7,22,37,52 * * * *', 'SELECT public.crm_sale_booking_dept_sync();');
END
$cron$;

-- the first pass now
SELECT public.crm_sale_booking_dept_sync();

COMMIT;
