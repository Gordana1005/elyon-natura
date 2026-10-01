-- ============================================================================
-- MEX PICKUP TIME — when the courier took the parcel (Stock v2, owner 01.10.2026)
--
-- Stock v2 (docs/STOCK-V2.md "Pickup time") must split a parcel's life in two:
--   за пакување   MEX 8 "Shipment created": the label exists, the goods are still
--                 in the warehouse
--   кај курирот   the courier has the parcel (4 / 10 / 1 / 9 / 3 / 13 …), until
--                 2 Delivered / 7 Return to sender
-- MEX keeps NO status history: list_shipments.php returns the CURRENT status and
-- two timestamps only (raw keys, all 62.175 parcels: tracking_id, cod, created_at,
-- last_update_at, current_status_id, current_status_name, receiver_city,
-- receiver_name, receiver_phone, sender_reference). So the register has to record
-- the moment itself, the first time it sees the parcel off 8:
--
--   mex_parcels.picked_up_at     timestamptz, write-once
--   mex_parcels.picked_up_basis  'observed' | 'orders.shipped_at' | 'estimated'
--                                (NULL together with picked_up_at = unknown)
--
-- ── What MEX's clock says (measured 01.10.2026, read-only) ──────────────────
--   * Labels are made in a 07:30–07:45 Skopje batch (and a smaller ~11:00 one).
--   * The first courier scan is 10 "In Transit", on the label's own day between
--     16:00 and 21:00: on 01.10, 472 of 533 labels went 8 → 10 at 17:11–20:45; 61
--     stayed at 8. 4 "Picked Up" is rare (9 parcels in the register).
--   * The 15-minute sync sees the move: 419 orders the MEX-8 rule kept confirmed
--     went to shipped on 01.10 at 17:22–17:52, on average 8 min after MEX's
--     last_update_at.
--   * A parcel at 10 can be re-scanned later the same evening (last_update_at up to
--     ~3 h after the first 10), so last_update_at is the pickup scan only when it
--     is read AT the first sighting off 8.
--   * last_update_at never moves after 2 / 7 (0 of 1.875 delivered since 22.09).
--     No parcel since 22.09 was delivered or returned on its label day.
--
-- ── The rule (mex_upsert_parcels, write-once) ───────────────────────────────
--   A. The register held the parcel at 8, or with no status yet (a push
--      placeholder, 20260943001200), and the sighting's status is anything else:
--        picked_up_at = MEX last_update_at of that sighting, clamped into
--                       [created_at_mex, now()]; basis 'observed'.
--      Normally that IS the 8 → 10 (or → 4) scan, at most 15 minutes before the
--      sync saw it. If the sync missed the scan (an outage) and the parcel jumped
--      8 → 1 / 9 / 2 / 7 …, it is the time of the first later event seen — an
--      upper bound, never earlier than the truth. Not on a parcel the register
--      already knows delivered / returned.
--   B. A parcel the register has never seen arrives already off 8:
--        4 / 10 with last_update_at on the label's Skopje day → that scan,
--                   clamped, basis 'observed' (it is the pickup / first scan);
--        anything else → NULL. Its MEX time is a later event (a delivery attempt,
--                   the delivery, the return, a re-scan days later); the only
--                   other stamp, created_at, is the label, not the pickup. No
--                   trustworthy pickup time exists, and reports show NULL +
--                   status ≠ 8 as "на пат" (за пакување and кај курирот combined).
--   C. Once set, never moved or cleared — a stale row (latest call wins, see
--      20260934000100) that drops a parcel back to 8 cannot re-stamp it.
-- It is computed from the previous register row, so mex-reconcile passes nothing
-- new: NO edge-function change and NO redeploy.
--
-- ── History backfill (cheap: ~1.000 rows of mex_parcels; orders untouched) ──
--   H1 'observed'  the sync's own first-off-8 sightings since the MEX-8 rule went
--                  live (first sweep with it: 2026-10-01 06:07:01 Skopje, run
--                  7a99720b): order_history 'shipped' rows written by
--                  "System (mex:reconciliation)" for a parcel the order already
--                  held at an EARLIER sweep (linked_at < sighting − 5 min), so
--                  that sweep saw it at 8. Value = least(sighting, last_update_at)
--                  — both are upper bounds of the move. A same-sweep fresh link is
--                  not a pickup sighting (2 such rows on 01.10, both excluded).
--   H2 'observed'  parcels still at 4 / 10 whose scan is on the label's Skopje day
--                  (rule B's test): last_update_at. A 4/10 scan on a later day may
--                  be a re-scan — left NULL.
--   'orders.shipped_at' is kept as a legal basis but writes NOTHING: every writer
--                  of orders.shipped_at copies the MEX label time (mex-reconcile
--                  `shipped_at: created_at`, the collabBox writers, the parcel
--                  linker), so it carries no pickup information. Whole register:
--                  38.327 equal the label (±1 min), 2.532 are before it, 13 after
--                  the delivery / return; the single one in between
--                  (002-9110-176290/2026) is a re-send's label time (07:35:43, the
--                  batch minute, 8 days after this label).
--   'estimated'    kept legal, writes NOTHING. A "label day ~17:00" guess would
--                  put the right DAY on most parcels (1.280 of the 2.059
--                  delivered / returned since 22.09 finished the next day) but an
--                  invented hour on all of them, and the wrong day on the ~6–11 %
--                  picked up a day late (30.09: 32 of 407 labels still at 8 the
--                  next night). Left to the owner.
--
-- Reruns are safe: ADD COLUMN IF NOT EXISTS, the drift guard accepts the body
-- below, and the backfill only fills NULLs. Apply BEFORE any migration whose SQL
-- functions or views read picked_up_at (LANGUAGE sql bodies are checked at
-- CREATE). Revert = re-apply the 20260934000100 body of mex_upsert_parcels
-- (the columns can stay; nothing else writes them).
-- ============================================================================

