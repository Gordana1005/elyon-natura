#!/usr/bin/env node
/**
 * Reconcile MEX Poshta shipments (portal CSV exports + API dates) against
 * public.orders — find orders whose CRM status contradicts what physically
 * happened at the courier, and optionally fix them.
 *
 *   node scripts/reconcile-mex-shipments.mjs <all.csv> [more.csv…] \
 *        --dates <mex-dates.json> [--commit]
 *
 * Ground truth: a MEX "Delivered" shipment means the COD was collected at the
 * door — whatever AlterCPA (or anyone) later wrote, that order is PAID. This is
 * the same class of correction as the 2026-08 collabBox reconciliation (2.609
 * orders cancelled at AlterCPA but proven paid).
 *
 * What --commit changes:
 *   - MEX Delivered  → status 'paid', paid_at = MEX delivery time; any
 *     cancellation/trash reason is CLEARED (a paid order must not carry one)
 *   - MEX Return     → status 'returned' (returned_at = MEX time) — but ONLY
 *     from open statuses (pending/take/call_again/confirmed/shipped/delivered).
 *     A cancelled/trashed/paid order + MEX return is REPORTED, not changed.
 *   - matched orders with an empty customer_address get the receiver address
 *     (orders fill-only; the customer_profiles backfill can then pick it up)
 *   - every change gets an order_history row + an order_note with the tracking id
 *
 * Matching (never guessed):
 *   phone last-8  →  candidate orders, then COD must equal round(price€×61.5)
 *   or that +150 ДОСТАВА (±3 ден), then nearest |ship created − order created|
 *   within [−3d … +75d]. A phone+COD with several equally-plausible orders is
 *   matched greedily nearest-date, 1:1; leftovers are reported as ambiguous.
 *   Orders with price 0 match only when the phone has a single candidate.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REF = 'bmfxhgznttcnnlqloqzp';                       // MACEDONIA. never change.
const MKD_PER_EUR = 61.5;                                  // FROZEN — see src/lib/currency.ts
const DELIVERY_MKD = 150;

const args = process.argv.slice(2);
const COMMIT = args.includes('--commit');
const datesIdx = args.indexOf('--dates');
const DATES_PATH = datesIdx >= 0 ? args[datesIdx + 1] : null;
const sinceIdx = args.indexOf('--since');
const SINCE = sinceIdx >= 0 ? args[sinceIdx + 1] : '2026-03-01';
const csvPaths = args.filter((a, i) => !a.startsWith('--') && i !== datesIdx + 1 && i !== sinceIdx + 1);
if (!csvPaths.length || !DATES_PATH) {
  console.error('usage: node scripts/reconcile-mex-shipments.mjs <export.csv> [more.csv…] --dates <mex-dates.json> [--commit]');
  process.exit(1);
}

const env = { ...process.env };
try {
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*?)"?\s*$/);
    if (m && !env[m[1]]) env[m[1]] = m[2];
  }
} catch { /* env may be real */ }
const SUPABASE_URL = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL?.includes(REF) || !SERVICE_KEY) {
  console.error(`Refusing to run: SUPABASE_URL must be the Macedonian project (${REF}).`);
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

/* ── CSV parsing (quoted fields, embedded commas, BOM) ───────────────────── */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (field !== '' || row.length) { row.push(field); rows.push(row); row = []; field = ''; }
      if (c === '\r' && text[i + 1] === '\n') i++;
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const last8 = (v) => {
  const d = String(v || '').replace(/\D/g, '');
  return d.length >= 8 ? d.slice(-8) : null;
};

/* ── load shipments (union of the CSVs, deduped on tracking id) ──────────── */
const dates = JSON.parse(readFileSync(DATES_PATH, 'utf8'));
const ships = new Map();
for (const p of csvPaths) {
  const rows = parseCsv(readFileSync(p, 'utf8').replace(/^﻿/, ''));
  const hdr = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name) => hdr.findIndex((h) => h === name);
  const iTrack = col('tracking id'), iName = col('receiver name'), iAddr = col('receiver address'),
    iCity = col('receiver city'), iTel = col('receiver tel'), iCod = col('cod'), iInstr = col('instructions');
  for (const r of rows.slice(1)) {
    const id = (r[iTrack] || '').trim();
    if (!id || ships.has(id)) continue;
    const d = dates[id];
    ships.set(id, {
      id,
      name: (r[iName] || '').trim(),
      addr: (r[iAddr] || '').trim(),
      city: (r[iCity] || '').trim(),
      tel8: last8(r[iTel]),
      cod: Math.round(Number(String(r[iCod]).replace(/[^\d.]/g, '')) || 0),
      instr: (r[iInstr] || '').trim(),
      status: d?.st ?? null,           // 2 delivered, 7 returned
      statusName: d?.stn ?? null,
      created: d?.c ? new Date(d.c.replace(' ', 'T') + '+02:00') : null,
      updated: d?.u ? new Date(d.u.replace(' ', 'T') + '+02:00') : null,
    });
  }
}
console.log(`shipments loaded: ${ships.size.toLocaleString('en-US')} (with API date/status: ${[...ships.values()].filter((s) => s.status != null).length.toLocaleString('en-US')})`);

