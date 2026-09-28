import { describe, expect, it } from 'vitest';
import { predictionListLabel } from './predictionListLabel';

// Display-only: the stored list names keep their EUR thresholds (the engine
// matches lists by exact name); the screen shows денари.
describe('predictionListLabel', () => {
  it('rewrites the EUR value band into денари', () => {
    expect(predictionListLabel('57d ≤26 (3+ orders)')).toBe('57d ≤ 1.599 ден (3+ orders)');
    expect(predictionListLabel('1-2yr 26+ (1-3 orders)')).toBe('1-2yr 1.599+ ден (1-3 orders)');
    expect(predictionListLabel('2yr+ ≤26 (7+ orders)')).toBe('2yr+ ≤ 1.599 ден (7+ orders)');
  });

  it('leaves every other name exactly as stored', () => {
    for (const n of ['NEWCOMERS (3+ orders)', 'Current Cancels', 'Trash List', 'Spring campaign', '', '57d ≤26+ (3+ orders)']) {
      expect(predictionListLabel(n)).toBe(n);
    }
    expect(predictionListLabel(null)).toBe('');
  });
});
