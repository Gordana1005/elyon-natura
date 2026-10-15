-- ============================================================================
-- WEB — the naturatherapy.mk page (owner 15.10.2026): ad spend, ROAS, customers
-- ============================================================================
-- Owner: "посебен пејџ за ВЕБ … roas, реклами, профити … веб клиенти кои имаат многу emails".
-- Decisions 15.10: a separate Web page (the calculations stay in Insights too — ONE calculation:
-- this page reads the cohort's own rows), the shop's read-only export widened by three functions
-- (crm_export.mk_ad_spend / mk_ad_entities / mk_customers — supabase/shop-side, applied 15.10),
-- e-mail outreach prepared (Brevo later, not active; the owner's lawyer signed off).
--
--   web_ad_spend       the shop's own Meta spend per day × ad (account currency, the NBRM rate the
--                      shop stored, spend_mkd = spend × fx_rate). purpose site | messaging
--   web_ad_entities    Meta campaign / ad names + status
--   web_customers      the shop's customers: e-mail, phone (E.164 + last 8), first name, city, orders,
--                      spent, marketing flag, has_account, loyalty balance — NEVER read by a browser
--   web_feed_runs      one row per feed run of the web-ads-sync function (ads | entities | customers)
--
--   web_ad_spend_replace(from, to, rows)   the writer: replaces the window's rows (Meta revises
--                                          spend for days — the shop re-reads the last 3 days hourly)
--   web_ad_entities_upsert(rows) · web_customers_upsert(rows)
--   web_page(from, to_end)       the page's breakdowns of the COHORT's web rows
--                                (insights_sale_rows source 'web', in_total) — channels, Meta
--                                campaigns with their spend and ROAS, daily, coupons, cities,
--                                products, plus the cancelled / unpaid-card orders apart
--   web_customers_summary()      counts for the outreach segments (no names, no e-mails)
--   invoke_web_ads_sync(body)    pg_cron → the web-ads-sync function (hourly :23, nightly 35 days)
--
-- ROAS here: the sales value of the period's paid-social web orders (the cohort's value: COD where a
-- parcel exists, else the shop total) ÷ the site-purpose Meta spend of the same Skopje days, from
-- app_settings.web_ads.floor_day (the day the shop's ad links began carrying campaign tags,
-- 2026-09-11 — spend before it cannot be tied to orders). "Платено ROAS" uses only what MEX paid.
-- A campaign is matched by the Meta campaign id the order carries (utm_campaign = {{campaign.id}}).
--
-- Tables: RLS on, no policy; the api (service role) reads them and decides who sees what.
-- Rollback: unschedule web-ads-sync / web-ads-sync-nightly, DROP the functions and tables.
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '10s';

-- ── 1. Tables ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.web_ad_spend (
  day            date NOT NULL,
  ad_id          text NOT NULL,
  adset_id       text,
  campaign_id    text NOT NULL,
  account_id     text,
  purpose        text NOT NULL DEFAULT 'site',
  currency       text NOT NULL,
  spend          numeric(12,2) NOT NULL DEFAULT 0,
  fx_rate        numeric(14,6) NOT NULL DEFAULT 1,
  spend_mkd      numeric(14,2) GENERATED ALWAYS AS (round(spend * fx_rate, 2)) STORED,
  impressions    integer NOT NULL DEFAULT 0,
  link_clicks    integer NOT NULL DEFAULT 0,
  meta_purchases integer NOT NULL DEFAULT 0,
  fetched_at     timestamptz,
  synced_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, ad_id)
);
CREATE INDEX IF NOT EXISTS web_ad_spend_campaign_idx ON public.web_ad_spend (campaign_id, day);
COMMENT ON TABLE public.web_ad_spend IS
  'naturatherapy.mk Meta spend per day x ad, mirrored from the shop (crm_export.mk_ad_spend) by web-ads-sync. spend in the ad-account currency, fx_rate = the NBRM rate the shop stored, spend_mkd = denars. Written only by web_ad_spend_replace(). 20261016130000.';

