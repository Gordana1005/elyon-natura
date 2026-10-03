#!/usr/bin/env node
/**
 * Prove the bridge did not silently lose anything — READ ONLY.
 *
 *   node scripts/verify-altercpa-bridge.mjs 2026-08-01 2026-08-07
 *   node scripts/verify-altercpa-bridge.mjs --days 7
 *
 * Compares THREE id sets over the same window and fails on any mismatch:
 *
 *   A. what AlterCPA's comp/list.json returns
 *   B. what public.altercpa_leads holds        → must EQUAL A
 *   C. what public.orders holds for the callable geos, keyed on
 *      (external_source='altercpa', external_order_id)
 *                                              → must EQUAL the callable,
 *                                                non-skipped subset of B
 *
 * ── Why this and not "the run log said ok" ─────────────────────────────────
 * A sync that truncates silently reports success. AlterCPA answers an oversized
 * window with an error OBJECT rather than an array, and any code that only
 * checks Array.isArray reads that as end-of-stream — the exact trap the 2026-08
 * history export was written to survive. The run log records what the sync
 * BELIEVED it saw; only re-fetching independently can show what it missed.
 *
 * Nothing is written. No AlterCPA write endpoint is referenced.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REF = 'oufoazmnbwugtfldkwsn';                       // MACEDONIA. never change.
const ENDPOINT_PATH = '/comp/list.json';                  // read-only. never change.

const env = {};
for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*?)"?\s*$/);
  if (m) env[m[1]] = m[2];
}
if (env.VITE_SUPABASE_PROJECT_ID && env.VITE_SUPABASE_PROJECT_ID !== REF) {
  console.error(`.env points at ${env.VITE_SUPABASE_PROJECT_ID}, not Macedonia. Refusing to run.`);
  process.exit(1);
}

const API_KEY = process.env.ALTERCPA_API_KEY || env.ALTERCPA_API_KEY;
if (!API_KEY) {
  console.error('Missing ALTERCPA_API_KEY (env or .env). See docs/VAULT.md §2.');
  process.exit(1);
}

const args = process.argv.slice(2);
const argVal = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

const days = Number(argVal('--days'));
const positional = args.filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
let fromSec, toSec;
if (positional.length === 2) {
  fromSec = Math.floor(Date.parse(positional[0] + 'T00:00:00Z') / 1000);
  toSec = Math.floor(Date.parse(positional[1] + 'T23:59:59Z') / 1000);
} else {
  const d = Number.isFinite(days) && days > 0 ? days : 7;
  toSec = Math.floor(Date.now() / 1000);
  fromSec = toSec - d * 86400;
}
const iso = (s) => new Date(s * 1000).toISOString();

async function sql(query) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${t}`);
  return JSON.parse(t);
}

/** Same contract as the sync: a non-array body is a HARD failure, and an
 *  oversized window is halved rather than accepted as empty. */
async function fetchWindow(base, from, to, depth = 0) {
  const url = `${base}${ENDPOINT_PATH}?id=${encodeURIComponent(API_KEY)}&from=${from}&to=${to}`;
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'Accept-Encoding': 'gzip' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      let body;
      try { body = JSON.parse(text); } catch { throw new Error(`unparseable (${text.slice(0, 120)})`); }
      if (!Array.isArray(body)) throw new Error(`non-array body: ${JSON.stringify(body).slice(0, 200)}`);
      return body;
    } catch (e) {
      lastErr = e;
      if (attempt < 3) await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  if (depth < 4 && to - from > 86400) {
    const mid = Math.floor((from + to) / 2);
    const a = await fetchWindow(base, from, mid, depth + 1);
    const b = await fetchWindow(base, mid + 1, to, depth + 1);
    return a.concat(b);
  }
  throw new Error(`window ${from}..${to} failed: ${lastErr.message}`);
}

// ── who are we checking ─────────────────────────────────────────────────────
const accounts = await sql(`select id, name, api_base, callable_geos, sync_from from public.altercpa_accounts where is_active order by name;`);
if (!accounts.length) {
  console.error('No active altercpa_accounts row. Nothing to verify.');
  process.exit(1);
}

console.log('═'.repeat(76));
console.log('AlterCPA bridge reconciliation — READ ONLY');
console.log(`Window: ${iso(fromSec)} → ${iso(toSec)}`);
console.log('═'.repeat(76));

let failed = false;

