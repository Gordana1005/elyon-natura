/**
 * teleshop-import — the pure rules behind scripts/import-teleshop-collabbox.mjs.
 *
 * Nothing here touches the network or the database: every function is a pure transform of
 * the collabBox header crawl (C:\Users\Mile\collab_out\orders\type_<TipID>.csv), the komitent
 * registry (komitenti_full.csv) and rows the importer read from the MK database. Keeping the
 * rules here makes them reviewable in one place and testable in isolation.
 *
 * OWNER DECISIONS (Mile, 2026-09-28 — law; restated in the importer header):
 *   * TELESHOP = Нарачка in (10036) + Нарачка out (10050), series 9100 / 9102 → CRM orders.
 *     Social (10106), web (10112), LEADS (10111), LEADS-OUT (10114), stores → never orders.
 *   * Value 0 or parcel COD 0 = a replacement → not an order.
 *   * A parcel another order already holds → conflict, nothing is created.
 *   * collabBox never decides "paid" in the MEX era: the parcel does (2 → paid / 'mex',
 *     7 → returned, other → shipped). Before MEX coverage → paid / 'legacy_import'.
 *   * price EUR = Iznos / 61.5 (the FROZEN peg — never "update" it).
 */

/** FROZEN — src/lib/currency.ts. The denar is derived; never "update" this. */
export const MKD_PER_EUR = 61.5;

/** The two teleshop document types and the two teleshop series (either type may use either series). */
export const TELESHOP_TYPES = Object.freeze({ '10036': 'Нарачка in', '10050': 'Нарачка out' });
export const TELESHOP_SERIES = Object.freeze(['9100', '9102']);
/** What a non-teleshop series inside a teleshop type really is (never created here). */
export const SERIES_MEANING = Object.freeze({
  '9103': 'LEADS-OUT (ElyonCRM) series', '9110': 'LEADS (AlterCPA) series', '9108': 'social series',
  '9225': 'series 9225 (unknown)', 'ННП': 'store / internal series', 'НАА': 'store / internal series',
});

/**
 * MEX coverage: from this Skopje day on, 100 % of teleshop documents worth > 0 have a parcel
 * in mex_parcels (measured 28.09: 27.03 59 %, 28.03 72 %, 29.03 48 %, 30.03 → 100 % every day).
 * Before it, "no parcel" means "the register does not reach back", not "not shipped".
 */
export const MEX_COVERAGE_FROM = '2026-03-30';
/**
 * A MEX-era document with no parcel this many days after it was raised never shipped: 99,99 % of
 * teleshop parcels are registered 0–4 days after their document (measured 28.09 on 34.000
 * documents: +1 day 23.553, +2 2.647, +3 5.532, +4 1.138, later 4).
 */
export const NO_PARCEL_GRACE_DAYS = 7;
/** Constant product name for an order imported without line items (one product bucket, never a guess). */
export const NO_ITEMS_PRODUCT_NAME = 'collabBox: без ставки (непознат производ)';
export const DAY_MS = 86_400_000;

// ─── CSV ────────────────────────────────────────────────────────────────────
/** RFC-4180 CSV (quoted fields, doubled quotes, CRLF) → array of rows. */
export function parseCsv(text) {
  const rows = [];
  let row = [], cur = '', q = false;
  const s = String(text).replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c;
      continue;
    }
    if (c === '"') { q = true; continue; }
    if (c === ',') { row.push(cur); cur = ''; continue; }
    if (c === '\n') { row.push(cur.replace(/\r$/, '')); rows.push(row); row = []; cur = ''; continue; }
    cur += c;
  }
  if (cur || row.length) { row.push(cur.replace(/\r$/, '')); rows.push(row); }
  return rows;
}
/** CSV text → objects keyed by the header row (short rows are dropped, not guessed). */
export function csvObjects(text) {
  const rows = parseCsv(text);
  const h = rows.shift() || [];
  return rows.filter((r) => r.length >= h.length - 1 && r.some((x) => x !== ''))
    .map((r) => Object.fromEntries(h.map((k, i) => [k, r[i] ?? ''])));
}

