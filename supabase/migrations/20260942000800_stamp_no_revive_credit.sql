-- The live sold-stamp never credits a MEX revival to "now" and the old assigned agent
-- (leaderboard audit, 28.09.2026): when mex-reconcile or a repair turns an old order that was NOT a
-- sale (cancelled / trashed / pending) into shipped / paid / returned and nobody confirmed it now,
-- tg_orders_stamp_sold used to stamp sold_at = now() and credit the order's old confirmed/assigned
-- name — e.g. a lead cancelled in July, revived today on another channel's parcel, credited today to
-- an operator who left in August. Such rows are left to the stamp-order-deciders cron, which credits
-- by its rules (collabBox author at the booking time, the AlterCPA decision). CRM confirmations,
-- inserts and the admin attribution correction behave exactly as before (20260942000700).
-- Backfill: the 6 orders stamped that way on 28.09 lose the wrong stamp (the cron re-stamps the ones
-- that are sales). Payout / bonus math is NOT touched.

BEGIN;

CREATE OR REPLACE FUNCTION public.tg_orders_stamp_sold()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _name   text;
  _via    text;
  _person uuid;
BEGIN
  -- An already-credited CRM sale whose confirmer is re-pointed (only the admin-only
  -- POST /orders/:id/attribution changes a SET confirmed_by_agent_id): the seller follows, and so
  -- does the department (an AlterCPA-team seller → AlterCPA, 20260942000700). sold_at never moves.
  IF TG_OP = 'UPDATE' AND NEW.sold_at IS NOT NULL AND OLD.sold_via = 'crm'
     AND OLD.confirmed_by_agent_id IS NOT NULL AND NEW.confirmed_by_agent_id IS NOT NULL
     AND NEW.confirmed_by_agent_id <> OLD.confirmed_by_agent_id THEN
    BEGIN
      SELECT sp.id INTO _person FROM public.sales_people sp WHERE sp.user_id = NEW.confirmed_by_agent_id;
    EXCEPTION WHEN OTHERS THEN
      _person := NULL;
    END;
    NEW.sold_by_person_id := _person;
    NEW.sold_by_ext       := coalesce(nullif(btrim(NEW.confirmed_by_name), ''), NEW.confirmed_by_agent_id::text);
    IF NEW.sale_source = 'elyon_crm' AND NEW.sale_source_detail IN ('prediction_list', 'direct')
       AND public.sales_person_in_team(_person, 'altercpa_leads', NEW.sold_at) THEN
      NEW.sale_source := 'altercpa'; NEW.sale_source_detail := 'team_prediction';
    ELSIF NEW.sale_source = 'altercpa' AND NEW.sale_source_detail = 'team_prediction'
       AND NOT public.sales_person_in_team(_person, 'altercpa_leads', NEW.sold_at) THEN
      NEW.sale_source := 'elyon_crm';
      NEW.sale_source_detail := public.elyon_crm_sale_detail(NEW.prediction_list_id, NEW.price, NEW.product_name);
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.sold_at IS NOT NULL THEN
    RETURN NEW;                                   -- write-once
  END IF;
  IF NEW.status::text NOT IN ('confirmed', 'shipped', 'delivered', 'paid', 'returned')
     OR coalesce(NEW.price, 0) <= 0
     OR public.is_synthetic_product_name(NEW.product_name) THEN
    RETURN NEW;                                   -- not a real sale
  END IF;
  -- MEX (or a repair) revived an order that was not a sale — cancelled / trashed / pending → shipped /
  -- paid / returned — and nobody confirmed it now: that is not a CRM decision of today. The
  -- stamp-order-deciders cron credits it by its rules (the collabBox author at the booking time, the
  -- AlterCPA decision), never "now" and the old assigned agent (20260942000800, leaderboard audit 28.09).
  IF TG_OP = 'UPDATE'
     AND NEW.status::text IN ('shipped', 'delivered', 'paid', 'returned')
     AND OLD.status::text NOT IN ('confirmed', 'shipped', 'delivered', 'paid', 'returned')
     AND OLD.confirmed_by_agent_id IS NOT DISTINCT FROM NEW.confirmed_by_agent_id
     AND OLD.confirmed_by_name IS NOT DISTINCT FROM NEW.confirmed_by_name THEN
    RETURN NEW;
  END IF;

  _name := nullif(btrim(NEW.confirmed_by_name), '');
  IF lower(_name) IN ('import', 'system') THEN
    _name := NULL;
  END IF;
  IF _name IS NULL AND NEW.source_type = 'import' THEN
    _name := nullif(btrim(NEW.assigned_agent_name), '');
  END IF;
  IF NEW.confirmed_by_agent_id IS NULL AND _name IS NULL THEN
    RETURN NEW;                                   -- nobody named: backfill / sync attribute it
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.status::text IN ('confirmed', 'shipped', 'delivered', 'paid', 'returned') THEN
    IF NOT ((OLD.confirmed_by_agent_id IS NULL AND NEW.confirmed_by_agent_id IS NOT NULL)
         OR (OLD.confirmed_by_name     IS NULL AND NEW.confirmed_by_name     IS NOT NULL)) THEN
      RETURN NEW;
    END IF;
    IF NEW.source_type = 'altercpa' OR NEW.external_source = 'altercpa' THEN
      RETURN NEW;
    END IF;
  END IF;

  _via := CASE WHEN NEW.source_type = 'import'
               THEN CASE WHEN NEW.external_source = 'collabbox' THEN 'collabbox' ELSE 'import' END
               ELSE 'crm'
          END;

  BEGIN
    IF NEW.confirmed_by_agent_id IS NOT NULL THEN
      SELECT sp.id INTO _person
        FROM public.sales_people sp
       WHERE sp.user_id = NEW.confirmed_by_agent_id;
    END IF;
    IF _person IS NULL AND _name IS NOT NULL THEN
      SELECT i.person_id INTO _person
        FROM public.sales_person_identities i
       WHERE i.account_id IS NULL
         AND i.value = _name
         AND i.kind IN ('order_name', 'collabbox_author')
       ORDER BY (i.kind = CASE WHEN _via = 'collabbox' THEN 'collabbox_author' ELSE 'order_name' END) DESC
       LIMIT 1;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    _person := NULL;
  END;

  NEW.sold_at           := coalesce(NEW.confirmed_at, now());
  NEW.sold_via          := _via;
  NEW.sold_by_person_id := _person;
  NEW.sold_by_ext       := coalesce(_name, NEW.confirmed_by_agent_id::text);
  -- a CRM sale made by an AlterCPA-team agent counts in AlterCPA (owner 28.09.2026)
  IF _via = 'crm' AND NEW.sale_source = 'elyon_crm' AND NEW.sale_source_detail IN ('prediction_list', 'direct')
     AND public.sales_person_in_team(_person, 'altercpa_leads', NEW.sold_at) THEN
    NEW.sale_source        := 'altercpa';
    NEW.sale_source_detail := 'team_prediction';
  END IF;
  RETURN NEW;
END;
$function$;

SET LOCAL elyon.keep_updated_at = 'on';
SET LOCAL elyon.bulk_repair = 'on';
SET LOCAL elyon.allow_sold_change = 'on';
UPDATE public.orders
   SET sold_at = NULL, sold_by_person_id = NULL, sold_via = NULL, sold_by_ext = NULL
 WHERE display_id IN ('ORD-78553', 'ORD-80544', 'ORD-77935', 'ORD-76196', 'ORD-93318', 'ORD-81079')
   AND sold_at >= TIMESTAMPTZ '2026-09-27 22:00+00';
SET LOCAL elyon.allow_sold_change = 'off';

COMMIT;
