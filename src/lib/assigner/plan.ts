/**
 * The Assigner's local preview of a distribution — the SAME split rule the
 * server applies (assigner_distribute), so the preview can be shown the moment
 * the operator touches a control, before the dry run answers:
 *
 * - how many rows move: `count` (null = all) for 'total', `count` × agents for
 *   'per_agent', never more than the pool;
 * - how they are dealt: round-robin in the agents' order, so the first agents
 *   take the remainder (100 over 3 = 34 · 33 · 33).
 *
 * Pure: no React, no network. plan.test.ts pins it.
 */
import type { DistributeSplit } from '@/lib/assignerApi';

export interface PlanAgentShare<A = string> { agent: A; count: number }

export interface DistributionPlan<A = string> {
  /** What the operator asked for (Infinity-free: `null` count = the pool). */
  requested: number;
  /** What will actually move: min(requested, pool). */
  total: number;
  /** requested > pool — "not enough: N available". */
  short: boolean;
  per: PlanAgentShare<A>[];
}

const whole = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0);

export function planDistribution<A = string>(
  count: number | null,
  agents: readonly A[],
  split: DistributeSplit,
  pool: number,
): DistributionPlan<A> {
  const k = agents.length;
  const available = whole(pool);
  if (k === 0) {
    const requested = count == null ? available : whole(count);
    return { requested, total: 0, short: requested > available, per: [] };
  }
  const requested = count == null ? available : split === 'per_agent' ? whole(count) * k : whole(count);
  const total = Math.min(requested, available);
  const base = Math.floor(total / k);
  const rest = total % k;
  return {
    requested,
    total,
    short: requested > available,
    per: agents.map((agent, i) => ({ agent, count: base + (i < rest ? 1 : 0) })),
  };
}

/** Deal concrete ids round-robin onto agents (manual selections), the same rule as above. */
export function dealRoundRobin<T, A = string>(items: readonly T[], agents: readonly A[]): Map<A, T[]> {
  const out = new Map<A, T[]>();
  agents.forEach((a) => out.set(a, []));
  if (!agents.length) return out;
  items.forEach((it, i) => out.get(agents[i % agents.length])!.push(it));
  return out;
}
