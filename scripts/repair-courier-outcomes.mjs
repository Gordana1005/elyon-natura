#!/usr/bin/env node
/**
 * scripts/repair-courier-outcomes.mjs — the delivery outcome of the parcels ANOTHER COURIER carried (owner, 03.10.2026).
 *
 * MEX did not carry everything: Kolporter Post took the teleshop parcels on 101 days of 22.01–27.11.2024, Eko Logistik
 * the LEADS parcels 09.10.2025–22.01.2026, Jon Express 12 days of May–June 2026. The CRM holds no parcel for those
 * orders, so "paid" was never proven and a cancelled lead that was in fact delivered was never a sale. collabBox itself
 * holds the outcome per document ("Delivered" / "Return to sender", scripts/collabbox-delivery-attrs.mjs — on 38.412
 * documents MEX carried, the flag equals MEX's final status in 98,4 %). The owner: "направи што е најпаметно … сакам
 * утре 100 % сигурна база".
 *
 * The input list is built read-only by scripts/history/courier_outcomes_build.py (order ↔ document from the history
 * audit, the flag, the courier of that day, and a re-send check). This script re-validates every row against the live
 * database and plans, per order with NO MEX parcel:
 *   proven         paid + Delivered                → stays paid, paid_basis = 'operator_ruling' (the owner's ruling:
 *                                                    the collabBox courier flag is the proof for these couriers)
 *   paid_returned  paid + Return to sender         → returned (returned_at = the document's dispatch time)
 *   dead_paid      cancelled / trashed + Delivered → paid (a missed sale; paid_at = the dispatch time)
 *   dead_returned  cancelled / trashed + Returned  → returned (it shipped and came back)
 * A returned document whose RE-SEND (a later document of the same customer no order owns) was delivered counts as
 * delivered. Never touched, listed in the CSV with the reason: an order that holds a MEX parcel (MEX decides), a status
 * that moved since the audit, an audit verdict that says MEX has something for the order, a document with no flag, a
 * re-send still open, an order in an agent payout, and — for a dead order — a TWIN: a living sale on the same phone
 * (last 8 digits), −30 d … +10 d around the document, that owns no document and no parcel of its own (the document may
 * be that sale's); a living sale of the SAME PRICE within 3 days of the dead order (a double entry, whatever it owns);
 * an order cancelled / trashed AS A DUPLICATE; and a dead order whose own sale stamp is more than 14 days away from
 * the document (it would land as a sale on a day the parcel does not belong to).
 *
 * Prices are not changed (the order keeps its CRM price; the document amount is in the CSV). sold_at is not written:
 * the cohort dates a revived order on its AlterCPA decision / creation day, as for every other revival.
 *
 *   node scripts/repair-courier-outcomes.mjs                                  # dry run → CSV + a data_repair_runs id
 *   node scripts/repair-courier-outcomes.mjs --apply --run <id> [--actor mile@elyon.com] [--chunk 200]
 *   --input doc-no-parcel   the same rules for the documents of a MEX month that have NO MEX parcel under their number
 *                           (scripts/history/doc_no_parcel_build.py — collabBox's flag is the only courier record)
 *   undo:  node scripts/rollback-repair.mjs --run <id> [--apply]
 *
 * Writes go through the repair kit (≤ 200 orders per transaction, elyon.bulk_repair + keep_updated_at, ledger
 * before/after, order_history, one order_notes row per order) with elyon.defer_segments = 'on' — the lists are
 * recomputed once after the run (select public.recompute_all_segments()). 🛑 Macedonia only; quiet window.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  ROOT, MKD_PER_EUR, bold, green, yellow, die, warn, ok,
  mkGuard, sqlRead, assertRemoteIsMk, requireRepairSchema, requireKeepUpdatedAt, requireQuietWindow,
  requireNoSegmentRecompute, loadOrderColumnTypes, loadPayoutOrderIds, loadPhoneOrders, resolveActor, phone8,
  qUuidArray, qTextArray, parseArgs, fileStamp, writeCsv, planLine, recordDryRun, verifyRunForApply,
  buildChunkSql, applyChunked, finalizeRun, auditPartial, stickyTrashEffects, printTrashFalls, fmtMkd, printTable, DAY_MS,
} from './lib/repair-kit.mjs';

export const KEY = 'courier-outcomes';
const INPUT_ROOT = join(ROOT, 'exports', 'repairs');
/** The builder's folder under exports/repairs: courier-outcomes (other couriers' days) or doc-no-parcel (--input). */
const INPUT_NAMES = new Set(['courier-outcomes', 'doc-no-parcel', 'jon-express-late-sale']);
const AUDIT = 'Историска ревизија 03.10.2026';
/** The owner's ruling of 03.10.2026: the collabBox courier flag proves these parcels. */
export const BASIS = 'operator_ruling';
/** Audit verdicts with nothing from MEX for the order — the only ones this repair may judge. */
const VERDICTS = new Set(['PAID_UNVERIFIABLE_NON_MEX_PERIOD', 'REVIEW_DOC_NO_PARCEL_MEX_PERIOD', 'OK_DEAD']);
const LIVING = new Set(['paid', 'delivered', 'shipped', 'confirmed', 'returned']);
const DEAD = new Set(['cancelled', 'trashed']);
const TWIN_BEFORE_D = 30, TWIN_AFTER_D = 10, SAME_PRICE_D = 3, SALE_DAY_FAR_D = 14;
const CLEARED = {
  cancellation_reason: null, cancellation_reason_notes: null, cancelled_at: null,
  trash_reason: null, trash_reason_notes: null, trashed_at: null,
};

