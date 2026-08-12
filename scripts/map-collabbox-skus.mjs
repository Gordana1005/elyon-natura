#!/usr/bin/env node
/**
 * Map collabBox warehouse SKUs onto the CRM catalogue.
 *
 *   node scripts/map-collabbox-skus.mjs                 # report only
 *   node scripts/map-collabbox-skus.mjs --commit        # write products.sku
 *
 * ── Why ──
 * All 88 CRM products carry a placeholder SKU (`SKU-000042`) and no barcode, so
 * nothing joins the catalogue to anything real. collabBox is the Macedonian
 * warehouse/accounting system (Accent Computers) and its line items carry the
 * actual article codes — `000042 СНАИЛ КОМПЛЕКС cps 30`. Those are the codes
 * the warehouse picks by.
 *
 * Overwriting `products.sku` is safe here: `src/lib/bigarenaStock.ts` matches
 * stock rows on an `NT____` SKU and NONE of the 88 currently have one, so that
 * path already matches nothing — and BigArena is the Bulgarian 3PL that
 * CLAUDE.md forbids using for real Macedonian shipments anyway.
 *
 * ── Matching ──
 * Names are Macedonian Cyrillic on one side and mixed Latin/Cyrillic on the
 * other ("ДР.СЛИМ 90 цпс" vs "DR.SLIM 90cps"), so both go through
 * normalizeMkGeo() from scripts/lib/mk-translit.mjs — the same lossy key that
 * reconciles MEX city names, and the only transliteration in this repo that
 * actually covers all seven Macedonian letters.
 *
 * Two keys per name: one with digits, one without. Pack sizes are written
 * inconsistently ("30/1", "30 cps", "cps 30"), so the digit-free key carries
 * the match and the digits only ever raise confidence.
 *
 * Evidence is never a name alone. The collabBox unit price is compared against
 * the CRM price × 61,5 — an independent witness, the same way COD corroborated
 * the shipment links. A name match that the price contradicts is reported,
 * not applied.
 *
 * That price MUST come from qty=1 lines only. Dividing a line's value by its
 * quantity averages the call centre's bulk deals ("3 for 1.490") into a unit
 * price far below list, which then contradicts a perfectly good name match:
 * ХЕМОРО ФОРТЕ averages 600 ден against a 2.490 ден list price. The single-unit
 * lines are the only ones that quote the list price back.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import * as XLSX from 'xlsx';
import { normalizeMkGeo } from './lib/mk-translit.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REF = 'bmfxhgznttcnnlqloqzp';
const MKD_PER_EUR = 61.5;
const COMMIT = process.argv.includes('--commit');

const env = { ...process.env };
for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*?)"?\s*$/);
  if (m && !env[m[1]]) env[m[1]] = m[2];
}
if (!(env.VITE_SUPABASE_URL || '').includes(REF)) { console.error('Not Macedonia. Refusing.'); process.exit(1); }
const sb = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const H = (t) => console.log(`\n${'═'.repeat(74)}\n${t}\n${'═'.repeat(74)}`);

/* ── collabBox articles ── */
const SERVICE_SKU = new Set(['8001', '8002']);
// Not articles: loyalty points and coupon markers, all zero-value.
const isMarker = (sku, name) => /^ПОЕН/i.test(sku) || /КУПОН|ПОЕН/i.test(name) || sku === '600082';
const C = { sku: 2, item: 3, qty: 20, val: 24 };
const num = (s) => Number(String(s ?? '').replace(/,/g, '').trim()) || 0;
const FILES = [
  'D:/Predikcii Final.xls',
  join(ROOT, '01.04.2025 - 31.12.2025.xls'),
  join(ROOT, '01.01.2026 - 31.03.2026 Pendinzi.xls'),
  join(ROOT, '01.04.2026 - 11.08.2026 Pendinzi.xls'),
];
const arts = new Map();
for (const p of FILES) {
  const wb = XLSX.read(readFileSync(p), { type: 'buffer' });
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: false });
  for (const r of aoa.slice(2)) {
    const sku = String(r[C.sku] ?? '').trim();
    const name = String(r[C.item] ?? '').trim().replace(/\s+/g, ' ');
    if (!sku || SERVICE_SKU.has(sku) || isMarker(sku, name)) continue;
    const qty = num(r[C.qty]), val = num(r[C.val]);
    if (!arts.has(sku)) arts.set(sku, { sku, names: new Map(), lines: 0, units: 0, singles: [] });
    const a = arts.get(sku);
    a.lines++; a.units += qty;
    a.names.set(name, (a.names.get(name) || 0) + 1);
    // qty=1 lines only — see the header note on bulk deals.
    if (qty === 1 && val > 0) a.singles.push(val);
  }
}
for (const a of arts.values()) {
  a.name = [...a.names.entries()].sort((x, y) => y[1] - x[1])[0][0];
  a.singles.sort((x, y) => x - y);
  a.medianUnit = a.singles.length ? a.singles[Math.floor(a.singles.length / 2)] : null;
  a.singleCount = a.singles.length;
}
console.log(`collabBox articles: ${arts.size}`);

