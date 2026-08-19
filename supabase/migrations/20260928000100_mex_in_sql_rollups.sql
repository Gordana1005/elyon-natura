-- ============================================================================
-- MEX IN THE SQL INSIGHTS ENGINE (2026-08-19)
--
-- BUG, live since MEX became a courier (20260915000400): the SQL engine's
-- courier CASEs in insights_orders_rollup and insights_paid_basis were written
-- before MEX existed and only knew speedy/econt. Every MEX order resolved to
-- 'unknown' and was charged the blended fallback (3.50) instead of the MEX
-- rate (2.439), and the Logistics card showed one big 'unknown' bucket.
-- Measured on 2026-07-01..08-19: 90 delivered MEX orders overcharged by
-- 1.061 each = 95.49 EUR of phantom delivery cost in clear_profit — found
-- because the new channel P&L (20260928000000, MEX-aware from birth) refused
-- to tie to the blended figure.
--
-- The TS twin resolveCourierService() gained mex in 20260915000400; these two
-- CASEs are the SQL twins and now match it. Both functions are re-emitted in
-- full with ONLY the courier CASEs changed.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.insights_orders_rollup(p_from text, p_to_end text)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp SET TimeZone = 'UTC' SET work_mem = '64MB'
AS $$
WITH base AS (
  -- Exactly the legacy filter. Project only what is needed: `g` is referenced
  -- many times so Postgres materialises it, and SELECT * would spill ~60 wide
  -- columns × 75k rows to a temp file on a small instance.
  SELECT o.id, o.status::text AS status, o.price, o.quantity,
         o.customer_city, o.courier_office_city, o.delivery_type, o.home_courier,
         o.assigned_agent_name, o.confirmed_by_name, o.cancelled_by_agent_id,
         o.source_type, o.created_at, o.cancellation_reason, o.return_reason,
         o.prediction_list_id, o.prediction_list_name, o.prediction_list_type,
         o.prediction_list_category
  FROM public.orders o
  WHERE (o.source_type IS NULL OR o.source_type <> 'monadon_legacy')
    AND (nullif(p_from, '')   IS NULL OR o.created_at >= nullif(p_from, '')::timestamptz)
    AND (nullif(p_to_end, '') IS NULL OR o.created_at <= nullif(p_to_end, '')::timestamptz)
),
it AS (
  SELECT i.order_id,
         count(*)::int                    AS n_items,
         coalesce(sum(i.quantity), 0)::int AS q_sum,
         -- orderPackageBonus items branch: packageBonusRate(price_per_unit) * quantity
         coalesce(sum(
           (CASE WHEN coalesce(i.price_per_unit, 0) >= 35 THEN 3
                 WHEN coalesce(i.price_per_unit, 0) >  25 THEN 2
                 ELSE 1 END) * coalesce(i.quantity, 0)), 0)::int AS bonus_items
  FROM public.order_items i JOIN base b ON b.id = i.order_id
  GROUP BY i.order_id
),
g AS (
  SELECT b.*,
         coalesce(t.n_items, 0) AS n_items,
         -- unitsOf(): items.length ? Σqty : (num(quantity) || 1)
         CASE WHEN coalesce(t.n_items, 0) > 0 THEN coalesce(t.q_sum, 0)
              WHEN coalesce(b.quantity, 0) = 0 THEN 1 ELSE b.quantity END AS units,
         (b.status IN ('confirmed','shipped','delivered','paid','returned')) AS is_real,
         (b.status IN ('confirmed','shipped','delivered','paid'))            AS is_sold,
         (b.status = 'paid')                                                 AS is_paid,
         -- ownerOf() BEFORE normAgent. JS `??` skips null/undefined but NOT '',
         -- which is exactly what coalesce does.
         coalesce(b.confirmed_by_name, b.assigned_agent_name) AS owner_raw,
         -- (customer_city || courier_office_city || '').trim() || 'Unknown'
         -- JS `||` is falsy-based, so '' is skipped too — hence nullif.
         coalesce(nullif(btrim(coalesce(nullif(b.customer_city, ''),
                                        nullif(b.courier_office_city, ''), '')), ''),
                  'Unknown') AS city,
         -- resolveCourierService(): delivery_type wins over home_courier
         CASE WHEN b.delivery_type = 'speedy_office' THEN 'speedy'
              WHEN b.delivery_type = 'econt_office'  THEN 'econt'
              WHEN b.delivery_type = 'mex_office'    THEN 'mex'
              WHEN b.home_courier IN ('speedy','econt','mex') THEN b.home_courier END AS courier,
         CASE WHEN b.delivery_type IN ('speedy_office','econt_office','mex_office') THEN 'office'
              WHEN b.home_courier IN ('speedy','econt','mex') THEN 'door' END          AS service,
         -- orderPackageBonus(). Legacy branch divides then compares, exactly as
         -- the TS does, so float behaviour matches.
         CASE WHEN b.status <> 'paid' THEN 0
              WHEN coalesce(t.n_items, 0) > 0 THEN coalesce(t.bonus_items, 0)
              ELSE (CASE WHEN coalesce(b.price,0)::float8
                            / (CASE WHEN coalesce(b.quantity,0)=0 THEN 1 ELSE b.quantity END)::float8 >= 35 THEN 3
                         WHEN coalesce(b.price,0)::float8
                            / (CASE WHEN coalesce(b.quantity,0)=0 THEN 1 ELSE b.quantity END)::float8 >  25 THEN 2
                         ELSE 1 END)
                   * (CASE WHEN coalesce(b.quantity,0)=0 THEN 1 ELSE b.quantity END)
         END::int AS bonus
  FROM base b LEFT JOIN it t ON t.order_id = b.id
),
span AS (
  -- (maxMs - minMs) / 86400000, then Math.max(1, ...). floor(epoch*1000)
  -- reproduces V8 truncating microseconds to milliseconds.
  SELECT CASE WHEN count(*) = 0 THEN 1::float8
              ELSE greatest(1::float8,
                   ((floor(extract(epoch FROM max(created_at)) * 1000)
                   - floor(extract(epoch FROM min(created_at)) * 1000))::float8) / 86400000::float8)
         END AS span_days
  FROM g
),
gran AS (
  SELECT CASE WHEN span_days <= 92 THEN 'day'
              WHEN span_days <= 400 THEN 'week' ELSE 'month' END AS granularity FROM span
),
trend AS (
  -- UTC ISO slices; date_trunc('week') starts Monday, matching
  -- `getUTCDay() || 7; setUTCDate(d - day + 1)`.
  SELECT CASE (SELECT granularity FROM gran)
           WHEN 'day'   THEN to_char(g.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')
           WHEN 'month' THEN to_char(g.created_at AT TIME ZONE 'UTC', 'YYYY-MM')
           ELSE to_char(date_trunc('week', g.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD')
         END AS bucket,
         sum(g.price) AS revenue, count(*)::int AS orders
  FROM g WHERE g.is_sold GROUP BY 1
),
statusdist AS (SELECT g.status, count(*)::int AS count, sum(g.price) AS value FROM g GROUP BY 1),
cities AS (SELECT g.city, count(*)::int AS orders, sum(g.price) AS revenue FROM g WHERE g.is_sold GROUP BY 1),
deliv  AS (SELECT coalesce(nullif(g.delivery_type, ''), 'home') AS delivery,
                  count(*)::int AS orders, sum(g.price) AS revenue FROM g WHERE g.is_sold GROUP BY 1),
srcs   AS (SELECT coalesce(nullif(g.source_type, ''), 'manual') AS source,
                  count(*)::int AS orders, sum(g.price) AS revenue FROM g WHERE g.is_sold GROUP BY 1),
agents AS (
  SELECT g.owner_raw,
    count(*) FILTER (WHERE g.is_real)::int                           AS orders,
    count(*) FILTER (WHERE g.is_real AND g.is_sold)::int             AS sold,
    count(*) FILTER (WHERE g.is_real AND g.is_paid)::int             AS paid,
    count(*) FILTER (WHERE g.is_real AND g.status = 'returned')::int AS returned,
    -- trashed is credited to ownerOf() and is NOT gated on is_real (see :13543)
    count(*) FILTER (WHERE g.status = 'trashed')::int                AS trashed,
    coalesce(sum(g.price) FILTER (WHERE g.is_real AND g.is_sold), 0)      AS revenue,
    coalesce(sum(g.units) FILTER (WHERE g.is_real AND g.is_sold), 0)::int AS units,
    -- payout inputs. PAID ⊂ REAL_ORDER so is_paid alone is faithful.
    coalesce(sum(g.price) FILTER (WHERE g.is_paid), 0)               AS paid_revenue,
    coalesce(sum(g.bonus) FILTER (WHERE g.is_paid), 0)::int          AS bonus_sum,
    coalesce(sum(g.units) FILTER (WHERE g.is_paid), 0)::int          AS pkgs_paid,
    coalesce(sum(g.units) FILTER (WHERE g.is_real
             AND g.status IN ('confirmed','shipped','delivered')), 0)::int AS pkgs_awaiting,
    coalesce(sum(g.units) FILTER (WHERE g.is_real AND g.status = 'returned'), 0)::int AS pkgs_returned
  FROM g GROUP BY 1
),
cancels AS (
  -- nameById[cancelled_by_agent_id] ?? confirmed_by_name ?? assigned_agent_name
  SELECT coalesce(pr.full_name, g.confirmed_by_name, g.assigned_agent_name) AS canceller_raw,
         count(*)::int AS cancelled
  FROM g LEFT JOIN public.profiles pr ON pr.user_id = g.cancelled_by_agent_id
  WHERE g.status = 'cancelled' GROUP BY 1
),
retreason AS (SELECT coalesce(nullif(g.return_reason, ''), '(unspecified)') AS reason,
                     count(*)::int AS count FROM g WHERE g.status = 'returned' GROUP BY 1),
retcity   AS (SELECT g.city, count(*)::int AS count FROM g WHERE g.status = 'returned' GROUP BY 1),
canreason AS (SELECT coalesce(nullif(g.cancellation_reason, ''), '(unspecified)') AS reason,
                     count(*)::int AS count FROM g WHERE g.status = 'cancelled' GROUP BY 1),
logi AS (
  -- counts only; the editable rate card is applied in TS so loadCourierRates()
  -- stays the single source of truth for money.
  SELECT coalesce(g.courier, 'unknown') AS courier,
         coalesce(g.service, '—')       AS service,
         (g.courier IS NOT NULL)        AS known,
         count(*) FILTER (WHERE g.status IN ('shipped','delivered','paid'))::int AS delivered,
         count(*) FILTER (WHERE g.status = 'returned')::int                      AS returned
  FROM g WHERE g.status IN ('shipped','delivered','paid','returned') GROUP BY 1,2,3
),
plists AS (
  -- extra owner_raw grain so TS can apply the agentNames gate to bonus_paid
  SELECT g.prediction_list_id AS list_id, g.prediction_list_name AS name,
         g.prediction_list_type AS type, g.prediction_list_category AS category,
         g.owner_raw,
         count(*)::int                                                AS orders,
         count(*) FILTER (WHERE g.is_real)::int                       AS confirmed,
         count(*) FILTER (WHERE g.is_paid)::int                       AS paid,
         count(*) FILTER (WHERE g.status = 'returned')::int           AS returned,
         count(*) FILTER (WHERE g.status = 'cancelled')::int          AS cancelled,
         coalesce(sum(g.price) FILTER (WHERE g.is_sold), 0)           AS revenue,
         coalesce(sum(g.price) FILTER (WHERE g.status = 'returned'), 0) AS refund_value,
         coalesce(sum(g.bonus), 0)::int                               AS bonus_sum
  FROM g WHERE g.prediction_list_id IS NOT NULL GROUP BY 1,2,3,4,5
),
sc AS (
  SELECT coalesce(sum(g.price) FILTER (WHERE g.is_paid), 0)      AS paid_revenue,
         count(*) FILTER (WHERE g.is_paid)::int                  AS paid_count,
         coalesce(sum(g.price) FILTER (WHERE g.is_sold), 0)      AS sold_revenue,
         count(*) FILTER (WHERE g.is_sold)::int                  AS sold_count,
         coalesce(sum(g.units) FILTER (WHERE g.is_sold), 0)::int AS units_sold,
         coalesce(sum(g.price) FILTER (WHERE g.status = 'returned'), 0) AS returns_value,
         coalesce(sum(g.price) FILTER (WHERE g.status IN ('confirmed','shipped','delivered')), 0) AS pipeline_value,
         count(*) FILTER (WHERE g.is_real)::int                  AS real_orders_count
  FROM g
)
SELECT jsonb_build_object(
  'span_days',           (SELECT span_days FROM span),
  'granularity',         (SELECT granularity FROM gran),
  'scalars',             (SELECT to_jsonb(sc) FROM sc),
  'status_distribution', (SELECT coalesce(jsonb_agg(to_jsonb(x)), '[]') FROM statusdist x),
  'trend',               (SELECT coalesce(jsonb_agg(to_jsonb(x)), '[]') FROM trend x),
  'by_city',             (SELECT coalesce(jsonb_agg(to_jsonb(x)), '[]') FROM cities x),
  'by_delivery',         (SELECT coalesce(jsonb_agg(to_jsonb(x)), '[]') FROM deliv x),
  'by_source',           (SELECT coalesce(jsonb_agg(to_jsonb(x)), '[]') FROM srcs x),
  'agents',              (SELECT coalesce(jsonb_agg(to_jsonb(x)), '[]') FROM agents x),
  'cancels',             (SELECT coalesce(jsonb_agg(to_jsonb(x)), '[]') FROM cancels x),
  'ret_reason',          (SELECT coalesce(jsonb_agg(to_jsonb(x)), '[]') FROM retreason x),
  'ret_city',            (SELECT coalesce(jsonb_agg(to_jsonb(x)), '[]') FROM retcity x),
  'can_reason',          (SELECT coalesce(jsonb_agg(to_jsonb(x)), '[]') FROM canreason x),
  'logistics',           (SELECT coalesce(jsonb_agg(to_jsonb(x)), '[]') FROM logi x),
  'prediction',          (SELECT coalesce(jsonb_agg(to_jsonb(x)), '[]') FROM plists x)
)
$$;

CREATE OR REPLACE FUNCTION public.insights_paid_basis(
  p_from text, p_to_end text, p_rates jsonb, p_fallback_deliver double precision)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp SET TimeZone = 'UTC' SET work_mem = '64MB'
AS $$
WITH paid AS (
  SELECT o.id, o.price, o.quantity, o.product_name,
         -- `(rates[key]?.deliver) ?? fallback.deliver` — `??` means an explicit
         -- 0 in the rate card wins over the fallback, which is what coalesce does.
         coalesce((p_rates -> (
            coalesce(CASE WHEN o.delivery_type = 'speedy_office' THEN 'speedy'
                          WHEN o.delivery_type = 'econt_office'  THEN 'econt'
                          WHEN o.delivery_type = 'mex_office'    THEN 'mex'
                          WHEN o.home_courier IN ('speedy','econt','mex') THEN o.home_courier END, '')
            || '_' ||
            coalesce(CASE WHEN o.delivery_type IN ('speedy_office','econt_office','mex_office') THEN 'office'
                          WHEN o.home_courier IN ('speedy','econt','mex') THEN 'door' END, '')
         ) ->> 'deliver')::float8, p_fallback_deliver) AS drate
  FROM public.orders o
  WHERE o.status = 'paid'
    AND (o.source_type IS NULL OR o.source_type <> 'monadon_legacy')
    AND (nullif(p_from, '')   IS NULL OR o.created_at >= nullif(p_from, '')::timestamptz)
    AND (nullif(p_to_end, '') IS NULL OR o.created_at <= nullif(p_to_end, '')::timestamptz)
),
it AS (
  SELECT i.order_id, i.product_name, coalesce(i.quantity, 0) AS q,
         coalesce(i.price_per_unit, 0) AS ppu, coalesce(i.total_price, 0) AS tp
  FROM public.order_items i JOIN paid p ON p.id = i.order_id
),
nit AS (SELECT order_id, count(*) AS n FROM it GROUP BY 1),
w AS (
  -- weight: ppu>0 ? ppu*(q||1) : tp>0 ? tp : (q||1)
  -- NOTE q is fallback-to-1 INSIDE the weight but raw everywhere else — a
  -- zero-quantity item is weighted as if 1 yet contributes 0 packages.
  SELECT it.*, p.price, p.drate,
    (CASE WHEN it.ppu > 0 THEN it.ppu::float8 * (CASE WHEN it.q = 0 THEN 1 ELSE it.q END)::float8
          WHEN it.tp  > 0 THEN it.tp::float8
          ELSE (CASE WHEN it.q = 0 THEN 1 ELSE it.q END)::float8 END) AS wi
  FROM it JOIN paid p ON p.id = it.order_id
),
wt AS (
  SELECT w.*,
         sum(w.wi) OVER (PARTITION BY w.order_id) AS tot_raw,
         sum(w.q)  OVER (PARTITION BY w.order_id) AS pkg_raw
  FROM w
),
lines AS (
  SELECT wt.order_id, wt.product_name, wt.q,
         wt.price::float8 * (wt.wi / (CASE WHEN wt.tot_raw = 0 THEN 1 ELSE wt.tot_raw END)) AS line_rev,
         wt.drate / (CASE WHEN wt.pkg_raw = 0 THEN 1 ELSE wt.pkg_raw END)::float8           AS dshare,
         true AS from_items
  FROM wt
),
legacy AS (
  SELECT p.id AS order_id, p.product_name,
         (CASE WHEN coalesce(p.quantity, 0) = 0 THEN 1 ELSE p.quantity END) AS q,
         p.price::float8 AS line_rev,
         p.drate / (CASE WHEN coalesce(p.quantity, 0) = 0 THEN 1 ELSE p.quantity END)::float8 AS dshare,
         false AS from_items
  FROM paid p LEFT JOIN nit n ON n.order_id = p.id
  WHERE coalesce(n.n, 0) = 0 AND p.product_name IS NOT NULL AND p.product_name <> ''
),
all_lines AS (SELECT * FROM lines UNION ALL SELECT * FROM legacy),
-- paidProdMap key: `it.product_name || "(unknown)"` for items, RAW name for legacy
prodpaid AS (
  SELECT CASE WHEN from_items THEN coalesce(nullif(product_name, ''), '(unknown)')
              ELSE product_name END AS product,
         sum(q)::int                   AS packages,
         count(DISTINCT order_id)::int AS orders,
         sum(line_rev)                 AS revenue,
         sum(dshare * q::float8)       AS deliver_sum
  FROM all_lines GROUP BY 1
),
-- orderCOGS() keys on the RAW product_name and uses (quantity || 1) — a
-- DIFFERENT key and a DIFFERENT unit count than paidProdMap. Kept separate so
-- pure_profit.cogs and Σ by_product.cogs stay exactly as they are today.
cogs_units AS (
  SELECT raw_product, sum(u)::int AS cogs_units FROM (
    SELECT it.product_name AS raw_product, CASE WHEN it.q = 0 THEN 1 ELSE it.q END AS u FROM it
    UNION ALL
    SELECT p.product_name, CASE WHEN coalesce(p.quantity,0) = 0 THEN 1 ELSE p.quantity END
      FROM paid p LEFT JOIN nit n ON n.order_id = p.id WHERE coalesce(n.n, 0) = 0
  ) z GROUP BY 1
),
-- realizedPkg: the unit price pushed q times; q=0 pushes nothing. Run-length
-- encoded instead of materialising one row per package.
dist AS (SELECT (line_rev / q::float8) AS u, sum(q)::bigint AS c
         FROM all_lines WHERE q > 0 GROUP BY 1),
tot  AS (SELECT coalesce(sum(c), 0)::bigint AS n FROM dist),
cum  AS (SELECT u, sum(c) OVER (ORDER BY u ROWS UNBOUNDED PRECEDING) AS cend FROM dist),
pk   AS (SELECT v.p,
           (SELECT c.u FROM cum c
             WHERE c.cend > public.js_pctl_index(v.p, (SELECT n FROM tot))
             ORDER BY c.u LIMIT 1) AS val
         FROM (VALUES (25),(50),(75)) v(p))
SELECT jsonb_build_object(
  'by_product',    (SELECT coalesce(jsonb_agg(to_jsonb(x)), '[]') FROM prodpaid x),
  'cogs_units',    (SELECT coalesce(jsonb_agg(to_jsonb(x)), '[]') FROM cogs_units x),
  'paid_packages', (SELECT coalesce(sum(q), 0)::int FROM all_lines),
  'realized', jsonb_build_object(
     'n',   (SELECT n FROM tot),
     'p25', (SELECT val FROM pk WHERE p = 25),
     'p50', (SELECT val FROM pk WHERE p = 50),
     'p75', (SELECT val FROM pk WHERE p = 75),
     'min', (SELECT u FROM dist ORDER BY u ASC  LIMIT 1),
     'max', (SELECT u FROM dist ORDER BY u DESC LIMIT 1))
)
$$;
