-- ============================================================================
-- STOCK v2 — 5/5: the reports (contract docs/STOCK-V2.md "Reports"; JSON shapes in
-- src/lib/stockV2Types.ts)
--
-- Every report reads ONE move source:
--   p_preview = false  the ledger (stock_moves) — once stock v2 is switched on;
--   p_preview = true   stock_v2_desired() — computed, nothing written (the banner
--                      "Преглед — пресметано, ништо не е запишано"); NULL = preview
--                      while stock_v2.enabled is false.
-- Balance at an instant t = Σ qty of the moves before t, a count at exactly t included
-- (an opening counted at 00:00 is part of that day's opening balance). Days are Skopje
-- days ((day)::timestamp AT TIME ZONE 'Europe/Skopje'), so the 25.10 switch is safe.
--
--   stock_v2_position_at(at, warehouse, preview)  on-hand + to_pack + with_courier per
--                                                 article (shared by the count writer)
--   stock_v2_on_hand(at, warehouse, preview)       → (warehouse_code, article_code, qty)
--   stock_v2_day(day, warehouse, at, money, preview)            → StockDay
--   stock_v2_article_series(article, warehouse, from, to, preview) → StockArticleSeries
--   stock_v2_parcels_day(day, filters, limit, offset, money)    → StockParcelsDay
--   stock_v2_movements(filters, limit, offset)                  → StockMovementsPage
--   stock_v2_reserved_now()                                     → reserved units now
--   stock_v2_health(detail)                                     → StockHealth
--   stock_v2_sigma_month_check(month)                           → Sigma 000217 vs MEX
--
-- The pipeline: to_pack = units in parcels already deducted (parcel_out) that MEX has not
-- picked up at t (mex_parcels.picked_up_at, migration 20260945000900 — required; a parcel
-- with no pickup stamp counts as picked up at creation once it left status 8);
-- with_courier = picked up before t, neither delivered nor returned before t. Both are
-- INSIDE the deduction: closing already excludes them. available = closing − reserved
-- (NOT closing − to_pack − reserved: to_pack is already out of closing — see the doc).
-- Department per parcel = the cohort's own rule (insights_parcel_rows): a live web
-- claim → web, else the order naming the parcel (or the register's order) through the
-- 4-argument cohort_order_source, else cohort_parcel_source(cohort_parcel_split(…)).
-- City = mex_parcels.receiver_city, zone = mex_zone_for_name(city). No receiver name or
-- phone leaves any report. Money keys (cost_mkd, value_mkd, cod_mkd) only with p_money;
-- stock_v2_article_series always carries the article cost (the api strips it).
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '10s';

DO $dep$
BEGIN
  IF to_regprocedure('public.stock_v2_desired()') IS NULL
     OR to_regprocedure('public.stock_v2_cost_at(text, timestamptz)') IS NULL THEN
    RAISE EXCEPTION 'stock v2 reports: apply 20260945000300 and 20260945000400 first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'mex_parcels' AND column_name = 'picked_up_at') THEN
    RAISE EXCEPTION 'stock v2 reports: apply 20260945000900 (mex_parcels.picked_up_at, workstream M) first';
  END IF;
  IF to_regprocedure('public.cohort_order_source(text, text, text, text)') IS NULL
     OR to_regprocedure('public.cohort_parcel_source(text)') IS NULL
     OR to_regprocedure('public.cohort_parcel_split(text, text, text, text)') IS NULL
     OR to_regprocedure('public.mex_zone_for_name(text, text)') IS NULL
     OR to_regprocedure('public.warehouse_send_base()') IS NULL THEN
    RAISE EXCEPTION 'stock v2 reports: the cohort / MEX zone / warehouse queue functions are missing';
  END IF;
END
$dep$;

-- ── 0. the move source ──────────────────────────────────────────────────────
-- A subquery text with (ord, id, article_code, warehouse_id, qty, kind, event_at, recorded_at, source,
-- source_key, correction, provisional, tracking_id, sigma_doc, count_id, manual_id, lines_source).
CREATE OR REPLACE FUNCTION public.stock_v2_moves_sql(p_preview boolean)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE WHEN coalesce(p_preview, false) THEN
    '(SELECT row_number() OVER (ORDER BY d.event_at, d.source_key, d.kind, d.article_code, d.warehouse_id) AS ord,
             -(row_number() OVER (ORDER BY d.event_at, d.source_key, d.kind, d.article_code, d.warehouse_id)) AS id,
             d.article_code, d.warehouse_id, d.qty, d.kind, d.event_at, d.event_at AS recorded_at, d.source,
             d.source_key, false AS correction, d.provisional, d.tracking_id, d.sigma_doc, d.count_id, d.manual_id,
             d.lines_source
        FROM public.stock_v2_desired() d)'
  ELSE
    '(SELECT m.id AS ord, m.id, m.article_code, m.warehouse_id, m.qty, m.kind, m.event_at, m.recorded_at, m.source,
             m.source_key, m.correction, m.provisional, m.tracking_id, m.sigma_doc, m.count_id, m.manual_id,
             m.lines_source
        FROM public.stock_moves m)'
  END
$$;

CREATE OR REPLACE FUNCTION public.stock_v2_wh_ref(p_id smallint)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object('code', w.code, 'name', w.name, 'role', w.role, 'tracked', w.tracked)
  FROM public.stock_warehouses w WHERE w.id = p_id
$$;

CREATE OR REPLACE FUNCTION public.stock_v2_freshness()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'last_run_at', (SELECT max(r.finished_at) FROM public.stock_runs r WHERE r.status = 'ok' AND NOT r.dry),
    'last_mex_at', (SELECT max(p.last_seen_at) FROM public.mex_parcels p),
    'last_sigma_at', (SELECT max(b.received_at) FROM public.stock_sigma_batches b))
$$;

-- ── 1. position at an instant ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.stock_v2_position_at(p_at timestamptz, p_warehouse text DEFAULT NULL, p_preview boolean DEFAULT NULL)
RETURNS TABLE (warehouse_code text, article_code text, on_hand numeric, to_pack numeric, with_courier numeric)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET work_mem = '64MB'
SET jit = off
AS $fn$
DECLARE
  v_at   timestamptz := coalesce(p_at, now());
  v_wh   smallint;
  v_prev boolean := coalesce(p_preview, NOT public.stock_v2_enabled());
BEGIN
  IF nullif(btrim(coalesce(p_warehouse, '')), '') IS NOT NULL THEN
    v_wh := public.stock_v2_wh(p_warehouse);
    IF v_wh IS NULL THEN RAISE EXCEPTION 'stock_v2_position_at: unknown warehouse %', p_warehouse USING ERRCODE = '22023'; END IF;
  END IF;
  RETURN QUERY EXECUTE format($q$
WITH
mv AS MATERIALIZED (
  SELECT m.warehouse_id, m.article_code, m.kind, m.qty, m.event_at, m.tracking_id
  FROM %s m
  WHERE m.event_at <= $1 AND ($2::smallint IS NULL OR m.warehouse_id = $2)
),
oh AS (
  SELECT mv.warehouse_id, mv.article_code, sum(mv.qty) AS q
  FROM mv WHERE mv.event_at < $1 OR mv.kind IN ('opening', 'count_adjust')
  GROUP BY 1, 2
),
po AS (
  SELECT mv.warehouse_id, mv.tracking_id, mv.article_code, -sum(mv.qty) AS q
  FROM mv WHERE mv.kind = 'parcel_out' AND mv.event_at < $1
  GROUP BY 1, 2, 3 HAVING sum(mv.qty) < 0
),
pl AS (
  SELECT po.warehouse_id, po.article_code,
         sum(po.q) FILTER (WHERE (mp.picked_up_at IS NULL AND mp.status_id = 8) OR mp.picked_up_at >= $1) AS to_pack,
         sum(po.q) FILTER (WHERE coalesce(mp.picked_up_at, CASE WHEN mp.status_id <> 8 THEN mp.created_at_mex END) < $1
                             AND NOT coalesce(mp.delivered_at < $1, false)
                             AND NOT (mp.status_id = 7 AND coalesce(mp.returned_at < $1, false))) AS with_courier
  FROM po
  JOIN public.mex_parcels mp ON mp.tracking_id = po.tracking_id
  LEFT JOIN (SELECT DISTINCT u.tracking_id FROM mv u WHERE u.kind = 'unpack_in' AND u.event_at < $1) un
         ON un.tracking_id = po.tracking_id
  WHERE un.tracking_id IS NULL
  GROUP BY 1, 2
),
k AS (SELECT oh.warehouse_id, oh.article_code FROM oh UNION SELECT pl.warehouse_id, pl.article_code FROM pl)
SELECT w.code, k.article_code, round(coalesce(oh.q, 0), 3), round(coalesce(pl.to_pack, 0), 3), round(coalesce(pl.with_courier, 0), 3)
FROM k
JOIN public.stock_warehouses w ON w.id = k.warehouse_id
LEFT JOIN oh ON oh.warehouse_id = k.warehouse_id AND oh.article_code = k.article_code
LEFT JOIN pl ON pl.warehouse_id = k.warehouse_id AND pl.article_code = k.article_code
WHERE coalesce(oh.q, 0) <> 0 OR coalesce(pl.to_pack, 0) <> 0 OR coalesce(pl.with_courier, 0) <> 0
$q$, public.stock_v2_moves_sql(v_prev)) USING v_at, v_wh;
END
$fn$;

