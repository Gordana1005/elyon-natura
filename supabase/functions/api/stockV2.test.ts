import { describe, expect, it } from "vitest";
import {
  ARTICLE_RE, MAX_LIMIT, SIGMA_MAX_SKEW_S, STOCK_CAPABILITIES, canVoidCount, cleanSearch, denyCode, isQty, moneyView,
  onHandMap, parseAliasBody, parseApproveBody, parseArticleCostBody, parseArticleSeriesQuery, parseArticlesQuery,
  parseBoolParam, parseConfigPatch, parseCountRequest, parseDayQuery, parseExemptBody, parseInstant, parseManualMoveRequest,
  parseMonthQuery, parseMovementsQuery, parseParcelOverride, parseParcelsQuery, parseQtyLines, parseReasonBody,
  parseRecipeBody, parseRunBody, parseSigmaBatch, parseSwitchBody, pickArticleCosts, readStockV2Settings, resolvePreview,
  resultError, shapeArticleRows, shapeConfig, shapeRecipe, shapeSigmaStatus, sigmaSignature, sigmaVerdictStatus,
  statusMovesStock, stockAccess, stockCan, stockRpcError, stripStockMoney, timingSafeEqual, verifySigmaSignature,
  type StockCaller,
} from "./stockV2.ts";

const q = (o: Record<string, string>) => new URLSearchParams(o);
const TODAY = "2026-10-01";
const NOW = Date.parse("2026-10-01T10:00:00Z");
const P1 = "aaaaaaaa-0000-4000-8000-000000000001";
const P2 = "BBBBBBBB-0000-4000-8000-000000000002";

const OWNER: StockCaller = { owner: true, admin: true, manager: false, warehouse: false };
const ADMIN: StockCaller = { owner: false, admin: true, manager: false, warehouse: false };     // a suspended admin
const MANAGER: StockCaller = { owner: false, admin: false, manager: true, warehouse: false };
const WAREHOUSE: StockCaller = { owner: false, admin: false, manager: false, warehouse: true };
const AGENT: StockCaller = { owner: false, admin: false, manager: false, warehouse: false };
const LISTED_OWNER: StockCaller = { owner: true, admin: false, manager: true, warehouse: false }; // a manager on the owners list

describe("access matrix", () => {
  it("quantities: owners, admin, manager, warehouse — never an agent", () => {
    for (const c of [OWNER, ADMIN, MANAGER, WAREHOUSE, LISTED_OWNER]) expect(stockCan(c, "read")).toBe(true);
    expect(stockCan(AGENT, "read")).toBe(false);
  });
  it("money: owners only (the owners list, not the role)", () => {
    expect(stockCan(OWNER, "money")).toBe(true);
    expect(stockCan(LISTED_OWNER, "money")).toBe(true);
    for (const c of [ADMIN, MANAGER, WAREHOUSE, AGENT]) expect(stockCan(c, "money")).toBe(false);
  });
  it("counts: owners, admin, warehouse — not a manager on their own, not an agent", () => {
    for (const c of [OWNER, ADMIN, WAREHOUSE, LISTED_OWNER]) expect(stockCan(c, "count")).toBe(true);
    for (const c of [MANAGER, AGENT]) expect(stockCan(c, "count")).toBe(false);
  });
  it("everything else is owners only", () => {
    for (const cap of ["approve", "move", "override", "configure", "switch", "run", "costs", "mappings"] as const) {
      expect(stockCan(OWNER, cap)).toBe(true);
      expect(stockCan(LISTED_OWNER, cap)).toBe(true);
      for (const c of [ADMIN, MANAGER, WAREHOUSE, AGENT]) expect(stockCan(c, cap)).toBe(false);
    }
  });
  it("the access map carries every capability", () => {
    const a = stockAccess(WAREHOUSE);
    expect(Object.keys(a).sort()).toEqual([...STOCK_CAPABILITIES].sort());
    expect(a).toMatchObject({ read: true, count: true, money: false, configure: false });
  });
  it("403 code: owners_only for staff on an owners-only capability, else forbidden", () => {
    expect(denyCode(MANAGER, "configure")).toBe("owners_only");
    expect(denyCode(WAREHOUSE, "money")).toBe("owners_only");
    expect(denyCode(AGENT, "configure")).toBe("forbidden");
    expect(denyCode(MANAGER, "count")).toBe("forbidden");
    expect(denyCode(AGENT, "read")).toBe("forbidden");
  });
  it("voiding: a pending count by the counters, an approved one only by an owner, a void one never", () => {
    expect(canVoidCount(WAREHOUSE, "pending")).toBe(true);
    expect(canVoidCount(ADMIN, "pending")).toBe(true);
    expect(canVoidCount(MANAGER, "pending")).toBe(false);
    expect(canVoidCount(WAREHOUSE, "approved")).toBe(false);
    expect(canVoidCount(OWNER, "approved")).toBe(true);
    expect(canVoidCount(OWNER, "void")).toBe(false);
    expect(canVoidCount(OWNER, null)).toBe(false);
  });
});

describe("the stock regime", () => {
  it("reads the v2 switch", () => {
    expect(readStockV2Settings(null)).toEqual({ present: false, enabled: false, sigma: { ingest: false, apply_on_ingest: true, costs_follow: false } });
    expect(readStockV2Settings([{ key: "stock_v2", value: { enabled: true, sigma: { ingest: true, apply_on_ingest: false } } }]))
      .toEqual({ present: true, enabled: true, sigma: { ingest: true, apply_on_ingest: false, costs_follow: false } });
    expect(readStockV2Settings([{ key: "stock_v2", value: "garbage" }]).present).toBe(true);
  });
  it("a status change stops moving stock as soon as the stock_v2 key exists", () => {
    expect(statusMovesStock([{ key: "stock_v2", value: { enabled: false } }])).toBe(false);
    expect(statusMovesStock([{ key: "stock_v2", value: null }, { key: "stock_mex_movements", value: { from: null } }])).toBe(false);
  });
  it("without stock_v2 the v1 rule decides", () => {
    expect(statusMovesStock([])).toBe(true);
    expect(statusMovesStock([{ key: "stock_mex_movements", value: { from: null, enabled: false } }])).toBe(true);
    expect(statusMovesStock([{ key: "stock_mex_movements", value: { from: "2026-09-22T00:00:00+02:00" } }])).toBe(false);
  });
  it("preview defaults to on while the switch is off", () => {
    expect(resolvePreview(null, false)).toBe(true);
    expect(resolvePreview(null, true)).toBe(false);
    expect(resolvePreview(false, false)).toBe(false);
    expect(resolvePreview(true, true)).toBe(true);
  });
});

