import { describe, expect, it } from "vitest";
import {
  bucketKeys, buildClock, buildProfitResponse, buildStrip, commissionAgentNames, costRatioOf, distributionOf,
  gatedBonusEur, mexRate, MKD_PER_EUR, normAgent, plRow, productRows, profitPrevWindow, PROFIT_PREV_MAX_DAYS,
  PROFIT_PRODUCTS_MAX, PROFIT_SOURCES,
  coalesceRanges, loadProfitClocks, mergeProfitRpcs, PROFIT_CACHE_MIN_DAYS, profitPieces, refreshMonths, webmasterNames,
  DEFAULT_VAT_RATE, vatOf, vatPerLine, vatUnclassifiedOf, buildQuality,
} from "./insightsProfit.ts";
import type { AggRow, CommRow, ProductRpcRow, ProfitCacheRow, ProfitRpc, ProfitSettings } from "./insightsProfit.ts";
import type { InsightsWindow } from "./insightsCommon.ts";
import { insightsWindows } from "./insightsCommon.ts";

const agg = (g: string, dim: string, key: string, x: Partial<AggRow>): AggRow => ({
  g, dim, key, n: 0, rev: 0, card: 0, pw: 0, rc: 0, ru: 0, rn: 0, cm: 0, pc: 0, pu: 0, fr: 0, lb: 0, ...x,
});

// VAT per line (20260944000900): v05 / v18 = the value at 5 % / 18 %, vt = its VAT,
// vc = the VAT of the costed part (rc), vu = the value with no rate (taxed at 5 %)
const S5 = 0.05 / 1.05, S18 = 0.18 / 1.18;
const vat = (x: { v05?: number; v18?: number; rc?: number; vu?: number }) => ({
  v00: 0, v05: x.v05 ?? 0, v10: 0, v18: x.v18 ?? 0,
  vt: (x.v05 ?? 0) * S5 + (x.v18 ?? 0) * S18, vc: (x.rc ?? 0) * S5, vu: x.vu ?? 0,
});

const SETTINGS: ProfitSettings = {
  defaultVatRate: 0.05,
  deliverEur: 2.439,   // courier_rates 'mex' = 150 ден
  returnEur: 0,
  rateSource: "courier_rates",
  agentNames: new Set(["Ана Петрова", "Марко"]),
};

// A small cohort: AlterCPA fully costed, teleshop uncosted, one web sale.
// Adenofrin (5 %, costed) for AlterCPA and ElyonCRM; Zinc / points / MEX-only with no rate
// on file (5 %, unclassified); the web sold a cosmetic at 18 % (Collagen Face Serum).
const COHORT: ProfitRpc = {
  clock: "cohort",
  granularity: "day",
  vat_mode: "per_line",
  agg: [
    agg("collected", "s", "altercpa", { n: 10, rev: 30000, pw: 10, rc: 30000, cm: 6000, pc: 30, lb: 30, ...vat({ v05: 30000, rc: 30000 }) }),
    agg("collected", "s", "elyon_crm", { n: 4, rev: 10000, pw: 4, rc: 8000, ru: 2000, cm: 1600, pc: 8, pu: 2, fr: 1, lb: 10, ...vat({ v05: 10000, rc: 8000, vu: 2000 }) }),
    agg("collected", "s", "web", { n: 2, rev: 3000, card: 1000, pw: 2, ru: 3000, pu: 3, ...vat({ v18: 3000 }) }),
    agg("collected", "s", "teleshop_other", { n: 5, rev: 10000, pw: 5, ru: 9900, rn: 100, pu: 12, fr: 2, ...vat({ v05: 10000, vu: 10000 }) }),
    agg("returned", "s", "altercpa", { n: 3, rev: 9000, pw: 3, ...vat({ v05: 9000 }) }),
    agg("returned", "s", "teleshop_other", { n: 1, rev: 2000, pw: 1, ...vat({ v05: 2000, vu: 2000 }) }),
    agg("open", "s", "altercpa", { n: 2, rev: 6000, pw: 2, ...vat({}) }),
    agg("unproven", "s", "elyon_crm", { n: 1, rev: 2500, pw: 1, ...vat({}) }),
    // days (collected + returned)
    agg("collected", "d", "2026-09-22", { n: 12, rev: 33000, pw: 12, rc: 25000, ru: 7900, rn: 100, cm: 5000, pc: 25, pu: 8, lb: 25, ...vat({ v05: 33000, rc: 25000, vu: 8000 }) }),
    agg("collected", "d", "2026-09-24", { n: 9, rev: 20000, pw: 9, rc: 13000, ru: 7000, cm: 2600, pc: 13, pu: 9, fr: 3, lb: 15, ...vat({ v05: 17000, v18: 3000, rc: 13000, vu: 4000 }) }),
    agg("returned", "d", "2026-09-24", { n: 4, rev: 11000, pw: 4, ...vat({ v05: 11000, vu: 2000 }) }),
    // AlterCPA webmasters (Σ collected = the AlterCPA row)
    agg("collected", "w", "3221", { n: 7, rev: 21000, pw: 7, rc: 21000, cm: 4200, pc: 21, lb: 21, ...vat({ v05: 21000, rc: 21000 }) }),
    agg("collected", "w", "__none__", { n: 3, rev: 9000, pw: 3, rc: 9000, cm: 1800, pc: 9, lb: 9, ...vat({ v05: 9000, rc: 9000 }) }),
    agg("returned", "w", "3221", { n: 3, rev: 9000, pw: 3, ...vat({ v05: 9000 }) }),
    agg("open", "w", "3221", { n: 2, rev: 6000, pw: 2, ...vat({}) }),
  ],
  comm: [
    // AlterCPA: 30 € ungated, of which 20 € owned by an agent ("Ана Петрова М." folds to her)
    { dim: "s", key: "altercpa", o: "Ана Петрова М.", b: 20, n: 6 },
    { dim: "s", key: "altercpa", o: null, b: 10, n: 4 },
    // ElyonCRM: 10 € ungated, all an admin's → 0 (an admin earns nothing)
    { dim: "s", key: "elyon_crm", o: "Админ", b: 10, n: 4 },
    { dim: "d", key: "2026-09-22", o: "Ана Петрова М.", b: 20, n: 6 },
    { dim: "d", key: "2026-09-22", o: null, b: 5, n: 2 },
    { dim: "d", key: "2026-09-24", o: null, b: 5, n: 2 },
    { dim: "d", key: "2026-09-24", o: "Админ", b: 10, n: 4 },
    { dim: "w", key: "3221", o: "Ана Петрова М.", b: 20, n: 6 },
    { dim: "w", key: "__none__", o: null, b: 10, n: 4 },
  ],
  wm_names: { "3221": "Fomikch" },
  strip: [
    { s: "altercpa", b: "paid", n: 10, v: 30000, c: 30000, no: 10, nw: 0, nm: 0 },
    { s: "altercpa", b: "returned", n: 3, v: 9000, c: 9000, no: 3, nw: 0, nm: 0 },
    { s: "altercpa", b: "courier", n: 2, v: 6000, c: 6000, no: 2, nw: 0, nm: 0 },
    { s: "altercpa", b: "cancelled_after_sale", n: 1, v: 3000, c: 0, no: 1, nw: 0, nm: 0 },
    { s: "teleshop_other", b: "paid", n: 5, v: 10000, c: 10000, no: 2, nw: 0, nm: 3 },
  ],
  products: [
    { s: "altercpa", g: "collected", k: "p:a", name: "Adenofrin", kind: "product", reviewed: false, pkg: true, cost_eur: 2.93, n: 10, qty: 30, pkgs: 30, fr: 0, rev: 30000, cm: 5404.95, sh: 10, lb: 30, vt: 30000 * S5, vr: 0.05, vd: false },
    { s: "elyon_crm", g: "collected", k: "p:a", name: "Adenofrin", kind: "product", reviewed: false, pkg: true, cost_eur: 2.93, n: 3, qty: 8, pkgs: 8, fr: 1, rev: 8000, cm: 1441.56, sh: 3, lb: 8, vt: 8000 * S5, vr: 0.05, vd: false },
    { s: "elyon_crm", g: "collected", k: "n:zinc", name: "Zinc", kind: "product", reviewed: false, pkg: true, cost_eur: null, n: 1, qty: 2, pkgs: 2, fr: 0, rev: 2000, cm: 0, sh: 1, lb: 2, vt: 2000 * S5, vr: 0.05, vd: true },
    { s: "teleshop_other", g: "collected", k: "n:zinc", name: "Zinc", kind: "product", reviewed: false, pkg: true, cost_eur: null, n: 2, qty: 12, pkgs: 12, fr: 2, rev: 5900, cm: 0, sh: 2, lb: 0, vt: 5900 * S5, vr: 0.05, vd: true },
    { s: "teleshop_other", g: "collected", k: "n:поен-150", name: "ПОЕН-150", kind: "loyalty_point", reviewed: false, pkg: false, cost_eur: null, n: 2, qty: 2, pkgs: 0, fr: 0, rev: 100, cm: 0, sh: 0, lb: 0, vt: 100 * S5, vr: 0.05, vd: true },
    { s: "teleshop_other", g: "collected", k: "__mex_only__", name: null, kind: "unknown", reviewed: false, pkg: false, cost_eur: null, n: 3, qty: 0, pkgs: 0, fr: 0, rev: 4000, cm: 0, sh: 3, lb: 0, vt: 4000 * S5, vr: 0.05, vd: true },
    { s: "web", g: "collected", k: "p:c", name: "Collagen Face Serum", kind: "product", reviewed: false, pkg: true, cost_eur: null, n: 2, qty: 3, pkgs: 3, fr: 0, rev: 3000, cm: 0, sh: 2, lb: 0, vt: 3000 * S18, vr: 0.18, vd: false },
    { s: "altercpa", g: "returned", k: "p:a", name: "Adenofrin", kind: "product", reviewed: false, pkg: true, cost_eur: 2.93, n: 3, qty: 9, pkgs: 9, fr: 0, rev: 9000, cm: 0, sh: 3, lb: 0, vt: 9000 * S5, vr: 0.05, vd: false },
  ],
  hist: [
    { s: "altercpa", u: 1000, q: 30, v: 30000 },
    { s: "elyon_crm", u: 1000, q: 7, v: 7000 },
    { s: "elyon_crm", u: 1000, q: 2, v: 2000 },
    { s: "teleshop_other", u: 500, q: 10, v: 5000 },
    { s: "web", u: 1000, q: 3, v: 3000 },
  ],
  no_items: { n: 0, v: 0 },
};

