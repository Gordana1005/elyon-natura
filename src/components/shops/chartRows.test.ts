import { beforeAll, describe, expect, it } from 'vitest';
import i18n from '@/i18n';
import type { ShopsDay, ShopsPeriod } from '@/lib/shopsTypes';
import day from './__fixtures__/day.owner.json';
import period from './__fixtures__/period.owner.json';
import { chartRows } from './chartRows';
import { stripShopsMoney } from './shopsModel';
import type { ShopsSummary } from './useShopsData';

const D = day as unknown as ShopsDay;
const P = period as unknown as ShopsPeriod;
const asDay = (d: ShopsDay, live: boolean): ShopsSummary => ({ kind: 'day', day: d, shops: d.shops, totals: d.totals, freshness: d.freshness, live });
const asPeriod = (p: ShopsPeriod): ShopsSummary => ({ kind: 'period', period: p, shops: p.shops, totals: p.totals, freshness: p.freshness, live: false });

beforeAll(async () => { await i18n.changeLanguage('mk'); });

describe('chart rows', () => {
  it('a live day: 08–14 on the Skopje clock, the running hour marked, sales for owners', () => {
    const rows = chartRows(asDay(D, true), '2026-10-02', new Date('2026-10-02T12:20:00Z'));
    expect(rows.map((r) => r.label)).toEqual(['8', '9', '10', '11', '12', '13', '14']);
    expect(rows[0].long).toBe('08:00–09:00');
    expect(rows.filter((r) => r.partial).map((r) => r.label)).toEqual(['14']);
    expect(rows.reduce((a, r) => a + (r.sales_mkd ?? 0), 0)).toBe(D.totals.sales_mkd);
  });
  it('a closed day runs to closing time with nothing marked; a manager gets no sales', () => {
    const rows = chartRows(asDay(stripShopsMoney(D), false), '2026-10-02');
    expect(rows[rows.length - 1].label).toBe('21');
    expect(rows.some((r) => r.partial)).toBe(false);
    expect(rows.some((r) => 'sales_mkd' in r)).toBe(false);
  });
  it('a period: one bar per day, dd.MM on the axis, the weekday in the long label', () => {
    const rows = chartRows(asPeriod(P), '2026-10-02');
    expect(rows).toHaveLength(30);
    expect(rows[0].label).toBe('01.09');
    expect(rows[0].long).toMatch(/01\.09\.2026$/);
    expect(rows.some((r) => r.partial)).toBe(false);
    expect(chartRows(asPeriod(P), '2026-09-30').filter((r) => r.partial).map((r) => r.key)).toEqual(['2026-09-30']);
  });
});
