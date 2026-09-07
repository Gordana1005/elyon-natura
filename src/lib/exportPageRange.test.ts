import { describe, it, expect } from 'vitest';
import { planExportWindow, clampPageRange, estimateExportRows } from './exportPageRange';

const PAGE = 20;   // PAGE_SIZE on /orders
const CHUNK = 200; // rows per export request

/** Simulate the fetch loop: returns the display_ids the operator would get. */
function simulate(scope: 'all' | 'range', pageFrom: number, pageTo: number, totalRows: number, cap = 20000) {
  const { startRow, endRow, firstChunk, offsetIntoChunk } = planExportWindow(scope, pageFrom, pageTo, PAGE, CHUNK);
  const collected: number[] = [];
  for (let chunk = firstChunk; ; chunk++) {
    const from = (chunk - 1) * CHUNK;
    const batch: number[] = [];
    for (let i = from; i < Math.min(from + CHUNK, totalRows); i++) batch.push(i);
    collected.push(...batch);
    const fetchedThrough = chunk * CHUNK;
    if (batch.length < CHUNK) break;
    if (fetchedThrough >= endRow) break;
    if (collected.length >= cap + startRow) break;
  }
  let rows = collected.slice(offsetIntoChunk);
  if (endRow !== Infinity) rows = rows.slice(0, endRow - startRow);
  if (rows.length > cap) rows = rows.slice(0, cap);
  return rows;
}

describe('export page window', () => {
  it('exports the whole filtered set, not just the first page', () => {
    // The reported bug: 57 shipped orders, export produced 20.
    expect(simulate('all', 1, 1, 57)).toHaveLength(57);
  });

  it('page 1 alone is the first 20 rows', () => {
    expect(simulate('range', 1, 1, 57)).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  it('a mid-list page window starts where the pager says it does', () => {
    // Pages 4-5 = rows 60..99, the same rows the pager shows on those pages.
    expect(simulate('range', 4, 5, 500)).toEqual(Array.from({ length: 40 }, (_, i) => 60 + i));
  });

  it('a window that straddles a 200-row chunk boundary is contiguous', () => {
    // Pages 10-11 = rows 180..219, which spans chunk 1 and chunk 2.
    expect(simulate('range', 10, 11, 500)).toEqual(Array.from({ length: 40 }, (_, i) => 180 + i));
  });

  it('a window starting exactly on a chunk boundary drops nothing', () => {
    // Page 11 = row 200, the first row of chunk 2.
    expect(simulate('range', 11, 12, 500)).toEqual(Array.from({ length: 40 }, (_, i) => 200 + i));
  });

  it('the last page returns the short remainder, not a padded window', () => {
    // 57 rows over 3 pages: page 3 holds 17.
    expect(simulate('range', 3, 3, 57)).toEqual(Array.from({ length: 17 }, (_, i) => 40 + i));
  });

  it('a deep window past a chunk boundary is still exact', () => {
    // Pages 41-42 = rows 800..839; chunk 5 starts at row 800.
    expect(simulate('range', 41, 42, 2000)).toEqual(Array.from({ length: 40 }, (_, i) => 800 + i));
  });

  it('never exceeds the row cap', () => {
    expect(simulate('all', 1, 1, 50000, 20000)).toHaveLength(20000);
  });

  it('every page of a set, concatenated, reproduces the set exactly once', () => {
    const total = 457;
    const pages = Math.ceil(total / PAGE);
    const seen: number[] = [];
    for (let p = 1; p <= pages; p++) seen.push(...simulate('range', p, p, total));
    expect(seen).toEqual(Array.from({ length: total }, (_, i) => i));
  });
});

describe('clampPageRange', () => {
  it('keeps a valid window untouched', () => {
    expect(clampPageRange('2', '4', 10)).toEqual({ pageFrom: 2, pageTo: 4 });
  });
  it('treats empty boxes as the whole set', () => {
    expect(clampPageRange('', '', 7)).toEqual({ pageFrom: 1, pageTo: 7 });
  });
  it('pulls an over-long window back to the last real page', () => {
    expect(clampPageRange('1', '999', 3)).toEqual({ pageFrom: 1, pageTo: 3 });
  });
  it('refuses to let "to" sit before "from"', () => {
    expect(clampPageRange('5', '2', 10)).toEqual({ pageFrom: 5, pageTo: 5 });
  });
  it('survives a zero-page (empty) result set', () => {
    expect(clampPageRange('1', '1', 0)).toEqual({ pageFrom: 1, pageTo: 1 });
  });
  it('rejects nonsense input instead of exporting nothing', () => {
    expect(clampPageRange('abc', '-4', 5)).toEqual({ pageFrom: 1, pageTo: 1 });
  });
});

describe('estimateExportRows', () => {
  it('reports the whole filtered set for "all pages"', () => {
    expect(estimateExportRows('all', 1, 1, 57, PAGE, 20000)).toBe(57);
  });
  it('does not promise more rows than the set holds', () => {
    // Pages 1-3 of a 57-row set is 57, not 60.
    expect(estimateExportRows('range', 1, 3, 57, PAGE, 20000)).toBe(57);
  });
  it('counts a full mid-list window', () => {
    expect(estimateExportRows('range', 2, 3, 500, PAGE, 20000)).toBe(40);
  });
  it('shows the cap rather than an unreachable total', () => {
    expect(estimateExportRows('all', 1, 1, 90000, PAGE, 20000)).toBe(20000);
  });
});