const CASH: ProfitRpc = {
  clock: "cash",
  granularity: "day",
  vat_mode: "per_line",
  agg: [
    agg("collected", "s", "altercpa", { n: 12, rev: 36000, pw: 12, rc: 36000, cm: 7200, pc: 36, lb: 36, ...vat({ v05: 36000, rc: 36000 }) }),
    agg("collected", "s", "web", { n: 3, rev: 4000, card: 1000, pw: 3, ru: 4000, pu: 4, ...vat({ v05: 1000, v18: 3000, vu: 1000 }) }),
    agg("collected", "d", "2026-09-22", { n: 15, rev: 40000, pw: 15, rc: 36000, ru: 4000, cm: 7200, pc: 36, pu: 4, lb: 36, ...vat({ v05: 37000, v18: 3000, rc: 36000, vu: 1000 }) }),
    agg("collected", "w", "3221", { n: 12, rev: 36000, pw: 12, rc: 36000, cm: 7200, pc: 36, lb: 36, ...vat({ v05: 36000, rc: 36000 }) }),
  ],
  comm: [{ dim: "s", key: "altercpa", o: "Марко", b: 36, n: 12 }],
  wm_names: { "3221": "Fomikch" },
  returned_parcels: [{ s: "altercpa", d: "2026-09-22", n: 4 }, { s: "web", d: "2026-09-23", n: 1 }],
};

const WEEK: InsightsWindow = {
  from: "2026-09-22", to: "2026-09-28", days: 7,
  fromIso: "2026-09-21T22:00:00.000Z", toEndIso: "2026-09-28T21:59:59.999Z", partial: true,
  prev: { from: "2026-09-15", to: "2026-09-21", fromIso: "2026-09-14T22:00:00.000Z", toEndIso: "2026-09-21T21:59:59.999Z" },
};

describe("today's commission gate (twins of /management-insights)", () => {
  it("normAgent folds whitespace and a trailing initial; blank is Unknown operator", () => {
    expect(normAgent("  Ана   Петрова М. ")).toBe("Ана Петрова");
    expect(normAgent("Елена Т")).toBe("Елена");
    expect(normAgent(null)).toBe("Unknown operator");
    expect(normAgent("   ")).toBe("Unknown operator");
  });

  it("agent names = agent roles minus anyone who is also admin / manager", () => {
    const names = commissionAgentNames(
      [{ user_id: "a", full_name: "Ана Петрова" }, { user_id: "m", full_name: "Мики" }, { user_id: "x", full_name: "Никој" }],
      [{ user_id: "a", role: "agent" }, { user_id: "m", role: "agent" }, { user_id: "m", role: "admin" }, { user_id: "x", role: "warehouse" }],
    );
    expect([...names]).toEqual(["Ана Петрова"]);
  });

  it("only agent-owned bonus counts", () => {
    expect(gatedBonusEur(COHORT.comm, "s", "altercpa", SETTINGS.agentNames)).toBe(20);
    expect(gatedBonusEur(COHORT.comm, "s", "elyon_crm", SETTINGS.agentNames)).toBe(0);
    expect(gatedBonusEur(COHORT.comm, "s", null, SETTINGS.agentNames)).toBe(20);
  });
});

