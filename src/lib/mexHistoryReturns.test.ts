import { describe, it, expect } from 'vitest';
// History audit 03.10.2026: the CRM says PAID, MEX's own final status of the parcel is "Return to sender" — MEX decides.
// Pinned here: the three rules, the returned_at (MEX's last update, Skopje wall clock), and what is never flipped —
// a moved status, another parcel, a parcel the live register knows but no order holds (a flip without the link would
// count the return twice), a re-send MEX delivered afterwards, a payout.
import { KEY, classify } from '../../scripts/repair-mex-history-returns.mjs';

const row = (over: Record<string, unknown> = {}) => ({
  order_id: 'a', audit_verdict: 'SET_RETURNED', mex_status: 'Return to sender', match: 'number', tracking: '002-9102-55/2024',
  account: 'NATURA', series: '9102', mex_created: '2024-03-04T10:00:00', mex_last_update: '2024-03-12T15:30:00', cod_mkd: '1800',
  resend_tracking: '', ...over,
});
const order = (over: Record<string, unknown> = {}) => ({ id: 'a', status: 'paid', mex_tracking_id: null, paid_basis: 'legacy_import', price: 29.27, ...over });
const none = new Set<string>();

describe('MEX history returns — paid in the CRM, returned at MEX', () => {
  it('by the order\'s own document number, or by the phone: returned at MEX\'s last update', () => {
    expect(KEY).toBe('mex-history-returns');
    const c = classify(row(), order(), null, none);
    expect(c.rule).toBe('mex_returned_number');
    expect(c.set).toEqual({ status: 'returned', returned_at: '2024-03-12T14:30:00.000Z', paid_at: null, paid_basis: null });
    expect(c.history).toEqual({ from: 'paid', to: 'returned' });
    expect(c.expectTracking).toBeNull();
    expect(c.note).toContain('002-9102-55/2024');
    expect(classify(row({ match: 'phone+date' }), order(), null, none).rule).toBe('mex_returned_phone');
  });

  it('an order that already holds the parcel (register 7) is corrected with its tracking as the guard', () => {
    const c = classify(row(), order({ mex_tracking_id: '002-9102-55/2024' }), { order_id: 'a', status_id: 7 }, none);
    expect(c.rule).toBe('held_returned');
    expect(c.expectTracking).toBe('002-9102-55/2024');
    expect(classify(row(), order({ mex_tracking_id: '002-9102-55/2024' }), { order_id: 'a', status_id: 2 }, none)).toEqual({ skip: 'register_status_2' });
    expect(classify(row(), order({ mex_tracking_id: '002-9102-55/2024' }), null, none)).toEqual({ skip: 'held_parcel_not_in_register' });
  });

  it('left alone: moved, another parcel, the register\'s unlinked or foreign parcel, a delivered re-send, a payout', () => {
    expect(classify(row(), order({ status: 'returned' }), null, none)).toEqual({ skip: 'moved_paid_to_returned' });
    expect(classify(row(), order({ mex_tracking_id: '002-9102-99/2024' }), null, none)).toEqual({ skip: 'holds_another_parcel' });
    expect(classify(row(), order(), { order_id: null, status_id: 7 }, none)).toEqual({ skip: 'parcel_in_register_unlinked' });
    expect(classify(row(), order(), { order_id: 'b', status_id: 7 }, none)).toEqual({ skip: 'parcel_held_by_another_order' });
    expect(classify(row({ resend_tracking: '002-9102-70/2024' }), order(), null, none)).toEqual({ skip: 'resend_delivered' });
    expect(classify(row(), order(), null, new Set(['a']))).toEqual({ skip: 'in_agent_payout' });
    expect(classify(row({ mex_status: 'Delivered' }), order(), null, none)).toEqual({ skip: 'not_a_mex_return' });
    expect(classify(row(), undefined, null, none)).toEqual({ skip: 'order_gone' });
  });
});
