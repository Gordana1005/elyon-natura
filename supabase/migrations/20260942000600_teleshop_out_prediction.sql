-- Teleshop "lead out" is prediction when the agent works in our CRM (owner, 28.09.2026):
--   "teleshop lead out — all the agents should be working on CRM; lead in no (we have no
--    importing of lead in directly into pendings and they don't work on the CRM), so we count
--    lead in under teleshop. The lead out, if it counts both in prediction and teleshop, it's a
--    mistake: every order from teleshop lead out should be coming out of our CRM, since 01
--    September. There might be agents still not using our CRM — map who works lead out and who
--    logs into our system, based on the orders created in our system."
--   + for LEADS-OUT (9103) booked only in collabBox: "Да, од денот кога почнала CRM".
--
-- So a collabBox document of series 9102 ("Нарачка out", NATURA) or 9103 ("LEADS-OUT", BIO
-- NATURAL) whose author is a person who works in our CRM counts as an ElyonCRM PREDICTION sale
-- credited to that person — from the day she started working in the CRM (never before
-- 01.09.2026), until the day she stopped (if she did). 9100 "Нарачка in" (the TV lead-in) stays
-- Teleshop whoever booked it. Managers never earn → their documents stay Teleshop.
-- "Works in our CRM" = a CRM login, not a manager, CRM activity (order_history rows under her
-- login) since 01.09 AND at least one CRM-made sale she confirmed: sales_people.crm_since /
-- crm_until below, measured from the live rows on 28.09.2026 (editable later).
--
-- One order, one source: the SAME order row moves from collabbox/teleshop to elyon_crm (never a
-- copy); every move is recorded in sale_source_reclass (before → after) for audit and rollback.
-- New imports classify the same way at INSERT (tg_orders_sale_source_fill). Details:
--   collabbox_out        series 9102 by a CRM-working agent
--   collabbox_leads_out  series 9103 by a CRM-working agent
-- Payout / bonus / commission math is NOT touched (deferred by the owner).

BEGIN;

-- ── 1. who works in our CRM, and since when ─────────────────────────────────
ALTER TABLE public.sales_people ADD COLUMN IF NOT EXISTS crm_since date;
ALTER TABLE public.sales_people ADD COLUMN IF NOT EXISTS crm_until date;
COMMENT ON COLUMN public.sales_people.crm_since IS
  'First Skopje day this person worked in our CRM (order_history under her login + a CRM-made sale; never before 2026-09-01). From this day her collabBox 9102 "Нарачка out" / 9103 "LEADS-OUT" documents count as ElyonCRM prediction sales (collabbox_prediction_detail). NULL = does not work in the CRM. Migration 20260942000600 (owner 28.09.2026).';
COMMENT ON COLUMN public.sales_people.crm_until IS
  'Last Skopje day of CRM work when she stopped (no CRM activity for 7+ days on 2026-09-28); NULL = still working in the CRM. Migration 20260942000600.';

-- ── 2. the rule ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.collabbox_prediction_detail(p_external_order_id text, p_person uuid, p_at timestamptz)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $fn$
  SELECT CASE split_part(coalesce(p_external_order_id, ''), '-', 2)
           WHEN '9102' THEN 'collabbox_out'
           WHEN '9103' THEN 'collabbox_leads_out'
         END
   WHERE split_part(coalesce(p_external_order_id, ''), '-', 2) IN ('9102', '9103')
     AND p_person IS NOT NULL AND p_at IS NOT NULL
     AND (p_at AT TIME ZONE 'Europe/Skopje')::date >= DATE '2026-09-01'
     AND EXISTS (SELECT 1 FROM public.sales_people sp
                  WHERE sp.id = p_person AND sp.user_id IS NOT NULL AND NOT sp.is_manager
                    AND sp.crm_since IS NOT NULL
                    AND (p_at AT TIME ZONE 'Europe/Skopje')::date >= sp.crm_since
                    AND (sp.crm_until IS NULL OR (p_at AT TIME ZONE 'Europe/Skopje')::date <= sp.crm_until));
$fn$;

COMMENT ON FUNCTION public.collabbox_prediction_detail(text, uuid, timestamptz) IS
  'Owner rule 28.09.2026: a collabBox 9102 "Нарачка out" / 9103 "LEADS-OUT" document booked by a person who works in our CRM (sales_people.crm_since … crm_until, not a manager, login) on or after 2026-09-01 is an ElyonCRM prediction sale → detail collabbox_out / collabbox_leads_out; otherwise NULL (stays collabbox). 9100 "Нарачка in" never. Migration 20260942000600.';

-- ── 3. new rows classify the same way at INSERT ──────────────────────────────
CREATE OR REPLACE FUNCTION public.tg_orders_sale_source_fill()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _o record;
  _c text[];
  _d text;
