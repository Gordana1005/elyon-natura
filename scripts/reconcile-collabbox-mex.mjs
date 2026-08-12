#!/usr/bin/env node
/**
 * Three-way settlement: collabBox document → MEX shipment → CRM order.
 *
 *   node scripts/reconcile-collabbox-mex.mjs [--csv <out.csv>]
 *
 * ── The key ──
 * A MEX `tracking_id` IS a collabBox document number (`002-9110-158456/2026`).
 * The call centre raises a Нарачка in collabBox and that number goes on the
 * parcel, so the two systems join EXACTLY — no phone, date or amount guessing.
 * That also settles what a collabBox document means: it becomes a shipment.
 * It is a dispatch note, and the money is decided later, at the door.
 *
 * ── Who is allowed to say what ──
 *   collabBox  what was dispatched: customer, products, units, value.
 *              NEVER whether it was paid.
 *   MEX        what physically happened: delivered (COD collected at the door)
 *              or returned to sender (never collected). This is money truth.
 *   CRM        what we currently believe. Audited, never trusted.
 *
 * ── Coverage, stated up front ──
 * MEX only carried for this account from 2026-04-02. Everything the collabBox
 * register holds before that — roughly two thirds of it — has NO courier record
 * at all and cannot be settled by this script. Do not read a clean result here
 * as a clean result overall.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import * as XLSX from 'xlsx';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REF = 'bmfxhgznttcnnlqloqzp';        // MACEDONIA. never change.
const MKD_PER_EUR = 61.5;                  // FROZEN — see src/lib/currency.ts
const args = process.argv.slice(2);
const csvIdx = args.indexOf('--csv');
const OUT_CSV = csvIdx >= 0 ? args[csvIdx + 1] : null;

const DELIVERED = 2, RETURNED = 7;

/* ── env ── */
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
const eur = (n) => `€${Math.round(n / MKD_PER_EUR).toLocaleString('en-US')}`;

/* ── 1. MEX ── */
const ships = JSON.parse(readFileSync(join(ROOT, 'scripts', 'data', 'mex-shipments.json'), 'utf8'));
const byTrack = new Map(ships.map((s) => [s.tracking_id, s]));
console.log(`MEX shipments   ${ships.length.toLocaleString('en-US')}`);

/* ── 2. collabBox ── */
const SERVICE_SKU = new Set(['8001', '8002']);
const C = { sku: 2, item: 3, party: 7, date: 8, doc: 10, author: 11, qty: 20, val: 24 };
const parseParty = (s) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  const m = t.match(/^(.*?)\s*Адреса:\s*(.*?)\s*Телефон:\s*(.*)$/);
  if (m) return { name: m[1].trim(), addr: m[2].trim(), phone: m[3].trim() };
  const m2 = t.match(/^(.*?)\s*Телефон:\s*(.*)$/);
  return m2 ? { name: m2[1].trim(), addr: '', phone: m2[2].trim() } : { name: t, addr: '', phone: '' };
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
            author: String(r[C.author] ?? '').trim(), goodsMkd: 0, totalMkd: 0, units: 0, products: [] };
      docs.set(doc, d);
    }
    d.totalMkd += num(r[C.val]);
    if (!SERVICE_SKU.has(String(r[C.sku]).trim())) {
      d.goodsMkd += num(r[C.val]); d.units += num(r[C.qty]);
      d.products.push(`${String(r[C.sku]).trim()} ${String(r[C.item]).trim().replace(/\s+/g, ' ')}`);
    }
  }
}
console.log(`collabBox docs  ${docs.size.toLocaleString('en-US')}`);

/* ── 3. the key join ── */
let hit = 0;
for (const s of ships) if (docs.has(s.tracking_id)) hit++;
H('DOES A MEX TRACKING ID EQUAL A collabBox DOCUMENT NUMBER?');
console.log(`  MEX shipments whose tracking id is a collabBox document: ${hit.toLocaleString('en-US')} / ${ships.length.toLocaleString('en-US')}  (${((100 * hit) / ships.length).toFixed(1)}%)`);
const mexDates = ships.map((s) => s.created_at).filter(Boolean).sort();
const inEra = [...docs.values()].filter((d) => d.date >= mexDates[0].slice(0, 10) && d.date <= mexDates[mexDates.length - 1].slice(0, 10));
console.log(`  collabBox documents inside the MEX era (${mexDates[0].slice(0, 10)} … ${mexDates[mexDates.length - 1].slice(0, 10)}): ${inEra.length.toLocaleString('en-US')}`);
console.log(`  of those, found at MEX: ${inEra.filter((d) => byTrack.has(d.doc)).length.toLocaleString('en-US')}`);
console.log(`\n  → a Нарачка becomes a parcel. The register is a dispatch log, and MEX`);
console.log(`    says what happened to each parcel afterwards.`);