describe("the P&L row", () => {
  it("revenue − VAT (per line) − COGS (known + estimated) − courier − returns − commission − lead = net", () => {
    // 24.000 of supplements at 5 % (20.000 costed), 6.000 of a cosmetic at 18 %, 1.000 with no rate
    const m = { n: 10, rev: 30000, card: 0, pw: 10, rc: 20000, ru: 10000, rn: 0, cm: 4000, pc: 20, pu: 10, fr: 0, lb: 30,
      v00: 0, v05: 24000, v10: 0, v18: 6000, vt: 24000 * S5 + 6000 * S18, vc: 20000 * S5, vu: 1000 };
    const r = plRow({ key: "x", m, perLine: true, commissionEur: 20, returnedParcels: 3, returnedSales: 3, returnedValue: 9000, costRatio: 0.2 }, SETTINGS);
    const vat = 24000 * S5 + 6000 * S18;
    expect(r.vat_mkd).toBe(Math.round(vat));
    expect(r.vat_costed_mkd).toBe(Math.round(20000 * S5));
    expect(r.vat_split).toEqual([
      { rate: 0.05, revenue_mkd: 24000, vat_mkd: Math.round(24000 * S5) },
      { rate: 0.18, revenue_mkd: 6000, vat_mkd: Math.round(6000 * S18) },
    ]);
    expect(r.vat_unclassified).toEqual({ revenue_mkd: 1000, vat_mkd: Math.round(1000 * S5) });
    expect(r.courier_mkd).toBe(10 * 150);
    expect(r.returns_mkd).toBe(0);
    expect(r.commission_mkd).toBe(Math.round(20 * MKD_PER_EUR));
    expect(r.cogs_est_mkd).toBe(2000);
    expect(r.lead_cost_mkd).toBe(0);
    const net = 30000 - vat - 4000 - 2000 - 1500 - 20 * 61.5;
    expect(r.net_mkd).toBe(Math.round(net));
    expect(r.net_upper_mkd).toBe(Math.round(net + 2000));
    expect(r.margin).toBeCloseTo(net / 30000, 10);
    expect(r.coverage_packages).toBeCloseTo(20 / 30, 10);
    expect(r.return_rate).toBeCloseTo(3 / 13, 10);
    expect(r.aov_mkd).toBe(3000);
    expect(r.profit_per_sale_mkd).toBe(Math.round(net / 10));
    // the costed packages alone: their revenue, their cost, the rest by revenue share
    const sigma = 20000 / 30000;
    const costed = 20000 - 20000 * S5 - 4000 - sigma * (1500 + 20 * 61.5);
    expect(r.costed.net_mkd).toBe(Math.round(costed));
  });

  it("an older insights_profit() body (no VAT per line): every line at the default rate, all of it unclassified", () => {
    const m = { n: 2, rev: 2100, card: 0, pw: 2, rc: 1050, ru: 1050, rn: 0, cm: 100, pc: 1, pu: 1, fr: 0, lb: 2,
      v00: 0, v05: 0, v10: 0, v18: 0, vt: 0, vc: 0, vu: 0 };
    const r = plRow({ key: "x", m, perLine: false, commissionEur: 0, returnedParcels: 0, returnedSales: 0, returnedValue: 0, costRatio: null }, SETTINGS);
    expect(r.vat_mkd).toBe(100);                                  // 2.100 × 5/105
    expect(r.vat_costed_mkd).toBe(50);
    expect(r.vat_split).toEqual([{ rate: 0.05, revenue_mkd: 2100, vat_mkd: 100 }]);
    expect(r.vat_unclassified).toEqual({ revenue_mkd: 2100, vat_mkd: 100 });
    expect(vatOf({ ...m, rev: 0 }, false, 0.05).split).toEqual([]);
  });

  it("with nothing costed the estimate is null (never a made-up cost)", () => {
    const m = { n: 1, rev: 1000, card: 0, pw: 1, rc: 0, ru: 1000, rn: 0, cm: 0, pc: 0, pu: 2, fr: 0, lb: 0,
      v00: 0, v05: 1000, v10: 0, v18: 0, vt: 1000 * S5, vc: 0, vu: 0 };
    const r = plRow({ key: "x", m, perLine: true, commissionEur: 0, returnedParcels: 0, returnedSales: 0, returnedValue: 0, costRatio: null }, SETTINGS);
    expect(r.cogs_est_mkd).toBeNull();
    expect(r.net_mkd).toBe(r.net_upper_mkd);
    expect(r.coverage_packages).toBe(0);
  });

  it("the estimate uses the cost share of the costed packages", () => {
    expect(costRatioOf(COHORT.agg)).toBeCloseTo((6000 + 1600) / (30000 + 8000), 12);
  });
});

describe("a clock", () => {
  const c = buildClock(COHORT, null, SETTINGS, bucketKeys("2026-09-22", "2026-09-24", "day"));

  it("Σ sources = the total, line by line", () => {
    for (const k of ["sales", "revenue_mkd", "vat_mkd", "cogs_known_mkd", "courier_mkd", "commission_mkd"] as const) {
      const sum = c.by_source.reduce((t, r) => t + (r[k] as number), 0);
      expect(Math.abs(sum - (c.total[k] as number))).toBeLessThanOrEqual(PROFIT_SOURCES.length);
    }
    const net = c.by_source.reduce((t, r) => t + r.net_mkd, 0);
    expect(Math.abs(net - c.total.net_mkd)).toBeLessThanOrEqual(PROFIT_SOURCES.length);
    expect(c.by_source.map((r) => r.key)).toEqual([...PROFIT_SOURCES]);
  });

  it("revenue is what MEX collected; open and unproven stay apart", () => {
    expect(c.total.revenue_mkd).toBe(53000);
    expect(c.open).toEqual({ count: 2, value_mkd: 6000 });
    expect(c.unproven).toEqual({ count: 1, value_mkd: 2500 });
    expect(c.total.returned).toBe(4);
    expect(c.total.returned_mkd).toBe(11000);
  });

  it("the trend fills the empty days", () => {
    expect(c.trend.map((p) => p.d)).toEqual(["2026-09-22", "2026-09-23", "2026-09-24"]);
    expect(c.trend[1]).toMatchObject({ sales: 0, revenue_mkd: 0, net_mkd: 0 });
  });

  it("webmasters add up to the AlterCPA row and carry their open / returned sales", () => {
    const alter = c.by_source.find((r) => r.key === "altercpa")!;
    expect(c.affiliates.reduce((t, a) => t + a.pl.revenue_mkd, 0)).toBe(alter.revenue_mkd);
    expect(c.affiliates.reduce((t, a) => t + a.pl.commission_mkd, 0)).toBe(alter.commission_mkd);
    const fom = c.affiliates.find((a) => a.key === "3221")!;
    expect(fom.name).toBe("Fomikch");
    expect(fom.sales_total).toBe(12);
    expect(fom.open).toBe(2);
    expect(fom.pl.return_rate).toBeCloseTo(3 / 10, 10);
    expect(c.affiliates.find((a) => a.key === "__none__")!.name).toBeNull();
  });

  it("cash: returns are MEX return-day parcels; per webmaster they are unknown (null)", () => {
    const k = buildClock(CASH, null, SETTINGS);
    expect(k.clock).toBe("delivered");
    expect(k.total.parcels_returned).toBe(5);
    expect(k.by_source.find((r) => r.key === "web")!.card_mkd).toBe(1000);
    expect(k.affiliates[0].pl.return_rate).toBeNull();
    expect(k.open).toBeNull();
    expect(k.total.commission_mkd).toBe(Math.round(36 * 61.5));
  });
});

