-- ============================================================================
-- INSIGHTS FOUNDATION — one sale cohort under every /insights tab (2026-09-28)
--
-- The owner's complaint: no two tabs agree, and the Overview's tiles cannot
-- add up because they count different things on three clocks. The owner
-- rules of 2026-09-28 (law) define ONE money view — a COHORT of sales — and
-- this migration is its single SQL definition. Every tab's own RPC is to read
-- these functions instead of re-deriving "what is a sale".
--
-- Adds, read-side only (no table is written, no trigger, no backfill, no cron):
--   insights_sale_rows(p_from, p_to_end[, p_keys])   one row per SALE
--   insights_leads_rows(p_from, p_to_end)            one row per lead that CAME IN
--   insights_cash_rows(p_from, p_to_end)             one row per MEX parcel
--                                                    DELIVERED (+ the card line)
--   insights_cohort(p_from, p_to_end, p_prev_from, p_prev_to_end, p_sources,
--                   p_money) → jsonb                 the /api/insights/cohort body
--   insights_cohort_order_exceptions() → jsonb       the two tiny id lists the
--                                                    /orders twin needs
--   cohort_* helpers (pure, inlinable)               the bucket / source /
--                                                    channel rules, ONCE
--   mk_geo_norm(text), mk_city_key(text)             city folding
--   product_aliases (table, UNSEEDED), product_alias_norm(), product_key(),
--   order_line_kind()                                product folding
--   two indexes on mex_parcels (created_at_mex, delivered_at)
--
-- Nothing here replaces insights_overview / insights_orders_rollup /
-- insights_paid_basis / insights_products / insights_channel_pl: they feed the
-- Payout tab and the parity harness and stay exactly as they are.
--
-- ── WHAT A SALE IS (owner rules 2026-09-28) ────────────────────────────────
-- FOUR sources, all included:
--   altercpa        orders.sale_source altercpa | affiliate
--                   + MEX-only parcels of series 9110 ("unlinked LEADS")
--   elyon_crm       orders.sale_source elyon_crm (prediction_list | direct;
--                   disposition rows are NEVER sales, orders or money)
--                   + MEX-only parcels of series 9103 ("unlinked LEADS-OUT")
--   web             public.web_orders (the naturatherapy.mk mirror — NOT
--                   orders) + MEX-only NTMK parcels no web order claims
--   teleshop_other  every other orders.sale_source (collabbox, legacy, …)
--                   + MEX-only parcels of series 9100/9102 (teleshop),
--                   9108 (social) and anything else (M…, bare numbers)
-- The series decides the channel, never the account (series cross accounts at
-- the margins — 20260934000100).
--
-- A PARCEL COUNTS ONCE. Ownership, first match wins:
--   1. a live web order claims it (web_orders.mex_tracking_id) → web
--      ("web claims win": 6 old AlterCPA orders hold an NTMK parcel through a
--      mis-link; they lose it and are judged on their CRM status alone)
--   2. a real order holds it (orders.mex_tracking_id; or mex_parcels.order_id)
--      → that order. Disposition rows are not real orders: a parcel only a
--      disposition row holds is MEX-only (17 such rows exist).
--   3. otherwise it is MEX-only.
-- (3 tracking ids are held by TWO orders each; both count it — flagged
--  q_shared_parcel, reported under quality.double_count_candidates.)
--
-- Orders: a row is a sale when it is not disposition and it has a parcel
-- (MEX-first) or its CRM status is confirmed | shipped | paid | returned.
-- Cancels and trash are NEVER sales; a sale that was later cancelled with no
-- parcel is kept OUTSIDE the total as cancelled_after_sale.
--
-- SALE DAY (the cohort clock, Skopje days):
--   orders   coalesce(sold_at, AlterCPA ledger decided_at for approved |
--            cancel_other, confirmed_at, created_at)
--   web      web_orders.created_at
--   MEX-only mex_parcels.created_at_mex
--
-- BUCKETS — MEX status decides whenever a parcel exists, even when the CRM
-- says cancelled (99 AlterCPA orders in Sept were "cancelled" but moving):
--   paid             MEX 2 Delivered                     (Наплатено)
--   paid_unproven    CRM paid, no parcel, not legacy     (red; should be 0)
--   paid_legacy      CRM paid, no parcel, paid_basis operator_ruling |
--                    legacy_import, or a pre-guard import row (paid_basis
--                    NULL, source_type import) — labelled, not an alarm.
--                    Web: an OpenCart (OC-) order delivered/done, no parcel.
--   courier          MEX 1 / 4 / 10 / any other moving status; CRM shipped
--                    with no parcel                      (Кај курирот)
--   courier_problem  MEX 3 / 9 / 13 — 13 Rejected is still AT the courier
--                    until MEX says 7                    (sub-part of courier)
--   label            MEX 8 Shipment created              (Спакувано, чека курир)
--   to_pack          CRM confirmed, no parcel            (Во магацин за пакување)
--   returned         MEX 7, or CRM returned with no parcel (Вратено)
-- The eight sum EXACTLY to the total. OUTSIDE the total:
--   cancelled_after_sale  sold (sold_at set), then cancelled/trashed, no parcel
--   replacement           nothing to collect: parcel COD <= 0 (or, with no
--                         parcel / no COD, price <= 0; web total <= 0)
--
-- VALUE (denari): the parcel's COD when a parcel exists (COD is what MEX
-- collects — never × 61,5 again), else price × 61,5 (the FROZEN peg; price is
-- EUR), web: the shop total. A price-0 order with a COD > 0 parcel is a real
-- sale valued at COD (flag q_no_price). Replacement rows carry value 0 (their
-- COD stays in cod_mkd).
--
-- CASH (insights_cash_rows): every MEX parcel delivered in the window, by
-- delivered_at, each once, owned as above — Σ cod_mkd ties to the MEX
-- register. Card-paid web orders (payment PAID, parcel delivered) add their
-- card money on its own line: card_mkd = shop total − the COD MEX collected.
--
-- LEADS (insights_leads_rows): what CAME INTO our systems in the window, by
-- created_at — orders (disposition rows kept apart: they are worked calls, not
-- leads) and web orders (failed card checkouts dropped, as the shop does).
-- MEX-only parcels never "came in" and are not leads.
--
-- ── /orders twin ────────────────────────────────────────────────────────────
-- GET /orders?cohort_bucket=<key>&sold_from&sold_to lists exactly the ORDER
-- part of a bucket. Its PostgREST predicates (supabase/functions/api/
-- insightsCommon.ts cohortBucketOrFilter / cohortSaleWindowOrFilter) are the
-- twins of cohort_order_bucket() and the sale-day coalesce below, over the
-- orders.mex_* columns; the two things they cannot see (a web claim, a ledger
-- date) come from insights_cohort_order_exceptions(). CHANGE THEM TOGETHER.
-- scripts/verify-insights-ties.mjs replays the TS twin over live rows.
--
-- ── Technique ───────────────────────────────────────────────────────────────
-- The cohort_* helpers are LANGUAGE sql IMMUTABLE with NO `SET search_path`:
-- that is what lets the planner INLINE them (a SET clause forbids inlining,
-- and a non-inlined call costs microseconds × 100k rows). They reference no
-- table and only pg_catalog built-ins, so a mutable search_path cannot change
-- what they compute. The table-reading functions are SECURITY DEFINER with a
-- pinned search_path, service_role EXECUTE only (+ the read-only harness role).
-- plpgsql + EXECUTE … USING on purpose (as insights_overview): each call is
-- planned with its REAL bounds.
-- 61.5 is the FROZEN MKD_PER_EUR peg (src/lib/currency.ts) — used only to
-- express a EUR price in denari, never to re-price anything.
-- ============================================================================

SET LOCAL lock_timeout = '5s';

-- ── 1. Indexes (mex_parcels is ~60k rows; each build is sub-second) ────────
-- MEX-only sales are dated by the parcel's creation; cash by its delivery.
CREATE INDEX IF NOT EXISTS idx_mex_parcels_created_at_mex
  ON public.mex_parcels (created_at_mex);
CREATE INDEX IF NOT EXISTS idx_mex_parcels_delivered_at
  ON public.mex_parcels (delivered_at) WHERE delivered_at IS NOT NULL;

-- ── 2. The rules, once (pure, inlinable) ───────────────────────────────────

