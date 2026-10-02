-- Insights speed (owner 02.10.2026, the floor closed). insights_sales part = 'detail' (the Overview's
-- top products and the Sales tab) spent ~1,45 s in "bought before" (bp): a scan of every order with a
-- regexp per phone, every parcel and every web order, hashed against the window's buyers. Now:
--   bp    per BUYER, three probes of the last-8 indexes (idx_orders_phone_last8 — the expression is
--         character-for-character its own —, idx_mex_parcels_phone8, idx_web_orders_phone8), each a
--         scalar sub-select that stops at the first hit, the next only when the one before found none.
--   wbo   OFFSET 0 keeps the shop's classifier above the DISTINCT: the planner had pushed it below,
--         onto every web order (~24k calls), instead of once per distinct (status, payment).
-- Nothing else changes (core / summary are the same text). Measured before the switch (EXPLAIN
-- ANALYZE, the new body as a session-only function, still over the old insights_sale_rows):
-- detail today 1.903 → ~915 ms, September 2.817 → ~1.870 ms (and 20260947001500 cuts its rows).
-- Proof (same snapshot, old vs new): detail for today / yesterday / last 7 days / September / 2026,
-- core and summary for today / September, owner and non-owner — byte-identical JSON.

DO $guard$
BEGIN
  IF md5(pg_get_functiondef('public.insights_sales(timestamp with time zone,timestamp with time zone,text,boolean,integer)'::regprocedure)) <> '2bc884549d7717325a13139dd4ab6974' THEN
    RAISE EXCEPTION 'insights_sales changed since this migration was written: rebuild it from the live body';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.insights_sales(p_from timestamp with time zone, p_to_end timestamp with time zone, p_part text DEFAULT 'core'::text, p_money boolean DEFAULT false, p_top integer DEFAULT 40)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET "TimeZone" TO 'UTC'
 SET work_mem TO '64MB'
 SET jit TO 'off'
AS $function$
DECLARE
  v_part text := lower(coalesce(nullif(btrim(p_part), ''), 'core'));
  v_fd   date;
  v_td   date;
  v_gran text;
  v_top  integer := least(greatest(coalesce(p_top, 40), 5), 200);
  v_out  jsonb;
