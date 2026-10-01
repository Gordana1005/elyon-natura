/**
 * collabBox credit re-run — the LIVE apply/credit path again for the Нарачка LEADS documents stuck at outcome
 * 'credit_pending' (owner, Mile, 01.10.2026). No shebang (repair-kit convention). Run with `node`.
 *
 * WHY: a LEADS (10111, role 'credit') document never becomes an order — it credits the order HOLDING its
 * parcel. While no order held the parcel it was recorded credit_pending (reason parcel_not_linked_yet /
 * no_parcel_yet), and public.collabbox_retry_open() re-tries only documents dated within the last 14 days, so
 * September's would never be credited once scripts/repair-link-lead-parcels.mjs links their parcels.
 * This tool re-runs exactly what the nightly retry runs — public.collabbox_apply_documents(run, payloads, dry),
 * i.e. the LIVE collabbox_apply_one → collabbox_credit_order (sold_at = the booking day, collabbox_sale_at(doc_at,
 * booked_at), 20260944000500/0600; its closed-month rule unchanged) — for a date range of your choosing, with the
 * stored payloads. Neither function is changed or re-implemented here.
 *
 *   node scripts/collabbox-recredit.mjs [--from 2026-09-01] [--to <today>] [--reasons parcel_not_linked_yet[,no_parcel_yet]] [--all]
 *        DRY RUN: read-only through the writer's own dry path (p_dry = true writes nothing) → CSV + a
 *        data_repair_runs dry-run row (key collabbox-recredit) + the run id. Default scope: credit_pending
 *        documents (reason parcel_not_linked_yet) dated in the range whose parcel an order holds NOW; --all
 *        re-runs every pending document in the range (the unheld ones simply stay pending).
 *   node scripts/collabbox-recredit.mjs --apply --run <id> [the same flags] [--actor mile@elyon.com] [--outside-quiet-window]
 *        one collabbox_sync_runs row (kind manual, status running → ok), batches of 40 through
 *        collabbox_apply_documents(run, …, false); every holder's sold_* and the document's outcome before/after in
 *        data_repair_rows. Refuses while a collabBox pass runs (one run at a time) and outside 20:55–07:00.
 *   node scripts/collabbox-recredit.mjs --rollback <id> [--apply] [--actor mile@elyon.com]
 *        the credits back (sold_* cleared under elyon.allow_sold_change) and the documents back to credit_pending —
 *        only where both still equal what the re-run wrote.
 *
 * Run it AFTER scripts/repair-link-lead-parcels.mjs --apply (before that, September's parcels have no holder).
 * 🛑 Macedonia only (repair-kit guards). collabbox_apply_one / collabbox_credit_order are another session's —
 * never modified here.
 */
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  ROOT, MK_REF, bold, green, yellow, die, warn, ok,
  mkGuard, sql, sqlRead, assertRemoteIsMk, requireKeepUpdatedAt, requireQuietWindow, requireNoSegmentRecompute,
  q, qUuid, qJson, qTextArray, parseArgs, isUuid, fmtSkopje, fmtSkopjeDate, fileStamp, writeCsv, candidateHash,
  resolveActor, recordDryRun, printTable, tally, canonicalJson,
} from './lib/repair-kit.mjs';
import { RECREDIT_KEY, skopjeDayRange, recreditBucket, readMigration, PLAN_MIGRATION, inlinePlanSql, rpcPlanSql, planOf, PLAN_SIG } from './lib/link-lead-parcels.mjs';

const BATCH = 40;   // the edge function's own batch (service_role statement_timeout 30 s)
const skopjeToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Skopje' }).format(new Date());
const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

/** The holder of a document's parcel, exactly as collabbox_apply_one's role 'credit' branch finds it. */
const HOLDER_SQL = `coalesce(p.order_id, (select case when count(*) = 1 then (array_agg(o.id))[1] end
                                            from public.orders o where o.mex_tracking_id = d.doc_number))`;

/** sold_* of the holder + the ledger row of the document — what a re-run may change. */
const snapSql = (holder, doc) => `jsonb_build_object(
    'sold_at', (select o.sold_at from public.orders o where o.id = ${holder}),
    'sold_via', (select o.sold_via from public.orders o where o.id = ${holder}),
    'sold_by_ext', (select o.sold_by_ext from public.orders o where o.id = ${holder}),
    'sold_by_person_id', (select o.sold_by_person_id from public.orders o where o.id = ${holder}),
    'doc', (select jsonb_build_object('outcome', d.outcome, 'reason', d.reason, 'credit', d.credit,
                                      'related_order_id', d.related_order_id) from public.collabbox_documents d where d.doc_number = ${doc}))`;

