/**
 * folder-decides — the pure half of scripts/repair-folder-decides.mjs (owner, Mile, 01.10.2026). No I/O here except
 * the exported SQL strings the script runs.
 *
 * OWNER LAW (28–29.09, confirmed 01.10.2026): "The department is decided by the collabBox FOLDER / MEX series, never by
 * the system an order was made in." On 01.10 ("Yes, the collabBox folder decides"): EVERY AlterCPA order that holds a
 * NATURA teleshop / social parcel (series 9102 Телешоп Out · 9100 Телешоп In · 9108 / 1300 Социјални) gives the parcel
 * to its collabBox document, which becomes ITS OWN order (Телешоп / Социјални, credited to the document's author) —
 * not only the cases sent on another day than the lead (scripts/repair-cross-channel-parcels.mjs, run a057bc52, did
 * those whose paid/returned came from a MEX flip of a cancel / trash).
 *
 * One UNIT = one parcel, applied in ONE sub-transaction (all or nothing):
 *   1. the AlterCPA order loses the parcel (orders.mex_* cleared, the register row unlinked) and goes back to what it
 *      was BEFORE the parcel made it a sale (preParcelState): its cancel / trash restored (cancel → 'other' + note,
 *      trash → 'not_reachable', the 21-day park — the repair-kit's revertDispositionSet), or — never cancelled (an
 *      AlterCPA approval / an imported "paid", then shipped on this parcel) — cancelled with reason 'other' and a
 *      system note. A SYSTEM write ("System (repair:folder-decides)", changed_by NULL): never a person's cancel, so
 *      the written-note rule (verify-disposition-notes D1) does not apply. Nothing is pushed to AlterCPA.
 *   2. the LIVE collabBox writer re-applies the parcel's document — collabbox_apply_documents(run, [payload], false) →
 *      collabbox_apply_one branch E — and it must answer 'created' with the parcel on the new order (seller = author,
 *      sold_at = collabbox_sale_at, status from MEX). Anything else rolls the whole unit back (left alone, listed).
 * Orders in agent_payout_items, LEADS-document orders (altercpa / collabbox_leads — their own 9110 parcel is the
 * question there), documents that cannot become an order and units the writer would refuse → manual.
 */
import {
  q, qUuid, qJson, MKD_PER_EUR, SNAP_COLUMNS, isoOrNull, fmtSkopje, fmtSkopjeDate, fmtMkd, toMs, planLine, snapshotSql,
  orderSnapshotSql, revertDispositionSet, trashParkNote,
} from './repair-kit.mjs';

export const KEY = 'folder-decides';
export const ACTOR = `System (repair:${KEY})`;
export const SERIES = Object.freeze(['9102', '9100', '9108', '1300']);
export const SALE_STATUSES = Object.freeze(['shipped', 'paid', 'returned', 'delivered']);
/** A parcel still at MEX 8 (label only) this long after it was created was never picked up — listed, not moved. */
export const STALE_LABEL_DAYS = 14;
export const DEPT_WORD = Object.freeze({
  altercpa: 'Affiliate – Lead in', elyon_crm: 'Affiliate – Lead out', teleshop_out: 'Телешоп – Lead out',
  teleshop_other: 'Телешоп – Lead in', social: 'Социјални мрежи', web: 'Web',
});
export const TYPE_WORD = Object.freeze({ 10050: 'Нарачка out', 10036: 'Нарачка in', 10106: 'Социјални мрежи', 10055: 'С. Мрежи-Продавница' });
/** Read-only 01.10.2026 ~23:30 Skopje (see the dry-run run id in the handoff). */
export const EXPECTED = Object.freeze({ candidates: 134, move: 127, manual: 7 });

const PHONE8_MK = `'^(7[0-9]{7}|2[0-9]{7}|3[1-4][0-9]{6}|4[2-8][0-9]{6})$'`;   // collabbox_mk_phone8 (20260942000900)
const mk8 = (expr) => `CASE WHEN btrim(coalesce(${expr}, '')) ~ ${PHONE8_MK} THEN btrim(${expr}) END`;

/**
 * The live candidates — every AlterCPA order holding a NATURA teleshop / social parcel — with what the dry run needs:
 * the parcel, the register, the document, the AlterCPA decision time, the two departments (cohort_order_source — the
 * ONE classifier) and the writer's branch-E gates AFTER the holder check, predicted read-only (the apply asks the live
 * writer itself): a web claim, a parcel older than its document, the customer's phone / a skipped komitent / a test
 * phone, and its possible_twin_crm_sale rule (the AlterCPA order itself excluded — it will be cancelled / trashed and
 * hold no parcel).
 */
