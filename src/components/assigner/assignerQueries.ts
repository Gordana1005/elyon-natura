import type { QueryClient } from '@tanstack/react-query';
import { apiGetCallAgains, apiGetUnassignedPending } from '@/lib/api';
import { apiGetAssignerBoard, apiGetAssignerLists, type CallAgainSource } from '@/lib/assignerApi';

/**
 * Every query the Assigner reads, in one place, so the page (tab counts), the
 * tabs (their tables) and the live refresh share ONE cache entry per view.
 */
export const ASSIGNER_KEYS = {
  board: ['assigner-board'] as const,
  lists: (departments: string[]) => ['assigner-lists', departments] as const,
  pendings: (order: 'newest' | 'oldest', departments: string[]) => ['unassigned-pending', order, departments] as const,
  callAgains: (f: CallAgainsFilters, departments: string[], page: number) =>
    ['assigner-call-agains', { ...f, departments, page }] as const,
  summary: ['assignment-summary'] as const,
};

/** The board polls every 5 s while the page is visible (plan A6). */
export const BOARD_POLL_MS = 5_000;
export const CALL_AGAINS_PAGE_SIZE = 50;

export interface CallAgainsFilters {
  source: CallAgainSource;
  /** 'all' | 'unassigned' | an agent's user_id. */
  agent: string;
  order: 'oldest' | 'newest';
}

export const boardQuery = () => ({
  queryKey: ASSIGNER_KEYS.board,
  queryFn: ({ signal }: { signal: AbortSignal }) => apiGetAssignerBoard(signal),
  refetchInterval: BOARD_POLL_MS,
  refetchIntervalInBackground: false,
  refetchOnWindowFocus: true,
  staleTime: 2_000,
});

/** ~170 ms on the server: NOT on the 5 s beat — the broadcast, every action and a 45 s poll refresh it. */
export const listsQuery = (departments: string[]) => ({
  queryKey: ASSIGNER_KEYS.lists(departments),
  queryFn: ({ signal }: { signal: AbortSignal }) => apiGetAssignerLists(departments, signal),
  refetchInterval: 45_000,
  refetchIntervalInBackground: false,
  refetchOnWindowFocus: true,
  staleTime: 5_000,
});

export const pendingsQuery = (order: 'newest' | 'oldest', departments: string[]) => ({
  queryKey: ASSIGNER_KEYS.pendings(order, departments),
  queryFn: ({ signal }: { signal: AbortSignal }) => apiGetUnassignedPending({ order, departments }, signal),
  refetchInterval: 15_000,
  refetchIntervalInBackground: false,
  refetchOnWindowFocus: true,
  staleTime: 5_000,
});

export const callAgainsQuery = (f: CallAgainsFilters, departments: string[], page: number) => ({
  queryKey: ASSIGNER_KEYS.callAgains(f, departments, page),
  queryFn: ({ signal }: { signal: AbortSignal }) => apiGetCallAgains({
    page, limit: CALL_AGAINS_PAGE_SIZE, agent_id: f.agent, source: f.source, order: f.order, departments,
  }, signal),
  refetchInterval: 30_000,
  refetchIntervalInBackground: false,
  refetchOnWindowFocus: true,
  staleTime: 5_000,
});

/** Everything a distribution, an unassign or a live "refresh" broadcast can move. */
export const ASSIGNER_INVALIDATE: readonly (readonly unknown[])[] = [
  ['assigner-board'],
  ['assigner-lists'],
  ['unassigned-pending'],
  ['assigner-call-agains'],
  ['assignment-summary'],
  ['assigner-distribute-preview'],
  ['segment'],
  ['segments'],
  ['assigner-agent-list-members'],
  ['assigner-agent-pendings'],
  ['online-agents'],
  ['my-queue-summary'],
  ['call-again-queue'],
];

export function invalidateAssigner(qc: QueryClient) {
  for (const queryKey of ASSIGNER_INVALIDATE) void qc.invalidateQueries({ queryKey: [...queryKey] });
}