export function scopeSql({ from, to, reasons, all }) {
  const r = skopjeDayRange(from, to);
  return `select d.doc_number, d.doc_at, d.booked_at, d.reason, d.author, d.payload is not null as has_payload,
       ${HOLDER_SQL} as holder,
       (select o.display_id from public.orders o where o.id = ${HOLDER_SQL}) as holder_display,
       (select o.sold_at is not null or o.sold_via is not null from public.orders o where o.id = ${HOLDER_SQL}) as holder_stamped
  from public.collabbox_documents d
  left join public.mex_parcels p on p.tracking_id = d.doc_number
 where d.outcome = 'credit_pending' and d.role = 'credit'
   and d.reason = any(${qTextArray(reasons)})
   and d.doc_at >= ${r.fromSql} and d.doc_at < ${r.toSql}
   and d.vanished_at is null and d.payload is not null
   ${all ? '' : `and ${HOLDER_SQL} is not null`}
 order by d.doc_at, d.doc_number`;
}

/** ONE batch = ONE transaction (one API call, the kit's buildChunkSql contract): the holders' sold_* and the
 *  documents before → the LIVE writer collabbox_apply_documents(syncRun, payloads, false) → after. */
export function buildRecreditBatchSql({ runId, syncRun, docNumbers }) {
  return `
set local statement_timeout = '120s';
set local lock_timeout = '20s';
set local timezone = 'UTC';
create temp table _rc on commit drop as
select d.doc_number, d.doc_at, d.payload, ${HOLDER_SQL} as holder
  from public.collabbox_documents d left join public.mex_parcels p on p.tracking_id = d.doc_number
 where d.doc_number = any(${qTextArray(docNumbers)}) and d.outcome = 'credit_pending';
insert into public.data_repair_rows (run_id, order_id, rule, before, evidence)
select ${qUuid(runId)}, r.holder, 'collabbox_recredit', ${snapSql('r.holder', 'r.doc_number')},
       jsonb_build_object('doc', r.doc_number, 'sync_run', ${q(syncRun)}, 'unit', 'rc:' || r.doc_number,
                          'line', r.doc_number || ':recredit:' || coalesce(r.holder::text, '') || ':')
  from _rc r;
create temp table _res on commit drop as
select public.collabbox_apply_documents(${qUuid(syncRun)},
         (select coalesce(jsonb_agg(r.payload order by r.doc_at, r.doc_number), '[]'::jsonb) from _rc r), false) as res;
update public.data_repair_rows x
   set after = ${snapSql('r.holder', 'r.doc_number')},
       evidence = x.evidence || jsonb_build_object('result',
         (select e from _res, jsonb_array_elements(_res.res -> 'results') e where e ->> 'doc' = r.doc_number limit 1))
  from _rc r
 where x.run_id = ${qUuid(runId)} and x.evidence ->> 'doc' = r.doc_number and x.after is null;
select (select count(*) from _rc)::int as planned, (select res -> 'outcomes' from _res) as outcomes;`;
}

/** The rows of an applied re-run whose holder + document still equal what the re-run wrote ("same"). */
export const rollbackCheckSql = (runId) => `select x.id, x.order_id, x.evidence ->> 'doc' as doc, x.before, x.after,
      (${snapSql('x.order_id', "(x.evidence ->> 'doc')")}) = x.after as same
    from public.data_repair_rows x where x.run_id = ${qUuid(runId)} and x.after is not null and x.before is distinct from x.after`;

