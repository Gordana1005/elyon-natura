import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { invalidateAssigner } from './assignerQueries';

/** The api broadcasts `refresh` on this channel after any queue change (plan A6). */
export const ASSIGNER_CHANNEL = 'assigner';
export const LIVE_DEBOUNCE_MS = 800;

/**
 * Live updates, the TV board's pattern: `orders` is not in the realtime
 * publication, so the api BROADCASTS after every write that changes an agent's
 * queue (call outcomes, dispositions, claims, distributions). A burst of
 * broadcasts collapses into one refetch ~0,8 s after the last one. The 5 s
 * board poll is the safety net when the socket is down.
 */
export function useAssignerLive() {
  const qc = useQueryClient();
  const timer = useRef<number | null>(null);
  const [lastSignalAt, setLastSignalAt] = useState<number | null>(null);

  useEffect(() => {
    const schedule = () => {
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        timer.current = null;
        setLastSignalAt(Date.now());
        invalidateAssigner(qc);
      }, LIVE_DEBOUNCE_MS);
    };
    let channel: ReturnType<typeof supabase.channel> | null = null;
    try {
      channel = supabase
        .channel(ASSIGNER_CHANNEL)
        .on('broadcast', { event: 'refresh' }, () => schedule())
        .subscribe();
    } catch {
      channel = null; // no realtime (tests, a blocked socket) — the poll still runs
    }
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
      if (channel) void supabase.removeChannel(channel);
    };
  }, [qc]);

  return { lastSignalAt };
}

/** A clock that ticks every `ms` — ages "refreshed N s ago". */
export function useNow(ms = 1_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}