BEGIN;

-- Fail fast rather than queue the 15-minute MEX sweep behind this ACCESS
-- EXCLUSIVE lock; the whole file holds it for well under a second.
SET LOCAL lock_timeout = '10s';

DO $drift$
BEGIN
  -- 1814b397… = the live body (= 20260934000100, verified 01.10.2026);
  -- c7b58bed… = the body below (a rerun of this migration).
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.mex_upsert_parcels(text,jsonb)')
                   AND md5(replace(p.prosrc, chr(13), '')) IN ('1814b397d98e3f2dba06ecea2f5e039c',
                                                               'c7b58bedd62f33def56f98518fef6962')) THEN
    RAISE EXCEPTION 'MEX pickup time: mex_upsert_parcels changed since this migration was written — rebase the picked_up_at edits onto the live body';
  END IF;
END
$drift$;

-- ── 1. The columns ──────────────────────────────────────────────────────────
-- Nullable, no default: catalog-only, no rewrite.
ALTER TABLE public.mex_parcels
  ADD COLUMN IF NOT EXISTS picked_up_at    timestamptz,
  ADD COLUMN IF NOT EXISTS picked_up_basis text;

ALTER TABLE public.mex_parcels DROP CONSTRAINT IF EXISTS mex_parcels_picked_up_basis_check;
ALTER TABLE public.mex_parcels ADD CONSTRAINT mex_parcels_picked_up_basis_check CHECK (
  (picked_up_at IS NULL AND picked_up_basis IS NULL)
  OR (picked_up_at IS NOT NULL AND picked_up_basis IN ('observed', 'orders.shipped_at', 'estimated'))
);

COMMENT ON COLUMN public.mex_parcels.picked_up_at IS
  'When the courier had the parcel (left MEX 8 "Shipment created" = за пакување). Write-once by mex_upsert_parcels: MEX last_update_at of the first sighting off 8 (normally the 8 → 10 In Transit scan, ≤ 15 min before the sync saw it; an upper bound if the sync missed the scan). NULL with a status other than 8 = unknown (first seen already past the first scan, or history) — reports show it as "на пат". Migration 20260945000900.';
COMMENT ON COLUMN public.mex_parcels.picked_up_basis IS
  'How picked_up_at was decided: observed (the register saw the parcel leave 8, or a same-day 4/10 scan; also the 01.10 order_history sightings) | orders.shipped_at | estimated (both legal, unused: orders.shipped_at is a copy of the label time, and no estimate was approved). NULL exactly when picked_up_at is NULL.';

