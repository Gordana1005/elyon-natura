import { describe, expect, it } from 'vitest';
import { mexBadge, orderValue, rowInstant, skopjeDayTime } from './rowModel';

describe('the row', () => {
  it('value: the parcel COD (денари) when MEX has one, else the CRM price ×61.5', () => {
    expect(orderValue({ price: 24.23, mex_cod_mkd: 1490 })).toEqual({ text: '1.490 ден', fromParcel: true });
    expect(orderValue({ price: 20, mex_cod_mkd: null })).toEqual({ text: '1.230 ден', fromParcel: false });
    expect(orderValue({ price: 20, mex_cod_mkd: 0 })).toEqual({ text: '0 ден', fromParcel: true }); // a replacement
  });

  it('is dated by its own status clock', () => {
    const base = { created_at: '2026-09-20T08:00:00Z', sold_at: '2026-09-22T08:00:00Z', confirmed_at: '2026-09-21T08:00:00Z', cancelled_at: '2026-09-23T08:00:00Z', trashed_at: '2026-09-24T08:00:00Z' };
    expect(rowInstant({ ...base, status: 'paid' })).toBe(base.sold_at);
    expect(rowInstant({ ...base, status: 'confirmed', sold_at: null })).toBe(base.confirmed_at);
    expect(rowInstant({ ...base, status: 'cancelled' })).toBe(base.cancelled_at);
    expect(rowInstant({ ...base, status: 'trashed' })).toBe(base.trashed_at);
    expect(rowInstant({ ...base, status: 'pending' })).toBe(base.created_at);
  });

  it('shows Skopje time (summer and winter), not the browser zone', () => {
    expect(skopjeDayTime('2026-09-21T22:30:00Z')).toEqual({ day: '22.09.2026', time: '00:30' });
    expect(skopjeDayTime('2026-12-01T23:15:00Z')).toEqual({ day: '02.12.2026', time: '00:15' });
    expect(skopjeDayTime(null)).toEqual({ day: '—', time: '' });
  });

  it('MEX badge tones', () => {
    expect(mexBadge({ mex_status_id: 2, mex_tracking_id: 'x' })).toEqual({ group: 'delivered', tone: 'good', statusId: 2 });
    expect(mexBadge({ mex_status_id: 10, mex_tracking_id: 'x' }).tone).toBe('courier');
    expect(mexBadge({ mex_status_id: 3, mex_tracking_id: 'x' }).tone).toBe('problem');
    expect(mexBadge({ mex_status_id: 8, mex_tracking_id: 'x' }).tone).toBe('label');
    expect(mexBadge({ mex_status_id: 7, mex_tracking_id: 'x' }).tone).toBe('returned');
    expect(mexBadge({ mex_status_id: 13, mex_tracking_id: 'x' }).tone).toBe('rejected');
    expect(mexBadge({ mex_status_id: null, mex_tracking_id: null })).toEqual({ group: 'no_parcel', tone: 'none', statusId: null });
  });
});