describe("products", () => {
  const ratio = costRatioOf(COHORT.agg);
  const { rows, others } = productRows(COHORT, SETTINGS, ratio);

  it("fold across sources; Σ revenue and commission tie to the P&L", () => {
    const c = buildClock(COHORT, null, SETTINGS);
    expect(others).toBeNull();
    expect(rows.reduce((t, p) => t + p.revenue_mkd, 0)).toBe(c.total.revenue_mkd);
    expect(Math.abs(rows.reduce((t, p) => t + p.commission_mkd, 0) - c.total.commission_mkd)).toBeLessThanOrEqual(1);
    const aden = rows.find((p) => p.key === "p:a")!;
    expect(aden.sources).toEqual(["altercpa", "elyon_crm"]);
    expect(aden.packages).toBe(38);
    expect(aden.cost_known).toBe(true);
    expect(aden.unit_cost_mkd).toBe(Math.round(2.93 * 61.5));
    expect(aden.returned_packages).toBe(9);
    expect(aden.return_rate).toBeCloseTo(9 / 47, 10);
  });

  it("an uncosted product reads 'no cost' with an estimate, never a clean margin", () => {
    const zinc = rows.find((p) => p.key === "n:zinc")!;
    expect(zinc.cost_known).toBe(false);
    expect(zinc.unit_cost_mkd).toBeNull();
    expect(zinc.cogs_est_mkd).toBe(Math.round(7900 * ratio!));
    const pts = rows.find((p) => p.kind === "loyalty_point")!;
    expect(pts.package).toBe(false);
    expect(pts.cogs_est_mkd).toBeNull();
    const mex = rows.find((p) => p.key === "__mex_only__")!;
    expect(mex.cogs_est_mkd).toBe(Math.round(4000 * ratio!));
  });

  it("past the cap the tail folds into one row, totals intact", () => {
    const many: ProductRpcRow[] = Array.from({ length: PROFIT_PRODUCTS_MAX + 5 }, (_, i) => ({
      s: "teleshop_other", g: "collected", k: `n:p${i}`, name: `P${i}`, kind: "product", reviewed: false, pkg: true,
      cost_eur: null, n: 1, qty: 1, pkgs: 1, fr: 0, rev: 1000 + i, cm: 0, sh: 1, lb: 0,
    }));
    const r = productRows({ ...COHORT, products: many }, SETTINGS, 0.2);
    expect(r.rows).toHaveLength(PROFIT_PRODUCTS_MAX);
    expect(r.total).toBe(PROFIT_PRODUCTS_MAX + 5);
    expect(r.others!.revenue_mkd).toBe(1000 + 1001 + 1002 + 1003 + 1004);
    expect(r.others!.cogs_est_mkd).toBe(Math.round(r.others!.revenue_mkd * 0.2));
  });
});

describe("the realized price distribution", () => {
  it("weighted order statistics over denar bins", () => {
    const d = distributionOf([
      { s: "a", u: 100, q: 1, v: 100 }, { s: "a", u: 200, q: 2, v: 400 }, { s: "b", u: 300, q: 1, v: 300 },
    ], null);
    expect(d).toEqual({ packages: 4, avg_mkd: 200, min_mkd: 100, p25_mkd: 100, median_mkd: 200, p75_mkd: 200, max_mkd: 300 });
    expect(distributionOf([], null).packages).toBe(0);
    expect(distributionOf(COHORT.hist, "teleshop_other").median_mkd).toBe(500);
  });
});

describe("the strip (CohortBar)", () => {
  it("buckets add up to the total; outside stays outside", () => {
    const s = buildStrip(COHORT.strip);
    expect(s.total).toEqual({ count: 20, value_mkd: 55000, cod_mkd: 55000, orders: 17, web: 0, mex_only: 3, booked: 0 });
    expect(s.buckets.reduce((t, b) => t + b.count, 0)).toBe(s.total.count);
    expect(s.outside.find((o) => o.key === "cancelled_after_sale")!.count).toBe(1);
    expect(s.by_source.map((r) => r.key)).toEqual([...PROFIT_SOURCES]);
    expect(s.by_source.find((r) => r.key === "altercpa")!.total.count).toBe(15);
  });

  it("collabBox bookings awaiting their parcel are the to-pack part's `booked` (20260942001900)", () => {
    // two Нарачка out documents booked today, no parcel yet: sales in "to pack", never orders
    const rows = [...COHORT.strip!, { s: "teleshop_out", b: "to_pack", n: 3, v: 6600, c: 0, no: 1, nw: 0, nm: 0, nb: 2 }];
    const s = buildStrip(rows);
    const tp = s.buckets.find((x) => x.key === "to_pack")!;
    expect(tp).toMatchObject({ count: 3, orders: 1, booked: 2 });
    expect(s.total).toMatchObject({ count: 23, orders: 18, mex_only: 3, booked: 2 });
    expect(s.total.orders + s.total.web + s.total.mex_only + s.total.booked).toBe(s.total.count);
    expect(s.by_source.find((r) => r.key === "teleshop_out")!.total).toMatchObject({ count: 3, booked: 2 });
    // an older body without `nb` holds no bookings
    expect(buildStrip(COHORT.strip).total.booked).toBe(0);
  });
});

describe("Social media — a source of its own (migration 20260942000500)", () => {
  // Teleshop's collabBox social documents and 9108 parcels moved to their own column: one
  // collected social sale (uncosted) and one returned, a strip part, a line and a price bin.
  const SOC: ProfitRpc = {
    ...COHORT,
    agg: [
      ...COHORT.agg!,
      agg("collected", "s", "social", { n: 2, rev: 4000, pw: 2, ru: 4000, pu: 3 }),
      agg("returned", "s", "social", { n: 1, rev: 1500, pw: 1 }),
    ],
    strip: [...COHORT.strip!, { s: "social", b: "paid", n: 2, v: 4000, c: 4000, no: 1, nw: 0, nm: 1 }],
    products: [...COHORT.products!,
      { s: "social", g: "collected", k: "n:zinc", name: "Zinc", kind: "product", reviewed: false, pkg: true, cost_eur: null, n: 2, qty: 3, pkgs: 3, fr: 0, rev: 4000, cm: 0, sh: 2, lb: 0 }],
    hist: [...COHORT.hist!, { s: "social", u: 1333, q: 3, v: 4000 }],
  };

  it("has its own P&L column, in the fixed order, and the columns still add up to the total", () => {
    const c = buildClock(SOC, null, SETTINGS);
    expect(c.by_source.map((r) => r.key)).toEqual(["altercpa", "elyon_crm", "teleshop_out", "teleshop_other", "social", "web"]);
    const soc = c.by_source.find((r) => r.key === "social")!;
    expect(soc).toMatchObject({ sales: 2, revenue_mkd: 4000, returned: 1, returned_mkd: 1500 });
    const tel = c.by_source.find((r) => r.key === "teleshop_other")!;
    expect(tel.revenue_mkd).toBe(10000);                       // Teleshop's own, social not in it
    for (const k of ["sales", "revenue_mkd", "vat_mkd", "courier_mkd", "net_mkd"] as const) {
      expect(Math.abs(c.by_source.reduce((t, r) => t + (r[k] as number), 0) - (c.total[k] as number))).toBeLessThanOrEqual(PROFIT_SOURCES.length);
    }
    expect(c.total.revenue_mkd).toBe(53000 + 4000);
  });

  it("the strip, the products and the realized prices know it", () => {
    const s = buildStrip(SOC.strip);
    expect(s.by_source.find((r) => r.key === "social")!.total).toMatchObject({ count: 2, orders: 1, mex_only: 1 });
    const zinc = productRows(SOC, SETTINGS, costRatioOf(SOC.agg)).rows.find((p) => p.key === "n:zinc")!;
    expect(zinc.sources).toEqual(["elyon_crm", "teleshop_other", "social"]);
    expect(distributionOf(SOC.hist, "social").packages).toBe(3);
  });
});