COMMENT ON FUNCTION public.stock_v2_position_at(timestamptz, text, boolean) IS
  'Stock v2 per (warehouse, article) at p_at: on-hand (moves before p_at, a count at p_at included), to_pack (deducted, not picked up at p_at) and with_courier (picked up, not delivered / returned at p_at). p_preview NULL = preview while stock v2 is off. Migration 20260945000500.';

CREATE OR REPLACE FUNCTION public.stock_v2_on_hand(p_at timestamptz DEFAULT NULL, p_warehouse text DEFAULT NULL, p_preview boolean DEFAULT NULL)
RETURNS TABLE (warehouse_code text, article_code text, qty numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT x.warehouse_code, x.article_code, x.on_hand
  FROM public.stock_v2_position_at(p_at, p_warehouse, p_preview) x
  WHERE x.on_hand <> 0
$$;

COMMENT ON FUNCTION public.stock_v2_on_hand(timestamptz, text, boolean) IS
  'Stock v2 on-hand per (warehouse, article) at p_at (default now) — the ledger, or the preview. Migration 20260945000500.';

-- ── 2. reserved now ─────────────────────────────────────────────────────────
-- Confirmed CRM orders with no parcel (the warehouse send queue) + collabBox bookings of the last 14 days
-- with no parcel (not storno / vanished, not a booking of a queued order), as articles: collabBox codes
-- directly (or their approved alias), CRM products through their approved recipe. An estimate: what does
-- not map is counted in unmapped_lines, nothing is guessed.
CREATE OR REPLACE FUNCTION public.stock_v2_reserved_lines()
RETURNS TABLE (article_code text, qty numeric, src text, ref text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET work_mem = '64MB'
SET jit = off
AS $res$
WITH
tp AS MATERIALIZED (SELECT public.report_excluded_phone8s() AS a),
q AS MATERIALIZED (SELECT b.id FROM public.warehouse_send_base() b),
ol AS (                    -- the queued orders' lines
  SELECT q.id::text AS ref, i.product_id, coalesce(i.quantity, 0)::numeric AS qn
  FROM q JOIN public.order_items i ON i.order_id = q.id
  UNION ALL
  SELECT q.id::text, o.product_id, coalesce(o.quantity, 1)::numeric
  FROM q JOIN public.orders o ON o.id = q.id
  WHERE NOT EXISTS (SELECT 1 FROM public.order_items i WHERE i.order_id = q.id)
),
oa AS (
  SELECT pa.article_code, ol.qn * pa.qty AS qty, 'order'::text AS src, ol.ref
  FROM ol
  JOIN public.product_articles pa
    ON pa.product_id = ol.product_id AND pa.status = 'approved'
   AND pa.valid_from <= now() AND (pa.valid_to IS NULL OR pa.valid_to > now())
  WHERE ol.qn > 0 AND ol.qn < 100
    AND NOT EXISTS (SELECT 1 FROM public.product_stock_exempt e WHERE e.product_id = ol.product_id)
  UNION ALL
  SELECT NULL, ol.qn, 'order', ol.ref
  FROM ol
  WHERE ol.qn > 0
    AND NOT EXISTS (SELECT 1 FROM public.product_stock_exempt e WHERE e.product_id = ol.product_id)
    AND NOT EXISTS (SELECT 1 FROM public.product_articles pa
                     WHERE pa.product_id = ol.product_id AND pa.status = 'approved'
                       AND pa.valid_from <= now() AND (pa.valid_to IS NULL OR pa.valid_to > now()))
),
bk AS MATERIALIZED (       -- collabBox bookings with no parcel yet
  SELECT d.doc_number, d.payload -> 'lines' AS lines
  FROM public.collabbox_documents d
  CROSS JOIN tp
  WHERE NOT d.is_storno AND d.vanished_at IS NULL AND d.lines_complete
    AND d.role IN ('order', 'order_unless_held', 'credit')
    AND coalesce(d.booked_at, d.doc_at) >= now() - interval '14 days'
    AND jsonb_typeof(d.payload -> 'lines') = 'array'
    AND NOT coalesce(d.phone8 = ANY (tp.a), false)
    AND NOT EXISTS (SELECT 1 FROM public.mex_parcels p WHERE p.tracking_id = d.doc_number)
    AND (d.order_id IS NULL OR d.order_id NOT IN (SELECT q.id FROM q))
    AND (d.related_order_id IS NULL OR d.related_order_id NOT IN (SELECT q.id FROM q))
),
bl AS (
  SELECT bk.doc_number AS ref, upper(btrim(e ->> 'code')) AS code, public.stock_v2_num(e ->> 'qty') AS qn,
         CASE WHEN (e ->> 'product_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              THEN (e ->> 'product_id')::uuid END AS pid
  FROM bk CROSS JOIN LATERAL jsonb_array_elements(bk.lines) e
  WHERE e ->> 'role' = 'goods' AND public.stock_v2_num(e ->> 'qty') > 0 AND public.stock_v2_num(e ->> 'qty') < 100
),
ba AS (
  SELECT x.article_code, x.qty, 'booking'::text AS src, x.ref
  FROM (
    SELECT bl.ref, a.article_code, bl.qn * a.qty AS qty
    FROM bl JOIN public.stock_article_aliases a
      ON a.status = 'approved' AND a.kind = 'article' AND a.source = 'collabbox_code' AND a.key = bl.code
    UNION ALL
    SELECT bl.ref, bl.code, bl.qn
    FROM bl
    WHERE NOT EXISTS (SELECT 1 FROM public.stock_article_aliases a
                       WHERE a.status = 'approved' AND a.source = 'collabbox_code' AND a.key = bl.code)
      AND EXISTS (SELECT 1 FROM public.stock_articles s WHERE s.code = bl.code)
    UNION ALL
    SELECT bl.ref, NULL, bl.qn
    FROM bl
    WHERE NOT EXISTS (SELECT 1 FROM public.stock_article_aliases a
                       WHERE a.status = 'approved' AND a.source = 'collabbox_code' AND a.key = bl.code)
      AND NOT EXISTS (SELECT 1 FROM public.stock_articles s WHERE s.code = bl.code)
  ) x
)
SELECT oa.article_code, oa.qty, oa.src, oa.ref FROM oa
UNION ALL
SELECT ba.article_code, ba.qty, ba.src, ba.ref FROM ba
$res$;

CREATE OR REPLACE FUNCTION public.stock_v2_reserved_now()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH r AS MATERIALIZED (SELECT * FROM public.stock_v2_reserved_lines()),
  ship AS (
    SELECT w.code FROM public.stock_parcel_routes rt JOIN public.stock_warehouses w ON w.id = rt.warehouse_id
    WHERE rt.active AND rt.valid_from <= now() AND (rt.valid_to IS NULL OR rt.valid_to > now())
    ORDER BY rt.priority, rt.id LIMIT 1
  )
  SELECT jsonb_build_object(
    'at', now(),
    'warehouse', (SELECT ship.code FROM ship),
    'orders', (SELECT count(DISTINCT r.ref) FROM r WHERE r.src = 'order'),
    'bookings', (SELECT count(DISTINCT r.ref) FROM r WHERE r.src = 'booking'),
    'units', (SELECT coalesce(sum(r.qty), 0) FROM r WHERE r.article_code IS NOT NULL),
    'unmapped_lines', (SELECT count(*) FROM r WHERE r.article_code IS NULL),
    'unmapped_units', (SELECT coalesce(sum(r.qty), 0) FROM r WHERE r.article_code IS NULL),
    'articles', coalesce((SELECT jsonb_agg(jsonb_build_object('code', x.article_code, 'name', a.name, 'qty', x.q) ORDER BY x.q DESC, x.article_code)
                            FROM (SELECT r.article_code, round(sum(r.qty), 3) AS q FROM r WHERE r.article_code IS NOT NULL GROUP BY 1) x
                            LEFT JOIN public.stock_articles a ON a.code = x.article_code), '[]'::jsonb))
$$;

COMMENT ON FUNCTION public.stock_v2_reserved_now() IS
  'Stock v2: units reserved NOW — confirmed CRM orders with no parcel (warehouse_send_base) through approved recipes + collabBox bookings of the last 14 days with no parcel (codes / approved aliases); unmapped lines counted, never guessed. {at, warehouse, orders, bookings, units, unmapped_lines, unmapped_units, articles[{code, name, qty}]}. Migration 20260945000500.';

-- ── 3. the day sheet (StockDay) ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.stock_v2_day(
  p_day       date,
  p_warehouse text    DEFAULT 'main',
  p_at        time    DEFAULT NULL,
  p_money     boolean DEFAULT false,
  p_preview   boolean DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET work_mem = '64MB'
SET jit = off
AS $fn$
DECLARE
  v_wh      record;
  v_enabled boolean := public.stock_v2_enabled();
  v_prev    boolean := coalesce(p_preview, NOT public.stock_v2_enabled());
  v_start   timestamptz;
  v_end     timestamptz;
  v_cut     timestamptz;
  v_w14     timestamptz;
  v_wdays   integer;
  v_today   date := (now() AT TIME ZONE 'Europe/Skopje')::date;
  v_res     boolean;
  v_body    jsonb;
  v_opening jsonb;
BEGIN
  IF p_day IS NULL THEN RAISE EXCEPTION 'stock_v2_day: day required' USING ERRCODE = '22023'; END IF;
  SELECT w.id, w.code INTO v_wh FROM public.stock_warehouses w WHERE w.code = lower(btrim(coalesce(p_warehouse, 'main')));
  IF v_wh.id IS NULL THEN RAISE EXCEPTION 'stock_v2_day: unknown warehouse %', p_warehouse USING ERRCODE = '22023'; END IF;

  v_start := (p_day::timestamp) AT TIME ZONE 'Europe/Skopje';
  v_end   := ((p_day + 1)::timestamp) AT TIME ZONE 'Europe/Skopje';
  v_cut   := CASE WHEN p_at IS NOT NULL THEN least((p_day + p_at) AT TIME ZONE 'Europe/Skopje', v_end) ELSE v_end END;
  v_w14   := ((p_day - 14)::timestamp) AT TIME ZONE 'Europe/Skopje';
  v_wdays := greatest(0, least(14, p_day - (public.stock_v2_scope_from() AT TIME ZONE 'Europe/Skopje')::date));
  -- reserved only for today, and only for the warehouse parcels leave now
  v_res := p_day = v_today AND EXISTS (
             SELECT 1 FROM public.stock_parcel_routes r
              WHERE r.active AND r.warehouse_id = v_wh.id AND r.valid_from <= now()
                AND (r.valid_to IS NULL OR r.valid_to > now()));

  EXECUTE format($q$
WITH
mv AS MATERIALIZED (
  SELECT m.article_code, m.kind, m.qty, m.event_at, m.tracking_id
  FROM %s m
  WHERE m.warehouse_id = $1 AND m.event_at <= $3
),
fm AS (
  SELECT mv.*,
         (mv.event_at < $2 OR (mv.event_at = $2 AND mv.kind IN ('opening', 'count_adjust'))) AS b0,
         (mv.event_at < $3 OR (mv.event_at = $3 AND mv.kind IN ('opening', 'count_adjust'))) AS b1
  FROM mv
),
bal AS (
  SELECT fm.article_code,
         coalesce(sum(fm.qty) FILTER (WHERE fm.b0), 0) AS opening,
         coalesce(sum(fm.qty) FILTER (WHERE fm.b1), 0) AS closing,
         coalesce(-sum(fm.qty) FILTER (WHERE fm.b1 AND NOT fm.b0 AND fm.kind = 'parcel_out'), 0) AS out,
         coalesce(sum(fm.qty) FILTER (WHERE fm.b1 AND NOT fm.b0 AND fm.kind IN ('return_in', 'unpack_in')), 0) AS back,
         coalesce(sum(fm.qty) FILTER (WHERE fm.b1 AND NOT fm.b0 AND fm.kind IN
                    ('receipt', 'transfer_in', 'production_in', 'b2b_return_in', 'shop_return_in', 'damaged_in')), 0) AS inn,
         coalesce(-sum(fm.qty) FILTER (WHERE fm.b1 AND NOT fm.b0 AND fm.kind IN
                    ('shop_out', 'export_out', 'b2b_out', 'transfer_out', 'writeoff', 'production_use')), 0) AS other_out,
         coalesce(sum(fm.qty) FILTER (WHERE fm.b1 AND NOT fm.b0 AND fm.kind IN ('count_adjust', 'adjust', 'opening')), 0) AS adj,
         coalesce(-sum(fm.qty) FILTER (WHERE fm.kind = 'parcel_out' AND fm.event_at >= $4 AND fm.event_at < $2), 0) AS out14
  FROM fm
  GROUP BY fm.article_code
),
po AS (
  SELECT mv.tracking_id, mv.article_code, -sum(mv.qty) AS q
  FROM mv WHERE mv.kind = 'parcel_out' AND mv.event_at < $3
  GROUP BY 1, 2 HAVING sum(mv.qty) < 0
),
pl AS (
  SELECT po.article_code,
         coalesce(sum(po.q) FILTER (WHERE (mp.picked_up_at IS NULL AND mp.status_id = 8) OR mp.picked_up_at >= $3), 0) AS to_pack,
         coalesce(sum(po.q) FILTER (WHERE coalesce(mp.picked_up_at, CASE WHEN mp.status_id <> 8 THEN mp.created_at_mex END) < $3
                                     AND NOT coalesce(mp.delivered_at < $3, false)
                                     AND NOT (mp.status_id = 7 AND coalesce(mp.returned_at < $3, false))), 0) AS with_courier
  FROM po
  JOIN public.mex_parcels mp ON mp.tracking_id = po.tracking_id
  LEFT JOIN (SELECT DISTINCT u.tracking_id FROM mv u WHERE u.kind = 'unpack_in' AND u.event_at < $3) un
         ON un.tracking_id = po.tracking_id
  WHERE un.tracking_id IS NULL
  GROUP BY 1
),
rs AS (
  SELECT r.article_code, sum(r.qty) AS q
  FROM public.stock_v2_reserved_lines() r
  WHERE $6 AND r.article_code IS NOT NULL
  GROUP BY 1
),
k AS (SELECT bal.article_code FROM bal UNION SELECT pl.article_code FROM pl UNION SELECT rs.article_code FROM rs),
r AS (
  SELECT k.article_code AS code, coalesce(a.name, k.article_code) AS name, coalesce(a.unit, 'КОМ') AS unit,
         round(coalesce(bal.opening, 0), 3) AS opening, round(coalesce(bal.out, 0), 3) AS out,
         round(coalesce(bal.back, 0), 3) AS back, round(coalesce(bal.inn, 0), 3) AS inn,
         round(coalesce(bal.other_out, 0), 3) AS other_out, round(coalesce(bal.adj, 0), 3) AS adj,
         round(coalesce(bal.closing, 0), 3) AS closing,
         round(coalesce(pl.to_pack, 0), 3) AS to_pack, round(coalesce(pl.with_courier, 0), 3) AS with_courier,
         round(coalesce(rs.q, 0), 3) AS reserved,
         CASE WHEN $7 > 0 THEN round(coalesce(bal.out14, 0) / $7, 2) ELSE 0 END AS avg14,
         CASE WHEN $5 THEN public.stock_v2_cost_at(k.article_code, $3) END AS cost
  FROM k
  LEFT JOIN bal ON bal.article_code = k.article_code
  LEFT JOIN pl ON pl.article_code = k.article_code
  LEFT JOIN rs ON rs.article_code = k.article_code
  LEFT JOIN public.stock_articles a ON a.code = k.article_code
),
rr AS (
  SELECT r.* FROM r
  WHERE r.opening <> 0 OR r.closing <> 0 OR r.out <> 0 OR r.back <> 0 OR r.inn <> 0 OR r.other_out <> 0
     OR r.adj <> 0 OR r.to_pack <> 0 OR r.with_courier <> 0 OR r.reserved <> 0
)
SELECT jsonb_build_object(
  'totals', jsonb_build_object(
      'articles', count(*),
      'opening', coalesce(sum(rr.opening), 0), 'out', coalesce(sum(rr.out), 0), 'back', coalesce(sum(rr.back), 0),
      'in', coalesce(sum(rr.inn), 0), 'other_out', coalesce(sum(rr.other_out), 0), 'adjust', coalesce(sum(rr.adj), 0),
      'closing', coalesce(sum(rr.closing), 0), 'to_pack', coalesce(sum(rr.to_pack), 0),
      'with_courier', coalesce(sum(rr.with_courier), 0), 'reserved', coalesce(sum(rr.reserved), 0),
      'available', coalesce(sum(rr.closing - rr.reserved), 0),
      'negatives', count(*) FILTER (WHERE rr.closing < 0))
    || CASE WHEN $5 THEN jsonb_build_object('value_mkd', round(sum(rr.closing * rr.cost) FILTER (WHERE rr.cost IS NOT NULL AND rr.closing > 0), 2))
            ELSE '{}'::jsonb END,
  'articles', coalesce(jsonb_agg(jsonb_build_object(
      'code', rr.code, 'name', rr.name, 'unit', rr.unit,
      'opening', rr.opening, 'out', rr.out, 'back', rr.back, 'in', rr.inn, 'other_out', rr.other_out,
      'adjust', rr.adj, 'closing', rr.closing, 'to_pack', rr.to_pack, 'with_courier', rr.with_courier,
      'reserved', rr.reserved, 'available', rr.closing - rr.reserved,
      'avg_out_14d', rr.avg14,
      'days_cover', CASE WHEN rr.avg14 > 0 THEN round(greatest(rr.closing, 0) / rr.avg14, 1) END,
      'negative', rr.closing < 0)
      || CASE WHEN $5 THEN jsonb_build_object('cost_mkd', rr.cost,
                                              'value_mkd', CASE WHEN rr.cost IS NOT NULL THEN round(rr.closing * rr.cost, 2) END)
              ELSE '{}'::jsonb END
    ORDER BY rr.name, rr.code), '[]'::jsonb))
FROM rr
$q$, public.stock_v2_moves_sql(v_prev))
  INTO v_body
  USING v_wh.id, v_start, v_cut, v_w14, coalesce(p_money, false), v_res, v_wdays::numeric;

  SELECT jsonb_build_object('count_id', c.id, 'counted_at', c.counted_at, 'source', c.source, 'status', c.status)
    INTO v_opening
    FROM public.stock_wh_counts c
   WHERE c.warehouse_id = v_wh.id AND c.kind = 'opening' AND c.status <> 'void'
   ORDER BY (c.status = 'approved') DESC, c.created_at DESC
   LIMIT 1;

  RETURN jsonb_build_object(
    'day', to_char(p_day, 'YYYY-MM-DD'),
    'at', CASE WHEN p_at IS NOT NULL THEN to_jsonb(v_cut) ELSE 'null'::jsonb END,
    'warehouse', public.stock_v2_wh_ref(v_wh.id),
    'preview', v_prev,
    'enabled', v_enabled,
    'opening', coalesce(v_opening, 'null'::jsonb),
    'totals', v_body -> 'totals',
    'articles', v_body -> 'articles',
    'freshness', public.stock_v2_freshness());
END
$fn$;

COMMENT ON FUNCTION public.stock_v2_day(date, text, time, boolean, boolean) IS
  'GET stock/v2/day → StockDay: per article of one warehouse on one Skopje day (up to p_at when given): opening, out, back, in, other_out, adjust, closing, to_pack, with_courier, reserved (today only), available = closing − reserved, avg_out_14d, days_cover, negative; cost / value only with p_money. Preview (desired) while stock v2 is off. Migration 20260945000500.';

-- ── 4. one article over days (StockArticleSeries) ───────────────────────────
CREATE OR REPLACE FUNCTION public.stock_v2_article_series(
  p_article   text,
  p_warehouse text DEFAULT 'main',
  p_from      date DEFAULT NULL,
  p_to        date DEFAULT NULL,
  p_preview   boolean DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET work_mem = '64MB'
SET jit = off
AS $fn$
DECLARE
  v_art   record;
  v_wh    record;
  v_prev  boolean := coalesce(p_preview, NOT public.stock_v2_enabled());
  v_to    date := coalesce(p_to, (now() AT TIME ZONE 'Europe/Skopje')::date);
  v_from  date;
  v_body  jsonb;
BEGIN
  SELECT a.code, a.name, a.unit INTO v_art FROM public.stock_articles a WHERE a.code = upper(btrim(coalesce(p_article, '')));
  IF v_art.code IS NULL THEN RAISE EXCEPTION 'stock_v2_article_series: unknown article %', p_article USING ERRCODE = '22023'; END IF;
  SELECT w.id, w.code INTO v_wh FROM public.stock_warehouses w WHERE w.code = lower(btrim(coalesce(p_warehouse, 'main')));
  IF v_wh.id IS NULL THEN RAISE EXCEPTION 'stock_v2_article_series: unknown warehouse %', p_warehouse USING ERRCODE = '22023'; END IF;
  v_from := coalesce(p_from, v_to - 29);
  IF v_from > v_to OR v_to - v_from > 400 THEN
    RAISE EXCEPTION 'stock_v2_article_series: bad window (at most 400 days)' USING ERRCODE = '22023';
  END IF;

  EXECUTE format($q$
WITH
mv AS MATERIALIZED (
  SELECT m.*
  FROM %s m
  WHERE m.warehouse_id = $1 AND m.article_code = $2 AND m.event_at < $4
),
d AS (
  SELECT g::date AS day, (g::timestamp AT TIME ZONE 'Europe/Skopje') AS s, ((g::date + 1)::timestamp AT TIME ZONE 'Europe/Skopje') AS e
  FROM generate_series($5::date, $6::date, interval '1 day') g
),
pt AS (
  SELECT d.day,
         coalesce(sum(mv.qty) FILTER (WHERE mv.event_at < d.s OR (mv.event_at = d.s AND mv.kind IN ('opening', 'count_adjust'))), 0) AS opening,
         coalesce(sum(mv.qty) FILTER (WHERE mv.event_at < d.e OR (mv.event_at = d.e AND mv.kind IN ('opening', 'count_adjust'))), 0) AS closing,
         coalesce(-sum(mv.qty) FILTER (WHERE mv.kind = 'parcel_out' AND mv.f), 0) AS out,
         coalesce(sum(mv.qty) FILTER (WHERE mv.kind IN ('return_in', 'unpack_in') AND mv.f), 0) AS back,
         coalesce(sum(mv.qty) FILTER (WHERE mv.kind IN ('receipt', 'transfer_in', 'production_in', 'b2b_return_in', 'shop_return_in', 'damaged_in') AND mv.f), 0) AS inn,
         coalesce(-sum(mv.qty) FILTER (WHERE mv.kind IN ('shop_out', 'export_out', 'b2b_out', 'transfer_out', 'writeoff', 'production_use') AND mv.f), 0) AS other_out,
         coalesce(sum(mv.qty) FILTER (WHERE mv.kind IN ('count_adjust', 'adjust', 'opening') AND mv.f), 0) AS adj
  FROM d
  LEFT JOIN LATERAL (
    SELECT x.qty, x.kind, x.event_at,
           (x.event_at > d.s OR (x.event_at = d.s AND x.kind NOT IN ('opening', 'count_adjust')))
           AND (x.event_at < d.e OR (x.event_at = d.e AND x.kind IN ('opening', 'count_adjust'))) AS f
    FROM mv x WHERE x.event_at <= d.e) mv ON true
  GROUP BY d.day
),
bl AS (
  SELECT mv.*, sum(mv.qty) OVER (ORDER BY mv.event_at, mv.ord ROWS UNBOUNDED PRECEDING) AS bal
  FROM mv
),
mr AS (
  SELECT bl.* FROM bl
  WHERE bl.event_at >= $3 AND bl.event_at < $4
  ORDER BY bl.event_at DESC, bl.ord DESC
  LIMIT 200
)
SELECT jsonb_build_object(
  'series', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                 'day', to_char(pt.day, 'YYYY-MM-DD'), 'opening', round(pt.opening, 3), 'out', round(pt.out, 3),
                 'back', round(pt.back, 3), 'in', round(pt.inn, 3), 'other_out', round(pt.other_out, 3),
                 'adjust', round(pt.adj, 3), 'closing', round(pt.closing, 3)) ORDER BY pt.day), '[]'::jsonb) FROM pt),
  'moves', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                 'id', mr.id, 'event_at', mr.event_at, 'recorded_at', mr.recorded_at,
                 'late_days', greatest(0, floor(extract(epoch FROM mr.recorded_at - mr.event_at) / 86400))::integer,
                 'warehouse_code', $7, 'article_code', mr.article_code, 'article_name', $8,
                 'qty', mr.qty, 'kind', mr.kind, 'source', mr.source, 'source_key', mr.source_key,
                 'tracking_id', mr.tracking_id, 'sigma_doc', mr.sigma_doc,
                 'sigma_versions', (SELECT sd.versions FROM public.stock_sigma_docs sd WHERE sd.doc_key = mr.sigma_doc),
                 'count_id', mr.count_id, 'manual_id', mr.manual_id, 'correction', mr.correction,
                 'provisional', mr.provisional, 'balance_after', round(mr.bal, 3))
               ORDER BY mr.event_at DESC, mr.ord DESC), '[]'::jsonb) FROM mr))
