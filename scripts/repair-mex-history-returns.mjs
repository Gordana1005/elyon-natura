#!/usr/bin/env node
/**
 * scripts/repair-mex-history-returns.mjs — orders the CRM calls PAID while MEX's own final status is "Return to sender".
 *
 * The history audit of 03.10.2026 compared every CRM order with the whole MEX register (453.204 parcels since
 * 18.03.2020). 22.074 paid orders have a parcel MEX returned: 20.415 by the exact number (the order was imported from
 * the collabBox document whose number IS the MEX tracking id), 1.659 by the customer's phone + date. Most are the
 * teleshop history import — written as paid by default; the CRM's live parcel register only starts on 10.11.2025, so
 * nothing ever corrected them. Owner law: MEX alone decides paid / returned, MEX status beats CRM status.
 *
 * The input is built read-only by scripts/history/mex_history_returns_build.py. This script re-validates every row
 * against the live database and plans:
 *   mex_returned_number   paid, the parcel number is the order's own document      → returned
 *   mex_returned_phone    paid, the parcel is the one on the customer's phone      → returned
 *   held_returned         paid, the order already HOLDS the parcel (register 7)    → returned
 * returned_at = MEX's last update of the parcel. Never touched, listed with the reason: a status that moved since the
 * audit, an order that holds ANOTHER parcel, a parcel the live register knows but no order holds (the linker's job —
 * a flip without the link would count the return twice) or another order holds, a RE-SEND MEX delivered afterwards
 * that no order owns (the customer paid in the end), an order in an agent payout.
 *
 *   node scripts/repair-mex-history-returns.mjs                                # dry run → CSV + a data_repair_runs id
 *   node scripts/repair-mex-history-returns.mjs --apply --run <id> [--actor mile@elyon.com] [--chunk 200]
 *   undo:  node scripts/rollback-repair.mjs --run <id> [--apply]
 *
 * Repair kit: ≤ 200 orders per transaction, elyon.bulk_repair + keep_updated_at + defer_segments, ledger before/after,
 * order_history, one order_notes row per order. Afterwards: select public.segment_recompute_drain(50000);
 * select public.recompute_all_segments(); and insights_profit_refresh per cached month. 🛑 Macedonia only; quiet window.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  ROOT, MKD_PER_EUR, bold, green, yellow, die, ok,
  mkGuard, sqlRead, assertRemoteIsMk, requireRepairSchema, requireKeepUpdatedAt, requireQuietWindow,
  requireNoSegmentRecompute, loadOrderColumnTypes, loadPayoutOrderIds, loadPhoneOrders, resolveActor,
  qUuidArray, qTextArray, parseArgs, fileStamp, writeCsv, planLine, recordDryRun, verifyRunForApply,
  buildChunkSql, applyChunked, finalizeRun, auditPartial, stickyTrashEffects, printTrashFalls, fmtMkd, printTable,
} from './lib/repair-kit.mjs';
import { parseCsv, skopjeWallToIso } from './repair-courier-outcomes.mjs';

export const KEY = 'mex-history-returns';
const INPUT = join(ROOT, 'exports', 'repairs', 'mex-history-returns', 'input.csv');
const AUDIT = 'Историска ревизија 03.10.2026';

/** Classify one input row against the live order and the live register row of its parcel (or none). */
export function classify(r, o, reg, payout) {
  if (!o) return { skip: 'order_gone' };
  if (r.audit_verdict !== 'SET_RETURNED' || r.mex_status !== 'Return to sender') return { skip: 'not_a_mex_return' };
  if (o.status !== 'paid') return { skip: `moved_paid_to_${o.status}` };
  if (o.mex_tracking_id && o.mex_tracking_id !== r.tracking) return { skip: 'holds_another_parcel' };
  if (reg && reg.order_id && reg.order_id !== o.id) return { skip: 'parcel_held_by_another_order' };
  if (reg && !reg.order_id) return { skip: 'parcel_in_register_unlinked' };
  if (!reg && o.mex_tracking_id) return { skip: 'held_parcel_not_in_register' };
  if (reg && Number(reg.status_id) !== 7) return { skip: `register_status_${reg.status_id}` };
  if (r.resend_tracking) return { skip: 'resend_delivered' };
  if (payout.has(o.id)) return { skip: 'in_agent_payout' };
  const at = skopjeWallToIso(r.mex_last_update) || skopjeWallToIso(r.mex_created);
  if (!at) return { skip: 'no_mex_time' };
  const held = !!o.mex_tracking_id;
  const rule = held ? 'held_returned' : r.match === 'number' ? 'mex_returned_number' : 'mex_returned_phone';
  return {
    rule, target: 'returned', expectTracking: held ? r.tracking : null,
    set: { status: 'returned', returned_at: at, paid_at: null, paid_basis: null },
    history: { from: 'paid', to: 'returned' },
    note: `MEX ${r.tracking} (${r.account}): вратена (Return to sender) — статусот е поправен: платена → вратена. ${AUDIT}.`,
    evidence: {
      tracking: r.tracking, account: r.account, series: r.series, mex_status: r.mex_status, match: r.match,
      mex_created: r.mex_created, mex_last_update: r.mex_last_update, cod_mkd: r.cod_mkd === '' ? null : Number(r.cod_mkd),
      basis_before: o.paid_basis ?? null,
    },
  };
}