/** The undo, ONE transaction: sold_* back (elyon.allow_sold_change), the documents back to credit_pending. */
export function buildRecreditRollbackSql({ runId, rbRunId, actor }) {
  const rb = rbRunId;
  const check = rollbackCheckSql(runId);
  return `
set local elyon.bulk_repair = 'on';
set local elyon.keep_updated_at = 'on';
set local elyon.allow_sold_change = 'on';
set local timezone = 'UTC';
create temp table _rb on commit drop as
${check};
delete from _rb where not same;
update public.orders o
   set sold_at = (b.before ->> 'sold_at')::timestamptz, sold_via = b.before ->> 'sold_via',
       sold_by_ext = b.before ->> 'sold_by_ext', sold_by_person_id = (b.before ->> 'sold_by_person_id')::uuid
  from _rb b where o.id = b.order_id;
update public.collabbox_documents d
   set outcome = b.before -> 'doc' ->> 'outcome', reason = b.before -> 'doc' ->> 'reason', credit = b.before -> 'doc' ->> 'credit',
       related_order_id = (b.before -> 'doc' ->> 'related_order_id')::uuid, updated_at = now()
  from _rb b where d.doc_number = b.doc;
insert into public.data_repair_rows (run_id, order_id, rule, before, after, evidence)
select ${qUuid(rb)}, b.order_id, 'rollback:collabbox_recredit', b.after, b.before, jsonb_build_object('doc', b.doc, 'rolled_back_run', ${q(runId)}) from _rb b;
insert into public.audit_log (actor_id, actor_email, action, target_type, target_id, target_name, payload)
values (${qUuid(actor.id)}, ${q(actor.email)}, 'data_repair.rollback', 'data_repair_run', ${q(runId)}, ${q(RECREDIT_KEY)},
        jsonb_build_object('rollback_run', ${q(rb)}, 'restored', (select count(*) from _rb)));
select (select count(*) from _rb)::int as restored;`;
}

export const recreditLines = (docs) => docs.map((d) => `${d.doc_number}:recredit:${d.holder ?? ''}:`);

function parseOpts(args) {
  const from = args.from || '2026-09-01';
  const to = args.to || skopjeToday();
  const reasons = String(args.reasons || 'parcel_not_linked_yet').split(',').map((s) => s.trim()).filter(Boolean);
  if (reasons.some((x) => !['parcel_not_linked_yet', 'no_parcel_yet'].includes(x))) die('--reasons: parcel_not_linked_yet and/or no_parcel_yet');
  skopjeDayRange(from, to);
  return { from, to, reasons, all: !!args.all };
}

async function dryRun(opts) {
  const docs = await sqlRead(scopeSql(opts));
  const range = await sqlRead(scopeSql({ ...opts, all: true }));
  console.log(`  credit_pending (${opts.reasons.join(', ')}) dated ${opts.from} … ${opts.to}: ${range.length} documents; ` +
    `${range.filter((d) => d.holder).length} have a holder NOW${opts.all ? '' : ' (the scope)'}`);

  // what the link backfill will give a holder (its plan — live function, or the migration file before it exists)
  const [fn] = await sqlRead(`select to_regprocedure(${q(PLAN_SIG)}) is not null as live`);
  const [pr] = await sqlRead(fn?.live ? rpcPlanSql(75) : inlinePlanSql(readMigration(ROOT, PLAN_MIGRATION), 75));
  const plan = planOf(pr);
  const planned = new Map((plan?.link ?? []).map((l) => [l.tracking_id, l]));
  const waiting = range.filter((d) => !d.holder && planned.has(d.doc_number));
  const stampedIds = waiting.length ? new Set((await sqlRead(`select id from public.orders where id = any(array[${waiting.map((d) => qUuid(planned.get(d.doc_number).order_id)).join(',')}])
      and (sold_at is not null or sold_via is not null)`)).map((r) => r.id)) : new Set();
  const willCredit = waiting.filter((d) => !stampedIds.has(planned.get(d.doc_number).order_id)).length;
  console.log(`  of the unheld ones, the link plan (${fn?.live ? 'live' : 'migration file'}) gives ${waiting.length} a holder; ` +
    `${willCredit} of those orders carry no sold stamp yet → credited by a re-run AFTER the backfill (estimate), ` +
    `${waiting.length - willCredit} already stamped → 'recorded'`);

  // the live writer's own dry path (p_dry = true writes nothing). supabase_read_only_user may not execute the
  // writer, so it runs on the privileged path inside a READ ONLY transaction — PostgreSQL refuses any write.
  const results = [];
  for (let i = 0; i < docs.length; i += BATCH) {
    const chunk = docs.slice(i, i + BATCH).map((d) => d.doc_number);
    const [r] = await sql(`set transaction read only;
      select public.collabbox_apply_documents(null, (select coalesce(jsonb_agg(d.payload order by d.doc_at, d.doc_number), '[]'::jsonb)
        from public.collabbox_documents d where d.doc_number = any(${qTextArray(chunk)})), true) as res`);
    results.push(...(parse(r.res)?.results ?? []));
  }
  const byDoc = new Map(results.map((x) => [x.doc, x]));
  const rows = docs.map((d) => ({ doc: d.doc_number, doc_day: fmtSkopjeDate(d.doc_at), booked: fmtSkopje(d.booked_at), reason_now: d.reason,
    holder: d.holder_display ?? '', holder_stamped: d.holder_stamped ? 'yes' : 'no', would_be: recreditBucket(byDoc.get(d.doc_number)),
    sale_at: fmtSkopje(byDoc.get(d.doc_number)?.sale_at) }));
  printTable(Object.entries(tally(rows, (x) => x.would_be)).map(([k, v]) => ({ 'the live path would answer': k, documents: v.orders })));
  return { docs, rows, range: range.length, held: range.filter((d) => d.holder).length, plan_waiting: waiting.length, plan_will_credit: willCredit };
}

