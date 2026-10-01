import { describe, it, expect } from 'vitest';
// Owner, Mile, 01.10.2026: link the 32 parcels the owner approved from the reviewer's manual list
// (exports/MEX_рачна_проверка_предлог_2026-10-01.xlsx, every "ПОВРЗИ со ORD-…" row) with the SAME apply semantics as
// public.link_lead_parcels() — pinned here: the row parsing, the live re-validation, the MEX status law, the
// repair-kit unit shape that scripts/rollback-repair.mjs undoes.
import {
  KEY, EXPECTED, NOTE_TAG, CANDIDATE_STATUSES, parseApprovedRows, sharedPairs, linkTarget, validatePair, classifyApproved, moveRows,
} from '../../scripts/lib/link-manual-approved.mjs';
import { lineOrderId, mexStatusSet } from '../../scripts/lib/repair-kit.mjs';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const H = 3_600_000;
const parcelAt = '2026-09-10T06:00:00Z';
const parcel = (tracking: string, over: Record<string, unknown> = {}) => ({
  tracking_id: tracking, account: 'bio_natural', series: '9110', status_id: 2, status_name: 'Delivered', cod_mkd: 3000,
  phone8: '70123499', created_at_mex: parcelAt, delivered_at: '2026-09-12T10:00:00Z', returned_at: null, last_update_at: '2026-09-12T10:00:00Z',
  order_id: null, named_by: 0, ...over,
});
const order = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid(n), display_id: `ORD-${n}`, status: 'cancelled', customer_phone: '+38970123499',
  created_at: new Date(Date.parse(parcelAt) - 20 * H).toISOString(), price: 24.23, product_name: 'Adenofrin',
  sale_source: 'altercpa', sale_source_detail: 'bridge', paid_basis: null, mex_tracking_id: null, held: 0, ...over,
});
const ctx = { payout: new Set<string>(), affiliate: new Set<string>(), excludedPhones: new Set<string>() };

describe('the reviewer\'s sheet → the owner-approved pairs', () => {
  it('takes only "ПОВРЗИ со ORD-n" rows; НЕ ПОВРЗУВАЈ / ЗА ГАЗДАТА are counted, never linked', () => {
    const r = parseApprovedRows([
      { '#': 1, 'MEX пратка': '002-9110-170060/2026', 'предлог': 'ПОВРЗИ со ORD-77627', 'сигурност': 'висока' },
      { '#': 4, 'MEX пратка': '002-9110-170274/2026', 'предлог': 'НЕ ПОВРЗУВАЈ', 'сигурност': 'висока' },
      { '#': 18, 'MEX пратка': '002-9110-172523/2026', 'предлог': 'ЗА ГАЗДАТА', 'сигурност': '' },
      { '#': 40, 'MEX пратка': '002-9110-177040/2026', 'предлог': ' ПОВРЗИ со ORD-357260 ', 'сигурност': 'средна' },
      { '#': 99, 'MEX пратка': 'ORD-1', 'предлог': 'ПОВРЗИ со ORD-1', 'сигурност': 'висока' },
    ]);
    expect(r.approved).toEqual([
      { n: '1', tracking: '002-9110-170060/2026', display_id: 'ORD-77627', confidence: 'висока' },
      { n: '40', tracking: '002-9110-177040/2026', display_id: 'ORD-357260', confidence: 'средна' },
    ]);
    expect(r.other).toEqual({ 'НЕ ПОВРЗУВАЈ': 1, 'ЗА ГАЗДАТА': 1 });
    expect(r.bad).toHaveLength(1);
    // the derived CSV (tracking, order, confidence) reads the same
    expect(parseApprovedRows([{ n: 3, tracking: '002-9110-170114/2026', order: 'ORD-77879', confidence: 'средна' }]).approved[0])
      .toMatchObject({ tracking: '002-9110-170114/2026', display_id: 'ORD-77879' });
    expect(KEY).toBe('link-manual-approved');
    expect(EXPECTED).toEqual({ approved: 32, link: 32 });
  });

  it('two approved rows sharing an order or a parcel are both held back', () => {
    const shared = sharedPairs([
      { n: '1', tracking: 'A', display_id: 'ORD-1', confidence: '' },
      { n: '2', tracking: 'B', display_id: 'ORD-1', confidence: '' },
      { n: '3', tracking: 'C', display_id: 'ORD-3', confidence: '' },
    ]);
    expect([...shared.keys()]).toEqual(['A', 'B']);
  });
});

