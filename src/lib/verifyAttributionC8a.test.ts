import { describe, it, expect } from 'vitest';
// C8a exception (owner decision 28.09.2026): "Duplicates: keep both orders on the 3 parcels
// held by two orders (they may be identical but both are accurate). Add a checker C8a
// exception." — the accepted pairs are data (scripts/data/c8a-accepted-duplicates.json); any
// NEW double claim must still FAIL.
import {
  ACCEPTED_DUPLICATES_FILE, parseAcceptedDuplicates, loadAcceptedDuplicates, classifyDoubleClaims, holdersKey, DOUBLE_CLAIMS_SQL,
} from '../../scripts/lib/accepted-duplicates.mjs';
import { judgeC8a, parseArgs } from '../../scripts/verify-attribution.mjs';

type Row = Record<string, unknown>;
const h = (display_id: string, status = 'paid', eur = 26.67) => ({ display_id, status, source: 'altercpa', eur });
const T1 = '002-9110-100001/2026';
const T2 = '002-9110-100002/2026';
const T3 = '002-9102-100003/2026';
const entry = (tracking_id: string, orders: string[], over: Row = {}) => ({ tracking_id, orders, reason: 'both orders are real', owner_date: '2026-09-28', ...over });
const acceptedOf = (list: Row[]) => ({ ...parseAcceptedDuplicates({ accepted: list }), missing: false, file: ACCEPTED_DUPLICATES_FILE });

