#!/usr/bin/env node
// Full accuracy audit (2026-08-11): every AlterCPA-imported order cross-checked
// against (1) AlterCPA's raw record — quantity, total price; (2) MEX's COD and
// terminal status for linked shipments. Reports everything; --commit fixes
// quantity/price on orders no agent owns (same rule as the resize sync).
//   node scripts/audit-altercpa-accuracy.mjs [--commit]
// Needs: scripts/data/altercpa-mk-raw.jsonl + the MEX CSV exports + mex-dates.json (paths below).
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRATCH = 'C:/Users/Mile/AppData/Local/Temp/claude/d--Dev-archives-elyon-natura/dd5edcb5-3625-4d19-821d-ffb508ceb61a/scratchpad';
const COMMIT = process.argv.includes('--commit');
const FX = { mkd: 61.5, eur: 1, bgn: 1.95583 };

const env = {};
for (const line of readFileSync(ROOT + '/.env', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*?)"?\s*$/);
  if (m) env[m[1]] = m[2];
}
const URL = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
if (!URL?.includes('bmfxhgznttcnnlqloqzp')) { console.error('Not Macedonia. Refusing.'); process.exit(1); }
const supabase = createClient(URL, env.SUPABASE_SERVICE_ROLE_KEY);

// ── source of truth 1: AlterCPA raw (history) + live ledger (bridge era) ────
const remote = new Map();   // external id → {qty, totalEur, phase}
const qtyOf = (o) => {
  const g = (o.goods || [])[0];
  const q = Number(g?.count ?? o.count ?? 1);
  return Number.isFinite(q) && q >= 1 ? Math.floor(q) : 1;
};
const eurOf = (o) => {
  const div = FX[String(o.currency || 'mkd').toLowerCase()];
  if (!div) return null;
  const n = Number(o.price);
  return Number.isFinite(n) ? Math.round((n / div) * 100) / 100 : null;
};
for (const line of readFileSync(ROOT + '/scripts/data/altercpa-mk-raw.jsonl', 'utf8').split('\n')) {
  if (!line.trim()) continue;
  try { const o = JSON.parse(line); remote.set(String(o.id), { qty: qtyOf(o), totalEur: eurOf(o), phase: Number(o.phase) || 0 }); } catch {}
}
console.log('AlterCPA raw records:', remote.size);

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
const ledger = await loadAll(() => supabase.from('altercpa_leads')
  .select("altercpa_id, payload"));
for (const l of ledger) {
  try { remote.set(String(l.altercpa_id), { qty: qtyOf(l.payload), totalEur: eurOf(l.payload), phase: Number(l.payload?.phase) || 0 }); } catch {}
}
console.log('after ledger overlay:', remote.size);

