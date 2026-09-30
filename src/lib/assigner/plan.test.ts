import { describe, expect, it } from 'vitest';
import { dealRoundRobin, planDistribution } from './plan';

const counts = (p: { per: { count: number }[] }) => p.per.map((x) => x.count);

describe('planDistribution — the server split rule', () => {
  it('total mode shares one count, the first agents take the remainder (100 / 3 → 34 · 33 · 33)', () => {
    const p = planDistribution(100, ['a', 'b', 'c'], 'total', 1000);
    expect(counts(p)).toEqual([34, 33, 33]);
    expect(p.total).toBe(100);
    expect(p.short).toBe(false);
    expect(p.per.map((x) => x.agent)).toEqual(['a', 'b', 'c']);
  });

  it('remainders land on the first agents in order', () => {
    expect(counts(planDistribution(20, ['a', 'b', 'c'], 'total', 500))).toEqual([7, 7, 6]);
    expect(counts(planDistribution(50, ['a', 'b', 'c', 'd'], 'total', 500))).toEqual([13, 13, 12, 12]);
    expect(counts(planDistribution(2, ['a', 'b', 'c'], 'total', 500))).toEqual([1, 1, 0]);
  });

  it('per_agent gives the count to each agent', () => {
    const p = planDistribution(20, ['a', 'b', 'c'], 'per_agent', 500);
    expect(counts(p)).toEqual([20, 20, 20]);
    expect(p.requested).toBe(60);
    expect(p.total).toBe(60);
  });

  it('a count bigger than the pool is capped and flagged short', () => {
    const p = planDistribution(100, ['a', 'b', 'c'], 'total', 40);
    expect(p.short).toBe(true);
    expect(p.requested).toBe(100);
    expect(p.total).toBe(40);
    expect(counts(p)).toEqual([14, 13, 13]);
  });

  it('per_agent over a short pool is dealt round-robin, never above the count', () => {
    const p = planDistribution(20, ['a', 'b', 'c'], 'per_agent', 50);
    expect(p.short).toBe(true);
    expect(counts(p)).toEqual([17, 17, 16]);
    expect(Math.max(...counts(p))).toBeLessThanOrEqual(20);
  });

  it('one agent takes everything asked for', () => {
    expect(counts(planDistribution(100, ['a'], 'total', 1000))).toEqual([100]);
    expect(counts(planDistribution(100, ['a'], 'per_agent', 1000))).toEqual([100]);
  });

  it('null count = the whole pool, in either split', () => {
    expect(counts(planDistribution(null, ['a', 'b'], 'total', 7))).toEqual([4, 3]);
    expect(counts(planDistribution(null, ['a', 'b'], 'per_agent', 7))).toEqual([4, 3]);
    expect(planDistribution(null, ['a', 'b'], 'total', 7).short).toBe(false);
  });

  it('no agents or an empty pool moves nothing', () => {
    expect(planDistribution(100, [], 'total', 500)).toMatchObject({ total: 0, per: [] });
    const empty = planDistribution(100, ['a', 'b'], 'total', 0);
    expect(empty.total).toBe(0);
    expect(empty.short).toBe(true);
    expect(counts(empty)).toEqual([0, 0]);
  });
});

describe('dealRoundRobin', () => {
  it('deals selected rows in order, matching the plan', () => {
    const dealt = dealRoundRobin([1, 2, 3, 4, 5], ['a', 'b']);
    expect(dealt.get('a')).toEqual([1, 3, 5]);
    expect(dealt.get('b')).toEqual([2, 4]);
    expect([...dealt.values()].map((v) => v.length)).toEqual(counts(planDistribution(5, ['a', 'b'], 'total', 5)));
  });
});