describe("query parsers", () => {
  it("booleans", () => {
    expect(parseBoolParam(null)).toEqual({ ok: true, value: null });
    expect(parseBoolParam("1")).toEqual({ ok: true, value: true });
    expect(parseBoolParam("false")).toEqual({ ok: true, value: false });
    expect(parseBoolParam("yes").ok).toBe(false);
  });

  it("day: defaults, a time of day, preview", () => {
    expect(parseDayQuery(q({}), TODAY)).toEqual({ ok: true, value: { day: TODAY, warehouse: "main", at: null, preview: null } });
    expect(parseDayQuery(q({ day: "2026-09-22", warehouse: "wh08", at: "07:30", preview: "1" }), TODAY))
      .toEqual({ ok: true, value: { day: "2026-09-22", warehouse: "wh08", at: "07:30:00", preview: true } });
  });
  it("day: refuses bad input", () => {
    expect(parseDayQuery(q({ day: "2026-02-30" }), TODAY)).toEqual({ ok: false, error: "bad_day" });
    expect(parseDayQuery(q({ day: "2026-10-02" }), TODAY)).toEqual({ ok: false, error: "bad_day" });   // the future
    expect(parseDayQuery(q({ day: "2019-12-31" }), TODAY)).toEqual({ ok: false, error: "bad_day" });
    expect(parseDayQuery(q({ day: "01.10.2026" }), TODAY)).toEqual({ ok: false, error: "bad_day" });
    expect(parseDayQuery(q({ warehouse: "Main" }), TODAY)).toEqual({ ok: false, error: "bad_warehouse" });
    expect(parseDayQuery(q({ warehouse: "m" }), TODAY)).toEqual({ ok: false, error: "bad_warehouse" });
    expect(parseDayQuery(q({ warehouse: "a".repeat(21) }), TODAY)).toEqual({ ok: false, error: "bad_warehouse" });
    expect(parseDayQuery(q({ warehouse: "main;drop" }), TODAY)).toEqual({ ok: false, error: "bad_warehouse" });
    expect(parseDayQuery(q({ at: "24:00" }), TODAY)).toEqual({ ok: false, error: "bad_at" });
    expect(parseDayQuery(q({ at: "7:30" }), TODAY)).toEqual({ ok: false, error: "bad_at" });
    expect(parseDayQuery(q({ preview: "maybe" }), TODAY)).toEqual({ ok: false, error: "bad_preview" });
  });

  it("article series: code required, 30 days by default, ≤ 92 days", () => {
    expect(parseArticleSeriesQuery(q({ code: "000123" }), TODAY))
      .toEqual({ ok: true, value: { code: "000123", warehouse: "main", from: "2026-09-02", to: TODAY, preview: null } });
    expect(parseArticleSeriesQuery(q({ code: "L00012", from: "2026-07-02", to: "2026-10-01" }), TODAY).ok).toBe(true); // 92 days
    expect(parseArticleSeriesQuery(q({ code: "000123", from: "2026-07-01", to: "2026-10-01" }), TODAY))
      .toEqual({ ok: false, error: "period_too_long" });
    expect(parseArticleSeriesQuery(q({ code: "000123", from: "2026-09-10", to: "2026-09-01" }), TODAY))
      .toEqual({ ok: false, error: "bad_period" });
    expect(parseArticleSeriesQuery(q({}), TODAY)).toEqual({ ok: false, error: "bad_code" });
    expect(parseArticleSeriesQuery(q({ code: "12345" }), TODAY)).toEqual({ ok: false, error: "bad_code" });
    expect(parseArticleSeriesQuery(q({ code: "000123", to: "2026-10-05" }), TODAY)).toEqual({ ok: false, error: "bad_to" });
    expect(parseArticleSeriesQuery(q({ code: "000123", from: "x" }), TODAY)).toEqual({ ok: false, error: "bad_from" });
  });

  it("parcels: filters, limits", () => {
    const p = parseParcelsQuery(q({ day: "2026-09-30", account: "natura", department: "teleshop_out", status: "returned",
      state: "unmapped", city: " Скопје ", warehouse: "main", limit: "500", offset: "100" }), TODAY);
    expect(p).toEqual({ ok: true, value: { day: "2026-09-30", limit: 500, offset: 100,
      filters: { warehouse: "main", account: "natura", department: "teleshop_out", status: "returned", state: "unmapped", city: "Скопје" } } });
    expect(parseParcelsQuery(q({}), TODAY)).toEqual({ ok: true, value: { day: TODAY, filters: {}, limit: 100, offset: 0 } });
    expect(parseParcelsQuery(q({ limit: String(MAX_LIMIT + 1) }), TODAY)).toEqual({ ok: false, error: "bad_limit" });
    expect(parseParcelsQuery(q({ limit: "0" }), TODAY)).toEqual({ ok: false, error: "bad_limit" });
    expect(parseParcelsQuery(q({ limit: "10.5" }), TODAY)).toEqual({ ok: false, error: "bad_limit" });
    expect(parseParcelsQuery(q({ offset: "-1" }), TODAY)).toEqual({ ok: false, error: "bad_offset" });
    expect(parseParcelsQuery(q({ account: "bg" }), TODAY)).toEqual({ ok: false, error: "bad_account" });
    expect(parseParcelsQuery(q({ department: "inbound" }), TODAY)).toEqual({ ok: false, error: "bad_department" });
    expect(parseParcelsQuery(q({ status: "paid" }), TODAY)).toEqual({ ok: false, error: "bad_status" });
    expect(parseParcelsQuery(q({ state: "lost" }), TODAY)).toEqual({ ok: false, error: "bad_state" });
  });

  it("movements: the window, the filters, corrections", () => {
    expect(parseMovementsQuery(q({}), TODAY)).toEqual({ ok: true, value: { filters: { from: "2026-09-02", to: TODAY }, limit: 100, offset: 0 } });
    const p = parseMovementsQuery(q({ from: "2026-09-22", to: "2026-09-30", warehouse: "main", article: "000123", kind: "parcel_out",
      source: "mex", q: "9110%_12(3)", corrections: "1", limit: "50" }), TODAY);
    expect(p).toEqual({ ok: true, value: { limit: 50, offset: 0, filters: {
      from: "2026-09-22", to: "2026-09-30", warehouse: "main", article: "000123", kind: "parcel_out", source: "mex", q: "9110 12 3", corrections: true } } });
    expect(parseMovementsQuery(q({ corrections: "0" }), TODAY).ok && (parseMovementsQuery(q({ corrections: "0" }), TODAY) as any).value.filters.corrections).toBe(false);
    expect(parseMovementsQuery(q({ kind: "sale" }), TODAY)).toEqual({ ok: false, error: "bad_kind" });
    expect(parseMovementsQuery(q({ source: "bigarena" }), TODAY)).toEqual({ ok: false, error: "bad_source" });
    expect(parseMovementsQuery(q({ article: "abc" }), TODAY)).toEqual({ ok: false, error: "bad_article" });
    expect(parseMovementsQuery(q({ corrections: "x" }), TODAY)).toEqual({ ok: false, error: "bad_corrections" });
    expect(parseMovementsQuery(q({ from: "2026-01-01" }), TODAY)).toEqual({ ok: false, error: "period_too_long" });
  });

  it("month", () => {
    expect(parseMonthQuery(q({ month: "2026-09" }), TODAY)).toEqual({ ok: true, value: "2026-09-01" });
    expect(parseMonthQuery(q({ month: "2026-10" }), TODAY)).toEqual({ ok: true, value: "2026-10-01" });
    expect(parseMonthQuery(q({ month: "2026-11" }), TODAY)).toEqual({ ok: false, error: "bad_month" });
    expect(parseMonthQuery(q({ month: "2026-13" }), TODAY)).toEqual({ ok: false, error: "bad_month" });
    expect(parseMonthQuery(q({ month: "2019-12" }), TODAY)).toEqual({ ok: false, error: "bad_month" });
    expect(parseMonthQuery(q({}), TODAY)).toEqual({ ok: false, error: "bad_month" });
  });

  it("articles list", () => {
    expect(parseArticlesQuery(q({}))).toEqual({ ok: true, value: { q: "", warehouse: "main", active: true, limit: 200, preview: null } });
    expect(parseArticlesQuery(q({ q: "колаген", active: "all", limit: "500", preview: "0" })))
      .toEqual({ ok: true, value: { q: "колаген", warehouse: "main", active: null, limit: 500, preview: false } });
    expect(parseArticlesQuery(q({ active: "0" })).ok && (parseArticlesQuery(q({ active: "0" })) as any).value.active).toBe(false);
    expect(parseArticlesQuery(q({ active: "some" }))).toEqual({ ok: false, error: "bad_active" });
    expect(parseArticlesQuery(q({ limit: "501" }))).toEqual({ ok: false, error: "bad_limit" });
  });

  it("free text loses control characters and LIKE metacharacters, ≤ 80", () => {
    expect(cleanSearch("a%b_c\\d,e(f)g'h\"i*\u0000j")).toBe("a b c d e f g h i j");
    expect(cleanSearch("x".repeat(200))).toHaveLength(80);
    expect(cleanSearch(null)).toBe("");
  });
});

