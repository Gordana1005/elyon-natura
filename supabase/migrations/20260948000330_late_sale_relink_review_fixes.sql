-- 20260948000330 — late_sale_relink / late_sale_relink_undo: two fixes from the code review (04.10.2026)
--
-- An independent read of 20260948000300 found nothing that blocks it and two things worth fixing:
--   1. the WORDS: a holder released with an unproven courier status ("its paid never had a MEX parcel of its own …
--      came N days after its sale and is a NEW order — the parcel / …", 20260947002030) kept "is a NEW order" in its
--      system cancel note although the parcel went to a LEAD — the relink's replace() looked for another shape. The
--      function now rewrites that shape too, and the 33 holders of run 92e559cb already relinked get the right words
--      here (text only: status, dates and money untouched; updated_at kept).
--   2. the UNDO and the lists: the status-only UPDATE fires the segment trigger while the reason / time columns are
--      still the relink's, so a lead going back to 'trashed' was read as a fresh permanent trash until the next
--      nightly recompute. The undo now recomputes the customer's lists once more on the final rows.
-- Both functions are re-emitted whole; nothing else changes.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL elyon.keep_updated_at = 'on';
SET LOCAL elyon.bulk_repair = 'on';

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
     SET cancellation_reason_notes = replace(replace(replace(replace(o.cancellation_reason_notes,
                                       'is a NEW order (owner 03.10.2026: a late sale is a new order)', _say),
                                       'is a NEW order (owner 03.10.2026)', _say),
                                       'is a NEW order — the parcel', _say || ' — the parcel'),   -- the "unproven courier status" release
                                       ' (owner 03.10.2026: a late sale is a new order)', ''),
         trash_reason_notes        = replace(replace(replace(replace(o.trash_reason_notes,
                                       'is a NEW order (owner 03.10.2026: a late sale is a new order)', _say),
                                       'is a NEW order (owner 03.10.2026)', _say),
                                       'is a NEW order — the parcel', _say || ' — the parcel'),
                                       ' (owner 03.10.2026: a late sale is a new order)', '')
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

CREATE OR REPLACE FUNCTION public.late_sale_relink_undo(p_run uuid, p_actor text DEFAULT NULL, p_move bigint DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  m        public.late_sale_moves%ROWTYPE;
  n        public.orders%ROWTYPE;
  b        jsonb;
  lb       jsonb;
  r        jsonb;
  _ok      integer := 0;
  _skipped jsonb := '[]'::jsonb;
  _prev_as text;
  _prev_ku text;
  _prev_br text;
BEGIN
  IF p_run IS NULL AND p_move IS NULL THEN
    RAISE EXCEPTION 'late_sale_relink_undo: a run or a move';
  END IF;
  _prev_as := current_setting('elyon.allow_sold_change', true);
  _prev_ku := current_setting('elyon.keep_updated_at', true);
  _prev_br := current_setting('elyon.bulk_repair', true);
  PERFORM set_config('elyon.allow_sold_change', 'on', true);
  PERFORM set_config('elyon.keep_updated_at', 'on', true);
  PERFORM set_config('elyon.bulk_repair', 'on', true);

  FOR m IN SELECT * FROM public.late_sale_moves l
            WHERE l.undone_at IS NULL AND l.relink_order_id IS NOT NULL AND l.new_order_id IS NULL
              AND (p_run IS NULL OR l.sync_run_id = p_run) AND (p_move IS NULL OR l.id = p_move)
            ORDER BY l.id DESC LOOP
    BEGIN
      b  := m.before;
      lb := m.relink_before;
      -- the old order: still as released?
      IF NOT EXISTS (SELECT 1 FROM public.orders o WHERE o.id = m.order_id
                       AND o.status::text = m.after ->> 'status'
                       AND o.mex_tracking_id IS NOT DISTINCT FROM m.after ->> 'mex_tracking_id'
                       AND o.sold_at IS NOT DISTINCT FROM (m.after ->> 'sold_at')::timestamptz) THEN
        _skipped := _skipped || jsonb_build_object('move', m.id, 'order', m.display_id, 'why', 'the old order changed since the relink');
        CONTINUE;
      END IF;
      -- the lead: still as relinked?
      SELECT * INTO n FROM public.orders WHERE id = m.relink_order_id FOR UPDATE;
      IF n.id IS NULL OR n.mex_tracking_id IS DISTINCT FROM m.tracking
         OR n.status::text IS DISTINCT FROM m.relink_after ->> 'status'
         OR EXISTS (SELECT 1 FROM public.agent_payout_items ap WHERE ap.order_id = n.id)
         OR EXISTS (SELECT 1 FROM public.order_history h WHERE h.order_id = n.id AND h.changed_by IS NOT NULL
                       AND h.changed_at > m.created_at) THEN
        _skipped := _skipped || jsonb_build_object('move', m.id, 'order', m.display_id, 'why', 'the lead changed since the relink');
        CONTINUE;
      END IF;

      -- the lead gives the parcel back and is what it was
      UPDATE public.mex_parcels mp SET order_id = NULL, link_method = NULL, linked_at = NULL
       WHERE mp.tracking_id = m.tracking AND mp.order_id = n.id;
      UPDATE public.orders o SET status = (lb ->> 'status')::public.order_status
       WHERE o.id = n.id AND o.status::text IS DISTINCT FROM lb ->> 'status';
      UPDATE public.orders o
         SET cancelled_at = (lb ->> 'cancelled_at')::timestamptz, cancellation_reason = lb ->> 'cancellation_reason',
             cancellation_reason_notes = lb ->> 'cancellation_reason_notes', trashed_at = (lb ->> 'trashed_at')::timestamptz,
             trash_reason = lb ->> 'trash_reason', trash_reason_notes = lb ->> 'trash_reason_notes',
             paid_at = (lb ->> 'paid_at')::timestamptz, returned_at = (lb ->> 'returned_at')::timestamptz,
             shipped_at = (lb ->> 'shipped_at')::timestamptz, paid_basis = lb ->> 'paid_basis',
             mex_tracking_id = lb ->> 'mex_tracking_id', mex_account = lb ->> 'mex_account',
             mex_status_id = (lb ->> 'mex_status_id')::integer, mex_cod_mkd = (lb ->> 'mex_cod_mkd')::integer,
             mex_delivered_at = (lb ->> 'mex_delivered_at')::timestamptz, mex_returned_at = (lb ->> 'mex_returned_at')::timestamptz,
             mex_last_update_at = (lb ->> 'mex_last_update_at')::timestamptz, mex_sent_at = (lb ->> 'mex_sent_at')::timestamptz,
             price = (lb ->> 'price')::numeric, quantity = (lb ->> 'quantity')::integer,
             sold_at = (lb ->> 'sold_at')::timestamptz, sold_via = lb ->> 'sold_via', sold_by_ext = lb ->> 'sold_by_ext',
             sold_by_person_id = (lb ->> 'sold_by_person_id')::uuid
       WHERE o.id = n.id;
      FOR r IN SELECT x FROM jsonb_array_elements(coalesce(lb -> '_register', '[]'::jsonb)) x LOOP
        UPDATE public.mex_parcels mp
           SET order_id = nullif(r ->> 'order_id', '')::uuid, link_method = r ->> 'link_method',
               linked_at = (r ->> 'linked_at')::timestamptz
         WHERE mp.tracking_id = r ->> 'tracking_id' AND mp.tracking_id <> m.tracking;
      END LOOP;
      IF m.relink_after ->> 'status' IS DISTINCT FROM lb ->> 'status' THEN
        INSERT INTO public.order_history (order_id, from_status, to_status, changed_by, changed_by_name)
        VALUES (n.id, (m.relink_after ->> 'status')::public.order_status, (lb ->> 'status')::public.order_status, NULL,
                'System (rollback:late-sale-relink)');
      END IF;

      -- the document's ledger row goes back
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

      -- the old order holds the parcel again (the block of late_sale_undo, 20260947002000): status first
      -- (the NULL-only timestamp triggers), then the columns
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
             'System (rollback:late-sale-relink)'
       WHERE m.after ->> 'status' IS DISTINCT FROM b ->> 'status';
      INSERT INTO public.order_notes (order_id, text, author_id, author_name)
      VALUES (m.order_id, format('Rollback of the late-parcel relink (move %s): this order holds MEX parcel %s again; lead %s is back as it was.',
                                 m.id, m.tracking, m.relink_display_id), NULL, 'System (rollback:late-sale-relink)'),
             (n.id, format('Rollback of the late-parcel relink (move %s): MEX parcel %s went back to order %s; this lead is as it was before.',
                           m.id, m.tracking, m.display_id), NULL, 'System (rollback:late-sale-relink)');
      -- the lists once more, on the final rows: the status-only UPDATEs above fire the segment trigger while the
      -- reason / time columns are still the relink's (a lead back to 'trashed' is read as a fresh permanent trash)
      PERFORM public.recompute_customer_segments(n.customer_phone);
      PERFORM public.recompute_customer_segments(o.customer_phone) FROM public.orders o
       WHERE o.id = m.order_id AND o.customer_phone IS DISTINCT FROM n.customer_phone;
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
REVOKE ALL ON FUNCTION public.late_sale_relink_undo(uuid, text, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.late_sale_relink_undo(uuid, text, bigint) TO service_role;

-- the words on the holders already relinked (idempotent: the pattern is gone afterwards)
UPDATE public.orders o
   SET cancellation_reason_notes = replace(replace(o.cancellation_reason_notes,
         'is a NEW order — the parcel',
         format('is the sale of lead %s of the same customer (the phone + date rule)', l.relink_display_id) || ' — the parcel'),
         ' (owner 03.10.2026: a late sale is a new order)', '')
  FROM public.late_sale_moves l
 WHERE l.order_id = o.id AND l.relink_order_id IS NOT NULL AND l.undone_at IS NULL
   AND o.status::text = 'cancelled'
   AND o.cancellation_reason_notes LIKE '%' || l.tracking || '%and is a NEW order — the parcel%';

COMMIT;
