import { describe, expect, it } from 'vitest';
import { parsePredictionListName, predictionListLabel } from './predictionListLabel';

// Display-only: the stored list names keep their EUR thresholds (the engine
// matches lists by exact name); the screen shows денари.
describe('predictionListLabel', () => {
  it('rewrites the EUR value band into денари', () => {
    expect(predictionListLabel('57d ≤26 (3+ orders)')).toBe('57d ≤ 1.599 ден (3+ orders)');
    expect(predictionListLabel('1-2yr 26+ (1-3 orders)')).toBe('1-2yr 1.599+ ден (1-3 orders)');
    expect(predictionListLabel('2yr+ ≤26 (7+ orders)')).toBe('2yr+ ≤ 1.599 ден (7+ orders)');
  });

  it('takes a name apart for display and grouping (never a key)', () => {
    expect(parsePredictionListName('57d ≤26 (3+ orders)')).toEqual({
      kind: 'band', recency: '57d', band: 'le', threshold: 26, orders: '3+', pen: null,
    });
    expect(parsePredictionListName('1-2yr 26+ (1-3 orders)')).toMatchObject({ kind: 'band', recency: '1-2yr', band: 'gt', orders: '1-3' });
    expect(parsePredictionListName('NEWCOMERS (7+ orders)')).toMatchObject({ kind: 'newcomers', recency: 'NEWCOMERS', orders: '7+', band: null });
    expect(parsePredictionListName('Current Cancels')).toMatchObject({ kind: 'pen', pen: 'current_cancels' });
    expect(parsePredictionListName('Trash List')).toMatchObject({ kind: 'pen', pen: 'trash' });
    for (const n of ['Spring campaign', '57d ≤26+ (3+ orders)', '57d 26 (3+ orders)', '', null]) {
      expect(parsePredictionListName(n).kind).toBe('other');
    }
  });

  it('leaves every other name exactly as stored', () => {
    for (const n of ['NEWCOMERS (3+ orders)', 'Current Cancels', 'Trash List', 'Spring campaign', '', '57d ≤26+ (3+ orders)']) {
      expect(predictionListLabel(n)).toBe(n);
    }
    expect(predictionListLabel(null)).toBe('');
  });
});