$q$, public.stock_v2_moves_sql(v_prev))
  INTO v_body
  USING v_wh.id, v_art.code,
        (v_from::timestamp) AT TIME ZONE 'Europe/Skopje', ((v_to + 1)::timestamp) AT TIME ZONE 'Europe/Skopje',
        v_from, v_to, v_wh.code, v_art.name;

  RETURN jsonb_build_object(
    'article', jsonb_build_object('code', v_art.code, 'name', v_art.name, 'unit', v_art.unit,
                                  'cost_mkd', public.stock_v2_cost_at(v_art.code, now())),
    'warehouse', public.stock_v2_wh_ref(v_wh.id),
    'preview', v_prev,
    'series', v_body -> 'series',
    'moves', v_body -> 'moves');
END
$fn$;

COMMENT ON FUNCTION public.stock_v2_article_series(text, text, date, date, boolean) IS
  'GET stock/v2/article → StockArticleSeries: one article in one warehouse per Skopje day (opening, out, back, in, other_out, adjust, closing; default the last 30 days, at most 400) + its moves newest first (≤ 200, balance_after). article.cost_mkd is always present — the api strips it for non-owners. Migration 20260945000500.';

-- ── 5. parcels of a day (StockParcelsDay) ───────────────────────────────────
-- p_filters: {warehouse, account, department, status (ParcelStatusGroup), city, state}
CREATE OR REPLACE FUNCTION public.stock_v2_parcels_day(
  p_day     date,
  p_filters jsonb   DEFAULT '{}'::jsonb,
  p_limit   integer DEFAULT 100,
  p_offset  integer DEFAULT 0,
  p_money   boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET work_mem = '64MB'
SET jit = off
AS $fn$
DECLARE
  v_f      jsonb := coalesce(p_filters, '{}'::jsonb);
  v_start  timestamptz;
  v_end    timestamptz;
  v_wh     smallint;
  v_limit  integer := least(greatest(coalesce(p_limit, 100), 0), 1000);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_out    jsonb;
BEGIN
  IF p_day IS NULL THEN RAISE EXCEPTION 'stock_v2_parcels_day: day required' USING ERRCODE = '22023'; END IF;
  IF jsonb_typeof(v_f) <> 'object' THEN RAISE EXCEPTION 'stock_v2_parcels_day: bad filters' USING ERRCODE = '22023'; END IF;
  IF nullif(v_f ->> 'warehouse', '') IS NOT NULL THEN
    v_wh := public.stock_v2_wh(v_f ->> 'warehouse');
    IF v_wh IS NULL THEN RAISE EXCEPTION 'stock_v2_parcels_day: unknown warehouse %', v_f ->> 'warehouse' USING ERRCODE = '22023'; END IF;
  END IF;
  v_start := (p_day::timestamp) AT TIME ZONE 'Europe/Skopje';
  v_end   := ((p_day + 1)::timestamp) AT TIME ZONE 'Europe/Skopje';

  WITH
  pv AS MATERIALIZED (SELECT * FROM public.stock_v2_parcels(v_start, v_end) x WHERE x.state <> 'test_phone'),
  mp AS MATERIALIZED (
    SELECT p.tracking_id, p.receiver_city, p.cod_mkd, p.picked_up_at, p.order_id, p.sender_reference
    FROM public.mex_parcels p WHERE p.tracking_id IN (SELECT pv.tracking_id FROM pv)
  ),
  wcl AS (
    SELECT DISTINCT w.mex_tracking_id AS tr
    FROM public.web_orders w
    WHERE w.mex_tracking_id IN (SELECT pv.tracking_id FROM pv) AND w.deleted_in_shop_at IS NULL
  ),
  ocl AS (
    SELECT DISTINCT ON (o.mex_tracking_id) o.mex_tracking_id AS tr, o.sale_source, o.sale_source_detail, o.dept_override
    FROM public.orders o
    WHERE o.mex_tracking_id IN (SELECT pv.tracking_id FROM pv) AND o.sale_source_detail IS DISTINCT FROM 'disposition'
    ORDER BY o.mex_tracking_id, o.created_at, o.id
  ),
  olk AS (
    SELECT o.id, o.sale_source, o.sale_source_detail, o.mex_tracking_id, o.dept_override
    FROM public.orders o
    WHERE o.id IN (SELECT mp.order_id FROM mp WHERE mp.order_id IS NOT NULL)
      AND o.sale_source_detail IS DISTINCT FROM 'disposition'
  ),
  cz AS (
    SELECT c.city, z.zone
    FROM (SELECT DISTINCT mp.receiver_city AS city FROM mp WHERE nullif(btrim(mp.receiver_city), '') IS NOT NULL) c
    LEFT JOIN LATERAL (SELECT y.mex_city_name AS zone FROM public.mex_zone_for_name(c.city) y LIMIT 1) z ON true
  ),
  rw AS MATERIALIZED (
    SELECT pv.*, mp.receiver_city AS city, cz.zone, mp.cod_mkd, mp.picked_up_at,
           CASE WHEN wcl.tr IS NOT NULL THEN 'web'
                WHEN ocl.tr IS NOT NULL THEN public.cohort_order_source(ocl.sale_source, ocl.sale_source_detail, ocl.tr, ocl.dept_override)
                WHEN olk.id IS NOT NULL THEN public.cohort_order_source(olk.sale_source, olk.sale_source_detail, olk.mex_tracking_id, olk.dept_override)
                ELSE public.cohort_parcel_source(public.cohort_parcel_split(pv.account, pv.series, pv.tracking_id, mp.sender_reference))
           END AS department,
           CASE WHEN pv.status_id IS NULL THEN NULL
                WHEN pv.status_id = 2 THEN 'delivered' WHEN pv.status_id = 7 THEN 'returned'
                WHEN pv.status_id = 8 THEN 'to_pack' WHEN pv.status_id IN (3, 9, 13) THEN 'problem'
                ELSE 'with_courier' END AS status_group,
           pv.created_at_mex >= v_start AND pv.created_at_mex < v_end AS created_today
    FROM pv
    JOIN mp ON mp.tracking_id = pv.tracking_id
    LEFT JOIN cz ON cz.city = mp.receiver_city
    LEFT JOIN wcl ON wcl.tr = pv.tracking_id
    LEFT JOIN ocl ON ocl.tr = pv.tracking_id
    LEFT JOIN olk ON olk.id = mp.order_id AND ocl.tr IS NULL
  ),
  fx AS MATERIALIZED (       -- every filter except status / state (the returns total uses these)
    SELECT rw.* FROM rw
    WHERE (nullif(v_f ->> 'account', '') IS NULL OR rw.account = v_f ->> 'account')
      AND (nullif(v_f ->> 'department', '') IS NULL OR rw.department = v_f ->> 'department')
      AND (nullif(v_f ->> 'city', '') IS NULL OR rw.city = v_f ->> 'city')
  ),
  f AS MATERIALIZED (
    SELECT fx.* FROM fx
    WHERE fx.created_today
      AND (v_wh IS NULL OR fx.warehouse_id = v_wh)
      AND (nullif(v_f ->> 'status', '') IS NULL OR fx.status_group = v_f ->> 'status')
      AND (nullif(v_f ->> 'state', '') IS NULL OR fx.state = v_f ->> 'state')
  ),
  hp AS (                    -- pickups of the day by hour (any creation day)
    SELECT extract(hour FROM p.picked_up_at AT TIME ZONE 'Europe/Skopje')::integer AS h, count(*) AS n
    FROM public.mex_parcels p
    WHERE p.picked_up_at >= v_start AND p.picked_up_at < v_end
      AND (nullif(v_f ->> 'account', '') IS NULL OR p.account = v_f ->> 'account')
      AND NOT coalesce(p.phone8 = ANY (public.report_excluded_phone8s()), false)
    GROUP BY 1
  ),
  hc AS (
    SELECT extract(hour FROM f.created_at_mex AT TIME ZONE 'Europe/Skopje')::integer AS h, count(*) AS n
    FROM f GROUP BY 1
  )
  SELECT jsonb_build_object(
    'totals', jsonb_build_object(
      'parcels', (SELECT count(*) FROM f),
      'units', (SELECT coalesce(sum(f.units), 0) FROM f),
      'gift_units', (SELECT coalesce(sum(f.gift_units), 0) FROM f),
      'returned_units', (SELECT coalesce(sum(fx.units_back), 0) FROM fx
                          WHERE fx.ret_at >= v_start AND fx.ret_at < v_end
                            AND (v_wh IS NULL OR fx.return_warehouse_id = v_wh))),
    'hourly', (SELECT jsonb_agg(jsonb_build_object('hour', g.h, 'created', coalesce(hc.n, 0), 'picked_up', coalesce(hp.n, 0)) ORDER BY g.h)
                 FROM generate_series(0, 23) g(h) LEFT JOIN hc ON hc.h = g.h LEFT JOIN hp ON hp.h = g.h),
    'by_account', (SELECT coalesce(jsonb_agg(jsonb_build_object('key', x.k, 'parcels', x.n, 'units', x.u) ORDER BY x.n DESC, x.k), '[]'::jsonb)
                     FROM (SELECT f.account AS k, count(*) AS n, sum(f.units) AS u FROM f GROUP BY 1) x),
    'by_department', (SELECT coalesce(jsonb_agg(jsonb_build_object('key', x.k, 'parcels', x.n, 'units', x.u)
                                                ORDER BY array_position(ARRAY['altercpa', 'elyon_crm', 'teleshop_out', 'teleshop_other', 'social', 'web'], x.k), x.k), '[]'::jsonb)
                        FROM (SELECT f.department AS k, count(*) AS n, sum(f.units) AS u FROM f GROUP BY 1) x),
    'by_status', (SELECT coalesce(jsonb_agg(jsonb_build_object('key', x.k, 'parcels', x.n, 'units', x.u)
                                            ORDER BY array_position(ARRAY['to_pack', 'with_courier', 'problem', 'delivered', 'returned'], x.k)), '[]'::jsonb)
                    FROM (SELECT f.status_group AS k, count(*) AS n, sum(f.units) AS u FROM f GROUP BY 1) x),
    'by_city', (SELECT coalesce(jsonb_agg(jsonb_build_object('key', x.k, 'zone', x.z, 'parcels', x.n, 'units', x.u) ORDER BY x.n DESC, x.k), '[]'::jsonb)
                  FROM (SELECT f.city AS k, max(f.zone) AS z, count(*) AS n, sum(f.units) AS u FROM f
                         GROUP BY 1 ORDER BY count(*) DESC, f.city LIMIT 30) x),
    'rows', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                 'tracking_id', y.tracking_id, 'account', y.account, 'series', y.series, 'department', y.department,
                 'status_id', y.status_id, 'status_group', y.status_group, 'created_at_mex', y.created_at_mex,
                 'picked_up_at', y.picked_up_at, 'delivered_at', y.delivered_at, 'returned_at', y.returned_at,
                 'city', y.city, 'zone', y.zone, 'units', y.units, 'gift_units', y.gift_units,
                 'lines_source', y.lines_source, 'state', y.state)
                 || CASE WHEN coalesce(p_money, false) THEN jsonb_build_object('cod_mkd', y.cod_mkd) ELSE '{}'::jsonb END
               ORDER BY y.created_at_mex DESC, y.tracking_id), '[]'::jsonb)
             FROM (SELECT * FROM f ORDER BY f.created_at_mex DESC, f.tracking_id LIMIT v_limit OFFSET v_offset) y),
    'total_rows', (SELECT count(*) FROM f))
    INTO v_out;

  RETURN jsonb_build_object('day', to_char(p_day, 'YYYY-MM-DD'),
                            'warehouse', CASE WHEN v_wh IS NOT NULL THEN public.stock_v2_wh_ref(v_wh) ELSE 'null'::jsonb END)
         || v_out;
