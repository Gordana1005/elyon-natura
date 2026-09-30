-- "Испрати до MEX" — the CRM creates MEX parcels itself (owner, 30.09.2026; plan Фаза 9).
--
-- Until now nothing in the CRM called MEX's add_shipment.php: agents re-booked every CRM sale in
-- collabBox (10114 LEADS-OUT), collabBox created the parcel and mex-reconcile linked it back by
-- phone + COD. The owner wants the naturatherapy.mk flow instead: the warehouse ticks confirmed
-- orders and presses "Испрати до MEX" (MANUAL — the 11:00 auto-send is built in code but NOT
-- scheduled, because not everyone works in the CRM yet); MEX status 8 "Shipment created" is
-- "за пакување"; the courier picking the parcel up (4/10/9/1/3) makes the order shipped.
--
-- MEX HAS NO CANCEL ENDPOINT. Everything below exists so that a parcel is created at most once:
--
--   public.mex_push_attempts           the ledger — one row per attempt (ok / exists_linked /
--                                      error / skipped) with the exact request and MEX's reply;
--                                      at most ONE successful row per order (partial UNIQUE).
--                                      RLS on, no policies: service_role only.
--   orders.mex_sent_at / mex_sent_by   when / by whom the parcel went to MEX. The push CLAIMS the
--                                      order by stamping them (mex_push_claim, UPDATE … WHERE
--                                      mex_tracking_id IS NULL); a definite refusal releases the
--                                      claim, an unknown outcome (timeout) keeps it for 15 minutes
--                                      and the next attempt asks MEX first. mex-reconcile stamps
--                                      mex_sent_at for parcels made elsewhere (collabBox).
--   mex_parcels.link_method 'push'     a parcel the CRM itself created (or found already at MEX
--                                      under our order number and re-linked, never re-created).
--   app_settings.mex_push              the switch — OFF by default: {"enabled":false,
--                                      "accounts":{"natura":false,"bio_natural":false},
--                                      "auto_send_at":null,"max_per_send":50}. Inserted only if
--                                      absent. While off, only a dry run is possible and the
--                                      /orders MEX CSV stays the way to ship.
--   mex_push_claim / mex_push_record / mex_push_release
--                                      the three writes of one push (edge function api,
--                                      supabase/functions/api/mexPush.ts).
--   warehouse_order_facts(ids)         one shape of an order for the queue and the push.
--   warehouse_queue(tab, departments, order, limit, offset)
--                                      /warehouse, one call: 'send' (confirmed, no parcel, never a
--                                      web order, never a test phone) · 'pack' (parcels at MEX 8,
--                                      both accounts, collabBox-booked included, MEX-only included,
--                                      ≤ 14 days) · 'pack_stale' (the same, older) + every count.
--
-- No status changes here (MEX 8 semantics: 20260943001210 / 001220 and mex-reconcile).
-- mex_link_parcel is replaced ONLY to accept 'push' — body otherwise verbatim (drift-guarded).

BEGIN;

SET LOCAL lock_timeout = '10s';

DO $drift$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.mex_link_parcel(text,uuid,text,boolean)')
                   AND md5(replace(p.prosrc, chr(13), '')) IN ('87baa6ba22a69e436b7c1f1be02598b9')) THEN
    RAISE EXCEPTION 'mex push: mex_link_parcel changed since this migration was written — rebase the ''push'' method onto the live body';
  END IF;
END
$drift$;

-- ── 1. orders: who sent the parcel, and when ────────────────────────────────
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS mex_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS mex_sent_by uuid;

COMMENT ON COLUMN public.orders.mex_sent_at IS
  'When the order''s parcel was created at MEX: the CRM push (its claim, then its success), or — for a parcel made elsewhere (collabBox) — the parcel''s own creation time, stamped by mex-reconcile. NULL = never sent. A value with mex_tracking_id NULL = a push whose outcome is not known yet (claim; re-checked at MEX before any retry). Migration 20260943001200.';
COMMENT ON COLUMN public.orders.mex_sent_by IS
  'auth user id of the login that pressed "Испрати до MEX" (NULL for parcels made outside the CRM). Migration 20260943001200.';

-- ── 2. the register accepts 'push' ──────────────────────────────────────────
ALTER TABLE public.mex_parcels DROP CONSTRAINT IF EXISTS mex_parcels_link_method_check;
ALTER TABLE public.mex_parcels ADD CONSTRAINT mex_parcels_link_method_check
  CHECK (link_method = ANY (ARRAY['tracking', 'phone_cod', 'phone_single', 'collabbox_import', 'repair', 'manual',
                                  'unknown_writer', 'name_city', 'upsell_revive', 'push']));

CREATE OR REPLACE FUNCTION public.mex_link_parcel(p_tracking text, p_order uuid, p_method text, p_force boolean DEFAULT false)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _p      public.mex_parcels%ROWTYPE;
  _force  boolean := coalesce(p_force, false);
  _result text;
