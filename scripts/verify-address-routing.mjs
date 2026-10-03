/**
 * verify-address-routing — READ-ONLY proof that the Macedonian address data and
 * the ONE MEX-zone resolver (migrations 20260943000500 / 0600 / 0700) route every
 * order to its own town — MEX has NO cancellation endpoint, so a wrong zone is a
 * lost parcel.
 *
 *   node scripts/verify-address-routing.mjs            (text report)
 *   node scripts/verify-address-routing.mjs --json
 *
 * Exit: 0 = no FAIL · 1 = at least one FAIL · 2 = refused / not applied / DB unreachable.
 *
 *   R1  no two VISIBLE districts with the same name under one city (the Гази Баба /
 *       Тафталиџе class); every hidden row points at a visible canonical row
 *   R2  requires_district = "the city's visible districts route to > 1 zone", for
 *       every city (Скопје, and only the cities the data really splits)
 *   R3  no district routes to ANOTHER town's zone (Прилеп's Центар → "Skopje - Centar"
 *       class); no village takes a prefixed zone of a town it is not near (> 25 km),
 *       nor an unprefixed TOWN zone by sharing the town's name (Крушево near Виница)
 *   R4  postcodes: every visible settlement has 4 digits; Skopje's districts are 10xx;
 *       a settlement whose code disagrees with all 6 nearest neighbours AND their
 *       first two digits is listed (WARN — GeoNames same-name codes)
 *   R5  the resolver on Skopje's districts: every visible district with its OWN zone
 *       resolves to that zone both by id and by name ("Скопје" + its name), and the
 *       parse rules (С of Скопје, "с. …", "гр. …", ", општ. X") hold in SQL
 *   R6  open orders (pending / take / call_again / confirmed / duplicated, no parcel,
 *       home delivery, not packed): mex_zone_basis distribution and the repair
 *       classes of open_order_zone_candidates() when 0700 is applied (INFO)
 *   R7  grants: anon / authenticated can execute none of the new functions
 *
 * Safety: the guard of scripts/verify-insights-ties.mjs (imported, not copied) —
 * pinned to Macedonia (oufoazmnbwugtfldkwsn), refused if .env points at Bulgaria,
 * every statement a single SELECT / WITH sent with read_only: true.
 */
import { runSql } from './verify-insights-ties.mjs';

const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v ?? 0) || 0);
const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

const results = [];
const timings = [];
function check(id, title) {
  const c = { id, title, status: 'PASS', lines: [] };
  results.push(c);
  return {
    tie(label, want, got) {
      const ok = JSON.stringify(want) === JSON.stringify(got);
      c.lines.push({ label, want, got, ok });
      if (!ok) c.status = 'FAIL';
    },
    warn(label, detail) { c.lines.push({ label, want: null, got: detail, ok: false, warn: true }); if (c.status === 'PASS') c.status = 'WARN'; },
    info(label, detail) { c.lines.push({ label, want: null, got: detail, ok: true, info: true }); },
  };
}
async function timed(label, sql) {
  const t0 = Date.now();
  const rows = await runSql(sql);
  timings.push({ label, ms: Date.now() - t0 });
  return rows;
}

// Distance in km between two settlement rows (a, b aliases) — the importer's flat approximation.
const KM = (a, b) => `(111.2 * sqrt(power(${a}.lat - ${b}.lat, 2) + power((${a}.lng - ${b}.lng) * cos(radians(41.6)), 2)))`;

