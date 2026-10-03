import { describe, it, expect } from 'vitest';
// Owner's cancel rules for the history up to 01.08.2026 (hand-over 03.10.2026): paid + no MEX + no collabBox = cancelled;
// a duplicate is cancelled as a duplicate; a label MEX never picked up is no shipment. Pinned here: the rules, the
// system cancel dated on the order's OWN day (never today — the 14-day Current Cancels pen), and what stops a cancel.
import { KEY, DUPLICATE_DAYS, classify } from '../../scripts/repair-history-cancels.mjs';

const row = (over: Record<string, unknown> = {}) => ({
  order_id: 'a', audit_status: 'paid', audit_verdict: 'SET_CANCELLED', tracking: '', mex_status: '', mex_created: '', match: '',
  duplicate_of: '', own_doc: '', own_doc_flag: '', own_doc_at: '', rescue_kind: '', rescue_ref: '', rescue_state: '', ...over,
});
const order = (over: Record<string, unknown> = {}) => ({
  id: 'a', display_id: 'ORD-1', status: 'paid', mex_tracking_id: null, paid_basis: null, price: 24.23,
  created_at: '2026-06-10T09:00:00Z', confirmed_at: '2026-06-10T12:00:00Z', sold_at: '2026-06-10T12:00:00Z', ...over,
});
const twin = (over: Record<string, unknown> = {}) => ({ id: 'b', display_id: 'ORD-2', status: 'paid', created_at: '2026-06-11T09:00:00Z', mex_tracking_id: '002-9110-7/2026', ...over });

describe('history cancels — paid with no proof of a shipment', () => {
  it('no MEX parcel and no collabBox document: a system cancel dated on the order\'s own day', () => {
    expect(KEY).toBe('history-cancels');
    const c = classify(row(), order());
    expect(c.rule).toBe('no_proof_cancel');
    expect(c.set).toMatchObject({ status: 'cancelled', cancelled_at: '2026-06-10T12:00:00Z', cancellation_reason: 'other', paid_at: null, paid_basis: null });
    expect(c.set.cancellation_reason_notes).toContain('Нема MEX пратка');
    expect(c.history).toEqual({ from: 'paid', to: 'cancelled' });
    expect(Object.keys(c.set)).not.toContain('sold_at');
    expect(classify(row(), order({ confirmed_at: null })).set.cancelled_at).toBe('2026-06-10T09:00:00Z');
  });

  it('never cancelled: a name match, a proven basis, a held parcel, a moved status, a payout', () => {
    expect(classify(row({ rescue_kind: 'mex', rescue_ref: 'x' }), order())).toEqual({ skip: 'name_match_mex' });
    expect(classify(row(), order({ paid_basis: 'operator_ruling' }))).toEqual({ skip: 'has_basis_operator_ruling' });
    expect(classify(row(), order({ mex_tracking_id: '002-9110-1/2026' }))).toEqual({ skip: 'holds_mex_parcel' });
    expect(classify(row(), order({ status: 'returned' }))).toEqual({ skip: 'moved_paid_to_returned' });
    expect(classify(row(), order(), { payout: new Set(['a']) })).toEqual({ skip: 'in_agent_payout' });
    expect(classify(row(), undefined)).toEqual({ skip: 'order_gone' });
  });

  it('a duplicate: the order that holds the parcel is ≤ 3 days away → duplicate_order; further → no proof of its own', () => {
    expect(DUPLICATE_DAYS).toBe(3);
    const r = row({ audit_verdict: 'SET_CANCELLED_DUPLICATE', duplicate_of: 'ORD-2' });
    const d = classify(r, order(), { twin: twin() });
    expect(d.rule).toBe('duplicate_cancel');
    expect(d.set.cancellation_reason).toBe('duplicate_order');
    expect(d.note).toContain('ORD-2');
    const far = classify(r, order(), { twin: twin({ created_at: '2026-06-16T09:00:00Z' }) });
    expect(far.rule).toBe('no_proof_cancel_twin');
    expect(far.set.cancellation_reason).toBe('other');
    expect(classify(r, order(), { twin: null })).toEqual({ skip: 'twin_order_gone' });
  });

  it('a "duplicate" with a document of its own that another courier carried is a sale of its own — judged by the flag', () => {
    const r = row({ audit_verdict: 'SET_CANCELLED_DUPLICATE', duplicate_of: 'ORD-2', own_doc: '001-10111-9/2025', own_doc_at: '2025-11-10T12:00:00' });
    const p = classify({ ...r, own_doc_flag: 'delivered' }, order(), { twin: twin() });
    expect(p.rule).toBe('dup_own_doc_proven');
    expect(p.set).toEqual({ paid_basis: 'operator_ruling' });
    expect(classify({ ...r, own_doc_flag: 'delivered' }, order({ paid_basis: 'operator_ruling' }), { twin: twin() })).toEqual({ skip: 'already_proven' });
    const back = classify({ ...r, own_doc_flag: 'returned' }, order(), { twin: twin() });
    expect(back.rule).toBe('dup_own_doc_returned');
    expect(back.set).toEqual({ status: 'returned', returned_at: '2025-11-10T11:00:00.000Z', paid_at: null, paid_basis: null });
    expect(classify({ ...r, own_doc_flag: '' }, order(), { twin: twin() })).toEqual({ skip: 'own_document_no_flag' });
  });

  it('a label MEX never picked up: cancelled, the held label stays the guard; a later delivery stops it', () => {
    const r = row({ audit_verdict: 'SET_CANCELLED_LABEL_ONLY', audit_status: 'shipped', tracking: '002-9102-5/2026', mex_status: 'Shipment created' });
    const c = classify(r, order({ status: 'shipped', mex_tracking_id: '002-9102-5/2026' }), { reg: { order_id: 'a', status_id: 8 } });
    expect(c.rule).toBe('label_only_cancel');
    expect(c.expectTracking).toBe('002-9102-5/2026');
    expect(c.set).toMatchObject({ status: 'cancelled', cancellation_reason: 'other', shipped_at: null });
    expect(c.history).toEqual({ from: 'shipped', to: 'cancelled' });
    expect(classify(r, order({ status: 'shipped' }), { reg: { order_id: 'a', status_id: 4 } })).toEqual({ skip: 'register_status_4' });
    expect(classify(r, order({ status: 'shipped' }), { reg: { order_id: 'z', status_id: 8 } })).toEqual({ skip: 'parcel_held_by_another_order' });
    expect(classify({ ...r, rescue_kind: 'mex' }, order({ status: 'shipped' }))).toEqual({ skip: 'delivered_later' });
    expect(classify({ ...r, mex_status: 'Delivered' }, order({ status: 'shipped' }))).toEqual({ skip: 'not_a_label' });
  });
});
