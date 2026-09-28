import { beforeEach, describe, expect, it } from 'vitest';
import {
  DRAFT_STORAGE_KEY, clearDraft, fillEmptyWithSystem, formatUnits, loadDraft, parseCounted, saveDraft, summarizeCount,
  type CountProduct,
} from './stockCount';

const products: CountProduct[] = [
  { id: 'a', name: 'Adenofrin', stock_quantity: 1000, cost_price: 2 },
  { id: 'b', name: 'Neurofix', stock_quantity: 1000, cost_price: 0 },
  { id: 'c', name: 'ZINC', stock_quantity: 5, cost_price: 1.5 },
  { id: 'd', name: 'Untouched', stock_quantity: 7 },
];

describe('parseCounted', () => {
  it('blank = not counted', () => {
    expect(parseCounted('')).toBeNull();
    expect(parseCounted('   ')).toBeNull();
    expect(parseCounted(undefined)).toBeNull();
  });
  it('whole numbers, as typed in Macedonian (thousands dot / space)', () => {
    expect(parseCounted('0')).toBe(0);
    expect(parseCounted(' 42 ')).toBe(42);
    expect(parseCounted('1.000')).toBe(1000);
    expect(parseCounted('1 250')).toBe(1250);
  });
  it('anything else is invalid', () => {
    expect(parseCounted('-3')).toBe('invalid');
    expect(parseCounted('2,5')).toBe('invalid');
    expect(parseCounted('2.5')).toBe('invalid');
    expect(parseCounted('12.50')).toBe('invalid');
    expect(parseCounted('abc')).toBe('invalid');
    expect(parseCounted('1000001')).toBe('invalid');
  });
});

describe('summarizeCount', () => {
  it('sends only counted products and estimates the difference', () => {
    const s = summarizeCount({ a: '900', b: '1000', c: '8', d: '' }, products);
    expect(s.lines).toEqual([{ product_id: 'a', counted: 900 }, { product_id: 'b', counted: 1000 }, { product_id: 'c', counted: 8 }]);
    expect(s).toMatchObject({ counted: 3, changed: 2, up: 3, down: 100, invalid: [] });
    // −100 × €2 + 3 × €1,5 (Neurofix has no cost)
    expect(s.diffCostEur).toBeCloseTo(-195.5);
  });
  it('an invalid field is reported, never sent', () => {
    const s = summarizeCount({ a: 'x', c: '4' }, products);
    expect(s.invalid).toEqual(['a']);
    expect(s.lines).toEqual([{ product_id: 'c', counted: 4 }]);
  });
  it('a count of zero is a count', () => {
    const s = summarizeCount({ d: '0' }, products);
    expect(s.lines).toEqual([{ product_id: 'd', counted: 0 }]);
    expect(s.down).toBe(7);
  });
});

describe('formatUnits', () => {
  it('groups by dots, a real minus sign', () => {
    expect(formatUnits(0)).toBe('0');
    expect(formatUnits(1250)).toBe('1.250');
    expect(formatUnits(-30)).toBe('−30');
    expect(formatUnits(1000000)).toBe('1.000.000');
    expect(formatUnits(null)).toBe('0');
  });
});

describe('fillEmptyWithSystem', () => {
  it('fills only the empty fields', () => {
    expect(fillEmptyWithSystem({ a: '3', b: ' ' }, products)).toEqual({ a: '3', b: '1000', c: '5', d: '7' });
  });
});

describe('the draft on this device', () => {
  beforeEach(() => localStorage.clear());
  it('round-trips, drops blanks, clears', () => {
    saveDraft({ a: '3', b: '' });
    expect(JSON.parse(localStorage.getItem(DRAFT_STORAGE_KEY) as string)).toEqual({ a: '3' });
    expect(loadDraft()).toEqual({ a: '3' });
    clearDraft();
    expect(loadDraft()).toEqual({});
  });
  it('ignores garbage', () => {
    localStorage.setItem(DRAFT_STORAGE_KEY, '[1,2]');
    expect(loadDraft()).toEqual({});
    localStorage.setItem(DRAFT_STORAGE_KEY, '{not json');
    expect(loadDraft()).toEqual({});
  });
});