describe("Телешоп – Lead out — a department of its own (migration 20260942001000)", () => {
  // collabBox "Нарачка out" documents (and a CRM sale shipped on a 9102 parcel) left
  // Affiliate – Lead out for their own column: one collected sale and one returned.
  const OUT: ProfitRpc = {
    ...COHORT,
    agg: [
      ...COHORT.agg!,
      agg("collected", "s", "teleshop_out", { n: 3, rev: 6000, pw: 3, ru: 6000, pu: 4 }),
      agg("returned", "s", "teleshop_out", { n: 1, rev: 2000, pw: 1 }),
    ],
    strip: [...COHORT.strip!, { s: "teleshop_out", b: "paid", n: 3, v: 6000, c: 6000, no: 3, nw: 0, nm: 0 }],
    hist: [...COHORT.hist!, { s: "teleshop_out", u: 1500, q: 4, v: 6000 }],
  };

  it("sits between Affiliate – Lead out and Телешоп – Lead in, and the columns still add up", () => {
    const c = buildClock(OUT, null, SETTINGS);
    expect(c.by_source.map((r) => r.key)).toEqual([...PROFIT_SOURCES]);
    expect(PROFIT_SOURCES.indexOf("teleshop_out")).toBe(PROFIT_SOURCES.indexOf("elyon_crm") + 1);
    expect(c.by_source.find((r) => r.key === "teleshop_out")).toMatchObject({ sales: 3, revenue_mkd: 6000, returned: 1, returned_mkd: 2000 });
    for (const k of ["sales", "revenue_mkd", "vat_mkd", "courier_mkd", "net_mkd"] as const) {
      expect(Math.abs(c.by_source.reduce((t, r) => t + (r[k] as number), 0) - (c.total[k] as number))).toBeLessThanOrEqual(PROFIT_SOURCES.length);
    }
    expect(c.total.revenue_mkd).toBe(53000 + 6000);
    expect(buildStrip(OUT.strip).by_source.find((r) => r.key === "teleshop_out")!.total).toMatchObject({ count: 3, orders: 3 });
    expect(distributionOf(OUT.hist, "teleshop_out").packages).toBe(4);
  });
});

describe("windows and settings", () => {
  it("bucket keys by day and by month", () => {
    expect(bucketKeys("2026-09-29", "2026-10-02", "day")).toEqual(["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"]);
    expect(bucketKeys("2025-11-15", "2026-02-01", "month")).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
    expect(bucketKeys("2026-02-01", "2026-01-01", "day")).toEqual([]);
  });

  it("the previous period only up to the cap", () => {
    expect(profitPrevWindow(WEEK)).toEqual({ fromIso: WEEK.prev!.fromIso, toEndIso: WEEK.prev!.toEndIso });
    expect(profitPrevWindow({ ...WEEK, days: PROFIT_PREV_MAX_DAYS + 1 })).toBeNull();
    expect(profitPrevWindow({ ...WEEK, prev: null })).toBeNull();
  });

  it("the MEX rate card row, else the fallback — labelled", () => {
    expect(mexRate({ mex_door: { deliver: 2.439, return_: 0 } }, { deliver: 3.5, return_: 6 }))
      .toEqual({ deliverEur: 2.439, returnEur: 0, rateSource: "courier_rates" });
    expect(mexRate({}, { deliver: 2.439, return_: 0 })).toEqual({ deliverEur: 2.439, returnEur: 0, rateSource: "fallback" });
  });
});

describe("the response", () => {
  const r = buildProfitResponse({ cohort: COHORT, cash: CASH, prevCohort: COHORT, prevCash: CASH }, WEEK, SETTINGS,
    new Date("2026-09-28T08:00:00Z")) as Record<string, any>;

  it("meta says what every figure rests on", () => {
    expect(r.meta).toMatchObject({
      from: "2026-09-22", to: "2026-09-28", money: true, granularity: "day", prev_from: "2026-09-15", prev_skipped: false,
      vat: { mode: "per_product_sigma", default_rate: 0.05, rate: 0.05, confirmed: true, source: "sigma" },
      courier: { deliver_mkd: 150, return_mkd: 0, source: "courier_rates" },
      lead_cost: { configured: false },
    });
  });

  it("carries both clocks, products, realized prices and the quality rail", () => {
    expect(r.cohort.clock).toBe("sale");
    expect(r.cash.clock).toBe("delivered");
    expect(r.cohort.prev.revenue_mkd).toBe(r.cohort.total.revenue_mkd);
    expect(r.cohort.trend).toHaveLength(7);
    expect(r.realized.all.packages).toBe(52);
    expect(Object.keys(r.realized)).toEqual(["all", ...PROFIT_SOURCES]);
    const kinds = r.quality.map((q: { kind: string }) => q.kind);
    expect(kinds).toEqual(expect.arrayContaining(["uncosted_packages", "unproven_paid", "lead_cost_missing", "return_fee_unconfirmed"]));
    expect(kinds).toContain("vat_unclassified");       // per product from Sigma since 01.10
    expect(kinds).not.toContain("vat_flat_default");
    const unc = r.quality.find((q: { kind: string }) => q.kind === "uncosted_packages");
    expect(unc.count).toBe(17);
    expect(unc.top[0].key).toBe("n:zinc");
  });

  it("no money key is ever ×61,5 twice: every *_mkd is a whole denar", () => {
    const walk = (v: unknown, path: string) => {
      if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) {
        if (/_mkd$/.test(k) && typeof x === "number") expect(Number.isInteger(x), `${path}.${k}`).toBe(true);
        walk(x, `${path}.${k}`);
      }
    };
    walk(r, "r");
  });
});

