#!/usr/bin/env node
/**
 * Repair — orders "shipped" while their parcel is still at MEX 8 "Shipment created"
 * (owner 30.09.2026: MEX 8 = ЗА ПАКУВАЊЕ; only 4/10/9/1/3 = shipped; plan Фаза 9).
 *
 * Until the MEX-8 semantics went live (mex-reconcile match.ts targetFor / atMexGate, the collabBox
 * writer 20260943001210) ANY parcel made the order 'shipped', including one a driver has not
 * collected yet. On 30.09 that was ~260 orders. This moves them back to 'confirmed' — за пакување —
 * and mex-reconcile moves them forward again, by itself, the moment the courier takes the parcel.
 *
 * Population: status 'shipped' · holds a parcel (orders.mex_tracking_id) · that parcel's REGISTER row
 * (public.mex_parcels) is at status 8. Per order: status → confirmed, shipped_at → NULL (it has not
 * shipped; the sweep stamps it again from the parcel), mex_sent_at → the parcel's creation at MEX if
 * NULL. One order_history row (shipped → confirmed) + one order_notes row. No stock movement: the
 * shipped of these orders was written by the MEX sweep / the collabBox writer, which never deduct
 * stock (the dry run counts any order a person marked shipped — 0 on 30.09); the next shipped
 * (the sweep again) deducts nothing either, so stock is unchanged end to end. Money does not move:
 * the cohort is MEX-first (a parcel at 8 is 'label' whatever the CRM status).
 *
 *   node --env-file=.env scripts/repair-shipped-at-mex8.mjs --preview           # counts only, writes NOTHING
 *   node --env-file=.env scripts/repair-shipped-at-mex8.mjs                     # dry run → CSV + a data_repair_runs row
 *   node --env-file=.env scripts/repair-shipped-at-mex8.mjs [--max-age-days 14] # only parcels created in the last N days
 *   node --env-file=.env scripts/repair-shipped-at-mex8.mjs --apply --run <id> [--actor mile@elyon.com] [--outside-quiet-window]
 *   node --env-file=.env scripts/repair-shipped-at-mex8.mjs --rollback <id> [--actor mile@elyon.com]
 *
 * Deploy the MEX-8 mex-reconcile FIRST (or the next sweep would not undo this, but it would keep
 * making new ones). Quiet window (after 20:55 Skopje), keep_updated_at on, never while the segment
 * recompute runs. 🛑 Macedonia only (repair-kit guards).
 */
import {
  bold, die, ok, green,
  mkGuard, sql, sqlRead, assertRemoteIsMk, q, qUuid, qJson, parseArgs, planLine,
  fileStamp, writeCsv, fmtSkopje, resolveActor, recordDryRun, verifyRunForApply, finalizeRun,
  requireKeepUpdatedAt, requireQuietWindow, requireNoSegmentRecompute, printTable,
} from './lib/repair-kit.mjs';

export const KEY = 'shipped-at-mex8';
const RULE = 'shipped_at_mex8_to_confirmed';
const CHUNK = 200;
const ACTOR_NAME = 'System (repair:shipped-at-mex8)';

const candidatesSql = (maxAgeDays) => `
select o.id as order_id, o.display_id, o.status::text as status, o.price, o.shipped_at,
       (to_jsonb(o) ->> 'mex_sent_at')::timestamptz as mex_sent_at,   -- readable before 20260943001200 (preview)
       o.sale_source, o.sale_source_detail, o.external_source,
       public.cohort_order_source(o.sale_source, o.sale_source_detail, o.mex_tracking_id, o.dept_override) as department,
       p.tracking_id, p.account, p.status_id, p.created_at_mex, p.last_update_at, p.cod_mkd,
       exists (select 1 from public.order_history h
                where h.order_id = o.id and h.to_status = 'shipped' and h.changed_by is not null) as shipped_by_person,
       exists (select 1 from public.inventory_logs l
                where l.movement_type = 'order_deduction' and l.notes like '%' || o.display_id || '%') as stock_deducted
  from public.orders o
  join public.mex_parcels p on p.tracking_id = o.mex_tracking_id
 where o.status = 'shipped'
   and p.status_id = 8
   ${maxAgeDays ? `and p.created_at_mex >= now() - interval '${Number(maxAgeDays)} days'` : ''}
 order by p.created_at_mex, o.id`;

const lineOf = (r) => planLine(r.order_id, RULE, 'confirmed', r.tracking_id);