describe('the MEX status law = link_lead_parcels_plan lk.target', () => {
  it('2 → paid / basis · 7 → returned · 8 → nothing · else → shipped', () => {
    expect(linkTarget('cancelled', null, 2)).toBe('paid');
    expect(linkTarget('paid', null, 2)).toBe('basis');
    expect(linkTarget('paid', 'mex', 2)).toBeNull();
    expect(linkTarget('paid', null, 7)).toBe('returned');
    expect(linkTarget('returned', null, 7)).toBeNull();
    expect(linkTarget('confirmed', null, 8)).toBeNull();
    expect(linkTarget('cancelled', null, 8)).toBeNull();
    expect(linkTarget('confirmed', null, 13)).toBe('shipped');
    expect(linkTarget('paid', null, 9)).toBe('shipped');
    expect(linkTarget('shipped', null, 1)).toBeNull();
    expect(CANDIDATE_STATUSES).toEqual(['pending', 'call_again', 'confirmed', 'paid', 'shipped', 'returned', 'cancelled', 'trashed']);
  });
});

describe('the live re-validation', () => {
  const a = { n: '1', tracking: '002-9110-1/2026', display_id: 'ORD-1', confidence: 'висока' };
  it('passes a still-orphan parcel and a parcel-less order on the same phone', () => {
    expect(validatePair(a, parcel(a.tracking), order(1), ctx)).toBeNull();
  });
  it('refuses everything that moved or was never safe', () => {
    const p = parcel(a.tracking), o = order(1);
    expect(validatePair(a, null, o, ctx)).toMatch(/not in the MEX register/);
    expect(validatePair(a, { ...p, order_id: uuid(9), order_display: 'ORD-9' }, o, ctx)).toMatch(/already linked \(to ORD-9\)/);
    expect(validatePair(a, { ...p, named_by: 1, named_display: 'ORD-9' }, o, ctx)).toMatch(/already names/);
    expect(validatePair(a, { ...p, series: '9102' }, o, ctx)).toMatch(/series 9102/);
    expect(validatePair(a, p, null, ctx)).toMatch(/does not exist/);
    expect(validatePair(a, p, { ...o, mex_tracking_id: '002-9110-2/2026' }, ctx)).toMatch(/already holds parcel/);
    expect(validatePair(a, p, { ...o, held: 1 }, ctx)).toMatch(/holds a parcel in the register/);
    expect(validatePair(a, p, { ...o, status: 'take' }, ctx)).toMatch(/is take/);
    expect(validatePair(a, p, { ...o, status: 'duplicated' }, ctx)).toMatch(/is duplicated/);
    expect(validatePair(a, p, { ...o, customer_phone: '070999888' }, ctx)).toMatch(/another phone/);
    expect(validatePair(a, p, { ...o, created_at: new Date(Date.parse(parcelAt) - 11 * 24 * H).toISOString() }, ctx)).toMatch(/outside parcel/);
    expect(validatePair(a, p, { ...o, price: 0 }, ctx)).toMatch(/not a priced real sale/);
    expect(validatePair(a, p, o, { ...ctx, payout: new Set([o.id]) })).toMatch(/agent_payout_items/);
    expect(validatePair(a, p, o, { ...ctx, affiliate: new Set([o.id]) })).toMatch(/affiliate lead/);
    expect(validatePair(a, p, o, { ...ctx, excludedPhones: new Set(['70123499']) })).toMatch(/test phone/);
    expect(validatePair(a, { ...p, status_id: 8 }, { ...o, status: 'confirmed' }, ctx)).toMatch(/MEX 8/);
  });
});

