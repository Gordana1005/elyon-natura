-- Every product to its KIND (owner feedback 01.10.2026, "Производи 2.0", point 1).
--
-- The owner: /products shows too much in one list — 706 rows where bundles, promotions, gifts and
-- objects (a body scale, blender, toaster, shakers …) sit next to the products. The first thing the
-- page shows must be the ordinary PRODUCTS (single supplements and cosmetics sold as products);
-- everything else is categorised, with chips:
--   product  Производи            — a single product (the default view)
--   bundle   Пакети и промоции    — "+", 1+1, 2+1, 2x, 3x, сет, PACK, Combo, пакет, гратис, подарок …
--   gift     Подароци             — an item used as a free gift
--   other    Друго                — a physical object that is not a supplement (вага, блендер, тостер,
--                                   шејкер / маталка, jade roller, масажер …)
--   NULL     Неодредено
-- Nothing reads the kind but /products (no report, no order, no money, no stock).
--
--   products.kind / kind_set_by / kind_set_at
--   product_kind_by_name(name)   the NAME classifier, immutable: {kind, reason, hit}. First rule that
--                                fires: promo (1+1, 30+30) → bundle word (сет/set as a word, pack, пакет,
--                                combo, gratis, подар…, gift, box) → multi pack (2x / 3х, or a leading
--                                count "2 СНАИЛ …" but not "5 in 1") → a "+" joining another item (a "+"
--                                between two nutrients of one formula — MAGNESIUM+B6, D3+K2+BOR — does not
--                                count; every part an object → other, else bundle) → an object word (mk,
--                                en, sq, bg) → a single product.
--   product_kind_proposal()      the suggestion per product: the name, and for a single product whose
--                                order lines are mostly FREE (0 ден in an order with a paid line of
--                                another product) a gift — ≥ 60 % of ≥ 20 lines, sure from ≥ 90 % of ≥ 30.
--                                An object stays "other" even when given away (owner: shakers are Друго).
--                                `auto` = undecided and sure: what "accept all sure" and
--                                scripts/apply-product-kinds.mjs may set.
--   products_set_kind(ids, kind, actor)
--                                the ONLY writer of the three columns (a guard trigger refuses any
--                                other write), one audit_log row per call. kind NULL = back to Неодредено.
--
-- The regex sources are copied VERBATIM from supabase/functions/api/productsCatalog.ts (its twin
-- classifyKindByName / proposeKind); productsCatalog.test.ts reads this file and fails on drift.
-- Everything is service_role only (the api edge function: GET /products/kind-proposal and
-- POST /products/kind, admins + owners). GET /products returns the column — a kind is not money.

-- ── 1. the columns ────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS kind text,
  ADD COLUMN IF NOT EXISTS kind_set_by uuid,
  ADD COLUMN IF NOT EXISTS kind_set_at timestamptz;

ALTER TABLE public.products DROP CONSTRAINT IF EXISTS products_kind_check;
ALTER TABLE public.products
  ADD CONSTRAINT products_kind_check
  CHECK (kind IS NULL OR kind IN ('product', 'bundle', 'gift', 'other'));

COMMENT ON COLUMN public.products.kind IS
  'What the row is on /products: product | bundle (Пакети и промоции) | gift (Подароци) | other (Друго, a physical object); NULL = Неодредено. Written only by products_set_kind() (audited). Migration 20260943001400.';
COMMENT ON COLUMN public.products.kind_set_by IS 'auth user id of the login that last set kind (products_set_kind).';
COMMENT ON COLUMN public.products.kind_set_at IS 'When kind was last set (products_set_kind).';