// ─── pure helpers ───────────────────────────────────────────────────────────
/** RFC-4180 CSV → array of objects (the input is our own file: UTF-8, BOM, quoted where needed). */
export function parseCsv(text) {
  const rows = []; let row = [], cell = '', inQ = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQ) {
      if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else inQ = false; } else cell += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  const head = rows.shift() || [];
  return rows.filter((r) => r.length === head.length).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

const SKOPJE_PARTS = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Skopje', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});
/** "2024-01-30T20:16:25" as Skopje wall time → the UTC instant (ISO). */
export function skopjeWallToIso(wall) {
  const asUtc = Date.parse(`${wall}Z`);
  if (!Number.isFinite(asUtc)) return null;
  const p = Object.fromEntries(SKOPJE_PARTS.formatToParts(new Date(asUtc)).map((x) => [x.type, x.value]));
  const shown = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return new Date(asUtc - (shown - asUtc)).toISOString();
}

const STATUS_MK = { cancelled: 'откажана', trashed: 'во корпа', paid: 'платена', returned: 'вратена' };

/**
 * The final outcome a row proves, or why it proves nothing: a returned document with a delivered re-send is a delivery
 * (by the re-send document, at its time); a re-send whose own outcome is unknown decides nothing yet.
 */
export function finalOutcome(r) {
  if (r.outcome === 'delivered') return { outcome: 'delivered', doc: r.doc, at: r.doc_at, resend: false };
  if (r.outcome === 'returned') {
    if (!r.resend_doc) return { outcome: 'returned', doc: r.doc, at: r.doc_at, resend: false };
    if (r.resend_outcome === 'delivered') return { outcome: 'delivered', doc: r.resend_doc, at: r.resend_at, resend: true };
    if (r.resend_outcome === 'returned') return { outcome: 'returned', doc: r.doc, at: r.doc_at, resend: false };
    return { skip: 'resend_open' };
  }
  return { skip: 'no_flag' };
}

