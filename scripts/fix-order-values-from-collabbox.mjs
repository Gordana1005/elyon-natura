#!/usr/bin/env node
/**
 * Correct order value and package count from the collabBox dispatch register.
 *
 *   node scripts/fix-order-values-from-collabbox.mjs            # dry run
 *   node scripts/fix-order-values-from-collabbox.mjs --commit    # apply
 *
 * ── What is wrong ──
 * The CRM stores the price the LEAD arrived with. When the call centre upsold
 * on the phone, the extra never went back to AlterCPA, so the order kept the
 * lead's figure while a bigger parcel went out the door. Measured against the
 * register, that is 10.2M ден (~166.000 EUR) of dispatched goods the CRM does
 * not record, concentrated exactly where documents are multi-product:
 *
 *     2025-07   74% multi-product   81% price mismatch
 *     2025-12    2% multi-product   23% mismatch
 *     2026-07   19% multi-product    1% mismatch   ← AlterCPA resize sync working
 *
 * It is not only a reporting error. `order_items.quantity × days_of_supply`
 * drives when the prediction engine calls a customer back, so a bundle recorded
 * as one unit is called back far too early.
 *
 * ── Why the link can be trusted ──
 *   TIER A  the order's mex_tracking_id IS the document number. Exact.
 *   TIER B  phone + date, accepted only when exactly one order is in the window
 *           AND no rival document is near it.
 *
 * Tier B was measured against Tier A rather than assumed: run the Tier B rule on
 * the 11.147 pairs whose answer Tier A already knows and it accepts 9.641 of
 * them, picking the right order 99,4% of the time. Its errors also announce
 * themselves — where it picked wrong the money disagrees 45,8% of the time,
 * against 1,1% where it picked right.
 *
 * ── Deliberately NOT done here ──
 * `order_items` is left alone. Rebuilding it needs a collabBox SKU → product map
 * that does not exist yet: the CRM's 88 products use `SKU-000002` with Latin
 * names, the register uses `000042` with Macedonian ones, and only 1% of line
 * items match by SKU, barcode or exact name. Until that map exists, `quantity`
 * is corrected ONLY for single-product documents, where "units" unambiguously
 * means packages of that one product. A bundle's package count belongs in
 * order_items, not in a single scalar.
 *
 * Orders owned by an agent are skipped — same rule as the AlterCPA resize sync.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import * as XLSX from 'xlsx';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REF = 'bmfxhgznttcnnlqloqzp';        // MACEDONIA. never change.
const MKD_PER_EUR = 61.5;                  // FROZEN — see src/lib/currency.ts
const TOL = 3;                             // ден — below this, treat as equal
const COMMIT = process.argv.includes('--commit');

const env = { ...process.env };
for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*?)"?\s*$/);
  if (m && !env[m[1]]) env[m[1]] = m[2];
}
const SUPABASE_URL = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
if (!SUPABASE_URL?.includes(REF) || !env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error(`Refusing to run: SUPABASE_URL must be the Macedonian project (${REF}).`);
  process.exit(1);
}
const sb = createClient(SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const H = (t) => console.log(`\n${'═'.repeat(74)}\n${t}\n${'═'.repeat(74)}`);
const mkd = (n) => `${Math.round(n).toLocaleString('en-US')} ден`;

/* ── collabBox ── */
const SERVICE_SKU = new Set(['8001', '8002']);
const C = { sku: 2, item: 3, party: 7, date: 8, doc: 10, qty: 20, val: 24 };
const parseParty = (s) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  const m = t.match(/^(.*?)\s*Адреса:\s*(.*?)\s*Телефон:\s*(.*)$/);
  if (m) return { name: m[1].trim(), phone: m[3].trim() };
  const m2 = t.match(/^(.*?)\s*Телефон:\s*(.*)$/);
  return m2 ? { name: m2[1].trim(), phone: m2[2].trim() } : { name: t, phone: '' };
};
const num = (s) => Number(String(s ?? '').replace(/,/g, '').trim()) || 0;
const last8 = (v) => { const d = String(v || '').replace(/\D/g, ''); return d.length >= 8 ? d.slice(-8) : null; };

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
      d = { doc, register, date: `${dm[3]}-${dm[2]}-${dm[1]}`, ...p, tel8: last8(p.phone),
            goodsMkd: 0, units: 0, skus: new Set(), products: [] };
      docs.set(doc, d);
    }
    const sku = String(r[C.sku] ?? '').trim();
    if (!SERVICE_SKU.has(sku)) {
      d.goodsMkd += num(r[C.val]); d.units += num(r[C.qty]); d.skus.add(sku);
      d.products.push(`${sku} ${String(r[C.item] ?? '').trim().replace(/\s+/g, ' ')} ×${num(r[C.qty])}`);
    }
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
  .select('id, display_id, customer_phone, price, quantity, status, created_at, mex_tracking_id, assigned_agent_id')
  .order('created_at'));
