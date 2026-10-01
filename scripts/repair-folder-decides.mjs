/**
 * Repair — the collabBox FOLDER decides: every AlterCPA order holding a NATURA teleshop / social parcel gives it to the
 * parcel's own collabBox document, which becomes its own Телешоп / Социјални order (owner, Mile, 01.10.2026). No shebang
 * (repair-kit convention: the test suite imports this file). Run with `node`.
 *
 * OWNER LAW: "The department is decided by the collabBox FOLDER / MEX series, never by the system an order was made in"
 * (28–29.09). On 01.10: "Yes, the collabBox folder decides" — ALL such cases, not only those sent on another day than the
 * lead: the parcel's sale belongs to Телешоп / Социјални and is credited to the collabBox document's author. The truth
 * is MEX (+ collabBox); AlterCPA statuses are a commercial artifact — nothing is pushed to AlterCPA.
 * Series: 9102 Телешоп Out (10050) · 9100 Телешоп In (10036) · 9108 / 1300 Социјални (10106).
 *
 * The rules are in scripts/lib/folder-decides.mjs (pure, tested in src/lib/folderOrders.test.ts); per parcel ONE
 * sub-transaction: the AlterCPA order back to what it was before the parcel made it a sale (its cancel / trash restored,
 * or — never cancelled — cancelled by the system, reason 'other' + note; never a person's cancel), the parcel unlinked,
 * then the LIVE collabBox writer re-applies the document (collabbox_apply_documents → collabbox_apply_one, unchanged)
 * and must answer 'created' — else the whole unit rolls back and is listed. Orders in agent_payout_items, LEADS-document
 * orders and documents the writer would not turn into an order are listed (manual).
 *
 *   node scripts/repair-folder-decides.mjs [--expect candidates=134,move=127,manual=7] [--hold ORD-1,…]
 *        dry run → CSV in exports/repairs (PII) + a data_repair_runs dry-run row + the run id
 *   node scripts/repair-folder-decides.mjs --apply --run <id> [--actor mile@elyon.com] [--chunk 40] [--outside-quiet-window]
 *        one collabbox_sync_runs row (manual, running → ok) carries the writer's re-applies; quiet window; never while a
 *        collabBox pass, the segment recompute or the no-parcel rule runs
 *   node scripts/repair-folder-decides.mjs --rollback <id> [--apply] [--actor mile@elyon.com]
 *        undo: the order the writer made is deleted, the document's ledger row back to 'conflict', the AlterCPA order +
 *        its register row back — only units where both orders are still as the run left them. rollback-repair.mjs
 *        refuses this key.
 *
 * 🛑 Macedonia only (repair-kit guards). Payout / bonus math untouched. Run it BEFORE scripts/repair-leads-parcel-orders.mjs
 * (the leads it cancels can become phone + date candidates for orphan 9110 parcels — that plan must see them).
 */
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  MK_REF, bold, green, yellow, die, warn, ok,
  mkGuard, sql, sqlRead, assertRemoteIsMk, requireRepairSchema, requireKeepUpdatedAt, requireQuietWindow,
  requireNoSegmentRecompute, loadOrderColumnTypes, q, qUuid, qJson, qTextArray, isUuid, parseArgs, parseExpect, checkDrift,
  expectString, fmtMkd, fileStamp, writeCsv, loadHistory, loadPhoneOrders, stickyTrashEffects, printTrashFalls, resolveActor,
  recordDryRun, verifyRunForApply, finalizeRun, auditPartial, printTable, candidateHash,
} from './lib/repair-kit.mjs';
import {
  KEY, EXPECTED, CANDIDATES_SQL, classifyFolderDecides, deptMoves, personMoves, buildApplySql, rollbackCheckSql, buildRollbackSql,
} from './lib/folder-decides.mjs';

const CHUNK = 40;   // the writer's own batch size (collabbox-sync edge function)
const SEPTEMBER = '2026-09';

export async function loadNames(ids) {
  const list = [...new Set(ids.filter(isUuid))];
  if (!list.length) return new Map();
  const rows = await sqlRead(`select id, display_name from public.sales_people where id = any(array[${list.map(qUuid).join(',')}])`);
  return new Map(rows.map((r) => [r.id, r.display_name]));
}

async function classify(runTag, hold) {
  const cands = await sqlRead(CANDIDATES_SQL);
  const history = await loadHistory(cands.map((c) => c.id));
  return { cands, ...classifyFolderDecides({ cands, history, hold, runTag }) };
}

