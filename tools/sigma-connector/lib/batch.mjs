/**
 * The SigmaBatch builder shared by the office connector (tools/sigma-connector/connector.mjs) and the repo's
 * scripts/stock/sigma-ingest-file.mjs. It is the JavaScript twin of docs/stock/build_sigma_stock.py §13 (the CSV
 * export): the same field list (../sigma-fields.json), the same sign rule, the same client-name rule — so a
 * document reaches stock_sigma_ingest() in exactly one shape whichever way it travels.
 *
 * Pure functions, no dependencies (Node ≥ 18): the repo can import it without installing the connector.
 */
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIELDS = JSON.parse(readFileSync(join(HERE, '..', 'sigma-fields.json'), 'utf8'));
const COMPANY_WORDS = new Set(FIELDS.company_hint_words.map((w) => w.toUpperCase()));

const trim = (v) => (v === null || v === undefined ? '' : String(v).trim());
const orNull = (v) => (trim(v) === '' ? null : trim(v));
export const r3 = (x) => {
  const v = Math.round(Number(x) * 1000) / 1000;
  return Object.is(v, -0) || v === 0 ? 0 : v;
};

/** Europe/Skopje offset ('+02:00' / '+01:00') at a UTC instant. */
function skopjeOffset(ms) {
  const part = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Skopje', timeZoneName: 'longOffset' })
    .formatToParts(new Date(ms)).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+01:00';
  const m = part.match(/GMT([+-])(\d{2}):?(\d{2})?/);
  return m ? `${m[1]}${m[2]}:${m[3] ?? '00'}` : '+01:00';
}

/** A Sigma local timestamp ('2026-09-28 15:14:40' or a Date read by mssql as local wall time) → ISO with offset. */
export function skopjeIso(v) {
  if (v === null || v === undefined || v === '') return null;
  let s;
  if (v instanceof Date) {
    // mssql returns DATETIME as a Date whose UTC fields hold the server's wall clock (useUTC: true, the default)
    const p = (n) => String(n).padStart(2, '0');
    s = `${v.getUTCFullYear()}-${p(v.getUTCMonth() + 1)}-${p(v.getUTCDate())} ${p(v.getUTCHours())}:${p(v.getUTCMinutes())}:${p(v.getUTCSeconds())}`;
  } else {
    s = String(v).trim().replace('T', ' ').slice(0, 19);
  }
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return null;
  const [, Y, M, D, h = '00', mi = '00', se = '00'] = m;
  const wall = Date.UTC(+Y, +M - 1, +D, +h, +mi, +se);
  let off = skopjeOffset(wall - 2 * 3600e3);
  const offMs = (o) => (o[0] === '-' ? -1 : 1) * (Number(o.slice(1, 3)) * 3600e3 + Number(o.slice(4, 6)) * 60e3);
  off = skopjeOffset(wall - offMs(off));                       // settle on the offset valid at that wall time
  return `${Y}-${M}-${D}T${h}:${mi}:${se}${off}`;
}

/** The Sigma date of a WDate value → 'YYYY-MM-DD'. */
export function sigmaDay(v) {
  const iso = skopjeIso(v);
  return iso ? iso.slice(0, 10) : null;
}

