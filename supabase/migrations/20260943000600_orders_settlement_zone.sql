-- ============================================================================
-- ONE MEX-zone resolver (Phase 5, plan 30.09) — orders remember the settlement
-- the agent PICKED, and the zone is derived from it on the server.
--
-- WHY. Until now the zone came from resolveMexCity() in api/index.ts (and a
-- copy in altercpa-sync): the text before the comma, matched by name with
-- LIMIT 1 and no ORDER BY. 290 of 295 Skopje sales in 30 days went to
-- "Skopje - Centar" because the neighbourhood was never looked at, and the
-- arbitrary pick sent same-named places to another town. MEX has NO
-- cancellation endpoint — a wrong zone is a lost parcel.
--
--   orders.settlement_id      the mk_settlements row the order form picked
--                             (a district when the city needs one). FK, ON
--                             DELETE SET NULL; added NOT VALID, then VALIDATE.
--   orders.mex_zone_basis     how the zone snapshot was decided:
--                               district      a district picked from the list
--                               settlement    a settlement picked (no district needed)
--                               city_default  a city that needs a district, none given
--                                             → the city's default zone (Skopje - Centar)
--                               name          resolved from free text (AlterCPA, old clients)
--                               repair        set by scripts/repair-open-order-zones.mjs
--                               manual        set by hand
--   customer_profiles.settlement_id   the same, remembered per phone.
--
--   mex_zone_for_settlement(id)   id → city / district / postcode / zone. Follows
--                                 a hidden duplicate's canonical_id and a MEX zone's
--                                 is_duplicate_of; only ACTIVE zones are returned.
--                                 A district whose zone belongs to another town
--                                 (the 20260943000500 class of defect) falls back
--                                 to its city's zone.
--   mex_zone_for_name(city, quarter)   deterministic free-text resolver:
--                                 • safe prefix strip (гр. / с. / село / град with a
--                                   dot or a space after it — never the С of Скопје,
--                                   Струга, Струмица) and the ", општ. X" suffix;
--                                 • a city/town beats same-named villages; villages
--                                   and districts that route to DIFFERENT zones are
--                                   ambiguous → no zone + a candidate list;
--                                 • a district is looked up only INSIDE the named
--                                   city (quarter), incl. the numbered family
--                                   "Карпош" → Карпош 1–4 when they share a zone;
--                                 • Skopje with no district → the city default,
--                                   basis 'city_default'.
--                                 Mirrored in supabase/functions/api/addressRouting.ts
--                                 (parse rules, unit-tested) — change both together.
--   customer_profile_merge(phone, patch, clear[], actor)
--                                 "Save the customer" without ever blanking a field:
--                                 new = coalesce(nullif(btrim(new), ''), old); only
--                                 the fields named in clear[] become NULL. Phone is
--                                 normalised to +389 E.164; an existing row with the
--                                 same last 8 digits is updated in place.
--
-- All functions: service role only (the api / altercpa-sync call them).
-- ============================================================================

SET LOCAL lock_timeout = '5s';

-- ── 1. Columns ───────────────────────────────────────────────────────────────
-- Catalog-only ADD COLUMNs (nullable, no default) — one ACCESS EXCLUSIVE touch.
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS settlement_id  text,
  ADD COLUMN IF NOT EXISTS mex_zone_basis text;

ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_settlement_id_fkey,
  ADD CONSTRAINT orders_settlement_id_fkey
    FOREIGN KEY (settlement_id) REFERENCES public.mk_settlements(id) ON DELETE SET NULL NOT VALID,
  DROP CONSTRAINT IF EXISTS orders_mex_zone_basis_check,
  ADD CONSTRAINT orders_mex_zone_basis_check CHECK (
    mex_zone_basis IS NULL OR mex_zone_basis IN
      ('district', 'settlement', 'city_default', 'name', 'repair', 'manual')) NOT VALID;

-- Every existing row is NULL in both columns, so the scans only confirm that.
ALTER TABLE public.orders VALIDATE CONSTRAINT orders_settlement_id_fkey;
ALTER TABLE public.orders VALIDATE CONSTRAINT orders_mex_zone_basis_check;

