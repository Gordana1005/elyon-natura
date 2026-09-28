#!/usr/bin/env node
/**
 * Repair — delete the CRM orders of the two test phones (owner decision 28.09.2026, HANDOFF §3).
 *
 *   "Test phones 070123456 and 23123123: DELETE their CRM orders (snapshot first). Exclude
 *    their web orders and MEX parcels from all reports; you can't touch the shop."
 *
 * WHAT IT DOES (rules + the dependent-table map: scripts/lib/test-phones.mjs)
 *   * finds every order whose last 8 digits are 70123456 / 23123123 (the project's last-8
 *     canon, the expression idx_orders_phone_last8 indexes);
 *   * deletes those that are a Macedonian spelling of a test number, and LISTS instead of
 *     deleting: other numbers that merely share the last 8 digits, orders an agent has open
 *     (take), orders in agent_payout_items or with an affiliate_leads row (payouts are
 *     deferred), and AlterCPA leads still open at AlterCPA (the next sync sweep would insert
 *     them again — pass --include-pending-altercpa to delete those too);
 *   * snapshots EVERY affected row first — the order and every row that points at it — to a
 *     JSON file in exports/repairs/ (before the transaction) and to data_repair_rows.before
 *     (inside it, the authoritative copy);
 *   * never deletes a ledger row: altercpa_leads.order_id, mex_parcels (+ link_method,
 *     linked_at), missed_calls.linked_order_id and other orders' duplicated_from are UNLINKED
 *     (set NULL) and recorded; order_items / order_history / order_notes / order_unpaid_alerts
 *     / no_parcel_rule_items go with the order (FK CASCADE); edit locks are removed; call logs,
 *     partner postbacks and the repair / 7-day ledgers are kept;
 *   * leaves web_orders (the shop mirror), mex_parcels rows, customer_profiles and the segment
 *     engine alone: reports exclude the phones through public.is_report_excluded_phone()
 *     (migration 20260939000700), and the AFTER DELETE trigger's recompute drops the phones
 *     from every non-static prediction list once they have no order left.
 *
 *   node scripts/repair-test-phones.mjs                                # dry run → CSVs + run id
 *   node scripts/repair-test-phones.mjs --apply --run <id> [--actor mile@elyon.com] [--chunk 200] [--outside-quiet-window]
 *   node scripts/repair-test-phones.mjs --restore <run>                # preview what would come back
 *   node scripts/repair-test-phones.mjs --restore <run> --apply        # re-insert from the snapshot
 *   --hold ORD-1,ORD-2           keep these (listed as held)
 *   --include-pending-altercpa   also delete orders whose AlterCPA lead is still open there
 *
 * Every write runs under SET LOCAL elyon.bulk_repair = 'on' + elyon.keep_updated_at = 'on',
 * in the quiet window (20:55–07:00 Skopje), never while recompute_all_segments runs, and only
 * after the live foreign keys onto orders(id) match the map this script was written against.
 *
 * 🛑 Macedonia only (repair-kit guards). The shop (naturatherapy.mk) is never touched.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  MK_REF, EXPORT_DIR, bold, green, yellow, die, warn, ok,
  mkGuard, sql, sqlRead, assertRemoteIsMk, requireRepairSchema, requireKeepUpdatedAt, requireQuietWindow, requireNoSegmentRecompute,
  q, qUuid, qUuidArray, qTextArray, isUuid, parseArgs, fmtSkopje, fileStamp, writeCsv, candidateHash, planLine,
  resolveActor, recordDryRun, verifyRunForApply, applyChunked, finalizeRun, auditPartial, printTable,
} from './lib/repair-kit.mjs';
import {
  KEY, RESTORE_KEY, TEST_PHONES, TEST_PHONE8S, DEPENDENTS, verifyForeignKeys, classifyTestPhoneOrders,
  orderSnapshotSql, buildDeleteChunkSql, phoneSnapshotSql, buildRestoreSql, depKeySql,
} from './lib/test-phones.mjs';

// ─── loaders (read-only; each SQL is exported so a sandbox runs exactly it) ──
const PHONES_SQL = qTextArray([...TEST_PHONE8S]);

export const ORDERS_SQL = `select o.id, o.display_id, o.status::text as status, o.customer_phone, o.customer_name, o.source_type,
      o.sale_source, o.sale_source_detail, o.external_source, o.external_order_id, o.created_at, o.updated_at,
      o.price::text as price, o.product_name, o.mex_tracking_id, o.assigned_agent_name
    from public.orders o
   where right(regexp_replace(o.customer_phone, '[^0-9]', '', 'g'), 8) = any(${PHONES_SQL})
   order by o.display_id`;
export const loadOrders = (read = sqlRead) => read(ORDERS_SQL);

/** The live foreign keys onto orders(id): [{ tbl, col, rule }]. */
export const FOREIGN_KEYS_SQL = `select c.conrelid::regclass::text as tbl, a.attname as col, c.confdeltype::text as rule, c.conname
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
   where c.contype = 'f' and c.confrelid = 'public.orders'::regclass
   order by 1, 2`;
