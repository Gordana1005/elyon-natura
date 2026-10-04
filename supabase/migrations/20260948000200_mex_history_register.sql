-- 20260948000200_mex_history_register.sql
-- The HISTORY of the MEX register (owner, 03–04.10.2026: "сакам 100 % сигурна база").
--
-- public.mex_parcels only starts on 10.11.2025 and is not complete even after that; the history audit of 03.10.2026
-- pulled the WHOLE register from MEX (453.204 parcels since 18.03.2020, both accounts). About 197.000 orders are the
-- collabBox documents whose number IS the MEX tracking id — their parcel proves them (2 Delivered → paid, 7 Return to
-- sender → returned), but they hold no parcel, so the CRM shows them as "paid (old import)", not as proven, and has no
-- cash day for them.
--
-- PHASE 1 (this migration): only parcels that an order OWNS BY NUMBER enter the register, and each arrives ALREADY
-- LINKED, in the same transaction as the one UPDATE of its order. No unlinked history row ever exists, so no reader
-- can count a parcel as a MEX-only sale next to its order — the cohort (insights_sale_rows `mo`), the Overview (`mf`,
-- order_id IS NULL), collabbox_feed_state and the web linker stay exactly as they are. Parcels with no order (the
-- sales the CRM never had) and the phone + date links are a later phase: they need a "does not count yet" marker and
-- the readers taught to honour it.
--
--   mex_parcels.history_run      the load that brought a row (NULL = the live sync) — also the undo key
--   mex_history_stage            the dump, parsed with the live sync's own mex_parse_ts / mex_parse_cod (private)
--   mex_history_links            the plan and the ledger: one row per order, the before-image of paid_basis
--   mex_history_link_plan(run)   fills the plan: collabBox order × its own parcel, paid × MEX 2 (COD > 0) or
--                                returned × MEX 7, the order holds no parcel, the register has no such row
--   mex_history_link_apply(run)  ≤ p_batch orders per transaction: insert the parcels linked, ONE update per order
--                                (the seven mex_* facts + paid_basis 'mex' on a paid order); status, sold_*, price
--                                and updated_at are never touched (elyon.keep_updated_at / bulk_repair / defer_segments)
--   mex_history_link_undo(run)   the reverse: orders back to no parcel and their old paid_basis, the rows deleted
--
-- What a link changes in the reports (measured before the load, 04.10.2026): the bucket paid_legacy → paid; the value
-- becomes the parcel COD (equal to price × 61,5 for 99,6 %, +150 delivery for 313, other for ~500); a cash day
-- (delivered_at) appears, so the cash clock and Наплата (MEX) show history. The department cannot move
-- (order_dept_decide evaluated on all of them: 0 change) and no sale day moves (sale_day_revive / late_sale skip an
-- order whose document number is its tracking id).

ALTER TABLE public.mex_parcels ADD COLUMN IF NOT EXISTS history_run uuid;
COMMENT ON COLUMN public.mex_parcels.history_run IS
  'The history load that inserted this row from the MEX register dump (mex_history_stage); NULL = the live sync. The undo key of mex_history_link_undo().';
CREATE INDEX IF NOT EXISTS idx_mex_parcels_history_run ON public.mex_parcels (history_run) WHERE history_run IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.mex_history_stage (
  tracking_id        text PRIMARY KEY,
  account            text NOT NULL CHECK (account IN ('bio_natural', 'natura')),
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
  dump_at            timestamptz NOT NULL
);
COMMENT ON TABLE public.mex_history_stage IS
  'The whole MEX register as pulled on 03.10.2026 (list_shipments, both accounts, since 18.03.2020), parsed like the live sync. Proof store and the source of the history loads; no reader of the CRM uses it.';
CREATE INDEX IF NOT EXISTS idx_mex_history_stage_phone8 ON public.mex_history_stage (phone8) WHERE phone8 IS NOT NULL;
ALTER TABLE public.mex_history_stage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mex_history_stage FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.mex_history_links (
  run_id            uuid NOT NULL,
  order_id          uuid NOT NULL,
  tracking_id       text NOT NULL,
  rule              text NOT NULL,
  expect_status     text NOT NULL,
  paid_basis_before text,
  planned_at        timestamptz NOT NULL DEFAULT now(),
  linked_at         timestamptz,
  skipped           text,
  undone_at         timestamptz,
  PRIMARY KEY (run_id, order_id),
  UNIQUE (run_id, tracking_id)
);
COMMENT ON TABLE public.mex_history_links IS
  'Plan + ledger of the history links (mex_history_link_plan / _apply / _undo): the order, its parcel, the status the plan saw and the paid_basis it had before.';
CREATE INDEX IF NOT EXISTS idx_mex_history_links_todo ON public.mex_history_links (run_id, order_id) WHERE linked_at IS NULL AND skipped IS NULL;
ALTER TABLE public.mex_history_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mex_history_links FROM PUBLIC, anon, authenticated;

