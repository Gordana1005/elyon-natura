/**
 * Repair — a RELEASED late-sale holder keeps its OWN earlier parcel (04.10.2026). No shebang (repair-kit convention).
 *
 * late_sale_release() (20260947002030) puts a holder that was cancelled / trashed when the late parcel arrived back
 * to cancelled / trashed with no parcel. When that order had shipped an EARLIER parcel of its own (the register still
 * links it, link_method tracking), the order is left naming nothing while the register says the parcel is its —
 * insights_sale_rows then counts the parcel as a MEX-only sale and insights_overview as owned (verify-attribution
 * C8c "contradict the order"). The history repair of 04.10.2026 left five such orders.
 *
 * MEX beats the CRM status (owner): the order holds its own earlier parcel again and follows it —
 *   MEX 7 → returned (returned_at = the parcel's) · MEX 2 → paid (basis mex) · MEX 8 → named only, the status waits
 *   for the pickup (a cancelled order with a label, as history-cancels leaves it) · anything else → shipped.
 * Only when: the order is in late_sale_moves (not undone), is cancelled / trashed, names no parcel, exactly ONE
 * register parcel is linked to it that no order names, and that parcel is not late for it (late_sale_case_of).
 *
 *   node scripts/repair-late-sale-prior-parcel.mjs                       # dry run → a data_repair_runs id
 *   node scripts/repair-late-sale-prior-parcel.mjs --apply --run <id> [--actor mile@elyon.com] [--outside-quiet-window]
 *   undo:  node scripts/rollback-repair.mjs --run <id> [--apply]
 *
 * 🛑 Macedonia only (repair-kit guards). Prices, sold_* and payouts untouched; nothing is sent to AlterCPA.
 */
import { pathToFileURL } from 'node:url';
import {
  MK_REF, bold, green, yellow, die, ok,
  mkGuard, sqlRead, assertRemoteIsMk, requireRepairSchema, requireKeepUpdatedAt, requireQuietWindow,
  requireNoSegmentRecompute, loadOrderColumnTypes, loadPayoutOrderIds, resolveActor, isUuid, parseArgs,
  planLine, recordDryRun, verifyRunForApply, buildChunkSql, applyChunked, finalizeRun, auditPartial,
  mexStatusSet, printTable, fmtMkd,
} from './lib/repair-kit.mjs';

export const KEY = 'late-sale-prior-parcel';

const PLAN_SQL = `
  select o.id as order_id, o.display_id, o.status::text as status, l.id as move, l.kase, l.tracking as late_parcel,
         m.tracking_id, m.status_id, m.status_name, m.cod_mkd, m.created_at_mex, m.delivered_at, m.returned_at, m.last_update_at,
         public.late_sale_case_of(o.id, m.tracking_id) as own_case,
         (select count(*) from public.mex_parcels x where x.order_id = o.id)::int as register_parcels
    from public.late_sale_moves l
    join public.orders o on o.id = l.order_id
    join public.mex_parcels m on m.order_id = o.id
   where l.undone_at is null
     and o.status::text in ('cancelled', 'trashed')
     and o.mex_tracking_id is null
     and not exists (select 1 from public.orders n where n.mex_tracking_id = m.tracking_id)
   order by o.display_id`;

