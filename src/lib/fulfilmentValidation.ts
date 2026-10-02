// Pre-export validation for the Daily Fulfilment CSV (the warehouse / BigArena
// hand-off). An order must be complete and correctly structured before it can
// ship — otherwise BigArena rejects the whole file. The export uses this to hold
// incomplete orders back as `confirmed` (instead of flipping the whole batch to
// `shipped`), so the operator never has to revert good orders one by one.
//
// See the elyon-fulfilment-csv skill. Field codes below map to i18n labels in
// the validation dialog.

import { isValidPhone } from '@/lib/validation';
import { effectiveHomeParts } from '@/lib/address';

export type FulfilmentField =
  | 'name'          // missing, or not a full name (first + last)
  | 'phone'         // missing or invalid
  | 'postal_code'   // missing or not a 4-digit BG code
  | 'product'       // no product / zero quantity
  | 'price'         // not a positive COD amount
  | 'address'       // home order with no usable street/quarter at all
  | 'house_number'  // home order has a street but the house number is missing
  | 'office'        // office order missing its office code / name / city
  | 'mex_city'      // no MEX delivery zone resolved for this address
  | 'data_hidden';  // customer data masked for this role — can't be validated here

export interface FulfilmentValidation {
  ok: boolean;
  missing: FulfilmentField[];
}

/** The order fields the warehouse hand-off depends on. All optional/loose — the
 *  orders list is heterogeneous (legacy rows, multi-item orders, masked PII). */
export interface FulfilmentOrder {
  id?: string;
  display_id?: string;
  customer_name?: string | null;
  customer_phone?: string | null;
  postal_code?: string | null;
  price?: number | string | null;
  product_name?: string | null;
  quantity?: number | null;
  order_items?: Array<{ product_name?: string | null; quantity?: number | null }> | null;
  delivery_type?: string | null;
  // Resolved server-side from the settlement. The MEX file's receiver_city_id.
  mex_city_id?: number | null;
  courier_office_code?: string | null;
  courier_office_name?: string | null;
  courier_office_city?: string | null;
  street?: string | null;
  street_number?: string | null;
  quarter?: string | null;
  block?: string | null;
  entry?: string | null;
  floor?: string | null;
  apartment?: string | null;
  customer_address?: string | null;
  customer_city?: string | null;
  /** The value is withheld from this viewer (a dept_admin's row of another department). */
  value_hidden?: boolean;
}

// What the API returns for a PII field the current role isn't allowed to see.
const MASK = '•••';

/** Office (courier-desk) deliveries need a selected office, not a street. */
function isOfficeDelivery(o: FulfilmentOrder): boolean {
  return o.delivery_type === 'speedy_office'
    || o.delivery_type === 'econt_office'
    || o.delivery_type === 'mex_office';
}

/** At least one product line with a name and a positive quantity. */
function hasProduct(o: FulfilmentOrder): boolean {
  const items = Array.isArray(o.order_items) ? o.order_items : [];
  if (items.length > 0) {
    return items.some((i) => String(i?.product_name || '').trim() !== '' && (Number(i?.quantity) || 0) >= 1);
  }
  return String(o.product_name || '').trim() !== '' && (Number(o.quantity) || 0) >= 1;
}

/** True if any customer field we rely on is masked by the privacy role. */
function looksMasked(o: FulfilmentOrder): boolean {
  const masked = (v: unknown) => String(v ?? '').trim() === MASK;
  return masked(o.customer_address) || masked(o.street) || masked(o.postal_code)
    || masked(o.courier_office_code) || masked(o.courier_office_name)
    || String(o.customer_phone || '').includes('•');
}

/**
 * Validate one order against the warehouse hand-off requirements. Returns the
 * stable field codes that are missing/invalid; `ok` is true only when none are.
 * Reuses the same address resolution (`effectiveHomeParts`) the CSV uses, so a
 * passing order exports and ships cleanly.
 */
export function validateOrderForFulfilment(o: FulfilmentOrder): FulfilmentValidation {
  // If the data is masked for this role, nothing below can be trusted — surface
  // one clear message rather than a pile of false "missing" flags.
  if (looksMasked(o)) return { ok: false, missing: ['data_hidden'] };
  // No price for this viewer (value_hidden): its COD cannot be written — never an Otkup of 0.
  if (o.value_hidden === true) return { ok: false, missing: ['data_hidden'] };

  const missing: FulfilmentField[] = [];

  // Name — present and a full name (first + last).
  const name = String(o.customer_name || '').trim();
  if (!name || name.split(/\s+/).filter(Boolean).length < 2) missing.push('name');

  // Phone — valid BG/international format (8–15 digits).
  if (!isValidPhone(String(o.customer_phone || ''))) missing.push('phone');

  // Postal code — Macedonian codes are 4-digit too, so the rule is unchanged.
  // Auto-filled from the settlement picker; MEX itself has no postcode field.
  if (!/^\d{4}$/.test(String(o.postal_code || '').trim())) missing.push('postal_code');

  // MEX delivery zone. add_shipment.php routes on receiver_city_id and nothing
  // else — no postcode field, and the address is free text — so an order
  // without a zone cannot be shipped at all. Hold it back rather than let the
  // courier guess: MEX has no cancellation endpoint, and a parcel sent to the
  // wrong town cannot be recalled.
  if (!(Number(o.mex_city_id) > 0)) missing.push('mex_city');

  // Product + quantity.
  if (!hasProduct(o)) missing.push('product');

  // Price — positive COD amount.
  if (!(Number(o.price) > 0)) missing.push('price');

  // Delivery address.
  if (isOfficeDelivery(o)) {
    if (!String(o.courier_office_code || '').trim()
      || !String(o.courier_office_name || '').trim()
      || !String(o.courier_office_city || '').trim()) {
      missing.push('office');
    }
  } else {
    // Home (door) delivery: complete = (street + house number) OR (quarter + block).
    const p = effectiveHomeParts(o);
    const hasStreetNo = !!(p.street && p.street_number);
    const hasQuarterBlock = !!(p.quarter && p.block);
    if (!hasStreetNo && !hasQuarterBlock) {
      // Be specific when a street is present but the number isn't (the common
      // "number stuck in the street name / left out" case); else it's a blank
      // or otherwise unusable address.
      if (p.street && !p.street_number) missing.push('house_number');
      else missing.push('address');
    }
  }

  return { ok: missing.length === 0, missing };
}
