#!/usr/bin/env node
/**
 * Repair B2 — the ghost-parcel leftovers, decided case by case (checker C10 + repair B's manual list).
 *
 * After repair B (mex-ghost-links, run 7d59b83a) and the C10 replacement exemption (owner ruling
 * 28.09.2026: price 0 + parcel COD 0 = a free replacement, not an order), 23 orders still held a
 * MEX tracking id on a 0 ден / synthetic row: B's 10 manual ghosts, 8 cancelled 0 ден call-outcome
 * rows the pre-fix reconcile had hung a parcel on without flipping them, and 5 price-0 real
 * product orders. Each was investigated on 28.09.2026 (orders on the phone, dates, COD vs prices,
 * names, the AlterCPA ledger, and the collabBox document whose DocNumber is the tracking id —
 * C:\Users\Mile\collab_out, headers to 10.09) and decided in DECISIONS below. The 3 tracking ids
 * held by two orders (repair B's D_manual) are the owner's "keep both" pairs — already accepted in
 * scripts/data/c8a-accepted-duplicates.json; nothing to do.
 *
 * OWNER LAW applied: MEX alone decides shipped/paid/returned; a parcel belongs to the order it was
 * shipped FOR; a 0 ден call-outcome row is never a sale; genuinely ambiguous cases are listed, not
 * guessed.
 *
 * ACTIONS
 *   move    the holder X loses parcel T; mex_link_parcel(T, R, 'repair', force). R's status follows
 *           the parcel (MEX decides: delivered → paid, returned → returned; an in-transit parcel
 *           never moves a cancel) — unless `resend`: R already names a NEWER parcel of its own (a
 *           re-send), keeps it (mex_link_parcel's re-send rule) and keeps its status.
 *   unlink  X loses T and nobody gets it (a MEX-only sale / owner undetermined / T not in either
 *           register): X's mex_* cleared, the register row unlinked if it points at X.
 *   keep    the parcel IS X's own — no write. The C10 FAIL is X's missing price (0 ден), which is a
 *           price repair (the MEX COD, owner rule 28.09), not a parcel one: listed for cod-price.
 *   X's status: a paid/returned/shipped that the pre-fix MEX reconcile flipped out of a cancel/
 *   trash via T goes back (cancel → 'other' + note, trash → 'not_reachable', the 21-day park —
 *   owner decision 27.09); a cancelled/trashed X keeps its status. If X's history does not prove
 *   that flip, the case is left manual.
 *   Every case is re-validated against the live rows (X still names T, nobody else does, the
 *   register agrees, R still has no parcel, same last-8 phone); anything that moved → manual.
 *
 *   node scripts/repair-ghost-manual.mjs                       # dry run → CSV + run id
 *   node scripts/repair-ghost-manual.mjs --apply --run <id> --guards-live [--actor mile@elyon.com] [--outside-quiet-window]
 *   --hold ORD-1,ORD-2      leave these cases untouched (listed as manual)
 *
 * ORDER: apply AFTER repair-altercpa-catchup-paid --population unproven-paid — two moves hand a
 * parcel to orders that population leaves manual (ORD-95923, and ORD-97860's parcel is the one
 * ORD-98347 was blocked on); applied first, they change that run's hash and it must be re-dry-run.
 *
 * 🛑 Macedonia only (repair-kit guards). Writes only with --apply, in the quiet window.
 */
import { pathToFileURL } from 'node:url';
import {
  MK_REF, bold, green, yellow, die, warn, ok,
  mkGuard, sqlRead, assertRemoteIsMk, requireRepairSchema, loadOrderColumnTypes,
  q, qTextArray, qUuid, qUuidArray, parseArgs, parseExpect, checkDrift, expectString,
  phone8, toMs, expectedCodMkd, codFit, fmtMkd, fmtSkopje, fmtSkopjeDate, fileStamp, writeCsv, planLine,
  loadPayoutOrderIds, loadPhoneOrders, stickyTrashEffects, printTrashFalls,
  loadHistory, loadMexNotes, mexFlipRevert, mexTargetFor, mexStatusSet, revertDispositionSet, trashParkNote, parcelWord,
  resolveActor, recordDryRun, verifyRunForApply, applyUnits, finalizeRun, auditPartial,
  requireKeepUpdatedAt, requireQuietWindow, requireNoSegmentRecompute, printTable, tally,
} from './lib/repair-kit.mjs';

