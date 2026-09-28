import { describe, expect, it } from 'vitest';
import { deriveCustomerSummary, orderTotal } from './searchFormat';

// orders.price is the ORDER TOTAL, not a unit price (verified on live data
// 2026-09-28: on multi-unit orders with lines, price = Σ order_items.total_price
// 17.692 times, price × quantity only 87). Multiplying it by quantity inflated
// customer search "lifetime revenue" and the history cards.
describe('orderTotal', () => {
  it('sums the order lines when there are any', () => {
    expect(orderTotal({ price: 65.04, quantity: 3, order_items: [{ total_price: 65.04 }] })).toBe(65.04);
    expect(orderTotal({ price: 32.52, quantity: 4, order_items: [{ total_price: 16.26 }, { total_price: 16.26 }] })).toBe(32.52);
  });

  it('an order without lines is its price — never price × quantity', () => {
    expect(orderTotal({ price: 48.78, quantity: 3 })).toBe(48.78);
    expect(orderTotal({ price: 48.78, quantity: 3, order_items: [] })).toBe(48.78);
    expect(orderTotal({ price: null, quantity: 2 })).toBe(0);
  });
});

describe('deriveCustomerSummary — lifetime revenue', () => {
  it('adds paid/delivered order totals once each, whatever their quantity', () => {
    const s = deriveCustomerSummary([
      { status: 'paid', price: 48.78, quantity: 3 },                                  // no lines
      { status: 'delivered', price: 65.04, quantity: 4, order_items: [{ total_price: 65.04 }] },
      { status: 'returned', price: 30, quantity: 2 },                                 // not revenue
    ]);
    expect(s?.paidCount).toBe(2);
    expect(s?.lifetimeRevenue).toBeCloseTo(113.82, 2);
  });
});