-- orders.sale_source → the four cohort sources.
CREATE OR REPLACE FUNCTION public.cohort_order_source(p_sale_source text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $b$
  SELECT CASE
    WHEN p_sale_source IN ('altercpa', 'affiliate') THEN 'altercpa'
    WHEN p_sale_source = 'elyon_crm'                THEN 'elyon_crm'
    WHEN p_sale_source = 'web'                      THEN 'web'
    ELSE 'teleshop_other'
  END
$b$;

-- An order's bucket, MEX-first. NULL = not a sale and not outside the total
-- (a lead, a pre-sale cancel, a disposition row). p_web_claimed: a live web
-- order claims this order's tracking id (web claims win → no parcel here).
-- TWIN: insightsCommon.ts cohortOrderBucket() + cohortBucketOrFilter().
CREATE OR REPLACE FUNCTION public.cohort_order_bucket(
  p_status           text,
  p_price            numeric,
  p_sold_at          timestamptz,
  p_paid_basis       text,
  p_source_type      text,
  p_detail           text,
  p_tracking         text,
  p_mex_status       integer,
  p_mex_cod          integer,
  p_mex_delivered_at timestamptz,
  p_web_claimed      boolean)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $b$
  SELECT CASE
    WHEN p_detail IS NOT DISTINCT FROM 'disposition' THEN NULL
    -- a parcel exists: MEX decides
    WHEN p_tracking IS NOT NULL
         AND (p_mex_status IS NOT NULL OR p_mex_delivered_at IS NOT NULL)
         AND p_web_claimed IS NOT TRUE THEN
      CASE
        WHEN p_mex_cod IS NOT NULL AND p_mex_cod <= 0                       THEN 'replacement'
        WHEN p_mex_cod IS NULL AND coalesce(p_price, 0) <= 0                THEN 'replacement'
        WHEN p_mex_status = 2
          OR (p_mex_status IS NULL AND p_mex_delivered_at IS NOT NULL)      THEN 'paid'
        WHEN p_mex_status = 7                                               THEN 'returned'
        WHEN p_mex_status IN (3, 9, 13)                                     THEN 'courier_problem'
        WHEN p_mex_status = 8                                               THEN 'label'
        ELSE 'courier'
      END
    -- no parcel: the CRM status
    WHEN p_status IN ('paid', 'returned', 'shipped', 'confirmed')
         AND coalesce(p_price, 0) <= 0                                      THEN 'replacement'
    WHEN p_status = 'paid' THEN
      CASE WHEN p_paid_basis IN ('operator_ruling', 'legacy_import')
             OR (p_paid_basis IS NULL AND p_source_type = 'import')         THEN 'paid_legacy'
           ELSE 'paid_unproven' END
    WHEN p_status = 'returned'                                              THEN 'returned'
    WHEN p_status = 'shipped'                                               THEN 'courier'
    WHEN p_status = 'confirmed'                                             THEN 'to_pack'
    WHEN p_status IN ('cancelled', 'trashed') AND p_sold_at IS NOT NULL
         AND coalesce(p_price, 0) > 0                                       THEN 'cancelled_after_sale'
  END
$b$;

-- A web order's bucket: its parcel's MEX status when it has one, else the
-- shop's own outcome (web_order_outcome). Awaiting / cancelled / failed card
-- checkouts with no parcel are not sales (NULL).
CREATE OR REPLACE FUNCTION public.cohort_web_bucket(
  p_outcome       text,
  p_is_legacy     boolean,
  p_total         numeric,
  p_parcel_status integer,
  p_has_parcel    boolean)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $b$
  SELECT CASE
    WHEN p_has_parcel IS TRUE AND p_parcel_status IS NOT NULL THEN
      CASE
        WHEN coalesce(p_total, 0) <= 0      THEN 'replacement'
        WHEN p_parcel_status = 2            THEN 'paid'
        WHEN p_parcel_status = 7            THEN 'returned'
        WHEN p_parcel_status IN (3, 9, 13)  THEN 'courier_problem'
        WHEN p_parcel_status = 8            THEN 'label'
        ELSE 'courier'
      END
    WHEN p_outcome IN ('delivered', 'no_record', 'returned', 'courier', 'preparing')
         AND coalesce(p_total, 0) <= 0      THEN 'replacement'
    WHEN p_outcome IN ('delivered', 'no_record') THEN
      CASE WHEN p_is_legacy IS TRUE THEN 'paid_legacy' ELSE 'paid_unproven' END
    WHEN p_outcome = 'returned'             THEN 'returned'
    WHEN p_outcome = 'courier'              THEN 'courier'
    WHEN p_outcome = 'preparing'            THEN 'to_pack'
  END
$b$;

-- A MEX-only parcel's bucket. COD <= 0 is a replacement, never a sale.
CREATE OR REPLACE FUNCTION public.cohort_parcel_bucket(p_status_id integer, p_cod integer)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $b$
  SELECT CASE
    WHEN coalesce(p_cod, 0) <= 0     THEN 'replacement'
    WHEN p_status_id = 2             THEN 'paid'
    WHEN p_status_id = 7             THEN 'returned'
    WHEN p_status_id IN (3, 9, 13)   THEN 'courier_problem'
    WHEN p_status_id = 8             THEN 'label'
    ELSE 'courier'
  END
$b$;

-- A MEX-only parcel's channel (the series names the sales channel).
CREATE OR REPLACE FUNCTION public.cohort_parcel_split(p_series text, p_tracking text, p_sender_ref text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $b$
  SELECT CASE
    WHEN p_series = '9110'                         THEN 'mex_leads'
    WHEN p_series = '9103'                         THEN 'mex_leads_out'
    WHEN p_series IN ('9100', '9102')              THEN 'mex_teleshop'
    WHEN p_series = '9108'                         THEN 'mex_social'
    WHEN p_series IS NULL
         AND (coalesce(p_tracking, '') ~ '^NTMK' OR coalesce(p_sender_ref, '') ~ '^NTMK') THEN 'mex_web'
    ELSE 'mex_other'
  END
$b$;

CREATE OR REPLACE FUNCTION public.cohort_split_source(p_split text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $b$
  SELECT CASE p_split
    WHEN 'mex_leads'     THEN 'altercpa'
    WHEN 'mex_leads_out' THEN 'elyon_crm'
    WHEN 'mex_web'       THEN 'web'
    ELSE 'teleshop_other'
  END
$b$;

-- The eight buckets that make up the total.
CREATE OR REPLACE FUNCTION public.cohort_in_total(p_bucket text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $b$
  SELECT coalesce(p_bucket IN ('paid', 'paid_unproven', 'paid_legacy', 'courier',
                               'courier_problem', 'label', 'to_pack', 'returned'), false)
$b$;

-- SQL twin of normalizeMkGeo (scripts/lib/mk-translit.mjs, src/lib/
-- transliterate.ts): lowercase → Cyrillic to Latin (щ → st) → strip
-- diacritics → ç đ ł ø → Latin digraphs (longest first) → keep a-z0-9.
-- Штип · Stip · Štip → "stip"; Ѓорче Петров · Gjorce Petrov → "gorcepetrov".
-- The key mk_settlements.name_norm was built with.
CREATE OR REPLACE FUNCTION public.mk_geo_norm(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $b$
  SELECT regexp_replace(
    replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(
      translate(
        regexp_replace(
          normalize(
            translate(replace(lower(coalesce(p, '')), 'щ', 'st'),
                      'абвгдѓежзѕијклљмнњопрстќуфхцчџшйъьюяыэёђћѐѝ',
                      'abvgdgezzdijkllmnnoprstkufhccdsjajuaieedcei'),
            NFD),
          '[̀-ͯ]', '', 'g'),
        'çđłø', 'cdlo'),
      'dzh', 'd'), 'zh', 'z'), 'sh', 's'), 'ch', 'c'), 'dz', 'd'),
      'dj', 'd'), 'gj', 'g'), 'kj', 'k'), 'lj', 'l'), 'nj', 'n'), 'ts', 'c'),
    '[^a-z0-9]', '', 'g')
$b$;

COMMENT ON FUNCTION public.mk_geo_norm(text) IS
  'SQL twin of normalizeMkGeo (scripts/lib/mk-translit.mjs + src/lib/transliterate.ts): the lossy Macedonian place-name key mk_settlements.name_norm is built with. Change all three together.';

-- ── 3. City folding ─────────────────────────────────────────────────────────
-- A raw city (Latin, Cyrillic, MEX's "Skopje - Aerodrom") → one key: the
-- mk_settlements.name_norm of the place it names, a Skopje/Tetovo district
-- folded into its city; the MEX "City - District" form falls back to the part
-- before the dash; an unknown place keeps its own normalised key (so Latin
-- and Cyrillic spellings of it still fold). NULL for empty input.
-- Callers pass the MEX receiver_city when the sale has a parcel (the courier's
-- address), else the order's customer_city.
CREATE OR REPLACE FUNCTION public.mk_city_key(p_raw text)
RETURNS text
LANGUAGE sql
STABLE
PARALLEL SAFE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $b$
  WITH k AS (
    SELECT public.mk_geo_norm(p_raw) AS full_key,
           CASE WHEN p_raw ~ '-' THEN public.mk_geo_norm(split_part(p_raw, '-', 1)) END AS head_key
  )
  SELECT coalesce(
    (SELECT coalesce(par.name_norm, s.name_norm)
       FROM public.mk_settlements s
       LEFT JOIN public.mk_settlements par ON par.id = s.parent_id AND s.kind = 'city_district'
      WHERE s.name_norm = k.full_key
      ORDER BY CASE s.kind WHEN 'city' THEN 1 WHEN 'town' THEN 2 WHEN 'city_district' THEN 3 ELSE 4 END, s.id
      LIMIT 1),
    (SELECT coalesce(par.name_norm, s.name_norm)
       FROM public.mk_settlements s
       LEFT JOIN public.mk_settlements par ON par.id = s.parent_id AND s.kind = 'city_district'
      WHERE k.head_key IS NOT NULL AND k.head_key <> '' AND s.name_norm = k.head_key
      ORDER BY CASE s.kind WHEN 'city' THEN 1 WHEN 'town' THEN 2 WHEN 'city_district' THEN 3 ELSE 4 END, s.id
      LIMIT 1),
    nullif(k.full_key, ''))
  FROM k
$b$;

COMMENT ON FUNCTION public.mk_city_key(text) IS
  'One key per Macedonian place: mk_geo_norm(raw) → mk_settlements.name_norm (districts folded into their city; "City - District" falls back to City); unknown places keep their normalised key. Prefer mex_parcels.receiver_city when the sale has a parcel.';

-- ── 4. Product folding — the alias table ships EMPTY ────────────────────────
-- Seeding waits for the owner's review (critic 2026-09-28): until then every
-- line is "product" and keys by its own normalised name ('n:…'), so nothing
-- is folded that a person has not approved.
CREATE TABLE IF NOT EXISTS public.product_aliases (
  source      text NOT NULL
              CONSTRAINT product_aliases_source_check
              CHECK (source IN ('crm', 'collabbox', 'web', 'altercpa', 'mex', 'any')),
  alias_norm  text NOT NULL
              CONSTRAINT product_aliases_alias_norm_check CHECK (alias_norm <> ''),
  product_id  uuid REFERENCES public.products(id) ON DELETE SET NULL,
  kind        text NOT NULL DEFAULT 'product'
              CONSTRAINT product_aliases_kind_check
              CHECK (kind IN ('product', 'gift', 'loyalty_point', 'delivery', 'note', 'flyer')),
  note        text,
  reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, alias_norm)
);

COMMENT ON TABLE public.product_aliases IS
  'Product-name folding for insights: (source, product_alias_norm(name)) → catalogue product and line kind (product | gift | loyalty_point | delivery | note | flyer). Shipped UNSEEDED; rows are added only after owner review (reviewed_by / reviewed_at). Source ''any'' is the fallback for every source. Written by the service role only.';

ALTER TABLE public.product_aliases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS product_aliases_select_owners ON public.product_aliases;
CREATE POLICY product_aliases_select_owners ON public.product_aliases
  FOR SELECT TO authenticated USING ((SELECT public.is_business_owner(auth.uid())));
REVOKE ALL ON public.product_aliases FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.product_aliases TO authenticated;
GRANT ALL ON public.product_aliases TO service_role;