export const KEY = 'ghost-manual';

/**
 * The owner-facing decision table (investigated 28.09.2026). `evidence` is what the order notes
 * quote. `x` = the order holding the parcel now; `to` = the order it was shipped for.
 */
export const DECISIONS = Object.freeze([
  // ── repair B's manual ghosts: 0 ден call outcomes the pre-fix reconcile flipped to paid/returned ──
  { x: 'ORD-91146', t: '002-9110-174110/2026', action: 'move', to: 'ORD-95923',
    evidence: 'collabBox LEADS document 002-9110-174110/2026 (СТЕФАНКА, 3.000 ден, Жаклина Дениќ) was issued 28.08 19:36, 77 minutes after AlterCPA lead ORD-95923 (3.000 ден) was created on 28.08 18:19; same phone, COD = its price' },
  { x: 'ORD-91446', t: '002-9110-175258/2026', action: 'move', to: 'ORD-98221', resend: true,
    evidence: 'collabBox LEADS document 002-9110-175258/2026 (СТЕФАНКА, 3.000 ден, Сашка Симоновска) was issued 08.09 20:40, 104 minutes after AlterCPA lead ORD-98221 (3.000 ден) was created on 08.09 18:56; it was returned on 12.09 and ORD-98221 was re-sent as 002-9110-176129/2026, which it keeps' },
  { x: 'ORD-92373', t: '002-9110-175114/2026', action: 'move', to: 'ORD-97860',
    evidence: 'collabBox LEADS document 002-9110-175114/2026 (Љубица Тумбова, 3.000 ден, Снежана Стојковска) was issued 07.09 13:47, the day after AlterCPA lead ORD-97860 (3.000 ден, 06.09 16:26) and two days BEFORE the other fit ORD-98347 (09.09) existed' },
  { x: 'ORD-92603', t: '002-9110-175877/2026', action: 'move', to: 'ORD-99385',
    evidence: 'the parcel was created 16.09, the day after AlterCPA lead ORD-99385 (3.000 ден, 15.09 05:51); the other fit ORD-96272 (30.08) has its own same-day LEADS document 002-9110-174272/2026 (30.08, 3.000 ден)' },
  { x: 'ORD-91484', t: '002-9110-175647/2026', action: 'unlink',
    evidence: 'owner undetermined — AlterCPA leads ORD-98944 (12.09, 1.490 ден) and ORD-97829 (06.09, 1.490 ден) both fit COD 1.640 = 1.490 + 150; ORD-97829\'s own LEADS document may be 002-9110-175031/2026 (06.09), which sits on ORD-81428; no collabBox document after 10.09 to decide' },
  { x: 'ORD-94110', t: '002-9103-176294/2026', action: 'unlink',
    evidence: 'owner undetermined — ORD-92900 (11.09) and ORD-93568 (14.09) are both Tamara Radovikj\'s confirmed 2.000 ден sales to this customer, neither packed; the COD fits both' },
  // ── cancelled 0 ден call outcomes the pre-fix reconcile hung a parcel on (status never flipped) ──
  { x: 'ORD-104908', t: '002-9100-175958/2026', action: 'unlink',
    evidence: 'a NATURA teleshop (9100) label of 21.09, 2.400 ден — three days after this call outcome; no CRM order on the phone fits it (a teleshop sale, MEX-only until its collabBox document is imported)' },
  { x: 'ORD-105342', t: '002-9102-176802/2026', action: 'unlink',
    evidence: 'a NATURA teleshop (9102) label of 21.09, 2.000 ден for a teleshop regular (Нарачка out documents since 03.2026); ORD-104653 (17.09, 2.600 ден) has its own parcel 002-9102-176708/2026; no CRM order fits' },
  { x: 'ORD-106703', t: '002-9103-177192/2026', action: 'unlink',
    evidence: 'a BIO NATURAL LEADS-OUT (9103) label of 25.09, 3.000 ден — the customer\'s regular LEADS-OUT purchase (Елена Младеновска, 3.000 ден since 05.2026); no CRM order fits' },
  { x: 'ORD-92522', t: '002-9103-176085/2026', action: 'unlink',
    evidence: 'a LEADS-OUT (9103) parcel of 22.09, Rejected, COD 2.625 ден; probable owner ORD-92860 (11.09, Tamara Radovikj, 3.500 ден — 2.625 is exactly 3.500 × 0,75) but the COD does not fit its price, so it is listed, not linked' },
  { x: 'ORD-93283', t: '002-9102-177278/2026', action: 'unlink',
    evidence: 'a NATURA teleshop (9102) parcel of 25.09, 2.000 ден, for a teleshop regular (Станка Јовановска\'s Нарачка out documents); ORD-103421 (09.09) has its own parcel; no CRM order fits' },
  { x: 'ORD-94487', t: '002-9110-176163/2026', action: 'unlink',
    evidence: 'a LEADS (9110) label of 21.09, 4.000 ден; no CRM order at all on this phone besides this call outcome — an AlterCPA sale outside the CRM (MEX-only)' },
  { x: 'ORD-95094', t: '002-9103-176523/2026', action: 'unlink',
    evidence: 'a LEADS-OUT (9103) parcel created 17.09 — the day of this "bought elsewhere" call outcome — Problematic, 4.000 ден; no CRM order fits' },
  { x: 'ORD-89804', t: '002-9110-175921/2026', action: 'unlink',
    evidence: 'the tracking id is in neither MEX register, so MEX cannot confirm it; a call outcome never owns a parcel (probable owner AlterCPA lead ORD-99491, 15.09, 4.000 ден — the MEX reconcile links it once MEX reports the parcel)' },
  // ── price-0 real product orders ──
  { x: 'ORD-61831', t: '002-9110-161007/2026', action: 'keep',
    evidence: 'its own parcel: created the day after this AlterCPA-approved lead (their record: "0 MKD"), the only order on the phone then; returned 23.04 — status already = MEX. Missing price: COD 1.640 ден' },
  { x: 'ORD-62572', t: '002-9110-161534/2026', action: 'keep',
    evidence: 'its own parcel: created 3 days after this AlterCPA-approved "0 MKD" lead; returned 29.04; the re-order ORD-87052 (30.04) has its own document. Missing price: COD 1.640 ден' },
  { x: 'ORD-66218', t: '002-9110-163774/2026', action: 'keep',
    evidence: 'its own parcel: created 3 days after this AlterCPA-approved "0 MKD" lead; returned 20.05. Missing price: COD 3.000 ден' },
  { x: 'ORD-93612', t: '002-9103-176312/2026', action: 'keep',
    evidence: 'its own parcel: created the day after Julijana Andonovska\'s manual order (14.09), delivered 16.09 — status already = MEX. Missing price: COD 3.000 ден (paid at 0 ден understates revenue by 3.000 ден)' },
  { x: 'ORD-97410', t: '002-9110-175121/2026', action: 'keep',
    evidence: 'its own parcel: collabBox LEADS document 07.09 (Миле Крстовски, 3.000 ден, Санела Џоговиќ); the only order on this phone (AlterCPA called it "trash (duplicate)", 0 MKD, but MEX delivered it 10.09). Missing price: COD 3.000 ден' },
  { x: 'ORD-68276', t: '002-9102-172073/2026', action: 'unlink',
    evidence: 'a NATURA teleshop "Нарачка out" document of 29.07 (Тамара Радович, 2.000 ден) for a teleshop regular — two months after this AlterCPA lead (28.05, "cancelled (changed mind)"), which the pre-fix reconcile flipped to paid on 20.09; the parcel is a teleshop sale (MEX-only)' },
  { x: 'ORD-75027', t: '002-9110-174357/2026', action: 'move', to: 'ORD-96472',
    evidence: 'collabBox LEADS document 002-9110-174357/2026 (БОБАН МЛАДЕНОВСКИ, 4.000 ден, Санела Џоговиќ) was issued 31.08 14:13, 4 hours after AlterCPA lead ORD-96472 (Alpha Male, 4.000 ден) was created on 31.08 10:16; ORD-75027 is a 03.07 lead cancelled then, flipped by the pre-fix reconcile on 18.09' },
  { x: 'ORD-88155', t: '002-9110-174884/2026', action: 'move', to: 'ORD-97550', resend: true,
    evidence: 'collabBox LEADS document 002-9110-174884/2026 (ДАНИЕЛА, 3.000 ден, Жаклина Дениќ) was issued 05.09 13:55, 5 hours after AlterCPA lead ORD-97550 (Urofix, 3.000 ден) was created on 05.09 09:01; it was returned on 15.09 and ORD-97550 was re-sent as 002-9110-175998/2026, which it keeps. ORD-88155 is a 13.08 lead AlterCPA trashed' },
  { x: 'ORD-89321', t: '002-9103-174025/2026', action: 'unlink',
    evidence: 'the tracking id is in neither MEX register; collabBox says 002-9103-174025/2026 is the LEADS-OUT document of 18.08 (ОЛГИЦА АВРАМОВСКА, 3.000 ден, Теодора Крстевска) = the shipment of ORD-89110 (18.08, 3.000 ден, delivered 21.08 under MEX id ORD-89110); this is its duplicate_order trash' },
]);

