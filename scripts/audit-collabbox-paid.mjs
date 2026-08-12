#!/usr/bin/env node
/**
 * collabBox paid-order audit — the 2026-08-11 re-export, WITH phone + product.
 *
 *   node scripts/audit-collabbox-paid.mjs [--csv <out.csv>] [--back N]
 *
 * ── Why this exists ──
 * The first collabBox exports (scripts/match-collabbox.mjs) carried only a
 * document number, a name, a date and an amount. Phone is the CRM's only
 * customer identity, so 86,6% of the 45.227 paid documents could not be
 * matched at all, and the join that did run was name+date — weak by
 * construction. That report ends with: "fixing that needs a collabBox
 * re-export with those two columns."
 *
 * This is that re-export. `Комитент` now reads
 *   "NAME Адреса: <address> Телефон: <phone>"
 * and every line item names its product and SKU, so the join is now
 * phone-last-8 + date — the same identity the CRM itself uses.
 *
 * ── The structural fact that shapes this whole report ──
 * Every one of the CRM's 81.343 orders is `external_source = 'altercpa'`.
 * AlterCPA is the affiliate lead network, so the CRM holds INBOUND leads and
 * nothing else. collabBox keeps two registers:
 *
 *   Нарачка LEADS    (Pendinzi)   inbound affiliate leads   → has a CRM twin
 *   LEADS-OUT Нарачка (Predikcii) outbound repeat sales     → NO CRM twin
 *
 * Predikcii is the call centre ringing the existing customer base off the
 * prediction lists. Those orders were raised in collabBox and never existed in
 * AlterCPA, so they were never imported. They cannot be "matched" — they are
 * missing. Matching them anyway pairs each document with that customer's older
 * inbound order, which is why a naive run reports a 30-45 day lag and an
 * amount that scatters across 187 distinct values instead of clustering on the
 * collabBox surcharge signature. This script keeps the two registers apart and
 * refuses to launder that gap into a match.
 *
 * ── A collabBox document is NOT proof of payment ──
 * scripts/match-collabbox.mjs asserts "every row in these two exports is a PAID
 * order … where collabBox says paid and AlterCPA says cancelled, collabBox
 * wins", and wrote 2.621 orders straight to `paid` on that basis. The full
 * register refutes it. Comparing the status mix of matched orders against the
 * population mix over the same period:
 *
 *     shipped ×1,96   returned ×1,83   paid ×1,58
 *     cancelled ×0,76   trashed ×0,25   confirmed ×0,10   pending ×0,09
 *
 * `returned` and `shipped` are enriched MORE than `paid`. A return is money
 * that was never collected, so if a document proved payment, returns would be
 * depleted — instead they are the second most over-represented status. What
 * every enriched status has in common is that the parcel physically left the
 * warehouse, and what every depleted status has in common is that it never
 * did. The counts agree too: 42.395 documents against 30.648 paid orders in
 * the same window, but ~43.700 that reached dispatch.
 *
 * "Нарачка" means order. The document is raised when the call centre RAISES
 * and dispatches an order — a dispatch note, not an invoice. It proves the
 * parcel went out; the money is decided later, at the door.
 *
 * That is corroborated independently: 97 of the 2.621 flipped orders were
 * afterwards proven RETURNED by MEX's own terminal status. Courier ground
 * truth could only reach the 1.158 flips in the MEX era, and 8,4% of those
 * were already wrong — a floor, not the rate, because a flip on an order that
 * was never dispatched leaves no courier trace at all.
 *
 * So this script reports the DISPATCH OUTCOME, and never flips anything.
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
const backIdx = args.indexOf('--back');
const BACK = backIdx >= 0 ? Number(args[backIdx + 1]) : 10;
const FWD = 2;

// Both registers now arrive complete. The Pendinzi export is split into three
// period files that tile without a gap (2025-06-12 → 2026-08-12); the register
// genuinely starts on 2025-06-12 even though the first file is named from
// 01.04.2025. Documents are keyed by document number, so an overlap between
// exports would dedupe rather than double-count.
const FILES = [
  { path: 'D:/Predikcii Final.xls', kind: 'xls', register: 'Predikcii',
    note: 'LEADS-OUT — full outbound register' },
  { path: join(ROOT, '01.04.2025 - 31.12.2025.xls'), kind: 'xls', register: 'Pendinzi',
    note: 'Нарачка LEADS — 2025-06-12 … 2025-12-31' },
  { path: join(ROOT, '01.01.2026 - 31.03.2026 Pendinzi.xls'), kind: 'xls', register: 'Pendinzi',
    note: 'Нарачка LEADS — 2026 Q1' },
  { path: join(ROOT, '01.04.2026 - 11.08.2026 Pendinzi.xls'), kind: 'xls', register: 'Pendinzi',
    note: 'Нарачка LEADS — 2026 Q2 to date' },
];

// Service lines, not products: delivery (100 or 150 ден) and the free-text
// operator note. Excluding them is what makes the amount comparison clean.
const SERVICE_SKU = new Set(['8001', '8002']);

/* ── env ─────────────────────────────────────────────────────────────────── */
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

