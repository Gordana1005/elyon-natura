// MEX Poshta CLIENT-PORTAL import file — the column contract, in one place.
//
// The portal's bulk importer takes an 8-column CSV whose header row is fixed
// (Latin, Macedonian words, exactly as their template ships it):
//
//   Kod na pratka,Ime,Adresa,Grad,Telefon,Otkup,Opis,Tezina
//   A1234567,Alex Test,Varshavska 123,Skopje,076123456,150,maska za telefon,0.1
//
// This replaced the add_shipment.php parameter layout (tracking_id,
// sender_reference, first_name/last_name, receiver_city_id, …): that was the
// API's contract, and the portal importer does not accept it. The API layout's
// extras are deliberately gone — the importer has no column for a zone id
// (Grad is matched by NAME against MEX's 149 Latin zone names, which is why
// the value here is the mex_city_name snapshot, not the operator's free-text
// city) and no first/last split.
//
// Everything is emitted in LATIN (operator decision 2026-08-18): the template
// is Latin, MEX's own zone list is Latin-only, and their importer's Cyrillic
// handling is unverified — a rejected file costs a shipping day. Uses the
// readable transliterate() map, never the lossy normalizeMkGeo().
//
// Every text field is also stripped of commas, quotes and newlines so that
// toCsv() never needs to quote a field — composeHomeAddress() joins with
// commas, and a naive importer would read a quoted field as garbage columns.
//
// The future add_shipment.php direct push (deferred; see the packing
// migration) should reuse these formatters rather than growing its own copies.

import type { CsvColumn } from './csv';
import { transliterate } from './transliterate';
import { composeHomeAddress, effectiveHomeParts } from './address';
import { codFor } from './currency';

/** Declared parcel weight in kg. Rates are flat (150 ден, every parcel is
 *  under 1 kg), so this is a declaration, not a billing input. */
export const MEX_IMPORT_WEIGHT_KG = '1';

/** The exact header row the MEX portal importer expects, in order. */
export const MEX_IMPORT_HEADERS = [
  'Kod na pratka', 'Ime', 'Adresa', 'Grad', 'Telefon', 'Otkup', 'Opis', 'Tezina',
] as const;

// Order rows arrive from the Orders page untyped; the fields actually read
// are listed here, the rest ride along.
export interface MexImportOrder {
  display_id?: string | null;
  customer_name?: string | null;
  customer_phone?: string | null;
  customer_address?: string | null;
  customer_city?: string | null;
  postal_code?: string | null;
  // Granular home-address parts consumed by effectiveHomeParts().
  street?: string | null;
  street_number?: string | null;
  quarter?: string | null;
  block?: string | null;
  entry?: string | null;
  floor?: string | null;
  apartment?: string | null;
  delivery_type?: string | null;
  courier_office_code?: string | null;
  courier_office_name?: string | null;
  courier_office_city?: string | null;
  mex_city_name?: string | null;
  delivery_instructions?: string | null;
  price?: number | null;
  [key: string]: unknown;
}

/** Latin, single-line, CSV-safe: transliterate, then remove every character
 *  that would force toCsv() to quote the field (commas, quotes, newlines). */
const field = (s: unknown): string =>
  transliterate(String(s ?? ''))
    .replace(/[",\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// Street-level address only — city goes in its own column. MEX has no office
// concept at all, so a pickup order states the pickup point inside the
// address itself ("Podiganje: #code name city" after transliteration).
const addressLine = (o: MexImportOrder): string => {
  if (o.delivery_type === 'speedy_office' || o.delivery_type === 'econt_office' || o.delivery_type === 'mex_office') {
    return [
      'Подигање:',
      o.courier_office_code && `#${o.courier_office_code}`,
      o.courier_office_name,
      o.courier_office_city,
    ].filter(Boolean).join(' ');
  }
  // Resolve the real parts first — splits a house number stuck in the street
  // field so the line carries "бр. <n>", and parses legacy blob-only rows.
  // Falls back to the raw blob if the address can't be resolved at all.
  return composeHomeAddress(effectiveHomeParts(o)) || (o.customer_address || '');
};

const cityName = (o: MexImportOrder): string =>
  (o.delivery_type === 'speedy_office' || o.delivery_type === 'econt_office' || o.delivery_type === 'mex_office')
    ? (o.courier_office_city || '')
    : (o.customer_city || '');

// MK national format (0XXXXXXXX) from the stored +389 E.164 number.
// NOTE: this used to strip only +359. A +389 number fell straight through
// and was emitted as "389XXXXXXXX" — a plausible-looking but wrong national
// number that a courier would fail to dial.
const phoneNational = (o: MexImportOrder): string => {
  let p = (o.customer_phone || '').replace(/[^\d+]/g, '');
  if (p.startsWith('+389')) p = '0' + p.slice(4);
  else if (p.startsWith('389')) p = '0' + p.slice(3);
  return p.replace(/\D/g, '');
};

/**
 * The 8 portal-import columns, ready for toCsv(orders, ..., ',', false) —
 * comma-separated, no BOM, and (thanks to `field`) never a quoted value.
 */
export function buildMexImportColumns(): CsvColumn<MexImportOrder>[] {
  return [
    // Our reference — display_id with everything non-numeric stripped
    // ("ORD-01234" → "01234", leading zeros kept). MEX echoes it back on
    // status lookups, which is what lets the reconcile cron match by code.
    { key: 'kod', header: 'Kod na pratka', format: (o) => String(o.display_id ?? '').replace(/\D/g, '') },
    // Full name in one field — the portal template has no first/last split.
    { key: 'ime', header: 'Ime', format: (o) => field(o.customer_name) },
    { key: 'adresa', header: 'Adresa', format: (o) => field(addressLine(o)) },
    // THE routing value. The importer matches this by name against MEX's own
    // zone list, so it must be the zone's Latin name (the mex_city_name
    // snapshot), not whatever the operator typed. Orders without a resolved
    // zone are held back by validateOrderForFulfilment before this runs.
    { key: 'grad', header: 'Grad', format: (o) => field(o.mex_city_name || cityName(o)) },
    { key: 'telefon', header: 'Telefon', format: phoneNational },
    // Plain integer denari ("1850", no decimals — the template shows "150").
    // codFor() stays the single source for the amount: it converts the stored
    // EUR price at the frozen peg and rounds to 10 ден, so the courier
    // collects exactly what every screen shows.
    { key: 'otkup', header: 'Otkup', format: (o) => String(codFor(o.price || 0).amount) },
    // The order form's "Delivery / additional info" field, verbatim
    // (operator decision 2026-08-18). Empty when the agent left it blank.
    { key: 'opis', header: 'Opis', format: (o) => field(o.delivery_instructions) },
    { key: 'tezina', header: 'Tezina', format: () => MEX_IMPORT_WEIGHT_KG },
  ];
}