describe("body parsers", () => {
  it("instants: ISO with an offset, a bare day = Skopje midnight, -infinity only where allowed", () => {
    expect(parseInstant("2026-09-22T00:00:00+02:00", NOW)).toEqual({ ok: true, value: "2026-09-21T22:00:00.000Z" });
    expect(parseInstant("2026-09-22", NOW)).toEqual({ ok: true, value: "2026-09-21T22:00:00.000Z" });
    expect(parseInstant("2026-01-15", NOW)).toEqual({ ok: true, value: "2026-01-14T23:00:00.000Z" });  // winter: +1
    expect(parseInstant("2026-09-22T08:00:00", NOW)).toEqual({ ok: false, error: "bad_time" });       // no offset
    expect(parseInstant("-infinity", NOW)).toEqual({ ok: false, error: "bad_time" });
    expect(parseInstant("-infinity", NOW, { allowInfinity: true })).toEqual({ ok: true, value: "-infinity" });
    expect(parseInstant("2026-10-01T11:00:00Z", NOW)).toEqual({ ok: false, error: "time_in_future" });
    expect(parseInstant("2026-10-01T10:05:00Z", NOW).ok).toBe(true);                                   // clock skew
    expect(parseInstant("2019-06-01", NOW)).toEqual({ ok: false, error: "bad_time" });
    expect(parseInstant(12, NOW)).toEqual({ ok: false, error: "bad_time" });
  });

  it("quantities", () => {
    expect(isQty(0, false)).toBe(true);
    expect(isQty(0, true)).toBe(false);
    expect(isQty(1.25, true)).toBe(true);
    expect(isQty(0.001, true)).toBe(true);
    expect(isQty(0.0001, true)).toBe(false);
    expect(isQty(-1, false)).toBe(false);
    expect(isQty(1_000_001, false)).toBe(false);
    expect(isQty(Number.NaN, false)).toBe(false);
    expect(isQty("3", false)).toBe(false);
  });

  it("lines", () => {
    expect(parseQtyLines([{ code: " 000123 ", qty: 2 }], { min: 1, max: 5, positive: true })).toEqual({ ok: true, value: [{ code: "000123", qty: 2 }] });
    expect(parseQtyLines([], { min: 1, max: 5, positive: true })).toEqual({ ok: false, error: "lines_required" });
    expect(parseQtyLines([], { min: 0, max: 5, positive: true })).toEqual({ ok: true, value: [] });
    expect(parseQtyLines("x", { min: 0, max: 5, positive: true })).toEqual({ ok: false, error: "lines_required" });
    expect(parseQtyLines([1], { min: 1, max: 5, positive: true })).toEqual({ ok: false, error: "bad_line" });
    expect(parseQtyLines([{ code: "x", qty: 1 }], { min: 1, max: 5, positive: true })).toEqual({ ok: false, error: "bad_code" });
    expect(parseQtyLines([{ code: "000123", qty: 0 }], { min: 1, max: 5, positive: true })).toEqual({ ok: false, error: "bad_qty" });
    expect(parseQtyLines([{ code: "000123", qty: 1 }, { code: "000123", qty: 2 }], { min: 1, max: 5, positive: true }))
      .toEqual({ ok: false, error: "duplicate_code" });
    expect(parseQtyLines(Array.from({ length: 6 }, (_, i) => ({ code: `00000${i}`, qty: 1 })), { min: 1, max: 5, positive: true }))
      .toEqual({ ok: false, error: "too_many_lines" });
  });

  const count = { warehouse: "main", counted_at: "2026-09-22T07:00:00+02:00", kind: "opening", lines: [{ code: "000123", qty: 0 }, { code: "L00001", qty: 12.5 }], dry: true };
  it("count: a good request", () => {
    expect(parseCountRequest(count, NOW)).toEqual({ ok: true, value: {
      warehouse: "main", counted_at: "2026-09-22T05:00:00.000Z", kind: "opening",
      lines: [{ code: "000123", qty: 0 }, { code: "L00001", qty: 12.5 }],
      packed_counted: false, source: "manual", source_ref: null, note: null, dry: true } });
    const full = parseCountRequest({ ...count, kind: "partial", packed_counted: true, source: "sigma_variant", source_ref: " 04_morning_2209 ", note: "  ", dry: false }, NOW);
    expect(full.ok && full.value).toMatchObject({ kind: "partial", packed_counted: true, source: "sigma_variant", source_ref: "04_morning_2209", note: null, dry: false });
  });
  it("count: refusals", () => {
    expect(parseCountRequest(null, NOW)).toEqual({ ok: false, error: "body_required" });
    expect(parseCountRequest({ ...count, warehouse: "MAIN" }, NOW)).toEqual({ ok: false, error: "bad_warehouse" });
    expect(parseCountRequest({ ...count, counted_at: "yesterday" }, NOW)).toEqual({ ok: false, error: "bad_counted_at" });
    expect(parseCountRequest({ ...count, counted_at: "2026-10-02T00:00:00Z" }, NOW)).toEqual({ ok: false, error: "counted_at_in_future" });
    expect(parseCountRequest({ ...count, kind: "monthly" }, NOW)).toEqual({ ok: false, error: "bad_kind" });
    expect(parseCountRequest({ ...count, lines: [] }, NOW)).toEqual({ ok: false, error: "lines_required" });
    expect(parseCountRequest({ ...count, lines: [{ code: "000123", qty: -1 }] }, NOW)).toEqual({ ok: false, error: "bad_qty" });
    expect(parseCountRequest({ ...count, packed_counted: "yes" }, NOW)).toEqual({ ok: false, error: "bad_packed_counted" });
    expect(parseCountRequest({ ...count, source: "bigarena" }, NOW)).toEqual({ ok: false, error: "bad_source" });
    expect(parseCountRequest({ ...count, source_ref: "x".repeat(201) }, NOW)).toEqual({ ok: false, error: "bad_source_ref" });
    expect(parseCountRequest({ ...count, note: 5 }, NOW)).toEqual({ ok: false, error: "bad_note" });
    expect(parseCountRequest({ ...count, note: "x".repeat(501) }, NOW)).toEqual({ ok: false, error: "bad_note" });
    const { dry: _dry, ...noDry } = count;
    expect(parseCountRequest(noDry, NOW)).toEqual({ ok: false, error: "dry_required" });
  });

  it("void reason", () => {
    expect(parseReasonBody({ reason: "  wrong shelf  " })).toEqual({ ok: true, value: "wrong shelf" });
    expect(parseReasonBody({ reason: "no" })).toEqual({ ok: false, error: "reason_required" });
    expect(parseReasonBody({})).toEqual({ ok: false, error: "reason_required" });
    expect(parseReasonBody({ reason: "x".repeat(501) })).toEqual({ ok: false, error: "reason_too_long" });
  });

  const move = { kind: "receipt", to: "main", event_at: "2026-09-30T12:00:00+02:00", lines: [{ code: "000123", qty: 10 }], dry: true };
  it("manual move: the sides each kind needs", () => {
    expect(parseManualMoveRequest(move, NOW)).toEqual({ ok: true, value: {
      kind: "receipt", from: null, to: "main", event_at: "2026-09-30T10:00:00.000Z", doc_ref: null, note: null,
      lines: [{ code: "000123", qty: 10 }], dry: true } });
    expect(parseManualMoveRequest({ ...move, to: null }, NOW)).toEqual({ ok: false, error: "to_required" });
    expect(parseManualMoveRequest({ ...move, kind: "transfer", from: "main" }, NOW).ok).toBe(false);
    expect(parseManualMoveRequest({ ...move, kind: "transfer", from: "main", to: "wh08" }, NOW).ok).toBe(true);
    expect(parseManualMoveRequest({ ...move, kind: "transfer", from: "main", to: "main" }, NOW)).toEqual({ ok: false, error: "same_warehouse" });
    expect(parseManualMoveRequest({ ...move, kind: "transfer", to: "main" }, NOW)).toEqual({ ok: false, error: "from_and_to_required" });
    expect(parseManualMoveRequest({ ...move, kind: "adjust", from: "main", to: "main" }, NOW)).toEqual({ ok: false, error: "one_side_required" });
    expect(parseManualMoveRequest({ ...move, kind: "adjust", to: null }, NOW)).toEqual({ ok: false, error: "one_side_required" });
    expect(parseManualMoveRequest({ ...move, kind: "adjust", from: "main", to: undefined }, NOW).ok).toBe(true);
    expect(parseManualMoveRequest({ ...move, kind: "writeoff", to: "writeoff" }, NOW)).toEqual({ ok: false, error: "from_required" });
    expect(parseManualMoveRequest({ ...move, kind: "writeoff", from: "main", to: "writeoff" }, NOW).ok).toBe(true);
    expect(parseManualMoveRequest({ ...move, kind: "damaged", from: "main", to: "damaged" }, NOW).ok).toBe(true);
    expect(parseManualMoveRequest({ ...move, kind: "unpack" }, NOW).ok).toBe(true);
  });
  it("manual move: refusals", () => {
    expect(parseManualMoveRequest({ ...move, kind: "sale" }, NOW)).toEqual({ ok: false, error: "bad_kind" });
    expect(parseManualMoveRequest({ ...move, to: "Main!" }, NOW)).toEqual({ ok: false, error: "bad_warehouse" });
    expect(parseManualMoveRequest({ ...move, event_at: "2026-10-03T00:00:00Z" }, NOW)).toEqual({ ok: false, error: "event_at_in_future" });
    expect(parseManualMoveRequest({ ...move, event_at: "soon" }, NOW)).toEqual({ ok: false, error: "bad_event_at" });
    expect(parseManualMoveRequest({ ...move, lines: [{ code: "000123", qty: 0 }] }, NOW)).toEqual({ ok: false, error: "bad_qty" });
    expect(parseManualMoveRequest({ ...move, doc_ref: "x".repeat(101) }, NOW)).toEqual({ ok: false, error: "bad_doc_ref" });
    expect(parseManualMoveRequest({ ...move, dry: "no" }, NOW)).toEqual({ ok: false, error: "dry_required" });
  });

  it("parcel override", () => {
    expect(parseParcelOverride({ tracking_id: " 9110123456 ", action: "exclude", note: "test parcel" }))
      .toEqual({ ok: true, value: { tracking_id: "9110123456", action: "exclude", payload: {}, note: "test parcel" } });
    expect(parseParcelOverride({ tracking_id: "NTMK-1", action: "lines", payload: { lines: [{ code: "000123", qty: 1 }] }, note: "real lines" }).ok).toBe(true);
    expect(parseParcelOverride({ tracking_id: "NTMK-1", action: "lines", payload: {}, note: "real lines" })).toEqual({ ok: false, error: "lines_required" });
    expect(parseParcelOverride({ tracking_id: "NTMK-1", action: "route", payload: { warehouse: "wh08" }, note: "routed" }).ok).toBe(true);
    expect(parseParcelOverride({ tracking_id: "NTMK-1", action: "route", payload: {}, note: "routed" })).toEqual({ ok: false, error: "bad_warehouse" });
    expect(parseParcelOverride({ tracking_id: "91 10", action: "exclude", note: "abc" })).toEqual({ ok: false, error: "bad_tracking_id" });
    expect(parseParcelOverride({ tracking_id: "9110", action: "delete", note: "abc" })).toEqual({ ok: false, error: "bad_action" });
    expect(parseParcelOverride({ tracking_id: "9110", action: "exclude", payload: [1], note: "abc" })).toEqual({ ok: false, error: "bad_payload" });
    expect(parseParcelOverride({ tracking_id: "9110", action: "exclude", payload: { x: "y".repeat(20_001) }, note: "abc" }))
      .toEqual({ ok: false, error: "payload_too_large" });
    expect(parseParcelOverride({ tracking_id: "9110", action: "exclude" })).toEqual({ ok: false, error: "note_required" });
  });

  it("config patch", () => {
    expect(parseConfigPatch({ routes: [{ id: 1, priority: 100 }] })).toEqual({ ok: true, value: { config: { routes: [{ id: 1, priority: 100 }] }, settings: null } });
    expect(parseConfigPatch({ settings: { stale_label_days: 10 } })).toEqual({ ok: true, value: { config: null, settings: { stale_label_days: 10 } } });
    expect(parseConfigPatch({ settings: { enabled: true } })).toEqual({ ok: false, error: "use_switch" });
    expect(parseConfigPatch({})).toEqual({ ok: false, error: "nothing_to_update" });
    expect(parseConfigPatch({ routes: "x" })).toEqual({ ok: false, error: "bad_routes" });
    expect(parseConfigPatch({ warehouses: [1] })).toEqual({ ok: false, error: "bad_warehouses" });
    expect(parseConfigPatch({ owners: [] })).toEqual({ ok: false, error: "unknown_key:owners" });
    expect(parseConfigPatch({ settings: [] })).toEqual({ ok: false, error: "bad_settings" });
    expect(parseConfigPatch({ sigma_rules: Array.from({ length: 201 }, () => ({})) })).toEqual({ ok: false, error: "bad_sigma_rules" });
  });

  it("switch / run", () => {
    expect(parseSwitchBody({ enabled: true })).toEqual({ ok: true, value: true });
    expect(parseSwitchBody({ enabled: "on" })).toEqual({ ok: false, error: "enabled_required" });
    expect(parseRunBody({ dry: false })).toEqual({ ok: true, value: false });
    expect(parseRunBody({})).toEqual({ ok: false, error: "dry_required" });
    expect(parseRunBody(null)).toEqual({ ok: false, error: "dry_required" });
  });

  it("article cost", () => {
    expect(parseArticleCostBody({ code: "000123", cost_mkd: 123.4567, valid_from: "-infinity", note: " Sigma " }, NOW))
      .toEqual({ ok: true, value: { code: "000123", cost_mkd: 123.4567, valid_from: "-infinity", note: "Sigma" } });
    expect(parseArticleCostBody({ code: "000123", cost_mkd: 0, valid_from: "2026-09-22" }, NOW))
      .toEqual({ ok: true, value: { code: "000123", cost_mkd: 0, valid_from: "2026-09-21T22:00:00.000Z", note: null } });
    expect(parseArticleCostBody({ code: "000123", cost_mkd: 1.23456, valid_from: "-infinity" }, NOW)).toEqual({ ok: false, error: "bad_cost" });
    expect(parseArticleCostBody({ code: "000123", cost_mkd: -1, valid_from: "-infinity" }, NOW)).toEqual({ ok: false, error: "bad_cost" });
    expect(parseArticleCostBody({ code: "000123", cost_mkd: "5", valid_from: "-infinity" }, NOW)).toEqual({ ok: false, error: "bad_cost" });
    expect(parseArticleCostBody({ code: "ABC", cost_mkd: 5, valid_from: "-infinity" }, NOW)).toEqual({ ok: false, error: "bad_code" });
    expect(parseArticleCostBody({ code: "000123", cost_mkd: 5 }, NOW)).toEqual({ ok: false, error: "bad_valid_from" });
  });

  it("recipe", () => {
    expect(parseRecipeBody({ product_id: P2, lines: [{ code: "000123", qty: 2 }, { code: "000777", qty: 1, role: "gift" }], approve: true }, NOW))
      .toEqual({ ok: true, value: { product_id: P2.toLowerCase(), approve: true, valid_from: null, note: null,
        lines: [{ code: "000123", qty: 2, role: "main" }, { code: "000777", qty: 1, role: "gift" }] } });
    expect(parseRecipeBody({ product_id: P1, lines: [] }, NOW).ok).toBe(true);    // no recipe
    expect(parseRecipeBody({ product_id: P1, lines: [], valid_from: "2026-09-22" }, NOW).ok).toBe(true);
    expect(parseRecipeBody({ product_id: "x", lines: [] }, NOW)).toEqual({ ok: false, error: "bad_product_id" });
    expect(parseRecipeBody({ product_id: P1 }, NOW)).toEqual({ ok: false, error: "lines_required" });
    expect(parseRecipeBody({ product_id: P1, lines: [{ code: "000123", qty: 101 }] }, NOW)).toEqual({ ok: false, error: "bad_qty" });
    expect(parseRecipeBody({ product_id: P1, lines: [{ code: "000123", qty: 0 }] }, NOW)).toEqual({ ok: false, error: "bad_qty" });
    expect(parseRecipeBody({ product_id: P1, lines: [{ code: "000123", qty: 1, role: "bonus" }] }, NOW)).toEqual({ ok: false, error: "bad_role" });
    expect(parseRecipeBody({ product_id: P1, lines: [{ code: "000123", qty: 1 }, { code: "000123", qty: 1 }] }, NOW)).toEqual({ ok: false, error: "duplicate_code" });
    expect(parseRecipeBody({ product_id: P1, lines: [], approve: "yes" }, NOW)).toEqual({ ok: false, error: "bad_approve" });
    expect(parseRecipeBody({ product_id: P1, lines: [], valid_from: "soon" }, NOW)).toEqual({ ok: false, error: "bad_valid_from" });
    expect(parseRecipeBody({ product_id: P1, lines: Array.from({ length: 51 }, (_, i) => ({ code: String(100000 + i), qty: 1 })) }, NOW))
      .toEqual({ ok: false, error: "too_many_lines" });
  });

  it("approve / exempt", () => {
    expect(parseApproveBody({ product_ids: [P1, P1.toUpperCase(), P2] })).toEqual({ ok: true, value: [P1, P2.toLowerCase()] });
    expect(parseApproveBody({ product_ids: [] })).toEqual({ ok: false, error: "product_ids_required" });
    expect(parseApproveBody({ product_ids: ["x"] })).toEqual({ ok: false, error: "bad_product_id" });
    expect(parseApproveBody(null)).toEqual({ ok: false, error: "product_ids_required" });
    expect(parseExemptBody({ product_ids: [P1], exempt: true, reason: "delivery" })).toEqual({ ok: true, value: { product_ids: [P1], exempt: true, reason: "delivery" } });
    expect(parseExemptBody({ product_ids: [P1], exempt: false })).toEqual({ ok: true, value: { product_ids: [P1], exempt: false, reason: null } });
    expect(parseExemptBody({ product_ids: [P1], exempt: true })).toEqual({ ok: false, error: "reason_required" });
    expect(parseExemptBody({ product_ids: [P1] })).toEqual({ ok: false, error: "exempt_required" });
  });

  it("alias", () => {
    expect(parseAliasBody({ source: "collabbox_code", key: " NT0108 ", lines: [{ code: "000123", qty: 1 }], approve: true }))
      .toEqual({ ok: true, value: { source: "collabbox_code", key: "NT0108", lines: [{ code: "000123", qty: 1 }], approve: true } });
    expect(parseAliasBody({ source: "name_any", key: "ПОЕН", lines: [] })).toEqual({ ok: true, value: { source: "name_any", key: "ПОЕН", lines: [], approve: false } });
    expect(parseAliasBody({ source: "sku", key: "x", lines: [] })).toEqual({ ok: false, error: "bad_source" });
    expect(parseAliasBody({ source: "web_sku", key: "", lines: [] })).toEqual({ ok: false, error: "bad_key" });
    expect(parseAliasBody({ source: "web_sku", key: "x" })).toEqual({ ok: false, error: "lines_required" });
  });

  it("Sigma batch", () => {
    const b = { batch_id: "csv-2026-10-01T10:00", source: "csv", mode: "delta", exported_at: "2026-10-01T10:00:00+02:00", docs: [{ doc_key: "2026|10|1" }] };
    expect(parseSigmaBatch(b)).toEqual({ ok: true, value: b });
    expect(parseSigmaBatch({ ...b, batch_id: "has space" })).toEqual({ ok: false, error: "bad_batch_id" });
    expect(parseSigmaBatch({ ...b, source: "ftp" })).toEqual({ ok: false, error: "bad_source" });
    expect(parseSigmaBatch({ ...b, mode: "all" })).toEqual({ ok: false, error: "bad_mode" });
    expect(parseSigmaBatch({ ...b, exported_at: "today" })).toEqual({ ok: false, error: "bad_exported_at" });
    expect(parseSigmaBatch({ ...b, mode: "snapshot" })).toEqual({ ok: false, error: "window_required" });
    expect(parseSigmaBatch({ ...b, mode: "snapshot", window: { from: "2026-09-22", to: "2026-10-01" } }).ok).toBe(true);
    expect(parseSigmaBatch({ ...b, window: { from: "x", to: "y" } })).toEqual({ ok: false, error: "bad_window" });
    expect(parseSigmaBatch({ ...b, docs: "x" })).toEqual({ ok: false, error: "bad_docs" });
    expect(parseSigmaBatch({ ...b, items: [1] })).toEqual({ ok: false, error: "bad_items" });
    expect(parseSigmaBatch([])).toEqual({ ok: false, error: "bad_batch" });
  });
});

