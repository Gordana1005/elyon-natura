/**
 * teleshop-customers — which collabBox komitenti on TELESHOP documents are real Macedonian
 * retail customers, under which phone, and whether the CRM already knows them.
 *
 * Pure: no network, no database, no files. The runner (scripts/build-teleshop-customers.mjs)
 * reads the registry, the header crawl and the CRM (SELECT only) and hands them in here; the
 * importer (scripts/import-teleshop-collabbox.mjs) consumes the result as
 * exports/teleshop/customers-clean.json through adaptCustomersClean().
 *
 * INPUTS
 *   komitenti   komitenti_full.csv rows (Sifra, VnatresenID, Ime, Ime_lat, Adresa, Grad, Drzava,
 *               Datum_raganje, Telefon, Mobilen, Email, Ziro_smetka, Broj_kartica, Danocen_broj,
 *               Faks, Lice_kontakt, DDV_broj, EMBS, Vraboten). Documents reference Sifra.
 *   docs        type_10036.csv / type_10050.csv rows (DocNumber, TipID, KomitentID, Iznos, Datum, Avtor).
 *   crm         one row per last-8 key of public.orders.customer_phone (p8, top_phone, n, last_name,
 *               names[], last_city, first_at, last_at, paid, trashed, wrong, cb, trash_reasons).
 *   profiles    public.customer_profiles (p8, phone, customer_name, city) — a phone known only here
 *               still counts as an existing customer.
 *   excludedPhone8s   public.report_excluded_phones (the owner's test numbers).
 *   settlements public.mk_settlements (name_norm, kind, id, parent_norm) → the mk_city_key twin.
 *
 * THE RULES (every one measured on the 2026-09-10 crawl; examples in the tests)
 *   Phones — strictly Macedonian. National significant number = 8 digits: 7X mobile, 2 Skopje,
 *     3[1-4] / 4[2-8] area codes. Accepted spellings: 07X XXX XXX, 0X XXX XXX, with or without
 *     +389 / 00389 / 389, spaces, dashes, slashes, dots, brackets; the 0 dropped (78666111); a
 *     letter O typed for the zero. Several numbers in one field are all kept. Everything else is
 *     REJECTED with its raw value and a reason — never rewritten into a fake +389 number (the
 *     trap normalizeMkPhone falls into; memory note feedback_normalizeMkPhone_is_a_rewriter).
 *     Placeholders: an all-zero subscriber part (070000000), eight equal digits, a 2-digit
 *     pattern (070707070), an ascending/descending run (070123456). Vanity numbers such as
 *     070333333 are real subscriptions — kept, flagged.
 *     Sources, in rank order: Мобилен, Телефон, Факс, Лице за контакт, the NAME (operators wrote
 *     numbers into it: "ЕЛКОВСКА ЕЛКА 071777222" while Телефон holds the truncated 07177722),
 *     the address ("БР ЗА КОНТАКТ 075444888"). phones[] is mobile first, then by source rank.
 *     The CUSTOMER phone is the first one the CRM already knows (so an existing customer is
 *     never split in two), else phones[0].
 *   Employees — Vraboten = Да is NOT an employee flag on the legacy register (Sifra < 40.000):
 *     30.125 of its 33.708 rows say Да, 26.221 of them in Skopje, the last one at Sifra 37.331,
 *     and 426 of them are long-standing teleshop buyers (one has 22 orders 2023–26).
 *     Above it Да is rare (170 rows) and real: operator accounts with Лице за контакт = their own
 *     name, "Mile Stoev", "Testoperator". An employee is: Да on the current register; "вработен/а"
 *     or a leading "ОПЕРАТОР" in the name; or an OPERATOR ACCOUNT — the name equals the Avtor
 *     who wrote ≥ 2 and ≥ half of its own documents (one operator: 35 of 41).
 *   Companies — a legal form anywhere (ДООЕЛ, ДОО, ДПТУ, АД, ТП, ЈЗУ, ПЗУ, ПУСЗ …), an
 *     institution word (аптека, фармација, хотел, дом за стари, автосервис …) unless it follows a
 *     location preposition ("поените се префрлени ВО продавница" is a person), or a real tax
 *     number / bank account / EMBS. Danocen_broj holding TEXT is an operator note ("НЕ ЈА
 *     БАРАЈТЕ"), not a tax number.
 *   Operator notes in the name (also read from Лице за контакт, Даночен број, Факс):
 *     deceased, do-not-contact (incl. dementia, "револтиран", "службен број"), wrong number,
 *     do-not-ship ("НЕ ПРАЌАЈ") → skip; "не звони од 14–17" is a CALL-TIME note, not a ban;
 *     "ВРАЌА НАРАЧКИ" → imported, flagged returns_orders; delivery hints → name_note.
 *     A ban written on one komitent covers every komitent on the same phone (phone_marked_*).
 *   Names — `name` is the person (HTML entities decoded, phones and notes lifted out, stray digit
 *     typos "МИЛИЦО0ВА" and glued "ДаниелаДаниелова" repaired, Latin look-alikes inside Cyrillic
 *     words fixed); `name_raw` keeps what was typed; `name_note` holds the lifted notes.
 *     Junk (a single letter, no letters, keyboard mash "сссддфф") and test names → skip.
 *   Dedupe — komitenti whose customer phone has the same last 8 digits are ONE customer:
 *     customer_name = the most complete, most recent name; every komitent id is listed.
 *   CRM — last-8 match against orders + customer_profiles → merge_existing, reusing the CRM's
 *     exact phone string (the segment engine keys on it); name/city agreement is reported.
 */
import { normalizeMkGeo } from './mk-translit.mjs';

export const RULES_VERSION = 'teleshop-customers v1 (2026-09-28)';
export const TELESHOP_DOC_TYPES = Object.freeze(['10036', '10050']);
export const TELESHOP_SERIES = Object.freeze(['9100', '9102']);
/** komitent Sifra below this = the legacy register, where Vraboten = Да is a stale default. */
export const LEGACY_REGISTER_BELOW = 40000;

