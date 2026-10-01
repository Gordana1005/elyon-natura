-- ============================================================================
-- The 10-day no-parcel rule: two exemptions (owner, Mile, 01.10.2026)
-- ============================================================================
-- The rule itself is UNCHANGED: 10 days, AlterCPA + affiliate approvals, 21:10 Skopje, apply mode
-- (app_settings.no_parcel_rule = {days 10, hour 21, mode apply, sources [altercpa, affiliate], from_date
-- 2026-08-01}). A confirmed order with no parcel after 10 days is still cancelled — EXCEPT:
--
--   (a) in_collab  the sale is entered in collabBox: a collabBox SALES document (role credit / order /
--                  order_unless_held) for the same customer — collabbox_documents.phone8 = the order's last 8
--                  digits, or its komitent's card (collabbox_customers.phone8) — dated doc_at ≥ the sale − 1 day,
--                  not a storno, not reversed (reversed_by / reason reversed_by_storno), not vanished, not a
--                  zero-value replacement / error row, and not already the document of ANOTHER order
--                  (order_id / related_order_id empty or this order). The parcel follows (the collabBox LEADS
--                  document waits for it as credit_pending) → never cancelled, like needs_linking.
--   (b) postponed  a note says the DELIVERY is postponed ("ако има забелешка дека е одложено за покасно да
--                  стигне"). Texts read: a person's order note (order_notes with author_id — system notes are
--                  machine text), orders.delivery_instructions, and the operator's AlterCPA comment
--                  (altercpa_leads.payload->>'comment' — where 29 of the 41 postponements found in the last 120 days
--                  are written: "достава после 1ви", "сака да и стигне после 15 ти"). Exempt while the sale
--                  is at most app_settings.no_parcel_rule.postpone_days old (default 45, never below `days`);
--                  after that the rule cancels it as before.
--   Precedence: needs_linking (an unlinked parcel on the phone) > in_collab > postponed > cancel. Each is
--   written to no_parcel_rule_items.action with exempt_ref = the document number / the matched text.
--
-- THE POSTPONEMENT REGEX (PostgreSQL ARE, on lower(text); \m \M = word edges):
--   postponed = D .{0,40} L  OR  L .{0,40} D  OR  (W AND NOT C)
--   D  a delivery word   (достав|стигн|стаса|испрат|прат[иаеку]|dostav|stign|stasa|isprat|prat[iaeku])
--   L  a later DAY       покасн|подоцн|поокасн|pokasn|podocn
--                        | \m(после|по|од|posle|po|od) + a day: 15ти/1ви/24 ti, 17.09, први, плата, пензија, викенд,
--                          празници, a weekday, месец
--                        | \m(на|за|na|za) 15ти · a date \m dd.mm \M (a "." — "3/3 пратки" is a fraction)
--                        | следниот/наредниот/идниот месец|недела|викенд · во понеделник…недела · за N дена|недели
--                        (never an hour: "после 16ч" is a time of day; never "за 750 ден" — денари)
--   W  postponement words that need no delivery word: после/по плата|пензија · следниот/наредниот месец|недела ·
--      одлож*/odloz*
--   C  a call-back or a future ORDER — a cancellation reason, never a postponement: ќе/ке/kje/ke (се|ми|ни|не|му|и|
--      ја|го){0,2} јав|ѕвон|звон|бара|побара|слушн|контакт|нарача · да (се|го|ја|ги|му|и|ни|не){1,2}
--      слушн|бара|побара|јави|контакт|ѕвони|чуеме · да нарача|наруча|порача (+ the Latin spellings)
--   Calibrated read-only on 120 days of comments (01.10.2026): 41 hits, every one a delivery date
--   ("достава после 17.09", "да стигне пратката после вторник", "доставата да биде на после 08.10.2026");
--   "подоцна да го бараме", "на 15ти зимал плата, тогаш да му се јавиме", "naredniot mesec planira da naraca"
--   do NOT match.
--
-- Edits to the LIVE body of apply_no_parcel_rule (md5 f2ed73a70435a9726ad7071b7dffdb64 of prosrc, =
-- 20260942000700:234-382), counted:
--   E1 DECLARE: _collab, _postponed, _postpone_days + the four regex constants c_rx_d / c_rx_l / c_rx_w / c_rx_c
--   E2 _postpone_days from the settings (default 45, never below _days)
--   E3 _np: the scan is wrapped; + collab_doc, postponed_note and plan_action
--      (needs_linking > in_collab > postponed > cancel)
--   E4 the counts read plan_action (+ _collab, _postponed); to_cancel / value_eur = plan_action 'cancel' only
--   E5 the dry-run answer + in_collab, postponed, postpone_days
--   E6 no_parcel_rule_runs + in_collab, postponed
--   E7 no_parcel_rule_items.action = plan_action, + exempt_ref
--   E8 the cancel UPDATE takes plan_action = 'cancel' (was: unlinked_tracking IS NULL)
--   E9 the final answer + in_collab, postponed
-- Readers of the run row (Settings → Integrations, integrationsHealth.ts) ignore the new keys until they show
-- them; to_cancel keeps its meaning (what the run cancels). Revert: re-apply 20260942000700's body (git) —
-- the new columns and CHECK values may stay.
-- Report today's numbers (read-only, before or after this migration): node scripts/verify-parcel-link-rules.mjs
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '10s';

