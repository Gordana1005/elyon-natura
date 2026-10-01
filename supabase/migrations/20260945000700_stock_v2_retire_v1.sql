-- ============================================================================
-- Stock v2 — retire v1 (owner 01.10.2026, docs/STOCK-V2.md "Retire v1", workstream A)
-- ============================================================================
-- Stock v2 knows exactly how much stock there is per article, warehouse and day: the 22.09 count,
-- every MEX parcel since (collabBox goods lines), Sigma for everything that is not a parcel — in the
-- append-only ledger public.stock_moves (migrations 20260945000100–0500). This migration retires the
-- v1 regime of 20260942000100 (a product-level count + a MEX ledger that moved products.stock_quantity):
--
--   1. cron 'stock-mex-apply' unscheduled; app_settings.stock_mex_movements marked
--      {"retired":"stock_v2","enabled":false} (v1 was never switched on: from = null).
--   2. insights_stock (Insights → Products & stock) re-emitted — its "trusted" stock is now
--      Stock v2's: every routed warehouse has an APPROVED opening, stock_v2.enabled is on and the last
--      ok stock_v2_apply run is under 60 minutes old. Quantities still come from products.stock_quantity,
--      which (3) keeps as the ledger's mirror; a product is "tracked" when the mirror writes it.
--      The trust keys keep their v1 names (counted, mex_enabled, mex_from, mex_last_run) so the page
--      reads on unchanged — see the st CTE. Drift guard: the body was taken from the live definition.
--   3. products_stock_mirror_refresh() — products.stock_quantity = the stock the ledger holds at
--      warehouse 'main' NOW (stock_v2_on_hand(now(), 'main', false)), per product with an approved
--      recipe valid now and not exempt: floor(min over its lines of on_hand ÷ line qty) — a single-article
--      product shows that article's on-hand, a bundle how many complete bundles the shelf makes (gift
--      lines count only for a product that is nothing but gifts). No recipe / exempt → left untouched.
--      Only while stock_v2.enabled is on (off = {"status":"disabled"}, nothing written: the ledger is
--      empty in preview). One at a time (advisory lock). Writes under the GUC elyon.stock_write.
--   4. tg_products_stock_guard — products.stock_quantity is written ONLY under elyon.stock_write = 'on'
--      (the mirror and the Stock v2 writers). Every v1 writer stops: the api's status deductions
--      (stockByStatus() is false once 'stock_v2' exists), restock / stock/count / BigArena sync (410),
--      the product form (the field is gone), stock_count_apply / stock_restock / stock_mex_apply, the
--      catalogue scripts. An INSERT may still create a product at stock 0 (the default).
--      Note: trg_notify_low_stock still fires on the mirror's updates (a product crossing its
--      low_stock_threshold notifies admins + warehouse) — the first refresh after the switch can send a
--      burst for every product whose real stock is under its threshold.
--   5. cron 'stock-v2-mirror' — the mirror every 15 minutes (14,29,44,59 UTC, 7 minutes after
--      mex-reconcile); the api also refreshes after POST stock/v2/run, the switch and a recipe change.
--      Off it returns after one settings read.
--
-- Deploy order: 20260945000100–0650 (workstreams E / S / P) → THIS → the api. Applied before them it
-- refuses (precondition below). Re-runnable (the drift guard accepts the old and the new body).
-- Rollback: DROP TRIGGER trg_products_stock_guard ON public.products; re-run the insights_stock body of
-- 20260942001800 (live md5 3cbd8b35a664276db691c734cc9c254b); cron.schedule('stock-mex-apply', '12,42 * * * *', …).
-- ============================================================================

BEGIN;

-- ── 0. preconditions: the Stock v2 schema and engine are applied ──────────────────────────────────
DO $pre$
DECLARE v_missing text;
BEGIN
  SELECT string_agg(x.name, ', ') INTO v_missing
  FROM (VALUES
    ('public.stock_moves', to_regclass('public.stock_moves') IS NOT NULL),
    ('public.stock_runs', to_regclass('public.stock_runs') IS NOT NULL),
    ('public.stock_wh_counts', to_regclass('public.stock_wh_counts') IS NOT NULL),
    ('public.stock_parcel_routes', to_regclass('public.stock_parcel_routes') IS NOT NULL),
    ('public.product_articles', to_regclass('public.product_articles') IS NOT NULL),
    ('public.product_stock_exempt', to_regclass('public.product_stock_exempt') IS NOT NULL),
    ('public.stock_v2_on_hand(timestamptz,text,boolean)',
       to_regprocedure('public.stock_v2_on_hand(timestamp with time zone,text,boolean)') IS NOT NULL),
    ('app_settings.stock_v2', EXISTS (SELECT 1 FROM public.app_settings WHERE key = 'stock_v2'))
  ) x(name, present)
  WHERE NOT x.present;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'stock v2 retire-v1: apply 20260945000100–0500 first (missing: %)', v_missing;
  END IF;
END
$pre$;

-- ── 0b. drift guard: insights_stock below was re-emitted from this live body ───────────────────────
DO $drift$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(e.sig, ', ') INTO v_bad
  FROM (VALUES
    ('public.insights_stock(timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone,text[],boolean)',
     '3cbd8b35a664276db691c734cc9c254b', 'fd482003616e0836b13e7fc2686f2a33')
  ) e(sig, old_md5, new_md5)
  LEFT JOIN pg_proc p ON p.oid = to_regprocedure(e.sig)
  WHERE p.oid IS NULL OR md5(replace(p.prosrc, chr(13), '')) NOT IN (e.old_md5, e.new_md5);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'stock v2 retire-v1: % changed since this migration was written — re-emit it from the live body', v_bad;
  END IF;
END
$drift$;

-- ── 1. the v1 MEX stock ledger: unscheduled, marked retired ────────────────────────────────────────
DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'stock-mex-apply') THEN
    PERFORM cron.unschedule('stock-mex-apply');
  END IF;
END
$cron$;

UPDATE public.app_settings
   SET value = coalesce(CASE WHEN jsonb_typeof(value) = 'object' THEN value END, '{}'::jsonb)
               || jsonb_build_object('retired', 'stock_v2', 'enabled', false)
 WHERE key = 'stock_mex_movements';

-- ── 2. insights_stock: the Stock v2 trust (re-emitted from the live body; only the sv2 / rcp / pc /
--      st / tr CTEs and the last_count key differ) ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.insights_stock(p_from timestamp with time zone, p_to_end timestamp with time zone, p_prev_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_prev_to_end timestamp with time zone DEFAULT NULL::timestamp with time zone, p_sources text[] DEFAULT NULL::text[], p_money boolean DEFAULT false)
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
  v_gran text;
  v_lo   timestamptz;
  v_out  jsonb;