export const CANDIDATES_SQL = `
with c as (
  select o.id, o.display_id, o.status::text as status, o.created_at, o.confirmed_at, o.price, o.product_name,
         o.sale_source, o.sale_source_detail, o.dept_override, o.external_source, o.external_order_id,
         o.sold_at, o.sold_by_person_id, o.mex_tracking_id as tracking, o.customer_phone,
         p.account, p.series, p.status_id as mex_status_id, p.status_name as mex_status_name, p.cod_mkd, p.created_at_mex,
         p.delivered_at, p.returned_at, p.last_update_at, p.order_id as reg_owner, p.link_method, p.phone8 as parcel_phone8,
         p.receiver_name, p.receiver_city,
         d.doc_number, d.doc_type_id, d.role as doc_role, d.outcome as doc_outcome, d.reason as doc_reason, d.doc_at, d.booked_at,
         d.author, d.author_person_id, d.amount_mkd, d.goods_mkd, d.komitent_id, d.komitent_name, d.is_storno, d.reversed_by, d.vanished_at,
         d.payload is not null as has_payload,
         coalesce((d.payload ->> 'lines_complete') = 'true', false) as lines_complete,
         case when jsonb_typeof(d.payload -> 'komitent') = 'object' then d.payload -> 'komitent' end as card,
         d.payload ->> 'name_skip' as name_skip,
         public.collabbox_sale_at(d.doc_at, least(coalesce(d.booked_at, d.doc_at), d.doc_at)) as doc_sale_at,
         public.cohort_order_source(o.sale_source, o.sale_source_detail, o.mex_tracking_id, o.dept_override) as dept_before,
         (select public.cohort_order_source(x[1], x[2], d.doc_number)
            from (select public.collabbox_department(d.doc_type_id, d.doc_number, d.author_person_id, d.doc_at) as x) z) as dept_after,
         (select count(*) from public.orders x where x.mex_tracking_id = p.tracking_id)::int as namers,
         exists (select 1 from public.orders x where x.external_source = 'collabbox' and x.external_order_id = p.tracking_id) as doc_is_order,
         exists (select 1 from public.web_orders w where w.mex_tracking_id = p.tracking_id and w.deleted_in_shop_at is null) as web_claimed,
         exists (select 1 from public.agent_payout_items ap where ap.order_id = o.id) as in_payout,
         (select max(l.decided_at) from public.altercpa_leads l
           where l.order_id = o.id and l.decision in ('approved', 'cancel_other') and l.decided_at is not null) as led_decided_at,
         (select max(l.decided_at) from public.altercpa_leads l where l.order_id = o.id and l.decided_at is not null) as any_decided_at
    from public.orders o
    join public.mex_parcels p on p.tracking_id = o.mex_tracking_id
    left join public.collabbox_documents d on d.doc_number = p.tracking_id
   where o.sale_source = 'altercpa'
     and p.account = 'natura'
     and p.series in (${SERIES.map(q).join(', ')})
),
cu as (
  select c.id,
         coalesce(case when c.card is not null then ${mk8("c.card ->> 'phone8'")} when cc.source = 'card' then ${mk8('cc.phone8')} end,
                  case when ${mk8('t.phone8')} is not null then t.phone8 end,
                  ${mk8('c.parcel_phone8')},
                  case when cc.source = 'parcel' and ${mk8('cc.phone8')} is not null then cc.phone8 end) as p8,
         coalesce(case when c.card is not null then nullif(btrim(c.card ->> 'skip_reason'), '') when cc.source = 'card' then cc.skip_reason end,
                  case when t.outcome = 'skipped' and t.reason in ('deceased', 'employee', 'company', 'operator_account', 'do_not_ship',
                                                                   'junk_name', 'wrong_number', 'test_name') then t.reason end,
                  case when c.card is null and cc.source is distinct from 'card' and t.komitent_id is null
                       then nullif(btrim(c.name_skip), '') end) as skip
    from c
    left join public.collabbox_customers cc on cc.komitent_id = c.komitent_id
    left join public.teleshop_import_customers t on t.komitent_id = c.komitent_id
)
select c.*, cu.p8 as writer_p8, cu.skip as writer_skip,
       (cu.p8 = any (public.report_excluded_phone8s())) as writer_test_phone,
       (select string_agg(o2.display_id || ' ' || o2.status::text, ', ' order by o2.created_at)
          from public.orders o2
         where cu.p8 is not null
           and right(regexp_replace(o2.customer_phone, '[^0-9]', '', 'g'), 8) = cu.p8
           and o2.id <> c.id
           and o2.external_source is distinct from 'collabbox'
           and o2.status::text in ('pending', 'take', 'call_again', 'confirmed', 'shipped', 'delivered', 'paid', 'returned')
           and o2.mex_tracking_id is null
           and o2.price > 0
           and not public.is_synthetic_product_name(o2.product_name)
           and o2.sale_source_detail is distinct from 'disposition'
           and o2.created_at >= c.doc_sale_at - interval '1 day'
           and o2.created_at <= c.doc_sale_at + interval '2 days'
           and (abs(round(o2.price * ${MKD_PER_EUR}) - c.amount_mkd) <= 3
                or abs(round(o2.price * ${MKD_PER_EUR}) + 150 - c.amount_mkd) <= 3
                or abs(round(o2.price * ${MKD_PER_EUR}) - round(coalesce(c.goods_mkd, c.amount_mkd, 0))) <= 3)) as writer_twins
  from c join cu on cu.id = c.id
 order by c.display_id`;