CREATE TABLE IF NOT EXISTS public.web_ad_entities (
  id         text PRIMARY KEY,
  kind       text NOT NULL,
  name       text,
  status     text,
  account_id text,
  fetched_at timestamptz,
  synced_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.web_ad_entities IS
  'Meta campaign / ad names and status (crm_export.mk_ad_entities). Written only by web_ad_entities_upsert(). 20261016130000.';

CREATE TABLE IF NOT EXISTS public.web_customers (
  shop_customer_id integer PRIMARY KEY,
  email            text,
  phone            text,
  phone8           text,
  first_name       text,
  city             text,
  orders_count     integer NOT NULL DEFAULT 0,
  total_spent      numeric(12,2) NOT NULL DEFAULT 0,
  marketing_opt_in boolean NOT NULL DEFAULT false,
  has_account      boolean NOT NULL DEFAULT false,
  loyalty_balance  integer NOT NULL DEFAULT 0,
  created_at       timestamptz,
  updated_at       timestamptz,
  synced_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS web_customers_phone8_idx ON public.web_customers (phone8);
CREATE INDEX IF NOT EXISTS web_customers_email_idx ON public.web_customers (lower(email));
COMMENT ON TABLE public.web_customers IS
  'naturatherapy.mk customers (crm_export.mk_customers, owner-approved 15.10.2026 for the outreach): e-mail, phone, first name, city, orders, spent, marketing flag, has_account, loyalty. Personal data: the api never sends a browser a list of them, only counts. Written only by web_customers_upsert(). 20261016130000.';

CREATE TABLE IF NOT EXISTS public.web_feed_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feed        text NOT NULL CHECK (feed IN ('ads', 'entities', 'customers')),
  status      text NOT NULL CHECK (status IN ('running', 'ok', 'partial', 'failed')),
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  rows_read   integer NOT NULL DEFAULT 0,
  rows_written integer NOT NULL DEFAULT 0,
  window_from date,
  window_to   date,
  cursor_ts   timestamptz,
  cursor_id   integer,
  error       text,
  stats       jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS web_feed_runs_feed_idx ON public.web_feed_runs (feed, started_at DESC);

ALTER TABLE public.web_ad_spend    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.web_ad_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.web_customers   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.web_feed_runs   ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.web_ad_spend, public.web_ad_entities, public.web_customers, public.web_feed_runs
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.web_ad_spend, public.web_ad_entities, public.web_customers TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.web_feed_runs TO service_role;

INSERT INTO public.app_settings (key, value)
VALUES ('web_ads', jsonb_build_object(
  'floor_day', '2026-09-11',
  'note', 'Spend counts toward ROAS from floor_day — the day the shop''s ad links began carrying campaign tags (storefront docs/traffic-attribution.md). 20261016130000.'))
ON CONFLICT (key) DO NOTHING;

-- ── 2. Writers (service role; web-ads-sync) ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.web_ad_spend_replace(p_from date, p_to date, p_rows jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _del int;
  _ins int;
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 62 THEN
    RAISE EXCEPTION 'web_ad_spend_replace: bad window (at most 63 days per call)' USING ERRCODE = '22023';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'web_ad_spend_replace: rows must be an array' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_rows) r
              WHERE (r ->> 'day')::date NOT BETWEEN p_from AND p_to) THEN
    RAISE EXCEPTION 'web_ad_spend_replace: a row outside the window' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('elyon.web_ad_spend'));
  DELETE FROM public.web_ad_spend WHERE day BETWEEN p_from AND p_to;
  GET DIAGNOSTICS _del = ROW_COUNT;
  INSERT INTO public.web_ad_spend (day, ad_id, adset_id, campaign_id, account_id, purpose, currency, spend, fx_rate,
                                   impressions, link_clicks, meta_purchases, fetched_at, synced_at)
  SELECT (r ->> 'day')::date, r ->> 'ad_id', r ->> 'adset_id', r ->> 'campaign_id', r ->> 'account_id',
         coalesce(r ->> 'purpose', 'site'), coalesce(r ->> 'currency', 'MKD'),
         coalesce((r ->> 'spend')::numeric, 0), coalesce((r ->> 'fx_rate')::numeric, 1),
         coalesce((r ->> 'impressions')::int, 0), coalesce((r ->> 'link_clicks')::int, 0),
         coalesce((r ->> 'meta_purchases')::int, 0), (r ->> 'fetched_at')::timestamptz, now()
    FROM jsonb_array_elements(p_rows) r
   WHERE r ->> 'ad_id' IS NOT NULL AND r ->> 'campaign_id' IS NOT NULL
  ON CONFLICT (day, ad_id) DO UPDATE
    SET adset_id = EXCLUDED.adset_id, campaign_id = EXCLUDED.campaign_id, account_id = EXCLUDED.account_id,
        purpose = EXCLUDED.purpose, currency = EXCLUDED.currency, spend = EXCLUDED.spend, fx_rate = EXCLUDED.fx_rate,
        impressions = EXCLUDED.impressions, link_clicks = EXCLUDED.link_clicks,
        meta_purchases = EXCLUDED.meta_purchases, fetched_at = EXCLUDED.fetched_at, synced_at = now();
  GET DIAGNOSTICS _ins = ROW_COUNT;
  RETURN jsonb_build_object('deleted', _del, 'written', _ins);
