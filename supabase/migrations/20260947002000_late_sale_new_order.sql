-- 20260947002000 — A LATE SALE IS A NEW ORDER (owner, 03.10.2026 — he answered "ДА" to exactly this)
--
-- When a collabBox SALES document (10111 / 10114 / 10036 / 10050 / 10106 / 10055) or a MEX parcel
-- arrives for an EXISTING order:
--   1. the lead is still open (pending / take / call_again, "повторно барање")  → the lead's sale
--      (Тим Маџари In) — unchanged;
--   2. the order was cancelled / trashed and the document / parcel arrives ≤ 10 days after that
--      cancel / trash → that order's own sale ("cancelled in AlterCPA, then shipped"), revived on the
--      booking day — unchanged (sale_day_revive, 20260947001800);
--   3. EVERYTHING ELSE is a NEW order on the booking day: more than 10 days after the cancel / trash,
--      or the old order's own sale already existed (an approval / a sale older than 10 days at the
--      arrival, or an order that already shipped its own earlier parcel). Owner: "14.07 → 01.09 нема
--      шанси, тоа мора да биде нов ордер … во друг однос, тоа е Out нарачка".
--      The new order is made by the LIVE collabBox writer (collabbox_apply_one, branch E — re-emitted
--      by 20260947002010), credited to the document's author, sold / created / confirmed at the
--      booking (collabbox_sale_at), the parcel moves to it, and its department is decided by the
--      author's LINE team (order_dept_by_team — Маџари people → Тим Маџари Out). A 10111 "Нарачка
--      LEADS" document normally makes no order (its sale is the AlterCPA lead); as a late sale it is
--      stored elyon_crm / collabbox_leads_late — NOT altercpa, so it is never a lead: the mapping puts
--      any elyon_crm detail but prediction_list / direct / collabbox_out in Affiliate – Lead out, and
--      the team rule (order_dept_by_team, which returns NULL only for sale_source 'altercpa') moves it
--      to the author's team department. The OLD order goes back to exactly what it was before the late
--      document / parcel touched it (late_sale_release). One sale, one order, never counted twice.
--
-- THE 10 DAYS (late_sale_dead_at / late_sale_classify): from the old order's cancel / trash — the last
-- order_history transition into cancelled / trashed at or before the arrival; else the AlterCPA ledger's
-- cancel / trash decision; else orders.cancelled_at / trashed_at (when ≤ the arrival); else
-- orders.updated_at (when ≤ the arrival — the latest the cancel can have been); else the order's own
-- creation (history imports carry no cancel time: the lead's day). For a sale: from its original sale
-- moment — the sale_day_revive ledger's old_sold_at when that re-timed it, else the earliest of sold_at,
-- the AlterCPA approval and confirmed_at, else created_at. The ARRIVAL = the earliest of the document's
-- sale time (collabbox_sale_at), its booking and the parcel's MEX creation (the same moment
-- sale_day_revive_plan uses). app_settings.late_sale_new_order.days (10) is the one knob.
--
-- Paths (this migration + 20260947002010):
--   * the writer (collabbox_apply_one): a LEADS credit, a LEADS-OUT credit or a teleshop / social
--     document whose parcel is held by a case-3 order → releases that order and creates the new one
--     (switch app_settings.late_sale_new_order.mode = apply; seeded 'report' — the writer then only
--     flags `late_sale_pending:<case>` and credits as before; a payload `late_sale_force: true` — the
--     history repair — applies whatever the switch says);
--   * collabbox_credit_order: never stamps a case-3 holder in apply mode (verdict 'late_sale');
--   * sale_day_revive_plan: never re-times a case-3 order (the 'stale' basis is gone; a 'dead' order
--     only when it is case 2);
--   * mex-reconcile (edge function): never REVIVES a case-3 order (it links, the writer splits), and a
--     not_in_collab_5d cancel comes back like no_parcel_7d within the 10 days;
--   * link_lead_parcels_plan (order created −10 d … +1 d of the parcel) and leads_parcel_orders_plan
--     (orphan 9110 parcels, no order) never attach a case-3 parcel — windows checked, unchanged.
-- History: scripts/repair-late-sale-new-order.mjs (dry run / --apply / --rollback <run>) re-applies each
-- case-3 unit's document through this writer; proof scripts/verify-late-sale-new-order.mjs.

BEGIN;

-- ── 1. The switch ──────────────────────────────────────────────────────────────
INSERT INTO public.app_settings (key, value)
VALUES ('late_sale_new_order', jsonb_build_object(
          'mode', 'report',
          'days', 10,
          'note', 'owner 03.10.2026 "ДА": a collabBox document / MEX parcel that arrives > 10 days after the old order''s cancel / trash, or after its own sale, is a NEW order on the booking day'))
ON CONFLICT (key) DO NOTHING;

-- ── 2. The cancel / trash moment of an order, as of p_at ───────────────────────
CREATE OR REPLACE FUNCTION public.late_sale_dead_at(p_order uuid, p_at timestamptz)
RETURNS timestamptz
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT coalesce(
    (SELECT max(h.changed_at) FROM public.order_history h
      WHERE h.order_id = p_order AND h.changed_at <= p_at AND h.to_status::text IN ('cancelled', 'trashed')),
    (SELECT max(l.decided_at) FROM public.altercpa_leads l
      WHERE l.order_id = p_order AND l.decision IN ('cancelled', 'trashed') AND l.decided_at <= p_at),
    (SELECT least(o.cancelled_at, o.trashed_at) FROM public.orders o
      WHERE o.id = p_order AND least(o.cancelled_at, o.trashed_at) <= p_at),
    (SELECT o.updated_at FROM public.orders o WHERE o.id = p_order AND o.updated_at <= p_at),
    (SELECT o.created_at FROM public.orders o WHERE o.id = p_order));
