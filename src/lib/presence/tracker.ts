/**
 * Presence tracker — ONE per browser tab, whatever React does.
 *
 * AppLayout is rendered by every page, so it unmounts and remounts on each
 * navigation. The tracker therefore lives at module scope: the hook
 * (usePresenceTracking) only acquires and releases it, and a short grace
 * period rides over the remount, so listeners, the beat interval and the idle
 * clock all survive navigation.
 *
 *   · Input listeners (pointer move/down, keys, wheel, touch, scroll, window
 *     focus, tab becoming visible) do O(1) work, throttled to once a second,
 *     and never touch React state — no re-render per mousemove.
 *   · The newest input time is shared with the other CRM tabs through
 *     localStorage, so working in one tab keeps every tab 'active'.
 *   · A call in progress counts as activity (VOIP is off: agents talk on their
 *     own handsets and the screen does not move), capped at an hour.
 *   · Beats POST /presence/activity once a minute, visible tab or not, and
 *     never for a session that is gone.
 *   · Shows the sticky idle toast when the server answers should_alert.
 *
 * It never touches profiles.last_seen_at: that is AuthContext's visible-tab
 * heartbeat (POST /presence/heartbeat), the lead-distribution engine's
 * "online" signal. Breaks are not reported from here either — the server reads
 * the break button's shift_breaks row itself (migration 20260935000200).
 */
import { supabase } from '@/integrations/supabase/client';
import { apiPresenceActivity } from '@/lib/api';
import { getBusCallState } from '@/lib/voip/callStateBus';
import { HEARTBEAT_MS, inputStateAt, inputThrottle, mergeLastInput, observeCall } from './state';
import { showIdleSelfToast } from './ui';

const RELEASE_GRACE_MS = 5_000;     // rides over AppLayout's per-page remount
const FIRST_BEAT_DELAY_MS = 2_000;  // let the page's own requests go first
const BEAT_TIMEOUT_MS = 15_000;     // a slow beat must never pile up behind the next
const INPUT_EVENTS = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'] as const;
const LISTEN_OPTS: AddEventListenerOptions = { capture: true, passive: true };

let userId: string | null = null;
let refs = 0;
let releaseTimer: ReturnType<typeof setTimeout> | null = null;
let firstBeatTimer: ReturnType<typeof setTimeout> | null = null;
let beatTimer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;
let lastInputAt = 0;
let lastMarkedAt = 0;
let lastSharedAt = 0;
let callSince: number | null = null;

const sharedKey = (uid: string) => `elyon.presence.lastInput:${uid}`;

function readShared(uid: string): string | null {
  try { return window.localStorage.getItem(sharedKey(uid)); } catch { return null; }
}

function writeShared(uid: string, at: number): void {
  // Private mode / blocked storage: this tab's own clock still works.
  try { window.localStorage.setItem(sharedKey(uid), String(at)); } catch { /* ignore */ }
}

function markInput(now: number = Date.now()): void {
  const { mark, share } = inputThrottle(now, lastMarkedAt, lastSharedAt);
  if (!mark) return;
  lastMarkedAt = now;
  lastInputAt = now;
  if (share && userId) {
    lastSharedAt = now;
    writeShared(userId, now);
  }
}

const onInput = () => markInput();
const onVisibility = () => { if (document.visibilityState === 'visible') markInput(); };

async function beat(): Promise<void> {
  const uid = userId;
  if (!uid || inFlight) return;
  inFlight = true;
  try {
    const now = Date.now();
    const call = observeCall(getBusCallState(), callSince, now);
    callSince = call.since;
    if (call.active) markInput(now);
    const state = inputStateAt(now, mergeLastInput(lastInputAt, readShared(uid), now));

    // Never beat for a session that is gone (signed out here or in another tab).
    const { data: { session } } = await supabase.auth.getSession();
    if (!session || session.user.id !== uid || userId !== uid) return;

    const res = await apiPresenceActivity(state, AbortSignal.timeout(BEAT_TIMEOUT_MS));
    if (res?.should_alert && userId === uid) {
      showIdleSelfToast(Number(res.alert_minutes ?? res.idle_minutes_streak ?? 0));
    }
  } catch {
    // Non-critical — the next beat retries in a minute.
  } finally {
    inFlight = false;
  }
}

function start(uid: string): void {
  userId = uid;
  lastInputAt = Date.now(); // the page just loaded / the person just signed in
  lastMarkedAt = 0;
  lastSharedAt = 0;
  callSince = null;
  for (const ev of INPUT_EVENTS) window.addEventListener(ev, onInput, LISTEN_OPTS);
  window.addEventListener('focus', onInput);
  document.addEventListener('visibilitychange', onVisibility);
  firstBeatTimer = setTimeout(() => { firstBeatTimer = null; void beat(); }, FIRST_BEAT_DELAY_MS);
  beatTimer = setInterval(() => { void beat(); }, HEARTBEAT_MS);
}

function stop(): void {
  for (const ev of INPUT_EVENTS) window.removeEventListener(ev, onInput, LISTEN_OPTS);
  window.removeEventListener('focus', onInput);
  document.removeEventListener('visibilitychange', onVisibility);
  if (firstBeatTimer) clearTimeout(firstBeatTimer);
  if (beatTimer) clearInterval(beatTimer);
  if (releaseTimer) clearTimeout(releaseTimer);
  firstBeatTimer = null;
  beatTimer = null;
  releaseTimer = null;
  userId = null;
  refs = 0;
  callSince = null;
}

/** Start (or keep) tracking this login in this tab. */
export function acquirePresence(uid: string): void {
  if (releaseTimer) { clearTimeout(releaseTimer); releaseTimer = null; }
  if (userId && userId !== uid) stop(); // a different login in this tab
  refs += 1;
  if (!userId) start(uid);
}

/** Stop tracking once nothing holds the tracker for a moment (grace covers the
 *  unmount → remount of a page navigation). */
export function releasePresence(uid: string): void {
  if (userId !== uid) return;
  refs = Math.max(0, refs - 1);
  if (refs > 0) return;
  if (releaseTimer) clearTimeout(releaseTimer);
  releaseTimer = setTimeout(() => {
    releaseTimer = null;
    if (refs === 0) stop();
  }, RELEASE_GRACE_MS);
}