/** AlterCPA ledger decision times of the candidates' orders (for the "never cancelled" cancel date). */
export const isSale = (s) => SALE_STATUSES.includes(s);

/**
 * What the order was BEFORE the parcel made it a sale — owner 01.10.2026: "the status before the first MEX-driven
 * shipped / paid / returned"; history rows oldest first. The first history row INTO a sale status names the status
 * before it (its from_status). Was that a cancel / trash → restore it (dated by the history row that made it so, else
 * the AlterCPA decision, else the order's creation). Anything else — pending / confirmed / an order imported straight
 * as paid (no history) — it was never cancelled: it is cancelled now, dated by the AlterCPA decision (else confirmed_at,
 * else created_at), so the cancel lands on the lead's own day, not today.
 *   → { revertTo: 'cancelled' | 'trashed', kind: 'restored' | 'never_cancelled', at, before, firstSaleMove }
 */
export function preParcelState({ order, history = [], decidedAt = null }) {
  const rows = history.filter((h) => h.order_id === order.id);
  const idx = rows.findIndex((h) => isSale(h.to_status));
  const first = idx >= 0 ? rows[idx] : null;
  const before = first ? first.from_status ?? null : (rows.length ? rows[0].from_status ?? null : null);
  const dead = ['cancelled', 'trashed'].includes(before) ? before
    : (!first && ['cancelled', 'trashed'].includes(order.status) ? order.status : null);
  if (dead) {
    const upTo = idx >= 0 ? rows.slice(0, idx) : rows;
    const into = [...upTo].reverse().find((h) => h.to_status === dead);
    return { revertTo: dead, kind: 'restored', before: dead, at: isoOrNull(into?.changed_at ?? decidedAt ?? order.created_at), firstSaleMove: first };
  }
  return { revertTo: 'cancelled', kind: 'never_cancelled', before, at: isoOrNull(decidedAt ?? order.confirmed_at ?? order.created_at), firstSaleMove: first };
}

/** The writer's branch-E verdict for a parcel once the AlterCPA order no longer holds it (read-only prediction). */
export function writerPrediction(c) {
  if (!c.doc_number) return 'no_document';
  if (!['10050', '10036', '10106'].includes(String(c.doc_type_id)) || c.doc_role !== 'order') return `not_an_order_document (${c.doc_type_id}/${c.doc_role})`;
  if (c.is_storno || c.reversed_by) return 'storno_or_reversed';
  if (c.vanished_at) return 'vanished_in_collabbox';
  if (!c.has_payload) return 'no_payload';
  if (c.doc_outcome === 'replacement') return `replacement (${c.doc_reason})`;
  if (c.doc_outcome !== 'conflict' || !['parcel_held_by_other_order', 'tracking_named_by_other_order'].includes(c.doc_reason)) {
    return `document_outcome_${c.doc_outcome}${c.doc_reason ? `/${c.doc_reason}` : ''}`;
  }
  if (c.doc_is_order) return 'document_is_an_order';
  if (!c.lines_complete) return 'line_items_not_read';
  if (!(Number(c.amount_mkd) > 0)) return 'zero_value';
  if (!(Number(c.cod_mkd) > 0)) return 'replacement_cod0';
  if (c.web_claimed) return 'parcel_claimed_by_web_order';
  if (c.created_at_mex && c.doc_at && toMs(c.created_at_mex) < toMs(c.doc_at)) return 'parcel_predates_document';
  if (c.writer_skip) return `komitent_${c.writer_skip}`;
  if (!c.writer_p8) return 'no_phone';
  if (c.writer_test_phone) return 'test_phone';
  if (c.writer_twins) return `possible_twin_crm_sale (${c.writer_twins})`;
  return 'created';
}

/** The AlterCPA order's sale day in the cohort today (insights_sale_rows: sold_at, else the AlterCPA decision, else confirmed / created). */
export const saleDayBefore = (c) => c.sold_at ?? c.led_decided_at ?? c.confirmed_at ?? c.created_at;

/**
 * @returns {{ units, csv, lines, counts, changes, moves }}
 *   units  repair units for buildApplySql: one per parcel ({ unit, order_id, tracking, expect_status, set, history, note,
 *          new_note, evidence, line })
 *   moves  per unit: dept / person / day / COD before and after (the owner's money + people tables)
 */