BEGIN
  IF p_tracking IS NULL OR p_order IS NULL THEN
    RAISE EXCEPTION 'mex_link_parcel: tracking id and order id are both required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_method IS NULL OR p_method NOT IN ('tracking', 'phone_cod', 'phone_single',
                                          'collabbox_import', 'repair', 'manual',
                                          'unknown_writer', 'name_city',
                                          'upsell_revive', 'push') THEN
    RAISE EXCEPTION 'mex_link_parcel: unknown link method %', coalesce(quote_literal(p_method), 'NULL')
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Row lock: two linkers racing for one parcel serialise here, and the loser
  -- then sees the winner's order_id ('already' or 'conflict').
  SELECT * INTO _p FROM public.mex_parcels WHERE tracking_id = p_tracking FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'missing';
  END IF;

  IF _p.order_id IS NOT NULL AND _p.order_id <> p_order AND NOT _force THEN
    RETURN 'conflict';
  END IF;

  IF _p.order_id IS DISTINCT FROM p_order
     AND NOT EXISTS (SELECT 1 FROM public.orders WHERE id = p_order) THEN
    RAISE EXCEPTION 'mex_link_parcel: order % does not exist', p_order
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF _force THEN
    -- mex_tracking_id := NULL cannot fire trg_orders_link_parcel (its WHEN
    -- clause requires a non-NULL id).
    UPDATE public.orders
       SET mex_tracking_id    = NULL,
           mex_account        = NULL,
           mex_status_id      = NULL,
           mex_cod_mkd        = NULL,
           mex_delivered_at   = NULL,
           mex_returned_at    = NULL,
           mex_last_update_at = NULL
     WHERE mex_tracking_id = p_tracking
       AND id <> p_order;
  END IF;

  IF _p.order_id = p_order THEN
    _result := 'already';
    -- The trigger links as 'unknown_writer' when an order writes the id
    -- before (or instead of) calling here; the caller's method replaces that
    -- placeholder. A real method is never overwritten.
    IF (_p.link_method IS NULL OR _p.link_method = 'unknown_writer')
       AND p_method <> 'unknown_writer' THEN
      UPDATE public.mex_parcels
         SET link_method = p_method
       WHERE tracking_id = p_tracking;
    END IF;
  ELSE
    _result := 'linked';
    -- Parcel FIRST: when the orders UPDATE below fires trg_orders_link_parcel,
    -- the parcel already has its order_id and the trigger does nothing.
    UPDATE public.mex_parcels
       SET order_id    = p_order,
           link_method = p_method,
           linked_at   = now()
     WHERE tracking_id = p_tracking;
  END IF;

  -- The order names this parcel and carries its facts — unless it already
  -- names a NEWER parcel that is also its own (a re-send), which it keeps.
  UPDATE public.orders o
     SET mex_tracking_id    = p_tracking,
         mex_account        = _p.account,
         mex_status_id      = _p.status_id,
         mex_cod_mkd        = _p.cod_mkd,
         mex_delivered_at   = _p.delivered_at,
         mex_returned_at    = _p.returned_at,
         mex_last_update_at = _p.last_update_at
   WHERE o.id = p_order
     AND (o.mex_tracking_id, o.mex_account, o.mex_status_id, o.mex_cod_mkd,
          o.mex_delivered_at, o.mex_returned_at, o.mex_last_update_at)
         IS DISTINCT FROM
         (p_tracking, _p.account, _p.status_id, _p.cod_mkd,
          _p.delivered_at, _p.returned_at, _p.last_update_at)
     AND NOT EXISTS (
           SELECT 1
             FROM public.mex_parcels q
            WHERE q.tracking_id = o.mex_tracking_id
              AND q.tracking_id <> p_tracking
              AND q.order_id = p_order
              AND q.created_at_mex > _p.created_at_mex);

  RETURN _result;
END;
$function$;

-- ── 3. the ledger ───────────────────────────────────────────────────────────
-- order_id carries NO foreign key on purpose (like data_repair_rows): the record of a parcel
-- that exists at MEX must outlive the order row.
CREATE TABLE IF NOT EXISTS public.mex_push_attempts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     uuid NOT NULL,
  account      text CHECK (account IN ('bio_natural', 'natura')),
  request_hash text,
  request      jsonb,
  response     jsonb,
  tracking_id  text,
  status       text NOT NULL CHECK (status IN ('ok', 'exists_linked', 'error', 'skipped')),
  error        text,
  actor        uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.mex_push_attempts IS
  'Every "Испрати до MEX" attempt, one row per order per try: ok (MEX created the parcel), exists_linked (MEX already had it under our order number — re-linked, never re-created), error, skipped (refused before MEX was asked). request = the exact add_shipment.php body, response = MEX''s reply. At most one ok/exists_linked row per order (MEX has no cancel). Service role only. Migration 20260943001200.';

