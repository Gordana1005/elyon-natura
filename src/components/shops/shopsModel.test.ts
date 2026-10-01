import { describe, expect, it } from 'vitest';
import type { ShopDayRow, ShopsDay, ShopsPeriod, ShopDetail, ShopsStockMatrix } from '@/lib/shopsTypes';
import day from './__fixtures__/day.owner.json';
import period from './__fixtures__/period.owner.json';
import detail from './__fixtures__/detail.owner.json';
import matrix from './__fixtures__/matrix.owner.json';
import {
  availableSorts, backfillShare, compactQty, controlState, defaultSort, filterMatrix, filterStock, hasKey, hourlyRows,
  parseSort, parseStockBasis, salesLate, snapshotIsRecent, sortShops, stripShopsMoney, tabParams, topSellerCodes,
  vsDir, withParam, zeroShops,
} from './shopsModel';

const D = day as unknown as ShopsDay;
const P = period as unknown as ShopsPeriod;
const DT = detail as unknown as ShopDetail;
const M = matrix as unknown as ShopsStockMatrix;

describe('the fixtures follow src/lib/shopsTypes.ts', () => {
  it('totals add up to the rows (the page never re-sums, but the fixtures must be honest)', () => {
    for (const r of [D, P]) {
      expect(r.totals.receipts).toBe(r.shops.reduce((a, s) => a + s.receipts, 0));
      expect(r.totals.units).toBe(r.shops.reduce((a, s) => a + s.units, 0));
      expect(r.totals.sales_mkd).toBe(r.shops.reduce((a, s) => a + (s.sales_mkd ?? 0), 0));
    }
    expect(D.hourly.reduce((a, h) => a + h.receipts, 0)).toBe(D.totals.receipts);
    expect(P.daily.reduce((a, h) => a + h.units, 0)).toBe(P.totals.units);
  });
});

describe('URL state', () => {
  it('a tab switch keeps the period and the shop, drops the tab\'s own filters', () => {
    const sp = new URLSearchParams('tab=shop&range=custom&from=2026-09-01&to=2026-09-30&shop=003&q=aloe&zero=1&compare=0');
    expect(tabParams(sp, 'deliveries').toString()).toBe('tab=deliveries&range=custom&from=2026-09-01&to=2026-09-30&shop=003');
    expect(tabParams(new URLSearchParams(), 'shop', { shop: '006' }).toString()).toBe('tab=shop&shop=006');
  });
  it('withParam sets, and removes on empty / false', () => {
    const sp = new URLSearchParams('tab=stock&q=x');
    expect(withParam(sp, 'gaps', true).get('gaps')).toBe('1');
    expect(withParam(sp, 'q', '').has('q')).toBe(false);
    expect(withParam(sp, 'q', null).toString()).toBe('tab=stock');
    expect(withParam(sp, 'gaps', false).has('gaps')).toBe(false);
  });
});