async function verifyDuplicates() {
  const [r] = await timed('R1 duplicates', `
    SELECT
      (SELECT coalesce(jsonb_agg(x), '[]'::jsonb) FROM (
         SELECT p.name AS city, d.name, count(*) AS n
           FROM public.mk_settlements d JOIN public.mk_settlements p ON p.id = d.parent_id
          WHERE d.kind = 'city_district' AND NOT d.is_hidden
          GROUP BY p.name, d.name_norm, d.name HAVING count(*) > 1) x) AS dups,
      (SELECT count(*) FROM public.mk_settlements WHERE is_hidden)::int AS hidden,
      (SELECT coalesce(jsonb_agg(h.id), '[]'::jsonb) FROM public.mk_settlements h
        LEFT JOIN public.mk_settlements c ON c.id = h.canonical_id
        WHERE h.is_hidden AND h.canonical_id IS NOT NULL AND (c.id IS NULL OR c.is_hidden)) AS bad_canonical,
      (SELECT count(*) FROM public.mk_streets s JOIN public.mk_settlements h ON h.id = s.settlement_id WHERE h.is_hidden)::int AS streets_on_hidden`);
  const c = check('R1', 'no visible duplicate districts under one city');
  c.tie('visible duplicates', [], parse(r.dups));
  c.tie('hidden rows with a missing / hidden canonical', [], parse(r.bad_canonical));
  c.info('hidden rows', n(r.hidden));
  if (n(r.streets_on_hidden)) c.warn('streets filed under a hidden row (a street re-import put them there — harmless, the picker searches the city)', n(r.streets_on_hidden));
}

async function verifyRequiresDistrict() {
  const rows = await timed('R2 requires_district', `
    SELECT c.id, c.name, c.requires_district AS flagged,
           (SELECT count(DISTINCT d.mex_city_id) FROM public.mk_settlements d
             WHERE d.parent_id = c.id AND d.kind = 'city_district' AND NOT d.is_hidden AND d.mex_city_id IS NOT NULL)::int AS zones
      FROM public.mk_settlements c
     WHERE c.kind IN ('city', 'town', 'village')
       AND (c.requires_district OR EXISTS (SELECT 1 FROM public.mk_settlements d WHERE d.parent_id = c.id))`);
  const c = check('R2', 'every multi-zone city requires a district (and only those)');
  const wrong = rows.filter((r) => r.flagged !== (n(r.zones) > 1)).map((r) => `${r.name} (${r.zones} zones, flagged ${r.flagged})`);
  c.tie('cities whose flag disagrees with their districts', [], wrong);
  c.info('cities that require a district', rows.filter((r) => r.flagged).map((r) => `${r.name} (${r.zones} zones)`));
}

async function verifyCrossCity() {
  const [r] = await timed('R3 cross-city', `
    WITH z AS (
      SELECT city_id, city_name, public.mex_zone_hub(city_name) AS hub, city_name ~ '-' AS prefixed FROM public.mex_cities
    ), towns AS (
      SELECT id, name_norm, lat, lng, mex_city_id FROM public.mk_settlements WHERE kind IN ('city', 'town')
    )
    SELECT
      (SELECT coalesce(jsonb_agg(d.name || ' · ' || p.name || ' → ' || z.city_name ORDER BY p.name, d.name), '[]'::jsonb)
         FROM public.mk_settlements d
         JOIN public.mk_settlements p ON p.id = d.parent_id
         JOIN z ON z.city_id = d.mex_city_id
        WHERE d.kind = 'city_district' AND NOT d.is_hidden
          AND d.mex_city_id IS DISTINCT FROM p.mex_city_id
          AND ((z.prefixed AND z.hub NOT IN (public.mk_geo_norm(p.name), public.mk_geo_norm(coalesce(p.name_lat, ''))))
               OR (NOT z.prefixed AND EXISTS (SELECT 1 FROM towns t WHERE t.mex_city_id = z.city_id AND t.id <> p.id)))) AS districts,
      (SELECT coalesce(jsonb_agg(s.name || ' (' || coalesce(s.municipality, '?') || ') → ' || z.city_name || ' ' || round(${KM('s', 't')}::numeric) || ' km' ORDER BY s.name), '[]'::jsonb)
         FROM public.mk_settlements s
         JOIN z ON z.city_id = s.mex_city_id AND z.prefixed
         JOIN towns t ON t.name_norm = z.hub
        WHERE s.kind = 'village' AND NOT s.is_hidden
          AND public.mk_geo_norm(coalesce(s.municipality, '')) <> z.hub
          AND ${KM('s', 't')} > 25) AS villages_prefixed,
      (SELECT coalesce(jsonb_agg(s.name || ' (' || coalesce(s.municipality, '?') || ') → ' || z.city_name ORDER BY s.name), '[]'::jsonb)
         FROM public.mk_settlements s
         JOIN z ON z.city_id = s.mex_city_id AND NOT z.prefixed
         JOIN towns t ON t.mex_city_id = z.city_id AND t.name_norm = s.name_norm AND t.id <> s.id
        WHERE s.kind = 'village' AND NOT s.is_hidden) AS villages_town_name,
      (SELECT count(*) FROM public.mk_settlements WHERE mex_match_method = 'manual')::int AS manual`);
  const c = check('R3', 'nobody routes to another town');
  c.tie('districts on another town\'s zone', [], parse(r.districts));
  c.tie('villages on a far prefixed zone (> 25 km, not their town)', [], parse(r.villages_prefixed));
  c.tie('villages on a TOWN zone by sharing its name', [], parse(r.villages_town_name));
  c.info('hand-decided zones (mex_match_method = manual, never overwritten by the mapper)', n(r.manual));
}

