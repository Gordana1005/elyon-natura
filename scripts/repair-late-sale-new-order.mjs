/**
 * Repair — a LATE SALE IS A NEW ORDER (owner, Mile, 03.10.2026 — "ДА"). No shebang (repair-kit convention). Run with node.
 *
 * OWNER LAW: when a collabBox sales document or a MEX parcel arrives for an existing order, it is that order's sale only
 * when the lead was still open, or the order was cancelled / trashed at most 10 days before it. Everything else — more
 * than 10 days after the cancel / trash, or after the order's own sale (an approval that never shipped, an order that
 * already shipped its own parcel) — is a NEW order on the booking day, credited to the document's author, its
 * department decided by the author's line team (Маџари → Тим Маџари Out — "тоа мора да биде нов ордер … тоа е Out
 * нарачка"); the OLD order goes back to what it was before. One definition: late_sale_classify / late_sale_plan
 * (migration 20260947002000); the new order is made by the LIVE collabBox writer (20260947002010) — see the header of
 * scripts/lib/late-sale-new-order.mjs.
 *
 *   node scripts/repair-late-sale-new-order.mjs [--expect units=738,move=685,manual=53] [--hold ORD-1,…]
 *        dry run → CSV in exports/neworder (PII) + a data_repair_runs dry-run row + the run id
 *   node scripts/repair-late-sale-new-order.mjs --apply --run <id> [--actor mile@elyon.com] [--chunk 40] [--no-switch]
 *        one collabbox_sync_runs row (manual, running → ok) carries the writer's re-applies; quiet window; never while a
 *        collabBox pass, the segment recompute or the no-parcel rule runs; at the end the forward switch
 *        app_settings.late_sale_new_order.mode goes to 'apply' (the writer splits late holders by itself) unless --no-switch
 *   node scripts/repair-late-sale-new-order.mjs --rollback <id> [--apply] [--actor mile@elyon.com]
 *        undo: late_sale_undo(<the apply's collabBox run>) — every new order deleted, every old order, register row and
 *        document ledger row back — only where both orders are still as the split left them; the switch goes back to
 *        'report'. rollback-repair.mjs refuses this key.
 *
 * 🛑 Macedonia only (repair-kit guards). Payout / bonus math untouched; nothing is sent to AlterCPA.
 */
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MK_REF, ROOT, bold, green, yellow, die, warn, ok,
  mkGuard, sql, sqlRead, assertRemoteIsMk, requireRepairSchema, requireKeepUpdatedAt, requireQuietWindow,
  requireNoSegmentRecompute, q, qUuid, qJson, qTextArray, isUuid, parseArgs, parseExpect, checkDrift, expectString,
  fmtMkd, fileStamp, loadPhoneOrders, stickyTrashEffects, printTrashFalls, resolveActor, recordDryRun,
  verifyRunForApply, finalizeRun, auditPartial, printTable, candidateHash,
} from './lib/repair-kit.mjs';
import {
  KEY, EXPECTED, PLAN_SQL, PREDICT_SQL, classifyLateSales, moneyMoves, madzariInMoves, afterEffects, restoredStatus,
  buildApplySql, switchSql, teamPersonSplit, statusSplit,
} from './lib/late-sale-new-order.mjs';

const CHUNK = 40;
const OUT_DIR = join(ROOT, 'exports', 'neworder');

