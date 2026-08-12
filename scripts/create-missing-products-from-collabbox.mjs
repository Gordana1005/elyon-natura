#!/usr/bin/env node
/**
 * Create the catalogue entries the CRM is missing, from the collabBox register.
 *
 *   node scripts/create-missing-products-from-collabbox.mjs           # dry run
 *   node scripts/create-missing-products-from-collabbox.mjs --commit
 *
 * Run scripts/map-collabbox-skus.mjs first — this reads its output.
 *
 * ── Why ──
 * The CRM catalogue has 88 products. The register ships 179 distinct articles,
 * and after mapping, 123 of them have no CRM product at all — including some of
 * the busiest things the warehouse sends: КУРКУМА АКТИВ (4.071 lines),
 * УРО ПРОТЕКТ (3.321), СНАИЛ КОМПЛЕКС (1.794), ПАРА ДЕТОКС (1.317). Every order
 * line for those is unattributable, which is why order_items cannot be rebuilt
 * and missing orders cannot be created: an order needs a product.
 *
 * ── The price ──
 * EUR, derived from the median qty=1 line at the frozen 61,5 peg. Single-unit
 * lines only — a bulk deal ("3 for 1.490") would set a list price far below the
 * real one. Articles that never sold as a single unit get price 0 and are
 * flagged, rather than guessed at from an averaged bundle.
 *
 * ── is_active ──
 * True only if the article shipped in the trailing 90 days. The register runs
 * back to 2025-06, so plenty of these are discontinued lines that should exist
 * for history without appearing in an agent's product picker.
 *
 * stock_quantity is 0 deliberately: collabBox knows the real figure and we do
 * not, and inventing one would put phantom stock in front of the warehouse.
 * days_of_supply_per_unit takes the catalogue default of 15 — it feeds reorder
 * timing in the segment engine and wants a per-product review, not a guess.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import * as XLSX from 'xlsx';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REF = 'bmfxhgznttcnnlqloqzp';
const MKD_PER_EUR = 61.5;
const DEFAULT_SUPPLY_DAYS = 15;
const ACTIVE_WINDOW_DAYS = 90;
const COMMIT = process.argv.includes('--commit');

const env = { ...process.env };
for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*?)"?\s*$/);
  if (m && !env[m[1]]) env[m[1]] = m[2];
}
if (!(env.VITE_SUPABASE_URL || '').includes(REF)) { console.error('Not Macedonia. Refusing.'); process.exit(1); }
const sb = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const MAP = JSON.parse(readFileSync(join(ROOT, 'scripts', 'data', 'collabbox-sku-map.json'), 'utf8'));
const need = new Set(MAP.unmatched.map((u) => u.collabbox_sku));
console.log(`articles without a CRM product: ${need.size}`);

/* ── re-read the register for names, single-unit prices and last-seen dates ── */
const SERVICE_SKU = new Set(['8001', '8002']);
const isMarker = (sku, name) => /^ПОЕН/i.test(sku) || /КУПОН|ПОЕН/i.test(name) || sku === '600082';
const C = { sku: 2, item: 3, date: 8, qty: 20, val: 24 };
const num = (s) => Number(String(s ?? '').replace(/,/g, '').trim()) || 0;
const FILES = [
  'D:/Predikcii Final.xls',
  join(ROOT, '01.04.2025 - 31.12.2025.xls'),
  join(ROOT, '01.01.2026 - 31.03.2026 Pendinzi.xls'),
  join(ROOT, '01.04.2026 - 11.08.2026 Pendinzi.xls'),
];
const arts = new Map();
let maxDate = '';
for (const p of FILES) {
  const wb = XLSX.read(readFileSync(p), { type: 'buffer' });
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: false });
  for (const r of aoa.slice(2)) {
    const sku = String(r[C.sku] ?? '').trim();
    const name = String(r[C.item] ?? '').trim().replace(/\s+/g, ' ');
    if (!sku || SERVICE_SKU.has(sku) || isMarker(sku, name) || !need.has(sku)) continue;
    const dm = String(r[C.date] ?? '').match(/^(\d{2})\.(\d{2})\.(\d{4})/);
    const date = dm ? `${dm[3]}-${dm[2]}-${dm[1]}` : '';
    if (date > maxDate) maxDate = date;
    const qty = num(r[C.qty]), val = num(r[C.val]);
    if (!arts.has(sku)) arts.set(sku, { sku, names: new Map(), lines: 0, units: 0, singles: [], last: '' });
    const a = arts.get(sku);
    a.lines++; a.units += qty;
    a.names.set(name, (a.names.get(name) || 0) + 1);
    if (qty === 1 && val > 0) a.singles.push(val);
    if (date > a.last) a.last = date;
  }
}
const cutoff = new Date(Date.parse(`${maxDate}T00:00:00Z`) - ACTIVE_WINDOW_DAYS * 86400_000).toISOString().slice(0, 10);
const rows = [];
for (const a of arts.values()) {
  a.singles.sort((x, y) => x - y);
  const med = a.singles.length ? a.singles[Math.floor(a.singles.length / 2)] : null;
  rows.push({
    sku: a.sku,
    name: [...a.names.entries()].sort((x, y) => y[1] - x[1])[0][0],
    price: med ? Math.round((med / MKD_PER_EUR) * 100) / 100 : 0,
    priceKnown: med != null,
    lines: a.lines, units: a.units, last: a.last,
    is_active: a.last >= cutoff,
  });
}
rows.sort((x, y) => y.lines - x.lines);