// ─── text ────────────────────────────────────────────────────────────────────
const NAMED_ENTITIES = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
/** A registry value as written: HTML entities from the crawl decoded, whitespace collapsed. */
export function decodeText(raw) {
  let s = String(raw ?? '');
  const cp = (n) => (n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ' ');
  s = s.replace(/&#(\d+);/g, (_, n) => cp(Number(n)));
  s = s.replace(/&#x([0-9a-f]+);/gi, (_, n) => cp(parseInt(n, 16)));
  s = s.replace(/&([a-z]+);/gi, (m, n) => NAMED_ENTITIES[n.toLowerCase()] ?? m);
  return s.replace(/[\s ]+/g, ' ').trim();
}
const hasText = (v) => String(v ?? '').trim() !== '';

// ─── phones ──────────────────────────────────────────────────────────────────
export const MK_MOBILE_RE = /^7\d{7}$/;
export const MK_LANDLINE_RE = /^(?:2\d{7}|3[1-4]\d{6}|4[2-8]\d{6})$/;
/** Country calling codes, only to NAME a foreign number in the reject list. */
const FOREIGN_CC = [
  ['381', 'RS'], ['382', 'ME'], ['383', 'XK'], ['385', 'HR'], ['386', 'SI'], ['387', 'BA'], ['359', 'BG'],
  ['355', 'AL'], ['352', 'LU'], ['353', 'IE'], ['354', 'IS'], ['358', 'FI'], ['380', 'UA'], ['420', 'CZ'],
  ['421', 'SK'], ['30', 'GR'], ['31', 'NL'], ['32', 'BE'], ['33', 'FR'], ['34', 'ES'], ['36', 'HU'],
  ['39', 'IT'], ['40', 'RO'], ['41', 'CH'], ['43', 'AT'], ['44', 'GB'], ['45', 'DK'], ['46', 'SE'],
  ['47', 'NO'], ['48', 'PL'], ['49', 'DE'], ['61', 'AU'], ['90', 'TR'], ['1', 'US/CA'], ['7', 'RU/KZ'],
];
const ccOf = (d) => FOREIGN_CC.find(([cc]) => d.startsWith(cc))?.[1] ?? null;

/** Why an otherwise well-formed Macedonian number is a placeholder, or null. */
export function placeholderWhy(nsn) {
  const sub = nsn[0] === '2' ? nsn.slice(1) : nsn.slice(2);
  if (/^0+$/.test(sub)) return 'placeholder_zeros';
  if (/^(\d)\1{7}$/.test(nsn)) return 'placeholder_repeated';
  if (/^(\d\d)\1{3}$/.test(nsn)) return 'placeholder_pattern';
  if ('0123456789'.includes(sub) || '9876543210'.includes(sub)) return 'placeholder_sequence';
  return null;
}
/** A real subscription with a showy subscriber part (070333333) — kept, but worth a glance. */
export const isVanityNumber = (nsn) => /^(\d)\1+$/.test(nsn[0] === '2' ? nsn.slice(1) : nsn.slice(2));

/**
 * ONE number as typed → { ok, p8, e164, kind } or { ok: false, why, nsn? }.
 * p8 is the 8-digit national significant number (it is also the project's last-8 key).
 */
export function parseMkNumber(raw) {
  const text = String(raw ?? '').trim();
  const base = { raw: text };
  if (!text) return { ...base, ok: false, why: 'empty' };
  if (/\d[.,]?\d*e\+?\d/i.test(text)) return { ...base, ok: false, why: 'scientific' };
  let t = text;
  let letterO = false;
  if (/^[OoОо](?=[\d\s\-/.]*\d)/.test(t)) { t = '0' + t.slice(1); letterO = true; }
  let d = t.replace(/\D/g, '');
  if (!d) return { ...base, ok: false, why: 'no_digits' };
  const intl = t.startsWith('+') || (d.startsWith('00') && d.length >= 10);
  if (intl) {
    if (d.startsWith('00')) d = d.slice(2);
    if (!d.startsWith('389')) return { ...base, ok: false, why: 'foreign', country: ccOf(d) };
    d = d.slice(3);
    if (d.startsWith('0')) d = d.slice(1);
  } else if (d.startsWith('389') && (d.length === 11 || (d.length === 12 && d[3] === '0'))) {
    d = d.slice(3);
    if (d.startsWith('0')) d = d.slice(1);
  } else if (d.startsWith('0')) {
    d = d.slice(1);
  }
  if (d.length < 8) return { ...base, ok: false, why: 'too_short', nsn: d };
  if (d.length > 8) return { ...base, ok: false, why: 'too_long', nsn: d };
  const kind = MK_MOBILE_RE.test(d) ? 'mobile' : MK_LANDLINE_RE.test(d) ? 'landline' : null;
  if (!kind) return { ...base, ok: false, why: 'not_mk_range', nsn: d };
  const ph = placeholderWhy(d);
  if (ph) return { ...base, ok: false, why: ph, nsn: d };
  return { ...base, ok: true, p8: d, e164: `+389${d}`, kind, letter_o: letterO };
}

const digitCount = (s) => (String(s).match(/\d/g) || []).length;
/** Digit runs joined by in-number separators ("070/222-444", "+389 70 123 456", "(02) 3 123 456"). */
const CANDIDATE_RE = /(?:\+\s*)?(?:(?<![\p{L}\d])[OoОо](?=\d))?\d(?:[\d\s\-/.()]*\d)?/gu;

/**
 * Every phone-number attempt inside a text → { found: [parsed ok], rejects: [parsed not ok],
 * spans: [[start, end]] } (spans = where the numbers sit, so a name can be cleaned of them).
 *   freeText = false (Телефон / Мобилен): every digit run is an attempt, junk is rejected.
 *   freeText = true  (name, address, notes): only runs of ≥ 8 digits that start like a phone
 *                    (+, 0, 389, or a bare 7XXXXXXX) are attempts — "92 години", "бр.18а",
 *                    "КАРТИЧКА 044455" and "ОД 13ч-16ч" are left alone.
 */
export function extractPhones(text, { freeText = false } = {}) {
  const s = String(text ?? '');
  const found = [];
  const rejects = [];
  const spans = [];
  if (!s.trim()) return { found, rejects, spans };
  if (!freeText && !/\d/.test(s)) return { found, rejects: [{ raw: s.trim(), ok: false, why: 'no_digits' }], spans };
  for (const m of s.matchAll(CANDIDATE_RE)) {
    const cand = m[0].replace(/[\s\-/.(]+$/, '');
    const nd = digitCount(cand);
    if (freeText) {
      const lead = cand.replace(/^[OoОо]/, '0').replace(/[^\d+]/g, '');
      if (nd < 8 || !/^(\+|0|389|7\d{7}$)/.test(lead)) continue;
    }
    const start = m.index;
    const whole = parseMkNumber(cand);
    if (whole.ok) { found.push(whole); spans.push([start, start + cand.length]); continue; }
    // several numbers in one run ("070444777/ 032555888", "070555222 070666333"): greedy, left to right
    const pieces = cand.split(/(?<=\d)(?=[\s\-/.()]+(?:\+|\d))/).map((p) => p.replace(/^[\s\-/.()]+/, ''));
    let buf = '';
    const got = [];
    const left = [];
    for (const p of pieces) {
      if (buf && digitCount(buf + p) > 13) { left.push(buf); buf = ''; }
      buf = buf ? `${buf} ${p}` : p;
      const r = parseMkNumber(buf);
      if (r.ok) { got.push(r); buf = ''; }
    }
    if (buf) left.push(buf);
    if (got.length) {
      found.push(...got);
      spans.push([start, start + cand.length]);
      for (const l of left) if (digitCount(l) >= 3) rejects.push(parseMkNumber(l));
    } else {
      rejects.push(whole);
      if (freeText) spans.push([start, start + cand.length]);
    }
  }
  return { found, rejects, spans };
}

/** The registry fields a phone can hide in, in trust order. */
export const PHONE_SOURCES = Object.freeze([
  ['mobilen', 'Mobilen', false], ['telefon', 'Telefon', false], ['faks', 'Faks', true],
  ['lice_kontakt', 'Lice_kontakt', true], ['name', 'Ime', true], ['address', 'Adresa', true],
]);
const SOURCE_RANK = Object.fromEntries(PHONE_SOURCES.map(([k], i) => [k, i]));

/**
 * All phones of one komitent → { phones: [{ e164, p8, kind, source }] (mobile first, then source
 * rank, de-duplicated), rejects: [{ raw, field, why, country? , nsn? }] }.
 */
export function komitentPhones(k) {
  const all = [];
  const rejects = [];
  let order = 0;
  for (const [key, field, freeText] of PHONE_SOURCES) {
    const text = key === 'name' || key === 'address' ? decodeText(k?.[field]) : String(k?.[field] ?? '');
    if (!text.trim()) continue;
    const { found, rejects: rj } = extractPhones(text, { freeText });
    for (const f of found) all.push({ e164: f.e164, p8: f.p8, kind: f.kind, source: key, letter_o: f.letter_o || undefined, order: order++ });
    for (const r of rj) rejects.push({ raw: r.raw, field: key, why: r.why, ...(r.country ? { country: r.country } : {}), ...(r.nsn !== undefined ? { nsn: r.nsn } : {}) });
  }
  const seen = new Set();
  const phones = [];
  for (const p of all.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'mobile' ? -1 : 1) || SOURCE_RANK[a.source] - SOURCE_RANK[b.source] || a.order - b.order)) {
    if (seen.has(p.p8)) continue;
    seen.add(p.p8);
    const { order: _o, ...rest } = p;
    phones.push(rest);
  }
  return { phones, rejects };
}

// ─── operator notes & names ──────────────────────────────────────────────────
const NL = '(?<![\\p{L}])';           // start of a word
const NR = '(?![\\p{L}])';            // end of a word
const re = (src) => new RegExp(src, 'iu');

/** "не … контактирај / барај / звони / праќај" in all the spellings the crawl has. */
// "дане" only when glued before a particle ("ДАНЕ СЕ БАРА") — Дане is a common first name
const NEG = `${NL}(?:никако\\s+)?(?:да\\s+не|дане(?=\\s+(?:се|и|го|ја|ги)${NR})|н+\\s?е+)\\s+(?:(?:се|го|ја|ги|и|ѝ|им|му|нѐ|ни)\\s+)*`;
const NOTE_RULES = [
  ['deceased', re(`${NL}(?:му\\s+|и\\s+)?(?:почин|почнат|почиан|покоен|покојн|умре|pocin|pokojn|umre)`)],
  ['do_not_ship', re(`${NEG}(?:праќ|прак|прат|испраќ)`)],
  ['do_not_contact', re(`${NEG}(?:ко+н?т|кнот|бар|јав|звон|ѕвон|досаѓ|досаг|досаж|вознемир|сака)`)],
  ['do_not_contact', re(`${NL}(?:ne\\s+kontakt|da\\s+ne\\s+(?:se\\s+)?(?:kontakt|dosa|bara|zvon))`)],
  ['do_not_contact', re(`${NL}(?:деменц|дементн|револтиран|службен\\s+број|служебен\\s+број|не\\s+користи\\s+веќе)`)],
  // "несака да се контактира", "несакка да му звониме", "не сака да и се звони" (review 28.09: these were imported as names)
  ['do_not_contact', re(`${NL}не\\s*сак+а\\s+да\\s+(?:(?:се|и|ѝ|му|го|ја|ги|им|ни)\\s+)*(?:ко+н?т|звон|ѕвон|бар|јав)`)],
  ['do_not_contact', re(`${NL}нр?е+\\s*ко+нтак`)],
  ['wrong_number', re(`${NL}(?:(?:по|з)?грешен\\s+број|непостоечк|бројот\\s+е\\s+променет|променет\\s+број|не\\s+е\\s+(?:\\p{L}+\\s+){1,3}на\\s+(?:овој|тој|ова)\\s+(?:број|телефон)|ne\\s+e\\s+(?:\\p{L}+\\s+){1,3}na\\s+ovoj)`)],
];
/**
 * A "не звони" that only limits the HOURS ("ДА НЕ И СЕ ЗВОНИ ОД 14 - 17 ЧАСОТ") is not a ban.
 * An hour is required: "да не се контактира ОД операторите" is a ban.
 */
const CALL_WINDOW = /^.{0,30}?(?:(?<![\p{L}])(?:од|до|после|пред|помеѓу)\s*\d|\d{1,2}\s*(?:ч|:|-|часот)|(?<![\p{L}])(?:наутро|навечер|попладне|викенд)(?![\p{L}]))/iu;
export const RETURNS_RE = re(`${NL}(?:ги\\s+)?вра[ќк]+а+(?:ат)?${NR}|${NL}вра[ќк]+а+\\s+(?:\\p{L}+\\s+)?(?:нарачк|пратк)|${NL}не\\s+прима${NR}`);
const DELIVERY_RE = re(`${NL}(?:достав|dostav)|${NL}(?:после|пред)\\s+\\d|${NL}до\\s+\\d{1,2}\\s*(?:ч|час|:)|${NL}од\\s+\\d{1,2}\\s*(?:ч|-|:)`);

/**
 * Operator notes in a komitent: { markers: Set('deceased' | 'do_not_contact' | 'wrong_number' |
 * 'do_not_ship'), returns: bool, delivery: bool, call_window: bool }. `texts` = the name plus the
 * free-text fields operators used as a notepad.
 */
/** Split words glued by a missing space ("МенковскаВРАЌА", "ОЛИВЕРОВАнесака") so a glued note is still read. */
const unglue = (t) => t.replace(/(\p{Lu}\p{Ll}{2,})(?=\p{Lu}{2,})/gu, '$1 ').replace(/(\p{Lu}{3,})(?=\p{Ll}{3,})/gu, '$1 ');
export function readNotes(texts) {
  const markers = new Set();
  let callWindow = false;
  for (const raw of texts) {
    const s = unglue(decodeText(raw));
    if (!s) continue;
    for (const [key, rx] of NOTE_RULES) {
      const m = s.match(rx);
      if (!m) continue;
      if (key === 'do_not_contact' || key === 'do_not_ship') {
        // followed by an hour range → it says WHEN to call, not whether to
        const tail = s.slice(m.index + m[0].length).replace(/^\p{L}*/u, '');
        if (CALL_WINDOW.test(tail)) { callWindow = true; continue; }
      }
      markers.add(key);
    }
  }
  const joined = texts.map((t) => unglue(decodeText(t))).join(' | ');
  return { markers, returns: RETURNS_RE.test(joined), delivery: DELIVERY_RE.test(joined), call_window: callWindow };
}

/** Where a note starts inside a name — everything from here to the segment's end is the note. */
const NOTE_START = re([
  `${NL}(?:му\\s+|и\\s+)?(?:почин|почнат|почиан|покоен|покојн|умре|pocin|pokojn)`,
  `${NEG}`,
  `${NL}никако${NR}`,
  `${NL}(?:ne\\s+e|da\\s+ne|ne\\s+kontakt)${NR}`,
  `${NL}(?:\\p{L}+\\s+)?за\\s+достав`,
  `${NL}(?:достав|dostav)`,
  `${NL}(?:после|пред)\\s+\\d`,
  `${NL}(?:до|од)\\s+\\d{1,2}\\s*(?:ч|час|:|-|\\s)`,
  `${NL}(?:ги\\s+)?вра[ќк]+а+(?:ат)?${NR}`, `${NL}вра[ќк]+а+\\s`, `${NL}не\\s+прима${NR}`, `${NL}ретур`, `${NL}замена${NR}`,
  `${NL}не\\s*сак+а\\s+да${NR}`, `${NL}нр?е+\\s*ко+нтак`,
  `${NL}(?:деменц|дементн|револт|болест|болна|болен|инвалид|склероз|тешко\\s+подвиж|на\\s+операција)`,
  `${NL}(?:жената|човекот|сопругот|сопругата|татко\\s+му|мајка\\s+му|мајка\\s+и)${NR}`,
  `${NL}(?:мајка|татко|сопруг|сопруга|сопругот|сопругата|ќерка|ќерката|син|синот|сестра|брат|внук|внука|снаа|зет)\\s+на${NR}`,
  `${NL}(?:свекор|свекрва)${NR}`,
  `${NL}(?:службен|служебен)`, `${NL}непостоечк`, `${NL}(?:по|з)?грешен\\s+број`, `${NL}бројот${NR}`,
  `${NL}(?:картичка|поени|поените|префрлени)${NR}`,
  `${NL}вработен`, `${NL}\\d{1,3}\\s+години${NR}`,
  `${NL}(?:контакт|тел|моб|kontakt|tel)\\.?:?\\s*$`,
].join('|'));

const CYR = /[Ѐ-ӿ]/;
const LAT_TO_CYR = { A: 'А', B: 'В', C: 'С', E: 'Е', H: 'Н', K: 'К', M: 'М', O: 'О', P: 'Р', T: 'Т', X: 'Х', a: 'а', c: 'с', e: 'е', o: 'о', p: 'р', x: 'х', y: 'у', J: 'Ј', j: 'ј' };
/** "Mенка" (Latin M + Cyrillic) → "Менка": a Latin look-alike inside a Cyrillic word. */
function fixHomoglyphs(s) {
  let fixed = false;
  const out = s.replace(/[\p{L}]+/gu, (w) => {
    if (!CYR.test(w) || !/[A-Za-z]/.test(w)) return w;
    const letters = [...w];
    if (!letters.every((c) => CYR.test(c) || LAT_TO_CYR[c])) return w;
    fixed = true;
    return letters.map((c) => LAT_TO_CYR[c] ?? c).join('');
  });
  return { text: out, fixed };
}

const VOWELS = /[аеиоуѐѝaeiouy]/iu;
const SUFFIX_ONLY = /^(?:ски|ска|овски|овска|евски|евска|ски|иќ|ова|ева|ski|ska)$/iu;

/**
 * A komitent name → { name, name_raw, name_note, person_tokens, junk, weak, test, employee,
 * company, fixes[] }. `name` is the person only; notes and phones are lifted out.
 */
export function analyzeName(raw, { phoneSpans = null } = {}) {
  const name_raw = decodeText(raw);
  const fixes = [];
  let s = name_raw;
  // 1. phones out (they are kept in phones[]); a "контакт"/"тел" label next to one goes with it
  const { spans } = phoneSpans ? { spans: phoneSpans } : extractPhones(s, { freeText: true });
  if (spans.length) {
    let out = '';
    let at = 0;
    for (const [a, b] of spans) { out += s.slice(at, a) + ' '; at = b; }
    s = (out + s.slice(at)).replace(/\s+/g, ' ').trim();
    s = s.replace(/(?:\s+|^)(?:и|или|ili)[\s\-,;]*$/iu, '');
    s = s.replace(/(?<![\p{L}])(?:бр(?:ој)?\s+за\s+контакт|контакт|тел|моб|kontakt|tel)\.?:?[\s\-,;]*$/iu, '');
    s = s.replace(/\s+/g, ' ').trim();
    fixes.push('phone_removed');
  }
  // 2. Latin look-alikes inside Cyrillic words
  const hg = fixHomoglyphs(s);
  if (hg.fixed) { s = hg.text; fixes.push('homoglyph'); }
  // 3. a stray digit typed inside / at the end of a word. A 0 next to an О is an extra keystroke
  //    ("МИЛИЦО0ВА" → МИЛИЦОВА); a 0 between other letters stands for the О ("Гр0здевски" →
  //    Гроздевски); any other digit is dropped ("ПАВЛИ9НКА", "ТАШКОВ0", "ПЕТКОВСКИ9").
  const d1 = s
    .replace(/(?<=\p{L})0(?=\p{L})/gu, (_, at, str) => (/[оОoO]/.test(str[at - 1] + str[at + 1]) ? '' : (/\p{Lu}/u.test(str[at - 1]) && /\p{Lu}/u.test(str[at + 1]) ? 'О' : 'о')))
    .replace(/(?<=\p{L})[1-9](?=\p{L})/gu, '')
    .replace(/(?<=\p{L}{3})\d(?![\d\p{L}])/gu, '');
  if (d1 !== s) { s = d1; fixes.push('digit_typo'); }
  // 4. caps lock: "сОКРАТОВСКИ", "рОЗА И вАНЧО" → Сократовски, Роза, Ванчо
  const cl = s.replace(/(?<![\p{L}])\p{Ll}\p{Lu}{2,}(?![\p{L}])/gu, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
  if (cl !== s) { s = cl; fixes.push('caps_lock'); }
  // 5. two words glued: "ДаниелаДаниелова", "МенковскаВРАЌА" (never "БлаГа" / "ТОДаКОВСКИ")
  const g = s.replace(/(\p{Lu}\p{Ll}{2,})(?=\p{Lu}\p{Ll}{2,}|\p{Lu}{2,}(?![\p{Ll}]))/gu, '$1 ').replace(/(\p{Lu}{3,})(?=\p{Ll}{3,})/gu, '$1 ');
  if (g !== s) { s = g; fixes.push('glued_words'); }
  // 6. letters typed with spaces: "С Т Р А Ш О" → СТРАШО
  if (/^(?:\p{L}\s+){2,}\p{L}$/u.test(s)) { s = s.replace(/\s+/g, ''); fixes.push('spaced_letters'); }

  // 7. notes out: bracketed asides, "!!!"-separated shouts, and "… да не се контактира" tails
  const notes = [];
  let person = s.replace(/\(([^()]*)\)?/g, (_, inner) => { if (inner.trim()) notes.push(inner.trim()); return ' '; });
  const segs = person.split(/\s*(?:!+|\*+|\s[-–—]+\s|\s[-–—]+(?=\p{L})|(?<=\p{L})[-–—]+\s)\s*/u);
  const keep = [];
  for (const seg0 of segs) {
    const seg = seg0.trim();
    if (!seg) continue;
    const m = seg.match(NOTE_START);
    if (!m) { keep.push(seg); continue; }
    const head = seg.slice(0, m.index).replace(/[\s,;:.\-–—/]+$/u, '').trim();
    notes.push(seg.slice(m.index).trim());
    if (head) keep.push(head);
  }
  // a hyphen inside a double surname ("АЛИСОВСКА-МАРКОВСКА") never split the segment, so it survives
  person = keep.join(' ').replace(/(?<![\p{L}])(?:и|или)\s*$/iu, '').replace(/[\s,;:.\-/]+$/u, '').replace(/^[\s,;:.\-/]+/u, '').replace(/\s+/g, ' ').trim();

  const tokens = person.split(/[^\p{L}]+/u).filter(Boolean);
  const letters = tokens.join('');
  // junk: nothing left at all (and no note explains why), a lone letter, keyboard mash, "ааа"/"BB BB"
  const junk = person
    ? !tokens.some((t) => [...t].length >= 2)
      || (tokens.length === 1 && [...tokens[0]].length >= 5 && !VOWELS.test(tokens[0]))
      || ([...letters].length >= 3 && new Set([...letters.toLowerCase()]).size === 1)
    : notes.length === 0 && !spans.length;   // a name that was only a phone number is nameless, not junk
  const weak = !junk && !!person && (tokens.length === 1 || tokens.every((t) => SUFFIX_ONLY.test(t)));
  const test = /(?<![\p{L}])(?:test|тест|проба|пробна|probna)(?![\p{L}])|^\s*test/iu.test(name_raw);
  const employee = /вработен/iu.test(name_raw) || /^\s*оператор(?:ка)?(?![\p{L}])/iu.test(name_raw);
  return { name: person, name_raw, name_note: notes.join(' · '), person_tokens: tokens, junk, weak, test, employee, fixes };
}

// ─── companies ───────────────────────────────────────────────────────────────
const LEGAL_FORM_RE = /(?<![\p{L}])(?:дооел|доо|дпту|дпу|ад|тп|јзу|пзу|пусз|јп|ооу|соу|dooel|doo|dptu|jzu|pzu)(?![\p{L}])/iu;
const INSTITUTION_RE = /(?<![\p{L}])(?:аптека|apteka|фармација|фарм|pharm|маркет|market|супермаркет|продавница|хотел|hotel|ресторан|кафе|кафана|кафуле|салон|клиника|ординација|болница|дом\s+за\s+стари|геронтолошки|училиште|градинка|општина|фабрика|амбасада|завод|институт|здружение|фондација|комерц|трејд|трговија|автосервис|пекара|бутик)(?![\p{L}])/iu;
const LOCATION_BEFORE = /(?<![\p{L}])(?:во|до|кај|пред|спроти|зад|од|на|vo|do|kaj)\s+(?:\p{L}+\s+)?$/iu;
/** Not a person: { company: bool, why } — examples in the tests. */
export function companyVerdict(k, nameRaw) {
  const n = decodeText(nameRaw ?? k?.Ime);
  if (LEGAL_FORM_RE.test(n)) return { company: true, why: `legal form "${n.match(LEGAL_FORM_RE)[0]}"` };
  const m = n.match(INSTITUTION_RE);
  if (m && !LOCATION_BEFORE.test(n.slice(0, m.index)) && !/поени/iu.test(n)) return { company: true, why: `institution word "${m[0]}"` };
  if (digitCount(k?.Danocen_broj ?? '') >= 7) return { company: true, why: 'tax number (Даночен број)' };
  for (const f of ['Ziro_smetka', 'EMBS', 'DDV_broj']) if (digitCount(k?.[f] ?? '') >= 5) return { company: true, why: `${f} present` };
  return { company: false, why: null };
}

// ─── cities ──────────────────────────────────────────────────────────────────
const KIND_RANK = { city: 1, town: 2, city_district: 3 };
/** mk_settlements rows → the lookup mk_city_key() does (name_norm → folded key). */
export function buildCityIndex(settlements) {
  const idx = new Map();
  for (const s of settlements || []) {
    const cur = idx.get(s.name_norm);
    const rank = KIND_RANK[s.kind] ?? 4;
    if (!cur || rank < cur.rank || (rank === cur.rank && String(s.id) < String(cur.id))) {
      idx.set(s.name_norm, { rank, id: s.id, key: (s.kind === 'city_district' && s.parent_norm) ? s.parent_norm : s.name_norm });
    }
  }
  return idx;
}
/** JS twin of public.mk_city_key(raw): { key, known } (known = the place is in mk_settlements). */
export function cityKey(raw, index) {
  const s = decodeText(raw);
  if (!s) return { key: null, known: false };
  const full = normalizeMkGeo(s);
  const head = s.includes('-') ? normalizeMkGeo(s.split('-')[0]) : null;
  if (index) {
    if (index.has(full)) return { key: index.get(full).key, known: true };
    if (head && index.has(head)) return { key: index.get(head).key, known: true };
  }
  return { key: full || null, known: false };
}

// ─── name comparison ────────────────────────────────────────────────────────
const stem = (t) => (t.length >= 5 ? t.replace(/[aeiou]+$/, '') : t);
export function nameTokens(s) {
  return String(s ?? '').split(/[^\p{L}]+/u).map((t) => normalizeMkGeo(t)).filter((t) => t.length >= 2);
}
function levenshtein(a, b) {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
/** One name token ~ another: equal, or a typo apart (1 edit from 4 letters, 2 from 7). */
const tokenLike = (x, y) => {
  if (x === y) return true;
  const n = Math.min(x.length, y.length);
  return n >= 4 && levenshtein(x, y) <= (n >= 7 ? 2 : 1);
};
/**
 * 'same' | 'partial' (a shared first name or surname, either gender, typos allowed) | 'different'
 * | 'unknown'. Script-blind (Cyrillic, Latin, "kj"/"ќ" all fold through normalizeMkGeo) and
 * spacing-blind ("Vesnavesnovska" = "Весна Весновска").
 */
export function compareNames(a, b) {
  const A0 = nameTokens(a);
  const B0 = nameTokens(b);
  if (!A0.length || !B0.length) return 'unknown';
  if (A0.join('') === B0.join('') || A0.join('') === [...B0].reverse().join('')) return 'same';
  const A = A0.map(stem);
  const B = B0.map(stem);
  if (A.every((x) => B.some((y) => tokenLike(x, y))) && B.every((y) => A.some((x) => tokenLike(x, y)))) return 'same';
  if (A.some((x) => x.length >= 3 && B.some((y) => tokenLike(x, y)))) return 'partial';
  return 'different';
}

// ─── documents ───────────────────────────────────────────────────────────────
export function parseAmount(raw) {
  const s = String(raw ?? '').trim().replace(/\s/g, '');
  if (!s) return null;
  const n = Number(s.replace(/,(?=\d{3}(?:\D|$))/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}
/** "30.04.2023 17:07:23" → "2023-04-30" (a Skopje wall-clock day). */
export const docDay = (raw) => { const m = String(raw ?? '').match(/(\d{2})\.(\d{2})\.(\d{4})/); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
export const docSeries = (docNumber) => String(docNumber ?? '').split('-')[1] ?? '';
const fold = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

// ─── the verdict ─────────────────────────────────────────────────────────────
/** Skip reasons in precedence order: the first that applies is `reason`, all are in `reasons`. */
export const SKIP_REASONS = Object.freeze([
  'not_in_registry', 'employee', 'operator_account', 'company', 'test_name', 'deceased', 'do_not_contact',
  'wrong_number', 'do_not_ship', 'junk_name', 'owner_test_phone', 'no_valid_phone',
  'phone_marked_deceased', 'phone_marked_do_not_contact', 'phone_marked_do_not_ship',
  'phone_of_employee', 'no_teleshop_order_document',
]);
/**
 * A ban written on one komitent covers everyone on that phone: the note is about the person the
 * number reaches. "Wrong number" is NOT spread — it says the number does not reach THAT komitent,
 * and the other komitent on it may be its rightful owner (flagged phone_marked_wrong_number_elsewhere).
 */
const PROPAGATE = { deceased: 'phone_marked_deceased', do_not_contact: 'phone_marked_do_not_contact', do_not_ship: 'phone_marked_do_not_ship' };
const IDENTITY_SKIPS = new Set(['not_in_registry', 'employee', 'operator_account', 'company', 'test_name', 'junk_name']);

const toMap = (x, key) => (x instanceof Map ? x : new Map((x || []).map((r) => [String(r[key]).trim(), r])));

/**
 * The whole pass. Returns { rows, groups, stats }.
 *   rows   one per komitent on a teleshop document (10036 / 10050), sorted by komitent id.
 *   groups Map p8 → { p8, komitent_ids, canonical_komitent_id, customer_name, status, crm }.
 */
export function buildTeleshopCustomers({ komitenti, docs, crm = [], profiles = [], excludedPhone8s = [], settlements = null } = {}) {
  const reg = toMap(komitenti, 'Sifra');
  const crmBy8 = new Map((crm || []).map((r) => [String(r.p8), r]));
  const profBy8 = new Map();
  for (const p of profiles || []) { const k8 = String(p.p8 ?? String(p.phone ?? '').replace(/\D/g, '').slice(-8)); if (k8.length === 8 && !profBy8.has(k8)) profBy8.set(k8, p); }
  // a CRM phone with digits glued after a real number (+389706662220): last-8 cannot see it
  const crmPollutedTwin = new Map();
  for (const r of crm || []) {
    const m = String(r.top_phone ?? '').match(/^\+389(\d{9,})$/);
    if (m && MK_MOBILE_RE.test(m[1].slice(0, 8))) crmPollutedTwin.set(m[1].slice(0, 8), r.top_phone);
  }
  const excluded = new Set((excludedPhone8s || []).map(String));
  const cityIdx = settlements ? buildCityIndex(settlements) : null;

  // documents per komitent
  const byK = new Map();
  for (const d of docs || []) {
    const type = String(d.TipID ?? d.type_id ?? '').trim();
    if (!TELESHOP_DOC_TYPES.includes(type)) continue;
    const id = String(d.KomitentID ?? d.komitent_id ?? '').trim();
    if (!id) continue;
    const e = byK.get(id) ?? byK.set(id, { all: 0, teleshop: 0, valued: 0, value_mkd: 0, first: null, last: null, lastTeleshop: null, doc_names: new Map(), authors: new Map(), self: 0 }).get(id);
    const series = docSeries(d.DocNumber ?? d.doc_number);
    const amount = parseAmount(d.Iznos ?? d.amount) ?? 0;
    const day = docDay(d.Datum ?? d.date);
    const author = fold(d.Avtor ?? d.author);
    e.all++;
    if (TELESHOP_SERIES.includes(series)) {
      e.teleshop++;
      if (amount > 0) { e.valued++; e.value_mkd += amount; }
      if (day && (!e.lastTeleshop || day > e.lastTeleshop)) e.lastTeleshop = day;
    }
    if (day && (!e.first || day < e.first)) e.first = day;
    if (day && (!e.last || day > e.last)) e.last = day;
    const nm = decodeText(d.Komitent ?? d.komitent_name);
    if (nm) e.doc_names.set(nm, (e.doc_names.get(nm) || 0) + 1);
    if (author) e.authors.set(author, (e.authors.get(author) || 0) + 1);
  }

  // pass 1 — each komitent on its own
  const rows = [];
  for (const [id, e] of byK) {
    const k = reg.get(id) || null;
    const reasons = [];
    const flags = [];
    const docName = [...e.doc_names.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
    const rawName = k ? k.Ime : docName;
    const ph = k ? komitentPhones(k) : { phones: [], rejects: [] };
    const nameInfo = analyzeName(rawName);
    const notes = readNotes(k ? [k.Ime, k.Ime_lat, k.Lice_kontakt, k.Danocen_broj, k.Faks] : [docName]);
    const selfDocs = e.authors.get(fold(nameInfo.name_raw)) ?? 0;
    const isDa = !!k && String(k.Vraboten ?? '').trim() === 'Да';
    const legacy = !!k && Number(k.Sifra) < LEGACY_REGISTER_BELOW;

    if (!k) reasons.push('not_in_registry');
    if (nameInfo.employee || (isDa && !legacy)) reasons.push('employee');
    if (selfDocs >= 2 && selfDocs * 2 >= e.all) reasons.push('operator_account');
    const co = k ? companyVerdict(k, rawName) : { company: false };
    if (co.company) reasons.push('company');
    if (nameInfo.test) reasons.push('test_name');
    for (const mk of ['deceased', 'do_not_contact', 'wrong_number', 'do_not_ship']) if (notes.markers.has(mk)) reasons.push(mk);
    if (nameInfo.junk && !notes.markers.size) reasons.push('junk_name');
    const exclHit = [...ph.phones.map((p) => p.p8), ...ph.rejects.map((r) => r.nsn).filter(Boolean)].find((p) => excluded.has(p));
    const phones = ph.phones.filter((p) => !excluded.has(p.p8));
    if (exclHit && !phones.length) reasons.push('owner_test_phone');
    else if (exclHit) flags.push('owner_test_phone_also_listed');
    if (!phones.length && !exclHit) reasons.push('no_valid_phone');
    if (e.valued === 0) reasons.push('no_teleshop_order_document');

    if (isDa && legacy) flags.push('legacy_vraboten_da');
    if (selfDocs >= 1 && !reasons.includes('operator_account')) flags.push('name_matches_own_author');
    if (notes.returns) flags.push('returns_orders');
    if (notes.call_window) flags.push('call_time_note');
    if (notes.delivery) flags.push('delivery_note');
    if (nameInfo.weak) flags.push('weak_name');
    if (!nameInfo.name) flags.push('no_person_name');
    for (const f of nameInfo.fixes) flags.push(`name_${f}`);
    if (phones.some((p) => p.source !== 'mobilen' && p.source !== 'telefon')) flags.push('phone_from_notes');
    if (phones.length && phones[0].source !== 'mobilen' && phones[0].source !== 'telefon') flags.push('primary_phone_from_notes');
    if (phones.some((p) => p.letter_o)) flags.push('letter_o_for_zero');
    if (phones.some((p) => isVanityNumber(p.p8))) flags.push('vanity_number');
    if (ph.rejects.length && phones.length) flags.push('some_phone_rejected');
    for (let i = 0; i < phones.length; i++) for (let j = i + 1; j < phones.length; j++) {
      const a = phones[i].p8; const b = phones[j].p8;
      if ([...a].filter((c, x) => c !== b[x]).length === 1) flags.push('near_duplicate_phones');
    }
    const country = decodeText(k?.Drzava);
    const city = decodeText(k?.Grad);
    if ((country && country !== 'Македонија') || /странство/iu.test(city)) flags.push('foreign_address');

    // the customer phone: the first the CRM already knows (never split an existing customer), else phones[0]
    const known = phones.find((p) => crmBy8.has(p.p8) || profBy8.has(p.p8));
    const primary = known ?? phones[0] ?? null;
    if (known && known !== phones[0]) flags.push('primary_by_crm_match');

    const ck = cityKey(city, cityIdx);
    const birthday = (() => { const m = String(k?.Datum_raganje ?? '').match(/(\d{2})\.(\d{2})\.(\d{4})/); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; })();
    // operators used the spare text fields as a notepad ("Ime_lat": "да не се контактира")
    const extra_notes = [];
    const lat = decodeText(k?.Ime_lat);
    const latIsNote = !!lat && (CYR.test(lat) || NOTE_START.test(lat) || readNotes([lat]).markers.size > 0);
    if (latIsNote) extra_notes.push({ field: 'Ime_lat', text: lat });
    for (const f of ['Lice_kontakt', 'Faks', 'Danocen_broj']) {
      const t = decodeText(k?.[f]);
      if (!t || !/\p{L}/u.test(t)) continue;
      if (f === 'Lice_kontakt' && compareNames(t, nameInfo.name || nameInfo.name_raw) === 'same') continue;
      extra_notes.push({ field: f, text: t });
    }
    if (extra_notes.length) flags.push('notes_in_other_fields');
    rows.push({
      komitent_id: id, vnatresen_id: k?.VnatresenID ?? null,
      status: null, reason: null, reasons, flags: [...new Set(flags)],
      name: nameInfo.name || null, name_raw: nameInfo.name_raw, name_note: nameInfo.name_note || null,
      name_lat: latIsNote ? null : lat || null, extra_notes, customer_name: null,
      phones: phones.map((p) => p.e164), phone_sources: phones.map((p) => ({ e164: p.e164, kind: p.kind, field: p.source })),
      phone_e164: primary?.e164 ?? null, phone8: primary?.p8 ?? null, customer_phone: null,
      phone_rejects: ph.rejects,
      city: city || null, city_key: ck.key, city_known: ck.known,
      address: decodeText(k?.Adresa) || null, country: country || null, birthday,
      email: decodeText(k?.Email) || null,
      company_why: co.company ? co.why : null,
      docs: { total: e.all, teleshop: e.teleshop, valued: e.valued, value_mkd: Math.round(e.value_mkd * 100) / 100, first: e.first, last: e.last, self_authored: selfDocs },
      group: null, crm: null,
      _lastTeleshop: e.lastTeleshop, _sifra: Number(id) || 0, _person_tokens: nameInfo.person_tokens.length,
    });
  }

  // pass 2 — one customer per phone
  const groups = new Map();
  for (const r of rows) if (r.phone8) (groups.get(r.phone8) ?? groups.set(r.phone8, { p8: r.phone8, members: [] }).get(r.phone8)).members.push(r);
  for (const g of groups.values()) {
    const marks = new Set();
    for (const m of g.members) for (const mk of Object.keys(PROPAGATE)) if (m.reasons.includes(mk)) marks.add(mk);
    const employeePhone = g.members.some((m) => m.reasons.includes('employee') || m.reasons.includes('operator_account'));
    const wrongElsewhere = g.members.some((m) => m.reasons.includes('wrong_number'));
    for (const m of g.members) {
      for (const mk of marks) if (!m.reasons.includes(mk)) m.reasons.push(PROPAGATE[mk]);
      if (employeePhone && !m.reasons.includes('employee') && !m.reasons.includes('operator_account')) m.reasons.push('phone_of_employee');
      if (wrongElsewhere && !m.reasons.includes('wrong_number')) m.flags.push('phone_marked_wrong_number_elsewhere');
    }
    const live = g.members.filter((m) => !m.reasons.some((x) => IDENTITY_SKIPS.has(x)));
    const pick = (live.length ? live : g.members).slice().sort((a, b) =>
      (b.name && !b.flags.includes('weak_name') ? 1 : 0) - (a.name && !a.flags.includes('weak_name') ? 1 : 0)
      || Math.min(b._person_tokens, 3) - Math.min(a._person_tokens, 3)
      || String(b._lastTeleshop ?? b.docs.last ?? '').localeCompare(String(a._lastTeleshop ?? a.docs.last ?? ''))
      || b._sifra - a._sifra)[0];
    g.canonical = pick;
    const c = crmBy8.get(g.p8);
    const p = profBy8.get(g.p8);
    // CRM cities: AlterCPA's lead form defaults to "Skopje" (60 % of its orders say Skopje), so only
    // the courier's city (mex_city_name) and manual / collabBox orders are trusted to disagree.
    const clean = (arr) => (arr || []).map((x) => decodeText(x)).filter(Boolean);
    const trustedCities = [...clean(c?.cities_trusted), ...clean(c?.mex_cities), ...(p?.city && !c ? [decodeText(p.city)] : [])];
    const cpaCities = clean(c?.cities_cpa);
    g.crm = c || p ? {
      phone: c?.top_phone ?? p?.phone ?? null,
      canonical_phone: /^\+389\d{8}$/.test(String(c?.top_phone ?? p?.phone ?? '')),
      spellings: c?.n_spellings ?? (p ? 1 : 0),
      orders: c?.n ?? 0, paid: c?.paid ?? 0, trashed: c?.trashed ?? 0, trashed_wrong_person_or_number: c?.wrong ?? 0,
      collabbox_orders: c?.cb ?? 0, trash_reasons: c?.trash_reasons ?? null,
      name: c?.last_name ?? p?.customer_name ?? null, names: c?.names ?? (p?.customer_name ? [p.customer_name] : []),
      city: trustedCities[0] ?? cpaCities[0] ?? c?.last_city ?? p?.city ?? null,
      city_source: trustedCities.length ? 'trusted' : cpaCities.length ? 'altercpa_form' : null,
      trusted_keys: [...new Set(trustedCities.map((x) => cityKey(x, cityIdx).key).filter(Boolean))],
      cpa_keys: [...new Set(cpaCities.map((x) => cityKey(x, cityIdx).key).filter(Boolean))],
      first_at: c?.first_at ?? null, last_at: c?.last_at ?? null,
      profile_only: !c && !!p,
    } : null;
  }

  // pass 3 — status, names, CRM agreement
  for (const r of rows) r.reasons.sort((a, b) => SKIP_REASONS.indexOf(a) - SKIP_REASONS.indexOf(b));
  for (const g of groups.values()) g.live = g.members.filter((m) => !m.reasons.length).length;
  for (const r of rows) {
    const g = r.phone8 ? groups.get(r.phone8) : null;
    if (g) {
      r.group = {
        key: g.p8, size: g.members.length, komitent_ids: g.members.map((m) => m.komitent_id).sort((a, b) => Number(a) - Number(b)),
        canonical_komitent_id: g.canonical.komitent_id,
        names_agree: g.members.length < 2 ? null : g.members.every((m) => compareNames(m.name, g.canonical.name) === 'same') ? 'same'
          : g.members.every((m) => compareNames(m.name, g.canonical.name) !== 'different') ? 'partial' : 'different',
      };
      r.customer_name = g.canonical.name || null;
      if (g.crm) {
        const order = ['same', 'partial', 'different', 'unknown'];
        const bestName = [g.crm.name, ...(g.crm.names || [])].map((n) => compareNames(r.name, n)).sort((a, b) => order.indexOf(a) - order.indexOf(b))[0] ?? 'unknown';
        const { trusted_keys: tk, cpa_keys: ck2, ...crmOut } = g.crm;
        const cityMatch = !r.city_key ? 'unknown'
          : tk.includes(r.city_key) ? 'same'
            : tk.length ? 'different'
              : ck2.includes(r.city_key) ? 'same'
                : ck2.length ? 'altercpa_form_only' : 'unknown';
        r.crm = { ...crmOut, name_match: bestName, city_match: cityMatch };
        if (!g.crm.canonical_phone) r.flags.push('crm_phone_noncanonical');
        if (g.crm.trashed_wrong_person_or_number) r.flags.push('crm_trashed_wrong_person_or_number');
      }
      if (!r.name) r.name = r.customer_name || r.crm?.name || null;
    }
    const twin = r.phone8 ? crmPollutedTwin.get(r.phone8) : null;
    if (twin && !r.crm) { r.flags.push('crm_polluted_twin'); r.crm_polluted_twin = twin; }
    if (r.reasons.length) {
      r.status = 'skip';
      r.reason = r.reasons[0];
      r.customer_phone = null;
    } else if (r.crm) {
      r.status = 'merge_existing';
      r.reason = r.crm.profile_only ? 'existing_crm_profile' : 'existing_crm_customer';
      r.customer_phone = r.crm.phone;
    } else {
      r.status = 'import';
      r.reason = g && g.live > 1 ? 'new_customer_merged' : 'new_customer';
      r.customer_phone = r.phone_e164;
    }
    // a name that was ONLY an operator note ("Врака НАРАЧКИ", "нрееее контактуирај") stays nameless — a note never becomes a name
    if (!r.name && !r.name_note) r.name = r.name_raw || null;
    r.flags = [...new Set(r.flags)];
  }
  for (const r of rows) { delete r._lastTeleshop; delete r._sifra; delete r._person_tokens; }
  rows.sort((a, b) => Number(a.komitent_id) - Number(b.komitent_id));

  // the groups, as the importer / report sees them
  const outGroups = new Map();
  for (const g of groups.values()) {
    const live = g.members.filter((m) => m.status !== 'skip');
    outGroups.set(g.p8, {
      p8: g.p8, komitent_ids: g.members.map((m) => m.komitent_id), live_ids: live.map((m) => m.komitent_id),
      canonical_komitent_id: g.canonical.komitent_id, customer_name: g.canonical.name || null,
      status: live.length ? live[0].status : 'skip', crm: g.crm,
    });
  }
  return { rows, groups: outGroups, stats: summarize(rows, outGroups) };
}

/** Counts for the report. */
export function summarize(rows, groups) {
  const count = (f) => { const m = {}; for (const r of rows) { const k = f(r); if (k != null) m[k] = (m[k] || 0) + 1; } return m; };
  const live = rows.filter((r) => r.status !== 'skip');
  const liveGroups = [...groups.values()].filter((g) => g.live_ids.length);
  const flagCounts = {};
  for (const r of rows) for (const f of r.flags) flagCounts[f] = (flagCounts[f] || 0) + 1;
  const reasonAny = {};
  for (const r of rows) for (const x of r.reasons) reasonAny[x] = (reasonAny[x] || 0) + 1;
  const value = (arr) => Math.round(arr.reduce((s, r) => s + (r.docs.value_mkd || 0), 0));
  return {
    komitenti: rows.length,
    with_valid_phone: rows.filter((r) => r.phones.length).length,
    by_status: count((r) => r.status),
    by_reason: count((r) => r.reason),
    reasons_any: reasonAny,
    flags: flagCounts,
    customers: {
      total: liveGroups.length,
      new: liveGroups.filter((g) => g.status === 'import').length,
      existing: liveGroups.filter((g) => g.status === 'merge_existing').length,
      komitenti_folded: live.length - liveGroups.length,
      multi_komitent_customers: liveGroups.filter((g) => g.live_ids.length > 1).length,
    },
    skipped_value_mkd: Object.fromEntries(Object.entries(count((r) => (r.status === 'skip' ? r.reason : null))).map(([k]) => [k, value(rows.filter((r) => r.status === 'skip' && r.reason === k))])),
    existing_name_match: count((r) => (r.status === 'merge_existing' ? r.crm?.name_match : null)),
    existing_city_match: count((r) => (r.status === 'merge_existing' ? r.crm?.city_match : null)),
  };
}