BEGIN
  IF p_from IS NULL OR p_to_end IS NULL OR p_to_end < p_from OR p_to_end - p_from > interval '800 days' THEN
    RAISE EXCEPTION 'insights_stock: bad window' USING ERRCODE = '22023';
  END IF;
  IF p_prev_from IS NOT NULL AND p_prev_to_end IS NOT NULL AND p_prev_to_end >= p_prev_from
     AND p_prev_to_end < p_from AND p_to_end - p_from <= interval '93 days' THEN
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
    RAISE EXCEPTION 'insights_stock: unknown source %', v_bad USING ERRCODE = '22023';
  END IF;

  v_fd   := (p_from   AT TIME ZONE 'Europe/Skopje')::date;
  v_td   := (p_to_end AT TIME ZONE 'Europe/Skopje')::date;
  v_gran := CASE WHEN v_td - v_fd + 1 <= 62 THEN 'day' ELSE 'month' END;
  v_lo   := least(p_from, coalesce(v_pf, p_from));

  -- $1 from · $2 to_end · $3 prev_from · $4 prev_to_end · $5 sources ·
  -- $6 earliest instant (prev) · $7 from day · $8 to day · $9 trend
  -- granularity · $10 the test phones' last-8 digits · $11 today (Skopje)
  EXECUTE $st$