console.log(`orders: ${orders.length.toLocaleString('en-US')}`);

const byTrack = new Map();
const byPhone = new Map();
for (const o of orders) {
  if (o.mex_tracking_id) byTrack.set(o.mex_tracking_id, o);
  const k = last8(o.customer_phone);
  if (k) { if (!byPhone.has(k)) byPhone.set(k, []); byPhone.get(k).push(o); }
}
const docsByPhone = new Map();
for (const d of docs.values()) if (d.tel8) { if (!docsByPhone.has(d.tel8)) docsByPhone.set(d.tel8, []); docsByPhone.get(d.tel8).push(d); }

/* ── link ── */
const DAY = 86400_000;
const byDate = [...docs.values()].sort((a, b) => a.date.localeCompare(b.date) || a.doc.localeCompare(b.doc));
const pairs = [];
const used = new Set();
for (const d of byDate) {
  const o = byTrack.get(d.doc);
  if (o) { pairs.push({ d, o, tier: 'A' }); used.add(o.id); }
}
for (const d of byDate) {
  if (byTrack.get(d.doc) || !d.tel8) continue;
  const dd = Date.parse(`${d.date}T12:00:00Z`);
  const cands = (byPhone.get(d.tel8) || []).filter((x) => !used.has(x.id) && !x.mex_tracking_id
    && (dd - Date.parse(x.created_at)) >= -2 * DAY && (dd - Date.parse(x.created_at)) <= 10 * DAY);
  const rivals = (docsByPhone.get(d.tel8) || []).filter((x) => x !== d && Math.abs(Date.parse(x.date) - dd) <= 12 * DAY);
  if (cands.length === 1 && rivals.length === 0) { pairs.push({ d, o: cands[0], tier: 'B' }); used.add(cands[0].id); }
}
H('LINKED');
for (const t of ['A', 'B']) console.log(`  tier ${t}: ${pairs.filter((p) => p.tier === t).length.toLocaleString('en-US')}`);

/* ── decide the changes ── */
const changes = [];
const skip = { agent: 0, unpriced: 0, equal: 0 };
for (const { d, o, tier } of pairs) {
  if (o.assigned_agent_id) { skip.agent++; continue; }
  if (!(d.goodsMkd > 0)) { skip.unpriced++; continue; }
  const curMkd = Math.round(Number(o.price) * MKD_PER_EUR);
  const priceOff = Math.abs(d.goodsMkd - curMkd) > TOL;
  // Only a single-product document can speak for a scalar package count.
  const single = d.skus.size === 1;
  const qtyOff = single && d.units > 0 && o.quantity != null && Number(o.quantity) !== d.units;
  if (!priceOff && !qtyOff) { skip.equal++; continue; }
  const patch = {};
  if (priceOff) patch.price = Math.round((d.goodsMkd / MKD_PER_EUR) * 100) / 100;
  if (qtyOff) patch.quantity = d.units;
  changes.push({ d, o, tier, patch, priceOff, qtyOff, deltaMkd: d.goodsMkd - curMkd });
}

