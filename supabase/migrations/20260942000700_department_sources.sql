-- Sale sources are the DEPARTMENTS (owner, 28.09.2026 ~23:00, whole history approved):
--   "ElyonCRM must be renamed Телешоп – Lead out, and Teleshop — where the sales are only from lead
--    in — Телешоп – Lead in. All in and out of the AlterCPA agents (the ones working AlterCPA via
--    affiliates; maybe they also do prediction when there are no leads to call) stays counted in
--    AlterCPA. Teleshop computes only the lead-in orders — the ones we import that we did not have
--    in the CRM before and that came from teleshop leads."
--
-- Keys stay (labels change in the UI):
--   altercpa   AlterCPA leads (bridge / history) + collabBox 9110 "LEADS" documents
--              ('collabbox_leads') + EVERY sale an AlterCPA-team agent makes (team_prediction,
--              team_collabbox_out, team_collabbox_leads_out) — the altercpa_leads team membership on
--              the sale day decides.
--   elyon_crm  "Телешоп – Lead out": CRM-made sales (prediction_list / direct) + collabBox 9102
--              "Нарачка out" ('collabbox_out') + 9103 "LEADS-OUT" ('collabbox_leads_out'), for every
--              year and every author (whether she logs into the CRM or not — sales_people.crm_since
--              stays as information, not as a gate).
--   collabbox  → "Телешоп – Lead in": 9100 "Нарачка in" only (+ 9108 social → its own source, see
--              20260942000500).
-- This supersedes the crm_since gate of 20260942000600 (collabbox_prediction_detail is dropped).
-- The big backfill of existing rows runs in chunks: scripts/reclass-department-sources.mjs.
-- Payout / bonus / commission math is NOT touched (deferred by the owner).

BEGIN;

-- ── 1. the department of a collabBox document ───────────────────────────────
CREATE OR REPLACE FUNCTION public.sales_person_in_team(p_person uuid, p_team text, p_at timestamptz)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $fn$
  SELECT p_person IS NOT NULL AND p_at IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.sales_team_members m
     WHERE m.person_id = p_person AND m.team_key = p_team
       AND (p_at AT TIME ZONE 'Europe/Skopje')::date BETWEEN m.valid_from AND coalesce(m.valid_to, DATE '2999-12-31'));
$fn$;

CREATE OR REPLACE FUNCTION public.collabbox_department(p_external_order_id text, p_person uuid, p_at timestamptz)
RETURNS text[]
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $fn$
  SELECT CASE
           WHEN s.ser = '9110' THEN ARRAY['altercpa', 'collabbox_leads']
           WHEN s.ser IN ('9102', '9103') AND public.sales_person_in_team(p_person, 'altercpa_leads', p_at)
             THEN ARRAY['altercpa', CASE s.ser WHEN '9102' THEN 'team_collabbox_out' ELSE 'team_collabbox_leads_out' END]
           WHEN s.ser = '9102' THEN ARRAY['elyon_crm', 'collabbox_out']
           WHEN s.ser = '9103' THEN ARRAY['elyon_crm', 'collabbox_leads_out']
         END
    FROM (SELECT split_part(coalesce(p_external_order_id, ''), '-', 2) AS ser) s;
$fn$;

COMMENT ON FUNCTION public.collabbox_department(text, uuid, timestamptz) IS
  'Owner law 28.09.2026 (departments): a collabBox document''s source by its DocNumber series and its author — 9110 LEADS → altercpa/collabbox_leads; 9102 Нарачка out / 9103 LEADS-OUT → elyon_crm ("Телешоп – Lead out") collabbox_out / collabbox_leads_out, or altercpa team_collabbox_out / team_collabbox_leads_out when the author is in the AlterCPA team that day; NULL for everything else (9100 lead in stays collabbox; 9108 social). Migration 20260942000700.';