export function classifyFolderDecides({ cands, history = [], hold = new Set(), runTag = 'dry-run', nowMs = Date.now(), today = fmtSkopjeDate(nowMs) }) {
  const units = [], csv = [], lines = [], moves = [];
  const changes = new Map();
  const counts = { candidates: cands.length, move: 0, manual: 0, excluded_payout: 0, restored_cancel: 0, restored_trash: 0, never_cancelled: 0 };
  for (const c of [...cands].sort((a, b) => String(a.display_id).localeCompare(String(b.display_id)))) {
    let why = '';
    const verdict = writerPrediction(c);
    if (hold.has(c.display_id)) why = 'held back with --hold';
    else if (c.in_payout) why = 'excluded_payout: the order is in agent_payout_items (payouts deferred by the owner)';
    else if (c.sale_source_detail === 'collabbox_leads') {
      why = `the holder is the order of collabBox LEADS document ${c.external_order_id} — its own 9110 parcel is not in the MEX register; a human decides`;
    } else if (!['paid', 'returned', 'shipped', 'delivered', 'cancelled', 'trashed'].includes(c.status)) why = `the AlterCPA order is ${c.status}`;
    else if (c.reg_owner && c.reg_owner !== c.id) why = 'the register links the parcel to another order';
    else if (Number(c.namers) !== 1) why = `${c.namers} orders name the parcel`;
    else if (verdict !== 'created') why = `the collabBox writer would answer: ${verdict}`;
    else if (Number(c.mex_status_id) === 8 && toMs(c.created_at_mex) < nowMs - STALE_LABEL_DAYS * 86_400_000) {
      // MEX 8 = за пакување: the writer would make a "to pack" order for a label never picked up — a human decides
      why = `the parcel has sat at MEX 8 (label only, за пакување) since ${fmtSkopjeDate(c.created_at_mex)} — the writer would make a to-pack order`;
    }
    const st = preParcelState({ order: c, history, decidedAt: c.any_decided_at });
    const action = why ? (c.in_payout ? 'excluded_payout' : 'manual') : 'move';
    if (action === 'move') counts.move++;
    else if (action === 'excluded_payout') counts.excluded_payout++;
    else counts.manual++;
    const docWord = `${TYPE_WORD[c.doc_type_id] || c.doc_type_id || '—'} ${c.doc_number || ''}`.trim();
    const target = ['cancelled', 'trashed'].includes(c.status) && st.kind === 'restored' && st.revertTo === c.status ? c.status : st.revertTo;
    csv.push({
      order: c.display_id, action, why, status_now: c.status, back_to: action === 'move' ? target : '', how: action === 'move' ? st.kind : '',
      back_dated: action === 'move' ? fmtSkopje(st.at) : '', tracking: c.tracking, series: c.series,
      parcel: `${c.mex_status_id} ${c.mex_status_name || ''}`.trim(), cod_mkd: c.cod_mkd, parcel_created: fmtSkopje(c.created_at_mex),
      lead_created: fmtSkopje(c.created_at), gap_days: c.doc_at ? ((toMs(c.doc_at) - toMs(c.created_at)) / 86_400_000).toFixed(1) : '',
      document: docWord, doc_day: fmtSkopje(c.doc_at), author: c.author || '', dept_before: DEPT_WORD[c.dept_before] || c.dept_before,
      dept_after: DEPT_WORD[c.dept_after] || c.dept_after || '', link_method: c.link_method || '', writer_verdict: verdict,
    });
    const line = planLine(c.id, action === 'move' ? 'FD_move' : action, action === 'move' ? `${c.status}>${target}:${c.doc_type_id}` : '', c.tracking);
    lines.push(line);
    if (action !== 'move') continue;
    if (st.kind === 'never_cancelled') counts.never_cancelled++;
    else if (st.revertTo === 'trashed') counts.restored_trash++;
    else counts.restored_cancel++;

    const deptAfter = DEPT_WORD[c.dept_after] || c.dept_after;
    const reason = `the sale is ${deptAfter} — collabBox ${TYPE_WORD[c.doc_type_id] || c.doc_type_id} document ${c.doc_number}` +
      ` (${fmtSkopjeDate(c.doc_at)}, ${fmtMkd(c.amount_mkd)} ден${c.author ? `, ${c.author}` : ''}) (owner 01.10.2026: the collabBox folder decides)`;
    const set = target === c.status
      ? { mex_tracking_id: null, mex_account: null, mex_status_id: null, mex_cod_mkd: null, mex_delivered_at: null,
        mex_returned_at: null, mex_last_update_at: null }
      : revertDispositionSet({ revertTo: target, at: st.at,
        cancelNote: st.kind === 'restored'
          ? `restored ${today}: its cancel was wiped when MEX parcel ${c.tracking} was attached; ${reason}`
          : `cancelled ${today} by the system: ${reason}; this AlterCPA lead has no parcel of its own`,
        trashNote: trashParkNote(c.tracking, { status_id: c.mex_status_id, status_name: c.mex_status_name }) });
    if (target !== c.status) changes.set(c.id, target === 'trashed' ? { status: 'trashed', trashed_at: st.at, trash_reason: 'not_reachable' } : { status: 'cancelled' });
    const note = `Repair ${KEY} (run ${runTag}): MEX NATURA parcel ${c.tracking} (${c.mex_status_id} ${c.mex_status_name || ''}, COD ${fmtMkd(c.cod_mkd)} ден) ` +
      `is not this AlterCPA order's sale — ${reason}. The parcel goes to that document, which becomes its own order credited to its author. ` +
      (target === c.status ? `Status ${c.status} is unchanged.`
        : st.kind === 'restored' ? `This order goes back to ${target}, as before the parcel made it a sale${target === 'trashed' ? ' (not_reachable, the 21-day park)' : ' (reason "other")'}.`
          : `It was never cancelled (${st.before ?? 'imported as ' + c.status}), so it is cancelled by the system (reason "other"), dated ${fmtSkopje(st.at)}.`) +
      ' Nothing was sent to AlterCPA.';
    const newNote = `Repair ${KEY} (run ${runTag}): this order was made from collabBox ${TYPE_WORD[c.doc_type_id] || c.doc_type_id} document ${c.doc_number} ` +
      `by the collabBox writer — its MEX parcel had been attached to AlterCPA order ${c.display_id}, which is not this sale ` +
      `(owner 01.10.2026: the collabBox folder decides the department — ${deptAfter}, seller = the document's author). Nothing was sent to AlterCPA.`;
    units.push({
      unit: `fd:${c.tracking}`, order_id: c.id, display_id: c.display_id, tracking: c.tracking, expect_status: c.status, set,
      history: target !== c.status ? { from: c.status, to: target } : null, note, new_note: newNote, line,
      evidence: { key: KEY, order: c.display_id, tracking: c.tracking, doc: c.doc_number, doc_type: c.doc_type_id, back_to: target,
        how: st.kind, back_dated: st.at, first_sale_move: st.firstSaleMove ? `${st.firstSaleMove.from_status ?? '∅'}>${st.firstSaleMove.to_status} ${st.firstSaleMove.changed_by_name ?? ''}`.trim() : null,
        dept_before: c.dept_before, dept_after: c.dept_after, author: c.author, author_person_id: c.author_person_id,
        seller_before: c.sold_by_person_id, cod_mkd: c.cod_mkd, parcel_status: c.mex_status_id },
    });
    moves.push({
      tracking: c.tracking, order: c.display_id, cod: Number(c.cod_mkd) || 0, status_id: Number(c.mex_status_id),
      dept_before: c.dept_before, dept_after: c.dept_after, person_before: c.sold_by_person_id ?? null, person_after: c.author_person_id ?? null,
      day_before: saleDayBefore(c), day_after: c.doc_sale_at,
    });
  }
  return { units, csv, lines, counts, changes, moves };
}