CREATE UNIQUE INDEX IF NOT EXISTS mex_push_attempts_one_success
  ON public.mex_push_attempts (order_id) WHERE status IN ('ok', 'exists_linked');
CREATE INDEX IF NOT EXISTS idx_mex_push_attempts_order
  ON public.mex_push_attempts (order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mex_push_attempts_created
  ON public.mex_push_attempts (created_at DESC);

ALTER TABLE public.mex_push_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mex_push_attempts FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.mex_push_attempts TO service_role;

-- The double-parcel guard looks up collabBox documents by the customer's last 8 digits.
CREATE INDEX IF NOT EXISTS idx_collabbox_documents_phone8_at
  ON public.collabbox_documents (phone8, doc_at) WHERE phone8 IS NOT NULL;

-- ── 4. the switch (OFF) ─────────────────────────────────────────────────────
INSERT INTO public.app_settings (key, value)
VALUES ('mex_push', '{"enabled": false, "accounts": {"natura": false, "bio_natural": false}, "auto_send_at": null, "max_per_send": 50}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ── 5. one order, as the queue and the push read it ─────────────────────────
-- The product line (products.brand_line, 20260943001300) is read through to_jsonb(), so this works
-- before and after that migration; its MEX profile comes from mex_profile_for_line() when that
-- exists, else from the same mapping inline (bio_natural / dr_becker → BIO NATURAL, natura_therapy /
-- ad_astra → NATURA). The account DECISION is made once, in TS (mexPush.ts decideAccount).
CREATE OR REPLACE FUNCTION public.warehouse_order_facts(p_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _cfg      jsonb;
  _days     integer := public.no_parcel_rule_days();
  _sources  text[];
  _from     timestamptz;
  _lines    text[];
  _line     text;
  _map      jsonb := '{}'::jsonb;
  _prof     text;
  _has_fn   boolean := to_regprocedure('public.mex_profile_for_line(text)') IS NOT NULL;
  _out      jsonb;
BEGIN
  IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN
    RETURN '[]'::jsonb;
  END IF;
  IF cardinality(p_ids) > 500 THEN
    RAISE EXCEPTION 'warehouse_order_facts: at most 500 orders per call' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT value INTO _cfg FROM public.app_settings WHERE key = 'no_parcel_rule';
  _cfg     := coalesce(_cfg, '{}'::jsonb);
  _sources := coalesce(ARRAY(SELECT jsonb_array_elements_text(_cfg -> 'sources')), ARRAY['altercpa', 'affiliate']);
  _from    := (coalesce((_cfg ->> 'from_date')::date, DATE '2026-08-01')::timestamp AT TIME ZONE 'Europe/Skopje');

  -- the MEX profile of each product line on these orders (≤ 4 lines: one call each)
  SELECT coalesce(array_agg(DISTINCT l), '{}') INTO _lines
    FROM (SELECT to_jsonb(pr) ->> 'brand_line' AS l
            FROM public.orders o
            LEFT JOIN public.order_items i ON i.order_id = o.id
            JOIN public.products pr ON pr.id = coalesce(i.product_id, o.product_id)
           WHERE o.id = ANY (p_ids)) s
   WHERE l IS NOT NULL;
  FOREACH _line IN ARRAY _lines LOOP
    IF _has_fn THEN
      EXECUTE 'SELECT public.mex_profile_for_line($1)' INTO _prof USING _line;
    ELSE
      _prof := CASE _line WHEN 'bio_natural' THEN 'bio_natural' WHEN 'dr_becker' THEN 'bio_natural'
                          WHEN 'natura_therapy' THEN 'natura' WHEN 'ad_astra' THEN 'natura' END;
    END IF;
    _map := _map || jsonb_build_object(_line, _prof);
  END LOOP;

  WITH o AS (
    SELECT x.*, coalesce(x.sold_at, x.confirmed_at, x.created_at) AS sale_at,
           public.cohort_order_source(x.sale_source, x.sale_source_detail, x.mex_tracking_id, x.dept_override) AS dept,
           right(regexp_replace(coalesce(x.customer_phone, ''), '[^0-9]', '', 'g'), 8) AS p8
      FROM public.orders x
     WHERE x.id = ANY (p_ids)
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', o.id,
           'display_id', o.display_id,
           'status', o.status,
           'created_at', o.created_at,
           'sale_at', o.sale_at,
           'department', o.dept,
           'sale_source', o.sale_source,
           'sale_source_detail', o.sale_source_detail,
           'source_type', o.source_type,
           'customer_name', o.customer_name,
           'customer_phone', o.customer_phone,
           'customer_city', o.customer_city,
           'customer_address', o.customer_address,
           'postal_code', o.postal_code,
           'street', o.street, 'street_number', o.street_number, 'quarter', o.quarter,
           'block', o.block, 'entry', o.entry, 'floor', o.floor, 'apartment', o.apartment,
           'delivery_type', o.delivery_type,
           'courier_office_code', o.courier_office_code, 'courier_office_name', o.courier_office_name,
           'courier_office_city', o.courier_office_city,
           'mex_city_id', o.mex_city_id,
           'mex_city_name', o.mex_city_name,
           'delivery_instructions', o.delivery_instructions,
           'ship_after_date', o.ship_after_date,
           'price_eur', o.price,
           'product_name', o.product_name,
           'quantity', o.quantity,
           'mex_tracking_id', o.mex_tracking_id,
           'mex_sent_at', o.mex_sent_at,
           'mex_sent_by', o.mex_sent_by,
           'test_phone', EXISTS (SELECT 1 FROM public.report_excluded_phones t WHERE t.phone8 = o.p8),
           'items', coalesce(it.items, '[]'::jsonb),
           'seller', coalesce(sp.display_name, o.confirmed_by_name, o.assigned_agent_name),
           'seller_team', tm.team_key,
           'no_parcel_rule', CASE
             WHEN o.sale_source = ANY (_sources)
              AND coalesce(o.sale_source_detail, '') <> 'team_prediction'
              AND o.sale_at >= _from
             THEN jsonb_build_object('days', _days, 'cancel_after', o.sale_at + make_interval(days => _days))
           END,
           'unlinked_parcels', coalesce(up.rows, '[]'::jsonb),
           'other_parcels', coalesce(op.rows, '[]'::jsonb),
           'collabbox_docs', coalesce(cd.rows, '[]'::jsonb),
           'last_attempt', la.row
         ) ORDER BY array_position(p_ids, o.id)), '[]'::jsonb)
    INTO _out
    FROM o
    LEFT JOIN public.sales_people sp ON sp.id = o.sold_by_person_id
    LEFT JOIN LATERAL (
      SELECT m.team_key FROM public.sales_team_members m
       WHERE m.person_id = o.sold_by_person_id
         AND (m.valid_from IS NULL OR m.valid_from <= (o.sale_at AT TIME ZONE 'Europe/Skopje')::date)
         AND (m.valid_to IS NULL OR m.valid_to >= (o.sale_at AT TIME ZONE 'Europe/Skopje')::date)
       ORDER BY m.is_primary DESC NULLS LAST, m.valid_from DESC NULLS LAST
       LIMIT 1) tm ON true
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object(
               'product_id', s.pid, 'product_name', s.pname, 'quantity', s.qty,
               'brand_line', s.line, 'line_profile', _map ->> s.line) ORDER BY s.ord) AS items
        FROM (
          SELECT i.product_id AS pid, i.product_name AS pname, i.quantity AS qty,
                 to_jsonb(pr) ->> 'brand_line' AS line, row_number() OVER (ORDER BY i.created_at, i.id) AS ord
            FROM public.order_items i
            LEFT JOIN public.products pr ON pr.id = i.product_id
           WHERE i.order_id = o.id
          UNION ALL
          SELECT o.product_id, o.product_name, coalesce(o.quantity, 1), to_jsonb(pr) ->> 'brand_line', 1
            FROM (SELECT 1) one
            LEFT JOIN public.products pr ON pr.id = o.product_id
           WHERE NOT EXISTS (SELECT 1 FROM public.order_items i WHERE i.order_id = o.id)
             AND (o.product_id IS NOT NULL OR nullif(btrim(o.product_name), '') IS NOT NULL)
        ) s) it ON true
    -- a parcel on the same phone that nobody holds (collabBox booked it, the link has not happened)
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('tracking_id', p.tracking_id, 'account', p.account,
               'status_id', p.status_id, 'created_at', p.created_at_mex, 'cod_mkd', p.cod_mkd)
               ORDER BY p.created_at_mex DESC) AS rows
        FROM (SELECT * FROM public.mex_parcels p
               WHERE length(o.p8) = 8 AND p.phone8 = o.p8 AND p.order_id IS NULL
                 AND p.created_at_mex >= o.sale_at - interval '14 days'
               ORDER BY p.created_at_mex DESC LIMIT 5) p) up ON true
    -- a parcel on the same phone already held by ANOTHER order (a twin sale, or a repeat purchase)
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('tracking_id', p.tracking_id, 'account', p.account,
               'status_id', p.status_id, 'created_at', p.created_at_mex, 'order_display_id', x.display_id)
               ORDER BY p.created_at_mex DESC) AS rows
        FROM (SELECT * FROM public.mex_parcels p
               WHERE length(o.p8) = 8 AND p.phone8 = o.p8 AND p.order_id IS NOT NULL AND p.order_id <> o.id
                 AND p.created_at_mex >= o.sale_at - interval '14 days'
               ORDER BY p.created_at_mex DESC LIMIT 5) p
        LEFT JOIN public.orders x ON x.id = p.order_id) op ON true
    -- a collabBox order document on the same phone (someone booked it there too)
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('doc_number', d.doc_number, 'doc_type_id', d.doc_type_id,
               'doc_type_name', d.doc_type_name, 'doc_at', d.doc_at, 'outcome', d.outcome)
               ORDER BY d.doc_at DESC) AS rows
        FROM (SELECT * FROM public.collabbox_documents d
               WHERE length(o.p8) = 8 AND d.phone8 = o.p8
                 AND d.doc_at >= o.sale_at - interval '14 days'
                 AND d.role IN ('order', 'order_unless_held')
                 AND NOT coalesce(d.is_storno, false) AND d.reversed_by IS NULL
               ORDER BY d.doc_at DESC LIMIT 5) d) cd ON true
    LEFT JOIN LATERAL (
      SELECT jsonb_build_object('status', a.status, 'error', a.error, 'account', a.account,
                                'tracking_id', a.tracking_id, 'created_at', a.created_at) AS row
        FROM public.mex_push_attempts a
       WHERE a.order_id = o.id
       ORDER BY a.created_at DESC LIMIT 1) la ON true;

  RETURN _out;
