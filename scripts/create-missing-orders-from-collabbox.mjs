#!/usr/bin/env node
/**
 * Create the orders the CRM never received, from the collabBox register.
 *
 *   node scripts/create-missing-orders-from-collabbox.mjs            # dry run
 *   node scripts/create-missing-orders-from-collabbox.mjs --commit
 *
 * Run first: scripts/map-collabbox-skus.mjs (writes collabbox-sku-map.json) and
 * scripts/create-missing-products-from-collabbox.mjs.
 *
 * ── What is missing and why ──
 * The CRM holds AlterCPA inbound leads only. Two things never reached it: the
 * whole outbound register (Predikcii — the call centre working the prediction
 * lists, which never existed in AlterCPA), and inbound documents whose lead was
 * lost. Every one is a real order the warehouse dispatched.
 *
 * ── Status: an operator decision, recorded here ──
 * Marked `paid`, on the operator's instruction of 2026-08-12 ("the manager says
 * ~95% of them were paid"). The register itself does NOT say this: searching all
 * 52 columns over the MEX era, where the courier knows the answer, no column
 * separates the 9.569 delivered documents from the 2.246 returned ones — the
 * best is quantity at a 4,3% gap, i.e. noise. So `paid` here is the operator's
 * business knowledge, not something read out of the file.
 *
 * The exception, and it is not a deviation from that instruction: where MEX has
 * the parcel and says it came BACK, the order is created `returned`. Marking a
 * parcel we can prove returned as paid would be knowingly false, and it is the
 * precise error that put 10 returned parcels on the books as revenue before.
 *
 * ── Never creates a duplicate ──
 * Only documents with NO candidate order on that phone in the window are
 * created. Where a phone has an order that merely could not be told apart from
 * a rival document, the document is reported and skipped — a missed order is
 * recoverable, a duplicated customer history corrupts the prediction lists.
 * (external_source, external_order_id) is partial-unique, so a re-run is
 * idempotent even if this rule is later loosened.
 *
 * ── Traps respected ──
 * `trg_orders_set_paid_at` is NULL-only and would stamp a 2025 order with
 * today's date, so paid_at/returned_at are set explicitly. created_at is noon
 * UTC, matching the AlterCPA import — a naked date is UTC midnight, which is
 * 02:00 in Skopje and lands the order on the previous day.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import * as XLSX from 'xlsx';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REF = 'bmfxhgznttcnnlqloqzp';
const MKD_PER_EUR = 61.5;
const COMMIT = process.argv.includes('--commit');
const LIMIT = (() => { const i = process.argv.indexOf('--limit'); return i >= 0 ? Number(process.argv[i + 1]) : null; })();

const env = { ...process.env };
for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*?)"?\s*$/);
  if (m && !env[m[1]]) env[m[1]] = m[2];
}
if (!(env.VITE_SUPABASE_URL || '').includes(REF)) { console.error('Not Macedonia. Refusing.'); process.exit(1); }
const sb = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const H = (t) => console.log(`\n${'═'.repeat(74)}\n${t}\n${'═'.repeat(74)}`);

/* ── helpers ── */
const num = (s) => Number(String(s ?? '').replace(/,/g, '').trim()) || 0;
const last8 = (v) => { const d = String(v || '').replace(/\D/g, ''); return d.length >= 8 ? d.slice(-8) : null; };
/** Local MK number (071680074, 71680074, 389…) → E.164, the way orders store it. */
function toE164(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('00389')) d = d.slice(5);
  else if (d.startsWith('389')) d = d.slice(3);
  else if (d.startsWith('0')) d = d.slice(1);
  return d.length === 8 ? `+389${d}` : null;
}
/** "ул. Битолска 12-Прилеп" → { address, city } — city is the tail after the last dash. */
function splitAddress(raw) {
  const t = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!t) return { address: '', city: '' };
  const i = t.lastIndexOf('-');
  if (i <= 0 || i === t.length - 1) return { address: t, city: '' };
  return { address: t.slice(0, i).trim(), city: t.slice(i + 1).trim() };
}

