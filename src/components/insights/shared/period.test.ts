import { describe, expect, it } from 'vitest';
import {
  MAX_SPAN_DAYS, formatDmy, isYmd, mondayOf, parseDmy, parsePeriodParams, periodText, presetRange, previousRange,
  skopjeToday, spanDays, switchTabParams, writePeriodParams,
} from './period';

// 28.09.2026 is a Monday.
const today = '2026-09-28';

describe('calendar presets (Skopje days, owner rule 2026-09-28)', () => {
  it('today · the last 7 days · this month from the 1st · this year from 1 January', () => {
    expect(presetRange('today', today)).toEqual({ from: today, to: today });
    expect(presetRange('week', today)).toEqual({ from: '2026-09-22', to: today });
    expect(presetRange('week', '2026-09-27')).toEqual({ from: '2026-09-21', to: '2026-09-27' }); // a Sunday
    expect(presetRange('week', '2026-10-01')).toEqual({ from: '2026-09-25', to: '2026-10-01' }); // across a month end
    expect(presetRange('month', today)).toEqual({ from: '2026-09-01', to: today });
    expect(presetRange('year', today)).toEqual({ from: '2026-01-01', to: today });
  });
  it('the first day of a year: the last 7 days reach back into December', () => {
    expect(presetRange('week', '2026-01-01')).toEqual({ from: '2025-12-26', to: '2026-01-01' });
    expect(presetRange('month', '2026-01-01')).toEqual({ from: '2026-01-01', to: '2026-01-01' });
    expect(presetRange('year', '2026-01-01')).toEqual({ from: '2026-01-01', to: '2026-01-01' });
  });
  it('weeks start on Monday', () => {
    expect(mondayOf('2026-09-28')).toBe('2026-09-28');
    expect(mondayOf('2026-10-04')).toBe('2026-09-28'); // Sunday
    expect(mondayOf('2026-10-05')).toBe('2026-10-05');
  });
  it('custom: swaps a reversed pair, pulls future days back to today, caps the span', () => {
    expect(presetRange('custom', today, { from: '2026-09-20', to: '2026-09-01' })).toEqual({ from: '2026-09-01', to: '2026-09-20' });
    expect(presetRange('custom', today, { from: '2026-09-20', to: '2026-12-31' })).toEqual({ from: '2026-09-20', to: today });
    const wide = presetRange('custom', today, { from: '2020-01-01', to: today });
    expect(wide).toEqual({ from: '2025-08-24', to: today });
    expect(spanDays(wide)).toBe(MAX_SPAN_DAYS + 1);
  });
  it('custom: an unreadable day falls back to this week instead of widening the range', () => {
    expect(presetRange('custom', today, { from: 'garbage', to: '2026-13-45' })).toEqual({ from: '2026-09-22', to: today });
    expect(presetRange('custom', today, { from: '2026-02-30', to: today })).toEqual({ from: '2026-09-22', to: today });
  });
  it('compare = the equal-length span right before', () => {
    expect(previousRange({ from: '2026-09-01', to: '2026-09-28' })).toEqual({ from: '2026-08-04', to: '2026-08-31' });
    expect(previousRange({ from: '2026-09-28', to: '2026-09-28' })).toEqual({ from: '2026-09-27', to: '2026-09-27' });
    expect(previousRange({ from: '2026-10-25', to: '2026-10-31' })).toEqual({ from: '2026-10-18', to: '2026-10-24' }); // DST week
  });
  it('today is the Skopje calendar day, not the UTC one', () => {
    expect(skopjeToday(new Date('2026-09-27T22:30:00Z'))).toBe('2026-09-28'); // 00:30 in Skopje
    expect(skopjeToday(new Date('2026-12-31T23:30:00Z'))).toBe('2027-01-01'); // CET
  });
});

