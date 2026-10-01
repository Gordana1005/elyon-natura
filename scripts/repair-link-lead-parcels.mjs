/**
 * Backfill — link the orphan BIO NATURAL lead parcels (9110 / 9103) to their CRM orders by PHONE + DATE
 * (owner, Mile, 01.10.2026). No shebang (repair-kit convention: the test suite imports this file). Run with `node`.
 *
 * OWNER LAW: MEX (+ collabBox) is the truth, never AlterCPA (its statuses are a commercial artifact — the ~30 %
 * confirmation guarantee). Nothing is pushed to AlterCPA. The amount is ignored (agents up-sell 1 → 3–6 boxes).
 *
 * THE RULES ARE NOT IN THIS FILE. They are public.link_lead_parcels_plan(days) — migration
 * 20260944000950_link_lead_parcels.sql — the very SELECT the nightly cron (link_lead_parcels_nightly, 21:02
 * Skopje) runs, so the backfill and the cron cannot disagree:
 *   mode rpc     the function exists → `select public.link_lead_parcels_plan(days)` (read-only)
 *   mode inline  before the migration → the migration FILE's plan body, run as one read-only SELECT
 *                (--inline forces it after the migration too; the dry run says which body ran and whether the
 *                live body still equals the file's)
 * In short: parcel 9110/9103 (or BIO NATURAL, no series), COD > 0, last 75 days, no order holds or names it, not a
 * test phone → the ONE order on the same last-8 phone created −10 d … +1 d that holds no parcel, is a real priced
 * sale (not a disposition / duplicate), and fits no other orphan parcel; > 72 h apart the collabBox document must
 * carry the order's product by name. Payout rows and affiliate leads go to the manual list.
 *
 * The order then follows MEX (as scripts/repair-link-elyon-parcels.mjs): 2 → paid (basis mex), 7 → returned,
 * 8 (за пакување) → no status change, anything else → shipped. Prices are NOT touched — run
 * scripts/repair-cod-price.mjs afterwards (owner 28.09: the CRM price follows the COD).
 *
 * RE-SHIPS are not this rule (the order already holds its first, dead parcel): after this backfill run
 * scripts/repair-link-elyon-parcels.mjs (dry run → apply) for them — the dry run here prints how its plan sits
 * next to this one (agree / conflict / its re-ships).
 *
 *   node scripts/repair-link-lead-parcels.mjs [--days 75] [--inline] [--expect parcels=397,link=98,manual=46]
 *        dry run (read-only + one data_repair_runs dry-run row) → CSV in exports/repairs (PII) + the run id
 *   node scripts/repair-link-lead-parcels.mjs --apply --run <id> [--days 75] [--actor mile@elyon.com] [--outside-quiet-window]
 *        needs migration 20260944000950; calls public.link_lead_parcels(true, days, run, hash) — the function
 *        refuses unless the plan still hashes to the reviewed run; ONE transaction
 *   node scripts/repair-link-lead-parcels.mjs --switch apply|report|off [--actor mile@elyon.com]
 *        the nightly cron's owner switch (app_settings.link_lead_parcels.mode) + one audit_log row
 *   undo: node scripts/rollback-repair.mjs --run <id> [--apply] [--loose]   (cron runs too: same ledger)
 *
 * 🛑 Macedonia only (repair-kit guards). Payout / bonus math untouched.
 */
import { pathToFileURL } from 'node:url';
import {
  ROOT, MK_REF, bold, green, yellow, die, warn, ok,
  mkGuard, sql, sqlRead, assertRemoteIsMk, requireRepairSchema, requireKeepUpdatedAt, requireQuietWindow,
  requireNoSegmentRecompute, q, qUuid, qJson, parseArgs, parseExpect, checkDrift, expectString, isUuid,
  fmtMkd, fileStamp, writeCsv, loadPhoneOrders, stickyTrashEffects, printTrashFalls, resolveActor, recordDryRun,
  loadPayoutOrderIds, printTable,
} from './lib/repair-kit.mjs';
import {
  KEY, PLAN_MIGRATION, PLAN_SIG, DEFAULT_DAYS, EXPECTED, readMigration, functionBody, inlinePlanSql, rpcPlanSql,
  planOf, planHashParity, planCsvRows, moveTable, compareWithElyonRepair,
} from './lib/link-lead-parcels.mjs';
import { loadCandidates as loadElyonCandidates, classifyLinks as classifyElyon } from './repair-link-elyon-parcels.mjs';
import { createHash } from 'node:crypto';

