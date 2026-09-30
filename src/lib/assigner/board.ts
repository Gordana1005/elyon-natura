/**
 * The live agent board's pure rules — order, load, presence, search. No React:
 * the AgentBoard test and the DistributeBar both lean on these.
 */
import { normalizeForSearch } from '@/lib/transliterate';
import type { AssignerBoardAgent } from '@/lib/assignerApi';

export type BoardPresence = 'in_call' | 'online' | 'offline';

/**
 * One load definition everywhere on the page: lead pendings + open list clients.
 * The api's `call_agains` is NOT added: `pendings` already counts the agent's
 * call-again LEADS and `list_open` their call-again list MEMBERS — it is a
 * breakdown shown on its own, never a third addend.
 */
export const agentLoad = (a: Pick<AssignerBoardAgent, 'pendings' | 'list_open'>) =>
  (a.pendings || 0) + (a.list_open || 0);

/** Anything an agent holds that the Unassign tab can take back. */
export const agentHolds = (a: Pick<AssignerBoardAgent, 'pendings' | 'call_agains' | 'list_assigned' | 'list_open'>) =>
  (a.pendings || 0) + (a.call_agains || 0) + Math.max(a.list_assigned || 0, a.list_open || 0) > 0;

export const presenceOf = (a: Pick<AssignerBoardAgent, 'online' | 'in_call'>): BoardPresence =>
  a.in_call ? 'in_call' : a.online ? 'online' : 'offline';

const PRESENCE_RANK: Record<BoardPresence, number> = { in_call: 0, online: 1, offline: 2 };

/** Online first (in a call before free), then the lightest load, then the name. */
export function sortBoardAgents<T extends AssignerBoardAgent>(agents: readonly T[]): T[] {
  return [...agents].sort((a, b) =>
    PRESENCE_RANK[presenceOf(a)] - PRESENCE_RANK[presenceOf(b)]
    || agentLoad(a) - agentLoad(b)
    || (a.full_name || '').localeCompare(b.full_name || '', 'mk'),
  );
}

/**
 * Cyrillic ⇄ Latin search key: normalizeForSearch (ж→zh, ч→ch, ј→j …) and a
 * looser fold of the digraphs (zh→z, ch→c, sh→s, ts→c, gj→g, kj→k, lj→l,
 * nj→n, dzh→dz), so "Zaklina" finds "Жаклина" and "Ivana" finds "Ивана".
 */
export function searchKeys(s: string): [string, string] {
  const strict = normalizeForSearch(s || '').trim();
  const loose = strict
    .replace(/dzh/g, 'dz')
    .replace(/([zcs])h/g, '$1')
    .replace(/ts/g, 'c')
    .replace(/([gkln])j/g, '$1')
    .replace(/y/g, 'j');
  return [strict, loose];
}

export function matchesAgentSearch(name: string, query: string): boolean {
  const q = query.trim();
  if (!q) return true;
  const [qs, ql] = searchKeys(q);
  const [ns, nl] = searchKeys(name);
  return ns.includes(qs) || nl.includes(ql);
}

const CALL_ROLES = ['agent', 'pending_agent', 'prediction_agent', 'inbound_agent'];

/** Managers/admins who do not also make calls — left out of "select all online". */
export const isManagementOnly = (a: Pick<AssignerBoardAgent, 'is_admin' | 'is_manager' | 'roles'>) =>
  a.is_admin || (a.is_manager && !a.roles.some((r) => CALL_ROLES.includes(r)));

export type BoardRoleFilter = 'all' | 'agents' | 'management';

export function filterBoard<T extends AssignerBoardAgent>(
  agents: readonly T[],
  opts: { query?: string; onlineOnly?: boolean; role?: BoardRoleFilter },
): T[] {
  return agents.filter((a) =>
    (!opts.onlineOnly || a.online || a.in_call)
    && (opts.role === 'agents' ? !isManagementOnly(a) : opts.role === 'management' ? (a.is_admin || a.is_manager) : true)
    && matchesAgentSearch(a.full_name, opts.query ?? ''),
  );
}

/** Whole days since an ISO time (never negative); null without a time. */
export function daysSince(iso: string | null | undefined, now = Date.now()): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now - t) / 86_400_000));
}
