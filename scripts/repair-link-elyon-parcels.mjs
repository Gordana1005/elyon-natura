/**
 * Repair — BIO NATURAL (Elyon account, series 9110 LEADS / 9103 LEADS-OUT) MEX parcels that no
 * CRM order holds although their sale IS in the CRM. No shebang (repair-kit convention). Run with
 * `node`.
 *
 * Found 28.09.2026 (read-only trace of the Overview's "Elyon сметка — неповрзани" — 163 parcels /
 * 512.510 ден in 22–28.09): about two thirds are real CRM sales the MEX reconcile could not
 * reach, and a third of those were counted TWICE (the order as "to pack" / returned, and the
 * parcel again as MEX-only):
 *   cancel_then_ship  the AlterCPA lead was cancelled / trashed in their panel and then shipped
 *                     through collabBox LEADS; the COD fits only the lead's price as edited in
 *                     AlterCPA (our order kept the import price), so rule C never matched.
 *   no_parcel         an open / "paid without proof" order on the same customer that holds no
 *                     parcel — often a malformed stored phone (+38938…, 07…): the reconcile
 *                     matches the exact phone string, this repair matches the last 8 digits.
 *   reship            the same sale re-sent after its first parcel came back (returned) or died at
 *                     "label": the order holds the dead parcel, the new one stood alone.
 *
 * OWNER LAW: MEX alone decides shipped / paid / returned (rule C: a parcel that appears on a
 * cancelled AlterCPA lead reopens it); a parcel belongs to the order it was shipped for; one sale
 * is counted once. Nothing is pushed to AlterCPA.
 *
 * A parcel is linked only when EXACTLY ONE order fits it and that order fits no other parcel:
 *   parcel   series 9110/9103 (or BIO NATURAL with no series), COD > 0, created in the last 75
 *            days, no order holds or names it, not a test phone.
 *   no_parcel / cancel_then_ship candidate: an AlterCPA or ElyonCRM real sale (price > 0, a real
 *            product, not a disposition row) on the same last-8 phone, holding no parcel, created
 *            from 10 days before to 1 day after the parcel; status open / paid / shipped /
 *            returned, or cancelled / trashed for AlterCPA; COD = price × 61,5 (±3, or +150
 *            delivery ±3) — for AlterCPA also the lead's current AlterCPA price.
 *   reship   candidate: an order on the same last-8 phone whose OWN parcel is returned (7) or at
 *            label (8), created before the new parcel and at most 30 days earlier; COD equal to
 *            that parcel's (±3) or fitting the price.
 * Status follows the parcel: delivered → paid (MEX time, basis mex), returned → returned, anything
 * else → shipped. The dead first parcel stays in the register linked to its order (a re-send —
 * mex_link_parcel keeps the NEWER parcel on the order; checker C8c lists it as WARN).
 * Prices are not touched here: scripts/repair-cod-price.mjs follows the COD afterwards.
 *
 *   node scripts/repair-link-elyon-parcels.mjs                        # dry run → CSV + run id
 *   node scripts/repair-link-elyon-parcels.mjs --apply --run <id> [--actor mile@elyon.com] [--outside-quiet-window]
 *   undo: node scripts/rollback-repair.mjs --run <id> [--apply]
 *
 * 🛑 Macedonia only (repair-kit guards). Payout / bonus math untouched.
 */
import { pathToFileURL } from 'node:url';
import {
  MK_REF, bold, green, yellow, die, ok,
  mkGuard, sqlRead, assertRemoteIsMk, requireRepairSchema, loadOrderColumnTypes,
  qUuid, parseArgs, parseExpect, checkDrift, expectString,
  toMs, expectedCodMkd, codFit, fmtMkd, fmtSkopje, fileStamp, writeCsv, planLine, DAY_MS,
  loadPayoutOrderIds, loadPhoneOrders, stickyTrashEffects, printTrashFalls, mexStatusSet, parcelWord,
  isSyntheticProductName, resolveActor, recordDryRun, verifyRunForApply, applyUnits, finalizeRun, auditPartial,
  requireKeepUpdatedAt, requireQuietWindow, requireNoSegmentRecompute, printTable, tally,
} from './lib/repair-kit.mjs';
import { altercpaMkd } from './lib/cod-price.mjs';

export const KEY = 'link-elyon-parcels';
/** Measured 2026-09-28 on the live rows (see the dry run in the status file). */
export const EXPECTED = { parcels: 669, link: 141, manual: 17 };
const OPEN = new Set(['pending', 'call_again', 'confirmed']);
const SOLD = new Set(['paid', 'delivered', 'shipped', 'returned']);

