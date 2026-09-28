/**
 * Repair — one sale booked TWICE: an agent confirmed it in our CRM (an ElyonCRM order, still
 * "confirmed" with no parcel) and then raised the shipment in collabBox, whose document came back
 * into the CRM through a collabBox import as a SECOND order that holds the MEX parcel. Both count
 * (the CRM copy as "to pack", the collabBox copy as paid / returned). No shebang (repair-kit
 * convention). Run with `node`.
 *
 * OWNER LAW: an order created FIRST in Elyon is ours even if it ships on a teleshop series; MEX
 * decides its status; one sale is counted once (owner 28.09.2026: "never count the same order in
 * two places").
 *
 * A pair = ElyonCRM order C (a real sale, no parcel) + collabBox order X on the same last-8 phone,
 * created from 1 day before to 4 days after C, the SAME price and the SAME seller, X holding a MEX
 * parcel T that the register links to X, nobody else naming T, and exactly one such X for C (and
 * one C for X). Then:
 *   C  takes T (mex_link_parcel force, 'repair'); its status follows MEX (delivered → paid with the
 *      MEX time, returned → returned, moving → shipped).
 *   X  → 'duplicated' (excluded from every figure); the link to T is moved off it.
 * Anything else is listed, never written.
 *
 *   node scripts/repair-crm-collabbox-twins.mjs                        # dry run → CSV + run id
 *   node scripts/repair-crm-collabbox-twins.mjs --apply --run <id> [--actor mile@elyon.com] [--outside-quiet-window]
 *   undo: node scripts/rollback-repair.mjs --run <id> [--apply]
 *
 * 🛑 Macedonia only (repair-kit guards). Payout / bonus math untouched.
 */
import { pathToFileURL } from 'node:url';
import {
  MK_REF, bold, green, yellow, die, ok,
  mkGuard, sqlRead, assertRemoteIsMk, requireRepairSchema, loadOrderColumnTypes,
  qUuid, parseArgs, parseExpect, checkDrift, expectString,
  expectedCodMkd, fmtMkd, fmtSkopje, fileStamp, writeCsv, planLine,
  loadPayoutOrderIds, mexTargetFor, mexStatusSet, parcelWord,
  resolveActor, recordDryRun, verifyRunForApply, applyUnits, finalizeRun, auditPartial,
  requireKeepUpdatedAt, requireQuietWindow, requireNoSegmentRecompute, printTable,
} from './lib/repair-kit.mjs';

export const KEY = 'crm-collabbox-twins';
/** Measured 2026-09-28 (read-only trace of every CRM sale since 01.08). */
export const EXPECTED = { pairs: 6, merge: 6, manual: 0 };

export async function loadPairs() {
  return sqlRead(`
    with crm as (
      select o.* from public.orders o
       where o.sale_source = 'elyon_crm' and o.sale_source_detail <> 'disposition'
         and o.status::text in ('confirmed', 'shipped', 'paid', 'returned', 'delivered')
         and o.mex_tracking_id is null and o.created_at >= '2026-08-01'),
    cb as (
      select o.* from public.orders o
       where o.sale_source = 'collabbox' and o.mex_tracking_id is not null
         and o.status::text in ('confirmed', 'shipped', 'paid', 'returned', 'delivered')),
    pr as (
      select c.id as c_id, x.id as x_id
        from crm c join cb x
          on public.insights_phone8(x.customer_phone) = public.insights_phone8(c.customer_phone)
         and x.created_at between c.created_at - interval '1 day' and c.created_at + interval '4 days'
         and abs(x.price - c.price) < 0.02
         and x.sold_by_person_id is not null and x.sold_by_person_id = c.sold_by_person_id)
    select c.id as c_id, c.display_id as c_display, c.status::text as c_status, c.price as c_price, c.created_at as c_created,
           x.id as x_id, x.display_id as x_display, x.status::text as x_status, x.price as x_price, x.created_at as x_created,
           x.external_order_id as x_doc, x.mex_tracking_id as tracking,
           p.account, p.series, p.status_id, p.status_name, p.cod_mkd, p.created_at_mex, p.delivered_at, p.returned_at,
           p.last_update_at, p.order_id as p_order,
           (select count(*) from pr p2 where p2.c_id = pr.c_id)::int as x_per_c,
           (select count(*) from pr p3 where p3.x_id = pr.x_id)::int as c_per_x,
           (select count(*) from public.orders n where n.mex_tracking_id = x.mex_tracking_id and n.id <> x.id)::int as other_namers,
           sp.display_name as seller
      from pr join public.orders c on c.id = pr.c_id join public.orders x on x.id = pr.x_id
      left join public.mex_parcels p on p.tracking_id = x.mex_tracking_id
      left join public.sales_people sp on sp.id = c.sold_by_person_id
     order by c.created_at`);
}

