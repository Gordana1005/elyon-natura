/**
 * collabbox-sync — the PURE half: no Deno, no network, no database. index.ts and client.ts import
 * it as "./collabbox.ts"; vitest runs collabbox.test.ts against it in Node.
 *
 * What lives here:
 *   * the parsers of the three collabBox pages the sync reads (document headers comp=searchdoc,
 *     line items comp=repbydocitm, komitent cards comp=infocc) and the browser-faithful
 *     serialisation of the line-items search form — ported from scripts/collabbox-fetch.mjs
 *     (PROTOCOL §0–§4 in its header; KEEP IN STEP) and the 2026-09-10 komitent harvest;
 *   * what a document TYPE does (DOC_ROLES — twin of public.collabbox_doc_role(), the test reads
 *     the migration and fails when the two differ);
 *   * line classification (goods / delivery / note / marker) and the catalogue mapping through
 *     product_aliases + products.sku, stornos, komitent verdicts and phones — ported from
 *     scripts/lib/teleshop-import.mjs (KEEP IN STEP);
 *   * Skopje calendar helpers, the request contract and the run summary.
 * The database decides everything that needs its state (parcels, holders, twins, phones, the
 * department): public.collabbox_apply_documents(), migration 20260942000900.
 */

/** FROZEN — src/lib/currency.ts. The denar is derived; never "update" this. */
export const MKD_PER_EUR = 61.5;

// ─── document types ─────────────────────────────────────────────────────────
/** The nightly re-read: every sales type (the store / replenishment types are not sales). */
export const NIGHTLY_TYPES: readonly string[] = Object.freeze([
  "10036", "10050", "10106", "10114", "10111", "10055", "10107", "10112", "10099", "10063", "10058",
]);
/** The live mode (owner 28.09 ~23:55): the types a seller books during the day. */
export const LIVE_TYPES: readonly string[] = Object.freeze(["10036", "10050", "10111", "10114", "10106"]);
/** Not in this login's form lists; queried by id anyway (collabbox-fetch KNOWN_TYPE_NAMES). */
export const KNOWN_TYPE_NAMES: Readonly<Record<string, string>> = Object.freeze({
  "10063": "Нарачка in/out", "10058": "Нарачка in Final",
});

export type DocRole = "order" | "order_unless_held" | "credit" | "record";
/**
 * What a type does in the CRM (owner 28.09.2026). TWIN of public.collabbox_doc_role() in
 * supabase/migrations/20260942000900_collabbox_nightly_sync.sql — change both.
 */
export const DOC_ROLES: Readonly<Record<string, DocRole>> = Object.freeze({
  "10036": "order",             // Нарачка in        (Телешоп – Lead in)
  "10050": "order",             // Нарачка out       (Телешоп – Lead out)
  "10106": "order",             // Социјални Мрежи
  "10114": "order_unless_held", // LEADS-OUT         (Affiliate – Lead out)
  "10111": "credit",            // Нарачка LEADS     (Affiliate – Lead in, via AlterCPA)
});
export const docRole = (type: unknown): DocRole => DOC_ROLES[String(type ?? "").trim()] ?? "record";
export const isOrderRole = (role: DocRole): boolean => role === "order" || role === "order_unless_held";