-- ── 2. the guard: one audited writer ──────────────────────────────────────────────────────────────
-- products is writable by admins and managers straight through PostgREST, so without this a kind
-- could change with no audit row. products_set_kind() opens the gate with a transaction-local setting.
CREATE OR REPLACE FUNCTION public.tg_products_kind_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.kind IS NULL AND NEW.kind_set_by IS NULL AND NEW.kind_set_at IS NULL THEN
      RETURN NEW;
    END IF;
  ELSIF NEW.kind IS NOT DISTINCT FROM OLD.kind
    AND NEW.kind_set_by IS NOT DISTINCT FROM OLD.kind_set_by
    AND NEW.kind_set_at IS NOT DISTINCT FROM OLD.kind_set_at THEN
    RETURN NEW;
  END IF;
  IF coalesce(current_setting('elyon.kind_write', true), '') <> 'on' THEN
    RAISE EXCEPTION 'products.kind is written only by products_set_kind() (audited)'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS trg_products_kind_guard ON public.products;
CREATE TRIGGER trg_products_kind_guard
  BEFORE INSERT OR UPDATE OF kind, kind_set_by, kind_set_at ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.tg_products_kind_guard();

-- ── 3. the name classifier ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.product_kind_by_name(p_name text)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $fn$
DECLARE
  -- KIND_RE_* of supabase/functions/api/productsCatalog.ts, verbatim
  re_promo        constant text := '[0-9]+\s*\+\s*[0-9]+';
  re_bundle_word  constant text := 'pack|пакет|paket|combo|комбо|gratis|гратис|подар|podar|gift|box|(^|[^a-zа-яѐ-џ])(сет|set)([^a-zа-яѐ-џ]|$)';
  re_multi_pack   constant text := '(^|[^a-zа-яѐ-џ0-9])[2-9]\s*[xх×]\s|^[2-9]\s+(?!(in|во)\s)(?=[a-zа-яѐ-џ])';
  re_nutrient_plus constant text := '(?<![a-zа-яѐ-џ0-9])(a|b|c|d|e|k|б|ц|д|е|к|b[0-9]{1,2}|б[0-9]{1,2}|d3|д3|k2|к2|zinc|zink|цинк|bor|бор|magnesium|магнезиум|магнесиум|chromium|хром|selenium|селен|eisen|iron|железо|calcium|калциум|folic)\s*\+\s*(?=(a|b|c|d|e|k|б|ц|д|е|к|b[0-9]{1,2}|б[0-9]{1,2}|d3|д3|k2|к2|zinc|zink|цинк|bor|бор|magnesium|магнезиум|магнесиум|chromium|хром|selenium|селен|eisen|iron|железо|calcium|калциум|folic)(?![a-zа-яѐ-џ0-9]))';
  re_joiner       constant text := '\+\s*([0-9]+\s*[xх×]?\s*)?[a-zа-яѐ-џ][a-zа-яѐ-џ0-9.-]';
  re_object       constant text := 'везна|scale|peshore|бленде|blender|тостер|toaster|миксер|mixer|шејкер|шейкер|shaker|маталк|matalk|мерач|правосм|vacuum|fshes|фигаро|пегла|ютия|телевизор|television|televizor|телефон|phone|соковник|сокоизстисквачка|juicer|бокал|kettle|глукометар|глюкомер|glucometer|термометар|термометър|thermometer|termometer|оксиметар|оксиметър|oximeter|оксиметер|бастун|маиц|тениск|t-shirt|хеланки|leggings|стегач|бандаж|ќебе|одеяло|blanket|batanij|апарат|бричење|самобръсначка|shaver|машин|yoga|јога|йога|ролер|roller|roler|масажер|масажор|massager|masazhues|gua sha|гуа ша|device|divice|pajisje|постур|posture|sponge|сунѓер|гъба за|тупфер|sharpener|острилк|brush|четк|furç|апликатор|applicator|сецко|chopper|(^|[^a-zа-яѐ-џ])(фен|тава|тиган|таблет|уред|апар|маш)([^a-zа-яѐ-џ]|$)|(^|[^a-zа-яѐ-џ])(вага|решо)';
  re_hit_trim     constant text := '^[^a-zа-яѐ-џ0-9+]+|[^a-zа-яѐ-џ0-9+]+$';
  n text := btrim(regexp_replace(lower(coalesce(p_name, '')), '\s+', ' ', 'g'));
  j text;
  hit text;
  parts text[];
