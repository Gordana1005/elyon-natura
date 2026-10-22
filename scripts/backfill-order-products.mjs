/**
 * Backfill — public.order_products for every order (migration 20261022120000; owner 22.10.2026: filter
 * the Assigner's customers and /orders by the products bought). No shebang (repair-kit convention).
 *
 *   node scripts/backfill-order-products.mjs            # DRY RUN (default) — READ-ONLY: how many orders /
 *                                                         rows the table should hold, what it holds now
 *   node scripts/backfill-order-products.mjs --apply [--batch 20000]
 *
 * WRITES (--apply): public.order_products_sync(<the next N order ids>) batch by batch, in id order — the
 * SAME function the order_items triggers and the nightly pass call, so a re-run only writes the
 * difference (safe to repeat, safe to stop). Only the new table is written: orders / order_items are
 * never touched (no updated_at bump, no orders trigger). Each batch is one Management API call, well
 * under its ~100 s gateway limit.
 *
 * 🛑 MACEDONIA ONLY (repair-kit guards; the token can write Bulgaria too).
 */
import { pathToFileURL } from 'node:url';
import { bold, die, ok, mkGuard, sql, sqlRead, assertRemoteIsMk, parseArgs, q } from './lib/repair-kit.mjs';

const DEFAULT_BATCH = 20000;

async function counts() {
  const [r] = await sqlRead(`
    SELECT (SELECT count(*) FROM public.orders)::int AS orders,
           (SELECT count(DISTINCT order_id) FROM public.order_items)::int AS orders_with_items,
           (SELECT count(*) FROM public.order_products)::int AS rows_now,
           (SELECT count(DISTINCT order_id) FROM public.order_products)::int AS orders_now`);
  return r;
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { flags: ['apply'], values: ['batch'] });
  const batch = args.batch ? Number(args.batch) : DEFAULT_BATCH;
  if (!Number.isInteger(batch) || batch < 100 || batch > 50000) die('--batch must be 100 … 50000');

  mkGuard();
  await assertRemoteIsMk();
  const [have] = await sqlRead(`SELECT to_regclass('public.order_products') IS NOT NULL AS t,
    to_regprocedure('public.order_products_sync(uuid[])') IS NOT NULL AS f`);
  if (!have?.t || !have?.f) die('migration 20261022120000_order_products.sql is not applied yet');

  const before = await counts();
  console.log(bold('order_products — now'));
  console.log(`  orders ${before.orders} · with lines ${before.orders_with_items} · table rows ${before.rows_now} on ${before.orders_now} orders`);

  if (!args.apply) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply to sync every order (only the difference is written).');
    return;
  }

  let last = '00000000-0000-0000-0000-000000000000';
  const tot = { batches: 0, orders: 0, deleted: 0, inserted: 0, updated: 0 };
  for (;;) {
    const t0 = Date.now();
    const [r] = await sql(`
      WITH ids AS (SELECT id FROM public.orders WHERE id > ${q(last)}::uuid ORDER BY id LIMIT ${batch})
      SELECT (SELECT id FROM ids ORDER BY id DESC LIMIT 1) AS last_id,
             (SELECT count(*) FROM ids)::int AS n,
             public.order_products_sync(ARRAY(SELECT id FROM ids)) AS res`);
    if (!r || !r.n) break;
    const res = typeof r.res === 'string' ? JSON.parse(r.res) : r.res;
    tot.batches++;
    tot.orders += r.n;
    tot.deleted += res.deleted;
    tot.inserted += res.inserted;
    tot.updated += res.updated;
    console.log(`  batch ${tot.batches}: ${r.n} orders → +${res.inserted} −${res.deleted} ~${res.updated} (${Date.now() - t0} ms)`);
    last = r.last_id;
    if (r.n < batch) break;
  }

  const after = await counts();
  ok(`synced ${tot.orders} orders in ${tot.batches} batches: +${tot.inserted} −${tot.deleted} ~${tot.updated}`);
  console.log(`  table rows ${after.rows_now} on ${after.orders_now} orders`);
  console.log('Check: node scripts/verify-order-products.mjs');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => die(e?.message ?? String(e)));
}