/* ── readers ─────────────────────────────────────────────────────────────── */
// collabBox CSV: semicolon-separated, every field quoted, trailing separator.
function parseCsv(txt) {
  return txt.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim()).map((l) => {
    const out = []; let cur = '', q = false;
    for (let i = 0; i < l.length; i++) {
      const c = l[i];
      if (q) { if (c === '"') { if (l[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else if (c === '"') q = true;
      else if (c === ';') { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out;
  });
}

// Same logical columns, different offsets: the xls is the wide
// "Документи-ставки" sheet, the csv a narrowed report view.
const COLS = {
  xls: { sku: 2, item: 3, code: 6, party: 7, date: 8, doc: 10, author: 11, qty: 20, val: 24 },
  csv: { sku: 1, item: 2, code: 3, party: 4, date: 5, doc: 7, author: 8, qty: 11, val: 12 },
};

function parseParty(s) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  const m = t.match(/^(.*?)\s*Адреса:\s*(.*?)\s*Телефон:\s*(.*)$/);
  if (m) return { name: m[1].trim(), addr: m[2].trim(), phone: m[3].trim() };
  const m2 = t.match(/^(.*?)\s*Телефон:\s*(.*)$/);
  if (m2) return { name: m2[1].trim(), addr: '', phone: m2[2].trim() };
  return { name: t, addr: '', phone: '' };
}
const num = (s) => Number(String(s ?? '').replace(/,/g, '').trim()) || 0;
const last8 = (v) => {
  const d = String(v || '').replace(/\D/g, '');
  return d.length >= 8 ? d.slice(-8) : null;
};

function readRegister({ path, kind, register }) {
  const C = COLS[kind];
  let rows;
  if (kind === 'xls') {
    const wb = XLSX.read(readFileSync(path), { type: 'buffer' });
    rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: false });
  } else {
    rows = parseCsv(readFileSync(path, 'utf8'));
  }
  const out = [];
  for (const r of rows.slice(2)) {
    const doc = String(r[C.doc] ?? '').trim();
    const dm = String(r[C.date] ?? '').match(/^(\d{2})\.(\d{2})\.(\d{4})/);
    if (!doc || !dm) continue;
    out.push({
      register, path,
      sku: String(r[C.sku] ?? '').trim(),
      item: String(r[C.item] ?? '').trim().replace(/\s+/g, ' '),
      ...parseParty(r[C.party]),
      date: `${dm[3]}-${dm[2]}-${dm[1]}`,
      doc,
      author: String(r[C.author] ?? '').trim(),
      qty: num(r[C.qty]),
      val: num(r[C.val]),
    });
  }
  return out;
}

/* ── build documents ─────────────────────────────────────────────────────── */
// A document is one order: several line items sharing a document number. The
// preview csv re-states lines the xls already has, so a document is built from
// the FIRST file that supplied it and later files only add unseen documents.
const items = FILES.flatMap(readRegister);
const docs = new Map();
for (const it of items) {
  let d = docs.get(it.doc);
  if (!d) {
    d = { doc: it.doc, register: it.register, source: it.path, date: it.date, name: it.name,
          addr: it.addr, phone: it.phone, tel8: last8(it.phone), author: it.author,
          lines: [], totalMkd: 0, goodsMkd: 0, units: 0, products: [], deliveryMkd: 0 };
    docs.set(it.doc, d);
  }
  if (it.path !== d.source) continue;      // duplicate of a document already built
  d.lines.push(it);
  d.totalMkd += it.val;
  if (it.sku === '8001') d.deliveryMkd += it.val;
  if (!SERVICE_SKU.has(it.sku)) { d.goodsMkd += it.val; d.units += it.qty; d.products.push(`${it.sku} ${it.item}`); }
}
const docList = [...docs.values()].sort((a, b) => a.date.localeCompare(b.date) || a.doc.localeCompare(b.doc));

const H = (t) => console.log(`\n${'═'.repeat(74)}\n${t}\n${'═'.repeat(74)}`);
const mkd = (n) => `${Math.round(n).toLocaleString('en-US')} ден`;
const eur = (n) => `€${Math.round(n / MKD_PER_EUR).toLocaleString('en-US')}`;

H('WHAT IS IN THE FILES');
for (const f of FILES) {
  const own = docList.filter((d) => d.source === f.path);
  const ds = own.map((d) => d.date).sort();
  console.log(`  ${f.path.split(/[\\/]/).pop()}`);
  console.log(`      ${String(own.length).padStart(6)} new documents   ${ds[0] ?? '—'} … ${ds[ds.length - 1] ?? '—'}   ${f.note}`);
}
// A gap between the period exports would silently look like "orders missing
// from collabBox", so prove the coverage is contiguous before reading anything
// into the reachability numbers.
for (const reg of ['Pendinzi', 'Predikcii']) {
  const days = [...new Set(docList.filter((d) => d.register === reg).map((d) => d.date))].sort();
  if (days.length < 2) continue;
  const gaps = [];
  for (let i = 1; i < days.length; i++) {
    const n = (Date.parse(days[i]) - Date.parse(days[i - 1])) / 86400_000;
    if (n > 4) gaps.push(`${days[i - 1]}→${days[i]} (${n}d)`);
  }
  console.log(`  ${reg} coverage: ${days.length} distinct days, ${gaps.length ? `gaps >4d: ${gaps.join(', ')}` : 'no gap over 4 days'}`);
}
const byReg = {};
for (const d of docList) (byReg[d.register] ??= []).push(d);
console.log(`\n  unique documents ${docList.length.toLocaleString('en-US')}   ${Object.entries(byReg).map(([k, v]) => `${k} ${v.length.toLocaleString('en-US')}`).join(' · ')}`);
console.log(`  with usable phone ${docList.filter((d) => d.tel8).length.toLocaleString('en-US')}  (${docList.filter((d) => !d.tel8).length} without)`);
console.log(`  date range        ${docList[0].date} … ${docList[docList.length - 1].date}`);
console.log(`  total value       ${mkd(docList.reduce((s, d) => s + d.totalMkd, 0))}  (${eur(docList.reduce((s, d) => s + d.totalMkd, 0))})`);

/* ── load orders ─────────────────────────────────────────────────────────── */
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
          'cancellation_reason, trash_reason, external_source, external_order_id')
  .order('created_at', { ascending: true }));
