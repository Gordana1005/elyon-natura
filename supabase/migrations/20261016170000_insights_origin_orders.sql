-- ============================================================================
-- THE ORDERS BEHIND AN ORIGIN TILE (owner, 15.10.2026)
--
-- Owner: "може ли … Bio Natural и Natura Therapy да ги направиме clickable, кога ќе кликнеме да ги
-- покажува сите нарачки? ЦРМ + collab? за да знаеме точно кои нарачки ги прават тие пари". A tile on
-- the Teleshop Out / Affiliate Out card counts the department's in-total cohort rows whose buyer's
-- origin is bio_natural / natura / new (20261015120100). Only the ORDER rows are on /orders — a
-- collabBox document still waiting for its parcel (the booking), a MEX parcel with no order and a
-- web order are not — so the drill is its own list: EXACTLY the rows the tile adds up, one per sale.
--
--   insights_origin_rows_core(from, to_end, source, origin)  the rows (service role / read-only only)
--   insights_origin_orders(from_day, to_day, source, origin) what the app calls (authenticated):
--       who may see it = who may see that department on the Overview — revenue viewers
--       (can_see_revenue) and a dept_admin for their own departments WITH денари; an admin / manager
--       counted (no value_mkd); anyone else 42501. Skopje days, at most 400 of them, ≤ 5.000 rows.
--
-- Read-only: it writes nothing. The same rows as insights_cohort (insights_sale_rows + the origin
-- rule), so the list's count and Σ value equal the tile.
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.insights_origin_rows_core(
  p_from timestamptz, p_to_end timestamptz, p_source text, p_origin text)