END
$fn$;

COMMENT ON FUNCTION public.warehouse_order_facts(uuid[]) IS
  'One order as "Испрати до MEX" reads it: address parts, MEX zone, items with their product line and its MEX profile, department (cohort_order_source 4-arg), seller + team, the 10-day no-parcel rule clock, and the double-parcel evidence (unlinked / other-order parcels and collabBox documents on the same last-8 phone within 14 days). ≤ 500 ids. Service role only. Migration 20260943001200.';

-- ── 6. the queue ────────────────────────────────────────────────────────────
-- The two populations, as plain set-returning SQL (no temp tables: the queue must also run in a
-- read-only transaction). Called only from warehouse_queue (SECURITY DEFINER), which is why they
-- carry no definer of their own.
CREATE OR REPLACE FUNCTION public.warehouse_send_base()
RETURNS TABLE (id uuid, sale_at timestamptz, dept text, no_address boolean, no_zone boolean, sent_unconfirmed boolean)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $fn$
  SELECT s.id, s.sale_at, s.dept, s.no_address, s.no_zone, s.sent_unconfirmed
    FROM (
      SELECT x.id, coalesce(x.sold_at, x.confirmed_at, x.created_at) AS sale_at,
             public.cohort_order_source(x.sale_source, x.sale_source_detail, x.mex_tracking_id, x.dept_override) AS dept,
             (nullif(btrim(coalesce(x.street, '')), '') IS NULL AND nullif(btrim(coalesce(x.quarter, '')), '') IS NULL
              AND nullif(btrim(coalesce(x.block, '')), '') IS NULL
              AND nullif(btrim(coalesce(x.customer_address, '')), '') IS NULL) AS no_address,
             (x.mex_city_id IS NULL) AS no_zone,
             (x.mex_sent_at IS NOT NULL) AS sent_unconfirmed
        FROM public.orders x
       WHERE x.status = 'confirmed'
         AND x.mex_tracking_id IS NULL
         AND coalesce(x.sale_source, '') <> 'web'
         AND NOT EXISTS (SELECT 1 FROM public.report_excluded_phones t
                          WHERE t.phone8 = right(regexp_replace(coalesce(x.customer_phone, ''), '[^0-9]', '', 'g'), 8))
    ) s
   WHERE s.dept <> 'web'
