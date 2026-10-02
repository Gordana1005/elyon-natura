import { describe, expect, it } from 'vitest';
import { bookingsApply, collabBadge, ddMm, isProvisionalDept, toBookingsParams } from './bookings';
import { readListParams } from './listParams';

const state = (qs = '') => readListParams(new URLSearchParams(qs));
const admin = { drill: false, isAgent: false };

describe('bookingsApply — where the collabBox bookings belong', () => {
  it('"Нарачки" and "Сите" — never leads, cancels or trash', () => {
    expect(bookingsApply(state(), 'orders', admin)).toBe(true);
    expect(bookingsApply(state(), 'all', admin)).toBe(true);
    for (const v of ['leads', 'cancelled', 'trashed'] as const) expect(bookingsApply(state(), v, admin)).toBe(false);
  });
  it('the period, department, seller and search apply to a booking', () => {
    expect(bookingsApply(state('range=week&dept=teleshop_out&seller=11111111-1111-4111-8111-111111111111&search=070123456'), 'orders', admin)).toBe(true);
  });
  it('a filter a booking cannot have hides the section', () => {
    expect(bookingsApply(state('mex=courier'), 'orders', admin)).toBe(false);
    expect(bookingsApply(state('mex=courier,no_parcel'), 'orders', admin)).toBe(true);
    expect(bookingsApply(state('source=altercpa'), 'orders', admin)).toBe(false);
    expect(bookingsApply(state('agent=none'), 'orders', admin)).toBe(false);
    expect(bookingsApply(state('pmin=1000'), 'orders', admin)).toBe(false);
    expect(bookingsApply(state('wm=3225'), 'orders', admin)).toBe(false);
    expect(bookingsApply(state(), 'orders', { drill: true, isAgent: false })).toBe(false);
  });
  it('"my orders": an admin who switches it on means assigned to them; an agent always sees their own (the api scopes)', () => {
    expect(bookingsApply(state('mine=1'), 'orders', admin)).toBe(false);
    expect(bookingsApply(state(), 'orders', { drill: false, isAgent: true })).toBe(true);
  });
});

describe('toBookingsParams', () => {
  it('keeps only the period, department, seller and search', () => {
    expect(toBookingsParams({
      view: 'orders', day_from: '2026-10-02', day_to: '2026-10-02', dept: 'teleshop_out', seller: 's', search: '070',
      mex: 'no_parcel', agent_id: 'a', price_min: 1,
    })).toEqual({ day_from: '2026-10-02', day_to: '2026-10-02', dept: 'teleshop_out', seller: 's', search: '070' });
    expect(toBookingsParams({ view: 'all' })).toEqual({});
  });
});

describe('the collabBox entry badge', () => {
  it('green with the document when the sale is in collabBox', () => {
    expect(collabBadge({ collab: { doc: '002-9103-178176/2026', sale_day: '2026-10-02', cancel_day: '2026-10-04', mode: 'report' } }))
      .toEqual({ kind: 'in', doc: '002-9103-178176/2026' });
  });
  it('amber when not; the cancel day only once the rule is in apply mode', () => {
    expect(collabBadge({ collab: { doc: null, sale_day: '2026-10-02', cancel_day: '2026-10-04', mode: 'report' } }))
      .toEqual({ kind: 'missing', cancelDay: null, days: 2 });
    expect(collabBadge({ collab: { doc: null, sale_day: '2026-09-30', cancel_day: '2026-10-02', mode: 'apply' } }))
      .toEqual({ kind: 'missing', cancelDay: '02.10', days: 2 });
  });
  it('nothing on a row without the field', () => {
    expect(collabBadge({})).toBeNull();
    expect(collabBadge({ collab: null })).toBeNull();
  });
  it('the department is provisional only without a document and without a parcel', () => {
    const c = { doc: null, sale_day: '2026-10-02', cancel_day: '2026-10-04', mode: 'report' as const };
    expect(isProvisionalDept({ collab: c })).toBe(true);
    expect(isProvisionalDept({ collab: { ...c, doc: '002-9103-1/2026' } })).toBe(false);
    expect(isProvisionalDept({ collab: c, mex_tracking_id: '002-9103-1/2026' })).toBe(false);
    expect(isProvisionalDept({})).toBe(false);
  });
  it('ddMm', () => {
    expect(ddMm('2026-10-04')).toBe('04.10');
    expect(ddMm(null)).toBe('');
    expect(ddMm('04.10.2026')).toBe('');
  });
});
