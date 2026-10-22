/**
 * verify-order-products — READ-ONLY proof that public.order_products (migration 20261022120000) holds
 * exactly the catalogue products of every order's lines.
 *
 *   node scripts/verify-order-products.mjs            (text report)
 *   node scripts/verify-order-products.mjs --json
 *
 * Exit: 0 = no FAIL · 1 = at least one FAIL · 2 = refused / not applied / DB unreachable.
 *
 *   P1  the table = a fresh recount from order_items (the line's product_id, else a reviewed alias by
 *       source collabbox | crm; delivery / loyalty / note / flyer and synthetic names dropped): no row
 *       missing, none extra, gift_only the same
 *   P2  every row's order still has a line naming that product (no orphans)
 *   P3  one product counted independently (default Urofix): orders whose lines name it by product_id
 *       or by a reviewed alias of it = the table's orders for it
 *   P4  the plumbing: the three order_items triggers, the nightly cron job, RLS on
 *   T   timings
 *
 * Safety: the guard of scripts/verify-insights-ties.mjs — pinned to Macedonia, every statement a single
 * SELECT / WITH sent with read_only: true.
 */
import { runSql } from './verify-insights-ties.mjs';

const UROFIX = 'fae40061-d8ad-4025-9de0-3dea17daff71';
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const n = (v) => Number(v ?? 0) || 0;
const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

const results = [];
const timings = [];
function check(id, title) {
  const c = { id, title, status: 'PASS', lines: [] };
  results.push(c);
  return {
    tie(label, want, got) {
      const ok = JSON.stringify(want) === JSON.stringify(got);
      c.lines.push({ label, want, got, ok });
      if (!ok) c.status = 'FAIL';
    },
    warn(label, detail) { c.lines.push({ label, got: detail, warn: true }); if (c.status === 'PASS') c.status = 'WARN'; },
    info(label, detail) { c.lines.push({ label, got: detail, info: true, ok: true }); },
  };
}
async function timed(label, sql) {
  const t0 = Date.now();
  const rows = await runSql(sql);
  timings.push({ label, ms: Date.now() - t0 });
  return rows;
}

// The definition, written out again (not a call of order_products_sync — that writes).
const WANT = `
  l AS MATERIALIZED (
    SELECT oi.order_id,
           CASE WHEN o.sale_source = 'collabbox' THEN 'collabbox' ELSE 'crm' END AS src,
           oi.product_id AS pid, oi.product_name AS name,
           (coalesce(oi.total_price, 0) <> 0 OR coalesce(oi.price_per_unit, 0) <> 0) AS priced
    FROM public.order_items oi
    JOIN public.orders o ON o.id = oi.order_id
    WHERE NOT public.is_synthetic_product_name(oi.product_name)
      AND oi.product_name IS DISTINCT FROM 'collabBox: без ставки (непознат производ)'
  ),
  d AS MATERIALIZED (
    SELECT x.src, x.name, public.order_line_kind(x.src, x.name) AS kind,
           (SELECT a.product_id FROM public.product_aliases a
             WHERE a.source IN (x.src, 'any') AND a.alias_norm = public.product_alias_norm(x.name)
               AND a.product_id IS NOT NULL
             ORDER BY (a.source = x.src) DESC LIMIT 1) AS alias_pid
    FROM (SELECT DISTINCT l.src, l.name FROM l) x
  ),
  r AS (
    SELECT l.order_id, coalesce(l.pid, d.alias_pid) AS product_id,
           (d.kind = 'gift' OR coalesce(p.kind = 'gift', false)
            OR (NOT l.priced AND bool_or(l.priced) OVER (PARTITION BY l.order_id))) AS gift
    FROM l JOIN d ON d.src = l.src AND d.name = l.name
    LEFT JOIN public.products p ON p.id = coalesce(l.pid, d.alias_pid)
    WHERE d.kind NOT IN ('delivery', 'loyalty_point', 'note', 'flyer')
  ),
  want AS MATERIALIZED (
    SELECT r.order_id, r.product_id, bool_and(r.gift) AS gift_only
    FROM r WHERE r.product_id IS NOT NULL GROUP BY 1, 2
  )`;

async function verifyTable() {
  const [r] = await timed('P1 recount', `
    WITH ${WANT},
    have AS MATERIALIZED (SELECT order_id, product_id, gift_only FROM public.order_products)
    SELECT
      (SELECT count(*) FROM want) AS want_rows,
      (SELECT count(*) FROM have) AS have_rows,
      (SELECT count(*) FROM want w WHERE NOT EXISTS (SELECT 1 FROM have h WHERE h.order_id = w.order_id AND h.product_id = w.product_id)) AS missing,
      (SELECT count(*) FROM have h WHERE NOT EXISTS (SELECT 1 FROM want w WHERE w.order_id = h.order_id AND w.product_id = h.product_id)) AS extra,
      (SELECT count(*) FROM want w JOIN have h USING (order_id, product_id) WHERE w.gift_only IS DISTINCT FROM h.gift_only) AS gift_diff,
      (SELECT coalesce(jsonb_agg(z), '[]'::jsonb) FROM (
         SELECT w.order_id, w.product_id FROM want w
          WHERE NOT EXISTS (SELECT 1 FROM have h WHERE h.order_id = w.order_id AND h.product_id = w.product_id)
          LIMIT 5) z) AS missing_sample
  `);
  const p1 = check('P1', 'order_products = a fresh recount from order_items');
  p1.tie('rows missing', 0, n(r.missing));
  p1.tie('rows extra', 0, n(r.extra));
  p1.tie('gift_only differs', 0, n(r.gift_diff));
  p1.info('rows (recount / table)', `${n(r.want_rows)} / ${n(r.have_rows)}`);
  const sample = parse(r.missing_sample);
  if (sample.length) p1.info('missing sample', sample);
}

