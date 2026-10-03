#!/usr/bin/env node
/**
 * Re-price the catalogue BACKWARDS from real Macedonian denar shelf prices.
 *
 * Why this exists: prices are stored in EUR and the denar shown to the customer
 * is derived from the frozen MKD_PER_EUR constant. The catalogue was seeded with
 * Bulgarian-style EUR price points (39.90, 29.90, …), which derive to untidy
 * denar figures like "2.454 ден". Nobody advertises 2.454 ден.
 *
 * So: pick the denar price you actually advertise, and this stores
 * denar / 61.5 as the EUR value. The derived figure then equals the marketed
 * figure exactly, everywhere — agent screen, report, courier label.
 *
 * DO THIS WHILE orders = 0. Re-pricing later does not restate history (that is
 * the point of freezing the constant), but it does mean old and new orders sit
 * at different prices, which is only correct if you genuinely changed the price.
 *
 * Usage:
 *   node scripts/reprice-catalogue-mk.mjs --plan            # show current mapping, change nothing
 *   node scripts/reprice-catalogue-mk.mjs --map prices.json # apply
 *
 * prices.json — either form:
 *   { "byEurPrice": { "39.90": 2490, "29.90": 1890 } }        # bulk, by current EUR price
 *   { "bySku":      { "NT0095": 2490 } }                      # per product
 *   { "byName":     { "Дијабетол Форте": 2490 } }             # per product
 * Values are the DENAR shelf price. Add --commit to actually write.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const REF = 'oufoazmnbwugtfldkwsn';
const MKD_PER_EUR = 61.5;   // must match src/lib/currency.ts

const args = process.argv.slice(2);
const planOnly = args.includes('--plan');
const commit = args.includes('--commit');
const mapPath = args[args.indexOf('--map') + 1];

const toml = readFileSync(join(root, 'supabase', 'config.toml'), 'utf8');
if (toml.match(/^\s*project_id\s*=\s*"([^"]+)"/m)?.[1] !== REF) {
  console.error('config.toml does not point at Macedonia — refusing to run.'); process.exit(1);
}
const env = {};
for (const line of readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
  if (m) env[m[1]] = m[2];
}
const token = env.SUPABASE_ACCESS_TOKEN;

async function sql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const t = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${t}`);
  return JSON.parse(t);
}

const group = (n) => {
  const s = String(Math.round(Math.abs(n)));
  return [...s].map((c, i) => (i > 0 && (s.length - i) % 3 === 0 ? '.' + c : c)).join('');
};

const products = await sql('select id, name, sku, price::numeric as price from public.products order by price desc, name;');

if (planOnly || !mapPath) {
  console.log('\nCurrent catalogue, and what each price DERIVES to today:\n');
  console.log(`  ${'EUR'.padStart(8)}  ${'derived'.padStart(12)}  ${'COD'.padStart(12)}  product`);
  console.log('  ' + '-'.repeat(74));
  for (const p of products) {
    const e = Number(p.price), den = Math.round(e * MKD_PER_EUR), cod = Math.round(den / 10) * 10;
    console.log(`  ${e.toFixed(2).padStart(8)}  ${(group(den) + ' ден').padStart(12)}  ${(group(cod) + ' ден').padStart(12)}  ${p.name}`);
  }
  console.log('\nTo re-price: put your real denar shelf prices in a JSON map and pass --map.');
  console.log('See the header of this file for the accepted shapes.\n');
  process.exit(0);
}

const map = JSON.parse(readFileSync(mapPath, 'utf8'));
const byEur = map.byEurPrice || {}, bySku = map.bySku || {}, byName = map.byName || {};

const updates = [];
for (const p of products) {
  const den = bySku[p.sku] ?? byName[p.name] ?? byEur[Number(p.price).toFixed(2)];
  if (den == null) continue;
  const eur = Math.round((Number(den) / MKD_PER_EUR) * 100) / 100;
  if (eur === Number(p.price)) continue;
  updates.push({ ...p, den: Number(den), newEur: eur });
}

if (!updates.length) { console.log('Nothing to change.'); process.exit(0); }

console.log(`\n${updates.length} product(s) to re-price:\n`);
console.log(`  ${'EUR now'.padStart(8)} -> ${'EUR new'.padStart(8)}   ${'advertised'.padStart(12)}  product`);
console.log('  ' + '-'.repeat(76));
for (const u of updates) {
  console.log(`  ${Number(u.price).toFixed(2).padStart(8)} -> ${u.newEur.toFixed(2).padStart(8)}   ${(group(u.den) + ' ден').padStart(12)}  ${u.name}`);
  const check = Math.round(u.newEur * MKD_PER_EUR);
  if (check !== u.den) console.log(`      ⚠ derives to ${group(check)} ден, not ${group(u.den)} — EUR cent rounding; pick a nearby denar price if that matters`);
}

if (!commit) { console.log('\nDry run. Re-run with --commit to write.\n'); process.exit(0); }

for (const u of updates) {
  await sql(`update public.products set price = ${u.newEur} where id = '${u.id}';`);
}
console.log(`\n✓ ${updates.length} product(s) re-priced.\n`);
