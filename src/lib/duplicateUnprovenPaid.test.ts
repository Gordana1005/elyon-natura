import { describe, it, expect } from 'vitest';
// Owner, Mile, 01.10.2026: of the "paid without MEX proof" orders (verify-attribution C7), cancel ONLY the duplicate
// leads — a sibling of the same customer created ≤ 3 days apart holds the parcel — as duplicates pointing to it.
// Pinned here: the sibling rule, the CRM's duplicate marking (cancelled + duplicate_order, never status 'duplicated'),
// the date, the cohort move, the Current Cancels check, and the read-only SQL the script runs.
import {
  KEY, EXPECTED, SIBLING_HOURS, isAffiliateParcel, pickSibling, cancelAt, cohortMove, classifyDuplicates, currentCancelsEffect, byMonth,
} from '../../scripts/lib/duplicate-unproven-paid.mjs';
import { candidatesSql, nearMissSql } from '../../scripts/repair-duplicate-unproven-paid.mjs';
import { assertReadOnly } from '../../scripts/verify-insights-ties.mjs';
import { lineOrderId } from '../../scripts/lib/repair-kit.mjs';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (iso: string, h = 0) => new Date(Date.parse(iso) + h * 3_600_000).toISOString();
const T = '2026-09-10T10:00:00Z';
const sib = (n: number, h: number, over: Record<string, unknown> = {}) => ({
  id: uuid(100 + n), display_id: `ORD-${100 + n}`, status: 'paid', sale_source: 'altercpa', created_at: at(T, h),
  tracking: `002-9110-${n}/2026`, series: '9110', account: 'bio_natural', status_id: 2, ...over,
});
const row = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid(n), display_id: `ORD-${n}`, status: 'paid', created_at: T, confirmed_at: at(T, 1), sold_at: at(T, 1), decided_at: at(T, 2),
  price: 24.23, paid_basis: null, source_type: 'altercpa', sale_source: 'altercpa', sale_source_detail: 'bridge',
  customer_phone: '+38970123499', mex_tracking_id: null, held: 0, in_payout: false, affiliate: false,
  paid_by: 'System (altercpa:cpa.moe main)', siblings: [sib(n, 20)], ...over,
});

describe('the sibling', () => {
  it('only a BIO NATURAL lead parcel makes a sibling (another department\'s parcel is its own sale)', () => {
    expect(isAffiliateParcel('9110', 'bio_natural')).toBe(true);
    expect(isAffiliateParcel('9103', 'bio_natural')).toBe(true);
    expect(isAffiliateParcel(null, 'bio_natural')).toBe(true);
    expect(isAffiliateParcel('9102', 'natura')).toBe(false);
    expect(isAffiliateParcel(null, 'natura')).toBe(false);
  });
  it('prefers the same sale source, then the nearest in time', () => {
    const o = row(1);
    const near = sib(2, 2, { sale_source: 'elyon_crm' }), same = sib(3, 30), far = sib(4, -60);
    expect(pickSibling(o, [near, same, far])?.display_id).toBe('ORD-103');
    expect(pickSibling(o, [near, sib(5, -1, { sale_source: 'elyon_crm' })])?.display_id).toBe('ORD-105');
    expect(pickSibling(o, [sib(6, 1, { series: '9100', account: 'natura' })])).toBeNull();
    expect(SIBLING_HOURS).toBe(72);
  });
});