// ─── money + dates ──────────────────────────────────────────────────────────
/** "2,000.00" / "1,234.50" → 2000 / 1234.5; "" → null (no amount is NOT zero). */
export function parseAmount(raw) {
  const t = String(raw ?? '').replace(/\s/g, '').replace(/,/g, '');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
export const eurFromMkd = (mkd) => Math.round((Number(mkd) / MKD_PER_EUR) * 100) / 100;

const SKOPJE_PARTS = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Skopje', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
function skopjeWall(ms) {
  const p = Object.fromEntries(SKOPJE_PARTS.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
}
/**
 * A Skopje wall-clock time → the UTC instant (DST-exact: CET +01:00 in winter, CEST +02:00 in
 * summer — the old importer's fixed +02:00 was an hour wrong from October to March).
 * In the autumn overlap the earlier (summer) instant is taken; a time inside the spring gap
 * is moved forward, as the clock was.
 */
export function skopjeToUtc(y, mo, d, h = 12, mi = 0, s = 0) {
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  let t = wall - 2 * 3_600_000;                       // start from CEST
  for (let i = 0; i < 3; i++) {
    const off = skopjeWall(t) - t;
    const next = wall - off;
    if (next === t) break;
    t = next;
  }
  return new Date(t);
}
/** "30.04.2023 17:07:23" (collabBox Datum, Skopje wall clock) → Date, or null. */
export function parseCbDatum(raw) {
  const m = String(raw ?? '').trim().match(/^(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return null;
  const [, d, mo, y, h, mi, s] = m;
  if (h === undefined) return skopjeToUtc(+y, +mo, +d, 12, 0, 0); // a date alone reads as 12:00 Skopje
  return skopjeToUtc(+y, +mo, +d, +h, +mi, +(s ?? 0));
}
/** "2026-09-25T20:17:03" (collabbox-fetch JSON, Skopje wall clock, no offset) → Date, or null. */
export function parseIsoLocal(raw) {
  const m = String(raw ?? '').trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  if (h === undefined) return skopjeToUtc(+y, +mo, +d, 12, 0, 0);
  return skopjeToUtc(+y, +mo, +d, +h, +mi, +(s ?? 0));
}
const SKOPJE_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Skopje', year: 'numeric', month: '2-digit', day: '2-digit' });
/** The Skopje calendar day (YYYY-MM-DD) of an instant. */
export const skopjeDay = (v) => (v == null || v === '' ? null : SKOPJE_DATE.format(new Date(v)));

// ─── documents ──────────────────────────────────────────────────────────────
export const DOC_NUMBER_RE = /^(\d{3})-(\d{4})-(\d+)\/(\d{4})$/;
export function docSeries(docNumber) {
  const m = String(docNumber ?? '').match(DOC_NUMBER_RE);
  if (m) return m[2];
  const parts = String(docNumber ?? '').split('-');
  return parts.length >= 2 ? parts[1] : null;
}

/** A header-crawl CSV row → the importer's document shape. */
export function docFromCsv(r, source = 'crawl') {
  const at = parseCbDatum(r.Datum);
  return {
    doc_number: String(r.DocNumber ?? '').trim(),
    doc_id: String(r.DocID ?? '').trim() || null,
    type_id: String(r.TipID ?? '').trim(),
    type_name: String(r.Tip ?? '').trim(),
    komitent_id: String(r.KomitentID ?? '').trim() || null,
    komitent_name: String(r.Komitent ?? '').trim(),
    amount_mkd: parseAmount(r.Iznos),
    currency: String(r.Valuta ?? '').trim(),
    doc_at: at ? at.toISOString() : null,
    datum_raw: String(r.Datum ?? '').trim(),
    author: authorOf(r.Avtor),
    source,
  };
}
/** A collabbox-fetch JSON header → the same shape (newer than the crawl; wins on conflict). */
export function docFromFetch(h, source = 'fetch') {
  const at = parseIsoLocal(h.datetime) ?? parseCbDatum(h.datetimeRaw);
  return {
    doc_number: String(h.docNumber ?? '').trim(),
    doc_id: h.docId ? String(h.docId) : null,
    type_id: String(h.typeId ?? '').trim(),
    type_name: String(h.typeName ?? '').trim(),
    komitent_id: h.customerId ? String(h.customerId).trim() : null,
    komitent_name: String(h.customerName ?? '').trim(),
    amount_mkd: typeof h.amount === 'number' ? h.amount : parseAmount(h.amount),
    currency: String(h.currency ?? '').trim(),
    doc_at: at ? at.toISOString() : null,
    datum_raw: String(h.datetimeRaw ?? h.datetime ?? '').trim(),
    author: authorOf(h.author),
    source,
  };
}
/**
 * The collabBox author exactly as collabBox spells it (only trimmed): the seller identities
 * (sales_person_identities kind collabbox_author) are keyed on that spelling, inner double
 * spaces included ("Анита  Анитевска"), and tg_orders_stamp_sold matches it verbatim.
 */
export const authorOf = (raw) => {
  const t = String(raw ?? '').trim();
  return t || null;
};

// ─── names ──────────────────────────────────────────────────────────────────
const ENTITIES = { '&#40;': '(', '&#41;': ')', '&amp;': '&', '&quot;': '"', '&#39;': "'", '&#34;': '"', '&lt;': '<', '&gt;': '>', '&nbsp;': ' ' };
/** A komitent name as written — HTML entities from the crawl decoded, whitespace collapsed, trimmed. */
export function cleanName(raw) {
  let s = String(raw ?? '');
  s = s.replace(/&#(\d+);/g, (m, n) => ENTITIES[m] ?? String.fromCodePoint(Number(n)));
  s = s.replace(/&[a-z]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m);
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * What an operator wrote INTO the customer name. These are not customers to import:
 * a dead person, someone who asked not to be called, a number that belongs to someone else,
 * a test record. (The CRM has no do-not-call flag, and the segment engine would put every
 * imported buyer into a calling list — so they are skipped and listed for the owner.)
 * 'returns_orders' ("ВРАЌА НАРАЧКИ") is a real customer: imported, only flagged.
 */
export const NAME_MARKERS = Object.freeze([
  ['deceased', /почин|почнат|почиан|умре|pocin|umre/iu],
  ['do_not_contact', /не\s*(го|ја|ги|и)?\s*(контакт|бара|барај|се\s+јав|јавува|звони|ѕвони)|да\s+не\s+се\s+контакт|ne\s+kontakt|блокира/iu],
  ['wrong_number', /(згрешен|погрешен|грешен)\s+број|wrong\s+number|непостоечки/iu],
  ['test', /(^|[^\p{L}])(тест|test|проба)([^\p{L}]|$)/iu],
]);
export const RETURNS_MARKER = /враќа\s+(нарачки|пратки)|ги\s+враќа|не\s+прима/iu;
export function nameMarker(name) {
  const n = cleanName(name);
  for (const [key, re] of NAME_MARKERS) if (re.test(n)) return key;
  return null;
}
/** Legal entities, shops and institutions — not retail customers. */
export const COMPANY_RE = /(ДООЕЛ|ДОО\b|\bАД\b|DOOEL|\bDOO\b|АПТЕКА|APTEKA|ПРОДАВНИЦА|МАРКЕТ|MARKET|\bТП\b|ЛИМАК|СИТИ\s*МОЛ|ФАРМАЦИЈА|PHARM|ОПШТИНА|БОЛНИЦА|ДОМ\s+ЗА\s+СТАРИ|ЗАВОД|КЛИНИКА|ОРДИНАЦИЈА|ХОТЕЛ|РЕСТОРАН|ЗДРУЖЕНИЕ|ФОНДАЦИЈА|УЧИЛИШТЕ|ГРАДИНКА|ПУСЗ|МЕДИ\s*ФАРМ)/iu;
/** Not a person: a company / store / institution by name, tax number or bank account. */
export function isCompany(k) {
  if (!k) return false;
  if (String(k.Danocen_broj ?? '').trim() || String(k.Ziro_smetka ?? '').trim()) return true;
  return COMPANY_RE.test(cleanName(k.Ime));
}

// ─── phones ─────────────────────────────────────────────────────────────────
/**
 * The Macedonian national significant number: 8 digits, mobile 7X, Skopje 2, the 3X / 4X area
 * codes in use (31–34, 42–48). Anything else is not provably Macedonian and is REJECTED —
 * never rewritten into a fake +389 number (normalizeMkPhone does that; see the memory note
 * feedback_normalizeMkPhone_is_a_rewriter).
 */
export const MK_NSN_RE = /^(7\d{7}|2\d{7}|3[1-4]\d{6}|4[2-8]\d{6})$/;

function onePhone(part) {
  const t = String(part).trim();
  let d = t.replace(/\D/g, '');
  if (!d) return { p8: null, why: 'empty' };
  if (t.startsWith('+') || d.startsWith('00')) {
    if (d.startsWith('00')) d = d.slice(2);
    if (!d.startsWith('389')) return { p8: null, why: 'foreign' };
    d = d.slice(3);
    if (d.startsWith('0')) d = d.slice(1);
  } else if (d.startsWith('389') && (d.length === 11 || d.length === 12)) {
    d = d.slice(3);
    if (d.startsWith('0')) d = d.slice(1);
  } else if (d.startsWith('0')) {
    d = d.slice(1);
  }
  if (d.length !== 8) return { p8: null, why: d.length < 8 ? 'too_short' : 'too_long' };
  if (!MK_NSN_RE.test(d)) return { p8: null, why: 'not_mk_range' };
  return { p8: d, kind: d.startsWith('7') ? 'mobile' : 'landline' };
}
/**
 * A phone as typed ("070/123-456", "071234567 или 072345678", "+389 70 123 456") → its 8
 * national digits, or { p8: null, why }. The first valid number of a list wins.
 */
export function mkPhone8(raw) {
  const s = String(raw ?? '').trim();
  if (!s || /^(null|nan|\/|-|0|x+)$/i.test(s)) return { p8: null, why: 'empty' };
  if (/e\+/i.test(s)) return { p8: null, why: 'scientific' };
  // one number typed with separators: "070/222-444", "075 111 333", "(02) 3 123 456"
  if (/^[\d\s\/\-.()+]+$/.test(s)) {
    const nd = s.replace(/\D/g, '').length;
    if (nd >= 8 && nd <= 12) { const w = onePhone(s); if (w.p8) return w; }
  }
  const parts = s.split(/\s*(?:[\/,;:]|(?<![\p{L}])(?:или|ИЛИ|ili|ILI)(?![\p{L}]))\s*/u).filter(Boolean);
  let firstWhy = null;
  for (const part of parts.length ? parts : [s]) {
    const r = onePhone(part);
    if (r.p8) return r;
    firstWhy ??= r.why;
  }
  // two numbers separated only by a space: "071234567 072345678"
  const groups = s.replace(/[^\d+ ]/g, ' ').split(/\s+/).filter((g) => g.replace(/\D/g, '').length >= 8);
  if (groups.length > 1) for (const g of groups) { const r = onePhone(g); if (r.p8) return r; }
  return { p8: null, why: firstWhy || 'invalid' };
}
/** The registry phone of a komitent: Мобилен first, then Телефон. */
export function komitentPhone(k) {
  if (!k) return { p8: null, why: 'no_komitent', field: null };
  const m = mkPhone8(k.Mobilen);
  if (m.p8) return { ...m, field: 'mobilen' };
  const t = mkPhone8(k.Telefon);
  if (t.p8) return { ...t, field: 'telefon' };
  const why = String(k.Mobilen ?? '').trim() && m.why !== 'empty' ? m.why : t.why;
  return { p8: null, why, field: null };
}
export const e164 = (p8) => (p8 ? `+389${p8}` : null);
export const CANONICAL_RE = /^\+389\d{8}$/;
/** Last 8 digits — the project's phone identity (idx_orders_phone_last8). */
export const last8 = (v) => String(v ?? '').replace(/\D/g, '').slice(-8);

// ─── MEX + the cohort's own buckets (mirrors of the SQL — keep in step) ─────
/** mex-reconcile's targetFor for a NEW order: 2 → paid, 7 → returned, anything else → shipped. */
export function statusFromParcel(p) {
  const s = Number(p.status_id);
  if (s === 2) {
    return { status: 'paid', paid_basis: 'mex', paid_at: p.delivered_at ?? p.last_update_at ?? p.created_at_mex, shipped_at: p.created_at_mex, returned_at: null };
  }
  if (s === 7) {
    return { status: 'returned', paid_basis: null, paid_at: null, shipped_at: p.created_at_mex, returned_at: p.returned_at ?? p.last_update_at ?? p.created_at_mex };
  }
  return { status: 'shipped', paid_basis: null, paid_at: null, shipped_at: p.created_at_mex, returned_at: null };
}
/** public.cohort_parcel_bucket */
export function cohortParcelBucket(statusId, cod) {
  if (!(Number(cod) > 0)) return 'replacement';
  const s = Number(statusId);
  if (s === 2) return 'paid';
  if (s === 7) return 'returned';
  if ([3, 9, 13].includes(s)) return 'courier_problem';
  if (s === 8) return 'label';
  return 'courier';
}
/** public.cohort_order_bucket for a row this importer creates (never 'disposition'). */
export function cohortOrderBucket({ status, price, paid_basis, source_type = 'import', tracking, mex_status_id, mex_cod_mkd, mex_delivered_at }) {
  if (tracking && (mex_status_id != null || mex_delivered_at)) {
    if (mex_cod_mkd != null && Number(mex_cod_mkd) <= 0) return 'replacement';
    if (mex_cod_mkd == null && !(Number(price) > 0)) return 'replacement';
    const s = mex_status_id == null ? null : Number(mex_status_id);
    if (s === 2 || (s == null && mex_delivered_at)) return 'paid';
    if (s === 7) return 'returned';
    if ([3, 9, 13].includes(s)) return 'courier_problem';
    if (s === 8) return 'label';
    return 'courier';
  }
  if (['paid', 'delivered', 'returned', 'shipped', 'confirmed'].includes(status) && !(Number(price) > 0)) return 'replacement';
  if (status === 'paid' || status === 'delivered') {
    return ['operator_ruling', 'legacy_import'].includes(paid_basis) || (paid_basis == null && source_type === 'import') ? 'paid_legacy' : 'paid_unproven';
  }
  if (status === 'returned') return 'returned';
  if (status === 'shipped') return 'courier';
  if (status === 'confirmed') return 'to_pack';
  return null;
}
export const cohortInTotal = (b) => ['paid', 'paid_unproven', 'paid_legacy', 'courier', 'courier_problem', 'label', 'to_pack', 'returned'].includes(b);

/** A COD fits a price: 'exact' (±3 ден), 'plus_delivery' (+150 ±3), or false (repair-kit rule). */
export function codFitsAmount(amountMkd, codMkd) {
  const a = Math.round(Number(amountMkd) || 0), c = Number(codMkd);
  if (!a || !Number.isFinite(c)) return false;
  if (Math.abs(c - a) <= 3) return 'exact';
  if (Math.abs(c - a - 150) <= 3) return 'plus_delivery';
  return false;
}

// ─── the segment engine, mirrored (engine v3.7-mk, recompute_customer_segments) ──
/**
 * Which lists ONE phone lands in, given all its orders — a line-by-line mirror of the live
 * public.recompute_customer_segments (engine v3.7-mk, 2026-08-06). Used ONLY to estimate the
 * blast radius read-only; the database engine stays the authority.
 * rows: [{ status, created_at (ms), price, source_type, trash_reason, trashed_at (ms|null) }]
 * → { target: list name | null, returns: bool, trash: bool, paid_count }
 */
export function engineClassify(rows, nowMs) {
  const live = rows.filter((r) => r.source_type !== 'monadon_legacy');
  if (!live.length) return { target: null, returns: false, trash: false, paid_count: 0, none: true };
  const newest = (xs) => xs.reduce((a, r) => (a == null || r.created_at > a.created_at ? r : a), null);
  const paid = live.filter((r) => r.status === 'paid');
  const lastPaid = newest(paid);
  const lastPaidAt = lastPaid?.created_at ?? null;
  const lastCancelled = newest(live.filter((r) => r.status === 'cancelled'));
  const lastReturned = newest(live.filter((r) => r.status === 'returned'));
  const newestIsReturn = !!lastReturned && !live.some((r) => r.created_at > lastReturned.created_at);
  let permAt = null, unreachAt = null;
  for (const r of live) {
    if (r.status !== 'trashed') continue;
    const at = r.trashed_at ?? r.created_at;
    if (r.trash_reason === 'not_reachable') { if (unreachAt == null || at > unreachAt) unreachAt = at; }
    else if (r.trash_reason !== 'duplicate_order') { if (permAt == null || at > permAt) permAt = at; }
  }
  const perm = permAt != null && (lastPaidAt == null || lastPaidAt <= permAt);
  const parked = !perm && unreachAt != null && nowMs - unreachAt < 21 * DAY_MS && (lastPaidAt == null || lastPaidAt <= unreachAt);
  const trash = perm || parked;
  const inflight = live.some((r) => ['pending', 'take', 'call_again', 'confirmed', 'shipped', 'delivered'].includes(r.status));
  const hasMonadon = rows.some((r) => r.source_type === 'monadon_legacy');
  const pc = paid.length;
  const freq = pc >= 7 ? '(7+ orders)' : pc >= 5 ? '(5+ orders)' : pc >= 3 ? '(3+ orders)' : '(1-3 orders)';
  let target = null;
  if (trash) target = null;
  else if (pc === 0 && inflight) target = null;
  else if (newestIsReturn && pc === 0) target = null;
  else if (!newestIsReturn && lastCancelled && (lastPaidAt == null || lastCancelled.created_at > lastPaidAt)
           && nowMs - lastCancelled.created_at < 14 * DAY_MS) target = 'Current Cancels';
  else if (pc === 0) {
    if (hasMonadon) target = null;
    else target = lastCancelled && (nowMs - lastCancelled.created_at) / DAY_MS <= 180 ? 'Never-Converted Recent' : 'Never-Converted Old';
  } else if (lastPaidAt != null) {
    const days = (nowMs - lastPaidAt) / DAY_MS;
    if (days < 21) target = `NEWCOMERS ${freq}`;
    else {
      const rec = days <= 57 ? '21d' : days <= 120 ? '57d' : days <= 180 ? '4-6m' : days <= 365 ? '6-12m' : days <= 730 ? '1-2yr' : '2yr+';
      const val = Number(lastPaid.price || 0) <= 26 ? '≤26' : '26+';
      target = `${rec} ${val} ${freq}`;
    }
  }
  return { target, returns: newestIsReturn && !trash, trash, perm, paid_count: pc };
}

// ─── inputs from the parallel helpers (consumed when present) ───────────────
/** Skip reasons that are a ban on calling the person → the ban family. */
export const BAN_FAMILY = Object.freeze({ deceased: 'deceased', phone_marked_deceased: 'deceased', do_not_contact: 'do_not_contact', phone_marked_do_not_contact: 'do_not_contact' });
/** Ban families --banned-as-trash IMPORTS (owner 28.09: deceased komitenti are never imported). */
export const BAN_IMPORTED = new Set(['do_not_contact']);
/**
 * The importer's verdict on a helper-A komitent: { skip, ban }.
 *   --vraboten-literal  also skips the legacy-register "Vraboten = Да" rows helper A imports
 *                       (flag legacy_vraboten_da) — default off: they are long-standing buyers.
 *   --banned-as-trash   imports do-not-contact komitenti (their phone then gets a trash marker);
 *                       deceased ones stay skipped.
 */
export function cleanSkip(clean, { vrabotenLiteral = false, bannedAsTrash = false } = {}) {
  let skip = clean.skip || null;
  if (!skip && vrabotenLiteral && (clean.flags || []).includes('legacy_vraboten_da')) skip = 'employee';
  const ban = BAN_FAMILY[skip] || null;
  if (ban && bannedAsTrash && BAN_IMPORTED.has(ban)) skip = null;
  return { skip, ban };
}
/**
 * exports/teleshop/customers-clean.json (helper A: scripts/lib/teleshop-customers.mjs) → Map
 * komitent_id → { p8, phone, match, skip, reason, name, city, address }. Tolerant of the shape
 * (an array, or { customers | komitenti | rows: [...] }, or an object keyed by komitent id) and
 * of the field names; refuses a file where no row has a komitent id (a wrong file must never
 * silently turn every customer into a skip).
 *   phone  = the exact CRM phone string to write (helper's merge with existing customers)
 *   skip   = null when the komitent is importable, else the reason (employee, company, …)
 */
export function adaptCustomersClean(json) {
  const rows = Array.isArray(json) ? json
    : Array.isArray(json?.customers) ? json.customers
    : Array.isArray(json?.komitenti) ? json.komitenti
    : Array.isArray(json?.rows) ? json.rows
    : json && typeof json === 'object' ? Object.entries(json.customers ?? json.komitenti ?? json).map(([k, v]) => ({ komitent_id: k, ...(v || {}) }))
    : [];
  const pick = (o, keys) => { for (const k of keys) if (o?.[k] !== undefined && o[k] !== null && o[k] !== '') return o[k]; return null; };
  const out = new Map();
  for (const r of rows) {
    const id = pick(r, ['komitent_id', 'komitentId', 'KomitentID', 'Sifra', 'sifra', 'id']);
    if (id == null) continue;
    // the order phone is ALWAYS a clean E.164: the helper's customer_phone when it is one, else its
    // phone_e164 — a malformed CRM spelling (+38938076222888) is never written onto a new order
    const rawCustomer = pick(r, ['customer_phone', 'crm_phone']);
    const e164Own = pick(r, ['phone_e164', 'e164']);
    const phone = rawCustomer && CANONICAL_RE.test(String(rawCustomer)) ? rawCustomer
      : e164Own && CANONICAL_RE.test(String(e164Own)) ? e164Own : pick(r, ['phone']);
    let p8 = pick(r, ['phone8', 'p8', 'last8']);
    if (!p8 && phone) p8 = String(phone).replace(/\D/g, '').slice(-8);
    const status = String(pick(r, ['outcome', 'status', 'action', 'decision']) ?? '').toLowerCase();
    const skipReason = pick(r, ['skip_reason', 'skipReason', 'reason', 'why']);
    const isSkip = pick(r, ['skip', 'skipped', 'excluded']) === true || /^(skip|skipped|exclude|excluded|reject|rejected|junk)$/.test(status);
    // helper A's vocabulary: status import | merge_existing | skip (reason = the first skip reason)
    const match = /existing_noncanonical/.test(status) ? 'existing_noncanonical'
      : /exist|merge|match/.test(status) ? (rawCustomer && !CANONICAL_RE.test(String(rawCustomer)) ? 'existing_noncanonical' : 'existing')
      : /new|import/.test(status) ? 'new' : null;
    out.set(String(id).trim(), {
      p8: p8 && MK_NSN_RE.test(String(p8)) ? String(p8) : null,
      phone: phone && CANONICAL_RE.test(String(phone)) ? String(phone) : (p8 && MK_NSN_RE.test(String(p8)) ? e164(String(p8)) : null),
      crm_phone: r.crm?.phone ?? (rawCustomer && !CANONICAL_RE.test(String(rawCustomer)) ? String(rawCustomer) : null),
      in_crm: !!r.crm,
      crm_orders: r.crm?.orders ?? null,
      match,
      skip: isSkip ? String(skipReason || 'excluded_by_customers_clean') : null,
      reason: skipReason ? String(skipReason) : null,
      name: pick(r, ['name', 'customer_name', 'Ime']),
      flags: Array.isArray(r.flags) ? r.flags : [],
      city: pick(r, ['city', 'Grad']),
      address: pick(r, ['address', 'street', 'Adresa']),
    });
  }
  if (rows.length && !out.size) throw new Error('customers-clean.json: no row carries a komitent id — refusing to use it');
  return out;
}

/**
 * exports/teleshop/items-2026-summary.json (helper B) → Map DocNumber → [{ code, name, qty,
 * value_mkd, kind, product_id }]. Accepts an object keyed by DocNumber or an array of
 * { doc_number | docNumber, lines: [...] }; a line is { article, articleCode, qty, value_mkd,
 * kind, product_id|null }. product_id is the helper's reviewed mapping: null stays null (never
 * guessed here).
 */
export function adaptItemsSummary(json, headersOut = null) {
  const entries = Array.isArray(json) ? json.map((e) => [e.doc_number ?? e.docNumber ?? e.DocNumber, e])
    : Array.isArray(json?.documents) ? json.documents.map((e) => [e.doc_number ?? e.docNumber ?? e.DocNumber, e])
    : Object.entries(json?.docs ?? json?.byDoc ?? json ?? {});
  const out = new Map();
  for (const [doc, e] of entries) {
    if (!doc || !/^\d{3}-/.test(String(doc))) continue;
    const lines = Array.isArray(e) ? e : Array.isArray(e?.lines) ? e.lines : [];
    // document-level fields, when the helper kept them → a header for a document the crawl never saw
    if (headersOut && e && !Array.isArray(e)) {
      const pickE = (keys) => { for (const k of keys) if (e[k] !== undefined && e[k] !== null && e[k] !== '') return e[k]; return null; };
      const typeId = pickE(['type_id', 'typeId', 'TipID']);
      const when = pickE(['datetime', 'doc_at', 'date', 'doc_date', 'Datum']);
      if (typeId && when) {
        const at = parseIsoLocal(String(when)) ?? parseCbDatum(String(when));
        const amount = pickE(['amount_mkd', 'amount', 'Iznos']);
        headersOut.push({
          doc_number: String(doc).trim(), doc_id: pickE(['doc_id', 'docId']), type_id: String(typeId), type_name: pickE(['type_name', 'typeName']) || '',
          komitent_id: pickE(['komitent_id', 'customerId', 'KomitentID']) ? String(pickE(['komitent_id', 'customerId', 'KomitentID'])) : null,
          komitent_name: String(pickE(['komitent_name', 'customerName', 'Komitent']) ?? ''),
          amount_mkd: amount != null ? (typeof amount === 'number' ? amount : parseAmount(amount)) : null,
          currency: 'МКД', doc_at: at ? at.toISOString() : null, datum_raw: String(when), author: authorOf(pickE(['author', 'Avtor'])), source: 'items',
          sum_check: pickE(['sum_check']),
          storno: amount == null && lines.some((l) => Number(l.value_mkd ?? 0) < 0 || Number(l.qty ?? 0) < 0),
          lines_value_mkd: lines.reduce((t, l) => t + (Number(l.value_mkd ?? l.saleValueVat ?? 0) || 0), 0),
          negative_line: amount != null && lines.some((l) => Number(l.value_mkd ?? 0) < 0 || Number(l.qty ?? 0) < 0),
          doc_flags: Array.isArray(e.flags) ? e.flags : [],
        });
      }
    }
    out.set(String(doc).trim(), lines.map((l) => ({
      code: String(l.articleCode ?? l.code ?? '').trim(),
      name: cleanName(l.article ?? l.name ?? ''),
      // order_items.quantity is what stock, package counts and cost read → physical UNITS (helper B:
      // qty × pack multiplier for "2+2"-style set articles); the document's own qty is kept beside it
      qty: Number(l.units ?? l.qty ?? l.qtyOut ?? 0) || 0,
      qty_doc: Number(l.qty ?? l.qtyOut ?? 0) || 0,
      value_mkd: Number(l.value_mkd ?? l.saleValueVat ?? l.value ?? 0) || 0,
      kind: l.kind ? String(l.kind).toLowerCase() : null,
      product_id: Object.prototype.hasOwnProperty.call(l, 'product_id') ? (l.product_id || null) : undefined,
    })));
  }
  return out;
}
