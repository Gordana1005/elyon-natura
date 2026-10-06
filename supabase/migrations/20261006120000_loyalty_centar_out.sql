-- ============================================================================
-- Лојалност — sure points for Тим Центар Out (owner 06.10.2026).
--
-- One new ledger. Nothing in orders, products, customers or the shop is updated.
-- A customer's points are the SUM of their rows, never a stored balance.
--
-- A row is sure only when ALL of these hold:
--   sale day (Skopje) from 2026-01-01 through today
--   MEX status 2 (Delivered) and the order is paid
--   department teleshop_out — the 4-arg cohort_order_source, team override included
--   a non-blank MEX tracking id and an 8-digit phone
--   not a test phone (is_report_excluded_phone)
--   NaturaTherapy line totals only, EUR × 61.5 rounded once per shipment
--   brand = products.brand_line, or — only when that is blank — an exact unique
--   catalogue name (loyalty_name_key). A longer name is NOT a match. Gifts,
--   delivery, Bio Natural, Dr.Becker, Ad Astra and anything still unnamed stay out.
--   the ladder: under 600 ден = 0 (no row), 600 = 65, 1200 = 100, 1800 = 150,
--   2000 = 200, 2400 = 350
--
-- Re-running the catch-up inserts what is newly sure, corrects a row whose
-- NaturaTherapy total changed, and removes a row whose parcel is no longer
-- delivered (MEX 7 and the rest). The 4.5M–8M / 20k–40k band is the FIRST load
-- only — it is not inside the hourly job, or a later year could never grow.
--
-- loyalty_shop_phone is filled by scripts/loyalty-mark-shop.mjs (the shop book
-- is another database). A cron cannot see it. Points are never copied to the shop.
--
-- Rollback: SELECT public.loyalty_grants_undo('mk-crm-centar-out-2026');
--           then drop the cron, the functions and the two tables.
-- ============================================================================

