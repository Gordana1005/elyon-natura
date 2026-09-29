import { describe, expect, it } from 'vitest';
import sample from './__fixtures__/cohort.sample.json';
import {
  bucketParts, canWeighByValue, checkSum, cohortDrill, cohortHref, cohortView, isMexOnlySplit, liveQuality, mexOnlyCount,
  ordersSupportsCohortDrill, stripCohortMoney, sumParts, tileKeys, workedOf,
} from './cohortModel';
import { COHORT_BUCKETS, type Cohort } from './cohortTypes';

// The week fixture is insights_cohort()'s exact shape for 22–28.09.2026 under
// the owner's six departments of 28.09.2026 (20260942001000), in his order: Affiliate –
// Lead in (altercpa) and Affiliate – Lead out (elyon_crm) are orders only this week,
// Телешоп – Lead out (teleshop_out) is its 9102 parcels with no order (mex_out), Телешоп –
// Lead in (teleshop_other) its parcels of series 9100 (mex_in) and none (mex_other),
// Social media its 9108 parcels (mex_social), the web shop its mirror.
const fixture = () => structuredClone(sample) as unknown as Cohort;
const range = { from: '2026-09-22', to: '2026-09-28' };
const row = (c: Cohort, k: string) => c.by_source.find((r) => r.key === k)!;
const WIN = 'sold_from=2026-09-22&sold_to=2026-09-28';

describe('the cohort adds up (the contract invariant)', () => {
  it('Σ buckets = total, for the whole business and for every source; the sources add up to the whole', () => {
    const c = fixture();
    expect(checkSum(c.total, c.buckets)).toMatchObject({ ok: true, count: { total: 1337, parts: 1337 } });
    expect(c.total.value_mkd).toBe(3239584);
    for (const r of c.by_source) expect(checkSum(r.total, r.buckets).ok, r.key).toBe(true);
    expect(sumParts(c.by_source.map((r) => ({ count: r.total.count, value_mkd: r.total.value_mkd ?? null, cod_mkd: null }))))
      .toMatchObject({ count: c.total.count, value_mkd: c.total.value_mkd });
    // …and so does what every number is made of: orders + web + MEX-only = count
    const t = sumParts(Object.values(bucketParts(c.buckets)));
    expect([t.orders, t.web, t.mex_only]).toEqual([507, 90, 740]);
    expect(t.orders! + t.web! + t.mex_only!).toBe(1337);
  });
  it('a total the parts do not reach is reported, never smoothed over', () => {
    const c = fixture();
    const bad = checkSum({ count: c.total.count + 3, value_mkd: c.total.value_mkd }, c.buckets);
    expect(bad).toMatchObject({ ok: false, count: { total: 1340, parts: 1337 } });
    expect(checkSum({ count: c.total.count, value_mkd: (c.total.value_mkd ?? 0) + 5000 }, c.buckets).ok).toBe(false);
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
    expect(cohortView(c, ['altercpa', 'elyon_crm', 'teleshop_out', 'teleshop_other', 'social', 'web']).filtered).toBe(false);
    // five of the six is a filter now
    expect(cohortView(c, ['altercpa', 'elyon_crm', 'teleshop_other', 'social', 'web']).filtered).toBe(true);
    expect(v.rows.map((r) => r.key)).toEqual(['altercpa', 'elyon_crm', 'teleshop_out', 'teleshop_other', 'social', 'web']);
  });
  it('a subset: the header equals Σ of the rows shown, parts and composition still add up', () => {
    const c = fixture();
    const v = cohortView(c, ['elyon_crm', 'altercpa']);
    expect(v.filtered).toBe(true);
    expect(v.rows.map((r) => r.key)).toEqual(['altercpa', 'elyon_crm']);
    expect(v.total).toMatchObject({ count: 365 + 142, value_mkd: 991320 + 390802, orders: 507, web: 0, mex_only: 0 });
    expect(checkSum({ count: v.total.count, value_mkd: v.total.value_mkd ?? undefined }, v.buckets).ok).toBe(true);
    expect(v.buckets.find((b) => b.key === 'to_pack')).toMatchObject({ count: 207 + 53, orders: 260, web: 0 });
    expect(v.outside.find((o) => o.key === 'cancelled_after_sale')?.count).toBe(2);
    expect(v.outside.find((o) => o.key === 'trashed_after_sale')?.count).toBe(1);
    expect(v.leads_in).toMatchObject({ came_in: 831 + 1780, became_sales: 351 + 142, disposition: 1638 });
    expect(v.leads_in.conversion).toBeCloseTo(493 / 2611, 6);
  });
  it('a non-owner subset carries no money', () => {
    const v = cohortView(stripCohortMoney(fixture()), ['web']);
    expect(v.total.value_mkd).toBeNull();
    expect(JSON.stringify(v.buckets)).not.toMatch(/_mkd/);
  });
});

