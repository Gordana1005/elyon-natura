/**
 * duplicate-unproven-paid — the pure half of scripts/repair-duplicate-unproven-paid.mjs (owner, Mile, 01.10.2026).
 * No I/O here.
 *
 * verify-attribution C7 lists the orders that are `paid` with no DELIVERED MEX parcel (created ≥ 01.08.2026 Skopje,
 * paid_basis not operator_ruling / legacy_import) — mostly AlterCPA leads written `paid` by the 18.09 catch-up
 * (`System (altercpa)`) or by the history import. A read-only investigation split them: the customer's parcel sits on
 * a SIBLING lead created ≤ 3 days apart (a duplicate lead — the sibling holds the real sale); the parcel sits on an
 * order more than 3 days apart (owner: leave those); a parcel was found (repair-altercpa-catchup-paid.mjs — not here).
 * The owner approved cancelling ONLY the duplicates, as duplicates pointing to the sibling.
 *
 * THE RULE (the investigator's, applied live): a C7 order (the SAME SQL — verify-attribution c7PopulationSql) that
 * holds no parcel at all, and ANOTHER order of the same customer (same last-8 digits of orders.customer_phone) created
 * within ±3 days (72 h) that holds a MEX parcel = the sibling. Safety (listed, never automatic): agent_payout_items,
 * affiliate leads (a status change sends a partner postback), a sibling whose parcel is not a BIO NATURAL (Affiliate)
 * parcel — a teleshop / social / web parcel is another department's sale (the folder decides).
 *
 * HOW THE CRM MARKS A DUPLICATE LEAD: cancelled with cancellation_reason 'duplicate_order' (the CHECK's value, the one
 * altercpa-sync writes for an AlterCPA cancel reason 7). NOT status 'duplicated': in this CRM that status is the
 * re-issue COPY made by POST /orders/:id/duplicate (a normal open order since 13.08, with duplicated_from = its
 * SOURCE) — the opposite of a dead duplicate lead. The cancel is a SYSTEM write (actor "System (repair:…)", no
 * person, so no person-note gate), dated on the lead's own day (its AlterCPA decision, else confirmed_at, else
 * created_at — as repair-folder-decides dates a never-cancelled lead), paid_at / paid_basis cleared; sold_* (the first
 * confirmer's stamp) and the AlterCPA ledger are never touched; nothing is pushed to AlterCPA.
 */
import { planLine, phone8, toMs, isoOrNull, fmtSkopje, fmtMkd, MKD_PER_EUR, DAY_MS } from './repair-kit.mjs';

export const KEY = 'duplicate-unproven-paid';
export const SIBLING_HOURS = 72;
export const OWNER_DAY = '01.10.2026';
/**
 * Read-only 01.10.2026 ~23:55 Skopje: C7 = 69 (74 at the investigation; the other session's catch-up run b3f38d6c
 * linked 5 of them to their own parcels at 23:33 — 3 of those also had a sibling, i.e. they were NOT duplicates) →
 * 20 duplicates by the rule. The investigator's ≈ 25 also counted holders found through the PARCEL's phone or at
 * 3.1 days — listed as near misses, never cancelled.
 */
export const EXPECTED = Object.freeze({ c7: 69, duplicate: 20 });

const AFFILIATE_SERIES = new Set(['9110', '9103']);
/** A BIO NATURAL lead parcel — the Affiliate department's (9110 Lead in · 9103 Lead out · BIO NATURAL with no series). */
export const isAffiliateParcel = (series, account) => AFFILIATE_SERIES.has(String(series ?? '')) || (!series && account === 'bio_natural');

/** Hours between two instants (absolute, one decimal). */
export const hoursApart = (a, b) => Math.round((Math.abs(toMs(a) - toMs(b)) / 3_600_000) * 10) / 10;

/**
 * The siblings of one C7 order → the one the cancel points to: a sibling on the same sale_source first, then the
 * nearest in time, then the lowest display id (stable). Only Affiliate-parcel siblings qualify; null when none.
 */