RETURNS TABLE(kind text, sale_at timestamptz, bucket text, value_mkd numeric, display_id text, order_id uuid,
              tracking_id text, customer text, phone text, seller text, products text,
              first_src text, first_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET "TimeZone" TO 'UTC'
SET work_mem TO '64MB'
SET jit TO 'off'
AS $fn$
  WITH r AS MATERIALIZED (
    SELECT s.*, co.affiliate_at, co.affiliate_src, co.natura_at, co.natura_src, co.web_at, co.web_src,
           CASE WHEN s.phone8 IS NULL THEN 'new'
                ELSE public.customer_origin_at_sale(co.affiliate_at, co.natura_at, co.web_at, s.sale_at) END AS origin
    FROM public.insights_sale_rows(p_from, p_to_end, false) s
    LEFT JOIN public.customer_origin co ON co.phone8 = s.phone8
    WHERE s.source = p_source AND s.in_total
  )
  SELECT r.kind, r.sale_at, r.bucket, r.value_mkd, r.display_id, r.order_id, r.tracking_id,
         coalesce(o.customer_name, d.komitent_name, p.receiver_name) AS customer,
         coalesce(o.customer_phone, d.customer_phone, p.receiver_phone_raw, w.phone,
                  CASE WHEN r.phone8 IS NOT NULL THEN '…' || r.phone8 END) AS phone,
         coalesce(sp.display_name, d.author) AS seller,
         coalesce(
           (SELECT string_agg(coalesce(oi.quantity, 1) || '× ' || coalesce(oi.product_name, '?'), ', ')
              FROM public.order_items oi WHERE oi.order_id = r.order_id),
           CASE WHEN o.product_name IS NOT NULL THEN coalesce(o.quantity, 1) || '× ' || o.product_name END,
           (SELECT string_agg((l ->> 'qty') || '× ' || coalesce(l ->> 'product_name', l ->> 'name'), ', ')
              FROM jsonb_array_elements(CASE WHEN jsonb_typeof(d.payload -> 'lines') = 'array' THEN d.payload -> 'lines' END) l
             WHERE l ->> 'role' = 'goods')) AS products,
         CASE r.origin WHEN 'bio_natural' THEN r.affiliate_src
                       WHEN 'natura' THEN CASE WHEN r.web_at < coalesce(r.natura_at, 'infinity') THEN r.web_src ELSE r.natura_src END END AS first_src,
         CASE r.origin WHEN 'bio_natural' THEN r.affiliate_at
                       WHEN 'natura' THEN least(r.natura_at, r.web_at) END AS first_at
  FROM r
  LEFT JOIN public.orders o ON r.kind = 'order' AND o.id = r.order_id
  LEFT JOIN public.collabbox_documents d ON r.kind = 'booking' AND d.doc_number = r.display_id
  LEFT JOIN public.mex_parcels p ON r.kind = 'mex' AND p.tracking_id = r.display_id
  LEFT JOIN public.web_orders w ON r.kind = 'web' AND w.shop_order_id = r.web_id
  LEFT JOIN public.sales_people sp ON sp.id = r.person_id
  WHERE r.origin = p_origin
  ORDER BY r.sale_at DESC, r.display_id
  LIMIT 5000
$fn$;

COMMENT ON FUNCTION public.insights_origin_rows_core(timestamptz, timestamptz, text, text) IS
  'The rows behind an origin tile (20261016170000): the department''s in-total cohort rows (insights_sale_rows) whose buyer''s origin at the sale is p_origin (customer_origin_at_sale) — orders, collabBox bookings, MEX-only parcels, web orders — with customer, phone, seller, products and the first trace. ≤ 5.000 rows, newest first. Service role / read-only only; the app calls insights_origin_orders().';

CREATE OR REPLACE FUNCTION public.insights_origin_orders(
  p_from date, p_to date, p_source text, p_origin text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_uid   uuid := auth.uid();
  v_scope text[];
  v_money boolean;
  v_rows  jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not signed in' USING ERRCODE = '42501';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 400 THEN
    RAISE EXCEPTION 'insights_origin_orders: bad period' USING ERRCODE = '22023';
  END IF;
  IF p_source NOT IN ('altercpa', 'elyon_crm', 'teleshop_out', 'teleshop_other', 'social', 'web', 'management')
     OR p_origin NOT IN ('bio_natural', 'natura', 'new') THEN
    RAISE EXCEPTION 'insights_origin_orders: bad source / origin' USING ERRCODE = '22023';
  END IF;

  v_scope := public.dept_scope(v_uid);            -- NULL = every department, {} = none, else a dept_admin's
  v_money := public.can_see_revenue(v_uid) OR (cardinality(v_scope) > 0 AND p_source = ANY (v_scope));
  IF NOT v_money AND NOT (public.has_role(v_uid, 'admin') OR public.has_role(v_uid, 'manager')) THEN
    RAISE EXCEPTION 'insights_origin_orders: not allowed' USING ERRCODE = '42501';
  END IF;

  SELECT coalesce(jsonb_agg(
           jsonb_strip_nulls(jsonb_build_object(
             'kind', c.kind,
             'sale_day', to_char(c.sale_at AT TIME ZONE 'Europe/Skopje', 'YYYY-MM-DD'),
             'bucket', c.bucket,
             'value_mkd', CASE WHEN v_money THEN round(c.value_mkd) END,
             'display_id', c.display_id,
             'order_id', c.order_id,
             'tracking_id', c.tracking_id,
             'customer', c.customer,
             'phone', c.phone,
             'seller', c.seller,
             'products', c.products,
             'first_src', c.first_src,
             'first_day', to_char(c.first_at AT TIME ZONE 'Europe/Skopje', 'YYYY-MM-DD')))
           ORDER BY c.sale_at DESC, c.display_id), '[]'::jsonb)
    INTO v_rows
    FROM public.insights_origin_rows_core(
           (p_from::timestamp AT TIME ZONE 'Europe/Skopje'),
           ((p_to + 1)::timestamp AT TIME ZONE 'Europe/Skopje') - interval '1 microsecond',
           p_source, p_origin) c;

  RETURN jsonb_build_object(
    'meta', jsonb_build_object('from', p_from, 'to', p_to, 'source', p_source, 'origin', p_origin,
                               'money', v_money, 'count', jsonb_array_length(v_rows),
                               'truncated', jsonb_array_length(v_rows) >= 5000),
    'rows', v_rows);
END;
$fn$;

COMMENT ON FUNCTION public.insights_origin_orders(date, date, text, text) IS
  'The list behind a Teleshop Out / Affiliate Out origin tile (20261016170000), for the signed-in user: revenue viewers and a dept_admin for their own departments get value_mkd; an admin / manager the same rows counted; anyone else 42501. Skopje days (≤ 400), ≤ 5.000 rows.';

REVOKE ALL ON FUNCTION public.insights_origin_rows_core(timestamptz, timestamptz, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.insights_origin_rows_core(timestamptz, timestamptz, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.insights_origin_orders(date, date, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.insights_origin_orders(date, date, text, text) TO authenticated, service_role;
DO $ro$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    GRANT EXECUTE ON FUNCTION public.insights_origin_rows_core(timestamptz, timestamptz, text, text) TO supabase_read_only_user;
  END IF;
END
$ro$;

COMMIT;

NOTIFY pgrst, 'reload schema';
