#!/usr/bin/env node
/**
 * scripts/repair-history-cancels.mjs — paid (or shipped) in the CRM with NO proof of a shipment: the owner's cancel rules
 * for the history up to 01.08.2026 (hand-over of 03.10.2026 §4; owner 03.10 night: "зошто чекаат моја одлука?").
 *
 * The history audit proves every order by MEX, by collabBox, or by both. What is left with neither:
 *   no_proof_cancel        SET_CANCELLED — paid, no MEX parcel, no collabBox document, nothing on the phone within
 *                          ±45 days (all AlterCPA "paid") → cancelled. Owner: "платена + нема MEX + нема collabBox =
 *                          откажана".
 *   duplicate_cancel       SET_CANCELLED_DUPLICATE with no document of its own — the parcel in its window belongs to
 *                          another order of the customer created ≤ 3 days away → cancelled as its duplicate
 *                          (cancellation_reason duplicate_order, the CRM's way to mark a duplicate lead).
 *   no_proof_cancel_twin   the same, but the order that holds the parcel is more than 3 days away → not a duplicate
 *                          entry, still no proof of its own → cancelled like no_proof_cancel.
 *   label_only_cancel      SET_CANCELLED_LABEL_ONLY — the parcel never left MEX status 8 (a label MEX never picked
 *                          up, checked months later) → cancelled.
 *   never_shipped_cancel   (--input doc-no-parcel, 04.10.2026) paid, a collabBox document, NO MEX parcel under its
 *                          number in a month MEX carried ≥ 90 % of the folder, and collabBox itself holds no courier
 *                          flag for it (or only "Shipment created") while the other documents of that day have theirs
 *                          → booked, never shipped → cancelled. The hand-over's question 4; decided by the flags
 *                          (scripts/history/doc_no_parcel_build.py). A delivered / returned flag goes through
 *                          repair-courier-outcomes.mjs --input doc-no-parcel instead.
 * and, because a "duplicate" that has a document of its own which ANOTHER courier carried is a sale of its own
 * (two documents, two parcels), judged by collabBox's courier flag exactly like scripts/repair-courier-outcomes.mjs:
 *   dup_own_doc_proven     Delivered → stays paid, paid_basis operator_ruling
 *   dup_own_doc_returned   Return to sender → returned
 *
 * Every cancel is a SYSTEM cancel (no person), dated on the order's OWN day (confirmed_at, else created_at) so that no
 * customer enters the 14-day Current Cancels pen today; paid_at / paid_basis are cleared; sold_* stay (the order shows
 * as "откажана по продажба", apart from the totals). Never touched, listed with the reason: a status that moved, an
 * order that now holds a parcel (other than its own label), a NAME match (an unclaimed parcel / document with the
 * customer's first + last name in the window — probably the sale under another phone), a parcel MEX delivered later
 * that no order owns, a document whose flag was not read yet, an order in an agent payout.
 *
 *   node scripts/repair-history-cancels.mjs                                # dry run → CSV + a data_repair_runs id
 *   node scripts/repair-history-cancels.mjs --apply --run <id> [--actor mile@elyon.com] [--chunk 200]
 *   undo:  node scripts/rollback-repair.mjs --run <id> [--apply]
 * Input: python scripts/history/history_cancels_build.py. Repair kit with elyon.defer_segments; afterwards the queue
 * drain, recompute_all_segments, insights_profit_refresh per cached month. 🛑 Macedonia only; quiet window.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  ROOT, MKD_PER_EUR, DAY_MS, bold, green, yellow, die, ok,
  mkGuard, sqlRead, assertRemoteIsMk, requireRepairSchema, requireKeepUpdatedAt, requireQuietWindow,
  requireNoSegmentRecompute, loadOrderColumnTypes, loadPayoutOrderIds, loadPhoneOrders, resolveActor,
  qUuidArray, qTextArray, parseArgs, fileStamp, writeCsv, planLine, recordDryRun, verifyRunForApply,
  buildChunkSql, applyChunked, finalizeRun, auditPartial, stickyTrashEffects, printTrashFalls, fmtMkd, printTable,
} from './lib/repair-kit.mjs';
import { parseCsv, skopjeWallToIso, BASIS } from './repair-courier-outcomes.mjs';

export const KEY = 'history-cancels';
const INPUT = join(ROOT, 'exports', 'repairs', 'history-cancels', 'input.csv');
const AUDIT = 'Историска ревизија 03.10.2026';
export const DUPLICATE_DAYS = 3;
const PROVEN = new Set(['mex', 'operator_ruling', 'legacy_import']);

const cancelSet = (o, reason, note, extra = {}) => ({
  status: 'cancelled', cancelled_at: o.confirmed_at || o.created_at, cancellation_reason: reason,
  cancellation_reason_notes: note, paid_at: null, paid_basis: null, ...extra,
});

/**
 * Classify one input row. `twin` = the live order named in duplicate_of (or null), `reg` = the live register row of the
 * label parcel (or null).
 */