-- ── 2. INSERT: collabBox rows take their department ──────────────────────────
CREATE OR REPLACE FUNCTION public.tg_orders_sale_source_fill()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _o record;
  _c text[];
  _d text[];
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
        -- A copy of a CRM order is a CRM order, but whether it is a SALE is its own business
        -- (20260942000400). A copy made in the CRM of a collabBox lead-out row is a CRM row too.
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
    -- a collabBox document belongs to its department (20260942000700)
    IF NEW.sale_source = 'collabbox' THEN
      _d := public.collabbox_department(NEW.external_order_id, NEW.sold_by_person_id, coalesce(NEW.sold_at, NEW.created_at));
      IF _d IS NOT NULL THEN
        NEW.sale_source        := _d[1];
        NEW.sale_source_detail := _d[2];
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NEW.sale_source        := NULL;
    NEW.sale_source_detail := NULL;
  END;
  RETURN NEW;
END;
$function$;

DROP FUNCTION IF EXISTS public.collabbox_prediction_detail(text, uuid, timestamptz);

-- ── 3. a CRM sale made by an AlterCPA-team agent counts in AlterCPA ──────────
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

-- ── 4. the reclass log keeps the FIRST source an order ever had ──────────────
COMMENT ON TABLE public.sale_source_reclass IS
  'Every deliberate move of orders.sale_source after insert (owner rules 28.09.2026: lead-out = prediction 20260942000600, departments 20260942000700) — from_* = the source the order had before the FIRST move, to_* = where it is now. Rollback: UPDATE orders SET sale_source = from_source, sale_source_detail = from_detail under SET LOCAL elyon.allow_source_change = ''on''.';

