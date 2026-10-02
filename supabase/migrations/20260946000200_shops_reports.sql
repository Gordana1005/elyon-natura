-- ============================================================================
-- Shops (Продавници) 2/3 — the reports behind GET /api/shops/* (JSON = src/lib/shopsTypes.ts)
-- ============================================================================
--   shops_day(day, money)                      → ShopsDay        (live when the day is today)
--   shops_period(from, to, money)              → ShopsPeriod     (+ what Natura invoiced the shops)
--   shop_detail(code, from, to, at, money)     → ShopDetail      (stock at `at` = latest take ≤ at + lines after it)
--   shops_stock_matrix(at, q, brand, money)    → ShopsStockMatrix
--   shops_deliveries(from, to, shop, money)    → ShopsDeliveries (Sigma invoice ↔ collabBox 10042 by Natura's number)
--   shops_health(money)                        → ShopsHealth
-- p_money = false (managers) → every *_mkd key is ABSENT (shops_strip_money; the api strips again).
--
-- HOW THE NUMBERS ARE MADE (docs/SHOPS.md; owner 02.10.2026):
--   * Days are Skopje days; a live day ends now. Sales = 10022 receipt lines − 10010 retail returns, WITH VAT;
--     loyalty ПОЕН-* lines never count (units, sales) — the controls include them (the till does).
--   * Ex VAT: each line ÷ (1 + its article's VAT): the line's own → shop_articles (nightly infollc) → products.vat_rate
--     by sku → 5 % (quality.vat_unclassified_units counts those units — never silent).
--   * cost_mkd = the shop's purchase cost ex VAT (collabBox's booked cost = Natura's invoice price). A line whose
--     unit cost is > 3 × the chain's median for that article and month is capped at the median (bundles assembled in
--     the shop break the average cost — Сити Мол 30.09: 4.667 / 5.736 ден vs ≈ 950); quality.cost_capped_lines.
--   * group_cost_mkd = Natura's own cost of the units sold: Stock v2 article_cost_at() (a kit = its components via
--     stock_article_kits) at the sale day. NULL while any unit has no cost (Stock v2 costs not loaded / migration
--     20260945000600 absent) — never invented; quality.group_cost_missing_units.
--   * vs_avg_pct: a day vs the same weekday of the 4 previous weeks (the weeks with data; live = cut at the same
--     elapsed time), a period vs the previous equal period; money for owners, units for managers.
--   * Stock at a moment: shops_stock_at(). Goods documents move stock by shops_doc_delta() (10005 by value sign,
--     10011 never, trade-book corrections never); ПОЕН vouchers are kept out of every product total.
--   * Natura's side (shops_period.natura, shops_deliveries): Stock v2's Sigma staging (stock_sigma_docs, client
--     000001, object = the shop) when it holds documents, else collabBox's own receipts (10042 in, 10044 back).
--     Sigma staging has quantities only: the money of a delivery is the received 10042's lines ex VAT. The TV
--     re-invoicing to Stores is not in the staging → ads_reinvoiced_ex_vat_mkd = NULL.
--
-- STABLE, SECURITY DEFINER, EXECUTE for service_role (+ supabase_read_only_user for scripts/shops/verify-shops.mjs).
-- Rollback: DROP these functions; the api answers 500 on the shops routes until re-applied.
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $dep$
BEGIN
  IF to_regclass('public.shop_sales_lines') IS NULL OR to_regprocedure('public.shops_doc_delta(text,text,text,text,numeric,numeric,numeric,boolean)') IS NULL THEN
    RAISE EXCEPTION '20260946000200: apply 20260946000100 (shops schema) first';
  END IF;
END
$dep$;

-- ── 0. small helpers ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.shops_type_name(p_type text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = public, pg_temp
AS $fn$
  SELECT CASE p_type
    WHEN '10022' THEN 'Фискална Сметка' WHEN '10010' THEN 'Повратница од малопродажба'
    WHEN '10018' THEN 'Дневен Финансиски Извештај' WHEN '10042' THEN 'Влезна Фактура'
    WHEN '10014' THEN 'Приемен лист во трговија' WHEN '10015' THEN 'Препратница'
    WHEN '10061' THEN 'Препратница меѓу продавници' WHEN '10044' THEN 'Повратница до добавувач'
    WHEN '10040' THEN 'Налог за производство' WHEN '10062' THEN 'Записник за оштетена роба'
    WHEN '10011' THEN 'Пописна листа' WHEN '10005' THEN 'Лагер-попис разлика' ELSE p_type END
$fn$;

CREATE OR REPLACE FUNCTION public.shops_ref_json(p_code text)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = public, pg_temp
AS $fn$
  SELECT jsonb_build_object('code', s.code, 'name', s.name, 'city', s.city, 'sigma_object', s.sigma_object, 'active', s.active)
    FROM public.shops s WHERE s.code = p_code
$fn$;

-- Every key ending in _mkd removed, at any depth (the managers' view).
CREATE OR REPLACE FUNCTION public.shops_strip_money(p jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp
AS $fn$
DECLARE v jsonb; k text; x jsonb;
BEGIN
  IF p IS NULL THEN RETURN NULL; END IF;
  IF jsonb_typeof(p) = 'object' THEN
    v := '{}'::jsonb;
    FOR k, x IN SELECT e.key, e.value FROM jsonb_each(p) e LOOP
      CONTINUE WHEN k ~ '_mkd$';
      v := v || jsonb_build_object(k, public.shops_strip_money(x));
    END LOOP;
    RETURN v;
  ELSIF jsonb_typeof(p) = 'array' THEN
    SELECT coalesce(jsonb_agg(public.shops_strip_money(e.value) ORDER BY e.ord), '[]'::jsonb) INTO v
      FROM jsonb_array_elements(p) WITH ORDINALITY AS e(value, ord);
    RETURN v;
  END IF;
  RETURN p;
END
$fn$;

CREATE OR REPLACE FUNCTION public.shops_freshness()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
  SELECT jsonb_build_object(
    'last_sales_at', greatest(
        (SELECT max(r.finished_at) FROM public.shops_reader_runs r WHERE r.status IN ('ok', 'partial') AND r.stats ? 'sales'),
        (SELECT max(l.read_at) FROM public.shop_sales_lines l)),
    'last_docs_at', greatest(
        (SELECT max(r.finished_at) FROM public.shops_reader_runs r WHERE r.status IN ('ok', 'partial') AND r.stats ? 'docs'),
        (SELECT max(d.read_at) FROM public.shop_docs d)),
    'last_stock_snapshot_at', (SELECT max(t.taken_at) FROM public.shop_stock_takes t WHERE t.source = 'infollc'),
    'reader_last_run_at', (SELECT max(coalesce(r.finished_at, r.started_at)) FROM public.shops_reader_runs r))
$fn$;

-- Natura's own cost (Stock v2) of articles at days: [{a, d}] → (article_code, day, cost_mkd). NULL when
-- article_cost_at() is absent or has no cost; a kit = Σ its components (stock_article_kits) when it has none.
CREATE OR REPLACE FUNCTION public.shops_unit_costs(p_pairs jsonb)
RETURNS TABLE (article_code text, day date, cost_mkd numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF to_regprocedure('public.article_cost_at(text,timestamp with time zone)') IS NULL THEN
    RETURN QUERY SELECT x.a, x.d, NULL::numeric FROM jsonb_to_recordset(coalesce(p_pairs, '[]'::jsonb)) AS x(a text, d date);
    RETURN;
  END IF;
  IF to_regclass('public.stock_article_kits') IS NULL THEN
    RETURN QUERY EXECUTE $q$
      SELECT x.a, x.d, public.article_cost_at(x.a, ((x.d + 1)::timestamp AT TIME ZONE 'Europe/Skopje') - interval '1 second')
        FROM jsonb_to_recordset($1) AS x(a text, d date) $q$
      USING coalesce(p_pairs, '[]'::jsonb);
    RETURN;
  END IF;
  RETURN QUERY EXECUTE $q$
    SELECT x.a, x.d,
           coalesce(public.article_cost_at(x.a, t.at),
                    (SELECT CASE WHEN count(*) = 0 OR bool_or(k.c IS NULL) THEN NULL ELSE round(sum(k.qty * k.c), 4) END
                       FROM (SELECT kk.qty, public.article_cost_at(kk.component_code, t.at) AS c
                               FROM public.stock_article_kits kk WHERE kk.kit_code = x.a) k))
      FROM jsonb_to_recordset($1) AS x(a text, d date)
      CROSS JOIN LATERAL (SELECT ((x.d + 1)::timestamp AT TIME ZONE 'Europe/Skopje') - interval '1 second' AS at) t $q$
    USING coalesce(p_pairs, '[]'::jsonb);
END
$fn$;

-- ── 1. line facts: one row per sales line in [p_from, p_to) ─────────────────
CREATE OR REPLACE FUNCTION public.shops_line_facts(p_from timestamptz, p_to timestamptz, p_shops text[] DEFAULT NULL)
RETURNS TABLE (doc_number text, doc_type text, shop_code text, sold_at timestamptz, day date, hour integer,
               article_code text, article_name text, is_point boolean, is_return boolean, named_customer boolean,
               units numeric, sale numeric, sale_ex_vat numeric, cost_booked numeric, cost_ex_vat numeric,
               cost_capped boolean, vat numeric, vat_known boolean, cashier text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
  WITH l AS (
    SELECT l.*, (l.sold_at AT TIME ZONE 'Europe/Skopje') AS loc, CASE WHEN l.is_return THEN -1 ELSE 1 END AS sgn
      FROM public.shop_sales_lines l
     WHERE l.sold_at >= p_from AND l.sold_at < p_to AND (p_shops IS NULL OR l.shop_code = ANY (p_shops))
  ), codes AS (
    SELECT DISTINCT l.article_code FROM l
  ), pv AS (
    SELECT DISTINCT ON (btrim(p.sku)) btrim(p.sku) AS sku, p.vat_rate
      FROM public.products p
     WHERE p.vat_rate IS NOT NULL AND btrim(p.sku) IN (SELECT c.article_code FROM codes c)
     ORDER BY btrim(p.sku), p.is_active DESC NULLS LAST
  ), med AS (
    SELECT m.article_code, date_trunc('month', m.sold_at AT TIME ZONE 'Europe/Skopje') AS mon,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY m.unit_cost_mkd) AS med
      FROM public.shop_sales_lines m
     WHERE m.doc_type = '10022' AND NOT m.is_point AND m.qty > 0 AND m.unit_cost_mkd > 0
       AND m.sold_at >= (date_trunc('month', p_from AT TIME ZONE 'Europe/Skopje') AT TIME ZONE 'Europe/Skopje')
       AND m.sold_at <  ((date_trunc('month', (p_to - interval '1 microsecond') AT TIME ZONE 'Europe/Skopje') + interval '1 month') AT TIME ZONE 'Europe/Skopje')
       AND m.article_code IN (SELECT c.article_code FROM codes c)
     GROUP BY 1, 2
  )
  SELECT l.doc_number, l.doc_type, l.shop_code, l.sold_at, l.loc::date, extract(hour FROM l.loc)::int,
         l.article_code, l.article_name, l.is_point, l.is_return, l.named_customer,
         CASE WHEN l.is_point THEN 0 ELSE l.sgn * l.qty END,
         CASE WHEN l.is_point THEN 0 ELSE l.sgn * coalesce(l.sale_value_mkd, 0) END,
         CASE WHEN l.is_point THEN 0 ELSE l.sgn * coalesce(l.sale_value_mkd, 0) / (1 + v.vat) END,
         CASE WHEN l.is_point THEN 0 ELSE l.sgn * coalesce(l.cost_value_mkd, 0) END,
         CASE WHEN l.is_point THEN 0
              ELSE l.sgn * (CASE WHEN c.capped THEN c.med * l.qty ELSE coalesce(l.cost_value_mkd, 0) END) / (1 + v.vat) END,
         coalesce(c.capped, false), v.vat, v.known, l.cashier
    FROM l
    LEFT JOIN public.shop_articles a ON a.article_code = l.article_code
    LEFT JOIN pv ON pv.sku = l.article_code
    LEFT JOIN med ON med.article_code = l.article_code AND med.mon = date_trunc('month', l.loc)
    CROSS JOIN LATERAL (SELECT coalesce(l.vat_rate, a.vat_rate, pv.vat_rate, 0.05)::numeric AS vat,
                               (l.vat_rate IS NOT NULL OR a.vat_rate IS NOT NULL OR pv.vat_rate IS NOT NULL) AS known) v
    CROSS JOIN LATERAL (SELECT med.med::numeric AS med,
                               (NOT l.is_point AND coalesce(med.med, 0) > 0 AND l.unit_cost_mkd > 3 * med.med) AS capped) c
$fn$;

-- Natura's cost per (shop, article, day) of the units sold (net of returns, no ПОЕН).
CREATE OR REPLACE FUNCTION public.shops_group_costs(p_from timestamptz, p_to timestamptz, p_shops text[] DEFAULT NULL)
RETURNS TABLE (shop_code text, article_code text, day date, units numeric, unit_cost numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  WITH u AS (
    SELECT l.shop_code AS s, l.article_code AS a, (l.sold_at AT TIME ZONE 'Europe/Skopje')::date AS d,
           sum(CASE WHEN l.is_return THEN -l.qty ELSE l.qty END) AS q
      FROM public.shop_sales_lines l
     WHERE l.sold_at >= p_from AND l.sold_at < p_to AND NOT l.is_point AND (p_shops IS NULL OR l.shop_code = ANY (p_shops))
     GROUP BY 1, 2, 3
  ), c AS (
    SELECT uc.article_code AS a, uc.day AS d, uc.cost_mkd AS cost
      FROM public.shops_unit_costs((SELECT coalesce(jsonb_agg(DISTINCT jsonb_build_object('a', u.a, 'd', u.d)), '[]'::jsonb) FROM u)) uc
  )
  SELECT u.s, u.a, u.d, u.q, c.cost FROM u LEFT JOIN c ON c.a = u.a AND c.d = u.d;
END
$fn$;

-- Per shop over [p_from, p_to): everything a ShopDayRow needs.
CREATE OR REPLACE FUNCTION public.shops_agg(p_from timestamptz, p_to timestamptz, p_shops text[] DEFAULT NULL)
RETURNS TABLE (shop_code text, receipts bigint, units numeric, returns_units numeric, first_at timestamptz, last_at timestamptz,
               days_with_sales bigint, sales numeric, sales_ex_vat numeric, returns_value numeric, cost_ex_vat numeric,
               cost_booked numeric, cost_capped_lines bigint, vat_unclassified_units numeric, named_customer_receipts bigint,
               group_cost numeric, group_cost_missing_units numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
  WITH f AS (SELECT * FROM public.shops_line_facts(p_from, p_to, p_shops)),
  g AS (
    SELECT gc.shop_code AS s,
           CASE WHEN bool_or(gc.unit_cost IS NULL AND gc.units <> 0) THEN NULL ELSE round(sum(gc.units * coalesce(gc.unit_cost, 0)), 2) END AS cost,
           coalesce(sum(abs(gc.units)) FILTER (WHERE gc.unit_cost IS NULL), 0) AS missing
      FROM public.shops_group_costs(p_from, p_to, p_shops) gc GROUP BY gc.shop_code
  ), a AS (
    SELECT f.shop_code AS s,
           count(DISTINCT f.doc_number) FILTER (WHERE f.doc_type = '10022') AS receipts,
           coalesce(sum(f.units) FILTER (WHERE NOT f.is_return), 0) AS units,
           coalesce(-sum(f.units) FILTER (WHERE f.is_return), 0) AS returns_units,
           min(f.sold_at) FILTER (WHERE f.doc_type = '10022') AS first_at,
           max(f.sold_at) FILTER (WHERE f.doc_type = '10022') AS last_at,
           count(DISTINCT f.day) FILTER (WHERE f.doc_type = '10022') AS days_with_sales,
           coalesce(sum(f.sale), 0) AS sales,
           coalesce(sum(f.sale_ex_vat), 0) AS sales_ex_vat,
           coalesce(-sum(f.sale) FILTER (WHERE f.is_return), 0) AS returns_value,
           coalesce(sum(f.cost_ex_vat), 0) AS cost_ex_vat,
           coalesce(sum(f.cost_booked), 0) AS cost_booked,
           count(*) FILTER (WHERE f.cost_capped) AS capped,
           coalesce(sum(abs(f.units)) FILTER (WHERE NOT f.vat_known AND NOT f.is_point), 0) AS vat_unclassified,
           count(DISTINCT f.doc_number) FILTER (WHERE f.named_customer) AS named
      FROM f GROUP BY f.shop_code
  )
  SELECT a.s, a.receipts, a.units, a.returns_units, a.first_at, a.last_at, a.days_with_sales, a.sales, a.sales_ex_vat,
         a.returns_value, a.cost_ex_vat, a.cost_booked, a.capped, a.vat_unclassified, a.named, g.cost, coalesce(g.missing, 0)
    FROM a LEFT JOIN g ON g.s = a.s
$fn$;

-- Sales (net, with VAT, no ПОЕН) and units per shop over a window — the light comparison base.
CREATE OR REPLACE FUNCTION public.shops_totals(p_from timestamptz, p_to timestamptz)
RETURNS TABLE (shop_code text, sales numeric, units numeric, lines bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
  SELECT l.shop_code,
         coalesce(sum(CASE WHEN l.is_point THEN 0 WHEN l.is_return THEN -coalesce(l.sale_value_mkd, 0) ELSE coalesce(l.sale_value_mkd, 0) END), 0),
         coalesce(sum(CASE WHEN l.is_point OR l.is_return THEN 0 ELSE l.qty END), 0),
         count(*)
    FROM public.shop_sales_lines l
   WHERE l.sold_at >= p_from AND l.sold_at < p_to
   GROUP BY l.shop_code
$fn$;

-- ShopDayRow[] + ShopsTotals for a window. p_cmp: the comparison windows [{"from": ts, "to": ts}, …];
-- p_cmp_avg: average them (the weekday base) or take the single one (the previous period).
CREATE OR REPLACE FUNCTION public.shops_rows_json(p_from timestamptz, p_to timestamptz, p_cmp jsonb, p_cmp_avg boolean,
                                                  p_money boolean, p_shops text[] DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_d0 date := (p_from AT TIME ZONE 'Europe/Skopje')::date;
  v_d1 date := ((p_to - interval '1 microsecond') AT TIME ZONE 'Europe/Skopje')::date;
  v_rows jsonb; v_tot jsonb;
BEGIN
  WITH a AS (SELECT * FROM public.shops_agg(p_from, p_to, p_shops)),
  cw AS (SELECT (e->>'from')::timestamptz AS f, (e->>'to')::timestamptz AS t, ord FROM jsonb_array_elements(coalesce(p_cmp, '[]'::jsonb)) WITH ORDINALITY x(e, ord)),
  cb AS (SELECT cw.ord, t.shop_code AS s, t.sales, t.units FROM cw CROSS JOIN LATERAL public.shops_totals(cw.f, cw.t) t),
  cn AS (SELECT count(DISTINCT cb.ord) AS n FROM cb),
  base AS (
    SELECT cb.s, CASE WHEN p_cmp_avg THEN sum(cb.sales) / nullif((SELECT n FROM cn), 0) ELSE sum(cb.sales) END AS sales,
                 CASE WHEN p_cmp_avg THEN sum(cb.units) / nullif((SELECT n FROM cn), 0) ELSE sum(cb.units) END AS units
      FROM cb GROUP BY cb.s
  ),
  ctl AS (
    SELECT c.shop_code AS s, CASE WHEN count(c.ok) = 0 THEN NULL ELSE bool_and(c.ok) END AS ok,
           count(c.cash_mkd) AS cash_days, sum(c.cash_mkd) AS cash, count(c.card_mkd) AS card_days, sum(c.card_mkd) AS card
      FROM public.shop_day_controls c WHERE c.day BETWEEN v_d0 AND v_d1 GROUP BY c.shop_code
  ),
  r AS (
    SELECT s.code, s.sort, coalesce(a.receipts, 0) AS receipts, coalesce(a.units, 0) AS units, coalesce(a.returns_units, 0) AS returns_units,
           a.first_at, a.last_at, coalesce(a.days_with_sales, 0) AS days, coalesce(a.sales, 0) AS sales, coalesce(a.sales_ex_vat, 0) AS sales_ex,
           coalesce(a.returns_value, 0) AS returns, coalesce(a.cost_ex_vat, 0) AS cost_ex, coalesce(a.cost_capped_lines, 0) AS capped,
           coalesce(a.vat_unclassified_units, 0) AS vat_unc, coalesce(a.named_customer_receipts, 0) AS named,
           CASE WHEN a.shop_code IS NULL THEN 0::numeric ELSE a.group_cost END AS gcost, coalesce(a.group_cost_missing_units, 0) AS gmiss,
           ctl.ok, CASE WHEN coalesce(a.days_with_sales, 0) = 0 THEN 0 WHEN ctl.cash_days >= a.days_with_sales THEN ctl.cash END AS cash,
           CASE WHEN coalesce(a.days_with_sales, 0) = 0 THEN 0 WHEN ctl.card_days >= a.days_with_sales THEN ctl.card END AS card,
           CASE WHEN p_money THEN b.sales ELSE b.units END AS base_v,
           CASE WHEN p_money THEN coalesce(a.sales, 0) ELSE coalesce(a.units, 0) END AS cur_v
      FROM public.shops s
      LEFT JOIN a ON a.shop_code = s.code
      LEFT JOIN base b ON b.s = s.code
      LEFT JOIN ctl ON ctl.s = s.code
     WHERE (p_shops IS NULL OR s.code = ANY (p_shops)) AND (s.active OR a.shop_code IS NOT NULL)
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'shop', public.shops_ref_json(r.code),
           'receipts', r.receipts, 'units', r.units, 'returns_units', r.returns_units,
           'first_receipt_at', r.first_at, 'last_receipt_at', r.last_at,
           'vs_avg_pct', CASE WHEN r.base_v > 0 THEN round(100 * (r.cur_v - r.base_v) / r.base_v, 1) END,
           'control_ok', r.ok,
           'sales_mkd', round(r.sales, 2), 'sales_ex_vat_mkd', round(r.sales_ex, 2),
           'cash_mkd', r.cash, 'card_mkd', r.card,
           'avg_receipt_mkd', CASE WHEN r.receipts > 0 THEN round(r.sales / r.receipts, 2) END,
           'cost_mkd', round(r.cost_ex, 2), 'shop_margin_mkd', round(r.sales_ex - r.cost_ex, 2),
           'group_cost_mkd', r.gcost, 'group_margin_mkd', CASE WHEN r.gcost IS NOT NULL THEN round(r.sales_ex - r.gcost, 2) END,
           'returns_mkd', round(r.returns, 2),
           'quality', jsonb_build_object('cost_capped_lines', r.capped, 'vat_unclassified_units', r.vat_unc,
                                         'group_cost_missing_units', r.gmiss, 'named_customer_receipts', r.named)
         ) ORDER BY r.cur_v DESC, r.sort), '[]'::jsonb),
         jsonb_build_object(
           'shops_open', count(*) FILTER (WHERE r.receipts > 0),
           'receipts', coalesce(sum(r.receipts), 0), 'units', coalesce(sum(r.units), 0), 'returns_units', coalesce(sum(r.returns_units), 0),
           'sales_mkd', round(coalesce(sum(r.sales), 0), 2), 'sales_ex_vat_mkd', round(coalesce(sum(r.sales_ex), 0), 2),
           'cash_mkd', CASE WHEN bool_and(r.cash IS NOT NULL) THEN sum(r.cash) END,
           'card_mkd', CASE WHEN bool_and(r.card IS NOT NULL) THEN sum(r.card) END,
           'avg_receipt_mkd', CASE WHEN sum(r.receipts) > 0 THEN round(sum(r.sales) / sum(r.receipts), 2) END,
           'cost_mkd', round(coalesce(sum(r.cost_ex), 0), 2), 'shop_margin_mkd', round(coalesce(sum(r.sales_ex - r.cost_ex), 0), 2),
           'group_cost_mkd', CASE WHEN bool_and(r.gcost IS NOT NULL) THEN sum(r.gcost) END,
           'group_margin_mkd', CASE WHEN bool_and(r.gcost IS NOT NULL) THEN round(sum(r.sales_ex) - sum(r.gcost), 2) END,
           'returns_mkd', round(coalesce(sum(r.returns), 0), 2),
           'quality', jsonb_build_object('cost_capped_lines', coalesce(sum(r.capped), 0), 'vat_unclassified_units', coalesce(sum(r.vat_unc), 0),
                                         'group_cost_missing_units', coalesce(sum(r.gmiss), 0), 'named_customer_receipts', coalesce(sum(r.named), 0)))
    INTO v_rows, v_tot
    FROM r;
  RETURN jsonb_build_object('rows', v_rows, 'totals', v_tot);
END
$fn$;

-- ── 2. stock at a moment ────────────────────────────────────────────────────
-- Per shop: the latest take ≤ p_at, plus every receipt / return / goods line after it up to p_at. A shop with
-- no take before p_at has no rows (its stock is unknown, never guessed).
CREATE OR REPLACE FUNCTION public.shops_stock_at(p_at timestamptz, p_shops text[] DEFAULT NULL)
RETURNS TABLE (shop_code text, article_code text, qty numeric, reserved numeric, avg_cost_mkd numeric, retail_price_mkd numeric,
               taken_at timestamptz, moves bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
  WITH t AS (
    SELECT s.code AS s, (SELECT max(k.taken_at) FROM public.shop_stock_takes k WHERE k.shop_code = s.code AND k.taken_at <= p_at) AS taken
      FROM public.shops s WHERE p_shops IS NULL OR s.code = ANY (p_shops)
  ), snap AS (
    SELECT x.shop_code AS s, x.article_code AS a, x.qty, x.reserved, x.avg_cost_mkd, x.retail_price_mkd
      FROM public.shop_stock_snapshots x JOIN t ON t.s = x.shop_code AND x.taken_at = t.taken
  ), sl AS (
    SELECT l.shop_code AS s, l.article_code AS a, sum(CASE WHEN l.is_return THEN l.qty ELSE -l.qty END) AS d, count(*) AS n
      FROM public.shop_sales_lines l JOIN t ON t.s = l.shop_code
     WHERE t.taken IS NOT NULL AND l.sold_at > t.taken AND l.sold_at <= p_at
     GROUP BY 1, 2
  ), dl AS (
    SELECT t.s, x.article_code AS a,
           sum(public.shops_doc_delta(x.doc_type, t.s, x.wh_in, x.wh_out, x.qty_in, x.qty_out, coalesce(x.sale_value_mkd, x.cost_value_mkd), x.is_correction)) AS d,
           count(*) AS n
      FROM t
      JOIN public.shop_doc_lines x ON (x.wh_in = t.s OR x.wh_out = t.s) AND x.doc_at > t.taken AND x.doc_at <= p_at
      JOIN public.shop_docs dd ON dd.doc_number = x.doc_number AND dd.vanished_at IS NULL
     WHERE t.taken IS NOT NULL
     GROUP BY 1, 2
  ), mv AS (
    SELECT u.s, u.a, sum(u.d) AS d, sum(u.n) AS n FROM (SELECT * FROM sl UNION ALL SELECT * FROM dl) u GROUP BY 1, 2
  )
  SELECT coalesce(sn.s, mv.s), coalesce(sn.a, mv.a), coalesce(sn.qty, 0) + coalesce(mv.d, 0), coalesce(sn.reserved, 0),
         sn.avg_cost_mkd, sn.retail_price_mkd, t.taken, coalesce(mv.n, 0)::bigint
    FROM snap sn
    FULL JOIN mv ON mv.s = sn.s AND mv.a = sn.a
    JOIN t ON t.s = coalesce(sn.s, mv.s)
$fn$;

-- ── 3. ShopsDay ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.shops_day(p_day date DEFAULT NULL, p_money boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_today date := (now() AT TIME ZONE 'Europe/Skopje')::date;
  v_day date := least(coalesce(p_day, v_today), v_today);
  v_from timestamptz := v_day::timestamp AT TIME ZONE 'Europe/Skopje';
  v_to timestamptz := CASE WHEN v_day = v_today THEN now() ELSE (v_day + 1)::timestamp AT TIME ZONE 'Europe/Skopje' END;
  v_cmp jsonb; v_rt jsonb; v_hourly jsonb; v_out jsonb;
BEGIN
  SELECT jsonb_agg(jsonb_build_object('from', w.f, 'to', w.f + (v_to - v_from)) ORDER BY k)
    INTO v_cmp
    FROM generate_series(1, 4) k
    CROSS JOIN LATERAL (SELECT ((v_day - 7 * k)::timestamp AT TIME ZONE 'Europe/Skopje') AS f) w;
  v_rt := public.shops_rows_json(v_from, v_to, v_cmp, true, p_money, NULL);
  SELECT coalesce(jsonb_agg(jsonb_build_object('hour', h.hour, 'receipts', h.receipts, 'units', h.units, 'sales_mkd', h.sales) ORDER BY h.hour), '[]'::jsonb)
    INTO v_hourly
    FROM (SELECT f.hour, count(DISTINCT f.doc_number) FILTER (WHERE f.doc_type = '10022') AS receipts,
                 coalesce(sum(f.units) FILTER (WHERE NOT f.is_return), 0) AS units, round(coalesce(sum(f.sale), 0), 2) AS sales
            FROM public.shops_line_facts(v_from, v_to, NULL) f GROUP BY f.hour) h;
  v_out := jsonb_build_object('day', v_day, 'live', v_day = v_today, 'shops', v_rt->'rows', 'totals', v_rt->'totals',
                              'hourly', v_hourly, 'freshness', public.shops_freshness());
  RETURN CASE WHEN p_money THEN v_out ELSE public.shops_strip_money(v_out) END;
END
$fn$;

-- ── 4. what Natura invoiced the shops (Sigma) / what Stores received (collabBox) ──
CREATE OR REPLACE FUNCTION public.shops_natura_json(p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_lo timestamptz := p_from::timestamp AT TIME ZONE 'Europe/Skopje';
  v_hi timestamptz := (p_to + 1)::timestamp AT TIME ZONE 'Europe/Skopje';
  v_sigma boolean := false; v_out jsonb; v_units jsonb;
BEGIN
  IF to_regclass('public.stock_sigma_docs') IS NOT NULL THEN
    SELECT EXISTS (SELECT 1 FROM public.stock_sigma_docs d WHERE d.client_code = '000001' AND d.vanished_at IS NULL) INTO v_sigma;
  END IF;
  IF v_sigma THEN
    WITH d AS (
      SELECT d.doc_key, d.doc_type, d.doc_date, d.doc_no, l.item_code, l.qty, l.side
        FROM public.stock_sigma_docs d
        CROSS JOIN LATERAL jsonb_to_recordset(d.lines) AS l(item_code text, qty numeric, side text)
       WHERE d.client_code = '000001' AND d.vanished_at IS NULL AND d.excluded_reason IS NULL
         AND d.doc_date BETWEEN p_from AND p_to
    ), u AS (
      SELECT coalesce(sum(d.qty) FILTER (WHERE d.doc_type IN ('ПМ1', 'ПМ2', 'ПМ9') AND d.side = 'out'), 0) AS delivered,
             coalesce(sum(d.qty) FILTER (WHERE d.doc_type IN ('ПМ4', 'ПМ11') AND d.side = 'in'), 0) AS returned
        FROM d
    ), net AS (
      SELECT d.item_code AS a, d.doc_date AS dd,
             sum(CASE WHEN d.doc_type IN ('ПМ1', 'ПМ2', 'ПМ9') AND d.side = 'out' THEN d.qty
                      WHEN d.doc_type IN ('ПМ4', 'ПМ11') AND d.side = 'in' THEN -d.qty ELSE 0 END) AS q
        FROM d GROUP BY 1, 2
    ), nc AS (
      SELECT CASE WHEN bool_or(c.cost_mkd IS NULL AND net.q <> 0) THEN NULL ELSE round(sum(net.q * coalesce(c.cost_mkd, 0)), 2) END AS cost
        FROM net LEFT JOIN public.shops_unit_costs((SELECT coalesce(jsonb_agg(jsonb_build_object('a', net.a, 'd', net.dd)), '[]'::jsonb) FROM net)) c
          ON c.article_code = net.a AND c.day = net.dd
    ), inv AS (
      -- the money of an invoice = the lines of the 10042 that received it (ex VAT); NULL while any is not received
      SELECT CASE WHEN bool_or(x.v IS NULL) THEN NULL ELSE round(sum(x.v), 2) END AS v, count(*) AS n, count(x.v) AS matched
        FROM (SELECT DISTINCT d.doc_key, d.doc_no FROM d WHERE d.doc_type IN ('ПМ1', 'ПМ2', 'ПМ9')) i
        LEFT JOIN LATERAL (
          SELECT sum(coalesce(dl.cost_value_mkd, 0) / (1 + coalesce(dl.vat_rate, a.vat_rate, 0.05))) AS v
            FROM public.shop_docs sd
            JOIN public.shop_doc_lines dl ON dl.doc_number = sd.doc_number AND NOT dl.is_correction
            LEFT JOIN public.shop_articles a ON a.article_code = dl.article_code
           WHERE sd.doc_type = '10042' AND sd.vanished_at IS NULL
             AND regexp_replace(sd.natura_doc_key, '^\d+-', '') = regexp_replace(public.shops_natura_doc_key(i.doc_no), '^\d+-', '')
             AND sd.doc_at >= v_lo - interval '10 days' AND sd.doc_at < v_hi + interval '60 days'
        ) x ON true
    )
    SELECT jsonb_build_object('basis', 'sigma', 'units_delivered', u.delivered, 'units_returned', u.returned,
                              'invoiced_ex_vat_mkd', inv.v, 'natura_cost_mkd', nc.cost,
                              'natura_margin_mkd', CASE WHEN inv.v IS NOT NULL AND nc.cost IS NOT NULL THEN round(inv.v - nc.cost, 2) END,
                              'ads_reinvoiced_ex_vat_mkd', NULL, 'invoices', inv.n, 'invoices_received', inv.matched)
      INTO v_out FROM u, nc, inv;
    RETURN v_out;
  END IF;
  -- no Sigma staging yet: what Stores' 001 Централен received from Natura (10042) and sent back (10044)
  WITH x AS (
    SELECT sd.doc_type, dl.article_code, (dl.doc_at AT TIME ZONE 'Europe/Skopje')::date AS dd,
           CASE WHEN sd.doc_type = '10042' THEN dl.qty_in - dl.qty_out ELSE dl.qty_out - dl.qty_in END AS q,
           coalesce(dl.cost_value_mkd, 0) / (1 + coalesce(dl.vat_rate, a.vat_rate, 0.05)) AS v
      FROM public.shop_docs sd
      JOIN public.shop_doc_lines dl ON dl.doc_number = sd.doc_number AND NOT dl.is_correction AND NOT dl.is_point
      LEFT JOIN public.shop_articles a ON a.article_code = dl.article_code
     WHERE sd.doc_type IN ('10042', '10044') AND sd.vanished_at IS NULL AND sd.doc_at >= v_lo AND sd.doc_at < v_hi
  ), net AS (
    SELECT x.article_code AS a, x.dd, sum(CASE WHEN x.doc_type = '10042' THEN x.q ELSE -x.q END) AS q FROM x GROUP BY 1, 2
  ), nc AS (
    SELECT CASE WHEN count(*) = 0 THEN 0 WHEN bool_or(c.cost_mkd IS NULL AND net.q <> 0) THEN NULL ELSE round(sum(net.q * coalesce(c.cost_mkd, 0)), 2) END AS cost
      FROM net LEFT JOIN public.shops_unit_costs((SELECT coalesce(jsonb_agg(jsonb_build_object('a', net.a, 'd', net.dd)), '[]'::jsonb) FROM net)) c
        ON c.article_code = net.a AND c.day = net.dd
  ), t AS (
    SELECT coalesce(sum(x.q) FILTER (WHERE x.doc_type = '10042'), 0) AS delivered,
           coalesce(sum(x.q) FILTER (WHERE x.doc_type = '10044'), 0) AS returned,
           round(coalesce(sum(x.v) FILTER (WHERE x.doc_type = '10042'), 0) - coalesce(sum(x.v) FILTER (WHERE x.doc_type = '10044'), 0), 2) AS v
      FROM x
  )
  SELECT jsonb_build_object('basis', 'collabbox', 'units_delivered', t.delivered, 'units_returned', t.returned,
                            'invoiced_ex_vat_mkd', t.v, 'natura_cost_mkd', nc.cost,
                            'natura_margin_mkd', CASE WHEN nc.cost IS NOT NULL THEN round(t.v - nc.cost, 2) END,
                            'ads_reinvoiced_ex_vat_mkd', NULL)
    INTO v_out FROM t, nc;
  RETURN v_out;
END
$fn$;

-- ── 5. ShopsPeriod ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.shops_period(p_from date, p_to date, p_money boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_today date := (now() AT TIME ZONE 'Europe/Skopje')::date;
  v_d1 date := least(coalesce(p_to, v_today), v_today);
  v_d0 date := least(coalesce(p_from, v_d1), v_d1);
  v_days int := v_d1 - v_d0 + 1;
  v_from timestamptz := v_d0::timestamp AT TIME ZONE 'Europe/Skopje';
  v_to timestamptz := CASE WHEN v_d1 = v_today THEN now() ELSE (v_d1 + 1)::timestamp AT TIME ZONE 'Europe/Skopje' END;
  v_pfrom timestamptz := (v_d0 - v_days)::timestamp AT TIME ZONE 'Europe/Skopje';
  v_rt jsonb; v_daily jsonb; v_out jsonb;
BEGIN
  IF v_days > 731 THEN RAISE EXCEPTION 'shops_period: at most 731 days'; END IF;
  -- the previous equal period, cut at the same elapsed time when this one is live
  v_rt := public.shops_rows_json(v_from, v_to,
            jsonb_build_array(jsonb_build_object('from', v_pfrom, 'to', least(v_pfrom + (v_to - v_from), v_from))), false, p_money, NULL);
  WITH f AS (SELECT * FROM public.shops_line_facts(v_from, v_to, NULL)),
  g AS (SELECT gc.day AS d, CASE WHEN bool_or(gc.unit_cost IS NULL AND gc.units <> 0) THEN NULL ELSE round(sum(gc.units * coalesce(gc.unit_cost, 0)), 2) END AS cost
          FROM public.shops_group_costs(v_from, v_to, NULL) gc GROUP BY gc.day),
  c AS (SELECT c.day AS d, sum(c.cash_mkd) AS cash, sum(c.card_mkd) AS card, count(c.cash_mkd) AS n FROM public.shop_day_controls c
         WHERE c.day BETWEEN v_d0 AND v_d1 GROUP BY c.day),
  dd AS (
    SELECT f.day AS d, count(DISTINCT f.doc_number) FILTER (WHERE f.doc_type = '10022') AS receipts,
           coalesce(sum(f.units) FILTER (WHERE NOT f.is_return), 0) AS units, coalesce(sum(f.sale), 0) AS sales,
           coalesce(sum(f.sale_ex_vat), 0) AS sales_ex, coalesce(sum(f.cost_ex_vat), 0) AS cost_ex,
           coalesce(-sum(f.sale) FILTER (WHERE f.is_return), 0) AS returns,
           count(DISTINCT f.shop_code) FILTER (WHERE f.doc_type = '10022') AS shops
      FROM f GROUP BY f.day
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'day', d.day, 'receipts', coalesce(dd.receipts, 0), 'units', coalesce(dd.units, 0),
           'sales_mkd', round(coalesce(dd.sales, 0), 2), 'sales_ex_vat_mkd', round(coalesce(dd.sales_ex, 0), 2),
           'cash_mkd', CASE WHEN coalesce(dd.shops, 0) = 0 THEN 0 WHEN c.n >= dd.shops THEN c.cash END,
           'card_mkd', CASE WHEN coalesce(dd.shops, 0) = 0 THEN 0 WHEN c.n >= dd.shops THEN c.card END,
           'avg_receipt_mkd', CASE WHEN dd.receipts > 0 THEN round(dd.sales / dd.receipts, 2) END,
           'cost_mkd', round(coalesce(dd.cost_ex, 0), 2), 'shop_margin_mkd', round(coalesce(dd.sales_ex - dd.cost_ex, 0), 2),
           'group_cost_mkd', CASE WHEN dd.d IS NULL THEN 0 ELSE g.cost END,
           'group_margin_mkd', CASE WHEN dd.d IS NULL THEN 0 WHEN g.cost IS NOT NULL THEN round(dd.sales_ex - g.cost, 2) END,
           'returns_mkd', round(coalesce(dd.returns, 0), 2)) ORDER BY d.day), '[]'::jsonb)
    INTO v_daily
    FROM (SELECT generate_series(v_d0, v_d1, interval '1 day')::date AS day) d
    LEFT JOIN dd ON dd.d = d.day LEFT JOIN g ON g.d = d.day LEFT JOIN c ON c.d = d.day;
  v_out := jsonb_build_object('from', v_d0, 'to', v_d1, 'shops', v_rt->'rows', 'totals', v_rt->'totals', 'daily', v_daily,
                              'natura', public.shops_natura_json(v_d0, v_d1), 'freshness', public.shops_freshness());
  RETURN CASE WHEN p_money THEN v_out ELSE public.shops_strip_money(v_out) END;
END
$fn$;

-- ── 6. ShopDetail ───────────────────────────────────────────────────────────
-- Stock rows of shops at a moment with the 30-day sales, cover and the chain's top sellers (ShopStockRow).
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

-- Brands of articles: Stock v2's stock_articles.brand when that table exists, else NULL (the caller falls back to
-- the collabBox article group).
CREATE OR REPLACE FUNCTION public.shops_brands(p_codes text[])
RETURNS TABLE (article_code text, brand text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF to_regclass('public.stock_articles') IS NULL THEN
    RETURN QUERY SELECT c, NULL::text FROM unnest(coalesce(p_codes, ARRAY[]::text[])) c;
    RETURN;
  END IF;
  RETURN QUERY EXECUTE 'SELECT c, nullif(btrim(sa.brand), '''') FROM unnest($1) c LEFT JOIN public.stock_articles sa ON sa.code = c'
    USING coalesce(p_codes, ARRAY[]::text[]);
END
$fn$;

-- The goods documents of one shop in a window: (at, type, doc, natura_doc, units for the shop, value ex VAT).
CREATE OR REPLACE FUNCTION public.shops_shop_docs(p_shop text, p_from timestamptz, p_to timestamptz)
RETURNS TABLE (doc_at timestamptz, doc_type text, doc_number text, natura_doc text, units numeric, value_mkd numeric, counted numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
  SELECT d.doc_at, d.doc_type, d.doc_number, d.natura_doc,
         coalesce(sum(public.shops_doc_delta(l.doc_type, p_shop, l.wh_in, l.wh_out, l.qty_in, l.qty_out,
                                             coalesce(l.sale_value_mkd, l.cost_value_mkd), l.is_correction)) FILTER (WHERE NOT l.is_point), 0),
         round(coalesce(sum(sign(public.shops_doc_delta(l.doc_type, p_shop, l.wh_in, l.wh_out, l.qty_in, l.qty_out,
                                                        coalesce(l.sale_value_mkd, l.cost_value_mkd), l.is_correction))
                            * abs(coalesce(l.cost_value_mkd, 0)) / (1 + coalesce(l.vat_rate, a.vat_rate, 0.05))) FILTER (WHERE NOT l.is_point), 0), 2),
         coalesce(sum(greatest(abs(l.qty_in), abs(l.qty_out))) FILTER (WHERE d.doc_type = '10011' AND NOT l.is_point), 0)
    FROM public.shop_docs d
    JOIN public.shop_doc_lines l ON l.doc_number = d.doc_number AND NOT l.is_correction
    LEFT JOIN public.shop_articles a ON a.article_code = l.article_code
   WHERE d.vanished_at IS NULL AND d.doc_at >= p_from AND d.doc_at < p_to
     AND (l.wh_in = p_shop OR l.wh_out = p_shop OR (d.doc_type = '10011' AND d.wh_code = p_shop))
   GROUP BY d.doc_at, d.doc_type, d.doc_number, d.natura_doc
$fn$;

CREATE OR REPLACE FUNCTION public.shop_detail(p_code text, p_from date DEFAULT NULL, p_to date DEFAULT NULL,
                                              p_at timestamptz DEFAULT NULL, p_money boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_today date := (now() AT TIME ZONE 'Europe/Skopje')::date;
  v_d1 date := least(coalesce(p_to, v_today), v_today);
  v_d0 date := least(coalesce(p_from, v_d1), v_d1);
  v_days int := v_d1 - v_d0 + 1;
  v_from timestamptz := v_d0::timestamp AT TIME ZONE 'Europe/Skopje';
  v_to timestamptz := CASE WHEN v_d1 = v_today THEN now() ELSE (v_d1 + 1)::timestamp AT TIME ZONE 'Europe/Skopje' END;
  v_pfrom timestamptz := (v_d0 - v_days)::timestamp AT TIME ZONE 'Europe/Skopje';
  v_at timestamptz := least(coalesce(p_at, now()), now());
  v_rt jsonb; v_arts jsonb; v_stock jsonb; v_tot jsonb; v_in jsonb; v_out_docs jsonb; v_counts jsonb; v_basis text;
  v_taken timestamptz; v_moves bigint; v_out jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.shops WHERE code = p_code) THEN RETURN NULL; END IF;
  IF v_days > 731 THEN RAISE EXCEPTION 'shop_detail: at most 731 days'; END IF;
  v_rt := public.shops_rows_json(v_from, v_to,
            jsonb_build_array(jsonb_build_object('from', v_pfrom, 'to', least(v_pfrom + (v_to - v_from), v_from))), false, p_money, ARRAY[p_code]);

  WITH f AS (SELECT * FROM public.shops_line_facts(v_from, v_to, ARRAY[p_code]) WHERE NOT is_point),
  g AS (SELECT gc.article_code AS a, CASE WHEN bool_or(gc.unit_cost IS NULL AND gc.units <> 0) THEN NULL ELSE sum(gc.units * coalesce(gc.unit_cost, 0)) END AS cost
          FROM public.shops_group_costs(v_from, v_to, ARRAY[p_code]) gc GROUP BY gc.article_code),
  a AS (SELECT f.article_code AS a, max(f.article_name) AS name, sum(f.units) AS units, sum(f.sale) AS sales,
               sum(f.sale_ex_vat) AS sales_ex, sum(f.cost_ex_vat) AS cost_ex FROM f GROUP BY f.article_code)
  SELECT coalesce(jsonb_agg(jsonb_build_object('code', a.a, 'name', a.name, 'units', a.units, 'sales_mkd', round(a.sales, 2),
           'shop_margin_mkd', round(a.sales_ex - a.cost_ex, 2),
           'group_margin_mkd', CASE WHEN g.cost IS NOT NULL THEN round(a.sales_ex - g.cost, 2) END) ORDER BY a.units DESC, a.sales DESC), '[]'::jsonb)
    INTO v_arts FROM a LEFT JOIN g ON g.a = a.a;

  WITH s AS (SELECT * FROM public.shops_stock_rows(v_at, ARRAY[p_code]))
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'code', s.article_code, 'name', s.name, 'brand', s.brand, 'qty', s.qty, 'reserved', s.reserved,
           'available', s.qty - s.reserved, 'sold_30d', s.sold_30d,
           'days_cover', CASE WHEN s.sold_30d > 0 THEN round(greatest(s.qty, 0) / (s.sold_30d / 30.0), 1) END,
           'last_sold_at', s.last_sold_at, 'zero_top_seller', s.zero_top_seller,
           'avg_cost_mkd', s.avg_cost_mkd, 'retail_price_mkd', s.retail_price_mkd,
           'value_cost_mkd', CASE WHEN s.avg_cost_mkd IS NOT NULL THEN round(s.qty * s.avg_cost_mkd, 2) END,
           'value_retail_mkd', CASE WHEN s.retail_price_mkd IS NOT NULL THEN round(s.qty * s.retail_price_mkd, 2) END)
           ORDER BY s.zero_top_seller DESC, s.sold_30d DESC, s.qty DESC, s.article_code)
           FILTER (WHERE s.qty <> 0 OR s.sold_30d <> 0 OR s.zero_top_seller), '[]'::jsonb),
         jsonb_build_object('articles', count(*) FILTER (WHERE s.qty > 0), 'units', coalesce(sum(s.qty) FILTER (WHERE s.qty > 0), 0),
           'value_cost_mkd', CASE WHEN bool_or(s.qty > 0 AND s.avg_cost_mkd IS NULL) THEN NULL
                                  ELSE round(coalesce(sum(s.qty * s.avg_cost_mkd) FILTER (WHERE s.qty > 0), 0), 2) END,
           'value_retail_mkd', CASE WHEN bool_or(s.qty > 0 AND s.retail_price_mkd IS NULL) THEN NULL
                                    ELSE round(coalesce(sum(s.qty * s.retail_price_mkd) FILTER (WHERE s.qty > 0), 0), 2) END),
         max(s.taken_at), coalesce(sum(s.moves), 0)
    INTO v_stock, v_tot, v_taken, v_moves FROM s;
  SELECT max(t.taken_at) INTO v_taken FROM public.shop_stock_takes t WHERE t.shop_code = p_code AND t.taken_at <= v_at;
  v_basis := CASE WHEN v_taken IS NULL THEN 'no snapshot before ' || to_char(v_at AT TIME ZONE 'Europe/Skopje', 'DD.MM.YYYY HH24:MI')
                  ELSE 'snapshot ' || to_char(v_taken AT TIME ZONE 'Europe/Skopje', 'DD.MM HH24:MI') || ' + ' || v_moves || ' movements' END;

  WITH d AS (SELECT * FROM public.shops_shop_docs(p_code, v_from, v_to))
  SELECT coalesce(jsonb_agg(jsonb_build_object('at', d.doc_at, 'type', d.doc_type, 'type_name', public.shops_type_name(d.doc_type),
           'doc', d.doc_number, 'natura_doc', d.natura_doc, 'units', d.units, 'value_mkd', d.value_mkd) ORDER BY d.doc_at DESC)
           FILTER (WHERE d.doc_type NOT IN ('10011', '10005') AND d.units > 0), '[]'::jsonb),
         coalesce(jsonb_agg(jsonb_build_object('at', d.doc_at, 'type', d.doc_type, 'type_name', public.shops_type_name(d.doc_type),
           'doc', d.doc_number, 'natura_doc', d.natura_doc, 'units', d.units, 'value_mkd', d.value_mkd) ORDER BY d.doc_at DESC)
           FILTER (WHERE d.doc_type NOT IN ('10011', '10005') AND d.units < 0), '[]'::jsonb),
         coalesce(jsonb_agg(jsonb_build_object('at', d.doc_at, 'type', d.doc_type, 'type_name', public.shops_type_name(d.doc_type),
           'doc', d.doc_number, 'natura_doc', d.natura_doc, 'units', CASE WHEN d.doc_type = '10011' THEN d.counted ELSE d.units END,
           'value_mkd', d.value_mkd) ORDER BY d.doc_at DESC)
           FILTER (WHERE d.doc_type IN ('10011', '10005')), '[]'::jsonb)
    INTO v_in, v_out_docs, v_counts FROM d;

  v_out := jsonb_build_object('shop', public.shops_ref_json(p_code), 'from', v_d0, 'to', v_d1,
             'summary', v_rt->'rows'->0, 'sales_by_article', v_arts, 'stock_at', v_at, 'stock_basis', v_basis,
             'stock_basis_at', v_taken, 'stock_movements', CASE WHEN v_taken IS NULL THEN 0 ELSE v_moves END,
             'stock', v_stock, 'stock_totals', v_tot, 'goods_in', v_in, 'goods_out', v_out_docs, 'counts', v_counts,
             'freshness', public.shops_freshness());
  RETURN CASE WHEN p_money THEN v_out ELSE public.shops_strip_money(v_out) END;
END
$fn$;

-- ── 7. ShopsStockMatrix ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.shops_stock_matrix(p_at timestamptz DEFAULT NULL, p_q text DEFAULT NULL, p_brand text DEFAULT NULL,
                                                     p_money boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_at timestamptz := least(coalesce(p_at, now()), now());
  v_shops text[]; v_out jsonb;
  v_q text := nullif(btrim(coalesce(p_q, '')), '');
  v_b text := nullif(btrim(coalesce(p_brand, '')), '');
BEGIN
  SELECT array_agg(s.code ORDER BY s.sort) INTO v_shops FROM public.shops s WHERE s.active;
  WITH r AS (SELECT * FROM public.shops_stock_rows(v_at, v_shops)),
  a AS (
    SELECT r.article_code AS code, max(r.name) AS name, max(r.brand) AS brand, sum(r.qty) AS total, sum(r.sold_30d) AS sold,
           jsonb_object_agg(r.shop_code, r.qty) FILTER (WHERE r.qty <> 0) AS by_shop
      FROM r GROUP BY r.article_code
  )
  SELECT jsonb_build_object(
           'at', v_at, 'freshness', public.shops_freshness(),
           'shops', (SELECT coalesce(jsonb_agg(public.shops_ref_json(c) ORDER BY o), '[]'::jsonb) FROM unnest(v_shops) WITH ORDINALITY u(c, o)),
           'articles', coalesce(jsonb_agg(jsonb_build_object('code', a.code, 'name', a.name, 'brand', a.brand, 'total', a.total,
                                  'sold_30d_total', a.sold, 'by_shop', coalesce(a.by_shop, '{}'::jsonb)) ORDER BY a.sold DESC, a.total DESC, a.code)
                                FILTER (WHERE (a.total <> 0 OR a.sold <> 0)
                                          AND (v_q IS NULL OR a.code ILIKE '%' || v_q || '%' OR a.name ILIKE '%' || v_q || '%')
                                          AND (v_b IS NULL OR a.brand ILIKE '%' || v_b || '%')), '[]'::jsonb))
    INTO v_out FROM a;
  RETURN CASE WHEN p_money THEN v_out ELSE public.shops_strip_money(v_out) END;
END
$fn$;

-- ── 8. ShopsDeliveries ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.shops_deliveries(p_from date DEFAULT NULL, p_to date DEFAULT NULL, p_shop text DEFAULT NULL,
                                                   p_money boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_today date := (now() AT TIME ZONE 'Europe/Skopje')::date;
  v_d1 date := least(coalesce(p_to, v_today), v_today);
  v_d0 date := least(coalesce(p_from, v_d1 - 29), v_d1);
  v_sigma boolean := false; v_rows jsonb; v_out jsonb;
BEGIN
  IF v_d1 - v_d0 > 731 THEN RAISE EXCEPTION 'shops_deliveries: at most 731 days'; END IF;
  IF to_regclass('public.stock_sigma_docs') IS NOT NULL THEN
    SELECT EXISTS (SELECT 1 FROM public.stock_sigma_docs d WHERE d.client_code = '000001' AND d.vanished_at IS NULL) INTO v_sigma;
  END IF;
  IF v_sigma THEN
    WITH inv AS (
      SELECT d.doc_key, d.doc_no, d.doc_date, s.code AS shop,
             (SELECT coalesce(sum(l.qty), 0) FROM jsonb_to_recordset(d.lines) AS l(item_code text, qty numeric, side text) WHERE l.side = 'out') AS units
        FROM public.stock_sigma_docs d
        LEFT JOIN public.shops s ON ltrim(s.sigma_object, '0') = ltrim(substring(coalesce(d.object_to, '') FROM '(\d+)$'), '0')
       WHERE d.client_code = '000001' AND d.vanished_at IS NULL AND d.excluded_reason IS NULL
         AND d.doc_type IN ('ПМ1', 'ПМ2', 'ПМ9') AND d.doc_date BETWEEN v_d0 AND v_d1
         AND (p_shop IS NULL OR s.code = p_shop)
    ), m AS (
      SELECT inv.*, rc.doc_number AS received_doc, rc.doc_at AS received_at, rc.v AS val
        FROM inv
        LEFT JOIN LATERAL (
          SELECT sd.doc_number, sd.doc_at,
                 (SELECT round(sum(coalesce(dl.cost_value_mkd, 0) / (1 + coalesce(dl.vat_rate, a.vat_rate, 0.05))), 2)
                    FROM public.shop_doc_lines dl LEFT JOIN public.shop_articles a ON a.article_code = dl.article_code
                   WHERE dl.doc_number = sd.doc_number AND NOT dl.is_correction) AS v
            FROM public.shop_docs sd
           WHERE sd.doc_type = '10042' AND sd.vanished_at IS NULL AND sd.natura_doc_key IS NOT NULL
             AND regexp_replace(sd.natura_doc_key, '^\d+-', '') = regexp_replace(public.shops_natura_doc_key(inv.doc_no), '^\d+-', '')
             AND sd.doc_at >= (inv.doc_date - 10)::timestamp AT TIME ZONE 'Europe/Skopje'
             AND sd.doc_at <  (inv.doc_date + 60)::timestamp AT TIME ZONE 'Europe/Skopje'
           ORDER BY abs(extract(epoch FROM sd.doc_at - (inv.doc_date::timestamp AT TIME ZONE 'Europe/Skopje')))
           LIMIT 1) rc ON true
    )
    SELECT coalesce(jsonb_agg(jsonb_build_object(
             'day', m.doc_date, 'shop', public.shops_ref_json(m.shop), 'sigma_doc', m.doc_no, 'units', m.units,
             'value_ex_vat_mkd', m.val, 'received_doc', m.received_doc, 'received_at', m.received_at,
             'in_transit', m.received_doc IS NULL,
             'lag_days', CASE WHEN m.received_at IS NOT NULL THEN (m.received_at AT TIME ZONE 'Europe/Skopje')::date - m.doc_date END)
             ORDER BY m.doc_date DESC, m.doc_no), '[]'::jsonb),
           jsonb_build_object('invoices', count(*), 'units', coalesce(sum(m.units), 0), 'in_transit', count(*) FILTER (WHERE m.received_doc IS NULL),
                              'valued', count(m.val),
                              'value_ex_vat_mkd', CASE WHEN bool_or(m.val IS NULL) THEN NULL ELSE round(coalesce(sum(m.val), 0), 2) END)
      INTO v_rows, v_out FROM m;
    v_out := jsonb_build_object('from', v_d0, 'to', v_d1, 'basis', 'sigma', 'rows', v_rows, 'totals', v_out);
  ELSE
    -- no Sigma staging: the 10042 receipts in 001 Централен; the shop = the 10014 into a shop of the same
    -- minutes with the same cost (every delivery is mirrored that way — owner investigation 02.10.2026)
    WITH r AS (
      SELECT sd.doc_number, sd.doc_at, sd.natura_doc,
             (SELECT coalesce(sum(dl.qty_in - dl.qty_out), 0) FROM public.shop_doc_lines dl WHERE dl.doc_number = sd.doc_number AND NOT dl.is_point AND NOT dl.is_correction) AS units,
             (SELECT coalesce(sum(dl.cost_value_mkd), 0) FROM public.shop_doc_lines dl WHERE dl.doc_number = sd.doc_number AND NOT dl.is_correction) AS cost,
             (SELECT round(sum(coalesce(dl.cost_value_mkd, 0) / (1 + coalesce(dl.vat_rate, a.vat_rate, 0.05))), 2)
                FROM public.shop_doc_lines dl LEFT JOIN public.shop_articles a ON a.article_code = dl.article_code
               WHERE dl.doc_number = sd.doc_number AND NOT dl.is_correction) AS v
        FROM public.shop_docs sd
       WHERE sd.doc_type = '10042' AND sd.vanished_at IS NULL
         AND sd.doc_at >= v_d0::timestamp AT TIME ZONE 'Europe/Skopje' AND sd.doc_at < (v_d1 + 1)::timestamp AT TIME ZONE 'Europe/Skopje'
    ), m AS (
      SELECT r.*, (
        SELECT x.wh_code FROM (
          SELECT t.doc_number, t.wh_code, t.doc_at,
                 (SELECT coalesce(sum(dl.cost_value_mkd), 0) FROM public.shop_doc_lines dl WHERE dl.doc_number = t.doc_number AND NOT dl.is_correction) AS cost
            FROM public.shop_docs t
           WHERE t.doc_type = '10014' AND t.vanished_at IS NULL AND t.wh_code IN (SELECT code FROM public.shops)
             AND t.doc_at BETWEEN r.doc_at - interval '20 minutes' AND r.doc_at + interval '1 day') x
         WHERE abs(x.cost - r.cost) <= 1
         ORDER BY abs(extract(epoch FROM x.doc_at - r.doc_at)) LIMIT 1) AS shop
        FROM r
    )
    SELECT coalesce(jsonb_agg(jsonb_build_object(
             'day', (m.doc_at AT TIME ZONE 'Europe/Skopje')::date, 'shop', public.shops_ref_json(m.shop), 'sigma_doc', m.natura_doc,
             'units', m.units, 'value_ex_vat_mkd', m.v, 'received_doc', m.doc_number, 'received_at', m.doc_at,
             'in_transit', false, 'lag_days', NULL) ORDER BY m.doc_at DESC)
             FILTER (WHERE p_shop IS NULL OR m.shop = p_shop), '[]'::jsonb),
           jsonb_build_object('invoices', count(*) FILTER (WHERE p_shop IS NULL OR m.shop = p_shop),
                              'units', coalesce(sum(m.units) FILTER (WHERE p_shop IS NULL OR m.shop = p_shop), 0), 'in_transit', 0,
                              'valued', count(m.v) FILTER (WHERE p_shop IS NULL OR m.shop = p_shop),
                              'value_ex_vat_mkd', CASE WHEN bool_or(m.v IS NULL) FILTER (WHERE p_shop IS NULL OR m.shop = p_shop) THEN NULL
                                                       ELSE round(coalesce(sum(m.v) FILTER (WHERE p_shop IS NULL OR m.shop = p_shop), 0), 2) END)
      INTO v_rows, v_out FROM m;
    v_out := jsonb_build_object('from', v_d0, 'to', v_d1, 'basis', 'collabbox', 'rows', v_rows, 'totals', v_out);
  END IF;
  RETURN CASE WHEN p_money THEN v_out ELSE public.shops_strip_money(v_out) END;
END
$fn$;

-- ── 9. ShopsHealth ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.shops_health(p_money boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_now timestamptz := now();
  v_today date := (now() AT TIME ZONE 'Europe/Skopje')::date;
  v_set jsonb; v_reader jsonb; v_backfill jsonb; v_controls jsonb; v_anom jsonb := '[]'::jsonb; v_out jsonb;
  v_sales_from date; v_done date; v_sigma boolean := false;
BEGIN
  SELECT s.value INTO v_set FROM public.app_settings s WHERE s.key = 'shops_reader';
  SELECT jsonb_build_object(
           'enabled', coalesce((v_set->>'enabled')::boolean, false),
           'last_run_at', (SELECT max(coalesce(r.finished_at, r.started_at)) FROM public.shops_reader_runs r),
           'last_status', (SELECT r.status FROM public.shops_reader_runs r ORDER BY r.started_at DESC LIMIT 1),
           'runs_24h', (SELECT count(*) FROM public.shops_reader_runs r WHERE r.started_at > v_now - interval '24 hours'),
           'errors_24h', (SELECT count(*) FROM public.shops_reader_runs r WHERE r.started_at > v_now - interval '24 hours' AND r.status = 'failed'))
    INTO v_reader;

  v_sales_from := coalesce(nullif(v_set->'backfill'->>'sales_from', '')::date,
                           (SELECT min(l.sold_at AT TIME ZONE 'Europe/Skopje')::date FROM public.shop_sales_lines l));
  -- the last day of the unbroken run of read days from sales_from (backfill log, or a day the live reader closed)
  SELECT max(d) INTO v_done FROM (
    SELECT g.d, count(*) OVER (ORDER BY g.d) AS n, (g.d - v_sales_from + 1) AS want
      FROM (SELECT b.key::date AS d FROM public.shops_backfill_log b WHERE b.kind IN ('sales_day', 'close_day') AND b.ok
             AND b.key ~ '^\d{4}-\d{2}-\d{2}$' AND b.key::date >= v_sales_from GROUP BY b.key) g
  ) x WHERE x.n = x.want;
  v_backfill := jsonb_build_object('sales_from', v_sales_from, 'sales_done_until', v_done,
                  'stock_history_months', (SELECT count(DISTINCT date_trunc('month', p.period_from)) FROM public.shop_stock_periods p));

  SELECT jsonb_build_object('days_checked', count(DISTINCT c.day) FILTER (WHERE c.ok IS NOT NULL),
                            'mismatches', count(*) FILTER (WHERE c.ok = false))
    INTO v_controls FROM public.shop_day_controls c WHERE c.day > v_today - 30;

  IF to_regclass('public.stock_sigma_docs') IS NOT NULL THEN
    SELECT EXISTS (SELECT 1 FROM public.stock_sigma_docs d WHERE d.client_code = '000001' AND d.vanished_at IS NULL) INTO v_sigma;
  END IF;

  WITH act AS (   -- shops that sell: receipts on ≥ 3 of the 7 days before
    SELECT l.shop_code AS s FROM public.shop_sales_lines l
     WHERE l.doc_type = '10022' AND l.sold_at >= (v_today - 7)::timestamp AT TIME ZONE 'Europe/Skopje' AND l.sold_at < v_today::timestamp AT TIME ZONE 'Europe/Skopje'
     GROUP BY l.shop_code HAVING count(DISTINCT (l.sold_at AT TIME ZONE 'Europe/Skopje')::date) >= 3
  ), days AS (
    SELECT d::date AS d FROM generate_series(v_today - 1, v_today, interval '1 day') d
     WHERE d::date < v_today OR (now() AT TIME ZONE 'Europe/Skopje')::time >= time '11:00'
  ), first_rc AS (
    SELECT days.d, a.s,
           (SELECT min(l.sold_at) FROM public.shop_sales_lines l WHERE l.shop_code = a.s AND l.doc_type = '10022'
              AND l.sold_at >= days.d::timestamp AT TIME ZONE 'Europe/Skopje' AND l.sold_at < (days.d + 1)::timestamp AT TIME ZONE 'Europe/Skopje') AS first_at,
           (SELECT count(*) FROM public.shop_sales_lines l WHERE l.doc_type = '10022'
              AND l.sold_at >= days.d::timestamp AT TIME ZONE 'Europe/Skopje' AND l.sold_at < (days.d + 1)::timestamp AT TIME ZONE 'Europe/Skopje') AS chain
      FROM days CROSS JOIN act a
  ), a1 AS (
    SELECT 'no_receipts_by_11' AS kind, f.s AS shop, f.d AS day,
           CASE WHEN f.first_at IS NULL THEN 'Нема сметка до 11:00'
                ELSE 'Првата сметка во ' || to_char(f.first_at AT TIME ZONE 'Europe/Skopje', 'HH24:MI') END AS detail,
           jsonb_build_object('first_receipt', to_char(f.first_at AT TIME ZONE 'Europe/Skopje', 'HH24:MI')) AS params,
           NULL::numeric AS v
      FROM first_rc f
     WHERE f.chain >= 5 AND (f.first_at IS NULL OR (f.first_at AT TIME ZONE 'Europe/Skopje')::time > time '11:00')
  ), a2 AS (   -- the booked cost above the sales (incl. VAT) — usually a bundle assembled in the shop
    SELECT 'cost_above_sales', l.shop_code, (l.sold_at AT TIME ZONE 'Europe/Skopje')::date,
           'Набавната вредност е поголема од продажбата',
           jsonb_build_object('cost_mkd', round(sum(coalesce(l.cost_value_mkd, 0)), 2), 'sales_mkd', round(sum(coalesce(l.sale_value_mkd, 0)), 2),
                              'receipts', count(DISTINCT l.doc_number)),
           round(sum(coalesce(l.cost_value_mkd, 0)) - sum(coalesce(l.sale_value_mkd, 0)), 2)
      FROM public.shop_sales_lines l
     WHERE l.doc_type = '10022' AND NOT l.is_point AND l.sold_at >= (v_today - 7)::timestamp AT TIME ZONE 'Europe/Skopje'
     GROUP BY l.shop_code, 3
    HAVING sum(coalesce(l.cost_value_mkd, 0)) > sum(coalesce(l.sale_value_mkd, 0)) AND sum(coalesce(l.sale_value_mkd, 0)) > 0
  ), a3 AS (   -- trade-book corrections after a count (never goods)
    SELECT 'book_correction', coalesce(l.wh_in, d.wh_code), (l.doc_at AT TIME ZONE 'Europe/Skopje')::date,
           'Корекција на трговската книга (не е стока): ' || d.doc_number,
           jsonb_build_object('doc', d.doc_number, 'article', l.article_name,
                              'units', greatest(abs(l.qty_in), abs(l.qty_out)), 'price_mkd', l.sale_value_mkd),
           l.sale_value_mkd
      FROM public.shop_doc_lines l JOIN public.shop_docs d ON d.doc_number = l.doc_number AND d.vanished_at IS NULL
     WHERE l.is_correction AND l.doc_at >= (v_today - 30)::timestamp AT TIME ZONE 'Europe/Skopje'
  ), a4 AS (   -- big goods movements per document (corrections and vouchers excluded)
    SELECT 'big_transfer', coalesce(min(sh.code), min(d.wh_code)),
           (d.doc_at AT TIME ZONE 'Europe/Skopje')::date,
           d.doc_number || ' · ' || public.shops_type_name(d.doc_type) || ': ' || round(sum(l.qty_in)) || ' парчиња',
           jsonb_build_object('doc', d.doc_number, 'type', d.doc_type, 'units', round(sum(l.qty_in), 3)),
           round(sum(coalesce(l.cost_value_mkd, 0)), 2)
      FROM public.shop_docs d JOIN public.shop_doc_lines l ON l.doc_number = d.doc_number AND NOT l.is_correction AND NOT l.is_point
      LEFT JOIN public.shops sh ON sh.code = l.wh_in
     WHERE d.vanished_at IS NULL AND d.doc_type IN ('10014', '10015', '10061') AND d.doc_at >= (v_today - 7)::timestamp AT TIME ZONE 'Europe/Skopje'
     GROUP BY d.doc_number, d.doc_type, d.doc_at
    HAVING abs(sum(coalesce(l.cost_value_mkd, 0))) >= 100000 OR abs(sum(l.qty_in)) >= 300
  ), a5 AS (   -- retail returns per shop and day
    SELECT 'big_return', l.shop_code, (l.sold_at AT TIME ZONE 'Europe/Skopje')::date,
           round(sum(l.qty)) || ' парчиња вратени во продавницата (10010)',
           jsonb_build_object('units', round(sum(l.qty), 3), 'value_mkd', round(sum(coalesce(l.sale_value_mkd, 0)), 2)),
           round(sum(coalesce(l.sale_value_mkd, 0)), 2)
      FROM public.shop_sales_lines l
     WHERE l.is_return AND NOT l.is_point AND l.sold_at >= (v_today - 7)::timestamp AT TIME ZONE 'Europe/Skopje'
     GROUP BY l.shop_code, 3 HAVING sum(l.qty) >= 3 OR sum(coalesce(l.sale_value_mkd, 0)) >= 3000
  ), zt AS (
    SELECT r.shop_code AS s, count(*) AS n, string_agg(r.article_code, ', ' ORDER BY r.sold_30d DESC) AS codes
      FROM public.shops_stock_rows(v_now, (SELECT array_agg(code) FROM public.shops WHERE active)) r
     WHERE r.zero_top_seller AND r.taken_at IS NOT NULL
     GROUP BY r.shop_code
  ), a6 AS (
    SELECT 'zero_top_seller', zt.s, v_today, zt.n || ' од 20-те најпродавани артикли ги нема на залиха',
           jsonb_build_object('count', zt.n, 'articles', left(zt.codes, 200)), NULL::numeric FROM zt
  ), a7 AS (
    SELECT 'control_mismatch', c.shop_code, c.day, 'Сметките не се совпаѓаат со дневниот извештај',
           jsonb_build_object('receipts_mkd', c.receipts_total_mkd, 'report_mkd', c.report_total_mkd, 'trade_book_mkd', c.tk_total_mkd,
                              'receipts', c.receipts),
           c.diff_mkd
      FROM public.shop_day_controls c WHERE c.ok = false AND c.day > v_today - 7
  ), al AS (
    SELECT * FROM a1 UNION ALL SELECT * FROM a2 UNION ALL SELECT * FROM a3 UNION ALL SELECT * FROM a4
    UNION ALL SELECT * FROM a5 UNION ALL SELECT * FROM a6 UNION ALL SELECT * FROM a7
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('kind', al.kind, 'shop', public.shops_ref_json(al.shop), 'day', al.day,
                                               'detail', al.detail, 'params', al.params, 'value_mkd', al.v) ORDER BY al.day DESC, al.kind, al.shop), '[]'::jsonb)
    INTO v_anom FROM (SELECT * FROM al ORDER BY al.day DESC LIMIT 200) al;

  IF v_sigma THEN   -- invoiced by Natura (Sigma) > 3 days ago, not received in collabBox — only for days the
                    -- reader has goods documents for (before the first 10042 read nothing could have matched)
    v_anom := v_anom || coalesce((
      SELECT jsonb_agg(jsonb_build_object('kind', 'delivery_not_received', 'shop', x->'shop', 'day', x->>'day',
                                          'detail', 'Фактурата ' || (x->>'sigma_doc') || ' (' || regexp_replace(x->>'units', '\.0+$', '')
                                                    || ' парчиња) не е примена во collabBox',
                                          'params', jsonb_build_object('sigma_doc', x->>'sigma_doc', 'units', (x->>'units')::numeric),
                                          'value_mkd', NULL))
        FROM jsonb_array_elements(public.shops_deliveries(v_today - 30, v_today - 3, NULL, true)->'rows') x
       WHERE (x->>'in_transit')::boolean
         AND (x->>'day')::date >= (SELECT min(sd.doc_at AT TIME ZONE 'Europe/Skopje')::date FROM public.shop_docs sd
                                    WHERE sd.doc_type = '10042' AND sd.header_seen)), '[]'::jsonb);
  END IF;

  v_out := jsonb_build_object('reader', v_reader, 'backfill', v_backfill, 'controls', v_controls, 'anomalies', v_anom,
                              'freshness', public.shops_freshness());
  RETURN CASE WHEN p_money THEN v_out ELSE public.shops_strip_money(v_out) END;
END
$fn$;

-- the nightly averages on shop_articles (fallback values for the stock rows)
CREATE OR REPLACE FUNCTION public.shops_articles_refresh_averages()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
DECLARE v_n int;
BEGIN
  WITH last AS (
    SELECT DISTINCT ON (s.article_code) s.article_code, s.avg_cost_mkd, s.retail_price_mkd
      FROM public.shop_stock_snapshots s
     WHERE s.taken_at > now() - interval '45 days' AND s.avg_cost_mkd > 0
     ORDER BY s.article_code, s.taken_at DESC
  )
  UPDATE public.shop_articles a SET last_avg_cost_mkd = last.avg_cost_mkd, last_retail_mkd = last.retail_price_mkd
    FROM last WHERE last.article_code = a.article_code
     AND (a.last_avg_cost_mkd IS DISTINCT FROM last.avg_cost_mkd OR a.last_retail_mkd IS DISTINCT FROM last.retail_price_mkd);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$fn$;

-- ── 10. grants ──────────────────────────────────────────────────────────────
DO $grant$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.shops_type_name(text)', 'public.shops_ref_json(text)', 'public.shops_strip_money(jsonb)', 'public.shops_freshness()',
    'public.shops_unit_costs(jsonb)', 'public.shops_line_facts(timestamptz,timestamptz,text[])',
    'public.shops_group_costs(timestamptz,timestamptz,text[])', 'public.shops_agg(timestamptz,timestamptz,text[])',
    'public.shops_totals(timestamptz,timestamptz)', 'public.shops_rows_json(timestamptz,timestamptz,jsonb,boolean,boolean,text[])',
    'public.shops_stock_at(timestamptz,text[])', 'public.shops_day(date,boolean)', 'public.shops_natura_json(date,date)',
    'public.shops_period(date,date,boolean)', 'public.shops_stock_rows(timestamptz,text[])', 'public.shops_brands(text[])',
    'public.shops_shop_docs(text,timestamptz,timestamptz)', 'public.shop_detail(text,date,date,timestamptz,boolean)',
    'public.shops_stock_matrix(timestamptz,text,text,boolean)', 'public.shops_deliveries(date,date,text,boolean)',
    'public.shops_health(boolean)', 'public.shops_articles_refresh_averages()'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') AND f <> 'public.shops_articles_refresh_averages()' THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO supabase_read_only_user', f);
    END IF;
  END LOOP;
END
$grant$;

COMMENT ON FUNCTION public.shops_day(date, boolean) IS
  'GET /api/shops/day → ShopsDay (src/lib/shopsTypes.ts): per shop receipts, units, returns, first / last receipt, vs the same weekday of the 4 previous weeks, the control verdict, money (owners); totals, hourly, freshness. Live when the day is today. p_money false → every *_mkd key absent. Migration 20260946000200.';
COMMENT ON FUNCTION public.shops_period(date, date, boolean) IS
  'GET /api/shops/period → ShopsPeriod: the shops over a period (vs the previous equal period), totals, daily, and natura = what Natura invoiced the shops (Sigma staging, client 000001) or, until it holds documents, what Stores'' 001 received (collabBox 10042 / 10044) — natura.basis says which. Migration 20260946000200.';
COMMENT ON FUNCTION public.shop_detail(text, date, date, timestamptz, boolean) IS
  'GET /api/shops/:code → ShopDetail: summary, sales by article, stock at p_at (latest take ≤ p_at + the lines after it; stock_basis says which), goods in / out and counts. NULL for an unknown shop. Migration 20260946000200.';
COMMENT ON FUNCTION public.shops_stock_matrix(timestamptz, text, text, boolean) IS
  'GET /api/shops/stock-matrix → ShopsStockMatrix: per article the stock in every active shop at p_at, the total and the chain''s 30-day sales; q = code / name, brand = Stock v2 brand or collabBox group. Migration 20260946000200.';
COMMENT ON FUNCTION public.shops_deliveries(date, date, text, boolean) IS
  'GET /api/shops/deliveries → ShopsDeliveries: Natura''s Sigma invoices to client 000001 (by delivery object = shop) matched to the collabBox 10042 that received them by Natura''s number (re-dating tolerated: −10 … +60 days); in transit when none. Until Sigma staging holds documents (basis collabbox): the 10042 receipts, the shop taken from the mirroring 10014. Migration 20260946000200.';
COMMENT ON FUNCTION public.shops_health(boolean) IS
  'GET /api/shops/health → ShopsHealth: reader switch and runs, backfill progress, controls of 30 days, anomalies (no_receipts_by_11, cost_above_sales, book_correction, big_transfer, big_return, zero_top_seller, control_mismatch, delivery_not_received), freshness. Migration 20260946000200.';
COMMENT ON FUNCTION public.shops_stock_at(timestamptz, text[]) IS
  'Stock of the shops at a moment: per shop the latest shop_stock_takes ≤ p_at (its snapshot rows) + every receipt / return line and goods line (shops_doc_delta) after it up to p_at. A shop with no take before p_at has no rows. Migration 20260946000200.';

COMMIT;

NOTIFY pgrst, 'reload schema';
