-- ============================================================================
-- mk_settlements — hide duplicates, fix routing to the wrong CITY, fix three
-- postcodes, flag the cities that need a neighbourhood (Phase 5, plan 30.09).
--
-- WHY. The order form picks a settlement and MEX routes on receiver_city_id
-- alone. MEX has NO cancellation endpoint: a parcel sent to the wrong zone is
-- unrecoverable. Three defects in the derived settlement data (OSM + GeoNames +
-- map-settlements-to-mex.mjs, 2026-08-06) routed real addresses wrongly:
--
--   1. DUPLICATES under one parent — Скопје: Гази Баба ×2, Тафталиџе ×2;
--      Крушево: Долно Маало ×2, Горно Маало ×2; Дебар: Долно Маало ×2;
--      Крива Паланка: Присојарци ×2. The picker showed each twice. The row
--      with more streets is kept (tie → the lower OSM id); the other is hidden
--      (is_hidden) and points at it (canonical_id); its streets MOVE to the kept
--      row (INSERT … ON CONFLICT DO NOTHING, then delete). Nothing is deleted
--      from mk_settlements, so an id stored anywhere keeps resolving.
--   2. CROSS-CITY ZONES — the mapper's "exact" tier matched a village or a
--      district to a MEX zone by NAME alone, even when that zone belongs to a
--      different town: Прилеп's Центар / Козле / Марино and Делчево's Центар
--      routed to "Skopje - …", Кичево's Карпош to "Skopje - Karpoš", four Селце
--      to "Tetovo - Selce", Крушево near Виница to "Kruševo" (128 km) … 21 rows,
--      each checked by hand against its coordinates and its five nearest
--      neighbours (all five route through the zone chosen here). They move to
--      the zone of their own hub town — exactly what the mapper's `parent` tier
--      would have given them — and are marked mex_match_method = 'manual', which
--      map-settlements-to-mex.mjs never overwrites.
--      Plus 9 Skopje districts whose NAME is a MEX zone of their own but which
--      fell back to "Skopje - Centar" (Населба Лисиче → Skopje - Lisiče, Скопје
--      Север → Skopje - Sever, Населба Драчево → Skopje - Dračevo, …).
--      Left alone on purpose: Давидово / Миравци / Прдејци ("Gevgelija - …" —
--      they ARE in Gevgelija municipality, only their nearest town differs) and
--      Катланово ("Skopje - Katlanovo" is right).
--   3. POSTCODES — enrich-mk-postal-codes.mjs gave three Skopje-area places the
--      code of a same-named place elsewhere (GeoNames name match):
--        Долно Оризари (Скопје district, Butel)  7204 → 1000
--            7204 is Долно Оризари near Битола; every settlement within 2 km
--            (Тенеќе Маало, Скопје Север, Шуто Оризари, Бутел 1/2) is 1000.
--        Добри Дол (village south of Skopje)      1236 → 1000
--            1236 is Добри Дол near Гостивар (that row keeps it); Ракотинци
--            1,6 km, Долно/Горно Соње, Сопиште — all 1000.
--        Драчево (village, Kisela Voda)           2436 → 1020
--            2436 belongs to the Струмица area; the six Dračevo neighbourhood
--            rows around it (≤ 0,9 km) are all 1020. GeoNames also lists 1050
--            "Skopje-Dracevo" — an open question for the owner; if 1050 is
--            confirmed, move the whole Dračevo cluster together.
--      MEX ignores postcodes (add_shipment.php has no such field); the code is
--      for our records and the pre-export check only.
--   4. requires_district — true for a city whose VISIBLE districts route to
--      more than one MEX zone. After the fixes above that is Скопје alone
--      (102 districts, ~30 zones); Прилеп, Кичево and Делчево collapse to one.
--      Recomputed by mk_settlements_refresh_requires_district(), which the
--      mapper script calls after every run.
--
-- The Карпош question: the plain "Карпош" row sits at 41.505 / 20.961 — inside
-- Кичево (Kičevo has a Karpoš neighbourhood), 67 km from Skopje. The re-parent
-- below only fires if it is within 12 km of Skopje (the importer's own district
-- radius), so it is a no-op on today's data; the row keeps parent Кичево and
-- gets the Kicevo zone. Typing "Карпош" in the picker lists Карпош 1–4 · Скопје.
--
-- Every change is guarded by the value it expects to replace, so a re-run (or
-- a run after the data moved) changes nothing it did not review.
-- scripts/import-mk-settlements.mjs never writes is_hidden / canonical_id /
-- requires_district / mex_* and no longer blanks a postcode OSM does not carry.
-- ============================================================================

