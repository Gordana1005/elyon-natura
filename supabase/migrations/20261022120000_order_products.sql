-- ============================================================================
-- order_products — WHICH CATALOGUE PRODUCTS AN ORDER HOLDS (owner 22.10.2026)
--
-- Owner: "да ги филтрираме и според продукт клиентите … и во самиот /orders каде што би можеле да
-- одбереме пример Urofix, и да ни ги покаже сите порачки кои содржат Urofix".
--
-- An order's products live in order_items (≈ 717k lines on 373k orders); orders.product_id /
-- product_name is only a header (the first product) and must never be filtered on. 49k lines carry
-- no product_id, only a name ("UROFIX BIONATURAL 30/1") that a REVIEWED alias folds onto the
-- catalogue — the same folding Insights uses (product_key / order_line_kind, 20260940000000; the
-- source is 'collabbox' for a collabBox order, else 'crm', as insights_sales does).
--
-- One row per (order, catalogue product):
--   gift_only  every line of that product in the order is a gift — the line's reviewed kind is
--              'gift', the product's kind is 'gift', or the line is priced 0 while ANOTHER line of
--              the same order is priced (an import with no per-line prices stays a purchase:
--              7.664 orders have only 0-priced lines).
-- Lines whose reviewed kind is delivery / loyalty_point / note / flyer, and synthetic names
-- (is_synthetic_product_name, the collabBox "без ставки" placeholder) never make a row.
--
-- A NEW table: orders is never written here (no updated_at bump, no orders trigger fires).
-- Kept by order_products_sync(ids):
--   · statement-level triggers on order_items (INSERT / UPDATE / DELETE, transition tables) — one
--     sync per statement for the touched orders; a failure is a WARNING, never a failed order write
--   · pg_cron 'order-products-nightly' (04:40 Skopje): the whole table (new aliases, product kinds,
--     a swallowed trigger failure)
-- Readers: GET /orders (the Производ filter: an inner embed `op:order_products!inner()`), the
-- Assigner (assigner_product_buyers, 20261022120100). RLS on, no policy: service role only.
-- Backfill: scripts/backfill-order-products.mjs · proof: scripts/verify-order-products.mjs
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS public.order_products (
  order_id   uuid    NOT NULL REFERENCES public.orders(id)   ON DELETE CASCADE,
  product_id uuid    NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  gift_only  boolean NOT NULL DEFAULT false,
  PRIMARY KEY (order_id, product_id)
);

CREATE INDEX IF NOT EXISTS order_products_product_idx ON public.order_products (product_id, order_id);

COMMENT ON TABLE public.order_products IS
  'The catalogue products an order holds (one row per order × product), from order_items: the line''s product_id, else a reviewed alias (product_key, source collabbox | crm); delivery / loyalty / note / flyer lines and synthetic names dropped; gift_only = every line of it is a gift. Kept by order_products_sync() (order_items triggers + the nightly pass). Read by GET /orders (Производ) and the Assigner. 20261022120000. Service role only.';

ALTER TABLE public.order_products ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.order_products FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.order_products TO service_role;

