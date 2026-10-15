-- ============================================================================
-- WEB page — one key per city (owner 15.10.2026, follow-up of 20261016130000)
-- ============================================================================
-- The shop stores the city as typed: "Skopje" and "Скопје" were two rows. web_page() and
-- web_customers_summary() now fold every spelling through public.mk_city_key() (the Insights key:
-- Latin / Cyrillic, districts into their city), once per distinct spelling. Nothing else changes.
-- Rollback: re-run the two functions from 20261016130000_web_page.sql.
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '10s';

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
        -- one key per place (Skopje / Скопје / districts fold, as in Insights): raw spellings first,
        -- then mk_city_key once per distinct spelling
        SELECT initcap(coalesce(public.mk_city_key(y.city), y.city)) AS city, sum(y.n) AS orders,
               sum(y.v) AS value_mkd, sum(y.rt) AS returned
          FROM (SELECT btrim(city) AS city, count(*) AS n, sum(value_mkd) AS v, sum(ret_n) AS rt
                  FROM w WHERE city IS NOT NULL AND btrim(city) <> '' GROUP BY 1) y
         GROUP BY 1 ORDER BY 2 DESC LIMIT 15) x), '[]'::jsonb),
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
                  SELECT initcap(coalesce(public.mk_city_key(y.city), y.city)) AS city, sum(y.n) AS count
                    FROM (SELECT btrim(city) AS city, count(*) AS n FROM seg
                           WHERE city IS NOT NULL AND btrim(city) <> '' GROUP BY 1) y
                   GROUP BY 1 ORDER BY 2 DESC LIMIT 12) x), '[]'::jsonb),
    'new_by_month', coalesce((SELECT jsonb_agg(x ORDER BY x.m) FROM (
                  SELECT to_char(created_at AT TIME ZONE 'Europe/Skopje', 'YYYY-MM') AS m, count(*) AS count
                    FROM seg WHERE created_at >= now() - interval '13 months' GROUP BY 1) x), '[]'::jsonb),
    'synced_at', (SELECT max(synced_at) FROM public.web_customers))
  INTO _out
  FROM seg;
  RETURN _out;
END;
$fn$;

COMMIT;
