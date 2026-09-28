#!/usr/bin/env node
/**
 * collabBox (Accent Computers) -> JSON, headless and READ-ONLY.
 *
 *   node scripts/collabbox-fetch.mjs --from 25.09.2026 --to 27.09.2026
 *   node scripts/collabbox-fetch.mjs --from 25.09.2026 --to 27.09.2026 --types sales
 *   node scripts/collabbox-fetch.mjs --from 01.09.2026 --to 07.09.2026 --types 10036,10050 --items html
 *
 * Options
 *   --from / --to  dd.mm.yyyy     document date window (inclusive, Europe/Skopje wall clock)
 *   --types        orders (default) = every document type named "Нарачка…" in the live form
 *                  sales            = the 10 channel types (in/out/in-out/in-Final/LEADS/LEADS-OUT/
 *                                     WEB/Социјални/С.Мрежи-Продавница/Ист Гејт)
 *                  10036,10050,…    = explicit type ids
 *   --items        xls (default) | html | none   how line items are read (see PROTOCOL §3)
 *   --no-headers                   skip the document-header search
 *   --chunk-days   N (default 1)   one query per N days; keeps every server query small
 *   --pause-ms     N (default 2500) politeness gap between requests (single-threaded, always)
 *   --max-requests N (default 250) hard stop, so a bug can never hammer their production ERP
 *   --out          dir (default exports/collabbox — gitignored)
 *   --keep-raw                      also keep each raw .xls / .html response under <out>/raw/
 *
 * Credentials are read at RUNTIME from docs/VAULT.md §7 (gitignored). They are never printed,
 * never written to the output, and the session id is redacted from every log line.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * PROTOCOL (reverse-engineered live 2026-09-28; supersedes the "DWR / not solved" note in
 * VAULT §7.1 — nothing here uses DWR. The results are SERVER-RENDERED into the POST response;
 * `collectGridIds()/getFirstGrid()` in xGrid.js only scans the DOM for keyboard navigation.)
 *
 * §0 Transport. http://146.255.89.49:8081/naturatherapy/  — plain HTTP, Apache Tomcat (Java),
 *    UTF-8 everywhere (Content-Type text/html;charset=UTF-8; forms are posted as
 *    application/x-www-form-urlencoded, UTF-8 percent-encoded, Cyrillic included).
 *    No HTTP basic auth, no CSRF token, no Referer/Origin check. State = one cookie:
 *    JSESSIONID (Path=/naturatherapy, HttpOnly). An expired session answers any page with
 *    `<script>location.href='./Login?';</script>` (HTTP 200) — detect that string, re-login.
 *
 * §1 Login.  GET  Login?                        -> sets JSESSIONID
 *            POST Login   company_code=&username=…&password=…&browserIsIE=0
 *            success body (43 B) = <script>location.href='./Index?';</script>
 *
 * §2 Document HEADERS — "Пребарување на документи" (comp=searchdoc).
 *    POST Index?comp=searchdoc&action=search
 *         searchMode=search  chkDocType=chk  selectedDocTypes=,10036,10050,   <- COMMA-WRAPPED
 *         chkDatumOd=chk datumod=dd.mm.yyyy  chkDatumDo=chk datumdo=dd.mm.yyyy  limitResults=0
 *    (a bare `selectedDocTypes=10036` matches NOTHING; `sel_selectedDocTypes` alone is IGNORED
 *    and returns every type.) No paging with limitResults=0: all rows in one HTML response
 *    (~1,5 KB per document; a busy day of every order type is ~1-2 MB).
 *    Count:  "Вкупно пронајдени N документи."   One row per document:
 *      <tr … id="row_K"> … <input type="checkbox" name="dokumentK-1" value="<DocID>">
 *      <a href="./Index?drawframe=0&comp=ovc&id=<ObjectID>">002-9103-177237/2026</a>
 *      <td>LEADS-OUT Нарачка</td>  <input name="komitentK-1" value="<customer id>">
 *      "#116579 Митко Роснов"  "3,000.00 МКД"  <td>&nbsp;(НалогБр.)</td>
 *      "25.09.2026 20:17:03"   author   filter('Тип на документ','10114','LEADS-OUT Нарачка')
 *    Amounts: "1,234.50" (comma thousands, dot decimals) + currency label (МКД).
 *
 * §3 Document LINE ITEMS — "Документи - ставки" (comp=repbydocitm). Has Артикл.
 *    The search form (`searchform`, ~226 controls) must be posted COMPLETE, the way a browser
 *    serialises it after the page's own `setCombos(left,right,',')` → `fillHidden()` has run:
 *    every dual-list pair posts BOTH hidden fields as comma-wrapped value lists, e.g.
 *      dokTipSelection=,10023,10049,…,   (left box = NOT selected)
 *      doktipid=,10114,                  (right box = selected — this is the filter)
 *      holding=,2,  delid=,2,  userid=,313,322,…,  selectedUserIds=,
 *    An EMPTY box is a single ","  — never ",," and never "" (",," is what made the
 *    2026-09-18 attempts return "Пребарувањето не врати резултати" every time).
 *    Selects post their selected option or, failing that, their FIRST option (not "").
 *    Two actions on the same POST Index?comp=repbydocitm:
 *      (a) mode=doSearch  searchMode=doSearch  limitResults=0   (the "Потврди" button)
 *          -> HTML table id="exportX", rows <tr id="row_K">, 13 columns:
 *             Бр. | Шифра | Артикл | Шифра на комитент | Комитент | Датум (dd.mm.yyyy hh:mm) |
 *             Тип на документ (link comp=ovc&id=<ObjectID>) | Број на документ | Автор |
 *             Група на артикл | Тип бренд | Количина излез | Продажна вредност со ддв
 *             last row = totals; "Не се пронајдени резултати" when empty. Cells wrap with <BR>.
 *      (b) mode=doListOptions searchMode=exportxls (the "Експортирај во Excel" button)
 *          -> HTML page whose body links ./FileDownload?path=reports/&file=DokumentiStavki_<JSESSIONID>.xls
 *             (the server writes the file to its own reports/ folder, one per session,
 *             overwritten by the next export). GET that link -> application/xls attachment,
 *             OLE2/BIFF8. Row 0 = title, row 1 = 35 named columns (Ред.Бр., ID, Шифра, Артикл,
 *             …, Количина излез, Единечна п. цена, Продажна вредност со ДДВ, Деловна единица,
 *             Продал, Влезен/Излезен магацин, ДДВ на артикл, Даночен индикатор), then one row per
 *             line item, last row = copyright. Датум is a DATE only (no time). Same file the
 *             operators export by hand, i.e. what scripts/import-collabbox-teleshop.mjs reads.
 *             The same page also links comp=cmc&action=newMail (e-mail the file) — NEVER call it.
 *
 * §4 Things this script must never touch (all found on these pages): resolveClick('save')/
 *    comp=savesrch (saves a search), resolveClick('addcustom'), resolveDelete, the actionForm
 *    (comp=kompop&act=addPopustForMoreKomIds = adds DISCOUNTS; comp=ctfec; comp=grpdocs),
 *    comp=infdocc&mode=add (creates documents), comp=cmc (mail), notepad save, and
 *    exportxlsTeleshop (hidden for this user: specijalenEksportVoPrebaruvanjeDokumenti=0).
 *    assertReadOnly() below enforces an allow-list of the only six request shapes used.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { read as readXls, utils as xlsUtils } from 'xlsx';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'http://146.255.89.49:8081/naturatherapy/';

// ── args ─────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const FROM = arg('from');
const TO = arg('to');
const TYPES_ARG = String(arg('types', 'orders'));
const ITEMS_MODE = String(arg('items', 'xls'));
const WANT_HEADERS = !argv.includes('--no-headers');
const CHUNK_DAYS = Math.max(1, parseInt(arg('chunk-days', '1'), 10));
const PAUSE_MS = Math.max(500, parseInt(arg('pause-ms', '2500'), 10));
const MAX_REQUESTS = parseInt(arg('max-requests', '250'), 10);
const OUT = resolve(ROOT, String(arg('out', 'exports/collabbox')));
const KEEP_RAW = argv.includes('--keep-raw');

const DMY = /^(\d{2})\.(\d{2})\.(\d{4})$/;
const IS_MAIN = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (IS_MAIN && (!DMY.test(FROM || '') || !DMY.test(TO || ''))) {
  console.error('usage: collabbox-fetch.mjs --from dd.mm.yyyy --to dd.mm.yyyy [--types orders|sales|id,id] [--items xls|html|none]');
  process.exit(1);
}
if (!['xls', 'html', 'none'].includes(ITEMS_MODE)) { console.error('--items must be xls, html or none'); process.exit(1); }
const toDate = (s) => { const [, d, m, y] = s.match(DMY); return new Date(Date.UTC(+y, +m - 1, +d)); };
const fmt = (d) => `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()}`;
if (IS_MAIN && toDate(FROM) > toDate(TO)) { console.error('--from is after --to'); process.exit(1); }

// The 10 channel types known from docs/VAULT.md §7 and the 2026-09-10 crawl.
const SALES_TYPES = ['10036', '10050', '10063', '10058', '10111', '10114', '10112', '10106', '10055', '10099'];
const KNOWN_TYPE_NAMES = { '10063': 'Нарачка in/out', '10058': 'Нарачка in Final' }; // not in this user's form lists

// ── credentials (VAULT §7), never printed ───────────────────────────────────────────────
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

// ── HTTP with a manual cookie jar, pacing, read-only allow-list, redacted logs ────────────
const jar = new Map();
let requests = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const redact = (s) => String(s).replace(/[0-9A-F]{32}/g, '<session>').replace(/JSESSIONID=[^;s]+/gi, 'JSESSIONID=<session>');
const log = (...a) => console.error(redact(a.join(' ')));

function assertReadOnly(method, path, body) {
  const p = path.split('#')[0];
  const form = body ? new URLSearchParams(body) : null;
  const ok =
    (method === 'GET' && p === 'Login?') ||
    (method === 'POST' && p === 'Login') ||
    (method === 'GET' && (p === 'Index?comp=searchdoc' || p === 'Index?comp=repbydocitm')) ||
    (method === 'POST' && p === 'Index?comp=searchdoc&action=search' && form.get('searchMode') === 'search') ||
    (method === 'POST' && p === 'Index?comp=repbydocitm' && ['doSearch', 'exportxls'].includes(form.get('searchMode'))) ||
    (method === 'GET' && /^FileDownload\?path=reports\/&file=DokumentiStavki_[0-9A-F]+\.xls$/.test(p));
  if (!ok) throw new Error(`refusing non-allow-listed request: ${method} ${redact(p)}`);
}

async function http(method, path, body = null) {
  assertReadOnly(method, path, body);
  if (++requests > MAX_REQUESTS) throw new Error(`--max-requests ${MAX_REQUESTS} reached, stopping`);
  if (requests > 1) await sleep(PAUSE_MS);
  const t0 = Date.now();
  const res = await fetch(BASE + path, {
    method,
    body,
    redirect: 'manual',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) elyon-collabbox-fetch/1 (read-only)',
      Accept: 'text/html,application/xhtml+xml,application/vnd.ms-excel,*/*',
      ...(jar.size ? { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    signal: AbortSignal.timeout(180_000),
  });
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const kv = c.split(';')[0];
    const i = kv.indexOf('=');
    jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const ms = Date.now() - t0;
  const shown = redact(path.split('#')[0]);
  log(`  #${requests} ${method} ${shown.length > 90 ? shown.slice(0, 90) + '…' : shown} -> ${res.status} ${buf.length} B ${ms} ms`);
  if (res.status !== 200) throw new Error(`HTTP ${res.status} for ${method} ${redact(path)}`);
  if (ms > 90_000) log('  ! slow answer (>90 s) — their server is under load; consider stopping');
  return { buf, text: buf.toString('utf8'), type: res.headers.get('content-type') || '' };
}