-- ── 6. the 10-day no-parcel rule keeps exactly its population ──────────────
-- A CRM sale an AlterCPA-team agent made now counts in AlterCPA (team_prediction), but it is not
-- an AlterCPA approval: the rule never covered CRM orders (owner, 28.09: scope = AlterCPA-confirmed).
-- Same exclusion in insights_overview (anp) and GET /orders?attention=approved_no_parcel_7d.
CREATE OR REPLACE FUNCTION public.apply_no_parcel_rule(_force boolean DEFAULT false, _dry_run boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _cfg        jsonb;
  _mode       text;
  _days       integer;
  _sources    text[];
  _from_date  date;
  _hour       integer;
  _skopje_now timestamp := now() AT TIME ZONE 'Europe/Skopje';
  _today      date;
  _run        uuid;
  _cand       integer;
  _cancel     integer;
  _link       integer;
  _value      numeric;
  _done       integer := 0;
  _done_value numeric := 0;
  _actor      constant text := 'System (no-parcel-7d)';
BEGIN
  _today := _skopje_now::date;

  SELECT value INTO _cfg FROM public.app_settings WHERE key = 'no_parcel_rule';
  _cfg       := coalesce(_cfg, '{}'::jsonb);
  _mode      := coalesce(_cfg->>'mode', 'report');
  _days      := public.no_parcel_rule_days();   -- settings.days, default 10, never below 3
  _sources   := coalesce(ARRAY(SELECT jsonb_array_elements_text(_cfg->'sources')), ARRAY['altercpa', 'affiliate']);
  _from_date := coalesce((_cfg->>'from_date')::date, DATE '2026-08-01');
  _hour      := coalesce((_cfg->>'hour')::int, 21);
  IF _mode NOT IN ('report', 'apply') THEN _mode := 'report'; END IF;

  IF NOT _force AND NOT _dry_run THEN
    IF extract(hour FROM _skopje_now)::int <> _hour THEN
      RETURN jsonb_build_object('ok', true, 'skipped', 'outside the ' || _hour || ':00 Skopje window');
    END IF;
    IF EXISTS (SELECT 1 FROM public.no_parcel_rule_runs r WHERE r.run_day = _today AND r.trigger_kind = 'cron') THEN
      RETURN jsonb_build_object('ok', true, 'skipped', 'already ran today');
    END IF;
  END IF;

  CREATE TEMP TABLE _np ON COMMIT DROP AS
  WITH anp AS (
    SELECT x.id, x.display_id, coalesce(x.price, 0) AS price, x.sold_by_person_id,
           coalesce(x.sold_at, x.confirmed_at, x.created_at) AS sold_at,
           right(regexp_replace(coalesce(x.customer_phone, ''), '\D', '', 'g'), 8) AS p8
    FROM public.orders x
    WHERE x.status = 'confirmed'
      AND x.sale_source = ANY (_sources)
      AND coalesce(x.sale_source_detail, '') <> 'team_prediction'   -- a CRM sale of an AlterCPA-team agent: not an AlterCPA approval (20260942000700)
      AND coalesce(x.sold_at, x.confirmed_at, x.created_at) < now() - make_interval(days => _days)
      AND coalesce(x.sold_at, x.confirmed_at, x.created_at) >= (_from_date::timestamp AT TIME ZONE 'Europe/Skopje')
      AND x.mex_tracking_id IS NULL
      AND (x.ship_after_date IS NULL OR x.ship_after_date <= _today)
      AND (x.packed_at IS NULL OR x.packed_at < now() - interval '2 days')
  )
  SELECT a.*,
         (_today - (a.sold_at AT TIME ZONE 'Europe/Skopje')::date) AS days_waiting,
         (SELECT p.tracking_id FROM public.mex_parcels p
           WHERE length(a.p8) = 8 AND p.phone8 = a.p8 AND p.order_id IS NULL
             AND p.created_at_mex >= a.sold_at - interval '2 days'
           ORDER BY p.created_at_mex LIMIT 1) AS unlinked_tracking,
         (SELECT p.order_id FROM public.mex_parcels p
           WHERE length(a.p8) = 8 AND p.phone8 = a.p8 AND p.order_id IS NOT NULL AND p.order_id <> a.id
             AND p.created_at_mex >= a.sold_at - interval '2 days'
           ORDER BY p.created_at_mex LIMIT 1) AS other_order_id
  FROM anp a;

  SELECT count(*),
         count(*) FILTER (WHERE unlinked_tracking IS NULL),
         count(*) FILTER (WHERE unlinked_tracking IS NOT NULL),
         coalesce(sum(price) FILTER (WHERE unlinked_tracking IS NULL), 0)
    INTO _cand, _cancel, _link, _value
  FROM _np;

  IF _dry_run THEN
    RETURN jsonb_build_object('ok', true, 'dry_run', true, 'mode', _mode, 'days', _days,
                              'candidates', _cand, 'to_cancel', _cancel, 'needs_linking', _link,
                              'value_eur', round(_value, 2));
  END IF;

  INSERT INTO public.no_parcel_rule_runs (run_day, mode, trigger_kind, days, candidates, to_cancel,
                                          needs_linking, value_eur, settings)
  VALUES (_today, _mode, CASE WHEN _force THEN 'manual' ELSE 'cron' END, _days, _cand, _cancel,
          _link, round(_value, 2), _cfg)
  RETURNING id INTO _run;

  INSERT INTO public.no_parcel_rule_items (run_id, order_id, display_id, action, sold_at, days_waiting,
                                           price_eur, sold_by_person_id, parcel_tracking, other_order_id)
  SELECT _run, n.id, n.display_id,
         CASE WHEN n.unlinked_tracking IS NOT NULL THEN 'needs_linking' ELSE 'cancel' END,
         n.sold_at, n.days_waiting, n.price, n.sold_by_person_id, n.unlinked_tracking, n.other_order_id
  FROM _np n;

  IF _mode = 'apply' AND _cancel > 0 THEN
    PERFORM set_config('elyon.bulk_repair', 'on', true);

    -- Status-guarded: an order that moved (or got a parcel) since the scan is left alone.
    WITH upd AS (
      UPDATE public.orders o
         SET status = 'cancelled',
             cancellation_reason = 'no_parcel_7d',
             cancellation_reason_notes = 'No MEX parcel ' || n.days_waiting || ' days after the AlterCPA approval (' || _days || '-day rule).'
        FROM _np n
       WHERE n.unlinked_tracking IS NULL
         AND o.id = n.id
         AND o.status = 'confirmed'
         AND o.mex_tracking_id IS NULL
      RETURNING o.id, n.price, n.sold_at, n.days_waiting
    ), hist AS (
      INSERT INTO public.order_history (order_id, from_status, to_status, changed_by, changed_by_name)
      SELECT u.id, 'confirmed'::public.order_status, 'cancelled'::public.order_status, NULL, _actor FROM upd u
      RETURNING order_id
    ), notes AS (
      INSERT INTO public.order_notes (order_id, text, author_id, author_name)
      SELECT u.id,
             'Cancelled automatically: approved in AlterCPA on '
               || to_char(u.sold_at AT TIME ZONE 'Europe/Skopje', 'DD.MM.YYYY')
               || ', no MEX parcel after ' || u.days_waiting
               || ' days. A parcel that appears later reopens the order.',
             NULL, _actor
      FROM upd u
      RETURNING order_id
    ), marked AS (
      UPDATE public.no_parcel_rule_items i SET action = 'cancelled'
        FROM upd u WHERE i.run_id = _run AND i.order_id = u.id
      RETURNING i.order_id
    )
    SELECT count(*), coalesce(sum(u.price), 0) INTO _done, _done_value
    FROM upd u;

    UPDATE public.no_parcel_rule_items SET action = 'skipped'
     WHERE run_id = _run AND action = 'cancel';

    UPDATE public.no_parcel_rule_runs
       SET cancelled = _done, cancelled_value_eur = round(_done_value, 2)
     WHERE id = _run;
    -- No audit_log row: it requires a human actor_id. The run + items ledger
    -- above IS the audit trail (who, what, when, value).
  END IF;

  RETURN jsonb_build_object('ok', true, 'run_id', _run, 'mode', _mode, 'days', _days,
                            'candidates', _cand, 'to_cancel', _cancel, 'needs_linking', _link,
                            'value_eur', round(_value, 2), 'cancelled', _done);
END;
$function$;

-- ── 5. small backfill: CRM-made sales of AlterCPA-team agents → AlterCPA ─────
SET LOCAL elyon.keep_updated_at = 'on';
SET LOCAL elyon.bulk_repair = 'on';
SET LOCAL elyon.allow_source_change = 'on';

CREATE TEMP TABLE _mv ON COMMIT DROP AS
SELECT o.id, o.sale_source AS from_source, o.sale_source_detail AS from_detail, 'altercpa'::text AS to_source,
       CASE o.sale_source_detail WHEN 'collabbox_out' THEN 'team_collabbox_out'
                                 WHEN 'collabbox_leads_out' THEN 'team_collabbox_leads_out'
                                 ELSE 'team_prediction' END AS to_detail
  FROM public.orders o
 WHERE o.sale_source = 'elyon_crm'
   AND o.sale_source_detail IN ('prediction_list', 'direct', 'collabbox_out', 'collabbox_leads_out')
   AND public.sales_person_in_team(o.sold_by_person_id, 'altercpa_leads', coalesce(o.sold_at, o.created_at));

INSERT INTO public.sale_source_reclass AS r (order_id, from_source, from_detail, to_source, to_detail, reason)
SELECT id, from_source, from_detail, to_source, to_detail,
       'owner 28.09.2026: every sale of an AlterCPA-team agent counts in AlterCPA'
  FROM _mv
ON CONFLICT (order_id) DO UPDATE SET to_source = excluded.to_source, to_detail = excluded.to_detail,
       reason = r.reason || ' → ' || excluded.reason, moved_at = now();

UPDATE public.orders o SET sale_source = m.to_source, sale_source_detail = m.to_detail
  FROM _mv m WHERE m.id = o.id;

SET LOCAL elyon.allow_source_change = 'off';

COMMIT;