export function pickSibling(order, siblings) {
  const ok = (siblings ?? []).filter((s) => isAffiliateParcel(s.series, s.account));
  if (!ok.length) return null;
  return [...ok].sort((a, b) =>
    (a.sale_source === order.sale_source ? 0 : 1) - (b.sale_source === order.sale_source ? 0 : 1)
    || hoursApart(a.created_at, order.created_at) - hoursApart(b.created_at, order.created_at)
    || String(a.display_id).localeCompare(String(b.display_id)))[0];
}

/** The day the cancel is dated: the lead's AlterCPA decision, else confirmed_at, else created_at. */
export const cancelAt = (o) => isoOrNull(o.decided_at ?? o.confirmed_at ?? o.created_at);

/** The cohort's sale day: sold_at, else the AlterCPA decision, else confirmed_at, else created_at. */
export const saleAt = (o) => o.sold_at ?? o.decided_at ?? o.confirmed_at ?? o.created_at;

/** The value the cohort gave the order (no parcel → price × 61,5 ден). */
export const valueMkd = (o) => Math.round(Number(o.price || 0) * MKD_PER_EUR);

/** Where the cohort files the order today (cohort_order_bucket, no parcel) and after the cancel. */
export function cohortMove(o) {
  const before = ['operator_ruling', 'legacy_import'].includes(o.paid_basis) || (o.paid_basis == null && o.source_type === 'import')
    ? 'paid_legacy' : 'paid_unproven';
  const after = o.sold_at && Number(o.price) > 0 ? 'cancelled_after_sale' : '(not in the cohort)';
  return { before, after };
}

/**
 * C7 rows (+ siblings[], in_payout, affiliate, held) → the repair-kit units, the CSV, the plan lines (what the hash
 * covers: order:DU_duplicate:paid>cancelled:<sibling>:<its parcel>), the status changes for the sticky-Trash pre-check.
 */
export function classifyDuplicates({ rows, runId = null }) {
  const runTag = runId ? String(runId).slice(0, 8) : 'dry-run';
  const units = [], csv = [], lines = [], changes = new Map();
  const counts = { c7: rows.length, duplicate: 0, manual: 0, no_sibling: 0 };
  for (const o of rows) {
    const sibs = Array.isArray(o.siblings) ? o.siblings : [];
    if (!sibs.length) { counts.no_sibling++; continue; }
    const sib = pickSibling(o, sibs);
    const others = sibs.filter((s) => s !== sib);
    const mv = cohortMove(o);
    let why = '';
    if (o.status !== 'paid') why = `the order is ${o.status}`;
    else if (o.mex_tracking_id || Number(o.held) > 0) why = 'the order holds a parcel itself';
    else if (o.in_payout) why = 'in agent_payout_items';
    else if (o.affiliate) why = 'an affiliate lead (a status change sends a partner postback)';
    else if (!sib) why = `the sibling's parcel is not a BIO NATURAL lead parcel (${sibs.map((s) => `${s.display_id} ${s.tracking} ${s.series ?? s.account ?? ''}`).join('; ')}) — another department's sale`;
    const row = {
      order: o.display_id, created: fmtSkopje(o.created_at), sale_day: fmtSkopje(saleAt(o)), detail: o.sale_source_detail, paid_by: o.paid_by ?? '',
      value_mkd: valueMkd(o), sibling: sib?.display_id ?? sibs.map((s) => s.display_id).join(' | '), sibling_status: sib?.status ?? '',
      sibling_source: sib?.sale_source ?? '', sibling_parcel: sib ? `${sib.tracking} (MEX ${sib.status_id ?? '?'})` : '',
      hours_apart: sib ? hoursApart(sib.created_at, o.created_at) : '', other_siblings: others.map((s) => `${s.display_id} ${s.tracking}`).join(' | '),
      cancel_dated: fmtSkopje(cancelAt(o)), cohort: `${mv.before} → ${mv.after}`, seller_stamp: o.sold_at ? 'yes' : 'no',
      action: why ? 'manual' : 'cancel', why,
    };
    csv.push(row);
    if (why) { counts.manual++; continue; }
    counts.duplicate++;
    const notes = `duplicate of ${sib.display_id} which holds the parcel ${sib.tracking} (owner ${OWNER_DAY})`;
    const line = planLine(o.id, 'DU_duplicate', `paid>cancelled:${sib.display_id}`, sib.tracking);
    lines.push(line);
    changes.set(o.id, { status: 'cancelled' });
    units.push({
      unit: `du:${o.display_id}`,
      rows: [{
        unit: `du:${o.display_id}`, order_id: o.id, rule: 'DU_duplicate', line,
        expect_status: 'paid', expect_tracking: null,
        set: { status: 'cancelled', cancelled_at: cancelAt(o), cancellation_reason: 'duplicate_order',
          cancellation_reason_notes: notes, paid_at: null, paid_basis: null },
        link: null, unlink: null, history: { from: 'paid', to: 'cancelled' },
        note: `${notes[0].toUpperCase()}${notes.slice(1)}. This lead stood "paid" with no MEX proof (written paid by ${o.paid_by || 'an import'}); ` +
          `the customer's sale is ${sib.display_id} (${sib.status}, created ${fmtSkopje(sib.created_at)}, ${hoursApart(sib.created_at, o.created_at)} h apart, ` +
          `same phone), which holds MEX parcel ${sib.tracking}` +
          `${others.length ? ` (also on the phone within 3 days: ${others.map((s) => `${s.display_id} → ${s.tracking}`).join(', ')})` : ''}. ` +
          `Cancelled by the system as a duplicate (reason duplicate_order), dated ${fmtSkopje(cancelAt(o))} — the lead's own day. ` +
          `The seller's stamp and the AlterCPA decision are untouched; nothing was sent to AlterCPA. ` +
          `Run ${runTag} (undo: scripts/rollback-repair.mjs --run ${runId ?? '<run id>'}).`,
        evidence: { key: KEY, order: o.display_id, sibling: sib.display_id, sibling_id: sib.id, tracking: sib.tracking,
          sibling_parcel_status: sib.status_id, hours: hoursApart(sib.created_at, o.created_at), others: others.map((s) => s.display_id),
          cohort: mv, value_mkd: valueMkd(o), paid_by: o.paid_by ?? null },
      }],
    });
  }
  return { units, csv, lines, changes, counts };
}

