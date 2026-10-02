-- STOCK V2 — PURCHASE COSTS FROM SIGMA (owner decision, Mile, 01.10.2026; contract docs/STOCK-V2.md "Costs").
--
-- The owner's rule:
--   * The purchase cost of EVERYTHING is Sigma's CalcBuyPrice (warehouse Ф00001-04), for the WHOLE history
--     (the first load is valid from '-infinity'). BioNatural items are costed at Ф00001 production cost,
--     not at the АД Астра inter-company price.
--   * The 69 old CRM products.cost_price values (EUR placeholders, ~3× too high) are ARCHIVED
--     (products_cost_legacy) and REPLACED.
--   * A bundle costs the sum of its components (its approved recipe, product_articles); a gift packed in
--     the parcel is a real cost (a recipe line with role 'gift' is costed like any other).
--   * Costs are business-confidential and visible to OWNERS only (is_business_owner()): every table is
--     service_role only and the api strips the money keys for everyone else.
--
-- Cost is in DENARI (cost_mkd, without VAT) — a deliberate exception to "store EUR": these are Sigma book
-- values. products.cost_price (EUR) becomes a GUARDED MIRROR = the current complete cost_mkd / 61,5 (the
-- frozen peg), written only by product_costs_rebuild().
--
--   article_cost_at(article, at)        the article's cost at a moment: the latest valid_from <= at; on a
--                                       tie the owner's value wins, then CalcBuyPrice, then the newest row
--   product_cost_at(product, at)        Σ qty × article_cost_at over the product's APPROVED recipe lines
--                                       valid at that moment; NULL when the recipe is missing or any line's
--                                       article has no cost (incomplete). An exempt product (delivery,
--                                       ПОЕН, flyers — product_stock_exempt) costs 0.
--   product_costs_rebuild(actor, archive_legacy)
--                                       rebuilds product_cost_history (intervals where the recipe and every
--                                       article cost are constant; complete = every line costed), archives
--                                       the legacy products.cost_price ONCE (every product, all values) and
--                                       writes the mirror — never before the legacy is archived
--   stock_article_costs_import(rows, valid_from, source_ref, actor, dry)
--                                       the Sigma load ({code, cost_mkd, source, basis, source_ref, flags} —
--                                       a row's own source_ref wins over the call's); append-only:
--                                       an existing (article, valid_from, source) is never overwritten
--                                       (unchanged / conflict); rows without a cost (basis none, 0, NULL)
--                                       and unknown articles are reported, never invented. DRY by default.
--   stock_article_cost_set(article, cost_mkd, valid_from, note, actor)
--                                       an owner's cost (source owner), then the rebuild; audited
--   tg_products_cost_guard              products.cost_price changes only with elyon.cost_write = 'on'
--                                       (product_costs_rebuild); an INSERT may carry 0 only
--
-- Every writer is SECURITY DEFINER, service_role only, sets the transaction-local elyon.stock_write = 'on'
-- (the contract's write gate on the stock tables) and writes one audit_log row.
-- The TABLES come from 20260945000100_stock_v2_schema.sql (workstream E) — this migration refuses to run
-- without them. Nothing here changes a report by itself: insights_profit() reads the history only once
-- 20260945000800 is applied AND app_settings.stock_v2.profit.cost_source = 'sigma'.
--
-- Apply order: 0100 (tables) → this → scripts/stock/costs-apply.mjs (DRY, then --apply) → 0800.
-- Rollback: DROP the six functions and the trigger; products.cost_price can be restored from
-- products_cost_legacy (UPDATE … SET cost_price = l.cost_price_eur with SET LOCAL elyon.cost_write = 'on').

BEGIN;

SET LOCAL lock_timeout = '10s';

-- ── 0. preconditions + drift guard ─────────────────────────────────────────────────────────────────
DO $pre$
DECLARE v_missing text; v_bad text;
BEGIN
  SELECT string_agg(t, ', ' ORDER BY t) INTO v_missing
    FROM unnest(ARRAY['public.stock_articles', 'public.product_articles', 'public.stock_article_costs',
                      'public.product_cost_history', 'public.products_cost_legacy', 'public.product_stock_exempt']) AS t
   WHERE to_regclass(t) IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'stock v2 costs: % missing — apply 20260945000100_stock_v2_schema.sql first', v_missing;
  END IF;
  -- the functions below are new: if one exists already it must be THIS migration's body (a re-run)
  SELECT string_agg(e.sig, ', ' ORDER BY e.sig) INTO v_bad
  FROM (VALUES
    ('public.article_cost_at(text,timestamp with time zone)', 'a4b226685b65173c95895b1d83523698'),
    ('public.product_cost_at(uuid,timestamp with time zone)', '16a180364eba4be0931b028bb34339f2'),
    ('public.product_costs_rebuild(uuid,boolean)', '7955a1d34c9858ac64adc1c0d6eb6f59'),
    ('public.stock_article_costs_import(jsonb,timestamp with time zone,text,uuid,boolean)', 'fa51909520de156c3c9ba695dd2610d7'),
    ('public.stock_article_cost_set(text,numeric,timestamp with time zone,text,uuid)', 'aaccc8997f89e42492b6a97731a89445'),
    ('public.tg_products_cost_guard()', 'c382f69179764274bced7706763938ec')
  ) e(sig, new_md5)
  JOIN pg_proc p ON p.oid = to_regprocedure(e.sig)
  WHERE md5(replace(p.prosrc, chr(13), '')) <> e.new_md5;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'stock v2 costs: % exists with another body — re-emit this migration from the live one', v_bad;
  END IF;
END
$pre$;

-- ── 1. the cost of an article at a moment ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.article_cost_at(p_article text, p_at timestamp with time zone)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT c.cost_mkd
    FROM public.stock_article_costs c
   WHERE c.article_code = p_article
     AND c.valid_from <= coalesce(p_at, now())
   ORDER BY c.valid_from DESC,
            (c.source = 'owner') DESC,
            (c.source = 'sigma_calcbuyprice') DESC,
            c.recorded_at DESC,
            c.id DESC
   LIMIT 1
$fn$;

COMMENT ON FUNCTION public.article_cost_at(text, timestamp with time zone) IS
  'The purchase cost (денари, without VAT) of a stock article at a moment: the stock_article_costs row with the latest valid_from <= p_at (NULL p_at = now); on a tie the owner''s value wins, then Sigma CalcBuyPrice, then the newest recorded. NULL = no cost on file. Owners only (service_role). Owner decision 01.10.2026, migration 20260945000600.';

-- ── 2. the cost of a product at a moment (its approved recipe) ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.product_cost_at(p_product uuid, p_at timestamp with time zone)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM public.product_stock_exempt e WHERE e.product_id = p_product) THEN 0::numeric
    ELSE (SELECT CASE WHEN count(*) = 0 OR bool_or(x.u IS NULL) THEN NULL ELSE round(sum(x.qty * x.u), 4) END
            FROM (SELECT pa.qty, public.article_cost_at(pa.article_code, coalesce(p_at, now())) AS u
                    FROM public.product_articles pa
                   WHERE pa.product_id = p_product
                     AND pa.status = 'approved'
                     AND pa.valid_from <= coalesce(p_at, now())
                     AND (pa.valid_to IS NULL OR pa.valid_to > coalesce(p_at, now()))) x)
  END
