-- ============================================================================
-- collabBOX NIGHTLY SYNC — every sales document, every night at 00:00 Skopje,
-- plus the day's bookings every 30 minutes for the leaderboard   (2026-09-28)
-- ============================================================================
-- Owner (Mile, 28.09.2026 ~23:30): "Why doesn't a collabBox cron run? We need it
-- every day at 00:00 — recording and seeing everything." ~23:55: departments are
-- by FOLDER (the document TYPE), never by the system an order was made in; and a
-- light live mode so an agent's collabBox bookings reach the leaderboard the
-- same day.
--
-- The Edge Function supabase/functions/collabbox-sync reads collabBox (read-only,
-- scripts/collabbox-fetch.mjs PROTOCOL §0–§4 ported to Deno) and calls the
-- writers below. This file is the database half:
--
--   orders.collabbox_doc_type          the collabBox document type an order IS
--   collabbox_doc_role(type)           what a type does in the CRM (THE list)
--   collabbox_department(type, doc, person, at)
--                                      THE department of a collabBox document
--                                      (by type; the series only when the type
--                                      is unknown) — tg_orders_sale_source_fill
--                                      passes the new column
--   collabbox_documents                THE LEDGER: one row per document seen,
--                                      whatever became of it (+ the payload, so
--                                      open documents are retried)
--   collabbox_customers                komitent cards read by the sync (phone,
--                                      name, address, the skip verdict)
--   collabbox_sync_runs                one row per run (nightly / live / manual)
--   collabbox_apply_documents(run, docs, dry)   THE writer (per document:
--                                      create / update / credit / conflict / …)
--   collabbox_record_booked(run, docs) the live mode: today's headers → 'booked'
--   collabbox_retry_open(run, dry, days, limit)  re-apply open ledger rows
--   collabbox_close_window(…)          documents a full re-read no longer finds
--   collabbox_nightly_window(days, max_days)     the nightly re-read window
--   collabbox_komitenti_needed(docs)   which komitent cards the sync must read
--   collabbox_booked_today(day)        the leaderboard's collabBox bookings
--   collabbox_feed_state()             THE freshness (replaces the stub of
--                                      20260939000200, same keys + run keys)
--   invoke_collabbox_sync(mode) + pg_cron 'collabbox-sync' / 'collabbox-live'
--
-- It SUPERSEDES supabase/paused/20260939000350_collabbox_sync.sql — never apply
-- that file after this one (see supabase/paused/README.md). Unlike it, nothing
-- here touches trg_orders_recompute_segments (20260942000300 already holds the
-- queue gate; the nightly volume is small, so the normal per-row recompute runs).
--
-- ── OWNER RULES (28.09.2026 — law) ──────────────────────────────────────────
-- * Idempotency key = DocNumber (= the MEX tracking id): external_source
--   'collabbox', external_order_id = DocNumber (uniq_orders_external_ref).
-- * The TYPE decides (series can lie: 703 LEADS-OUT documents are numbered 9102):
--     10036 Нарачка in   · 10050 Нарачка out · 10106 Социјални Мрежи  → ORDERS
--     10114 LEADS-OUT    → an order ONLY when no order holds / names its parcel,
--                          else the author is credited on that order. Created
--                          only once its MEX parcel exists (a LEADS-OUT booked
--                          in collabBox often has a CRM twin that takes the
--                          parcel — the 20260942000700 leads-out import rule);
--                          until then 'awaiting_parcel', retried 14 days
--     10111 Нарачка LEADS → never an order (it comes through AlterCPA): the
--                          author is credited on the order holding its parcel
--     10055 · 10107 · 10112 · 10099 (and 10063 / 10058) → recorded only
--   Departments (collabbox_department, owner ~23:55, the main session reclasses
--   the existing rows): 10111 altercpa/collabbox_leads (Affiliate – Lead in) ·
--   10114 elyon_crm/collabbox_leads_out (Affiliate – Lead out) · 10050
--   collabbox/teleshop_out (Телешоп – Lead out) · 10036 collabbox/teleshop
--   (Телешоп – Lead in) · 10106 / 10055 collabbox/social. No AlterCPA-team
--   override any more.
-- * Status NEVER from collabBox: parcel 2 → paid (paid_at = delivered_at,
--   paid_basis 'mex') · 7 → returned · other → shipped; no parcel yet →
--   'confirmed' (to pack) with mex_tracking_id = DocNumber, so mex-reconcile's
--   remembered link takes it over. No legacy_import (history is imported).
-- * Never a double count: a parcel another order holds or names, a parcel a live
--   web order claims, a parcel created BEFORE the document (it may never be linked
--   to this order), or a live CRM / AlterCPA sale on the same last-8 phone with no
--   parcel of its own, created 1 day before … 2 days after the document, whose
--   price fits the document → 'conflict', listed, nothing created, never forced.
-- * Replacements (document value 0, goods 0, parcel COD 0) are never orders.
--   Stornos are recorded, never created; the document a storno reverses is marked
--   (ledger reversed_by) and, when THIS sync created its order, the order gets a
--   note — never deleted, never re-statused (MEX decides) — and is listed.
-- * Price = goods value of the lines (ДОСТАВА, ЗАБЕЛЕШКА, ПОЕН / КУПОН / ФЛАЕР
--   excluded) / 61,5 (the FROZEN peg); a parcel COD that fits neither the goods
--   nor goods + 150 wins (CLAUDE.md "COD ≠ CRM price → MEX is right"). Lines →
--   order_items (product via product_aliases / products.sku, classified by the
--   Edge Function); unmapped lines keep their name and are listed on the run.
-- * Phone: the komitent card read tonight → the teleshop import's registry
--   (teleshop_import_customers) → the parcel receiver; strictly +389 + 8 digits
--   (7X, 2, 3[1-4], 4[2-8]); none → 'no_phone', retried 14 days. Komitenti the
--   teleshop import skipped (deceased, employee, company, …) and new cards with
--   those markers are skipped. customer_profiles: insert-only.
-- * Seller: sold_at = the document time, sold_via 'collabbox', sold_by_ext = the
--   author in the identity's own spelling, sold_by_person_id through
--   sales_person_identities (collabbox_author, then order_name; whitespace-
--   normalised). No agent-facing field (confirmed_by_*, assigned_*). A credit on
--   an EXISTING order is NULL → value only and never moves a sale into another
--   month (backfill-sellers-collabbox.mjs's rule).
-- * Bulk guards: elyon.bulk_repair (no bells) + elyon.keep_updated_at, set
--   transaction-locally by the writers.
--
-- ── SCHEDULE (pg_cron is UTC; the gates in invoke_collabbox_sync are Skopje) ──
--   collabbox-sync   '0 22,23 * * *'  → proceeds only at 00:xx Skopje, once a
--                    day (DST-proof: exactly one of the two slots is 00:xx)
--   collabbox-live   '*/30 6-19 * * *' → proceeds 08:00–20:00 Skopje (UTC 6–19
--                    covers both CET and CEST; the gate drops the rest)
-- Both are silent no-ops until the Vault row 'collabbox_sync_secret' exists.
--
-- ── SETUP (docs/handoff/2026-09-28/collabbox-pipeline.md §8, the runbook) ────
--   node scripts/assert-mk-target.mjs
--   node scripts/apply-migration-mk.mjs supabase/migrations/20260942000900_collabbox_nightly_sync.sql
--   npx supabase secrets set COLLABBOX_USER=… COLLABBOX_PASS=… COLLABBOX_SYNC_SECRET=<64 hex> --project-ref bmfxhgznttcnnlqloqzp
--   npx supabase functions deploy collabbox-sync --project-ref bmfxhgznttcnnlqloqzp
--   (dry run one day, then) SELECT vault.create_secret('<the same 64 hex>', 'collabbox_sync_secret');
--   node scripts/engine-fixture-mk.mjs
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 0. What this builds on ──────────────────────────────────────────────────
DO $dep$
BEGIN
  IF to_regclass('public.mex_parcels') IS NULL
     OR to_regprocedure('public.mex_link_parcel(text,uuid,text,boolean)') IS NULL
     OR to_regclass('public.teleshop_import_customers') IS NULL
     OR to_regclass('public.teleshop_import_documents') IS NULL
     OR to_regclass('public.sales_person_identities') IS NULL
     OR to_regclass('public.web_orders') IS NULL
     OR to_regclass('public.altercpa_leads') IS NULL
     OR to_regprocedure('public.is_business_owner(uuid)') IS NULL
     OR to_regprocedure('public.is_report_excluded_phone(text)') IS NULL
     OR to_regprocedure('public.is_synthetic_product_name(text)') IS NULL
     OR to_regprocedure('public.classify_sale_source(text,text,text,uuid,numeric,text)') IS NULL
     OR to_regprocedure('public.elyon_crm_sale_detail(uuid,numeric,text)') IS NULL
     OR to_regprocedure('public.collabbox_department(text,uuid,timestamptz)') IS NULL THEN
    RAISE EXCEPTION '20260942000900: apply the MEX register, sale-source, teleshop-ledger (20260942000300) and department (20260942000700) migrations first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'update_updated_at_column'
                    AND p.prosrc LIKE '%keep_updated_at%') THEN
    RAISE EXCEPTION '20260942000900: update_updated_at_column() does not honour elyon.keep_updated_at — apply 20260939000300 first';
  END IF;
END
$dep$;

-- ── 1. orders.collabbox_doc_type ────────────────────────────────────────────
-- Nullable, no default: catalog-only. The CHECK is NOT VALID (every existing row
-- is NULL; new writes are checked) so no table scan runs under this lock.
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS collabbox_doc_type text;
ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_collabbox_doc_type_check;
ALTER TABLE public.orders ADD CONSTRAINT orders_collabbox_doc_type_check
  CHECK (collabbox_doc_type IS NULL OR collabbox_doc_type ~ '^[0-9]{3,8}$') NOT VALID;