export function classifyPairs({ pairs, payout = new Set(), runTag = 'dry-run' }) {
  const units = [], csv = [], lines = [];
  const counts = { pairs: pairs.length, merge: 0, manual: 0 };
  for (const r of pairs) {
    let why = '';
    if (!r.p_order) why = 'the parcel is not in the MEX register';
    else if (r.p_order !== r.x_id) why = 'the register links the parcel to another order';
    else if (r.other_namers) why = 'another order also names the parcel';
    else if (r.x_per_c > 1 || r.c_per_x > 1) why = 'more than one candidate pair — needs a human';
    else if (payout.has(r.c_id) || payout.has(r.x_id)) why = 'an order of the pair is in agent_payout_items';
    const action = why ? 'manual' : 'merge';
    counts[action]++;
    const follow = action === 'merge' ? mexTargetFor(r.c_status, r) : null;
    const pTxt = `${r.status_id ?? ''} ${r.status_name || ''}`.trim();
    csv.push({ crm_order: r.c_display, crm_status: r.c_status, crm_created: fmtSkopje(r.c_created), collabbox_order: r.x_display,
      collabbox_status: r.x_status, doc: r.x_doc, tracking: r.tracking, parcel_status: pTxt, cod_mkd: r.cod_mkd ?? '',
      price_mkd: expectedCodMkd(r.c_price), seller: r.seller || '', action, target: follow || '', why });
    const cLine = planLine(r.c_id, action, follow || '', r.tracking);
    const xLine = planLine(r.x_id, action, 'duplicated', r.tracking);
    lines.push(cLine, xLine);
    if (action !== 'merge') continue;
    const unit = `cc:${r.tracking}`;
    units.push({
      unit,
      rows: [
        { unit, order_id: r.x_id, rule: 'CC_duplicate', line: xLine, expect_status: r.x_status, expect_tracking: r.tracking,
          set: { status: 'duplicated' }, link: null, unlink: null, history: { from: r.x_status, to: 'duplicated' },
          note: `Repair ${KEY} (run ${runTag}): this collabBox copy (document ${r.x_doc}) is the SAME sale as ElyonCRM order ${r.c_display} ` +
            `(same customer, price ${fmtMkd(expectedCodMkd(r.c_price))} ден and seller ${r.seller || '—'}, confirmed in the CRM first). The sale is counted once, ` +
            `on ${r.c_display}, which takes MEX parcel ${r.tracking}; this copy is marked duplicated.`,
          evidence: { key: KEY, order: r.x_display, twin_of: r.c_display, doc: r.x_doc, tracking: r.tracking } },
        { unit, order_id: r.c_id, rule: 'CC_keeps', line: cLine, expect_status: r.c_status, expect_tracking: null,
          set: follow ? mexStatusSet(follow, r) : {},
          link: { tracking: r.tracking, method: 'repair', force: true, expectOwner: r.x_id }, unlink: null,
          history: follow ? { from: r.c_status, to: follow } : null,
          note: `Repair ${KEY} (run ${runTag}): this sale was also booked in collabBox (document ${r.x_doc}, imported as ${r.x_display}). ` +
            `Confirmed here first, so it is ours: MEX parcel ${r.tracking} (${pTxt}, COD ${fmtMkd(r.cod_mkd)} ден) is linked here` +
            (follow ? ` and the status follows MEX: ${r.c_status} → ${follow} (${parcelWord(r)}).` : '.'),
          evidence: { key: KEY, order: r.c_display, twin: r.x_display, doc: r.x_doc, tracking: r.tracking, status_follow: follow } },
      ],
    });
  }
  return { units, csv, lines, counts };
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { flags: ['apply', 'outside-quiet-window', 'help'], values: ['run', 'expect', 'actor'] });
  if (args.help) { console.log('usage: node scripts/repair-crm-collabbox-twins.mjs [--expect k=n,…] | --apply --run <id> [--actor <email>] [--outside-quiet-window]'); return; }
  mkGuard();
  const APPLY = !!args.apply;
  console.log(bold(`\nRepair — ${KEY} — ${APPLY ? 'APPLY' : 'DRY RUN'}  (${MK_REF})\n`));
  if (APPLY && !args.run) die('--apply needs --run <id> (printed by the dry run).');
  await assertRemoteIsMk();
  await requireRepairSchema({ forApply: APPLY });
  await requireKeepUpdatedAt({ forApply: APPLY });
  if (APPLY) { requireQuietWindow({ override: !!args['outside-quiet-window'] }); await requireNoSegmentRecompute('start the apply'); }
  const expected = parseExpect(args.expect, EXPECTED);

  const pairs = await loadPairs();
  const payout = await loadPayoutOrderIds(pairs.flatMap((p) => [p.c_id, p.x_id]));
  const plan = classifyPairs({ pairs, payout, runTag: APPLY ? String(args.run).slice(0, 8) : 'dry-run' });
  if (plan.units.some((u) => u.rows.some((r) => r.set?.status === 'confirmed'))) die('a row would be set to confirmed — refusing.');
  printTable(plan.csv.map((r) => ({ crm: r.crm_order, status: r.crm_status, '→': r.target || '=', collabbox: r.collabbox_order, cb: r.collabbox_status,
    parcel: r.parcel_status, cod: r.cod_mkd, price: r.price_mkd, action: r.action, why: r.why })));
  const csvPath = writeCsv(`${KEY}-${APPLY ? 'apply-' : ''}${fileStamp()}.csv`, plan.csv);
  ok(`CSV (contains PII — stays in exports/, never commit): ${csvPath}`);

  if (!APPLY) {
    const drift = checkDrift(plan.counts, expected);
    printTable(drift.rows);
    if (!drift.pass) die(`Counts drifted — NO run recorded. If understood, re-run with --expect ${expectString(plan.counts, Object.keys(expected))}`);
    const { id, hash } = await recordDryRun({ key: KEY, lines: plan.lines, summary: { script: 'repair-crm-collabbox-twins.mjs', expected, counts: plan.counts, csv: csvPath.split(/[\\/]/).pop() } });
    console.log(bold(`\nDry run recorded: ${green(id)}`) + `  (hash ${hash.slice(0, 12)}…)\n  node scripts/repair-crm-collabbox-twins.mjs --apply --run ${id}\n`);
    return;
  }
  const actor = await resolveActor(args.actor || 'mile@elyon.com');
  const { done } = await verifyRunForApply({ key: KEY, runId: args.run, lines: plan.lines });
  const units = plan.units.filter((u) => !u.rows.some((r) => done.has(r.order_id)));
  const typeMap = await loadOrderColumnTypes();
  const stats = await applyUnits({ key: KEY, runId: args.run, units, typeMap });
  const payload = { script: 'repair-crm-collabbox-twins.mjs', counts: plan.counts, applied_orders: stats.applied, links: stats.links,
    skipped_moved: stats.skipped, outside_quiet_window: !!args['outside-quiet-window'] };
  if (stats.failed) { await auditPartial({ key: KEY, runId: args.run, actor, payload: { ...payload, failed: stats.failed } }); die(`Stopped at chunk ${stats.failed.chunk}.`); }
  await finalizeRun({ key: KEY, runId: args.run, actor, payload });
  ok(`run ${args.run} applied — ${stats.applied} orders, ${stats.links} parcel links`);
  const [v] = await sqlRead(`select
      (select count(*) from public.data_repair_rows r join public.orders o on o.id = r.order_id
        where r.run_id = ${qUuid(args.run)} and r.rule = 'CC_keeps' and o.mex_tracking_id is not null)::int as crm_with_parcel,
      (select count(*) from public.data_repair_rows r join public.orders o on o.id = r.order_id
        where r.run_id = ${qUuid(args.run)} and r.rule = 'CC_duplicate' and o.status = 'duplicated' and o.mex_tracking_id is null)::int as copies_retired`);
  printTable([v]);
  console.log(yellow('  Next: node scripts/verify-attribution.mjs (C8) and the Insights ties.\n'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => die(e.stack || e.message || String(e)));
}