/**
 * The engine's "Current Cancels" pen (recompute_customer_segments: the newest cancelled order by created_at, newer
 * than the newest paid, created < `days` ago) — which customers would ENTER it once the cancels land. Exact phones
 * (the engine keys on customer_phone), monadon_legacy ignored as the engine does.
 */
export function currentCancelsEffect(phoneOrders, changes, nowMs = Date.now(), days = 14) {
  const byPhone = new Map();
  for (const r of phoneOrders) (byPhone.get(r.customer_phone) ?? byPhone.set(r.customer_phone, []).get(r.customer_phone)).push(r);
  const inPen = (rows) => {
    const live = rows.filter((r) => r.source_type !== 'monadon_legacy');
    const last = (st) => live.filter((r) => r.status === st).reduce((m, r) => Math.max(m, toMs(r.created_at)), -Infinity);
    const c = last('cancelled'), p = last('paid');
    return c > -Infinity && c > p && nowMs - c < days * DAY_MS;
  };
  const enter = [];
  for (const [phone, rows] of byPhone) {
    if (!rows.some((r) => changes.has(r.id))) continue;
    const after = rows.map((r) => (changes.has(r.id) ? { ...r, ...changes.get(r.id) } : r));
    if (!inPen(rows) && inPen(after)) enter.push({ phone8: phone8(phone), orders: rows.filter((r) => changes.has(r.id)).map((r) => r.display_id) });
  }
  return enter;
}

/** Sale month (Skopje) → { orders, ден } of the cancels — what the cohort / board of those days lose as sales. */
export function byMonth(csv) {
  const out = {};
  for (const r of csv.filter((x) => x.action === 'cancel')) {
    const m = String(r.sale_day).slice(3, 10);
    out[m] ??= { orders: 0, mkd: 0 };
    out[m].orders++;
    out[m].mkd += Number(r.value_mkd) || 0;
  }
  return Object.entries(out).map(([month, v]) => ({ month, orders: v.orders, 'value (ден)': fmtMkd(v.mkd) }));
}
