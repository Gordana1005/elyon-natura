/**
 * Repair — the teleshop "twin" parcels: a collabBox Нарачка in/out document whose sale is ALREADY
 * in the CRM as another order (usually an AlterCPA lead the teleshop team confirmed in AlterCPA's
 * panel and then booked in collabBox). No shebang (repair-kit convention). Run with `node`.
 *
 * The teleshop history import (scripts/import-teleshop-collabbox.mjs, run 8bb49e8e, 28.09.2026)
 * never creates such a document — the sale would count twice — and records it in
 * teleshop_import_documents as outcome 'conflict', reason likely_twin_crm_sale_price_differs /
 * possible_twin_crm_sale, with related_order_id = the CRM order and tracking_id = the document's
 * MEX parcel (DocNumber = tracking id). From the MEX era those parcels stayed UNLINKED, so the
 * twin kept its own status: 9 were "paid" while MEX returned the parcel, 8 "confirmed" while MEX
 * moved it (independent audit, 28.09.2026).
 *
 * OWNER (28.09.2026): "the teleshop team also confirms in AlterCPA — it is still the system they
 * use until everyone moves to our CRM; link everything that has to be linked, make it accurate."
 * OWNER LAW: MEX alone decides shipped / paid / returned; a parcel belongs to the order it was
 * shipped for; one sale is counted once.
 *
 * ACTION per case (re-validated against the live rows):
 *   link    mex_link_parcel(T, R, 'collabbox_import'): R names the parcel and carries its facts;
 *           R's status follows MEX (kit mexTargetFor — delivered → paid with the MEX time,
 *           returned → returned, moving → shipped only from an open status). A twin already
 *           paid on a delivered parcel keeps its status and gets paid_basis 'mex'.
 *   manual  listed, never written: the parcel is not in the register / the register or another
 *           order holds it / R already names another parcel / another phone / R take/duplicated /
 *           R in agent_payout_items / two documents point at the same R.
 * The price is NOT touched here: once linked, scripts/repair-cod-price.mjs (owner rule "COD ≠
 * price → MEX is right") re-prices the ones whose COD differs — it trusts a teleshop parcel on a
 * non-teleshop order only when this ledger names that order as the document's sale (collab_twin).
 * The ledger's reason parcel_held_by_other_order (the parcel was already linked to its twin by
 * mex-reconcile) needs no link — only the price follow-up.
 *
 *   node scripts/repair-teleshop-twin-links.mjs                        # dry run → CSV + run id
 *   node scripts/repair-teleshop-twin-links.mjs --apply --run <id> [--actor mile@elyon.com] [--outside-quiet-window]
 *   undo: node scripts/rollback-repair.mjs --run <id> [--apply]
 *
 * 🛑 Macedonia only (repair-kit guards). Payout / bonus math untouched.
 */
import { pathToFileURL } from 'node:url';
import {
  MK_REF, bold, green, yellow, die, warn, ok,
  mkGuard, sqlRead, assertRemoteIsMk, requireRepairSchema, loadOrderColumnTypes,
  qUuid, parseArgs, parseExpect, checkDrift, expectString,
  phone8, expectedCodMkd, codFit, fmtMkd, fmtSkopje, fileStamp, writeCsv, planLine,
  loadPayoutOrderIds, loadPhoneOrders, stickyTrashEffects, printTrashFalls,
  mexTargetFor, mexStatusSet, parcelWord,
  resolveActor, recordDryRun, verifyRunForApply, applyUnits, finalizeRun, auditPartial,
  requireKeepUpdatedAt, requireQuietWindow, requireNoSegmentRecompute, printTable, tally,
} from './lib/repair-kit.mjs';

export const KEY = 'teleshop-twin-links';
const TWIN_REASONS = ['likely_twin_crm_sale_price_differs', 'possible_twin_crm_sale'];

/** Measured 2026-09-28 (the audit's 57 MEX-era twins). */
export const EXPECTED = { cases: 57, link: 57, manual: 0, followed: 17 };

