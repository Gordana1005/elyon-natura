import { describe, expect, it } from "vitest";
import {
  DAY, codOk, dedupeShipments, hasSaleValue, isNegativeCod, isRealSale, isRegisterOnlyRun,
  isSyntheticProductName, mexDate, mkE164, parseCod, pickCandidate,
  rememberedLinkMethod, resolveHolder, shipGate, skopjeYmd, targetFor, atMexGate, AT_MEX_STATUS,
} from "./match.ts";
import type { OrderRow } from "./match.ts";
import { isSyntheticProductName as uiIsSynthetic } from "../../../src/lib/utils";
// The upsell revive (owner rule 2026-09-28) — tested at the bottom of the file.
import { isAlterCpaOrder, isLeadsParcel, isNoParcelCancel, mexSeries } from "./match.ts";
import type { ParcelRef } from "./match.ts";

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

  it("a COD fit may be a cancelled real sale on its own folder's parcel (rule C decides later)", () => {
    const cancelled = order({ status: "cancelled" });
    expect(pickCandidate([cancelled], 1500, SHIP_CREATED, { account: "bio_natural", tracking_id: "002-9110-176001/2026" }))
      .toEqual({ order: cancelled, method: "phone_cod" });
    // NATURA carried the LEADS series before BIO NATURAL existed (02.04.2026)
    expect(pickCandidate([cancelled], 1500, SHIP_CREATED, { account: "natura", tracking_id: "002-9110-150001/2026" }))
      .toEqual({ order: cancelled, method: "phone_cod" });
  });

  it("never revives a dead AlterCPA lead on another folder's parcel (teleshop / social / web)", () => {
    for (const tracking_id of ["002-9102-177292/2026", "002-9100-160001/2026", "002-9108-3481/2026", "002-1300-101/2026", "NTMK62207", "002-9103-176483/2026"]) {
      const cancelled = order({ status: "cancelled" });
      const trashed = order({ status: "trashed" });
      expect(pickCandidate([cancelled], 1500, SHIP_CREATED, { account: "natura", tracking_id })).toEqual({ skip: "single_not_open" });
      expect(pickCandidate([trashed], 1500, SHIP_CREATED, { account: "natura", tracking_id })).toEqual({ skip: "single_not_open" });
    }
    // no parcel reference at all → no revive either
    expect(pickCandidate([order({ status: "cancelled" })], 1500, SHIP_CREATED)).toEqual({ skip: "single_not_open" });
  });

  it("a dead CRM sale fits only a LEADS-OUT (9103) parcel", () => {
    const crm = (o: Partial<OrderRow> = {}) => order({ status: "cancelled", source_type: "manual", external_source: null, ...o });
    const c1 = crm();
    expect(pickCandidate([c1], 1500, SHIP_CREATED, { account: "bio_natural", tracking_id: "002-9103-176483/2026" }))
      .toEqual({ order: c1, method: "phone_cod" });
    expect(pickCandidate([crm()], 1500, SHIP_CREATED, { account: "natura", tracking_id: "002-9102-177292/2026" }))
      .toEqual({ skip: "single_not_open" });
  });

  it("the folder guard never touches open orders: a fitting open lead still takes a teleshop parcel", () => {
    const open = order({ status: "confirmed" });
    expect(pickCandidate([open], 1500, SHIP_CREATED, { account: "natura", tracking_id: "002-9102-177292/2026" }))
      .toEqual({ order: open, method: "phone_cod" });
    // a dead lead beside it does not compete for the teleshop parcel
    const dead = order({ status: "cancelled", created_at: daysBefore(0) });
    expect(pickCandidate([dead, open], 1500, SHIP_CREATED, { account: "natura", tracking_id: "002-9102-177292/2026" }))
      .toEqual({ order: open, method: "phone_cod" });
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
  it("targetFor maps MEX statuses, string or number (owner 30.09: 8 = за пакување)", () => {
    expect(targetFor(2)).toBe("paid");
    expect(targetFor("7")).toBe("returned");
    expect(targetFor(8)).toBe("at_mex");
    expect(targetFor("8")).toBe("at_mex");
    for (const id of [4, 10, 9, 1, 3, "4", 13]) expect(targetFor(id)).toBe("shipped");
    expect(AT_MEX_STATUS).toBe(8);
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
  // Reference values from PostgreSQL (mex_parse_ts's own expression, '…'::timestamp
  // AT TIME ZONE 'Europe/Skopje', checked on the live MK database 01.10.2026).
  it("mexDate uses the offset Skopje had AT that moment — CET in winter, exactly like mex_parse_ts", () => {
    expect(mexDate("2026-11-10 00:30:00")?.toISOString()).toBe("2026-11-09T23:30:00.000Z");   // was 22:30Z (+02:00)
    expect(mexDate("2026-10-25 00:30:00")?.toISOString()).toBe("2026-10-24T22:30:00.000Z");   // CEST, before the change
    expect(mexDate("2026-10-25 23:30:00")?.toISOString()).toBe("2026-10-25T22:30:00.000Z");   // CET, after it
    expect(mexDate("2026-10-25 02:30:00")?.toISOString()).toBe("2026-10-25T01:30:00.000Z");   // the repeated hour → the later
    expect(mexDate("2026-03-29 02:30:00")?.toISOString()).toBe("2026-03-29T01:30:00.000Z");   // the gap
    expect(mexDate("2026-09-20T12:00")?.toISOString()).toBe("2026-09-20T10:00:00.000Z");
    expect(mexDate("2026-09-20 12:00:00.5")?.toISOString()).toBe("2026-09-20T10:00:00.500Z");
    expect(mexDate("2026-02-31 10:00:00")).toBeNull();
    expect(mexDate("2026-09-20")).toBeNull();
  });
  it("a winter delivery at 00:30 Skopje is dated that day, not the day before", () => {
    const d = mexDate("2026-11-10 00:30:00")!;
    expect(skopjeYmd(d)).toBe("2026-11-10");
  });
  it("skopjeYmd is the Skopje calendar day (00:30 / 23:30 Skopje)", () => {
    expect(skopjeYmd(new Date("2026-09-30T22:30:00Z"))).toBe("2026-10-01");   // 00:30 CEST
    expect(skopjeYmd(new Date("2026-10-01T21:30:00Z"))).toBe("2026-10-01");   // 23:30 CEST
    expect(skopjeYmd(Date.parse("2026-10-25T22:30:00Z"))).toBe("2026-10-25"); // 23:30 CET on the 25-hour day
  });
});

// ── The upsell revive (owner rule 2026-09-28) ───────────────────────────────
// The 7-day no-parcel rule cancelled an AlterCPA sale; its parcel turns up later
// with a COD that is not the CRM price (an upsell at AlterCPA). npCancel is the
// shape apply_no_parcel_rule leaves behind, sold 12 days before the parcel.
const npCancel = (o: Partial<OrderRow> = {}) => order({
  status: "cancelled", cancellation_reason: "no_parcel_7d", created_at: daysBefore(12), ...o,
});
const LEADS: ParcelRef = { account: "bio_natural", tracking_id: "002-9110-158456/2026" };
const UPSELL_COD = 3000;   // two packages at the door; the CRM still says one × 1.500 ден

describe("mexSeries / isLeadsParcel", () => {
  it("reads the series exactly as the mex_parcels.series column does", () => {
    expect(mexSeries("002-9110-158456/2026")).toBe("9110");
    expect(mexSeries("002-9103-1/2026")).toBe("9103");
    for (const id of ["ORD-89109", "NTMK40556", "M3258911", "3324341", "", null, undefined,
      "02-9110-1/2026", "002-91100-1/2026", "x002-9110-1/2026", "002-9110"]) {
      expect(mexSeries(id)).toBeNull();
    }
  });
  it("is BIO NATURAL series 9110 only — the account as fetched, never derived", () => {
    expect(isLeadsParcel(LEADS)).toBe(true);
    expect(isLeadsParcel({ ...LEADS, account: "natura" })).toBe(false);
    expect(isLeadsParcel({ ...LEADS, tracking_id: "002-9103-158456/2026" })).toBe(false);
    expect(isLeadsParcel({ tracking_id: LEADS.tracking_id })).toBe(false);
    expect(isLeadsParcel(null)).toBe(false);
    expect(isLeadsParcel(undefined)).toBe(false);
  });
});

describe("isAlterCpaOrder / isNoParcelCancel", () => {
  it("is AlterCPA by source_type or external_source (classify_sale_source's rule)", () => {
    expect(isAlterCpaOrder({ source_type: "altercpa", external_source: "altercpa" })).toBe(true);
    expect(isAlterCpaOrder({ source_type: "altercpa", external_source: null })).toBe(true);
    expect(isAlterCpaOrder({ source_type: "import", external_source: "altercpa" })).toBe(true);
    expect(isAlterCpaOrder({ source_type: "manual", external_source: null })).toBe(false);
    expect(isAlterCpaOrder({ source_type: "import", external_source: "collabbox" })).toBe(false);
    expect(isAlterCpaOrder({ source_type: "affiliate", external_source: null })).toBe(false);
  });
  it("is only our own no_parcel_7d cancel of an AlterCPA sale", () => {
    expect(isNoParcelCancel(npCancel())).toBe(true);
    expect(isNoParcelCancel(npCancel({ cancellation_reason: "changed_mind" }))).toBe(false);
    expect(isNoParcelCancel(npCancel({ status: "trashed" }))).toBe(false);
    expect(isNoParcelCancel(npCancel({ source_type: "manual", external_source: null }))).toBe(false);
  });
});

describe("pickCandidate — the upsell revive (owner rule 2026-09-28)", () => {
  it("links the lone no_parcel_7d AlterCPA cancel when every condition holds", () => {
    const o = npCancel();
    expect(pickCandidate([o], UPSELL_COD, SHIP_CREATED, LEADS)).toEqual({ order: o, method: "upsell_revive" });
    // any COD that does not fit — below the price too
    expect(pickCandidate([o], 999, SHIP_CREATED, LEADS)).toEqual({ order: o, method: "upsell_revive" });
  });

  it("also for the 2026-08 history import (external_source altercpa)", () => {
    const o = npCancel({ source_type: "import", external_source: "altercpa" });
    expect(pickCandidate([o], UPSELL_COD, SHIP_CREATED, LEADS)).toEqual({ order: o, method: "upsell_revive" });
  });

  it("counts real sales exactly as phone_single does — unlinked and inside the window", () => {
    const o = npCancel();
    const notRivals = [
      ghost({ created_at: daysBefore(1) }),                                     // 0 ден disposition
      order({ status: "paid", price: 30, mex_tracking_id: "002-9110-1/2026" }), // holds its own parcel
      order({ status: "paid", price: 30, created_at: daysBefore(90) }),         // outside the window
    ];
    expect(pickCandidate([...notRivals, o], UPSELL_COD, SHIP_CREATED, LEADS)).toEqual({ order: o, method: "upsell_revive" });
  });

  it("uses the matcher's window, both edges included", () => {
    const early = npCancel({ created_at: daysBefore(75) });
    expect(pickCandidate([early], UPSELL_COD, SHIP_CREATED, LEADS)).toEqual({ order: early, method: "upsell_revive" });
    const late = npCancel({ created_at: daysBefore(-3) });
    expect(pickCandidate([late], UPSELL_COD, SHIP_CREATED, LEADS)).toEqual({ order: late, method: "upsell_revive" });
  });

  it("hands the revived order to rule C", () => {
    const pick = pickCandidate([npCancel()], UPSELL_COD, SHIP_CREATED, LEADS);
    expect("order" in pick && shipGate(pick.order, pick.method)).toBe("rule_c");
  });

  // ── each condition failing on its own ──
  it("not for another account (a NATURA 9110 parcel)", () => {
    expect(pickCandidate([npCancel()], UPSELL_COD, SHIP_CREATED, { ...LEADS, account: "natura" }))
      .toEqual({ skip: "single_not_open" });
    expect(pickCandidate([npCancel()], UPSELL_COD, SHIP_CREATED, { tracking_id: LEADS.tracking_id }))
      .toEqual({ skip: "single_not_open" });
  });

  it("not for another series, or a tracking id with no series", () => {
    for (const tracking_id of ["002-9103-158456/2026", "002-9100-1/2026", "002-9102-1/2026", "002-9108-1/2026",
      "ORD-89109", "NTMK40556", "M3258911", "3324341"]) {
      expect(pickCandidate([npCancel()], UPSELL_COD, SHIP_CREATED, { account: "bio_natural", tracking_id }))
        .toEqual({ skip: "single_not_open" });
    }
  });

  it("not outside the ship window", () => {
    expect(pickCandidate([npCancel({ created_at: daysBefore(76) })], UPSELL_COD, SHIP_CREATED, LEADS))
      .toEqual({ skip: "unmatched" });
    expect(pickCandidate([npCancel({ created_at: daysBefore(-4) })], UPSELL_COD, SHIP_CREATED, LEADS))
      .toEqual({ skip: "unmatched" });
    expect(pickCandidate([npCancel()], UPSELL_COD, null, LEADS)).toEqual({ skip: "unmatched" });
  });

  it("not with no real sale on the phone", () => {
    expect(pickCandidate([], UPSELL_COD, SHIP_CREATED, LEADS)).toEqual({ skip: "unmatched" });
    expect(pickCandidate([ghost()], UPSELL_COD, SHIP_CREATED, LEADS)).toEqual({ skip: "no_real_sale" });
    // a 0 ден no_parcel_7d row is no real sale either
    expect(pickCandidate([npCancel({ price: 0 })], UPSELL_COD, SHIP_CREATED, LEADS)).toEqual({ skip: "no_real_sale" });
    // and one that already holds a parcel is no candidate at all
    expect(pickCandidate([npCancel({ mex_tracking_id: "002-9110-1/2026" })], UPSELL_COD, SHIP_CREATED, LEADS))
      .toEqual({ skip: "unmatched" });
  });

  it("not with two or more real sales on the phone", () => {
    expect(pickCandidate([npCancel(), order({ status: "confirmed", price: 30 })], UPSELL_COD, SHIP_CREATED, LEADS))
      .toEqual({ skip: "ambiguous" });
    expect(pickCandidate([npCancel(), order({ status: "paid", price: 30 })], UPSELL_COD, SHIP_CREATED, LEADS))
      .toEqual({ skip: "ambiguous" });
    expect(pickCandidate([npCancel(), npCancel({ created_at: daysBefore(20) })], UPSELL_COD, SHIP_CREATED, LEADS))
      .toEqual({ skip: "ambiguous" });
  });

  it("not for a cancel with another reason — or none", () => {
    for (const cancellation_reason of ["changed_mind", "no_money", "other", "duplicate_order", "stale_pending_cleanup", null]) {
      expect(pickCandidate([npCancel({ cancellation_reason })], UPSELL_COD, SHIP_CREATED, LEADS))
        .toEqual({ skip: "single_not_open" });
    }
  });

  it("not for a no_parcel_7d order that is no longer cancelled", () => {
    for (const status of ["trashed", "paid", "returned"]) {
      expect(pickCandidate([npCancel({ status })], UPSELL_COD, SHIP_CREATED, LEADS)).toEqual({ skip: "single_not_open" });
    }
  });

  it("not for an order that did not come through AlterCPA", () => {
    for (const src of [
      { source_type: "manual", external_source: null },
      { source_type: "import", external_source: "collabbox" },
      { source_type: "affiliate", external_source: null },
      { source_type: "opencart", external_source: null },
    ]) {
      expect(pickCandidate([npCancel(src)], UPSELL_COD, SHIP_CREATED, LEADS)).toEqual({ skip: "single_not_open" });
    }
  });

  it("not on a COD of 0 — no money signal", () => {
    expect(pickCandidate([npCancel()], 0, SHIP_CREATED, LEADS)).toEqual({ skip: "single_not_open" });
  });

  it("a COD that fits takes the normal phone_cod path, not the revive", () => {
    const o = npCancel();
    expect(pickCandidate([o], 1500, SHIP_CREATED, LEADS)).toEqual({ order: o, method: "phone_cod" });
    expect(pickCandidate([o], 1650, SHIP_CREATED, LEADS)).toEqual({ order: o, method: "phone_cod" });
  });

  it("never without the parcel — the three-argument call is unchanged", () => {
    expect(pickCandidate([npCancel()], UPSELL_COD, SHIP_CREATED)).toEqual({ skip: "single_not_open" });
    expect(pickCandidate([npCancel()], UPSELL_COD, SHIP_CREATED, null)).toEqual({ skip: "single_not_open" });
  });

  it("leaves the open-order fallback as it was on a 9110 parcel", () => {
    const open = order({ status: "confirmed", price: 30 });
    expect(pickCandidate([open], UPSELL_COD, SHIP_CREATED, LEADS)).toEqual({ order: open, method: "phone_single" });
  });
});

describe("atMexGate — MEX 8 is за пакување, never shipped (owner 30.09.2026)", () => {
  it("a confirmed or already-shipped order keeps its status (only mex_sent_at is stamped)", () => {
    expect(atMexGate(order({ status: "confirmed" }), "tracking")).toBe("stamp");
    expect(atMexGate(order({ status: "shipped" }), "phone_cod")).toBe("stamp");
  });
  it("an open order waits for the pickup (no sold stamp 'now' for the old agent)", () => {
    for (const status of ["pending", "take", "call_again"]) expect(atMexGate(order({ status }), "phone_single")).toBe("wait_pickup");
  });
  it("a cancel rule C would revive also waits for the pickup; anything else is a no-op", () => {
    expect(atMexGate(order({ status: "cancelled" }), "tracking")).toBe("wait_pickup");
    expect(atMexGate(order({ status: "trashed" }), "phone_cod")).toBe("wait_pickup");
    expect(atMexGate(npCancel(), "upsell_revive")).toBe("wait_pickup");
    expect(atMexGate(order({ status: "cancelled" }), "phone_single")).toBeNull();
    expect(atMexGate(ghost(), "tracking")).toBeNull();
  });
  it("never touches a settled order", () => {
    for (const status of ["paid", "returned", "delivered", "duplicated"]) expect(atMexGate(order({ status }), "tracking")).toBeNull();
  });
  it("the full mapping: 8 → at_mex · 4/10/9/1/3 → shipped · 2 → paid · 7 → returned", () => {
    const map = Object.fromEntries([8, 4, 10, 9, 1, 3, 2, 7].map((id) => [id, targetFor(id)]));
    expect(map).toEqual({ 8: "at_mex", 4: "shipped", 10: "shipped", 9: "shipped", 1: "shipped", 3: "shipped", 2: "paid", 7: "returned" });
  });
});

describe("shipGate — the upsell revive", () => {
  it("allows rule C on the no_parcel_7d AlterCPA cancel an upsell_revive link names", () => {
    expect(shipGate(npCancel(), "upsell_revive")).toBe("rule_c");
    expect(shipGate(npCancel({ source_type: "import", external_source: "altercpa" }), "upsell_revive")).toBe("rule_c");
  });
  it("denies it for anything else", () => {
    expect(shipGate(npCancel({ cancellation_reason: "changed_mind" }), "upsell_revive")).toBeNull();
    expect(shipGate(npCancel({ source_type: "manual", external_source: null }), "upsell_revive")).toBeNull();
    for (const status of ["trashed", "paid", "returned", "delivered", "shipped"]) {
      expect(shipGate(npCancel({ status }), "upsell_revive")).toBeNull();
    }
  });
});