/** Classify one input row against the live order. → { rule, set, history, note, target } or { skip }. */
export function classify(r, o, { owned, inputIds, siblings, payout }) {
  if (!o) return { skip: 'order_gone' };
  if (o.mex_tracking_id) return { skip: 'holds_mex_parcel' };
  if (!VERDICTS.has(r.audit_verdict)) return { skip: `audit_${r.audit_verdict}` };
  if (o.status !== r.audit_status) return { skip: `moved_${r.audit_status}_to_${o.status}` };
  const f = finalOutcome(r);
  if (f.skip) return f;
  const at = skopjeWallToIso(f.at);
  if (!at) return { skip: 'no_document_time' };
  if (payout.has(o.id)) return { skip: 'in_agent_payout' };
  const head = `collabBox ${r.doc} · ${r.courier_mk}`;
  // what the courier flag says, in the operators' words
  const delivered = f.resend ? `вратена, па повторно испратена со ${f.doc} и доставена` : 'доставена (Delivered)';
  const evidence = {
    doc: r.doc, doc_type: r.doc_type, courier: r.courier, flag: r.outcome, match: r.match, doc_at: r.doc_at,
    audit_verdict: r.audit_verdict, basis_before: o.paid_basis ?? null,
    ...(f.resend ? { resend_doc: f.doc, resend_via: r.resend_via } : {}),
  };

  if (o.status === 'paid') {
    if (f.outcome === 'delivered') {
      if (o.paid_basis === BASIS || o.paid_basis === 'mex') return { skip: 'already_proven' };
      return {
        rule: 'proven', target: 'paid', proofDoc: f.doc, evidence, set: { paid_basis: BASIS }, history: null,
        note: `${head}: ${delivered} — платено, докажано со статусот на курирот во collabBox. ${AUDIT}.`,
      };
    }
    return {
      rule: 'paid_returned', target: 'returned', proofDoc: f.doc, evidence,
      set: { status: 'returned', returned_at: at, paid_at: null, paid_basis: null },
      history: { from: 'paid', to: 'returned' },
      note: `${head}: вратена (Return to sender) — статусот е поправен: платена → вратена. ${AUDIT}.`,
    };
  }
  if (DEAD.has(o.status)) {
    const t = Date.parse(at);
    // a duplicate is housekeeping: its document belongs to the order it duplicates
    const why = `${o.cancellation_reason_notes ?? ''} ${o.trash_reason_notes ?? ''}`;
    if (o.cancellation_reason === 'duplicate_order' || o.trash_reason === 'duplicate_order' || /duplicate|дупликат/i.test(why)) return { skip: 'dead_as_duplicate' };
    // its own sale stamp says another day than the document: it would count as a sale where the parcel does not belong
    const stamp = o.sold_at || o.confirmed_at;
    if (stamp && Math.abs(Date.parse(stamp) - t) > SALE_DAY_FAR_D * DAY_MS) return { skip: 'sale_day_far_from_document' };
    const sibs = (siblings.get(phone8(o.customer_phone)) || []).filter((s) => s.id !== o.id && LIVING.has(s.status));
    // a living sale on the same phone around the document that owns no evidence of its own may be the document's order
    const twin = sibs.find((s) => !s.mex_tracking_id && !owned.has(s.id) && !inputIds.has(s.id)
      && Date.parse(s.created_at) >= t - TWIN_BEFORE_D * DAY_MS && Date.parse(s.created_at) <= t + TWIN_AFTER_D * DAY_MS);
    if (twin) return { skip: 'twin_living_sale', twin: twin.display_id };
    // the same price within three days of the dead order: one sale entered twice, whatever the twin owns
    const same = sibs.find((s) => Number(s.price) > 0 && Math.abs(Number(s.price) - Number(o.price)) < 0.005
      && Math.abs(Date.parse(s.created_at) - Date.parse(o.created_at)) <= SAME_PRICE_D * DAY_MS);
    if (same) return { skip: 'same_price_twin', twin: same.display_id };
    const was = STATUS_MK[o.status];
    if (f.outcome === 'delivered') {
      return {
        rule: 'dead_paid', target: 'paid', proofDoc: f.doc, evidence,
        set: { ...CLEARED, status: 'paid', paid_at: at, returned_at: null, paid_basis: BASIS },
        history: { from: o.status, to: 'paid' },
        note: `${head}: ${delivered} — пратката е испратена и наплатена; статусот е поправен: ${was} → платена. ${AUDIT}.`,
      };
    }
    return {
      rule: 'dead_returned', target: 'returned', proofDoc: f.doc, evidence,
      set: { ...CLEARED, status: 'returned', returned_at: at, paid_at: null, paid_basis: null },
      history: { from: o.status, to: 'returned' },
      note: `${head}: вратена (Return to sender) — пратката е испратена и вратена; статусот е поправен: ${was} → вратена. ${AUDIT}.`,
    };
  }
  return { skip: `status_${o.status}` };
}

