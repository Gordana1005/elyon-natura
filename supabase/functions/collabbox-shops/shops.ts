/**
 * collabbox-shops — the PURE half: no Deno, no network, no database. index.ts and client.ts import
 * it as "./shops.ts"; vitest runs shops.test.ts against it (and the fixtures/ pages) in Node.
 *
 * The 22 shops of НАТУРА ТЕРАПИ СТОРЕС ДООЕЛ run their tills on collabBox (the same server the
 * collabbox-sync function reads for the teleshop). This module knows:
 *   * the document types the shops reader may read (and the ones it must never add up);
 *   * the browser-faithful bodies of the five report forms it posts (docs/SHOPS.md "Facts"):
 *       repbydocitm (document lines)  · searchdoc (document headers) · infollc (stock per shop)
 *       lnp (opening / in / out / closing per period) · tkreport (the trade book: cash / card)
 *   * the parsers of those five answers, header-driven (a column is found by its caption, so a
 *     re-ordered or extra column never shifts a number into the wrong field);
 *   * what a line IS for a shop (signed units, loyalty ПОЕН lines, retail returns), the Skopje
 *     calendar and the request contract.
 *
 * PII: a retail line's customer is always "Непознат Купувач" — the parsers never return a customer
 * name, and a line's komitent id is used only to count the (rare) named-customer receipts. Cashier
 * names are staff and are kept (the seller of a receipt). Notes are never returned; only the
 * Natura invoice number is extracted from a goods document.
 *
 * Form helpers (decode … encodeForm) are copies of supabase/functions/collabbox-sync/collabbox.ts —
 * KEEP IN STEP. They are copied, not imported, so this function deploys on its own.
 */

// ─── document types ─────────────────────────────────────────────────────────
/** Fiscal receipts and retail returns: the sales (every 15 minutes, today). */
export const SALES_TYPES: readonly string[] = Object.freeze(["10022", "10010"]);
/** The goods documents read hourly (last 2 days): Natura's invoice into 001, 001 → shop,
 *  transfers, returns to Natura, bundle assembly, damaged goods, counts. */
export const DOC_TYPES: readonly string[] = Object.freeze([
  "10042", "10014", "10015", "10061", "10044", "10040", "10062", "10011", "10005",
]);
/** The daily financial report — the CONTROL of the receipts, never added to them. */
export const CONTROL_TYPE = "10018";
/** Every type the reader may put into a request (the allow-list checks it). */
export const READ_TYPES: readonly string[] = Object.freeze([...SALES_TYPES, ...DOC_TYPES, CONTROL_TYPE]);
/** Never read as goods or sales: 10016 = the twin of 10042, 10008 = price change only, 10009 =
 *  discount approval, 10066 = retail turnover summary, 10081–10113 = orders. */
export const NEVER_TYPES: readonly string[] = Object.freeze(["10016", "10008", "10009", "10066"]);
/** Types whose lines move stock (10011 is the count LIST — the movement is its 10005 difference). */
export const STOCK_TYPES: readonly string[] = Object.freeze([
  "10022", "10010", "10042", "10014", "10015", "10061", "10044", "10040", "10062", "10005",
]);

export const TYPE_NAMES: Readonly<Record<string, string>> = Object.freeze({
  "10022": "Фискална Сметка",
  "10010": "Повратница од малопродажба",
  "10018": "Дневен Финансиски Извештај",
  "10042": "Влезна Фактура",
  "10016": "Приемница",
  "10014": "Приемен лист во трговија",
  "10015": "Препратница",
  "10061": "ПРЕПРАТНИЦА МЕЃУ ПРОДАВНИЦИ",
  "10044": "Повратница до добавувач",
  "10040": "Налог за производство",
  "10062": "Записник за оштетена роба",
  "10011": "Пописна Листа",
  "10005": "Лагер-попис разлика",
  "10066": "Промет Малопродажба",
  "10008": "Нивелација",
  "10009": "Одобрение за попуст",
});
const normName = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
const TYPE_BY_NAME = new Map(Object.entries(TYPE_NAMES).map(([id, n]) => [normName(n), id]));
/** "Фискална Сметка" → "10022"; unknown name → null. */
export const typeIdByName = (name: unknown): string | null => TYPE_BY_NAME.get(normName(name)) ?? null;

/** collabBox internal warehouse ids (the magid / rightMagIds filters) of the 22 shops — the seed of
 *  public.shops (migration 20260946000100) holds the same list; shops.test.ts checks the two agree. */
export const SHOP_MAGIDS: Readonly<Record<string, number>> = Object.freeze({
  "003": 4, "004": 6, "005": 7, "006": 8, "007": 9, "008": 10, "009": 11, "010": 12, "011": 13, "012": 14,
  "013": 15, "015": 17, "016": 18, "017": 19, "020": 37, "021": 38, "023": 40, "024": 41, "026": 43,
  "027": 44, "028": 45, "029": 46,
});
const MAGID_SET = new Set(Object.values(SHOP_MAGIDS));

// ─── HTML helpers (collabbox-sync/collabbox.ts — KEEP IN STEP) ───────────────
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
/** A cell's text: <BR> joins (collabBox wraps long names), tags → space, whitespace collapsed. */
export const cellText = (html: unknown): string =>
  decode(String(html ?? "").replace(/<br\s*\/?>/gi, "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
/** "1,234.50" / "3,000.00 МКД" / "-1,500.00" / "0,00" → number; "" → null (no amount is NOT zero). */
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

// ─── forms, serialised as a browser would (collabbox-sync — KEEP IN STEP) ───
export interface FormOption { value: string; text: string; selected: boolean; disabled: boolean }
export interface ParsedForm { pairs: [string, string][]; selects: Record<string, FormOption[]>; combos: [string, string, string][] }

/** Browser-faithful serialisation of <form name=…> plus its setCombos() dual lists. One deliberate difference
 *  from the collabbox-sync copy: the closing tag is found case-insensitively — tkreport writes <FORM …>…</FORM>,
 *  and a case-sensitive search ran on into the next form (the fast-search box) and posted its fields too. */
export function readForm(html: string, formName: string): ParsedForm {
  const start = html.search(new RegExp(`<form[^>]*name\\s*=\\s*"?${formName}"?`, "i"));
  if (start < 0) throw new Error(`form "${formName}" not found — collabBox page layout changed?`);
  const end = html.toLowerCase().indexOf("</form>", start);
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
export function dropField(form: ParsedForm, name: string): void {
  form.pairs = form.pairs.filter(([k]) => k !== name);
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
        ?? { value: v, text: TYPE_NAMES[v] ?? v, selected: false, disabled: false });
    }
    setField(form, left, list(L, sep, "value"));
    setField(form, "captions_" + left, list(L, sep, "text"));
    setField(form, right, list(R, sep, "value"));
    setField(form, "captions_" + right, list(R, sep, "text"));
  }
}
export const encodeForm = (pairs: [string, string][]): string =>
  pairs.map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v)).join("&");

