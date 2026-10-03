-- 20260947002030 — late_sale_release: an UNPROVEN courier status is not restored (20260947002000 follow-up)
--
-- The history dry run (03.10.2026 ~04:30) found 233 'stale' old orders — AlterCPA history imports / mirrors — whose
-- status at the late parcel's arrival was "paid" / "shipped" / "returned" with NO MEX parcel of their own. Restored
-- literally, the cohort would count each again as paid_unproven on its old day (cohort_order_bucket) while the late
-- parcel's money counts on the new order: one purchase twice. MEX alone proves paid / shipped / returned; AlterCPA
-- decides only confirmed-or-dead (CLAUDE.md). So such an order is cancelled by the SYSTEM (reason other + a note),
-- dated by its own sale moment — exactly what repair-folder-decides did for the same shape (owner 01.10.2026, "never
-- cancelled → cancelled by the system"). An approval ('confirmed' at the arrival) is still restored as 'confirmed'
-- (the no-parcel / collabBox-entry rules act on it), a cancel / trash as before. Also: a cancel / trash keeps its own
-- reason / time only while the order is STILL that status (a revived row's reason fields are the wiped ones).
-- The undo (late_sale_undo) restores the full before-image, unchanged.

BEGIN;

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
  _cat      timestamptz;                -- the cancel / trash moment the order gets back
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
    _cat := _c.dead_at;
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
  ELSIF _st IN ('paid', 'delivered', 'shipped', 'returned') THEN
    -- 'stale' with a courier status that no parcel of its own ever proved (an AlterCPA / import "paid", a mirrored
    -- "shipped"): MEX alone proves paid / shipped / returned, AlterCPA only confirmed-or-dead (CLAUDE.md). Restored
    -- literally it would count again as paid_unproven on its old day while its late parcel counts on the new order —
    -- the same purchase twice. So, as the folder-decides repair did for the same shape (owner 01.10.2026), it is
    -- cancelled by the SYSTEM (reason other + note), dated by its own sale moment — never a person's cancel.
    _what := format('collabBox %s document %s', coalesce(_c.doc_type_id, '?'), p_tracking);
    _creason := 'other';
    _cnote := format('cancelled %s by the system: its "%s" never had a MEX parcel of its own (MEX alone proves it); MEX parcel %s came %s days after its sale and is a NEW order — the parcel / %s (owner 03.10.2026: a late sale is a new order)',
                     _day, _st, p_tracking, _c.gap_days, _what);
    _st  := 'cancelled';
    _cat := _c.sale_at;
  ELSE                                                -- 'stale': an approval whose own parcel never came
    _paid  := NULL;
    _ret   := NULL;
    _ship  := NULL;
    -- an AlterCPA "paid" with no parcel of its own is unproven (owner: MEX alone proves paid); a history import's stays legacy
    _basis := CASE WHEN _st = 'paid' THEN CASE WHEN _o.paid_basis IS NOT NULL AND _o.paid_basis <> 'mex' THEN _o.paid_basis
                                               WHEN _o.sale_source = 'altercpa' THEN 'unproven' ELSE 'legacy_import' END END;
  END IF;

  -- ── the cod-price repair's price, when it priced THIS order from THIS parcel and still stands ──
  SELECT x.id, x.before INTO _cp_id, _cp_bef
    FROM public.data_repair_rows x JOIN public.data_repair_runs r ON r.id = x.run_id
   WHERE r.key = 'cod-price' AND x.order_id = p_order AND x.after IS NOT NULL
     AND x.before ->> 'mex_tracking_id' = p_tracking
     AND (x.after ->> 'price') ~ '^[0-9]+([.][0-9]+)?$' AND (x.after ->> 'price')::numeric = _o.price   -- still the repair's price
     AND (x.before ->> 'price') ~ '^[0-9]+([.][0-9]+)?$'
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
         cancelled_at              = CASE WHEN _st = 'cancelled' THEN coalesce(CASE WHEN o.status::text = 'cancelled' THEN o.cancelled_at END, _cat) END,
         -- a cancel / trash the parcel never wiped (the order is still dead) keeps its own reason and time
         cancellation_reason       = CASE WHEN _st = 'cancelled' THEN CASE WHEN o.status::text = 'cancelled' AND o.cancellation_reason IS NOT NULL
                                                                           THEN o.cancellation_reason ELSE _creason END END,
         cancellation_reason_notes = CASE WHEN _st = 'cancelled' THEN CASE WHEN o.status::text = 'cancelled' AND o.cancellation_reason IS NOT NULL
                                                                           THEN o.cancellation_reason_notes ELSE _cnote END END,
         trashed_at                = CASE WHEN _st = 'trashed' THEN coalesce(CASE WHEN o.status::text = 'trashed' THEN o.trashed_at END, _cat) END,
         trash_reason              = CASE WHEN _st = 'trashed' THEN CASE WHEN o.status::text = 'trashed' AND o.trash_reason IS NOT NULL
                                                                         THEN o.trash_reason ELSE 'not_reachable' END END,
         trash_reason_notes        = CASE WHEN _st = 'trashed' THEN CASE WHEN o.status::text = 'trashed' AND o.trash_reason IS NOT NULL
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

COMMIT;
