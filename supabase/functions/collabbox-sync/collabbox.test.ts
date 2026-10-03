import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DOC_ROLES, LIVE_TYPES, NIGHTLY_TYPES, aliasNorm, bookedHeader, buildCatalogue, buildDocuments, cellText, chunk,
  classifyLine, dayRange, addDays, docRole, fillCombos, headersProblem, headersSearchBody, isLoginPage, isStorno,
  isYmd, itemsSearchBody, komitentCard, komitentSearchBody, lineRole, mkPhone8, nameVerdict, num, isoLocal,
  pairStornos, parseHeaders, parseItemsHtml, parseKomitentSearch, parseRequest, readForm, redact, skopjeDate,
  summarizeResults, toDmy,
} from "./collabbox.ts";
import type { HeaderRow, ItemRow, KomitentRow, SyncDoc } from "./collabbox.ts";
import { CollabboxClient, CollabboxError, RequestCapError, isAllowed, splitSetCookie } from "./client.ts";
import type { FetchLike, ResponseLike } from "./client.ts";

// ── synthetic fixtures, shaped like the live pages (names, phones and numbers are invented) ──
const headerRow = (k: number, o: { doc: string; type: string; typeName: string; kom: string; name: string; amount: string; at: string; author: string }) => `
<tr class = "bgcolorF6F6F9" id="row_${k}">
<td>
<input type="hidden" name="rowHeight_${k}" id="rowHeight_${k}" value="2">
<span class="noPrint"><input type="checkbox" name="dokument${k - 1}" value="${900000 + k}" id="dokument${k - 1}" checked></span>
</td>
<td>

${k}

</td>
<td>
<a href="./Index?drawframe=0&comp=ovc&id=${800000 + k}" target="_blank">

${o.doc}

</a>
</td>
<td>

${o.typeName}

</td>
<td>
<input type="hidden" name="komitent${k - 1}" id="komitent${k - 1}" value="${o.kom}">
<a href="javascript:showCD(${o.kom});">

#${o.kom} ${o.name}

</a>
</td>
<td align = "right">
<span name="labels"  class="boldText" ><nobr>
${o.amount}
</nobr></span>
</td>
<td>

&nbsp;

</td>
<td>

${o.at}

</td>
<td>

${o.author}

</td>
<td align = "center">
<div id="noPrint" class="noPrint" >
<a href="javascript:filter('Тип на документ','${o.type}','${o.typeName}');" class="imgLink"><img src="x.gif"></a>
<a href="javascript:filter('Комитент','${o.kom}','${o.name}');" class="imgLink"><img src="y.gif"></a>
</div>
</td>
</tr>`;
const headersPage = (rows: string[], total = rows.length) => `<html><body><form name="HtmlForm"></form>
<div class="info">Резултати од пребарувањето. Вкупно пронајдени ${total} документи.</div>
<table class="grid"><tr><td class = "caption">Датум</td></tr>${rows.join("\n")}</table></body></html>`;
const H1 = headerRow(1, { doc: "002-9102-100001/2026", type: "10050", typeName: "Нарачка out", kom: "40123", name: "Марко Марковски", amount: "3,150.00 МКД", at: "27.09.2026 10:00:05", author: "Ана  Тестова" });
const H2 = headerRow(2, { doc: "002-9102-100002/2026", type: "10114", typeName: "LEADS-OUT Нарачка", kom: "40124", name: "Јана Јановска", amount: "1,500.00 МКД", at: "27.09.2026 11:30:00", author: "Ана Тестова" });

const itemRow = (k: number, c: string[]) => `<tr id="row_${k}">${c.map((x, i) => (i === 6 ? `<td><a href="./Index?drawframe=0&comp=ovc&id=${800000 + k}">${x}</a></td>` : `<td>${x}</td>`)).join("")}</tr>`;
const itemsPage = (rows: string[]) => `<html><body><table id="exportX">
<tr><td>Бр.</td><td>Шифра</td><td>Артикл</td></tr>
${rows.join("\n")}
<tr id="row_99"><td colspan="11">Вкупно</td><td>6.00</td><td>6,150.00</td></tr>
</table></body></html>`;
const I1 = itemRow(1, ["1", "001317", "PROSTA FIX BIONATURAL 30/1", "40123", "Марко Марковски", "27.09.2026 10:00", "Нарачка out", "002-9102-<BR>100001/2026", "Ана Тестова", "ДОДАТОЦИ", "BIONATURAL", "2.00", "3,000.00"]);
const I2 = itemRow(2, ["2", "8001", "ДОСТАВА", "40123", "Марко Марковски", "27.09.2026 10:00", "Нарачка out", "002-9102-100001/2026", "Ана Тестова", "УСЛУГИ", "", "1.00", "150.00"]);
const I3 = itemRow(3, ["3", "ПОЕН-200", "ПОЕН-200", "40123", "Марко Марковски", "27.09.2026 10:00", "Нарачка out", "002-9102-100001/2026", "Ана Тестова", "", "", "1.00", "0.00"]);
const I4 = itemRow(4, ["4", "000637", "КУРКУМА АКТИВ", "40124", "Јана Јановска", "27.09.2026 11:30", "LEADS-OUT Нарачка", "002-9102-100002/2026", "Ана Тестова", "", "", "2.00", "1,500.00"]);

const komitentPage = (rows: { code: string; name: string; phone: string; mobile: string; tax?: string; bank?: string; vraboten?: string; city?: string }[]) => `<html><body>
<table id="table_exp"><tr><td class="caption">Шифра</td></tr>
${rows.map((r) => {
  const cells = ["1", "<a href=\"./Index?drawframe=0&comp=ovc&id=5550001\">види</a>", r.code, r.name, "", "Ул. Прва 1", "", r.city ?? "Скопје", "Македонија", "", r.phone, r.mobile, "", r.bank ?? "", "", r.tax ?? "", "", "", "", "", r.vraboten ?? "Не"];
  return `<tr><td><input type="checkbox" name="popust_${r.code}" value="1"></td>${cells.map((x) => `<td class="tdList">${x}</td>`).join("")}</tr>`;
}).join("\n")}
</table></body></html>`;

/** The live Коминтенти answer (03.10.2026): header row, 20 tdList cells per row (the checkbox cell is one),
 *  "Пронајден е N резултат" in the dialog. */
