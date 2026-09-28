-- Departments are by FOLDER, never by the seller's team (owner, 28.09.2026 ~23:55): "we never mix
-- our CRM with affiliate lead out … it doesn't matter in which system an order was made — we look by
-- departments; affiliate lead out stays affiliate lead out". The AlterCPA-team override of
-- 20260942000700 (a CRM sale of an AlterCPA-team agent → altercpa/team_prediction) is withdrawn: her
-- CRM prediction sale is Affiliate – Lead out like anyone's. tg_orders_stamp_sold keeps the
-- no-revive guard (20260942000800) and the attribution re-point (20260942000400) and never touches
-- sale_source again. The existing team_* rows move back in scripts/reclass-by-folder.mjs.
-- Payout / bonus math is NOT touched.

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
  -- POST /orders/:id/attribution changes a SET confirmed_by_agent_id): the seller follows.
  -- sold_at never moves. (The department never depends on the seller — 20260942001100.)
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
  RETURN NEW;
END;
$function$;

COMMIT;