async function verifyPostcodes() {
  const [r] = await timed('R4 postcodes', `
    WITH s AS (SELECT * FROM public.mk_settlements WHERE NOT is_hidden),
    nb AS (
      SELECT s.id, s.name, s.post_code, s.municipality,
             (SELECT array_agg(x.post_code) FROM (
                SELECT n2.post_code FROM public.mk_settlements n2
                 WHERE n2.id <> s.id AND n2.lat IS NOT NULL AND NOT n2.is_hidden
                 ORDER BY power(n2.lat - s.lat, 2) + power((n2.lng - s.lng) * cos(radians(41.6)), 2) LIMIT 6) x) AS near
        FROM s WHERE s.lat IS NOT NULL
    )
    SELECT
      (SELECT coalesce(jsonb_agg(name ORDER BY name), '[]'::jsonb) FROM s WHERE coalesce(post_code, '') !~ '^\\d{4}$') AS bad_format,
      (SELECT coalesce(jsonb_agg(d.name || ' ' || d.post_code ORDER BY d.name), '[]'::jsonb)
         FROM s d WHERE d.parent_id = 'osm:n170792214' AND d.kind = 'city_district' AND left(coalesce(d.post_code, ''), 2) <> '10') AS skopje_not_10xx,
      (SELECT coalesce(jsonb_agg(nb.name || ' (' || coalesce(nb.municipality, '?') || ') ' || nb.post_code ORDER BY nb.name), '[]'::jsonb)
         FROM nb
        WHERE NOT (nb.post_code = ANY (nb.near))
          AND NOT EXISTS (SELECT 1 FROM unnest(nb.near) c WHERE left(c, 2) = left(nb.post_code, 2))) AS outliers`);
  const c = check('R4', 'postcode sanity');
  c.tie('visible settlements without a 4-digit code', [], parse(r.bad_format));
  c.tie('Skopje districts outside 10xx', [], parse(r.skopje_not_10xx));
  const out = parse(r.outliers);
  if (out.length) c.warn(`${out.length} settlements whose code no neighbour shares (GeoNames same-name codes; MEX ignores postcodes — owner review)`, out.slice(0, 40).join(' · ') + (out.length > 40 ? ' …' : ''));
}