const komitentPageLive = (rows: { code: string; name: string; phone: string; mobile: string; tax: string; vraboten: string }[]) => `<html><body>
<table><tr><td class="cnt" style="color:#000;"> Пронајден е ${rows.length} резултат </td></tr></table>
<div id="printDiv"><TABLE id="table_exp" cellpadding="1" cellspacing="1" align="center">
<tr class = "tableheader_small"> <td> <div class="noPrint"><input type="checkbox" name="popust_all" value="ON" id="popust_all"></div> </td>
<td> Р.Б </td> <td> Шифра </td> <td> Име </td> <td> Име на латиница </td> <td> Адреса </td> <td> Адреса на латиница </td> <td> Град </td>
<td> Држава </td> <td> Датум на раѓање </td> <td> Телефон </td> <td> Мобилен </td> <td> e-mail </td> <td> Жиро сметка </td> <td> Даночен број </td>
<td> Факс </td> <td> Лице за контакт </td> <td> ддв број </td> <td> ЕМБС </td> <td> Вработен </td> <td class = "noPrint"> &nbsp; </td> </tr>
${rows.map((r, i) => `<tr class = "trAlt"> <td class = "tdList"> <div class="noPrint"><input type="checkbox" name="popust_${r.code}" value="${r.code}" id="popust_${r.code}"></div> </td>
<td class = "tdList"> ${i + 1}. </td> <td class = "tdList"> <a href="./Index?comp=ovc&id=5550002&back=1"> ${r.code} </a> </td>
<td class = "tdList"> <a href="./Index?comp=ovc&id=5550002&back=1"> ${r.name} </a> </td> <td class = "tdList"> &nbsp; </td>
<td class = "tdList"> ул. Прва 1&nbsp; </td> <td class = "tdList"> &nbsp; </td> <td class = "tdList"> Тетово&nbsp; </td> <td class = "tdList"> Македонија&nbsp; </td>
<td class = "tdList"> </td> <td class = "tdList"> ${r.phone}&nbsp; </td> <td class = "tdList"> ${r.mobile}&nbsp; </td> <td class = "tdList"> &nbsp; </td>
<td class = "tdList"> <nobr> &nbsp; </nobr> </td> <td class = "tdList"> ${r.tax}&nbsp; </td> <td class = "tdList"> &nbsp; </td> <td class = "tdList"> &nbsp; </td>
<td class = "tdList"> &nbsp;&nbsp; </td> <td class = "tdList"> &nbsp;&nbsp; </td> <td class = "tdList"> ${r.vraboten} </td>
<td class = "noPrint"> <input type="hidden" name="komintentiIds" id="komintentiIds" value="${r.code}"> </td> </tr>`).join("\n")}
</table></div></body></html>`;
/** The Коминтенти search form (a cut of the live one: the fields the server reads, the custom-field picker). */
const komitentFormPage = `<html><body>
<form name="searchform" method="post" action="#">
<input type="hidden" id="language" name="language" value="1">
<input type="text" name="name1" id="name1" value="">
<input type="hidden" name="lettersubmit" id="lettersubmit" value="0">
<input type="text" name="id" class="textInput" size="10" value="">
<SELECT NAME="city" id="city"><option value="-2">Сите градови</option><option value="-1">Нема внесено град</option></SELECT>
<SELECT NAME="pageNum" id="pageNum"><option value="50" selected>50</option><option value="100">100</option></SELECT>
<SELECT NAME="prekinati" id="prekinati"><option value="1">Да</option><option value="2" selected>Сите</option></SELECT>
<SELECT NAME="custom" id="custom"><option>денови на доспевање</option></SELECT>
<input type="button" name="HtmlButton" value="Додади" onClick="javascript:setCookie();resolveClick('addcustom');">
<input type="hidden" name="number" id="number" value="0">
<input type="hidden" name="delcustom" id="delcustom" value="none">
<input type="hidden" name="searchMode" id="searchMode" value="none">
<SELECT NAME="prikaziKartica" id="prikaziKartica"><option value="-1" selected>Не</option><option value="1">Да</option></SELECT>
<input type="checkbox" name="aktivnaKartica" value="ON" id="aktivnaKartica" checked>
<input type="submit" name="Submit" value="Барај" onclick="javascript:resolveClick('search');setCookie();" class="button">
</form></body></html>`;

const itemsFormPage = `<html><body>
<form name="searchform" method="post" action="./Index?comp=repbydocitm">
<input type="hidden" name="mode" value="">
<input type="hidden" name="searchMode" value="">
<input type="text" name="datumod" value="01.09.2026">
<input type="text" name="datumdo" value="28.09.2026">
<input type="text" name="realdatumod" value="x">
<input type="text" name="realdatumdo" value="y">
<input type="checkbox" name="chkOff">
<input type="checkbox" name="chkOn" checked>
<select name="predefiniraniIntervali"><option value="3">Месец</option><option value="0" selected>--</option></select>
<select name="grupa"><option value="" disabled>—</option><option value="7">Сите</option></select>
<input type="hidden" name="limitResults" value="100">
<input type="hidden" name="dokTipSelection" value="">
<input type="hidden" name="doktipid" value="">
<select name="sel_dokTipSelection" multiple><option value="10036">Нарачка in</option><option value="10050">Нарачка out</option><option value="10111">Нарачка LEADS</option></select>
<select name="sel_doktipid" multiple></select>
<input type="hidden" name="holding" value=""><input type="hidden" name="delid" value="">
<select name="sel_holding" multiple></select>
<select name="sel_delid" multiple><option value="2">Деловна единица</option></select>
<script>setCombos('dokTipSelection','doktipid',',');setCombos('holding','delid',',');</script>
<input type="submit" name="go" value="Потврди">
</form></body></html>`;

