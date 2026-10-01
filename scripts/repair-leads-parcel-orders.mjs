/**
 * Backfill — a CRM order from a collabBox "Нарачка LEADS" (10111) document when MEX really delivered or returned its
 * 9110 parcel and no order holds it (owner, Mile, 01.10.2026). No shebang (repair-kit convention: the test suite
 * imports this file). Run with `node`.
 *
 * OWNER (verbatim): "If there is delivery from MEX too or return, then of course we will import them, that way we know
 * that MEX really tried to deliver that order." The truth is MEX (+ collabBox), never AlterCPA; nothing is pushed to
 * AlterCPA.
 *
 * THE RULES ARE NOT IN THIS FILE. They are public.leads_parcel_orders_plan(days) — migration
 * 20260944000970_leads_parcel_orders.sql — the very SELECT the nightly cron (leads_parcel_orders_nightly, 21:06
 * Skopje) runs:
 *   mode rpc     the function exists (and equals the file) → `select public.leads_parcel_orders_plan(days)`
 *   mode inline  before the migration → the migration FILE's plan body as one read-only SELECT (--inline forces it)
 * In short: a 9110 parcel MEX delivered (2) / returned (7), COD > 0, last 75 days, no order holds or names it, not a
 * test phone + its 10111 document (credit_pending, lines read, value > 0) → one order made from the document, unless
 * the phone + date linker (link_lead_parcels_plan) has a row for the parcel, an Affiliate sale is alive on the phone
 * (parcel − 30 d … + 1 d — a re-ship / the same lead: scripts/repair-link-elyon-parcels.mjs), or the writer's
 * possible_twin_crm_sale rule fits. In-transit parcels wait: they qualify once MEX delivers or returns them.
 * 9103 (LEADS-OUT, 10114) is the live writer's own job (role order_unless_held) — reported here, never touched.
 *
 *   node scripts/repair-leads-parcel-orders.mjs [--days 75] [--inline] [--expect parcels=213,create=121,manual=92]
 *        dry run (read-only + one data_repair_runs dry-run row) → CSV in exports/repairs (PII) + the run id
 *   node scripts/repair-leads-parcel-orders.mjs --apply --run <id> [--days 75] [--actor mile@elyon.com] [--outside-quiet-window]
 *        needs migration 20260944000970; calls public.leads_parcel_orders(true, days, run, hash) — refused unless the
 *        plan still hashes to the reviewed run; ONE transaction, one sub-transaction per order
 *   node scripts/repair-leads-parcel-orders.mjs --switch apply|report|off [--actor mile@elyon.com]
 *        the nightly cron's owner switch (app_settings.leads_parcel_orders.mode) + one audit_log row
 *   node scripts/repair-leads-parcel-orders.mjs --rollback <run> [--apply] [--actor mile@elyon.com]
 *        undo ONE run (backfill or a nightly cron apply): the orders it made are deleted while still exactly as made,
 *        their collabBox ledger rows go back to credit_pending. rollback-repair.mjs refuses this key.
 *
 * 🛑 Macedonia only (repair-kit guards). Payout / bonus math untouched.
 */
import { randomUUID, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  ROOT, MK_REF, bold, green, yellow, die, warn, ok,
  mkGuard, sql, sqlRead, assertRemoteIsMk, requireRepairSchema, requireKeepUpdatedAt, requireQuietWindow,
  requireNoSegmentRecompute, q, qUuid, qJson, parseArgs, parseExpect, checkDrift, expectString, isUuid,
  fmtMkd, fileStamp, writeCsv, resolveActor, recordDryRun, printTable, candidateHash,
} from './lib/repair-kit.mjs';
import { readMigration, functionBody } from './lib/link-lead-parcels.mjs';
import {
  KEY, MIGRATION, PLAN_SIG, APPLY_SIG, DEFAULT_DAYS, EXPECTED, inlinePlanSql, rpcPlanSql, planOf, planHashParity,
  planCsvRows, createTables, rollbackCheckSql, buildRollbackSql,
} from './lib/leads-parcel-orders.mjs';