async function rollback(args) {
  const runId = args.rollback;
  if (!isUuid(runId)) die('--rollback needs the applied run id.');
  const [run] = await sqlRead(`select id, key, applied_at from public.data_repair_runs where id = ${qUuid(runId)}`);
  if (!run || run.key !== KEY) die(`run ${runId} is not a ${KEY} run.`);
  const rows = await sqlRead(`set local timezone = 'UTC';\n${rollbackCheckSql(runId)}`);   // the snapshots were written in UTC
  const same = rows.filter((r) => r.holder_same && r.made_same);
  console.log(`  units the run applied: ${rows.length} · restorable: ${same.length} · left alone: ${rows.length - same.length}`);
  for (const r of rows.filter((x) => !(x.holder_same && x.made_same)).slice(0, 30)) {
    console.log(`    ${r.display_id} ${r.tracking}: ${!r.holder_same ? 'the AlterCPA order changed' : 'the made order changed'}`);
  }
  if (!args.apply) { console.log(`\nPreview only. To undo: node scripts/repair-folder-decides.mjs --rollback ${runId} --apply\n`); return; }
  requireQuietWindow({ override: !!args['outside-quiet-window'] });
  await requireKeepUpdatedAt({ forApply: true });
  await requireNoSegmentRecompute('start the rollback');
  const actor = await resolveActor(args.actor || 'mile@elyon.com');
  const rb = randomUUID();
  await sql(`insert into public.data_repair_runs (id, key, dry_run, candidate_hash, summary)
    values (${qUuid(rb)}, ${q(`rollback-${KEY}`)}, false, ${q(candidateHash(same.map((r) => `${r.order_id}:rollback::${r.tracking}`)))},
            ${qJson({ rolled_back_run: runId })})`);
  const [res] = await sql(buildRollbackSql({ runId, rbRunId: rb, actor, typeMap: await loadOrderColumnTypes() }));
  await sql(`update public.data_repair_runs set applied_at = now(), applied_by = ${qUuid(actor.id)},
      summary = summary || ${qJson({ restored: res.restored, skipped: res.skipped })} where id = ${qUuid(rb)}`);
  ok(`undone: ${res.restored} units (rollback run ${rb}); left alone: ${(res.skipped || []).length}`);
  for (const s of res.skipped || []) console.log(yellow(`    ${s.tracking}: ${s.why}`));
  console.log(yellow('  Next: node scripts/engine-fixture-mk.mjs · node scripts/verify-folder-orders.mjs\n'));
}

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    flags: ['apply', 'outside-quiet-window', 'help'], values: ['run', 'expect', 'actor', 'hold', 'chunk', 'rollback'],
  });
  if (args.help) { console.log('see the header of scripts/repair-folder-decides.mjs'); return; }
  mkGuard();
  const APPLY = !!args.apply;
  console.log(bold(`\nRepair — ${KEY} — ${args.rollback ? 'ROLLBACK' : APPLY ? 'APPLY' : 'DRY RUN'}  (${MK_REF})\n`));
  await assertRemoteIsMk();
  if (args.rollback) { await rollback(args); return; }
  if (APPLY && !isUuid(args.run)) die('--apply needs --run <id> (printed by the dry run).');
  await requireRepairSchema({ forApply: APPLY });
  await requireKeepUpdatedAt({ forApply: APPLY });
  if (APPLY) { requireQuietWindow({ override: !!args['outside-quiet-window'] }); await requireNoSegmentRecompute('start the apply'); }
  const hold = new Set(String(args.hold || '').split(',').map((s) => s.trim()).filter(Boolean));
  const runTag = APPLY ? String(args.run).slice(0, 8) : 'dry-run';
  const plan = await classify(runTag, hold);
  const names = await loadNames(plan.moves.flatMap((m) => [m.person_before, m.person_after]));

  // ── report ──
  console.log(bold('Counts'));
  printTable(Object.entries(plan.counts).map(([bucket, n]) => ({ bucket, n })));
  const why = new Map();
  for (const r of plan.csv.filter((x) => x.action !== 'move')) {
    const k = r.why.replace(/ORD-\d+/g, 'ORD-…').replace(/\d{3}-\d{4}-\d+\/\d{4}/g, '…').slice(0, 110);
    why.set(k, (why.get(k) || 0) + 1);
  }
  if (why.size) { console.log(bold('\nLeft alone (manual) — why')); printTable([...why].map(([reason, n]) => ({ reason, n }))); }
  const byKind = {};
  for (const r of plan.csv.filter((x) => x.action === 'move')) {
    const k = `${r.status_now} → ${r.back_to} (${r.how}) · ${r.dept_after}`;
    byKind[k] ??= { units: 0, mkd: 0 };
    byKind[k].units++;
    byKind[k].mkd += Number(r.cod_mkd) || 0;
  }
  console.log(bold('\nMoves — the AlterCPA order → its new status · the department the parcel goes to'));
  printTable(Object.entries(byKind).sort((a, b) => b[1].units - a[1].units).map(([move, v]) => ({ move, units: v.units, 'COD (ден)': fmtMkd(v.mkd) })));
  console.log(bold('\nMoney per department — every month (sale day before = the AlterCPA order\'s, after = the document\'s booking)'));
  printTable(deptMoves(plan.moves));
  console.log(bold('Money per department — September 2026 only'));
  printTable(deptMoves(plan.moves, SEPTEMBER));
  console.log(bold('People — the sale (COD) each loses / gains'));
  printTable(personMoves(plan.moves, names));
  // sticky Trash pre-check: the AlterCPA orders' changes AND the orders the writer will make (on '+389' + its phone,
  // dated by the booking) — a synthetic 'cancelled' row (neutral to the engine) that becomes the parcel's MEX status
  const byId = new Map(plan.cands.map((c) => [c.id, c]));
  const changes = new Map(plan.changes);
  const made = plan.units.map((u) => {
    const c = byId.get(u.order_id);
    const status = Number(c.mex_status_id) === 2 ? 'paid' : Number(c.mex_status_id) === 7 ? 'returned' : 'shipped';
    changes.set(`new:${u.tracking}`, { status });
    return { id: `new:${u.tracking}`, display_id: `(new) ${u.tracking}`, customer_phone: `+389${c.writer_p8}`, status: 'cancelled',
      created_at: c.doc_sale_at, trashed_at: null, trash_reason: null, source_type: 'import' };
  });
  const phones = [...(await sqlRead(`select customer_phone from public.orders where id = any(array[${plan.units.map((u) => qUuid(u.order_id)).join(',') || 'null::uuid'}])`))
    .map((r) => r.customer_phone), ...made.map((m) => m.customer_phone)];
  const trash = stickyTrashEffects([...await loadPhoneOrders(phones), ...made], changes);
  const trashCount = printTrashFalls(trash, 'customers who fall back into sticky Trash (the new collabBox orders counted)');
  console.log(`  customers released from Trash: ${trash.released.length}`);

  const csvPath = writeCsv(`${KEY}-${APPLY ? 'apply-' : ''}${fileStamp()}.csv`, plan.csv);
  ok(`CSV (contains PII — stays in exports/, never commit): ${csvPath}`);

  if (!APPLY) {
    const counts = { candidates: plan.counts.candidates, move: plan.counts.move, manual: plan.counts.manual + plan.counts.excluded_payout };
    const drift = checkDrift(counts, parseExpect(args.expect, EXPECTED));
    printTable(drift.rows);
    if (!drift.pass) die(`Counts drifted — NO run recorded. If understood, re-run with --expect ${expectString(counts, Object.keys(EXPECTED))}`);
    const { id, hash } = await recordDryRun({ key: KEY, lines: plan.lines, summary: {
      script: 'repair-folder-decides.mjs', counts: plan.counts, hold: [...hold],
      units: plan.csv.map((r) => ({ order: r.order, action: r.action, tracking: r.tracking, back_to: r.back_to || null, how: r.how || null,
        dept_after: r.dept_after || null, why: r.why || null })),
      moves: plan.moves, trash_falls_permanent: trashCount.permanent, trash_falls_parked: trashCount.parked,
      csv: csvPath.split(/[\\/]/).pop() } });
    console.log(bold(`\nDry run recorded: ${green(id)}`) + `  (hash ${hash.slice(0, 12)}…)\n` +
      '  In the quiet window (23:00–23:55 or 00:15–02:00 Skopje — no collabBox pass, no recompute):\n' +
      `  node scripts/assert-mk-target.mjs && node scripts/repair-folder-decides.mjs --apply --run ${id}${hold.size ? ` --hold ${[...hold].join(',')}` : ''}\n`);
    return;
  }

  // ── apply ──
  const [busy] = await sqlRead(`select count(*)::int n from public.collabbox_sync_runs where status = 'running' and started_at > now() - interval '20 minutes'`);
  if (busy.n) die('a collabBox pass is running (collabbox_sync_runs) — the writer runs one pass at a time; retry when it finished.');
  const actor = await resolveActor(args.actor || 'mile@elyon.com');
  const { done } = await verifyRunForApply({ key: KEY, runId: args.run, lines: plan.lines });
  const units = plan.units.filter((u) => !done.has(u.order_id));
  const typeMap = await loadOrderColumnTypes();
  const days = plan.cands.filter((c) => units.some((u) => u.order_id === c.id)).map((c) => c.doc_at).filter(Boolean).sort();
  const [sr] = await sql(`insert into public.collabbox_sync_runs (kind, trigger_kind, status, window_from, window_to, doc_types, stats)
    values ('manual', 'manual', 'running', ${q(String(days[0] ?? new Date().toISOString()).slice(0, 10))}::date,
            ${q(String(days[days.length - 1] ?? new Date().toISOString()).slice(0, 10))}::date, ${qTextArray(['10050', '10036', '10106'])},
            ${qJson({ tool: 'scripts/repair-folder-decides.mjs', repair_run: args.run })}) returning id`);
  ok(`collabbox_sync_runs ${sr.id} (manual, running) carries the writer's re-applies`);
  const size = Math.max(1, Math.min(CHUNK, Number(args.chunk) || CHUNK));
  const stats = { applied: 0, made: [], skipped: [], failed: null };
  const t0 = Date.now();
  for (let i = 0; i < units.length; i += size) {
    const chunk = units.slice(i, i + size);
    process.stdout.write(`  chunk ${i / size + 1}/${Math.ceil(units.length / size)} (${chunk.length} units) … `);
    try {
      await requireNoSegmentRecompute('start the next chunk');
      const [res] = await sql(buildApplySql({ runId: args.run, syncRun: sr.id, units: chunk, typeMap }));
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
  for (const s of stats.skipped) console.log(yellow(`    left alone ${s.unit}: ${s.why}`));
  const payload = { script: 'repair-folder-decides.mjs', counts: plan.counts, applied_units: stats.applied, sync_run: sr.id,
    skipped: stats.skipped, resumed_from: done.size, outside_quiet_window: !!args['outside-quiet-window'] };
  if (stats.failed) {
    await auditPartial({ key: KEY, runId: args.run, actor, payload: { ...payload, failed: stats.failed } });
    die(`Stopped at chunk ${stats.failed.chunk}; committed units are in the ledger — fix the cause and re-run the same --apply.`);
  }
  await finalizeRun({ key: KEY, runId: args.run, actor, payload });
  ok(`run ${args.run} applied — ${stats.applied} parcels went to their collabBox documents`);
  const [v] = await sqlRead(`select
      (select count(*) from public.data_repair_rows where run_id = ${qUuid(args.run)} and rule = 'FD_revert')::int as ledger_rows,
      (select count(*) from public.data_repair_rows r join public.orders o on o.id = r.order_id
        where r.run_id = ${qUuid(args.run)} and (o.mex_tracking_id is not null or o.status::text not in ('cancelled', 'trashed')))::int as holder_not_dead,
      (select count(*) from public.data_repair_rows r join public.orders n on n.id = (r.evidence ->> 'created_order')::uuid
        where r.run_id = ${qUuid(args.run)}
          and public.cohort_order_source(n.sale_source, n.sale_source_detail, n.mex_tracking_id, n.dept_override) is distinct from r.evidence ->> 'dept_after')::int as dept_wrong,
      (select count(*) from (select mex_tracking_id from public.orders where mex_tracking_id is not null group by 1 having count(*) > 1) d
        where d.mex_tracking_id in (select evidence ->> 'tracking' from public.data_repair_rows where run_id = ${qUuid(args.run)}))::int as parcel_twice`);
  printTable([v]);
  if (v.holder_not_dead || v.dept_wrong || v.parcel_twice) warn('a post-check is not 0 — investigate now (node scripts/verify-folder-orders.mjs).');
  console.log(yellow(`  Next: node scripts/verify-folder-orders.mjs · node scripts/engine-fixture-mk.mjs · a Pure Profit refresh for the months that moved ·\n` +
    `        then a fresh dry run of scripts/repair-leads-parcel-orders.mjs.\n  Undo: node scripts/repair-folder-decides.mjs --rollback ${args.run}\n`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => die(e.stack || e.message || String(e)));
}