/* ── SKU map ── */
const skuMap = new Map();
for (const m of JSON.parse(readFileSync(join(ROOT, 'scripts', 'data', 'collabbox-sku-map.json'), 'utf8')).matched) {
  skuMap.set(m.collabbox_sku, { id: m.product_id, name: m.product_name });
}
console.log(`SKU map: ${skuMap.size} articles → products`);

/* ── MEX ── */
const mex = new Map();
for (const s of JSON.parse(readFileSync(join(ROOT, 'scripts', 'data', 'mex-shipments.json'), 'utf8'))) {
  mex.set(s.tracking_id, s);
}

/* ── collabBox ── */
const SERVICE_SKU = new Set(['8001', '8002']);
const isMarker = (sku, name) => /^ПОЕН/i.test(sku) || /КУПОН|ПОЕН/i.test(name) || sku === '600082';
const C = { sku: 2, item: 3, party: 7, date: 8, doc: 10, author: 11, qty: 20, val: 24 };
const parseParty = (s) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  const m = t.match(/^(.*?)\s*Адреса:\s*(.*?)\s*Телефон:\s*(.*)$/);
  if (m) return { name: m[1].trim(), addr: m[2].trim(), phone: m[3].trim() };
  const m2 = t.match(/^(.*?)\s*Телефон:\s*(.*)$/);
  return m2 ? { name: m2[1].trim(), addr: '', phone: m2[2].trim() } : { name: t, addr: '', phone: '' };
};
const FILES = [
  ['D:/Predikcii Final.xls', 'Predikcii'],
  [join(ROOT, '01.04.2025 - 31.12.2025.xls'), 'Pendinzi'],
  [join(ROOT, '01.01.2026 - 31.03.2026 Pendinzi.xls'), 'Pendinzi'],
  [join(ROOT, '01.04.2026 - 11.08.2026 Pendinzi.xls'), 'Pendinzi'],
];
const docs = new Map();
for (const [path, register] of FILES) {
  const wb = XLSX.read(readFileSync(path), { type: 'buffer' });
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: false });
  for (const r of aoa.slice(2)) {
    const doc = String(r[C.doc] ?? '').trim();
    const dm = String(r[C.date] ?? '').match(/^(\d{2})\.(\d{2})\.(\d{4})/);
    if (!doc || !dm) continue;
    let d = docs.get(doc);
    if (!d) {
      const p = parseParty(r[C.party]);
      const { address, city } = splitAddress(p.addr);
      d = { doc, register, date: `${dm[3]}-${dm[2]}-${dm[1]}`, name: p.name, address, city,
            phone: toE164(p.phone), tel8: last8(p.phone), author: String(r[C.author] ?? '').trim(),
            goodsMkd: 0, units: 0, lines: [] };
      docs.set(doc, d);
    }
    const sku = String(r[C.sku] ?? '').trim();
    const name = String(r[C.item] ?? '').trim().replace(/\s+/g, ' ');
    if (SERVICE_SKU.has(sku) || isMarker(sku, name)) continue;
    const qty = num(r[C.qty]), val = num(r[C.val]);
    d.goodsMkd += val; d.units += qty;
    d.lines.push({ sku, name, qty, val });
  }
}
console.log(`collabBox documents: ${docs.size.toLocaleString('en-US')}`);

/* ── orders ── */
async function loadAll(build) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    let attempt = 0, data, error;
    for (;;) {
      ({ data, error } = await build().range(from, from + 999));
      if (!error || ++attempt >= 4) break;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
    if (error) throw new Error(error.message);
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return rows;
}
console.log('loading orders…');
const orders = await loadAll(() => sb.from('orders')
  .select('id, customer_phone, created_at, mex_tracking_id, external_source, external_order_id')
  .order('created_at'));