COMMENT ON COLUMN public.orders.collabbox_doc_type IS
  'The collabBox document TYPE this order is (10036 Нарачка in · 10050 Нарачка out · 10106 Социјални Мрежи · 10114 LEADS-OUT · 10111 Нарачка LEADS · …). Set by the collabbox-sync writer on insert and filled once on orders it re-reads; history by scripts/backfill-collabbox-doc-types.mjs. The type decides the department (collabbox_department) — the DocNumber series can lie. NULL = not a collabBox order, or its type is not known yet. Migration 20260942000900.';

-- ── 2. The document TYPE decides ────────────────────────────────────────────
-- What a type does in the CRM. TWIN: DOC_ROLES in supabase/functions/
-- collabbox-sync/collabbox.ts (collabbox.test.ts reads this CASE and fails when
-- the two differ).
CREATE OR REPLACE FUNCTION public.collabbox_doc_role(p_type text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $fn$
  SELECT CASE btrim(coalesce(p_type, ''))
    WHEN '10036' THEN 'order'               -- Нарачка in         (Телешоп – Lead in)
    WHEN '10050' THEN 'order'               -- Нарачка out        (Телешоп – Lead out)
    WHEN '10106' THEN 'order'               -- Социјални Мрежи    (Social)
    WHEN '10114' THEN 'order_unless_held'   -- LEADS-OUT          (Affiliate – Lead out)
    WHEN '10111' THEN 'credit'              -- Нарачка LEADS      (Affiliate – Lead in, via AlterCPA)
    ELSE 'record'                           -- 10055 · 10107 · 10112 · 10099 · 10063 · 10058 · …
  END
$fn$;

COMMENT ON FUNCTION public.collabbox_doc_role(text) IS
  'What a collabBox document type does in the CRM (owner 28.09.2026): order (10036, 10050, 10106) · order_unless_held (10114: an order only when no order holds / names its parcel, else the author is credited on that order) · credit (10111: never an order — the author is credited on the order holding its parcel) · record (everything else: ledger only). TWIN: collabbox.ts DOC_ROLES. Migration 20260942000900.';

-- THE department of a collabBox document: by TYPE when known, else by the
-- DocNumber series. p_person / p_at are kept in the signature so a person- or
-- date-based rule can come back without touching a caller (the owner is still
-- deciding whether "affiliate out" becomes a department of its own) — today
-- they are not used: the AlterCPA-team override is gone (owner ~23:55).
CREATE OR REPLACE FUNCTION public.collabbox_department(
  p_doc_type          text,
  p_external_order_id text,
  p_person            uuid,
  p_at                timestamptz)
RETURNS text[]
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $fn$
  SELECT CASE
           WHEN t.typ = '10111'               THEN ARRAY['altercpa',  'collabbox_leads']      -- Affiliate – Lead in
           WHEN t.typ = '10114'               THEN ARRAY['elyon_crm', 'collabbox_leads_out']  -- Affiliate – Lead out
           WHEN t.typ = '10050'               THEN ARRAY['collabbox', 'teleshop_out']         -- Телешоп – Lead out
           WHEN t.typ = '10036'               THEN ARRAY['collabbox', 'teleshop']             -- Телешоп – Lead in
           WHEN t.typ IN ('10106', '10055')   THEN ARRAY['collabbox', 'social']
           -- the type is unknown (or records only): the DocNumber series
           WHEN t.ser = '9110'                THEN ARRAY['altercpa',  'collabbox_leads']
           WHEN t.ser = '9103'                THEN ARRAY['elyon_crm', 'collabbox_leads_out']
           WHEN t.ser = '9102'                THEN ARRAY['collabbox', 'teleshop_out']
           WHEN t.ser = '9100'                THEN ARRAY['collabbox', 'teleshop']
           WHEN t.ser IN ('9108', '1300')     THEN ARRAY['collabbox', 'social']
         END
    FROM (SELECT nullif(btrim(coalesce(p_doc_type, '')), '') AS typ,
                 split_part(coalesce(p_external_order_id, ''), '-', 2) AS ser) t;
$fn$;

COMMENT ON FUNCTION public.collabbox_department(text, text, uuid, timestamptz) IS
  'THE department of a collabBox document, {sale_source, detail} (owner 28.09.2026 ~23:55, departments by folder): by TYPE — 10111 altercpa/collabbox_leads · 10114 elyon_crm/collabbox_leads_out · 10050 collabbox/teleshop_out · 10036 collabbox/teleshop · 10106, 10055 collabbox/social — else by the DocNumber series (9110 · 9103 · 9102 · 9100 · 9108/1300 alike); NULL for anything else (classify_sale_source stands). p_person / p_at are unused today (no team override). Called by tg_orders_sale_source_fill at INSERT. Migration 20260942000900.';

-- The 3-argument form stays for its callers (scripts/import-leads-out-collabbox.mjs,
-- scripts/reclass-department-sources.mjs): the series fallback of the one mapping.
CREATE OR REPLACE FUNCTION public.collabbox_department(p_external_order_id text, p_person uuid, p_at timestamptz)
RETURNS text[]
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $fn$
  SELECT public.collabbox_department(NULL::text, p_external_order_id, p_person, p_at);
$fn$;

COMMENT ON FUNCTION public.collabbox_department(text, uuid, timestamptz) IS
  'Compatibility form: collabbox_department(NULL type, DocNumber, person, at) — the DocNumber-series fallback of THE mapping (the 4-argument form). Migration 20260942000900.';

-- tg_orders_sale_source_fill: the LIVE body (pg_get_functiondef, 28.09.2026 —
-- 20260942000700) with ONE change: the department is asked with the type.
CREATE OR REPLACE FUNCTION public.tg_orders_sale_source_fill()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _o record;
  _c text[];
  _d text[];
BEGIN
  IF NEW.sale_source IS NOT NULL THEN
    RETURN NEW;
  END IF;

  BEGIN
    IF NEW.duplicated_from IS NOT NULL THEN
      SELECT o.sale_source, o.sale_source_detail, o.source_type, o.external_source,
             o.external_order_id, o.prediction_list_id, o.price, o.product_name
        INTO _o
        FROM public.orders o
       WHERE o.id = NEW.duplicated_from;
      IF FOUND THEN
        IF _o.sale_source IS NOT NULL THEN
          NEW.sale_source        := _o.sale_source;
          NEW.sale_source_detail := _o.sale_source_detail;
        ELSE
          _c := public.classify_sale_source(_o.source_type, _o.external_source, _o.external_order_id,
                                            _o.prediction_list_id, _o.price, _o.product_name);
          NEW.sale_source        := _c[1];
          NEW.sale_source_detail := _c[2];
        END IF;
        -- A copy of a CRM order is a CRM order, but whether it is a SALE is its own business
        -- (20260942000400). A copy made in the CRM of a collabBox lead-out row is a CRM row too.
        IF NEW.sale_source = 'elyon_crm' THEN
          NEW.sale_source_detail := public.elyon_crm_sale_detail(
            coalesce(NEW.prediction_list_id, _o.prediction_list_id), NEW.price, NEW.product_name);
        END IF;
        RETURN NEW;
      END IF;
    END IF;

    _c := public.classify_sale_source(NEW.source_type, NEW.external_source, NEW.external_order_id,
                                      NEW.prediction_list_id, NEW.price, NEW.product_name);
    NEW.sale_source        := _c[1];
    NEW.sale_source_detail := _c[2];
    -- a collabBox document belongs to its department — by its TYPE when the writer knows it
    -- (orders.collabbox_doc_type, 20260942000900), else by its series (20260942000700)
    IF NEW.sale_source = 'collabbox' THEN
      _d := public.collabbox_department(NEW.collabbox_doc_type, NEW.external_order_id,
                                        NEW.sold_by_person_id, coalesce(NEW.sold_at, NEW.created_at));
      IF _d IS NOT NULL THEN
        NEW.sale_source        := _d[1];
        NEW.sale_source_detail := _d[2];
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NEW.sale_source        := NULL;
    NEW.sale_source_detail := NULL;
  END;
  RETURN NEW;
END;
$function$;

-- ── 3. The run log ──────────────────────────────────────────────────────────
-- One row per Edge Function run that wrote (a dry run writes nothing, not even
-- this). run_day = the Skopje date the run started — invoke_collabbox_sync's
-- once-a-day gate reads it. Counters are bumped by the writers in the same
-- transaction as the writes they count; stats (lists, samples, per-day fetch
-- figures) are written by the function when it finishes.
CREATE TABLE IF NOT EXISTS public.collabbox_sync_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind              text NOT NULL
                    CONSTRAINT collabbox_sync_runs_kind_check
                    CHECK (kind IN ('nightly', 'live', 'manual')),
  trigger_kind      text NOT NULL DEFAULT 'manual'
                    CONSTRAINT collabbox_sync_runs_trigger_check
                    CHECK (trigger_kind IN ('cron', 'manual')),
  run_day           date NOT NULL DEFAULT ((now() AT TIME ZONE 'Europe/Skopje')::date),
  status            text NOT NULL DEFAULT 'running'
                    CONSTRAINT collabbox_sync_runs_status_check
                    CHECK (status IN ('running', 'ok', 'partial', 'failed')),
  window_from       date,
  window_to         date,
  doc_types         text[],
  requests          integer NOT NULL DEFAULT 0,   -- HTTP requests to collabBox
  fetched           integer NOT NULL DEFAULT 0,   -- documents read (headers)
  lines_read        integer NOT NULL DEFAULT 0,
  created           integer NOT NULL DEFAULT 0,
  updated           integer NOT NULL DEFAULT 0,
  unchanged         integer NOT NULL DEFAULT 0,   -- 'exists': already an order, nothing to do
  conflicts         integer NOT NULL DEFAULT 0,
  replacements      integer NOT NULL DEFAULT 0,
  no_phone          integer NOT NULL DEFAULT 0,
  credited          integer NOT NULL DEFAULT 0,
  unmapped_lines    integer NOT NULL DEFAULT 0,   -- goods lines of CREATED orders with no catalogue product
  recorded          integer NOT NULL DEFAULT 0,
  skipped           integer NOT NULL DEFAULT 0,
  pending           integer NOT NULL DEFAULT 0,   -- awaiting_parcel · credit_pending · no_items
  stornos           integer NOT NULL DEFAULT 0,
  errors            integer NOT NULL DEFAULT 0,
  booked            integer NOT NULL DEFAULT 0,   -- live mode: headers recorded as 'booked'
  vanished          integer NOT NULL DEFAULT 0,
  komitenti_fetched integer NOT NULL DEFAULT 0,
  stats             jsonb NOT NULL DEFAULT '{}'::jsonb,
  error             text,
  warning           text,
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  duration_ms       integer
);