/** sigma-fields.json client_name_rule — a person's name never leaves the office. */
export function companyName(name) {
  const n = trim(name);
  if (!n) return null;
  const words = n.toUpperCase().match(/\p{L}+/gu) ?? [];
  if (words.some((w) => COMPANY_WORDS.has(w))) return n;
  if (/[0-9.*\-&"()]/.test(n)) return n;
  if (words.length === 1 || words.length >= 4) return n;
  return null;
}

/** ПМ1 → ПН1, ТМ1 → ТН1, НМ1 → НН1, ММ2 → МН2 (the work layer of a posted stock document). */
export const workTypeOf = (invType) => (invType === 'ММ2' ? 'МН2' : `${invType[0]}Н${invType.slice(2)}`);

/** DocType rows → { [type]: {inout, transfer} }. */
export function docTypeMap(rows) {
  const out = {};
  for (const r of rows) out[trim(r.DocType)] = { inout: trim(r.InOut), transfer: String(r.TransferDoc).trim() === '1', name: trim(r.TypeDescription) };
  return out;
}

/** Lines → [{item_code, qty, side}] summed per (item_code, side), sorted, zero sums dropped (the sign rule). */
export function docLines(rows, docType, qtyOf, docTypes) {
  const dt = docTypes[docType] ?? {};
  const agg = new Map();
  const add = (code, side, q) => {
    const k = `${code}\u0000${side}`;
    agg.set(k, (agg.get(k) ?? 0) + q);
  };
  for (const l of rows) {
    const code = trim(l.CodeID);
    const q = Number(qtyOf(l)) || 0;
    if (dt.transfer) { add(code, 'out', q); add(code, 'in', q); }
    else if ((dt.inout ?? '').startsWith('I')) add(code, 'in', q);
    else add(code, 'out', q);
  }
  return [...agg.entries()]
    .map(([k, q]) => { const [item_code, side] = k.split('\u0000'); return { item_code, qty: r3(q), side }; })
    .filter((l) => l.qty !== 0)
    .sort((a, b) => (a.item_code < b.item_code ? -1 : a.item_code > b.item_code ? 1 : a.side < b.side ? -1 : a.side > b.side ? 1 : 0));
}

/** The client of a document: the non-own party (none for a transfer). */
export function counterparty(docType, clientFrom, clientTo, docTypes) {
  const dt = docTypes[docType] ?? {};
  if (dt.transfer) return null;
  return (dt.inout ?? '').startsWith('I') ? orNull(clientFrom) : orNull(clientTo);
}

/**
 * One POSTED stock document (InventoryHead + its InventoryLine rows + its work document).
 * head may be null (a document whose lines were posted after the header was read): the first line stands in.
 */
export function postedDoc({ wyear, docType, docNo, head, lines, work, docTypes, clients }) {
  const first = lines[0] ?? {};
  const h = head ?? first;
  const client = counterparty(docType, h.ClientFrom, h.ClientTo, docTypes);
  return {
    doc_key: `${trim(wyear)}|${trim(docType)}|${trim(docNo)}`,
    wyear: trim(wyear), doc_type: trim(docType), doc_no: trim(docNo),
    doc_date: sigmaDay(h.WDate ?? first.WDate),
    posted_at: head ? skopjeIso(head.SysDateTime) : (work ? skopjeIso(work.LastChangeDateTime) : null),
    created_at_sigma: work ? skopjeIso(work.SysDateTime) : null,
    created_by: orNull(work ? work.SysUser : head?.SysUser),
    last_change_by: orNull(work ? work.LastChangeUser : head?.SysUser),
    status: 'posted',
    company_from: orNull(h.ClientFrom), object_from: orNull(h.ObjectFrom),
    company_to: orNull(h.ClientTo), object_to: orNull(h.ObjectTo),
    client_code: client, client_name: client ? companyName(clients[client]) : null,
    lines: docLines(lines, trim(docType), (l) => l.Quantity, docTypes),
  };
}

/** The quantity of a draft line: the first non-zero of the draft columns (sigma-fields.json draft_qty_columns). */
export const draftQty = (l) => {
  for (const c of FIELDS.draft_qty_columns) { const v = Number(l[c]); if (v) return v; }
  return 0;
};

/** One open DRAFT (WorkDocInHead Status ≠ 4 with no posted twin) — "најавено", never moves stock. */
export function draftDoc({ head, lines, docTypes, clients }) {
  const docType = trim(head.DocType);
  const client = counterparty(docType, head.ClientFrom, head.ClientTo, docTypes);
  return {
    doc_key: `${trim(head.WYear)}|${docType}|${trim(head.DocNo)}`,
    wyear: trim(head.WYear), doc_type: docType, doc_no: trim(head.DocNo),
    doc_date: sigmaDay(head.WDate),
    posted_at: null,
    created_at_sigma: skopjeIso(head.SysDateTime),
    created_by: orNull(head.SysUser), last_change_by: orNull(head.LastChangeUser),
    status: 'draft',
    company_from: orNull(head.ClientFrom), object_from: orNull(head.ObjectFrom),
    company_to: orNull(head.ClientTo), object_to: orNull(head.ObjectTo),
    client_code: client, client_name: client ? companyName(clients[client]) : null,
    lines: docLines(lines.filter((l) => trim(l.CodeType) === 'I'), docType, draftQty, docTypes),
  };
}

const PRIVATE_LABEL = { 'PRO NATURAL': 'Private label AL (PRO NATURAL)', 'MONE TIZE': 'Private label BA (MONE TIZE)',
  BIOLAB: 'Private label (BIOLAB)', 'ХЕЛТИКОР ДОО': 'Private label (Heltikor)' };

/** build_sigma_stock.py brand_of(): the brand line of a Sigma item. */
export function brandOf(code, item) {
  const g = trim(item.ItemGroupID); const n = trim(item.Name).toUpperCase(); const cls = trim(item.AccountPG);
  if (cls === 'ЛОЈАЛИТИ') return 'Loyalty gift';
  if (cls === 'ТС') return g ? `Third-party: ${g}` : 'Third-party (trade goods)';
  if (g === 'АД АСТРА') return 'AD Astra';
  if (g === 'БИОНАТУРАЛ' || n.includes('BIONATURAL') || n.includes('БИОНАТУРАЛ')) return 'BioNatural';
  if (g === 'ELIXY' || n.startsWith('ELIXY')) return 'ELIXY';
  if (g === 'DR BECKER' || n.includes('DR BECKER')) return 'Dr Becker';
  if (g === 'НАТУРА- БУГАРИЈА') return 'Natura Therapy (BG label)';
  if (PRIVATE_LABEL[g]) return PRIVATE_LABEL[g];
  if (g) return `Third-party: ${g}`;
  if (code.startsWith('011')) return 'Food line';
  return cls === 'АРТИКЛ' ? 'Natura Therapy' : null;
}

/** An Item row → SigmaItem, or null when it is not a stock article (class, or a code that is not 6 digits). */
export function toItem(row, active) {
  const code = trim(row.ItemID);
  const cls = trim(row.AccountPG);
  if (!/^[0-9]{6}$/.test(code) || !FIELDS.article_classes.includes(cls)) return null;
  return { code, name: trim(row.Name), unit: trim(row.MainUnitID) || 'КОМ', sigma_class: cls || null, brand: brandOf(code, row), active: !!active };
}

/** A StockObject row → SigmaBalance (qty = In − Out of that WYear bucket), or null when it is all zero. */
export function toBalance(row) {
  const qty = r3(Number(row.InInventoryQuantity || 0) - Number(row.OutInventoryQuantity || 0));
  const p = Math.round(Number(row.CalcBuyPrice || 0) * 1e4) / 1e4;
  if (qty === 0 && p === 0) return null;
  return { company: trim(row.Client), object: trim(row.Object), item_code: trim(row.ItemID), wyear: trim(row.WYear), qty,
    calc_buy_price: p || null };
}

/** Keep only the contract keys of a document / item / balance (defence in depth before anything leaves). */
export function whitelist(obj, keys) {
  const out = {};
  for (const k of keys) out[k] = obj[k] ?? null;
  return out;
}

const bytes = (o) => Buffer.byteLength(JSON.stringify(o), 'utf8');

/**
 * Split a batch so that no request carries more than maxDocs documents or maxBytes bytes. Documents first, then
 * items, then balances (an item's WYear buckets stay together), drafts in the LAST chunk — a snapshot's vanish
 * check runs when the last chunk arrives. One chunk → the batch unchanged.
 */
export function chunkBatch(batch, { maxDocs = FIELDS.limits.max_docs_per_batch, maxBytes = FIELDS.limits.max_bytes_per_batch } = {}) {
  const head = { source: batch.source, mode: batch.mode, exported_at: batch.exported_at };
  if (batch.window) head.window = batch.window;
  const parts = [];
  let cur = { docs: [] };
  const flush = () => { if (Object.values(cur).some((a) => a.length)) parts.push(cur); cur = {}; };
  const room = (key, value, maxN) => {
    const arr = cur[key] ?? [];
    return arr.length < maxN && bytes({ ...head, ...cur, [key]: [...arr, value] }) < maxBytes - 2048;
  };
  for (const d of batch.docs ?? []) {
    if (!room('docs', d, maxDocs)) flush();
    (cur.docs ??= []).push(d);
  }
  for (const it of batch.items ?? []) {
    if (!room('items', it, Infinity)) flush();
    (cur.items ??= []).push(it);
  }
  const groups = new Map();
  for (const b of batch.balances ?? []) {
    const k = `${b.company}|${b.object}|${b.item_code}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(b);
  }
  for (const g of groups.values()) {
    const next = [...(cur.balances ?? []), ...g];
    if (cur.balances && bytes({ ...head, ...cur, balances: next }) >= maxBytes - 2048) flush();
    cur.balances = [...(cur.balances ?? []), ...g];
  }
  flush();
  if (!parts.length) parts.push({});
  if (batch.drafts) parts[parts.length - 1].drafts = batch.drafts;
  if (parts.length === 1) return [batch];
  return parts.map((p, i) => ({
    batch_id: `${batch.batch_id}-c${String(i + 1).padStart(3, '0')}`,
    ...head,
    ...p,
    ...(p.balances ? { balances_taken_at: batch.balances_taken_at ?? batch.exported_at } : {}),
    chunk: { run_id: batch.batch_id, index: i + 1, total: parts.length },
  }));
}

/** x-elyon-signature = hex(HMAC_SHA256(secret, ts + '.' + rawBody)). */
export function sign(secret, ts, rawBody) {
  return createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
}

/** POST one batch with the HMAC headers; retries 429 / 5xx / network errors. Returns {status, body}. */
export async function postBatch(url, secret, batch, { retries = 4, timeoutMs = 120_000, log = () => {} } = {}) {
  const raw = JSON.stringify(batch);
  for (let attempt = 0; ; attempt++) {
    const ts = String(Math.floor(Date.now() / 1000));
    let res, text;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-elyon-ts': ts, 'x-elyon-signature': sign(secret, ts, raw) },
        body: raw,
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await res.text();
    } catch (e) {
      if (attempt < retries) { log(`network error (${e?.name ?? e}), retry ${attempt + 1}/${retries}`); await pause(2 ** attempt * 2000); continue; }
      throw new Error(`POST failed: ${e?.message ?? e}`);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      log(`HTTP ${res.status}, retry ${attempt + 1}/${retries}`);
      await pause(2 ** attempt * 2000);
      continue;
    }
    let body = text;
    try { body = JSON.parse(text); } catch { /* keep the text */ }
    return { status: res.status, body };
  }
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