$fn$;

CREATE OR REPLACE FUNCTION public.warehouse_pack_base(p_stale interval DEFAULT interval '14 days')
RETURNS TABLE (tracking_id text, created_at timestamptz, stale boolean, dept text)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $fn$
  SELECT p.tracking_id, coalesce(p.created_at_mex, p.first_seen_at),
         coalesce(p.created_at_mex, p.first_seen_at) < now() - p_stale,
         CASE WHEN o.id IS NOT NULL
              THEN public.cohort_order_source(o.sale_source, o.sale_source_detail, o.mex_tracking_id, o.dept_override)
              ELSE public.cohort_parcel_source(public.cohort_parcel_split(p.account, p.series, p.tracking_id, p.sender_reference))
         END
    FROM public.mex_parcels p
    LEFT JOIN public.orders o ON o.id = p.order_id
   WHERE p.status_id = 8
     AND NOT EXISTS (SELECT 1 FROM public.report_excluded_phones t WHERE t.phone8 = p.phone8)
$fn$;

CREATE OR REPLACE FUNCTION public.warehouse_queue(p_tab text DEFAULT 'send', p_departments text[] DEFAULT NULL,
                                                  p_order text DEFAULT 'oldest', p_limit integer DEFAULT 50,
                                                  p_offset integer DEFAULT 0)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  c_stale   CONSTANT interval := interval '14 days';
  _tab      text := coalesce(p_tab, 'send');
  _desc     boolean := coalesce(p_order, 'oldest') = 'newest';
  _limit    integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  _offset   integer := greatest(coalesce(p_offset, 0), 0);
  _deps     text[] := CASE WHEN p_departments IS NULL OR cardinality(p_departments) = 0 THEN NULL ELSE p_departments END;
  _counts   jsonb;
  _ids      uuid[];
  _total    integer;
  _rows     jsonb;