CREATE INDEX IF NOT EXISTS idx_orders_settlement_id
  ON public.orders (settlement_id) WHERE settlement_id IS NOT NULL;

COMMENT ON COLUMN public.orders.settlement_id IS
  'mk_settlements row the order form picked (the district when the city requires one). The zone snapshot (mex_city_id / mex_city_name) is derived from it by mex_zone_for_settlement().';
COMMENT ON COLUMN public.orders.mex_zone_basis IS
  'How mex_city_id was decided: district | settlement | city_default (city needs a district, none given) | name (free text) | repair | manual.';

ALTER TABLE public.customer_profiles
  ADD COLUMN IF NOT EXISTS settlement_id text;
ALTER TABLE public.customer_profiles
  DROP CONSTRAINT IF EXISTS customer_profiles_settlement_id_fkey,
  ADD CONSTRAINT customer_profiles_settlement_id_fkey
    FOREIGN KEY (settlement_id) REFERENCES public.mk_settlements(id) ON DELETE SET NULL;
COMMENT ON COLUMN public.customer_profiles.settlement_id IS
  'The customer''s last picked settlement / district (mk_settlements.id). Prefills the order form.';

-- ── 2. Small pure helpers (mirrored in api/addressRouting.ts) ────────────────
-- "гр. Битола" → "Битола", "с. Сушица" → "Сушица", "село Сушица" → "Сушица".
-- The marker needs a dot or whitespace after it, so "Скопје", "Струга",
-- "Струмица", "Selce", "Skopje" are never touched.
CREATE OR REPLACE FUNCTION public.mk_strip_settlement_prefix(p text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $f$
  SELECT btrim(regexp_replace(coalesce(p, ''),
    '^\s*(?:[Гг]р\.|[Гг]р\s+|[Гг]рад\s+|[Сс]ело\s+|[Сс]\.|[Сс]\s+|[Gg]r\.|[Gg]rad\s+|[Ss]elo\s+|[Ss]\.|[Ss]\s+)\s*', ''))
$f$;

-- "нас. Карпош" / "населба Карпош" / "н.м. …" / "кв. …" / "ж.к. …" → the name.
CREATE OR REPLACE FUNCTION public.mk_clean_quarter(p text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $f$
  SELECT btrim(regexp_replace(coalesce(p, ''),
    '^\s*(?:[Нн]ас\.|[Нн]аселба\s+|[Нн]\.\s?[Мм]\.|[Кк]в\.|[Жж]\.\s?[Кк]\.?|[Кк]вартал\s+|[Nn]as\.|[Nn]aselba\s+)\s*', ''))
$f$;

-- MEX zone name → the town it belongs to ("Skopje - Karpoš" → skopje,
-- "SKOPJE-DUCANDZIK" → skopje, "Bitola" → bitola) and its leaf.
CREATE OR REPLACE FUNCTION public.mex_zone_hub(p_name text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $f$
  SELECT public.mk_geo_norm(regexp_replace(coalesce(p_name, ''), '\s*-.*$', ''))
$f$;
CREATE OR REPLACE FUNCTION public.mex_zone_leaf(p_name text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $f$
  SELECT CASE WHEN coalesce(p_name, '') ~ '-'
              THEN public.mk_geo_norm(regexp_replace(p_name, '^[^-]*-\s*', ''))
              ELSE public.mk_geo_norm(p_name) END
$f$;

-- A zone id → the canonical ACTIVE zone (follows is_duplicate_of), or no row.
CREATE OR REPLACE FUNCTION public.mex_zone_canonical(p_zone integer)
RETURNS TABLE (city_id integer, city_name text)
LANGUAGE plpgsql STABLE
SET search_path = public, pg_temp
AS $f$
#variable_conflict use_column
DECLARE
  z record;
  hops int := 0;
BEGIN
  IF p_zone IS NULL THEN RETURN; END IF;
  SELECT m.city_id, m.city_name, m.is_active, m.is_duplicate_of INTO z FROM public.mex_cities m WHERE m.city_id = p_zone;
  WHILE FOUND AND z.is_duplicate_of IS NOT NULL AND hops < 5 LOOP
    hops := hops + 1;
    SELECT m.city_id, m.city_name, m.is_active, m.is_duplicate_of INTO z FROM public.mex_cities m WHERE m.city_id = z.is_duplicate_of;
  END LOOP;
  IF z.city_id IS NULL OR NOT z.is_active OR z.is_duplicate_of IS NOT NULL THEN RETURN; END IF;
  city_id := z.city_id; city_name := z.city_name;
  RETURN NEXT;
END
$f$;

-- ── 3. mex_zone_for_settlement ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mex_zone_for_settlement(p_id text)
RETURNS TABLE (
  city_id text, city_name text, district_id text, district_name text, post_code text,
  mex_city_id integer, mex_city_name text, requires_district boolean, basis text,
  city_kind text, municipality text)
LANGUAGE plpgsql STABLE
SET search_path = public, pg_temp
AS $f$
#variable_conflict use_column
DECLARE
  s public.mk_settlements%ROWTYPE;
  c public.mk_settlements%ROWTYPE;
  d public.mk_settlements%ROWTYPE;
  hops int := 0;
  cz record;
  dz record;
  own_zone boolean;
BEGIN
  IF coalesce(btrim(p_id), '') = '' THEN RETURN; END IF;
  SELECT * INTO s FROM public.mk_settlements WHERE id = p_id;
  IF NOT FOUND THEN RETURN; END IF;
  WHILE s.is_hidden AND s.canonical_id IS NOT NULL AND hops < 3 LOOP
    hops := hops + 1;
    SELECT * INTO s FROM public.mk_settlements WHERE id = s.canonical_id;
  END LOOP;

  IF s.kind = 'city_district' AND s.parent_id IS NOT NULL THEN
    SELECT * INTO c FROM public.mk_settlements WHERE id = s.parent_id;
    IF FOUND THEN d := s; ELSE c := s; END IF;
  ELSE
    c := s;
  END IF;

  SELECT * INTO cz FROM public.mex_zone_canonical(c.mex_city_id);
  IF d.id IS NOT NULL THEN
    SELECT * INTO dz FROM public.mex_zone_canonical(d.mex_city_id);
    -- The district's zone must belong to its own city: the same zone, a zone
    -- prefixed with the city's name, or an unprefixed zone no other town owns.
    own_zone := dz.city_id IS NOT NULL AND (
         dz.city_id = cz.city_id
      OR public.mex_zone_hub(dz.city_name) IN (public.mk_geo_norm(c.name), public.mk_geo_norm(c.name_lat))
      OR (dz.city_name !~ '-' AND NOT EXISTS (
            SELECT 1 FROM public.mk_settlements t
             WHERE t.kind IN ('city', 'town') AND t.id <> c.id AND t.mex_city_id = dz.city_id)));
  END IF;

  city_id := c.id;
  city_name := c.name;
  district_id := d.id;
  district_name := d.name;
  post_code := coalesce(nullif(btrim(d.post_code), ''), nullif(btrim(c.post_code), ''));
  requires_district := coalesce(c.requires_district, false);
  city_kind := c.kind;
  municipality := c.municipality;
  IF d.id IS NOT NULL AND own_zone THEN
    mex_city_id := dz.city_id; mex_city_name := dz.city_name; basis := 'district';
  ELSIF cz.city_id IS NOT NULL THEN
    mex_city_id := cz.city_id; mex_city_name := cz.city_name;
    basis := CASE WHEN d.id IS NULL AND c.requires_district THEN 'city_default' ELSE 'settlement' END;
  ELSE
    mex_city_id := NULL; mex_city_name := NULL; basis := NULL;
  END IF;
  RETURN NEXT;
END
$f$;

COMMENT ON FUNCTION public.mex_zone_for_settlement(text) IS
  'Picked settlement / district → city, district, postcode and the ACTIVE canonical MEX zone. basis: district | settlement | city_default (city requires a district, none given) | NULL (no zone). Service role only.';

-- ── 4. mex_zone_for_name ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mex_zone_for_name(p_city text, p_quarter text DEFAULT NULL)
RETURNS TABLE (
  city_id text, city_name text, district_id text, district_name text, post_code text,
  mex_city_id integer, mex_city_name text, requires_district boolean, basis text,
  city_kind text, municipality text, match text, candidates jsonb)
LANGUAGE plpgsql STABLE
SET search_path = public, pg_temp
AS $f$
#variable_conflict use_column
DECLARE
  v_raw      text := btrim(coalesce(p_city, ''));
  v_head     text;
  v_rest     text;
  v_base     text;
  v_muni     text := NULL;
  v_q        text := nullif(btrim(coalesce(p_quarter, '')), '');
  v_ckey     text;
  v_qkey     text;
  v_qkey2    text;
  v_all      jsonb;
  v_cities   int;
  v_zones    int;
  v_picked   text := NULL;   -- the settlement (or district) the city text names
  v_how      text := NULL;
  v_zone     integer;
  v_n        int;
  v_nz       int;
  v_one      text;
  pr         record;
  zr         record;
BEGIN
  match := 'none';
  IF v_raw = '' THEN RETURN NEXT; RETURN; END IF;

  -- "Кадино, општ. Скопје" → base "Кадино", municipality hint "skopje". Any
  -- other text after the comma is a quarter hint when none was given.
  v_head := split_part(v_raw, ',', 1);
  v_rest := btrim(substr(v_raw, length(v_head) + 2));
  IF v_rest ~ '^(?:[Оо]пшт(?:ина)?|[Oo]p[sš]t(?:ina)?)(?:\.|\s|$)' THEN
    v_muni := nullif(public.mk_geo_norm(
      regexp_replace(v_rest, '^(?:[Оо]пшт(?:ина)?|[Oo]p[sš]t(?:ina)?)\.?\s*', '')), '');
  ELSIF v_rest <> '' AND v_q IS NULL THEN
    v_q := v_rest;
  END IF;
  v_base := public.mk_strip_settlement_prefix(v_head);
  v_ckey := public.mk_geo_norm(v_base);

  -- "Skopje - Aerodrom" / "SKOPJE-KERAMIDNICA": nothing is called that, so the
  -- part before the dash is the city and the rest the quarter.
  IF v_base ~ '-' AND NOT EXISTS (
       SELECT 1 FROM public.mk_settlements s WHERE s.name_norm = v_ckey AND NOT s.is_hidden) THEN
    v_q := coalesce(v_q, nullif(btrim(regexp_replace(v_base, '^[^-]*-', '')), ''));
    v_base := btrim(regexp_replace(v_base, '\s*-.*$', ''));
    v_ckey := public.mk_geo_norm(v_base);
  END IF;

  IF length(v_ckey) < 2 THEN RETURN NEXT; RETURN; END IF;

  -- Candidates: the exact name, plus the numbered district family ("Карпош" →
  -- Карпош 1–4), each with the zone it would really route to. A municipality
  -- hint narrows them when it matches any.
  WITH base AS (
    SELECT s.id, s.name, s.kind, s.name_norm, p.name AS parent_name, s.municipality,
           z.post_code AS pc, z.mex_city_id AS zone, z.mex_city_name AS zone_name
      FROM public.mk_settlements s
      LEFT JOIN public.mk_settlements p ON p.id = s.parent_id
      CROSS JOIN LATERAL public.mex_zone_for_settlement(s.id) z
     WHERE NOT s.is_hidden
       AND (s.name_norm = v_ckey
            OR (s.kind = 'city_district' AND s.name_norm LIKE v_ckey || '%'
                AND s.name_norm ~ ('^' || v_ckey || '[0-9]+$')))
  ), hinted AS (
    SELECT * FROM base b
     WHERE v_muni IS NOT NULL
       AND v_muni IN (public.mk_geo_norm(b.municipality), public.mk_geo_norm(b.parent_name))
  ), cand AS (
    SELECT * FROM hinted
    UNION ALL
    SELECT * FROM base WHERE NOT EXISTS (SELECT 1 FROM hinted)
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id, 'name', c.name, 'kind', c.kind, 'name_norm', c.name_norm,
           'parent_name', c.parent_name, 'municipality', c.municipality, 'post_code', c.pc,
           'mex_city_id', c.zone, 'mex_city_name', c.zone_name)
         ORDER BY CASE c.kind WHEN 'city' THEN 1 WHEN 'town' THEN 2 WHEN 'city_district' THEN 3 ELSE 4 END,
                  c.name, c.parent_name, c.municipality, c.id), '[]'::jsonb)
    INTO v_all
    FROM cand c;

  SELECT count(*) FILTER (WHERE e->>'kind' IN ('city', 'town') AND e->>'name_norm' = v_ckey),
         count(DISTINCT e->>'mex_city_id') FILTER (WHERE e->>'mex_city_id' IS NOT NULL)
    INTO v_cities, v_zones
    FROM jsonb_array_elements(v_all) e;

  IF v_cities = 1 THEN
    -- A city or town beats same-named villages and districts.
    SELECT e->>'id' INTO v_picked FROM jsonb_array_elements(v_all) e
     WHERE e->>'kind' IN ('city', 'town') AND e->>'name_norm' = v_ckey;
    v_how := 'settlement';
  ELSIF jsonb_array_length(v_all) > 0 THEN
    IF v_cities > 1 OR v_zones > 1 THEN
      -- Same name, different zones: never guess. The caller shows the choices.
      match := 'ambiguous';
      candidates := (SELECT jsonb_agg(e - 'name_norm') FROM (
                       SELECT e FROM jsonb_array_elements(v_all) WITH ORDINALITY AS t(e, i) ORDER BY i LIMIT 12) x);
      RETURN NEXT;
      RETURN;
    END IF;
    -- One zone (or none) among them all: the exact name first, then villages
    -- before districts, then the lowest id — deterministic.
    SELECT e->>'id' INTO v_picked FROM jsonb_array_elements(v_all) e
     ORDER BY (e->>'name_norm' = v_ckey) DESC,
              CASE e->>'kind' WHEN 'village' THEN 1 WHEN 'city_district' THEN 2 ELSE 3 END,
              e->>'id'
     LIMIT 1;
    v_how := 'settlement';
  END IF;

  IF v_picked IS NULL THEN
    -- No settlement is called that: a MEX zone leaf that exists exactly once
    -- ("Kapistec"), else a hand-curated alias.
    SELECT min(m.city_id), count(*) INTO v_zone, v_n
      FROM public.mex_cities m
     WHERE m.is_active AND m.is_duplicate_of IS NULL AND public.mex_zone_leaf(m.city_name) = v_ckey;
    IF v_n = 1 THEN
      v_how := 'zone_leaf';
    ELSE
      v_zone := NULL;
      SELECT a.mex_city_id INTO v_zone FROM public.mex_city_aliases a WHERE a.alias_norm = v_ckey;
      IF v_zone IS NOT NULL THEN v_how := 'alias'; END IF;
    END IF;
    IF v_zone IS NULL THEN RETURN NEXT; RETURN; END IF;
    SELECT * INTO zr FROM public.mex_zone_canonical(v_zone);
    IF zr.city_id IS NULL THEN RETURN NEXT; RETURN; END IF;
    mex_city_id := zr.city_id; mex_city_name := zr.city_name;
    requires_district := false; basis := 'name'; match := v_how;
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT * INTO pr FROM public.mex_zone_for_settlement(v_picked);

  -- A district is looked up ONLY inside the named city (the quarter text).
  IF pr.district_id IS NULL AND v_q IS NOT NULL THEN
    v_qkey  := public.mk_geo_norm(v_q);
    v_qkey2 := public.mk_geo_norm(public.mk_clean_quarter(v_q));
    IF greatest(length(v_qkey), length(v_qkey2)) >= 2 THEN
      SELECT d.id INTO v_one FROM public.mk_settlements d
       WHERE d.parent_id = pr.city_id AND d.kind = 'city_district' AND NOT d.is_hidden
         AND d.name_norm IN (v_qkey, v_qkey2)
       ORDER BY (d.name_norm = v_qkey) DESC, d.id
       LIMIT 1;
      IF v_one IS NOT NULL THEN
        SELECT * INTO pr FROM public.mex_zone_for_settlement(v_one);
        v_how := 'district';
      ELSE
        -- The numbered family inside the city ("Карпош" → Карпош 1–4), usable
        -- only when every member routes to ONE zone.
        SELECT count(*), count(DISTINCT z.mex_city_id), min(z.mex_city_id), min(d.id)
          INTO v_n, v_nz, v_zone, v_one
          FROM public.mk_settlements d
          CROSS JOIN LATERAL public.mex_zone_for_settlement(d.id) z
         WHERE d.parent_id = pr.city_id AND d.kind = 'city_district' AND NOT d.is_hidden
           AND length(v_qkey2) >= 3
           AND d.name_norm LIKE v_qkey2 || '%' AND d.name_norm ~ ('^' || v_qkey2 || '[0-9]+$');
        IF v_n >= 1 AND v_nz = 1 THEN
          IF v_n = 1 THEN
            SELECT * INTO pr FROM public.mex_zone_for_settlement(v_one);
          ELSE
            SELECT * INTO zr FROM public.mex_zone_canonical(v_zone);
            pr.mex_city_id := zr.city_id; pr.mex_city_name := zr.city_name; pr.basis := 'district';
          END IF;
          v_how := 'district_group';
        ELSE
          -- A MEX zone of this city named like the quarter ("Лисиче" → Skopje - Lisiče).
          SELECT min(m.city_id), count(*) INTO v_zone, v_n
            FROM public.mex_cities m
           WHERE m.is_active AND m.is_duplicate_of IS NULL AND m.city_name ~ '-'
             AND public.mex_zone_hub(m.city_name) IN (
                   public.mk_geo_norm(pr.city_name),
                   (SELECT public.mk_geo_norm(x.name_lat) FROM public.mk_settlements x WHERE x.id = pr.city_id))
             AND public.mex_zone_leaf(m.city_name) IN (v_qkey, v_qkey2);
          IF v_n = 1 THEN
            SELECT * INTO zr FROM public.mex_zone_canonical(v_zone);
            IF zr.city_id IS NOT NULL THEN
              pr.mex_city_id := zr.city_id; pr.mex_city_name := zr.city_name; pr.basis := 'district';
              v_how := 'zone_leaf';
            END IF;
          END IF;
        END IF;
      END IF;
    END IF;
  END IF;

  city_id := pr.city_id; city_name := pr.city_name;
  district_id := pr.district_id; district_name := pr.district_name;
  post_code := pr.post_code;
  mex_city_id := pr.mex_city_id; mex_city_name := pr.mex_city_name;
  requires_district := pr.requires_district;
  city_kind := pr.city_kind;
  municipality := pr.municipality;
  basis := CASE WHEN pr.mex_city_id IS NULL THEN NULL
                WHEN pr.basis = 'city_default' THEN 'city_default'
                ELSE 'name' END;
  match := CASE WHEN pr.district_id IS NOT NULL AND v_how = 'settlement' THEN 'district' ELSE v_how END;
  RETURN NEXT;
END
$f$;

COMMENT ON FUNCTION public.mex_zone_for_name(text, text) IS
  'Free-text city (+ quarter) → settlement, district and ACTIVE MEX zone. Deterministic; a bare name whose candidates route to several zones returns no zone, match = ambiguous and a candidate list (≤ 12). basis: name | city_default | NULL. match: settlement | district | district_group | zone_leaf | alias | ambiguous | none. Parse rules mirrored in supabase/functions/api/addressRouting.ts. Service role only.';

-- ── 5. customer_profile_merge ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.customer_profile_merge(
  p_phone text, p_patch jsonb, p_clear text[] DEFAULT '{}', p_actor uuid DEFAULT NULL)
RETURNS public.customer_profiles
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $f$
DECLARE
  v_allowed CONSTANT text[] := ARRAY[
    'customer_name', 'birthday', 'street', 'street_number', 'quarter', 'apartment', 'floor', 'block',
    'entry', 'city', 'postal_code', 'delivery_type', 'home_courier', 'courier_office_code',
    'courier_office_name', 'courier_office_city', 'delivery_instructions', 'gift_note', 'notes',
    'mex_city_id', 'mex_city_name', 'settlement_id'];
  v_digits text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  v_phone  text;
  v_key    text;
  v_patch  jsonb := '{}'::jsonb;
  v_clear  text[];
  v_k      text;
  v_v      text;
  v_out    public.customer_profiles%ROWTYPE;
BEGIN
  IF length(v_digits) = 8 THEN v_phone := '+389' || v_digits;
  ELSIF length(v_digits) = 9 AND left(v_digits, 1) = '0' THEN v_phone := '+389' || substr(v_digits, 2);
  ELSIF length(v_digits) = 11 AND left(v_digits, 3) = '389' THEN v_phone := '+' || v_digits;
  ELSIF length(v_digits) = 13 AND left(v_digits, 5) = '00389' THEN v_phone := '+' || substr(v_digits, 3);
  ELSIF length(v_digits) BETWEEN 9 AND 15 AND btrim(p_phone) LIKE '+%' THEN v_phone := '+' || v_digits;
  ELSE RAISE EXCEPTION 'customer_profile_merge: invalid phone' USING ERRCODE = '22023';
  END IF;

  -- Only known columns; blanks never overwrite.
  FOR v_k, v_v IN SELECT e.key, e.value FROM jsonb_each_text(coalesce(p_patch, '{}'::jsonb)) e LOOP
    IF v_k = ANY (v_allowed) AND nullif(btrim(coalesce(v_v, '')), '') IS NOT NULL THEN
      v_patch := v_patch || jsonb_build_object(v_k, btrim(v_v));
    END IF;
  END LOOP;
  SELECT coalesce(array_agg(c), '{}') INTO v_clear
    FROM unnest(coalesce(p_clear, '{}'::text[])) c WHERE c = ANY (v_allowed);

  -- Values that must parse or exist; a bad one is dropped, never stored half-way.
  IF v_patch ? 'birthday' AND (v_patch->>'birthday') !~ '^\d{4}-\d{2}-\d{2}$' THEN v_patch := v_patch - 'birthday'; END IF;
  IF v_patch ? 'mex_city_id' AND ((v_patch->>'mex_city_id') !~ '^\d{1,9}$'
       OR NOT EXISTS (SELECT 1 FROM public.mex_cities m WHERE m.city_id = (v_patch->>'mex_city_id')::int)) THEN
    v_patch := v_patch - 'mex_city_id';
  END IF;
  IF v_patch ? 'settlement_id' AND NOT EXISTS (SELECT 1 FROM public.mk_settlements s WHERE s.id = v_patch->>'settlement_id') THEN
    v_patch := v_patch - 'settlement_id';
  END IF;

  -- The row for this customer: the exact E.164 key, else the latest row with the
  -- same last 8 digits (a legacy key stays; no second row is created).
  SELECT cp.phone INTO v_key FROM public.customer_profiles cp WHERE cp.phone = v_phone;
  IF v_key IS NULL THEN
    SELECT cp.phone INTO v_key FROM public.customer_profiles cp
     WHERE right(regexp_replace(cp.phone, '\D', '', 'g'), 8) = right(v_digits, 8)
     ORDER BY cp.updated_at DESC
     LIMIT 1;
  END IF;
  IF v_key IS NULL THEN
    INSERT INTO public.customer_profiles (phone, updated_by) VALUES (v_phone, p_actor);
    v_key := v_phone;
  END IF;

  UPDATE public.customer_profiles cp SET
    customer_name         = CASE WHEN 'customer_name' = ANY (v_clear) THEN NULL ELSE coalesce(v_patch->>'customer_name', cp.customer_name) END,
    birthday              = CASE WHEN 'birthday' = ANY (v_clear) THEN NULL ELSE coalesce((v_patch->>'birthday')::date, cp.birthday) END,
    street                = CASE WHEN 'street' = ANY (v_clear) THEN NULL ELSE coalesce(v_patch->>'street', cp.street) END,
    street_number         = CASE WHEN 'street_number' = ANY (v_clear) THEN NULL ELSE coalesce(v_patch->>'street_number', cp.street_number) END,
    quarter               = CASE WHEN 'quarter' = ANY (v_clear) THEN NULL ELSE coalesce(v_patch->>'quarter', cp.quarter) END,
    apartment             = CASE WHEN 'apartment' = ANY (v_clear) THEN NULL ELSE coalesce(v_patch->>'apartment', cp.apartment) END,
    floor                 = CASE WHEN 'floor' = ANY (v_clear) THEN NULL ELSE coalesce(v_patch->>'floor', cp.floor) END,
    block                 = CASE WHEN 'block' = ANY (v_clear) THEN NULL ELSE coalesce(v_patch->>'block', cp.block) END,
    entry                 = CASE WHEN 'entry' = ANY (v_clear) THEN NULL ELSE coalesce(v_patch->>'entry', cp.entry) END,
    city                  = CASE WHEN 'city' = ANY (v_clear) THEN NULL ELSE coalesce(v_patch->>'city', cp.city) END,
    postal_code           = CASE WHEN 'postal_code' = ANY (v_clear) THEN NULL ELSE coalesce(v_patch->>'postal_code', cp.postal_code) END,
    delivery_type         = CASE WHEN 'delivery_type' = ANY (v_clear) THEN NULL ELSE coalesce(v_patch->>'delivery_type', cp.delivery_type) END,
    home_courier          = CASE WHEN 'home_courier' = ANY (v_clear) THEN NULL ELSE coalesce(v_patch->>'home_courier', cp.home_courier) END,
    courier_office_code   = CASE WHEN 'courier_office_code' = ANY (v_clear) THEN NULL ELSE coalesce(v_patch->>'courier_office_code', cp.courier_office_code) END,
    courier_office_name   = CASE WHEN 'courier_office_name' = ANY (v_clear) THEN NULL ELSE coalesce(v_patch->>'courier_office_name', cp.courier_office_name) END,
    courier_office_city   = CASE WHEN 'courier_office_city' = ANY (v_clear) THEN NULL ELSE coalesce(v_patch->>'courier_office_city', cp.courier_office_city) END,
    delivery_instructions = CASE WHEN 'delivery_instructions' = ANY (v_clear) THEN NULL ELSE coalesce(v_patch->>'delivery_instructions', cp.delivery_instructions) END,
    gift_note             = CASE WHEN 'gift_note' = ANY (v_clear) THEN NULL ELSE coalesce(v_patch->>'gift_note', cp.gift_note) END,
    notes                 = CASE WHEN 'notes' = ANY (v_clear) THEN NULL ELSE coalesce(v_patch->>'notes', cp.notes) END,
    mex_city_id           = CASE WHEN 'mex_city_id' = ANY (v_clear) THEN NULL ELSE coalesce((v_patch->>'mex_city_id')::int, cp.mex_city_id) END,
    mex_city_name         = CASE WHEN 'mex_city_name' = ANY (v_clear) THEN NULL ELSE coalesce(v_patch->>'mex_city_name', cp.mex_city_name) END,
    settlement_id         = CASE WHEN 'settlement_id' = ANY (v_clear) THEN NULL ELSE coalesce(v_patch->>'settlement_id', cp.settlement_id) END,
    updated_by            = coalesce(p_actor, cp.updated_by),
    updated_at            = now()
  WHERE cp.phone = v_key
  RETURNING cp.* INTO v_out;
  RETURN v_out;
END
$f$;

COMMENT ON FUNCTION public.customer_profile_merge(text, jsonb, text[], uuid) IS
  'Fill-only upsert of customer_profiles: a non-blank value in p_patch replaces the stored one, a blank never does; only the columns named in p_clear become NULL. Phone → +389 E.164; an existing row with the same last 8 digits is updated in place. Service role only.';

-- ── 6. Grants — service role only ────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.mk_strip_settlement_prefix(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mk_clean_quarter(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mex_zone_hub(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mex_zone_leaf(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mex_zone_canonical(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mex_zone_for_settlement(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mex_zone_for_name(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.customer_profile_merge(text, jsonb, text[], uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mk_strip_settlement_prefix(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mk_clean_quarter(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mex_zone_hub(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mex_zone_leaf(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mex_zone_canonical(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.mex_zone_for_settlement(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mex_zone_for_name(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.customer_profile_merge(text, jsonb, text[], uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