describe("money strip", () => {
  const payload = {
    day: TODAY,
    totals: { closing: 10, value_mkd: 5000 },
    articles: [
      { code: "000123", closing: 4, cost_mkd: 100, value_mkd: 400, nested: [{ cod_mkd: 1, units: 2, deep: { value_diff_mkd: 3, ok: true } }] },
      { code: "000777", closing: 6, cost_mkd: null, price_eur: 2, calc_buy_price: 9, cost_price: 1 },
    ],
    list: [[{ value_mkd: 1, n: 1 }]],
    note: "value_mkd stays a string value",
  };
  it("removes the money keys at any depth, arrays of arrays included", () => {
    expect(stripStockMoney(payload)).toEqual({
      day: TODAY,
      totals: { closing: 10 },
      articles: [
        { code: "000123", closing: 4, nested: [{ units: 2, deep: { ok: true } }] },
        { code: "000777", closing: 6 },
      ],
      list: [[{ n: 1 }]],
      note: "value_mkd stays a string value",
    });
  });
  it("never mutates its input; owners get it untouched", () => {
    const copy = JSON.parse(JSON.stringify(payload));
    stripStockMoney(payload);
    expect(payload).toEqual(copy);
    expect(moneyView(true, payload)).toBe(payload);
    expect(moneyView(false, payload)).not.toHaveProperty("totals.value_mkd");
  });
  it("passes scalars and null through", () => {
    expect(stripStockMoney(null)).toBe(null);
    expect(stripStockMoney(5)).toBe(5);
    expect(stripStockMoney([1, "a"])).toEqual([1, "a"]);
  });
});

