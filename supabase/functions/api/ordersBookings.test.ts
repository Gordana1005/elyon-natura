import { describe, expect, it } from "vitest";
import {
  BOOKINGS_LOOKBACK_DAYS, bookingSaleRows, bookingsResponse, bookingsWindow, buildBookingRows, chunks,
  collabById, collabCandidateIds, COLLAB_STATES_MAX_IDS, countByDepartment, filterBookings, maskName, maskPhone,
  matchesSearch, parseBookingsParams, redactBookings, saleRowsArgs, sortBookings,
  type BookingRow, type CollabDocRow, type SaleRow,
} from "./ordersBookings.ts";
import { parseSearch } from "./ordersList.ts";

const TODAY = "2026-10-02";
const P1 = "b8a68017-96f2-4c36-8d86-b8d29a30bed1";
const P2 = "a01fae4f-3168-47ae-82c1-4c6cdbc61c1e";

const sale = (o: Partial<SaleRow>): SaleRow => ({
  kind: "booking", source: "teleshop_other", sale_at: "2026-10-02T06:38:54Z", value_mkd: 2000, person_id: P1,
  display_id: "002-9100-176650/2026", phone8: "78724890", ...o,
});
const doc = (o: Partial<CollabDocRow>): CollabDocRow => ({
  doc_number: "002-9100-176650/2026", doc_type_id: "10036", doc_type_name: "Нарачка in", komitent_name: "Владо Стојков",
  booked_at: "2026-10-02T06:38:54Z", doc_at: "2026-10-02T06:38:54Z", amount_mkd: "2000.00", ...o,
});
const row = (o: Partial<BookingRow>): BookingRow => ({
  doc_number: "002-9100-176650/2026", folder: "Нарачка in", doc_type_id: "10036", department: "teleshop_other",
  booked_at: "2026-10-02T06:38:54Z", dispatch_day: "2026-10-02", customer_name: "Владо Стојков", phone8: "78724890",
  value_mkd: 2000, seller_person_id: P1, seller_name: "Александра Чима", ...o,
});

describe("parseBookingsParams — the list's own parser", () => {
  it("reads day_from / day_to, dept, seller and search", () => {
    const r = parseBookingsParams(new URLSearchParams(`day_from=2026-10-01&day_to=2026-10-02&dept=teleshop_out,social&seller=${P1}&search=070 123 456`));
    expect(r).toEqual({
      ok: true,
      value: { dayFrom: "2026-10-01", dayTo: "2026-10-02", departments: ["teleshop_out", "social"], sellerId: P1, search: { kind: "phone", last8: "70123456" } },
    });
  });
  it("refuses what GET /orders refuses (never a silently wider list)", () => {
    expect(parseBookingsParams(new URLSearchParams("dept=bigarena")).ok).toBe(false);
    expect(parseBookingsParams(new URLSearchParams("seller=nope")).ok).toBe(false);
    expect(parseBookingsParams(new URLSearchParams("day_from=2026-02-30")).ok).toBe(false);
    expect(parseBookingsParams(new URLSearchParams("day_from=2026-10-02&day_to=2026-10-01")).ok).toBe(false);
  });
  it("ignores the list's other params (view, mex, page …)", () => {
    expect(parseBookingsParams(new URLSearchParams("view=orders&mex=no_parcel&page=3")).ok).toBe(true);
  });
});

describe("bookingsWindow — the days a booking can exist", () => {
  const earliest = "2026-09-04"; // today and the 28 days before
  it("a day inside the lookback is read as asked", () => {
    expect(bookingsWindow({ dayFrom: TODAY, dayTo: TODAY }, TODAY)).toEqual({ empty: false, from: TODAY, to: TODAY, clamped: false });
  });
  it("covers a booking booked 17 days back (15.09 on 02.10 — seen live)", () => {
    const w = bookingsWindow({ dayFrom: "2026-09-15", dayTo: "2026-09-15" }, TODAY);
    expect(w).toEqual({ empty: false, from: "2026-09-15", to: "2026-09-15", clamped: false });
  });
  it(`an open or older start is cut to the last ${BOOKINGS_LOOKBACK_DAYS} days and says so`, () => {
    expect(bookingsWindow({ dayFrom: null, dayTo: null }, TODAY)).toEqual({ empty: false, from: earliest, to: TODAY, clamped: true });
    expect(bookingsWindow({ dayFrom: "2026-01-01", dayTo: "2026-09-30" }, TODAY)).toEqual({ empty: false, from: earliest, to: "2026-09-30", clamped: true });
    expect(bookingsWindow({ dayFrom: earliest, dayTo: TODAY }, TODAY)).toMatchObject({ from: earliest, clamped: false });
  });
  it("a window wholly before the lookback, or in the future, is empty", () => {
    expect(bookingsWindow({ dayFrom: "2026-08-01", dayTo: "2026-08-31" }, TODAY)).toEqual({ empty: true, clamped: true });
    expect(bookingsWindow({ dayFrom: "2026-10-05", dayTo: "2026-10-06" }, TODAY)).toEqual({ empty: true, clamped: false });
  });
  it("the end never passes today", () => {
    expect(bookingsWindow({ dayFrom: TODAY, dayTo: "2026-10-31" }, TODAY)).toMatchObject({ from: TODAY, to: TODAY });
  });
  it("the RPC gets Skopje midnight … the day's last instant (CEST = UTC+2)", () => {
    expect(saleRowsArgs({ from: "2026-10-01", to: TODAY })).toEqual({
      p_from: "2026-09-30T22:00:00.000Z", p_to_end: "2026-10-02T21:59:59.999999Z",
    });
  });
});