$fn$;

COMMENT ON FUNCTION public.product_cost_at(uuid, timestamp with time zone) IS
  'The purchase cost (денари) of one unit of a product at a moment: Σ qty × article_cost_at() over its APPROVED recipe lines (product_articles) valid then — a bundle = its components, a packed gift line included. NULL when there is no approved recipe or a line''s article has no cost (incomplete); 0 for a product_stock_exempt product. Owners only. Migration 20260945000600.';

-- ── 3. the rebuild: product_cost_history + the legacy archive + the mirror ─────────────────────────
CREATE OR REPLACE FUNCTION public.product_costs_rebuild(p_actor uuid, p_archive_legacy boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_email text;
  v_now timestamptz := now();
  v_before text;
  v_after text;
  v_rows int;
  v_products int;
  v_complete int;
  v_incomplete int;
  v_exempt int;
  v_uncosted_articles int;
  v_archived_before boolean;
  v_archived int := 0;
  v_archived_nonzero int := 0;
  v_mirror int := 0;
  v_mirror_state text;
  v_prev_keep text;
  v_out jsonb;
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'actor is required' USING ERRCODE = '22023';
  END IF;
  -- one rebuild at a time (an owner's cost and the Sigma load may race)
  PERFORM pg_advisory_xact_lock(hashtext('elyon.product_costs_rebuild'));
  SELECT u.email INTO v_email FROM auth.users u WHERE u.id = p_actor;

  SELECT md5(coalesce(string_agg(h.product_id::text || '|' || h.valid_from::text || '|' || coalesce(h.valid_to::text, '')
                                 || '|' || coalesce(h.cost_mkd::text, '') || '|' || h.complete::text, ';'
                                 ORDER BY h.product_id, h.valid_from), ''))
    INTO v_before FROM public.product_cost_history h;

  PERFORM set_config('elyon.stock_write', 'on', true);
  DELETE FROM public.product_cost_history;

  INSERT INTO public.product_cost_history (product_id, valid_from, valid_to, cost_mkd, complete, components)
  WITH ap AS (       -- the approved recipe lines (an exempt product carries no goods)
    SELECT pa.product_id, pa.article_code, pa.qty, pa.role, pa.valid_from, pa.valid_to
      FROM public.product_articles pa
     WHERE pa.status = 'approved'
       AND (pa.valid_to IS NULL OR pa.valid_to > pa.valid_from)
       AND NOT EXISTS (SELECT 1 FROM public.product_stock_exempt e WHERE e.product_id = pa.product_id)
  ),
  bp AS (            -- every moment a product's cost may change: a recipe line starts / ends, an article cost starts
    SELECT ap.product_id, ap.valid_from AS b FROM ap
    UNION
    SELECT ap.product_id, ap.valid_to FROM ap WHERE ap.valid_to IS NOT NULL
    UNION
    SELECT ap.product_id, c.valid_from FROM ap JOIN public.stock_article_costs c ON c.article_code = ap.article_code
  ),
  iv AS (
    SELECT bp.product_id, bp.b AS vf, lead(bp.b) OVER (PARTITION BY bp.product_id ORDER BY bp.b) AS vt FROM bp
  ),
  calc AS (          -- the cost on each interval (Σ of the costed lines; complete = every line costed)
    SELECT iv.product_id, iv.vf, iv.vt, x.cost, x.complete, x.components
      FROM iv
     CROSS JOIN LATERAL (
       SELECT count(*) AS n,
              round(sum(l.qty * l.u), 4) AS cost,
              bool_and(l.u IS NOT NULL) AS complete,
              jsonb_agg(jsonb_build_object('code', l.article_code, 'qty', l.qty, 'role', l.role, 'unit_mkd', l.u)
                        ORDER BY l.article_code) AS components
         FROM (SELECT ap.article_code, ap.qty, ap.role, public.article_cost_at(ap.article_code, iv.vf) AS u
                 FROM ap
                WHERE ap.product_id = iv.product_id
                  AND ap.valid_from <= iv.vf AND (ap.valid_to IS NULL OR ap.valid_to > iv.vf)) l
     ) x
     WHERE x.n > 0
  ),
  isl AS (           -- neighbours with the same cost and components are one interval
    SELECT calc.*,
           CASE WHEN lag(calc.vt) OVER w = calc.vf
                 AND lag(calc.cost) OVER w IS NOT DISTINCT FROM calc.cost
                 AND lag(calc.complete) OVER w = calc.complete
                 AND lag(calc.components) OVER w = calc.components
                THEN 0 ELSE 1 END AS brk
      FROM calc WINDOW w AS (PARTITION BY calc.product_id ORDER BY calc.vf)
  ),
  grp AS (
    SELECT isl.*, sum(isl.brk) OVER (PARTITION BY isl.product_id ORDER BY isl.vf) AS gid FROM isl
  )
  SELECT grp.product_id, min(grp.vf), (array_agg(grp.vt ORDER BY grp.vf DESC))[1],
         (array_agg(grp.cost ORDER BY grp.vf))[1], bool_and(grp.complete), (array_agg(grp.components ORDER BY grp.vf))[1]
    FROM grp
   GROUP BY grp.product_id, grp.gid
  UNION ALL
  SELECT e.product_id, '-infinity'::timestamptz, NULL::timestamptz, 0::numeric, true,
         jsonb_build_array(jsonb_build_object('exempt', true, 'reason', e.reason))
    FROM public.product_stock_exempt e;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  SELECT md5(coalesce(string_agg(h.product_id::text || '|' || h.valid_from::text || '|' || coalesce(h.valid_to::text, '')
                                 || '|' || coalesce(h.cost_mkd::text, '') || '|' || h.complete::text, ';'
                                 ORDER BY h.product_id, h.valid_from), '')),
         count(DISTINCT h.product_id)
    INTO v_after, v_products FROM public.product_cost_history h;

  SELECT count(*) FILTER (WHERE h.complete), count(*) FILTER (WHERE NOT h.complete)
    INTO v_complete, v_incomplete
    FROM public.product_cost_history h
   WHERE h.valid_from <= v_now AND (h.valid_to IS NULL OR h.valid_to > v_now);
  SELECT count(*) INTO v_exempt FROM public.product_stock_exempt;
  SELECT count(DISTINCT pa.article_code) INTO v_uncosted_articles
    FROM public.product_articles pa
   WHERE pa.status = 'approved' AND pa.valid_from <= v_now AND (pa.valid_to IS NULL OR pa.valid_to > v_now)
     AND public.article_cost_at(pa.article_code, v_now) IS NULL;

  -- the legacy CRM costs are archived ONCE, every product (0 included), before anything overwrites them
  v_archived_before := EXISTS (SELECT 1 FROM public.products_cost_legacy);
  IF p_archive_legacy AND NOT v_archived_before THEN
    INSERT INTO public.products_cost_legacy (product_id, cost_price_eur, archived_at, archived_by)
    SELECT p.id, p.cost_price, v_now, p_actor FROM public.products p;
    GET DIAGNOSTICS v_archived = ROW_COUNT;
    SELECT count(*) INTO v_archived_nonzero FROM public.products_cost_legacy l WHERE coalesce(l.cost_price_eur, 0) <> 0;
  END IF;

  -- the mirror (EUR, frozen peg): the current complete cost, else 0 — never over an unarchived legacy value
  IF v_archived_before OR v_archived > 0 THEN
    v_prev_keep := current_setting('elyon.keep_updated_at', true);
    PERFORM set_config('elyon.cost_write', 'on', true);
    PERFORM set_config('elyon.keep_updated_at', 'on', true);
    WITH cur AS (
      SELECT p.id,
             coalesce((SELECT round(h.cost_mkd / 61.5, 6)
                         FROM public.product_cost_history h
                        WHERE h.product_id = p.id AND h.complete
                          AND h.valid_from <= v_now AND (h.valid_to IS NULL OR h.valid_to > v_now)), 0) AS eur
        FROM public.products p
    )
    UPDATE public.products p SET cost_price = cur.eur
      FROM cur
     WHERE cur.id = p.id AND p.cost_price IS DISTINCT FROM cur.eur;
    GET DIAGNOSTICS v_mirror = ROW_COUNT;
    PERFORM set_config('elyon.cost_write', 'off', true);
    PERFORM set_config('elyon.keep_updated_at', coalesce(v_prev_keep, ''), true);
    v_mirror_state := 'written';
  ELSE
    v_mirror_state := 'skipped_legacy_not_archived';
  END IF;
  PERFORM set_config('elyon.stock_write', 'off', true);

  v_out := jsonb_build_object(
    'ok', true,
    'rows', v_rows,
    'products', v_products,
    'complete_now', v_complete,
    'incomplete_now', v_incomplete,
    'exempt', v_exempt,
    'uncosted_articles_now', v_uncosted_articles,
    'changed', v_before IS DISTINCT FROM v_after,
    'legacy_archived', v_archived,
    'legacy_archived_nonzero', v_archived_nonzero,
    'legacy_was_archived', v_archived_before,
    'mirror', v_mirror_state,
    'mirror_updated', v_mirror
  );

  IF v_before IS DISTINCT FROM v_after OR v_archived > 0 OR v_mirror > 0 THEN
    INSERT INTO audit_log (actor_id, actor_email, action, target_type, target_id, target_name, payload)
    VALUES (p_actor, v_email, 'stock.product_costs_rebuild', 'product_cost_history', NULL, 'Sigma purchase costs', v_out);
  END IF;
  RETURN v_out;
END
$fn$;

COMMENT ON FUNCTION public.product_costs_rebuild(uuid, boolean) IS
  'Rebuilds product_cost_history from the approved recipes (product_articles) and the article costs (stock_article_costs): one row per interval where the recipe and every cost are constant, complete = every line costed, components = the lines and their unit costs. With p_archive_legacy it archives products.cost_price into products_cost_legacy ONCE (every product), then writes the mirror products.cost_price = current complete cost_mkd / 61.5 (0 without one) — never while the legacy is unarchived. Audited (stock.product_costs_rebuild). Owner decision 01.10.2026, migration 20260945000600.';

-- ── 4. the Sigma load ──────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.stock_article_costs_import(p_rows jsonb, p_valid_from timestamp with time zone,
                                                           p_source_ref text, p_actor uuid, p_dry boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_email text;
  v_ref text := nullif(btrim(coalesce(p_source_ref, '')), '');
  v_dry boolean := coalesce(p_dry, true);
  v_out jsonb;
  v_inserted int := 0;
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'actor is required' USING ERRCODE = '22023';
  END IF;
  IF p_valid_from IS NULL THEN
    RAISE EXCEPTION 'valid_from is required (the first Sigma load uses -infinity)' USING ERRCODE = '22023';
  END IF;
  IF v_ref IS NULL OR length(v_ref) > 200 THEN
    RAISE EXCEPTION 'source_ref is required (max 200), e.g. "Sigma StockObject 2026-09-29"' USING ERRCODE = '22023';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'rows must be a JSON array of {code, cost_mkd, source, basis, flags}' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_rows) > 50000 THEN
    RAISE EXCEPTION 'at most 50000 rows per call' USING ERRCODE = '22023';
  END IF;
  SELECT u.email INTO v_email FROM auth.users u WHERE u.id = p_actor;

  PERFORM set_config('elyon.stock_write', 'on', true);
  WITH src AS (
    SELECT e.ord,
           nullif(btrim(e.value ->> 'code'), '') AS code,
           CASE WHEN jsonb_typeof(e.value -> 'cost_mkd') = 'number' THEN (e.value ->> 'cost_mkd')::numeric
                WHEN btrim(e.value ->> 'cost_mkd') ~ '^[0-9]+([.][0-9]+)?$' THEN btrim(e.value ->> 'cost_mkd')::numeric
           END AS cost,
           coalesce(nullif(btrim(e.value ->> 'source'), ''), 'sigma_calcbuyprice') AS source,
           nullif(btrim(e.value ->> 'basis'), '') AS basis,
           -- a row's own provenance wins (the Sigma file names its StockObject / bucket); else the call's
           left(coalesce(nullif(btrim(e.value ->> 'source_ref'), ''), v_ref), 200) AS ref,
           CASE WHEN jsonb_typeof(e.value -> 'flags') = 'array'
                THEN ARRAY(SELECT left(f, 60) FROM jsonb_array_elements_text(e.value -> 'flags') AS f LIMIT 20)
                ELSE '{}'::text[] END AS flags
      FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS e(value, ord)
  ),
  cls AS (
    SELECT src.*,
           CASE
             WHEN src.code IS NULL OR NOT (src.code ~ '^[0-9]{6}$' OR src.code ~ '^L[0-9]{5}$') THEN 'invalid'
             WHEN src.source NOT IN ('sigma_calcbuyprice', 'sigma_last_buyprice') THEN 'invalid'
             WHEN count(*) OVER (PARTITION BY src.code, src.source) > 1 THEN 'duplicate'
             -- never invent a cost: no value, 0 (Sigma's "no purchase price") or basis none are reported
             WHEN src.cost IS NULL OR src.cost <= 0 OR src.basis = 'none' THEN 'no_cost'
             WHEN src.cost >= 1000000000 THEN 'invalid'
             WHEN NOT EXISTS (SELECT 1 FROM public.stock_articles a WHERE a.code = src.code) THEN 'unknown_article'
             WHEN ex.cost_mkd IS NULL THEN 'insert'
             WHEN ex.cost_mkd = round(src.cost, 4) THEN 'unchanged'
             ELSE 'conflict'                -- append-only: the existing row stays
           END AS verdict
      FROM src
      LEFT JOIN public.stock_article_costs ex
        ON ex.article_code = src.code AND ex.valid_from = p_valid_from AND ex.source = src.source
  ),
  ins AS (
    INSERT INTO public.stock_article_costs (article_code, cost_mkd, valid_from, source, basis, source_ref, flags, recorded_by, recorded_at)
    SELECT cls.code, round(cls.cost, 4), p_valid_from, cls.source, cls.basis, cls.ref, cls.flags, p_actor, now()
      FROM cls
     WHERE cls.verdict = 'insert' AND NOT v_dry
    RETURNING 1
  ),
  smp AS (           -- up to 20 codes per verdict (codes only — never a cost in the answer)
    SELECT c.verdict, jsonb_agg(coalesce(c.code, '#' || c.ord::text) ORDER BY c.ord) FILTER (WHERE c.rn <= 20) AS codes, count(*) AS n
      FROM (SELECT cls.*, row_number() OVER (PARTITION BY cls.verdict ORDER BY cls.ord) AS rn FROM cls) c
     GROUP BY c.verdict
  )
  SELECT jsonb_build_object(
           'dry', v_dry,
           'valid_from', p_valid_from,
           'source_ref', v_ref,
           'rows', (SELECT count(*) FROM cls),
           'insert', coalesce((SELECT n FROM smp WHERE verdict = 'insert'), 0),
           'inserted', (SELECT count(*) FROM ins),
           'unchanged', coalesce((SELECT n FROM smp WHERE verdict = 'unchanged'), 0),
           'conflict', coalesce((SELECT n FROM smp WHERE verdict = 'conflict'), 0),
           'no_cost', coalesce((SELECT n FROM smp WHERE verdict = 'no_cost'), 0),
           'unknown_article', coalesce((SELECT n FROM smp WHERE verdict = 'unknown_article'), 0),
           'duplicate', coalesce((SELECT n FROM smp WHERE verdict = 'duplicate'), 0),
           'invalid', coalesce((SELECT n FROM smp WHERE verdict = 'invalid'), 0),
           'samples', coalesce((SELECT jsonb_object_agg(smp.verdict, smp.codes) FROM smp WHERE smp.verdict <> 'insert'), '{}'::jsonb)
         )
    INTO v_out;
  PERFORM set_config('elyon.stock_write', 'off', true);

  v_inserted := (v_out ->> 'inserted')::int;
  IF v_inserted > 0 THEN
    INSERT INTO audit_log (actor_id, actor_email, action, target_type, target_id, target_name, payload)
    VALUES (p_actor, v_email, 'stock.article_costs_import', 'stock_article_costs', NULL, v_ref, v_out);
  END IF;
  RETURN v_out;
END
$fn$;

COMMENT ON FUNCTION public.stock_article_costs_import(jsonb, timestamp with time zone, text, uuid, boolean) IS
  'Loads Sigma purchase costs ({code, cost_mkd, source sigma_calcbuyprice|sigma_last_buyprice, basis, source_ref, flags}; a row''s own source_ref wins over p_source_ref) into stock_article_costs at p_valid_from (the first load: -infinity). Append-only: an existing (article, valid_from, source) is never overwritten (unchanged / conflict); no cost, unknown articles, duplicates and invalid rows are counted and sampled (codes only). DRY by default; audited (stock.article_costs_import). Run product_costs_rebuild() after. Migration 20260945000600.';

-- ── 5. an owner's cost ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.stock_article_cost_set(p_article text, p_cost_mkd numeric, p_valid_from timestamp with time zone,
                                                       p_note text, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_email text;
  v_code text := nullif(btrim(coalesce(p_article, '')), '');
  v_at timestamptz := coalesce(p_valid_from, now());
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_name text;
  v_from numeric;
  v_products int;
  v_rebuild jsonb;
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'actor is required' USING ERRCODE = '22023';
  END IF;
  IF p_cost_mkd IS NULL OR p_cost_mkd < 0 OR p_cost_mkd >= 1000000000 THEN
    RAISE EXCEPTION 'cost_mkd must be a number of денари >= 0' USING ERRCODE = '22023';
  END IF;
  IF v_note IS NOT NULL AND length(v_note) > 500 THEN
    RAISE EXCEPTION 'note is too long (max 500)' USING ERRCODE = '22023';
  END IF;
  SELECT a.name INTO v_name FROM public.stock_articles a WHERE a.code = v_code;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown article %', coalesce(v_code, '∅') USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.stock_article_costs c
              WHERE c.article_code = v_code AND c.valid_from = v_at AND c.source = 'owner') THEN
    RAISE EXCEPTION 'an owner cost for % from % already exists — set it from a later moment', v_code, v_at USING ERRCODE = '22023';
  END IF;
  SELECT u.email INTO v_email FROM auth.users u WHERE u.id = p_actor;
  v_from := public.article_cost_at(v_code, v_at);

  PERFORM set_config('elyon.stock_write', 'on', true);
  INSERT INTO public.stock_article_costs (article_code, cost_mkd, valid_from, source, basis, source_ref, flags, recorded_by, recorded_at)
  VALUES (v_code, round(p_cost_mkd, 4), v_at, 'owner', 'owner', left(coalesce('owner: ' || v_note, 'owner'), 200), '{}', p_actor, now());
  PERFORM set_config('elyon.stock_write', 'off', true);

  SELECT count(DISTINCT pa.product_id) INTO v_products
    FROM public.product_articles pa WHERE pa.article_code = v_code AND pa.status = 'approved';
  v_rebuild := public.product_costs_rebuild(p_actor, false);

  INSERT INTO audit_log (actor_id, actor_email, action, target_type, target_id, target_name, payload)
  VALUES (p_actor, v_email, 'stock.article_cost_set', 'stock_article', v_code, v_name,
          jsonb_build_object('from_mkd', v_from, 'to_mkd', round(p_cost_mkd, 4), 'valid_from', v_at, 'note', v_note,
                             'products', v_products, 'rebuild', v_rebuild));
  RETURN jsonb_build_object('ok', true, 'article', v_code, 'name', v_name, 'from_mkd', v_from, 'cost_mkd', round(p_cost_mkd, 4),
                            'valid_from', v_at, 'products', v_products, 'rebuild', v_rebuild);
END
$fn$;

COMMENT ON FUNCTION public.stock_article_cost_set(text, numeric, timestamp with time zone, text, uuid) IS
  'An owner''s purchase cost for one article (source owner — wins a tie with Sigma) from p_valid_from (NULL = now), then product_costs_rebuild(). Append-only: the same article and moment twice is refused. Audited (stock.article_cost_set). Feeds POST /api/stock/v2/article-cost (owners). Migration 20260945000600.';

-- ── 6. the guard: products.cost_price is the mirror ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tg_products_cost_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF coalesce(NEW.cost_price, 0) = 0 THEN
      RETURN NEW;
    END IF;
  ELSIF NEW.cost_price IS NOT DISTINCT FROM OLD.cost_price THEN
    RETURN NEW;
  END IF;
  IF coalesce(current_setting('elyon.cost_write', true), '') <> 'on' THEN
    RAISE EXCEPTION 'products.cost_price is the mirror of the Sigma purchase cost — written only by product_costs_rebuild() (set the cost on the article or the recipe; owner 01.10.2026)'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS trg_products_cost_guard ON public.products;
CREATE TRIGGER trg_products_cost_guard
  BEFORE INSERT OR UPDATE OF cost_price
  ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.tg_products_cost_guard();

COMMENT ON COLUMN public.products.cost_price IS
  'MIRROR (EUR, frozen 61.5 peg) of the product''s current complete Sigma purchase cost: product_cost_history.cost_mkd / 61.5, 0 without one. Written only by product_costs_rebuild() (trg_products_cost_guard). The CRM''s own values before 01.10.2026 are in products_cost_legacy. Owner decision 01.10.2026, migration 20260945000600.';

-- ── 7. grants: service_role only; the read-only harness may read costs ────────────────────────────
REVOKE ALL ON FUNCTION public.article_cost_at(text, timestamp with time zone) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.product_cost_at(uuid, timestamp with time zone) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.product_costs_rebuild(uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.stock_article_costs_import(jsonb, timestamp with time zone, text, uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.stock_article_cost_set(text, numeric, timestamp with time zone, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tg_products_cost_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.article_cost_at(text, timestamp with time zone) TO service_role;
GRANT EXECUTE ON FUNCTION public.product_cost_at(uuid, timestamp with time zone) TO service_role;
GRANT EXECUTE ON FUNCTION public.product_costs_rebuild(uuid, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.stock_article_costs_import(jsonb, timestamp with time zone, text, uuid, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.stock_article_cost_set(text, numeric, timestamp with time zone, text, uuid) TO service_role;

DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    GRANT EXECUTE ON FUNCTION public.article_cost_at(text, timestamp with time zone) TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.product_cost_at(uuid, timestamp with time zone) TO supabase_read_only_user;
  END IF;
END
$grant$;

NOTIFY pgrst, 'reload schema';

COMMIT;