export const loadForeignKeys = (read = sqlRead) => read(FOREIGN_KEYS_SQL);

/** The DEPENDENTS whose table exists here (a missing soft-reference table is skipped). */
export const presentTablesSql = (tables) => `select jsonb_object_agg(t, to_regclass('public.' || t) is not null) as present
    from unnest(${qTextArray(tables)}) t`;
export async function existingDependents(read = sqlRead) {
  const tables = [...new Set(DEPENDENTS.map((d) => d.table))];
  const [r] = await read(presentTablesSql(tables));
  const present = r?.present || {};
  return { deps: DEPENDENTS.filter((d) => present[d.table]), missing: tables.filter((t) => !present[t]) };
}

/** Every dependent row per order (dry run listing): table, column, FK rule, action, row key. */
export function dependentRowsSql(d, orderIds) {
  const extra = d.where ? ` and ${d.where}` : '';
  return `select x.${d.column} as order_id, ${depKeySql(d)} as key
      from public.${d.table} x where x.${d.column} = any(${qUuidArray(orderIds)})${extra}`;
}
export async function loadDependentRows(deps, orderIds, read = sqlRead) {
  const out = [];
  if (!orderIds.length) return out;
  for (const d of deps) {
    const rows = await read(dependentRowsSql(d, orderIds));
    for (const r of rows) out.push({ table: d.table, column: d.column, fk: d.fk || 'none (soft reference)', action: d.action, order_id: r.order_id, key: r.key });
  }
  return out;
}

export const cpaLeadsSql = (orderIds) => `select l.order_id, l.altercpa_id, l.phase, l.skip_reason, l.created_remote
    from public.altercpa_leads l where l.order_id = any(${qUuidArray(orderIds)})`;
export async function loadCpaLeads(orderIds, read = sqlRead) {
  if (!orderIds.length) return new Map();
  const rows = await read(cpaLeadsSql(orderIds));
  const m = new Map();
  for (const r of rows) (m.get(r.order_id) ?? m.set(r.order_id, []).get(r.order_id)).push(r);
  return m;
}

/** What stays on the phones: web orders, MEX parcels, profiles, segment members — and whether reports can exclude them yet. */
export const PHONE_FACTS_SQL = `select
      (select count(*) from public.web_orders w where w.phone8 = any(${PHONES_SQL}))::int as web_orders,
      (select count(*) from public.mex_parcels p where p.phone8 = any(${PHONES_SQL}))::int as mex_parcels,
      (select count(*) from public.mex_parcels p where p.phone8 = any(${PHONES_SQL}) and p.order_id is not null)::int as mex_parcels_linked,
      (select coalesce(sum(p.cod_mkd) filter (where p.status_id = 2), 0) from public.mex_parcels p where p.phone8 = any(${PHONES_SQL}))::bigint as mex_delivered_cod,
      (select count(*) from public.customer_profiles c where right(regexp_replace(c.phone, '[^0-9]', '', 'g'), 8) = any(${PHONES_SQL}))::int as profiles,
      (select count(*) from public.prediction_segment_members m where right(regexp_replace(m.customer_phone, '[^0-9]', '', 'g'), 8) = any(${PHONES_SQL}))::int as segment_members,
      to_regclass('public.report_excluded_phones') is not null as has_table,
      to_regprocedure('public.is_report_excluded_phone(text)') is not null as has_helper`;
