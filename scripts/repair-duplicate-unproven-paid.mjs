/**
 * Repair — cancel the DUPLICATE leads among the "paid without MEX proof" orders (verify-attribution C7) as duplicates
 * of the sibling that holds the customer's parcel (owner, Mile, 01.10.2026). No shebang (repair-kit convention: the
 * test suite imports this file). Run with `node`.
 *
 * OWNER (01.10.2026): of the C7 orders, cancel ONLY the duplicates — a lead whose customer's parcel sits on a SIBLING
 * lead created ≤ 3 days apart (the sibling already holds the real sale). The ones whose parcel sits on an order more
 * than 3 days apart stay as they are; the ones with a parcel found are repair-altercpa-catchup-paid.mjs's job.
 *
 * The rule and the marking are in scripts/lib/duplicate-unproven-paid.mjs (pure, tested in
 * src/lib/duplicateUnprovenPaid.test.ts): the C7 population is verify-attribution's own SQL (c7PopulationSql); the
 * sibling = another order on the same last-8 phone created within ±72 h that holds a MEX parcel (a BIO NATURAL one —
 * else listed). The order is cancelled the way the CRM marks a duplicate lead — reason 'duplicate_order', notes
 * "duplicate of ORD-… which holds the parcel … (owner 01.10.2026)" — by the SYSTEM (no person, no person-note gate),
 * dated on the lead's own day, paid_at / paid_basis cleared; order_history paid → cancelled + one note; the repair
 * ledger before / after (repair-kit applyUnits). sold_* and the AlterCPA ledger are never touched; nothing is pushed
 * to AlterCPA. NOT status 'duplicated' (that is the re-issue COPY of POST /orders/:id/duplicate in this CRM).
 *
 * What it does elsewhere (printed by the dry run): the cohort / TV board stop counting the lead as a sale of its day
 * (paid_unproven / paid_legacy → cancelled_after_sale — the sibling's parcel already counts the sale, so a double
 * count goes away); sticky Trash: a cancel is no trash, but taking a "paid" away can put a customer back (pre-check);
 * Current Cancels (14 d) entries; the AlterCPA guarantee: `counted` reads the AlterCPA decision (unchanged), the old
 * `crm_sticky` metric reads "ever confirmed / paid" in order_history (unchanged where that row exists — counted).
 *
 *   node scripts/repair-duplicate-unproven-paid.mjs [--expect c7=69,duplicate=20]
 *        dry run → CSV in exports/repairs (PII) + a data_repair_runs dry-run row + the run id
 *   node scripts/repair-duplicate-unproven-paid.mjs --apply --run <id> [--actor mile@elyon.com] [--outside-quiet-window]
 *   undo: node scripts/rollback-repair.mjs --run <id> [--apply]
 *
 * 🛑 Macedonia only (repair-kit guards). Payout / bonus math untouched.
 */
import { pathToFileURL } from 'node:url';
import {
  MK_REF, bold, green, yellow, die, ok,
  mkGuard, sqlRead, assertRemoteIsMk, requireRepairSchema, requireKeepUpdatedAt, requireQuietWindow,
  requireNoSegmentRecompute, loadOrderColumnTypes, qUuid, parseArgs, parseExpect, checkDrift, expectString,
  fileStamp, writeCsv, loadPhoneOrders, stickyTrashEffects, printTrashFalls, resolveActor, recordDryRun,
  verifyRunForApply, applyUnits, finalizeRun, auditPartial, printTable, tally, fmtMkd,
} from './lib/repair-kit.mjs';
import { KEY, EXPECTED, SIBLING_HOURS, classifyDuplicates, currentCancelsEffect, byMonth } from './lib/duplicate-unproven-paid.mjs';
import { c7PopulationSql } from './verify-attribution.mjs';

const P8 = (col) => `right(regexp_replace(${col}, '[^0-9]', '', 'g'), 8)`;

