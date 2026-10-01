-- ============================================================================
-- collabBox: a sale counts on the day the operator BOOKED it (owner, 01.10.2026)
--
--   "Денот кога операторот ја внел, т.е јас денес ако потврдам нарачка ми се брои за денес, а дали
--    достава ќе биде после 5 дена тоа не е проблем, тоа само ќе ја валидира порачката, или ќе ја
--    направи return ако не ја земе клиентот, но на leaderboard и секаде Live, мора да покажува колку
--    денес има потврдено секаде и тие се информациите што не интерсират."
--
-- collabBox's document date (Datum → collabbox_documents.doc_at) is the DISPATCH day: it keeps the
-- booking's clock time but carries the day the parcel is sent (002-9102-177916/2026 reads 01.10 10:30
-- yet sits between 177909 at 30.09 10:08 and 177920 at 30.09 11:19 — booked 30.09 10:30). Until now
-- every collabBox sale counted on its dispatch day, and a booking dated ahead was not even read (the
-- frequent pass read yesterday + today by DOCUMENT date): on 01.10, 64 bookings dated 02–09.10
-- (144.410 ден) were invisible.
--
-- This migration (the ledger + the writer; the readers follow in 20260944000600):
--   1. collabbox_documents.booked_at + booked_at_basis ('seen' · 'sequence' · 'doc') — WHEN the
--      operator booked the document, never after doc_at. Decided once, at the first sighting
--      (write-once; the backfill script may re-decide 'sequence' / 'doc' rows under
--      elyon.collabbox_booked_at_backfill), by public.collabbox_estimate_booked_at():
--        'seen'      a full pass that had read the document's day (or the ahead range holding it)
--                    finished before the pass that first saw it and started < 23 h before: booked in
--                    between → its clock time on the latest day ≤ the sighting (exact across midnight)
--        'sequence'  DocNumbers are allocated in booking order per series: the 3rd smallest
--                    LEAST(doc_at, first_seen_at) of the next 20 numbers (+ 60 min) bounds it → its
--                    clock time on the latest day ≤ that bound (robust to a document dated a day back)
--        'doc'       nothing better → doc_at. Never more than 31 days before doc_at.
--      TWIN: scripts/lib/collabbox-booking-day.mjs (constants checked by bookingDay.test.ts).
--   2. collabbox_sync_runs.ahead_to — the ahead range a pass READ (collabbox-sync ahead_days): the
--      frequent pass now also reads the documents dated tomorrow … today + 14 (ONE header search +
--      ONE line-items request), so a booking is seen within 15 minutes whatever its dispatch day.
--   3. public.collabbox_sale_at(doc_at, booked_at) — THE sale time of a collabBox document: its
--      booking, from public.collabbox_booking_day_since() on (01.10.2026 00:00 Skopje — the owner's
--      default: closed months never move, nothing moves INTO September), else doc_at. Every reader
--      calls it: the writer (orders.sold_at / confirmed_at / created_at, the seller credit), the
--      leaderboard's bookings, the cohort's booking rows (20260944000600).
--   4. collabbox_apply_one — the order a document becomes carries sold_at = confirmed_at = created_at
--      = its sale time; collabbox_credit_order is called with it (its closed-month rule unchanged);
--      the ledger row gets booked_at at its first sighting. Five exact edits of the LIVE body.
--   5. collabbox_booked_today — the day's bookings by sale time (the leaderboard's copy of the filter
--      follows in 20260944000600). collabbox_feed_state — data_through = the newest document dated
--      up to now (the ahead range would show next week). invoke_collabbox_sync — the frequent pass
--      sends ahead_days 14.
--
-- History is NOT touched here: rows already in the ledger keep booked_at NULL (= doc_at for every
-- reader) until scripts/backfill-collabbox-booked-at.mjs (dry run → owner OK → --apply).
-- Apply ORDER: this migration → 20260944000600 → deploy collabbox-sync → the backfill's dry run.
-- The function must not be deployed before this migration (its run row writes ahead_to; it falls back
-- without it, but reads nothing ahead until the cron sends ahead_days). Revert: re-apply the previous
-- bodies (git) — the columns may stay (NULL-tolerant everywhere).
-- Every replaced body is the LIVE one (pg_get_functiondef, 01.10.2026) with counted, exact edits; the
-- drift guard refuses if any changed since.
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '10s';