export async function loadPhoneFacts(read = sqlRead) {
  const [r] = await read(PHONE_FACTS_SQL);
  return r;
}

// ─── restore ────────────────────────────────────────────────────────────────
/** Insertable columns (not generated, not dropped) per table + the tables with an ALWAYS identity. */
export const insertableColumnsSql = (tables) => `select c.relname as tbl, a.attname as col, a.attidentity::text as ident
    from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = any(${qTextArray(tables)}) and a.attnum > 0 and not a.attisdropped
     and a.attgenerated = '' order by c.relname, a.attnum`;
export async function loadInsertableColumns(tables, read = sqlRead) {
  const rows = await read(insertableColumnsSql(tables));
  const cols = {}, identity = new Set();
  for (const r of rows) { (cols[r.tbl] ??= []).push(r.col); if (r.ident === 'a') identity.add(r.tbl); }
  return { cols, identity };
}

/** The orders a test-phones run deleted, from its ledger (and whether each exists again). */
export const restoreRowsSql = (runId) => `select r.order_id, r.before->'order'->>'display_id' as display_id, r.before->'order'->>'status' as status,
      r.before->'order'->>'source_type' as source_type, r.before->'order'->>'customer_phone' as phone,
      (select jsonb_object_agg(k, jsonb_array_length(v)) from jsonb_each(r.before->'deps') e(k, v)) as deps,
      exists (select 1 from public.orders o where o.id = r.order_id) as exists_now
    from public.data_repair_rows r
   where r.run_id = ${qUuid(runId)} and r.rule = 'delete' and r.after is not null and r.before->>'kind' = 'deleted_order'
   order by 2`;

