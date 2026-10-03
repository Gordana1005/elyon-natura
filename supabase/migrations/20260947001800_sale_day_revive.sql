-- 20260947001800 — THE SALE DAY OF A REVIVED ORDER = THE BOOKING (owner, 03.10.2026: "ДА")
--
-- "When an old, DEAD order (cancelled / trashed) is revived or credited by a collabBox document
--  or by its MEX parcel, the sale must count on the day the operator BOOKED that document — not
--  on the old order's date."
--
-- Why (coverage audit exports/coverage/pokrienost-2026-10-03.md §8.2): 116 September 10111
-- "Нарачка LEADS" documents (323.260 ден) counted on the date of an AlterCPA / history order of
-- July–August, e.g. 002-9110-174443/2026 booked 01.09 → ORD-77284 of 14.07, 002-9110-174419/2026
-- booked 01.09 → ORD-88154 of 12.08. The cohort's sale moment is
-- coalesce(sold_at, AlterCPA approval, confirmed_at, created_at); a revival never moved sold_at:
--   * collabbox_credit_order() (the writer's LEADS / LEADS-OUT credit) stamped a dead lead with
--     its OLD cohort moment whenever the document fell in another Skopje month (ORD-88154: lead
--     12.08, cancelled 13.08, its 9110 parcel booked 01.09 → sold_at 12.08);
--   * the stamping cron's history_import rule stamps sold_at = coalesce(confirmed_at, created_at)
--     (the history import's 12:00 lead day) on a history lead mex-reconcile revived
--     cancelled → paid / returned on its 9110 parcel (the 11.08 history reconcile);
--   * an approval stamped at its decision (sold_via altercpa / import) that never got a parcel,
--     whose customer bought again weeks later: mex-reconcile / link-lead-parcels linked the new
--     parcel to the old approval (ORD-77284: history approval 14.07 "paid", parcel booked 01.09).
--
-- THE RULE (one definition, sale_day_revive_plan): an order that is a sale now and holds a MEX
-- parcel is RE-TIMED when, at the ARRIVAL of its reviving evidence (the earliest of the parcel's
-- collabBox sales document — its booking / document time — and the parcel's MEX creation), it was
--   'dead'   — cancelled / trashed (order_history; a history import: its import status), or
--   'unsold' — still an undecided lead (pending / take / call_again): no approval existed, or
--   'stale'  — an AlterCPA approval (bridge / history) with no parcel of its own whose sale moment
--              is older than the no-parcel rule (app_settings.no_parcel_rule.days, 10) — dead by
--              that law even where the 21:10 cancel never ran (history imports, before 01.08).
-- Its new sale time = collabbox_sale_at(doc_at, booked_at) of that document; with no document,
-- the parcel's created_at_mex. Only a move FORWARD to a later Skopje day. A living approval
-- (alive at the arrival, or one that held its own earlier parcel) keeps its own time.
-- The seller (sold_by_person_id / sold_by_ext / sold_via) and confirmed_by_* NEVER change — only
-- sold_at. An unstamped order (sold_at NULL) is never touched: stamping sold_at alone would hide
-- it from the stamping cron and from collabbox_credit_order (they take sold_at IS NULL).
--
-- THE WRITER (audited, the guard-trigger pattern of elyon-security): sale_day_revive_apply()
-- is the only code that moves a set sold_at for this rule — it sets elyon.allow_sold_change and
-- elyon.keep_updated_at LOCALLY for its own UPDATE and restores them, writes one ledger row per
-- move (sale_day_revive_moves) under a run (sale_day_revive_runs) — the audit trail, like
-- no_parcel_rule_runs / collab_entry_rule_runs (audit_log needs a real auth user as the actor). sale_day_revive_undo(run) puts every move of a run back (only where sold_at still
-- holds the moved value). The department trigger (zzz_orders_dept_override, UPDATE OF sold_at)
-- re-decides the department for the new day by itself; a lead stays Тим Маџари In.
--
-- FORWARD: collabbox_credit_order() stamps a dead / unsold order with the document time in every
-- month (below); the cron 'sale-day-revive' (migration 20260947001810, after the backfill) runs
-- the same plan every 15 minutes for whatever mex-reconcile / the link repairs / the stamping cron
-- revive later. The order-creating paths already carry the booking — the writer's branch E
-- (created / confirmed / sold = collabbox_sale_at) and leads_parcel_orders (created / confirmed =
-- collabbox_sale_at(doc_at, least(booked_at, doc_at)), credited by the live writer).
--
-- Not changed: the segment engine (it reads orders.created_at — no list band moves), bonus math,
-- insights_sale_rows / leaderboard_day_v2 / insights_cohort (they read sold_at as before),
-- mex-reconcile (it never writes sold_at).

BEGIN;

-- ── 1. The ledger ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.sale_day_revive_runs (
  run_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at   timestamptz,
  mode          text NOT NULL CHECK (mode IN ('dry', 'apply')),
  scope         text NOT NULL,              -- backfill | cron | manual
  since         timestamptz,
  planned       integer,
  moved         integer,
  actor         text,
  summary       jsonb,
  undone_at     timestamptz,
  undone_by     text,
  undo_restored integer
);

CREATE TABLE IF NOT EXISTS public.sale_day_revive_moves (
  id                bigserial PRIMARY KEY,
  run_id            uuid NOT NULL REFERENCES public.sale_day_revive_runs(run_id),
  order_id          uuid NOT NULL,
  display_id        text,
  basis             text NOT NULL CHECK (basis IN ('dead', 'unsold', 'stale')),
  status_at_arrival text,
  old_sold_at       timestamptz NOT NULL,
  new_sold_at       timestamptz NOT NULL,
  arrival_at        timestamptz,
  doc_number        text,
  doc_type_id       text,
  parcel            text,
  value_mkd         numeric,
  sale_source       text,
  sale_source_detail text,
  sold_via          text,
  dept_before       text,
  dept_after        text,
  applied           boolean NOT NULL DEFAULT false,
  undone_at         timestamptz
);
CREATE INDEX IF NOT EXISTS idx_sale_day_revive_moves_run   ON public.sale_day_revive_moves (run_id);
CREATE INDEX IF NOT EXISTS idx_sale_day_revive_moves_order ON public.sale_day_revive_moves (order_id);

ALTER TABLE public.sale_day_revive_runs  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sale_day_revive_moves ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sale_day_revive_runs, public.sale_day_revive_moves FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.sale_day_revive_moves_id_seq FROM PUBLIC, anon, authenticated;

-- ── 2. The switch (owner key; the backfill run below is manual, the cron reads it) ──
INSERT INTO public.app_settings (key, value)
VALUES ('sale_day_revive', jsonb_build_object(
          'mode', 'apply',
          'note', 'owner 03.10.2026: a dead order revived by a collabBox document / its MEX parcel counts on the booking day'))
ON CONFLICT (key) DO NOTHING;

-- ── 3. The status an order had at a moment (order_history) ─────────────────
-- The last transition at or before p_at; else the from_status of the first one after it (the
-- status the order had all along — a history import carries its import status there). The first
-- row after p_at may be the INSERT row (from_status NULL) of an order created earlier in reality
-- (orders.created_at = the lead's own time): the AlterCPA catch-ups of 18.09 inserted weeks-old
-- leads with the status AlterCPA reported — that status is the evidence. An order created after
-- p_at → '(not_yet)'; no history at all → its status now.
CREATE OR REPLACE FUNCTION public.order_status_at(p_order uuid, p_at timestamptz)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT CASE WHEN o.created_at > p_at THEN '(not_yet)' ELSE coalesce(
    (SELECT h.to_status::text FROM public.order_history h
      WHERE h.order_id = p_order AND h.changed_at <= p_at
      ORDER BY h.changed_at DESC, h.id DESC LIMIT 1),
    (SELECT coalesce(h.from_status, h.to_status)::text
       FROM public.order_history h
      WHERE h.order_id = p_order AND h.changed_at > p_at
      ORDER BY h.changed_at, h.id LIMIT 1),
    o.status::text) END
  FROM public.orders o WHERE o.id = p_order;
$fn$;
REVOKE ALL ON FUNCTION public.order_status_at(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.order_status_at(uuid, timestamptz) TO service_role;

-- ── 4. The plan — ONE definition (backfill, cron, verify-sale-day-revive.mjs) ──
-- p_since bounds the NEW sale time (the day the sale moves to); p_order = one order only.
CREATE OR REPLACE FUNCTION public.sale_day_revive_plan(
  p_since timestamptz DEFAULT '2026-01-01 00:00:00+01',
  p_order uuid DEFAULT NULL)
RETURNS TABLE (
  order_id uuid, display_id text, basis text, status_at_arrival text,
  old_sold_at timestamptz, new_sold_at timestamptz, arrival_at timestamptz,
  doc_number text, doc_type_id text, parcel text, value_mkd numeric,
  sale_source text, sale_source_detail text, sold_via text, dept_before text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  WITH prm AS (
    SELECT coalesce((SELECT CASE WHEN (s.value ->> 'days') ~ '^[0-9]{1,3}$' THEN (s.value ->> 'days')::int END
                       FROM public.app_settings s WHERE s.key = 'no_parcel_rule'), 10) AS stale_days
  ),
  e AS (            -- a sale now, stamped, holding a parcel; its reviving evidence
    SELECT o.id, o.display_id, o.status::text AS status, o.sold_at, o.sold_via, o.mex_tracking_id,
           o.created_at, o.sale_source, o.sale_source_detail, o.price, o.dept_override,
           d.doc_number, d.doc_type_id, d.booked_at,
           public.collabbox_sale_at(d.doc_at, d.booked_at) AS t_doc,
           p.created_at_mex AS t_par, p.cod_mkd
    FROM public.orders o
    LEFT JOIN public.mex_parcels p ON p.tracking_id = o.mex_tracking_id
    LEFT JOIN LATERAL (
      SELECT d.doc_number, d.doc_type_id, d.doc_at, d.booked_at
      FROM public.collabbox_documents d
      WHERE d.doc_number = o.mex_tracking_id
        AND public.collabbox_doc_role(d.doc_type_id) <> 'record'      -- a SALES document
        AND NOT coalesce(d.is_storno, false)
        AND d.vanished_at IS NULL
    ) d ON true
    WHERE o.mex_tracking_id IS NOT NULL
      AND o.status::text IN ('confirmed', 'shipped', 'delivered', 'paid', 'returned')
      AND o.sold_at IS NOT NULL
      AND (p_order IS NULL OR o.id = p_order)
      -- an undone move stays undone: the cron never moves that order again
      AND NOT EXISTS (SELECT 1 FROM public.sale_day_revive_moves u
                       WHERE u.order_id = o.id AND u.undone_at IS NOT NULL)
  ),
  a AS (
    SELECT e.*,
           coalesce(e.t_doc, e.t_par)            AS new_at,
           least(e.t_doc, e.booked_at, e.t_par)  AS arr_at
    FROM e
    WHERE coalesce(e.t_doc, e.t_par) >= p_since
      AND (coalesce(e.t_doc, e.t_par) AT TIME ZONE 'Europe/Skopje')::date
          > (e.sold_at AT TIME ZONE 'Europe/Skopje')::date                -- forward only, another day
  ),
  s AS (
    SELECT a.*,
           public.order_status_at(a.id, a.arr_at) AS st_arr,
           (EXISTS (SELECT 1 FROM public.mex_parcels m
                     WHERE m.order_id = a.id AND m.tracking_id <> a.mex_tracking_id
                       AND m.created_at_mex < a.arr_at)
            OR EXISTS (SELECT 1 FROM public.order_history h
                        WHERE h.order_id = a.id AND h.changed_at < a.arr_at
                          AND h.to_status::text IN ('shipped', 'delivered', 'paid', 'returned')
                          AND h.changed_by_name LIKE 'System (mex:%')) AS had_parcel
    FROM a
  ),
  b AS (
    SELECT s.*,
           CASE WHEN s.st_arr IN ('cancelled', 'trashed') THEN 'dead'
                WHEN s.st_arr IN ('pending', 'take', 'call_again') THEN 'unsold'
                WHEN s.st_arr IN ('confirmed', 'shipped', 'delivered', 'paid', 'returned')
                     AND s.sale_source = 'altercpa' AND s.sale_source_detail IN ('bridge', 'history')
                     AND NOT s.had_parcel
                     AND s.sold_at < s.arr_at - make_interval(days => (SELECT prm.stale_days FROM prm))
                  THEN 'stale'
           END AS basis
    FROM s
  )
  SELECT b.id, b.display_id, b.basis, b.st_arr, b.sold_at, b.new_at, b.arr_at,
         b.doc_number, b.doc_type_id, b.mex_tracking_id,
         coalesce(nullif(b.cod_mkd, 0)::numeric, round(coalesce(b.price, 0) * 61.5)),
         b.sale_source, b.sale_source_detail, b.sold_via,
         public.cohort_order_source(b.sale_source, b.sale_source_detail, b.mex_tracking_id, b.dept_override)
  FROM b
  WHERE b.basis IS NOT NULL
    -- the sale is dated BEFORE its reviving evidence existed
    AND b.sold_at < b.arr_at;
$fn$;
REVOKE ALL ON FUNCTION public.sale_day_revive_plan(timestamptz, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sale_day_revive_plan(timestamptz, uuid) TO service_role;

-- ── 5. The audited writer ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.sale_day_revive_apply(
  p_dry   boolean     DEFAULT true,
  p_scope text        DEFAULT 'manual',
  p_since timestamptz DEFAULT '2026-01-01 00:00:00+01',
  p_limit integer     DEFAULT 5000,
  p_actor text        DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _mode     text := coalesce((SELECT s.value ->> 'mode' FROM public.app_settings s WHERE s.key = 'sale_day_revive'), 'off');
  _run      uuid;
  _planned  integer := 0;
  _moved    integer := 0;
  _prev_ku  text;
  _prev_as  text;
  _summary  jsonb;
BEGIN
  IF p_scope NOT IN ('backfill', 'cron', 'manual') THEN
    RAISE EXCEPTION 'sale_day_revive_apply: unknown scope %', p_scope;
  END IF;
  -- the cron obeys the switch; a manual / backfill run is a person's decision (still logged)
  IF p_scope = 'cron' AND _mode = 'off' THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'switch off');
  END IF;
  IF p_scope = 'cron' AND _mode = 'report' THEN
    p_dry := true;
  END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('public.sale_day_revive_apply', 0)) THEN
    RETURN jsonb_build_object('ok', false, 'skipped', 'another run holds the lock');
  END IF;

  INSERT INTO public.sale_day_revive_runs (mode, scope, since, actor)
  VALUES (CASE WHEN p_dry THEN 'dry' ELSE 'apply' END, p_scope, p_since, p_actor)
  RETURNING run_id INTO _run;

  INSERT INTO public.sale_day_revive_moves
         (run_id, order_id, display_id, basis, status_at_arrival, old_sold_at, new_sold_at, arrival_at,
          doc_number, doc_type_id, parcel, value_mkd, sale_source, sale_source_detail, sold_via, dept_before)
  SELECT _run, pl.order_id, pl.display_id, pl.basis, pl.status_at_arrival, pl.old_sold_at, pl.new_sold_at,
         pl.arrival_at, pl.doc_number, pl.doc_type_id, pl.parcel, pl.value_mkd, pl.sale_source,
         pl.sale_source_detail, pl.sold_via, pl.dept_before
  FROM public.sale_day_revive_plan(p_since, NULL) pl
  ORDER BY pl.new_sold_at, pl.order_id
  LIMIT greatest(coalesce(p_limit, 5000), 0);
  GET DIAGNOSTICS _planned = ROW_COUNT;

  IF _planned = 0 AND p_scope = 'cron' THEN            -- an empty tick leaves no run behind
    DELETE FROM public.sale_day_revive_runs WHERE run_id = _run;
    RETURN jsonb_build_object('ok', true, 'planned', 0, 'moved', 0);
  END IF;

  IF NOT p_dry AND _planned > 0 THEN
    _prev_ku := current_setting('elyon.keep_updated_at', true);
    _prev_as := current_setting('elyon.allow_sold_change', true);
    PERFORM set_config('elyon.keep_updated_at', 'on', true);     -- GET /call-agains reads updated_at
    PERFORM set_config('elyon.allow_sold_change', 'on', true);   -- the write-once guard, for THIS update only

    WITH up AS (
      UPDATE public.orders o
         SET sold_at = m.new_sold_at
        FROM public.sale_day_revive_moves m
       WHERE m.run_id = _run
         AND o.id = m.order_id
         AND o.sold_at = m.old_sold_at                -- untouched since the plan
      RETURNING o.id,
                public.cohort_order_source(o.sale_source, o.sale_source_detail, o.mex_tracking_id, o.dept_override) AS dept
    )
    UPDATE public.sale_day_revive_moves m
       SET applied = true, dept_after = up.dept
      FROM up
     WHERE m.run_id = _run AND m.order_id = up.id;
    GET DIAGNOSTICS _moved = ROW_COUNT;

    PERFORM set_config('elyon.allow_sold_change', coalesce(_prev_as, ''), true);
    PERFORM set_config('elyon.keep_updated_at', coalesce(_prev_ku, ''), true);
  END IF;

  SELECT jsonb_build_object(
           'by_basis', coalesce((SELECT jsonb_object_agg(x.basis, x.n) FROM (
                          SELECT m.basis, count(*) AS n FROM public.sale_day_revive_moves m
                           WHERE m.run_id = _run GROUP BY 1) x), '{}'::jsonb),
           'value_mkd', coalesce((SELECT sum(m.value_mkd) FROM public.sale_day_revive_moves m WHERE m.run_id = _run), 0))
    INTO _summary;

  UPDATE public.sale_day_revive_runs
     SET finished_at = clock_timestamp(), planned = _planned, moved = _moved, summary = _summary
   WHERE run_id = _run;

  RETURN jsonb_build_object('ok', true, 'run_id', _run, 'dry', p_dry, 'planned', _planned, 'moved', _moved,
                            'summary', _summary);
END
$fn$;
REVOKE ALL ON FUNCTION public.sale_day_revive_apply(boolean, text, timestamptz, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sale_day_revive_apply(boolean, text, timestamptz, integer, text) TO service_role;

-- ── 6. The undo ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.sale_day_revive_undo(p_run uuid, p_actor text DEFAULT NULL, p_basis text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _n       integer := 0;
  _left    integer := 0;
  _prev_ku text;
  _prev_as text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.sale_day_revive_runs r WHERE r.run_id = p_run AND r.mode = 'apply') THEN
    RAISE EXCEPTION 'sale_day_revive_undo: no applied run %', p_run;
  END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('public.sale_day_revive_apply', 0)) THEN
    RAISE EXCEPTION 'sale_day_revive_undo: a run holds the lock — try again';
  END IF;

  _prev_ku := current_setting('elyon.keep_updated_at', true);
  _prev_as := current_setting('elyon.allow_sold_change', true);
  PERFORM set_config('elyon.keep_updated_at', 'on', true);
  PERFORM set_config('elyon.allow_sold_change', 'on', true);

  WITH up AS (
    UPDATE public.orders o
       SET sold_at = m.old_sold_at
      FROM public.sale_day_revive_moves m
     WHERE m.run_id = p_run AND m.applied AND m.undone_at IS NULL
       AND (p_basis IS NULL OR m.basis = p_basis)           -- e.g. only the 'stale' approvals
       AND o.id = m.order_id
       AND o.sold_at = m.new_sold_at                  -- only what this run left in place
    RETURNING o.id
  )
  UPDATE public.sale_day_revive_moves m
     SET undone_at = clock_timestamp()
    FROM up
   WHERE m.run_id = p_run AND m.order_id = up.id;
  GET DIAGNOSTICS _n = ROW_COUNT;

  PERFORM set_config('elyon.allow_sold_change', coalesce(_prev_as, ''), true);
  PERFORM set_config('elyon.keep_updated_at', coalesce(_prev_ku, ''), true);

  SELECT count(*) INTO _left FROM public.sale_day_revive_moves m
   WHERE m.run_id = p_run AND m.applied AND m.undone_at IS NULL
     AND (p_basis IS NULL OR m.basis = p_basis);

  UPDATE public.sale_day_revive_runs
     SET undone_at = clock_timestamp(), undone_by = p_actor, undo_restored = coalesce(undo_restored, 0) + _n
   WHERE run_id = p_run;

  RETURN jsonb_build_object('ok', true, 'run_id', p_run, 'basis', p_basis, 'restored', _n, 'not_restored_changed_since', _left);
END
$fn$;
REVOKE ALL ON FUNCTION public.sale_day_revive_undo(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sale_day_revive_undo(uuid, text, text) TO service_role;

-- ── 7. The forward rule in the writer's credit ─────────────────────────────
-- collabbox_credit_order() (live definition of 20260944000500 / …0600, re-emitted unchanged
-- except the sale time): an order that was dead / an undecided lead when this document (or its
-- parcel) arrived is stamped with the DOCUMENT time in every month — the old "another month →
-- keep the cohort moment" rule stamped ORD-88154 with its 12.08 lead day for a 01.09 booking.
-- Anything else keeps the old rule (the same Skopje month → the document time, else the cohort).
CREATE OR REPLACE FUNCTION public.collabbox_credit_order(p_order uuid, p_doc text, p_doc_at timestamp with time zone, p_author text, p_dry boolean)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _o       record;
  _person  uuid;
  _ext     text;
  _cohort  timestamptz;
  _sold_at timestamptz;
  _arr_st  text;
BEGIN
  IF p_order IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT i.person_id, i.ext INTO _person, _ext FROM public.collabbox_author_identity(p_author) i;
  IF _ext IS NULL THEN
    RETURN 'no_author';
  END IF;

  SELECT o.id, o.status::text AS status, o.price, o.product_name, o.created_at, o.confirmed_at,
         o.mex_tracking_id, o.sold_at, o.sold_via, o.sold_by_ext, o.sold_by_person_id
    INTO _o
    FROM public.orders o
   WHERE o.id = p_order;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF _o.sold_at IS NOT NULL OR _o.sold_via IS NOT NULL OR _o.sold_by_ext IS NOT NULL
     OR _o.sold_by_person_id IS NOT NULL THEN
    IF _o.sold_by_person_id IS NULL AND _person IS NOT NULL
       AND _o.sold_via = 'collabbox' AND _o.sold_by_ext = _ext THEN
      IF NOT p_dry THEN
        UPDATE public.orders SET sold_by_person_id = _person
         WHERE id = p_order AND sold_by_person_id IS NULL;
      END IF;
      RETURN 'person_filled';
    END IF;
    RETURN CASE WHEN _o.sold_via = 'collabbox' THEN 'already' ELSE 'other_decider' END;
  END IF;

  IF _o.status = 'duplicated' OR coalesce(_o.price, 0) <= 0
     OR public.is_synthetic_product_name(_o.product_name) THEN
    RETURN 'not_a_sale';
  END IF;
  -- a sale now, or MEX moves this very parcel (a cancelled lead that shipped — the cohort counts it)
  IF _o.status NOT IN ('confirmed', 'shipped', 'delivered', 'paid', 'returned')
     AND _o.mex_tracking_id IS DISTINCT FROM p_doc THEN
    RETURN 'not_a_sale';
  END IF;
  IF p_doc_at < _o.created_at - interval '48 hours' THEN
    RETURN 'doc_predates_order';
  END IF;
  IF EXISTS (SELECT 1 FROM public.orders x WHERE x.mex_tracking_id = p_doc AND x.id <> p_order)
     OR EXISTS (SELECT 1 FROM public.mex_parcels m
                 WHERE m.tracking_id = p_doc AND m.order_id IS NOT NULL AND m.order_id <> p_order) THEN
    RETURN 'parcel_shared';
  END IF;

  SELECT coalesce(max(l.decided_at), _o.confirmed_at, _o.created_at) INTO _cohort
    FROM public.altercpa_leads l
   WHERE l.order_id = p_order AND l.decision IN ('approved', 'cancel_other') AND l.decided_at IS NOT NULL;
  -- 03.10.2026 (owner "ДА"): the status the order had when this document / its parcel arrived
  _arr_st := public.order_status_at(p_order,
               least(p_doc_at, coalesce((SELECT m.created_at_mex FROM public.mex_parcels m WHERE m.tracking_id = p_doc), p_doc_at)));
  _sold_at := CASE WHEN _arr_st IN ('cancelled', 'trashed', 'pending', 'take', 'call_again')
                   THEN p_doc_at                                  -- dead / undecided: the booking is the sale
                   WHEN to_char(p_doc_at AT TIME ZONE 'Europe/Skopje', 'YYYY-MM')
                      = to_char(_cohort AT TIME ZONE 'Europe/Skopje', 'YYYY-MM')
                   THEN p_doc_at ELSE _cohort END;

  IF NOT p_dry THEN
    UPDATE public.orders o
       SET sold_at = _sold_at, sold_via = 'collabbox', sold_by_ext = _ext, sold_by_person_id = _person
     WHERE o.id = p_order
       AND o.sold_at IS NULL AND o.sold_via IS NULL AND o.sold_by_ext IS NULL AND o.sold_by_person_id IS NULL;
    IF NOT FOUND THEN
      RETURN 'already';
    END IF;
  END IF;
  RETURN CASE WHEN _person IS NULL THEN 'stamped_no_person' ELSE 'stamped' END;
END;
$function$;

COMMIT;
