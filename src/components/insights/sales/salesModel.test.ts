import { describe, expect, it } from 'vitest';
import type { SalesCore, SalesDetail } from '@/lib/insightsApi/sales';
import coreSample from './__fixtures__/sales.core.sample.json';
import detailSample from './__fixtures__/sales.detail.sample.json';
import prevSample from './__fixtures__/sales.prev.sample.json';
import {
  asCohortRows, channelViews, cityName, detailQuality, heatGrid, hourSpan, isPartialBucket, outcomeOf, paidRate,
  prevHeadline, productViews, returnRate, seriesKey, sourceViews, trendRows, trendSources,
} from './salesModel';

const core = () => ({ ...structuredClone(coreSample), prev: structuredClone(prevSample) }) as unknown as SalesCore;
const detail = () => structuredClone(detailSample) as unknown as SalesDetail;

describe('outcome rates', () => {
  it('paid counts ruling / legacy paid; returns divide by the CLOSED sales only', () => {
    const o = outcomeOf({ count: 10 }, [
      { key: 'paid', count: 5 }, { key: 'paid_legacy', count: 1 }, { key: 'returned', count: 2 },
      { key: 'courier', count: 1 }, { key: 'to_pack', count: 1 },
    ] as SalesCore['buckets']);
    expect(o).toMatchObject({ paid: 6, returned: 2, inFlight: 2, toPack: 1 });
    expect(paidRate(o)).toBeCloseTo(0.6);
    expect(returnRate(o)).toBeCloseTo(2 / 8);
  });
  it('nothing to divide by → null, never 0 %', () => {
    const o = outcomeOf({ count: 0 }, []);
    expect(paidRate(o)).toBeNull();
    expect(returnRate(o)).toBeNull();
  });
});

describe('sources', () => {
  it('five rows in the fixed order, Σ = the header, shares by денари for owners', () => {
    const c = core();
    const v = sourceViews(c, true);
    expect(v.map((x) => x.key)).toEqual(['altercpa', 'elyon_crm', 'teleshop_other', 'social', 'web']);
    expect(v.reduce((a, x) => a + x.count, 0)).toBe(c.total.count);
    expect(v.reduce((a, x) => a + (x.value ?? 0), 0)).toBe(c.total.value_mkd);
    expect(v.reduce((a, x) => a + (x.share ?? 0), 0)).toBeCloseTo(1, 6);
    const alter = v[0];
    expect(alter.avg).toBeCloseTo(alter.value! / alter.count);
    expect(alter.prevCount).toBe(c.prev!.by_source.find((s) => s.key === 'altercpa')!.total.count);
  });
  it('a non-owner: no value, shares by count', () => {
    const v = sourceViews(core(), false);
    expect(v.every((x) => x.value == null && x.avg == null)).toBe(true);
    expect(v.reduce((a, x) => a + (x.share ?? 0), 0)).toBeCloseTo(1, 6);
  });
  it('rows the cohort helpers accept (an empty funnel)', () => {
    const rows = asCohortRows(core().by_source);
    expect(rows[0].leads_in.came_in).toBe(0);
    expect(rows[0].buckets).toHaveLength(8);
  });
  it('the previous headline carries money only when sent', () => {
    const pt = (prevSample as { total: { count: number; value_mkd: number } }).total;
    expect(prevHeadline(core().prev)).toMatchObject({ count: pt.count, value_mkd: pt.value_mkd });
    expect(prevHeadline(null)).toBeNull();
    expect(prevHeadline({ total: { count: 3 }, buckets: [], by_source: [] })).toEqual({ count: 3 });
  });
});

describe('trend', () => {
  it('Σ of every row = the header; sources that sold nothing drop out', () => {
    const c = core();
    const byCount = trendRows(c.trend.points, false);
    expect(byCount.reduce((a, r) => a + r.total, 0)).toBe(c.total.count);
    const byValue = trendRows(c.trend.points, true);
    expect(byValue.reduce((a, r) => a + r.total, 0)).toBe(c.total.value_mkd);
    expect(trendSources(byCount)).toEqual(['altercpa', 'elyon_crm', 'teleshop_other', 'social', 'web']);
    expect(trendSources([{ d: '2026-09-01', total: 1, altercpa: 1, web: 0 }])).toEqual(['altercpa']);
  });
  it('a week or month that sticks out of the period is partial', () => {
    expect(isPartialBucket('2026-08-31', 'week', '2026-09-01', '2026-09-27')).toBe(true);
    expect(isPartialBucket('2026-09-07', 'week', '2026-09-01', '2026-09-27')).toBe(false);
    expect(isPartialBucket('2026-09-01', 'month', '2026-09-01', '2026-09-27')).toBe(true);
    expect(isPartialBucket('2026-08-01', 'month', '2026-08-01', '2026-09-27')).toBe(false);
    expect(isPartialBucket('2026-09-03', 'day', '2026-09-01', '2026-09-27')).toBe(false);
  });
});