describe('the units the repair-kit applies (rollback-repair.mjs undoes them)', () => {
  const approved = [
    { n: '1', tracking: '002-9110-1/2026', display_id: 'ORD-1', confidence: 'висока' },
    { n: '2', tracking: '002-9110-2/2026', display_id: 'ORD-2', confidence: 'средна' },
    { n: '3', tracking: '002-9110-3/2026', display_id: 'ORD-3', confidence: 'висока' },
    { n: '4', tracking: '002-9110-4/2026', display_id: 'ORD-4', confidence: 'средна' },
  ];
  const parcels = new Map([
    ['002-9110-1/2026', parcel('002-9110-1/2026')],
    ['002-9110-2/2026', parcel('002-9110-2/2026', { status_id: 7, status_name: 'Return to sender', returned_at: '2026-09-15T08:00:00Z' })],
    ['002-9110-3/2026', parcel('002-9110-3/2026', { status_id: 2 })],
    ['002-9110-4/2026', parcel('002-9110-4/2026', { order_id: uuid(99) })],
  ]);
  const orders = new Map([
    ['ORD-1', order(1)], ['ORD-2', order(2, { status: 'confirmed' })], ['ORD-3', order(3, { status: 'paid' })], ['ORD-4', order(4)],
  ]);
  const runId = '12345678-aaaa-4bbb-8ccc-1234567890ab';
  const plan = classifyApproved({ approved, parcels, orders, ctx, runId });

  it('links what validates, skips (lists) what does not', () => {
    expect(plan.counts).toEqual({ approved: 4, link: 3, skipped: 1, high: 2, medium: 1 });
    expect(plan.csv.find((r) => r.order === 'ORD-4')).toMatchObject({ action: 'skip', why: expect.stringMatching(/already linked/) });
  });

  it('one unit per parcel: mex_link_parcel method repair, the MEX columns, history, one note with the owner\'s words', () => {
    const [u1, u2, u3] = plan.units;
    const r1 = u1.rows[0];
    expect(r1).toMatchObject({ order_id: uuid(1), rule: 'LM_manual', expect_status: 'cancelled', expect_tracking: null,
      link: { tracking: '002-9110-1/2026', method: 'repair', force: false, expectOwner: null }, history: { from: 'cancelled', to: 'paid' } });
    expect(r1.set).toEqual(mexStatusSet('paid', parcels.get('002-9110-1/2026')));
    expect(r1.set).toMatchObject({ status: 'paid', paid_basis: 'mex', cancellation_reason: null, trash_reason: null, cancelled_at: null });
    expect(r1.note).toContain(NOTE_TAG);
    expect(NOTE_TAG).toBe('linked by owner-approved manual review 01.10.2026');
    expect(r1.note).toContain(`undo: scripts/rollback-repair.mjs --run ${runId}`);
    expect(r1.note).toContain('Nothing was sent to AlterCPA');
    expect(u2.rows[0].set).toMatchObject({ status: 'returned', returned_at: '2026-09-15T08:00:00.000Z', paid_at: null });
    expect(u3.rows[0].set).toEqual({ paid_basis: 'mex' });       // already paid → only the proof
    expect(u3.rows[0].history).toBeNull();
    for (const u of plan.units) expect(u.rows[0].set.status).not.toBe('confirmed');
  });

  it('the hash lines carry the order first (the kit reads it back) and the status changes feed the Trash pre-check', () => {
    expect(plan.lines).toEqual([
      `${uuid(1)}:LM_manual:cancelled>paid:002-9110-1/2026`,
      `${uuid(2)}:LM_manual:confirmed>returned:002-9110-2/2026`,
      `${uuid(3)}:LM_manual:paid>basis:002-9110-3/2026`,
    ]);
    for (const l of plan.lines) expect(lineOrderId(l)).toMatch(/^0{8}-/);
    expect([...plan.changes.entries()]).toEqual([[uuid(1), { status: 'paid' }], [uuid(2), { status: 'returned' }]]);
    expect(moveRows(plan.csv).map((r) => r.move)).toEqual(['cancelled → paid', 'confirmed → returned', 'paid → basis']);
  });
});
