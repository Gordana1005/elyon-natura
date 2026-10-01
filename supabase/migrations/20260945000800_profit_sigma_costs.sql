-- REAL PROFIT ON SIGMA PURCHASE COSTS (owner decision, Mile, 01.10.2026; contract docs/STOCK-V2.md "Profit").
--
-- The owner's rule: the purchase cost of everything is Sigma CalcBuyPrice, for the whole history; the old CRM
-- products.cost_price placeholders are archived and replaced (20260945000600); a bundle costs the sum of its
-- components (its approved recipe); gifts packed in the parcel are a real cost; costs are seen by OWNERS only.
-- Real profit uses these costs.
--
--   insights_profit()   a line's unit cost, by app_settings.stock_v2.profit.cost_source:
--                         'legacy' (the contract's default) — products.cost_price (EUR) × 61,5, exactly as before
--                                  (the body answers the same numbers as 20260944000900; parity proved in the dry run)
--                         'sigma'  — product_cost_history at the SALE DAY (cohort: the sale's Skopje day; cash: the
--                                  day MEX delivered), denari, NO ×61,5: cm = cost_mkd × qty. A bundle is costed by
--                                  its recipe (the history already sums its components). A product with no approved
--                                  recipe, or an article without a cost, is UNCOSTED and keeps the labelled estimate
--                                  (its revenue × the costed share's cost ratio) — never a silent 0.
--                       VAT per line is untouched (20260944000900).
--                       Phase B — "Подароци и дополнително спакувано", behind stock_v2.profit.extra_goods (default
--                       false; only with cost_source sigma): per collected parcel, the cost of what the collabBox
--                       document says was PACKED (payload->'lines', role goods, code = the Sigma article, at
--                       article_cost_at on the sale day) minus the cost of the order lines, each holder of a shared
--                       parcel carrying its 1/holders share — only when every packed line and every order line is
--                       costed (otherwise the parcel is left to the estimate, never counted twice). A MEX-only parcel
--                       whose collabBox contents are known becomes COSTED (its revenue leaves the estimate; its cost
--                       is the packed goods). A returned parcel's goods came back: no cost. It reads the collabBox
--                       ledger directly — not the stock ledger. New measures per agg row: cx (the extra, signed),
--                       cxm (the MEX-only part), cxn (the negative part — the recipe costs more than what was packed),
--                       xr (MEX-only revenue now costed), xn (sales compared); per product cx, xr, plus cost_mkd (max
--                       unit cost), pc (costed packages) and rc (costed revenue). The payload says cost_mode
--                       ('legacy' | 'sigma') and extra_goods.
--   insights_profit_cache_sig()      + the cost history, the approved recipes, the article costs and the
--                                      stock_v2.profit switches (any change invalidates the cached months)
--   insights_profit_cache_version()  5 → 6: no month cached before the Sigma costs is ever merged
--
-- Body = the LIVE one (20260944000900, md5 506d7d42…) with counted edits only: DECLARE (the switches) · ln0 (+ the
-- sale day) · kc (+ the product id) · ln1 (the unit cost by mode) · ln (+ the line weight) · xd / xs (Phase B, new)
-- · lm · agg_l · agg · prod · the two payload markers · EXECUTE … USING (+ $5 / $6).
--
-- Needs 20260945000600 (the cost functions) and 20260945000100 (the tables). Deploy order: 0100 → 0600 →
-- scripts/stock/costs-apply.mjs → this → the api (insightsProfit.ts reads cogs_extra / cost_mode) → the frontend →
-- switch stock_v2.profit.cost_source to 'sigma' (owner) → refresh the monthly cache
-- (SELECT public.insights_profit_refresh_nightly(true, 10); three times, or wait for 03:40 Skopje).
-- Rollback: re-emit insights_profit / _cache_sig / _cache_version from 20260944000900 (version 5).

BEGIN;

SET LOCAL lock_timeout = '10s';

-- ── 0. preconditions + drift guard: the bodies below were written against these live versions ────────
DO $drift$
DECLARE v_bad text; v_missing text;
BEGIN
  SELECT string_agg(t, ', ' ORDER BY t) INTO v_missing
    FROM unnest(ARRAY['public.product_cost_history', 'public.product_articles', 'public.stock_article_costs', 'public.stock_articles']) AS t
   WHERE to_regclass(t) IS NULL;
  IF v_missing IS NULL AND to_regprocedure('public.article_cost_at(text,timestamp with time zone)') IS NULL THEN
    v_missing := 'public.article_cost_at()';
  END IF;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'profit on Sigma costs: % missing — apply 20260945000100 and 20260945000600 first', v_missing;
  END IF;
  SELECT string_agg(e.sig, ', ' ORDER BY e.sig) INTO v_bad
  FROM (VALUES
    ('public.insights_profit(timestamp with time zone,timestamp with time zone,text,text,boolean)', '506d7d42a8962f92e3c7e91604a173e0', '4bc37adc005979689df1609f0f3aefd8'),
    ('public.insights_profit_cache_sig()', 'a369c3deea5f96f32f3131bbe757ed17', '19820e042bc5913d4a796c6413230123'),
    ('public.insights_profit_cache_version()', 'b4b2127a3fa9289a452ccf493c3a289f', 'ddcb63008ba4e94fdef6d2c1a325503e')
  ) e(sig, old_md5, new_md5)
  LEFT JOIN pg_proc p ON p.oid = to_regprocedure(e.sig)
  WHERE p.oid IS NULL OR md5(replace(p.prosrc, chr(13), '')) NOT IN (e.old_md5, e.new_md5);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'profit on Sigma costs: % changed since this migration was written — re-emit it from the live body', v_bad;
  END IF;
END
$drift$;

-- ── 1. the cache: a changed cost, recipe or switch invalidates it; nothing cached before is merged ──────
CREATE OR REPLACE FUNCTION public.insights_profit_cache_sig()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT md5(
    coalesce((SELECT string_agg(p.id::text || '|' || coalesce(p.name, '') || '|' || coalesce(p.cost_price::text, '')
                                || '|' || coalesce(p.vat_rate::text, ''), ';' ORDER BY p.id)
                FROM public.products p), '') || '#' ||
    coalesce((SELECT string_agg(a.source || '|' || a.alias_norm || '|' || coalesce(a.product_id::text, '') || '|' || a.kind, ';'
                                ORDER BY a.source, a.alias_norm)
                FROM public.product_aliases a), '') || '#' ||
    coalesce(array_to_string(public.report_excluded_phone8s(), ','), '') || '#' ||
    -- Sigma costs (20260945000800): the cost history, the approved recipes, the article costs, the switches
    coalesce((SELECT string_agg(h.product_id::text || '|' || h.valid_from::text || '|' || coalesce(h.valid_to::text, '')
                                || '|' || coalesce(h.cost_mkd::text, '') || '|' || h.complete::text, ';'
                                ORDER BY h.product_id, h.valid_from)
                FROM public.product_cost_history h), '') || '#' ||
    coalesce((SELECT string_agg(r.product_id::text || '|' || r.article_code || '|' || r.qty::text || '|' || r.valid_from::text
                                || '|' || coalesce(r.valid_to::text, ''), ';' ORDER BY r.product_id, r.article_code, r.valid_from)
                FROM public.product_articles r WHERE r.status = 'approved'), '') || '#' ||
    coalesce((SELECT string_agg(c.article_code || '|' || c.valid_from::text || '|' || c.source || '|' || c.cost_mkd::text, ';'
                                ORDER BY c.article_code, c.valid_from, c.source)
                FROM public.stock_article_costs c), '') || '#' ||
    coalesce((SELECT (s.value -> 'profit')::text FROM public.app_settings s WHERE s.key = 'stock_v2'), ''))
$function$;

-- 5 → 6: Sigma purchase costs + Phase B (20260945000800)
CREATE OR REPLACE FUNCTION public.insights_profit_cache_version()
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
AS $function$ SELECT 6 $function$;

-- ── 2. insights_profit(): the unit cost by mode, Phase B ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.insights_profit(p_from timestamp with time zone, p_to_end timestamp with time zone, p_clock text DEFAULT 'cohort'::text, p_granularity text DEFAULT NULL::text, p_detail boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET "TimeZone" TO 'UTC'
 SET work_mem TO '64MB'
 SET jit TO 'off'
AS $function$
DECLARE
  -- $1 from · $2 to_end · $3 granularity ('day' | 'month') · $4 detail · $5 cost mode ('legacy' | 'sigma')
  -- · $6 Phase B extra packed goods (boolean)
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
         NULL::text AS wkind,
         s.day     -- the clock's day (cohort: the sale's Skopje day; cash: the day MEX delivered) — the cost date
  FROM s JOIN ob ON ob.id = s.order_id JOIN oi ON oi.order_id = s.order_id
  WHERE s.g IN ('collected', 'returned')
  UNION ALL
  SELECT s.sid, CASE WHEN ob.sale_source = 'collabbox' THEN 'collabbox' ELSE 'crm' END,
         ob.product_name, ob.product_id, ob.oq, 1::float8, ob.bonus_eur, NULL, s.day
  FROM s JOIN ob ON ob.id = s.order_id
  WHERE s.g IN ('collected', 'returned') AND NOT ob.has_items
  UNION ALL
  -- web_order_items joined straight (its index), never through a CTE: the
  -- planner cannot size a CTE and loops over it once per web sale
  SELECT s.sid, 'web', wi.name, NULL::uuid, coalesce(wi.quantity, 0),
         CASE WHEN wi.kind = 'GIFT' THEN 0
              ELSE greatest(coalesce(wi.price, 0) * coalesce(wi.quantity, 0) - coalesce(wi.discount_allocated, 0), 0) END::float8,
         0::float8, wi.kind, s.day
  FROM s JOIN public.web_order_items wi ON wi.shop_order_id = s.web_id
  WHERE s.g IN ('collected', 'returned') AND s.kind = 'web'
  UNION ALL
  SELECT s.sid, CASE WHEN s.kind = 'mex' THEN 'mex' ELSE 'none' END, NULL, NULL, 0, 1::float8, 0::float8, NULL, s.day
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
-- a known cost is never invented: legacy = a catalogue cost_price > 0 (EUR);
-- sigma = the product's complete Sigma cost (product_cost_history, its recipe)
-- on the sale day. The VAT rate is the product's own (products.vat_rate, from
-- Sigma; NULL = unclassified)
kc AS (
  SELECT DISTINCT ON (k2.k) k2.k, p.id AS pid, CASE WHEN p.cost_price > 0 THEN p.cost_price::numeric END AS cost_eur, p.name AS pname,
         p.vat_rate AS vat_n
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
         -- uc = the unit cost in денари (NULL = uncosted); ce = the legacy EUR price
         -- it came from (legacy mode only: cm stays cost_eur × qty × 61,5, bit for bit)
         CASE WHEN $5 = 'sigma' THEN hc.cost_mkd ELSE kc.cost_eur::float8 * 61.5 END AS uc,
         CASE WHEN $5 = 'sigma' THEN NULL::float8 ELSE kc.cost_eur::float8 END AS ce,
         kc.pname, kc.vat_n
  FROM ln0
  LEFT JOIN lk2 k2 ON k2.src = ln0.src AND k2.pk_name = coalesce(ln0.name, '') AND k2.pk_pid = coalesce(ln0.pid::text, '')
  LEFT JOIN kc ON kc.k = k2.k
  -- the interval of the product's cost history that holds the sale day (Skopje
  -- midnight); an incomplete recipe on that day = uncosted (the PK's index)
  LEFT JOIN LATERAL (
    SELECT CASE WHEN h.complete AND (h.valid_to IS NULL OR h.valid_to > (ln0.day::timestamp AT TIME ZONE 'Europe/Skopje'))
                THEN h.cost_mkd::float8 END AS cost_mkd
    FROM public.product_cost_history h
    WHERE $5 = 'sigma' AND h.product_id = kc.pid
      AND h.valid_from <= (ln0.day::timestamp AT TIME ZONE 'Europe/Skopje')
    ORDER BY h.valid_from DESC
    LIMIT 1
  ) hc ON true
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
         ln1.qty, ln1.lb, ln1.uc, ln1.ce, ln1.vat_n,
         coalesce(ln1.pname, ln1.name) AS name,
         s.g, s.source, s.d, s.wm,
         -- the sale's value by price weight; all-zero prices → by packages
         s.rev * (CASE WHEN ls.sw > 0 THEN ln1.w0 / ls.sw
                       WHEN ls.sq > 0 THEN (CASE WHEN ln1.kind IN ('product', 'gift') THEN ln1.qty::float8 / ls.sq ELSE 0 END)
                       ELSE 1.0::float8 / ls.nl END) AS rv,
         -- the same weight alone (Σ over a sale's lines = 1): how a sale-level
         -- cost (Phase B) is shared by its lines
         (CASE WHEN ls.sw > 0 THEN ln1.w0 / ls.sw
               WHEN ls.sq > 0 THEN (CASE WHEN ln1.kind IN ('product', 'gift') THEN ln1.qty::float8 / ls.sq ELSE 0 END)
               ELSE 1.0::float8 / ls.nl END) AS wt,
         -- the sale's parcel by packages (courier share)
         s.pw * (CASE WHEN ls.np = 0 THEN 1.0::float8 / ls.nl
                      WHEN ln1.kind NOT IN ('product', 'gift') THEN 0
                      WHEN ls.sq > 0 THEN ln1.qty::float8 / ls.sq
                      ELSE 1.0::float8 / ls.np END) AS sh,
         (ln1.kind IN ('product', 'gift') AND ls.sw > 0 AND ln1.w0 = 0) AS free
  FROM ln1 JOIN ls ON ls.sid = ln1.sid JOIN s ON s.sid = ln1.sid
),
-- Phase B (stock_v2.profit.extra_goods, Sigma mode only): what each collected
-- parcel REALLY held — its collabBox document's goods lines (code = the Sigma
-- article, doc_number = the MEX tracking id), costed on the sale day. Read
-- straight from the collabBox ledger, never the stock ledger. A returned
-- parcel's goods came back: no cost (collected only). nu = lines without a
-- cost (an unknown article, no Sigma cost, a quantity of 100+ or none) — such
-- a parcel is left to the estimate.
xd AS MATERIALIZED (
  SELECT s.sid, s.pw,
         count(*) FILTER (WHERE g.u IS NULL OR g.q IS NULL OR g.q >= 100) AS nu,
         sum(g.q * g.u) AS cogs
  FROM s
  JOIN public.collabbox_documents d
    ON d.doc_number = s.tracking_id AND NOT d.is_storno AND d.reversed_by IS NULL AND d.vanished_at IS NULL AND d.lines_complete
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(d.payload -> 'lines') = 'array' THEN d.payload -> 'lines' ELSE '[]'::jsonb END) e(l)
  CROSS JOIN LATERAL (
    SELECT CASE WHEN btrim(e.l ->> 'qty') ~ '^[0-9]+([.][0-9]+)?$' THEN btrim(e.l ->> 'qty')::float8 END AS q,
           -- the article's cost on the sale day — THE definition (article_cost_at, 20260945000600);
           -- ~0,25 s a month more than an inlined twin, never a second rule to keep in step
           public.article_cost_at(e.l ->> 'code', (s.day::timestamp AT TIME ZONE 'Europe/Skopje'))::float8 AS u
  ) g
  WHERE $6 AND s.g = 'collected' AND s.tracking_id IS NOT NULL
    AND e.l ->> 'role' = 'goods' AND (g.q IS NULL OR g.q > 0)
  GROUP BY s.sid, s.pw
),
-- per sale: its share of the packed goods (1/holders of a shared parcel) minus
-- its own lines' cost — only when every packed line AND every package line is
-- costed (otherwise the estimate covers it; never counted twice). A MEX-only
-- sale (contents unknown until now) takes the packed goods as its cost.
-- (one join, then one aggregate: a per-sale subquery on the inner side was rescanned per parcel)
xs AS MATERIALIZED (
  SELECT ln.sid,
         max(xd.cogs * xd.pw) - sum(CASE WHEN ln.pkg AND ln.uc IS NOT NULL THEN ln.uc * ln.qty ELSE 0 END) AS cx,
         bool_and(ln.kind = 'unknown') AS mex
  FROM ln JOIN xd ON xd.sid = ln.sid
  GROUP BY ln.sid
  HAVING max(xd.nu) = 0
     AND bool_and(NOT (ln.pkg AND ln.uc IS NULL))
     AND (bool_and(ln.kind = 'unknown') OR NOT bool_or(ln.kind = 'unknown'))
),
lm AS MATERIALIZED (     -- line measures (денари; legacy cost EUR × 61,5, Sigma cost as it is)
  SELECT ln.*,
         CASE WHEN ln.pkg AND ln.uc IS NOT NULL THEN ln.rv WHEN xs.mex THEN ln.rv ELSE 0 END AS rc,
         CASE WHEN xs.mex THEN 0 WHEN (ln.pkg AND ln.uc IS NULL) OR ln.kind = 'unknown' THEN ln.rv ELSE 0 END AS ru,
         CASE WHEN NOT ln.pkg AND ln.kind <> 'unknown' THEN ln.rv ELSE 0 END AS rn,
         CASE WHEN ln.pkg AND ln.uc IS NOT NULL
              THEN (CASE WHEN ln.ce IS NOT NULL THEN ln.ce * ln.qty * 61.5 ELSE ln.uc * ln.qty END) ELSE 0 END AS cm,
         CASE WHEN ln.pkg AND ln.uc IS NOT NULL THEN ln.qty ELSE 0 END AS pc,
         CASE WHEN ln.pkg AND ln.uc IS NULL THEN ln.qty ELSE 0 END AS pu,
         CASE WHEN ln.free THEN ln.qty ELSE 0 END AS fr,
         -- Phase B: the extra packed goods (signed), shared by the sale's lines by
         -- value; its MEX-only part; its negative part; the MEX-only revenue now
         -- costed; the sales compared (Σ weights = 1 per sale)
         coalesce(xs.cx, 0) * ln.wt AS cx,
         CASE WHEN xs.mex THEN xs.cx * ln.wt ELSE 0 END AS cxm,
         CASE WHEN xs.cx < 0 THEN xs.cx * ln.wt ELSE 0 END AS cxn,
         CASE WHEN xs.mex THEN ln.rv ELSE 0 END AS xr,
         CASE WHEN xs.sid IS NOT NULL THEN ln.wt ELSE 0 END AS xn,
         -- VAT per LINE (owner 01.10.2026, replaces the flat 18 %): the line's
         -- value × r/(1+r), r = its product's Sigma rate. A line with no product
         -- or no rate (a MEX-only parcel, a sale without lines, an unmatched
         -- name, a product not classified yet) is taxed at the core range's 5 %
         -- and its value is counted in vu — visible, never silent.
         coalesce(ln.vat_n, 0.05) AS vr,
         (ln.vat_n IS NULL) AS vd,
         ln.rv * coalesce(ln.vat_n, 0.05)::float8 / (1 + coalesce(ln.vat_n, 0.05)::float8) AS vt,
         CASE WHEN (ln.pkg AND ln.uc IS NOT NULL) OR xs.mex
              THEN ln.rv * coalesce(ln.vat_n, 0.05)::float8 / (1 + coalesce(ln.vat_n, 0.05)::float8) ELSE 0 END AS vc,
         CASE WHEN ln.vat_n IS NULL THEN ln.rv ELSE 0 END AS vu,
         CASE WHEN coalesce(ln.vat_n, 0.05) = 0    THEN ln.rv ELSE 0 END AS v00,
         CASE WHEN coalesce(ln.vat_n, 0.05) = 0.05 THEN ln.rv ELSE 0 END AS v05,
         CASE WHEN coalesce(ln.vat_n, 0.05) = 0.10 THEN ln.rv ELSE 0 END AS v10,
         CASE WHEN coalesce(ln.vat_n, 0.05) = 0.18 THEN ln.rv ELSE 0 END AS v18
  FROM ln LEFT JOIN xs ON xs.sid = ln.sid
),
agg_s AS (    -- sale-level measures
  SELECT s.g, s.source, s.d, s.wm, count(*) AS n, sum(s.rev) AS rev, sum(s.card) AS card, sum(s.pw) AS pw
  FROM s GROUP BY GROUPING SETS ((s.g, s.source), (s.g, s.d), (s.g, s.wm))
),
agg_l AS (    -- line measures on the same grains
  SELECT lm.g, lm.source, lm.d, lm.wm,
         sum(lm.rc) AS rc, sum(lm.ru) AS ru, sum(lm.rn) AS rn, sum(lm.cm) AS cm,
         sum(lm.pc) AS pc, sum(lm.pu) AS pu, sum(lm.fr) AS fr, sum(lm.lb) AS lb,
         sum(lm.vt) AS vt, sum(lm.vc) AS vc, sum(lm.vu) AS vu,
         sum(lm.v00) AS v00, sum(lm.v05) AS v05, sum(lm.v10) AS v10, sum(lm.v18) AS v18,
         sum(lm.cx) AS cx, sum(lm.cxm) AS cxm, sum(lm.cxn) AS cxn, sum(lm.xr) AS xr, sum(lm.xn) AS xn
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
         coalesce(l.fr, 0) AS fr, coalesce(l.lb, 0)::numeric AS lb,
         -- VAT per line (vt), of the costed part (vc), the unclassified value (vu)
         -- and the value by rate (v00 / v05 / v10 / v18; vu is inside v05)
         round(coalesce(l.vt, 0)::numeric, 9) AS vt, round(coalesce(l.vc, 0)::numeric, 9) AS vc,
         round(coalesce(l.vu, 0)::numeric, 9) AS vu,
         round(coalesce(l.v00, 0)::numeric, 9) AS v00, round(coalesce(l.v05, 0)::numeric, 9) AS v05,
         round(coalesce(l.v10, 0)::numeric, 9) AS v10, round(coalesce(l.v18, 0)::numeric, 9) AS v18,
         -- Phase B (0 when off): the extra packed goods, its MEX-only and negative
         -- parts, the MEX-only revenue now costed, the sales compared
         round(coalesce(l.cx, 0)::numeric, 9) AS cx, round(coalesce(l.cxm, 0)::numeric, 9) AS cxm,
         round(coalesce(l.cxn, 0)::numeric, 9) AS cxn, round(coalesce(l.xr, 0)::numeric, 9) AS xr,
         round(coalesce(l.xn, 0)::numeric, 9) AS xn
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
         count(*) FILTER (WHERE sr.kind = 'mex')   AS nm,
         count(*) FILTER (WHERE sr.kind = 'booking') AS nb
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
         bool_or(lm.pkg) AS pkg,
         -- legacy: the catalogue EUR price as before; Sigma: the unit cost / 61,5 (a
         -- client older than 20260945000800 reads only this)
         max(CASE WHEN lm.ce IS NOT NULL THEN lm.ce ELSE lm.uc / 61.5 END) AS cost_eur,
         max(pn.n) AS n,
         sum(lm.qty) AS qty, sum(CASE WHEN lm.pkg THEN lm.qty ELSE 0 END) AS pkgs, sum(lm.fr) AS fr,
         round(sum(lm.rv)::numeric, 9) AS rev, round(sum(lm.cm)::numeric, 9) AS cm,
         round(sum(lm.sh)::numeric, 9) AS sh, sum(lm.lb)::numeric AS lb,
         -- the product's VAT (Σ per line), its rate, whether the rate was defaulted
         round(sum(lm.vt)::numeric, 9) AS vt, max(lm.vr) AS vr, bool_or(lm.vd) AS vd,
         -- the cost (20260945000800): the highest unit cost in денари, the costed
         -- packages and revenue (a recipe may start mid-window), Phase B's share
         round(max(lm.uc)::numeric, 9) AS cost_mkd, sum(lm.pc) AS pc, round(sum(lm.rc)::numeric, 9) AS rc,
         round(sum(lm.cx)::numeric, 9) AS cx, round(sum(lm.xr)::numeric, 9) AS xr
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
  -- every agg row carries vt / vc / vu / v00–v18 and every product row vt / vr / vd
  'vat_mode', 'per_line',
  -- the unit cost's source (legacy | sigma) and whether Phase B ran (20260945000800)
  'cost_mode', $5,
  'extra_goods', $6,
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
                (SELECT public.cohort_order_source(x.sale_source, x.sale_source_detail, x.mex_tracking_id, x.dept_override) FROM public.orders x
                  WHERE x.mex_tracking_id = p.tracking_id
                    AND x.sale_source_detail IS DISTINCT FROM 'disposition'
                  ORDER BY x.created_at, x.id LIMIT 1),
                (SELECT public.cohort_order_source(x.sale_source, x.sale_source_detail, x.mex_tracking_id, x.dept_override) FROM public.orders x
                  WHERE p.order_id IS NOT NULL AND x.id = p.order_id
                    AND x.sale_source_detail IS DISTINCT FROM 'disposition'),
                public.cohort_parcel_source(public.cohort_parcel_split(p.account, p.series, p.tracking_id, p.sender_reference))) END AS source
  FROM public.mex_parcels p CROSS JOIN prm CROSS JOIN xp
  WHERE p.returned_at BETWEEN prm.f AND prm.t
    AND NOT public.insights_excluded8(p.phone8, xp.l)
)
SELECT jsonb_build_object(
  'clock', 'cash',
  'vat_mode', 'per_line',
  'cost_mode', $5,
  'extra_goods', $6,
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
  -- the cost switches (owner 01.10.2026, docs/STOCK-V2.md Settings): $5 cost mode, $6 Phase B
  v_set  jsonb := (SELECT s.value FROM public.app_settings s WHERE s.key = 'stock_v2');
  v_cost text;
  v_extra boolean;
BEGIN
  v_cost := CASE WHEN v_set #>> '{profit,cost_source}' = 'sigma' THEN 'sigma' ELSE 'legacy' END;
  -- the extra packed goods are costed at Sigma prices: meaningful only against Sigma-costed order lines
  v_extra := v_cost = 'sigma' AND coalesce(v_set #>> '{profit,extra_goods}', 'false') = 'true';
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
      USING p_from, p_to_end, v_gran, coalesce(p_detail, true), v_cost, v_extra;
  ELSE
    EXECUTE v_head_cash || v_common || v_tail_cash INTO v_out
      USING p_from, p_to_end, v_gran, coalesce(p_detail, true), v_cost, v_extra;
  END IF;
  RETURN v_out;
END;
$function$;

COMMENT ON FUNCTION public.insights_profit(timestamp with time zone, timestamp with time zone, text, text, boolean) IS
  'Pure Profit / Margins inputs of one clock (cohort | cash): sales, lines, VAT per line (20260944000900) and the unit cost by app_settings.stock_v2.profit.cost_source — legacy (products.cost_price × 61.5) or sigma (product_cost_history at the sale day, денари); Phase B extra packed goods behind profit.extra_goods (sigma only). Payload markers vat_mode, cost_mode, extra_goods. Owner decision 01.10.2026, migration 20260945000800.';

NOTIFY pgrst, 'reload schema';

COMMIT;