// ─── loaders ────────────────────────────────────────────────────────────────
async function loadOrders(ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 2000) {
    const rows = await sqlRead(`select id, display_id, status::text as status, mex_tracking_id, paid_basis, price,
        customer_phone, created_at, source_type, sale_source, sold_at, confirmed_at,
        cancellation_reason::text as cancellation_reason, cancellation_reason_notes,
        trash_reason::text as trash_reason, trash_reason_notes
      from public.orders where id = any(${qUuidArray(ids.slice(i, i + 2000))})`);
    for (const r of rows) out.set(r.id, r);
  }
  return out;
}
/** Every order on the same last-8 phones (the project's phone identity) — the twin guard's view of a customer. */
async function loadSiblings(phones) {
  const list = [...new Set(phones.map(phone8).filter((x) => x.length === 8))];
  const out = [];
  for (let i = 0; i < list.length; i += 2000) {
    out.push(...await sqlRead(`select id, display_id, customer_phone, status::text as status, created_at, price, mex_tracking_id
      from public.orders
     where right(regexp_replace(customer_phone, '[^0-9]', '', 'g'), 8) = any(${qTextArray(list.slice(i, i + 2000))})`));
  }
  return out;
}

// ─── main ───────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2), { flags: ['apply', 'outside-quiet-window'], values: ['run', 'actor', 'chunk', 'input'] });
  mkGuard();
  await assertRemoteIsMk();
  await requireRepairSchema({ forApply: !!args.apply });
  await requireKeepUpdatedAt({ forApply: !!args.apply });

  const inputName = args.input || 'courier-outcomes';
  if (!INPUT_NAMES.has(inputName)) die(`--input must be one of: ${[...INPUT_NAMES].join(', ')}`);
  const INPUT_DIR = join(INPUT_ROOT, inputName);
  const inputPath = join(INPUT_DIR, 'input.csv');
  const ownedPath = join(INPUT_DIR, 'owned-orders.csv');
  if (!existsSync(inputPath) || !existsSync(ownedPath)) die(`input not found in ${INPUT_DIR} — run: python scripts/history/courier_outcomes_build.py`);
  const input = parseCsv(readFileSync(inputPath, 'utf8'));
  const owned = new Set(readFileSync(ownedPath, 'utf8').split(/\r?\n/).slice(1).filter(Boolean));
  const inputIds = new Set(input.map((r) => r.order_id));
  if (inputIds.size !== input.length) die('the input names an order twice — rebuild it.');
  ok(`input: ${input.length.toLocaleString('de-DE')} orders on another courier's documents; ${owned.size.toLocaleString('de-DE')} audited orders own evidence`);

  const orders = await loadOrders([...inputIds]);
  const deadPhones = input.map((r) => orders.get(r.order_id)).filter((o) => o && DEAD.has(o.status)).map((o) => o.customer_phone);
  const sibRows = await loadSiblings(deadPhones);
  const siblings = new Map();
  for (const s of sibRows) { const k = phone8(s.customer_phone); (siblings.get(k) ?? siblings.set(k, []).get(k)).push(s); }
  const payout = await loadPayoutOrderIds([...inputIds]);

  const plan = [], skipped = [], csv = [];
  for (const r of input) {
    const o = orders.get(r.order_id);
    const c = classify(r, o, { owned, inputIds, siblings, payout });
    const base = {
      order_id: r.order_id, display_id: o?.display_id ?? r.display_id, order_day: r.order_day, status_now: o?.status ?? '',
      paid_basis_now: o?.paid_basis ?? '', doc: r.doc, doc_type: r.doc_type, doc_at: r.doc_at, courier: r.courier,
      flag: r.outcome, resend_doc: r.resend_doc, resend_outcome: r.resend_outcome, match: r.match, audit_verdict: r.audit_verdict,
      price_eur: o?.price ?? r.price_eur, value_mkd: Math.round(Number(o?.price ?? 0) * MKD_PER_EUR), doc_amount_mkd: r.doc_amount_mkd,
    };
    if (c.skip) { skipped.push({ ...base, action: 'skip', reason: c.skip, twin: c.twin ?? '' }); csv.push({ ...base, action: 'skip', rule: '', target: '', reason: c.skip, twin: c.twin ?? '' }); continue; }
    const line = planLine(r.order_id, c.rule, c.target, c.proofDoc);
    plan.push({
      unit: r.order_id, order_id: r.order_id, rule: c.rule, line, expect_status: o.status, expect_tracking: null,
      set: c.set, link: null, unlink: null, history: c.history, note: c.note, evidence: c.evidence,
      _o: o, _r: r,
    });
    csv.push({ ...base, action: 'apply', rule: c.rule, target: c.target, reason: '', twin: '' });
  }

  // ── summary
  const by = {};
  for (const p of plan) {
    by[p.rule] ??= { orders: 0, eur: 0, mkd: 0, doc_mkd: 0, zero_price: 0, Kolporter: 0, Eko: 0, Jon: 0 };
    const b = by[p.rule];
    b.orders++; b.eur += Number(p._o.price || 0); b.mkd += Math.round(Number(p._o.price || 0) * MKD_PER_EUR);
    b.doc_mkd += Number(p._r.doc_amount_mkd || 0); if (!(Number(p._o.price) > 0)) b.zero_price++;
    b[p._r.courier.split(' ')[0]] = (b[p._r.courier.split(' ')[0]] || 0) + 1;
  }
  console.log(bold('\nPlan (orders with NO MEX parcel, judged by the collabBox courier flag):'));
  printTable(Object.entries(by).map(([rule, b]) => ({
    rule, orders: b.orders, eur: Math.round(b.eur), 'CRM value ден': fmtMkd(b.mkd), 'document ден': fmtMkd(b.doc_mkd),
    'price ≤ 0': b.zero_price, Kolporter: b.Kolporter, Eko: b.Eko, Jon: b.Jon,
  })));
  const why = {};
  for (const s of skipped) why[s.reason] = (why[s.reason] || 0) + 1;
  console.log(bold('Left alone:'));
  printTable(Object.entries(why).sort((a, b) => b[1] - a[1]).map(([reason, orders]) => ({ reason, orders })));
  const basisMove = {};
  for (const p of plan.filter((x) => x.rule === 'proven')) basisMove[p._o.paid_basis ?? 'NULL'] = (basisMove[p._o.paid_basis ?? 'NULL'] || 0) + 1;
  console.log(`  proven — paid_basis today: ${Object.entries(basisMove).map(([k, n]) => `${k} ×${n}`).join(', ')} → ${BASIS}`);

  // ── sticky-Trash pre-check for the status changes (listed, never blocking)
  const moving = plan.filter((p) => p.set.status);
  const phoneOrders = await loadPhoneOrders(moving.map((p) => p._o.customer_phone));
  const changes = new Map(moving.map((p) => [p.order_id, { status: p.set.status, trashed_at: null, trash_reason: null }]));
  const trash = stickyTrashEffects(phoneOrders, changes);
  const falls = printTrashFalls(trash);
  console.log(`  released from sticky Trash by a now-paid order: ${trash.released.length}`);

  const lines = plan.map((p) => p.line);
  const summary = {
    input: input.length, planned: plan.length, skipped: skipped.length,
    rules: Object.fromEntries(Object.entries(by).map(([k, b]) => [k, { orders: b.orders, eur: Math.round(b.eur) }])),
    left_alone: why, trash: { permanent: falls.permanent, parked: falls.parked, released: trash.released.length }, basis: BASIS,
    options: { input: inputName },
  };

  if (!args.apply) {
    const file = writeCsv(`${KEY}-${fileStamp()}.csv`, csv);
    const run = await recordDryRun({ key: KEY, lines, summary });
    console.log(`\n${green('DRY RUN')} — nothing was written to orders.\n  CSV: ${file}\n  run: ${bold(run.id)}  (hash ${run.hash.slice(0, 12)}…)`);
    console.log(`  apply: node scripts/repair-courier-outcomes.mjs --apply --run ${run.id}${args.input ? ` --input ${inputName}` : ''}`);
    return;
  }

  // ── apply
  const { done } = await verifyRunForApply({ key: KEY, runId: args.run, lines, options: args.input ? { input: inputName } : null });
  requireQuietWindow({ override: !!args['outside-quiet-window'] });
  await requireNoSegmentRecompute('start the apply');
  const actor = await resolveActor(args.actor || 'mile@elyon.com');
  const typeMap = await loadOrderColumnTypes();
  const todo = plan.filter((p) => !done.has(p.order_id)).map(({ _o, _r, ...row }) => row);
  // status changes first (they move money), the proof marking last
  todo.sort((a, b) => Number(!a.set.status) - Number(!b.set.status));
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
  console.log('  next: select public.recompute_all_segments();  then the verify scripts.');
  console.log(`  undo: node scripts/rollback-repair.mjs --run ${args.run} --apply`);
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/repair-courier-outcomes.mjs')) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
