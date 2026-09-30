#!/usr/bin/env node
/**
 * Resolve every Macedonian settlement to a MEX Poshta delivery zone.
 *
 * The hard problem this solves: we hold ~1.800 real settlements, MEX routes on
 * 149 coarse zones. The two lists do not correspond — MEX explodes Skopje into
 * ~60 neighbourhoods and Tetovo into ~30 villages, but collapses every village
 * around Kumanovo into a single "Kumanovo" zone. Their names are Latin-only and
 * inconsistently transliterated; ours are Cyrillic.
 *
 * Tiers, in order. Each settlement takes the first that hits:
 *
 *   exact   normalizeMkGeo(settlement) === a zone's normalised leaf.
 *           Ambiguity (several zones share a leaf) is broken by matching the
 *           zone's parent prefix against the settlement's municipality or
 *           parent city; still-ambiguous cases are reported, never guessed.
 *   alias   Resolved through mex_city_aliases — Albanian names and MEX typos
 *           a normaliser must not be allowed to guess.
 *   parent  No zone of its own, so it inherits its municipality seat's zone.
 *           This is CORRECT for a depot-routed courier: MEX genuinely serves
 *           those villages off the seat's route. It is how 1.800 settlements
 *           map onto 149 zones without lying about any of them.
 *   unmapped  Nothing found. mex_city_id stays NULL and the order is REJECTED
 *           at push time. Never guessed — MEX has no cancellation endpoint, so
 *           a parcel sent to the wrong town cannot be recalled.
 *
 *   node --env-file=.env scripts/map-settlements-to-mex.mjs --dry-run
 *   node --env-file=.env scripts/map-settlements-to-mex.mjs
 */

import { createClient } from '@supabase/supabase-js';
import { normalizeMkGeo, splitMexCityName } from './lib/mk-translit.mjs';
import { haversineKm } from './lib/osm-fetch.mjs';

const DRY_RUN = process.argv.includes('--dry-run');

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env.');
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