BEGIN
  IF n = '' THEN
    RETURN jsonb_build_object('kind', NULL, 'reason', 'empty_name', 'hit', NULL);
  END IF;

  hit := regexp_substr(n, re_promo);
  IF hit IS NOT NULL THEN
    RETURN jsonb_build_object('kind', 'bundle', 'reason', 'promo', 'hit', coalesce(nullif(regexp_replace(hit, re_hit_trim, '', 'g'), ''), btrim(hit)));
  END IF;
  hit := regexp_substr(n, re_bundle_word);
  IF hit IS NOT NULL THEN
    RETURN jsonb_build_object('kind', 'bundle', 'reason', 'bundle_word', 'hit', coalesce(nullif(regexp_replace(hit, re_hit_trim, '', 'g'), ''), btrim(hit)));
  END IF;
  hit := regexp_substr(n, re_multi_pack);
  IF hit IS NOT NULL THEN
    RETURN jsonb_build_object('kind', 'bundle', 'reason', 'multi_pack', 'hit', coalesce(nullif(regexp_replace(hit, re_hit_trim, '', 'g'), ''), btrim(hit)));
  END IF;

  -- a "+" inside one formula (MAGNESIUM+B6, D3+K2+BOR) is not a joiner
  j := regexp_replace(n, re_nutrient_plus, '\1 & ', 'g');
  IF j ~ re_joiner THEN
    parts := ARRAY(SELECT btrim(x) FROM unnest(regexp_split_to_array(j, '\+')) AS x WHERE btrim(x) <> '');
    IF cardinality(parts) > 0 AND NOT EXISTS (SELECT 1 FROM unnest(parts) AS x WHERE x !~ re_object) THEN
      hit := regexp_substr(n, re_object);
      RETURN jsonb_build_object('kind', 'other', 'reason', 'object_set', 'hit',
        CASE WHEN hit IS NULL THEN NULL ELSE coalesce(nullif(regexp_replace(hit, re_hit_trim, '', 'g'), ''), btrim(hit)) END);
    END IF;
    RETURN jsonb_build_object('kind', 'bundle', 'reason', 'plus_joiner', 'hit', '+');
  END IF;

  hit := regexp_substr(n, re_object);
  IF hit IS NOT NULL THEN
    RETURN jsonb_build_object('kind', 'other', 'reason', 'object_word', 'hit', coalesce(nullif(regexp_replace(hit, re_hit_trim, '', 'g'), ''), btrim(hit)));
  END IF;
  RETURN jsonb_build_object('kind', 'product', 'reason', 'single', 'hit', NULL);
END
$fn$;

COMMENT ON FUNCTION public.product_kind_by_name(text) IS
  'The kind a product NAME says: {kind: product|bundle|other|null, reason: promo|bundle_word|multi_pack|plus_joiner|object_set|object_word|single|empty_name, hit}. Twin of classifyKindByName() in supabase/functions/api/productsCatalog.ts (same regexes, drift-tested). Migration 20260943001400.';

