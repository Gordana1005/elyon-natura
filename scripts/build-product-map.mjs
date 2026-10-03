#!/usr/bin/env node
/**
 * Validate scripts/data/altercpa-product-map.json against BOTH the export and
 * the live catalogue, then write a review page. Read-only unless --commit.
 *
 *   node scripts/build-product-map.mjs            # validate + report
 *   node scripts/build-product-map.mjs --commit   # create the missing products
 *
 * Two failure modes this exists to catch:
 *   1. an AlterCPA offer name the map does not cover — it would silently import
 *      with product_id = NULL and never show up in a product report;
 *   2. a "crm" value that is not byte-identical to products.name — the import
 *      matches on exact lowercased name, so a stray space means no link.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readOrders, productNameOf, MKD_PER_EUR } from './lib/altercpa.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAW = join(ROOT, 'scripts', 'data', 'altercpa-mk-raw.jsonl');
const MAP_FILE = join(ROOT, 'scripts', 'data', 'altercpa-product-map.json');
const OUT = join(ROOT, 'scripts', 'data', 'altercpa-product-map-review.md');
const COMMIT = process.argv.includes('--commit');

const REF = 'oufoazmnbwugtfldkwsn';
const env = {};
for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
  if (m) env[m[1]] = m[2];
}

async function sql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const t = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${t}`);
  return JSON.parse(t);
}

const { map, create } = JSON.parse(readFileSync(MAP_FILE, 'utf8'));
const orders = readOrders(RAW);

// ── volumes per AlterCPA name ─────────────────────────────────────────────
const vol = new Map();
for (const o of orders) {
  const n = productNameOf(o) || '(blank)';
  vol.set(n, (vol.get(n) || 0) + 1);
}

// ── 1. every exported name must be covered ────────────────────────────────
const uncovered = [...vol.keys()].filter((n) => !map[n]);
if (uncovered.length) {
  console.error('✗ These AlterCPA names are in the export but not in the map:');
  for (const n of uncovered.sort((a, b) => vol.get(b) - vol.get(a))) {
    console.error(`    ${String(vol.get(n)).padStart(6)}  ${n}`);
  }
  console.error('\nAdd them to scripts/data/altercpa-product-map.json and re-run.');
  process.exit(1);
}
const unused = Object.keys(map).filter((n) => !vol.has(n));
console.log(`✓ all ${vol.size} exported names covered by the map` + (unused.length ? ` (${unused.length} map entries unused)` : ''));

// ── 2. every "crm" target must exist, byte-identical ──────────────────────
const catalogue = await sql('select id, name, sku, price from public.products order by name;');
const byExactName = new Map(catalogue.map((p) => [p.name, p]));
const byLowerName = new Map(catalogue.map((p) => [p.name.toLowerCase().trim(), p]));

const badCrm = [];
for (const [alter, e] of Object.entries(map)) {
  if (!e.crm) continue;
  if (!byExactName.has(e.crm)) {
    const near = byLowerName.get(e.crm.toLowerCase().trim());
    badCrm.push({ alter, want: e.crm, near: near?.name ?? null });
  }
}
if (badCrm.length) {
  console.error('✗ These "crm" targets do not match a catalogue product exactly:');
  for (const b of badCrm) {
    console.error(`    ${b.alter} → "${b.want}"` + (b.near ? `  (case/space differs from "${b.near}")` : '  (no such product)'));
  }
  process.exit(1);
}
console.log(`✓ every mapped catalogue name resolves against ${catalogue.length} live products`);

// ── 3. roll up by canonical product ───────────────────────────────────────
const canon = new Map();
for (const [alter, e] of Object.entries(map)) {
  const k = e.canonical;
  if (!canon.has(k)) canon.set(k, { orders: 0, names: [], crm: e.crm || null, create: e.create || null, review: [] });
  const c = canon.get(k);
  c.orders += vol.get(alter) || 0;
  if (vol.has(alter)) c.names.push(alter);
  if (e.review) c.review.push(e.review);
}
const rows = [...canon.entries()].sort((a, b) => b[1].orders - a[1].orders);
const linked = rows.filter(([, c]) => c.crm);
const toCreate = rows.filter(([, c]) => c.create);
const linkedOrders = linked.reduce((a, [, c]) => a + c.orders, 0);
const createOrders = toCreate.reduce((a, [, c]) => a + c.orders, 0);

const missingPrice = toCreate.filter(([, c]) => !create[c.create]);
if (missingPrice.length) {
  console.error(`✗ No price proposed for: ${missingPrice.map(([k]) => k).join(', ')}`);
  process.exit(1);
}

// ── report ────────────────────────────────────────────────────────────────
const L = [];
const say = (s = '') => L.push(s);
say(`# AlterCPA → catalogue mapping — review`);
say();
say(`${orders.length.toLocaleString('en-US')} orders · ${vol.size} AlterCPA names · **${canon.size} canonical products**`);
say();
say(`- **${linked.length}** map onto products already in the catalogue — ${linkedOrders.toLocaleString('en-US')} orders (${((100 * linkedOrders) / orders.length).toFixed(1)}%)`);
say(`- **${toCreate.length}** need creating — ${createOrders.toLocaleString('en-US')} orders (${((100 * createOrders) / orders.length).toFixed(1)}%)`);
say();
say(`Nothing below is written to the catalogue until this file is signed off and the script`);
say(`is re-run with \`--commit\`.`);
say();
say(`## Maps onto an existing product`);
say();
say(`| canonical | orders | AlterCPA names collapsed | → catalogue |`);
say(`|---|---:|---|---|`);
for (const [k, c] of linked) {
  say(`| ${k} | ${c.orders.toLocaleString('en-US')} | ${c.names.join(' · ')} | \`${c.crm}\` |`);
}
say();
say(`## To be created`);
say();
say(`Prices are the shelf price we would sell at today, from the clean-denar bands in`);
say(`\`reprice-2026-08.json\`, chosen from each product's dominant historical price point.`);
say(`They do **not** touch imported orders, which keep the price the customer actually paid.`);
say();
say(`| canonical | orders | AlterCPA names collapsed | proposed price | stored EUR | commission tier |`);
say(`|---|---:|---|---:|---:|---|`);
for (const [k, c] of toCreate) {
  const den = create[c.create].price_den;
  const eur = Math.round((den / MKD_PER_EUR) * 100) / 100;
  const tier = eur >= 35 ? '3 (€3)' : eur > 25 ? '2 (€2)' : '1 (€1)';
  say(`| ${k} | ${c.orders.toLocaleString('en-US')} | ${c.names.join(' · ')} | ${den.toLocaleString('en-US')} ден | €${eur.toFixed(2)} | ${tier} |`);
}
say();
const reviews = rows.filter(([, c]) => c.review.length);
if (reviews.length) {
  say(`## Judgement calls to confirm`);
  say();
  for (const [k, c] of reviews) for (const r of c.review) say(`- **${k}** — ${r}`);
  say();
}
say(`## Unit costs`);
say();
say(`Every created product starts at \`cost_price = 0\`. Profit and margin reports will read`);
say(`100% margin on ${createOrders.toLocaleString('en-US')} orders until real costs are loaded — the same gap the 29`);
say(`existing zero-cost products already have. Costs are a separate, deliberate step.`);
say();

writeFileSync(OUT, L.join('\n'), 'utf8');
console.log(`\nWrote ${OUT}`);
console.log(`  canonical products : ${canon.size}`);
console.log(`  already in catalogue: ${linked.length}  (${linkedOrders.toLocaleString('en-US')} orders)`);
console.log(`  to create           : ${toCreate.length}  (${createOrders.toLocaleString('en-US')} orders)`);

if (!COMMIT) {
  console.log('\nDRY RUN — no catalogue changes. Re-run with --commit to create the products.');
  process.exit(0);
}

// ── commit ────────────────────────────────────────────────────────────────
const existing = new Set(catalogue.map((p) => p.name.toLowerCase().trim()));
const news = toCreate
  .map(([, c]) => c.create)
  .filter((n, i, a) => a.indexOf(n) === i)
  .filter((n) => !existing.has(n.toLowerCase().trim()));

if (!news.length) {
  console.log('\nAll products already exist. Nothing to create.');
  process.exit(0);
}
const values = news.map((n) => {
  const eur = Math.round((create[n].price_den / MKD_PER_EUR) * 100) / 100;
  const esc = n.replace(/'/g, "''");
  return `('${esc}', ${eur}, ${Number(create[n].cost_price) || 0}, 'Created for the AlterCPA history import (2026-08-05).', true)`;
}).join(',\n         ');

console.log(`\nCreating ${news.length} products…`);
await sql(`insert into public.products (name, price, cost_price, description, is_active)
values ${values};`);
const after = await sql(`select name, sku, price from public.products where name in (${news.map((n) => `'${n.replace(/'/g, "''")}'`).join(',')}) order by name;`);
for (const p of after) console.log(`  ${p.sku}  €${p.price}  ${p.name}`);
console.log(`\n✓ ${after.length} products created.`);
