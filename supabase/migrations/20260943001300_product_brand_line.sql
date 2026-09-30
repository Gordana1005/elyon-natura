-- Every product to its BRAND LINE (plan 30.09.2026, "Фаза 4 — Мапа на производите по линија").
--
-- Owner ruling 30.09.2026: when the CRM itself ships an order via MEX, the product line decides the
-- MEX profile (the team is secondary):
--   Bio Natural  → BIO NATURAL account      Natura Therapy → NATURA account
--   Dr.Becker    → BIO NATURAL account      Ad Astra       → NATURA account
-- (Dr.Becker is new, a few products, "together with BioNatural".) The owner asked for a map of ALL
-- products by line first; the exact shipping rule is refined later (plan Фаза 9). Nothing here ships
-- anything and no report reads the line yet — departments stay decided by the collabBox folder and
-- the MEX profile of the parcel (cohort_order_source), never by this column.
--
--   products.brand_line          natura_therapy | bio_natural | ad_astra | dr_becker, NULL = not yet
--                                decided (the owner decides; nothing guesses a line into it)
--   products.brand_line_set_by   the login that last set it (auth user id)
--   products.brand_line_set_at   when
--   mex_profile_for_line(line)   bio_natural / dr_becker → 'bio_natural'; natura_therapy / ad_astra →
--                                'natura'; anything else → NULL. Immutable.
--   product_brand_line_proposal(p_days)
--                                the suggestion from the parcels of the last p_days days (orders with a
--                                MEX account, by order_items.product_id or orders.product_id, one count
--                                per order): per product the parcels per account, a suggested line, a
--                                confidence and the reason. Precedence: a Dr.Becker / Ad Astra word in
--                                the name (a HINT — the owner confirms) > a Bio Natural ANCHOR name (the
--                                12 products of the `bionatural products/` folder, or BIONATURAL in the
--                                name) > the parcels (≥ 90 % on one account → that account's default
--                                line, bio_natural or natura_therapy; otherwise the majority, low).
--                                An anchor the parcels mostly contradict is a CONFLICT (never auto).
--                                `auto` = what "accept all ≥ 90 %" and scripts/apply-brand-lines.mjs may
--                                set: undecided rows whose confidence is anchor or high.
--   products_set_brand_line(ids, line, actor)
--                                the ONLY writer of the three columns (a guard trigger refuses any other
--                                write), one audit_log row per call. line NULL = back to undecided.
--
-- Everything is service_role only (the api edge function: GET /products/brand-line-proposal and
-- POST /products/brand-line, admins + owners). GET /products (select *) returns the columns to every
-- login that can read products — a line is not money.

-- ── 1. the columns ────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS brand_line text,
  ADD COLUMN IF NOT EXISTS brand_line_set_by uuid,
  ADD COLUMN IF NOT EXISTS brand_line_set_at timestamptz;

ALTER TABLE public.products DROP CONSTRAINT IF EXISTS products_brand_line_check;
ALTER TABLE public.products
  ADD CONSTRAINT products_brand_line_check
  CHECK (brand_line IS NULL OR brand_line IN ('natura_therapy', 'bio_natural', 'ad_astra', 'dr_becker'));

COMMENT ON COLUMN public.products.brand_line IS
  'The product''s brand line: natura_therapy | bio_natural | ad_astra | dr_becker; NULL = not yet decided. Written only by products_set_brand_line() (audited). mex_profile_for_line() maps it to the MEX account. Migration 20260943001300.';
COMMENT ON COLUMN public.products.brand_line_set_by IS 'auth user id of the login that last set brand_line (products_set_brand_line).';
COMMENT ON COLUMN public.products.brand_line_set_at IS 'When brand_line was last set (products_set_brand_line).';

