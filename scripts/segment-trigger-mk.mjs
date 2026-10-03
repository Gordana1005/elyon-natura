#!/usr/bin/env node
/**
 * Put orders into (and out of) bulk-load mode.
 *
 *   node scripts/segment-trigger-mk.mjs --status
 *   node scripts/segment-trigger-mk.mjs --disable
 *   node scripts/segment-trigger-mk.mjs --enable
 *   node scripts/segment-trigger-mk.mjs --recompute
 *   node scripts/segment-trigger-mk.mjs --backfill-timestamps
 *
 * Two groups of row triggers make a large historical import go wrong:
 *
 * SEGMENTS — trg_orders_segments_insert fires FOR EACH ROW and recomputes that
 *   customer's entire band membership from their whole order history. Across
 *   80k inserts that is 80k recomputes, and every one but the last per phone is
 *   immediately thrown away. Disable, load, re-enable, then recompute once.
 *
 * TIMESTAMPS — orders_set_paid_at / _cancelled_at / _returned_at / _shipped_at
 *   stamp now() on INSERT when the column is NULL. They exist so live status
 *   changes are recorded, but on a history import they would date all 27k paid
 *   orders and 35k cancellations to the day of the import. Every time-series
 *   report — revenue by month, the Paid tab, cancellation trends — would show
 *   one enormous spike today and nothing before it. So they are disabled for
 *   the load and the real times are backfilled afterwards from AlterCPA's own
 *   `done` timestamp, which is when the order actually reached its outcome.
 *
 * ⚠️ Leaving any of these disabled is a silent bug: the CRM keeps working and
 * quietly stops recording. --status is loud about it.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readOrders, PHASE_TO_STATUS } from './lib/altercpa.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REF = 'oufoazmnbwugtfldkwsn';
const SOURCE_LABEL = 'altercpa';

const GROUPS = {
  segments: ['trg_orders_segments_insert', 'trg_orders_segments_status'],
  timestamps: ['trg_orders_set_paid_at', 'trg_orders_set_cancelled_at',
    'trg_orders_set_returned_at', 'trg_orders_set_shipped_at'],
};
const ALL = [...GROUPS.segments, ...GROUPS.timestamps];

const toml = readFileSync(join(ROOT, 'supabase', 'config.toml'), 'utf8');
if (toml.match(/^\s*project_id\s*=\s*"([^"]+)"/m)?.[1] !== REF) {
  console.error('config.toml does not point at Macedonia — refusing to run.');
  process.exit(1);
}
const env = {};
for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
  if (m) env[m[1]] = m[2];
}

async function sql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const t = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${t}`);
  return t ? JSON.parse(t) : [];
}

async function status() {
  const rows = await sql(`select tgname, tgenabled from pg_trigger
    where tgrelid = 'public.orders'::regclass and tgname in (${ALL.map((t) => `'${t}'`).join(',')})
    order by tgname;`);
  const off = [];
  for (const [group, names] of Object.entries(GROUPS)) {
    console.log(`  ${group}:`);
    for (const n of names) {
      const r = rows.find((x) => x.tgname === n);
      const on = r?.tgenabled === 'O';
      if (!r) { console.log(`    \x1b[33mMISSING \x1b[0m ${n}`); continue; }
      if (!on) off.push(n);
      console.log(`    ${on ? '\x1b[32mENABLED \x1b[0m' : '\x1b[31mDISABLED\x1b[0m'} ${n}`);
    }
  }
  if (off.length) {
    console.log(`\n\x1b[31m⚠️  ${off.length} trigger(s) DISABLED\x1b[0m — the CRM is in bulk-load mode and is`);
    console.log('   silently not recording. Finish with:');
    console.log('     node scripts/segment-trigger-mk.mjs --backfill-timestamps');
    console.log('     node scripts/segment-trigger-mk.mjs --enable');
    console.log('     node scripts/segment-trigger-mk.mjs --recompute');
  }
  return off.length === 0;
}

const arg = process.argv[2];

if (arg === '--disable') {
  for (const t of ALL) await sql(`alter table public.orders disable trigger ${t};`);
  console.log('Bulk-load mode ON.\n');
  await status();
} else if (arg === '--enable') {
  for (const t of ALL) await sql(`alter table public.orders enable trigger ${t};`);
  console.log('Bulk-load mode OFF.\n');
  await status();
} else if (arg === '--recompute') {
  console.log('Trigger state:');
  if (!(await status())) {
    console.error('\nRefusing to recompute while a trigger is disabled — enable it first,');
    console.error('or any order written during the rebuild would be missed.');
    process.exit(1);
  }
  // recompute_all_segments() loops over every distinct phone inside a single
  // statement. At 47k customers that blows the Management API's statement
  // timeout and the whole transaction rolls back — hours of work, zero rows.
  // So drive the per-customer function in chunks instead: each chunk is its own
  // transaction, and a timeout costs one chunk rather than everything.
  const CHUNK = 1500;
  const phones = (await sql(
    `select distinct customer_phone from public.orders where customer_phone <> '' order by 1;`
  )).map((r) => r.customer_phone);
  console.log(`\nRecomputing ${phones.length.toLocaleString('en-US')} customers in chunks of ${CHUNK}…`);
  const t0 = Date.now();
  for (let i = 0; i < phones.length; i += CHUNK) {
    const chunk = phones.slice(i, i + CHUNK).map((p) => `('${p.replace(/'/g, "''")}')`).join(',');
    await sql(`select public.recompute_customer_segments(v.phone) from (values ${chunk}) as v(phone);`);
    const pct = ((100 * Math.min(i + CHUNK, phones.length)) / phones.length).toFixed(1);
    const rate = Math.min(i + CHUNK, phones.length) / ((Date.now() - t0) / 1000);
    process.stdout.write(`\r  ${pct}%  ${rate.toFixed(0)} customers/s  eta ${Math.round((phones.length - i - CHUNK) / Math.max(rate, 0.01))}s      `);
  }
  const [{ n }] = await sql('select count(*)::int n from public.prediction_segment_members;');
  console.log(`\n✓ ${phones.length.toLocaleString('en-US')} customers recomputed in ${Math.round((Date.now() - t0) / 1000)}s → ${n.toLocaleString('en-US')} list memberships`);
} else if (arg === '--backfill-timestamps') {
  // AlterCPA's `done` is when the order reached its final outcome — the real
  // paid/cancelled moment. Fall back to the creation time when it is absent.
  const orders = readOrders(join(ROOT, 'scripts', 'data', 'altercpa-mk-raw.jsonl'));
  // The collabBox corrections have to be applied here too. Those orders are
  // `cancelled` in AlterCPA but `paid` in the CRM, so keying the column off the
  // raw phase would stamp cancelled_at on a paid order and leave paid_at null —
  // which silently drops them out of every revenue report windowed on paid_at.
  const corrections = JSON.parse(
    readFileSync(join(ROOT, 'scripts', 'data', 'collabbox-corrections.json'), 'utf8')).orders;
  const COL = { paid: 'paid_at', cancelled: 'cancelled_at', returned: 'returned_at' };
  const byCol = { paid_at: [], cancelled_at: [], returned_at: [] };
  for (const o of orders) {
    const status = corrections[o.id]?.status || PHASE_TO_STATUS[o.phase];
    const col = COL[status];
    if (!col) continue;
    const at = new Date((Number(o.done) || Number(o.time)) * 1000).toISOString();
    byCol[col].push([String(o.id), at]);
  }
  // A row that is paid must not still carry the cancellation stamp it got from
  // its AlterCPA outcome.
  const cleared = await sql(`update public.orders set cancelled_at = null
    where external_source = '${SOURCE_LABEL}' and status = 'paid' and cancelled_at is not null
    returning 1;`);
  if (cleared.length) console.log(`cleared cancelled_at on ${cleared.length.toLocaleString('en-US')} corrected (now paid) orders`);
  for (const [col, pairs] of Object.entries(byCol)) {
    if (!pairs.length) continue;
    console.log(`${col}: ${pairs.length.toLocaleString('en-US')} rows`);
    const CHUNK = 2000;
    let done = 0;
    for (let i = 0; i < pairs.length; i += CHUNK) {
      const vs = pairs.slice(i, i + CHUNK)
        .map(([id, at]) => `('${id}','${at}'::timestamptz)`).join(',');
      const out = await sql(`update public.orders o set ${col} = v.at
        from (values ${vs}) as v(ext, at)
        where o.external_source = '${SOURCE_LABEL}' and o.external_order_id = v.ext
        returning 1;`);
      done += out.length;
      process.stdout.write(`\r  updated ${done.toLocaleString('en-US')}   `);
    }
    console.log();
  }
  const check = await sql(`select status::text, count(*)::int as n,
      min(coalesce(paid_at, cancelled_at, returned_at))::date as earliest,
      max(coalesce(paid_at, cancelled_at, returned_at))::date as latest
    from public.orders where external_source = '${SOURCE_LABEL}'
    group by 1 order by 2 desc;`);
  console.log('\nOutcome timestamps now span:');
  for (const r of check) console.log(`  ${r.status.padEnd(10)} ${String(r.n).padStart(7)}   ${r.earliest} → ${r.latest}`);
} else {
  console.log('Trigger state:');
  await status();
}
