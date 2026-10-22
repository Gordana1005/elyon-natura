-- ============================================================================
-- THE ASSIGNER BY PRODUCT (owner 22.10.2026) + Менаџмент in the department checks
--
-- Owner: "во распределувач … последна порачка да ја пишува и продуктите кои се купени … и тоа како
-- филтер, пример сакаме да провериме Urofix, па да ги филтрираме и според продукт клиентите".
--
-- 1. assigner_product_buyers(products) — THE definition of "bought it": the last-8 phones of every
--    customer with a REAL order (confirmed / shipped / delivered / paid / returned — the "Нарачки" of
--    CLAUDE.md) holding one of the products as a purchase (order_products, not gift_only;
--    20261022120000). Call-centre dispositions are never orders. The web shop is not in it (web
--    orders are not CRM orders).
-- 2. The product filter, two scopes:
--      'ever'  the member's customer ever bought one of the products (by the last-8 phone)
--      'last'  the member's "Последна нарачка" (trigger_order_id — the order whose price and date the
--              Assigner shows) holds one of them as a purchase
--    on assigner_list_members (a card's page), assigner_lists (the list counts = the DistributeBar
--    pool) and assigner_distribute (kind 'list' only; pendings / call-agains refuse it).
-- 3. assigner_list_members.last_order_items — what that same order holds, for the page rows only
--    (≤ 200): [{name, qty, gift}], the catalogue name where the line names a product (its id or a
--    reviewed alias), lines of one name summed, purchases first; delivery / loyalty / note / flyer
--    lines and synthetic names dropped; no line → the order's header product_name (qty null).
-- 4. assigner_lists.whole_assigned — everything assigned in the WHOLE list (no department, no
--    product): what "Одземи ги сите" frees, now that by_department follows the product filter.
-- 5. 'management' joins the department keys of assigner_lists / assigner_distribute /
--    assigner_call_agains: the api has sent it since 20260947001000 and the SQL refused it
--    ("invalid department: management" on the Менаџмент chip), and by_department never counted it.
--
-- Signatures change (new trailing defaults) → the old ones are dropped; the api calls by name.
-- Access: service role only (+ the read-only verification role, as before).
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '10s';

DO $drift$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE proname = 'assigner_list_members') IS DISTINCT FROM '1ff00f38e435c46fd2b70385332668eb' THEN
    RAISE EXCEPTION 'assigner_list_members drifted from its 20260943001900 body — re-read it before replacing';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE proname = 'assigner_lists') IS DISTINCT FROM '759cee09db4a58f233a2d9a62696141c' THEN
    RAISE EXCEPTION 'assigner_lists drifted from its 20260942001957 body — re-read it before replacing';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE proname = 'assigner_distribute') IS DISTINCT FROM 'd3486ecf4733c006f01702651cf55476' THEN
    RAISE EXCEPTION 'assigner_distribute drifted from its 20260942001960 body — re-read it before replacing';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE proname = 'assigner_call_agains') IS DISTINCT FROM '5d0ba841f3972fffbde189db69355c4a' THEN
    RAISE EXCEPTION 'assigner_call_agains drifted from its 20260942001962 body — re-read it before replacing';
  END IF;
END
$drift$;

