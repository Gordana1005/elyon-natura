#!/usr/bin/env node
/**
 * Repair — the product on /calls cancel / trash records (owner audit, 30.09.2026).
 *
 * When an agent closed a customer with no open order, /calls recorded a synthetic cancelled/trashed
 * order meant to carry "the customer's last product". The page looked it up through GET /orders,
 * which RLS scopes to the agent's own orders, so for prediction-list customers it found nothing and
 * wrote "No prior product on file" — 7.170 rows since 18.08, although those customers HAVE bought.
 * Since 47620bd POST /orders fills new records from public.last_sale_product (migration
 * 20260943000200); this script repairs the old ones with the sale that came BEFORE each record.
 *
 * Population: status cancelled/trashed · source_type manual · sale_source_detail 'disposition' ·
 * a placeholder product name (public.is_synthetic_product_name) · no order_items · NOT the teleshop
 * import's ban markers (external_source 'teleshop_import') · a real sale exists before created_at.
 * Writes ONLY orders.product_name / product_id (no items → stock and package reports untouched; the
 * price stays 0 so the row stays a disposition; no segment trigger fires on these columns; updated_at
 * is kept). Every row goes to data_repair_rows with before/after; --rollback restores the rows that
 * still hold the repaired value.
 *
 *   node scripts/repair-disposition-products.mjs                                  # dry run → CSV + run id
 *   node scripts/repair-disposition-products.mjs --apply --run <id> [--actor mile@elyon.com] [--outside-quiet-window]
 *   node scripts/repair-disposition-products.mjs --rollback <id> [--actor mile@elyon.com]
 *
 * 🛑 Macedonia only (repair-kit guards). Writes only with --apply / --rollback, in the quiet window.
 */
import {
  bold, green, yellow, die, warn, ok,
  mkGuard, sql, sqlRead, assertRemoteIsMk, q, qUuid, qJson, parseArgs, planLine,
  fileStamp, writeCsv, fmtSkopje, resolveActor, recordDryRun, verifyRunForApply, finalizeRun,
  requireKeepUpdatedAt, requireQuietWindow, requireNoSegmentRecompute, printTable,
} from './lib/repair-kit.mjs';

export const KEY = 'disposition-products';
const RULE = 'disposition_product';
const CHUNK = 500;

// SELECT only — run through sql() (not the read-only role) because last_sale_product is
// service_role/postgres only.
const CANDIDATES_SQL = `
select o.id as order_id, o.display_id, o.status::text as status, o.created_at,
       o.product_name as old_name, o.product_id as old_pid,
       l.product_name as new_name, l.product_id as new_pid, l.order_id as source_order, l.sale_at as source_sale_at
  from public.orders o
  cross join lateral public.last_sale_product(o.customer_phone, o.created_at) l
 where o.sale_source_detail = 'disposition'
   and o.source_type = 'manual'
   and o.status in ('cancelled', 'trashed')
   and public.is_synthetic_product_name(o.product_name)
   and o.external_source is distinct from 'teleshop_import'
   and not exists (select 1 from public.order_items i where i.order_id = o.id)
   and l.product_name is not null
 order by o.created_at, o.id`;

const lineOf = (r) => planLine(r.order_id, RULE, r.new_pid || r.new_name, null);

function chunkSql(runId, rows) {
  const values = rows.map((r) => `(${qUuid(r.order_id)}, ${qUuid(r.new_pid || null)}, ${q(r.new_name)}, ${qUuid(r.source_order)}, ${q(lineOf(r))})`).join(',\n');
  // One chunk = one implicit transaction (see repair-kit buildChunkSql).
  return `
set local elyon.bulk_repair = 'on';
set local elyon.keep_updated_at = 'on';
set local statement_timeout = '120s';
set local lock_timeout = '20s';
create temp table _plan (order_id uuid primary key, product_id uuid, product_name text not null,
                         source_order uuid, line text not null) on commit drop;
insert into _plan values
${values};
select count(*) from (select 1 from public.orders where id in (select order_id from _plan) for update) l;
create temp table _ok on commit drop as
select p.* from _plan p join public.orders o on o.id = p.order_id
 where o.status in ('cancelled', 'trashed')
   and public.is_synthetic_product_name(o.product_name)
   and not exists (select 1 from public.order_items i where i.order_id = o.id);
insert into public.data_repair_rows (run_id, order_id, rule, before, after, evidence)
select ${qUuid(runId)}, k.order_id, ${q(RULE)},
       jsonb_build_object('product_id', o.product_id, 'product_name', o.product_name),
       jsonb_build_object('product_id', k.product_id, 'product_name', k.product_name),
       jsonb_build_object('line', k.line, 'source_order', k.source_order)
  from _ok k join public.orders o on o.id = k.order_id;
update public.orders o set product_name = k.product_name, product_id = k.product_id
  from _ok k where o.id = k.order_id;
select (select count(*) from _plan)::int as planned, (select count(*) from _ok)::int as applied;`;
}