SET LOCAL lock_timeout = '5s';

-- ── 0. Columns ───────────────────────────────────────────────────────────────
ALTER TABLE public.mk_settlements
  ADD COLUMN IF NOT EXISTS is_hidden         boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS canonical_id      text,
  ADD COLUMN IF NOT EXISTS requires_district boolean NOT NULL DEFAULT false;

ALTER TABLE public.mk_settlements
  DROP CONSTRAINT IF EXISTS mk_settlements_canonical_id_fkey,
  ADD CONSTRAINT mk_settlements_canonical_id_fkey
    FOREIGN KEY (canonical_id) REFERENCES public.mk_settlements(id) ON DELETE SET NULL,
  DROP CONSTRAINT IF EXISTS mk_settlements_canonical_not_self,
  ADD CONSTRAINT mk_settlements_canonical_not_self CHECK (canonical_id IS NULL OR canonical_id <> id);

CREATE INDEX IF NOT EXISTS idx_mk_settlements_canonical
  ON public.mk_settlements (canonical_id) WHERE canonical_id IS NOT NULL;

COMMENT ON COLUMN public.mk_settlements.is_hidden IS
  'Hidden from the address picker (a duplicate of canonical_id, or retired). Never deleted: an id stored on an order or profile keeps resolving via canonical_id.';
COMMENT ON COLUMN public.mk_settlements.canonical_id IS
  'For a hidden duplicate: the visible row that replaces it. mex_zone_for_settlement() follows it.';
COMMENT ON COLUMN public.mk_settlements.requires_district IS
  'The city''s visible districts route to more than one MEX zone, so a confirmed order must name the district (Скопје). Derived — mk_settlements_refresh_requires_district().';

-- ── 1. Duplicates under one parent ───────────────────────────────────────────
DO $dups$
DECLARE
  r record;
  moved int;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      -- (duplicate to hide,  canonical kept,        why)
      ('osm:n370514799',   'osm:n13228288532', 'Гази Баба · Скопје — 7 vs 28 streets'),
      ('osm:n365294523',   'osm:n13231746396', 'Тафталиџе · Скопје — 17 vs 22 streets'),
      ('osm:n9686735396',  'osm:n8247407936',  'Долно Маало · Крушево — 0 vs 4 streets (kept row has the town code 7550)'),
      ('osm:n9686735397',  'osm:n2328380822',  'Горно Маало · Крушево — 0 vs 8 streets (kept row has the town code 7550)'),
      ('osm:n12149195663', 'osm:n10235796629', 'Долно Маало · Дебар — 0 vs 0 streets, lower id kept'),
      ('osm:n11831151988', 'osm:n11831151623', 'Присојарци · Крива Паланка — 0 vs 0 streets, lower id kept')
    ) AS v(dup_id, keep_id, why)
  LOOP
    -- Drift guard: same parent, same name key, both city districts, keep visible.
    IF NOT EXISTS (
      SELECT 1 FROM public.mk_settlements d JOIN public.mk_settlements k ON k.id = r.keep_id
       WHERE d.id = r.dup_id
         AND d.kind = 'city_district' AND k.kind = 'city_district'
         AND d.parent_id IS NOT DISTINCT FROM k.parent_id
         AND d.name_norm = k.name_norm
         AND NOT k.is_hidden
    ) THEN
      RAISE NOTICE 'dup % → % skipped (data moved): %', r.dup_id, r.keep_id, r.why;
      CONTINUE;
    END IF;

    INSERT INTO public.mk_streets (settlement_id, name, name_lc, name_norm, kind, source)
    SELECT r.keep_id, s.name, s.name_lc, s.name_norm, s.kind, s.source
      FROM public.mk_streets s WHERE s.settlement_id = r.dup_id
    ON CONFLICT (settlement_id, name, kind) DO NOTHING;
    GET DIAGNOSTICS moved = ROW_COUNT;
    DELETE FROM public.mk_streets WHERE settlement_id = r.dup_id;

    UPDATE public.mk_settlements
       SET is_hidden = true, canonical_id = r.keep_id, updated_at = now()
     WHERE id = r.dup_id;
    RAISE NOTICE 'dup % hidden → % (% streets moved): %', r.dup_id, r.keep_id, moved, r.why;
  END LOOP;