// ── helpers ──────────────────────────────────────────────────────────────────
describe("small helpers", () => {
  it("reads amounts, dates and cells as collabBox writes them", () => {
    expect(num("3,150.00 МКД")).toBe(3150);
    expect(num("-1,500.50")).toBe(-1500.5);
    expect(num("")).toBeNull();
    expect(isoLocal("27.09.2026 21:31:23")).toBe("2026-09-27T21:31:23");
    expect(isoLocal("27.09.2026 21:31")).toBe("2026-09-27T21:31:00");
    expect(isoLocal("27.09.2026")).toBe("2026-09-27");
    expect(cellText("002-9102-<BR>100001/2026 &amp; <b>x</b>")).toBe("002-9102-100001/2026 & x");
    expect(isLoginPage("<script>location.href='./Login?';</script>")).toBe(true);
    expect(isLoginPage("<html>" + "x".repeat(300) + "</html>")).toBe(false);
  });
  it("never lets a session id reach a log line", () => {
    expect(redact("JSESSIONID=ABCDEF0123456789ABCDEF0123456789; x")).not.toMatch(/ABCDEF0123/);
    expect(redact("file=DokumentiStavki_ABCDEF0123456789ABCDEF0123456789.xls")).toBe("file=DokumentiStavki_<session>.xls");
  });
  it("Skopje days are DST-exact and dd.mm.yyyy for collabBox", () => {
    expect(skopjeDate(Date.parse("2026-10-24T22:30:00Z"))).toBe("2026-10-25"); // CEST: 00:30
    expect(skopjeDate(Date.parse("2026-10-25T22:30:00Z"))).toBe("2026-10-25"); // CET: 23:30
    expect(skopjeDate(Date.parse("2026-03-28T23:30:00Z"))).toBe("2026-03-29"); // CET: 00:30
    expect(toDmy("2026-09-05")).toBe("05.09.2026");
    expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
    expect(dayRange("2026-09-29", "2026-10-02")).toEqual(["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"]);
    expect(isYmd("2026-02-30")).toBe(false);
    expect(isYmd("2026-02-28")).toBe(true);
  });
  it("chunks", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 40)).toEqual([]);
  });
});

// ── §2 headers ───────────────────────────────────────────────────────────────
describe("parseHeaders", () => {
  it("reads every field of a document row", () => {
    const p = parseHeaders(headersPage([H1, H2]));
    expect(p.total).toBe(2);
    expect(p.rows).toHaveLength(2);
    expect(p.rows[0]).toMatchObject({
      docId: "900001", objectId: "800001", docNumber: "002-9102-100001/2026", typeId: "10050", typeName: "Нарачка out",
      customerId: "40123", customerName: "Марко Марковски", amount: 3150, currency: "МКД",
      datetime: "2026-09-27T10:00:05", author: "Ана Тестова",
    });
    expect(p.rows[1].typeId).toBe("10114");
    expect(headersProblem(p)).toBeNull();
  });
  it("fails loudly when the count does not match or the page is not a result page", () => {
    expect(headersProblem(parseHeaders(headersPage([H1], 2)))).toMatch(/server says 2 documents, parsed 1/);
    expect(headersProblem(parseHeaders("<html><body>Некоја друга страница</body></html>"))).toMatch(/unrecognised/);
    const empty = parseHeaders("<html><body>Резултати: Не се пронајдени документи.</body></html>");
    expect(empty.rows).toHaveLength(0);
    expect(empty.noResults).toBe(true);
    expect(headersProblem(empty)).toBeNull();
  });
  it("one draft row without a DocNumber does not stop the day; many broken rows still do", () => {
    const one = { total: 3, noResults: false, recognised: true, rows: [
      { docNumber: "002-9102-1/2026", typeId: "10050", datetime: "2026-04-06T10:00:00" },
      { docNumber: "", typeId: "10050", datetime: "2026-04-06T10:05:00" },
      { docNumber: "002-9102-2/2026", typeId: "10050", datetime: "2026-04-06T10:10:00" },
    ] } as unknown as Parameters<typeof headersProblem>[0];
    expect(headersProblem(one)).toBeNull();
    const many = { ...one, total: 5, rows: Array.from({ length: 5 }, () => ({ docNumber: "", typeId: "", datetime: "" })) } as unknown as Parameters<typeof headersProblem>[0];
    expect(headersProblem(many)).toMatch(/5 of 5 rows without DocNumber/);
  });
  it("the search body comma-wraps the type ids (a bare id matches nothing)", () => {
    const b = new URLSearchParams(headersSearchBody(["10036", "10050"], "27.09.2026", "27.09.2026"));
    expect(b.get("selectedDocTypes")).toBe(",10036,10050,");
    expect(b.get("searchMode")).toBe("search");
    expect(b.get("limitResults")).toBe("0");
    expect(b.get("datumod")).toBe("27.09.2026");
  });
});

// ── §3 line items ────────────────────────────────────────────────────────────
describe("parseItemsHtml", () => {
  it("reads the 13-column table, joins <BR>-wrapped numbers, drops the totals row", () => {
    const p = parseItemsHtml(itemsPage([I1, I2, I3]));
    expect(p.hasTable).toBe(true);
    expect(p.items).toHaveLength(3);
    expect(p.items[0]).toMatchObject({ articleCode: "001317", docNumber: "002-9102-100001/2026", qtyOut: 2, saleValueVat: 3000, objectId: "800001" });
    expect(p.items[1]).toMatchObject({ articleCode: "8001", article: "ДОСТАВА", saleValueVat: 150 });
  });
  it("knows an empty answer from a changed layout", () => {
    expect(parseItemsHtml("<html>Не се пронајдени резултати</html>")).toMatchObject({ items: [], noResults: true, hasTable: false });
    expect(parseItemsHtml("<html>нешто друго</html>")).toMatchObject({ items: [], noResults: false, hasTable: false });
  });
});