DO $drift$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(e.sig, ', ' ORDER BY e.sig) INTO v_bad
  FROM (VALUES
    ('public.apply_no_parcel_rule(boolean,boolean)', 'f2ed73a70435a9726ad7071b7dffdb64', '31bedf4e1390ab08c302fcb14317d342')
  ) e(sig, old_md5, new_md5)
  LEFT JOIN pg_proc p ON p.oid = to_regprocedure(e.sig)
  WHERE p.oid IS NULL OR md5(replace(p.prosrc, chr(13), '')) NOT IN (e.old_md5, e.new_md5);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'no-parcel exemptions: % changed since this migration was written — re-emit it from the live body', v_bad;
  END IF;
  IF to_regclass('public.collabbox_documents') IS NULL OR to_regclass('public.collabbox_customers') IS NULL
     OR to_regclass('public.altercpa_leads') IS NULL OR to_regprocedure('public.no_parcel_rule_days()') IS NULL THEN
    RAISE EXCEPTION 'no-parcel exemptions: collabbox_documents / collabbox_customers / altercpa_leads / no_parcel_rule_days() are required';
  END IF;
END
$drift$;

-- ── 1. the ledger learns the two exemptions ─────────────────────────────────
ALTER TABLE public.no_parcel_rule_items DROP CONSTRAINT IF EXISTS no_parcel_rule_items_action_check;
ALTER TABLE public.no_parcel_rule_items ADD CONSTRAINT no_parcel_rule_items_action_check
  CHECK (action IN ('cancel', 'needs_linking', 'cancelled', 'skipped', 'in_collab', 'postponed'));
ALTER TABLE public.no_parcel_rule_items ADD COLUMN IF NOT EXISTS exempt_ref text;
ALTER TABLE public.no_parcel_rule_runs  ADD COLUMN IF NOT EXISTS in_collab integer NOT NULL DEFAULT 0;
ALTER TABLE public.no_parcel_rule_runs  ADD COLUMN IF NOT EXISTS postponed integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.no_parcel_rule_items.exempt_ref IS
  'Why the order was not cancelled (20260944000960): in_collab → the collabBox document number; postponed → the note text that postpones the delivery (≤ 200 chars).';
COMMENT ON TABLE public.no_parcel_rule_items IS
  '2026-09-28: the orders each no-parcel run matched: cancel (report) | cancelled (apply) | needs_linking (an unlinked MEX parcel on the same phone) | in_collab (a collabBox sales document for the customer since the sale) | postponed (a note postpones the delivery; ≤ postpone_days) — the last three are never cancelled | skipped (changed under the run). Owner-only. Exemptions: 20260944000960.';

