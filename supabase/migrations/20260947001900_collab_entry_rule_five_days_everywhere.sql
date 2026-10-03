-- ============================================================================
-- The collabBox entry rule: 5 days, for EVERY sale (owner, Mile, 03.10.2026 — "ГО")
-- ============================================================================
-- Owner: "Треба да почекаме порачката да се внесе барем следните 5 дена најново правило за од секаде, ако порачката ја
--   нема во collab 5 дена, тогаш одиме cancel со причина, нема внесено порачка во Collab. Барем се додека не почнат од
--   кај нас да испраќаат со пошта."
-- Replaces the 2-day CRM-only rule of 20260947000200 (report mode, never applied). Until the CRM itself ships
-- ("Испрати до MEX", mex_push, switched OFF) a sale reaches MEX ONLY through a collabBox document — its DocNumber IS the
-- MEX tracking id — so a sale nobody entered in collabBox is never shipped.
--
-- THE POPULATION (collab_entry_rule_plan) — every SALE a person or an intake made outside collabBox:
--   status confirmed | shipped (shipped in the CRM with no MEX parcel = never shipped), no MEX tracking id, price > 0,
--   NOT external_source 'collabbox' (collabBox made it), NOT sale_source 'web' (the shop), NOT a disposition (elyon_crm /
--   disposition), NOT a test phone (report_excluded_phone8s), ship_after_date not in the future, sold on a Skopje day
--   >= from_date (2026-08-01). That is: CRM sales of every department (Менаџмент included), AlterCPA approvals (Тим
--   Маџари In — bridge and history), affiliate partner orders and any other intake. MEX-only parcels are not orders.
--   paid / delivered with no parcel (AlterCPA's own "paid", 49 since 01.08) are NOT touched: they claim money, and the
--   cohort already leaves them alone (20260947001850).
--
-- "IN COLLABBOX" — sale_collab_evidence(order), ONE definition for the rule, its re-check and the /orders badge. The
-- first that fits (kind · ref):
--   pushed            a success in mex_push_attempts (ok / exists_linked) — the CRM shipped it itself; the rule fades
--                     out by itself once the push is switched on
--   in_collab         crm_sale_collab_doc (20260947000200, unchanged): (a) a document names the order (order_id /
--                     related_order_id), (b) a living sales document on the customer's phone or komitent booked from
--                     the sale − 2 days on, (c) the phoneless twin (the seller's booking within 10 min, or the
--                     customer's full name); + a document whose number is the order's external_order_id
--   in_collab_amount  NEW — the phoneless LEADS / LEADS-OUT booking: a living, unclaimed sales document with NO phone
--                     (its own or its komitent's) entered (least(booked_at, doc_at)) from the sale − 2 days to the sale
--                     + days + 1, whose value is the sale's (goods or total = price × 61.5, or + 150 delivery, ± 3 ден)
--                     AND whose komitent name shares a name word (≥ 4 letters, mk_geo_norm-folded, equal or contained)
--                     with the customer's — sale_collab_amount_twin()
--   needs_linking     an unlinked MEX parcel on the customer's phone created since the sale − 2 days
--   postponed         a note postpones the DELIVERY — the no-parcel rule's regex, character for character
--                     (sale_delivery_postponed_note; verify E6 compares the two), while the sale is ≤ postpone_days (45)
--   A false "in collabBox" only spares an order; the rule never cancels on a doubt.
-- BACKTEST (read-only, September sale days 01–27, the rule evaluated as of sale day + 5 at 21:20): 3.210 sales; without
--   in_collab_amount 485 would have been cancelled, 12 of them WRONG (41.190 ден — their own parcel's collabBox document
--   was booked in time, but it carries no phone: 10111 LEADS / 10114 LEADS-OUT); with it 1 wrong (3.500 ден, Ѕвонко ≠
--   Zvonko after the fold) and 7 never-shipped sales spared. exports/collab5/ (gitignored).
--
-- THE RULE — apply_collab_entry_rule(force, dry_run), cron collab-entry-rule hourly at :20 UTC, acting once a day in the
--   Skopje `hour` (21) — the function reads the Skopje clock, so CEST / CET need no cron change (21:02 linker · 21:06
--   LEADS orders · 21:10 no-parcel · 21:20 this):
--   warn     age = days − 1 (the evening before): a bell to the seller, once per order (apply mode, `warn`)
--   cancel   age >= days and no evidence: status cancelled, cancellation_reason 'other' (a SYSTEM cancel, never a
--            person's reason — a new code would touch the api's reason lists and mex-reconcile), cancellation_reason_notes
--            'Нема внесено порачка во Collab' (the owner's words), machine code not_in_collab_<days>d in the ledger
--            (collab_entry_rule_items.reason_code), an order_history row (from the order's own status), a system order
--            note, updated_at kept (elyon.keep_updated_at), paid / returned bells silenced (elyon.bulk_repair).
--   bells    to the SELLER (sales_people.user_id of sold_by_person_id) — else the confirmer, else the assignee — type
--            not_in_collab (meta notif.notInCollab), the evening before not_in_collab_warning (notif.notInCollabWarning).
--            A sale whose day is more than silent_after_days (14) old is cancelled SILENTLY (no bell; items.silent).
--   Re-check at the cancel: status unchanged, still no parcel, still no evidence (sale_collab_evidence).
-- Undo a run: collab_entry_rule_undo(run_id) (service role) — back to the status each order had (items.status_before).
-- Settings (owner key app_settings.collab_entry_rule): {mode, days 5, hour 21, from_date 2026-08-01, warn true,
--   silent_after_days 14, postpone_days 45, scope 'all'} — this migration keeps the mode (report); 20260947001910
--   switches it to apply.
-- Read-only: collab_entry_rule_plan(p_days) answers for any number of days. Proof: node scripts/verify-collab-entry-rule.mjs
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $drift$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(e.sig, ', ' ORDER BY e.sig) INTO v_bad
  FROM (VALUES
    ('public.collab_entry_rule_plan()',                  '7ce489ae4874eeb4b2ff585da26033db'),
    ('public.apply_collab_entry_rule(boolean,boolean)',  'd0f69f4c61105f1917b5b5ce2e1b19c1'),
    ('public.collab_entry_rule_undo(uuid)',              'f16dc95c333e02c5153aff37b7af49d6'),
    ('public.crm_sale_collab_states(uuid[])',            '6608cf9ce566c02e18c9fa4578a2e1b0'),
    ('public.apply_no_parcel_rule(boolean,boolean)',     '31bedf4e1390ab08c302fcb14317d342')
  ) e(sig, md5)
  LEFT JOIN pg_proc p ON p.oid = to_regprocedure(e.sig)
  WHERE p.oid IS NULL OR md5(replace(p.prosrc, chr(13), '')) <> e.md5;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'collab entry rule 5 days: % changed since this migration was written — re-read the live body', v_bad;
  END IF;
  IF to_regprocedure('public.crm_sale_collab_doc(uuid)') IS NULL
     OR to_regprocedure('public.mk_geo_norm(text)') IS NULL
     OR to_regprocedure('public.report_excluded_phone8s()') IS NULL
     OR to_regprocedure('public.cohort_order_source(text,text,text,text)') IS NULL
     OR to_regprocedure('public.order_dept_by_team(text,uuid,timestamptz)') IS NULL
     OR to_regclass('public.mex_push_attempts') IS NULL THEN
    RAISE EXCEPTION 'collab entry rule 5 days: a helper is missing (crm_sale_collab_doc / mk_geo_norm / report_excluded_phone8s / cohort_order_source 4-arg / order_dept_by_team / mex_push_attempts)';
  END IF;
END
$drift$;

-- ── 1. the ledger learns the wider rule ─────────────────────────────────────
ALTER TABLE public.collab_entry_rule_items DROP CONSTRAINT IF EXISTS collab_entry_rule_items_action_check;
ALTER TABLE public.collab_entry_rule_items ADD CONSTRAINT collab_entry_rule_items_action_check
  CHECK (action IN ('cancel', 'cancelled', 'warn', 'warned', 'in_collab', 'needs_linking', 'pushed', 'postponed',
                    'skipped', 'undone'));
ALTER TABLE public.collab_entry_rule_items
  ADD COLUMN IF NOT EXISTS status_before      text,
  ADD COLUMN IF NOT EXISTS sale_source        text,
  ADD COLUMN IF NOT EXISTS sale_source_detail text,
  ADD COLUMN IF NOT EXISTS department         text,
  ADD COLUMN IF NOT EXISTS evidence_kind      text,
  ADD COLUMN IF NOT EXISTS silent             boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reason_code        text;
ALTER TABLE public.collab_entry_rule_runs
  ADD COLUMN IF NOT EXISTS pushed           integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS postponed        integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cancelled_silent integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS scope            text;

COMMENT ON TABLE public.collab_entry_rule_runs IS
  'Owner 02.10 / 03.10.2026: one row per run of the collabBox entry rule (apply_collab_entry_rule; 5 days, every sale since 20260947001900) — mode, days, counts, value, settings; cancelled_silent = cancels without a bell (sale > silent_after_days old); undone_at / undone when collab_entry_rule_undo reverted it. Owner-only (service role).';
COMMENT ON TABLE public.collab_entry_rule_items IS
  'The orders each collabBox entry-rule run matched: cancel (report) | cancelled (apply) | warn | warned | in_collab (evidence = the document) | needs_linking (the unlinked parcel) | pushed (the CRM shipped it) | postponed (the note) | skipped (changed under the run) | undone. status_before = the status a cancel replaced (the undo restores it); reason_code = not_in_collab_<days>d; silent = cancelled without a bell. Migrations 20260947000200 / 1900.';

-- ── 2. name words: the phoneless booking's customer ─────────────────────────
CREATE OR REPLACE FUNCTION public.collab_name_words(p_name text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE PARALLEL SAFE
AS $fn$
  -- the words of a name folded to Latin (mk_geo_norm), split like collabbox_name_key, 4+ letters, distinct
  SELECT coalesce(array_agg(DISTINCT w.t ORDER BY w.t), ARRAY[]::text[])
  FROM (SELECT public.mk_geo_norm(x) AS t
          FROM regexp_split_to_table(coalesce(p_name, ''), '[[:space:][:punct:][:digit:]]+') AS x) w
  WHERE length(w.t) >= 4;
$fn$;

CREATE OR REPLACE FUNCTION public.collab_names_share_word(p_a text, p_b text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE PARALLEL SAFE
AS $fn$
  -- one word of one name equals, or is contained in, a word of the other ("Janevskgjorgji" ~ "ЃОРЃИ ЈАНЕВСКИ")
  SELECT EXISTS (SELECT 1 FROM unnest(public.collab_name_words(p_a)) x, unnest(public.collab_name_words(p_b)) y
                  WHERE x = y OR strpos(x, y) > 0 OR strpos(y, x) > 0);
$fn$;

-- ── 3. the phoneless booking of the same value ──────────────────────────────
CREATE OR REPLACE FUNCTION public.sale_collab_amount_twin(p_order uuid, p_days integer DEFAULT 5)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  WITH o AS (
    SELECT x.id, x.customer_name, round(x.price * 61.5) AS cod,
           coalesce(x.sold_at, x.confirmed_at, x.created_at) AS at
    FROM public.orders x
    WHERE x.id = p_order AND coalesce(x.price, 0) > 0
  )
  SELECT d.doc_number
  FROM o, public.collabbox_documents d
  WHERE d.doc_at >= o.at - interval '2 days'                                    -- doc_at >= entered: the index range
    AND d.doc_at <  o.at + make_interval(days => greatest(coalesce(p_days, 5), 1) + 16)
    AND least(coalesce(d.booked_at, d.doc_at), d.doc_at)
        BETWEEN o.at - interval '2 days' AND o.at + make_interval(days => greatest(coalesce(p_days, 5), 1) + 1)
    AND d.role IN ('credit', 'order', 'order_unless_held')
    AND NOT coalesce(d.is_storno, false) AND d.reversed_by IS NULL AND d.vanished_at IS NULL
    AND coalesce(d.outcome, '') NOT IN ('storno', 'replacement', 'error')
    AND coalesce(d.reason, '') <> 'reversed_by_storno'
    AND (d.order_id IS NULL OR d.order_id = o.id)
    AND (d.related_order_id IS NULL OR d.related_order_id = o.id)
    AND (abs(coalesce(d.goods_mkd, d.amount_mkd) - o.cod) <= 3
         OR abs(d.amount_mkd - o.cod) <= 3
         OR abs(d.amount_mkd - o.cod - 150) <= 3)
    AND coalesce(length(d.phone8), 0) <> 8                                      -- no phone of its own …
    AND NOT EXISTS (SELECT 1 FROM public.collabbox_customers c                   -- … nor its komitent's
                     WHERE c.komitent_id = d.komitent_id AND length(c.phone8) = 8)
    AND NOT EXISTS (SELECT 1 FROM public.teleshop_import_customers t
                     WHERE t.komitent_id = d.komitent_id AND length(t.phone8) = 8)
    AND public.collab_names_share_word(d.komitent_name, o.customer_name)
  ORDER BY least(coalesce(d.booked_at, d.doc_at), d.doc_at), d.doc_number
  LIMIT 1;
$fn$;
COMMENT ON FUNCTION public.sale_collab_amount_twin(uuid, integer) IS
  'Owner 03.10.2026: the phoneless collabBox booking of a sale — a living, unclaimed sales document with no phone (own or komitent''s), entered (least(booked_at, doc_at)) from the sale − 2 days to the sale + days + 1, of the sale''s value (goods / total = price × 61.5, or + 150, ± 3 ден) and sharing a name word with the customer (collab_names_share_word) — or NULL. Most 10111 LEADS documents carry no phone yet. Migration 20260947001900.';

-- ── 4. a note that postpones the delivery — the no-parcel rule's regex ───────
CREATE OR REPLACE FUNCTION public.sale_delivery_postponed_note(p_order uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  -- COPIED CHARACTER FOR CHARACTER from apply_no_parcel_rule (20260944000960) — verify-collab-entry-rule E6 compares them
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
  RETURN (
    SELECT left(regexp_replace(t.txt, '\s+', ' ', 'g'), 200)
      FROM (SELECT n.text AS txt, n.created_at AS at FROM public.order_notes n
             WHERE n.order_id = p_order AND n.author_id IS NOT NULL
            UNION ALL
            SELECT o.delivery_instructions, o.created_at FROM public.orders o WHERE o.id = p_order
            UNION ALL
            SELECT l.payload ->> 'comment', l.last_seen_at FROM public.altercpa_leads l WHERE l.order_id = p_order) t
     WHERE coalesce(t.txt, '') <> ''
       AND (lower(t.txt) ~ (c_rx_d || '.{0,40}' || c_rx_l)
            OR lower(t.txt) ~ (c_rx_l || '.{0,40}' || c_rx_d)
            OR (lower(t.txt) ~ c_rx_w AND lower(t.txt) !~ c_rx_c))
     ORDER BY t.at DESC NULLS LAST
     LIMIT 1);
END;
$fn$;
COMMENT ON FUNCTION public.sale_delivery_postponed_note(uuid) IS
  'Owner 03.10.2026: the note (a person''s order note, the delivery instructions, the AlterCPA operator''s comment) that postpones the DELIVERY of an order, by the no-parcel rule''s regex (20260944000960, copied character for character) — or NULL. The age limit (postpone_days) is the caller''s. Migration 20260947001900.';

-- ── 5. the evidence: ONE definition ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.sale_collab_evidence(p_order uuid, p_days integer DEFAULT NULL)
RETURNS TABLE(kind text, ref text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _cfg   jsonb := coalesce((SELECT s.value FROM public.app_settings s WHERE s.key = 'collab_entry_rule'), '{}'::jsonb);
  _np    jsonb := coalesce((SELECT s.value FROM public.app_settings s WHERE s.key = 'no_parcel_rule'), '{}'::jsonb);
  _days  integer := greatest(1, least(30, coalesce(p_days, CASE WHEN coalesce(_cfg->>'days', '') ~ '^[0-9]{1,2}$'
                                                                THEN (_cfg->>'days')::int END, 5)));
  _pdays integer := coalesce(CASE WHEN coalesce(_cfg->>'postpone_days', '') ~ '^[0-9]{1,3}$' THEN (_cfg->>'postpone_days')::int END,
                             CASE WHEN coalesce(_np->>'postpone_days', '') ~ '^[0-9]{1,3}$' THEN (_np->>'postpone_days')::int END,
                             45);
  _today date := (now() AT TIME ZONE 'Europe/Skopje')::date;
  _o     record;
  _p8    text;
  _r     text;
BEGIN
  SELECT x.id, x.mex_tracking_id, x.external_order_id, x.customer_phone,
         coalesce(x.sold_at, x.confirmed_at, x.created_at) AS at
    INTO _o
    FROM public.orders x WHERE x.id = p_order;
  IF NOT FOUND THEN RETURN; END IF;
  _p8 := right(regexp_replace(coalesce(_o.customer_phone, ''), '\D', '', 'g'), 8);

  IF _o.mex_tracking_id IS NOT NULL THEN
    kind := 'parcel'; ref := _o.mex_tracking_id; RETURN NEXT; RETURN;
  END IF;

  SELECT coalesce(a.tracking_id, a.id::text) INTO _r FROM public.mex_push_attempts a
   WHERE a.order_id = p_order AND a.status IN ('ok', 'exists_linked') ORDER BY a.created_at LIMIT 1;
  IF _r IS NOT NULL THEN kind := 'pushed'; ref := _r; RETURN NEXT; RETURN; END IF;

  _r := public.crm_sale_collab_doc(p_order);
  IF _r IS NULL AND nullif(btrim(coalesce(_o.external_order_id, '')), '') IS NOT NULL THEN
    SELECT d.doc_number INTO _r FROM public.collabbox_documents d
     WHERE d.doc_number = _o.external_order_id AND NOT coalesce(d.is_storno, false) AND d.vanished_at IS NULL;
  END IF;
  IF _r IS NOT NULL THEN kind := 'in_collab'; ref := _r; RETURN NEXT; RETURN; END IF;

  _r := public.sale_collab_amount_twin(p_order, _days);
  IF _r IS NOT NULL THEN kind := 'in_collab_amount'; ref := _r; RETURN NEXT; RETURN; END IF;

  SELECT p.tracking_id INTO _r FROM public.mex_parcels p
   WHERE length(_p8) = 8 AND p.phone8 = _p8 AND p.order_id IS NULL
     AND p.created_at_mex >= _o.at - interval '2 days'
   ORDER BY p.created_at_mex LIMIT 1;
  IF _r IS NOT NULL THEN kind := 'needs_linking'; ref := _r; RETURN NEXT; RETURN; END IF;

  IF (_today - (_o.at AT TIME ZONE 'Europe/Skopje')::date) <= greatest(_pdays, _days) THEN
    _r := public.sale_delivery_postponed_note(p_order);
    IF _r IS NOT NULL THEN kind := 'postponed'; ref := _r; RETURN NEXT; RETURN; END IF;
  END IF;

  kind := NULL; ref := NULL; RETURN NEXT;
END;
$fn$;
COMMENT ON FUNCTION public.sale_collab_evidence(uuid, integer) IS
  'Owner 03.10.2026: why a sale counts as entered in collabBox (kind, ref) — parcel (it holds a MEX parcel) | pushed (mex_push_attempts ok / exists_linked) | in_collab (crm_sale_collab_doc, or the document named by external_order_id) | in_collab_amount (sale_collab_amount_twin: the phoneless booking of the same value and name) | needs_linking (an unlinked parcel on the phone since the sale − 2 days) | postponed (sale_delivery_postponed_note, while ≤ postpone_days) — or one row (NULL, NULL). ONE definition for the 5-day rule, its re-check and the /orders badge. Migration 20260947001900.';

-- ── 6. the plan (read-only): what a run would do now ────────────────────────
DROP FUNCTION IF EXISTS public.collab_entry_rule_plan();

CREATE FUNCTION public.collab_entry_rule_plan(p_days integer DEFAULT NULL)
RETURNS TABLE(order_id uuid, display_id text, customer_name text, sold_at timestamptz, sale_day date, age_days integer,
              price_eur numeric, sold_by_person_id uuid, owner_user_id uuid, collab_doc text,
              unlinked_tracking text, plan_action text,
              status text, sale_source text, sale_source_detail text, department text,
              evidence_kind text, evidence_ref text, silent boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _cfg    jsonb := coalesce((SELECT s.value FROM public.app_settings s WHERE s.key = 'collab_entry_rule'), '{}'::jsonb);
  _days   integer := greatest(1, least(30, coalesce(p_days, CASE WHEN coalesce(_cfg->>'days', '') ~ '^[0-9]{1,2}$'
                                                                 THEN (_cfg->>'days')::int END, 5)));
  _from   date := coalesce(CASE WHEN coalesce(_cfg->>'from_date', '') ~ '^\d{4}-\d{2}-\d{2}$'
                                THEN (_cfg->>'from_date')::date END, date '2026-08-01');
  _silent integer := coalesce(CASE WHEN coalesce(_cfg->>'silent_after_days', '') ~ '^[0-9]{1,3}$'
                                   THEN (_cfg->>'silent_after_days')::int END, 14);
  _today  date := (now() AT TIME ZONE 'Europe/Skopje')::date;
  _excl   text[] := public.report_excluded_phone8s();
BEGIN
  RETURN QUERY
  WITH c AS (
    SELECT x.id, x.display_id, x.customer_name, coalesce(x.price, 0) AS price, x.sold_by_person_id,
           coalesce((SELECT sp.user_id FROM public.sales_people sp WHERE sp.id = x.sold_by_person_id),
                    x.confirmed_by_agent_id, x.assigned_agent_id) AS owner_id,
           coalesce(x.sold_at, x.confirmed_at, x.created_at) AS at,
           (coalesce(x.sold_at, x.confirmed_at, x.created_at) AT TIME ZONE 'Europe/Skopje')::date AS sday,
           right(regexp_replace(coalesce(x.customer_phone, ''), '\D', '', 'g'), 8) AS p8,
           x.status::text AS st, x.sale_source AS src, x.sale_source_detail AS det,
           public.cohort_order_source(x.sale_source, x.sale_source_detail, x.mex_tracking_id, x.dept_override) AS dept
    FROM public.orders x
    WHERE x.status IN ('confirmed', 'shipped')
      AND x.mex_tracking_id IS NULL
      AND coalesce(x.external_source, '') <> 'collabbox'
      AND coalesce(x.sale_source, '') <> 'web'
      AND coalesce(x.sale_source_detail, '') <> 'disposition'
      AND coalesce(x.price, 0) > 0
      AND (x.ship_after_date IS NULL OR x.ship_after_date <= _today)
      AND coalesce(x.sold_at, x.confirmed_at, x.created_at) >= (_from::timestamp AT TIME ZONE 'Europe/Skopje')
      AND (coalesce(x.sold_at, x.confirmed_at, x.created_at) AT TIME ZONE 'Europe/Skopje')::date <= _today - (_days - 1)
  ), e AS (
    SELECT c.*, (_today - c.sday) AS age, ev.kind AS ekind, ev.ref AS eref
    FROM c
    LEFT JOIN LATERAL public.sale_collab_evidence(c.id, _days) ev ON true
    WHERE NOT (c.p8 = ANY (_excl))
  )
  SELECT e.id, e.display_id, e.customer_name, e.at, e.sday, e.age, e.price, e.sold_by_person_id, e.owner_id,
         CASE WHEN e.ekind LIKE 'in_collab%' THEN e.eref END,
         CASE WHEN e.ekind = 'needs_linking' THEN e.eref END,
         CASE WHEN e.ekind LIKE 'in_collab%'       THEN 'in_collab'
              WHEN e.ekind = 'needs_linking'       THEN 'needs_linking'
              WHEN e.ekind IN ('pushed', 'parcel') THEN 'pushed'
              WHEN e.ekind = 'postponed'           THEN 'postponed'
              WHEN e.age >= _days                  THEN 'cancel'
              ELSE 'warn' END,
         e.st, e.src, e.det, e.dept, e.ekind, e.eref,
         (e.sday < _today - _silent)
  FROM e
  ORDER BY e.at;
END;
$fn$;
COMMENT ON FUNCTION public.collab_entry_rule_plan(integer) IS
  'Owner 03.10.2026: every sale made outside collabBox (confirmed / shipped, no parcel, not collabBox-made, not web, not a disposition, not a test phone, sold since from_date) at least days − 1 Skopje days old, and what the collabBox entry rule does with each now: in_collab | needs_linking | pushed | postponed | warn (the evening before) | cancel; silent = older than silent_after_days (no bell). p_days overrides the setting (a read-only what-if). Migrations 20260947000200 / 1900.';

-- ── 7. the rule ─────────────────────────────────────────────────────────────
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
                                                             THEN (_cfg->>'days')::int END, 5)));
  _hour       integer := coalesce(CASE WHEN coalesce(_cfg->>'hour', '') ~ '^[0-9]{1,2}$' THEN (_cfg->>'hour')::int END, 21);
  _warn       boolean := coalesce((_cfg->>'warn')::boolean, true);
  _now_sk     timestamp := now() AT TIME ZONE 'Europe/Skopje';
  _today      date := (now() AT TIME ZONE 'Europe/Skopje')::date;
  _note       constant text := 'Нема внесено порачка во Collab';
  _code       text;
  _actor      text;
  _run        uuid;
  _cand       integer; _cancel integer; _towarn integer; _collab integer; _link integer; _pushed integer; _postp integer;
  _value      numeric;
  _done       integer := 0; _done_value numeric := 0; _warned integer := 0; _silent_done integer := 0;
BEGIN
  IF _mode NOT IN ('report', 'apply') THEN _mode := 'report'; END IF;
  _code  := 'not_in_collab_' || _days || 'd';
  _actor := 'Систем: правило collabBox ' || _days || ' дена';

  IF NOT p_force AND NOT p_dry_run THEN
    IF extract(hour FROM _now_sk)::int <> _hour THEN
      RETURN jsonb_build_object('ok', true, 'skipped', 'outside the ' || _hour || ':00 Skopje window');
    END IF;
    IF EXISTS (SELECT 1 FROM public.collab_entry_rule_runs r WHERE r.run_day = _today AND r.trigger_kind = 'cron') THEN
      RETURN jsonb_build_object('ok', true, 'skipped', 'already ran today');
    END IF;
  END IF;

  CREATE TEMP TABLE _cer ON COMMIT DROP AS SELECT * FROM public.collab_entry_rule_plan(_days);

  SELECT count(*),
         count(*) FILTER (WHERE plan_action = 'cancel'),
         count(*) FILTER (WHERE plan_action = 'warn'),
         count(*) FILTER (WHERE plan_action = 'in_collab'),
         count(*) FILTER (WHERE plan_action = 'needs_linking'),
         count(*) FILTER (WHERE plan_action = 'pushed'),
         count(*) FILTER (WHERE plan_action = 'postponed'),
         coalesce(sum(price_eur) FILTER (WHERE plan_action = 'cancel'), 0)
    INTO _cand, _cancel, _towarn, _collab, _link, _pushed, _postp, _value
  FROM _cer;

  IF p_dry_run THEN
    RETURN jsonb_build_object('ok', true, 'dry_run', true, 'mode', _mode, 'days', _days, 'candidates', _cand,
                              'to_cancel', _cancel,
                              'to_cancel_silent', (SELECT count(*) FROM _cer WHERE plan_action = 'cancel' AND silent),
                              'to_warn', _towarn, 'in_collab', _collab, 'needs_linking', _link, 'pushed', _pushed,
                              'postponed', _postp, 'value_eur', round(_value, 2));
  END IF;

  INSERT INTO public.collab_entry_rule_runs (run_day, mode, trigger_kind, days, candidates, to_cancel, to_warn,
                                             in_collab, needs_linking, pushed, postponed, value_eur, settings, scope)
  VALUES (_today, _mode, CASE WHEN p_force THEN 'manual' ELSE 'cron' END, _days, _cand, _cancel, _towarn,
          _collab, _link, _pushed, _postp, round(_value, 2), _cfg, coalesce(_cfg->>'scope', 'all'))
  RETURNING id INTO _run;

  INSERT INTO public.collab_entry_rule_items (run_id, order_id, display_id, action, sold_at, age_days, price_eur,
                                              sold_by_person_id, owner_user_id, evidence, status_before, sale_source,
                                              sale_source_detail, department, evidence_kind, silent, reason_code)
  SELECT _run, c.order_id, c.display_id, c.plan_action, c.sold_at, c.age_days, c.price_eur, c.sold_by_person_id,
         c.owner_user_id, left(c.evidence_ref, 200), c.status, c.sale_source, c.sale_source_detail, c.department,
         c.evidence_kind, c.silent, CASE WHEN c.plan_action = 'cancel' THEN _code END
  FROM _cer c;

  IF _mode = 'apply' THEN
    PERFORM set_config('elyon.keep_updated_at', 'on', true);   -- GET /call-agains reads updated_at
    PERFORM set_config('elyon.bulk_repair', 'on', true);

    IF _cancel > 0 THEN
      -- Status-guarded and re-checked: an order that moved, got a parcel or got its collabBox evidence since the scan
      -- is left alone.
      WITH upd AS (
        UPDATE public.orders o
           SET status = 'cancelled',
               cancellation_reason = 'other',
               cancellation_reason_notes = _note
          FROM _cer c
         WHERE c.plan_action = 'cancel'
           AND o.id = c.order_id
           AND o.status::text = c.status
           AND o.mex_tracking_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM public.sale_collab_evidence(o.id, _days) ev WHERE ev.kind IS NOT NULL)
        RETURNING o.id, c.display_id, c.customer_name, c.price_eur, c.sold_at, c.age_days, c.owner_user_id,
                  c.status AS was, c.silent
      ), hist AS (
        INSERT INTO public.order_history (order_id, from_status, to_status, changed_by, changed_by_name)
        SELECT u.id, u.was::public.order_status, 'cancelled'::public.order_status, NULL, _actor FROM upd u
        RETURNING order_id
      ), notes AS (
        INSERT INTO public.order_notes (order_id, text, author_id, author_name)
        SELECT u.id,
               'Откажана автоматски — ' || _note || ': продажбата од '
                 || to_char(u.sold_at AT TIME ZONE 'Europe/Skopje', 'DD.MM.YYYY') || ' не е внесена во collabBox '
                 || u.age_days || ' дена (правило ' || _days || ' дена). Ако подоцна се внесе во collabBox, '
                 || 'продажбата се брои кога MEX ќе ја создаде пратката.',
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
        WHERE u.owner_user_id IS NOT NULL AND NOT u.silent
        RETURNING id
      ), marked AS (
        UPDATE public.collab_entry_rule_items i SET action = 'cancelled'
          FROM upd u WHERE i.run_id = _run AND i.order_id = u.id AND i.action = 'cancel'
        RETURNING i.order_id
      )
      SELECT count(*), coalesce(sum(u.price_eur), 0), count(*) FILTER (WHERE u.silent)
        INTO _done, _done_value, _silent_done
        FROM upd u;

      UPDATE public.collab_entry_rule_items SET action = 'skipped' WHERE run_id = _run AND action = 'cancel';
    END IF;

    IF _warn AND _towarn > 0 THEN
      -- The evening before: one bell per order, never twice, never for a silent (old) sale.
      WITH w AS (
        SELECT c.* FROM _cer c
        WHERE c.plan_action = 'warn' AND c.owner_user_id IS NOT NULL AND NOT c.silent
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
                                  'customer', coalesce(w.customer_name, ''), 'hour', _hour || ':20', 'days', _days)
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
       SET cancelled = _done, cancelled_value_eur = round(_done_value, 2), warned = _warned,
           cancelled_silent = _silent_done
     WHERE id = _run;
    -- No audit_log row: it requires a human actor_id. The run + items ledger IS the audit trail.
  END IF;

  RETURN jsonb_build_object('ok', true, 'run_id', _run, 'mode', _mode, 'days', _days, 'candidates', _cand,
                            'to_cancel', _cancel, 'to_warn', _towarn, 'in_collab', _collab, 'needs_linking', _link,
                            'pushed', _pushed, 'postponed', _postp, 'value_eur', round(_value, 2),
                            'cancelled', _done, 'cancelled_silent', _silent_done, 'warned', _warned);
END;
$fn$;
COMMENT ON FUNCTION public.apply_collab_entry_rule(boolean, boolean) IS
  'Owner 03.10.2026: every sale made outside collabBox (collab_entry_rule_plan) with no MEX parcel and no evidence of a collabBox entry (sale_collab_evidence) `days` (5) Skopje days after its sale day is cancelled at 21:20 Skopje — reason other, note "Нема внесено порачка во Collab", code not_in_collab_<days>d in the ledger — and its seller gets a bell (not_in_collab; none when the sale is older than silent_after_days); the evening before a warning bell (not_in_collab_warning). report = ledger only. Migrations 20260947000200 / 1900.';

-- ── 8. undo a run ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.collab_entry_rule_undo(p_run uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _n integer := 0;
  _actor constant text := 'Систем: враќање на правилото collabBox';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.collab_entry_rule_runs r WHERE r.id = p_run) THEN
    RAISE EXCEPTION 'collab_entry_rule_undo: unknown run %', p_run USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('elyon.keep_updated_at', 'on', true);
  PERFORM set_config('elyon.bulk_repair', 'on', true);

  WITH upd AS (
    UPDATE public.orders o
       SET status = coalesce(i.status_before, 'confirmed')::public.order_status,
           cancellation_reason = NULL, cancellation_reason_notes = NULL, cancelled_at = NULL
      FROM public.collab_entry_rule_items i
     WHERE i.run_id = p_run AND i.action = 'cancelled' AND o.id = i.order_id
       AND o.status = 'cancelled' AND o.cancellation_reason = 'other'
       AND (coalesce(o.cancellation_reason_notes, '') = 'Нема внесено порачка во Collab'
            OR coalesce(o.cancellation_reason_notes, '') LIKE 'not_in_collab_%')
    RETURNING o.id, coalesce(i.status_before, 'confirmed') AS back_to
  ), hist AS (
    INSERT INTO public.order_history (order_id, from_status, to_status, changed_by, changed_by_name)
    SELECT u.id, 'cancelled'::public.order_status, u.back_to::public.order_status, NULL, _actor
    FROM upd u
    RETURNING order_id
  ), notes AS (
    INSERT INTO public.order_notes (order_id, text, author_id, author_name)
    SELECT u.id, 'Вратена: откажувањето „Нема внесено порачка во Collab“ е поништено.', NULL, _actor
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
  'Owner 02.10 / 03.10.2026: reverts the cancels of one collabBox entry-rule run — every order still cancelled by the rule (reason other + its note) goes back to the status it had (items.status_before), with history + a note; updated_at kept. Service role. Migrations 20260947000200 / 1900.';

-- ── 9. the /orders badge: every sale of the rule, the same evidence ─────────
CREATE OR REPLACE FUNCTION public.crm_sale_collab_states(p_ids uuid[])
RETURNS TABLE(order_id uuid, collab_doc text, sale_day date, cancel_day date, mode text, team_dept text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _cfg  jsonb := coalesce((SELECT s.value FROM public.app_settings s WHERE s.key = 'collab_entry_rule'), '{}'::jsonb);
  _days integer := greatest(1, least(30, coalesce(CASE WHEN coalesce(_cfg->>'days', '') ~ '^[0-9]{1,2}$'
                                                       THEN (_cfg->>'days')::int END, 5)));
  _mode text := CASE WHEN _cfg->>'mode' = 'apply' THEN 'apply' ELSE 'report' END;
BEGIN
  IF coalesce(array_length(p_ids, 1), 0) > 200 THEN
    RAISE EXCEPTION 'crm_sale_collab_states: at most 200 orders' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT x.id,
         CASE WHEN ev.kind LIKE 'in_collab%' THEN ev.ref END,
         (coalesce(x.sold_at, x.confirmed_at, x.created_at) AT TIME ZONE 'Europe/Skopje')::date,
         -- the day the rule cancels it — none while something else spares it (pushed / unlinked parcel / postponed)
         CASE WHEN ev.kind IS NULL
              THEN (coalesce(x.sold_at, x.confirmed_at, x.created_at) AT TIME ZONE 'Europe/Skopje')::date + _days END,
         _mode,
         public.order_dept_by_team(x.sale_source, x.sold_by_person_id, coalesce(x.sold_at, x.created_at))
  FROM public.orders x
  LEFT JOIN LATERAL public.sale_collab_evidence(x.id, _days) ev ON true
  WHERE x.id = ANY (p_ids)
    AND x.status IN ('confirmed', 'shipped')
    AND x.mex_tracking_id IS NULL
    AND coalesce(x.external_source, '') <> 'collabbox'
    AND coalesce(x.sale_source, '') <> 'web'
    AND coalesce(x.sale_source_detail, '') <> 'disposition'
    AND coalesce(x.price, 0) > 0;
END;
$fn$;
COMMENT ON FUNCTION public.crm_sale_collab_states(uuid[]) IS
  'Owner 02.10 / 03.10.2026: for the /orders badge — each sale of the collabBox entry rule among the ids (confirmed / shipped, no parcel, not collabBox-made, not web, not a disposition): its collabBox document (sale_collab_evidence in_collab*) or NULL, its sale day, the day the rule cancels it (NULL while it is spared: pushed / unlinked parcel / postponed), the rule''s mode, and team_dept = the department its seller''s team already decides. ≤ 200 ids. Migrations 20260947000200 / 0500 / 1900.';

DO $g$
BEGIN
  REVOKE ALL ON FUNCTION public.collab_name_words(text)                    FROM PUBLIC, anon, authenticated;
  REVOKE ALL ON FUNCTION public.collab_names_share_word(text, text)        FROM PUBLIC, anon, authenticated;
  REVOKE ALL ON FUNCTION public.sale_collab_amount_twin(uuid, integer)     FROM PUBLIC, anon, authenticated;
  REVOKE ALL ON FUNCTION public.sale_delivery_postponed_note(uuid)         FROM PUBLIC, anon, authenticated;
  REVOKE ALL ON FUNCTION public.sale_collab_evidence(uuid, integer)        FROM PUBLIC, anon, authenticated;
  REVOKE ALL ON FUNCTION public.collab_entry_rule_plan(integer)            FROM PUBLIC, anon, authenticated;
  REVOKE ALL ON FUNCTION public.apply_collab_entry_rule(boolean, boolean)  FROM PUBLIC, anon, authenticated;
  REVOKE ALL ON FUNCTION public.collab_entry_rule_undo(uuid)               FROM PUBLIC, anon, authenticated;
  REVOKE ALL ON FUNCTION public.crm_sale_collab_states(uuid[])             FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.collab_name_words(text)                   TO service_role;
  GRANT EXECUTE ON FUNCTION public.collab_names_share_word(text, text)       TO service_role;
  GRANT EXECUTE ON FUNCTION public.sale_collab_amount_twin(uuid, integer)    TO service_role;
  GRANT EXECUTE ON FUNCTION public.sale_delivery_postponed_note(uuid)        TO service_role;
  GRANT EXECUTE ON FUNCTION public.sale_collab_evidence(uuid, integer)       TO service_role;
  GRANT EXECUTE ON FUNCTION public.collab_entry_rule_plan(integer)           TO service_role;
  GRANT EXECUTE ON FUNCTION public.apply_collab_entry_rule(boolean, boolean) TO service_role;
  GRANT EXECUTE ON FUNCTION public.collab_entry_rule_undo(uuid)              TO service_role;
  GRANT EXECUTE ON FUNCTION public.crm_sale_collab_states(uuid[])            TO service_role;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    GRANT EXECUTE ON FUNCTION public.collab_name_words(text)                TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.collab_names_share_word(text, text)    TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.sale_collab_amount_twin(uuid, integer) TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.sale_delivery_postponed_note(uuid)     TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.sale_collab_evidence(uuid, integer)    TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.collab_entry_rule_plan(integer)        TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.crm_sale_collab_states(uuid[])         TO supabase_read_only_user;
  END IF;
END
$g$;

-- ── 10. the owner key: 5 days, every sale — the mode is NOT changed here ────
UPDATE public.app_settings
   SET value = coalesce(value, '{}'::jsonb)
               || jsonb_build_object('days', 5, 'silent_after_days', 14, 'postpone_days', 45, 'scope', 'all'),
       updated_at = now()
 WHERE key = 'collab_entry_rule';

-- The cron stays: hourly at :20 UTC, the function acts in the Skopje hour (21) — DST-proof.
DO $cron$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job j WHERE j.jobname = 'collab-entry-rule' AND j.schedule = '20 * * * *' AND j.active) THEN
    PERFORM cron.unschedule(j.jobid) FROM cron.job j WHERE j.jobname = 'collab-entry-rule';
    PERFORM cron.schedule('collab-entry-rule', '20 * * * *', 'SELECT public.apply_collab_entry_rule();');
  END IF;
END
$cron$;

COMMIT;