BEGIN
  IF _tab NOT IN ('send', 'pack', 'pack_stale') THEN
    RAISE EXCEPTION 'warehouse_queue: unknown tab %', quote_literal(_tab) USING ERRCODE = 'invalid_parameter_value';
  END IF;

  WITH s AS MATERIALIZED (SELECT * FROM public.warehouse_send_base()),
       p AS MATERIALIZED (SELECT * FROM public.warehouse_pack_base(c_stale))
  SELECT jsonb_build_object(
    'send', (SELECT count(*) FROM s),
    'send_by_department', (SELECT coalesce(jsonb_object_agg(d, n), '{}'::jsonb) FROM (SELECT s.dept d, count(*) n FROM s GROUP BY 1) x),
    'send_over_3d', (SELECT count(*) FROM s WHERE s.sale_at < now() - interval '3 days'),
    'send_no_address', (SELECT count(*) FROM s WHERE s.no_address),
    'send_no_zone', (SELECT count(*) FROM s WHERE s.no_zone),
    'send_unconfirmed', (SELECT count(*) FROM s WHERE s.sent_unconfirmed),
    'pack', (SELECT count(*) FROM p WHERE NOT p.stale),
    'pack_by_department', (SELECT coalesce(jsonb_object_agg(d, n), '{}'::jsonb) FROM (SELECT p.dept d, count(*) n FROM p WHERE NOT p.stale GROUP BY 1) x),
    'pack_over_3d', (SELECT count(*) FROM p WHERE NOT p.stale AND p.created_at < now() - interval '3 days'),
    'pack_stale', (SELECT count(*) FROM p WHERE p.stale),
    'active_products', (SELECT count(*) FROM public.products pr WHERE pr.is_active),
    'stale_days', 14
  ) INTO _counts;

  IF _tab = 'send' THEN
    WITH s AS MATERIALIZED (SELECT * FROM public.warehouse_send_base() b WHERE _deps IS NULL OR b.dept = ANY (_deps))
    SELECT (SELECT count(*) FROM s),
           (SELECT coalesce(array_agg(pg.id ORDER BY pg.rn), '{}')
              FROM (SELECT s.id, row_number() OVER (ORDER BY CASE WHEN _desc THEN NULL ELSE s.sale_at END ASC,
                                                             CASE WHEN _desc THEN s.sale_at END DESC, s.id) AS rn
                      FROM s ORDER BY rn LIMIT _limit OFFSET _offset) pg)
      INTO _total, _ids;
    _rows := public.warehouse_order_facts(_ids);
  ELSE
    WITH w AS MATERIALIZED (
      SELECT b.*, row_number() OVER (ORDER BY CASE WHEN _desc THEN NULL ELSE b.created_at END ASC,
                                            CASE WHEN _desc THEN b.created_at END DESC, b.tracking_id) AS rn
        FROM public.warehouse_pack_base(c_stale) b
       WHERE b.stale = (_tab = 'pack_stale') AND (_deps IS NULL OR b.dept = ANY (_deps))
    )
    SELECT (SELECT count(*) FROM w),
           (SELECT coalesce(jsonb_agg(z.r ORDER BY z.rn), '[]'::jsonb)
              FROM (
                SELECT q.rn, jsonb_build_object(
                         'tracking_id', p.tracking_id, 'account', p.account, 'series', p.series,
                         'status_id', p.status_id, 'status_name', p.status_name,
                         'created_at', q.created_at, 'last_update_at', p.last_update_at,
                         'receiver_name', p.receiver_name, 'receiver_city', p.receiver_city,
                         'cod_mkd', p.cod_mkd, 'link_method', p.link_method,
                         'department', q.dept,
                         'order_id', o.id, 'display_id', o.display_id, 'order_status', o.status,
                         'customer_name', o.customer_name, 'mex_sent_at', o.mex_sent_at,
                         'items', CASE WHEN o.id IS NULL THEN '[]'::jsonb ELSE coalesce((
                            SELECT jsonb_agg(jsonb_build_object('product_name', i.product_name, 'quantity', i.quantity)
                                             ORDER BY i.created_at, i.id)
                              FROM public.order_items i WHERE i.order_id = o.id),
                            CASE WHEN nullif(btrim(o.product_name), '') IS NOT NULL
                                 THEN jsonb_build_array(jsonb_build_object('product_name', o.product_name,
                                                                           'quantity', coalesce(o.quantity, 1)))
                                 ELSE '[]'::jsonb END) END
                       ) AS r
                  FROM (SELECT * FROM w ORDER BY w.rn LIMIT _limit OFFSET _offset) q
                  JOIN public.mex_parcels p ON p.tracking_id = q.tracking_id
                  LEFT JOIN public.orders o ON o.id = p.order_id) z)
      INTO _total, _rows;
  END IF;

  RETURN jsonb_build_object('tab', _tab, 'order', CASE WHEN _desc THEN 'newest' ELSE 'oldest' END,
                            'limit', _limit, 'offset', _offset, 'total', coalesce(_total, 0),
                            'counts', _counts, 'rows', coalesce(_rows, '[]'::jsonb), 'generated_at', now());
