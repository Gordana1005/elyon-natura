-- ============================================================================
-- The department trigger fires AFTER the seller stamp (fix, 02.10.2026)
-- ============================================================================
-- 20260947000400 made the seller's team decide the department, read by tg_orders_dept_override from
-- NEW.sold_by_person_id. Two gaps showed on production within the hour (ORD-363140, a Телешоп Out agent's CRM sale
-- confirmed 13:44, stored as Affiliate – Lead out):
--   1. BEFORE triggers fire in NAME order: "tg_orders_zz_dept_override" sorts BEFORE "trg_orders_stamp_sold" ('g' < 'r'),
--      so on INSERT the department was decided before the seller was stamped (the 20260942001800 comment assumed the
--      opposite; harmless until the seller mattered);
--   2. a confirm is an UPDATE OF status: the stamp trigger sets sold_by_person_id, but the department trigger listens to
--      UPDATE OF sale_source, sale_source_detail, sold_by_person_id, sold_at, mex_account, mex_tracking_id — the columns
--      the STATEMENT names, never the ones another trigger fills — so it did not fire at all.
-- Fix: the same function under the name "zzz_orders_dept_override" (sorts after every trg_* / trigger_* BEFORE trigger)
-- and the stamp trigger's columns added (status, confirmed_by_agent_id, confirmed_by_name). Then the orders stamped
-- since 20260947000400 are re-decided (orders_dept_recompute's rule, the last 3 days).
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $drift$
BEGIN
  IF to_regprocedure('public.order_dept_decide(text,text,uuid,timestamptz,text,text,uuid)') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.orders'::regclass AND tgname = 'tg_orders_zz_dept_override')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.orders'::regclass AND tgname = 'trg_orders_stamp_sold') THEN
    RAISE EXCEPTION 'dept trigger order: 20260947000400 / the stamp trigger missing';
  END IF;
END
$drift$;

DROP TRIGGER IF EXISTS tg_orders_zz_dept_override ON public.orders;
DROP TRIGGER IF EXISTS zzz_orders_dept_override ON public.orders;
CREATE TRIGGER zzz_orders_dept_override
  BEFORE INSERT OR UPDATE OF sale_source, sale_source_detail, sold_by_person_id, sold_at, mex_account, mex_tracking_id,
                             status, confirmed_by_agent_id, confirmed_by_name
  ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.tg_orders_dept_override();
COMMENT ON TRIGGER zzz_orders_dept_override ON public.orders IS
  'The stored department (order_dept_decide) — named zzz_ so it fires after trg_orders_stamp_sold (BEFORE triggers run in name order) and listening to the stamp''s columns too (status / confirmed_by_*), so a confirm decides with the stamped seller. Migration 20260947000600.';

COMMENT ON COLUMN public.orders.dept_override IS
  'THE stored department decision (20260947000400, owner 02.10.2026): order_dept_decide = the seller''s team (a lead excepted) → a CRM sale''s MEX profile → a CRM sale''s own collabBox booking → NULL (the folder / series mapping, cohort_order_source 3-arg). Maintained by zzz_orders_dept_override (20260947000600), tg_sales_team_members_dept and the cron crm-sale-booking-dept — never write it by hand.';

-- re-decide what the gap left behind (orders created or changed since 20260947000400)
SET LOCAL elyon.keep_updated_at = 'on';
WITH c AS (
  SELECT o.id, o.dept_override AS cur,
         public.order_dept_decide(o.sale_source, o.sale_source_detail, o.sold_by_person_id,
                                  coalesce(o.sold_at, o.created_at), o.mex_account, o.mex_tracking_id, o.id) AS want
  FROM public.orders o
  WHERE o.updated_at >= now() - interval '3 days' OR o.created_at >= now() - interval '3 days'
     OR coalesce(o.sold_at, o.created_at) >= now() - interval '3 days'
)
UPDATE public.orders o SET dept_override = c.want
  FROM c
 WHERE o.id = c.id AND c.cur IS DISTINCT FROM c.want;

COMMIT;
