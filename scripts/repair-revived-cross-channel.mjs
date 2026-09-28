/**
 * Repair — old AlterCPA leads the MEX reconcile revived (28.09.2026 07:07) on a parcel of ANOTHER
 * channel, two months later: a NATURA teleshop "Нарачка out" document (9102) or a web-shop parcel
 * (NTMK…). The web order and the teleshop documents are the real owners — the lead counted a sale
 * that is not its own (and the web one twice: the web order AND the lead). No shebang (repair-kit
 * convention). Run with `node`.
 *
 * Found by the leaderboard audit 28.09.2026 (credits dated today for leads cancelled in July, to
 * operators who have left). Same action as repair-ghost-manual's 'unlink' (its classifier is
 * reused): the lead loses the parcel and goes back to the status it had before the MEX flip
 * (cancelled → cancelled/other + note; trashed → not_reachable park), the register row is
 * unlinked, and the parcel stays with its real owner (the web order already names NTMK62207; the
 * two teleshop documents stand as MEX-only until their collabBox import).
 *
 *   node scripts/repair-revived-cross-channel.mjs                        # dry run → CSV + run id
 *   node scripts/repair-revived-cross-channel.mjs --apply --run <id> [--actor mile@elyon.com] [--outside-quiet-window]
 *   undo: node scripts/rollback-repair.mjs --run <id> [--apply]
 *
 * 🛑 Macedonia only (repair-kit guards).
 */
import { pathToFileURL } from 'node:url';
import {
  MK_REF, bold, green, die, ok, mkGuard, assertRemoteIsMk, requireRepairSchema, loadOrderColumnTypes,
  parseArgs, fileStamp, writeCsv, loadPayoutOrderIds, loadHistory, loadMexNotes,
  resolveActor, recordDryRun, verifyRunForApply, applyUnits, finalizeRun, auditPartial,
  requireKeepUpdatedAt, requireQuietWindow, requireNoSegmentRecompute, printTable,
} from './lib/repair-kit.mjs';
import { classifyGhostManual, loadOrdersByDisplay, loadParcels, loadNamers, loadOwnParcels } from './repair-ghost-manual.mjs';

export const KEY = 'revived-cross-channel';

export const DECISIONS = Object.freeze([
  { x: 'ORD-76196', t: 'NTMK62207', action: 'unlink',
    evidence: 'NTMK62207 is web-shop order NTMK62207 (20.09.2026, 1.790 ден, DELIVERED) — a web sale; this is an AlterCPA lead of 08.07 that the MEX reconcile revived on 28.09 by phone and price' },
  { x: 'ORD-77935', t: '002-9102-177292/2026', action: 'unlink',
    evidence: 'collabBox "Нарачка out" document 002-9102-177292/2026 (23.09.2026, 2.800 ден, Милјана Тодоровска н.) — a teleshop-out sale; this is an AlterCPA lead of 19.07 that the MEX reconcile revived on 28.09' },
  { x: 'ORD-80544', t: '002-9102-177325/2026', action: 'unlink',
    evidence: 'collabBox "Нарачка out" document 002-9102-177325/2026 (23.09.2026, 2.000 ден, Верица Костова) — a teleshop-out sale; this is an AlterCPA lead of 01.08 that the MEX reconcile revived on 28.09' },
]);
export const EXPECTED = { cases: 3, move: 0, unlink: 3, keep: 0, manual: 0 };

async function main() {
  const args = parseArgs(process.argv.slice(2), { flags: ['apply', 'outside-quiet-window', 'help'], values: ['run', 'actor'] });
  if (args.help) { console.log('usage: node scripts/repair-revived-cross-channel.mjs [--apply --run <id>]'); return; }
  mkGuard();
  const APPLY = !!args.apply;
  console.log(bold(`\nRepair — ${KEY} — ${APPLY ? 'APPLY' : 'DRY RUN'}  (${MK_REF})\n`));
  if (APPLY && !args.run) die('--apply needs --run <id>.');
  await assertRemoteIsMk();
  await requireRepairSchema({ forApply: APPLY });
  await requireKeepUpdatedAt({ forApply: APPLY });
  if (APPLY) { requireQuietWindow({ override: !!args['outside-quiet-window'] }); await requireNoSegmentRecompute('start the apply'); }

  const orders = await loadOrdersByDisplay(DECISIONS.map((d) => d.x));
  const trackings = DECISIONS.map((d) => d.t);
  const [parcels, namers, ownParcels] = await Promise.all([loadParcels(trackings), loadNamers(trackings), loadOwnParcels(orders.map((o) => o.id))]);
  const [history, notes] = await Promise.all([loadHistory(orders.map((o) => o.id)), loadMexNotes(orders.map((o) => o.id))]);
  const payout = await loadPayoutOrderIds(orders.map((o) => o.id));
  const plan = classifyGhostManual({ decisions: DECISIONS, orders, parcels, namers, ownParcels, history, notes, payout, runTag: APPLY ? String(args.run).slice(0, 8) : 'dry-run' });
  printTable(plan.csv.map((r) => ({ order: r.case, action: r.action, tracking: r.tracking, parcel: r.parcel_status, status: r.holder_status, back_to: r.holder_back_to, why: r.why })));
  const csvPath = writeCsv(`${KEY}-${APPLY ? 'apply-' : ''}${fileStamp()}.csv`, plan.csv);
  ok(`CSV: ${csvPath}`);
  if (plan.counts.unlink !== EXPECTED.unlink) die(`expected ${EXPECTED.unlink} unlinks, got ${plan.counts.unlink} — read the why column.`);
  if (!APPLY) {
    const { id, hash } = await recordDryRun({ key: KEY, lines: plan.lines, summary: { script: 'repair-revived-cross-channel.mjs', counts: plan.counts } });
    console.log(bold(`\nDry run recorded: ${green(id)}`) + `  (hash ${hash.slice(0, 12)}…)\n  node scripts/repair-revived-cross-channel.mjs --apply --run ${id}\n`);
    return;
  }
  const actor = await resolveActor(args.actor || 'mile@elyon.com');
  const { done } = await verifyRunForApply({ key: KEY, runId: args.run, lines: plan.lines });
  const units = plan.units.filter((u) => !u.rows.some((r) => done.has(r.order_id)));
  const stats = await applyUnits({ key: KEY, runId: args.run, units, typeMap: await loadOrderColumnTypes() });
  const payload = { script: 'repair-revived-cross-channel.mjs', counts: plan.counts, applied_orders: stats.applied };
  if (stats.failed) { await auditPartial({ key: KEY, runId: args.run, actor, payload: { ...payload, failed: stats.failed } }); die(`Stopped at chunk ${stats.failed.chunk}.`); }
  await finalizeRun({ key: KEY, runId: args.run, actor, payload });
  ok(`run ${args.run} applied — ${stats.applied} orders`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => die(e.stack || e.message || String(e)));
}
