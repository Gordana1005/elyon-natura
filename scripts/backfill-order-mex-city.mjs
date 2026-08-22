#!/usr/bin/env node
/**
 * Backfill orders.mex_city_id / mex_city_name for orders written before the
 * MEX integration existed.
 *
 * New orders get their zone resolved server-side on save. Everything created
 * earlier has NULL, and an order with no zone cannot be handed to MEX — the
 * fulfilment export holds it back rather than shipping it somewhere wrong.
 *
 * Why this can't be a plain SQL UPDATE: the imported orders store their city in
 * LATIN ("Skopje", "Kavadarci") while mk_settlements is Cyrillic, so joining on
 * name_lc matches nothing at all. normalizeMkGeo() is what bridges the two, and
 * it lives in JS.
 *
 * Groups orders by normalised city so each distinct city costs one UPDATE
 * rather than one per order.
 *
 *   node --env-file=.env scripts/backfill-order-mex-city.mjs --dry-run
 *   node --env-file=.env scripts/backfill-order-mex-city.mjs
 *   node --env-file=.env scripts/backfill-order-mex-city.mjs --all   # incl. closed history
 */

import { createClient } from '@supabase/supabase-js';
import { normalizeMkGeo } from './lib/mk-translit.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const ALL = process.argv.includes('--all');

// Only these can still be shipped, so only these block anything operationally.
// --all also stamps closed history, which makes logistics reporting consistent.
const ACTIVE = ['pending', 'take', 'confirmed', 'call_again', 'shipped'];

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env.');
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

/** Strip the picker's ", општ. X" suffix and any гр./с. marker, then normalise. */
function cityKey(raw) {
  // Bare `с.?` with the `i` flag eats the first letter of Скопје / Струмица
  // (Cyrillic С). Require the dotted form `с.` / `гр.` or a following space
  // on село/град so Градско is not stripped to ско.
  const base = String(raw || '').split(',')[0]
    .replace(/^\s*(?:гр\.|с\.|село\s+|град\s+)/i, '')
    .trim();
  return normalizeMkGeo(base);
}

async function main() {
  console.log('Loading settlements…');
  const settlements = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('mk_settlements')
      .select('name, name_norm, mex_city_id, mex_cities(city_name)')
      .not('mex_city_id', 'is', null)
      .range(from, from + 999);
    if (error) throw error;
    settlements.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  // First writer wins: mk_settlements is ordered so cities/towns come before
  // hamlets, and a bare "Skopje" should resolve to the city, not a namesake.
  const byNorm = new Map();
  for (const s of settlements) {
    if (!byNorm.has(s.name_norm)) {
      byNorm.set(s.name_norm, { id: s.mex_city_id, name: s.mex_cities?.city_name ?? null });
    }
  }
  console.log(`${byNorm.size} distinct settlement keys with a MEX zone.\n`);

  console.log(`Loading orders (${ALL ? 'ALL statuses' : ACTIVE.join(', ')})…`);
  const orders = [];
  for (let from = 0; ; from += 1000) {
    let q = supabase.from('orders').select('id, customer_city, status').is('mex_city_id', null);
    if (!ALL) q = q.in('status', ACTIVE);
    const { data, error } = await q.range(from, from + 999);
    if (error) throw error;
    orders.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  console.log(`${orders.length} orders without a zone.\n`);
  if (orders.length === 0) { console.log('Nothing to do.'); return; }

  // Group by resolved zone so each distinct city is a single UPDATE.
  const groups = new Map();
  const unresolved = new Map();
  for (const o of orders) {
    const key = cityKey(o.customer_city);
    const zone = key ? byNorm.get(key) : null;
    if (!zone) {
      unresolved.set(o.customer_city || '(blank)', (unresolved.get(o.customer_city || '(blank)') || 0) + 1);
      continue;
    }
    const gk = `${zone.id}|${zone.name}`;
    if (!groups.has(gk)) groups.set(gk, { zone, ids: [] });
    groups.get(gk).ids.push(o.id);
  }

  const resolved = [...groups.values()].reduce((a, g) => a + g.ids.length, 0);
  console.log(`resolved   ${String(resolved).padStart(6)}  (${groups.size} distinct zones)`);
  console.log(`unresolved ${String(orders.length - resolved).padStart(6)}`);
  if (unresolved.size) {
    console.log('\nUnresolved cities (these orders stay unshippable until fixed by hand):');
    [...unresolved.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)
      .forEach(([c, n]) => console.log(`  ${String(n).padStart(5)}  ${c}`));
  }

  if (DRY_RUN) { console.log('\n--dry-run: nothing written.'); return; }

  let done = 0;
  for (const { zone, ids } of groups.values()) {
    // Chunked: a very long IN list makes an unwieldy URL.
    for (let i = 0; i < ids.length; i += 200) {
      const slice = ids.slice(i, i + 200);
      const { error } = await supabase
        .from('orders')
        .update({ mex_city_id: zone.id, mex_city_name: zone.name })
        .in('id', slice);
      if (error) throw error;
      done += slice.length;
      process.stdout.write(`\r  updated ${done}/${resolved}`);
    }
  }
  console.log(`\n\nDone. ${done} orders stamped with a MEX zone.`);
}

main().catch(e => { console.error(e); process.exit(1); });