const srcAll = {};
for (const o of orders) srcAll[o.external_source ?? 'null'] = (srcAll[o.external_source ?? 'null'] || 0) + 1;

const byPhone = new Map();
for (const o of orders) {
  const k = last8(o.customer_phone);
  if (!k) continue;
  (byPhone.get(k) ?? byPhone.set(k, []).get(k)).push({ ...o, createdD: new Date(o.created_at), taken: false });
}

H('WHAT IS IN THE CRM');
console.log(`  orders ${orders.length.toLocaleString('en-US')}   external_source: ${Object.entries(srcAll).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v.toLocaleString('en-US')}`).join(' · ')}`);
console.log(`  distinct phones (last-8): ${byPhone.size.toLocaleString('en-US')}`);
console.log(`\n  → the CRM holds AlterCPA inbound leads and nothing else. The outbound`);
console.log(`    (Predikcii / LEADS-OUT) register has no counterpart here by construction.`);

/* ── match ───────────────────────────────────────────────────────────────── */
const DAY = 86400_000;
const dayOf = (iso) => Math.floor(Date.parse(iso + 'T12:00:00Z') / DAY);
// Compare GOODS value against the order price: delivery is billed at 100 or
// 150 ден depending on the period, so including it would blur every comparison.
const amountDiff = (o, d) => (Number(o.price) > 0 && d.goodsMkd > 0)
  ? d.goodsMkd - Math.round(Number(o.price) * MKD_PER_EUR) : null;

// `shiftDays` exists for the placebo control below: re-run the identical
// matcher against dates that cannot possibly be right and see what survives.
function match(shiftDays) {
  for (const list of byPhone.values()) for (const o of list) o.taken = false;
  const out = [];
  for (const d of docList) {
    if (!d.tel8) { out.push({ d, verdict: 'no_phone' }); continue; }
    const all = byPhone.get(d.tel8) || [];
    if (!all.length) { out.push({ d, verdict: 'phone_absent' }); continue; }
    const docDay = dayOf(d.date) + shiftDays;
    const inWin = all.filter((o) => {
      if (o.taken) return false;
      const lag = docDay - Math.floor(o.createdD.getTime() / DAY);
      return lag >= -FWD && lag <= BACK;
    });
    if (!inWin.length) { out.push({ d, verdict: 'phone_only', otherOrders: all.length }); continue; }
    const scored = inWin.map((o) => ({ o, diff: amountDiff(o, d), lag: docDay - Math.floor(o.createdD.getTime() / DAY) }));
    scored.sort((a, b) => (Number(Math.abs(b.diff ?? 9e9) <= 3) - Number(Math.abs(a.diff ?? 9e9) <= 3)) || (Math.abs(a.lag) - Math.abs(b.lag)));
    const pick = scored[0];
    pick.o.taken = true;
    out.push({ d, verdict: 'matched', o: pick.o, lag: pick.lag, diff: pick.diff, alts: inWin.length - 1 });
  }
  return out;
}

// Placebo: the same matcher on impossible dates. Whatever it still "finds" is
// the noise floor — two orders from the same repeat customer happening to sit
// near each other. A finding is only real to the extent it beats this.
const PLACEBO = [120, 240, -200];
const placebo = {};
for (const s of PLACEBO) {
  const r = match(s);
  for (const reg of Object.keys(byReg)) {
    const m = r.filter((x) => x.d.register === reg && x.verdict === 'matched');
    const priced = m.filter((x) => x.diff !== null);
    (placebo[reg] ??= []).push({
      shift: s,
      rate: (100 * m.length) / byReg[reg].length,
      exact: (100 * priced.filter((x) => Math.abs(x.diff) <= 3).length) / (priced.length || 1),
    });
  }
}
const results = match(0);

/* ── per-register verdict ────────────────────────────────────────────────── */
for (const [reg, list] of Object.entries(byReg)) {
  const rs = results.filter((r) => r.d.register === reg);
  const m = rs.filter((r) => r.verdict === 'matched');
  const val = (f) => rs.filter(f).reduce((s, r) => s + r.d.totalMkd, 0);

  H(`REGISTER: ${reg}${reg === 'Predikcii' ? '  (LEADS-OUT — outbound repeat sales)' : '  (Нарачка LEADS — inbound affiliate leads)'}`);
  console.log(`  documents raised at collabBox       ${String(list.length).padStart(6)}   ${mkd(val(() => true))}`);
  console.log(`  ── found in the CRM within ${String(BACK).padStart(2)}d       ${String(m.length).padStart(6)}   ${((100 * m.length) / list.length).toFixed(1)}%`);
  console.log(`     phone known, no order near date  ${String(rs.filter((r) => r.verdict === 'phone_only').length).padStart(6)}`);
  console.log(`     phone not in the CRM at all      ${String(rs.filter((r) => r.verdict === 'phone_absent').length).padStart(6)}`);
  console.log(`     document carries no phone        ${String(rs.filter((r) => r.verdict === 'no_phone').length).padStart(6)}`);

  if (m.length) {
    // Precision: a genuine pairing shows the collabBox signature — the goods
    // value equals the order price, or exceeds it by a real upsell. A false
    // pairing (the customer's OTHER order) scatters with no spike at zero.
    const priced = m.filter((r) => r.diff !== null);
    const exact = priced.filter((r) => Math.abs(r.diff) <= 3).length;
    console.log(`\n  precision — goods value vs order price (×61,5):`);
    console.log(`     exact to ±3 ден                 ${String(exact).padStart(6)}   ${((100 * exact) / (priced.length || 1)).toFixed(1)}% of ${priced.length} priced matches`);
    const tally = {};
    for (const r of priced) tally[Math.round(r.diff)] = (tally[Math.round(r.diff)] || 0) + 1;
    console.log(`     distinct differences            ${String(Object.keys(tally).length).padStart(6)}`);
    console.log(`     most common: ${Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k > 0 ? '+' : ''}${k}×${v}`).join('  ')}`);

    // Placebo control — the same matcher on impossible dates.
    console.log(`\n     placebo (same matcher, shifted dates — this is the noise floor):`);
    for (const p of placebo[reg]) {
      console.log(`       ${String(p.shift > 0 ? `+${p.shift}` : p.shift).padStart(5)}d  matched ${p.rate.toFixed(1).padStart(5)}%   exact-amount ${p.exact.toFixed(1).padStart(5)}%`);
    }
    console.log(`       actual  matched ${((100 * m.length) / list.length).toFixed(1).padStart(5)}%   exact-amount ${((100 * exact) / (priced.length || 1)).toFixed(1).padStart(5)}%`);

    // Dispatch outcome. The enrichment column is the evidence for what a
    // document means: it is computed against orders created in this register's
    // own window, so it is not skewed by the CRM's overall age mix.
    const lo = list[0].date, hi = list[list.length - 1].date;
    const popOrders = orders.filter((o) => o.created_at >= lo && o.created_at <= `${hi}T23:59:59Z`);
    const pop = {};
    for (const o of popOrders) pop[o.status ?? 'null'] = (pop[o.status ?? 'null'] || 0) + 1;
    const st = {};
    for (const r of m) st[r.o.status ?? 'null'] = (st[r.o.status ?? 'null'] || 0) + 1;
    console.log(`\n  dispatch outcome — what the CRM says happened to these orders:`);
    console.log(`     ${'status'.padEnd(12)} ${'docs'.padStart(6)} ${'share'.padStart(7)} ${'population'.padStart(11)} ${'enrichment'.padStart(11)}`);
    for (const [s, n] of Object.entries(st).sort((a, b) => b[1] - a[1])) {
      const ps = (pop[s] ?? 0) / (popOrders.length || 1);
      console.log(`     ${s.padEnd(12)} ${String(n).padStart(6)} ${`${((100 * n) / m.length).toFixed(1)}%`.padStart(7)} ${`${(100 * ps).toFixed(1)}%`.padStart(11)} ${`×${((n / m.length) / (ps || 1e-9)).toFixed(2)}`.padStart(11)}`);
    }

    // The genuine anomaly: a document says the parcel went out, and the CRM
    // shows an outcome only reachable WITHOUT dispatching. paid / returned /
    // shipped are all consistent with a dispatch; the rest are not.
    const DISPATCHED_OK = new Set(['paid', 'returned', 'shipped', 'delivered']);
    const odd = m.filter((r) => !DISPATCHED_OK.has(r.o.status));
    if (odd.length) {
      const why = {};
      for (const r of odd) { const k = `${r.o.status} · ${r.o.cancellation_reason || r.o.trash_reason || '—'}`; why[k] = (why[k] || 0) + 1; }
      console.log(`\n     ${odd.length.toLocaleString('en-US')} documents were raised for orders the CRM says never shipped (${mkd(odd.reduce((s, r) => s + r.d.totalMkd, 0))}):`);
      for (const [k, n] of Object.entries(why).sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`       ${String(n).padStart(5)}  ${k}`);
      console.log(`     → either the cancel/trash is wrong, or a delivery outcome was never recorded.`);
      console.log(`       NOT evidence of payment on its own — settle these against courier data.`);
    }
  }
  // Third defect class: the order is here, it is paid, and the amount is still
  // wrong. The call centre upsold on the phone and the extra never came back to
  // AlterCPA, so the CRM kept the LEAD's price and package count.
  const okPaid = m.filter((r) => r.o.status === 'paid' && r.diff !== null);
  const under = okPaid.filter((r) => r.diff > 3);
  const over = okPaid.filter((r) => r.diff < -3);
  if (okPaid.length) {
    const sumUnder = under.reduce((s, r) => s + r.diff, 0);
    console.log(`\n  value accuracy on the ${okPaid.length} matched-and-paid orders:`);
    console.log(`     CRM records LESS than collected  ${String(under.length).padStart(6)}   short by ${mkd(sumUnder)} (${eur(sumUnder)})`);
    console.log(`     CRM records MORE than collected  ${String(over.length).padStart(6)}   over by ${mkd(-over.reduce((s, r) => s + r.diff, 0))}`);
    const qtyBad = m.filter((r) => r.o.status === 'paid' && r.d.units > 0 && Number(r.o.quantity) !== r.d.units);
    console.log(`     package count disagrees          ${String(qtyBad.length).padStart(6)}   (collabBox units vs order quantity)`);
  }

  const missing = rs.filter((r) => r.verdict !== 'matched');
  if (missing.length) {
    console.log(`\n  NOT REPRESENTED IN THE CRM: ${missing.length.toLocaleString('en-US')} documents, ${mkd(missing.reduce((s, r) => s + r.d.totalMkd, 0))} (${eur(missing.reduce((s, r) => s + r.d.totalMkd, 0))})`);
  }
}

