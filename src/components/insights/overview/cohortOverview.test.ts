import { describe, expect, it } from 'vitest';
import type { Cohort, CohortSourceRow } from '../shared/cohortTypes';
import { bucketParts, checkSum, cohortDrill, cohortView, stripCohortMoney, sumParts } from '../shared/cohortModel';
import sample from './__fixtures__/cohort.sample.json';
import { splitDrill, tileBuckets, tilePart, workedOf } from './cohortOverview';

// The Overview's source cards over the shared cohort, checked against the
// fixture built from the real week 22–28.09.2026 (research_cohortData): the
// parts add up to the total everywhere, a subset of sources re-sums exactly,
// and a number links only to a list that holds exactly what it counts.

const fixture = () => structuredClone(sample) as unknown as Cohort;
const range = { from: '2026-09-22', to: '2026-09-28' };
const row = (k: string) => fixture().by_source.find((r) => r.key === k)! as CohortSourceRow;

describe('the week fixture is a valid cohort', () => {
  it('Σ parts = total — the header and every source', () => {
    const c = fixture();
    expect(checkSum(c.total, c.buckets)).toMatchObject({ ok: true, count: { total: 1337, parts: 1337 } });
    expect(c.total.value_mkd).toBe(3239584);
    for (const r of c.by_source) expect(checkSum(r.total, r.buckets).ok).toBe(true);
    const rows = sumParts(c.by_source.map((r) => ({ count: r.total.count, value_mkd: r.total.value_mkd ?? null, cod_mkd: null })));
    expect(rows).toMatchObject({ count: 1337, value_mkd: 3239584 });
  });
  it('a subset of sources re-sums from its rows (header = Σ of the cards shown)', () => {
    const v = cohortView(fixture(), ['altercpa', 'elyon_crm']);
    expect(v.filtered).toBe(true);
    expect(v.total).toMatchObject({ count: 397 + 180, value_mkd: 1086880 + 492027 });
    expect(bucketParts(v.buckets).to_pack.count).toBe(207 + 53);
    expect(v.leads_in).toMatchObject({ came_in: 831 + 1780, became_sales: 351 + 142 });
  });
  it('a non-owner copy carries counts only', () => {
    const s = stripCohortMoney(fixture());
    expect(JSON.stringify(s)).not.toMatch(/_mkd"/);
    expect(s.meta.money).toBe(false);
    expect(s.by_source[0].total.count).toBe(397);
  });
});

describe('tiles', () => {
  it('"Кај курирот" is moving + problem in one number', () => {
    expect(tileBuckets('courier')).toEqual(['courier', 'courier_problem']);
    expect(tileBuckets('paid')).toEqual(['paid']);
    const parts = bucketParts(row('altercpa').buckets);
    expect(tilePart(parts, 'courier')).toEqual({ count: 23 + 41, value_mkd: 68400 + 123600, cod_mkd: null });
    expect(tilePart(parts, 'to_pack').count).toBe(207);
  });
  it('a courier tile opens both buckets; the web mirror and MEX-only rows never link', () => {
    const alter = row('altercpa');
    expect(cohortDrill([alter], tileBuckets('courier'), range, true).href)
      .toBe('/orders?cohort_bucket=courier%2Ccourier_problem&sale_source=altercpa%2Caffiliate&sold_from=2026-09-22&sold_to=2026-09-28');
    // 32 LEADS parcels have no order: the link opens the orders, the tooltip says what is missing.
    expect(cohortDrill([alter], 'paid', range, true).mexOnly).toBe(32);
    expect(cohortDrill([row('web')], 'paid', range, true)).toMatchObject({ href: null, blocked: 'web' });
    // This week's teleshop is MEX parcels only (collabBox stale): no list holds it.
    expect(cohortDrill([row('teleshop_other')], 'paid', range, true)).toMatchObject({ href: null, blocked: 'mex_only' });
    // Until /orders knows cohort_bucket, nothing links — a wider list would be worse than none.
    expect(cohortDrill([alter], 'paid', range, false)).toMatchObject({ href: null, blocked: 'unsupported' });
  });
});

describe('split chips', () => {
  it('an orders split links to exactly that split once /orders can filter the cohort', () => {
    const elyon = row('elyon_crm');
    const pl = elyon.splits.find((s) => s.key === 'prediction_list')!;
    expect(splitDrill(elyon, pl, range, true).href)
      .toBe('/orders?sale_source=elyon_crm&sale_source_detail=prediction_list&sold_from=2026-09-22&sold_to=2026-09-28');
    expect(splitDrill(elyon, pl, range, false)).toEqual({ href: null, blocked: 'unsupported' });
    const orders = { key: 'orders', count: 365 };
    expect(splitDrill(row('altercpa'), orders, range, true).href)
      .toBe('/orders?sale_source=altercpa%2Caffiliate&sold_from=2026-09-22&sold_to=2026-09-28');
  });
  it('parcels, the web mirror, empty and unknown splits never link — each says why', () => {
    const alter = row('altercpa');
    expect(splitDrill(alter, alter.splits.find((s) => s.key === 'unlinked_leads')!, range, true)).toEqual({ href: null, blocked: 'mex_only' });
    expect(splitDrill(row('teleshop_other'), { key: 'mex_teleshop', count: 639 }, range, true).blocked).toBe('mex_only');
    expect(splitDrill(row('web'), { key: 'cod', count: 84 }, range, true).blocked).toBe('web');
    expect(splitDrill(row('teleshop_other'), { key: 'collabbox', count: 0 }, range, true).blocked).toBe('none');
    expect(splitDrill(alter, { key: 'new_customers', count: 5 }, range, true).blocked).toBe('not_orders');
  });
});

describe('leads', () => {
  it('"Обработени" = became a sale + cancelled + trashed; open leads are not worked yet', () => {
    expect(workedOf(row('altercpa').leads_in)).toBe(351 + 301 + 63);
    expect(workedOf(row('web').leads_in)).toBe(90 + 23);
    expect(workedOf(null)).toBe(0);
    const l = row('altercpa').leads_in;
    expect(l.became_sales + l.cancelled + l.trashed + l.open).toBe(l.came_in);
  });
});
