-- ============================================================================
-- STOCK v2 — 2/5: the parcel resolver (contract docs/STOCK-V2.md "SQL functions")
--
-- What a MEX parcel holds, in articles, and where it leaves from / comes back to.
--
-- stock_v2_parcel_lines(p_from, p_to) — one row per resolved line of every parcel
-- in scope (created in [p_from, p_to), or status 7 and returned in it; p_from NULL
-- = the first active route's valid_from = the opening 22.09.2026 00:00 Skopje).
-- ONE source per parcel, tried in order:
--   0. a test phone (report_excluded_phone8s(): the parcel's phone, the claiming web
--      order's or a holding order's) → line_state test_phone, nothing moves;
--      an active override 'exclude' → excluded;
--   1. an active override 'lines' (payload.lines = [{code, qty}]);
--   2. the collabBox document doc_number = tracking_id: not storno, lines_complete,
--      at least one goods line with qty > 0 (a vanished document still counts —
--      its lines are the best evidence of what was packed — and is flagged
--      provisional);
--   3. the live web order that claims the parcel (web_orders.mex_tracking_id);
--   4. the union of the real (non-disposition) orders holding it — the order naming
--      it, or the register's link (mex_parcels.order_id);
--   5. otherwise no_lines (why 'waiting' while the parcel is under 2 days old).
-- A goods line becomes article(s), first match wins:
--   collabBox: approved alias collabbox_code → stock_articles.code = code →
--              alias collabbox_name → alias name_any → the line's product_id;
--   web:       alias web_sku → alias web_product (shop product id) → alias
--              name_any → the CRM product (reviewed product_aliases, else the one
--              active catalogue product of that name);
--   CRM:       alias name_any → order_items.product_id (else the reviewed alias /
--              the one catalogue name);
--   override:  stock_articles.code = code.
-- A CRM product moves stock only through its APPROVED recipe (product_articles,
-- valid at the parcel's creation) — exempt products (product_stock_exempt) are
-- not_stock, a product with no approved recipe is unmapped (no_recipe). A kit
-- article (is_set with stock_article_kits rows) is expanded into its components.
-- Gifts (0-value collabBox goods lines, web GIFT / 0-price lines, 0-price CRM
-- items) ARE deducted (why = 'gift'), unless stock_v2.free_units = 'skip'.
-- Not stock: collabBox delivery / marker / note lines, ПОЕН / ЗАБЕЛЕШКА / ФЛАЕР /
-- ДОСТАВА by name, a reviewed product_aliases kind, an alias of kind not_stock,
-- qty ≤ 0. Review (unmapped): qty ≥ 100 (bad_quantity), unknown_code, no_product,
-- no_recipe.
--
-- stock_v2_parcels(p_from, p_to) — one verdict per parcel: its route (the lowest
-- priority active route into a tracked warehouse whose filters match and whose
-- window holds the creation time; the return route is the one valid at
-- returned_at), state (test_phone · excluded · pre_opening · no_route · moved ·
-- partial · unmapped · waiting_lines · no_lines), flags (provisional ·
-- override_<action> · stale_label · possible_relabel · return_no_route), units,
-- the article quantities {code: qty} and the review list. out_at / ret_at /
-- unpack_at say which ledger events the parcel asks for (stock_v2_desired, 0300).
--
-- p_to is an extension of the contract's (p_from) signature (DEFAULT NULL = no end)
-- so a day report resolves only that day's parcels. Read-only; EXECUTE for
-- service_role (+ supabase_read_only_user for the verify script).
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '10s';

DO $dep$
BEGIN
  IF to_regclass('public.stock_moves') IS NULL
     OR to_regprocedure('public.report_excluded_phone8s()') IS NULL
     OR to_regprocedure('public.insights_phone8(text)') IS NULL
     OR to_regprocedure('public.product_key(text, text, uuid)') IS NULL
     OR to_regprocedure('public.order_line_kind(text, text)') IS NULL
     OR to_regprocedure('public.product_alias_norm(text)') IS NULL THEN
    RAISE EXCEPTION 'stock v2 resolver: apply 20260945000100 (and the product alias / report helpers) first';
  END IF;
END
$dep$;

-- ── 0. small helpers ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.stock_v2_num(p_text text)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE WHEN btrim(coalesce(p_text, '')) ~ '^-?[0-9]+(\.[0-9]+)?$' THEN btrim(p_text)::numeric END
$$;

COMMENT ON FUNCTION public.stock_v2_num(text) IS
  'A quantity out of jsonb text → numeric; NULL for anything else, never raises. Migration 20260945000200.';

CREATE OR REPLACE FUNCTION public.stock_v2_settings()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT '{"enabled": false, "free_units": "deduct", "stale_label_days": 14, "relabel_window_days": 3,
           "sigma": {"ingest": false, "apply_on_ingest": true, "costs_follow": false},
           "profit": {"cost_source": "legacy", "extra_goods": false}}'::jsonb
         || coalesce((SELECT CASE WHEN jsonb_typeof(a.value) = 'object' THEN a.value END
                        FROM public.app_settings a WHERE a.key = 'stock_v2'), '{}'::jsonb)
$$;

COMMENT ON FUNCTION public.stock_v2_settings() IS
  'app_settings.stock_v2 over its defaults (enabled false, free_units deduct, stale_label_days 14, relabel_window_days 3, sigma{…}, profit{…}). Migration 20260945000200.';

CREATE OR REPLACE FUNCTION public.stock_v2_enabled()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(public.stock_v2_settings() ->> 'enabled', 'false') = 'true'
$$;

CREATE OR REPLACE FUNCTION public.stock_v2_scope_from()
RETURNS timestamptz
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT coalesce((SELECT min(r.valid_from) FROM public.stock_parcel_routes r WHERE r.active),
                  '2026-09-22 00:00:00+02'::timestamptz)
$$;

COMMENT ON FUNCTION public.stock_v2_scope_from() IS
  'Where the parcel ledger starts: the earliest active route''s valid_from (seeded 2026-09-22 00:00 Skopje — the morning count, owner 01.10.2026). Migration 20260945000200.';

CREATE OR REPLACE FUNCTION public.stock_v2_alias_key(p_source text, p_text text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE WHEN p_source IN ('collabbox_code', 'web_sku', 'web_product')
              THEN nullif(upper(btrim(coalesce(p_text, ''))), '')
              ELSE nullif(public.product_alias_norm(p_text), '') END
$$;

COMMENT ON FUNCTION public.stock_v2_alias_key(text, text) IS
  'The normalised key of a stock_article_aliases row: codes / SKUs / shop product ids upper-trimmed, names through product_alias_norm(). Migration 20260945000200.';

CREATE OR REPLACE FUNCTION public.stock_v2_wh(p_code text)
RETURNS smallint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT w.id FROM public.stock_warehouses w WHERE w.code = lower(btrim(coalesce(p_code, '')))
$$;

-- ── 1. the lines of every parcel ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.stock_v2_parcel_lines(p_from timestamptz DEFAULT NULL, p_to timestamptz DEFAULT NULL)
RETURNS TABLE (
  tracking_id  text,
  lines_source text,
  provisional  boolean,
  article_code text,
  qty          numeric,
  line_state   text,
  line_code    text,
  line_name    text,
  product_id   uuid,
  why          text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET work_mem = '64MB'
SET jit = off
AS $lines$
WITH
prm AS MATERIALIZED (
  SELECT coalesce(p_from, public.stock_v2_scope_from()) AS f,
         coalesce(p_to, 'infinity'::timestamptz) AS t,
         public.report_excluded_phone8s() AS tp,
         coalesce(public.stock_v2_settings() ->> 'free_units', 'deduct') = 'skip' AS skip_free
),
sc AS MATERIALIZED (       -- the parcels in scope
  SELECT p.tracking_id AS tr, p.created_at_mex AS cat, p.order_id AS reg_order,
         coalesce(p.phone8 = ANY (prm.tp), false) AS test
  FROM public.mex_parcels p
  CROSS JOIN prm
  WHERE (p.created_at_mex >= prm.f AND p.created_at_mex < prm.t)
     OR (p.status_id = 7 AND p.returned_at >= prm.f AND p.returned_at < prm.t)
),
ov AS MATERIALIZED (
  SELECT o.tracking_id AS tr, o.action, o.payload
  FROM public.stock_parcel_overrides o
  WHERE o.active AND o.tracking_id IN (SELECT sc.tr FROM sc)
),
cb AS MATERIALIZED (       -- 2. the collabBox document of the parcel
  SELECT d.doc_number AS tr, d.payload -> 'lines' AS lines, d.vanished_at IS NOT NULL AS vanished
  FROM public.collabbox_documents d
  WHERE d.doc_number IN (SELECT sc.tr FROM sc)
    AND NOT d.is_storno
    AND d.lines_complete
    AND jsonb_typeof(d.payload -> 'lines') = 'array'
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(d.payload -> 'lines') e
                 WHERE e ->> 'role' = 'goods' AND public.stock_v2_num(e ->> 'qty') > 0)
),
wo AS MATERIALIZED (       -- 3. the live web order claiming it
  SELECT DISTINCT ON (w.mex_tracking_id) w.mex_tracking_id AS tr, w.shop_order_id,
         coalesce(w.phone8 = ANY (prm.tp), false) AS test
  FROM public.web_orders w
  CROSS JOIN prm
  WHERE w.mex_tracking_id IN (SELECT sc.tr FROM sc) AND w.deleted_in_shop_at IS NULL
  ORDER BY w.mex_tracking_id, w.created_at DESC, w.shop_order_id DESC
),
oo AS MATERIALIZED (       -- 4. every real order holding it
  SELECT DISTINCT x.tr, x.oid, x.asrc, x.test
  FROM (SELECT sc.tr, o.id AS oid, o.sale_source_detail AS det,
               CASE WHEN o.sale_source = 'collabbox' THEN 'collabbox' ELSE 'crm' END AS asrc,
               coalesce(public.insights_phone8(o.customer_phone) = ANY (prm.tp), false) AS test
          FROM sc JOIN public.orders o ON o.mex_tracking_id = sc.tr CROSS JOIN prm
        UNION ALL
        SELECT sc.tr, o.id, o.sale_source_detail,
               CASE WHEN o.sale_source = 'collabbox' THEN 'collabbox' ELSE 'crm' END,
               coalesce(public.insights_phone8(o.customer_phone) = ANY (prm.tp), false)
          FROM sc JOIN public.orders o ON o.id = sc.reg_order CROSS JOIN prm) x
  WHERE x.det IS DISTINCT FROM 'disposition'
),
ps AS MATERIALIZED (       -- ONE source per parcel
  SELECT sc.tr, sc.cat,
         CASE WHEN sc.test OR coalesce(wo.test, false)
                   OR EXISTS (SELECT 1 FROM oo WHERE oo.tr = sc.tr AND oo.test) THEN 'test_phone'
              WHEN ov.action = 'exclude' THEN 'excluded'
              WHEN ov.action = 'lines'   THEN 'override'
              WHEN cb.tr IS NOT NULL     THEN 'collabbox'
              WHEN wo.tr IS NOT NULL     THEN 'web'
              WHEN EXISTS (SELECT 1 FROM oo WHERE oo.tr = sc.tr) THEN 'crm'
              ELSE 'none' END AS s,
         coalesce(cb.vanished, false) AS cb_vanished
  FROM sc
  LEFT JOIN ov ON ov.tr = sc.tr
  LEFT JOIN cb ON cb.tr = sc.tr
  LEFT JOIN wo ON wo.tr = sc.tr
),
rl AS MATERIALIZED (       -- every raw line of the chosen source
  SELECT ps.tr, ps.cat, ps.s AS ls, 'override'::text AS asrc, 'goods'::text AS role,
         nullif(btrim(e ->> 'code'), '') AS code, NULL::text AS name, NULL::text AS sku, NULL::text AS wpid,
         NULL::uuid AS pid, public.stock_v2_num(e ->> 'qty') AS q, false AS free
  FROM ps
  JOIN ov ON ov.tr = ps.tr
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(ov.payload -> 'lines') = 'array'
                                               THEN ov.payload -> 'lines' ELSE '[]'::jsonb END) e
  WHERE ps.s = 'override'
  UNION ALL
  SELECT ps.tr, ps.cat, ps.s, 'collabbox', coalesce(nullif(e ->> 'role', ''), 'goods'),
         nullif(btrim(e ->> 'code'), ''), e ->> 'name', NULL, NULL,
         CASE WHEN (e ->> 'product_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              THEN (e ->> 'product_id')::uuid END,
         public.stock_v2_num(e ->> 'qty'),
         coalesce(public.stock_v2_num(e ->> 'value_mkd'), 0) = 0
  FROM ps
  JOIN cb ON cb.tr = ps.tr
  CROSS JOIN LATERAL jsonb_array_elements(cb.lines) e
  WHERE ps.s = 'collabbox'
  UNION ALL
  SELECT ps.tr, ps.cat, ps.s, 'web', 'goods', NULL, i.name, nullif(btrim(i.sku), ''), i.product_id::text,
         NULL::uuid, i.quantity::numeric, (i.kind = 'GIFT' OR coalesce(i.price, 0) <= 0)
  FROM ps
  JOIN wo ON wo.tr = ps.tr
  JOIN public.web_order_items i ON i.shop_order_id = wo.shop_order_id
  WHERE ps.s = 'web'
  UNION ALL
  SELECT ps.tr, ps.cat, ps.s, oo.asrc, 'goods', NULL, i.product_name, NULL, NULL, i.product_id,
         i.quantity::numeric, coalesce(i.price_per_unit, 0) <= 0
  FROM ps
  JOIN oo ON oo.tr = ps.tr
  JOIN public.order_items i ON i.order_id = oo.oid
  WHERE ps.s = 'crm'
  UNION ALL
  -- an order with no item rows: its own single product (the api's legacy path)
  SELECT ps.tr, ps.cat, ps.s, oo.asrc, 'goods', NULL, o.product_name, NULL, NULL, o.product_id,
         coalesce(o.quantity, 1)::numeric, coalesce(o.price, 0) <= 0
  FROM ps
  JOIN oo ON oo.tr = ps.tr
  JOIN public.orders o ON o.id = oo.oid
  WHERE ps.s = 'crm'
    AND NOT EXISTS (SELECT 1 FROM public.order_items i WHERE i.order_id = oo.oid)
    AND (o.product_id IS NOT NULL OR nullif(btrim(o.product_name), '') IS NOT NULL)
),
dn AS MATERIALIZED (       -- each distinct web / CRM line text ONCE: its reviewed product alias and kind
  SELECT d.asrc, d.name, public.order_line_kind(d.asrc, d.name) AS ak,
         CASE WHEN k.pk LIKE 'p:%' THEN substr(k.pk, 3)::uuid END AS alias_pid
  FROM (SELECT DISTINCT rl.asrc, rl.name FROM rl WHERE rl.ls IN ('web', 'crm') AND rl.name IS NOT NULL) d
  CROSS JOIN LATERAL (SELECT public.product_key(d.asrc, d.name, NULL) AS pk) k
),
cat AS MATERIALIZED (      -- active catalogue names: a line equal to exactly ONE of them is that product
  SELECT public.product_alias_norm(p.name) AS norm, (array_agg(p.id ORDER BY p.id))[1] AS id, count(*) AS n
  FROM public.products p WHERE p.is_active GROUP BY 1
),
al AS MATERIALIZED (       -- the approved aliases' keys
  SELECT DISTINCT a.source, a.key FROM public.stock_article_aliases a WHERE a.status = 'approved'
),
rk AS MATERIALIZED (       -- each line: its CRM product and HOW it resolves
  SELECT r.tr, r.cat, r.ls, r.code, r.name, r.sku, r.wpid, r.q, r.free, x.pid2,
         CASE
           WHEN r.role <> 'goods'                                               THEN 'ns:' || r.role
           WHEN coalesce(dn.ak, 'product') <> 'product'                         THEN 'ns:' || dn.ak
           WHEN r.ls IN ('web', 'crm') AND lower(coalesce(r.name, '')) ~ '^\s*(поен|poen)'                  THEN 'ns:loyalty_point'
           WHEN r.ls IN ('web', 'crm') AND lower(coalesce(r.name, '')) ~ '(забелешка|zabeleska|zabeleshka)' THEN 'ns:note'
           WHEN r.ls IN ('web', 'crm') AND lower(coalesce(r.name, '')) ~ '^\s*(флаер|flaer|flyer)'          THEN 'ns:flyer'
           WHEN r.ls IN ('web', 'crm') AND lower(coalesce(r.name, '')) ~ '^\s*(достава|dostava)'            THEN 'ns:delivery'
           WHEN r.q IS NULL OR r.q <= 0                                         THEN 'ns:zero_quantity'
           WHEN r.q >= 100                                                      THEN 'un:bad_quantity'
           WHEN prm.skip_free AND r.free                                        THEN 'ns:free_skip'
           WHEN r.ls = 'override' THEN
             CASE WHEN EXISTS (SELECT 1 FROM public.stock_articles a WHERE a.code = r.code) THEN 'art' ELSE 'un:unknown_code' END
           WHEN r.ls = 'collabbox' AND EXISTS (SELECT 1 FROM al WHERE al.source = 'collabbox_code'
                                                  AND al.key = public.stock_v2_alias_key('collabbox_code', r.code)) THEN 'al:collabbox_code'
           WHEN r.ls = 'collabbox' AND EXISTS (SELECT 1 FROM public.stock_articles a WHERE a.code = r.code) THEN 'art'
           WHEN r.ls = 'collabbox' AND EXISTS (SELECT 1 FROM al WHERE al.source = 'collabbox_name'
                                                  AND al.key = public.stock_v2_alias_key('collabbox_name', r.name)) THEN 'al:collabbox_name'
           WHEN r.ls = 'web' AND EXISTS (SELECT 1 FROM al WHERE al.source = 'web_sku'
                                            AND al.key = public.stock_v2_alias_key('web_sku', r.sku)) THEN 'al:web_sku'
           WHEN r.ls = 'web' AND EXISTS (SELECT 1 FROM al WHERE al.source = 'web_product'
                                            AND al.key = public.stock_v2_alias_key('web_product', r.wpid)) THEN 'al:web_product'
           WHEN EXISTS (SELECT 1 FROM al WHERE al.source = 'name_any'
                           AND al.key = public.stock_v2_alias_key('name_any', r.name)) THEN 'al:name_any'
           WHEN x.pid2 IS NULL THEN CASE WHEN r.ls = 'collabbox' THEN 'un:unknown_code' ELSE 'un:no_product' END
           WHEN EXISTS (SELECT 1 FROM public.product_stock_exempt e WHERE e.product_id = x.pid2) THEN 'ns:exempt'
           WHEN EXISTS (SELECT 1 FROM public.product_articles a
                         WHERE a.product_id = x.pid2 AND a.status = 'approved'
                           AND a.valid_from <= r.cat AND (a.valid_to IS NULL OR a.valid_to > r.cat)) THEN 'rc'
           ELSE 'un:no_recipe'
         END AS how
  FROM rl r
  CROSS JOIN prm
  LEFT JOIN dn ON r.ls IN ('web', 'crm') AND dn.asrc = r.asrc AND dn.name = r.name
  LEFT JOIN cat c ON r.ls IN ('web', 'crm') AND r.pid IS NULL AND c.norm = public.product_alias_norm(r.name)
  CROSS JOIN LATERAL (SELECT coalesce(r.pid, dn.alias_pid, CASE WHEN c.n = 1 THEN c.id END) AS pid2) x
),
ex AS (                    -- each line → its article(s)
  SELECT k.tr, k.ls, k.code, k.name, k.sku, k.pid2, k.free,
         a.article_code AS art, k.q * a.qty AS aq,
         CASE WHEN a.kind = 'not_stock' THEN 'ns:alias_not_stock' END AS how2
  FROM rk k
  JOIN public.stock_article_aliases a
    ON a.status = 'approved'
   AND a.source = substr(k.how, 4)
   AND a.key = public.stock_v2_alias_key(substr(k.how, 4),
                 CASE substr(k.how, 4) WHEN 'collabbox_code' THEN k.code WHEN 'web_sku' THEN k.sku
                                       WHEN 'web_product' THEN k.wpid ELSE k.name END)
  WHERE k.how LIKE 'al:%'
  UNION ALL
  SELECT k.tr, k.ls, k.code, k.name, k.sku, k.pid2, k.free, k.code, k.q, NULL
  FROM rk k WHERE k.how = 'art'
  UNION ALL
  SELECT k.tr, k.ls, k.code, k.name, k.sku, k.pid2, k.free, pa.article_code, k.q * pa.qty, NULL
  FROM rk k
  JOIN public.product_articles pa
    ON pa.product_id = k.pid2 AND pa.status = 'approved'
   AND pa.valid_from <= k.cat AND (pa.valid_to IS NULL OR pa.valid_to > k.cat)
  WHERE k.how = 'rc'
  UNION ALL
  SELECT k.tr, k.ls, k.code, k.name, k.sku, k.pid2, k.free, NULL, k.q, k.how
  FROM rk k WHERE k.how LIKE 'ns:%' OR k.how LIKE 'un:%'
),
kx AS MATERIALIZED (       -- kits → components (one level)
  SELECT k.kit_code, k.component_code, k.qty
  FROM public.stock_article_kits k
  JOIN public.stock_articles s ON s.code = k.kit_code AND s.is_set
)
SELECT e.tr,
       CASE WHEN e.ls IN ('override', 'collabbox', 'web', 'crm') THEN e.ls END,
       (e.ls = 'crm' AND e.tr ~ '^[0-9]{3}-[0-9]{4}-') OR (e.ls = 'collabbox' AND ps.cb_vanished),
       CASE WHEN e.how2 IS NULL THEN coalesce(kx.component_code, e.art) END,
       round(e.aq * coalesce(kx.qty, 1), 3),
       CASE WHEN e.how2 LIKE 'ns:%' THEN 'not_stock' WHEN e.how2 LIKE 'un:%' THEN 'unmapped' ELSE 'stock' END,
       coalesce(e.code, e.sku), e.name, e.pid2,
       CASE WHEN e.how2 IS NOT NULL THEN substr(e.how2, 4) WHEN e.free THEN 'gift' END
FROM ex e
JOIN ps ON ps.tr = e.tr
LEFT JOIN kx ON e.how2 IS NULL AND kx.kit_code = e.art
UNION ALL
-- a parcel with nothing to resolve: a test phone, an exclusion, or no lines (yet)
SELECT ps.tr,
       CASE WHEN ps.s IN ('override', 'collabbox', 'web', 'crm') THEN ps.s END,
       false, NULL, NULL,
       CASE ps.s WHEN 'test_phone' THEN 'test_phone' WHEN 'excluded' THEN 'excluded' ELSE 'no_lines' END,
       NULL, NULL, NULL,
       CASE WHEN ps.s IN ('test_phone', 'excluded') THEN ps.s
            WHEN ps.cat > now() - interval '2 days' THEN 'waiting'
            ELSE 'no_lines' END
FROM ps
WHERE ps.s IN ('test_phone', 'excluded', 'none')
   OR NOT EXISTS (SELECT 1 FROM rl WHERE rl.tr = ps.tr)
$lines$;

COMMENT ON FUNCTION public.stock_v2_parcel_lines(timestamptz, timestamptz) IS
  'Stock v2: every line of every MEX parcel created (or returned, status 7) in [p_from, p_to) as articles — one source per parcel (override → collabBox document → web order → CRM orders → no_lines), aliases, approved recipes, kits expanded, gifts deducted (why gift). line_state stock | not_stock | unmapped | no_lines | test_phone | excluded; why = the reason. p_from NULL = stock_v2_scope_from(). Migration 20260945000200.';

-- ── 2. one verdict per parcel ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.stock_v2_parcels(p_from timestamptz DEFAULT NULL, p_to timestamptz DEFAULT NULL)
RETURNS TABLE (
  tracking_id         text,
  account             text,
  series              text,
  status_id           integer,
  created_at_mex      timestamptz,
  delivered_at        timestamptz,
  returned_at         timestamptz,
  lines_source        text,
  provisional         boolean,
  route_id            integer,
  warehouse_id        smallint,
  return_warehouse_id smallint,
  out_at              timestamptz,
  ret_at              timestamptz,
  unpack_at           timestamptz,
  state               text,
  flags               text[],
  units               numeric,
  units_out           numeric,
  units_back          numeric,
  gift_units          numeric,
  articles            jsonb,
  unmapped            jsonb)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET work_mem = '64MB'
SET jit = off
AS $parcels$
WITH
st AS MATERIALIZED (
  SELECT CASE WHEN (s ->> 'stale_label_days') ~ '^[0-9]{1,3}$' THEN (s ->> 'stale_label_days')::int ELSE 14 END AS stale_days,
         CASE WHEN (s ->> 'relabel_window_days') ~ '^[0-9]{1,2}$' THEN (s ->> 'relabel_window_days')::int ELSE 3 END AS relabel_days
  FROM (SELECT public.stock_v2_settings() AS s) x
),
ln AS MATERIALIZED (SELECT * FROM public.stock_v2_parcel_lines(p_from, p_to)),
pl AS MATERIALIZED (       -- per parcel: its lines summed
  SELECT l.tracking_id AS tr,
         max(l.lines_source) AS ls,
         bool_or(l.provisional) AS prov,
         bool_or(l.line_state = 'test_phone') AS test,
         bool_or(l.line_state = 'excluded') AS excl,
         coalesce(sum(l.qty) FILTER (WHERE l.line_state = 'stock'), 0) AS units,
         coalesce(sum(l.qty) FILTER (WHERE l.line_state = 'stock' AND l.why = 'gift'), 0) AS gift,
         count(*) FILTER (WHERE l.line_state = 'stock') AS n_stock,
         count(*) FILTER (WHERE l.line_state = 'unmapped') AS n_unm,
         bool_or(l.line_state = 'no_lines' AND l.why = 'waiting') AS waiting,
         coalesce(jsonb_agg(jsonb_build_object('code', l.line_code, 'name', l.line_name, 'qty', l.qty, 'why', l.why)
                            ORDER BY l.line_name, l.line_code) FILTER (WHERE l.line_state = 'unmapped'), '[]'::jsonb) AS unm
  FROM ln l
  GROUP BY l.tracking_id
),
pa AS MATERIALIZED (       -- per parcel: {article: qty}
  SELECT x.tracking_id AS tr, jsonb_object_agg(x.article_code, x.q ORDER BY x.article_code) AS arts
  FROM (SELECT l.tracking_id, l.article_code, sum(l.qty) AS q
          FROM ln l WHERE l.line_state = 'stock'
         GROUP BY 1, 2
        HAVING sum(l.qty) <> 0) x
  GROUP BY x.tracking_id
),
mp AS MATERIALIZED (
  SELECT p.tracking_id, p.account, p.series, p.status_id, p.created_at_mex, p.delivered_at, p.returned_at, p.phone8
  FROM public.mex_parcels p
  WHERE p.tracking_id IN (SELECT pl.tr FROM pl)
),
ov AS MATERIALIZED (
  SELECT o.tracking_id, o.action, o.payload, coalesce(o.event_at, o.set_at) AS ev
  FROM public.stock_parcel_overrides o
  WHERE o.active AND o.tracking_id IN (SELECT pl.tr FROM pl)
),
tw AS MATERIALIZED (SELECT w.id, w.code FROM public.stock_warehouses w WHERE w.tracked AND w.active),
rt AS MATERIALIZED (       -- the active routes into a tracked warehouse
  SELECT r.id, r.priority, r.match_account, r.match_series, r.match_shape, r.warehouse_id,
         r.return_warehouse_id, r.valid_from, r.valid_to
  FROM public.stock_parcel_routes r
  WHERE r.active AND r.warehouse_id IN (SELECT tw.id FROM tw)
),
r0 AS MATERIALIZED (SELECT min(rt.valid_from) AS first_from FROM rt),
v AS (
  SELECT mp.*, pl.ls, pl.prov, pl.test, pl.excl, pl.units, pl.gift, pl.n_stock, pl.n_unm, pl.waiting, pl.unm,
         coalesce(pa.arts, '{}'::jsonb) AS arts,
         ov.action AS ov_action, ov.payload AS ov_payload, ov.ev AS ov_ev,
         r0.first_from, ro.id AS ro_id, ro.warehouse_id AS ro_wh,
         rr.id AS rr_id, coalesce(rr.return_warehouse_id, rr.warehouse_id) AS rr_wh,
         st.stale_days, st.relabel_days
  FROM mp
  JOIN pl ON pl.tr = mp.tracking_id
  LEFT JOIN pa ON pa.tr = mp.tracking_id
  LEFT JOIN ov ON ov.tracking_id = mp.tracking_id
  CROSS JOIN r0
  CROSS JOIN st
  LEFT JOIN LATERAL (
    SELECT rt.id, rt.warehouse_id FROM rt
    WHERE (rt.match_account IS NULL OR rt.match_account = mp.account)
      AND (rt.match_series IS NULL OR rt.match_series = mp.series)
      AND (rt.match_shape IS NULL OR rt.match_shape = CASE WHEN pl.ls IN ('collabbox', 'web', 'crm') THEN pl.ls ELSE 'other' END)
      AND rt.valid_from <= mp.created_at_mex AND (rt.valid_to IS NULL OR mp.created_at_mex < rt.valid_to)
    ORDER BY rt.priority, rt.id
    LIMIT 1) ro ON true
  LEFT JOIN LATERAL (
    SELECT rt.id, rt.warehouse_id, rt.return_warehouse_id FROM rt
    WHERE mp.status_id = 7 AND mp.returned_at IS NOT NULL
      AND (rt.match_account IS NULL OR rt.match_account = mp.account)
      AND (rt.match_series IS NULL OR rt.match_series = mp.series)
      AND (rt.match_shape IS NULL OR rt.match_shape = CASE WHEN pl.ls IN ('collabbox', 'web', 'crm') THEN pl.ls ELSE 'other' END)
      AND rt.valid_from <= mp.returned_at AND (rt.valid_to IS NULL OR mp.returned_at < rt.valid_to)
    ORDER BY rt.priority, rt.id
    LIMIT 1) rr ON true
),
w AS (
  SELECT v.*,
         -- the warehouse the goods leave: the route's, or the override's (a tracked warehouse)
         CASE WHEN v.ro_id IS NULL THEN NULL
              WHEN v.ov_action = 'route' AND (SELECT tw.id FROM tw WHERE tw.code = lower(v.ov_payload ->> 'warehouse')) IS NOT NULL
                THEN (SELECT tw.id FROM tw WHERE tw.code = lower(v.ov_payload ->> 'warehouse'))
              ELSE v.ro_wh END AS wh_out,
         -- … and come back to
         CASE WHEN v.rr_id IS NULL THEN NULL
              WHEN v.ov_action = 'damaged_return'
                THEN coalesce((SELECT tw.id FROM tw WHERE tw.code = lower(coalesce(v.ov_payload ->> 'warehouse', 'damaged'))), v.rr_wh)
              WHEN v.ov_action = 'route' AND (SELECT tw.id FROM tw WHERE tw.code = lower(v.ov_payload ->> 'return_warehouse')) IS NOT NULL
                THEN (SELECT tw.id FROM tw WHERE tw.code = lower(v.ov_payload ->> 'return_warehouse'))
              ELSE v.rr_wh END AS wh_ret,
         NOT v.test AND NOT v.excl AS live
  FROM v
)
SELECT w.tracking_id, w.account, w.series, w.status_id, w.created_at_mex, w.delivered_at, w.returned_at,
       w.ls, coalesce(w.prov, false), w.ro_id, w.wh_out, w.wh_ret,
       CASE WHEN w.live AND w.wh_out IS NOT NULL AND w.n_stock > 0 THEN w.created_at_mex END,
       CASE WHEN w.live AND w.wh_ret IS NOT NULL AND w.n_stock > 0 THEN w.returned_at END,
       CASE WHEN w.live AND w.wh_out IS NOT NULL AND w.n_stock > 0 AND w.ov_action = 'unpacked'
            THEN greatest(w.ov_ev, w.created_at_mex) END,
       CASE WHEN w.test THEN 'test_phone'
            WHEN w.excl THEN 'excluded'
            WHEN w.first_from IS NOT NULL AND w.created_at_mex < w.first_from THEN 'pre_opening'
            WHEN w.wh_out IS NULL THEN 'no_route'
            WHEN w.n_stock > 0 AND w.n_unm > 0 THEN 'partial'
            WHEN w.n_stock > 0 THEN 'moved'
            WHEN w.n_unm > 0 THEN 'unmapped'
            WHEN w.waiting THEN 'waiting_lines'
            ELSE 'no_lines' END,
       array_remove(ARRAY[
         CASE WHEN w.prov THEN 'provisional' END,
         CASE WHEN w.ov_action IS NOT NULL THEN 'override_' || w.ov_action END,
         CASE WHEN w.status_id = 8 AND w.created_at_mex < now() - make_interval(days => w.stale_days) THEN 'stale_label' END,
         CASE WHEN w.status_id = 8 AND length(coalesce(w.phone8, '')) = 8
                   AND EXISTS (SELECT 1 FROM public.mex_parcels q
                                WHERE q.phone8 = w.phone8 AND q.tracking_id <> w.tracking_id
                                  AND q.created_at_mex > w.created_at_mex
                                  AND q.created_at_mex <= w.created_at_mex + make_interval(days => w.relabel_days))
              THEN 'possible_relabel' END,
         CASE WHEN w.live AND w.status_id = 7 AND w.wh_ret IS NULL AND w.n_stock > 0 THEN 'return_no_route' END
       ]::text[], NULL),
       w.units,
       CASE WHEN w.live AND w.wh_out IS NOT NULL THEN w.units ELSE 0 END,
       CASE WHEN w.live AND w.wh_ret IS NOT NULL THEN w.units ELSE 0 END,
       w.gift,
       w.arts,
       w.unm
FROM w
$parcels$;

COMMENT ON FUNCTION public.stock_v2_parcels(timestamptz, timestamptz) IS
  'Stock v2: one verdict per parcel in scope — route (lowest-priority matching active route into a tracked warehouse, valid at creation; the return route valid at returned_at; override route / damaged_return), state (test_phone · excluded · pre_opening · no_route · moved · partial · unmapped · waiting_lines · no_lines), flags (provisional · override_<action> · stale_label · possible_relabel · return_no_route), units (in / out / back / gifts), articles {code: qty}, the review list; out_at / ret_at / unpack_at = the ledger events it asks for. Migration 20260945000200.';

-- ── 3. grants ───────────────────────────────────────────────────────────────
DO $grants$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.stock_v2_num(text)', 'public.stock_v2_settings()', 'public.stock_v2_enabled()',
                           'public.stock_v2_scope_from()', 'public.stock_v2_alias_key(text, text)',
                           'public.stock_v2_wh(text)',
                           'public.stock_v2_parcel_lines(timestamptz, timestamptz)',
                           'public.stock_v2_parcels(timestamptz, timestamptz)']
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