REVOKE ALL ON FUNCTION public.product_kind_by_name(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.product_kind_by_name(text) TO service_role;

-- ── 4. the proposal ───────────────────────────────────────────────────────────────────────────────
-- Every product. A FREE line = 0 ден in an order that has a paid line of ANOTHER product (the gift
-- beside the sale; a 1+1 of the same product does not make it a gift).
CREATE OR REPLACE FUNCTION public.product_kind_proposal()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_rows jsonb;
  v_summary jsonb;
BEGIN
  WITH st AS (
    SELECT oi.product_id AS pid,
           count(*)::int AS lines,
           count(*) FILTER (
             WHERE coalesce(oi.price_per_unit, 0) = 0
               AND EXISTS (SELECT 1 FROM order_items o2
                            WHERE o2.order_id = oi.order_id
                              AND o2.product_id IS DISTINCT FROM oi.product_id
                              AND o2.price_per_unit > 0))::int AS free
      FROM order_items oi
     WHERE oi.product_id IS NOT NULL
     GROUP BY oi.product_id
  ),
  base AS (
    SELECT p.id, p.name, p.sku, p.is_active, p.kind, p.kind_set_at,
           pr.full_name AS set_by_name,
           coalesce(st.lines, 0) AS lines,
           coalesce(st.free, 0) AS free,
           product_kind_by_name(p.name) AS byname
      FROM products p
      LEFT JOIN st ON st.pid = p.id
      LEFT JOIN profiles pr ON pr.user_id = p.kind_set_by
  ),
  shared AS (
    SELECT b.*,
           CASE WHEN b.lines > 0 THEN round(b.free::numeric / b.lines, 4) END AS share
      FROM base b
  ),
  judged AS (
    SELECT s.*,
           coalesce((s.byname ->> 'kind') = 'product' AND s.lines >= 20 AND s.share >= 0.6, false) AS is_gift
      FROM shared s
  ),
  graded AS (
    SELECT j.*,
           CASE WHEN j.is_gift THEN 'gift' ELSE j.byname ->> 'kind' END AS suggested,
           CASE WHEN j.is_gift THEN 'free_in_orders' ELSE j.byname ->> 'reason' END AS reason,
           CASE WHEN j.is_gift THEN NULL ELSE j.byname ->> 'hit' END AS hit,
           CASE WHEN j.is_gift AND NOT (j.share >= 0.9 AND j.lines >= 30) THEN 'low' ELSE 'high' END AS confidence
      FROM judged j
  )
  SELECT
    coalesce(jsonb_agg(jsonb_build_object(
      'id', g.id,
      'name', g.name,
      'sku', g.sku,
      'is_active', g.is_active,
      'kind', g.kind,
      'kind_set_at', g.kind_set_at,
      'kind_set_by_name', g.set_by_name,
      'suggested', g.suggested,
      'confidence', g.confidence,
      'reason', g.reason,
      'hit', g.hit,
      'lines', g.lines,
      'free_lines', g.free,
      'free_share', g.share,
      'auto', (g.kind IS NULL AND g.suggested IS NOT NULL AND g.confidence = 'high')
    ) ORDER BY lower(g.name), g.id), '[]'::jsonb),
    jsonb_build_object(
      'products', count(*),
      'suggested', jsonb_build_object(
        'product', count(*) FILTER (WHERE g.suggested = 'product'),
        'bundle',  count(*) FILTER (WHERE g.suggested = 'bundle'),
        'gift',    count(*) FILTER (WHERE g.suggested = 'gift'),
        'other',   count(*) FILTER (WHERE g.suggested = 'other'),
        'none',    count(*) FILTER (WHERE g.suggested IS NULL)),
      'decided', count(*) FILTER (WHERE g.kind IS NOT NULL),
      'auto',    count(*) FILTER (WHERE g.kind IS NULL AND g.suggested IS NOT NULL AND g.confidence = 'high'),
      'low',     count(*) FILTER (WHERE g.confidence = 'low'),
      'differs', count(*) FILTER (WHERE g.kind IS NOT NULL AND g.suggested IS NOT NULL AND g.kind <> g.suggested)
    )
    INTO v_rows, v_summary
    FROM graded g;

  RETURN jsonb_build_object('generated_at', now(), 'summary', v_summary, 'rows', v_rows);
END
$fn$;

COMMENT ON FUNCTION public.product_kind_proposal() IS
  'The kind suggestion per product: product_kind_by_name(), and a single product whose order lines are ≥ 60 % free (≥ 20 lines; sure from ≥ 90 % of ≥ 30) is a gift. Rows + summary {products, suggested{product,bundle,gift,other,none}, decided, auto, low, differs}. Read-only. Feeds GET /products/kind-proposal and scripts/apply-product-kinds.mjs. Twin of proposeKind() in productsCatalog.ts. Migration 20260943001400.';

REVOKE ALL ON FUNCTION public.product_kind_proposal() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.product_kind_proposal() TO service_role;

-- ── 5. the writer ─────────────────────────────────────────────────────────────────────────────────
-- Sets (or, with p_kind NULL, clears) the kind of up to 1.000 products in one transaction and writes
-- ONE audit_log row (action products.set_kind) with every change. Rows already of that kind are left
-- untouched (no set_by / set_at bump) and reported as unchanged; unknown ids come back as missing.
CREATE OR REPLACE FUNCTION public.products_set_kind(p_ids uuid[], p_kind text, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_ids uuid[];
  v_email text;
  v_changes jsonb;
  v_missing jsonb;
  v_updated int;
  v_found int;
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'actor is required' USING ERRCODE = '22023';
  END IF;
  IF p_kind IS NOT NULL AND p_kind NOT IN ('product', 'bundle', 'gift', 'other') THEN
    RAISE EXCEPTION 'invalid product kind: %', p_kind USING ERRCODE = '22023';
  END IF;
  SELECT coalesce(array_agg(DISTINCT i), '{}') INTO v_ids FROM unnest(p_ids) AS i WHERE i IS NOT NULL;
  IF cardinality(v_ids) = 0 THEN
    RAISE EXCEPTION 'no product ids' USING ERRCODE = '22023';
  END IF;
  IF cardinality(v_ids) > 1000 THEN
    RAISE EXCEPTION 'at most 1000 products per call' USING ERRCODE = '22023';
  END IF;

  SELECT u.email INTO v_email FROM auth.users u WHERE u.id = p_actor;

  SELECT count(*)::int INTO v_found FROM products WHERE id = ANY (v_ids);
  SELECT coalesce(jsonb_agg(i ORDER BY i), '[]'::jsonb) INTO v_missing
    FROM unnest(v_ids) AS i WHERE NOT EXISTS (SELECT 1 FROM products p WHERE p.id = i);

  PERFORM set_config('elyon.kind_write', 'on', true);
  WITH prev AS (
    SELECT p.id, p.name, p.kind AS from_kind
      FROM products p
     WHERE p.id = ANY (v_ids) AND p.kind IS DISTINCT FROM p_kind
       FOR UPDATE
  ),
  upd AS (
    UPDATE products p
       SET kind = p_kind, kind_set_by = p_actor, kind_set_at = now()
      FROM prev
     WHERE p.id = prev.id
    RETURNING p.id
  )
  SELECT count(*)::int,
         coalesce(jsonb_agg(jsonb_build_object('id', prev.id, 'name', prev.name, 'from', prev.from_kind, 'to', p_kind)
                            ORDER BY lower(prev.name), prev.id), '[]'::jsonb)
    INTO v_updated, v_changes
    FROM upd JOIN prev ON prev.id = upd.id;
  PERFORM set_config('elyon.kind_write', 'off', true);

  IF v_updated > 0 THEN
    INSERT INTO audit_log (actor_id, actor_email, action, target_type, target_id, target_name, payload)
    VALUES (
      p_actor, v_email, 'products.set_kind', 'products',
      CASE WHEN v_updated = 1 THEN v_changes -> 0 ->> 'id' END,
      coalesce(p_kind, 'undecided'),
      jsonb_build_object(
        'kind', p_kind,
        'requested', cardinality(v_ids),
        'updated', v_updated,
        'unchanged', v_found - v_updated,
        'missing', v_missing,
        'changes', v_changes
      )
    );
  END IF;

  RETURN jsonb_build_object(
    'kind', p_kind,
    'requested', cardinality(v_ids),
    'updated', v_updated,
    'unchanged', v_found - v_updated,
    'missing', v_missing,
    'changes', v_changes
  );
END
$fn$;

COMMENT ON FUNCTION public.products_set_kind(uuid[], text, uuid) IS
  'The only writer of products.kind / _set_by / _set_at: sets p_kind (NULL = Неодредено) on up to 1000 products, skips rows already of it, one audit_log row (products.set_kind) with every change. Returns {kind, requested, updated, unchanged, missing, changes}. Feeds POST /products/kind and scripts/apply-product-kinds.mjs --apply. Migration 20260943001400.';

REVOKE ALL ON FUNCTION public.products_set_kind(uuid[], text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.products_set_kind(uuid[], text, uuid) TO service_role;