BEGIN
  IF p_from IS NULL OR p_to_end IS NULL THEN
    RAISE EXCEPTION 'insights_sales: p_from and p_to_end are required' USING ERRCODE = '22023';
  END IF;
  IF p_to_end < p_from OR p_to_end - p_from > interval '800 days' THEN
    RAISE EXCEPTION 'insights_sales: bad window' USING ERRCODE = '22023';
  END IF;
  IF v_part NOT IN ('core', 'detail', 'summary') THEN
    RAISE EXCEPTION 'insights_sales: unknown part %', v_part USING ERRCODE = '22023';
  END IF;

  v_fd   := (p_from   AT TIME ZONE 'Europe/Skopje')::date;
  v_td   := (p_to_end AT TIME ZONE 'Europe/Skopje')::date;
  v_gran := CASE WHEN v_td - v_fd + 1 <= 62 THEN 'day'
                 WHEN v_td - v_fd + 1 <= 190 THEN 'week'
                 ELSE 'month' END;

  -- $1 from · $2 to_end · $3 from day · $4 to day · $5 trend granularity ·
  -- $6 top N rows (products, cities) · $7 money (ranks by денари, else by
  -- packages — a non-owner's order never leaks the money ranking)
  IF v_part = 'core' THEN
    EXECUTE $core$
WITH
prm AS (
  SELECT $1::timestamptz AS f, $2::timestamptz AS t, $3::date AS fd, $4::date AS td, $5::text AS gran,
         '&sold_from=' || to_char($3::date, 'YYYY-MM-DD') || '&sold_to=' || to_char($4::date, 'YYYY-MM-DD') AS win_q
),
srcs AS (
  -- ss = the source's GET /orders cohort_source value (insights_cohort's twin)
  SELECT * FROM (VALUES ('altercpa', 1, 'altercpa'), ('elyon_crm', 2, 'elyon_crm'),
                        ('teleshop_out', 3, 'teleshop_out'), ('teleshop_other', 4, 'teleshop_other'),
                        ('social', 5, 'social'), ('web', 6, 'web'), ('management', 7, 'management')) v(key, ord, ss)
),
bks AS (
  SELECT * FROM (VALUES ('paid', 1, true), ('paid_unproven', 2, true), ('paid_legacy', 3, true),
                        ('courier', 4, true), ('courier_problem', 5, true), ('label', 6, true),
                        ('to_pack', 7, true), ('returned', 8, true),
                        ('cancelled_after_sale', 9, false), ('trashed_after_sale', 10, false),
                        ('replacement', 11, false)) v(key, ord, in_total)
),
-- THE cohort rows (foundation), once
r AS MATERIALIZED (
  SELECT s.kind, s.source, s.split, s.sale_source, s.sale_at, s.sale_day, s.bucket, s.in_total, s.value_mkd, s.cod_mkd,
         s.mex_account, s.mex_series, s.tracking_id,
         s.q_cancelled_but_moving, s.q_no_seller, s.q_zero_cod, s.q_double_count
  FROM public.insights_sale_rows($1, $2, false) s
),
-- ── the cohort block: the twin of insights_cohort's `ag` … `bj` ──────────
ag AS (
  SELECT coalesce(r.source, '*') AS src, r.bucket,
         count(*)                                   AS n,
         coalesce(sum(r.value_mkd), 0)              AS v,
         coalesce(sum(r.cod_mkd), 0)                AS c,
         count(*) FILTER (WHERE r.kind = 'order')   AS n_order,
         count(*) FILTER (WHERE r.kind = 'web')     AS n_web,
         count(*) FILTER (WHERE r.kind = 'mex')     AS n_mex,
         count(*) FILTER (WHERE r.kind = 'booking') AS n_booking
  FROM r
  GROUP BY GROUPING SETS ((r.source, r.bucket), (r.bucket))
),
scopes AS (
  SELECT '*'::text AS src, 0 AS ord, NULL::text AS ss
  UNION ALL
  SELECT s.key, s.ord, s.ss FROM srcs s
),
bx AS (
  SELECT sc.src, sc.ss, b.key, b.ord, b.in_total,
         coalesce(a.n, 0) AS n, coalesce(a.v, 0) AS v, coalesce(a.c, 0) AS c,
         coalesce(a.n_order, 0) AS n_order, coalesce(a.n_web, 0) AS n_web, coalesce(a.n_mex, 0) AS n_mex,
         coalesce(a.n_booking, 0) AS n_booking
  FROM scopes sc
  CROSS JOIN bks b
  LEFT JOIN ag a ON a.src = sc.src AND a.bucket = b.key
),
bj AS (
  SELECT x.src,
    jsonb_agg(jsonb_build_object(
      'key', x.key, 'count', x.n, 'value_mkd', round(x.v), 'cod_mkd', round(x.c),
      'orders', x.n_order, 'web', x.n_web, 'mex_only', x.n_mex, 'booked', x.n_booking,
      'drill', CASE WHEN x.n_order > 0 THEN
                 '/orders?cohort_bucket=' || x.key || coalesce('&cohort_source=' || x.ss, '') || prm.win_q END)
      ORDER BY x.ord) FILTER (WHERE x.in_total) AS buckets,
    jsonb_agg(jsonb_build_object(
      'key', x.key, 'count', x.n, 'value_mkd', round(x.v),
      'orders', x.n_order, 'web', x.n_web, 'mex_only', x.n_mex, 'booked', x.n_booking,
      'drill', CASE WHEN x.n_order > 0 THEN
                 '/orders?cohort_bucket=' || x.key || coalesce('&cohort_source=' || x.ss, '') || prm.win_q END)
      ORDER BY x.ord) FILTER (WHERE NOT x.in_total) AS outside,
    jsonb_build_object(
      'count', coalesce(sum(x.n) FILTER (WHERE x.in_total), 0),
      'value_mkd', round(coalesce(sum(x.v) FILTER (WHERE x.in_total), 0)),
      'cod_mkd', round(coalesce(sum(x.c) FILTER (WHERE x.in_total), 0)),
      'orders', coalesce(sum(x.n_order) FILTER (WHERE x.in_total), 0),
      'web', coalesce(sum(x.n_web) FILTER (WHERE x.in_total), 0),
      'mex_only', coalesce(sum(x.n_mex) FILTER (WHERE x.in_total), 0),
      'booked', coalesce(sum(x.n_booking) FILTER (WHERE x.in_total), 0),
      'drill', CASE WHEN coalesce(sum(x.n_order) FILTER (WHERE x.in_total), 0) > 0 THEN
                 '/orders?cohort_bucket=total' || coalesce('&cohort_source=' || max(x.ss), '') || max(prm.win_q) END) AS total
  FROM bx x
  CROSS JOIN prm
  GROUP BY x.src
),
spj AS (                   -- splits: what each source's total is made of
  SELECT sp.source,
    jsonb_agg(jsonb_build_object(
      'key', sp.split, 'kind', sp.kind, 'count', sp.n, 'value_mkd', round(sp.v),
      'drill', CASE WHEN sp.kind = 'order' AND sp.split <> 'none' AND sp.split ~* '^[a-z0-9_.-]{1,40}$' THEN
                 '/orders?cohort_bucket=total&cohort_source=' || s.ss || '&sale_source_detail=' || sp.split || prm.win_q END)
      ORDER BY sp.n DESC, sp.split) AS j
  FROM (SELECT r.source, r.split, r.kind, count(*) AS n, sum(r.value_mkd) AS v
          FROM r WHERE r.in_total GROUP BY r.source, r.split, r.kind) sp
  JOIN srcs s ON s.key = sp.source
  CROSS JOIN prm
  GROUP BY sp.source
),
-- ── trend by source (sale day; day ≤ 62 days, week ≤ 190, else month) ────
tk AS (
  SELECT to_char(g, 'YYYY-MM-DD') AS d
  FROM prm, generate_series(date_trunc(prm.gran, prm.fd::timestamp), date_trunc(prm.gran, prm.td::timestamp),
                            ('1 ' || prm.gran)::interval) g
),
tv AS MATERIALIZED (
  SELECT to_char(date_trunc(prm.gran, r.sale_day::timestamp), 'YYYY-MM-DD') AS d, r.source,
         count(*) AS n, sum(r.value_mkd) AS v
  FROM r CROSS JOIN prm
  WHERE r.in_total
  GROUP BY 1, 2
),
tj AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'd', tk.d,
           'count', coalesce((SELECT sum(tv.n) FROM tv WHERE tv.d = tk.d), 0),
           'value_mkd', round(coalesce((SELECT sum(tv.v) FROM tv WHERE tv.d = tk.d), 0)),
           'by_source', (SELECT jsonb_agg(jsonb_build_object('key', s.key, 'count', coalesce(tv.n, 0),
                                                             'value_mkd', round(coalesce(tv.v, 0)))
                                          ORDER BY s.ord)
                           FROM srcs s LEFT JOIN tv ON tv.d = tk.d AND tv.source = s.key))
           ORDER BY tk.d), '[]'::jsonb) AS j
  FROM tk
),
-- ── MEX account / series: the channel a parcel names ─────────────────────
chs AS (
  SELECT CASE WHEN r.tracking_id IS NULL THEN NULL ELSE coalesce(r.mex_account, 'unknown') END AS account,
         CASE WHEN r.tracking_id IS NULL      THEN 'none'
              WHEN r.mex_series IS NOT NULL   THEN r.mex_series
              WHEN r.tracking_id ~ '^NTMK'    THEN 'ntmk'
              WHEN r.tracking_id ~ '^M[0-9]'  THEN 'm'
              ELSE 'other' END AS chan,
         r.source,
         count(*) AS n, coalesce(sum(r.value_mkd), 0) AS v, coalesce(sum(r.cod_mkd), 0) AS c,
         count(*) FILTER (WHERE r.bucket IN ('paid', 'paid_legacy', 'paid_unproven'))    AS paid,
         count(*) FILTER (WHERE r.bucket IN ('courier', 'courier_problem', 'label'))     AS courier,
         count(*) FILTER (WHERE r.bucket = 'to_pack')                                    AS to_pack,
         count(*) FILTER (WHERE r.bucket = 'returned')                                   AS returned
  FROM r
  WHERE r.in_total
  GROUP BY 1, 2, 3
),
chj AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'account', c.account, 'series', c.chan,
           'count', c.n, 'value_mkd', round(c.v), 'cod_mkd', round(c.c),
           'paid', c.paid, 'courier', c.courier, 'to_pack', c.to_pack, 'returned', c.returned,
           'by_source', c.bs)
           ORDER BY (c.chan = 'none'), c.n DESC, c.account, c.chan), '[]'::jsonb) AS j
  FROM (
    SELECT x.account, x.chan, sum(x.n) AS n, sum(x.v) AS v, sum(x.c) AS c,
           sum(x.paid) AS paid, sum(x.courier) AS courier, sum(x.to_pack) AS to_pack, sum(x.returned) AS returned,
           jsonb_agg(jsonb_build_object('key', x.source, 'count', x.n) ORDER BY s.ord) AS bs
    FROM chs x
    JOIN srcs s ON s.key = x.source
    GROUP BY x.account, x.chan
  ) c
),
-- ── when we sell: weekday × hour (Skopje). Only sales that carry a real
-- moment — an agent's decision (AlterCPA intake, a CRM sale) and web
-- checkouts. collabBox orders carry a date only (imported at 09:00) and a
-- MEX-only parcel's time is its label, not a sale: they are counted apart,
-- never smeared into the grid. By the ORDER's own sale_source, never its
-- department: a CRM sale shipped on a teleshop parcel is still a timed CRM
-- decision (20260942001000); the timed set is exactly the pre-six-department one.
tmr AS MATERIALIZED (
  SELECT r.kind, r.source, r.sale_at, r.sale_day, r.value_mkd,
         (r.kind = 'web' OR (r.kind = 'order' AND r.sale_source IN ('altercpa', 'affiliate', 'elyon_crm')
                             AND r.split NOT IN ('collabbox_out', 'collabbox_leads_out', 'team_collabbox_out', 'team_collabbox_leads_out', 'collabbox_leads'))) AS timed
  FROM r
  WHERE r.in_total
),
tmj AS (
  SELECT jsonb_build_object(
    'cells', (SELECT coalesce(jsonb_agg(jsonb_build_object('dow', c.dow, 'hour', c.h, 'count', c.n, 'value_mkd', round(c.v))
                                        ORDER BY c.dow, c.h), '[]'::jsonb)
                FROM (SELECT extract(isodow FROM tmr.sale_at AT TIME ZONE 'Europe/Skopje')::int AS dow,
                             extract(hour FROM tmr.sale_at AT TIME ZONE 'Europe/Skopje')::int AS h,
                             count(*) AS n, sum(tmr.value_mkd) AS v
                        FROM tmr WHERE tmr.timed GROUP BY 1, 2) c),
    'timed', (SELECT count(*) FROM tmr WHERE tmr.timed),
    'untimed', (SELECT coalesce(jsonb_agg(jsonb_build_object('key', u.key, 'kind', u.kind, 'count', u.n) ORDER BY u.n DESC), '[]'::jsonb)
                  FROM (SELECT tmr.source AS key, tmr.kind, count(*) AS n FROM tmr WHERE NOT tmr.timed
                         GROUP BY tmr.source, tmr.kind) u),
    -- every sale by its sale day's weekday, with how many such days the period has
    'weekdays', (SELECT jsonb_agg(jsonb_build_object('dow', g.dow, 'count', coalesce(w.n, 0), 'value_mkd', round(coalesce(w.v, 0)),
                                                     'days', coalesce(dd.days, 0))
                                  ORDER BY g.dow)
                   FROM generate_series(1, 7) g(dow)
                   LEFT JOIN (SELECT extract(isodow FROM tmr.sale_day)::int AS dow, count(*) AS n, sum(tmr.value_mkd) AS v
                                FROM tmr GROUP BY 1) w ON w.dow = g.dow
                   LEFT JOIN (SELECT extract(isodow FROM d)::int AS dow, count(*) AS days
                                FROM prm, generate_series(prm.fd::timestamp, prm.td::timestamp, interval '1 day') d
                               GROUP BY 1) dd ON dd.dow = g.dow)) AS j
),
-- ── quality: the cohort's five, exactly as insights_cohort counts them ────
qj AS (
  SELECT jsonb_build_array(
    jsonb_build_object('kind', 'unproven_paid',
      'count', count(*) FILTER (WHERE r.bucket = 'paid_unproven'),
      'value_mkd', round(coalesce(sum(r.value_mkd) FILTER (WHERE r.bucket = 'paid_unproven'), 0))),
    jsonb_build_object('kind', 'zero_cod_parcels',
      'count', count(*) FILTER (WHERE r.q_zero_cod),
      'value_mkd', round(coalesce(sum(r.cod_mkd) FILTER (WHERE r.q_zero_cod), 0))),
    jsonb_build_object('kind', 'double_count_candidates',
      'count', count(*) FILTER (WHERE r.q_double_count),
      'value_mkd', round(coalesce(sum(r.value_mkd) FILTER (WHERE r.q_double_count), 0))),
    jsonb_build_object('kind', 'no_seller',
      'count', count(*) FILTER (WHERE r.q_no_seller),
      'value_mkd', round(coalesce(sum(r.value_mkd) FILTER (WHERE r.q_no_seller), 0))),
    jsonb_build_object('kind', 'cancelled_but_moving',
      'count', count(*) FILTER (WHERE r.q_cancelled_but_moving),
      'value_mkd', round(coalesce(sum(r.value_mkd) FILTER (WHERE r.q_cancelled_but_moving), 0)))) AS j
  FROM r
)
SELECT jsonb_build_object(
  'meta', jsonb_build_object(
    'from', to_char(prm.fd, 'YYYY-MM-DD'),
    'to', to_char(prm.td, 'YYYY-MM-DD'),
    'generated_at', now(),
    'money', true,
    'clock', 'sale',
    'part', 'core',
    'granularity', prm.gran),
  'total',     b0.total,
  'buckets',   b0.buckets,
  'outside',   b0.outside,
  'by_source', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                  'key', s.key, 'total', bs.total, 'buckets', bs.buckets, 'outside', bs.outside,
                  'splits', coalesce(sj.j, '[]'::jsonb)) ORDER BY s.ord), '[]'::jsonb)
                FROM srcs s JOIN bj bs ON bs.src = s.key LEFT JOIN spj sj ON sj.source = s.key),
  'trend',     jsonb_build_object('granularity', prm.gran, 'points', (SELECT j FROM tj)),
  'channels',  (SELECT j FROM chj),
  'timing',    (SELECT j FROM tmj),
  'quality',   (SELECT j FROM qj))
