-- ============================================================================
-- Лојалност — the naturatherapy.mk points next to the CRM points (owner
-- 20.10.2026: "да ги додадеме во CRM и поените од ВЕБ, таму во друг таб да си
-- ги пишува поени од ВЕБ, за да може се да биде од едно место").
--
-- The web points are the shop's own balance (Customer.loyaltyBalance), mirrored
-- hourly into web_customers by web-ads-sync (20261016130000). They are SHOWN,
-- never added to the CRM ledger and never written back: loyalty_grants stays the
-- CRM's sure Teleshop Out points only, and the shop keeps its own balance.
--
--   loyalty_web_page(q, page, size)  the "Веб" tab: one row per phone (a profile
--                                    with no phone is its own row), web points,
--                                    the shop's order count, the CRM points of the
--                                    same last-8 phone.
--   loyalty_page                     + web_points per row; "и на продавница" is now
--                                    read live from web_customers (any profile on
--                                    the phone), not the 06.10 snapshot.
--   loyalty_phone                    + web_points / web_profiles; a phone with web
--                                    points only opens too (no CRM grants).
--
-- Personal data: only customers WITH web points reach a browser, and only first
-- name, phone, city, points and order count — never the e-mail, the last name or
-- the address. Owners, admins and managers only (the /loyalty api gate).
-- loyalty_shop_phone is no longer read (kept; scripts/loyalty-mark-shop.mjs is
-- not needed any more).
--
-- Rollback: re-apply loyalty_page / loyalty_phone from 20261006120000 and
--           DROP FUNCTION public.loyalty_web_page(text, integer, integer).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.loyalty_page(p_q text, p_page integer, p_size integer)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_q text := left(btrim(coalesce(p_q, '')), 80);
  v_digits text := regexp_replace(left(btrim(coalesce(p_q, '')), 80), '\D', '', 'g');
  v_plain text := replace(replace(replace(left(btrim(coalesce(p_q, '')), 80), '\', ''), '%', ''), '_', '');
  v_like text := NULL;
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_size integer := least(greatest(coalesce(p_size, 50), 1), 100);
  v_out jsonb;
BEGIN
  -- '%' and '_' are stripped, so an empty or wildcard search cannot become LIKE '%%'.
  IF char_length(v_plain) >= 2 THEN
    v_like := '%' || v_plain || '%';
  END IF;

  WITH web AS (
    SELECT w.phone8,
           count(*)::int AS profiles,
           sum(w.loyalty_balance)::int AS points
      FROM public.web_customers w
     WHERE w.phone8 ~ '^[0-9]{8}$'
     GROUP BY w.phone8
  ),
  summary AS (
    SELECT count(DISTINCT g.phone8)::int AS customers,
           coalesce(sum(g.points), 0)::bigint AS points,
           count(*)::int AS orders,
           (SELECT count(*)::int FROM web
             WHERE EXISTS (SELECT 1 FROM public.loyalty_grants x WHERE x.phone8 = web.phone8)) AS on_shop
      FROM public.loyalty_grants g
  ),
  cust AS (
    SELECT g.phone8,
           sum(g.points)::int AS points,
           count(*)::int AS orders,
           sum(g.nt_mkd)::int AS nt_mkd,
           max(g.sale_day) AS last_day
      FROM public.loyalty_grants g
     WHERE CASE
             WHEN v_like IS NULL AND char_length(v_digits) < 3 THEN true
             ELSE (char_length(v_digits) >= 3 AND g.phone8 LIKE '%' || v_digits || '%')
               OR (v_like IS NOT NULL AND g.display_id ILIKE v_like)
               OR (v_like IS NOT NULL AND EXISTS (
                    SELECT 1 FROM public.orders o
                     WHERE o.id = g.order_id
                       AND o.customer_name ILIKE v_like
                  ))
           END
     GROUP BY g.phone8
  ),
  counted AS (
    SELECT count(*)::int AS total FROM cust
  ),
  paged AS (
    SELECT * FROM cust
     ORDER BY points DESC, last_day DESC, phone8
     OFFSET (v_page - 1) * v_size
     LIMIT v_size
  ),
  named AS (
    SELECT p.phone8, p.points, p.orders, p.nt_mkd, p.last_day,
           o.customer_name AS name,
           o.customer_city AS city,
           o.customer_phone AS phone,
           coalesce(w.profiles, 0)::int AS shop_profiles,
           coalesce(w.points, 0)::int AS web_points
      FROM paged p
      LEFT JOIN LATERAL (
        SELECT o.customer_name, o.customer_city, o.customer_phone
          FROM public.loyalty_grants g
          JOIN public.orders o ON o.id = g.order_id
         WHERE g.phone8 = p.phone8
         ORDER BY g.sale_day DESC, g.created_at DESC
         LIMIT 1
      ) o ON true
      LEFT JOIN web w ON w.phone8 = p.phone8
  )
  SELECT jsonb_build_object(
    'summary', (SELECT jsonb_build_object(
                  'customers', s.customers,
                  'points', s.points,
                  'orders', s.orders,
                  'on_shop', s.on_shop
                ) FROM summary s),
    'q', v_q,
    'page', v_page,
    'size', v_size,
    'total', (SELECT total FROM counted),
    'rows', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'phone8', n.phone8,
               'name', coalesce(n.name, ''),
               'city', coalesce(n.city, ''),
               'phone', coalesce(n.phone, ''),
               'points', n.points,
               'orders', n.orders,
               'nt_mkd', n.nt_mkd,
               'last_day', to_char(n.last_day, 'YYYY-MM-DD'),
               'shop_profiles', n.shop_profiles,
               'web_points', n.web_points
             ) ORDER BY n.points DESC, n.last_day DESC, n.phone8)
        FROM named n
    ), '[]'::jsonb)
  )
  INTO v_out;

  RETURN v_out;