-- The alias key: lowercase, trimmed, inner whitespace collapsed. Deliberately
-- NOT lossy (package sizes like "2+1" must stay apart); spelling variants are
-- folded by alias rows, which a person reviews.
CREATE OR REPLACE FUNCTION public.product_alias_norm(p_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $b$
  SELECT nullif(lower(regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g')), '')
$b$;

-- 'p:<product uuid>' when the line names a catalogue product (its own
-- product_id, else a reviewed alias), else 'n:<normalised name>'. NULL when
-- there is neither.
CREATE OR REPLACE FUNCTION public.product_key(p_source text, p_name text, p_product_id uuid DEFAULT NULL)
RETURNS text
LANGUAGE sql
STABLE
PARALLEL SAFE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $b$
  SELECT CASE
    WHEN p_product_id IS NOT NULL THEN 'p:' || p_product_id::text
    ELSE coalesce(
      (SELECT 'p:' || a.product_id::text
         FROM public.product_aliases a
        WHERE a.source IN (p_source, 'any')
          AND a.alias_norm = public.product_alias_norm(p_name)
          AND a.product_id IS NOT NULL
        ORDER BY (a.source = p_source) DESC
        LIMIT 1),
      'n:' || public.product_alias_norm(p_name))
  END
$b$;

-- product | gift | loyalty_point | delivery | note | flyer — 'product' until
-- a reviewed alias says otherwise.
CREATE OR REPLACE FUNCTION public.order_line_kind(p_source text, p_name text)
RETURNS text
LANGUAGE sql
STABLE
PARALLEL SAFE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $b$
  SELECT coalesce(
    (SELECT a.kind
       FROM public.product_aliases a
      WHERE a.source IN (p_source, 'any')
        AND a.alias_norm = public.product_alias_norm(p_name)
      ORDER BY (a.source = p_source) DESC
      LIMIT 1),
    'product')
$b$;

-- ── 5. insights_sale_rows — one row per sale ───────────────────────────────
-- Columns:
--   kind            order | web | mex (MEX-only parcel)
--   source          altercpa | elyon_crm | web | teleshop_other
--   split           orders: sale_source_detail ('none' when NULL); web: shop |
--                   opencart; MEX-only: mex_leads | mex_leads_out |
--                   mex_teleshop | mex_social | mex_web | mex_other
--   sale_source     orders.sale_source (NULL for web / MEX-only)
--   sale_at/_day    the cohort clock (header) / its Skopje day
--   bucket          see the header; in_total = one of the eight
--   proven          MEX Delivered (bucket paid)
--   value_eur       orders.price, the catalogue EUR (NULL for web / MEX-only)
--   value_mkd       the cohort value (COD | price × 61,5 | shop total; 0 for
--                   a replacement)
--   cod_mkd         the owned parcel's COD (NULL without a parcel)
--   cash_at         MEX delivered_at for bucket paid
--   card_mkd        card money of a card-paid, delivered web order
--   person_id       orders.sold_by_person_id
--   list_id/_name   orders.prediction_list_*
--   city_key        mk_city_key(receiver_city if a parcel, else the order's
--                   city) — only when p_keys (default true)
--   product_key     product_key(orders' / the web order's main line) — p_keys
--   crm_status      orders.status / web_orders.status
--   mex_*           the owned parcel's status, account, series
--   q_*             quality flags: cancelled_but_moving (CRM cancelled/trashed,
--                   MEX moving) · no_seller (order sale, no person) · zero_cod
--                   (a parcel with COD <= 0) · no_price (price <= 0, valued at
--                   COD) · shared_parcel (two orders hold the tracking id) ·
--                   double_count (MEX-only parcel on the phone of a CRM sale
--                   that has no parcel, sale ±21 days — never auto-merged)
--   order_id · display_id (order display id / web order number / tracking
--   id) · web_id · tracking_id · phone8
-- Replacement and cancelled_after_sale rows ARE returned (in_total false).
CREATE OR REPLACE FUNCTION public.insights_sale_rows(
  p_from   timestamptz,
  p_to_end timestamptz,
  p_keys   boolean DEFAULT true)
RETURNS TABLE (
  kind                   text,
  source                 text,
  split                  text,
  sale_source            text,
  sale_at                timestamptz,
  sale_day               date,
  bucket                 text,
  in_total               boolean,
  proven                 boolean,
  value_eur              numeric,
  value_mkd              numeric,
  cod_mkd                numeric,
  cash_at                timestamptz,
  card_mkd               numeric,
  person_id              uuid,
  list_id                uuid,
  list_name              text,
  city_key               text,
  product_key            text,
  crm_status             text,
  mex_status_id          integer,
  mex_account            text,
  mex_series             text,
  q_cancelled_but_moving boolean,
  q_no_seller            boolean,
  q_zero_cod             boolean,
  q_no_price             boolean,
  q_shared_parcel        boolean,
  q_double_count         boolean,
  order_id               uuid,
  display_id             text,
  web_id                 integer,
  tracking_id            text,
  phone8                 text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET TimeZone = 'UTC'
SET work_mem = '64MB'
AS $fn$
DECLARE
  -- ONE definition of the rows ($1 from · $2 to_end · $3 compute the keys);
  -- only the last step differs: with the keys it joins the city / product
  -- keys (computed once per distinct value), without them it streams `u`
  -- straight out (no second pass, no materialisation of 100k wide rows).
  v_rows text := $sr$
WITH
wc AS MATERIALIZED (       -- parcels a live web order claims (web claims win)
  SELECT DISTINCT w.mex_tracking_id AS tr
  FROM public.web_orders w
  WHERE w.mex_tracking_id IS NOT NULL AND w.deleted_in_shop_at IS NULL
),
led AS MATERIALIZED (      -- AlterCPA approvals on orders that carry no sold_at
  SELECT l.order_id, max(l.decided_at) AS decided_at
  FROM public.altercpa_leads l
  JOIN public.orders x ON x.id = l.order_id AND x.sold_at IS NULL
  WHERE l.order_id IS NOT NULL
    AND l.decision IN ('approved', 'cancel_other')
    AND l.decided_at IS NOT NULL
  GROUP BY l.order_id
),
shr AS MATERIALIZED (      -- tracking ids two real orders hold
  SELECT x.mex_tracking_id AS tr
  FROM public.orders x
  WHERE x.mex_tracking_id IS NOT NULL
    AND x.sale_source_detail IS DISTINCT FROM 'disposition'
  GROUP BY x.mex_tracking_id
  HAVING count(*) > 1
),
ob AS (
  SELECT x.id, x.display_id, x.status::text AS status, x.price, x.sale_source, x.sale_source_detail,
         x.sold_by_person_id, x.prediction_list_id, x.prediction_list_name,
         x.customer_city, x.product_id, x.product_name,
         regexp_replace(coalesce(x.customer_phone, ''), '[^0-9]', '', 'g') AS phone_digits,
         x.mex_tracking_id, x.mex_status_id, x.mex_cod_mkd, x.mex_delivered_at, x.mex_account,
         z.sale_at, z.web_claimed,
         (x.mex_tracking_id IS NOT NULL
          AND (x.mex_status_id IS NOT NULL OR x.mex_delivered_at IS NOT NULL)
          AND NOT z.web_claimed) AS hp,
         public.cohort_order_bucket(x.status::text, x.price, x.sold_at, x.paid_basis, x.source_type,
                                    x.sale_source_detail, x.mex_tracking_id, x.mex_status_id,
                                    x.mex_cod_mkd, x.mex_delivered_at, z.web_claimed) AS bucket
  FROM public.orders x
  CROSS JOIN LATERAL (
    -- the ledger is read only for an order that has no sold_at (coalesce
    -- short-circuits; `led` holds a handful of rows); the web claim is a
    -- hashed probe into `wc`
    SELECT coalesce(x.sold_at, (SELECT led.decided_at FROM led WHERE led.order_id = x.id),
                    x.confirmed_at, x.created_at) AS sale_at,
           coalesce(x.mex_tracking_id IN (SELECT wc.tr FROM wc), false) AS web_claimed
  ) z
  WHERE z.sale_at BETWEEN $1 AND $2
    AND x.sale_source_detail IS DISTINCT FROM 'disposition'
),
o AS (
  SELECT 'order'::text AS kind,
         public.cohort_order_source(ob.sale_source) AS source,
         coalesce(ob.sale_source_detail, 'none') AS split,
         ob.sale_source,
         ob.sale_at,
         ob.bucket,
         (ob.bucket = 'paid') AS proven,
         ob.price AS value_eur,
         CASE WHEN ob.bucket = 'replacement' THEN 0::numeric
              WHEN ob.hp AND ob.mex_cod_mkd IS NOT NULL THEN ob.mex_cod_mkd::numeric
              ELSE round(coalesce(ob.price, 0) * 61.5) END AS value_mkd,
         CASE WHEN ob.hp THEN ob.mex_cod_mkd::numeric END AS cod_mkd,
         -- orders.mex_delivered_at is the parcel's copy; read the register only
         -- when the copy is missing (a handful of drifted links)
         CASE WHEN ob.bucket = 'paid' THEN
           coalesce(ob.mex_delivered_at,
                    (SELECT p.delivered_at FROM public.mex_parcels p WHERE p.tracking_id = ob.mex_tracking_id)) END AS cash_at,
         NULL::numeric AS card_mkd,
         ob.sold_by_person_id AS person_id,
         ob.prediction_list_id AS list_id,
         ob.prediction_list_name AS list_name,
         -- the courier's address when there is a parcel (only read when the
         -- keys are asked for)
         coalesce(CASE WHEN $3 AND ob.hp THEN
                    (SELECT nullif(btrim(p.receiver_city), '') FROM public.mex_parcels p
                      WHERE p.tracking_id = ob.mex_tracking_id) END,
                  nullif(btrim(ob.customer_city), '')) AS city_raw,
         CASE WHEN ob.sale_source = 'collabbox' THEN 'collabbox' ELSE 'crm' END AS product_src,
         ob.product_name AS product_raw,
         ob.product_id AS product_uuid,
         ob.status AS crm_status,
         CASE WHEN ob.hp THEN ob.mex_status_id END AS mex_status_id,
         CASE WHEN ob.hp THEN ob.mex_account END AS mex_account,
         -- mex_parcels.series, the same generated expression
         CASE WHEN ob.hp AND ob.mex_tracking_id ~ '^[0-9]{3}-[0-9]{4}-'
              THEN split_part(ob.mex_tracking_id, '-', 2) END AS mex_series,
         (ob.status IN ('cancelled', 'trashed') AND ob.bucket IN ('courier', 'courier_problem', 'label')) AS q_cancelled_but_moving,
         (ob.sold_by_person_id IS NULL AND public.cohort_in_total(ob.bucket)) AS q_no_seller,
         (ob.bucket = 'replacement' AND ob.hp) AS q_zero_cod,
         (coalesce(ob.price, 0) <= 0 AND public.cohort_in_total(ob.bucket)) AS q_no_price,
         (ob.hp AND ob.mex_tracking_id IN (SELECT shr.tr FROM shr)) AS q_shared_parcel,
         false AS q_double_count,
         ob.id AS order_id,
         ob.display_id,
         NULL::integer AS web_id,
         CASE WHEN ob.hp THEN ob.mex_tracking_id END AS tracking_id,
         CASE WHEN length(ob.phone_digits) >= 8 THEN right(ob.phone_digits, 8) END AS phone8
  FROM ob
  WHERE ob.bucket IS NOT NULL
),
-- The shop's classifier once per distinct (status, payment) — it carries a
-- SET clause, so it is never inlined and a per-row call costs ~10 µs.
wos AS MATERIALIZED (
  SELECT d.status, d.payment_status, d.payment_method,
         public.web_order_outcome(d.status, d.payment_status, d.payment_method) AS outcome
  FROM (SELECT DISTINCT w.status, w.payment_status, w.payment_method
          FROM public.web_orders w
         WHERE w.deleted_in_shop_at IS NULL
           AND w.created_at BETWEEN $1 AND $2) d
),
wo AS MATERIALIZED (
  SELECT w.shop_order_id, w.order_number, w.status, w.payment_method, w.payment_status, w.total,
         w.city, w.phone8, w.is_legacy, w.created_at,
         wos.outcome,
         p.tracking_id AS p_tr, p.status_id AS p_st, p.cod_mkd AS p_cod, p.delivered_at AS p_deliv,
         p.receiver_city AS p_city, p.account AS p_account, p.series AS p_series
  FROM public.web_orders w
  JOIN wos ON wos.status = w.status AND wos.payment_status = w.payment_status
          AND wos.payment_method = w.payment_method
  LEFT JOIN public.mex_parcels p ON p.tracking_id = w.mex_tracking_id
  WHERE w.deleted_in_shop_at IS NULL
    AND w.created_at BETWEEN $1 AND $2
),
wb AS (
  SELECT wo.*, public.cohort_web_bucket(wo.outcome, wo.is_legacy, wo.total, wo.p_st, wo.p_tr IS NOT NULL) AS bucket
  FROM wo
),
wr AS (
  SELECT 'web'::text AS kind,
         'web'::text AS source,
         CASE WHEN wb.is_legacy THEN 'opencart' ELSE 'shop' END AS split,
         NULL::text AS sale_source,
         wb.created_at AS sale_at,
         wb.bucket,
         (wb.bucket = 'paid') AS proven,
         NULL::numeric AS value_eur,
         CASE WHEN wb.bucket = 'replacement' THEN 0::numeric ELSE wb.total END AS value_mkd,
         CASE WHEN wb.p_tr IS NOT NULL THEN wb.p_cod::numeric END AS cod_mkd,
         CASE WHEN wb.bucket = 'paid' THEN wb.p_deliv END AS cash_at,
         CASE WHEN wb.bucket = 'paid' AND wb.payment_method = 'CARD'
                   AND wb.payment_status IN ('PAID', 'PARTIALLY_REFUNDED')
              THEN greatest(wb.total - coalesce(wb.p_cod, 0), 0) END AS card_mkd,
         NULL::uuid AS person_id,
         NULL::uuid AS list_id,
         NULL::text AS list_name,
         coalesce(nullif(btrim(wb.p_city), ''), nullif(btrim(wb.city), '')) AS city_raw,
         'web'::text AS product_src,
         CASE WHEN $3 THEN
           (SELECT i.name FROM public.web_order_items i
             WHERE i.shop_order_id = wb.shop_order_id AND i.kind = 'SALE'
             ORDER BY i.price * i.quantity DESC, i.shop_item_id
             LIMIT 1) END AS product_raw,
         NULL::uuid AS product_uuid,
         wb.status AS crm_status,
         wb.p_st AS mex_status_id,
         wb.p_account AS mex_account,
         wb.p_series AS mex_series,
         false AS q_cancelled_but_moving,
         false AS q_no_seller,
         (wb.bucket = 'replacement' AND wb.p_tr IS NOT NULL) AS q_zero_cod,
         false AS q_no_price,
         false AS q_shared_parcel,
         false AS q_double_count,
         NULL::uuid AS order_id,
         wb.order_number AS display_id,
         wb.shop_order_id AS web_id,
         wb.p_tr AS tracking_id,
         wb.phone8
  FROM wb
  WHERE wb.bucket IS NOT NULL
),
mo AS MATERIALIZED (       -- MEX-only: no live web order, no real order holds it
  SELECT p.tracking_id, p.account, p.series, p.status_id, p.cod_mkd, p.created_at_mex,
         p.delivered_at, p.receiver_city, p.phone8,
         public.cohort_parcel_split(p.series, p.tracking_id, p.sender_reference) AS split
  FROM public.mex_parcels p
  WHERE p.created_at_mex BETWEEN $1 AND $2
    AND NOT EXISTS (SELECT 1 FROM wc WHERE wc.tr = p.tracking_id)
    AND NOT EXISTS (SELECT 1 FROM public.orders x
                     WHERE x.mex_tracking_id = p.tracking_id
                       AND x.sale_source_detail IS DISTINCT FROM 'disposition')
    AND (p.order_id IS NULL
         OR NOT EXISTS (SELECT 1 FROM public.orders x
                         WHERE x.id = p.order_id
                           AND x.sale_source_detail IS DISTINCT FROM 'disposition'))
),
-- CRM sales with no parcel, by phone: a MEX-only parcel on one of these phones
-- within ±21 days may be the same sale (quality item; never auto-merged).
-- The phone expression is character-for-character idx_orders_phone_last8's.
cs AS MATERIALIZED (
  SELECT right(regexp_replace(x.customer_phone, '[^0-9]', '', 'g'), 8) AS p8,
         coalesce(x.sold_at, x.confirmed_at, x.created_at) AS at
  FROM public.orders x
  WHERE x.mex_tracking_id IS NULL
    AND x.status IN ('confirmed', 'shipped', 'paid', 'returned')
    AND coalesce(x.price, 0) > 0
    AND x.sale_source_detail IS DISTINCT FROM 'disposition'
    AND x.customer_phone IS NOT NULL
    AND coalesce(x.sold_at, x.confirmed_at, x.created_at)
        BETWEEN $1 - interval '21 days' AND $2 + interval '21 days'
),
dbl AS MATERIALIZED (
  SELECT DISTINCT mo.tracking_id
  FROM mo
  JOIN cs ON cs.p8 = mo.phone8
         AND cs.at BETWEEN mo.created_at_mex - interval '21 days' AND mo.created_at_mex + interval '21 days'
  WHERE coalesce(mo.cod_mkd, 0) > 0
),
mr AS (
  SELECT 'mex'::text AS kind,
         public.cohort_split_source(mo.split) AS source,
         mo.split,
         NULL::text AS sale_source,
         mo.created_at_mex AS sale_at,
         public.cohort_parcel_bucket(mo.status_id, mo.cod_mkd) AS bucket,
         (mo.status_id = 2 AND coalesce(mo.cod_mkd, 0) > 0) AS proven,
         NULL::numeric AS value_eur,
         CASE WHEN coalesce(mo.cod_mkd, 0) > 0 THEN mo.cod_mkd::numeric ELSE 0::numeric END AS value_mkd,
         mo.cod_mkd::numeric AS cod_mkd,
         CASE WHEN mo.status_id = 2 AND coalesce(mo.cod_mkd, 0) > 0 THEN mo.delivered_at END AS cash_at,
         NULL::numeric AS card_mkd,
         NULL::uuid AS person_id,
         NULL::uuid AS list_id,
         NULL::text AS list_name,
         nullif(btrim(mo.receiver_city), '') AS city_raw,
         'mex'::text AS product_src,
         NULL::text AS product_raw,
         NULL::uuid AS product_uuid,
         NULL::text AS crm_status,
         mo.status_id AS mex_status_id,
         mo.account AS mex_account,
         mo.series AS mex_series,
         false AS q_cancelled_but_moving,
         false AS q_no_seller,
         (coalesce(mo.cod_mkd, 0) <= 0) AS q_zero_cod,
         false AS q_no_price,
         false AS q_shared_parcel,
         (mo.tracking_id IN (SELECT dbl.tracking_id FROM dbl)) AS q_double_count,
         NULL::uuid AS order_id,
         mo.tracking_id AS display_id,
         NULL::integer AS web_id,
         mo.tracking_id,
         mo.phone8
  FROM mo
),
u AS (
  SELECT * FROM o
  UNION ALL SELECT * FROM wr
  UNION ALL SELECT * FROM mr
)
$sr$;
  v_keys text := $srk$,
ck AS (                    -- city keys, once per distinct raw city
  SELECT d.raw, public.mk_city_key(d.raw) AS k
  FROM (SELECT DISTINCT u.city_raw AS raw FROM u WHERE $3 AND u.city_raw IS NOT NULL) d
),
pk AS (                    -- product keys, once per distinct line
  SELECT d.src, d.raw_k, d.pid_k, public.product_key(d.src, d.raw, d.pid) AS k
  FROM (SELECT DISTINCT u.product_src AS src, u.product_raw AS raw, u.product_uuid AS pid,
               coalesce(u.product_raw, '') AS raw_k, coalesce(u.product_uuid::text, '') AS pid_k
        FROM u WHERE $3 AND (u.product_raw IS NOT NULL OR u.product_uuid IS NOT NULL)) d
)
SELECT u.kind, u.source, u.split, u.sale_source, u.sale_at,
       (u.sale_at AT TIME ZONE 'Europe/Skopje')::date AS sale_day,
       u.bucket, public.cohort_in_total(u.bucket) AS in_total, u.proven,
       u.value_eur, u.value_mkd, u.cod_mkd, u.cash_at, u.card_mkd,
       u.person_id, u.list_id, u.list_name, ck.k AS city_key, pk.k AS product_key,
       u.crm_status, u.mex_status_id, u.mex_account, u.mex_series,
       u.q_cancelled_but_moving, u.q_no_seller, u.q_zero_cod, u.q_no_price, u.q_shared_parcel, u.q_double_count,
       u.order_id, u.display_id, u.web_id, u.tracking_id, u.phone8
FROM u
LEFT JOIN ck ON ck.raw = u.city_raw
LEFT JOIN pk ON pk.src = u.product_src
            AND pk.raw_k = coalesce(u.product_raw, '')
            AND pk.pid_k = coalesce(u.product_uuid::text, '')
$srk$;
  v_plain text := $srn$
SELECT u.kind, u.source, u.split, u.sale_source, u.sale_at,
       (u.sale_at AT TIME ZONE 'Europe/Skopje')::date AS sale_day,
       u.bucket, public.cohort_in_total(u.bucket) AS in_total, u.proven,
       u.value_eur, u.value_mkd, u.cod_mkd, u.cash_at, u.card_mkd,
       u.person_id, u.list_id, u.list_name, NULL::text AS city_key, NULL::text AS product_key,
       u.crm_status, u.mex_status_id, u.mex_account, u.mex_series,
       u.q_cancelled_but_moving, u.q_no_seller, u.q_zero_cod, u.q_no_price, u.q_shared_parcel, u.q_double_count,
       u.order_id, u.display_id, u.web_id, u.tracking_id, u.phone8
FROM u
$srn$;
BEGIN
  IF p_from IS NULL OR p_to_end IS NULL THEN
    RAISE EXCEPTION 'insights_sale_rows: p_from and p_to_end are required' USING ERRCODE = '22023';
  END IF;
  IF p_to_end < p_from OR p_to_end - p_from > interval '800 days' THEN
    RAISE EXCEPTION 'insights_sale_rows: bad window' USING ERRCODE = '22023';
  END IF;

  IF coalesce(p_keys, true) THEN
    RETURN QUERY EXECUTE v_rows || v_keys USING p_from, p_to_end, true;
  ELSE
    RETURN QUERY EXECUTE v_rows || v_plain USING p_from, p_to_end, false;
  END IF;
END;
$fn$;

COMMENT ON FUNCTION public.insights_sale_rows(timestamptz, timestamptz, boolean) IS
  'THE sale cohort (owner rules 2026-09-28): one row per sale across orders, web_orders and MEX-only parcels, sale day in the window, MEX-first bucket, value (COD | price×61.5 | shop total), cash, card, person, list, city/product keys, quality flags. Replacement and cancelled_after_sale rows are returned with in_total = false. Definitions: migration 20260940000000.';

-- ── 6. insights_leads_rows — what came in ──────────────────────────────────
-- One row per lead that CAME IN during the window (created_at): every order
-- (disposition rows returned with state 'disposition' — they are worked calls,
-- not leads) and every web order except failed card checkouts. state:
--   sale        it is a sale NOW (in_total bucket, any sale day)
--   cancelled   CRM cancelled / web cancelled (incl. cancelled after a sale)
--   trashed     CRM trashed
--   open        still being worked (pending | take | call_again | duplicated;
--               web awaiting)
--   other       anything else — a free replacement, a sale re-opened
--   disposition an ElyonCRM "no" call row
-- MEX-only parcels never came in and are not here.
CREATE OR REPLACE FUNCTION public.insights_leads_rows(p_from timestamptz, p_to_end timestamptz)
RETURNS TABLE (
  kind       text,
  source     text,
  split      text,
  came_at    timestamptz,
  state      text,
  bucket     text,
  order_id   uuid,
  display_id text,
  web_id     integer,
  person_id  uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET TimeZone = 'UTC'
SET work_mem = '64MB'
AS $fn$
BEGIN
  IF p_from IS NULL OR p_to_end IS NULL OR p_to_end < p_from OR p_to_end - p_from > interval '800 days' THEN
    RAISE EXCEPTION 'insights_leads_rows: bad window' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY EXECUTE $lr$
WITH
wc AS MATERIALIZED (
  SELECT DISTINCT w.mex_tracking_id AS tr
  FROM public.web_orders w
  WHERE w.mex_tracking_id IS NOT NULL AND w.deleted_in_shop_at IS NULL
),
ol AS (
  SELECT x.id, x.display_id, x.status::text AS status, x.sale_source, x.sale_source_detail,
         x.created_at, x.sold_by_person_id,
         public.cohort_order_bucket(x.status::text, x.price, x.sold_at, x.paid_basis, x.source_type,
                                    x.sale_source_detail, x.mex_tracking_id, x.mex_status_id,
                                    x.mex_cod_mkd, x.mex_delivered_at,
                                    coalesce(x.mex_tracking_id IN (SELECT wc.tr FROM wc), false)) AS bucket
  FROM public.orders x
  WHERE x.created_at BETWEEN $1 AND $2
),
wos AS MATERIALIZED (       -- the shop's classifier once per distinct (status, payment)
  SELECT d.status, d.payment_status, d.payment_method,
         public.web_order_outcome(d.status, d.payment_status, d.payment_method) AS oc
  FROM (SELECT DISTINCT w.status, w.payment_status, w.payment_method
          FROM public.web_orders w
         WHERE w.deleted_in_shop_at IS NULL
           AND w.created_at BETWEEN $1 AND $2) d
),
wl AS (
  SELECT w.shop_order_id, w.order_number, w.is_legacy, w.created_at, wos.oc,
         public.cohort_web_bucket(wos.oc, w.is_legacy, w.total, p.status_id, p.tracking_id IS NOT NULL) AS bucket
  FROM public.web_orders w
  JOIN wos ON wos.status = w.status AND wos.payment_status = w.payment_status
          AND wos.payment_method = w.payment_method
  LEFT JOIN public.mex_parcels p ON p.tracking_id = w.mex_tracking_id
  WHERE w.deleted_in_shop_at IS NULL
    AND w.created_at BETWEEN $1 AND $2
)
SELECT 'order'::text                                                           AS kind,
       public.cohort_order_source(ol.sale_source)                              AS source,
       coalesce(ol.sale_source_detail, 'none')                                 AS split,
       ol.created_at                                                           AS came_at,
       CASE WHEN ol.sale_source_detail = 'disposition'                         THEN 'disposition'
            WHEN public.cohort_in_total(ol.bucket)                             THEN 'sale'
            WHEN ol.status = 'cancelled'                                       THEN 'cancelled'
            WHEN ol.status = 'trashed'                                         THEN 'trashed'
            WHEN ol.status IN ('pending', 'take', 'call_again', 'duplicated')  THEN 'open'
            ELSE 'other' END                                                   AS state,
       ol.bucket                                                               AS bucket,
       ol.id                                                                   AS order_id,
       ol.display_id                                                           AS display_id,
       NULL::integer                                                           AS web_id,
       ol.sold_by_person_id                                                    AS person_id
FROM ol
UNION ALL
SELECT 'web'::text,
       'web'::text,
       CASE WHEN wl.is_legacy THEN 'opencart' ELSE 'shop' END,
       wl.created_at,
       CASE WHEN public.cohort_in_total(wl.bucket) THEN 'sale'
            WHEN wl.oc = 'cancelled'               THEN 'cancelled'
            WHEN wl.oc = 'awaiting'                THEN 'open'
            ELSE 'other' END,
       wl.bucket, NULL::uuid, wl.order_number, wl.shop_order_id, NULL::uuid
FROM wl
WHERE wl.oc <> 'card_unpaid'
  $lr$
  USING p_from, p_to_end;
END;
$fn$;

COMMENT ON FUNCTION public.insights_leads_rows(timestamptz, timestamptz) IS
  'The leads funnel (owner rules 2026-09-28): orders and web orders that CAME IN in the window (created_at), each with its state now: sale | cancelled | trashed | open | other | disposition. Failed card checkouts are dropped; MEX-only parcels are not leads.';

-- ── 7. insights_cash_rows — MEX money by delivery day ──────────────────────
-- One row per MEX parcel DELIVERED in the window (delivered_at, write-once),
-- both accounts, every parcel exactly once, owned as in the header (web claim
-- → real order → MEX-only). card_mkd: the card money of a card-paid web order
-- (payment PAID / PARTIALLY_REFUNDED) = shop total − the COD MEX collected.
-- sale_at: the owner's sale day — splits the cash into "from this period's
-- sales" and "from earlier sales".
CREATE OR REPLACE FUNCTION public.insights_cash_rows(p_from timestamptz, p_to_end timestamptz)
RETURNS TABLE (
  kind         text,
  source       text,
  split        text,
  tracking_id  text,
  delivered_at timestamptz,
  cod_mkd      numeric,
  card_mkd     numeric,
  sale_at      timestamptz,
  order_id     uuid,
  display_id   text,
  web_id       integer,
  account      text,
  series       text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET TimeZone = 'UTC'
SET work_mem = '64MB'
AS $fn$
BEGIN
  IF p_from IS NULL OR p_to_end IS NULL OR p_to_end < p_from OR p_to_end - p_from > interval '800 days' THEN
    RAISE EXCEPTION 'insights_cash_rows: bad window' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY EXECUTE $cr$
WITH
dp AS MATERIALIZED (
  SELECT p.tracking_id, p.account, p.series, p.sender_reference, p.cod_mkd, p.delivered_at,
         p.created_at_mex, p.order_id
  FROM public.mex_parcels p
  WHERE p.delivered_at BETWEEN $1 AND $2
),
led AS MATERIALIZED (
  SELECT l.order_id, max(l.decided_at) AS decided_at
  FROM public.altercpa_leads l
  JOIN public.orders x ON x.id = l.order_id AND x.sold_at IS NULL
  WHERE l.order_id IS NOT NULL
    AND l.decision IN ('approved', 'cancel_other')
    AND l.decided_at IS NOT NULL
  GROUP BY l.order_id
),
wcl AS (                   -- the live web order that claims the parcel
  SELECT DISTINCT ON (w.mex_tracking_id)
         w.mex_tracking_id AS tr, w.shop_order_id, w.order_number, w.created_at, w.total,
         w.payment_method, w.payment_status, w.is_legacy
  FROM public.web_orders w
  JOIN dp ON dp.tracking_id = w.mex_tracking_id
  WHERE w.deleted_in_shop_at IS NULL
  ORDER BY w.mex_tracking_id, w.created_at DESC, w.shop_order_id DESC
),
ocl AS (                   -- the real order that holds it (the linked one first)
  SELECT DISTINCT ON (x.mex_tracking_id)
         x.mex_tracking_id AS tr, x.id, x.display_id, x.sale_source, x.sale_source_detail,
         coalesce(x.sold_at, (SELECT led.decided_at FROM led WHERE led.order_id = x.id),
                  x.confirmed_at, x.created_at) AS sale_at
  FROM dp
  JOIN public.orders x ON x.mex_tracking_id = dp.tracking_id
  WHERE x.sale_source_detail IS DISTINCT FROM 'disposition'
  ORDER BY x.mex_tracking_id, (x.id = dp.order_id) IS TRUE DESC, x.display_id
)
SELECT CASE WHEN wcl.tr IS NOT NULL THEN 'web' WHEN ow.id IS NOT NULL THEN 'order' ELSE 'mex' END AS kind,
       CASE WHEN wcl.tr IS NOT NULL THEN 'web'
            WHEN ow.id IS NOT NULL THEN public.cohort_order_source(ow.sale_source)
            ELSE public.cohort_split_source(public.cohort_parcel_split(dp.series, dp.tracking_id, dp.sender_reference)) END AS source,
       CASE WHEN wcl.tr IS NOT NULL THEN CASE WHEN wcl.is_legacy THEN 'opencart' ELSE 'shop' END
            WHEN ow.id IS NOT NULL THEN coalesce(ow.sale_source_detail, 'none')
            ELSE public.cohort_parcel_split(dp.series, dp.tracking_id, dp.sender_reference) END AS split,
       dp.tracking_id                                                        AS tracking_id,
       dp.delivered_at                                                       AS delivered_at,
       dp.cod_mkd::numeric                                                   AS cod_mkd,
       CASE WHEN wcl.tr IS NOT NULL AND wcl.payment_method = 'CARD'
                 AND wcl.payment_status IN ('PAID', 'PARTIALLY_REFUNDED')
            THEN greatest(wcl.total - coalesce(dp.cod_mkd, 0), 0) END        AS card_mkd,
       CASE WHEN wcl.tr IS NOT NULL THEN wcl.created_at
            WHEN ow.id IS NOT NULL THEN ow.sale_at
            ELSE dp.created_at_mex END                                       AS sale_at,
       CASE WHEN wcl.tr IS NULL THEN ow.id END                               AS order_id,
       CASE WHEN wcl.tr IS NOT NULL THEN wcl.order_number
            WHEN ow.id IS NOT NULL THEN ow.display_id
            ELSE dp.tracking_id END                                          AS display_id,
       wcl.shop_order_id                                                     AS web_id,
       dp.account                                                            AS account,
       dp.series                                                             AS series
FROM dp
LEFT JOIN wcl ON wcl.tr = dp.tracking_id
LEFT JOIN ocl ON ocl.tr = dp.tracking_id
-- a parcel linked (mex_parcels.order_id) to a real order that does not carry
-- its tracking id (0 on 2026-09-28) still belongs to that order
LEFT JOIN LATERAL (
  SELECT x.id, x.display_id, x.sale_source, x.sale_source_detail,
         coalesce(x.sold_at, (SELECT led.decided_at FROM led WHERE led.order_id = x.id),
                  x.confirmed_at, x.created_at) AS sale_at
  FROM public.orders x
  WHERE ocl.tr IS NULL AND wcl.tr IS NULL AND dp.order_id IS NOT NULL
    AND x.id = dp.order_id
    AND x.sale_source_detail IS DISTINCT FROM 'disposition'
) olk ON true
CROSS JOIN LATERAL (
  SELECT coalesce(ocl.id, olk.id)                 AS id,
         coalesce(ocl.display_id, olk.display_id) AS display_id,
         CASE WHEN ocl.tr IS NOT NULL THEN ocl.sale_source ELSE olk.sale_source END               AS sale_source,
         CASE WHEN ocl.tr IS NOT NULL THEN ocl.sale_source_detail ELSE olk.sale_source_detail END AS sale_source_detail,
         coalesce(ocl.sale_at, olk.sale_at)       AS sale_at
) ow
  $cr$
  USING p_from, p_to_end;
END;
$fn$;

COMMENT ON FUNCTION public.insights_cash_rows(timestamptz, timestamptz) IS
  'Cash flow (owner rules 2026-09-28): every MEX parcel delivered in the window, once, with its owner (web claim → order → MEX-only), COD, the card money of a card-paid web order, and the owner''s sale day. Σ cod_mkd ties to the MEX register.';

-- ── 8. The two id lists the /orders twin cannot derive from order columns ──
--   web_claimed  orders whose mex_tracking_id a live web order claims (the
--                order is judged WITHOUT that parcel)
--   ledger       orders with no sold_at whose sale day is the AlterCPA
--                ledger's decided_at (approved | cancel_other)
-- Both are tiny (6 and 2 on 2026-09-28; the stamping cron empties the second).
CREATE OR REPLACE FUNCTION public.insights_cohort_order_exceptions()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT jsonb_build_object(
    'web_claimed', coalesce((
      SELECT jsonb_agg(DISTINCT x.id)
      FROM public.orders x
      JOIN public.web_orders w ON w.mex_tracking_id = x.mex_tracking_id AND w.deleted_in_shop_at IS NULL
      WHERE x.mex_tracking_id IS NOT NULL), '[]'::jsonb),
    'ledger', coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', q.order_id, 'sale_at', q.decided_at) ORDER BY q.order_id)
      FROM (SELECT l.order_id, max(l.decided_at) AS decided_at
              FROM public.altercpa_leads l
              JOIN public.orders x ON x.id = l.order_id AND x.sold_at IS NULL
             WHERE l.order_id IS NOT NULL
               AND l.decision IN ('approved', 'cancel_other')
               AND l.decided_at IS NOT NULL
             GROUP BY l.order_id) q), '[]'::jsonb))
$fn$;

COMMENT ON FUNCTION public.insights_cohort_order_exceptions() IS
  'For GET /orders?cohort_bucket: {web_claimed: [order ids whose parcel a web order claims], ledger: [{id, sale_at}] orders dated by the AlterCPA ledger}. The PostgREST twin of the cohort needs exactly these two lists.';

-- ── 9. Money strip (non-owners): every *_mkd / *_eur key, at any depth ─────
CREATE OR REPLACE FUNCTION public.insights_strip_money(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $fn$
DECLARE
  r jsonb;
  k text;
  v jsonb;
BEGIN
  IF p IS NULL THEN
    RETURN NULL;
  END IF;
  IF jsonb_typeof(p) = 'object' THEN
    r := '{}'::jsonb;
    FOR k, v IN SELECT e.key, e.value FROM jsonb_each(p) e LOOP
      CONTINUE WHEN k ~ '(_mkd|_eur)$';
      r := r || jsonb_build_object(k, public.insights_strip_money(v));
    END LOOP;
    RETURN r;
  ELSIF jsonb_typeof(p) = 'array' THEN
    RETURN coalesce((SELECT jsonb_agg(public.insights_strip_money(e.value) ORDER BY e.ord)
                       FROM jsonb_array_elements(p) WITH ORDINALITY e(value, ord)), '[]'::jsonb);
  END IF;
  RETURN p;
END;
$fn$;

-- ── 10. insights_cohort — THE contract (GET /api/insights/cohort) ──────────
-- { meta:{from,to,prev_from,prev_to,generated_at,money,clock:'sale',sources,granularity},
--   total:{count,value_mkd?,cod_mkd?,orders,web,mex_only,drill},
--   buckets:[{key,count,value_mkd?,cod_mkd?,orders,web,mex_only,drill}]   Σ = total
--   outside:[{key:'cancelled_after_sale'|'replacement',count,value_mkd?,orders,web,mex_only,drill}],
--   by_source:[{key,total,buckets,outside,splits:[{key,kind,count,value_mkd?,drill}],leads_in}],
--   leads_in:{came_in,became_sales,cancelled,trashed,open,conversion,other,disposition},
--   cash_flow:{cod_mkd?,card_mkd?,parcels,card_orders,from_this_period_mkd?,from_earlier_mkd?},
--   prev:{total,buckets} | null,
--   spark:[{d,count,value_mkd?}],
--   quality:[{kind,count,value_mkd?}] — all five kinds, always }
-- orders / web / mex_only split each count into what GET /orders can list
-- (orders) and what it cannot (web orders, MEX-only parcels); drill is the
-- /orders link of the orders part, NULL when there is none. p_money = false
-- removes every *_mkd / *_eur key (absent, never 0). p_sources NULL = all four.
-- Spark: at least 14 Skopje days ending at `to`, daily up to 62 days, monthly
-- beyond. prev has no drill links (its window may be cut at the elapsed time).
CREATE OR REPLACE FUNCTION public.insights_cohort(
  p_from        timestamptz,
  p_to_end      timestamptz,
  p_prev_from   timestamptz DEFAULT NULL,
  p_prev_to_end timestamptz DEFAULT NULL,
  p_sources     text[]      DEFAULT NULL,
  p_money       boolean     DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET TimeZone = 'UTC'
SET work_mem = '64MB'
AS $fn$
DECLARE
  v_all  text[] := ARRAY['altercpa', 'elyon_crm', 'web', 'teleshop_other'];
  v_src  text[];
  v_bad  text;
  v_pf   timestamptz;
  v_pt   timestamptz;
  v_fd   date;
  v_td   date;
  v_pfd  date;
  v_ptd  date;
  v_sfd  date;
  v_gran text;
  v_lo   timestamptz;
  v_out  jsonb;
BEGIN
  IF p_from IS NULL OR p_to_end IS NULL THEN
    RAISE EXCEPTION 'insights_cohort: p_from and p_to_end are required' USING ERRCODE = '22023';
  END IF;
  IF p_to_end < p_from OR p_to_end - p_from > interval '800 days' THEN
    RAISE EXCEPTION 'insights_cohort: bad window' USING ERRCODE = '22023';
  END IF;
  IF p_prev_from IS NOT NULL AND p_prev_to_end IS NOT NULL
     AND p_prev_to_end >= p_prev_from AND p_prev_to_end - p_prev_from <= interval '800 days' THEN
    v_pf := p_prev_from;
    v_pt := p_prev_to_end;
  END IF;

  SELECT array_agg(DISTINCT lower(btrim(s))) INTO v_src
    FROM unnest(coalesce(p_sources, ARRAY[]::text[])) s
   WHERE nullif(btrim(s), '') IS NOT NULL;
  IF v_src IS NULL OR cardinality(v_src) = 0 THEN
    v_src := v_all;
  END IF;
  SELECT s INTO v_bad FROM unnest(v_src) s WHERE NOT (s = ANY (v_all)) LIMIT 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'insights_cohort: unknown source %', v_bad USING ERRCODE = '22023';
  END IF;

  v_fd   := (p_from   AT TIME ZONE 'Europe/Skopje')::date;
  v_td   := (p_to_end AT TIME ZONE 'Europe/Skopje')::date;
  v_pfd  := (v_pf AT TIME ZONE 'Europe/Skopje')::date;
  v_ptd  := (v_pt AT TIME ZONE 'Europe/Skopje')::date;
  v_sfd  := CASE WHEN v_td - v_fd + 1 >= 14 THEN v_fd ELSE v_td - 13 END;
  v_gran := CASE WHEN v_td - v_sfd + 1 <= 62 THEN 'day' ELSE 'month' END;
  v_lo   := least(p_from, coalesce(v_pf, p_from), (v_sfd::timestamp AT TIME ZONE 'Europe/Skopje'));

  -- $1 from · $2 to_end · $3 prev_from · $4 prev_to_end · $5 sources ·
  -- $6 from day · $7 to day · $8 spark first day · $9 spark granularity ·
  -- $10 prev from day · $11 prev to day · $12 all four sources · $13 the
  -- earliest instant any part needs (prev / spark)
  EXECUTE $co$
WITH
prm AS (
  SELECT $1::timestamptz AS f, $2::timestamptz AS t, $3::timestamptz AS pf, $4::timestamptz AS pt,
         $5::text[] AS srcs, $6::date AS fd, $7::date AS td, $8::date AS sfd, $9::text AS sgran,
         $10::date AS pfd, $11::date AS ptd, $12::boolean AS all_src,
         CASE WHEN $9::text = 'day' THEN 'YYYY-MM-DD' ELSE 'YYYY-MM' END AS sfmt,
         '&sold_from=' || to_char($6::date, 'YYYY-MM-DD') || '&sold_to=' || to_char($7::date, 'YYYY-MM-DD') AS win_q
),
srcs AS (
  SELECT s.key, s.ord, s.ss
  FROM (VALUES ('altercpa', 1, 'altercpa,affiliate'), ('elyon_crm', 2, 'elyon_crm'),
               ('web', 3, 'web'), ('teleshop_other', 4, 'collabbox,legacy')) s(key, ord, ss)
  CROSS JOIN prm
  WHERE s.key = ANY (prm.srcs)
),
-- '*' = every selected source; its sale_source filter is omitted when all four are
scopes AS (
  SELECT '*'::text AS src, 0 AS ord,
         CASE WHEN (SELECT all_src FROM prm) THEN NULL
              ELSE (SELECT string_agg(s.ss, ',' ORDER BY s.ord) FROM srcs s) END AS ss
  UNION ALL
  SELECT s.key, s.ord, s.ss FROM srcs s
),
bks AS (
  SELECT * FROM (VALUES ('paid', 1, true), ('paid_unproven', 2, true), ('paid_legacy', 3, true),
                        ('courier', 4, true), ('courier_problem', 5, true), ('label', 6, true),
                        ('to_pack', 7, true), ('returned', 8, true),
                        ('cancelled_after_sale', 9, false), ('replacement', 10, false)) v(key, ord, in_total)
),
sr AS MATERIALIZED (
  SELECT r.kind, r.source, r.split, r.bucket, r.in_total, r.value_mkd, r.cod_mkd, r.sale_day,
         r.q_cancelled_but_moving, r.q_no_seller, r.q_zero_cod, r.q_shared_parcel, r.q_double_count,
         (r.sale_at BETWEEN prm.f AND prm.t) AS cur,
         coalesce(r.sale_at BETWEEN prm.pf AND prm.pt, false) AS prev
  FROM public.insights_sale_rows($13, $2, false) r
  CROSS JOIN prm
  WHERE r.source = ANY (prm.srcs)
),
ag AS (                    -- (source | every source) × bucket, current and previous
  SELECT coalesce(r.source, '*') AS src, r.bucket,
         count(*) FILTER (WHERE r.cur)                        AS n,
         coalesce(sum(r.value_mkd) FILTER (WHERE r.cur), 0)   AS v,
         coalesce(sum(r.cod_mkd)   FILTER (WHERE r.cur), 0)   AS c,
         count(*) FILTER (WHERE r.cur AND r.kind = 'order')   AS n_order,
         count(*) FILTER (WHERE r.cur AND r.kind = 'web')     AS n_web,
         count(*) FILTER (WHERE r.cur AND r.kind = 'mex')     AS n_mex,
         count(*) FILTER (WHERE r.prev)                       AS pn,
         coalesce(sum(r.value_mkd) FILTER (WHERE r.prev), 0)  AS pv,
         coalesce(sum(r.cod_mkd)   FILTER (WHERE r.prev), 0)  AS pc
  FROM sr r
  WHERE r.cur OR r.prev
  GROUP BY GROUPING SETS ((r.source, r.bucket), (r.bucket))
),
bx AS (                    -- every scope × every bucket, zero-filled
  SELECT sc.src, sc.ord AS sord, sc.ss, b.key, b.ord, b.in_total,
         coalesce(a.n, 0) AS n, coalesce(a.v, 0) AS v, coalesce(a.c, 0) AS c,
         coalesce(a.n_order, 0) AS n_order, coalesce(a.n_web, 0) AS n_web, coalesce(a.n_mex, 0) AS n_mex,
         coalesce(a.pn, 0) AS pn, coalesce(a.pv, 0) AS pv, coalesce(a.pc, 0) AS pc
  FROM scopes sc
  CROSS JOIN bks b
  LEFT JOIN ag a ON a.src = sc.src AND a.bucket = b.key
),
bj AS (
  SELECT x.src,
    jsonb_agg(jsonb_build_object(
      'key', x.key, 'count', x.n, 'value_mkd', round(x.v), 'cod_mkd', round(x.c),
      'orders', x.n_order, 'web', x.n_web, 'mex_only', x.n_mex,
      'drill', CASE WHEN x.n_order > 0 THEN
                 '/orders?cohort_bucket=' || x.key || coalesce('&sale_source=' || x.ss, '') || prm.win_q END)
      ORDER BY x.ord) FILTER (WHERE x.in_total) AS buckets,
    jsonb_agg(jsonb_build_object(
      'key', x.key, 'count', x.n, 'value_mkd', round(x.v),
      'orders', x.n_order, 'web', x.n_web, 'mex_only', x.n_mex,
      'drill', CASE WHEN x.n_order > 0 THEN
                 '/orders?cohort_bucket=' || x.key || coalesce('&sale_source=' || x.ss, '') || prm.win_q END)
      ORDER BY x.ord) FILTER (WHERE NOT x.in_total) AS outside,
    jsonb_build_object(
      'count', coalesce(sum(x.n) FILTER (WHERE x.in_total), 0),
      'value_mkd', round(coalesce(sum(x.v) FILTER (WHERE x.in_total), 0)),
      'cod_mkd', round(coalesce(sum(x.c) FILTER (WHERE x.in_total), 0)),
      'orders', coalesce(sum(x.n_order) FILTER (WHERE x.in_total), 0),
      'web', coalesce(sum(x.n_web) FILTER (WHERE x.in_total), 0),
      'mex_only', coalesce(sum(x.n_mex) FILTER (WHERE x.in_total), 0),
      'drill', CASE WHEN coalesce(sum(x.n_order) FILTER (WHERE x.in_total), 0) > 0 THEN
                 '/orders?cohort_bucket=total' || coalesce('&sale_source=' || max(x.ss), '') || max(prm.win_q) END) AS total,
    jsonb_build_object(
      'count', coalesce(sum(x.pn) FILTER (WHERE x.in_total), 0),
      'value_mkd', round(coalesce(sum(x.pv) FILTER (WHERE x.in_total), 0)),
      'cod_mkd', round(coalesce(sum(x.pc) FILTER (WHERE x.in_total), 0))) AS prev_total,
    jsonb_agg(jsonb_build_object('key', x.key, 'count', x.pn, 'value_mkd', round(x.pv), 'cod_mkd', round(x.pc))
      ORDER BY x.ord) FILTER (WHERE x.in_total) AS prev_buckets
  FROM bx x
  CROSS JOIN prm
  GROUP BY x.src
),
sp AS (                    -- splits: what each source's total is made of
  SELECT r.source, r.split, r.kind, count(*) AS n, sum(r.value_mkd) AS v
  FROM sr r
  WHERE r.cur AND r.in_total
  GROUP BY r.source, r.split, r.kind
),
spj AS (
  SELECT sp.source,
    jsonb_agg(jsonb_build_object(
      'key', sp.split, 'kind', sp.kind, 'count', sp.n, 'value_mkd', round(sp.v),
      'drill', CASE WHEN sp.kind = 'order' AND sp.split <> 'none' THEN
                 '/orders?cohort_bucket=total&sale_source=' || s.ss || '&sale_source_detail=' || sp.split || prm.win_q END)
      ORDER BY sp.n DESC, sp.split) AS j
  FROM sp
  JOIN srcs s ON s.key = sp.source
  CROSS JOIN prm
  GROUP BY sp.source
),
lr AS MATERIALIZED (
  SELECT l.source, l.state
  FROM public.insights_leads_rows($1, $2) l
  CROSS JOIN prm
  WHERE l.source = ANY (prm.srcs)
),
la AS (
  SELECT coalesce(l.source, '*') AS src,
         count(*) FILTER (WHERE l.state <> 'disposition') AS came_in,
         count(*) FILTER (WHERE l.state = 'sale')         AS sales,
         count(*) FILTER (WHERE l.state = 'cancelled')    AS cancelled,
         count(*) FILTER (WHERE l.state = 'trashed')      AS trashed,
         count(*) FILTER (WHERE l.state = 'open')         AS open,
         count(*) FILTER (WHERE l.state = 'other')        AS other,
         count(*) FILTER (WHERE l.state = 'disposition')  AS dispo
  FROM lr l
  GROUP BY GROUPING SETS ((l.source), ())
),
laj AS (
  SELECT sc.src, jsonb_build_object(
    'came_in',      coalesce(la.came_in, 0),
    'became_sales', coalesce(la.sales, 0),
    'cancelled',    coalesce(la.cancelled, 0),
    'trashed',      coalesce(la.trashed, 0),
    'open',         coalesce(la.open, 0),
    'conversion',   CASE WHEN coalesce(la.came_in, 0) > 0 THEN round(la.sales::numeric / la.came_in, 4) END,
    'other',        coalesce(la.other, 0),
    'disposition',  coalesce(la.dispo, 0)) AS j
  FROM scopes sc
  LEFT JOIN la ON la.src = sc.src
),
cr AS MATERIALIZED (
  SELECT c.tracking_id, c.cod_mkd, c.card_mkd, c.sale_at
  FROM public.insights_cash_rows($1, $2) c
  CROSS JOIN prm
  WHERE c.source = ANY (prm.srcs)
),
cfj AS (
  SELECT jsonb_build_object(
    'parcels',     count(c.tracking_id),
    'cod_mkd',     round(coalesce(sum(c.cod_mkd), 0)),
    'card_mkd',    round(coalesce(sum(c.card_mkd), 0)),
    'card_orders', count(*) FILTER (WHERE c.card_mkd > 0),
    'from_this_period_mkd', round(coalesce(sum(coalesce(c.cod_mkd, 0) + coalesce(c.card_mkd, 0))
                                   FILTER (WHERE c.sale_at BETWEEN prm.f AND prm.t), 0)),
    'from_earlier_mkd',     round(coalesce(sum(coalesce(c.cod_mkd, 0) + coalesce(c.card_mkd, 0))
                                   FILTER (WHERE c.sale_at IS NULL OR NOT (c.sale_at BETWEEN prm.f AND prm.t)), 0))) AS j
  FROM prm
  LEFT JOIN cr c ON true
  GROUP BY prm.f, prm.t
),
sk AS (
  SELECT to_char(g, prm.sfmt) AS d
  FROM prm, generate_series(date_trunc(prm.sgran, prm.sfd::timestamp), date_trunc(prm.sgran, prm.td::timestamp),
                            ('1 ' || prm.sgran)::interval) g
),
sv AS (
  SELECT to_char(date_trunc(prm.sgran, r.sale_day::timestamp), prm.sfmt) AS d, count(*) AS n, sum(r.value_mkd) AS v
  FROM sr r CROSS JOIN prm
  WHERE r.in_total AND r.sale_day BETWEEN prm.sfd AND prm.td
  GROUP BY 1
),
skj AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object('d', sk.d, 'count', coalesce(sv.n, 0), 'value_mkd', round(coalesce(sv.v, 0)))
                            ORDER BY sk.d), '[]'::jsonb) AS j
  FROM sk LEFT JOIN sv ON sv.d = sk.d
),
qj AS (
  SELECT jsonb_build_array(
    jsonb_build_object('kind', 'unproven_paid',
      'count', count(*) FILTER (WHERE r.bucket = 'paid_unproven'),
      'value_mkd', round(coalesce(sum(r.value_mkd) FILTER (WHERE r.bucket = 'paid_unproven'), 0))),
    jsonb_build_object('kind', 'zero_cod_parcels',
      'count', count(*) FILTER (WHERE r.q_zero_cod),
      'value_mkd', round(coalesce(sum(r.cod_mkd) FILTER (WHERE r.q_zero_cod), 0))),
    jsonb_build_object('kind', 'double_count_candidates',
      'count', count(*) FILTER (WHERE r.q_double_count OR r.q_shared_parcel),
      'value_mkd', round(coalesce(sum(r.value_mkd) FILTER (WHERE r.q_double_count OR r.q_shared_parcel), 0))),
    jsonb_build_object('kind', 'no_seller',
      'count', count(*) FILTER (WHERE r.q_no_seller),
      'value_mkd', round(coalesce(sum(r.value_mkd) FILTER (WHERE r.q_no_seller), 0))),
    jsonb_build_object('kind', 'cancelled_but_moving',
      'count', count(*) FILTER (WHERE r.q_cancelled_but_moving),
      'value_mkd', round(coalesce(sum(r.value_mkd) FILTER (WHERE r.q_cancelled_but_moving), 0)))) AS j
  FROM sr r
  WHERE r.cur
),
bsj AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'key',       s.key,
    'total',     b.total,
    'buckets',   b.buckets,
    'outside',   b.outside,
    'splits',    coalesce(sj.j, '[]'::jsonb),
    'leads_in',  l.j) ORDER BY s.ord), '[]'::jsonb) AS j
  FROM srcs s
  JOIN bj b ON b.src = s.key
  JOIN laj l ON l.src = s.key
  LEFT JOIN spj sj ON sj.source = s.key
)
SELECT jsonb_build_object(
  'meta', jsonb_build_object(
    'from',         to_char(prm.fd, 'YYYY-MM-DD'),
    'to',           to_char(prm.td, 'YYYY-MM-DD'),
    'prev_from',    to_char(prm.pfd, 'YYYY-MM-DD'),
    'prev_to',      to_char(prm.ptd, 'YYYY-MM-DD'),
    'generated_at', now(),
    'money',        true,
    'clock',        'sale',
    'sources',      to_jsonb(ARRAY(SELECT s.key FROM srcs s ORDER BY s.ord)),
    'granularity',  prm.sgran),
  'total',     b.total,
  'buckets',   b.buckets,
  'outside',   b.outside,
  'by_source', (SELECT j FROM bsj),
  'leads_in',  (SELECT l.j FROM laj l WHERE l.src = '*'),
  'cash_flow', (SELECT j FROM cfj),
  'prev',      CASE WHEN prm.pf IS NULL THEN NULL
                    ELSE jsonb_build_object('total', b.prev_total, 'buckets', b.prev_buckets) END,
  'spark',     (SELECT j FROM skj),
  'quality',   (SELECT j FROM qj))