// ── the items form, serialised as a browser would ─────────────────────────────
describe("readForm / fillCombos / itemsSearchBody", () => {
  it("posts every control the way the page's own scripts leave it", () => {
    const f = readForm(itemsFormPage, "searchform");
    const get = (k: string) => f.pairs.find(([n]) => n === k)?.[1];
    expect(get("chkOn")).toBe("on");
    expect(get("chkOff")).toBeUndefined();
    expect(get("predefiniraniIntervali")).toBe("0");          // the selected option
    expect(get("grupa")).toBe("7");                           // no selection: the first enabled option
    expect(get("go")).toBeUndefined();                        // buttons are never posted
    expect(f.combos).toEqual([["dokTipSelection", "doktipid", ","], ["holding", "delid", ","]]);
  });
  it("dual lists: both boxes comma-wrapped, an empty box is exactly ','", () => {
    const f = readForm(itemsFormPage, "searchform");
    fillCombos(f, { dokTipSelection: new Set(["10050", "10063"]) });
    const get = (k: string) => f.pairs.find(([n]) => n === k)?.[1];
    expect(get("dokTipSelection")).toBe(",10036,10111,");
    expect(get("doktipid")).toBe(",10050,10063,");
    expect(get("captions_doktipid")).toBe(",Нарачка out,Нарачка in/out,");
    expect(get("holding")).toBe(",");
    expect(get("delid")).toBe(",2,");
  });
  it("the HTML-table search: doSearch, the day, no Excel export", () => {
    const b = new URLSearchParams(itemsSearchBody(itemsFormPage, ["10036"], "27.09.2026", "27.09.2026"));
    expect(b.get("mode")).toBe("doSearch");
    expect(b.get("searchMode")).toBe("doSearch");
    expect(b.get("datumod")).toBe("27.09.2026");
    expect(b.get("realdatumod")).toBe("");
    expect(b.get("limitResults")).toBe("0");
    expect(b.get("doktipid")).toBe(",10036,");
    expect(isAllowed("POST", "Index?comp=repbydocitm", b.toString())).toBe(true);
  });
  it("a missing form is a loud error", () => {
    expect(() => readForm("<html></html>", "searchform")).toThrow(/layout changed/);
  });
});

// ── komitent cards, phones, verdicts ──────────────────────────────────────────
describe("komitent cards", () => {
  it("parses the Коминтенти table and picks the row by Шифра", () => {
    const html = komitentPage([
      { code: "40123", name: "Марко Марковски", phone: "02/3111-222", mobile: "070 111 222" },
      { code: "40999", name: "Друг Човек", phone: "", mobile: "071222333" },
    ]);
    const { rows, hasTable } = parseKomitentSearch(html);
    expect(hasTable).toBe(true);
    expect(rows.map((r) => r.komitentId)).toEqual(["40123", "40999"]);
    expect(rows[0]).toMatchObject({ name: "Марко Марковски", mobile: "070 111 222", phone: "02/3111-222", objectId: "5550001" });
    const card = komitentCard(rows[0]);
    expect(card).toMatchObject({ komitent_id: "40123", phone8: "70111222", phone_field: "mobilen", skip_reason: null, city: "Скопје" });
  });
  it("reads the operators' default layout (20 columns, no Број картичка) by its header row", () => {
    const html = komitentPageLive([{ code: "40123", name: "Марко Марковски", phone: "070 111 222", mobile: "", tax: "", vraboten: "Не" }]);
    const { rows, hasTable, resultCount } = parseKomitentSearch(html);
    expect(hasTable).toBe(true);
    expect(resultCount).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ komitentId: "40123", name: "Марко Марковски", phone: "070 111 222", mobile: "", city: "Тетово",
      country: "Македонија", taxNumber: "", vraboten: "Не", cardNo: "", objectId: "5550002" });
    expect(komitentCard(rows[0])).toMatchObject({ phone8: "70111222", phone_field: "telefon", skip_reason: null });
    // a company's tax number lands in Даночен број (column 14 here, 15 in the harvest's layout)
    const co = parseKomitentSearch(komitentPageLive([{ code: "40124", name: "Петар", phone: "", mobile: "071222333", tax: "4030999123456", vraboten: "Не" }]));
    expect(komitentCard(co.rows[0]).skip_reason).toBe("company");
    expect(parseKomitentSearch(komitentPageLive([{ code: "40125", name: "Ана", phone: "", mobile: "071222334", tax: "", vraboten: "Да" }])).rows[0].vraboten).toBe("Да");
  });
  it("builds the card search from the Коминтенти form, as the operators' Барај sends it", () => {
    const body = new URLSearchParams(komitentSearchBody(komitentFormPage, "40123"));
    expect(body.get("id")).toBe("40123");
    expect(body.get("searchMode")).toBe("search");
    expect(body.get("lettersubmit")).toBe("0");
    expect(body.get("name1")).toBe("");
    expect(body.get("delcustom")).toBe("none");
    expect(body.get("prekinati")).toBe("2");          // the form's own defaults travel with it
    expect(body.get("aktivnaKartica")).toBe("ON");
    expect(body.has("Submit")).toBe(false);           // buttons are never sent
    expect(isAllowed("POST", "Index?comp=infocc&action=search", body.toString())).toBe(true);
  });
  const row = (o: Partial<KomitentRow>): KomitentRow => ({
    komitentId: "45000", objectId: null, name: "Петар Петровски", nameLat: "", address: "", addressLat: "", city: "", country: "",
    phone: "", mobile: "075123456", email: "", bankAccount: "", cardNo: "", taxNumber: "", vraboten: "Не", ...o,
  });
  it("the teleshop import's verdicts", () => {
    expect(komitentCard(row({ vraboten: "Да" })).skip_reason).toBe("employee");                 // current register
    expect(komitentCard(row({ komitentId: "1200", vraboten: "Да" }))).toMatchObject({ skip_reason: null, flags: ["vraboten_legacy_flag"] });
    expect(komitentCard(row({ taxNumber: "4030999123456" })).skip_reason).toBe("company");
    expect(komitentCard(row({ name: "АПТЕКА ЗДРАВЈЕ ДООЕЛ" })).skip_reason).toBe("company");
    expect(komitentCard(row({ name: "Петар Петровски почина" })).skip_reason).toBe("deceased");
    expect(komitentCard(row({ name: "Петар (не го контактирај)" }))).toMatchObject({ skip_reason: null, flags: ["do_not_contact"] });
    expect(komitentCard(row({ mobile: "", phone: "046 123 456" }))).toMatchObject({ phone8: "46123456", phone_field: "telefon" });
    expect(komitentCard(row({ mobile: "+40 721 234 567", phone: "" })).phone8).toBeNull();     // never a fake +389 number
    expect(nameVerdict("Марија Тестова")).toEqual({ skip: null, flags: [] });                  // "тест" inside a word
    expect(nameVerdict("ТЕСТ НАРАЧКА").skip).toBe("test");
  });
  it("strict Macedonian phones only", () => {
    expect(mkPhone8("070/123-456").p8).toBe("70123456");
    expect(mkPhone8("+389 70 123 456").p8).toBe("70123456");
    expect(mkPhone8("0038970123456").p8).toBe("70123456");
    expect(mkPhone8("071234567 или 072345678").p8).toBe("71234567");
    expect(mkPhone8("02 3 123 456").p8).toBe("23123456");
    expect(mkPhone8("+40 721 234 567")).toMatchObject({ p8: null, why: "foreign" });
    expect(mkPhone8("070 12 34")).toMatchObject({ p8: null, why: "too_short" });
    expect(mkPhone8("09012345678").p8).toBeNull();
    expect(mkPhone8("")).toMatchObject({ p8: null, why: "empty" });
  });
});