const md5 = (s) => createHash('md5').update(String(s).replace(/\r/g, '')).digest('hex');
const SEPTEMBER = '2026-09';

/** Which body runs: the live function, or the migration file's (inline). */
export async function resolveMode({ forceInline = false } = {}) {
  const fileText = readMigration(ROOT, MIGRATION);
  const fileBody = functionBody(fileText, 'FUNCTION public.leads_parcel_orders_plan(', '$plan$');
  const [s] = await sqlRead(`select to_regprocedure(${q(PLAN_SIG)}) is not null as live,
      (select md5(replace(p.prosrc, chr(13), '')) from pg_proc p where p.oid = to_regprocedure(${q(PLAN_SIG)})) as live_md5,
      to_regprocedure(${q(APPLY_SIG)}) is not null as apply_fn`);
  return { live: !!s?.live, applyFn: !!s?.apply_fn, liveMd5: s?.live_md5 ?? null, fileMd5: md5(fileBody), fileText,
    mode: s?.live && !forceInline ? 'rpc' : 'inline' };
}

export async function loadPlan({ mode, fileText, days }) {
  const [row] = await sqlRead(mode === 'rpc' ? rpcPlanSql(days) : inlinePlanSql(fileText, days));
  const plan = planOf(row);
  if (!plan || !Array.isArray(plan.create)) die('the plan came back empty — check the migration body.');
  return plan;
}

/** person id → display name, for every seller the plan names. */
export async function loadNames(ids) {
  const list = [...new Set(ids.filter(isUuid))];
  if (!list.length) return new Map();
  const rows = await sqlRead(`select id, display_name from public.sales_people where id = any(array[${list.map(qUuid).join(',')}])`);
  return new Map(rows.map((r) => [r.id, r.display_name]));
}

/** Read-only: the 9103 (LEADS-OUT) parcels in the same situation — the live writer's job, reported only. */
export const LEADS_OUT_SQL = (days) => `select p.status_id, coalesce(d.outcome, 'no document') as outcome, coalesce(d.reason, '') as reason,
       count(*)::int as parcels, coalesce(sum(p.cod_mkd), 0)::int as cod_mkd
  from public.mex_parcels p
  left join public.collabbox_documents d on d.doc_number = p.tracking_id
 where p.series = '9103' and p.status_id in (2, 7) and p.order_id is null and coalesce(p.cod_mkd, 0) > 0
   and p.created_at_mex >= now() - make_interval(days => ${Number(days)})
   and not exists (select 1 from public.orders n where n.mex_tracking_id = p.tracking_id)
 group by 1, 2, 3 order by 1, 4 desc`;

async function switchMode(args) {
  const mode = String(args.switch);
  if (!['apply', 'report', 'off'].includes(mode)) die('--switch takes apply | report | off');
  const actor = await resolveActor(args.actor || 'mile@elyon.com');
  const [cur] = await sqlRead(`select value from public.app_settings where key = 'leads_parcel_orders'`);
  if (!cur) die('app_settings.leads_parcel_orders is missing — apply migration 20260944000970 first.');
  const before = typeof cur.value === 'string' ? JSON.parse(cur.value) : cur.value;
  const after = { ...before, mode };
  await sql(`update public.app_settings set value = ${qJson(after)} where key = 'leads_parcel_orders';
    insert into public.audit_log (actor_id, actor_email, action, target_type, target_id, target_name, payload)
    values (${qUuid(actor.id)}, ${q(actor.email)}, 'settings.update', 'app_settings', 'leads_parcel_orders', 'leads_parcel_orders',
            ${qJson({ before, after, via: 'scripts/repair-leads-parcel-orders.mjs --switch' })});`);
  ok(`app_settings.leads_parcel_orders.mode: ${before.mode ?? '(unset)'} → ${mode} (audit_log row written, actor ${actor.email})`);
}

