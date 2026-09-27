import { describe, it, expect } from 'vitest';
import {
  CALL_ACTIVE_CAP_MS,
  IDLE_AFTER_MS,
  inputStateAt,
  inputThrottle,
  mergeLastInput,
  observeCall,
  shiftDay,
  skopjeDay,
  skopjeHm,
  splitMinutes,
} from './state';

const NOW = Date.parse('2026-09-28T08:00:00Z');

describe('inputStateAt', () => {
  it('is active while the last input is under a minute old', () => {
    expect(inputStateAt(NOW, NOW)).toBe('active');
    expect(inputStateAt(NOW, NOW - 59_999)).toBe('active');
  });

  it('turns idle at exactly one minute without input', () => {
    expect(inputStateAt(NOW, NOW - IDLE_AFTER_MS)).toBe('idle');
    expect(inputStateAt(NOW, NOW - 30 * 60_000)).toBe('idle');
  });

  it('treats "never had input" and garbage as idle', () => {
    expect(inputStateAt(NOW, null)).toBe('idle');
    expect(inputStateAt(NOW, undefined)).toBe('idle');
    expect(inputStateAt(NOW, 0)).toBe('idle');
    expect(inputStateAt(NOW, Number.NaN)).toBe('idle');
  });

  it('counts an input stamped slightly in the future as now', () => {
    expect(inputStateAt(NOW, NOW + 2_000)).toBe('active');
  });

  it('honours a custom threshold', () => {
    expect(inputStateAt(NOW, NOW - 10_000, 5_000)).toBe('idle');
  });
});

describe('mergeLastInput — working in one tab keeps every tab active', () => {
  it('takes the newest of this tab and the others', () => {
    expect(mergeLastInput(NOW - 90_000, String(NOW - 5_000), NOW)).toBe(NOW - 5_000);
    expect(mergeLastInput(NOW - 5_000, String(NOW - 90_000), NOW)).toBe(NOW - 5_000);
  });

  it('accepts a number as well as the localStorage string', () => {
    expect(mergeLastInput(null, NOW - 1_000, NOW)).toBe(NOW - 1_000);
  });

  it('ignores unreadable, non-positive or far-future shared values', () => {
    expect(mergeLastInput(NOW - 70_000, 'abc', NOW)).toBe(NOW - 70_000);
    expect(mergeLastInput(NOW - 70_000, null, NOW)).toBe(NOW - 70_000);
    expect(mergeLastInput(NOW - 70_000, '0', NOW)).toBe(NOW - 70_000);
    expect(mergeLastInput(NOW - 70_000, '-5', NOW)).toBe(NOW - 70_000);
    expect(mergeLastInput(NOW - 70_000, String(NOW + 60 * 60_000), NOW)).toBe(NOW - 70_000);
  });

  it('returns null when neither side knows of any input', () => {
    expect(mergeLastInput(null, null, NOW)).toBeNull();
    expect(mergeLastInput(0, 'x', NOW)).toBeNull();
  });

  it('feeds inputStateAt end to end', () => {
    // This tab has been untouched for 5 minutes, another tab saw a click 10 s ago.
    const merged = mergeLastInput(NOW - 5 * 60_000, String(NOW - 10_000), NOW);
    expect(inputStateAt(NOW, merged)).toBe('active');
  });
});

describe('inputThrottle — no work per mousemove', () => {
  it('records at most once a second', () => {
    expect(inputThrottle(NOW, NOW - 500, 0).mark).toBe(false);
    expect(inputThrottle(NOW, NOW - 1_000, 0).mark).toBe(true);
  });

  it('shares with other tabs at most every 5 seconds', () => {
    expect(inputThrottle(NOW, NOW - 2_000, NOW - 2_000)).toEqual({ mark: true, share: false });
    expect(inputThrottle(NOW, NOW - 2_000, NOW - 5_000)).toEqual({ mark: true, share: true });
  });

  it('never shares an event it did not record', () => {
    expect(inputThrottle(NOW, NOW - 10, NOW - 60_000)).toEqual({ mark: false, share: false });
  });
});

describe('observeCall — a call on the handset is work', () => {
  it('no call → not active, clock reset', () => {
    expect(observeCall('idle', NOW - 1_000, NOW)).toEqual({ since: null, active: false });
    expect(observeCall(undefined, null, NOW)).toEqual({ since: null, active: false });
  });

  it('a call starts its own clock and counts as activity', () => {
    expect(observeCall('in_call', null, NOW)).toEqual({ since: NOW, active: true });
    expect(observeCall('dialing', null, NOW).active).toBe(true);
    expect(observeCall('wrapping', NOW - 5 * 60_000, NOW)).toEqual({ since: NOW - 5 * 60_000, active: true });
  });

  it('stops counting a call stuck past the cap', () => {
    expect(observeCall('in_call', NOW - CALL_ACTIVE_CAP_MS, NOW).active).toBe(false);
    expect(observeCall('in_call', NOW - CALL_ACTIVE_CAP_MS + 1, NOW).active).toBe(true);
  });
});

describe('splitMinutes', () => {
  it('splits whole minutes', () => {
    expect(splitMinutes(205)).toEqual({ h: 3, m: 25 });
    expect(splitMinutes(59)).toEqual({ h: 0, m: 59 });
    expect(splitMinutes(60)).toEqual({ h: 1, m: 0 });
  });

  it('floors and clamps junk to zero', () => {
    expect(splitMinutes(61.9)).toEqual({ h: 1, m: 1 });
    expect(splitMinutes(-5)).toEqual({ h: 0, m: 0 });
    expect(splitMinutes(null)).toEqual({ h: 0, m: 0 });
    expect(splitMinutes(undefined)).toEqual({ h: 0, m: 0 });
  });
});

describe('Skopje calendar helpers', () => {
  it('skopjeDay rolls over at Skopje midnight, not UTC midnight', () => {
    // 22:30Z on 27.09 is 00:30 on 28.09 in Skopje (CEST, UTC+2).
    expect(skopjeDay(new Date('2026-09-27T22:30:00Z'))).toBe('2026-09-28');
    expect(skopjeDay(new Date('2026-09-27T21:59:00Z'))).toBe('2026-09-27');
    // Winter (CET, UTC+1): 23:30Z on 15.01 is 00:30 on 16.01.
    expect(skopjeDay(new Date('2026-01-15T23:30:00Z'))).toBe('2026-01-16');
  });

  it('shiftDay walks the calendar across month, year and DST boundaries', () => {
    expect(shiftDay('2026-09-30', 1)).toBe('2026-10-01');
    expect(shiftDay('2026-01-01', -1)).toBe('2025-12-31');
    expect(shiftDay('2026-10-25', 1)).toBe('2026-10-26'); // CEST → CET night
    expect(shiftDay('2026-03-29', -1)).toBe('2026-03-28'); // CET → CEST night
    expect(shiftDay('2028-02-28', 1)).toBe('2028-02-29');
  });

  it('skopjeHm shows the Skopje wall clock', () => {
    expect(skopjeHm('2026-09-28T06:05:00Z')).toBe('08:05');
    expect(skopjeHm('2026-01-15T06:05:00Z')).toBe('07:05');
    expect(skopjeHm('2026-09-27T22:00:00Z')).toBe('00:00');
    expect(skopjeHm(null)).toBe('');
    expect(skopjeHm('not a date')).toBe('');
  });
});