// ─── the request bodies (docs/SHOPS.md "Facts"; the probe of 01.10.2026) ────
export const PATHS = Object.freeze({
  login: "Login", loginForm: "Login?",
  searchdoc: "Index?comp=searchdoc&action=search",
  items: "Index?comp=repbydocitm", itemsForm: "Index?comp=repbydocitm",
  infollc: "Index?comp=infollc", infollcForm: "Index?comp=infollc",
  lnp: "Index?comp=lnp&act=search", lnpForm: "Index?comp=lnp",
  tkreport: "Index?comp=tkreport&action=submit", tkreportForm: "Index?comp=tkreport",
});

export interface ItemsOptions {
  types: readonly string[];
  fromDmy: string;
  toDmy: string;
  /** one shop (its collabBox magid); null = every warehouse */
  magid?: number | null;
  /** one row per out-warehouse with sums only (the per-shop totals) */
  sumsByShop?: boolean;
  /** "HH:MM" hour window */
  casOd?: string | null;
  casDo?: string | null;
}
/** Document lines (comp=repbydocitm, "Потврди"): the sync's search + purchase AND sale prices, unit
 *  prices, the in / out warehouse, the business unit and the article id. */
export function itemsBody(formHtml: string, o: ItemsOptions): string {
  const form = readForm(formHtml, "searchform");
  const sel: Record<string, Set<string>> = { dokTipSelection: new Set(o.types) };
  if (o.magid != null) sel.leftMagIds = new Set([String(o.magid)]);
  fillCombos(form, sel);
  setField(form, "datumod", o.fromDmy);
  setField(form, "datumdo", o.toDmy);
  setField(form, "realdatumod", "");
  setField(form, "realdatumdo", "");
  setField(form, "predefiniraniIntervali", "0");
  setField(form, "limitResults", "0");
  setField(form, "casOd", o.casOd ?? "");
  setField(form, "casDo", o.casDo ?? "");
  setField(form, "cmbProkaz", "1");               // Набавна и продажна цена
  setField(form, "edinecnaCena", "ON");
  setField(form, "prikaziMagVlez", "on");
  setField(form, "prikaziMagIzlez", "on");
  setField(form, "showWorkingUnit", "ON");
  setField(form, "idArtikl", "ON");
  if (o.sumsByShop) {
    setField(form, "groupby", "dokumenti.magizlez");
    setField(form, "onlySums", "on");
  } else {
    setField(form, "groupby", "-1");
    dropField(form, "onlySums");
  }
  setField(form, "mode", "doSearch");
  setField(form, "searchMode", "doSearch");
  return encodeForm(form.pairs);
}

/** Document headers (comp=searchdoc): COMMA-WRAPPED type ids; optionally the "Бр. Влезна Фактура"
 *  column (Natura's own invoice number on a 10042) and the "Забелешка" column (Natura's return
 *  number on a 10044). */
export function searchDocBody(types: readonly string[], fromDmy: string, toDmy: string, withNatura = false): string {
  const p: Record<string, string> = {
    searchMode: "search", chkDocType: "chk", selectedDocTypes: "," + types.join(",") + ",",
    chkDatumOd: "chk", datumod: fromDmy, chkDatumDo: "chk", datumdo: toDmy, limitResults: "0",
  };
  if (withNatura) { p.chkShowBrVlFaktura = "chk"; p.chkShowDocZabeleska = "chk"; }
  return new URLSearchParams(p).toString();
}

/** Stock of ONE shop as of a day (comp=infollc, "Потврди"): avg cost ex VAT, in, out, stock,
 *  reserved, available, value, retail price — and the VAT % of each article. */
export function infollcBody(formHtml: string, magid: number, asOfDmy: string): string {
  const form = readForm(formHtml, "searchform");
  fillCombos(form, { leftMagIds: new Set([String(magid)]), priceTypesLeft: new Set(["1"]) });
  setField(form, "datumod", "");
  setField(form, "datumdo", asOfDmy);
  setField(form, "predefiniraniIntervali", "0");
  setField(form, "avrPrice", "ON");
  setField(form, "ddvProcentPoArtikl", "show");   // the VAT % of each article
  setField(form, "prekinatProducts", "show");     // discontinued articles too (the default hides them — lnp shows them)
  setField(form, "mode", "doListOptions");
  setField(form, "results", "1");
  setField(form, "searchMode", "");
  return encodeForm(form.pairs);
}

/** Opening / bought / sold / closing of ONE shop over a period (comp=lnp, "Барај"). */
export function lnpBody(formHtml: string, magid: number, fromDmy: string, toDmy: string): string {
  const form = readForm(formHtml, "searchform");
  fillCombos(form, { leftMagIds: new Set([String(magid)]), priceTypesLeft: new Set(["1"]) });
  setField(form, "datumod", fromDmy);
  setField(form, "datumdo", toDmy);
  setField(form, "predefiniraniIntervali", "0");
  setField(form, "prikaziFinansiskoSaldo", "ON");
  setField(form, "avrPrice", "ON");
  setField(form, "searchMode", "none");
  setField(form, "delcustom", "none");
  return encodeForm(form.pairs);
}