/** Measured 2026-09-28 on the live rows (see the dry-run run id in the handoff). */
export const EXPECTED = { cases: 23, move: 6, unlink: 12, keep: 5, manual: 0, reverted: 9, followed: 4, trash_permanent: 0 };

// ─── loaders (read-only) ────────────────────────────────────────────────────
const ORDER_COLS = `o.id, o.display_id, o.status::text as status, o.price, o.product_name, o.source_type, o.external_source,
  o.external_order_id, o.created_at, o.confirmed_at, o.mex_tracking_id, o.customer_name, o.customer_phone, o.packed_at`;

export async function loadOrdersByDisplay(displayIds) {
  const list = [...new Set(displayIds.filter(Boolean))];
  if (!list.length) return [];
  return sqlRead(`select ${ORDER_COLS} from public.orders o where o.display_id = any(${qTextArray(list)})`);
}
const PARCEL_COLS = `tracking_id, account, series, status_id, status_name, cod_mkd, receiver_name, receiver_city,
  phone8, created_at_mex, delivered_at, returned_at, last_update_at, order_id, link_method`;
export async function loadParcels(trackings) {
  const list = [...new Set(trackings.filter(Boolean))];
  if (!list.length) return [];
  return sqlRead(`select ${PARCEL_COLS} from public.mex_parcels where tracking_id = any(${qTextArray(list)})`);
}
/** Every order naming one of these tracking ids (orders side), and every register parcel linked to the given orders. */
export async function loadNamers(trackings) {
  const list = [...new Set(trackings.filter(Boolean))];
  if (!list.length) return [];
  return sqlRead(`select o.id, o.display_id, o.mex_tracking_id from public.orders o where o.mex_tracking_id = any(${qTextArray(list)})`);
}
export async function loadOwnParcels(orderIds) {
  const ids = [...new Set(orderIds.filter(Boolean))];
  if (!ids.length) return [];
  return sqlRead(`select ${PARCEL_COLS} from public.mex_parcels where order_id = any(${qUuidArray(ids)})`);
}