describe("HMAC — POST stock/sigma/ingest", () => {
  const SECRET = "test-secret-not-real";
  const body = JSON.stringify({ batch_id: "b1", source: "connector", mode: "delta", exported_at: "2026-10-01T10:00:00Z" });
  const ts = String(Math.floor(NOW / 1000));

  it("a valid signature passes (string and bytes)", async () => {
    const sig = await sigmaSignature(SECRET, ts, body);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifySigmaSignature(ts, body, sig, SECRET, NOW)).toEqual({ ok: true });
    expect(await verifySigmaSignature(ts, new TextEncoder().encode(body), sig.toUpperCase(), SECRET, NOW)).toEqual({ ok: true });
    expect(await verifySigmaSignature(ts, body, `sha256=${sig}`, SECRET, NOW)).toEqual({ ok: true });
  });
  it("matches an independent HMAC (node:crypto)", async () => {
    const { createHmac } = await import("node:crypto");
    const expected = createHmac("sha256", SECRET).update(`${ts}.${body}`).digest("hex");
    expect(await sigmaSignature(SECRET, ts, body)).toBe(expected);
  });
  it("a wrong secret fails", async () => {
    const sig = await sigmaSignature("another-secret", ts, body);
    expect(await verifySigmaSignature(ts, body, sig, SECRET, NOW)).toEqual({ ok: false, error: "bad_signature" });
  });
  it("a tampered body fails", async () => {
    const sig = await sigmaSignature(SECRET, ts, body);
    expect(await verifySigmaSignature(ts, body.replace("b1", "b2"), sig, SECRET, NOW)).toEqual({ ok: false, error: "bad_signature" });
    expect(await verifySigmaSignature(ts, body + " ", sig, SECRET, NOW)).toEqual({ ok: false, error: "bad_signature" });
  });
  it("the timestamp is signed: another ts with the same signature fails", async () => {
    const sig = await sigmaSignature(SECRET, ts, body);
    const other = String(Number(ts) + 1);
    expect(await verifySigmaSignature(other, body, sig, SECRET, NOW)).toEqual({ ok: false, error: "bad_signature" });
  });
  it("a stale or future timestamp fails (±300 s)", async () => {
    const old = String(Math.floor(NOW / 1000) - SIGMA_MAX_SKEW_S - 1);
    const sigOld = await sigmaSignature(SECRET, old, body);
    expect(await verifySigmaSignature(old, body, sigOld, SECRET, NOW)).toEqual({ ok: false, error: "stale" });
    const fut = String(Math.floor(NOW / 1000) + SIGMA_MAX_SKEW_S + 1);
    expect(await verifySigmaSignature(fut, body, await sigmaSignature(SECRET, fut, body), SECRET, NOW)).toEqual({ ok: false, error: "stale" });
    const edge = String(Math.floor(NOW / 1000) - SIGMA_MAX_SKEW_S);
    expect(await verifySigmaSignature(edge, body, await sigmaSignature(SECRET, edge, body), SECRET, NOW)).toEqual({ ok: true });
  });
  it("milliseconds are accepted as a timestamp", async () => {
    const ms = String(NOW);
    expect(await verifySigmaSignature(ms, body, await sigmaSignature(SECRET, ms, body), SECRET, NOW)).toEqual({ ok: true });
  });
  it("missing headers, a bad timestamp or a malformed signature fail", async () => {
    const sig = await sigmaSignature(SECRET, ts, body);
    expect(await verifySigmaSignature(null, body, sig, SECRET, NOW)).toEqual({ ok: false, error: "missing_headers" });
    expect(await verifySigmaSignature(ts, body, "", SECRET, NOW)).toEqual({ ok: false, error: "missing_headers" });
    expect(await verifySigmaSignature("12a", body, sig, SECRET, NOW)).toEqual({ ok: false, error: "bad_timestamp" });
    expect(await verifySigmaSignature("2026-10-01T10:00:00Z", body, sig, SECRET, NOW)).toEqual({ ok: false, error: "bad_timestamp" });
    expect(await verifySigmaSignature(ts, body, sig.slice(0, 63), SECRET, NOW)).toEqual({ ok: false, error: "bad_signature" });
    expect(await verifySigmaSignature(ts, body, "z".repeat(64), SECRET, NOW)).toEqual({ ok: false, error: "bad_signature" });
  });
  it("no secret configured → fail closed", async () => {
    const sig = await sigmaSignature(SECRET, ts, body);
    expect(await verifySigmaSignature(ts, body, sig, "", NOW)).toEqual({ ok: false, error: "not_configured" });
    expect(await verifySigmaSignature(ts, body, sig, undefined, NOW)).toEqual({ ok: false, error: "not_configured" });
    expect(sigmaVerdictStatus("not_configured")).toBe(503);
    expect(sigmaVerdictStatus("bad_signature")).toBe(401);
    expect(sigmaVerdictStatus("stale")).toBe(401);
  });
  it("timing-safe equality", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
    expect(timingSafeEqual("", "")).toBe(true);
  });
});