/** The money a parcel brings to its department's cohort total (paid / with the courier / returned all count — MEX decides). */
const counted = (m) => m.cod > 0;

/** Per department: what leaves and what arrives (orders, ден) — for the whole set and for one Skopje month. */
export function deptMoves(moves, month = null) {
  const inMonth = (v) => !month || new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Skopje', year: 'numeric', month: '2-digit' }).format(new Date(v)) === month;
  const out = {};
  const add = (d, k, n, mkd) => { out[d] ??= { lose: 0, lose_mkd: 0, gain: 0, gain_mkd: 0 }; out[d][k] += n; out[d][`${k}_mkd`] += mkd; };
  for (const m of moves.filter(counted)) {
    if (inMonth(m.day_before)) add(m.dept_before, 'lose', 1, m.cod);
    if (inMonth(m.day_after)) add(m.dept_after, 'gain', 1, m.cod);
  }
  return Object.entries(out).map(([dept, v]) => ({ department: DEPT_WORD[dept] || dept, '−orders': v.lose, '−ден': fmtMkd(v.lose_mkd),
    '+orders': v.gain, '+ден': fmtMkd(v.gain_mkd), 'net ден': fmtMkd(v.gain_mkd - v.lose_mkd) }));
}

/** Per person: the sales (and ден) each loses / gains. `names` maps person id → display name. */
export function personMoves(moves, names = new Map()) {
  const out = {};
  const who = (id) => (id ? names.get(id) ?? id : '(nobody credited)');
  for (const m of moves.filter(counted)) {
    const a = who(m.person_before), b = who(m.person_after);
    out[a] ??= { lose: 0, lose_mkd: 0, gain: 0, gain_mkd: 0 };
    out[b] ??= { lose: 0, lose_mkd: 0, gain: 0, gain_mkd: 0 };
    if (a === b) continue;
    out[a].lose++; out[a].lose_mkd += m.cod;
    out[b].gain++; out[b].gain_mkd += m.cod;
  }
  return Object.entries(out).filter(([, v]) => v.lose || v.gain)
    .sort((x, y) => (y[1].gain_mkd - y[1].lose_mkd) - (x[1].gain_mkd - x[1].lose_mkd))
    .map(([person, v]) => ({ person, '−sales': v.lose, '−ден': fmtMkd(v.lose_mkd), '+sales': v.gain, '+ден': fmtMkd(v.gain_mkd), 'net ден': fmtMkd(v.gain_mkd - v.lose_mkd) }));
}

// ─── the apply: one unit = one sub-transaction ──────────────────────────────────────────────────────────────

/** The revert columns every unit may set (revertDispositionSet's shape, or only the MEX copy for a dead holder). */
export const REVERT_COLUMNS = Object.freeze(['status', 'cancelled_at', 'cancellation_reason', 'cancellation_reason_notes',
  'trashed_at', 'trash_reason', 'trash_reason_notes', 'paid_at', 'returned_at', 'shipped_at', 'mex_tracking_id', 'mex_account',
  'mex_status_id', 'mex_cod_mkd', 'mex_delivered_at', 'mex_returned_at', 'mex_last_update_at', 'paid_basis']);