END
$dups$;

-- ── 2. Карпош — re-parent to Скопје only if it really lies inside Skopje ─────
DO $karpos$
DECLARE
  sk record;
  kp record;
  km numeric;
BEGIN
  SELECT id, lat, lng INTO sk FROM public.mk_settlements WHERE id = 'osm:n170792214' AND name = 'Скопје';
  SELECT id, lat, lng, parent_id INTO kp FROM public.mk_settlements WHERE id = 'osm:n7729019365' AND name = 'Карпош';
  IF sk.id IS NULL OR kp.id IS NULL THEN RAISE NOTICE 'Карпош check skipped (rows missing)'; RETURN; END IF;
  km := 111.2 * sqrt(power(kp.lat - sk.lat, 2) + power((kp.lng - sk.lng) * cos(radians(41.6)), 2));
  IF km <= 12 THEN
    UPDATE public.mk_settlements SET parent_id = sk.id, updated_at = now() WHERE id = kp.id;
    RAISE NOTICE 'Карпош re-parented to Скопје (% km)', round(km, 1);
  ELSE
    RAISE NOTICE 'Карпош stays under its parent (% km from Skopje)', round(km, 1);
  END IF;
END
$karpos$;

-- ── 3. Zone fixes: cross-city (21) + name-evident Skopje districts (9) ───────
DO $zones$
DECLARE
  r record;
  n int := 0;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      -- (settlement,        expected parent|null, old zone, new zone, why)
      -- districts routed to another city
      ('osm:n8596817617',  'osm:n388170933',  185, 138, 'Центар · Прилеп was Skopje - Centar'),
      ('osm:n3413061217',  'osm:n388170933',  266, 138, 'Козле · Прилеп was Skopje - Kozle'),
      ('osm:n8596805784',  'osm:n388170933',  283, 138, 'Марино · Прилеп was Skopje - Marino'),
      ('osm:n3705836158',  'osm:n417730489',  185, 126, 'Центар · Делчево was Skopje - Centar'),
      ('osm:n7729019365',  'osm:n299302852',  176, 121, 'Карпош · Кичево was Skopje - Karpoš'),
      -- villages routed to a same-named zone of another town (hub = nearest town)
      ('osm:n1812130817',  NULL, 247, 138, 'Волково near Прилеп (4,9 km) was Skopje - Volkovo'),
      ('osm:n1912974542',  NULL, 208, 138, 'Пештани near Прилеп (12 km) was Ohrid - Peštani (74 km)'),
      ('osm:n1812130810',  NULL, 228, 138, 'Селце near Прилеп (2,7 km) was Tetovo - Selce'),
      ('osm:n1875723277',  NULL, 266, 145, 'Кожле near Велес (15 km) was Skopje - Kozle'),
      ('osm:n1875768481',  NULL, 188, 145, 'Лисиче near Велес (14 km) was Skopje - Lisiče'),
      ('osm:n1986560834',  NULL, 285, 142, 'Нерези near Струга (19 km) was Skopje - Nerezi (101 km)'),
      ('osm:n1825323481',  NULL, 184, 114, 'Сарај near Струмица (6,8 km) was Skopje - Saraj (120 km)'),
      ('osm:n1875330432',  NULL, 229, 185, 'Бродец north of Skopje (16 km) was Tetovo - Brodec (42 km); neighbours route Skopje - Centar'),
      ('osm:n2048183715',  NULL, 229, 120, 'Бродец near Гостивар (18 km) was Tetovo - Brodec (34 km)'),
      ('osm:n456085931',   NULL, 228, 117, 'Селце near Штип (9,9 km) was Tetovo - Selce (107 km)'),
      ('osm:n1984411240',  NULL, 228, 115, 'Селце near Дебар (16 km) was Tetovo - Selce'),
      ('osm:n412814956',   NULL, 228, 133, 'Селце near Крушево (5,7 km) was Tetovo - Selce'),
      ('osm:n2024605294',  NULL, 199, 112, 'Челопек near Куманово (14 km) was Tetovo - Celopek (75 km)'),
      ('osm:n2617450350',  NULL, 209, 141, 'Лескоец near Ресен (19 km) was Ohrid - Leskoec (the Ohrid one is 4 km from Ohrid)'),
      ('osm:n2021391220',  NULL, 133, 146, 'Крушево near Виница (9,8 km) was Kruševo (128 km)'),
      ('osm:n1974380764',  NULL, 136, 120, 'Неготино near Гостивар (9,8 km) was Negotino (109 km)'),
      -- Skopje districts that name a MEX zone of their own (were Skopje - Centar)
      ('osm:n8224118256',  'osm:n170792214', 185, 188, 'Населба Лисиче → Skopje - Lisiče'),
      ('osm:n2883877899',  'osm:n170792214', 185, 188, 'Горно Лисиче → Skopje - Lisiče'),
      ('osm:n11897741355', 'osm:n170792214', 185, 197, 'Скопје Север → Skopje - Sever'),
      ('osm:n12128543535', 'osm:n170792214', 185, 186, 'Населба Драчево → Skopje - Dračevo'),
      ('osm:n12207400669', 'osm:n170792214', 185, 205, 'Населба Радишани → Skopje - Radisani'),
      ('osm:n470409501',   'osm:n170792214', 185, 285, 'Долно Нерези → Skopje - Nerezi'),
      ('osm:n11898676219', 'osm:n170792214', 185, 285, 'Средно Нерези → Skopje - Nerezi'),
      ('osm:n13228288530', 'osm:n170792214', 185, 178, 'Стар Аеродром → Skopje - Aerodrom'),
      ('osm:n2883877893',  'osm:n170792214', 185, 178, 'Реонски Центар Аеродром → Skopje - Aerodrom')
    ) AS v(id, parent_id, old_zone, new_zone, why)
  LOOP
    UPDATE public.mk_settlements s
       SET mex_city_id = r.new_zone,
           mex_match_method = 'manual',
           mex_match_note = '20260943000500: ' || r.why,
           updated_at = now()
     WHERE s.id = r.id
       AND s.mex_city_id = r.old_zone
       AND s.parent_id IS NOT DISTINCT FROM r.parent_id
       AND EXISTS (SELECT 1 FROM public.mex_cities z
                    WHERE z.city_id = r.new_zone AND z.is_active AND z.is_duplicate_of IS NULL);
    IF FOUND THEN n := n + 1; ELSE RAISE NOTICE 'zone fix skipped (data moved): % — %', r.id, r.why; END IF;
  END LOOP;
  RAISE NOTICE 'zone fixes applied: %', n;