-- ── 2. the guard: one audited writer ──────────────────────────────────────────────────────────────
-- products is writable by admins and managers straight through PostgREST (RLS "… can manage
-- products"), so without this a line could change with no audit row. products_set_brand_line() opens
-- the gate with a transaction-local setting; a maintenance script must do the same deliberately.
CREATE OR REPLACE FUNCTION public.tg_products_brand_line_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.brand_line IS NULL AND NEW.brand_line_set_by IS NULL AND NEW.brand_line_set_at IS NULL THEN
      RETURN NEW;
    END IF;
  ELSIF NEW.brand_line IS NOT DISTINCT FROM OLD.brand_line
    AND NEW.brand_line_set_by IS NOT DISTINCT FROM OLD.brand_line_set_by
    AND NEW.brand_line_set_at IS NOT DISTINCT FROM OLD.brand_line_set_at THEN
    RETURN NEW;
  END IF;
  IF coalesce(current_setting('elyon.brand_line_write', true), '') <> 'on' THEN
    RAISE EXCEPTION 'products.brand_line is written only by products_set_brand_line() (audited)'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS trg_products_brand_line_guard ON public.products;
CREATE TRIGGER trg_products_brand_line_guard
  BEFORE INSERT OR UPDATE OF brand_line, brand_line_set_by, brand_line_set_at ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.tg_products_brand_line_guard();

-- ── 3. line → MEX profile ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mex_profile_for_line(p_line text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $fn$
  SELECT CASE p_line
           WHEN 'bio_natural'    THEN 'bio_natural'
           WHEN 'dr_becker'      THEN 'bio_natural'
           WHEN 'natura_therapy' THEN 'natura'
           WHEN 'ad_astra'       THEN 'natura'
         END;
$fn$;

COMMENT ON FUNCTION public.mex_profile_for_line(text) IS
  'Owner ruling 30.09.2026: the MEX account a brand line ships with — bio_natural / dr_becker → bio_natural (BIO NATURAL), natura_therapy / ad_astra → natura (NATURA); anything else → NULL. Migration 20260943001300.';

REVOKE ALL ON FUNCTION public.mex_profile_for_line(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mex_profile_for_line(text) TO service_role;

-- ── 4. the proposal ───────────────────────────────────────────────────────────────────────────────
-- Population: every product that is active, or had a parcel in the window, or carries an anchor /
-- hint word, or already has a line (287 on 30.09.2026 before any line was set). Names are squashed
-- (lower case, spaces / dots / dashes / underscores removed) before matching, so "Slim Fit",
-- "SLIMFIT", "Dr. Becker" and "Dr.Becker" all match.
CREATE OR REPLACE FUNCTION public.product_brand_line_proposal(p_days integer DEFAULT 180)
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
  IF p_days IS NULL OR p_days < 1 OR p_days > 3650 THEN
    RAISE EXCEPTION 'p_days must be 1..3650' USING ERRCODE = '22023';
  END IF;

  WITH par AS (
    SELECT x.pid,
           count(DISTINCT o.id) FILTER (WHERE o.mex_account = 'bio_natural')::int AS bio,
           count(DISTINCT o.id) FILTER (WHERE o.mex_account = 'natura')::int      AS nat
      FROM orders o
      CROSS JOIN LATERAL (
        SELECT oi.product_id AS pid FROM order_items oi WHERE oi.order_id = o.id AND oi.product_id IS NOT NULL
        UNION
        SELECT o.product_id WHERE o.product_id IS NOT NULL
      ) x
     WHERE o.mex_account IN ('bio_natural', 'natura')
       AND o.created_at >= now() - make_interval(days => p_days)
     GROUP BY x.pid
  ),
  base AS (
    SELECT p.id, p.name, p.sku, p.is_active, p.brand_line, p.brand_line_set_at,
           pr.full_name AS set_by_name,
           coalesce(par.bio, 0) AS bio,
           coalesce(par.nat, 0) AS nat,
           regexp_replace(lower(p.name), '[[:space:]._-]+', '', 'g') AS squashed
      FROM products p
      LEFT JOIN par ON par.pid = p.id
      LEFT JOIN profiles pr ON pr.user_id = p.brand_line_set_by
  ),
  tagged AS (
    SELECT b.*,
           b.bio + b.nat AS parcels,
           substring(b.squashed FROM '(bionatural|бионатурал|adenofrin|аденофрин|alphamale|алфамејл|алфамале|arthrofix|артрофикс|brainfix|браинфикс|cardiofix|кардиофикс|glucofix|глукофикс|hemorofix|хеморофикс|liverfix|ливерфикс|neurofix|неурофикс|parafix|парафикс|prostafix|простафикс|slimfit|слимфит)') AS anchor,
           CASE WHEN b.squashed ~ '(becker|бекер|беккер)' THEN 'dr_becker'
                WHEN b.squashed ~ '(adastra|адастра)'     THEN 'ad_astra' END AS hint
      FROM base b
  ),
  shares AS (
    SELECT t.*,
           CASE WHEN t.parcels = 0 THEN NULL
                WHEN t.bio > t.nat THEN 'bio_natural'
                WHEN t.nat > t.bio THEN 'natura' END AS majority,
           CASE WHEN t.parcels = 0 THEN NULL
                ELSE round(greatest(t.bio, t.nat)::numeric / t.parcels, 4) END AS share,
           CASE WHEN t.parcels = 0 THEN 'none'
                WHEN greatest(t.bio, t.nat)::numeric / t.parcels >= 0.9 THEN 'sure'
                ELSE 'mixed' END AS bucket
      FROM tagged t
     WHERE t.is_active OR t.parcels > 0 OR t.anchor IS NOT NULL OR t.hint IS NOT NULL OR t.brand_line IS NOT NULL
  ),
  decided AS (
    SELECT s.*,
           -- the account a NAME says the product ships with (hint or anchor); NULL for the rest
           CASE WHEN s.hint IS NOT NULL THEN mex_profile_for_line(s.hint)
                WHEN s.anchor IS NOT NULL THEN 'bio_natural' END AS name_profile,
           CASE WHEN s.hint IS NOT NULL THEN s.hint
                WHEN s.anchor IS NOT NULL THEN 'bio_natural'
                WHEN s.majority = 'bio_natural' THEN 'bio_natural'
                WHEN s.majority = 'natura' THEN 'natura_therapy' END AS suggested
      FROM shares s
  ),
  judged AS (
    -- a name the parcels mostly contradict (under half on the name's account) is a conflict
    SELECT d.*,
           coalesce(d.parcels > 0 AND d.name_profile IS NOT NULL
             AND (CASE WHEN d.name_profile = 'bio_natural' THEN d.bio ELSE d.nat END)::numeric / d.parcels < 0.5,
             false) AS conflict
      FROM decided d
  ),
  graded AS (
    SELECT f.*,
           CASE WHEN f.hint IS NOT NULL THEN 'hint'
                WHEN f.anchor IS NOT NULL AND f.conflict THEN 'conflict'
                WHEN f.anchor IS NOT NULL THEN 'anchor'
                WHEN f.bucket = 'sure' THEN 'high'
                WHEN f.bucket = 'mixed' AND f.suggested IS NOT NULL THEN 'low'
                ELSE 'none' END AS confidence,
           CASE WHEN f.hint IS NOT NULL THEN 'hint_name'
                WHEN f.anchor IS NOT NULL AND f.conflict THEN 'anchor_conflict'
                WHEN f.anchor IS NOT NULL THEN 'anchor_name'
                WHEN f.bucket = 'sure' THEN 'parcels_sure'
                WHEN f.bucket = 'mixed' AND f.suggested IS NOT NULL THEN 'parcels_mixed'
                WHEN f.bucket = 'mixed' THEN 'parcels_tie'
                ELSE 'no_parcels' END AS reason
      FROM judged f
  )
  SELECT
    coalesce(jsonb_agg(jsonb_build_object(
      'id', g.id,
      'name', g.name,
      'sku', g.sku,
      'is_active', g.is_active,
      'brand_line', g.brand_line,
      'brand_line_set_at', g.brand_line_set_at,
      'brand_line_set_by_name', g.set_by_name,
      'bio_natural', g.bio,
      'natura', g.nat,
      'parcels', g.parcels,
      'majority', g.majority,
      'share', g.share,
      'bucket', g.bucket,
      'anchor', g.anchor,
      'hint', g.hint,
      'suggested', g.suggested,
      'suggested_profile', mex_profile_for_line(g.suggested),
      'confidence', g.confidence,
      'conflict', g.conflict,
      'reason', g.reason,
      'auto', (g.brand_line IS NULL AND g.confidence IN ('anchor', 'high'))
    ) ORDER BY g.parcels DESC, lower(g.name), g.id), '[]'::jsonb),
    jsonb_build_object(
      'products',   count(*),
      'sure',       count(*) FILTER (WHERE g.bucket = 'sure'),
      'mixed',      count(*) FILTER (WHERE g.bucket = 'mixed'),
      'none',       count(*) FILTER (WHERE g.bucket = 'none'),
      'anchors',    count(*) FILTER (WHERE g.anchor IS NOT NULL AND g.hint IS NULL),
      'conflicts',  count(*) FILTER (WHERE g.conflict),
      'hints',      jsonb_build_object(
                      'ad_astra',  count(*) FILTER (WHERE g.hint = 'ad_astra'),
                      'dr_becker', count(*) FILTER (WHERE g.hint = 'dr_becker')),
      'decided',    count(*) FILTER (WHERE g.brand_line IS NOT NULL),
      'auto',       count(*) FILTER (WHERE g.brand_line IS NULL AND g.confidence IN ('anchor', 'high')),
      'few_parcels_auto', count(*) FILTER (WHERE g.brand_line IS NULL AND g.confidence = 'high' AND g.parcels < 10)
    )
    INTO v_rows, v_summary
    FROM graded g;

  RETURN jsonb_build_object(
    'days', p_days,
    'generated_at', now(),
    'summary', v_summary,
    'rows', v_rows
  );
END
$fn$;

COMMENT ON FUNCTION public.product_brand_line_proposal(integer) IS
  'The brand-line suggestion per product from the MEX parcels of the last p_days days (hint name > Bio Natural anchor name > parcels ≥ 90 % on one account; an anchor the parcels mostly contradict is a conflict). Rows + summary {products, sure, mixed, none, anchors, conflicts, hints, decided, auto}. Read-only. Feeds GET /products/brand-line-proposal and scripts/apply-brand-lines.mjs. Migration 20260943001300.';

REVOKE ALL ON FUNCTION public.product_brand_line_proposal(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.product_brand_line_proposal(integer) TO service_role;

-- ── 5. the writer ─────────────────────────────────────────────────────────────────────────────────
-- Sets (or, with p_line NULL, clears) the line of up to 1.000 products in one transaction and writes
-- ONE audit_log row (action products.set_brand_line) with every change. Rows already on that line are
-- left untouched (no set_by / set_at bump) and reported as unchanged; unknown ids come back as missing.
CREATE OR REPLACE FUNCTION public.products_set_brand_line(p_ids uuid[], p_line text, p_actor uuid)
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
  IF p_line IS NOT NULL AND p_line NOT IN ('natura_therapy', 'bio_natural', 'ad_astra', 'dr_becker') THEN
    RAISE EXCEPTION 'invalid brand line: %', p_line USING ERRCODE = '22023';
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

  PERFORM set_config('elyon.brand_line_write', 'on', true);
  WITH prev AS (
    SELECT p.id, p.name, p.brand_line AS from_line
      FROM products p
     WHERE p.id = ANY (v_ids) AND p.brand_line IS DISTINCT FROM p_line
       FOR UPDATE
  ),
  upd AS (
    UPDATE products p
       SET brand_line = p_line, brand_line_set_by = p_actor, brand_line_set_at = now()
      FROM prev
     WHERE p.id = prev.id
    RETURNING p.id
  )
  SELECT count(*)::int,
         coalesce(jsonb_agg(jsonb_build_object('id', prev.id, 'name', prev.name, 'from', prev.from_line, 'to', p_line)
                            ORDER BY lower(prev.name), prev.id), '[]'::jsonb)
    INTO v_updated, v_changes
    FROM upd JOIN prev ON prev.id = upd.id;
  PERFORM set_config('elyon.brand_line_write', 'off', true);

  IF v_updated > 0 THEN
    INSERT INTO audit_log (actor_id, actor_email, action, target_type, target_id, target_name, payload)
    VALUES (
      p_actor, v_email, 'products.set_brand_line', 'products',
      CASE WHEN v_updated = 1 THEN v_changes -> 0 ->> 'id' END,
      coalesce(p_line, 'undecided'),
      jsonb_build_object(
        'line', p_line,
        'mex_profile', mex_profile_for_line(p_line),
        'requested', cardinality(v_ids),
        'updated', v_updated,
        'unchanged', v_found - v_updated,
        'missing', v_missing,
        'changes', v_changes
      )
    );
  END IF;

  RETURN jsonb_build_object(
    'line', p_line,
    'mex_profile', mex_profile_for_line(p_line),
    'requested', cardinality(v_ids),
    'updated', v_updated,
    'unchanged', v_found - v_updated,
    'missing', v_missing,
    'changes', v_changes
  );
END
$fn$;

COMMENT ON FUNCTION public.products_set_brand_line(uuid[], text, uuid) IS
  'The only writer of products.brand_line / _set_by / _set_at: sets p_line (NULL = undecided) on up to 1000 products, skips rows already on it, one audit_log row (products.set_brand_line) with every change. Returns {line, mex_profile, requested, updated, unchanged, missing, changes}. Feeds POST /products/brand-line and scripts/apply-brand-lines.mjs --apply. Migration 20260943001300.';

REVOKE ALL ON FUNCTION public.products_set_brand_line(uuid[], text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.products_set_brand_line(uuid[], text, uuid) TO service_role;