/** "col = CASE WHEN set ? 'col' THEN (set->>'col')::type ELSE col END" — only the keys a unit names change. */
function setClause(typeMap) {
  return REVERT_COLUMNS.filter((c) => c !== 'status').map((c) => {
    const t = typeMap[c];
    if (!t) throw new Error(`orders.${c} does not exist`);
    return `${c} = CASE WHEN r.set_cols ? '${c}' THEN (r.set_cols ->> '${c}')::${t} ELSE o2.${c} END`;
  }).join(',\n             ');
}

/**
 * ONE chunk = ONE API call = ONE transaction (the kit's buildChunkSql contract: no explicit BEGIN, SET LOCAL holds,
 * any error outside a unit rolls the chunk back). Inside, a DO block works unit by unit, each in its own
 * sub-transaction: re-check → ledger before → revert the AlterCPA order + unlink the register row → order_history +
 * note → ledger after → the LIVE writer re-applies the document (it must answer 'created' with the parcel on the new
 * order) → the new order's note → the ledger row's evidence names it. A unit that fails at ANY step is rolled back
 * whole and listed (`ok = false`).
 */
export function buildApplySql({ runId, syncRun, units, typeMap }) {
  if (!units.length) throw new Error('no units');
  for (const u of units) if (u.set?.status === 'confirmed') throw new Error(`unit ${u.unit} would be set to confirmed — refusing`);
  const values = units.map((u) => `(${[q(u.unit), qUuid(u.order_id), q(u.tracking), q(u.expect_status), qJson(u.set || {}),
    q(u.history?.from ?? null), q(u.history?.to ?? null), q(u.note), q(u.new_note), qJson({ ...u.evidence, line: u.line, unit: u.unit })].join(', ')})`);
  const snap = snapshotSql('x', 'mp.tracking_id = r.tracking');
  return `
set local elyon.bulk_repair = 'on';
set local elyon.keep_updated_at = 'on';
set local statement_timeout = '170s';
set local lock_timeout = '20s';
set local timezone = 'UTC';
create temp table _fd (unit text primary key, order_id uuid not null, tracking text not null, expect_status text not null,
  set_cols jsonb not null, hist_from text, hist_to text, note text, new_note text, evidence jsonb not null) on commit drop;
insert into _fd values
${values.join(',\n')};
create temp table _fd_out (unit text, order_id uuid, tracking text, ok boolean, why text, new_order uuid, new_display text) on commit drop;
do $fd$
declare
  r record;
  o public.orders%rowtype;
  p public.mex_parcels%rowtype;
  d public.collabbox_documents%rowtype;
  rid bigint;
  res jsonb;
  e jsonb;
  nid uuid;
  ndisp text;
  dbefore jsonb;
begin
  for r in select * from _fd order by unit loop
    begin
      select * into o from public.orders where id = r.order_id for update;
      select * into p from public.mex_parcels where tracking_id = r.tracking for update;
      select * into d from public.collabbox_documents where doc_number = r.tracking for update;
      if o.id is null or o.status::text is distinct from r.expect_status or o.mex_tracking_id is distinct from r.tracking
         or (p.order_id is not null and p.order_id <> r.order_id)
         or exists (select 1 from public.orders x where x.mex_tracking_id = r.tracking and x.id <> r.order_id)
         or exists (select 1 from public.orders x where x.external_source = 'collabbox' and x.external_order_id = r.tracking)
         or d.doc_number is null or d.outcome is distinct from 'conflict'
         or exists (select 1 from public.agent_payout_items ap where ap.order_id = r.order_id) then
        insert into _fd_out values (r.unit, r.order_id, r.tracking, false, 'moved since the dry run', null, null);
        continue;
      end if;
      dbefore := jsonb_build_object('outcome', d.outcome, 'reason', d.reason, 'order_id', d.order_id,
                   'related_order_id', d.related_order_id, 'credit', d.credit, 'flags', to_jsonb(d.flags),
                   'planned_status', d.planned_status, 'paid_basis', d.paid_basis, 'price_eur', d.price_eur,
                   'created_by_sync', d.created_by_sync, 'created_run_id', d.created_run_id);
      insert into public.data_repair_rows (run_id, order_id, rule, before, evidence)
      select ${qUuid(runId)}, x.id, 'FD_revert', ${snap}, r.evidence from public.orders x where x.id = r.order_id
      returning id into rid;

      -- 1. the AlterCPA order: back to what it was before the parcel made it a sale; the MEX copy cleared
      update public.orders o2
         set status = CASE WHEN r.set_cols ? 'status' THEN (r.set_cols ->> 'status')::public.order_status ELSE o2.status END,
             ${setClause(typeMap)}
       where o2.id = r.order_id;
      update public.mex_parcels set order_id = null, link_method = null, linked_at = null
       where tracking_id = r.tracking and order_id = r.order_id;
      if r.hist_to is not null then
        insert into public.order_history (order_id, from_status, to_status, changed_by, changed_by_name)
        values (r.order_id, r.hist_from::public.order_status, r.hist_to::public.order_status, null, ${q(ACTOR)});
      end if;
      insert into public.order_notes (order_id, text, author_id, author_name) values (r.order_id, r.note, null, ${q(ACTOR)});
      update public.data_repair_rows dr set after = (select ${snap} from public.orders x where x.id = r.order_id) where dr.id = rid;

      -- 2. the document becomes its own order — through the LIVE writer (collabbox_apply_one branch E)
      res := public.collabbox_apply_documents(${qUuid(syncRun)}, jsonb_build_array(d.payload), false);
      e := res -> 'results' -> 0;
      if e is null or e ->> 'outcome' is distinct from 'created' or (e ->> 'order_id') is null then
        raise exception 'the collabBox writer answered % / %', coalesce(e ->> 'outcome', 'nothing'), coalesce(e ->> 'reason', '');
      end if;
      nid := (e ->> 'order_id')::uuid;
      if not exists (select 1 from public.mex_parcels where tracking_id = r.tracking and order_id = nid) then
        raise exception 'the parcel is not on the new order';
      end if;
      select display_id into ndisp from public.orders where id = nid;
      insert into public.order_notes (order_id, text, author_id, author_name) values (nid, r.new_note, null, ${q(ACTOR)});
      update public.data_repair_rows dr
         set evidence = dr.evidence || jsonb_build_object('created_order', nid, 'created_display', ndisp, 'writer', e,
                                                          'doc_before', dbefore, 'sync_run', ${q(syncRun)})
       where dr.id = rid;
      insert into _fd_out values (r.unit, r.order_id, r.tracking, true, null, nid, ndisp);
    exception when others then
      insert into _fd_out values (r.unit, r.order_id, r.tracking, false, left(sqlerrm, 300), null, null);
    end;
  end loop;
end $fd$;
select (select count(*) from _fd)::int as planned, (select count(*) from _fd_out where ok)::int as applied,
       (select coalesce(jsonb_agg(jsonb_build_object('unit', unit, 'order', new_display)), '[]'::jsonb) from _fd_out where ok) as made,
       (select coalesce(jsonb_agg(jsonb_build_object('unit', unit, 'why', why)), '[]'::jsonb) from _fd_out where not ok) as skipped;`;
}