/* ── 4. orders ── */
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
console.log('\nloading orders…');
const orders = await loadAll(() => sb.from('orders')
  .select('id, display_id, customer_phone, customer_name, price, quantity, status, created_at, paid_at, ' +
          'cancellation_reason, trash_reason, mex_tracking_id, assigned_agent_id')
  .gte('created_at', '2026-03-01').order('created_at'));
console.log(`orders since 2026-03-01: ${orders.length.toLocaleString('en-US')}`);
const byMex = new Map();
const byPhone = new Map();
for (const o of orders) {
  if (o.mex_tracking_id) byMex.set(o.mex_tracking_id, o);
  const k = last8(o.customer_phone);
  if (k) { if (!byPhone.has(k)) byPhone.set(k, []); byPhone.get(k).push(o); }
}
console.log(`  already linked by mex_tracking_id: ${byMex.size.toLocaleString('en-US')}`);

/* ── 5. settle ── */
// Link priority: the stored link, then the collabBox document's phone with the
// COD corroborating. collabBox is what makes the second path safe — it supplies
// the phone MEX shows only in truncated form, keyed by the exact document.
const DAY = 86400_000;
const rows = [];
const stat = { linked_stored: 0, linked_collabbox: 0, unlinked: 0 };
for (const s of ships) {
  const d = docs.get(s.tracking_id) || null;
  let o = byMex.get(s.tracking_id) || null;
  let how = o ? 'mex_tracking_id' : null;
  if (!o && d?.tel8) {
    const created = s.created_at ? Date.parse(s.created_at.replace(' ', 'T') + '+02:00') : null;
    const cands = (byPhone.get(d.tel8) || []).filter((x) => !x.mex_tracking_id
      && (created === null || (created - Date.parse(x.created_at) >= -3 * DAY && created - Date.parse(x.created_at) <= 75 * DAY)));
    if (cands.length === 1) { o = cands[0]; how = 'collabbox doc → phone'; }
    else if (cands.length > 1) {
      const cod = Math.round(Number(String(s.cod).replace(/[^\d.]/g, '')) || 0);
      const exact = cands.filter((x) => Math.abs(cod - Math.round(Number(x.price) * MKD_PER_EUR)) <= 3
        || Math.abs(cod - Math.round(Number(x.price) * MKD_PER_EUR) - 150) <= 3);
      if (exact.length === 1) { o = exact[0]; how = 'collabbox doc → phone + COD'; }
    }
  }
  if (how === 'mex_tracking_id') stat.linked_stored++;
  else if (how) stat.linked_collabbox++;
  else stat.unlinked++;

  const truth = s.current_status_id === DELIVERED ? 'paid'
    : s.current_status_id === RETURNED ? 'returned' : null;
  rows.push({ s, d, o, how, truth });
}

H('SETTLEMENT — WHAT MEX SAYS vs WHAT THE CRM SAYS');
console.log(`  linked by stored mex_tracking_id   ${String(stat.linked_stored).padStart(6)}`);
console.log(`  newly linked via collabBox doc     ${String(stat.linked_collabbox).padStart(6)}  ← these files closed this gap`);
console.log(`  still unlinked                     ${String(stat.unlinked).padStart(6)}`);

const settled = rows.filter((r) => r.o && r.truth);
const agree = settled.filter((r) => r.o.status === r.truth);
const disagree = settled.filter((r) => r.o.status !== r.truth);
console.log(`\n  shipments with a terminal MEX status AND a linked order: ${settled.length.toLocaleString('en-US')}`);
console.log(`     CRM already correct   ${String(agree.length).padStart(6)}   ${((100 * agree.length) / settled.length).toFixed(1)}%`);
console.log(`     CRM wrong             ${String(disagree.length).padStart(6)}   ${((100 * disagree.length) / settled.length).toFixed(1)}%`);