describe('products and cities', () => {
  it('product shares add up over the whole product table (top + others)', () => {
    const d = detail();
    const s = d.products.summary;
    const v = productViews(d.products.rows, s, true);
    const top = v.reduce((a, r) => a + (r.value_mkd ?? 0), 0);
    expect(top + (d.products.others.value_mkd ?? 0)).toBe(s.value_mkd);
    const adenofrin = v.find((r) => r.name === 'Adenofrin')!;
    // the 1.000 / 750 typing slips are not packages
    expect(adenofrin.units).toBeLessThan(1500);
    expect(adenofrin.perUnit).toBeCloseTo(adenofrin.value_mkd! / adenofrin.units);
    expect(productViews(d.products.rows, s, false).every((r) => r.perUnit == null)).toBe(true);
  });
  it('a city reads in the reader\'s script', () => {
    const c = { name: 'Скопје', name_lat: 'Skopje' };
    expect(cityName(c, 'mk')).toBe('Скопје');
    expect(cityName(c, 'bg')).toBe('Скопје');
    expect(cityName(c, 'en')).toBe('Skopje');
    expect(cityName(c, 'sq')).toBe('Skopje');
  });
  it('Skopje is ONE row (Latin, Cyrillic and MEX zones folded)', () => {
    const rows = detail().cities.rows;
    expect(rows.filter((r) => /skopje|скопје/i.test(`${r.name} ${r.name_lat}`))).toHaveLength(1);
    expect(rows[0].spellings).toBeGreaterThan(1);
  });
});

describe('channels', () => {
  it('series keys are safe i18n keys', () => {
    expect(seriesKey('9110')).toBe('s9110');
    expect(seriesKey('ntmk')).toBe('ntmk');
    expect(seriesKey('none')).toBe('none');
    expect(seriesKey('weird.key')).toBe('other');
  });
  it('rows add up to the header and carry their rates', () => {
    const c = core();
    const v = channelViews(c.channels, c.total.count);
    expect(v.reduce((a, r) => a + r.count, 0)).toBe(c.total.count);
    expect(v[v.length - 1].series).toBe('none');
  });
});

describe('weekday × hour', () => {
  it('cells, peak and steps', () => {
    const g = heatGrid({
      cells: [{ dow: 1, hour: 9, count: 10 }, { dow: 3, hour: 14, count: 2 }, { dow: 9, hour: 1, count: 99 }],
      timed: 12, untimed: [], weekdays: [],
    });
    expect(g.max).toBe(10);
    expect(g.peak).toEqual({ dow: 1, hour: 9, count: 10 });
    expect(g.step(0)).toBe(0);
    expect(g.step(10)).toBe(5);
    expect(g.step(2)).toBe(1);
    expect(g.byHour[9]).toBe(10);
    expect(g.byDow[2]).toBe(2);
  });
  it('the fixture grid holds exactly the timed sales', () => {
    const c = core();
    const g = heatGrid(c.timing);
    expect(g.byDow.reduce((a, n) => a + n, 0)).toBe(c.timing.timed);
  });
  it('the hour span always covers the working day', () => {
    expect(hourSpan(Array(24).fill(0))).toEqual([8, 20]);
    const h = Array(24).fill(0); h[6] = 1; h[22] = 1;
    expect(hourSpan(h)).toEqual([6, 22]);
  });
});

describe('quality items', () => {
  it('only items above zero; money only when sent', () => {
    const items = detailQuality(detail());
    expect(items.map((i) => i.kind)).toEqual(expect.arrayContaining(['unmapped_products', 'bad_qty', 'auto_lines']));
    expect(items.every((i) => i.count > 0)).toBe(true);
    expect(detailQuality(undefined)).toEqual([]);
  });
});
