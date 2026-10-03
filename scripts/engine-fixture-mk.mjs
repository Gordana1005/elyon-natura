#!/usr/bin/env node
/**
 * Segment-engine regression fixture.
 *
 * The engine resolves its target list by EXACT NAME match:
 *     select id from prediction_segment_lists where name = v_target_list_name ...
 * and it deletes the customer's existing rule-list memberships BEFORE resolving.
 * So if a list name ever drifts, the engine silently removes members and inserts
 * nothing — a mass wipe with no error. This fixture proves the contract holds.
 *
 * Run after EVERY migration bundle.
 *
 *   node scripts/engine-fixture-mk.mjs
 *
 * Synthesises two throwaway customers, recomputes, asserts the resolved list,
 * then deletes them and verifies the tables are back to their prior counts.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// The target comes from scripts/lib/target.mjs (03.10.2026): config.toml, or ELYON_TARGET_REF during the move
// to the new project; the token follows the target. Bulgaria and retired refs are refused there.
import { REF, TARGET, accessToken } from './lib/target.mjs';

const toml = readFileSync(join(root, 'supabase', 'config.toml'), 'utf8');
if (toml.match(/^\s*project_id\s*=\s*"([^"]+)"/m)?.[1] !== REF && !TARGET.overridden) {
  console.error('config.toml does not point at Macedonia'); process.exit(1);
}
const token = accessToken();

async function sql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const t = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${t}`);
  try { return JSON.parse(t); } catch { return t; }
}

// price → expected list. 30 days since last paid = the "21d" recency band
// (21-57d); 2 lifetime paid orders = the "(1-3 orders)" frequency bucket.
const CASES = [
  { phone: '+38971000001', price: 20, expect: '21d ≤26 (1-3 orders)' },
  { phone: '+38971000002', price: 40, expect: '21d 26+ (1-3 orders)' },
];

const before = (await sql('select count(*)::int n from public.orders;'))[0].n;
let failures = 0;

try {
  for (const c of CASES) {
    await sql(`
      insert into public.orders (display_id, product_name, customer_name, customer_phone, status, price, created_at, paid_at)
      values
        ('FIXT-${c.phone.slice(-4)}-A', 'Fixture', 'Fixture Case', '${c.phone}', 'paid', ${c.price}, now() - interval '200 days', now() - interval '200 days'),
        ('FIXT-${c.phone.slice(-4)}-B', 'Fixture', 'Fixture Case', '${c.phone}', 'paid', ${c.price}, now() - interval '30 days',  now() - interval '30 days');`);

    await sql(`select public.recompute_customer_segments('${c.phone}');`);

    const rows = await sql(`
      select l.name
        from public.prediction_segment_members m
        join public.prediction_segment_lists l on l.id = m.list_id
       where m.customer_phone = '${c.phone}';`);

    const got = rows.map((r) => r.name);
    const pass = got.includes(c.expect);
    if (!pass) failures++;
    console.log(
      `${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} €${c.price} → ${JSON.stringify(got)}` +
      (pass ? '' : `\n    expected to include: ${JSON.stringify(c.expect)}`),
    );
  }
} finally {
  const phones = CASES.map((c) => `'${c.phone}'`).join(',');
  await sql(`delete from public.prediction_segment_members where customer_phone in (${phones});`);
  await sql(`delete from public.prediction_segment_members_shadow where customer_phone in (${phones});`);
  await sql(`delete from public.orders where customer_phone in (${phones});`);
  const after = (await sql('select count(*)::int n from public.orders;'))[0].n;
  if (after !== before) { console.error(`\x1b[31m✗ cleanup left ${after - before} extra orders\x1b[0m`); failures++; }
  else console.log(`· cleaned up (orders back to ${after})`);
}

if (failures) { console.error(`\n\x1b[31m${failures} FAILURE(S) — the engine⇄list-name contract is broken. Stop.\x1b[0m`); process.exit(1); }
console.log('\n\x1b[32mEngine ⇄ list-name contract intact.\x1b[0m');