// ── lines and the catalogue ───────────────────────────────────────────────────
describe("lines", () => {
  const cat = buildCatalogue(
    [
      { source: "collabbox", alias_norm: "prosta fix bionatural 30/1", product_id: "p-prosta", kind: "product" },
      { source: "any", alias_norm: "prosta fix bionatural 30/1", product_id: "p-other", kind: "product" },
      { source: "any", alias_norm: "поен-200", product_id: null, kind: "loyalty_point" },
      { source: "any", alias_norm: "чашка/мерач", product_id: null, kind: "gift" },
      { source: "web", alias_norm: "куркума актив", product_id: "p-web", kind: "product" },
    ],
    [
      { id: "p-kurkuma-old", sku: "000637", name: "КУРКУМА (стар)", is_active: false },
      { id: "p-kurkuma", sku: "000637", name: "КУРКУМА АКТИВ", is_active: true },
      { id: "p-prosta", sku: "001317", name: "PROSTA FIX BIONATURAL 30/1", is_active: true },
    ],
  );
  it("roles: aliases first, then the service codes and names", () => {
    expect(lineRole("8001", "ДОСТАВА", 150)).toBe("delivery");
    expect(lineRole("8002", "ДОСТАВА", 150)).toBe("delivery");
    expect(lineRole("8002", "ЗАБЕЛЕШКА звонете поупорно", 0)).toBe("note");
    expect(lineRole("", "ДОСТАВА до 14 часот", 0)).toBe("note");
    expect(lineRole("ПОЕН-350", "ПОЕН-350", 0)).toBe("marker");
    expect(lineRole("8004", "КУПОН-НАГРАДНА ИГРА", 0)).toBe("marker");
    expect(lineRole("", "ФЛАЕР-ПРОГРАМА ЗА ЛОЈАЛНОСТ", 0)).toBe("marker");
    expect(lineRole("001317", "PROSTA FIX", 1500)).toBe("goods");
    expect(lineRole("x", "Чашка/мерач", 0, "gift")).toBe("goods");
    expect(lineRole("x", "anything", 10, "note")).toBe("note");
    expect(aliasNorm("  PROSTA   FIX  BIONATURAL 30/1 ")).toBe("prosta fix bionatural 30/1");
  });
  it("products: the collabBox alias wins over 'any', then products.sku (the active product)", () => {
    const l1 = classifyLine({ articleCode: "001317", article: "PROSTA FIX  BIONATURAL 30/1", qtyOut: 2, saleValueVat: 3000 }, cat);
    expect(l1).toMatchObject({ role: "goods", product_id: "p-prosta", product_name: "PROSTA FIX BIONATURAL 30/1", qty: 2, value_mkd: 3000 });
    const l2 = classifyLine({ articleCode: "000637", article: "КУРКУМА АКТИВ", qtyOut: 1, saleValueVat: 1500 }, cat);
    expect(l2).toMatchObject({ product_id: "p-kurkuma", product_name: "КУРКУМА АКТИВ" });      // the 'web' alias is not used
    const l3 = classifyLine({ articleCode: "999999", article: "НОВ АРТИКЛ", qtyOut: 1, saleValueVat: 900 }, cat);
    expect(l3).toMatchObject({ role: "goods", product_id: null, product_name: null, name: "НОВ АРТИКЛ" });
    const l4 = classifyLine({ articleCode: "ПОЕН-200", article: "ПОЕН-200", qtyOut: 1, saleValueVat: 0 }, cat);
    expect(l4).toMatchObject({ role: "marker", product_id: null });
  });
});

// ── documents ─────────────────────────────────────────────────────────────────
describe("buildDocuments", () => {
  const cat = buildCatalogue([], [{ id: "p-prosta", sku: "001317", name: "PROSTA FIX BIONATURAL 30/1", is_active: true }]);
  it("joins the lines to their header, classifies them, keeps the type's role", () => {
    const headers = parseHeaders(headersPage([H1, H2])).rows;
    const items = parseItemsHtml(itemsPage([I1, I2, I3, I4])).items;
    const { docs, warnings } = buildDocuments(headers, items, cat, "2026-09-27");
    expect(docs).toHaveLength(2);
    const d1 = docs[0];
    expect(d1).toMatchObject({ doc_number: "002-9102-100001/2026", type_id: "10050", role: "order", amount_mkd: 3150,
      doc_at: "2026-09-27T10:00:05", author: "Ана Тестова", lines_complete: true, storno: false, komitent_id: "40123" });
    expect(d1.lines.map((l) => l.role)).toEqual(["goods", "delivery", "marker"]);
    expect(d1.lines[0].product_id).toBe("p-prosta");
    expect(docs[1].role).toBe("order_unless_held");        // LEADS-OUT numbered 9102: the type decides
    expect(warnings).toEqual({ items_without_header: 0, duplicate_doc_numbers: [], unknown_type_rows: 0 });
  });
  it("items that could not be read → lines_complete false (the writer never guesses)", () => {
    const { docs } = buildDocuments(parseHeaders(headersPage([H1])).rows, null, cat, "2026-09-27");
    expect(docs[0]).toMatchObject({ lines_complete: false, lines: [] });
  });
  it("a DocNumber listed twice is kept once and flagged", () => {
    const { docs, warnings } = buildDocuments(parseHeaders(headersPage([H1, H1.replace('id="row_1"', 'id="row_2"')])).rows, [], cat, "2026-09-27");
    expect(docs).toHaveLength(1);
    expect(docs[0].flags).toContain("duplicate_doc_number");
    expect(warnings.duplicate_doc_numbers).toEqual(["002-9102-100001/2026"]);
  });
  it("the live mode books the header only", () => {
    const b = bookedHeader(parseHeaders(headersPage([H1])).rows[0]);
    expect(b).toMatchObject({ doc_number: "002-9102-100001/2026", type_id: "10050", amount_mkd: 3150, author: "Ана Тестова", storno: false });
    expect(b).not.toHaveProperty("lines");
  });
});

