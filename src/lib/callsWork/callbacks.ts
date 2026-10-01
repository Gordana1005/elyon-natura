// "Повторно" — the quick callback chips (plan Фаза 11, /calls). Times are on the
// Europe/Skopje clock whatever the browser says, and every choice falls inside the
// 6-day call-again window the server enforces (callsOutcome.ts CALLBACK_MAX_MS = 5 days).

import { fromSkopjeDatetimeLocal, skopjeWallToUtcMs, toSkopjeDatetimeLocal } from '@/lib/skopjeTime';

const TZ = 'Europe/Skopje';

/** YYYY-MM-DD and HH (0–23) of an instant on the Skopje clock. */
export function skopjeParts(at: Date): { day: string; hour: number; minute: number } {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(at);
  const v = (t: string) => p.find((x) => x.type === t)?.value ?? '00';
  const hour = Number(v('hour')) % 24;
  return { day: `${v('year')}-${v('month')}-${v('day')}`, hour, minute: Number(v('minute')) };
}

/** The UTC instant of HH:MM on a Skopje calendar day — DST-exact (the shared skopjeTime module;
 *  the old noon probe was an hour off before 03:00 on the two changeover days). */
export function skopjeWallToUtc(day: string, hour: number, minute = 0): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(skopjeWallToUtcMs(y, m, d, hour, minute));
}

function nextDay(day: string, n = 1): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export type CallbackChoiceKey = 'in1h' | 'in3h' | 'evening' | 'tomorrow';
export interface CallbackChoice { key: CallbackChoiceKey; at: Date }

/** The evening chip is offered until an hour before it. */
export const EVENING_HOUR = 18;
export const TOMORROW_HOUR = 10;

/**
 * The chips, in order: in 1 h · in 3 h · this evening 18:00 (only before 17:00) ·
 * tomorrow 10:00. Rounded to the minute so the label and the stored time agree.
 */
export function callbackChoices(now: Date): CallbackChoice[] {
  const round = (ms: number) => new Date(Math.ceil(ms / 60_000) * 60_000);
  const { day, hour } = skopjeParts(now);
  const out: CallbackChoice[] = [
    { key: 'in1h', at: round(now.getTime() + 3_600_000) },
    { key: 'in3h', at: round(now.getTime() + 3 * 3_600_000) },
  ];
  if (hour < EVENING_HOUR - 1) out.push({ key: 'evening', at: skopjeWallToUtc(day, EVENING_HOUR) });
  out.push({ key: 'tomorrow', at: skopjeWallToUtc(nextDay(day), TOMORROW_HOUR) });
  return out;
}

/** HH:mm on the Skopje clock. */
export function skopjeClock(at: Date): string {
  const { hour, minute } = skopjeParts(at);
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** The latest callback the server accepts (5 days), for the custom picker's max. */
export const CALLBACK_MAX_MS = 5 * 24 * 60 * 60 * 1000;

/** A datetime-local value on the SKOPJE clock, whatever the browser's own clock (owner 01.10.2026:
 *  the same time everywhere). Read it back with fromDatetimeLocal — never `new Date(value)`, which
 *  reads it on the browser's clock. */
export function toDatetimeLocal(at: Date): string {
  return toSkopjeDatetimeLocal(at);
}

/** A datetime-local value (Skopje wall time) → the instant; null when empty / unreadable. */
export function fromDatetimeLocal(value: string | null | undefined): Date | null {
  return fromSkopjeDatetimeLocal(value);
}

/** A custom pick is valid when it is in the future and within the window. */
export function isValidCallback(at: Date | null, now: Date): boolean {
  if (!at || Number.isNaN(at.getTime())) return false;
  return at.getTime() > now.getTime() && at.getTime() <= now.getTime() + CALLBACK_MAX_MS;
}