console.log(`register last day: ${maxDate}   active cutoff: ${cutoff}`);
console.log(`to create: ${rows.length}   active ${rows.filter((r) => r.is_active).length} · archived ${rows.filter((r) => !r.is_active).length}`);
console.log(`  with a single-unit price: ${rows.filter((r) => r.priceKnown).length}   without (price 0): ${rows.filter((r) => !r.priceKnown).length}`);
console.log(`  order lines they cover:   ${rows.reduce((s, r) => s + r.lines, 0).toLocaleString('en-US')}`);
console.log('\n  biggest:');
for (const r of rows.slice(0, 15)) {
  console.log(`    ${r.sku.padEnd(8)} ${String(r.lines).padStart(5)} lines  €${String(r.price).padStart(6)}  ${r.is_active ? 'active  ' : 'archived'} last ${r.last}  ${r.name.slice(0, 44)}`);
}
const noPrice = rows.filter((r) => !r.priceKnown);
if (noPrice.length) {
  console.log(`\n  ⚠ never sold as a single unit — created at price 0, needs a price before use:`);
  for (const r of noPrice.slice(0, 10)) console.log(`    ${r.sku.padEnd(8)} ${String(r.lines).padStart(5)} lines  ${r.name.slice(0, 50)}`);
}

if (!COMMIT) { console.log('\nDRY RUN — nothing created. Re-run with --commit.'); process.exit(0); }

/* ── guard: never create a SKU that already exists ── */
const { data: existing } = await sb.from('products').select('sku');
const have = new Set((existing || []).map((p) => String(p.sku).trim()));
const fresh = rows.filter((r) => !have.has(r.sku));
console.log(`\ncreating ${fresh.length} (${rows.length - fresh.length} already present)`);

const created = [];
for (let i = 0; i < fresh.length; i += 50) {
  const chunk = fresh.slice(i, i + 50).map((r) => ({
    name: r.name, sku: r.sku, price: r.price, description: '', category: '',
    is_active: r.is_active, stock_quantity: 0, low_stock_threshold: 5, cost_price: 0,
    days_of_supply_per_unit: DEFAULT_SUPPLY_DAYS,
  }));
  const { data, error } = await sb.from('products').insert(chunk).select('id,sku,name');
  if (error) { console.error(`  chunk ${i}: ${error.message}`); continue; }
  created.push(...(data || []));
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const RB = join(ROOT, 'scripts', 'data', `products-created-${stamp}.json`);
writeFileSync(RB, JSON.stringify({ note: 'Delete these to roll back', created }, null, 2), 'utf8');
console.log(`✓ created ${created.length} products`);
console.log(`rollback → ${RB}`);
