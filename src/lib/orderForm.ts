// The order form's rules (Phase 6, plan 30.09) — pure, so the modal, its tests and
// any later surface agree on one answer.
//
// A CONFIRMED order goes to the warehouse and then to MEX, which routes on the zone
// alone and has no cancellation endpoint. So a confirm needs a place picked from the
// list (never free text), a district where the city is split over several zones
// (Скопје), and an address the courier can find — the same "street + number OR
// quarter + building" rule the MEX export (fulfilmentValidation.ts) applies, so an
// order that passes here exports cleanly. Call-again / pending / cancel / trash
// record a call outcome and need no address.

import type { CustomerProfileBody } from '@/lib/api';

export type OrderFormGap = 'name' | 'phone' | 'products' | 'settlement' | 'district' | 'street' | 'office';

/** Display / scroll order of the gaps (header → products → address). */
export const GAP_ORDER: readonly OrderFormGap[] = ['name', 'phone', 'products', 'settlement', 'district', 'street', 'office'];

export interface OrderFormAddress {
  delivery_type: string;
  settlement_id: string | null;
  street: string;
  street_number: string;
  quarter: string;
  block: string;
  courier_office_code?: string;
  courier_office_name?: string;
  courier_office_city?: string;
}

export interface OrderFormCheck {
  status: string;
  name: string;
  phone: string;
  itemCount: number;
  address: OrderFormAddress;
  /** The server's answer for the picked settlement (null while loading / none picked). */
  zone: { requires_district: boolean | null; district_id: string | null } | null;
}

/** Only a confirm ships — everything else records a call outcome. */
export const addressRequired = (status: string): boolean => status === 'confirmed';

const filled = (s: string | null | undefined) => !!String(s ?? '').trim();

export const isOfficeDelivery = (t: string | null | undefined) =>
  t === 'speedy_office' || t === 'econt_office' || t === 'mex_office';

/** Street + house number, or quarter + building — mirror of validateOrderForFulfilment. */
export const hasCourierAddress = (a: Pick<OrderFormAddress, 'street' | 'street_number' | 'quarter' | 'block'>) =>
  (filled(a.street) && filled(a.street_number)) || (filled(a.quarter) && filled(a.block));

/** What is still missing, in GAP_ORDER. Empty = the primary button may save. */
export function orderFormGaps(c: OrderFormCheck): OrderFormGap[] {
  const gaps = new Set<OrderFormGap>();
  if (!filled(c.name)) gaps.add('name');
  if (!filled(c.phone)) gaps.add('phone');
  if (addressRequired(c.status)) {
    if (c.itemCount < 1) gaps.add('products');
    if (isOfficeDelivery(c.address.delivery_type)) {
      if (!filled(c.address.courier_office_code) || !filled(c.address.courier_office_name) || !filled(c.address.courier_office_city)) {
        gaps.add('office');
      }
    } else {
      if (!c.address.settlement_id) gaps.add('settlement');
      else if (c.zone?.requires_district && !c.zone.district_id) gaps.add('district');
      if (!hasCourierAddress(c.address)) gaps.add('street');
    }
  }
  return GAP_ORDER.filter((g) => gaps.has(g));
}

/**
 * "Зачувај го клиентот" / the merge after a confirm. Blank fields are left OUT —
 * the server merges fill-only (customer_profile_merge), so an empty form field
 * never wipes what the profile already knows. Birthday and the profile note are
 * not form fields any more and are never sent from here.
 */
export function profilePatchFromForm(f: {
  phone: string;
  name: string;
  address: OrderFormAddress & { city: string; postal_code: string; entry: string; floor: string; apartment: string; home_courier?: string };
}): CustomerProfileBody {
  const out: Record<string, string> = { phone: f.phone.trim() };
  const put = (k: Exclude<keyof CustomerProfileBody, 'clear' | 'phone'>, v: string | null | undefined) => {
    const s = String(v ?? '').trim();
    if (s) out[k] = s;
  };
  put('customer_name', f.name);
  const a = f.address;
  put('delivery_type', a.delivery_type);
  if (isOfficeDelivery(a.delivery_type)) {
    put('courier_office_code', a.courier_office_code);
    put('courier_office_name', a.courier_office_name);
    put('courier_office_city', a.courier_office_city);
  } else {
    put('city', a.city);
    put('postal_code', a.postal_code);
    put('quarter', a.quarter);
    put('street', a.street);
    put('street_number', a.street_number);
    put('block', a.block);
    put('entry', a.entry);
    put('floor', a.floor);
    put('apartment', a.apartment);
    put('home_courier', a.home_courier);
    put('settlement_id', a.settlement_id);
  }
  return out as unknown as CustomerProfileBody;
}