FROM prm
JOIN bj b0 ON b0.src = '*'
$core$
    INTO v_out
    USING p_from, p_to_end, v_fd, v_td, v_gran, v_top, coalesce(p_money, false);
  ELSIF v_part = 'detail' THEN
    EXECUTE $detail$
WITH
prm AS (
  SELECT $1::timestamptz AS f, $2::timestamptz AS t, $3::date AS fd, $4::date AS td,
         $6::integer AS topn, $7::boolean AS money
),
srcs AS (
  SELECT * FROM (VALUES ('altercpa', 1), ('elyon_crm', 2), ('teleshop_out', 3), ('teleshop_other', 4),
                        ('social', 5), ('web', 6), ('management', 7)) v(key, ord)
),
-- THE cohort's sales (foundation) + the city the foundation would key them
-- by — its twin: the owned parcel's receiver_city (tracking_id is set only
-- when the sale owns a parcel), else the order's / web order's own city.
-- rid = a row id the line rows carry.
rt AS MATERIALIZED (
  SELECT row_number() OVER () AS rid,
         s.kind, s.source, s.sale_source, s.bucket, s.value_mkd, s.order_id, s.web_id, s.tracking_id,
         CASE WHEN s.phone8 ~ '^[0-9]{8}$' THEN s.phone8 END AS phone8,
         coalesce(nullif(btrim(p.receiver_city), ''),
                  CASE WHEN s.kind = 'order' THEN
                         (SELECT nullif(btrim(o.customer_city), '') FROM public.orders o WHERE o.id = s.order_id)
                       WHEN s.kind = 'web' THEN
                         (SELECT nullif(btrim(w.city), '') FROM public.web_orders w WHERE w.shop_order_id = s.web_id)
                  END) AS city_raw
  FROM public.insights_sale_rows($1, $2, false) s
  LEFT JOIN public.mex_parcels p ON p.tracking_id = s.tracking_id
  WHERE s.in_total
),
-- ── products: every line of every sale; the sale's value is spread over its
-- lines so Σ products + Σ other lines + Σ sales with no line = the total ──
ln0 AS MATERIALIZED (
  SELECT rt.rid, rt.source, rt.bucket, rt.value_mkd, oi.id::text AS lid,
         CASE WHEN rt.sale_source = 'collabbox' THEN 'collabbox' ELSE 'crm' END AS src,
         oi.product_id AS pid, oi.product_name AS name,
         greatest(coalesce(oi.quantity, 0), 0) AS qty,
         greatest(coalesce(oi.total_price, 0), 0)::numeric AS w,
         NULL::text AS shop_kind
  FROM rt
  JOIN public.order_items oi ON oi.order_id = rt.order_id
  WHERE rt.kind = 'order'
  UNION ALL
  SELECT rt.rid, rt.source, rt.bucket, rt.value_mkd, 'w' || i.shop_item_id::text,
         'web', NULL::uuid, i.name,
         greatest(coalesce(i.quantity, 0), 0),
         greatest(coalesce(i.price, 0) * coalesce(i.quantity, 0) - coalesce(i.discount_allocated, 0), 0)::numeric,
         i.kind
  FROM rt
  JOIN public.web_order_items i ON i.shop_order_id = rt.web_id
  WHERE rt.kind = 'web'
),
-- the product key and the reviewed kind, once per distinct line — as ONE map
-- (a lookup per line, never a join the planner can mis-size)
lkm AS MATERIALIZED (
  SELECT coalesce(jsonb_object_agg(d.k, jsonb_build_array(
           coalesce(public.product_key(d.src, d.name, d.pid), '__unknown__'),
           public.order_line_kind(d.src, d.name))), '{}'::jsonb) AS m
  FROM (SELECT DISTINCT l.src || chr(1) || coalesce(l.name, '') || chr(1) || coalesce(l.pid::text, '') AS k,
               l.src, l.name, l.pid
          FROM ln0 l) d
),
ln1 AS MATERIALIZED (   -- the kind is decided once per line (it feeds four window sums)
  SELECT l.*, x.pkey,
         CASE
           -- a reviewed alias (product_aliases) says what the line is
           WHEN x.akind IS DISTINCT FROM 'product'                                        THEN x.akind
           WHEN l.shop_kind = 'GIFT'                                                      THEN 'gift'
           WHEN lower(coalesce(l.name, '')) ~ '^\s*(поен|poen)(и|i)?([^[:alpha:]]|$)'     THEN 'loyalty_point'
           WHEN lower(coalesce(l.name, '')) ~ '^\s*(достава|dostava|delivery|shipping)([^[:alpha:]]|$)' THEN 'delivery'
           ELSE 'product' END AS kind0,
         (x.akind IS DISTINCT FROM 'product') AS by_alias
  FROM ln0 l
  CROSS JOIN LATERAL (
    SELECT e ->> 0 AS pkey, e ->> 1 AS akind
    FROM (SELECT (SELECT lkm.m FROM lkm) -> (l.src || chr(1) || coalesce(l.name, '') || chr(1) || coalesce(l.pid::text, '')) AS e) q
  ) x
),
-- ONE sort per sale. The weight is the line's money (sw > 0); a sale valued
-- at COD with no priced line spreads over its product units instead. Running
-- sums allocate by the cumulative method, so a sale's lines add up to its
-- value to the denar: Σ (round(V·c/T) − round(V·(c − a)/T)) = round(V) = V.
ln2 AS (
  SELECT l.*,
         (CASE WHEN l.kind0 = 'product' THEN greatest(l.qty, 1) ELSE 0 END)::numeric AS pq,
         sum(l.w) OVER wp AS sw,
         sum(l.w) OVER wr AS cw,
         sum(CASE WHEN l.kind0 = 'product' THEN greatest(l.qty, 1) ELSE 0 END) OVER wp AS sq,
         sum(CASE WHEN l.kind0 = 'product' THEN greatest(l.qty, 1) ELSE 0 END) OVER wr AS cq
  FROM ln1 l
  WINDOW wp AS (PARTITION BY l.rid),
         wr AS (PARTITION BY l.rid ORDER BY l.w DESC, (l.kind0 = 'product') DESC, l.qty DESC, l.lid
                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
),
lv AS MATERIALIZED (
  SELECT z.*,
         -- a package count no price supports (1.000 at 48,78 €) is a typing
         -- slip: the line keeps its money, its units are left out and reported
         (z.lkind = 'product' AND z.qty > 20 AND z.val < 60 * z.qty) AS bad_qty
  FROM (
    SELECT l.rid, l.pkey, l.by_alias, l.qty, l.name, l.source, l.bucket, l.value_mkd,
           -- a free unit of a product on a paid sale is a gift
           CASE WHEN l.kind0 = 'product' AND l.w = 0 AND l.sw > 0 THEN 'gift' ELSE l.kind0 END AS lkind,
           (l.sw > 0 OR l.sq > 0) AS alloc,
           CASE WHEN l.sw > 0 THEN round(l.value_mkd * l.cw / l.sw) - round(l.value_mkd * (l.cw - l.w) / l.sw)
                WHEN l.sq > 0 THEN round(l.value_mkd * l.cq / l.sq) - round(l.value_mkd * (l.cq - l.pq) / l.sq)
                ELSE 0::numeric END AS val
    FROM ln2 l
  ) z
),
lp AS MATERIALIZED (       -- one row per sale × product (a product twice on a sale counts once)
  SELECT lv.rid, lv.pkey, lv.source, lv.bucket,
         sum(CASE WHEN lv.bad_qty THEN 0 ELSE lv.qty END) AS units,
         sum(lv.val) AS v,
         max(lv.name) AS any_name,
         bool_or(lv.bad_qty) AS bad_qty
  FROM lv
  WHERE lv.lkind = 'product'
  GROUP BY lv.rid, lv.pkey, lv.source, lv.bucket
),
pa AS MATERIALIZED (
  SELECT q.*,
         row_number() OVER (ORDER BY CASE WHEN (SELECT prm.money FROM prm) THEN q.v ELSE q.units END DESC NULLS LAST,
                                     q.sales DESC, q.pkey) AS rk
  FROM (
    SELECT lp.pkey,
           count(*)                                                                     AS sales,
           sum(lp.units)                                                                AS units,
           sum(lp.v)                                                                    AS v,
           count(*) FILTER (WHERE lp.bucket IN ('paid', 'paid_legacy'))                AS paid,
           count(*) FILTER (WHERE lp.bucket = 'returned')                               AS returned,
           count(*) FILTER (WHERE lp.bucket IN ('courier', 'courier_problem', 'label')) AS courier,
           count(*) FILTER (WHERE lp.bucket = 'to_pack')                                AS to_pack,
           max(lp.any_name)                                                             AS any_name
    FROM lp
    GROUP BY lp.pkey
  ) q
),
-- the top keys as ONE array: a probe per line, never a join over CTE scans
ptop AS MATERIALIZED (
  SELECT coalesce(array_agg(pa.pkey), ARRAY[]::text[]) AS keys
  FROM pa WHERE pa.rk <= (SELECT prm.topn FROM prm)
),
pbs AS MATERIALIZED (      -- per top product × source
  SELECT q.pkey,
         jsonb_agg(jsonb_build_object('key', q.source, 'sales', q.sales, 'units', q.units,
                                      'value_mkd', round(q.v)) ORDER BY s.ord) AS j
  FROM (SELECT lp.pkey, lp.source, count(*) AS sales, sum(lp.units) AS units, sum(lp.v) AS v
          FROM lp
         WHERE lp.pkey = ANY ((SELECT ptop.keys FROM ptop)::text[])
         GROUP BY lp.pkey, lp.source) q
  JOIN srcs s ON s.key = q.source
  GROUP BY q.pkey
),
pj AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'key', t.pkey,
           'name', coalesce((SELECT pr.name FROM public.products pr
                              WHERE t.pkey ~ '^p:[0-9a-f-]{36}$' AND pr.id = substring(t.pkey FROM 3)::uuid), t.any_name),
           'catalogue', t.pkey LIKE 'p:%',
           'sales', t.sales, 'units', t.units, 'value_mkd', round(t.v),
           'paid', t.paid, 'returned', t.returned, 'courier', t.courier, 'to_pack', t.to_pack,
           'by_source', coalesce((SELECT bs.j FROM pbs bs WHERE bs.pkey = t.pkey), '[]'::jsonb))
           ORDER BY t.rk), '[]'::jsonb) AS j
  FROM pa t
  WHERE t.rk <= (SELECT prm.topn FROM prm)
),
po AS (                    -- the rest of the products, one row
  SELECT (SELECT count(*) FROM pa WHERE pa.rk > (SELECT prm.topn FROM prm)) AS products,
         count(DISTINCT lp.rid) AS sales,
         coalesce(sum(lp.units), 0) AS units, coalesce(sum(lp.v), 0) AS v
  FROM lp
  WHERE NOT (lp.pkey = ANY ((SELECT ptop.keys FROM ptop)::text[]))
),
pnp AS (                   -- lines that are not packages: gifts, points, delivery …
  SELECT lv.lkind AS kind, count(*) AS lines, count(DISTINCT lv.rid) AS sales,
         coalesce(sum(lv.qty), 0) AS units, coalesce(sum(lv.val), 0) AS v,
         count(*) FILTER (WHERE NOT lv.by_alias) AS auto
  FROM lv
  WHERE lv.lkind <> 'product'
  GROUP BY lv.lkind
),
pres AS (                  -- sales no line can carry: MEX-only parcels, a sale with no line to spread over
  SELECT count(*) AS sales, coalesce(sum(rt.value_mkd), 0) AS v,
         count(*) FILTER (WHERE rt.kind = 'mex') AS mex_only,
         coalesce(sum(rt.value_mkd) FILTER (WHERE rt.kind = 'mex'), 0) AS mex_v
  FROM rt
  WHERE rt.rid NOT IN (SELECT lv.rid FROM lv WHERE lv.alloc)   -- a hashed sub-plan
),
psum AS (
  SELECT (SELECT count(*) FROM pa)                                          AS products,
         (SELECT count(*) FROM pa WHERE pa.pkey NOT LIKE 'p:%')             AS unmapped_products,
         count(DISTINCT lp.rid)                                             AS sales,
         coalesce(sum(lp.units), 0)                                         AS units,
         coalesce(sum(lp.v), 0)                                             AS v,
         count(DISTINCT lp.rid) FILTER (WHERE lp.pkey NOT LIKE 'p:%')       AS unmapped_sales,
         coalesce(sum(lp.units) FILTER (WHERE lp.pkey NOT LIKE 'p:%'), 0)   AS unmapped_units,
         coalesce(sum(lp.v) FILTER (WHERE lp.pkey NOT LIKE 'p:%'), 0)       AS unmapped_v,
         count(*) FILTER (WHERE lp.bad_qty)                                 AS bad_qty_lines,
         coalesce(sum(lp.v) FILTER (WHERE lp.bad_qty), 0)                   AS bad_qty_v
  FROM lp
),
-- ── cities: mk_city_key once per distinct spelling (Latin, Cyrillic and the
-- MEX "Skopje - Aerodrom" zones fold into one place) ──────────────────────
cr AS MATERIALIZED (       -- per raw spelling first: a hash over ~1.000 rows, not a sort of every sale
  SELECT rt.city_raw AS raw,
         count(*)                                                                     AS n,
         coalesce(sum(rt.value_mkd), 0)                                               AS v,
         count(*) FILTER (WHERE rt.bucket IN ('paid', 'paid_legacy'))                AS paid,
         count(*) FILTER (WHERE rt.bucket = 'returned')                               AS returned,
         count(*) FILTER (WHERE rt.bucket IN ('courier', 'courier_problem', 'label')) AS courier,
         count(*) FILTER (WHERE rt.bucket = 'to_pack')                                AS to_pack
  FROM rt
  GROUP BY rt.city_raw
),
ca AS MATERIALIZED (
  SELECT k.k, sum(cr.n) AS n, sum(cr.v) AS v, sum(cr.paid) AS paid, sum(cr.returned) AS returned,
         sum(cr.courier) AS courier, sum(cr.to_pack) AS to_pack,
         count(cr.raw) AS spellings,
         (array_agg(cr.raw ORDER BY cr.n DESC, cr.raw))[1] AS sample_raw
  FROM cr
  CROSS JOIN LATERAL (SELECT CASE WHEN cr.raw IS NOT NULL THEN public.mk_city_key(cr.raw) END AS k) k
  GROUP BY k.k
),
car AS MATERIALIZED (
  SELECT ca.*, row_number() OVER (ORDER BY ca.n DESC, ca.v DESC, ca.k) AS rk,
         (SELECT jsonb_build_object('name', s.name, 'name_lat', s.name_lat)
            FROM public.mk_settlements s
           WHERE s.name_norm = ca.k
           ORDER BY CASE s.kind WHEN 'city' THEN 1 WHEN 'town' THEN 2 WHEN 'city_district' THEN 3 ELSE 4 END, s.id
           LIMIT 1) AS nm
  FROM ca WHERE ca.k IS NOT NULL
),
cj AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'key', car.k,
           'name', coalesce(car.nm ->> 'name', car.sample_raw),
           'name_lat', coalesce(car.nm ->> 'name_lat', car.sample_raw),
           'known', car.nm IS NOT NULL,
           'count', car.n, 'value_mkd', round(car.v),
           'paid', car.paid, 'returned', car.returned, 'courier', car.courier, 'to_pack', car.to_pack,
           'spellings', car.spellings)
           ORDER BY car.rk), '[]'::jsonb) AS j
  FROM car
  WHERE car.rk <= (SELECT prm.topn FROM prm)
),
csum AS (
  SELECT count(*) FILTER (WHERE car.rk > prm.topn)                        AS others_places,
         coalesce(sum(car.n) FILTER (WHERE car.rk > prm.topn), 0)         AS others_n,
         coalesce(sum(car.v) FILTER (WHERE car.rk > prm.topn), 0)         AS others_v,
         coalesce(sum(car.paid) FILTER (WHERE car.rk > prm.topn), 0)      AS others_paid,
         coalesce(sum(car.returned) FILTER (WHERE car.rk > prm.topn), 0)  AS others_returned,
         coalesce(sum(car.courier) FILTER (WHERE car.rk > prm.topn), 0)   AS others_courier,
         coalesce(sum(car.to_pack) FILTER (WHERE car.rk > prm.topn), 0)   AS others_to_pack,
         count(*)                                                         AS places,
         coalesce(sum(car.spellings), 0)                                  AS spellings,
         count(*) FILTER (WHERE car.nm IS NULL)                           AS unknown_places,
         coalesce(sum(car.n) FILTER (WHERE car.nm IS NULL), 0)            AS unknown_places_n,
         coalesce(sum(car.v) FILTER (WHERE car.nm IS NULL), 0)            AS unknown_places_v
  FROM car CROSS JOIN prm
),
cnull AS (
  SELECT coalesce(max(ca.n), 0) AS n, coalesce(max(ca.v), 0) AS v, coalesce(max(ca.paid), 0) AS paid,
         coalesce(max(ca.returned), 0) AS returned, coalesce(max(ca.courier), 0) AS courier,
         coalesce(max(ca.to_pack), 0) AS to_pack
  FROM ca WHERE ca.k IS NULL
),
-- ── buyers (last-8 phone): new vs returning, repeat within the period ─────
b AS MATERIALIZED (
  SELECT rt.phone8, count(*) AS n, sum(rt.value_mkd) AS v, count(DISTINCT rt.source) AS n_src
  FROM rt WHERE rt.phone8 IS NOT NULL
  GROUP BY rt.phone8
),
-- the shop's classifier once per distinct (status, payment) — as the foundation does.
-- OFFSET 0 keeps the classifier above the DISTINCT (20260947001500): without it the
-- planner pushed the filter down and ran it on every web order (~24k calls, ~290 ms).
wbo AS MATERIALIZED (
  SELECT d.status, d.payment_status, d.payment_method
  FROM (SELECT DISTINCT w.status, w.payment_status, w.payment_method FROM public.web_orders w OFFSET 0) d
  WHERE public.web_order_outcome(d.status, d.payment_status, d.payment_method)
        IN ('delivered', 'no_record', 'returned', 'courier', 'preparing')
),
-- bought before the window: a CRM sale (sale day before `from`), a parcel
-- with money, or a web order the shop counts as a sale. This window's own
-- rows never count (a ledger-dated order, a parcel made before its sale
-- day). Per BUYER (20260947001500; was a scan of every order with a regexp per
-- phone + every parcel + every web order, hashed against the buyers, ~1,4 s):
-- three probes of the last-8 indexes (idx_orders_phone_last8 — the expression is
-- character-for-character its own —, idx_mex_parcels_phone8, idx_web_orders_phone8),
-- each a scalar sub-select that stops at the first hit, the next one only when the
-- one before found nothing. b.phone8 is always 8 digits (rt keeps only those).
bp AS MATERIALIZED (
  SELECT b.phone8
  FROM b
  WHERE coalesce((
          SELECT true
          FROM public.orders x
          WHERE right(regexp_replace(x.customer_phone, '[^0-9]', '', 'g'), 8) = b.phone8
            AND coalesce(x.sold_at, x.confirmed_at, x.created_at) < (SELECT prm.f FROM prm)
            AND x.status IN ('confirmed', 'shipped', 'paid', 'delivered', 'returned')
            AND coalesce(x.price, 0) > 0
            AND x.sale_source_detail IS DISTINCT FROM 'disposition'
            AND x.customer_phone IS NOT NULL
            AND x.id NOT IN (SELECT rt.order_id FROM rt WHERE rt.order_id IS NOT NULL)
          LIMIT 1), false)
     OR coalesce((
          SELECT true
          FROM public.mex_parcels p
          WHERE p.phone8 = b.phone8
            AND p.created_at_mex < (SELECT prm.f FROM prm)
            AND coalesce(p.cod_mkd, 0) > 0
            AND p.tracking_id NOT IN (SELECT rt.tracking_id FROM rt WHERE rt.tracking_id IS NOT NULL)
          LIMIT 1), false)
     OR coalesce((
          SELECT true
          FROM public.web_orders w
          WHERE w.phone8 = b.phone8
            AND w.created_at < (SELECT prm.f FROM prm)
            AND w.deleted_in_shop_at IS NULL
            AND coalesce(w.total, 0) > 0
            AND (w.status, w.payment_status, w.payment_method) IN (SELECT wbo.status, wbo.payment_status, wbo.payment_method FROM wbo)
          LIMIT 1), false)
),
bf AS MATERIALIZED (
  SELECT b.*, (b.phone8 IN (SELECT bp.phone8 FROM bp)) AS returning FROM b
),
bj2 AS (
  SELECT jsonb_build_object(
    'buyers',              count(*),
    'returning',           count(*) FILTER (WHERE bf.returning),
    'new',                 count(*) FILTER (WHERE NOT bf.returning),
    'repeat',              count(*) FILTER (WHERE bf.n >= 2),
    'cross_source',        count(*) FILTER (WHERE bf.n_src >= 2),
    'sales',               coalesce(sum(bf.n), 0),
    'sales_new',           coalesce(sum(bf.n) FILTER (WHERE NOT bf.returning), 0),
    'sales_returning',     coalesce(sum(bf.n) FILTER (WHERE bf.returning), 0),
    'value_new_mkd',       round(coalesce(sum(bf.v) FILTER (WHERE NOT bf.returning), 0)),
    'value_returning_mkd', round(coalesce(sum(bf.v) FILTER (WHERE bf.returning), 0)),
    'no_phone',            (SELECT count(*) FROM rt WHERE rt.phone8 IS NULL),
    -- how far back "bought before" can see (CRM orders and MEX parcels)
    'history_from',        to_char(least((SELECT min(x.created_at) FROM public.orders x),
                                         (SELECT min(p.created_at_mex) FROM public.mex_parcels p))
                                   AT TIME ZONE 'Europe/Skopje', 'YYYY-MM-DD'),
    'by_source', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
               'key', q.source, 'buyers', q.buyers, 'new', q.nw, 'returning', q.buyers - q.nw, 'repeat', q.rep)
               ORDER BY s.ord), '[]'::jsonb)
      FROM (SELECT y.source, count(*) AS buyers,
                   count(*) FILTER (WHERE y.phone8 NOT IN (SELECT bp.phone8 FROM bp)) AS nw,
                   count(*) FILTER (WHERE y.n >= 2) AS rep
              FROM (SELECT rt.source, rt.phone8, count(*) AS n FROM rt WHERE rt.phone8 IS NOT NULL
                     GROUP BY rt.source, rt.phone8) y
             GROUP BY y.source) q
      JOIN srcs s ON s.key = q.source)) AS j
  FROM bf
),
-- ── basket: packages per sale ────────────────────────────────────────────
-- sales with lines: their package count; sales with none (MEX-only parcels)
-- are the per-source remainder — no join, no lookup
bu AS MATERIALIZED (
  SELECT lv.rid, lv.source, max(lv.value_mkd) AS v,
         coalesce(sum(lv.qty) FILTER (WHERE lv.lkind = 'product' AND NOT lv.bad_qty), 0) AS units
  FROM lv
  GROUP BY lv.rid, lv.source
),
bk AS MATERIALIZED (
  SELECT q.source, q.ub, sum(q.n) AS n, sum(q.v) AS v, sum(q.units) AS units
  FROM (
    SELECT bu.source,
           CASE WHEN bu.units <= 0 THEN 'none' WHEN bu.units >= 5 THEN '5' ELSE bu.units::text END AS ub,
           count(*) AS n, coalesce(sum(bu.v), 0) AS v, coalesce(sum(bu.units), 0) AS units
    FROM bu
    GROUP BY 1, 2
    UNION ALL
    SELECT a.source, 'none', a.n - coalesce(l.n, 0), a.v - coalesce(l.v, 0), 0
    FROM (SELECT rt.source, count(*) AS n, coalesce(sum(rt.value_mkd), 0) AS v FROM rt GROUP BY rt.source) a
    LEFT JOIN (SELECT bu.source, count(*) AS n, coalesce(sum(bu.v), 0) AS v FROM bu GROUP BY bu.source) l
           ON l.source = a.source
  ) q
  GROUP BY q.source, q.ub
),
bkj AS (
  SELECT jsonb_build_object(
    'dist', (SELECT jsonb_agg(jsonb_build_object('key', k.key, 'count', coalesce(z.n, 0), 'value_mkd', round(coalesce(z.v, 0)))
                              ORDER BY k.ord)
               FROM (VALUES ('1', 1), ('2', 2), ('3', 3), ('4', 4), ('5', 5), ('none', 6)) k(key, ord)
               LEFT JOIN (SELECT bk.ub, sum(bk.n) AS n, sum(bk.v) AS v FROM bk GROUP BY bk.ub) z ON z.ub = k.key),
    'by_source', (SELECT jsonb_agg(jsonb_build_object(
                           'key', s.key,
                           'count', coalesce(z.n, 0),
                           'with_units', coalesce(z.nu, 0),
                           'units', coalesce(z.units, 0),
                           'value_mkd', round(coalesce(z.v, 0)),
                           'dist', (SELECT jsonb_agg(jsonb_build_object('key', k.key, 'count', coalesce(bk2.n, 0)) ORDER BY k.ord)
                                      FROM (VALUES ('1', 1), ('2', 2), ('3', 3), ('4', 4), ('5', 5), ('none', 6)) k(key, ord)
                                      LEFT JOIN bk bk2 ON bk2.source = s.key AND bk2.ub = k.key))
                           ORDER BY s.ord)
                    FROM srcs s
                    LEFT JOIN (SELECT bk.source, sum(bk.n) AS n, sum(bk.n) FILTER (WHERE bk.ub <> 'none') AS nu,
                                      sum(bk.units) AS units, sum(bk.v) AS v
                                 FROM bk GROUP BY bk.source) z ON z.source = s.key)) AS j
)
SELECT jsonb_build_object(
  'meta', jsonb_build_object(
    'from', to_char(prm.fd, 'YYYY-MM-DD'),
    'to', to_char(prm.td, 'YYYY-MM-DD'),
    'generated_at', now(),
    'money', true,
    'clock', 'sale',
    'part', 'detail',
    'top_n', prm.topn),
  'total', (SELECT jsonb_build_object('count', count(*), 'value_mkd', round(coalesce(sum(rt.value_mkd), 0))) FROM rt),
  'products',  jsonb_build_object(
                 'rows', (SELECT j FROM pj),
                 'others', (SELECT jsonb_build_object('products', po.products, 'sales', po.sales, 'units', po.units,
                                                      'value_mkd', round(po.v)) FROM po),
                 'non_product', (SELECT coalesce(jsonb_agg(jsonb_build_object('kind', pnp.kind, 'lines', pnp.lines,
                                   'sales', pnp.sales, 'units', pnp.units, 'value_mkd', round(pnp.v), 'auto', pnp.auto)
                                   ORDER BY pnp.lines DESC), '[]'::jsonb) FROM pnp),
                 'no_product', (SELECT jsonb_build_object('sales', pres.sales, 'value_mkd', round(pres.v),
                                                          'mex_only', pres.mex_only, 'mex_only_value_mkd', round(pres.mex_v))
                                  FROM pres),
                 'summary', (SELECT jsonb_build_object('products', psum.products, 'units', psum.units,
                                                       'value_mkd', round(psum.v), 'sales', psum.sales,
                                                       'unmapped_products', psum.unmapped_products,
                                                       'unmapped_units', psum.unmapped_units,
                                                       'unmapped_value_mkd', round(psum.unmapped_v),
                                                       'unmapped_sales', psum.unmapped_sales,
                                                       'bad_qty_lines', psum.bad_qty_lines,
                                                       'bad_qty_value_mkd', round(psum.bad_qty_v))
                               FROM psum)),
  'cities',    jsonb_build_object(
                 'rows', (SELECT j FROM cj),
                 'others', (SELECT jsonb_build_object('places', csum.others_places, 'count', csum.others_n,
                                                      'value_mkd', round(csum.others_v), 'paid', csum.others_paid,
                                                      'returned', csum.others_returned, 'courier', csum.others_courier,
                                                      'to_pack', csum.others_to_pack) FROM csum),
                 'unknown', (SELECT jsonb_build_object('count', cnull.n, 'value_mkd', round(cnull.v), 'paid', cnull.paid,
                                                       'returned', cnull.returned, 'courier', cnull.courier,
                                                       'to_pack', cnull.to_pack) FROM cnull),
                 'places', (SELECT csum.places FROM csum),
                 'spellings', (SELECT csum.spellings FROM csum),
                 'unknown_places', (SELECT csum.unknown_places FROM csum),
                 'unknown_places_count', (SELECT csum.unknown_places_n FROM csum),
                 'unknown_places_value_mkd', (SELECT round(csum.unknown_places_v) FROM csum)),
  'customers', (SELECT j FROM bj2),
  'basket',    (SELECT j FROM bkj))
