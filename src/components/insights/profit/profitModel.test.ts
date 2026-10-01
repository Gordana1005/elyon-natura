import { describe, expect, it } from 'vitest';
import type { PLRow, ProfitProduct } from '@/lib/insightsApi/profit';
import type { ProfitResponse } from '@/lib/insightsApi/profit';
import {
  costSource, defaultVatRate, extraGoods, floorPrice, floorStatus, packageBonusRate, productUnit, productVatRate, simPriceFor, simulate, sortProducts,
  stripRows, totalCosts, vatPerProduct, waterfall,
} from './profitModel';

// VAT per product from Sigma (01.10.2026): 5 % supplements, 18 % cosmetics
const S5 = 0.05 / 1.05, S18 = 0.18 / 1.18;

const row = (x: Partial<PLRow> = {}): PLRow => ({
  key: 'total', sales: 10, revenue_mkd: 30000, card_mkd: 0, vat_mkd: 1953, cogs_known_mkd: 4000, cogs_est_mkd: 2000,
  vat_costed_mkd: 952, vat_split: [{ rate: 0.05, revenue_mkd: 25000, vat_mkd: 1190 }, { rate: 0.18, revenue_mkd: 5000, vat_mkd: 763 }],
  vat_unclassified: { revenue_mkd: 1000, vat_mkd: 48 },
  courier_mkd: 1500, returns_mkd: 0, commission_mkd: 1230, lead_cost_mkd: 0, net_mkd: 19317, net_upper_mkd: 21317,
  margin: 19317 / 30000, costed: { revenue_mkd: 20000, net_mkd: 12418, margin: 12418 / 20000 },
  revenue_costed_mkd: 20000, revenue_uncosted_mkd: 10000, revenue_other_mkd: 0, packages: 30, free_packages: 0,
  packages_costed: 20, packages_uncosted: 10, coverage_packages: 2 / 3, coverage_revenue: 2 / 3, parcels_delivered: 10,
  parcels_returned: 3, returned: 3, returned_mkd: 9000, return_rate: 3 / 13, aov_mkd: 3000, cost_per_sale_mkd: 1331,
  profit_per_sale_mkd: 1669, packages_per_sale: 3, ...x,
});

const prod = (x: Partial<ProfitProduct>): ProfitProduct => ({
  key: 'p:a', name: 'A', kind: 'product', reviewed: false, package: true, sources: ['altercpa'], sales: 10, packages: 20,
  free_packages: 0, revenue_mkd: 20000, cost_known: true, unit_cost_mkd: 180, cogs_mkd: 3600, cogs_est_mkd: null,
  vat_mkd: 952, vat_rate: 0.05, vat_classified: true, courier_mkd: 1500, commission_mkd: 615, commission_share: 0.25, net_mkd: 13333, margin: 0.6667,
  returned_packages: 2, returned_mkd: 2000, return_rate: 2 / 22, ...x,
});

describe('waterfall', () => {
  it('runs from revenue through every cost to the server net (estimated basis)', () => {
    const s = waterfall(row(), 'estimated', 0.05);
    expect(s.map((x) => x.key)).toEqual(['revenue', 'vat', 'cogs_known', 'cogs_est', 'courier', 'returns', 'commission', 'lead', 'net']);
    expect(s[0]).toMatchObject({ value: 30000, from: 0, to: 30000 });
    expect(s[1]).toMatchObject({ value: -1953, from: 30000, to: 28047 });   // the server's per-product VAT, as sent
    expect(s.find((x) => x.key === 'cogs_est')!.estimate).toBe(true);
    expect(s.find((x) => x.key === 'lead')!.pending).toBe(true);
    const last = s[s.length - 2];
    expect(last.to).toBe(30000 - totalCosts(row()));
    expect(s[s.length - 1].value).toBe(19317);
  });

  it('with nothing to estimate from, the estimate step is not drawn', () => {
    expect(waterfall(row({ cogs_est_mkd: null }), 'estimated', 0.05).some((x) => x.key === 'cogs_est')).toBe(false);
  });

  it('costed basis: costed revenue, ITS OWN per-product VAT, allocated costs, no estimate', () => {
    const s = waterfall(row(), 'costed', 0.05);
    expect(s[0].value).toBe(20000);
    expect(s.find((x) => x.key === 'vat')!.value).toBe(-952);
    expect(s.find((x) => x.key === 'courier')).toMatchObject({ value: -1000, estimate: true });
    expect(s.some((x) => x.key === 'cogs_est')).toBe(false);
    expect(s[s.length - 1].value).toBe(12418);
  });

  it('an api older than 01.10 (no costed VAT): the costed VAT falls back to the default rate', () => {
    const s = waterfall(row({ vat_costed_mkd: undefined }), 'costed', 0.05);
    expect(s.find((x) => x.key === 'vat')!.value).toBe(-Math.round(20000 * S5));
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
    expect(u.vat).toBeCloseTo(952 / 20, 9);                          // the product's own VAT per package
    expect(u.net).toBeCloseTo(1000 - 952 / 20 - 180 - 75 - 615 / 20, 6);
    expect(floorStatus(u, 430)).toBe('clears');
    expect(floorStatus(u, 900)).toBe('below');
    const unknown = productUnit(prod({ cost_known: false, unit_cost_mkd: null, cogs_mkd: 0 }))!;
    expect(unknown.net).toBeNull();
    expect(floorStatus(unknown, 0)).toBe('no_cost');
    expect(productUnit(prod({ packages: 0 }))).toBeNull();
  });
});