WITH
prm AS (
  SELECT $1::timestamptz AS f, $2::timestamptz AS t, $3::timestamptz AS pf, $4::timestamptz AS pt,
         $5::text[] AS srcs, $7::date AS fd, $8::date AS td, $9::text AS gran, $11::date AS today,
         CASE WHEN $9::text = 'day' THEN 'YYYY-MM-DD' ELSE 'YYYY-MM' END AS fmt
),
-- ── what moved: the cohort's sales (sale day), what came back (MEX return
-- day) and what waits in the warehouse NOW ─────────────────────────────────
sr AS MATERIALIZED (       -- the period's sales (+ the previous period's, for the movers)
  SELECT r.kind, r.source, r.sale_source, r.order_id, r.web_id,
         (r.sale_at BETWEEN $1 AND $2) AS cur,
         coalesce(r.sale_at BETWEEN $3 AND $4, false) AS prev,
         to_char(date_trunc($9, (r.sale_at AT TIME ZONE 'Europe/Skopje')::date::timestamp),
                 CASE WHEN $9 = 'day' THEN 'YYYY-MM-DD' ELSE 'YYYY-MM' END) AS d
  FROM public.insights_sale_rows($6, $2, false) r
  WHERE r.in_total AND r.source = ANY ($5)
),
rt AS MATERIALIZED (       -- parcels MEX returned in the period (goods back on the shelf)
  SELECT q.kind, q.source, q.sale_source, q.order_id, q.web_id
  FROM public.insights_parcel_rows($1, $2, 'returned') q
  WHERE q.source = ANY ($5)
),
lb AS MATERIALIZED (       -- label printed, waiting for the courier NOW (MEX 8) — each parcel once
  SELECT q.kind, q.source, q.sale_source, q.order_id, q.web_id, q.sale_at, q.cod_mkd AS value_mkd
  FROM public.insights_parcel_rows($1, $2, 'label_now') q
  WHERE q.source = ANY ($5) AND coalesce(q.cod_mkd, 0) > 0
),
wc AS MATERIALIZED (       -- parcels a live web order claims (web claims win — the cohort's rule)
  SELECT DISTINCT w.mex_tracking_id AS tr FROM public.web_orders w
  WHERE w.mex_tracking_id IS NOT NULL AND w.deleted_in_shop_at IS NULL
),
tp AS MATERIALIZED (       -- the test phones' parcels
  SELECT p.tracking_id AS tr FROM public.mex_parcels p WHERE p.phone8 = ANY ($10)
),
tk AS MATERIALIZED (       -- to pack NOW: sold, no parcel yet (the cohort's to_pack bucket)
  SELECT 'order'::text AS kind, public.cohort_order_source(x.sale_source, x.sale_source_detail, x.mex_tracking_id, x.dept_override) AS source, x.sale_source,
         x.id AS order_id, NULL::integer AS web_id,
         coalesce(x.sold_at,
                  (SELECT max(l.decided_at) FROM public.altercpa_leads l
                    WHERE x.sold_at IS NULL AND l.order_id = x.id
                      AND l.decision IN ('approved', 'cancel_other') AND l.decided_at IS NOT NULL),
                  x.confirmed_at, x.created_at) AS sale_at,
         round(coalesce(x.price, 0) * 61.5) AS value_mkd
  FROM public.orders x
  WHERE x.status = 'confirmed'
    AND x.sale_source_detail IS DISTINCT FROM 'disposition'
    AND public.cohort_order_bucket(x.status::text, x.price, x.sold_at, x.paid_basis, x.source_type,
                                   x.sale_source_detail, x.mex_tracking_id, x.mex_status_id,
                                   x.mex_cod_mkd, x.mex_delivered_at,
                                   coalesce(x.mex_tracking_id IN (SELECT wc.tr FROM wc), false)) = 'to_pack'
    AND NOT public.insights_excluded8(public.insights_phone8(x.customer_phone), $10)
    AND NOT coalesce(x.mex_tracking_id IN (SELECT tp.tr FROM tp), false)
    AND public.cohort_order_source(x.sale_source, x.sale_source_detail, x.mex_tracking_id, x.dept_override) = ANY ($5)
  UNION ALL
  SELECT 'web', 'web', NULL, NULL, w.shop_order_id, w.created_at, round(w.total)
  FROM public.web_orders w
  WHERE w.deleted_in_shop_at IS NULL
    AND w.mex_tracking_id IS NULL
    AND coalesce(w.total, 0) > 0
    AND w.created_at > $11::timestamp - interval '400 days'
    AND public.web_order_outcome(w.status, w.payment_status, w.payment_method) = 'preparing'
    AND NOT public.insights_excluded8(w.phone8, $10)
    AND 'web' = ANY ($5)
),
qu AS (                    -- the queue: to pack + label printed, with the age of the sale
  SELECT x.*, ($11::date - (x.sale_at AT TIME ZONE 'Europe/Skopje')::date) AS age,
         CASE WHEN ($11::date - (x.sale_at AT TIME ZONE 'Europe/Skopje')::date) <= 2 THEN '0_2'
              WHEN ($11::date - (x.sale_at AT TIME ZONE 'Europe/Skopje')::date) <= 7 THEN '3_7'
              WHEN ($11::date - (x.sale_at AT TIME ZONE 'Europe/Skopje')::date) <= 14 THEN '8_14'
              WHEN ($11::date - (x.sale_at AT TIME ZONE 'Europe/Skopje')::date) <= 30 THEN '15_30'
              ELSE '31_plus' END AS age_key
  FROM (SELECT tk.*, 'to_pack'::text AS stage FROM tk
        UNION ALL
        SELECT lb.kind, lb.source, lb.sale_source, lb.order_id, lb.web_id, lb.sale_at, lb.value_mkd, 'label' FROM lb) x
),
-- ── every item line, once per (lset, flags) ─────────────────────────────────
-- lset: sold (cur / prev, day, source) · returned · to_pack · label. A line is
-- keyed by its text (src, product id, name, web kind, free, impossible qty).
ln AS MATERIALIZED (
  SELECT u.lset, u.cur, u.prev, u.d, u.source,
         CASE WHEN u.kind = 'web' THEN 'web' WHEN u.sale_source = 'collabbox' THEN 'collabbox' ELSE 'crm' END AS src,
         i.product_id AS pid, i.product_name AS nm, NULL::text AS wk,
         (coalesce(i.price_per_unit, 0) <= 0) AS free, (coalesce(i.quantity, 0) >= 100) AS bad,
         coalesce(i.quantity, 0) AS q
  FROM (SELECT 'sold'::text AS lset, sr.cur, sr.prev, sr.d, sr.source, sr.kind, sr.sale_source, sr.order_id FROM sr WHERE sr.kind = 'order'
        UNION ALL SELECT 'returned', false, false, NULL, rt.source, rt.kind, rt.sale_source, rt.order_id FROM rt WHERE rt.kind = 'order'
        UNION ALL SELECT qu.stage, false, false, NULL, qu.source, qu.kind, qu.sale_source, qu.order_id FROM qu WHERE qu.kind = 'order') u
  -- a HASH join on purpose (all of a year's lines; see insights_returns)
  JOIN public.order_items i ON (i.order_id::text) = u.order_id::text
  UNION ALL
  SELECT u.lset, u.cur, u.prev, u.d, u.source, 'web', NULL::uuid, i.name, i.kind,
         (coalesce(i.price, 0) <= 0), (coalesce(i.quantity, 0) >= 100), coalesce(i.quantity, 0)
  FROM (SELECT 'sold'::text AS lset, sr.cur, sr.prev, sr.d, sr.source, sr.web_id FROM sr WHERE sr.kind = 'web'
        UNION ALL SELECT 'returned', false, false, NULL, rt.source, rt.web_id FROM rt WHERE rt.kind = 'web'
        UNION ALL SELECT qu.stage, false, false, NULL, qu.source, qu.web_id FROM qu WHERE qu.kind = 'web') u
  JOIN public.web_order_items i ON i.shop_order_id = u.web_id
),
la AS MATERIALIZED (       -- folded per distinct line text (a few thousand)
  SELECT ln.src, ln.nm, ln.pid, ln.wk, ln.free, ln.bad,
         concat_ws(chr(31), ln.src, coalesce(ln.pid::text, ''), coalesce(ln.nm, ''), coalesce(ln.wk, ''),
                   ln.free::int::text, ln.bad::int::text) AS lkey,
         coalesce(sum(ln.q) FILTER (WHERE ln.lset = 'sold' AND ln.cur), 0)                              AS q_cur,
         count(*) FILTER (WHERE ln.lset = 'sold' AND ln.cur)                                            AS n_cur,
         coalesce(sum(ln.q) FILTER (WHERE ln.lset = 'sold' AND ln.prev), 0)                             AS q_prev,
         coalesce(sum(ln.q) FILTER (WHERE ln.lset = 'sold' AND ln.cur AND ln.source = 'altercpa'), 0)   AS q_alt,
         coalesce(sum(ln.q) FILTER (WHERE ln.lset = 'sold' AND ln.cur AND ln.source = 'elyon_crm'), 0)  AS q_ely,
         coalesce(sum(ln.q) FILTER (WHERE ln.lset = 'sold' AND ln.cur AND ln.source = 'teleshop_out'), 0) AS q_tout,
         coalesce(sum(ln.q) FILTER (WHERE ln.lset = 'sold' AND ln.cur AND ln.source = 'web'), 0)        AS q_web,
         coalesce(sum(ln.q) FILTER (WHERE ln.lset = 'sold' AND ln.cur AND ln.source = 'teleshop_other'), 0) AS q_tel,
         coalesce(sum(ln.q) FILTER (WHERE ln.lset = 'sold' AND ln.cur AND ln.source = 'social'), 0)     AS q_soc,
         coalesce(sum(ln.q) FILTER (WHERE ln.lset = 'returned'), 0)                                     AS q_ret,
         coalesce(sum(ln.q) FILTER (WHERE ln.lset = 'to_pack'), 0)                                      AS q_pack,
         coalesce(sum(ln.q) FILTER (WHERE ln.lset = 'label'), 0)                                        AS q_label
  FROM ln
  GROUP BY ln.src, ln.nm, ln.pid, ln.wk, ln.free, ln.bad
),
cat AS MATERIALIZED (      -- active catalogue names: an unaliased line equal to ONE of them folds into it
  SELECT public.product_alias_norm(p.name) AS norm, min(p.id::text) AS id, count(*) AS n
  FROM public.products p WHERE p.is_active GROUP BY 1
),
lk AS MATERIALIZED (       -- each line text: its product key and kind, computed ONCE
  SELECT x.*,
         CASE WHEN c.id IS NOT NULL THEN 'p:' || c.id ELSE x.k END AS key,
         CASE WHEN x.ak <> 'product'                                     THEN x.ak
              WHEN lower(x.nm) ~ '^\s*(поен|poen)'                        THEN 'loyalty_point'
              WHEN lower(x.nm) ~ '(забелешка|zabeleska|zabeleshka)'       THEN 'note'
              WHEN lower(x.nm) ~ '^\s*(флаер|flaer|flyer)'                THEN 'flyer'
              WHEN lower(x.nm) ~ '^\s*(достава|dostava)'                  THEN 'delivery'
              WHEN x.bad                                                  THEN 'bad_quantity'
              WHEN x.wk = 'GIFT' OR x.free                                THEN 'gift'
              ELSE 'product' END AS lkind
  FROM (SELECT la.*, public.product_key(la.src, la.nm, la.pid) AS k, public.order_line_kind(la.src, la.nm) AS ak
          FROM la) x
  LEFT JOIN cat c ON c.n = 1 AND x.k LIKE 'n:%' AND c.norm = substr(x.k, 3)
),
-- a line's kind by its text key, as ONE jsonb object (a lookup, not a join)
lmap AS MATERIALIZED (
  SELECT coalesce(jsonb_object_agg(lk.lkey, lk.lkind), '{}'::jsonb) AS m FROM lk
),
pg AS MATERIALIZED (       -- per product key: products and gifts (the rest is not a product)
  SELECT lk.key,
         coalesce(sum(lk.q_cur) FILTER (WHERE lk.lkind = 'product'), 0)   AS units,
         coalesce(sum(lk.q_prev) FILTER (WHERE lk.lkind = 'product'), 0)  AS units_prev,
         coalesce(sum(lk.q_alt) FILTER (WHERE lk.lkind = 'product'), 0)   AS u_alt,
         coalesce(sum(lk.q_ely) FILTER (WHERE lk.lkind = 'product'), 0)   AS u_ely,
         coalesce(sum(lk.q_tout) FILTER (WHERE lk.lkind = 'product'), 0)  AS u_tout,
         coalesce(sum(lk.q_web) FILTER (WHERE lk.lkind = 'product'), 0)   AS u_web,
         coalesce(sum(lk.q_tel) FILTER (WHERE lk.lkind = 'product'), 0)   AS u_tel,
         coalesce(sum(lk.q_soc) FILTER (WHERE lk.lkind = 'product'), 0)   AS u_soc,
         coalesce(sum(lk.q_cur) FILTER (WHERE lk.lkind = 'gift'), 0)      AS free_units,
         coalesce(sum(lk.q_ret) FILTER (WHERE lk.lkind IN ('product', 'gift')), 0)   AS returned_units,
         coalesce(sum(lk.q_pack) FILTER (WHERE lk.lkind IN ('product', 'gift')), 0)  AS pack_units,
         coalesce(sum(lk.q_label) FILTER (WHERE lk.lkind IN ('product', 'gift')), 0) AS label_units,
         (array_agg(lk.nm ORDER BY lk.q_cur DESC NULLS LAST, lk.nm))[1]   AS sample
  FROM lk
  WHERE lk.key IS NOT NULL AND lk.lkind IN ('product', 'gift')
  GROUP BY lk.key
),
-- ── the catalogue and its ledger ───────────────────────────────────────────
lgp AS (
  SELECT l.product_id, count(*) AS n_logs,
         count(*) FILTER (WHERE l.movement_type = 'manual_adjust' OR l.reason = 'manual') AS n_adjust,
         max(l.created_at) FILTER (WHERE l.movement_type IN ('manual_adjust', 'bigarena_sync', 'count') OR l.reason IN ('manual', 'bigarena_import', 'stock_count')) AS counted_at,
         max(l.created_at) AS moved_at
  FROM public.inventory_logs l
  GROUP BY l.product_id
),
scl AS (                  -- products a stock count (попис) covered (20260942000100)
  SELECT l.product_id, max(c.counted_at) AS counted_at
  FROM public.stock_count_lines l
  JOIN public.stock_counts c ON c.id = l.count_id
  GROUP BY l.product_id
),
sv2 AS (                  -- Stock v2 (20260945000700): the switch, the approved openings, the last ok ledger run
  SELECT coalesce((SELECT a.value ->> 'enabled' FROM public.app_settings a WHERE a.key = 'stock_v2'), 'false') = 'true' AS enabled,
         -- every active route's warehouse holds an approved opening (and there is one)
         (EXISTS (SELECT 1 FROM public.stock_wh_counts c WHERE c.kind = 'opening' AND c.status = 'approved')
          AND NOT EXISTS (SELECT 1 FROM public.stock_parcel_routes r
                           WHERE r.active AND (r.valid_to IS NULL OR r.valid_to > now())
                             AND NOT EXISTS (SELECT 1 FROM public.stock_wh_counts c
                                              WHERE c.warehouse_id = r.warehouse_id AND c.kind = 'opening' AND c.status = 'approved'))) AS opened,
         (SELECT min(c.counted_at) FROM public.stock_wh_counts c WHERE c.kind = 'opening' AND c.status = 'approved') AS opening_at,
         (SELECT max(c.counted_at) FROM public.stock_wh_counts c WHERE c.status = 'approved') AS last_count_at,
         (SELECT max(r.finished_at) FROM public.stock_runs r WHERE r.status = 'ok' AND NOT coalesce(r.dry, false)) AS last_run
),
rcp AS (                  -- products whose stock_quantity the v2 mirror writes: an approved recipe valid now, not exempt
  SELECT DISTINCT pa.product_id
  FROM public.product_articles pa
  WHERE pa.status = 'approved' AND pa.valid_from <= now() AND (pa.valid_to IS NULL OR pa.valid_to > now())
    AND NOT EXISTS (SELECT 1 FROM public.product_stock_exempt e WHERE e.product_id = pa.product_id)
),
pc AS MATERIALIZED (
  SELECT p.id, p.name, p.sku, p.is_active, p.stock_quantity, p.low_stock_threshold, p.cost_price, p.price,
         -- Stock v2 on: a product is tracked when the mirror writes it (approved recipe); the v1 rules otherwise
         CASE WHEN sv2.enabled THEN rc.product_id IS NOT NULL
              ELSE (coalesce(g.n_logs, 0) > 0 OR coalesce(p.stock_quantity, 0) <> 0 OR s.product_id IS NOT NULL) END AS tracked,
         CASE WHEN sv2.enabled THEN false
              ELSE (p.stock_quantity = 1000 AND g.n_logs = g.n_adjust AND g.n_adjust > 0 AND s.product_id IS NULL) END AS placeholder,
         (coalesce(p.cost_price, 0) > 0) AS cost_known,
         greatest(g.counted_at, s.counted_at) AS counted_at, g.moved_at,
         -- a duplicate candidate key: the first word, transliterated (Adenofrin · ADENOFRIN 20/1 cps)
         CASE WHEN length(public.mk_geo_norm(split_part(btrim(p.name), ' ', 1))) >= 4
              THEN public.mk_geo_norm(split_part(btrim(p.name), ' ', 1)) END AS dup_key
  FROM public.products p
  LEFT JOIN lgp g ON g.product_id = p.id
  LEFT JOIN scl s ON s.product_id = p.id
  LEFT JOIN rcp rc ON rc.product_id = p.id
  CROSS JOIN sv2
),
lg AS (
  SELECT max(l.created_at) FILTER (WHERE l.movement_type IN ('manual_adjust', 'bigarena_sync', 'count') OR l.reason IN ('manual', 'bigarena_import', 'stock_count')) AS last_count_at,
         max(l.created_at) FILTER (WHERE l.movement_type = 'restock' OR l.reason = 'restock')                                               AS last_restock_at,
         max(l.created_at) FILTER (WHERE l.movement_type = 'order_deduction' OR l.reason = 'order_deduction')                               AS last_deduction_at,
         max(l.created_at)                                                                                                                  AS last_move_at,
         coalesce(-sum(l.change_amount) FILTER (WHERE l.created_at BETWEEN $1 AND $2 AND l.change_amount < 0), 0) AS out_window,
         coalesce(sum(l.change_amount) FILTER (WHERE l.created_at BETWEEN $1 AND $2 AND l.change_amount > 0), 0)  AS in_window,
         count(*) FILTER (WHERE l.created_at BETWEEN $1 AND $2)                                                  AS moves_window
  FROM public.inventory_logs l
),
ps AS (                    -- MEX parcels created: in the period, and since the ledger's last deduction
  SELECT count(*) FILTER (WHERE p.created_at_mex BETWEEN $1 AND $2)                      AS in_window,
         count(*) FILTER (WHERE p.created_at_mex > coalesce(lg.last_deduction_at, '-infinity')) AS since_deduction,
         max(p.created_at_mex)                                                           AS last_parcel_at
  FROM lg
  JOIN public.mex_parcels p ON p.created_at_mex >= least($1, coalesce(lg.last_deduction_at, $1))
  WHERE NOT public.insights_excluded8(p.phone8, $10)
),
st AS (                    -- the stock regime = Stock v2 (20260945000700; the v1 count + MEX ledger are retired).
                           -- The keys keep their v1 names for the page: counted_at = the last approved count
                           -- (once every routed warehouse has its opening), mex_enabled = stock_v2.enabled,
                           -- mex_from = the opening, mex_last_run = the last ok stock_v2_apply
  SELECT CASE WHEN sv2.opened THEN sv2.last_count_at END AS counted_at,
         sv2.enabled AS mex_enabled,
         sv2.opening_at AS mex_from,
         sv2.last_run AS mex_last_run
  FROM sv2
),
tr AS (                    -- is the stock worth reading? an approved opening, v2 on, and its last ok run under 60 minutes old
  SELECT (st.counted_at IS NOT NULL AND st.mex_enabled
          AND coalesce(st.mex_last_run >= now() - interval '60 minutes', false)) AS trusted,
         lg.*, ps.in_window AS parcels_window, ps.since_deduction, ps.last_parcel_at,
         st.counted_at, st.mex_enabled, st.mex_from, st.mex_last_run
  FROM lg, ps, st
),
-- ── the product table ──────────────────────────────────────────────────────
pr0 AS (
  SELECT coalesce(g.key, 'p:' || c.id::text) AS key, c.id AS product_id,
         coalesce(c.name, g.sample) AS name, c.sku, c.is_active, (c.id IS NOT NULL) AS catalogue,
         coalesce(c.tracked, false) AS tracked, coalesce(c.placeholder, false) AS placeholder,
         CASE WHEN c.tracked THEN c.stock_quantity END AS on_hand,
         c.low_stock_threshold, c.cost_known, c.cost_price, c.price, c.counted_at,
         coalesce(g.units, 0) AS units, coalesce(g.units_prev, 0) AS units_prev,
         coalesce(g.u_alt, 0) AS u_alt, coalesce(g.u_ely, 0) AS u_ely, coalesce(g.u_tout, 0) AS u_tout,
         coalesce(g.u_web, 0) AS u_web, coalesce(g.u_tel, 0) AS u_tel, coalesce(g.u_soc, 0) AS u_soc,
         coalesce(g.free_units, 0) AS free_units, coalesce(g.returned_units, 0) AS returned_units,
         coalesce(g.pack_units, 0) AS pack_units, coalesce(g.label_units, 0) AS label_units
  FROM pg g
  -- every active catalogue product, plus any inactive one that still sold
  FULL JOIN (SELECT * FROM pc
              WHERE pc.is_active OR 'p:' || pc.id::text IN (SELECT pg.key FROM pg WHERE pg.key LIKE 'p:%')) c
         ON g.key = 'p:' || c.id::text
),
pr1 AS (
  SELECT pr0.*,
         CASE WHEN NOT pr0.catalogue THEN NULL
              WHEN NOT pr0.tracked THEN 'not_tracked'
              WHEN pr0.on_hand <= 0 THEN 'out'
              WHEN pr0.on_hand < coalesce(pr0.low_stock_threshold, 0) THEN 'low'
              ELSE 'ok' END AS state,
         row_number() OVER (ORDER BY pr0.units DESC, pr0.pack_units + pr0.label_units DESC, pr0.name) AS rn
  FROM pr0
),
prj AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'key', p.key, 'product_id', p.product_id, 'name', p.name, 'sku', p.sku,
           'catalogue', p.catalogue, 'tracked', p.tracked, 'placeholder', p.placeholder, 'state', p.state,
           'on_hand', p.on_hand, 'low_threshold', p.low_stock_threshold, 'cost_known', p.cost_known,
           'units', p.units, 'units_prev', CASE WHEN tr0.pf IS NULL THEN NULL ELSE p.units_prev END,
           'by_source', jsonb_build_object('altercpa', p.u_alt, 'elyon_crm', p.u_ely, 'teleshop_out', p.u_tout,
                                           'web', p.u_web, 'teleshop_other', p.u_tel, 'social', p.u_soc),
           'free_units', p.free_units, 'returned_units', p.returned_units,
           'queue_units', p.pack_units + p.label_units, 'pack_units', p.pack_units, 'label_units', p.label_units,
           'days_cover', CASE WHEN tr0.trusted AND p.tracked AND p.units > 0 AND p.on_hand IS NOT NULL
                              THEN round(p.on_hand / (p.units::numeric / tr0.days), 1) END,
           'cost_mkd', CASE WHEN p.cost_known THEN round(p.cost_price * 61.5) END,
           'price_mkd', CASE WHEN p.price > 0 THEN round(p.price * 61.5) END,
           'stock_value_mkd', CASE WHEN tr0.trusted AND p.tracked AND p.cost_known AND p.on_hand > 0
                                   THEN round(p.on_hand * p.cost_price * 61.5) END)
         ORDER BY p.rn), '[]'::jsonb) AS j
  FROM pr1 p
  CROSS JOIN (SELECT tr.trusted, prm.pf, (prm.td - prm.fd + 1) AS days FROM tr, prm) tr0
  -- every catalogue product, and the rest (names not in the catalogue) up to 120 rows
  WHERE p.catalogue OR p.rn <= 120
),
prx AS (                   -- what the 120-row cut left out
  SELECT count(*) AS products, coalesce(sum(p.units), 0) AS units
  FROM pr1 p WHERE NOT p.catalogue AND p.rn > 120
),
-- ── KPIs ───────────────────────────────────────────────────────────────────
kp AS (
  SELECT (SELECT count(*) FROM sr WHERE sr.cur)                          AS sales,
         (SELECT count(*) FROM sr WHERE sr.cur AND sr.kind = 'mex')      AS sales_mex_only,
         (SELECT count(*) FROM sr WHERE sr.prev)                         AS sales_prev,
         (SELECT coalesce(sum(g.units), 0) FROM pg g)                    AS units,
         (SELECT coalesce(sum(g.units_prev), 0) FROM pg g)               AS units_prev,
         (SELECT coalesce(sum(g.free_units), 0) FROM pg g)               AS free_units,
         (SELECT coalesce(sum(g.units), 0) FROM pg g WHERE g.key LIKE 'p:%') AS units_catalogue,
         (SELECT count(*) FROM pg g WHERE g.units > 0)                   AS products_sold,
         (SELECT coalesce(sum(g.returned_units), 0) FROM pg g)           AS returned_units,
         (SELECT count(*) FROM rt)                                       AS returned_parcels,
         (SELECT count(*) FROM rt WHERE rt.kind = 'mex')                 AS returned_mex_only
),
-- ── the queue ──────────────────────────────────────────────────────────────
qa AS (
  SELECT qu.stage, qu.age_key, qu.source,
         count(*) AS n, coalesce(sum(qu.value_mkd), 0) AS v,
         count(*) FILTER (WHERE qu.kind = 'order') AS n_o, count(*) FILTER (WHERE qu.kind = 'web') AS n_w,
         count(*) FILTER (WHERE qu.kind = 'mex') AS n_m,
         min(qu.sale_at) AS oldest, max(qu.age) AS max_age, min(qu.age) AS min_age
  FROM qu
  GROUP BY GROUPING SETS ((qu.stage, qu.age_key), (qu.stage, qu.source), (qu.stage))
),
qj AS (
  SELECT jsonb_agg(jsonb_build_object(
           'stage', s.stage,
           'count', coalesce(t.n, 0), 'value_mkd', round(coalesce(t.v, 0)),
           'orders', coalesce(t.n_o, 0), 'web', coalesce(t.n_w, 0), 'mex_only', coalesce(t.n_m, 0),
           'oldest', to_char((t.oldest AT TIME ZONE 'Europe/Skopje')::date, 'YYYY-MM-DD'),
           'units', (SELECT coalesce(sum(CASE WHEN s.stage = 'to_pack' THEN g.pack_units ELSE g.label_units END), 0) FROM pg g),
           'ages', (SELECT jsonb_agg(jsonb_build_object(
                             'key', a.key, 'count', coalesce(x.n, 0), 'value_mkd', round(coalesce(x.v, 0)),
                             'orders', coalesce(x.n_o, 0), 'web', coalesce(x.n_w, 0), 'mex_only', coalesce(x.n_m, 0),
                             -- the sale days this age covers (for the /orders drill)
                             'from', to_char(CASE WHEN a.hi IS NULL THEN ($11::date - coalesce(x.max_age, a.lo)) ELSE $11::date - a.hi END, 'YYYY-MM-DD'),
                             'to', to_char($11::date - a.lo, 'YYYY-MM-DD'))
                           ORDER BY a.ord)
                    FROM (VALUES ('0_2', 0, 2, 1), ('3_7', 3, 7, 2), ('8_14', 8, 14, 3), ('15_30', 15, 30, 4), ('31_plus', 31, NULL, 5)) a(key, lo, hi, ord)
                    LEFT JOIN qa x ON x.stage = s.stage AND x.age_key = a.key AND x.source IS NULL),
           'by_source', (SELECT coalesce(jsonb_agg(jsonb_build_object('key', x.source, 'count', x.n, 'value_mkd', round(x.v),
                                                                    'orders', x.n_o, 'web', x.n_w, 'mex_only', x.n_m,
                                                                    'oldest', to_char((x.oldest AT TIME ZONE 'Europe/Skopje')::date, 'YYYY-MM-DD'))
                                                   ORDER BY array_position(ARRAY['altercpa', 'elyon_crm', 'teleshop_out', 'teleshop_other', 'social', 'web'], x.source)), '[]'::jsonb)
                         FROM qa x WHERE x.stage = s.stage AND x.source IS NOT NULL AND x.age_key IS NULL))
         ORDER BY s.ord) AS j
  FROM (VALUES ('to_pack', 1), ('label', 2)) s(stage, ord)
  LEFT JOIN qa t ON t.stage = s.stage AND t.age_key IS NULL AND t.source IS NULL
),
-- the products waiting in the queue (units)
qp AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object('key', x.key, 'name', coalesce(c.name, x.sample), 'catalogue', c.id IS NOT NULL,
                                               'pack_units', x.pack_units, 'label_units', x.label_units,
                                               'on_hand', CASE WHEN c.tracked THEN c.stock_quantity END)
                            ORDER BY x.pack_units + x.label_units DESC, x.key), '[]'::jsonb) AS j
  FROM (SELECT g.*, row_number() OVER (ORDER BY g.pack_units + g.label_units DESC, g.key) AS rn
          FROM pg g WHERE g.pack_units + g.label_units > 0) x
  LEFT JOIN pc c ON x.key = 'p:' || c.id::text
  WHERE x.rn <= 20
),
-- ── the trend: product units per day (per month beyond 62 days), by source ──
lt AS (
  SELECT ln.d, ln.source,
         concat_ws(chr(31), ln.src, coalesce(ln.pid::text, ''), coalesce(ln.nm, ''), coalesce(ln.wk, ''),
                   ln.free::int::text, ln.bad::int::text) AS lkey,
         sum(ln.q) AS q
  FROM ln WHERE ln.lset = 'sold' AND ln.cur
  GROUP BY 1, 2, 3
),
tv AS (
  SELECT lt.d,
         sum(lt.q) FILTER (WHERE lt.source = 'altercpa')       AS alt,
         sum(lt.q) FILTER (WHERE lt.source = 'elyon_crm')      AS ely,
         sum(lt.q) FILTER (WHERE lt.source = 'teleshop_out')   AS tout,
         sum(lt.q) FILTER (WHERE lt.source = 'web')            AS web,
         sum(lt.q) FILTER (WHERE lt.source = 'teleshop_other') AS tel,
         sum(lt.q) FILTER (WHERE lt.source = 'social')         AS soc
  FROM lt
  WHERE (SELECT lmap.m FROM lmap) ->> lt.lkey = 'product'
  GROUP BY lt.d
),
tj AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object('d', k.d,
           'units', coalesce(tv.alt, 0) + coalesce(tv.ely, 0) + coalesce(tv.tout, 0) + coalesce(tv.web, 0)
                    + coalesce(tv.tel, 0) + coalesce(tv.soc, 0),
           'by_source', jsonb_build_object('altercpa', coalesce(tv.alt, 0), 'elyon_crm', coalesce(tv.ely, 0),
                                           'teleshop_out', coalesce(tv.tout, 0),
                                           'web', coalesce(tv.web, 0), 'teleshop_other', coalesce(tv.tel, 0), 'social', coalesce(tv.soc, 0)))
         ORDER BY k.d), '[]'::jsonb) AS j
  FROM (SELECT to_char(g, CASE WHEN $9 = 'day' THEN 'YYYY-MM-DD' ELSE 'YYYY-MM' END) AS d
          FROM generate_series(date_trunc($9, $7::timestamp), date_trunc($9, $8::timestamp), ('1 ' || $9)::interval) g) k
  LEFT JOIN tv ON tv.d = k.d
),
-- ── catalogue hygiene ──────────────────────────────────────────────────────
hy AS (
  SELECT jsonb_build_object(
    'duplicates', coalesce((
      SELECT jsonb_agg(jsonb_build_object('key', d.dup_key, 'products', d.products) ORDER BY d.units DESC, d.dup_key)
      FROM (SELECT c.dup_key, sum(coalesce(g.units, 0)) AS units,
                   jsonb_agg(jsonb_build_object('product_id', c.id, 'name', c.name, 'tracked', c.tracked,
                                                'on_hand', CASE WHEN c.tracked THEN c.stock_quantity END,
                                                'units', coalesce(g.units, 0))
                             ORDER BY coalesce(g.units, 0) DESC, c.name) AS products
            FROM pc c LEFT JOIN pg g ON g.key = 'p:' || c.id::text
            WHERE c.is_active AND c.dup_key IS NOT NULL
            GROUP BY c.dup_key HAVING count(*) > 1) d), '[]'::jsonb),
    'unmapped', jsonb_build_object(
      'names', (SELECT count(*) FROM pg g WHERE g.key LIKE 'n:%' AND g.units > 0),
      'units', (SELECT coalesce(sum(g.units), 0) FROM pg g WHERE g.key LIKE 'n:%'),
      'rows', coalesce((SELECT jsonb_agg(jsonb_build_object('name', x.sample, 'units', x.units) ORDER BY x.units DESC, x.sample)
                          FROM (SELECT g.sample, g.units FROM pg g WHERE g.key LIKE 'n:%' AND g.units > 0
                                 ORDER BY g.units DESC, g.sample LIMIT 25) x), '[]'::jsonb)),
    'no_cost', jsonb_build_object(
      'active', (SELECT count(*) FROM pc c WHERE c.is_active AND NOT c.cost_known),
      'selling', (SELECT count(*) FROM pc c JOIN pg g ON g.key = 'p:' || c.id::text WHERE NOT c.cost_known AND g.units > 0),
      'units', (SELECT coalesce(sum(g.units), 0) FROM pc c JOIN pg g ON g.key = 'p:' || c.id::text WHERE NOT c.cost_known),
      'rows', coalesce((SELECT jsonb_agg(jsonb_build_object('product_id', x.id, 'name', x.name, 'units', x.units) ORDER BY x.units DESC, x.name)
                          FROM (SELECT c.id, c.name, g.units FROM pc c JOIN pg g ON g.key = 'p:' || c.id::text
                                 WHERE NOT c.cost_known AND g.units > 0 ORDER BY g.units DESC, c.name LIMIT 15) x), '[]'::jsonb)),
    'not_products', coalesce((SELECT jsonb_agg(jsonb_build_object('kind', x.lkind, 'units', x.u, 'lines', x.n) ORDER BY x.u DESC)
                                FROM (SELECT lk.lkind, sum(lk.q_cur) AS u, sum(lk.n_cur) AS n FROM lk
                                       WHERE lk.lkind NOT IN ('product', 'gift') AND lk.n_cur > 0 GROUP BY 1) x), '[]'::jsonb),
    'not_tracked', (SELECT count(*) FROM pc c WHERE c.is_active AND NOT c.tracked),
    'placeholder', (SELECT count(*) FROM pc c WHERE c.is_active AND c.placeholder),
    'inactive_selling', (SELECT count(*) FROM pc c JOIN pg g ON g.key = 'p:' || c.id::text WHERE NOT c.is_active AND g.units > 0)) AS j
),
-- ── valuation (owners; only when the count can be trusted) ─────────────────
va AS (
  SELECT round(coalesce(sum(c.stock_quantity * c.cost_price) FILTER (WHERE c.cost_known AND c.stock_quantity > 0), 0) * 61.5) AS cost_v,
         round(coalesce(sum(c.stock_quantity * c.price) FILTER (WHERE c.price > 0 AND c.stock_quantity > 0), 0) * 61.5) AS price_v,
         coalesce(sum(c.stock_quantity) FILTER (WHERE c.stock_quantity > 0), 0) AS units_on_hand,
         coalesce(sum(c.stock_quantity) FILTER (WHERE c.stock_quantity > 0 AND c.cost_known), 0) AS units_costed
  FROM pc c WHERE c.is_active AND c.tracked
)
SELECT jsonb_build_object(
  'meta', jsonb_build_object('clock', 'sale', 'granularity', prm.gran, 'money', true, 'sources', to_jsonb(prm.srcs),
                             'today', to_char(prm.today, 'YYYY-MM-DD')),
  'trust', jsonb_build_object(
    'trusted', tr.trusted,
    'last_count', to_char((CASE WHEN tr.mex_enabled THEN tr.counted_at ELSE greatest(tr.last_count_at, tr.counted_at) END
                            AT TIME ZONE 'Europe/Skopje')::date, 'YYYY-MM-DD'),
    'last_restock', to_char((tr.last_restock_at AT TIME ZONE 'Europe/Skopje')::date, 'YYYY-MM-DD'),
    'last_deduction', to_char((tr.last_deduction_at AT TIME ZONE 'Europe/Skopje')::date, 'YYYY-MM-DD'),
    'last_movement', to_char((tr.last_move_at AT TIME ZONE 'Europe/Skopje')::date, 'YYYY-MM-DD'),
    'last_parcel', to_char((tr.last_parcel_at AT TIME ZONE 'Europe/Skopje')::date, 'YYYY-MM-DD'),
    'parcels_since_deduction', tr.since_deduction,
    'ledger_out_window', tr.out_window, 'ledger_in_window', tr.in_window, 'ledger_moves_window', tr.moves_window,
    'parcels_window', tr.parcels_window,
    'counted', tr.counted_at IS NOT NULL,
    'mex_enabled', tr.mex_enabled,
    'mex_from', to_char((tr.mex_from AT TIME ZONE 'Europe/Skopje')::date, 'YYYY-MM-DD'),
    'mex_last_run', to_char(tr.mex_last_run AT TIME ZONE 'Europe/Skopje', 'YYYY-MM-DD"T"HH24:MI')),
  'kpis', jsonb_build_object(
    'sales', kp.sales, 'sales_mex_only', kp.sales_mex_only,
    'units', kp.units, 'units_prev', CASE WHEN prm.pf IS NULL THEN NULL ELSE kp.units_prev END,
    'free_units', kp.free_units, 'units_catalogue', kp.units_catalogue, 'products_sold', kp.products_sold,
    'returned_units', kp.returned_units, 'returned_parcels', kp.returned_parcels, 'returned_mex_only', kp.returned_mex_only,
    'tracked', (SELECT count(*) FROM pc c WHERE c.is_active AND c.tracked),
    'active', (SELECT count(*) FROM pc c WHERE c.is_active),
    'out', CASE WHEN tr.trusted THEN (SELECT count(*) FROM pc c WHERE c.is_active AND c.tracked AND c.stock_quantity <= 0) END,
    'low', CASE WHEN tr.trusted THEN (SELECT count(*) FROM pc c WHERE c.is_active AND c.tracked AND c.stock_quantity > 0
                                                                   AND c.stock_quantity < coalesce(c.low_stock_threshold, 0)) END),
  'queue', (SELECT j FROM qj),
  'queue_products', (SELECT j FROM qp),
  'products', (SELECT j FROM prj),
  'products_more', (SELECT jsonb_build_object('products', prx.products, 'units', prx.units) FROM prx),
  'trend', (SELECT j FROM tj),
  'hygiene', (SELECT j FROM hy),
  'valuation', CASE WHEN tr.trusted THEN (
    SELECT jsonb_build_object('cost_mkd', va.cost_v, 'price_mkd', va.price_v,
                              'coverage', CASE WHEN va.units_on_hand > 0 THEN round(va.units_costed::numeric / va.units_on_hand, 4) END)
    FROM va) END)