END;
$$;

CREATE OR REPLACE FUNCTION public.loyalty_phone(p_phone8 text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_phone text := btrim(coalesce(p_phone8, ''));
  v_out jsonb;
BEGIN
  IF v_phone !~ '^[0-9]{8}$' THEN
    RETURN NULL;
  END IF;

  WITH g AS (
    SELECT * FROM public.loyalty_grants WHERE phone8 = v_phone
  ),
  w AS (
    SELECT * FROM public.web_customers WHERE phone8 = v_phone
  ),
  head AS (
    SELECT o.customer_name AS name, o.customer_city AS city, o.customer_phone AS phone
      FROM g
      JOIN public.orders o ON o.id = g.order_id
     ORDER BY g.sale_day DESC, g.created_at DESC
     LIMIT 1
  ),
  web_head AS (
    SELECT w.first_name AS name, w.city, w.phone
      FROM w
     ORDER BY w.loyalty_balance DESC, w.updated_at DESC NULLS LAST, w.shop_customer_id
     LIMIT 1
  )
  SELECT jsonb_build_object(
    'phone8', v_phone,
    'name', coalesce((SELECT nullif(name, '') FROM head), (SELECT nullif(name, '') FROM web_head), ''),
    'city', coalesce((SELECT nullif(city, '') FROM head), (SELECT nullif(city, '') FROM web_head), ''),
    'phone', coalesce((SELECT nullif(phone, '') FROM head), (SELECT nullif(phone, '') FROM web_head), ''),
    'points', (SELECT coalesce(sum(points), 0)::int FROM g),
    'orders', (SELECT count(*)::int FROM g),
    'nt_mkd', (SELECT coalesce(sum(nt_mkd), 0)::int FROM g),
    'shop_profiles', (SELECT count(*)::int FROM w),
    'web_points', (SELECT coalesce(sum(loyalty_balance), 0)::int FROM w),
    'web_orders', (SELECT coalesce(sum(orders_count), 0)::int FROM w),
    'web_synced_at', (SELECT max(synced_at) FROM w),
    'grants', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'display_id', display_id,
               'sale_day', to_char(sale_day, 'YYYY-MM-DD'),
               'nt_mkd', nt_mkd,
               'points', points,
               'mex_tracking_id', mex_tracking_id
             ) ORDER BY sale_day DESC, created_at DESC)
        FROM g
    ), '[]'::jsonb)
  )
  INTO v_out
  WHERE EXISTS (SELECT 1 FROM g)
     OR EXISTS (SELECT 1 FROM w WHERE w.loyalty_balance > 0);

  RETURN v_out;
END;
$$;