-- ── 1. who bought it ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.assigner_product_buyers(p_product_ids uuid[])
RETURNS TABLE (phone8 text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT DISTINCT right(regexp_replace(o.customer_phone, '[^0-9]', '', 'g'), 8)
  FROM public.order_products op
  JOIN public.orders o ON o.id = op.order_id
  WHERE op.product_id = ANY (p_product_ids)
    AND NOT op.gift_only
    AND o.status IN ('confirmed', 'shipped', 'delivered', 'paid', 'returned')
    AND o.sale_source_detail IS DISTINCT FROM 'disposition'
    AND length(regexp_replace(o.customer_phone, '[^0-9]', '', 'g')) >= 8
$fn$;

COMMENT ON FUNCTION public.assigner_product_buyers(uuid[]) IS
  'The Assigner''s "bought it": last-8 phones of customers with a real order (confirmed / shipped / delivered / paid / returned, no disposition) holding one of the products as a purchase (order_products, not gift_only). 20261022120100. Service role only.';

-- ── 2. a list's members page ────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.assigner_list_members(uuid, text[], text, text, integer, integer);

CREATE FUNCTION public.assigner_list_members(
  p_list_id       uuid,
  p_departments   text[]  DEFAULT NULL,
  p_assigned      text    DEFAULT 'all',   -- 'all' | 'none' | <agent uuid>
  p_completed     text    DEFAULT 'all',   -- 'all' | 'yes' | 'no'
  p_limit         integer DEFAULT 50,
  p_offset        integer DEFAULT 0,
  p_product_ids   uuid[]  DEFAULT NULL,    -- NULL / empty = every customer
  p_product_scope text    DEFAULT 'ever'   -- 'ever' | 'last' (anything else = 'ever'; the api validates)
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
WITH buyers AS MATERIALIZED (
  SELECT b.phone8
  FROM public.assigner_product_buyers(p_product_ids) b
  WHERE cardinality(p_product_ids) > 0 AND coalesce(p_product_scope, 'ever') <> 'last'
),
m AS (
  SELECT pm.*, public.assigner_dept_key(cd.department) AS department, cd.order_id AS last_sale_order_id
  FROM public.prediction_segment_members pm
  LEFT JOIN public.customer_departments cd ON cd.customer_phone = pm.customer_phone
  WHERE pm.list_id = p_list_id
    AND (p_departments IS NULL OR cardinality(p_departments) = 0
         OR public.assigner_dept_key(cd.department) = ANY (p_departments))
    AND (p_assigned IS NULL OR p_assigned = 'all'
         OR (p_assigned = 'none' AND pm.assigned_agent_id IS NULL)
         OR pm.assigned_agent_id::text = p_assigned)
    AND (p_completed IS NULL OR p_completed = 'all'
         OR (p_completed = 'yes' AND pm.is_completed)
         OR (p_completed = 'no' AND NOT pm.is_completed))
    AND (p_product_ids IS NULL OR cardinality(p_product_ids) = 0
         OR (p_product_scope = 'last' AND EXISTS (
               SELECT 1 FROM public.order_products op
                WHERE op.order_id = pm.trigger_order_id AND op.product_id = ANY (p_product_ids) AND NOT op.gift_only))
         OR (coalesce(p_product_scope, 'ever') <> 'last'
             AND right(regexp_replace(pm.customer_phone, '[^0-9]', '', 'g'), 8) IN (SELECT b.phone8 FROM buyers b)))
),
pg AS (
  SELECT * FROM m
  ORDER BY m.trigger_event_at DESC NULLS LAST, m.customer_phone
  LIMIT greatest(1, least(coalesce(p_limit, 50), 200)) OFFSET greatest(0, coalesce(p_offset, 0))
),
pg2 AS (
  SELECT pg.*,
         coalesce(sp.display_name, nullif(btrim(o.sold_by_ext), ''), nullif(btrim(o.confirmed_by_name), '')) AS last_seller
  FROM pg
  LEFT JOIN public.orders o ON o.id = pg.last_sale_order_id
  LEFT JOIN public.sales_people sp ON sp.id = o.sold_by_person_id
),
-- what the order shown as "Последна нарачка" holds (the price and date come from the same order)
pg3 AS (
  SELECT pg2.*,
         coalesce(li.items,
                  CASE WHEN lo.product_name IS NOT NULL
                            AND NOT public.is_synthetic_product_name(lo.product_name)
                            AND lo.product_name <> 'collabBox: без ставки (непознат производ)'
                       THEN jsonb_build_array(jsonb_build_object('name', btrim(lo.product_name), 'qty', NULL, 'gift', false))
                  END) AS last_order_items
  FROM pg2
  LEFT JOIN LATERAL (
    SELECT o.id, o.product_name,
           CASE WHEN o.sale_source = 'collabbox' THEN 'collabbox' ELSE 'crm' END AS src
    FROM public.orders o
    WHERE o.id = coalesce(pg2.trigger_order_id, pg2.last_sale_order_id)
  ) lo ON true
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object('name', g.name, 'qty', g.qty, 'gift', g.gift)
                     ORDER BY g.gift, g.pos, g.name) AS items
    FROM (
      SELECT z.name, z.gift, sum(z.qty)::int AS qty, min(z.pos) AS pos
      FROM (
        SELECT coalesce(p.name, btrim(y.product_name)) AS name, y.qty, y.pos,
               (y.kind = 'gift' OR coalesce(p.kind = 'gift', false)
                OR (NOT y.priced AND bool_or(y.priced) OVER ())) AS gift
        FROM (
          SELECT oi.product_name,
                 greatest(coalesce(oi.quantity, 1), 1) AS qty,
                 row_number() OVER (ORDER BY oi.created_at, oi.id) AS pos,
                 (coalesce(oi.total_price, 0) <> 0 OR coalesce(oi.price_per_unit, 0) <> 0) AS priced,
                 public.order_line_kind(lo.src, oi.product_name) AS kind,
                 coalesce(oi.product_id,
                          (SELECT CASE WHEN k.k LIKE 'p:%' THEN substr(k.k, 3)::uuid END
                             FROM (SELECT public.product_key(lo.src, oi.product_name, NULL) AS k) k)) AS pid
          FROM public.order_items oi
          WHERE oi.order_id = lo.id
            AND NOT public.is_synthetic_product_name(oi.product_name)
            AND oi.product_name <> 'collabBox: без ставки (непознат производ)'
        ) y
        LEFT JOIN public.products p ON p.id = y.pid
        WHERE y.kind NOT IN ('delivery', 'loyalty_point', 'note', 'flyer')
      ) z
      GROUP BY z.name, z.gift
    ) g
  ) li ON true
)
SELECT jsonb_build_object(
  'total',   (SELECT count(*) FROM m),
  'members', coalesce((SELECT jsonb_agg(to_jsonb(pg3) ORDER BY pg3.trigger_event_at DESC NULLS LAST, pg3.customer_phone) FROM pg3),
                      '[]'::jsonb)
)
$fn$;

COMMENT ON FUNCTION public.assigner_list_members(uuid, text[], text, text, integer, integer, uuid[], text) IS
  'GET /api/segments/:id (Assigner): a list''s members page with the buyer department (assigner_dept_key over customer_departments; unknown = no row), a department filter, last_seller (who sold the customer''s last sale), the product filter (ever bought — assigner_product_buyers — or in the "Последна нарачка" order) and last_order_items (what that order holds: [{name, qty, gift}]). 20260942001963 + 20260943001900 + 20261022120100. Service role only.';

-- ── 3. the list counts ──────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.assigner_lists(text[]);

