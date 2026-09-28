import { describe, it, expect } from 'vitest';
// The pure halves of the 28.09.2026 link repairs (owner: "link everything that has to be linked,
// make it accurate; never count the same order twice"). Synthetic rows only.
import { fitOf, targetFor, classifyLinks } from '../../scripts/repair-link-elyon-parcels.mjs';
import { classifyTwins } from '../../scripts/repair-teleshop-twin-links.mjs';
import { classifyPairs } from '../../scripts/repair-crm-collabbox-twins.mjs';

const P = { tracking_id: '002-9110-1/2026', account: 'bio_natural', series: '9110', status_id: 2, status_name: 'Delivered',
  cod_mkd: 3000, phone8: '70111222', created_at_mex: '2026-09-10T06:00:00Z', delivered_at: '2026-09-12T10:00:00Z',
  returned_at: null, last_update_at: '2026-09-12T10:00:00Z' };
const O = { id: '11111111-1111-4111-8111-111111111111', display_id: 'ORD-1', status: 'cancelled', price: 24.23, product_name: 'Urofix',
  sale_source: 'altercpa', sale_source_detail: 'bridge', customer_phone: '+38970111222', created_at: '2026-09-08T10:00:00Z',
  paid_basis: null, held_tracking: null, held_status: null, held_cod: null, held_created: null, held_order: null,
  cpa_price: '3000', cpa_currency: 'MKD' };
const row = (o = {}, p = {}) => ({ ...P, ...O, ...p, ...o });

describe('link-elyon-parcels — which order a lonely BIO NATURAL parcel belongs to', () => {
  it('an AlterCPA lead cancelled in the panel, then shipped at the price edited in AlterCPA', () => {
    expect(fitOf(row())).toMatchObject({ kind: 'cancel_then_ship', how: 'AlterCPA lead price' });
  });
  it('no fit: a 0 ден call outcome, a price that fits nothing, or an order far from the parcel', () => {
    expect(fitOf(row({ price: 0, sale_source: 'elyon_crm', sale_source_detail: 'disposition' }))).toBeNull();
    expect(fitOf(row({ cpa_price: '1990' }))).toBeNull();
    expect(fitOf(row({ created_at: '2026-08-20T10:00:00Z' }))).toBeNull();
  });
  it('a CRM order is never revived from cancelled (only AlterCPA leads are, rule C)', () => {
    expect(fitOf(row({ sale_source: 'elyon_crm', sale_source_detail: 'prediction_list', price: 48.78 }))).toBeNull();
    expect(fitOf(row({ sale_source: 'elyon_crm', sale_source_detail: 'prediction_list', price: 48.78, status: 'confirmed' })))
      .toMatchObject({ kind: 'no_parcel', how: 'price exact' });
  });
  it('a re-shipment: the order holds its own returned parcel with the same COD', () => {
    const r = row({ status: 'returned', held_tracking: '002-9110-0/2026', held_status: 7, held_cod: 3000,
      held_created: '2026-09-01T06:00:00Z', held_order: O.id });
    expect(fitOf(r)).toMatchObject({ kind: 'reship' });
    expect(fitOf({ ...r, held_created: '2026-07-01T06:00:00Z' })).toBeNull();          // more than 30 days apart
    expect(fitOf({ ...r, held_status: 2 })).toBeNull();                               // the first parcel was delivered
  });
  it('the order follows the parcel', () => {
    expect(targetFor({ status: 'cancelled' }, { status_id: 2 })).toBe('paid');
    expect(targetFor({ status: 'paid', paid_basis: null }, { status_id: 2 })).toBe('basis');
    expect(targetFor({ status: 'paid', paid_basis: 'mex' }, { status_id: 2 })).toBeNull();
    expect(targetFor({ status: 'returned' }, { status_id: 1 })).toBe('shipped');
    expect(targetFor({ status: 'returned' }, { status_id: 7 })).toBeNull();
  });
  it('two orders fitting one parcel, or one order fitting two parcels, are left to a human', () => {
    const a = row();
    const b = row({ id: '22222222-2222-4222-8222-222222222222', display_id: 'ORD-2' });
    expect(classifyLinks({ rows: [a, b] }).counts).toMatchObject({ link: 0, manual: 1 });
    const c = row({}, { tracking_id: '002-9110-2/2026' });
    expect(classifyLinks({ rows: [a, c] }).counts).toMatchObject({ link: 0, manual: 2 });
    expect(classifyLinks({ rows: [a] }).counts).toMatchObject({ link: 1, manual: 0, cancel_then_ship: 1 });
  });
});