console.log(`orders: ${orders.length.toLocaleString('en-US')}`);
const already = new Set(orders.filter((o) => o.external_source === 'collabbox').map((o) => o.external_order_id));
const byTrack = new Map();
const byPhone = new Map();
for (const o of orders) {
  if (o.mex_tracking_id) byTrack.set(o.mex_tracking_id, o);
  const k = last8(o.customer_phone);
  if (k) { if (!byPhone.has(k)) byPhone.set(k, []); byPhone.get(k).push(o); }
}

/* ── which documents have no order ── */
const DAY = 86400_000;
const byDate = [...docs.values()].sort((a, b) => a.date.localeCompare(b.date) || a.doc.localeCompare(b.doc));
const claimed = new Set();
for (const d of byDate) { const o = byTrack.get(d.doc); if (o) claimed.add(o.id); }
const missing = [];
const skip = { matched: 0, ambiguous: 0, no_phone: 0, no_product: 0, already: 0 };
for (const d of byDate) {
  if (already.has(d.doc)) { skip.already++; continue; }
  if (byTrack.get(d.doc)) { skip.matched++; continue; }
  if (!d.phone || !d.tel8) { skip.no_phone++; continue; }
  const dd = Date.parse(`${d.date}T12:00:00Z`);
  const cands = (byPhone.get(d.tel8) || []).filter((x) => !claimed.has(x.id) && !x.mex_tracking_id
    && (dd - Date.parse(x.created_at)) >= -2 * DAY && (dd - Date.parse(x.created_at)) <= 10 * DAY);
  if (cands.length === 1) { claimed.add(cands[0].id); skip.matched++; continue; }
  if (cands.length > 1) { skip.ambiguous++; continue; }
  // primary product = the most valuable line, which is what the order header names
  const withProd = d.lines.filter((l) => skuMap.has(l.sku));
  if (!withProd.length) { skip.no_product++; continue; }
  const primary = withProd.slice().sort((a, b) => b.val - a.val || b.qty - a.qty)[0];
  missing.push({ d, primary });
}

H('MISSING ORDERS');
console.log(`  to create              ${String(missing.length).padStart(6)}`);
console.log(`  already has an order   ${String(skip.matched).padStart(6)}`);
console.log(`  ambiguous — skipped    ${String(skip.ambiguous).padStart(6)}  (an order exists but cannot be told from a rival document)`);
console.log(`  unusable phone         ${String(skip.no_phone).padStart(6)}`);
console.log(`  no mappable product    ${String(skip.no_product).padStart(6)}`);
console.log(`  created by an earlier run ${String(skip.already).padStart(4)}`);

const byReg = {};
for (const m of missing) byReg[m.d.register] = (byReg[m.d.register] || 0) + 1;
console.log(`\n  by register: ${Object.entries(byReg).map(([k, v]) => `${k} ${v.toLocaleString('en-US')}`).join(' · ')}`);
const withMex = missing.filter((m) => mex.has(m.d.doc));
const mexRet = withMex.filter((m) => mex.get(m.d.doc).current_status_id === 7);
console.log(`  with a MEX parcel: ${withMex.length.toLocaleString('en-US')}  → ${mexRet.length.toLocaleString('en-US')} of them RETURNED (created 'returned', not 'paid')`);
const value = missing.reduce((s, m) => s + m.d.goodsMkd, 0);
console.log(`  value: ${Math.round(value).toLocaleString('en-US')} ден  (€${Math.round(value / MKD_PER_EUR).toLocaleString('en-US')})`);
const withAddr = missing.filter((m) => m.d.address).length;
console.log(`  with an address: ${withAddr.toLocaleString('en-US')} · with a city: ${missing.filter((m) => m.d.city).length.toLocaleString('en-US')} · multi-line: ${missing.filter((m) => m.d.lines.length > 1).length.toLocaleString('en-US')}`);

