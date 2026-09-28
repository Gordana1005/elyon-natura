-- ============================================================================
-- TELESHOP IMPORT — the ledger + a bulk mode for the segment trigger (2026-09-28)
-- ============================================================================
-- Owner (Mile, 28.09): "From 01.09 teleshop must work fully through our CRM …
-- import the teleshop clients — carefully, legitimately, without garbage,
-- recorded properly and as accurate as every metric we keep."
--
-- scripts/import-teleshop-collabbox.mjs turns the collabBox teleshop documents
-- (Нарачка in 10036 + Нарачка out 10050, series 9100 / 9102) into CRM orders
-- and their komitenti into CRM customers. This migration gives it:
--
--   teleshop_import_documents  THE LEDGER — one row per source document the
--                              import saw, whatever became of it (created /
--                              exists / enriched / conflict / skipped + why).
--   teleshop_import_customers  one row per komitent (collabBox customer):
--                              new / existing / skipped + why, the phone used.
--   segment_recompute_queue    phones whose segment recompute a BULK writer
--   segment_recompute_drain()  deferred (see §3) — and how they are settled.
--
-- Nothing here writes an order. Applying it changes no behaviour for any
-- existing writer: the segment trigger only defers when a transaction sets
-- elyon.defer_segments = 'on' (only bulk importers do).
--
-- §3's TRIGGER is the SAME code as the paused collabBox sync (supabase/paused/
-- 20260939000350_collabbox_sync.sql §2): the LIVE definition (pg_get_functiondef,
-- 2026-09-28) with one block added in front. The DRAIN here is stricter than the
-- paused one: a phone whose recompute fails is marked (failed_at / last_error)
-- and skipped instead of aborting the whole batch — if the paused file is ever
-- applied, give it THIS drain (it would otherwise re-emit the older one).
--
-- After applying: node scripts/engine-fixture-mk.mjs (the engine contract).
-- ============================================================================

SET LOCAL lock_timeout = '5s';

