#!/usr/bin/env node
/**
 * Seed altercpa_offer_map from the curated 2026-08 history map.
 *
 *   node scripts/seed-altercpa-offer-map.mjs            # report only
 *   node scripts/seed-altercpa-offer-map.mjs --commit   # write
 *
 * scripts/data/altercpa-product-map.json was reviewed and signed off during the
 * 81.657-order history import: it maps each AlterCPA offer name onto a
 * catalogue product, collapsing the network's naming variants ("Prostatol
 * Complex", "Prostatol Complex RS [Full Price]") onto one canonical product.
 * Re-deciding all of that by hand in the admin queue would be pointless and
 * would risk splitting a product that was deliberately merged.
 *
 * Only MK is seeded. The other geos this account runs (RS, BA, XK, BG) are
 * mirror-only, so their offers need no product link — and guessing one would
 * imply a catalogue and a price we do not actually sell there.
 *
 * Idempotent: re-running only fills gaps. A mapping an admin has already set by
 * hand is NEVER overwritten, because the human decision is the newer one.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REF = 'oufoazmnbwugtfldkwsn';           // MACEDONIA. never change.
const COMMIT = process.argv.includes('--commit');
const GEO = 'MK';

const env = {};
for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
  if (m) env[m[1]] = m[2];
}
if (env.VITE_SUPABASE_PROJECT_ID && env.VITE_SUPABASE_PROJECT_ID !== REF) {
  console.error(`.env points at ${env.VITE_SUPABASE_PROJECT_ID}, not Macedonia. Refusing.`);
  process.exit(1);
}

async function sql(query) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${t}`);
  return JSON.parse(t);
}
const esc = (s) => String(s).replace(/'/g, "''");

const { map } = JSON.parse(readFileSync(join(ROOT, 'scripts/data/altercpa-product-map.json'), 'utf8'));
const accounts = await sql(`select id, name from public.altercpa_accounts where is_active order by name;`);
if (!accounts.length) { console.error('No active altercpa_accounts row.'); process.exit(1); }
const account = accounts[0];

const products = await sql(`select id, name, sku, price from public.products;`);
// Matched case/space-insensitively. The history map needed byte-identical names
// and a stray double space silently broke the link; do not repeat that.
const byName = new Map(products.map((p) => [p.name.toLowerCase().trim(), p]));

console.log('═'.repeat(74));
console.log(`Seeding altercpa_offer_map — account "${account.name}", geo ${GEO}`);
console.log(`${Object.keys(map).length} AlterCPA names · ${products.length} catalogue products`);
console.log(`Mode: ${COMMIT ? 'COMMIT' : 'DRY RUN (nothing written)'}`);
console.log('═'.repeat(74));

const existing = await sql(`
  select lower(btrim(offer_name)) as key, product_id
  from public.altercpa_offer_map
  where account_id = '${account.id}' and geo = '${GEO}';`);
const already = new Map(existing.map((r) => [r.key, r.product_id]));

const resolved = [], unresolved = [], skippedHuman = [];
for (const [alterName, entry] of Object.entries(map)) {
  const target = entry.crm || entry.create;
  if (!target) { unresolved.push({ alterName, want: '(no target in map)' }); continue; }
  const p = byName.get(String(target).toLowerCase().trim());
  if (!p) { unresolved.push({ alterName, want: target }); continue; }

  const key = alterName.toLowerCase().trim();
  if (already.get(key)) { skippedHuman.push(alterName); continue; }   // never overwrite
  resolved.push({ alterName, product: p });
}

console.log(`\n✓ resolve to a live product : ${resolved.length}`);
console.log(`· already mapped, left alone : ${skippedHuman.length}`);
console.log(`✗ cannot resolve             : ${unresolved.length}`);
if (unresolved.length) {
  console.log('\nThese stay in the admin queue for a human:');
  for (const u of unresolved) console.log(`   ${u.alterName}  →  "${u.want}"`);
}

if (!COMMIT) {
  console.log('\nDRY RUN — re-run with --commit to write.');
  process.exit(0);
}
if (!resolved.length) { console.log('\nNothing to write.'); process.exit(0); }

// One statement, so a partial failure cannot leave the map half-seeded.
const values = resolved
  .map((r) => `('${account.id}', '${GEO}', '${esc(r.alterName)}', '${r.product.id}', 0, now())`)
  .join(',\n         ');
await sql(`
  insert into public.altercpa_offer_map (account_id, geo, offer_name, product_id, seen_count, last_seen_at)
  values ${values}
  on conflict (account_id, geo, offer_name_key) do update
    set product_id = coalesce(public.altercpa_offer_map.product_id, excluded.product_id);`);

const after = await sql(`
  select count(*) total, count(product_id) mapped
  from public.altercpa_offer_map where account_id = '${account.id}' and geo = '${GEO}';`);
console.log(`\n✓ done — ${after[0].mapped}/${after[0].total} ${GEO} offers now mapped.`);
