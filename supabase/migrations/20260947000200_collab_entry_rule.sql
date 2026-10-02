-- ============================================================================
-- A CRM sale must be entered in collabBox within 2 days (owner, Mile, 02.10.2026)
-- ============================================================================
-- Owner: "се проверува ако некоја порачка ја нема внесено во наредните 2 дена во collab, тогаш оди cancel,
--   Агентот добива известување – нотификација, дека ја нема во collab внесено 2 дена, и одтука пратката е
--   канцелирана."
-- Why: a CRM-made sale (sale_source elyon_crm, detail prediction_list / direct) ships only once its seller books it
--   in collabBox — the collabBox document number IS the MEX tracking id. On 02.10.2026 54 such sales were ≥ 2 days
--   old with no collabBox document and no parcel (the oldest 46 days); every CRM sale that holds a parcel (740 since
--   01.09) holds it through its collabBox document.
--
-- THE EVIDENCE that a CRM sale is in collabBox — crm_sale_collab_doc(order), ONE definition for the rule and for
-- the /orders badge (crm_sale_collab_states). The first that fits, its document number:
--   (a) the writer's own link: a collabBox document names the order (order_id / related_order_id — the
--       possible_twin_crm_sale conflict), not a storno, not vanished;
--   (b) the customer: a collabBox SALES document (role credit / order / order_unless_held) — not a storno /
--       reversed / vanished / replacement / error row, nobody else's (order_id / related_order_id empty or this
--       order) — booked (collabbox_sale_at) from the sale − 2 days on, on the customer's phone: its phone8 or its
--       komitent's (collabbox_customers / teleshop_import_customers — 85 % of the documents carry no phone8);
--   (c) the phoneless twin (the writer's, 20260944000630): the seller's own sales document booked within 10 minutes
--       of the sale, or one booked from the sale − 1 day to + 2 days whose customer name matches after the script
--       fold (collabbox_name_key).
--   A false "in collabBox" only spares an order; the rule never cancels on a doubt.
--
-- THE RULE — apply_collab_entry_rule(force, dry_run), cron collab-entry-rule hourly at :20, acting in the `hour`
-- (21) Skopje, once a day (21:02 linker · 21:06 LEADS orders · 21:10 no-parcel · 21:20 this):
--   candidates  status confirmed · sale_source elyon_crm + detail prediction_list | direct · no MEX tracking id ·
--               sold on a Skopje day ≥ from_date · not a test phone · ship_after_date not in the future ·
--               age (Skopje days since the sale day) ≥ days − 1
--   in_collab      the evidence above → never touched
--   needs_linking  an unlinked MEX parcel on the phone created since the sale − 2 days → never cancelled
--   warn           age = days − 1 (the evening before): a bell to the seller, once per order (apply mode, `warn`)
--   cancel         age ≥ days and none of the above
-- A cancel: status cancelled, cancellation_reason 'other' — a SYSTEM cancel, never a person's reason (a new code
--   would touch the shared api's reason lists and mex-reconcile's revival) — cancellation_reason_notes
--   'not_in_collab_2d: …', an order_history row, a system order note, updated_at kept (elyon.keep_updated_at), and a
--   bell for the sale owner = the confirmer, else the assignee (elyon-notifications Rule 1): type not_in_collab,
--   meta notif.notInCollab (the evening before: not_in_collab_warning, notif.notInCollabWarning).
-- A booking made later is still a sale: the collabBox writer's twin rule reads living sales only (pending … returned),
--   so the document becomes its own order once MEX has its parcel — counted once.
-- Undo a run: collab_entry_rule_undo(run_id) (service role) — back to confirmed, status-guarded, logged.
-- Settings: app_settings.collab_entry_rule = {mode report|apply, days 2, hour 21, from_date, warn} — an OWNER key
--   (tg_app_settings_guard_owner_keys re-emitted below). Seeded REPORT: nothing is cancelled and nobody is notified
--   until the owner has seen the list and switches it to apply.
-- Report (read-only): node scripts/verify-collab-entry-rule.mjs
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $drift$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.tg_app_settings_guard_owner_keys()')
                   AND md5(replace(p.prosrc, chr(13), '')) = 'cebcf4fd23bc95d3ef2bb6b465ec71e8') THEN
    RAISE EXCEPTION 'collab entry rule: tg_app_settings_guard_owner_keys changed since this migration was written';
  END IF;
  IF to_regprocedure('public.collabbox_sale_at(timestamptz,timestamptz)') IS NULL
     OR to_regprocedure('public.collabbox_name_key(text)') IS NULL
     OR to_regprocedure('public.report_excluded_phone8s()') IS NULL THEN
    RAISE EXCEPTION 'collab entry rule: a helper (collabbox_sale_at / collabbox_name_key / report_excluded_phone8s) is missing';
  END IF;
