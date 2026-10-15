-- ============================================================================
-- THE CUSTOMER'S ORIGIN — where a buyer FIRST came from (owner, 15.10.2026)
--
-- Owner: "тимот Центар Out ги работи клиентите од целата база … да поделиме колку од тие
-- продажби доаѓаат од претходно што се биле лидови од Affiliate (Bio Natural), а колку од
-- Teleshop (Natura Therapy / Ad Astra)". The Overview's department card of Тим Центар Out (and
-- Тим Маџари Out) splits its sales by the ORIGIN of each buyer (20261015120100). This file keeps
-- the per-phone facts that split needs.
--
-- ORIGIN ≠ DEPARTMENT. The department of a sale is the seller's team / folder / profile
-- (order_dept_by_team, cohort_order_source) and never changes here. The origin is a fact about the
-- CUSTOMER: the side of their first trace, decided by the RAW record of that trace — never by who
-- sold to them later (dept_override is not read).
--
-- A customer = the last 8 digits of the phone (insights_phone8; the test phones of
-- report_excluded_phone8s() never get a row). Per phone, the EARLIEST trace on each side:
--   affiliate  (Bio Natural — came as a Тим Маџари lead)
--              an AlterCPA lead (MK, not a test order; created_remote, else first_seen_at) ·
--              an order with sale_source 'altercpa' (any status: the lead itself, its created_at) ·
--              a CRM sale on the BIO NATURAL profile · a collabBox LEADS / LEADS-OUT order
--              (cohort_order_source 3-arg = altercpa / elyon_crm) · a MEX parcel of series
--              9110 / 9103 or on BIO NATURAL · a collabBox document 10111 / 10114
--   natura     (Natura Therapy / Ad Astra — Тим Центар and Социјални)
--              every other sale (Нарачка in / out, social; the teleshop history) · a MEX parcel
--              of NATURA's series (9100 / 9102 / 9108 / 1300, and every "M…" id before 2023 —
--              MEX's old format, the teleshop) · a collabBox document 10036 / 10050 / 10106 / 10055
--   web        (naturatherapy.mk — Natura Therapy too, counted apart) a web_orders row · a MEX
--              parcel NTMK… / "M…" from 2023 · an order the cohort calls web
-- The SERIES decides before the account: until 02.04.2026 the affiliate parcels (9110 / 9103) went
-- out on the NATURA account (the BIO NATURAL profile did not exist). A collabBox order follows its
-- TYPE (the folder — the DocNumber series lies for ~1.100 documents); a CRM-made sale its profile.
-- Sales = confirmed / shipped / delivered / paid / returned; a disposition record is no trace.
--
-- AT A SALE (customer_origin_at_sale): the side whose earliest trace is more than 1 hour before
-- the sale ('bio_natural' when the affiliate trace is the first, else 'natura' — web included),
-- 'new' when nothing came before (the sale's own order / document / parcel are never "before" it).
--
-- HOW IT STAYS FRESH (no trigger on the hot tables)
--   customer_origin_refresh(false)  every 15 minutes (pg_cron 'customer-origin-refresh', :09 /
--       :24 / :39 / :54 — after the MEX, collabBox and web passes): recomputes EXACTLY every phone
--       touched since the last watermark − 10 minutes (orders.updated_at, new AlterCPA leads, new
--       MEX parcels, changed collabBox documents, new web orders). A no-op until the first full fill.
--   customer_origin_refresh(true)   nightly 05:15 Skopje (pg_cron 'customer-origin-nightly' fires
--       03:15 and 04:15 UTC; the wrapper works only in the Skopje hour 5 — DST-proof): every phone;
--       a phone with no trace left loses its row. It catches what the watermarks cannot show
--       (keep_updated_at writes, deleted orders, a changed phone, reclassified documents).
--   One run at a time (advisory lock); a second caller returns 0. Reads, writes only these tables.
--   The full run reads ~1,2 M traces of 168.000 phones: ~30 s (measured read-only 15.10.2026).
--
-- Access: service role + supabase_read_only_user SELECT (RLS on, no policies). Read by the
-- SECURITY DEFINER insights_cohort.
--
-- NO INITIAL FILL in this file: run `select public.customer_origin_refresh(true)` once after
-- applying (or let the 05:15 job do it). Until then the cohort shows no origin (never a guess).
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '10s';

DO $chk$
BEGIN
  IF to_regprocedure('public.cohort_order_source(text,text,text)') IS NULL
     OR to_regprocedure('public.collabbox_sale_at(timestamptz,timestamptz)') IS NULL
     OR to_regprocedure('public.report_excluded_phone8s()') IS NULL
     OR to_regclass('public.mex_history_stage') IS NULL THEN
    RAISE EXCEPTION 'customer_origin: a dependency is missing (cohort_order_source 3-arg, collabbox_sale_at, report_excluded_phone8s, mex_history_stage)';
  END IF;
END
$chk$;

CREATE TABLE IF NOT EXISTS public.customer_origin (
  phone8        text        PRIMARY KEY CHECK (phone8 ~ '^[0-9]{8}$'),
  affiliate_at  timestamptz,
  affiliate_src text,
  natura_at     timestamptz,
  natura_src    text,
  web_at        timestamptz,
  web_src       text,
  refreshed_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (affiliate_at IS NOT NULL OR natura_at IS NOT NULL OR web_at IS NOT NULL)
);

ALTER TABLE public.customer_origin ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.customer_origin FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.customer_origin TO service_role;

COMMENT ON TABLE public.customer_origin IS
  'Where a customer (last 8 digits of the phone) FIRST came from, per side (20261015120000): the earliest affiliate trace (Bio Natural — an AlterCPA lead, a LEADS / LEADS-OUT document, a 9110 / 9103 or BIO NATURAL parcel, a CRM sale on BIO NATURAL), the earliest natura trace (Natura Therapy / Ad Astra — teleshop / social sales, NATURA series parcels, Нарачка in / out / social documents), the earliest web trace. *_src = lead | order | parcel | doc | web. Read through customer_origin_at_sale(). Refreshed by customer_origin_refresh(): 15-min incremental, 05:15 Skopje full. Never a department.';

CREATE TABLE IF NOT EXISTS public.customer_origin_state (
  id           boolean     PRIMARY KEY DEFAULT true CHECK (id),
  watermark    timestamptz,
  last_run_at  timestamptz,
  last_full_at timestamptz,
  last_mode    text,
  last_phones  integer,
  last_rows    integer,
  last_deleted integer,
  last_ms      integer
);
INSERT INTO public.customer_origin_state (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.customer_origin_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.customer_origin_state FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.customer_origin_state TO service_role;

COMMENT ON TABLE public.customer_origin_state IS
  'customer_origin_refresh() bookkeeping (20261015120000): the watermark of the last run (NULL = the full fill never ran — the incremental run is then a no-op, and the cohort shows no origin) and what the last run did.';

DO $ro$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    GRANT SELECT ON public.customer_origin, public.customer_origin_state TO supabase_read_only_user;
  END IF;
END
$ro$;

-- ── the sides ────────────────────────────────────────────────────────────────

-- A MEX parcel: the SERIES first (9110 / 9103 went out on NATURA before 02.04.2026), then the
-- account; NTMK… (or its sender reference) and "M…" from 2023 = the web shop; else NATURA.
CREATE OR REPLACE FUNCTION public.customer_origin_parcel_side(
  p_account text, p_tracking text, p_sender_ref text, p_created_at timestamptz)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN split_part(coalesce(p_tracking, ''), '-', 2) IN ('9110', '9103') OR p_account = 'bio_natural' THEN 'affiliate'
    WHEN coalesce(p_tracking, '') ~ '^NTMK' OR coalesce(p_sender_ref, '') ~ '^NTMK'
         OR (coalesce(p_tracking, '') ~ '^M' AND p_created_at >= timestamptz '2023-01-01 00:00:00+01') THEN 'web'
    ELSE 'natura' END
$$;
COMMENT ON FUNCTION public.customer_origin_parcel_side(text, text, text, timestamptz) IS
  'The origin side of a MEX parcel (20261015120000): series 9110 / 9103 or the BIO NATURAL account → affiliate; NTMK… / "M…" from 2023 → web; else natura.';

-- An order: an AlterCPA lead → affiliate; a CRM-made sale on BIO NATURAL → affiliate; otherwise the
-- folder / series mapping (cohort_order_source 3-arg — never the seller's team): Тим Маџари's
-- departments → affiliate, web → web, the rest → natura.
CREATE OR REPLACE FUNCTION public.customer_origin_order_side(
  p_sale_source text, p_detail text, p_tracking text, p_mex_account text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN p_sale_source = 'altercpa' THEN 'affiliate'
    WHEN p_sale_source IS DISTINCT FROM 'collabbox' AND p_mex_account = 'bio_natural' THEN 'affiliate'
    ELSE CASE public.cohort_order_source(p_sale_source, p_detail, p_tracking)
           WHEN 'altercpa' THEN 'affiliate'
           WHEN 'elyon_crm' THEN 'affiliate'
           WHEN 'web' THEN 'web'
           ELSE 'natura' END
  END
$$;
COMMENT ON FUNCTION public.customer_origin_order_side(text, text, text, text) IS
  'The origin side of an order (20261015120000): an AlterCPA lead or a CRM-made sale on BIO NATURAL → affiliate; else cohort_order_source 3-arg (the folder / series, never dept_override): altercpa / elyon_crm → affiliate, web → web, else natura.';

-- The origin of a sale at p_sale_at: the earliest side before it (1 hour of slack keeps the
-- sale's own order / document / parcel out). Web is Natura Therapy too.
CREATE OR REPLACE FUNCTION public.customer_origin_at_sale(
  p_affiliate_at timestamptz, p_natura_at timestamptz, p_web_at timestamptz, p_sale_at timestamptz)
RETURNS text
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN p_affiliate_at < p_sale_at - interval '1 hour'
         AND p_affiliate_at <= coalesce(p_natura_at, 'infinity') AND p_affiliate_at <= coalesce(p_web_at, 'infinity')
      THEN 'bio_natural'
    WHEN least(p_natura_at, p_web_at) < p_sale_at - interval '1 hour' THEN 'natura'
    ELSE 'new' END
$$;
COMMENT ON FUNCTION public.customer_origin_at_sale(timestamptz, timestamptz, timestamptz, timestamptz) IS
  'The customer''s origin at a sale (20261015120000): bio_natural (the first trace before the sale is affiliate) | natura (Natura Therapy / Ad Astra, web included) | new (nothing more than 1 hour before the sale).';

-- Natura by the web shop: the first natura-side trace is a web one.
CREATE OR REPLACE FUNCTION public.customer_origin_web_first(
  p_affiliate_at timestamptz, p_natura_at timestamptz, p_web_at timestamptz, p_sale_at timestamptz)
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT coalesce(p_web_at < p_sale_at - interval '1 hour'
                  AND p_web_at < coalesce(p_natura_at, 'infinity')
                  AND p_web_at < coalesce(p_affiliate_at, 'infinity'), false)
$$;

-- Both sides before the sale (the first one still decides).
CREATE OR REPLACE FUNCTION public.customer_origin_mixed(
  p_affiliate_at timestamptz, p_natura_at timestamptz, p_web_at timestamptz, p_sale_at timestamptz)
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT coalesce(p_affiliate_at < p_sale_at - interval '1 hour', false)
     AND coalesce(least(p_natura_at, p_web_at) < p_sale_at - interval '1 hour', false)
$$;

-- ── the one definition: every phone's earliest trace per side ───────────────

CREATE OR REPLACE FUNCTION public.customer_origin_rows(p_phones text[] DEFAULT NULL)
RETURNS TABLE(phone8 text, affiliate_at timestamptz, affiliate_src text, natura_at timestamptz, natura_src text,
              web_at timestamptz, web_src text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET "TimeZone" TO 'UTC'
SET work_mem TO '128MB'
SET jit TO 'off'
AS $fn$
DECLARE
  -- each source's phone filter: every phone (NULL) or the given ones, on each index's exact expression
  f_lead  text := CASE WHEN p_phones IS NULL THEN 'true'
                       ELSE $f$right(regexp_replace(coalesce(l.phone_e164, l.phone_raw, ''), '[^0-9]', '', 'g'), 8) = ANY ($1)$f$ END;
  f_order text := CASE WHEN p_phones IS NULL THEN 'true'
                       ELSE $f$right(regexp_replace(o.customer_phone, '[^0-9]', '', 'g'), 8) = ANY ($1)$f$ END;
  f_par   text := CASE WHEN p_phones IS NULL THEN 'true' ELSE 'p.phone8 = ANY ($1)' END;
  f_hist  text := CASE WHEN p_phones IS NULL THEN 'true' ELSE 'h.phone8 = ANY ($1)' END;
  f_doc   text := CASE WHEN p_phones IS NULL THEN 'true' ELSE 'd.phone8 = ANY ($1)' END;
  f_km    text := CASE WHEN p_phones IS NULL THEN 'true' ELSE 'k.p8 = ANY ($1)' END;
  f_web   text := CASE WHEN p_phones IS NULL THEN 'true' ELSE 'w.phone8 = ANY ($1)' END;
BEGIN
  RETURN QUERY EXECUTE format($q$
WITH
-- a collabBox document with no phone of its own: the komitent's phone as the writer finds it
-- (the card → the teleshop registry → any stored card; insights_sale_rows' bk0)
km AS (
  SELECT k.komitent_id, k.p8
  FROM (
    SELECT DISTINCT ON (x.komitent_id) x.komitent_id, x.p8
    FROM (
      SELECT c.komitent_id, c.phone8 AS p8, 1 AS pr FROM public.collabbox_customers c
       WHERE c.source = 'card' AND c.phone8 ~ '^[0-9]{8}$'
      UNION ALL
      SELECT t.komitent_id, t.phone8, 2 FROM public.teleshop_import_customers t WHERE t.phone8 ~ '^[0-9]{8}$'
      UNION ALL
      SELECT c.komitent_id, c.phone8, 3 FROM public.collabbox_customers c WHERE c.phone8 ~ '^[0-9]{8}$'
    ) x
    ORDER BY x.komitent_id, x.pr
  ) k
  WHERE %6$s
),
docs AS (
  SELECT d.phone8 AS p8, d.doc_type_id, d.doc_at, d.booked_at
  FROM public.collabbox_documents d
  WHERE d.doc_type_id IN ('10111', '10114', '10036', '10050', '10106', '10055')
    AND NOT coalesce(d.is_storno, false) AND d.reversed_by IS NULL AND d.vanished_at IS NULL
    AND d.phone8 ~ '^[0-9]{8}$' AND %5$s
  UNION ALL
  SELECT km.p8, d.doc_type_id, d.doc_at, d.booked_at
  FROM km
  JOIN public.collabbox_documents d ON d.komitent_id = km.komitent_id
  WHERE d.doc_type_id IN ('10111', '10114', '10036', '10050', '10106', '10055')
    AND NOT coalesce(d.is_storno, false) AND d.reversed_by IS NULL AND d.vanished_at IS NULL
    AND (d.phone8 IS NULL OR d.phone8 !~ '^[0-9]{8}$')
),
t AS (
  SELECT right(regexp_replace(coalesce(l.phone_e164, l.phone_raw, ''), '[^0-9]', '', 'g'), 8) AS p8,
         'affiliate'::text AS side, coalesce(l.created_remote, l.first_seen_at) AS at, 'lead'::text AS src
  FROM public.altercpa_leads l
  WHERE upper(coalesce(l.geo, 'MK')) = 'MK' AND l.skip_reason IS DISTINCT FROM 'test_order' AND %1$s
  UNION ALL
  SELECT right(regexp_replace(o.customer_phone, '[^0-9]', '', 'g'), 8),
         public.customer_origin_order_side(o.sale_source, o.sale_source_detail, o.mex_tracking_id, o.mex_account),
         CASE WHEN o.sale_source = 'altercpa' THEN o.created_at ELSE coalesce(o.sold_at, o.confirmed_at, o.created_at) END,
         'order'
  FROM public.orders o
  WHERE (o.sale_source = 'altercpa' OR o.status::text IN ('confirmed', 'shipped', 'delivered', 'paid', 'returned'))
    AND o.sale_source_detail IS DISTINCT FROM 'disposition' AND %2$s
  UNION ALL
  -- the live register (its history copies are the stage's own rows)
  SELECT p.phone8, public.customer_origin_parcel_side(p.account, p.tracking_id, p.sender_reference, p.created_at_mex),
         p.created_at_mex, 'parcel'
  FROM public.mex_parcels p
  WHERE p.history_run IS NULL AND %3$s
  UNION ALL
  SELECT h.phone8, public.customer_origin_parcel_side(h.account, h.tracking_id, h.sender_reference, h.created_at_mex),
         h.created_at_mex, 'parcel'
  FROM public.mex_history_stage h
  WHERE h.phone8 IS NOT NULL AND %4$s
  UNION ALL
  SELECT d.p8, CASE WHEN d.doc_type_id IN ('10111', '10114') THEN 'affiliate' ELSE 'natura' END,
         public.collabbox_sale_at(d.doc_at, d.booked_at), 'doc'
  FROM docs d
  UNION ALL
  SELECT w.phone8, 'web', w.created_at, 'web'
  FROM public.web_orders w
  WHERE w.deleted_in_shop_at IS NULL AND %7$s
)
SELECT t.p8,
       min(t.at) FILTER (WHERE t.side = 'affiliate'),
       (array_agg(t.src ORDER BY t.at) FILTER (WHERE t.side = 'affiliate'))[1],
       min(t.at) FILTER (WHERE t.side = 'natura'),
       (array_agg(t.src ORDER BY t.at) FILTER (WHERE t.side = 'natura'))[1],
       min(t.at) FILTER (WHERE t.side = 'web'),
       (array_agg(t.src ORDER BY t.at) FILTER (WHERE t.side = 'web'))[1]
FROM t
WHERE t.p8 ~ '^[0-9]{8}$' AND t.at IS NOT NULL AND NOT (t.p8 = ANY ($2))
  AND ($1 IS NULL OR t.p8 = ANY ($1))
GROUP BY t.p8
$q$, f_lead, f_order, f_par, f_hist, f_doc, f_km, f_web)
  USING p_phones, public.report_excluded_phone8s();
END;
$fn$;

COMMENT ON FUNCTION public.customer_origin_rows(text[]) IS
  'THE definition of public.customer_origin (20261015120000): per phone (last 8 digits; test phones never), the earliest trace on each side — affiliate / natura / web — and which source gave it, over AlterCPA leads, orders, MEX parcels (live + history stage), collabBox documents and web orders. NULL = every phone; else only the given ones (each source on its index''s own expression). Read-only.';

-- ── the refresh ──────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.customer_origin_refresh(p_full boolean DEFAULT false)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET work_mem TO '128MB'
SET jit TO 'off'
AS $fn$
DECLARE
  v_mark    timestamptz := now();          -- this transaction's start: the next watermark
  v_t0      timestamptz := clock_timestamp();
  v_since   timestamptz;
  v_phones  text[];
  v_n       integer := 0;
  v_rows    integer := 0;
  v_deleted integer := 0;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended('public.customer_origin_refresh', 0)) THEN
    RAISE NOTICE 'customer_origin_refresh: another run holds the lock — skipped';
    RETURN 0;
  END IF;

  SELECT s.watermark INTO v_since FROM public.customer_origin_state s WHERE s.id;
  IF NOT p_full AND v_since IS NULL THEN
    RAISE NOTICE 'customer_origin_refresh: no full fill yet — run customer_origin_refresh(true) first';
    RETURN 0;
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS co_new (
    phone8 text, affiliate_at timestamptz, affiliate_src text, natura_at timestamptz, natura_src text,
    web_at timestamptz, web_src text
  ) ON COMMIT DROP;
  TRUNCATE pg_temp.co_new;

  IF p_full THEN
    -- the MEX history must be there: without it the history's first traces would silently move
    IF (SELECT count(*) FROM public.mex_history_stage) < 450000 THEN
      RAISE EXCEPTION 'customer_origin_refresh: mex_history_stage holds < 450.000 parcels — refusing a full rebuild';
    END IF;
    INSERT INTO pg_temp.co_new SELECT * FROM public.customer_origin_rows(NULL);
  ELSE
    -- every phone touched since the watermark (− 10 minutes for writers that started earlier)
    SELECT array_agg(DISTINCT x.p8) INTO v_phones
    FROM (
      SELECT right(regexp_replace(o.customer_phone, '[^0-9]', '', 'g'), 8) AS p8
        FROM public.orders o WHERE o.updated_at > v_since - interval '10 minutes'
      UNION
      SELECT right(regexp_replace(coalesce(l.phone_e164, l.phone_raw, ''), '[^0-9]', '', 'g'), 8)
        FROM public.altercpa_leads l WHERE l.first_seen_at > v_since - interval '10 minutes'
      UNION
      SELECT p.phone8 FROM public.mex_parcels p WHERE p.first_seen_at > v_since - interval '10 minutes'
      UNION
      SELECT coalesce(CASE WHEN d.phone8 ~ '^[0-9]{8}$' THEN d.phone8 END,
                      (SELECT c.phone8 FROM public.collabbox_customers c
                        WHERE c.komitent_id = d.komitent_id AND c.phone8 ~ '^[0-9]{8}$'
                        ORDER BY (c.source = 'card') DESC LIMIT 1),
                      (SELECT t.phone8 FROM public.teleshop_import_customers t
                        WHERE t.komitent_id = d.komitent_id AND t.phone8 ~ '^[0-9]{8}$'))
        FROM public.collabbox_documents d WHERE d.updated_at > v_since - interval '10 minutes'
      UNION
      SELECT w.phone8 FROM public.web_orders w WHERE w.last_synced_at > v_since - interval '10 minutes'
    ) x
    WHERE x.p8 ~ '^[0-9]{8}$';
    v_phones := coalesce(v_phones, ARRAY[]::text[]);
    IF cardinality(v_phones) > 0 THEN
      INSERT INTO pg_temp.co_new SELECT * FROM public.customer_origin_rows(v_phones);
    END IF;
  END IF;

  SELECT count(*) INTO v_n FROM pg_temp.co_new;

  WITH up AS (
    INSERT INTO public.customer_origin AS co
           (phone8, affiliate_at, affiliate_src, natura_at, natura_src, web_at, web_src, refreshed_at)
    SELECT n.phone8, n.affiliate_at, n.affiliate_src, n.natura_at, n.natura_src, n.web_at, n.web_src, v_mark
    FROM pg_temp.co_new n
    ON CONFLICT (phone8) DO UPDATE
       SET affiliate_at = EXCLUDED.affiliate_at, affiliate_src = EXCLUDED.affiliate_src,
           natura_at    = EXCLUDED.natura_at,    natura_src    = EXCLUDED.natura_src,
           web_at       = EXCLUDED.web_at,       web_src       = EXCLUDED.web_src,
           refreshed_at = EXCLUDED.refreshed_at
     WHERE (co.affiliate_at, co.affiliate_src, co.natura_at, co.natura_src, co.web_at, co.web_src)
           IS DISTINCT FROM
           (EXCLUDED.affiliate_at, EXCLUDED.affiliate_src, EXCLUDED.natura_at, EXCLUDED.natura_src,
            EXCLUDED.web_at, EXCLUDED.web_src)
    RETURNING 1
  )
  SELECT count(*) INTO v_rows FROM up;

  -- a phone with no trace left (full: any; incremental: only the touched ones)
  DELETE FROM public.customer_origin co
   WHERE (p_full OR co.phone8 = ANY (v_phones))
     AND NOT EXISTS (SELECT 1 FROM pg_temp.co_new n WHERE n.phone8 = co.phone8);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  UPDATE public.customer_origin_state s
     SET watermark    = v_mark,
         last_run_at  = clock_timestamp(),
         last_full_at = CASE WHEN p_full THEN clock_timestamp() ELSE s.last_full_at END,
         last_mode    = CASE WHEN p_full THEN 'full' ELSE 'incremental' END,
         last_phones  = CASE WHEN p_full THEN v_n ELSE cardinality(v_phones) END,
         last_rows    = v_rows,
         last_deleted = v_deleted,
         last_ms      = (extract(epoch FROM clock_timestamp() - v_t0) * 1000)::int
   WHERE s.id;

  RETURN v_rows;
END;
$fn$;

COMMENT ON FUNCTION public.customer_origin_refresh(boolean) IS
  'Refreshes public.customer_origin from customer_origin_rows() (20261015120000). p_full = false: exactly the phones touched since the last watermark − 10 min (orders.updated_at, new AlterCPA leads, new MEX parcels, changed collabBox documents, synced web orders) — a no-op until the first full fill; p_full = true: every phone (refuses while mex_history_stage < 450.000), and a phone with no trace left loses its row. Returns the rows inserted or changed. One run at a time. Writes only customer_origin(_state).';

-- The nightly full rebuild: 05:15 Skopje whatever the season (cron fires 03:15 and 04:15 UTC; only
-- the run that lands in the Skopje hour 5 works) — after the collabBox night pass, the 01:10
-- customer departments and the segment recompute, before MEX resumes at 06:00.
CREATE OR REPLACE FUNCTION public.customer_origin_refresh_nightly()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF extract(hour FROM now() AT TIME ZONE 'Europe/Skopje') <> 5 THEN
    RETURN NULL;
  END IF;
  RETURN public.customer_origin_refresh(true);
END;
$fn$;

COMMENT ON FUNCTION public.customer_origin_refresh_nightly() IS
  'pg_cron wrapper (20261015120000): the full customer_origin_refresh(true) at 05:15 Europe/Skopje — returns NULL outside the Skopje hour 5.';

REVOKE ALL ON FUNCTION public.customer_origin_rows(text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.customer_origin_refresh(boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.customer_origin_refresh_nightly() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.customer_origin_rows(text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.customer_origin_refresh(boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.customer_origin_refresh_nightly() TO service_role;
-- the small pure helpers: anyone may call them (they read nothing)
GRANT EXECUTE ON FUNCTION public.customer_origin_parcel_side(text, text, text, timestamptz) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.customer_origin_order_side(text, text, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.customer_origin_at_sale(timestamptz, timestamptz, timestamptz, timestamptz) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.customer_origin_web_first(timestamptz, timestamptz, timestamptz, timestamptz) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.customer_origin_mixed(timestamptz, timestamptz, timestamptz, timestamptz) TO authenticated, service_role;
DO $ro$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    GRANT EXECUTE ON FUNCTION public.customer_origin_rows(text[]) TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.customer_origin_parcel_side(text, text, text, timestamptz) TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.customer_origin_order_side(text, text, text, text) TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.customer_origin_at_sale(timestamptz, timestamptz, timestamptz, timestamptz) TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.customer_origin_web_first(timestamptz, timestamptz, timestamptz, timestamptz) TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.customer_origin_mixed(timestamptz, timestamptz, timestamptz, timestamptz) TO supabase_read_only_user;
  END IF;
END
$ro$;

DO $cron$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job
   WHERE jobname IN ('customer-origin-refresh', 'customer-origin-nightly');
END
$cron$;

SELECT cron.schedule(
  'customer-origin-refresh',
  '9-59/15 * * * *',
  $job$SELECT public.customer_origin_refresh(false);$job$
);

SELECT cron.schedule(
  'customer-origin-nightly',
  '15 3,4 * * *',
  $job$SELECT public.customer_origin_refresh_nightly();$job$
);

COMMIT;

NOTIFY pgrst, 'reload schema';