describe("the rows — the cohort's booking rows, enriched", () => {
  it("keeps only kind = 'booking', each document once", () => {
    const rows = bookingSaleRows([
      sale({}), sale({}), sale({ kind: "order", display_id: "ORD-1" }), sale({ kind: "web", display_id: "NTMK-1" }),
      sale({ display_id: null }), sale({ display_id: "002-9102-1/2026", source: "teleshop_out" }),
    ]);
    expect(rows.map((r) => r.display_id)).toEqual(["002-9100-176650/2026", "002-9102-1/2026"]);
    expect(bookingSaleRows(null)).toEqual([]);
  });

  it("the cohort decides department, time and value; the document adds folder, customer, dispatch day", () => {
    const docs = new Map([["002-9100-176650/2026", doc({ doc_at: "2026-10-04T08:00:00Z", amount_mkd: "2150.00" })]]);
    const [r] = buildBookingRows([sale({ value_mkd: "2000" })], docs, new Map([[P1, "Александра Чима"]]));
    expect(r).toEqual({
      doc_number: "002-9100-176650/2026", folder: "Нарачка in", doc_type_id: "10036", department: "teleshop_other",
      booked_at: "2026-10-02T06:38:54Z", dispatch_day: "2026-10-04", customer_name: "Владо Стојков", phone8: "78724890",
      value_mkd: 2000, seller_person_id: P1, seller_name: "Александра Чима",
    });
  });

  it("a document the read missed still lists the booking (folder / customer unknown)", () => {
    const [r] = buildBookingRows([sale({ person_id: null, phone8: null })], new Map(), new Map());
    expect(r).toMatchObject({ folder: null, customer_name: null, dispatch_day: null, seller_name: null, seller_person_id: null, phone8: null, value_mkd: 2000 });
  });

  it("the dispatch day is the Skopje day (23:30 UTC on 01.10 = 02.10 in Skopje)", () => {
    const [r] = buildBookingRows([sale({})], new Map([["002-9100-176650/2026", doc({ doc_at: "2026-10-01T23:30:00Z" })]]), new Map());
    expect(r.dispatch_day).toBe("2026-10-02");
  });
});

describe("filters, scope and order", () => {
  const rows = [
    row({ doc_number: "002-9100-1/2026", department: "teleshop_other", seller_person_id: P1, booked_at: "2026-10-02T07:00:00Z" }),
    row({ doc_number: "002-9102-2/2026", department: "teleshop_out", seller_person_id: P2, booked_at: "2026-10-02T09:00:00Z", customer_name: "Марија Петровска", phone8: "70123456" }),
    row({ doc_number: "002-9108-3/2026", department: "social", seller_person_id: null, booked_at: "2026-10-01T15:00:00Z" }),
  ];
  const none = { departments: [], sellerId: null, search: null, scopePersonIds: null };

  it("no filter → everything", () => {
    expect(filterBookings(rows, none)).toHaveLength(3);
  });
  it("department and seller narrow like the list's dept / seller", () => {
    expect(filterBookings(rows, { ...none, departments: ["teleshop_out", "social"] }).map((r) => r.doc_number)).toEqual(["002-9102-2/2026", "002-9108-3/2026"]);
    expect(filterBookings(rows, { ...none, sellerId: P1 }).map((r) => r.doc_number)).toEqual(["002-9100-1/2026"]);
  });
  it("a caller below manager sees only their own (an author-less booking is nobody's)", () => {
    expect(filterBookings(rows, { ...none, scopePersonIds: [P2] }).map((r) => r.doc_number)).toEqual(["002-9102-2/2026"]);
    expect(filterBookings(rows, { ...none, scopePersonIds: [] })).toEqual([]);
  });
  it("search: a phone by its last 8 digits, a document number exactly, else name / number text", () => {
    expect(filterBookings(rows, { ...none, search: parseSearch("+389 70 123 456") }).map((r) => r.doc_number)).toEqual(["002-9102-2/2026"]);
    expect(filterBookings(rows, { ...none, search: parseSearch("002-9108-3/2026") }).map((r) => r.doc_number)).toEqual(["002-9108-3/2026"]);
    expect(filterBookings(rows, { ...none, search: parseSearch("марија") }).map((r) => r.doc_number)).toEqual(["002-9102-2/2026"]);
    expect(filterBookings(rows, { ...none, search: parseSearch("9100") }).map((r) => r.doc_number)).toEqual(["002-9100-1/2026"]);
    expect(matchesSearch(row({ phone8: null }), parseSearch("070123456"))).toBe(false);
  });
  it("newest booking first", () => {
    expect(sortBookings(rows).map((r) => r.doc_number)).toEqual(["002-9102-2/2026", "002-9100-1/2026", "002-9108-3/2026"]);
  });
  it("counts per department in the owner's order, zero departments left out", () => {
    expect(Object.entries(countByDepartment([...rows, rows[0]]))).toEqual([["teleshop_out", 1], ["teleshop_other", 2], ["social", 1]]);
  });
});

