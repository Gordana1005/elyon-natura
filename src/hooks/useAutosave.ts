import { useCallback, useEffect, useRef, useState } from 'react';
import { nextSaveStatus, type SaveEvent, type SaveStatus } from '@/lib/personalNotes/model';

// The Личен дневник's autosave (plan Фаза 7, 01.10.2026):
//  - an edit is saved 1.200 ms after the typing stops (each edit restarts the clock);
//  - it is flushed at once on blur, on a note switch (unmount), when the tab is hidden
//    (visibilitychange) and when the page goes away (pagehide — a keepalive fetch);
//  - ONE request in flight: edits made meanwhile are merged and sent right after it, so the
//    newest edit always wins and the server never sees two writes on the same base version;
//  - versioned: every save carries the version it started from; a 409 holds the edit and
//    asks the person ("Земи ја новата" / "Задржи ја мојата") — nothing is overwritten silently.

export interface AutosaveSaved { version: number }

export interface UseAutosaveOptions<P extends object, R extends AutosaveSaved> {
  /** The server version the editor started from. */
  version: number;
  /** Write `patch` on `baseVersion`; resolves the new version, rejects on a conflict / failure. */
  save: (patch: P, baseVersion: number, opts: { keepalive: boolean }) => Promise<R>;
  isConflict: (err: unknown) => boolean;
  onSaved?: (result: R, patch: P) => void;
  onConflict?: (err: unknown) => void;
  onError?: (err: unknown) => void;
  /** Debounce, ms (default 1.200). */
  delay?: number;
  /** false = read-only: nothing is ever scheduled or sent. */
  enabled?: boolean;
}

export const AUTOSAVE_DELAY_MS = 1200;

export function useAutosave<P extends object, R extends AutosaveSaved>(options: UseAutosaveOptions<P, R>) {
  const opts = useRef(options);
  opts.current = options;

  const [status, setStatus] = useState<SaveStatus>('idle');
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const statusRef = useRef<SaveStatus>('idle');
  const mounted = useRef(true);
  const pending = useRef<P | null>(null);
  const version = useRef(options.version);
  const inFlight = useRef<Promise<void> | null>(null);
  const again = useRef<{ keepalive: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dispatch = useCallback((e: SaveEvent) => {
    statusRef.current = nextSaveStatus(statusRef.current, e);
    if (mounted.current) setStatus(statusRef.current);
  }, []);

  const clearTimer = () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
  };

  const run = useCallback((keepalive = false): Promise<void> => {
    clearTimer();
    if (inFlight.current) {
      // One request at a time: remember to send the newest edits right after this one.
      again.current = { keepalive: keepalive || !!again.current?.keepalive };
      return inFlight.current;
    }
    const patch = pending.current;
    if (!patch || statusRef.current === 'conflict') return Promise.resolve();
    pending.current = null;
    dispatch({ type: 'send' });
    const p = (async () => {
      try {
        const r = await opts.current.save(patch, version.current, { keepalive });
        version.current = r.version;
        if (mounted.current) setSavedAt(Date.now());
        opts.current.onSaved?.(r, patch);
        dispatch({ type: 'ok', pendingAfter: !!pending.current });
      } catch (err) {
        // Keep the unsent edit under anything typed since (newest wins).
        pending.current = { ...patch, ...(pending.current ?? {}) } as P;
        again.current = null;
        if (opts.current.isConflict(err)) {
          dispatch({ type: 'conflict' });
          opts.current.onConflict?.(err);
        } else {
          dispatch({ type: 'fail' });
          opts.current.onError?.(err);
        }
      } finally {
        inFlight.current = null;
      }
      const next = again.current;
      again.current = null;
      if (next && pending.current) await run(next.keepalive);
    })();
    inFlight.current = p;
    return p;
  }, [dispatch]);

  /** An edit: merged into the unsent patch, saved after the debounce. */
  const schedule = useCallback((patch: Partial<P>) => {
    if (opts.current.enabled === false) return;
    pending.current = { ...(pending.current ?? {}), ...patch } as P;
    dispatch({ type: 'edit' });
    clearTimer();
    if (statusRef.current === 'conflict') return;
    timer.current = setTimeout(() => { void run(false); }, opts.current.delay ?? AUTOSAVE_DELAY_MS);
  }, [dispatch, run]);

  /** Save now (blur, pin, move, before a delete). Resolves when nothing is left to send. */
  const flush = useCallback(async (o?: { keepalive?: boolean }) => {
    await run(!!o?.keepalive);
    // An edit that arrived while the first save ran is chained by run(); wait for it too.
    while (inFlight.current) await inFlight.current;
  }, [run]);

  /** "Земи ја новата": drop my unsent edit, continue on the server's version. */
  const takeTheirs = useCallback((serverVersion: number) => {
    clearTimer();
    pending.current = null;
    version.current = serverVersion;
    dispatch({ type: 'take_theirs' });
    if (mounted.current) setSavedAt(Date.now());
  }, [dispatch]);

  /** "Задржи ја мојата": write my whole draft on the server's version. */
  const keepMine = useCallback((serverVersion: number, draft: P) => {
    version.current = serverVersion;
    pending.current = { ...draft, ...(pending.current ?? {}) } as P;
    dispatch({ type: 'keep_mine' });
    return run(false);
  }, [dispatch, run]);

  useEffect(() => {
    mounted.current = true;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') void run(true);
    };
    const onPageHide = () => {
      clearTimer();
      const patch = pending.current;
      if (!patch || statusRef.current === 'conflict') return;
      if (!inFlight.current) { void run(true); return; }
      // Leaving mid-save: send the newest edit on the version the running save produces.
      opts.current.save(patch, version.current + 1, { keepalive: true }).then(
        (r) => { if (pending.current === patch) pending.current = null; version.current = Math.max(version.current, r.version); },
        () => { /* the page is gone; nothing to tell */ },
      );
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      mounted.current = false;
      // A note switch / leaving the page: the last edit is not lost.
      if (pending.current && statusRef.current !== 'conflict') void run(false);
      else clearTimer();
    };
  }, [run]);

  return {
    status,
    savedAt,
    schedule,
    flush,
    retry: flush,
    takeTheirs,
    keepMine,
    hasPending: () => !!pending.current || !!inFlight.current,
    currentVersion: () => version.current,
  };
}