CREATE TABLE public.loyalty_grants (
  order_id uuid PRIMARY KEY REFERENCES public.orders(id) ON DELETE RESTRICT,
  phone8 text NOT NULL CHECK (phone8 ~ '^[0-9]{8}$'),
  display_id text,
  sale_day date NOT NULL,
  mex_tracking_id text NOT NULL CHECK (btrim(mex_tracking_id) <> ''),
  nt_mkd integer NOT NULL CHECK (nt_mkd >= 600),
  points integer NOT NULL CHECK (points IN (65, 100, 150, 200, 350)),
  batch text NOT NULL DEFAULT 'mk-crm-centar-out-2026',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX loyalty_grants_phone8_idx ON public.loyalty_grants (phone8);

COMMENT ON TABLE public.loyalty_grants IS
  'Sure loyalty points, one row per delivered Тим Центар Out shipment. Sum by phone8. Deny-all — the api reads loyalty_page / loyalty_phone.';

-- Phones that also have a naturatherapy.mk profile. A badge, not a second balance.
CREATE TABLE public.loyalty_shop_phone (
  phone8 text PRIMARY KEY CHECK (phone8 ~ '^[0-9]{8}$'),
  shop_profiles integer NOT NULL CHECK (shop_profiles > 0),
  noted_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.loyalty_shop_phone IS
  'Snapshot of shop profiles (tenant 2, last 8 digits) that also have a loyalty grant. Written only by scripts/loyalty-mark-shop.mjs.';

DROP TRIGGER IF EXISTS update_loyalty_grants_updated_at ON public.loyalty_grants;
CREATE TRIGGER update_loyalty_grants_updated_at
  BEFORE UPDATE ON public.loyalty_grants
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.loyalty_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loyalty_shop_phone ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.loyalty_grants FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.loyalty_shop_phone FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.loyalty_grants TO service_role;
GRANT ALL ON public.loyalty_shop_phone TO service_role;

-- Space, dot, hyphen, underscore, plus, slash and apostrophe are not part of a name.
-- chr(39) is the apostrophe, so the literal does not depend on quote-doubling.
CREATE OR REPLACE FUNCTION public.loyalty_name_key(p_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
  SELECT lower(translate(coalesce(p_name, ''), ' .-_+/' || chr(39), ''));
$$;

CREATE OR REPLACE FUNCTION public.loyalty_sure_centar_out()
RETURNS TABLE (
  order_id uuid,
  display_id text,
  phone8 text,
  sale_day date,
  mex_tracking_id text,
  nt_mkd integer,
  points integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH win AS MATERIALIZED (
    SELECT o.id,
           nullif(btrim(o.display_id), '') AS display_id,
           btrim(o.mex_tracking_id) AS mex_tracking_id,
           right(regexp_replace(coalesce(o.customer_phone, ''), '\D', '', 'g'), 8) AS phone8,
           (coalesce(o.sold_at, o.confirmed_at, o.created_at) AT TIME ZONE 'Europe/Skopje')::date AS sale_day
      FROM public.orders o
     WHERE coalesce(o.sold_at, o.confirmed_at, o.created_at) >= TIMESTAMPTZ '2025-12-31 22:00:00+00'
       AND o.mex_status_id = 2
       AND o.status = 'paid'
       AND btrim(coalesce(o.mex_tracking_id, '')) <> ''
       AND NOT public.is_report_excluded_phone(o.customer_phone)
       AND public.cohort_order_source(o.sale_source, o.sale_source_detail, o.mex_tracking_id, o.dept_override) = 'teleshop_out'
  ),
  scoped AS MATERIALIZED (
    SELECT * FROM win
     WHERE sale_day >= DATE '2026-01-01'
       AND sale_day <= (now() AT TIME ZONE 'Europe/Skopje')::date
  ),
  name_map AS MATERIALIZED (
    SELECT public.loyalty_name_key(p.name) AS k,
           min(p.brand_line) AS brand_line
      FROM public.products p
     WHERE p.brand_line IS NOT NULL
       AND public.loyalty_name_key(p.name) <> ''
     GROUP BY 1
    HAVING count(DISTINCT p.brand_line) = 1
  ),
  lines AS MATERIALIZED (
    SELECT s.id,
           coalesce(oi.total_price, 0) AS eur,
           coalesce(p.kind, '') AS kind,
           CASE
             WHEN coalesce(p.brand_line, '') <> '' THEN p.brand_line
             WHEN nm.brand_line IS NOT NULL THEN nm.brand_line
             ELSE ''
           END AS brand_line
      FROM scoped s
      JOIN public.order_items oi ON oi.order_id = s.id
      LEFT JOIN public.products p ON p.id = oi.product_id
      LEFT JOIN name_map nm
        ON nm.k = public.loyalty_name_key(coalesce(nullif(oi.product_name, ''), p.name, ''))
  ),
  per AS MATERIALIZED (
    SELECT s.id, s.display_id, s.phone8, s.mex_tracking_id, s.sale_day,
           coalesce(round(sum(l.eur) FILTER (
             WHERE l.brand_line = 'natura_therapy' AND l.kind IS DISTINCT FROM 'gift'
           ) * 61.5), 0)::int AS nt_mkd
      FROM scoped s
      LEFT JOIN lines l ON l.id = s.id
     GROUP BY s.id, s.display_id, s.phone8, s.mex_tracking_id, s.sale_day
  )
  SELECT p.id, p.display_id, p.phone8, p.sale_day, p.mex_tracking_id, p.nt_mkd,
         CASE
           WHEN p.nt_mkd >= 2400 THEN 350
           WHEN p.nt_mkd >= 2000 THEN 200
           WHEN p.nt_mkd >= 1800 THEN 150
           WHEN p.nt_mkd >= 1200 THEN 100
           WHEN p.nt_mkd >= 600 THEN 65
           ELSE 0
         END AS points
    FROM per p
   WHERE p.nt_mkd >= 600
     AND p.phone8 ~ '^[0-9]{8}$';
$$;

CREATE OR REPLACE FUNCTION public.loyalty_catchup()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ins integer := 0;
  v_upd integer := 0;
  v_del integer := 0;
BEGIN
  DROP TABLE IF EXISTS pg_temp._loyalty_sure;
  CREATE TEMP TABLE _loyalty_sure ON COMMIT DROP AS
    SELECT * FROM public.loyalty_sure_centar_out();

  INSERT INTO public.loyalty_grants (
    order_id, phone8, display_id, sale_day, mex_tracking_id, nt_mkd, points, batch
  )
  SELECT s.order_id, s.phone8, s.display_id, s.sale_day, s.mex_tracking_id, s.nt_mkd, s.points,
         'mk-crm-centar-out-2026'
    FROM _loyalty_sure s
  ON CONFLICT (order_id) DO NOTHING;
  GET DIAGNOSTICS v_ins = ROW_COUNT;

  UPDATE public.loyalty_grants g
     SET phone8 = s.phone8,
         display_id = s.display_id,
         sale_day = s.sale_day,
         mex_tracking_id = s.mex_tracking_id,
         nt_mkd = s.nt_mkd,
         points = s.points
    FROM _loyalty_sure s
   WHERE g.order_id = s.order_id
     AND g.batch = 'mk-crm-centar-out-2026'
     AND (g.phone8, g.display_id, g.sale_day, g.mex_tracking_id, g.nt_mkd, g.points)
         IS DISTINCT FROM
         (s.phone8, s.display_id, s.sale_day, s.mex_tracking_id, s.nt_mkd, s.points);
  GET DIAGNOSTICS v_upd = ROW_COUNT;

  -- A parcel that is no longer delivered (or left the department) loses the points.
  DELETE FROM public.loyalty_grants g
   WHERE g.batch = 'mk-crm-centar-out-2026'
     AND NOT EXISTS (SELECT 1 FROM _loyalty_sure s WHERE s.order_id = g.order_id);
  GET DIAGNOSTICS v_del = ROW_COUNT;

  RETURN jsonb_build_object('inserted', v_ins, 'updated', v_upd, 'removed', v_del);
END;
$$;

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

  WITH summary AS (
    SELECT count(DISTINCT phone8)::int AS customers,
           coalesce(sum(points), 0)::bigint AS points,
           count(*)::int AS orders,
           (SELECT count(*)::int FROM public.loyalty_shop_phone) AS on_shop
      FROM public.loyalty_grants
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
           coalesce(sp.shop_profiles, 0)::int AS shop_profiles
      FROM paged p
      LEFT JOIN LATERAL (
        SELECT o.customer_name, o.customer_city, o.customer_phone
          FROM public.loyalty_grants g
          JOIN public.orders o ON o.id = g.order_id
         WHERE g.phone8 = p.phone8
         ORDER BY g.sale_day DESC, g.created_at DESC
         LIMIT 1
      ) o ON true
      LEFT JOIN public.loyalty_shop_phone sp ON sp.phone8 = p.phone8
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
               'shop_profiles', n.shop_profiles
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
  head AS (
    SELECT o.customer_name AS name, o.customer_city AS city, o.customer_phone AS phone
      FROM g
      JOIN public.orders o ON o.id = g.order_id
     ORDER BY g.sale_day DESC, g.created_at DESC
     LIMIT 1
  )
  SELECT jsonb_build_object(
    'phone8', v_phone,
    'name', coalesce((SELECT name FROM head), ''),
    'city', coalesce((SELECT city FROM head), ''),
    'phone', coalesce((SELECT phone FROM head), ''),
    'points', (SELECT coalesce(sum(points), 0)::int FROM g),
    'orders', (SELECT count(*)::int FROM g),
    'nt_mkd', (SELECT coalesce(sum(nt_mkd), 0)::int FROM g),
    'shop_profiles', coalesce((SELECT shop_profiles FROM public.loyalty_shop_phone WHERE phone8 = v_phone), 0),
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
  WHERE EXISTS (SELECT 1 FROM g);

  RETURN v_out;
END;
$$;

-- Manual undo of one batch. Not granted to the api. Orders are not touched.
CREATE OR REPLACE FUNCTION public.loyalty_grants_undo(p_batch text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_n integer;
BEGIN
  IF p_batch IS NULL OR btrim(p_batch) = '' THEN
    RAISE EXCEPTION 'batch required';
  END IF;
  DELETE FROM public.loyalty_grants WHERE batch = btrim(p_batch);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

REVOKE ALL ON FUNCTION public.loyalty_name_key(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.loyalty_sure_centar_out() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.loyalty_catchup() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.loyalty_page(text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.loyalty_phone(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.loyalty_grants_undo(text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.loyalty_page(text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.loyalty_phone(text) TO service_role;

-- The first load. A total outside the band, or one row that is not delivered /
-- paid / Тим Центар Out, aborts the whole migration (tables, cron, rows).
SELECT public.loyalty_catchup();

DO $$
DECLARE
  v_orders integer;
  v_points bigint;
  v_bad integer;
BEGIN
  SELECT count(*)::int, coalesce(sum(points), 0)
    INTO v_orders, v_points
    FROM public.loyalty_grants;

  IF v_orders < 20000 OR v_orders > 40000 OR v_points < 4500000 OR v_points > 8000000 THEN
    RAISE EXCEPTION 'loyalty first load outside the sure band: % orders, % points', v_orders, v_points;
  END IF;

  SELECT count(*)::int INTO v_bad
    FROM public.loyalty_grants g
    JOIN public.orders o ON o.id = g.order_id
   WHERE o.mex_status_id IS DISTINCT FROM 2
      OR o.status IS DISTINCT FROM 'paid'
      OR public.cohort_order_source(o.sale_source, o.sale_source_detail, o.mex_tracking_id, o.dept_override)
           IS DISTINCT FROM 'teleshop_out'
      OR g.points IS DISTINCT FROM (
           CASE
             WHEN g.nt_mkd >= 2400 THEN 350
             WHEN g.nt_mkd >= 2000 THEN 200
             WHEN g.nt_mkd >= 1800 THEN 150
             WHEN g.nt_mkd >= 1200 THEN 100
             WHEN g.nt_mkd >= 600 THEN 65
             ELSE 0
           END
         )
      OR g.nt_mkd < 600
      OR g.phone8 !~ '^[0-9]{8}$'
      OR btrim(coalesce(g.mex_tracking_id, '')) = ''
      OR (coalesce(o.sold_at, o.confirmed_at, o.created_at) AT TIME ZONE 'Europe/Skopje')::date < DATE '2026-01-01'
      OR (coalesce(o.sold_at, o.confirmed_at, o.created_at) AT TIME ZONE 'Europe/Skopje')::date
           > (now() AT TIME ZONE 'Europe/Skopje')::date;

  IF v_bad > 0 THEN
    RAISE EXCEPTION 'loyalty grants include % rows that are not sure', v_bad;
  END IF;
END $$;

-- Minute 20, every hour — off the :00 and :15 jobs. Same rules as the first load,
-- without the band, so later delivered parcels earn and returns come off.
SELECT cron.unschedule('loyalty-centar-out-catchup')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'loyalty-centar-out-catchup');
SELECT cron.schedule(
  'loyalty-centar-out-catchup',
  '20 * * * *',
  $$SELECT public.loyalty_catchup();$$
);

NOTIFY pgrst, 'reload schema';
