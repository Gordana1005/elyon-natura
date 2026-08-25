/**
 * Pendings queue order on /calls.
 *
 * Operator rule (2026-08-25): fresh assigned leads first; call-agains last.
 * After "Didn't Answer", never serve the same order next if any other assigned
 * work exists. If that order is the agent's only remaining lead, it may return.
 */

export type PendingQueueRow = {
  id: string;
  status?: string | null;
  next_call_after?: string | null;
  assigned_at?: string | null;
  created_at?: string | null;
  call_again_since?: string | null;
  customer_phone?: string;
};

const LEAD_ORDER: Record<string, number> = { pending: 0, take: 1, call_again: 2 };

export function isParkedLead(o: PendingQueueRow, now = Date.now()): boolean {
  return !!o.next_call_after && new Date(o.next_call_after).getTime() > now;
}

export function sortPendingQueue<T extends PendingQueueRow>(rows: T[], now = Date.now()): T[] {
  return [...rows].sort((a, b) => {
    const parked = Number(isParkedLead(a, now)) - Number(isParkedLead(b, now));
    if (parked !== 0) return parked;
    const rank = (LEAD_ORDER[a.status || ''] ?? 9) - (LEAD_ORDER[b.status || ''] ?? 9);
    if (rank !== 0) return rank;
    if (isParkedLead(a, now) && isParkedLead(b, now)) {
      return new Date(a.next_call_after || 0).getTime() - new Date(b.next_call_after || 0).getTime();
    }
    if ((a.status === 'call_again' || b.status === 'call_again') && a.status === b.status) {
      const ta = new Date(a.call_again_since || a.created_at || 0).getTime();
      const tb = new Date(b.call_again_since || b.created_at || 0).getTime();
      return ta - tb;
    }
    const aTime = new Date(a.assigned_at || a.created_at || 0).getTime();
    const bTime = new Date(b.assigned_at || b.created_at || 0).getTime();
    return bTime - aTime;
  });
}

/** Next lead after a disposition. Prefers anyone except `excludeId`; only
 *  falls back to that same id when it is the agent's last remaining row. */
export function pickNextPending<T extends PendingQueueRow>(
  sorted: T[],
  excludeId?: string | null,
): T | null {
  if (!sorted.length) return null;
  if (!excludeId) return sorted[0];
  const other = sorted.find((o) => o.id !== excludeId);
  if (other) return other;
  return sorted.find((o) => o.id === excludeId) || null;
}