END
$fn$;

COMMENT ON FUNCTION public.warehouse_queue(text, text[], text, integer, integer) IS
  '/warehouse in one call. tab send = confirmed orders with no MEX parcel (never a web order, never a test phone), with warehouse_order_facts per row; pack = parcels at MEX 8 (за пакување) from both accounts incl. collabBox-booked and MEX-only ones, ≤ 14 days old; pack_stale = older ones. departments filter (cohort_order_source / cohort_parcel_source), order oldest|newest, limit ≤ 200. counts = every tile. Money keys end in _eur/_mkd so the API strips them for non-owners. Service role only. Migration 20260943001200.';

-- ── 7. the three writes of one push ─────────────────────────────────────────
-- CLAIM: stamps mex_sent_at/by on a confirmed order with no parcel and no successful push, unless
-- another claim is younger than p_stale_minutes. Returns the order (warehouse_order_facts) and the
-- claim token (the stamped mex_sent_at), or why it could not be claimed.
CREATE OR REPLACE FUNCTION public.mex_push_claim(p_order uuid, p_actor uuid, p_stale_minutes integer DEFAULT 15)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _o        record;
  _at       timestamptz;
  _p8       text;
BEGIN
  PERFORM set_config('elyon.keep_updated_at', 'on', true);   -- a claim is not a call (/call-agains)

  SELECT o.id, o.status::text AS status, o.mex_tracking_id, o.mex_sent_at, o.sale_source, o.customer_phone,
         public.cohort_order_source(o.sale_source, o.sale_source_detail, o.mex_tracking_id, o.dept_override) AS dept
    INTO _o
    FROM public.orders o WHERE o.id = p_order FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'not_found');
  END IF;
  _p8 := right(regexp_replace(coalesce(_o.customer_phone, ''), '[^0-9]', '', 'g'), 8);
  IF _o.mex_tracking_id IS NOT NULL THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'has_parcel', 'tracking_id', _o.mex_tracking_id);
  END IF;
  IF EXISTS (SELECT 1 FROM public.mex_push_attempts a WHERE a.order_id = p_order AND a.status IN ('ok', 'exists_linked')) THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'already_sent');
  END IF;
  IF _o.status <> 'confirmed' THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'not_confirmed', 'status', _o.status);
  END IF;
  IF coalesce(_o.sale_source, '') = 'web' OR _o.dept = 'web' THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'web_order');
  END IF;
  IF EXISTS (SELECT 1 FROM public.report_excluded_phones t WHERE t.phone8 = _p8) THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'test_phone');
  END IF;
  IF _o.mex_sent_at IS NOT NULL
     AND _o.mex_sent_at > now() - make_interval(mins => greatest(coalesce(p_stale_minutes, 15), 1)) THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'claimed_recently', 'mex_sent_at', _o.mex_sent_at);
  END IF;

  _at := clock_timestamp();
  UPDATE public.orders SET mex_sent_at = _at, mex_sent_by = p_actor WHERE id = p_order;

  RETURN jsonb_build_object('claimed', true, 'claimed_at', _at,
                            'was_claimed_at', _o.mex_sent_at,
                            'order', public.warehouse_order_facts(ARRAY[p_order]) -> 0);
END
$fn$;

-- RELEASE: undo a claim that produced no parcel — only the caller's own claim (the token).
CREATE OR REPLACE FUNCTION public.mex_push_release(p_order uuid, p_claimed_at timestamptz)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _n integer;
BEGIN
  PERFORM set_config('elyon.keep_updated_at', 'on', true);
  UPDATE public.orders
     SET mex_sent_at = NULL, mex_sent_by = NULL
   WHERE id = p_order AND mex_tracking_id IS NULL AND mex_sent_at = p_claimed_at;
  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN _n > 0;
END
$fn$;

