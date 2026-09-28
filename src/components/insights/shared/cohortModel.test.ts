import { describe, expect, it } from 'vitest';
import sample from './__fixtures__/cohort.sample.json';
import {
  bucketParts, canWeighByValue, checkSum, cohortDrill, cohortHref, cohortView, liveQuality, mexOnlyCount,
  ordersSupportsCohortDrill, stripCohortMoney, sumParts, tileKeys,
} from './cohortModel';
import { COHORT_BUCKETS, type Cohort } from './cohortTypes';

const fixture = () => structuredClone(sample) as unknown as Cohort;
const range = { from: '2026-09-22', to: '2026-09-28' };
const row = (c: Cohort, k: string) => c.by_source.find((r) => r.key === k)!;

describe('the cohort adds up (the contract invariant)', () => {
  it('Σ buckets = total, for the whole business and for every source', () => {
    const c = fixture();
    expect(checkSum(c.total, c.buckets)).toMatchObject({ ok: true, count: { total: 1337, parts: 1337 } });
    for (const r of c.by_source) expect(checkSum(r.total, r.buckets).ok, r.key).toBe(true);
    // …and the sources add up to the whole.
    expect(sumParts(c.by_source.map((r) => ({ count: r.total.count, value_mkd: r.total.value_mkd ?? null, cod_mkd: null }))))
      .toMatchObject({ count: c.total.count, value_mkd: c.total.value_mkd });
  });
  it('a total the parts do not reach is reported, never smoothed over', () => {
    const c = fixture();
    const bad = checkSum({ count: c.total.count + 3, value_mkd: c.total.value_mkd }, c.buckets);
    expect(bad).toMatchObject({ ok: false, count: { total: 1340, parts: 1337 } });
    const badMoney = checkSum({ count: c.total.count, value_mkd: (c.total.value_mkd ?? 0) + 5000 }, c.buckets);
    expect(badMoney.ok).toBe(false);
    // rounding slack: ≤ 1 ден per part
    expect(checkSum({ count: c.total.count, value_mkd: (c.total.value_mkd ?? 0) + 2 }, c.buckets).ok).toBe(true);
  });
  it('every bucket is present in the bar order, zeros included; tiles show the core always', () => {
    const parts = bucketParts(fixture().buckets);
    expect(Object.keys(parts)).toEqual([...COHORT_BUCKETS]);
    expect(tileKeys(parts)).toEqual(['paid', 'courier', 'label', 'to_pack', 'returned']);
    parts.paid_unproven = { count: 2, value_mkd: 5980, cod_mkd: null };
    expect(tileKeys(parts)).toEqual(['paid', 'paid_unproven', 'courier', 'label', 'to_pack', 'returned']);
  });
  it('owners weigh the bar by денари only when every part carries them', () => {
    const parts = Object.values(bucketParts(fixture().buckets));
    expect(canWeighByValue(parts, true)).toBe(true);
    expect(canWeighByValue(parts, false)).toBe(false);
    expect(canWeighByValue(Object.values(bucketParts(stripCohortMoney(fixture()).buckets)), true)).toBe(false);
  });
});

describe('the source filter re-sums from by_source', () => {
  it('no filter (or all) = the server’s own numbers', () => {
    const c = fixture();
    const v = cohortView(c, []);
    expect(v.filtered).toBe(false);
    expect(v.total.count).toBe(1337);
    expect(v.buckets).toBe(c.buckets);
    expect(cohortView(c, ['altercpa', 'elyon_crm', 'web', 'teleshop_other']).filtered).toBe(false);
    expect(v.rows.map((r) => r.key)).toEqual(['altercpa', 'elyon_crm', 'web', 'teleshop_other']);
  });
  it('a subset: the header equals Σ of the rows shown, parts still add up', () => {
    const c = fixture();
    const v = cohortView(c, ['elyon_crm', 'altercpa']);
    expect(v.filtered).toBe(true);
    expect(v.rows.map((r) => r.key)).toEqual(['altercpa', 'elyon_crm']);
    expect(v.total.count).toBe(397 + 180);
    expect(v.total.value_mkd).toBe((row(c, 'altercpa').total.value_mkd ?? 0) + (row(c, 'elyon_crm').total.value_mkd ?? 0));
    expect(checkSum({ count: v.total.count, value_mkd: v.total.value_mkd ?? undefined }, v.buckets).ok).toBe(true);
    expect(v.buckets.find((b) => b.key === 'to_pack')?.count).toBe(207 + 53);
    expect(v.outside.find((o) => o.key === 'cancelled_after_sale')?.count).toBe(3);
    expect(v.leads_in).toMatchObject({ came_in: 831 + 142, became_sales: 351 + 142 });
    expect(v.leads_in.conversion).toBeCloseTo(493 / 973, 6);
  });
  it('a non-owner subset carries no money', () => {
    const v = cohortView(stripCohortMoney(fixture()), ['web']);
    expect(v.total.value_mkd).toBeNull();
    expect(JSON.stringify(v.buckets)).not.toMatch(/_mkd/);
  });
});

