-- ElyonCRM sales: every sale made in our CRM counts, and counts for the agent who made it
-- (owner, 28.09.2026: "every order made from our CRM must be counted — in prediction and on the
-- Leaderboard — never in two places, always accurate").
--
-- Two gaps found on 28.09 (read-only trace of every CRM sale, 30.08–28.09):
--
-- 1. sale_source_detail is decided ONCE, at insert, from the price. A CRM call-outcome row
--    (price 0 → 'disposition') that an agent or manager later turns into a real sale — or a
--    DUPLICATE of such a row, which inherited 'disposition' from its original — stayed
--    'disposition' for ever, and 'disposition' is excluded from the cohort, the Overview, the
--    Прогнозни списоци tab and the TV board. Seen live: ORD-109265 (28.09, 2.000 ден).
--    Fix: (a) a duplicate of an elyon_crm order classifies its detail from ITS OWN price and
--    product (the source stays elyon_crm); (b) an elyon_crm 'disposition' order that becomes a
--    sale (a sale status, price > 0, a real product) is upgraded to prediction_list / direct —
--    the ONLY change sale_source_detail ever makes after insert (disposition → sale, never back,
--    never another source).
--
-- 2. orders.sold_* credit whoever pressed Confirm and are write-once, so the admin-only
--    attribution correction (POST /orders/:id/attribution — it re-points confirmed_by_*) never
--    reached the TV board / Insights: a manager who confirmed or duplicated an agent's sale kept
--    it (managers never earn on the board). Fix: for a CRM-made sale (sold_via 'crm'), a change
--    of an already-set confirmed_by_agent_id — only that endpoint does it — re-points
--    sold_by_person_id / sold_by_ext to the new confirmer. sold_at (WHEN) never moves.
--
-- Backfill: the 1 disposition-now-sale order and the 6 CRM sales whose admin attribution
-- correction never reached sold_* (ORD-91526, 91871, 91872, 92547, 95221, 109265).
-- Payout / bonus / commission math is NOT touched (deferred by the owner).

BEGIN;

-- ── 1a. duplicates of a CRM order classify from their own price ─────────────
CREATE OR REPLACE FUNCTION public.tg_orders_sale_source_fill()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _o record;
  _c text[];
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
  EXCEPTION WHEN OTHERS THEN
    NEW.sale_source        := NULL;
    NEW.sale_source_detail := NULL;
  END;
  RETURN NEW;
END;
$function$;

-- ── 1b. a CRM call-outcome row that becomes a real sale is a sale ────────────
CREATE OR REPLACE FUNCTION public.tg_orders_sale_detail_upgrade()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _d text;
BEGIN
  IF NEW.status::text IN ('confirmed', 'shipped', 'delivered', 'paid', 'returned') THEN
    _d := public.elyon_crm_sale_detail(NEW.prediction_list_id, NEW.price, NEW.product_name);
    IF _d <> 'disposition' THEN
      NEW.sale_source_detail := _d;     -- UPDATE OF price/status/…: the source lock does not fire
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.tg_orders_sale_detail_upgrade() IS
  'BEFORE UPDATE OF price, status, product_name, prediction_list_id on an elyon_crm ''disposition'' order: once it is a sale (sale status, price > 0, a real product) its detail becomes prediction_list / direct (elyon_crm_sale_detail). The only post-insert change of sale_source_detail; never back to disposition, never another source. Migration 20260942000400 (owner 28.09.2026: every CRM sale counts).';

DROP TRIGGER IF EXISTS trg_orders_sale_detail_upgrade ON public.orders;
CREATE TRIGGER trg_orders_sale_detail_upgrade
  BEFORE UPDATE OF price, status, product_name, prediction_list_id ON public.orders
  FOR EACH ROW
  WHEN (OLD.sale_source = 'elyon_crm' AND OLD.sale_source_detail = 'disposition')
  EXECUTE FUNCTION public.tg_orders_sale_detail_upgrade();

-- ── 2. the admin attribution correction re-points a CRM sale's seller ─────────
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
  -- sold_at (when) never moves. 20260942000400.
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

-- ── backfill ─────────────────────────────────────────────────────────────────
SET LOCAL elyon.keep_updated_at = 'on';
SET LOCAL elyon.bulk_repair = 'on';

-- the disposition rows that are sales today
SET LOCAL elyon.allow_source_change = 'on';
UPDATE public.orders o
   SET sale_source_detail = public.elyon_crm_sale_detail(o.prediction_list_id, o.price, o.product_name)
 WHERE o.sale_source = 'elyon_crm' AND o.sale_source_detail = 'disposition'
   AND o.status::text IN ('confirmed', 'shipped', 'delivered', 'paid', 'returned')
   AND o.price > 0 AND NOT public.is_synthetic_product_name(o.product_name);
SET LOCAL elyon.allow_source_change = 'off';

-- CRM sales whose admin attribution correction never reached sold_*
SET LOCAL elyon.allow_sold_change = 'on';
UPDATE public.orders o
   SET sold_by_person_id = sp.id,
       sold_by_ext       = coalesce(nullif(btrim(o.confirmed_by_name), ''), o.confirmed_by_agent_id::text)
  FROM public.sales_people sp
 WHERE sp.user_id = o.confirmed_by_agent_id
   AND o.sold_via = 'crm' AND o.sold_at IS NOT NULL
   AND o.sold_by_person_id IS DISTINCT FROM sp.id
   AND EXISTS (SELECT 1 FROM public.audit_log a
                WHERE a.action = 'order.attribution_correction' AND a.target_id = o.id::text);
SET LOCAL elyon.allow_sold_change = 'off';

COMMIT;