// ── source of truth 2: MEX (COD + terminal status by tracking id) ───────────
const mex = JSON.parse(readFileSync(SCRATCH + '/mex-dates.json', 'utf8'));   // id → {st,c,u}
const mexCod = new Map();
function parseCsv(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (f !== '' || row.length) { row.push(f); rows.push(row); row = []; f = ''; } if (c === '\r' && text[i + 1] === '\n') i++; }
    else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows;
}
const mexInstr = new Map();
for (const p of ['D:/export_2026-08-11.csv', 'D:/export_2026-08-11 (1).csv', 'D:/export_2026-08-11 (2).csv']) {
  const rows = parseCsv(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
  const hdr = rows[0].map((h) => h.trim().toLowerCase());
  const iT = hdr.indexOf('tracking id'), iC = hdr.indexOf('cod'), iI = hdr.indexOf('instructions');
  for (const r of rows.slice(1)) {
    const id = (r[iT] || '').trim();
    if (id && !mexCod.has(id)) {
      mexCod.set(id, Math.round(Number(String(r[iC]).replace(/[^\d.]/g, '')) || 0));
      mexInstr.set(id, (r[iI] || '').trim());
    }
  }
}
// Instructions are the packing list: "CARDIOFIX … = 3,ДОСТАВА = 1". The pack
// count is the sum of the product lines' "= N"; a ДОСТАВА line means the 150
// ден delivery fee is inside the COD.
function parseInstr(instr) {
  if (!instr) return null;
  let qty = 0, delivery = 0, parsed = 0;
  for (const part of instr.split(',')) {
    const m = part.match(/=\s*(\d+)\s*$/);
    if (!m) continue;
    parsed++;
    if (/достава/i.test(part)) delivery = 150;
    else qty += Number(m[1]);
  }
  if (!parsed || qty < 1) return null;
  return { qty, delivery };
}
console.log('MEX shipments with COD:', mexCod.size);

// ── our orders ──────────────────────────────────────────────────────────────
const orders = await loadAll(() => supabase.from('orders')
  .select('id, display_id, external_order_id, quantity, price, status, assigned_agent_id, confirmed_by_agent_id, mex_tracking_id')
  .eq('external_source', 'altercpa'));
console.log('CRM orders (altercpa):', orders.length, '\n');

// Truth priority: the courier's collected COD (with a parseable packing list)
// outranks AlterCPA's record — upsells often never made it back into their
// system, so for linked shipments the two DISAGREE PERMANENTLY (~2.7k orders).
// Without this priority the audit would ping-pong orders between the two.
const stats = {
  checked: 0, no_remote: 0,
  qty_ok: 0, qty_wrong: 0, price_ok: 0, price_wrong: 0,
  fixable: 0, agent_owned: 0, zeroed_remote: 0,
  mex_linked: 0, cod_match: 0, courier_overrides_remote: 0, cod_unparseable: 0,
  mex_status_ok: 0, mex_status_off: 0,
};
const fixes = [];
const statusFixes = [], codFixes = [];
const codOffSamples = [], statusOffSamples = [];
for (const o of orders) {
  const r = remote.get(String(o.external_order_id));
  if (!r) { stats.no_remote++; continue; }
  stats.checked++;
  if (r.totalEur == null || (r.qty === 1 && r.totalEur === 0)) { stats.zeroed_remote++; continue; }

  // The applicable truth: courier COD (+packing list) when linked, else AlterCPA.
  let truth = { qty: r.qty, price: r.totalEur, src: 'altercpa' };
  const codHere = o.mex_tracking_id ? mexCod.get(o.mex_tracking_id) : null;
  if (codHere != null && codHere > 0) {
    const expRemote = Math.round(r.totalEur * 61.5);
    const agreesRemote = Math.abs(codHere - expRemote) <= 3 || Math.abs(codHere - expRemote - 150) <= 3;
    if (agreesRemote) stats.cod_match++;
    else {
      const pi = parseInstr(mexInstr.get(o.mex_tracking_id));
      if (!pi) stats.cod_unparseable++;
      else {
        stats.courier_overrides_remote++;
        truth = { qty: pi.qty, price: Math.round(((codHere - pi.delivery) / 61.5) * 100) / 100, src: 'mex', cod: codHere, delivery: pi.delivery };
        if (codOffSamples.length < 12) codOffSamples.push({ ord: o.display_id, track: o.mex_tracking_id, cod: codHere, altercpa_mkd: expRemote });
      }
    }
  }

  const qtyOk = o.quantity === truth.qty;
  const priceOk = Math.abs(Number(o.price) - truth.price) <= 0.02;
  qtyOk ? stats.qty_ok++ : stats.qty_wrong++;
  priceOk ? stats.price_ok++ : stats.price_wrong++;
  if ((!qtyOk || !priceOk) && truth.price > 0) {
    if (o.assigned_agent_id || o.confirmed_by_agent_id) stats.agent_owned++;
    else if (truth.src === 'mex') { stats.fixable++; codFixes.push({ id: o.id, display: o.display_id, qty: truth.qty, price: truth.price, cod: truth.cod, delivery: truth.delivery, track: o.mex_tracking_id }); }
    else { stats.fixable++; fixes.push({ id: o.id, qty: truth.qty, price: truth.price }); }
  }

  if (o.mex_tracking_id) {
    stats.mex_linked++;
    const st = mex[o.mex_tracking_id]?.st;
    if (st === 2 || st === 7) {
      const want = st === 2 ? 'paid' : 'returned';
      if (o.status === want || o.status === 'duplicated') stats.mex_status_ok++;
      else {
        stats.mex_status_off++;
        if (statusOffSamples.length < 12) statusOffSamples.push({ ord: o.display_id, crm: o.status, mex: want });
        statusFixes.push({ id: o.id, display: o.display_id, was: o.status, want, track: o.mex_tracking_id, when: mex[o.mex_tracking_id]?.u });
      }
    }
  }
}
console.log(stats);
if (codOffSamples.length) { console.log('\nCOD mismatch samples:'); console.table(codOffSamples); }
if (statusOffSamples.length) { console.log('\nMEX status mismatch samples:'); console.table(statusOffSamples); }

if (!COMMIT) { console.log('\nDRY RUN — nothing written. --commit fixes: remote qty/price, MEX status drifts, COD-corrected totals.'); process.exit(0); }

// ── MEX status enforcement (same rules as mex-reconcile) ────────────────────
let sDone = 0;
for (const f of statusFixes) {
  const when = f.when ? new Date(f.when.replace(' ', 'T') + '+02:00').toISOString() : new Date().toISOString();
  const upd = f.want === 'paid'
    ? { status: 'paid', paid_at: when, cancellation_reason: null, cancellation_reason_notes: null, cancelled_at: null, trash_reason: null, trash_reason_notes: null, trashed_at: null }
    : { status: 'returned', returned_at: when, paid_at: null, cancellation_reason: null, cancellation_reason_notes: null, cancelled_at: null, trash_reason: null, trash_reason_notes: null, trashed_at: null };
  const { error: e1 } = await supabase.from('orders').update(upd).eq('id', f.id);
  if (e1) { console.error(`${f.display}: ${e1.message}`); continue; }
  await supabase.from('order_history').insert({ order_id: f.id, from_status: f.was, to_status: f.want, changed_by: null, changed_by_name: 'System (mex:reconciliation)' });
  await supabase.from('order_notes').insert({
    order_id: f.id,
    text: `MEX ${f.track} ${f.want === 'paid' ? 'delivered' : 'returned to sender'} ${when.slice(0, 10)} — status corrected to ${f.want} (was ${f.was}; audit 2026-08-11).`,
    author_id: null, author_name: 'System',
  });
  sDone++;
}
console.log(`status corrections applied: ${sDone}/${statusFixes.length}`);

// ── COD-based size/total corrections ────────────────────────────────────────
let cDone = 0;
for (const f of codFixes) {
  const { error: e1 } = await supabase.from('orders').update({ quantity: f.qty, price: f.price }).eq('id', f.id);
  if (e1) { console.error(`${f.display}: ${e1.message}`); continue; }
  await supabase.from('order_items').update({
    quantity: f.qty,
    price_per_unit: Math.round((f.price / Math.max(1, f.qty)) * 100) / 100,
    total_price: f.price,
  }).eq('order_id', f.id);
  await supabase.from('order_notes').insert({
    order_id: f.id,
    text: `Corrected from the courier record (audit 2026-08-11): MEX ${f.track} collected COD ${f.cod} ден${f.delivery ? ' (incl. 150 ден delivery)' : ''} for ${f.qty} pack(s) — order total set to ${Math.round(f.price * 61.5)} ден.`,
    author_id: null, author_name: 'System',
  });
  cDone++;
  if (cDone % 200 === 0) process.stdout.write(`\r  cod-fixed ${cDone}/${codFixes.length}`);
}
console.log(`\ncod corrections applied: ${cDone}/${codFixes.length}`);

let done = 0;
for (const f of fixes) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const { error: e1 } = await supabase.from('orders').update({ quantity: f.qty, price: f.price }).eq('id', f.id);
      if (e1) throw new Error(e1.message);
      const { error: e2 } = await supabase.from('order_items').update({
        quantity: f.qty,
        price_per_unit: Math.round((f.price / Math.max(1, f.qty)) * 100) / 100,
        total_price: f.price,
      }).eq('order_id', f.id);
      if (e2) throw new Error(e2.message);
      lastErr = null; break;
    } catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 2000 * attempt)); }
  }
  if (lastErr) throw new Error(`${f.id}: ${lastErr.message}`);
  done++;
  if (done % 200 === 0) process.stdout.write(`\r  fixed ${done}/${fixes.length}`);
}
console.log(`\nfixed: ${done}`);