-- ── 1. The document ledger ──────────────────────────────────────────────────
-- PK = DocNumber (which is also the MEX tracking id of its parcel). A re-run
-- updates the row (run_id = the last run that saw it); first_run_id never
-- changes; created_by_run is set only by the run that CREATED order_id — the
-- key --rollback deletes by.
--   outcome  created   an order was created for this document
--            exists    an order with (external_source 'collabbox',
--                      external_order_id = DocNumber) already existed
--            enriched  … and empty fields of it were filled
--            conflict  the parcel (or the tracking id) is held by ANOTHER
--                      order — nothing created, never forced (owner rule)
--            skipped   not a sale / not importable — `reason` says why
CREATE TABLE IF NOT EXISTS public.teleshop_import_documents (
  doc_number        text PRIMARY KEY,
  doc_id            text,
  doc_type_id       text NOT NULL,
  series            text,
  doc_at            timestamptz,
  komitent_id       text,
  author            text,
  amount_mkd        numeric(14, 2),
  price_eur         numeric(12, 2),
  phone8            text,
  phone_source      text
                    CONSTRAINT teleshop_import_documents_phone_source_check
                    CHECK (phone_source IS NULL OR phone_source IN ('registry', 'parcel')),
  customer_phone    text,
  outcome           text NOT NULL
                    CONSTRAINT teleshop_import_documents_outcome_check
                    CHECK (outcome IN ('created', 'exists', 'enriched', 'conflict', 'skipped')),
  reason            text NOT NULL,
  planned_status    text,
  paid_basis        text,
  tracking_id       text,
  parcel_status_id  integer,
  parcel_cod_mkd    integer,
  order_id          uuid REFERENCES public.orders(id) ON DELETE SET NULL,
  related_order_id  uuid REFERENCES public.orders(id) ON DELETE SET NULL,
  flags             text[] NOT NULL DEFAULT '{}'::text[],
  source            text NOT NULL DEFAULT 'crawl'
                    CONSTRAINT teleshop_import_documents_source_check
                    CHECK (source IN ('crawl', 'fetch', 'items')),
  run_id            uuid NOT NULL,
  first_run_id      uuid NOT NULL,
  created_by_run    uuid,
  rolled_back_at    timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.teleshop_import_documents IS
  'Teleshop import ledger (scripts/import-teleshop-collabbox.mjs, 2026-09-28): one row per collabBox teleshop document (Нарачка in 10036 / out 10050) the import saw — outcome created / exists / enriched / conflict / skipped with the reason, the phone used, the planned status and its basis (mex | legacy_import), the parcel, the order it became (order_id) or the order that holds its parcel (related_order_id). created_by_run = the run that created order_id (--rollback deletes by it). Money + PII: business owners only; written only by the importer (service role).';

CREATE INDEX IF NOT EXISTS idx_teleshop_import_documents_run      ON public.teleshop_import_documents (run_id);
CREATE INDEX IF NOT EXISTS idx_teleshop_import_documents_created  ON public.teleshop_import_documents (created_by_run) WHERE created_by_run IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_teleshop_import_documents_order    ON public.teleshop_import_documents (order_id) WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_teleshop_import_documents_outcome  ON public.teleshop_import_documents (outcome, reason);
CREATE INDEX IF NOT EXISTS idx_teleshop_import_documents_komitent ON public.teleshop_import_documents (komitent_id);
CREATE INDEX IF NOT EXISTS idx_teleshop_import_documents_doc_at   ON public.teleshop_import_documents (doc_at);

-- ── 2. The customer (komitent) ledger ───────────────────────────────────────
--   outcome  new                   no CRM order / profile had this phone
--            existing              matched a CRM customer by last-8 digits;
--                                  the CRM's own phone string is reused
--            existing_noncanonical matched, but the CRM only knows the phone
--                                  in a malformed spelling (+38938076222888):
--                                  the new orders carry the CLEAN E.164 (the
--                                  malformed string is never written again);
--                                  listed for a phone repair
--            skipped               not imported — `reason` says why
-- profile_action: inserted (a customer_profiles row was created) · filled
-- (empty fields of an existing profile were filled; profile_before holds what
-- they were and what was written, for --rollback) · none. profile_run_id = the
-- run that inserted / filled it — the key --rollback deletes / restores by, so
-- a later run's rollback removes exactly that run's profiles.
CREATE TABLE IF NOT EXISTS public.teleshop_import_customers (
  komitent_id     text PRIMARY KEY,
  name            text,
  phone8          text,
  phone_raw       text,
  phone_field     text,
  customer_phone  text,
  outcome         text NOT NULL
                  CONSTRAINT teleshop_import_customers_outcome_check
                  CHECK (outcome IN ('new', 'existing', 'existing_noncanonical', 'skipped')),
  reason          text,
  docs            integer NOT NULL DEFAULT 0,
  created_orders  integer NOT NULL DEFAULT 0,
  profile_action  text
                  CONSTRAINT teleshop_import_customers_profile_action_check
                  CHECK (profile_action IS NULL OR profile_action IN ('inserted', 'filled', 'none')),
  profile_before  jsonb,
  profile_run_id  uuid,
  run_id          uuid NOT NULL,
  first_run_id    uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.teleshop_import_customers IS
  'Teleshop import — one row per collabBox komitent the import saw (2026-09-28): new / existing (matched by last-8, the CRM phone string reused) / existing_noncanonical / skipped + reason (employee, company, deceased, do-not-contact, wrong number, test, no valid Macedonian phone, test phone …), and what happened to its customer_profiles row. PII: business owners only; written only by the importer.';

CREATE INDEX IF NOT EXISTS idx_teleshop_import_customers_phone ON public.teleshop_import_customers (customer_phone);
CREATE INDEX IF NOT EXISTS idx_teleshop_import_customers_run   ON public.teleshop_import_customers (run_id);
CREATE INDEX IF NOT EXISTS idx_teleshop_import_customers_profile_run ON public.teleshop_import_customers (profile_run_id) WHERE profile_run_id IS NOT NULL;

ALTER TABLE public.teleshop_import_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.teleshop_import_customers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS teleshop_import_documents_select_owners ON public.teleshop_import_documents;
CREATE POLICY teleshop_import_documents_select_owners ON public.teleshop_import_documents
  FOR SELECT TO authenticated
  USING ((SELECT public.is_business_owner(auth.uid())));

DROP POLICY IF EXISTS teleshop_import_customers_select_owners ON public.teleshop_import_customers;
CREATE POLICY teleshop_import_customers_select_owners ON public.teleshop_import_customers
  FOR SELECT TO authenticated
  USING ((SELECT public.is_business_owner(auth.uid())));

REVOKE ALL ON public.teleshop_import_documents, public.teleshop_import_customers FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.teleshop_import_documents, public.teleshop_import_customers TO authenticated;
GRANT ALL    ON public.teleshop_import_documents, public.teleshop_import_customers TO service_role;

-- ── 3. Deferred segment recompute (BULK writers only) ───────────────────────
-- Every orders INSERT fires trg_orders_segments_insert → recompute_customer_
-- segments(phone) per row. For an import of tens of thousands of orders that
-- is tens of thousands of recomputes inside the import's transactions (and a
-- deadlock risk against the nightly recompute_all_segments). With
-- SET LOCAL elyon.defer_segments = 'on' the trigger QUEUES the phone instead;
-- segment_recompute_drain() (or the nightly recompute_all_segments, which
-- covers every phone) settles the queue once, in the quiet window.
CREATE TABLE IF NOT EXISTS public.segment_recompute_queue (
  phone     text PRIMARY KEY,
  queued_at timestamptz NOT NULL DEFAULT now(),
  source    text
);
-- a phone whose recompute raised: kept (and reported), never retried in a loop
ALTER TABLE public.segment_recompute_queue
  ADD COLUMN IF NOT EXISTS failed_at  timestamptz,
  ADD COLUMN IF NOT EXISTS last_error text;

COMMENT ON TABLE public.segment_recompute_queue IS
  'Phones whose per-row segment recompute a BULK writer deferred (SET LOCAL elyon.defer_segments = ''on''; users: the teleshop import 2026-09-28, the paused collabBox sync). Drained by segment_recompute_drain(); recompute_all_segments() covers it too. Service role only.';

ALTER TABLE public.segment_recompute_queue ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.segment_recompute_queue FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.segment_recompute_queue TO service_role;

-- The LIVE body (2026-09-28), with only the first block added.
CREATE OR REPLACE FUNCTION public.trg_orders_recompute_segments()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Bulk loads (SET LOCAL elyon.defer_segments = 'on'): queue, don't recompute.
  IF coalesce(current_setting('elyon.defer_segments', true), '') = 'on' THEN
    IF TG_OP IN ('UPDATE', 'DELETE') AND coalesce(OLD.customer_phone, '') <> '' THEN
      INSERT INTO public.segment_recompute_queue (phone, source)
      VALUES (OLD.customer_phone, 'deferred') ON CONFLICT (phone) DO NOTHING;
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') AND coalesce(NEW.customer_phone, '') <> '' THEN
      INSERT INTO public.segment_recompute_queue (phone, source)
      VALUES (NEW.customer_phone, 'deferred') ON CONFLICT (phone) DO NOTHING;
    END IF;
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    PERFORM public.recompute_customer_segments(OLD.customer_phone);
    RETURN OLD;
  END IF;

  PERFORM public.recompute_customer_segments(NEW.customer_phone);

  -- If the phone moved, recompute the old phone too
  IF TG_OP = 'UPDATE' AND NEW.customer_phone IS DISTINCT FROM OLD.customer_phone THEN
    PERFORM public.recompute_customer_segments(OLD.customer_phone);
  END IF;

  RETURN NEW;
END;
$function$;

-- Settles the queue: oldest first, p_limit phones per call. One phone's error
-- never aborts the batch: it is marked failed (failed_at, last_error), skipped
-- by later calls and reported by the importer's --drain. NOT to be run
-- concurrently with recompute_all_segments or a bulk writer.
CREATE OR REPLACE FUNCTION public.segment_recompute_drain(p_limit integer DEFAULT 5000)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _phone text;
  _n     integer := 0;
BEGIN
  FOR _phone IN
    SELECT q.phone FROM public.segment_recompute_queue q
     WHERE q.failed_at IS NULL
     ORDER BY q.queued_at, q.phone
     LIMIT greatest(coalesce(p_limit, 5000), 1)
  LOOP
    BEGIN
      PERFORM public.recompute_customer_segments(_phone);
      DELETE FROM public.segment_recompute_queue WHERE phone = _phone;
      _n := _n + 1;
    EXCEPTION WHEN OTHERS THEN
      UPDATE public.segment_recompute_queue
         SET failed_at = now(), last_error = left(SQLERRM, 500)
       WHERE phone = _phone;
    END;
  END LOOP;
  RETURN _n;
END;
$fn$;

COMMENT ON FUNCTION public.segment_recompute_drain(integer) IS
  'Recompute the segments of up to p_limit queued phones (segment_recompute_queue, filled by bulk writers under elyon.defer_segments) and dequeue them; a phone whose recompute raises is marked failed_at / last_error and skipped (never aborts the batch). Returns how many succeeded. Never concurrently with recompute_all_segments or a bulk writer.';

REVOKE ALL ON FUNCTION public.segment_recompute_drain(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.segment_recompute_drain(integer) TO service_role;