const isLoginPage = (t) => t.length < 200 && t.includes("location.href='./Login");

async function login() {
  const { user, pass } = credentials();
  jar.clear();
  await http('GET', 'Login?');
  const r = await http('POST', 'Login', new URLSearchParams({ company_code: '', username: user, password: pass, browserIsIE: '0' }).toString());
  if (!r.text.includes("location.href='./Index?'")) throw new Error('collabBox login failed (credentials in VAULT §7 rejected?)');
  log('  logged in');
}

/** One retry with a fresh session when the server bounced us to the login page. */
async function authed(method, path, body, rebuildBody) {
  let r = await http(method, path, body);
  if (isLoginPage(r.text)) {
    log('  session expired — logging in again');
    await login();
    r = await http(method, path, rebuildBody ? await rebuildBody() : body);
  }
  return r;
}

// ── HTML helpers ─────────────────────────────────────────────────────────────────────────
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s) => String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return ENT[e.toLowerCase()] ?? m;
});
const cellText = (html) => decode(String(html).replace(/<br\s*\/?>/gi, '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const num = (s) => { const t = String(s ?? '').replace(/[^\d.,-]/g, '').replace(/,/g, ''); return t === '' || t === '-' ? null : Number(t); };
/** "25.09.2026 20:17:03" | "25.09.2026 20:17" | "25.09.2026" -> "2026-09-25T20:17:03" (Skopje wall clock, no offset) */
const isoLocal = (s) => {
  const m = String(s ?? '').match(/(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}` + (m[4] ? `T${m[4]}:${m[5]}:${m[6] ?? '00'}` : '');
};

function attrs(tag) {
  const out = {};
  const body = tag.replace(/^<\s*[a-z0-9]+/i, '').replace(/\/?>$/, '');
  const re = /([^\s=\/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m;
  while ((m = re.exec(body))) { const k = m[1].toLowerCase(); if (!(k in out)) out[k] = m[2] ?? m[3] ?? m[4] ?? ''; }
  return out;
}

/** Browser-faithful serialisation of <form name=…> plus its setCombos() dual lists. */
function readForm(html, formName) {
  const start = html.search(new RegExp(`<form[^>]*name\\s*=\\s*"?${formName}"?`, 'i'));
  if (start < 0) throw new Error(`form "${formName}" not found — collabBox page layout changed?`);
  const end = html.indexOf('</form>', start);
  const f = html.slice(start, end < 0 ? undefined : end);
  const low = f.toLowerCase();
  const pairs = [];
  const selects = {};
  const re = /<(input|select|textarea)\b[^>]*>/gi;
  let m;
  while ((m = re.exec(f))) {
    const tag = m[0];
    const kind = m[1].toLowerCase();
    const a = attrs(tag);
    if (kind === 'select') {
      const close = low.indexOf('</select>', m.index);
      const inner = f.slice(m.index + tag.length, close < 0 ? undefined : close);
      const opts = [];
      for (const o of inner.matchAll(/<option\b([^>]*)>([^<]*)/gi)) {
        const oa = attrs('<option ' + o[1] + '>');
        const text = decode(o[2]).replace(/\s+/g, ' ').trim();
        opts.push({ value: decode('value' in oa ? oa.value : text), text, selected: 'selected' in oa, disabled: 'disabled' in oa });
      }
      if (a.name) selects[a.name] = opts;
      if (close >= 0) re.lastIndex = close;
      if (!a.name || 'disabled' in a) continue;
      if ('multiple' in a) { for (const o of opts) if (o.selected && !o.disabled) pairs.push([a.name, o.value]); }
      else if (opts.length) { const o = [...opts].reverse().find((x) => x.selected) ?? opts.find((x) => !x.disabled); if (o) pairs.push([a.name, o.value]); }
      continue;
    }
    if (kind === 'textarea') {
      const close = low.indexOf('</textarea>', m.index);
      if (a.name && !('disabled' in a)) pairs.push([a.name, decode(f.slice(m.index + tag.length, close))]);
      if (close >= 0) re.lastIndex = close;
      continue;
    }
    if (!a.name || 'disabled' in a) continue;
    const type = (a.type || 'text').toLowerCase();
    if (['button', 'submit', 'image', 'reset', 'file'].includes(type)) continue;
    if ((type === 'checkbox' || type === 'radio') && !('checked' in a)) continue;
    pairs.push([a.name, decode('value' in a ? a.value : type === 'checkbox' || type === 'radio' ? 'on' : '')]);
  }
  const combos = [...f.matchAll(/setCombos\('([^']+)','([^']+)','([^']*)'\)/g)].map((x) => [x[1], x[2], x[3] || ',']);
  return { pairs, selects, combos };
}

function setField(form, name, value) {
  const i = form.pairs.findIndex(([k]) => k === name);
  if (i >= 0) form.pairs[i][1] = value; else form.pairs.push([name, value]);
}

/** HtmlSelectListScript.fillHidden(): every box -> ",v1,v2,"  (empty box -> ","). */
function fillCombos(form, selectedByLeft = {}) {
  const list = (opts, sep, key) => sep + opts.map((o) => String(o[key]).split(sep).join('#$') + sep).join('');
  for (const [left, right, sep] of form.combos) {
    let L = [...(form.selects['sel_' + left] || [])];
    let R = [...(form.selects['sel_' + right] || [])];
    const want = selectedByLeft[left];
    if (want) {
      const all = [...L, ...R];
      L = all.filter((o) => !want.has(String(o.value)));
      R = [...want].map((v) => all.find((o) => String(o.value) === v) ?? { value: v, text: KNOWN_TYPE_NAMES[v] ?? v });
    }
    setField(form, left, list(L, sep, 'value'));
    setField(form, 'captions_' + left, list(L, sep, 'text'));
    setField(form, right, list(R, sep, 'value'));
    setField(form, 'captions_' + right, list(R, sep, 'text'));
  }
}
const encodeForm = (pairs) => pairs.map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');

// ── §2 headers ───────────────────────────────────────────────────────────────────────────
function parseHeaders(html) {
  const total = cellText(html).match(/Вкупно пронајдени\s+(\d+)\s+документ/)?.[1];
  const rows = [];
  for (const part of html.split(/<tr\b/i)) {
    if (!/id="row_\d+"/i.test(part)) continue;
    const body = part.slice(0, part.search(/<\/tr>/i) >= 0 ? part.search(/<\/tr>/i) : undefined);
    const tds = [...body.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((x) => x[1]);
    const ft = body.match(/filter\('Тип на документ','(\d+)','([^']*)'\)/);
    const fk = body.match(/filter\('Комитент','(\d+)','([^']*)'\)/);
    const amountCell = cellText(body.match(/name="labels"[^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? '');
    const dateIdx = tds.findIndex((t) => /^\s*\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}/.test(cellText(t)));
    const when = dateIdx >= 0 ? cellText(tds[dateIdx]) : null;
    rows.push({
      docId: body.match(/name="dokument\d+"\s+value="(\d+)"/i)?.[1] ?? null,
      objectId: body.match(/comp=ovc&(?:amp;)?id=(\d+)/i)?.[1] ?? null,
      docNumber: cellText(body.match(/comp=ovc&(?:amp;)?id=\d+"[^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? '') || null,
      typeId: ft?.[1] ?? null,
      typeName: ft ? decode(ft[2]) : cellText(tds[3] ?? ''),
      customerId: fk?.[1] ?? body.match(/name="komitent\d+"[^>]*value="(\d+)"/i)?.[1] ?? null,
      customerName: fk ? decode(fk[2]).trim() : null,
      amount: num(amountCell),
      currency: amountCell.replace(/[\d.,\s-]/g, '') || null,
      orderRef: dateIdx > 0 ? cellText(tds[dateIdx - 1]) || null : null, // "НалогБр."
      datetime: isoLocal(when),
      datetimeRaw: when,
      author: dateIdx >= 0 ? cellText(tds[dateIdx + 1] ?? '') || null : null,
    });
  }
  return { total: total == null ? null : Number(total), rows };
}

async function fetchHeaders(types, from, to) {
  const body = new URLSearchParams({
    searchMode: 'search', chkDocType: 'chk', selectedDocTypes: ',' + types.join(',') + ',',
    chkDatumOd: 'chk', datumod: from, chkDatumDo: 'chk', datumdo: to, limitResults: '0',
  }).toString();
  const r = await authed('POST', 'Index?comp=searchdoc&action=search', body);
  if (KEEP_RAW) writeFileSync(join(OUT, 'raw', `searchdoc_${from}_${to}.html`), r.buf);
  const p = parseHeaders(r.text);
  if (p.total == null && p.rows.length === 0 && !/Не се пронајдени|не врати резултати/i.test(cellText(r.text))) {
    // no count and no rows is only OK when the page says so; otherwise the layout changed
    if (!/Резултати/.test(r.text)) throw new Error(`searchdoc ${from}..${to}: unrecognised answer (${r.buf.length} B)`);
  }
  if (p.total != null && p.total !== p.rows.length) throw new Error(`searchdoc ${from}..${to}: server says ${p.total}, parsed ${p.rows.length}`);
  return p.rows;
}

// ── §3 line items ────────────────────────────────────────────────────────────────────────
let itemsFormHtml = null;
async function itemsForm(types, from, to, action) {
  if (!itemsFormHtml) itemsFormHtml = (await authed('GET', 'Index?comp=repbydocitm')).text;
  const form = readForm(itemsFormHtml, 'searchform');
  fillCombos(form, { dokTipSelection: new Set(types) });
  setField(form, 'datumod', from);
  setField(form, 'datumdo', to);
  setField(form, 'realdatumod', '');
  setField(form, 'realdatumdo', '');
  setField(form, 'predefiniraniIntervali', '0');
  setField(form, 'limitResults', '0');
  if (action === 'doSearch') { setField(form, 'mode', 'doSearch'); setField(form, 'searchMode', 'doSearch'); }
  else { setField(form, 'mode', 'doListOptions'); setField(form, 'searchMode', 'exportxls'); }
  return encodeForm(form.pairs);
}

const XLS_COLS = {
  'Ред.Бр.': 'rowNo', ID: 'articleId', 'Шифра': 'articleCode', 'Артикл': 'article', 'Оригинална шифра': 'originalCode',
  'Оригинален назив': 'originalName', 'Шифра на комитент': 'customerId', 'Комитент': 'customerName', 'Датум': 'date',
  'Тип на документ': 'typeName', 'Број на документ': 'docNumber', 'Aвтор': 'author', 'Автор': 'author',
  'Група на артикл': 'articleGroup', 'Тип бренд': 'brand', 'Единица мерка': 'unit', 'Сериски број': 'serial',
  'Трошковно место': 'costCenter', 'Профитен центар': 'profitCenter', 'Забелешка': 'note', 'Количина влез': 'qtyIn',
  'Количина излез': 'qtyOut', 'Единечна н. цена': 'unitPurchasePrice', 'Единечна п. цена': 'unitSalePrice',
  'Набавна вредност со ДДВ': 'purchaseValueVat', 'Продажна вредност со ДДВ': 'saleValueVat',
  'Бр. Влезна Фактура': 'inboundInvoiceNo', 'Деловна единица': 'businessUnit', 'Шифра на локација': 'locationCode',
  'Адреса на локација': 'locationAddress', 'Акциза': 'excise', 'Продал': 'soldBy', 'Влезен магацин': 'warehouseIn',
  'Излезен магацин': 'warehouseOut', 'ДДВ на артикл': 'vatRate', 'Даночен индикатор': 'taxIndicator',
};
const NUMERIC = new Set(['qtyIn', 'qtyOut', 'unitPurchasePrice', 'unitSalePrice', 'purchaseValueVat', 'saleValueVat', 'excise', 'vatRate']);

function parseItemsXls(buf) {
  const wb = readXls(buf);
  const rows = xlsUtils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: true });
  const hi = rows.findIndex((r) => r.includes('Број на документ') && r.includes('Артикл'));
  if (hi < 0) throw new Error('xls: header row (Број на документ / Артикл) not found');
  const H = rows[hi].map((h) => String(h).trim());
  const out = [];
  for (const r of rows.slice(hi + 1)) {
    if (!String(r[H.indexOf('Број на документ')] ?? '').trim()) continue; // title/footer/blank rows
    const o = {};
    H.forEach((h, i) => {
      const v = r[i];
      if (!h) { if (v !== '' && v != null) (o.extra ??= {})[`col${i}`] = v; return; }
      const k = XLS_COLS[h] ?? h;
      o[k] = NUMERIC.has(k) ? (v === '' ? null : Number(v)) : typeof v === 'string' ? v.trim() : v;
    });
    o.date = isoLocal(o.date) ?? o.date;
    out.push(o);
  }
  return out;
}

function parseItemsHtml(html) {
  const t0 = html.search(/id="exportX"/i);
  if (t0 < 0) return [];
  const table = html.slice(t0);
  const out = [];
  for (const part of table.split(/<tr\b/i)) {
    if (!/id="row_\d+"/i.test(part)) continue;
    const tds = [...part.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((x) => x[1]);
    if (tds.length < 13) continue;
    const c = tds.map(cellText);
    out.push({
      rowNo: num(c[0]), articleCode: c[1], article: c[2], customerId: c[3], customerName: c[4],
      date: isoLocal(c[5]), dateRaw: c[5], typeName: c[6],
      objectId: tds[6].match(/comp=ovc&(?:amp;)?id=(\d+)/i)?.[1] ?? null,
      docNumber: c[7], author: c[8], articleGroup: c[9], brand: c[10], qtyOut: num(c[11]), saleValueVat: num(c[12]),
    });
  }
  return out;
}

async function fetchItems(types, from, to) {
  if (ITEMS_MODE === 'html') {
    const body = await itemsForm(types, from, to, 'doSearch');
    const r = await authed('POST', 'Index?comp=repbydocitm', body, () => { itemsFormHtml = null; return itemsForm(types, from, to, 'doSearch'); });
    if (KEEP_RAW) writeFileSync(join(OUT, 'raw', `repbydocitm_${from}_${to}.html`), r.buf);
    if (/Не се пронајдени резултати/.test(r.text)) return [];
    const items = parseItemsHtml(r.text);
    if (!items.length) throw new Error(`repbydocitm ${from}..${to}: no rows and no "no results" message`);
    return items;
  }
  const body = await itemsForm(types, from, to, 'exportxls');
  const r = await authed('POST', 'Index?comp=repbydocitm', body, () => { itemsFormHtml = null; return itemsForm(types, from, to, 'exportxls'); });
  if (/не врати резултати|Не се пронајдени резултати/.test(r.text)) return [];
  const link = r.text.match(/\.\/(FileDownload\?path=reports\/&(?:amp;)?file=DokumentiStavki_[0-9A-F]+\.xls)/)?.[1]?.replace(/&amp;/g, '&');
  if (!link) throw new Error(`repbydocitm export ${from}..${to}: no FileDownload link in the answer (${r.buf.length} B)`);
  const x = await http('GET', link);
  if (x.buf.subarray(0, 4).toString('hex') !== 'd0cf11e0') throw new Error(`export ${from}..${to}: not an OLE2 .xls (${x.type})`);
  if (KEEP_RAW) writeFileSync(join(OUT, 'raw', `DokumentiStavki_${from}_${to}.xls`), x.buf);
  return parseItemsXls(x.buf);
}

// ── main ─────────────────────────────────────────────────────────────────────────────────
async function main() {
  mkdirSync(OUT, { recursive: true });
  if (KEEP_RAW) mkdirSync(join(OUT, 'raw'), { recursive: true });
  const started = new Date();
  log(`collabBox fetch ${FROM}..${TO}  types=${TYPES_ARG}  items=${ITEMS_MODE}  chunk=${CHUNK_DAYS}d  pause=${PAUSE_MS}ms`);
  await login();

  // Type catalogue from the live items form (same 89 ids the searchdoc form lists).
  itemsFormHtml = (await authed('GET', 'Index?comp=repbydocitm')).text;
  const catalogue = Object.fromEntries((readForm(itemsFormHtml, 'searchform').selects['sel_dokTipSelection'] || []).map((o) => [o.value, o.text]));
  Object.assign(catalogue, Object.fromEntries(Object.entries(KNOWN_TYPE_NAMES).filter(([k]) => !catalogue[k])));
  let types;
  if (TYPES_ARG === 'orders') types = Object.keys(catalogue).filter((id) => /нарачк/i.test(catalogue[id]));
  else if (TYPES_ARG === 'sales') types = SALES_TYPES;
  else types = TYPES_ARG.split(',').map((s) => s.trim()).filter(Boolean);
  const bad = types.filter((t) => !/^\d+$/.test(t));
  if (bad.length) throw new Error(`bad type id(s): ${bad.join(',')}`);
  const unknown = types.filter((t) => !catalogue[t]);
  if (unknown.length) log(`  ! type id(s) not in this user's form list (still queried): ${unknown.join(',')}`);
  const nameToId = Object.fromEntries(Object.entries(catalogue).map(([id, n]) => [n.replace(/\s+/g, ' ').trim(), id]));

  const headers = [];
  const items = [];
  const chunks = [];
  for (let d = toDate(FROM); d <= toDate(TO); d = new Date(d.getTime() + CHUNK_DAYS * 86_400_000)) {
    const e = new Date(Math.min(d.getTime() + (CHUNK_DAYS - 1) * 86_400_000, toDate(TO).getTime()));
    chunks.push([fmt(d), fmt(e)]);
  }
  for (const [from, to] of chunks) {
    log(`chunk ${from}..${to}`);
    let h = null;
    let it = null;
    if (WANT_HEADERS) { h = await fetchHeaders(types, from, to); headers.push(...h); }
    if (ITEMS_MODE !== 'none') {
      it = await fetchItems(types, from, to);
      for (const x of it) x.typeId = nameToId[String(x.typeName).replace(/\s+/g, ' ').trim()] ?? null;
      items.push(...it);
    }
    log(`  -> ${h ? h.length + ' documents' : ''}${h && it ? ', ' : ''}${it ? it.length + ' line items' : ''}`);
  }

  // per-type summary + cross-checks (headers vs items)
  const perType = {};
  const bump = (id, name) => (perType[id ?? name] ??= { typeId: id, typeName: name, documents: 0, amount: 0, itemDocuments: 0, lineItems: 0, units: 0, itemsValue: 0 });
  for (const h of headers) { const t = bump(h.typeId, h.typeName); t.documents++; t.amount += h.amount ?? 0; }
  const docsWithItems = new Map();
  for (const x of items) {
    const t = bump(x.typeId, x.typeName);
    t.lineItems++; t.units += x.qtyOut ?? 0; t.itemsValue += x.saleValueVat ?? 0;
    if (!docsWithItems.has(x.docNumber)) { docsWithItems.set(x.docNumber, x.typeId ?? x.typeName); t.itemDocuments++; }
  }
  for (const t of Object.values(perType)) { t.amount = Math.round(t.amount * 100) / 100; t.itemsValue = Math.round(t.itemsValue * 100) / 100; t.units = Math.round(t.units * 1000) / 1000; }
  const headerDocs = new Set(headers.map((h) => h.docNumber));
  const checks = WANT_HEADERS && ITEMS_MODE !== 'none'
    ? {
        headerDocsWithoutItems: [...headerDocs].filter((d) => !docsWithItems.has(d)).length,
        itemDocsWithoutHeader: [...docsWithItems.keys()].filter((d) => !headerDocs.has(d)).length,
        duplicateHeaderDocNumbers: headers.length - headerDocs.size,
      }
    : {};

  const stamp = started.toISOString().replace(/[:.]/g, '-');
  const file = join(OUT, `collabbox_${FROM}_${TO}_${stamp}.json`);
  const result = {
    meta: {
      source: 'collabBox (Accent Computers) http://146.255.89.49:8081/naturatherapy',
      from: FROM, to: TO, timezone: 'Europe/Skopje (wall clock, no offset)', currencyNote: 'amounts as shown in collabBox (МКД)',
      types, itemsMode: ITEMS_MODE, chunkDays: CHUNK_DAYS, fetchedAt: started.toISOString(),
      finishedAt: new Date().toISOString(), requests, readOnly: true,
    },
    typeNames: Object.fromEntries(types.map((t) => [t, catalogue[t] ?? null])),
    summary: { documents: headers.length, lineItems: items.length, perType: Object.values(perType).sort((a, b) => b.documents - a.documents || b.lineItems - a.lineItems), checks },
    headers,
    items,
  };
  writeFileSync(file, JSON.stringify(result, null, 1));
  console.log(JSON.stringify({ file, documents: headers.length, lineItems: items.length, requests, perType: result.summary.perType, checks }, null, 1));
}

export { parseHeaders, parseItemsXls, parseItemsHtml, readForm, fillCombos, encodeForm };

if (IS_MAIN) {
  main().catch((e) => { console.error(redact('x ' + (e?.stack || e))); process.exit(1); });
}