describe('teleshop-twin-links — a teleshop document whose sale is already a CRM order', () => {
  const base = { doc_number: '002-9102-5/2026', reason: 'likely_twin_crm_sale_price_differs', tracking_id: '002-9102-5/2026',
    amount_mkd: 3000, author: 'X', doc_at: '2026-09-02T10:00:00Z', doc_phone8: '70111222', id: O.id, display_id: 'ORD-1',
    status: 'paid', price: 24.23, product_name: 'Urofix', source_type: 'import', external_source: 'altercpa',
    customer_phone: '+38970111222', mex_tracking_id: null, paid_basis: null, created_at: '2026-09-01T10:00:00Z',
    p_tracking: '002-9102-5/2026', account: 'natura', series: '9102', status_id: 7, status_name: 'Return to sender', cod_mkd: 3000,
    p_phone8: '70111222', created_at_mex: '2026-09-02T12:00:00Z', delivered_at: null, returned_at: '2026-09-09T10:00:00Z',
    last_update_at: '2026-09-09T10:00:00Z', p_order: null, namers: [], docs_on_order: 1 };
  it('MEX decides: a "paid" twin whose parcel came back becomes returned', () => {
    const { units, counts } = classifyTwins({ cases: [base] });
    expect(counts).toMatchObject({ link: 1, followed: 1 });
    expect(units[0].rows[0].set.status).toBe('returned');
    expect(units[0].rows[0].link).toMatchObject({ tracking: base.tracking_id, method: 'collabbox_import', force: false });
  });
  it('never links a parcel another order holds or two documents claim', () => {
    expect(classifyTwins({ cases: [{ ...base, p_order: '33333333-3333-4333-8333-333333333333' }] }).counts.manual).toBe(1);
    expect(classifyTwins({ cases: [{ ...base, docs_on_order: 2 }] }).counts.manual).toBe(1);
  });
});

describe('crm-collabbox-twins — one sale booked in the CRM and in collabBox', () => {
  const pair = { c_id: O.id, c_display: 'ORD-1', c_status: 'confirmed', c_price: 48.78, c_created: '2026-09-05T10:00:00Z',
    x_id: '44444444-4444-4444-8444-444444444444', x_display: 'ORD-9', x_status: 'paid', x_price: 48.78, x_created: '2026-09-05T11:00:00Z',
    x_doc: '002-9102-7/2026', tracking: '002-9102-7/2026', account: 'natura', series: '9102', status_id: 2, status_name: 'Delivered',
    cod_mkd: 3000, created_at_mex: '2026-09-06T06:00:00Z', delivered_at: '2026-09-08T10:00:00Z', returned_at: null,
    last_update_at: '2026-09-08T10:00:00Z', p_order: '44444444-4444-4444-8444-444444444444', x_per_c: 1, c_per_x: 1, other_namers: 0, seller: 'A' };
  it('the CRM order keeps the sale and takes the parcel; the collabBox copy is marked duplicated', () => {
    const { units, counts } = classifyPairs({ pairs: [pair] });
    expect(counts).toMatchObject({ merge: 1, manual: 0 });
    const [copy, keep] = units[0].rows;
    expect(copy.set).toEqual({ status: 'duplicated' });
    expect(keep.set.status).toBe('paid');
    expect(keep.link).toMatchObject({ tracking: pair.tracking, force: true, expectOwner: pair.x_id });
  });
  it('an ambiguous pair is left alone', () => {
    expect(classifyPairs({ pairs: [{ ...pair, x_per_c: 2 }] }).counts).toMatchObject({ merge: 0, manual: 1 });
  });
});