describe('leads', () => {
  it('a partition of what came in; "Обработени" = sale + cancelled + trashed (a "no" call is a cancel)', () => {
    for (const r of fixture().by_source) {
      const l = r.leads_in;
      expect(l.became_sales + l.cancelled + l.trashed + l.open + (l.other ?? 0), r.key).toBe(l.came_in);
    }
    const elyon = row(fixture(), 'elyon_crm').leads_in;
    expect(workedOf(elyon)).toBe(1780);
    expect(workedOf(row(fixture(), 'altercpa').leads_in)).toBe(351 + 301 + 63);
    expect(workedOf(null)).toBe(0);
  });
});

describe('drill links: a number opens /orders only when the list holds exactly it', () => {
  it('/orders must know cohort_bucket first — otherwise no link at all', () => {
    expect(ordersSupportsCohortDrill(['sale_source', 'sold_from'])).toBe(false);
    expect(ordersSupportsCohortDrill(['sale_source', 'cohort_bucket'])).toBe(true);
    const c = fixture();
    expect(cohortDrill([row(c, 'altercpa')], 'paid', range, false))
      .toMatchObject({ href: null, ordersHref: null, blocked: 'unsupported', orders: 70 });
  });
  it('all orders → the number itself links, with the bucket, the sources and the sale window', () => {
    const c = fixture();
    const d = cohortDrill([row(c, 'altercpa'), row(c, 'elyon_crm')], 'paid', range, true);
    expect(d).toMatchObject({ blocked: null, ordersHref: null, orders: 121, web: 0, mexOnly: 0 });
    expect(d.href).toBe(`/orders?cohort_bucket=paid&cohort_source=altercpa%2Celyon_crm&${WIN}`);
    expect(cohortDrill([row(c, 'elyon_crm')], ['courier', 'courier_problem'], range, true).href)
      .toBe(`/orders?cohort_bucket=courier%2Ccourier_problem&cohort_source=elyon_crm&${WIN}`);
    expect(cohortDrill([row(c, 'altercpa')], 'total', range, true).href)
      .toBe(`/orders?cohort_bucket=total&cohort_source=altercpa&${WIN}`);
  });
  it('partly orders → no link on the number; its order part gets its own exact link', () => {
    const c = fixture();
    const d = cohortDrill(c.by_source, 'paid', range, true);
    expect(d).toMatchObject({ href: null, blocked: 'mixed', orders: 121, web: 46, mexOnly: 550 });
    // every source at once: no cohort_source (the api's own links do the same)
    expect(d.ordersHref).toBe(`/orders?cohort_bucket=paid&${WIN}`);
    const total = cohortDrill(c.by_source, 'total', range, true);
    expect(total).toMatchObject({ href: null, orders: 507, ordersHref: `/orders?cohort_bucket=total&${WIN}` });
    // Affiliate – Lead in + Телешоп – Lead in: the parcels have no order → only the AlterCPA part opens
    const at = cohortDrill([row(c, 'altercpa'), row(c, 'teleshop_other')], 'label', range, true);
    expect(at).toMatchObject({ href: null, blocked: 'mex_only', orders: 30, mexOnly: 32 });
    expect(at.ordersHref).toBe(`/orders?cohort_bucket=label&cohort_source=altercpa%2Cteleshop_other&${WIN}`);
  });
  it('no orders behind a number → no link and no part link; each says why', () => {
    const c = fixture();
    expect(cohortDrill([row(c, 'web')], 'paid', range, true)).toMatchObject({ href: null, ordersHref: null, blocked: 'web' });
    expect(cohortDrill([row(c, 'teleshop_other')], 'returned', range, true))
      .toMatchObject({ href: null, ordersHref: null, blocked: 'mex_only' });
    expect(cohortDrill(c.by_source, 'paid_unproven', range, true)).toMatchObject({ href: null, blocked: 'none' });
    // an api that does not say what a number is made of: nobody can promise the list holds it
    const bare = fixture();
    for (const b of bare.by_source[0].buckets) { delete b.orders; delete b.web; delete b.mex_only; }
    expect(cohortDrill([bare.by_source[0]], 'paid', range, true)).toMatchObject({ href: null, blocked: 'unknown' });
  });
  it('Social media is its own card: its parcels never link, its collabBox orders open by cohort_source', () => {
    const c = fixture();
    expect(cohortDrill([row(c, 'social')], 'paid', range, true)).toMatchObject({ href: null, ordersHref: null, blocked: 'mex_only', mexOnly: 22 });
    // a week with social orders too: the order part opens cohort_source=social
    const soc = row(c, 'social');
    const withOrders = { ...soc, buckets: soc.buckets.map((b) => (b.key === 'paid' ? { ...b, count: b.count + 5, orders: 5 } : b)) };
    const d = cohortDrill([withOrders], 'paid', range, true);
    expect(d).toMatchObject({ href: null, blocked: 'mex_only', orders: 5, mexOnly: 22 });
    expect(d.ordersHref).toBe(`/orders?cohort_bucket=paid&cohort_source=social&${WIN}`);
    // Social + Teleshop together: one list, both sources
    const both = cohortDrill([withOrders, row(c, 'teleshop_other')], 'paid', range, true);
    expect(both.ordersHref).toBe(`/orders?cohort_bucket=paid&cohort_source=teleshop_other%2Csocial&${WIN}`);
  });
  it('Телешоп – Lead out is its own card: its 9102 parcels never link, its orders open by cohort_source', () => {
    const c = fixture();
    const out = row(c, 'teleshop_out');
    expect(cohortDrill([out], 'paid', range, true)).toMatchObject({ href: null, ordersHref: null, blocked: 'mex_only', mexOnly: 30 });
    const withOrders = { ...out, buckets: out.buckets.map((b) => (b.key === 'paid' ? { ...b, count: b.count + 4, orders: 4 } : b)) };
    const d = cohortDrill([withOrders], 'paid', range, true);
    expect(d).toMatchObject({ href: null, blocked: 'mex_only', orders: 4, mexOnly: 30 });
    expect(d.ordersHref).toBe(`/orders?cohort_bucket=paid&cohort_source=teleshop_out&${WIN}`);
    // Affiliate – Lead out + Телешоп – Lead out: one list, both departments, in the owner's order
    const both = cohortDrill([withOrders, row(c, 'elyon_crm')], 'paid', range, true);
    expect(both.ordersHref).toBe(`/orders?cohort_bucket=paid&cohort_source=elyon_crm%2Cteleshop_out&${WIN}`);
  });
  it('cohortHref: several parts = any of them; total is the eight in-total buckets', () => {
    expect(cohortHref('total', ['elyon_crm'], range)).toBe(`/orders?cohort_bucket=total&cohort_source=elyon_crm&${WIN}`);
    expect(cohortHref(['paid', 'label'], [], range)).toBe(`/orders?cohort_bucket=paid%2Clabel&${WIN}`);
    // the sources in display order; all six = no filter; an unknown key is never sent
    expect(cohortHref('total', ['social', 'teleshop_other'], range)).toBe(`/orders?cohort_bucket=total&cohort_source=teleshop_other%2Csocial&${WIN}`);
    expect(cohortHref('total', ['teleshop_other', 'teleshop_out', 'elyon_crm'], range))
      .toBe(`/orders?cohort_bucket=total&cohort_source=elyon_crm%2Cteleshop_out%2Cteleshop_other&${WIN}`);
    expect(cohortHref('total', ['web', 'social', 'teleshop_other', 'teleshop_out', 'elyon_crm', 'altercpa'], range)).toBe(`/orders?cohort_bucket=total&${WIN}`);
    expect(cohortHref('total', ['web', 'social', 'teleshop_other', 'elyon_crm', 'altercpa'], range))
      .toBe(`/orders?cohort_bucket=total&cohort_source=altercpa%2Celyon_crm%2Cteleshop_other%2Csocial%2Cweb&${WIN}`);
    expect(cohortHref('total', ['teleshop', 'social'], range)).toBe(`/orders?cohort_bucket=total&cohort_source=social&${WIN}`);
  });
  it('MEX-only splits and counts come from the api’s kinds', () => {
    const c = fixture();
    expect(mexOnlyCount(row(c, 'teleshop_other'))).toBe(669);
    expect(mexOnlyCount(row(c, 'teleshop_out'))).toBe(40);
    expect(mexOnlyCount(row(c, 'social'))).toBe(31);
    expect(mexOnlyCount(row(c, 'altercpa'))).toBe(0);
    expect(isMexOnlySplit({ key: 'elyon_unlinked', kind: 'mex' })).toBe(true);
    // 9103 (Affiliate – Lead out) and 9102 (Телешоп – Lead out) parcels with no order, by key alone too
    expect(isMexOnlySplit('mex_leads_out')).toBe(true);
    expect(isMexOnlySplit('mex_out')).toBe(true);
    expect(isMexOnlySplit({ key: 'bridge', kind: 'order' })).toBe(false);
    expect(isMexOnlySplit('mex_teleshop')).toBe(true);
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
    expect(s.total.orders).toBe(507);
    expect(s.cash_flow.parcels).toBe(c.cash_flow.parcels);
    expect(c.meta.money).toBe(true); // the input is untouched
  });
});