CREATE FUNCTION public.assigner_lists(
  p_departments   text[] DEFAULT NULL,
  p_product_ids   uuid[] DEFAULT NULL,
  p_product_scope text   DEFAULT 'ever'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET work_mem = '32MB'          -- the member x cache hash join stays in memory
AS $fn$
DECLARE
  c_keys  CONSTANT text[] := ARRAY['altercpa', 'elyon_crm', 'teleshop_out', 'teleshop_other',
                                   'social', 'web', 'management', 'unknown'];
  v_sel   text[];
  v_bad   text;
  v_prods uuid[] := CASE WHEN cardinality(p_product_ids) > 0 THEN p_product_ids END;
  v_scope text   := lower(btrim(coalesce(p_product_scope, 'ever')));
  v_out   jsonb;
BEGIN
  IF p_departments IS NOT NULL AND cardinality(p_departments) > 0 THEN
    SELECT x INTO v_bad FROM unnest(p_departments) x WHERE x IS NULL OR NOT (x = ANY (c_keys)) LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'invalid department: %', coalesce(v_bad, 'null') USING ERRCODE = '22023';
    END IF;
    SELECT array_agg(k ORDER BY i) INTO v_sel
      FROM unnest(c_keys) WITH ORDINALITY AS u(k, i)
     WHERE k = ANY (p_departments);
  END IF;
  IF v_scope NOT IN ('ever', 'last') THEN
    RAISE EXCEPTION 'invalid product scope: %', p_product_scope USING ERRCODE = '22023';
  END IF;

  WITH
  lists AS (
    SELECT l.id, l.name, l.description, l.category, l.is_static, l.display_order,
           (NOT l.is_static OR l.name IN ('FULL MONAD LIST', 'Trash List')) AS assignable
    FROM public.prediction_segment_lists l
    WHERE l.is_active
  ),
  buyers AS MATERIALIZED (
    SELECT b.phone8 FROM public.assigner_product_buyers(v_prods) b
    WHERE v_prods IS NOT NULL AND v_scope = 'ever'
  ),
  agg AS (
    SELECT m.list_id,
           public.assigner_dept_key(cd.department)                                  AS dept,
           count(*)::int                                                              AS total,
           count(*) FILTER (WHERE NOT m.is_completed AND m.assigned_agent_id IS NULL)::int AS distributable,
           count(*) FILTER (WHERE m.assigned_agent_id IS NOT NULL)::int              AS assigned,
           count(*) FILTER (WHERE m.is_completed)::int                               AS done,
           count(*) FILTER (WHERE NOT m.is_completed)::int                           AS open
    FROM public.prediction_segment_members m
    JOIN lists ON lists.id = m.list_id
    LEFT JOIN public.customer_departments cd ON cd.customer_phone = m.customer_phone
    WHERE v_prods IS NULL
       OR (v_scope = 'last' AND EXISTS (
             SELECT 1 FROM public.order_products op
              WHERE op.order_id = m.trigger_order_id AND op.product_id = ANY (v_prods) AND NOT op.gift_only))
       OR (v_scope = 'ever'
           AND right(regexp_replace(m.customer_phone, '[^0-9]', '', 'g'), 8) IN (SELECT b.phone8 FROM buyers b))
    GROUP BY 1, 2
  ),
  -- everything assigned in the whole list, no filter: what "Одземи ги сите" frees
  whole AS (
    SELECT m.list_id, count(*) FILTER (WHERE m.assigned_agent_id IS NOT NULL)::int AS assigned
    FROM public.prediction_segment_members m
    JOIN lists ON lists.id = m.list_id
    GROUP BY 1
  ),
  per AS (
    SELECT l.id,
           sum(a.total)::int AS all_total,
           coalesce(sum(a.total)         FILTER (WHERE v_sel IS NULL OR a.dept = ANY (v_sel)), 0)::int AS total,
           coalesce(sum(a.distributable) FILTER (WHERE v_sel IS NULL OR a.dept = ANY (v_sel)), 0)::int AS distributable,
           coalesce(sum(a.assigned)      FILTER (WHERE v_sel IS NULL OR a.dept = ANY (v_sel)), 0)::int AS assigned,
           coalesce(sum(a.done)          FILTER (WHERE v_sel IS NULL OR a.dept = ANY (v_sel)), 0)::int AS done,
           coalesce(sum(a.open)          FILTER (WHERE v_sel IS NULL OR a.dept = ANY (v_sel)), 0)::int AS open,
           (SELECT jsonb_object_agg(k.k, jsonb_build_object(
                     'total',         coalesce(b.total, 0),
                     'distributable', coalesce(b.distributable, 0),
                     'assigned',      coalesce(b.assigned, 0),
                     'done',          coalesce(b.done, 0)))
              FROM unnest(c_keys) AS k(k)
              LEFT JOIN agg b ON b.list_id = l.id AND b.dept = k.k)                AS by_department
    FROM lists l
    JOIN agg a ON a.list_id = l.id
    GROUP BY l.id
  ),
  ol AS (
    SELECT l.*, p.total, p.distributable, p.assigned, p.done, p.open, p.by_department,
           coalesce(w.assigned, 0) AS whole_assigned
    FROM lists l
    JOIN per p ON p.id = l.id
    LEFT JOIN whole w ON w.list_id = l.id
    WHERE p.all_total > 0
  )
  SELECT jsonb_build_object(
    'generated_at',  now(),
    'departments',   to_jsonb(v_sel),
    'products',      to_jsonb(v_prods),
    'product_scope', CASE WHEN v_prods IS NOT NULL THEN v_scope END,
    'lists', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'id',             r.id,
               'name',           r.name,
               'description',    r.description,
               'category',       r.category,
               'is_static',      r.is_static,
               'display_order',  r.display_order,
               'assignable',     r.assignable,
               'total',          r.total,
               'distributable',  r.distributable,
               'assigned',       r.assigned,
               'done',           r.done,
               'open',           r.open,
               'whole_assigned', r.whole_assigned,
               'by_department',  r.by_department)
             ORDER BY r.display_order, r.name)
      FROM ol r), '[]'::jsonb),
    'totals', (
      SELECT jsonb_build_object(
               'total',         coalesce(sum(r.total), 0),
               'distributable', coalesce(sum(r.distributable), 0),
               'assigned',      coalesce(sum(r.assigned), 0),
               'done',          coalesce(sum(r.done), 0))
      FROM ol r)
  ) INTO v_out;

  RETURN v_out;