describe('the cancel = how the CRM marks a duplicate lead', () => {
  const runId = '12345678-aaaa-4bbb-8ccc-1234567890ab';
  const plan = classifyDuplicates({ runId, rows: [
    row(1),
    row(2, { siblings: [] }),                                                    // no sibling → left as it is
    row(3, { in_payout: true }),
    row(4, { affiliate: true }),
    row(5, { siblings: [sib(5, 3, { series: '9108', account: 'natura' })] }),    // a social parcel → listed
    row(6, { mex_tracking_id: '002-9110-66/2026' }),
    row(7, { decided_at: null, sale_source_detail: 'history', source_type: 'import', sold_at: null, siblings: [sib(7, -30), sib(8, 10, { sale_source: 'elyon_crm', series: '9103' })] }),
  ] });

  it('cancels only clean duplicates; lists the unsafe ones; leaves the sibling-less', () => {
    expect(plan.counts).toEqual({ c7: 7, duplicate: 2, manual: 4, no_sibling: 1 });
    expect(Object.fromEntries(plan.csv.filter((r) => r.action === 'manual').map((r) => [r.order, r.why]))).toMatchObject({
      'ORD-3': 'in agent_payout_items', 'ORD-4': expect.stringMatching(/affiliate lead/),
      'ORD-5': expect.stringMatching(/not a BIO NATURAL lead parcel/), 'ORD-6': 'the order holds a parcel itself',
    });
    expect(KEY).toBe('duplicate-unproven-paid');
    expect(EXPECTED).toEqual({ c7: 69, duplicate: 20 });
  });

  it('cancelled + duplicate_order + "duplicate of ORD-… which holds the parcel …", never status duplicated', () => {
    const r = plan.units[0].rows[0];
    expect(r).toMatchObject({ order_id: uuid(1), rule: 'DU_duplicate', expect_status: 'paid', expect_tracking: null,
      link: null, unlink: null, history: { from: 'paid', to: 'cancelled' } });
    expect(r.set).toEqual({ status: 'cancelled', cancelled_at: at(T, 2), cancellation_reason: 'duplicate_order',
      cancellation_reason_notes: 'duplicate of ORD-101 which holds the parcel 002-9110-1/2026 (owner 01.10.2026)', paid_at: null, paid_basis: null });
    for (const u of plan.units) {
      expect(u.rows[0].set.status).not.toBe('duplicated');
      expect(Object.keys(u.rows[0].set)).not.toEqual(expect.arrayContaining(['sold_at', 'sold_by_person_id', 'confirmed_at', 'duplicated_from']));
    }
    expect(r.note).toContain('Duplicate of ORD-101 which holds the parcel 002-9110-1/2026 (owner 01.10.2026).');
    expect(r.note).toContain('nothing was sent to AlterCPA');
    expect(r.note).toContain(`undo: scripts/rollback-repair.mjs --run ${runId}`);
    expect(plan.lines[0]).toBe(`${uuid(1)}:DU_duplicate:paid>cancelled:ORD-101:002-9110-1/2026`);
    expect(lineOrderId(plan.lines[0])).toBe(uuid(1));
    expect([...plan.changes.values()]).toEqual([{ status: 'cancelled' }, { status: 'cancelled' }]);
  });

  it('dated on the lead\'s own day; names the other siblings; a history import is paid_legacy in the cohort today', () => {
    const r7 = plan.units[1].rows[0];
    expect(r7.set.cancelled_at).toBe(at(T, 1));                       // no AlterCPA decision → confirmed_at
    expect(r7.set.cancellation_reason_notes).toContain('ORD-107');     // same source first
    expect(r7.note).toContain('also on the phone within 3 days: ORD-108 → 002-9110-8/2026');
    expect(cancelAt({ created_at: T })).toBe(new Date(T).toISOString());
    expect(cohortMove(row(1))).toEqual({ before: 'paid_unproven', after: 'cancelled_after_sale' });
    expect(cohortMove(row(7, { sale_source_detail: 'history', source_type: 'import', sold_at: null })))
      .toEqual({ before: 'paid_legacy', after: '(not in the cohort)' });
    expect(byMonth(plan.csv)).toEqual([{ month: '09.2026', orders: 2, 'value (ден)': '2.980' }]);
  });
});

describe('Current Cancels (the engine\'s 14-day pen)', () => {
  const now = Date.parse('2026-10-02T08:00:00Z');
  const o = (id: number, status: string, created: string, phone = '+38970000001') =>
    ({ id: uuid(id), display_id: `ORD-${id}`, customer_phone: phone, status, created_at: created, source_type: 'altercpa' });
  it('a customer enters only when the cancelled lead is the newest, newer than the last paid, < 14 days old', () => {
    const rows = [o(1, 'paid', '2026-09-25T10:00:00Z'), o(2, 'paid', '2026-09-24T10:00:00Z'),
      o(3, 'paid', '2026-09-01T10:00:00Z', '+38970000002'), o(4, 'returned', '2026-08-30T10:00:00Z', '+38970000002')];
    expect(currentCancelsEffect(rows, new Map([[uuid(1), { status: 'cancelled' }]]), now)).toEqual([{ phone8: '70000001', orders: ['ORD-1'] }]);
    expect(currentCancelsEffect(rows, new Map([[uuid(3), { status: 'cancelled' }]]), now)).toEqual([]);   // 31 days old
    expect(currentCancelsEffect(rows, new Map([[uuid(2), { status: 'cancelled' }]]), now)).toEqual([]);   // ORD-1 paid is newer
  });
});

describe('the SQL the script runs is read-only', () => {
  it('the candidates and the near misses pass the repo read-only guard and use C7\'s own population', () => {
    expect(() => assertReadOnly(candidatesSql())).not.toThrow();
    expect(() => assertReadOnly(nearMissSql())).not.toThrow();
    expect(candidatesSql()).toContain("o.status = 'paid'");
    expect(candidatesSql()).toContain("interval '72 hours'");
    expect(candidatesSql()).toContain("right(regexp_replace(s.customer_phone, '[^0-9]', '', 'g'), 8) = x.p8");
  });
});
