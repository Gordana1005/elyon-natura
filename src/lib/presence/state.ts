/**
 * Presence — the pure rules behind the activity beat (tracker.ts /
 * usePresenceTracking) and the owners' "Who is working" panel. No DOM, no
 * React, no network: everything here is unit-tested (state.test.ts).
 *
 * The server side is migration 20260935000200_agent_presence.sql. The browser
 * reports only what it can observe — was there input in the last minute? —
 * and the database decides the rest: breaks (from the break button's
 * shift_breaks row), the idle streak, when to alert and who is told.
 */

/** What the browser reports on each beat. Breaks are decided server-side. */
export type InputState = 'active' | 'idle';

/** No keyboard / mouse / touch / scroll for this long = idle. The database
 *  starts the idle streak this long before the first idle beat — keep the two
 *  in step. */
export const IDLE_AFTER_MS = 60_000;
/** One beat a minute while the app is open, visible tab or not. The server
 *  deduplicates beats closer than 50 s, so extra beats never double-count. */
export const HEARTBEAT_MS = 60_000;
/** A call in progress counts as activity — while VOIP is off, agents talk on
 *  their own handsets and nothing moves on screen — but only for this long,
 *  so a call state stuck after a crash cannot mask a real absence. */
export const CALL_ACTIVE_CAP_MS = 60 * 60_000;
/** Input is recorded at most once a second (plenty for a 60-second rule)… */
export const INPUT_RESOLUTION_MS = 1_000;
/** …and shared with the other CRM tabs at most every 5 seconds. */
export const SHARED_WRITE_MS = 5_000;

/** 'active' when the last input is less than `idleAfterMs` old. */
export function inputStateAt(
  now: number,
  lastInputAt: number | null | undefined,
  idleAfterMs: number = IDLE_AFTER_MS,
): InputState {
  if (lastInputAt == null || !Number.isFinite(lastInputAt) || lastInputAt <= 0) return 'idle';
  return now - lastInputAt < idleAfterMs ? 'active' : 'idle';
}

/**
 * Newest input across this tab and the others. `shared` is the raw value the
 * other tabs wrote to localStorage — anything unparseable, non-positive or
 * implausibly far in the future (another machine's clock, a bad write) is
 * ignored rather than trusted.
 */
export function mergeLastInput(local: number | null | undefined, shared: unknown, now: number): number | null {
  const raw = typeof shared === 'string' ? Number(shared) : typeof shared === 'number' ? shared : NaN;
  const sharedOk = Number.isFinite(raw) && raw > 0 && raw <= now + 5_000 ? raw : null;
  const localOk = local != null && Number.isFinite(local) && local > 0 ? local : null;
  if (localOk == null) return sharedOk;
  if (sharedOk == null) return localOk;
  return Math.max(localOk, sharedOk);
}

/**
 * Throttle for the input listeners: whether an event at `now` is recorded,
 * and whether it is also written to the shared (cross-tab) timestamp.
 */
export function inputThrottle(
  now: number,
  lastMarkedAt: number,
  lastSharedAt: number,
): { mark: boolean; share: boolean } {
  if (now - lastMarkedAt < INPUT_RESOLUTION_MS) return { mark: false, share: false };
  return { mark: true, share: now - lastSharedAt >= SHARED_WRITE_MS };
}

/**
 * One observation of the softphone state bus ('idle' | 'dialing' | 'in_call' |
 * 'wrapping' | 'ending'). Tracks when the current call began and whether it
 * still counts as activity (any non-idle state, for at most `capMs`).
 */
export function observeCall(
  busState: string | null | undefined,
  since: number | null,
  now: number,
  capMs: number = CALL_ACTIVE_CAP_MS,
): { since: number | null; active: boolean } {
  if (!busState || busState === 'idle') return { since: null, active: false };
  const start = since ?? now;
  return { since: start, active: now - start < capMs };
}

/** Whole minutes → hours + minutes, for "3 h 25 min" labels. */
export function splitMinutes(total: number | null | undefined): { h: number; m: number } {
  const t = Math.max(0, Math.floor(Number(total) || 0));
  return { h: Math.floor(t / 60), m: t % 60 };
}

/** YYYY-MM-DD of `now` on the Europe/Skopje calendar. */
export function skopjeDay(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Skopje', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

/** Calendar arithmetic on a YYYY-MM-DD string. Pure date math, so DST can
 *  never skip or repeat a day. */
export function shiftDay(day: string, delta: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}

/** HH:mm on the Skopje clock for an ISO instant ('' for none / invalid). */
export function skopjeHm(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Skopje', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d).replace(/^24:/, '00:');
}