describe("PII — the masks GET /orders applies", () => {
  it("masks the surname and all but the last 3 phone digits when the role may not see them", () => {
    expect(maskName("Марија Петровска Николова")).toBe("Марија П. Н.");
    expect(maskName("Марија")).toBe("Марија");
    expect(maskPhone("70123456")).toBe("•••••456");
    const [r] = redactBookings([row({ customer_name: "Марија Петровска", phone8: "70123456" })], { name: false, phone: false });
    expect(r).toMatchObject({ customer_name: "Марија П.", phone8: "•••••456" });
  });
  it("leaves them when allowed", () => {
    const [r] = redactBookings([row({})], { name: true, phone: true });
    expect(r).toMatchObject({ customer_name: "Владо Стојков", phone8: "78724890" });
    expect(redactBookings([row({ phone8: null })], { name: true, phone: false })[0].phone8).toBeNull();
  });
});

describe("the response", () => {
  it("rows newest first, total, per-department counts, the clamp and the window", () => {
    const w = bookingsWindow({ dayFrom: null, dayTo: TODAY }, TODAY);
    const res = bookingsResponse([row({ booked_at: "2026-10-01T10:00:00Z", doc_number: "a" }), row({ doc_number: "b" })], w);
    expect(res.rows.map((r) => r.doc_number)).toEqual(["b", "a"]);
    expect(res).toMatchObject({ total: 2, by_department: { teleshop_other: 2 }, clamped: true, window: { from: "2026-09-04", to: TODAY }, lookback_days: 29 });
    expect(bookingsResponse([], { empty: true, clamped: true })).toEqual({ rows: [], total: 0, by_department: {}, clamped: true, window: null, lookback_days: 29 });
  });
  it("chunks keep the RPC under its 200-id limit", () => {
    const ids = Array.from({ length: 450 }, (_, i) => `id${i}`);
    expect(chunks(ids, COLLAB_STATES_MAX_IDS).map((c) => c.length)).toEqual([200, 200, 50]);
    expect(chunks([], 200)).toEqual([]);
  });
});

describe("the 2-day collabBox entry rule badge (crm_sale_collab_states)", () => {
  const o = (x: Record<string, unknown>) => ({ id: "o", status: "confirmed", sale_source: "elyon_crm", sale_source_detail: "prediction_list", mex_tracking_id: null, ...x });
  it("asks only about confirmed CRM sales (prediction_list | direct) without a parcel", () => {
    const ids = collabCandidateIds([
      o({ id: "a" }), o({ id: "b", sale_source_detail: "direct" }),
      o({ id: "c", sale_source_detail: "disposition" }), o({ id: "d", status: "shipped" }),
      o({ id: "e", sale_source: "collabbox" }), o({ id: "f", mex_tracking_id: "002-9103-1/2026" }),
      o({ id: "g", sale_source: "altercpa", sale_source_detail: null }),
    ]);
    expect(ids).toEqual(["a", "b"]);
  });
  it("maps each state onto its order; an unknown mode reads as report", () => {
    expect(collabById([
      { order_id: "a", collab_doc: "002-9103-178176/2026", sale_day: "2026-10-02", cancel_day: "2026-10-04", mode: "report", team_dept: "teleshop_out" },
      { order_id: "b", collab_doc: null, sale_day: "2026-10-01", cancel_day: "2026-10-03", mode: "apply" },
      { order_id: "c", collab_doc: "", sale_day: null, cancel_day: null, mode: "weird" },
    ])).toEqual({
      a: { doc: "002-9103-178176/2026", sale_day: "2026-10-02", cancel_day: "2026-10-04", mode: "report", team_decides: true },
      b: { doc: null, sale_day: "2026-10-01", cancel_day: "2026-10-03", mode: "apply", team_decides: false },
      c: { doc: null, sale_day: null, cancel_day: null, mode: "report", team_decides: false },
    });
    expect(collabById(null)).toEqual({});
  });
});