// ─── the rollback: the made order deleted, the document's ledger row back, the AlterCPA order + register back ─────

/** Which units of a run can be undone: the new order still exactly as the writer made it, the AlterCPA order still = after. */
export const rollbackCheckSql = (runId) => `select x.id, x.order_id, x.evidence ->> 'tracking' as tracking,
       x.evidence ->> 'created_display' as created_display, o.display_id,
       (${orderSnapshotSql('o')} = (x.after - 'parcels')) as holder_same,
       (n.id is not null and n.external_source = 'collabbox' and n.external_order_id = x.evidence ->> 'tracking'
        and n.mex_tracking_id is not distinct from x.evidence ->> 'tracking'
        and not exists (select 1 from public.agent_payout_items ap where ap.order_id = n.id)
        and not exists (select 1 from public.order_history h where h.order_id = n.id and h.changed_by is not null)
        and not exists (select 1 from public.orders dd where dd.duplicated_from = n.id)) as made_same
  from public.data_repair_rows x
  join public.orders o on o.id = x.order_id
  left join public.orders n on n.id = (x.evidence ->> 'created_order')::uuid
 where x.run_id = ${qUuid(runId)} and x.rule = 'FD_revert' and x.after is not null and x.evidence ? 'created_order'`;

/**
 * The undo, ONE transaction; per unit a sub-transaction: the order the writer made is deleted (items / notes / history
 * go with it), the collabBox ledger row goes back to its 'conflict', the AlterCPA order gets every SNAP column of
 * `before` back and the register row its old link. Only units where BOTH orders are still as the run left them.
 */
