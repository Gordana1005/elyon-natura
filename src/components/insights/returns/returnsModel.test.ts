import { describe, expect, it } from 'vitest';
import type { ReturnsResponse, StockProductRow, StockResponse } from '@/lib/insightsApi/returnsStock';
import returnsSample from './__fixtures__/returns.sample.json';
import stockSample from '../stock/__fixtures__/stock.sample.json';
import {
  cityName, drillSourcesOf, filterProducts, queueDrill, ratePp, returnsColumns, rsDrill, slowMovers, topMovers,
} from './returnsModel';

const R = returnsSample as unknown as ReturnsResponse;
const S = stockSample as unknown as StockResponse;
const range = { from: '2026-09-01', to: '2026-09-27' };
const params = (href: string) => Object.fromEntries(new URLSearchParams(href.split('?')[1]));

describe('rsDrill', () => {
  it('an all-orders number opens exactly its orders', () => {
    const d = rsDrill({ clock: 'sale', bucket: 'returned', comp: { orders: 67 }, count: 67, sources: ['elyon_crm'], range });
    expect(d.blocked).toBeNull();
    expect(d.href).toMatch(/^\/orders\?/);
    expect(params(d.href!)).toEqual({ cohort_bucket: 'returned', cohort_source: 'elyon_crm', sold_from: '2026-09-01', sold_to: '2026-09-27' });
  });

  it('a mixed number has no link of its own but offers its order part', () => {
    const d = rsDrill({ clock: 'sale', bucket: 'returned', comp: R.kpis.returned, count: R.kpis.returned.count, sources: [], range });
    expect(d.href).toBeNull();
    expect(d.blocked).toBe('mixed');
    expect(d.orders).toBe(R.kpis.returned.orders);
    // every source at once sends no cohort_source (the api's own links do the same)
    expect(params(d.ordersHref!)).toEqual({ cohort_bucket: 'returned', sold_from: '2026-09-01', sold_to: '2026-09-27' });
  });

  it('adds exact filters (a seller) and never links the MEX-return-day clock', () => {
    const d = rsDrill({ clock: 'sale', bucket: 'returned', comp: { orders: 3 }, count: 3, sources: [], range,
      extra: { sold_by_person_id: '00000000-0000-4000-8000-000000000001' } });
    expect(params(d.href!).sold_by_person_id).toBe('00000000-0000-4000-8000-000000000001');
    const m = rsDrill({ clock: 'returned', bucket: 'returned', comp: { orders: 3 }, count: 3, sources: [], range });
    expect(m).toMatchObject({ href: null, ordersHref: null, blocked: 'mex_day' });
    expect(rsDrill({ clock: 'sale', bucket: 'returned', comp: { orders: 0 }, count: 0, sources: [], range }).blocked).toBe('none');
  });

  it('web-only and MEX-only numbers say why', () => {
    expect(rsDrill({ clock: 'sale', bucket: 'returned', comp: { web: 2 }, count: 2, sources: ['web'], range }).blocked).toBe('web');
    expect(rsDrill({ clock: 'sale', bucket: 'returned', comp: { mex_only: 2 }, count: 2, sources: [], range }).blocked).toBe('mex_only');
  });

  it('filters /orders by the selected cohort sources (collabBox is two: Social media, Teleshop / other)', () => {
    expect(drillSourcesOf([])).toHaveLength(5);
    const soc = rsDrill({ clock: 'sale', bucket: 'returned', comp: { orders: 2 }, count: 2, sources: ['social'], range });
    expect(params(soc.href!).cohort_source).toBe('social');
    const two = rsDrill({ clock: 'sale', bucket: 'returned', comp: { orders: 2 }, count: 2, sources: ['teleshop_other', 'altercpa'], range });
    expect(params(two.href!).cohort_source).toBe('altercpa,teleshop_other');
    expect(params(two.href!).sale_source).toBeUndefined();
  });
});

describe('queueDrill', () => {
  it('lists the to-pack orders of one age by the sale days it covers', () => {
    const pack = S.queue.find((q) => q.stage === 'to_pack')!;
    const age = pack.ages.find((a) => a.key === '8_14')!;
    const d = queueDrill('to_pack', age, []);
    const p = params(d.href ?? d.ordersHref!);
    expect(p).toMatchObject({ cohort_bucket: 'to_pack', sold_from: age.from, sold_to: age.to });
    expect(age.from <= age.to).toBe(true);
  });
});

describe('returnsColumns', () => {
  it('sale clock: closed + open + returned = the day\'s sales', () => {
    for (const c of returnsColumns(R.trend, 'sale')) {
      expect(c.segs.map((s) => s.key)).toEqual(['closed', 'open', 'returned']);
      expect(c.segs.reduce((a, s) => a + s.value, 0)).toBe(c.total);
    }
  });
  it('MEX clock: delivered + returned, no open part', () => {
    const cols = returnsColumns([{ d: '2026-09-01', base: 10, returned: 3, open: 0 }], 'returned');
    expect(cols[0].segs).toEqual([{ key: 'closed', value: 7 }, { key: 'returned', value: 3 }]);
  });
});

describe('small rules', () => {
  it('ratePp: the change in percentage points', () => {
    expect(ratePp(0.1018, 0.1441)).toBe(-4.2);
    expect(ratePp(0.2, null)).toBeNull();
  });
  it('cityName: Cyrillic for mk / bg, Latin for en, Albanian for sq', () => {
    const row = { key: 'skopje', name: 'Скопје', name_lat: 'Skopje', name_sq: 'Shkup' };
    expect(cityName(row, 'mk')).toBe('Скопје');
    expect(cityName(row, 'bg')).toBe('Скопје');
    expect(cityName(row, 'en')).toBe('Skopje');
    expect(cityName(row, 'sq')).toBe('Shkup');
    expect(cityName({ ...row, name_sq: null }, 'sq')).toBe('Skopje');
  });
});

describe('stock rules', () => {
  const rows = S.products as StockProductRow[];
  it('top movers: by units, with the change against the previous period', () => {
    const top = topMovers(rows, 5);
    expect(top).toHaveLength(5);
    for (let i = 1; i < top.length; i++) expect(top[i - 1].row.units).toBeGreaterThanOrEqual(top[i].row.units);
    expect(top[0].delta).toBe(top[0].row.units - (top[0].row.units_prev ?? 0));
  });
  it('slow movers: only tracked catalogue products that hold stock, fewest units first', () => {
    const slow = slowMovers(rows, 10);
    for (const r of slow) expect(r.catalogue && r.tracked && (r.on_hand ?? 0) > 0).toBe(true);
    for (let i = 1; i < slow.length; i++) expect(slow[i - 1].units).toBeLessThanOrEqual(slow[i].units);
  });
  it('filterProducts: name / SKU search, catalogue-only, sort', () => {
    const hit = filterProducts(rows, 'adenofrin', 'units');
    expect(hit.length).toBeGreaterThan(0);
    expect(hit.every((r) => String(r.name).toLowerCase().includes('adenofrin') || String(r.sku).toLowerCase().includes('adenofrin'))).toBe(true);
    expect(filterProducts(rows, '', 'units', true).every((r) => r.catalogue)).toBe(true);
    const byQueue = filterProducts(rows, '', 'queue');
    expect(byQueue[0].queue_units).toBe(Math.max(...rows.map((r) => r.queue_units)));
  });
});