DO $drift$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(e.sig, ', ' ORDER BY e.sig) INTO v_bad
  FROM (VALUES
    ('public.collabbox_apply_one(uuid,jsonb,boolean)', '06be589bb5b88ce80ae822d1e4770a2b', '199afc20f05b9f5ce023a7778c664323'),
    ('public.collabbox_booked_today(date)', '9ce2dd4c19f9e11671b801197441dd11', '9ef16fc9da955775c331e5fa23c19f5a'),
    ('public.collabbox_feed_state()', '7890e27f95dd7fb98456771fc9832700', 'b30a8ad01c36f301fb79a185e592d57a'),
    ('public.invoke_collabbox_sync(text)', '7c541b3499dafe5c335b4099c86f6ecd', '40973037fa7a16b5e03826561a275488')
  ) e(sig, old_md5, new_md5)
  LEFT JOIN pg_proc p ON p.oid = to_regprocedure(e.sig)
  WHERE p.oid IS NULL OR md5(replace(p.prosrc, chr(13), '')) NOT IN (e.old_md5, e.new_md5);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'collabBox booking day: % changed since this migration was written — re-emit it from the live body', v_bad;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'orders'
                   AND column_name = 'mex_sent_at') THEN
    RAISE EXCEPTION 'collabBox booking day: orders.mex_sent_at is missing — apply 20260943001200 first';
  END IF;
END
$drift$;

-- ── 1. the booking time on the ledger, the ahead range on the run ───────────
ALTER TABLE public.collabbox_documents
  ADD COLUMN IF NOT EXISTS booked_at       timestamptz,
  ADD COLUMN IF NOT EXISTS booked_at_basis text;

DO $c$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'collabbox_documents_booked_at_basis_check') THEN
    ALTER TABLE public.collabbox_documents
      ADD CONSTRAINT collabbox_documents_booked_at_basis_check
      CHECK (booked_at_basis IS NULL OR booked_at_basis IN ('seen', 'sequence', 'doc'));
  END IF;
END
$c$;

COMMENT ON COLUMN public.collabbox_documents.booked_at IS
  'When the operator BOOKED the document (owner 01.10.2026: a sale counts on that day) — never after doc_at, which is the DISPATCH day with the booking''s clock time. Decided at the first sighting by collabbox_estimate_booked_at() (write-once; scripts/backfill-collabbox-booked-at.mjs fills history). NULL = not decided yet (read as doc_at). The sale time every reader uses is collabbox_sale_at(doc_at, booked_at). Migration 20260944000500.';
COMMENT ON COLUMN public.collabbox_documents.booked_at_basis IS
  'How booked_at was decided: seen (a full pass that had read its day missed it, the next one saw it — exact) · sequence (estimated from the per-series DocNumber order) · doc (= doc_at, nothing better). Migration 20260944000500.';

ALTER TABLE public.collabbox_sync_runs ADD COLUMN IF NOT EXISTS ahead_to date;
COMMENT ON COLUMN public.collabbox_sync_runs.ahead_to IS
  'The last day of the AHEAD range this pass read (documents dated after its window: booked already, dispatched later — collabbox-sync ahead_days). NULL = none. A booking dated in (window_to, ahead_to] that this pass did not find was booked after it (collabbox_estimate_booked_at, basis seen). Migration 20260944000500.';

-- ── 2. the DocNumber sequence: NNN-SSSS-n/yyyy → (NNN-SSSS/yyyy, n) ────────
CREATE OR REPLACE FUNCTION public.collabbox_doc_seq_key(p_doc text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $fn$
  SELECT CASE WHEN p_doc ~ '^[0-9]{3}-[0-9]{4}-[0-9]{1,15}/[0-9]{4}$'
              THEN split_part(p_doc, '-', 1) || '-' || split_part(p_doc, '-', 2) || '/' || split_part(p_doc, '/', 2) END;
$fn$;

CREATE OR REPLACE FUNCTION public.collabbox_doc_seq_no(p_doc text)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $fn$
  SELECT CASE WHEN p_doc ~ '^[0-9]{3}-[0-9]{4}-[0-9]{1,15}/[0-9]{4}$'
              THEN split_part(split_part(p_doc, '-', 3), '/', 1)::bigint END;
$fn$;

COMMENT ON FUNCTION public.collabbox_doc_seq_key(text) IS
  'collabBox DocNumber → its numbering sequence (prefix-series/year), NULL for any other shape. The numbers of a sequence are allocated in BOOKING order. Migration 20260944000500.';
COMMENT ON FUNCTION public.collabbox_doc_seq_no(text) IS
  'collabBox DocNumber → its number inside the sequence (collabbox_doc_seq_key), NULL for any other shape. Migration 20260944000500.';

CREATE INDEX IF NOT EXISTS idx_collabbox_documents_seq
  ON public.collabbox_documents (public.collabbox_doc_seq_key(doc_number), public.collabbox_doc_seq_no(doc_number));

-- ── 3. the booking time ─────────────────────────────────────────────────────
-- The latest instant ≤ p_bound whose Skopje wall clock equals p_like's (DST-exact: the local day
-- + the clock, read as Europe/Skopje). TWIN: projectClockBelow (collabbox-booking-day.mjs).
CREATE OR REPLACE FUNCTION public.collabbox_clock_below(p_like timestamptz, p_bound timestamptz)
RETURNS timestamptz
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $fn$
  SELECT c.t
    FROM (VALUES (0), (1), (2)) k(n)
   CROSS JOIN LATERAL (
     SELECT ((((p_bound AT TIME ZONE 'Europe/Skopje')::date - k.n) + (p_like AT TIME ZONE 'Europe/Skopje')::time)
             AT TIME ZONE 'Europe/Skopje') AS t) c
   WHERE p_like IS NOT NULL AND p_bound IS NOT NULL AND c.t <= p_bound
   ORDER BY k.n
   LIMIT 1;
