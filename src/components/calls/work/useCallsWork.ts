import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { apiRecordCallOutcome, type RecordOutcomeBody, type RecordOutcomeResult } from '@/lib/callsWorkApi';

/** How long "Не одговара" can be taken back. */
export const UNDO_MS = 5_000;

export interface DeferredOutcome {
  id: number;
  body: RecordOutcomeBody;
  /** Who it was for — shown on the undo bar. */
  label: string;
  startedAt: number;
  onCommitted?: (res: RecordOutcomeResult) => void;
  onFailed?: (err: unknown) => void;
  /** Put the customer back on screen. */
  onUndo: () => void;
}

/**
 * One-tap "Не одговара" with a 5 s undo. The page moves to the next customer at once;
 * the outcome is SENT only when the undo window closes — so an undo has nothing to
 * revert on the server (the no-answer lifecycle parks members, flips leads to
 * call_again and counts the 9-strike streak; none of that is safely reversible).
 * A newer outcome, leaving the page, hiding the tab (the phone app opening for the
 * next call) or closing it sends the pending one immediately (keepalive).
 */
export function useDeferredOutcome(send: typeof apiRecordCallOutcome = apiRecordCallOutcome) {
  const [pending, setPending] = useState<DeferredOutcome | null>(null);
  const ref = useRef<DeferredOutcome | null>(null);
  const timer = useRef<number | null>(null);

  const clearTimer = () => {
    if (timer.current != null) { window.clearTimeout(timer.current); timer.current = null; }
  };

  const commit = useCallback((keepalive = false) => {
    const p = ref.current;
    if (!p) return;
    ref.current = null;
    clearTimer();
    setPending(null);
    void send(p.body, keepalive ? { keepalive: true } : undefined).then(
      (res) => p.onCommitted?.(res),
      (err) => p.onFailed?.(err),
    );
  }, [send]);

  const schedule = useCallback((p: Omit<DeferredOutcome, 'id' | 'startedAt'>) => {
    commit(); // a newer outcome closes the previous undo window
    const next: DeferredOutcome = { ...p, id: Date.now(), startedAt: Date.now() };
    ref.current = next;
    setPending(next);
    timer.current = window.setTimeout(() => commit(), UNDO_MS);
  }, [commit]);

  const undo = useCallback(() => {
    const p = ref.current;
    if (!p) return;
    ref.current = null;
    clearTimer();
    setPending(null);
    p.onUndo();
  }, []);

  useEffect(() => {
    const onVisibility = () => { if (document.visibilityState === 'hidden') commit(true); };
    const onPageHide = () => commit(true);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      commit(true);
    };
  }, [commit]);

  return { pending, schedule, commit, undo };
}

/** The api broadcasts `refresh` on this channel after any queue change (the Assigner's). */
export const CALLS_LIVE_CHANNEL = 'assigner';
export const CALLS_LIVE_DEBOUNCE_MS = 800;

/**
 * Refresh the agent's queues the moment the api says they changed — a manager handing
 * work over, a claim, a distribution — instead of waiting for the next poll. Only
 * signals for THIS agent (or for everyone) count. `orders` is not in the realtime
 * publication, hence the broadcast.
 */
export function useCallsLive(userId: string | undefined, onRefresh: () => void) {
  const cb = useRef(onRefresh);
  cb.current = onRefresh;
  useEffect(() => {
    if (!userId) return;
    let t: number | null = null;
    const signal = (msg: { payload?: { agent_id?: string | null } } | undefined) => {
      const aid = msg?.payload?.agent_id;
      if (aid && aid !== userId) return;
      if (t != null) window.clearTimeout(t);
      t = window.setTimeout(() => { t = null; cb.current(); }, CALLS_LIVE_DEBOUNCE_MS);
    };
    let channel: ReturnType<typeof supabase.channel> | null = null;
    try {
      channel = supabase.channel(CALLS_LIVE_CHANNEL).on('broadcast', { event: 'refresh' }, signal).subscribe();
    } catch {
      channel = null; // no realtime (tests, a blocked socket) — the polls still run
    }
    return () => {
      if (t != null) window.clearTimeout(t);
      if (channel) void supabase.removeChannel(channel);
    };
  }, [userId]);
}

/** document.hidden as React state (re-renders so a function refetchInterval re-evaluates). */
export function useDocumentHidden(): boolean {
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.visibilityState === 'hidden');
  useEffect(() => {
    const on = () => setHidden(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return hidden;
}