/* ── CRM catalogue ── */
const { data: prods, error } = await sb.from('products').select('id,name,sku,price,stock_quantity,is_active');
if (error) throw new Error(error.message);
console.log(`CRM products:       ${prods.length}`);

/* ── keys ── */
const keyFull = (s) => normalizeMkGeo(s);
const keyAlpha = (s) => normalizeMkGeo(s).replace(/[0-9]/g, '');
for (const p of prods) { p.kf = keyFull(p.name); p.ka = keyAlpha(p.name); }
for (const a of arts.values()) { a.kf = keyFull(a.name); a.ka = keyAlpha(a.name); }

const priceOk = (a, p) => {
  if (!a.medianUnit || !(Number(p.price) > 0)) return null;
  const exp = Number(p.price) * MKD_PER_EUR;
  // 20%: the catalogue was re-priced in EUR during the period the register
  // covers (scripts/reprice-catalogue-mk.mjs), so a good match can still drift.
  return Math.abs(a.medianUnit - exp) / exp <= 0.20;
};

/* ── match ── */
const results = [];
const claimed = new Map();     // product id → article (a product takes one SKU)
const sorted = [...arts.values()].sort((x, y) => y.lines - x.lines);   // busiest article wins a contested product
for (const a of sorted) {
  if (!a.ka) { results.push({ a, tier: 'unusable name' }); continue; }
  let cands = prods.filter((p) => p.kf === a.kf);
  let how = 'exact (with size)';
  if (!cands.length) { cands = prods.filter((p) => p.ka === a.ka); how = 'exact (name only)'; }
  if (!cands.length) {
    cands = prods.filter((p) => p.ka.length >= 5 && a.ka.length >= 5
      && (p.ka.includes(a.ka) || a.ka.includes(p.ka)));
    how = 'containment';
  }
  const free = cands.filter((p) => !claimed.has(p.id));
  if (!free.length) { results.push({ a, tier: cands.length ? 'product already claimed' : 'no candidate' }); continue; }

  let pick = free[0];
  if (free.length > 1) {
    const corroborated = free.filter((p) => priceOk(a, p) === true);
    if (corroborated.length === 1) pick = corroborated[0];
    else { results.push({ a, tier: 'ambiguous', cands: free.map((p) => p.name) }); continue; }
  }
  const pOk = priceOk(a, pick);
  if (how === 'containment' && pOk === false) { results.push({ a, p: pick, tier: 'name matched, price contradicts', pOk }); continue; }
  claimed.set(pick.id, a);
  results.push({ a, p: pick, tier: 'matched', how, pOk });
}

/* ── report ── */
const matched = results.filter((r) => r.tier === 'matched');
H('RESULT');
const byHow = {};
for (const r of matched) byHow[r.how] = (byHow[r.how] || 0) + 1;
console.log(`  matched articles      ${String(matched.length).padStart(4)} / ${arts.size}   (${Object.entries(byHow).map(([k, v]) => `${k} ${v}`).join(' · ')})`);
console.log(`  price corroborates    ${String(matched.filter((r) => r.pOk === true).length).padStart(4)}`);
console.log(`  price contradicts     ${String(matched.filter((r) => r.pOk === false).length).padStart(4)}  (name evidence was exact — reported below)`);
console.log(`  price unavailable     ${String(matched.filter((r) => r.pOk === null).length).padStart(4)}`);
for (const t of ['ambiguous', 'name matched, price contradicts', 'product already claimed', 'no candidate', 'unusable name']) {
  const n = results.filter((r) => r.tier === t).length;
  if (n) console.log(`  ${t.padEnd(32)} ${String(n).padStart(4)}`);
}
const lines = (rs) => rs.reduce((s, r) => s + r.a.lines, 0);
console.log(`\n  line-item coverage: ${lines(matched).toLocaleString('en-US')} / ${lines(results).toLocaleString('en-US')} (${((100 * lines(matched)) / lines(results)).toFixed(1)}%)`);
console.log(`  CRM products given a real SKU: ${claimed.size} / ${prods.length}`);