-- ── 2. The sync writer — the LIVE body with the picked_up_at edits ──────────
-- Edits only: _picked_new; prev.picked_up_at; the two INSERT columns (rule B);
-- the two ON CONFLICT assignments (rules A + C); RETURNING; the count; the
-- 'picked_up_new' key. Everything else is verbatim.
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
  _picked_new    integer := 0;
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
    SELECT m.tracking_id, m.delivered_at, m.returned_at, m.picked_up_at
    FROM public.mex_parcels m
    JOIN src s ON s.tracking_id = m.tracking_id
  ),
  up AS (
    INSERT INTO public.mex_parcels AS m (
      tracking_id, account, status_id, status_name, cod_mkd,
      receiver_name, receiver_city, receiver_phone_raw, phone8, sender_reference,
      created_at_mex, last_update_at, delivered_at, returned_at,
      picked_up_at, picked_up_basis, raw)
    SELECT
      s.tracking_id, p_account, s.status_id, s.status_name, s.cod_mkd,
      s.receiver_name, s.receiver_city, s.receiver_phone_raw,
      CASE WHEN length(s.phone_digits) >= 8 THEN right(s.phone_digits, 8) END,
      s.sender_reference,
      s.created_at_mex, s.last_update_at,
      CASE WHEN s.status_id = 2 THEN s.last_update_at END,
      CASE WHEN s.status_id = 7 THEN s.last_update_at END,
      -- Rule B (a parcel never seen before): only a 4 Picked Up / 10 In Transit scan
      -- on the label's own Skopje day is the pickup; anything later carries no pickup time.
      -- (On a conflict these two values are ignored: rule A below decides.)
      CASE WHEN s.status_id IN (4, 10)
            AND (s.last_update_at AT TIME ZONE 'Europe/Skopje')::date
              = (s.created_at_mex AT TIME ZONE 'Europe/Skopje')::date
           THEN least(greatest(s.last_update_at, s.created_at_mex), now()) END,
      CASE WHEN s.status_id IN (4, 10)
            AND (s.last_update_at AT TIME ZONE 'Europe/Skopje')::date
              = (s.created_at_mex AT TIME ZONE 'Europe/Skopje')::date
           THEN 'observed' END,
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
      -- Rules A + C, write-once: the first sighting off 8 of a parcel the register held at 8
      -- (or with no status yet — a push placeholder) and does not know delivered / returned.
      -- MEX's own time of that sighting, never before the label, never in the future.
      picked_up_at       = CASE
                             WHEN m.picked_up_at IS NOT NULL THEN m.picked_up_at
                             WHEN EXCLUDED.status_id <> 8
                              AND (m.status_id IS NULL OR m.status_id = 8)
                              AND m.delivered_at IS NULL AND m.returned_at IS NULL
                             THEN least(greatest(coalesce(EXCLUDED.last_update_at, now()),
                                                 coalesce(EXCLUDED.created_at_mex, m.created_at_mex)),
                                        now())
                           END,
      picked_up_basis    = CASE
                             WHEN m.picked_up_at IS NOT NULL THEN m.picked_up_basis
                             WHEN EXCLUDED.status_id <> 8
                              AND (m.status_id IS NULL OR m.status_id = 8)
                              AND m.delivered_at IS NULL AND m.returned_at IS NULL
                             THEN 'observed'
                           END,
      raw                = EXCLUDED.raw,
      last_seen_at       = now()
    RETURNING m.tracking_id, m.delivered_at, m.returned_at, m.picked_up_at
  )
  SELECT count(*)::integer,
         (count(*) FILTER (WHERE u.delivered_at IS NOT NULL AND p.delivered_at IS NULL))::integer,
         (count(*) FILTER (WHERE u.returned_at  IS NOT NULL AND p.returned_at  IS NULL))::integer,
         (count(*) FILTER (WHERE u.picked_up_at IS NOT NULL AND p.picked_up_at IS NULL))::integer,
         coalesce(array_agg(u.tracking_id), ARRAY[]::text[])
    INTO _upserted, _delivered_new, _returned_new, _picked_new, _batch
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
    'picked_up_new', _picked_new,
    'orders_synced', _orders_synced
  );
END;
$fn$;

COMMENT ON FUNCTION public.mex_upsert_parcels(text, jsonb) IS
  'Upserts a batch of MEX list_shipments rows into mex_parcels (facts only; the link is never touched; delivered_at / returned_at / picked_up_at write-once — picked_up_at on the first sighting off MEX 8, 20260945000900) and copies the facts onto linked orders. Returns {received, upserted, skipped, delivered_new, returned_new, picked_up_new, orders_synced}. Service role only.';

REVOKE ALL ON FUNCTION public.mex_upsert_parcels(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mex_upsert_parcels(text, jsonb) TO service_role;

-- ── 3. History ──────────────────────────────────────────────────────────────
-- H1: the sync's own first-off-8 sightings since the MEX-8 rule went live. From
-- that sweep on, an order holding a parcel at 8 stays confirmed / waits, and the
-- sweep that first sees the parcel off 8 moves it to shipped and writes this row.
WITH seen AS (
  SELECT p.tracking_id,
         least(min(h.changed_at), p.last_update_at) AS at
  FROM public.order_history h
  JOIN public.orders o      ON o.id = h.order_id
  JOIN public.mex_parcels p ON p.tracking_id = o.mex_tracking_id AND p.order_id = o.id
  WHERE h.to_status = 'shipped'
    AND h.changed_by IS NULL
    AND h.changed_by_name = 'System (mex:reconciliation)'
    AND h.changed_at >= timestamptz '2026-10-01 06:07:00+02'
    AND p.linked_at < h.changed_at - interval '5 minutes'   -- held at an earlier sweep, i.e. at 8
    AND p.created_at_mex < h.changed_at
    AND p.status_id <> 8
    AND p.picked_up_at IS NULL
  GROUP BY p.tracking_id, p.last_update_at
)
UPDATE public.mex_parcels m
   SET picked_up_at    = greatest(s.at, m.created_at_mex),
       picked_up_basis = 'observed'
  FROM seen s
 WHERE m.tracking_id = s.tracking_id
   AND m.picked_up_at IS NULL;

-- H2: still at 4 / 10, scanned on the label's own Skopje day (rule B's test).
UPDATE public.mex_parcels m
   SET picked_up_at    = least(greatest(m.last_update_at, m.created_at_mex), now()),
       picked_up_basis = 'observed'
 WHERE m.picked_up_at IS NULL
   AND m.status_id IN (4, 10)
   AND (m.last_update_at AT TIME ZONE 'Europe/Skopje')::date
     = (m.created_at_mex AT TIME ZONE 'Europe/Skopje')::date;

COMMIT;

NOTIFY pgrst, 'reload schema';
