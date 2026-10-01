#!/usr/bin/env node
/**
 * Refresh the local collabBox folder C:\Users\Mile\collab_out from the LIVE collabBox, read-only.
 * The owner asks for it when he wants the folder up to date ("кога ќе треба, ќе ти кажам").
 *
 *   1. documents (headers of the 9 "Нарачка" types, whole history) — the existing fetcher:
 *        node scripts/collabbox-fetch.mjs --from 01.01.2023 --to <today + 14 d> \
 *          --types 10036,10050,10063,10058,10111,10114,10112,10106,10055 --items none \
 *          --chunk-days 7 --max-requests 320 --out exports/collabbox/collab-out-<date>
 *      (sequential, 2,5 s between requests; the window runs ahead of today on purpose:
 *       "Нарачка out" / LEADS-OUT documents are often dated the NEXT day)
 *   2. the komitent register:
 *        node scripts/collab-out-refresh.mjs komitenti --out exports/collabbox/collab-out-<date>
 *   3. build the folder (writes only document/register files; READMEs are edited by hand):
 *        node scripts/collab-out-refresh.mjs build --docs <fetch json> \
 *          --komitenti exports/collabbox/collab-out-<date>/komitenti_full.csv [--dir C:\Users\Mile\collab_out] [--dry]
 *
 * Step 2 talks to collabBox with its OWN allow-list of exactly three request shapes (GET Login?,
 * POST Login, POST the komitent search "comp=infocc&action=search" with searchMode=search) — the
 * same search the operators use; nothing is saved, edited or exported on their server.
 * Credentials come from docs/VAULT.md §7 at runtime, are never printed, and the session id is
 * redacted from every log line. Strictly sequential (their ERP slowed down under parallel
 * full-history queries on 10.09.2026).
 *
 * The register search was recovered from the 10.09.2026 harvest (same form fields; `name1=А` +
 * `lettersubmit=1` is how that harvest asked for the whole register; the total is read back from
 * the page and every page must return its full size).
 *
 * Output format = the 10.09/11.09 export, so every script and README keeps working:
 *   documents: DocID,DocNumber,TipID,Tip,KomitentID,Komitent,Iznos,Valuta,Datum,Avtor
 *              (UTF-8 BOM, comma, "1,234.00" amounts, dd.mm.yyyy hh:mm:ss Skopje wall clock)
 *   register:  Sifra,VnatresenID,Ime,…,Vraboten (20 columns)
 * The files hold personal data (names, phones, addresses) — they never leave this machine and are
 * never committed.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync, copyFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'http://146.255.89.49:8081/naturatherapy/';
const argv = process.argv.slice(2);
const cmd = argv[0];
const arg = (name, def) => {
  const i = argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};

const redact = (s) => String(s).replace(/[0-9A-F]{32}/g, '<session>').replace(/JSESSIONID=[^;\s]+/gi, 'JSESSIONID=<session>');
let LOGFILE = null;
const log = (...a) => {
  const line = new Date().toISOString() + ' ' + redact(a.join(' '));
  console.error(line);
  if (LOGFILE) appendFileSync(LOGFILE, line + '\n');
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── the 9 document types of the export, in the export's order ───────────────────────────────
export const TYPES = [
  { id: '10111', file: 'orders_10111_Naracka_LEADS.csv', folder: '01-affiliate-lead-in' },
  { id: '10114', file: 'orders_10114_LEADS_OUT.csv', folder: '02-affiliate-lead-out' },
  { id: '10050', file: 'orders_10050_Naracka_out.csv', folder: '03-teleshop-lead-out' },
  { id: '10036', file: 'orders_10036_Naracka_in.csv', folder: '04-teleshop-lead-in' },
  { id: '10106', file: 'orders_10106_Naracka_Social.csv', folder: '05-socijalni-mrezi' },
  { id: '10055', file: 'orders_10055_Naracka_Social_Shop.csv', folder: '05-socijalni-mrezi' },
  { id: '10112', file: 'orders_10112_Naracka_WEB.csv', folder: '06-web' },
  { id: '10063', file: 'orders_10063_Naracka_in_out.csv', folder: '07-ostanati-tipovi' },
  { id: '10058', file: 'orders_10058_Naracka_in_Final.csv', folder: '07-ostanati-tipovi' },
];
export const DOC_COLS = ['DocID', 'DocNumber', 'TipID', 'Tip', 'KomitentID', 'Komitent', 'Iznos', 'Valuta', 'Datum', 'Avtor'];
export const KOM_COLS = ['Sifra', 'VnatresenID', 'Ime', 'Ime_lat', 'Adresa', 'Adresa_lat', 'Grad', 'Drzava', 'Datum_raganje', 'Telefon', 'Mobilen', 'Email', 'Ziro_smetka', 'Broj_kartica', 'Danocen_broj', 'Faks', 'Lice_kontakt', 'DDV_broj', 'EMBS', 'Vraboten'];

/** The export's CSV quoting: only fields with " , newline or ; are quoted. */
export const csvCell = (v) => { v = v == null ? '' : String(v); return /[",\n;]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
export const money = (n) => (n == null ? '' : Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
export const docRow = (h) => [h.docId, h.docNumber, h.typeId, h.typeName, h.customerId, h.customerName, money(h.amount), h.currency, h.datetimeRaw, h.author].map(csvCell).join(',');
/** "dd.mm.yyyy hh:mm:ss" -> sortable key */
const dateKey = (s) => { const m = String(s ?? '').match(/(\d{2})\.(\d{2})\.(\d{4})\s*(\d{2})?:?(\d{2})?:?(\d{2})?/); return m ? `${m[3]}${m[2]}${m[1]}${m[4] ?? '00'}${m[5] ?? '00'}${m[6] ?? '00'}` : ''; };

// ── komitent register ───────────────────────────────────────────────────────────────────────
const decode = (s) => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const clean = (s) => decode(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

/** One page of the komitent search -> rows (the 10.09 harvest's parser, unchanged). */
export function parseKomitenti(html) {
  const ti = html.indexOf('id="table_exp"');
  if (ti < 0) return [];
  const rows = [];
  for (const part of html.slice(ti).split(/<tr\b/i)) {
    if (!/popust_\d+/i.test(part)) continue;
    const code = (part.match(/name="popust_(\d+)"/i) || [])[1] || '';
    const oid = (part.match(/comp=ovc&id=(\d+)/i) || [])[1] || '';
    const cells = [];
    const re = /<td class\s*=\s*"tdList">([\s\S]*?)<\/td>/gi;
    let m;
    while ((m = re.exec(part))) cells.push(clean(m[1]));
    if (cells.length < 21) continue;
    rows.push({
      Sifra: code || cells[2], VnatresenID: oid, Ime: cells[3], Ime_lat: cells[4], Adresa: cells[5], Adresa_lat: cells[6],
      Grad: cells[7], Drzava: cells[8], Datum_raganje: cells[9], Telefon: cells[10], Mobilen: cells[11], Email: cells[12],
      Ziro_smetka: cells[13], Broj_kartica: cells[14], Danocen_broj: cells[15], Faks: cells[16], Lice_kontakt: cells[17],
      DDV_broj: cells[18], EMBS: cells[19], Vraboten: cells[20],
    });
  }
  return rows;
}

/** The page's own total ("… вкупно N …"), or null. */
export function komitentiTotal(html) {
  const t = clean(html);
  const m = t.match(/вкупно[^0-9]{0,40}([\d.,]+)/i) || t.match(/([\d.,]+)[^0-9]{0,20}вкупно/i);
  return m ? Number(m[1].replace(/[.,]/g, '')) : null;
}

function credentials() {
  const vault = readFileSync(join(ROOT, 'docs', 'VAULT.md'), 'utf8');
  const at = vault.indexOf('## §7 collabBox');
  if (at < 0) throw new Error('docs/VAULT.md has no "## §7 collabBox" section');
  const s = vault.slice(at, at + 4000);
  const user = s.match(/\*\*User:\*\*\s*`([^`]+)`/)?.[1];
  const pass = s.match(/\*\*Password:\*\*\s*`([^`]+)`/)?.[1];
  if (!user || !pass) throw new Error('collabBox User/Password not found in docs/VAULT.md §7');
  return { user, pass };
}

const jar = new Map();
let requests = 0;
const MAX_REQUESTS = Number(arg('max-requests', 60));
const PAUSE_MS = Math.max(1000, Number(arg('pause-ms', 2500)));

function assertReadOnly(method, path, body) {
  const form = body ? new URLSearchParams(body) : null;
  const ok =
    (method === 'GET' && path === 'Login?') ||
    (method === 'POST' && path === 'Login') ||
    (method === 'POST' && /^Index\?comp=infocc&action=search&pgsf=\d+&cp=\d+$/.test(path) && form.get('searchMode') === 'search');
  if (!ok) throw new Error(`refusing non-allow-listed request: ${method} ${redact(path)}`);
}

async function http(method, path, body = null) {
  assertReadOnly(method, path, body);
  if (++requests > MAX_REQUESTS) throw new Error(`--max-requests ${MAX_REQUESTS} reached, stopping`);
  if (requests > 1) await sleep(PAUSE_MS);
  const t0 = Date.now();
  const res = await fetch(BASE + path, {
    method, body, redirect: 'manual',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) elyon-collab-out-refresh/1 (read-only)',
      ...(jar.size ? { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    signal: AbortSignal.timeout(300_000),
  });
  for (const c of res.headers.getSetCookie?.() ?? []) { const kv = c.split(';')[0]; const i = kv.indexOf('='); jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim()); }
  const text = Buffer.from(await res.arrayBuffer()).toString('utf8');
  const ms = Date.now() - t0;
  log(`  #${requests} ${method} ${redact(path)} -> ${res.status} ${text.length} chars ${ms} ms`);
  if (res.status !== 200) throw new Error(`HTTP ${res.status} for ${method} ${redact(path)}`);
  if (ms > 90_000) log('  ! slow answer (>90 s) — their server is under load');
  return text;
}
const isLoginPage = (t) => t.length < 200 && t.includes("location.href='./Login");
async function login() {
  const { user, pass } = credentials();
  jar.clear();
  await http('GET', 'Login?');
  const r = await http('POST', 'Login', new URLSearchParams({ company_code: '', username: user, password: pass, browserIsIE: '0' }).toString());
  if (!r.includes("location.href='./Index?'")) throw new Error('collabBox login failed');
  log('  logged in');
}

const searchBody = (pageSize) => [
  'searchMode=search', 'name1=%D0%90', 'id=', 'address=', 'city=', 'opstina=', 'regionId=', 'drzavaId=', 'taxnum=', 'telnum=',
  'mobilen=', 'bankacc=', 'prikaziKartica=1', 'brojKartica=', 'lettersubmit=1', 'language=1', 'showAllResults=',
  `pageNum=${pageSize}`, 'number=0',
].join('&');

async function komitentiPage(cp, pageSize) {
  const path = `Index?comp=infocc&action=search&pgsf=${pageSize * (cp - 1)}&cp=${cp}`;
  let html = await http('POST', path, searchBody(pageSize));
  if (isLoginPage(html)) { log('  session expired — logging in again'); await login(); html = await http('POST', path, searchBody(pageSize)); }
  return html;
}

async function harvestKomitenti() {
  const out = resolve(ROOT, String(arg('out', `exports/collabbox/collab-out-${new Date().toISOString().slice(0, 10)}`)));
  mkdirSync(out, { recursive: true });
  LOGFILE = join(out, 'harvest.log');
  const PS = Number(arg('page-size', 10000));
  log(`komitent register harvest, page size ${PS}, pause ${PAUSE_MS} ms`);
  await login();
  const first = await komitentiPage(1, PS);
  const total = komitentiTotal(first);
  if (!total) throw new Error('could not read the register total from the first page — layout changed?');
  const pages = Math.ceil(total / PS);
  if (pages + 3 > MAX_REQUESTS) throw new Error(`${pages} pages needed, --max-requests ${MAX_REQUESTS} too low`);
  log(`  server total ${total} komitenti, ${pages} pages`);
  const all = new Map();
  const add = (rows) => { for (const r of rows) all.set(r.Sifra + '|' + r.VnatresenID, r); };
  for (let cp = 1; cp <= pages; cp++) {
    const html = cp === 1 ? first : await komitentiPage(cp, PS);
    const rows = parseKomitenti(html);
    const expect = cp < pages ? PS : total - PS * (pages - 1);
    log(`page ${cp}/${pages} rows=${rows.length} (expect ${expect})`);
    if (rows.length !== expect) throw new Error(`page ${cp}: ${rows.length} rows, expected ${expect} — stopping (nothing written)`);
    add(rows);
  }
  if (all.size !== total) log(`  ! ${total} reported, ${all.size} unique (duplicates across pages)`);
  const file = join(out, 'komitenti_full.csv');
  writeFileSync(file, '\uFEFF' + KOM_COLS.join(',') + '\n' + [...all.values()].map((r) => KOM_COLS.map((c) => csvCell(r[c])).join(',')).join('\n') + '\n', 'utf8');
  log(`DONE ${all.size} komitenti -> ${file} (${requests} requests)`);
  console.log(JSON.stringify({ file, total, unique: all.size, requests }));
}

// ── build the folder ────────────────────────────────────────────────────────────────────────
function readCsvLines(path) {
  return readFileSync(path, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
}

function build() {
  const docsPath = resolve(ROOT, String(arg('docs')));
  const komPath = resolve(ROOT, String(arg('komitenti')));
  const dir = resolve(String(arg('dir', 'C:/Users/Mile/collab_out')));
  const dry = argv.includes('--dry');
  if (!existsSync(docsPath) || !existsSync(komPath)) throw new Error('--docs <fetch json> and --komitenti <csv> are required');
  const j = JSON.parse(readFileSync(docsPath, 'utf8'));
  const headers = j.headers;

  // duplicate DocIDs across chunks would mean overlapping windows — refuse
  const ids = new Set(headers.map((h) => h.docId));
  if (ids.size !== headers.length) throw new Error(`${headers.length - ids.size} duplicate DocIDs in ${docsPath}`);
  const wanted = new Set(TYPES.map((t) => t.id));
  const stray = headers.filter((h) => !wanted.has(h.typeId));
  if (stray.length) throw new Error(`${stray.length} documents of unexpected types (${[...new Set(stray.map((h) => h.typeId))]})`);

  // newest first, like the export
  headers.sort((a, b) => dateKey(b.datetimeRaw).localeCompare(dateKey(a.datetimeRaw)) || Number(b.docId) - Number(a.docId));

  // compare with what is in the folder now
  const oldCombined = join(dir, '09-site-nalozi-zaedno', 'orders_ALL_combined.csv');
  const old = existsSync(oldCombined) ? readCsvLines(oldCombined).slice(1) : [];
  const oldById = new Map(old.map((l) => [l.split(',')[0], l]));
  let same = 0, changed = 0, added = 0;
  for (const h of headers) { const o = oldById.get(h.docId); if (!o) added++; else if (o === docRow(h)) same++; else changed++; }
  const gone = old.filter((l) => !ids.has(l.split(',')[0])).length;

  const head = '\uFEFF' + DOC_COLS.join(',') + '\n';
  const perType = [];
  const writes = [];
  for (const t of TYPES) {
    const rows = headers.filter((h) => h.typeId === t.id);
    perType.push({ id: Number(t.id), name: rows[0]?.typeName ?? j.typeNames?.[t.id] ?? null, saved: rows.length });
    writes.push([join(dir, t.folder, t.file), head + rows.map(docRow).join('\n') + (rows.length ? '\n' : '')]);
  }
  writes.push([oldCombined, head + headers.map(docRow).join('\n') + '\n']);

  const kom = readCsvLines(komPath);
  const komFile = join(dir, '08-komitenti-klienti', 'komitenti_full.csv');
  const oldKom = existsSync(komFile) ? readCsvLines(komFile).length - 1 : 0;
  const komIds = new Set(kom.slice(1).map((l) => l.split(',')[0]));
  const docKomMissing = new Set(headers.map((h) => h.customerId).filter((id) => id && !komIds.has(id)));

  const range = headers.length ? [headers[headers.length - 1].datetimeRaw, headers[0].datetimeRaw] : [null, null];
  const report = {
    fetchedAt: j.meta?.fetchedAt, finishedAt: j.meta?.finishedAt, requests: j.meta?.requests,
    documents: headers.length, range, perType,
    vsFolderBefore: { before: old.length, sameRow: same, changedRow: changed, newDocuments: added, goneFromCollabBox: gone },
    komitenti: { before: oldKom, now: kom.length - 1, documentCustomersMissingFromRegister: docKomMissing.size },
  };
  console.log(JSON.stringify(report, null, 1));
  if (dry) { console.error('--dry: nothing written'); return; }

  for (const [p, content] of writes) writeFileSync(p, content, 'utf8');
  copyFileSync(komPath, komFile);
  const komBuf = readFileSync(komFile);
  writeFileSync(komFile + '.gz', gzipSync(komBuf, { level: 9 }));
  writeFileSync(join(dir, '09-site-nalozi-zaedno', 'summary.json'), JSON.stringify({ ...report, perType: perType.map((p) => ({ ...p, expected: p.saved })) }, null, 1) + '\n', 'utf8');
  console.error(`written: ${writes.length} document files + register (+ .gz) + 09-site-nalozi-zaedno/summary.json in ${dir}`);
}

const IS_MAIN = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (!IS_MAIN) { /* imported for its helpers */ }
else if (cmd === 'komitenti') harvestKomitenti().catch((e) => { log('x ' + (e?.stack || e)); process.exit(1); });
else if (cmd === 'build') { try { build(); } catch (e) { console.error(redact('x ' + (e?.stack || e))); process.exit(1); } }
else if (cmd) { console.error('usage: collab-out-refresh.mjs komitenti [--out dir] | build --docs <json> --komitenti <csv> [--dir collab_out] [--dry]'); process.exit(1); }
