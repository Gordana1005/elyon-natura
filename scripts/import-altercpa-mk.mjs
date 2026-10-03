#!/usr/bin/env node
/**
 * Import the AlterCPA Macedonian history into the CRM.
 *
 *   node scripts/import-altercpa-mk.mjs                    # dry run (default)
 *   node scripts/import-altercpa-mk.mjs --limit 200        # first slice only
 *   node scripts/import-altercpa-mk.mjs --commit           # write
 *   node scripts/import-altercpa-mk.mjs --commit --resume  # continue after a stop
 *
 * Posts to POST /api/orders/import — the same endpoint the admin Import Orders
 * page uses — so dedupe, phone normalisation, product matching, order_items,
 * provenance notes and customer_profiles all behave exactly as they do in the
 * UI. It is admin-only, so the script signs in with a real admin login.
 *
 * ── Idempotency ──
 * external_order_id = the AlterCPA order id, under the FIXED source label
 * `altercpa`. A partial unique index on (external_source, external_order_id)
 * backs it, so re-running is a no-op. Never change SOURCE_LABEL: the dedupe
 * query is scoped by it, so a different label would re-import all 81k rows as
 * duplicates.
 *
 * ── Before --commit, disable the segment trigger ──
 * trg_orders_segments_insert recomputes a customer's whole segment membership
 * on EVERY inserted row. Across 81k inserts that is 81k redundant recomputes —
 * only the last one per phone matters. See the runbook printed by --commit.
 */
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PHASE, PHASE_TO_STATUS, REASON, EXACT_FX, FX_TO_EUR,
  toEur, normalizeMkPhone, productNameOf, quantityOf, isoDay, readOrders, isTestOrder,
} from './lib/altercpa.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const D = (f) => join(ROOT, 'scripts', 'data', f);
const RAW = D('altercpa-mk-raw.jsonl');
const MAP_FILE = D('altercpa-product-map.json');
const CORRECTIONS = D('collabbox-corrections.json');
const DONE_LOG = D('altercpa-import-done.txt');
const PAYLOAD_SAMPLE = D('altercpa-import-payload-sample.json');

const SOURCE_LABEL = 'altercpa';   // NEVER change — the dedupe key is scoped by it
const BATCH = 200;

const args = process.argv.slice(2);
const COMMIT = args.includes('--commit');
const RESUME = args.includes('--resume');
const LIMIT = (() => { const i = args.indexOf('--limit'); return i >= 0 ? Number(args[i + 1]) : null; })();
const CONCURRENCY = (() => { const i = args.indexOf('--concurrency'); return i >= 0 ? Math.max(1, Number(args[i + 1])) : 6; })();
const REF = 'oufoazmnbwugtfldkwsn';

const env = {};
for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
  if (m) env[m[1]] = m[2];
}
const SUPABASE_URL = env.VITE_SUPABASE_URL;
const ANON = env.VITE_SUPABASE_PUBLISHABLE_KEY || env.VITE_SUPABASE_ANON_KEY;
const ADMIN_EMAIL = process.env.MK_ADMIN_EMAIL || 'mile@elyon.com';
const ADMIN_PASSWORD = process.env.MK_ADMIN_PASSWORD;

// ── build the rows ────────────────────────────────────────────────────────
const { map } = JSON.parse(readFileSync(MAP_FILE, 'utf8'));
const corrections = existsSync(CORRECTIONS) ? JSON.parse(readFileSync(CORRECTIONS, 'utf8')).orders : {};
const orders = readOrders(RAW);

console.log('═'.repeat(72));
console.log(`Mode: ${COMMIT ? 'COMMIT' : 'DRY RUN'}   source label: "${SOURCE_LABEL}"`);
console.log(`Orders in export: ${orders.length.toLocaleString('en-US')}`);
console.log(`collabBox corrections loaded: ${Object.keys(corrections).length.toLocaleString('en-US')}`);
console.log('═'.repeat(72));

const skipped = { test_order: 0, no_phone: 0, no_rate: 0 };
const statusCount = {};
const rows = [];

