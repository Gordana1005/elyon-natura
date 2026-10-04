-- 20260948000310 — late_sale_relink: a holder that NAMES the parcel while the register row is unlinked (04.10.2026)
--
-- The probe of 20260948000300 (six units inside a rolled-back transaction) found three case-3 holders whose order
-- names the late parcel (orders.mex_tracking_id) while mex_parcels.order_id is NULL — ORD-48624, ORD-50072,
-- ORD-51069. late_sale_release() only asks that the order names the parcel; the relink asked for the register row
-- too and refused them. Now: the register row must be the holder's OR unlinked (another order's → refused, as
-- before), and the order must name the parcel. Nothing else changes — the function is re-emitted whole.

BEGIN;

SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE FUNCTION public.late_sale_relink(p_sync_run uuid, p_holder uuid, p_tracking text, p_lead uuid, p_case text,
                                                   p_expect_status text DEFAULT NULL, p_kind text DEFAULT 'phone_date')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  c_actor  CONSTANT text := 'System (late-sale:relink)';
  _l       public.orders%ROWTYPE;          -- the lead
  _h       record;                         -- the holder
  _p       public.mex_parcels%ROWTYPE;
  _d       public.collabbox_documents%ROWTYPE;
  _move    bigint;
  _target  text;
  _before  jsonb;
  _res     text;
  _kase    text;
  _e       jsonb;
  _w       jsonb;
  _say     text;
  _prev_as text;
  _prev_ku text;
  _prev_br text;