export function buildRollbackSql({ runId, rbRunId, actor, typeMap }) {
  const restore = SNAP_COLUMNS.filter((c) => c !== 'status').map((c) => `${c} = (r.before ->> '${c}')::${typeMap[c]}`).join(',\n             ');
  return `
set local elyon.bulk_repair = 'on';
set local elyon.keep_updated_at = 'on';
set local statement_timeout = '170s';
set local lock_timeout = '20s';
set local timezone = 'UTC';
create temp table _rb_out (order_id uuid, tracking text, ok boolean, why text) on commit drop;
do $rb$
declare
  r record;
  n public.orders%rowtype;
  snap jsonb;
  bp jsonb;
begin
  for r in select x.order_id, x.before, x.after, x.evidence from public.data_repair_rows x
            where x.run_id = ${qUuid(runId)} and x.rule = 'FD_revert' and x.after is not null and x.evidence ? 'created_order'
            order by x.id loop
    begin
      if not exists (select 1 from public.orders o where o.id = r.order_id
                       and jsonb_build_object(${SNAP_COLUMNS.map((c) => `'${c}', o.${c}`).join(', ')}) = (r.after - 'parcels')) then
        insert into _rb_out values (r.order_id, r.evidence ->> 'tracking', false, 'the AlterCPA order changed since the run');
        continue;
      end if;
      select * into n from public.orders where id = (r.evidence ->> 'created_order')::uuid for update;
      if n.id is null or n.external_source is distinct from 'collabbox' or n.external_order_id is distinct from (r.evidence ->> 'tracking')
         or n.mex_tracking_id is distinct from (r.evidence ->> 'tracking')
         or exists (select 1 from public.agent_payout_items ap where ap.order_id = n.id)
         or exists (select 1 from public.order_history h where h.order_id = n.id and h.changed_by is not null)
         or exists (select 1 from public.orders dd where dd.duplicated_from = n.id) then
        insert into _rb_out values (r.order_id, r.evidence ->> 'tracking', false, 'the order the writer made changed since the run');
        continue;
      end if;
      snap := jsonb_build_object('order', to_jsonb(n),
                'items', (select coalesce(jsonb_agg(to_jsonb(i)), '[]'::jsonb) from public.order_items i where i.order_id = n.id),
                'notes', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.order_notes t where t.order_id = n.id),
                'history', (select coalesce(jsonb_agg(to_jsonb(h)), '[]'::jsonb) from public.order_history h where h.order_id = n.id));
      delete from public.orders where id = n.id;
      update public.collabbox_documents d
         set outcome = r.evidence -> 'doc_before' ->> 'outcome', reason = r.evidence -> 'doc_before' ->> 'reason',
             order_id = nullif(r.evidence -> 'doc_before' ->> 'order_id', '')::uuid,
             related_order_id = nullif(r.evidence -> 'doc_before' ->> 'related_order_id', '')::uuid,
             credit = r.evidence -> 'doc_before' ->> 'credit',
             flags = coalesce(array(select jsonb_array_elements_text(r.evidence -> 'doc_before' -> 'flags')), '{}'::text[]),
             planned_status = r.evidence -> 'doc_before' ->> 'planned_status', paid_basis = r.evidence -> 'doc_before' ->> 'paid_basis',
             price_eur = (r.evidence -> 'doc_before' ->> 'price_eur')::numeric,
             created_by_sync = coalesce((r.evidence -> 'doc_before' ->> 'created_by_sync')::boolean, false),
             created_run_id = nullif(r.evidence -> 'doc_before' ->> 'created_run_id', '')::uuid, updated_at = now()
       where d.doc_number = r.evidence ->> 'tracking';
      -- the AlterCPA order: status first (the NULL-only timestamp triggers), then every other column of before
      update public.orders o2 set status = (r.before ->> 'status')::public.order_status
       where o2.id = r.order_id and o2.status::text is distinct from r.before ->> 'status';
      update public.orders o2 set
             ${restore}
       where o2.id = r.order_id;
      for bp in select x from jsonb_array_elements(r.before -> 'parcels') x loop
        update public.mex_parcels mp
           set order_id = nullif(bp ->> 'order_id', '')::uuid, link_method = bp ->> 'link_method',
               linked_at = (bp ->> 'linked_at')::timestamptz
         where mp.tracking_id = bp ->> 'tracking_id';
      end loop;
      insert into public.order_history (order_id, from_status, to_status, changed_by, changed_by_name)
      select r.order_id, (r.after ->> 'status')::public.order_status, (r.before ->> 'status')::public.order_status, null, ${q(`System (rollback:${KEY})`)}
       where r.after ->> 'status' is distinct from r.before ->> 'status';
      insert into public.order_notes (order_id, text, author_id, author_name)
      values (r.order_id, ${q(`Rollback of repair ${KEY} (run ${String(runId).slice(0, 8)}): this order holds its MEX parcel again; the order the collabBox writer made from the document was removed.`)}, null, ${q(`System (rollback:${KEY})`)});
      insert into public.data_repair_rows (run_id, order_id, rule, before, after, evidence)
      values (${qUuid(rbRunId)}, r.order_id, 'rollback:FD_revert', r.after, r.before,
              jsonb_build_object('rolled_back_run', ${q(runId)}, 'deleted_order', snap, 'tracking', r.evidence ->> 'tracking',
                                 'line', r.order_id::text || ':rollback:' || coalesce(r.before ->> 'status', '') || ':' || (r.evidence ->> 'tracking')));
      insert into _rb_out values (r.order_id, r.evidence ->> 'tracking', true, null);
    exception when others then
      insert into _rb_out values (r.order_id, r.evidence ->> 'tracking', false, left(sqlerrm, 300));
    end;
  end loop;
end $rb$;
insert into public.audit_log (actor_id, actor_email, action, target_type, target_id, target_name, payload)
values (${qUuid(actor.id)}, ${q(actor.email)}, 'data_repair.rollback', 'data_repair_run', ${q(runId)}, ${q(KEY)},
        jsonb_build_object('rollback_run', ${q(rbRunId)}, 'restored', (select count(*) from _rb_out where ok),
                           'left_alone', (select count(*) from _rb_out where not ok)));
select (select count(*) from _rb_out)::int as candidates, (select count(*) from _rb_out where ok)::int as restored,
       (select coalesce(jsonb_agg(jsonb_build_object('tracking', tracking, 'why', why)), '[]'::jsonb) from _rb_out where not ok) as skipped;`;
}