for (const o of orders) {
  if (isTestOrder(o)) { skipped.test_order++; continue; }

  const phone = normalizeMkPhone(o.phone);
  if (!phone) { skipped.no_phone++; continue; }

  const cur = String(o.currency || 'mkd').toLowerCase();
  const price = toEur(o.price, cur);
  if (price === null) { skipped.no_rate++; continue; }

  const rawProduct = productNameOf(o);
  const entry = map[rawProduct];
  const productName = entry ? (entry.crm || entry.create) : rawProduct;

  const corr = corrections[o.id];
  const status = corr ? corr.status : (PHASE_TO_STATUS[o.phase] || 'pending');
  statusCount[status] = (statusCount[status] || 0) + 1;

  // Provenance. Everything needed to trace a row back to AlterCPA — and, when
  // collabBox overrode the outcome, which document did it.
  const note = [
    String(o.comment || '').trim(),
    `AlterCPA #${o.id} · ${PHASE[o.phase] || o.phase}` +
      (o.reason ? ` (${REASON[o.reason] ?? `reason ${o.reason}`})` : '') +
      ` · offer "${rawProduct}" · ${Number(o.price).toLocaleString('en-US')} ${cur.toUpperCase()}`,
    EXACT_FX.has(cur) ? null
      : `⚠️ ${cur.toUpperCase()} converted at an approximate rate (÷ ${FX_TO_EUR[cur]}) — verify before using this figure.`,
    corr ? `Status corrected cancelled→paid from collabBox document ${corr.doc} (${corr.source}, tier ${corr.tier}).` : null,
  ].filter(Boolean).join(' | ');

  rows.push({
    external_order_id: String(o.id),
    order_date: isoDay(o.time),
    customer_name: String(o.name || '').trim().slice(0, 200),
    customer_phone: phone,
    product_name: productName.slice(0, 300),
    quantity: quantityOf(o),
    price,
    status,
    customer_city: String(o.city || '').trim().slice(0, 200),
    customer_address: String(o.addr || '').trim().slice(0, 600),
    postal_code: String(o.index || '').trim().slice(0, 30),
    note: note.slice(0, 2000),
  });
}

// Oldest first, so if the run is interrupted the CRM holds a complete prefix of
// history rather than a random scatter.
rows.sort((a, b) => a.order_date.localeCompare(b.order_date) || Number(a.external_order_id) - Number(b.external_order_id));

