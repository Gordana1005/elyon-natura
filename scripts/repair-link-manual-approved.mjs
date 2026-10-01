/**
 * Repair — link the parcels the OWNER APPROVED from the phone + date linker's manual list (owner, Mile, 01.10.2026).
 * No shebang (repair-kit convention: the test suite imports this file). Run with `node`.
 *
 * The nightly linker (public.link_lead_parcels_plan, 20260944000950) lists a parcel with more than one candidate order
 * for a human. A read-only reviewer proposed one pick per listed parcel in
 * exports/MEX_рачна_проверка_предлог_2026-10-01.xlsx (sheet "Рачна проверка", column "предлог": "ПОВРЗИ со ORD-…" /
 * "НЕ ПОВРЗУВАЈ" / "ЗА ГАЗДАТА"). The owner approved linking ALL "ПОВРЗИ" rows — 32 parcels (19 high + 13 medium).
 * "НЕ ПОВРЗУВАЈ" and "ЗА ГАЗДАТА" rows are never touched.
 *
 * Every pair is re-validated LIVE (scripts/lib/link-manual-approved.mjs validatePair): the parcel is still an orphan
 * BIO NATURAL lead parcel (no order holds or names it), the order still holds no parcel, is on the parcel's last-8
 * phone, created −10 d … +1 d, a priced real sale in a candidate status, not in agent_payout_items, not an affiliate
 * lead, and no other approved pair uses the same order or parcel. A row that no longer validates is listed and skipped.
 *
 * APPLY = the same semantics as public.link_lead_parcels(): mex_link_parcel(…, 'repair'); the order follows MEX
 * (2 → paid, paid_basis 'mex' · 7 → returned · 8 → unchanged · else → shipped); disposition fields cleared;
 * order_history + one note "linked by owner-approved manual review 01.10.2026"; ledger before / after — through the
 * repair-kit's applyUnits (one ≤ 200-order transaction, SET LOCAL elyon.bulk_repair / keep_updated_at). Nothing is
 * pushed to AlterCPA; prices are not touched (scripts/repair-cod-price.mjs follows the COD afterwards).
 *
 *   node scripts/repair-link-manual-approved.mjs [--file <xlsx|csv>] [--expect approved=32,link=32]
 *        dry run → CSV in exports/repairs (PII) + a data_repair_runs dry-run row + the run id
 *   node scripts/repair-link-manual-approved.mjs --apply --run <id> [--file …] [--actor mile@elyon.com] [--outside-quiet-window]
 *   undo: node scripts/rollback-repair.mjs --run <id> [--apply] [--loose]
 *   then: node scripts/collabbox-recredit.mjs (dry run) — the LEADS documents of the linked parcels get their seller
 *
 * 🛑 Macedonia only (repair-kit guards). Payout / bonus math untouched.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as XLSX from 'xlsx';
import {
  ROOT, MK_REF, bold, green, yellow, die, warn, ok,
  mkGuard, sqlRead, assertRemoteIsMk, requireRepairSchema, requireKeepUpdatedAt, requireQuietWindow,
  requireNoSegmentRecompute, loadOrderColumnTypes, qTextArray, qUuidArray, parseArgs, parseExpect, checkDrift,
  expectString, fmtMkd, fmtSkopjeDate, fileStamp, writeCsv, loadPayoutOrderIds, loadPhoneOrders, stickyTrashEffects,
  printTrashFalls, resolveActor, recordDryRun, verifyRunForApply, applyUnits, finalizeRun, auditPartial, printTable, tally,
  qUuid,
} from './lib/repair-kit.mjs';
import { KEY, SOURCE_XLSX, SHEET, EXPECTED, parseApprovedRows, classifyApproved, moveRows } from './lib/link-manual-approved.mjs';

/** The reviewer's sheet (xlsx) or a CSV derived from it → row objects. */
export function readSource(file) {
  const path = isAbsolute(file) ? file : join(ROOT, file);
  if (!existsSync(path)) die(`${file} not found — the reviewer's list belongs in exports/ (gitignored, PII).`);
  const wb = XLSX.read(readFileSync(path), { type: 'buffer' });
  const ws = wb.Sheets[SHEET] ?? (/\.csv$/i.test(path) ? wb.Sheets[wb.SheetNames[0]] : null);
  if (!ws) die(`${file}: no sheet "${SHEET}".`);
  return XLSX.utils.sheet_to_json(ws, { defval: '' });
}