FROM prm, tr, kp
  $st$
  INTO v_out
  USING p_from, p_to_end, v_pf, v_pt, v_src, v_lo, v_fd, v_td, v_gran,
        public.report_excluded_phone8s(), (now() AT TIME ZONE 'Europe/Skopje')::date;

  v_out := jsonb_set(v_out, '{meta,has_prev}', to_jsonb(v_pf IS NOT NULL));
  IF coalesce(p_money, false) THEN
    RETURN v_out;
  END IF;
  v_out := public.insights_strip_money(jsonb_set(v_out, '{valuation}', 'null'::jsonb));
  RETURN jsonb_set(v_out, '{meta,money}', 'false'::jsonb);
END;
$function$;

COMMENT ON FUNCTION public.insights_stock(timestamptz, timestamptz, timestamptz, timestamptz, text[], boolean) IS
  'Insights → Products & stock. Trusted stock = Stock v2: every routed warehouse has an approved opening, stock_v2.enabled is on and the last ok stock_v2_apply is under 60 minutes old; quantities = products.stock_quantity (the ledger mirror, products_stock_mirror_refresh). Re-emitted by 20260945000700.';

-- ── 3. products.stock_quantity = the ledger's mirror ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.products_stock_mirror_refresh()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_products int := 0;
  v_changed  int := 0;
  v_t0       timestamptz := clock_timestamp();