describe('the committed exception file', () => {
  it('is valid JSON the checker trusts (entries are filled live by the lead)', () => {
    const acc = loadAcceptedDuplicates();
    expect(acc.missing).toBe(false);
    expect(acc.errors).toEqual([]);
    for (const e of acc.entries) {
      expect(e.orders.length).toBeGreaterThanOrEqual(2);
      expect(e.owner_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
  it('validates every entry — a sloppy exception must never accept anything', () => {
    expect(parseAcceptedDuplicates({}).errors[0]).toMatch(/no "accepted" array/);
    const bad = parseAcceptedDuplicates({ accepted: [
      entry('', ['ORD-1', 'ORD-2']), entry(T1, ['ORD-1']), entry(T2, ['ORD-1', 'X-2']),
      entry(T3, ['ORD-1', 'ORD-2'], { reason: '' }), entry(T3, ['ORD-3', 'ORD-4'], { owner_date: '28.09.2026' }),
    ] });
    expect(bad.errors.join(' | ')).toMatch(/tracking_id is empty/);
    expect(bad.errors.join(' | ')).toMatch(/at least two/);
    expect(bad.errors.join(' | ')).toMatch(/not a display id: X-2/);
    expect(bad.errors.join(' | ')).toMatch(/reason is empty/);
    expect(bad.errors.join(' | ')).toMatch(/owner_date must be YYYY-MM-DD/);
    expect(bad.errors.join(' | ')).toMatch(/listed twice/);
  });
  it('matches a set of orders regardless of order and case', () => {
    expect(holdersKey(['ord-2', 'ORD-1'])).toBe(holdersKey(['ORD-1', 'ORD-2']));
  });
  it('prints read-only SQL for the template', () => {
    expect(DOUBLE_CLAIMS_SQL).toMatch(/^select/);
    expect(DOUBLE_CLAIMS_SQL).toMatch(/having count\(\*\) > 1/);
    expect(parseArgs(['--c8a-template']).c8aTemplate).toBe(true);
  });
});

describe('classifyDoubleClaims', () => {
  it('accepts only the exact (tracking id, orders) pairs; flags stale and changed entries', () => {
    const doubles = [
      { tracking_id: T1, holders: [h('ORD-1'), h('ORD-2')] },
      { tracking_id: T2, holders: [h('ORD-3'), h('ORD-4'), h('ORD-5')] },
      { tracking_id: T3, holders: [h('ORD-6'), h('ORD-7')] },
    ];
    const { entries } = parseAcceptedDuplicates({ accepted: [entry(T1, ['ORD-2', 'ORD-1']), entry(T2, ['ORD-3', 'ORD-4']), entry('002-9110-999/2026', ['ORD-8', 'ORD-9'])] });
    const c = classifyDoubleClaims(doubles, entries);
    expect(c.accepted.map((d: Row) => d.tracking_id)).toEqual([T1]);
    expect(c.unaccepted.map((d: Row) => d.tracking_id)).toEqual([T2, T3]);
    expect(c.changed.map((e: Row) => e.tracking_id)).toEqual([T2]);
    expect(c.stale.map((e: Row) => e.tracking_id)).toEqual(['002-9110-999/2026']);
  });
});

describe('judgeC8a — the check itself', () => {
  const three = [
    { tracking_id: T1, holders: [h('ORD-1'), h('ORD-2')] },
    { tracking_id: T2, holders: [h('ORD-3', 'shipped'), h('ORD-4', 'paid')] },
    { tracking_id: T3, holders: [h('ORD-5', 'returned'), h('ORD-6', 'returned')] },
  ];
  const acceptAll = acceptedOf([entry(T1, ['ORD-1', 'ORD-2']), entry(T2, ['ORD-3', 'ORD-4']), entry(T3, ['ORD-5', 'ORD-6'])]);
  it('PASS with no double claims at all', () => {
    const r = judgeC8a({ doubles: [], accepted: acceptedOf([]) });
    expect(r.status).toBe('PASS');
    expect(r.count).toBe(0);
  });
  it('the three owner-accepted parcels read INFO and PASS', () => {
    const r = judgeC8a({ doubles: three, accepted: acceptAll });
    expect(r.status).toBe('PASS');
    expect(r.count).toBe(0);
    expect(r.note).toMatch(/INFO: 3 owner-accepted double claim\(s\)/);
    expect(r.breakdown.owner_accepted).toHaveLength(3);
    expect(r.sample).toEqual([]);
  });
  it('any NEW double claim still FAILs, with its excess paid money', () => {
    const r = judgeC8a({ doubles: [...three, { tracking_id: '002-9110-200000/2026', holders: [h('ORD-10', 'paid', 30), h('ORD-11', 'paid', 20)] }], accepted: acceptAll });
    expect(r.status).toBe('FAIL');
    expect(r.count).toBe(1);
    expect(r.sample[0].tracking_id).toBe('002-9110-200000/2026');
    expect(r.note).toMatch(/1 of them carry 2\+ PAID orders .* EUR 20\.00/);
    expect(r.breakdown.by_holder_statuses).toEqual([{ k: 'paid+paid', n: 1 }]);
  });
  it('a third order joining an accepted parcel FAILs (the pair no longer matches)', () => {
    const joined = three.map((d) => (d.tracking_id === T1 ? { ...d, holders: [...d.holders, h('ORD-12')] } : d));
    const r = judgeC8a({ doubles: joined, accepted: acceptAll });
    expect(r.status).toBe('FAIL');
    expect(r.count).toBe(1);
    expect(r.note).toMatch(/held by a DIFFERENT set of orders/);
  });
  it('a stale exception WARNs until it is removed from the file', () => {
    const r = judgeC8a({ doubles: three.slice(0, 2), accepted: acceptAll });
    expect(r.status).toBe('WARN');
    expect(r.note).toMatch(/no longer match any double claim \(002-9102-100003\/2026\)/);
    expect(r.breakdown.stale_exceptions).toHaveLength(1);
  });
  it('a date-narrowed run does not call an accepted pair outside its window stale', () => {
    const r = judgeC8a({ doubles: three.slice(0, 2), accepted: acceptAll, narrowed: true });
    expect(r.status).toBe('PASS');
    expect(r.breakdown.stale_exceptions).toHaveLength(0);
    expect(r.note).toMatch(/1 accepted pair\(s\) lie outside it/);
  });
  it('an invalid file accepts nothing and FAILs', () => {
    const r = judgeC8a({ doubles: three, accepted: acceptedOf([entry(T1, ['ORD-1', 'ORD-2'], { reason: '' })]) });
    expect(r.status).toBe('FAIL');
    expect(r.count).toBe(3);
    expect(r.note).toMatch(/INVALID/);
  });
  it('a missing file accepts nothing', () => {
    const r = judgeC8a({ doubles: three, accepted: { entries: [], errors: [], missing: true, file: ACCEPTED_DUPLICATES_FILE } });
    expect(r.status).toBe('FAIL');
    expect(r.note).toMatch(/missing/);
  });
});