describe('floor price (the product\'s own VAT rate)', () => {
  it('nets exactly the target at the tier it lands in — supplement (5 %) and cosmetic (18 %)', () => {
    for (const [r, share] of [[0.05, S5], [0.18, S18]] as const) {
      const P = floorPrice(180, 75, 430, r, 1)!;
      const tier = packageBonusRate(P / 61.5);
      expect(P - P * share - 180 - 75 - tier * 61.5).toBeCloseTo(430, 6);
    }
    expect(floorPrice(null, 75, 430, 0.05, 1)).toBeNull();
  });

  it('a supplement at 5 % needs a lower floor than the same costs at 18 %', () => {
    expect(floorPrice(180, 75, 430, 0.05, 1)!).toBeLessThan(floorPrice(180, 75, 430, 0.18, 1)!);
  });

  it("the product's rate, else the default; the meta says how VAT was computed", () => {
    expect(productVatRate(prod({ vat_rate: 0.18 }), 0.05)).toBe(0.18);
    expect(productVatRate(prod({ vat_rate: null }), 0.05)).toBe(0.05);
    expect(productVatRate(prod({ vat_rate: undefined }), 0.05)).toBe(0.05);
    const meta = (vat: ProfitResponse['meta']['vat']) => ({ vat }) as ProfitResponse['meta'];
    expect(defaultVatRate(meta({ mode: 'per_product_sigma', default_rate: 0.05, rate: 0.05, confirmed: true }))).toBe(0.05);
    expect(vatPerProduct(meta({ mode: 'per_product_sigma', default_rate: 0.05, rate: 0.05, confirmed: true }))).toBe(true);
    // an api older than 01.10.2026 sends {rate, confirmed} only
    expect(defaultVatRate(meta({ rate: 0.18, confirmed: true }))).toBe(0.18);
    expect(vatPerProduct(meta({ rate: 0.18, confirmed: true }))).toBe(false);
  });

  it('a product nobody earns commission on needs a lower floor', () => {
    expect(floorPrice(180, 75, 430, 0.05, 0)!).toBeLessThan(floorPrice(180, 75, 430, 0.05, 1)!);
  });
});

describe('simulator', () => {
  const base = {
    price: 3000, paidPackages: 3, bonusPackages: 1, costPerPackage: 180, deliverMkd: 150, returnMkd: 0,
    returnRate: 0.1, vatRate: 0.05, commissionShare: 1, leadCostMkd: 0,
  };
  it('one delivered order and the expected order after returns', () => {
    const r = simulate(base);
    expect(r.packages).toBe(4);
    expect(r.perPackagePrice).toBe(750);
    const commission = 4 * packageBonusRate(750 / 61.5) * 61.5;
    const delivered = 3000 - 3000 * S5 - 720 - 150 - commission;
    expect(r.netDelivered).toBeCloseTo(delivered, 6);
    expect(r.netExpected).toBeCloseTo(0.9 * delivered, 6);
    expect(simulate({ ...base, costPerPackage: null }).netExpected).toBeNull();
    // the same bundle of a cosmetic (18 %) leaves less
    expect(simulate({ ...base, vatRate: 0.18 }).netDelivered!).toBeCloseTo(delivered - 3000 * (S18 - S5), 6);
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

describe('Sigma purchase costs (owner 01.10.2026)', () => {
  it('the extra packed goods are a step of both bases, after the product cost', () => {
    const r = row({ cogs_extra_mkd: 300, net_mkd: 19017, costed: { revenue_mkd: 20000, net_mkd: 12118, margin: 12118 / 20000 } });
    const s = waterfall(r, 'estimated', 0.05);
    expect(s.map((x) => x.key)).toEqual(['revenue', 'vat', 'cogs_known', 'cogs_est', 'cogs_extra', 'courier', 'returns', 'commission', 'lead', 'net']);
    expect(s.find((x) => x.key === 'cogs_extra')).toMatchObject({ value: -300 });
    expect(s.find((x) => x.key === 'cogs_extra')!.estimate).toBeFalsy();
    expect(waterfall(r, 'costed', 0.05).some((x) => x.key === 'cogs_extra')).toBe(true);
    expect(totalCosts(r)).toBe(totalCosts(row()) + 300);
    // Phase B off / an older api: no step, nothing added
    expect(waterfall(row(), 'estimated', 0.05).some((x) => x.key === 'cogs_extra')).toBe(false);
    expect(extraGoods(row())).toBe(0);
  });

  it("a package's cost carries its share of the packed gifts", () => {
    const u = productUnit(prod({ cogs_extra_mkd: 200 }))!;
    expect(u.cost).toBe((3600 + 200) / 20);
  });

  it('the cost source: Sigma when the api says so, else the legacy catalogue', () => {
    const meta = { vat: { rate: 0.05, confirmed: true } } as unknown as ProfitResponse['meta'];
    expect(costSource(meta)).toBe('legacy');
    expect(costSource({ ...meta, cost: { source: 'sigma' } } as unknown as ProfitResponse['meta'])).toBe('sigma');
  });
});
