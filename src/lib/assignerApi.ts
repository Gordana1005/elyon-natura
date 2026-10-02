/**
 * The Assigner's own api (plan Part A5): the live agent board, the lists by
 * buyer department and the one server-side distribution (with its dry run for
 * the preview). Same base URL and auth as every other call — apiFetch from
 * ./api (the functions/v1/api base, the session bearer, the apikey header).
 *
 * The payloads are normalised on the way in: a missing number reads 0 and a
 * missing list reads [], so a half-deployed api degrades to zeros instead of
 * NaN on the screen.
 */
import { apiFetch } from './api';

/** The departments in the owner's order (28.09.2026; Менаџмент last, 02.10.2026 — a buyer whose
 *  last purchase was a Менаџмент person's sale, 20260947001000) — the Insights SOURCE_ORDER. */
export const ASSIGNER_DEPARTMENTS = ['altercpa', 'elyon_crm', 'teleshop_out', 'teleshop_other', 'social', 'web', 'management'] as const;
export type AssignerDepartment = (typeof ASSIGNER_DEPARTMENTS)[number];
/** `by_department` also carries the customers with no known department. */
export const UNKNOWN_DEPARTMENT = 'unknown';

export const isAssignerDepartment = (v: string): v is AssignerDepartment =>
  (ASSIGNER_DEPARTMENTS as readonly string[]).includes(v);

// ── GET /assigner/board ─────────────────────────────────────────────────────

export interface AssignerShift { start: string; end: string }

export interface AssignerBoardAgent {
  user_id: string;
  full_name: string;
  roles: string[];
  is_admin: boolean;
  is_manager: boolean;
  team_key: string | null;
  team_name: string | null;
  /** The lane inside the business line (in | out | social) — the badge only (20260943000950). */
  team_lane?: string | null;
  /** last_seen_at within 2 minutes — the /agents/online rule. */
  online: boolean;
  /** Softphone dialing / in call, under 3 minutes old. */
  in_call: boolean;
  last_seen_at: string | null;
  /** Today's shift by the Skopje date (00:00–00:00 dropped by the api). */
  shift: AssignerShift | null;
  /** Lead pendings held: pending + take + call_again on lead sources (assigned_pending_counts()). */
  pendings: number;
  pendings_pending: number;
  pendings_take: number;
  /** Call-agains held: lead orders in call_again + list members with call_again_since, not done. */
  call_agains: number;
  call_agains_orders: number;
  call_agains_members: number;
  /** List clients assigned and not done / of those parked in a call-again cooldown / all assigned. */
  list_open: number;
  list_parked: number;
  list_assigned: number;
  /** Decisions today (Skopje day), v_sales_work. */
  worked_today: number;
}

export interface AssignerBoardTotals {
  agents: number;
  online: number;
  in_call: number;
  pendings_unassigned: number;
  call_agains_unassigned: number;
  call_agains_unassigned_orders: number;
  call_agains_unassigned_members: number;
  oldest_call_again_since: string | null;
  worked_today: number;
}

export interface AssignerBoard {
  generated_at: string;
  agents: AssignerBoardAgent[];
  totals: AssignerBoardTotals;
}

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

function normAgent(a: Partial<AssignerBoardAgent> & Record<string, unknown>): AssignerBoardAgent {
  const shift = a.shift && typeof a.shift === 'object' && str(a.shift.start) && str(a.shift.end)
    ? { start: String(a.shift.start).slice(0, 5), end: String(a.shift.end).slice(0, 5) }
    : null;
  return {
    user_id: String(a.user_id ?? ''),
    full_name: String(a.full_name ?? ''),
    roles: Array.isArray(a.roles) ? a.roles.map(String) : [],
    is_admin: !!a.is_admin,
    is_manager: !!a.is_manager,
    team_key: str(a.team_key),
    team_name: str(a.team_name),
    team_lane: str(a.team_lane),
    online: !!a.online,
    in_call: !!a.in_call,
    last_seen_at: str(a.last_seen_at),
    shift,
    pendings: num(a.pendings),
    pendings_pending: num(a.pendings_pending),
    pendings_take: num(a.pendings_take),
    call_agains: num(a.call_agains),
    call_agains_orders: num(a.call_agains_orders),
    call_agains_members: num(a.call_agains_members),
    list_open: num(a.list_open),
    list_parked: num(a.list_parked),
    list_assigned: num(a.list_assigned),
    worked_today: num(a.worked_today),
  };
}

export function normalizeBoard(raw: unknown): AssignerBoard {
  const r = (raw ?? {}) as Record<string, unknown>;
  const agents = Array.isArray(r.agents) ? r.agents.map((a) => normAgent(a as Record<string, unknown>)) : [];
  const t = (r.totals ?? {}) as Record<string, unknown>;
  return {
    generated_at: str(r.generated_at) ?? new Date().toISOString(),
    agents,
    totals: {
      agents: t.agents != null ? num(t.agents) : agents.length,
      online: t.online != null ? num(t.online) : agents.filter((a) => a.online).length,
      in_call: t.in_call != null ? num(t.in_call) : agents.filter((a) => a.in_call).length,
      pendings_unassigned: num(t.pendings_unassigned),
      call_agains_unassigned: num(t.call_agains_unassigned),
      call_agains_unassigned_orders: num(t.call_agains_unassigned_orders),
      call_agains_unassigned_members: num(t.call_agains_unassigned_members),
      oldest_call_again_since: str(t.oldest_call_again_since),
      worked_today: t.worked_today != null ? num(t.worked_today) : agents.reduce((s, a) => s + a.worked_today, 0),
    },
  };
}

