import { describe, expect, it } from 'vitest';
import {
  activeFilterCount, clearDrillParams, clearListParams, customStatePick, effectiveRange, hasAnyFilter, mexGroupOf, phoneLast8,
  readListParams, toApiParams, writeListParams,
} from './listParams';
import { phoneLast8 as apiPhoneLast8, STATE_KEYS as API_STATE_KEYS } from '../../../supabase/functions/api/ordersList';
import { STATE_KEYS } from './statusModel';

const sp = (qs: string) => new URLSearchParams(qs);
const TODAY = '2026-10-01';

describe('the URL state', () => {
  it('reads every filter and ignores what it cannot read', () => {
    const s = readListParams(sp('search=070&st=paid,confirmed.no_parcel,lost&range=custom&from=2026-09-01&to=2026-09-30&dept=social,web,collabbox'
      + '&seller=11111111-1111-4111-8111-111111111111&mex=courier,packed&source=manual,opencart&agent=none&mine=1&pmin=500&pmax=abc&wm=3225&page=3'));
    expect(s).toMatchObject({
      search: '070', states: ['confirmed.no_parcel', 'paid'], range: 'custom', from: '2026-09-01', to: '2026-09-30',
      depts: ['social', 'web'], seller: '11111111-1111-4111-8111-111111111111', mex: ['courier'], sources: ['manual'],
      agent: 'none', mine: true, priceMin: 500, priceMax: null, wm: '3225', page: 3,
    });
    expect(readListParams(sp('view=sales&range=decade&seller=anna&agent=me&page=-2'))).toMatchObject({
      states: [], range: null, seller: null, agent: null, page: 1,
    });
    // a bare from/to pair (a link from elsewhere) is a custom period
    expect(readListParams(sp('from=2026-09-01&to=2026-09-07')).range).toBe('custom');
  });

  it('an old ?view= link still means what it said (read into the status pick)', () => {
    expect(readListParams(sp('view=orders')).states).toEqual(['confirmed', 'shipped', 'delivered', 'paid', 'returned']);
    expect(readListParams(sp('view=leads')).states).toEqual(['pending', 'take', 'call_again', 'duplicated']);
    expect(readListParams(sp('view=cancelled')).states).toEqual(['cancelled']);
    expect(readListParams(sp('view=all')).states).toEqual([]);
    // an explicit pick wins over the old chip
    expect(readListParams(sp('view=orders&st=trashed')).states).toEqual(['trashed']);
  });

  it('writes a change back, keeps other params, and sends the list to page 1', () => {
    const base = sp('cohort_bucket=paid&sold_from=2026-09-22&sold_to=2026-09-28&page=4&view=orders');
    const out = writeListParams(base, { depts: ['altercpa', 'elyon_crm'] });
    expect(out.get('dept')).toBe('altercpa,elyon_crm');
    expect(out.get('cohort_bucket')).toBe('paid');
    expect(out.get('view')).toBe('orders');
    expect(out.has('page')).toBe(false);
    expect(writeListParams(out, { page: 2 }).get('page')).toBe('2');
    // a pick replaces the old chip param, in the list's order, a covered child dropped
    const picked = writeListParams(out, { states: ['paid', 'confirmed.packed', 'confirmed'] });
    expect(picked.get('st')).toBe('confirmed,paid');
    expect(picked.has('view')).toBe(false);
    expect(writeListParams(picked, { states: [] }).has('st')).toBe(false);
    // empty values leave the URL; a preset drops the custom days
    const c = writeListParams(sp('range=custom&from=2026-09-01&to=2026-09-02&dept=web'), { range: 'month', depts: [] });
    expect(c.toString()).toBe('range=month');
    expect(writeListParams(sp(''), { mine: false }).get('mine')).toBe('0');
    expect(writeListParams(sp('mine=1'), { mine: null }).has('mine')).toBe(false);
  });

  it('"Исчисти" removes the filters and the drill; the drill ✕ keeps the filters', () => {
    const s = sp('st=paid&view=leads&dept=web&cohort_bucket=paid&sold_from=2026-09-22&lbl=Ana&other=1');
    expect(clearListParams(s).toString()).toBe('other=1');
    expect(clearDrillParams(s).toString()).toBe('st=paid&view=leads&dept=web&other=1');
  });
});