describe("VAT per product from Sigma (owner 01.10.2026, migration 20260944000900)", () => {
  const c = buildClock(COHORT, null, SETTINGS);
  const { rows } = productRows(COHORT, SETTINGS, costRatioOf(COHORT.agg));

  it("the VAT line is Σ per line at each product's rate — not revenue × 18/118", () => {
    const expected = 50000 * S5 + 3000 * S18;   // 50.000 ден of supplements + 3.000 of a cosmetic
    expect(c.total.vat_mkd).toBe(Math.round(expected));
    expect(c.total.vat_mkd).not.toBe(Math.round(53000 * 0.18 / 1.18));
    expect(c.total.vat_split).toEqual([
      { rate: 0.05, revenue_mkd: 50000, vat_mkd: Math.round(50000 * S5) },
      { rate: 0.18, revenue_mkd: 3000, vat_mkd: Math.round(3000 * S18) },
    ]);
    // the web column carries the cosmetic at 18 %
    expect(c.by_source.find((r) => r.key === "web")!.vat_mkd).toBe(Math.round(3000 * S18));
    // Σ products = the VAT line
    expect(Math.abs(rows.reduce((t, p) => t + p.vat_mkd, 0) - c.total.vat_mkd)).toBeLessThanOrEqual(rows.length);
  });

  it("each product carries its rate; what has no rate is unclassified at 5 %, never silent", () => {
    const aden = rows.find((p) => p.key === "p:a")!;
    expect(aden).toMatchObject({ vat_rate: 0.05, vat_classified: true, vat_mkd: Math.round(38000 * S5) });
    expect(rows.find((p) => p.key === "p:c")).toMatchObject({ vat_rate: 0.18, vat_classified: true, vat_mkd: Math.round(3000 * S18) });
    for (const k of ["n:zinc", "__mex_only__", "n:поен-150"]) {
      expect(rows.find((p) => p.key === k)).toMatchObject({ vat_rate: DEFAULT_VAT_RATE, vat_classified: false });
    }
    expect(c.total.vat_unclassified).toEqual({ revenue_mkd: 12000, vat_mkd: Math.round(12000 * S5) });
    expect(vatUnclassifiedOf(COHORT)).toEqual({
      revenue_mkd: 12000, vat_mkd: Math.round(12000 * S5),
      mex_only_mkd: 4000, no_lines_mkd: 0, unmatched_mkd: 8000, no_rate_mkd: 0, products: 3,
    });
  });

  it("the meta says how VAT was computed, by rate and what was unclassified", () => {
    const r = buildProfitResponse({ cohort: COHORT, cash: CASH }, WEEK, SETTINGS, new Date("2026-09-28T08:00:00Z")) as Record<string, any>;
    expect(r.meta.vat.by_rate.cohort).toEqual({
      "0.05": { revenue_mkd: 50000, vat_mkd: Math.round(50000 * S5) },
      "0.18": { revenue_mkd: 3000, vat_mkd: Math.round(3000 * S18) },
    });
    expect(r.meta.vat.by_rate.cash["0.18"]).toEqual({ revenue_mkd: 3000, vat_mkd: Math.round(3000 * S18) });
    expect(r.meta.vat.unclassified.cohort.mex_only_mkd).toBe(4000);
    expect(r.meta.vat.unclassified.cash).toEqual({ revenue_mkd: 1000, vat_mkd: Math.round(1000 * S5) });
    expect(r.meta.vat.effective_rate.cohort).toBeCloseTo(r.cohort.total.vat_mkd / (53000 - r.cohort.total.vat_mkd), 10);
    const q = r.quality.find((x: { kind: string }) => x.kind === "vat_unclassified");
    expect(q).toMatchObject({ count: 3, value_mkd: 12000 });
    expect(q.top[0].key).toBe("n:zinc");
  });

  it("an older body (no vat_mode) answers at the flat default, labelled, never 18 %", () => {
    const old = (r: ProfitRpc): ProfitRpc => {
      const { vat_mode: _drop, ...rest } = r;
      return { ...rest, agg: r.agg!.map(({ vt: _a, vc: _b, vu: _c, v00: _d, v05: _e, v10: _f, v18: _g, ...a }) => a) };
    };
    expect(vatPerLine(old(COHORT))).toBe(false);
    const r = buildProfitResponse({ cohort: old(COHORT), cash: old(CASH) }, WEEK, SETTINGS, new Date("2026-09-28T08:00:00Z")) as Record<string, any>;
    expect(r.meta.vat.mode).toBe("flat_default");
    expect(r.cohort.total.vat_mkd).toBe(Math.round(53000 * S5));
    expect(r.cohort.total.vat_unclassified.revenue_mkd).toBe(53000);
    expect(r.quality.map((x: { kind: string }) => x.kind)).toContain("vat_flat_default");
    expect(r.meta.vat.unclassified.cohort).toBeNull();
  });

  it("a merge is per line only when every piece is", () => {
    expect(mergeProfitRpcs([COHORT, COHORT], "cohort", "day").vat_mode).toBe("per_line");
    const { vat_mode: _x, ...older } = COHORT;
    expect(mergeProfitRpcs([COHORT, older], "cohort", "day").vat_mode).toBeUndefined();
    const m = mergeProfitRpcs([COHORT, COHORT], "cohort", "day");
    const alter = m.agg!.find((a) => a.g === "collected" && a.dim === "s" && a.key === "altercpa")!;
    expect(alter.vt).toBeCloseTo(2 * 30000 * S5, 9);
    expect(m.products!.find((p) => p.k === "p:c" && p.g === "collected")).toMatchObject({ vr: 0.18, vd: false });
  });

  it("the quality rail lists the unclassified products (biggest first)", () => {
    const q = buildQuality(COHORT, c, rows, SETTINGS).find((x) => x.kind === "vat_unclassified")!;
    expect(q.top!.map((p) => p.key)).toEqual(["n:zinc", "__mex_only__", "n:поен-150"]);
    expect(q.share).toBeCloseTo(12000 / 53000, 10);
  });
});

// ── the monthly cache (migration 20260942000200) ─────────────────────────────

const NOW = new Date("2026-09-28T10:00:00Z");   // 28.09.2026, Skopje

describe("the monthly cache: pieces", () => {
  it("cuts a window into whole closed months and live edges", () => {
    expect(profitPieces({ from: "2025-09-28", to: "2026-09-28" }, NOW)).toEqual({
      months: ["2025-10-01", "2025-11-01", "2025-12-01", "2026-01-01", "2026-02-01", "2026-03-01",
        "2026-04-01", "2026-05-01", "2026-06-01", "2026-07-01", "2026-08-01"],
      live: [{ from: "2025-09-28", to: "2025-09-30" }, { from: "2026-09-01", to: "2026-09-28" }],
    });
    // a window ending mid-month: that month is live even though it is closed
    expect(profitPieces({ from: "2026-04-01", to: "2026-08-15" }, NOW)).toEqual({
      months: ["2026-04-01", "2026-05-01", "2026-06-01", "2026-07-01"],
      live: [{ from: "2026-08-01", to: "2026-08-15" }],
    });
    expect(refreshMonths({ from: "2026-07-20", to: "2026-09-28" }, NOW)).toEqual(["2026-07-01", "2026-08-01"]);
  });

  it("joins adjacent live ranges", () => {
    expect(coalesceRanges([{ from: "2026-05-01", to: "2026-05-31" }, { from: "2026-03-01", to: "2026-03-31" }, { from: "2026-04-01", to: "2026-04-30" }]))
      .toEqual([{ from: "2026-03-01", to: "2026-05-31" }]);
    expect(coalesceRanges([{ from: "2026-03-01", to: "2026-03-31" }, { from: "2026-05-01", to: "2026-05-31" }])).toHaveLength(2);
  });

  it("names the webmasters as the SQL does (latest named, then updated)", () => {
    expect(webmasterNames([
      { wm_id: "1", name: "Old", named_at: "2026-01-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z" },
      { wm_id: "1", name: "New", named_at: "2026-05-01T00:00:00Z", updated_at: "2026-02-01T00:00:00Z" },
      { wm_id: "2", name: "  ", named_at: null, updated_at: null },
      { wm_id: "3", name: "X", named_at: null, updated_at: "2026-01-01T00:00:00Z" },
    ])).toEqual({ "1": "New", "3": "X" });
  });
});

/** A synthetic database: every day carries a small P&L of its own, so any
 *  split of a window must add up to the whole. */
