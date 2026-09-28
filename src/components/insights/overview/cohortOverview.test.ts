import { describe, expect, it } from 'vitest';
import type { Cohort, CohortSourceRow } from '../shared/cohortTypes';
import { bucketParts, cohortDrill } from '../shared/cohortModel';
import sample from '../shared/__fixtures__/cohort.sample.json';
import { splitDrill, tileBuckets, tilePart, workedOf } from './cohortOverview';

// The Overview's source cards over the shared cohort, checked against the
// week fixture (22–28.09.2026 in insights_cohort()'s shape): a tile adds up
// its buckets, a chip links only to a list that holds exactly it.

const fixture = () => structuredClone(sample) as unknown as Cohort;
const range = { from: '2026-09-22', to: '2026-09-28' };
const row = (k: string) => fixture().by_source.find((r) => r.key === k)! as CohortSourceRow;
const WIN = 'sold_from=2026-09-22&sold_to=2026-09-28';

describe('tiles', () => {
  it('"Кај курирот" is moving + problem in one number, with what it is made of', () => {
    expect(tileBuckets('courier')).toEqual(['courier', 'courier_problem']);
    expect(tileBuckets('paid')).toEqual(['paid']);
    const parts = bucketParts(row('altercpa').buckets);
    expect(tilePart(parts, 'courier')).toMatchObject({ count: 20 + 36, value_mkd: 50800 + 91500, orders: 56, web: 0, mex_only: 0 });
    expect(tilePart(parts, 'to_pack').count).toBe(207);
  });
  it('a courier tile opens both buckets; the web mirror and MEX-only sources never link', () => {
    expect(cohortDrill([row('altercpa')], tileBuckets('courier'), range, true).href)
      .toBe(`/orders?cohort_bucket=courier%2Ccourier_problem&sale_source=altercpa%2Caffiliate&${WIN}`);
    expect(cohortDrill([row('web')], 'paid', range, true)).toMatchObject({ href: null, blocked: 'web' });
    expect(cohortDrill([row('teleshop_other')], 'paid', range, true)).toMatchObject({ href: null, blocked: 'mex_only' });
    // Until /orders knows cohort_bucket, nothing links — a wider list would be worse than none.
    expect(cohortDrill([row('altercpa')], 'paid', range, false)).toMatchObject({ href: null, blocked: 'unsupported' });
  });
});

describe('split chips', () => {
  it('an order split links to exactly that split of the cohort once /orders can filter it', () => {
    const elyon = row('elyon_crm');
    const pl = elyon.splits.find((s) => s.key === 'prediction_list')!;
    expect(splitDrill(elyon, pl, range, true).href)
      .toBe(`/orders?cohort_bucket=total&sale_source=elyon_crm&sale_source_detail=prediction_list&${WIN}`);
    expect(splitDrill(elyon, pl, range, false)).toEqual({ href: null, blocked: 'unsupported' });
    const bridge = row('altercpa').splits.find((s) => s.key === 'bridge')!;
    expect(splitDrill(row('altercpa'), bridge, range, true).href)
      .toBe(`/orders?cohort_bucket=total&sale_source=altercpa%2Caffiliate&sale_source_detail=bridge&${WIN}`);
    // the api's own link for the chip says the same
    expect(bridge.drill).toBe(`/orders?cohort_bucket=total&sale_source=altercpa,affiliate&sale_source_detail=bridge&${WIN}`);
  });
  it('parcels, the web mirror, empty, unnamed and unknown splits never link — each says why', () => {
    const tele = row('teleshop_other');
    expect(splitDrill(tele, tele.splits.find((s) => s.key === 'elyon_unlinked')!, range, true)).toEqual({ href: null, blocked: 'mex_only' });
    expect(splitDrill(tele, { key: 'mex_teleshop', kind: 'mex', count: 639 }, range, true).blocked).toBe('mex_only');
    expect(splitDrill(row('web'), { key: 'cod', kind: 'web', count: 84 }, range, true).blocked).toBe('web');
    expect(splitDrill(tele, { key: 'teleshop', kind: 'order', count: 0 }, range, true).blocked).toBe('none');
    expect(splitDrill(row('altercpa'), { key: 'none', kind: 'order', count: 5 }, range, true).blocked).toBe('not_orders');
    expect(splitDrill(row('altercpa'), { key: 'new customers', kind: 'order', count: 5 }, range, true).blocked).toBe('not_orders');
    expect(splitDrill(row('altercpa'), { key: 'bridge', count: 5 }, range, true).blocked).toBe('not_orders');
  });
});

describe('leads', () => {
  it('"Обработени" = became a sale + cancelled + trashed; open leads are not worked yet', () => {
    expect(workedOf(row('altercpa').leads_in)).toBe(351 + 301 + 63);
    expect(workedOf(row('web').leads_in)).toBe(90 + 23);
    // ElyonCRM's "no" calls are cancels: every call is a decision
    expect(workedOf(row('elyon_crm').leads_in)).toBe(1780);
    expect(workedOf(null)).toBe(0);
    const l = row('altercpa').leads_in;
    expect(l.became_sales + l.cancelled + l.trashed + l.open + (l.other ?? 0)).toBe(l.came_in);
  });
});
