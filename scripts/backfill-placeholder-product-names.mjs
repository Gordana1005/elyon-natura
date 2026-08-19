// Repair the cancel/trash records that claim "No prior product on file".
//
// /calls writes a synthetic order when an agent records a cancel or trash for a
// customer with no open order, and stamps it with the customer's last real
// product (CallsPage.lastRealProduct). That lookup used to accept a previous
// synthetic row as a "real" product, so once one placeholder existed it was
// copied forward on every later call and the customer's actual purchase — which
// sits one row below — was never read again.
//
// The lookup is fixed. This repairs the rows it already produced by resolving
// each one to the customer's most recent genuinely real product.
//
// Only product_name is written. product_id stays null so nothing that joins on
// it (stock, revenue attribution) changes behaviour, and price stays 0.
// Non-cancelled/trashed rows are never touched — guessing a product onto a PAID
// order would invent revenue attribution.
//
// Usage:  node scripts/backfill-placeholder-product-names.mjs           (dry run)
//         node scripts/backfill-placeholder-product-names.mjs --apply
import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync } from 'node:fs';

const APPLY = process.argv.includes('--apply');

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
    })
);

if (!String(env.SUPABASE_URL).includes('bmfxhgznttcnnlqloqzp')) {
  console.error('ABORT: not the Macedonian project ->', env.SUPABASE_URL);
  process.exit(1);
}

const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// Mirror of src/lib/utils.ts isSyntheticProductName — keep the two in step.
const isSynthetic = (name) => {
  const n = (name || '').trim();
  if (!n || n === '—') return true;
  return /^(Cancelled|Trashed|No prior product on file)/i.test(n);
};

const realProductOf = (o) => {
  const named = (o.order_items || []).filter((i) => i.product_name && !isSynthetic(i.product_name));
  if (named.length) return named.map((i) => i.product_name).join(', ');
  if (!isSynthetic(o.product_name)) return o.product_name;
  return null;
};

const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

console.log(`Target: ${env.SUPABASE_URL} (MK)\nMode:   ${APPLY ? 'APPLY' : 'DRY RUN'}\n`);

// 1. Every row still carrying the placeholder.
const { data: broken, error: e1 } = await db
  .from('orders')
  .select('id, display_id, status, customer_phone, created_at, product_name')
  .eq('product_name', 'No prior product on file')
  .order('created_at', { ascending: false });
if (e1) throw e1;
console.log(`Placeholder rows found: ${broken.length}`);

const eligible = broken.filter((o) => o.status === 'cancelled' || o.status === 'trashed');
const skippedStatus = broken.filter((o) => o.status !== 'cancelled' && o.status !== 'trashed');
if (skippedStatus.length) {
  console.log(`\nSKIPPED — not a cancel/trash record, needs a human decision:`);
  skippedStatus.forEach((o) => console.log(`  ${o.display_id}  ${o.status}  ${o.customer_phone}`));
}

// 2. Pull the full order history for every phone involved, in one sweep.
const phones = [...new Set(eligible.map((o) => o.customer_phone).filter(Boolean))];
console.log(`\nDistinct customers: ${phones.length}`);

const history = new Map();
for (const part of chunk(phones, 100)) {
  const { data, error } = await db
    .from('orders')
    .select('id, customer_phone, created_at, product_name, order_items(product_name)')
    .in('customer_phone', part)
    .order('created_at', { ascending: false });
  if (error) throw error;
  for (const o of data) {
    if (!history.has(o.customer_phone)) history.set(o.customer_phone, []);
    history.get(o.customer_phone).push(o);
  }
}

// 3. Resolve each broken row to that customer's real product, preferring one
//    ordered BEFORE the placeholder (a genuinely "prior" product).
const updates = [];
const unresolved = [];
for (const o of eligible) {
  const rows = (history.get(o.customer_phone) || []).filter((r) => r.id !== o.id);
  const earlier = rows.filter((r) => r.created_at < o.created_at);
  const pick = earlier.map(realProductOf).find(Boolean) || rows.map(realProductOf).find(Boolean) || null;
  if (pick) updates.push({ id: o.id, display_id: o.display_id, status: o.status, from: o.product_name, to: pick });
  else unresolved.push(o);
}

console.log(`\nResolved:   ${updates.length}`);
console.log(`Unresolved: ${unresolved.length}  (customer genuinely has no real product anywhere — these keep the dash)`);

const byProduct = {};
updates.forEach((u) => { byProduct[u.to] = (byProduct[u.to] || 0) + 1; });
console.log(`\nTop products being restored:`);
Object.entries(byProduct).sort((a, b) => b[1] - a[1]).slice(0, 12)
  .forEach(([k, v]) => console.log(`  ${String(v).padStart(4)}  ${k.slice(0, 60)}`));

console.log(`\nSample of the change:`);
updates.slice(0, 10).forEach((u) => console.log(`  ${u.display_id.padEnd(10)} ${u.status.padEnd(9)} -> ${u.to.slice(0, 46)}`));

if (!APPLY) {
  const out = new URL('./backfill-placeholder-rollback-PREVIEW.json', import.meta.url);
  writeFileSync(out, JSON.stringify(updates, null, 1));
  console.log(`\nDRY RUN — nothing written. Preview saved to ${out.pathname}`);
  console.log(`Re-run with --apply to write ${updates.length} rows.`);
  process.exit(0);
}

// 4. Apply, with a rollback file written BEFORE the first write.
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const rollback = new URL(`./backfill-placeholder-rollback-${stamp}.json`, import.meta.url);
writeFileSync(rollback, JSON.stringify(updates, null, 1));
console.log(`\nRollback written to ${rollback.pathname}`);

let ok = 0;
let failed = 0;
for (const u of updates) {
  const { error } = await db.from('orders').update({ product_name: u.to }).eq('id', u.id);
  if (error) { failed++; console.error(`  FAIL ${u.display_id}: ${error.message}`); }
  else ok++;
  if (ok % 50 === 0) console.log(`  ...${ok}/${updates.length}`);
}
console.log(`\nDone. Updated ${ok}, failed ${failed}.`);

const { count } = await db
  .from('orders')
  .select('*', { count: 'exact', head: true })
  .eq('product_name', 'No prior product on file');
console.log(`Placeholder rows remaining: ${count} (expected ${unresolved.length + skippedStatus.length})`);