export async function loadCandidates() {
  return sqlRead(`
    with ex as (select public.report_excluded_phone8s() as p8s),
    pr as materialized (
      select p.tracking_id, p.account, p.series, p.status_id, p.status_name, p.cod_mkd, p.phone8,
             p.created_at_mex, p.delivered_at, p.returned_at, p.last_update_at
        from public.mex_parcels p, ex
       where p.order_id is null and coalesce(p.cod_mkd, 0) > 0 and p.phone8 ~ '^[0-9]{8}$'
         and (p.series in ('9110', '9103') or (coalesce(p.series, '') = '' and p.account = 'bio_natural'))
         and p.created_at_mex >= now() - interval '75 days'
         and not (p.phone8 = any(ex.p8s))
         and not exists (select 1 from public.orders n where n.mex_tracking_id = p.tracking_id))
    select pr.tracking_id, pr.account, pr.series, pr.status_id, pr.status_name, pr.cod_mkd, pr.phone8,
           pr.created_at_mex, pr.delivered_at, pr.returned_at, pr.last_update_at,
           o.id, o.display_id, o.status::text as status, o.price, o.product_name, o.sale_source, o.sale_source_detail,
           o.customer_phone, o.created_at, o.paid_basis, o.mex_tracking_id as held_tracking,
           h.status_id as held_status, h.cod_mkd as held_cod, h.created_at_mex as held_created, h.order_id as held_order,
           l.payload->>'price' as cpa_price, l.payload->>'currency' as cpa_currency
      from pr
      left join public.orders o
        on right(regexp_replace(o.customer_phone, '[^0-9]', '', 'g'), 8) = pr.phone8
       and o.created_at between pr.created_at_mex - interval '40 days' and pr.created_at_mex + interval '1 day'
       and o.sale_source in ('altercpa', 'elyon_crm')
       and o.status::text not in ('take', 'duplicated')
      left join public.mex_parcels h on h.tracking_id = o.mex_tracking_id
      left join lateral (select ll.payload from public.altercpa_leads ll where ll.order_id = o.id
                          order by ll.last_seen_at desc nulls last limit 1) l on true
     order by pr.created_at_mex, pr.tracking_id`);
}

const fitsMkd = (expMkd, cod) => expMkd > 0 && (Math.abs(cod - expMkd) <= 3 || Math.abs(cod - expMkd - 150) <= 3);

/** How (if at all) order row `r` fits its parcel. */
export function fitOf(r) {
  if (!r.id) return null;
  const cod = Number(r.cod_mkd);
  const pMs = toMs(r.created_at_mex), oMs = toMs(r.created_at);
  const realSale = Number(r.price) > 0 && r.sale_source_detail !== 'disposition' && !isSyntheticProductName(r.product_name);
  if (!r.held_tracking) {
    if (!realSale || oMs < pMs - 10 * DAY_MS || oMs > pMs + DAY_MS) return null;
    const statusOk = OPEN.has(r.status) || SOLD.has(r.status) || (r.sale_source === 'altercpa' && ['cancelled', 'trashed'].includes(r.status));
    if (!statusOk) return null;
    const byPrice = codFit(r.price, cod);
    const cpaMkd = r.sale_source === 'altercpa' ? altercpaMkd(r.cpa_price, r.cpa_currency) : null;
    const byLead = !byPrice && cpaMkd ? fitsMkd(cpaMkd, cod) : false;
    if (!byPrice && !byLead) return null;
    const kind = ['cancelled', 'trashed'].includes(r.status) ? 'cancel_then_ship' : 'no_parcel';
    return { kind, how: byPrice ? `price ${byPrice}` : 'AlterCPA lead price' };
  }
  // re-ship: the order holds its own dead parcel, older than this one, within 30 days
  if (r.held_order !== r.id || ![7, 8].includes(Number(r.held_status))) return null;
  const hMs = toMs(r.held_created);
  if (!(hMs < pMs) || pMs - hMs > 30 * DAY_MS) return null;
  const sameCod = Math.abs(cod - Number(r.held_cod)) <= 3;
  const byPrice = realSale && codFit(r.price, cod);
  if (!sameCod && !byPrice) return null;
  return { kind: 'reship', how: sameCod ? 'same COD as the first parcel' : `price ${byPrice}` };
}

/** The status the order takes from the parcel, 'basis' for a paid order that only gains its proof, or null. */
export function targetFor(order, p) {
  const s = Number(p.status_id);
  if (s === 2) return ['paid', 'delivered'].includes(order.status) ? (order.paid_basis === 'mex' ? null : 'basis') : 'paid';
  if (s === 7) return order.status === 'returned' ? null : 'returned';
  return order.status === 'shipped' ? null : 'shipped';
}

