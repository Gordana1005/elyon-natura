/**
 * The collabBox komitent register (a harvest of the Коминтенти list — scripts/collab-out-refresh.mjs
 * komitenti → komitenti_full.csv) read the way the sync reads a komitent CARD.
 *
 * registerCard(row) is the TWIN of komitentCard() in supabase/functions/collabbox-sync/collabbox.ts (the
 * phone — Мобилен first, then Телефон, strict Macedonian NSN, never rewritten — and the skip verdict:
 * employee · company · deceased · wrong_number · test; do_not_contact / returns_orders only flagged).
 * supabase/functions/collabbox-sync/registerPhones.test.ts proves the two equal.
 * The file holds PII (names, phones, addresses): it never leaves exports/ and is never committed.
 */
import { readFileSync } from 'node:fs';
import { COMPANY_RE, RETURNS_MARKER, cleanName, csvObjects, mkPhone8, nameMarker } from './teleshop-import.mjs';

/** The 20 columns of the 10.09 / 01.10 harvests. */
export const REGISTER_COLUMNS = Object.freeze(['Sifra', 'VnatresenID', 'Ime', 'Ime_lat', 'Adresa', 'Adresa_lat', 'Grad', 'Drzava',
  'Datum_raganje', 'Telefon', 'Mobilen', 'Email', 'Ziro_smetka', 'Broj_kartica', 'Danocen_broj', 'Faks', 'Lice_kontakt', 'DDV_broj',
  'EMBS', 'Vraboten']);
/** Komitent ids below this are the legacy register, where Vraboten = Да is a stale default (collabbox.ts). */
export const LEGACY_KOMITENT_BELOW = 40000;
/** collabbox_customers.source of a harvest made on `ymd` (YYYY-MM-DD): 'register_YYYYMMDD' (20260947001950). */
export const registerSource = (ymd) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ymd))) throw new Error(`register date must be YYYY-MM-DD, got ${ymd}`);
  return `register_${String(ymd).replace(/-/g, '')}`;
};
export const SOURCE_RE = /^register_\d{8}$/;

/** komitenti_full.csv → Map(Шифра → row). Refuses a file that is not the harvest's layout or repeats a Шифра. */
export function loadRegister(file) {
  const rows = csvObjects(readFileSync(file, 'utf8'));
  if (!rows.length) throw new Error(`${file}: no rows`);
  const missing = REGISTER_COLUMNS.filter((c) => !(c in rows[0]));
  if (missing.length) throw new Error(`${file}: not the register layout (missing ${missing.join(', ')})`);
  const out = new Map();
  for (const r of rows) {
    if (!/^\d{1,10}$/.test(r.Sifra)) continue;
    if (out.has(r.Sifra)) throw new Error(`${file}: Шифра ${r.Sifra} twice`);
    out.set(r.Sifra, r);
  }
  return out;
}

/** A register row → the card as collabbox.ts komitentCard() builds it (KEEP IN STEP). */
export function registerCard(r) {
  const name = cleanName(r.Ime);
  const m = mkPhone8(r.Mobilen);
  const t = m.p8 ? null : mkPhone8(r.Telefon);
  const p8 = m.p8 ?? t?.p8 ?? null;
  const flags = [];
  let skip = null;
  const isDa = String(r.Vraboten ?? '').trim() === 'Да';
  const legacy = Number(r.Sifra) < LEGACY_KOMITENT_BELOW;
  if (/вработен/iu.test(name) || (isDa && !legacy)) skip = 'employee';
  else if (String(r.Danocen_broj ?? '').trim() || String(r.Ziro_smetka ?? '').trim() || COMPANY_RE.test(name)) skip = 'company';
  else {
    const marker = nameMarker(name);
    if (marker === 'do_not_contact') flags.push('do_not_contact');
    else if (marker) skip = marker;
  }
  if (RETURNS_MARKER.test(name)) flags.push('returns_orders');
  if (isDa && legacy) flags.push('vraboten_legacy_flag');
  return {
    komitent_id: r.Sifra, object_id: r.VnatresenID || null, name: name || null, phone8: p8,
    phone_field: m.p8 ? 'mobilen' : p8 ? 'telefon' : null,
    phone_raw: [r.Mobilen, r.Telefon].map((x) => String(x ?? '').trim()).filter(Boolean).join(' | ') || null,
    city: cleanName(r.Grad) || null, address: cleanName(r.Adresa) || null, skip_reason: skip, flags,
  };
}

/** Why a register row gives no phone (counts only): empty · foreign · invalid. */
export function noPhoneWhy(r) {
  const raw = [r.Mobilen, r.Telefon].map((x) => String(x ?? '').trim()).filter(Boolean);
  if (!raw.length) return 'empty';
  return raw.some((x) => mkPhone8(x).why === 'foreign') ? 'foreign' : 'invalid';
}
