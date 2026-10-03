import { describe, it, expect } from 'vitest';
// Owner, Mile, 03.10.2026: the parcels ANOTHER courier carried (Kolporter Post 2024, Eko Logistik 10.2025–01.2026,
// Jon Express 05–06.2026) are judged by collabBox's own "Delivered" / "Return to sender" flag — only for orders that
// hold NO MEX parcel. Pinned here: the four rules, what is never touched (a MEX parcel, a moved status, a verdict where
// MEX has something, twins, duplicates, a sale stamp on another day), the re-send, and the Skopje wall-clock conversion.
import { KEY, BASIS, classify, finalOutcome, skopjeWallToIso, parseCsv } from '../../scripts/repair-courier-outcomes.mjs';

const DAY = 86_400_000;
const row = (over: Record<string, unknown> = {}) => ({
  order_id: 'a', doc: '001-10111-77/2025', doc_type: 'Нарачка LEADS', doc_at: '2025-11-10T12:00:00', courier: 'Eko Logistik',
  courier_mk: 'Еко Логистик', match: 'phone+date', audit_verdict: 'OK_DEAD', audit_status: 'cancelled', outcome: 'delivered',
  resend_doc: '', resend_at: '', resend_outcome: '', resend_via: '', ...over,
});
const order = (over: Record<string, unknown> = {}) => ({
  id: 'a', display_id: 'ORD-1', status: 'cancelled', mex_tracking_id: null, paid_basis: null, price: 24.23,
  customer_phone: '+38970111222', created_at: '2025-11-09T09:00:00Z', sold_at: null, confirmed_at: null,
  cancellation_reason: 'changed_mind', cancellation_reason_notes: null, trash_reason: null, trash_reason_notes: null, ...over,
});
const ctx = (over: Record<string, unknown> = {}) => ({
  owned: new Set<string>(), inputIds: new Set(['a']), siblings: new Map<string, unknown[]>(), payout: new Set<string>(), ...over,
});
const sibling = (over: Record<string, unknown> = {}) => ({
  id: 'b', display_id: 'ORD-2', status: 'paid', mex_tracking_id: null, price: 40, created_at: '2025-11-01T10:00:00Z',
  customer_phone: '+38970111222', ...over,
});
const withSibling = (s: unknown) => ctx({ siblings: new Map([['70111222', [s]]]) });