BEGIN
  IF NEW.sale_source IS NOT NULL THEN
    RETURN NEW;
  END IF;

  BEGIN
    IF NEW.duplicated_from IS NOT NULL THEN
      SELECT o.sale_source, o.sale_source_detail, o.source_type, o.external_source,
             o.external_order_id, o.prediction_list_id, o.price, o.product_name
        INTO _o
        FROM public.orders o
       WHERE o.id = NEW.duplicated_from;
      IF FOUND THEN
        IF _o.sale_source IS NOT NULL THEN
          NEW.sale_source        := _o.sale_source;
          NEW.sale_source_detail := _o.sale_source_detail;
        ELSE
          _c := public.classify_sale_source(_o.source_type, _o.external_source, _o.external_order_id,
                                            _o.prediction_list_id, _o.price, _o.product_name);
          NEW.sale_source        := _c[1];
          NEW.sale_source_detail := _c[2];
        END IF;
        -- A copy of a CRM order is a CRM order, but whether it is a SALE is its own business:
        -- a duplicated call-outcome row that is priced is a real sale (20260942000400).
        IF NEW.sale_source = 'elyon_crm' THEN
          NEW.sale_source_detail := public.elyon_crm_sale_detail(
            coalesce(NEW.prediction_list_id, _o.prediction_list_id), NEW.price, NEW.product_name);
        END IF;
        RETURN NEW;
      END IF;
    END IF;

    _c := public.classify_sale_source(NEW.source_type, NEW.external_source, NEW.external_order_id,
                                      NEW.prediction_list_id, NEW.price, NEW.product_name);
    NEW.sale_source        := _c[1];
    NEW.sale_source_detail := _c[2];
    -- teleshop lead out / LEADS-OUT booked by an agent who works in our CRM = prediction (20260942000600)
    IF NEW.sale_source = 'collabbox' THEN
      _d := public.collabbox_prediction_detail(NEW.external_order_id, NEW.sold_by_person_id, coalesce(NEW.sold_at, NEW.created_at));
      IF _d IS NOT NULL THEN
        NEW.sale_source        := 'elyon_crm';
        NEW.sale_source_detail := _d;
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NEW.sale_source        := NULL;
    NEW.sale_source_detail := NULL;
  END;
  RETURN NEW;
END;
$function$;

-- ── 4. the audit trail of every source move ──────────────────────────────────
CREATE TABLE IF NOT EXISTS public.sale_source_reclass (
  order_id     uuid PRIMARY KEY REFERENCES public.orders(id) ON DELETE CASCADE,
  from_source  text NOT NULL,
  from_detail  text,
  to_source    text NOT NULL,
  to_detail    text,
  reason       text NOT NULL,
  moved_at     timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.sale_source_reclass IS
  'Every deliberate move of orders.sale_source after insert (owner rules), before → after, for audit and rollback (UPDATE … SET sale_source = from_source under SET LOCAL elyon.allow_source_change). Migration 20260942000600.';
ALTER TABLE public.sale_source_reclass ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sale_source_reclass FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sale_source_reclass TO service_role;

-- ── 5. backfill: who works in the CRM (measured on the live rows, 28.09.2026) ─
WITH act AS (
  SELECT sp.id,
         min((h.changed_at AT TIME ZONE 'Europe/Skopje')::date) AS first_day,
         max((h.changed_at AT TIME ZONE 'Europe/Skopje')::date) AS last_day
    FROM public.sales_people sp
    JOIN public.order_history h ON h.changed_by = sp.user_id AND h.changed_at >= TIMESTAMPTZ '2026-08-31 22:00+00'
   WHERE sp.user_id IS NOT NULL AND NOT sp.is_manager
     AND EXISTS (SELECT 1 FROM public.orders o
                  WHERE o.confirmed_by_agent_id = sp.user_id AND o.sale_source = 'elyon_crm'
                    AND o.sale_source_detail <> 'disposition'
                    AND o.confirmed_at >= TIMESTAMPTZ '2026-08-31 22:00+00')
   GROUP BY sp.id
)
UPDATE public.sales_people sp
   SET crm_since = greatest(act.first_day, DATE '2026-09-01'),
       crm_until = CASE WHEN act.last_day < (now() AT TIME ZONE 'Europe/Skopje')::date - 7 THEN act.last_day END
  FROM act
 WHERE act.id = sp.id;

-- ── 6. backfill: the documents already imported move, once, as the same rows ─
SET LOCAL elyon.keep_updated_at = 'on';
SET LOCAL elyon.bulk_repair = 'on';
SET LOCAL elyon.allow_source_change = 'on';

CREATE TEMP TABLE _mv ON COMMIT DROP AS
SELECT o.id, o.sale_source AS from_source, o.sale_source_detail AS from_detail,
       public.collabbox_prediction_detail(o.external_order_id, o.sold_by_person_id, coalesce(o.sold_at, o.created_at)) AS to_detail
  FROM public.orders o
 WHERE o.sale_source = 'collabbox' AND o.external_source = 'collabbox'
   AND split_part(coalesce(o.external_order_id, ''), '-', 2) IN ('9102', '9103')
   AND coalesce(o.sold_at, o.created_at) >= TIMESTAMPTZ '2026-08-31 22:00+00';
DELETE FROM _mv WHERE to_detail IS NULL;

INSERT INTO public.sale_source_reclass (order_id, from_source, from_detail, to_source, to_detail, reason)
SELECT id, from_source, from_detail, 'elyon_crm', to_detail,
       'owner 28.09.2026: teleshop lead out / LEADS-OUT by an agent who works in our CRM = prediction'
  FROM _mv
ON CONFLICT (order_id) DO NOTHING;

UPDATE public.orders o
   SET sale_source = 'elyon_crm', sale_source_detail = m.to_detail
  FROM _mv m
 WHERE m.id = o.id;

SET LOCAL elyon.allow_source_change = 'off';

COMMIT;