H('CHANGES');
const pr = changes.filter((c) => c.priceOff);
const up = pr.filter((c) => c.deltaMkd > 0), dn = pr.filter((c) => c.deltaMkd < 0);
console.log(`  price corrections    ${String(pr.length).padStart(6)}`);
console.log(`    ↑ under-recorded   ${String(up.length).padStart(6)}   +${mkd(up.reduce((s, c) => s + c.deltaMkd, 0))}  (€${Math.round(up.reduce((s, c) => s + c.deltaMkd, 0) / MKD_PER_EUR).toLocaleString('en-US')})`);
console.log(`    ↓ over-recorded    ${String(dn.length).padStart(6)}   ${mkd(dn.reduce((s, c) => s + c.deltaMkd, 0))}`);
console.log(`  quantity corrections ${String(changes.filter((c) => c.qtyOff).length).padStart(6)}   (single-product documents only)`);
console.log(`  orders affected      ${String(changes.length).padStart(6)}`);
console.log(`\n  skipped: agent-owned ${skip.agent} · unpriced document ${skip.unpriced} · already correct ${skip.equal.toLocaleString('en-US')}`);
const byTier = {};
for (const c of changes) byTier[c.tier] = (byTier[c.tier] || 0) + 1;
console.log(`  by tier: ${Object.entries(byTier).map(([k, v]) => `${k} ${v.toLocaleString('en-US')}`).join(' · ')}`);
const st = {};
for (const c of changes) st[c.o.status] = (st[c.o.status] || 0) + 1;
console.log(`  by status: ${Object.entries(st).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v.toLocaleString('en-US')}`).join(' · ')}`);
const paidDelta = changes.filter((c) => c.o.status === 'paid').reduce((s, c) => s + c.deltaMkd, 0);
console.log(`\n  net change to PAID revenue: ${paidDelta > 0 ? '+' : ''}${mkd(paidDelta)}  (€${Math.round(paidDelta / MKD_PER_EUR).toLocaleString('en-US')})`);

console.log('\n  sample:');
for (const c of changes.slice(0, 5)) {
  console.log(`    ${c.o.display_id ?? c.o.id.slice(0, 8)} ${c.d.date} tier ${c.tier}  €${c.o.price}→€${c.patch.price ?? c.o.price}  qty ${c.o.quantity}→${c.patch.quantity ?? c.o.quantity}  │ ${c.d.products.join(' + ').slice(0, 70)}`);
}

if (!COMMIT) {
  console.log(`\nDRY RUN — nothing written. Re-run with --commit.`);
  process.exit(0);
}

/* ── apply ── */
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const ROLLBACK = join(ROOT, 'scripts', 'data', `collabbox-value-rollback-${stamp}.json`);
writeFileSync(ROLLBACK, JSON.stringify({
  generated: new Date().toISOString(),
  note: 'Restore with: UPDATE orders SET price=<price>, quantity=<quantity> WHERE id=<id>',
  orders: changes.map((c) => ({ id: c.o.id, display_id: c.o.display_id, doc: c.d.doc, tier: c.tier,
    price: Number(c.o.price), quantity: c.o.quantity, new_price: c.patch.price ?? null, new_quantity: c.patch.quantity ?? null })),
}, null, 2), 'utf8');
console.log(`\nrollback → ${ROLLBACK}`);

let ok = 0, fail = 0;
for (const c of changes) {
  const { error } = await sb.from('orders').update(c.patch).eq('id', c.o.id);
  if (error) { fail++; if (fail <= 5) console.error(`  ${c.o.id}: ${error.message}`); continue; }
  ok++;
  const bits = [];
  if (c.priceOff) bits.push(`total ${mkd(Math.round(Number(c.o.price) * MKD_PER_EUR))} → ${mkd(c.d.goodsMkd)}`);
  if (c.qtyOff) bits.push(`packages ${c.o.quantity} → ${c.patch.quantity}`);
  await sb.from('order_notes').insert({
    order_id: c.o.id,
    text: `Corrected from collabBox document ${c.d.doc} (${c.d.date}): ${bits.join(', ')}. Dispatched: ${c.d.products.join(' + ')}.`,
    author_id: null, author_name: 'System (collabBox)',
  });
  if (ok % 500 === 0) console.log(`  ${ok}/${changes.length}`);
}
console.log(`\n✓ updated ${ok.toLocaleString('en-US')}, failed ${fail}`);