export function classify(r, o, { twin = null, reg = null, payout = new Set() } = {}) {
  if (!o) return { skip: 'order_gone' };
  if (o.status !== r.audit_status) return { skip: `moved_${r.audit_status}_to_${o.status}` };
  if (payout.has(o.id)) return { skip: 'in_agent_payout' };
  const v = r.audit_verdict;

  if (v === 'SET_CANCELLED') {
    if (o.mex_tracking_id) return { skip: 'holds_mex_parcel' };
    if (PROVEN.has(o.paid_basis)) return { skip: `has_basis_${o.paid_basis}` };
    if (r.rescue_kind) return { skip: `name_match_${r.rescue_kind}` };
    const note = `Нема MEX пратка и нема порачка во Collab (ни на телефонот, ни на името) — системско откажување. ${AUDIT}.`;
    return { rule: 'no_proof_cancel', target: 'cancelled', ref: '', set: cancelSet(o, 'other', note), history: { from: o.status, to: 'cancelled' }, note, evidence: { verdict: v } };
  }

  if (v === 'SET_CANCELLED_DUPLICATE') {
    if (o.mex_tracking_id) return { skip: 'holds_mex_parcel' };
    if (r.own_doc) {
      if (r.own_doc_flag === 'delivered') {
        if (o.paid_basis === BASIS || o.paid_basis === 'mex') return { skip: 'already_proven' };
        return {
          rule: 'dup_own_doc_proven', target: 'paid', ref: r.own_doc, set: { paid_basis: BASIS }, history: null,
          note: `collabBox ${r.own_doc}: доставена (Delivered) со друг курир — своја пратка, не е дупликат; платено, докажано. ${AUDIT}.`,
          evidence: { verdict: v, doc: r.own_doc, flag: r.own_doc_flag, basis_before: o.paid_basis ?? null },
        };
      }
      if (r.own_doc_flag === 'returned') {
        const at = skopjeWallToIso(r.own_doc_at);
        if (!at) return { skip: 'no_document_time' };
        return {
          rule: 'dup_own_doc_returned', target: 'returned', ref: r.own_doc,
          set: { status: 'returned', returned_at: at, paid_at: null, paid_basis: null }, history: { from: o.status, to: 'returned' },
          note: `collabBox ${r.own_doc}: вратена (Return to sender) со друг курир — статусот е поправен: платена → вратена. ${AUDIT}.`,
          evidence: { verdict: v, doc: r.own_doc, flag: r.own_doc_flag, basis_before: o.paid_basis ?? null },
        };
      }
      return { skip: 'own_document_no_flag' };
    }
    if (PROVEN.has(o.paid_basis)) return { skip: `has_basis_${o.paid_basis}` };
    if (!twin) return { skip: 'twin_order_gone' };
    const apart = Math.abs(Date.parse(twin.created_at) - Date.parse(o.created_at)) / DAY_MS;
    if (apart <= DUPLICATE_DAYS) {
      const note = `Дупликат на ${twin.display_id}, која ја држи пратката на клиентот — системско откажување. ${AUDIT}.`;
      return {
        rule: 'duplicate_cancel', target: 'cancelled', ref: twin.display_id, set: cancelSet(o, 'duplicate_order', note),
        history: { from: o.status, to: 'cancelled' }, note, evidence: { verdict: v, duplicate_of: twin.display_id, days_apart: Math.round(apart * 10) / 10 },
      };
    }
    const note = `Нема своја MEX пратка ни порачка во Collab — пратката на клиентот е на ${twin.display_id}; системско откажување. ${AUDIT}.`;
    return {
      rule: 'no_proof_cancel_twin', target: 'cancelled', ref: twin.display_id, set: cancelSet(o, 'other', note),
      history: { from: o.status, to: 'cancelled' }, note, evidence: { verdict: v, parcel_on: twin.display_id, days_apart: Math.round(apart * 10) / 10 },
    };
  }

  if (v === 'DOC_NEVER_SHIPPED') {
    if (o.mex_tracking_id) return { skip: 'holds_mex_parcel' };
    if (o.paid_basis === 'mex' || o.paid_basis === BASIS) return { skip: `has_basis_${o.paid_basis}` };
    const what = r.doc_trace === 'label only' ? 'само етикета (Shipment created), MEX не ја подигна' : 'нема MEX пратка и нема статус од курир';
    const note = `collabBox ${r.own_doc}: книжена, никогаш испратена — ${what}; системско откажување. ${AUDIT}.`;
    return {
      rule: 'never_shipped_cancel', target: 'cancelled', ref: r.own_doc, set: cancelSet(o, 'other', note), history: { from: o.status, to: 'cancelled' }, note,
      evidence: { verdict: 'REVIEW_DOC_NO_PARCEL_MEX_PERIOD', doc: r.own_doc, trace: r.doc_trace, basis_before: o.paid_basis ?? null },
    };
  }

  if (v === 'SET_CANCELLED_LABEL_ONLY') {
    if (r.rescue_kind) return { skip: 'delivered_later' };
    if (r.mex_status !== 'Shipment created') return { skip: 'not_a_label' };
    if (o.mex_tracking_id && o.mex_tracking_id !== r.tracking) return { skip: 'holds_another_parcel' };
    if (reg && reg.order_id && reg.order_id !== o.id) return { skip: 'parcel_held_by_another_order' };
    if (reg && Number(reg.status_id) !== 8) return { skip: `register_status_${reg.status_id}` };
    const note = `MEX ${r.tracking}: само етикета (Shipment created) — MEX никогаш не ја подигна пратката; системско откажување. ${AUDIT}.`;
    return {
      rule: 'label_only_cancel', target: 'cancelled', ref: r.tracking, expectTracking: o.mex_tracking_id || null,
      set: cancelSet(o, 'other', note, { shipped_at: null }), history: { from: o.status, to: 'cancelled' }, note,
      evidence: { verdict: v, tracking: r.tracking, mex_status: r.mex_status, mex_created: r.mex_created, match: r.match, held: !!o.mex_tracking_id },
    };
  }
  return { skip: `verdict_${v}` };
}