// ─── classification (pure — no I/O) ─────────────────────────────────────────
const CLEAR_MEX = Object.freeze({ mex_tracking_id: null, mex_account: null, mex_status_id: null, mex_cod_mkd: null,
  mex_delivered_at: null, mex_returned_at: null, mex_last_update_at: null });

/**
 * @returns {{ units, csv, lines, counts, changes }}
 */
export function classifyGhostManual({ decisions = DECISIONS, orders, parcels, namers, ownParcels, history = [], notes = [],
  payout = new Set(), hold = new Set(), runTag = 'dry-run', today = fmtSkopjeDate(Date.now()) }) {
  const byDisplay = new Map(orders.map((o) => [o.display_id, o]));
  const parcelBy = new Map(parcels.map((p) => [p.tracking_id, p]));
  const namersBy = new Map();
  for (const n of namers) (namersBy.get(n.mex_tracking_id) ?? namersBy.set(n.mex_tracking_id, []).get(n.mex_tracking_id)).push(n);
  const ownBy = new Map();
  for (const p of ownParcels) (ownBy.get(p.order_id) ?? ownBy.set(p.order_id, []).get(p.order_id)).push(p);

  const units = [], csv = [], lines = [];
  const changes = new Map();
  const counts = { cases: decisions.length, move: 0, unlink: 0, keep: 0, manual: 0, excluded_payout: 0, reverted: 0, followed: 0 };
  for (const d of [...decisions].sort((a, b) => a.x.localeCompare(b.x))) {
    const X = byDisplay.get(d.x) || null;
    const R = d.to ? byDisplay.get(d.to) || null : null;
    const P = parcelBy.get(d.t) || null;
    let action = d.action, why = '';
    // ── re-validate against the live rows
    const others = (namersBy.get(d.t) || []).filter((n) => !X || n.id !== X.id);
    if (hold.has(d.x) || (d.to && hold.has(d.to))) why = 'held back with --hold';
    else if (!X) why = `${d.x} not found`;
    else if (X.mex_tracking_id !== d.t) why = `${d.x} no longer names ${d.t} (now ${X.mex_tracking_id || 'none'})`;
    else if (others.length) why = `${d.t} is also named by ${others.map((n) => n.display_id).join(', ')}`;
    else if (P && P.order_id && P.order_id !== X.id) why = 'the register links the parcel to another order';
    else if (action === 'move' && !P) why = 'the parcel is not in the MEX register';
    else if (action === 'move' && !R) why = `${d.to} not found`;
    else if (action === 'move' && phone8(R.customer_phone) !== (P.phone8 || phone8(X.customer_phone))) why = `${d.to} is on another phone than the parcel`;
    else if (action === 'move' && ['take', 'duplicated'].includes(R.status)) why = `${d.to} is ${R.status}`;
    else if (action === 'move' && !d.resend && R.mex_tracking_id) why = `${d.to} already names ${R.mex_tracking_id}`;
    else if (action === 'move' && d.resend) {
      const newer = (ownBy.get(R.id) || []).find((p) => p.tracking_id === R.mex_tracking_id && toMs(p.created_at_mex) > toMs(P.created_at_mex));
      if (!newer) why = `${d.to} was expected to keep a NEWER parcel of its own (a re-send); it names ${R.mex_tracking_id || 'none'}`;
    }
    const inPayout = [X?.id, R?.id].some((id) => id && payout.has(id));
    // X's status: a MEX flip out of a cancel/trash goes back; a cancel/trash stays
    let rv = null;
    if (!why && X && action !== 'keep' && ['paid', 'returned', 'shipped'].includes(X.status)) {
      rv = mexFlipRevert({ order: X, history, notes, tracking: d.t });
      if (!rv.ok) why = `${d.x} ${X.status}: ${rv.why}`;
    } else if (!why && X && action !== 'keep' && !['cancelled', 'trashed'].includes(X.status)) {
      why = `${d.x} is ${X.status} — neither a MEX flip nor a cancel/trash`;
    }
    if (why) action = 'manual';
    else if (inPayout && action !== 'keep') { action = 'excluded_payout'; why = 'an order of this case is in agent_payout_items'; }
    counts[action] = (counts[action] || 0) + 1;

    const follow = action === 'move' && !d.resend ? mexTargetFor(R.status, P) : null;
    const revertTo = rv?.ok ? rv.revertTo : '';
    const pTxt = P ? `${P.status_id} ${P.status_name || ''}`.trim() : 'not in the register';
    csv.push({
      case: d.x, action, planned: d.action, why, tracking: d.t, account: P?.account || '', parcel_status: pTxt, cod_mkd: P?.cod_mkd ?? '',
      parcel_created: fmtSkopje(P?.created_at_mex), receiver: P ? `${P.receiver_name || ''} / ${P.receiver_city || ''}` : '',
      holder_status: X?.status || '', holder_source: X ? `${X.source_type}/${X.external_source || '-'}` : '', holder_price_mkd: X ? expectedCodMkd(X.price) : '',
      holder_product: X?.product_name || '', holder_created: fmtSkopje(X?.created_at), holder_back_to: revertTo,
      to_order: d.to || '', to_status: R?.status || '', to_price_mkd: R ? expectedCodMkd(R.price) : '', to_created: fmtSkopje(R?.created_at),
      to_target: follow || (action === 'move' && d.resend ? `keeps ${R?.mex_tracking_id} (re-send)` : ''), cod_fit_to: R && P ? (codFit(R.price, P.cod_mkd) || '') : '',
      evidence: d.evidence, trash_effect: '',
    });
    const line = planLine(X?.id || d.x, action, action === 'move' ? `${d.to}:${follow || ''}` : revertTo, d.t);
    lines.push(line);
    if (!['move', 'unlink'].includes(action)) continue;

    // ── plan rows
    const flipDate = rv?.ok ? fmtSkopjeDate(rv.flip.changed_at) : '';
    const dest = action === 'move' ? `it was shipped for ${d.to}, where it is moved` : 'it stays unlinked (a MEX-only parcel until its real order is known)';
    const xSet = rv?.ok
      ? revertDispositionSet({ revertTo, at: rv.originAt,
        cancelNote: `original reason wiped when MEX parcel ${d.t} was mis-matched on ${flipDate}; ${action === 'move' ? `the parcel belongs to ${d.to}` : 'the parcel is not this order\'s'}; restored ${today}`,
        trashNote: trashParkNote(d.t, P) })
      : { ...CLEAR_MEX };
    if (rv?.ok) counts.reverted++;
    const xNote = `Repair ${KEY} (run ${runTag}): MEX ${P?.account ? `${P.account} ` : ''}parcel ${d.t} (${pTxt}${P ? `, COD ${fmtMkd(P.cod_mkd)} ден` : ''}) is not this order's` +
      ` — ${d.evidence}. The link is removed; ${dest}.` +
      (rv?.ok ? ` On ${flipDate} the pre-fix MEX reconcile had flipped this ${revertTo === 'trashed' ? 'trashed' : 'cancelled'} order to ${rv.flip.to_status} with it, so it goes back to ${revertTo}` +
        (revertTo === 'trashed' ? ' as not_reachable (the 21-day park, owner decision 27.09.2026).' : '; its original reason was wiped, so it reads "other".')
        : ` Status ${X.status} is unchanged.`);
    const rows = [{
      unit: `gm:${d.t}`, order_id: X.id, rule: action === 'move' ? 'GM_loses' : 'GM_unlink', line,
      expect_status: X.status, expect_tracking: d.t,
      set: xSet, link: null, unlink: P && P.order_id === X.id && action === 'unlink' ? d.t : null,
      history: rv?.ok ? { from: X.status, to: revertTo } : null,
      note: xNote,
      evidence: { key: KEY, order: X.display_id, tracking: d.t, action, to: d.to || null, revert_to: revertTo || null,
        parcel_status: P?.status_id ?? null, cod_mkd: P?.cod_mkd ?? null, why: d.evidence },
    }];
    if (rv?.ok) changes.set(X.id, revertTo === 'trashed' ? { status: 'trashed', trashed_at: rv.originAt, trash_reason: 'not_reachable' } : { status: 'cancelled' });
    if (action === 'move') {
      if (follow) counts.followed++;
      const rLine = planLine(R.id, 'GM_gets', follow || '', d.t);
      lines.push(rLine);
      rows.push({
        unit: `gm:${d.t}`, order_id: R.id, rule: 'GM_gets', line: rLine,
        expect_status: R.status, expect_tracking: R.mex_tracking_id ?? null,
        set: follow ? mexStatusSet(follow, P) : {},
        link: { tracking: d.t, method: 'repair', force: true, expectOwner: P.order_id || null },
        unlink: null,
        history: follow ? { from: R.status, to: follow } : null,
        note: `Repair ${KEY} (run ${runTag}): MEX ${P.account || ''} parcel ${d.t} (${pTxt}, created ${fmtSkopje(P.created_at_mex)}, COD ${fmtMkd(P.cod_mkd)} ден)` +
          ` was shipped for this order — ${d.evidence}. It had been attached to ${d.x}; it is linked here` +
          (d.resend ? `, as the first shipment: this order keeps its newer parcel ${R.mex_tracking_id} (the re-send) and its status.`
            : follow ? `, and the status follows MEX: ${R.status} → ${follow} (${parcelWord(P)}).` : `; status ${R.status} is unchanged (the parcel is ${parcelWord(P)}).`),
        evidence: { key: KEY, order: R.display_id, tracking: d.t, role: 'gets_parcel', from: d.x, resend: !!d.resend, status_follow: follow,
          parcel_status: P.status_id, cod_mkd: P.cod_mkd, price_mkd: expectedCodMkd(R.price), cod_fit: codFit(R.price, P.cod_mkd) || null },
      });
      if (follow) changes.set(R.id, { status: follow });
    }
    units.push({ unit: `gm:${d.t}`, rows });
  }
  return { units, csv, lines, counts, changes };
}