const grid = {};
for (const r of settled) {
  const k = `${r.truth.padEnd(9)} ← MEX │ CRM says ${r.o.status}`;
  grid[k] = (grid[k] || 0) + 1;
}
console.log('\n  full grid:');
for (const [k, n] of Object.entries(grid).sort((a, b) => b[1] - a[1])) {
  const ok = k.includes(`CRM says ${k.slice(0, 9).trim()}`);
  console.log(`     ${ok ? '✓' : '✗'} ${k.padEnd(46)} ${String(n).padStart(6)}`);
}

const toPaid = disagree.filter((r) => r.truth === 'paid');
const toRet = disagree.filter((r) => r.truth === 'returned');
const valOf = (a) => a.reduce((s, r) => s + (Number(r.o.price) || 0) * MKD_PER_EUR, 0);
console.log(`\n  → ${toPaid.length.toLocaleString('en-US')} orders MEX DELIVERED that the CRM does not call paid  (${mkd(valOf(toPaid))} / ${eur(valOf(toPaid))})`);
const wp = {};
for (const r of toPaid) { const k = `${r.o.status} · ${r.o.cancellation_reason || r.o.trash_reason || '—'}`; wp[k] = (wp[k] || 0) + 1; }
for (const [k, n] of Object.entries(wp).sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`       ${String(n).padStart(5)}  ${k}`);
console.log(`\n  → ${toRet.length.toLocaleString('en-US')} orders MEX RETURNED that the CRM does not call returned  (${mkd(valOf(toRet))} / ${eur(valOf(toRet))})`);
const wr = {};
for (const r of toRet) { const k = `${r.o.status} · ${r.o.cancellation_reason || r.o.trash_reason || '—'}`; wr[k] = (wr[k] || 0) + 1; }
for (const [k, n] of Object.entries(wr).sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`       ${String(n).padStart(5)}  ${k}`);
const paidButReturned = toRet.filter((r) => r.o.status === 'paid');
if (paidButReturned.length) {
  console.log(`\n  ⚠ ${paidButReturned.length.toLocaleString('en-US')} of those are booked as PAID revenue on parcels that came back (${mkd(valOf(paidButReturned))} / ${eur(valOf(paidButReturned))}).`);
}

H('WHAT THIS CANNOT REACH');
const preMex = [...docs.values()].filter((d) => d.date < mexDates[0].slice(0, 10));
console.log(`  ${preMex.length.toLocaleString('en-US')} collabBox documents predate MEX (${mexDates[0].slice(0, 10)}) — ${mkd(preMex.reduce((s, d) => s + d.totalMkd, 0))}.`);
console.log(`  No courier record exists for them, so their status cannot be settled by`);
console.log(`  any evidence we currently hold. A different carrier delivered that era;`);
console.log(`  settling it needs that carrier's register.`);

/* ── 6. close the linking gap ────────────────────────────────────────────── */
// mex-reconcile links a shipment to an order by phone + COD ≈ order price. That
// test fails exactly where the CRM price is wrong — and the CRM price is wrong
// wherever the call centre upsold on the phone without it reaching AlterCPA. So
// the orders whose value is understated are the same ones the courier can never
// settle: one defect causes the other.
//
// collabBox breaks the deadlock, because the document number IS the tracking id.
// The parcel names its own order. We only have to check that the COD agrees with
// what collabBox says was IN the parcel — not with the price we recorded.
const DELIV_MAX = 155;
const codOf = (s) => Math.round(Number(String(s.cod ?? '').replace(/[^\d.]/g, '')) || 0);
const link = { ready: [], ambiguous: 0, absent: 0, no_doc: 0, no_cod_support: 0, already: 0 };
for (const r of rows) {
  if (r.o && r.how === 'mex_tracking_id') { link.already++; continue; }
  const d = r.d;
  if (!d?.tel8) { link.no_doc++; continue; }
  const cod = codOf(r.s);
  const dg = Math.abs(cod - d.goodsMkd);
  // The document must describe THIS parcel: the courier collected what
  // collabBox says was inside it, give or take the delivery fee.
  if (!(cod > 0 && d.goodsMkd > 0 && (dg <= 3 || dg <= DELIV_MAX))) { link.no_cod_support++; continue; }
  const created = r.s.created_at ? Date.parse(r.s.created_at.replace(' ', 'T') + '+02:00') : null;
  const cands = (byPhone.get(d.tel8) || []).filter((x) => !x.mex_tracking_id
    && (created === null || (created - Date.parse(x.created_at) >= -3 * DAY && created - Date.parse(x.created_at) <= 75 * DAY)));
  if (cands.length === 1) link.ready.push({ order: cands[0], track: r.s.tracking_id, doc: d });
  else if (cands.length > 1) {
    const exact = cands.filter((x) => Math.abs(cod - Math.round(Number(x.price) * MKD_PER_EUR)) <= 3
      || Math.abs(cod - Math.round(Number(x.price) * MKD_PER_EUR) - 150) <= 3);
    if (exact.length === 1) link.ready.push({ order: exact[0], track: r.s.tracking_id, doc: d });
    else link.ambiguous++;
  } else link.absent++;    // the parcel went out, but no order for that phone exists
}
H('CLOSING THE LINKING GAP (what these files uniquely provide)');
console.log(`  already linked                       ${String(link.already).padStart(6)}`);
console.log(`  linkable via the collabBox document  ${String(link.ready.length).padStart(6)}  ← new`);
console.log(`  document found but COD disagrees     ${String(link.no_cod_support).padStart(6)}`);
console.log(`  no usable collabBox document         ${String(link.no_doc).padStart(6)}`);
console.log(`  several candidates, none decisive    ${String(link.ambiguous).padStart(6)}`);
console.log(`  NO order exists for that phone       ${String(link.absent).padStart(6)}  ← parcel shipped, order missing`);

