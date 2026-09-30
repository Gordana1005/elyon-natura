-- collabBox writer: a parcel at MEX 8 ("Shipment created") is ЗА ПАКУВАЊЕ, not shipped
-- (owner, 30.09.2026 — the naturatherapy.mk semantics; plan Фаза 9).
--
-- collabbox_apply_one used to create the order of a folder document as 'shipped' for ANY parcel
-- status other than 2 / 7. Now:
--   parcel 8            → 'confirmed' (за пакување), shipped_at NULL, mex_sent_at = the parcel's
--                         creation at MEX; the ledger reason reads 'parcel_to_pack'
--   parcel 4/10/9/1/3/… → 'shipped' (unchanged)   2 → 'paid'   7 → 'returned'   (unchanged)
--   no parcel           → 'confirmed' (unchanged)
-- Every order it creates also carries mex_sent_at (20260943001200) when a parcel exists.
-- mex-reconcile moves the order on to shipped when the courier takes the parcel (the remembered
-- 'tracking' link, shipGate 'open'). Money does not move: the cohort is MEX-first (MEX 8 = 'label').
--
-- The body is the LIVE definition (md5 acc1ca8320aa43dbc08c2c5df1a3f85c of prosrc, CR-stripped) with five exact edits;
-- the drift guard refuses to run on anything else. Revert = re-apply the previous body (git).

BEGIN;

SET LOCAL lock_timeout = '10s';

DO $drift$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.collabbox_apply_one(uuid,jsonb,boolean)')
                   AND md5(replace(p.prosrc, chr(13), '')) IN ('acc1ca8320aa43dbc08c2c5df1a3f85c')) THEN
    RAISE EXCEPTION 'collabBox MEX 8: collabbox_apply_one changed since this migration was written';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'orders'
                   AND column_name = 'mex_sent_at') THEN
    RAISE EXCEPTION 'collabBox MEX 8: orders.mex_sent_at is missing — apply 20260943001200 first';
  END IF;
END
$drift$;

