// ============================================================================
// "Испрати до MEX" — the CRM creates MEX Poshta parcels itself (owner 30.09.2026,
// plan Фаза 9). The pure half of
//   POST /api/warehouse/mex-push           {order_ids, account_overrides?, dry_run}
//   GET  /api/warehouse/queue              (the per-row decision, via warehouseQueue.ts)
// plus the MEX client (fetch injected, so vitest mocks it — no real MEX call ever
// runs in a test) and mexAutoSendPlan() — the 11:00 auto-send, BUILT BUT NOT
// SCHEDULED (owner: not everyone works in the CRM yet).
//
// Dependency-free on purpose (no Deno globals, no URL imports): vitest runs
// mexPush.test.ts against this file in Node, and index.ts imports it.
//
// THE CONTRACT. One parcel = exactly what the /orders "MEX Import CSV" would put in
// the MEX portal (src/lib/mexImportCsv.ts, the elyon-fulfilment-csv skill): the same
// name (Ime), address (Adresa, composeHomeAddress + the CSV sanitiser), zone (Grad →
// here its id, receiver_city_id), phone (Telefon), COD (Otkup = codFor: price € ×
// 61.5, rounded to 10 ден, a STRING of whole denars), Opis (delivery_instructions)
// and weight (Tezina 1). The formatting is PORTED below (Deno cannot resolve the
// app's `@/` imports) and mexPush.test.ts pins it to the CSV builder field by field.
// Ported from the naturatherapy.mk shop (D:\naturatherapy\storefront\src\lib\shipping\
// mex.ts / mex-send.ts, read-only): the add_shipment.php body, the existence check
// before every send, and the send-loop bookkeeping.
//
// MEX HAS NO CANCEL. Every order is claimed first (orders.mex_sent_at, UPDATE …
// WHERE mex_tracking_id IS NULL), then MEX is asked whether a parcel already exists
// under our order number (re-linked, never re-created), and only then created. A
// timeout after the create keeps the claim, so nothing re-sends it blind; the next
// attempt asks MEX first. The ledger (public.mex_push_attempts) allows ONE success
// per order.
// ============================================================================

export const MEX_API_BASE = "https://mex.mk/api/json";
/** MEX's Opis / instructions — they confirmed ~10 000 characters. */
export const MEX_OPIS_MAX_CHARS = 10_000;
/** Declared parcel weight in kg — the CSV's Tezina (MEX_IMPORT_WEIGHT_KG). Rates are flat. */
export const MEX_PUSH_WEIGHT_KG = 1;
/** The hard cap on one manual send (the shop's button; app_settings.mex_push.max_per_send ≤ this). */
export const MEX_PUSH_HARD_CAP = 50;
/** An unanswered claim older than this may be re-claimed (after asking MEX first). */
export const MEX_CLAIM_STALE_MINUTES = 15;
/** Stop starting new orders after this much wall time — the edge function has ~150 s. */
export const MEX_PUSH_TIME_BUDGET_MS = 100_000;
/** One MEX request never waits longer than this. */
export const MEX_REQUEST_TIMEOUT_MS = 20_000;
/** FROZEN — src/lib/currency.ts MKD_PER_EUR. Never "update" it. */
export const MKD_PER_EUR = 61.5;

export const MEX_ACCOUNTS = ["bio_natural", "natura"] as const;
export type MexAccount = typeof MEX_ACCOUNTS[number];
export const isMexAccount = (v: unknown): v is MexAccount => v === "bio_natural" || v === "natura";

// ── settings (app_settings.mex_push) ───────────────────────────────────────────

export interface MexPushSettings {
  enabled: boolean;
  accounts: Record<MexAccount, boolean>;
  /** "HH:MM" Skopje for the auto-send; null = never. Built, NOT scheduled. */
  auto_send_at: string | null;
  max_per_send: number;
}

export const MEX_PUSH_DEFAULTS: MexPushSettings = {
  enabled: false,
  accounts: { bio_natural: false, natura: false },
  auto_send_at: null,
  max_per_send: MEX_PUSH_HARD_CAP,
};

/** app_settings.mex_push → settings. Anything missing or malformed reads as OFF. */
export function readMexPushSettings(value: unknown): MexPushSettings {
  const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const acc = (v.accounts && typeof v.accounts === "object" ? v.accounts : {}) as Record<string, unknown>;
  const max = Math.trunc(Number(v.max_per_send));
  const at = typeof v.auto_send_at === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v.auto_send_at) ? v.auto_send_at : null;
  return {
    enabled: v.enabled === true,
    accounts: { bio_natural: acc.bio_natural === true, natura: acc.natura === true },
    auto_send_at: at,
    max_per_send: Number.isFinite(max) && max >= 1 ? Math.min(max, MEX_PUSH_HARD_CAP) : MEX_PUSH_HARD_CAP,
  };
}

/** May this account be sent to right now? */
export function accountOpen(s: MexPushSettings, account: MexAccount): boolean {
  return s.enabled && s.accounts[account] === true;
}

/** PATCH body of the admin switch → the new settings, or an error code. */
export function applySettingsPatch(
  cur: MexPushSettings, body: unknown,
): { ok: true; settings: MexPushSettings } | { ok: false; error: string } {
  const b = (body && typeof body === "object" ? body : null) as Record<string, unknown> | null;
  if (!b) return { ok: false, error: "invalid_body" };
  const next: MexPushSettings = { ...cur, accounts: { ...cur.accounts } };
  let touched = false;
  if ("enabled" in b) {
    if (typeof b.enabled !== "boolean") return { ok: false, error: "invalid_enabled" };
    next.enabled = b.enabled; touched = true;
  }
  if ("accounts" in b) {
    const a = b.accounts as Record<string, unknown> | null;
    if (!a || typeof a !== "object") return { ok: false, error: "invalid_accounts" };
    for (const [k, val] of Object.entries(a)) {
      if (!isMexAccount(k) || typeof val !== "boolean") return { ok: false, error: "invalid_accounts" };
      next.accounts[k] = val; touched = true;
    }
  }
  if ("max_per_send" in b) {
    const n = Math.trunc(Number(b.max_per_send));
    if (!Number.isFinite(n) || n < 1 || n > MEX_PUSH_HARD_CAP) return { ok: false, error: "invalid_max_per_send" };
    next.max_per_send = n; touched = true;
  }
  if ("auto_send_at" in b) {
    // The auto-send is built but NOT scheduled (owner 30.09): the time is stored, nothing reads it.
    if (b.auto_send_at !== null && !(typeof b.auto_send_at === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(b.auto_send_at))) {
      return { ok: false, error: "invalid_auto_send_at" };
    }
    next.auto_send_at = (b.auto_send_at as string | null); touched = true;
  }
  if (!touched) return { ok: false, error: "nothing_to_change" };
  return { ok: true, settings: next };
}

// ── the CSV contract, ported (src/lib/transliterate.ts · address.ts · mexImportCsv.ts · currency.ts) ──

