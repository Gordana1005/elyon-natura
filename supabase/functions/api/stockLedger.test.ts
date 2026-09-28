import { describe, expect, it } from "vitest";
import {
  MAX_COUNTED, countErrorStatus, parseCountBody, parseMexSwitchBody, stockCountAccess, stockHealthAccess,
  stockMovesOnStatus,
} from "./stockLedger.ts";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "BBBBBBBB-0000-4000-8000-000000000002";

describe("access", () => {
  it("health: owners, admins/managers, warehouse", () => {
    expect(stockHealthAccess(true, false, false)).toBe(true);
    expect(stockHealthAccess(false, true, false)).toBe(true);
    expect(stockHealthAccess(false, false, true)).toBe(true);
    expect(stockHealthAccess(false, false, false)).toBe(false);
  });
  it("count: owners, admins, warehouse — not a manager on their own", () => {
    expect(stockCountAccess(true, false, false)).toBe(true);
    expect(stockCountAccess(false, true, false)).toBe(true);
    expect(stockCountAccess(false, false, true)).toBe(true);
    expect(stockCountAccess(false, false, false)).toBe(false);
  });
});

describe("parseCountBody", () => {
  it("accepts lines, lower-cases ids, trims the note, dry defaults to false", () => {
    const p = parseCountBody({ lines: [{ product_id: A, counted: 0 }, { product_id: B, counted: 12 }], note: "  shelf A  " });
    expect(p).toEqual({ ok: true, value: { lines: [{ product_id: A, counted: 0 }, { product_id: B.toLowerCase(), counted: 12 }], note: "shelf A", dry: false } });
  });
  it("dry preview", () => {
    const p = parseCountBody({ lines: [{ product_id: A, counted: 1 }], dry: true });
    expect(p.ok && p.value.dry).toBe(true);
  });
  it("refuses what the count must never store", () => {
    expect(parseCountBody(null)).toEqual({ ok: false, error: "body_required" });
    expect(parseCountBody({ lines: [] })).toEqual({ ok: false, error: "lines_required" });
    expect(parseCountBody({ lines: [7] })).toEqual({ ok: false, error: "bad_line" });
    expect(parseCountBody({ lines: [{ product_id: "x", counted: 1 }] })).toEqual({ ok: false, error: "bad_product_id" });
    expect(parseCountBody({ lines: [{ product_id: A, counted: 1.5 }] })).toEqual({ ok: false, error: "bad_quantity" });
    expect(parseCountBody({ lines: [{ product_id: A, counted: -1 }] })).toEqual({ ok: false, error: "bad_quantity" });
    expect(parseCountBody({ lines: [{ product_id: A, counted: "3" }] })).toEqual({ ok: false, error: "bad_quantity" });
    expect(parseCountBody({ lines: [{ product_id: A, counted: MAX_COUNTED + 1 }] })).toEqual({ ok: false, error: "bad_quantity" });
    expect(parseCountBody({ lines: [{ product_id: A, counted: 1 }, { product_id: A.toUpperCase(), counted: 2 }] }))
      .toEqual({ ok: false, error: "duplicate_product" });
    expect(parseCountBody({ lines: [{ product_id: A, counted: 1 }], note: 5 })).toEqual({ ok: false, error: "bad_note" });
    expect(parseCountBody({ lines: [{ product_id: A, counted: 1 }], dry: "yes" })).toEqual({ ok: false, error: "bad_dry" });
  });
  it("caps the note", () => {
    const p = parseCountBody({ lines: [{ product_id: A, counted: 1 }], note: "x".repeat(900) });
    expect(p.ok && p.value.note?.length).toBe(500);
  });
});

describe("parseMexSwitchBody", () => {
  it("on / off, free units optional", () => {
    expect(parseMexSwitchBody({ enabled: true })).toEqual({ ok: true, value: { enabled: true, free_units: null } });
    expect(parseMexSwitchBody({ enabled: false, free_units: "skip" })).toEqual({ ok: true, value: { enabled: false, free_units: "skip" } });
  });
  it("refuses anything else", () => {
    expect(parseMexSwitchBody({})).toEqual({ ok: false, error: "enabled_required" });
    expect(parseMexSwitchBody({ enabled: "true" })).toEqual({ ok: false, error: "enabled_required" });
    expect(parseMexSwitchBody({ enabled: true, free_units: "maybe" })).toEqual({ ok: false, error: "bad_free_units" });
  });
});

describe("stockMovesOnStatus — the old status-driven moves stop at the first count", () => {
  it("keeps them before any count", () => {
    expect(stockMovesOnStatus(null)).toBe(true);
    expect(stockMovesOnStatus({ enabled: false, from: null })).toBe(true);
    expect(stockMovesOnStatus({ enabled: false })).toBe(true);
    expect(stockMovesOnStatus({ from: "garbage" })).toBe(true);
    expect(stockMovesOnStatus([])).toBe(true);
  });
  it("stops them once a count anchored the MEX ledger — switched on or not", () => {
    expect(stockMovesOnStatus({ enabled: false, from: "2026-10-01T08:00:00.123+00:00" })).toBe(false);
    expect(stockMovesOnStatus({ enabled: true, from: "2026-10-01T08:00:00+00:00" })).toBe(false);
  });
});

describe("countErrorStatus", () => {
  it("maps the RPC refusals", () => {
    expect(countErrorStatus("no_count")).toBe(409);
    expect(countErrorStatus("not_installed")).toBe(503);
    expect(countErrorStatus("unknown_product")).toBe(404);
    expect(countErrorStatus("bad_quantity")).toBe(400);
  });
});