-- ── the sync ────────────────────────────────────────────────────────────────
-- p_order_ids NULL = every order (the nightly pass); else exactly those orders. Writes only the
-- difference: rows no longer held are deleted, new ones inserted, a changed gift_only updated.
-- Returns {orders, deleted, inserted, updated}.
CREATE OR REPLACE FUNCTION public.order_products_sync(p_order_ids uuid[] DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
SET work_mem = '64MB'
AS $fn$
DECLARE
  v_all boolean := p_order_ids IS NULL;
  v_del integer := 0;
  v_ins integer := 0;
  v_upd integer := 0;
BEGIN
  IF NOT v_all AND cardinality(p_order_ids) = 0 THEN
    RETURN jsonb_build_object('orders', 0, 'deleted', 0, 'inserted', 0, 'updated', 0);
  END IF;

  -- ONE statement (no temp table: this runs on every order_items write): what the orders should
  -- hold, then the difference — rows no longer held go, the rest is an upsert that touches a row
  -- only when it is new or its gift_only changed.
  WITH l AS MATERIALIZED (
    SELECT oi.order_id,
           CASE WHEN o.sale_source = 'collabbox' THEN 'collabbox' ELSE 'crm' END AS src,
           oi.product_id AS pid,
           oi.product_name AS name,
           (coalesce(oi.total_price, 0) <> 0 OR coalesce(oi.price_per_unit, 0) <> 0) AS priced
    FROM public.order_items oi
    JOIN public.orders o ON o.id = oi.order_id
    WHERE (v_all OR oi.order_id = ANY (p_order_ids))
      AND NOT public.is_synthetic_product_name(oi.product_name)
      AND oi.product_name IS DISTINCT FROM 'collabBox: без ставки (непознат производ)'
  ),
  -- the reviewed kind and the folded product once per distinct (source, name), never per line
  d AS MATERIALIZED (
    SELECT x.src, x.name,
           public.order_line_kind(x.src, x.name) AS kind,
           (SELECT a.product_id
              FROM public.product_aliases a
             WHERE a.source IN (x.src, 'any')
               AND a.alias_norm = public.product_alias_norm(x.name)
               AND a.product_id IS NOT NULL
             ORDER BY (a.source = x.src) DESC
             LIMIT 1) AS alias_pid
    FROM (SELECT DISTINCT l.src, l.name FROM l) x
  ),
  r AS (
    SELECT l.order_id,
           coalesce(l.pid, d.alias_pid) AS product_id,
           (d.kind = 'gift'
            OR coalesce(p.kind = 'gift', false)
            OR (NOT l.priced AND bool_or(l.priced) OVER (PARTITION BY l.order_id))) AS gift
    FROM l
    JOIN d ON d.src = l.src AND d.name = l.name
    LEFT JOIN public.products p ON p.id = coalesce(l.pid, d.alias_pid)
    WHERE d.kind NOT IN ('delivery', 'loyalty_point', 'note', 'flyer')
  ),
  want AS MATERIALIZED (
    SELECT r.order_id, r.product_id, bool_and(r.gift) AS gift_only
    FROM r
    WHERE r.product_id IS NOT NULL
    GROUP BY r.order_id, r.product_id
  ),
  del AS (
    DELETE FROM public.order_products op
     WHERE (v_all OR op.order_id = ANY (p_order_ids))
       AND NOT EXISTS (SELECT 1 FROM want w WHERE w.order_id = op.order_id AND w.product_id = op.product_id)
    RETURNING 1
  ),
  ups AS (
    INSERT INTO public.order_products AS op (order_id, product_id, gift_only)
    SELECT w.order_id, w.product_id, w.gift_only FROM want w
    ON CONFLICT (order_id, product_id) DO UPDATE SET gift_only = EXCLUDED.gift_only
       WHERE op.gift_only IS DISTINCT FROM EXCLUDED.gift_only
    RETURNING (op.xmax = 0) AS inserted
  )
  SELECT (SELECT count(*) FROM del),
         (SELECT count(*) FILTER (WHERE inserted) FROM ups),
         (SELECT count(*) FILTER (WHERE NOT inserted) FROM ups)
    INTO v_del, v_ins, v_upd;

  RETURN jsonb_build_object(
    'orders',   CASE WHEN v_all THEN NULL ELSE cardinality(p_order_ids) END,
    'deleted',  v_del,
    'inserted', v_ins,
    'updated',  v_upd);
END;
$fn$;

COMMENT ON FUNCTION public.order_products_sync(uuid[]) IS
  'Brings order_products in line with order_items for the given orders (NULL = every order): deletes rows no longer held, inserts new ones, updates a changed gift_only. Returns {orders, deleted, inserted, updated}. 20261022120000. Service role only.';

-- ── the triggers on order_items ─────────────────────────────────────────────
-- One sync per statement for the orders it touched. An UPDATE that changes nothing a row depends
-- on (quantity, updated_at) syncs nothing. A failing sync never fails the order write: it is a
-- WARNING and the nightly pass repairs it.
CREATE OR REPLACE FUNCTION public.tg_order_items_order_products()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_ids uuid[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT array_agg(DISTINCT n.order_id) INTO v_ids FROM new_rows n;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT array_agg(DISTINCT o.order_id) INTO v_ids FROM old_rows o;
  ELSE
    SELECT array_agg(DISTINCT z.order_id) INTO v_ids
      FROM (SELECT n.order_id
              FROM new_rows n JOIN old_rows o ON o.id = n.id
             WHERE (n.order_id, n.product_id, n.product_name, n.price_per_unit, n.total_price)
                   IS DISTINCT FROM (o.order_id, o.product_id, o.product_name, o.price_per_unit, o.total_price)
            UNION
            SELECT o.order_id
              FROM new_rows n JOIN old_rows o ON o.id = n.id
             WHERE n.order_id IS DISTINCT FROM o.order_id) z;
  END IF;

  IF v_ids IS NOT NULL THEN
    BEGIN
      PERFORM public.order_products_sync(v_ids);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'order_products_sync failed for % orders: %', cardinality(v_ids), SQLERRM;
    END;
  END IF;
  RETURN NULL;
END;
$fn$;

DROP TRIGGER IF EXISTS order_items_order_products_ins ON public.order_items;
DROP TRIGGER IF EXISTS order_items_order_products_upd ON public.order_items;
DROP TRIGGER IF EXISTS order_items_order_products_del ON public.order_items;

CREATE TRIGGER order_items_order_products_ins
  AFTER INSERT ON public.order_items
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.tg_order_items_order_products();

CREATE TRIGGER order_items_order_products_upd
  AFTER UPDATE ON public.order_items
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.tg_order_items_order_products();

CREATE TRIGGER order_items_order_products_del
  AFTER DELETE ON public.order_items
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.tg_order_items_order_products();

-- ── the nightly pass ────────────────────────────────────────────────────────
-- pg_cron at 02:40 and 03:40 UTC, self-gated to 04:40 Skopje (after the segment recompute and the
-- buyer departments, before the floor opens). _force = run now.
CREATE OR REPLACE FUNCTION public.order_products_nightly(_force boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF NOT _force AND extract(hour FROM now() AT TIME ZONE 'Europe/Skopje') <> 4 THEN
    RETURN jsonb_build_object('skipped', 'not 04:00 Skopje');
  END IF;
  RETURN public.order_products_sync(NULL);
END;
$fn$;

COMMENT ON FUNCTION public.order_products_nightly(boolean) IS
  'pg_cron ''order-products-nightly'' (40 2,3 * * * UTC, self-gated to 04:40 Skopje): order_products_sync(NULL) — picks up new aliases, product kinds and any swallowed trigger failure. 20261022120000.';

REVOKE ALL ON FUNCTION public.order_products_sync(uuid[])          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.order_products_nightly(boolean)       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tg_order_items_order_products()       FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.order_products_sync(uuid[])        TO service_role;
GRANT EXECUTE ON FUNCTION public.order_products_nightly(boolean)    TO service_role;

DO $g$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    EXECUTE 'GRANT SELECT ON public.order_products TO supabase_read_only_user';
  END IF;
END $g$;

DO $cron$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'order-products-nightly';
END
$cron$;

SELECT cron.schedule(
  'order-products-nightly',
  '40 2,3 * * *',
  $job$SELECT public.order_products_nightly();$job$
);

COMMIT;

NOTIFY pgrst, 'reload schema';
