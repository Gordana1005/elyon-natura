import { describe, expect, it } from 'vitest';
import type { PLRow, ProfitProduct } from '@/lib/insightsApi/profit';
import {
  floorPrice, floorStatus, packageBonusRate, productUnit, simPriceFor, simulate, sortProducts, stripRows, totalCosts, waterfall,
} from './profitModel';

const row = (x: Partial<PLRow> = {}): PLRow => ({
  key: 'total', sales: 10, revenue_mkd: 30000, card_mkd: 0, vat_mkd: 4576, cogs_known_mkd: 4000, cogs_est_mkd: 2000,
  courier_mkd: 1500, returns_mkd: 0, commission_mkd: 1230, lead_cost_mkd: 0, net_mkd: 16694, net_upper_mkd: 18694,
  margin: 16694 / 30000, costed: { revenue_mkd: 20000, net_mkd: 10794, margin: 10794 / 20000 },
  revenue_costed_mkd: 20000, revenue_uncosted_mkd: 10000, revenue_other_mkd: 0, packages: 30, free_packages: 0,
  packages_costed: 20, packages_uncosted: 10, coverage_packages: 2 / 3, coverage_revenue: 2 / 3, parcels_delivered: 10,
  parcels_returned: 3, returned: 3, returned_mkd: 9000, return_rate: 3 / 13, aov_mkd: 3000, cost_per_sale_mkd: 1331,
  profit_per_sale_mkd: 1669, packages_per_sale: 3, ...x,
});

const prod = (x: Partial<ProfitProduct>): ProfitProduct => ({
  key: 'p:a', name: 'A', kind: 'product', reviewed: false, package: true, sources: ['altercpa'], sales: 10, packages: 20,
  free_packages: 0, revenue_mkd: 20000, cost_known: true, unit_cost_mkd: 180, cogs_mkd: 3600, cogs_est_mkd: null,
  vat_mkd: 3051, courier_mkd: 1500, commission_mkd: 615, commission_share: 0.25, net_mkd: 11234, margin: 0.5617,
  returned_packages: 2, returned_mkd: 2000, return_rate: 2 / 22, ...x,
});

describe('waterfall', () => {
  it('runs from revenue through every cost to the server net (estimated basis)', () => {
    const s = waterfall(row(), 'estimated', 0.18);
    expect(s.map((x) => x.key)).toEqual(['revenue', 'vat', 'cogs_known', 'cogs_est', 'courier', 'returns', 'commission', 'lead', 'net']);
    expect(s[0]).toMatchObject({ value: 30000, from: 0, to: 30000 });
    expect(s[1]).toMatchObject({ value: -4576, from: 30000, to: 25424 });
    expect(s.find((x) => x.key === 'cogs_est')!.estimate).toBe(true);
    expect(s.find((x) => x.key === 'lead')!.pending).toBe(true);
    const last = s[s.length - 2];
    expect(last.to).toBe(30000 - totalCosts(row()));
    expect(s[s.length - 1].value).toBe(16694);
  });

  it('with nothing to estimate from, the estimate step is not drawn', () => {
    expect(waterfall(row({ cogs_est_mkd: null }), 'estimated', 0.18).some((x) => x.key === 'cogs_est')).toBe(false);
  });

  it('costed basis: costed revenue, its own VAT, allocated costs, no estimate', () => {
    const s = waterfall(row(), 'costed', 0.18);
    expect(s[0].value).toBe(20000);
    expect(s.find((x) => x.key === 'vat')!.value).toBe(-Math.round(20000 * 0.18 / 1.18));
    expect(s.find((x) => x.key === 'courier')).toMatchObject({ value: -1000, estimate: true });
    expect(s.some((x) => x.key === 'cogs_est')).toBe(false);
    expect(s[s.length - 1].value).toBe(10794);
  });
});

describe('products', () => {
  it('search and sort, unknown values last', () => {
    const rows = [prod({ key: 'a', name: 'Alpha', margin: 0.2 }), prod({ key: 'b', name: 'Beta', margin: null }), prod({ key: 'c', name: 'Gamma', margin: 0.5 })];
    expect(sortProducts(rows, 'margin').map((p) => p.key)).toEqual(['c', 'a', 'b']);
    expect(sortProducts(rows, 'revenue', 'ET').map((p) => p.key)).toEqual(['b']);
  });

  it('per-package economics on the P&L basis; unknown cost = no net, never "clears"', () => {
    const u = productUnit(prod({}))!;
    expect(u.price).toBe(1000);
    expect(u.cost).toBe(180);
    expect(u.net).toBeCloseTo(1000 - 3051 / 20 - 180 - 75 - 615 / 20, 6);
    expect(floorStatus(u, 430)).toBe('clears');
    expect(floorStatus(u, 900)).toBe('below');
    const unknown = productUnit(prod({ cost_known: false, unit_cost_mkd: null, cogs_mkd: 0 }))!;
    expect(unknown.net).toBeNull();
    expect(floorStatus(unknown, 0)).toBe('no_cost');
    expect(productUnit(prod({ packages: 0 }))).toBeNull();
  });
});

describe('floor price', () => {
  it('nets exactly the target at the tier it lands in', () => {
    const P = floorPrice(180, 75, 430, 0.18, 1)!;
    const tier = packageBonusRate(P / 61.5);
    const net = P - P * 0.18 / 1.18 - 180 - 75 - tier * 61.5;
    expect(net).toBeCloseTo(430, 6);
    expect(floorPrice(null, 75, 430, 0.18, 1)).toBeNull();
  });

  it('a product nobody earns commission on needs a lower floor', () => {
    expect(floorPrice(180, 75, 430, 0.18, 0)!).toBeLessThan(floorPrice(180, 75, 430, 0.18, 1)!);
  });
});

describe('simulator', () => {
  const base = {
    price: 3000, paidPackages: 3, bonusPackages: 1, costPerPackage: 180, deliverMkd: 150, returnMkd: 0,
    returnRate: 0.1, vatRate: 0.18, commissionShare: 1, leadCostMkd: 0,
  };
  it('one delivered order and the expected order after returns', () => {
    const r = simulate(base);
    expect(r.packages).toBe(4);
    expect(r.perPackagePrice).toBe(750);
    const commission = 4 * packageBonusRate(750 / 61.5) * 61.5;
    const delivered = 3000 - 3000 * 0.18 / 1.18 - 720 - 150 - commission;
    expect(r.netDelivered).toBeCloseTo(delivered, 6);
    expect(r.netExpected).toBeCloseTo(0.9 * delivered, 6);
    expect(simulate({ ...base, costPerPackage: null }).netExpected).toBeNull();
  });

  it('solves the order price for a per-package target', () => {
    const p = simPriceFor(base, 430)!;
    expect(simulate({ ...base, price: p }).netPerPackage!).toBeGreaterThanOrEqual(430 - 1e-6);
    expect(simulate({ ...base, price: p - 5 }).netPerPackage!).toBeLessThan(430);
  });
});

describe('the strip as CohortBar rows', () => {
  it('keeps each source block and adds empty leads', () => {
    const t = { count: 1, value_mkd: 100, cod_mkd: 100, orders: 1, web: 0, mex_only: 0 };
    const rows = stripRows({ total: t, buckets: [], outside: [], by_source: [{ key: 'web', total: t, buckets: [], outside: [] }] });
    expect(rows[0]).toMatchObject({ key: 'web', total: t, splits: [] });
    expect(rows[0].leads_in.came_in).toBe(0);
  });
});
