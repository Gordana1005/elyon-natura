#!/usr/bin/env node
/**
 * Post-import verification for the AlterCPA Macedonian history.
 *
 *   node scripts/verify-altercpa-import.mjs
 *
 * Checks the things that would be expensive to discover later:
 *   - every exported order arrived, and nothing arrived twice
 *   - the denar a customer sees equals the denar they were originally charged
 *     (a 61x currency slip is the classic failure here, and it is silent)
 *   - products are linked, not left as loose text
 *   - outcome timestamps span real history rather than all landing on today
 *   - the collabBox corrections are actually on the rows they were meant for
 *   - no imported order is credited to a live agent (they must earn no bonus)
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readOrders, isTestOrder, normalizeMkPhone, toEur, MKD_PER_EUR } from './lib/altercpa.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REF = 'oufoazmnbwugtfldkwsn';
const SOURCE = 'altercpa';

const env = {};
for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
  if (m) env[m[1]] = m[2];
}
const sql = async (query) => {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const t = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${t}`);
  return t ? JSON.parse(t) : [];
};

let failures = 0;
const pass = (m) => console.log(`\x1b[32m  ✓\x1b[0m ${m}`);
const fail = (m) => { failures++; console.log(`\x1b[31m  ✗\x1b[0m ${m}`); };
const info = (m) => console.log(`    ${m}`);
const head = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`);

// ── what we expected to send ──────────────────────────────────────────────
const exported = readOrders(join(ROOT, 'scripts', 'data', 'altercpa-mk-raw.jsonl'));
const corrections = JSON.parse(readFileSync(join(ROOT, 'scripts', 'data', 'collabbox-corrections.json'), 'utf8')).orders;
const expected = exported.filter((o) => !isTestOrder(o) && normalizeMkPhone(o.phone) && toEur(o.price, o.currency) !== null);

head('1. Row count');
const [{ n: total, distinct }] = await sql(
  `select count(*)::int n, count(distinct external_order_id)::int distinct from public.orders where external_source = '${SOURCE}';`);
if (total === expected.length) pass(`${total.toLocaleString('en-US')} orders — matches the ${expected.length.toLocaleString('en-US')} rows the export should yield`);
else fail(`${total.toLocaleString('en-US')} in the CRM vs ${expected.length.toLocaleString('en-US')} expected (difference ${(expected.length - total).toLocaleString('en-US')})`);
if (total === distinct) pass('no duplicate external_order_id');
else fail(`${(total - distinct).toLocaleString('en-US')} duplicate external_order_ids`);

head('2. Statuses');
const statuses = await sql(`select status::text, count(*)::int n from public.orders where external_source='${SOURCE}' group by 1 order by 2 desc;`);
const want = {};
for (const o of expected) {
  const s = corrections[o.id] ? 'paid' : ({ 3: 'paid', 4: 'cancelled', 5: 'trashed' }[o.phase] || 'pending');
  want[s] = (want[s] || 0) + 1;
}
for (const r of statuses) {
  if (want[r.status] === r.n) pass(`${r.status.padEnd(10)} ${r.n.toLocaleString('en-US')}`);
  else fail(`${r.status.padEnd(10)} ${r.n.toLocaleString('en-US')} in the CRM vs ${(want[r.status] || 0).toLocaleString('en-US')} expected`);
}

head('3. Currency — the denar shown must equal the denar charged');
// Every price the CRM renders is eurToDen(price) = round(eur * 61.5). Compare
// that against the original AlterCPA denar figure, order by order.
const sample = await sql(`select external_order_id, price::float8 price from public.orders
  where external_source='${SOURCE}' order by random() limit 4000;`);
const byId = new Map(exported.map((o) => [String(o.id), o]));
let mism = 0; const worst = [];
for (const r of sample) {
  const o = byId.get(String(r.external_order_id));
  if (!o || String(o.currency).toLowerCase() !== 'mkd') continue;
  const shown = Math.round(r.price * MKD_PER_EUR);
  if (shown !== Math.round(Number(o.price))) {
    mism++;
    if (worst.length < 5) worst.push(`#${o.id}: charged ${o.price} ден, CRM shows ${shown} ден`);
  }
}
if (!mism) pass(`${sample.length.toLocaleString('en-US')} sampled orders all round-trip to the exact denar originally charged`);
else { fail(`${mism} of ${sample.length} orders display a different denar than was charged`); worst.forEach(info); }

head('4. Product links');
const [{ linked, unlinked }] = await sql(`select
  sum((product_id is not null)::int)::int linked, sum((product_id is null)::int)::int unlinked
  from public.orders where external_source='${SOURCE}';`);
if (!unlinked) pass(`all ${linked.toLocaleString('en-US')} orders link to a catalogue product`);
else fail(`${unlinked.toLocaleString('en-US')} orders have no product link`);
const [{ items }] = await sql(`select count(*)::int items from order_items i join orders o on o.id=i.order_id where o.external_source='${SOURCE}';`);
if (items === total) pass(`${items.toLocaleString('en-US')} order_items rows — one per order`);
else fail(`${items.toLocaleString('en-US')} order_items for ${total.toLocaleString('en-US')} orders`);

head('5. Outcome timestamps span real history');
const spans = await sql(`select status::text,
    min(coalesce(paid_at, cancelled_at, returned_at))::date earliest,
    max(coalesce(paid_at, cancelled_at, returned_at))::date latest,
    count(*) filter (where coalesce(paid_at, cancelled_at, returned_at) is null)::int missing
  from public.orders where external_source='${SOURCE}' and status in ('paid','cancelled','returned') group by 1;`);
for (const r of spans) {
  if (r.earliest && r.earliest < '2025-06-01') pass(`${r.status.padEnd(10)} ${r.earliest} → ${r.latest}${r.missing ? `  (${r.missing} without a timestamp)` : ''}`);
  else fail(`${r.status.padEnd(10)} starts at ${r.earliest} — timestamps look stamped at import time, not backfilled`);
}

head('6. collabBox corrections landed');
const expectedIds = new Set(expected.map((o) => String(o.id)));
// Only corrections whose order actually survived the phone/test filters can be
// expected in the CRM — the rest were never sent.
const ids = Object.keys(corrections).filter((i) => expectedIds.has(i));
const [{ n: paidCorr }] = await sql(`select count(*)::int n from public.orders
  where external_source='${SOURCE}' and status='paid' and external_order_id in (${ids.map((i) => `'${i}'`).join(',')});`);
const inScope = ids.length;
if (paidCorr === inScope) pass(`all ${paidCorr.toLocaleString('en-US')} checked corrections are marked paid`);
else fail(`${paidCorr.toLocaleString('en-US')} of ${inScope.toLocaleString('en-US')} corrections are paid`);
const [{ n: noted }] = await sql(`select count(*)::int n from order_notes n join orders o on o.id=n.order_id
  where o.external_source='${SOURCE}' and n.text like '%Status corrected cancelled%';`);
if (noted > 0) pass(`${noted.toLocaleString('en-US')} orders carry the correction provenance in their note`);
else fail('no correction provenance found in order notes');

head('7. No agent earns commission on imported history');
const [{ n: attributed }] = await sql(`select count(*)::int n from public.orders
  where external_source='${SOURCE}' and (confirmed_by_agent_id is not null or assigned_agent_id is not null);`);
if (!attributed) pass('no imported order is attributed to a real agent — payouts unaffected');
else fail(`${attributed.toLocaleString('en-US')} imported orders are credited to an agent and would generate a bonus`);

head('8. Customers and prediction lists');
const [{ phones, profiles }] = await sql(`select
  (select count(distinct customer_phone)::int from public.orders where external_source='${SOURCE}') phones,
  (select count(*)::int from public.customer_profiles) profiles;`);
info(`${phones.toLocaleString('en-US')} distinct customers · ${profiles.toLocaleString('en-US')} customer_profiles`);
const lists = await sql(`select l.name, count(m.*)::int n from prediction_segment_lists l
  left join prediction_segment_members m on m.list_id = l.id group by 1 having count(m.*) > 0 order by 2 desc limit 12;`);
if (lists.length) { pass(`${lists.length} prediction lists have members`); for (const l of lists) info(`${String(l.n).padStart(7)}  ${l.name}`); }
else fail('every prediction list is empty — recompute_all_segments() has not run');

console.log('\n' + '═'.repeat(64));
console.log(failures ? `\x1b[31m${failures} check(s) FAILED\x1b[0m` : '\x1b[32mAll checks passed.\x1b[0m');
process.exit(failures ? 1 : 0);