FROM prm
JOIN bj b ON b.src = '*'
  $co$
  INTO v_out
  USING p_from, p_to_end, v_pf, v_pt, v_src, v_fd, v_td, v_sfd, v_gran, v_pfd, v_ptd,
        (v_src @> v_all), v_lo;

  IF coalesce(p_money, false) THEN
    RETURN v_out;
  END IF;
  v_out := public.insights_strip_money(v_out);
  RETURN jsonb_set(v_out, '{meta,money}', 'false'::jsonb);
END;
$fn$;

COMMENT ON FUNCTION public.insights_cohort(timestamptz, timestamptz, timestamptz, timestamptz, text[], boolean) IS
  'GET /api/insights/cohort (owner rules 2026-09-28): the sales made in the window (sale day, Skopje) split into MEX-first buckets that sum exactly to the total, by source with splits and the leads funnel, cash flow by MEX delivery day (+ card), previous period, spark and quality. p_money = false strips every *_mkd / *_eur key. Contract: migration 20260940000000.';

-- ── 11. Grants ──────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.cohort_order_source(text)                          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cohort_order_bucket(text, numeric, timestamptz, text, text, text, text, integer, integer, timestamptz, boolean)
                                                                                 FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cohort_web_bucket(text, boolean, numeric, integer, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cohort_parcel_bucket(integer, integer)             FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cohort_parcel_split(text, text, text)              FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cohort_split_source(text)                          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cohort_in_total(text)                              FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mk_geo_norm(text)                                  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mk_city_key(text)                                  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.product_alias_norm(text)                           FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.product_key(text, text, uuid)                      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.order_line_kind(text, text)                        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.insights_sale_rows(timestamptz, timestamptz, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.insights_leads_rows(timestamptz, timestamptz)      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.insights_cash_rows(timestamptz, timestamptz)       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.insights_cohort_order_exceptions()                 FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.insights_strip_money(jsonb)                        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.insights_cohort(timestamptz, timestamptz, timestamptz, timestamptz, text[], boolean)
                                                                                 FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.cohort_order_source(text)                       TO service_role;
GRANT EXECUTE ON FUNCTION public.cohort_order_bucket(text, numeric, timestamptz, text, text, text, text, integer, integer, timestamptz, boolean)
                                                                                 TO service_role;
GRANT EXECUTE ON FUNCTION public.cohort_web_bucket(text, boolean, numeric, integer, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.cohort_parcel_bucket(integer, integer)          TO service_role;
GRANT EXECUTE ON FUNCTION public.cohort_parcel_split(text, text, text)           TO service_role;
GRANT EXECUTE ON FUNCTION public.cohort_split_source(text)                       TO service_role;
GRANT EXECUTE ON FUNCTION public.cohort_in_total(text)                           TO service_role;
-- Pure text folding: harmless to a signed-in user (search boxes may use it).
GRANT EXECUTE ON FUNCTION public.mk_geo_norm(text)                               TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mk_city_key(text)                               TO service_role;
GRANT EXECUTE ON FUNCTION public.product_alias_norm(text)                        TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.product_key(text, text, uuid)                   TO service_role;
GRANT EXECUTE ON FUNCTION public.order_line_kind(text, text)                     TO service_role;
GRANT EXECUTE ON FUNCTION public.insights_sale_rows(timestamptz, timestamptz, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.insights_leads_rows(timestamptz, timestamptz)   TO service_role;
GRANT EXECUTE ON FUNCTION public.insights_cash_rows(timestamptz, timestamptz)    TO service_role;
GRANT EXECUTE ON FUNCTION public.insights_cohort_order_exceptions()              TO service_role;
GRANT EXECUTE ON FUNCTION public.insights_strip_money(jsonb)                     TO service_role;
GRANT EXECUTE ON FUNCTION public.insights_cohort(timestamptz, timestamptz, timestamptz, timestamptz, text[], boolean)
                                                                                 TO service_role;

-- The read-only verification harness (scripts/verify-insights-ties.mjs) calls
-- these through the Management API with read_only: true, which runs as
-- supabase_read_only_user. That role already reads every table
-- (pg_read_all_data), so EXECUTE on functions that only read widens nothing.
-- Conditional so a fresh local database without the platform role migrates.
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    GRANT EXECUTE ON FUNCTION public.cohort_order_source(text)                    TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.cohort_order_bucket(text, numeric, timestamptz, text, text, text, text, integer, integer, timestamptz, boolean)
                                                                                 TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.cohort_web_bucket(text, boolean, numeric, integer, boolean) TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.cohort_parcel_bucket(integer, integer)       TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.cohort_parcel_split(text, text, text)        TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.cohort_split_source(text)                    TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.cohort_in_total(text)                        TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.mk_geo_norm(text)                            TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.mk_city_key(text)                            TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.product_alias_norm(text)                     TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.product_key(text, text, uuid)                TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.order_line_kind(text, text)                  TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.insights_sale_rows(timestamptz, timestamptz, boolean) TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.insights_leads_rows(timestamptz, timestamptz) TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.insights_cash_rows(timestamptz, timestamptz) TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.insights_cohort_order_exceptions()           TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.insights_strip_money(jsonb)                  TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.insights_cohort(timestamptz, timestamptz, timestamptz, timestamptz, text[], boolean)
                                                                                 TO supabase_read_only_user;
    GRANT SELECT ON public.product_aliases TO supabase_read_only_user;
  END IF;
END
$grant$;

NOTIFY pgrst, 'reload schema';