function classify(rows, payout) {
  const plan = [], skipped = [];
  for (const r of rows) {
    let why = '';
    if (r.register_parcels !== 1) why = `the register links ${r.register_parcels} parcels to it`;
    else if (['dead_late', 'stale', 'second_sale'].includes(r.own_case)) why = `the parcel is itself late for the order (${r.own_case})`;
    else if (payout.has(r.order_id)) why = 'in agent_payout_items (payouts deferred by the owner)';
    if (why) { skipped.push({ order: r.display_id, parcel: r.tracking_id, why }); continue; }
    const s = Number(r.status_id);
    const target = s === 2 ? 'paid' : s === 7 ? 'returned' : s === 8 ? null : 'shipped';
    const set = target ? mexStatusSet(target, r) : {};
    const word = target === 'returned' ? 'вратена' : target === 'paid' ? 'платена' : target === 'shipped' ? 'испратена' : null;
    plan.push({
      unit: r.order_id, order_id: r.order_id, rule: target ? `LP_${target}` : 'LP_label', expect_status: r.status, expect_tracking: null,
      line: planLine(r.order_id, target ? `LP_${target}` : 'LP_label', `${r.status}>${target ?? '='}`, r.tracking_id),
      set, link: { tracking: r.tracking_id, method: 'tracking', force: false, expectOwner: r.order_id }, unlink: null,
      history: target ? { from: r.status, to: target } : null,
      note: `MEX parcel ${r.tracking_id} (${r.status_id} ${r.status_name || ''}, COD ${fmtMkd(r.cod_mkd)} ден) is this order's OWN earlier parcel: the register links it to this order, and the late-sale release (parcel ${r.late_parcel}, a new order) had left the order naming nothing. ` +
        (target ? `MEX decides: статусот е поправен — ${r.status === 'cancelled' ? 'откажана' : 'во корпа'} → ${word}.` : 'The parcel is a label MEX never picked up (MEX 8): the order names it, the status waits for the pickup.') +
        ' Nothing was sent to AlterCPA.',
      evidence: { move: r.move, kase: r.kase, late_parcel: r.late_parcel, parcel: r.tracking_id, mex_status: r.status_id, own_case: r.own_case },
      _r: r, _target: target,
    });
  }
  return { plan, skipped };
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { flags: ['apply', 'outside-quiet-window'], values: ['run', 'actor'] });
  mkGuard();
  const APPLY = !!args.apply;
  console.log(bold(`\nRepair — ${KEY} — ${APPLY ? 'APPLY' : 'DRY RUN'}  (${MK_REF})\n`));
  await assertRemoteIsMk();
  if (APPLY && !isUuid(args.run)) die('--apply needs --run <id> (printed by the dry run).');
  await requireRepairSchema({ forApply: APPLY });
  await requireKeepUpdatedAt({ forApply: APPLY });

  const rows = await sqlRead(PLAN_SQL);
  const payout = await loadPayoutOrderIds(rows.map((r) => r.order_id));
  const { plan, skipped } = classify(rows, payout);
  printTable(plan.map((p) => ({ order: p._r.display_id, case: p._r.kase, now: p._r.status, parcel: p._r.tracking_id,
    mex: `${p._r.status_id} ${p._r.status_name || ''}`, cod: fmtMkd(p._r.cod_mkd), 'becomes': p._target ?? '(named only)', 'own case': p._r.own_case })));
  if (skipped.length) { console.log(bold('Left alone:')); printTable(skipped); }
  const lines = plan.map((p) => p.line);
  const summary = { planned: plan.length, skipped, rules: plan.reduce((m, p) => ({ ...m, [p.rule]: (m[p.rule] || 0) + 1 }), {}) };

  if (!APPLY) {
    if (!plan.length) { ok('nothing to repair.'); return; }
    const run = await recordDryRun({ key: KEY, lines, summary });
    console.log(`\n${green('DRY RUN')} — nothing was written to orders.\n  run: ${bold(run.id)}  (hash ${run.hash.slice(0, 12)}…)`);
    console.log(`  apply: node scripts/repair-late-sale-prior-parcel.mjs --apply --run ${run.id}`);
    return;
  }

  const { done } = await verifyRunForApply({ key: KEY, runId: args.run, lines });
  requireQuietWindow({ override: !!args['outside-quiet-window'] });
  await requireNoSegmentRecompute('start the apply');
  const actor = await resolveActor(args.actor || 'mile@elyon.com');
  const typeMap = await loadOrderColumnTypes();
  const todo = plan.filter((p) => !done.has(p.order_id)).map(({ _r, _target, ...row }) => row);
  const stats = await applyChunked({ items: todo, label: 'orders', build: (chunk) => buildChunkSql({ key: KEY, runId: args.run, rows: chunk, typeMap }) });
  const payload = { planned: todo.length, applied: stats.applied, skipped: stats.skipped.length, failed: stats.failed, rules: summary.rules };
  if (stats.failed) {
    await auditPartial({ key: KEY, runId: args.run, actor, payload });
    die(`stopped at chunk ${stats.failed.chunk}: ${stats.failed.error}`);
  }
  await finalizeRun({ key: KEY, runId: args.run, actor, payload });
  ok(`applied ${stats.applied}/${todo.length} orders${stats.skipped.length ? yellow(` — ${stats.skipped.length} moved since the dry run, left alone`) : ''}`);
  console.log(`  undo: node scripts/rollback-repair.mjs --run ${args.run} --apply`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => die(e.stack || e.message || String(e)));
}
