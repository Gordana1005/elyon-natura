-- ============================================================================
-- open_order_zone_candidates() — which OPEN orders route to the wrong MEX zone
-- (Phase 7, plan 30.09). Read-only; scripts/repair-open-order-zones.mjs dry-runs,
-- applies (district_fix + cross_city_fix only) and rolls back through the
-- data_repair_runs / data_repair_rows ledger (20260934000200).
--
-- An order is a candidate while nothing has left the building: status pending /
-- take / call_again / confirmed / duplicated, no MEX parcel (mex_tracking_id IS
-- NULL — MEX has no cancel / re-route endpoint, so a parcel's zone is final),
-- home delivery, not packed. Each is re-resolved by the ONE resolver
-- (20260943000600): its picked settlement_id when it has one, else its
-- customer_city + quarter text. Classes:
--
--   same            the stored zone is the resolved one (duplicate MEX rows fold:
--                   143 Štip ≡ 117 Stip)
--   district_fix    same town, another zone ("Skopje - Centar" → "Skopje - Karpoš")
--   cross_city_fix  another town's zone — or no zone at all — becomes the right one
--                   (Прилеп "Центар" on "Skopje - Centar" → "Prilep")
--   needs_pick      the text names several places that route differently
--                   ("Сарај", "с. Сушица") or a city that needs a district and has
--                   none (Скопје with no neighbourhood → city default). A person
--                   picks — the repair never touches these.
--   unmapped        nothing resolves ("Vigonza", "Битола с Ивањевци", blank).
-- ============================================================================

-- The town a MEX zone belongs to: "Skopje - Karpoš" → skopje, "Bitola" → bitola.
CREATE OR REPLACE FUNCTION public.mex_zone_town_key(p_name text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $f$
  SELECT CASE WHEN p_name IS NULL THEN NULL ELSE public.mex_zone_hub(p_name) END
$f$;

CREATE OR REPLACE FUNCTION public.open_order_zone_candidates()
RETURNS TABLE (
  order_id uuid, display_id text, status text, created_at timestamptz,
  customer_city text, quarter text,
  old_zone integer, old_zone_name text, old_settlement_id text, old_basis text,
  new_zone integer, new_zone_name text, new_settlement_id text,
  new_city text, new_district text, new_basis text, match text, candidates jsonb,
  class text)
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $f$
  WITH o AS (
    SELECT o.id, o.display_id, o.status::text AS status, o.created_at, o.customer_city, o.quarter,
           o.mex_city_id, o.mex_city_name, o.settlement_id, o.mex_zone_basis
      FROM public.orders o
     WHERE o.status::text IN ('pending', 'take', 'call_again', 'confirmed', 'duplicated')
       AND o.mex_tracking_id IS NULL
       AND o.packed_at IS NULL
       AND coalesce(o.delivery_type, 'home') = 'home'
  ), r AS (
    SELECT o.*,
           s.city_id AS s_city, s.city_name AS s_city_name, s.district_id AS s_district, s.district_name AS s_district_name,
           s.mex_city_id AS s_zone, s.mex_city_name AS s_zone_name, s.basis AS s_basis,
           n.city_id AS n_city, n.city_name AS n_city_name, n.district_id AS n_district, n.district_name AS n_district_name,
           n.mex_city_id AS n_zone, n.mex_city_name AS n_zone_name, n.basis AS n_basis, n.match AS n_match, n.candidates AS n_candidates
      FROM o
      LEFT JOIN LATERAL public.mex_zone_for_settlement(o.settlement_id) s ON o.settlement_id IS NOT NULL
      LEFT JOIN LATERAL public.mex_zone_for_name(o.customer_city, o.quarter) n ON o.settlement_id IS NULL OR s.city_id IS NULL
  ), x AS (
    SELECT r.*,
           CASE WHEN r.s_city IS NOT NULL THEN r.s_zone ELSE r.n_zone END AS z,
           CASE WHEN r.s_city IS NOT NULL THEN r.s_zone_name ELSE r.n_zone_name END AS z_name,
           CASE WHEN r.s_city IS NOT NULL THEN coalesce(r.s_district, r.s_city) ELSE coalesce(r.n_district, r.n_city) END AS z_settlement,
           CASE WHEN r.s_city IS NOT NULL THEN r.s_city_name ELSE r.n_city_name END AS z_city,
           CASE WHEN r.s_city IS NOT NULL THEN r.s_district_name ELSE r.n_district_name END AS z_district,
           CASE WHEN r.s_city IS NOT NULL THEN r.s_basis ELSE r.n_basis END AS z_basis,
           CASE WHEN r.s_city IS NOT NULL THEN 'settlement_id' ELSE coalesce(r.n_match, 'none') END AS z_match,
           (SELECT c.city_id FROM public.mex_zone_canonical(r.mex_city_id) c) AS old_canon
      FROM r
  )
  SELECT x.id, x.display_id, x.status, x.created_at, x.customer_city, x.quarter,
         x.mex_city_id, x.mex_city_name, x.settlement_id, x.mex_zone_basis,
         x.z, x.z_name, x.z_settlement, x.z_city, x.z_district, x.z_basis, x.z_match,
         CASE WHEN x.z_match = 'ambiguous' THEN x.n_candidates END,
         CASE
           WHEN x.z_match = 'ambiguous' OR x.z_basis = 'city_default' THEN 'needs_pick'
           WHEN x.z IS NULL THEN 'unmapped'
           WHEN x.z = coalesce(x.old_canon, x.mex_city_id) THEN 'same'
           WHEN x.mex_city_id IS NOT NULL
                AND public.mex_zone_town_key(x.mex_city_name) = public.mex_zone_town_key(x.z_name) THEN 'district_fix'
           ELSE 'cross_city_fix'
         END
    FROM x
$f$;

COMMENT ON FUNCTION public.open_order_zone_candidates() IS
  'Open home orders without a MEX parcel, re-resolved by mex_zone_for_settlement / mex_zone_for_name and classed same | district_fix | cross_city_fix | needs_pick | unmapped. Read-only; scripts/repair-open-order-zones.mjs applies district_fix + cross_city_fix through the data_repair ledger. Service role only.';

REVOKE ALL ON FUNCTION public.mex_zone_town_key(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.open_order_zone_candidates() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mex_zone_town_key(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.open_order_zone_candidates() TO service_role;

NOTIFY pgrst, 'reload schema';