/** The live rows the validation reads: the parcels (+ who names them) and the orders (+ register rows held). */
export async function loadLive(approved) {
  const trs = [...new Set(approved.map((a) => a.tracking))];
  const ids = [...new Set(approved.map((a) => a.display_id))];
  const parcels = new Map((trs.length ? await sqlRead(`select p.tracking_id, p.account, p.series, p.status_id, p.status_name, p.cod_mkd,
        p.phone8, p.created_at_mex, p.delivered_at, p.returned_at, p.last_update_at, p.order_id,
        (select o.display_id from public.orders o where o.id = p.order_id) as order_display,
        (select count(*) from public.orders n where n.mex_tracking_id = p.tracking_id)::int as named_by,
        (select string_agg(n.display_id, ', ') from public.orders n where n.mex_tracking_id = p.tracking_id) as named_display
      from public.mex_parcels p where p.tracking_id = any(${qTextArray(trs)})`) : []).map((r) => [r.tracking_id, r]));
  const orderRows = ids.length ? await sqlRead(`select o.id, o.display_id, o.status::text as status, o.customer_phone, o.created_at,
        o.price, o.product_name, o.sale_source, o.sale_source_detail, o.paid_basis, o.mex_tracking_id,
        (select count(*) from public.mex_parcels m where m.order_id = o.id)::int as held
      from public.orders o where o.display_id = any(${qTextArray(ids)})`) : [];
  const dupIds = Object.entries(tally(orderRows, (r) => r.display_id)).filter(([, v]) => v.orders > 1).map(([k]) => k);
  if (dupIds.length) die(`display ids on more than one order: ${dupIds.join(', ')} — refusing.`);
  const orders = new Map(orderRows.map((r) => [r.display_id, r]));
  const oids = orderRows.map((r) => r.id);
  const payout = await loadPayoutOrderIds(oids);
  const affiliate = new Set(oids.length ? (await sqlRead(`select distinct order_id from public.affiliate_leads
      where order_id = any(${qUuidArray(oids)})`)).map((r) => r.order_id) : []);
  const [ex] = await sqlRead('select public.report_excluded_phone8s() as p8s');
  const excludedPhones = new Set(Array.isArray(ex?.p8s) ? ex.p8s : String(ex?.p8s ?? '').replace(/[{}]/g, '').split(',').filter(Boolean));
  return { parcels, orders, ctx: { payout, affiliate, excludedPhones } };
}