if (args.includes('--link')) {
  if (!args.includes('--commit')) {
    console.log(`\n  DRY RUN — pass --commit to write mex_tracking_id on ${link.ready.length} orders.`);
  } else {
    console.log(`\n  writing mex_tracking_id on ${link.ready.length} orders…`);
    let ok = 0, fail = 0;
    for (const l of link.ready) {
      const { error } = await sb.from('orders')
        .update({ mex_tracking_id: l.track }).eq('id', l.order.id).is('mex_tracking_id', null);
      if (error) { fail++; console.error(`  ${l.order.id}: ${error.message}`); } else ok++;
      if (ok % 200 === 0 && ok) console.log(`    ${ok}/${link.ready.length}`);
    }
    console.log(`  ✓ linked ${ok}, failed ${fail}`);
    console.log(`\n  Now run the production reconciler so IT decides the statuses:`);
    console.log(`    curl -X POST .../functions/v1/mex-reconcile -d '{"kind":"backfill","from":"2026-04-01"}'`);
  }
}

if (OUT_CSV) {
  const out = ['sep=;', ['tracking_id', 'mex_status', 'mex_status_name', 'mex_truth', 'mex_created', 'mex_cod',
    'link_method', 'register', 'doc_date', 'cb_name', 'cb_phone', 'cb_address', 'cb_goods_mkd', 'cb_units', 'cb_products',
    'order_id', 'order_display_id', 'crm_status', 'crm_reason', 'crm_price_eur', 'crm_price_mkd', 'crm_qty',
    'crm_created', 'crm_paid_at', 'action'].join(';')];
  for (const r of rows) {
    const action = !r.o ? 'no order linked' : !r.truth ? 'in flight' : r.o.status === r.truth ? 'ok' : `set ${r.truth}`;
    out.push([r.s.tracking_id, r.s.current_status_id, r.s.current_status_name, r.truth ?? '', r.s.created_at ?? '', r.s.cod ?? '',
      r.how ?? '', r.d?.register ?? '', r.d?.date ?? '', r.d?.name ?? '', r.d?.phone ?? '', r.d?.addr ?? '',
      r.d?.goodsMkd ?? '', r.d?.units ?? '', r.d?.products.join(' + ') ?? '',
      r.o?.id ?? '', r.o?.display_id ?? '', r.o?.status ?? '', r.o?.cancellation_reason || r.o?.trash_reason || '',
      r.o?.price ?? '', r.o ? Math.round(Number(r.o.price) * MKD_PER_EUR) : '', r.o?.quantity ?? '',
      r.o?.created_at ?? '', r.o?.paid_at ?? '', action,
    ].map((v) => String(v ?? '').replace(/[;\r\n]/g, ' ')).join(';'));
  }
  writeFileSync(OUT_CSV, '\uFEFF' + out.join('\n'), 'utf8');
  console.log(`\nrow-by-row → ${OUT_CSV}`);
}
