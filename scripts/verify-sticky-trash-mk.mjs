#!/usr/bin/env node
/**
 * Behavioural fixture for engine v3.7-mk (sticky trash) and the 14-day Current
 * Cancels return. Twin of scripts/engine-fixture-mk.mjs: it inserts throwaway
 * orders on reserved fixture phones, recomputes, asserts the resulting list
 * membership, and deletes everything again in a finally block.
 *
 *   node scripts/verify-sticky-trash-mk.mjs
 *
 * Run it after ANY change to the segment engine. The rules it pins are operator
 * decisions, not implementation details — if a case here fails, the engine no
 * longer does what Macedonia asked for.
 *
 * Reserved phones: +38971000101 … +38971000108. Nothing else may use them.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const REF = 'oufoazmnbwugtfldkwsn';

const toml = readFileSync(join(root, 'supabase', 'config.toml'), 'utf8');
if (toml.match(/^\s*project_id\s*=\s*"([^"]+)"/m)?.[1] !== REF) {
  console.error('config.toml does not point at Macedonia — refusing to run.');
  process.exit(1);
}
const env = {};
for (const line of readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/)) {
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
  return JSON.parse(t);
}

// Each case: orders to plant, then the lists the phone must / must not be in.
// `paid 30d ago, €20, 2 lifetime` is the baseline band: 21d ≤26 (1-3 orders).
const BAND = '21d ≤26 (1-3 orders)';
const CASES = [
  {
    name: 'cancel < 14d → parked in Current Cancels',
    phone: '+38971000101',
    orders: [
      `('paid',      20, now() - interval '200 days', null)`,
      `('cancelled', 20, now() - interval '3 days',   null)`,
    ],
    expect: ['Current Cancels'],
    reject: [BAND],
  },
  {
    name: 'cancel > 14d → back to the band from last paid date + order count',
    phone: '+38971000102',
    orders: [
      `('paid',      20, now() - interval '200 days', null)`,
      `('paid',      20, now() - interval '30 days',  null)`,
      `('cancelled', 20, now() - interval '20 days',  null)`,
    ],
    expect: [BAND],
    reject: ['Current Cancels'],
  },
  {
    name: "trash 'rude' → out of every calling band, into Trash List",
    phone: '+38971000103',
    orders: [
      `('paid',    20, now() - interval '200 days', null)`,
      `('paid',    20, now() - interval '30 days',  null)`,
      `('trashed', 20, now() - interval '10 days',  'rude')`,
    ],
    expect: ['Trash List'],
    reject: [BAND, 'Current Cancels'],
  },
  {
    name: 'a later PENDING lead does NOT release a trash (sticky)',
    phone: '+38971000104',
    orders: [
      `('paid',    20, now() - interval '200 days', null)`,
      `('paid',    20, now() - interval '30 days',  null)`,
      `('trashed', 20, now() - interval '10 days',  'rude')`,
      `('pending', 20, now() - interval '1 day',    null)`,
    ],
    expect: ['Trash List'],
    reject: [BAND],
  },
  {
    name: 'a later PAID order DOES release a trash (money wins)',
    phone: '+38971000105',
    orders: [
      `('paid',    20, now() - interval '200 days', null)`,
      `('trashed', 20, now() - interval '40 days',  'wrong_person')`,
      `('paid',    20, now() - interval '30 days',  null)`,
    ],
    expect: [BAND],
    reject: ['Trash List'],
  },
  {
    name: "'duplicate_order' is housekeeping — stays callable, never in Trash List",
    phone: '+38971000106',
    orders: [
      `('paid',    20, now() - interval '200 days', null)`,
      `('paid',    20, now() - interval '30 days',  null)`,
      `('trashed', 20, now() - interval '10 days',  'duplicate_order')`,
    ],
    expect: [BAND],
    reject: ['Trash List'],
  },
  {
    name: "'not_reachable' < 21d → parked in Trash List",
    phone: '+38971000107',
    orders: [
      `('paid',    20, now() - interval '200 days', null)`,
      `('paid',    20, now() - interval '30 days',  null)`,
      `('trashed', 20, now() - interval '5 days',   'not_reachable')`,
    ],
    expect: ['Trash List'],
    reject: [BAND],
  },
  {
    name: "'not_reachable' > 21d → released back into the band",
    phone: '+38971000108',
    orders: [
      `('paid',    20, now() - interval '200 days', null)`,
      `('paid',    20, now() - interval '30 days',  null)`,
      `('trashed', 20, now() - interval '25 days',  'not_reachable')`,
    ],
    expect: [BAND],
    reject: ['Trash List'],
  },
];

const phones = CASES.map((c) => `'${c.phone}'`).join(',');
const before = (await sql('select count(*)::int n from public.orders;'))[0].n;
let failures = 0;

// Start from a clean slate in case an earlier run died mid-way.
await sql(`delete from public.orders where customer_phone in (${phones});`);

try {
  for (const c of CASES) {
    const tag = c.phone.slice(-4);
    const values = c.orders
      .map((o, i) => {
        const [, status, price, created, reason] =
          o.match(/^\('([a-z_]+)',\s*(\d+),\s*(.+?),\s*(null|'[a-z_]+')\)$/);
        // trashed_at must be explicit: the BEFORE trigger only stamps now(), and
        // these fixtures need historical trash instants.
        const trashedAt = status === 'trashed' ? created : 'null';
        const paidAt = status === 'paid' ? created : 'null';
        return `('FIXS-${tag}-${i}', 'Fixture', 'Sticky Fixture', '${c.phone}', '${status}', ${price}, ${created}, ${paidAt}, ${trashedAt}, ${reason})`;
      })
      .join(',\n        ');

    await sql(`
      insert into public.orders
        (display_id, product_name, customer_name, customer_phone, status, price, created_at, paid_at, trashed_at, trash_reason)
      values
        ${values};`);

    await sql(`select public.recompute_customer_segments('${c.phone}');`);

    const rows = await sql(`
      select l.name from public.prediction_segment_members m
        join public.prediction_segment_lists l on l.id = m.list_id
       where m.customer_phone = '${c.phone}';`);
    const got = rows.map((r) => r.name);

    const missing = c.expect.filter((e) => !got.includes(e));
    const present = c.reject.filter((r) => got.includes(r));
    const pass = missing.length === 0 && present.length === 0;
    if (!pass) failures++;

    console.log(`${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${c.name}`);
    console.log(`    got: ${JSON.stringify(got)}`);
    if (missing.length) console.log(`    \x1b[31mmissing: ${JSON.stringify(missing)}\x1b[0m`);
    if (present.length) console.log(`    \x1b[31mshould not be in: ${JSON.stringify(present)}\x1b[0m`);
  }
} finally {
  await sql(`delete from public.prediction_segment_members where customer_phone in (${phones});`);
  await sql(`delete from public.prediction_segment_members_shadow where customer_phone in (${phones});`);
  await sql(`delete from public.orders where customer_phone in (${phones});`);
  const after = (await sql('select count(*)::int n from public.orders;'))[0].n;
  if (after !== before) {
    console.error(`\x1b[31m✗ cleanup left ${after - before} extra orders\x1b[0m`);
    failures++;
  } else {
    console.log(`\n· cleaned up (orders back to ${after})`);
  }
}

if (failures) {
  console.error(`\n\x1b[31m${failures} case(s) FAILED — the engine no longer matches the operator rules.\x1b[0m`);
  process.exit(1);
}
console.log('\x1b[32mSticky trash + 14-day cancel return: all rules hold.\x1b[0m');