END
$drift$;

-- ── 1. the ledger ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.collab_entry_rule_runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_day             date NOT NULL,
  ran_at              timestamptz NOT NULL DEFAULT now(),
  mode                text NOT NULL CHECK (mode IN ('report', 'apply')),
  trigger_kind        text NOT NULL CHECK (trigger_kind IN ('cron', 'manual')),
  days                integer NOT NULL,
  candidates          integer NOT NULL DEFAULT 0,
  to_cancel           integer NOT NULL DEFAULT 0,
  to_warn             integer NOT NULL DEFAULT 0,
  in_collab           integer NOT NULL DEFAULT 0,
  needs_linking       integer NOT NULL DEFAULT 0,
  cancelled           integer NOT NULL DEFAULT 0,
  warned              integer NOT NULL DEFAULT 0,
  value_eur           numeric NOT NULL DEFAULT 0,
  cancelled_value_eur numeric NOT NULL DEFAULT 0,
  settings            jsonb,
  undone_at           timestamptz,
  undone              integer
);
CREATE INDEX IF NOT EXISTS idx_collab_entry_rule_runs_day ON public.collab_entry_rule_runs (run_day, trigger_kind);

CREATE TABLE IF NOT EXISTS public.collab_entry_rule_items (
  id                bigserial PRIMARY KEY,
  run_id            uuid NOT NULL REFERENCES public.collab_entry_rule_runs (id) ON DELETE CASCADE,
  order_id          uuid NOT NULL,
  display_id        text,
  action            text NOT NULL CHECK (action IN ('cancel', 'cancelled', 'warn', 'warned', 'in_collab',
                                                    'needs_linking', 'skipped', 'undone')),
  sold_at           timestamptz,
  age_days          integer,
  price_eur         numeric,
  sold_by_person_id uuid,
  owner_user_id     uuid,
  evidence          text
);
CREATE INDEX IF NOT EXISTS idx_collab_entry_rule_items_run   ON public.collab_entry_rule_items (run_id);
CREATE INDEX IF NOT EXISTS idx_collab_entry_rule_items_order ON public.collab_entry_rule_items (order_id, action);

COMMENT ON TABLE public.collab_entry_rule_runs IS
  'Owner 02.10.2026: one row per run of the 2-day collabBox entry rule (apply_collab_entry_rule) — mode, counts, value, settings; undone_at / undone when collab_entry_rule_undo reverted it. Owner-only (service role). Migration 20260947000200.';
COMMENT ON TABLE public.collab_entry_rule_items IS
  'The orders each collabBox entry-rule run matched: cancel (report) | cancelled (apply) | warn | warned | in_collab (evidence = the document number) | needs_linking (evidence = the unlinked parcel) | skipped (changed under the run) | undone. Migration 20260947000200.';

ALTER TABLE public.collab_entry_rule_runs  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.collab_entry_rule_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.collab_entry_rule_runs  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.collab_entry_rule_items FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.collab_entry_rule_items_id_seq FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.collab_entry_rule_runs  TO service_role;
GRANT ALL ON public.collab_entry_rule_items TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.collab_entry_rule_items_id_seq TO service_role;