END;
$fn$;

COMMENT ON FUNCTION public.assigner_lists(text[], uuid[], text) IS
  'GET /api/assigner/lists: every active list with members (for the product filter: with matching members) — assignable (NOT is_static, or FULL MONAD LIST / Trash List), total / distributable (open, unassigned) / assigned / done / open for the selected buyer departments (customer_departments; unknown = no row; NULL = all) and products (ever bought | in the "Последна нарачка" order; NULL = everyone), by_department for all eight keys under the product filter (Σ = the list''s product total), whole_assigned (the whole list, no filter — what "Одземи ги сите" frees). 20260942001957 + 20261022120100. Service role only.';

-- ── 4. the distribution ─────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.assigner_distribute(text, uuid, text[], text, integer, text, uuid[], boolean, boolean, text, text);

CREATE FUNCTION public.assigner_distribute(
  p_kind             text,
  p_list_id          uuid,
  p_departments      text[],
  p_order            text,
  p_count            integer,
  p_split            text,
  p_agent_ids        uuid[],
  p_include_assigned boolean,
  p_dry_run          boolean,
  p_source           text DEFAULT 'all',
  p_actor_name       text DEFAULT NULL,
  p_product_ids      uuid[] DEFAULT NULL,
  p_product_scope    text   DEFAULT 'ever'
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  c_keys    CONSTANT text[] := ARRAY['altercpa', 'elyon_crm', 'teleshop_out', 'teleshop_other',
                                     'social', 'web', 'management', 'unknown'];
  c_ids_cap CONSTANT integer := 5000;
  v_kind    text    := lower(btrim(coalesce(p_kind, '')));
  v_order   text    := lower(btrim(coalesce(p_order, 'newest')));
  v_split   text    := lower(btrim(coalesce(p_split, 'total')));
  v_source  text    := lower(btrim(coalesce(p_source, 'all')));
  v_incl    boolean := coalesce(p_include_assigned, false);
  v_dry     boolean := coalesce(p_dry_run, true);
  v_actor   text    := coalesce(nullif(btrim(p_actor_name), ''), 'Assigner');
  v_prods   uuid[]  := CASE WHEN cardinality(p_product_ids) > 0 THEN p_product_ids END;
  v_pscope  text    := lower(btrim(coalesce(p_product_scope, 'ever')));
  v_now     timestamptz := now();
  v_sel     text[];
  v_bad     text;
  v_agents  uuid[];
  v_names   text[];
  v_n       integer;
  v_need    integer;
  v_list    record;
  v_sk      text;
  v_qo      text;   -- orders branch
  v_qm      text;   -- members branch
  v_lock_o  text;
  v_lock_m  text;
  v_pool    integer := 0;
  v_cnt     integer;
  v_src     text[];
  v_oid     uuid[];
  v_lid     uuid[];
  v_ph      text[];
  v_selected integer := 0;
  v_done_o  integer[];
  v_done_m  integer[];
  v_prev    text;
  v_assigned integer := 0;
  v_per     jsonb;
  v_ids     jsonb;
BEGIN
  -- ── arguments ──────────────────────────────────────────────────────────────
  IF v_kind NOT IN ('list', 'pendings', 'call_agains') THEN
    RAISE EXCEPTION 'invalid kind: %', p_kind USING ERRCODE = '22023';
  END IF;
  IF v_order NOT IN ('newest', 'oldest', 'random') THEN
    RAISE EXCEPTION 'invalid order: %', p_order USING ERRCODE = '22023';
  END IF;
  IF v_order = 'random' AND v_kind <> 'list' THEN
    RAISE EXCEPTION 'invalid order: random is for lists only' USING ERRCODE = '22023';
  END IF;
  IF v_split NOT IN ('total', 'per_agent') THEN
    RAISE EXCEPTION 'invalid split: %', p_split USING ERRCODE = '22023';
  END IF;
  IF v_source NOT IN ('all', 'order', 'prediction') THEN
    RAISE EXCEPTION 'invalid source: %', p_source USING ERRCODE = '22023';
  END IF;
  IF p_count IS NOT NULL AND p_count < 1 THEN
    RAISE EXCEPTION 'invalid count: % (a positive number, or null for all)', p_count USING ERRCODE = '22023';
  END IF;
  IF v_pscope NOT IN ('ever', 'last') THEN
    RAISE EXCEPTION 'invalid product scope: %', p_product_scope USING ERRCODE = '22023';
  END IF;
  IF v_prods IS NOT NULL AND v_kind <> 'list' THEN
    RAISE EXCEPTION 'invalid products: the product filter is for lists only' USING ERRCODE = '22023';
  END IF;

  IF p_departments IS NOT NULL AND cardinality(p_departments) > 0 THEN
    SELECT x INTO v_bad FROM unnest(p_departments) x WHERE x IS NULL OR NOT (x = ANY (c_keys)) LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'invalid department: %', coalesce(v_bad, 'null') USING ERRCODE = '22023';
    END IF;
    SELECT array_agg(k ORDER BY i) INTO v_sel
      FROM unnest(c_keys) WITH ORDINALITY AS u(k, i)
     WHERE k = ANY (p_departments);
  END IF;

  -- agents: duplicates dropped, the given order kept
  SELECT array_agg(z.a ORDER BY z.i) INTO v_agents
    FROM (SELECT DISTINCT ON (u.a) u.a, u.i
            FROM unnest(p_agent_ids) WITH ORDINALITY AS u(a, i)
           WHERE u.a IS NOT NULL
           ORDER BY u.a, u.i) z;
  v_n := coalesce(cardinality(v_agents), 0);
  IF v_n = 0 THEN
    RAISE EXCEPTION 'no agents' USING ERRCODE = '22023';
  END IF;

  SELECT u.a::text INTO v_bad
    FROM unnest(v_agents) AS u(a)
   WHERE NOT EXISTS (
           SELECT 1 FROM public.profiles p
            WHERE p.user_id = u.a AND p.is_active
              AND EXISTS (SELECT 1 FROM public.user_roles r
                           WHERE r.user_id = p.user_id AND r.role::text <> 'affiliate'))
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'inactive or unknown agent: %', v_bad USING ERRCODE = '22023';
  END IF;

  SELECT array_agg(coalesce(nullif(btrim(p.full_name), ''), p.email) ORDER BY u.i) INTO v_names
    FROM unnest(v_agents) WITH ORDINALITY AS u(a, i)
    JOIN public.profiles p ON p.user_id = u.a;

  IF v_kind = 'list' THEN
    IF p_list_id IS NULL THEN
      RAISE EXCEPTION 'list_id required' USING ERRCODE = '22023';
    END IF;
    SELECT l.id, l.name, l.is_static, l.is_active INTO v_list
      FROM public.prediction_segment_lists l WHERE l.id = p_list_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'list not found' USING ERRCODE = '22023';
    END IF;
    IF NOT v_list.is_active THEN
      RAISE EXCEPTION 'list is not active' USING ERRCODE = '22023';
    END IF;
    IF v_list.is_static AND v_list.name NOT IN ('FULL MONAD LIST', 'Trash List') THEN
      RAISE EXCEPTION 'list is not assignable' USING ERRCODE = '22023';
    END IF;
  END IF;

  v_need := CASE WHEN p_count IS NULL THEN NULL
                 WHEN v_split = 'per_agent' THEN p_count * v_n
                 ELSE p_count END;

  -- ── the pool ───────────────────────────────────────────────────────────────
  -- One sort key for every branch: newest = −epoch, oldest = +epoch, random.
  -- $1 list_id · $2 include_assigned · $3 departments · $4 need · $5 source · $6 products · $7 product scope
  v_sk := CASE v_order WHEN 'newest' THEN '-extract(epoch FROM %1$s)::float8'
                       WHEN 'oldest' THEN 'extract(epoch FROM %1$s)::float8'
                       ELSE 'random()' END;

  IF v_kind = 'list' THEN
    v_qm := format($q$
      SELECT 'm'::text AS src, NULL::uuid AS oid, m.list_id AS lid, m.customer_phone AS ph,
             %s AS sk, m.list_id::text || '|' || m.customer_phone AS tb
        FROM public.prediction_segment_members m
        LEFT JOIN public.customer_departments cd ON cd.customer_phone = m.customer_phone
       WHERE m.list_id = $1
         AND NOT m.is_completed
         AND ($2 OR m.assigned_agent_id IS NULL)
         AND ($3::text[] IS NULL OR public.assigner_dept_key(cd.department) = ANY ($3::text[]))
         AND ($6::uuid[] IS NULL
              OR ($7 = 'last' AND EXISTS (
                    SELECT 1 FROM public.order_products op
                     WHERE op.order_id = m.trigger_order_id AND op.product_id = ANY ($6::uuid[]) AND NOT op.gift_only))
              OR ($7 = 'ever' AND right(regexp_replace(m.customer_phone, '[^0-9]', '', 'g'), 8) IN (
                    SELECT b.phone8 FROM public.assigner_product_buyers($6::uuid[]) b)))$q$,
      format(v_sk, 'm.trigger_event_at'));
  ELSIF v_kind = 'pendings' THEN
    v_qo := format($q$
      SELECT 'o'::text AS src, o.id AS oid, NULL::uuid AS lid, NULL::text AS ph,
             %s AS sk, o.id::text AS tb
        FROM public.orders o
       WHERE o.status = 'pending'
         AND o.source_type IN ('altercpa', 'inbound_lead', 'opencart', 'opencart_abandoned')
         AND ($2 OR o.assigned_agent_id IS NULL)
         AND ($3::text[] IS NULL OR public.assigner_dept_key(public.cohort_order_source(
               o.sale_source, o.sale_source_detail, o.mex_tracking_id, o.dept_override)) = ANY ($3::text[]))$q$,
      format(v_sk, 'o.created_at'));
  ELSE
    v_qo := format($q$
      SELECT 'o'::text AS src, o.id AS oid, NULL::uuid AS lid, NULL::text AS ph,
             %s AS sk, o.id::text AS tb
        FROM public.orders o
       WHERE o.status = 'call_again'
         AND o.source_type IN ('altercpa', 'inbound_lead', 'opencart', 'opencart_abandoned')
         AND ($2 OR o.assigned_agent_id IS NULL)
         AND ($3::text[] IS NULL OR public.assigner_dept_key(public.cohort_order_source(
               o.sale_source, o.sale_source_detail, o.mex_tracking_id, o.dept_override)) = ANY ($3::text[]))
         AND $5 IN ('all', 'order')$q$,
      format(v_sk, 'o.call_again_since'));
    v_qm := format($q$
      SELECT 'm'::text AS src, NULL::uuid AS oid, m.list_id AS lid, m.customer_phone AS ph,
             %s AS sk, m.list_id::text || '|' || m.customer_phone AS tb
        FROM public.prediction_segment_members m
        LEFT JOIN public.customer_departments cd ON cd.customer_phone = m.customer_phone
       WHERE m.call_again_since IS NOT NULL
         AND NOT m.is_completed
         AND ($2 OR m.assigned_agent_id IS NULL)
         AND ($3::text[] IS NULL OR public.assigner_dept_key(cd.department) = ANY ($3::text[]))
         AND $5 IN ('all', 'prediction')$q$,
      format(v_sk, 'm.call_again_since'));
  END IF;

  IF v_qo IS NOT NULL THEN
    EXECUTE 'SELECT count(*)::int FROM (' || v_qo || ') c' INTO v_cnt
      USING p_list_id, v_incl, v_sel, v_need, v_source, v_prods, v_pscope;
    v_pool := v_pool + v_cnt;
  END IF;
  IF v_qm IS NOT NULL THEN
    EXECUTE 'SELECT count(*)::int FROM (' || v_qm || ') c' INTO v_cnt
      USING p_list_id, v_incl, v_sel, v_need, v_source, v_prods, v_pscope;
    v_pool := v_pool + v_cnt;
  END IF;

  -- ── the selection (locked in a real run) ───────────────────────────────────
  v_lock_o := CASE WHEN v_dry THEN '' ELSE ' FOR UPDATE OF o SKIP LOCKED' END;
  v_lock_m := CASE WHEN v_dry THEN '' ELSE ' FOR UPDATE OF m SKIP LOCKED' END;

  EXECUTE
    'SELECT coalesce(array_agg(x.src ORDER BY x.sk NULLS LAST, x.tb), ''{}''),'
    || '    coalesce(array_agg(x.oid ORDER BY x.sk NULLS LAST, x.tb), ''{}''),'
    || '    coalesce(array_agg(x.lid ORDER BY x.sk NULLS LAST, x.tb), ''{}''),'
    || '    coalesce(array_agg(x.ph  ORDER BY x.sk NULLS LAST, x.tb), ''{}'')'
    || '  FROM (SELECT u.* FROM ('
    || CASE WHEN v_qo IS NOT NULL
            THEN 'SELECT a.* FROM (' || v_qo || ' ORDER BY sk NULLS LAST, tb LIMIT $4' || v_lock_o || ') a'
            ELSE '' END
    || CASE WHEN v_qo IS NOT NULL AND v_qm IS NOT NULL THEN ' UNION ALL ' ELSE '' END
    || CASE WHEN v_qm IS NOT NULL
            THEN 'SELECT b.* FROM (' || v_qm || ' ORDER BY sk NULLS LAST, tb LIMIT $4' || v_lock_m || ') b'
            ELSE '' END
    || '  ) u ORDER BY u.sk NULLS LAST, u.tb LIMIT $4) x'
    INTO v_src, v_oid, v_lid, v_ph
    USING p_list_id, v_incl, v_sel, v_need, v_source, v_prods, v_pscope;

  v_selected := coalesce(cardinality(v_src), 0);

  -- ── the deal: item k (1-based, in the chosen order) → agent ((k-1) mod n)+1
  -- planned per agent (a dry run reports these)
  SELECT coalesce(array_agg(coalesce(c.o, 0) ORDER BY g.ai), '{}'),
         coalesce(array_agg(coalesce(c.m, 0) ORDER BY g.ai), '{}')
    INTO v_done_o, v_done_m
    FROM generate_series(1, v_n) AS g(ai)
    LEFT JOIN (
      SELECT ((s.k - 1) % v_n + 1)::int AS ai,
             count(*) FILTER (WHERE s.src = 'o')::int AS o,
             count(*) FILTER (WHERE s.src = 'm')::int AS m
        FROM unnest(v_src) WITH ORDINALITY AS s(src, k)
       GROUP BY 1) c ON c.ai = g.ai;

  -- ── the writes ─────────────────────────────────────────────────────────────
  IF NOT v_dry AND v_selected > 0 THEN
    IF 'o' = ANY (v_src) THEN
      -- an assignment is not a call: keep orders.updated_at (GET /call-agains)
      v_prev := current_setting('elyon.keep_updated_at', true);
      PERFORM set_config('elyon.keep_updated_at', 'on', true);

      WITH s AS (
        SELECT s.oid, ((s.k - 1) % v_n + 1)::int AS ai
          FROM unnest(v_src, v_oid) WITH ORDINALITY AS s(src, oid, k)
         WHERE s.src = 'o'
      ),
      u AS (
        UPDATE public.orders o
           SET assigned_agent_id   = v_agents[s.ai],
               assigned_agent_name = v_names[s.ai],
               assigned_at         = v_now,
               assigned_by         = v_actor
          FROM s
         WHERE o.id = s.oid
           AND o.status = CASE WHEN v_kind = 'pendings' THEN 'pending'::public.order_status
                               ELSE 'call_again'::public.order_status END
           AND o.source_type IN ('altercpa', 'inbound_lead', 'opencart', 'opencart_abandoned')
           AND (v_incl OR o.assigned_agent_id IS NULL)
        RETURNING s.ai
      )
      SELECT coalesce(array_agg(coalesce(c.n, 0) ORDER BY g.ai), '{}') INTO v_done_o
        FROM generate_series(1, v_n) AS g(ai)
        LEFT JOIN (SELECT u.ai, count(*)::int AS n FROM u GROUP BY u.ai) c ON c.ai = g.ai;

      PERFORM set_config('elyon.keep_updated_at', coalesce(v_prev, ''), true);
    ELSE
      v_done_o := array_fill(0, ARRAY[v_n]);
    END IF;

    IF 'm' = ANY (v_src) THEN
      WITH s AS (
        SELECT s.lid, s.ph, ((s.k - 1) % v_n + 1)::int AS ai
          FROM unnest(v_src, v_lid, v_ph) WITH ORDINALITY AS s(src, lid, ph, k)
         WHERE s.src = 'm'
      ),
      u AS (
        UPDATE public.prediction_segment_members m
           SET assigned_agent_id   = v_agents[s.ai],
               assigned_agent_name = v_names[s.ai],
               assigned_at         = v_now
          FROM s
         WHERE m.list_id = s.lid
           AND m.customer_phone = s.ph
           AND NOT m.is_completed
           AND (v_kind <> 'call_agains' OR m.call_again_since IS NOT NULL)
           AND (v_incl OR m.assigned_agent_id IS NULL)
        RETURNING s.ai
      )
      SELECT coalesce(array_agg(coalesce(c.n, 0) ORDER BY g.ai), '{}') INTO v_done_m
        FROM generate_series(1, v_n) AS g(ai)
        LEFT JOIN (SELECT u.ai, count(*)::int AS n FROM u GROUP BY u.ai) c ON c.ai = g.ai;
    ELSE
      v_done_m := array_fill(0, ARRAY[v_n]);
    END IF;

    SELECT coalesce(sum(x), 0)::int INTO v_assigned FROM unnest(v_done_o || v_done_m) x;
  END IF;

  -- ── the answer ─────────────────────────────────────────────────────────────
  SELECT jsonb_agg(jsonb_build_object(
           'agent_id',  v_agents[g.ai],
           'full_name', v_names[g.ai],
           'count',     v_done_o[g.ai] + v_done_m[g.ai],
           'orders',    v_done_o[g.ai],
           'members',   v_done_m[g.ai]) ORDER BY g.ai)
    INTO v_per
    FROM generate_series(1, v_n) AS g(ai);

  IF v_selected <= c_ids_cap THEN
    SELECT coalesce(jsonb_agg(CASE WHEN s.src = 'o' THEN 'order:' || s.oid::text
                                   ELSE 'member:' || s.lid::text || ':' || s.ph END ORDER BY s.k), '[]'::jsonb)
      INTO v_ids
      FROM unnest(v_src, v_oid, v_lid, v_ph) WITH ORDINALITY AS s(src, oid, lid, ph, k);
  END IF;

  RETURN jsonb_build_object(
    'kind',          v_kind,
    'dry_run',       v_dry,
    'list_id',       p_list_id,
    'departments',   to_jsonb(v_sel),
    'order',         v_order,
    'split',         v_split,
    'count',         p_count,
    'source',        CASE WHEN v_kind = 'call_agains' THEN v_source END,
    'products',      to_jsonb(v_prods),
    'product_scope', CASE WHEN v_prods IS NOT NULL THEN v_pscope END,
    'agents',        v_n,
    'pool',          v_pool,
    'selected',      v_selected,
    'assigned',      v_assigned,
    'per_agent',     coalesce(v_per, '[]'::jsonb),
    'ids',           v_ids,
    'ids_truncated', v_selected > c_ids_cap
  );
END;
$fn$;

COMMENT ON FUNCTION public.assigner_distribute(text, uuid, text[], text, integer, text, uuid[], boolean, boolean, text, text, uuid[], text) IS
  'POST /api/assigner/distribute (20260942001960 + 20261022120100): deals a list''s members (assignable lists only; buyer department filter; product filter — ever bought or in the "Последна нарачка" order, lists only), unassigned lead pendings, or call-agains (lead call_again orders + member callbacks) to agents — newest / oldest (random for lists), p_count NULL = all, split total (round-robin, first agents take the remainder) or per_agent (p_count each). FOR UPDATE SKIP LOCKED; writes only the assignment triple (+ assigned_by on orders, under elyon.keep_updated_at). p_dry_run = the same selection, no locks, no writes.';

-- ── 5. call-agains: Менаџмент is a department (body otherwise 20260942001962) ──
CREATE OR REPLACE FUNCTION public.assigner_call_agains(
  p_agent       text    DEFAULT NULL,
  p_source      text    DEFAULT 'all',
  p_departments text[]  DEFAULT NULL,
  p_order       text    DEFAULT 'oldest',
  p_limit       integer DEFAULT 50,
  p_offset      integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  c_keys   CONSTANT text[] := ARRAY['altercpa', 'elyon_crm', 'teleshop_out', 'teleshop_other',
                                    'social', 'web', 'management', 'unknown'];
  v_agent  text    := lower(btrim(coalesce(p_agent, 'all')));
  v_aid    uuid;
  v_source text    := lower(btrim(coalesce(p_source, 'all')));
  v_order  text    := lower(btrim(coalesce(p_order, 'oldest')));
  v_limit  integer := least(greatest(coalesce(p_limit, 50), 1), 500);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_sel    text[];
  v_bad    text;
  v_out    jsonb;
BEGIN
  IF v_source NOT IN ('all', 'order', 'prediction') THEN
    RAISE EXCEPTION 'invalid source: %', p_source USING ERRCODE = '22023';
  END IF;
  IF v_order NOT IN ('oldest', 'newest') THEN
    RAISE EXCEPTION 'invalid order: %', p_order USING ERRCODE = '22023';
  END IF;
  IF v_agent NOT IN ('all', 'unassigned') THEN
    IF v_agent !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'invalid agent: %', p_agent USING ERRCODE = '22023';
    END IF;
    v_aid := v_agent::uuid;
  END IF;
  IF p_departments IS NOT NULL AND cardinality(p_departments) > 0 THEN
    SELECT x INTO v_bad FROM unnest(p_departments) x WHERE x IS NULL OR NOT (x = ANY (c_keys)) LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'invalid department: %', coalesce(v_bad, 'null') USING ERRCODE = '22023';
    END IF;
    v_sel := p_departments;
  END IF;

  WITH
  o AS (
    SELECT 'order'::text AS source_kind, ('order:' || o.id::text) AS list_id, o.id AS order_id,
           o.customer_phone, o.customer_name, o.call_again_since,
           NULL::timestamptz AS last_call_at, 'no_answer'::text AS last_call_outcome,
           NULL::timestamptz AS in_call_again_until,
           o.assigned_agent_id, o.assigned_agent_name,
           o.price AS lifetime_value, NULL::integer AS paid_count, o.price AS avg_package_price,
           o.product_name AS list_name, 'order'::text AS list_category,
           public.assigner_dept_key(public.cohort_order_source(
             o.sale_source, o.sale_source_detail, o.mex_tracking_id, o.dept_override)) AS department,
           o.id::text AS tb
    FROM public.orders o
    WHERE v_source IN ('all', 'order')
      AND o.status = 'call_again'
      AND o.source_type IN ('altercpa', 'inbound_lead', 'opencart', 'opencart_abandoned')
      AND (v_agent = 'all'
           OR (v_agent = 'unassigned' AND o.assigned_agent_id IS NULL)
           OR o.assigned_agent_id = v_aid)
  ),
  m AS (
    SELECT 'prediction'::text AS source_kind, m.list_id::text AS list_id, NULL::uuid AS order_id,
           m.customer_phone, m.customer_name, m.call_again_since,
           m.last_call_at, m.last_call_outcome, m.in_call_again_until,
           m.assigned_agent_id, m.assigned_agent_name,
           m.lifetime_value, m.paid_count, m.avg_package_price,
           l.name AS list_name, l.category AS list_category,
           public.assigner_dept_key(cd.department) AS department,
           m.list_id::text || '|' || m.customer_phone AS tb
    FROM public.prediction_segment_members m
    LEFT JOIN public.prediction_segment_lists l ON l.id = m.list_id
    LEFT JOIN public.customer_departments cd ON cd.customer_phone = m.customer_phone
    WHERE v_source IN ('all', 'prediction')
      AND m.call_again_since IS NOT NULL
      AND NOT m.is_completed
      AND (v_agent = 'all'
           OR (v_agent = 'unassigned' AND m.assigned_agent_id IS NULL)
           OR m.assigned_agent_id = v_aid)
  ),
  u AS (
    SELECT * FROM o WHERE v_sel IS NULL OR o.department = ANY (v_sel)
    UNION ALL
    SELECT * FROM m WHERE v_sel IS NULL OR m.department = ANY (v_sel)
  ),
  pg AS (
    SELECT u.*
    FROM u
    ORDER BY CASE WHEN v_order = 'oldest' THEN u.call_again_since END ASC NULLS LAST,
             CASE WHEN v_order = 'newest' THEN u.call_again_since END DESC NULLS LAST,
             u.tb
    LIMIT v_limit OFFSET v_offset
  )
  SELECT jsonb_build_object(
    'total',         (SELECT count(*) FROM u),
    'total_orders',  (SELECT count(*) FROM u WHERE u.source_kind = 'order'),
    'total_members', (SELECT count(*) FROM u WHERE u.source_kind = 'prediction'),
    'items', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'source_kind',         p.source_kind,
               'list_id',             p.list_id,
               'order_id',            p.order_id,
               'customer_phone',      p.customer_phone,
               'customer_name',       p.customer_name,
               'call_again_since',    p.call_again_since,
               'last_call_at',        p.last_call_at,
               'last_call_outcome',   p.last_call_outcome,
               'in_call_again_until', p.in_call_again_until,
               'assigned_agent_id',   p.assigned_agent_id,
               'assigned_agent_name', p.assigned_agent_name,
               'lifetime_value',      p.lifetime_value,
               'paid_count',          p.paid_count,
               'avg_package_price',   p.avg_package_price,
               'list_name',           p.list_name,
               'list_category',       p.list_category,
               'department',          p.department)
             ORDER BY CASE WHEN v_order = 'oldest' THEN p.call_again_since END ASC NULLS LAST,
                      CASE WHEN v_order = 'newest' THEN p.call_again_since END DESC NULLS LAST,
                      p.tb)
      FROM pg p), '[]'::jsonb)
  ) INTO v_out;

  RETURN v_out;