function dayPayload(clock: "cohort" | "cash", day: string, month: string): ProfitRpc {
  const d = Number(day.slice(8, 10));
  const m = { n: 1, rev: 1000 + d, card: 0, pw: 1, rc: 600, ru: 400 + d, rn: 0, cm: 120.5, pc: 2, pu: 1, fr: 0, lb: 2,
    // VAT in binary-exact amounts (the SQL rounds to 9 decimals; float noise is not the point here)
    v00: 0, v05: 1000, v10: 0, v18: d, vt: 48 + d / 4, vc: 28.5, vu: d % 5 === 0 ? 400 : 0 };
  const aggRows: AggRow[] = [
    { g: "collected", dim: "s", key: "altercpa", ...m },
    { g: "collected", dim: "d", key: month, ...m },
    { g: "collected", dim: "w", key: "3221", ...m },
    { g: "returned", dim: "s", key: "altercpa", ...m, n: 0, rev: 0, pw: d % 3 === 0 ? 1 : 0 },
  ];
  const base: ProfitRpc = {
    clock, granularity: "month", vat_mode: "per_line", agg: aggRows, wm_names: { "3221": "Fomikch" },
    comm: [{ dim: "s", key: "altercpa", o: d % 2 ? "Ана Петрова" : null, b: 2, n: 1 }, { dim: "d", key: month, o: "Ана Петрова", b: 2, n: 1 }],
  };
  if (clock === "cohort") {
    base.strip = [{ s: "altercpa", b: "paid", n: 1, v: 1000 + d, c: 1000 + d, no: 1, nw: 0, nm: 0 }];
    base.products = [
      { s: "altercpa", g: "collected", k: "p:a", name: d % 2 ? "Adenofrin" : "ADENOFRIN", kind: "product", reviewed: false, pkg: true, cost_eur: 2.93, n: 1, qty: 2, pkgs: 2, fr: 0, rev: 600, cm: 120.5, sh: 0.25 + d / 1000, lb: 2, vt: 28.5, vr: 0.05, vd: false },
      { s: "altercpa", g: "collected", k: "n:x", name: "X", kind: "product", reviewed: false, pkg: true, cost_eur: null, n: 1, qty: 1, pkgs: 1, fr: 0, rev: 400 + d, cm: 0, sh: 0.75 - d / 1000, lb: 0, vt: 19.5 + d / 4, vr: 0.18, vd: d % 5 === 0 },
    ];
    base.hist = [{ s: "altercpa", u: 300, q: 2, v: 600 }];
    base.no_items = { n: 0, v: 0 };
  } else {
    base.returned_parcels = [{ s: "altercpa", d: month, n: d % 4 === 0 ? 1 : 0 }];
  }
  return base;
}
function fakeLive(range: { fromIso: string; toEndIso: string }, clock: "cohort" | "cash"): ProfitRpc {
  const parts: ProfitRpc[] = [];
  for (let t = Date.parse(range.fromIso) + 12 * 3600_000; t <= Date.parse(range.toEndIso); t += 86400_000) {
    const day = new Date(t).toISOString().slice(0, 10);
    parts.push(dayPayload(clock, day, day.slice(0, 7)));
  }
  return mergeProfitRpcs(parts, clock, "month");
}

describe("the monthly cache: loading", () => {
  const YEAR: InsightsWindow = {
    from: "2025-09-28", to: "2026-09-28", days: 366, partial: true, prev: null,
    fromIso: "2025-09-27T22:00:00.000Z", toEndIso: "2026-09-28T21:59:59.999Z",
  };
  const monthEndOf = (m: string) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10);

  it("cached closed months + live edges = one live call, clock by clock", async () => {
    const calls: string[] = [];
    const plan = profitPieces(YEAR, NOW);
    const cache: ProfitCacheRow[] = plan.months.flatMap((m) => (["cohort", "cash"] as const).map((clock) => {
      const w = insightsWindows(m, monthEndOf(m), false, NOW) as InsightsWindow;
      return { month: m, clock, refreshed_at: "2026-09-28T01:30:00Z", payload: fakeLive(w, clock) };
    }));
    const out = await loadProfitClocks(YEAR, {
      live: async (r, clock) => { calls.push(`${clock}:${r.fromIso}`); return fakeLive(r, clock); },
      readCache: async () => cache,
      webmasters: async () => [{ wm_id: "3221", name: "Fomikch", named_at: null, updated_at: null }],
    }, NOW);
    expect(calls).toHaveLength(4);   // two edges × two clocks
    expect(out.cache).toMatchObject({ months: { cohort: 11, cash: 11 }, closed_months: 11, refreshed_min: "2026-09-28T01:30:00Z" });
    for (const clock of ["cohort", "cash"] as const) {
      const a = buildClock(fakeLive(YEAR, clock), null, SETTINGS), b = buildClock(out[clock], null, SETTINGS);
      expect(b.total).toEqual(a.total);
      expect(b.by_source).toEqual(a.by_source);
      expect(b.affiliates).toEqual(a.affiliates);
      expect(b.trend).toEqual(a.trend);
    }
    const pa = productRows(fakeLive(YEAR, "cohort"), SETTINGS, 0.2), pb = productRows(out.cohort, SETTINGS, 0.2);
    // money exact; a margin (a fraction) to float noise
    const fix = (r: typeof pa) => ({ ...r, rows: r.rows.map((p) => ({ ...p, margin: p.margin == null ? null : Number(p.margin.toFixed(9)) })) });
    expect(fix(pb)).toEqual(fix(pa));
    expect(pb.rows.find((p) => p.key === "p:a")!.name).toBe("ADENOFRIN");   // byte-order minimum, as COLLATE "C"
  });

  it("a month the cache does not hold is computed live; a cache that fails means all live", async () => {
    const calls: string[] = [];
    const out = await loadProfitClocks(YEAR, {
      live: async (r, clock) => { calls.push(`${clock}:${r.fromIso}`); return fakeLive(r, clock); },
      readCache: async () => { throw new Error("down"); },
      webmasters: async () => [],
    }, NOW);
    expect(out.cache!.months).toEqual({ cohort: 0, cash: 0 });
    expect(buildClock(out.cohort, null, SETTINGS).total).toEqual(buildClock(fakeLive(YEAR, "cohort"), null, SETTINGS).total);
    // edges (2) + the 11 missing months joined into one range, per clock
    expect(calls).toHaveLength(6);
  });

  it(`up to ${PROFIT_CACHE_MIN_DAYS} days: two live calls, no cache`, async () => {
    let n = 0;
    const out = await loadProfitClocks(WEEK, {
      live: async (r, clock) => { n++; return fakeLive(r, clock); },
      readCache: async () => { throw new Error("must not be read"); },
      webmasters: async () => [],
    }, NOW);
    expect(n).toBe(2);
    expect(out.cache).toBeNull();
  });
});