$fn$;

-- WHEN was a document booked? → (booked_at, basis). p_seen_at = its first sighting (the ledger's
-- first_seen_at; now() for a document not in the ledger yet), p_first_run = the pass that saw it
-- (never counts as the watching pass). TWIN: estimateBookedAt (collabbox-booking-day.mjs) — the
-- constants below are checked against it by supabase/functions/collabbox-sync/bookingDay.test.ts.
CREATE OR REPLACE FUNCTION public.collabbox_estimate_booked_at(
  p_doc       text,
  p_doc_at    timestamptz,
  p_seen_at   timestamptz,
  p_first_run uuid)
RETURNS TABLE (booked_at timestamptz, basis text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  c_seq_next  CONSTANT integer  := 20;                    -- SEQ_NEXT
  c_seq_rank  CONSTANT integer  := 3;                     -- SEQ_RANK
  c_seq_tol   CONSTANT interval := interval '60 minutes'; -- SEQ_TOL_S
  c_watch     CONSTANT interval := interval '23 hours';   -- WATCH_MAX_S
  c_seen_tol  CONSTANT interval := interval '30 minutes'; -- SEEN_TOL_S
  c_max_back  CONSTANT interval := interval '31 days';    -- MAX_BACK_DAYS
  _day   date;
  _key   text := public.collabbox_doc_seq_key(btrim(coalesce(p_doc, '')));
  _no    bigint := public.collabbox_doc_seq_no(btrim(coalesce(p_doc, '')));
  _w     timestamptz;
  _t     timestamptz;
  _bound timestamptz;
BEGIN
  IF p_doc_at IS NULL THEN
    RETURN;
  END IF;
  _day := (p_doc_at AT TIME ZONE 'Europe/Skopje')::date;

  -- 'seen': the latest pass that had read this day (its window, or its ahead range) and finished
  -- before the sighting without finding the document — booked between that pass and the sighting
  IF p_seen_at IS NOT NULL THEN
    SELECT max(r.started_at) INTO _w
      FROM public.collabbox_sync_runs r
     WHERE r.status = 'ok' AND r.kind IN ('manual', 'nightly')   -- a full pass (the live mode read 5 types)
       AND r.finished_at IS NOT NULL AND r.finished_at < p_seen_at
       AND r.started_at >= p_seen_at - c_watch
       AND r.id IS DISTINCT FROM p_first_run
       AND ((_day BETWEEN r.window_from AND r.window_to)
            OR (r.ahead_to IS NOT NULL AND _day > r.window_to AND _day <= r.ahead_to));
    IF _w IS NOT NULL THEN
      _t := public.collabbox_clock_below(p_doc_at, p_seen_at);
      IF _t IS NULL OR _t < _w - c_seen_tol THEN
        _t := least(p_doc_at, p_seen_at);     -- the clock does not fit the gap: the sighting bounds it
      END IF;
      IF _t >= p_doc_at THEN
        booked_at := p_doc_at; basis := 'seen';
      ELSIF p_doc_at - _t > c_max_back THEN
        booked_at := p_doc_at; basis := 'doc';
      ELSE
        booked_at := _t; basis := 'seen';
      END IF;
      RETURN NEXT;
      RETURN;
    END IF;
  END IF;

  -- 'sequence': the 3rd smallest LEAST(doc_at, first_seen_at) of the next 20 numbers of the series
  IF _key IS NOT NULL THEN
    SELECT x.v INTO _bound
      FROM (SELECT least(m.doc_at, m.first_seen_at) AS v
              FROM public.collabbox_documents m
             WHERE public.collabbox_doc_seq_key(m.doc_number) = _key
               AND public.collabbox_doc_seq_no(m.doc_number) > _no
             ORDER BY public.collabbox_doc_seq_no(m.doc_number), m.doc_number
             LIMIT c_seq_next) x
     ORDER BY x.v
    OFFSET c_seq_rank - 1
     LIMIT 1;
  END IF;
  IF p_seen_at IS NOT NULL THEN
    _bound := least(coalesce(_bound, p_seen_at), p_seen_at);   -- its own sighting bounds it too
  END IF;
  IF _bound IS NULL OR _bound + c_seq_tol >= p_doc_at THEN
    booked_at := p_doc_at; basis := 'doc';
    RETURN NEXT;
    RETURN;
  END IF;
  _t := public.collabbox_clock_below(p_doc_at, _bound + c_seq_tol);
  IF _t IS NULL OR _t >= p_doc_at OR p_doc_at - _t > c_max_back THEN
    booked_at := p_doc_at; basis := 'doc';
  ELSE
    booked_at := _t; basis := 'sequence';
  END IF;
  RETURN NEXT;
END;
$fn$;

COMMENT ON FUNCTION public.collabbox_estimate_booked_at(text, timestamptz, timestamptz, uuid) IS
  'collabBox: when was this document BOOKED → (booked_at, basis seen · sequence · doc), never after doc_at (the dispatch day with the booking''s clock time). seen = a full pass that had read its day finished before the sighting (< 23 h) → its clock on the latest day ≤ the sighting; sequence = the 3rd smallest LEAST(doc_at, first_seen_at) of the next 20 DocNumbers of the series + 60 min bounds it; doc = doc_at. TWIN scripts/lib/collabbox-booking-day.mjs. Migration 20260944000500.';

-- The owner's closed-month rule (default, 01.10.2026): a sale moves to its booking day only from
-- 01.10.2026 00:00 Skopje on — nothing moves inside or into September. Answering "September too"
-- = a one-line re-definition here + the backfill's --apply.
CREATE OR REPLACE FUNCTION public.collabbox_booking_day_since()
RETURNS timestamptz
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $fn$
  SELECT timestamptz '2026-10-01 00:00:00+02';
$fn$;

COMMENT ON FUNCTION public.collabbox_booking_day_since() IS
  'From when a collabBox sale counts on its BOOKING day (collabbox_sale_at): 01.10.2026 00:00 Skopje — closed months never move (owner default, 01.10.2026). Migration 20260944000500.';

-- THE sale time of a collabBox document: its booking (from collabbox_booking_day_since() on), else
-- its document date. TWIN: saleAt (collabbox-booking-day.mjs).
CREATE OR REPLACE FUNCTION public.collabbox_sale_at(p_doc_at timestamptz, p_booked_at timestamptz)
RETURNS timestamptz
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $fn$
  SELECT CASE WHEN p_booked_at IS NOT NULL AND p_booked_at < p_doc_at
                   AND p_booked_at >= public.collabbox_booking_day_since()
              THEN p_booked_at ELSE p_doc_at END;
$fn$;

COMMENT ON FUNCTION public.collabbox_sale_at(timestamptz, timestamptz) IS
  'THE sale time of a collabBox document (owner 01.10.2026: the day the operator booked it): booked_at when it is earlier than doc_at and on/after collabbox_booking_day_since(), else doc_at. Read by the writer, collabbox_booked_today, leaderboard_day_v2, insights_sale_rows, insights_work. Migration 20260944000500.';

-- ── 4. the ledger decides booked_at at the first sighting, write-once ───────
CREATE OR REPLACE FUNCTION public.tg_collabbox_documents_booked_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _b timestamptz;
  _k text;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.booked_at IS NOT NULL
     AND (NEW.booked_at IS DISTINCT FROM OLD.booked_at OR NEW.booked_at_basis IS DISTINCT FROM OLD.booked_at_basis)
     AND coalesce(current_setting('elyon.collabbox_booked_at_backfill', true), '') <> 'on' THEN
    NEW.booked_at := OLD.booked_at;               -- write-once (the backfill script re-decides under its GUC)
    NEW.booked_at_basis := OLD.booked_at_basis;
  END IF;
  IF TG_OP = 'INSERT' AND NEW.booked_at IS NULL AND NEW.doc_at IS NOT NULL THEN
    SELECT e.booked_at, e.basis INTO _b, _k
      FROM public.collabbox_estimate_booked_at(NEW.doc_number, NEW.doc_at, NEW.first_seen_at, NEW.first_run_id) e;
    NEW.booked_at := _b;
    NEW.booked_at_basis := _k;
  END IF;
  IF NEW.booked_at IS NOT NULL AND NEW.doc_at IS NOT NULL AND NEW.booked_at > NEW.doc_at THEN
    NEW.booked_at := NEW.doc_at;                  -- never after the document's own date (moved earlier)
    NEW.booked_at_basis := 'doc';
  END IF;
  IF NEW.booked_at IS NOT NULL AND NEW.booked_at_basis IS NULL THEN
    NEW.booked_at_basis := 'doc';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_collabbox_documents_booked_at ON public.collabbox_documents;
CREATE TRIGGER trg_collabbox_documents_booked_at
  BEFORE INSERT OR UPDATE OF booked_at, booked_at_basis, doc_at ON public.collabbox_documents
  FOR EACH ROW EXECUTE FUNCTION public.tg_collabbox_documents_booked_at();

COMMENT ON FUNCTION public.tg_collabbox_documents_booked_at() IS
  'collabbox_documents: booked_at is decided at the first sighting (collabbox_estimate_booked_at, when the writer did not pass it), write-once (elyon.collabbox_booked_at_backfill = on lets the backfill re-decide), never after doc_at. Migration 20260944000500.';

-- ── 5. the writer: an order's sale time is its booking ──────────────────────
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
  _booked     timestamptz;                -- when the operator BOOKED it (collabbox_documents.booked_at)
  _bbasis     text;
  _sale_at    timestamptz;                -- THE sale time: collabbox_sale_at(doc_at, booked_at) — 20260944000500
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

  -- the BOOKING time (owner 01.10.2026: a sale counts on the day the operator booked it; doc_at is the
  -- dispatch day). A known document keeps what its first sighting decided (a row from before
  -- 20260944000500 reads as doc_at until the backfill); a new one is decided now.
  IF _has_prev THEN
    _booked := least(coalesce(_prev.booked_at, _doc_at), _doc_at);
    _bbasis := CASE WHEN _prev.booked_at IS NOT NULL THEN _prev.booked_at_basis END;
  ELSE
    SELECT e.booked_at, e.basis INTO _booked, _bbasis
      FROM public.collabbox_estimate_booked_at(_doc, _doc_at, now(), p_run) e;
  END IF;
  _booked := coalesce(_booked, _doc_at);
  _sale_at := public.collabbox_sale_at(_doc_at, _booked);

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
        _credit := public.collabbox_credit_order(_o.id, _doc, _sale_at, _author, p_dry);
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
      _credit := public.collabbox_credit_order(_holder, _doc, _sale_at, _author, p_dry);
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
        _credit := public.collabbox_credit_order(_holder, _doc, _sale_at, _author, p_dry);
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
                _sale_at, _sale_at,                       -- created / confirmed = the booking (20260944000500)
                CASE WHEN _ext IS NOT NULL THEN _sale_at END,
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
           first_run_id, run_id, first_seen_at, last_seen_at, vanished_at, payload, updated_at,
           booked_at, booked_at_basis)
    VALUES (_doc, nullif(btrim(p_doc ->> 'doc_id'), ''), nullif(btrim(p_doc ->> 'object_id'), ''), _type,
            nullif(btrim(p_doc ->> 'type_name'), ''), _role, _doc_at, _kom, _kname,
            _author, _person, _amount, CASE WHEN _role <> 'record' OR _nlines > 0 THEN _goods END, _delivery,
            CASE WHEN _outcome IN ('created', 'updated') THEN _price END, _nlines, _complete,
            _unmapped, _storno, CASE WHEN _storno THEN _orig END, nullif(btrim(p_doc ->> 'reversed_by'), ''),
            _p8, _psrc, _phone, _outcome, _reason, _dept,
            CASE WHEN _outcome = 'created' THEN _status END, CASE WHEN _outcome = 'created' THEN _basis END,
            CASE WHEN _has_p THEN _p.status_id END, CASE WHEN _has_p THEN _p.cod_mkd END,
            _order_id, _related, _created, CASE WHEN _created THEN p_run END, _credit,
            coalesce(_flags, '{}'::text[]), 1, p_run, p_run, now(), now(), NULL, p_doc, now(),
            _booked, _bbasis)                     -- decided once: ON CONFLICT never rewrites it
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
    'booked_at', _booked, 'booked_at_basis', _bbasis, 'sale_at', _sale_at,
    'flags', to_jsonb(coalesce(_flags, '{}'::text[])));