async function rollback(args) {
  const runId = args.rollback;
  if (!isUuid(runId)) die('--rollback needs the applied run id.');
  const [run] = await sqlRead(`select id, key, dry_run, applied_at from public.data_repair_runs where id = ${qUuid(runId)}`);
  if (!run || run.key !== KEY) die(`run ${runId} is not a ${KEY} run.`);
  const rows = await sqlRead(rollbackCheckSql(runId));
  const same = rows.filter((r) => r.same);
  console.log(`  orders the run made: ${rows.length} · still exactly as made (restorable): ${same.length} · left alone: ${rows.length - same.length}`);
  for (const r of rows.filter((x) => !x.same).slice(0, 30)) console.log(`    ${r.display_id ?? r.order_id} ${r.doc}: ${r.exists ? 'changed since' : 'gone'}`);
  if (!args.apply) { console.log(`\nPreview only. To undo: node scripts/repair-leads-parcel-orders.mjs --rollback ${runId} --apply\n`); return; }
  requireQuietWindow({ override: !!args['outside-quiet-window'] });
  await requireKeepUpdatedAt({ forApply: true });
  await requireNoSegmentRecompute('start the rollback');
  const actor = await resolveActor(args.actor || 'mile@elyon.com');
  const rb = randomUUID();
  await sql(`insert into public.data_repair_runs (id, key, dry_run, candidate_hash, summary)
    values (${qUuid(rb)}, ${q(`rollback-${KEY}`)}, false, ${q(candidateHash(same.map((r) => `${r.order_id}:rollback:deleted:${r.doc}`)))},
            ${qJson({ rolled_back_run: runId })})`);
  const [res] = await sql(buildRollbackSql({ runId, rbRunId: rb, actor }));
  await sql(`update public.data_repair_runs set applied_at = now(), applied_by = ${qUuid(actor.id)},
      summary = summary || ${qJson({ restored: res.restored, skipped: res.skipped })} where id = ${qUuid(rb)}`);
  ok(`undone: ${res.restored} orders deleted and their ledger rows restored (rollback run ${rb}); left alone: ${(res.skipped || []).length}`);
  console.log(yellow('  Next: node scripts/engine-fixture-mk.mjs · node scripts/verify-folder-orders.mjs\n'));
}

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    flags: ['apply', 'inline', 'outside-quiet-window', 'help'], values: ['run', 'expect', 'actor', 'days', 'switch', 'rollback'],
  });
  if (args.help) { console.log('see the header of scripts/repair-leads-parcel-orders.mjs'); return; }
  mkGuard();
  const APPLY = !!args.apply;
  const days = args.days ? Number(args.days) : DEFAULT_DAYS;
  if (!Number.isInteger(days) || days < 1 || days > 400) die('--days must be an integer 1…400');
  console.log(bold(`\nBackfill — ${KEY} — ${args.rollback ? 'ROLLBACK' : args.switch ? 'SWITCH' : APPLY ? 'APPLY' : 'DRY RUN'}  (${MK_REF})\n`));
  await assertRemoteIsMk();
  if (args.switch) { await switchMode(args); return; }
  if (args.rollback) { await rollback(args); return; }
  if (APPLY && !isUuid(args.run)) die('--apply needs --run <id> (printed by the dry run).');
  await requireRepairSchema({ forApply: APPLY });
  await requireKeepUpdatedAt({ forApply: APPLY });
  if (APPLY) { requireQuietWindow({ override: !!args['outside-quiet-window'] }); await requireNoSegmentRecompute('start the apply'); }

  const m = await resolveMode({ forceInline: !!args.inline && !APPLY });
  console.log(`  rules: ${m.mode === 'rpc' ? 'the LIVE public.leads_parcel_orders_plan()' : `the migration FILE's plan body (${MIGRATION}, inline)`}`);
  if (m.live && m.liveMd5 !== m.fileMd5) warn(`the live plan body (md5 ${m.liveMd5}) differs from ${MIGRATION} (md5 ${m.fileMd5})`);
  else if (m.live) ok('the live plan body equals the migration file');

  if (APPLY) {
    if (!m.applyFn) die('public.leads_parcel_orders() is missing — apply migration 20260944000970 first (node scripts/apply-migration-mk.mjs …).');
    const [busy] = await sqlRead(`select count(*)::int n from public.collabbox_sync_runs where status = 'running' and started_at > now() - interval '20 minutes'`);
    if (busy.n) die('a collabBox pass is running (collabbox_sync_runs) — the writer runs one pass at a time; retry when it finished.');
    const [run] = await sqlRead(`select id, key, dry_run, candidate_hash, summary, applied_at from public.data_repair_runs where id = ${qUuid(args.run)}`);
    if (!run) die(`run ${args.run} not found.`);
    if (run.key !== KEY) die(`run ${args.run} belongs to "${run.key}", not "${KEY}".`);
    if (!run.dry_run || run.applied_at) die(`run ${args.run} is not an unapplied dry run.`);
    const runDays = Number(run.summary?.days ?? DEFAULT_DAYS);
    if (runDays !== days) die(`run ${args.run} was dry-run with --days ${runDays}; pass the same.`);
    const plan = await loadPlan({ mode: 'rpc', fileText: m.fileText, days });
    if (plan.hash !== run.candidate_hash) {
      die(`The plan changed since the dry run (hash ${String(plan.hash).slice(0, 12)}… ≠ ${String(run.candidate_hash).slice(0, 12)}…).\n` +
        '  Run the dry run again, review the new CSV, and apply THAT run id.');
    }
    ok(`hash matches the dry run (${plan.hash.slice(0, 12)}…) — ${plan.counts.create} orders to make`);
    const actor = await resolveActor(args.actor || 'mile@elyon.com');
    const [res] = await sql(`select public.leads_parcel_orders(true, ${days}, ${qUuid(args.run)}, ${q(plan.hash)}) as res`);
    const out = typeof res?.res === 'string' ? JSON.parse(res.res) : res?.res;
    if (!out?.ok) die(`leads_parcel_orders did not answer ok: ${JSON.stringify(out).slice(0, 500)}`);
    const payload = { script: 'repair-leads-parcel-orders.mjs', days, applied: out.applied, moved: out.moved,
      skipped: out.skipped, sync_run: out.sync_run, writer_outcomes: out.writer_outcomes, outside_quiet_window: !!args['outside-quiet-window'] };
    await sql(`update public.data_repair_runs set applied_by = ${qUuid(actor.id)} where id = ${qUuid(args.run)};
      insert into public.audit_log (actor_id, actor_email, action, target_type, target_id, target_name, payload)
      values (${qUuid(actor.id)}, ${q(actor.email)}, 'data_repair.apply', 'data_repair_run', ${q(args.run)}, ${q(KEY)}, ${qJson(payload)});`);
    ok(`run ${args.run} applied — ${out.applied} orders made${out.moved ? `, ${out.moved} left alone (moved since the dry run)` : ''}; ` +
      `the live writer answered ${JSON.stringify(out.writer_outcomes)} (collabBox run ${out.sync_run})`);
    for (const s of out.skipped ?? []) console.log(yellow(`    skipped ${s.tracking_id}: ${s.why}`));
    const [v] = await sqlRead(`select
        (select count(*) from public.data_repair_rows where run_id = ${qUuid(args.run)} and rule = 'LPO_create')::int as ledger_rows,
        (select count(*) from public.data_repair_rows r join public.orders o on o.id = r.order_id
          where r.run_id = ${qUuid(args.run)} and r.rule = 'LPO_create'
            and public.cohort_order_source(o.sale_source, o.sale_source_detail, o.mex_tracking_id, o.dept_override) <> 'altercpa')::int as not_affiliate_in,
        (select count(*) from public.data_repair_rows r join public.mex_parcels p on p.tracking_id = r.evidence ->> 'doc'
          where r.run_id = ${qUuid(args.run)} and r.rule = 'LPO_create' and p.order_id is distinct from r.order_id)::int as parcel_not_held,
        (select count(*) from public.data_repair_rows r join public.collabbox_documents d on d.doc_number = r.evidence ->> 'doc'
          where r.run_id = ${qUuid(args.run)} and r.rule = 'LPO_create'
            and (d.order_id is distinct from r.order_id or d.outcome not in ('updated', 'exists')))::int as ledger_not_order`);
    printTable([v]);
    console.log(yellow(`  Next: node scripts/verify-folder-orders.mjs · node scripts/engine-fixture-mk.mjs · then --switch apply for the nightly cron.\n` +
      `  Undo: node scripts/repair-leads-parcel-orders.mjs --rollback ${args.run}\n`));
    return;
  }

  // ── dry run ──
  const expected = parseExpect(args.expect, EXPECTED);
  const plan = await loadPlan({ mode: m.mode, fileText: m.fileText, days });
  const parity = planHashParity(plan);
  if (!parity.ok) die(`hash parity FAILED: SQL ${plan.hash} ≠ repair-kit ${parity.js} — the ledger contract is broken.`);
  ok(`plan hash ${plan.hash.slice(0, 12)}… = the repair-kit's sha256 of the ${parity.lines.length} plan lines`);

  const c = plan.counts;
  printTable([{ parcels: c.parcels, with_document: c.with_document, create: c.create, 'create COD (ден)': fmtMkd(c.create_cod_mkd),
    manual: c.manual, 'manual COD (ден)': fmtMkd(c.manual_cod_mkd) }]);
  console.log(`  by MEX target ${JSON.stringify(c.by_target)} · manual ${JSON.stringify(c.manual_by_reason)}`);
  const names = await loadNames([...plan.create, ...plan.manual].map((x) => x.author_person_id));
  for (const [label, month] of [[`last ${days} days`, null], ['September 2026 (sale day = the booking)', SEPTEMBER]]) {
    const t = createTables(plan, names, month);
    console.log(bold(`\nOrders to make — ${label}: ${t.n} (${fmtMkd(t.mkd)} ден)`));
    printTable(t.byStatus);
    printTable(t.byAuthor);
  }
  const out9103 = await sqlRead(LEADS_OUT_SQL(days));
  console.log(bold('\n9103 LEADS-OUT parcels delivered / returned that no order holds (the live writer owns 10114 — reported only)'));
  printTable(out9103);

  const csvPath = writeCsv(`${KEY}-${fileStamp()}.csv`, planCsvRows(plan, names));
  ok(`CSV (contains PII — stays in exports/, never commit): ${csvPath}`);
  const counts = { parcels: c.parcels, create: c.create, manual: c.manual };
  const drift = checkDrift(counts, expected);
  printTable(drift.rows);
  if (!drift.pass) die(`Counts drifted — NO run recorded. If understood, re-run with --expect ${expectString(counts, Object.keys(expected))}`);
  const { id, hash } = await recordDryRun({ key: KEY, lines: parity.lines, summary: {
    script: 'repair-leads-parcel-orders.mjs', trigger: 'manual', mode: m.mode, days, expected, counts: plan.counts,
    create: plan.create.map((x) => ({ tracking_id: x.tracking_id, target: x.target, cod_mkd: x.cod_mkd, price_eur: x.price_eur,
      sale_at: x.sale_at, author: x.author, author_person_id: x.author_person_id, created_at_mex: x.created_at_mex })),
    manual: plan.manual.map((x) => ({ tracking_id: x.tracking_id, reason: x.reason, cod_mkd: x.cod_mkd })),
    leads_out_9103: out9103, csv: csvPath.split(/[\\/]/).pop() } });
  if (hash !== plan.hash) die('internal: the recorded hash differs from the plan hash.');
  console.log(bold(`\nDry run recorded: ${green(id)}`) + `  (hash ${hash.slice(0, 12)}…)\n` +
    (m.applyFn ? `  node scripts/repair-leads-parcel-orders.mjs --apply --run ${id}${days !== DEFAULT_DAYS ? ` --days ${days}` : ''}\n`
      : `  apply needs migration 20260944000970 first: node scripts/assert-mk-target.mjs && node scripts/apply-migration-mk.mjs ${MIGRATION}\n` +
        `  then: node scripts/repair-leads-parcel-orders.mjs --apply --run ${id} — it re-plans with the LIVE function and refuses\n` +
        '  unless the hash still equals this run (anything moved since → dry-run again)\n'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => die(e.stack || e.message || String(e)));
}
