// Minimal Overpass client with an on-disk cache.
//
// We pull Macedonian address reference data from OpenStreetMap rather than from
// MEX, because MEX publishes no street or settlement data at all — their
// get_cities.php returns 149 coarse routing zones and nothing else.
//
// Overpass over the Geofabrik .osm.pbf on purpose: the pbf route needs a parser
// dependency and a 50 MB download, while these queries return exactly the tags
// we store. The cache makes a re-run free, which matters because the public
// instances rate-limit and time out under load.

import fs from 'node:fs';
import path from 'node:path';

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  // Handles some heavy area queries the main instance times out on, but
  // rate-limits harder (429) once you have used your slot.
  'https://overpass.kumi.systems/api/interpreter',
];

// Overpass REQUIRES a User-Agent. Without one, overpass-api.de answers 406/504
// and kumi 429 — all of which look like rate limiting but are not. Identify the
// client honestly; it is also what lets an operator contact us about a bad query.
const USER_AGENT = 'elyon-natura-crm/1.0 (Macedonian address import; +https://naturall.mk)';

export const CACHE_DIR = path.join(process.cwd(), 'scripts', 'data', 'osm-cache');

/** Macedonia's OSM relation, as an Overpass area id (3600000000 + relation id). */
export const MK_AREA = 3600053293;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Run an Overpass QL query, caching the parsed JSON under `key`.
 * Retries across endpoints — a timeout on one instance usually succeeds on
 * another rather than meaning the query is wrong.
 */
export async function overpass(key, query, { refresh = false } = {}) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const file = path.join(CACHE_DIR, `${key}.json`);

  if (!refresh && fs.existsSync(file)) {
    const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
    console.log(`  [cache] ${key}: ${cached.elements?.length ?? 0} elements`);
    return cached;
  }

  let lastErr;
  const ATTEMPTS = ENDPOINTS.length * 3;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const url = ENDPOINTS[attempt % ENDPOINTS.length];
    try {
      process.stdout.write(`  [fetch] ${key} via ${new URL(url).host}… `);
      const res = await fetch(url, {
        method: 'POST',
        // Form-encoded `data=`, not a raw text body: overpass-api.de answers
        // 406 Not Acceptable to text/plain, while kumi tolerates either.
        body: new URLSearchParams({ data: query }),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': USER_AGENT,
        },
        signal: AbortSignal.timeout(300_000),
      });
      const text = await res.text();
      // Overpass reports runtime errors as an HTML body, sometimes with 200.
      if (!text.trimStart().startsWith('{')) {
        throw new Error(text.includes('timeout') ? `server busy (${res.status})` : `non-JSON (${res.status})`);
      }
      const data = JSON.parse(text);
      fs.writeFileSync(file, JSON.stringify(data));
      console.log(`${data.elements?.length ?? 0} elements`);
      return data;
    } catch (e) {
      lastErr = e;
      console.log(`failed (${e.message})`);
      // Overpass hands out per-IP slots; 429 means "wait", not "retry harder".
      // Back off progressively so a rate-limited run recovers instead of
      // burning every attempt in 30 seconds.
      const wait = /429|busy|timeout/.test(e.message) ? 30_000 * (attempt + 1) : 5_000;
      if (attempt < ATTEMPTS - 1) {
        console.log(`         retrying in ${Math.round(wait / 1000)}s…`);
        await sleep(wait);
      }
    }
  }
  throw new Error(`Overpass query "${key}" failed after retries: ${lastErr?.message}`);
}

/** Great-circle distance in km. Good enough for nearest-settlement assignment. */
export function haversineKm(aLat, aLng, bLat, bLng) {
  const R = 6371;
  const dLat = (bLat - aLat) * Math.PI / 180;
  const dLng = (bLng - aLng) * Math.PI / 180;
  const la1 = aLat * Math.PI / 180;
  const la2 = bLat * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Ray-casting point-in-polygon. `ring` is [{lat,lon}, …].
 * Used to place settlements inside their општина, since OSM's is_in tags are
 * too sparse and inconsistent to rely on.
 */
export function pointInRing(lat, lon, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i].lat, xi = ring[i].lon;
    const yj = ring[j].lat, xj = ring[j].lon;
    const intersects = (yi > lat) !== (yj > lat)
      && lon < ((xj - xi) * (lat - yi)) / ((yj - yi) || Number.EPSILON) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * A relation returned with `out geom` arrives as unordered `outer`/`inner` way
 * members. We only need a containment test, so treat every outer way as its own
 * ring and accept a hit in any of them — stitching the rings into one closed
 * polygon would add failure modes for no gain here.
 */
export function relationOuterRings(rel) {
  return (rel.members || [])
    .filter(m => m.type === 'way' && m.role !== 'inner' && Array.isArray(m.geometry) && m.geometry.length > 2)
    .map(m => m.geometry);
}

export function pointInRelation(lat, lon, rings) {
  return rings.some(r => pointInRing(lat, lon, r));
}