export const TK_PAYMENTS = Object.freeze({
  cash: ["typePayment_Во готово"],
  card: ["typePayment_Со картичка", "typePayment_Со картичка (VISA)", "typePayment_Со картичка (MASTERCARD)", "typePayment_Со картичка (DINERS)"],
});
/** The trade book (comp=tkreport, "Барај"): every warehouse, sums per warehouse, the chosen
 *  payment types (all = the receipts total; cash only = the cash per shop). Never the notepad. */
export function tkreportBody(formHtml: string, fromDmy: string, toDmy: string, payments: "all" | "cash"): string {
  const form = readForm(formHtml, "searchform");
  dropField(form, "notepadid");
  dropField(form, "notepadtext");
  for (const k of [...TK_PAYMENTS.cash, ...TK_PAYMENTS.card]) dropField(form, k);
  for (const k of payments === "cash" ? TK_PAYMENTS.cash : [...TK_PAYMENTS.cash, ...TK_PAYMENTS.card]) setField(form, k, "ON");
  setField(form, "cmbMagacin", "-1");
  setField(form, "dateFrom", fromDmy);
  setField(form, "dateTo", toDmy);
  setField(form, "interval", "0");
  setField(form, "cmbSort", "1");
  setField(form, "sum_by_warehouse", "ON");
  return encodeForm(form.pairs);
}

// ─── the allow-list ─────────────────────────────────────────────────────────
const FORBIDDEN_PATH = /(export|FileDownload|submitCombo|label|etiket|basket|kosnick|notepad|comp=(ltd|mp|plrwc)\b|addcustom|deletecustom|save|snimi|delete|insert|update)/i;
const typesWithin = (list: string | null | undefined): boolean => {
  const ids = String(list ?? "").split(",").filter(Boolean);
  return ids.length > 0 && ids.every((t) => READ_TYPES.includes(t));
};
const oneShop = (list: string | null | undefined): boolean => {
  const ids = String(list ?? "").split(",").filter(Boolean);
  return ids.length === 1 && MAGID_SET.has(Number(ids[0]));
};
const noWriteFields = (form: URLSearchParams): boolean => {
  for (const [k, v] of form) {
    if (/^(notepad|btnNotepad)/i.test(k)) return false;
    if (/(mode|action|act|searchMode|delcustom)$/i.test(k) && /(add|delete|save|snimi|insert|update|brisi|export|custom|submitCombo)/i.test(v) && v !== "none") return false;
  }
  return (form.get("savedSearchTitle") ?? "") === "";
};

/**
 * The ONLY request shapes this reader may send (method + path + the form's own mode fields):
 *   login · the five report forms (display only) · searchdoc · repbydocitm · infollc · lnp ·
 *   tkreport — every type within READ_TYPES, one shop at a time where the form takes one.
 * Never an export, submitCombo, addcustom / deletecustom, label or basket, notepad, ltd, mp, plrwc.
 */
export function isAllowed(method: string, path: string, body: string | null | undefined): boolean {
  const p = path.split("#")[0];
  if (method === "GET" && p === PATHS.loginForm) return !body;
  if (method === "POST" && p === PATHS.login) return true;
  if (FORBIDDEN_PATH.test(p)) return false;
  if (method === "GET") {
    return !body && ([PATHS.itemsForm, PATHS.infollcForm, PATHS.lnpForm, PATHS.tkreportForm] as string[]).includes(p);
  }
  if (method !== "POST" || !body) return false;
  const f = new URLSearchParams(body);
  if (!noWriteFields(f)) return false;
  switch (p) {
    case PATHS.searchdoc:
      return f.get("searchMode") === "search" && f.get("chkDocType") === "chk" && typesWithin(f.get("selectedDocTypes"));
    case PATHS.items:
      return f.get("searchMode") === "doSearch" && f.get("mode") === "doSearch" && typesWithin(f.get("doktipid"))
        && (f.get("magid") === "," || oneShop(f.get("magid")));
    case PATHS.infollc:
      return f.get("mode") === "doListOptions" && f.get("results") === "1" && f.get("searchMode") === ""
        && oneShop(f.get("rightMagIds"));
    case PATHS.lnp:
      return f.get("searchMode") === "none" && f.get("delcustom") === "none" && oneShop(f.get("rightMagIds"));
    case PATHS.tkreport:
      return f.get("cmbMagacin") === "-1" && f.get("sum_by_warehouse") === "ON";
    default:
      return false;
  }
}