const CYR_TO_LAT: Record<string, string> = {
  "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ж": "zh", "з": "z", "и": "i",
  "й": "y", "к": "k", "л": "l", "м": "m", "н": "n", "о": "o", "п": "p", "р": "r", "с": "s",
  "т": "t", "у": "u", "ф": "f", "х": "h", "ц": "ts", "ч": "ch", "ш": "sh", "щ": "sht",
  "ъ": "a", "ь": "y", "ю": "yu", "я": "ya",
  "А": "A", "Б": "B", "В": "V", "Г": "G", "Д": "D", "Е": "E", "Ж": "Zh", "З": "Z", "И": "I",
  "Й": "Y", "К": "K", "Л": "L", "М": "M", "Н": "N", "О": "O", "П": "P", "Р": "R", "С": "S",
  "Т": "T", "У": "U", "Ф": "F", "Х": "H", "Ц": "Ts", "Ч": "Ch", "Ш": "Sh", "Щ": "Sht",
  "Ъ": "A", "Ь": "Y", "Ю": "Yu", "Я": "Ya",
  "ѓ": "gj", "ѕ": "dz", "ј": "j", "љ": "lj", "њ": "nj", "ќ": "kj", "џ": "dzh",
  "Ѓ": "Gj", "Ѕ": "Dz", "Ј": "J", "Љ": "Lj", "Њ": "Nj", "Ќ": "Kj", "Џ": "Dzh",
  "ѐ": "e", "ѝ": "i", "Ѐ": "E", "Ѝ": "I",
};

/** Port of src/lib/transliterate.ts transliterate() — keep in step (the test compares). */
export function transliterate(s: string): string {
  if (!s) return "";
  let out = String(s);
  out = out.replace(/СП/g, "SP").replace(/сп/g, "sp");
  return out.split("").map((c) => CYR_TO_LAT[c] ?? c).join("");
}

