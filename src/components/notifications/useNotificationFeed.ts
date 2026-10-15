import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { fetchOverview, fetchRows, markAllRead, markRowRead, markStackRead } from '@/lib/notifications/api';
import { EMPTY_OVERVIEW, buildFeed, unreadCount, type NotifStack } from '@/lib/notifications/feed';
import type { NotificationRow } from '@/lib/notifications/localize';
import type { NotifFilter } from '@/lib/notifications/registry';
import { showNotificationToast } from './notificationToasts';

const NOTIF_KEY = ['notifications'] as const;
const ROWS_PAGE = 50;

/**
 * The bell and /notifications read the same way (owner 15.10.2026): the stacks of a window +
 * the non-stacked rows apart, the read watermark, Realtime INSERTs (a toast + a debounced refresh —
 * a burst of 400 paid rows is ONE refetch, not 400).
 *
 * `from` / `to` are UTC instants ([from, to)); the bell passes the last 7 Skopje days and no `to`.
 * `live` subscribes to Realtime and pops the arrival toasts — the bell only, never twice.
 */
export function useNotificationFeed({
  from, to = null, filter, live = false, pinLimit = 5, poll = false,
}: {
  from: string;
  to?: string | null;
  filter: NotifFilter;
  live?: boolean;
  pinLimit?: number;
  poll?: boolean;
}) {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const qc = useQueryClient();

  const overview = useQuery({
    queryKey: [...NOTIF_KEY, 'overview', userId, from, to],
    queryFn: () => fetchOverview(from, to),
    enabled: !!userId,
    staleTime: 15_000,
    refetchInterval: poll ? 60_000 : false,
  });

  const rows = useInfiniteQuery({
    queryKey: [...NOTIF_KEY, 'rows', userId, filter, from, to],
    queryFn: ({ pageParam }) => fetchRows({
      userId: userId as string, filter, limit: ROWS_PAGE, before: pageParam,
      // The bell lists every non-stacked row it can (they are few); the page keeps to its period.
      from: to ? from : null, to,
    }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.length < ROWS_PAGE ? undefined : last[last.length - 1].created_at),
    enabled: !!userId,
    staleTime: 15_000,
    refetchInterval: poll ? 60_000 : false,
  });

  const refresh = useCallback(() => { void qc.invalidateQueries({ queryKey: NOTIF_KEY }); }, [qc]);

  // Realtime: INSERT only — a mark-as-read is an UPDATE and must stay silent (and "mark all" writes
  // no row at all, it moves the watermark).
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!live || !userId) return;
    const channel = supabase
      .channel('notifications-realtime')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${userId}` },
        (payload) => {
          if (payload.new) showNotificationToast(payload.new as NotificationRow);
          if (debounce.current) clearTimeout(debounce.current);
          debounce.current = setTimeout(refresh, 1000);
        },
      )
      .subscribe();
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
      supabase.removeChannel(channel);
    };
  }, [live, userId, refresh]);

  const ov = overview.data ?? EMPTY_OVERVIEW;
  const allRows = useMemo(() => (rows.data?.pages ?? []).flat(), [rows.data]);
  const feed = useMemo(
    () => buildFeed({ rows: allRows, stacks: ov.stacks, readBefore: ov.readBefore, filter, pinLimit }),
    [allRows, ov, filter, pinLimit],
  );

  const markRow = useCallback(async (n: NotificationRow) => {
    if (!n.is_read) {
      await markRowRead(n.id);
      refresh();
    }
  }, [refresh]);
  const markStack = useCallback(async (s: NotifStack) => {
    await markStackRead(s.type, s.day);
    refresh();
  }, [refresh]);
  const markAll = useCallback(async () => {
    await markAllRead();
    refresh();
  }, [refresh]);

  return {
    userId,
    overview: ov,
    feed,
    readBefore: ov.readBefore,
    unread: unreadCount(ov),
    countOf: (f: NotifFilter) => unreadCount(ov, f),
    loading: overview.isLoading || rows.isLoading,
    error: overview.error ?? rows.error ?? null,
    hasMoreRows: !!rows.hasNextPage,
    loadingMoreRows: rows.isFetchingNextPage,
    loadMoreRows: () => void rows.fetchNextPage(),
    refresh,
    markRow,
    markStack,
    markAll,
  };
}