describe('defaults — every status, every date (owner 15.10.2026)', () => {
  it('opens on all statuses and all dates', () => {
    const s = readListParams(sp(''));
    expect(s.states).toEqual([]);
    expect(effectiveRange(s, TODAY)).toEqual({ preset: 'all', days: null });
    expect(hasAnyFilter(s, false)).toBe(false);
  });

  it('Денес and the other presets are Skopje days', () => {
    expect(effectiveRange(readListParams(sp('range=today')), TODAY).days).toEqual({ from: TODAY, to: TODAY });
    expect(effectiveRange(readListParams(sp('range=week')), TODAY).days).toEqual({ from: '2026-09-25', to: TODAY });
    expect(effectiveRange(readListParams(sp('range=year')), TODAY).preset).toBe('year'); // an old link still works
  });

  it('a custom period may be open on one side', () => {
    expect(effectiveRange(readListParams(sp('range=custom&from=2026-09-10')), TODAY).days).toEqual({ from: '2026-09-10', to: TODAY });
    expect(effectiveRange(readListParams(sp('range=custom&to=2026-09-10')), TODAY).days?.to).toBe('2026-09-10');
  });
});

describe('the api parameters', () => {
  const ctx = { today: TODAY, isAgent: false, userId: 'me' };

  it('sends view=all + the pick as state, Skopje days and the filters; prices go in EUR', () => {
    const p = toApiParams(readListParams(sp('st=paid,shipped.problem&range=today&dept=social&mex=at_mex,no_parcel&source=manual&seller=11111111-1111-4111-8111-111111111111&pmin=615&wm=77')), ctx);
    expect(p).toEqual({
      view: 'all', state: 'shipped.problem,paid', day_from: '2026-10-01', day_to: '2026-10-01', dept: 'social', mex: 'at_mex,no_parcel',
      source: 'manual', seller: '11111111-1111-4111-8111-111111111111', price_min: 10, cpa_webmaster: '77',
    });
    expect(toApiParams(readListParams(sp('')), ctx)).toEqual({ view: 'all' });
    expect(toApiParams(readListParams(sp('view=cancelled')), ctx)).toEqual({ view: 'all', state: 'cancelled' });
  });

  it('"my orders": agents always (except a search), others when switched on; it beats the agent picker', () => {
    const agent = { ...ctx, isAgent: true };
    expect(toApiParams(readListParams(sp('')), agent).agent_id).toBe('me');
    expect(toApiParams(readListParams(sp('search=Марија')), agent).agent_id).toBeUndefined();
    expect(toApiParams(readListParams(sp('agent=none')), ctx).agent_id).toBe('none');
    expect(toApiParams(readListParams(sp('mine=1&agent=none')), ctx).agent_id).toBe('me');
  });

  it('the "Филтри" badge counts the panel filters; a quick-view pick is the strip\'s, a custom pick the panel\'s', () => {
    expect(activeFilterCount(readListParams(sp('')), false)).toBe(0);
    expect(activeFilterCount(readListParams(sp('range=month&st=paid,cancelled&dept=web,social&mex=courier&pmin=1')), false)).toBe(4);
    expect(activeFilterCount(readListParams(sp('st=confirmed,shipped,delivered,paid,returned')), false)).toBe(0);
    expect(customStatePick(readListParams(sp('st=returned')))).toBe(false);
    expect(customStatePick(readListParams(sp('st=confirmed.no_parcel')))).toBe(true);
    expect(activeFilterCount(readListParams(sp('mine=1')), true)).toBe(0);
    expect(hasAnyFilter(readListParams(sp('range=today')), false)).toBe(true);
  });
});

describe('twins of the api', () => {
  it('the same status-pick vocabulary', () => {
    expect([...STATE_KEYS]).toEqual([...API_STATE_KEYS]);
  });
  it('detects a phone exactly like the api', () => {
    for (const s of ['070 123 456', '+389 70 123 456', '(070) 123-456', '12345', 'ORD-361499', '7012345', 'Марија', '']) {
      expect(phoneLast8(s), s).toBe(apiPhoneLast8(s));
    }
  });
  it('groups MEX statuses (the row badge)', () => {
    expect(mexGroupOf(8, 'x')).toBe('at_mex');
    expect(mexGroupOf(9, 'x')).toBe('courier');
    expect(mexGroupOf(2, 'x')).toBe('delivered');
    expect(mexGroupOf(7, 'x')).toBe('returned');
    expect(mexGroupOf(13, 'x')).toBe('rejected');
    expect(mexGroupOf(null, null)).toBe('no_parcel');
  });
});
