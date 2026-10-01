-- ============================================================================
-- STOCK v2 — integration readers (docs/STOCK-V2.md "Integration notes"; JSON shapes in
-- src/lib/stockV2Types.ts). Two read-only functions the UI / profit workstreams asked for:
--
--   stock_v2_counts(warehouse, limit, money) → StockCountHistoryRow[]
--       GET /api/stock/v2/counts — the count history of one warehouse (or all), newest
--       first: kind, source, status, packed_counted, how many lines, the unit difference
--       Σ(counted − system_qty_at_save), its value at each article's cost at the count time
--       (only with p_money — the api passes is_business_owner()), the note, who saved /
--       approved it and when, the void reason. Unknown warehouse → {ok:false, error}.
--
--   stock_v2_product_overview() → [{product_id, recipe_status, cost_mkd}]
--       GET /api/products/catalogue (owners) — per product: the recipe status
--       (exempt > approved > proposed > none, lines valid now or later) and the current
--       COMPLETE purchase cost from product_cost_history (null when the current interval is
--       incomplete or there is none; an exempt product costs 0). Only products that have
--       something are listed; the api defaults the rest to 'none' / null. One jsonb value,
--       so PostgREST's row cap never truncates it.
--
-- Both: SECURITY DEFINER, search_path = public, EXECUTE for service_role (and the read-only
-- harness). Nothing is written. Needs 20260945000100 (tables) and 20260945000400
-- (stock_v2_cost_at). Safe to apply before or after 20260945000600 / 0700.
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '10s';

DO $dep$
BEGIN
  IF to_regclass('public.stock_wh_counts') IS NULL
     OR to_regclass('public.stock_wh_count_lines') IS NULL
     OR to_regclass('public.product_articles') IS NULL
     OR to_regclass('public.product_stock_exempt') IS NULL
     OR to_regclass('public.product_cost_history') IS NULL THEN
    RAISE EXCEPTION 'stock v2 readers: apply 20260945000100 first';
  END IF;
  IF to_regprocedure('public.stock_v2_cost_at(text, timestamptz)') IS NULL THEN
    RAISE EXCEPTION 'stock v2 readers: apply 20260945000400 first (stock_v2_cost_at)';
  END IF;
END
$dep$;

-- ── 1. the count history ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.stock_v2_counts(
  p_warehouse text    DEFAULT NULL,
  p_limit     integer DEFAULT 50,
  p_money     boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_code  text    := nullif(lower(btrim(coalesce(p_warehouse, ''))), '');
  v_wh    smallint;
  v_limit integer := greatest(1, least(coalesce(p_limit, 50), 500));
  v_money boolean := coalesce(p_money, false);
  v_out   jsonb;
BEGIN
  IF v_code IS NOT NULL THEN
    SELECT w.id INTO v_wh FROM public.stock_warehouses w WHERE w.code = v_code;
    IF v_wh IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'unknown_warehouse'); END IF;
  END IF;

  WITH c AS MATERIALIZED (
    SELECT k.id, k.counted_at, k.kind, k.source, k.status, k.packed_counted, k.note, k.created_by, k.created_at,
           k.approved_by, k.approved_at, k.void_reason, w.code AS wh_code
      FROM public.stock_wh_counts k
      JOIN public.stock_warehouses w ON w.id = k.warehouse_id
     WHERE v_wh IS NULL OR k.warehouse_id = v_wh
     ORDER BY k.counted_at DESC, k.created_at DESC, k.id
     LIMIT v_limit
  ),
  l AS (
    SELECT cl.count_id,
           count(*) AS n,
           -- what the count changes, in units: Σ(counted − what the system showed at the save)
           CASE WHEN count(cl.system_qty_at_save) = 0 THEN NULL
                ELSE round(sum(cl.counted_qty - cl.system_qty_at_save), 3) END AS diff,
           -- its value at each article's cost at the count time (owners); 0 when nothing differs,
           -- null when the differing articles carry no cost
           CASE WHEN v_money THEN
             CASE WHEN count(*) FILTER (WHERE cl.counted_qty IS DISTINCT FROM cl.system_qty_at_save) = 0 THEN 0::numeric
                  ELSE round(sum(CASE WHEN cl.counted_qty IS DISTINCT FROM cl.system_qty_at_save
                                      THEN (cl.counted_qty - cl.system_qty_at_save)
                                           * public.stock_v2_cost_at(cl.article_code, c.counted_at) END), 2)
             END
           END AS val
      FROM public.stock_wh_count_lines cl
      JOIN c ON c.id = cl.count_id
     GROUP BY cl.count_id
  )
  SELECT coalesce(jsonb_agg(
           jsonb_build_object(
             'id', c.id,
             'warehouse', c.wh_code,
             'counted_at', c.counted_at,
             'kind', c.kind,
             'source', c.source,
             'status', c.status,
             'packed_counted', c.packed_counted,
             'lines', coalesce(l.n, 0),
             'diff_units', l.diff,
             'note', c.note,
             'created_by_name', cb.name,
             'created_at', c.created_at,
             'approved_by_name', ab.name,
             'approved_at', c.approved_at,
             'void_reason', c.void_reason)
           || CASE WHEN v_money THEN jsonb_build_object('value_diff_mkd', l.val) ELSE '{}'::jsonb END
           ORDER BY c.counted_at DESC, c.created_at DESC, c.id), '[]'::jsonb)
    INTO v_out
    FROM c
    LEFT JOIN l ON l.count_id = c.id
    LEFT JOIN LATERAL (SELECT coalesce(nullif(btrim(p.full_name), ''), p.email) AS name
                         FROM public.profiles p WHERE p.user_id = c.created_by LIMIT 1) cb ON true
    LEFT JOIN LATERAL (SELECT coalesce(nullif(btrim(p.full_name), ''), p.email) AS name
                         FROM public.profiles p WHERE p.user_id = c.approved_by LIMIT 1) ab ON true;

  RETURN v_out;