async function dryRun() {
  const rows = await sql(CANDIDATES_SQL);
  const total = await sql(`select count(*)::int n from public.orders o
    where o.sale_source_detail = 'disposition' and o.source_type = 'manual' and o.status in ('cancelled','trashed')
      and public.is_synthetic_product_name(o.product_name) and o.external_source is distinct from 'teleshop_import'
      and not exists (select 1 from public.order_items i where i.order_id = o.id)`);
  const byMonth = {};
  for (const r of rows) {
    const m = String(r.created_at).slice(0, 7);
    byMonth[m] ??= { month: m, cancelled: 0, trashed: 0, with_product_id: 0 };
    byMonth[m][r.status]++;
    if (r.new_pid) byMonth[m].with_product_id++;
  }
  console.log(bold(`\nPlaceholder dispositions: ${total[0].n} · fillable from an earlier sale: ${rows.length} · no earlier sale (left as is): ${total[0].n - rows.length}\n`));
  printTable(Object.values(byMonth));
  console.log(bold('\nSamples:'));
  printTable(rows.slice(-12).map((r) => ({ order: r.display_id, status: r.status, record: fmtSkopje(r.created_at), product: String(r.new_name).slice(0, 50), sale: fmtSkopje(r.source_sale_at) })));
  const csv = writeCsv(`${KEY}-${fileStamp()}.csv`, rows.map((r) => ({
    order: r.display_id, order_id: r.order_id, status: r.status, recorded: fmtSkopje(r.created_at),
    old_product: r.old_name, new_product: r.new_name, new_product_id: r.new_pid, source_order: r.source_order, source_sale: fmtSkopje(r.source_sale_at),
  })));
  const { id, hash } = await recordDryRun({ key: KEY, lines: rows.map(lineOf), summary: { total: total[0].n, fillable: rows.length, by_month: byMonth } });
  ok(`CSV: ${csv}`);
  ok(`dry run recorded: ${bold(id)} (hash ${hash.slice(0, 12)}…)`);
  console.log(`\nApply (quiet window, after 20:55 Skopje):\n  node scripts/repair-disposition-products.mjs --apply --run ${id}`);
}

async function apply(runId, actorEmail, outside) {
  requireQuietWindow({ override: outside });
  await requireKeepUpdatedAt({ forApply: true });
  await requireNoSegmentRecompute('start');
  const actor = await resolveActor(actorEmail);
  const rows = await sql(CANDIDATES_SQL);
  const { done } = await verifyRunForApply({ key: KEY, runId, lines: rows.map(lineOf) });
  const todo = rows.filter((r) => !done.has(r.order_id));
  let planned = 0, applied = 0;
  for (let i = 0; i < todo.length; i += CHUNK) {
    const part = todo.slice(i, i + CHUNK);
    process.stdout.write(`  chunk ${i / CHUNK + 1}/${Math.ceil(todo.length / CHUNK)} (${part.length}) … `);
    const [res] = await sql(chunkSql(runId, part));
    planned += res.planned; applied += res.applied;
    console.log(`${green('committed')} ${res.applied}/${res.planned}`);
  }
  await finalizeRun({ key: KEY, runId, actor, payload: { planned, applied, resumed: done.size } });
  ok(`applied ${applied} of ${planned} (${planned - applied} changed since the dry run — left alone)`);
}

async function rollback(runId, actorEmail, outside) {
  requireQuietWindow({ override: outside });
  const actor = await resolveActor(actorEmail);
  const [res] = await sql(`
set local elyon.bulk_repair = 'on';
set local elyon.keep_updated_at = 'on';
set local statement_timeout = '300s';
with r as (
  select r.order_id, r.before, r.after from public.data_repair_rows r
   where r.run_id = ${qUuid(runId)} and r.rule = ${q(RULE)} and r.after is not null
), u as (
  update public.orders o
     set product_name = r.before->>'product_name', product_id = nullif(r.before->>'product_id', '')::uuid
    from r
   where o.id = r.order_id
     and o.product_name is not distinct from r.after->>'product_name'
     and o.product_id is not distinct from nullif(r.after->>'product_id', '')::uuid
  returning o.id
)
select (select count(*) from r)::int as rows, (select count(*) from u)::int as restored;`);
  await sql(`insert into public.audit_log (actor_id, actor_email, action, target_type, target_id, target_name, payload)
    values (${qUuid(actor.id)}, ${q(actor.email)}, 'data_repair.rollback', 'data_repair_run', ${q(runId)}, ${q(KEY)}, ${qJson(res)})`);
  ok(`rolled back ${res.restored} of ${res.rows} rows (the rest changed since the repair)`);
}

const args = parseArgs(process.argv.slice(2), { flags: ['apply', 'outside-quiet-window'], values: ['run', 'rollback', 'actor'] });
mkGuard();
await assertRemoteIsMk();
const actorEmail = args.actor || 'mile@elyon.com';
if (args.rollback) await rollback(args.rollback, actorEmail, !!args['outside-quiet-window']);
else if (args.apply) { if (!args.run) die('--apply needs --run <dry-run id>'); await apply(args.run, actorEmail, !!args['outside-quiet-window']); }
else await dryRun();