-- ── 2. the rule — the LIVE body with edits E1–E9 ─────────────────────────────
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
  _collab        integer;   -- E1: the two exemptions (owner 01.10.2026, 20260944000960)
  _postponed     integer;
  _postpone_days integer;
  -- the postponement regex (lower(text)): D .{0,40} L | L .{0,40} D | (W and not C) — documented in 20260944000960
  c_rx_d constant text := '(достав|стигн|стаса|испрат|прат[иаеку]|dostav|stign|stasa|isprat|prat[iaeku])';
  c_rx_l constant text := '(покасн|подоцн|поокасн|pokasn|podocn'
    || '|\m(после|по|од|posle|po|od)\s+(\d{1,2}\s?-?\s?(ти|ви|ри|ми|ог|ti|vi|ri|mi)\M|\d{1,2}\.(0?[1-9]|1[0-2])\M|први|прв|втори|плата|платата|пензи|викенд|празни|понеделник|вторник|среда|четврток|петок|сабота|недела|месец|prvi|vtori|plata|penzi|vikend|prazni|ponedel|vtornik|sreda|cetvrtok|petok|sabota|nedela|mesec)'
    || '|\m(на|за|na|za)\s+\d{1,2}\s?-?\s?(ти|ви|ри|ми|ti|vi|ri|mi)\M'
    || '|\m\d{1,2}\.(0?[1-9]|1[0-2])\M'
    || '|\m(следн|наредн|идн|sledn|nared|idn)\S*\s+(месец|недел|викенд|mesec|nedel|vikend)'
    || '|\m(во|vo)\s+(понеделник|вторник|среда|четврток|петок|сабота|недела|ponedel|vtornik|sreda|cetvrtok|petok|sabota|nedela)'
    || '|\m(за|za)\s+\d{1,2}\s+(дена|недели|недела|dena|nedeli|nedela))';
  c_rx_w constant text := '(\m(после|по|posle|po)\s+(плата|платата|пензија|пензијата|plata|platata|penzija|penzijata)'
    || '|\m(следн|наредн|идн|sledn|nared|idn)\S*\s+(месец|недел|mesec|nedel)'
    || '|одлож|odlo[zž])';
  c_rx_c constant text := '(\m(ќе|ке|kje|ke|ce|će)\s+((се|ми|ни|не|му|и|ѝ|ја|го|se|mi|ni|ne|mu|i|ja|go)\s+){0,2}(јав|ѕвон|звон|бара|побара|слушн|контакт|нарача|наруча|javi|jav|zvon|bara|pobara|slusn|kontakt|naraca|naruca)'
    || '|\m(да|da)\s+(нарача|наруча|порача|naraca|naruca|poraca)'
    || '|\m(да|da)\s+((се|го|ја|ги|му|и|ѝ|ни|не|se|go|ja|gi|mu|i|ni|ne)\s+){1,2}(слушн|бара|побара|јави|контакт|ѕвони|звони|чуеме|slusn|bara|pobara|javi|kontakt|zvoni|cuem))';
