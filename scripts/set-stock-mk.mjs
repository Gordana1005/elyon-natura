#!/usr/bin/env node
/**
 * Set every product's warehouse stock to a flat quantity (default 1000 packages).
 *
 * Why a script and not the UI: the Warehouse screen only has "Restock", which is
 * ADDITIVE (POST /api/restock takes a positive delta), and there is no bulk
 * absolute-set anywhere in the Macedonian build — the BigArena stock-sync upload
 * is deliberately not shipped here because its parser reads the Bulgarian
 * fulfilment panel's Cyrillic headers. The per-product absolute set exists only
 * on PATCH /api/products/:id, one call at a time.
 *
 * THE HOUSE RULE: never move stock without a paired inventory_logs row.
 * products.stock_quantity is the single source of truth (there is no ledger the
 * level is derived from), but the Movements tab, the per-product history panel
 * and insights_calls_and_movement all read inventory_logs. Updating one without
 * the other silently breaks all three. This script writes both, in one
 * transaction, mirroring what PATCH /api/products/:id does per product
 * (reason 'manual', movement_type 'manual_adjust').
 *
 * user_id is left NULL, which renders as "System" in the Movements tab — the
 * same convention import-products-bigarena.mjs already uses for script writes.
 *
 * The low-stock notification trigger cannot fire on the way UP: it is guarded to
 * the downward crossing only (20260604130000_notification_triggers.sql), so this
 * will not spam anyone's bell.
 *
 * Usage:
 *   node scripts/set-stock-mk.mjs                  # plan only, writes nothing
 *   node scripts/set-stock-mk.mjs --commit         # apply
 *   node scripts/set-stock-mk.mjs --qty 500 --commit
 *   node scripts/set-stock-mk.mjs --active-only --commit
 *
 * Always run `node scripts/assert-mk-target.mjs` first.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const REF = 'oufoazmnbwugtfldkwsn';

const args = process.argv.slice(2);
const commit = args.includes('--commit');
const activeOnly = args.includes('--active-only');
const qtyArg = args.indexOf('--qty');
const QTY = qtyArg === -1 ? 1000 : Number(args[qtyArg + 1]);

if (!Number.isInteger(QTY) || QTY < 0 || QTY > 1000000) {
  console.error(`--qty must be an integer 0..1000000 (got ${args[qtyArg + 1]})`);
  process.exit(1);
}

// Same tripwire every other MK write script carries: the token in .env can write
// to the LIVE Bulgarian project too, and nothing but this check stops it.
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
const token = env.SUPABASE_ACCESS_TOKEN;
if (!token) { console.error('SUPABASE_ACCESS_TOKEN missing (set it in .env)'); process.exit(1); }

async function sql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const t = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${t}`);
  return JSON.parse(t);
}

const scope = activeOnly ? 'and is_active = true' : '';

// ---------------------------------------------------------------- plan / snapshot
const before = await sql(`
  select id, sku, name, stock_quantity, is_active
  from public.products
  where true ${scope}
  order by sku nulls last, name`);

const changing = before.filter(p => p.stock_quantity !== QTY);
const totalDelta = changing.reduce((s, p) => s + (QTY - p.stock_quantity), 0);

console.log(`Products in scope : ${before.length}${activeOnly ? ' (active only)' : ' (all, active + inactive)'}`);
console.log(`Already at ${QTY}    : ${before.length - changing.length}`);
console.log(`Will change       : ${changing.length}`);
console.log(`Net units added   : ${totalDelta.toLocaleString('en-US')}`);
console.log('');
for (const p of changing.slice(0, 10)) {
  console.log(`  ${(p.sku || '—').padEnd(10)} ${String(p.name).slice(0, 44).padEnd(46)} ${String(p.stock_quantity).padStart(6)} → ${QTY}`);
}
if (changing.length > 10) console.log(`  … and ${changing.length - 10} more`);

if (!commit) {
  console.log('\nPLAN ONLY — nothing written. Re-run with --commit to apply.');
  process.exit(0);
}
if (changing.length === 0) {
  console.log('\nNothing to do.');
  process.exit(0);
}

// The only rollback there is: the exact pre-change levels, on disk.
const stamp = new Date().toISOString().slice(0, 10);
const snapPath = join(root, 'scripts', 'data', `stock-before-${stamp}.json`);
writeFileSync(snapPath, JSON.stringify(before, null, 2), 'utf8');
console.log(`\nSnapshot written: ${snapPath}`);

// ---------------------------------------------------------------- apply
// One transaction: capture the old levels, update, and log the exact deltas the
// UPDATE actually performed. `before` is materialised first so the INSERT reads
// pre-update values (a plain join against products would see the new ones).
const note = `Bulk stock set to ${QTY} packages — ${stamp}`;
await sql(`
BEGIN;

WITH snapshot AS MATERIALIZED (
  SELECT id, stock_quantity FROM public.products
  WHERE stock_quantity IS DISTINCT FROM ${QTY} ${scope}
),
upd AS (
  UPDATE public.products p
  SET stock_quantity = ${QTY}
  FROM snapshot s
  WHERE p.id = s.id
  RETURNING p.id
)
INSERT INTO public.inventory_logs
  (product_id, change_amount, previous_stock, new_stock, reason, movement_type, notes)
SELECT u.id, ${QTY} - s.stock_quantity, s.stock_quantity, ${QTY},
       'manual', 'manual_adjust', ${JSON.stringify(note).replace(/^"|"$/g, "'")}
FROM upd u JOIN snapshot s ON s.id = u.id;

COMMIT;`);

// ---------------------------------------------------------------- verify
const [after] = await sql(`
  select count(*) filter (where stock_quantity = ${QTY}) as at_target,
         count(*) as total
  from public.products where true ${scope}`);
const [logged] = await sql(`
  select count(*) as rows from public.inventory_logs
  where movement_type = 'manual_adjust' and notes = '${note}'`);

console.log(`\nDone. ${after.at_target}/${after.total} products at ${QTY}; ${logged.rows} inventory_logs rows written.`);
if (Number(after.at_target) !== Number(after.total)) {
  console.error('WARNING: some products are not at the target quantity.');
  process.exit(1);
}