describe('money: only what the payload carries', () => {
  it('stripShopsMoney removes every *_mkd key at any depth and keeps the counts', () => {
    const m = stripShopsMoney(P);
    const json = JSON.stringify(m);
    expect(json).not.toMatch(/_mkd"/);
    expect(m.totals.receipts).toBe(P.totals.receipts);
    expect(m.natura.units_delivered).toBe(P.natura.units_delivered);
    expect(hasKey(m.totals, 'sales_mkd')).toBe(false);
    expect(hasKey(P.totals, 'sales_mkd')).toBe(true);
  });
  it('a money sort exists only when its key arrived; owners default to sales, managers to units', () => {
    expect(availableSorts(P.shops, P.totals)).toContain('sales_mkd');
    const stripped = stripShopsMoney(P);
    const av = availableSorts(stripped.shops, stripped.totals);
    expect(av).toEqual(['units', 'receipts', 'returns_units', 'vs_avg_pct']);
    expect(defaultSort(true)).toBe('sales_mkd');
    expect(parseSort('sales_mkd', av, false)).toBe('units');
    expect(parseSort('nonsense', availableSorts(P.shops, P.totals), true)).toBe('sales_mkd');
    expect(parseSort('receipts', av, false)).toBe('receipts');
  });
});

describe('sorting shops', () => {
  const row = (code: string, units: number, vs: number | null): ShopDayRow => ({
    shop: { code, name: code, city: 'Скопје', sigma_object: null, active: true },
    receipts: 1, units, returns_units: 0, first_receipt_at: null, last_receipt_at: null, vs_avg_pct: vs, control_ok: null,
  });
  it('highest first, a missing value last whatever the direction, ties by code', () => {
    const rows = [row('005', 3, null), row('003', 9, 4), row('004', 9, -2)];
    expect(sortShops(rows, 'units').map((r) => r.shop.code)).toEqual(['003', '004', '005']);
    expect(sortShops(rows, 'units', 'asc').map((r) => r.shop.code)).toEqual(['005', '003', '004']);
    expect(sortShops(rows, 'vs_avg_pct').map((r) => r.shop.code)).toEqual(['003', '004', '005']);
    expect(sortShops(rows, 'vs_avg_pct', 'asc').map((r) => r.shop.code)).toEqual(['004', '003', '005']);
  });
});

describe('vs average · control', () => {
  it('vs_avg_pct is in percent; within ±2 % is "at average"', () => {
    expect(vsDir(12.4)).toBe('up');
    expect(vsDir(-8.1)).toBe('down');
    expect(vsDir(1.9)).toBe('flat');
    expect(vsDir(-1.99)).toBe('flat');
    expect(vsDir(null)).toBe('none');
    expect(vsDir(undefined)).toBe('none');
  });
  it('control: true ✓ · false ≠ · null not yet', () => {
    expect(controlState(true)).toBe('ok');
    expect(controlState(false)).toBe('diff');
    expect(controlState(null)).toBe('pending');
  });
});

describe('the hour axis', () => {
  it('a live day: from opening to the running hour, gaps as zeros, the running hour marked', () => {
    const rows = hourlyRows([{ hour: 9, receipts: 4, units: 6, sales_mkd: 900 }, { hour: 11, receipts: 2, units: 2, sales_mkd: 300 }], 11);
    expect(rows.map((r) => r.hour)).toEqual([8, 9, 10, 11]);
    expect(rows[2]).toEqual({ hour: 10, receipts: 0, units: 0, sales_mkd: 0, partial: false });
    expect(rows[3].partial).toBe(true);
  });
  it('a closed day shows the whole shop day; no sales key without money', () => {
    const rows = hourlyRows([{ hour: 7, receipts: 1, units: 1 }, { hour: 22, receipts: 1, units: 1 }], null);
    expect(rows[0].hour).toBe(7);
    expect(rows[rows.length - 1].hour).toBe(22);
    expect(rows.some((r) => 'sales_mkd' in r)).toBe(false);
    expect(rows.some((r) => r.partial)).toBe(false);
  });
});

describe('stock of one shop', () => {
  it('"само нула" keeps the empty shelves; top sellers at zero come first', () => {
    const zero = filterStock(DT.stock, { zero: true });
    expect(zero.length).toBeGreaterThan(0);
    expect(zero.every((r) => r.qty <= 0)).toBe(true);
    expect(zero[0].zero_top_seller).toBe(true);
  });
  it('search matches Cyrillic names from Latin input, and codes', () => {
    expect(filterStock(DT.stock, { q: 'aloe' }).map((r) => r.name)).toContain('Алое Вера 500 мл');
    expect(filterStock(DT.stock, { q: '10001' }).map((r) => r.code)).toEqual(['10001']);
    expect(filterStock(DT.stock, { q: 'bio natural' }).every((r) => r.brand === 'Bio Natural')).toBe(true);
  });
  it('reads the server basis for translation, else null (shown as sent)', () => {
    expect(parseStockBasis('snapshot 01.10 23:30 + 14 movements')).toEqual({ at: '01.10 23:30', movements: 14 });
    expect(parseStockBasis('snapshot 30.09.2026 23:30 + 1 movement')).toEqual({ at: '30.09.2026 23:30', movements: 1 });
    expect(parseStockBasis('нешто друго')).toBeNull();
    expect(parseStockBasis(null)).toBeNull();
  });
});

describe('the matrix', () => {
  const top = topSellerCodes(M.articles);
  it('top sellers = the 20 best 30-day sellers', () => {
    expect(top.size).toBe(20);
    const best = [...M.articles].sort((a, b) => b.sold_30d_total - a.sold_30d_total)[0];
    expect(top.has(best.code)).toBe(true);
  });
  it('filters by search, brand and "top sellers with a 0"; best sellers first', () => {
    expect(filterMatrix(M, { q: 'kurkum' }, top).map((a) => a.name)).toEqual(['Куркумактив 500 мл']);
    const bio = filterMatrix(M, { brand: 'Bio Natural' }, top);
    expect(bio.length).toBeGreaterThan(0);
    expect(bio.every((a) => a.brand === 'Bio Natural')).toBe(true);
    const none = filterMatrix(M, { brand: '__none__' }, top);
    expect(none.every((a) => a.brand === null)).toBe(true);
    const gaps = filterMatrix(M, { gaps: true }, top);
    expect(gaps.every((a) => top.has(a.code) && zeroShops(a, M.shops).length > 0)).toBe(true);
    const all = filterMatrix(M, {}, top);
    for (let i = 1; i < all.length; i++) expect(all[i - 1].sold_30d_total).toBeGreaterThanOrEqual(all[i].sold_30d_total);
  });
  it('compact numbers keep the dense matrix narrow', () => {
    expect(compactQty(7, 'mk')).toBe('7');
    expect(compactQty(1240, 'mk')).toBe('1,2k');
    expect(compactQty(1240, 'en')).toBe('1.2k');
    expect(compactQty(12000, 'mk')).toBe('12k');
  });
});

describe('health · freshness', () => {
  it('backfill share from the first day to today', () => {
    expect(backfillShare('2026-01-01', '2026-01-01', '2026-01-11')).toBe(0);
    expect(backfillShare('2026-01-01', '2026-01-06', '2026-01-11')).toBe(0.5);
    expect(backfillShare(null, null, '2026-01-11')).toBeNull();
  });
  it('receipts older than 30 min during the shops\' hours are late', () => {
    const at = Date.parse('2026-10-02T12:00:00Z'); // 14:00 Skopje
    expect(salesLate({ last_sales_at: '2026-10-02T11:45:00Z', last_docs_at: null, last_stock_snapshot_at: null, reader_last_run_at: null }, at)).toBe(false);
    expect(salesLate({ last_sales_at: '2026-10-02T11:00:00Z', last_docs_at: null, last_stock_snapshot_at: null, reader_last_run_at: null }, at)).toBe(true);
    // 02:00 Skopje — the shops are closed, nothing is late
    expect(salesLate({ last_sales_at: '2026-10-01T19:00:00Z', last_docs_at: null, last_stock_snapshot_at: null, reader_last_run_at: null }, Date.parse('2026-10-02T00:00:00Z'))).toBe(false);
  });
  it('last night\'s snapshot is "23:30"; an older one carries its day', () => {
    const now = Date.parse('2026-10-02T12:00:00Z');
    expect(snapshotIsRecent('2026-10-01T21:30:00Z', now)).toBe(true);
    expect(snapshotIsRecent('2026-09-29T21:30:00Z', now)).toBe(false);
  });
});
