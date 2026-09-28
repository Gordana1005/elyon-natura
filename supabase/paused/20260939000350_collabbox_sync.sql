-- ============================================================================
-- collabBOX SYNC — the company's other order system, into the CRM (2026-09-28)
-- ============================================================================
-- collabBox (Accent Computers, http://146.255.89.49:8081/naturatherapy/) is
-- where the TELESHOP call centre types its orders. Until now its documents
-- reached the CRM only by hand-run imports (the last on 2026-09-18), so the
-- Overview showed collabBox "stale" and ~6.700 NATURA parcels had no order.
-- Headless read-only access works (scripts/collabbox-fetch.mjs, VAULT §7.1),
-- and an Edge Function reaches the server from eu-central-1, so this migration
-- adds the database half of a nightly sync:
--
--   collabbox_documents      THE LEDGER — one row per collabBox document of
--                            the channel types, whatever became of it
--   collabbox_customers      the komitent registry (documents carry NO phone)
--   collabbox_sync_runs      one row per Edge Function invocation that worked
--   collabbox_sku_map        article code → products.id, + service/note rows
--   segment_recompute_queue  phones whose segment recompute a BULK load
--                            deferred (trg_orders_recompute_segments gate)
--   orders.not_counted_reason  'replacement' — a row kept for its parcel that
--                            is NOT an order (owner decision 4)
--   collabbox_apply_documents(run, docs, opts)   the writer (service role)
--   collabbox_close_window(run, from, to, types) documents that vanished
--   collabbox_upsert_customers(run, rows, source)
--   collabbox_credit_authors(dry, limit)         LEADS author → seller sweep
--   collabbox_mark_replacements(apply)           the historic price-0 rows
--   collabbox_feed_state()   THE freshness (replaces the 20260939000200 stub)
--   invoke_collabbox_sync(mode) + pg_cron 'collabbox-sync' / 'collabbox-customers'
--
-- ── OWNER DECISIONS (Mile, 2026-09-28 — law) ────────────────────────────────
-- 1. TELESHOP — Нарачка in (10036) and Нарачка out (10050), series 9100/9102
--    on the NATURA MEX account — BECOME CRM ORDERS: source_type 'import',
--    external_source 'collabbox', external_order_id = DocNumber (sale_source
--    collabbox / teleshop is derived by tg_orders_sale_source_fill). Teleshop
--    customers DO enter the prediction lists: the normal per-row segment
--    trigger runs (bulk mode only defers it — see §2).
-- 2. SOCIAL (10106, 9108) and WEB (10112) are LEDGER ONLY. LEADS (10111) and
--    LEADS-OUT (10114) are ledger only too (their orders arrive through
--    AlterCPA / ElyonCRM) — but their author (Aвтор) credits the SELLER: an
--    order holding that DocNumber as its parcel with no seller yet gets
--    sold_* stamped (sold_via 'collabbox', sold_by_ext = author) and the person
--    through sales_person_identities kind 'collabbox_author'
--    (collabbox_credit_order). tg_orders_sold_write_once allows NULL → value.
--    Store / replenishment types (Продавница …) are not sales: never fetched;
--    10055 С.Мрежи-Продавница is 'no_courier'.
-- 3. HISTORY is loaded once (scripts/collabbox-backfill.mjs), then every night
--    the Edge Function re-reads the LAST 30 DAYS (edits, storno, deletions),
--    upserting by DocNumber. Status of a created order:
--      the DocNumber has a MEX parcel → the courier decides:
--          2 Delivered → paid (paid_at = delivered_at, paid_basis 'mex')
--          7 Returned  → returned
--          anything else → shipped
--      no parcel, document before MEX coverage (2026-04-01 Skopje — NATURA's
--          register starts 2026-03-09 and March holds only 504 parcels
--          against ~6.000 a month from April) → paid, paid_basis
--          'legacy_import' (the 2026-08-12 rule: pre-MEX collabBox orders are
--          settled; NEVER counted as MEX-proven cash)
--      no parcel, MEX era → confirmed (to pack); mex-reconcile takes over
--          through the remembered link (orders.mex_tracking_id = DocNumber).
--    collabBox NEVER sets paid on its own for a MEX-era document.
-- 4. REPLACEMENTS (document value 0 and/or parcel COD 0 — 'замена', a missing
--    item resent) are NOT orders: ledger kind 'replacement', one note on the
--    customer's previous sale. The historic price-0 collabBox rows that hold a
--    parcel are marked orders.not_counted_reason = 'replacement' by
--    collabbox_mark_replacements(true) — never deleted; DRY RUN by default.
-- 5. A teleshop document whose parcel another order already holds (the 170
--    AlterCPA orders on teleshop parcels STAY AS THEY ARE) creates NO order:
--    ledger action 'conflict', no money — never a double count, never a force.
--
-- ── DATES ───────────────────────────────────────────────────────────────────
-- collabBox shows Skopje wall-clock time ("25.09.2026 20:17:03"). The fetcher
-- sends it WITHOUT an offset; collabbox_parse_local() reads it AT TIME ZONE
-- 'Europe/Skopje', which is DST-exact (the old importer's fixed +02:00 was an
-- hour off in winter). A date-only value reads as 12:00 Skopje.
--
-- ── MONEY ───────────────────────────────────────────────────────────────────
-- price (EUR) = goods value / 61.5 — the FROZEN MKD_PER_EUR peg (CLAUDE.md:
-- never "update" it). Goods = the document's line items minus service rows:
-- 8001 ДОСТАВА (delivery fee), 8002 / ЗАБЕЛЕШКА… (note lines → order_notes),
-- ПОЕН-* (loyalty-point markers). COD = price × 61.5 (+150 when delivery is
-- charged) — the same tolerance mex-reconcile's COD check already applies.
--
-- ── TRIGGERS ────────────────────────────────────────────────────────────────
-- Nothing is muted. An insert fires every orders trigger as any import does:
-- display id, sale_source fill, stamp_sold (sold_via 'collabbox', the author),
-- paid_at / paid_basis (explicit values survive), link_parcel (the parcel is
-- then re-claimed through mex_link_parcel with method 'collabbox_import'),
-- auto-distribute (a no-op: never 'pending') and the per-row SEGMENT recompute.
-- BULK mode (the history backfill only) sets two TRANSACTION-LOCAL switches:
--   elyon.bulk_repair    = 'on'  (20260934000200: no paid/returned bells)
--   elyon.defer_segments = 'on'  (§2 below: the phone is QUEUED instead of
--                                  recomputed row by row)
-- and the backfill ends by telling the operator to run, once and NOT while
-- another bulk writer runs (it deadlocked once):
--   SELECT public.recompute_all_segments();   -- or segment_recompute_drain()
--   node scripts/engine-fixture-mk.mjs
-- Data fills on existing orders (product, items, phone, seller) run under
-- elyon.keep_updated_at = 'on' (20260939000300) so updated_at is not bumped;
-- a real change (price of a to-pack order, a status from the courier) bumps
-- it as usual. No session_replication_role anywhere.
--
-- Apply AFTER 20260939000200 (the collabbox_feed_state stub this replaces)
-- and 20260939000300 (elyon.keep_updated_at), BEFORE 20260939000400.
-- Then: node scripts/collabbox-sync-setup.mjs → deploy collabbox-sync →
-- node scripts/collabbox-backfill.mjs (dry, then --apply). Until the Vault row
-- collabbox_sync_secret exists both cron jobs are silent no-ops.
-- ============================================================================

SET LOCAL lock_timeout = '5s';

-- ── 1. orders.not_counted_reason — first, so the strongest orders lock is
--       taken up front and held for milliseconds ─────────────────────────────
-- Nullable, no default: catalog-only. The CHECK validates in one pass over
-- ~105k rows that are all NULL.
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS not_counted_reason text,
  DROP CONSTRAINT IF EXISTS orders_not_counted_reason_check,
  ADD CONSTRAINT orders_not_counted_reason_check CHECK (
    not_counted_reason IS NULL OR not_counted_reason IN ('replacement'));

COMMENT ON COLUMN public.orders.not_counted_reason IS
  'Set = this row is kept (it holds a MEX parcel, its history, its notes) but it is NOT an order: every order count, revenue sum and conversion must exclude it (AND not_counted_reason IS NULL). replacement = a collabBox replacement / resend (document value 0 and parcel COD 0), owner decision 2026-09-28. Written only by collabbox_mark_replacements(true).';

CREATE INDEX IF NOT EXISTS idx_orders_not_counted
  ON public.orders (not_counted_reason) WHERE not_counted_reason IS NOT NULL;

-- ── 2. Deferred segment recompute (BULK loads only) ─────────────────────────
-- trg_orders_recompute_segments is re-emitted VERBATIM from the LIVE
-- definition (pg_get_functiondef, 2026-09-28); the only change is the first
-- block. With elyon.defer_segments = 'on' in the transaction the phone is
-- queued instead of recomputed; unset (every other write in the system) it
-- behaves exactly as before. segment_recompute_drain() or the nightly
-- recompute_all_segments (00:00 UTC) then settles the queue.
CREATE TABLE IF NOT EXISTS public.segment_recompute_queue (
  phone     text PRIMARY KEY,
  queued_at timestamptz NOT NULL DEFAULT now(),
  source    text
);

COMMENT ON TABLE public.segment_recompute_queue IS
  'Phones whose per-row segment recompute a BULK writer deferred (SET LOCAL elyon.defer_segments = ''on''; first user: the collabBox history backfill, 2026-09-28). Drained by segment_recompute_drain(); recompute_all_segments() covers it too. Service role only.';

ALTER TABLE public.segment_recompute_queue ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.segment_recompute_queue FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.segment_recompute_queue TO service_role;

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

-- Settles the queue: oldest first, p_limit phones per call. NOT to be run
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
     ORDER BY q.queued_at, q.phone
     LIMIT greatest(coalesce(p_limit, 5000), 1)
  LOOP
    PERFORM public.recompute_customer_segments(_phone);
    DELETE FROM public.segment_recompute_queue WHERE phone = _phone;
    _n := _n + 1;
  END LOOP;
  RETURN _n;
END;
$fn$;

COMMENT ON FUNCTION public.segment_recompute_drain(integer) IS
  'Recompute the segments of up to p_limit queued phones (segment_recompute_queue, filled by bulk writers under elyon.defer_segments) and dequeue them. Returns how many. Never concurrently with recompute_all_segments or a bulk writer.';

REVOKE ALL ON FUNCTION public.segment_recompute_drain(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.segment_recompute_drain(integer) TO service_role;

-- ── 3. The run log ──────────────────────────────────────────────────────────
-- One row per Edge Function invocation that did work (a no-op slot writes
-- nothing). The nightly re-read is a SESSION (session_day = the Skopje date)
-- that several 10-minute slots advance one day-chunk at a time: next_day is
-- where the next slot continues, done = the session finished. Freshness
-- (collabbox_feed_state) reads the last 'ok' row.
CREATE TABLE IF NOT EXISTS public.collabbox_sync_runs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind               text NOT NULL
                     CONSTRAINT collabbox_sync_runs_kind_check
                     CHECK (kind IN ('daily', 'backfill', 'customers', 'upload')),
  status             text NOT NULL DEFAULT 'running'
                     CONSTRAINT collabbox_sync_runs_status_check
                     CHECK (status IN ('running', 'ok', 'partial', 'failed')),
  session_id         uuid,
  session_day        date,              -- daily: the Skopje night this session belongs to
  window_from        date,              -- the whole window the session covers
  window_to          date,
  cursor_from        date,              -- first day THIS invocation worked on
  cursor_to          date,              -- last day it completed
  next_day           date,              -- where the next invocation continues (NULL = done)
  done               boolean NOT NULL DEFAULT false,
  doc_types          text[],
  requests           integer NOT NULL DEFAULT 0,   -- HTTP requests to collabBox
  docs_read          integer NOT NULL DEFAULT 0,
  lines_read         integer NOT NULL DEFAULT 0,
  created            integer NOT NULL DEFAULT 0,
  enriched           integer NOT NULL DEFAULT 0,
  annotated          integer NOT NULL DEFAULT 0,
  conflicts          integer NOT NULL DEFAULT 0,
  replacements       integer NOT NULL DEFAULT 0,
  skipped            integer NOT NULL DEFAULT 0,
  errors             integer NOT NULL DEFAULT 0,
  deleted_marked     integer NOT NULL DEFAULT 0,
  credited           integer NOT NULL DEFAULT 0,
  customers_upserted integer NOT NULL DEFAULT 0,
  unmapped_skus      jsonb NOT NULL DEFAULT '{}'::jsonb,   -- article code → name
  stats              jsonb NOT NULL DEFAULT '{}'::jsonb,   -- per kind/action counts, samples
  error              text,
  warning            text,
  started_at         timestamptz NOT NULL DEFAULT now(),
  finished_at        timestamptz,
  duration_ms        integer
);

COMMENT ON TABLE public.collabbox_sync_runs IS
  'One row per collabbox-sync Edge Function invocation that did work (2026-09-28): daily = one slot of the nightly 30-day re-read session (session_day, next_day, done), backfill = one range call, customers = a komitent refresh, upload = a manual file. Freshness for the Overview and Settings → Integrations health via collabbox_feed_state(). Service-role writes.';

CREATE INDEX IF NOT EXISTS idx_collabbox_sync_runs_kind_recent
  ON public.collabbox_sync_runs (kind, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_collabbox_sync_runs_session
  ON public.collabbox_sync_runs (session_id, started_at DESC) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_collabbox_sync_runs_ok
  ON public.collabbox_sync_runs (finished_at DESC) WHERE status = 'ok';

-- ── 4. The komitent registry ────────────────────────────────────────────────
-- collabBox documents carry the customer id (Шифра на комитент) but no phone.
-- Коминтенти (comp=infocc) holds it; the Edge Function refreshes komitenti
-- created/changed in the last days (its Датум од-до filter), the backfill
-- seeds the 2026-09-10 snapshot (C:\Users\Mile\collab_out\komitenti_full.csv,
-- 165.129 rows). A MEX parcel's phone8 is the fallback and the confirmation.
CREATE TABLE IF NOT EXISTS public.collabbox_customers (
  komitent_id   text PRIMARY KEY,         -- Шифра
  object_id     text,                     -- internal id (comp=ovc&id=)
  name          text,
  phone8        text,                     -- last 8 digits of Мобилен, else Телефон (+389 stripped)
  phone_raw     text,                     -- Телефон as typed
  mobile_raw    text,                     -- Мобилен as typed
  address       text,
  city          text,
  country       text,
  source        text NOT NULL DEFAULT 'feed'
                CONSTRAINT collabbox_customers_source_check
                CHECK (source IN ('feed', 'snapshot', 'upload')),
  run_id        uuid,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.collabbox_customers IS
  'collabBox Коминтенти (customer registry): the phone behind a document''s komitent id. PII — business owners only; service-role writes (collabbox_upsert_customers).';

CREATE INDEX IF NOT EXISTS idx_collabbox_customers_phone8
  ON public.collabbox_customers (phone8) WHERE phone8 IS NOT NULL;

-- ── 5. The SKU map ──────────────────────────────────────────────────────────
-- role: goods (a product line; product_id may still be NULL = unmapped) ·
-- delivery (8001 ДОСТАВА) · note (8002 — free-text ЗАБЕЛЕШКА lines) · marker
-- (ПОЕН-* loyalty points; also matched by prefix, so new ПОЕН codes need no
-- row) · ignore. Seeded from scripts/data/collabbox-sku-map.json (173
-- reviewed rows, 2026-08-12) and products.sku (the catalogue's own collabBox
-- codes — which WIN where the two disagree: 000942 / 000616 / 000944 were
-- mapped by name to the 90 tbl / 1+1 variants in the JSON, while the product
-- carrying that very code is the 30-piece one).
CREATE TABLE IF NOT EXISTS public.collabbox_sku_map (
  article_code text PRIMARY KEY,
  article_name text,
  product_id   uuid REFERENCES public.products(id) ON DELETE SET NULL,
  role         text NOT NULL DEFAULT 'goods'
               CONSTRAINT collabbox_sku_map_role_check
               CHECK (role IN ('goods', 'delivery', 'note', 'marker', 'ignore')),
  how          text,
  source       text NOT NULL DEFAULT 'manual'
               CONSTRAINT collabbox_sku_map_source_check
               CHECK (source IN ('seed_json', 'products_sku', 'manual')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.collabbox_sku_map IS
  'collabBox article code (Шифра) → products.id, plus the service rows the sync must not count as goods (8001 delivery, 8002 note, ПОЕН-* markers). Unmapped goods codes are listed per run in collabbox_sync_runs.unmapped_skus. Service-role writes.';

INSERT INTO public.collabbox_sku_map (article_code, article_name, product_id, role, how, source)
SELECT v.code, v.name, coalesce(ps.id, p.id), 'goods',
       CASE WHEN ps.id IS NOT NULL AND ps.id IS DISTINCT FROM p.id
            THEN 'products.sku overrides the JSON (' || v.how || ')' ELSE v.how END,
       CASE WHEN ps.id IS NOT NULL AND ps.id IS DISTINCT FROM p.id
            THEN 'products_sku' ELSE 'seed_json' END
  FROM (VALUES
  ('000637', 'КУРКУМА АКТИВ', '20dc61f2-8ab4-4fe0-b196-7e51d71c5d83', 'exact (with size)'),
  ('001317', 'PROSTA FIX BIONATURAL 30/1', '8ae08430-37c3-438a-b3cc-0d713bbfbc6a', 'containment'),
  ('001313', 'ARTHRO FIX BIONATURAL 30/1', 'ab09eec7-638e-44a7-ab83-1b820df4c9cb', 'containment'),
  ('000265', 'ПРОСТАТОЛ КОМПЛЕКС cps 30', '0a67af01-ba33-42fc-949e-9fc5e60960e2', 'exact (with size)'),
  ('000594', 'УРО ПРОТЕКТ 30 cps', '456139ed-0151-479b-9680-00b090075db0', 'exact (with size)'),
  ('001314', 'GLUCO FIX BIONATURAL 30/1', 'e25e349c-377e-45fb-9307-991573ac05ae', 'containment'),
  ('001539', 'NEUROFIX BIONATURAL 30/1', '8f5732dc-cf65-4cae-b1d2-1d4ae96fd479', 'exact (with size)'),
  ('001538', 'UROFIX BIONATURAL 30/1', 'fae40061-d8ad-4025-9de0-3dea17daff71', 'containment'),
  ('001536', 'PARAFIX BIONATURAL 30/1cps', '92ffb0db-e8c0-433e-bc54-707c1281f380', 'containment'),
  ('001291', 'CARDIOFIX BIONATURAL 30 cps', '17e1f647-8091-4434-9fac-94ffc21c00d7', 'containment'),
  ('001312', 'SLIM FIT BIONATURAL 30/1', 'bdc79d87-8e42-430d-8925-c3b010ca257f', 'containment'),
  ('001315', 'ALPHA MALE BIONATURAL 30.1', 'cf38ad20-8608-4a81-b852-d9b5c7d3e0cc', 'containment'),
  ('000042', 'СНАИЛ КОМПЛЕКС cps 30', '7ecd116e-b183-48f7-bb85-b01a793db9d5', 'exact (with size)'),
  ('001584', 'ADENOFRIN 20/1 cps', '87337325-528f-4007-96b2-fcc1262a55e3', 'exact (with size)'),
  ('001071', 'ПАРА ДЕТОКС 30 cps', 'e255dad4-846d-4920-9b84-424e6496b010', 'exact (with size)'),
  ('000412', 'ДИАБЕТОЛ ФОРТЕ 30cps', 'f960872c-8a5c-4ae5-a4aa-496fc2b43f3e', 'exact (with size)'),
  ('000040', 'СНАИЛ КРЕМА 100ml антиревматска туба', '0567ebad-600e-4c3b-9c05-10ecdeb3e8cb', 'exact (with size)'),
  ('001055', 'ALPHA MALE 60 cps', '74c4b953-4e9f-495e-a51f-1bf25f2e3de2', 'exact (with size)'),
  ('000940', 'ЦИНК-30 tbl', '910d1192-30c0-40eb-a83f-a5432160fbac', 'exact (with size)'),
  ('000165', 'АЛОЕ ВЕРА ГЕЛ СО АРОНИЈА 0,5Л', 'd1f5c8d7-cf12-4198-a5dc-ce1cac5e5362', 'exact (with size)'),
  ('005032', 'ELIXY Hyaluronic&Aloe Vera 45+', '62690050-795a-467d-8057-916b16bee383', 'exact (with size)'),
  ('001540', 'HEMOROFIX BIONATURAL 30/1', '1395475b-b4a4-41cf-92ba-118d3d9af794', 'containment'),
  ('000271', 'САУ ПАЛМЕТТО (Saw Palmetto) 30 cps', '2edc76db-48fb-4820-8da9-04ce52cf66db', 'exact (with size)'),
  ('000565', 'ГАСТРО АЛОЕ 500ml', 'f9efaf2a-84ba-49f6-9de0-b9d859f8665e', 'containment'),
  ('001225', 'ДР.СЛИМ 90 цпс', '41dcd909-4d23-47d5-869b-3d8c266b72a8', 'exact (with size)'),
  ('001526', 'ZINK-180/1 TAB BIONATURAL', 'a2b31d95-37b6-44f5-bb4f-7b34742503de', 'exact (with size)'),
  ('000889', 'ДИЕТ ШЕЈК Ванила 500g', '04fe60cd-5e81-41f1-a4ae-e3b2a9f94cad', 'exact (with size)'),
  ('000273', 'ГЛУКОЗАМИН СУЛФАТ 30 cps', 'b226b5c4-329b-4366-841a-8024a0de4c8b', 'exact (with size)'),
  ('000502', 'ВЕНОГЕЛ гел 100ml', '3a754b34-11cd-4fba-8913-6acb3b6ccf76', 'containment'),
  ('000893', 'ДИЕТ ШЕЈК Јагода 500g', '0962a7cc-d547-46c8-92a0-38adc0f8c4cd', 'exact (with size)'),
  ('001635', 'МЕЛЕМ R&R 30МЛ', 'bfcfb81c-fb11-4216-9211-e6f4a7dc754a', 'exact (with size)'),
  ('000593', 'Д-МАНОЗА 30cps', 'cc68b664-9703-422a-9e56-78db5bfda7ca', 'exact (with size)'),
  ('005037', 'ELIXY-hyaluronic acid-collagen&aloe vera', 'bcc3c57d-7526-4e15-ab2f-8f9850a03a03', 'exact (with size)'),
  ('000949', 'АРТРО БЛУ ГЕЛ 200 МЛ,', 'd5684d72-f24f-4a02-af02-49b5f5b44d9d', 'exact (with size)'),
  ('000891', 'ДИЕТ ШЕЈК Чоколадо 500g', '66ed167b-ebf3-4147-8ad0-8d94002b96f4', 'exact (with size)'),
  ('001072', 'ТУРМЕРИК КУРКУМИН 425МЛ', '8ff7d97c-8ac0-4b2b-a1c5-6a4b57cb0c8a', 'exact (with size)'),
  ('001026', 'ДР.СЛИМ 210гр.', '8b1d6f5e-4404-48ff-b42c-fc5376c0cd0a', 'exact (with size)'),
  ('000942', 'ВИТАМИН Д3 30tbl', 'e513e786-5292-4c11-916c-8306e8a83ddb', 'exact (name only)'),
  ('000982', 'КОЛАГЕН ПЕПТИД СО ВАНИЛА 200ГР', '6836933e-8fff-4ddd-b4f9-b43b10b67d33', 'exact (with size)'),
  ('001023', 'Колаген Пептид со МАЛИНА 200 гр', 'de3d548e-4665-49ea-bce9-49a8634bc60e', 'exact (with size)'),
  ('000109', 'АЛОЕ ВЕРА ГЕЛ СО АРОНИЈА 1Л', 'b01ce730-f4a6-4f9b-9011-bda12fcfd37d', 'exact (with size)'),
  ('000325', 'ЕПИМЕДИУМ КОМПЛЕКС 30 cps.', 'faa45e27-43c2-4f74-9315-b74bece42e1c', 'exact (with size)'),
  ('000615', 'СЛИМ КОМПЛЕКС 30cps', '45fbadb2-aaf3-4f50-9ecb-31cf52055006', 'exact (with size)'),
  ('000616', 'СЛИМ ФИБЕР 30cps', '938de0ca-28a1-4c99-9ade-3ecf59c559e6', 'exact (name only)'),
  ('000166', 'НЕУРО АКТИВ 60 cps', 'a4e10c30-f199-4f6b-8bf7-6cb946df2734', 'exact (with size)'),
  ('001524', 'B6 180/1 tab BIONATURAL', '21cf5a21-fb6b-41e2-8eb9-8aa648195505', 'exact (with size)'),
  ('001113', 'Колаген Пептид -БЕЗ ВКУС 200 гр', 'a94536dc-c34e-4b4b-818b-e6927c6433b8', 'exact (with size)'),
  ('001316', 'BRAIN FIX BIONATURAL 30/1', 'e0a4c01f-f06b-4f49-98b3-f0de309f7992', 'containment'),
  ('005031', 'ELIXY Hyaluronic&Aloe Vera 35+', '00c8958e-f431-4842-ab6c-04f69f9d1adb', 'exact (with size)'),
  ('000944', 'ВИТАМИН Б6 30tbl', '96432842-2aa1-4b95-a2ed-49e00f6ab6d6', 'exact (name only)'),
  ('000312', 'ТРИБУЛУС ТЕРЕСТРИС 30cps', '604ab890-8d89-4027-9956-946e87f1aea7', 'exact (with size)'),
  ('001571', 'MAGNESIUM CITRAT 325mg 150/1 tab', 'a93a0b66-1aca-408d-a3c3-57b6a3316ab4', 'containment'),
  ('000796', 'Имуно Буст-Капина 500 мл.', '66170d45-0689-40f5-965f-ea963ec5550a', 'exact (with size)'),
  ('001525', 'D3 180/1 tab BIONATURAL', '7ed95220-fd77-492d-b292-c6145b82e65e', 'exact (with size)'),
  ('000636', 'БРАИН АКТИВ 30cps', '4d720da7-d826-4771-915d-0c7aaa8ed194', 'exact (with size)'),
  ('001227', 'НУТРИ ШЕЈК-со вкус на ванила 500 гр.', '08e5b05d-a361-4774-90ba-73f8177e418f', 'exact (with size)'),
  ('000923', 'Л-КАРНИТИН 60 cps', 'd5877b39-e763-449f-9d9e-3ee0a7f7a7fc', 'exact (with size)'),
  ('000126', 'КУРКУМИН ЕКСТРАКТ cps 30', '1702df10-a9aa-43ff-b92a-007090c9c325', 'exact (with size)'),
  ('000448', 'Вит.Ц за возрасни 0,5ml.', 'd91cad1c-5041-43d2-b0b7-3a5901570c02', 'exact (with size)'),
  ('000489', 'БРОНХО ПРОТЕКТ 500ml', 'c5d5659f-8997-41c5-aa68-cf98032c4215', 'exact (with size)'),
  ('000604', 'Вит.Ц за возрасни 250 мл.', 'a8040b9e-f07a-4058-906d-b689f45e8067', 'exact (with size)'),
  ('001335', 'TONGAKT ALI 60/1', '7846f678-c6f2-4c3c-bb39-e19856a36f2f', 'exact (with size)'),
  ('000523', 'БИЛБЕРИ НАТУРА 30cps', '9a459687-5384-40c1-aad3-2e3290dbb332', 'exact (with size)'),
  ('000568', 'ГАСТРО ПРОТЕКТ 500ml', '79a798bc-0da2-41e4-a38f-c09fe4d838d4', 'exact (with size)'),
  ('001232', 'БИЛБЕРИ 90/1 таблети', 'faea7453-4c63-4345-9d11-d6a181a75346', 'exact (with size)'),
  ('001239', 'АРТРО ФЛЕКС 100 мл', 'ad3b4bee-9b32-489b-825c-e503b757b197', 'exact (with size)'),
  ('001054', 'ВИТАМИН Ц-1000 60 cps', 'd9e5d5fd-f80f-4eca-bbe5-a07168caba5d', 'exact (with size)'),
  ('001156', 'ЛИВЕР ДЕТОКС 90/1 cps', '5b481426-d810-4d76-b8de-ea8af1efbbca', 'exact (with size)'),
  ('005007', 'ELIXY-Дневенкрем снаил 50ml', '1e01b8be-e04d-460a-adb1-8adf96a348ef', 'exact (with size)'),
  ('005035', 'ХЕМОРО ГЕЛ 100МЛ', '472912aa-5d0b-4d65-a303-ec3bf7fead59', 'exact (with size)'),
  ('001228', 'НУТРИ ШЕЈК-со вкус на чоколадо 500гр.', 'a787c8b1-205a-4b2c-84c2-db3076dc3f54', 'exact (with size)'),
  ('001229', 'НУТРИ ШЕЈК-со вкус на јагода 500 гр.', 'e10ab6fc-eda4-47a8-9ddf-7a0536c603c4', 'exact (with size)'),
  ('001112', 'Колаген Пептид -ЧОКОЛАДО 200 гр', 'f4e2c96b-571d-4620-bbf5-097fed5fe026', 'exact (with size)'),
  ('000541', 'ТИГРОВА МАСТ 30ml', '6b2e1c91-d2f2-4028-a068-b31cc61141e0', 'exact (with size)'),
  ('000592', 'КУРКУМАКТИВ 250ml', '042fd198-eeb6-4d05-922b-8089403a0f51', 'exact (with size)'),
  ('005005', 'ELIXY-Серум со 20%снаил екстракт', 'd9aa8e45-1c04-4fee-b031-433759006fe1', 'exact (with size)'),
  ('001200', 'ФЕММЕ 7 60 cps', 'c3ce5bde-6967-4564-8c58-4a085305aad7', 'exact (with size)'),
  ('000605', 'ТЕЧЕН КОЛАГЕН 250 мл.', 'cc561012-c751-4d67-84ec-40c076b49388', 'exact (with size)'),
  ('005006', 'ELIXY-Ноќен крем снаил 50ml', '3231056c-16ea-453f-92ee-82431a92d770', 'exact (with size)'),
  ('001529', 'ЦИНК 365/1 таб', '54ee17b2-b88e-4f6d-bcdf-778560d9a4ad', 'exact (with size)'),
  ('005012', 'ELIXY Хијалурон и Алое серум 30ml', 'c955d1bf-325b-44c7-bb7d-29ed4d5ea38d', 'exact (with size)'),
  ('001129', 'МАГНЕСИУМ 325 МГ 60/1', '7de94a98-1abc-45e5-94aa-48f397178a4e', 'exact (with size)'),
  ('000797', 'Имуно Буст-Портокал/Ананас 500 мл.', 'b78bc6f1-3989-4945-a38a-85843d77f4c2', 'exact (with size)'),
  ('000652', 'ЧИА ТЕРАПИЈА со вит.Ц Jаболко 500ml', '6b399f77-3d74-4ff3-a2d8-d4ead6479ec5', 'exact (with size)'),
  ('001074', 'ЗЕЛЕН ЧАЈ ЕКСТРАКТ 60/1 cps', '9f22d4af-5efb-4a08-84c7-8db624ee3adc', 'exact (with size)'),
  ('005015', 'АЛОЕ БОДИ ГЕЛ 100ml', '79035f81-394a-4b45-82cf-8d132a3038b1', 'exact (with size)'),
  ('005034', 'Р и Р Мелем 100 мл.', '0f6e5240-0e90-4b56-a18f-86e2b49b9969', 'exact (with size)'),
  ('001333', 'SHILAJIT 60/1 cps', '07f086f7-39d8-40e3-a55b-f45d0e0f713c', 'exact (with size)'),
  ('001427', 'Мача со колаген 175гр', '9c08eb88-fc01-4050-9983-fb4df76c8c2f', 'exact (with size)'),
  ('001654', 'ZINC 120/1 tab ФИЗИЧКИ', '432bde3d-2ed5-4127-9747-3c6ea64f6e41', 'exact (with size)'),
  ('700085', '1 DR.SLIM POWDER+2 DR.SLIM CAPS', '763d7435-0bc7-4ef9-b4a3-f543186b0874', 'exact (with size)'),
  ('001527', 'ВИТАМИН Д3 365/1 таб', 'fb450a97-8fde-4591-99d5-83b3caa7ce93', 'exact (with size)'),
  ('000503', 'БРОНХО ПРОТЕКТ 250ml', 'ecb31fdc-6224-44bd-857b-648b78a0694c', 'exact (with size)'),
  ('001461', 'МАТАЛКА ЗА НЕС', '3e5e29b3-1921-4dbc-8ad6-4f312a560e60', 'exact (with size)'),
  ('005008', 'ELIXY-Околуочен крем 30ml', 'fe262460-3161-4b43-b948-d386d14a34d8', 'exact (with size)'),
  ('000306', 'ЗЕЛЕН ЧАЈ ЕКСТРАКТ 30 cps', '84cb7e1c-b313-485d-b657-bdb4e8d3ecf6', 'exact (with size)'),
  ('001293', 'Natural Laxative 100% 90/1 cps', '94c86a2d-0258-4687-8ca4-bd591f6e287a', 'exact (with size)'),
  ('001277', 'Natural Fiber 100% 210gr', '9f6001cd-5521-4eb4-b234-28460afdfa15', 'exact (with size)'),
  ('001661', 'VITAMIN D3 120/1 tab', 'c5baa58c-238c-442d-8ee6-66147c7709ec', 'exact (with size)'),
  ('000941', 'СЛЕЕП МЕЛАТОНИН 30 tbl', '0d8459a2-7a74-4997-a6d4-4abf773172c9', 'exact (with size)'),
  ('005042', 'ELIXY-анти-инфламаторен гел 200 мл', '69b7dd41-8c84-43c9-b795-e8f2adbf27f6', 'exact (with size)'),
  ('001128', 'ВИТАМИН Ц 500МГ/60 ТАБ', 'b66acbb5-287c-4dff-98a0-69c9c3c374e7', 'exact (with size)'),
  ('001058', 'ХЕМОРО ФОРТЕ', 'cf71eecc-5289-4e4b-bfa0-93d19ad204e7', 'exact (with size)'),
  ('000583', 'ЧИА ТЕРАПИЈА со вит.Ц Диња 500ml', '0ba6c1aa-7400-4dea-9ac9-07196b01c492', 'exact (with size)'),
  ('000890', 'ШЕЈКЕР', '52fc3fd3-67f7-4443-a4b4-9993de796315', 'exact (with size)'),
  ('001110', 'ВИТАМИН Д3 180 tbl', '6455af36-3aa4-444b-bb67-f0e302e4e60a', 'exact (with size)'),
  ('005030', 'ELIXY-ТЕРМО ГЕЛ 200ml+КРИО ГЕЛ 200ml', 'b3f71472-0600-43a9-9b24-338de4b1ff68', 'exact (with size)'),
  ('000602', 'ЦИНК 60tbl', '08d8378d-7fb9-4470-8c20-5cdf7d2f29d9', 'exact (with size)'),
  ('000456', 'ТЕЧЕН ХЛОРОФИЛ 500ml', '9ae2a1a7-a645-4404-afe6-1bd6de88ecef', 'exact (with size)'),
  ('000601', 'ВИТАМИН Д3 60 tbl', '985b7f2a-08fa-4ec5-abf6-00d3f723664e', 'exact (with size)'),
  ('001073', 'АШВАГАНДА ЕКСТРАКТ 60/1 cps', '7c28153d-01a4-4bab-b0dd-8b3864e32f85', 'exact (with size)'),
  ('000585', 'БЈУТИ КОЛАГЕН 500мл', 'eaa75b4e-92ff-4f37-8001-c828db96a8a1', 'exact (with size)'),
  ('8003', 'СТЕГАЧ', 'd89d0473-8317-4214-b276-0d8ab9b49802', 'exact (with size)'),
  ('001311', 'ВЕНО ГАРД 30/1', '946efd4e-908b-4cce-ade6-195e330f1fea', 'exact (with size)'),
  ('001537', 'LIVERFIX 30/1 BIONATURAL', 'daf9023e-c5fd-4900-9160-6f430a6ac979', 'exact (with size)'),
  ('001630', 'VITAMIN D3+K2+BOR 180/1 tab', '2adfb3b1-3b1c-4405-b611-e0acf85d6b00', 'exact (with size)'),
  ('000313', 'ЦИТРУС ЕКСТРАКТ 30cps', '8065e5a7-ba7d-41f6-bca3-dfd8ee65db81', 'exact (with size)'),
  ('001230', 'ДР.СЛИМ РАСТИТЕЛЕН 210 гр', 'fe3d1bf9-67ba-40ab-ab7e-7e341bd3d6ed', 'exact (with size)'),
  ('001214', 'ГЛУКАТОЛ 180/1 cps', '72db3682-3497-4395-83a8-9593ddacefdd', 'exact (with size)'),
  ('005043', 'ELIXY-Шампон Алое вера 500 мл.', '146a38e1-6d48-4b85-8263-02d3840d534b', 'exact (with size)'),
  ('001159', 'САМБУКУС сируп 250 мл', '318077bc-32bc-4e9b-aee6-33ddcfe71380', 'exact (with size)'),
  ('005019', 'ELIXY-Серум со витамин Ц', '30add053-f69a-4903-954d-50645540bdaa', 'exact (with size)'),
  ('001462', 'БРОНХО ПРОТЕКТ ФОРТЕ 500 мл', '2b4391b5-88d4-409e-bfc2-2fca5e1df747', 'exact (with size)'),
  ('001150', 'ОСТЕО ФИКС 180 cps', '2d950e9d-6acd-45fe-ad6f-9f56ef99acfc', 'exact (with size)'),
  ('005023', 'Еликси Колаген серум 30 мл', '85048dcd-9dc9-4c32-b601-cfdcef9f2d4c', 'exact (with size)'),
  ('001530', 'МЕЛАТОНИН 365/1 таб', '20aa7e33-be8c-495b-a925-d34addf7e105', 'exact (with size)'),
  ('001575', 'MAGNESIUM+ZINK+B complex 120/1 TAB', '56299955-d23a-4d07-acfb-d6002945a0db', 'exact (with size)'),
  ('001033', 'ИЗО МАКС ЈАГОДА 250 гр', 'b3efc2d8-5e6d-46a2-b6d3-d95e0545b21f', 'exact (with size)'),
  ('000994', 'АЛОЕ АРОНИЈА СО ВИТ Ц ЦИНК И Д3 500МЛ', 'a6d0e53f-2e1d-4a8d-bf22-4753b755bf7c', 'exact (with size)'),
  ('001075', 'МАКА ЕКСТРАКТ 60/1 cps', '02c76e4c-6df1-415a-9610-d7ca8845d6f5', 'exact (with size)'),
  ('700100', 'Глукатол 30 cps', '310309b6-b363-478e-bc1d-8154637ce8c8', 'exact (with size)'),
  ('001223', 'ХИАЛУРОН 5 90 гр', 'b056281f-2005-4254-8692-f51f8eeb28fa', 'exact (with size)'),
  ('000953', 'КРЕАТИН ВО ПРАВ 200ГР', 'c801c3cc-c3e5-4fec-aeb8-733c546d33c7', 'exact (with size)'),
  ('001019', 'CALM антистрес формула 30 1', 'a0ac8f5a-e48f-4b7e-b2cd-65ac0c1a1db8', 'exact (with size)'),
  ('000584', 'ЧИА ТЕРАПИЈА со вит.Ц Лубени. 500ml', '6b3736b5-53e5-47b1-bbd6-1f2a657d10dd', 'exact (with size)'),
  ('005046', 'Elixy капсули за коса 60/1', '0d3e23a1-d9ce-4f7b-bbd2-e0e3cb21fc47', 'exact (with size)'),
  ('001641', 'MAGNESIUM GEL 50ml', 'cfeea178-f0bc-4c4c-a989-032112ffaf5a', 'exact (with size)'),
  ('001659', 'MAGNESIUM BISGLYCINATE 120/1', 'ab0619ab-4e13-49c7-8ed0-b97bbb4ef0ab', 'exact (with size)'),
  ('000301', 'ЕКСТРАКТ ОД ЦРНО ГОЏИ cps 30', '766bf69e-8ae6-4ba0-90cd-c28f0dba98a4', 'exact (with size)'),
  ('002391', 'Ф-50 КРЕМА ЗА СОНЧАЊЕ ЛИЦЕ 50 мл.', '1cbd1e9d-31db-4332-b398-4ed37ba3e394', 'exact (with size)'),
  ('700022', 'ALPHA MALE 2 + 1 TRIBULUS 60CPS', 'b724ffd0-5332-4238-ab2f-74ab6ef27297', 'exact (with size)'),
  ('000300', 'РЕСВЕРАТРОЛ КОМПЛЕКС 30 cps', '6a1b278a-fec5-41b0-8a64-86fc74430055', 'exact (with size)'),
  ('005047', 'ELIXY Алое Крема SPF 20 50мл', '7705d06d-fccf-4fb2-80ed-0185de104d69', 'exact (with size)'),
  ('000597', 'Витамин Ц за деца со Д3 250 мл.', 'a79c814f-55f6-427a-af83-fec127e7b450', 'exact (with size)'),
  ('001088', '100 % whey протеин ванила 500gr', 'ce455c6d-0e66-4b2e-8740-c44ec802ab14', 'exact (with size)'),
  ('002366', 'Магнезиум гел 250мл', 'a7932e0b-f596-4410-aa66-1aa48d5e55b6', 'exact (with size)'),
  ('000957', 'БЦАА ВО ПРАВ 200 ГР', 'a168b5e5-9f2e-414d-9289-025b17ca2ee2', 'exact (with size)'),
  ('000194', 'КУРКУМИН ЛИКВИД 0,5 Л.', '4364ddc3-c6a4-48de-ace8-ea623d71f5da', 'exact (with size)'),
  ('ХЕЛАНКИ', 'ХЕЛАНКИ ХЛ', '7b5e8083-bf95-498c-8385-9f5c15902220', 'exact (with size)'),
  ('001111', 'КИДС МУЛТИВИТАМИНС 60 tbl', '71bece5b-129f-45d9-ad54-6dade62ce574', 'exact (with size)'),
  ('600071', 'БРАИН 1+1', 'dd849486-79b6-4901-922b-f8cb593dad39', 'exact (with size)'),
  ('001087', '100 % whey протеин чоколадо 500gr', '5957bc0d-825e-41fc-9087-02b03b5fab07', 'exact (with size)'),
  ('000328', 'ХЕПАТОЛ ФОРТЕ 30 cps', 'a05eabed-4e65-4fe8-b3f4-62300fcbbb3a', 'containment'),
  ('700036', '1 ГЛУТАМИН + 2 КРЕАТИН', '6c8ae9d1-016e-4ec0-8253-8a841e5ef269', 'exact (with size)'),
  ('001318', '100% WHEY ВАНИЛА 2.0 КГ', '014f1d2c-bd9e-402b-bc92-5b6047fcb3d3', 'exact (with size)'),
  ('001201', 'ФЕММЕ 7 1+1', '35a1cda5-23ac-49af-8c74-5e104f87954c', 'exact (name only)'),
  ('005017', 'ELIXY Масло од марула 30 ml', '287fb838-e897-4e3f-a249-15b0bf9ca693', 'exact (with size)'),
  ('005010', 'ELIXY Масло од авокадо 30 ml', '373f6352-5f2f-4226-8050-6a18c5b8e09c', 'exact (with size)'),
  ('000305', 'СПИРУЛИНА КАПСУЛИ cps 60- (600мг)', 'f5ee28d2-b839-4cb2-888e-d37d6f664756', 'exact (with size)'),
  ('001515', 'GASTRO COMFORT 30/1 cps', 'c57ec1bd-6a4c-48e0-8744-637b9f68d6fa', 'exact (with size)'),
  ('001670', 'ZINC 120/1 tab', '3ff3e198-94c7-4f05-8eb9-d723daeedaa3', 'exact (with size)'),
  ('001573', 'MAGNESIUM+ B6 150/1 tab', '578b42d3-c182-48fc-a43f-e0e66749f61f', 'exact (with size)'),
  ('001660', 'VITAMIN B6 120/1 tab', '931cb587-1f07-4687-a337-0ac9c788c700', 'exact (name only)'),
  ('000543', 'МЕГА МУЛТИВИТАМИН 250 мл.', 'e5a11614-77f7-4373-bf93-6e81eef9dccc', 'exact (with size)'),
  ('001061', '100 % whey протеин чоколадо 1.2кг', '2da1de15-e62d-45cb-a795-741065b76161', 'exact (with size)'),
  ('000319', 'АЛОЕ РОЈАЛ 0,5 Л', '605b5017-afed-4c3d-ac1a-9ff56e5cee7c', 'exact (with size)'),
  ('000536', 'ГАСТРО ПРОТЕКТ 250 ml', '4820aa2c-fea5-4f6e-9395-b8bd4fc50a7a', 'exact (with size)'),
  ('000425', 'АЛОЕ СОК со вкус на портокал 500 ml', 'a91db622-5716-482a-b1dc-ece926cc7a53', 'exact (with size)'),
  ('005040', 'ELIXY -крем за лице HYDRATING 100 мл', '9bbc3c65-a610-49a3-86ff-b559ff7e6550', 'exact (with size)'),
  ('000074', 'АЛОЕ ВЕРА ГЕЛ СО РЕСВЕРАТРОЛ 1Л', 'd37e7cb6-5e7b-4c22-820f-a04a3ed1acc8', 'exact (with size)'),
  ('001155', 'КИДС МУЛТИВИТАМИНС 120 tbl', '2a39c3cd-73a1-4f4b-9eef-4307e3b73d8d', 'exact (with size)'),
  ('000752', 'ОМЕГА 3 КАПКИ 30ml', '292d5e5e-1cb0-49d7-a724-9e2d07983bbe', 'exact (with size)'),
  ('000033', 'Вит.Ц за возрасни 1л.', '539d21d1-aae0-46ef-8963-dda59ac6d150', 'exact (with size)')
  ) AS v(code, name, product_id, how)
  LEFT JOIN public.products p ON p.id = v.product_id::uuid
  LEFT JOIN LATERAL (
    SELECT x.id FROM public.products x
     WHERE x.sku = v.code
     ORDER BY x.is_active DESC NULLS LAST, x.created_at
     LIMIT 1) ps ON true
 WHERE coalesce(ps.id, p.id) IS NOT NULL
ON CONFLICT (article_code) DO NOTHING;

-- Catalogue codes the JSON does not know (products created from collabBox
-- after 2026-08-12, e.g. 001152 ВИТАМИН Д3 90 tbl).
INSERT INTO public.collabbox_sku_map (article_code, article_name, product_id, role, how, source)
SELECT DISTINCT ON (p.sku) p.sku, p.name, p.id, 'goods', 'products.sku', 'products_sku'
  FROM public.products p
 WHERE p.sku ~ '^[0-9]{6}$'
 ORDER BY p.sku, p.is_active DESC NULLS LAST, p.created_at
ON CONFLICT (article_code) DO NOTHING;

-- Service rows: never goods, never counted in the price.
INSERT INTO public.collabbox_sku_map (article_code, article_name, product_id, role, how, source) VALUES
  ('8001', 'ДОСТАВА', NULL, 'delivery', 'delivery fee (150 ден) — not goods', 'manual'),
  ('8002', 'ЗАБЕЛЕШКА / free-text line', NULL, 'note', 'operator note typed as a line — goes to order_notes', 'manual')
ON CONFLICT (article_code) DO UPDATE
  SET role = EXCLUDED.role, product_id = NULL, how = EXCLUDED.how, updated_at = now();

-- ── 6. The ledger ───────────────────────────────────────────────────────────
-- One row per collabBox document of the channel types, whatever became of
-- it. PK = DocNumber, which is ALSO the MEX tracking id of its parcel.
--   kind    sale · replacement · annotate_only (social / web / LEADS /
--           LEADS-OUT) · no_courier (10055) · store · unknown_series (a
--           teleshop type outside 9100/9102, 10063 / 10058 / 10099)
--   action  what the LAST pass did: created · enriched · annotated ·
--           conflict · skipped_unchanged · skipped_replacement (no previous
--           sale to note it on) · skipped_social · skipped_web ·
--           skipped_no_order · skipped_store · skipped_no_courier ·
--           skipped_unknown_series · skipped_duplicate (a concurrent writer
--           created the same order)
--   first_action  the FIRST pass's action, never changed ('created' = this
--           sync owns the order)
--   order_id      the order this document IS (created, or found by external
--           ref / parcel)
--   related_order_id  conflict: the order holding the parcel · replacement:
--           the previous sale the note went on
--   deleted_at    set when a full re-read of the document's day no longer
--           returns it (deleted / reversed in collabBox); cleared if it returns
CREATE TABLE IF NOT EXISTS public.collabbox_documents (
  doc_number       text PRIMARY KEY,
  doc_id           text,
  object_id        text,
  doc_type_id      text NOT NULL,
  doc_type_name    text,
  series           text GENERATED ALWAYS AS (
                     CASE WHEN doc_number ~ '^[0-9]{3}-[0-9]{4}-'
                          THEN split_part(doc_number, '-', 2)
                     END
                   ) STORED,
  doc_at           timestamptz NOT NULL,
  komitent_id      text,
  customer_name    text,
  phone8           text,
  phone_source     text CONSTRAINT collabbox_documents_phone_source_check
                   CHECK (phone_source IN ('registry', 'parcel')),
  address          text,
  city             text,
  author           text,
  amount_mkd       numeric(14, 2),
  goods_mkd        numeric(14, 2),
  delivery_mkd     numeric(14, 2),
  lines            jsonb NOT NULL DEFAULT '[]'::jsonb,
  note_lines       text[],
  kind             text NOT NULL
                   CONSTRAINT collabbox_documents_kind_check
                   CHECK (kind IN ('sale', 'replacement', 'annotate_only', 'no_courier',
                                   'store', 'unknown_series')),
  order_id         uuid REFERENCES public.orders(id) ON DELETE SET NULL,
  related_order_id uuid REFERENCES public.orders(id) ON DELETE SET NULL,
  action           text NOT NULL
                   CONSTRAINT collabbox_documents_action_check
                   CHECK (action IN ('created', 'enriched', 'annotated', 'conflict',
                                     'skipped_unchanged', 'skipped_replacement',
                                     'skipped_social', 'skipped_web', 'skipped_no_order',
                                     'skipped_store', 'skipped_no_courier',
                                     'skipped_unknown_series', 'skipped_duplicate')),
  first_action     text NOT NULL,
  author_credit    text,
  source           text NOT NULL
                   CONSTRAINT collabbox_documents_source_check
                   CHECK (source IN ('feed', 'backfill', 'upload')),
  run_id           uuid,
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  raw              jsonb
);

COMMENT ON TABLE public.collabbox_documents IS
  'collabBox document ledger (2026-09-28): one row per document of the channel types (teleshop 10036/10050, social 10106, web 10112, LEADS 10111, LEADS-OUT 10114, 10055, 10063/10058/10099), what it is (kind) and what the sync did (action / first_action / order_id / related_order_id / author_credit). PK DocNumber = the MEX tracking id. Written only by collabbox_apply_documents / collabbox_close_window. Money + PII: business owners only.';

CREATE INDEX IF NOT EXISTS idx_collabbox_documents_doc_at    ON public.collabbox_documents (doc_at);
CREATE INDEX IF NOT EXISTS idx_collabbox_documents_type_at   ON public.collabbox_documents (doc_type_id, doc_at);
CREATE INDEX IF NOT EXISTS idx_collabbox_documents_order     ON public.collabbox_documents (order_id) WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_collabbox_documents_related   ON public.collabbox_documents (related_order_id) WHERE related_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_collabbox_documents_komitent  ON public.collabbox_documents (komitent_id);
CREATE INDEX IF NOT EXISTS idx_collabbox_documents_kind      ON public.collabbox_documents (kind, action);

-- ── 7. RLS — owners read, the service role writes ───────────────────────────
ALTER TABLE public.collabbox_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.collabbox_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.collabbox_sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.collabbox_sku_map   ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS collabbox_documents_select_owners ON public.collabbox_documents;
CREATE POLICY collabbox_documents_select_owners ON public.collabbox_documents
  FOR SELECT TO authenticated
  USING ((SELECT public.is_business_owner(auth.uid())));

DROP POLICY IF EXISTS collabbox_customers_select_owners ON public.collabbox_customers;
CREATE POLICY collabbox_customers_select_owners ON public.collabbox_customers
  FOR SELECT TO authenticated
  USING ((SELECT public.is_business_owner(auth.uid())));

-- Run health and the SKU map hold no PII: owners, admin and manager.
DROP POLICY IF EXISTS collabbox_sync_runs_select ON public.collabbox_sync_runs;
CREATE POLICY collabbox_sync_runs_select ON public.collabbox_sync_runs
  FOR SELECT TO authenticated
  USING (
    (SELECT public.is_business_owner(auth.uid()))
    OR (SELECT public.has_role(auth.uid(), 'admin'::app_role))
    OR (SELECT public.has_role(auth.uid(), 'manager'::app_role))
  );

DROP POLICY IF EXISTS collabbox_sku_map_select ON public.collabbox_sku_map;
CREATE POLICY collabbox_sku_map_select ON public.collabbox_sku_map
  FOR SELECT TO authenticated
  USING (
    (SELECT public.is_business_owner(auth.uid()))
    OR (SELECT public.has_role(auth.uid(), 'admin'::app_role))
    OR (SELECT public.has_role(auth.uid(), 'manager'::app_role))
  );

REVOKE ALL ON public.collabbox_documents, public.collabbox_customers,
              public.collabbox_sync_runs, public.collabbox_sku_map
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.collabbox_documents, public.collabbox_customers,
                public.collabbox_sync_runs, public.collabbox_sku_map TO authenticated;
GRANT ALL    ON public.collabbox_documents, public.collabbox_customers,
                public.collabbox_sync_runs, public.collabbox_sku_map TO service_role;

-- ── 8. Small pure helpers (KEEP IN STEP with supabase/functions/collabbox-sync/collabbox.ts) ──
-- "2026-09-25T20:17:03" | "2026-09-25 20:17" | "2026-09-25" | "25.09.2026 20:17:03"
-- (Skopje wall clock, no offset) → timestamptz. Date only → 12:00 Skopje.
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

-- A number as the fetcher sends it (JSON number or "1234.5"); anything else NULL.
CREATE OR REPLACE FUNCTION public.collabbox_num(p_value text)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT CASE WHEN btrim(coalesce(p_value, '')) ~ '^-?[0-9]+(\.[0-9]+)?$'
              THEN btrim(p_value)::numeric END;
$fn$;

-- A Macedonian phone as typed → its 8 national digits, or NULL. The first
-- number of a "070… / 071…" pair wins; 00389 / 389 / trunk 0 are stripped;
-- exactly 8 digits must remain (the create-missing-orders rule — mex-reconcile's
-- 8–9 digit tolerance is for MEX's own field only).
CREATE OR REPLACE FUNCTION public.collabbox_phone8(p_raw text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT n.d
    FROM regexp_split_to_table(coalesce(p_raw, ''), '[/,;]') WITH ORDINALITY AS t(part, ord)
    CROSS JOIN LATERAL (
      SELECT regexp_replace(regexp_replace(regexp_replace(
               regexp_replace(t.part, '[^0-9]', '', 'g'),
               '^00389', ''), '^389', ''), '^0', '') AS d) n
   WHERE length(n.d) = 8
   ORDER BY t.ord
   LIMIT 1;
$fn$;

-- What a line item is. KEEP IN STEP with lineRole() in collabbox.ts.
CREATE OR REPLACE FUNCTION public.collabbox_line_role(p_code text, p_name text)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $fn$
  SELECT CASE
    WHEN m.role IS NOT NULL AND m.role <> 'goods'                          THEN m.role
    WHEN coalesce(p_code, '') ~ '^\s*(ПОЕН|Поен|поен)'
      OR coalesce(p_name, '') ~ '^\s*(ПОЕН|Поен|поен)'                      THEN 'marker'
    WHEN coalesce(p_name, '') ~ '^\s*(ЗАБЕЛЕШКА|Забелешка|забелешка)'      THEN 'note'
    ELSE 'goods'
  END
  FROM (SELECT 1) one
  LEFT JOIN public.collabbox_sku_map m ON m.article_code = btrim(p_code);
$fn$;

CREATE OR REPLACE FUNCTION public.collabbox_bump(p_counts jsonb, p_key text, p_by integer DEFAULT 1)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT CASE WHEN p_key IS NULL THEN coalesce(p_counts, '{}'::jsonb)
              ELSE jsonb_set(coalesce(p_counts, '{}'::jsonb), ARRAY[p_key],
                             to_jsonb(coalesce((p_counts ->> p_key)::integer, 0) + p_by))
         END;
$fn$;

REVOKE ALL ON FUNCTION public.collabbox_parse_local(text), public.collabbox_num(text),
                       public.collabbox_phone8(text), public.collabbox_line_role(text, text),
                       public.collabbox_bump(jsonb, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.collabbox_parse_local(text), public.collabbox_num(text),
                          public.collabbox_phone8(text), public.collabbox_line_role(text, text),
                          public.collabbox_bump(jsonb, text, integer)
  TO service_role;

-- ── 9. The komitent writer ──────────────────────────────────────────────────
-- p_rows: [{komitent_id, object_id, name, phone, mobile, address, city, country}]
-- ≤ 5.000 per call. A 'snapshot' row never overwrites a row the live feed
-- wrote (the snapshot is older); feed/upload rows update only what changed.
CREATE OR REPLACE FUNCTION public.collabbox_upsert_customers(
  p_run    uuid,
  p_rows   jsonb,
  p_source text DEFAULT 'feed')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _src text := coalesce(nullif(p_source, ''), 'feed');
  _res jsonb;
BEGIN
  IF _src NOT IN ('feed', 'snapshot', 'upload') THEN
    RAISE EXCEPTION 'collabbox_upsert_customers: unknown source %', _src USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'collabbox_upsert_customers: p_rows must be a JSON array' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF jsonb_array_length(p_rows) > 5000 THEN
    RAISE EXCEPTION 'collabbox_upsert_customers: at most 5000 rows per call' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  WITH r AS (
    SELECT DISTINCT ON (k.id)
           k.id AS komitent_id,
           nullif(btrim(x.v ->> 'object_id'), '') AS object_id,
           nullif(btrim(x.v ->> 'name'), '')      AS name,
           public.collabbox_phone8(coalesce(nullif(btrim(x.v ->> 'mobile'), ''), x.v ->> 'phone')) AS p_mobile_first,
           public.collabbox_phone8(x.v ->> 'phone') AS p_phone,
           nullif(btrim(x.v ->> 'phone'), '')     AS phone_raw,
           nullif(btrim(x.v ->> 'mobile'), '')    AS mobile_raw,
           nullif(btrim(x.v ->> 'address'), '')   AS address,
           nullif(btrim(x.v ->> 'city'), '')      AS city,
           nullif(btrim(x.v ->> 'country'), '')   AS country
      FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS x(v, ord)
      CROSS JOIN LATERAL (SELECT nullif(btrim(x.v ->> 'komitent_id'), '') AS id) k
     WHERE k.id IS NOT NULL
     ORDER BY k.id, x.ord DESC
  ), up AS (
    INSERT INTO public.collabbox_customers AS c
           (komitent_id, object_id, name, phone8, phone_raw, mobile_raw, address, city, country, source, run_id)
    SELECT r.komitent_id, r.object_id, r.name, coalesce(r.p_mobile_first, r.p_phone),
           r.phone_raw, r.mobile_raw, r.address, r.city, r.country, _src, p_run
      FROM r
    ON CONFLICT (komitent_id) DO UPDATE
       SET object_id  = coalesce(EXCLUDED.object_id, c.object_id),
           name       = coalesce(EXCLUDED.name, c.name),
           phone8     = coalesce(EXCLUDED.phone8, c.phone8),
           phone_raw  = EXCLUDED.phone_raw,
           mobile_raw = EXCLUDED.mobile_raw,
           address    = coalesce(EXCLUDED.address, c.address),
           city       = coalesce(EXCLUDED.city, c.city),
           country    = coalesce(EXCLUDED.country, c.country),
           source     = EXCLUDED.source,
           run_id     = EXCLUDED.run_id,
           updated_at = now()
     WHERE (_src <> 'snapshot' OR c.source = 'snapshot')
       AND (c.object_id, c.name, c.phone8, c.phone_raw, c.mobile_raw, c.address, c.city, c.country)
           IS DISTINCT FROM
           (coalesce(EXCLUDED.object_id, c.object_id), coalesce(EXCLUDED.name, c.name),
            coalesce(EXCLUDED.phone8, c.phone8), EXCLUDED.phone_raw, EXCLUDED.mobile_raw,
            coalesce(EXCLUDED.address, c.address), coalesce(EXCLUDED.city, c.city),
            coalesce(EXCLUDED.country, c.country))
    RETURNING (xmax = 0) AS inserted
  )
  SELECT jsonb_build_object(
           'ok', true,
           'rows', (SELECT count(*) FROM r),
           'with_phone', (SELECT count(*) FROM r WHERE coalesce(r.p_mobile_first, r.p_phone) IS NOT NULL),
           'inserted', count(*) FILTER (WHERE up.inserted),
           'updated', count(*) FILTER (WHERE NOT up.inserted))
    INTO _res
    FROM up;
  RETURN _res;
END;
$fn$;

COMMENT ON FUNCTION public.collabbox_upsert_customers(uuid, jsonb, text) IS
  'collabBox komitent registry writer (service role): upsert by komitent_id; phone8 = Мобилен else Телефон (collabbox_phone8). A snapshot row never overwrites a feed row. Returns {rows, with_phone, inserted, updated}.';

REVOKE ALL ON FUNCTION public.collabbox_upsert_customers(uuid, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.collabbox_upsert_customers(uuid, jsonb, text) TO service_role;

-- ── 10. Seller credit from a LEADS / LEADS-OUT author (owner decision 2) ────
-- Internal. Returns what it did (or, dry, would do):
--   stamped            sold_* were all NULL → sold_at = coalesce(confirmed_at,
--                      document time), sold_via 'collabbox', sold_by_ext =
--                      author, sold_by_person_id = the collabbox_author identity
--   stamped_no_person  the same, no identity for that author yet (Settings →
--                      Teams names it later; stamp_order_deciders' fill pass
--                      then completes the person)
--   person_filled      already stamped via collabbox with this very author,
--                      person was NULL → filled
--   no_identity        …and still no identity
--   already            a person is already credited
--   other_decider      stamped by another rule / decider (an AlterCPA id, an
--                      import operator): never overwritten, never mixed
--   not_a_sale         not a real sale (status, price 0, synthetic product)
-- Only NULL → value writes (tg_orders_sold_write_once allows exactly those).
CREATE OR REPLACE FUNCTION public.collabbox_credit_order(
  p_order  uuid,
  p_author text,
  p_doc_at timestamptz,
  p_dry    boolean)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _o      record;
  _person uuid;
  _author text := nullif(btrim(p_author), '');
BEGIN
  IF p_order IS NULL OR _author IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT o.status::text AS status, o.price, o.product_name, o.confirmed_at,
         o.sold_at, o.sold_via, o.sold_by_ext, o.sold_by_person_id
    INTO _o
    FROM public.orders o
   WHERE o.id = p_order;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF _o.sold_by_person_id IS NOT NULL THEN
    RETURN 'already';
  END IF;
  IF _o.status NOT IN ('confirmed', 'shipped', 'delivered', 'paid', 'returned')
     OR coalesce(_o.price, 0) <= 0
     OR public.is_synthetic_product_name(_o.product_name) THEN
    RETURN 'not_a_sale';
  END IF;

  SELECT i.person_id INTO _person
    FROM public.sales_person_identities i
   WHERE i.kind = 'collabbox_author' AND i.account_id IS NULL AND i.value = _author;

  IF _o.sold_at IS NULL AND _o.sold_via IS NULL AND _o.sold_by_ext IS NULL THEN
    IF NOT p_dry THEN
      PERFORM set_config('elyon.keep_updated_at', 'on', true);
      UPDATE public.orders o
         SET sold_at           = coalesce(o.confirmed_at, p_doc_at, o.created_at),
             sold_via          = 'collabbox',
             sold_by_ext       = _author,
             sold_by_person_id = _person
       WHERE o.id = p_order
         AND o.sold_at IS NULL AND o.sold_via IS NULL AND o.sold_by_ext IS NULL
         AND o.sold_by_person_id IS NULL;
      PERFORM set_config('elyon.keep_updated_at', '', true);
    END IF;
    RETURN CASE WHEN _person IS NULL THEN 'stamped_no_person' ELSE 'stamped' END;
  END IF;

  IF _o.sold_via = 'collabbox' AND _o.sold_by_ext = _author THEN
    IF _person IS NULL THEN
      RETURN 'no_identity';
    END IF;
    IF NOT p_dry THEN
      PERFORM set_config('elyon.keep_updated_at', 'on', true);
      UPDATE public.orders o
         SET sold_by_person_id = _person
       WHERE o.id = p_order AND o.sold_by_person_id IS NULL;
      PERFORM set_config('elyon.keep_updated_at', '', true);
    END IF;
    RETURN 'person_filled';
  END IF;

  RETURN 'other_decider';
END;
$fn$;

COMMENT ON FUNCTION public.collabbox_credit_order(uuid, text, timestamptz, boolean) IS
  'Internal (collabBox sync, owner decision 2026-09-28 #2): credit the collabBox LEADS/LEADS-OUT author as the seller of the order holding that document''s parcel — NULL → value only (write-once sold_*), person via sales_person_identities kind collabbox_author. Returns stamped | stamped_no_person | person_filled | no_identity | already | other_decider | not_a_sale.';

REVOKE ALL ON FUNCTION public.collabbox_credit_order(uuid, text, timestamptz, boolean)
  FROM PUBLIC, anon, authenticated, service_role;

-- ── 11. One document ────────────────────────────────────────────────────────
-- Internal; called per document by collabbox_apply_documents inside its own
-- subtransaction (one bad document never aborts the batch). p_doc:
--   { doc_number, doc_id, object_id, doc_type_id, doc_type_name,
--     doc_at ("YYYY-MM-DDTHH:MM:SS", Skopje wall clock), komitent_id,
--     customer_name, author, amount_mkd, currency,
--     lines: [{ code, name, qty, value_mkd, group, brand }] }
-- p_dry: every read, no write — the returned action is what apply would do.
CREATE OR REPLACE FUNCTION public.collabbox_apply_one(
  p_run    uuid,
  p_doc    jsonb,
  p_dry    boolean,
  p_source text,
  p_bulk   boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  -- MKD_PER_EUR — FROZEN (CLAUDE.md). Never "update" it: re-price in EUR instead.
  c_rate     CONSTANT numeric     := 61.5;
  -- MEX coverage of the NATURA account (see the header): before this, a
  -- document with no parcel is a settled legacy sale.
  c_boundary CONSTANT timestamptz := timestamptz '2026-04-01 00:00:00 Europe/Skopje';
  _doc        text := nullif(btrim(p_doc ->> 'doc_number'), '');
  _type       text := nullif(btrim(p_doc ->> 'doc_type_id'), '');
  _author     text := nullif(btrim(p_doc ->> 'author'), '');
  _kom        text := nullif(btrim(p_doc ->> 'komitent_id'), '');
  _series     text;
  _doc_at     timestamptz;
  _amount     numeric;
  _in_lines   jsonb;
  _has_lines  boolean;
  _rlines     jsonb;
  _goods      numeric;
  _delivery   numeric;
  _notes      text[];
  _top        uuid;
  _pname      text;
  _qty        integer;
  _unmapped   jsonb;
  _p          public.mex_parcels%ROWTYPE;
  _has_p      boolean := false;
  _c          public.collabbox_customers%ROWTYPE;
  _has_c      boolean := false;
  _phone8     text;
  _phone_src  text;
  _mismatch   boolean := false;
  _e164       text;
  _name       text;
  _city       text;
  _address    text;
  _prev       public.collabbox_documents%ROWTYPE;
  _has_prev   boolean := false;
  _o          record;
  _has_o      boolean := false;
  _kind       text;
  _action     text;
  _order_id   uuid;
  _related    uuid;
  _credit     text;
  _status     text;
  _paid_at    timestamptz;
  _basis      text;
  _shipped_at timestamptz;
  _ret_at     timestamptz;
  _link       text;
  _changed    boolean := false;
  _price      numeric;
  _need_fill  boolean := false;
  _need_items boolean := false;
  _need_price boolean := false;
  _need_link  boolean := false;
  _need_stat  boolean := false;
  _holder_now uuid;
BEGIN
  IF _doc IS NULL THEN
    RAISE EXCEPTION 'collabbox: a document without doc_number' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF _type IS NULL OR _type !~ '^[0-9]{3,8}$' THEN
    RAISE EXCEPTION 'collabbox: % has no doc_type_id', _doc USING ERRCODE = 'invalid_parameter_value';
  END IF;
  _doc_at := public.collabbox_parse_local(p_doc ->> 'doc_at');
  IF _doc_at IS NULL THEN
    RAISE EXCEPTION 'collabbox: % has no parseable doc_at (%)', _doc, p_doc ->> 'doc_at'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  _series := CASE WHEN _doc ~ '^[0-9]{3}-[0-9]{4}-' THEN split_part(_doc, '-', 2) END;
  _amount := public.collabbox_num(p_doc ->> 'amount_mkd');
  _in_lines := CASE WHEN jsonb_typeof(p_doc -> 'lines') = 'array' THEN p_doc -> 'lines' ELSE '[]'::jsonb END;
  _has_lines := jsonb_array_length(_in_lines) > 0;

  -- ── lines: role, product (map, then the catalogue's own sku), value ──────
  WITH l AS (
    SELECT x.ord,
           nullif(btrim(x.v ->> 'code'), '')                  AS code,
           btrim(coalesce(x.v ->> 'name', ''))                AS name,
           coalesce(public.collabbox_num(x.v ->> 'qty'), 0)       AS qty,
           coalesce(public.collabbox_num(x.v ->> 'value_mkd'), 0) AS val
      FROM jsonb_array_elements(_in_lines) WITH ORDINALITY AS x(v, ord)
  ), r AS (
    SELECT l.*,
           public.collabbox_line_role(l.code, l.name) AS role,
           coalesce(m.product_id,
                    (SELECT p.id FROM public.products p
                      WHERE l.code IS NOT NULL AND p.sku = l.code
                      ORDER BY p.is_active DESC NULLS LAST, p.created_at
                      LIMIT 1)) AS product_id
      FROM l
      LEFT JOIN public.collabbox_sku_map m ON m.article_code = l.code AND m.role = 'goods'
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
                    'code', r.code, 'name', r.name, 'qty', r.qty, 'value_mkd', r.val,
                    'role', r.role,
                    'product_id', CASE WHEN r.role = 'goods' THEN r.product_id END)
                  ORDER BY r.ord), '[]'::jsonb),
         coalesce(sum(r.val) FILTER (WHERE r.role = 'goods'), 0),
         coalesce(sum(r.val) FILTER (WHERE r.role = 'delivery'), 0),
         array_agg(r.name ORDER BY r.ord) FILTER (WHERE r.role = 'note' AND r.name <> ''),
         (array_agg(r.product_id ORDER BY r.val DESC, r.ord)
            FILTER (WHERE r.role = 'goods' AND r.product_id IS NOT NULL))[1],
         left(string_agg(r.name, ' + ' ORDER BY r.ord) FILTER (WHERE r.role = 'goods' AND r.name <> ''), 300),
         coalesce(sum(greatest(round(r.qty), 0)) FILTER (WHERE r.role = 'goods'), 0)::integer,
         coalesce(jsonb_object_agg(r.code, r.name)
                    FILTER (WHERE r.role = 'goods' AND r.product_id IS NULL AND r.code IS NOT NULL), '{}'::jsonb)
    INTO _rlines, _goods, _delivery, _notes, _top, _pname, _qty, _unmapped
    FROM r;
  IF NOT _has_lines THEN
    _goods := coalesce(_amount, 0);          -- a document without lines: its header amount
  END IF;
  _price := round(_goods / c_rate, 2);

  -- ── context: parcel, customer, ledger, existing order ────────────────────
  SELECT * INTO _p FROM public.mex_parcels WHERE tracking_id = _doc;
  _has_p := FOUND;
  IF _kom IS NOT NULL THEN
    SELECT * INTO _c FROM public.collabbox_customers WHERE komitent_id = _kom;
    _has_c := FOUND;
  END IF;
  -- Phone: the registry first (it is the customer's own record and carries
  -- the address), the parcel's receiver as fallback and confirmation.
  IF _has_c AND _c.phone8 IS NOT NULL THEN
    _phone8 := _c.phone8; _phone_src := 'registry';
  END IF;
  IF _has_p AND _p.phone8 IS NOT NULL THEN
    IF _phone8 IS NULL THEN
      _phone8 := _p.phone8; _phone_src := 'parcel';
    ELSIF _phone8 <> _p.phone8 THEN
      _mismatch := true;
    END IF;
  END IF;
  _e164 := CASE WHEN _phone8 IS NOT NULL THEN '+389' || _phone8 END;
  _name := left(coalesce(nullif(btrim(CASE WHEN _has_c THEN _c.name END), ''),
                         nullif(btrim(p_doc ->> 'customer_name'), ''),
                         nullif(btrim(CASE WHEN _has_p THEN _p.receiver_name END), ''),
                         '—'), 200);
  _city := left(coalesce(nullif(btrim(CASE WHEN _has_c THEN _c.city END), ''),
                         nullif(btrim(CASE WHEN _has_p THEN _p.receiver_city END), ''), ''), 120);
  _address := left(coalesce(nullif(btrim(CASE WHEN _has_c THEN _c.address END), ''), ''), 600);

  SELECT * INTO _prev FROM public.collabbox_documents WHERE doc_number = _doc;
  _has_prev := FOUND;

  SELECT o.id, o.status::text AS status, o.price, o.product_id, o.customer_phone,
         o.confirmed_by_name, o.mex_tracking_id, o.mex_status_id, o.packed_at
    INTO _o
    FROM public.orders o
   WHERE o.external_source = 'collabbox' AND o.external_order_id = _doc;
  _has_o := FOUND;

  -- ── kind ─────────────────────────────────────────────────────────────────
  _kind := CASE
    WHEN _type IN ('10036', '10050') THEN
      CASE WHEN _series IS NULL OR _series NOT IN ('9100', '9102') THEN 'unknown_series'
           WHEN _goods <= 0 OR coalesce(_amount, 0) <= 0
             OR (_has_p AND coalesce(_p.cod_mkd, 0) = 0)            THEN 'replacement'
           ELSE 'sale'
      END
    WHEN _type IN ('10106', '10112', '10111', '10114')                THEN 'annotate_only'
    WHEN _type = '10055'                                              THEN 'no_courier'
    WHEN _type IN ('10063', '10058', '10099')                         THEN 'unknown_series'
    ELSE 'store'
  END;

  -- ── 1. SALE ──────────────────────────────────────────────────────────────
  IF _kind = 'sale' AND _has_o THEN
    -- ENRICH an order this document already is (ours, or an earlier import).
    _order_id := _o.id;
    _need_fill := (_o.product_id IS NULL AND _top IS NOT NULL)
               OR (coalesce(_o.customer_phone, '') = '' AND _e164 IS NOT NULL)
               OR (_o.confirmed_by_name IS NULL AND _author IS NOT NULL);
    _need_items := _top IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM public.order_items i
                                WHERE i.order_id = _o.id AND i.product_id IS NOT NULL);
    -- A document edited before it shipped: only an order THIS sync created,
    -- still to pack, with no parcel.
    _need_price := _o.status = 'confirmed' AND _o.mex_status_id IS NULL AND _o.packed_at IS NULL
               AND _has_prev AND _prev.first_action = 'created'
               AND _price > 0 AND _price IS DISTINCT FROM _o.price;
    _need_link := _has_p AND _p.order_id IS NULL
               AND (_o.mex_tracking_id IS NULL OR _o.mex_tracking_id = _doc);
    IF _has_p AND _p.order_id IS NOT NULL AND _p.order_id <> _o.id THEN
      _related := _p.order_id;             -- held by another order: reported, never forced
    END IF;

    IF NOT p_dry THEN
      IF _need_fill OR _need_items THEN
        PERFORM set_config('elyon.keep_updated_at', 'on', true);
        IF _need_fill THEN
          UPDATE public.orders o
             SET product_id        = coalesce(o.product_id, _top),
                 customer_phone    = CASE WHEN coalesce(o.customer_phone, '') = '' AND _e164 IS NOT NULL
                                          THEN _e164 ELSE o.customer_phone END,
                 confirmed_by_name = coalesce(o.confirmed_by_name, _author)
           WHERE o.id = _o.id;
        END IF;
        IF _need_items AND NOT _need_price THEN
          -- The order has no product-mapped line (the 2026-09 teleshop import
          -- wrote names only, notes and ПОЕН markers included): rebuild its
          -- items from the document. No table references order_items.
          DELETE FROM public.order_items WHERE order_id = _o.id;
          INSERT INTO public.order_items (order_id, product_id, product_name, quantity, price_per_unit, total_price, created_at)
          SELECT _o.id, (x ->> 'product_id')::uuid, left(coalesce(nullif(x ->> 'name', ''), '—'), 300),
                 greatest(round((x ->> 'qty')::numeric), 1)::integer,
                 round((x ->> 'value_mkd')::numeric / greatest(round((x ->> 'qty')::numeric), 1) / c_rate, 2),
                 round((x ->> 'value_mkd')::numeric / c_rate, 2),
                 _doc_at
            FROM jsonb_array_elements(_rlines) x
           WHERE x ->> 'role' = 'goods'
             AND ((x ->> 'qty')::numeric > 0 OR (x ->> 'value_mkd')::numeric > 0);
          INSERT INTO public.order_notes (order_id, text, author_id, author_name, created_at)
          SELECT _o.id, 'collabBox: ' || n, NULL, 'collabBox', _doc_at
            FROM unnest(coalesce(_notes, '{}'::text[])) n
           WHERE NOT EXISTS (SELECT 1 FROM public.order_notes x
                              WHERE x.order_id = _o.id AND x.text = 'collabBox: ' || n);
        END IF;
        PERFORM set_config('elyon.keep_updated_at', '', true);
      END IF;

      IF _need_price THEN
        -- a real business change: updated_at moves, the segment trigger runs
        UPDATE public.orders o
           SET price = _price,
               quantity = greatest(_qty, 1),
               product_name = coalesce(_pname, o.product_name),
               product_id = coalesce(_top, o.product_id)
         WHERE o.id = _o.id;
        DELETE FROM public.order_items WHERE order_id = _o.id;
        INSERT INTO public.order_items (order_id, product_id, product_name, quantity, price_per_unit, total_price, created_at)
        SELECT _o.id, (x ->> 'product_id')::uuid, left(coalesce(nullif(x ->> 'name', ''), '—'), 300),
               greatest(round((x ->> 'qty')::numeric), 1)::integer,
               round((x ->> 'value_mkd')::numeric / greatest(round((x ->> 'qty')::numeric), 1) / c_rate, 2),
               round((x ->> 'value_mkd')::numeric / c_rate, 2),
               _doc_at
          FROM jsonb_array_elements(_rlines) x
         WHERE x ->> 'role' = 'goods'
           AND ((x ->> 'qty')::numeric > 0 OR (x ->> 'value_mkd')::numeric > 0);
        INSERT INTO public.order_notes (order_id, text, author_id, author_name)
        VALUES (_o.id, format('collabBox document %s was edited — price %s → %s EUR.', _doc, _o.price, _price),
                NULL, 'collabBox');
      END IF;

      IF _need_link THEN
        _link := public.mex_link_parcel(_doc, _o.id, 'collabbox_import', false);
        IF _link = 'conflict' THEN
          SELECT order_id INTO _related FROM public.mex_parcels WHERE tracking_id = _doc;
        END IF;
      END IF;
    END IF;

    -- Status from the parcel — only a still-confirmed order, forward-only,
    -- exactly what mex-reconcile would apply (it keeps the order current
    -- from then on).
    IF _o.status = 'confirmed' AND _has_p AND coalesce(_o.price, 0) > 0
       AND (_p.order_id = _o.id OR (_p.order_id IS NULL AND _need_link)) THEN
      _need_stat := true;
      _status := CASE _p.status_id WHEN 2 THEN 'paid' WHEN 7 THEN 'returned' ELSE 'shipped' END;
      IF NOT p_dry THEN
        SELECT order_id INTO _holder_now FROM public.mex_parcels WHERE tracking_id = _doc;
        IF _holder_now = _o.id THEN
          UPDATE public.orders o
             SET status      = _status::public.order_status,
                 shipped_at  = coalesce(o.shipped_at, _p.created_at_mex, _doc_at),
                 paid_at     = CASE WHEN _status = 'paid' THEN coalesce(_p.delivered_at, _p.last_update_at, now()) END,
                 paid_basis  = CASE WHEN _status = 'paid' THEN 'mex' END,
                 returned_at = CASE WHEN _status = 'returned' THEN coalesce(_p.returned_at, _p.last_update_at, now()) ELSE o.returned_at END
           WHERE o.id = _o.id AND o.status = 'confirmed';
          IF FOUND THEN
            INSERT INTO public.order_history (order_id, from_status, to_status, changed_by, changed_by_name)
            VALUES (_o.id, 'confirmed', _status::public.order_status, NULL, 'System (collabbox:sync)');
          END IF;
        ELSE
          _need_stat := false;
        END IF;
      END IF;
    END IF;

    _changed := _need_fill OR _need_items OR _need_price OR (_need_link AND coalesce(_link, 'linked') IN ('linked', 'already')) OR _need_stat;
    _action := CASE WHEN _related IS NOT NULL THEN 'conflict'
                    WHEN _changed THEN 'enriched'
                    ELSE 'skipped_unchanged' END;

  ELSIF _kind = 'sale' THEN
    -- CREATE — unless another order already holds this parcel (decision 5).
    _related := CASE WHEN _has_p THEN _p.order_id END;
    IF _related IS NULL THEN
      SELECT o.id INTO _related
        FROM public.orders o
       WHERE o.mex_tracking_id = _doc
       ORDER BY o.created_at
       LIMIT 1;
    END IF;

    IF _related IS NOT NULL THEN
      _action := 'conflict';
    ELSE
      IF _has_p THEN
        _status := CASE _p.status_id WHEN 2 THEN 'paid' WHEN 7 THEN 'returned' ELSE 'shipped' END;
        _shipped_at := coalesce(_p.created_at_mex, _doc_at);
        IF _status = 'paid' THEN
          _paid_at := coalesce(_p.delivered_at, _p.last_update_at, _shipped_at);
          _basis := 'mex';
        ELSIF _status = 'returned' THEN
          _ret_at := coalesce(_p.returned_at, _p.last_update_at, _shipped_at);
        END IF;
      ELSIF _doc_at < c_boundary THEN
        _status := 'paid';                 -- 2026-08-12 rule: pre-MEX collabBox sales are settled
        _paid_at := _doc_at;
        _basis := 'legacy_import';
      ELSE
        _status := 'confirmed';            -- to pack; the courier decides from here
      END IF;

      IF p_dry THEN
        _action := 'created';
      ELSE
        BEGIN
          INSERT INTO public.orders (
                 product_id, product_name, customer_name, customer_phone, customer_city, customer_address,
                 price, quantity, status, source_type, external_source, external_order_id,
                 created_at, confirmed_at, confirmed_by_name, mex_tracking_id,
                 paid_at, paid_basis, shipped_at, returned_at)
          VALUES (_top,
                  coalesce(_pname, left(coalesce(nullif(p_doc ->> 'doc_type_name', ''), 'collabBox') || ' ' || _doc, 300)),
                  _name, coalesce(_e164, ''), _city, _address,
                  _price, greatest(_qty, 1), _status::public.order_status, 'import', 'collabbox', _doc,
                  _doc_at, _doc_at, _author,
                  -- the remembered link: a MEX-era document names its parcel-to-be
                  CASE WHEN _has_p OR _doc_at >= c_boundary THEN _doc END,
                  _paid_at, _basis, _shipped_at, _ret_at)
          RETURNING id INTO _order_id;

          INSERT INTO public.order_items (order_id, product_id, product_name, quantity, price_per_unit, total_price, created_at)
          SELECT _order_id, (x ->> 'product_id')::uuid, left(coalesce(nullif(x ->> 'name', ''), '—'), 300),
                 greatest(round((x ->> 'qty')::numeric), 1)::integer,
                 round((x ->> 'value_mkd')::numeric / greatest(round((x ->> 'qty')::numeric), 1) / c_rate, 2),
                 round((x ->> 'value_mkd')::numeric / c_rate, 2),
                 _doc_at
            FROM jsonb_array_elements(_rlines) x
           WHERE x ->> 'role' = 'goods'
             AND ((x ->> 'qty')::numeric > 0 OR (x ->> 'value_mkd')::numeric > 0);

          INSERT INTO public.order_notes (order_id, text, author_id, author_name, created_at)
          SELECT _order_id, 'collabBox: ' || n, NULL, 'collabBox', _doc_at
            FROM unnest(coalesce(_notes, '{}'::text[])) n;

          IF NOT p_bulk THEN
            INSERT INTO public.order_history (order_id, from_status, to_status, changed_by, changed_by_name)
            VALUES (_order_id, NULL, _status::public.order_status, NULL, 'System (collabbox:sync)');
          END IF;

          IF _e164 IS NOT NULL THEN
            INSERT INTO public.customer_profiles (phone, customer_name, city, street)
            VALUES (_e164, _name, nullif(_city, ''), nullif(_address, ''))
            ON CONFLICT (phone) DO NOTHING;
          END IF;

          IF _has_p THEN
            -- trg_orders_link_parcel already claimed a free parcel as
            -- 'unknown_writer'; this names the method. 'conflict' = another
            -- linker won the race since the check above → undo this order.
            _link := public.mex_link_parcel(_doc, _order_id, 'collabbox_import', false);
            IF _link = 'conflict' THEN
              RAISE EXCEPTION 'collabbox: parcel % was claimed concurrently', _doc USING ERRCODE = 'CBX01';
            END IF;
          END IF;
          _action := 'created';
        EXCEPTION
          WHEN SQLSTATE 'CBX01' THEN
            _order_id := NULL;
            _action := 'conflict';
            SELECT order_id INTO _related FROM public.mex_parcels WHERE tracking_id = _doc;
          WHEN unique_violation THEN
            -- a concurrent writer created the same (external_source, external_order_id)
            _order_id := NULL;
            _action := 'skipped_duplicate';
            SELECT o.id INTO _order_id FROM public.orders o
             WHERE o.external_source = 'collabbox' AND o.external_order_id = _doc;
        END;
      END IF;
    END IF;

  -- ── 2. REPLACEMENT — not an order (decision 4) ───────────────────────────
  ELSIF _kind = 'replacement' THEN
    IF _has_o THEN
      _order_id := _o.id;                  -- a historic price-0 row that IS this document
    END IF;
    IF _e164 IS NOT NULL THEN
      SELECT o.id INTO _related
        FROM public.orders o
       WHERE o.customer_phone = _e164
         AND o.price > 0
         AND o.status IN ('confirmed', 'shipped', 'delivered', 'paid', 'returned')
         AND o.created_at <= _doc_at
         AND o.id IS DISTINCT FROM _order_id
         AND o.not_counted_reason IS NULL
       ORDER BY o.created_at DESC
       LIMIT 1;
    END IF;
    IF _related IS NOT NULL THEN
      _action := 'annotated';
      IF NOT p_dry AND NOT (_has_prev AND _prev.related_order_id IS NOT DISTINCT FROM _related) THEN
        INSERT INTO public.order_notes (order_id, text, author_id, author_name)
        VALUES (_related,
                format('collabBox replacement %s (%s, %s ден, parcel COD %s): %s — sent at no charge; not a new sale.',
                       _doc, to_char(_doc_at AT TIME ZONE 'Europe/Skopje', 'DD.MM.YYYY'),
                       coalesce(_amount, 0), coalesce(CASE WHEN _has_p THEN _p.cod_mkd::text END, 'no parcel yet'),
                       coalesce(_pname, array_to_string(_notes, '; '), '—')),
                NULL, 'collabBox');
      END IF;
    ELSE
      _action := CASE WHEN _has_o THEN 'annotated' ELSE 'skipped_replacement' END;
    END IF;

  -- ── 3. LEDGER ONLY — social, web, LEADS, LEADS-OUT ───────────────────────
  ELSIF _kind = 'annotate_only' THEN
    _order_id := CASE WHEN _has_o THEN _o.id WHEN _has_p THEN _p.order_id END;
    IF _order_id IS NULL THEN
      SELECT o.id INTO _order_id FROM public.orders o
       WHERE o.mex_tracking_id = _doc
       ORDER BY o.created_at
       LIMIT 1;
    END IF;
    IF _order_id IS NOT NULL THEN
      _action := 'annotated';
      IF _type IN ('10111', '10114') AND _author IS NOT NULL THEN
        _credit := public.collabbox_credit_order(_order_id, _author, _doc_at, p_dry);
      END IF;
    ELSE
      _action := CASE _type WHEN '10106' THEN 'skipped_social'
                            WHEN '10112' THEN 'skipped_web'
                            ELSE 'skipped_no_order' END;
    END IF;

  ELSE
    _action := 'skipped_' || _kind;        -- store · no_courier · unknown_series
  END IF;

  -- ── the ledger row ───────────────────────────────────────────────────────
  IF NOT p_dry THEN
    INSERT INTO public.collabbox_documents AS d (
           doc_number, doc_id, object_id, doc_type_id, doc_type_name, doc_at, komitent_id,
           customer_name, phone8, phone_source, address, city, author, amount_mkd, goods_mkd,
           delivery_mkd, lines, note_lines, kind, order_id, related_order_id, action,
           first_action, author_credit, source, run_id, first_seen_at, last_seen_at,
           deleted_at, raw)
    VALUES (_doc, nullif(p_doc ->> 'doc_id', ''), nullif(p_doc ->> 'object_id', ''), _type,
            nullif(p_doc ->> 'doc_type_name', ''), _doc_at, _kom,
            nullif(btrim(p_doc ->> 'customer_name'), ''), _phone8, _phone_src,
            nullif(_address, ''), nullif(_city, ''), _author, _amount, _goods, _delivery,
            _rlines, _notes, _kind, _order_id, _related, _action,
            _action, _credit, p_source, p_run, now(), now(), NULL, p_doc - 'lines')
    ON CONFLICT (doc_number) DO UPDATE
       SET doc_id           = coalesce(EXCLUDED.doc_id, d.doc_id),
           object_id        = coalesce(EXCLUDED.object_id, d.object_id),
           doc_type_id      = EXCLUDED.doc_type_id,
           doc_type_name    = coalesce(EXCLUDED.doc_type_name, d.doc_type_name),
           doc_at           = EXCLUDED.doc_at,
           komitent_id      = EXCLUDED.komitent_id,
           customer_name    = EXCLUDED.customer_name,
           phone8           = coalesce(EXCLUDED.phone8, d.phone8),
           phone_source     = coalesce(EXCLUDED.phone_source, d.phone_source),
           address          = coalesce(EXCLUDED.address, d.address),
           city             = coalesce(EXCLUDED.city, d.city),
           author           = EXCLUDED.author,
           amount_mkd       = EXCLUDED.amount_mkd,
           goods_mkd        = EXCLUDED.goods_mkd,
           delivery_mkd     = EXCLUDED.delivery_mkd,
           lines            = EXCLUDED.lines,
           note_lines       = EXCLUDED.note_lines,
           kind             = EXCLUDED.kind,
           order_id         = coalesce(EXCLUDED.order_id, d.order_id),
           related_order_id = coalesce(EXCLUDED.related_order_id, d.related_order_id),
           action           = EXCLUDED.action,
           author_credit    = coalesce(EXCLUDED.author_credit, d.author_credit),
           run_id           = EXCLUDED.run_id,
           last_seen_at     = now(),
           deleted_at       = NULL,
           raw              = EXCLUDED.raw;
  END IF;

  RETURN jsonb_build_object(
    'doc', _doc, 'type', _type, 'kind', _kind, 'action', _action,
    'order_id', _order_id, 'related_order_id', _related, 'credit', _credit,
    'status', CASE WHEN _action = 'created' THEN _status END,
    'price_eur', CASE WHEN _action = 'created' THEN _price END,
    'phone_source', _phone_src, 'phone_mismatch', _mismatch, 'no_phone', _e164 IS NULL,
    'cod0_value', (_kind = 'replacement' AND _goods > 0),
    'unmapped', _unmapped);
END;
$fn$;

COMMENT ON FUNCTION public.collabbox_apply_one(uuid, jsonb, boolean, text, boolean) IS
  'Internal (collabBox sync): classify and apply ONE document — create / enrich a teleshop order, record a conflict or a replacement, annotate a ledger-only document and credit a LEADS author. See the migration header for the rules. Called only by collabbox_apply_documents.';

REVOKE ALL ON FUNCTION public.collabbox_apply_one(uuid, jsonb, boolean, text, boolean)
  FROM PUBLIC, anon, authenticated, service_role;

-- ── 12. The writer ──────────────────────────────────────────────────────────
-- p_opts: { dry: bool, bulk: bool, source: 'feed' | 'backfill' | 'upload' }
--   dry  — nothing is written (not even the ledger); the result says what
--          apply would do. p_run may be NULL.
--   bulk — the history backfill: no notification bells (elyon.bulk_repair),
--          segment recomputes QUEUED (elyon.defer_segments), no per-order
--          order_history row. Both switches are transaction-local.
-- ≤ 1.000 documents per call (the Edge Function sends one day, ≤ 300 a call).
CREATE OR REPLACE FUNCTION public.collabbox_apply_documents(
  p_run  uuid,
  p_docs jsonb,
  p_opts jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _dry     boolean := coalesce((p_opts ->> 'dry')::boolean, false);
  _bulk    boolean := coalesce((p_opts ->> 'bulk')::boolean, false);
  _source  text    := coalesce(nullif(p_opts ->> 'source', ''), 'feed');
  _d       jsonb;
  _r       jsonb;
  _n       integer := 0;
  _err     integer := 0;
  _eur     numeric := 0;
  _kinds   jsonb := '{}'::jsonb;
  _actions jsonb := '{}'::jsonb;
  _ka      jsonb := '{}'::jsonb;
  _credits jsonb := '{}'::jsonb;
  _stat    jsonb := '{}'::jsonb;
  _phone   jsonb := '{}'::jsonb;
  _unmap   jsonb := '{}'::jsonb;
  _errs    jsonb := '[]'::jsonb;
  _confl   jsonb := '[]'::jsonb;
BEGIN
  IF _source NOT IN ('feed', 'backfill', 'upload') THEN
    RAISE EXCEPTION 'collabbox_apply_documents: unknown source %', _source USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_docs IS NULL OR jsonb_typeof(p_docs) <> 'array' THEN
    RAISE EXCEPTION 'collabbox_apply_documents: p_docs must be a JSON array' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF jsonb_array_length(p_docs) > 1000 THEN
    RAISE EXCEPTION 'collabbox_apply_documents: at most 1000 documents per call' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT _dry AND p_run IS NULL THEN
    RAISE EXCEPTION 'collabbox_apply_documents: a run id is required to write' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF _bulk AND NOT _dry THEN
    PERFORM set_config('elyon.bulk_repair', 'on', true);
    PERFORM set_config('elyon.defer_segments', 'on', true);
  END IF;

  FOR _d IN SELECT value FROM jsonb_array_elements(p_docs) LOOP
    _n := _n + 1;
    BEGIN
      _r := public.collabbox_apply_one(p_run, _d, _dry, _source, _bulk);
      _kinds   := public.collabbox_bump(_kinds, _r ->> 'kind');
      _actions := public.collabbox_bump(_actions, _r ->> 'action');
      _ka      := public.collabbox_bump(_ka, (_r ->> 'kind') || ':' || (_r ->> 'action'));
      _credits := public.collabbox_bump(_credits, _r ->> 'credit');
      _phone   := public.collabbox_bump(_phone, CASE WHEN (_r ->> 'kind') = 'sale'
                                                     THEN coalesce(_r ->> 'phone_source', 'none') END);
      IF (_r ->> 'phone_mismatch')::boolean THEN _phone := public.collabbox_bump(_phone, 'registry_vs_parcel_differ'); END IF;
      IF (_r ->> 'cod0_value')::boolean THEN _kinds := public.collabbox_bump(_kinds, 'replacement_value_gt0_cod0'); END IF;
      IF (_r ->> 'action') = 'created' THEN
        _eur  := _eur + coalesce((_r ->> 'price_eur')::numeric, 0);
        _stat := public.collabbox_bump(_stat, _r ->> 'status');
      END IF;
      IF (_r ->> 'action') = 'conflict' AND jsonb_array_length(_confl) < 25 THEN
        _confl := _confl || jsonb_build_array(jsonb_build_object('doc', _r ->> 'doc', 'held_by', _r ->> 'related_order_id'));
      END IF;
      _unmap := _unmap || coalesce(_r -> 'unmapped', '{}'::jsonb);
    EXCEPTION WHEN OTHERS THEN
      _err := _err + 1;
      IF jsonb_array_length(_errs) < 25 THEN
        _errs := _errs || jsonb_build_array(jsonb_build_object('doc', _d ->> 'doc_number', 'error', left(SQLERRM, 300)));
      END IF;
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true, 'dry', _dry, 'bulk', _bulk, 'docs', _n, 'errors', _err,
    'kinds', _kinds, 'actions', _actions, 'kind_action', _ka, 'credits', _credits,
    'created_status', _stat, 'created_eur', round(_eur, 2), 'phones', _phone,
    'unmapped_skus', _unmap, 'error_sample', _errs, 'conflict_sample', _confl);
END;
$fn$;

COMMENT ON FUNCTION public.collabbox_apply_documents(uuid, jsonb, jsonb) IS
  'collabBox sync writer (service role, 2026-09-28): upsert the ledger and create / enrich teleshop orders from up to 1000 documents; p_opts {dry, bulk, source}. Per-document subtransactions: one bad document is counted in errors, never aborts the batch. Returns counts by kind / action / credit, created status and EUR, phone sources, unmapped SKUs and samples.';

REVOKE ALL ON FUNCTION public.collabbox_apply_documents(uuid, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.collabbox_apply_documents(uuid, jsonb, jsonb) TO service_role;

-- ── 13. Documents that vanished from a fully re-read window ─────────────────
-- Called after EVERY document of [p_from, p_to] (Skopje dates) of p_types was
-- applied under p_run. A ledger row of that window and those types that p_run
-- did not see was deleted or reversed in collabBox → deleted_at. The order
-- THIS sync created for it is cancelled only while nothing else happened to
-- it: still confirmed, not packed, no parcel anywhere. Anything further along
-- keeps its status (MEX decides) and just gets a note.
CREATE OR REPLACE FUNCTION public.collabbox_close_window(
  p_run   uuid,
  p_from  date,
  p_to    date,
  p_types text[],
  p_dry   boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _lo        timestamptz := p_from::timestamp AT TIME ZONE 'Europe/Skopje';
  _hi        timestamptz := (p_to + 1)::timestamp AT TIME ZONE 'Europe/Skopje';
  _gone      text[];
  _cancelled integer := 0;
  _noted     integer := 0;
BEGIN
  IF p_run IS NULL OR p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 62
     OR p_types IS NULL OR cardinality(p_types) = 0 THEN
    RAISE EXCEPTION 'collabbox_close_window: run, a window of ≤ 63 days and types are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT coalesce(array_agg(d.doc_number), '{}'::text[]) INTO _gone
    FROM public.collabbox_documents d
   WHERE d.doc_at >= _lo AND d.doc_at < _hi
     AND d.doc_type_id = ANY (p_types)
     AND d.deleted_at IS NULL
     AND d.run_id IS DISTINCT FROM p_run;

  IF NOT p_dry AND cardinality(_gone) > 0 THEN
    UPDATE public.collabbox_documents SET deleted_at = now()
     WHERE doc_number = ANY (_gone);

    WITH c AS (
      UPDATE public.orders o
         SET status = 'cancelled',
             cancellation_reason = 'other',
             cancellation_reason_notes = 'collabBox document ' || d.doc_number
                                         || ' no longer exists (deleted or reversed in collabBox)'
        FROM public.collabbox_documents d
       WHERE d.doc_number = ANY (_gone)
         AND d.first_action = 'created'
         AND o.id = d.order_id
         AND o.status = 'confirmed'
         AND o.packed_at IS NULL
         AND o.mex_status_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM public.mex_parcels p
                          WHERE p.order_id = o.id OR p.tracking_id = d.doc_number)
      RETURNING o.id
    ), h AS (
      INSERT INTO public.order_history (order_id, from_status, to_status, changed_by, changed_by_name)
      SELECT c.id, 'confirmed', 'cancelled', NULL, 'System (collabbox:sync)' FROM c
      RETURNING 1
    )
    SELECT count(*) INTO _cancelled FROM h;

    INSERT INTO public.order_notes (order_id, text, author_id, author_name)
    SELECT d.order_id,
           'collabBox document ' || d.doc_number || ' is no longer in collabBox (deleted or reversed) — '
             || CASE WHEN o.status = 'cancelled' AND o.cancellation_reason_notes LIKE 'collabBox document%'
                     THEN 'the order was cancelled before packing.'
                     ELSE 'status left to the courier.' END,
           NULL, 'collabBox'
      FROM public.collabbox_documents d
      JOIN public.orders o ON o.id = d.order_id
     WHERE d.doc_number = ANY (_gone);
    GET DIAGNOSTICS _noted = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object('ok', true, 'dry', p_dry, 'gone', cardinality(_gone),
                            'orders_cancelled', _cancelled, 'orders_noted', _noted,
                            'sample', to_jsonb(_gone[1:20]));
END;
$fn$;

COMMENT ON FUNCTION public.collabbox_close_window(uuid, date, date, text[], boolean) IS
  'collabBox sync (service role): after a FULL re-read of [p_from, p_to] (Skopje) for p_types under p_run, mark ledger documents p_run did not see as deleted_at; cancel the order this sync created for one only while it is still confirmed, unpacked and parcel-less; note the rest. Returns {gone, orders_cancelled, orders_noted, sample}.';

REVOKE ALL ON FUNCTION public.collabbox_close_window(uuid, date, date, text[], boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.collabbox_close_window(uuid, date, date, text[], boolean) TO service_role;

-- ── 14. LEADS author credit — the sweep ─────────────────────────────────────
-- The per-document credit runs when a LEADS / LEADS-OUT document is applied;
-- this sweep catches orders that took the parcel AFTER (mex-reconcile linking
-- it later) and identities added in Settings → Teams. Dry by default.
CREATE OR REPLACE FUNCTION public.collabbox_credit_authors(
  p_dry   boolean DEFAULT true,
  p_limit integer DEFAULT 5000)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _r      record;
  _credit text;
  _counts jsonb := '{}'::jsonb;
  _n      integer := 0;
BEGIN
  FOR _r IN
    SELECT DISTINCT ON (o.id) o.id AS order_id, d.doc_number, d.author, d.doc_at, d.order_id AS ledger_order
      FROM public.collabbox_documents d
      LEFT JOIN public.mex_parcels p ON p.tracking_id = d.doc_number
      JOIN public.orders o ON o.id = coalesce(d.order_id, p.order_id)
     WHERE d.doc_type_id IN ('10111', '10114')
       AND d.deleted_at IS NULL
       AND d.author IS NOT NULL
       AND o.sold_by_person_id IS NULL
     ORDER BY o.id, d.doc_at DESC
     LIMIT greatest(coalesce(p_limit, 5000), 1)
  LOOP
    _n := _n + 1;
    _credit := public.collabbox_credit_order(_r.order_id, _r.author, _r.doc_at, p_dry);
    _counts := public.collabbox_bump(_counts, coalesce(_credit, 'none'));
    IF NOT p_dry THEN
      UPDATE public.collabbox_documents
         SET order_id = coalesce(order_id, _r.order_id),
             author_credit = coalesce(_credit, author_credit)
       WHERE doc_number = _r.doc_number
         AND (order_id IS NULL OR author_credit IS DISTINCT FROM coalesce(_credit, author_credit));
    END IF;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'dry', p_dry, 'candidates', _n, 'credits', _counts);
END;
$fn$;

COMMENT ON FUNCTION public.collabbox_credit_authors(boolean, integer) IS
  'collabBox sync (service role): sweep LEADS / LEADS-OUT ledger documents whose order (by ledger or by parcel link) has no seller person and credit the collabBox author (collabbox_credit_order). Dry by default. Returns {candidates, credits by outcome}.';

REVOKE ALL ON FUNCTION public.collabbox_credit_authors(boolean, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.collabbox_credit_authors(boolean, integer) TO service_role;

-- ── 15. The historic price-0 rows (decision 4) — DRY RUN by default ─────────
-- collabBox orders with price 0 that hold a parcel whose COD is 0 (65 on
-- 2026-09-28: 63 paid, 1 returned, 1 shipped; every COD 0). Apply marks them
-- not_counted_reason = 'replacement' (rows, parcels and history untouched),
-- notes the customer's previous priced sale and records the ledger row.
CREATE OR REPLACE FUNCTION public.collabbox_mark_replacements(p_apply boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _set    jsonb;
  _n      integer;
  _marked integer := 0;
BEGIN
  -- The candidate set, computed once and reused by every statement below
  -- (no temp table: the dry run must work in a read-only transaction).
  SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.created_at, c.display_id), '[]'::jsonb)
    INTO _set
    FROM (
      SELECT o.id, o.display_id, o.status::text AS status, o.external_order_id AS doc,
             o.sale_source_detail AS detail, o.created_at,
             coalesce(p.cod_mkd, o.mex_cod_mkd) AS cod_mkd,
             prev.id AS prev_id, prev.display_id AS prev_display_id
        FROM public.orders o
        LEFT JOIN public.mex_parcels p ON p.tracking_id = o.mex_tracking_id
        LEFT JOIN LATERAL (
          SELECT x.id, x.display_id FROM public.orders x
           WHERE x.customer_phone = o.customer_phone AND o.customer_phone <> ''
             AND x.id <> o.id AND x.price > 0 AND x.not_counted_reason IS NULL
             AND x.status IN ('confirmed', 'shipped', 'delivered', 'paid', 'returned')
             AND x.created_at <= o.created_at
           ORDER BY x.created_at DESC LIMIT 1) prev ON true
       WHERE o.external_source = 'collabbox'
         AND coalesce(o.price, 0) = 0
         AND o.mex_tracking_id IS NOT NULL
         AND coalesce(p.cod_mkd, o.mex_cod_mkd, 0) = 0
         AND o.not_counted_reason IS NULL) c;
  _n := jsonb_array_length(_set);

  IF p_apply AND _n > 0 THEN
    PERFORM set_config('elyon.keep_updated_at', 'on', true);
    UPDATE public.orders o SET not_counted_reason = 'replacement'
      FROM jsonb_to_recordset(_set) AS r(id uuid)
     WHERE o.id = r.id AND o.not_counted_reason IS NULL;
    GET DIAGNOSTICS _marked = ROW_COUNT;
    PERFORM set_config('elyon.keep_updated_at', '', true);

    INSERT INTO public.order_notes (order_id, text, author_id, author_name)
    SELECT r.prev_id,
           format('%s (collabBox %s, %s) was a replacement sent at no charge (COD 0) — kept for its parcel, not counted as an order.',
                  r.display_id, r.doc, to_char(r.created_at AT TIME ZONE 'Europe/Skopje', 'DD.MM.YYYY')),
           NULL, 'collabBox'
      FROM jsonb_to_recordset(_set) AS r(prev_id uuid, display_id text, doc text, created_at timestamptz)
     WHERE r.prev_id IS NOT NULL;

    INSERT INTO public.order_notes (order_id, text, author_id, author_name)
    SELECT r.id, 'Replacement (price 0, COD 0): not counted as an order (owner decision 2026-09-28).'
                 || CASE WHEN r.prev_display_id IS NOT NULL THEN ' Previous sale: ' || r.prev_display_id || '.' ELSE '' END,
           NULL, 'collabBox'
      FROM jsonb_to_recordset(_set) AS r(id uuid, prev_display_id text);

    -- The ledger knows them too; the backfill's re-read keeps them 'replacement'.
    INSERT INTO public.collabbox_documents AS d (doc_number, doc_type_id, doc_at, kind, order_id,
           related_order_id, action, first_action, source, amount_mkd, goods_mkd)
    SELECT r.doc, '0', r.created_at, 'replacement', r.id, r.prev_id, 'annotated', 'annotated', 'upload', 0, 0
      FROM jsonb_to_recordset(_set) AS r(id uuid, doc text, created_at timestamptz, prev_id uuid)
     WHERE r.doc IS NOT NULL
    ON CONFLICT (doc_number) DO UPDATE
       SET kind = 'replacement', order_id = EXCLUDED.order_id,
           related_order_id = coalesce(d.related_order_id, EXCLUDED.related_order_id);
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'apply', p_apply, 'candidates', _n, 'marked', _marked,
    'rows', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                      'display_id', r.display_id, 'status', r.status, 'detail', r.detail, 'doc', r.doc,
                      'created', to_char(r.created_at AT TIME ZONE 'Europe/Skopje', 'YYYY-MM-DD'),
                      'cod_mkd', r.cod_mkd, 'previous_sale', r.prev_display_id)), '[]'::jsonb)
               FROM jsonb_to_recordset(_set) AS r(display_id text, status text, detail text, doc text,
                                                  created_at timestamptz, cod_mkd integer, prev_display_id text)));
END;
$fn$;

COMMENT ON FUNCTION public.collabbox_mark_replacements(boolean) IS
  'Owner decision 2026-09-28 #4: list (default) or mark (p_apply) the historic collabBox price-0 orders holding a COD-0 parcel as not_counted_reason = replacement — rows are never deleted; notes the previous priced sale. Service role.';

REVOKE ALL ON FUNCTION public.collabbox_mark_replacements(boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.collabbox_mark_replacements(boolean) TO service_role;

-- ── 16. THE freshness — replaces the 20260939000200 stub, same keys ─────────
--   last_ok_at    the last run that finished 'ok' (a completed nightly
--                 session, a completed backfill range)
--   status        failed — the last finished run failed (a 'running' row
--                 older than 15 minutes counts as failed: the invocation was
--                 killed); stale — no ok run in 26 h; ok; n/a — never run AND
--                 no collabBox order at all
--   data_through  the newest document in the ledger
--   lag_parcels   NATURA teleshop parcels (9100 / 9102), COD > 0, older than
--                 48 h, linked to no order, with NO ledger row and not claimed
--                 by a live web order — documents the sync has not seen
-- Before the first run exists it falls back to the stub's reading (newest
-- collabBox order, stale after 7 days) so the Overview stays meaningful
-- during the rollout. Extra keys (last_run_at, last_error, last_error_at,
-- runs_24h, failed_24h) are for Settings → Integrations health.
CREATE OR REPLACE FUNCTION public.collabbox_feed_state()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
WITH runs AS (
  SELECT r.* FROM public.collabbox_sync_runs r
   WHERE r.kind IN ('daily', 'backfill')
),
last_ok AS (
  SELECT max(r.finished_at) AS t FROM runs r WHERE r.status = 'ok'
),
last_settled AS (
  SELECT r.status, r.error, r.started_at, r.finished_at
    FROM runs r
   WHERE r.status <> 'running' OR r.started_at < now() - interval '15 minutes'
   ORDER BY r.started_at DESC
   LIMIT 1
),
last_fail AS (
  SELECT r.error, coalesce(r.finished_at, r.started_at) AS t
    FROM runs r
   WHERE r.status = 'failed' OR (r.status = 'running' AND r.started_at < now() - interval '15 minutes')
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
docs AS (
  SELECT max(d.doc_at) AS t FROM public.collabbox_documents d WHERE d.deleted_at IS NULL
),
legacy AS (
  SELECT max(o.created_at) AS last_doc FROM public.orders o WHERE o.sale_source = 'collabbox'
),
lag AS (
  SELECT count(*) AS n
    FROM public.mex_parcels p
   WHERE p.account = 'natura'
     AND p.series IN ('9100', '9102')
     AND coalesce(p.cod_mkd, 0) > 0
     AND p.created_at_mex < now() - interval '48 hours'
     AND p.order_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.collabbox_documents d WHERE d.doc_number = p.tracking_id)
     AND NOT EXISTS (SELECT 1 FROM public.web_orders w
                      WHERE w.mex_tracking_id = p.tracking_id AND w.deleted_in_shop_at IS NULL)
)
SELECT CASE
  WHEN a.runs_all = 0 THEN
    jsonb_build_object(
      'feed', 'collabbox',
      'last_ok_at', lg.last_doc,
      'status', CASE WHEN lg.last_doc IS NULL THEN 'n/a'
                     WHEN lg.last_doc < now() - interval '7 days' THEN 'stale'
                     ELSE 'ok' END,
      'detail', 'no sync run yet (manual import); newest document '
                || coalesce(to_char(lg.last_doc AT TIME ZONE 'Europe/Skopje', 'DD.MM.YYYY'), '-')
                || '; ' || lag.n || ' NATURA teleshop parcels without a document',
      'data_through', lg.last_doc,
      'lag_parcels', lag.n,
      'last_run_at', NULL, 'last_error', NULL, 'last_error_at', NULL,
      'runs_24h', 0, 'failed_24h', 0)
  ELSE
    jsonb_build_object(
      'feed', 'collabbox',
      'last_ok_at', lo.t,
      'status', CASE WHEN ls.status = 'failed' OR ls.status = 'running' THEN 'failed'
                     WHEN lo.t IS NULL OR lo.t < now() - interval '26 hours' THEN 'stale'
                     ELSE 'ok' END,
      'detail', 'nightly sync (30-day re-read); last ok '
                || coalesce(to_char(lo.t AT TIME ZONE 'Europe/Skopje', 'DD.MM.YYYY HH24:MI'), 'never')
                || '; documents through '
                || coalesce(to_char(dc.t AT TIME ZONE 'Europe/Skopje', 'DD.MM.YYYY HH24:MI'), '-')
                || '; ' || lag.n || ' NATURA teleshop parcels without a document'
                || CASE WHEN ls.status IN ('failed', 'running')
                        THEN '; last run failed: ' || coalesce(left(ls.error, 200), 'killed (no finish)')
                        ELSE '' END,
      'data_through', dc.t,
      'lag_parcels', lag.n,
      'last_run_at', a.last_run_at,
      'last_error', lf.error,
      'last_error_at', lf.t,
      'runs_24h', a.runs_24h,
      'failed_24h', a.failed_24h)
  END
  FROM agg a
  CROSS JOIN last_ok lo
  CROSS JOIN docs dc
  CROSS JOIN legacy lg
  CROSS JOIN lag
  LEFT JOIN last_settled ls ON true
  LEFT JOIN last_fail lf ON true;
$fn$;

COMMENT ON FUNCTION public.collabbox_feed_state() IS
  'THE collabBox freshness (20260939000350 — replaces the 20260939000200 stub, same keys + last_run_at / last_error / last_error_at / runs_24h / failed_24h): {feed, last_ok_at, status ok|stale|failed|n/a, detail, data_through, lag_parcels}. last_ok_at = last ok sync run; failed if the last finished run failed (a running row > 15 min counts); stale after 26 h without an ok run; lag = unlinked NATURA 9100/9102 COD parcels > 48 h old with no ledger row. Before the first run: the stub''s manual-import reading.';

REVOKE ALL ON FUNCTION public.collabbox_feed_state() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.collabbox_feed_state() TO service_role;
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    GRANT EXECUTE ON FUNCTION public.collabbox_feed_state() TO supabase_read_only_user;
  END IF;
END
$grant$;

-- ── 17. The schedulers ──────────────────────────────────────────────────────
-- Same pg_cron + pg_net + Vault pattern as invoke_mex_reconcile: the shared
-- secret lives in Vault (row collabbox_sync_secret, created by
-- scripts/collabbox-sync-setup.mjs), never in SQL. pg_cron fires in UTC; the
-- Skopje gate below makes both jobs DST-proof:
--   collabbox-customers  21:20 Skopje — komitenti created/changed in the last
--                        3 days (so tonight's new customers have phones)
--   collabbox-sync       every 10 min 21:34–23:44 Skopje — ONE nightly
--                        session re-reads the last 30 days, a day-chunk at a
--                        time (≈ 13 days per 150 s invocation → done by
--                        ~21:55); later slots find it done and return at once.
-- Both hit collabBox strictly sequentially (2,5 s between requests), after
-- the teleshop shift and far from the 02:00 segment recompute.
CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE OR REPLACE FUNCTION public.invoke_collabbox_sync(_mode text DEFAULT 'daily')
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  _secret text;
  _local  time := (now() AT TIME ZONE 'Europe/Skopje')::time;
BEGIN
  IF _mode = 'daily' THEN
    IF NOT (_local >= time '21:30' AND _local < time '23:45') THEN
      RETURN;
    END IF;
  ELSIF _mode = 'customers' THEN
    IF NOT (_local >= time '21:00' AND _local < time '21:30') THEN
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
    body := jsonb_build_object('mode', _mode),
    timeout_milliseconds := 180000
  );
EXCEPTION WHEN OTHERS THEN
  RETURN;  -- the scheduler must never error the cron job
END;
$fn$;

REVOKE ALL ON FUNCTION public.invoke_collabbox_sync(text) FROM PUBLIC, anon, authenticated;

DO $cron$
DECLARE
  _job text;
BEGIN
  FOREACH _job IN ARRAY ARRAY['collabbox-sync', 'collabbox-customers'] LOOP
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = _job) THEN
      PERFORM cron.unschedule(_job);
    END IF;
  END LOOP;
END
$cron$;

-- Minutes no other job uses (:00 :01 :03 :05 :06 :07 :18 :33 :37 :48 are taken;
-- even minutes are shared with the 2-minute jobs either way). 19–22 UTC covers
-- 21:30–23:45 Skopje in summer (UTC+2) and winter (UTC+1).
SELECT cron.schedule(
  'collabbox-sync', '4,14,24,34,44,54 19-22 * * *',
  $job$SELECT public.invoke_collabbox_sync('daily');$job$
);

SELECT cron.schedule(
  'collabbox-customers', '20 19,20 * * *',
  $job$SELECT public.invoke_collabbox_sync('customers');$job$
);

-- PostgREST: new tables, functions and the orders column.
NOTIFY pgrst, 'reload schema';
