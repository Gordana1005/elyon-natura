-- ============================================================================
-- THE COHORT SPLITS EACH DEPARTMENT BY THE CUSTOMERS' ORIGIN (owner, 15.10.2026)
--
-- Owner: "тимот на Центар Out, од сите продажби што ги имаат направено, колку од нив се дел од
-- Bio Natural т.е колку … доаѓаат од претходно што се биле лидови од Affiliate, а колку од нив
-- доаѓаат од Teleshop". insights_cohort's by_source rows gain two lists, both over the SAME rows
-- as the department's total (cur AND in_total) — one calculation, the parts add up to it exactly:
--
--   origins   [{key: bio_natural | natura | new, count, value_mkd, web, mixed, no_phone}]
--             the buyer's origin at the sale (customer_origin_at_sale over public.customer_origin,
--             20261015120000): bio_natural = first came as an affiliate (Тим Маџари) lead;
--             natura = Natura Therapy / Ad Astra (teleshop, social — `web` of them first came
--             through the web shop); new = no trace before the sale (`no_phone` of them have no
--             phone at all). `mixed` = sales whose buyer has history on both sides (the first decides).
--             NULL until customer_origin's first full fill — never a guess.
--   accounts  [{key: natura | bio_natural | none, count, value_mkd}] the MEX profile the sale went
--             out on (none = no parcel yet: a booking, an order at the warehouse).
--
-- A department's ORIGIN never changes its department (the seller's team / folder decide that).
-- Money: p_money = false strips every *_mkd at any depth (insights_strip_money) — counts stay.
-- The api's non-money whitelist (insightsCommon.ts COHORT_NON_MONEY_KEYS) learns origins /
-- accounts / mixed / no_phone in the same release.
--
-- Re-emitted from the LIVE body (md5 guard; four counted edits). Rollback: the saved body
-- exports/origin/insights_cohort_live_2026-10-15.sql (gitignored) — apply it as is.
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $chk$
BEGIN
  IF to_regclass('public.customer_origin') IS NULL
     OR to_regprocedure('public.customer_origin_at_sale(timestamptz,timestamptz,timestamptz,timestamptz)') IS NULL THEN
    RAISE EXCEPTION 'insights_cohort origins: apply 20261015120000_customer_origin.sql first';
  END IF;
  IF pg_get_function_result('public.insights_sale_rows(timestamp with time zone,timestamp with time zone,boolean)'::regprocedure)
       NOT LIKE '%sale_at timestamp with time zone%'
     OR pg_get_function_result('public.insights_sale_rows(timestamp with time zone,timestamp with time zone,boolean)'::regprocedure)
       NOT LIKE '%mex_account text%'
     OR pg_get_function_result('public.insights_sale_rows(timestamp with time zone,timestamp with time zone,boolean)'::regprocedure)
       NOT LIKE '%phone8 text%' THEN
    RAISE EXCEPTION 'insights_cohort origins: insights_sale_rows no longer returns sale_at / mex_account / phone8';
  END IF;
END
$chk$;

CREATE FUNCTION pg_temp.reemit_origin(p_sig text, p_md5 text, p_old text[], p_new text[], p_cnt int[])
RETURNS void
LANGUAGE plpgsql
AS $f$
DECLARE
  v_def text;
  v_k   int;
  i     int;
BEGIN
  IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p WHERE p.oid = to_regprocedure(p_sig)) IS DISTINCT FROM p_md5 THEN
    RAISE EXCEPTION 'insights_cohort origins: % changed since this migration was written — re-emit from the live body', p_sig;
  END IF;
  v_def := replace(pg_get_functiondef(to_regprocedure(p_sig)), chr(13), '');
  FOR i IN 1 .. array_length(p_old, 1) LOOP
    v_k := (length(v_def) - length(replace(v_def, p_old[i], ''))) / length(p_old[i]);
    IF v_k <> p_cnt[i] THEN
      RAISE EXCEPTION 'insights_cohort origins: % edit % found % times, expected %', p_sig, i, v_k, p_cnt[i];
    END IF;
    v_def := replace(v_def, p_old[i], p_new[i]);
  END LOOP;
  EXECUTE v_def;
END
$f$;