describe("stornos", () => {
  const d = (o: Partial<SyncDoc>): SyncDoc => ({
    doc_number: "x", doc_id: null, object_id: null, type_id: "10036", type_name: null, role: "order", komitent_id: "1",
    komitent_name: null, amount_mkd: 1500, currency: null, doc_at: "2026-09-27T10:00:00", day: "2026-09-27", author: null,
    lines: [], lines_complete: true, storno: false, reverses: null, reversed_by: null, flags: [], name_skip: null,
    name_flags: [], komitent: null, ...o,
  });
  const neg = (v: number) => [{ code: "1", name: "x", qty: -1, value_mkd: v, role: "goods" as const, product_id: null, product_name: null }];
  it("detects a reversal document", () => {
    expect(isStorno(null, neg(-1500))).toBe(true);
    expect(isStorno(0, neg(-1500))).toBe(true);
    expect(isStorno(-1500, [])).toBe(true);
    expect(isStorno(1500, neg(-150))).toBe(false);   // a negative line inside a real sale is only a flag
    expect(isStorno(null, [])).toBe(false);
  });
  it("pairs a storno with the ONE earlier document it reverses", () => {
    const docs = [
      d({ doc_number: "A", amount_mkd: 1500, doc_at: "2026-09-27T09:00:00" }),
      d({ doc_number: "B", amount_mkd: 900, doc_at: "2026-09-27T09:30:00" }),
      d({ doc_number: "S", amount_mkd: null, storno: true, lines: neg(-1500), doc_at: "2026-09-27T12:00:00" }),
    ];
    expect(pairStornos(docs)).toEqual([{ storno: "S", original: "A", candidates: 1 }]);
    expect(docs[0].reversed_by).toBe("S");
    expect(docs[2].reverses).toBe("A");
  });
  it("two candidates → no pair (never a guess)", () => {
    const docs = [
      d({ doc_number: "A", amount_mkd: 1500 }), d({ doc_number: "A2", amount_mkd: 1500 }),
      d({ doc_number: "S", amount_mkd: null, storno: true, lines: neg(-1500), doc_at: "2026-09-27T12:00:00" }),
    ];
    expect(pairStornos(docs)[0]).toEqual({ storno: "S", original: null, candidates: 2 });
    expect(docs.every((x) => !x.reversed_by)).toBe(true);
  });
});

// ── the type table and the department — twins of the migration ────────────────
describe("parity with 20260942000900", () => {
  const sql = readFileSync(join(process.cwd(), "supabase/migrations/20260942000900_collabbox_nightly_sync.sql"), "utf8");
  const fnBody = (name: string) => {
    const start = sql.indexOf(`FUNCTION public.${name}(`);
    return sql.slice(start, sql.indexOf("$fn$;", start));
  };
  it("DOC_ROLES = public.collabbox_doc_role()", () => {
    const body = fnBody("collabbox_doc_role");
    const cases = Object.fromEntries([...body.matchAll(/WHEN '(\d+)' THEN '([a-z_]+)'/g)].map((m) => [m[1], m[2]]));
    expect(cases).toEqual(DOC_ROLES);
    expect(body).toMatch(/ELSE 'record'/);
    expect(docRole("10055")).toBe("record");
    expect(docRole(" 10114 ")).toBe("order_unless_held");
  });
  it("the department is the owner's folder map (28.09.2026 ~23:55)", () => {
    const body = fnBody("collabbox_department");
    const byType = Object.fromEntries([...body.matchAll(/WHEN t\.typ (?:= '(\d+)'|IN \('(\d+)', '(\d+)'\))\s+THEN ARRAY\['([a-z_]+)',\s*'([a-z_]+)'\]/g)]
      .flatMap((m) => (m[1] ? [[m[1], `${m[4]}/${m[5]}`]] : [[m[2], `${m[4]}/${m[5]}`], [m[3], `${m[4]}/${m[5]}`]])));
    expect(byType).toEqual({
      10111: "altercpa/collabbox_leads",
      10114: "elyon_crm/collabbox_leads_out",
      10050: "collabbox/teleshop_out",
      10036: "collabbox/teleshop",
      10106: "collabbox/social",
      10055: "collabbox/social",
    });
    expect(body).not.toMatch(/team_/);                      // no AlterCPA-team override any more
  });
  it("the fetched types cover every role", () => {
    for (const t of Object.keys(DOC_ROLES)) expect(NIGHTLY_TYPES).toContain(t);
    expect(LIVE_TYPES).toEqual(["10036", "10050", "10111", "10114", "10106"]);
    expect(sql).toMatch(/'10036', '10050', '10111', '10114', '10106'/);   // collabbox_booked_today's list
  });
  it("MK_NSN twin: the SQL phone check is the same pattern", () => {
    expect(sql).toContain("'^(7[0-9]{7}|2[0-9]{7}|3[1-4][0-9]{6}|4[2-8][0-9]{6})$'");
  });
  it("the scheduler calls THIS project only", () => {
    const urls = [...sql.matchAll(/https:\/\/([a-z0-9]+)\.supabase\.co/g)].map((m) => m[1]);
    expect(urls.length).toBeGreaterThan(0);
    expect(new Set(urls)).toEqual(new Set(["bmfxhgznttcnnlqloqzp"]));
    expect(sql).not.toContain("sxymaloycddnoxudxaqp");
  });
});