END;
$$;

CREATE OR REPLACE FUNCTION public.web_ad_entities_upsert(p_rows jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _n int;
BEGIN
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'web_ad_entities_upsert: rows must be an array' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.web_ad_entities (id, kind, name, status, account_id, fetched_at, synced_at)
  SELECT r ->> 'id', coalesce(r ->> 'kind', 'campaign'), r ->> 'name', r ->> 'status', r ->> 'account_id',
         (r ->> 'fetched_at')::timestamptz, now()
    FROM jsonb_array_elements(p_rows) r
   WHERE r ->> 'id' IS NOT NULL
  ON CONFLICT (id) DO UPDATE
    SET kind = EXCLUDED.kind, name = coalesce(EXCLUDED.name, web_ad_entities.name), status = EXCLUDED.status,
        account_id = EXCLUDED.account_id, fetched_at = EXCLUDED.fetched_at, synced_at = now();
  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN jsonb_build_object('written', _n);
END;
$$;

-- Monotonic on updated_at: an older read never overwrites a newer row.
CREATE OR REPLACE FUNCTION public.web_customers_upsert(p_rows jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _n int;
BEGIN
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'web_customers_upsert: rows must be an array' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_rows) > 5000 THEN
    RAISE EXCEPTION 'web_customers_upsert: at most 5000 rows per call' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.web_customers AS c (shop_customer_id, email, phone, phone8, first_name, city, orders_count,
                                         total_spent, marketing_opt_in, has_account, loyalty_balance,
                                         created_at, updated_at, synced_at)
  SELECT (r ->> 'shop_customer_id')::int,
         nullif(lower(btrim(r ->> 'email')), ''),
         public.web_phone_e164(r ->> 'phone'),
         public.web_phone8(r ->> 'phone'),
         nullif(btrim(r ->> 'first_name'), ''),
         nullif(btrim(r ->> 'city'), ''),
         coalesce((r ->> 'orders_count')::int, 0),
         coalesce((r ->> 'total_spent')::numeric, 0),
         coalesce((r ->> 'marketing_opt_in')::boolean, false),
         coalesce((r ->> 'has_account')::boolean, false),
         coalesce((r ->> 'loyalty_balance')::int, 0),
         (r ->> 'created_at')::timestamptz, (r ->> 'updated_at')::timestamptz, now()
    FROM jsonb_array_elements(p_rows) r
   WHERE r ->> 'shop_customer_id' IS NOT NULL
  ON CONFLICT (shop_customer_id) DO UPDATE
    SET email = EXCLUDED.email, phone = EXCLUDED.phone, phone8 = EXCLUDED.phone8,
        first_name = EXCLUDED.first_name, city = EXCLUDED.city, orders_count = EXCLUDED.orders_count,
        total_spent = EXCLUDED.total_spent, marketing_opt_in = EXCLUDED.marketing_opt_in,
        has_account = EXCLUDED.has_account, loyalty_balance = EXCLUDED.loyalty_balance,
        created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at, synced_at = now()
    WHERE c.updated_at IS NULL OR EXCLUDED.updated_at >= c.updated_at;
  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN jsonb_build_object('written', _n);
END;
$$;

-- ── 3. The page ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.web_page(p_from timestamptz, p_to_end timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET "TimeZone" = 'UTC'
SET work_mem = '64MB'
SET jit = 'off'
AS $fn$
DECLARE
  _floor date := coalesce((SELECT nullif(value ->> 'floor_day', '')::date FROM public.app_settings WHERE key = 'web_ads'),
                          '2026-09-11'::date);
  _fd    date;
  _td    date;
  _sf    date;
  _out   jsonb;
BEGIN
  IF p_from IS NULL OR p_to_end IS NULL OR p_to_end <= p_from OR p_to_end - p_from > interval '400 days' THEN
    RAISE EXCEPTION 'web_page: bad window (at most 400 days)' USING ERRCODE = '22023';
  END IF;
  _fd := (p_from AT TIME ZONE 'Europe/Skopje')::date;
  _td := ((p_to_end - interval '1 microsecond') AT TIME ZONE 'Europe/Skopje')::date;
  _sf := greatest(_fd, _floor);

  WITH
  r AS MATERIALIZED (       -- THE cohort's web rows (one calculation with Insights / Табла / TV)
    SELECT s.web_id, s.bucket, coalesce(s.value_mkd, 0) AS value_mkd, s.sale_day
      FROM public.insights_sale_rows(p_from, p_to_end, false) s
     WHERE s.source = 'web' AND s.in_total
  ),
  w AS MATERIALIZED (
    SELECT r.*, o.channel, o.traffic_source, o.campaign, o.discount_code, o.city, o.payment_method,
           (r.bucket IN ('paid', 'paid_legacy', 'paid_unproven'))::int AS paid_n,
           CASE WHEN r.bucket IN ('paid', 'paid_legacy', 'paid_unproven') THEN r.value_mkd ELSE 0 END AS paid_mkd,
           (r.bucket = 'returned')::int AS ret_n,
           CASE WHEN r.bucket = 'returned' THEN r.value_mkd ELSE 0 END AS ret_mkd
      FROM r LEFT JOIN public.web_orders o ON o.shop_order_id = r.web_id
  ),
  sp AS MATERIALIZED (      -- Meta spend of the window's Skopje days, from the floor
    SELECT s.* FROM public.web_ad_spend s WHERE s.day BETWEEN _sf AND _td
  ),
  camp AS (
    SELECT w.campaign AS k, count(*) AS n, sum(w.value_mkd) AS v, sum(w.paid_n) AS pn, sum(w.paid_mkd) AS pv,
           sum(w.ret_n) AS rn, sum(w.ret_mkd) AS rv
      FROM w WHERE w.channel = 'paid_social' AND w.campaign IS NOT NULL GROUP BY 1
  ),
  cs AS (
    SELECT s.campaign_id AS k,
           sum(s.spend_mkd) FILTER (WHERE s.purpose = 'site') AS spend,
           sum(s.spend_mkd) FILTER (WHERE s.purpose <> 'site') AS spend_other,
           sum(s.impressions) AS imp, sum(s.link_clicks) AS clicks, sum(s.meta_purchases) AS mp
      FROM sp s GROUP BY 1
  ),
  cj AS (
    SELECT coalesce(c.k, s.k) AS k, e.name, e.status,
           coalesce(c.n, 0) AS n, coalesce(c.v, 0) AS v, coalesce(c.pn, 0) AS pn, coalesce(c.pv, 0) AS pv,
           coalesce(c.rn, 0) AS rn, coalesce(c.rv, 0) AS rv,
           coalesce(s.spend, 0) AS spend, coalesce(s.spend_other, 0) AS spend_other,
           coalesce(s.imp, 0) AS imp, coalesce(s.clicks, 0) AS clicks, coalesce(s.mp, 0) AS mp
      FROM camp c FULL JOIN cs s ON s.k = c.k
      LEFT JOIN public.web_ad_entities e ON e.id = coalesce(c.k, s.k)
  ),
  days AS (
    SELECT g.d::date AS d FROM generate_series(_fd, _td, interval '1 day') g(d)
  ),
  dw AS (
    SELECT w.sale_day AS d, count(*) AS n, sum(w.value_mkd) AS v,
           sum(w.value_mkd) FILTER (WHERE w.channel = 'paid_social') AS ps
      FROM w GROUP BY 1
  ),
  ds AS (
    SELECT s.day AS d, sum(s.spend_mkd) FILTER (WHERE s.purpose = 'site') AS spend FROM sp s GROUP BY 1
  ),
  items AS (
    SELECT coalesce(nullif(btrim(i.name), ''), '?') AS name, sum(i.quantity) AS qty,
           sum(i.price * i.quantity - coalesce(i.discount_allocated, 0)) AS v, count(DISTINCT i.shop_order_id) AS orders
      FROM public.web_order_items i
      JOIN (SELECT DISTINCT web_id FROM w WHERE web_id IS NOT NULL) x ON x.web_id = i.shop_order_id
     WHERE coalesce(i.kind, 'SALE') <> 'GIFT'
     GROUP BY 1
  ),
  lost AS (                 -- outside the cohort, shown apart: cancelled / failed card checkouts
    SELECT public.web_order_outcome(o.status, o.payment_status, o.payment_method) AS k, count(*) AS n,
           sum(o.total) AS v
      FROM public.web_orders o
     WHERE o.created_at >= p_from AND o.created_at < p_to_end AND o.deleted_in_shop_at IS NULL
       AND public.web_order_outcome(o.status, o.payment_status, o.payment_method) IN ('cancelled', 'card_unpaid')
     GROUP BY 1
  )
  SELECT jsonb_build_object(
    'from', _fd, 'to', _td, 'spend_from', _sf, 'floor_day', _floor,
    'total', (SELECT jsonb_build_object('orders', count(*), 'value_mkd', coalesce(sum(value_mkd), 0),
                                        'paid', coalesce(sum(paid_n), 0), 'paid_mkd', coalesce(sum(paid_mkd), 0),
                                        'returned', coalesce(sum(ret_n), 0), 'returned_mkd', coalesce(sum(ret_mkd), 0),
                                        'no_order', count(*) FILTER (WHERE web_id IS NULL))
                FROM w),
    'channels', coalesce((SELECT jsonb_agg(x ORDER BY x.value_mkd DESC) FROM (
        SELECT CASE WHEN web_id IS NULL THEN 'mex_only' ELSE coalesce(channel, 'unknown') END AS channel,
               coalesce(traffic_source, '') AS source,
               count(*) AS orders, sum(value_mkd) AS value_mkd, sum(paid_n) AS paid, sum(paid_mkd) AS paid_mkd,
               sum(ret_n) AS returned, sum(ret_mkd) AS returned_mkd
          FROM w GROUP BY 1, 2) x), '[]'::jsonb),
    'ads', (SELECT jsonb_build_object(
               'spend_mkd', coalesce(sum(spend_mkd) FILTER (WHERE purpose = 'site'), 0),
               'spend_other_mkd', coalesce(sum(spend_mkd) FILTER (WHERE purpose <> 'site'), 0),
               'impressions', coalesce(sum(impressions) FILTER (WHERE purpose = 'site'), 0),
               'link_clicks', coalesce(sum(link_clicks) FILTER (WHERE purpose = 'site'), 0),
               'meta_purchases', coalesce(sum(meta_purchases) FILTER (WHERE purpose = 'site'), 0),
               'currency', min(currency),
               'synced_at', (SELECT max(synced_at) FROM public.web_ad_spend))
              FROM sp),
    'paid_social', (SELECT jsonb_build_object('orders', count(*), 'value_mkd', coalesce(sum(value_mkd), 0),
                                              'paid', coalesce(sum(paid_n), 0), 'paid_mkd', coalesce(sum(paid_mkd), 0),
                                              'returned', coalesce(sum(ret_n), 0), 'returned_mkd', coalesce(sum(ret_mkd), 0),
                                              'no_campaign', count(*) FILTER (WHERE campaign IS NULL))
                      FROM w WHERE channel = 'paid_social'),
    'campaigns', coalesce((SELECT jsonb_agg(jsonb_build_object(
                    'id', k, 'name', name, 'status', status, 'orders', n, 'value_mkd', v, 'paid', pn, 'paid_mkd', pv,
                    'returned', rn, 'returned_mkd', rv, 'spend_mkd', spend, 'spend_other_mkd', spend_other,
                    'impressions', imp, 'link_clicks', clicks, 'meta_purchases', mp)
                  ORDER BY spend DESC, v DESC) FROM cj WHERE n > 0 OR spend > 0), '[]'::jsonb),
    'daily', coalesce((SELECT jsonb_agg(jsonb_build_object('d', d.d, 'orders', coalesce(dw.n, 0), 'value_mkd', coalesce(dw.v, 0),
                                                         'paid_social_mkd', coalesce(dw.ps, 0), 'spend_mkd', coalesce(ds.spend, 0))
                                        ORDER BY d.d)
                         FROM days d LEFT JOIN dw ON dw.d = d.d LEFT JOIN ds ON ds.d = d.d), '[]'::jsonb),
    'coupons', coalesce((SELECT jsonb_agg(x ORDER BY x.orders DESC, x.value_mkd DESC) FROM (
        SELECT upper(discount_code) AS code, count(*) AS orders, sum(value_mkd) AS value_mkd
          FROM w WHERE discount_code IS NOT NULL AND btrim(discount_code) <> '' GROUP BY 1
          ORDER BY 2 DESC, 3 DESC LIMIT 15) x), '[]'::jsonb),
    'cities', coalesce((SELECT jsonb_agg(x ORDER BY x.orders DESC) FROM (
        SELECT initcap(lower(btrim(city))) AS city, count(*) AS orders, sum(value_mkd) AS value_mkd,
               sum(ret_n) AS returned
          FROM w WHERE city IS NOT NULL AND btrim(city) <> '' GROUP BY 1 ORDER BY 2 DESC LIMIT 15) x), '[]'::jsonb),
    'payment', coalesce((SELECT jsonb_agg(x ORDER BY x.orders DESC) FROM (
        SELECT coalesce(payment_method, 'unknown') AS method, count(*) AS orders, sum(value_mkd) AS value_mkd,
               sum(ret_n) AS returned
          FROM w WHERE web_id IS NOT NULL GROUP BY 1) x), '[]'::jsonb),
    'products', coalesce((SELECT jsonb_agg(x ORDER BY x.value_mkd DESC) FROM (
        SELECT name, qty, round(v, 2) AS value_mkd, orders FROM items ORDER BY v DESC LIMIT 20) x), '[]'::jsonb),
    'lost', coalesce((SELECT jsonb_object_agg(k, jsonb_build_object('orders', n, 'value_mkd', v)) FROM lost), '{}'::jsonb))
  INTO _out;
  RETURN _out;
END;
$fn$;
COMMENT ON FUNCTION public.web_page(timestamptz, timestamptz) IS
  'GET /api/web/page: the Web page''s breakdowns of the cohort''s web rows (insights_sale_rows source web, in_total — the same rows as Insights): channels, Meta campaigns with spend / ROAS inputs, daily, coupons, cities, payment, products, and the cancelled / unpaid-card orders apart. 20261016130000.';

-- Counts for the outreach segments — never a name or an e-mail. Last purchase = the newest of the
-- person's web orders and CRM sales (confirmed / shipped / paid) on the same last-8 phone.
CREATE OR REPLACE FUNCTION public.web_customers_summary()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET "TimeZone" = 'UTC'
SET work_mem = '64MB'
SET jit = 'off'
AS $fn$
DECLARE
  _out jsonb;
BEGIN
  WITH
  lw AS (SELECT o.phone8, max(o.created_at) AS at FROM public.web_orders o
          WHERE o.phone8 IS NOT NULL AND o.deleted_in_shop_at IS NULL
            AND public.web_order_outcome(o.status, o.payment_status, o.payment_method) NOT IN ('cancelled', 'card_unpaid')
          GROUP BY 1),
  c AS MATERIALIZED (
    SELECT wc.*, greatest(lw.at, (
             SELECT max(x.created_at) FROM public.orders x
              WHERE wc.phone8 IS NOT NULL
                AND right(regexp_replace(x.customer_phone, '[^0-9]', '', 'g'), 8) = wc.phone8
                AND x.status::text IN ('confirmed', 'shipped', 'paid'))) AS last_at
      FROM public.web_customers wc
      LEFT JOIN lw ON lw.phone8 = wc.phone8
  ),
  seg AS (
    SELECT c.*,
           CASE WHEN c.last_at IS NULL THEN 'never'
                WHEN c.last_at >= now() - interval '21 days' THEN 'd0_20'
                WHEN c.last_at >= now() - interval '58 days' THEN 'd21_57'
                WHEN c.last_at >= now() - interval '121 days' THEN 'd58_120'
                WHEN c.last_at >= now() - interval '366 days' THEN 'd121_365'
                ELSE 'd365_plus' END AS recency
      FROM c
  )
  SELECT jsonb_build_object(
    'total', count(*),
    'with_email', count(*) FILTER (WHERE email IS NOT NULL),
    'with_phone', count(*) FILTER (WHERE phone8 IS NOT NULL),
    'opted_in', count(*) FILTER (WHERE marketing_opt_in),
    'with_account', count(*) FILTER (WHERE has_account),
    'repeat', count(*) FILTER (WHERE orders_count >= 2),
    'with_points', count(*) FILTER (WHERE loyalty_balance > 0),
    'points_total', coalesce(sum(loyalty_balance), 0),
    'recency', (SELECT jsonb_object_agg(k, jsonb_build_object('count', n, 'with_email', e)) FROM (
                  SELECT recency AS k, count(*) AS n, count(*) FILTER (WHERE email IS NOT NULL) AS e
                    FROM seg GROUP BY 1) x),
    'cities', coalesce((SELECT jsonb_agg(x ORDER BY x.count DESC) FROM (
                  SELECT initcap(lower(btrim(city))) AS city, count(*) AS count
                    FROM seg WHERE city IS NOT NULL AND btrim(city) <> '' GROUP BY 1 ORDER BY 2 DESC LIMIT 12) x), '[]'::jsonb),
    'new_by_month', coalesce((SELECT jsonb_agg(x ORDER BY x.m) FROM (
                  SELECT to_char(created_at AT TIME ZONE 'Europe/Skopje', 'YYYY-MM') AS m, count(*) AS count
                    FROM seg WHERE created_at >= now() - interval '13 months' GROUP BY 1) x), '[]'::jsonb),
    'synced_at', (SELECT max(synced_at) FROM public.web_customers))
  INTO _out
  FROM seg;
  RETURN _out;
END;
$fn$;
COMMENT ON FUNCTION public.web_customers_summary() IS
  'GET /api/web/customers: counts of the shop''s customers for the outreach segments (recency of the last purchase anywhere — web or CRM sale on the same last-8 phone), e-mail / opt-in / account / loyalty. No names, no e-mails. 20261016130000.';

-- ── 4. The scheduler (pg_cron → web-ads-sync; the shared web_sync_secret in Vault) ──
CREATE OR REPLACE FUNCTION public.invoke_web_ads_sync(_body jsonb DEFAULT '{}'::jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  _secret text;
BEGIN
  SELECT decrypted_secret INTO _secret FROM vault.decrypted_secrets WHERE name = 'web_sync_secret';
  IF _secret IS NULL THEN RETURN; END IF;
  -- MACEDONIA. This URL must always be THIS project (oufoazmnbwugtfldkwsn since 03.10.2026).
  PERFORM net.http_post(
    url := 'https://oufoazmnbwugtfldkwsn.supabase.co/functions/v1/web-ads-sync',
    headers := jsonb_build_object('x-web-sync-secret', _secret, 'Content-Type', 'application/json'),
    body := coalesce(_body, '{}'::jsonb),
    timeout_milliseconds := 300000);
EXCEPTION WHEN OTHERS THEN
  RETURN;
END;
$fn$;

DO $cron$
DECLARE
  _job text;
BEGIN
  FOREACH _job IN ARRAY ARRAY['web-ads-sync', 'web-ads-sync-nightly'] LOOP
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = _job) THEN PERFORM cron.unschedule(_job); END IF;
  END LOOP;
END
$cron$;
-- hourly (the shop re-reads Meta hourly: last 3 days); nightly 02:41 UTC the last 35 days (Meta revises)
SELECT cron.schedule('web-ads-sync', '23 * * * *', $job$SELECT public.invoke_web_ads_sync('{"days": 4}'::jsonb);$job$);
SELECT cron.schedule('web-ads-sync-nightly', '41 2 * * *', $job$SELECT public.invoke_web_ads_sync('{"days": 35}'::jsonb);$job$);

-- ── 5. Grants ───────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.web_ad_spend_replace(date, date, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.web_ad_entities_upsert(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.web_customers_upsert(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.web_page(timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.web_customers_summary() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.invoke_web_ads_sync(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.web_ad_spend_replace(date, date, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.web_ad_entities_upsert(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.web_customers_upsert(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.web_page(timestamptz, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.web_customers_summary() TO service_role;

DO $g$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    EXECUTE 'GRANT SELECT ON public.web_ad_spend, public.web_ad_entities, public.web_feed_runs TO supabase_read_only_user';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.web_page(timestamptz, timestamptz), public.web_customers_summary() TO supabase_read_only_user';
  END IF;
END
$g$;

-- ── 6. Module: the page (the api decides who sees what: revenue viewers the page, margin
-- viewers the spend / ROAS / profit) ─────────────────────────────────────────
INSERT INTO public.module_settings (module_key, module_label, is_enabled, is_protected) VALUES
  ('web', 'Web shop', true, false)
ON CONFLICT (module_key) DO NOTHING;
INSERT INTO public.role_permissions (role, module_key, can_view, can_create, can_edit, can_delete, can_export) VALUES
  ('admin',   'web', true, true, true, true, true),
  ('manager', 'web', true, false, false, false, true)
ON CONFLICT (role, module_key) DO NOTHING;

COMMIT;
