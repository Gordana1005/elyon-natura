import { describe, expect, it } from 'vitest';
import {
  isPicked, normalizeStates, pickHoldsBookings, quickViewOf, QUICK_VIEW_STATES, QUICK_VIEWS, STATE_KEYS, STATUS_ROWS,
  toggleState, visibleStatusRows,
} from './statusModel';

describe('the status pick', () => {
  it('normalizes: list order, unknown out, a child covered by its parent out', () => {
    expect(normalizeStates(['paid', 'nope', 'confirmed.packed', 'confirmed', 'shipped.problem'])).toEqual(['confirmed', 'shipped.problem', 'paid']);
  });

  it('a parent ticks its children; a child of a picked parent is un-ticked by keeping its sibling', () => {
    let s = toggleState([], 'confirmed');
    expect(s).toEqual(['confirmed']);
    expect(isPicked(s, 'confirmed.packed')).toBe(true);
    s = toggleState(s, 'confirmed.packed');
    expect(s).toEqual(['confirmed.no_parcel']);
    expect(isPicked(s, 'confirmed')).toBe(false);
    s = toggleState(s, 'confirmed.no_parcel');
    expect(s).toEqual([]);
    // ticking the parent swallows a lone child
    expect(toggleState(['shipped.problem', 'paid'], 'shipped')).toEqual(['shipped', 'paid']);
    // un-ticking the parent takes its children with it
    expect(toggleState(['shipped', 'paid'], 'shipped')).toEqual(['paid']);
  });

  it('the quick views: Сите · Нарачки · Отворени лидови · Откажани · Корпа · Вратени', () => {
    expect(QUICK_VIEWS).toEqual(['all', 'orders', 'leads', 'cancelled', 'trashed', 'returned']);
    for (const v of QUICK_VIEWS) expect(quickViewOf(QUICK_VIEW_STATES[v])).toBe(v);
    expect(quickViewOf(['paid', 'returned', 'confirmed', 'shipped', 'delivered'])).toBe('orders');
    expect(quickViewOf(['paid'])).toBeNull();
    expect(quickViewOf(['confirmed.no_parcel'])).toBeNull();
  });

  it('lists every key once; take / delivered only with orders or when picked', () => {
    expect(STATUS_ROWS.map((r) => r.key).sort()).toEqual([...STATE_KEYS].sort());
    const keys = (rows: { key: string }[]) => rows.map((r) => r.key);
    expect(keys(visibleStatusRows([], undefined))).not.toContain('take');
    expect(keys(visibleStatusRows([], { delivered: 3 }))).toContain('delivered');
    expect(keys(visibleStatusRows(['take'], { take: 0 }))).toContain('take');
  });

  it('the collabBox bookings sit beside every status, Потврдена or Во магацин за пакување', () => {
    expect(pickHoldsBookings([])).toBe(true);
    expect(pickHoldsBookings(QUICK_VIEW_STATES.orders)).toBe(true);
    expect(pickHoldsBookings(['confirmed.no_parcel'])).toBe(true);
    expect(pickHoldsBookings(['paid'])).toBe(false);
    expect(pickHoldsBookings(['confirmed.packed'])).toBe(false);
    expect(pickHoldsBookings(QUICK_VIEW_STATES.leads)).toBe(false);
  });
});