async function apply(opts, args) {
  requireQuietWindow({ override: !!args['outside-quiet-window'] });
  await requireKeepUpdatedAt({ forApply: true });
  await requireNoSegmentRecompute('start the re-run');
  const [busy] = await sqlRead(`select count(*)::int n from public.collabbox_sync_runs where status = 'running' and started_at > now() - interval '20 minutes'`);
  if (busy.n) die('a collabBox pass is running (collabbox_sync_runs) — one run at a time; retry when it finished.');
  const [run] = await sqlRead(`select id, key, dry_run, candidate_hash, summary, applied_at from public.data_repair_runs where id = ${qUuid(args.run)}`);
  if (!run || run.key !== RECREDIT_KEY || !run.dry_run || run.applied_at) die(`run ${args.run} is not an unapplied ${RECREDIT_KEY} dry run.`);
  if (canonicalJson(run.summary?.options ?? {}) !== canonicalJson(opts)) die(`run ${args.run} was dry-run with ${canonicalJson(run.summary?.options)} — pass the same flags.`);
  const docs = await sqlRead(scopeSql(opts));
  if (candidateHash(recreditLines(docs)) !== run.candidate_hash) die('the documents (or their holders) changed since the dry run — dry-run again.');
  ok(`hash matches the dry run — ${docs.length} documents`);
  const actor = await resolveActor(args.actor || 'mile@elyon.com');
  const types = [...new Set((await sqlRead(`select distinct doc_type_id from public.collabbox_documents where doc_number = any(${qTextArray(docs.map((d) => d.doc_number))})`)).map((r) => r.doc_type_id))];
  const t0 = Date.now();
  const [sr] = await sql(`insert into public.collabbox_sync_runs (kind, trigger_kind, status, window_from, window_to, doc_types, stats)
    values ('manual', 'manual', 'running', ${q(opts.from)}::date, ${q(opts.to)}::date, ${qTextArray(types)},
            ${qJson({ tool: 'scripts/collabbox-recredit.mjs', repair_run: args.run })}) returning id`);
  const syncRun = sr.id;
  ok(`collabbox_sync_runs ${syncRun} (manual, running)`);
  const outcomes = {};
  let failed = null;
  for (let i = 0; i < docs.length; i += BATCH) {
    const chunk = docs.slice(i, i + BATCH).map((d) => d.doc_number);
    process.stdout.write(`  batch ${i / BATCH + 1}/${Math.ceil(docs.length / BATCH)} (${chunk.length}) … `);
    try {
      const [r] = await sql(buildRecreditBatchSql({ runId: args.run, syncRun, docNumbers: chunk }));
      const oc = parse(r.outcomes) ?? {};
      for (const [k, v] of Object.entries(oc)) outcomes[k] = (outcomes[k] || 0) + Number(v);
      console.log(`${green('committed')} ${JSON.stringify(oc)}`);
    } catch (e) {
      console.log('FAILED — rolled back');
      failed = String(e.message || e).slice(0, 1500);
      console.error(failed);
      break;
    }
  }
  await sql(`update public.collabbox_sync_runs set status = ${q(failed ? 'failed' : 'ok')}, error = ${q(failed)},
      finished_at = now(), duration_ms = ${Date.now() - t0}, stats = stats || ${qJson({ outcomes })} where id = ${qUuid(syncRun)}`);
  const payload = { script: 'collabbox-recredit.mjs', options: opts, sync_run: syncRun, outcomes, failed };
  if (failed) {
    await sql(`insert into public.audit_log (actor_id, actor_email, action, target_type, target_id, target_name, payload)
      values (${qUuid(actor.id)}, ${q(actor.email)}, 'data_repair.apply_partial', 'data_repair_run', ${q(args.run)}, ${q(RECREDIT_KEY)}, ${qJson(payload)})`);
    die('stopped — the committed batches are in the ledger; dry-run again for the rest.');
  }
  await sql(`update public.data_repair_runs set applied_at = now(), applied_by = ${qUuid(actor.id)},
      summary = coalesce(summary, '{}'::jsonb) || jsonb_build_object('apply', ${qJson(payload)}) where id = ${qUuid(args.run)} and applied_at is null;
    insert into public.audit_log (actor_id, actor_email, action, target_type, target_id, target_name, payload)
    values (${qUuid(actor.id)}, ${q(actor.email)}, 'data_repair.apply', 'data_repair_run', ${q(args.run)}, ${q(RECREDIT_KEY)}, ${qJson(payload)});`);
  ok(`re-run ${args.run} applied: ${JSON.stringify(outcomes)} — undo: node scripts/collabbox-recredit.mjs --rollback ${args.run}`);
}