SELECT pg_temp.reemit_origin(
  'public.insights_cohort(timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone,text[],boolean)',
  'a74a8795df36ffc9ed3badbcb46a2320',
  ARRAY[
    -- 1. sr carries the sale's time, phone and MEX profile
    $a$         (r.sale_at BETWEEN prm.f AND prm.t) AS cur,$a$,
    -- 2. the origin / account parts, before the leads
    $a$lr AS MATERIALIZED ($a$,
    -- 3. by_source gains origins + accounts
    $a$    'splits',    coalesce(sj.j, '[]'::jsonb),$a$,
    -- 4. … joined per department
    $a$  LEFT JOIN spj sj ON sj.source = s.key$a$
  ],
  ARRAY[
    $a$         r.sale_at, r.phone8, r.mex_account,
         (r.sale_at BETWEEN prm.f AND prm.t) AS cur,$a$,
    $a$-- the customers' origin (20261015120100): each in-total sale of the period by where its buyer FIRST
-- came from (public.customer_origin) and by the MEX profile it went out on — the department's own
-- rows, so each list adds up to its total. No phone / no trace before the sale = 'new'.
ogr AS (
  SELECT r.source,
         CASE WHEN r.phone8 IS NULL THEN 'new'
              ELSE public.customer_origin_at_sale(co.affiliate_at, co.natura_at, co.web_at, r.sale_at) END AS origin,
         (r.phone8 IS NOT NULL AND public.customer_origin_web_first(co.affiliate_at, co.natura_at, co.web_at, r.sale_at)) AS web_first,
         (r.phone8 IS NOT NULL AND public.customer_origin_mixed(co.affiliate_at, co.natura_at, co.web_at, r.sale_at)) AS mixed,
         (r.phone8 IS NULL) AS no_phone,
         CASE WHEN r.mex_account IN ('natura', 'bio_natural') THEN r.mex_account ELSE 'none' END AS account,
         r.value_mkd
  FROM sr r
  LEFT JOIN public.customer_origin co ON co.phone8 = r.phone8
  WHERE r.cur AND r.in_total
),
oga AS (
  SELECT o.source, o.origin, count(*) AS n, sum(o.value_mkd) AS v,
         count(*) FILTER (WHERE o.web_first) AS web, count(*) FILTER (WHERE o.mixed) AS mixed,
         count(*) FILTER (WHERE o.no_phone) AS no_phone
  FROM ogr o
  GROUP BY o.source, o.origin
),
ogj AS (
  SELECT s.key AS source,
    jsonb_agg(jsonb_build_object(
      'key', k.key, 'count', coalesce(a.n, 0), 'value_mkd', round(coalesce(a.v, 0)),
      'web', coalesce(a.web, 0), 'mixed', coalesce(a.mixed, 0), 'no_phone', coalesce(a.no_phone, 0))
      ORDER BY k.ord) AS j
  FROM srcs s
  CROSS JOIN (VALUES ('bio_natural', 1), ('natura', 2), ('new', 3)) k(key, ord)
  LEFT JOIN oga a ON a.source = s.key AND a.origin = k.key
  GROUP BY s.key
),
aca AS (
  SELECT o.source, o.account, count(*) AS n, sum(o.value_mkd) AS v
  FROM ogr o
  GROUP BY o.source, o.account
),
acj AS (
  SELECT s.key AS source,
    jsonb_agg(jsonb_build_object('key', k.key, 'count', coalesce(a.n, 0), 'value_mkd', round(coalesce(a.v, 0)))
      ORDER BY k.ord) AS j
  FROM srcs s
  CROSS JOIN (VALUES ('natura', 1), ('bio_natural', 2), ('none', 3)) k(key, ord)
  LEFT JOIN aca a ON a.source = s.key AND a.account = k.key
  GROUP BY s.key
),
-- the origin is shown only once customer_origin had its first full fill
cor AS (
  SELECT (st.last_full_at IS NOT NULL) AS ready FROM public.customer_origin_state st WHERE st.id
),
lr AS MATERIALIZED ($a$,
    $a$    'splits',    coalesce(sj.j, '[]'::jsonb),
    'origins',   CASE WHEN (SELECT c.ready FROM cor c) THEN oj.j END,
    'accounts',  aj.j,$a$,
    $a$  LEFT JOIN spj sj ON sj.source = s.key
  LEFT JOIN ogj oj ON oj.source = s.key
  LEFT JOIN acj aj ON aj.source = s.key$a$
  ],
  ARRAY[1, 1, 1, 1]);

COMMENT ON FUNCTION public.insights_cohort(timestamptz, timestamptz, timestamptz, timestamptz, text[], boolean) IS
  'THE sales cohort (one total, parts that add up) — by_source rows carry splits, origins (the buyers'' origin: bio_natural | natura | new, with web / mixed / no_phone; NULL before customer_origin''s first fill) and accounts (natura | bio_natural | none), each over the department''s own in-total rows (20261015120100). p_money = false strips every *_mkd.';

-- Self-check: for yesterday and the last 30 days, every department's accounts (and origins, once
-- filled) add up to its total — count and денари. A mismatch rolls the whole file back.
DO $self$
DECLARE
  v_day  timestamptz := (date_trunc('day', now() AT TIME ZONE 'Europe/Skopje') - interval '1 day') AT TIME ZONE 'Europe/Skopje';
  v_win  record;
  v_c    jsonb;
  v_r    jsonb;
  v_t    numeric;
  v_s    numeric;
  v_list text;
BEGIN
  FOR v_win IN SELECT * FROM (VALUES (v_day, v_day + interval '1 day' - interval '1 microsecond'),
                                     (v_day - interval '29 days', v_day + interval '1 day' - interval '1 microsecond')) w(f, t) LOOP
    v_c := public.insights_cohort(v_win.f, v_win.t, NULL, NULL, NULL, true);
    FOR v_r IN SELECT x FROM jsonb_array_elements(v_c -> 'by_source') x LOOP
      FOREACH v_list IN ARRAY ARRAY['accounts', 'origins'] LOOP
        CONTINUE WHEN jsonb_typeof(v_r -> v_list) IS DISTINCT FROM 'array';
        SELECT coalesce(sum((e ->> 'count')::numeric), 0) INTO v_s FROM jsonb_array_elements(v_r -> v_list) e;
        v_t := (v_r -> 'total' ->> 'count')::numeric;
        IF v_s <> v_t THEN
          RAISE EXCEPTION 'insights_cohort origins: % of % add up to % sales, the total is % (%–%)',
            v_list, v_r ->> 'key', v_s, v_t, v_win.f, v_win.t;
        END IF;
        SELECT coalesce(sum((e ->> 'value_mkd')::numeric), 0) INTO v_s FROM jsonb_array_elements(v_r -> v_list) e;
        v_t := (v_r -> 'total' ->> 'value_mkd')::numeric;
        IF abs(v_s - v_t) > 3 THEN
          RAISE EXCEPTION 'insights_cohort origins: % of % add up to % ден, the total is % (%–%)',
            v_list, v_r ->> 'key', v_s, v_t, v_win.f, v_win.t;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;
END
$self$;

COMMIT;

NOTIFY pgrst, 'reload schema';