BEGIN
  -- Off = preview: the ledger is empty, the mirror would write zeros. Nothing is touched.
  IF coalesce((SELECT a.value ->> 'enabled' FROM public.app_settings a WHERE a.key = 'stock_v2'), 'false') <> 'true' THEN
    RETURN jsonb_build_object('status', 'disabled');
  END IF;
  -- one refresh at a time (the cron, a run, the switch, a recipe change)
  IF NOT pg_try_advisory_xact_lock(hashtextextended('products_stock_mirror_refresh', 0)) THEN
    RETURN jsonb_build_object('status', 'busy');
  END IF;
  PERFORM set_config('elyon.stock_write', 'on', true);

  WITH oh AS MATERIALIZED (
    SELECT o.article_code, sum(o.qty) AS qty
    FROM public.stock_v2_on_hand(now(), 'main', false) o
    GROUP BY o.article_code
  ),
  rl AS (                -- the approved recipe valid now; exempt products never move
    SELECT pa.product_id, pa.article_code, pa.qty, pa.role
    FROM public.product_articles pa
    WHERE pa.status = 'approved' AND pa.qty > 0
      AND pa.valid_from <= now() AND (pa.valid_to IS NULL OR pa.valid_to > now())
      AND NOT EXISTS (SELECT 1 FROM public.product_stock_exempt e WHERE e.product_id = pa.product_id)
  ),
  rs AS (                -- what a sale needs: the non-gift lines, or every line of a gift-only product
    SELECT rl.* FROM rl
    WHERE rl.role <> 'gift'
       OR NOT EXISTS (SELECT 1 FROM rl r2 WHERE r2.product_id = rl.product_id AND r2.role <> 'gift')
  ),
  want AS (              -- a single article → its on-hand; a bundle → how many complete bundles the shelf makes
    SELECT rs.product_id,
           greatest(least(floor(min(coalesce(oh.qty, 0) / rs.qty)), 2000000000), -2000000000)::int AS q
    FROM rs
    LEFT JOIN oh ON oh.article_code = rs.article_code
    GROUP BY rs.product_id
  ),
  upd AS (
    UPDATE public.products p
       SET stock_quantity = w.q
      FROM want w
     WHERE p.id = w.product_id
       AND p.stock_quantity IS DISTINCT FROM w.q
    RETURNING p.id
  )
  SELECT (SELECT count(*) FROM want), (SELECT count(*) FROM upd) INTO v_products, v_changed;

  RETURN jsonb_build_object('status', 'ok', 'warehouse', 'main', 'products', v_products, 'changed', v_changed,
                            'ms', round(extract(epoch FROM clock_timestamp() - v_t0) * 1000));