async function verifyResolver() {
  const [r] = await timed('R5 resolver', `
    WITH d AS (
      SELECT d.id, d.name, d.mex_city_id
        FROM public.mk_settlements d
       WHERE d.parent_id = 'osm:n170792214' AND d.kind = 'city_district' AND NOT d.is_hidden
         AND d.mex_city_id IS NOT NULL AND d.mex_city_id <> 185
    ), res AS (
      SELECT d.name, d.mex_city_id AS own,
             (SELECT z.mex_city_id FROM public.mex_zone_for_settlement(d.id) z) AS by_id,
             (SELECT z.mex_city_id FROM public.mex_zone_for_name('Скопје', d.name) z) AS by_name
        FROM d
    ), cases AS (
      SELECT v.city, v.quarter, v.want_city, v.want_zone_prefix, z.city_name, z.mex_city_name, z.match
        FROM (VALUES
          ('Скопје', NULL, 'Скопје', 'Skopje - Centar'),
          ('Струга', NULL, 'Струга', 'Struga'),
          ('Струмица', NULL, 'Струмица', 'Strumica'),
          ('гр. Битола', NULL, 'Битола', 'Bitola'),
          ('Кадино, општ. Скопје', NULL, 'Кадино', 'Skopje'),
          ('Скопје', 'нас. Аеродром', 'Скопје', 'Skopje - Aerodrom'),
          ('Skopje - Karpos', NULL, 'Скопје', 'Skopje - Karpo'),
          ('Прилеп', 'Центар', 'Прилеп', 'Prilep')
        ) v(city, quarter, want_city, want_zone_prefix)
        CROSS JOIN LATERAL public.mex_zone_for_name(v.city, v.quarter) z
    )
    SELECT
      (SELECT count(*) FROM res)::int AS districts,
      (SELECT coalesce(jsonb_agg(name || ': own ' || own || ', by id ' || coalesce(by_id::text, '∅') || ', by name ' || coalesce(by_name::text, '∅')), '[]'::jsonb)
         FROM res WHERE by_id IS DISTINCT FROM own OR by_name IS DISTINCT FROM own) AS mismatches,
      (SELECT coalesce(jsonb_agg(city || ' | ' || coalesce(quarter, '∅') || ' → ' || coalesce(city_name, '∅') || ' / ' || coalesce(mex_city_name, '∅')), '[]'::jsonb)
         FROM cases WHERE city_name IS DISTINCT FROM want_city OR coalesce(mex_city_name, '') NOT LIKE want_zone_prefix || '%') AS parse_failures,
      (SELECT match FROM public.mex_zone_for_name('с. Сушица', NULL)) AS susica,
      (SELECT basis FROM public.mex_zone_for_name('Скопје', NULL)) AS skopje_basis,
      (SELECT public.mk_strip_settlement_prefix('Скопје')) AS strip_skopje`);
  const c = check('R5', 'Skopje districts resolve to their own zone; the parse rules hold');
  c.tie('districts whose zone differs by id or by name', [], parse(r.mismatches));
  c.tie('parse cases that resolved wrongly', [], parse(r.parse_failures));
  c.tie('"с. Сушица" (four villages, four zones)', 'ambiguous', r.susica);
  c.tie('Скопје without a district', 'city_default', r.skopje_basis);
  c.tie('the С of Скопје survives', 'Скопје', r.strip_skopje);
  c.info('Skopje districts with a zone of their own, checked', n(r.districts));
}

async function verifyOpenOrders(hasRepair) {
  const [r] = await timed('R6 open orders', `
    WITH o AS (
      SELECT o.* FROM public.orders o
       WHERE o.status::text IN ('pending', 'take', 'call_again', 'confirmed', 'duplicated')
         AND o.mex_tracking_id IS NULL AND o.packed_at IS NULL AND coalesce(o.delivery_type, 'home') = 'home'
    )
    SELECT count(*)::int AS open,
           count(*) FILTER (WHERE mex_city_id IS NULL)::int AS no_zone,
           count(*) FILTER (WHERE settlement_id IS NOT NULL)::int AS with_settlement,
           (SELECT jsonb_object_agg(coalesce(b, '∅'), c) FROM (SELECT mex_zone_basis AS b, count(*) AS c FROM o GROUP BY 1) x) AS by_basis
      FROM o`);
  const c = check('R6', 'open orders — zone basis (INFO)');
  c.info('open home orders without a parcel', n(r.open));
  c.info('… without a zone (held back by the export)', n(r.no_zone));
  c.info('… with a picked settlement', n(r.with_settlement));
  c.info('… by mex_zone_basis', parse(r.by_basis) || {});
  if (hasRepair) {
    const [k] = await timed('R6 repair classes', `
      SELECT jsonb_object_agg(class, n) AS classes FROM (
        SELECT class, count(*)::int AS n FROM public.open_order_zone_candidates() GROUP BY 1) x`);
    c.info('open_order_zone_candidates() classes', parse(k.classes) || {});
  }
}