async function pagedSelect(table, columns, tweak = q => q) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await tweak(supabase.from(table).select(columns)).range(from, from + 999);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function main() {
  // Only canonical, active zones are targetable. This is where MEX's duplicate
  // rows (117 Stip / 143 Štip) stop mattering — handled once, here, rather than
  // at every lookup.
  const zones = await pagedSelect('mex_cities', 'city_id, city_name, city_name_norm',
    q => q.is('is_duplicate_of', null).eq('is_active', true));
  const aliases = await pagedSelect('mex_city_aliases', 'alias_norm, mex_city_id');
  const settlements = await pagedSelect('mk_settlements',
    'id, name, name_norm, name_sq, municipality, kind, parent_id, lat, lng');

  if (settlements.length === 0) {
    console.error('mk_settlements is empty — run import-mk-settlements.mjs first.');
    process.exit(1);
  }
  console.log(`${zones.length} canonical MEX zones · ${settlements.length} settlements · ${aliases.length} aliases\n`);

  // ── Index zones by their leaf name ─────────────────────────────────────────
  // "Skopje - Aerodrom" indexes under 'aerodrom' with parent 'skopje';
  // "Bitola" indexes under 'bitola' with parent null.
  const byLeaf = new Map();
  for (const z of zones) {
    const { parent, leaf } = splitMexCityName(z.city_name);
    if (!leaf) continue;
    if (!byLeaf.has(leaf)) byLeaf.set(leaf, []);
    byLeaf.get(leaf).push({ ...z, parent, leaf });
  }
  const aliasMap = new Map(aliases.map(a => [a.alias_norm, a.mex_city_id]));

  const settlementById = new Map(settlements.map(s => [s.id, s]));

  /**
   * Pick one zone from several sharing a leaf name, using the zone's parent
   * prefix as the tie-break: "Gostivar - Orizari" vs "Kocani - Orizari" is
   * decided by which општина the settlement actually sits in.
   */
  // Towns and cities by name key — the owners of the unprefixed zones.
  const townByNorm = new Map(settlements.filter(x => x.kind === 'city' || x.kind === 'town').map(x => [x.name_norm, x]));

  /**
   * A name match may only land on a zone of the settlement's OWN town. Until
   * 2026-09-30 a single candidate was taken blindly, which sent Прилеп's Центар /
   * Козле / Марино to "Skopje - …", four Селце to "Tetovo - Selce" and the
   * village Крушево near Виница to "Kruševo" (128 km) — fixed by hand in
   * migration 20260943000500 (mex_match_method 'manual', never overwritten).
   *   prefixed "X - Y"  → X must be the settlement's parent city (a district) or
   *                        nearest town (a village) — EXCEPT a village whose own
   *                        name is the leaf and that sits within 25 km of X
   *                        (Давидово → "Gevgelija - Davidovo": MEX lists it).
   *   unprefixed "X"    → a village may not take a TOWN's zone by sharing its name.
   */
  function sameCity(zone, s) {
    if (zone.parent) {
      const context = new Set();
      if (s.municipality) context.add(normalizeMkGeo(s.municipality));
      if (s.parent_id && settlementById.has(s.parent_id)) context.add(normalizeMkGeo(settlementById.get(s.parent_id).name));
      if (context.has(zone.parent)) return true;
      if (s.kind === 'city_district') return false;
      const hub = townByNorm.get(zone.parent);
      return !!hub && s.lat != null && hub.lat != null && haversineKm(Number(s.lat), Number(s.lng), Number(hub.lat), Number(hub.lng)) <= 25;
    }
    if (s.kind === 'city' || s.kind === 'town') return true;
    const town = townByNorm.get(zone.leaf);
    return !town || town.id === s.id;
  }

  function disambiguate(candidates, s) {
    candidates = candidates.filter(c => sameCity(c, s));
    if (candidates.length === 0) return { zone: null, ambiguous: false };
    if (candidates.length === 1) return { zone: candidates[0], ambiguous: false };
    const context = new Set();
    if (s.municipality) context.add(normalizeMkGeo(s.municipality));
    if (s.parent_id && settlementById.has(s.parent_id)) {
      context.add(normalizeMkGeo(settlementById.get(s.parent_id).name));
    }
    const hits = candidates.filter(c => c.parent && context.has(c.parent));
    if (hits.length === 1) return { zone: hits[0], ambiguous: false };
    // Prefer an unprefixed zone — "Bitola" beats "Bitola - Orizari" for the
    // settlement actually called Bitola.
    const bare = candidates.filter(c => !c.parent);
    if (bare.length === 1) return { zone: bare[0], ambiguous: false };
    return { zone: null, ambiguous: true };
  }

  // ── Zone groups, keyed by parent prefix ───────────────────────────────────
  // MEX has no bare "Skopje" zone — every Skopje entry is prefixed. A settlement
  // whose name IS a prefix therefore names a group, not a zone, and needs a
  // representative picked for it.
  const byParent = new Map();
  for (const list of byLeaf.values()) {
    for (const z of list) {
      if (!z.parent) continue;
      if (!byParent.has(z.parent)) byParent.set(z.parent, []);
      byParent.get(z.parent).push(z);
    }
  }
  /** The city-centre zone if MEX has one, else the lowest id in the group. */
  const groupRepresentative = (group) =>
    group.find(z => z.leaf === 'centar' || z.leaf === 'centre' || z.leaf === 'center')
    || [...group].sort((a, b) => a.city_id - b.city_id)[0];

  /** Edit distance, capped — we only ever care about "is it 1?". */
  function editDistance(a, b) {
    if (Math.abs(a.length - b.length) > 1) return 99;
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 0; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        dp[i][j] = a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
      }
    }
    return dp[a.length][b.length];
  }

  const results = [];
  const ambiguities = [];
  const counts = { exact: 0, alias: 0, parent_prefix: 0, fuzzy: 0, parent: 0, unmapped: 0 };

  for (const s of settlements) {
    let zone = null, method = 'unmapped', note = null;

    // ── exact ──
    const direct = byLeaf.get(s.name_norm);
    if (direct?.length) {
      const { zone: z, ambiguous } = disambiguate(direct, s);
      if (z) { zone = z; method = 'exact'; }
      else if (ambiguous) ambiguities.push({ s, candidates: direct });
    }

    // ── alias ──
    if (!zone) {
      for (const key of [s.name_norm, normalizeMkGeo(s.name_sq || '')].filter(Boolean)) {
        if (aliasMap.has(key)) {
          const id = aliasMap.get(key);
          zone = zones.find(z => z.city_id === id) || null;
          if (zone) { method = 'alias'; note = `alias:${key}`; break; }
        }
      }
    }

    // ── parent_prefix: the settlement names a zone GROUP, not a zone ──
    // Скопје → "Skopje - Centar". Without this the capital is unroutable and
    // every village that inherits its zone goes unmapped with it.
    if (!zone && byParent.has(s.name_norm)) {
      zone = groupRepresentative(byParent.get(s.name_norm));
      method = 'parent_prefix';
      note = `group "${s.name}" → ${zone.city_name}`;
    }

    // ── fuzzy: MEX's transliteration is one letter off ours ──
    // Constrained to zones under the settlement's own hub, so a near-miss can
    // never pull a parcel into a different town.
    if (!zone) {
      const hubKey = s.municipality ? normalizeMkGeo(s.municipality) : null;
      const pool = hubKey && byParent.has(hubKey) ? byParent.get(hubKey) : [];
      const near = pool.filter(z => editDistance(s.name_norm, z.leaf) === 1);
      if (near.length === 1) {
        zone = near[0];
        method = 'fuzzy';
        note = `edit-distance 1: "${s.name}" ≈ "${zone.city_name}"`;
      }
    }

    // ── parent (the hub town) ──
    // Resolve the hub the same way a settlement resolves itself: first as a
    // zone in its own right, then as a zone GROUP. Skipping the group fallback
    // here is what left every village around Skopje unmapped even after Скопје
    // itself resolved — the capital only exists as a group.
    const resolveHub = (hubName) => {
      if (!hubName) return null;
      const key = normalizeMkGeo(hubName);
      const direct = byLeaf.get(key);
      // Prefer the bare zone: a village near Гостивар routes through
      // "Gostivar", not through "Gostivar - Cegrane".
      if (direct?.length) return direct.find(c => !c.parent) || direct[0];
      if (byParent.has(key)) return groupRepresentative(byParent.get(key));
      return null;
    };

    if (!zone && s.municipality) {
      const hub = resolveHub(s.municipality);
      if (hub) { zone = hub; method = 'parent'; note = `via ${s.municipality}`; }
    }

    // ── parent via the district's own city ──
    if (!zone && s.parent_id && settlementById.has(s.parent_id)) {
      const p = settlementById.get(s.parent_id);
      const hub = resolveHub(p.name);
      if (hub) { zone = hub; method = 'parent'; note = `via ${p.name}`; }
    }

    counts[method]++;
    results.push({
      id: s.id,
      name: s.name,
      mex_city_id: zone?.city_id ?? null,
      mex_match_method: method,
      mex_match_note: note,
    });
  }

  // ── Report ─────────────────────────────────────────────────────────────────
  const total = settlements.length;
  const pct = n => `${((n / total) * 100).toFixed(1)}%`;
  console.log('MATCH TIERS');
  for (const k of ['exact','alias','parent_prefix','fuzzy','parent','unmapped']) {
    console.log('  ' + k.padEnd(14) + String(counts[k]).padStart(5) + '  ' + pct(counts[k]) + (k==='unmapped' ? '  <- the backlog' : ''));
  }

  if (ambiguities.length) {
    console.log(`\nAMBIGUOUS (${ambiguities.length}) — several zones share the name and the`);
    console.log('municipality did not break the tie. Add a row to mex_city_aliases to settle each:');
    for (const a of ambiguities.slice(0, 20)) {
      console.log(`  ${a.s.name} (общ. ${a.s.municipality || '?'}) → ${a.candidates.map(c => `${c.city_id} ${c.city_name}`).join(' | ')}`);
    }
    if (ambiguities.length > 20) console.log(`  … and ${ambiguities.length - 20} more`);
  }

  const unmapped = results.filter(r => r.mex_match_method === 'unmapped');
  if (unmapped.length) {
    console.log(`\nUNMAPPED sample (${unmapped.length} total) — these will be REJECTED at push time:`);
    console.log('  ' + unmapped.slice(0, 25).map(r => r.name).join(', '));
  }

  // Zones nobody routes to. Usually fine (MEX lists a hamlet we call something
  // else), but a big number here means the leaf matching is off.
  const usedZones = new Set(results.map(r => r.mex_city_id).filter(Boolean));
  const unusedZones = zones.filter(z => !usedZones.has(z.city_id));
  console.log(`\nZones reachable: ${usedZones.size}/${zones.length}. Never targeted: ${unusedZones.length}`);
  if (unusedZones.length) {
    console.log('  ' + unusedZones.slice(0, 25).map(z => z.city_name).join(', '));
  }

  if (DRY_RUN) { console.log('\n--dry-run: nothing written.'); return; }

  // Never clobber a human decision.
  const manual = new Set(
    (await pagedSelect('mk_settlements', 'id', q => q.eq('mex_match_method', 'manual'))).map(r => r.id)
  );
  const toWrite = results.filter(r => !manual.has(r.id));
  console.log(`\nPreserving ${manual.size} manual overrides.`);

  let written = 0;
  const CHUNK = 500;
  for (let i = 0; i < toWrite.length; i += CHUNK) {
    const slice = toWrite.slice(i, i + CHUNK);
    // Upsert needs every NOT NULL column, so patch row-by-row via a bulk
    // upsert on the primary key with only the mapping columns changed.
    const { error } = await supabase.from('mk_settlements').upsert(
      slice.map(r => ({
        id: r.id,
        name: r.name,
        name_lc: r.name.toLowerCase(),
        name_norm: normalizeMkGeo(r.name),
        mex_city_id: r.mex_city_id,
        mex_match_method: r.mex_match_method,
        mex_match_note: r.mex_match_note,
        updated_at: new Date().toISOString(),
      })),
      { onConflict: 'id' }
    );
    if (error) throw error;
    written += slice.length;
    process.stdout.write(`\r  updated ${written}/${toWrite.length}`);
  }
  console.log(`\n\nDone. ${written} settlements mapped.`);

  // A city needs a district in the order form when its visible districts now
  // route to more than one zone (migration 20260943000500).
  const { data: needDistrict, error: rdErr } = await supabase.rpc('mk_settlements_refresh_requires_district');
  if (rdErr) console.warn(`requires_district refresh failed: ${rdErr.message}`);
  else console.log(`Cities that require a district: ${needDistrict}`);
}

main().catch(e => { console.error(e); process.exit(1); });