/* ── what these files can actually fix ───────────────────────────────────── */
// Split strictly by what the register is evidence OF. A dispatch note proves
// the order existed and what went out in the parcel — so it can create a
// missing order and correct a value or a package count. It says nothing about
// whether the money came back, so it can never settle a status.
H('WHAT THESE FILES CAN FIX');
const matchedAll = results.filter((r) => r.verdict === 'matched');
const DISPATCHED_OK = new Set(['paid', 'returned', 'shipped', 'delivered']);

// 1. orders that exist at collabBox and nowhere in the CRM
const absent = results.filter((r) => r.verdict !== 'matched');
const absentByReg = {};
for (const r of absent) (absentByReg[r.d.register] ??= []).push(r);
console.log(`\n  1. MISSING ORDERS — create them (name, phone, address, product, date, operator, value all present)`);
for (const [reg, rs] of Object.entries(absentByReg)) {
  console.log(`       ${reg.padEnd(11)} ${String(rs.length).padStart(6)} orders   ${mkd(rs.reduce((s, r) => s + r.d.totalMkd, 0))}`);
}
console.log(`       ${'TOTAL'.padEnd(11)} ${String(absent.length).padStart(6)} orders   ${mkd(absent.reduce((s, r) => s + r.d.totalMkd, 0))}  (${eur(absent.reduce((s, r) => s + r.d.totalMkd, 0))})`);