describe("SQL refusals → HTTP", () => {
  it("maps Postgres / PostgREST codes", () => {
    expect(stockRpcError({ code: "PGRST202", message: "Could not find the function" })).toEqual({ status: 503, body: { error: "not_installed" } });
    expect(stockRpcError({ code: "42P01" }).status).toBe(503);
    expect(stockRpcError({ code: "PGRST205", message: "Could not find the table" })).toEqual({ status: 503, body: { error: "not_installed" } });
    expect(stockRpcError({ code: "22023", message: "unknown article 999999" })).toEqual({ status: 400, body: { error: "bad_request", detail: "unknown article 999999" } });
    expect(stockRpcError({ code: "42501", message: "owners only" }).status).toBe(403);
    expect(stockRpcError({ code: "P0002" }).status).toBe(404);
    expect(stockRpcError({ code: "23505", message: "dup key (secret detail)" })).toEqual({ status: 409, body: { error: "conflict" } });
    expect(stockRpcError({ code: "55P03" })).toEqual({ status: 409, body: { error: "busy" } });
    expect(stockRpcError({ code: "57014" }).status).toBe(504);
    expect(stockRpcError({ code: "P0001", message: "no_opening" })).toEqual({ status: 409, body: { error: "no_opening" } });
    expect(stockRpcError({ code: "P0001", message: "owners_only" })).toEqual({ status: 403, body: { error: "owners_only" } });
    expect(stockRpcError({ code: "P0001", message: "Something human went wrong" })).toEqual({ status: 400, body: { error: "bad_request", detail: "Something human went wrong" } });
    expect(stockRpcError({ code: "XX000", message: "relation stock_moves …" })).toEqual({ status: 500, body: { error: "failed" } });
    expect(stockRpcError(null)).toEqual({ status: 500, body: { error: "failed" } });
  });
  it("maps {ok:false, error} results and lets everything else through", () => {
    expect(resultError({ ok: false, error: "disabled" })).toEqual({ status: 409, body: { error: "disabled" } });
    expect(resultError({ ok: false, error: "not_found", detail: "count" })).toEqual({ status: 404, body: { error: "not_found", detail: "count" } });
    expect(resultError({ ok: false, error: "Weird Message!" })).toEqual({ status: 400, body: { error: "failed" } });
    expect(resultError({ ok: false })).toEqual({ status: 400, body: { error: "failed" } });
    expect(resultError({ ok: true })).toBe(null);
    expect(resultError({ status: "disabled" })).toBe(null);
    expect(resultError([])).toBe(null);
    expect(resultError(null)).toBe(null);
  });
});