export const apiGetAssignerBoard = async (signal?: AbortSignal): Promise<AssignerBoard> =>
  normalizeBoard(await apiFetch('assigner/board', { signal }));

// ── GET /assigner/lists?departments= ────────────────────────────────────────

export interface AssignerListCounts {
  total: number;
  /** Not done AND unassigned — what a distribution without "include assigned" can pull. */
  distributable: number;
  assigned: number;
  done: number;
}

export interface AssignerList extends AssignerListCounts {
  id: string;
  /** The ENGINE KEY — never renamed, never translated back. Display via listLabel(). */
  name: string;
  description: string | null;
  category: string | null;
  is_static: boolean;
  display_order: number;
  assignable: boolean;
  /** Not done (assigned or not). */
  open: number;
  /** Every department + 'unknown', whatever the selection. */
  by_department: Record<string, AssignerListCounts>;
}

export interface AssignerLists {
  generated_at: string;
  departments: string[] | null;
  lists: AssignerList[];
  totals: AssignerListCounts;
}

const normCounts = (c: unknown): AssignerListCounts => {
  const o = (c ?? {}) as Record<string, unknown>;
  return { total: num(o.total), distributable: num(o.distributable), assigned: num(o.assigned), done: num(o.done) };
};

export function normalizeLists(raw: unknown): AssignerLists {
  const r = (raw ?? {}) as Record<string, unknown>;
  const lists: AssignerList[] = (Array.isArray(r.lists) ? r.lists : []).map((x) => {
    const l = x as Record<string, unknown>;
    const counts = normCounts(l);
    const byDept: Record<string, AssignerListCounts> = {};
    if (l.by_department && typeof l.by_department === 'object') {
      for (const [k, v] of Object.entries(l.by_department as Record<string, unknown>)) byDept[k] = normCounts(v);
    }
    return {
      ...counts,
      id: String(l.id ?? ''),
      name: String(l.name ?? ''),
      description: str(l.description),
      category: str(l.category),
      is_static: !!l.is_static,
      display_order: num(l.display_order),
      assignable: l.assignable !== false,
      open: l.open != null ? num(l.open) : Math.max(0, counts.total - counts.done),
      by_department: byDept,
    };
  });
  const totals = r.totals
    ? normCounts(r.totals)
    : lists.reduce<AssignerListCounts>((s, l) => ({
      total: s.total + l.total, distributable: s.distributable + l.distributable,
      assigned: s.assigned + l.assigned, done: s.done + l.done,
    }), { total: 0, distributable: 0, assigned: 0, done: 0 });
  return {
    generated_at: str(r.generated_at) ?? new Date().toISOString(),
    departments: Array.isArray(r.departments) ? r.departments.map(String) : null,
    lists,
    totals,
  };
}

/** `departments` empty/undefined = every department. */
export const apiGetAssignerLists = async (departments?: string[], signal?: AbortSignal): Promise<AssignerLists> => {
  const qs = departments && departments.length ? `?departments=${encodeURIComponent(departments.join(','))}` : '';
  return normalizeLists(await apiFetch(`assigner/lists${qs}`, { signal }));
};

// ── POST /assigner/distribute ───────────────────────────────────────────────

export type DistributeKind = 'list' | 'pendings' | 'call_agains';
export type DistributeOrder = 'newest' | 'oldest' | 'random';
export type DistributeSplit = 'total' | 'per_agent';
export type CallAgainSource = 'all' | 'order' | 'prediction';

export interface DistributeBody {
  kind: DistributeKind;
  list_id?: string;
  departments?: string[];
  /** 'random' is for lists only. */
  order: DistributeOrder;
  /** null = all. */
  count: number | null;
  split: DistributeSplit;
  agent_ids: string[];
  include_assigned: boolean;
  dry_run: boolean;
  source?: CallAgainSource;
}

export interface DistributeAgentCount { agent_id: string; full_name: string; count: number }

export interface DistributeResult {
  kind: DistributeKind;
  dry_run: boolean;
  /** Rows the selection could draw from. */
  pool: number;
  /** Rows picked (≤ pool). */
  selected: number;
  /** Rows actually moved (0 on a dry run). */
  assigned: number;
  per_agent: DistributeAgentCount[];
}

export function normalizeDistribute(raw: unknown, body: DistributeBody): DistributeResult {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    kind: (str(r.kind) as DistributeKind) ?? body.kind,
    dry_run: r.dry_run != null ? !!r.dry_run : body.dry_run,
    pool: num(r.pool),
    selected: num(r.selected),
    assigned: num(r.assigned),
    per_agent: (Array.isArray(r.per_agent) ? r.per_agent : []).map((p) => {
      const o = p as Record<string, unknown>;
      return { agent_id: String(o.agent_id ?? ''), full_name: String(o.full_name ?? ''), count: num(o.count) };
    }),
  };
}

export const apiAssignerDistribute = async (body: DistributeBody, signal?: AbortSignal): Promise<DistributeResult> => {
  const clean: DistributeBody = {
    ...body,
    ...(body.departments && body.departments.length ? { departments: body.departments } : { departments: undefined }),
  };
  const raw = await apiFetch('assigner/distribute', { method: 'POST', body: JSON.stringify(clean), signal });
  return normalizeDistribute(raw, body);
};
