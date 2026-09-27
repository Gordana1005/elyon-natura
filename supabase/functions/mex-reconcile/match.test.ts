import { describe, expect, it } from "vitest";
import {
  DAY, codOk, dedupeShipments, hasSaleValue, isNegativeCod, isRealSale, isRegisterOnlyRun,
  isSyntheticProductName, mexDate, mkE164, parseCod, pickCandidate,
  rememberedLinkMethod, resolveHolder, shipGate, targetFor,
} from "./match.ts";
import type { OrderRow } from "./match.ts";
import { isSyntheticProductName as uiIsSynthetic } from "../../../src/lib/utils";

// A parcel created 2026-09-20 12:00 Skopje; orders are dated relative to it.
const SHIP_CREATED = mexDate("2026-09-20 12:00:00")!;
const daysBefore = (n: number) => new Date(SHIP_CREATED.getTime() - n * DAY).toISOString();

let seq = 0;
const order = (o: Partial<OrderRow> = {}): OrderRow => ({
  id: `o${++seq}`,
  status: "confirmed",
  price: 24.39,                       // × 61,5 = 1.500 ден
  created_at: daysBefore(2),
  mex_tracking_id: null,
  product_name: "ПРОСТАТОЛ КОМПЛЕКС cps 30",
  source_type: "altercpa",
  external_source: "altercpa",
  cancellation_reason: null,
  ...o,
});

// The exact shape /calls writes when an agent logs a "no" on a prediction list.
const ghost = (o: Partial<OrderRow> = {}) => order({
  status: "cancelled", price: 0, product_name: "No prior product on file",
  source_type: "manual", external_source: null, cancellation_reason: "changed_mind", ...o,
});

describe("mkE164", () => {
  it("normalises local, trunk-0 and +389 forms to the same E.164", () => {
    expect(mkE164("070 123 456")).toBe("+38970123456");
    expect(mkE164("70123456")).toBe("+38970123456");
    expect(mkE164("+389 70 123 456")).toBe("+38970123456");
    expect(mkE164("38970123456")).toBe("+38970123456");
    expect(mkE164("070/123-456")).toBe("+38970123456");
  });
  it("keeps 8-digit landlines", () => {
    expect(mkE164("02 3123 456")).toBe("+38923123456");
  });
  it("rejects empty and implausible numbers", () => {
    expect(mkE164(null)).toBeNull();
    expect(mkE164(undefined)).toBeNull();
    expect(mkE164("")).toBeNull();
    expect(mkE164("12345")).toBeNull();
    expect(mkE164("0701234567890")).toBeNull();
  });
});

describe("codOk / parseCod", () => {
  it("parses MEX's string COD to whole denari", () => {
    expect(parseCod("1500.00")).toBe(1500);
    expect(parseCod("1,650.40")).toBe(1650);
    expect(parseCod(null)).toBe(0);
  });
  it("fits the total with or without the 150 ден delivery fee, ±3 ден", () => {
    expect(codOk(24.39, 1500)).toBe(true);
    expect(codOk(24.39, 1650)).toBe(true);
    expect(codOk(24.39, 1503)).toBe(true);
    expect(codOk(24.39, 1504)).toBe(false);
    expect(codOk(24.39, 1800)).toBe(false);
  });
  it("never fits an unpriced order", () => {
    expect(codOk(0, 0)).toBe(false);
    expect(codOk(null, 150)).toBe(false);
  });
  it("spots a negative COD (money out) the way mex_parse_cod does", () => {
    expect(isNegativeCod("-3000")).toBe(true);
    expect(isNegativeCod(" -1310.00")).toBe(true);
    expect(isNegativeCod("1500.00")).toBe(false);
    expect(isNegativeCod("1-500")).toBe(false);
    expect(isNegativeCod(null)).toBe(false);
    expect(parseCod("-3000")).toBe(3000);          // why the guard exists
  });
});

describe("isRealSale", () => {
  it("rejects every flavour of call disposition and admin copy", () => {
    expect(isRealSale(ghost())).toBe(false);
    // /calls copies a prior REAL product name onto the disposition, still at 0 ден
    expect(isRealSale(ghost({ product_name: "ПРОСТАТОЛ КОМПЛЕКС cps 30" }))).toBe(false);
    expect(isRealSale(order({ product_name: "Cancelled" }))).toBe(false);
    expect(isRealSale(order({ product_name: "" }))).toBe(false);
    expect(isRealSale(order({ status: "duplicated" }))).toBe(false);
    expect(isRealSale(order({ price: null }))).toBe(false);
  });
  it("accepts a priced order with a real product", () => {
    expect(isRealSale(order())).toBe(true);
    expect(isRealSale(order({ status: "cancelled" }))).toBe(true);
  });
  it("mirrors src/lib/utils.ts isSyntheticProductName exactly", () => {
    const names = [
      "No prior product on file", "  no prior product on file  ", "Cancelled", "Trashed",
      "CANCELLED - customer declined", "—", "", "   ", null, undefined,
      "ProstaFix", "ПРОСТАТОЛ КОМПЛЕКС cps 30", "Detox Cancelled Edition", "Файл Trashed",
    ];
    for (const n of names) expect(isSyntheticProductName(n)).toBe(uiIsSynthetic(n));
  });
});