END
$fn$;

COMMENT ON FUNCTION public.stock_v2_parcels_day(date, jsonb, integer, integer, boolean) IS
  'GET stock/v2/parcels → StockParcelsDay: the parcels MEX created on one Skopje day (test phones never), filtered by warehouse / account / department (the cohort''s rule) / status group / city / stock state, with totals (+ units returned that day), created and picked-up per hour, breakdowns and a page of rows (no receiver name or phone; cod_mkd only with p_money). Migration 20260945000500.';

-- ── 6. the movements page (StockMovementsPage) ──────────────────────────────
-- p_filters: {from, to (inclusive Skopje days 'YYYY-MM-DD'), warehouse (code), article (code), kind, source,
--             q (article code / name, tracking id, Sigma document, source key), corrections (true = only the
--             corrections, false = without them, absent = all; 'only' / 'hide' accepted too), preview (bool)}
CREATE OR REPLACE FUNCTION public.stock_v2_movements(p_filters jsonb DEFAULT '{}'::jsonb, p_limit integer DEFAULT 100, p_offset integer DEFAULT 0)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET work_mem = '64MB'
SET jit = off
AS $fn$
DECLARE
  v_f      jsonb := coalesce(p_filters, '{}'::jsonb);
  v_prev   boolean;
  v_wh     smallint;
  v_art    text := nullif(upper(btrim(coalesce(v_f ->> 'article', ''))), '');
  v_from   timestamptz;
  v_to     timestamptz;
  v_limit  integer := least(greatest(coalesce(p_limit, 100), 0), 1000);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_q      text := nullif(btrim(coalesce(v_f ->> 'q', '')), '');
  v_out    jsonb;