END;
$function$;

-- ── 6. the leaderboard's bookings of a day: by sale time ────────────────────
CREATE OR REPLACE FUNCTION public.collabbox_booked_today(p_day date DEFAULT NULL::date)
 RETURNS TABLE(author text, person_id uuid, doc_type text, docs integer, value_mkd numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH d AS (SELECT coalesce(p_day, (now() AT TIME ZONE 'Europe/Skopje')::date) AS day)
  SELECT b.author, b.author_person_id, b.doc_type_id, count(*)::integer, coalesce(sum(b.amount_mkd), 0)
    FROM public.collabbox_documents b, d
   -- the day the operator BOOKED it (collabbox_sale_at, 20260944000500); never after doc_at
   WHERE b.doc_at >= (d.day::timestamp AT TIME ZONE 'Europe/Skopje')
     AND public.collabbox_sale_at(b.doc_at, b.booked_at) >= (d.day::timestamp AT TIME ZONE 'Europe/Skopje')
     AND public.collabbox_sale_at(b.doc_at, b.booked_at) <  ((d.day + 1)::timestamp AT TIME ZONE 'Europe/Skopje')
     -- booked by the live mode today, or processed by the nightly run and still waiting for its
     -- parcel (main session 29.09: order-type documents wait for the parcel instead of a to-pack order)
     AND b.outcome IN ('booked', 'awaiting_parcel')
     AND b.vanished_at IS NULL
     AND NOT b.is_storno
     AND b.amount_mkd > 0
     AND b.doc_type_id IN ('10036', '10050', '10111', '10114', '10106')
     AND NOT EXISTS (SELECT 1 FROM public.orders o
                      WHERE o.external_source = 'collabbox' AND o.external_order_id = b.doc_number)
     AND NOT EXISTS (SELECT 1 FROM public.orders o WHERE o.mex_tracking_id = b.doc_number)
     AND NOT EXISTS (SELECT 1 FROM public.mex_parcels p
                      WHERE p.tracking_id = b.doc_number AND p.order_id IS NOT NULL)
   GROUP BY b.author, b.author_person_id, b.doc_type_id
   ORDER BY count(*) DESC, b.author;
$function$;

COMMENT ON FUNCTION public.collabbox_booked_today(date) IS
  'The leaderboard''s collabBox bookings of a Skopje day (default today): per author / person / type, the count and денари of documents BOOKED that day (collabbox_sale_at — owner 01.10.2026; dispatch day before 01.10.2026) that are still waiting (booked / awaiting_parcel) and that no order holds yet (external ref, tracking id or linked parcel). Types 10036 · 10050 · 10111 · 10114 · 10106. Migrations 20260942000900, 20260944000500.';

-- ── 7. freshness: the newest document dated up to now ──────────────────────
CREATE OR REPLACE FUNCTION public.collabbox_feed_state()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
WITH runs AS (
  SELECT r.* FROM public.collabbox_sync_runs r WHERE r.kind IN ('nightly', 'manual')
),
last_ok AS (
  SELECT max(r.finished_at) AS t FROM runs r WHERE r.status = 'ok'
),
last_settled AS (
  SELECT r.status, r.error
    FROM runs r
   WHERE r.status <> 'running' OR r.started_at < now() - interval '20 minutes'
   ORDER BY r.started_at DESC
   LIMIT 1
),
last_fail AS (
  SELECT coalesce(r.error, 'killed (never finished)') AS error, coalesce(r.finished_at, r.started_at) AS t
    FROM runs r
   WHERE r.status = 'failed' OR (r.status = 'running' AND r.started_at < now() - interval '20 minutes')
   ORDER BY r.started_at DESC
   LIMIT 1
),
agg AS (
  SELECT max(r.started_at) AS last_run_at,
         count(*) FILTER (WHERE r.started_at > now() - interval '24 hours') AS runs_24h,
         count(*) FILTER (WHERE r.started_at > now() - interval '24 hours' AND r.status = 'failed') AS failed_24h,
         count(*) AS runs_all
    FROM runs r
),
live AS (
  SELECT max(r.finished_at) FILTER (WHERE r.status = 'ok') AS last_ok
    FROM public.collabbox_sync_runs r WHERE r.kind = 'live'
),
booked AS (
  SELECT count(*) AS n
    FROM public.collabbox_documents d
   WHERE d.outcome = 'booked' AND d.vanished_at IS NULL
     AND d.doc_at >= (((now() AT TIME ZONE 'Europe/Skopje')::date)::timestamp AT TIME ZONE 'Europe/Skopje')
),
docs AS (
  -- dated up to now: a booking dated ahead (dispatched later, read since 20260944000500) is not "newest"
  SELECT max(d.doc_at) AS t FROM public.collabbox_documents d WHERE d.vanished_at IS NULL AND d.doc_at <= now()
),
legacy AS (
  SELECT max(o.created_at) AS last_doc FROM public.orders o WHERE o.sale_source = 'collabbox'
),
-- the run that should already have finished (20260942001300: every 15 min 07:00–22:59 Skopje, a
-- full pass of yesterday + today; the nightly 00:00 re-reads the last 3 days): in the working day
-- "now"; late evening the 22:45 run; after midnight the nightly 00:00 run
ex AS (
  SELECT CASE WHEN z.l::time >= time '07:30' AND z.l::time < time '23:15' THEN now()
              WHEN z.l::time >= time '23:15' THEN (z.l::date + time '22:45') AT TIME ZONE 'Europe/Skopje'
              WHEN z.l::time <  time '00:45' THEN ((z.l::date - 1) + time '22:45') AT TIME ZONE 'Europe/Skopje'
              ELSE (z.l::date + time '00:00') AT TIME ZONE 'Europe/Skopje' END AS expected
    FROM (SELECT now() AT TIME ZONE 'Europe/Skopje' AS l) z
),
lag AS (
  SELECT count(*) AS n
    FROM public.mex_parcels p
   WHERE p.account = 'natura'
     AND p.series IN ('9100', '9102', '9108')
     AND coalesce(p.cod_mkd, 0) > 0
     AND p.created_at_mex < now() - interval '48 hours'
     AND p.order_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.web_orders w
                      WHERE w.mex_tracking_id = p.tracking_id AND w.deleted_in_shop_at IS NULL)
     AND NOT EXISTS (SELECT 1 FROM public.collabbox_documents d WHERE d.doc_number = p.tracking_id)
),
-- orders THIS sync created to pack that still have no parcel a week later: nothing cancels them
-- (the 10-day rule covers AlterCPA only) — they are counted here so they stay visible
stale AS (
  SELECT count(*) AS n
    FROM public.collabbox_documents d
    JOIN public.orders o ON o.id = d.order_id
   WHERE d.created_by_sync
     AND o.status = 'confirmed'
     AND o.mex_status_id IS NULL
     AND d.doc_at < now() - interval '7 days'
)
SELECT CASE
  WHEN a.runs_all = 0 THEN
    jsonb_build_object(
      'feed', 'collabbox',
      'last_ok_at', lg.last_doc,
      'status', CASE WHEN lg.last_doc IS NULL THEN 'n/a'
                     WHEN lg.last_doc < now() - interval '7 days' THEN 'stale'
                     ELSE 'ok' END,
      'detail', 'manual import; newest document '
                || coalesce(to_char(lg.last_doc AT TIME ZONE 'Europe/Skopje', 'DD.MM.YYYY'), '-')
                || '; ' || lag.n || ' NATURA parcels not imported (the nightly sync has not run yet)',
      'data_through', lg.last_doc,
      'lag_parcels', lag.n,
      'last_run_at', NULL, 'last_error', NULL, 'last_error_at', NULL,
      'runs_24h', 0, 'failed_24h', 0,
      'live_last_ok_at', lv.last_ok, 'booked_today', bk.n, 'stale_to_pack', st.n)
  ELSE
    jsonb_build_object(
      'feed', 'collabbox',
      'last_ok_at', lo.t,
      'status', CASE WHEN ls.status IN ('failed', 'running') THEN 'failed'
                     WHEN lo.t IS NULL OR lo.t < ex.expected - interval '45 minutes' THEN 'stale'
                     ELSE 'ok' END,
      'detail', 'full sync every 15 min 07:00-22:59 (yesterday + today) + nightly 00:00 (last 3 days); last ok '
                || coalesce(to_char(lo.t AT TIME ZONE 'Europe/Skopje', 'DD.MM.YYYY HH24:MI'), 'never')
                || '; documents through '
                || coalesce(to_char(dc.t AT TIME ZONE 'Europe/Skopje', 'DD.MM.YYYY HH24:MI'), '-')
                || '; ' || lag.n || ' NATURA parcels without a document'
                || CASE WHEN st.n > 0 THEN '; ' || st.n || ' synced orders still to pack after 7 days' ELSE '' END
                || CASE WHEN ls.status IN ('failed', 'running')
                        THEN '; last run failed: ' || coalesce(left(ls.error, 200), 'killed (never finished)')
                        ELSE '' END,
      'data_through', dc.t,
      'lag_parcels', lag.n,
      'last_run_at', a.last_run_at,
      'last_error', lf.error,
      'last_error_at', lf.t,
      'runs_24h', a.runs_24h,
      'failed_24h', a.failed_24h,
      'live_last_ok_at', lv.last_ok,
      'booked_today', bk.n,
      'stale_to_pack', st.n)
  END
  FROM agg a
  CROSS JOIN last_ok lo
  CROSS JOIN docs dc
  CROSS JOIN legacy lg
  CROSS JOIN lag
  CROSS JOIN live lv
  CROSS JOIN booked bk
  CROSS JOIN stale st
  CROSS JOIN ex
  LEFT JOIN last_settled ls ON true
  LEFT JOIN last_fail lf ON true;