async function loadOrders(ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 2000) {
    const rows = await sqlRead(`select id, display_id, status::text as status, mex_tracking_id, paid_basis, price, customer_phone,
        created_at, confirmed_at, sold_at
      from public.orders where id = any(${qUuidArray(ids.slice(i, i + 2000))})`);
    for (const r of rows) out.set(r.id, r);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { flags: ['apply', 'outside-quiet-window'], values: ['run', 'actor', 'chunk', 'input'] });
  mkGuard();
  await assertRemoteIsMk();
  await requireRepairSchema({ forApply: !!args.apply, needReason: 'duplicate_order' });
  await requireKeepUpdatedAt({ forApply: !!args.apply });
  if (args.input && args.input !== 'doc-no-parcel') die('--input: only doc-no-parcel is known');
  const NEVER = join(ROOT, 'exports', 'repairs', 'doc-no-parcel', 'never-shipped.csv');
  const path = args.input ? NEVER : INPUT;
  if (!existsSync(path)) die(`input not found: ${path} — run: python scripts/history/${args.input ? 'doc_no_parcel_build.py' : 'history_cancels_build.py'}`);
  const input = parseCsv(readFileSync(path, 'utf8')).map((r) => (args.input ? {
    ...r, audit_verdict: 'DOC_NEVER_SHIPPED', own_doc: r.doc, doc_trace: r.trace, tracking: '', duplicate_of: '', own_doc_flag: '', rescue_kind: '',
  } : r));
  const ids = [...new Set(input.map((r) => r.order_id))];
  if (ids.length !== input.length) die('the input names an order twice — rebuild it.');
  ok(`input: ${input.length.toLocaleString('de-DE')} orders (no proof / duplicate / label only)`);

  const orders = await loadOrders(ids);
  const twinIds = [...new Set(input.map((r) => r.duplicate_of).filter(Boolean))];
  const twins = new Map();
  for (let i = 0; i < twinIds.length; i += 2000) {
    for (const t of await sqlRead(`select id, display_id, status::text as status, created_at, mex_tracking_id from public.orders
      where display_id = any(${qTextArray(twinIds.slice(i, i + 2000))})`)) twins.set(t.display_id, t);
  }
  const trackings = [...new Set(input.map((r) => r.tracking).filter(Boolean))];
  const register = new Map();
  for (let i = 0; i < trackings.length; i += 2000) {
    for (const p of await sqlRead(`select tracking_id, order_id, status_id from public.mex_parcels where tracking_id = any(${qTextArray(trackings.slice(i, i + 2000))})`)) register.set(p.tracking_id, p);
  }
  const payout = await loadPayoutOrderIds(ids);

  const plan = [], csv = [], why = {};
  for (const r of input) {
    const o = orders.get(r.order_id);
    const c = classify(r, o, { twin: twins.get(r.duplicate_of) || null, reg: register.get(r.tracking) || null, payout });
    const base = {
      order_id: r.order_id, display_id: o?.display_id ?? r.display_id, order_day: r.order_day, verdict: r.audit_verdict, status_now: o?.status ?? '',
      paid_basis_now: o?.paid_basis ?? '', dept: r.dept, tracking: r.tracking, duplicate_of: r.duplicate_of, own_doc: r.own_doc, own_doc_flag: r.own_doc_flag,
      rescue: r.rescue_kind ? `${r.rescue_kind} ${r.rescue_ref} (${r.rescue_state})` : '', price_eur: o?.price ?? r.price_eur,
      value_mkd: Math.round(Number(o?.price ?? 0) * MKD_PER_EUR),
    };
    if (c.skip) { why[c.skip] = (why[c.skip] || 0) + 1; csv.push({ ...base, action: 'skip', rule: '', reason: c.skip }); continue; }
    plan.push({
      unit: r.order_id, order_id: r.order_id, rule: c.rule, line: planLine(r.order_id, c.rule, c.target, c.ref),
      expect_status: o.status, expect_tracking: c.expectTracking ?? null, set: c.set, link: null, unlink: null,
      history: c.history, note: c.note, evidence: c.evidence, _o: o, _r: r,
    });
    csv.push({ ...base, action: 'apply', rule: c.rule, reason: '' });
  }

  const by = {}, byMonth = {};
  for (const p of plan) {
    by[p.rule] ??= { orders: 0, eur: 0 };
    by[p.rule].orders++; by[p.rule].eur += Number(p._o.price || 0);
    if (p.set.status === 'cancelled') { const m = p._r.order_day.slice(0, 7); byMonth[m] ??= { orders: 0, eur: 0 }; byMonth[m].orders++; byMonth[m].eur += Number(p._o.price || 0); }
  }
  console.log(bold('\nPlan:'));
  printTable(Object.entries(by).map(([rule, b]) => ({ rule, orders: b.orders, eur: Math.round(b.eur), 'ден': fmtMkd(b.eur * MKD_PER_EUR) })));
  console.log(bold('Cancels by the order\'s month:'));
  console.log('  ' + Object.entries(byMonth).sort().map(([m, b]) => `${m}: ${b.orders}`).join(' · '));
  console.log(bold('Left alone:'));
  printTable(Object.entries(why).sort((a, b) => b[1] - a[1]).map(([reason, n]) => ({ reason, orders: n })));

  const moving = plan.filter((p) => p.set.status);
  const phoneOrders = await loadPhoneOrders(moving.map((p) => p._o.customer_phone));
  const trash = stickyTrashEffects(phoneOrders, new Map(moving.map((p) => [p.order_id, { status: p.set.status }])));
  const falls = printTrashFalls(trash);

  const lines = plan.map((p) => p.line);
  const summary = {
    input: input.length, planned: plan.length, skipped: input.length - plan.length,
    rules: Object.fromEntries(Object.entries(by).map(([k, b]) => [k, { orders: b.orders, eur: Math.round(b.eur) }])),
    left_alone: why, trash: { permanent: falls.permanent, parked: falls.parked },
    ...(args.input ? { options: { input: args.input } } : {}),
  };
  if (!args.apply) {
    const file = writeCsv(`${KEY}-${fileStamp()}.csv`, csv);
    const run = await recordDryRun({ key: KEY, lines, summary });
    console.log(`\n${green('DRY RUN')} — nothing was written to orders.\n  CSV: ${file}\n  run: ${bold(run.id)}  (hash ${run.hash.slice(0, 12)}…)`);
    console.log(`  apply: node scripts/repair-history-cancels.mjs --apply --run ${run.id}${args.input ? ` --input ${args.input}` : ''}`);
    return;
  }

  const { done } = await verifyRunForApply({ key: KEY, runId: args.run, lines, options: args.input ? { input: args.input } : null });
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
  console.log(`  undo: node scripts/rollback-repair.mjs --run ${args.run} --apply`);
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/repair-history-cancels.mjs')) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