END
$fn$;

COMMENT ON FUNCTION public.stock_v2_counts(text, integer, boolean) IS
  'GET stock/v2/counts (owners · admin · manager · warehouse) → StockCountHistoryRow[]: the counts of one warehouse (NULL = every warehouse), newest first, ≤ 500 — kind, source, status, packed_counted, lines, diff_units = Σ(counted − system_qty_at_save), value_diff_mkd (only with p_money: the difference × stock_v2_cost_at at the count time; 0 when nothing differs), note, created / approved by (profile name) and when, void_reason. Unknown warehouse → {ok:false, error:unknown_warehouse}. Read-only. Migration 20260945000510.';

-- ── 2. the recipe status and current cost of every product (the /products catalogue) ──
CREATE OR REPLACE FUNCTION public.stock_v2_product_overview()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  WITH ex AS (
    SELECT e.product_id FROM public.product_stock_exempt e
  ),
  rl AS (            -- the recipe lines valid now or later (rejected lines never count)
    SELECT pa.product_id,
           bool_or(pa.status = 'approved') AS approved,
           bool_or(pa.status = 'proposed') AS proposed
      FROM public.product_articles pa
     WHERE pa.status IN ('approved', 'proposed')
       AND (pa.valid_to IS NULL OR pa.valid_to > now())
     GROUP BY pa.product_id
  ),
  ch AS (            -- the cost interval holding now: its cost only when complete
    SELECT DISTINCT ON (h.product_id) h.product_id, CASE WHEN h.complete THEN h.cost_mkd END AS cost_mkd
      FROM public.product_cost_history h
     WHERE h.valid_from <= now() AND (h.valid_to IS NULL OR h.valid_to > now())
     ORDER BY h.product_id, h.valid_from DESC
  ),
  ids AS (
    SELECT ex.product_id FROM ex UNION SELECT rl.product_id FROM rl UNION SELECT ch.product_id FROM ch
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'product_id', ids.product_id,
           'recipe_status', CASE WHEN ex.product_id IS NOT NULL THEN 'exempt'
                                 WHEN rl.approved THEN 'approved'
                                 WHEN rl.proposed THEN 'proposed'
                                 ELSE 'none' END,
           'cost_mkd', CASE WHEN ex.product_id IS NOT NULL THEN coalesce(ch.cost_mkd, 0) ELSE ch.cost_mkd END)
           ORDER BY ids.product_id), '[]'::jsonb)
    FROM ids
    LEFT JOIN ex ON ex.product_id = ids.product_id
    LEFT JOIN rl ON rl.product_id = ids.product_id
    LEFT JOIN ch ON ch.product_id = ids.product_id;
$fn$;

COMMENT ON FUNCTION public.stock_v2_product_overview() IS
  'GET products/catalogue (owners): [{product_id, recipe_status, cost_mkd}] for every product with an exemption, a recipe line valid now or later, or a cost interval — recipe_status exempt > approved > proposed > none; cost_mkd = the current product_cost_history interval when complete (денари without VAT), else null; an exempt product 0. The api defaults every other product to none / null. Read-only, OWNERS ONLY through the api. Migration 20260945000510.';

-- ── 3. grants ───────────────────────────────────────────────────────────────
DO $grants$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.stock_v2_counts(text, integer, boolean)', 'public.stock_v2_product_overview()']
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