// 2. value + package count on orders we DO have. The dispatch value is the
//    truth here whatever the outcome was, so this is not limited to paid ones.
const valBad = matchedAll.filter((r) => r.diff !== null && Math.abs(r.diff) > 3);
const qtyBad = matchedAll.filter((r) => r.d.units > 0 && r.o.quantity != null && Number(r.o.quantity) !== r.d.units);
const either = new Set([...valBad, ...qtyBad]);
const shortfall = valBad.filter((r) => r.diff > 0).reduce((s, r) => s + r.diff, 0);
console.log(`\n  2. WRONG VALUE / PACKAGE COUNT — correct them from the document`);
console.log(`       value disagrees            ${String(valBad.length).padStart(6)} orders`);
console.log(`         └ CRM under-records      ${String(valBad.filter((r) => r.diff > 0).length).padStart(6)} orders   ${mkd(shortfall)} (${eur(shortfall)}) not recorded`);
console.log(`         └ CRM over-records       ${String(valBad.filter((r) => r.diff < 0).length).padStart(6)} orders   ${mkd(-valBad.filter((r) => r.diff < 0).reduce((s, r) => s + r.diff, 0))}`);
console.log(`       package count disagrees    ${String(qtyBad.length).padStart(6)} orders`);
console.log(`       ── distinct orders affected ${String(either.size).padStart(5)}`);