-- ── 2. the evidence: ONE definition ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.crm_sale_collab_doc(p_order uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  WITH o AS (
    SELECT x.id, x.sold_by_person_id, x.customer_name,
           coalesce(x.sold_at, x.confirmed_at, x.created_at) AS sold_at,
           right(regexp_replace(coalesce(x.customer_phone, ''), '\D', '', 'g'), 8) AS p8
    FROM public.orders x
    WHERE x.id = p_order
  ),
  k AS (       -- the komitents on the customer's phone
    SELECT c.komitent_id FROM public.collabbox_customers c, o
     WHERE length(o.p8) = 8 AND c.phone8 = o.p8 AND c.komitent_id IS NOT NULL
    UNION
    SELECT t.komitent_id FROM public.teleshop_import_customers t, o
     WHERE length(o.p8) = 8 AND t.phone8 = o.p8 AND t.komitent_id IS NOT NULL
  ),
  d AS MATERIALIZED (   -- the living sales documents dated from the sale − 2 days on, nobody else's
    SELECT d.doc_number, d.phone8, d.komitent_id, d.komitent_name, d.author_person_id,
           public.collabbox_sale_at(d.doc_at, d.booked_at) AS booked
    FROM public.collabbox_documents d, o
    WHERE d.doc_at >= o.sold_at - interval '2 days'
      AND d.role IN ('credit', 'order', 'order_unless_held')
      AND NOT coalesce(d.is_storno, false) AND d.reversed_by IS NULL AND d.vanished_at IS NULL
      AND coalesce(d.outcome, '') NOT IN ('storno', 'replacement', 'error')
      AND coalesce(d.reason, '') <> 'reversed_by_storno'
      AND (d.order_id IS NULL OR d.order_id = o.id)
      AND (d.related_order_id IS NULL OR d.related_order_id = o.id)
  )
  SELECT coalesce(
    -- (a) the writer's own link
    (SELECT x.doc_number FROM public.collabbox_documents x, o
      WHERE (x.order_id = o.id OR x.related_order_id = o.id)
        AND NOT coalesce(x.is_storno, false) AND x.vanished_at IS NULL
      ORDER BY x.doc_at, x.doc_number LIMIT 1),
    -- (b) the customer's phone (the document's own, or its komitent's)
    (SELECT d.doc_number FROM d, o
      WHERE length(o.p8) = 8
        AND d.booked >= o.sold_at - interval '2 days'
        AND (d.phone8 = o.p8 OR d.komitent_id IN (SELECT k.komitent_id FROM k))
      ORDER BY d.booked, d.doc_number LIMIT 1),
    -- (c) the phoneless twin: the seller's own booking within 10 minutes, or the customer's name
    (SELECT d.doc_number FROM d, o
      WHERE d.booked BETWEEN o.sold_at - interval '1 day' AND o.sold_at + interval '2 days'
        AND ((d.author_person_id = o.sold_by_person_id
              AND d.booked BETWEEN o.sold_at - interval '10 minutes' AND o.sold_at + interval '10 minutes')
             OR public.collabbox_name_key(d.komitent_name) = public.collabbox_name_key(o.customer_name))
      ORDER BY d.booked, d.doc_number LIMIT 1))
$fn$;
COMMENT ON FUNCTION public.crm_sale_collab_doc(uuid) IS
  'Owner 02.10.2026: the collabBox document that proves a CRM sale was entered in collabBox — (a) a document naming the order, (b) a living sales document for the customer''s phone (its own or its komitent''s) booked from the sale − 2 days on, (c) the phoneless twin (the seller''s booking within 10 min, or the customer''s name) — or NULL. ONE definition for the 2-day rule and the /orders badge. Migration 20260947000200.';

-- ── 3. the plan (read-only): what a run would do now ────────────────────────
CREATE OR REPLACE FUNCTION public.collab_entry_rule_plan()
RETURNS TABLE(order_id uuid, display_id text, customer_name text, sold_at timestamptz, sale_day date, age_days integer,
              price_eur numeric, sold_by_person_id uuid, owner_user_id uuid, collab_doc text,
              unlinked_tracking text, plan_action text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _cfg   jsonb := coalesce((SELECT s.value FROM public.app_settings s WHERE s.key = 'collab_entry_rule'), '{}'::jsonb);
  _days  integer := greatest(1, least(30, coalesce(CASE WHEN coalesce(_cfg->>'days', '') ~ '^[0-9]{1,2}$'
                                                        THEN (_cfg->>'days')::int END, 2)));
  _from  date := coalesce(CASE WHEN coalesce(_cfg->>'from_date', '') ~ '^\d{4}-\d{2}-\d{2}$'
                               THEN (_cfg->>'from_date')::date END, date '2026-08-01');
  _today date := (now() AT TIME ZONE 'Europe/Skopje')::date;
  _excl  text[] := public.report_excluded_phone8s();
BEGIN
  RETURN QUERY
  WITH c AS (
    SELECT x.id, x.display_id, x.customer_name, coalesce(x.price, 0) AS price, x.sold_by_person_id,
           coalesce(x.confirmed_by_agent_id, x.assigned_agent_id) AS owner_id,
           coalesce(x.sold_at, x.confirmed_at, x.created_at) AS at,
           (coalesce(x.sold_at, x.confirmed_at, x.created_at) AT TIME ZONE 'Europe/Skopje')::date AS sday,
           right(regexp_replace(coalesce(x.customer_phone, ''), '\D', '', 'g'), 8) AS p8
    FROM public.orders x
    WHERE x.status = 'confirmed'
      AND x.sale_source = 'elyon_crm'
      AND x.sale_source_detail IN ('prediction_list', 'direct')
      AND x.mex_tracking_id IS NULL
      AND (x.ship_after_date IS NULL OR x.ship_after_date <= _today)
      AND coalesce(x.sold_at, x.confirmed_at, x.created_at) >= (_from::timestamp AT TIME ZONE 'Europe/Skopje')
      AND (coalesce(x.sold_at, x.confirmed_at, x.created_at) AT TIME ZONE 'Europe/Skopje')::date <= _today - (_days - 1)
  ), e AS (
    SELECT c.*, (_today - c.sday) AS age,
           public.crm_sale_collab_doc(c.id) AS doc,
           (SELECT p.tracking_id FROM public.mex_parcels p
             WHERE length(c.p8) = 8 AND p.phone8 = c.p8 AND p.order_id IS NULL
               AND p.created_at_mex >= c.at - interval '2 days'
             ORDER BY p.created_at_mex LIMIT 1) AS unlinked
    FROM c
    WHERE NOT (c.p8 = ANY (_excl))
  )
  SELECT e.id, e.display_id, e.customer_name, e.at, e.sday, e.age, e.price, e.sold_by_person_id, e.owner_id,
         e.doc, e.unlinked,
         CASE WHEN e.doc IS NOT NULL      THEN 'in_collab'
              WHEN e.unlinked IS NOT NULL THEN 'needs_linking'
              WHEN e.age >= _days         THEN 'cancel'
              ELSE 'warn' END
  FROM e
  ORDER BY e.at;
END;
$fn$;
COMMENT ON FUNCTION public.collab_entry_rule_plan() IS
  'Owner 02.10.2026: the confirmed CRM sales (elyon_crm prediction_list / direct, no parcel) at least days − 1 Skopje days old and what the 2-day collabBox rule does with each now: in_collab | needs_linking | warn (the evening before) | cancel. Read-only. Migration 20260947000200.';

-- ── 4. the rule ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.apply_collab_entry_rule(p_force boolean DEFAULT false, p_dry_run boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _cfg        jsonb := coalesce((SELECT s.value FROM public.app_settings s WHERE s.key = 'collab_entry_rule'), '{}'::jsonb);
  _mode       text := coalesce(_cfg->>'mode', 'report');
  _days       integer := greatest(1, least(30, coalesce(CASE WHEN coalesce(_cfg->>'days', '') ~ '^[0-9]{1,2}$'
                                                             THEN (_cfg->>'days')::int END, 2)));
  _hour       integer := coalesce(CASE WHEN coalesce(_cfg->>'hour', '') ~ '^[0-9]{1,2}$' THEN (_cfg->>'hour')::int END, 21);
  _warn       boolean := coalesce((_cfg->>'warn')::boolean, true);
  _now_sk     timestamp := now() AT TIME ZONE 'Europe/Skopje';
  _today      date := (now() AT TIME ZONE 'Europe/Skopje')::date;
  _actor      constant text := 'Систем: правило collabBox 2 дена';
  _run        uuid;
  _cand       integer; _cancel integer; _towarn integer; _collab integer; _link integer;
  _value      numeric;
  _done       integer := 0; _done_value numeric := 0; _warned integer := 0;
BEGIN
  IF _mode NOT IN ('report', 'apply') THEN _mode := 'report'; END IF;

  IF NOT p_force AND NOT p_dry_run THEN
    IF extract(hour FROM _now_sk)::int <> _hour THEN
      RETURN jsonb_build_object('ok', true, 'skipped', 'outside the ' || _hour || ':00 Skopje window');
    END IF;
    IF EXISTS (SELECT 1 FROM public.collab_entry_rule_runs r WHERE r.run_day = _today AND r.trigger_kind = 'cron') THEN
      RETURN jsonb_build_object('ok', true, 'skipped', 'already ran today');
    END IF;
  END IF;

  CREATE TEMP TABLE _cer ON COMMIT DROP AS SELECT * FROM public.collab_entry_rule_plan();

  SELECT count(*),
         count(*) FILTER (WHERE plan_action = 'cancel'),
         count(*) FILTER (WHERE plan_action = 'warn'),
         count(*) FILTER (WHERE plan_action = 'in_collab'),
         count(*) FILTER (WHERE plan_action = 'needs_linking'),
         coalesce(sum(price_eur) FILTER (WHERE plan_action = 'cancel'), 0)
    INTO _cand, _cancel, _towarn, _collab, _link, _value
  FROM _cer;

  IF p_dry_run THEN
    RETURN jsonb_build_object('ok', true, 'dry_run', true, 'mode', _mode, 'days', _days, 'candidates', _cand,
                              'to_cancel', _cancel, 'to_warn', _towarn, 'in_collab', _collab,
                              'needs_linking', _link, 'value_eur', round(_value, 2));
  END IF;

  INSERT INTO public.collab_entry_rule_runs (run_day, mode, trigger_kind, days, candidates, to_cancel, to_warn,
                                             in_collab, needs_linking, value_eur, settings)
  VALUES (_today, _mode, CASE WHEN p_force THEN 'manual' ELSE 'cron' END, _days, _cand, _cancel, _towarn,
          _collab, _link, round(_value, 2), _cfg)
  RETURNING id INTO _run;

  INSERT INTO public.collab_entry_rule_items (run_id, order_id, display_id, action, sold_at, age_days, price_eur,
                                              sold_by_person_id, owner_user_id, evidence)
  SELECT _run, c.order_id, c.display_id, c.plan_action, c.sold_at, c.age_days, c.price_eur, c.sold_by_person_id,
         c.owner_user_id,
         CASE c.plan_action WHEN 'in_collab' THEN c.collab_doc WHEN 'needs_linking' THEN c.unlinked_tracking END
  FROM _cer c;

  IF _mode = 'apply' THEN
    PERFORM set_config('elyon.keep_updated_at', 'on', true);   -- GET /call-agains reads updated_at
    PERFORM set_config('elyon.bulk_repair', 'on', true);

    IF _cancel > 0 THEN
      -- Status-guarded: an order that moved, got a parcel or got its collabBox document since the scan is left alone.
      WITH upd AS (
        UPDATE public.orders o
           SET status = 'cancelled',
               cancellation_reason = 'other',
               cancellation_reason_notes = 'not_in_collab_2d: not entered in collabBox ' || c.age_days
                                           || ' days after the sale (' || _days || '-day rule).'
          FROM _cer c
         WHERE c.plan_action = 'cancel'
           AND o.id = c.order_id
           AND o.status = 'confirmed'
           AND o.mex_tracking_id IS NULL
           AND public.crm_sale_collab_doc(o.id) IS NULL
        RETURNING o.id, c.display_id, c.customer_name, c.price_eur, c.sold_at, c.age_days, c.owner_user_id
      ), hist AS (
        INSERT INTO public.order_history (order_id, from_status, to_status, changed_by, changed_by_name)
        SELECT u.id, 'confirmed'::public.order_status, 'cancelled'::public.order_status, NULL, _actor FROM upd u
        RETURNING order_id
      ), notes AS (
        INSERT INTO public.order_notes (order_id, text, author_id, author_name)
        SELECT u.id,
               'Откажана автоматски: продажбата од ' || to_char(u.sold_at AT TIME ZONE 'Europe/Skopje', 'DD.MM.YYYY')
                 || ' не е внесена во collabBox ' || u.age_days || ' дена. Ако се внесе подоцна, collabBox ја прави '
                 || 'нарачката кога MEX ќе ја создаде пратката.',
               NULL, _actor
        FROM upd u
        RETURNING order_id
      ), bell AS (
        INSERT INTO public.notifications (user_id, title, message, type, link, meta)
        SELECT u.owner_user_id,
               'Order cancelled — not in collabBox',
               'Order ' || u.display_id || coalesce(' (' || nullif(btrim(u.customer_name), '') || ')', '')
                 || ' was not entered in collabBox within ' || _days || ' days and was cancelled.',
               'not_in_collab', '/orders',
               jsonb_build_object('i18n', 'notif.notInCollab', 'order', u.display_id,
                                  'customer', coalesce(u.customer_name, ''), 'days', _days)
        FROM upd u
        WHERE u.owner_user_id IS NOT NULL
        RETURNING id
      ), marked AS (
        UPDATE public.collab_entry_rule_items i SET action = 'cancelled'
          FROM upd u WHERE i.run_id = _run AND i.order_id = u.id AND i.action = 'cancel'
        RETURNING i.order_id
      )
      SELECT count(*), coalesce(sum(u.price_eur), 0) INTO _done, _done_value FROM upd u;

      UPDATE public.collab_entry_rule_items SET action = 'skipped' WHERE run_id = _run AND action = 'cancel';
    END IF;

    IF _warn AND _towarn > 0 THEN
      -- The evening before: one bell per order, never twice.
      WITH w AS (
        SELECT c.* FROM _cer c
        WHERE c.plan_action = 'warn' AND c.owner_user_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM public.collab_entry_rule_items i
                           WHERE i.order_id = c.order_id AND i.action = 'warned')
      ), bell AS (
        INSERT INTO public.notifications (user_id, title, message, type, link, meta)
        SELECT w.owner_user_id,
               'Enter the order in collabBox',
               'Order ' || w.display_id || coalesce(' (' || nullif(btrim(w.customer_name), '') || ')', '')
                 || ' is not in collabBox yet. It is cancelled tomorrow at ' || _hour || ':20 if it is still not entered.',
               'not_in_collab_warning', '/orders',
               jsonb_build_object('i18n', 'notif.notInCollabWarning', 'order', w.display_id,
                                  'customer', coalesce(w.customer_name, ''), 'hour', _hour || ':20')
        FROM w
        RETURNING id
      ), marked AS (
        UPDATE public.collab_entry_rule_items i SET action = 'warned'
          FROM w WHERE i.run_id = _run AND i.order_id = w.order_id AND i.action = 'warn'
        RETURNING i.order_id
      )
      SELECT count(*) INTO _warned FROM marked;
    END IF;

    UPDATE public.collab_entry_rule_runs
       SET cancelled = _done, cancelled_value_eur = round(_done_value, 2), warned = _warned
     WHERE id = _run;
    -- No audit_log row: it requires a human actor_id. The run + items ledger IS the audit trail.
  END IF;

  RETURN jsonb_build_object('ok', true, 'run_id', _run, 'mode', _mode, 'days', _days, 'candidates', _cand,
                            'to_cancel', _cancel, 'to_warn', _towarn, 'in_collab', _collab, 'needs_linking', _link,
                            'value_eur', round(_value, 2), 'cancelled', _done, 'warned', _warned);
END;
$fn$;
COMMENT ON FUNCTION public.apply_collab_entry_rule(boolean, boolean) IS
  'Owner 02.10.2026: a confirmed CRM sale (elyon_crm prediction_list / direct) with no MEX parcel and no collabBox document (crm_sale_collab_doc) `days` (2) Skopje days after its sale day is cancelled at 21:20 Skopje (reason other, note not_in_collab_2d) and its seller gets a bell (not_in_collab); the evening before a warning bell (not_in_collab_warning). report = ledger only. Migration 20260947000200.';

-- ── 5. undo a run ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.collab_entry_rule_undo(p_run uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _n integer := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.collab_entry_rule_runs r WHERE r.id = p_run) THEN
    RAISE EXCEPTION 'collab_entry_rule_undo: unknown run %', p_run USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('elyon.keep_updated_at', 'on', true);
  PERFORM set_config('elyon.bulk_repair', 'on', true);

  WITH upd AS (
    UPDATE public.orders o
       SET status = 'confirmed', cancellation_reason = NULL, cancellation_reason_notes = NULL, cancelled_at = NULL
      FROM public.collab_entry_rule_items i
     WHERE i.run_id = p_run AND i.action = 'cancelled' AND o.id = i.order_id
       AND o.status = 'cancelled' AND o.cancellation_reason = 'other'
       AND coalesce(o.cancellation_reason_notes, '') LIKE 'not_in_collab_2d:%'
    RETURNING o.id
  ), hist AS (
    INSERT INTO public.order_history (order_id, from_status, to_status, changed_by, changed_by_name)
    SELECT u.id, 'cancelled'::public.order_status, 'confirmed'::public.order_status, NULL,
           'Систем: враќање на правилото collabBox 2 дена'
    FROM upd u
    RETURNING order_id
  ), notes AS (
    INSERT INTO public.order_notes (order_id, text, author_id, author_name)
    SELECT u.id, 'Вратена во потврдена: откажувањето од правилото collabBox 2 дена е поништено.', NULL,
           'Систем: враќање на правилото collabBox 2 дена'
    FROM upd u
    RETURNING order_id
  ), marked AS (
    UPDATE public.collab_entry_rule_items i SET action = 'undone'
      FROM upd u WHERE i.run_id = p_run AND i.order_id = u.id AND i.action = 'cancelled'
    RETURNING i.order_id
  )
  SELECT count(*) INTO _n FROM upd;

  UPDATE public.collab_entry_rule_runs SET undone_at = now(), undone = coalesce(undone, 0) + _n WHERE id = p_run;
  RETURN jsonb_build_object('ok', true, 'run_id', p_run, 'undone', _n);
END;
$fn$;
COMMENT ON FUNCTION public.collab_entry_rule_undo(uuid) IS
  'Owner 02.10.2026: reverts the cancels of one collabBox entry-rule run back to confirmed (only orders still cancelled by the rule), with history + a note; updated_at kept. Service role. Migration 20260947000200.';

-- ── 6. the /orders badge: the state of a page of orders ─────────────────────
CREATE OR REPLACE FUNCTION public.crm_sale_collab_states(p_ids uuid[])
RETURNS TABLE(order_id uuid, collab_doc text, sale_day date, cancel_day date, mode text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _cfg  jsonb := coalesce((SELECT s.value FROM public.app_settings s WHERE s.key = 'collab_entry_rule'), '{}'::jsonb);
  _days integer := greatest(1, least(30, coalesce(CASE WHEN coalesce(_cfg->>'days', '') ~ '^[0-9]{1,2}$'
                                                       THEN (_cfg->>'days')::int END, 2)));
  _mode text := CASE WHEN _cfg->>'mode' = 'apply' THEN 'apply' ELSE 'report' END;
BEGIN
  IF coalesce(array_length(p_ids, 1), 0) > 200 THEN
    RAISE EXCEPTION 'crm_sale_collab_states: at most 200 orders' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT x.id, public.crm_sale_collab_doc(x.id),
         (coalesce(x.sold_at, x.confirmed_at, x.created_at) AT TIME ZONE 'Europe/Skopje')::date,
         (coalesce(x.sold_at, x.confirmed_at, x.created_at) AT TIME ZONE 'Europe/Skopje')::date + _days,
         _mode
  FROM public.orders x
  WHERE x.id = ANY (p_ids)
    AND x.status = 'confirmed'
    AND x.sale_source = 'elyon_crm'
    AND x.sale_source_detail IN ('prediction_list', 'direct')
    AND x.mex_tracking_id IS NULL;
END;
$fn$;
COMMENT ON FUNCTION public.crm_sale_collab_states(uuid[]) IS
  'Owner 02.10.2026: for the /orders badge — each confirmed CRM sale without a parcel among the ids: its collabBox document (crm_sale_collab_doc) or NULL, its sale day and the day the 2-day rule cancels it, and the rule''s mode. ≤ 200 ids. Migration 20260947000200.';

DO $g$
BEGIN
  REVOKE ALL ON FUNCTION public.crm_sale_collab_doc(uuid)               FROM PUBLIC, anon, authenticated;
  REVOKE ALL ON FUNCTION public.collab_entry_rule_plan()                FROM PUBLIC, anon, authenticated;
  REVOKE ALL ON FUNCTION public.apply_collab_entry_rule(boolean, boolean) FROM PUBLIC, anon, authenticated;
  REVOKE ALL ON FUNCTION public.collab_entry_rule_undo(uuid)            FROM PUBLIC, anon, authenticated;
  REVOKE ALL ON FUNCTION public.crm_sale_collab_states(uuid[])          FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.crm_sale_collab_doc(uuid)               TO service_role;
  GRANT EXECUTE ON FUNCTION public.collab_entry_rule_plan()                TO service_role;
  GRANT EXECUTE ON FUNCTION public.apply_collab_entry_rule(boolean, boolean) TO service_role;
  GRANT EXECUTE ON FUNCTION public.collab_entry_rule_undo(uuid)            TO service_role;
  GRANT EXECUTE ON FUNCTION public.crm_sale_collab_states(uuid[])          TO service_role;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    GRANT SELECT ON public.collab_entry_rule_runs, public.collab_entry_rule_items TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.crm_sale_collab_doc(uuid)      TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.collab_entry_rule_plan()       TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.crm_sale_collab_states(uuid[]) TO supabase_read_only_user;
  END IF;
END
$g$;

-- ── 7. the owner key ────────────────────────────────────────────────────────
INSERT INTO public.app_settings (key, value, updated_at)
VALUES ('collab_entry_rule', '{"mode":"report","days":2,"hour":21,"from_date":"2026-08-01","warn":true}'::jsonb, now())
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.tg_app_settings_guard_owner_keys()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
DECLARE
  _guarded constant text[] := ARRAY['no_parcel_rule', 'stock_mex_movements', 'stock_counted_at', 'mex_push', 'link_lead_parcels', 'leads_parcel_orders', 'stock_v2', 'shops_reader', 'call_scripts', 'collab_entry_rule'];
BEGIN
  IF current_user IN ('anon', 'authenticated')
     AND (CASE WHEN TG_OP = 'DELETE' THEN OLD.key ELSE NEW.key END = ANY (_guarded)
          OR (TG_OP = 'UPDATE' AND OLD.key = ANY (_guarded))) THEN
    RAISE EXCEPTION 'app_settings.% is changed only through its owners'' switch in the app',
                    CASE WHEN TG_OP = 'INSERT' THEN NEW.key ELSE OLD.key END
      USING ERRCODE = '42501';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;

-- ── 8. the cron: hourly at :20, acts in the `hour` (21) Skopje ──────────────
DO $cron$
BEGIN
  PERFORM cron.unschedule(j.jobid) FROM cron.job j WHERE j.jobname = 'collab-entry-rule';
  PERFORM cron.schedule('collab-entry-rule', '20 * * * *', 'SELECT public.apply_collab_entry_rule();');
END
$cron$;

COMMIT;