BEGIN
  IF jsonb_typeof(v_f) <> 'object' THEN RAISE EXCEPTION 'stock_v2_movements: bad filters' USING ERRCODE = '22023'; END IF;
  v_prev := CASE WHEN jsonb_typeof(v_f -> 'preview') = 'boolean' THEN (v_f ->> 'preview')::boolean
                 ELSE NOT public.stock_v2_enabled() END;
  IF nullif(v_f ->> 'warehouse', '') IS NOT NULL THEN
    v_wh := public.stock_v2_wh(v_f ->> 'warehouse');
    IF v_wh IS NULL THEN RAISE EXCEPTION 'stock_v2_movements: unknown warehouse %', v_f ->> 'warehouse' USING ERRCODE = '22023'; END IF;
  END IF;
  IF (v_f ->> 'from') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN v_from := ((v_f ->> 'from')::date::timestamp) AT TIME ZONE 'Europe/Skopje'; END IF;
  IF (v_f ->> 'to') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN v_to := (((v_f ->> 'to')::date + 1)::timestamp) AT TIME ZONE 'Europe/Skopje'; END IF;

  EXECUTE format($q$
WITH
b AS MATERIALIZED (
  SELECT m.*,
         CASE WHEN $1::smallint IS NOT NULL AND $2::text IS NOT NULL
              THEN sum(m.qty) OVER (ORDER BY m.event_at, m.ord ROWS UNBOUNDED PRECEDING) END AS bal
  FROM %s m
  WHERE ($1::smallint IS NULL OR m.warehouse_id = $1) AND ($2::text IS NULL OR m.article_code = $2)
),
f AS MATERIALIZED (
  SELECT b.* FROM b
  LEFT JOIN public.stock_articles a ON a.code = b.article_code
  WHERE ($3::timestamptz IS NULL OR b.event_at >= $3) AND ($4::timestamptz IS NULL OR b.event_at < $4)
    AND ($5::text IS NULL OR b.kind = $5) AND ($6::text IS NULL OR b.source = $6)
    AND ($7::text IS NULL OR (CASE WHEN $7 IN ('only', 'true') THEN b.correction
                                   WHEN $7 IN ('hide', 'false') THEN NOT b.correction ELSE true END))
    AND ($8::text IS NULL OR b.source_key ILIKE '%%' || $8 || '%%' OR b.tracking_id ILIKE '%%' || $8 || '%%'
         OR b.sigma_doc ILIKE '%%' || $8 || '%%' OR a.name ILIKE '%%' || $8 || '%%' OR b.article_code = upper($8))
)
SELECT jsonb_build_object(
  'total', (SELECT count(*) FROM f),
  'rows', (SELECT coalesce(jsonb_agg(jsonb_build_object(
              'id', y.id, 'event_at', y.event_at, 'recorded_at', y.recorded_at,
              'late_days', greatest(0, floor(extract(epoch FROM y.recorded_at - y.event_at) / 86400))::integer,
              'warehouse_code', w.code, 'article_code', y.article_code, 'article_name', coalesce(a.name, y.article_code),
              'qty', y.qty, 'kind', y.kind, 'source', y.source, 'source_key', y.source_key,
              'tracking_id', y.tracking_id, 'sigma_doc', y.sigma_doc,
              'sigma_versions', sd.versions, 'count_id', y.count_id, 'manual_id', y.manual_id,
              'correction', y.correction, 'provisional', y.provisional)
              || CASE WHEN y.bal IS NOT NULL THEN jsonb_build_object('balance_after', round(y.bal, 3)) ELSE '{}'::jsonb END
            ORDER BY y.event_at DESC, y.ord DESC), '[]'::jsonb)
           FROM (SELECT * FROM f ORDER BY f.event_at DESC, f.ord DESC LIMIT $9 OFFSET $10) y
           JOIN public.stock_warehouses w ON w.id = y.warehouse_id
           LEFT JOIN public.stock_articles a ON a.code = y.article_code
           LEFT JOIN public.stock_sigma_docs sd ON sd.doc_key = y.sigma_doc))
$q$, public.stock_v2_moves_sql(v_prev))
  INTO v_out
  USING v_wh, v_art, v_from, v_to, nullif(v_f ->> 'kind', ''), nullif(v_f ->> 'source', ''),
        nullif(v_f ->> 'corrections', ''), v_q, v_limit, v_offset;

  RETURN v_out || jsonb_build_object('preview', v_prev);