async function restore(args) {
  const runId = args.restore;
  if (!isUuid(runId)) die('--restore needs the data_repair_runs id of the applied test-phones run.');
  const APPLY = !!args.apply;
  console.log(bold(`\nRestore of ${KEY} run ${runId} — ${APPLY ? 'APPLY' : 'PREVIEW'}  (${MK_REF})\n`));
  await assertRemoteIsMk();
  await requireRepairSchema({ forApply: APPLY });
  await requireKeepUpdatedAt({ forApply: APPLY });
  const [run] = await sqlRead(`select id, key, applied_at, created_at from public.data_repair_runs where id = ${qUuid(runId)}`);
  if (!run) die(`run ${runId} not found.`);
  if (run.key !== KEY) die(`run ${runId} belongs to "${run.key}", not "${KEY}".`);
  const rows = await sqlRead(restoreRowsSql(runId));
  if (!rows.length) die('this run deleted no order — nothing to restore.');
  const only = new Set(String(args.only || '').split(',').map((s) => s.trim()).filter(Boolean));
  const scope = rows.filter((r) => !r.exists_now && (!only.size || only.has(r.display_id)));
  const back = rows.filter((r) => r.exists_now);
  console.log(`  deleted by the run: ${rows.length} · exist again (skipped): ${back.length} · to restore: ${scope.length}`);
  printTable(scope.slice(0, 50).map((r) => ({ order: r.display_id, status: r.status, source: r.source_type, rows: Object.entries(r.deps || {}).filter(([, n]) => n).map(([k, n]) => `${k.split('.')[0]} ${n}`).join(', ') })));
  if (!APPLY) { console.log(`\nPreview only — nothing written. To restore: node scripts/repair-test-phones.mjs --restore ${runId} --apply${args.only ? ` --only ${args.only}` : ''}\n`); return; }
  if (!scope.length) die('nothing left to restore.');

  requireQuietWindow({ override: !!args['outside-quiet-window'] });
  await requireNoSegmentRecompute('start the restore');
  const actor = await resolveActor(args.actor || 'mile@elyon.com');
  const { deps } = await existingDependents();
  const reinsertTables = ['orders', ...deps.filter((d) => d.snapshot === 'rows' && d.restore?.startsWith('reinsert')).map((d) => d.table)];
  const { cols, identity } = await loadInsertableColumns(reinsertTables);
  const restoreRunId = randomUUID();
  const lines = scope.map((r) => planLine(r.order_id, 'restore', r.status, ''));
  await sql(`insert into public.data_repair_runs (id, key, dry_run, candidate_hash, summary, created_at)
    values (${qUuid(restoreRunId)}, ${q(RESTORE_KEY)}, false, ${q(candidateHash(lines))},
            ${`${q(JSON.stringify({ restored_run: runId, orders_in_scope: scope.length, only: [...only] }))}::jsonb`}, now())`);
  ok(`restore recorded as run ${restoreRunId}`);
  const stats = await applyChunked({
    items: scope.map((r) => r.order_id), label: 'orders',
    build: (ids) => buildRestoreSql({ runId, restoreRunId, orderIds: ids, cols, identity, deps }),
    chunkSize: args.chunk,
  });
  const payload = { restored_run: runId, restored: stats.applied, chunks: `${stats.committed}/${stats.chunks}`, failed: stats.failed };
  await sql(`update public.data_repair_runs set applied_at = now(), applied_by = ${qUuid(actor.id)},
           summary = coalesce(summary, '{}'::jsonb) || jsonb_build_object('apply', ${q(JSON.stringify(payload))}::jsonb)
     where id = ${qUuid(restoreRunId)};
    insert into public.audit_log (actor_id, actor_email, action, target_type, target_id, target_name, payload)
    values (${qUuid(actor.id)}, ${q(actor.email)}, ${q(stats.failed ? 'data_repair.restore_partial' : 'data_repair.restore')},
            'data_repair_run', ${q(runId)}, ${q(KEY)}, ${q(JSON.stringify(payload))}::jsonb);`);
  if (stats.failed) die(`stopped at chunk ${stats.failed.chunk}; earlier chunks are committed. Re-run the same command to continue (restored orders exist again and are skipped).`);
  ok(`restored ${stats.applied} orders from run ${runId}.`);
  console.log(yellow('  The segment engine recomputed each phone on insert. Next: node scripts/engine-fixture-mk.mjs\n'));
}