// 3. what the register cannot settle
const odd = matchedAll.filter((r) => !DISPATCHED_OK.has(r.o.status));
console.log(`\n  3. CANNOT BE FIXED FROM THESE FILES — status`);
console.log(`       ${String(odd.length).padStart(6)} orders were dispatched but the CRM says they never shipped.`);
console.log(`              That is a real contradiction worth chasing, but a Нарачка proves`);
console.log(`              dispatch, not collection. Settle it against courier data (MEX),`);
console.log(`              which is the only source that saw the money at the door.`);
console.log(`\n       ${String(matchedAll.filter((r) => r.o.status === 'returned').length).padStart(6)} of the matched orders are ones MEX proved came BACK —`);
console.log(`              they carry a collabBox document too, which is why the register`);
console.log(`              cannot be read as a list of payments.`);

console.log(`\n  ── FIXABLE FROM THESE FILES: ${(absent.length + either.size).toLocaleString('en-US')} orders`);
console.log(`     (${absent.length.toLocaleString('en-US')} to create, ${either.size.toLocaleString('en-US')} to correct in place)`);

/* ── row-by-row audit ────────────────────────────────────────────────────── */
if (OUT_CSV) {
  const rows = ['sep=;', ['verdict', 'register', 'doc', 'doc_date', 'name', 'phone', 'address', 'author',
    'total_mkd', 'goods_mkd', 'delivery_mkd', 'units', 'products', 'order_id', 'order_display_id',
    'order_status', 'order_created', 'order_paid_at', 'order_price_eur', 'order_price_mkd', 'order_qty',
    'order_reason', 'lag_days', 'goods_minus_price_mkd', 'alt_candidates'].join(';')];
  for (const r of results) {
    const o = r.o;
    rows.push([r.verdict, r.d.register, r.d.doc, r.d.date, r.d.name, r.d.phone, r.d.addr, r.d.author,
      r.d.totalMkd, r.d.goodsMkd, r.d.deliveryMkd, r.d.units, r.d.products.join(' + '),
      o?.id ?? '', o?.display_id ?? '', o?.status ?? '', o?.created_at ?? '', o?.paid_at ?? '',
      o?.price ?? '', o ? Math.round(Number(o.price) * MKD_PER_EUR) : '', o?.quantity ?? '',
      o?.cancellation_reason || o?.trash_reason || '', r.lag ?? '', r.diff ?? '', r.alts ?? '',
    ].map((v) => String(v ?? '').replace(/[;\r\n]/g, ' ')).join(';'));
  }
  writeFileSync(OUT_CSV, '\uFEFF' + rows.join('\n'), 'utf8');
  console.log(`\nrow-by-row audit → ${OUT_CSV}`);
}
