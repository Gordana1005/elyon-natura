-- ============================================================================
-- MEX PARCEL REGISTER — the courier's record, kept whole (2026-09-27)
--
-- Standing rule (2026-08-12): AlterCPA decides confirmed-or-dead; MEX ALONE
-- decides shipped / paid / returned. Yet the CRM only ever kept the MEX facts
-- it managed to MATCH: mex-reconcile reads a page of shipments, pairs each
-- with an order, and throws the shipment away. A parcel that matched nothing
-- left no trace at all, and a matched one left only orders.mex_tracking_id —
-- not its COD, not when it was delivered, not which account shipped it. "How
-- much did MEX actually collect?" could not be answered from the database, so
-- every paid order had to be taken on trust.
--
-- This migration keeps the courier's record itself, SEPARATE from the
-- judgement of which order it belongs to:
--
--   public.mex_parcels      one row per MEX parcel, both accounts, every
--                           status, matched or not. FACTS (status, COD,
--                           receiver, timestamps) are refreshed by every sync;
--                           the LINK (order_id / link_method / linked_at) is
--                           never touched by a sync.
--   orders.mex_*            a copy of the linked parcel's facts on the order,
--                           so money reports need no join.
--   mex_upsert_parcels()    the sync writer: facts only, 500-row batches.
--   mex_link_parcel()       the sanctioned way to link a parcel to an order:
--                           'missing' | 'already' | 'conflict' | 'linked'.
--   trg_orders_link_parcel  safety net for writers that set
--                           orders.mex_tracking_id directly (the collabBox
--                           importers, the CSV reconcile twin, mex-reconcile's
--                           own fresh-match write): the parcel is linked as
--                           'unknown_writer' and the order gets its facts.
--
-- ── The two accounts ───────────────────────────────────────────────────────
--   bio_natural  MEX_API_KEY    the Elyon business — series 9110 / 9103
--   natura       MEX_API_KEY_2  teleshop + social + web shop — series 9100 /
--                               9102 / 9108, plus ids with no series (NTMK…,
--                               M…)
-- Tracking ids are disjoint across the two (0 overlap in the 2026-09-27 pull
-- of 17.764 + 12.228 parcels), so tracking_id alone is the key. Series DO
-- cross accounts at the margins (34 × 9100/9102 under bio_natural, 8 ×
-- 9103/9110 under natura), which is why `account` is stored and never derived
-- from the series.
--
-- ── Quirks this table absorbs (all measured on the 2026-09-27 pull) ─────────
--   * `cod` is a STRING of denari ("1640"; "1500.00" also occurs). Four
--     parcels carry a NEGATIVE cod (-3000, -2500, -2000, -1310; all status 2
--     Delivered) — and they are exactly the four bare 7-digit tracking ids
--     (3324341 …), i.e. a different kind of shipment, most likely money
--     flowing back to the customer. The sign is KEPT: stripping it would book
--     +3000 ден collected where MEX says the opposite. (mex-reconcile's TS
--     parseCod strips it; that value only feeds its COD-fit matching.)
--   * Not every tracking id has the 002-9110-158456/2026 shape: 59
--     bio_natural parcels use one of OUR display ids (ORD-89109 …), 357 use
--     NTMK40556 …, 380 use M3258911 …, 4 are bare numbers. `series` is set
--     only for the real NNN-SSSS-… shape, so these read NULL instead of a fake
--     series ("89109").
--   * receiver_phone carries spaces, dashes, dots, tabs, a stray letter and
--     once two numbers. phone8 = its last 8 digits, the CRM's matching canon.
--   * Timestamps are Skopje wall-clock time. AT TIME ZONE 'Europe/Skopje' is
--     DST-exact (mex-reconcile's fixed +02:00 is an hour off in winter).
--   * Unparseable values become NULL rather than aborting a 500-row batch.
--
-- ── Link state at write time ───────────────────────────────────────────────
-- 19.463 of 105.447 orders carry a mex_tracking_id and 47 tracking ids are
-- held by TWO orders each. The register therefore does NOT derive links from
-- orders.mex_tracking_id when it inserts a parcel: the backfill
-- (scripts/backfill-mex-register.mjs) records the pre-register links with
-- their real provenance ('tracking' / 'collabbox_import') and resolves the
-- doubles. Consequence worth knowing: the trigger only fires on an ORDER
-- write, so an order that received its tracking id BEFORE its parcel was
-- registered stays unlinked until a linker pass (or the backfill) links it.
--
-- Security: parcels carry receiver names, phones and COD — money + PII.
-- SELECT is for business owners only (20260934000000 must be applied first);
-- every writer is service_role.
-- ============================================================================

-- Fail fast rather than queue every orders query behind this migration's
-- ACCESS EXCLUSIVE lock. Transaction-scoped; the whole file is one
-- transaction and holds the lock for milliseconds once it has it.
SET LOCAL lock_timeout = '5s';

-- ── 1. The linked parcel's facts, copied onto the order ─────────────────────
-- Taken FIRST so the strongest lock on orders is acquired up front (the FK
-- and trigger below only need weaker ones). Nullable, no default:
-- catalog-only on 105k rows — no rewrite, no scan.
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS mex_account        text,
  ADD COLUMN IF NOT EXISTS mex_status_id      integer,
  ADD COLUMN IF NOT EXISTS mex_cod_mkd        integer,
  ADD COLUMN IF NOT EXISTS mex_delivered_at   timestamptz,
  ADD COLUMN IF NOT EXISTS mex_returned_at    timestamptz,
  ADD COLUMN IF NOT EXISTS mex_last_update_at timestamptz;

COMMENT ON COLUMN public.orders.mex_account IS
  'MEX account of the parcel this order names in mex_tracking_id: bio_natural | natura. Copied from mex_parcels by mex_upsert_parcels / mex_link_parcel / trg_orders_link_parcel — never hand-written.';
COMMENT ON COLUMN public.orders.mex_status_id IS
  'MEX current_status_id of the linked parcel (2 Delivered, 7 Return to sender, 8 Shipment created, 10 In Transit, 13 Rejected, …). Copied from mex_parcels.';
COMMENT ON COLUMN public.orders.mex_cod_mkd IS
  'COD of the linked parcel in whole denari, exactly as MEX reports it (may include the 150 ден delivery fee; sign kept). Copied from mex_parcels.';
COMMENT ON COLUMN public.orders.mex_delivered_at IS
  'When MEX first reported the linked parcel Delivered (status 2). Write-once on the parcel. The courier''s proof of payment.';
COMMENT ON COLUMN public.orders.mex_returned_at IS
  'When MEX first reported the linked parcel Return to sender (status 7). Write-once on the parcel.';
COMMENT ON COLUMN public.orders.mex_last_update_at IS
  'MEX last_update_at of the linked parcel (Skopje wall time converted to timestamptz).';

-- ── 2. The register ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.mex_parcels (
  tracking_id        text PRIMARY KEY,
  account            text NOT NULL
                     CONSTRAINT mex_parcels_account_check
                     CHECK (account IN ('bio_natural', 'natura')),
  -- 002-9110-158456/2026 → '9110'. Only the real NNN-SSSS-… shape has a
  -- series; ORD-89109, NTMK40556, M3258911 and bare numbers read NULL.
  series             text GENERATED ALWAYS AS (
                       CASE WHEN tracking_id ~ '^[0-9]{3}-[0-9]{4}-'
                            THEN split_part(tracking_id, '-', 2)
                       END
                     ) STORED,
  status_id          integer,
  status_name        text,
  cod_mkd            integer,
  receiver_name      text,
  receiver_city      text,
  receiver_phone_raw text,
  phone8             text,
  sender_reference   text,
  created_at_mex     timestamptz,
  last_update_at     timestamptz,
  delivered_at       timestamptz,          -- write-once: first sighting of status 2
  returned_at        timestamptz,          -- write-once: first sighting of status 7
  order_id           uuid REFERENCES public.orders(id) ON DELETE SET NULL,
  link_method        text
                     CONSTRAINT mex_parcels_link_method_check
                     CHECK (link_method IN ('tracking', 'phone_cod', 'phone_single',
                                            'collabbox_import', 'repair', 'manual',
                                            'unknown_writer', 'name_city')),
  linked_at          timestamptz,
  first_seen_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at       timestamptz NOT NULL DEFAULT now(),
  raw                jsonb
);

COMMENT ON TABLE public.mex_parcels IS
  'MEX Poshta parcel register: one row per parcel from BOTH accounts, matched or not. Facts are refreshed by mex_upsert_parcels (service role); the link (order_id/link_method/linked_at) is written only by mex_link_parcel and trg_orders_link_parcel. MEX is the money truth (rule 2026-08-12). SELECT: business owners only.';
COMMENT ON COLUMN public.mex_parcels.account IS
  'bio_natural (MEX_API_KEY, the Elyon business) | natura (MEX_API_KEY_2, teleshop + social + web shop). Stored, never derived from the series: series cross accounts at the margins.';
COMMENT ON COLUMN public.mex_parcels.cod_mkd IS
  'MEX cod string as whole denari. Sign kept (four parcels report a negative COD). NULL when MEX sent nothing parseable.';
COMMENT ON COLUMN public.mex_parcels.phone8 IS
  'Last 8 digits of receiver_phone — the CRM phone-matching canon. NULL when fewer than 8 digits.';
COMMENT ON COLUMN public.mex_parcels.delivered_at IS
  'First time a sync saw status 2 Delivered (MEX last_update_at of that sighting). Write-once: a later status never clears or moves it.';
COMMENT ON COLUMN public.mex_parcels.returned_at IS
  'First time a sync saw status 7 Return to sender (MEX last_update_at of that sighting). Write-once.';
COMMENT ON COLUMN public.mex_parcels.link_method IS
  'How order_id was decided: tracking | phone_cod | phone_single | collabbox_import | repair | manual | unknown_writer (an order wrote the tracking id without going through mex_link_parcel) | name_city. May be pre-declared on an unlinked parcel; the trigger keeps a pre-declared method.';
COMMENT ON COLUMN public.mex_parcels.raw IS
  'The last list_shipments.php row received for this parcel, verbatim.';

CREATE INDEX IF NOT EXISTS idx_mex_parcels_phone8
  ON public.mex_parcels (phone8);
CREATE INDEX IF NOT EXISTS idx_mex_parcels_order_id
  ON public.mex_parcels (order_id);
CREATE INDEX IF NOT EXISTS idx_mex_parcels_series_created
  ON public.mex_parcels (series, created_at_mex);
CREATE INDEX IF NOT EXISTS idx_mex_parcels_status_updated
  ON public.mex_parcels (status_id, last_update_at);
-- ~95% of parcels have no sender reference (only web-shop ids carry one).
CREATE INDEX IF NOT EXISTS idx_mex_parcels_sender_reference
  ON public.mex_parcels (sender_reference) WHERE sender_reference IS NOT NULL;

-- Money + PII: business owners only. No write policies — service role only.
ALTER TABLE public.mex_parcels ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mex_parcels_select_owners ON public.mex_parcels;
CREATE POLICY mex_parcels_select_owners ON public.mex_parcels
  FOR SELECT TO authenticated
  -- Scalar sub-select: evaluated once per statement, not once per parcel.
  USING ((SELECT public.is_business_owner(auth.uid())));

REVOKE ALL ON public.mex_parcels FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.mex_parcels TO authenticated;
GRANT ALL ON public.mex_parcels TO service_role;

-- ── 3. Parsers — a bad cell becomes NULL, never an aborted batch ────────────
-- "YYYY-MM-DD HH:MM:SS", Skopje wall time → timestamptz. The shape check keeps
-- out the special inputs a timestamp cast would otherwise accept ('now',
-- 'epoch', 'infinity'); pg_input_is_valid (PG16+) rejects impossible dates
-- such as MySQL's 0000-00-00 without raising.
CREATE OR REPLACE FUNCTION public.mex_parse_ts(p_value text)
RETURNS timestamptz
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
           WHEN btrim(p_value) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]+)?)?$'
            AND pg_input_is_valid(btrim(p_value), 'timestamp')
           THEN btrim(p_value)::timestamp AT TIME ZONE 'Europe/Skopje'
         END