END
$fn$;

COMMENT ON FUNCTION public.products_stock_mirror_refresh() IS
  'Stock v2: products.stock_quantity = the ledger on-hand at warehouse main now (stock_v2_on_hand(now(), ''main'', false)) for every product with an approved recipe valid now and not exempt — floor(min(on_hand / line qty)); untouched otherwise. Only while stock_v2.enabled. cron stock-v2-mirror + the api. Migration 20260945000700.';

REVOKE ALL ON FUNCTION public.products_stock_mirror_refresh() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.products_stock_mirror_refresh() TO service_role;

-- ── 4. the guard: products.stock_quantity only under elyon.stock_write ──────────────────────────────
CREATE OR REPLACE FUNCTION public.tg_products_stock_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF coalesce(NEW.stock_quantity, 0) = 0 THEN
      RETURN NEW;                       -- a new product starts at 0 (the column default)
    END IF;
  ELSIF NEW.stock_quantity IS NOT DISTINCT FROM OLD.stock_quantity THEN
    RETURN NEW;
  END IF;
  IF coalesce(current_setting('elyon.stock_write', true), '') <> 'on' THEN
    RAISE EXCEPTION 'products.stock_quantity is derived from the Stock v2 ledger — written only by products_stock_mirror_refresh()'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION public.tg_products_stock_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_products_stock_guard ON public.products;
CREATE TRIGGER trg_products_stock_guard
  BEFORE INSERT OR UPDATE OF stock_quantity ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.tg_products_stock_guard();

-- ── 5. the mirror every 15 minutes (off: one settings read) ────────────────────────────────────────
DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'stock-v2-mirror') THEN
    PERFORM cron.unschedule('stock-v2-mirror');
  END IF;
END
$cron$;

SELECT cron.schedule(
  'stock-v2-mirror',
  '14,29,44,59 * * * *',
  $job$SELECT public.products_stock_mirror_refresh();$job$
);

COMMIT;

NOTIFY pgrst, 'reload schema';