END
$fn$;

COMMENT ON FUNCTION public.stock_v2_movements(jsonb, integer, integer) IS
  'GET stock/v2/movements → StockMovementsPage {rows, total} (+ preview): the ledger (or, filters.preview / switched off, stock_v2_desired()) filtered by inclusive Skopje from/to, warehouse, article, kind, source, q, corrections (true = only, false = without), newest first; balance_after when one article AND one warehouse are filtered. Migration 20260945000500.';

-- ── 7. health (StockHealth) ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.stock_v2_health(p_detail boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET work_mem = '64MB'
SET jit = off
AS $fn$
DECLARE
  v_enabled boolean := public.stock_v2_enabled();
  v_detail  boolean := coalesce(p_detail, true);
  v_pending jsonb;
  v_neg     jsonb := '[]'::jsonb;
  v_queues  jsonb;
  v_sigma   jsonb;
BEGIN
  -- desired vs applied, and the negatives (the ledger when on, the preview when off) — ONE desired()
  WITH
  d AS MATERIALIZED (
    SELECT x.source_key, x.kind, x.article_code, x.warehouse_id, x.event_at, sum(x.qty) AS q
    FROM public.stock_v2_desired() x GROUP BY 1, 2, 3, 4, 5
  ),
  a AS MATERIALIZED (
    SELECT m.source_key, m.kind, m.article_code, m.warehouse_id, m.event_at, sum(m.qty) AS q
    FROM public.stock_moves m GROUP BY 1, 2, 3, 4, 5
  ),
  j AS (
    SELECT coalesce(d.q, 0) - coalesce(a.q, 0) AS delta
    FROM d FULL JOIN a ON a.source_key = d.source_key AND a.kind = d.kind AND a.article_code = d.article_code
                      AND a.warehouse_id = d.warehouse_id AND a.event_at = d.event_at
    WHERE coalesce(d.q, 0) <> coalesce(a.q, 0)
  ),
  oh AS (
    SELECT s.warehouse_id, s.article_code, sum(s.q) AS q
    FROM (SELECT * FROM d WHERE NOT v_enabled UNION ALL SELECT * FROM a WHERE v_enabled) s
    WHERE s.event_at <= now()
    GROUP BY 1, 2
    HAVING sum(s.q) < 0
  )
  SELECT jsonb_build_object('groups', (SELECT count(*) FROM j), 'units', (SELECT coalesce(sum(abs(j.delta)), 0) FROM j)),
         CASE WHEN v_detail THEN
           (SELECT coalesce(jsonb_agg(jsonb_build_object('warehouse', w.code, 'code', oh.article_code,
                                                         'name', coalesce(sa.name, oh.article_code), 'qty', round(oh.q, 3))
                                      ORDER BY oh.q, oh.article_code), '[]'::jsonb)
              FROM oh JOIN public.stock_warehouses w ON w.id = oh.warehouse_id
              LEFT JOIN public.stock_articles sa ON sa.code = oh.article_code)
         ELSE '[]'::jsonb END
    INTO v_pending, v_neg;

  -- the review queues over every parcel in scope
  WITH p AS MATERIALIZED (SELECT * FROM public.stock_v2_parcels(NULL, NULL)),
  um AS (
    SELECT coalesce(p.lines_source, 'none') AS source, e ->> 'code' AS code, coalesce(e ->> 'name', e ->> 'code', '?') AS name,
           sum(public.stock_v2_num(e ->> 'qty')) AS units, count(DISTINCT p.tracking_id) AS parcels
    FROM p CROSS JOIN LATERAL jsonb_array_elements(p.unmapped) e
    GROUP BY 1, 2, 3
  )
  SELECT jsonb_build_object(
    'unmapped', CASE WHEN v_detail THEN
                  (SELECT coalesce(jsonb_agg(jsonb_build_object('source', x.source, 'code', x.code, 'name', x.name,
                                                                'units', x.units, 'parcels', x.parcels)
                                             ORDER BY x.units DESC, x.name), '[]'::jsonb)
                     FROM (SELECT * FROM um ORDER BY um.units DESC, um.name LIMIT 50) x)
                ELSE '[]'::jsonb END,
    'no_lines', (SELECT count(*) FROM p WHERE p.state = 'no_lines'),
    'no_route', (SELECT count(*) FROM p WHERE p.state = 'no_route'),
    'test_phone', (SELECT count(*) FROM p WHERE p.state = 'test_phone'),
    'stale_labels', (SELECT count(*) FROM p WHERE 'stale_label' = ANY (p.flags)),
    'possible_relabels', (SELECT count(*) FROM p WHERE 'possible_relabel' = ANY (p.flags)),
    'waiting_lines', (SELECT count(*) FROM p WHERE p.state = 'waiting_lines'),
    'unmapped_parcels', (SELECT count(*) FROM p WHERE p.state IN ('unmapped', 'partial')),
    'states', (SELECT coalesce(jsonb_object_agg(s.state, s.n), '{}'::jsonb)
                 FROM (SELECT p.state, count(*) AS n FROM p GROUP BY 1) s))
    INTO v_queues;

  SELECT jsonb_build_object(
    'last_batch_at', (SELECT max(b.received_at) FROM public.stock_sigma_batches b),
    'connector_last_seen', (SELECT max(b.received_at) FROM public.stock_sigma_batches b WHERE b.source = 'connector'),
    'docs_staged', (SELECT count(*) FROM public.stock_sigma_docs d WHERE d.vanished_at IS NULL),
    'docs_excluded', (SELECT count(*) FROM public.stock_sigma_docs d
                       WHERE d.vanished_at IS NULL
                         AND (d.excluded_reason IS NOT NULL
                              OR public.stock_v2_sigma_excluded(d.doc_key, d.doc_type, d.client_code,
                                                                d.company_from, d.object_from, d.company_to, d.object_to))),
    'docs_versions_gt1', (SELECT count(*) FROM public.stock_sigma_docs d WHERE d.versions > 1),
    'docs_type_not_included', (SELECT count(*) FROM public.stock_sigma_docs d
                                WHERE d.vanished_at IS NULL
                                  AND NOT EXISTS (SELECT 1 FROM public.stock_sigma_doc_types t WHERE t.doc_type = d.doc_type AND t.include)),
    'unknown_items', (SELECT count(DISTINCT btrim(e ->> 'item_code')) FROM public.stock_sigma_docs d
                       CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(d.lines) = 'array' THEN d.lines ELSE '[]'::jsonb END) e
                       WHERE d.vanished_at IS NULL
                         AND NOT EXISTS (SELECT 1 FROM public.stock_articles a WHERE a.code = btrim(e ->> 'item_code'))))
    INTO v_sigma;

  RETURN jsonb_build_object(
    'enabled', v_enabled,
    'preview_available', true,
    'openings', coalesce((SELECT jsonb_agg(jsonb_build_object('warehouse', w.code, 'count_id', c.id, 'counted_at', c.counted_at,
                                                              'status', c.status, 'source', c.source)
                                           ORDER BY w.sort, c.counted_at)
                            FROM public.stock_wh_counts c JOIN public.stock_warehouses w ON w.id = c.warehouse_id
                           WHERE c.kind = 'opening' AND c.status <> 'void'), '[]'::jsonb),
    'last_run', (SELECT jsonb_build_object('at', r.started_at, 'status', r.status, 'trigger', r.trigger,
                                           'stats', coalesce(r.stats, '{}'::jsonb) || jsonb_build_object('error', r.error))
                   FROM public.stock_runs r WHERE NOT r.dry ORDER BY r.started_at DESC LIMIT 1),
    'pending', v_pending,
    'queues', v_queues,
    'negatives', v_neg,
    'uncosted_articles', (SELECT count(*) FROM public.stock_articles a
                           WHERE a.active AND NOT EXISTS (SELECT 1 FROM public.stock_article_costs c WHERE c.article_code = a.code)),
    'recipes', jsonb_build_object(
      'products_active', (SELECT count(*) FROM public.products p WHERE p.is_active),
      'with_approved_recipe', (SELECT count(DISTINCT pa.product_id) FROM public.product_articles pa
                                 JOIN public.products p ON p.id = pa.product_id AND p.is_active
                                WHERE pa.status = 'approved' AND (pa.valid_to IS NULL OR pa.valid_to > now())),
      'proposed', (SELECT count(DISTINCT pa.product_id) FROM public.product_articles pa WHERE pa.status = 'proposed'),
      'exempt', (SELECT count(*) FROM public.product_stock_exempt)),
    'sigma', v_sigma);