FROM prm
$detail$
    INTO v_out
    USING p_from, p_to_end, v_fd, v_td, v_gran, v_top, coalesce(p_money, false);
  ELSE
    EXECUTE $summary$
WITH
srcs AS (
  SELECT * FROM (VALUES ('altercpa', 1), ('elyon_crm', 2), ('teleshop_out', 3), ('teleshop_other', 4),
                        ('social', 5), ('web', 6), ('management', 7)) v(key, ord)
),
bks AS (
  SELECT * FROM (VALUES ('paid', 1), ('paid_unproven', 2), ('paid_legacy', 3), ('courier', 4),
                        ('courier_problem', 5), ('label', 6), ('to_pack', 7), ('returned', 8)) v(key, ord)
),
r AS MATERIALIZED (
  SELECT s.source, s.bucket, s.value_mkd, s.cod_mkd
  FROM public.insights_sale_rows($1, $2, false) s
  WHERE s.in_total
),
ag AS (
  SELECT coalesce(r.source, '*') AS src, r.bucket, count(*) AS n,
         coalesce(sum(r.value_mkd), 0) AS v, coalesce(sum(r.cod_mkd), 0) AS c
  FROM r
  GROUP BY GROUPING SETS ((r.source, r.bucket), (r.bucket))
),
tot AS (
  SELECT sc.src,
         jsonb_build_object('count', coalesce(sum(a.n), 0), 'value_mkd', round(coalesce(sum(a.v), 0)),
                            'cod_mkd', round(coalesce(sum(a.c), 0))) AS j
  FROM (SELECT '*'::text AS src UNION ALL SELECT s.key FROM srcs s) sc
  LEFT JOIN ag a ON a.src = sc.src
  GROUP BY sc.src
)
SELECT jsonb_build_object(
  'meta', jsonb_build_object(
    'from', to_char($3::date, 'YYYY-MM-DD'),
    'to', to_char($4::date, 'YYYY-MM-DD'),
    'money', true,
    'clock', 'sale',
    'part', 'summary'),
  'total', (SELECT t.j FROM tot t WHERE t.src = '*'),
  'buckets', (SELECT jsonb_agg(jsonb_build_object('key', b.key, 'count', coalesce(a.n, 0),
                                                  'value_mkd', round(coalesce(a.v, 0)), 'cod_mkd', round(coalesce(a.c, 0)))
                               ORDER BY b.ord)
                FROM bks b LEFT JOIN ag a ON a.src = '*' AND a.bucket = b.key),
  'by_source', (SELECT jsonb_agg(jsonb_build_object('key', s.key, 'total', t.j) ORDER BY s.ord)
                  FROM srcs s JOIN tot t ON t.src = s.key))
$summary$
    INTO v_out
    USING p_from, p_to_end, v_fd, v_td, v_gran, v_top, coalesce(p_money, false);
  END IF;

  IF coalesce(p_money, false) THEN
    RETURN v_out;
  END IF;
  v_out := public.insights_strip_money(v_out);
  RETURN jsonb_set(v_out, '{meta,money}', 'false'::jsonb);
END;
$function$;

-- smoke: the dynamic SQL runs (a failure rolls the whole file back)
DO $smoke$
BEGIN
  PERFORM public.insights_sales(now() - interval '1 day', now(), 'detail', true, 40);
END
$smoke$;