describe('courier outcomes — the collabBox flag decides only where MEX carried nothing', () => {
  it('the key, the basis and the Skopje wall clock (winter +1, summer +2)', () => {
    expect(KEY).toBe('courier-outcomes');
    expect(BASIS).toBe('operator_ruling');
    expect(skopjeWallToIso('2024-01-30T20:16:25')).toBe('2024-01-30T19:16:25.000Z');
    expect(skopjeWallToIso('2026-05-12T10:00:00')).toBe('2026-05-12T08:00:00.000Z');
    expect(skopjeWallToIso('not a time')).toBeNull();
  });

  it('a cancelled lead whose parcel was delivered is a sale: paid at the dispatch time, cancel fields cleared', () => {
    const c = classify(row(), order(), ctx());
    expect(c.rule).toBe('dead_paid');
    expect(c.set).toEqual({
      cancellation_reason: null, cancellation_reason_notes: null, cancelled_at: null,
      trash_reason: null, trash_reason_notes: null, trashed_at: null,
      status: 'paid', paid_at: '2025-11-10T11:00:00.000Z', returned_at: null, paid_basis: 'operator_ruling',
    });
    expect(c.history).toEqual({ from: 'cancelled', to: 'paid' });
    expect(c.note).toContain('001-10111-77/2025');
    expect(c.note).toContain('Еко Логистик');
    // never the sale stamps — a written confirmed_at / sold_at would date the sale today
    expect(Object.keys(c.set)).not.toEqual(expect.arrayContaining(['sold_at', 'confirmed_at', 'price']));
  });

  it('a returned parcel: a dead order becomes returned, a paid one loses its paid', () => {
    const dead = classify(row({ outcome: 'returned', audit_status: 'trashed' }), order({ status: 'trashed', trash_reason: 'wrong_person', cancellation_reason: null }), ctx());
    expect(dead.rule).toBe('dead_returned');
    expect(dead.set).toMatchObject({ status: 'returned', returned_at: '2025-11-10T11:00:00.000Z', paid_at: null, paid_basis: null, trash_reason: null });
    const paid = classify(row({ outcome: 'returned', audit_status: 'paid', audit_verdict: 'PAID_UNVERIFIABLE_NON_MEX_PERIOD' }),
      order({ status: 'paid', paid_basis: 'legacy_import' }), ctx());
    expect(paid.rule).toBe('paid_returned');
    expect(paid.set).toEqual({ status: 'returned', returned_at: '2025-11-10T11:00:00.000Z', paid_at: null, paid_basis: null });
    expect(paid.history).toEqual({ from: 'paid', to: 'returned' });
  });

  it('a paid order whose parcel was delivered only gets the proof — its status is not in the UPDATE', () => {
    const r = row({ audit_status: 'paid', audit_verdict: 'PAID_UNVERIFIABLE_NON_MEX_PERIOD' });
    const c = classify(r, order({ status: 'paid' }), ctx());
    expect(c.rule).toBe('proven');
    expect(c.set).toEqual({ paid_basis: 'operator_ruling' });
    expect(c.history).toBeNull();
    expect(classify(r, order({ status: 'paid', paid_basis: 'operator_ruling' }), ctx())).toEqual({ skip: 'already_proven' });
    expect(classify(r, order({ status: 'paid', paid_basis: 'mex' }), ctx())).toEqual({ skip: 'already_proven' });
  });

  it('returned, then re-sent and delivered = delivered by the re-send document; an open re-send decides nothing', () => {
    const back = row({ outcome: 'returned', resend_doc: '001-10111-99/2025', resend_at: '2025-11-20T09:00:00', resend_outcome: 'delivered', resend_via: 'mex' });
    expect(finalOutcome(back)).toEqual({ outcome: 'delivered', doc: '001-10111-99/2025', at: '2025-11-20T09:00:00', resend: true });
    const c = classify(back, order(), ctx());
    expect(c.rule).toBe('dead_paid');
    expect(c.set.paid_at).toBe('2025-11-20T08:00:00.000Z');
    expect(c.proofDoc).toBe('001-10111-99/2025');
    expect(finalOutcome(row({ outcome: 'returned', resend_doc: 'x', resend_outcome: 'open' }))).toEqual({ skip: 'resend_open' });
    expect(finalOutcome(row({ outcome: 'returned', resend_doc: 'x', resend_outcome: 'returned' })).outcome).toBe('returned');
    expect(finalOutcome(row({ outcome: 'neither' }))).toEqual({ skip: 'no_flag' });
  });

  it('MEX decides wherever it has something: a held parcel, a verdict with MEX proof, a moved status are left alone', () => {
    expect(classify(row(), order({ mex_tracking_id: '002-9110-1/2026' }), ctx())).toEqual({ skip: 'holds_mex_parcel' });
    expect(classify(row({ audit_verdict: 'OK_PAID_PROVEN' }), order(), ctx())).toEqual({ skip: 'audit_OK_PAID_PROVEN' });
    expect(classify(row({ audit_verdict: 'SET_CANCELLED_DUPLICATE' }), order(), ctx())).toEqual({ skip: 'audit_SET_CANCELLED_DUPLICATE' });
    expect(classify(row(), order({ status: 'paid' }), ctx())).toEqual({ skip: 'moved_cancelled_to_paid' });
    expect(classify(row(), undefined, ctx())).toEqual({ skip: 'order_gone' });
    expect(classify(row(), order(), ctx({ payout: new Set(['a']) }))).toEqual({ skip: 'in_agent_payout' });
  });

  it('never a twin: a living sale on the phone with no evidence of its own may be the document\'s order', () => {
    expect(classify(row(), order(), withSibling(sibling()))).toEqual({ skip: 'twin_living_sale', twin: 'ORD-2' });
    // it owns a document / parcel of its own, or is itself on the list → two documents, two sales
    expect(classify(row(), order(), { ...withSibling(sibling()), owned: new Set(['b']) }).rule).toBe('dead_paid');
    expect(classify(row(), order(), { ...withSibling(sibling()), inputIds: new Set(['a', 'b']) }).rule).toBe('dead_paid');
    expect(classify(row(), order(), withSibling(sibling({ mex_tracking_id: '002-9110-5/2025' }))).rule).toBe('dead_paid');
    // outside −30 d … +10 d around the document, or not living
    const t = Date.parse('2025-11-10T11:00:00Z');
    expect(classify(row(), order(), withSibling(sibling({ created_at: new Date(t - 31 * DAY).toISOString() }))).rule).toBe('dead_paid');
    expect(classify(row(), order(), withSibling(sibling({ created_at: new Date(t + 11 * DAY).toISOString() }))).rule).toBe('dead_paid');
    expect(classify(row(), order(), withSibling(sibling({ status: 'cancelled' }))).rule).toBe('dead_paid');
  });

  it('the same price within three days is one sale entered twice — whatever the twin owns', () => {
    const twin = sibling({ price: 24.23, created_at: '2025-11-10T09:00:00Z' });
    expect(classify(row(), order(), { ...withSibling(twin), owned: new Set(['b']) })).toEqual({ skip: 'same_price_twin', twin: 'ORD-2' });
    expect(classify(row(), order(), { ...withSibling({ ...twin, created_at: '2025-11-14T09:00:00Z' }), owned: new Set(['b']) }).rule).toBe('dead_paid');
    expect(classify(row(), order(), { ...withSibling({ ...twin, price: 30 }), owned: new Set(['b']) }).rule).toBe('dead_paid');
  });

  it('a duplicate stays dead, and so does an order whose own sale stamp is far from the document', () => {
    expect(classify(row({ audit_status: 'trashed' }), order({ status: 'trashed', trash_reason: 'duplicate_order', cancellation_reason: null }), ctx()))
      .toEqual({ skip: 'dead_as_duplicate' });
    expect(classify(row(), order({ cancellation_reason: 'other', cancellation_reason_notes: 'duplicate of ORD-101 which holds the parcel' }), ctx()))
      .toEqual({ skip: 'dead_as_duplicate' });
    expect(classify(row(), order({ sold_at: '2026-09-17T10:00:00Z' }), ctx())).toEqual({ skip: 'sale_day_far_from_document' });
    expect(classify(row(), order({ sold_at: '2025-11-08T10:00:00Z' }), ctx()).rule).toBe('dead_paid');
  });

  it('reads its own CSV: BOM, quoted commas and doubled quotes', () => {
    expect(parseCsv('﻿a,b\r\n1,"x, ""y"""\r\n2,z\r\n')).toEqual([{ a: '1', b: 'x, "y"' }, { a: '2', b: 'z' }]);
  });
});