$function$;

-- ── 8. the frequent pass also reads the next 14 days ───────────────────────
CREATE OR REPLACE FUNCTION public.invoke_collabbox_sync(_mode text DEFAULT 'nightly'::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _secret text;
  _local  timestamp := now() AT TIME ZONE 'Europe/Skopje';
  _body   jsonb;
BEGIN
  IF _mode = 'nightly' THEN
    IF extract(hour FROM _local) <> 0 THEN
      RETURN;
    END IF;
    IF EXISTS (SELECT 1 FROM public.collabbox_sync_runs r
                WHERE r.kind = 'nightly' AND r.run_day = _local::date) THEN
      RETURN;
    END IF;
    _body := jsonb_build_object('mode', 'nightly', 'trigger', 'cron');
  ELSIF _mode = 'frequent' THEN
    -- 07:00–22:59 Skopje: yesterday + today in full (20260942001300) + the documents DATED the next
    -- 14 days, which are booked already (one header search + one line-items request; 20260944000500)
    IF _local::time < time '07:00' OR _local::time >= time '23:00' THEN
      RETURN;
    END IF;
    _body := jsonb_build_object('mode', 'manual', 'trigger', 'cron',
                                'from', to_char(_local::date - 1, 'YYYY-MM-DD'),
                                'to',   to_char(_local::date, 'YYYY-MM-DD'),
                                'ahead_days', 14);
  ELSIF _mode = 'live' THEN
    IF _local::time < time '08:00' OR _local::time >= time '20:15' THEN
      RETURN;
    END IF;
    _body := jsonb_build_object('mode', 'live', 'trigger', 'cron');
  ELSE
    RETURN;
  END IF;

  SELECT decrypted_secret INTO _secret
    FROM vault.decrypted_secrets
   WHERE name = 'collabbox_sync_secret';
  IF _secret IS NULL THEN
    RETURN;  -- vault not configured yet → no-op
  END IF;

  PERFORM net.http_post(
    url := 'https://bmfxhgznttcnnlqloqzp.supabase.co/functions/v1/collabbox-sync',
    headers := jsonb_build_object(
      'x-collabbox-sync-secret', _secret,
      'Content-Type', 'application/json'
    ),
    body := _body,
    timeout_milliseconds := 60000
  );
EXCEPTION WHEN OTHERS THEN
  RETURN;  -- the scheduler must never error the cron job
END;
$function$;

COMMENT ON FUNCTION public.invoke_collabbox_sync(text) IS
  'pg_cron → collabbox-sync: nightly (00:00 Skopje, last 3 days) · frequent (every 15 min 07:00–22:59 Skopje, yesterday + today in full + the documents dated the next 14 days, ahead_days — 20260944000500) · live (headers only — retired from the schedule by 20260942001300, kept callable). No-op until the vault secret collabbox_sync_secret exists. Migrations 20260942000900, 20260942001300, 20260944000500.';

-- ── 9. grants ───────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.collabbox_estimate_booked_at(text, timestamptz, timestamptz, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tg_collabbox_documents_booked_at()                                 FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.collabbox_estimate_booked_at(text, timestamptz, timestamptz, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.collabbox_doc_seq_key(text)                     TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.collabbox_doc_seq_no(text)                      TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.collabbox_clock_below(timestamptz, timestamptz) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.collabbox_booking_day_since()                   TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.collabbox_sale_at(timestamptz, timestamptz)     TO authenticated, service_role;
-- collabbox_apply_one / collabbox_booked_today / collabbox_feed_state / invoke_collabbox_sync keep
-- their grants (CREATE OR REPLACE keeps the ACL).

-- the read-only verification path (Management API, read_only: true): scripts/verify-booking-day.mjs,
-- scripts/backfill-collabbox-booked-at.mjs (dry run), verify-leaderboard-v2 --inline
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    GRANT EXECUTE ON FUNCTION public.collabbox_estimate_booked_at(text, timestamptz, timestamptz, uuid) TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.collabbox_doc_seq_key(text)                     TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.collabbox_doc_seq_no(text)                      TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.collabbox_clock_below(timestamptz, timestamptz) TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.collabbox_booking_day_since()                   TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.collabbox_sale_at(timestamptz, timestamptz)     TO supabase_read_only_user;
  END IF;
END
$grant$;

COMMIT;