async function verifyOrphans() {
  const [r] = await timed('P2 orphans', `
    SELECT count(*) AS orphans FROM public.order_products op
     WHERE NOT EXISTS (
       SELECT 1 FROM public.order_items oi
        WHERE oi.order_id = op.order_id
          AND (oi.product_id = op.product_id
               OR (oi.product_id IS NULL AND EXISTS (
                     SELECT 1 FROM public.product_aliases a
                      WHERE a.product_id = op.product_id
                        AND a.alias_norm = public.product_alias_norm(oi.product_name)))))
  `);
  const p2 = check('P2', 'every row has a line naming its product');
  p2.tie('rows with no such line', 0, n(r.orphans));
}

async function verifyOneProduct(pid) {
  const [r] = await timed('P3 one product', `
    WITH names AS (SELECT a.alias_norm FROM public.product_aliases a WHERE a.product_id = '${pid}'::uuid)
    SELECT
      (SELECT name FROM public.products WHERE id = '${pid}'::uuid) AS name,
      (SELECT count(DISTINCT oi.order_id) FROM public.order_items oi
        WHERE (oi.product_id = '${pid}'::uuid
               OR (oi.product_id IS NULL AND public.product_alias_norm(oi.product_name) IN (SELECT alias_norm FROM names)))
          AND NOT public.is_synthetic_product_name(oi.product_name)) AS by_lines,
      (SELECT count(*) FROM public.order_products WHERE product_id = '${pid}'::uuid) AS in_table,
      (SELECT count(*) FROM public.order_products WHERE product_id = '${pid}'::uuid AND NOT gift_only) AS bought,
      (SELECT jsonb_object_agg(status, c) FROM (
         SELECT o.status, count(*) c FROM public.order_products op JOIN public.orders o ON o.id = op.order_id
          WHERE op.product_id = '${pid}'::uuid GROUP BY 1) z) AS by_status
  `);
  const p3 = check('P3', `one product counted from its lines: ${r.name ?? pid}`);
  p3.tie('orders (lines by product_id or a reviewed alias) = table', n(r.by_lines), n(r.in_table));
  p3.info('bought (not a gift)', n(r.bought));
  p3.info('by status', parse(r.by_status));
}

async function verifyPlumbing() {
  const [r] = await timed('P4 plumbing', `
    SELECT
      (SELECT coalesce(jsonb_agg(tgname ORDER BY tgname), '[]'::jsonb) FROM pg_trigger
        WHERE tgrelid = 'public.order_items'::regclass AND tgname LIKE 'order_items_order_products_%' AND tgenabled <> 'D') AS triggers,
      (SELECT schedule FROM cron.job WHERE jobname = 'order-products-nightly' AND active) AS cron,
      (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.order_products'::regclass) AS rls,
      (SELECT count(*) FROM public.order_products) AS rows,
      (SELECT count(DISTINCT order_id) FROM public.order_products) AS orders,
      (SELECT count(*) FROM public.order_products WHERE gift_only) AS gift_rows
  `);
  const p4 = check('P4', 'triggers, nightly job, RLS');
  p4.tie('order_items triggers', ['order_items_order_products_del', 'order_items_order_products_ins', 'order_items_order_products_upd'], parse(r.triggers));
  p4.tie('cron order-products-nightly', '40 2,3 * * *', r.cron);
  p4.tie('RLS on', true, r.rls);
  p4.info('rows / orders / gift-only rows', `${n(r.rows)} / ${n(r.orders)} / ${n(r.gift_rows)}`);
}

async function main() {
  const json = process.argv.includes('--json');
  const [have] = await runSql(`SELECT to_regclass('public.order_products') IS NOT NULL AS t`);
  if (!have?.t) { console.error('verify-order-products: migration 20261022120000 not applied'); process.exit(2); }
  await verifyTable();
  await verifyOrphans();
  await verifyOneProduct(arg('--product') || UROFIX);
  await verifyPlumbing();

  const fail = results.some((c) => c.status === 'FAIL');
  if (json) {
    console.log(JSON.stringify({ tool: 'verify-order-products', read_only: true, generated_at: new Date().toISOString(), status: fail ? 'FAIL' : 'PASS', results, timings }, null, 2));
  } else {
    console.log('verify-order-products · read-only · Macedonia');
    for (const c of results) {
      console.log(`\n${c.status.padEnd(4)}  ${c.id}  ${c.title}`);
      for (const l of c.lines) {
        if (l.info) console.log(`        · ${l.label}: ${typeof l.got === 'object' ? JSON.stringify(l.got) : l.got}`);
        else if (l.warn) console.log(`        ! ${l.label}: ${l.got}`);
        else if (!l.ok) console.log(`        ✗ ${l.label}: want ${JSON.stringify(l.want)}, got ${JSON.stringify(l.got)}`);
      }
    }
    console.log(`\ntimings: ${timings.map((t) => `${t.label} ${t.ms} ms`).join(' · ')}`);
    console.log(`\n${fail ? 'FAIL' : 'PASS'}`);
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(`verify-order-products error: ${e?.message ?? e}`); process.exit(2); });