$$;

COMMENT ON FUNCTION public.mex_parse_ts(text) IS
  'MEX timestamp (Skopje wall time, "YYYY-MM-DD HH:MM:SS") → timestamptz, DST-exact. NULL for anything unparseable — never raises.';

-- MEX cod string → whole denari. Digits and the decimal point are kept (as
-- mex-reconcile does), a LEADING minus keeps its sign, and anything that does
-- not reduce to one number of at most 9 integer digits is NULL (no int
-- overflow, no "1.640.00" cast error).
CREATE OR REPLACE FUNCTION public.mex_parse_cod(p_value text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
           WHEN s.d ~ '^[0-9]{1,9}([.][0-9]*)?$'
           THEN (CASE WHEN btrim(p_value) LIKE '-%' THEN -1 ELSE 1 END)
                * round(s.d::numeric)::integer
         END
    FROM (SELECT regexp_replace(coalesce(p_value, ''), '[^0-9.]', '', 'g') AS d) s
$$;

COMMENT ON FUNCTION public.mex_parse_cod(text) IS
  'MEX cod string → integer denari ("1640" → 1640, "1500.00" → 1500, "-3000" → -3000, "" → NULL). Never raises.';

REVOKE ALL ON FUNCTION public.mex_parse_ts(text)  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mex_parse_cod(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mex_parse_ts(text)  TO service_role;
GRANT EXECUTE ON FUNCTION public.mex_parse_cod(text) TO service_role;

-- ── 4. The sync writer ──────────────────────────────────────────────────────
-- p_rows = a JSON array of list_shipments.php rows, as MEX returns them.
-- Set-based: one INSERT … ON CONFLICT for the batch, one UPDATE for the orders.
--
--   * Facts are overwritten by every sync call (the latest CALL wins — there
--     is no last_update_at ordering across calls; within one batch the
--     freshest repeat of a parcel wins). A NULL in the new row never erases a
--     known value, so a partial row cannot blank the register.
--   * delivered_at / returned_at are write-once: set on the first sighting of
--     status 2 / 7 and never moved or cleared afterwards.
--   * order_id / link_method / linked_at / first_seen_at are NEVER written.
--   * Linked orders get the facts of the parcel they NAME in mex_tracking_id;
--     an order linked only to older parcels (a re-send) gets its newest one.
--     Unchanged orders are not rewritten (no updated_at churn, no dead tuples).
--
-- Returns {received, upserted, skipped, delivered_new, returned_new,
-- orders_synced}. skipped = rows without a tracking id, non-objects, and
-- in-batch repeats of the same parcel (the freshest repeat wins).
CREATE OR REPLACE FUNCTION public.mex_upsert_parcels(p_account text, p_rows jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _received      integer := 0;
  _upserted      integer := 0;
  _delivered_new integer := 0;
  _returned_new  integer := 0;
  _orders_synced integer := 0;
  _batch         text[]  := ARRAY[]::text[];
BEGIN
  IF p_account IS NULL OR p_account NOT IN ('bio_natural', 'natura') THEN
    RAISE EXCEPTION 'mex_upsert_parcels: unknown MEX account %', coalesce(quote_literal(p_account), 'NULL')
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'mex_upsert_parcels: p_rows must be a JSON array'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  _received := jsonb_array_length(p_rows);

  WITH parsed AS (
    SELECT
      nullif(btrim(e->>'tracking_id'), '')                                  AS tracking_id,
      CASE WHEN btrim(e->>'current_status_id') ~ '^[0-9]{1,9}$'
           THEN btrim(e->>'current_status_id')::integer END                AS status_id,
      nullif(btrim(e->>'current_status_name'), '')                          AS status_name,
      public.mex_parse_cod(e->>'cod')                                       AS cod_mkd,
      nullif(btrim(e->>'receiver_name'), '')                                AS receiver_name,
      nullif(btrim(e->>'receiver_city'), '')                                AS receiver_city,
      nullif(e->>'receiver_phone', '')                                      AS receiver_phone_raw,
      regexp_replace(coalesce(e->>'receiver_phone', ''), '[^0-9]', '', 'g') AS phone_digits,
      nullif(btrim(e->>'sender_reference'), '')                             AS sender_reference,
      public.mex_parse_ts(e->>'created_at')                                 AS created_at_mex,
      public.mex_parse_ts(e->>'last_update_at')                             AS last_update_at,
      e                                                                     AS raw
    FROM jsonb_array_elements(p_rows) AS e
    WHERE jsonb_typeof(e) = 'object'
  ),
  src AS (
    -- One row per parcel: ON CONFLICT DO UPDATE refuses to touch a row twice
    -- in one statement, and MEX paging can repeat a parcel whose status moved
    -- mid-pull. The freshest sighting wins.
    SELECT DISTINCT ON (x.tracking_id) x.*
    FROM parsed x
    WHERE x.tracking_id IS NOT NULL
    ORDER BY x.tracking_id, x.last_update_at DESC NULLS LAST
  ),
  prev AS (
    -- Same snapshot as the INSERT below, so this is the state BEFORE it.
    SELECT m.tracking_id, m.delivered_at, m.returned_at
    FROM public.mex_parcels m
    JOIN src s ON s.tracking_id = m.tracking_id
  ),
  up AS (
    INSERT INTO public.mex_parcels AS m (
      tracking_id, account, status_id, status_name, cod_mkd,
      receiver_name, receiver_city, receiver_phone_raw, phone8, sender_reference,
      created_at_mex, last_update_at, delivered_at, returned_at, raw)
    SELECT
      s.tracking_id, p_account, s.status_id, s.status_name, s.cod_mkd,
      s.receiver_name, s.receiver_city, s.receiver_phone_raw,
      CASE WHEN length(s.phone_digits) >= 8 THEN right(s.phone_digits, 8) END,
      s.sender_reference,
      s.created_at_mex, s.last_update_at,
      CASE WHEN s.status_id = 2 THEN s.last_update_at END,
      CASE WHEN s.status_id = 7 THEN s.last_update_at END,
      s.raw
    FROM src s
    ORDER BY s.tracking_id                -- stable row-lock order across syncs
    ON CONFLICT (tracking_id) DO UPDATE SET
      account            = EXCLUDED.account,
      status_id          = coalesce(EXCLUDED.status_id,          m.status_id),
      status_name        = coalesce(EXCLUDED.status_name,        m.status_name),
      cod_mkd            = coalesce(EXCLUDED.cod_mkd,            m.cod_mkd),
      receiver_name      = coalesce(EXCLUDED.receiver_name,      m.receiver_name),
      receiver_city      = coalesce(EXCLUDED.receiver_city,      m.receiver_city),
      receiver_phone_raw = coalesce(EXCLUDED.receiver_phone_raw, m.receiver_phone_raw),
      phone8             = coalesce(EXCLUDED.phone8,             m.phone8),
      sender_reference   = coalesce(EXCLUDED.sender_reference,   m.sender_reference),
      created_at_mex     = coalesce(EXCLUDED.created_at_mex,     m.created_at_mex),
      last_update_at     = coalesce(EXCLUDED.last_update_at,     m.last_update_at),
      delivered_at       = coalesce(m.delivered_at, EXCLUDED.delivered_at),   -- write-once
      returned_at        = coalesce(m.returned_at,  EXCLUDED.returned_at),    -- write-once
      raw                = EXCLUDED.raw,
      last_seen_at       = now()
    RETURNING m.tracking_id, m.delivered_at, m.returned_at
  )
  SELECT count(*)::integer,
         (count(*) FILTER (WHERE u.delivered_at IS NOT NULL AND p.delivered_at IS NULL))::integer,
         (count(*) FILTER (WHERE u.returned_at  IS NOT NULL AND p.returned_at  IS NULL))::integer,
         coalesce(array_agg(u.tracking_id), ARRAY[]::text[])
    INTO _upserted, _delivered_new, _returned_new, _batch
    FROM up u
    LEFT JOIN prev p ON p.tracking_id = u.tracking_id;

  -- Propagate to linked orders. A separate statement on purpose: it must see
  -- the rows the INSERT above just wrote.
  IF _upserted > 0 THEN
    WITH touched AS (
      SELECT DISTINCT m.order_id
      FROM public.mex_parcels m
      WHERE m.tracking_id = ANY (_batch)
        AND m.order_id IS NOT NULL
    ),
    pick AS (
      -- An order can own several parcels (a re-send). It carries the facts of
      -- the parcel it names in mex_tracking_id; failing that, its newest one.
      -- Deterministic, so two syncs can never flip-flop an order.
      SELECT DISTINCT ON (m.order_id)
             m.order_id, m.account, m.status_id, m.cod_mkd,
             m.delivered_at, m.returned_at, m.last_update_at
      FROM public.mex_parcels m
      JOIN touched t       ON t.order_id = m.order_id
      JOIN public.orders o ON o.id = m.order_id
      ORDER BY m.order_id,
               (CASE WHEN m.tracking_id = o.mex_tracking_id THEN 0 ELSE 1 END),
               m.created_at_mex DESC NULLS LAST,
               m.tracking_id DESC
    )
    UPDATE public.orders o
       SET mex_account        = k.account,
           mex_status_id      = k.status_id,
           mex_cod_mkd        = k.cod_mkd,
           mex_delivered_at   = k.delivered_at,
           mex_returned_at    = k.returned_at,
           mex_last_update_at = k.last_update_at
      FROM pick k
     WHERE o.id = k.order_id
       AND (o.mex_account, o.mex_status_id, o.mex_cod_mkd,
            o.mex_delivered_at, o.mex_returned_at, o.mex_last_update_at)
           IS DISTINCT FROM
           (k.account, k.status_id, k.cod_mkd,
            k.delivered_at, k.returned_at, k.last_update_at);
    GET DIAGNOSTICS _orders_synced = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object(
    'received',      _received,
    'upserted',      _upserted,
    'skipped',       _received - _upserted,
    'delivered_new', _delivered_new,
    'returned_new',  _returned_new,
    'orders_synced', _orders_synced
  );
END;
$fn$;

COMMENT ON FUNCTION public.mex_upsert_parcels(text, jsonb) IS
  'Upserts a batch of MEX list_shipments rows into mex_parcels (facts only; the link is never touched; delivered_at/returned_at write-once) and copies the facts onto linked orders. Returns {received, upserted, skipped, delivered_new, returned_new, orders_synced}. Service role only.';

REVOKE ALL ON FUNCTION public.mex_upsert_parcels(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mex_upsert_parcels(text, jsonb) TO service_role;

-- ── 5. The linker ───────────────────────────────────────────────────────────
--   'missing'   no such parcel in the register (sync it first)
--   'already'   the parcel already belongs to p_order; the order is made to
--               name it and carry its facts (unless the order names a NEWER
--               parcel of its own — a re-send keeps its newest), and an
--               'unknown_writer' placeholder is upgraded to p_method
--   'conflict'  the parcel belongs to another order and p_force is false
--   'linked'    the parcel now belongs to p_order; the order names it and
--               carries its facts (same re-send rule)
-- p_force: take the parcel from whichever order holds it, and clear
-- mex_tracking_id + every mex_* fact on any OTHER order that names it (also
-- on 'already' — that is how a double-held tracking id is made single).
-- A p_order that does not exist raises: it is a caller bug, not an outcome.
CREATE OR REPLACE FUNCTION public.mex_link_parcel(
  p_tracking text,
  p_order    uuid,
  p_method   text,
  p_force    boolean DEFAULT false
)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _p      public.mex_parcels%ROWTYPE;
  _force  boolean := coalesce(p_force, false);
  _result text;
BEGIN
  IF p_tracking IS NULL OR p_order IS NULL THEN
    RAISE EXCEPTION 'mex_link_parcel: tracking id and order id are both required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_method IS NULL OR p_method NOT IN ('tracking', 'phone_cod', 'phone_single',
                                          'collabbox_import', 'repair', 'manual',
                                          'unknown_writer', 'name_city') THEN
    RAISE EXCEPTION 'mex_link_parcel: unknown link method %', coalesce(quote_literal(p_method), 'NULL')
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Row lock: two linkers racing for one parcel serialise here, and the loser
  -- then sees the winner's order_id ('already' or 'conflict').
  SELECT * INTO _p FROM public.mex_parcels WHERE tracking_id = p_tracking FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'missing';
  END IF;

  IF _p.order_id IS NOT NULL AND _p.order_id <> p_order AND NOT _force THEN
    RETURN 'conflict';
  END IF;

  IF _p.order_id IS DISTINCT FROM p_order
     AND NOT EXISTS (SELECT 1 FROM public.orders WHERE id = p_order) THEN
    RAISE EXCEPTION 'mex_link_parcel: order % does not exist', p_order
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF _force THEN
    -- mex_tracking_id := NULL cannot fire trg_orders_link_parcel (its WHEN
    -- clause requires a non-NULL id).
    UPDATE public.orders
       SET mex_tracking_id    = NULL,
           mex_account        = NULL,
           mex_status_id      = NULL,
           mex_cod_mkd        = NULL,
           mex_delivered_at   = NULL,
           mex_returned_at    = NULL,
           mex_last_update_at = NULL
     WHERE mex_tracking_id = p_tracking
       AND id <> p_order;
  END IF;

  IF _p.order_id = p_order THEN
    _result := 'already';
    -- The trigger links as 'unknown_writer' when an order writes the id
    -- before (or instead of) calling here; the caller's method replaces that
    -- placeholder. A real method is never overwritten.
    IF (_p.link_method IS NULL OR _p.link_method = 'unknown_writer')
       AND p_method <> 'unknown_writer' THEN
      UPDATE public.mex_parcels
         SET link_method = p_method
       WHERE tracking_id = p_tracking;
    END IF;
  ELSE
    _result := 'linked';
    -- Parcel FIRST: when the orders UPDATE below fires trg_orders_link_parcel,
    -- the parcel already has its order_id and the trigger does nothing.
    UPDATE public.mex_parcels
       SET order_id    = p_order,
           link_method = p_method,
           linked_at   = now()
     WHERE tracking_id = p_tracking;
  END IF;

  -- The order names this parcel and carries its facts — unless it already
  -- names a NEWER parcel that is also its own (a re-send), which it keeps.
  UPDATE public.orders o
     SET mex_tracking_id    = p_tracking,
         mex_account        = _p.account,
         mex_status_id      = _p.status_id,
         mex_cod_mkd        = _p.cod_mkd,
         mex_delivered_at   = _p.delivered_at,
         mex_returned_at    = _p.returned_at,
         mex_last_update_at = _p.last_update_at
   WHERE o.id = p_order
     AND (o.mex_tracking_id, o.mex_account, o.mex_status_id, o.mex_cod_mkd,
          o.mex_delivered_at, o.mex_returned_at, o.mex_last_update_at)
         IS DISTINCT FROM
         (p_tracking, _p.account, _p.status_id, _p.cod_mkd,
          _p.delivered_at, _p.returned_at, _p.last_update_at)
     AND NOT EXISTS (
           SELECT 1
             FROM public.mex_parcels q
            WHERE q.tracking_id = o.mex_tracking_id
              AND q.tracking_id <> p_tracking
              AND q.order_id = p_order
              AND q.created_at_mex > _p.created_at_mex);

  RETURN _result;
END;
$fn$;

COMMENT ON FUNCTION public.mex_link_parcel(text, uuid, text, boolean) IS
  'Links a registered MEX parcel to an order and copies its facts onto the order. Returns missing | already | conflict | linked. p_force takes the parcel from another order and clears mex_tracking_id + mex_* on every other order naming it. Service role only.';

REVOKE ALL ON FUNCTION public.mex_link_parcel(text, uuid, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mex_link_parcel(text, uuid, text, boolean) TO service_role;

-- ── 6. Safety net: an order that names a free parcel gets it ────────────────
-- Covers every writer that sets orders.mex_tracking_id directly instead of
-- calling mex_link_parcel (collabBox importers, the CSV reconcile twin,
-- mex-reconcile's fresh-match write). Only a FREE parcel is taken — a parcel
-- another order already holds is left alone (that is mex_link_parcel's
-- 'conflict', not something a trigger may decide). A method pre-declared on
-- the free parcel (e.g. 'collabbox_import') is kept.
--
-- No recursion: mex_link_parcel links the parcel before it writes the order,
-- so the trigger it fires finds order_id set and does nothing; this
-- function's own orders UPDATE and mex_upsert_parcels' never list
-- mex_tracking_id in SET, so UPDATE OF mex_tracking_id cannot re-fire; and
-- clearing the id to NULL is excluded by the WHEN clause.
--
-- SECURITY DEFINER because the writer may be an authenticated session, which
-- has no UPDATE on mex_parcels. Failures are swallowed: a safety net must
-- never fail the order write it rides on — the linker finds the parcel later.
CREATE OR REPLACE FUNCTION public.tg_orders_link_parcel()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _p record;
BEGIN
  UPDATE public.mex_parcels m
     SET order_id    = NEW.id,
         link_method = coalesce(m.link_method, 'unknown_writer'),
         linked_at   = coalesce(m.linked_at, now())
   WHERE m.tracking_id = NEW.mex_tracking_id
     AND m.order_id IS NULL
  RETURNING m.account, m.status_id, m.cod_mkd,
            m.delivered_at, m.returned_at, m.last_update_at
       INTO _p;

  IF FOUND THEN
    -- Leave the order exactly as mex_link_parcel would: naming the parcel AND
    -- carrying its facts. mex_tracking_id is not in this SET list, so the
    -- trigger cannot re-fire.
    UPDATE public.orders o
       SET mex_account        = _p.account,
           mex_status_id      = _p.status_id,
           mex_cod_mkd        = _p.cod_mkd,
           mex_delivered_at   = _p.delivered_at,
           mex_returned_at    = _p.returned_at,
           mex_last_update_at = _p.last_update_at
     WHERE o.id = NEW.id
       AND o.mex_tracking_id = NEW.mex_tracking_id
       AND (o.mex_account, o.mex_status_id, o.mex_cod_mkd,
            o.mex_delivered_at, o.mex_returned_at, o.mex_last_update_at)
           IS DISTINCT FROM
           (_p.account, _p.status_id, _p.cod_mkd,
            _p.delivered_at, _p.returned_at, _p.last_update_at);
  END IF;

  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$fn$;

COMMENT ON FUNCTION public.tg_orders_link_parcel() IS
  'AFTER INSERT / UPDATE OF mex_tracking_id on orders: links a FREE mex_parcels row to the order (link_method unknown_writer unless pre-declared) and copies its facts onto the order. Never takes a parcel another order holds; never fails the order write.';

REVOKE ALL ON FUNCTION public.tg_orders_link_parcel() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_orders_link_parcel ON public.orders;
CREATE TRIGGER trg_orders_link_parcel
AFTER INSERT OR UPDATE OF mex_tracking_id ON public.orders
FOR EACH ROW
WHEN (NEW.mex_tracking_id IS NOT NULL)
EXECUTE FUNCTION public.tg_orders_link_parcel();

-- ── 7. mex_sync_runs.kind gains 'register' ──────────────────────────────────
-- Recreated from the LIVE definition (2026-09-27) plus 'register': a run that
-- only fetches and upserts the register. Such a run matches nothing, so it
-- must never advance mex-reconcile's matching cursor (match.ts
-- isRegisterOnlyRun).
ALTER TABLE public.mex_sync_runs
  DROP CONSTRAINT IF EXISTS mex_sync_runs_kind_check,
  ADD CONSTRAINT mex_sync_runs_kind_check
    CHECK (kind IN ('rolling', 'backfill', 'manual', 'dry', 'register'));

NOTIFY pgrst, 'reload schema';
