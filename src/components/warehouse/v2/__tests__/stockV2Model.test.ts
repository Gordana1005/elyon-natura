import { describe, expect, it } from 'vitest';
import {
  fmtCover, fmtQty, fmtSigned, filterArticles, hasKey, parseHm, parsePasted, parseQty, readPageOffset,
} from '../stockV2Model';
import { ARTICLES } from './fixtures';

describe('stock v2 model', () => {
  it('writes quantities in the reader\'s marks, fractions only for КГ', () => {
    expect(fmtQty(1250, 'mk')).toBe('1.250');
    expect(fmtQty(12.5, 'mk')).toBe('12,5');
    expect(fmtQty(1250.75, 'mk')).toBe('1.250,75');
    expect(fmtQty(-4, 'mk')).toBe('−4');
    expect(fmtQty(1250, 'en')).toBe('1,250');
    expect(fmtQty(null, 'mk')).toBe('—');
    expect(fmtSigned(20, 'mk')).toBe('+20');
    expect(fmtSigned(-5, 'mk')).toBe('−5');
    expect(fmtSigned(0, 'mk')).toBe('0');
    expect(fmtCover(3.46, 'mk')).toBe('3,5');
    expect(fmtCover(29.4, 'mk')).toBe('29');
    expect(fmtCover(null, 'mk')).toBeNull();
  });

  it('reads a typed quantity: Macedonian thousands, decimal comma, blank, garbage', () => {
    expect(parseQty('')).toBeNull();
    expect(parseQty('24')).toBe(24);
    expect(parseQty('1.250')).toBe(1250);
    expect(parseQty('1 250')).toBe(1250);
    expect(parseQty('12,5')).toBe(12.5);
    expect(parseQty('12.5')).toBe(12.5);
    expect(parseQty('1.250,5')).toBe(1250.5);
    expect(parseQty('-3')).toBe('invalid');
    expect(parseQty('abc')).toBe('invalid');
  });

  it('reads two columns pasted from Excel, skipping a header and keeping the last repeat', () => {
    const r = parsePasted('Шифра\tКоличина\r\n100123\t24\n100456;1.250\n\nL00007 12,5\n100123\t30\nxx\t3\n');
    expect(r.lines).toEqual([
      { code: '100123', qty: 30 },
      { code: '100456', qty: 1250 },
      { code: 'L00007', qty: 12.5 },
    ]);
    expect(r.errors).toEqual([{ row: 7, text: 'xx\t3' }]);
  });

  it('reads HH:MM and the page offset', () => {
    expect(parseHm('9:05')).toBe('09:05');
    expect(parseHm('14.30')).toBe('14:30');
    expect(parseHm('24:00')).toBeNull();
    expect(parseHm('')).toBeNull();
    expect(readPageOffset(null, 50)).toBe(0);
    expect(readPageOffset('3', 50)).toBe(100);
    expect(readPageOffset('x', 50)).toBe(0);
  });

  it('filters by code or name, only negatives, and sorts', () => {
    expect(filterArticles(ARTICLES, { q: 'neuro' }, 'mk').map((a) => a.code)).toEqual(['100456']);
    expect(filterArticles(ARTICLES, { q: 'L000' }, 'mk').map((a) => a.code)).toEqual(['L00007']);
    expect(filterArticles(ARTICLES, { negative: true }, 'mk').map((a) => a.code)).toEqual(['100456']);
    expect(filterArticles(ARTICLES, { sort: 'out' }, 'mk').map((a) => a.code)).toEqual(['100123', '100456', 'L00007']);
    expect(filterArticles(ARTICLES, { sort: 'closing' }, 'mk')[0].code).toBe('100456');
    expect(filterArticles(ARTICLES, { sort: 'cover' }, 'mk').map((a) => a.code)).toEqual(['100456', '100123', 'L00007']);
  });

  it('sees a money key only when the api sent it', () => {
    expect(hasKey({ value_mkd: null }, 'value_mkd')).toBe(true);
    expect(hasKey({}, 'value_mkd')).toBe(false);
    expect(hasKey(null, 'value_mkd')).toBe(false);
  });
});
