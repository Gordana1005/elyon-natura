// ============================================================================
// The ONE Skopje calendar of the api (owner 01.10.2026: "we need to match
// everywhere that it's the same time").
//
// The CRM's day is Europe/Skopje (CET +1 / CEST +2). The edge runtime and the
// database both run in UTC, so every "today", every day boundary and every day
// bucket must be computed here — never with Date#setHours / getDate /
// toISOString().slice(0, 10) on the server clock (that is the UTC day, which
// starts at 01:00 / 02:00 Skopje).
//
// Dependency-free on purpose (no Deno globals, no URL imports): vitest runs
// skopjeTime.test.ts against this file in Node; index.ts, overview.ts and the
// other api modules import it.
//
// DST: the two changeover days are exact. 29.03.2026 has 23 hours, 25.10.2026
// has 25 — a day boundary is the instant Skopje's wall clock reads 00:00, found
// by asking the offset AT that instant (a noon probe gets the changeover
// midnight wrong by an hour, a fixed 24 h day drops or adds the extra hour).
// ============================================================================

export const SKOPJE_TZ = "Europe/Skopje";

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

const SKOPJE_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: SKOPJE_TZ, hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
});

export interface SkopjeParts { y: number; mo: number; d: number; h: number; mi: number; s: number }

const toMs = (at: Date | number | string): number =>
  at instanceof Date ? at.getTime() : typeof at === "number" ? at : Date.parse(at);

/** Skopje wall-clock fields of an instant. */
export function skopjeParts(at: Date | number | string): SkopjeParts {
  const p: Record<string, string> = {};
  for (const x of SKOPJE_PARTS.formatToParts(new Date(toMs(at)))) p[x.type] = x.value;
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}

/** Skopje wall clock minus UTC at an instant: +1 h in winter, +2 h in summer. */
export function skopjeOffsetMs(ms: number): number {
  const t = Math.floor(ms / 1000) * 1000;
  const p = skopjeParts(t);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - t;
}

/** A Skopje wall-clock time → the UTC epoch ms it names. DST-exact, including
 *  the two changeover days (a noon probe gets their midnight wrong by 1 h). */
export function skopjeWallToUtcMs(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): number {
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  let t = wall - skopjeOffsetMs(wall);
  const off = skopjeOffsetMs(t);
  if (wall - off !== t) t = wall - off;
  return t;
}

/** A real YYYY-MM-DD day (2026-02-30 is not one). */
export function isValidYmd(s: unknown): s is string {
  if (typeof s !== "string" || !YMD_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Calendar arithmetic on a YYYY-MM-DD (no timezone can shift it). */
export function addDaysYmd(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Calendar days from `from` to `to`, both inclusive (1 for a single day). */
export function daysInclusive(from: string, to: string): number {
  const a = Date.parse(from + "T00:00:00Z");
  const b = Date.parse(to + "T00:00:00Z");
  return Math.round((b - a) / 86_400_000) + 1;
}

/** The Skopje calendar day (YYYY-MM-DD) an instant falls on. '' for an unreadable value. */
export function skopjeYmd(at: Date | number | string): string {
  const ms = toMs(at);
  if (!Number.isFinite(ms)) return "";
  const p = skopjeParts(ms);
  return `${p.y}-${String(p.mo).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/** Today on the Skopje calendar. */
export function skopjeTodayYmd(now: Date = new Date()): string {
  return skopjeYmd(now);
}

/** The Skopje wall-clock hour (0–23) of an instant. */
export function skopjeHour(at: Date | number | string = new Date()): number {
  return skopjeParts(at).h;
}

/** Skopje 00:00 of a calendar day, as a UTC ISO instant. */
export function skopjeMidnightIso(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(skopjeWallToUtcMs(y, m, d)).toISOString();
}

/** The LAST instant of a Skopje calendar day (23:59:59.999999 local) as a UTC
 *  ISO string with microseconds. Used as an inclusive `<=` bound, it leaves no
 *  gap before the next day's midnight (a …59.000 bound drops the final second). */
export function skopjeDayEndIso(ymd: string): string {
  const next = Date.parse(skopjeMidnightIso(addDaysYmd(ymd, 1)));
  return new Date(next - 1).toISOString().replace(/Z$/, "999Z");
}

/** Today's Skopje day and the instant it began. */
export function skopjeDayStartOf(now: Date = new Date()): { startISO: string; day: string } {
  const day = skopjeYmd(now);
  return { startISO: skopjeMidnightIso(day), day };
}

/** [start, end) UTC window of a Skopje calendar day (default: today). A
 *  malformed day falls back to today. */
export function skopjeDayRangeOf(dayParam?: string | null, now: Date = new Date()): {
  day: string; today: string; startISO: string; endISO: string;
} {
  const today = skopjeYmd(now);
  const day = isValidYmd(dayParam) ? dayParam : today;
  return { day, today, startISO: skopjeMidnightIso(day), endISO: skopjeMidnightIso(addDaysYmd(day, 1)) };
}

/**
 * A `from` / `to` query value → an instant. A bare YYYY-MM-DD is a SKOPJE day
 * (its 00:00 for a lower bound, its last instant for an inclusive upper bound);
 * anything else (a full ISO instant from a caller that already pinned it) passes
 * through untouched. Empty → null.
 */
export function skopjeBound(v: string | null | undefined, edge: "start" | "end"): string | null {
  const s = (v ?? "").trim();
  if (!s) return null;
  if (isValidYmd(s)) return edge === "start" ? skopjeMidnightIso(s) : skopjeDayEndIso(s);
  return s;
}