describe('drill links: a cohort part → /orders', () => {
  it('/orders must know cohort_bucket first — otherwise no link at all', () => {
    expect(ordersSupportsCohortDrill(['sale_source', 'sold_from'])).toBe(false);
    expect(ordersSupportsCohortDrill(['sale_source', 'cohort_bucket'])).toBe(true);
    const c = fixture();
    expect(cohortDrill([row(c, 'altercpa')], 'paid', range, false)).toEqual({ href: null, blocked: 'unsupported', mexOnly: 32 });
  });
  it('orders sources link, with the sale window and the bucket', () => {
    const c = fixture();
    const d = cohortDrill([row(c, 'altercpa'), row(c, 'elyon_crm')], 'paid', range, true);
    expect(d.blocked).toBeNull();
    expect(d.href).toBe('/orders?cohort_bucket=paid&sale_source=altercpa%2Caffiliate%2Celyon_crm&sold_from=2026-09-22&sold_to=2026-09-28');
    // The unlinked LEADS / LEADS-OUT parcels are not orders: the list can hold fewer rows — said, not hidden.
    expect(d.mexOnly).toBe(32 + 38);
    expect(cohortDrill([row(c, 'elyon_crm')], ['courier', 'courier_problem'], range, true).href)
      .toBe('/orders?cohort_bucket=courier%2Ccourier_problem&sale_source=elyon_crm&sold_from=2026-09-22&sold_to=2026-09-28');
    expect(cohortHref('total', ['elyon_crm'], range)).toBe('/orders?sale_source=elyon_crm&sold_from=2026-09-22&sold_to=2026-09-28');
  });
  it('the web shop (a mirror) and a source made only of MEX parcels never link', () => {
    const c = fixture();
    expect(cohortDrill(c.by_source, 'paid', range, true)).toMatchObject({ href: null, blocked: 'web' });
    expect(mexOnlyCount(row(c, 'teleshop_other'))).toBe(670);
    expect(cohortDrill([row(c, 'teleshop_other')], 'returned', range, true)).toMatchObject({ href: null, blocked: 'mex_only' });
    // …but a part the web shop has none of still links for the orders sources.
    expect(cohortDrill([row(c, 'altercpa'), row(c, 'web')], 'returned', range, true).href).toContain('sale_source=altercpa%2Caffiliate&');
  });
  it('nothing there → nothing to open', () => {
    const c = fixture();
    expect(cohortDrill(c.by_source, 'paid_unproven', range, true)).toEqual({ href: null, blocked: 'none', mexOnly: 0 });
  });
});

describe('quality rail and the money strip', () => {
  it('live items only, most severe first, then the biggest', () => {
    const q = liveQuality([
      { kind: 'zero_cod_parcels', count: 80 },
      { kind: 'unproven_paid', count: 2 },
      { kind: 'no_seller', count: 3 },
      { kind: 'double_count_candidates', count: 9 },
      { kind: 'cancelled_but_moving', count: 0 },
    ]);
    expect(q.map((x) => x.kind)).toEqual(['unproven_paid', 'double_count_candidates', 'no_seller', 'zero_cod_parcels']);
  });
  it('a non-owner payload: every *_mkd key gone, every count kept', () => {
    const c = fixture();
    const s = stripCohortMoney(c);
    expect(JSON.stringify(s)).not.toMatch(/_mkd/);
    expect(s.meta.money).toBe(false);
    expect(s.total.count).toBe(c.total.count);
    expect(s.cash_flow.parcels).toBe(c.cash_flow.parcels);
    expect(c.meta.money).toBe(true); // the input is untouched
  });
});