// ─── main ───────────────────────────────────────────────────────────────────
const USAGE = `usage: node scripts/repair-test-phones.mjs [--hold ORD-1,…] [--include-pending-altercpa]
       node scripts/repair-test-phones.mjs --apply --run <id> [--include-pending-altercpa] [--hold …] [--actor <email>] [--chunk 200] [--outside-quiet-window]
       node scripts/repair-test-phones.mjs --restore <run> [--apply] [--only ORD-1,…] [--actor <email>] [--outside-quiet-window]`;

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    flags: ['apply', 'include-pending-altercpa', 'outside-quiet-window', 'help'],
    values: ['run', 'restore', 'actor', 'chunk', 'hold', 'only'],
  });
  if (args.help) { console.log(USAGE); return; }
  mkGuard();
  if (args.restore) { await restore(args); return; }
  const APPLY = !!args.apply;
  console.log(bold(`\nRepair ${KEY} — delete the test phones' CRM orders — ${APPLY ? 'APPLY' : 'DRY RUN'}  (${MK_REF})`));
  console.log(`  test numbers: ${TEST_PHONES.map((t) => `${t.national} (last 8: ${t.phone8})`).join(', ')}\n`);
  if (APPLY && !args.run) die('--apply needs --run <id> (printed by the dry run).');
  await assertRemoteIsMk();
  await requireRepairSchema({ forApply: APPLY });
  await requireKeepUpdatedAt({ forApply: APPLY });
  const hold = new Set(String(args.hold || '').split(',').map((s) => s.trim()).filter(Boolean));
  const includePendingAltercpa = !!args['include-pending-altercpa'];
  const options = { include_pending_altercpa: includePendingAltercpa, hold: [...hold].sort() };

  // 0. the map this script was written against must be the database's
  const fkProblems = verifyForeignKeys(await loadForeignKeys());
  if (fkProblems.length) {
    const msg = `the foreign keys onto orders(id) differ from scripts/lib/test-phones.mjs DEPENDENTS:\n  - ${fkProblems.join('\n  - ')}`;
    if (APPLY) die(`${msg}\n  Update the map (and its restore) before deleting anything.`);
    warn(`${msg}\n  — fine for a dry run, BLOCKS --apply.`);
  } else ok('the live foreign keys onto orders(id) match the dependent-table map');
  const { deps, missing } = await existingDependents();
  if (missing.length) warn(`tables not present here (skipped): ${missing.join(', ')}`);

  // 1. load
  const orders = await loadOrders();
  const ids = orders.map((o) => o.id);
  const [depRows, cpaLeads, facts] = await Promise.all([loadDependentRows(deps, ids), loadCpaLeads(ids), loadPhoneFacts()]);
  const blocks = new Map();
  for (const r of depRows) if (r.action === 'block') (blocks.get(r.order_id) ?? blocks.set(r.order_id, []).get(r.order_id)).push(r.table);
  ok(`${orders.length} CRM order(s) on the test numbers (last-8 match) · ${depRows.length} dependent row(s)`);

  // 2. classify
  const plan = classifyTestPhoneOrders({ orders, blocks, cpaLeads, hold, includePendingAltercpa });
  const toDelete = plan.rows.filter((r) => r.rule === 'delete');
  const delIds = new Set(toDelete.map((r) => r.id));

  // 3. report
  console.log(bold('\nOrders'));
  printTable(Object.entries(plan.counts).filter(([k]) => k !== 'total').map(([rule, n]) => ({ rule, orders: n })));
  printTable(plan.rows.slice(0, 60).map((r) => ({ order: r.display_id, rule: r.rule, status: r.status, source: r.sale_source || r.source_type, phone: r.customer_phone, created: fmtSkopje(r.created_at), why: r.why })));
  if (plan.rows.length > 60) console.log(`  … ${plan.rows.length - 60} more in the CSV`);
  console.log(bold('\nDependent rows of the orders to delete — and what happens to each'));
  const depTally = {};
  for (const r of depRows.filter((x) => delIds.has(x.order_id))) {
    const k = `${r.table}.${r.column}`;
    depTally[k] ??= { table: k, fk: r.fk, action: r.action, rows: 0 };
    depTally[k].rows++;
  }
  printTable(DEPENDENTS.map((d) => depTally[`${d.table}.${d.column}`] || { table: `${d.table}.${d.column}`, fk: d.fk || 'none (soft reference)', action: d.action, rows: 0 }));
  console.log(bold('\nKept on the phones (the shop and MEX are never touched)'));
  console.log(`  web orders ${facts.web_orders} · MEX parcels ${facts.mex_parcels} (${facts.mex_parcels_linked} linked to an order now; delivered COD ${Number(facts.mex_delivered_cod).toLocaleString('de-DE')} ден)` +
    ` · customer profiles ${facts.profiles} · prediction-list memberships ${facts.segment_members} (the engine drops the non-static ones once no order is left)`);
  console.log(`  report exclusion: ${facts.has_table && facts.has_helper ? green('public.report_excluded_phones + is_report_excluded_phone() are live') : yellow('migration 20260939000700 is NOT applied yet — reports still count these phones')}`);

  const stamp = fileStamp();
  const ordersCsv = writeCsv(`${KEY}-orders-${APPLY ? 'apply-' : ''}${stamp}.csv`, plan.rows.map((r) => ({
    rule: r.rule, why: r.why, order: r.display_id, status: r.status, source: r.sale_source || r.source_type, detail: r.sale_source_detail || '',
    phone: r.customer_phone, phone_form: r.form, customer: r.customer_name, created: fmtSkopje(r.created_at), price_eur: r.price,
    product: r.product_name, tracking: r.mex_tracking_id || '', agent: r.assigned_agent_name || '',
    altercpa: (r.altercpa || []).map((l) => `#${l.altercpa_id} phase ${l.phase ?? '?'}`).join(', '), blocks: (r.blocks || []).join(', '),
  })));
  const byId = new Map(plan.rows.map((r) => [r.id, r.display_id]));
  const depsCsv = writeCsv(`${KEY}-dependents-${APPLY ? 'apply-' : ''}${stamp}.csv`, depRows.map((r) => ({
    order: byId.get(r.order_id) || r.order_id, order_rule: plan.rows.find((x) => x.id === r.order_id)?.rule || '',
    table: r.table, column: r.column, fk_on_delete: r.fk, action: r.action, key: r.key,
  })));
  ok(`CSV (contains PII — stays in exports/, never commit): ${ordersCsv}`);
  ok(`CSV (every dependent row): ${depsCsv}`);

  // 4. dry run → ledger row
  if (!APPLY) {
    if (!plan.lines.length) { console.log(bold('\nNothing to delete — no run recorded.\n')); return; }
    const summary = {
      script: 'repair-test-phones.mjs', options, counts: plan.counts, phones: TEST_PHONE8S,
      dependents: Object.values(depTally), kept_on_phones: facts, fk_problems: fkProblems,
      listed: plan.rows.filter((r) => r.rule !== 'delete').map((r) => ({ order: r.display_id, rule: r.rule, why: r.why })),
      csv: [ordersCsv, depsCsv].map((p) => p.split(/[\\/]/).pop()),
    };
    const { id, hash } = await recordDryRun({ key: KEY, lines: plan.lines, summary });
    console.log(bold(`\nDry run recorded: ${green(id)}`) + `  (hash ${hash.slice(0, 12)}…, ${plan.lines.length} orders to delete)`);
    console.log('Nothing was deleted. After review, in the quiet window (after 20:55 Skopje):');
    console.log('  node scripts/assert-mk-target.mjs');
    console.log(`  node scripts/repair-test-phones.mjs --apply --run ${id}${includePendingAltercpa ? ' --include-pending-altercpa' : ''}${options.hold.length ? ` --hold ${options.hold.join(',')}` : ''}\n`);
    return;
  }

  // 5. apply
  // Order matters: a deleted order's delivered parcel becomes an unlinked, "MEX-only" parcel —
  // counted as MEX-only cash by every report that does not exclude the phone yet.
  if (!facts.has_table || !facts.has_helper) {
    die('migration 20260939000700 (public.report_excluded_phones + is_report_excluded_phone) is not applied —\n' +
      '  apply it FIRST, or the deleted orders\' parcels start counting as MEX-only sales in the reports.');
  }
  requireQuietWindow({ override: !!args['outside-quiet-window'] });
  await requireNoSegmentRecompute('start the apply');
  const actor = await resolveActor(args.actor || 'mile@elyon.com');
  ok(`recorded as ${actor.email}`);
  const { done } = await verifyRunForApply({ key: KEY, runId: args.run, lines: plan.lines, options });
  const todo = toDelete.filter((r) => !done.has(r.id));

  // snapshot FIRST — the same before-image the transaction writes, to a file
  mkdirSync(EXPORT_DIR, { recursive: true });
  const snapRows = todo.length ? await sqlRead(`select o.id, ${orderSnapshotSql('o', deps)} as snapshot
      from public.orders o where o.id = any(${qUuidArray(todo.map((r) => r.id))}) order by o.display_id`) : [];
  const preFile = join(EXPORT_DIR, `${KEY}-snapshot-${String(args.run).slice(0, 8)}-${stamp}.json`);
  writeFileSync(preFile, JSON.stringify({ run: args.run, taken_at: new Date().toISOString(), phones: TEST_PHONE8S, orders: snapRows }, null, 1));
  ok(`snapshot of ${snapRows.length} order(s) + every dependent row written BEFORE deleting: ${preFile}`);
  if (snapRows.length !== todo.length) die(`the snapshot has ${snapRows.length} of ${todo.length} orders — some changed since the classification; re-run.`);
  await sql(phoneSnapshotSql({ runId: args.run }));

  console.log(bold(`\nDeleting ${todo.length} order(s)`));
  const stats = await applyChunked({
    items: todo.map((r) => ({ order_id: r.id, expect_status: r.status, expect_phone: r.customer_phone, expect_tracking: r.mex_tracking_id ?? null, rule: 'delete',
      evidence: { key: KEY, order: r.display_id, phone8: r.phone8, status: r.status, source: r.sale_source || r.source_type, line: planLine(r.id, 'delete', r.status, r.phone8) } })),
    build: (chunk) => buildDeleteChunkSql({ runId: args.run, rows: chunk, deps }),
    chunkSize: args.chunk,
  });
  const payload = {
    script: 'repair-test-phones.mjs', options, counts: plan.counts, deleted: stats.applied, skipped_moved: stats.skipped,
    chunks: `${stats.committed}/${stats.chunks}`, resumed_from: done.size, snapshot_file: preFile.split(/[\\/]/).pop(),
    outside_quiet_window: !!args['outside-quiet-window'],
  };
  if (stats.failed) {
    await auditPartial({ key: KEY, runId: args.run, actor, payload: { ...payload, failed: stats.failed } });
    die(`Stopped at chunk ${stats.failed.chunk}; ${stats.committed} chunk(s) committed and are in the ledger.\n` +
      '  Fix the cause, then re-run the same --apply command: it resumes after the committed chunks.');
  }
  await finalizeRun({ key: KEY, runId: args.run, actor, payload });

  // the ledger's own copy, as committed
  const ledger = await sqlRead(`select order_id, rule, before, after, evidence, created_at from public.data_repair_rows
    where run_id = ${qUuid(args.run)} order by id`);
  const ledgerFile = join(EXPORT_DIR, `${KEY}-ledger-${String(args.run).slice(0, 8)}-${fileStamp()}.json`);
  writeFileSync(ledgerFile, JSON.stringify({ run: args.run, rows: ledger }, null, 1));
  ok(`run ${args.run} applied — ${stats.applied} order(s) deleted${stats.skipped.length ? `, ${stats.skipped.length} left alone (changed since the dry run)` : ''}`);
  ok(`ledger copy: ${ledgerFile}`);

  // 6. verify
  const [v] = await sqlRead(`select
      (select count(*) from public.orders o where right(regexp_replace(o.customer_phone, '[^0-9]', '', 'g'), 8) = any(${PHONES_SQL}))::int as orders_left,
      (select count(*) from public.data_repair_rows where run_id = ${qUuid(args.run)} and rule = 'delete' and after is not null)::int as ledger_rows,
      (select count(*) from public.mex_parcels p where p.phone8 = any(${PHONES_SQL}) and p.order_id is not null)::int as parcels_still_linked,
      (select count(*) from public.prediction_segment_members m where right(regexp_replace(m.customer_phone, '[^0-9]', '', 'g'), 8) = any(${PHONES_SQL}))::int as segment_members_left`);
  console.log(bold('\nVerification'));
  printTable([v]);
  console.log(`  orders left on the phones: ${v.orders_left} (expected = the ${plan.rows.length - toDelete.length} listed + ${stats.skipped.length} left alone)`);
  console.log(yellow(`  Undo: node scripts/repair-test-phones.mjs --restore ${args.run} [--apply]`));
  console.log(yellow('  Next: node scripts/engine-fixture-mk.mjs; apply 20260939000700 if the report exclusion is not live yet.\n'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => die(e.stack || e.message || String(e)));
}