for (const acc of accounts) {
  const callable = new Set((acc.callable_geos || []).map((g) => String(g).toUpperCase()));
  console.log(`\n── ${acc.name}  (callable: ${[...callable].join(', ') || 'none'}) ──`);

  // The bridge is not responsible for anything created before sync_from — that
  // period belongs to the 2026-08 history import. Comparing against it reports
  // a failure for orders the bridge was correctly told to ignore, and a check
  // that cries wolf stops being read.
  let accFrom = fromSec;
  if (acc.sync_from) {
    const floor = Math.floor(new Date(acc.sync_from).getTime() / 1000);
    if (floor > accFrom) {
      console.log(`  window clamped to sync_from ${acc.sync_from} (was ${iso(fromSec).slice(0, 10)})`);
      accFrom = floor;
    }
  }
  if (accFrom >= toSec) { console.log('  window is entirely before sync_from — nothing to check.'); continue; }

  // A. the API
  process.stdout.write('  fetching from AlterCPA… ');
  const rows = await fetchWindow(String(acc.api_base).replace(/\/+$/, ''), accFrom, toSec);
  const apiIds = new Set(rows.map((o) => String(o.id)));
  console.log(`${apiIds.size} distinct ids`);

  // B. the ledger
  const ledger = await sql(`
    select altercpa_id, geo, skip_reason, order_id
    from public.altercpa_leads
    where account_id = '${acc.id}'
      and created_remote >= '${iso(accFrom)}'
      and created_remote <= '${iso(toSec)}';`);
  const ledgerIds = new Set(ledger.map((r) => r.altercpa_id));

  const missingFromLedger = [...apiIds].filter((id) => !ledgerIds.has(id));
  const extraInLedger = [...ledgerIds].filter((id) => !apiIds.has(id));

  console.log(`  ledger: ${ledgerIds.size} rows`);
  if (missingFromLedger.length) {
    failed = true;
    console.log(`  ✗ ${missingFromLedger.length} ids on the API are NOT in the ledger`);
    console.log(`      e.g. ${missingFromLedger.slice(0, 10).join(', ')}`);
    console.log('      → the sync missed these. Re-run a backfill over this window.');
  } else {
    console.log('  ✓ every API id is in the ledger');
  }
  if (extraInLedger.length) {
    // Not necessarily a fault: an order deleted on their side stays in our
    // ledger on purpose. Reported, never treated as success-or-failure.
    console.log(`  ⓘ ${extraInLedger.length} ledger ids are no longer returned by the API`);
    console.log('      (deleted or merged upstream — we keep our copy deliberately)');
  }

  // C. the orders
  const expectPromoted = ledger.filter((r) => !r.skip_reason);
  const orderRows = await sql(`
    select external_order_id from public.orders
    where external_source = 'altercpa'
      and external_order_id in (${expectPromoted.length
        ? expectPromoted.map((r) => `'${String(r.altercpa_id).replace(/'/g, "''")}'`).join(',')
        : `''`});`);
  const orderIds = new Set(orderRows.map((r) => r.external_order_id));
  const notPromoted = expectPromoted.filter((r) => !orderIds.has(r.altercpa_id));

  console.log(`  callable & promotable: ${expectPromoted.length}   in orders: ${orderIds.size}`);
  if (notPromoted.length) {
    failed = true;
    console.log(`  ✗ ${notPromoted.length} leads are marked promotable but have no order`);
    console.log(`      e.g. ${notPromoted.slice(0, 10).map((r) => r.altercpa_id).join(', ')}`);
  } else {
    console.log('  ✓ every promotable lead has its order');
  }

  // D. containment — the promise that foreign traffic never becomes an order.
  const leaked = await sql(`
    select l.altercpa_id, l.geo
    from public.altercpa_leads l
    join public.orders o
      on o.external_source = 'altercpa' and o.external_order_id = l.altercpa_id
    where l.account_id = '${acc.id}'
      and l.skip_reason = 'geo_not_callable'
    limit 20;`);
  if (leaked.length) {
    failed = true;
    console.log(`  ✗ CONTAINMENT BREACH: ${leaked.length}+ non-callable leads have orders`);
    for (const r of leaked.slice(0, 5)) console.log(`      ${r.altercpa_id} (${r.geo})`);
  } else {
    console.log('  ✓ no non-callable geo has leaked into orders');
  }

  // E. per-geo shape, so a country that suddenly stopped arriving is visible.
  const byGeo = {};
  for (const o of rows) {
    const g = String(o.country || '??').toUpperCase();
    byGeo[g] = (byGeo[g] || 0) + 1;
  }
  const shape = Object.entries(byGeo).sort((a, b) => b[1] - a[1])
    .map(([g, n]) => `${g}:${n}${callable.has(g) ? '*' : ''}`).join('  ');
  console.log(`  geos in window: ${shape || '—'}   (* = callable)`);
}

console.log('\n' + '═'.repeat(76));
if (failed) {
  console.log('✗ RECONCILIATION FAILED — see the ✗ lines above.');
  process.exit(1);
}
console.log('✓ RECONCILIATION OK — API, ledger and orders agree over this window.');
console.log('Nothing was written. This check is read-only.');