// ─── HTML helpers ───────────────────────────────────────────────────────────
const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export function decode(s: unknown): string {
  return String(s ?? "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (m, e: string) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return ENT[e.toLowerCase()] ?? m;
  });
}
/** A cell's text: <BR> joins (collabBox wraps long numbers), tags → space, whitespace collapsed. */
export const cellText = (html: unknown): string =>
  decode(String(html ?? "").replace(/<br\s*\/?>/gi, "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
/** "1,234.50" / "3,000.00 МКД" / "-1,500.00" → number; "" → null (no amount is NOT zero). */
export function num(s: unknown): number | null {
  const t = String(s ?? "").replace(/[^\d.,-]/g, "").replace(/,/g, "");
  if (t === "" || t === "-" || t === ".") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
/** "25.09.2026 20:17:03" | "25.09.2026 20:17" | "25.09.2026" → "2026-09-25T20:17:03" (Skopje wall clock). */
export function isoLocal(s: unknown): string | null {
  const m = String(s ?? "").match(/(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}` + (m[4] ? `T${m[4]}:${m[5]}:${m[6] ?? "00"}` : "");
}
function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const body = tag.replace(/^<\s*[a-z0-9]+/i, "").replace(/\/?>$/, "");
  const re = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const k = m[1].toLowerCase();
    if (!(k in out)) out[k] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return out;
}
/** collabBox answers an expired session with a 43-byte `location.href='./Login?'` page (HTTP 200). */
export const isLoginPage = (text: string): boolean => text.length < 200 && text.includes("location.href='./Login");
/** Never log a session id: 32-hex tokens and JSESSIONID values are masked. */
export const redact = (s: unknown): string =>
  String(s ?? "").replace(/[0-9A-F]{32}/gi, "<session>").replace(/JSESSIONID=[^;\s&]+/gi, "JSESSIONID=<session>");

// ─── §2 document headers (comp=searchdoc) ───────────────────────────────────
export interface HeaderRow {
  docId: string | null; objectId: string | null; docNumber: string | null;
  typeId: string | null; typeName: string; customerId: string | null; customerName: string | null;
  amount: number | null; currency: string | null; orderRef: string | null;
  datetime: string | null; datetimeRaw: string | null; author: string | null;
}
export interface HeadersPage { total: number | null; rows: HeaderRow[]; noResults: boolean; recognised: boolean }

export function parseHeaders(html: string): HeadersPage {
  const text = cellText(html);
  const totalRaw = text.match(/Вкупно пронајдени\s+(\d+)\s+документ/)?.[1];
  const rows: HeaderRow[] = [];
  for (const part of html.split(/<tr\b/i)) {
    if (!/id="row_\d+"/i.test(part)) continue;
    const end = part.search(/<\/tr>/i);
    const body = end >= 0 ? part.slice(0, end) : part;
    const tds = [...body.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((x) => x[1]);
    const ft = body.match(/filter\('Тип на документ','(\d+)','([^']*)'\)/);
    const fk = body.match(/filter\('Комитент','(\d+)','([^']*)'\)/);
    const amountCell = cellText(body.match(/name="labels"[^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? "");
    const dateIdx = tds.findIndex((t) => /^\s*\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}/.test(cellText(t)));
    const when = dateIdx >= 0 ? cellText(tds[dateIdx]) : null;
    rows.push({
      docId: body.match(/name="dokument\d+"\s+value="(\d+)"/i)?.[1] ?? null,
      objectId: body.match(/comp=ovc&(?:amp;)?id=(\d+)/i)?.[1] ?? null,
      docNumber: cellText(body.match(/comp=ovc&(?:amp;)?id=\d+"[^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? "") || null,
      typeId: ft?.[1] ?? null,
      typeName: ft ? decode(ft[2]) : cellText(tds[3] ?? ""),
      customerId: fk?.[1] ?? body.match(/name="komitent\d+"[^>]*value="(\d+)"/i)?.[1] ?? null,
      customerName: fk ? decode(fk[2]).trim() : null,
      amount: num(amountCell),
      currency: amountCell.replace(/[\d.,\s-]/g, "") || null,
      orderRef: dateIdx > 0 ? cellText(tds[dateIdx - 1]) || null : null,
      datetime: isoLocal(when),
      datetimeRaw: when,
      author: dateIdx >= 0 ? cellText(tds[dateIdx + 1] ?? "") || null : null,
    });
  }
  const noResults = /Не се пронајдени|не врати резултати/i.test(text);
  const total = totalRaw == null ? null : Number(totalRaw);
  return { total, rows, noResults, recognised: total != null || rows.length > 0 || noResults || /Резултати/.test(html) };
}

/** The fetcher's two loud failures: an unrecognised page, or a count the rows do not match. */
export function headersProblem(p: HeadersPage): string | null {
  if (!p.recognised) return "unrecognised answer (layout changed?)";
  if (p.total != null && p.total !== p.rows.length) return `server says ${p.total} documents, parsed ${p.rows.length}`;
  if (p.rows.some((r) => !r.docNumber || !r.typeId || !r.datetime)) return "a row without DocNumber / type / time (layout changed?)";
  return null;
}

// ─── §3 line items (comp=repbydocitm, the HTML table) ───────────────────────
export interface ItemRow {
  rowNo: number | null; articleCode: string; article: string; customerId: string; customerName: string;
  date: string | null; dateRaw: string; typeName: string; objectId: string | null; docNumber: string;
  author: string; articleGroup: string; brand: string; qtyOut: number | null; saleValueVat: number | null;
}
export interface ItemsPage { items: ItemRow[]; noResults: boolean; hasTable: boolean }

/** 13 columns: Бр. | Шифра | Артикл | Шифра на комитент | Комитент | Датум | Тип на документ |
 *  Број на документ | Автор | Група на артикл | Тип бренд | Количина излез | Продажна вредност со ддв.
 *  The totals row (no DocNumber) is dropped. */
export function parseItemsHtml(html: string): ItemsPage {
  const noResults = /Не се пронајдени резултати|не врати резултати/i.test(html);
  const t0 = html.search(/id="exportX"/i);
  if (t0 < 0) return { items: [], noResults, hasTable: false };
  const items: ItemRow[] = [];
  for (const part of html.slice(t0).split(/<tr\b/i)) {
    if (!/id="row_\d+"/i.test(part)) continue;
    const tds = [...part.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((x) => x[1]);
    if (tds.length < 13) continue;
    const c = tds.map(cellText);
    if (!c[7]) continue;
    items.push({
      rowNo: num(c[0]), articleCode: c[1], article: c[2], customerId: c[3], customerName: c[4],
      date: isoLocal(c[5]), dateRaw: c[5], typeName: c[6],
      objectId: tds[6].match(/comp=ovc&(?:amp;)?id=(\d+)/i)?.[1] ?? null,
      docNumber: c[7], author: c[8], articleGroup: c[9], brand: c[10], qtyOut: num(c[11]), saleValueVat: num(c[12]),
    });
  }
  return { items, noResults, hasTable: true };
}

// ─── the komitent card (comp=infocc search, the 2026-09-10 harvest's table) ──
export interface KomitentRow {
  komitentId: string; objectId: string | null; name: string; nameLat: string; address: string; addressLat: string;
  city: string; country: string; phone: string; mobile: string; email: string; bankAccount: string;
  cardNo: string; taxNumber: string; vraboten: string;
}
/** Rows of `id="table_exp"`: each carries a `popust_<Шифра>` checkbox and ≥ 21 `tdList` cells
 *  (2 Шифра · 3 Име · 4 Име лат. · 5 Адреса · 6 Адреса лат. · 7 Град · 8 Држава · 9 Датум раѓање ·
 *  10 Телефон · 11 Мобилен · 12 Email · 13 Жиро сметка · 14 Број картичка · 15 Даночен број · …
 *  20 Вработен). */
export function parseKomitentSearch(html: string): { rows: KomitentRow[]; hasTable: boolean } {
  const t0 = html.indexOf('id="table_exp"');
  if (t0 < 0) return { rows: [], hasTable: false };
  const rows: KomitentRow[] = [];
  for (const part of html.slice(t0).split(/<tr\b/i)) {
    const code = part.match(/name="popust_(\d+)"/i)?.[1];
    if (!code) continue;
    const cells = [...part.matchAll(/<td\b[^>]*class\s*=\s*"tdList"[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => cellText(m[1]));
    if (cells.length < 21) continue;
    rows.push({
      komitentId: code || cells[2], objectId: part.match(/comp=ovc&(?:amp;)?id=(\d+)/i)?.[1] ?? null,
      name: cells[3], nameLat: cells[4], address: cells[5], addressLat: cells[6], city: cells[7], country: cells[8],
      phone: cells[10], mobile: cells[11], email: cells[12], bankAccount: cells[13], cardNo: cells[14],
      taxNumber: cells[15], vraboten: cells[20],
    });
  }
  return { rows, hasTable: true };
}

// ─── the line-items search form, serialised as a browser would ──────────────
export interface FormOption { value: string; text: string; selected: boolean; disabled: boolean }
export interface ParsedForm { pairs: [string, string][]; selects: Record<string, FormOption[]>; combos: [string, string, string][] }

/** Browser-faithful serialisation of <form name=…> plus its setCombos() dual lists. */
export function readForm(html: string, formName: string): ParsedForm {
  const start = html.search(new RegExp(`<form[^>]*name\\s*=\\s*"?${formName}"?`, "i"));
  if (start < 0) throw new Error(`form "${formName}" not found — collabBox page layout changed?`);
  const end = html.indexOf("</form>", start);
  const f = html.slice(start, end < 0 ? undefined : end);
  const low = f.toLowerCase();
  const pairs: [string, string][] = [];
  const selects: Record<string, FormOption[]> = {};
  const re = /<(input|select|textarea)\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(f))) {
    const tag = m[0];
    const kind = m[1].toLowerCase();
    const a = attrs(tag);
    if (kind === "select") {
      const close = low.indexOf("</select>", m.index);
      const inner = f.slice(m.index + tag.length, close < 0 ? undefined : close);
      const opts: FormOption[] = [];
      for (const o of inner.matchAll(/<option\b([^>]*)>([^<]*)/gi)) {
        const oa = attrs("<option " + o[1] + ">");
        const text = decode(o[2]).replace(/\s+/g, " ").trim();
        opts.push({ value: decode("value" in oa ? oa.value : text), text, selected: "selected" in oa, disabled: "disabled" in oa });
      }
      if (a.name) selects[a.name] = opts;
      if (close >= 0) re.lastIndex = close;
      if (!a.name || "disabled" in a) continue;
      if ("multiple" in a) {
        for (const o of opts) if (o.selected && !o.disabled) pairs.push([a.name, o.value]);
      } else if (opts.length) {
        const o = [...opts].reverse().find((x) => x.selected) ?? opts.find((x) => !x.disabled);
        if (o) pairs.push([a.name, o.value]);
      }
      continue;
    }
    if (kind === "textarea") {
      const close = low.indexOf("</textarea>", m.index);
      if (a.name && !("disabled" in a)) pairs.push([a.name, decode(f.slice(m.index + tag.length, close < 0 ? undefined : close))]);
      if (close >= 0) re.lastIndex = close;
      continue;
    }
    if (!a.name || "disabled" in a) continue;
    const type = (a.type || "text").toLowerCase();
    if (["button", "submit", "image", "reset", "file"].includes(type)) continue;
    if ((type === "checkbox" || type === "radio") && !("checked" in a)) continue;
    pairs.push([a.name, decode("value" in a ? a.value : type === "checkbox" || type === "radio" ? "on" : "")]);
  }
  const combos = [...f.matchAll(/setCombos\('([^']+)','([^']+)','([^']*)'\)/g)]
    .map((x) => [x[1], x[2], x[3] || ","] as [string, string, string]);
  return { pairs, selects, combos };
}
export function setField(form: ParsedForm, name: string, value: string): void {
  const i = form.pairs.findIndex(([k]) => k === name);
  if (i >= 0) form.pairs[i][1] = value; else form.pairs.push([name, value]);
}
/** HtmlSelectListScript.fillHidden(): every box → ",v1,v2,"; an EMPTY box is exactly "," (never ",,"). */
export function fillCombos(form: ParsedForm, selectedByLeft: Record<string, Set<string>> = {}): void {
  const list = (opts: { value: string; text: string }[], sep: string, key: "value" | "text") =>
    sep + opts.map((o) => String(o[key]).split(sep).join("#$") + sep).join("");
  for (const [left, right, sep] of form.combos) {
    let L = [...(form.selects["sel_" + left] || [])];
    let R = [...(form.selects["sel_" + right] || [])];
    const want = selectedByLeft[left];
    if (want) {
      const all = [...L, ...R];
      L = all.filter((o) => !want.has(String(o.value)));
      R = [...want].map((v) => all.find((o) => String(o.value) === v)
        ?? { value: v, text: KNOWN_TYPE_NAMES[v] ?? v, selected: false, disabled: false });
    }
    setField(form, left, list(L, sep, "value"));
    setField(form, "captions_" + left, list(L, sep, "text"));
    setField(form, right, list(R, sep, "value"));
    setField(form, "captions_" + right, list(R, sep, "text"));
  }
}
export const encodeForm = (pairs: [string, string][]): string =>
  pairs.map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v)).join("&");

/** The line-items search for [from, to] (dd.mm.yyyy) of `types`, HTML table mode ("Потврди"). */
export function itemsSearchBody(formHtml: string, types: readonly string[], fromDmy: string, toDmy: string): string {
  const form = readForm(formHtml, "searchform");
  fillCombos(form, { dokTipSelection: new Set(types) });
  setField(form, "datumod", fromDmy);
  setField(form, "datumdo", toDmy);
  setField(form, "realdatumod", "");
  setField(form, "realdatumdo", "");
  setField(form, "predefiniraniIntervali", "0");
  setField(form, "limitResults", "0");
  setField(form, "mode", "doSearch");
  setField(form, "searchMode", "doSearch");
  return encodeForm(form.pairs);
}
/** The header search (§2): COMMA-WRAPPED type ids — a bare id matches nothing. */
export function headersSearchBody(types: readonly string[], fromDmy: string, toDmy: string): string {
  return new URLSearchParams({
    searchMode: "search", chkDocType: "chk", selectedDocTypes: "," + types.join(",") + ",",
    chkDatumOd: "chk", datumod: fromDmy, chkDatumDo: "chk", datumdo: toDmy, limitResults: "0",
  }).toString();
}
/** The komitent search by Шифра (the 2026-09-10 harvest's field set, one page). */
export function komitentSearchBody(komitentId: string): string {
  return new URLSearchParams({
    searchMode: "search", name1: "", id: komitentId, address: "", city: "", opstina: "", regionId: "",
    drzavaId: "", taxnum: "", telnum: "", mobilen: "", bankacc: "", prikaziKartica: "1", brojKartica: "",
    lettersubmit: "0", language: "1", showAllResults: "", pageNum: "50",
  }).toString();
}
export const KOMITENT_SEARCH_PATH = "Index?comp=infocc&action=search&pgsf=0&cp=1";

// ─── names, markers, phones (scripts/lib/teleshop-import.mjs — KEEP IN STEP) ──
const NAME_ENTITIES: Record<string, string> = { "&#40;": "(", "&#41;": ")", "&amp;": "&", "&quot;": '"', "&#39;": "'", "&#34;": '"', "&lt;": "<", "&gt;": ">", "&nbsp;": " " };
/** A name as written — HTML entities decoded, whitespace collapsed, trimmed. */
export function cleanName(raw: unknown): string {
  let s = String(raw ?? "");
  s = s.replace(/&#(\d+);/g, (m, n) => NAME_ENTITIES[m] ?? String.fromCodePoint(Number(n)));
  s = s.replace(/&[a-z]+;/gi, (m) => NAME_ENTITIES[m.toLowerCase()] ?? m);
  return s.replace(/\s+/g, " ").trim();
}
/** What an operator wrote INTO a customer name. */
export const NAME_MARKERS: ReadonlyArray<[string, RegExp]> = Object.freeze([
  ["deceased", /почин|почнат|почиан|умре|pocin|umre/iu],
  ["do_not_contact", /не\s*(го|ја|ги|и)?\s*(контакт|бара|барај|се\s+јав|јавува|звони|ѕвони)|да\s+не\s+се\s+контакт|ne\s+kontakt|блокира/iu],
  ["wrong_number", /(згрешен|погрешен|грешен)\s+број|wrong\s+number|непостоечки/iu],
  ["test", /(^|[^\p{L}])(тест|test|проба)([^\p{L}]|$)/iu],
] as [string, RegExp][]);
export const RETURNS_MARKER = /враќа\s+(нарачки|пратки)|ги\s+враќа|не\s+прима/iu;
export function nameMarker(name: unknown): string | null {
  const n = cleanName(name);
  for (const [key, re] of NAME_MARKERS) if (re.test(n)) return key;
  return null;
}
/** Legal entities, shops and institutions — not retail customers. */
export const COMPANY_RE = /(ДООЕЛ|ДОО\b|\bАД\b|DOOEL|\bDOO\b|АПТЕКА|APTEKA|ПРОДАВНИЦА|МАРКЕТ|MARKET|\bТП\b|ЛИМАК|СИТИ\s*МОЛ|ФАРМАЦИЈА|PHARM|ОПШТИНА|БОЛНИЦА|ДОМ\s+ЗА\s+СТАРИ|ЗАВОД|КЛИНИКА|ОРДИНАЦИЈА|ХОТЕЛ|РЕСТОРАН|ЗДРУЖЕНИЕ|ФОНДАЦИЈА|УЧИЛИШТЕ|ГРАДИНКА|ПУСЗ|МЕДИ\s*ФАРМ)/iu;

/**
 * The Macedonian national significant number: 8 digits, mobile 7X, Skopje 2, area codes 31–34 and
 * 42–48. Anything else is REJECTED, never rewritten into a fake +389 number.
 * TWIN: public.collabbox_mk_phone8() and scripts/lib/teleshop-import.mjs MK_NSN_RE.
 */
export const MK_NSN_RE = /^(7\d{7}|2\d{7}|3[1-4]\d{6}|4[2-8]\d{6})$/;
export interface Phone8 { p8: string | null; why?: string; kind?: "mobile" | "landline" }
function onePhone(part: string): Phone8 {
  const t = String(part).trim();
  let d = t.replace(/\D/g, "");
  if (!d) return { p8: null, why: "empty" };
  if (t.startsWith("+") || d.startsWith("00")) {
    if (d.startsWith("00")) d = d.slice(2);
    if (!d.startsWith("389")) return { p8: null, why: "foreign" };
    d = d.slice(3);
    if (d.startsWith("0")) d = d.slice(1);
  } else if (d.startsWith("389") && (d.length === 11 || d.length === 12)) {
    d = d.slice(3);
    if (d.startsWith("0")) d = d.slice(1);
  } else if (d.startsWith("0")) {
    d = d.slice(1);
  }
  if (d.length !== 8) return { p8: null, why: d.length < 8 ? "too_short" : "too_long" };
  if (!MK_NSN_RE.test(d)) return { p8: null, why: "not_mk_range" };
  return { p8: d, kind: d.startsWith("7") ? "mobile" : "landline" };
}
/** A phone as typed ("070/123-456", "071234567 или 072345678", "+389 70 123 456") → its 8 digits. */
export function mkPhone8(raw: unknown): Phone8 {
  const s = String(raw ?? "").trim();
  if (!s || /^(null|nan|\/|-|0|x+)$/i.test(s)) return { p8: null, why: "empty" };
  if (/e\+/i.test(s)) return { p8: null, why: "scientific" };
  if (/^[\d\s/\-.()+]+$/.test(s)) {
    const nd = s.replace(/\D/g, "").length;
    if (nd >= 8 && nd <= 12) { const w = onePhone(s); if (w.p8) return w; }
  }
  const parts = s.split(/\s*(?:[/,;:]|(?<![\p{L}])(?:или|ИЛИ|ili|ILI)(?![\p{L}]))\s*/u).filter(Boolean);
  let firstWhy: string | undefined;
  for (const part of parts.length ? parts : [s]) {
    const r = onePhone(part);
    if (r.p8) return r;
    firstWhy ??= r.why;
  }
  const groups = s.replace(/[^\d+ ]/g, " ").split(/\s+/).filter((g) => g.replace(/\D/g, "").length >= 8);
  if (groups.length > 1) for (const g of groups) { const r = onePhone(g); if (r.p8) return r; }
  return { p8: null, why: firstWhy || "invalid" };
}

/** Komitent ids below this are the legacy register, where Vraboten = Да is a stale default. */
export const LEGACY_KOMITENT_BELOW = 40000;
/** The card as the writer stores it (public.collabbox_customers). */
export interface KomitentCard {
  komitent_id: string; object_id: string | null; name: string | null; phone8: string | null;
  phone_field: "mobilen" | "telefon" | null; phone_raw: string | null; city: string | null;
  address: string | null; skip_reason: string | null; flags: string[];
}
/**
 * A komitent card → the phone (Мобилен first, then Телефон) and the verdict the teleshop import
 * used: employee (Вработен = Да on the current register, or "вработен/а" in the name), company
 * (tax number, bank account or a company name), deceased / wrong number / test in the name.
 * Do-not-contact is imported (owner 28.09) — only flagged.
 */
export function komitentCard(row: KomitentRow): KomitentCard {
  const name = cleanName(row.name);
  const m = mkPhone8(row.mobile);
  const t = m.p8 ? null : mkPhone8(row.phone);
  const p8 = m.p8 ?? t?.p8 ?? null;
  const flags: string[] = [];
  let skip: string | null = null;
  const isDa = String(row.vraboten ?? "").trim() === "Да";
  const legacy = Number(row.komitentId) < LEGACY_KOMITENT_BELOW;
  if (/вработен/iu.test(name) || (isDa && !legacy)) skip = "employee";
  else if (String(row.taxNumber ?? "").trim() || String(row.bankAccount ?? "").trim() || COMPANY_RE.test(name)) skip = "company";
  else {
    const marker = nameMarker(name);
    if (marker === "do_not_contact") flags.push("do_not_contact");
    else if (marker) skip = marker;
  }
  if (RETURNS_MARKER.test(name)) flags.push("returns_orders");
  if (isDa && legacy) flags.push("vraboten_legacy_flag");
  return {
    komitent_id: row.komitentId, object_id: row.objectId || null, name: name || null, phone8: p8,
    phone_field: m.p8 ? "mobilen" : p8 ? "telefon" : null,
    phone_raw: [row.mobile, row.phone].map((x) => String(x ?? "").trim()).filter(Boolean).join(" | ") || null,
    city: cleanName(row.city) || null, address: cleanName(row.address) || null, skip_reason: skip, flags,
  };
}
/** The header's komitent name alone (no card yet): the same markers + a company name. */
export function nameVerdict(name: unknown): { skip: string | null; flags: string[] } {
  const n = cleanName(name);
  if (!n) return { skip: null, flags: [] };
  if (COMPANY_RE.test(n)) return { skip: "company", flags: [] };
  const marker = nameMarker(n);
  if (marker === "do_not_contact") return { skip: null, flags: ["do_not_contact"] };
  return { skip: marker, flags: [] };
}

// ─── lines ──────────────────────────────────────────────────────────────────
export type LineRole = "goods" | "delivery" | "note" | "marker";
/** TWIN of public.product_alias_norm(): lower-case, trimmed, inner whitespace collapsed. */
export const aliasNorm = (name: unknown): string | null => {
  const t = String(name ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  return t || null;
};
/**
 * What a line is. A reviewed alias kind decides first (product_aliases: product / gift → goods ·
 * delivery · note · loyalty_point / flyer → marker); then the codes and names the imports use:
 * 8001 / "ДОСТАВА" delivery · 8004, ПОЕН-*, КУПОН, ФЛАЕР markers (0-value loyalty lines) ·
 * 8002 / "ЗАБЕЛЕШКА…" notes (a "ДОСТАВА …" line worth nothing is an instruction, i.e. a note).
 */
export function lineRole(code: unknown, name: unknown, value: number, aliasKind?: string | null): LineRole {
  const k = String(aliasKind ?? "").toLowerCase();
  if (k === "product" || k === "gift") return "goods";
  if (k === "delivery") return "delivery";
  if (k === "note") return "note";
  if (k === "loyalty_point" || k === "flyer") return "marker";
  const c = String(code ?? "").trim();
  const n = String(name ?? "").trim();
  if (c === "8001") return "delivery";
  if (c === "8004" || /^поен/iu.test(c) || /^(поен|купон|флаер)/iu.test(n) || /купон/iu.test(n)) return "marker";
  if (/^достава\s*$/iu.test(n)) return "delivery";
  if (c === "8002" || /^забелешк/iu.test(n)) return "note";
  if (/^достав/iu.test(n)) return value > 0 ? "delivery" : "note";
  return "goods";
}

export interface AliasRow { source: string; alias_norm: string; product_id: string | null; kind: string }
export interface ProductRow { id: string; sku: string | null; name: string; is_active: boolean | null }
export interface Catalogue {
  aliases: Map<string, { product_id: string | null; kind: string }>;
  skus: Map<string, { id: string; name: string }>;
  names: Map<string, string>;
}
/** product_aliases (collabbox, then 'any') + products.sku (active first) → the line mapper. */
export function buildCatalogue(aliasRows: AliasRow[], productRows: ProductRow[]): Catalogue {
  const aliases = new Map<string, { product_id: string | null; kind: string }>();
  for (const a of aliasRows) {
    if (a.source !== "collabbox" && a.source !== "any") continue;
    aliases.set(`${a.source}:${a.alias_norm}`, { product_id: a.product_id ?? null, kind: String(a.kind || "product") });
  }
  const skus = new Map<string, { id: string; name: string }>();
  for (const p of [...productRows].sort((x, y) => Number(!!x.is_active) - Number(!!y.is_active))) {
    const sku = String(p.sku ?? "").trim();
    if (sku) skus.set(sku, { id: p.id, name: p.name });   // the active one is set last and wins
  }
  const names = new Map(productRows.map((p) => [p.id, p.name] as [string, string]));
  return { aliases, skus, names };
}

export interface DocLine {
  code: string; name: string; qty: number; value_mkd: number; role: LineRole;
  product_id: string | null; product_name: string | null;
}
export function classifyLine(item: Pick<ItemRow, "articleCode" | "article" | "qtyOut" | "saleValueVat">, cat: Catalogue | null): DocLine {
  const code = String(item.articleCode ?? "").trim();
  const name = cleanName(item.article);
  const value = Number(item.saleValueVat) || 0;
  const qty = Number(item.qtyOut) || 0;
  const norm = aliasNorm(name);
  const alias = norm && cat ? (cat.aliases.get(`collabbox:${norm}`) ?? cat.aliases.get(`any:${norm}`) ?? null) : null;
  const role = lineRole(code, name, value, alias?.kind);
  let productId: string | null = null;
  if (role === "goods" && cat) productId = alias?.product_id ?? cat.skus.get(code)?.id ?? null;
  return {
    code, name, qty, value_mkd: value, role, product_id: productId,
    product_name: productId ? (cat?.names.get(productId) ?? name) : null,
  };
}

/** A reversal document: a negative amount, or no / zero amount and a negative line. */
export function isStorno(amount: number | null, lines: Pick<DocLine, "qty" | "value_mkd">[]): boolean {
  if (amount != null && amount < 0) return true;
  const negative = lines.some((l) => l.value_mkd < 0 || l.qty < 0);
  return negative && (amount == null || amount <= 0);
}
export function stornoValue(doc: Pick<SyncDoc, "amount_mkd" | "lines">): number {
  const neg = doc.lines.filter((l) => l.value_mkd < 0).reduce((s, l) => s + l.value_mkd, 0);
  return Math.abs(neg) || Math.abs(doc.amount_mkd ?? 0);
}

// ─── documents ──────────────────────────────────────────────────────────────
export interface SyncDoc {
  doc_number: string; doc_id: string | null; object_id: string | null; type_id: string; type_name: string | null;
  role: DocRole; komitent_id: string | null; komitent_name: string | null; amount_mkd: number | null;
  currency: string | null; doc_at: string; day: string; author: string | null;
  lines: DocLine[]; lines_complete: boolean; storno: boolean;
  reverses: string | null; reversed_by: string | null; flags: string[];
  name_skip: string | null; name_flags: string[]; komitent: KomitentCard | null;
}
export interface BuildWarnings { items_without_header: number; duplicate_doc_numbers: string[]; unknown_type_rows: number }

/**
 * One day's headers (+ its line items, or null when they could not be read) → the documents the
 * writer receives. A DocNumber that appears twice is kept once and flagged (never an order).
 */
export function buildDocuments(headers: HeaderRow[], items: ItemRow[] | null, cat: Catalogue | null, day: string):
  { docs: SyncDoc[]; warnings: BuildWarnings } {
  const linesBy = new Map<string, DocLine[]>();
  for (const it of items ?? []) {
    const d = String(it.docNumber ?? "").trim();
    if (!d) continue;
    (linesBy.get(d) ?? linesBy.set(d, []).get(d)!).push(classifyLine(it, cat));
  }
  const seen = new Map<string, SyncDoc>();
  const duplicates = new Set<string>();
  let unknownType = 0;
  for (const h of headers) {
    const docNumber = String(h.docNumber ?? "").trim();
    if (!docNumber || !h.typeId || !h.datetime) { unknownType++; continue; }
    if (seen.has(docNumber)) { duplicates.add(docNumber); continue; }
    const lines = linesBy.get(docNumber) ?? [];
    const verdict = nameVerdict(h.customerName);
    seen.set(docNumber, {
      doc_number: docNumber, doc_id: h.docId, object_id: h.objectId, type_id: String(h.typeId), type_name: h.typeName || null,
      role: docRole(h.typeId), komitent_id: h.customerId, komitent_name: h.customerName ? cleanName(h.customerName) : null,
      amount_mkd: h.amount, currency: h.currency, doc_at: h.datetime, day,
      author: h.author ? h.author.replace(/\s+/g, " ").trim() || null : null,
      lines, lines_complete: items !== null, storno: isStorno(h.amount, lines),
      reverses: null, reversed_by: null, flags: [], name_skip: verdict.skip, name_flags: verdict.flags, komitent: null,
    });
  }
  for (const d of duplicates) seen.get(d)!.flags.push("duplicate_doc_number");
  const headerDocs = new Set(seen.keys());
  const itemsWithoutHeader = [...linesBy.keys()].filter((d) => !headerDocs.has(d)).length;
  return { docs: [...seen.values()], warnings: { items_without_header: itemsWithoutHeader, duplicate_doc_numbers: [...duplicates], unknown_type_rows: unknownType } };
}

/**
 * Stornos inside the window: the document a storno reverses = the same komitent's earlier
 * non-storno document worth exactly the reversed value (±1 ден) — only when exactly ONE fits
 * (teleshop-import's rule). The writer searches the ledgers for the ones not found here.
 */
export function pairStornos(docs: SyncDoc[]): { storno: string; original: string | null; candidates: number }[] {
  const out: { storno: string; original: string | null; candidates: number }[] = [];
  for (const st of docs.filter((d) => d.storno).sort((a, b) => a.doc_at.localeCompare(b.doc_at))) {
    const value = stornoValue(st);
    const cands = value > 0 && st.komitent_id
      ? docs.filter((o) => !o.storno && o.doc_number !== st.doc_number && o.komitent_id === st.komitent_id
          && o.amount_mkd != null && Math.abs(o.amount_mkd - value) <= 1 && o.doc_at <= st.doc_at && !o.reversed_by)
      : [];
    const original = cands.length === 1 ? cands[0] : null;
    if (original) { st.reverses = original.doc_number; original.reversed_by = st.doc_number; }
    out.push({ storno: st.doc_number, original: original?.doc_number ?? null, candidates: cands.length });
  }
  return out;
}

/** What the live mode books: the header only. */
export function bookedHeader(h: HeaderRow) {
  return {
    doc_number: h.docNumber, doc_id: h.docId, object_id: h.objectId, type_id: h.typeId, type_name: h.typeName || null,
    komitent_id: h.customerId, komitent_name: h.customerName ? cleanName(h.customerName) : null,
    amount_mkd: h.amount, doc_at: h.datetime, author: h.author ? h.author.replace(/\s+/g, " ").trim() || null : null,
    storno: h.amount != null && h.amount < 0,
  };
}

// ─── Skopje calendar ────────────────────────────────────────────────────────
const SKOPJE_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Skopje", year: "numeric", month: "2-digit", day: "2-digit" });
/** The Skopje calendar day (YYYY-MM-DD) of an instant. */
export const skopjeDate = (ms: number = Date.now()): string => SKOPJE_DATE.format(new Date(ms));
export const isYmd = (s: unknown): s is string => {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(s + "T00:00:00Z");
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
};
export const addDays = (ymd: string, n: number): string => new Date(Date.parse(ymd + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);
export function dayRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 62; d = addDays(d, 1)) out.push(d);
  return out;
}
/** YYYY-MM-DD → dd.mm.yyyy (collabBox's date fields). */
export const toDmy = (ymd: string): string => `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}.${ymd.slice(0, 4)}`;

// ─── the request ────────────────────────────────────────────────────────────
export type SyncMode = "nightly" | "live" | "manual";
export interface SyncRequest {
  mode: SyncMode; dry: boolean; from: string | null; to: string | null; days: number;
  trigger: "cron" | "manual"; background: boolean;
}
export const MAX_WINDOW_DAYS = 14;
/**
 * The body contract:
 *   { mode: 'nightly' | 'live' | 'manual' (default manual), dry_run?: true,
 *     from?: 'YYYY-MM-DD', to?: 'YYYY-MM-DD' (manual only; ≤ 14 days, not after today),
 *     days?: 1–14 (the nightly window, default 3), trigger?: 'cron', wait?: true }
 * A run that WRITES orders (nightly / manual, not dry) answers 202 at once and works in the
 * background — the writer batches and card lookups can outlast a synchronous answer (~150 s);
 * `wait: true` keeps it synchronous. A dry run and the (≤ 3-request) live run always answer when done.
 */
export function parseRequest(body: unknown, todayYmd: string): { ok: true; req: SyncRequest } | { ok: false; error: string } {
  const b = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const mode = b.mode === undefined ? "manual" : b.mode;
  if (mode !== "nightly" && mode !== "live" && mode !== "manual") return { ok: false, error: "mode must be nightly, live or manual" };
  const dry = b.dry_run === true || b.dry === true;
  const trigger = b.trigger === "cron" ? "cron" : "manual";
  let days = 3;
  if (b.days !== undefined) {
    const n = Number(b.days);
    if (!Number.isInteger(n) || n < 1 || n > MAX_WINDOW_DAYS) return { ok: false, error: `days must be 1–${MAX_WINDOW_DAYS}` };
    days = n;
  }
  let from: string | null = null, to: string | null = null;
  if (b.from !== undefined || b.to !== undefined) {
    if (mode !== "manual") return { ok: false, error: "from / to are for mode manual only" };
    from = (b.from ?? b.to) as string;
    to = (b.to ?? b.from) as string;
    if (!isYmd(from) || !isYmd(to)) return { ok: false, error: "from / to must be YYYY-MM-DD" };
    if (from > to) return { ok: false, error: "from is after to" };
    if (to > todayYmd) return { ok: false, error: "to is in the future" };
    if (dayRange(from, to).length > MAX_WINDOW_DAYS) return { ok: false, error: `at most ${MAX_WINDOW_DAYS} days per run` };
  }
  const background = !dry && mode !== "live" && b.wait !== true;
  return { ok: true, req: { mode, dry, from, to, days, trigger, background } };
}

// ─── batching and the run summary ───────────────────────────────────────────
export function chunk<T>(xs: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += Math.max(1, n)) out.push(xs.slice(i, i + Math.max(1, n)));
  return out;
}
/** One result row of public.collabbox_apply_documents(). */
export interface ApplyResult {
  doc: string; type?: string; role?: string; outcome: string; reason?: string | null;
  order_id?: string | null; related_order_id?: string | null; credit?: string | null;
  status?: string | null; price_eur?: number | null; unmapped?: number; flags?: string[];
  department?: string[] | null; phone_source?: string | null;
}
const bump = (o: Record<string, number>, k: string, n = 1) => { o[k] = (o[k] || 0) + n; };
/**
 * The lists the run keeps (≤ 100 each): conflicts with the order in the way, documents without a
 * phone, unmapped line names of created orders, stornos, flags — and counts by outcome / reason.
 */
export function summarizeResults(results: ApplyResult[], docsByNumber: Map<string, SyncDoc> = new Map()) {
  const outcomes: Record<string, number> = {};
  const reasons: Record<string, number> = {};
  const flags: Record<string, number> = {};
  const unmapped: Record<string, number> = {};
  const createdByStatus: Record<string, number> = {};
  const conflicts: { doc: string; reason: string | null; related_order_id: string | null }[] = [];
  const noPhone: string[] = [];
  const stornos: { doc: string; reason: string | null }[] = [];
  const errors: { doc: string; reason: string | null }[] = [];
  let createdEur = 0;
  for (const r of results) {
    bump(outcomes, r.outcome);
    if (r.reason) bump(reasons, `${r.outcome}:${r.reason}`);
    for (const f of r.flags ?? []) bump(flags, f);
    if (r.outcome === "created") {
      bump(createdByStatus, String(r.status ?? "?"));
      createdEur += Number(r.price_eur) || 0;
      for (const l of docsByNumber.get(r.doc)?.lines ?? []) {
        if (l.role === "goods" && !l.product_id && (l.qty > 0 || l.value_mkd > 0) && Object.keys(unmapped).length < 100) {
          bump(unmapped, `${l.code || "-"} ${l.name}`.trim());
        }
      }
    }
    if (r.outcome === "conflict" && conflicts.length < 100) conflicts.push({ doc: r.doc, reason: r.reason ?? null, related_order_id: r.related_order_id ?? null });
    if (r.outcome === "no_phone" && noPhone.length < 100) noPhone.push(r.doc);
    if (r.outcome === "storno" && stornos.length < 100) stornos.push({ doc: r.doc, reason: r.reason ?? null });
    if (r.outcome === "error" && errors.length < 50) errors.push({ doc: r.doc, reason: r.reason ?? null });
  }
  return {
    outcomes, reasons, flags, unmapped, created: { by_status: createdByStatus, eur: Math.round(createdEur * 100) / 100 },
    conflicts, no_phone: noPhone, stornos, errors,
  };
}