// ─── loaders (read-only) ────────────────────────────────────────────────────
export async function loadCases() {
  return sqlRead(`
    select d.doc_number, d.reason, d.tracking_id, d.amount_mkd, d.author, d.doc_at, d.phone8 as doc_phone8,
           o.id, o.display_id, o.status::text as status, o.price, o.product_name, o.source_type, o.external_source,
           o.customer_phone, o.mex_tracking_id, o.paid_basis, o.created_at,
           p.tracking_id as p_tracking, p.account, p.series, p.status_id, p.status_name, p.cod_mkd, p.phone8 as p_phone8,
           p.created_at_mex, p.delivered_at, p.returned_at, p.last_update_at, p.order_id as p_order,
           (select coalesce(jsonb_agg(x.display_id), '[]'::jsonb) from public.orders x
             where x.mex_tracking_id = d.tracking_id and x.id <> o.id) as namers,
           (select count(*) from public.teleshop_import_documents d2
             where d2.related_order_id = d.related_order_id and d2.outcome = 'conflict'
               and d2.reason = any(array['${TWIN_REASONS.join("','")}']) and d2.tracking_id is not null
               and d2.rolled_back_at is null)::int as docs_on_order
      from public.teleshop_import_documents d
      join public.orders o on o.id = d.related_order_id
      left join public.mex_parcels p on p.tracking_id = d.tracking_id
     where d.outcome = 'conflict' and d.rolled_back_at is null and d.tracking_id is not null
       and d.reason = any(array['${TWIN_REASONS.join("','")}'])
     order by d.doc_number`);
}

// ─── classification (pure — no I/O) ─────────────────────────────────────────
export function classifyTwins({ cases, payout = new Set(), runTag = 'dry-run' }) {
  const units = [], csv = [], lines = [];
  const changes = new Map();
  const counts = { cases: cases.length, link: 0, manual: 0, followed: 0, basis_only: 0 };
  for (const c of cases) {
    const t = c.tracking_id;
    const namers = Array.isArray(c.namers) ? c.namers : [];
    const parcelPhone = c.p_phone8 || c.doc_phone8 || '';
    let why = '';
    if (!c.p_tracking) why = 'the parcel is not in the MEX register';
    else if (c.p_order && c.p_order !== c.id) why = 'the register links the parcel to another order';
    else if (namers.length) why = `${t} is named by ${namers.join(', ')}`;
    else if (c.mex_tracking_id && c.mex_tracking_id !== t) why = `${c.display_id} already names ${c.mex_tracking_id}`;
    else if (parcelPhone && phone8(c.customer_phone) !== parcelPhone) why = `${c.display_id} is on another phone than the parcel`;
    else if (['take', 'duplicated'].includes(c.status)) why = `${c.display_id} is ${c.status}`;
    else if (Number(c.docs_on_order) > 1) why = `${c.docs_on_order} teleshop documents point at ${c.display_id} — which parcel is its own needs a human`;
    else if (payout.has(c.id)) why = `${c.display_id} is in agent_payout_items`;
    const action = why ? 'manual' : 'link';
    counts[action]++;

    const follow = action === 'link' ? mexTargetFor(c.status, c) : null;
    const basisOnly = action === 'link' && !follow && c.status === 'paid' && Number(c.status_id) === 2 && c.paid_basis !== 'mex';
    const pTxt = c.p_tracking ? `${c.status_id} ${c.status_name || ''}`.trim() : 'not in the register';
    csv.push({
      doc: c.doc_number, reason: c.reason, action, why, order: c.display_id, source: `${c.source_type}/${c.external_source || '-'}`,
      status: c.status, target: follow || (basisOnly ? 'paid (basis mex)' : ''), parcel_status: pTxt, account: c.account || '',
      cod_mkd: c.cod_mkd ?? '', price_mkd: expectedCodMkd(c.price), doc_mkd: c.amount_mkd ?? '', cod_fit: codFit(c.price, c.cod_mkd) || '',
      parcel_created: fmtSkopje(c.created_at_mex), order_created: fmtSkopje(c.created_at), doc_at: fmtSkopje(c.doc_at), author: c.author || '',
      product: c.product_name || '',
    });
    const line = planLine(c.id, action, follow || (basisOnly ? 'basis' : ''), t);
    lines.push(line);
    if (action !== 'link') continue;
    if (follow) { counts.followed++; changes.set(c.id, { status: follow }); }
    if (basisOnly) counts.basis_only++;

    units.push({
      unit: `tw:${t}`,
      rows: [{
        unit: `tw:${t}`, order_id: c.id, rule: 'TW_link', line,
        expect_status: c.status, expect_tracking: c.mex_tracking_id ?? null,
        set: follow ? mexStatusSet(follow, c) : basisOnly ? { paid_basis: 'mex' } : {},
        link: { tracking: t, method: 'collabbox_import', force: false, expectOwner: null },
        unlink: null,
        history: follow ? { from: c.status, to: follow } : null,
        note: `Repair ${KEY} (run ${runTag}): collabBox teleshop document ${c.doc_number} (${fmtSkopje(c.doc_at)}, ${fmtMkd(c.amount_mkd)} ден` +
          `${c.author ? `, ${c.author}` : ''}) shipped THIS sale — the teleshop team confirmed it in AlterCPA and booked it in collabBox. ` +
          `Its MEX parcel ${t} (${pTxt}, COD ${fmtMkd(c.cod_mkd)} ден) is linked here` +
          (follow ? ` and the status follows MEX: ${c.status} → ${follow} (${parcelWord(c)}).`
            : basisOnly ? '; the order was already paid and MEX proves it (delivered).'
              : `; status ${c.status} is unchanged (the parcel is ${parcelWord(c)}).`),
        evidence: { key: KEY, order: c.display_id, doc: c.doc_number, reason: c.reason, tracking: t, status_follow: follow,
          parcel_status: c.status_id, cod_mkd: c.cod_mkd, price_mkd: expectedCodMkd(c.price), doc_mkd: c.amount_mkd },
      }],
    });
  }
  return { units, csv, lines, counts, changes };
}