CREATE OR REPLACE FUNCTION public.collabbox_apply_one(p_run uuid, p_doc jsonb, p_dry boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  c_rate      CONSTANT numeric := 61.5;   -- MKD_PER_EUR — FROZEN (CLAUDE.md): never "update" it
  c_delivery  CONSTANT numeric := 150;    -- the MEX delivery fee a COD may include
  c_tol       CONSTANT numeric := 3;      -- ден
  c_no_items  CONSTANT text := 'collabBox: без ставки (непознат производ)';
  _doc        text := nullif(btrim(p_doc ->> 'doc_number'), '');
  _type       text := nullif(btrim(p_doc ->> 'type_id'), '');
  _role       text;
  _doc_at     timestamptz;
  _amount     numeric;
  _author     text := nullif(regexp_replace(btrim(coalesce(p_doc ->> 'author', '')), '\s+', ' ', 'g'), '');
  _kom        text := nullif(btrim(p_doc ->> 'komitent_id'), '');
  _kname      text := nullif(btrim(p_doc ->> 'komitent_name'), '');
  _lines      jsonb := CASE WHEN jsonb_typeof(p_doc -> 'lines') = 'array' THEN p_doc -> 'lines' ELSE '[]'::jsonb END;
  _complete   boolean := coalesce((p_doc ->> 'lines_complete')::boolean, false);
  _storno     boolean := coalesce((p_doc ->> 'storno')::boolean, false);
  _card       jsonb := CASE WHEN jsonb_typeof(p_doc -> 'komitent') = 'object' THEN p_doc -> 'komitent' END;
  _flags      text[] := ARRAY(SELECT jsonb_array_elements_text(
                           CASE WHEN jsonb_typeof(p_doc -> 'flags') = 'array' THEN p_doc -> 'flags' ELSE '[]'::jsonb END));
  _nlines     integer := 0;
  _goods      numeric := 0;
  _delivery   numeric := 0;
  _unmapped   integer := 0;
  _notes      text[];
  _goods_l    jsonb := '[]'::jsonb;
  _top        uuid;
  _pname      text;
  _qty        integer := 1;
  _person     uuid;
  _ext        text;
  _prev       public.collabbox_documents%ROWTYPE;
  _has_prev   boolean := false;
  _o          record;
  _has_o      boolean := false;
  _p          public.mex_parcels%ROWTYPE;
  _has_p      boolean := false;
  _cc         public.collabbox_customers%ROWTYPE;
  _has_cc     boolean := false;
  _tic        record;
  _has_tic    boolean := false;
  _holder     uuid;
  _outcome    text;
  _reason     text;
  _order_id   uuid;
  _related    uuid;
  _credit     text;
  _status     text;
  _basis      text;
  _paid_at    timestamptz;
  _shipped_at timestamptz;
  _sent_at    timestamptz;                -- when the parcel was created at MEX (orders.mex_sent_at)
  _ret_at     timestamptz;
  _p8         text;
  _psrc       text;
  _phone      text;
  _cname      text;
  _city       text;
  _address    text;
  _skip       text;
  _price      numeric;
  _link       text;
  _dept       text[];
  _created    boolean := false;
  _changed    boolean := false;
  _orig       text;
  _svalue     numeric;
  _note_head  text;
BEGIN
  IF _doc IS NULL THEN
    RAISE EXCEPTION 'collabbox: a document without doc_number' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF _type IS NULL OR _type !~ '^[0-9]{3,8}$' THEN
    RAISE EXCEPTION 'collabbox: % has no type id', _doc USING ERRCODE = 'invalid_parameter_value';
  END IF;
  _doc_at := public.collabbox_parse_local(p_doc ->> 'doc_at');
  IF _doc_at IS NULL THEN
    RAISE EXCEPTION 'collabbox: % has no parseable doc_at (%)', _doc, left(p_doc ->> 'doc_at', 40)
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  _role   := public.collabbox_doc_role(_type);
  _amount := public.collabbox_num(p_doc ->> 'amount_mkd');

  -- ── the lines, as the function classified them (a product id must exist) ──
  SELECT count(*)::integer,
         coalesce(sum(s.v) FILTER (WHERE s.r = 'goods'), 0),
         coalesce(sum(s.v) FILTER (WHERE s.r = 'delivery'), 0),
         count(*) FILTER (WHERE s.r = 'goods' AND s.pid IS NULL AND (s.q > 0 OR s.v > 0))::integer,
         array_agg(s.raw ORDER BY s.ord) FILTER (WHERE s.r = 'note' AND s.raw <> ''),
         coalesce(jsonb_agg(jsonb_build_object('product_id', s.pid, 'name', s.nm, 'qty', s.q, 'value_mkd', s.v)
                            ORDER BY s.ord) FILTER (WHERE s.r = 'goods' AND (s.q > 0 OR s.v > 0)), '[]'::jsonb),
         (array_agg(s.pid ORDER BY s.v DESC, s.ord) FILTER (WHERE s.r = 'goods' AND s.pid IS NOT NULL))[1],
         left(string_agg(s.nm, ' + ' ORDER BY s.ord) FILTER (WHERE s.r = 'goods' AND (s.q > 0 OR s.v > 0)), 300),
         greatest(coalesce(sum(greatest(ceil(s.q), 1)) FILTER (WHERE s.r = 'goods' AND (s.q > 0 OR s.v > 0)), 0), 1)::integer
    INTO _nlines, _goods, _delivery, _unmapped, _notes, _goods_l, _top, _pname, _qty
    FROM (SELECT x.ord,
                 CASE WHEN x.l ->> 'role' IN ('goods', 'delivery', 'note', 'marker') THEN x.l ->> 'role' ELSE 'note' END AS r,
                 pr.id AS pid,
                 left(coalesce(nullif(btrim(x.l ->> 'product_name'), ''), nullif(btrim(x.l ->> 'name'), ''), '—'), 300) AS nm,
                 left(btrim(coalesce(x.l ->> 'name', '')), 500) AS raw,
                 coalesce(public.collabbox_num(x.l ->> 'qty'), 0) AS q,
                 coalesce(public.collabbox_num(x.l ->> 'value_mkd'), 0) AS v
            FROM jsonb_array_elements(_lines) WITH ORDINALITY AS x(l, ord)
            LEFT JOIN public.products pr   -- CASE: the cast never runs on a malformed id
              ON pr.id = CASE WHEN (x.l ->> 'product_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                              THEN (x.l ->> 'product_id')::uuid END) s;

  SELECT i.person_id, i.ext INTO _person, _ext FROM public.collabbox_author_identity(_author) i;
  _dept := public.collabbox_department(_type, _doc, _person, _doc_at);

  SELECT * INTO _prev FROM public.collabbox_documents WHERE doc_number = _doc;
  _has_prev := FOUND;

  SELECT o.id, o.status::text AS status, o.price, o.packed_at, o.mex_status_id, o.mex_tracking_id,
         o.collabbox_doc_type, o.sold_at, o.sold_via, o.sold_by_ext, o.sold_by_person_id
    INTO _o
    FROM public.orders o
   WHERE o.external_source = 'collabbox' AND o.external_order_id = _doc;
  _has_o := FOUND;

  SELECT * INTO _p FROM public.mex_parcels WHERE tracking_id = _doc;
  _has_p := FOUND;

  <<decide>>
  LOOP
    -- ── A. a storno: recorded, never an order; the document it reverses is marked ──
    IF _storno THEN
      _outcome := 'storno';
      SELECT abs(sum(coalesce(public.collabbox_num(l ->> 'value_mkd'), 0)))
        INTO _svalue
        FROM jsonb_array_elements(_lines) l
       WHERE coalesce(public.collabbox_num(l ->> 'value_mkd'), 0) < 0;
      _svalue := coalesce(nullif(_svalue, 0), abs(_amount));
      _orig := nullif(btrim(p_doc ->> 'reverses'), '');
      IF _orig IS NULL AND _kom IS NOT NULL AND coalesce(_svalue, 0) > 0 THEN
        -- the same komitent's earlier document worth exactly that, ≤ 120 days back — only when ONE fits
        SELECT CASE WHEN count(*) = 1 THEN min(c.doc) END INTO _orig
          FROM (SELECT d.doc_number AS doc
                  FROM public.collabbox_documents d
                 WHERE d.komitent_id = _kom AND d.doc_number <> _doc AND NOT d.is_storno
                   AND d.reversed_by IS NULL AND d.vanished_at IS NULL
                   AND abs(coalesce(d.amount_mkd, 0) - _svalue) <= 1
                   AND d.doc_at <= _doc_at AND d.doc_at >= _doc_at - interval '120 days'
                UNION
                SELECT t.doc_number
                  FROM public.teleshop_import_documents t
                 WHERE t.komitent_id = _kom AND t.doc_number <> _doc
                   AND NOT (t.outcome = 'skipped' AND t.reason IN ('storno', 'reversed_by_storno'))
                   AND abs(coalesce(t.amount_mkd, 0) - _svalue) <= 1
                   AND t.doc_at <= _doc_at AND t.doc_at >= _doc_at - interval '120 days') c;
      END IF;
      IF _orig IS NULL THEN
        _reason := 'storno_unmatched';
        EXIT decide;
      END IF;
      _reason := 'reverses:' || _orig;
      SELECT d.order_id INTO _related
        FROM public.collabbox_documents d
       WHERE d.doc_number = _orig AND d.created_by_sync AND d.order_id IS NOT NULL;
      IF _related IS NOT NULL THEN
        _flags := _flags || 'storno_marks_sync_order'::text;
        _note_head := 'collabBox storno ' || _doc || ' ';
        IF NOT p_dry THEN
          INSERT INTO public.order_notes (order_id, text, author_id, author_name)
          SELECT _related,
                 _note_head || format('(%s) reverses document %s. The order is left as it is (its status comes from MEX) — check it and cancel it if it never shipped.',
                                      to_char(_doc_at AT TIME ZONE 'Europe/Skopje', 'DD.MM.YYYY HH24:MI'), _orig),
                 NULL, 'collabBox'
           WHERE NOT EXISTS (SELECT 1 FROM public.order_notes n
                              WHERE n.order_id = _related AND left(n.text, length(_note_head)) = _note_head);
        END IF;
      ELSE
        SELECT t.order_id INTO _related
          FROM public.teleshop_import_documents t
         WHERE t.doc_number = _orig AND t.outcome IN ('created', 'exists', 'enriched') AND t.order_id IS NOT NULL;
        IF _related IS NOT NULL THEN
          _flags := _flags || 'storno_original_imported'::text;
        END IF;
      END IF;
      IF NOT p_dry THEN
        UPDATE public.collabbox_documents d
           SET reversed_by = _doc,
               flags = CASE WHEN 'reversed_by_storno' = ANY (d.flags) THEN d.flags ELSE d.flags || 'reversed_by_storno'::text END,
               updated_at = now()
         WHERE d.doc_number = _orig AND d.reversed_by IS DISTINCT FROM _doc;
      END IF;
      EXIT decide;
    END IF;

    -- ── B. record-only types ────────────────────────────────────────────────
    IF _role = 'record' THEN
      _outcome := 'recorded';
      _order_id := CASE WHEN _has_o THEN _o.id END;
      EXIT decide;
    END IF;

    -- ── C. the document already IS an order (the idempotency key) ────────────
    IF _has_o THEN
      _order_id := _o.id;
      IF _o.collabbox_doc_type IS NULL THEN
        _changed := true;
        IF NOT p_dry THEN
          UPDATE public.orders SET collabbox_doc_type = _type WHERE id = _o.id AND collabbox_doc_type IS NULL;
        END IF;
      ELSIF _o.collabbox_doc_type <> _type THEN
        _flags := _flags || ('type_changed:' || _o.collabbox_doc_type || '>' || _type);  -- listed; the department is write-once
      END IF;
      IF _o.sold_at IS NULL AND _o.sold_via IS NULL AND _o.sold_by_ext IS NULL AND _o.sold_by_person_id IS NULL THEN
        _credit := public.collabbox_credit_order(_o.id, _doc, _doc_at, _author, p_dry);
        IF _credit IN ('stamped', 'stamped_no_person', 'person_filled') THEN _changed := true; END IF;
      END IF;
      -- edited in collabBox before it shipped — only an order THIS sync created, still to pack
      IF _has_prev AND _prev.created_by_sync AND _o.status = 'confirmed' AND _o.packed_at IS NULL
         AND _o.mex_status_id IS NULL AND _complete THEN
        _price := round(CASE WHEN _nlines > 0 THEN _goods ELSE coalesce(_amount, 0) END / c_rate, 2);
        IF _price > 0 AND abs(_price - coalesce(_o.price, 0)) >= 0.01 THEN
          _changed := true;
          _flags := _flags || 'edited_before_packing'::text;
          IF NOT p_dry THEN
            UPDATE public.orders o
               SET price = _price, quantity = _qty,
                   product_name = coalesce(_pname, o.product_name), product_id = coalesce(_top, o.product_id)
             WHERE o.id = _o.id AND o.status = 'confirmed';
            IF jsonb_array_length(_goods_l) > 0 THEN
              DELETE FROM public.order_items WHERE order_id = _o.id;
              INSERT INTO public.order_items (order_id, product_id, product_name, quantity, price_per_unit, total_price, created_at)
              SELECT _o.id, i.product_id, i.product_name, i.quantity, i.price_per_unit, i.total_price, _doc_at
                FROM public.collabbox_items(_goods_l, _price) i;
            END IF;
            INSERT INTO public.order_notes (order_id, text, author_id, author_name)
            VALUES (_o.id, format('collabBox document %s was edited before packing — price %s → %s EUR.', _doc, _o.price, _price),
                    NULL, 'collabBox');
          END IF;
        END IF;
      ELSIF _has_prev AND _prev.created_by_sync AND _o.status <> 'confirmed'
            AND _amount IS DISTINCT FROM _prev.amount_mkd THEN
        _flags := _flags || 'amount_edited_after_shipping'::text;   -- MEX decides; listed
      END IF;
      IF nullif(p_doc ->> 'reversed_by', '') IS NOT NULL OR (_has_prev AND _prev.reversed_by IS NOT NULL) THEN
        _flags := _flags || 'reversed_by_storno'::text;
      END IF;
      _outcome := CASE WHEN _changed THEN 'updated' ELSE 'exists' END;
      EXIT decide;
    END IF;

    -- ── D. Нарачка LEADS: never an order — credit the order holding its parcel ──
    IF _role = 'credit' THEN
      _holder := CASE WHEN _has_p THEN _p.order_id END;
      IF _holder IS NULL THEN
        SELECT CASE WHEN count(*) = 1 THEN (array_agg(o.id))[1] END INTO _holder
          FROM public.orders o WHERE o.mex_tracking_id = _doc;
      END IF;
      IF coalesce(_amount, 0) <= 0 THEN
        _outcome := 'replacement'; _reason := 'replacement_zero_value'; _related := _holder;
        EXIT decide;
      END IF;
      IF _holder IS NULL THEN
        _outcome := 'credit_pending';
        _reason := CASE WHEN _has_p THEN 'parcel_not_linked_yet' ELSE 'no_parcel_yet' END;
        EXIT decide;
      END IF;
      _related := _holder;
      _credit := public.collabbox_credit_order(_holder, _doc, _doc_at, _author, p_dry);
      _outcome := CASE WHEN _credit IN ('stamped', 'stamped_no_person', 'person_filled') THEN 'credited' ELSE 'recorded' END;
      _reason := 'credit_' || coalesce(_credit, 'none');
      EXIT decide;
    END IF;

    -- ── E. an order document (10036 · 10050 · 10106) or LEADS-OUT (10114) ─────
    IF nullif(p_doc ->> 'reversed_by', '') IS NOT NULL OR (_has_prev AND _prev.reversed_by IS NOT NULL) THEN
      _outcome := 'skipped'; _reason := 'reversed_by_storno';
      EXIT decide;
    END IF;
    IF 'duplicate_doc_number' = ANY (_flags) THEN
      _outcome := 'skipped'; _reason := 'duplicate_doc_number';
      EXIT decide;
    END IF;
    IF _doc !~ '^[0-9]{3}-[0-9]{4}-[0-9]+/[0-9]{4}$' THEN
      _outcome := 'skipped'; _reason := 'bad_doc_number';
      EXIT decide;
    END IF;
    IF NOT _complete THEN
      _outcome := 'no_items'; _reason := 'line_items_not_read';
      EXIT decide;
    END IF;
    IF _amount IS NULL THEN
      _outcome := 'skipped'; _reason := 'no_amount';
      EXIT decide;
    END IF;
    IF _nlines = 0 THEN
      _goods := _amount;                               -- a document without lines: its header amount
      _flags := _flags || 'no_items_in_document'::text;
    END IF;
    IF _amount <= 0 OR _goods <= 0 THEN
      _outcome := 'replacement'; _reason := 'replacement_zero_value';
      EXIT decide;
    END IF;
    IF _has_p AND coalesce(_p.cod_mkd, 0) <= 0 THEN
      _outcome := 'replacement'; _reason := 'replacement_cod0';
      EXIT decide;
    END IF;

    -- who else holds / names this parcel
    _holder := CASE WHEN _has_p THEN _p.order_id END;
    IF _holder IS NOT NULL THEN
      _reason := 'parcel_held_by_other_order';
    ELSE
      SELECT o.id INTO _holder FROM public.orders o WHERE o.mex_tracking_id = _doc ORDER BY o.created_at LIMIT 1;
      IF _holder IS NOT NULL THEN _reason := 'tracking_named_by_other_order'; END IF;
    END IF;
    IF _holder IS NOT NULL THEN
      _related := _holder;
      IF _role = 'order_unless_held' THEN
        _credit := public.collabbox_credit_order(_holder, _doc, _doc_at, _author, p_dry);
        _outcome := CASE WHEN _credit IN ('stamped', 'stamped_no_person', 'person_filled') THEN 'credited' ELSE 'recorded' END;
        _reason := _reason || ';credit_' || coalesce(_credit, 'none');
      ELSE
        _outcome := 'conflict';                         -- never a second order, never a forced link
      END IF;
      EXIT decide;
    END IF;
    IF _has_p AND EXISTS (SELECT 1 FROM public.web_orders w
                           WHERE w.mex_tracking_id = _doc AND w.deleted_in_shop_at IS NULL) THEN
      _outcome := 'conflict'; _reason := 'parcel_claimed_by_web_order';
      EXIT decide;
    END IF;
    IF _has_p AND _p.created_at_mex IS NOT NULL AND _p.created_at_mex < _doc_at THEN
      _outcome := 'conflict'; _reason := 'parcel_predates_document';   -- never linked to a later order
      EXIT decide;
    END IF;
    -- No parcel yet → wait (retried 14 nights), never a "to pack" CRM order: teleshop, social and
    -- LEADS-OUT are packed in collabBox, so a sync order without a parcel would sit in the CRM
    -- warehouse's Packing queue (a double-pack risk). Until the parcel exists the booking is seen
    -- through collabbox_booked_today() (the leaderboard). Main session, 29.09.2026.
    IF _role IN ('order', 'order_unless_held') AND NOT _has_p THEN
      _outcome := 'awaiting_parcel';
      _reason := CASE WHEN _role = 'order_unless_held' THEN 'leads_out_waits_for_its_parcel' ELSE 'waits_for_its_parcel' END;
      EXIT decide;
    END IF;

    -- ── the customer: the card read tonight / stored, the teleshop registry, the parcel ──
    IF _kom IS NOT NULL THEN
      SELECT * INTO _cc FROM public.collabbox_customers WHERE komitent_id = _kom;
      _has_cc := FOUND;
    END IF;
    IF _card IS NOT NULL THEN
      _p8 := public.collabbox_mk_phone8(_card ->> 'phone8');
      _skip := nullif(btrim(_card ->> 'skip_reason'), '');
      _cname := nullif(btrim(_card ->> 'name'), '');
      _city := nullif(btrim(_card ->> 'city'), '');
      _address := nullif(btrim(_card ->> 'address'), '');
      IF jsonb_typeof(_card -> 'flags') = 'array' AND (_card -> 'flags') ? 'do_not_contact' THEN
        _flags := _flags || 'banned_customer_do_not_contact'::text;
      END IF;
    ELSIF _has_cc AND _cc.source = 'card' THEN
      _p8 := public.collabbox_mk_phone8(_cc.phone8);
      _skip := _cc.skip_reason;
      _cname := nullif(btrim(_cc.name), '');
      _city := nullif(btrim(_cc.city), '');
      _address := nullif(btrim(_cc.address), '');
      IF 'do_not_contact' = ANY (_cc.flags) THEN _flags := _flags || 'banned_customer_do_not_contact'::text; END IF;
    END IF;
    IF _p8 IS NOT NULL THEN _psrc := 'card'; END IF;
    IF _kom IS NOT NULL THEN
      SELECT t.phone8, t.outcome, t.reason, t.name INTO _tic
        FROM public.teleshop_import_customers t WHERE t.komitent_id = _kom;
      _has_tic := FOUND;
      IF _has_tic THEN
        IF _p8 IS NULL AND public.collabbox_mk_phone8(_tic.phone8) IS NOT NULL THEN
          _p8 := _tic.phone8; _psrc := 'teleshop_import';
        END IF;
        IF _skip IS NULL AND _tic.outcome = 'skipped'
           AND _tic.reason IN ('deceased', 'employee', 'company', 'operator_account', 'do_not_ship',
                               'junk_name', 'wrong_number', 'test_name') THEN
          _skip := _tic.reason;
        END IF;
        _cname := coalesce(_cname, nullif(btrim(_tic.name), ''));
      END IF;
    END IF;
    -- a komitent nobody knows yet (no card, not in the teleshop registry): its header name decides
    IF _card IS NULL AND NOT (_has_cc AND _cc.source = 'card') AND NOT _has_tic THEN
      _skip := coalesce(_skip, nullif(btrim(p_doc ->> 'name_skip'), ''));
      IF jsonb_typeof(p_doc -> 'name_flags') = 'array' AND (p_doc -> 'name_flags') ? 'do_not_contact'
         AND NOT ('banned_customer_do_not_contact' = ANY (_flags)) THEN
        _flags := _flags || 'banned_customer_do_not_contact'::text;
      END IF;
    END IF;
    IF _has_p AND public.collabbox_mk_phone8(_p.phone8) IS NOT NULL THEN
      IF _p8 IS NULL THEN
        _p8 := _p.phone8; _psrc := 'parcel';
      ELSIF _p8 <> _p.phone8 THEN
        _flags := _flags || 'phone_differs_from_parcel'::text;
      END IF;
    END IF;
    IF _p8 IS NULL AND _has_cc AND _cc.source = 'parcel' AND public.collabbox_mk_phone8(_cc.phone8) IS NOT NULL THEN
      _p8 := _cc.phone8; _psrc := 'parcel_registry';
    END IF;
    _cname := left(coalesce(_cname, _kname, nullif(btrim(CASE WHEN _has_p THEN _p.receiver_name END), ''), '—'), 200);
    _city := left(coalesce(_city, nullif(btrim(CASE WHEN _has_p THEN _p.receiver_city END), ''), ''), 120);
    _address := left(coalesce(_address, ''), 600);

    IF _skip IS NOT NULL THEN
      _outcome := 'skipped'; _reason := 'komitent_' || _skip;
      EXIT decide;
    END IF;
    IF _p8 IS NULL THEN
      _outcome := 'no_phone';
      _reason := CASE WHEN _kom IS NULL THEN 'no_komitent'
                      WHEN _card IS NULL AND NOT _has_cc THEN 'komitent_card_not_read'
                      ELSE 'no_valid_macedonian_phone' END;
      EXIT decide;
    END IF;
    IF public.is_report_excluded_phone(_p8) THEN
      _outcome := 'skipped'; _reason := 'test_phone';
      EXIT decide;
    END IF;
    _phone := '+389' || _p8;

    -- ── the same sale already in the CRM (a twin) → never a second order ─────
    SELECT o.id INTO _related
      FROM public.orders o
     WHERE right(regexp_replace(o.customer_phone, '[^0-9]', '', 'g'), 8) = _p8
       AND o.external_source IS DISTINCT FROM 'collabbox'
       AND o.status::text IN ('pending', 'take', 'call_again', 'confirmed', 'shipped', 'delivered', 'paid', 'returned')
       AND o.mex_tracking_id IS NULL
       AND o.price > 0
       AND NOT public.is_synthetic_product_name(o.product_name)
       AND o.sale_source_detail IS DISTINCT FROM 'disposition'
       AND o.created_at >= _doc_at - interval '1 day'
       AND o.created_at <= _doc_at + interval '2 days'
       AND (abs(round(o.price * c_rate) - _amount) <= c_tol
            OR abs(round(o.price * c_rate) + c_delivery - _amount) <= c_tol
            OR abs(round(o.price * c_rate) - round(_goods)) <= c_tol)
     ORDER BY abs(extract(epoch FROM o.created_at - _doc_at)), o.created_at
     LIMIT 1;
    IF _related IS NOT NULL THEN
      _outcome := 'conflict'; _reason := 'possible_twin_crm_sale';
      EXIT decide;
    END IF;
    IF EXISTS (SELECT 1 FROM public.orders o
                WHERE right(regexp_replace(o.customer_phone, '[^0-9]', '', 'g'), 8) = _p8
                  AND o.external_source IS DISTINCT FROM 'collabbox'
                  AND o.status::text IN ('pending', 'take', 'call_again', 'confirmed', 'shipped', 'delivered', 'paid', 'returned')
                  AND o.mex_tracking_id IS NULL AND o.price > 0
                  AND o.created_at >= _doc_at - interval '3 days' AND o.created_at <= _doc_at + interval '3 days') THEN
      _flags := _flags || 'near_crm_sale_price_differs'::text;   -- not the owner's twin rule: listed, created
    END IF;

    -- ── price and status — MEX decides the status, never collabBox ──────────
    _price := round(_goods / c_rate, 2);
    IF _has_p AND _p.cod_mkd > 0
       AND NOT (abs(_p.cod_mkd - round(_goods)) <= c_tol OR abs(_p.cod_mkd - round(_goods) - c_delivery) <= c_tol) THEN
      _price := round(_p.cod_mkd / c_rate, 2);                     -- COD ≠ price → MEX is right
      _flags := _flags || 'price_from_cod'::text;
    END IF;
    IF _nlines > 0 AND abs(_amount - round(_goods) - round(_delivery)) > c_tol THEN
      _flags := _flags || 'lines_differ_from_amount'::text;
    END IF;
    IF _has_p THEN
      -- MEX 8 "Shipment created" = за пакување: the order stays confirmed until the courier takes it
      -- (4/10/9/1/3 → shipped). Owner 30.09.2026; mex-reconcile applies the same rule (match.ts targetFor).
      _status := CASE _p.status_id WHEN 2 THEN 'paid' WHEN 7 THEN 'returned' WHEN 8 THEN 'confirmed' ELSE 'shipped' END;
      _sent_at := coalesce(_p.created_at_mex, _doc_at);
      _shipped_at := CASE WHEN _status = 'confirmed' THEN NULL ELSE _sent_at END;
      IF _status = 'paid' THEN
        _paid_at := coalesce(_p.delivered_at, _p.last_update_at, _shipped_at);
        _basis := 'mex';
      ELSIF _status = 'returned' THEN
        _ret_at := coalesce(_p.returned_at, _p.last_update_at, _shipped_at);
      END IF;
    ELSE
      _status := 'confirmed';                                      -- to pack; mex-reconcile takes over
    END IF;
    IF _author IS NULL THEN _flags := _flags || 'no_author'::text;
    ELSIF _person IS NULL THEN _flags := _flags || 'author_unmapped'::text;
    END IF;
    _outcome := 'created';
    _reason := CASE WHEN _has_p AND _status = 'confirmed' THEN 'parcel_to_pack' WHEN _has_p THEN 'parcel_' || _status ELSE 'to_pack' END;

    IF NOT p_dry THEN
      BEGIN
        INSERT INTO public.orders (
               product_id, product_name, customer_name, customer_phone, customer_city, customer_address,
               price, quantity, status, source_type, external_source, external_order_id, delivery_type,
               created_at, confirmed_at, sold_at, sold_via, sold_by_ext, sold_by_person_id,
               mex_tracking_id, paid_at, paid_basis, shipped_at, returned_at, collabbox_doc_type, mex_sent_at)
        VALUES (_top, coalesce(_pname, c_no_items), _cname, _phone, _city, _address,
                _price, _qty, _status::public.order_status, 'import', 'collabbox', _doc, 'home',
                _doc_at, _doc_at,
                CASE WHEN _ext IS NOT NULL THEN _doc_at END,
                CASE WHEN _ext IS NOT NULL THEN 'collabbox' END,
                _ext, _person,
                _doc, _paid_at, _basis, _shipped_at, _ret_at, _type, _sent_at)
        ON CONFLICT (external_source, external_order_id) WHERE external_order_id IS NOT NULL DO NOTHING
        RETURNING id INTO _order_id;

        IF _order_id IS NULL THEN
          -- another writer created it a moment ago: this document is an order now
          SELECT o.id INTO _order_id FROM public.orders o
           WHERE o.external_source = 'collabbox' AND o.external_order_id = _doc;
          _outcome := 'exists'; _reason := 'created_concurrently';
        ELSE
          _created := true;
          IF jsonb_array_length(_goods_l) > 0 THEN
            INSERT INTO public.order_items (order_id, product_id, product_name, quantity, price_per_unit, total_price, created_at)
            SELECT _order_id, i.product_id, i.product_name, i.quantity, i.price_per_unit, i.total_price, _doc_at
              FROM public.collabbox_items(_goods_l, _price) i;
          END IF;
          INSERT INTO public.order_notes (order_id, text, author_id, author_name, created_at)
          SELECT _order_id, 'collabBox: ' || n, NULL, 'collabBox', _doc_at
            FROM unnest(coalesce(_notes, '{}'::text[])) n;
          INSERT INTO public.order_history (order_id, from_status, to_status, changed_by, changed_by_name)
          VALUES (_order_id, NULL, _status::public.order_status, NULL, 'System (collabbox-sync)');
          INSERT INTO public.customer_profiles (phone, customer_name, city, street)
          VALUES (_phone, nullif(_cname, '—'), nullif(_city, ''), nullif(_address, ''))
          ON CONFLICT (phone) DO NOTHING;
          IF _has_p THEN
            -- trg_orders_link_parcel already claimed the FREE parcel ('unknown_writer');
            -- this names the method. Anything else = another linker won since the check.
            _link := public.mex_link_parcel(_doc, _order_id, 'collabbox_import', false);
            IF _link IS DISTINCT FROM 'linked' AND _link IS DISTINCT FROM 'already' THEN
              RAISE EXCEPTION 'collabbox: parcel % → %', _doc, coalesce(_link, 'null') USING ERRCODE = 'P0CBX';
            END IF;
          END IF;
        END IF;
      EXCEPTION WHEN SQLSTATE 'P0CBX' THEN
        _created := false;
        _order_id := NULL;
        _outcome := 'conflict';
        _reason := 'parcel_claimed_concurrently';
        SELECT m.order_id INTO _related FROM public.mex_parcels m WHERE m.tracking_id = _doc;
      END;
    END IF;
    EXIT decide;
  END LOOP;

  -- ── the komitent registry (not in a dry run) ──────────────────────────────
  IF NOT p_dry AND _kom IS NOT NULL THEN
    IF _card IS NOT NULL THEN
      INSERT INTO public.collabbox_customers AS c
             (komitent_id, object_id, name, phone8, phone_field, phone_raw, city, address, skip_reason, flags, source, run_id)
      VALUES (_kom, nullif(btrim(_card ->> 'object_id'), ''), nullif(btrim(_card ->> 'name'), ''),
              public.collabbox_mk_phone8(_card ->> 'phone8'), nullif(btrim(_card ->> 'phone_field'), ''),
              left(nullif(btrim(_card ->> 'phone_raw'), ''), 200), nullif(btrim(_card ->> 'city'), ''),
              left(nullif(btrim(_card ->> 'address'), ''), 600), nullif(btrim(_card ->> 'skip_reason'), ''),
              ARRAY(SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(_card -> 'flags') = 'array'
                                                          THEN _card -> 'flags' ELSE '[]'::jsonb END)),
              'card', p_run)
      ON CONFLICT (komitent_id) DO UPDATE
         SET object_id = coalesce(EXCLUDED.object_id, c.object_id), name = coalesce(EXCLUDED.name, c.name),
             phone8 = EXCLUDED.phone8, phone_field = EXCLUDED.phone_field, phone_raw = EXCLUDED.phone_raw,
             city = coalesce(EXCLUDED.city, c.city), address = coalesce(EXCLUDED.address, c.address),
             skip_reason = EXCLUDED.skip_reason, flags = EXCLUDED.flags, source = 'card',
             run_id = EXCLUDED.run_id, updated_at = now();
    ELSIF _psrc = 'parcel' AND NOT _has_cc THEN
      INSERT INTO public.collabbox_customers (komitent_id, name, phone8, phone_field, city, source, run_id)
      VALUES (_kom, nullif(_cname, '—'), _p8, 'parcel', nullif(_city, ''), 'parcel', p_run)
      ON CONFLICT (komitent_id) DO NOTHING;
    END IF;
  END IF;

  -- ── the ledger row (not in a dry run) ──────────────────────────────────────
  IF NOT p_dry THEN
    INSERT INTO public.collabbox_documents AS d (
           doc_number, doc_id, object_id, doc_type_id, doc_type_name, role, doc_at, komitent_id, komitent_name,
           author, author_person_id, amount_mkd, goods_mkd, delivery_mkd, price_eur, lines_n, lines_complete,
           unmapped_lines, is_storno, reverses_doc, reversed_by, phone8, phone_source, customer_phone,
           outcome, reason, department, planned_status, paid_basis, parcel_status_id, parcel_cod_mkd,
           order_id, related_order_id, created_by_sync, created_run_id, credit, flags, attempts,
           first_run_id, run_id, first_seen_at, last_seen_at, vanished_at, payload, updated_at)
    VALUES (_doc, nullif(btrim(p_doc ->> 'doc_id'), ''), nullif(btrim(p_doc ->> 'object_id'), ''), _type,
            nullif(btrim(p_doc ->> 'type_name'), ''), _role, _doc_at, _kom, _kname,
            _author, _person, _amount, CASE WHEN _role <> 'record' OR _nlines > 0 THEN _goods END, _delivery,
            CASE WHEN _outcome IN ('created', 'updated') THEN _price END, _nlines, _complete,
            _unmapped, _storno, CASE WHEN _storno THEN _orig END, nullif(btrim(p_doc ->> 'reversed_by'), ''),
            _p8, _psrc, _phone, _outcome, _reason, _dept,
            CASE WHEN _outcome = 'created' THEN _status END, CASE WHEN _outcome = 'created' THEN _basis END,
            CASE WHEN _has_p THEN _p.status_id END, CASE WHEN _has_p THEN _p.cod_mkd END,
            _order_id, _related, _created, CASE WHEN _created THEN p_run END, _credit,
            coalesce(_flags, '{}'::text[]), 1, p_run, p_run, now(), now(), NULL, p_doc, now())
    ON CONFLICT (doc_number) DO UPDATE
       SET doc_id           = coalesce(EXCLUDED.doc_id, d.doc_id),
           object_id        = coalesce(EXCLUDED.object_id, d.object_id),
           doc_type_id      = EXCLUDED.doc_type_id,
           doc_type_name    = coalesce(EXCLUDED.doc_type_name, d.doc_type_name),
           role             = EXCLUDED.role,
           doc_at           = EXCLUDED.doc_at,
           komitent_id      = EXCLUDED.komitent_id,
           komitent_name    = coalesce(EXCLUDED.komitent_name, d.komitent_name),
           author           = EXCLUDED.author,
           author_person_id = EXCLUDED.author_person_id,
           amount_mkd       = EXCLUDED.amount_mkd,
           goods_mkd        = EXCLUDED.goods_mkd,
           delivery_mkd     = EXCLUDED.delivery_mkd,
           price_eur        = coalesce(EXCLUDED.price_eur, d.price_eur),
           lines_n          = EXCLUDED.lines_n,
           lines_complete   = EXCLUDED.lines_complete,
           unmapped_lines   = EXCLUDED.unmapped_lines,
           is_storno        = EXCLUDED.is_storno,
           reverses_doc     = coalesce(EXCLUDED.reverses_doc, d.reverses_doc),
           reversed_by      = coalesce(d.reversed_by, EXCLUDED.reversed_by),
           phone8           = coalesce(EXCLUDED.phone8, d.phone8),
           phone_source     = coalesce(EXCLUDED.phone_source, d.phone_source),
           customer_phone   = coalesce(EXCLUDED.customer_phone, d.customer_phone),
           outcome          = EXCLUDED.outcome,
           reason           = EXCLUDED.reason,
           department       = EXCLUDED.department,
           planned_status   = coalesce(EXCLUDED.planned_status, d.planned_status),
           paid_basis       = coalesce(EXCLUDED.paid_basis, d.paid_basis),
           parcel_status_id = EXCLUDED.parcel_status_id,
           parcel_cod_mkd   = EXCLUDED.parcel_cod_mkd,
           order_id         = coalesce(EXCLUDED.order_id, d.order_id),
           related_order_id = EXCLUDED.related_order_id,
           created_by_sync  = d.created_by_sync OR EXCLUDED.created_by_sync,
           created_run_id   = coalesce(d.created_run_id, EXCLUDED.created_run_id),
           credit           = coalesce(EXCLUDED.credit, d.credit),
           flags            = EXCLUDED.flags,
           attempts         = d.attempts + 1,
           first_run_id     = coalesce(d.first_run_id, EXCLUDED.first_run_id),
           run_id           = EXCLUDED.run_id,
           last_seen_at     = now(),
           vanished_at      = NULL,
           payload          = EXCLUDED.payload,
           updated_at       = now();
  END IF;

  RETURN jsonb_build_object(
    'doc', _doc, 'type', _type, 'role', _role, 'outcome', _outcome, 'reason', _reason,
    'order_id', _order_id, 'related_order_id', _related, 'credit', _credit,
    'status', CASE WHEN _outcome = 'created' THEN _status END,
    'price_eur', CASE WHEN _outcome IN ('created', 'updated') THEN _price END,
    'goods_mkd', _goods, 'amount_mkd', _amount, 'lines', _nlines, 'unmapped', _unmapped,
    'phone_source', _psrc, 'department', to_jsonb(_dept), 'author_person', _person,
    'flags', to_jsonb(coalesce(_flags, '{}'::text[])));
END;
$function$;

COMMIT;