/** The C7 orders with everything the rule and the report read — ONE read-only SELECT. */
export const candidatesSql = () => `WITH c7 AS (${c7PopulationSql()}),
x AS (
  SELECT o.id, o.display_id, o.status::text AS status, o.created_at, o.confirmed_at, o.sold_at, o.price, o.paid_basis,
         o.source_type, o.sale_source, o.sale_source_detail, o.customer_phone, o.mex_tracking_id, ${P8('o.customer_phone')} AS p8,
         (SELECT count(*) FROM public.mex_parcels m WHERE m.order_id = o.id)::int AS held,
         (SELECT max(l.decided_at) FROM public.altercpa_leads l
           WHERE l.order_id = o.id AND l.decision IN ('approved', 'cancel_other') AND l.decided_at IS NOT NULL) AS decided_at,
         EXISTS (SELECT 1 FROM public.agent_payout_items a WHERE a.order_id = o.id) AS in_payout,
         EXISTS (SELECT 1 FROM public.affiliate_leads a WHERE a.order_id = o.id) AS affiliate,
         EXISTS (SELECT 1 FROM public.altercpa_leads l WHERE l.order_id = o.id) AS has_lead,
         EXISTS (SELECT 1 FROM public.order_history h WHERE h.order_id = o.id
                    AND h.to_status IN ('confirmed', 'shipped', 'delivered', 'paid', 'returned')) AS ever_sold_in_history,
         (SELECT h.changed_by_name FROM public.order_history h WHERE h.order_id = o.id AND h.to_status = 'paid'
           ORDER BY h.changed_at DESC LIMIT 1) AS paid_by
    FROM public.orders o JOIN c7 ON c7.id = o.id
)
SELECT x.*,
       (SELECT jsonb_agg(jsonb_build_object('id', s.id, 'display_id', s.display_id, 'status', s.status::text,
                                            'sale_source', s.sale_source, 'created_at', s.created_at,
                                            'tracking', coalesce(pp.tracking_id, s.mex_tracking_id), 'series', pp.series,
                                            'account', pp.account, 'status_id', pp.status_id) ORDER BY s.created_at, s.display_id)
          FROM public.orders s
          LEFT JOIN LATERAL (SELECT m.tracking_id, m.series, m.account, m.status_id FROM public.mex_parcels m
                              WHERE m.tracking_id = s.mex_tracking_id OR m.order_id = s.id
                              ORDER BY (m.tracking_id = s.mex_tracking_id) DESC NULLS LAST, m.created_at_mex DESC LIMIT 1) pp ON true
         WHERE s.id <> x.id AND ${P8('s.customer_phone')} = x.p8
           AND s.created_at BETWEEN x.created_at - interval '${SIBLING_HOURS} hours' AND x.created_at + interval '${SIBLING_HOURS} hours'
           AND (s.mex_tracking_id IS NOT NULL OR pp.tracking_id IS NOT NULL)) AS siblings
  FROM x
 ORDER BY x.created_at, x.display_id`;

/** Report only: holders the rule does NOT see — through the PARCEL's phone (≤ 72 h), or an order-phone sibling 72–96 h. */
export const nearMissSql = () => `WITH c7 AS (${c7PopulationSql()}),
x AS (SELECT o.id, o.display_id, o.created_at, ${P8('o.customer_phone')} AS p8 FROM public.orders o JOIN c7 ON c7.id = o.id)
SELECT x.display_id, h.display_id AS holder, p.tracking_id,
       round((abs(extract(epoch FROM h.created_at - x.created_at)) / 3600.0)::numeric, 1) AS hours,
       CASE WHEN ${P8('h.customer_phone')} = x.p8 THEN 'order phone, 72–96 h' ELSE 'parcel phone only' END AS why
  FROM x
  JOIN public.mex_parcels p ON p.phone8 = x.p8 AND p.order_id IS NOT NULL AND p.order_id <> x.id
  JOIN public.orders h ON h.id = p.order_id
 WHERE (${P8('h.customer_phone')} <> x.p8 AND abs(extract(epoch FROM h.created_at - x.created_at)) <= ${SIBLING_HOURS} * 3600)
    OR (${P8('h.customer_phone')} = x.p8 AND abs(extract(epoch FROM h.created_at - x.created_at)) > ${SIBLING_HOURS} * 3600
        AND abs(extract(epoch FROM h.created_at - x.created_at)) <= 96 * 3600)
 ORDER BY x.display_id, hours`;

