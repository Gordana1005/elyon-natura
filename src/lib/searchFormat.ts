// Pure formatting/derivation helpers shared by the Search Prediction page and
// the topbar global search. Kept separate from the rendering components so
// React Fast Refresh stays happy (a module should export only components OR
// only helpers, not both).

import { STATUS_COLORS } from '@/types';
import { composeHomeAddress } from '@/lib/address';

// Order-status colours come from the single source of truth in src/types
// (STATUS_COLORS). Lead-status colours (not_contacted/no_answer/interested/
// not_interested) are added here since they're not part of OrderStatus.
export const STATUS_TONE: Record<string, string> = {
  ...STATUS_COLORS,
  not_contacted: 'bg-gray-400 text-white border-gray-400',
  no_answer: 'bg-amber-500 text-white border-amber-500',
  interested: 'bg-sky-500 text-white border-sky-500',
  not_interested: 'bg-rose-500 text-white border-rose-500',
};

export function deliveryLabel(o: any): { icon: string; line1: string; line2: string } {
  const dt = o.delivery_type || 'home';
  if (dt === 'speedy_office' || dt === 'econt_office' || dt === 'mex_office') {
    const courier = dt === 'speedy_office' ? 'Speedy' : dt === 'mex_office' ? 'MEX' : 'Econt';
    const code = o.courier_office_code ? `${o.courier_office_code} ` : '';
    const officeName = o.courier_office_name || '';
    const city = o.courier_office_city || '';
    return {
      icon: '🚚',
      line1: `${courier} · ${city}`,
      line2: `${code}${officeName}`.trim() || '—',
    };
  }
  // Home address
  const body = composeHomeAddress(o);
  return {
    icon: '🏠',
    line1: o.customer_city || o.customer_address || '—',
    line2: body || (o.postal_code || '—'),
  };
}

export function fullAddress(o: any): string {
  if (!o) return '';
  if (o.delivery_type === 'speedy_office' || o.delivery_type === 'econt_office' || o.delivery_type === 'mex_office') {
    const courier = o.delivery_type === 'speedy_office' ? 'Speedy' : o.delivery_type === 'mex_office' ? 'MEX' : 'Econt';
    return `${courier} — ${o.courier_office_city || ''} · ${o.courier_office_code ? o.courier_office_code + ' ' : ''}${o.courier_office_name || ''}`.trim();
  }
  const parts = [
    composeHomeAddress(o),
    o.customer_city,
    o.postal_code,
  ].filter(Boolean);
  if (parts.length === 0) return o.customer_address || '';
  return parts.join(', ');
}

/**
 * An order's total in stored EUR: the sum of its lines, or — for an order with
 * no order_items rows — `orders.price`, which IS the order total (not a unit
 * price; verified 2026-09-28: on 17.692 of 21.996 multi-unit orders with lines,
 * price = Σ order_items.total_price, and price × quantity matched only 87). The
 * import sets total_price = price; the server's call history and lead→order
 * conversion read it the same way. Never multiply it by `quantity`.
 */
export function orderTotal(o: any): number {
  const items = o?.order_items || [];
  if (items.length > 0) {
    return items.reduce((s: number, i: any) => s + Number(i.total_price || 0), 0);
  }
  return Number(o?.price || 0);
}

export interface CustomerSummary {
  name: string;
  phone: string;
  email: string;
  birthday: string | null;
  address: string;
  city: string;
  totalOrders: number;
  paidCount: number;
  lifetimeRevenue: number;
}

// Customer summary derived from a set of orders. Uses the most recent order for
// personal info (address, name) and aggregates paid totals across all of them.
export function deriveCustomerSummary(orders: any[]): CustomerSummary | null {
  if (!orders || orders.length === 0) return null;
  const latest = orders[0];
  const paidStatuses = new Set(['paid', 'delivered']);
  let lifetimeRevenue = 0;
  let paidCount = 0;
  for (const o of orders) {
    const t = orderTotal(o);
    if (paidStatuses.has(o.status)) {
      lifetimeRevenue += t;
      paidCount++;
    }
  }
  return {
    name: latest.customer_name || '—',
    phone: latest.customer_phone || '—',
    email: latest.customer_email || '',
    birthday: latest.birthday,
    address: fullAddress(latest),
    city: latest.customer_city || '',
    totalOrders: orders.length,
    paidCount,
    lifetimeRevenue,
  };
}