// ── the request contract ──────────────────────────────────────────────────────
describe("parseRequest", () => {
  const today = "2026-09-29";
  it("defaults, the cron path, what runs in the background", () => {
    expect(parseRequest({}, today)).toEqual({ ok: true, req: { mode: "manual", dry: false, from: null, to: null, days: 3, trigger: "manual", background: true, ahead: 0 } });
    expect(parseRequest({ mode: "nightly", trigger: "cron" }, today)).toMatchObject({ ok: true, req: { mode: "nightly", trigger: "cron", background: true } });
    expect(parseRequest({ mode: "manual", from: "2026-09-27", wait: true }, today)).toMatchObject({ ok: true, req: { background: false } });
    expect(parseRequest({ mode: "live", trigger: "cron" }, today)).toMatchObject({ ok: true, req: { background: false } });
    expect(parseRequest({ mode: "nightly", dry_run: true }, today)).toMatchObject({ ok: true, req: { dry: true, background: false } });
  });
  it("a manual window", () => {
    expect(parseRequest({ mode: "manual", from: "2026-09-27", to: "2026-09-27", dry_run: true }, today))
      .toMatchObject({ ok: true, req: { from: "2026-09-27", to: "2026-09-27", dry: true } });
    expect(parseRequest({ from: "2026-09-27" }, today)).toMatchObject({ ok: true, req: { from: "2026-09-27", to: "2026-09-27" } });
  });
  it("refuses what it cannot do", () => {
    expect(parseRequest({ mode: "backfill" }, today).ok).toBe(false);
    expect(parseRequest({ mode: "nightly", from: "2026-09-27" }, today).ok).toBe(false);
    expect(parseRequest({ from: "2026-09-30" }, today).ok).toBe(false);                    // the future
    expect(parseRequest({ from: "2026-09-01", to: "2026-09-20" }, today).ok).toBe(false);  // > 14 days
    expect(parseRequest({ from: "2026-09-28", to: "2026-09-27" }, today).ok).toBe(false);
    expect(parseRequest({ days: 0 }, today).ok).toBe(false);
    expect(parseRequest({ days: 15 }, today).ok).toBe(false);
  });
});

describe("summarizeResults", () => {
  it("counts outcomes and keeps the lists the run shows", () => {
    const docs = new Map<string, SyncDoc>([["A", { lines: [
      { code: "999", name: "НОВ АРТИКЛ", qty: 1, value_mkd: 900, role: "goods", product_id: null, product_name: null },
      { code: "8001", name: "ДОСТАВА", qty: 1, value_mkd: 150, role: "delivery", product_id: null, product_name: null },
    ] } as SyncDoc]]);
    const s = summarizeResults([
      { doc: "A", outcome: "created", status: "paid", price_eur: 14.63, flags: ["price_from_cod"] },
      { doc: "B", outcome: "conflict", reason: "possible_twin_crm_sale", related_order_id: "o-1" },
      { doc: "C", outcome: "no_phone", reason: "komitent_card_not_read" },
      { doc: "D", outcome: "storno", reason: "reverses:A" },
    ], docs);
    expect(s.outcomes).toEqual({ created: 1, conflict: 1, no_phone: 1, storno: 1 });
    expect(s.reasons["conflict:possible_twin_crm_sale"]).toBe(1);
    expect(s.unmapped).toEqual({ "999 НОВ АРТИКЛ": 1 });
    expect(s.created).toEqual({ by_status: { paid: 1 }, eur: 14.63 });
    expect(s.conflicts).toEqual([{ doc: "B", reason: "possible_twin_crm_sale", related_order_id: "o-1" }]);
    expect(s.no_phone).toEqual(["C"]);
    expect(s.flags).toEqual({ price_from_cod: 1 });
  });
});

// ── the client: read-only, paced, capped, re-login ────────────────────────────
type Handler = (method: string, path: string, body: string | undefined, cookie: string | undefined) => { status?: number; body: string; setCookie?: string[] };
function fakeFetch(handler: Handler) {
  const calls: { method: string; path: string; body?: string; cookie?: string }[] = [];
  const f: FetchLike = async (url, init) => {
    const path = url.replace("http://146.255.89.49:8081/naturatherapy/", "");
    calls.push({ method: init.method, path, body: init.body, cookie: init.headers.Cookie });
    const r = handler(init.method, path, init.body, init.headers.Cookie);
    const res: ResponseLike = {
      status: r.status ?? 200,
      headers: { get: () => null, getSetCookie: () => r.setCookie ?? [] },
      text: async () => r.body,
    };
    return res;
  };
  return { f, calls };
}
const LOGIN_OK = "<script>location.href='./Index?';</script>";
const LOGIN_PAGE = "<script>location.href='./Login?';</script>";
const SESSION = "ABCDEF0123456789ABCDEF0123456789";