-- ── the plan ────────────────────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mex_history_link_plan(p_run uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $plan$
DECLARE
  _n integer;
BEGIN
  IF p_run IS NULL THEN
    RAISE EXCEPTION 'mex_history_link_plan: a run id is required';
  END IF;
  IF EXISTS (SELECT 1 FROM public.mex_history_links WHERE run_id = p_run) THEN
    RAISE EXCEPTION 'mex_history_link_plan: run % already has a plan', p_run;
  END IF;

  INSERT INTO public.mex_history_links (run_id, order_id, tracking_id, rule, expect_status)
  SELECT p_run, o.id, s.tracking_id,
         CASE WHEN o.status = 'paid' THEN 'paid_delivered' ELSE 'returned_returned' END,
         o.status::text
    FROM public.mex_history_stage s
    JOIN public.orders o
      ON o.external_source = 'collabbox' AND o.external_order_id = s.tracking_id   -- the document number IS the parcel
   WHERE o.mex_tracking_id IS NULL
     AND (   (o.status = 'paid'     AND s.status_id = 2 AND coalesce(s.cod_mkd, 0) > 0)   -- COD 0 = a replacement: not here
          OR (o.status = 'returned' AND s.status_id = 7))
     AND coalesce(s.phone8, '') NOT IN ('70123456', '23123123')                    -- the test phones
     AND s.created_at_mex IS NOT NULL AND s.last_update_at IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.mex_parcels mp WHERE mp.tracking_id = s.tracking_id)
     AND NOT EXISTS (SELECT 1 FROM public.orders x WHERE x.mex_tracking_id = s.tracking_id);
  GET DIAGNOSTICS _n = ROW_COUNT;

  RETURN jsonb_build_object(
    'run', p_run, 'planned', _n,
    'by_rule', (SELECT jsonb_object_agg(x.rule, x.n) FROM (
                  SELECT l.rule, count(*) AS n FROM public.mex_history_links l WHERE l.run_id = p_run GROUP BY 1) x));
END;
$plan$;

-- ── the apply: ≤ p_batch orders per transaction ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE PROCEDURE public.mex_history_link_apply(p_run uuid, p_batch integer DEFAULT 2000, p_max integer DEFAULT NULL)
LANGUAGE plpgsql
AS $apply$
DECLARE
  _picked integer;
  _total  integer := 0;
BEGIN
  IF p_run IS NULL OR coalesce(p_batch, 0) < 1 THEN
    RAISE EXCEPTION 'mex_history_link_apply: a run id and a batch size are required';
  END IF;
  LOOP
    -- transaction-local: they end with every COMMIT below
    PERFORM set_config('elyon.bulk_repair', 'on', true);
    PERFORM set_config('elyon.keep_updated_at', 'on', true);
    PERFORM set_config('elyon.defer_segments', 'on', true);

    WITH b AS (
      SELECT l.order_id, l.tracking_id, l.expect_status
        FROM public.mex_history_links l
       WHERE l.run_id = p_run AND l.linked_at IS NULL AND l.skipped IS NULL
       ORDER BY l.order_id
       LIMIT p_batch
    ),
    lk AS (                                   -- lock the orders; a concurrent writer waits for the commit
      SELECT o.id, o.status::text AS status, o.mex_tracking_id, o.external_order_id, o.paid_basis
        FROM public.orders o JOIN b ON b.order_id = o.id
       ORDER BY o.id
         FOR UPDATE OF o
    ),
    ok AS (                                   -- still exactly as planned, and the register still has no such row
      SELECT b.order_id, b.tracking_id, lk.paid_basis AS basis_before
        FROM b JOIN lk ON lk.id = b.order_id
       WHERE lk.mex_tracking_id IS NULL AND lk.status = b.expect_status AND lk.external_order_id = b.tracking_id
         AND NOT EXISTS (SELECT 1 FROM public.mex_parcels mp WHERE mp.tracking_id = b.tracking_id)
    ),
    ins AS (                                  -- the parcel arrives LINKED (as mex_upsert_parcels would store it)
      INSERT INTO public.mex_parcels (
        tracking_id, account, status_id, status_name, cod_mkd,
        receiver_name, receiver_city, receiver_phone_raw, phone8, sender_reference,
        created_at_mex, last_update_at, delivered_at, returned_at,
        order_id, link_method, linked_at, first_seen_at, last_seen_at, history_run)
      SELECT s.tracking_id, s.account, s.status_id, s.status_name, s.cod_mkd,
             s.receiver_name, s.receiver_city, s.receiver_phone_raw, s.phone8, s.sender_reference,
             s.created_at_mex, s.last_update_at,
             CASE WHEN s.status_id = 2 THEN s.last_update_at END,
             CASE WHEN s.status_id = 7 THEN s.last_update_at END,
             ok.order_id, 'collabbox_import', now(), s.dump_at, s.dump_at, p_run
        FROM ok JOIN public.mex_history_stage s ON s.tracking_id = ok.tracking_id
      RETURNING tracking_id
    ),
    upd AS (                                  -- ONE update per order: the parcel's facts, and the proof on a paid one
      UPDATE public.orders o
         SET mex_tracking_id    = s.tracking_id,
             mex_account        = s.account,
             mex_status_id      = s.status_id,
             mex_cod_mkd        = s.cod_mkd,
             mex_delivered_at   = CASE WHEN s.status_id = 2 THEN s.last_update_at END,
             mex_returned_at    = CASE WHEN s.status_id = 7 THEN s.last_update_at END,
             mex_last_update_at = s.last_update_at,
             paid_basis         = CASE WHEN o.status = 'paid' THEN 'mex' ELSE o.paid_basis END
        FROM ok JOIN public.mex_history_stage s ON s.tracking_id = ok.tracking_id
       WHERE o.id = ok.order_id
      RETURNING o.id
    ),
    led AS (
      UPDATE public.mex_history_links l
         SET linked_at = now(), paid_basis_before = ok.basis_before
        FROM ok
       WHERE l.run_id = p_run AND l.order_id = ok.order_id
      RETURNING l.order_id
    ),
    skp AS (
      UPDATE public.mex_history_links l
         SET skipped = 'moved since the plan'
        FROM b
       WHERE l.run_id = p_run AND l.order_id = b.order_id
         AND NOT EXISTS (SELECT 1 FROM ok WHERE ok.order_id = b.order_id)
      RETURNING l.order_id
    )
    SELECT (SELECT count(*) FROM b) INTO _picked
      FROM (SELECT count(*) FROM ins) i, (SELECT count(*) FROM upd) u, (SELECT count(*) FROM led) d, (SELECT count(*) FROM skp) k;

    EXIT WHEN _picked = 0;
    _total := _total + _picked;
    COMMIT;
    EXIT WHEN p_max IS NOT NULL AND _total >= p_max;
  END LOOP;