// ─── main ───────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2), {
    flags: ['apply', 'outside-quiet-window', 'help'],
    values: ['run', 'expect', 'actor'],
  });
  if (args.help) { console.log('usage: node scripts/repair-teleshop-twin-links.mjs [--expect k=n,…] | --apply --run <id> [--actor <email>] [--outside-quiet-window]'); return; }
  mkGuard();
  const APPLY = !!args.apply;
  console.log(bold(`\nRepair — ${KEY} — ${APPLY ? 'APPLY' : 'DRY RUN'}  (${MK_REF})\n`));
  if (APPLY && !args.run) die('--apply needs --run <id> (printed by the dry run).');
  await assertRemoteIsMk();
  await requireRepairSchema({ forApply: APPLY });
  await requireKeepUpdatedAt({ forApply: APPLY });
  if (APPLY) {
    requireQuietWindow({ override: !!args['outside-quiet-window'] });
    await requireNoSegmentRecompute('start the apply');
  }
  const expected = parseExpect(args.expect, EXPECTED);

  const cases = await loadCases();
  const payout = await loadPayoutOrderIds(cases.map((c) => c.id));
  ok(`${cases.length} MEX-era twin documents in the teleshop ledger`);
  const runTag = APPLY ? String(args.run).slice(0, 8) : 'dry-run';
  const plan = classifyTwins({ cases, payout, runTag });
  if (plan.units.some((u) => u.rows.some((r) => r.set?.status === 'confirmed'))) die('a row would be set to confirmed — refusing.');

  const phoneRows = await loadPhoneOrders(cases.map((c) => c.customer_phone));
  const trash = stickyTrashEffects(phoneRows, plan.changes);

  printTable(Object.entries(tally(plan.csv, (r) => `${r.action} · ${r.status} → ${r.target || 'same'}`, (r) => r.cod_mkd))
    .map(([k, v]) => ({ case: k, docs: v.orders, 'parcel COD (ден)': fmtMkd(v.mkd) })));
  for (const r of plan.csv.filter((x) => x.action === 'manual')) console.log(`  manual ${r.order} ${r.doc}: ${r.why}`);
  const trashCount = printTrashFalls(trash);
  console.log(`  customers released from Trash (an order becomes paid): ${trash.released.length}`);
  const csvPath = writeCsv(`${KEY}-${APPLY ? 'apply-' : ''}${fileStamp()}.csv`, plan.csv);
  ok(`CSV (contains PII — stays in exports/, never commit): ${csvPath}`);

  if (!APPLY) {
    const counts = { cases: plan.counts.cases, link: plan.counts.link, manual: plan.counts.manual, followed: plan.counts.followed };
    const drift = checkDrift(counts, expected);
    printTable(drift.rows);
    if (!drift.pass) die(`Counts drifted — NO run recorded. Read the CSV; if understood, re-run with --expect ${expectString(counts, Object.keys(expected))}`);
    const { id, hash } = await recordDryRun({ key: KEY, lines: plan.lines, summary: {
      script: 'repair-teleshop-twin-links.mjs', expected, counts: plan.counts, trash_falls_permanent: trashCount.permanent,
      trash_released: trash.released.length, csv: csvPath.split(/[\\/]/).pop() } });
    console.log(bold(`\nDry run recorded: ${green(id)}`) + `  (hash ${hash.slice(0, 12)}…)`);
    console.log(`  node scripts/repair-teleshop-twin-links.mjs --apply --run ${id}\n`);
    return;
  }

  const actor = await resolveActor(args.actor || 'mile@elyon.com');
  ok(`recorded as ${actor.email}`);
  const { done } = await verifyRunForApply({ key: KEY, runId: args.run, lines: plan.lines });
  const units = plan.units.filter((u) => !u.rows.some((r) => done.has(r.order_id)));
  const typeMap = await loadOrderColumnTypes();
  console.log(bold(`\nApplying ${units.length} links`));
  const stats = await applyUnits({ key: KEY, runId: args.run, units, typeMap });
  const payload = { script: 'repair-teleshop-twin-links.mjs', counts: plan.counts, applied_orders: stats.applied, links: stats.links,
    skipped_moved: stats.skipped, chunks: `${stats.committed}/${stats.chunks}`, outside_quiet_window: !!args['outside-quiet-window'] };
  if (stats.failed) {
    await auditPartial({ key: KEY, runId: args.run, actor, payload: { ...payload, failed: stats.failed } });
    die(`Stopped at chunk ${stats.failed.chunk}; committed chunks are in the ledger — fix the cause and re-run the same --apply.`);
  }
  await finalizeRun({ key: KEY, runId: args.run, actor, payload });
  ok(`run ${args.run} applied — ${stats.applied} orders, ${stats.links} parcel links`);

  const [v] = await sqlRead(`select
      (select count(*) from public.data_repair_rows where run_id = ${qUuid(args.run)} and after is not null)::int as ledger_rows,
      (select count(*) from public.data_repair_rows r join public.orders o on o.id = r.order_id join public.mex_parcels p on p.order_id = o.id
        where r.run_id = ${qUuid(args.run)})::int as linked_now,
      (select count(*) from public.data_repair_rows r join public.orders o on o.id = r.order_id
        where r.run_id = ${qUuid(args.run)} and ((o.status = 'paid' and o.mex_status_id <> 2) or (o.status = 'returned' and o.mex_status_id <> 7)))::int as status_disagrees`);
  printTable([v]);
  if (v.status_disagrees) warn('some linked orders disagree with their parcel — investigate.');
  console.log(yellow('  Next: node scripts/repair-cod-price.mjs (dry run) — the twins whose COD differs from their price.\n'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => die(e.stack || e.message || String(e)));
}