function chunkSql(runId, rows) {
  const values = rows.map((r) => `(${qUuid(r.order_id)}, ${q(r.tracking_id)}, ${q(lineOf(r))})`).join(',\n');
  // One chunk = one implicit transaction (see repair-kit buildChunkSql).
  return `
set local elyon.bulk_repair = 'on';
set local elyon.keep_updated_at = 'on';
set local statement_timeout = '120s';
set local lock_timeout = '20s';
create temp table _plan (order_id uuid primary key, tracking_id text not null, line text not null) on commit drop;
insert into _plan values
${values};
select count(*) from (select 1 from public.orders where id in (select order_id from _plan) for update) l;
create temp table _ok on commit drop as
select p.*, mp.created_at_mex from _plan p
  join public.orders o on o.id = p.order_id
  join public.mex_parcels mp on mp.tracking_id = p.tracking_id
 where o.status = 'shipped' and o.mex_tracking_id = p.tracking_id and mp.status_id = 8;
insert into public.data_repair_rows (run_id, order_id, rule, before, after, evidence)
select ${qUuid(runId)}, k.order_id, ${q(RULE)},
       jsonb_build_object('status', o.status, 'shipped_at', o.shipped_at, 'mex_sent_at', o.mex_sent_at),
       jsonb_build_object('status', 'confirmed', 'shipped_at', null, 'mex_sent_at', coalesce(o.mex_sent_at, k.created_at_mex, o.shipped_at)),
       jsonb_build_object('line', k.line, 'tracking_id', k.tracking_id, 'parcel_created_at', k.created_at_mex)
  from _ok k join public.orders o on o.id = k.order_id;
update public.orders o
   set status = 'confirmed', shipped_at = null, mex_sent_at = coalesce(o.mex_sent_at, k.created_at_mex, o.shipped_at)
  from _ok k where o.id = k.order_id;
insert into public.order_history (order_id, from_status, to_status, changed_by, changed_by_name)
select k.order_id, 'shipped'::public.order_status, 'confirmed'::public.order_status, null, ${q(ACTOR_NAME)} from _ok k;
insert into public.order_notes (order_id, text, author_id, author_name)
select k.order_id,
       'MEX ' || k.tracking_id || ' is still at 8 (Shipment created — за пакување): status set back to confirmed. It becomes shipped when the courier takes the parcel (owner 30.09.2026).',
       null, 'System'
  from _ok k;
select (select count(*) from _plan)::int as planned, (select count(*) from _ok)::int as applied;`;
}

function summarize(rows) {
  const by = {};
  const now = Date.now();
  for (const r of rows) {
    const age = (now - new Date(r.created_at_mex).getTime()) / 86_400_000;
    const k = `${r.account} · ${age <= 14 ? '≤ 14 days' : '> 14 days'}`;
    by[k] ??= { group: k, orders: 0, value_mkd: 0, by_person: 0, stock_deducted: 0 };
    by[k].orders++;
    by[k].value_mkd += Math.round(Number(r.price || 0) * 61.5);
    if (r.shipped_by_person) by[k].by_person++;
    if (r.stock_deducted) by[k].stock_deducted++;
  }
  const byDept = {};
  for (const r of rows) byDept[r.department] = (byDept[r.department] || 0) + 1;
  return { groups: Object.values(by), byDept };
}

async function dryRun({ record, maxAgeDays }) {
  const rows = await sqlRead(candidatesSql(maxAgeDays));
  const { groups, byDept } = summarize(rows);
  console.log(bold(`\nOrders 'shipped' while their parcel is at MEX 8: ${rows.length}${maxAgeDays ? ` (parcels ≤ ${maxAgeDays} days old)` : ''}\n`));
  printTable(groups);
  console.log('by department:', byDept);
  console.log(bold('\nSamples (oldest and newest):'));
  printTable([...rows.slice(0, 5), ...rows.slice(-5)].map((r) => ({
    order: r.display_id, dept: r.department, tracking: r.tracking_id, parcel_created: fmtSkopje(r.created_at_mex), shipped_at: fmtSkopje(r.shipped_at),
  })));
  if (!record) { ok('preview only — nothing written (no CSV, no data_repair_runs row).'); return; }
  const csv = writeCsv(`${KEY}-${fileStamp()}.csv`, rows.map((r) => ({
    order: r.display_id, order_id: r.order_id, department: r.department, tracking_id: r.tracking_id, account: r.account,
    parcel_created: fmtSkopje(r.created_at_mex), shipped_at: fmtSkopje(r.shipped_at), price_eur: r.price,
    shipped_by_person: r.shipped_by_person, stock_deducted: r.stock_deducted,
  })));
  const { id, hash } = await recordDryRun({ key: KEY, lines: rows.map(lineOf), summary: { total: rows.length, groups, by_department: byDept, options: { max_age_days: maxAgeDays ?? null } } });
  ok(`CSV: ${csv}`);
  ok(`dry run recorded: ${bold(id)} (hash ${hash.slice(0, 12)}…)`);
  console.log(`\nApply (quiet window, after 20:55 Skopje, AFTER the MEX-8 mex-reconcile is deployed):\n  node --env-file=.env scripts/repair-shipped-at-mex8.mjs --apply --run ${id}${maxAgeDays ? ` --max-age-days ${maxAgeDays}` : ''}`);
}