END
$fn$;

COMMENT ON FUNCTION public.stock_v2_health(boolean) IS
  'GET stock/v2/health → StockHealth: switch, openings, last run, pending (desired vs applied groups / units), review queues over every parcel in scope (unmapped lines, no_lines, no_route, test_phone, stale / relabel labels, waiting), negatives (ledger when on, preview when off), uncosted articles, recipe coverage, Sigma staging. No money. Migration 20260945000500.';

-- ── 8. Sigma's MEX invoice (000217) against what MEX delivered ──────────────
CREATE OR REPLACE FUNCTION public.stock_v2_sigma_month_check(p_month date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET work_mem = '64MB'
SET jit = off
AS $fn$
DECLARE
  v_m0  date;
  v_m1  date;
  v_s   timestamptz;
  v_e   timestamptz;
  v_out jsonb;
BEGIN
  IF p_month IS NULL THEN RAISE EXCEPTION 'stock_v2_sigma_month_check: month required' USING ERRCODE = '22023'; END IF;
  v_m0 := date_trunc('month', p_month)::date;
  v_m1 := (v_m0 + interval '1 month')::date;
  v_s  := (v_m0::timestamp) AT TIME ZONE 'Europe/Skopje';
  v_e  := (v_m1::timestamp) AT TIME ZONE 'Europe/Skopje';

  WITH
  sd AS (
    SELECT d.doc_key, d.lines FROM public.stock_sigma_docs d
    WHERE d.client_code = '000217' AND d.doc_date >= v_m0 AND d.doc_date < v_m1 AND d.vanished_at IS NULL
  ),
  si AS (
    SELECT btrim(e ->> 'item_code') AS code, sum(public.stock_v2_num(e ->> 'qty')) AS q
    FROM sd CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(sd.lines) = 'array' THEN sd.lines ELSE '[]'::jsonb END) e
    GROUP BY 1
  ),
  pv AS MATERIALIZED (
    SELECT * FROM public.stock_v2_parcels(v_s - interval '45 days', v_e) x
    WHERE x.status_id = 2 AND x.delivered_at >= v_s AND x.delivered_at < v_e AND x.state <> 'test_phone'
  ),
  mi AS (
    SELECT a.key AS code, sum(a.value::numeric) AS q
    FROM pv CROSS JOIN LATERAL jsonb_each_text(pv.articles) a
    GROUP BY 1
  ),
  j AS (
    SELECT coalesce(si.code, mi.code) AS code, coalesce(si.q, 0) AS sigma_qty, coalesce(mi.q, 0) AS delivered_qty
    FROM si FULL JOIN mi ON mi.code = si.code
  )
  SELECT jsonb_build_object(
    'month', to_char(v_m0, 'YYYY-MM'),
    'sigma', jsonb_build_object('docs', (SELECT count(*) FROM sd), 'units', (SELECT coalesce(sum(si.q), 0) FROM si)),
    'mex', jsonb_build_object('parcels', (SELECT count(*) FROM pv), 'units', (SELECT coalesce(sum(mi.q), 0) FROM mi),
                              'unmapped_parcels', (SELECT count(*) FROM pv WHERE pv.state IN ('unmapped', 'partial', 'no_lines'))),
    'unknown_items', (SELECT count(*) FROM si WHERE NOT EXISTS (SELECT 1 FROM public.stock_articles a WHERE a.code = si.code)),
    'articles', (SELECT coalesce(jsonb_agg(jsonb_build_object('code', j.code, 'name', a.name, 'sigma_qty', round(j.sigma_qty, 3),
                                                              'delivered_qty', round(j.delivered_qty, 3),
                                                              'diff', round(j.sigma_qty - j.delivered_qty, 3))
                                           ORDER BY abs(j.sigma_qty - j.delivered_qty) DESC, j.code), '[]'::jsonb)
                   FROM j LEFT JOIN public.stock_articles a ON a.code = j.code))
    INTO v_out;
  RETURN v_out;