async function verifyGrants() {
  const fns = [
    'public.mk_strip_settlement_prefix(text)', 'public.mk_clean_quarter(text)', 'public.mex_zone_hub(text)',
    'public.mex_zone_leaf(text)', 'public.mex_zone_canonical(integer)', 'public.mex_zone_for_settlement(text)',
    'public.mex_zone_for_name(text,text)', 'public.customer_profile_merge(text,jsonb,text[],uuid)',
    'public.mk_settlements_refresh_requires_district()',
  ];
  const rows = await timed('R7 grants', `
    SELECT f AS fn,
           to_regprocedure(f) IS NOT NULL AS present,
           CASE WHEN to_regprocedure(f) IS NULL THEN NULL ELSE has_function_privilege('anon', to_regprocedure(f), 'EXECUTE') END AS anon,
           CASE WHEN to_regprocedure(f) IS NULL THEN NULL ELSE has_function_privilege('authenticated', to_regprocedure(f), 'EXECUTE') END AS authed,
           CASE WHEN to_regprocedure(f) IS NULL THEN NULL ELSE has_function_privilege('service_role', to_regprocedure(f), 'EXECUTE') END AS service
      FROM unnest(ARRAY[${fns.map((f) => `'${f}'`).join(', ')}]::text[]) f`);
  const c = check('R7', 'the new functions are service-role only');
  c.tie('missing functions', [], rows.filter((x) => !x.present).map((x) => x.fn));
  c.tie('callable by anon / authenticated', [], rows.filter((x) => x.present && (x.anon || x.authed)).map((x) => x.fn));
  c.tie('not callable by service_role', [], rows.filter((x) => x.present && !x.service).map((x) => x.fn));
}

async function main() {
  const json = process.argv.includes('--json');
  const [have] = await runSql(`
    SELECT (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'mk_settlements'
              AND column_name IN ('is_hidden', 'canonical_id', 'requires_district'))::int AS settle_cols,
           (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'orders'
              AND column_name IN ('settlement_id', 'mex_zone_basis'))::int AS order_cols,
           to_regprocedure('public.mex_zone_for_name(text,text)') IS NOT NULL AS by_name,
           to_regprocedure('public.open_order_zone_candidates()') IS NOT NULL AS repair`);
  if (n(have.settle_cols) < 3 || n(have.order_cols) < 2 || !have.by_name) {
    console.error('verify-address-routing: not applied yet — apply 20260943000500 and 20260943000600 first');
    process.exit(2);
  }
  await verifyDuplicates();
  await verifyRequiresDistrict();
  await verifyCrossCity();
  await verifyPostcodes();
  await verifyResolver();
  await verifyOpenOrders(!!have.repair);
  await verifyGrants();

  const fail = results.some((c) => c.status === 'FAIL');
  if (json) {
    console.log(JSON.stringify({ tool: 'verify-address-routing', read_only: true, generated_at: new Date().toISOString(), status: fail ? 'FAIL' : 'PASS', results, timings }, null, 2));
  } else {
    console.log('verify-address-routing · read-only · Macedonia');
    for (const c of results) {
      console.log(`\n${c.status.padEnd(4)}  ${c.id}  ${c.title}`);
      for (const l of c.lines) {
        if (l.info) console.log(`        · ${l.label}: ${typeof l.got === 'object' ? JSON.stringify(l.got) : l.got}`);
        else if (l.warn) console.log(`        ! ${l.label}: ${l.got}`);
        else if (!l.ok) console.log(`        ✗ ${l.label}: want ${JSON.stringify(l.want)}, got ${JSON.stringify(l.got)}`);
      }
    }
    console.log(`\ntimings: ${timings.map((t) => `${t.label} ${t.ms} ms`).join(' · ')}`);
    console.log(`\n${fail ? 'FAIL' : 'PASS'}`);
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(`verify-address-routing error: ${e?.message ?? e}`); process.exit(2); });