async function apply(runId, actorEmail, outside, maxAgeDays) {
  requireQuietWindow({ override: outside });
  const [col] = await sqlRead("select count(*)::int n from information_schema.columns where table_schema = 'public' and table_name = 'orders' and column_name = 'mex_sent_at'");
  if (!col?.n) die('orders.mex_sent_at is missing — apply migration 20260943001200 first.');
  await requireKeepUpdatedAt({ forApply: true });
  await requireNoSegmentRecompute('start');
  const actor = await resolveActor(actorEmail);
  const rows = await sqlRead(candidatesSql(maxAgeDays));
  const { done } = await verifyRunForApply({ key: KEY, runId, lines: rows.map(lineOf), options: { max_age_days: maxAgeDays ?? null } });
  const todo = rows.filter((r) => !done.has(r.order_id));
  let planned = 0, applied = 0;
  for (let i = 0; i < todo.length; i += CHUNK) {
    await requireNoSegmentRecompute('chunk');
    const part = todo.slice(i, i + CHUNK);
    process.stdout.write(`  chunk ${i / CHUNK + 1}/${Math.ceil(todo.length / CHUNK)} (${part.length}) … `);
    const [res] = await sql(chunkSql(runId, part));
    planned += res.planned; applied += res.applied;
    console.log(`${green('committed')} ${res.applied}/${res.planned}`);
  }
  await finalizeRun({ key: KEY, runId, actor, payload: { planned, applied, resumed: done.size } });
  ok(`applied ${applied} of ${planned} (${planned - applied} moved since the dry run — left alone)`);
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
  -- only rows still exactly as the repair left them (still confirmed, still at MEX 8)
  update public.orders o
     set status = 'shipped', shipped_at = (r.before->>'shipped_at')::timestamptz,
         mex_sent_at = (r.before->>'mex_sent_at')::timestamptz
    from r
   where o.id = r.order_id and o.status = 'confirmed' and o.shipped_at is null
  returning o.id
), h as (
  insert into public.order_history (order_id, from_status, to_status, changed_by, changed_by_name)
  select u.id, 'confirmed'::public.order_status, 'shipped'::public.order_status, null, ${q(ACTOR_NAME + ' rollback')} from u
  returning order_id
)
select (select count(*) from r)::int as rows, (select count(*) from u)::int as restored;`);
  await sql(`insert into public.audit_log (actor_id, actor_email, action, target_type, target_id, target_name, payload)
    values (${qUuid(actor.id)}, ${q(actor.email)}, 'data_repair.rollback', 'data_repair_run', ${q(runId)}, ${q(KEY)}, ${qJson(res)})`);
  ok(`rolled back ${res.restored} of ${res.rows} rows (the rest moved on since the repair)`);
}

const args = parseArgs(process.argv.slice(2), { flags: ['apply', 'preview', 'outside-quiet-window'], values: ['run', 'rollback', 'actor', 'max-age-days'] });
mkGuard();
await assertRemoteIsMk();
const actorEmail = args.actor || 'mile@elyon.com';
const maxAgeDays = args['max-age-days'] ? Number(args['max-age-days']) : null;
if (maxAgeDays !== null && !(maxAgeDays > 0 && maxAgeDays <= 365)) die('--max-age-days must be 1…365');
if (args.rollback) await rollback(args.rollback, actorEmail, !!args['outside-quiet-window']);
else if (args.apply) { if (!args.run) die('--apply needs --run <dry-run id>'); await apply(args.run, actorEmail, !!args['outside-quiet-window'], maxAgeDays); }
else await dryRun({ record: !args.preview, maxAgeDays });