const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

async function main() {
  const args = parseArgs(process.argv.slice(2), { flags: ['apply', 'outside-quiet-window', 'help'], values: ['run', 'expect', 'actor'] });
  if (args.help) { console.log('usage: node scripts/repair-duplicate-unproven-paid.mjs [--expect c7=69,duplicate=20] | --apply --run <id> [--actor <email>] [--outside-quiet-window]'); return; }
  mkGuard();
  const APPLY = !!args.apply;
  console.log(bold(`\nRepair — ${KEY} — ${APPLY ? 'APPLY' : 'DRY RUN'}  (${MK_REF})\n`));
  if (APPLY && !args.run) die('--apply needs --run <id> (printed by the dry run).');
  await assertRemoteIsMk();
  await requireRepairSchema({ forApply: APPLY, needReason: 'duplicate_order' });
  await requireKeepUpdatedAt({ forApply: APPLY });
  if (APPLY) { requireQuietWindow({ override: !!args['outside-quiet-window'] }); await requireNoSegmentRecompute('start the apply'); }

  const rows = (await sqlRead(candidatesSql())).map((r) => ({ ...r, siblings: parse(r.siblings) ?? [] }));
  const plan = classifyDuplicates({ rows, runId: APPLY ? args.run : null });
  if (plan.units.some((u) => u.rows.some((r) => r.set?.status === 'confirmed'))) die('a row would be set to confirmed — refusing.');

  console.log(`  C7 now: ${plan.counts.c7} · duplicate → cancel ${plan.counts.duplicate} · listed ${plan.counts.manual} · no sibling within ${SIBLING_HOURS} h ${plan.counts.no_sibling} (left as they are)`);
  printTable(byMonth(plan.csv));
  for (const r of plan.csv.filter((x) => x.action === 'manual')) console.log(yellow(`    listed ${r.order}: ${r.why}`));
  const cancels = plan.csv.filter((r) => r.action === 'cancel');
  const ids = new Set(plan.units.map((u) => u.rows[0].order_id));
  const mine = rows.filter((r) => ids.has(r.id));
  printTable(Object.entries(tally(cancels, (r) => r.cohort, (r) => r.value_mkd)).map(([k, v]) => ({ 'cohort bucket': k, orders: v.orders, 'value (ден)': fmtMkd(v.mkd) })));
  console.log(`  TV board / cohort: ${cancels.filter((r) => r.seller_stamp === 'yes').length} carry a seller stamp (kept, write-once) → shown as "cancelled after sale" on their sale day, not ranked`);
  const guarantee = { with_lead: mine.filter((r) => r.has_lead).length, crm_sticky_flips: mine.filter((r) => r.has_lead && !r.ever_sold_in_history).length };
  console.log(`  AlterCPA guarantee: ${guarantee.with_lead} have an AlterCPA ledger row — counted (decision) unchanged; old crm_sticky flips for ${guarantee.crm_sticky_flips} (no order_history row to a sale status)`);
  const phoneRows = await loadPhoneOrders(mine.map((r) => r.customer_phone));
  const trash = stickyTrashEffects(phoneRows, plan.changes);
  const trashCount = printTrashFalls(trash);
  const pen = currentCancelsEffect(phoneRows, plan.changes);
  console.log(`  customers entering Current Cancels (14 d): ${pen.length}${pen.length ? ` — ${pen.map((p) => p.orders.join('+')).join(', ')}` : ''}`);
  const cancelled = new Set(cancels.map((r) => r.order));
  const near = (await sqlRead(nearMissSql())).filter((n) => !cancelled.has(n.display_id));
  if (near.length) {
    console.log(yellow(`  near misses (NOT cancelled — not the rule; for the owner): ${near.length}`));
    for (const n of near) console.log(yellow(`    ${n.display_id} ↔ ${n.holder} (${n.tracking_id}, ${n.hours} h): ${n.why}`));
  }
  const csvPath = writeCsv(`${KEY}-${APPLY ? 'apply-' : ''}${fileStamp()}.csv`, [...plan.csv,
    ...near.map((n) => ({ order: n.display_id, sibling: n.holder, sibling_parcel: n.tracking_id, hours_apart: n.hours, action: 'near_miss', why: n.why }))]);
  ok(`CSV (contains PII — stays in exports/, never commit): ${csvPath}`);

  if (!APPLY) {
    const expected = parseExpect(args.expect, EXPECTED);
    const counts = { c7: plan.counts.c7, duplicate: plan.counts.duplicate };
    const drift = checkDrift(counts, expected);
    printTable(drift.rows);
    if (!drift.pass) die(`Counts drifted — NO run recorded. If understood, re-run with --expect ${expectString(counts, Object.keys(expected))}`);
    const { id, hash } = await recordDryRun({ key: KEY, lines: plan.lines, summary: {
      script: 'repair-duplicate-unproven-paid.mjs', source: 'verify-attribution C7 (c7PopulationSql)', owner_approved: '2026-10-01',
      expected, counts: plan.counts, guarantee, trash_falls_permanent: trashCount.permanent, trash_released: trash.released.length,
      current_cancels: pen.length, near_misses: near.length, by_month: byMonth(plan.csv), csv: csvPath.split(/[\\/]/).pop() } });
    console.log(bold(`\nDry run recorded: ${green(id)}`) + `  (hash ${hash.slice(0, 12)}…)\n` +
      `  node scripts/repair-duplicate-unproven-paid.mjs --apply --run ${id}\n  undo: node scripts/rollback-repair.mjs --run ${id}\n`);
    return;
  }
  const actor = await resolveActor(args.actor || 'mile@elyon.com');
  const { done } = await verifyRunForApply({ key: KEY, runId: args.run, lines: plan.lines });
  const units = plan.units.filter((u) => !u.rows.some((r) => done.has(r.order_id)));
  const typeMap = await loadOrderColumnTypes();
  const stats = await applyUnits({ key: KEY, runId: args.run, units, typeMap });
  const payload = { script: 'repair-duplicate-unproven-paid.mjs', counts: plan.counts, applied_orders: stats.applied,
    skipped_moved: stats.skipped, outside_quiet_window: !!args['outside-quiet-window'] };
  if (stats.failed) { await auditPartial({ key: KEY, runId: args.run, actor, payload: { ...payload, failed: stats.failed } }); die(`Stopped at chunk ${stats.failed.chunk}.`); }
  await finalizeRun({ key: KEY, runId: args.run, actor, payload });
  ok(`run ${args.run} applied — ${stats.applied} orders cancelled as duplicates${stats.skipped.length ? `, ${stats.skipped.length} left alone (moved since the dry run)` : ''}`);
  const [v] = await sqlRead(`select
      (select count(*) from public.data_repair_rows where run_id = ${qUuid(args.run)} and after is not null)::int as ledger_rows,
      (select count(*) from public.data_repair_rows r join public.orders o on o.id = r.order_id
        where r.run_id = ${qUuid(args.run)} and (o.status <> 'cancelled' or o.cancellation_reason is distinct from 'duplicate_order'))::int as not_marked,
      (select count(*) from public.data_repair_rows r join public.orders s on s.id = (r.evidence->>'sibling_id')::uuid
        where r.run_id = ${qUuid(args.run)} and s.mex_tracking_id is distinct from r.evidence->>'tracking'
          and not exists (select 1 from public.mex_parcels m where m.order_id = s.id and m.tracking_id = r.evidence->>'tracking'))::int as sibling_lost_parcel`);
  printTable([v]);
  console.log(yellow(`  Next: node scripts/verify-attribution.mjs (C7 drops by ${stats.applied}) · node scripts/engine-fixture-mk.mjs\n` +
    `  Undo: node scripts/rollback-repair.mjs --run ${args.run}\n`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => die(e.stack || e.message || String(e)));
}
