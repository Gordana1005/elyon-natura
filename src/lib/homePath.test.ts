import { describe, expect, it } from 'vitest';
import { homePath } from './homePath';

const can = (...keys: string[]) => (k: string) => keys.includes(k);

describe('homePath — where a login lands (owner 29.09.2026)', () => {
  it('sends every kind of call agent to /calls', () => {
    for (const u of [{ isAgent: true, isPendingAgent: true }, { isAgent: true, isPredictionAgent: true }, { isAgent: true, isInboundAgent: true }]) {
      expect(homePath(u, { canAccessModule: can('calls', 'dashboard', 'performance') })).toBe('/calls');
    }
  });

  it('never sends a prediction agent to /assigned (the old loop)', () => {
    expect(homePath({ isAgent: true, isPredictionAgent: true }, { canAccessModule: can('calls', 'dashboard') })).toBe('/calls');
  });

  it('sends admins, managers and business owners to Insights', () => {
    expect(homePath({ isAdmin: true }, { canAccessModule: () => true })).toBe('/insights');
    expect(homePath({ isManager: true }, { canAccessModule: can('insights', 'dashboard', 'orders') })).toBe('/insights');
    expect(homePath({ isAgent: true }, { canAccessModule: can('calls'), canSeeBusiness: true })).toBe('/insights');
  });

  it('a manager who is also an agent still starts on Insights', () => {
    expect(homePath({ isManager: true, isAgent: true }, { canAccessModule: can('insights', 'calls') })).toBe('/insights');
  });

  it('warehouse, ads admin and external affiliate land on their own page', () => {
    expect(homePath({ isWarehouse: true }, { canAccessModule: can('warehouse', 'orders') })).toBe('/warehouse');
    // /webhooks is hidden since the page audit (30.09.2026) — ads admins land on the catalogue
    expect(homePath({ isAdsAdmin: true }, { canAccessModule: can('products', 'webhooks') })).toBe('/products');
    expect(homePath({ isAffiliate: true, isExternalAffiliate: true }, { canAccessModule: can('affiliate_portal') })).toBe('/affiliate');
  });

  it('falls back to any page the login can open, else null (the no-access screen, never a loop)', () => {
    expect(homePath({}, { canAccessModule: can('orders') })).toBe('/orders');
    expect(homePath({ isAgent: true }, { canAccessModule: () => false })).toBeNull();
    expect(homePath(null, { canAccessModule: () => true })).toBe('/login');
  });
});