$fn$;
REVOKE ALL ON FUNCTION public.late_sale_dead_at(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.late_sale_dead_at(uuid, timestamptz) TO service_role, supabase_read_only_user;

-- ── 3. THE classification — one definition (writer, credit, revive plan, plan, checker) ──
-- kase: is_document (the order IS the document) · no_arrival · not_existing (created after the arrival)
--       · open (case 1) · dead_recent (case 2) · own (its own sale, ≤ 10 days) · other
--       · dead_late / stale / second_sale (case 3 → a NEW order)
CREATE OR REPLACE FUNCTION public.late_sale_classify(p_order uuid, p_tracking text)
RETURNS TABLE (kase text, arrival_at timestamptz, status_at text, dead_at timestamptz, sale_at timestamptz,
               gap_days numeric, prior_parcel text, doc_number text, doc_type_id text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  WITH prm AS (
    SELECT coalesce((SELECT CASE WHEN (s.value ->> 'days') ~ '^[0-9]{1,3}$' THEN (s.value ->> 'days')::int END
                       FROM public.app_settings s WHERE s.key = 'late_sale_new_order'), 10) AS days,
           coalesce((SELECT CASE WHEN (s.value ->> 'postpone_days') ~ '^[0-9]{1,3}$' THEN (s.value ->> 'postpone_days')::int END
                       FROM public.app_settings s WHERE s.key = 'collab_entry_rule'), 45) AS postpone_days
  ),
  a AS (
    SELECT o.id, o.created_at, o.confirmed_at, o.sold_at, o.external_order_id,
           least(public.collabbox_sale_at(d.doc_at, d.booked_at), d.booked_at, p.created_at_mex) AS arr,
           d.doc_number, d.doc_type_id
    FROM public.orders o
    LEFT JOIN public.mex_parcels p ON p.tracking_id = p_tracking
    LEFT JOIN LATERAL (
      SELECT d.doc_number, d.doc_type_id, d.doc_at, d.booked_at
      FROM public.collabbox_documents d
      WHERE d.doc_number = p_tracking
        AND public.collabbox_doc_role(d.doc_type_id) <> 'record'         -- a SALES document
        AND NOT coalesce(d.is_storno, false)
        AND d.vanished_at IS NULL
    ) d ON true
    WHERE o.id = p_order
  ),
  s AS (
    SELECT a.*,
           CASE WHEN a.arr IS NOT NULL THEN public.order_status_at(a.id, a.arr) END AS st,
           (SELECT m.tracking_id FROM public.mex_parcels m
             WHERE m.order_id = a.id AND m.tracking_id <> p_tracking AND m.created_at_mex < a.arr
             ORDER BY m.created_at_mex DESC LIMIT 1)                       AS p0,
           CASE WHEN a.arr IS NOT NULL THEN public.late_sale_dead_at(a.id, a.arr) END AS dat,
           coalesce(
             (SELECT m.old_sold_at FROM public.sale_day_revive_moves m
               WHERE m.order_id = a.id AND m.applied AND m.undone_at IS NULL ORDER BY m.id DESC LIMIT 1),
             least(a.sold_at,
                   (SELECT max(l.decided_at) FROM public.altercpa_leads l
                     WHERE l.order_id = a.id AND l.decision IN ('approved', 'cancel_other')),
                   a.confirmed_at),
             a.created_at)                                                 AS s0
    FROM a
  )
  SELECT CASE
           WHEN s.external_order_id = p_tracking                          THEN 'is_document'
           WHEN s.arr IS NULL                                             THEN 'no_arrival'
           WHEN s.st = '(not_yet)'                                        THEN 'not_existing'
           WHEN s.st IN ('pending', 'take', 'call_again')                 THEN 'open'
           WHEN s.st IN ('cancelled', 'trashed') THEN
             CASE WHEN s.arr - s.dat > make_interval(days => prm.days) THEN 'dead_late' ELSE 'dead_recent' END
           WHEN s.st IN ('confirmed', 'shipped', 'delivered', 'paid', 'returned') THEN
             CASE WHEN s.p0 IS NOT NULL                                   THEN 'second_sale'
                  WHEN s.arr - s.s0 <= make_interval(days => prm.days)    THEN 'own'
                  -- an approval whose DELIVERY the customer postponed (the no-parcel rule's own exemption,
                  -- sale_delivery_postponed_note, ≤ postpone_days): its own parcel, not a new order
                  WHEN s.st = 'confirmed' AND s.arr - s.s0 <= make_interval(days => prm.postpone_days)
                       AND public.sale_delivery_postponed_note(s.id) IS NOT NULL THEN 'own'
                  ELSE 'stale' END
           ELSE 'other'
         END,
         s.arr, s.st,
         CASE WHEN s.st IN ('cancelled', 'trashed') THEN s.dat END,
         s.s0,
         round((extract(epoch FROM s.arr - CASE WHEN s.st IN ('cancelled', 'trashed') THEN s.dat ELSE s.s0 END) / 86400.0)::numeric, 1),
         s.p0, s.doc_number, s.doc_type_id
  FROM s CROSS JOIN prm;
$fn$;
REVOKE ALL ON FUNCTION public.late_sale_classify(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.late_sale_classify(uuid, text) TO service_role, supabase_read_only_user;

CREATE OR REPLACE FUNCTION public.late_sale_case_of(p_order uuid, p_tracking text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT c.kase FROM public.late_sale_classify(p_order, p_tracking) c;
$fn$;
REVOKE ALL ON FUNCTION public.late_sale_case_of(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.late_sale_case_of(uuid, text) TO service_role, supabase_read_only_user;

-- ── 4. The ledger (one row per split: the writer's forward ones and the history repair's) ──
CREATE TABLE IF NOT EXISTS public.late_sale_moves (
  id               bigserial PRIMARY KEY,
  sync_run_id      uuid,                         -- the collabbox_sync_runs row the writer ran under
  scope            text NOT NULL DEFAULT 'writer' CHECK (scope IN ('writer', 'repair')),
  order_id         uuid NOT NULL,                -- the OLD order
  display_id       text,
  tracking         text NOT NULL,
  doc_number       text,
  doc_type_id      text,
  kase             text NOT NULL CHECK (kase IN ('dead_late', 'stale', 'second_sale')),
  status_at        text,
  arrival_at       timestamptz,
  dead_at          timestamptz,
  sale_at          timestamptz,
  gap_days         numeric,
  prior_parcel     text,
  before           jsonb NOT NULL,               -- the old order + its register row + items, as they were
  after            jsonb,                        -- the old order as released
  doc_before       jsonb,                        -- the collabbox_documents row before the re-apply
  revive_moves     bigint[],                     -- sale_day_revive_moves this release closed
  dept_before      text,
  new_order_id     uuid,
  new_display_id   text,
  dept_after       text,
  value_mkd        numeric,
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  undone_at        timestamptz,
  undone_by        text
);
CREATE INDEX IF NOT EXISTS idx_late_sale_moves_order    ON public.late_sale_moves (order_id);
CREATE INDEX IF NOT EXISTS idx_late_sale_moves_run      ON public.late_sale_moves (sync_run_id);
CREATE INDEX IF NOT EXISTS idx_late_sale_moves_new      ON public.late_sale_moves (new_order_id);
CREATE INDEX IF NOT EXISTS idx_late_sale_moves_tracking ON public.late_sale_moves (tracking);
ALTER TABLE public.late_sale_moves ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.late_sale_moves FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.late_sale_moves_id_seq FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.late_sale_moves TO supabase_read_only_user;

-- ── 5. The release: the OLD order back to what it was before the late document / parcel ──
-- Called by the writer inside the same sub-block as the new order's INSERT (a failed INSERT / link
-- rolls the release back with it). Restores:
--   status          = its status at the arrival (order_status_at); a second sale → its own earlier
--                     parcel's MEX status (2 paid · 7 returned · 8 confirmed · else shipped), with that
--                     parcel back on the order;
--   cancel / trash  = dated by the cancel / trash moment; reason from the actor of that transition
--                     ('System (no-parcel-7d)' → no_parcel_7d; the 5-day collabBox rule → other + "Нема
--                     внесено порачка во Collab"; anything else → other + a system note — mex-reconcile
--                     wiped the original); a trash → not_reachable (the 21-day park, owner 27.09);
--   money / MEX     = this parcel's mex_* / mex_sent_at / paid / returned / shipped stamps cleared
--                     (a 'paid' history order keeps its own paid_at, else confirmed / created);
--   price           = the cod-price repair's before-price when that repair priced it from THIS parcel
--                     and the price is still the repair's;
--   sold_at         = the sale_day_revive ledger's old_sold_at (that move is closed);
--   sold_*          = cleared when THIS document's author was stamped on it by its credit (the sale
--                     is the new order's) — the stamping cron then credits the old order by its own rules;
--   register        = this parcel unlinked (the writer links it to the new order).
-- Never a person's cancel (changed_by NULL, 'System (late-sale:new-order)'); nothing is sent to AlterCPA.
CREATE OR REPLACE FUNCTION public.late_sale_release(p_run uuid, p_order uuid, p_tracking text, p_case text, p_scope text DEFAULT 'writer')
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  c_actor   CONSTANT text := 'System (late-sale:new-order)';
  _o        public.orders%ROWTYPE;
  _c        record;
  _p0       public.mex_parcels%ROWTYPE;
  _has_p0   boolean := false;
  _d        public.collabbox_documents%ROWTYPE;
  _has_d    boolean := false;
  _st       text;
  _who      text;
  _creason  text;
  _cnote    text;
  _tnote    text;
  _paid     timestamptz;
  _ret      timestamptz;
  _ship     timestamptz;
  _basis    text;
  _cp_id    bigint;
  _cp_bef   jsonb;
  _rv_ids   bigint[];
  _rv_old   timestamptz;
  _ext      text;
  _clear    boolean := false;
  _id       bigint;
  _before   jsonb;
  _prev_as  text;
  _prev_ku  text;
  _day      text := to_char(now() AT TIME ZONE 'Europe/Skopje', 'DD.MM.YYYY');
  _what     text;
BEGIN
  SELECT * INTO _o FROM public.orders WHERE id = p_order FOR UPDATE;
  IF NOT FOUND OR _o.mex_tracking_id IS DISTINCT FROM p_tracking THEN
    RAISE EXCEPTION 'late_sale_release: order % does not hold parcel %', p_order, p_tracking;
  END IF;
  SELECT * INTO _c FROM public.late_sale_classify(p_order, p_tracking);
  IF _c.kase IS DISTINCT FROM p_case OR _c.kase NOT IN ('dead_late', 'stale', 'second_sale') THEN
    RAISE EXCEPTION 'late_sale_release: order % / % is %, not %', p_order, p_tracking, coalesce(_c.kase, 'unknown'), p_case;
  END IF;
  IF EXISTS (SELECT 1 FROM public.agent_payout_items ap WHERE ap.order_id = p_order) THEN
    RAISE EXCEPTION 'late_sale_release: order % is in agent_payout_items (payouts deferred by the owner)', p_order;
  END IF;
  SELECT * INTO _d FROM public.collabbox_documents WHERE doc_number = p_tracking;
  _has_d := FOUND;

  _before := to_jsonb(_o)
             || jsonb_build_object(
                  '_register', (SELECT jsonb_agg(jsonb_build_object('tracking_id', m.tracking_id, 'order_id', m.order_id,
                                                                   'link_method', m.link_method, 'linked_at', m.linked_at))
                                  FROM public.mex_parcels m WHERE m.tracking_id = p_tracking OR m.order_id = p_order),
                  '_items', (SELECT coalesce(jsonb_agg(to_jsonb(i)), '[]'::jsonb) FROM public.order_items i WHERE i.order_id = p_order));

  -- ── the status it had, and its dates ──
  _st := _c.status_at;
  IF p_case = 'second_sale' THEN
    SELECT * INTO _p0 FROM public.mex_parcels WHERE tracking_id = _c.prior_parcel;
    _has_p0 := FOUND;
    IF NOT _has_p0 THEN
      RAISE EXCEPTION 'late_sale_release: the earlier parcel % of % is gone', _c.prior_parcel, p_order;
    END IF;
    _st := CASE _p0.status_id WHEN 2 THEN 'paid' WHEN 7 THEN 'returned' WHEN 8 THEN 'confirmed' ELSE 'shipped' END;
    _ship  := CASE WHEN _st = 'confirmed' THEN NULL ELSE coalesce(_p0.created_at_mex, _o.shipped_at) END;
    _paid  := CASE WHEN _st = 'paid' THEN coalesce(_p0.delivered_at, _p0.last_update_at, _ship) END;
    _ret   := CASE WHEN _st = 'returned' THEN coalesce(_p0.returned_at, _p0.last_update_at, _ship) END;
    _basis := CASE WHEN _st = 'paid' THEN 'mex' END;
  ELSIF _st IN ('cancelled', 'trashed') THEN
    SELECT h.changed_by_name INTO _who FROM public.order_history h
     WHERE h.order_id = p_order AND h.to_status::text = _st AND h.changed_at <= _c.arrival_at
     ORDER BY h.changed_at DESC, h.id DESC LIMIT 1;
    _what := format('collabBox %s document %s', coalesce(_c.doc_type_id, '?'), p_tracking);
    IF _st = 'cancelled' THEN
      IF _who ILIKE 'System (no-parcel%' THEN
        _creason := 'no_parcel_7d';
      ELSIF _who ILIKE 'System (collab-entry%' OR _who ILIKE '%not_in_collab%' THEN
        _creason := 'other'; _cnote := 'Нема внесено порачка во Collab';
      ELSE
        _creason := 'other';
        _cnote := format('restored %s: its cancel was wiped when MEX parcel %s was attached %s days after it — the parcel / %s is a NEW order (owner 03.10.2026: a late sale is a new order)',
                         _day, p_tracking, _c.gap_days, _what);
      END IF;
    ELSE
      _tnote := format('original trash reason was wiped when MEX parcel %s was attached %s days after it; restored as not_reachable (21-day park, owner 27.09) — the parcel / %s is a NEW order (owner 03.10.2026)',
                       p_tracking, _c.gap_days, _what);
    END IF;
  ELSE                                                -- 'stale': a sale whose own parcel never came
    _paid  := CASE WHEN _st = 'paid' THEN coalesce(CASE WHEN _o.status::text = 'paid' THEN _o.paid_at END, _o.confirmed_at, _o.created_at) END;
    _ret   := CASE WHEN _st = 'returned' THEN _o.returned_at END;
    _ship  := CASE WHEN _st IN ('shipped', 'delivered', 'paid', 'returned') THEN _o.shipped_at END;
    -- an AlterCPA "paid" with no parcel of its own is unproven (owner: MEX alone proves paid); a history import's stays legacy
    _basis := CASE WHEN _st = 'paid' THEN CASE WHEN _o.paid_basis IS NOT NULL AND _o.paid_basis <> 'mex' THEN _o.paid_basis
                                               WHEN _o.sale_source = 'altercpa' THEN 'unproven' ELSE 'legacy_import' END END;
  END IF;

  -- ── the cod-price repair's price, when it priced THIS order from THIS parcel and still stands ──
  SELECT x.id, x.before INTO _cp_id, _cp_bef
    FROM public.data_repair_rows x JOIN public.data_repair_runs r ON r.id = x.run_id
   WHERE r.key = 'cod-price' AND x.order_id = p_order AND x.after IS NOT NULL
     AND x.before ->> 'mex_tracking_id' = p_tracking
     AND (x.after ->> 'price') ~ '^[0-9]+(.[0-9]+)?$' AND (x.after ->> 'price')::numeric = _o.price   -- still the repair's price
     AND (x.before ->> 'price') ~ '^[0-9]+(.[0-9]+)?$'
   ORDER BY x.id DESC LIMIT 1;

  -- ── the sale time sale_day_revive moved (its move is closed here) ──
  SELECT array_agg(m.id ORDER BY m.id), (array_agg(m.old_sold_at ORDER BY m.id))[1]
    INTO _rv_ids, _rv_old
    FROM public.sale_day_revive_moves m
   WHERE m.order_id = p_order AND m.applied AND m.undone_at IS NULL AND m.parcel = p_tracking;

  -- ── this document's author stamped on it by the credit: the sale is the new order's ──
  IF _has_d THEN
    SELECT i.ext INTO _ext FROM public.collabbox_author_identity(_d.author) i;
  END IF;
  -- never for a second sale: the old order is still a sale (its own earlier parcel) and keeps its seller
  _clear := p_case <> 'second_sale' AND _o.sold_via = 'collabbox' AND _ext IS NOT NULL AND _o.sold_by_ext IS NOT DISTINCT FROM _ext
            AND _o.external_source IS DISTINCT FROM 'collabbox'
            AND coalesce(_o.sale_source_detail, '') NOT IN ('collabbox_leads', 'collabbox_leads_out', 'collabbox_leads_late')
            AND NOT EXISTS (SELECT 1 FROM public.collabbox_documents x
                             WHERE x.related_order_id = p_order AND x.doc_number <> p_tracking
                               AND x.credit IN ('stamped', 'stamped_no_person', 'person_filled'));

  INSERT INTO public.late_sale_moves (sync_run_id, scope, order_id, display_id, tracking, doc_number, doc_type_id, kase,
                                      status_at, arrival_at, dead_at, sale_at, gap_days, prior_parcel, before, doc_before,
                                      revive_moves, dept_before, value_mkd)
  SELECT p_run, coalesce(p_scope, 'writer'), p_order, _o.display_id, p_tracking, _c.doc_number, _c.doc_type_id, p_case,
         _c.status_at, _c.arrival_at, _c.dead_at, _c.sale_at, _c.gap_days, _c.prior_parcel, _before,
         CASE WHEN _has_d THEN to_jsonb(_d) - 'payload' END, _rv_ids,
         public.cohort_order_source(_o.sale_source, _o.sale_source_detail, _o.mex_tracking_id, _o.dept_override),
         coalesce(nullif((SELECT m.cod_mkd FROM public.mex_parcels m WHERE m.tracking_id = p_tracking), 0)::numeric,
                  round(coalesce(_o.price, 0) * 61.5))
  RETURNING id INTO _id;

  _prev_as := current_setting('elyon.allow_sold_change', true);
  _prev_ku := current_setting('elyon.keep_updated_at', true);
  PERFORM set_config('elyon.allow_sold_change', 'on', true);
  PERFORM set_config('elyon.keep_updated_at', 'on', true);

  -- the register first: this parcel is free for the new order
  UPDATE public.mex_parcels SET order_id = NULL, link_method = NULL, linked_at = NULL
   WHERE tracking_id = p_tracking AND order_id = p_order;

  UPDATE public.orders o
     SET status                    = _st::public.order_status,
         -- a cancel / trash the parcel never wiped (the order is still dead) keeps its own reason and time
         cancelled_at              = CASE WHEN _st = 'cancelled' THEN coalesce(o.cancelled_at, _c.dead_at) END,
         cancellation_reason       = CASE WHEN _st = 'cancelled' THEN coalesce(o.cancellation_reason, _creason) END,
         cancellation_reason_notes = CASE WHEN _st = 'cancelled' THEN CASE WHEN o.cancellation_reason IS NOT NULL
                                                                           THEN o.cancellation_reason_notes ELSE _cnote END END,
         trashed_at                = CASE WHEN _st = 'trashed' THEN coalesce(o.trashed_at, _c.dead_at) END,
         trash_reason              = CASE WHEN _st = 'trashed' THEN coalesce(o.trash_reason, 'not_reachable') END,
         trash_reason_notes        = CASE WHEN _st = 'trashed' THEN CASE WHEN o.trash_reason IS NOT NULL
                                                                         THEN o.trash_reason_notes ELSE _tnote END END,
         paid_at                   = _paid,
         returned_at               = _ret,
         shipped_at                = _ship,
         paid_basis                = _basis,
         mex_tracking_id           = CASE WHEN _has_p0 THEN _p0.tracking_id END,
         mex_account               = CASE WHEN _has_p0 THEN _p0.account END,
         mex_status_id             = CASE WHEN _has_p0 THEN _p0.status_id END,
         mex_cod_mkd               = CASE WHEN _has_p0 THEN _p0.cod_mkd END,
         mex_delivered_at          = CASE WHEN _has_p0 THEN _p0.delivered_at END,
         mex_returned_at           = CASE WHEN _has_p0 THEN _p0.returned_at END,
         mex_last_update_at        = CASE WHEN _has_p0 THEN _p0.last_update_at END,
         mex_sent_at               = CASE WHEN _has_p0 THEN _p0.created_at_mex END,
         price                     = CASE WHEN _cp_id IS NOT NULL THEN (_cp_bef ->> 'price')::numeric ELSE o.price END,
         quantity                  = CASE WHEN _cp_id IS NOT NULL AND (_cp_bef ->> 'quantity') ~ '^[0-9]+$'
                                          THEN (_cp_bef ->> 'quantity')::integer ELSE o.quantity END,
         sold_at                   = CASE WHEN _clear THEN NULL WHEN _rv_old IS NOT NULL THEN _rv_old ELSE o.sold_at END,
         sold_via                  = CASE WHEN _clear THEN NULL ELSE o.sold_via END,
         sold_by_ext               = CASE WHEN _clear THEN NULL ELSE o.sold_by_ext END,
         sold_by_person_id         = CASE WHEN _clear THEN NULL ELSE o.sold_by_person_id END
   WHERE o.id = p_order;

  IF _cp_id IS NOT NULL AND jsonb_typeof(_cp_bef -> 'items') = 'array' THEN
    UPDATE public.order_items i
       SET quantity = (x ->> 'quantity')::integer, total_price = (x ->> 'total_price')::numeric,
           price_per_unit = (x ->> 'price_per_unit')::numeric
      FROM jsonb_array_elements(_cp_bef -> 'items') x
     WHERE i.order_id = p_order AND i.id = (x ->> 'id')::uuid;
  END IF;

  IF _rv_ids IS NOT NULL THEN
    UPDATE public.sale_day_revive_moves m SET undone_at = clock_timestamp() WHERE m.id = ANY (_rv_ids);
  END IF;

  IF _o.status::text IS DISTINCT FROM _st THEN
    INSERT INTO public.order_history (order_id, from_status, to_status, changed_by, changed_by_name)
    VALUES (p_order, _o.status, _st::public.order_status, NULL, c_actor);
  END IF;

  UPDATE public.late_sale_moves l
     SET after = (SELECT to_jsonb(x) FROM public.orders x WHERE x.id = p_order)
   WHERE l.id = _id;

  PERFORM set_config('elyon.allow_sold_change', coalesce(_prev_as, ''), true);
  PERFORM set_config('elyon.keep_updated_at', coalesce(_prev_ku, ''), true);
  RETURN _id;
END
$fn$;
REVOKE ALL ON FUNCTION public.late_sale_release(uuid, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.late_sale_release(uuid, uuid, text, text, text) TO service_role;

-- ── 6. After the writer made the new order: the ledger names it, both orders get a note ──
CREATE OR REPLACE FUNCTION public.late_sale_attach_new(p_move bigint, p_new uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _m   public.late_sale_moves%ROWTYPE;
  _n   record;
  _old text;
  _why text;
BEGIN
  SELECT * INTO _m FROM public.late_sale_moves WHERE id = p_move;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'late_sale_attach_new: no move %', p_move;
  END IF;
  SELECT o.display_id, o.sold_by_ext,
         public.cohort_order_source(o.sale_source, o.sale_source_detail, o.mex_tracking_id, o.dept_override) AS dept,
         to_char(o.sold_at AT TIME ZONE 'Europe/Skopje', 'DD.MM.YYYY') AS day
    INTO _n FROM public.orders o WHERE o.id = p_new;
  UPDATE public.late_sale_moves SET new_order_id = p_new, new_display_id = _n.display_id, dept_after = _n.dept WHERE id = p_move;
  SELECT o.display_id INTO _old FROM public.orders o WHERE o.id = _m.order_id;
  _why := CASE _m.kase
            WHEN 'dead_late'   THEN format('%s days after this order was %s', _m.gap_days, _m.status_at)
            WHEN 'stale'       THEN format('%s days after this order''s own sale, which never shipped', _m.gap_days)
            ELSE format('after this order had already shipped its own parcel %s', _m.prior_parcel) END;
  INSERT INTO public.order_notes (order_id, text, author_id, author_name)
  VALUES (_m.order_id,
          format('Late sale (owner 03.10.2026): MEX parcel %s / collabBox %s document arrived %s — it is a NEW order %s (%s, %s), credited to its author. This order is back as it was before the parcel: %s.',
                 _m.tracking, coalesce(_m.doc_type_id, '?'), _why, _n.display_id, _n.day, coalesce(_n.sold_by_ext, 'no author'),
                 (SELECT o.status::text FROM public.orders o WHERE o.id = _m.order_id)),
          NULL, 'System (late-sale:new-order)'),
         (p_new,
          format('Late sale (owner 03.10.2026): made from collabBox %s document %s, whose parcel had been attached to %s (%s). A sale that arrives more than 10 days after a cancel / trash, or after the order''s own sale, is a new order on the booking day; the seller''s team decides the department.',
                 coalesce(_m.doc_type_id, '?'), _m.tracking, _old, _why),
          NULL, 'System (late-sale:new-order)');
END
$fn$;
REVOKE ALL ON FUNCTION public.late_sale_attach_new(bigint, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.late_sale_attach_new(bigint, uuid) TO service_role;

-- ── 7. The plan (history repair, checker): every case-3 order holding a parcel ──
CREATE OR REPLACE FUNCTION public.late_sale_plan(p_since timestamptz DEFAULT '2026-01-01 00:00:00+01', p_order uuid DEFAULT NULL)
RETURNS TABLE (
  order_id uuid, display_id text, kase text, status_now text, status_at text, arrival_at timestamptz,
  dead_at timestamptz, sale_at timestamptz, gap_days numeric, prior_parcel text, tracking text,
  doc_number text, doc_type_id text, doc_role text, doc_outcome text, doc_author text, author_person_id uuid,
  doc_sale_at timestamptz, value_mkd numeric, parcel_status_id integer, sale_source text, sale_source_detail text,
  sold_at timestamptz, sold_via text, dept_before text, dept_after text, in_payout boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  WITH h AS MATERIALIZED (   -- orders holding a parcel that could be case 3 (a cheap necessary condition first)
    SELECT o.id, o.mex_tracking_id AS trk
    FROM public.orders o
    JOIN public.mex_parcels p ON p.tracking_id = o.mex_tracking_id
    LEFT JOIN public.collabbox_documents d ON d.doc_number = o.mex_tracking_id
    WHERE o.status::text <> 'duplicated'
      AND o.external_order_id IS DISTINCT FROM o.mex_tracking_id
      AND (p_order IS NULL OR o.id = p_order)
      AND (least(public.collabbox_sale_at(d.doc_at, d.booked_at), d.booked_at, p.created_at_mex)
             - least(o.created_at, o.confirmed_at, o.sold_at) > interval '10 days'
           OR EXISTS (SELECT 1 FROM public.mex_parcels m WHERE m.order_id = o.id AND m.tracking_id <> o.mex_tracking_id))
  ),
  k AS MATERIALIZED (       -- THE classification, once per candidate
    SELECT h.id, h.trk, c.*
    FROM h CROSS JOIN LATERAL public.late_sale_classify(h.id, h.trk) c
  ),
  l AS MATERIALIZED (       -- case 3 only
    SELECT k.* FROM k WHERE k.kase IN ('dead_late', 'stale', 'second_sale') AND k.arrival_at >= p_since
  ),
  x AS MATERIALIZED (
    SELECT l.*, o.display_id, o.status::text AS status_now, o.price, o.sale_source AS o_src, o.sale_source_detail AS o_det,
           o.sold_at AS o_sold_at, o.sold_via AS o_sold_via, o.mex_tracking_id AS o_trk, o.dept_override,
           p.cod_mkd, p.status_id AS p_status,
           d.doc_number AS d_doc, d.doc_type_id AS d_type, d.role AS d_role, d.outcome AS d_outcome, d.author AS d_author,
           coalesce((SELECT i.person_id FROM public.collabbox_author_identity(d.author) i), d.author_person_id) AS d_person,
           public.collabbox_sale_at(d.doc_at, least(coalesce(d.booked_at, d.doc_at), d.doc_at)) AS d_sale_at
    FROM l
    JOIN public.orders o ON o.id = l.id
    JOIN public.mex_parcels p ON p.tracking_id = l.trk
    LEFT JOIN LATERAL (
      SELECT y.* FROM public.collabbox_documents y
       WHERE y.doc_number = l.trk AND public.collabbox_doc_role(y.doc_type_id) <> 'record'
         AND NOT coalesce(y.is_storno, false) AND y.vanished_at IS NULL
    ) d ON true
  )
  SELECT x.id, x.display_id, x.kase, x.status_now, x.status_at, x.arrival_at, x.dead_at, x.sale_at, x.gap_days,
         x.prior_parcel, x.trk, x.d_doc, x.d_type, x.d_role, x.d_outcome, x.d_author, x.d_person, x.d_sale_at,
         coalesce(nullif(x.cod_mkd, 0)::numeric, round(coalesce(x.price, 0) * 61.5)),
         x.p_status, x.o_src, x.o_det, x.o_sold_at, x.o_sold_via,
         public.cohort_order_source(x.o_src, x.o_det, x.o_trk, x.dept_override),
         CASE WHEN x.d_doc IS NOT NULL THEN
           coalesce(public.order_dept_by_team(nd.src, x.d_person, x.d_sale_at), public.cohort_order_source(nd.src, nd.det, x.trk)) END,
         EXISTS (SELECT 1 FROM public.agent_payout_items ap WHERE ap.order_id = x.id)
  FROM x
  LEFT JOIN LATERAL (
    SELECT CASE WHEN x.d_type = '10111' THEN 'elyon_crm' ELSE (public.collabbox_department(x.d_type, x.d_doc, NULL, NULL))[1] END AS src,
           CASE WHEN x.d_type = '10111' THEN 'collabbox_leads_late' ELSE (public.collabbox_department(x.d_type, x.d_doc, NULL, NULL))[2] END AS det
  ) nd ON true;
$fn$;
REVOKE ALL ON FUNCTION public.late_sale_plan(timestamptz, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.late_sale_plan(timestamptz, uuid) TO service_role, supabase_read_only_user;

-- ── 8. The undo — per collabBox run (the repair's, or a writer pass), or one move ──
-- Per move, only when both orders are still as the split left them: the new order is deleted (its
-- items / notes / history go with it), the document's ledger row goes back, the old order gets every
-- column of `before` back that the release wrote, its register row its old link, the closed
-- sale_day_revive moves are reopened.
CREATE OR REPLACE FUNCTION public.late_sale_undo(p_run uuid, p_actor text DEFAULT NULL, p_move bigint DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  m        public.late_sale_moves%ROWTYPE;
  n        public.orders%ROWTYPE;
  b        jsonb;
  r        jsonb;
  _ok      integer := 0;
  _skipped jsonb := '[]'::jsonb;
  _prev_as text;
  _prev_ku text;
  _prev_br text;
BEGIN
  IF p_run IS NULL AND p_move IS NULL THEN
    RAISE EXCEPTION 'late_sale_undo: a run or a move';
  END IF;
  _prev_as := current_setting('elyon.allow_sold_change', true);
  _prev_ku := current_setting('elyon.keep_updated_at', true);
  _prev_br := current_setting('elyon.bulk_repair', true);
  PERFORM set_config('elyon.allow_sold_change', 'on', true);
  PERFORM set_config('elyon.keep_updated_at', 'on', true);
  PERFORM set_config('elyon.bulk_repair', 'on', true);

  FOR m IN SELECT * FROM public.late_sale_moves l
            WHERE l.undone_at IS NULL AND l.new_order_id IS NOT NULL
              AND (p_run IS NULL OR l.sync_run_id = p_run) AND (p_move IS NULL OR l.id = p_move)
            ORDER BY l.id DESC LOOP
    BEGIN
      b := m.before;
      -- the old order: still as released?
      IF NOT EXISTS (SELECT 1 FROM public.orders o WHERE o.id = m.order_id
                       AND o.status::text = m.after ->> 'status'
                       AND o.mex_tracking_id IS NOT DISTINCT FROM m.after ->> 'mex_tracking_id'
                       AND o.sold_at IS NOT DISTINCT FROM (m.after ->> 'sold_at')::timestamptz) THEN
        _skipped := _skipped || jsonb_build_object('move', m.id, 'order', m.display_id, 'why', 'the old order changed since the split');
        CONTINUE;
      END IF;
      SELECT * INTO n FROM public.orders WHERE id = m.new_order_id FOR UPDATE;
      IF n.id IS NULL OR n.external_source IS DISTINCT FROM 'collabbox' OR n.external_order_id IS DISTINCT FROM m.tracking
         OR n.mex_tracking_id IS DISTINCT FROM m.tracking
         OR EXISTS (SELECT 1 FROM public.agent_payout_items ap WHERE ap.order_id = n.id)
         OR EXISTS (SELECT 1 FROM public.order_history h WHERE h.order_id = n.id AND h.changed_by IS NOT NULL)
         OR EXISTS (SELECT 1 FROM public.orders dd WHERE dd.duplicated_from = n.id) THEN
        _skipped := _skipped || jsonb_build_object('move', m.id, 'order', m.display_id, 'why', 'the new order changed since the split');
        CONTINUE;
      END IF;
      DELETE FROM public.orders WHERE id = n.id;
      IF m.doc_before IS NOT NULL THEN
        UPDATE public.collabbox_documents d
           SET outcome = m.doc_before ->> 'outcome', reason = m.doc_before ->> 'reason',
               order_id = nullif(m.doc_before ->> 'order_id', '')::uuid,
               related_order_id = nullif(m.doc_before ->> 'related_order_id', '')::uuid,
               credit = m.doc_before ->> 'credit',
               flags = coalesce(array(SELECT jsonb_array_elements_text(m.doc_before -> 'flags')), '{}'::text[]),
               planned_status = m.doc_before ->> 'planned_status', paid_basis = m.doc_before ->> 'paid_basis',
               price_eur = (m.doc_before ->> 'price_eur')::numeric,
               created_by_sync = coalesce((m.doc_before ->> 'created_by_sync')::boolean, false),
               created_run_id = nullif(m.doc_before ->> 'created_run_id', '')::uuid, updated_at = now()
         WHERE d.doc_number = m.tracking;
      END IF;
      -- status first (the NULL-only timestamp triggers), then the columns
      UPDATE public.orders o SET status = (b ->> 'status')::public.order_status
       WHERE o.id = m.order_id AND o.status::text IS DISTINCT FROM b ->> 'status';
      UPDATE public.orders o
         SET cancelled_at = (b ->> 'cancelled_at')::timestamptz, cancellation_reason = b ->> 'cancellation_reason',
             cancellation_reason_notes = b ->> 'cancellation_reason_notes', trashed_at = (b ->> 'trashed_at')::timestamptz,
             trash_reason = b ->> 'trash_reason', trash_reason_notes = b ->> 'trash_reason_notes',
             paid_at = (b ->> 'paid_at')::timestamptz, returned_at = (b ->> 'returned_at')::timestamptz,
             shipped_at = (b ->> 'shipped_at')::timestamptz, paid_basis = b ->> 'paid_basis',
             mex_tracking_id = b ->> 'mex_tracking_id', mex_account = b ->> 'mex_account',
             mex_status_id = (b ->> 'mex_status_id')::integer, mex_cod_mkd = (b ->> 'mex_cod_mkd')::integer,
             mex_delivered_at = (b ->> 'mex_delivered_at')::timestamptz, mex_returned_at = (b ->> 'mex_returned_at')::timestamptz,
             mex_last_update_at = (b ->> 'mex_last_update_at')::timestamptz, mex_sent_at = (b ->> 'mex_sent_at')::timestamptz,
             price = (b ->> 'price')::numeric, quantity = (b ->> 'quantity')::integer,
             sold_at = (b ->> 'sold_at')::timestamptz, sold_via = b ->> 'sold_via', sold_by_ext = b ->> 'sold_by_ext',
             sold_by_person_id = (b ->> 'sold_by_person_id')::uuid
       WHERE o.id = m.order_id;
      FOR r IN SELECT x FROM jsonb_array_elements(coalesce(b -> '_items', '[]'::jsonb)) x LOOP
        UPDATE public.order_items i
           SET quantity = (r ->> 'quantity')::integer, total_price = (r ->> 'total_price')::numeric,
               price_per_unit = (r ->> 'price_per_unit')::numeric
         WHERE i.id = (r ->> 'id')::uuid AND i.order_id = m.order_id;
      END LOOP;
      FOR r IN SELECT x FROM jsonb_array_elements(coalesce(b -> '_register', '[]'::jsonb)) x LOOP
        UPDATE public.mex_parcels mp
           SET order_id = nullif(r ->> 'order_id', '')::uuid, link_method = r ->> 'link_method',
               linked_at = (r ->> 'linked_at')::timestamptz
         WHERE mp.tracking_id = r ->> 'tracking_id';
      END LOOP;
      IF m.revive_moves IS NOT NULL THEN
        UPDATE public.sale_day_revive_moves x SET undone_at = NULL WHERE x.id = ANY (m.revive_moves);
      END IF;
      INSERT INTO public.order_history (order_id, from_status, to_status, changed_by, changed_by_name)
      SELECT m.order_id, (m.after ->> 'status')::public.order_status, (b ->> 'status')::public.order_status, NULL,
             'System (rollback:late-sale)'
       WHERE m.after ->> 'status' IS DISTINCT FROM b ->> 'status';
      INSERT INTO public.order_notes (order_id, text, author_id, author_name)
      VALUES (m.order_id, format('Rollback of the late-sale split (move %s): this order holds MEX parcel %s again; the order %s made from the document was removed.',
                                 m.id, m.tracking, m.new_display_id), NULL, 'System (rollback:late-sale)');
      UPDATE public.late_sale_moves SET undone_at = clock_timestamp(), undone_by = p_actor WHERE id = m.id;
      _ok := _ok + 1;
    EXCEPTION WHEN OTHERS THEN
      _skipped := _skipped || jsonb_build_object('move', m.id, 'order', m.display_id, 'why', left(SQLERRM, 300));
    END;
  END LOOP;

  PERFORM set_config('elyon.allow_sold_change', coalesce(_prev_as, ''), true);
  PERFORM set_config('elyon.keep_updated_at', coalesce(_prev_ku, ''), true);
  PERFORM set_config('elyon.bulk_repair', coalesce(_prev_br, ''), true);
  RETURN jsonb_build_object('ok', true, 'run', p_run, 'move', p_move, 'restored', _ok, 'skipped', _skipped);
END
$fn$;
REVOKE ALL ON FUNCTION public.late_sale_undo(uuid, text, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.late_sale_undo(uuid, text, bigint) TO service_role;

-- ── 9. collabbox_credit_order: never stamps a case-3 holder once the rule is on ──
-- Live definition of 20260947001800, re-emitted unchanged except the late-sale check before the stamp.
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
  -- 20260947002000 (owner 03.10.2026): a LATE document is a new order, never this order's credit
  IF coalesce((SELECT s.value ->> 'mode' FROM public.app_settings s WHERE s.key = 'late_sale_new_order'), 'off') = 'apply'
     AND _o.mex_tracking_id IS NOT DISTINCT FROM p_doc
     AND public.late_sale_case_of(p_order, p_doc) IN ('dead_late', 'stale', 'second_sale') THEN
    RETURN 'late_sale';
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

-- ── 10. sale_day_revive_plan: a case-3 order is never re-timed (it becomes a new order) ──
-- Live definition of 20260947001800, re-emitted: the 'stale' basis is gone (a stale approval is case 3)
-- and a 'dead' / 'unsold' order moves only when late_sale_classify says case 1 / 2.
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
  WITH e AS (            -- a sale now, stamped, holding a parcel; its reviving evidence
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
    SELECT a.*, public.order_status_at(a.id, a.arr_at) AS st_arr
    FROM a
  ),
  b AS (
    SELECT s.*,
           CASE WHEN s.st_arr IN ('cancelled', 'trashed') THEN 'dead'
                WHEN s.st_arr IN ('pending', 'take', 'call_again') THEN 'unsold'
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
    AND b.sold_at < b.arr_at
    -- 20260947002000: case 1 / 2 only — a late document / parcel is a NEW order, never a revive
    AND public.late_sale_case_of(b.id, b.mex_tracking_id) IN ('open', 'dead_recent');
$fn$;
REVOKE ALL ON FUNCTION public.sale_day_revive_plan(timestamptz, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sale_day_revive_plan(timestamptz, uuid) TO service_role, supabase_read_only_user;

COMMIT;
