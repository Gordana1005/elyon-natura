-- The sale cohort's spark per department (29.09.2026) — insights_cohort re-emitted from its live
-- body with two counted edits: every spark point also carries `by_source`
-- [{key, count, value_mkd}] for the selected departments, in the owner's order.
--
-- Why: the Overview's "Тренд по извор" drew a "placed" line per department that counted every
-- order CREATED that day — 0-ден "no"-call rows, cancels, trash and open leads included (22–28.09:
-- Affiliate – Lead out 2.713 "placed" against 212 cohort sales). The line is now the cohort's own
-- sales by SALE day per department (bookings included, денари = parcel COD else price × 61,5), the
-- same rows the header counts: Σ by_source = the point, and over the window Σ points of a
-- department = its by_source total. The whole-business point (d, count, value_mkd) is unchanged;
-- the MEX cash line stays insights_overview's (it ties to the register).
-- No new scan: the rows are the ones `sr` already materialised. value_mkd is a money key — a
-- non-owner's payload loses it (insights_strip_money here, the api's whitelist keeps key/count).

BEGIN;

SET LOCAL lock_timeout = '10s';

DO $drift$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.insights_cohort(timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone,text[],boolean)')
                   AND md5(replace(p.prosrc, chr(13), '')) IN ('f58f7f52a36891bf95066bd932ef031b', '202a37a67bd760c0161dae32ce050bec')) THEN
    RAISE EXCEPTION 'insights_cohort changed since this migration was written — re-emit it from the live body';
  END IF;
END
$drift$;

CREATE OR REPLACE FUNCTION public.insights_cohort(p_from timestamp with time zone, p_to_end timestamp with time zone, p_prev_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_prev_to_end timestamp with time zone DEFAULT NULL::timestamp with time zone, p_sources text[] DEFAULT NULL::text[], p_money boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET "TimeZone" TO 'UTC'
 SET work_mem TO '64MB'
 SET jit TO 'off'
AS $function$
DECLARE
  v_all  text[] := ARRAY['altercpa', 'elyon_crm', 'teleshop_out', 'teleshop_other', 'social', 'web'];
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
  -- $10 prev from day · $11 prev to day · $12 all six sources · $13 the
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
  -- ss = the source's GET /orders cohort_source value (the api's twin of
  -- cohort_order_source(sale_source, sale_source_detail, mex_tracking_id): a
  -- department is not a sale_source list (20260942001000)
  FROM (VALUES ('altercpa', 1, 'altercpa'), ('elyon_crm', 2, 'elyon_crm'),
               ('teleshop_out', 3, 'teleshop_out'), ('teleshop_other', 4, 'teleshop_other'),
               ('social', 5, 'social'), ('web', 6, 'web')) s(key, ord, ss)
  CROSS JOIN prm
  WHERE s.key = ANY (prm.srcs)
),
-- '*' = every selected source; its cohort_source filter is omitted when all six are
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
                        ('cancelled_after_sale', 9, false), ('trashed_after_sale', 10, false),
                        ('replacement', 11, false)) v(key, ord, in_total)
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
         count(*) FILTER (WHERE r.cur AND r.kind = 'booking') AS n_booking,
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
         coalesce(a.n_booking, 0) AS n_booking,
         coalesce(a.pn, 0) AS pn, coalesce(a.pv, 0) AS pv, coalesce(a.pc, 0) AS pc
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
                 '/orders?cohort_bucket=total' || coalesce('&cohort_source=' || max(x.ss), '') || max(prm.win_q) END) AS total,
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
      -- only a detail GET /orders accepts (overview.ts DETAIL_RE) links
      'drill', CASE WHEN sp.kind = 'order' AND sp.split <> 'none' AND sp.split ~* '^[a-z0-9_.-]{1,40}$' THEN
                 '/orders?cohort_bucket=total&cohort_source=' || s.ss || '&sale_source_detail=' || sp.split || prm.win_q END)
      ORDER BY sp.n DESC, sp.split) AS j
  FROM sp
  JOIN srcs s ON s.key = sp.source
  CROSS JOIN prm
  GROUP BY sp.source
),
lr AS MATERIALIZED (
  SELECT l.source, l.state, l.disposition
  FROM public.insights_leads_rows($1, $2) l
  CROSS JOIN prm
  WHERE l.source = ANY (prm.srcs)
),
la AS (                    -- a partition: sales + cancelled + trashed + open + other = came_in
  SELECT coalesce(l.source, '*') AS src,
         count(*)                                         AS came_in,
         count(*) FILTER (WHERE l.state = 'sale')         AS sales,
         count(*) FILTER (WHERE l.state = 'cancelled')    AS cancelled,
         count(*) FILTER (WHERE l.state = 'trashed')      AS trashed,
         count(*) FILTER (WHERE l.state = 'open')         AS open,
         count(*) FILTER (WHERE l.state = 'other')        AS other,
         count(*) FILTER (WHERE l.disposition)            AS dispo
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
    'other',        coalesce(la.other, 0),
    'disposition',  coalesce(la.dispo, 0),
    'conversion',   CASE WHEN coalesce(la.came_in, 0) > 0 THEN round(la.sales::numeric / la.came_in, 4) END) AS j
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
-- the spark per department too (20260942001930): the Overview's trend draws each department's
-- sales by sale day from these same rows — one scan, no second count of anything
svs AS (
  SELECT to_char(date_trunc(prm.sgran, r.sale_day::timestamp), prm.sfmt) AS d, r.source, count(*) AS n, sum(r.value_mkd) AS v
  FROM sr r CROSS JOIN prm
  WHERE r.in_total AND r.sale_day BETWEEN prm.sfd AND prm.td
  GROUP BY 1, 2
),
sv AS (
  SELECT svs.d, sum(svs.n) AS n, sum(svs.v) AS v FROM svs GROUP BY svs.d
),
skj AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object('d', sk.d, 'count', coalesce(sv.n, 0), 'value_mkd', round(coalesce(sv.v, 0)),
                                               'by_source', (SELECT jsonb_agg(jsonb_build_object('key', s.key, 'count', coalesce(x.n, 0),
                                                                                                 'value_mkd', round(coalesce(x.v, 0)))
                                                                              ORDER BY s.ord)
                                                               FROM srcs s LEFT JOIN svs x ON x.d = sk.d AND x.source = s.key))
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
    -- a shared parcel is NOT a candidate: the owner ruled both orders
    -- accurate and its COD is split, not doubled (checker C8a exception)
    jsonb_build_object('kind', 'double_count_candidates',
      'count', count(*) FILTER (WHERE r.q_double_count),
      'value_mkd', round(coalesce(sum(r.value_mkd) FILTER (WHERE r.q_double_count), 0))),
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
$function$;

COMMIT;