const suspicious = matched.filter((r) => r.pOk === false);
if (suspicious.length) {
  console.log(`\n  ⚠ matched on an exact name but the price disagrees — check these:`);
  for (const r of suspicious.slice(0, 12)) {
    console.log(`     ${r.a.sku}  ${r.a.name.slice(0, 38).padEnd(38)} ${Math.round(r.a.medianUnit)} ден  vs  ${r.p.name.slice(0, 30).padEnd(30)} €${r.p.price} (${Math.round(Number(r.p.price) * MKD_PER_EUR)} ден)`);
  }
}
const unmatchedBig = results.filter((r) => r.tier !== 'matched').sort((x, y) => y.a.lines - x.a.lines);
if (unmatchedBig.length) {
  console.log(`\n  biggest UNMATCHED articles (no CRM product — these need creating):`);
  for (const r of unmatchedBig.slice(0, 15)) {
    console.log(`     ${r.a.sku.padEnd(8)} ${String(r.a.lines).padStart(5)} lines  ${r.a.medianUnit ? `${Math.round(r.a.medianUnit)} ден`.padStart(9) : '        —'}  ${r.a.name.slice(0, 46)}   [${r.tier}]`);
  }
}
const orphan = prods.filter((p) => !claimed.has(p.id));
console.log(`\n  CRM products with NO collabBox article (${orphan.length}): ${orphan.slice(0, 10).map((p) => p.name.slice(0, 24)).join(' · ')}${orphan.length > 10 ? ' …' : ''}`);

console.log('\n  sample of what would be written:');
for (const r of matched.slice(0, 8)) {
  console.log(`     ${String(r.p.sku).padEnd(12)} → ${r.a.sku.padEnd(8)}  ${r.p.name.slice(0, 34).padEnd(34)} ← ${r.a.name.slice(0, 34)}`);
}

/* ── write ── */
const MAP_OUT = join(ROOT, 'scripts', 'data', 'collabbox-sku-map.json');
writeFileSync(MAP_OUT, JSON.stringify({
  generated: new Date().toISOString(),
  note: 'collabBox article code → CRM product. Consumed by the order_items rebuild.',
  matched: matched.map((r) => ({ collabbox_sku: r.a.sku, collabbox_name: r.a.name, lines: r.a.lines,
    median_unit_mkd: r.a.medianUnit ? Math.round(r.a.medianUnit) : null,
    product_id: r.p.id, product_name: r.p.name, old_sku: r.p.sku, price_eur: Number(r.p.price),
    how: r.how, price_corroborates: r.pOk })),
  unmatched: unmatchedBig.map((r) => ({ collabbox_sku: r.a.sku, collabbox_name: r.a.name, lines: r.a.lines,
    median_unit_mkd: r.a.medianUnit ? Math.round(r.a.medianUnit) : null, reason: r.tier })),
}, null, 2), 'utf8');
console.log(`\nmap → ${MAP_OUT}`);

if (!COMMIT) { console.log('\nDRY RUN — products.sku not written. Re-run with --commit.'); process.exit(0); }

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const RB = join(ROOT, 'scripts', 'data', `product-sku-rollback-${stamp}.json`);
writeFileSync(RB, JSON.stringify(matched.map((r) => ({ id: r.p.id, name: r.p.name, sku: r.p.sku })), null, 2), 'utf8');
console.log(`rollback → ${RB}`);
let ok = 0, fail = 0;
for (const r of matched) {
  const { error: e } = await sb.from('products').update({ sku: r.a.sku }).eq('id', r.p.id);
  if (e) { fail++; console.error(`  ${r.p.name}: ${e.message}`); } else ok++;
}
console.log(`\n✓ updated ${ok} products, failed ${fail}`);