BEGIN
  IF p_sync_run IS NULL OR p_holder IS NULL OR p_lead IS NULL OR p_tracking IS NULL OR p_holder = p_lead THEN
    RAISE EXCEPTION 'late_sale_relink: a run, a holder, a tracking id and a different lead are required';
  END IF;
  SELECT o.id, o.display_id, o.customer_phone, o.created_at INTO _h FROM public.orders o WHERE o.id = p_holder FOR UPDATE;
  SELECT * INTO _l FROM public.orders WHERE id = p_lead FOR UPDATE;
  IF _h.id IS NULL OR _l.id IS NULL THEN
    RAISE EXCEPTION 'late_sale_relink: holder % or lead % is gone', p_holder, p_lead;
  END IF;
  IF right(regexp_replace(coalesce(_l.customer_phone, ''), '[^0-9]', '', 'g'), 8)
     IS DISTINCT FROM right(regexp_replace(coalesce(_h.customer_phone, ''), '[^0-9]', '', 'g'), 8) THEN
    RAISE EXCEPTION 'late_sale_relink: lead % and holder % are not the same customer (last 8 digits)', _l.display_id, _h.display_id;
  END IF;
  IF _l.mex_tracking_id IS NOT NULL THEN
    RAISE EXCEPTION 'late_sale_relink: lead % already holds parcel %', _l.display_id, _l.mex_tracking_id;
  END IF;
  IF p_expect_status IS NOT NULL AND _l.status::text IS DISTINCT FROM p_expect_status THEN
    RAISE EXCEPTION 'late_sale_relink: lead % is % now, % when it was planned', _l.display_id, _l.status, p_expect_status;
  END IF;
  IF _l.status::text NOT IN ('pending', 'call_again', 'confirmed', 'paid', 'shipped', 'returned', 'cancelled', 'trashed') THEN
    RAISE EXCEPTION 'late_sale_relink: lead % is % — not a candidate status', _l.display_id, _l.status;
  END IF;
  IF EXISTS (SELECT 1 FROM public.agent_payout_items ap WHERE ap.order_id = p_lead) THEN
    RAISE EXCEPTION 'late_sale_relink: lead % is in agent_payout_items (payouts deferred by the owner)', _l.display_id;
  END IF;
  IF EXISTS (SELECT 1 FROM public.affiliate_leads al WHERE al.order_id = p_lead) THEN
    RAISE EXCEPTION 'late_sale_relink: lead % is an affiliate_leads order', _l.display_id;
  END IF;
  SELECT * INTO _p FROM public.mex_parcels WHERE tracking_id = p_tracking FOR UPDATE;
  -- the register row is the holder's, or unlinked while the holder names the parcel (three such holders, 04.10.2026);
  -- late_sale_release() itself only asks that the ORDER names it
  IF NOT FOUND OR (_p.order_id IS NOT NULL AND _p.order_id <> p_holder) THEN
    RAISE EXCEPTION 'late_sale_relink: parcel % is not held by % in the register', p_tracking, _h.display_id;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.orders o WHERE o.id = p_holder AND o.mex_tracking_id = p_tracking) THEN
    RAISE EXCEPTION 'late_sale_relink: order % does not name parcel %', _h.display_id, p_tracking;
  END IF;
  IF EXISTS (SELECT 1 FROM public.orders x WHERE x.mex_tracking_id = p_tracking AND x.id <> p_holder) THEN
    RAISE EXCEPTION 'late_sale_relink: parcel % is named by another order', p_tracking;
  END IF;

  _prev_as := current_setting('elyon.allow_sold_change', true);
  _prev_ku := current_setting('elyon.keep_updated_at', true);
  _prev_br := current_setting('elyon.bulk_repair', true);
  PERFORM set_config('elyon.allow_sold_change', 'on', true);
  PERFORM set_config('elyon.keep_updated_at', 'on', true);     -- /call-agains reads orders.updated_at as the last call
  PERFORM set_config('elyon.bulk_repair', 'on', true);         -- no paid / returned bells for a batch

  -- 1. the holder back to what it was; the parcel is free
  _move := public.late_sale_release(p_sync_run, p_holder, p_tracking, p_case, 'repair');

  -- 2. the lead takes it — the phone + date linker's own write (link_lead_parcels, 20260944000950)
  _before := to_jsonb(_l)
             || jsonb_build_object('_register',
                  (SELECT jsonb_agg(jsonb_build_object('tracking_id', m.tracking_id, 'order_id', m.order_id,
                                                      'link_method', m.link_method, 'linked_at', m.linked_at))
                     FROM public.mex_parcels m WHERE m.tracking_id = p_tracking OR m.order_id = p_lead));
  _target := CASE WHEN _p.status_id = 2 THEN CASE WHEN _l.status::text = 'paid'
                                                  THEN CASE WHEN _l.paid_basis = 'mex' THEN NULL ELSE 'basis' END
                                                  ELSE 'paid' END
                  WHEN _p.status_id = 7 THEN CASE WHEN _l.status::text = 'returned' THEN NULL ELSE 'returned' END
                  WHEN _p.status_id = 8 THEN NULL     -- label only (MEX 8 = за пакување): linked, the status waits for the pickup
                  ELSE CASE WHEN _l.status::text = 'shipped' THEN NULL ELSE 'shipped' END END;
  IF _target = 'paid' THEN
    UPDATE public.orders
       SET status = 'paid', paid_at = coalesce(_p.delivered_at, _p.last_update_at, _p.created_at_mex, now()),
           returned_at = NULL, paid_basis = 'mex',
           cancellation_reason = NULL, cancellation_reason_notes = NULL, cancelled_at = NULL,
           trash_reason = NULL, trash_reason_notes = NULL, trashed_at = NULL
     WHERE id = p_lead;
  ELSIF _target = 'returned' THEN
    UPDATE public.orders
       SET status = 'returned', returned_at = coalesce(_p.returned_at, _p.last_update_at, now()),
           paid_at = NULL, paid_basis = NULL,
           cancellation_reason = NULL, cancellation_reason_notes = NULL, cancelled_at = NULL,
           trash_reason = NULL, trash_reason_notes = NULL, trashed_at = NULL
     WHERE id = p_lead;
  ELSIF _target = 'shipped' THEN
    UPDATE public.orders
       SET status = 'shipped', shipped_at = coalesce(_p.created_at_mex, now()),
           paid_at = NULL, paid_basis = NULL,
           cancellation_reason = NULL, cancellation_reason_notes = NULL, cancelled_at = NULL,
           trash_reason = NULL, trash_reason_notes = NULL, trashed_at = NULL
     WHERE id = p_lead;
  ELSIF _target = 'basis' THEN
    UPDATE public.orders SET paid_basis = 'mex' WHERE id = p_lead;
  END IF;

  _res := public.mex_link_parcel(p_tracking, p_lead, 'repair', false);
  IF _res IS DISTINCT FROM 'linked' AND _res IS DISTINCT FROM 'already' THEN
    RAISE EXCEPTION 'late_sale_relink: mex_link_parcel % → %', p_tracking, coalesce(_res, 'null');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.orders o WHERE o.id = p_lead AND o.mex_tracking_id = p_tracking)
     OR EXISTS (SELECT 1 FROM public.orders x WHERE x.mex_tracking_id = p_tracking AND x.id <> p_lead) THEN
    RAISE EXCEPTION 'late_sale_relink: parcel % is not (only) on lead %', p_tracking, _l.display_id;
  END IF;
  IF _target IN ('paid', 'returned', 'shipped') THEN
    INSERT INTO public.order_history (order_id, from_status, to_status, changed_by, changed_by_name)
    VALUES (p_lead, _l.status, _target::public.order_status, NULL, c_actor);
  END IF;

  -- 3. the lead is never itself a late holder of this parcel
  _kase := public.late_sale_case_of(p_lead, p_tracking);
  IF _kase IN ('dead_late', 'stale', 'second_sale') THEN
    RAISE EXCEPTION 'late_sale_relink: lead % is itself % for parcel %', _l.display_id, _kase, p_tracking;
  END IF;

  -- 4. the document credits the order that holds its parcel now (the live writer, no force)
  SELECT * INTO _d FROM public.collabbox_documents WHERE doc_number = p_tracking;
  IF FOUND AND _d.payload IS NOT NULL AND public.collabbox_doc_role(_d.doc_type_id) <> 'record'
     AND NOT coalesce(_d.is_storno, false) AND _d.vanished_at IS NULL THEN
    _w := public.collabbox_apply_documents(p_sync_run, jsonb_build_array(_d.payload), false);
    _e := _w -> 'results' -> 0;
    IF _e IS NULL OR coalesce(_e ->> 'outcome', '') NOT IN ('credited', 'recorded')
       OR (_e ->> 'related_order_id') IS DISTINCT FROM p_lead::text THEN
      RAISE EXCEPTION 'late_sale_relink: the collabBox writer answered % / % (related %)',
        coalesce(_e ->> 'outcome', 'nothing'), coalesce(_e ->> 'reason', ''), coalesce(_e ->> 'related_order_id', 'none');
    END IF;
  END IF;

  -- 5. the words, the ledger
  _say := format('is the sale of lead %s of the same customer (the phone + date rule)', _l.display_id);
  UPDATE public.orders o
     SET cancellation_reason_notes = replace(replace(o.cancellation_reason_notes,
                                       'is a NEW order (owner 03.10.2026: a late sale is a new order)', _say),
                                       'is a NEW order (owner 03.10.2026)', _say),
         trash_reason_notes        = replace(replace(o.trash_reason_notes,
                                       'is a NEW order (owner 03.10.2026: a late sale is a new order)', _say),
                                       'is a NEW order (owner 03.10.2026)', _say)
   WHERE o.id = p_holder
     AND (o.cancellation_reason_notes LIKE '%' || p_tracking || '%is a NEW order%'
          OR o.trash_reason_notes LIKE '%' || p_tracking || '%is a NEW order%');

  INSERT INTO public.order_notes (order_id, text, author_id, author_name)
  VALUES (p_holder,
          format('Late parcel (owner 03.10.2026): MEX parcel %s / collabBox %s document does not belong to this order — it is the sale of lead %s of the same customer (created %s; the phone + date rule, owner 01.10.2026). The parcel moved to that lead; this order is back as it was before the parcel: %s.',
                 p_tracking, coalesce(_d.doc_type_id, '?'), _l.display_id,
                 to_char(_l.created_at AT TIME ZONE 'Europe/Skopje', 'DD.MM.YYYY HH24:MI'),
                 (SELECT o.status::text FROM public.orders o WHERE o.id = p_holder)),
          NULL, c_actor),
         (p_lead,
          format('MEX parcel %s (%s, %s, COD %s ден, created %s) is this lead''s own sale: the same customer by the last 8 digits, this lead created %s — the only order that fits the parcel by the phone + date rule (owner 01.10.2026), and it fits no other parcel. The parcel had been attached to the customer''s older order %s, which is back as it was. %s Nothing was sent to AlterCPA. Undo: late_sale_relink_undo (move %s).',
                 p_tracking, coalesce(_p.account, '?'), trim(coalesce(_p.status_id::text, '?') || ' ' || coalesce(_p.status_name, '')),
                 replace(to_char(_p.cod_mkd, 'FM999,999,990'), ',', '.'),
                 to_char(_p.created_at_mex AT TIME ZONE 'Europe/Skopje', 'DD.MM.YYYY HH24:MI'),
                 to_char(_l.created_at AT TIME ZONE 'Europe/Skopje', 'DD.MM.YYYY HH24:MI'),
                 _h.display_id,
                 CASE WHEN _target IN ('paid', 'returned', 'shipped') THEN format('The status follows MEX: %s → %s.', _l.status, _target)
                      WHEN _target = 'basis' THEN 'The order was already paid; MEX now proves it (paid basis mex).'
                      WHEN _p.status_id = 8 THEN 'The parcel is at MEX 8 (за пакување): the status waits for the courier''s pickup.'
                      ELSE format('The status (%s) already matches MEX.', _l.status) END,
                 _move),
          NULL, c_actor);

  UPDATE public.late_sale_moves l
     SET relink_order_id   = p_lead,
         relink_display_id = _l.display_id,
         relink_kind       = p_kind,
         relink_before     = _before,
         relink_after      = (SELECT to_jsonb(x) FROM public.orders x WHERE x.id = p_lead),
         after             = (SELECT to_jsonb(x) FROM public.orders x WHERE x.id = p_holder),
         dept_after        = (SELECT public.cohort_order_source(x.sale_source, x.sale_source_detail, x.mex_tracking_id, x.dept_override)
                                FROM public.orders x WHERE x.id = p_lead)
   WHERE l.id = _move;

  PERFORM set_config('elyon.allow_sold_change', coalesce(_prev_as, ''), true);
  PERFORM set_config('elyon.keep_updated_at', coalesce(_prev_ku, ''), true);
  PERFORM set_config('elyon.bulk_repair', coalesce(_prev_br, ''), true);

  RETURN jsonb_build_object('move', _move, 'holder', _h.display_id, 'lead', p_lead, 'lead_display', _l.display_id,
                            'from', _l.status, 'target', _target, 'mex_status', _p.status_id, 'writer', _e);
END
$fn$;
REVOKE ALL ON FUNCTION public.late_sale_relink(uuid, uuid, text, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.late_sale_relink(uuid, uuid, text, uuid, text, text, text) TO service_role;

COMMIT;
