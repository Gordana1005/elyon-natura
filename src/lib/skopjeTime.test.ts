import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  formatSkopje, fromSkopjeDatetimeLocal, localDateOfYmd, skopjeTodayLocal, skopjeTodayYmd, skopjeWallDate,
  toSkopjeDatetimeLocal,
} from './skopjeTime';
import { formatDate, formatDayDmy } from '@/i18n/dates';
import { skopjeToday } from '@/components/insights/shared/period';
import { fromDatetimeLocal, skopjeWallToUtc, toDatetimeLocal } from '@/lib/callsWork/callbacks';

// The reader's computer may be set to any zone; the CRM shows Skopje (owner 01.10.2026).
const ZONES = ['Europe/Skopje', 'UTC', 'America/New_York', 'Asia/Tokyo'];
const savedTz = process.env.TZ;
afterEach(() => { process.env.TZ = savedTz; vi.useRealTimers(); });

describe.each(ZONES)('the Skopje clock on a computer set to %s', (tz) => {
  it('00:30 Skopje: the day is already the new one, everywhere on screen', () => {
    process.env.TZ = tz;
    const at = '2026-09-30T22:30:00Z';   // 01.10.2026 00:30 CEST
    expect(formatSkopje(at, 'dd.MM.yyyy HH:mm')).toBe('01.10.2026 00:30');
    expect(formatDate(at, 'dd.MM.yyyy HH:mm')).toBe('01.10.2026 00:30');
    expect(formatDayDmy(at)).toBe('01.10.2026');
    expect(skopjeTodayYmd(new Date(at))).toBe('2026-10-01');
    expect(skopjeToday(new Date(at))).toBe('2026-10-01');
  });

  it('23:30 Skopje: still the same day', () => {
    process.env.TZ = tz;
    const at = '2026-10-01T21:30:00Z';   // 01.10.2026 23:30 CEST
    expect(formatSkopje(at, 'dd.MM HH:mm')).toBe('01.10 23:30');
    expect(formatDayDmy(at)).toBe('01.10.2026');
  });

  it('25.10.2026 (the 25-hour day): both 02:30s and the winter evening', () => {
    process.env.TZ = tz;
    expect(formatSkopje('2026-10-25T00:30:00Z', 'dd.MM HH:mm')).toBe('25.10 02:30');   // CEST
    expect(formatSkopje('2026-10-25T01:30:00Z', 'dd.MM HH:mm')).toBe('25.10 02:30');   // CET, the hour again
    expect(formatSkopje('2026-10-25T22:30:00Z', 'dd.MM HH:mm')).toBe('25.10 23:30');
    expect(formatDayDmy('2026-10-25T22:59:59Z')).toBe('25.10.2026');
    expect(formatDayDmy('2026-10-25T23:00:00Z')).toBe('26.10.2026');
  });

  it('a bare YYYY-MM-DD is that calendar day (never read as UTC midnight)', () => {
    process.env.TZ = tz;
    expect(formatDayDmy('2026-10-01')).toBe('01.10.2026');
    expect(formatDate('2026-10-01', 'dd.MM.yyyy')).toBe('01.10.2026');
    expect(formatSkopje('2026-10-01', 'dd.MM')).toBe('01.10');
  });

  it("the pickers' today is Skopje's today", () => {
    process.env.TZ = tz;
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-30T22:30:00Z'));   // 00:30 Skopje
    const d = skopjeTodayLocal();
    expect([d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours()]).toEqual([2026, 10, 1, 0]);
    vi.setSystemTime(new Date('2026-10-01T21:30:00Z'));   // 23:30 Skopje
    expect(skopjeTodayLocal().getDate()).toBe(1);
  });

  it('datetime-local values are Skopje wall time, both ways', () => {
    process.env.TZ = tz;
    const at = new Date('2026-10-01T16:00:00Z');   // 18:00 Skopje
    expect(toSkopjeDatetimeLocal(at)).toBe('2026-10-01T18:00');
    expect(toDatetimeLocal(at)).toBe('2026-10-01T18:00');
    expect(fromSkopjeDatetimeLocal('2026-10-01T18:00')?.toISOString()).toBe('2026-10-01T16:00:00.000Z');
    expect(fromDatetimeLocal('2026-12-01T10:00')?.toISOString()).toBe('2026-12-01T09:00:00.000Z');   // CET
    expect(fromDatetimeLocal('')).toBeNull();
    expect(fromDatetimeLocal('2026-02-31T10:00')).toBeNull();
  });
});

describe('the zone switch in these tests is real', () => {
  it('a computer in Tokyo really reads local time as +9', () => {
    process.env.TZ = 'Asia/Tokyo';
    expect(new Date(2026, 9, 1).getTimezoneOffset()).toBe(-540);
    process.env.TZ = 'America/New_York';
    expect(new Date(2026, 9, 1).getTimezoneOffset()).toBe(240);
  });
});

describe('helpers', () => {
  it('skopjeWallDate carries the Skopje wall fields', () => {
    const w = skopjeWallDate('2026-09-30T22:30:00Z')!;
    expect([w.getFullYear(), w.getMonth() + 1, w.getDate(), w.getHours(), w.getMinutes()]).toEqual([2026, 10, 1, 0, 30]);
    expect(skopjeWallDate('nope')).toBeNull();
  });
  it('formatSkopje is "—" for a missing or unreadable value (date-fns would throw)', () => {
    expect(formatSkopje(null, 'HH:mm')).toBe('—');
    expect(formatSkopje('', 'HH:mm')).toBe('—');
    expect(formatSkopje('garbage', 'HH:mm')).toBe('—');
  });
  it('localDateOfYmd is a local midnight', () => {
    const d = localDateOfYmd('2026-10-25');
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()]).toEqual([2026, 9, 25, 0]);
  });
  it('callback wall time is exact on the changeover night (00:30 on 25.10 is still CEST)', () => {
    expect(skopjeWallToUtc('2026-10-25', 0, 30).toISOString()).toBe('2026-10-24T22:30:00.000Z');
    expect(skopjeWallToUtc('2026-10-25', 10).toISOString()).toBe('2026-10-25T09:00:00.000Z');
    expect(skopjeWallToUtc('2026-03-29', 1, 30).toISOString()).toBe('2026-03-29T00:30:00.000Z');
  });
});