async function rollback(args) {
  const runId = args.rollback;
  if (!isUuid(runId)) die('--rollback needs the applied run id.');
  const [run] = await sqlRead(`select id, key, applied_at from public.data_repair_runs where id = ${qUuid(runId)}`);
  if (!run || run.key !== RECREDIT_KEY) die(`run ${runId} is not a ${RECREDIT_KEY} run.`);
  // restorable = the holder's sold_* and the document still exactly as the re-run left them
  const check = rollbackCheckSql(runId);
  const rows = await sqlRead(`set local timezone = 'UTC';\n${check}`);   // the snapshots were written in UTC
  const same = rows.filter((r) => r.same);
  console.log(`  changed by the re-run: ${rows.length} · restorable (unchanged since): ${same.length} · left alone: ${rows.length - same.length}`);
  if (!args.apply) { console.log(`\nPreview only. To restore: node scripts/collabbox-recredit.mjs --rollback ${runId} --apply\n`); return; }
  await requireKeepUpdatedAt({ forApply: true });
  const actor = await resolveActor(args.actor || 'mile@elyon.com');
  const rb = randomUUID();
  await sql(`insert into public.data_repair_runs (id, key, dry_run, candidate_hash, summary)
    values (${qUuid(rb)}, ${q(`rollback-${RECREDIT_KEY}`)}, false, ${q(candidateHash(same.map((r) => `${r.doc}:rollback::`)))}, ${qJson({ rolled_back_run: runId })})`);
  const [res] = await sql(buildRecreditRollbackSql({ runId, rbRunId: rb, actor }));
  ok(`restored ${res.restored} documents / credits (rollback run ${rb})`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    flags: ['apply', 'all', 'outside-quiet-window', 'help'], values: ['run', 'from', 'to', 'reasons', 'actor', 'rollback'],
  });
  if (args.help) { console.log('see the header of scripts/collabbox-recredit.mjs'); return; }
  mkGuard();
  console.log(bold(`\ncollabBox credit re-run — ${args.rollback ? 'ROLLBACK' : args.apply ? 'APPLY' : 'DRY RUN (read-only)'}  (${MK_REF})\n`));
  await assertRemoteIsMk();
  if (args.rollback) { await rollback(args); return; }
  const opts = parseOpts(args);
  if (args.apply) {
    if (!isUuid(args.run)) die('--apply needs --run <id> (printed by the dry run).');
    await apply(opts, args);
    return;
  }
  const d = await dryRun(opts);
  const csvPath = writeCsv(`${RECREDIT_KEY}-${fileStamp()}.csv`, d.rows);
  ok(`CSV: ${csvPath}`);
  const lines = recreditLines(d.docs);
  const { id } = await recordDryRun({ key: RECREDIT_KEY, lines, summary: { script: 'collabbox-recredit.mjs', options: opts,
    in_range: d.range, held_now: d.held, scope: d.docs.length, plan_waiting: d.plan_waiting, plan_will_credit: d.plan_will_credit,
    would_be: tally(d.rows, (x) => x.would_be), csv: csvPath.split(/[\\/]/).pop() } });
  console.log(bold(`\nDry run recorded: ${green(id)}`) + `\n  node scripts/collabbox-recredit.mjs --apply --run ${id}` +
    `${opts.from !== '2026-09-01' ? ` --from ${opts.from}` : ''}${args.to ? ` --to ${opts.to}` : ''}${args.reasons ? ` --reasons ${args.reasons}` : ''}${opts.all ? ' --all' : ''}\n` +
    (d.plan_waiting ? yellow(`  ${d.plan_waiting} more documents get a holder from the link backfill — run that first, then dry-run this again.\n`) : ''));
  if (!args.to) warn(`--to defaulted to today (${opts.to}); the apply must pass --to ${opts.to} if it runs on another day.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => die(e.stack || e.message || String(e)));
}
