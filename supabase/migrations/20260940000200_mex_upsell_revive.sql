-- ============================================================================
-- MEX UPSELL REVIVE — link method 'upsell_revive' (2026-09-28)
--
-- WHY. The 7-day no-parcel rule (20260938000000, APPLY mode since 28.09)
-- cancels an AlterCPA-confirmed order that still has no MEX parcel 7 days after
-- the approval (cancellation_reason 'no_parcel_7d'). Owner rule: when the
-- parcel turns up later, the order goes to shipped and then follows MEX.
-- mex-reconcile did that only when the parcel's COD fits the CRM price
-- (phone_cod + rule C). ~8.3% of BIO NATURAL series-9110 parcels carry a COD
-- that is not the price — an upsell at AlterCPA — and a lone cancelled sale
-- never gets the 'phone_single' fallback, so those cancels stood forever.
--
-- WHAT. mex-reconcile gains ONE narrow path (match.ts pickCandidate): a BIO
-- NATURAL 9110 parcel with a COD > 0, inside the ship window [−3d … +75d], on
-- a phone whose only real sale is our own no_parcel_7d cancel of an AlterCPA
-- order → linked as 'upsell_revive'; rule C then moves the order to the MEX
-- target (shipped / paid / returned). The register must accept the method in
-- both places that enumerate it:
--   mex_parcels_link_method_check  recreated: the 20260934000100 list +
--                                  'upsell_revive'
--   mex_link_parcel()              re-emitted VERBATIM from 20260934000100 (no
--                                  later migration redefines it); the only
--                                  change is the same word in its p_method list
-- A method of its own, not 'phone_single', so every revive stays findable and
-- reversible: mex_parcels WHERE link_method = 'upsell_revive'.
-- Nothing else: no row is written, no trigger, no cron, no grant change
-- (CREATE OR REPLACE keeps the function's ACL and COMMENT). The no-parcel
-- ledger is deliberately NOT touched: no_parcel_rule_items records what the
-- nightly rule did, and its 'cancelled' row stays true after a revive.
--
-- DRIFT GUARD. The function body is replaced whole, so a live hotfix made
-- outside the migrations would be silently reverted. Step 0 fingerprints the
-- live body (-- comments stripped, whitespace collapsed: immune to CRLF and to
-- comment encoding) and accepts only the 20260934000100 body or this file's
-- own (a re-run). Anything else raises, and the whole file rolls back.
--
-- APPLY — Macedonia only, tripwire first, and BEFORE deploying mex-reconcile:
--   node scripts/assert-mk-target.mjs
--   node scripts/apply-migration-mk.mjs 20260940000200_mex_upsell_revive.sql
--   npx supabase functions deploy mex-reconcile --project-ref bmfxhgznttcnnlqloqzp
-- Deployed the other way round, each revive link fails 'unknown link method':
-- counted link_error, the parcel stays unlinked and is retried on the next run
-- — safe, it only waits. Keep clear of the :07/:37 mex-reconcile slots: the
-- ALTER needs a brief ACCESS EXCLUSIVE lock on mex_parcels (lock_timeout 5s).
-- Idempotent: a re-run recreates the same constraint and the same body.
--
-- ROLLBACK: redeploy mex-reconcile without the path; relabel the links
-- (UPDATE mex_parcels SET link_method = 'phone_single' WHERE link_method =
-- 'upsell_revive'); then run steps 1–2 below with 'upsell_revive' removed from
-- both lists.
-- ============================================================================

BEGIN;

-- Fail fast rather than queue the sync behind this file's ACCESS EXCLUSIVE
-- lock on mex_parcels. Transaction-scoped.
SET LOCAL lock_timeout = '5s';

-- ── 0. Drift guard ──────────────────────────────────────────────────────────
DO $guard$
DECLARE
  _fp text;
BEGIN
  SELECT md5(btrim(regexp_replace(regexp_replace(p.prosrc, '--[^\n]*', '', 'g'), '\s+', ' ', 'g')))
    INTO _fp
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.mex_link_parcel(text,uuid,text,boolean)');
  IF _fp IS NULL THEN
    RAISE EXCEPTION '20260940000200: public.mex_link_parcel(text,uuid,text,boolean) is missing — apply 20260934000100 first';
  END IF;
  IF _fp NOT IN ('2e8e3881b2de77ac2b98dd4e29fb2cce',     -- 20260934000100
                 '4a89229c578952173b50250f73bfe7b2') THEN -- this file (a re-run)
    RAISE EXCEPTION '20260940000200: the live mex_link_parcel() is neither the 20260934000100 body nor this one (fingerprint %) — it was changed outside the migrations. Nothing was applied; merge that change into this file first.', _fp;
  END IF;
END
$guard$;

-- ── 1. The register accepts the method ─────────────────────────────────────
-- One statement: the old CHECK goes and the new one is validated in the same
-- short pass over mex_parcels (~30k rows) while the lock is held. Every
-- existing row satisfies it — the old list is a subset of the new one.
ALTER TABLE public.mex_parcels
  DROP CONSTRAINT IF EXISTS mex_parcels_link_method_check,
  ADD CONSTRAINT mex_parcels_link_method_check
    CHECK (link_method IN ('tracking', 'phone_cod', 'phone_single',
                           'collabbox_import', 'repair', 'manual',
                           'unknown_writer', 'name_city', 'upsell_revive'));

COMMENT ON COLUMN public.mex_parcels.link_method IS
  'How order_id was decided: tracking | phone_cod | phone_single | collabbox_import | repair | manual | unknown_writer (an order wrote the tracking id without going through mex_link_parcel) | name_city | upsell_revive (mex-reconcile, 2026-09-28: a BIO NATURAL 9110 parcel whose COD differs from the price, on a phone whose only real sale is a no_parcel_7d AlterCPA cancel; rule C reopens it). May be pre-declared on an unlinked parcel; the trigger keeps a pre-declared method.';

-- ── 2. mex_link_parcel() accepts it too ─────────────────────────────────────
-- VERBATIM from 20260934000100 §5 except the p_method list (+ 'upsell_revive').
-- Same contract: 'missing' | 'already' | 'conflict' | 'linked'.
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
                                          'unknown_writer', 'name_city',
                                          'upsell_revive') THEN
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

NOTIFY pgrst, 'reload schema';

COMMIT;
