import { format as dfFormat, formatDistanceToNow as dfFormatDistanceToNow } from 'date-fns';
import { bg, sq, mk } from 'date-fns/locale';
import i18n from './index';
import { localDateOfYmd, skopjeWallDate } from '@/lib/skopjeTime';

// Locale-aware date formatting for USER-VISIBLE dates (word-bearing patterns
// like 'MMM d', 'PPP', formatDistanceToNow). Machine formats — 'yyyy-MM-dd'
// API payloads and the fulfilment CSV timestamp — must keep importing
// date-fns directly so they never localize.
//
// The CLOCK is always Europe/Skopje (owner 01.10.2026: "the same time
// everywhere"), whatever the reader's computer is set to:
//   - a timestamp (an ISO string or epoch ms from the api) is shown on the Skopje
//     clock — a call at 00:30 Skopje is "01.10 00:30" on every screen;
//   - a bare 'YYYY-MM-DD' is a calendar day and is shown as that day (never read
//     as UTC midnight and shifted to the day before);
//   - a Date object is taken as a calendar / picker value (day pickers, month
//     axes, `new Date(y, m, d)`) and shown with its own local fields. To show an
//     INSTANT, pass the timestamp string or number — not `new Date(timestamp)`.

const LOCALES = { bg, sq, mk } as const; // en = date-fns default (undefined)

const localeFor = () => LOCALES[i18n.language as keyof typeof LOCALES];

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/** What date-fns should format: Skopje's wall clock for a timestamp, the day itself for a YYYY-MM-DD. */
function displayDate(date: Date | number | string): Date {
  if (date instanceof Date) return date;
  if (typeof date === 'string' && YMD_RE.test(date)) return localDateOfYmd(date);
  return skopjeWallDate(date) ?? new Date(NaN);
}

export function formatDate(date: Date | number | string, fmt: string): string {
  return dfFormat(displayDate(date), fmt, { locale: localeFor() });
}

export function formatDistanceToNow(
  date: Date | number | string,
  options?: { addSuffix?: boolean; includeSeconds?: boolean },
): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return dfFormatDistanceToNow(d, { ...options, locale: localeFor() });
}

/**
 * A user-visible calendar day as dd.MM.yyyy (Macedonian day-first order), the
 * same in every UI language and browser — `toLocaleDateString()` follows the
 * reader's machine instead (e.g. 9/28/2026). A timestamp is dated on the Skopje
 * calendar (an order at 00:30 Skopje is that day, not the day before). '—' for
 * a missing/invalid value, where date-fns `format` would throw.
 */
export function formatDayDmy(date: Date | number | string | null | undefined): string {
  if (date == null || date === '') return '—';
  const d = displayDate(date);
  return Number.isNaN(d.getTime()) ? '—' : dfFormat(d, 'dd.MM.yyyy');
}

/** Pass to react-day-picker (ui/calendar.tsx) so pickers localize month/weekday names. */
export const dayPickerLocale = localeFor;
