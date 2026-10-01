-- ============================================================================
-- Shops: "top sellers" = GOODS only (02.10.2026, after the first live read)
-- ============================================================================
-- The first live read (01.10) flagged "11 of the 20 top sellers are out of stock" in EVERY shop. The
-- chain's top-20 list held loyalty ПОЕН vouchers, the paper bag (1506 ХАРТИЕНА КЕСА) and bundles the till
-- assembles at the moment of sale (10040: 600067 "1+1 ПРОСТАТОЛ", 800314 "2 КРЕАТИН …", 101659 "3 MAGNESIUM
-- …", 700061 "ТУРМЕРИК 1+1", 000553 "2+2 АЛОЕ …", 000569 "3/1 ДИАБЕТОЛ …") — none of them sits on a shelf,
-- so the zero_top_seller flag and its anomaly were false alarms. The list now keeps Sigma article codes
-- (00xxxx) whose name is not a bundle pattern. Only the `top` CTE of shops_stock_rows() changes
-- (re-emitted from the 20260946000200 body).
-- ============================================================================

SET lock_timeout = '10s';

BEGIN;

DO $drift$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.shops_stock_rows(timestamptz,text[])')
                   AND md5(replace(p.prosrc, chr(13), '')) IN ('9283c36aaf66b0362d831713124a25d8', 'a33d7af7a9fee5131fc76bbf76641a08')) THEN
    RAISE EXCEPTION 'shops_stock_rows changed since this migration was written — re-emit it from the live body';
  END IF;
END
$drift$;

CREATE OR REPLACE FUNCTION public.shops_stock_rows(p_at timestamptz, p_shops text[])
RETURNS TABLE (shop_code text, article_code text, name text, brand text, qty numeric, reserved numeric, sold_30d numeric,
               last_sold_at timestamptz, zero_top_seller boolean, avg_cost_mkd numeric, retail_price_mkd numeric, taken_at timestamptz, moves bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  WITH st AS (
    SELECT * FROM public.shops_stock_at(p_at, p_shops) x
     WHERE NOT EXISTS (SELECT 1 FROM public.shop_articles a WHERE a.article_code = x.article_code AND a.is_point)
       AND x.article_code !~* '^поен'
  ), sold AS (
    SELECT l.shop_code AS s, l.article_code AS a, sum(CASE WHEN l.is_return THEN -l.qty ELSE l.qty END) AS q, max(l.sold_at) AS last_at
      FROM public.shop_sales_lines l
     WHERE l.sold_at > p_at - interval '30 days' AND l.sold_at <= p_at AND NOT l.is_point AND l.shop_code = ANY (p_shops)
     GROUP BY 1, 2
  ), lastsold AS (
    SELECT l.shop_code AS s, l.article_code AS a, max(l.sold_at) AS last_at
      FROM public.shop_sales_lines l
     WHERE l.sold_at > p_at - interval '365 days' AND l.sold_at <= p_at AND NOT l.is_point AND NOT l.is_return AND l.shop_code = ANY (p_shops)
     GROUP BY 1, 2
  ), top AS (
    SELECT l.article_code AS a
      FROM public.shop_sales_lines l
     WHERE l.sold_at > p_at - interval '30 days' AND l.sold_at <= p_at AND NOT l.is_point AND NOT l.is_return
       -- goods only (02.10.2026): a Sigma article code (00xxxx — collabBox bundle codes are 1xxxxx–8xxxxx, bags
       -- and consumables have 4 digits), and never a bundle name ("1+1 …", "ТУРМЕРИК 1+1", "2+2 АЛОЕ …",
       -- "3/1 ДИАБЕТОЛ …", "2 КРЕАТИН …") — those are assembled at the till by 10040 and never sit on a shelf.
       AND l.article_code ~ '^00[0-9]{4}$'
       AND coalesce(l.article_name, '') !~ '[0-9]\s*\+\s*[0-9]'
       AND coalesce(l.article_name, '') !~ '^\s*[0-9]+\s*/\s*[0-9]+\s'
       AND coalesce(l.article_name, '') !~ '^\s*[1-9]\s+[^0-9%]'
     GROUP BY l.article_code ORDER BY sum(l.qty) DESC LIMIT 20
  ), keys AS (
    SELECT st.shop_code AS s, st.article_code AS a FROM st
    UNION SELECT sold.s, sold.a FROM sold
    UNION SELECT s.s, top.a FROM (SELECT DISTINCT st.shop_code AS s FROM st) s CROSS JOIN top
  ), br AS (
    SELECT b.article_code AS a, b.brand FROM public.shops_brands((SELECT coalesce(array_agg(DISTINCT keys.a), ARRAY[]::text[]) FROM keys)) b
  )
  SELECT k.s, k.a, coalesce(sa.name, k.a), coalesce(br.brand, sa.group_name),
         coalesce(st.qty, 0), coalesce(st.reserved, 0), coalesce(sold.q, 0), ls.last_at,
         (coalesce(st.qty, 0) <= 0 AND k.a IN (SELECT top.a FROM top)),
         coalesce(st.avg_cost_mkd, sa.last_avg_cost_mkd), coalesce(st.retail_price_mkd, sa.last_retail_mkd),
         (SELECT max(t.taken_at) FROM public.shop_stock_takes t WHERE t.shop_code = k.s AND t.taken_at <= p_at),
         coalesce(st.moves, 0)::bigint
    FROM keys k
    LEFT JOIN st ON st.shop_code = k.s AND st.article_code = k.a
    LEFT JOIN sold ON sold.s = k.s AND sold.a = k.a
    LEFT JOIN lastsold ls ON ls.s = k.s AND ls.a = k.a
    LEFT JOIN public.shop_articles sa ON sa.article_code = k.a
    LEFT JOIN br ON br.a = k.a
   WHERE coalesce(sa.is_point, false) = false;
END
$fn$;

COMMIT;

NOTIFY pgrst, 'reload schema';
