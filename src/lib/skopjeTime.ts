/**
 * The Skopje clock for the SPA (owner 01.10.2026: "we need to match everywhere that it's the
 * same time"). The CRM's day and every time shown are Europe/Skopje — whatever the reader's
 * computer is set to. The day arithmetic is the api's own dependency-free module
 * (supabase/functions/api/skopjeTime.ts), re-exported, so the screen and the server can never
 * disagree on where a day starts; this file adds what only a browser needs:
 *
 *   formatSkopje(at, 'dd.MM HH:mm')   an INSTANT on the Skopje clock (date-fns pattern, not
 *                                     localized — the drop-in for `format(new Date(x), …)`)
 *   skopjeWallDate(at)                a Date whose LOCAL fields are Skopje's wall clock, for
 *                                     date-fns / day pickers
 *   skopjeTodayLocal()                Skopje's today as a local-midnight Date (day pickers'
 *                                     "today", min / disabled dates)
 *   localDateOfYmd('2026-10-01')      a calendar day as a local-midnight Date
 *   toSkopjeDatetimeLocal / fromSkopjeDatetimeLocal
 *                                     <input type="datetime-local"> values on the Skopje clock
 */
import { format as dfFormat } from 'date-fns';
import { isValidYmd, skopjeParts, skopjeWallToUtcMs, skopjeYmd } from '../../supabase/functions/api/skopjeTime';

export * from '../../supabase/functions/api/skopjeTime';

const toMs = (at: Date | number | string): number =>
  at instanceof Date ? at.getTime() : typeof at === 'number' ? at : Date.parse(at);

/**
 * A Date whose browser-local fields (getFullYear … getMinutes) read Skopje's wall clock at the
 * instant `at`. Only for FORMATTING / calendar UI — its getTime() is not the instant. Null for
 * an unreadable value.
 */
export function skopjeWallDate(at: Date | number | string): Date | null {
  const ms = toMs(at);
  if (!Number.isFinite(ms)) return null;
  const p = skopjeParts(ms);
  return new Date(p.y, p.mo - 1, p.d, p.h, p.mi, p.s, ((ms % 1000) + 1000) % 1000);
}

/** A YYYY-MM-DD calendar day as a local-midnight Date (what day pickers hand out and take). */
export function localDateOfYmd(ymd: string): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d);
}

const YMD_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * An instant on the Skopje clock with a date-fns pattern (not localized) — the drop-in for
 * `format(new Date(x), …)`. A bare YYYY-MM-DD is a calendar day and is shown as that day.
 * '—' when missing / unreadable (date-fns `format` would throw).
 */
export function formatSkopje(at: Date | number | string | null | undefined, pattern: string): string {
  if (at == null || at === '') return '—';
  const wall = typeof at === 'string' && YMD_ONLY.test(at) ? localDateOfYmd(at) : skopjeWallDate(at);
  return wall && !Number.isNaN(wall.getTime()) ? dfFormat(wall, pattern) : '—';
}

/** Skopje's today as a local-midnight Date — the day pickers' "today" on any computer. */
export function skopjeTodayLocal(now: Date = new Date()): Date {
  return localDateOfYmd(skopjeYmd(now));
}

const pad = (n: number) => String(n).padStart(2, '0');

/** An instant → an <input type="datetime-local"> value on the Skopje clock (YYYY-MM-DDTHH:mm). */
export function toSkopjeDatetimeLocal(at: Date): string {
  const p = skopjeParts(at);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}`;
}

/** An <input type="datetime-local"> value read as Skopje wall time → the instant; null when empty / unreadable. */
export function fromSkopjeDatetimeLocal(value: string | null | undefined): Date | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec((value ?? '').trim());
  if (!m || !isValidYmd(m[1])) return null;
  const [y, mo, d] = m[1].split('-').map(Number);
  const h = Number(m[2]), mi = Number(m[3]), s = Number(m[4] ?? 0);
  if (h > 23 || mi > 59 || s > 59) return null;
  return new Date(skopjeWallToUtcMs(y, mo, d, h, mi, s));
}