/** The collabBox document of each linked parcel — what scripts/collabbox-recredit.mjs will find afterwards. */
async function documentsOf(trackings) {
  if (!trackings.length) return [];
  return sqlRead(`select d.doc_number, d.doc_type_id, d.role, d.outcome, d.reason, d.doc_at, d.booked_at, d.author
      from public.collabbox_documents d where d.doc_number = any(${qTextArray(trackings)})`)
    .then((rows) => rows.map((d) => ({ ...d, month: fmtSkopjeDate(d.doc_at).slice(3) })));
}

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    flags: ['apply', 'outside-quiet-window', 'help'], values: ['run', 'expect', 'actor', 'file'],
  });
  if (args.help) {
    console.log('usage: node scripts/repair-link-manual-approved.mjs [--file <xlsx|csv>] [--expect approved=32,link=32]\n' +
      '       node scripts/repair-link-manual-approved.mjs --apply --run <id> [--file …] [--actor <email>] [--outside-quiet-window]');
    return;
  }
  mkGuard();
  const APPLY = !!args.apply;
  console.log(bold(`\nRepair — ${KEY} — ${APPLY ? 'APPLY' : 'DRY RUN'}  (${MK_REF})\n`));
  if (APPLY && !args.run) die('--apply needs --run <id> (printed by the dry run).');
  await assertRemoteIsMk();
  await requireRepairSchema({ forApply: APPLY });
  await requireKeepUpdatedAt({ forApply: APPLY });
  if (APPLY) { requireQuietWindow({ override: !!args['outside-quiet-window'] }); await requireNoSegmentRecompute('start the apply'); }

  const file = args.file || SOURCE_XLSX;
  const { approved, other, bad } = parseApprovedRows(readSource(file));
  console.log(`  ${file}: ${approved.length} approved ("ПОВРЗИ со ORD-…") · not linked by this repair: ${JSON.stringify(other)}`);
  for (const b of bad) warn(`row ${b.n}: ${b.tracking} — ${b.why}`);
  const live = await loadLive(approved);
  const plan = classifyApproved({ approved, ...live, runId: APPLY ? args.run : null });
  if (plan.units.some((u) => u.rows.some((r) => r.set?.status === 'confirmed'))) die('a row would be set to confirmed — refusing.');

  printTable(moveRows(plan.csv));
  console.log(`  link ${plan.counts.link} (${plan.counts.high} high, ${plan.counts.medium} medium) · skipped ${plan.counts.skipped}`);
  for (const s of plan.csv.filter((r) => r.action === 'skip')) console.log(yellow(`    skip row ${s.n} ${s.tracking} → ${s.order}: ${s.why}`));
  const phones = [...plan.units.flatMap((u) => u.rows.map((r) => live.orders.get(r.evidence.order)?.customer_phone))].filter(Boolean);
  const trash = stickyTrashEffects(await loadPhoneOrders(phones), plan.changes);
  const trashCount = printTrashFalls(trash);
  console.log(`  customers released from Trash (an order becomes paid): ${trash.released.length}`);
  const linked = plan.csv.filter((r) => r.action === 'link');
  const docs = await documentsOf(linked.map((r) => r.tracking));
  printTable(Object.entries(tally(docs, (d) => `${d.doc_type_id} ${d.outcome}${d.reason ? ` (${d.reason})` : ''} · ${d.month}`))
    .map(([k, v]) => ({ 'collabBox document of a linked parcel': k, documents: v.orders })));
  console.log(`  linked parcels with no collabBox document: ${linked.length - docs.length}`);
  const csvPath = writeCsv(`${KEY}-${APPLY ? 'apply-' : ''}${fileStamp()}.csv`, plan.csv);
  ok(`CSV (contains PII — stays in exports/, never commit): ${csvPath}`);

  if (!APPLY) {
    const expected = parseExpect(args.expect, EXPECTED);
    const counts = { approved: plan.counts.approved, link: plan.counts.link };
    const drift = checkDrift(counts, expected);
    printTable(drift.rows);
    if (!drift.pass) die(`Counts drifted — NO run recorded. If understood, re-run with --expect ${expectString(counts, Object.keys(expected))}`);
    const { id, hash } = await recordDryRun({ key: KEY, lines: plan.lines, summary: {
      script: 'repair-link-manual-approved.mjs', source: file, owner_approved: '2026-10-01', expected, counts: plan.counts,
      skipped: plan.csv.filter((r) => r.action === 'skip').map((r) => ({ row: r.n, tracking: r.tracking, order: r.order, why: r.why })),
      trash_falls_permanent: trashCount.permanent, trash_released: trash.released.length,
      documents: tally(docs, (d) => `${d.doc_type_id}:${d.outcome}:${d.reason ?? ''}:${d.month}`), csv: csvPath.split(/[\\/]/).pop() } });
    console.log(bold(`\nDry run recorded: ${green(id)}`) + `  (hash ${hash.slice(0, 12)}…)\n` +
      `  node scripts/repair-link-manual-approved.mjs --apply --run ${id}${args.file ? ` --file ${args.file}` : ''}\n` +
      `  undo: node scripts/rollback-repair.mjs --run ${id}\n`);
    return;
  }
  const actor = await resolveActor(args.actor || 'mile@elyon.com');
  const { done } = await verifyRunForApply({ key: KEY, runId: args.run, lines: plan.lines });
  const units = plan.units.filter((u) => !u.rows.some((r) => done.has(r.order_id)));
  const typeMap = await loadOrderColumnTypes();
  const stats = await applyUnits({ key: KEY, runId: args.run, units, typeMap });
  const payload = { script: 'repair-link-manual-approved.mjs', source: file, counts: plan.counts, applied_orders: stats.applied,
    links: stats.links, skipped_moved: stats.skipped, outside_quiet_window: !!args['outside-quiet-window'] };
  if (stats.failed) { await auditPartial({ key: KEY, runId: args.run, actor, payload: { ...payload, failed: stats.failed } }); die(`Stopped at chunk ${stats.failed.chunk}.`); }
  await finalizeRun({ key: KEY, runId: args.run, actor, payload });
  ok(`run ${args.run} applied — ${stats.applied} orders, ${stats.links} parcel links${stats.skipped.length ? `, ${stats.skipped.length} left alone (moved since the dry run)` : ''}`);
  const [v] = await sqlRead(`select
      (select count(*) from public.data_repair_rows where run_id = ${qUuid(args.run)} and after is not null)::int as ledger_rows,
      (select count(*) from public.data_repair_rows r join public.orders o on o.id = r.order_id
        where r.run_id = ${qUuid(args.run)} and o.mex_tracking_id is distinct from r.evidence->>'tracking')::int as not_holding,
      (select count(*) from public.data_repair_rows r join public.orders o on o.id = r.order_id
        where r.run_id = ${qUuid(args.run)} and ((o.status = 'paid' and o.mex_status_id <> 2) or (o.status = 'returned' and o.mex_status_id <> 7)))::int as status_disagrees`);
  printTable([v]);
  console.log(yellow(`  Next: node scripts/collabbox-recredit.mjs --from 2026-07-01 --to 2026-09-30 (dry run) · node scripts/repair-cod-price.mjs (dry run) ·\n` +
    `        node scripts/verify-parcel-link-rules.mjs · undo: node scripts/rollback-repair.mjs --run ${args.run}\n`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => die(e.stack || e.message || String(e)));
}