console.log(`\nrows ready       ${rows.length.toLocaleString('en-US')}`);
console.log(`skipped (test)   ${skipped.test_order}`);
console.log(`skipped (phone)  ${skipped.no_phone}`);
console.log(`skipped (no fx)  ${skipped.no_rate}`);
console.log(`\nstatus split:`);
for (const [s, n] of Object.entries(statusCount).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${s.padEnd(10)} ${n.toLocaleString('en-US').padStart(8)}`);
}
const corrected = rows.filter((r) => corrections[r.external_order_id]).length;
console.log(`\nof which corrected by collabBox: ${corrected.toLocaleString('en-US')}`);
console.log(`total value: €${rows.reduce((a, r) => a + r.price, 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`);

// ── resume ────────────────────────────────────────────────────────────────
// Resume from the DATABASE, not from a log file. A killed run can leave rows
// written but unlogged (or logged but rolled back), and the database is the
// only account of what is actually there. Re-posting a row is harmless anyway —
// the unique index turns it into a counted duplicate — so this is about not
// wasting hours, not about correctness.
let done = new Set();
if (RESUME) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: `select external_order_id from public.orders where external_source = '${SOURCE_LABEL}';` }),
  });
  if (!res.ok) { console.error(`Could not read existing ids: ${res.status} ${await res.text()}`); process.exit(1); }
  for (const r of await res.json()) done.add(String(r.external_order_id));
  console.log(`\nresuming — ${done.size.toLocaleString('en-US')} rows already in the CRM`);
}
let pending = done.size ? rows.filter((r) => !done.has(r.external_order_id)) : rows;
if (LIMIT) pending = pending.slice(0, LIMIT);
console.log(`still to post: ${pending.length.toLocaleString('en-US')}`);

writeFileSync(PAYLOAD_SAMPLE, JSON.stringify({
  source: SOURCE_LABEL, upsert_profiles: true, rows: pending.slice(0, 5),
}, null, 2), 'utf8');
console.log(`\nsample payload → ${PAYLOAD_SAMPLE}`);

if (!COMMIT) {
  console.log('\n' + '═'.repeat(72));
  console.log('DRY RUN — nothing written. Re-run with --commit.');
  console.log('═'.repeat(72));
  process.exit(0);
}

// ── commit ────────────────────────────────────────────────────────────────
if (!ADMIN_PASSWORD) {
  console.error('\nMK_ADMIN_PASSWORD is not set. The import endpoint is admin-only.');
  console.error('  MK_ADMIN_PASSWORD=… node scripts/import-altercpa-mk.mjs --commit');
  process.exit(1);
}

console.log('\nSigning in…');
const authRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
  method: 'POST',
  headers: { apikey: ANON, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
});
if (!authRes.ok) { console.error(`Sign-in failed: ${authRes.status} ${await authRes.text()}`); process.exit(1); }
const { access_token } = await authRes.json();
console.log(`Signed in as ${ADMIN_EMAIL}`);

const totals = { total: 0, created: 0, duplicates: 0, skipped_no_phone: 0, failed: 0 };
const started = Date.now();

// Each batch is ~50s of server work (200 inserts + order_items + notes +
// profile upserts), so a single serial stream runs at ~4 rows/s and 80k rows
// would take six hours. Batches are independent — every row carries its own
// globally unique AlterCPA id, and the unique index is the backstop — so they
// can run concurrently against separate edge-function instances. Batch size
// stays at 200: 1000 would fit the endpoint's cap but risks the function's
// wall-clock limit.
const batches = [];
for (let i = 0; i < pending.length; i += BATCH) batches.push(pending.slice(i, i + BATCH));

let next = 0, finished = 0;
async function worker() {
  while (true) {
    const idx = next++;
    if (idx >= batches.length) return;
    const slice = batches[idx];
    let res, body;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        res = await fetch(`${SUPABASE_URL}/functions/v1/api/orders/import`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${access_token}`, apikey: ANON, 'Content-Type': 'application/json' },
          body: JSON.stringify({ source: SOURCE_LABEL, upsert_profiles: true, rows: slice }),
        });
        body = await res.text();
        if (res.ok) break;
      } catch (e) { body = String(e); res = { ok: false, status: 0 }; }
      if (attempt < 3) await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
    if (!res?.ok) {
      console.error(`\n✗ batch ${idx} failed after retries: ${res?.status} ${String(body).slice(0, 300)}`);
      console.error('  Re-run with --commit --resume; it will pick up whatever is missing.');
      process.exit(1);
    }
    const r = JSON.parse(body);
    for (const k of Object.keys(totals)) totals[k] += r[k] || 0;
    appendFileSync(DONE_LOG, slice.map((s) => s.external_order_id).join('\n') + '\n', 'utf8');

    finished += slice.length;
    const rate = finished / ((Date.now() - started) / 1000);
    const eta = Math.round((pending.length - finished) / Math.max(rate, 0.01));
    process.stdout.write(`\r  ${((100 * finished) / pending.length).toFixed(1)}%  created ${totals.created.toLocaleString('en-US')}  dup ${totals.duplicates.toLocaleString('en-US')}  failed ${totals.failed}  ${rate.toFixed(1)}/s  eta ${Math.floor(eta / 60)}m${String(eta % 60).padStart(2, '0')}s   `);
  }
}
console.log(`Posting ${batches.length.toLocaleString('en-US')} batches of ${BATCH} across ${CONCURRENCY} workers…`);
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

console.log('\n\n' + '═'.repeat(72));
console.log('IMPORT COMPLETE');
for (const [k, v] of Object.entries(totals)) console.log(`  ${k.padEnd(18)} ${v.toLocaleString('en-US')}`);
console.log('═'.repeat(72));
console.log(`\nPosted ids logged to ${DONE_LOG}`);
console.log(`Now re-enable the trigger and rebuild the segments once:`);
console.log(`  node scripts/segment-trigger-mk.mjs --enable`);
console.log(`  node scripts/segment-trigger-mk.mjs --recompute`);
console.log(`  node scripts/engine-fixture-mk.mjs`);