const md5 = (s) => createHash('md5').update(String(s).replace(/\r/g, '')).digest('hex');

/** Which body runs: the live function, or the migration file's (inline). */
export async function resolveMode({ forceInline = false } = {}) {
  const fileText = readMigration(ROOT, PLAN_MIGRATION);
  const fileBody = functionBody(fileText, 'FUNCTION public.link_lead_parcels_plan(', '$plan$');
  const [s] = await sqlRead(`select to_regprocedure(${q(PLAN_SIG)}) is not null as live,
      (select md5(replace(p.prosrc, chr(13), '')) from pg_proc p where p.oid = to_regprocedure(${q(PLAN_SIG)})) as live_md5,
      to_regprocedure('public.link_lead_parcels(boolean,integer,uuid,text)') is not null as apply_fn`);
  return { live: !!s?.live, applyFn: !!s?.apply_fn, liveMd5: s?.live_md5 ?? null, fileMd5: md5(fileBody), fileText,
    mode: s?.live && !forceInline ? 'rpc' : 'inline' };
}

export async function loadPlan({ mode, fileText, days }) {
  const [row] = await sqlRead(mode === 'rpc' ? rpcPlanSql(days) : inlinePlanSql(fileText, days));
  const plan = planOf(row);
  if (!plan || !Array.isArray(plan.link)) die('the plan came back empty — check the migration body.');
  return plan;
}