END;
$apply$;

-- ── the undo ────────────────────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE PROCEDURE public.mex_history_link_undo(p_run uuid, p_batch integer DEFAULT 2000)
LANGUAGE plpgsql
AS $undo$
DECLARE
  _picked integer;
BEGIN
  IF p_run IS NULL OR coalesce(p_batch, 0) < 1 THEN
    RAISE EXCEPTION 'mex_history_link_undo: a run id and a batch size are required';
  END IF;
  LOOP
    PERFORM set_config('elyon.bulk_repair', 'on', true);
    PERFORM set_config('elyon.keep_updated_at', 'on', true);
    PERFORM set_config('elyon.defer_segments', 'on', true);

    WITH b AS (
      SELECT l.order_id, l.tracking_id, l.paid_basis_before
        FROM public.mex_history_links l
       WHERE l.run_id = p_run AND l.linked_at IS NOT NULL AND l.undone_at IS NULL
       ORDER BY l.order_id
       LIMIT p_batch
    ),
    upd AS (                                  -- only an order that still holds exactly this parcel goes back
      UPDATE public.orders o
         SET mex_tracking_id = NULL, mex_account = NULL, mex_status_id = NULL, mex_cod_mkd = NULL,
             mex_delivered_at = NULL, mex_returned_at = NULL, mex_last_update_at = NULL,
             paid_basis = CASE WHEN o.status = 'paid' AND o.paid_basis = 'mex' THEN b.paid_basis_before ELSE o.paid_basis END
        FROM b
       WHERE o.id = b.order_id AND o.mex_tracking_id = b.tracking_id
      RETURNING o.id
    ),
    del AS (
      DELETE FROM public.mex_parcels mp
       USING b
       WHERE mp.tracking_id = b.tracking_id AND mp.history_run = p_run AND mp.order_id = b.order_id
      RETURNING mp.tracking_id
    ),
    led AS (
      UPDATE public.mex_history_links l
         SET undone_at = now()
        FROM b
       WHERE l.run_id = p_run AND l.order_id = b.order_id
      RETURNING l.order_id
    )
    SELECT (SELECT count(*) FROM b) INTO _picked
      FROM (SELECT count(*) FROM upd) u, (SELECT count(*) FROM del) d, (SELECT count(*) FROM led) k;

    EXIT WHEN _picked = 0;
    COMMIT;
  END LOOP;
END;
$undo$;

REVOKE ALL ON FUNCTION  public.mex_history_link_plan(uuid)                    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON PROCEDURE public.mex_history_link_apply(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON PROCEDURE public.mex_history_link_undo(uuid, integer)           FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION  public.mex_history_link_plan(uuid)                    TO service_role;
GRANT EXECUTE ON PROCEDURE public.mex_history_link_apply(uuid, integer, integer) TO service_role;
GRANT EXECUTE ON PROCEDURE public.mex_history_link_undo(uuid, integer)           TO service_role;