END;
$fn$;

-- ── grants ──────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.assigner_product_buyers(uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.assigner_list_members(uuid, text[], text, text, integer, integer, uuid[], text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.assigner_lists(text[], uuid[], text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.assigner_distribute(text, uuid, text[], text, integer, text, uuid[], boolean, boolean, text, text, uuid[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assigner_product_buyers(uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.assigner_list_members(uuid, text[], text, text, integer, integer, uuid[], text) TO service_role;
GRANT EXECUTE ON FUNCTION public.assigner_lists(text[], uuid[], text) TO service_role;
GRANT EXECUTE ON FUNCTION public.assigner_distribute(text, uuid, text[], text, integer, text, uuid[], boolean, boolean, text, text, uuid[], text) TO service_role;

-- the read-only verification path (scripts/verify-assigner.mjs: read-only calls and dry runs)
DO $g$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.assigner_product_buyers(uuid[]) TO supabase_read_only_user';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.assigner_list_members(uuid, text[], text, text, integer, integer, uuid[], text) TO supabase_read_only_user';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.assigner_lists(text[], uuid[], text) TO supabase_read_only_user';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.assigner_distribute(text, uuid, text[], text, integer, text, uuid[], boolean, boolean, text, text, uuid[], text) TO supabase_read_only_user';
  END IF;
END $g$;

COMMIT;

NOTIFY pgrst, 'reload schema';
