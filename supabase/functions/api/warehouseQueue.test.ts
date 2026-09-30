import { describe, expect, it } from "vitest";
import { buildQueueResponse, enrichSendRow, parseQueueParams, stripMoney } from "./warehouseQueue.ts";
import { readMexPushSettings, type PushOrder } from "./mexPush.ts";

const q = (o: Record<string, string>) => ({ get: (k: string) => (k in o ? o[k] : null) });
const NOW = new Date("2026-10-01T09:00:00Z");

const row: PushOrder = {
  id: "11111111-1111-4111-8111-111111111111", display_id: "ORD-1", status: "confirmed",
  customer_name: "Ана Петровска", customer_phone: "+38976123456", street: "Партизанска", street_number: "12",
  postal_code: "1000", mex_city_id: 262, mex_city_name: "Skopje - Aerodrom", price_eur: 30.08,
  items: [{ product_name: "Alpha Male", quantity: 1, brand_line: null }], department: "altercpa", sale_source: "altercpa",
  sale_at: "2026-09-25T08:00:00Z", no_parcel_rule: { days: 10, cancel_after: "2026-10-05T08:00:00Z" },
  unlinked_parcels: [{ tracking_id: "002-9110-7/2026", cod_mkd: 1850, created_at: "2026-09-26T08:00:00Z" }],
};

describe("GET /warehouse/queue params", () => {
  it("defaults", () => {
    expect(parseQueueParams(q({}))).toEqual({ ok: true, params: { tab: "send", departments: null, order: "oldest", limit: 50, offset: 0 } });
  });
  it("departments, order, paging", () => {
    expect(parseQueueParams(q({ tab: "pack", departments: "altercpa, social,altercpa", order: "newest", limit: "200", offset: "50" })))
      .toEqual({ ok: true, params: { tab: "pack", departments: ["altercpa", "social"], order: "newest", limit: 200, offset: 50 } });
    expect(parseQueueParams(q({ departments: "all" }))).toMatchObject({ ok: true, params: { departments: null } });
  });
  it("rejects what the RPC would not understand", () => {
    expect(parseQueueParams(q({ tab: "history" }))).toEqual({ ok: false, error: "invalid_tab" });
    expect(parseQueueParams(q({ departments: "teleshop" }))).toEqual({ ok: false, error: "invalid_department" });
    expect(parseQueueParams(q({ limit: "500" }))).toEqual({ ok: false, error: "invalid_limit" });
    expect(parseQueueParams(q({ order: "random" }))).toEqual({ ok: false, error: "invalid_order" });
  });
});

describe("the rows", () => {
  it("a send row carries validation, the account suggestion, warnings and the 10-day clock", () => {
    const r = enrichSendRow(row, readMexPushSettings(null), NOW) as Record<string, any>;
    expect(r.validation).toEqual({ ok: true, missing: [] });
    expect(r.account).toMatchObject({ suggested: "bio_natural", basis: "department", needs_pick: true, reasons: ["line_missing"], open: false });
    expect(r.warnings.map((w: { code: string }) => w.code)).toEqual(["unlinked_parcel"]);
    expect(r.blockers).toEqual(["needs_pick", "double_parcel_risk"]);
    expect(r.no_parcel_days_left).toBe(4);
    expect(r.zone).toEqual({ id: 262, name: "Skopje - Aerodrom" });
  });
  it("money is for owners only — every _eur / _mkd key, at any depth", () => {
    const rpc = { tab: "send", total: 1, counts: { send: 1 }, rows: [row] };
    const ctx = { settingsValue: null, keys: { bio_natural: true, natura: false }, canPush: true, canToggle: false, now: NOW };
    const owner = buildQueueResponse(rpc, { ...ctx, isOwner: true }) as Record<string, any>;
    expect(owner.rows[0].price_eur).toBe(30.08);
    expect(owner.rows[0].unlinked_parcels[0].cod_mkd).toBe(1850);
    expect(owner.money).toBe(true);
    const staff = buildQueueResponse(rpc, { ...ctx, isOwner: false }) as Record<string, any>;
    expect(staff.rows[0].price_eur).toBeUndefined();
    expect(staff.rows[0].unlinked_parcels[0].cod_mkd).toBeUndefined();
    expect(staff.rows[0].display_id).toBe("ORD-1");
    expect(staff.push).toMatchObject({ enabled: false, accounts: { bio_natural: false, natura: false }, auto_send_scheduled: false, keys: { bio_natural: true, natura: false } });
    expect(JSON.stringify(staff)).not.toMatch(/_eur"|_mkd"/);
  });
  it("pack rows pass through (COD stripped for non-owners)", () => {
    const rpc = { tab: "pack", rows: [{ tracking_id: "002-9102-1/2026", cod_mkd: 1600, department: "teleshop_out" }] };
    const r = buildQueueResponse(rpc, { isOwner: false, settingsValue: null, keys: { bio_natural: false, natura: false }, canPush: false, canToggle: false }) as Record<string, any>;
    expect(r.rows).toEqual([{ tracking_id: "002-9102-1/2026", department: "teleshop_out" }]);
  });
  it("stripMoney leaves everything else alone", () => {
    expect(stripMoney({ a: 1, b_eur: 2, c: [{ d_mkd: 3, e: "x" }], f: null })).toEqual({ a: 1, c: [{ e: "x" }], f: null });
  });
});