END
$zones$;

-- ── 4. Postcodes (reviewed) ──────────────────────────────────────────────────
UPDATE public.mk_settlements s
   SET post_code = v.new_code, updated_at = now()
  FROM (VALUES
    ('osm:n13268362759', '7204', '1000'),   -- Долно Оризари · Скопје (Butel)
    ('osm:n1910027073',  '1236', '1000'),   -- Добри Дол south of Skopje (Sopište)
    ('osm:n2381411363',  '2436', '1020')    -- Драчево (Kisela Voda)
  ) AS v(id, old_code, new_code)
 WHERE s.id = v.id AND s.post_code = v.old_code;

-- ── 5. requires_district ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mk_settlements_refresh_requires_district()
RETURNS integer
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $f$
DECLARE
  n int;
BEGIN
  WITH z AS (
    SELECT c.id,
           (SELECT count(DISTINCT d.mex_city_id)
              FROM public.mk_settlements d
             WHERE d.parent_id = c.id AND d.kind = 'city_district'
               AND NOT d.is_hidden AND d.mex_city_id IS NOT NULL) > 1 AS needs
      FROM public.mk_settlements c
     WHERE c.kind IN ('city', 'town', 'village')
  )
  UPDATE public.mk_settlements s
     SET requires_district = z.needs
    FROM z
   WHERE s.id = z.id AND s.requires_district IS DISTINCT FROM z.needs;
  SELECT count(*) INTO n FROM public.mk_settlements WHERE requires_district;
  RETURN n;
END
$f$;

COMMENT ON FUNCTION public.mk_settlements_refresh_requires_district() IS
  'Recompute mk_settlements.requires_district (visible districts spread over > 1 MEX zone). Returns how many cities need a district. Called by scripts/map-settlements-to-mex.mjs after it writes. Service role only.';

REVOKE ALL ON FUNCTION public.mk_settlements_refresh_requires_district() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mk_settlements_refresh_requires_district() TO service_role;

SELECT public.mk_settlements_refresh_requires_district();

NOTIFY pgrst, 'reload schema';