async function switchMode(args) {
  const mode = String(args.switch);
  if (!['apply', 'report', 'off'].includes(mode)) die('--switch takes apply | report | off');
  const actor = await resolveActor(args.actor || 'mile@elyon.com');
  const [cur] = await sqlRead(`select value from public.app_settings where key = 'link_lead_parcels'`);
  if (!cur) die('app_settings.link_lead_parcels is missing — apply migration 20260944000950 first.');
  const before = typeof cur.value === 'string' ? JSON.parse(cur.value) : cur.value;
  const after = { ...before, mode };
  await sql(`update public.app_settings set value = ${qJson(after)} where key = 'link_lead_parcels';
    insert into public.audit_log (actor_id, actor_email, action, target_type, target_id, target_name, payload)
    values (${qUuid(actor.id)}, ${q(actor.email)}, 'settings.update', 'app_settings', 'link_lead_parcels', 'link_lead_parcels',
            ${qJson({ before, after, via: 'scripts/repair-link-lead-parcels.mjs --switch' })});`);
  ok(`app_settings.link_lead_parcels.mode: ${before.mode ?? '(unset)'} → ${mode} (audit_log row written, actor ${actor.email})`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    flags: ['apply', 'inline', 'outside-quiet-window', 'help'], values: ['run', 'expect', 'actor', 'days', 'switch'],
  });
  if (args.help) {
    console.log('usage: node scripts/repair-link-lead-parcels.mjs [--days 75] [--inline] [--expect k=n,…]\n' +
      '       node scripts/repair-link-lead-parcels.mjs --apply --run <id> [--days 75] [--actor <email>] [--outside-quiet-window]\n' +
      '       node scripts/repair-link-lead-parcels.mjs --switch apply|report|off [--actor <email>]');
    return;
  }
  mkGuard();
  const APPLY = !!args.apply;
  const days = args.days ? Number(args.days) : DEFAULT_DAYS;
  if (!Number.isInteger(days) || days < 1 || days > 400) die('--days must be an integer 1…400');
  console.log(bold(`\nBackfill — ${KEY} — ${args.switch ? 'SWITCH' : APPLY ? 'APPLY' : 'DRY RUN'}  (${MK_REF})\n`));
  await assertRemoteIsMk();
  if (args.switch) { await switchMode(args); return; }
  if (APPLY && !isUuid(args.run)) die('--apply needs --run <id> (printed by the dry run).');
  await requireRepairSchema({ forApply: APPLY });
  await requireKeepUpdatedAt({ forApply: APPLY });
  if (APPLY) { requireQuietWindow({ override: !!args['outside-quiet-window'] }); await requireNoSegmentRecompute('start the apply'); }

  const m = await resolveMode({ forceInline: !!args.inline && !APPLY });
  console.log(`  rules: ${m.mode === 'rpc' ? 'the LIVE public.link_lead_parcels_plan()' : `the migration FILE's plan body (${PLAN_MIGRATION}, inline)`}`);
  if (m.live && m.liveMd5 !== m.fileMd5) warn(`the live plan body (md5 ${m.liveMd5}) differs from ${PLAN_MIGRATION} (md5 ${m.fileMd5})`);
  else if (m.live) ok('the live plan body equals the migration file');

  if (APPLY) {
    if (!m.applyFn) die('public.link_lead_parcels() is missing — apply migration 20260944000950 first (node scripts/apply-migration-mk.mjs …).');
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
    ok(`hash matches the dry run (${plan.hash.slice(0, 12)}…) — ${plan.counts.link} links`);
    const actor = await resolveActor(args.actor || 'mile@elyon.com');
    const [res] = await sql(`select public.link_lead_parcels(true, ${days}, ${qUuid(args.run)}, ${q(plan.hash)}) as res`);
    const out = typeof res?.res === 'string' ? JSON.parse(res.res) : res?.res;
    if (!out?.ok) die(`link_lead_parcels did not answer ok: ${JSON.stringify(out).slice(0, 500)}`);
    const payload = { script: 'repair-link-lead-parcels.mjs', days, applied: out.applied, moved: out.moved,
      skipped: out.skipped, outside_quiet_window: !!args['outside-quiet-window'] };
    await sql(`update public.data_repair_runs set applied_by = ${qUuid(actor.id)} where id = ${qUuid(args.run)};
      insert into public.audit_log (actor_id, actor_email, action, target_type, target_id, target_name, payload)
      values (${qUuid(actor.id)}, ${q(actor.email)}, 'data_repair.apply', 'data_repair_run', ${q(args.run)}, ${q(KEY)}, ${qJson(payload)});`);
    ok(`run ${args.run} applied — ${out.applied} parcels linked${out.moved ? `, ${out.moved} left alone (moved since the dry run)` : ''}`);
    for (const s of out.skipped ?? []) console.log(yellow(`    skipped ${s.display_id} ${s.tracking_id}: ${s.why}`));
    const [v] = await sqlRead(`select
        (select count(*) from public.data_repair_rows where run_id = ${qUuid(args.run)} and after is not null)::int as ledger_rows,
        (select count(*) from public.data_repair_rows r join public.orders o on o.id = r.order_id
          where r.run_id = ${qUuid(args.run)} and o.mex_tracking_id is distinct from r.evidence->>'tracking')::int as not_holding,
        (select count(*) from public.data_repair_rows r join public.orders o on o.id = r.order_id
          where r.run_id = ${qUuid(args.run)} and ((o.status = 'paid' and o.mex_status_id <> 2) or (o.status = 'returned' and o.mex_status_id <> 7)))::int as status_disagrees`);
    printTable([v]);
    console.log(yellow(`  Next: node scripts/repair-cod-price.mjs (dry run) · node scripts/repair-link-elyon-parcels.mjs (re-ships, dry run) ·\n` +
      `        node scripts/collabbox-recredit.mjs (dry run) · node scripts/verify-parcel-link-rules.mjs · then --switch apply for the nightly cron.\n` +
      `  Undo: node scripts/rollback-repair.mjs --run ${args.run}\n`));
    return;
  }

  // ── dry run ──
  const expected = parseExpect(args.expect, EXPECTED);
  const plan = await loadPlan({ mode: m.mode, fileText: m.fileText, days });
  const parity = planHashParity(plan);
  if (!parity.ok) die(`hash parity FAILED: SQL ${plan.hash} ≠ repair-kit ${parity.js} — the ledger contract is broken.`);
  ok(`plan hash ${plan.hash.slice(0, 12)}… = the repair-kit's sha256 of the ${parity.lines.length} plan lines`);

  const c = plan.counts;
  printTable([{ parcels: c.parcels, with_candidates: c.with_candidates, pairs: c.pairs, unique: c.unique,
    link: c.link, 'link COD (ден)': fmtMkd(c.link_cod_mkd), manual: c.manual }]);
  printTable(moveTable(plan));
  console.log(`  by kind ${JSON.stringify(c.by_kind)} · MEX status ${JSON.stringify(c.by_mex_status)} · manual ${JSON.stringify(c.manual_by_reason)}`);

  const payout = await loadPayoutOrderIds(plan.link.map((l) => l.order_id));
  if (payout.size) die(`${payout.size} planned orders sit in agent_payout_items — the plan must have sent them to manual.`);
  const ids = plan.link.map((l) => l.order_id);
  const phones = ids.length ? (await sqlRead(`select customer_phone from public.orders where id = any(array[${ids.map(qUuid).join(',')}])`)).map((r) => r.customer_phone) : [];
  const changes = new Map(plan.link.filter((l) => ['paid', 'returned', 'shipped'].includes(l.target)).map((l) => [l.order_id, { status: l.target }]));
  const trash = stickyTrashEffects(await loadPhoneOrders(phones), changes);
  const trashCount = printTrashFalls(trash);
  console.log(`  customers released from Trash (an order becomes paid): ${trash.released.length}`);

  // the COD-based BIO NATURAL repair next to this plan (re-ships stay its job)
  let elyon = null;
  try {
    const rows = await loadElyonCandidates();
    const ep = classifyElyon({ rows, payout: await loadPayoutOrderIds([...new Set(rows.map((r) => r.id).filter(Boolean))]) });
    elyon = { counts: ep.counts, ...compareWithElyonRepair(plan, ep.units) };
    console.log(`  repair-link-elyon-parcels (COD-based) today: ${ep.counts.link} link (${ep.counts.cancel_then_ship} cancel_then_ship, ` +
      `${ep.counts.no_parcel} no_parcel, ${ep.counts.reship} reship), ${ep.counts.manual} manual — vs this plan: ${elyon.agree} agree, ` +
      `${elyon.conflict.length} conflict, only there: ${JSON.stringify(elyon.only_elyon)}`);
    for (const x of elyon.conflict) warn(`  conflict: ${x.tracking} → ${x.elyon_order} there (${x.kind}), another order here`);
    console.log(yellow('  → run scripts/repair-link-elyon-parcels.mjs AFTER this backfill for its re-ships (this rule never links an order that holds a parcel).'));
  } catch (e) {
    warn(`could not compare with repair-link-elyon-parcels: ${String(e.message || e).slice(0, 200)}`);
  }

  const csvPath = writeCsv(`${KEY}-${fileStamp()}.csv`, planCsvRows(plan));
  ok(`CSV (contains PII — stays in exports/, never commit): ${csvPath}`);
  const counts = { parcels: c.parcels, link: c.link, manual: c.manual };
  const drift = checkDrift(counts, expected);
  printTable(drift.rows);
  if (!drift.pass) die(`Counts drifted — NO run recorded. If understood, re-run with --expect ${expectString(counts, Object.keys(expected))}`);
  const { id, hash } = await recordDryRun({ key: KEY, lines: parity.lines, summary: {
    script: 'repair-link-lead-parcels.mjs', trigger: 'manual', mode: m.mode, days, expected, counts: plan.counts,
    link: plan.link, manual: plan.manual, trash_falls_permanent: trashCount.permanent, trash_released: trash.released.length,
    elyon_repair: elyon ? { counts: elyon.counts, agree: elyon.agree, conflict: elyon.conflict.length, only_elyon: elyon.only_elyon } : null,
    csv: csvPath.split(/[\\/]/).pop() } });
  if (hash !== plan.hash) die('internal: the recorded hash differs from the plan hash.');
  console.log(bold(`\nDry run recorded: ${green(id)}`) + `  (hash ${hash.slice(0, 12)}…)\n` +
    (m.applyFn ? `  node scripts/repair-link-lead-parcels.mjs --apply --run ${id}${days !== DEFAULT_DAYS ? ` --days ${days}` : ''}\n`
      : `  apply needs migration 20260944000950 first: node scripts/assert-mk-target.mjs && node scripts/apply-migration-mk.mjs ${PLAN_MIGRATION}\n` +
        `  then: node scripts/repair-link-lead-parcels.mjs --apply --run ${id} — it re-plans with the LIVE function and refuses\n` +
        '  unless the hash still equals this run (anything moved since → dry-run again)\n'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => die(e.stack || e.message || String(e)));
}