describe("CollabboxClient", () => {
  const make = (handler: Handler, o: Partial<{ maxRequests: number }> = {}) => {
    const { f, calls } = fakeFetch(handler);
    const logs: string[] = [];
    const sleeps: number[] = [];
    const client = new CollabboxClient({
      fetch: f, user: "operator", pass: "s3cret-pass", maxRequests: o.maxRequests ?? 20, pauseMs: 1500,
      sleep: async (ms) => { sleeps.push(ms); }, log: (l) => logs.push(l),
    });
    return { client, calls, logs, sleeps };
  };
  const server: Handler = (method, path, body) => {
    if (path === "Login?") return { body: "<form>login</form>", setCookie: [`JSESSIONID=${SESSION}; Path=/naturatherapy; HttpOnly`] };
    if (path === "Login") return { body: LOGIN_OK };
    if (path === "Index?comp=searchdoc&action=search") return { body: headersPage([H1, H2]) };
    if (path === "Index?comp=repbydocitm" && method === "GET") return { body: itemsFormPage };
    if (path === "Index?comp=repbydocitm") return { body: itemsPage([I1, I2]) };
    if (path === "Index?comp=infocc" && method === "GET") return { body: komitentFormPage };
    if (path === "Index?comp=infocc&action=search" && method === "POST") {
      const id = new URLSearchParams(body ?? "").get("id");
      return id === "40123"
        ? { body: komitentPageLive([{ code: "40123", name: "Марко Марковски", phone: "", mobile: "070111222", tax: "", vraboten: "Не" }]) }
        : { body: "<html><body><form name=\"searchform\"></form><table><tr><td>Нема резултати за специфираното барање</td></tr></table></body></html>" };
    }
    return { status: 404, body: "" };
  };

  it("logs in, keeps the cookie, paces every request, never logs the password or the session", async () => {
    const { client, calls, logs, sleeps } = make(server);
    await client.login();
    const page = await client.searchHeaders(["10050", "10114"], "27.09.2026", "27.09.2026");
    expect(page.rows).toHaveLength(2);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET Login?", "POST Login", "POST Index?comp=searchdoc&action=search"]);
    expect(calls[2].cookie).toBe(`JSESSIONID=${SESSION}`);
    expect(new URLSearchParams(calls[1].body).get("password")).toBe("s3cret-pass");
    expect(sleeps).toEqual([1500, 1500]);
    const all = logs.join("\n");
    expect(all).not.toContain("s3cret-pass");
    expect(all).not.toContain(SESSION);
  });
  it("reads the line items through the browser form, and a komitent card", async () => {
    const { client, calls } = make(server);
    await client.login();
    const items = await client.searchItems(["10050"], "27.09.2026", "27.09.2026");
    expect(items).toHaveLength(2);
    const post = calls.find((c) => c.method === "POST" && c.path === "Index?comp=repbydocitm")!;
    expect(new URLSearchParams(post.body).get("doktipid")).toBe(",10050,");
    const k = await client.readKomitent("40123");
    expect(k?.mobile).toBe("070111222");
    expect(await client.readKomitent("99999")).toBeNull();      // "Нема резултати" = not found
    expect(await client.readKomitent("1 OR 1=1")).toBeNull();   // never sent
    // the form once per session, then one search per card — the operators' Барај, never the paged shape
    const kom = calls.filter((c) => c.path.startsWith("Index?comp=infocc"));
    expect(kom.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET Index?comp=infocc", "POST Index?comp=infocc&action=search", "POST Index?comp=infocc&action=search",
    ]);
    expect(new URLSearchParams(kom[1].body).get("id")).toBe("40123");
    expect(new URLSearchParams(kom[1].body).get("searchMode")).toBe("search");
  });
  it("a card search that ignores its filter is an error, never 'not found' (the 29.09–03.10 failure)", async () => {
    const register = komitentPage(Array.from({ length: 50 }, (_, i) => ({ code: String(10 + i), name: "Х", phone: "", mobile: "070111222" })));
    const { client } = make((m, p, b, c) => (p === "Index?comp=infocc&action=search" ? { body: register } : server(m, p, b, c)));
    await client.login();
    await expect(client.readKomitent("40123")).rejects.toThrow(/ignored its filter/);
  });
  it("logs in again once when the session expired", async () => {
    let bounced = false;
    const { client } = make((m, p, b, c) => {
      if (p === "Index?comp=searchdoc&action=search" && !bounced) { bounced = true; return { body: LOGIN_PAGE }; }
      return server(m, p, b, c);
    });
    await client.login();
    const page = await client.searchHeaders(["10050"], "27.09.2026", "27.09.2026");
    expect(page.rows).toHaveLength(2);
    expect(client.logins).toBe(2);
  });
  it("refuses anything outside the read-only allow-list", () => {
    expect(isAllowed("GET", "Login?", null)).toBe(true);
    expect(isAllowed("POST", "Index?comp=searchdoc&action=search", "searchMode=search")).toBe(true);
    expect(isAllowed("POST", "Index?comp=searchdoc&action=save", "searchMode=search")).toBe(false);
    expect(isAllowed("POST", "Index?comp=repbydocitm", "mode=doListOptions&searchMode=exportxls")).toBe(false);
    expect(isAllowed("POST", "Index?comp=cmc&action=newMail", "x=1")).toBe(false);
    expect(isAllowed("POST", "Index?comp=kompop&act=addPopustForMoreKomIds", "searchMode=search")).toBe(false);
    expect(isAllowed("GET", "Index?comp=infdocc&mode=add&doctype=10040", null)).toBe(false);
    // the komitent card: the form (display) and its pure search — nothing else of the Коминтенти page
    expect(isAllowed("GET", "Index?comp=infocc", null)).toBe(true);
    expect(isAllowed("POST", "Index?comp=infocc&action=search", "searchMode=search&id=40123&delcustom=none")).toBe(true);
    expect(isAllowed("POST", "Index?comp=infocc&action=search", "searchMode=search&id=")).toBe(false);
    expect(isAllowed("POST", "Index?comp=infocc&action=search", "searchMode=search&id=40123&delcustom=5")).toBe(false);
    expect(isAllowed("POST", "Index?comp=infocc&action=search", "searchMode=exportxls&id=40123")).toBe(false);
    expect(isAllowed("POST", "Index?comp=infocc&action=exportxls", "searchMode=search&id=40123")).toBe(false);
    expect(isAllowed("POST", "Index?comp=infocc&action=addcustom", "searchMode=addcustom&id=40123")).toBe(false);
    expect(isAllowed("POST", "Index?comp=infocc&action=search&pgsf=0&cp=1", "searchMode=search&id=40123")).toBe(false);   // the old shape
    expect(isAllowed("GET", "Index?comp=infocc&action=search", null)).toBe(false);
    expect(isAllowed("GET", "Index?comp=savesrch&drawframe=no&formname=searchform", null)).toBe(false);
  });
  it("stops at the request cap and on an HTTP error", async () => {
    const capped = make(server, { maxRequests: 3 });
    await capped.client.login();
    await capped.client.searchHeaders(["10050"], "27.09.2026", "27.09.2026");
    await expect(capped.client.searchHeaders(["10050"], "27.09.2026", "27.09.2026")).rejects.toBeInstanceOf(RequestCapError);
    const broken = make((m, p, b, c) => (p === "Index?comp=searchdoc&action=search" ? { status: 500, body: "" } : server(m, p, b, c)));
    await broken.client.login();
    await expect(broken.client.searchHeaders(["10050"], "27.09.2026", "27.09.2026")).rejects.toBeInstanceOf(CollabboxError);
  });
  it("a rejected login is an error, and says nothing about the password", async () => {
    const { client } = make((m, p, b, c) => (p === "Login" ? { body: "<html>Погрешна лозинка</html>" } : server(m, p, b, c)));
    const err = await client.login().catch((e) => e as Error);
    expect(err).toBeInstanceOf(CollabboxError);
    expect(String(err.message)).not.toContain("s3cret-pass");
  });
  it("splits a combined Set-Cookie header", () => {
    expect(splitSetCookie(`JSESSIONID=${SESSION}; Path=/naturatherapy; HttpOnly, other=1; Path=/`)).toEqual([
      `JSESSIONID=${SESSION}; Path=/naturatherapy; HttpOnly`, "other=1; Path=/",
    ]);
    expect(splitSetCookie(null)).toEqual([]);
  });
});