describe("pickCandidate", () => {
  it("never chooses a 0 ден 'No prior product on file' cancel — even as the only candidate", () => {
    const r = pickCandidate([ghost()], 1500, SHIP_CREATED);
    expect(r).toEqual({ skip: "no_real_sale" });
  });

  it("never chooses a 0 ден disposition that copied a real product name", () => {
    const r = pickCandidate([ghost({ product_name: "ПРОСТАТОЛ КОМПЛЕКС cps 30" })], 0, SHIP_CREATED);
    expect(r).toEqual({ skip: "no_real_sale" });
  });

  it("picks the real sale, not the ghost beside it", () => {
    const real = order({ status: "pending", price: 30 });   // COD will not fit
    const r = pickCandidate([ghost({ created_at: daysBefore(0) }), real], 1500, SHIP_CREATED);
    expect(r).toEqual({ order: real, method: "phone_single" });
  });

  it("falls back to a single real OPEN order by phone_single when the COD differs", () => {
    const only = order({ status: "confirmed", price: 30 });
    expect(pickCandidate([only], 999, SHIP_CREATED)).toEqual({ order: only, method: "phone_single" });
    const shipped = order({ status: "shipped", price: 30 });
    expect(pickCandidate([shipped], 999, SHIP_CREATED)).toEqual({ order: shipped, method: "phone_single" });
  });

  it("does not fall back onto a single real order that is cancelled or already settled", () => {
    expect(pickCandidate([order({ status: "cancelled", price: 30 })], 999, SHIP_CREATED))
      .toEqual({ skip: "single_not_open" });
    expect(pickCandidate([order({ status: "paid", price: 30 })], 999, SHIP_CREATED))
      .toEqual({ skip: "single_not_open" });
  });

  it("lets a COD fit win over a nearer order that does not fit", () => {
    const near = order({ price: 30, created_at: daysBefore(0) });
    const fit = order({ price: 24.39, created_at: daysBefore(10) });
    expect(pickCandidate([near, fit], 1650, SHIP_CREATED)).toEqual({ order: fit, method: "phone_cod" });
  });

  it("takes the nearest created date among several COD fits", () => {
    const far = order({ created_at: daysBefore(20) });
    const near = order({ created_at: daysBefore(1) });
    expect(pickCandidate([far, near], 1500, SHIP_CREATED)).toEqual({ order: near, method: "phone_cod" });
  });

  it("a COD fit may be a cancelled real sale (rule C decides later)", () => {
    const cancelled = order({ status: "cancelled" });
    expect(pickCandidate([cancelled], 1500, SHIP_CREATED)).toEqual({ order: cancelled, method: "phone_cod" });
  });

  it("excludes duplicated orders even when their COD fits", () => {
    const dup = order({ status: "duplicated", created_at: daysBefore(0) });
    expect(pickCandidate([dup], 1500, SHIP_CREATED)).toEqual({ skip: "no_real_sale" });
    const real = order({ created_at: daysBefore(5) });
    expect(pickCandidate([dup, real], 1500, SHIP_CREATED)).toEqual({ order: real, method: "phone_cod" });
  });

  it("calls several real sales with no COD fit ambiguous", () => {
    const r = pickCandidate([order({ price: 30 }), order({ price: 40 })], 999, SHIP_CREATED);
    expect(r).toEqual({ skip: "ambiguous" });
  });

  it("ignores orders that already hold a parcel or sit outside [−3d … +75d]", () => {
    expect(pickCandidate([order({ mex_tracking_id: "T1" })], 1500, SHIP_CREATED)).toEqual({ skip: "unmatched" });
    expect(pickCandidate([order({ created_at: daysBefore(76) })], 1500, SHIP_CREATED)).toEqual({ skip: "unmatched" });
    expect(pickCandidate([order({ created_at: daysBefore(-4) })], 1500, SHIP_CREATED)).toEqual({ skip: "unmatched" });
    expect("order" in pickCandidate([order({ created_at: daysBefore(-2) })], 1500, SHIP_CREATED)).toBe(true);
    expect(pickCandidate([order()], 1500, null)).toEqual({ skip: "unmatched" });
    expect(pickCandidate([], 1500, SHIP_CREATED)).toEqual({ skip: "unmatched" });
  });
});