/* ── load orders since just before the MEX era ───────────────────────────── */
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
const orders = await loadAll(() => supabase
  .from('orders')
  .select('id, display_id, customer_phone, customer_name, customer_address, customer_city, price, quantity, status, created_at, cancellation_reason, trash_reason, cancelled_by_agent_id, confirmed_at, assigned_agent_id, external_source, external_order_id')
  .gte('created_at', SINCE)
  .order('created_at', { ascending: true }));
console.log(`orders since ${SINCE}: ${orders.length.toLocaleString('en-US')}`);

const byPhone = new Map();
for (const o of orders) {
  const k = last8(o.customer_phone);
  if (!k) continue;
  if (!byPhone.has(k)) byPhone.set(k, []);
  byPhone.get(k).push({ ...o, createdD: new Date(o.created_at), shipments: [] });
}

/* ── match ───────────────────────────────────────────────────────────────── */
const codOk = (o, cod) => {
  const exp = Math.round(Number(o.price) * MKD_PER_EUR);
  if (!exp) return null;                                    // unpriced — no COD signal
  return Math.abs(cod - exp) <= 3 || Math.abs(cod - exp - DELIVERY_MKD) <= 3;
};
const DAY = 86400_000;
const inWindow = (o, s) => s.created && (s.created - o.createdD) >= -3 * DAY && (s.created - o.createdD) <= 75 * DAY;

let matched = 0, noPhone = 0, noCandidate = 0, ambiguous = 0;
const unmatchedSamples = [];
const shipList = [...ships.values()].sort((a, b) => (a.created?.getTime() ?? 0) - (b.created?.getTime() ?? 0));
for (const s of shipList) {
  if (!s.tel8) { noPhone++; continue; }
  const cands = (byPhone.get(s.tel8) || []).filter((o) => inWindow(o, s));
  if (!cands.length) {
    noCandidate++;
    if (unmatchedSamples.length < 40) unmatchedSamples.push({ id: s.id, name: s.name, tel8: s.tel8, cod: s.cod, created: s.created?.toISOString()?.slice(0, 10) });
    continue;
  }
  const codMatches = cands.filter((o) => codOk(o, s.cod) === true);
  let pool = codMatches.length ? codMatches : (cands.length === 1 ? cands : []);
  if (!pool.length) { ambiguous++; continue; }
  // nearest by date, preferring orders with no shipment yet (1:1), falling
  // back to reuse (a returned parcel re-sent is two shipments, one order)
  const dist = (o) => Math.abs((s.created?.getTime() ?? 0) - o.createdD.getTime());
  const free = pool.filter((o) => o.shipments.length === 0);
  const target = (free.length ? free : pool).sort((a, b) => dist(a) - dist(b))[0];
  target.shipments.push(s);
  matched++;
}
console.log(`\nmatching: ${matched.toLocaleString('en-US')} matched · ${noCandidate} no candidate order · ${ambiguous} ambiguous (skipped) · ${noPhone} unusable phone`);

/* ── classify per order ──────────────────────────────────────────────────── */
const OPEN = new Set(['pending', 'take', 'call_again', 'confirmed', 'shipped', 'delivered']);
const matrix = {};                    // crmStatus → mexOutcome → count
const bump = (a, b) => { (matrix[a] ??= {}); matrix[a][b] = (matrix[a][b] || 0) + 1; };
const toPaid = [], toReturned = [], conflicts = [], addrFills = [];
let alreadyRight = 0;

for (const list of byPhone.values()) {
  for (const o of list) {
    if (!o.shipments.length) continue;
    const delivered = o.shipments.filter((s) => s.status === 2).sort((a, b) => b.updated - a.updated)[0];
    const returned = o.shipments.filter((s) => s.status === 7).sort((a, b) => b.updated - a.updated)[0];
    const active = o.shipments.find((s) => s.status !== 2 && s.status !== 7);
    const outcome = delivered ? 'delivered' : returned ? 'returned' : (active?.statusName || 'active');
    bump(o.status, outcome);

    const src = delivered ?? returned ?? o.shipments[0];
    if (src.addr && !String(o.customer_address || '').trim()) {
      addrFills.push({ id: o.id, addr: src.addr.slice(0, 600), city: src.city && !String(o.customer_city || '').trim() ? src.city.slice(0, 200) : null });
    }

    if (delivered) {
      if (o.status === 'paid') { alreadyRight++; continue; }
      if (o.status === 'duplicated') { conflicts.push({ kind: 'duplicated_but_delivered', order: o.display_id, track: delivered.id }); continue; }
      toPaid.push({ o, s: delivered });
    } else if (returned) {
      if (o.status === 'returned') { alreadyRight++; continue; }
      if (OPEN.has(o.status)) toReturned.push({ o, s: returned });
      else conflicts.push({ kind: `${o.status}_but_mex_returned`, order: o.display_id, track: returned.id });
    }
  }
}