-- RECORD: the ledger row, and for a parcel that now exists (ok / exists_linked): the register row
-- (p_parcel, shaped like a list_shipments.php row — the next 15-minute sweep overwrites it with
-- MEX's own), the link (method 'push'), the stamp and one order note. A parcel that cannot be
-- linked (held by another order) is recorded as an error and the claim is KEPT, so nothing
-- re-sends it; the note tells the warehouse to look at it in the MEX portal.
CREATE OR REPLACE FUNCTION public.mex_push_record(
  p_order uuid, p_claimed_at timestamptz, p_account text, p_status text, p_tracking text,
  p_request jsonb, p_response jsonb, p_request_hash text, p_error text, p_actor uuid,
  p_parcel jsonb DEFAULT NULL, p_release boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _status  text := p_status;
  _error   text := p_error;
  _link    text;
  _id      uuid;
  _who     text;
  _acct    text := CASE p_account WHEN 'bio_natural' THEN 'BIO NATURAL' WHEN 'natura' THEN 'NATURA' ELSE coalesce(p_account, '—') END;
  _released boolean := false;
BEGIN
  IF _status NOT IN ('ok', 'exists_linked', 'error', 'skipped') THEN
    RAISE EXCEPTION 'mex_push_record: unknown status %', quote_literal(_status) USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM set_config('elyon.keep_updated_at', 'on', true);
  SELECT coalesce(nullif(btrim(pr.full_name), ''), pr.email) INTO _who FROM public.profiles pr WHERE pr.user_id = p_actor;

  IF _status IN ('ok', 'exists_linked') THEN
    IF p_tracking IS NULL OR p_account IS NULL THEN
      RAISE EXCEPTION 'mex_push_record: a parcel needs its tracking id and account' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF p_parcel IS NOT NULL THEN
      PERFORM public.mex_upsert_parcels(p_account, jsonb_build_array(p_parcel || jsonb_build_object('tracking_id', p_tracking)));
    ELSIF NOT EXISTS (SELECT 1 FROM public.mex_parcels WHERE tracking_id = p_tracking) THEN
      PERFORM public.mex_upsert_parcels(p_account, jsonb_build_array(jsonb_build_object('tracking_id', p_tracking)));
    END IF;
    _link := public.mex_link_parcel(p_tracking, p_order, 'push', false);
    IF _link NOT IN ('linked', 'already') THEN
      _status := 'error';
      _error := 'link_' || _link;
      INSERT INTO public.order_notes (order_id, text, author_id, author_name)
      VALUES (p_order,
              format('MEX %s (%s) exists, but it is held by another order in the CRM — it was NOT linked here. Check it in the MEX portal before sending anything again.', p_tracking, _acct),
              p_actor, coalesce(_who, 'CRM'));
    END IF;
  END IF;

  BEGIN
    INSERT INTO public.mex_push_attempts (order_id, account, request_hash, request, response, tracking_id, status, error, actor)
    VALUES (p_order, p_account, p_request_hash, p_request, p_response, p_tracking, _status, left(_error, 1000), p_actor)
    RETURNING id INTO _id;
  EXCEPTION WHEN unique_violation THEN
    -- a second success for one order: never recorded twice (the first row stands)
    RETURN jsonb_build_object('status', 'duplicate_success', 'link', _link);
  END;

  IF _status IN ('ok', 'exists_linked') THEN
    UPDATE public.orders
       SET mex_sent_at = coalesce(mex_sent_at, p_claimed_at, now()),
           mex_sent_by = coalesce(mex_sent_by, p_actor)
     WHERE id = p_order;
    INSERT INTO public.order_notes (order_id, text, author_id, author_name)
    VALUES (p_order,
            CASE WHEN _status = 'ok'
                 THEN format('MEX %s created from the CRM (%s) — за пакување until the courier takes it.', p_tracking, _acct)
                 ELSE format('MEX already had %s under this order number (%s) — linked, not created again.', p_tracking, _acct) END,
            p_actor, coalesce(_who, 'CRM'));
  ELSIF coalesce(p_release, false) AND _link IS NULL THEN
    _released := public.mex_push_release(p_order, p_claimed_at);
  END IF;

  RETURN jsonb_build_object('status', _status, 'id', _id, 'link', _link, 'released', _released, 'error', _error);
END
$fn$;

DO $g$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.warehouse_order_facts(uuid[])',
    'public.warehouse_send_base()',
    'public.warehouse_pack_base(interval)',
    'public.warehouse_queue(text, text[], text, integer, integer)',
    'public.mex_push_claim(uuid, uuid, integer)',
    'public.mex_push_release(uuid, timestamptz)',
    'public.mex_push_record(uuid, timestamptz, text, text, text, jsonb, jsonb, text, text, uuid, jsonb, boolean)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.warehouse_order_facts(uuid[]) TO supabase_read_only_user';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.warehouse_send_base() TO supabase_read_only_user';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.warehouse_pack_base(interval) TO supabase_read_only_user';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.warehouse_queue(text, text[], text, integer, integer) TO supabase_read_only_user';
    EXECUTE 'GRANT SELECT ON public.mex_push_attempts TO supabase_read_only_user';
  END IF;
END
$g$;

NOTIFY pgrst, 'reload schema';

COMMIT;