describe("resolveHolder", () => {
  it("prefers the real sale when a ghost holds the same tracking id (the teleshop doubles)", () => {
    const teleshop = order({ external_source: "collabbox", source_type: "import", status: "paid" });
    expect(resolveHolder([ghost({ status: "paid" }), teleshop], null)).toEqual({ order: teleshop });
  });
  it("keeps a single holder as-is", () => {
    const g = ghost();
    expect(resolveHolder([g], undefined)).toEqual({ order: g });
  });
  it("refuses to guess between two real sales or two ghosts", () => {
    expect(resolveHolder([order(), order()], null)).toEqual({ skip: "tracking_conflict" });
    expect(resolveHolder([ghost(), ghost()], null)).toEqual({ skip: "tracking_conflict" });
  });
  it("follows the register's link, and stops when the register points elsewhere", () => {
    const a = order();
    const b = order();
    expect(resolveHolder([a, b], b.id)).toEqual({ order: b });
    expect(resolveHolder([a], "someone-else")).toEqual({ skip: "register_disagrees" });
  });
});

describe("shipGate — rule C (MEX outranks AlterCPA)", () => {
  it("moves any open order forward", () => {
    for (const status of ["pending", "take", "call_again", "confirmed"]) {
      expect(shipGate(order({ status }), "phone_single")).toBe("open");
    }
  });
  it("allows an AlterCPA cancel/trash on a strong link", () => {
    expect(shipGate(order({ status: "cancelled" }), "tracking")).toBe("rule_c");
    expect(shipGate(order({ status: "trashed" }), "phone_cod")).toBe("rule_c");
    expect(shipGate(order({ status: "cancelled", source_type: "import", external_source: "altercpa" }), "tracking")).toBe("rule_c");
    expect(shipGate(order({ status: "cancelled", source_type: "altercpa", external_source: null }), "phone_cod")).toBe("rule_c");
  });
  it("allows our own no_parcel_7d cancel whatever the source", () => {
    expect(shipGate(order({ status: "cancelled", source_type: "manual", external_source: null, cancellation_reason: "no_parcel_7d" }), "tracking"))
      .toBe("rule_c");
  });
  it("denies a phone_single guess", () => {
    expect(shipGate(order({ status: "cancelled" }), "phone_single")).toBeNull();
  });
  it("denies a manual/prediction cancel and a collabBox cancel", () => {
    expect(shipGate(ghost(), "tracking")).toBeNull();
    expect(shipGate(order({ status: "cancelled", source_type: "manual", external_source: null }), "phone_cod")).toBeNull();
    expect(shipGate(order({ status: "trashed", source_type: "import", external_source: "collabbox" }), "tracking")).toBeNull();
  });
  it("never moves a settled order backwards", () => {
    for (const status of ["paid", "returned", "delivered", "shipped"]) {
      expect(shipGate(order({ status }), "tracking")).toBeNull();
    }
  });
});

describe("small helpers", () => {
  it("targetFor maps MEX statuses, string or number", () => {
    expect(targetFor(2)).toBe("paid");
    expect(targetFor("7")).toBe("returned");
    for (const id of [8, 4, 10, 9, 1, 3]) expect(targetFor(id)).toBe("shipped");
  });
  it("hasSaleValue is false for every 0 ден row", () => {
    expect(hasSaleValue(ghost())).toBe(false);
    expect(hasSaleValue(ghost({ product_name: "ProstaFix" }))).toBe(false);
    expect(hasSaleValue(order())).toBe(true);
  });
  it("rememberedLinkMethod labels collabBox imports", () => {
    expect(rememberedLinkMethod({ external_source: "collabbox" })).toBe("collabbox_import");
    expect(rememberedLinkMethod({ external_source: "altercpa" })).toBe("tracking");
    expect(rememberedLinkMethod({ external_source: null })).toBe("tracking");
  });
  it("dedupeShipments keeps the last row per tracking id and drops id-less rows", () => {
    const rows = [
      { tracking_id: "A", n: 1 }, { tracking_id: "B", n: 2 }, { tracking_id: "A", n: 3 }, { tracking_id: "", n: 4 },
    ];
    expect(dedupeShipments(rows)).toEqual([{ tracking_id: "B", n: 2 }, { tracking_id: "A", n: 3 }]);
  });
  it("isRegisterOnlyRun spots register runs by kind or marker", () => {
    expect(isRegisterOnlyRun({ kind: "register", skipped: {} })).toBe(true);
    expect(isRegisterOnlyRun({ kind: "backfill", skipped: { register_only: 1 } })).toBe(true);
    expect(isRegisterOnlyRun({ kind: "rolling", skipped: { fetched_natura: 12 } })).toBe(false);
    expect(isRegisterOnlyRun({ kind: "rolling", skipped: null })).toBe(false);
  });
  it("mexDate reads Skopje local time and rejects garbage", () => {
    expect(mexDate("2026-09-20 12:00:00")?.toISOString()).toBe("2026-09-20T10:00:00.000Z");
    expect(mexDate("")).toBeNull();
    expect(mexDate("not a date")).toBeNull();
  });
});
