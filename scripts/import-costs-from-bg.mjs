#!/usr/bin/env node
/**
 * Copy per-unit PURCHASE COST (products.cost_price) from the Bulgarian
 * catalogue into the Macedonian one, matching products by name.
 *
 *   node scripts/import-costs-from-bg.mjs            # dry run, writes nothing
 *   node scripts/import-costs-from-bg.mjs --commit   # write MK cost_price
 *
 * Why this exists: every MK product shipped with cost_price = 0, so Pure Profit
 * reported 100% margin and Margin Lab's floor-price calculator was meaningless.
 * The two catalogues are the same products (MK is a hard fork of BG), and BG has
 * real costs recorded, so BG is the only available source of truth today.
 *
 * Why NOT scripts/import-natura-costs.mjs: that script carries a hand-typed map
 * transcribed from a spreadsheet, and several of its figures now disagree with
 * the BG database (e.g. Curcumactiv 4.23 vs 6.30, Saw Palmetto 1.27 vs 1.60).
 * Reading both databases live removes the transcription step entirely.
 *
 * ── BULGARIA SAFETY ────────────────────────────────────────────────────────
 * Bulgaria is a separate LIVE business and is off limits for writes. This script
 * touches it with HTTP GET only, through one helper (bgGet) that hard-codes the
 * method. Every write goes to Macedonia. The guards below refuse to run if the
 * two projects are ever transposed.
 *
 * Rollback: update public.products set cost_price = 0;   (the prior state)
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MK_REF = 'oufoazmnbwugtfldkwsn';
const BG_REF = 'sxymaloycddnoxudxaqp';
const BG_ENV = 'C:/Users/Mile/Desktop/elyoncrm/.env';
const COMMIT = process.argv.includes('--commit');

const fail = (m) => { console.error(`\x1b[31m✗ ${m}\x1b[0m`); process.exit(1); };

const parseEnv = (path) => {
  const out = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
};

// Guard 1: this repo must be the Macedonian one.
const toml = readFileSync(join(root, 'supabase', 'config.toml'), 'utf8');
const ref = toml.match(/^\s*project_id\s*=\s*"([^"]+)"/m)?.[1];
if (ref !== MK_REF) fail(`config.toml project_id = "${ref}", expected "${MK_REF}"`);

const mkEnv = parseEnv(join(root, '.env'));
const MK_URL = mkEnv.SUPABASE_URL || mkEnv.VITE_SUPABASE_URL;
const MK_KEY = mkEnv.SUPABASE_SERVICE_ROLE_KEY;
if (!MK_URL || !MK_KEY) fail('MK SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing');

// Guard 2: the write target must be Macedonia and must not be Bulgaria.
if (!MK_URL.includes(MK_REF)) fail(`write target ${MK_URL} is not the MK project`);
if (MK_URL.includes(BG_REF)) fail('REFUSING: the write target is Bulgaria.');

const bgEnv = parseEnv(BG_ENV);
const BG_URL = bgEnv.SUPABASE_URL || bgEnv.VITE_SUPABASE_URL;
const BG_KEY = bgEnv.SUPABASE_SERVICE_ROLE_KEY;
if (!BG_URL || !BG_KEY) fail(`could not read BG credentials from ${BG_ENV}`);

// Guard 3: the read source must be Bulgaria (otherwise we would be copying MK's
// own zeroes back onto itself and reporting success).
if (!BG_URL.includes(BG_REF)) fail(`read source ${BG_URL} is not the BG project`);

/** Bulgaria: GET only. The method is not a parameter, on purpose. */
const bgGet = async (path) => {
  const res = await fetch(`${BG_URL}/rest/v1/${path}`, {
    method: 'GET',
    headers: { apikey: BG_KEY, Authorization: `Bearer ${BG_KEY}` },
  });
  if (!res.ok) throw new Error(`BG GET ${path} → ${res.status} ${await res.text()}`);
  return res.json();
};

const mk = async (path, method = 'GET', body) => {
  const res = await fetch(`${MK_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: MK_KEY, Authorization: `Bearer ${MK_KEY}`,
      'Content-Type': 'application/json', Prefer: 'return=minimal',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`MK ${method} ${path} → ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
};

// Names differ only in incidental whitespace/case between the two catalogues
// (e.g. "Diet shake vanilla  500g" has a double space in one of them).
const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').replace(/\.$/, '').trim();

console.log(`Reading costs  ← BG ${BG_URL}  (GET only)`);
console.log(`Writing costs  → MK ${MK_URL}\n`);

const bgProducts = await bgGet('products?select=name,cost_price,price');
const mkProducts = await mk('products?select=id,name,cost_price,price');

const bgByName = new Map();
for (const p of bgProducts) bgByName.set(norm(p.name), p);

const willSet = [], unchanged = [], noCost = [], noMatch = [];
for (const p of mkProducts) {
  const bg = bgByName.get(norm(p.name));
  if (!bg) { noMatch.push(p); continue; }
  const cost = Number(bg.cost_price ?? 0);
  if (!(cost > 0)) { noCost.push(p); continue; }
  if (Number(p.cost_price ?? 0) === cost) { unchanged.push(p); continue; }
  willSet.push({ id: p.id, name: p.name, cost, price: Number(p.price ?? 0) });
}

// A BG value that looks BGN-scale rather than EUR would silently inflate every
// margin. The lev peg is 1.95583, so anything above half the shelf price is
// suspicious for this catalogue (real costs run 5-25% of the shelf price).
const suspicious = willSet.filter((r) => r.price > 0 && r.cost > r.price * 0.5);
if (suspicious.length) {
  console.log('\x1b[33m⚠ costs that look too high vs the MK shelf price — check the currency:\x1b[0m');
  for (const r of suspicious) console.log(`   €${r.cost.toFixed(2)} cost vs €${r.price.toFixed(2)} price  ${r.name}`);
  fail('refusing to write until these are explained');
}

console.log(`MK catalogue: ${mkProducts.length} products · BG catalogue: ${bgProducts.length}\n`);
console.log(`=== WILL SET cost_price (${willSet.length}) ===`);
for (const r of willSet.sort((a, b) => b.cost - a.cost)) {
  const margin = r.price > 0 ? `  margin €${(r.price - r.cost).toFixed(2)} (${Math.round((1 - r.cost / r.price) * 100)}%)` : '  (no shelf price)';
  console.log(`  €${r.cost.toFixed(2).padStart(6)}  ${r.name.padEnd(46).slice(0, 46)}${margin}`);
}
if (unchanged.length) console.log(`\n· ${unchanged.length} already correct`);
console.log(`\n=== BG has no cost either (${noCost.length}) ===`);
for (const p of noCost) console.log(`  · ${p.name}`);
if (noMatch.length) {
  console.log(`\n=== no BG counterpart (${noMatch.length}) ===`);
  for (const p of noMatch) console.log(`  ? ${p.name}`);
}

if (!COMMIT) {
  console.log('\nDry run. Re-run with --commit to write the costs above to Macedonia.\n');
  process.exit(0);
}

let n = 0;
for (const r of willSet) {
  await mk(`products?id=eq.${r.id}`, 'PATCH', { cost_price: r.cost });
  n++;
}
console.log(`\n\x1b[32m✓ cost_price set on ${n} Macedonian products.\x1b[0m`);
console.log('Confirm these against real MK supplier invoices — they are Bulgarian sourcing figures.\n');