/** Port of mexImportCsv.ts `field`: Latin, single-line, no comma / quote / newline. */
export function csvField(s: unknown): string {
  return transliterate(String(s ?? ""))
    .replace(/[",\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * MEX's API cannot read UTF-8 (the shop found "????" echoed back), so what reaches
 * add_shipment.php is plain ASCII: diacritics folded (č → c), typographic dashes and
 * quotes to their ASCII forms, anything else non-printable dropped. A no-op on what
 * csvField() produces from Macedonian Cyrillic or plain Latin — so the parcel equals
 * the CSV cell for every normal order (pinned by the test).
 */
export function asciiFold(s: string): string {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u2018-\u201b]/g, "'")
    .replace(/[\u201c-\u201f\u00ab\u00bb]/g, '"')
    .replace(/\u2026/g, "...")
    .replace(/\u00a0/g, " ")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export interface HomeAddressParts {
  quarter?: string | null; street?: string | null; street_number?: string | null;
  block?: string | null; entry?: string | null; floor?: string | null; apartment?: string | null;
}
export interface ParsedHomeAddress {
  quarter: string; street: string; street_number: string; block: string; entry: string;
  floor: string; apartment: string; city: string; postal_code: string;
}

/** Port of src/lib/address.ts composeHomeAddress. */
export function composeHomeAddress(a: HomeAddressParts): string {
  const streetNo = [a.street, a.street_number && `бр. ${a.street_number}`].filter(Boolean).join(" ");
  return [
    a.quarter,
    streetNo,
    a.block && `згр. ${a.block}`,
    a.entry && `влез ${a.entry}`,
    a.floor && `кат ${a.floor}`,
    a.apartment && `стан ${a.apartment}`,
  ].filter(Boolean).join(", ");
}

const cleanAddr = (s?: string | null): string =>
  (s || "").replace(/[«»"„""]/g, "").replace(/\s+/g, " ").replace(/^[\s,;.-]+|[\s,;.-]+$/g, "").trim();

const TRAILING_NUMBER = /(?:№|No|бр|број|номер)?\.?\s*(\d+[А-Яа-яЀ-ӿA-Za-z]?)\s*$/i;

/** Port of src/lib/address.ts splitTrailingHouseNumber. */
export function splitTrailingHouseNumber<T extends HomeAddressParts>(parts: T): T {
  const street = (parts.street || "").trim();
  if (!street || (parts.street_number || "").trim()) return parts;
  const nm = street.match(TRAILING_NUMBER);
  if (nm && nm.index !== undefined && nm.index > 0) {
    return { ...parts, street: cleanAddr(street.slice(0, nm.index)), street_number: nm[1] };
  }
  return parts;
}

const PART_BOUNDARY =
  String.raw`(?=[,;]|\s+(?:с\.|село|гр\.|град|кв\.|ж\.?\s?к|квартал|нас\.|населба|н\.м\.|бл\.|блок|згр\.|зграда|ет\.|ап\.|вх\.|кат|стан|влез|вл\.|бр\.|број|общ\.|општ\.|општина|обл\.|\d{4})|$)`;

/** Port of src/lib/address.ts looksLikeCourier. */
export function looksLikeCourier(text?: string | null): boolean {
  return !!text && /(еконт|econt|спиди|speedy|мекс|mex|офис|автомат)/i.test(text);
}

/** Port of src/lib/address.ts parseHomeAddress. */
export function parseHomeAddress(blob?: string | null, city?: string | null): ParsedHomeAddress {
  const out: ParsedHomeAddress = {
    quarter: "", street: "", street_number: "", block: "", entry: "",
    floor: "", apartment: "", city: "", postal_code: "",
  };
  const providedCity = looksLikeCourier(city) ? "" : cleanAddr(city);
  if (providedCity) out.city = providedCity;

  const raw = cleanAddr(blob);
  if (!raw || looksLikeCourier(raw)) return out;

  let residue = ` ${raw} `;
  const grab = (re: RegExp, set: (m: RegExpMatchArray) => void): void => {
    const m = residue.match(re);
    if (m) { set(m); residue = residue.replace(m[0], " "); }
  };

  grab(/(?:^|[\s,])обл(?:аст)?\.?\s*[А-Яа-яA-Za-z. '-]+/i, () => {});
  grab(/(?:^|[\s,])сем(?:ейство)?\.?\s+[А-Яа-я][А-Яа-я-]+/i, () => {});
  grab(/(?<!\d)\d{4}(?!\d)/, (m) => { out.postal_code = m[0].trim(); });
  grab(/(?:^|[\s,(])бл\.?\s*(\d[0-9A-Za-zА-Яа-я]*)/i, (m) => { out.block = m[1]; });
  grab(/(?:^|[\s,(])вх\.?\s*(?:од)?\s*([0-9A-Za-zА-Яа-я]+)/i, (m) => { out.entry = m[1]; });
  grab(/(?:^|[\s,(])ет\.?\s*(?:аж)?\s*(\d+)/i, (m) => { out.floor = m[1]; });
  grab(/(?:^|[\s,(])ап\.?\s*(?:артамент)?\s*(\d+)/i, (m) => { out.apartment = m[1]; });
  grab(new RegExp(String.raw`(?:^|[\s,])((?:кв\.|ж\.?\s?к\.?|квартал)\s*[А-Яа-яA-Za-z0-9 .'-]+?)` + PART_BOUNDARY, "i"),
    (m) => { out.quarter = cleanAddr(m[1]); });
  if (!out.city) {
    grab(new RegExp(String.raw`(?:^|[\s,])(с\.\s*[А-Яа-яA-Za-z .'-]+?)` + PART_BOUNDARY, "i"),
      (m) => { out.city = cleanAddr(m[1]); });
    if (!out.city) {
      grab(new RegExp(String.raw`(?:^|[\s,])(гр\.\s*[А-Яа-яA-Za-z .'-]+?)` + PART_BOUNDARY, "i"),
        (m) => { out.city = cleanAddr(m[1]); });
    }
  } else {
    grab(new RegExp(String.raw`(?:^|[\s,])(?:с\.|гр\.)\s*[А-Яа-яA-Za-z .'-]+?` + PART_BOUNDARY, "i"), () => {});
  }
  grab(new RegExp(String.raw`((?:ул\.?|бул\.?|пл\.)\s*[А-Яа-яA-Za-z0-9 .№#'-]+?)` + PART_BOUNDARY, "i"),
    (m) => { out.street = cleanAddr(m[1]); });
  if (!out.street) {
    const rem = cleanAddr(residue);
    if (rem && /[А-Яа-яA-Za-z]/.test(rem)) out.street = rem;
  }
  return splitTrailingHouseNumber(out);
}

/** Port of src/lib/address.ts effectiveHomeParts. */
export function effectiveHomeParts(o: {
  street?: string | null; street_number?: string | null; quarter?: string | null;
  block?: string | null; entry?: string | null; floor?: string | null; apartment?: string | null;
  customer_address?: string | null; customer_city?: string | null; postal_code?: string | null;
}): ParsedHomeAddress {
  const hasStructured = !!(o.street || o.quarter || o.street_number || o.block);
  if (hasStructured) {
    const s = splitTrailingHouseNumber({
      street: o.street || "", street_number: o.street_number || "", quarter: o.quarter || "",
      block: o.block || "", entry: o.entry || "", floor: o.floor || "", apartment: o.apartment || "",
    });
    return {
      quarter: s.quarter || "", street: s.street || "", street_number: s.street_number || "",
      block: s.block || "", entry: s.entry || "", floor: s.floor || "", apartment: s.apartment || "",
      city: o.customer_city || "", postal_code: o.postal_code || "",
    };
  }
  return parseHomeAddress(o.customer_address, o.customer_city);
}

const OFFICE_TYPES = new Set(["speedy_office", "econt_office", "mex_office"]);

/** The order fields one parcel is built from (warehouse_order_facts). */
export interface PushOrder {
  id: string;
  display_id?: string | null;
  status?: string | null;
  customer_name?: string | null;
  customer_phone?: string | null;
  customer_address?: string | null;
  customer_city?: string | null;
  postal_code?: string | null;
  street?: string | null; street_number?: string | null; quarter?: string | null;
  block?: string | null; entry?: string | null; floor?: string | null; apartment?: string | null;
  delivery_type?: string | null;
  courier_office_code?: string | null; courier_office_name?: string | null; courier_office_city?: string | null;
  mex_city_id?: number | string | null;
  mex_city_name?: string | null;
  delivery_instructions?: string | null;
  ship_after_date?: string | null;
  price_eur?: number | string | null;
  product_name?: string | null;
  quantity?: number | null;
  items?: PushItem[] | null;
  department?: string | null;
  sale_source?: string | null;
  mex_tracking_id?: string | null;
  mex_sent_at?: string | null;
  test_phone?: boolean | null;
  seller_team?: string | null;
  sale_at?: string | null;
  unlinked_parcels?: Array<Record<string, unknown>> | null;
  other_parcels?: Array<Record<string, unknown>> | null;
  collabbox_docs?: Array<Record<string, unknown>> | null;
  no_parcel_rule?: { days?: number; cancel_after?: string } | null;
  [key: string]: unknown;
}

export interface PushItem {
  product_id?: string | null;
  product_name?: string | null;
  quantity?: number | null;
  brand_line?: string | null;
  /** mex_profile_for_line(brand_line), resolved in SQL when the function exists. */
  line_profile?: string | null;
}

/** Street-level address, exactly the CSV's Adresa (before the ASCII fold). */
export function addressLine(o: PushOrder): string {
  if (OFFICE_TYPES.has(String(o.delivery_type || ""))) {
    return [
      "Подигање:",
      o.courier_office_code && `#${o.courier_office_code}`,
      o.courier_office_name,
      o.courier_office_city,
    ].filter(Boolean).join(" ");
  }
  return composeHomeAddress(effectiveHomeParts(o)) || (o.customer_address || "");
}

/** Port of mexImportCsv.ts phoneNational: +389… → 0…, digits only (MEX "07xxxxxxx"). */
export function phoneNational(raw: string | null | undefined): string {
  let p = String(raw || "").replace(/[^\d+]/g, "");
  if (p.startsWith("+389")) p = "0" + p.slice(4);
  else if (p.startsWith("389")) p = "0" + p.slice(3);
  return p.replace(/\D/g, "");
}

/** Port of src/lib/currency.ts codFor(): € → whole denars at the FROZEN peg, rounded to 10. */
export function codMkd(eurPrice: number | string | null | undefined): number {
  const n = Number(eurPrice);
  const den = Number.isFinite(n) ? Math.round(n * MKD_PER_EUR) : 0;
  return Math.round(den / 10) * 10;
}

/** Split at the first space, like the shop: "Ана Марија Петрова" → Ana / Marija Petrova. */
export function splitName(full: string): { first_name: string; last_name: string } {
  const [first, ...rest] = full.trim().split(/\s+/);
  return { first_name: first || full || "-", last_name: rest.join(" ") || "-" };
}

/** add_shipment.php's body — every string ASCII, COD a string of whole denars. */
export interface MexShipmentPayload {
  tracking_id: string;
  sender_reference: string;
  first_name: string;
  last_name: string;
  receiver_phone: string;
  receiver_address?: string;
  receiver_city_id: number;
  cod: string;
  weight: number;
  instructions?: string;
}

/** The eight CSV cells this parcel equals (for the parity test and the dry-run preview). */
export interface CsvEquivalent {
  ime: string; adresa: string; grad: string; telefon: string; otkup: string; opis: string; tezina: string;
}

export function csvEquivalent(o: PushOrder): CsvEquivalent {
  const city = OFFICE_TYPES.has(String(o.delivery_type || "")) ? (o.courier_office_city || "") : (o.customer_city || "");
  return {
    ime: csvField(o.customer_name),
    adresa: csvField(addressLine(o)),
    grad: csvField(o.mex_city_name || city),
    telefon: phoneNational(o.customer_phone),
    otkup: String(codMkd(o.price_eur || 0)),
    opis: csvField(o.delivery_instructions),
    tezina: String(MEX_PUSH_WEIGHT_KG),
  };
}

/** Build add_shipment.php's body. Pure; call validateForPush() first. */
export function buildMexPayload(o: PushOrder): MexShipmentPayload {
  const csv = csvEquivalent(o);
  const name = asciiFold(csv.ime);
  const { first_name, last_name } = splitName(name);
  const address = asciiFold(csv.adresa);
  const opis = asciiFold(csv.opis).slice(0, MEX_OPIS_MAX_CHARS);
  const ref = String(o.display_id || "");
  const payload: MexShipmentPayload = {
    // MEX files the parcel under OUR reference (the shop's NTMK… and our CSV-era ORD-… parcels
    // came back with exactly this tracking id), so an order can never get a second one silently.
    tracking_id: ref,
    sender_reference: ref,
    first_name,
    last_name,
    receiver_phone: csv.telefon,
    receiver_city_id: Number(o.mex_city_id),
    cod: csv.otkup,
    weight: MEX_PUSH_WEIGHT_KG,
  };
  if (address) payload.receiver_address = address;
  if (opis) payload.instructions = opis;
  return payload;
}

// ── validation (the CSV's gate + the push's own) ────────────────────────────────

export type PushField =
  // src/lib/fulfilmentValidation.ts — the same codes, the same rules
  | "name" | "phone" | "postal_code" | "product" | "price" | "address" | "house_number" | "office" | "mex_city"
  // the push's own
  | "not_confirmed" | "has_parcel" | "web_order" | "test_phone" | "ship_later" | "no_reference";

const isValidPhone = (phone: string): boolean =>
  /^\+?\d{8,15}$/.test(phone.replace(/[^\d+]/g, "").replace(/(?!^)\+/g, ""));

function hasProduct(o: PushOrder): boolean {
  const items = Array.isArray(o.items) ? o.items : [];
  if (items.length > 0) {
    return items.some((i) => String(i?.product_name || "").trim() !== "" && (Number(i?.quantity) || 0) >= 1);
  }
  return String(o.product_name || "").trim() !== "" && (Number(o.quantity) || 0) >= 1;
}

/** Skopje's calendar day of `now`, YYYY-MM-DD. */
export function skopjeDay(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Skopje", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(now);
}

/**
 * Everything that keeps this order from becoming a parcel NOW. The first nine codes are
 * validateOrderForFulfilment's (the /orders CSV gate) with the same rules, so an order the
 * CSV would hold back is never pushed either.
 */
export function validateForPush(o: PushOrder, now: Date = new Date()): { ok: boolean; missing: PushField[] } {
  const missing: PushField[] = [];
  if (o.status && o.status !== "confirmed") missing.push("not_confirmed");
  if (o.mex_tracking_id) missing.push("has_parcel");
  if (o.department === "web" || o.sale_source === "web") missing.push("web_order");
  if (o.test_phone) missing.push("test_phone");
  if (!String(o.display_id || "").trim()) missing.push("no_reference");

  const name = String(o.customer_name || "").trim();
  if (!name || name.split(/\s+/).filter(Boolean).length < 2) missing.push("name");
  if (!isValidPhone(String(o.customer_phone || ""))) missing.push("phone");
  if (!/^\d{4}$/.test(String(o.postal_code || "").trim())) missing.push("postal_code");
  if (!(Number(o.mex_city_id) > 0)) missing.push("mex_city");
  if (!hasProduct(o)) missing.push("product");
  if (!(Number(o.price_eur) > 0)) missing.push("price");
  if (OFFICE_TYPES.has(String(o.delivery_type || ""))) {
    if (!String(o.courier_office_code || "").trim() || !String(o.courier_office_name || "").trim()
      || !String(o.courier_office_city || "").trim()) missing.push("office");
  } else {
    const p = effectiveHomeParts(o);
    if (!(p.street && p.street_number) && !(p.quarter && p.block)) {
      missing.push(p.street && !p.street_number ? "house_number" : "address");
    }
  }
  const after = String(o.ship_after_date || "").slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(after) && after > skopjeDay(now)) missing.push("ship_later");
  return { ok: missing.length === 0, missing };
}

// ── the MEX profile (account) ───────────────────────────────────────────────────

/** Mirror of public.mex_profile_for_line (20260943001300): the product line → the account. */
export function lineProfile(line: string | null | undefined): MexAccount | null {
  switch (line) {
    case "bio_natural": case "dr_becker": return "bio_natural";
    case "natura_therapy": case "ad_astra": return "natura";
    default: return null;
  }
}

/** The department's account (owner 29.09: BIO NATURAL = affiliate in/out, NATURA = teleshop/social/web). */
export function departmentProfile(dept: string | null | undefined): MexAccount | null {
  switch (dept) {
    case "altercpa": case "elyon_crm": return "bio_natural";
    case "teleshop_out": case "teleshop_other": case "social": return "natura";
    default: return null;   // web is never pushed; management (a seller's team, not a folder) and unknown decide nothing
  }
}

/** The seller's team → its line's account (owner 30.09: Телешоп via NATURA, Affiliate via BIO NATURAL).
 *  Secondary: it can only DISAGREE (→ a manual pick), never decide on its own. */
export function teamProfile(team: string | null | undefined): MexAccount | null {
  const t = String(team || "");
  if (t === "affiliate" || t === "altercpa_leads" || t.startsWith("affiliate:")) return "bio_natural";
  if (t === "teleshop" || t === "crm_prediction" || t.startsWith("teleshop:")) return "natura";
  return null;
}

export type AccountReason =
  | "mixed_basket" | "line_missing" | "line_partial" | "department_disagrees" | "team_disagrees"
  | "no_department_profile" | "web_order";

export interface AccountDecision {
  /** The suggestion (null = none possible: a mixed basket, a web order, nothing known). */
  account: MexAccount | null;
  basis: "product_line" | "department" | "none";
  line_profiles: MexAccount[];
  department_profile: MexAccount | null;
  team_profile: MexAccount | null;
  reasons: AccountReason[];
  /** A person must choose the account (with a reason) before this order may be sent. */
  needs_pick: boolean;
}

/**
 * Which MEX account sends this parcel (owner 30.09.2026, decisions 5): MAINLY THE PRODUCT
 * LINE — Bio Natural and Dr.Becker via BIO NATURAL, Natura Therapy and Ad Astra via NATURA;
 * the team is secondary. With no line on the products (20260943001300 not applied, or not
 * tagged yet) the order's department decides — and a person confirms it. A mixed basket, or
 * any disagreement between product line / department / seller team, is a warning plus a
 * manual pick with a reason (the exact mixed-basket rule is still the owner's to make).
 */
export function decideAccount(o: Pick<PushOrder, "items" | "department" | "seller_team" | "sale_source">): AccountDecision {
  const items = Array.isArray(o.items) ? o.items : [];
  const profiles = items.map((i) => (isMexAccount(i?.line_profile) ? i.line_profile : lineProfile(i?.brand_line)));
  const known = [...new Set(profiles.filter((p): p is MexAccount => p !== null))].sort();
  const unknown = profiles.filter((p) => p === null).length;
  const dep = departmentProfile(o.department);
  const team = teamProfile(o.seller_team);
  const reasons: AccountReason[] = [];
  const out = (account: MexAccount | null, basis: AccountDecision["basis"]): AccountDecision => ({
    account, basis, line_profiles: known, department_profile: dep, team_profile: team,
    reasons, needs_pick: reasons.length > 0 || account === null,
  });

  if (o.department === "web" || o.sale_source === "web") {
    reasons.push("web_order");
    return { ...out(null, "none"), needs_pick: false };   // never sent from the CRM — nothing to pick
  }
  if (known.length > 1) {
    reasons.push("mixed_basket");
    return out(null, "none");
  }
  if (known.length === 1) {
    const acc = known[0];
    if (unknown > 0) reasons.push("line_partial");
    if (dep && dep !== acc) reasons.push("department_disagrees");
    if (team && team !== acc) reasons.push("team_disagrees");
    return out(acc, "product_line");
  }
  reasons.push("line_missing");
  if (!dep) {
    reasons.push("no_department_profile");
    return out(null, "none");
  }
  if (team && team !== dep) reasons.push("team_disagrees");
  return out(dep, "department");
}

// ── the double-parcel guard ─────────────────────────────────────────────────────

export type PushWarning =
  | { code: "unlinked_parcel"; tracking_id: string; account?: string; created_at?: string; blocking: true }
  | { code: "collabbox_doc"; doc_number: string; doc_at?: string; type?: string; blocking: boolean }
  | { code: "other_parcel"; tracking_id: string; order_display_id?: string; created_at?: string; blocking: false }
  | { code: "sent_unconfirmed"; mex_sent_at: string; blocking: false }
  | { code: "last_attempt_failed"; error?: string; at?: string; blocking: false };

const DAY_MS = 86_400_000;

/**
 * Evidence that this sale may already have a parcel made elsewhere (MEX has no cancel):
 *   • an UNLINKED parcel on the same last-8 phone within 14 days of the sale — blocking;
 *   • a collabBox order document on the same phone from the day before the sale on —
 *     blocking (someone booked it there too); an older one (≤ 14 days) is only a hint;
 *   • a parcel on the same phone held by another order since the day before — a hint
 *     (a twin sale, or a genuine repeat purchase);
 *   • an unanswered earlier push (mex_sent_at without a parcel) — a hint; the push asks MEX
 *     before creating anything in any case.
 * A blocking one is overridden only by an explicit person decision with a reason.
 */
export function doubleParcelWarnings(o: PushOrder): PushWarning[] {
  const out: PushWarning[] = [];
  const saleMs = o.sale_at ? new Date(o.sale_at).getTime() : NaN;
  const since = (at: unknown, days: number) =>
    !Number.isFinite(saleMs) || (typeof at === "string" && new Date(at).getTime() >= saleMs - days * DAY_MS);
  for (const p of o.unlinked_parcels ?? []) {
    out.push({ code: "unlinked_parcel", tracking_id: String(p.tracking_id ?? ""), account: p.account as string | undefined,
      created_at: p.created_at as string | undefined, blocking: true });
  }
  for (const d of o.collabbox_docs ?? []) {
    out.push({ code: "collabbox_doc", doc_number: String(d.doc_number ?? ""), doc_at: d.doc_at as string | undefined,
      type: (d.doc_type_name ?? d.doc_type_id) as string | undefined, blocking: since(d.doc_at, 1) });
  }
  for (const p of o.other_parcels ?? []) {
    if (!since(p.created_at, 1)) continue;
    out.push({ code: "other_parcel", tracking_id: String(p.tracking_id ?? ""), order_display_id: p.order_display_id as string | undefined,
      created_at: p.created_at as string | undefined, blocking: false });
  }
  if (o.mex_sent_at && !o.mex_tracking_id) out.push({ code: "sent_unconfirmed", mex_sent_at: String(o.mex_sent_at), blocking: false });
  const la = o.last_attempt as { status?: string; error?: string; created_at?: string } | null | undefined;
  if (la && (la.status === "error" || la.status === "skipped")) {
    out.push({ code: "last_attempt_failed", error: la.error, at: la.created_at, blocking: false });
  }
  return out;
}

/** Days until the 10-day no-parcel rule cancels this AlterCPA approval (null = the rule does not apply). */
export function noParcelDaysLeft(o: PushOrder, now: Date = new Date()): number | null {
  const at = o.no_parcel_rule?.cancel_after;
  if (!at) return null;
  const ms = new Date(at).getTime() - now.getTime();
  return Number.isFinite(ms) ? Math.ceil(ms / DAY_MS) : null;
}

// ── one order, evaluated (the queue shows it, the push enforces it) ──────────────

export interface AccountOverride { account: MexAccount; reason: string; double_ok?: boolean }

export interface Evaluation {
  ok: boolean;
  /** The account this parcel goes to (the override, else the suggestion when no pick is needed). */
  account: MexAccount | null;
  decision: AccountDecision;
  missing: PushField[];
  warnings: PushWarning[];
  /** Why it cannot go now: validation codes + needs_pick / double_parcel_risk / bad_override. */
  blockers: string[];
  payload: MexShipmentPayload | null;
  csv: CsvEquivalent;
}

export const MIN_REASON_CHARS = 3;

export function evaluateOrder(o: PushOrder, override: AccountOverride | null | undefined, now: Date = new Date()): Evaluation {
  const v = validateForPush(o, now);
  const decision = decideAccount(o);
  const warnings = doubleParcelWarnings(o);
  const blockers: string[] = [...v.missing];
  let account: MexAccount | null = null;
  const reasonOk = !!override && String(override.reason || "").trim().length >= MIN_REASON_CHARS;
  if (override) {
    if (!isMexAccount(override.account) || !reasonOk) blockers.push("bad_override");
    else account = override.account;
  } else if (!decision.needs_pick) {
    account = decision.account;
  }
  if (!account && !blockers.includes("bad_override") && !v.missing.includes("web_order")) blockers.push("needs_pick");
  if (warnings.some((w) => w.blocking) && !(override?.double_ok === true && reasonOk)) blockers.push("double_parcel_risk");
  return {
    ok: blockers.length === 0,
    account,
    decision,
    missing: v.missing,
    warnings,
    blockers,
    payload: v.ok ? buildMexPayload(o) : null,
    csv: csvEquivalent(o),
  };
}

// ── request validation ──────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PushRequest {
  order_ids: string[];
  overrides: Record<string, AccountOverride>;
  dry_run: boolean;
}

export function parsePushBody(body: unknown, cap: number = MEX_PUSH_HARD_CAP): { ok: true; req: PushRequest } | { ok: false; error: string } {
  const b = (body && typeof body === "object" ? body : null) as Record<string, unknown> | null;
  if (!b) return { ok: false, error: "invalid_body" };
  if (!Array.isArray(b.order_ids) || b.order_ids.length === 0) return { ok: false, error: "order_ids_required" };
  const ids = [...new Set(b.order_ids.map((x) => String(x)))];
  if (ids.some((x) => !UUID_RE.test(x))) return { ok: false, error: "invalid_order_id" };
  if (ids.length > Math.min(cap, MEX_PUSH_HARD_CAP)) return { ok: false, error: "too_many_orders" };
  const overrides: Record<string, AccountOverride> = {};
  const raw = b.account_overrides;
  if (raw !== undefined && raw !== null) {
    if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "invalid_account_overrides" };
    for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!ids.includes(id)) continue;
      const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
      if (!isMexAccount(o.account)) return { ok: false, error: "invalid_override_account" };
      const reason = String(o.reason ?? "").trim();
      if (reason.length < MIN_REASON_CHARS) return { ok: false, error: "override_reason_required" };
      overrides[id] = { account: o.account, reason: reason.slice(0, 500), double_ok: o.double_ok === true };
    }
  }
  return { ok: true, req: { order_ids: ids, overrides, dry_run: b.dry_run === true } };
}

// ── the MEX client (fetch injected) ─────────────────────────────────────────────

export class MexNotConfiguredError extends Error {
  constructor(public account: MexAccount) { super(`MEX ${account}: no API key`); }
}
/** The request may or may not have reached MEX (timeout, network, a non-JSON body). */
export class MexUnknownOutcomeError extends Error {}

export interface MexStatusReply { success?: number; tracking_id?: string; current_status_id?: string | number; current_status_name?: string; error?: string | null }
export interface MexAddReply { success?: number; tracking_id?: string; error?: string | null; response_msg?: string }

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) =>
  Promise<{ status: number; text(): Promise<string> }>;

export interface MexClient {
  hasKey(account: MexAccount): boolean;
  status(account: MexAccount, trackingId: string): Promise<MexStatusReply>;
  statusByRef(account: MexAccount, ref: string): Promise<MexStatusReply>;
  addShipment(account: MexAccount, payload: MexShipmentPayload): Promise<MexAddReply>;
}

export function createMexClient(opts: {
  keys: Partial<Record<MexAccount, string | undefined>>;
  fetch: FetchLike;
  timeoutMs?: number;
  base?: string;
}): MexClient {
  const base = opts.base ?? MEX_API_BASE;
  const call = async <T>(account: MexAccount, path: string, init: { method?: string; query?: Record<string, string>; body?: unknown }): Promise<T> => {
    const key = opts.keys[account];
    if (!key) throw new MexNotConfiguredError(account);
    const qs = init.query ? "?" + new URLSearchParams(init.query).toString() : "";
    let res: { status: number; text(): Promise<string> };
    try {
      const signal = typeof AbortSignal !== "undefined" && "timeout" in AbortSignal
        ? (AbortSignal as unknown as { timeout(ms: number): AbortSignal }).timeout(opts.timeoutMs ?? MEX_REQUEST_TIMEOUT_MS)
        : undefined;
      res = await opts.fetch(`${base}/${path}${qs}`, {
        method: init.method ?? "GET",
        headers: { AuthKey: key, ...(init.body ? { "Content-Type": "application/json" } : {}) },
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal,
      });
    } catch (e) {
      throw new MexUnknownOutcomeError(`MEX ${path}: ${(e as Error)?.message || "network error"}`);
    }
    const text = await res.text();
    if (res.status === 401 || res.status === 403) throw new MexNotConfiguredError(account);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new MexUnknownOutcomeError(`MEX ${path}: non-JSON reply (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }
  };
  return {
    hasKey: (a) => !!opts.keys[a],
    status: (a, id) => call<MexStatusReply>(a, "get_shipment_status.php", { query: { tracking_id: id } }),
    statusByRef: (a, ref) => call<MexStatusReply>(a, "get_shipment_status_by_ref.php", { query: { sender_reference: ref } }),
    addShipment: (a, payload) => call<MexAddReply>(a, "add_shipment.php", { method: "POST", body: payload }),
  };
}

/** `success: 1` with a status id = the parcel exists; `success: 0` ("No shipment found") = no. */
export function replyShowsParcel(r: MexStatusReply | null | undefined): boolean {
  return !!r && Number(r.success) === 1 && r.current_status_id !== undefined && r.current_status_id !== null && r.current_status_id !== "";
}

export interface ExistingParcel { tracking_id: string; status_id: number | null; status_name: string | null; probe: string }

/**
 * Does MEX already hold a parcel for this order on this account? Asked three ways: our
 * reference as the tracking id (how MEX files it), as the sender reference, and the CSV's
 * digits-only "Kod na pratka" (01234 for ORD-01234). Throws when MEX could not answer —
 * "could not ask" must never read as "does not exist".
 */
export async function findExistingParcel(client: MexClient, account: MexAccount, ref: string): Promise<ExistingParcel | null> {
  const digits = ref.replace(/\D/g, "");
  const probes: Array<[string, () => Promise<MexStatusReply>]> = [
    ["tracking_id", () => client.status(account, ref)],
    ["sender_reference", () => client.statusByRef(account, ref)],
  ];
  if (digits && digits !== ref) probes.push(["csv_code", () => client.status(account, digits)]);
  for (const [probe, run] of probes) {
    const r = await run();
    if (replyShowsParcel(r)) {
      const id = Number(r.current_status_id);
      return {
        tracking_id: String(r.tracking_id || (probe === "csv_code" ? digits : ref)),
        status_id: Number.isFinite(id) ? id : null,
        status_name: r.current_status_name ?? null,
        probe,
      };
    }
  }
  return null;
}

// ── stable request fingerprint (FNV-1a, dependency-free) ────────────────────────

export function stableJson(v: unknown): string {
  const norm = (x: unknown): unknown => Array.isArray(x) ? x.map(norm)
    : x && typeof x === "object" ? Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, norm((x as Record<string, unknown>)[k])])) : x;
  return JSON.stringify(norm(v));
}

export function requestHash(v: unknown): string {
  const s = stableJson(v);
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

/** "YYYY-MM-DD HH:MM:SS" in Skopje — how MEX writes its own timestamps (mex_parse_ts). */
export function skopjeStamp(d: Date): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Skopje", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour === "24" ? "00" : p.hour}:${p.minute}:${p.second}`;
}

// ── the send loop ───────────────────────────────────────────────────────────────

export type PushOutcome = "sent" | "exists_linked" | "skipped" | "error" | "unknown_outcome" | "not_claimed" | "deferred" | "dry_run";

export interface PushResult {
  order_id: string;
  display_id: string | null;
  outcome: PushOutcome;
  account: MexAccount | null;
  tracking_id?: string | null;
  reason?: string | null;
  blockers?: string[];
  warnings?: PushWarning[];
  decision?: AccountDecision;
  payload?: MexShipmentPayload | null;
  csv?: CsvEquivalent;
}

export interface RegisterHit { tracking_id: string; account: MexAccount; status_id: number | null; match: "ref" | "csv_code" }

export interface ClaimReply { claimed: boolean; reason?: string; claimed_at?: string; order?: PushOrder; tracking_id?: string }
export interface RecordArgs {
  order_id: string; claimed_at: string | null; account: MexAccount | null;
  status: "ok" | "exists_linked" | "error" | "skipped"; tracking_id: string | null;
  request: unknown; response: unknown; request_hash: string | null; error: string | null;
  parcel: Record<string, unknown> | null; release: boolean;
}
export interface RecordReply { status?: string; link?: string | null; error?: string | null; released?: boolean }

export interface PushDeps {
  settings: MexPushSettings;
  client: MexClient;
  /** warehouse_order_facts for a dry run (no claim). */
  facts(ids: string[]): Promise<PushOrder[]>;
  claim(orderId: string): Promise<ClaimReply>;
  record(args: RecordArgs): Promise<RecordReply>;
  /**
   * A parcel already in OUR register (both accounts, 15-minute sweep) for this order: under
   * its reference (match 'ref' — re-linked), or under the CSV's digits-only code on the same
   * last-8 phone (match 'csv_code' — the portal import made it; never created twice, and
   * left to the sweep's phone + COD link rather than guessed here).
   */
  registerLookup(ref: string, phone: string | null): Promise<RegisterHit | null>;
  now(): Date;
  budgetMs?: number;
}

/** The register row a fresh parcel starts with — list_shipments.php's shape; the next sweep replaces it. */
export function provisionalParcel(p: MexShipmentPayload, now: Date, trackingId: string, statusId = 8, statusName = "Shipment created"): Record<string, unknown> {
  return {
    tracking_id: trackingId,
    sender_reference: p.sender_reference,
    current_status_id: String(statusId),
    current_status_name: statusName,
    cod: p.cod,
    receiver_name: `${p.first_name} ${p.last_name}`.trim(),
    receiver_phone: p.receiver_phone,
    created_at: skopjeStamp(now),
    last_update_at: skopjeStamp(now),
    source: "crm_push",
  };
}

/**
 * Send (or dry-run) one request's orders. Every order on its own: one bad address never
 * stops the other forty-nine, and each result says exactly what happened to it.
 */
export async function runMexPush(req: PushRequest, deps: PushDeps): Promise<{ results: PushResult[]; stopped: string | null }> {
  const results: PushResult[] = [];
  const started = deps.now().getTime();
  const budget = deps.budgetMs ?? MEX_PUSH_TIME_BUDGET_MS;
  let stopped: string | null = null;

  if (req.dry_run) {
    const facts = await deps.facts(req.order_ids);
    const byId = new Map(facts.map((f) => [String(f.id), f]));
    for (const id of req.order_ids) {
      const o = byId.get(id);
      if (!o) { results.push({ order_id: id, display_id: null, outcome: "not_claimed", account: null, reason: "not_found" }); continue; }
      const ev = evaluateOrder(o, req.overrides[id], deps.now());
      const blockers = [...ev.blockers];
      if (ev.account && !accountOpen(deps.settings, ev.account)) blockers.push("account_disabled");
      if (ev.account && !deps.client.hasKey(ev.account)) blockers.push("account_not_configured");
      const reg = o.display_id ? await deps.registerLookup(String(o.display_id), (o.customer_phone as string) ?? null) : null;
      if (reg?.match === "csv_code") blockers.push("csv_parcel_exists");
      results.push({
        order_id: id, display_id: (o.display_id as string) ?? null, outcome: "dry_run", account: ev.account,
        tracking_id: reg?.tracking_id ?? null,
        reason: reg?.match === "ref" ? "exists_in_register" : reg?.match === "csv_code" ? "csv_parcel_exists" : null,
        blockers, warnings: ev.warnings, decision: ev.decision, payload: ev.payload, csv: ev.csv,
      });
    }
    return { results, stopped: null };
  }

  for (const id of req.order_ids) {
    if (stopped || deps.now().getTime() - started > budget) {
      stopped = stopped ?? "time_budget";
      results.push({ order_id: id, display_id: null, outcome: "deferred", account: null, reason: stopped });
      continue;
    }
    const claim = await deps.claim(id);
    if (!claim.claimed || !claim.order) {
      results.push({ order_id: id, display_id: null, outcome: "not_claimed", account: null, reason: claim.reason ?? "not_claimed",
        tracking_id: claim.tracking_id ?? null });
      continue;
    }
    const o = claim.order;
    const ref = String(o.display_id || "");
    const claimedAt = claim.claimed_at ?? null;
    const ev = evaluateOrder(o, req.overrides[id], deps.now());
    const base = { order_id: id, display_id: ref || null, account: ev.account, warnings: ev.warnings, decision: ev.decision, csv: ev.csv };
    const refuse = async (reason: string, blockers: string[]) => {
      await deps.record({ order_id: id, claimed_at: claimedAt, account: ev.account, status: "skipped", tracking_id: null,
        request: ev.payload, response: null, request_hash: ev.payload ? requestHash(ev.payload) : null,
        error: reason, parcel: null, release: true });
      results.push({ ...base, outcome: "skipped", reason, blockers });
    };
    if (!ev.ok || !ev.account || !ev.payload) { await refuse(ev.blockers.join(",") || "invalid", ev.blockers); continue; }
    const account = ev.account;
    if (!accountOpen(deps.settings, account)) { await refuse("account_disabled", ["account_disabled"]); continue; }
    if (!deps.client.hasKey(account)) { await refuse("account_not_configured", ["account_not_configured"]); continue; }
    const payload = ev.payload;
    const hash = requestHash(payload);

    // 1. our own register (both accounts, fed every 15 minutes) — no MEX call needed
    const reg = await deps.registerLookup(ref, (o.customer_phone as string) ?? null);
    if (reg?.match === "csv_code") {
      // The portal CSV import already made it (Kod na pratka = our digits). Never a second one;
      // the sweep links it by phone + COD.
      await deps.record({ order_id: id, claimed_at: claimedAt, account: reg.account, status: "skipped", tracking_id: null,
        request: payload, response: { register: reg.tracking_id }, request_hash: hash,
        error: `csv_parcel_exists: ${reg.tracking_id}`, parcel: null, release: true });
      results.push({ ...base, outcome: "skipped", reason: "csv_parcel_exists", tracking_id: reg.tracking_id, blockers: ["csv_parcel_exists"] });
      continue;
    }
    let existing: ExistingParcel | null = reg
      ? { tracking_id: reg.tracking_id, status_id: reg.status_id, status_name: null, probe: "register" }
      : null;
    const existingAccount: MexAccount = reg?.account ?? account;
    // 2. MEX itself, on the account we are about to use
    if (!existing) {
      try {
        existing = await findExistingParcel(deps.client, account, ref);
      } catch (e) {
        if (e instanceof MexNotConfiguredError) { stopped = "not_configured"; }
        await deps.record({ order_id: id, claimed_at: claimedAt, account, status: "error", tracking_id: null,
          request: payload, response: null, request_hash: hash,
          error: `existence_check_failed: ${(e as Error)?.message ?? e}`, parcel: null, release: true });
        results.push({ ...base, outcome: "error", reason: "existence_check_failed" });
        continue;
      }
      if (existing?.probe === "csv_code") {
        await deps.record({ order_id: id, claimed_at: claimedAt, account, status: "skipped", tracking_id: null,
          request: payload, response: { probe: "csv_code", tracking_id: existing.tracking_id }, request_hash: hash,
          error: `csv_parcel_exists: ${existing.tracking_id}`, parcel: null, release: true });
        results.push({ ...base, outcome: "skipped", reason: "csv_parcel_exists", tracking_id: existing.tracking_id, blockers: ["csv_parcel_exists"] });
        continue;
      }
    }
    if (existing) {
      const rec = await deps.record({ order_id: id, claimed_at: claimedAt, account: existingAccount, status: "exists_linked",
        tracking_id: existing.tracking_id, request: payload, response: { probe: existing.probe, status_id: existing.status_id },
        request_hash: hash, error: null,
        parcel: existing.probe === "register" ? null
          : { tracking_id: existing.tracking_id, sender_reference: ref,
              current_status_id: existing.status_id != null ? String(existing.status_id) : undefined,
              current_status_name: existing.status_name ?? undefined },
        release: false });
      const linkedOk = rec.status === "exists_linked" || rec.status === "duplicate_success";
      results.push({ ...base, account: existingAccount, outcome: linkedOk ? "exists_linked" : "error",
        tracking_id: existing.tracking_id, reason: linkedOk ? existing.probe : (rec.error ?? "link_failed") });
      continue;
    }

    // 3. create it
    let reply: MexAddReply;
    try {
      reply = await deps.client.addShipment(account, payload);
    } catch (e) {
      if (e instanceof MexNotConfiguredError) {
        stopped = "not_configured";
        await deps.record({ order_id: id, claimed_at: claimedAt, account, status: "error", tracking_id: null,
          request: payload, response: null, request_hash: hash, error: "mex_key_rejected", parcel: null, release: true });
        results.push({ ...base, outcome: "error", reason: "mex_key_rejected" });
        continue;
      }
      // It may exist now. Keep the claim: the next attempt (after 15 minutes) asks MEX first.
      await deps.record({ order_id: id, claimed_at: claimedAt, account, status: "error", tracking_id: null,
        request: payload, response: null, request_hash: hash,
        error: `unknown_outcome: ${(e as Error)?.message ?? e}`, parcel: null, release: false });
      results.push({ ...base, outcome: "unknown_outcome", reason: "unknown_outcome" });
      continue;
    }
    if (Number(reply?.success) !== 1 || !reply?.tracking_id) {
      const why = String(reply?.error || reply?.response_msg || "unknown error").slice(0, 300);
      await deps.record({ order_id: id, claimed_at: claimedAt, account, status: "error", tracking_id: null,
        request: payload, response: reply, request_hash: hash, error: `mex_refused: ${why}`, parcel: null, release: true });
      results.push({ ...base, outcome: "error", reason: `mex_refused: ${why}` });
      continue;
    }
    const tracking = String(reply.tracking_id);
    const rec = await deps.record({ order_id: id, claimed_at: claimedAt, account, status: "ok", tracking_id: tracking,
      request: payload, response: reply, request_hash: hash, error: null,
      parcel: provisionalParcel(payload, deps.now(), tracking), release: false });
    const ok = rec.status === "ok" || rec.status === "duplicate_success";
    // Not ok here = the parcel EXISTS at MEX but the CRM could not record / link it: the claim
    // stays, nothing re-sends it, and the warehouse is told to look in the MEX portal.
    results.push({ ...base, outcome: ok ? "sent" : "error", tracking_id: tracking,
      reason: ok ? null : `created_not_saved: ${rec.error ?? "record_failed"}` });
  }
  return { results, stopped };
}

/** One line per request for audit_log (order numbers and tracking ids only — never PII). */
export function pushAuditPayload(req: PushRequest, out: { results: PushResult[]; stopped: string | null }): Record<string, unknown> {
  const pick = (o: PushOutcome) => out.results.filter((r) => r.outcome === o);
  return {
    requested: req.order_ids.length,
    sent: pick("sent").map((r) => ({ order: r.display_id, tracking_id: r.tracking_id, account: r.account })),
    exists_linked: pick("exists_linked").map((r) => ({ order: r.display_id, tracking_id: r.tracking_id, account: r.account })),
    skipped: pick("skipped").map((r) => ({ order: r.display_id, reason: r.reason })),
    errors: [...pick("error"), ...pick("unknown_outcome")].map((r) => ({ order: r.display_id, reason: r.reason })),
    not_claimed: pick("not_claimed").map((r) => ({ order_id: r.order_id, reason: r.reason })),
    deferred: pick("deferred").length,
    overrides: Object.entries(req.overrides).map(([id, o]) => ({ order_id: id, account: o.account, reason: o.reason, double_ok: !!o.double_ok })),
    stopped: out.stopped,
  };
}

/** Money out for a non-owner: the COD in a payload / CSV preview is shown to owners only. */
export function stripPushMoney(r: PushResult): PushResult {
  const out: PushResult = { ...r };
  if (out.payload) out.payload = { ...out.payload, cod: "" };
  if (out.csv) out.csv = { ...out.csv, otkup: "" };
  return out;
}

// ── the 11:00 auto-send — BUILT, NOT SCHEDULED (owner 30.09.2026) ──────────────

export interface AutoSendPlan<T extends PushOrder> {
  toSend: Array<{ order: T; account: MexAccount }>;
  needsPick: T[];
  invalid: Array<{ order: T; missing: PushField[] }>;
  doubleParcel: T[];
  accountClosed: T[];
  unconfirmedEarlier: T[];
  truncated: boolean;
}

/**
 * What an unattended morning run would send: oldest sale first; only orders a person would
 * not have to decide anything about — valid, no manual pick, no double-parcel evidence, the
 * account switched on, no unanswered earlier push. Everything else is listed for a human.
 * Pure: the caller (a future cron) reads the queue, calls this, and feeds toSend to
 * runMexPush with no overrides. Deliberately nothing schedules it.
 */
export function mexAutoSendPlan<T extends PushOrder>(rows: T[], settings: MexPushSettings, now: Date = new Date(),
  max: number = settings.max_per_send): AutoSendPlan<T> {
  const plan: AutoSendPlan<T> = { toSend: [], needsPick: [], invalid: [], doubleParcel: [], accountClosed: [], unconfirmedEarlier: [], truncated: false };
  const cap = Math.max(0, Math.min(max, MEX_PUSH_HARD_CAP));
  const sorted = [...rows].sort((a, b) => String(a.sale_at ?? "").localeCompare(String(b.sale_at ?? "")));
  for (const o of sorted) {
    const ev = evaluateOrder(o, null, now);
    if (ev.missing.length) { plan.invalid.push({ order: o, missing: ev.missing }); continue; }
    if (o.mex_sent_at) { plan.unconfirmedEarlier.push(o); continue; }
    if (ev.warnings.some((w) => w.blocking)) { plan.doubleParcel.push(o); continue; }
    if (!ev.account || ev.decision.needs_pick) { plan.needsPick.push(o); continue; }
    if (!accountOpen(settings, ev.account)) { plan.accountClosed.push(o); continue; }
    if (plan.toSend.length >= cap) { plan.truncated = true; continue; }
    plan.toSend.push({ order: o, account: ev.account });
  }
  return plan;
}