describe("shapes", () => {
  it("article costs: newest valid_from ≤ at, an owner value wins a tie", () => {
    const at = Date.parse("2026-10-01T00:00:00Z");
    const m = pickArticleCosts([
      { article_code: "000123", cost_mkd: 100, valid_from: "-infinity", source: "sigma_calcbuyprice" },
      { article_code: "000123", cost_mkd: 120, valid_from: "2026-09-29T00:00:00Z", source: "sigma_calcbuyprice" },
      { article_code: "000123", cost_mkd: 999, valid_from: "2026-10-05T00:00:00Z", source: "sigma_calcbuyprice" },
      { article_code: "000777", cost_mkd: 50, valid_from: "-infinity", source: "sigma_calcbuyprice" },
      { article_code: "000777", cost_mkd: 55, valid_from: "-infinity", source: "owner" },
      { article_code: "000888", cost_mkd: null, valid_from: "-infinity", source: "owner" },
    ], at);
    expect(m.get("000123")).toBe(120);
    expect(m.get("000777")).toBe(55);
    expect(m.has("000888")).toBe(false);
  });

  it("on-hand map and article rows (cost only when given)", () => {
    const oh = onHandMap([{ warehouse_code: "main", article_code: "000123", qty: "4.5" }, { article_code: "000777", qty: -2 }, { bad: 1 }]);
    expect(oh.get("000123")).toBe(4.5);
    const rows = [{ code: "000123", name: "Колаген", unit: "КОМ", brand: null, active: true }, { code: "000999", name: "X", unit: "КГ", brand: "BN", active: false }];
    expect(shapeArticleRows(rows, oh, null)).toEqual([
      { code: "000123", name: "Колаген", unit: "КОМ", brand: null, active: true, on_hand: 4.5 },
      { code: "000999", name: "X", unit: "КГ", brand: "BN", active: false, on_hand: 0 },
    ]);
    expect(shapeArticleRows(rows, null, new Map([["000123", 10]]))[0]).toMatchObject({ on_hand: null, cost_mkd: 10 });
    expect(shapeArticleRows(rows, null, new Map([["000123", 10]]))[1]).toMatchObject({ cost_mkd: null });
  });

  it("recipe: live lines sorted, completeness, money only for owners", () => {
    const input = {
      product: { id: P1, name: "Collagen 2x" },
      lines: [
        { article_code: "000777", qty: 1, role: "gift", status: "approved", confidence: "high" },
        { article_code: "000123", qty: 2, role: "main", status: "approved", confidence: "high" },
        { article_code: "000555", qty: 1, role: "main", status: "proposed", confidence: "low" },
        { article_code: "000444", qty: 1, role: "main", status: "approved", confidence: "high", valid_to: "2026-09-01T00:00:00Z" },
      ],
      names: new Map([["000123", "Колаген"], ["000777", "Шејкер"]]),
      exempt: false,
      costs: new Map([["000123", 100], ["000777", 10]]),
      nowMs: NOW,
    };
    const owner = shapeRecipe({ ...input, money: true });
    expect(owner).toEqual({
      product_id: P1, product_name: "Collagen 2x", exempt: false, complete: true, cost_mkd: 210,
      lines: [
        { code: "000123", name: "Колаген", qty: 2, role: "main", status: "approved", confidence: "high", cost_mkd: 100 },
        { code: "000777", name: "Шејкер", qty: 1, role: "gift", status: "approved", confidence: "high", cost_mkd: 10 },
        { code: "000555", name: "", qty: 1, role: "main", status: "proposed", confidence: "low", cost_mkd: null },
      ],
    });
    expect(shapeRecipe({ ...input, money: true, productCost: 205 }).cost_mkd).toBe(205);
    const staff = shapeRecipe({ ...input, money: false });
    expect(staff).not.toHaveProperty("cost_mkd");
    expect((staff.lines as any[])[0]).not.toHaveProperty("cost_mkd");
    expect(staff.complete).toBe(true);
    const uncosted = shapeRecipe({ ...input, costs: new Map([["000123", 100]]), money: true });
    expect(uncosted).toMatchObject({ complete: false, cost_mkd: null });
    expect(shapeRecipe({ ...input, lines: [], money: true })).toMatchObject({ complete: false, lines: [], cost_mkd: null });
  });

  it("config: everything for owners, the warehouses for the rest", () => {
    const input = {
      settings: { enabled: false, stale_label_days: 14 },
      warehouses: [
        { id: 2, code: "wh08", name: "Сигма 08", role: "review", tracked: false, sellable: false, active: true, sort: 2, sigma_moves_from: null },
        { id: 1, code: "main", name: "Главен магацин Скопје", role: "main", tracked: true, sellable: true, active: true, sort: 1, sigma_moves_from: "2026-09-22T00:00:00+02:00" },
      ],
      keys: [{ system: "sigma", key: "Ф00001-04", warehouse_id: 1 }, { system: "collabbox", key: "002", warehouse_id: 1 }],
      routes: [{ id: 1, priority: 100, match_account: null, match_series: null, match_shape: null, warehouse_id: 1, return_warehouse_id: null, valid_from: "2026-09-21T22:00:00+00:00", valid_to: null, active: true }],
      rules: [{ id: 1, match: { client_code: "000217" }, action: "exclude", reason: "MEX invoices", active: true }],
    };
    const full = shapeConfig(input, true) as any;
    expect(full.warehouses.map((w: any) => w.code)).toEqual(["main", "wh08"]);
    expect(full.warehouses[0].keys).toEqual([{ system: "sigma", key: "Ф00001-04" }, { system: "collabbox", key: "002" }]);
    expect(full.routes).toEqual([{ id: 1, priority: 100, match_account: null, match_series: null, match_shape: null, warehouse: "main",
      return_warehouse: null, valid_from: "2026-09-21T22:00:00+00:00", valid_to: null, active: true }]);
    expect(full.sigma_rules).toEqual([{ id: 1, match: { client_code: "000217" }, action: "exclude", reason: "MEX invoices", active: true }]);
    expect(full.settings).toEqual({ enabled: false, stale_label_days: 14 });
    const lean = shapeConfig(input, false) as any;
    expect(lean.settings).toEqual({ enabled: false });
    expect(lean.routes).toEqual([]);
    expect(lean.sigma_rules).toEqual([]);
    expect(lean.warehouses[0]).toMatchObject({ code: "main", keys: [] });
  });

  it("Sigma status: the secret is only a yes/no, last batch per source", () => {
    const s = shapeSigmaStatus({
      settings: readStockV2Settings([{ key: "stock_v2", value: { enabled: false, sigma: { ingest: true } } }]),
      configured: true,
      batches: [
        { batch_id: "c2", source: "connector", mode: "delta", received_at: "2026-10-01T09:00:00Z", counts: { docs: 3 } },
        { batch_id: "f1", source: "csv", mode: "delta", received_at: "2026-09-30T09:00:00Z", result: "x" },
        { batch_id: "c1", source: "connector", mode: "snapshot", received_at: "2026-09-30T08:00:00Z" },
      ],
      docs: { staged: 10, excluded: 2, vanished: 1, versions_gt1: 3, drafts: 4 },
    }) as any;
    expect(s).toMatchObject({ enabled: false, ingest: true, configured: true, last_batch_at: "2026-10-01T09:00:00Z",
      connector_last_seen: "2026-10-01T09:00:00Z", csv_last_seen: "2026-09-30T09:00:00Z",
      docs: { staged: 10, excluded: 2, vanished: 1, versions_gt1: 3, drafts: 4 } });
    expect(s.batches[1].result).toEqual({});
    expect(JSON.stringify(s)).not.toContain("secret");
  });

  it("article code pattern", () => {
    expect(ARTICLE_RE.test("000123")).toBe(true);
    expect(ARTICLE_RE.test("L00123")).toBe(true);
    expect(ARTICLE_RE.test("l00123")).toBe(false);
    expect(ARTICLE_RE.test("0001234")).toBe(false);
  });
});