describe('dd.mm.yyyy — the only way a day is written', () => {
  it('reads what an operator types, day first', () => {
    expect(parseDmy('28.09.2026')).toBe('2026-09-28');
    expect(parseDmy('1.9.2026')).toBe('2026-09-01');
    expect(parseDmy('01/09/2026')).toBe('2026-09-01');
    expect(parseDmy('01-09-2026')).toBe('2026-09-01');
    expect(parseDmy('28.09.26')).toBe('2026-09-28');
    expect(parseDmy(' 2026-09-28 ')).toBe('2026-09-28');
    expect(parseDmy('28.09.2026.')).toBe('2026-09-28');
  });
  it('never reads the US month-first order, and refuses days that do not exist', () => {
    expect(parseDmy('09/28/2026')).toBeNull();
    expect(parseDmy('31.02.2026')).toBeNull();
    expect(parseDmy('2026-02-30')).toBeNull();
    expect(parseDmy('')).toBeNull();
    expect(parseDmy('28.09')).toBeNull();
    expect(isYmd('2026-02-29')).toBe(false);
    expect(isYmd('2028-02-29')).toBe(true);
  });
  it('writes dd.mm.yyyy and short periods', () => {
    expect(formatDmy('2026-09-01')).toBe('01.09.2026');
    expect(formatDmy('bad')).toBe('');
    expect(periodText({ from: today, to: today })).toBe('28.09.2026');
    expect(periodText({ from: '2026-09-01', to: today })).toBe('01.09 – 28.09.2026');
    expect(periodText({ from: '2025-12-29', to: '2026-01-02' })).toBe('29.12.2025 – 02.01.2026');
  });
});

describe('the period in the /insights URL', () => {
  it('defaults: this week, compare on — and defaults stay out of the URL', () => {
    expect(parsePeriodParams(new URLSearchParams('tab=sales'), today))
      .toEqual({ preset: 'week', range: { from: '2026-09-22', to: today }, compare: true });
    const sp = writePeriodParams(new URLSearchParams('tab=sales&range=month&compare=0'), { preset: 'week', compare: true });
    expect(sp.toString()).toBe('tab=sales');
  });
  it('round-trips a custom period and keeps every other param', () => {
    const sp = writePeriodParams(new URLSearchParams('tab=overview&src=web'), {
      preset: 'custom', range: { from: '2026-09-01', to: '2026-09-10' }, compare: false,
    });
    expect(sp.get('tab')).toBe('overview');
    expect(sp.get('src')).toBe('web');
    expect(Object.fromEntries(sp)).toMatchObject({ range: 'custom', from: '2026-09-01', to: '2026-09-10', compare: '0' });
    expect(parsePeriodParams(sp, today)).toEqual({ preset: 'custom', range: { from: '2026-09-01', to: '2026-09-10' }, compare: false });
  });
  it('a preset drops stale custom days; a preset is recomputed from today, never frozen', () => {
    const sp = writePeriodParams(new URLSearchParams('range=custom&from=2026-09-01&to=2026-09-10'), { preset: 'month' });
    expect(sp.toString()).toBe('range=month');
    expect(parsePeriodParams(sp, '2026-10-05').range).toEqual({ from: '2026-10-01', to: '2026-10-05' });
  });
  it('a from/to pair without `range` (a link from elsewhere) is a custom period', () => {
    expect(parsePeriodParams(new URLSearchParams('from=2026-09-01&to=2026-09-27'), today))
      .toMatchObject({ preset: 'custom', range: { from: '2026-09-01', to: '2026-09-27' } });
  });
  it('reads the legacy cmp=0 and writes compare=0 in its place', () => {
    expect(parsePeriodParams(new URLSearchParams('cmp=0'), today).compare).toBe(false);
    const sp = writePeriodParams(new URLSearchParams('cmp=0'), { compare: false });
    expect(sp.toString()).toBe('compare=0');
    expect(writePeriodParams(new URLSearchParams('cmp=0'), { compare: true }).toString()).toBe('');
  });
  it('switching tabs keeps the period and drops the old tab’s own filters', () => {
    const sp = new URLSearchParams('tab=overview&range=custom&from=2026-09-01&to=2026-09-10&compare=0&src=web&team=x&ovFixture=1');
    expect(switchTabParams(sp, 'sales').toString()).toBe('tab=sales&range=custom&from=2026-09-01&to=2026-09-10&compare=0');
    expect(switchTabParams(new URLSearchParams('tab=overview&cmp=0'), 'stock').toString()).toBe('tab=stock&compare=0');
    expect(switchTabParams(new URLSearchParams(''), 'returns').toString()).toBe('tab=returns');
  });
});