BEGIN
  _today := _skopje_now::date;

  SELECT value INTO _cfg FROM public.app_settings WHERE key = 'no_parcel_rule';
  _cfg       := coalesce(_cfg, '{}'::jsonb);
  _mode      := coalesce(_cfg->>'mode', 'report');
  _days      := public.no_parcel_rule_days();   -- settings.days, default 10, never below 3
  _sources   := coalesce(ARRAY(SELECT jsonb_array_elements_text(_cfg->'sources')), ARRAY['altercpa', 'affiliate']);
  _from_date := coalesce((_cfg->>'from_date')::date, DATE '2026-08-01');
  _hour      := coalesce((_cfg->>'hour')::int, 21);
  -- E2: a postponed delivery is spared until the sale is this old (default 45 days, never below the rule's days)
  _postpone_days := greatest(coalesce(CASE WHEN btrim(coalesce(_cfg->>'postpone_days', '')) ~ '^[0-9]{1,3}$'
                                           THEN (_cfg->>'postpone_days')::int END, 45), _days);
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
  -- E3: the scan is wrapped to classify it: needs_linking > in_collab > postponed > cancel
  SELECT s.*,
         CASE WHEN s.unlinked_tracking IS NOT NULL THEN 'needs_linking'
              WHEN s.collab_doc IS NOT NULL THEN 'in_collab'
              WHEN s.postponed_note IS NOT NULL THEN 'postponed'
              ELSE 'cancel' END AS plan_action
  FROM (
  SELECT a.*,
         (_today - (a.sold_at AT TIME ZONE 'Europe/Skopje')::date) AS days_waiting,
         (SELECT p.tracking_id FROM public.mex_parcels p
           WHERE length(a.p8) = 8 AND p.phone8 = a.p8 AND p.order_id IS NULL
             AND p.created_at_mex >= a.sold_at - interval '2 days'
           ORDER BY p.created_at_mex LIMIT 1) AS unlinked_tracking,
         (SELECT p.order_id FROM public.mex_parcels p
           WHERE length(a.p8) = 8 AND p.phone8 = a.p8 AND p.order_id IS NOT NULL AND p.order_id <> a.id
             AND p.created_at_mex >= a.sold_at - interval '2 days'
           ORDER BY p.created_at_mex LIMIT 1) AS other_order_id,
         -- (a) in_collab: a collabBox sales document for the customer since the sale (not a storno / reversed /
         --     vanished / zero-value / error row, not another order's document)
         (SELECT d.doc_number FROM public.collabbox_documents d
           WHERE length(a.p8) = 8
             AND (d.phone8 = a.p8
                  OR d.komitent_id IN (SELECT c.komitent_id FROM public.collabbox_customers c WHERE c.phone8 = a.p8))
             AND d.role IN ('credit', 'order', 'order_unless_held')
             AND NOT coalesce(d.is_storno, false) AND d.reversed_by IS NULL AND d.vanished_at IS NULL
             AND coalesce(d.outcome, '') NOT IN ('storno', 'replacement', 'error')
             AND coalesce(d.reason, '') <> 'reversed_by_storno'
             AND (d.order_id IS NULL OR d.order_id = a.id)
             AND (d.related_order_id IS NULL OR d.related_order_id = a.id)
             AND d.doc_at >= a.sold_at - interval '1 day'
           ORDER BY d.doc_at DESC, d.doc_number LIMIT 1) AS collab_doc,
         -- (b) postponed: a person's note, the delivery instructions or the AlterCPA operator's comment postpones
         --     the DELIVERY (the regex above), while the sale is at most _postpone_days old
         (SELECT left(regexp_replace(t.txt, '\s+', ' ', 'g'), 200)
            FROM (SELECT n.text AS txt, n.created_at AS at FROM public.order_notes n
                   WHERE n.order_id = a.id AND n.author_id IS NOT NULL
                  UNION ALL
                  SELECT o.delivery_instructions, o.created_at FROM public.orders o WHERE o.id = a.id
                  UNION ALL
                  SELECT l.payload ->> 'comment', l.last_seen_at FROM public.altercpa_leads l WHERE l.order_id = a.id) t
           WHERE coalesce(t.txt, '') <> ''
             AND (_today - (a.sold_at AT TIME ZONE 'Europe/Skopje')::date) <= _postpone_days
             AND (lower(t.txt) ~ (c_rx_d || '.{0,40}' || c_rx_l)
                  OR lower(t.txt) ~ (c_rx_l || '.{0,40}' || c_rx_d)
                  OR (lower(t.txt) ~ c_rx_w AND lower(t.txt) !~ c_rx_c))
           ORDER BY t.at DESC NULLS LAST LIMIT 1) AS postponed_note
  FROM anp a) s;

  -- E4: the counts read the classification
  SELECT count(*),
         count(*) FILTER (WHERE plan_action = 'cancel'),
         count(*) FILTER (WHERE plan_action = 'needs_linking'),
         coalesce(sum(price) FILTER (WHERE plan_action = 'cancel'), 0),
         count(*) FILTER (WHERE plan_action = 'in_collab'),
         count(*) FILTER (WHERE plan_action = 'postponed')
    INTO _cand, _cancel, _link, _value, _collab, _postponed
  FROM _np;

  IF _dry_run THEN
    RETURN jsonb_build_object('ok', true, 'dry_run', true, 'mode', _mode, 'days', _days,
                              'candidates', _cand, 'to_cancel', _cancel, 'needs_linking', _link,
                              'in_collab', _collab, 'postponed', _postponed, 'postpone_days', _postpone_days,   -- E5
                              'value_eur', round(_value, 2));
  END IF;

  INSERT INTO public.no_parcel_rule_runs (run_day, mode, trigger_kind, days, candidates, to_cancel,
                                          needs_linking, value_eur, settings, in_collab, postponed)   -- E6
  VALUES (_today, _mode, CASE WHEN _force THEN 'manual' ELSE 'cron' END, _days, _cand, _cancel,
          _link, round(_value, 2), _cfg, _collab, _postponed)
  RETURNING id INTO _run;

  INSERT INTO public.no_parcel_rule_items (run_id, order_id, display_id, action, sold_at, days_waiting,
                                           price_eur, sold_by_person_id, parcel_tracking, other_order_id, exempt_ref)
  SELECT _run, n.id, n.display_id,
         n.plan_action,                                                                              -- E7
         n.sold_at, n.days_waiting, n.price, n.sold_by_person_id, n.unlinked_tracking, n.other_order_id,
         CASE n.plan_action WHEN 'in_collab' THEN n.collab_doc WHEN 'postponed' THEN n.postponed_note END
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
       WHERE n.plan_action = 'cancel'                                                                -- E8
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
                            'in_collab', _collab, 'postponed', _postponed,                                -- E9
                            'value_eur', round(_value, 2), 'cancelled', _done);
END;
$function$;

COMMENT ON FUNCTION public.apply_no_parcel_rule(boolean, boolean) IS
  'The 10-day no-parcel rule (owner 28.09; 20260938000000 … 20260942000700): an AlterCPA / affiliate approval still confirmed with no MEX parcel `days` after the sale is cancelled (no_parcel_7d) at 21:10 Skopje — EXCEPT needs_linking (an unlinked parcel on the phone), in_collab (a collabBox sales document for the customer since the sale) and postponed (a note postpones the delivery, ≤ postpone_days) — owner 01.10.2026, 20260944000960.';

COMMIT;
