-- ============================================================================
-- INSIGHTS → PURE PROFIT: A MONTHLY CACHE FOR LONG WINDOWS (2026-09-28)
--
-- Owner, 28.09: long windows may be faster "if it doesn't make a problem".
-- A year on /insights?tab=pure-profit took 5–8 s: insights_profit() rebuilds
-- every sale's lines, product costs and parcels for 12 months, twice (cohort +
-- cash). Closed months hardly change, so their P&L building blocks are now
-- kept per month and a long window reads them instead of recomputing.
--
-- WHAT IS CACHED: public.insights_profit_monthly — one row per CLOSED Skopje
-- month × clock ('cohort' | 'cash'): exactly the jsonb insights_profit()
-- returns for that month (granularity 'month', detail on): the cohort strip,
-- the P&L building blocks per source / month / AlterCPA webmaster, commission
-- per owner, the product rows, the realized-price histogram, returned parcels.
-- Every block is ADDITIVE (sums per key), so the api (insightsProfit.ts
-- mergeProfitRpcs) adds whole cached months to the live pieces of a window —
-- the partial first month and the current month — and gets the very same
-- numbers a single live call returns. scripts/verify-tab-profit.mjs --cache
-- proves it (a year and 01.04–27.09: month pieces vs one live call).
--
-- insights_profit() is re-emitted (same signature) with three changes that make
-- it additive over any split of a window, nothing else:
--   * a parcel two orders share counts 1/holders for each holder, the holders
--     counted over ALL of them (the foundation's rule), not only those inside
--     the window (3 such parcels exist; a window holding one holder now carries
--     half the parcel instead of all of it);
--   * sums leave with 9 decimals instead of 2 / 4 (the api rounds to denars once);
--   * a product's display name / kind is the byte-order (COLLATE "C") minimum,
--     the same rule the api applies when it folds pieces.
--
-- FRESHNESS. A cached month is used only while it is valid:
--   version   insights_profit_cache_version() — bump it when the P&L logic changes
--   sig       insights_profit_cache_sig(): the catalogue (id, name, cost_price),
--             the reviewed product aliases and the test-phone list — a cost price
--             entered in Products invalidates every cached month at once
-- Data under a closed month still moves (MEX delivers late, repairs relink
-- parcels, AlterCPA dates a sale): insights_profit_touched(since) lists the
-- months whose rows changed since a moment (orders / order_items updated_at, a
-- parcel linked here or updated at MEX (+2 days import slack), a web order
-- (+1 day), an AlterCPA decision). The NIGHTLY job refreshes:
--   the last 3 closed months · every cached month touched since its refresh ·
--   every month with an old version / sig · missing months of the last 24
-- (at most 30 a night, newest first). Between runs a cached month can be behind
-- the live data — the tab says "cached until dd.mm HH:mm" and owners can refresh
-- the window's months by hand (POST /api/insights/profit/refresh).
--
-- CRON: 'insights-profit-monthly' at :40 past 01 and 02 UTC; the function runs
-- only when it is 03:xx in Skopje, so it fires once a night in summer (CEST,
-- 01:40 UTC) and in winter (CET, 02:40 UTC) — the DST-proof gate the other
-- crons use. Quiet window: no import cron is heavy at 03:40.
--
-- Writes: only public.insights_profit_monthly, only through the SECURITY
-- DEFINER refresh functions (service_role / pg_cron). Nothing else is written.
-- ============================================================================

SET LOCAL lock_timeout = '5s';

DO $dep$
BEGIN
  IF to_regprocedure('public.insights_profit(timestamptz,timestamptz,text,text,boolean)') IS NULL THEN
    RAISE EXCEPTION 'apply 20260941000300_insights_profit.sql first';
  END IF;
  IF to_regnamespace('cron') IS NULL THEN
    CREATE EXTENSION IF NOT EXISTS pg_cron;
  END IF;
END
$dep$;

-- ── 1. insights_profit(), additive over any split of a window ───────────────
CREATE OR REPLACE FUNCTION public.insights_profit(
  p_from        timestamptz,
  p_to_end      timestamptz,
  p_clock       text    DEFAULT 'cohort',
  p_granularity text    DEFAULT NULL,
  p_detail      boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET TimeZone = 'UTC'
SET work_mem = '64MB'
SET jit = off
AS $fn$
DECLARE
  -- $1 from · $2 to_end · $3 granularity ('day' | 'month') · $4 detail
  v_head_cohort text := $hc$
WITH
prm AS (
  SELECT $1::timestamptz AS f, $2::timestamptz AS t, $3::text AS gran,
         CASE WHEN $3::text = 'day' THEN 'YYYY-MM-DD' ELSE 'YYYY-MM' END AS fmt
),
-- THE sale cohort (insights_sale_rows), each sale's group:
--   collected = paid (MEX delivered) + paid_legacy · returned · open (courier,
--   problem, label, to pack) · unproven (CRM paid, no parcel — never profit)
sr AS MATERIALIZED (
  SELECT r.kind, r.source, r.bucket, r.in_total, r.value_mkd, r.cod_mkd, r.card_mkd, r.sale_day,
         r.order_id, r.web_id, r.tracking_id, r.q_shared_parcel,
         CASE WHEN r.bucket IN ('paid', 'paid_legacy') THEN 'collected'
              WHEN r.bucket = 'returned'               THEN 'returned'
              WHEN r.bucket = 'paid_unproven'          THEN 'unproven'
              WHEN r.in_total                          THEN 'open' END AS g
  FROM public.insights_sale_rows($1, $2, false) r
),
-- a parcel two orders share (owner-ruled accurate) is ONE parcel to MEX: each
-- holder carries 1/holders of it — counted over ALL its holders (the
-- foundation's rule: real, non-test orders), not only those in the window,
-- so any split of a window into pieces adds up to the same parcels
shp AS (
  SELECT x.mex_tracking_id AS tracking_id, count(*) AS c
  FROM public.orders x
  WHERE x.mex_tracking_id IN (SELECT sr.tracking_id FROM sr WHERE sr.q_shared_parcel AND sr.tracking_id IS NOT NULL)
    AND x.sale_source_detail IS DISTINCT FROM 'disposition'
    AND NOT public.insights_excluded8(public.insights_phone8(x.customer_phone), (SELECT public.report_excluded_phone8s()))
  GROUP BY 1
),
s0 AS (
  SELECT sr.g, sr.source, sr.kind,
         coalesce(sr.value_mkd, 0)::float8 AS rev, coalesce(sr.card_mkd, 0)::float8 AS card,
         sr.sale_day AS day, sr.order_id, sr.web_id, sr.tracking_id,
         CASE WHEN shp.c > 1 THEN 1.0::float8 / shp.c ELSE 1.0::float8 END AS pw
  FROM sr LEFT JOIN shp ON shp.tracking_id = sr.tracking_id AND sr.q_shared_parcel
  WHERE sr.g IS NOT NULL
),
$hc$;
  v_head_cash text := $hh$
WITH
prm AS (
  SELECT $1::timestamptz AS f, $2::timestamptz AS t, $3::text AS gran,
         CASE WHEN $3::text = 'day' THEN 'YYYY-MM-DD' ELSE 'YYYY-MM' END AS fmt
),
-- THE cash flow (insights_cash_rows): every MEX parcel delivered in the
-- window, once, with its owner; revenue = COD + the card money of a
-- card-paid web order
s0 AS (
  SELECT 'collected'::text AS g, c.source, c.kind,
         (coalesce(c.cod_mkd, 0) + coalesce(c.card_mkd, 0))::float8 AS rev,
         coalesce(c.card_mkd, 0)::float8 AS card,
         (c.delivered_at AT TIME ZONE 'Europe/Skopje')::date AS day,
         c.order_id, c.web_id, c.tracking_id, 1.0::float8 AS pw
  FROM public.insights_cash_rows($1, $2) c
),
$hh$;
  v_common text := $cm$
s1 AS MATERIALIZED (
  SELECT row_number() OVER () AS sid, s0.*,
         to_char(date_trunc(prm.gran, s0.day::timestamp), prm.fmt) AS d
  FROM s0 CROSS JOIN prm
),
oid AS MATERIALIZED (SELECT DISTINCT s1.order_id AS id FROM s1 WHERE s1.order_id IS NOT NULL),
oi AS MATERIALIZED (
  SELECT i.order_id, i.product_id, i.product_name,
         coalesce(i.quantity, 0) AS qty,
         coalesce(i.price_per_unit, 0)::float8 AS ppu,
         coalesce(i.total_price, 0)::float8 AS tp
  FROM public.order_items i JOIN oid ON oid.id = i.order_id
),
oia AS (
  SELECT oi.order_id,
         sum((CASE WHEN oi.ppu >= 35 THEN 3 WHEN oi.ppu > 25 THEN 2 ELSE 1 END) * oi.qty) AS bonus_items
  FROM oi GROUP BY 1
),
-- index.ts orderPackageBonus(), unchanged: EUR per package by the line's
-- unit price (<25 → 1 · 25–35 → 2 · ≥35 → 3), only when status = 'paid';
-- an order with no lines prices its own quantity. The owner (ownerOf()
-- before normAgent) goes out raw: the api applies the agents-only gate.
ob AS MATERIALIZED (
  SELECT x.id, x.status::text AS status, x.sale_source, x.product_id, x.product_name,
         coalesce(x.confirmed_by_name, x.assigned_agent_name) AS owner_raw,
         nullif(btrim(x.cpa_webmaster_id), '') AS wm,
         (a.order_id IS NOT NULL) AS has_items,
         CASE WHEN coalesce(x.quantity, 0) = 0 THEN 1 ELSE x.quantity END AS oq,
         CASE WHEN x.status::text <> 'paid' THEN 0
              WHEN a.order_id IS NOT NULL THEN coalesce(a.bonus_items, 0)
              ELSE (CASE WHEN coalesce(x.price, 0)::float8
                                / (CASE WHEN coalesce(x.quantity, 0) = 0 THEN 1 ELSE x.quantity END)::float8 >= 35 THEN 3
                         WHEN coalesce(x.price, 0)::float8
                                / (CASE WHEN coalesce(x.quantity, 0) = 0 THEN 1 ELSE x.quantity END)::float8 > 25 THEN 2
                         ELSE 1 END)
                   * (CASE WHEN coalesce(x.quantity, 0) = 0 THEN 1 ELSE x.quantity END)
         END::float8 AS bonus_eur
  FROM public.orders x
  JOIN oid ON oid.id = x.id
  LEFT JOIN oia a ON a.order_id = x.id
),
s AS MATERIALIZED (
  SELECT s1.*, ob.owner_raw, ob.status AS crm_status,
         CASE WHEN s1.source = 'altercpa' THEN coalesce(ob.wm, '__none__') END AS wm,
         coalesce(ob.bonus_eur, 0) AS bonus_eur
  FROM s1 LEFT JOIN ob ON ob.id = s1.order_id
),
-- every P&L sale's lines (collected + returned); a sale with none gets one
-- pseudo line so its revenue is never dropped
ln0 AS MATERIALIZED (
  SELECT s.sid, CASE WHEN ob.sale_source = 'collabbox' THEN 'collabbox' ELSE 'crm' END AS src,
         oi.product_name AS name, oi.product_id AS pid, oi.qty,
         CASE WHEN oi.ppu > 0 THEN oi.ppu * greatest(oi.qty, 0) WHEN oi.tp > 0 THEN oi.tp ELSE 0 END::float8 AS w0,
         CASE WHEN ob.status = 'paid'
              THEN (CASE WHEN oi.ppu >= 35 THEN 3 WHEN oi.ppu > 25 THEN 2 ELSE 1 END) * oi.qty ELSE 0 END::float8 AS lb,
         NULL::text AS wkind
  FROM s JOIN ob ON ob.id = s.order_id JOIN oi ON oi.order_id = s.order_id
  WHERE s.g IN ('collected', 'returned')
  UNION ALL
  SELECT s.sid, CASE WHEN ob.sale_source = 'collabbox' THEN 'collabbox' ELSE 'crm' END,
         ob.product_name, ob.product_id, ob.oq, 1::float8, ob.bonus_eur, NULL
  FROM s JOIN ob ON ob.id = s.order_id
  WHERE s.g IN ('collected', 'returned') AND NOT ob.has_items
  UNION ALL
  -- web_order_items joined straight (its index), never through a CTE: the
  -- planner cannot size a CTE and loops over it once per web sale
  SELECT s.sid, 'web', wi.name, NULL::uuid, coalesce(wi.quantity, 0),
         CASE WHEN wi.kind = 'GIFT' THEN 0
              ELSE greatest(coalesce(wi.price, 0) * coalesce(wi.quantity, 0) - coalesce(wi.discount_allocated, 0), 0) END::float8,
         0::float8, wi.kind
  FROM s JOIN public.web_order_items wi ON wi.shop_order_id = s.web_id
  WHERE s.g IN ('collected', 'returned') AND s.kind = 'web'
  UNION ALL
  SELECT s.sid, CASE WHEN s.kind = 'mex' THEN 'mex' ELSE 'none' END, NULL, NULL, 0, 1::float8, 0::float8, NULL
  FROM s
  WHERE s.g IN ('collected', 'returned')
    AND (s.kind = 'mex'
         OR (s.kind = 'web' AND NOT EXISTS (SELECT 1 FROM public.web_order_items wi WHERE wi.shop_order_id = s.web_id)))
),
-- the catalogue by its folded name (product_alias_norm): an exact name match
-- (case / spaces ignored) IS that catalogue product; spelling variants still
-- wait for reviewed product_aliases rows
cat AS (
  SELECT DISTINCT ON (public.product_alias_norm(p.name))
         public.product_alias_norm(p.name) AS nn, p.id
  FROM public.products p
  WHERE public.product_alias_norm(p.name) IS NOT NULL
  ORDER BY public.product_alias_norm(p.name), (coalesce(p.cost_price, 0) > 0) DESC, p.is_active DESC, p.created_at, p.id
),
-- keys and kinds once per distinct line (product_key() is not inlinable)
lk AS MATERIALIZED (
  SELECT d.src, d.pk_name, d.pk_pid, k.key0, k.nn, k.rk
  FROM (SELECT DISTINCT ln0.src, ln0.name, ln0.pid,
               coalesce(ln0.name, '') AS pk_name, coalesce(ln0.pid::text, '') AS pk_pid
          FROM ln0 WHERE ln0.src IN ('crm', 'collabbox', 'web')) d
  CROSS JOIN LATERAL (
    SELECT public.product_key(d.src, d.name, d.pid) AS key0,
           public.product_alias_norm(d.name) AS nn,
           (SELECT a.kind FROM public.product_aliases a
             WHERE a.source IN (d.src, 'any') AND a.alias_norm = public.product_alias_norm(d.name)
             ORDER BY (a.source = d.src) DESC LIMIT 1) AS rk
  ) k
),
lk2 AS MATERIALIZED (
  SELECT lk.src, lk.pk_name, lk.pk_pid,
         CASE WHEN lk.key0 LIKE 'p:%' THEN lk.key0
              WHEN cat.id IS NOT NULL THEN 'p:' || cat.id::text
              ELSE coalesce(lk.key0, '__unknown__') END AS k,
         -- a reviewed alias decides; until then the obvious non-product lines
         -- of the collabBox / CRM imports are recognised by their name
         coalesce(lk.rk,
           CASE WHEN lk.nn ~ '^(поен|poen)'          THEN 'loyalty_point'
                WHEN lk.nn ~ '^(достав|dostav)'      THEN 'delivery'
                WHEN lk.nn ~ '^(забелешк|zabeles)'   THEN 'note'
                WHEN lk.nn ~ '^(флаер|flaer|flyer)'  THEN 'flyer' END) AS kind0,
         (lk.rk IS NOT NULL) AS reviewed
  FROM lk LEFT JOIN cat ON cat.nn = lk.nn AND lk.key0 NOT LIKE 'p:%'
),
-- a known cost is a catalogue cost_price > 0 (EUR) — never invented
kc AS (
  SELECT DISTINCT ON (k2.k) k2.k, CASE WHEN p.cost_price > 0 THEN p.cost_price::numeric END AS cost_eur, p.name AS pname
  FROM lk2 k2 JOIN public.products p ON k2.k = 'p:' || p.id::text
  ORDER BY k2.k
),
ln1 AS (
  SELECT ln0.sid, ln0.name, ln0.qty, ln0.w0, ln0.lb,
         CASE WHEN ln0.src = 'mex' THEN '__mex_only__' WHEN ln0.src = 'none' THEN '__unknown__'
              ELSE coalesce(k2.k, '__unknown__') END AS k,
         CASE WHEN ln0.src IN ('mex', 'none') THEN 'unknown'
              ELSE coalesce(k2.kind0, CASE WHEN ln0.wkind = 'GIFT' THEN 'gift' END, 'product') END AS kind,
         coalesce(k2.reviewed, false) AS reviewed,
         kc.cost_eur::float8 AS cost_eur, kc.pname
  FROM ln0
  LEFT JOIN lk2 k2 ON k2.src = ln0.src AND k2.pk_name = coalesce(ln0.name, '') AND k2.pk_pid = coalesce(ln0.pid::text, '')
  LEFT JOIN kc ON kc.k = k2.k
),
-- per sale: the weights its value is split by
ls AS (
  SELECT ln1.sid, sum(ln1.w0) AS sw,
         sum(CASE WHEN ln1.kind IN ('product', 'gift') THEN ln1.qty ELSE 0 END) AS sq,
         count(*) AS nl,
         count(*) FILTER (WHERE ln1.kind IN ('product', 'gift')) AS np
  FROM ln1 GROUP BY 1
),
ln AS (
  SELECT ln1.sid, ln1.k, ln1.kind, ln1.reviewed, (ln1.kind IN ('product', 'gift')) AS pkg,
         ln1.qty, ln1.lb, ln1.cost_eur,
         coalesce(ln1.pname, ln1.name) AS name,
         s.g, s.source, s.d, s.wm,
         -- the sale's value by price weight; all-zero prices → by packages
         s.rev * (CASE WHEN ls.sw > 0 THEN ln1.w0 / ls.sw
                       WHEN ls.sq > 0 THEN (CASE WHEN ln1.kind IN ('product', 'gift') THEN ln1.qty::float8 / ls.sq ELSE 0 END)
                       ELSE 1.0::float8 / ls.nl END) AS rv,
         -- the sale's parcel by packages (courier share)
         s.pw * (CASE WHEN ls.np = 0 THEN 1.0::float8 / ls.nl
                      WHEN ln1.kind NOT IN ('product', 'gift') THEN 0
                      WHEN ls.sq > 0 THEN ln1.qty::float8 / ls.sq
                      ELSE 1.0::float8 / ls.np END) AS sh,
         (ln1.kind IN ('product', 'gift') AND ls.sw > 0 AND ln1.w0 = 0) AS free
  FROM ln1 JOIN ls ON ls.sid = ln1.sid JOIN s ON s.sid = ln1.sid
),
lm AS MATERIALIZED (     -- line measures (денари; cost EUR × 61,5)
  SELECT ln.*,
         CASE WHEN ln.pkg AND ln.cost_eur IS NOT NULL THEN ln.rv ELSE 0 END AS rc,
         CASE WHEN (ln.pkg AND ln.cost_eur IS NULL) OR ln.kind = 'unknown' THEN ln.rv ELSE 0 END AS ru,
         CASE WHEN NOT ln.pkg AND ln.kind <> 'unknown' THEN ln.rv ELSE 0 END AS rn,
         CASE WHEN ln.pkg AND ln.cost_eur IS NOT NULL THEN ln.cost_eur * ln.qty * 61.5 ELSE 0 END AS cm,
         CASE WHEN ln.pkg AND ln.cost_eur IS NOT NULL THEN ln.qty ELSE 0 END AS pc,
         CASE WHEN ln.pkg AND ln.cost_eur IS NULL THEN ln.qty ELSE 0 END AS pu,
         CASE WHEN ln.free THEN ln.qty ELSE 0 END AS fr
  FROM ln
),
agg_s AS (    -- sale-level measures
  SELECT s.g, s.source, s.d, s.wm, count(*) AS n, sum(s.rev) AS rev, sum(s.card) AS card, sum(s.pw) AS pw
  FROM s GROUP BY GROUPING SETS ((s.g, s.source), (s.g, s.d), (s.g, s.wm))
),
agg_l AS (    -- line measures on the same grains
  SELECT lm.g, lm.source, lm.d, lm.wm,
         sum(lm.rc) AS rc, sum(lm.ru) AS ru, sum(lm.rn) AS rn, sum(lm.cm) AS cm,
         sum(lm.pc) AS pc, sum(lm.pu) AS pu, sum(lm.fr) AS fr, sum(lm.lb) AS lb
  FROM lm GROUP BY GROUPING SETS ((lm.g, lm.source), (lm.g, lm.d), (lm.g, lm.wm))
),
agg AS (
  SELECT a.g,
         CASE WHEN a.source IS NOT NULL THEN 's' WHEN a.d IS NOT NULL THEN 'd' ELSE 'w' END AS dim,
         coalesce(a.source, a.d, a.wm) AS key,
         -- 9 decimals: a month-by-month cache adds up to the whole window exactly once rounded to denars
         a.n, round(a.rev::numeric, 9) AS rev, round(a.card::numeric, 9) AS card, round(a.pw::numeric, 9) AS pw,
         round(coalesce(l.rc, 0)::numeric, 9) AS rc, round(coalesce(l.ru, 0)::numeric, 9) AS ru, round(coalesce(l.rn, 0)::numeric, 9) AS rn,
         round(coalesce(l.cm, 0)::numeric, 9) AS cm, coalesce(l.pc, 0) AS pc, coalesce(l.pu, 0) AS pu,
         coalesce(l.fr, 0) AS fr, coalesce(l.lb, 0)::numeric AS lb
  FROM agg_s a
  LEFT JOIN agg_l l ON l.g = a.g
       AND coalesce(l.source, '') = coalesce(a.source, '') AND coalesce(l.d, '') = coalesce(a.d, '')
       AND coalesce(l.wm, '') = coalesce(a.wm, '')
  WHERE a.source IS NOT NULL OR a.d IS NOT NULL OR a.wm IS NOT NULL
),
comm AS (     -- today's per-package bonus of every paid order, at owner grain
  SELECT s.source, s.d, s.wm, s.owner_raw, sum(s.bonus_eur)::numeric AS b, count(*) AS n
  FROM s WHERE s.g = 'collected' AND s.bonus_eur > 0
  GROUP BY GROUPING SETS ((s.source, s.owner_raw), (s.d, s.owner_raw), (s.wm, s.owner_raw))
),
wmn AS (
  SELECT DISTINCT ON (w.wm_id) w.wm_id, w.name
  FROM public.altercpa_webmasters w
  WHERE nullif(btrim(w.name), '') IS NOT NULL
  ORDER BY w.wm_id, w.named_at DESC NULLS LAST, w.updated_at DESC
),
$cm$;
  v_tail_cohort text := $tc$
cb AS (       -- the cohort strip: Σ = insights_cohort, bucket by bucket
  SELECT sr.source AS s, sr.bucket AS b, count(*) AS n,
         round(coalesce(sum(sr.value_mkd), 0)) AS v,
         round(coalesce(sum(sr.cod_mkd), 0))   AS c,
         count(*) FILTER (WHERE sr.kind = 'order') AS no,
         count(*) FILTER (WHERE sr.kind = 'web')   AS nw,
         count(*) FILTER (WHERE sr.kind = 'mex')   AS nm
  FROM sr GROUP BY 1, 2
),
pn AS (       -- how many sales carry the product (a narrow hash, no DISTINCT sort)
  SELECT x.source, x.g, x.k, count(*) AS n
  FROM (SELECT lm.source, lm.g, lm.k, lm.sid FROM lm GROUP BY 1, 2, 3, 4) x
  GROUP BY 1, 2, 3
),
prod AS (     -- the product P&L (collected and returned), by source
  SELECT lm.source AS s, lm.g, lm.k,
         -- byte order (COLLATE "C"): the api folds pieces with the same rule
         min(lm.name COLLATE "C") AS name, min(lm.kind COLLATE "C") AS kind, bool_or(lm.reviewed) AS reviewed,
         bool_or(lm.pkg) AS pkg, max(lm.cost_eur) AS cost_eur, max(pn.n) AS n,
         sum(lm.qty) AS qty, sum(CASE WHEN lm.pkg THEN lm.qty ELSE 0 END) AS pkgs, sum(lm.fr) AS fr,
         round(sum(lm.rv)::numeric, 9) AS rev, round(sum(lm.cm)::numeric, 9) AS cm,
         round(sum(lm.sh)::numeric, 9) AS sh, sum(lm.lb)::numeric AS lb
  FROM lm JOIN pn ON pn.source = lm.source AND pn.g = lm.g AND pn.k = lm.k
  GROUP BY 1, 2, 3
),
pd AS (       -- realized денари per paid package (collected, real products), binned to the denar
  SELECT lm.source AS s, round(lm.rv / lm.qty)::int AS u, sum(lm.qty) AS q, sum(lm.rv) AS v
  FROM lm
  WHERE lm.g = 'collected' AND lm.pkg AND NOT lm.free AND lm.qty > 0 AND lm.rv > 0
  GROUP BY 1, 2
)
SELECT jsonb_build_object(
  'clock', 'cohort',
  'granularity', (SELECT gran FROM prm),
  'strip', coalesce((SELECT jsonb_agg(to_jsonb(cb) ORDER BY cb.s, cb.b) FROM cb), '[]'::jsonb),
  'agg', coalesce((SELECT jsonb_agg(to_jsonb(agg) ORDER BY agg.g, agg.dim, agg.key) FROM agg
                    WHERE $4 OR agg.dim = 's'), '[]'::jsonb),
  'wm_names', CASE WHEN $4 THEN coalesce((SELECT jsonb_object_agg(wmn.wm_id, wmn.name)
                          FROM wmn WHERE wmn.wm_id IN (SELECT a.key FROM agg a WHERE a.dim = 'w')), '{}'::jsonb) END,
  'comm', coalesce((SELECT jsonb_agg(jsonb_build_object(
             'dim', CASE WHEN c.source IS NOT NULL THEN 's' WHEN c.d IS NOT NULL THEN 'd' ELSE 'w' END,
             'key', coalesce(c.source, c.d, c.wm), 'o', c.owner_raw, 'b', c.b, 'n', c.n))
           FROM comm c WHERE c.source IS NOT NULL OR ($4 AND (c.d IS NOT NULL OR c.wm IS NOT NULL))), '[]'::jsonb),
  'products', CASE WHEN $4 THEN coalesce((SELECT jsonb_agg(to_jsonb(prod) ORDER BY prod.rev DESC, prod.k) FROM prod), '[]'::jsonb) END,
  'hist', CASE WHEN $4 THEN coalesce((SELECT jsonb_agg(jsonb_build_object('s', pd.s, 'u', pd.u, 'q', pd.q, 'v', round(pd.v::numeric, 9))) FROM pd), '[]'::jsonb) END,
  'no_items', (SELECT jsonb_build_object('n', count(*), 'v', round(coalesce(sum(s.rev), 0)))
                 FROM s JOIN ob ON ob.id = s.order_id
                WHERE s.g = 'collected' AND NOT ob.has_items)
)
$tc$;
  v_tail_cash text := $th$
xp AS MATERIALIZED (SELECT public.report_excluded_phone8s() AS l),
wc AS MATERIALIZED (
  SELECT DISTINCT w.mex_tracking_id AS tr FROM public.web_orders w
  WHERE w.mex_tracking_id IS NOT NULL AND w.deleted_in_shop_at IS NULL
),
rp AS (       -- parcels MEX returned in the window, owned as a sale is (web claim → order → MEX-only)
  SELECT p.tracking_id,
         to_char(date_trunc(prm.gran, (p.returned_at AT TIME ZONE 'Europe/Skopje')::date::timestamp), prm.fmt) AS d,
         CASE WHEN EXISTS (SELECT 1 FROM wc WHERE wc.tr = p.tracking_id) THEN 'web'
              ELSE coalesce(
                (SELECT public.cohort_order_source(x.sale_source) FROM public.orders x
                  WHERE x.mex_tracking_id = p.tracking_id
                    AND x.sale_source_detail IS DISTINCT FROM 'disposition'
                  ORDER BY x.created_at, x.id LIMIT 1),
                (SELECT public.cohort_order_source(x.sale_source) FROM public.orders x
                  WHERE p.order_id IS NOT NULL AND x.id = p.order_id
                    AND x.sale_source_detail IS DISTINCT FROM 'disposition'),
                'teleshop_other') END AS source
  FROM public.mex_parcels p CROSS JOIN prm CROSS JOIN xp
  WHERE p.returned_at BETWEEN prm.f AND prm.t
    AND NOT public.insights_excluded8(p.phone8, xp.l)
)
SELECT jsonb_build_object(
  'clock', 'cash',
  'granularity', (SELECT gran FROM prm),
  'agg', coalesce((SELECT jsonb_agg(to_jsonb(agg) ORDER BY agg.g, agg.dim, agg.key) FROM agg
                    WHERE $4 OR agg.dim = 's'), '[]'::jsonb),
  'wm_names', CASE WHEN $4 THEN coalesce((SELECT jsonb_object_agg(wmn.wm_id, wmn.name)
                          FROM wmn WHERE wmn.wm_id IN (SELECT a.key FROM agg a WHERE a.dim = 'w')), '{}'::jsonb) END,
  'comm', coalesce((SELECT jsonb_agg(jsonb_build_object(
             'dim', CASE WHEN c.source IS NOT NULL THEN 's' WHEN c.d IS NOT NULL THEN 'd' ELSE 'w' END,
             'key', coalesce(c.source, c.d, c.wm), 'o', c.owner_raw, 'b', c.b, 'n', c.n))
           FROM comm c WHERE c.source IS NOT NULL OR ($4 AND (c.d IS NOT NULL OR c.wm IS NOT NULL))), '[]'::jsonb),
  'returned_parcels', coalesce((SELECT jsonb_agg(jsonb_build_object('s', r.source, 'd', r.d, 'n', r.n))
           FROM (SELECT rp.source, rp.d, count(*) AS n FROM rp GROUP BY 1, 2) r), '[]'::jsonb)
)
$th$;
  v_gran text;
  v_days integer;
  v_out  jsonb;
BEGIN
  IF p_from IS NULL OR p_to_end IS NULL OR p_to_end < p_from OR p_to_end - p_from > interval '800 days' THEN
    RAISE EXCEPTION 'insights_profit: bad window' USING ERRCODE = '22023';
  END IF;
  IF coalesce(p_clock, 'cohort') NOT IN ('cohort', 'cash') THEN
    RAISE EXCEPTION 'insights_profit: unknown clock %', p_clock USING ERRCODE = '22023';
  END IF;
  -- daily up to 62 Skopje days, monthly beyond (as insights_cohort's spark);
  -- a caller that splits a window passes the whole window's granularity
  v_days := (p_to_end AT TIME ZONE 'Europe/Skopje')::date - (p_from AT TIME ZONE 'Europe/Skopje')::date + 1;
  v_gran := CASE WHEN p_granularity IN ('day', 'month') THEN p_granularity
                 WHEN v_days <= 62 THEN 'day' ELSE 'month' END;

  IF coalesce(p_clock, 'cohort') = 'cohort' THEN
    EXECUTE v_head_cohort || v_common || v_tail_cohort INTO v_out
      USING p_from, p_to_end, v_gran, coalesce(p_detail, true);
  ELSE
    EXECUTE v_head_cash || v_common || v_tail_cash INTO v_out
      USING p_from, p_to_end, v_gran, coalesce(p_detail, true);
  END IF;
  RETURN v_out;
END;
$fn$;

COMMENT ON FUNCTION public.insights_profit(timestamptz, timestamptz, text, text, boolean) IS
  'Insights → Pure Profit / Margins: the P&L inputs of one clock — cohort (insights_sale_rows) or cash (insights_cash_rows) — per sale split into lines, known product cost, parcel share, today''s per-package bonus raw per owner. ADDITIVE over any split of the window (a shared parcel counts 1/holders over all its holders; 9-decimal sums; byte-order names), so insights_profit_monthly months plus live edges equal one live call. Migrations 20260941000300 + 20260942000200.';

-- ── 2. the cache ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.insights_profit_monthly (
  month        date        NOT NULL
               CONSTRAINT insights_profit_monthly_month_check CHECK (extract(day FROM month) = 1),
  clock        text        NOT NULL
               CONSTRAINT insights_profit_monthly_clock_check CHECK (clock IN ('cohort', 'cash')),
  payload      jsonb       NOT NULL,
  sig          text        NOT NULL,
  version      integer     NOT NULL,
  refreshed_at timestamptz NOT NULL,
  duration_ms  integer,
  PRIMARY KEY (month, clock)
);

COMMENT ON TABLE public.insights_profit_monthly IS
  'Pure Profit monthly cache: insights_profit() of one CLOSED Skopje month per clock (granularity month, detail on) — additive blocks the api adds to live edges for windows over 62 days. refreshed_at = the data snapshot (10 min of in-flight-write slack subtracted). Valid while version = insights_profit_cache_version() and sig = insights_profit_cache_sig(). Written only by insights_profit_refresh() (nightly cron + the owners'' refresh). Migration 20260942000200.';

ALTER TABLE public.insights_profit_monthly ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.insights_profit_monthly FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.insights_profit_monthly TO service_role;

-- The P&L logic version the cached rows were built with.
CREATE OR REPLACE FUNCTION public.insights_profit_cache_version()
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $fn$ SELECT 2 $fn$;

-- What else a cached month depends on besides its own rows: the catalogue
-- (names fold lines, cost_price costs them), the reviewed aliases (keys and
-- kinds) and the test phones (excluded everywhere).
CREATE OR REPLACE FUNCTION public.insights_profit_cache_sig()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT md5(
    coalesce((SELECT string_agg(p.id::text || '|' || coalesce(p.name, '') || '|' || coalesce(p.cost_price::text, ''), ';' ORDER BY p.id)
                FROM public.products p), '') || '#' ||
    coalesce((SELECT string_agg(a.source || '|' || a.alias_norm || '|' || coalesce(a.product_id::text, '') || '|' || a.kind, ';'
                                ORDER BY a.source, a.alias_norm)
                FROM public.product_aliases a), '') || '#' ||
    coalesce(array_to_string(public.report_excluded_phone8s(), ','), ''))
$fn$;

-- ── 3. which months moved since a moment ─────────────────────────────────────
-- A SUPERSET: every month a changed row can sit in on either clock. changed_at
-- is the latest effective change (MEX's own parcel clock + 2 days, the shop's
-- + 1 day, for import slack — such a month stays "touched" for that long).
CREATE OR REPLACE FUNCTION public.insights_profit_touched(p_since timestamptz)
RETURNS TABLE (month date, changed_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET TimeZone = 'UTC'
SET work_mem = '64MB'
SET jit = off
AS $fn$
WITH ev AS (
  -- an order changed: its sale-day candidates, its parcel's delivery / return, its ledger date
  SELECT d.t, x.updated_at AS eff
  FROM public.orders x
  LEFT JOIN public.mex_parcels mp ON mp.tracking_id = x.mex_tracking_id
  CROSS JOIN LATERAL (VALUES (x.created_at), (x.confirmed_at), (x.sold_at), (x.mex_delivered_at),
                             (mp.delivered_at), (mp.returned_at),
                             ((SELECT max(l.decided_at) FROM public.altercpa_leads l WHERE l.order_id = x.id))) d(t)
  WHERE x.updated_at > p_since
  UNION ALL
  SELECT d.t, i.updated_at
  FROM public.order_items i
  JOIN public.orders x ON x.id = i.order_id
  CROSS JOIN LATERAL (VALUES (x.created_at), (x.confirmed_at), (x.sold_at), (x.mex_delivered_at)) d(t)
  WHERE i.updated_at > p_since
  UNION ALL
  -- a parcel updated at MEX (their clock) or linked / unlinked here
  SELECT d.t, greatest(pp.linked_at, pp.last_update_at + interval '2 days')
  FROM public.mex_parcels pp
  CROSS JOIN LATERAL (VALUES (pp.created_at_mex), (pp.delivered_at), (pp.returned_at)) d(t)
  WHERE pp.linked_at > p_since OR pp.last_update_at > p_since - interval '2 days'
  UNION ALL
  -- a web order changed in the shop or got its parcel
  SELECT d.t, greatest(w.updated_at + interval '1 day', w.mex_linked_at)
  FROM public.web_orders w
  LEFT JOIN public.mex_parcels wp ON wp.tracking_id = w.mex_tracking_id
  CROSS JOIN LATERAL (VALUES (w.created_at), (wp.delivered_at), (wp.returned_at)) d(t)
  WHERE w.updated_at > p_since - interval '1 day' OR w.mex_linked_at > p_since
  UNION ALL
  -- an AlterCPA decision dates a sale: its own month and the month the order sat in
  SELECT d.t, l.decided_at
  FROM public.altercpa_leads l
  JOIN public.orders x ON x.id = l.order_id
  CROSS JOIN LATERAL (VALUES (l.decided_at), (x.created_at), (x.confirmed_at)) d(t)
  WHERE l.decided_at > p_since
)
SELECT date_trunc('month', ev.t AT TIME ZONE 'Europe/Skopje')::date, max(ev.eff)
FROM ev
WHERE ev.t IS NOT NULL AND p_since IS NOT NULL
GROUP BY 1
$fn$;

-- ── 4. refresh one closed month (both clocks) ────────────────────────────────
CREATE OR REPLACE FUNCTION public.insights_profit_refresh(p_month date)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
SET TimeZone = 'UTC'
AS $fn$
DECLARE
  v_month date := date_trunc('month', p_month)::date;
  v_cur   date := date_trunc('month', now() AT TIME ZONE 'Europe/Skopje')::date;
  v_from  timestamptz;
  v_to    timestamptz;
  v_sig   text := public.insights_profit_cache_sig();
  v_ver   integer := public.insights_profit_cache_version();
  v_clock text;
  v_t0    timestamptz;
  v_out   jsonb := '[]'::jsonb;
BEGIN
  IF v_month IS NULL OR v_month >= v_cur THEN
    RETURN jsonb_build_object('month', v_month, 'skipped', 'not a closed month');
  END IF;
  -- one refresh of a month at a time (the cron and an owner's button can meet)
  IF NOT pg_try_advisory_xact_lock(hashtext('insights_profit_refresh'), (extract(year FROM v_month) * 100 + extract(month FROM v_month))::integer) THEN
    RETURN jsonb_build_object('month', v_month, 'skipped', 'being refreshed');
  END IF;
  v_from := v_month::timestamp AT TIME ZONE 'Europe/Skopje';
  v_to   := (v_month + interval '1 month')::timestamp AT TIME ZONE 'Europe/Skopje' - interval '1 microsecond';
  FOREACH v_clock IN ARRAY ARRAY['cohort', 'cash'] LOOP
    v_t0 := clock_timestamp();
    INSERT INTO public.insights_profit_monthly AS c (month, clock, payload, sig, version, refreshed_at, duration_ms)
    VALUES (v_month, v_clock, public.insights_profit(v_from, v_to, v_clock, 'month', true), v_sig, v_ver,
            -- a write still in flight when the snapshot was taken is dated
            -- before it: 10 minutes of slack so the touched-check sees it
            v_t0 - interval '10 minutes',
            (extract(epoch FROM clock_timestamp() - v_t0) * 1000)::integer)
    ON CONFLICT (month, clock) DO UPDATE
      SET payload = EXCLUDED.payload, sig = EXCLUDED.sig, version = EXCLUDED.version,
          refreshed_at = EXCLUDED.refreshed_at, duration_ms = EXCLUDED.duration_ms;
    v_out := v_out || jsonb_build_object('clock', v_clock, 'ms', (extract(epoch FROM clock_timestamp() - v_t0) * 1000)::integer);
  END LOOP;
  RETURN jsonb_build_object('month', v_month, 'clocks', v_out);
END;
$fn$;

COMMENT ON FUNCTION public.insights_profit_refresh(date) IS
  'Recompute one CLOSED Skopje month of insights_profit_monthly (both clocks); an open month is skipped. The owners'' refresh (POST /api/insights/profit/refresh, month by month) and the nightly job call it. Migration 20260942000200.';

-- ── 5. the cached months a window may use ────────────────────────────────────
-- Rows built with the current logic version and dependencies only (a months'
-- rows that moved since are the nightly job's, or the owner's refresh).
CREATE OR REPLACE FUNCTION public.insights_profit_cache_read(p_months date[])
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT jsonb_build_object(
    'rows', coalesce(jsonb_agg(jsonb_build_object(
      'month', to_char(c.month, 'YYYY-MM-DD'), 'clock', c.clock, 'refreshed_at', c.refreshed_at, 'payload', c.payload)
      ORDER BY c.month, c.clock), '[]'::jsonb))
  FROM public.insights_profit_monthly c
  WHERE c.month = ANY (p_months)
    AND c.version = public.insights_profit_cache_version()
    AND c.sig = public.insights_profit_cache_sig()
$fn$;

-- ── 6. the nightly job ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.insights_profit_refresh_nightly(p_force boolean DEFAULT false, p_max integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
SET TimeZone = 'UTC'
AS $fn$
DECLARE
  v_now    timestamp := now() AT TIME ZONE 'Europe/Skopje';
  v_cur    date := date_trunc('month', now() AT TIME ZONE 'Europe/Skopje')::date;
  v_sig    text := public.insights_profit_cache_sig();
  v_ver    integer := public.insights_profit_cache_version();
  v_since  timestamptz;
  v_months date[];
  v_m      date;
  v_done   jsonb := '[]'::jsonb;
  v_t0     timestamptz := clock_timestamp();
BEGIN
  -- DST-proof: scheduled at 01:40 and 02:40 UTC, runs only at 03:xx Skopje
  IF NOT coalesce(p_force, false) AND extract(hour FROM v_now)::integer <> 3 THEN
    RETURN jsonb_build_object('skipped', 'not 03:xx Skopje', 'skopje_time', to_char(v_now, 'HH24:MI'));
  END IF;
  SELECT min(c.refreshed_at) INTO v_since FROM public.insights_profit_monthly c;
  SELECT array_agg(x.m ORDER BY x.m DESC) INTO v_months
  FROM (
    SELECT DISTINCT m FROM (
      -- the last 3 closed months, always (late MEX deliveries land here)
      SELECT (v_cur - make_interval(months => i))::date AS m FROM generate_series(1, 3) i
      UNION ALL
      -- built with other logic or other catalogue / aliases / test phones
      SELECT c.month FROM public.insights_profit_monthly c WHERE c.version <> v_ver OR c.sig <> v_sig
      UNION ALL
      -- rows under the month moved since it was cached (repairs, relinks, late MEX)
      SELECT t.month FROM public.insights_profit_touched(v_since) t
      JOIN public.insights_profit_monthly c ON c.month = t.month AND t.changed_at > c.refreshed_at
      UNION ALL
      -- not cached yet (the last 24 closed months; one row per clock expected)
      SELECT g.m FROM (SELECT (v_cur - make_interval(months => i))::date AS m FROM generate_series(1, 24) i) g
      WHERE (SELECT count(*) FROM public.insights_profit_monthly c WHERE c.month = g.m) < 2
    ) a
    WHERE a.m < v_cur
    ORDER BY m DESC
    LIMIT greatest(1, coalesce(p_max, 30))
  ) x;
  FOREACH v_m IN ARRAY coalesce(v_months, ARRAY[]::date[]) LOOP
    v_done := v_done || public.insights_profit_refresh(v_m);
  END LOOP;
  RETURN jsonb_build_object('refreshed', v_done, 'months', coalesce(array_length(v_months, 1), 0),
                            'ms', (extract(epoch FROM clock_timestamp() - v_t0) * 1000)::integer);
END;
$fn$;

COMMENT ON FUNCTION public.insights_profit_refresh_nightly(boolean, integer) IS
  'Nightly (03:xx Skopje, DST-proof gate): refresh insights_profit_monthly for the last 3 closed months, every cached month touched since its refresh (insights_profit_touched), every month with an old version / sig, and missing months of the last 24 — at most p_max (30), newest first. p_force skips the hour gate. Migration 20260942000200.';

-- ── 7. grants ────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.insights_profit_cache_version()                    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.insights_profit_cache_sig()                        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.insights_profit_touched(timestamptz)               FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.insights_profit_refresh(date)                      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.insights_profit_cache_read(date[])                 FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.insights_profit_refresh_nightly(boolean, integer)  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.insights_profit_cache_version()                 TO service_role;
GRANT EXECUTE ON FUNCTION public.insights_profit_cache_sig()                     TO service_role;
GRANT EXECUTE ON FUNCTION public.insights_profit_touched(timestamptz)            TO service_role;
GRANT EXECUTE ON FUNCTION public.insights_profit_refresh(date)                   TO service_role;
GRANT EXECUTE ON FUNCTION public.insights_profit_cache_read(date[])              TO service_role;
GRANT EXECUTE ON FUNCTION public.insights_profit_refresh_nightly(boolean, integer) TO service_role;

-- The read-only harness (scripts/verify-tab-profit.mjs --cache) reads the cache
-- and the checks; it never refreshes. Conditional for a fresh local database.
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    GRANT SELECT ON public.insights_profit_monthly TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.insights_profit_cache_version()      TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.insights_profit_cache_sig()          TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.insights_profit_touched(timestamptz) TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.insights_profit_cache_read(date[])   TO supabase_read_only_user;
  END IF;
END
$grant$;

-- ── 8. the cron ──────────────────────────────────────────────────────────────
DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'insights-profit-monthly') THEN
    PERFORM cron.unschedule('insights-profit-monthly');
  END IF;
END
$cron$;

SELECT cron.schedule(
  'insights-profit-monthly',
  '40 1,2 * * *',
  $job$SELECT public.insights_profit_refresh_nightly();$job$
);

NOTIFY pgrst, 'reload schema';
