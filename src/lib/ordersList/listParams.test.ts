import { describe, expect, it } from 'vitest';
import {
  activeFilterCount, clearDrillParams, clearListParams, effectiveRange, effectiveView, mexGroupOf, phoneLast8,
  readListParams, toApiParams, writeListParams,
} from './listParams';
import { phoneLast8 as apiPhoneLast8 } from '../../../supabase/functions/api/ordersList';

const sp = (qs: string) => new URLSearchParams(qs);
const TODAY = '2026-10-01';
const NO_DRILL = { drill: false };

describe('the URL state', () => {
  it('reads every filter and ignores what it cannot read', () => {
    const s = readListParams(sp('search=070&view=cancelled&range=custom&from=2026-09-01&to=2026-09-30&dept=social,web,collabbox'
      + '&seller=11111111-1111-4111-8111-111111111111&mex=courier,packed&source=manual,opencart&agent=none&mine=1&pmin=500&pmax=abc&wm=3225&page=3'));
    expect(s).toMatchObject({
      search: '070', view: 'cancelled', range: 'custom', from: '2026-09-01', to: '2026-09-30',
      depts: ['social', 'web'], seller: '11111111-1111-4111-8111-111111111111', mex: ['courier'], sources: ['manual'],
      agent: 'none', mine: true, priceMin: 500, priceMax: null, wm: '3225', page: 3,
    });
    expect(readListParams(sp('view=sales&range=decade&seller=anna&agent=me&page=-2'))).toMatchObject({
      view: null, range: null, seller: null, agent: null, page: 1,
    });
    // a bare from/to pair (a link from elsewhere) is a custom period
    expect(readListParams(sp('from=2026-09-01&to=2026-09-07')).range).toBe('custom');
  });

  it('writes a change back, keeps other params, and sends the list to page 1', () => {
    const base = sp('cohort_bucket=paid&sold_from=2026-09-22&sold_to=2026-09-28&page=4&view=orders');
    const out = writeListParams(base, { depts: ['altercpa', 'elyon_crm'] });
    expect(out.get('dept')).toBe('altercpa,elyon_crm');
    expect(out.get('cohort_bucket')).toBe('paid');
    expect(out.get('view')).toBe('orders');
    expect(out.has('page')).toBe(false);
    expect(writeListParams(out, { page: 2 }).get('page')).toBe('2');
    // empty values leave the URL; a preset drops the custom days
    const c = writeListParams(sp('range=custom&from=2026-09-01&to=2026-09-02&dept=web'), { range: 'month', depts: [] });
    expect(c.toString()).toBe('range=month');
    expect(writeListParams(sp(''), { mine: false }).get('mine')).toBe('0');
    expect(writeListParams(sp('mine=1'), { mine: null }).has('mine')).toBe(false);
  });

  it('"Исчисти" removes the filters and the drill; the drill ✕ keeps the filters', () => {
    const s = sp('view=leads&dept=web&cohort_bucket=paid&sold_from=2026-09-22&lbl=Ana&other=1');
    expect(clearListParams(s).toString()).toBe('other=1');
    expect(clearDrillParams(s).toString()).toBe('view=leads&dept=web&other=1');
  });
});

describe('defaults — "Нарачки", the last 7 Skopje days', () => {
  it('opens on Нарачки for the last 7 days', () => {
    const s = readListParams(sp(''));
    expect(effectiveView(s, NO_DRILL)).toBe('orders');
    expect(effectiveRange(s, TODAY, NO_DRILL)).toEqual({ preset: 'week', days: { from: '2026-09-25', to: '2026-10-01' } });
  });

  it('a drill-down or a search lists every status and every date — unless the URL says otherwise', () => {
    const drill = { drill: true };
    expect(effectiveView(readListParams(sp('')), drill)).toBe('all');
    expect(effectiveRange(readListParams(sp('')), TODAY, drill)).toEqual({ preset: 'all', days: null });
    expect(effectiveView(readListParams(sp('search=ORD-1')), NO_DRILL)).toBe('all');
    expect(effectiveView(readListParams(sp('search=ORD-1&view=orders')), NO_DRILL)).toBe('orders');
    expect(effectiveRange(readListParams(sp('range=today')), TODAY, drill).days).toEqual({ from: TODAY, to: TODAY });
  });

  it('a custom period may be open on one side', () => {
    expect(effectiveRange(readListParams(sp('range=custom&from=2026-09-10')), TODAY, NO_DRILL).days).toEqual({ from: '2026-09-10', to: TODAY });
    expect(effectiveRange(readListParams(sp('range=custom&to=2026-09-10')), TODAY, NO_DRILL).days?.to).toBe('2026-09-10');
  });
});

describe('the api parameters', () => {
  const ctx = { ...NO_DRILL, today: TODAY, isAgent: false, userId: 'me' };

  it('sends the view, Skopje days and the filters; prices go in EUR', () => {
    const p = toApiParams(readListParams(sp('dept=social&mex=at_mex,no_parcel&source=manual&seller=11111111-1111-4111-8111-111111111111&pmin=615&wm=77')), ctx);
    expect(p).toEqual({
      view: 'orders', day_from: '2026-09-25', day_to: '2026-10-01', dept: 'social', mex: 'at_mex,no_parcel', source: 'manual',
      seller: '11111111-1111-4111-8111-111111111111', price_min: 10, cpa_webmaster: '77',
    });
    expect(toApiParams(readListParams(sp('range=all&view=all')), ctx)).toEqual({ view: 'all' });
  });

  it('"my orders": agents always (except a search), others when switched on; it beats the agent picker', () => {
    const agent = { ...ctx, isAgent: true };
    expect(toApiParams(readListParams(sp('')), agent).agent_id).toBe('me');
    expect(toApiParams(readListParams(sp('search=Марија')), agent).agent_id).toBeUndefined();
    expect(toApiParams(readListParams(sp('agent=none')), ctx).agent_id).toBe('none');
    expect(toApiParams(readListParams(sp('mine=1&agent=none')), ctx).agent_id).toBe('me');
  });

  it('counts the filters beyond the defaults (the phone badge)', () => {
    expect(activeFilterCount(readListParams(sp('')), false)).toBe(0);
    expect(activeFilterCount(readListParams(sp('range=month&dept=web,social&mex=courier&pmin=1')), false)).toBe(4);
    expect(activeFilterCount(readListParams(sp('mine=1')), true)).toBe(0);
  });
});

describe('phone + MEX twins of the api', () => {
  it('detects a phone exactly like the api', () => {
    for (const s of ['070 123 456', '+389 70 123 456', '(070) 123-456', '12345', 'ORD-361499', '7012345', 'Марија', '']) {
      expect(phoneLast8(s), s).toBe(apiPhoneLast8(s));
    }
  });
  it('groups MEX statuses', () => {
    expect(mexGroupOf(8, 'x')).toBe('at_mex');
    expect(mexGroupOf(9, 'x')).toBe('courier');
    expect(mexGroupOf(2, 'x')).toBe('delivered');
    expect(mexGroupOf(7, 'x')).toBe('returned');
    expect(mexGroupOf(13, 'x')).toBe('rejected');
    expect(mexGroupOf(null, null)).toBe('no_parcel');
  });
});