// ─── table helpers ──────────────────────────────────────────────────────────
const rowsOf = (html: string): string[] => html.split(/<tr\b/i).slice(1).map((part) => {
  const end = part.search(/<\/tr>/i);
  return end >= 0 ? part.slice(0, end) : part;
});
const tdsOf = (row: string): string[] => [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((x) => x[1]);
/** A row's visible text (rowsOf keeps the <tr …> attributes at the front of each row — dropped here). */
const rowText = (row: string): string => cellText(row.slice(row.indexOf(">") + 1));
/** The table that starts at `at` (up to its first </table>; these report tables hold no nested table). */
const tableAt = (html: string, at: number): string => {
  const end = html.toLowerCase().indexOf("</table>", at);
  return html.slice(at, end < 0 ? undefined : end);
};
const capKey = (s: string) => cellText(s).toLowerCase().replace(/\s+/g, " ").trim();
/** "003 Продавница Карпош" → "003"; anything else → null. */
export const warehouseCode = (name: unknown): string | null => String(name ?? "").trim().match(/^(\d{3})\b/)?.[1] ?? null;
/** "003-4101/1664-2026" / "001-1210-826/2026" → "003" (the warehouse the document belongs to). */
export const docWarehouse = (doc: unknown): string | null => String(doc ?? "").trim().match(/^(\d{3})-/)?.[1] ?? null;
/** Loyalty lines (ПОЕН-120 …): kept, flagged, never a product, never units or sales. */
export const isPointLine = (code: unknown, name: unknown): boolean =>
  /^поен/iu.test(String(code ?? "").trim()) || /^поен/iu.test(String(name ?? "").trim());
/** Natura's own invoice number as typed in collabBox ("04-01101", "04-001104") → its key "04-1101". */
export function naturaDocKey(raw: unknown): string | null {
  const m = String(raw ?? "").trim().match(/^(\d{1,3})\s*[-/ ]\s*0*(\d{1,7})$/);
  if (m) return `${m[1].padStart(2, "0")}-${Number(m[2])}`;
  const n = String(raw ?? "").trim().match(/^0*(\d{1,7})$/);
  return n ? String(Number(n[1])) : null;
}

// ─── document LINES (comp=repbydocitm) ──────────────────────────────────────
export interface ReportLine {
  rowNo: number | null;
  articleId: string | null;
  articleCode: string;
  articleName: string;
  /** the line's komitent is NOT the anonymous retail customer (id 3) — counted, never stored */
  namedCustomer: boolean;
  at: string | null;                 // Skopje wall clock "YYYY-MM-DDTHH:MM:SS"
  typeName: string;
  typeId: string | null;
  objectId: string | null;
  docNumber: string;
  whIn: string | null;               // warehouse codes
  whOut: string | null;
  author: string | null;
  articleGroup: string | null;
  brand: string | null;
  qtyIn: number;
  qtyOut: number;
  unitCost: number | null;           // with VAT (the report's "со ддв")
  unitPrice: number | null;
  costValue: number | null;
  saleValue: number | null;
  vatRate: number | null;            // when the report carries a VAT % column
}
export interface LinesPage { lines: ReportLine[]; noResults: boolean; hasTable: boolean; problem: string | null; header: string[] }

const LINE_COLUMNS: Record<string, keyof ReportLine | "komitentId" | "komitent" | "unit"> = {
  "бр.": "rowNo", "id": "articleId", "шифра": "articleCode", "артикл": "articleName",
  "шифра на комитент": "komitentId", "комитент": "komitent", "датум": "at", "тип на документ": "typeName",
  "број на документ": "docNumber", "влезен магацин": "whIn", "излезен магацин": "whOut", "автор": "author",
  "група на артикл": "articleGroup", "тип бренд": "brand", "деловна единица": "unit",
  "количина влез": "qtyIn", "количина излез": "qtyOut", "единечна н. цена": "unitCost", "единечна п. цена": "unitPrice",
  "набавна вредност со ддв": "costValue", "набавна вредност": "costValue",
  "продажна вредност со ддв": "saleValue", "продажна вредност": "saleValue",
};
const REQUIRED_LINE_COLUMNS = ["articleCode", "articleName", "at", "typeName", "docNumber", "whIn", "whOut", "qtyIn", "qtyOut", "costValue", "saleValue"];
const ANON_RETAIL_KOMITENT = "3";

/** The HTML table id="exportX" → lines. The totals row (no document number) is dropped. */
export function parseLinesReport(html: string): LinesPage {
  const noResults = /Не се пронајдени резултати|не врати резултати/i.test(html);
  const t0 = html.search(/id="exportX"/i);
  if (t0 < 0) return { lines: [], noResults, hasTable: false, problem: noResults ? null : "no result table", header: [] };
  const rows = rowsOf(tableAt(html, t0));
  const headRow = rows.find((r) => /class\s*=\s*"tableheader"/i.test(r));
  if (!headRow) return { lines: [], noResults, hasTable: true, problem: noResults ? null : "no header row", header: [] };
  const header = tdsOf(headRow).map(capKey);
  const col: Record<string, number> = {};
  header.forEach((h, i) => {
    const k = LINE_COLUMNS[h];
    if (k && !(k in col)) col[k] = i;
    else if (/ддв/.test(h) && /%|процент/.test(h) && !("vatRate" in col)) col.vatRate = i;
  });
  const missing = REQUIRED_LINE_COLUMNS.filter((k) => !(k in col));
  if (missing.length) return { lines: [], noResults, hasTable: true, problem: `columns missing: ${missing.join(", ")}`, header };
  const lines: ReportLine[] = [];
  for (const r of rows) {
    if (!/id="row_\d+"/i.test(r)) continue;
    const tds = tdsOf(r);
    if (tds.length < header.length) continue;
    const c = (k: string) => (k in col ? cellText(tds[col[k]]) : "");
    const docNumber = c("docNumber");
    if (!docNumber) continue;
    const typeName = c("typeName");
    const vat = "vatRate" in col ? num(c("vatRate")) : null;
    lines.push({
      rowNo: num(c("rowNo")), articleId: c("articleId") || null, articleCode: c("articleCode"), articleName: c("articleName"),
      namedCustomer: "komitentId" in col ? (c("komitentId") !== "" && c("komitentId") !== ANON_RETAIL_KOMITENT) : false,
      at: isoLocal(c("at")), typeName, typeId: typeIdByName(typeName),
      objectId: tds[col.typeName]?.match(/comp=ovc&(?:amp;)?id=(\d+)/i)?.[1] ?? tds[col.docNumber]?.match(/comp=ovc&(?:amp;)?id=(\d+)/i)?.[1] ?? null,
      docNumber, whIn: warehouseCode(c("whIn")), whOut: warehouseCode(c("whOut")),
      author: c("author") || null, articleGroup: c("articleGroup") || null, brand: c("brand") || null,
      qtyIn: num(c("qtyIn")) ?? 0, qtyOut: num(c("qtyOut")) ?? 0,
      unitCost: num(c("unitCost")), unitPrice: num(c("unitPrice")), costValue: num(c("costValue")), saleValue: num(c("saleValue")),
      vatRate: vat == null ? null : vat > 1 ? Math.round(vat * 100) / 10000 : vat,
    });
  }
  return { lines, noResults, hasTable: true, problem: null, header };
}

/** Per-shop sums (groupby dokumenti.magizlez + onlySums): one row per out-warehouse. */
export function parseShopSums(html: string): { shop: string; qtyOut: number; cost: number | null; sale: number | null }[] {
  const t0 = html.search(/id="exportX"/i);
  if (t0 < 0) return [];
  const rows = rowsOf(html.slice(t0));
  const headRow = rows.find((r) => /class\s*=\s*"tableheader"/i.test(r));
  if (!headRow) return [];
  const header = tdsOf(headRow).map(capKey);
  const iw = header.indexOf("излезен магацин"), iq = header.indexOf("количина излез");
  const ic = header.findIndex((h) => h.startsWith("набавна вредност")), is = header.findIndex((h) => h.startsWith("продажна вредност"));
  const out: { shop: string; qtyOut: number; cost: number | null; sale: number | null }[] = [];
  for (const r of rows) {
    const tds = tdsOf(r).map(cellText);
    const shop = iw >= 0 ? warehouseCode(tds[iw]) : null;
    if (!shop) continue;
    out.push({ shop, qtyOut: num(tds[iq]) ?? 0, cost: num(tds[ic]), sale: num(tds[is]) });
  }
  return out;
}

// ─── document HEADERS (comp=searchdoc) ──────────────────────────────────────
export interface DocHeader {
  docId: string | null;
  objectId: string | null;
  docNumber: string;
  typeId: string | null;
  typeName: string;
  amount: number | null;
  at: string | null;
  author: string | null;
  /** Natura's invoice / return number (the "Бр. Влезна Фактура" column, its link title, or a
   *  note that is exactly such a number) — never the note text itself */
  naturaDoc: string | null;
}
export interface DocHeadersPage { total: number | null; rows: DocHeader[]; noResults: boolean; recognised: boolean; problem: string | null }

const NATURA_DOC_RE = /^\s*(\d{2}\s*-\s*\d{3,7})\s*$/;
export function parseDocHeaders(html: string): DocHeadersPage {
  const text = cellText(html.replace(/<script[\s\S]*?<\/script>/gi, ""));
  const totalRaw = text.match(/Вкупно пронајдени\s+(\d+)\s+документ/)?.[1];
  const noResults = /Не се пронајдени|не врати резултати/i.test(text);
  const total = totalRaw == null ? null : Number(totalRaw);
  const rows: DocHeader[] = [];
  const all = rowsOf(html);
  const capRow = all.find((r) => /class\s*=\s*"caption"/i.test(r) && /Наслов/.test(r));
  const caps = capRow ? tdsOf(capRow).map(capKey) : [];
  const idx = (name: string) => caps.indexOf(name);
  const iDoc = idx("наслов"), iType = idx("тип"), iAmount = idx("износ"), iDate = idx("датум"), iAuthor = idx("автор");
  const iNote = idx("забелешка"), iInv = idx("бр. влезна фактура");
  for (const r of all) {
    if (!/id="row_\d+"/i.test(r)) continue;
    const tds = tdsOf(r);
    const cell = (i: number) => (i >= 0 && i < tds.length ? cellText(tds[i]) : "");
    const docNumber = (iDoc >= 0 ? cell(iDoc) : cellText(r.match(/comp=ovc&(?:amp;)?id=\d+"[^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? "")).trim();
    if (!docNumber) continue;
    const ft = r.match(/filter\('Тип на документ','(\d+)','([^']*)'\)/);
    const inv = cell(iInv) || (r.match(/title="Број на влезна фактура:\s*([^"]*)"/i)?.[1] ?? "").trim();
    const note = cell(iNote);
    const natura = NATURA_DOC_RE.test(inv) ? inv.replace(/\s+/g, "") : NATURA_DOC_RE.test(note) ? note.replace(/\s+/g, "") : null;
    rows.push({
      docId: r.match(/name="dokument\d+"\s+value="(\d+)"/i)?.[1] ?? null,
      objectId: r.match(/comp=ovc&(?:amp;)?id=(\d+)/i)?.[1] ?? null,
      docNumber,
      typeId: ft?.[1] ?? typeIdByName(cell(iType)),
      typeName: ft ? decode(ft[2]) : cell(iType),
      amount: num(cellText(r.match(/name="labels"[^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? cell(iAmount))),
      at: isoLocal(cell(iDate)),
      author: cell(iAuthor) || null,
      naturaDoc: natura,
    });
  }
  const recognised = total != null || rows.length > 0 || noResults;
  let problem: string | null = null;
  if (!recognised) problem = "unrecognised answer (layout changed?)";
  else if (total != null && total !== rows.length) problem = `server says ${total} documents, parsed ${rows.length}`;
  else if (rows.length && (iDoc < 0 || iDate < 0)) problem = "caption row not found (layout changed?)";
  return { total, rows, noResults, recognised, problem };
}

// ─── STOCK per shop (comp=infollc) ──────────────────────────────────────────
export interface StockRow {
  articleCode: string;
  articleName: string;
  articleId: string | null;
  group: string | null;
  unit: string | null;
  avgCost: number | null;        // ex VAT
  qtyIn: number | null;
  qtyOut: number | null;
  qty: number;
  reserved: number;
  available: number | null;
  value: number | null;          // at avg cost, ex VAT
  retailPrice: number | null;    // with VAT
  vatRate: number | null;        // 0.05 / 0.18 … when the VAT % column is shown
}
export interface StockPage { shop: string | null; asOf: string | null; rows: StockRow[]; problem: string | null; vatColumn: boolean }

const STOCK_COLUMNS: Record<string, keyof StockRow> = {
  "шифра": "articleCode", "артикл": "articleName", "ед.мера": "unit", "просечна цена": "avgCost",
  "влезна кол.": "qtyIn", "излезна кол.": "qtyOut", "лагер": "qty", "резервација": "reserved",
  "расположлива количина": "available", "вкупно": "value", "малопродажна цена": "retailPrice",
};
/** The table id="tableResultsLager": one block per article group, each with its own caption row. */
export function parseInfollc(html: string): StockPage {
  const t0 = html.search(/id="tableResultsLager"/i);
  if (t0 < 0) {
    const empty = /Не се пронајдени|не врати резултати|Нема податоци/i.test(html);
    return { shop: null, asOf: null, rows: [], problem: empty ? null : "no stock table", vatColumn: false };
  }
  const table = html.slice(t0);
  const shop = warehouseCode(cellText(table.match(/Магацин:(?:&nbsp;|\s)*([^<]*)/i)?.[1] ?? ""));
  const asOf = isoLocal(cellText(table.match(/До датум:(?:&nbsp;|\s)*([^<]*)/i)?.[1] ?? ""))?.slice(0, 10) ?? null;
  const rows: StockRow[] = [];
  let col: Record<string, number> | null = null;
  let group: string | null = null;
  let vatColumn = false;
  for (const r of rowsOf(table)) {
    const g = rowText(r).match(/^Група на артикли:\s*(.+)$/);
    if (g) { group = g[1].trim(); continue; }
    const tds = tdsOf(r);
    const caps = tds.map(capKey);
    if (caps.includes("шифра") && caps.includes("лагер")) {
      col = {};
      caps.forEach((h, i) => {
        const k = STOCK_COLUMNS[h];
        if (k && !(k in col!)) col![k] = i;
        else if (/ддв|данок/.test(h) && !("vatRate" in col!)) { col!.vatRate = i; vatColumn = true; }
      });
      continue;
    }
    if (!col || !/id="row_\d+"/i.test(r)) continue;
    const c = (k: string) => (k in col! ? cellText(tds[col![k]]) : "");
    const code = c("articleCode");
    if (!code) continue;
    const vat = "vatRate" in col ? num(c("vatRate")) : null;
    rows.push({
      articleCode: code, articleName: c("articleName"),
      articleId: r.match(/'idart':'(\d+)'/)?.[1] ?? r.match(/[?&]id=(\d+)&red=llc/)?.[1] ?? null,
      group, unit: c("unit") || null, avgCost: num(c("avgCost")), qtyIn: num(c("qtyIn")), qtyOut: num(c("qtyOut")),
      qty: num(c("qty")) ?? 0, reserved: num(c("reserved")) ?? 0, available: num(c("available")),
      value: num(c("value")), retailPrice: num(c("retailPrice")),
      vatRate: vat == null ? null : vat > 1 ? Math.round(vat * 100) / 10000 : vat,
    });
  }
  return { shop, asOf, rows, problem: rows.length || /Не се пронајдени|не врати резултати/i.test(html) ? null : "no stock rows", vatColumn };
}

// ─── PERIOD flows per shop (comp=lnp) ───────────────────────────────────────
export interface PeriodRow {
  articleCode: string; articleName: string; group: string | null; subgroup: string | null;
  openingQty: number; openingValue: number | null; inPurchase: number; inTransfer: number;
  outSales: number; outTransfer: number; closingQty: number; closingValue: number | null;
  avgCost: number | null; closingRetail: number | null;
}
export interface PeriodPage { shop: string | null; from: string | null; to: string | null; rows: PeriodRow[]; problem: string | null }
/** The table id="result_table_id": Шифра | Опис | Бренд | Подгрупа | Лагер <from> | Финансиско салдо |
 *  Просечна цена | Просечна сума | Малопродажна сума | in: од набавка, препратница | out: од продажба,
 *  препратница | Лагер <to> | Финансиско салдо | Просечна цена | Просечна сума | Малопродажна сума. */
export function parseLnp(html: string): PeriodPage {
  const t0 = html.search(/id="result_table_id"/i);
  if (t0 < 0) return { shop: null, from: null, to: null, rows: [], problem: /Не се пронајдени|не врати резултати/i.test(html) ? null : "no period table" };
  const table = html.slice(t0);
  const head = cellText(table.slice(0, 2000));
  const shop = warehouseCode(head.match(/Магацини:\s*([^,]+)/)?.[1] ?? "");
  const from = isoLocal(head.match(/Датум од:\s*(\d{2}\.\d{2}\.\d{4})/)?.[1] ?? "");
  const to = isoLocal(head.match(/Датум до:\s*(\d{2}\.\d{2}\.\d{4})/)?.[1] ?? "");
  if (!/Лагер\s+\d{2}\.\d{2}\.\d{4}/.test(cellText(table.slice(0, 6000)))) return { shop, from, to, rows: [], problem: "caption row not found (layout changed?)" };
  const rows: PeriodRow[] = [];
  let group: string | null = null;
  for (const r of rowsOf(table)) {
    const g = rowText(r).match(/^Група на артикли:\s*(.+)$/);
    if (g) { group = g[1].trim(); continue; }
    if (!/class\s*=\s*"tdList"/i.test(r)) continue;
    const c = tdsOf(r).map(cellText);
    if (c.length < 18 || !c[0] || /^вкупно/i.test(c[0])) continue;
    rows.push({
      articleCode: c[0], articleName: c[1], group, subgroup: c[3] || null,
      openingQty: num(c[4]) ?? 0, openingValue: num(c[5]), inPurchase: num(c[9]) ?? 0, inTransfer: num(c[10]) ?? 0,
      outSales: num(c[11]) ?? 0, outTransfer: num(c[12]) ?? 0, closingQty: num(c[13]) ?? 0, closingValue: num(c[14]),
      avgCost: num(c[15]), closingRetail: num(c[17]),
    });
  }
  return { shop, from, to, rows, problem: null };
}

// ─── the trade book (comp=tkreport) ─────────────────────────────────────────
export interface TkPage { total: number | null; byPayment: Record<string, number>; byShopName: Record<string, number>; problem: string | null }
export function parseTkreport(html: string): TkPage {
  const t0 = html.search(/id="tableExport"/i);
  if (t0 < 0) return { total: null, byPayment: {}, byShopName: {}, problem: /Не се пронајдени|не врати резултати/i.test(html) ? null : "no trade-book table" };
  const table = tableAt(html, t0);
  const byPayment: Record<string, number> = {};
  const byShopName: Record<string, number> = {};
  let total: number | null = null;
  for (const r of rowsOf(table)) {
    const c = tdsOf(r).map(cellText);
    if (c.length < 2) continue;
    const label = c.slice(0, -1).join(" ").trim();
    const amount = num(c[c.length - 1]);
    const shop = label.match(/^Вкупно за магацинот\s+(.+?):?$/);
    if (shop) { const k = shop[1].trim(); byShopName[k] = Math.round(((byShopName[k] ?? 0) + (amount ?? 0)) * 100) / 100; continue; }
    if (/^Вкупно:?$/.test(label)) { total = amount; continue; }
    if (c.length === 3 && /^\d{2}\.\d{2}\.\d{4}$/.test(c[0])) {
      byPayment[c[1]] = Math.round(((byPayment[c[1]] ?? 0) + (amount ?? 0)) * 100) / 100;
    }
  }
  const recognised = total != null || Object.keys(byPayment).length > 0;
  return { total, byPayment, byShopName, problem: recognised || /Не се пронајдени|не врати резултати/i.test(html) ? null : "no totals (layout changed?)" };
}

// ─── what the writers receive ───────────────────────────────────────────────
/** One receipt / return line as public.shops_ingest_sales() takes it. */
export interface SalesLineRow {
  doc_number: string; line_no: number; doc_type: string; shop_code: string; sold_at: string;
  article_code: string; article_id: string | null; article_name: string; article_group: string | null;
  qty: number; unit_cost_mkd: number | null; unit_price_mkd: number | null; cost_value_mkd: number | null;
  sale_value_mkd: number | null; vat_rate: number | null; cashier: string | null; is_return: boolean; is_point: boolean;
  named_customer: boolean; collabbox_object_id: string | null;
}
/** One goods-document line as public.shops_ingest_docs() takes it. */
export interface DocLineRow {
  doc_number: string; line_no: number; doc_type: string; doc_at: string; wh_in: string | null; wh_out: string | null;
  article_code: string; article_id: string | null; article_name: string; article_group: string | null;
  qty_in: number; qty_out: number; unit_cost_mkd: number | null; unit_price_mkd: number | null;
  cost_value_mkd: number | null; sale_value_mkd: number | null; vat_rate: number | null;
}

export interface SplitLines { sales: SalesLineRow[]; docs: DocLineRow[]; skipped: Record<string, number> }
/**
 * Report lines → the writers' rows. line_no = the line's position inside its document in the
 * report (the writer replaces a document's lines as a whole, so a re-ordered report never leaves a
 * stale line behind). Sales lines need a shop warehouse; the quantity of a sale is its out
 * quantity, of a retail return its in quantity (always positive; is_return says which way).
 */
export function splitLines(lines: ReportLine[], shopCodes: ReadonlySet<string>): SplitLines {
  const sales: SalesLineRow[] = [];
  const docs: DocLineRow[] = [];
  const skipped: Record<string, number> = {};
  const skip = (why: string) => { skipped[why] = (skipped[why] ?? 0) + 1; };
  const lineNo = new Map<string, number>();
  for (const l of lines) {
    const type = l.typeId;
    if (!type) { skip(`unknown_type:${l.typeName}`.slice(0, 60)); continue; }
    if (NEVER_TYPES.includes(type) || type === CONTROL_TYPE) { skip(`never:${type}`); continue; }
    if (!l.at) { skip("no_time"); continue; }
    const n = (lineNo.get(l.docNumber) ?? 0) + 1;
    lineNo.set(l.docNumber, n);
    if (SALES_TYPES.includes(type)) {
      const isReturn = type === "10010";
      const shop = [isReturn ? l.whIn : l.whOut, l.whOut, l.whIn, docWarehouse(l.docNumber)].find((w) => w && shopCodes.has(w)) ?? null;
      if (!shop) { skip("sale_not_in_a_shop"); continue; }
      const qty = isReturn ? (l.qtyIn || -l.qtyOut) : (l.qtyOut || -l.qtyIn);
      sales.push({
        doc_number: l.docNumber, line_no: n, doc_type: type, shop_code: shop, sold_at: l.at,
        article_code: l.articleCode, article_id: l.articleId, article_name: l.articleName, article_group: l.articleGroup,
        qty: Math.abs(qty), unit_cost_mkd: l.unitCost, unit_price_mkd: l.unitPrice,
        cost_value_mkd: l.costValue == null ? null : Math.abs(l.costValue), sale_value_mkd: l.saleValue == null ? null : Math.abs(l.saleValue),
        vat_rate: l.vatRate, cashier: l.author, is_return: isReturn !== (qty < 0), is_point: isPointLine(l.articleCode, l.articleName),
        named_customer: l.namedCustomer, collabbox_object_id: l.objectId,
      });
      continue;
    }
    if (DOC_TYPES.includes(type)) {
      docs.push({
        doc_number: l.docNumber, line_no: n, doc_type: type, doc_at: l.at, wh_in: l.whIn, wh_out: l.whOut,
        article_code: l.articleCode, article_id: l.articleId, article_name: l.articleName, article_group: l.articleGroup,
        qty_in: l.qtyIn, qty_out: l.qtyOut, unit_cost_mkd: l.unitCost, unit_price_mkd: l.unitPrice,
        cost_value_mkd: l.costValue, sale_value_mkd: l.saleValue, vat_rate: l.vatRate,
      });
      continue;
    }
    skip(`not_read:${type}`);
  }
  return { sales, docs, skipped };
}
/** Units a document line moves for ONE warehouse: + into it, − out of it (both = net). */
export function signedFor(wh: string, l: Pick<DocLineRow, "wh_in" | "wh_out" | "qty_in" | "qty_out">): number {
  return (l.wh_in === wh ? l.qty_in : 0) - (l.wh_out === wh ? l.qty_out : 0);
}

/** One shop-day control as public.shops_ingest_controls() takes it. */
export interface ControlRow {
  shop_code: string; report_total_mkd: number | null; report_doc: string | null;
  tk_total_mkd: number | null; cash_mkd: number | null; card_mkd: number | null;
}
/**
 * The day's controls: the 10018 daily report per shop (its number starts with the shop's code) and
 * the trade book per shop (by the warehouse's name), all payments and cash only (card = all − cash).
 */
export function buildControls(
  reports: DocHeader[], tkAll: TkPage | null, tkCash: TkPage | null,
  shops: { code: string; collabbox_name: string | null }[],
): ControlRow[] {
  const nameKey = (s: string) => s.replace(/^\d{3}\s+/, "").replace(/\s+/g, " ").trim().toLowerCase();
  const tkFor = (page: TkPage | null, shop: { collabbox_name: string | null }) => {
    if (!page || !shop.collabbox_name) return null;
    const want = nameKey(shop.collabbox_name);
    for (const [k, v] of Object.entries(page.byShopName)) if (nameKey(k) === want) return v;
    return null;
  };
  const out: ControlRow[] = [];
  for (const s of shops) {
    const rs = reports.filter((r) => r.typeId === CONTROL_TYPE && docWarehouse(r.docNumber) === s.code);
    const all = tkFor(tkAll, s);
    const cash = tkFor(tkCash, s);
    const report = rs.length ? rs.reduce((t, r) => t + (r.amount ?? 0), 0) : null;
    if (report == null && all == null) continue;
    out.push({
      shop_code: s.code, report_total_mkd: report, report_doc: rs.map((r) => r.docNumber).join(", ") || null,
      tk_total_mkd: all, cash_mkd: tkCash ? (cash ?? (all != null ? 0 : null)) : null,
      card_mkd: tkCash && all != null ? Math.round((all - (cash ?? 0)) * 100) / 100 : null,
    });
  }
  return out;
}

// ─── Skopje calendar ────────────────────────────────────────────────────────
const SKOPJE_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Skopje", year: "numeric", month: "2-digit", day: "2-digit" });
const SKOPJE_HM = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Skopje", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
/** The Skopje calendar day (YYYY-MM-DD) of an instant. */
export const skopjeDate = (ms: number = Date.now()): string => SKOPJE_DATE.format(new Date(ms));
/** The Skopje wall-clock "HH:MM" of an instant. */
export const skopjeHm = (ms: number = Date.now()): string => SKOPJE_HM.format(new Date(ms));
export const isYmd = (s: unknown): s is string => {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(s + "T00:00:00Z");
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
};
export const addDays = (ymd: string, n: number): string => new Date(Date.parse(ymd + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);
export function dayRange(from: string, to: string, max = 400): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < max; d = addDays(d, 1)) out.push(d);
  return out;
}
/** YYYY-MM-DD → dd.mm.yyyy (collabBox's date fields). */
export const toDmy = (ymd: string): string => `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}.${ymd.slice(0, 4)}`;
/** "YYYY-MM" → its first and last day. */
export function monthRange(ym: string): { from: string; to: string } {
  const from = `${ym}-01`;
  const next = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 1));
  return { from, to: addDays(next.toISOString().slice(0, 10), -1) };
}
/** Months "YYYY-MM" from `fromYm` through `toYm` inclusive. */
export function monthsBetween(fromYm: string, toYm: string, max = 60): string[] {
  const out: string[] = [];
  let y = Number(fromYm.slice(0, 4)), m = Number(fromYm.slice(5, 7));
  while (out.length < max) {
    const ym = `${y}-${String(m).padStart(2, "0")}`;
    if (ym > toYm) break;
    out.push(ym);
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

// ─── the request ────────────────────────────────────────────────────────────
export type ShopsMode = "sales" | "docs" | "nightly" | "backfill" | "manual";
export const PARTS = ["sales", "docs", "stock", "controls", "lnp"] as const;
export type Part = typeof PARTS[number];
export interface ShopsRequest {
  mode: ShopsMode;
  dry: boolean;
  trigger: "cron" | "manual";
  /** manual: the day (sales / stock / controls) or the window (docs) */
  from: string | null;
  to: string | null;
  parts: Part[];
  /** manual: limit stock / lnp to these shops */
  shops: string[] | null;
  wait: boolean;
}
/**
 * The body contract:
 *   { mode: 'sales' | 'docs' | 'nightly' | 'backfill'  (cron; trigger: 'cron'),
 *     mode: 'manual', from: 'YYYY-MM-DD', to?: 'YYYY-MM-DD' (≤ 7 days, not after today),
 *           parts: ['sales','docs','stock','controls','lnp'], shops?: ['003', …],
 *     dry_run?: true (read + parse + plan; writes nothing), wait?: true (answer when done) }
 */
export function parseRequest(body: unknown, todayYmd: string): { ok: true; req: ShopsRequest } | { ok: false; error: string } {
  const b = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const mode = (b.mode ?? "manual") as ShopsMode;
  if (!["sales", "docs", "nightly", "backfill", "manual"].includes(mode)) return { ok: false, error: "mode must be sales, docs, nightly, backfill or manual" };
  const dry = b.dry_run === true || b.dry === true;
  const trigger = b.trigger === "cron" ? "cron" : "manual";
  let from: string | null = null, to: string | null = null;
  let parts: Part[] = [];
  let shops: string[] | null = null;
  if (mode === "manual") {
    from = (b.from ?? b.day ?? null) as string | null;
    to = (b.to ?? from) as string | null;
    if (!isYmd(from) || !isYmd(to)) return { ok: false, error: "manual needs from (and to) as YYYY-MM-DD" };
    if (from > to) return { ok: false, error: "from is after to" };
    if (to > todayYmd) return { ok: false, error: "to is in the future" };
    if (dayRange(from, to).length > 7) return { ok: false, error: "at most 7 days per manual run" };
    const raw = Array.isArray(b.parts) ? b.parts : [];
    if (!raw.length || raw.some((p) => !PARTS.includes(p as Part))) return { ok: false, error: `parts must be a non-empty subset of ${PARTS.join(", ")}` };
    parts = [...new Set(raw as Part[])];
    if (b.shops !== undefined && b.shops !== null) {
      if (!Array.isArray(b.shops) || !b.shops.length || b.shops.some((s) => typeof s !== "string" || !(s in SHOP_MAGIDS))) {
        return { ok: false, error: "shops must be a non-empty list of shop codes (003 …)" };
      }
      shops = [...new Set(b.shops as string[])];
    }
  } else if (b.from !== undefined || b.to !== undefined || b.parts !== undefined) {
    return { ok: false, error: "from / to / parts are for mode manual only" };
  }
  return { ok: true, req: { mode, dry, trigger, from, to, parts, shops, wait: b.wait === true || dry } };
}

export function chunk<T>(xs: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += Math.max(1, n)) out.push(xs.slice(i, i + Math.max(1, n)));
  return out;
}
