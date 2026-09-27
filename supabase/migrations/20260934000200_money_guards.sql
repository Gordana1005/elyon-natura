-- ============================================================================
-- MONEY GUARDS — make "MEX decides money" hold in the database (2026-09-27)
--
-- Standing rule (2026-08-12): AlterCPA decides confirmed-or-dead; MEX ALONE
-- decides shipped / paid / returned. Until now that rule lived only in
-- whichever code path remembered it. This migration puts it in the schema,
-- and adds what a large, careful repair of the money ledger needs:
--
--   1. elyon.bulk_repair — a transaction-local switch that silences the three
--      notification triggers (order paid, order returned, AlterCPA confirm
--      milestones). Every paid/returned flip notifies the sale owner AND every
--      admin; a repair that corrects thousands of orders must not bury the
--      staff in bells that describe no real event.
--   2. trg_orders_block_altercpa_money_insert — an AlterCPA order can never be
--      CREATED as shipped / delivered / paid / returned. Root cause: on
--      2026-09-18 a catch-up inserted 1.344 AlterCPA orders directly as paid
--      (altercpa.ts PHASE_TO_STATUS maps phase 3 "approved" → paid, so any
--      import that is not pending_only creates revenue on insert), booking
--      money no courier had confirmed. No override: the live bridge
--      (import_scope = pending_only) only ever inserts pending.
--   3. cancellation_reason 'no_parcel_7d' — an AlterCPA-confirmed order that
--      got no MEX parcel within 7 days is cancelled under its OWN reason, so
--      it is never mistaken for a customer's decision, and mex-reconcile can
--      revive it (match.ts shipGate, rule C) if the parcel turns up after all.
--   4. orders.paid_basis — WHY an order counts as paid: 'mex' (a delivered
--      MEX parcel), 'operator_ruling', 'legacy_import', 'manual', 'unproven'.
--      A write that makes an order paid without saying why is stamped
--      'manual'; leaving paid clears it. Deliberately NOT backfilled here —
--      a later migration does that.
--   5. data_repair_runs / data_repair_rows — the repair ledger. A dry run
--      records every candidate (before / after / evidence); candidate_hash
--      lets the apply prove it acts on exactly the set that was reviewed.
--      Service role only.
--
-- HOW TO USE THE SWITCH — always transaction-local, never session-level (a
-- session SET on a pooled connection would leak into other clients' work):
--     BEGIN;
--     SET LOCAL elyon.bulk_repair = 'on';      -- or set_config('elyon.bulk_repair', 'on', true)
--     UPDATE public.orders ...;
--     COMMIT;
-- ============================================================================

-- Fail fast rather than queue every orders query behind this migration's
-- ACCESS EXCLUSIVE lock. Transaction-scoped.
SET LOCAL lock_timeout = '5s';

-- ── 1. Schema on orders — ONE statement, ONE validation scan ────────────────
-- Taken first so the strongest lock on orders is acquired up front. paid_basis
-- is nullable with no default (catalog-only). The two CHECKs are validated in
-- a single pass over the 40 MB heap (~105k rows) while the lock is held —
-- sub-second. orders_cancellation_reason_check is recreated from the LIVE
-- definition (2026-09-27) plus 'no_parcel_7d'; every existing row already
-- satisfies it (the old list is a subset of the new one).
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS paid_basis text,
  DROP CONSTRAINT IF EXISTS orders_cancellation_reason_check,
  ADD CONSTRAINT orders_cancellation_reason_check CHECK (
    cancellation_reason IS NULL OR cancellation_reason IN (
      'no_money', 'changed_mind', 'wrong_product', 'bought_elsewhere',
      'family_refused', 'duplicate_order', 'price_too_high', 'not_satisfied',
      'still_using_product', 'not_interested', 'will_call_back', 'other',
      'pending_cleanup', 'stale_pending_cleanup',
      'no_parcel_7d')),
  DROP CONSTRAINT IF EXISTS orders_paid_basis_check,
  ADD CONSTRAINT orders_paid_basis_check CHECK (
    paid_basis IS NULL OR paid_basis IN (
      'mex', 'operator_ruling', 'legacy_import', 'manual', 'unproven'));

COMMENT ON COLUMN public.orders.paid_basis IS
  'Why this order counts as paid: mex (a delivered MEX parcel) | operator_ruling | legacy_import | manual | unproven. NULL whenever status <> paid. A paid write that does not set it is stamped manual (trg_orders_set_paid_basis); an explicit value in the same write survives.';

-- ── 2. The bulk-repair switch in the three notification triggers ────────────
-- Each re-emitted VERBATIM from the LIVE definition (pg_get_functiondef,
-- 2026-09-27); the only change is the first statement. All three are AFTER
-- row triggers, where the return value is ignored — RETURN NEW keeps each
-- function's own convention. Grants and comments are untouched: CREATE OR
-- REPLACE keeps the existing ACL and COMMENT.

CREATE OR REPLACE FUNCTION public.tg_notify_order_paid()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  owner_id uuid;
  label    text;
  amount   text;
  msg      text;
BEGIN
  -- Bulk data repair (SET LOCAL elyon.bulk_repair = 'on'): no bells.
  IF coalesce(current_setting('elyon.bulk_repair', true), '') = 'on' THEN RETURN NEW; END IF;

  owner_id := COALESCE(NEW.confirmed_by_agent_id, NEW.assigned_agent_id);
  label := 'Order ' || COALESCE(NEW.display_id, left(NEW.id::text, 8));
  amount := '€' || trim(to_char(COALESCE(NEW.price, 0), 'FM999999990.00'));
  msg := label || ' (' || COALESCE(NULLIF(NEW.customer_name, ''), NEW.customer_phone, '') || ') was paid — ' || amount || '.';

  -- Agent copy (the sale owner).
  IF owner_id IS NOT NULL THEN
    INSERT INTO public.notifications (user_id, type, title, message, link)
    VALUES (owner_id, 'order_paid', 'Order paid', msg, '/orders');
  END IF;

  -- Admin oversight (exclude owner to avoid a dup).
  INSERT INTO public.notifications (user_id, type, title, message, link)
  SELECT ur.user_id, 'order_paid', 'Order paid', msg, '/orders'
  FROM public.user_roles ur
  WHERE ur.role = 'admin'
    AND ur.user_id <> COALESCE(owner_id, '00000000-0000-0000-0000-000000000000');

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.tg_notify_order_returned()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  owner_id uuid;
  label    text;
  msg      text;
BEGIN
  -- Bulk data repair (SET LOCAL elyon.bulk_repair = 'on'): no bells.
  IF coalesce(current_setting('elyon.bulk_repair', true), '') = 'on' THEN RETURN NEW; END IF;

  owner_id := COALESCE(NEW.confirmed_by_agent_id, NEW.assigned_agent_id);
  label := 'Order ' || COALESCE(NEW.display_id, left(NEW.id::text, 8));
  msg := label || ' (' || COALESCE(NULLIF(NEW.customer_name, ''), NEW.customer_phone, '') || ') was marked Returned.';

  -- Agent copy (the sale owner).
  IF owner_id IS NOT NULL THEN
    INSERT INTO public.notifications (user_id, type, title, message, link)
    VALUES (owner_id, 'order_returned', 'Order returned', msg, '/orders');
  END IF;

  -- Admin oversight (exclude owner to avoid a dup).
  INSERT INTO public.notifications (user_id, type, title, message, link)
  SELECT ur.user_id, 'order_returned', 'Order returned', msg, '/orders'
  FROM public.user_roles ur
  WHERE ur.role = 'admin'
    AND ur.user_id <> COALESCE(owner_id, '00000000-0000-0000-0000-000000000000');

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.tg_altercpa_confirm_rate()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _lead record; _step int; _geo text; _cohort date; _c record;
BEGIN
  -- Bulk data repair (SET LOCAL elyon.bulk_repair = 'on'): no milestone pings.
  IF coalesce(current_setting('elyon.bulk_repair', true), '') = 'on' THEN RETURN NEW; END IF;

  IF NEW.status NOT IN ('confirmed','shipped','delivered','paid','returned') THEN
    RETURN NEW;
  END IF;

  SELECT value #>> '{}' INTO _geo FROM public.app_settings WHERE key = 'altercpa_rate_geo';

  -- orders carry no affiliate columns; the ledger row is the linkage.
  SELECT l.webmaster, l.geo, l.created_remote, l.first_seen_at INTO _lead
  FROM public.altercpa_leads l WHERE l.order_id = NEW.id LIMIT 1;
  -- NOT FOUND, never `_lead IS NULL`: a record tests NULL only when EVERY
  -- field is null, and webmaster alone could legitimately be.
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF upper(COALESCE(_lead.geo, '')) <> upper(COALESCE(_geo, 'MK')) THEN RETURN NEW; END IF;

  SELECT (value #>> '{}')::int INTO _step
  FROM public.app_settings WHERE key = 'altercpa_rate_milestone_step';
  _step := GREATEST(COALESCE(_step, 10), 1);

  -- The cohort is the lead's ARRIVAL day, never today. A 12.08 lead confirmed
  -- on 13.08 updates — and is announced as — the 12.08 cohort. This was the
  -- operator's explicit requirement: the day must never be ambiguous.
  _cohort := (COALESCE(_lead.created_remote, _lead.first_seen_at) AT TIME ZONE public.crm_tz())::date;

  SELECT * INTO _c FROM public.altercpa_rate_cohort(COALESCE(_lead.webmaster,'(none)'), _cohort);
  IF _c.confirmed = 0 OR _c.confirmed % _step <> 0 THEN
    RETURN NEW;
  END IF;

  PERFORM public.notify_altercpa_rate(
    COALESCE(_lead.webmaster,'(none)'), _cohort, 'confirms', _c.confirmed, _c.sent, _c.confirmed);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- A stats ping must NEVER roll back a confirm.
  RETURN NEW;
END;
$function$;

-- ── 3. AlterCPA can never CREATE money ──────────────────────────────────────
-- BEFORE INSERT, AlterCPA rows only (the WHEN clause keeps every other insert
-- path free of even a function call). Updates are untouched: an order still
-- reaches shipped/paid/returned the legitimate way — from the courier.
-- No override, not even elyon.bulk_repair.
CREATE OR REPLACE FUNCTION public.tg_orders_block_altercpa_money_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF NEW.status IN ('paid', 'returned', 'shipped', 'delivered') THEN
    RAISE EXCEPTION 'AlterCPA order % cannot be created as %: AlterCPA decides only confirmed-or-dead; MEX decides money (guard 2026-09-27)',
                    coalesce(NEW.external_order_id, NEW.display_id, NEW.id::text), NEW.status
      USING ERRCODE = 'check_violation',
            HINT = 'Insert it as pending, confirmed, cancelled or trashed; mex-reconcile moves it to shipped / paid / returned from the courier record.';
  END IF;
  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION public.tg_orders_block_altercpa_money_insert() IS
  'BEFORE INSERT on orders WHEN source_type = altercpa: refuses status shipped/delivered/paid/returned. AlterCPA decides only confirmed-or-dead; MEX decides money. Root cause: 1.344 AlterCPA orders inserted as paid on 2026-09-18. No override.';

REVOKE ALL ON FUNCTION public.tg_orders_block_altercpa_money_insert() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_orders_block_altercpa_money_insert ON public.orders;
CREATE TRIGGER trg_orders_block_altercpa_money_insert
BEFORE INSERT ON public.orders
FOR EACH ROW
WHEN (NEW.source_type = 'altercpa')
EXECUTE FUNCTION public.tg_orders_block_altercpa_money_insert();

-- ── 4. paid_basis follows status ────────────────────────────────────────────
-- In a BEFORE UPDATE trigger NEW.paid_basis is the value from the SET list
-- when the write names it, and the OLD value otherwise. So:
--   SET status='paid', paid_basis='mex'   → 'mex' survives (mex-reconcile)
--   SET status='paid'  (from not-paid)    → 'manual'
--   SET status='paid'  (already paid)     → keeps its existing basis
--   SET status=<anything but paid>        → NULL
-- A write that sets paid_basis WITHOUT touching status does not fire this
-- trigger (UPDATE OF status) — that is how the backfill will stamp history.
CREATE OR REPLACE FUNCTION public.tg_orders_set_paid_basis()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF NEW.status = 'paid' AND NEW.paid_basis IS NULL THEN
    NEW.paid_basis := 'manual';
  ELSIF NEW.status <> 'paid' THEN
    NEW.paid_basis := NULL;
  END IF;
  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION public.tg_orders_set_paid_basis() IS
  'BEFORE INSERT OR UPDATE OF status on orders: a paid write without a paid_basis is stamped manual; any non-paid status clears paid_basis. An explicit paid_basis in the same write survives.';

REVOKE ALL ON FUNCTION public.tg_orders_set_paid_basis() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_orders_set_paid_basis ON public.orders;
CREATE TRIGGER trg_orders_set_paid_basis
BEFORE INSERT OR UPDATE OF status ON public.orders
FOR EACH ROW
EXECUTE FUNCTION public.tg_orders_set_paid_basis();

-- ── 5. The repair ledger ────────────────────────────────────────────────────
-- A run is one repair rule applied (or rehearsed) once. Rows keep before /
-- after / evidence per order, so any repair can be explained and reversed.
-- order_id carries NO foreign key on purpose: the ledger must outlive the
-- orders it describes. RLS on, NO policies, no anon/authenticated grants —
-- only the service role (repair scripts, the api edge function) and postgres
-- ever read or write it.
CREATE TABLE IF NOT EXISTS public.data_repair_runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key            text NOT NULL,
  dry_run        boolean NOT NULL DEFAULT true,
  candidate_hash text,
  summary        jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  applied_at     timestamptz,
  applied_by     uuid
);

COMMENT ON TABLE public.data_repair_runs IS
  'One run of a data-repair rule (dry or applied). candidate_hash fingerprints the candidate set so an apply can prove it acts on exactly what was reviewed. Service role only.';

CREATE TABLE IF NOT EXISTS public.data_repair_rows (
  id         bigserial PRIMARY KEY,
  run_id     uuid NOT NULL REFERENCES public.data_repair_runs(id) ON DELETE CASCADE,
  order_id   uuid,
  rule       text,
  before     jsonb,
  after      jsonb,
  evidence   jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.data_repair_rows IS
  'Per-order record of a data-repair run: the rule, the order before and after, and the evidence (e.g. the MEX parcel). order_id has no FK on purpose — the ledger outlives the orders it describes.';

CREATE INDEX IF NOT EXISTS idx_data_repair_rows_run_id
  ON public.data_repair_rows (run_id);
CREATE INDEX IF NOT EXISTS idx_data_repair_rows_order_id
  ON public.data_repair_rows (order_id);

ALTER TABLE public.data_repair_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.data_repair_rows ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.data_repair_runs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.data_repair_rows FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.data_repair_rows_id_seq FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.data_repair_runs TO service_role;
GRANT ALL ON public.data_repair_rows TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.data_repair_rows_id_seq TO service_role;

NOTIFY pgrst, 'reload schema';