describe("Sigma purchase costs + extra packed goods (owner 01.10.2026, migration 20260945000800)", () => {
  // A Sigma-mode body: per-product costed packages / revenue (pc / rc), Phase B's extra (cx)
  const SIGMA: ProfitRpc = {
    ...COHORT,
    cost_mode: "sigma",
    extra_goods: true,
    agg: [
      // AlterCPA: all costed; 2 parcels held a gift worth 120 ден more than their lines (cx), one MEX-only
      // parcel with known contents (xr 1.000 revenue, its packed goods 90 ден = cxm), one recipe heavier
      // than what was packed (cxn −30)
      agg("collected", "s", "altercpa", { n: 10, rev: 30000, pw: 10, rc: 31000, ru: 0, cm: 3000, pc: 30, lb: 30,
        cx: 180, cxm: 90, cxn: -30, xr: 1000, xn: 4, ...vat({ v05: 31000, rc: 31000 }) }),
      agg("collected", "s", "teleshop_other", { n: 5, rev: 10000, pw: 5, rc: 6000, ru: 4000, cm: 600, pc: 6, pu: 4, lb: 0, ...vat({ v05: 10000, rc: 6000 }) }),
    ],
    products: [
      // costed on every sale day
      { s: "altercpa", g: "collected", k: "p:a", name: "Adenofrin", kind: "product", reviewed: false, pkg: true, cost_eur: 100 / 61.5, cost_mkd: 100,
        n: 10, qty: 30, pkgs: 30, fr: 0, rev: 30000, cm: 3000, sh: 10, lb: 30, vt: 30000 * S5, vr: 0.05, vd: false, pc: 30, rc: 30000, cx: 90, xr: 0 },
      // the recipe was approved mid-window: 6 of 10 packages costed
      { s: "teleshop_other", g: "collected", k: "p:z", name: "Zinc", kind: "product", reviewed: false, pkg: true, cost_eur: 100 / 61.5, cost_mkd: 100,
        n: 5, qty: 10, pkgs: 10, fr: 0, rev: 10000, cm: 600, sh: 5, lb: 0, vt: 10000 * S5, vr: 0.05, vd: false, pc: 6, rc: 6000, cx: 0, xr: 0 },
      // MEX-only, contents known for one parcel (xr), unknown for the rest
      { s: "altercpa", g: "collected", k: "__mex_only__", name: null, kind: "unknown", reviewed: false, pkg: false, cost_eur: null, cost_mkd: null,
        n: 2, qty: 0, pkgs: 0, fr: 0, rev: 1500, cm: 0, sh: 2, lb: 0, vt: 1500 * S5, vr: 0.05, vd: true, pc: 0, rc: 1000, cx: 90, xr: 1000 },
    ],
  };

  it("the extra packed goods are a cost of the costed basis; the ratio includes them", () => {
    const m = { n: 10, rev: 30000, card: 0, pw: 10, rc: 30000, ru: 0, rn: 0, cm: 3000, pc: 30, pu: 0, fr: 0, lb: 0,
      v00: 0, v05: 30000, v10: 0, v18: 0, vt: 30000 * S5, vc: 30000 * S5, vu: 0, cx: 180, cxm: 90, cxn: -30, xr: 1000, xn: 4 };
    const r = plRow({ key: "x", m, perLine: true, commissionEur: 0, returnedParcels: 0, returnedSales: 0, returnedValue: 0, costRatio: null }, SETTINGS);
    expect(r.cogs_extra_mkd).toBe(180);
    expect(r.cogs_extra_detail).toEqual({ mex_only_mkd: 90, mex_only_revenue_mkd: 1000, negative_mkd: -30, sales: 4 });
    const net = 30000 - 30000 * S5 - 3000 - 180 - 1500;
    expect(r.net_mkd).toBe(Math.round(net));
    expect(r.costed.net_mkd).toBe(Math.round(30000 - 30000 * S5 - 3000 - 180 - 1500));
    // Phase B off / an older caller: no measure = 0
    const { cx: _cx, cxm: _cxm, cxn: _cxn, xr: _xr, xn: _xn, ...old } = m;
    const o = plRow({ key: "x", m: old as typeof m, perLine: true, commissionEur: 0, returnedParcels: 0, returnedSales: 0, returnedValue: 0, costRatio: null }, SETTINGS);
    expect(o.cogs_extra_mkd).toBe(0);
    expect(o.net_mkd).toBe(Math.round(net + 180));
    expect(costRatioOf(SIGMA.agg)).toBeCloseTo((3000 + 180 + 600) / (31000 + 6000), 12);
  });

  it("a product is costed per package: a partial recipe estimates only its uncosted part", () => {
    const ratio = costRatioOf(SIGMA.agg)!;
    const { rows } = productRows(SIGMA, SETTINGS, ratio);
    const a = rows.find((p) => p.key === "p:a")!;
    expect(a).toMatchObject({ cost_known: true, cost_partial: false, unit_cost_mkd: 100, packages_costed: 30, cogs_mkd: 3000, cogs_est_mkd: null, cogs_extra_mkd: 90 });
    const z = rows.find((p) => p.key === "p:z")!;
    expect(z).toMatchObject({ cost_known: false, cost_partial: true, unit_cost_mkd: 100, packages_costed: 6, cogs_mkd: 600 });
    expect(z.cogs_est_mkd).toBe(Math.round(4000 * ratio));
    // the MEX-only row: the part whose contents are known is no longer estimated
    const mex = rows.find((p) => p.key === "__mex_only__")!;
    expect(mex.cogs_est_mkd).toBe(Math.round(500 * ratio));
    expect(mex.cogs_extra_mkd).toBe(90);
    // net = revenue − VAT − known − extra − estimate − courier − commission
    expect(a.net_mkd).toBe(Math.round(30000 - 30000 * S5 - 3000 - 90 - 10 * 150 - a.commission_mkd));
  });

  it("an older body (no pc / rc) keeps the catalogue rule: cost_eur decides the whole product", () => {
    const { rows } = productRows(COHORT, SETTINGS, 0.2);
    expect(rows.find((p) => p.key === "p:a")).toMatchObject({ cost_known: true, cost_partial: false, unit_cost_mkd: Math.round(2.93 * 61.5), packages_costed: 38, cogs_extra_mkd: 0 });
    expect(rows.find((p) => p.key === "n:zinc")).toMatchObject({ cost_known: false, cost_partial: false, unit_cost_mkd: null, packages_costed: 0 });
  });

  it("meta.cost says where the cost came from; the rail names the missing recipes or the legacy costs", () => {
    const sigma = buildProfitResponse({ cohort: SIGMA, cash: { ...CASH, cost_mode: "sigma", extra_goods: true } }, WEEK, SETTINGS, NOW);
    expect((sigma.meta as { cost: unknown }).cost).toMatchObject({
      source: "sigma", basis: "sigma_calcbuyprice", as_of: "2026-09-29", extra_goods: true, partial_products: 1,
    });
    const kinds = (sigma.quality as { kind: string; value_mkd?: number }[]);
    expect(kinds.map((q) => q.kind)).toContain("recipe_missing");
    expect(kinds.map((q) => q.kind)).not.toContain("cost_legacy");
    expect(kinds.find((q) => q.kind === "extra_goods_negative")).toMatchObject({ value_mkd: -30 });
    const legacy = buildProfitResponse({ cohort: COHORT, cash: CASH }, WEEK, SETTINGS, NOW);
    expect((legacy.meta as { cost: unknown }).cost).toMatchObject({ source: "legacy", basis: "catalogue_cost_price", as_of: null, extra_goods: false });
    const lk = (legacy.quality as { kind: string }[]).map((q) => q.kind);
    expect(lk).toContain("cost_legacy");
    expect(lk).toContain("uncosted_packages");
    expect(lk).not.toContain("recipe_missing");
  });

  it("the monthly merge sums the cost keys, keeps the highest unit cost and one cost mode", () => {
    const a = { ...SIGMA, products: SIGMA.products!.slice(0, 1) };
    const b = { ...SIGMA, products: [{ ...SIGMA.products![0], cost_mkd: 120, pc: 10, rc: 10000, cm: 1200, cx: 10 }] };
    const m = mergeProfitRpcs([a, b], "cohort", "month");
    const p = m.products!.find((x) => x.k === "p:a")!;
    expect(p).toMatchObject({ cost_mkd: 120, pc: 40, rc: 40000, cm: 4200, cx: 100 });
    expect(m.cost_mode).toBe("sigma");
    expect(m.extra_goods).toBe(true);
    expect(m.agg!.find((x) => x.g === "collected" && x.key === "altercpa")).toMatchObject({ cx: 360, cxm: 180, cxn: -60, xr: 2000, xn: 8 });
    // an older piece (no cost keys) never invents per-product cost keys; mixed modes say so
    const old = mergeProfitRpcs([COHORT, COHORT], "cohort", "month");
    expect(old.products!.find((x) => x.k === "p:a")!.pc).toBeUndefined();
    expect(old.cost_mode).toBe("legacy");
    expect(mergeProfitRpcs([COHORT, SIGMA], "cohort", "month").cost_mode).toBe("mixed");
  });
});
