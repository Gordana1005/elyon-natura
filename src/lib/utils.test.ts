import { describe, it, expect } from 'vitest';
import { isSyntheticProductName } from './utils';

// This guard is load-bearing. /calls stamps a cancel/trash record with the
// customer's last real product; when the lookup accepted a previous synthetic
// row as that product, the placeholder was copied forward on every later call
// and the customer's actual purchase was never read again. 401 orders reached
// production claiming "No prior product on file" while 94% of those customers
// had a paid product one row below.
describe('isSyntheticProductName', () => {
  it('rejects the placeholders the CRM writes on synthetic outcome rows', () => {
    expect(isSyntheticProductName('No prior product on file')).toBe(true);
    expect(isSyntheticProductName('Cancelled')).toBe(true);
    expect(isSyntheticProductName('Trashed')).toBe(true);
    expect(isSyntheticProductName('—')).toBe(true);
  });

  it('treats empty and missing names as synthetic', () => {
    expect(isSyntheticProductName('')).toBe(true);
    expect(isSyntheticProductName('   ')).toBe(true);
    expect(isSyntheticProductName(null)).toBe(true);
    expect(isSyntheticProductName(undefined)).toBe(true);
  });

  it('matches regardless of case or surrounding whitespace', () => {
    expect(isSyntheticProductName('  no prior product on file  ')).toBe(true);
    expect(isSyntheticProductName('CANCELLED - customer declined')).toBe(true);
  });

  it('accepts real catalogue products, Latin and Cyrillic', () => {
    expect(isSyntheticProductName('ProstaFix')).toBe(false);
    expect(isSyntheticProductName('Slim Fit')).toBe(false);
    expect(isSyntheticProductName('ПРОСТАТОЛ КОМПЛЕКС cps 30')).toBe(false);
    expect(isSyntheticProductName('АЛОЕ ВЕРА ГЕЛ СО АРОНИЈА 1Л')).toBe(false);
    expect(isSyntheticProductName('ArthroFix, ЦИНК-30 tbl')).toBe(false);
  });

  it('does not reject a real product merely for containing a placeholder word', () => {
    // Only a leading match is a placeholder — these are genuine names.
    expect(isSyntheticProductName('Detox Cancelled Edition')).toBe(false);
    expect(isSyntheticProductName('Файл Trashed')).toBe(false);
  });
});