export function classifyLinks({ rows, payout = new Set(), runTag = 'dry-run' }) {
  const byParcel = new Map();
  for (const r of rows) {
    const e = byParcel.get(r.tracking_id) ?? byParcel.set(r.tracking_id, { p: r, fits: [] }).get(r.tracking_id);
    const f = fitOf(r);
    if (f) e.fits.push({ ...f, o: r });
  }
  const parcelsPerOrder = new Map();
  for (const e of byParcel.values()) if (e.fits.length === 1) {
    const id = e.fits[0].o.id; parcelsPerOrder.set(id, (parcelsPerOrder.get(id) || 0) + 1);
  }
  const units = [], csv = [], lines = [];
  const changes = new Map();
  const counts = { parcels: byParcel.size, link: 0, manual: 0, no_fit: 0, cancel_then_ship: 0, no_parcel: 0, reship: 0 };
  for (const [tracking, e] of byParcel) {
    const p = e.p;
    let action = 'link', why = '';
    if (!e.fits.length) { counts.no_fit++; continue; }
    if (e.fits.length > 1) { action = 'manual'; why = `${e.fits.length} orders fit (${e.fits.map((f) => f.o.display_id).join(', ')})`; }
    const f = e.fits[0], o = f.o;
    if (!why && parcelsPerOrder.get(o.id) > 1) { action = 'manual'; why = `${o.display_id} fits ${parcelsPerOrder.get(o.id)} parcels`; }
    if (!why && payout.has(o.id)) { action = 'manual'; why = `${o.display_id} is in agent_payout_items`; }
    counts[action]++;
    if (action === 'link') counts[f.kind]++;
    const target = action === 'link' ? targetFor(o, p) : null;
    const pTxt = `${p.status_id} ${p.status_name || ''}`.trim();
    csv.push({ tracking, series: p.series || '', parcel_status: pTxt, cod_mkd: p.cod_mkd, parcel_created: fmtSkopje(p.created_at_mex),
      order: action === 'link' ? o.display_id : e.fits.map((x) => x.o.display_id).join(' | '), source: o.sale_source, status: o.status,
      price_mkd: expectedCodMkd(o.price), kind: f.kind, fit: f.how, target: target || '', held: o.held_tracking || '', action, why });
    const line = planLine(o.id, action, `${f.kind}:${target || ''}`, tracking);
    lines.push(line);
    if (action !== 'link') continue;
    if (target && target !== 'basis') changes.set(o.id, { status: target });
    const set = target === 'basis' ? { paid_basis: 'mex' } : target ? mexStatusSet(target, p) : {};
    const what = f.kind === 'reship'
      ? `the same sale was re-sent after its first parcel ${o.held_tracking} ${Number(o.held_status) === 7 ? 'came back' : 'died at label'}; the order now follows the new parcel`
      : f.kind === 'cancel_then_ship'
        ? `the lead was ${o.status} in AlterCPA's panel and then shipped (fit: ${f.how}) — MEX outranks the panel (rule C)`
        : `the reconcile never reached it (fit: ${f.how}, same customer by the last 8 digits)`;
    units.push({
      unit: `le:${tracking}`,
      rows: [{
        unit: `le:${tracking}`, order_id: o.id, rule: `LE_${f.kind}`, line,
        expect_status: o.status, expect_tracking: o.held_tracking ?? null, set,
        link: { tracking, method: 'repair', force: false, expectOwner: null }, unlink: null,
        history: target && target !== 'basis' ? { from: o.status, to: target } : null,
        note: `Repair ${KEY} (run ${runTag}): MEX ${p.account || ''} parcel ${tracking} (${pTxt}, created ${fmtSkopje(p.created_at_mex)}, COD ${fmtMkd(p.cod_mkd)} ден) ` +
          `was shipped for this order and stood alone in the register: ${what}. It is linked here` +
          (target === 'basis' ? '; the order was already paid and MEX proves it.' : target ? ` and the status follows MEX: ${o.status} → ${target} (${parcelWord(p)}).` : '.'),
        evidence: { key: KEY, order: o.display_id, tracking, kind: f.kind, fit: f.how, target, parcel_status: p.status_id, cod_mkd: p.cod_mkd,
          price_mkd: expectedCodMkd(o.price), held: o.held_tracking || null },
      }],
    });
  }
  return { units, csv, lines, counts, changes };
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { flags: ['apply', 'outside-quiet-window', 'help'], values: ['run', 'expect', 'actor'] });
  if (args.help) { console.log('usage: node scripts/repair-link-elyon-parcels.mjs [--expect k=n,…] | --apply --run <id> [--actor <email>] [--outside-quiet-window]'); return; }
  mkGuard();
  const APPLY = !!args.apply;
  console.log(bold(`\nRepair — ${KEY} — ${APPLY ? 'APPLY' : 'DRY RUN'}  (${MK_REF})\n`));
  if (APPLY && !args.run) die('--apply needs --run <id> (printed by the dry run).');
  await assertRemoteIsMk();
  await requireRepairSchema({ forApply: APPLY });
  await requireKeepUpdatedAt({ forApply: APPLY });
  if (APPLY) { requireQuietWindow({ override: !!args['outside-quiet-window'] }); await requireNoSegmentRecompute('start the apply'); }
  const expected = parseExpect(args.expect, EXPECTED);

  const rows = await loadCandidates();
  const payout = await loadPayoutOrderIds([...new Set(rows.map((r) => r.id).filter(Boolean))]);
  const plan = classifyLinks({ rows, payout, runTag: APPLY ? String(args.run).slice(0, 8) : 'dry-run' });
  if (plan.units.some((u) => u.rows.some((r) => r.set?.status === 'confirmed'))) die('a row would be set to confirmed — refusing.');
  const phoneRows = await loadPhoneOrders([...new Set(plan.units.flatMap((u) => u.rows.map((r) => rows.find((x) => x.id === r.order_id)?.customer_phone)).filter(Boolean))]);
  const trash = stickyTrashEffects(phoneRows, plan.changes);

  printTable(Object.entries(tally(plan.csv, (r) => `${r.action} · ${r.kind} · ${r.status} → ${r.target || 'same'}`, (r) => r.cod_mkd))
    .map(([k, v]) => ({ case: k, parcels: v.orders, 'COD (ден)': fmtMkd(v.mkd) })));
  console.log(`  parcels in scope ${plan.counts.parcels} · no fitting order ${plan.counts.no_fit} (MEX-only sales — nothing to link)`);
  const trashCount = printTrashFalls(trash);
  console.log(`  customers released from Trash (an order becomes paid): ${trash.released.length}`);
  const csvPath = writeCsv(`${KEY}-${APPLY ? 'apply-' : ''}${fileStamp()}.csv`, plan.csv);
  ok(`CSV (contains PII — stays in exports/, never commit): ${csvPath}`);

  if (!APPLY) {
    const counts = { parcels: plan.counts.parcels, link: plan.counts.link, manual: plan.counts.manual };
    const drift = checkDrift(counts, expected);
    printTable(drift.rows);
    if (!drift.pass) die(`Counts drifted — NO run recorded. If understood, re-run with --expect ${expectString(counts, Object.keys(expected))}`);
    const { id, hash } = await recordDryRun({ key: KEY, lines: plan.lines, summary: { script: 'repair-link-elyon-parcels.mjs', expected, counts: plan.counts,
      trash_falls_permanent: trashCount.permanent, trash_released: trash.released.length, csv: csvPath.split(/[\\/]/).pop() } });
    console.log(bold(`\nDry run recorded: ${green(id)}`) + `  (hash ${hash.slice(0, 12)}…)\n  node scripts/repair-link-elyon-parcels.mjs --apply --run ${id}\n`);
    return;
  }
  const actor = await resolveActor(args.actor || 'mile@elyon.com');
  const { done } = await verifyRunForApply({ key: KEY, runId: args.run, lines: plan.lines });
  const units = plan.units.filter((u) => !u.rows.some((r) => done.has(r.order_id)));
  const typeMap = await loadOrderColumnTypes();
  const stats = await applyUnits({ key: KEY, runId: args.run, units, typeMap });
  const payload = { script: 'repair-link-elyon-parcels.mjs', counts: plan.counts, applied_orders: stats.applied, links: stats.links,
    skipped_moved: stats.skipped, outside_quiet_window: !!args['outside-quiet-window'] };
  if (stats.failed) { await auditPartial({ key: KEY, runId: args.run, actor, payload: { ...payload, failed: stats.failed } }); die(`Stopped at chunk ${stats.failed.chunk}.`); }
  await finalizeRun({ key: KEY, runId: args.run, actor, payload });
  ok(`run ${args.run} applied — ${stats.applied} orders, ${stats.links} parcel links${stats.skipped.length ? `, ${stats.skipped.length} left alone (moved since the dry run)` : ''}`);
  const [v] = await sqlRead(`select
      (select count(*) from public.data_repair_rows where run_id = ${qUuid(args.run)} and after is not null)::int as ledger_rows,
      (select count(*) from public.data_repair_rows r join public.orders o on o.id = r.order_id
        where r.run_id = ${qUuid(args.run)} and ((o.status = 'paid' and o.mex_status_id <> 2) or (o.status = 'returned' and o.mex_status_id <> 7)))::int as status_disagrees`);
  printTable([v]);
  console.log(yellow('  Next: node scripts/repair-cod-price.mjs (dry run), node scripts/verify-attribution.mjs.\n'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => die(e.stack || e.message || String(e)));
}
