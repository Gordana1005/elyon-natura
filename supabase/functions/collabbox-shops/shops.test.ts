import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as S from "./shops.ts";
import { CollabboxError, MIN_PAUSE_MS, RequestCapError, ShopsClient, splitSetCookie } from "./client.ts";
import type { FetchLike, ResponseLike } from "./client.ts";

// Fixtures: real collabBox answers of 30.09.2026 / September (probe of 01.10 and the reader's own check of
// 02.10), trimmed to the result table or the search form; every person's name replaced ("Касиер N",
// "Корисник N"), no customer data (retail lines carry only "Непознат Купувач").
const FIX = join(process.cwd(), "supabase/functions/collabbox-shops/fixtures");
const fx = (f: string) => readFileSync(join(FIX, f), "utf8");
const SHOPS = new Set(Object.keys(S.SHOP_MAGIDS));
const sum = <T>(xs: T[], f: (x: T) => number | null | undefined) => Math.round(xs.reduce((t, x) => t + (Number(f(x)) || 0), 0) * 100) / 100;

describe("the shops (seed twin)", () => {
  it("22 shops; magids as in the migration seed", () => {
    expect(Object.keys(S.SHOP_MAGIDS)).toHaveLength(22);
    const sql = readFileSync(join(process.cwd(), "supabase/migrations/20260946000100_shops_schema.sql"), "utf8");
    const seed = [...sql.matchAll(/\('(\d{3})',\s*'[^']+',\s*'[^']+',\s*'(\d{2})',\s*(\d+),\s*'(\d{3}) Продавница [^']+'/g)];
    expect(seed).toHaveLength(22);
    for (const m of seed) {
      expect(S.SHOP_MAGIDS[m[1]]).toBe(Number(m[3]));
      expect(m[4]).toBe(m[1]);
    }
  });
  it("every seeded shop is in the live warehouse list of the forms (name and magid)", () => {
    const form = fx("form_repbydocitm.html");
    const sql = readFileSync(join(process.cwd(), "supabase/migrations/20260946000100_shops_schema.sql"), "utf8");
    for (const m of sql.matchAll(/\('(\d{3})',\s*'([^']+)',\s*'[^']+',\s*'\d{2}',\s*(\d+),\s*'([^']+)'/g)) {
      expect(form).toContain(`<option value="${m[3]}">${m[4]}`);
      expect(m[4]).toBe(`${m[1]} Продавница ${m[2]}`);
    }
  });
});

describe("document lines (repbydocitm)", () => {
  it("Карпош 30.09: 12 lines, 6 receipts, 10.691,97 ден (ПОЕН 2,14 of it), cashiers kept, no customer", () => {
    const p = S.parseLinesReport(fx("lines_karpos_3009.html"));
    expect(p.problem).toBeNull();
    expect(p.header).toHaveLength(21);
    expect(p.lines).toHaveLength(12);
    const { sales, docs, skipped } = S.splitLines(p.lines, SHOPS);
    expect(docs).toHaveLength(0);
    expect(skipped).toEqual({});
    expect(new Set(sales.map((l) => l.doc_number)).size).toBe(6);
    expect(sum(sales, (l) => l.sale_value_mkd)).toBe(10691.97);
    expect(sum(sales.filter((l) => l.is_point), (l) => l.sale_value_mkd)).toBe(2.14);
    expect(sum(sales.filter((l) => !l.is_point), (l) => l.qty)).toBe(16);
    expect(sales.every((l) => l.shop_code === "003" && l.doc_type === "10022" && !l.is_return && !l.named_customer)).toBe(true);
    const line = sales.find((l) => l.article_code === "000982")!;
    expect(line).toMatchObject({ doc_number: "003-4101/1666-2026", line_no: 1, sold_at: "2026-09-30T14:11:00", qty: 3,
      unit_cost_mkd: 284, unit_price_mkd: 571.4, cost_value_mkd: 852, sale_value_mkd: 1714.2, article_id: "1658", article_group: "34" });
    expect(line.cashier).toMatch(/^Касиер \d+$/);
    // line numbers restart per document, in report order
    expect(sales.filter((l) => l.doc_number === "003-4101/1666-2026").map((l) => l.line_no)).toEqual([1, 2, 3, 4, 5]);
  });
  it("all shops 18:00–19:00: 34 lines over several shops", () => {
    const p = S.parseLinesReport(fx("lines_retail_all_3009_18h.html"));
    const { sales } = S.splitLines(p.lines, SHOPS);
    expect(sales).toHaveLength(34);
    expect(new Set(sales.map((l) => l.shop_code)).size).toBeGreaterThan(5);
    expect(sum(sales, (l) => l.sale_value_mkd)).toBe(28342.89);
  });
  it("per-shop sums: 22 shops, 340.470,33 ден, Сити Мол cost above sales", () => {
    const s = S.parseShopSums(fx("sums_by_shop_3009.html"));
    expect(s).toHaveLength(22);
    expect(sum(s, (x) => x.sale)).toBe(340470.33);
    expect(s.find((x) => x.shop === "003")).toEqual({ shop: "003", qtyOut: 19, cost: 4126.26, sale: 10691.97 });
    expect(s.find((x) => x.shop === "029")).toMatchObject({ cost: 12269.3, sale: 9395 });
  });
  it("10014 into Карпош (September): signed both ways, 10008 never read", () => {
    const p = S.parseLinesReport(fx("lines_into_karpos_sep.html"));
    const { docs, sales, skipped } = S.splitLines(p.lines, SHOPS);
    expect(sales).toHaveLength(0);
    expect(skipped).toEqual({ "never:10008": 25 });
    expect(docs).toHaveLength(62);
    expect(docs.every((d) => d.doc_type === "10014" && d.wh_in === "003" && d.wh_out === "001")).toBe(true);
    expect(sum(docs, (d) => S.signedFor("003", d))).toBe(-63);
    expect(sum(docs, (d) => S.signedFor("001", d))).toBe(63);
    expect(docs.find((d) => d.doc_number === "003-7500-552/2026")).toMatchObject({ qty_in: 10, qty_out: 10, cost_value_mkd: 2090, sale_value_mkd: 14900 });
  });
  it("Natura → 001: 10042 and 10044 kept, the 10016 twin never", () => {
    const p = S.parseLinesReport(fx("lines_natura_in_3009.html"));
    const { docs, skipped } = S.splitLines(p.lines, SHOPS);
    expect(skipped).toEqual({ "never:10016": 70 });
    expect(new Set(docs.map((d) => d.doc_type))).toEqual(new Set(["10042", "10044"]));
    expect(docs.filter((d) => d.doc_type === "10042").every((d) => d.wh_in === "001" && d.qty_in > 0 && d.qty_out === 0)).toBe(true);
    expect(docs.filter((d) => d.doc_type === "10044").every((d) => d.qty_out > 0 && d.qty_in === 0)).toBe(true);
  });
  it("an unrecognisable table is a problem, an empty search is not", () => {
    expect(S.parseLinesReport("<html>Пребарувањето не врати резултати</html>")).toMatchObject({ lines: [], noResults: true, problem: null });
    expect(S.parseLinesReport('<table id="exportX"><tr><td class = "tableheader">Бр.</td></tr></table>').problem).toMatch(/columns missing/);
    expect(S.parseLinesReport("<html>?</html>").problem).toBe("no result table");
  });
});

describe("document headers (searchdoc)", () => {
  it("10042 / 10044 of 30.09 with Natura's numbers (the column, the link title, the note)", () => {
    const p = S.parseDocHeaders(fx("headers_natura_3009.html"));
    expect(p.problem).toBeNull();
    expect(p.total).toBe(23);
    expect(p.rows).toHaveLength(23);
    const inv = p.rows.find((r) => r.docNumber === "001-1210-833/2026")!;
    expect(inv).toMatchObject({ typeId: "10042", amount: 54449, at: "2026-09-30T13:04:42", naturaDoc: "04-01108" });
    const ret = p.rows.find((r) => r.docNumber === "001-7105-702/2026")!;
    expect(ret).toMatchObject({ typeId: "10044", amount: 308, naturaDoc: "04-00698" });
    expect(p.rows.find((r) => r.docNumber === "001-1210-829/2026")!.naturaDoc).toBe("04-001104");
    expect(p.rows.every((r) => r.naturaDoc)).toBe(true);
  });
  it("the 22 daily reports (10018): one per shop, Карпош 10.692", () => {
    const p = S.parseDocHeaders(fx("headers_10018_3009.html"));
    expect(p.rows).toHaveLength(22);
    expect(p.rows.every((r) => r.typeId === "10018")).toBe(true);
    expect(sum(p.rows, (r) => r.amount)).toBe(340472);
    expect(p.rows.find((r) => S.docWarehouse(r.docNumber) === "003")!.amount).toBe(10692);
  });
  it("a count that does not match the rows is a problem", () => {
    const html = fx("headers_10018_3009.html").replace("Вкупно пронајдени 22 документи", "Вкупно пронајдени 23 документи");
    expect(S.parseDocHeaders(html).problem).toMatch(/server says 23/);
  });
});

describe("stock (infollc) and periods (lnp)", () => {
  it("Карпош as of 30.09: 704 articles incl. discontinued, 4.893 units, the VAT of every article", () => {
    const p = S.parseInfollc(fx("stock_karpos_3009.html"));
    expect(p.problem).toBeNull();
    expect(p.shop).toBe("003");
    expect(p.asOf).toBe("2026-09-30");
    expect(p.vatColumn).toBe(true);
    expect(p.rows).toHaveLength(704);
    expect(sum(p.rows, (r) => r.qty)).toBe(4893);
    const gel = p.rows.find((r) => r.articleCode === "001641")!;
    expect(gel).toMatchObject({ articleName: "MAGNESIUM GEL 50ml", avgCost: 22.0339, qty: 22, reserved: 0, retailPrice: 250, vatRate: 0.18, articleId: "2123" });
    expect(p.rows.find((r) => r.articleCode === "000982")!.vatRate).toBe(0.05);
    const rates = new Set(p.rows.map((r) => r.vatRate));
    expect(rates).toEqual(new Set([0, 0.05, 0.18]));
    expect(p.rows.filter((r) => r.group).length).toBe(704);
  });
  it("lnp September: closing = the infollc stock of 30.09, article by article", () => {
    const ln = S.parseLnp(fx("lnp_karpos_sep.html"));
    expect(ln).toMatchObject({ shop: "003", from: "2026-09-01", to: "2026-09-30", problem: null });
    const st = S.parseInfollc(fx("stock_karpos_3009.html"));
    const a = new Map(st.rows.map((r) => [r.articleCode, r.qty]));
    let compared = 0;
    for (const r of ln.rows) {
      if (!a.has(r.articleCode)) continue;
      expect(r.closingQty).toBe(a.get(r.articleCode));
      compared++;
    }
    expect(compared).toBeGreaterThan(300);
    expect(sum(ln.rows, (r) => r.closingQty)).toBe(sum(st.rows, (r) => r.qty));
    expect(ln.rows.find((r) => r.articleCode === "001637")).toMatchObject({ openingQty: 11, inTransfer: -5, closingQty: 6, subgroup: "АД АСТРА" });
  });
});

describe("the trade book (tkreport) and the controls", () => {
  it("all payments: 340.472, cash / card, per shop by name", () => {
    const tk = S.parseTkreport(fx("tkreport_all_3009.html"));
    expect(tk).toMatchObject({ total: 340472, problem: null });
    expect(tk.byPayment).toEqual({ "Во готово": 183824, "Со картичка": 156648 });
    expect(Object.keys(tk.byShopName)).toHaveLength(22);
    expect(tk.byShopName["Продавница Карпош"]).toBe(10692);
  });
  it("cash only: per shop", () => {
    const tk = S.parseTkreport(fx("tkreport_cash_3009.html"));
    expect(tk.total).toBe(183824);
    expect(tk.byShopName["Продавница Карпош"]).toBe(4202);
  });
  it("buildControls: 10018 by the number's prefix, the trade book by the warehouse name, card = all − cash", () => {
    const reports = S.parseDocHeaders(fx("headers_10018_3009.html")).rows;
    const rows = S.buildControls(reports, S.parseTkreport(fx("tkreport_all_3009.html")), S.parseTkreport(fx("tkreport_cash_3009.html")),
      [{ code: "003", collabbox_name: "003 Продавница Карпош" }, { code: "020", collabbox_name: "020 Продавница Аеродром" }]);
    expect(rows).toEqual([
      { shop_code: "003", report_total_mkd: 10692, report_doc: "003-1101-222/2026", tk_total_mkd: 10692, cash_mkd: 4202, card_mkd: 6490 },
      expect.objectContaining({ shop_code: "020", report_total_mkd: 13026, tk_total_mkd: 13025.95 }),
    ]);
    expect(S.buildControls(reports, null, null, [{ code: "003", collabbox_name: null }])[0]).toMatchObject({ report_total_mkd: 10692, tk_total_mkd: null, cash_mkd: null, card_mkd: null });
  });
});

describe("request bodies and the allow-list", () => {
  const items = fx("form_repbydocitm.html");
  it("lines: the sync's search + prices, warehouses, unit, article id; one shop by magid", () => {
    const b = new URLSearchParams(S.itemsBody(items, { types: S.SALES_TYPES, fromDmy: "30.09.2026", toDmy: "30.09.2026", magid: 4 }));
    expect(b.get("mode")).toBe("doSearch");
    expect(b.get("searchMode")).toBe("doSearch");
    expect(b.get("doktipid")).toBe(",10022,10010,");
    expect(b.get("magid")).toBe(",4,");
    expect(b.get("cmbProkaz")).toBe("1");
    expect(b.get("limitResults")).toBe("0");
    for (const k of ["edinecnaCena", "prikaziMagVlez", "prikaziMagIzlez", "showWorkingUnit", "idArtikl"]) expect(b.has(k)).toBe(true);
    expect(b.has("onlySums")).toBe(false);
    expect(S.isAllowed("POST", S.PATHS.items, b.toString())).toBe(true);
    const sums = new URLSearchParams(S.itemsBody(items, { types: S.SALES_TYPES, fromDmy: "30.09.2026", toDmy: "30.09.2026", sumsByShop: true }));
    expect(sums.get("groupby")).toBe("dokumenti.magizlez");
    expect(sums.get("onlySums")).toBe("on");
    expect(sums.get("magid")).toBe(",");
  });
  it("stock, period, trade book, headers: their shapes pass, one shop at a time", () => {
    const st = S.infollcBody(fx("form_infollc.html"), 4, "30.09.2026");
    const sp = new URLSearchParams(st);
    expect([sp.get("mode"), sp.get("results"), sp.get("searchMode"), sp.get("rightMagIds"), sp.get("datumdo")]).toEqual(["doListOptions", "1", "", ",4,", "30.09.2026"]);
    expect([sp.get("ddvProcentPoArtikl"), sp.get("prekinatProducts"), sp.get("priceTypes")]).toEqual(["show", "show", ",1,"]);
    expect(S.isAllowed("POST", S.PATHS.infollc, st)).toBe(true);
    const ln = S.lnpBody(fx("form_lnp.html"), 4, "01.09.2026", "30.09.2026");
    expect(S.isAllowed("POST", S.PATHS.lnp, ln)).toBe(true);
    const tk = S.tkreportBody(fx("form_tkreport.html"), "30.09.2026", "30.09.2026", "cash");
    const tp = new URLSearchParams(tk);
    expect(tp.get("typePayment_Во готово")).toBe("ON");
    expect(tp.has("typePayment_Со картичка")).toBe(false);
    expect(tp.has("notepadtext") || tp.has("notepadid")).toBe(false);
    expect(S.isAllowed("POST", S.PATHS.tkreport, tk)).toBe(true);
    expect(S.isAllowed("POST", S.PATHS.searchdoc, S.searchDocBody(S.DOC_TYPES, "29.09.2026", "30.09.2026", true))).toBe(true);
    for (const p of [S.PATHS.itemsForm, S.PATHS.infollcForm, S.PATHS.lnpForm, S.PATHS.tkreportForm, S.PATHS.loginForm]) expect(S.isAllowed("GET", p, null)).toBe(true);
  });
  it("refuses everything else", () => {
    const lines = S.itemsBody(items, { types: S.SALES_TYPES, fromDmy: "30.09.2026", toDmy: "30.09.2026" });
    const tk = S.tkreportBody(fx("form_tkreport.html"), "30.09.2026", "30.09.2026", "all");
    const st = S.infollcBody(fx("form_infollc.html"), 4, "30.09.2026");
    const refused: [string, string, string | null][] = [
      ["GET", "Index?comp=ltd", null], ["GET", "Index?comp=mp", null], ["GET", "Index?comp=plrwc", null],
      ["GET", "Index?comp=searchdoc", null], ["GET", "FileDownload?path=reports/&file=x.xls", null],
      ["POST", S.PATHS.items, lines.replace("searchMode=doSearch", "searchMode=exportxls")],
      ["POST", S.PATHS.items, lines.replace(/doktipid=[^&]*/, "doktipid=%2C10036%2C")],          // a teleshop type
      ["POST", S.PATHS.items, lines.replace(/doktipid=[^&]*/, "doktipid=%2C10016%2C")],          // the 10042 twin
      ["POST", S.PATHS.items, lines.replace(/savedSearchTitle=[^&]*/, "savedSearchTitle=x")],
      ["POST", "Index?comp=tkreport&action=submitCombo", tk],
      ["POST", S.PATHS.tkreport, tk + "&notepadtext=x"],
      ["POST", S.PATHS.tkreport, tk.replace("cmbMagacin=-1", "cmbMagacin=4")],
      ["POST", S.PATHS.infollc, st.replace("mode=doListOptions", "mode=addcustom")],
      ["POST", S.PATHS.infollc, st.replace("rightMagIds=%2C4%2C", "rightMagIds=%2C3%2C")],     // 001 Централен is not a shop
      ["POST", S.PATHS.infollc, st.replace("rightMagIds=%2C4%2C", "rightMagIds=%2C4%2C6%2C")], // one shop at a time
      ["POST", S.PATHS.searchdoc, S.searchDocBody(["10036"], "30.09.2026", "30.09.2026")],
      ["POST", "Index?comp=searchdoc&action=delete", S.searchDocBody(["10022"], "30.09.2026", "30.09.2026")],
    ];
    for (const [m, p, b] of refused) expect(S.isAllowed(m, p, b), `${m} ${p}`).toBe(false);
  });
});

describe("splitLines rules", () => {
  const base: S.ReportLine = {
    rowNo: 1, articleId: "1", articleCode: "000982", articleName: "X", namedCustomer: false, at: "2026-09-30T10:00:00",
    typeName: "Фискална Сметка", typeId: "10022", objectId: "1", docNumber: "003-4101/1-2026", whIn: "003", whOut: "003",
    author: "Касиер 1", articleGroup: "34", brand: null, qtyIn: 0, qtyOut: 1, unitCost: 1, unitPrice: 2, costValue: 1, saleValue: 2, vatRate: null,
  };
  it("a retail return is positive with is_return; the daily report and unknown types are never sales", () => {
    const { sales, skipped } = S.splitLines([
      base,
      { ...base, typeId: "10010", typeName: "Повратница од малопродажба", docNumber: "003-x/2", qtyIn: 2, qtyOut: 0, saleValue: -4 },
      { ...base, typeId: "10018", typeName: "Дневен Финансиски Извештај", docNumber: "003-1101-1/2026" },
      { ...base, typeId: null, typeName: "Нешто ново", docNumber: "003-y/3" },
      { ...base, docNumber: "999-z/4", whIn: "999", whOut: "999" },
    ], SHOPS);
    expect(sales.map((s) => [s.doc_type, s.qty, s.is_return, s.sale_value_mkd])).toEqual([["10022", 1, false, 2], ["10010", 2, true, 4]]);
    expect(skipped).toEqual({ "never:10018": 1, "unknown_type:Нешто ново": 1, sale_not_in_a_shop: 1 });
  });
  it("ПОЕН lines are kept and flagged", () => {
    const { sales } = S.splitLines([{ ...base, articleCode: "ПОЕН-120", articleName: "ПОЕН-120" }], SHOPS);
    expect(sales[0].is_point).toBe(true);
  });
  it("naturaDocKey normalises the hand-typed numbers", () => {
    expect(S.naturaDocKey("04-01101")).toBe("04-1101");
    expect(S.naturaDocKey("04-001104")).toBe("04-1104");
    expect(S.naturaDocKey(" 4 - 1104 ")).toBe("04-1104");
    expect(S.naturaDocKey("01101")).toBe("1101");
    expect(S.naturaDocKey("ПМ1")).toBeNull();
  });
});

describe("parseRequest", () => {
  const today = "2026-10-02";
  it("cron modes take no window", () => {
    expect(S.parseRequest({ mode: "sales", trigger: "cron" }, today)).toMatchObject({ ok: true, req: { mode: "sales", trigger: "cron", dry: false, wait: false } });
    expect(S.parseRequest({ mode: "nightly", from: "2026-10-01" }, today)).toMatchObject({ ok: false });
    expect(S.parseRequest({ mode: "drop" }, today)).toMatchObject({ ok: false });
  });
  it("manual: a window of ≤ 7 days, parts, shops, dry runs wait", () => {
    expect(S.parseRequest({ mode: "manual", from: "2026-09-30", parts: ["sales", "controls"], dry_run: true }, today)).toEqual({
      ok: true, req: { mode: "manual", dry: true, trigger: "manual", from: "2026-09-30", to: "2026-09-30", parts: ["sales", "controls"], shops: null, wait: true },
    });
    expect(S.parseRequest({ mode: "manual", from: "2026-09-20", to: "2026-09-30", parts: ["sales"] }, today)).toMatchObject({ ok: false });
    expect(S.parseRequest({ mode: "manual", from: "2026-10-03", parts: ["sales"] }, today)).toMatchObject({ ok: false });
    expect(S.parseRequest({ mode: "manual", from: "2026-09-30", parts: ["export"] }, today)).toMatchObject({ ok: false });
    expect(S.parseRequest({ mode: "manual", from: "2026-09-30", parts: ["stock"], shops: ["001"] }, today)).toMatchObject({ ok: false });
    expect(S.parseRequest({ mode: "manual", from: "2026-09-30", parts: ["stock"], shops: ["003"] }, today)).toMatchObject({ ok: true, req: { shops: ["003"] } });
  });
});

describe("Skopje calendar", () => {
  it("months and days", () => {
    expect(S.monthRange("2026-02")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(S.monthsBetween("2025-11", "2026-02")).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
    expect(S.toDmy("2026-09-30")).toBe("30.09.2026");
    expect(S.skopjeDate(Date.parse("2026-09-30T22:30:00Z"))).toBe("2026-10-01");
    expect(S.skopjeHm(Date.parse("2026-09-30T05:20:00Z"))).toBe("07:20");
  });
});

// ── the client, against a fake collabBox ─────────────────────────────────────
function fakeServer(pages: Record<string, string | ((body: string | undefined) => string)>) {
  const calls: { method: string; path: string; body?: string; cookie?: string }[] = [];
  const fetch: FetchLike = async (url, init) => {
    const path = url.replace(/^.*naturatherapy\//, "");
    calls.push({ method: init.method, path, body: init.body, cookie: init.headers.Cookie });
    const page = pages[`${init.method} ${path}`];
    const text = typeof page === "function" ? page(init.body) : page ?? "";
    const res: ResponseLike = {
      status: 200,
      headers: { get: (n: string) => (n.toLowerCase() === "set-cookie" && path === "Login?" ? "JSESSIONID=ABC; Path=/naturatherapy" : null) },
      text: async () => text,
    };
    return res;
  };
  return { fetch, calls };
}
const LOGIN_OK = "<script>location.href='./Index?';</script>";
const BOUNCE = "<script>location.href='./Login?';</script>";

describe("ShopsClient", () => {
  it("logs in, keeps ≥ 1,5 s between requests, reads the stock of one shop", async () => {
    const waits: number[] = [];
    let t = 0;
    const srv = fakeServer({
      "GET Login?": "<form>login</form>", "POST Login": LOGIN_OK,
      "GET Index?comp=infollc": fx("form_infollc.html"),
      "POST Index?comp=infollc": fx("stock_karpos_3009.html"),
    });
    const c = new ShopsClient({ fetch: srv.fetch, user: "u", pass: "p", maxRequests: 10, pauseMs: 100,
      sleep: async (ms) => { waits.push(ms); t += ms; }, now: () => t });
    await c.login();
    const page = await c.stock(4, "30.09.2026");
    expect(page.rows).toHaveLength(704);
    expect(srv.calls.map((x) => `${x.method} ${x.path}`)).toEqual(["GET Login?", "POST Login", "GET Index?comp=infollc", "POST Index?comp=infollc"]);
    expect(waits.every((w) => w >= MIN_PAUSE_MS)).toBe(true);
    expect(waits).toHaveLength(3);
    expect(srv.calls[2].cookie).toBe("JSESSIONID=ABC");
    expect(c.byKind).toEqual({ login: 2, "form:infollc": 1, stock: 1 });
  });
  it("re-logs in once when bounced, then fails loudly", async () => {
    let n = 0;
    const srv = fakeServer({
      "GET Login?": "x", "POST Login": LOGIN_OK, "GET Index?comp=tkreport": fx("form_tkreport.html"),
      "POST Index?comp=tkreport&action=submit": () => (++n === 1 ? BOUNCE : fx("tkreport_all_3009.html")),
    });
    const c = new ShopsClient({ fetch: srv.fetch, user: "u", pass: "p", maxRequests: 20, pauseMs: 0, sleep: async () => {} });
    await c.login();
    const tk = await c.tradeBook("30.09.2026", "30.09.2026", "all");
    expect(tk.total).toBe(340472);
    expect(c.logins).toBe(2);
  });
  it("the request cap and the allow-list stop it before anything is sent", async () => {
    const srv = fakeServer({ "GET Login?": "x", "POST Login": LOGIN_OK });
    const c = new ShopsClient({ fetch: srv.fetch, user: "u", pass: "p", maxRequests: 2, pauseMs: 0, sleep: async () => {} });
    await c.login();
    await expect(c.headers(S.DOC_TYPES, "30.09.2026", "30.09.2026")).rejects.toBeInstanceOf(RequestCapError);
    expect(srv.calls).toHaveLength(2);
    const c2 = new ShopsClient({ fetch: srv.fetch, user: "u", pass: "p", maxRequests: 9, pauseMs: 0, sleep: async () => {} });
    await expect(c2.headers(["10036"], "30.09.2026", "30.09.2026")).rejects.toBeInstanceOf(CollabboxError);
    expect(srv.calls).toHaveLength(2);
  });
  it("a wrong login is an error, never a silent empty run", async () => {
    const srv = fakeServer({ "GET Login?": "x", "POST Login": "<html>Погрешна лозинка</html>" });
    const c = new ShopsClient({ fetch: srv.fetch, user: "u", pass: "p", maxRequests: 5, pauseMs: 0, sleep: async () => {} });
    await expect(c.login()).rejects.toThrow(/login failed/);
  });
  it("splitSetCookie", () => {
    expect(splitSetCookie("JSESSIONID=A; Path=/x, other=B; HttpOnly")).toEqual(["JSESSIONID=A; Path=/x", "other=B; HttpOnly"]);
  });
});
