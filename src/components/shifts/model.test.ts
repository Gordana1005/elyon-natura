import { beforeAll, describe, expect, it } from 'vitest';
import i18n from '@/i18n';
import { cellKey, diffCells, type GridCell } from '@/lib/shiftsApi';
import {
  EMPTY_STAGING, baselineCells, buildBrushes, shortWindow, stagingReducer, stepAnchor, viewDays,
} from './model';
import { shiftRefusalText } from './loginRefusal';

const U = 'u1';
const stored = new Map<string, GridCell>([
  [cellKey(U, '2026-10-05'), { user_id: U, date: '2026-10-05', shift_id: 's', start: '07:00', end: '21:00', name: 'Октомври', template_id: null }],
]);

describe('views', () => {
  it('week = Mon–Sun, month = the whole month; steps move a whole view', () => {
    expect(viewDays('week', '2026-10-07')).toEqual(['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11']);
    expect(viewDays('month', '2026-02-10')).toHaveLength(28);
    expect(stepAnchor('week', '2026-10-07', 1)).toBe('2026-10-12');
    expect(stepAnchor('month', '2026-10-31', 1)).toBe('2026-11-01');
    expect(stepAnchor('month', '2026-10-15', -1)).toBe('2026-09-01');
  });
  it('short windows and brushes', () => {
    expect(shortWindow('07:00', '21:00')).toBe('07–21');
    expect(shortWindow('07:30', '14:30')).toBe('07:30–14:30');
    const b = buildBrushes([{ id: 't', name: 'Smena 1', start: '07:30', end: '14:30' }],
      [{ start: '07:00', end: '21:00', name: 'Октомври', count: 9 }, { start: '07:00', end: '21:00', name: 'x', count: 1 }]);
    expect(b.map((x) => x.key)).toEqual(['t:t', 'w:07:00-21:00']);
  });
});

describe('staging', () => {
  it('keeps the baseline of the first paint, un-stages a paint back to it, survives a view change', () => {
    let s = stagingReducer(EMPTY_STAGING, { type: 'paint', entries: [[cellKey(U, '2026-10-05'), { kind: 'off' }]], stored });
    expect(s.staged.size).toBe(1);
    // the grid moved on: the cell is no longer in `stored`, the baseline still knows it had a shift
    s = stagingReducer(s, { type: 'paint', entries: [[cellKey(U, '2026-10-05'), { kind: 'window', start: '07:00', end: '21:00' }]], stored: new Map() });
    expect(s.staged.size).toBe(0);
    s = stagingReducer(s, { type: 'paint', entries: [[cellKey(U, '2026-10-06'), { kind: 'window', start: '08:00', end: '16:00' }]], stored });
    expect(diffCells(baselineCells(s), s.staged)).toEqual([{ user_id: U, date: '2026-10-06', start: '08:00', end: '16:00' }]);
    expect(stagingReducer(s, { type: 'reset' }).staged.size).toBe(0);
  });
});

describe('login refusal text', () => {
  beforeAll(async () => { await i18n.changeLanguage('mk'); });
  it('translates the gate code, with the windows and the next shift', () => {
    const t = i18n.t.bind(i18n);
    expect(shiftRefusalText(t, { allowed: false, code: 'outside_hours', windows: ['09:00 - 17:00'], next_shift: { date: '2026-10-02', start: '09:00', end: '17:00' } }))
      .toBe('Вашата смена денес е 09:00 - 17:00 — сега сте надвор од неа. Следна смена: 02.10 од 09:00.');
    expect(shiftRefusalText(t, { allowed: false, code: 'no_assignment' })).toBe('Немате доделена смена. Јавете се кај менаџерот.');
    // an older api: its English message as sent
    expect(shiftRefusalText(t, { allowed: false, message: 'Login not allowed.' })).toBe('Login not allowed.');
  });
});