async function loadOrders(ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 2000) {
    const rows = await sqlRead(`select id, display_id, status::text as status, mex_tracking_id, paid_basis, price, customer_phone, created_at
      from public.orders where id = any(${qUuidArray(ids.slice(i, i + 2000))})`);
    for (const r of rows) out.set(r.id, r);
  }
  return out;
}
async function loadRegister(trackings) {
  const out = new Map();
  for (let i = 0; i < trackings.length; i += 2000) {
    const rows = await sqlRead(`select tracking_id, order_id, status_id from public.mex_parcels
      where tracking_id = any(${qTextArray(trackings.slice(i, i + 2000))})`);
    for (const r of rows) out.set(r.tracking_id, r);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { flags: ['apply', 'outside-quiet-window'], values: ['run', 'actor', 'chunk'] });
  mkGuard();
  await assertRemoteIsMk();
  await requireRepairSchema({ forApply: !!args.apply });
  await requireKeepUpdatedAt({ forApply: !!args.apply });
  if (!existsSync(INPUT)) die(`input not found: ${INPUT} — run: python scripts/history/mex_history_returns_build.py`);
  const input = parseCsv(readFileSync(INPUT, 'utf8'));
  const ids = [...new Set(input.map((r) => r.order_id))];
  if (ids.length !== input.length) die('the input names an order twice — rebuild it.');
  if (new Set(input.map((r) => r.tracking)).size !== input.length) die('the input names a parcel twice — rebuild it.');
  ok(`input: ${input.length.toLocaleString('de-DE')} paid orders whose parcel MEX returned`);

  const orders = await loadOrders(ids);
  const register = await loadRegister(input.map((r) => r.tracking));
  const payout = await loadPayoutOrderIds(ids);

  const plan = [], csv = [], why = {};
  for (const r of input) {
    const o = orders.get(r.order_id);
    const c = classify(r, o, register.get(r.tracking) || null, payout);
    const base = {
      order_id: r.order_id, display_id: o?.display_id ?? r.display_id, order_day: r.order_day, status_now: o?.status ?? '',
      paid_basis_now: o?.paid_basis ?? '', dept: r.dept, tracking: r.tracking, account: r.account, match: r.match,
      mex_created: r.mex_created, mex_last_update: r.mex_last_update, cod_mkd: r.cod_mkd, resend_tracking: r.resend_tracking,
      price_eur: o?.price ?? r.price_eur, value_mkd: Math.round(Number(o?.price ?? 0) * MKD_PER_EUR),
    };
    if (c.skip) { why[c.skip] = (why[c.skip] || 0) + 1; csv.push({ ...base, action: 'skip', rule: '', reason: c.skip }); continue; }
    plan.push({
      unit: r.order_id, order_id: r.order_id, rule: c.rule, line: planLine(r.order_id, c.rule, c.target, r.tracking),
      expect_status: 'paid', expect_tracking: c.expectTracking, set: c.set, link: null, unlink: null,
      history: c.history, note: c.note, evidence: c.evidence, _o: o, _r: r,
    });
    csv.push({ ...base, action: 'apply', rule: c.rule, reason: '' });
  }

  const by = {}, byYear = {};
  for (const p of plan) {
    by[p.rule] ??= { orders: 0, eur: 0, mkd: 0, cod: 0 };
    by[p.rule].orders++; by[p.rule].eur += Number(p._o.price || 0); by[p.rule].mkd += Math.round(Number(p._o.price || 0) * MKD_PER_EUR);
    by[p.rule].cod += Number(p._r.cod_mkd || 0);
    const y = p._r.mex_created.slice(0, 4);
    byYear[y] ??= { orders: 0, eur: 0 }; byYear[y].orders++; byYear[y].eur += Number(p._o.price || 0);
  }
  console.log(bold('\nPlan (the CRM says paid, MEX says Return to sender):'));
  printTable(Object.entries(by).map(([rule, b]) => ({ rule, orders: b.orders, eur: Math.round(b.eur), 'CRM value ден': fmtMkd(b.mkd), 'MEX COD ден': fmtMkd(b.cod) })));
  printTable(Object.entries(byYear).sort().map(([year, b]) => ({ year, orders: b.orders, eur: Math.round(b.eur) })));
  console.log(bold('Left alone:'));
  printTable(Object.entries(why).sort((a, b) => b[1] - a[1]).map(([reason, n]) => ({ reason, orders: n })));
  const basis = {};
  for (const p of plan) basis[p._o.paid_basis ?? 'NULL'] = (basis[p._o.paid_basis ?? 'NULL'] || 0) + 1;
  console.log(`  paid_basis today: ${Object.entries(basis).map(([k, n]) => `${k} ×${n}`).join(', ')}`);

  const phoneOrders = await loadPhoneOrders(plan.map((p) => p._o.customer_phone));
  const trash = stickyTrashEffects(phoneOrders, new Map(plan.map((p) => [p.order_id, { status: 'returned' }])));
  const falls = printTrashFalls(trash);

  const lines = plan.map((p) => p.line);
  const summary = {
    input: input.length, planned: plan.length, skipped: input.length - plan.length,
    rules: Object.fromEntries(Object.entries(by).map(([k, b]) => [k, { orders: b.orders, eur: Math.round(b.eur) }])),
    left_alone: why, trash: { permanent: falls.permanent, parked: falls.parked },
  };
  if (!args.apply) {
    const file = writeCsv(`${KEY}-${fileStamp()}.csv`, csv);
    const run = await recordDryRun({ key: KEY, lines, summary });
    console.log(`\n${green('DRY RUN')} — nothing was written to orders.\n  CSV: ${file}\n  run: ${bold(run.id)}  (hash ${run.hash.slice(0, 12)}…)`);
    console.log(`  apply: node scripts/repair-mex-history-returns.mjs --apply --run ${run.id}`);
    return;
  }

  const { done } = await verifyRunForApply({ key: KEY, runId: args.run, lines });
  requireQuietWindow({ override: !!args['outside-quiet-window'] });
  await requireNoSegmentRecompute('start the apply');
  const actor = await resolveActor(args.actor || 'mile@elyon.com');
  const typeMap = await loadOrderColumnTypes();
  const todo = plan.filter((p) => !done.has(p.order_id)).map(({ _o, _r, ...row }) => row);
  console.log(bold(`\nApplying ${todo.length.toLocaleString('de-DE')} orders (run ${args.run}) …`));
  const stats = await applyChunked({
    items: todo, chunkSize: args.chunk, label: 'orders',
    build: (rows) => `set local elyon.defer_segments = 'on';\n${buildChunkSql({ key: KEY, runId: args.run, rows, typeMap })}`,
  });
  const payload = { planned: todo.length, applied: stats.applied, chunks: stats.committed, skipped: stats.skipped.length, failed: stats.failed, rules: summary.rules };
  if (stats.failed) {
    await auditPartial({ key: KEY, runId: args.run, actor, payload });
    die(`stopped at chunk ${stats.failed.chunk}: ${stats.failed.error}\n  Committed chunks are in the ledger — re-run the same command to resume.`);
  }
  await finalizeRun({ key: KEY, runId: args.run, actor, payload });
  ok(`applied ${stats.applied}/${todo.length} orders in ${stats.committed} transactions${stats.skipped.length ? yellow(` — ${stats.skipped.length} moved since the dry run, left alone`) : ''}`);
  console.log('  next: select public.segment_recompute_drain(50000); select public.recompute_all_segments(); the profit cache; the verify scripts.');
  console.log(`  undo: node scripts/rollback-repair.mjs --run ${args.run} --apply`);
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/repair-mex-history-returns.mjs')) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