console.log('\nCRM status × MEX outcome (matched orders):');
console.table(matrix);
const sumMkd = (arr) => arr.reduce((a, { s }) => a + s.cod, 0);
const paidFromCancelled = toPaid.filter(({ o }) => o.status === 'cancelled');
const paidFromTrashed = toPaid.filter(({ o }) => o.status === 'trashed');
const paidByOurAgent = toPaid.filter(({ o }) => o.cancelled_by_agent_id);
console.log(`\n→ to PAID: ${toPaid.length} orders, ${sumMkd(toPaid).toLocaleString('en-US')} ден COD`);
console.log(`   of which wrongly CANCELLED: ${paidFromCancelled.length} (${sumMkd(paidFromCancelled).toLocaleString('en-US')} ден)`);
console.log(`   of which wrongly TRASHED : ${paidFromTrashed.length} (${sumMkd(paidFromTrashed).toLocaleString('en-US')} ден)`);
console.log(`   cancelled by OUR agent   : ${paidByOurAgent.length} (rest were AlterCPA-side cancels)`);
console.log(`→ to RETURNED (from open statuses): ${toReturned.length}`);
console.log(`→ conflicts reported, not changed: ${conflicts.length}`);
console.log(`already correct: ${alreadyRight} · address fills on matched orders: ${addrFills.length}`);

const SCRATCH = process.env.RECON_REPORT || join(ROOT, 'scripts', 'data', 'mex-reconcile-report.json');
writeFileSync(SCRATCH, JSON.stringify({
  generated: new Date().toISOString(),
  matrix, conflicts, unmatchedSamples,
  toPaid: toPaid.map(({ o, s }) => ({ order: o.display_id, id: o.id, was: o.status, track: s.id, cod: s.cod, delivered: s.updated })),
  toReturned: toReturned.map(({ o, s }) => ({ order: o.display_id, id: o.id, was: o.status, track: s.id, returned: s.updated })),
}, null, 2));
console.log(`\nfull report → ${SCRATCH}`);

if (!COMMIT) { console.log('\nDRY RUN — nothing written. Re-run with --commit.'); process.exit(0); }

/* ── apply ───────────────────────────────────────────────────────────────── */
async function withRetry(fn, what) {
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try { const { error } = await fn(); if (error) throw new Error(error.message); return; }
    catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 2000 * attempt)); }
  }
  throw new Error(`${what}: ${lastErr.message}`);
}

let done = 0;
for (const { o, s } of toPaid) {
  await withRetry(() => supabase.from('orders').update({
    status: 'paid',
    paid_at: s.updated.toISOString(),
    cancellation_reason: null, cancellation_reason_notes: null, cancelled_at: null,
    trash_reason: null, trash_reason_notes: null, trashed_at: null,
  }).eq('id', o.id), `paid ${o.display_id}`);
  await withRetry(() => supabase.from('order_history').insert({
    order_id: o.id, from_status: o.status, to_status: 'paid',
    changed_by: null, changed_by_name: 'System (mex:reconciliation)',
  }), `history ${o.display_id}`);
  await withRetry(() => supabase.from('order_notes').insert({
    order_id: o.id,
    text: `MEX ${s.id} delivered ${s.updated.toISOString().slice(0, 10)} (COD ${s.cod} ден) — status corrected to paid (was ${o.status}).`,
    author_id: null, author_name: 'System',
  }), `note ${o.display_id}`);
  done++;
  if (done % 100 === 0) process.stdout.write(`\r  paid ${done}/${toPaid.length}`);
}
console.log(`\npaid applied: ${done}`);

done = 0;
for (const { o, s } of toReturned) {
  await withRetry(() => supabase.from('orders').update({
    status: 'returned', returned_at: s.updated.toISOString(),
  }).eq('id', o.id), `returned ${o.display_id}`);
  await withRetry(() => supabase.from('order_history').insert({
    order_id: o.id, from_status: o.status, to_status: 'returned',
    changed_by: null, changed_by_name: 'System (mex:reconciliation)',
  }), `history ${o.display_id}`);
  await withRetry(() => supabase.from('order_notes').insert({
    order_id: o.id,
    text: `MEX ${s.id} returned to sender ${s.updated.toISOString().slice(0, 10)} — status set to returned (was ${o.status}).`,
    author_id: null, author_name: 'System',
  }), `note ${o.display_id}`);
  done++;
}
console.log(`returned applied: ${done}`);

done = 0;
for (const f of addrFills) {
  const patch = { customer_address: f.addr };
  if (f.city) patch.customer_city = f.city;
  await withRetry(() => supabase.from('orders').update(patch).eq('id', f.id), `addr ${f.id}`);
  done++;
  if (done % 200 === 0) process.stdout.write(`\r  addr ${done}/${addrFills.length}`);
}
console.log(`\naddress fills applied: ${done}`);
console.log('\nDone. Segment recomputes ran per-row via triggers.');
