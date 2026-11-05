import type { AgentFloorRow, AgentLiveStatus } from '@/lib/api';

/**
 * Pure helpers for the Активност на агенти page (GET /agent-floor). No React,
 * no network — unit-tested in floor.test.ts.
 */

/** Who is "working" first: in a call, then online, idle, on break, offline. */
export const LIVE_RANK: Record<AgentLiveStatus, number> = {
  in_call: 0, online: 1, idle: 2, break: 3, offline: 4,
};

export type StatusFilter = 'all' | AgentLiveStatus;

/** Live status first (today), then the day's sales, then calls, then name. */
export function sortAgents(rows: AgentFloorRow[]): AgentFloorRow[] {
  const rank = (r: AgentFloorRow) => (r.live ? LIVE_RANK[r.live.status] : 0);
  return [...rows].sort((a, b) =>
    rank(a) - rank(b)
    || b.sales.sales - a.sales.sales
    || b.totals.calls - a.totals.calls
    || a.full_name.localeCompare(b.full_name));
}

export function filterAgents(rows: AgentFloorRow[], status: StatusFilter): AgentFloorRow[] {
  if (status === 'all') return rows;
  return rows.filter((r) => r.live?.status === status);
}

export interface TeamTotals {
  agents: number;
  onShift: number;
  online: number;        // anyone not offline (in call, online, idle, break)
  byStatus: Record<AgentLiveStatus, number>;
  calls: number;
  answered: number;
  answerRate: number;    // 0..1
  talkSeconds: number;
  avgTalkSeconds: number; // per ANSWERED call
  onlineMinutes: number;
  sales: number;
  worked: number;
  returned: number;
  /** MKD, null when the viewer has no money keys. */
  valueMkd: number | null;
}

export function teamTotals(rows: AgentFloorRow[]): TeamTotals {
  const byStatus: Record<AgentLiveStatus, number> = { in_call: 0, online: 0, idle: 0, break: 0, offline: 0 };
  const t: TeamTotals = {
    agents: rows.length, onShift: 0, online: 0, byStatus,
    calls: 0, answered: 0, answerRate: 0, talkSeconds: 0, avgTalkSeconds: 0, onlineMinutes: 0,
    sales: 0, worked: 0, returned: 0, valueMkd: null,
  };
  for (const r of rows) {
    if (r.shift_windows.length > 0) t.onShift++;
    if (r.live) {
      byStatus[r.live.status]++;
      if (r.live.status !== 'offline') t.online++;
    }
    t.calls += r.totals.calls;
    t.answered += r.totals.answered;
    t.talkSeconds += r.totals.talk_seconds;
    t.onlineMinutes += r.presence?.online_minutes ?? 0;
    t.sales += r.sales.sales;
    t.worked += r.sales.worked;
    t.returned += r.sales.returned;
    if (typeof r.sales.value_mkd === 'number') t.valueMkd = (t.valueMkd ?? 0) + r.sales.value_mkd;
  }
  t.answerRate = t.calls ? t.answered / t.calls : 0;
  t.avgTalkSeconds = t.answered ? t.talkSeconds / t.answered : 0;
  if (t.valueMkd != null) t.valueMkd = Math.round(t.valueMkd);
  return t;
}

/** Share of the online time spent active / idle / on break, as percentages that sum to 100 (or all 0). */
export function presenceSplit(p: AgentFloorRow['presence']): { active: number; idle: number; brk: number } {
  const total = p?.online_minutes ?? 0;
  if (!p || total <= 0) return { active: 0, idle: 0, brk: 0 };
  const active = (p.active_minutes / total) * 100;
  const idle = (p.idle_minutes / total) * 100;
  return { active, idle, brk: Math.max(0, 100 - active - idle) };
}

/** Whole minutes between an ISO instant and `now` (0 for none / future). */
export function minutesSince(iso: string | null | undefined, now: number = Date.now()): number {
  if (!iso) return 0;
  const at = new Date(iso).getTime();
  if (!Number.isFinite(at)) return 0;
  return Math.max(0, Math.floor((now - at) / 60000));
}

/** Late threshold: a few minutes' grace before the badge shows. */
export const LATE_GRACE_MINUTES = 5;
export const isLate = (r: Pick<AgentFloorRow, 'late_minutes'>) => (r.late_minutes ?? 0) >= LATE_GRACE_MINUTES;