COMMENT ON TABLE public.collabbox_sync_runs IS
  'collabbox-sync runs (2026-09-28): nightly (00:00 Skopje, the last 3 days re-read with line items, orders written) · live (every 30 min 08–20 Skopje, today''s headers → ledger ''booked'') · manual (a window by hand). Counters are bumped by the writers atomically with their writes; stats holds the lists (conflicts, no-phone, unmapped lines, stornos, vanished documents) and per-day fetch figures. A dry run writes no row. Freshness: collabbox_feed_state(). Owners read; service role writes.';

CREATE INDEX IF NOT EXISTS idx_collabbox_sync_runs_kind_started
  ON public.collabbox_sync_runs (kind, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_collabbox_sync_runs_day
  ON public.collabbox_sync_runs (kind, run_day);

-- ── 4. Komitent cards read by the sync ──────────────────────────────────────
-- Documents carry the komitent id, never a phone. The sync reads the card
-- (Коминтенти, comp=infocc) of a komitent it cannot resolve otherwise; the
-- teleshop import's registry (teleshop_import_customers, 70k komitenti) and the
-- parcel's receiver cover the rest. source 'parcel' = no card yet, the phone the
-- parcel of one of its documents carried (used for its later parcel-less
-- documents only after the card and the teleshop registry).
CREATE TABLE IF NOT EXISTS public.collabbox_customers (
  komitent_id    text PRIMARY KEY,
  object_id      text,
  name           text,
  phone8         text,
  phone_field    text,
  phone_raw      text,
  city           text,
  address        text,
  skip_reason    text,
  flags          text[] NOT NULL DEFAULT '{}'::text[],
  source         text NOT NULL DEFAULT 'card'
                 CONSTRAINT collabbox_customers_source_check CHECK (source IN ('card', 'parcel')),
  run_id         uuid,
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.collabbox_customers IS
  'collabBox komitent cards the sync read (2026-09-28): phone8 (strict Macedonian NSN, Мобилен first), name, city, address, the skip verdict (employee · company · deceased · wrong_number · test) and flags (do_not_contact). source parcel = no card, the phone a parcel of its document carried. PII — business owners only; written only by the collabbox-sync writer.';

-- ── 5. THE LEDGER ───────────────────────────────────────────────────────────
-- One row per collabBox document the sync saw (nightly or live), whatever
-- became of it. PK = DocNumber = the MEX tracking id of its parcel.
--   outcome — what the LAST pass decided:
--     booked          live mode: header only, not processed yet
--     created         this pass created order_id
--     exists          the document already is an order, nothing to do
--     updated         … and something was filled / corrected on it
--     credited        its author was credited on the order holding its parcel
--     recorded        ledger only (a record type, or nothing to credit)
--     conflict        another order / a web order holds its parcel, the parcel
--                     predates it, or a CRM twin — nothing created (related_order_id)
--     replacement     value 0 / goods 0 / parcel COD 0 — never an order
--     storno          a reversal document (reverses_doc = what it reverses)
--     skipped         not importable (reason)
--     no_phone · awaiting_parcel · credit_pending   open — retried for 14 days
--     no_items        its day's line items could not be read — re-read next night
--     error           the writer raised (reason) — retried
--   created_by_sync — THIS sync created order_id (never cleared)
--   payload         — the document as the function sent it (header, classified
--                     lines, komitent card): what the retry pass re-applies
CREATE TABLE IF NOT EXISTS public.collabbox_documents (
  doc_number        text PRIMARY KEY,
  doc_id            text,
  object_id         text,
  doc_type_id       text NOT NULL,
  doc_type_name     text,
  role              text NOT NULL
                    CONSTRAINT collabbox_documents_role_check
                    CHECK (role IN ('order', 'order_unless_held', 'credit', 'record')),
  series            text GENERATED ALWAYS AS (
                      CASE WHEN doc_number ~ '^[0-9]{3}-[0-9]{4}-' THEN split_part(doc_number, '-', 2) END
                    ) STORED,
  doc_at            timestamptz NOT NULL,
  komitent_id       text,
  komitent_name     text,
  author            text,
  author_person_id  uuid REFERENCES public.sales_people(id) ON DELETE SET NULL,
  amount_mkd        numeric(14, 2),
  goods_mkd         numeric(14, 2),
  delivery_mkd      numeric(14, 2),
  price_eur         numeric(12, 2),
  lines_n           integer NOT NULL DEFAULT 0,
  lines_complete    boolean NOT NULL DEFAULT false,
  unmapped_lines    integer NOT NULL DEFAULT 0,
  is_storno         boolean NOT NULL DEFAULT false,
  reverses_doc      text,
  reversed_by       text,
  phone8            text,
  phone_source      text
                    CONSTRAINT collabbox_documents_phone_source_check
                    CHECK (phone_source IS NULL OR phone_source IN ('card', 'teleshop_import', 'parcel', 'parcel_registry')),
  customer_phone    text,
  outcome           text NOT NULL
                    CONSTRAINT collabbox_documents_outcome_check
                    CHECK (outcome IN ('booked', 'created', 'exists', 'updated', 'credited', 'recorded',
                                       'conflict', 'replacement', 'storno', 'skipped', 'no_phone',
                                       'awaiting_parcel', 'credit_pending', 'no_items', 'error')),
  reason            text,
  department        text[],
  planned_status    text,
  paid_basis        text,
  parcel_status_id  integer,
  parcel_cod_mkd    integer,
  order_id          uuid REFERENCES public.orders(id) ON DELETE SET NULL,
  related_order_id  uuid REFERENCES public.orders(id) ON DELETE SET NULL,
  created_by_sync   boolean NOT NULL DEFAULT false,
  created_run_id    uuid,
  credit            text,
  flags             text[] NOT NULL DEFAULT '{}'::text[],
  attempts          integer NOT NULL DEFAULT 1,
  first_run_id      uuid,
  run_id            uuid,
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  vanished_at       timestamptz,
  payload           jsonb,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.collabbox_documents IS
  'collabBox document ledger (collabbox-sync, 2026-09-28): one row per sales document seen — type, role, author (+ person), amount, goods, the outcome of the last pass (booked · created · exists · updated · credited · recorded · conflict · replacement · storno · skipped · no_phone · awaiting_parcel · credit_pending · no_items · error) and why, the order it is (order_id) or the order in its way (related_order_id), created_by_sync, storno links, vanished_at (a full re-read no longer found it) and the payload the retry pass re-applies. PK DocNumber = the MEX tracking id. Money + PII: business owners only; written only by the collabbox-sync writers.';

CREATE INDEX IF NOT EXISTS idx_collabbox_documents_doc_at   ON public.collabbox_documents (doc_at);
CREATE INDEX IF NOT EXISTS idx_collabbox_documents_type_at  ON public.collabbox_documents (doc_type_id, doc_at);
CREATE INDEX IF NOT EXISTS idx_collabbox_documents_outcome  ON public.collabbox_documents (outcome, doc_at);
CREATE INDEX IF NOT EXISTS idx_collabbox_documents_komitent ON public.collabbox_documents (komitent_id) WHERE komitent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_collabbox_documents_order    ON public.collabbox_documents (order_id) WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_collabbox_documents_related  ON public.collabbox_documents (related_order_id) WHERE related_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_collabbox_documents_run      ON public.collabbox_documents (run_id);

-- ── 6. RLS — business owners read, the service role writes ──────────────────
ALTER TABLE public.collabbox_sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.collabbox_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.collabbox_documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS collabbox_sync_runs_select_owners ON public.collabbox_sync_runs;
CREATE POLICY collabbox_sync_runs_select_owners ON public.collabbox_sync_runs
  FOR SELECT TO authenticated USING ((SELECT public.is_business_owner(auth.uid())));
DROP POLICY IF EXISTS collabbox_customers_select_owners ON public.collabbox_customers;
CREATE POLICY collabbox_customers_select_owners ON public.collabbox_customers
  FOR SELECT TO authenticated USING ((SELECT public.is_business_owner(auth.uid())));
DROP POLICY IF EXISTS collabbox_documents_select_owners ON public.collabbox_documents;
CREATE POLICY collabbox_documents_select_owners ON public.collabbox_documents
  FOR SELECT TO authenticated USING ((SELECT public.is_business_owner(auth.uid())));

REVOKE ALL ON public.collabbox_sync_runs, public.collabbox_customers, public.collabbox_documents
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.collabbox_sync_runs, public.collabbox_customers, public.collabbox_documents TO authenticated;
GRANT ALL    ON public.collabbox_sync_runs, public.collabbox_customers, public.collabbox_documents TO service_role;

-- ── 7. Small pure helpers ───────────────────────────────────────────────────
-- "2026-09-25T20:17:03" | "2026-09-25 20:17" | "2026-09-25" | "25.09.2026 20:17:03"
-- (Skopje wall clock, no offset) → timestamptz, DST-exact. A date alone = 12:00.
CREATE OR REPLACE FUNCTION public.collabbox_parse_local(p_value text)
RETURNS timestamptz
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $fn$
  SELECT CASE
    WHEN s.v ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}(:[0-9]{2})?$'
     AND pg_input_is_valid(replace(s.v, 'T', ' '), 'timestamp')
      THEN replace(s.v, 'T', ' ')::timestamp AT TIME ZONE 'Europe/Skopje'
    WHEN s.v ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND pg_input_is_valid(s.v, 'date')
      THEN (s.v::date + time '12:00') AT TIME ZONE 'Europe/Skopje'
    WHEN s.v ~ '^[0-9]{2}\.[0-9]{2}\.[0-9]{4} [0-9]{2}:[0-9]{2}(:[0-9]{2})?$'
     AND pg_input_is_valid(substr(s.v, 7, 4) || '-' || substr(s.v, 4, 2) || '-' || substr(s.v, 1, 2) || substr(s.v, 11), 'timestamp')
      THEN (substr(s.v, 7, 4) || '-' || substr(s.v, 4, 2) || '-' || substr(s.v, 1, 2) || substr(s.v, 11))::timestamp
           AT TIME ZONE 'Europe/Skopje'
    WHEN s.v ~ '^[0-9]{2}\.[0-9]{2}\.[0-9]{4}$'
     AND pg_input_is_valid(substr(s.v, 7, 4) || '-' || substr(s.v, 4, 2) || '-' || substr(s.v, 1, 2), 'date')
      THEN ((substr(s.v, 7, 4) || '-' || substr(s.v, 4, 2) || '-' || substr(s.v, 1, 2))::date + time '12:00')
           AT TIME ZONE 'Europe/Skopje'
  END
  FROM (SELECT btrim(coalesce(p_value, '')) AS v) s;
$fn$;

-- A number as the function sends it (JSON number or "1234.5"); anything else NULL.
CREATE OR REPLACE FUNCTION public.collabbox_num(p_value text)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $fn$
  SELECT CASE WHEN btrim(coalesce(p_value, '')) ~ '^-?[0-9]+(\.[0-9]+)?$' THEN btrim(p_value)::numeric END;
$fn$;

-- A strict Macedonian national number (8 digits: 7X mobile, 2 Skopje, 3[1-4] /
-- 4[2-8] area codes) or NULL — never a rewritten fake +389 number.
-- TWIN: MK_NSN_RE in collabbox.ts and scripts/lib/teleshop-import.mjs.
CREATE OR REPLACE FUNCTION public.collabbox_mk_phone8(p_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $fn$
  SELECT CASE WHEN btrim(coalesce(p_value, '')) ~ '^(7[0-9]{7}|2[0-9]{7}|3[1-4][0-9]{6}|4[2-8][0-9]{6})$'
              THEN btrim(p_value) END;
$fn$;

-- Sum two {key: count} objects.
CREATE OR REPLACE FUNCTION public.collabbox_merge_counts(p_a jsonb, p_b jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $fn$
  SELECT coalesce(jsonb_object_agg(k, n), '{}'::jsonb)
    FROM (SELECT e.key AS k, sum(CASE WHEN jsonb_typeof(e.value) = 'number' THEN (e.value)::numeric ELSE 0 END) AS n
            FROM (SELECT * FROM jsonb_each(coalesce(p_a, '{}'::jsonb))
                  UNION ALL
                  SELECT * FROM jsonb_each(coalesce(p_b, '{}'::jsonb))) e
           GROUP BY e.key) s;
$fn$;

-- The seller behind a collabBox author: the identity's person and its OWN
-- spelling (the stamping cron and Settings → Teams match sold_by_ext exactly;
-- the HTML collapses the double spaces the identities keep). collabbox_author
-- first, then order_name — the order the stamping cron uses for sold_via
-- collabbox. Always one row: (NULL, NULL) for no author, (NULL, author) when
-- nobody is named yet.
CREATE OR REPLACE FUNCTION public.collabbox_author_identity(p_author text)
RETURNS TABLE (person_id uuid, ext text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT i.person_id, coalesce(i.value, a.author)
    FROM (SELECT nullif(regexp_replace(btrim(coalesce(p_author, '')), '\s+', ' ', 'g'), '') AS author) a
    LEFT JOIN LATERAL (
      SELECT x.person_id, x.value
        FROM public.sales_person_identities x
       WHERE a.author IS NOT NULL
         AND x.account_id IS NULL
         AND x.kind IN ('collabbox_author', 'order_name')
         AND regexp_replace(btrim(x.value), '\s+', ' ', 'g') = a.author
       ORDER BY (x.kind = 'collabbox_author') DESC, x.created_at
       LIMIT 1) i ON true;
$fn$;

-- order_items for a created order: one row per goods line (qty > 0 or value > 0),
-- totals proportional to the line values and summing EXACTLY to the order price
-- (the cents remainder on the largest line); all-zero lines: the first carries it.
CREATE OR REPLACE FUNCTION public.collabbox_items(p_lines jsonb, p_price numeric)
RETURNS TABLE (product_id uuid, product_name text, quantity integer, price_per_unit numeric, total_price numeric, ord bigint)
LANGUAGE sql
IMMUTABLE
AS $fn$
  WITH l AS (
    SELECT x.ord,
           CASE WHEN (x.v ->> 'product_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                THEN (x.v ->> 'product_id')::uuid END AS pid,
           left(coalesce(nullif(btrim(x.v ->> 'name'), ''), '—'), 300) AS nm,
           greatest(ceil(coalesce(public.collabbox_num(x.v ->> 'qty'), 0)), 1)::integer AS q,
           greatest(coalesce(public.collabbox_num(x.v ->> 'value_mkd'), 0), 0) AS v
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_lines) = 'array' THEN p_lines ELSE '[]'::jsonb END)
           WITH ORDINALITY AS x(v, ord)
  ), t AS (
    SELECT l.*, sum(l.v) OVER () AS vsum, row_number() OVER (ORDER BY l.v DESC, l.ord) AS rk FROM l
  ), s AS (
    SELECT t.*, CASE WHEN t.vsum > 0 THEN round(p_price * t.v / t.vsum, 2)
                     WHEN t.rk = 1 THEN round(p_price, 2)
                     ELSE 0 END AS share
      FROM t
  ), f AS (
    SELECT s.*, round(p_price, 2) - sum(s.share) OVER () AS rest FROM s
  )
  SELECT f.pid, f.nm, f.q,
         round((f.share + CASE WHEN f.rk = 1 THEN f.rest ELSE 0 END) / f.q, 2),
         f.share + CASE WHEN f.rk = 1 THEN f.rest ELSE 0 END,
         f.ord
    FROM f
   ORDER BY f.ord;
$fn$;

-- ── 8. Crediting the author on an order (NULL → value only) ──────────────────
-- Returns: stamped · stamped_no_person · person_filled (already stamped with this
-- very author, person now known) · already (credited via collabbox) ·
-- other_decider (credited by another rule — never overwritten) · not_a_sale ·
-- doc_predates_order (the document is > 48 h older than the order: an earlier
-- sale's parcel) · parcel_shared (another order also holds / names it) ·
-- no_author. sold_at = the document time, unless that moves the sale into another
-- Skopje month than its cohort day (AlterCPA decision, confirmed_at, created_at)
-- — then the cohort day (backfill-sellers-collabbox.mjs: closed months never move).
CREATE OR REPLACE FUNCTION public.collabbox_credit_order(
  p_order    uuid,
  p_doc      text,
  p_doc_at   timestamptz,
  p_author   text,
  p_dry      boolean)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _o       record;
  _person  uuid;
  _ext     text;
  _cohort  timestamptz;
  _sold_at timestamptz;
BEGIN
  IF p_order IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT i.person_id, i.ext INTO _person, _ext FROM public.collabbox_author_identity(p_author) i;
  IF _ext IS NULL THEN
    RETURN 'no_author';
  END IF;

  SELECT o.id, o.status::text AS status, o.price, o.product_name, o.created_at, o.confirmed_at,
         o.mex_tracking_id, o.sold_at, o.sold_via, o.sold_by_ext, o.sold_by_person_id
    INTO _o
    FROM public.orders o
   WHERE o.id = p_order;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF _o.sold_at IS NOT NULL OR _o.sold_via IS NOT NULL OR _o.sold_by_ext IS NOT NULL
     OR _o.sold_by_person_id IS NOT NULL THEN
    IF _o.sold_by_person_id IS NULL AND _person IS NOT NULL
       AND _o.sold_via = 'collabbox' AND _o.sold_by_ext = _ext THEN
      IF NOT p_dry THEN
        UPDATE public.orders SET sold_by_person_id = _person
         WHERE id = p_order AND sold_by_person_id IS NULL;
      END IF;
      RETURN 'person_filled';
    END IF;
    RETURN CASE WHEN _o.sold_via = 'collabbox' THEN 'already' ELSE 'other_decider' END;
  END IF;

  IF _o.status = 'duplicated' OR coalesce(_o.price, 0) <= 0
     OR public.is_synthetic_product_name(_o.product_name) THEN
    RETURN 'not_a_sale';
  END IF;
  -- a sale now, or MEX moves this very parcel (a cancelled lead that shipped — the cohort counts it)
  IF _o.status NOT IN ('confirmed', 'shipped', 'delivered', 'paid', 'returned')
     AND _o.mex_tracking_id IS DISTINCT FROM p_doc THEN
    RETURN 'not_a_sale';
  END IF;
  IF p_doc_at < _o.created_at - interval '48 hours' THEN
    RETURN 'doc_predates_order';
  END IF;
  IF EXISTS (SELECT 1 FROM public.orders x WHERE x.mex_tracking_id = p_doc AND x.id <> p_order)
     OR EXISTS (SELECT 1 FROM public.mex_parcels m
                 WHERE m.tracking_id = p_doc AND m.order_id IS NOT NULL AND m.order_id <> p_order) THEN
    RETURN 'parcel_shared';
  END IF;

  SELECT coalesce(max(l.decided_at), _o.confirmed_at, _o.created_at) INTO _cohort
    FROM public.altercpa_leads l
   WHERE l.order_id = p_order AND l.decision IN ('approved', 'cancel_other') AND l.decided_at IS NOT NULL;
  _sold_at := CASE WHEN to_char(p_doc_at AT TIME ZONE 'Europe/Skopje', 'YYYY-MM')
                      = to_char(_cohort AT TIME ZONE 'Europe/Skopje', 'YYYY-MM')
                   THEN p_doc_at ELSE _cohort END;

  IF NOT p_dry THEN
    UPDATE public.orders o
       SET sold_at = _sold_at, sold_via = 'collabbox', sold_by_ext = _ext, sold_by_person_id = _person
     WHERE o.id = p_order
       AND o.sold_at IS NULL AND o.sold_via IS NULL AND o.sold_by_ext IS NULL AND o.sold_by_person_id IS NULL;
    IF NOT FOUND THEN
      RETURN 'already';
    END IF;
  END IF;
  RETURN CASE WHEN _person IS NULL THEN 'stamped_no_person' ELSE 'stamped' END;
END;
$fn$;

COMMENT ON FUNCTION public.collabbox_credit_order(uuid, text, timestamptz, text, boolean) IS
  'Internal (collabbox-sync): credit a collabBox author as the seller of an order — NULL → value only (write-once sold_*), sold_via collabbox, the identity''s spelling and person; sold_at = the document time unless that crosses a Skopje month. Returns stamped · stamped_no_person · person_filled · already · other_decider · not_a_sale · doc_predates_order · parcel_shared · no_author. Migration 20260942000900.';

-- ── 9. ONE document ─────────────────────────────────────────────────────────
-- Internal; collabbox_apply_documents runs it per document in its own
-- subtransaction. p_doc (collabbox.ts SyncDoc):
--   { doc_number, doc_id, object_id, type_id, type_name, komitent_id,
--     komitent_name, amount_mkd, doc_at ("YYYY-MM-DDTHH:MM:SS" Skopje),
--     author, lines_complete, storno, reverses, reversed_by, flags[],
--     name_skip, name_flags[],
--     lines: [{ code, name, qty, value_mkd, role goods|delivery|note|marker,
--               product_id, product_name }],
--     komitent: { komitent_id, object_id, name, phone8, phone_field, phone_raw,
--                 city, address, skip_reason, flags[] } | null }
-- p_dry: reads only — the result is what apply would do.
CREATE OR REPLACE FUNCTION public.collabbox_apply_one(p_run uuid, p_doc jsonb, p_dry boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
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
      _status := CASE _p.status_id WHEN 2 THEN 'paid' WHEN 7 THEN 'returned' ELSE 'shipped' END;
      _shipped_at := coalesce(_p.created_at_mex, _doc_at);
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
    _reason := CASE WHEN _has_p THEN 'parcel_' || _status ELSE 'to_pack' END;

    IF NOT p_dry THEN
      BEGIN
        INSERT INTO public.orders (
               product_id, product_name, customer_name, customer_phone, customer_city, customer_address,
               price, quantity, status, source_type, external_source, external_order_id, delivery_type,
               created_at, confirmed_at, sold_at, sold_via, sold_by_ext, sold_by_person_id,
               mex_tracking_id, paid_at, paid_basis, shipped_at, returned_at, collabbox_doc_type)
        VALUES (_top, coalesce(_pname, c_no_items), _cname, _phone, _city, _address,
                _price, _qty, _status::public.order_status, 'import', 'collabbox', _doc, 'home',
                _doc_at, _doc_at,
                CASE WHEN _ext IS NOT NULL THEN _doc_at END,
                CASE WHEN _ext IS NOT NULL THEN 'collabbox' END,
                _ext, _person,
                _doc, _paid_at, _basis, _shipped_at, _ret_at, _type)
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
$fn$;

COMMENT ON FUNCTION public.collabbox_apply_one(uuid, jsonb, boolean) IS
  'Internal (collabbox-sync): classify and apply ONE collabBox document — storno, record, existing order (fill type / seller / to-pack edit), LEADS credit, create an order (conflict, replacement, no phone, twin, …) — and write its ledger row. See the migration header for the owner rules. Called only by collabbox_apply_documents. Migration 20260942000900.';

-- ── 10. THE writer ──────────────────────────────────────────────────────────
-- ≤ 200 documents per call (the function sends 40): one transaction, one
-- subtransaction per document — a bad document is an 'error' ledger row (it is
-- retried), never an aborted batch. p_dry: nothing is written, not even the
-- ledger or the run; the result is the plan. Counters of p_run are bumped here.
CREATE OR REPLACE FUNCTION public.collabbox_apply_documents(p_run uuid, p_docs jsonb, p_dry boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _d        jsonb;
  _r        jsonb;
  _err      text;
  _results  jsonb := '[]'::jsonb;
  _counts   jsonb := '{}'::jsonb;
  _n        integer := 0;
  _unmapped integer := 0;
  _outcome  text;
BEGIN
  IF p_docs IS NULL OR jsonb_typeof(p_docs) <> 'array' THEN
    RAISE EXCEPTION 'collabbox_apply_documents: p_docs must be a JSON array' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF jsonb_array_length(p_docs) > 200 THEN
    RAISE EXCEPTION 'collabbox_apply_documents: at most 200 documents per call' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT coalesce(p_dry, false) THEN
    IF p_run IS NULL OR NOT EXISTS (SELECT 1 FROM public.collabbox_sync_runs r WHERE r.id = p_run AND r.status = 'running') THEN
      RAISE EXCEPTION 'collabbox_apply_documents: a running collabbox_sync_runs row is required to write'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    PERFORM set_config('elyon.bulk_repair', 'on', true);      -- no paid / returned bells
    PERFORM set_config('elyon.keep_updated_at', 'on', true);  -- /call-agains reads updated_at
  END IF;

  FOR _d IN
    SELECT e.value FROM jsonb_array_elements(p_docs) e
     ORDER BY e.value ->> 'doc_at', e.value ->> 'doc_number'
  LOOP
    _n := _n + 1;
    BEGIN
      _r := public.collabbox_apply_one(p_run, _d, coalesce(p_dry, false));
    EXCEPTION WHEN OTHERS THEN
      _err := left(SQLERRM, 300);
      _r := jsonb_build_object('doc', _d ->> 'doc_number', 'type', _d ->> 'type_id', 'outcome', 'error', 'reason', _err);
      IF NOT coalesce(p_dry, false) AND nullif(btrim(_d ->> 'doc_number'), '') IS NOT NULL THEN
        BEGIN
          INSERT INTO public.collabbox_documents AS x (doc_number, doc_type_id, role, doc_at, outcome, reason,
                                                       first_run_id, run_id, payload)
          VALUES (btrim(_d ->> 'doc_number'), coalesce(nullif(btrim(_d ->> 'type_id'), ''), '0'),
                  public.collabbox_doc_role(_d ->> 'type_id'),
                  coalesce(public.collabbox_parse_local(_d ->> 'doc_at'), now()), 'error', _err, p_run, p_run, _d)
          ON CONFLICT (doc_number) DO UPDATE
             SET outcome = 'error', reason = EXCLUDED.reason, run_id = EXCLUDED.run_id,
                 attempts = x.attempts + 1, payload = EXCLUDED.payload, last_seen_at = now(), updated_at = now();
        EXCEPTION WHEN OTHERS THEN
          NULL;   -- the error is in the result either way
        END;
      END IF;
    END;
    _outcome := _r ->> 'outcome';
    _counts := public.collabbox_merge_counts(_counts, jsonb_build_object(_outcome, 1));
    IF _outcome = 'created' THEN _unmapped := _unmapped + coalesce((_r ->> 'unmapped')::integer, 0); END IF;
    _results := _results || jsonb_build_array(_r);
  END LOOP;

  IF NOT coalesce(p_dry, false) THEN
    UPDATE public.collabbox_sync_runs r
       SET created        = r.created        + coalesce((_counts ->> 'created')::integer, 0),
           updated        = r.updated        + coalesce((_counts ->> 'updated')::integer, 0),
           unchanged      = r.unchanged      + coalesce((_counts ->> 'exists')::integer, 0),
           conflicts      = r.conflicts      + coalesce((_counts ->> 'conflict')::integer, 0),
           replacements   = r.replacements   + coalesce((_counts ->> 'replacement')::integer, 0),
           no_phone       = r.no_phone       + coalesce((_counts ->> 'no_phone')::integer, 0),
           credited       = r.credited       + coalesce((_counts ->> 'credited')::integer, 0),
           recorded       = r.recorded       + coalesce((_counts ->> 'recorded')::integer, 0),
           skipped        = r.skipped        + coalesce((_counts ->> 'skipped')::integer, 0),
           pending        = r.pending        + coalesce((_counts ->> 'awaiting_parcel')::integer, 0)
                                             + coalesce((_counts ->> 'credit_pending')::integer, 0)
                                             + coalesce((_counts ->> 'no_items')::integer, 0),
           stornos        = r.stornos        + coalesce((_counts ->> 'storno')::integer, 0),
           errors         = r.errors         + coalesce((_counts ->> 'error')::integer, 0),
           unmapped_lines = r.unmapped_lines + _unmapped
     WHERE r.id = p_run;
  END IF;

  RETURN jsonb_build_object('ok', true, 'dry', coalesce(p_dry, false), 'docs', _n, 'outcomes', _counts,
                            'unmapped_lines', _unmapped, 'results', _results);
END;
$fn$;

COMMENT ON FUNCTION public.collabbox_apply_documents(uuid, jsonb, boolean) IS
  'THE collabbox-sync writer (service role, 2026-09-28): up to 200 documents, one subtransaction each (an error is a retried ledger row, never an aborted batch), bulk guards bulk_repair + keep_updated_at; bumps the run''s counters. p_dry = the plan, nothing written. Returns {docs, outcomes, unmapped_lines, results[]}. Migration 20260942000900.';

-- ── 11. The live mode: today's headers → 'booked' ───────────────────────────
-- Headers only (no lines, no customer, no order). A row the nightly run already
-- processed is never turned back into 'booked'.
CREATE OR REPLACE FUNCTION public.collabbox_record_booked(p_run uuid, p_docs jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _d       jsonb;
  _doc     text;
  _type    text;
  _at      timestamptz;
  _author  text;
  _person  uuid;
  _n       integer := 0;
  _written integer := 0;
  _bad     integer := 0;
  _k       integer;
BEGIN
  IF p_docs IS NULL OR jsonb_typeof(p_docs) <> 'array' OR jsonb_array_length(p_docs) > 2000 THEN
    RAISE EXCEPTION 'collabbox_record_booked: p_docs must be a JSON array of ≤ 2000 headers' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_run IS NULL OR NOT EXISTS (SELECT 1 FROM public.collabbox_sync_runs r WHERE r.id = p_run AND r.status = 'running') THEN
    RAISE EXCEPTION 'collabbox_record_booked: a running collabbox_sync_runs row is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  FOR _d IN SELECT e.value FROM jsonb_array_elements(p_docs) e LOOP
    _n := _n + 1;
    _doc := nullif(btrim(_d ->> 'doc_number'), '');
    _type := nullif(btrim(_d ->> 'type_id'), '');
    _at := public.collabbox_parse_local(_d ->> 'doc_at');
    IF _doc IS NULL OR _type IS NULL OR _type !~ '^[0-9]{3,8}$' OR _at IS NULL THEN
      _bad := _bad + 1;
      CONTINUE;
    END IF;
    _author := nullif(regexp_replace(btrim(coalesce(_d ->> 'author', '')), '\s+', ' ', 'g'), '');
    SELECT i.person_id INTO _person FROM public.collabbox_author_identity(_author) i;
    INSERT INTO public.collabbox_documents AS d (
           doc_number, doc_id, object_id, doc_type_id, doc_type_name, role, doc_at, komitent_id, komitent_name,
           author, author_person_id, amount_mkd, is_storno, outcome, reason, department, first_run_id, run_id, payload)
    VALUES (_doc, nullif(btrim(_d ->> 'doc_id'), ''), nullif(btrim(_d ->> 'object_id'), ''), _type,
            nullif(btrim(_d ->> 'type_name'), ''), public.collabbox_doc_role(_type), _at,
            nullif(btrim(_d ->> 'komitent_id'), ''), nullif(btrim(_d ->> 'komitent_name'), ''),
            _author, _person, public.collabbox_num(_d ->> 'amount_mkd'),
            coalesce((_d ->> 'storno')::boolean, false), 'booked', 'live_header',
            public.collabbox_department(_type, _doc, _person, _at), p_run, p_run, _d)
    ON CONFLICT (doc_number) DO UPDATE
       SET doc_id = coalesce(EXCLUDED.doc_id, d.doc_id), object_id = coalesce(EXCLUDED.object_id, d.object_id),
           doc_type_id = EXCLUDED.doc_type_id, doc_type_name = coalesce(EXCLUDED.doc_type_name, d.doc_type_name),
           role = EXCLUDED.role, doc_at = EXCLUDED.doc_at, komitent_id = EXCLUDED.komitent_id,
           komitent_name = coalesce(EXCLUDED.komitent_name, d.komitent_name), author = EXCLUDED.author,
           author_person_id = EXCLUDED.author_person_id, amount_mkd = EXCLUDED.amount_mkd,
           is_storno = EXCLUDED.is_storno, department = EXCLUDED.department, run_id = EXCLUDED.run_id,
           attempts = d.attempts + 1, last_seen_at = now(), vanished_at = NULL, payload = EXCLUDED.payload,
           updated_at = now()
     WHERE d.outcome = 'booked';
    GET DIAGNOSTICS _k = ROW_COUNT;
    _written := _written + _k;
  END LOOP;

  UPDATE public.collabbox_sync_runs r SET booked = r.booked + _written WHERE r.id = p_run;
  RETURN jsonb_build_object('ok', true, 'headers', _n, 'booked', _written, 'already_processed', _n - _written - _bad,
                            'invalid', _bad);
END;
$fn$;

COMMENT ON FUNCTION public.collabbox_record_booked(uuid, jsonb) IS
  'collabbox-sync live mode (service role, owner 28.09.2026 ~23:55): upsert today''s document headers into the ledger as ''booked'' (type, author + person, time, amount, department) — no order, no lines; a row already processed by the nightly run is never turned back. Returns {headers, booked, already_processed, invalid}. Migration 20260942000900.';

-- ── 12. Re-applying open rows ───────────────────────────────────────────────
-- no_phone · awaiting_parcel · credit_pending · error rows of the last p_days
-- that this run has not processed yet, oldest first, from their stored payload
-- (a parcel may have appeared since, a card been read, a holder linked).
-- Apply marks each row with p_run, so repeated calls walk the backlog; a dry
-- call re-plans the first p_limit rows only.
CREATE OR REPLACE FUNCTION public.collabbox_retry_open(
  p_run   uuid,
  p_dry   boolean DEFAULT false,
  p_days  integer DEFAULT 14,
  p_limit integer DEFAULT 40)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _docs jsonb;
BEGIN
  SELECT coalesce(jsonb_agg(s.payload ORDER BY s.doc_at, s.doc_number), '[]'::jsonb) INTO _docs
    FROM (SELECT d.payload, d.doc_at, d.doc_number
            FROM public.collabbox_documents d
           WHERE d.outcome IN ('no_phone', 'awaiting_parcel', 'credit_pending', 'error')
             AND d.doc_at >= now() - make_interval(days => greatest(coalesce(p_days, 14), 1))
             AND d.vanished_at IS NULL
             AND d.payload IS NOT NULL
             AND d.run_id IS DISTINCT FROM p_run
           ORDER BY d.doc_at, d.doc_number
           LIMIT least(greatest(coalesce(p_limit, 40), 1), 200)) s;
  RETURN public.collabbox_apply_documents(p_run, _docs, coalesce(p_dry, false));
END;
$fn$;

COMMENT ON FUNCTION public.collabbox_retry_open(uuid, boolean, integer, integer) IS
  'collabbox-sync (service role): re-apply up to p_limit open ledger rows (no_phone · awaiting_parcel · credit_pending · error) of the last p_days from their stored payload, oldest first, skipping rows p_run already processed. Same result as collabbox_apply_documents. Migration 20260942000900.';

-- ── 13. Documents a full re-read no longer finds ────────────────────────────
-- After EVERY day of [p_from, p_to] (Skopje) was re-read for p_types: ledger rows
-- of those days and types that are not in p_seen were deleted in collabBox →
-- vanished_at (+ flag); an order THIS sync created for one gets a note (never
-- deleted, never re-statused — MEX decides) and is listed. A day whose re-read
-- returned nothing while the ledger knows ≥ 10 documents, or lost more than half
-- of them, is suspicious and never marked (reported instead).
CREATE OR REPLACE FUNCTION public.collabbox_close_window(
  p_run   uuid,
  p_from  date,
  p_to    date,
  p_types text[],
  p_seen  text[],
  p_dry   boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _gone    jsonb;
  _skipped jsonb;
  _marked  integer := 0;
  _noted   integer := 0;
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 31
     OR p_types IS NULL OR cardinality(p_types) = 0 THEN
    RAISE EXCEPTION 'collabbox_close_window: a window of ≤ 32 days and the types are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT coalesce(p_dry, false) AND (p_run IS NULL OR NOT EXISTS (
        SELECT 1 FROM public.collabbox_sync_runs r WHERE r.id = p_run AND r.status = 'running')) THEN
    RAISE EXCEPTION 'collabbox_close_window: a running collabbox_sync_runs row is required to write' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  WITH led AS (
    SELECT d.doc_number, (d.doc_at AT TIME ZONE 'Europe/Skopje')::date AS day, d.created_by_sync, d.order_id
      FROM public.collabbox_documents d
     WHERE d.doc_at >= (p_from::timestamp AT TIME ZONE 'Europe/Skopje')
       AND d.doc_at <  ((p_to + 1)::timestamp AT TIME ZONE 'Europe/Skopje')
       AND d.doc_type_id = ANY (p_types)
       AND d.vanished_at IS NULL
  ), seen AS (
    SELECT DISTINCT s AS doc FROM unnest(coalesce(p_seen, '{}'::text[])) s
  ), per_day AS (
    SELECT l.day, count(*) AS known,
           count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM seen s WHERE s.doc = l.doc_number)) AS gone
      FROM led l GROUP BY l.day
  ), bad AS (
    SELECT p.day FROM per_day p WHERE p.known >= 10 AND p.gone * 2 > p.known
  )
  SELECT coalesce((SELECT jsonb_agg(jsonb_build_object('doc', l.doc_number, 'day', l.day,
                                                       'order_id', l.order_id, 'sync_order', l.created_by_sync)
                                    ORDER BY l.day, l.doc_number)
                     FROM led l
                    WHERE NOT EXISTS (SELECT 1 FROM seen s WHERE s.doc = l.doc_number)
                      AND NOT EXISTS (SELECT 1 FROM bad b WHERE b.day = l.day)), '[]'::jsonb),
         coalesce((SELECT jsonb_agg(jsonb_build_object('day', p.day, 'known', p.known, 'gone', p.gone) ORDER BY p.day)
                     FROM per_day p WHERE EXISTS (SELECT 1 FROM bad b WHERE b.day = p.day)), '[]'::jsonb)
    INTO _gone, _skipped;

  IF NOT coalesce(p_dry, false) AND jsonb_array_length(_gone) > 0 THEN
    UPDATE public.collabbox_documents d
       SET vanished_at = now(),
           flags = CASE WHEN 'vanished_from_collabbox' = ANY (d.flags) THEN d.flags ELSE d.flags || 'vanished_from_collabbox'::text END,
           run_id = p_run, updated_at = now()
      FROM jsonb_to_recordset(_gone) AS g(doc text)
     WHERE d.doc_number = g.doc AND d.vanished_at IS NULL;
    GET DIAGNOSTICS _marked = ROW_COUNT;

    INSERT INTO public.order_notes (order_id, text, author_id, author_name)
    SELECT g.order_id,
           'collabBox document ' || g.doc || ' is no longer in collabBox (deleted there). The order is left as it is (its status comes from MEX) — check it.',
           NULL, 'collabBox'
      FROM jsonb_to_recordset(_gone) AS g(doc text, order_id uuid, sync_order boolean)
     WHERE g.sync_order AND g.order_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.order_notes n
                        WHERE n.order_id = g.order_id
                          AND n.text = 'collabBox document ' || g.doc || ' is no longer in collabBox (deleted there). The order is left as it is (its status comes from MEX) — check it.');
    GET DIAGNOSTICS _noted = ROW_COUNT;

    UPDATE public.collabbox_sync_runs r SET vanished = r.vanished + _marked WHERE r.id = p_run;
  END IF;

  RETURN jsonb_build_object('ok', true, 'dry', coalesce(p_dry, false), 'gone', jsonb_array_length(_gone),
                            'marked', _marked, 'orders_noted', _noted, 'suspicious_days', _skipped,
                            'sample', (SELECT coalesce(jsonb_agg(e), '[]'::jsonb)
                                         FROM (SELECT e FROM jsonb_array_elements(_gone) e LIMIT 50) x));
END;
$fn$;

COMMENT ON FUNCTION public.collabbox_close_window(uuid, date, date, text[], text[], boolean) IS
  'collabbox-sync (service role): after a FULL re-read of [p_from, p_to] (Skopje) for p_types, mark ledger documents not in p_seen as vanished (deleted in collabBox) and note the orders this sync created for them — never deleted or re-statused; suspicious days (≥ 10 known, more than half gone) are reported, never marked. Migration 20260942000900.';

-- ── 14. The nightly window ──────────────────────────────────────────────────
-- The last p_days complete Skopje days (today − p_days … yesterday), widened back
-- to the day after the last OK nightly window and to any day still holding
-- header-only ('booked') or unread-lines ('no_items') rows — so a missed night is
-- caught up — never further back than p_max_days.
CREATE OR REPLACE FUNCTION public.collabbox_nightly_window(p_days integer DEFAULT 3, p_max_days integer DEFAULT 14)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _today  date := (now() AT TIME ZONE 'Europe/Skopje')::date;
  _days   integer := least(greatest(coalesce(p_days, 3), 1), 14);
  _max    integer := least(greatest(coalesce(p_max_days, 14), 1), 31);
  _from   date;
  _to     date;
  _lastok date;
  _open   date;
  _why    text := 'last ' || _days || ' days';
BEGIN
  _to := _today - 1;
  _from := _today - _days;
  SELECT max(r.window_to) INTO _lastok FROM public.collabbox_sync_runs r WHERE r.kind = 'nightly' AND r.status = 'ok';
  IF _lastok IS NOT NULL AND _lastok + 1 < _from THEN
    _from := _lastok + 1; _why := _why || '; caught up from the last ok night';
  END IF;
  SELECT min((d.doc_at AT TIME ZONE 'Europe/Skopje')::date) INTO _open
    FROM public.collabbox_documents d
   WHERE d.outcome IN ('booked', 'no_items') AND d.vanished_at IS NULL
     AND d.doc_at >= ((_today - _max)::timestamp AT TIME ZONE 'Europe/Skopje')
     AND d.doc_at <  (_today::timestamp AT TIME ZONE 'Europe/Skopje');
  IF _open IS NOT NULL AND _open < _from THEN
    _from := _open; _why := _why || '; widened to unprocessed documents';
  END IF;
  IF _from < _today - _max THEN
    _from := _today - _max; _why := _why || '; capped at ' || _max || ' days';
  END IF;
  RETURN jsonb_build_object('today', _today, 'from', _from, 'to', _to, 'why', _why);
END;
$fn$;

COMMENT ON FUNCTION public.collabbox_nightly_window(integer, integer) IS
  'collabbox-sync: the nightly re-read window {today, from, to, why} — the last p_days Skopje days, widened back to the day after the last ok nightly window and to days still holding booked / no_items rows, never more than p_max_days. Migration 20260942000900.';

-- ── 15. Which komitent cards the sync must read ─────────────────────────────
-- p_docs: [{doc_number, komitent_id}] of order documents. A komitent is needed
-- when no card was read, the teleshop registry has neither a valid phone nor a
-- verdict for it, and its document is not an order yet. priority 1 = its
-- document's parcel carries no valid phone either (without the card it cannot be
-- created), 2 = the card would only confirm the parcel phone / bring a verdict.
CREATE OR REPLACE FUNCTION public.collabbox_komitenti_needed(p_docs jsonb)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT coalesce(jsonb_agg(jsonb_build_object('komitent_id', k.kom, 'priority', k.pri) ORDER BY k.pri, k.kom), '[]'::jsonb)
    FROM (SELECT x.kom,
                 min(CASE WHEN public.collabbox_mk_phone8(p.phone8) IS NULL THEN 1 ELSE 2 END) AS pri
            FROM (SELECT DISTINCT nullif(btrim(e ->> 'komitent_id'), '') AS kom, nullif(btrim(e ->> 'doc_number'), '') AS doc
                    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_docs) = 'array' THEN p_docs ELSE '[]'::jsonb END) e) x
            LEFT JOIN public.mex_parcels p ON p.tracking_id = x.doc
           WHERE x.kom IS NOT NULL AND x.kom ~ '^[0-9]{1,10}$'
             AND NOT EXISTS (SELECT 1 FROM public.collabbox_customers c WHERE c.komitent_id = x.kom AND c.source = 'card')
             AND NOT EXISTS (SELECT 1 FROM public.teleshop_import_customers t
                              WHERE t.komitent_id = x.kom
                                AND (public.collabbox_mk_phone8(t.phone8) IS NOT NULL OR t.outcome = 'skipped'))
             AND NOT EXISTS (SELECT 1 FROM public.orders o
                              WHERE o.external_source = 'collabbox' AND o.external_order_id = x.doc)
           GROUP BY x.kom) k;
$fn$;

COMMENT ON FUNCTION public.collabbox_komitenti_needed(jsonb) IS
  'collabbox-sync: the komitent ids whose card the sync should read ([{komitent_id, priority}], 1 = no phone anywhere, 2 = the parcel has one), from [{doc_number, komitent_id}] of order documents. Migration 20260942000900.';

-- ── 16. The leaderboard's collabBox bookings ────────────────────────────────
-- Per author / person / type: the day's booked documents (live mode) that no
-- order holds yet — by DocNumber (external ref or tracking id) or through its
-- parcel. A booking drops out the moment such an order exists, and once the
-- nightly run processed it (then the order, if any, counts instead). Value =
-- the document amount (денари). Replacements (≤ 0) and stornos are not bookings.
CREATE OR REPLACE FUNCTION public.collabbox_booked_today(p_day date DEFAULT NULL)
RETURNS TABLE (author text, person_id uuid, doc_type text, docs integer, value_mkd numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  WITH d AS (SELECT coalesce(p_day, (now() AT TIME ZONE 'Europe/Skopje')::date) AS day)
  SELECT b.author, b.author_person_id, b.doc_type_id, count(*)::integer, coalesce(sum(b.amount_mkd), 0)
    FROM public.collabbox_documents b, d
   WHERE b.doc_at >= (d.day::timestamp AT TIME ZONE 'Europe/Skopje')
     AND b.doc_at <  ((d.day + 1)::timestamp AT TIME ZONE 'Europe/Skopje')
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
$fn$;

COMMENT ON FUNCTION public.collabbox_booked_today(date) IS
  'The leaderboard''s collabBox bookings of a Skopje day (default today; owner 28.09.2026 ~23:55): per author / person / type, the count and денари of documents the live mode booked that no order holds yet (external ref, tracking id or linked parcel) and the nightly run has not processed — so nothing is counted twice. Types 10036 · 10050 · 10111 · 10114 · 10106. Migration 20260942000900.';

-- ── 17. THE freshness — replaces the 20260939000200 stub, same keys ─────────
--   status  failed — the last settled nightly/manual run failed (a 'running' row
--           older than 20 minutes was killed) · stale — no ok run for 26 h ·
--           ok · n/a — never run and no collabBox order at all
--   last_ok_at = the last ok nightly/manual run; data_through = the newest
--   document in the ledger; lag_parcels = NATURA 9100/9102/9108 COD parcels older
--   than 48 h, linked to no order, not claimed by a web order and never seen by
--   the sync. Until the first run exists it answers exactly as the stub did.
--   Extra keys for Settings → Integrations: last_run_at, last_error,
--   last_error_at, runs_24h, failed_24h, live_last_ok_at, booked_today,
--   stale_to_pack (orders this sync created to pack, still without a parcel after
--   7 days — nothing cancels them automatically).
CREATE OR REPLACE FUNCTION public.collabbox_feed_state()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
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
  SELECT max(d.doc_at) AS t FROM public.collabbox_documents d WHERE d.vanished_at IS NULL
),
legacy AS (
  SELECT max(o.created_at) AS last_doc FROM public.orders o WHERE o.sale_source = 'collabbox'
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
                     WHEN lo.t IS NULL OR lo.t < now() - interval '26 hours' THEN 'stale'
                     ELSE 'ok' END,
      'detail', 'nightly sync 00:00 (last 3 days re-read); last ok '
                || coalesce(to_char(lo.t AT TIME ZONE 'Europe/Skopje', 'DD.MM.YYYY HH24:MI'), 'never')
                || '; documents through '
                || coalesce(to_char(dc.t AT TIME ZONE 'Europe/Skopje', 'DD.MM.YYYY HH24:MI'), '-')
                || '; live bookings last ok '
                || coalesce(to_char(lv.last_ok AT TIME ZONE 'Europe/Skopje', 'DD.MM HH24:MI'), '-')
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
  LEFT JOIN last_settled ls ON true
  LEFT JOIN last_fail lf ON true;
$fn$;

COMMENT ON FUNCTION public.collabbox_feed_state() IS
  'THE collabBox freshness (20260942000900 — replaces the 20260939000200 stub, same keys): {feed, last_ok_at, status ok|stale|failed|n/a, detail, data_through, lag_parcels} + last_run_at, last_error, last_error_at, runs_24h, failed_24h, live_last_ok_at, booked_today, stale_to_pack. last_ok_at = last ok nightly/manual sync run; failed = the last settled run failed (a running row > 20 min counts); stale after 26 h; lag = unlinked NATURA 9100/9102/9108 COD parcels > 48 h the sync never saw. Before the first run: the stub''s reading. Read by integrations_health() and the api''s Overview overlay.';

-- ── 18. Grants ──────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.collabbox_doc_role(text)                                   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.collabbox_department(text, text, uuid, timestamptz)       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.collabbox_department(text, uuid, timestamptz)             FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.collabbox_parse_local(text)                                FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.collabbox_num(text)                                        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.collabbox_mk_phone8(text)                                  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.collabbox_merge_counts(jsonb, jsonb)                       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.collabbox_author_identity(text)                            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.collabbox_items(jsonb, numeric)                            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.collabbox_credit_order(uuid, text, timestamptz, text, boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.collabbox_apply_one(uuid, jsonb, boolean)                  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.collabbox_apply_documents(uuid, jsonb, boolean)            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.collabbox_record_booked(uuid, jsonb)                       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.collabbox_retry_open(uuid, boolean, integer, integer)      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.collabbox_close_window(uuid, date, date, text[], text[], boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.collabbox_nightly_window(integer, integer)                 FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.collabbox_komitenti_needed(jsonb)                          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.collabbox_booked_today(date)                               FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.collabbox_doc_role(text)                                TO service_role;
GRANT EXECUTE ON FUNCTION public.collabbox_department(text, text, uuid, timestamptz)    TO service_role;
GRANT EXECUTE ON FUNCTION public.collabbox_department(text, uuid, timestamptz)          TO service_role;
GRANT EXECUTE ON FUNCTION public.collabbox_parse_local(text)                             TO service_role;
GRANT EXECUTE ON FUNCTION public.collabbox_num(text)                                     TO service_role;
GRANT EXECUTE ON FUNCTION public.collabbox_mk_phone8(text)                               TO service_role;
GRANT EXECUTE ON FUNCTION public.collabbox_merge_counts(jsonb, jsonb)                    TO service_role;
GRANT EXECUTE ON FUNCTION public.collabbox_author_identity(text)                         TO service_role;
GRANT EXECUTE ON FUNCTION public.collabbox_items(jsonb, numeric)                         TO service_role;
GRANT EXECUTE ON FUNCTION public.collabbox_apply_documents(uuid, jsonb, boolean)         TO service_role;
GRANT EXECUTE ON FUNCTION public.collabbox_record_booked(uuid, jsonb)                    TO service_role;
GRANT EXECUTE ON FUNCTION public.collabbox_retry_open(uuid, boolean, integer, integer)   TO service_role;
GRANT EXECUTE ON FUNCTION public.collabbox_close_window(uuid, date, date, text[], text[], boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.collabbox_nightly_window(integer, integer)              TO service_role;
GRANT EXECUTE ON FUNCTION public.collabbox_komitenti_needed(jsonb)                       TO service_role;
GRANT EXECUTE ON FUNCTION public.collabbox_booked_today(date)                            TO service_role;
-- collabbox_feed_state keeps its grants (CREATE OR REPLACE keeps the ACL).

-- The read-only verification path (Management API, read_only: true) — conditional
-- so a fresh local database without the platform role still migrates.
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    GRANT EXECUTE ON FUNCTION public.collabbox_booked_today(date)            TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.collabbox_nightly_window(integer, integer) TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.collabbox_komitenti_needed(jsonb)       TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.collabbox_department(text, text, uuid, timestamptz) TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.collabbox_department(text, uuid, timestamptz)       TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.collabbox_doc_role(text)                TO supabase_read_only_user;
  END IF;
END
$grant$;

-- ── 19. The schedulers ──────────────────────────────────────────────────────
-- Same pg_cron + pg_net + Vault pattern as invoke_mex_reconcile / invoke_web_sync:
-- the shared secret lives in Vault (row collabbox_sync_secret = the function's
-- COLLABBOX_SYNC_SECRET), never in SQL. Until it exists both jobs are no-ops.
CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE OR REPLACE FUNCTION public.invoke_collabbox_sync(_mode text DEFAULT 'nightly')
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  _secret text;
  _local  timestamp := now() AT TIME ZONE 'Europe/Skopje';
BEGIN
  IF _mode = 'nightly' THEN
    -- 00:xx Skopje only (DST-proof: exactly one of the two UTC slots), once a day
    IF extract(hour FROM _local) <> 0 THEN
      RETURN;
    END IF;
    IF EXISTS (SELECT 1 FROM public.collabbox_sync_runs r
                WHERE r.kind = 'nightly' AND r.run_day = _local::date) THEN
      RETURN;
    END IF;
  ELSIF _mode = 'live' THEN
    -- every 30 minutes 08:00–20:00 Skopje
    IF _local::time < time '08:00' OR _local::time >= time '20:15' THEN
      RETURN;
    END IF;
  ELSE
    RETURN;
  END IF;

  SELECT decrypted_secret INTO _secret
    FROM vault.decrypted_secrets
   WHERE name = 'collabbox_sync_secret';
  IF _secret IS NULL THEN
    RETURN;  -- vault not configured yet → no-op
  END IF;

  -- MACEDONIA. This URL must always be THIS project.
  PERFORM net.http_post(
    url := 'https://bmfxhgznttcnnlqloqzp.supabase.co/functions/v1/collabbox-sync',
    headers := jsonb_build_object(
      'x-collabbox-sync-secret', _secret,
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object('mode', _mode, 'trigger', 'cron'),
    timeout_milliseconds := 60000
  );
EXCEPTION WHEN OTHERS THEN
  RETURN;  -- the scheduler must never error the cron job
END;
$fn$;

COMMENT ON FUNCTION public.invoke_collabbox_sync(text) IS
  'pg_cron → collabbox-sync (THIS project). nightly: only at 00:xx Skopje and only when no nightly run exists for today; live: 08:00–20:00 Skopje. No-op until the Vault row collabbox_sync_secret exists. Migration 20260942000900.';

REVOKE ALL ON FUNCTION public.invoke_collabbox_sync(text) FROM PUBLIC, anon, authenticated;

DO $cron$
DECLARE
  _job text;
BEGIN
  FOREACH _job IN ARRAY ARRAY['collabbox-sync', 'collabbox-live', 'collabbox-customers'] LOOP
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = _job) THEN
      PERFORM cron.unschedule(_job);
    END IF;
  END LOOP;
END
$cron$;

-- 22:00 UTC = 00:00 CEST, 23:00 UTC = 00:00 CET; the gate keeps the one that is 00:xx Skopje.
SELECT cron.schedule(
  'collabbox-sync', '0 22,23 * * *',
  $job$SELECT public.invoke_collabbox_sync('nightly');$job$
);

-- UTC 06–19 covers 08:00–20:00 Skopje in summer AND winter; the gate drops the rest.
SELECT cron.schedule(
  'collabbox-live', '*/30 6-19 * * *',
  $job$SELECT public.invoke_collabbox_sync('live');$job$
);

-- PostgREST: the new tables, functions and orders column.
NOTIFY pgrst, 'reload schema';

COMMIT;
