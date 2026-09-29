-- A CRM-made sale's department follows its MEX PROFILE (owner, 29.09.2026 ~12:05–12:10):
--   "Every order sent to MEX via BIO NATURAL comes from affiliate IN and OUT; no teleshop order has ever
--    been sent via BIO NATURAL — teleshop sends via NATURA" · "web e-commerce is entirely via NATURA" ·
--   earlier the same morning: "if an affiliate agent makes an order in our CRM first, it counts in
--    Affiliate out, and we look at MEX — BIO NATURAL or NATURA — and decide by that".
--
-- orders.dept_override (the reserved slot of 20260942001800, reset by …1850) now carries that rule for
-- a CRM-made sale (elyon_crm prediction_list / direct):
--   · parcel on BIO NATURAL → Affiliate – Lead out, whatever its series (6 September list sales on a
--     BIO NATURAL 9102 number were Телешоп – Lead out by series);
--   · parcel on NATURA      → by series: 9100 → Телешоп – Lead in, 9108 / 1300 → social, anything else
--     (9102, 9103 …) → Телешоп – Lead out;
--   · no parcel yet         → NULL = THE mapping (Affiliate – Lead out) until MEX shows the profile.
-- Every other order: NULL (the collabBox folder decides; a LEADS-OUT folder is Affiliate – Lead out).
-- A MEX-only parcel (cohort_parcel_split): BIO NATURAL → affiliate before any other test (9110 → Lead
-- in, anything else → Lead out) — never web, never teleshop.
-- The agent-team rule and its sales_team_members trigger are gone; the orders trigger re-decides when
-- the source, the seller, the sale time or the parcel (account / tracking id) changes.

BEGIN;

SET LOCAL lock_timeout = '10s';

DO $drift$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.cohort_parcel_split(text,text,text,text)')
                   AND md5(replace(p.prosrc, chr(13), '')) IN ('7fbafa51247efed942313022febbe536', '5846692c55fa566bffc80cb5d42e4c8b'))
     OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.tg_orders_dept_override()')
                   AND md5(replace(p.prosrc, chr(13), '')) IN ('a864aea369f34295eb2cc30a7b8ade25', 'c84b07bcf9fe03c3e425176524fc57c9')) THEN
    RAISE EXCEPTION 'department by MEX profile: cohort_parcel_split / tg_orders_dept_override changed since this migration was written';
  END IF;
END
$drift$;

-- ── 1. the rule for a CRM-made sale ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.order_dept_override(p_sale_source text, p_detail text, p_person uuid, p_at timestamptz,
                                                     p_account text, p_tracking text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $fn$
  SELECT CASE
    WHEN p_sale_source = 'elyon_crm' AND p_detail IN ('prediction_list', 'direct') THEN
      CASE WHEN p_account = 'bio_natural' THEN 'elyon_crm'
           WHEN p_account = 'natura' THEN
             CASE WHEN p_tracking LIKE '___-9100-%'                                   THEN 'teleshop_other'
                  WHEN p_tracking LIKE '___-9108-%' OR p_tracking LIKE '___-1300-%'  THEN 'social'
                  ELSE 'teleshop_out' END
      END
  END
$fn$;
COMMENT ON FUNCTION public.order_dept_override(text, text, uuid, timestamptz, text, text) IS
  'Owner 29.09.2026: a CRM-made sale follows its MEX profile — BIO NATURAL → Affiliate – Lead out, NATURA → by series (9100 teleshop in, 9108/1300 social, else teleshop out), no parcel → NULL (THE mapping). Everything else NULL. Migration 20260942001860.';
DO $g$
BEGIN
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.order_dept_override(text, text, uuid, timestamptz, text, text) TO service_role';
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.order_dept_override(text, text, uuid, timestamptz, text, text) TO supabase_read_only_user';
  END IF;
END
$g$;

-- ── 2. the orders trigger: also on a parcel change ──────────────────────────
CREATE OR REPLACE FUNCTION public.tg_orders_dept_override()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  NEW.dept_override := public.order_dept_override(NEW.sale_source, NEW.sale_source_detail, NEW.sold_by_person_id,
                                                  coalesce(NEW.sold_at, NEW.created_at), NEW.mex_account, NEW.mex_tracking_id);
  RETURN NEW;
END
$fn$;
DROP TRIGGER IF EXISTS tg_orders_zz_dept_override ON public.orders;
CREATE TRIGGER tg_orders_zz_dept_override
  BEFORE INSERT OR UPDATE OF sale_source, sale_source_detail, sold_by_person_id, sold_at, mex_account, mex_tracking_id
  ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.tg_orders_dept_override();

-- the team rule is gone: no re-decision on a team change
DROP TRIGGER IF EXISTS tg_sales_team_members_dept_override ON public.sales_team_members;
DROP FUNCTION IF EXISTS public.tg_sales_team_members_dept_override();

COMMENT ON COLUMN public.orders.dept_override IS
  'The department a CRM-made sale takes from its MEX profile (20260942001860): BIO NATURAL → elyon_crm (Affiliate – Lead out), NATURA → by series; NULL = THE mapping (cohort_order_source 3-arg). Maintained by tg_orders_zz_dept_override — never write it by hand.';

-- ── 3. MEX-only parcels: BIO NATURAL is affiliate before anything else ─────
CREATE OR REPLACE FUNCTION public.cohort_parcel_split(p_account text, p_series text, p_tracking text, p_sender_ref text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
AS $function$
  SELECT CASE
    -- BIO NATURAL is affiliate IN and OUT, whatever the series or the sender reference: no teleshop,
    -- social or web order is ever sent via BIO NATURAL (owner, 29.09.2026 ~12:10 — "web
    -- e-commerce is entirely via NATURA"; 20260942001860)
    WHEN p_account = 'bio_natural' AND p_series = '9110'                         THEN 'mex_leads'
    WHEN p_account = 'bio_natural'                                               THEN 'mex_leads_out'
    WHEN coalesce(p_tracking, '') ~ '^NTMK' OR coalesce(p_sender_ref, '') ~ '^NTMK' THEN 'mex_web'
    WHEN coalesce(p_tracking, '') ~ '^M[0-9]'                                    THEN 'mex_web'
    WHEN p_series = '9110'                                                       THEN 'mex_leads'
    WHEN p_series = '9103'                                                       THEN 'mex_leads_out'
    WHEN p_series = '9102'                                                       THEN 'mex_out'
    WHEN p_series = '9100'                                                       THEN 'mex_in'
    WHEN p_series IN ('9108', '1300')                                            THEN 'mex_social'
    ELSE 'mex_other'
  END
$function$;

-- ── 4. every existing CRM sale ──────────────────────────────────────────────
SET LOCAL elyon.keep_updated_at = 'on';
SET LOCAL elyon.bulk_repair = 'on';
UPDATE public.orders o
   SET dept_override = public.order_dept_override(o.sale_source, o.sale_source_detail, o.sold_by_person_id,
                                                  coalesce(o.sold_at, o.created_at), o.mex_account, o.mex_tracking_id)
 WHERE o.dept_override IS DISTINCT FROM public.order_dept_override(o.sale_source, o.sale_source_detail, o.sold_by_person_id,
                                                  coalesce(o.sold_at, o.created_at), o.mex_account, o.mex_tracking_id);

COMMIT;