CREATE OR REPLACE FUNCTION public.loyalty_web_page(p_q text, p_page integer, p_size integer)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_q text := left(btrim(coalesce(p_q, '')), 80);
  v_digits text := regexp_replace(left(btrim(coalesce(p_q, '')), 80), '\D', '', 'g');
  v_plain text := replace(replace(replace(left(btrim(coalesce(p_q, '')), 80), '\', ''), '%', ''), '_', '');
  v_like text := NULL;
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_size integer := least(greatest(coalesce(p_size, 50), 1), 100);
  v_out jsonb;
BEGIN
  IF char_length(v_plain) >= 2 THEN
    v_like := '%' || v_plain || '%';
  END IF;

  WITH src AS (
    SELECT w.*,
           CASE WHEN w.phone8 ~ '^[0-9]{8}$' THEN w.phone8 END AS p8
      FROM public.web_customers w
     WHERE w.loyalty_balance > 0
  ),
  -- One row per phone; a profile with no usable phone stands alone.
  grp AS (
    SELECT coalesce(s.p8, 'id:' || s.shop_customer_id) AS k,
           s.p8 AS phone8,
           sum(s.loyalty_balance)::int AS points,
           sum(s.orders_count)::int AS orders,
           count(*)::int AS profiles,
           (array_agg(s.first_name ORDER BY s.loyalty_balance DESC, s.shop_customer_id)
              FILTER (WHERE coalesce(s.first_name, '') <> ''))[1] AS name,
           (array_agg(s.city ORDER BY s.loyalty_balance DESC, s.shop_customer_id)
              FILTER (WHERE coalesce(s.city, '') <> ''))[1] AS city,
           (array_agg(s.phone ORDER BY s.loyalty_balance DESC, s.shop_customer_id)
              FILTER (WHERE coalesce(s.phone, '') <> ''))[1] AS phone
      FROM src s
     GROUP BY 1, 2
  ),
  crm AS (
    SELECT g.phone8, sum(g.points)::int AS points
      FROM public.loyalty_grants g
     WHERE g.phone8 IN (SELECT phone8 FROM grp WHERE phone8 IS NOT NULL)
     GROUP BY g.phone8
  ),
  rows_all AS (
    SELECT r.*, coalesce(c.points, 0)::int AS crm_points
      FROM grp r
      LEFT JOIN crm c ON c.phone8 = r.phone8
  ),
  summary AS (
    SELECT count(*)::int AS customers,
           coalesce(sum(points), 0)::bigint AS points,
           count(*) FILTER (WHERE crm_points > 0)::int AS with_crm,
           (SELECT max(synced_at) FROM public.web_customers) AS synced_at
      FROM rows_all
  ),
  found AS (
    SELECT * FROM rows_all r
     WHERE CASE
             WHEN v_like IS NULL AND char_length(v_digits) < 3 THEN true
             ELSE (char_length(v_digits) >= 3 AND r.phone8 LIKE '%' || v_digits || '%')
               OR (v_like IS NOT NULL AND (r.name ILIKE v_like OR r.city ILIKE v_like))
           END
  ),
  paged AS (
    SELECT * FROM found
     ORDER BY points DESC, k
     OFFSET (v_page - 1) * v_size
     LIMIT v_size
  )
  SELECT jsonb_build_object(
    'summary', (SELECT jsonb_build_object(
                  'customers', s.customers,
                  'points', s.points,
                  'with_crm', s.with_crm,
                  'synced_at', s.synced_at
                ) FROM summary s),
    'q', v_q,
    'page', v_page,
    'size', v_size,
    'total', (SELECT count(*)::int FROM found),
    'rows', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'key', p.k,
               'phone8', p.phone8,
               'name', coalesce(p.name, ''),
               'city', coalesce(p.city, ''),
               'phone', coalesce(p.phone, ''),
               'points', p.points,
               'orders', p.orders,
               'profiles', p.profiles,
               'crm_points', p.crm_points
             ) ORDER BY p.points DESC, p.k)
        FROM paged p
    ), '[]'::jsonb)
  )
  INTO v_out;

  RETURN v_out;
END;
$$;

REVOKE ALL ON FUNCTION public.loyalty_page(text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.loyalty_phone(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.loyalty_web_page(text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.loyalty_page(text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.loyalty_phone(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.loyalty_web_page(text, integer, integer) TO service_role;

COMMENT ON TABLE public.web_customers IS
  'naturatherapy.mk customers (crm_export.mk_customers, owner-approved 15.10.2026 for the outreach): e-mail, phone, first name, city, orders, spent, marketing flag, has_account, loyalty. Personal data: /web gets counts only; /loyalty (owners, admins, managers — owner 20.10.2026) gets first name, phone, city, points and orders of the customers WITH points, never the e-mail. Written only by web_customers_upsert(). 20261016130000 / 20261020130000.';

NOTIFY pgrst, 'reload schema';
