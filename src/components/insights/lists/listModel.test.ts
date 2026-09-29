import { beforeAll, describe, expect, it } from 'vitest';
import i18n from '@/i18n';
import type { ListsResponse } from '@/lib/insightsApi/lists';
import sample from './__fixtures__/lists.sample.json';
import {
  aovOf, conversionOf, groupKeyOf, groupLists, isQuiet, listLabel, listsDrill, listsHref, reachOf, recencyValueMatrix,
  returnRateOf, rollup, salesPerHourOf, sortRows, staleSoldTo, trendRows, viewOf,
} from './listModel';

const data = sample as unknown as ListsResponse;
const views = viewOf(data.lists);
const t = (k: string, o?: Record<string, unknown>) => i18n.t(k, o) as string;
const RANGE = { from: '2026-09-01', to: '2026-09-27' };

beforeAll(async () => { await i18n.changeLanguage('mk'); });

describe('listLabel — display only, the stored name stays the key', () => {
  it('reads a band list in the reader\'s language, EUR band in денари', () => {
    expect(listLabel(t, '57d 26+ (1-3 orders)')).toBe('57–120 дена · над 1.599 ден · 1–3 нарачки');
    expect(listLabel(t, '21d ≤26 (7+ orders)')).toBe('21–57 дена · до 1.599 ден · 7+ нарачки');
    expect(listLabel(t, 'NEWCOMERS (3+ orders)')).toBe('Нови купувачи · 3+ нарачки');
    expect(listLabel(t, 'Current Cancels')).toBe('Скорешни откажувања (14 дена)');
    expect(listLabel(t, 'Trash List')).toBe('Корпа');
  });

  it('shows an unknown name as stored (a campaign, a hand-made list)', () => {
    expect(listLabel(t, 'Spring campaign')).toBe('Spring campaign');
    expect(listLabel(t, null)).toBe('');
  });

  it('never prints the English engine words or a euro threshold', () => {
    for (const r of views) {
      const l = listLabel(t, r.name, r.parsed);
      expect(l).not.toMatch(/orders\)|NEWCOMERS|Current |Never-Converted|Trash List|€|EUR|≤26|26\+/);
    }
  });
});

describe('grouping and roll-ups', () => {
  it('groups by recency in the engine order, the pens last', () => {
    const g = groupLists(views, 'recency', 'order');
    expect(g.map((x) => x.key)).toEqual(['newcomers', 'd21', 'd57', 'm4_6', 'm6_12', 'y1_2', 'y2plus', 'pens']);
    expect(groupKeyOf(views.find((v) => v.name === 'Current Returns')!, 'recency').key).toBe('pens');
  });

  it('every grouping adds up to the same lists total', () => {
    const all = rollup(views);
    for (const by of ['recency', 'value', 'orders', 'none'] as const) {
      const g = groupLists(views, by, 'value');
      expect(g.reduce((a, x) => a + x.total.count, 0)).toBe(all.count);
      expect(g.reduce((a, x) => a + (x.total.value_mkd ?? 0), 0)).toBe(all.value_mkd);
      expect(g.reduce((a, x) => a + x.total.worked, 0)).toBe(all.worked);
    }
    // Σ lists + list not recorded = the slice total (= the Overview's split)
    expect(all.count + data.not_recorded.count).toBe(data.total.count);
    expect((all.value_mkd ?? 0) + (data.not_recorded.value_mkd ?? 0)).toBe(data.total.value_mkd);
  });

  it('merges parts by key and keeps the bar order', () => {
    const all = rollup(views);
    expect(all.buckets.map((b) => b.key)).toEqual(['paid', 'courier', 'courier_problem', 'label', 'to_pack', 'returned']);
    expect(all.buckets.reduce((a, b) => a + b.count, 0)).toBe(all.count);
  });

  it('a counts-only payload rolls up with money null, never 0', () => {
    const noMoney = views.map(({ value_mkd: _v, cash_mkd: _c, cod_mkd: _d, stale_to_pack_value_mkd: _s, ...r }) => r);
    const all = rollup(noMoney);
    expect(all.value_mkd).toBeNull();
    expect(all.cash_mkd).toBeNull();
    expect(all.count).toBe(rollup(views).count);
  });

  it('sorts by value, conversion, members — the engine order breaks ties', () => {
    const byValue = sortRows(views, 'value');
    expect(byValue[0].name).toBe('57d 26+ (1-3 orders)');
    const byConv = sortRows(views.filter((v) => v.worked > 0), 'conversion');
    const c = byConv.map((v) => conversionOf(v.count, v.worked)!);
    expect([...c].sort((a, b) => b - a)).toEqual(c);
  });

  it('a list with no member, no work and no sale is quiet', () => {
    expect(isQuiet(views.find((v) => v.name === 'Due to Reorder')!)).toBe(true);
    expect(isQuiet(views.find((v) => v.name === '1-2yr ≤26 (1-3 orders)')!)).toBe(false); // members, 0 sales = news
  });
});