END
$fn$;

COMMENT ON FUNCTION public.stock_v2_sigma_month_check(date) IS
  'GET stock/v2/sigma/month-check: Sigma''s МЕКС ПОШТА invoice lines (client 000217, never moved) of one month against the articles in the parcels MEX delivered that month (Skopje) — per article sigma_qty, delivered_qty, diff. Migration 20260945000500.';

-- ── 9. grants ───────────────────────────────────────────────────────────────
DO $grants$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.stock_v2_moves_sql(boolean)', 'public.stock_v2_wh_ref(smallint)', 'public.stock_v2_freshness()',
    'public.stock_v2_position_at(timestamptz, text, boolean)', 'public.stock_v2_on_hand(timestamptz, text, boolean)',
    'public.stock_v2_reserved_lines()', 'public.stock_v2_reserved_now()',
    'public.stock_v2_day(date, text, time, boolean, boolean)',
    'public.stock_v2_article_series(text, text, date, date, boolean)',
    'public.stock_v2_parcels_day(date, jsonb, integer, integer, boolean)',
    'public.stock_v2_movements(jsonb, integer, integer)',
    'public.stock_v2_health(boolean)', 'public.stock_v2_sigma_month_check(date)']
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO supabase_read_only_user', f);
    END IF;
  END LOOP;
END
$grants$;

NOTIFY pgrst, 'reload schema';

COMMIT;