function writeCsvHere(name, rows) {
  mkdirSync(OUT_DIR, { recursive: true });
  const cols = rows.length ? Object.keys(rows[0]) : [];
  const esc = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const path = join(OUT_DIR, name);
  writeFileSync(path, [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n'), 'utf8');
  return path;
}

async function classify(hold) {
  const plan = await sqlRead(PLAN_SQL);
  const predictions = await sql(PREDICT_SQL);         // privileged path, READ ONLY transaction (see PREDICT_SQL)
  return { plan, ...classifyLateSales({ plan, predictions, hold }) };
}

async function rollback(args) {
  const runId = args.rollback;
  if (!isUuid(runId)) die('--rollback needs the applied run id.');
  const [run] = await sqlRead(`select id, key, applied_at, summary from public.data_repair_runs where id = ${qUuid(runId)}`);
  if (!run || run.key !== KEY) die(`run ${runId} is not a ${KEY} run.`);
  const syncRun = run.summary?.apply?.sync_run;
  if (!isUuid(syncRun)) die(`run ${runId} has no applied collabBox run in its summary (was it applied?).`);
  const rows = await sqlRead(`select l.id, l.display_id, l.new_display_id, l.tracking,
      (o.status::text = l.after ->> 'status' and o.mex_tracking_id is not distinct from l.after ->> 'mex_tracking_id') as old_same,
      (n.id is not null and n.mex_tracking_id is not distinct from l.tracking
        and not exists (select 1 from public.order_history h where h.order_id = n.id and h.changed_by is not null)) as new_same
    from public.late_sale_moves l join public.orders o on o.id = l.order_id left join public.orders n on n.id = l.new_order_id
   where l.sync_run_id = ${qUuid(syncRun)} and l.undone_at is null and l.new_order_id is not null`);
  const same = rows.filter((r) => r.old_same && r.new_same);
  console.log(`  splits of collabBox run ${syncRun}: ${rows.length} · restorable: ${same.length} · left alone: ${rows.length - same.length}`);
  for (const r of rows.filter((x) => !(x.old_same && x.new_same)).slice(0, 30)) {
    console.log(`    ${r.display_id} / ${r.new_display_id} ${r.tracking}: ${!r.old_same ? 'the old order changed' : 'the new order changed'}`);
  }
  if (!args.apply) { console.log(`\nPreview only. To undo: node scripts/repair-late-sale-new-order.mjs --rollback ${runId} --apply\n`); return; }
  requireQuietWindow({ override: !!args['outside-quiet-window'] });
  await requireKeepUpdatedAt({ forApply: true });
  await requireNoSegmentRecompute('start the rollback');
  const actor = await resolveActor(args.actor || 'mile@elyon.com');
  const rb = randomUUID();
  await sql(`insert into public.data_repair_runs (id, key, dry_run, candidate_hash, summary)
    values (${qUuid(rb)}, ${q(`rollback-${KEY}`)}, false, ${q(candidateHash(same.map((r) => `${r.id}:rollback`)))},
            ${qJson({ rolled_back_run: runId, sync_run: syncRun })})`);
  const [res] = await sql(`select public.late_sale_undo(${qUuid(syncRun)}, ${q(actor.email)}) as r`);
  await sql(switchSql('report'));
  await sql(`update public.data_repair_runs set applied_at = now(), applied_by = ${qUuid(actor.id)},
      summary = summary || ${qJson({ restored: res.r.restored, skipped: res.r.skipped })} where id = ${qUuid(rb)};
    insert into public.audit_log (actor_id, actor_email, action, target_type, target_id, target_name, payload)
    values (${qUuid(actor.id)}, ${q(actor.email)}, 'data_repair.rollback', 'data_repair_run', ${q(runId)}, ${q(KEY)},
            ${qJson({ rollback_run: rb, restored: res.r.restored, left_alone: (res.r.skipped || []).length })});`);
  ok(`undone: ${res.r.restored} splits (rollback run ${rb}); left alone: ${(res.r.skipped || []).length}; switch → report`);
  for (const s of res.r.skipped || []) console.log(yellow(`    move ${s.move} ${s.order}: ${s.why}`));
  console.log(yellow('  Next: node scripts/verify-late-sale-new-order.mjs · node scripts/engine-fixture-mk.mjs\n'));
}

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    flags: ['apply', 'outside-quiet-window', 'no-switch', 'help'], values: ['run', 'expect', 'actor', 'hold', 'chunk', 'rollback'],
  });
  if (args.help) { console.log('see the header of scripts/repair-late-sale-new-order.mjs'); return; }
  mkGuard();
  const APPLY = !!args.apply;
  console.log(bold(`\nRepair — ${KEY} — ${args.rollback ? 'ROLLBACK' : APPLY ? 'APPLY' : 'DRY RUN'}  (${MK_REF})\n`));
  await assertRemoteIsMk();
  if (args.rollback) { await rollback(args); return; }
  if (APPLY && !isUuid(args.run)) die('--apply needs --run <id> (printed by the dry run).');
  await requireRepairSchema({ forApply: APPLY });
  await requireKeepUpdatedAt({ forApply: APPLY });
  const [fn] = await sqlRead(`select position('late_sale_release' in prosrc) > 0 as writer_ok from pg_proc where proname = 'collabbox_apply_one'`);
  if (!fn?.writer_ok) die('the live collabbox_apply_one has no late-sale branch — apply 20260947002000 / 2010 first.');
  if (APPLY) { requireQuietWindow({ override: !!args['outside-quiet-window'] }); await requireNoSegmentRecompute('start the apply'); }
  const hold = new Set(String(args.hold || '').split(',').map((s) => s.trim()).filter(Boolean));
  const plan = await classify(hold);

  // ── report ──
  console.log(bold('Units — case · document type · action'));
  printTable(Object.entries(plan.counts.by_case).sort().map(([k, n]) => ({ unit: k, n })));
  if (Object.keys(plan.counts.manual_why).length) {
    console.log(bold('\nLeft alone (manual) — why'));
    printTable(Object.entries(plan.counts.manual_why).sort((a, b) => b[1] - a[1]).map(([reason, n]) => ({ reason, n })));
  }
  const money = moneyMoves(plan.units);
  console.log(bold('\nMoney per month × department (the parcel leaves the old order\'s sale day / department, arrives on the booking day in the author\'s team)'));
  printTable(money.map(({ _net, ...r }) => r));
  console.log(bold('Тим Маџари In → …'));
  printTable(madzariInMoves(plan.units));
  const split = teamPersonSplit(plan.units);
  console.log(bold("\nThe new orders by the author's TEAM (the team decides; a late 10111 is never a lead)"));
  printTable(split.team);
  console.log(bold("… and by PERSON (credited = the collabBox document's author, who entered it so it went to MEX)"));
  printTable(split.person);
  const stSplit = statusSplit(plan.units);
  console.log(bold("The new orders' status from MEX × team × month (no unit lacks a parcel → cancelled 0)"));
  printTable(stSplit);
  const fx = afterEffects(plan.units);
  console.log(bold('After-effects'));
  printTable(Object.entries(fx.restored_by_status).map(([move, n]) => ({ 'old order status now → restored': move, n })));
  console.log(`  restored cancels inside Current Cancels' 14 days (from the order's creation): ${fx.current_cancels}`);
  console.log(`  approvals back to confirmed with no parcel, sold since 01.08: ${fx.no_parcel_rule} AlterCPA → the 10-day no-parcel rule (21:10) · ${fx.collab_entry_rule} other → the 5-day collabBox rule (21:20), unless exempt; before 01.08 (no rule acts): ${fx.confirmed_before_august}`);
  // sticky Trash pre-check: the old orders' restored status + the new orders (on the old order's phone — the writer
  // takes the komitent / registry / parcel phone, which is the same customer), dated by the booking
  const changes = new Map();
  const made = [];
  for (const u of plan.units) {
    const to = restoredStatus(u);
    changes.set(u.order_id, to === 'trashed' ? { status: 'trashed', trashed_at: u.dead_at, trash_reason: 'not_reachable' } : { status: to });
    changes.set(`new:${u.tracking}`, { status: u.prediction?.new_status || 'shipped' });
    made.push({ id: `new:${u.tracking}`, display_id: `(new) ${u.tracking}`, customer_phone: u.customer_phone, status: 'cancelled',
      created_at: u.doc_sale_at, trashed_at: null, trash_reason: null, source_type: 'import' });
  }
  const trash = stickyTrashEffects([...await loadPhoneOrders(plan.units.map((u) => u.customer_phone)), ...made], changes);
  const trashCount = printTrashFalls(trash, 'customers who fall back into sticky Trash');
  console.log(`  customers released from Trash: ${trash.released.length}`);

  const stamp = fileStamp();
  const csvPath = writeCsvHere(`${KEY}-${APPLY ? 'apply-' : ''}${stamp}.csv`, plan.csv);
  writeCsvHere(`${KEY}-money-${stamp}.csv`, money.map(({ _net, ...r }) => r));
  writeCsvHere(`${KEY}-teams-${stamp}.csv`, [...split.team, ...split.person]);
  writeCsvHere(`${KEY}-status-${stamp}.csv`, stSplit);
  ok(`CSV (contains PII — stays in exports/, never commit): ${csvPath}`);

  if (!APPLY) {
    const counts = { units: plan.counts.units, move: plan.counts.move, manual: plan.counts.manual };
    const drift = checkDrift(counts, parseExpect(args.expect, EXPECTED));
    printTable(drift.rows);
    if (!drift.pass) die(`Counts drifted — NO run recorded. If understood, re-run with --expect ${expectString(counts, Object.keys(EXPECTED))}`);
    const { id, hash } = await recordDryRun({ key: KEY, lines: plan.lines, summary: {
      script: 'repair-late-sale-new-order.mjs', counts: plan.counts, hold: [...hold], after_effects: fx,
      trash_falls_permanent: trashCount.permanent, trash_falls_parked: trashCount.parked,
      money: money.map(({ _net, ...r }) => r), teams: split.team, people: split.person, status: stSplit,
      units: plan.csv.map((r) => ({ order: r.order, action: r.action, kase: r.kase, tracking: r.tracking, why: r.why || null })),
      csv: csvPath.split(/[\\/]/).pop() } });
    console.log(bold(`\nDry run recorded: ${green(id)}`) + `  (hash ${hash.slice(0, 12)}…)\n` +
      '  In the quiet window (after 23:00 Skopje, or between two collabBox passes; no recompute):\n' +
      `  node scripts/assert-mk-target.mjs && node scripts/repair-late-sale-new-order.mjs --apply --run ${id}${hold.size ? ` --hold ${[...hold].join(',')}` : ''}\n`);
    return;
  }

  // ── apply ──
  const [busy] = await sqlRead(`select count(*)::int n from public.collabbox_sync_runs where status = 'running' and started_at > now() - interval '20 minutes'`);
  if (busy.n) die('a collabBox pass is running (collabbox_sync_runs) — the writer runs one pass at a time; retry when it finished.');
  const actor = await resolveActor(args.actor || 'mile@elyon.com');
  const { done } = await verifyRunForApply({ key: KEY, runId: args.run, lines: plan.lines });
  const units = plan.units.filter((u) => !done.has(u.order_id));
  const days = units.map((u) => u.doc_sale_at).filter(Boolean).sort();
  const [sr] = await sql(`insert into public.collabbox_sync_runs (kind, trigger_kind, status, window_from, window_to, doc_types, stats)
    values ('manual', 'manual', 'running', ${q(String(days[0] ?? new Date().toISOString()).slice(0, 10))}::date,
            ${q(String(days[days.length - 1] ?? new Date().toISOString()).slice(0, 10))}::date,
            ${qTextArray(['10111', '10114', '10050', '10036', '10106'])},
            ${qJson({ tool: 'scripts/repair-late-sale-new-order.mjs', repair_run: args.run })}) returning id`);
  ok(`collabbox_sync_runs ${sr.id} (manual, running) carries the writer's re-applies`);
  const size = Math.max(1, Math.min(CHUNK, Number(args.chunk) || CHUNK));
  const stats = { applied: 0, made: [], skipped: [], failed: null };
  const t0 = Date.now();
  for (let i = 0; i < units.length; i += size) {
    const chunk = units.slice(i, i + size);
    process.stdout.write(`  chunk ${i / size + 1}/${Math.ceil(units.length / size)} (${chunk.length} units) … `);
    try {
      await requireNoSegmentRecompute('start the next chunk');
      const [res] = await sql(buildApplySql({ runId: args.run, syncRun: sr.id, units: chunk }));
      stats.applied += res.applied;
      stats.made.push(...(res.made || []));
      stats.skipped.push(...(res.skipped || []));
      console.log(`${green('committed')} ${res.applied}/${res.planned}${(res.skipped || []).length ? yellow(` (${res.skipped.length} left alone)`) : ''}`);
    } catch (e) {
      console.log('FAILED — rolled back');
      stats.failed = { chunk: i / size + 1, error: String(e.message || e).slice(0, 1500) };
      console.error(stats.failed.error);
      break;
    }
  }
  await sql(`update public.collabbox_sync_runs set status = ${q(stats.failed ? 'failed' : 'ok')}, error = ${q(stats.failed?.error ?? null)},
      finished_at = now(), duration_ms = ${Date.now() - t0}, stats = stats || ${qJson({ made: stats.made.length, skipped: stats.skipped })}
    where id = ${qUuid(sr.id)}`);
  for (const s of stats.skipped) console.log(yellow(`    left alone ${s.tracking}: ${s.why}`));
  const payload = { script: 'repair-late-sale-new-order.mjs', counts: plan.counts, applied_units: stats.applied, sync_run: sr.id,
    skipped: stats.skipped, resumed_from: done.size, outside_quiet_window: !!args['outside-quiet-window'] };
  if (stats.failed) {
    await auditPartial({ key: KEY, runId: args.run, actor, payload: { ...payload, failed: stats.failed } });
    die(`Stopped at chunk ${stats.failed.chunk}; committed units are in the ledger — fix the cause and re-run the same --apply.`);
  }
  await finalizeRun({ key: KEY, runId: args.run, actor, payload });
  ok(`run ${args.run} applied — ${stats.applied} late sales are new orders (collabBox run ${sr.id})`);
  if (!args['no-switch']) {
    const [sw] = await sql(switchSql('apply'));
    ok(`forward switch app_settings.late_sale_new_order → ${JSON.stringify(sw?.value)}`);
  }
  const [v] = await sqlRead(`select
      (select count(*) from public.late_sale_moves where sync_run_id = ${qUuid(sr.id)} and undone_at is null)::int as moves,
      (select count(*) from public.late_sale_moves l join public.orders o on o.id = l.order_id
        where l.sync_run_id = ${qUuid(sr.id)} and o.mex_tracking_id is not distinct from l.tracking)::int as old_still_holds,
      (select count(*) from (select mex_tracking_id from public.orders where mex_tracking_id is not null group by 1 having count(*) > 1) d
        where d.mex_tracking_id in (select tracking from public.late_sale_moves where sync_run_id = ${qUuid(sr.id)}))::int as parcel_twice,
      (select count(*) from public.late_sale_moves l join public.orders n on n.id = l.new_order_id
        where l.sync_run_id = ${qUuid(sr.id)} and n.sale_source = 'altercpa')::int as new_is_lead`);
  printTable([v]);
  if (v.old_still_holds || v.parcel_twice || v.new_is_lead) warn('a post-check is not 0 — investigate now (node scripts/verify-late-sale-new-order.mjs).');
  console.log(yellow(`  Next: node scripts/verify-late-sale-new-order.mjs · node scripts/engine-fixture-mk.mjs · verify-insights-ties ·\n` +
    `        a Pure Profit refresh for the months that moved.\n  Undo: node scripts/repair-late-sale-new-order.mjs --rollback ${args.run}\n`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => die(e.stack || e.message || String(e)));
}