describe('rates', () => {
  it('conversion = sales ÷ worked decisions; returns ÷ (paid + returned)', () => {
    expect(conversionOf(686, 7000)).toBeCloseTo(0.098, 3);
    expect(conversionOf(3, 0)).toBeNull();
    expect(returnRateOf(448, 67)).toBeCloseTo(67 / 515, 6);
    expect(returnRateOf(0, 0)).toBeNull();
    expect(aovOf(1929281, 686)).toBeCloseTo(2812.36, 1);
    expect(aovOf(undefined, 686)).toBeNull();
    expect(reachOf(7000, 4373)).toBeCloseTo(7000 / 11373, 6);
    expect(salesPerHourOf(6, 120)).toBe(3);
    expect(salesPerHourOf(6, null)).toBeNull();
  });
});

describe('/orders links — exact or none', () => {
  it('builds the list slice filter', () => {
    const href = listsHref('total', RANGE, { listName: '57d 26+ (1-3 orders)' });
    const sp = new URLSearchParams(href.split('?')[1]);
    // cohort_source=elyon_crm: a list sale shipped on a NATURA 9102 / 9100 / 9108 parcel is
    // Телешоп / Social media, not this tab (owner 28.09) — detail alone would list it too
    expect(Object.fromEntries(sp)).toEqual({
      cohort_bucket: 'total', cohort_source: 'elyon_crm', sale_source: 'elyon_crm', sale_source_detail: 'prediction_list',
      prediction_list: '57d 26+ (1-3 orders)', sold_from: '2026-09-01', sold_to: '2026-09-27',
    });
    expect(listsHref(['courier', 'courier_problem'], RANGE, { personId: 'p1' })).toContain('cohort_bucket=courier%2Ccourier_problem');
  });

  it('links only a number that has orders behind it, with a known name', () => {
    const r = views.find((v) => v.name === '57d 26+ (1-3 orders)')!;
    const parts = [...r.buckets, ...r.outside];
    expect(listsDrill(parts, 'total', RANGE, r.drill_name, true)).toMatchObject({ blocked: null, orders: r.count });
    expect(listsDrill(parts, 'paid_unproven', RANGE, r.drill_name, true).href).toBeNull();  // 0 there
    expect(listsDrill(parts, 'total', RANGE, null, true)).toMatchObject({ href: null, blocked: 'unknown' });
    expect(listsDrill(parts, 'total', RANGE, r.drill_name, false)).toMatchObject({ href: null, blocked: 'unsupported' });
    expect(listsDrill(parts, 'total', null, r.drill_name, true).href).toBeNull();
  });

  it('the stale drill ends 8 days before today, inside the period', () => {
    expect(staleSoldTo(RANGE, '2026-09-28', 7)).toBe('2026-09-20');
    expect(staleSoldTo({ from: '2026-09-22', to: '2026-09-28' }, '2026-09-28', 7)).toBeNull();
    expect(staleSoldTo({ from: '2026-08-01', to: '2026-08-31' }, '2026-09-28', 7)).toBe('2026-08-31');
  });
});

describe('trend and matrix', () => {
  it('folds the parts into the stack and keeps the period totals', () => {
    const counts = trendRows(data.trend, false);
    expect(counts.reduce((a, r) => a + r.total, 0)).toBe(data.trend.reduce((a, p) => a + p.count, 0));
    const money = trendRows(data.trend, true);
    expect(money.reduce((a, r) => a + r.total, 0)).toBe(data.trend.reduce((a, p) => a + (p.value_mkd ?? 0), 0));
    // courier_problem folds into courier
    expect(counts.some((r) => 'courier_problem' in r)).toBe(false);
  });

  it('recency × value covers exactly the band lists', () => {
    const m = recencyValueMatrix(views);
    expect(m.rows[0]).toBe('d21');
    expect(m.threshold).toBe(26);
    const band = views.filter((v) => v.parsed.kind === 'band');
    const cells = Object.values(m.cells).flatMap((c) => Object.values(c));
    expect(cells.reduce((a, c) => a + c!.count, 0)).toBe(band.reduce((a, v) => a + v.count, 0));
  });
});