// ─── main ───────────────────────────────────────────────────────────────────
const USAGE = `usage: node scripts/repair-ghost-manual.mjs [--expect k=n,...] [--hold ORD-1,...]
       node scripts/repair-ghost-manual.mjs --apply --run <id> --guards-live [--actor <email>] [--outside-quiet-window]`;

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    flags: ['apply', 'guards-live', 'outside-quiet-window', 'help'],
    values: ['run', 'expect', 'actor', 'hold'],
  });
  if (args.help) { console.log(USAGE); return; }
  mkGuard();
  const APPLY = !!args.apply;
  console.log(bold(`\nRepair B2 — ${KEY} — ${APPLY ? 'APPLY' : 'DRY RUN'}  (${MK_REF})\n`));
  if (APPLY && !args.run) die('--apply needs --run <id> (printed by the dry run).');
  if (APPLY && !args['guards-live']) die('--apply needs --guards-live: confirm the fixed mex-reconcile (no fallback onto 0 ден rows) is DEPLOYED.');
  await assertRemoteIsMk();
  await requireRepairSchema({ forApply: APPLY });
  await requireKeepUpdatedAt({ forApply: APPLY });
  if (APPLY) {
    requireQuietWindow({ override: !!args['outside-quiet-window'] });
    await requireNoSegmentRecompute('start the apply');
  }
  const hold = new Set(String(args.hold || '').split(',').map((s) => s.trim()).filter(Boolean));
  const expected = parseExpect(args.expect, EXPECTED);

  // 1. load
  const orders = await loadOrdersByDisplay(DECISIONS.flatMap((d) => [d.x, d.to]));
  const trackings = DECISIONS.map((d) => d.t);
  const [parcels, namers, ownParcels] = await Promise.all([
    loadParcels(trackings), loadNamers(trackings), loadOwnParcels(orders.map((o) => o.id))]);
  const [history, notes] = await Promise.all([loadHistory(orders.map((o) => o.id)), loadMexNotes(orders.map((o) => o.id))]);
  const payout = await loadPayoutOrderIds(orders.map((o) => o.id));
  ok(`${DECISIONS.length} decided cases · ${orders.length} orders · ${parcels.length} of their parcels in the register`);

  // 2. classify
  const runTag = APPLY ? String(args.run).slice(0, 8) : 'dry-run';
  const plan = classifyGhostManual({ orders, parcels, namers, ownParcels, history, notes, payout, hold, runTag });
  if (plan.units.some((u) => u.rows.some((r) => r.set?.status === 'confirmed'))) die('a row would be set to confirmed — refusing.');

  // 3. pre-checks
  const phoneRows = await loadPhoneOrders(orders.map((o) => o.customer_phone));
  const trash = stickyTrashEffects(phoneRows, plan.changes);
  const effectOf = new Map();
  for (const f of trash.falls) for (const d of f.orders) effectOf.set(d, f.kind === 'parked' ? `parked (not_reachable) until ${fmtSkopjeDate(f.until)}` : `falls into PERMANENT Trash — held by ${f.by}`);
  for (const f of trash.released) for (const d of f.orders) effectOf.set(d, 'released from Trash');
  for (const row of plan.csv) row.trash_effect = [effectOf.get(row.case), row.to_order && effectOf.get(row.to_order) ? `${row.to_order}: ${effectOf.get(row.to_order)}` : ''].filter(Boolean).join('; ');

  // 4. report
  console.log(bold('\nDecisions'));
  for (const r of plan.csv) {
    console.log(`  ${r.case.padEnd(11)} ${r.action.padEnd(7)} ${r.tracking.padEnd(21)} ${String(r.parcel_status).padEnd(20)} COD ${String(r.cod_mkd).padStart(5)}` +
      `  ${r.holder_status}${r.holder_back_to ? ` → ${r.holder_back_to}` : ''}` +
      `${r.to_order ? `  ⇒ ${r.to_order} ${r.to_status}${r.to_target ? ` → ${r.to_target}` : ''}` : ''}${r.why ? `  [${r.why}]` : ''}`);
  }
  printTable(Object.entries(tally(plan.csv, (r) => r.action, (r) => r.cod_mkd)).map(([action, v]) => ({ action, cases: v.orders, 'parcel COD (ден)': fmtMkd(v.mkd) })));
  console.log(bold('Pre-checks'));
  console.log(`  cases with an order in agent_payout_items: ${plan.counts.excluded_payout || 0}`);
  const trashCount = printTrashFalls(trash);
  console.log(`  customers released from Trash (an order becomes paid): ${trash.released.length}`);
  const csvPath = writeCsv(`${KEY}-${APPLY ? 'apply-' : ''}${fileStamp()}.csv`, plan.csv);
  ok(`CSV (contains PII — stays in exports/, never commit): ${csvPath}`);

  // 5. dry run → drift → ledger row
  if (!APPLY) {
    const counts = { cases: plan.counts.cases, move: plan.counts.move || 0, unlink: plan.counts.unlink || 0, keep: plan.counts.keep || 0,
      manual: (plan.counts.manual || 0) + (plan.counts.excluded_payout || 0), reverted: plan.counts.reverted, followed: plan.counts.followed,
      trash_permanent: trashCount.permanent };
    const drift = checkDrift(counts, expected);
    console.log(bold('\nExpected vs actual'));
    printTable(drift.rows);
    if (!drift.pass) {
      die('Counts drifted from the expected ones — NO run recorded. Read the CSV (why); if understood, re-run with\n' +
        `  --expect ${expectString(counts, Object.keys(expected))}`);
    }
    const summary = {
      script: 'repair-ghost-manual.mjs', expected, counts: plan.counts,
      cases: plan.csv.map((r) => ({ case: r.case, action: r.action, tracking: r.tracking, to: r.to_order || null, back_to: r.holder_back_to || null, to_target: r.to_target || null, why: r.why || null })),
      trash_falls_permanent: trashCount.permanent, trash_falls_parked: trashCount.parked, trash_released: trash.released.length,
      csv: csvPath.split(/[\\/]/).pop(),
    };
    const { id, hash } = await recordDryRun({ key: KEY, lines: plan.lines, summary });
    console.log(bold(`\nDry run recorded: ${green(id)}`) + `  (hash ${hash.slice(0, 12)}…)`);
    console.log('Nothing was written to orders. After review, in the quiet window (after 20:55 Skopje), AFTER the unproven-paid apply:');
    console.log('  node scripts/assert-mk-target.mjs');
    console.log(`  node scripts/repair-ghost-manual.mjs --apply --run ${id} --guards-live${hold.size ? ` --hold ${[...hold].join(',')}` : ''}\n`);
    return;
  }

  // 6. apply
  const actor = await resolveActor(args.actor || 'mile@elyon.com');
  ok(`recorded as ${actor.email}`);
  const { done } = await verifyRunForApply({ key: KEY, runId: args.run, lines: plan.lines });
  const units = plan.units.filter((u) => !u.rows.some((r) => done.has(r.order_id)));
  const typeMap = await loadOrderColumnTypes();
  console.log(bold(`\nApplying ${units.length} cases (${units.reduce((n, u) => n + u.rows.length, 0)} orders)`));
  const stats = await applyUnits({ key: KEY, runId: args.run, units, typeMap });
  const payload = { script: 'repair-ghost-manual.mjs', counts: plan.counts, applied_orders: stats.applied, links: stats.links,
    skipped_moved: stats.skipped, chunks: `${stats.committed}/${stats.chunks}`, resumed_from: done.size, outside_quiet_window: !!args['outside-quiet-window'] };
  if (stats.failed) {
    await auditPartial({ key: KEY, runId: args.run, actor, payload: { ...payload, failed: stats.failed } });
    die(`Stopped at chunk ${stats.failed.chunk}; ${stats.committed} chunk(s) committed and are in the ledger — fix the cause and re-run the same --apply.`);
  }
  await finalizeRun({ key: KEY, runId: args.run, actor, payload });
  ok(`run ${args.run} applied — ${stats.applied} orders, ${stats.links} parcel links${stats.skipped.length ? `, ${stats.skipped.length} left alone (moved since the dry run)` : ''}`);

  // 7. verify
  const [v] = await sqlRead(`select
      (select count(*) from public.data_repair_rows where run_id = ${qUuid(args.run)} and after is not null)::int as ledger_rows,
      (select count(*) from public.data_repair_rows r join public.orders o on o.id = r.order_id
        where r.run_id = ${qUuid(args.run)} and o.status = 'confirmed')::int as now_confirmed,
      (select count(*) from public.orders o where o.display_id = any(${qTextArray(DECISIONS.filter((d) => d.action !== 'keep').map((d) => d.x))})
        and o.mex_tracking_id is not null)::int as holders_still_naming,
      (select count(*) from (select mex_tracking_id from public.orders where mex_tracking_id is not null
        group by 1 having count(*) > 1) d)::int as trackings_on_two_orders`);
  console.log(bold('\nVerification'));
  printTable([v]);
  if (v.now_confirmed) warn('some repaired orders sit in confirmed — investigate now.');
  console.log(yellow('  Next: node scripts/engine-fixture-mk.mjs, node scripts/verify-attribution.mjs (C10 should show only the "keep" price-0 orders).\n'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => die(e.stack || e.message || String(e)));
}