console.log('\n  sample:');
for (const m of missing.slice(0, 6)) {
  const st = mex.get(m.d.doc)?.current_status_id === 7 ? 'returned' : 'paid';
  console.log(`    ${m.d.date} ${m.d.register.padEnd(9)} ${m.d.phone}  ${st.padEnd(8)} €${(m.d.goodsMkd / MKD_PER_EUR).toFixed(2).padStart(7)} ×${m.d.units}  ${m.primary.name.slice(0, 30).padEnd(30)} │ ${m.d.name.slice(0, 20)} · ${m.d.city}`);
}

if (!COMMIT) { console.log('\nDRY RUN — nothing created. Re-run with --commit.'); process.exit(0); }

/* ── create ── */
const todo = LIMIT ? missing.slice(0, LIMIT) : missing;
console.log(`\ncreating ${todo.length.toLocaleString('en-US')}…`);
const createdIds = [];
let made = 0, failed = 0;
for (let i = 0; i < todo.length; i += 100) {
  const chunk = todo.slice(i, i + 100);
  const rows = chunk.map(({ d, primary }) => {
    const ship = mex.get(d.doc);
    const returned = ship?.current_status_id === 7;
    const at = `${d.date}T12:00:00+00:00`;
    const prod = skuMap.get(primary.sku);
    return {
      product_id: prod.id, product_name: prod.name,
      customer_name: d.name || '', customer_phone: d.phone,
      customer_address: d.address || '', customer_city: d.city || '',
      price: Math.round((d.goodsMkd / MKD_PER_EUR) * 100) / 100,
      // collabBox occasionally books a fractional quantity (3.1); the column is
      // an integer, so round up — a dispatched part-unit is still a unit shipped.
      quantity: d.units > 0 ? Math.max(1, Math.ceil(d.units)) : 1,
      status: returned ? 'returned' : 'paid',
      paid_at: returned ? null : at,
      returned_at: returned ? at : null,
      created_at: at,
      source_type: 'import',
      delivery_type: 'home',
      external_source: 'collabbox',
      external_order_id: d.doc,
      mex_tracking_id: ship ? d.doc : null,
      confirmed_by_name: d.author || null,
    };
  });
  const { data, error } = await sb.from('orders').insert(rows).select('id, external_order_id');
  if (error) { failed += chunk.length; console.error(`  chunk ${i}: ${error.message}`); continue; }
  made += data.length;
  createdIds.push(...data.map((r) => r.id));

  // line items — now possible because the catalogue covers 98,3% of lines
  const idByDoc = new Map(data.map((r) => [r.external_order_id, r.id]));
  const items = [];
  for (const { d } of chunk) {
    const oid = idByDoc.get(d.doc);
    if (!oid) continue;
    for (const l of d.lines) {
      const p = skuMap.get(l.sku);
      if (!p) continue;
      items.push({ order_id: oid, product_id: p.id, product_name: p.name,
        quantity: l.qty > 0 ? Math.max(1, Math.ceil(l.qty)) : 1,
        price_per_unit: l.qty > 0 ? Math.round((l.val / l.qty / MKD_PER_EUR) * 100) / 100 : 0,
        total_price: Math.round((l.val / MKD_PER_EUR) * 100) / 100 });
    }
  }
  if (items.length) {
    const { error: ie } = await sb.from('order_items').insert(items);
    if (ie) console.error(`  items chunk ${i}: ${ie.message}`);
  }
  if (made % 500 < 100) console.log(`  ${made.toLocaleString('en-US')}/${todo.length.toLocaleString('en-US')}`);
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const RB = join(ROOT, 'scripts', 'data', `orders-created-${stamp}.json`);
writeFileSync(RB, JSON.stringify({ note: 'Delete these order ids to roll back (order_items cascade)', ids: createdIds }, null, 2), 'utf8');
console.log(`\n✓ created ${made.toLocaleString('en-US')} orders, failed ${failed}`);
console.log(`rollback → ${RB}`);
